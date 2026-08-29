// Public, unauthenticated routes — the web form that replaces the Google Form.
// This is the ONLY write path into `leads` that doesn't require Cloudflare
// Access, by design: enquirers aren't staff.

import { json, badRequest, notFound, normalizePhone } from "../lib/util.js";

export async function captureLead(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !body.name || !body.phone) {
    return badRequest("name and phone are required");
  }

  const phone_normalized = normalizePhone(body.phone);
  if (phone_normalized.length < 10) return badRequest("enter a valid 10-digit phone number");

  // Duplicate check — blueprint §3: flag, never silently block. Same phone
  // number within the last 90 days is treated as a possible duplicate so a
  // genuine second enquiry from the same couple still comes through.
  const dup = await env.DB.prepare(
    `SELECT id FROM leads WHERE phone_normalized = ? AND created_at >= datetime('now','-90 days') ORDER BY created_at DESC LIMIT 1`
  )
    .bind(phone_normalized)
    .first();

  const source = (body.source || "Website").trim();

  const result = await env.DB.prepare(
    `INSERT INTO leads (name, phone, phone_normalized, email, source, event_type, event_date, budget_est, referred_by, message, possible_duplicate_of, stage)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'New')`
  )
    .bind(
      body.name,
      body.phone,
      phone_normalized,
      body.email || null,
      source,
      body.event_type || null,
      body.event_date || null,
      body.budget_est ? Number(body.budget_est) : null,
      body.referred_by || null,
      body.message || null,
      dup ? dup.id : null
    )
    .run();

  const leadId = result.meta.last_row_id;
  await env.DB.prepare(
    `INSERT INTO lead_status_history (lead_id, from_stage, to_stage, changed_by) VALUES (?, NULL, 'New', 'capture-form')`
  )
    .bind(leadId)
    .run();

  return json({ ok: true, lead_id: leadId, possible_duplicate: !!dup }, { status: 201 });
}

// ── Public post-event feedback — the shareable link staff send after
// delivery. Token-gated the same way the photographer portal is, since the
// feedback page has to work for a customer with no login at all.

