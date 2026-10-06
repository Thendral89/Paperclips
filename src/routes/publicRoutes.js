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
    `SELECT q.*, l.name AS lead_name, l.event_type
     FROM lead_quotes q JOIN leads l ON l.id = q.lead_id WHERE q.token = ?`
  ).bind(token).first();
  if (!quote) return notFound("invalid or expired quote link");

  const nowStatus = quote.status === "Draft" || quote.status === "Sent" ? "Viewed" : quote.status;
  const sessionKey=request.headers.get("x-quote-session")||null;
  await env.DB.batch([
    env.DB.prepare(`UPDATE lead_quotes SET view_count = view_count + 1, last_viewed_at = datetime('now'), status = ? WHERE id = ?`).bind(nowStatus, quote.id),
    env.DB.prepare(`INSERT INTO quote_views (quote_id,session_key) VALUES (?,?)`).bind(quote.id,sessionKey),
    env.DB.prepare(`INSERT INTO quote_engagement_events(quote_id,event_type,session_key) VALUES(?,'quote_opened',?)`).bind(quote.id,sessionKey),
  ]);
  if (quote.status === "Draft" || quote.status === "Sent") {
    await env.DB.prepare(`INSERT INTO lead_activities (lead_id, activity_type, description) VALUES (?, 'Quote viewed', NULL)`).bind(quote.lead_id).run();
  }

  const [{results:items},{results:options},{results:comments}] = await Promise.all([
    env.DB.prepare(`SELECT id,label,price,is_addon,selected,package_id,service_id FROM quote_items WHERE quote_id=? ORDER BY is_addon,id`).bind(quote.id).all(),
    env.DB.prepare(`SELECT id,package_id,label,price,details_json,selected,sort_order FROM quote_package_options WHERE quote_id=? ORDER BY sort_order,id`).bind(quote.id).all(),
    env.DB.prepare(`SELECT author,message,created_at FROM quote_comments WHERE quote_id=? ORDER BY created_at ASC`).bind(quote.id).all()
  ]);

  const packageIds=[...new Set(options.map(o=>o.package_id).filter(Boolean))];
  let packageServices={};
  if(packageIds.length){
    const placeholders=packageIds.map(()=>"?").join(",");
    const {results:ps}=await env.DB.prepare(`SELECT pi.package_id,s.id,s.name,pi.quantity
      FROM package_items pi JOIN services s ON s.id=pi.service_id
      WHERE pi.package_id IN (${placeholders}) ORDER BY s.name`).bind(...packageIds).all();
    for(const row of ps)(packageServices[row.package_id] ||= []).push({id:row.id,name:row.name,quantity:Number(row.quantity||1)});
  }

  for(const option of options){
    let details={};
    try{details=JSON.parse(option.details_json||"{}")}catch{}
    option.details=details;
    option.package_services=packageServices[option.package_id]||details.services||[];
  }
  const selectedOption=options.find(o=>Number(o.selected)===1);
  const addonTotal=items.filter(i=>Number(i.is_addon)===1 && Number(i.selected)===1).reduce((sum,i)=>sum+Number(i.price||0),0);
  const legacyBase=options.length ? 0 : items.filter(i=>Number(i.is_addon)===0 && Number(i.selected)===1).reduce((sum,i)=>sum+Number(i.price||0),0);
  const subtotal=Number(selectedOption?.price||0)+addonTotal+legacyBase;
  const total=Math.max(0,subtotal-Number(quote.concession_amount||0));

  return json({
    lead_name:quote.lead_name,event_type:quote.event_type,tier_name:null,tier_perks:null,multiplier:1,
    valid_until:quote.valid_until,concession_amount:quote.concession_amount,concession_note:quote.concession_note,
    items,options,selected_package_option_id:selectedOption?.id||null,subtotal,total,comments
  });
}