// Minimal context for the feedback page: who/what it's for, plus the Google
// review link, which is public-facing by design (it's meant to be shared
// with exactly this audience). Never exposes anything else from settings.
export async function getFeedbackContext(request, env, token) {
  const event = await env.DB.prepare(
    `SELECT e.id, e.type, e.event_date, a.id AS account_id, a.name AS account_name
     FROM events e JOIN accounts a ON a.id = e.account_id WHERE e.feedback_token = ?`
  ).bind(token).first();
  if (!event) return notFound("invalid or expired feedback link");
  const reviewLink = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'google_review_link'`).first();
  return json({
    event_type: event.type,
    event_date: event.event_date,
    account_name: event.account_name,
    google_review_link: reviewLink?.value || null,
  });
}

// Positive feedback is never stored — the page sends the visitor straight
// to the Google review link and that's the whole point of it. Only
// Negative feedback creates an internal record, since that's the only case
// anyone needs to act on.
export async function submitFeedback(request, env, token) {
  const body = await request.json().catch(() => null);
  if (!body || !body.sentiment) return badRequest("sentiment is required");
  if (!["Positive", "Negative"].includes(body.sentiment)) return badRequest("sentiment must be Positive or Negative");

  const event = await env.DB.prepare(
    `SELECT id, account_id FROM events WHERE feedback_token = ?`
  ).bind(token).first();
  if (!event) return notFound("invalid or expired feedback link");

  if (body.sentiment === "Positive") {
    return json({ ok: true, stored: false });
  }

  await env.DB.prepare(
    `INSERT INTO feedback (event_id, account_id, sentiment, rating, comment) VALUES (?, ?, 'Negative', ?, ?)`
  ).bind(event.id, event.account_id, body.rating ? Number(body.rating) : null, body.comment || null).run();
  return json({ ok: true, stored: true }, { status: 201 });
}

// ── Public quote viewing — token-gated, no login, read-only except for
// toggling optional add-ons. Every view is logged: a running counter, a
// last-viewed timestamp, and an individual quote_views row, so staff can
// see not just that it was opened but how many times and how recently —
// the actual signal for prioritising a lead ("viewed 6 times this week"
// means something very different from "opened once and went quiet").
export async function getQuoteContext(request, env, token) {
  const quote = await env.DB.prepare(
    `SELECT q.*, pt.name AS tier_name, pt.multiplier, pt.perks AS tier_perks, l.name AS lead_name, l.event_type
     FROM lead_quotes q LEFT JOIN pricing_tiers pt ON pt.id = q.pricing_tier_id
     JOIN leads l ON l.id = q.lead_id WHERE q.token = ?`
  ).bind(token).first();
  if (!quote) return notFound("invalid or expired quote link");

  const nowStatus = quote.status === "Draft" || quote.status === "Sent" ? "Viewed" : quote.status;
  await env.DB.batch([
    env.DB.prepare(`UPDATE lead_quotes SET view_count = view_count + 1, last_viewed_at = datetime('now'), status = ? WHERE id = ?`)
      .bind(nowStatus, quote.id),
    env.DB.prepare(`INSERT INTO quote_views (quote_id) VALUES (?)`).bind(quote.id),
  ]);
  // Only the transition INTO Viewed is worth a line on the lead's timeline —
  // every subsequent view still counts toward view_count/quote_views, but
  // logging every single one there would drown out everything else on it.
  if (quote.status === "Draft" || quote.status === "Sent") {
    await env.DB.prepare(`INSERT INTO lead_activities (lead_id, activity_type, description) VALUES (?, 'Quote viewed', NULL)`)
      .bind(quote.lead_id).run();
  }

  const { results: items } = await env.DB.prepare(`SELECT id, label, price, is_addon, selected FROM quote_items WHERE quote_id = ?`).bind(quote.id).all();
  const subtotal = items.filter((i) => i.selected).reduce((s, i) => s + i.price, 0);
  const total = Math.max(0, Math.round(subtotal * (quote.multiplier || 1)) - (quote.concession_amount || 0));
  const { results: comments } = await env.DB.prepare(
    `SELECT author, message, created_at FROM quote_comments WHERE quote_id = ? ORDER BY created_at ASC`
  ).bind(quote.id).all();

  return json({
    lead_name: quote.lead_name,
    event_type: quote.event_type,
    tier_name: quote.tier_name,
    tier_perks: quote.tier_perks,
    multiplier: quote.multiplier || 1,
    valid_until: quote.valid_until,
    concession_amount: quote.concession_amount,
    concession_note: quote.concession_note,
    items,
    subtotal,
    total,
    comments,
  });
}

// A customer message from the public quote page — "can you add a second
// videographer?", "do you have a package with more hours?". Stored on the
// thread AND logged as a lead activity, since a message sitting unread in a
// quote nobody's looking at is worse than not having the feature at all.
export async function addQuoteComment(request, env, token) {
  const body = await request.json().catch(() => null);
  const message = (body?.message || "").trim();
  if (!message) return badRequest("message is required");
  if (message.length > 2000) return badRequest("message is too long (2000 characters max)");
  const quote = await env.DB.prepare(`SELECT id, lead_id FROM lead_quotes WHERE token = ?`).bind(token).first();
  if (!quote) return notFound("invalid or expired quote link");

  await env.DB.batch([
    env.DB.prepare(`INSERT INTO quote_comments (quote_id, author, message) VALUES (?, 'customer', ?)`)
      .bind(quote.id, message),
    env.DB.prepare(`INSERT INTO lead_activities (lead_id, activity_type, description) VALUES (?, 'Quote comment', ?)`)
      .bind(quote.lead_id, message),
  ]);
  return json({ ok: true }, { status: 201 });
}

// Customer toggling one optional add-on — the only write a customer can
// make. Base/included items (is_addon = 0) are rejected outright: those
// stay admin-only, same as the concession.
export async function toggleQuoteItem(request, env, token) {
  const body = await request.json().catch(() => null);
  if (!body || !body.item_id || body.selected === undefined) return badRequest("item_id and selected are required");
  const quote = await env.DB.prepare(`SELECT id FROM lead_quotes WHERE token = ?`).bind(token).first();
  if (!quote) return notFound("invalid or expired quote link");
  const item = await env.DB.prepare(`SELECT * FROM quote_items WHERE id = ? AND quote_id = ?`).bind(body.item_id, quote.id).first();
  if (!item) return notFound("item not found on this quote");
  if (!item.is_addon) return badRequest("this item isn't adjustable");
  await env.DB.prepare(`UPDATE quote_items SET selected = ? WHERE id = ?`).bind(body.selected ? 1 : 0, item.id).run();
  return json({ ok: true });
}