export async function selectQuotePackage(request, env, token) {
  const body=await request.json().catch(()=>null);
  const optionId=Number(body?.option_id||0);
  if(!optionId) return badRequest("option_id is required");
  const quote=await env.DB.prepare(`SELECT id,status FROM lead_quotes WHERE token=?`).bind(token).first();
  if(!quote) return notFound("invalid or expired quote link");
  if(["Accepted","Rejected","Expired","Cancelled"].includes(quote.status)) return badRequest("this Quote is no longer adjustable");
  const option=await env.DB.prepare(`SELECT id,package_id FROM quote_package_options WHERE id=? AND quote_id=?`).bind(optionId,quote.id).first();
  if(!option) return notFound("package option not found");
  const sessionKey=String(body?.session_key||"").slice(0,120)||null;
  await env.DB.batch([
    env.DB.prepare(`UPDATE quote_package_options SET selected=0,updated_at=datetime('now') WHERE quote_id=?`).bind(quote.id),
    env.DB.prepare(`UPDATE quote_package_options SET selected=1,updated_at=datetime('now') WHERE id=?`).bind(optionId),
    env.DB.prepare(`INSERT INTO quote_engagement_events(quote_id,event_type,package_id,session_key) VALUES(?,?,?,?,?)`.replace("VALUES(?,?,?,?,?)","VALUES(?,?,?,?)")).bind(quote.id,"package_selected",option.package_id,sessionKey)
  ]);
  return json({ok:true,selected_package_option_id:optionId});
}

// Meaningful quote engagement only. No scroll, mouse or keystroke telemetry.
export async function logQuoteEngagement(request, env, token) {
  const body = await request.json().catch(() => null);
  const allowed = new Set(["package_viewed","package_expanded","service_viewed","addon_viewed","package_selected","service_selected","addon_selected"]);
  const eventType = String(body?.event_type || "");
  if (!allowed.has(eventType)) return badRequest("unsupported engagement event");
  const quote = await env.DB.prepare("SELECT id FROM lead_quotes WHERE token=?").bind(token).first();
  if (!quote) return notFound("invalid or expired quote link");
  const itemId = body?.quote_item_id ? Number(body.quote_item_id) : null;
  const optionId = body?.package_option_id ? Number(body.package_option_id) : null;
  const item = itemId ? await env.DB.prepare("SELECT id,package_id,service_id,is_addon FROM quote_items WHERE id=? AND quote_id=?").bind(itemId,quote.id).first() : null;
  const option = optionId ? await env.DB.prepare("SELECT id,package_id FROM quote_package_options WHERE id=? AND quote_id=?").bind(optionId,quote.id).first() : null;
  if (itemId && !item) return notFound("quote item not found");
  if (optionId && !option) return notFound("package option not found");
  const sessionKey = String(body?.session_key || "").slice(0,120) || null;
  await env.DB.prepare(`INSERT INTO quote_engagement_events(quote_id,event_type,quote_item_id,package_id,service_id,session_key) VALUES(?,?,?,?,?,?)`)
    .bind(quote.id,item?.id||null,option?.package_id||item?.package_id||null,item?.service_id||null,sessionKey).run();
  return json({ok:true});
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
  if(["Accepted","Rejected","Expired","Cancelled"].includes(quote.status)) return badRequest("this Quote is no longer adjustable");
  const item = await env.DB.prepare(`SELECT * FROM quote_items WHERE id = ? AND quote_id = ?`).bind(body.item_id, quote.id).first();
  if (!item) return notFound("item not found on this quote");
  if (!item.is_addon) return badRequest("this item isn't adjustable");
  const selected=body.selected ? 1 : 0;
  const eventType=item.is_addon ? "addon_selected" : "service_selected";
  await env.DB.batch([
    env.DB.prepare(`UPDATE quote_items SET selected = ? WHERE id = ?`).bind(selected,item.id),
    env.DB.prepare(`INSERT INTO quote_engagement_events(
      quote_id,event_type,quote_item_id,package_id,service_id,session_key
    ) VALUES(?,?,?,?,?,?)`).bind(
      quote.id,eventType,item.id,item.package_id||null,item.service_id||null,body.session_key||null
    )
  ]);
  return json({ ok: true });
}
