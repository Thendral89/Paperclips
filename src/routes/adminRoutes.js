// Everything behind Cloudflare Access. All of it assumes requireStaff()
// already ran in index.js and returned non-null.

import { json, badRequest, notFound, makeToken } from "../lib/util.js";

// ── Dashboard ────────────────────────────────────────────────────────
export async function dashboard(request, env) {
  const [today, overdue, newThisWeek, pendingPayments] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM leads WHERE next_follow_up_date = date('now') AND stage NOT IN ('Booked','Lost')`
    ).all(),
    env.DB.prepare(
      `SELECT * FROM leads WHERE next_follow_up_date < date('now') AND stage NOT IN ('Booked','Lost') ORDER BY next_follow_up_date ASC`
    ).all(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM leads WHERE created_at >= datetime('now','-7 days')`
    ).first(),
    env.DB.prepare(
      `SELECT e.id, a.name, (e.quote_total - e.advance_paid) AS balance
       FROM events e JOIN accounts a ON a.id = e.account_id
       WHERE (e.quote_total - e.advance_paid) > 0`
    ).all(),
  ]);
  return json({
    todays_followups: today.results,
    overdue_followups: overdue.results,
    new_leads_7d: newThisWeek.n,
    pending_payments: pendingPayments.results,
  });
}

// ── Leads ────────────────────────────────────────────────────────────
export async function listLeads(request, env) {
  const stage = new URL(request.url).searchParams.get("stage");
  const q = stage
    ? env.DB.prepare(`SELECT * FROM leads WHERE stage = ? ORDER BY created_at DESC`).bind(stage)
    : env.DB.prepare(`SELECT * FROM leads ORDER BY created_at DESC LIMIT 200`);
  const { results } = await q.all();
  return json(results);
}

export async function getLead(request, env, id) {
  const lead = await env.DB.prepare(`SELECT * FROM leads WHERE id = ?`).bind(id).first();
  if (!lead) return notFound("lead not found");
  const [notes, history, account] = await Promise.all([
    env.DB.prepare(`SELECT * FROM lead_notes WHERE lead_id = ? ORDER BY created_at DESC`).bind(id).all(),
    env.DB.prepare(`SELECT * FROM lead_status_history WHERE lead_id = ? ORDER BY changed_at DESC`).bind(id).all(),
    env.DB.prepare(`SELECT id FROM accounts WHERE lead_id = ?`).bind(id).first(),
  ]);
  return json({ ...lead, notes: notes.results, status_history: history.results, account_id: account?.id || null });
}

export async function createLeadManual(request, env, staff) {
  const body = await request.json().catch(() => null);
  if (!body || !body.name || !body.phone) return badRequest("name and phone are required");
  const { normalizePhone } = await import("../lib/util.js");
  const phone_normalized = normalizePhone(body.phone);
  const result = await env.DB.prepare(
    `INSERT INTO leads (name, phone, phone_normalized, email, source, event_type, event_date, budget_est, referred_by, message, stage)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'New')`
  )
    .bind(
      body.name, body.phone, phone_normalized, body.email || null,
      body.source || "Manual", body.event_type || null, body.event_date || null,
      body.budget_est ? Number(body.budget_est) : null, body.referred_by || null, body.message || null
    )
    .run();
  const id = result.meta.last_row_id;
  await env.DB.prepare(`INSERT INTO lead_status_history (lead_id, to_stage, changed_by) VALUES (?, 'New', ?)`)
    .bind(id, staff.email).run();
  return json({ ok: true, id }, { status: 201 });
}

export async function updateLeadStage(request, env, id, staff) {
  const body = await request.json().catch(() => null);
  if (!body || !body.stage) return badRequest("stage is required");
  if (body.stage === "Lost" && !body.lost_reason) return badRequest("lost_reason is required when marking a lead Lost");
  const lead = await env.DB.prepare(`SELECT stage FROM leads WHERE id = ?`).bind(id).first();
  if (!lead) return notFound("lead not found");

  await env.DB.batch([
    env.DB.prepare(`UPDATE leads SET stage = ?, lost_reason = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(body.stage, body.stage === "Lost" ? body.lost_reason : null, id),
    env.DB.prepare(`INSERT INTO lead_status_history (lead_id, from_stage, to_stage, changed_by) VALUES (?, ?, ?, ?)`)
      .bind(id, lead.stage, body.stage, staff.email),
  ]);
  return json({ ok: true });
}

export async function setFollowUp(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body || !body.date) return badRequest("date is required, YYYY-MM-DD");
  await env.DB.prepare(`UPDATE leads SET next_follow_up_date = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(body.date, id).run();
  // TODO calendar sync: once a Google service account + the existing "Paperclip
  // Studios CRM Sync" calendar ID are configured as secrets, call the Calendar
  // API here to create/update the matching event. Left as a stub so this ships
  // without inventing credentials you haven't given me — see README.
  return json({ ok: true });
}

export async function addNote(request, env, id, staff) {
  const body = await request.json().catch(() => null);
  if (!body || !body.note) return badRequest("note is required");
  await env.DB.prepare(`INSERT INTO lead_notes (lead_id, author, note) VALUES (?, ?, ?)`)
    .bind(id, staff.email, body.note).run();
  return json({ ok: true });
}

// ── Convert lead → account ──────────────────────────────────────────
export async function convertLead(request, env, id) {
  const lead = await env.DB.prepare(`SELECT * FROM leads WHERE id = ?`).bind(id).first();
  if (!lead) return notFound("lead not found");
  const existing = await env.DB.prepare(`SELECT id FROM accounts WHERE lead_id = ?`).bind(id).first();
  if (existing) return json({ ok: true, account_id: existing.id });

  const result = await env.DB.prepare(
    `INSERT INTO accounts (lead_id, name, phone, email, client_since) VALUES (?, ?, ?, ?, datetime('now'))`
  )
    .bind(id, lead.name, lead.phone, lead.email)
    .run();
  await env.DB.prepare(`UPDATE leads SET stage = 'Booked', updated_at = datetime('now') WHERE id = ?`).bind(id).run();
  return json({ ok: true, account_id: result.meta.last_row_id }, { status: 201 });
}

// ── Accounts / Customer 360 ─────────────────────────────────────────
export async function listAccounts(request, env) {
  const { results } = await env.DB.prepare(`SELECT * FROM accounts ORDER BY client_since DESC`).all();
  return json(results);
}

export async function getAccount360(request, env, id) {
  const account = await env.DB.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(id).first();
  if (!account) return notFound("account not found");
  const [{ results: events }, { results: contacts }] = await Promise.all([
    env.DB.prepare(
      `SELECT e.*, pt.name AS tier_name FROM events e LEFT JOIN pricing_tiers pt ON pt.id = e.pricing_tier_id
       WHERE e.account_id = ? ORDER BY e.event_date DESC`
    ).bind(id).all(),
    env.DB.prepare(`SELECT * FROM contacts WHERE account_id = ? ORDER BY is_primary DESC, created_at ASC`).bind(id).all(),
  ]);

  const eventIds = events.map((e) => e.id);
  let payments = [];
  let ltv = 0;
  if (eventIds.length) {
    const placeholders = eventIds.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT * FROM payments WHERE event_id IN (${placeholders}) ORDER BY date DESC`
    ).bind(...eventIds).all();
    payments = results;
    ltv = events.reduce((sum, e) => sum + (e.quote_total || 0), 0);
  }
  return json({ ...account, events, payments, contacts, lifetime_value: ltv });
}

export async function addContact(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body || !body.name) return badRequest("name is required");
  const account = await env.DB.prepare(`SELECT id FROM accounts WHERE id = ?`).bind(id).first();
  if (!account) return notFound("account not found");
  await env.DB.prepare(
    `INSERT INTO contacts (account_id, name, role, phone, email, is_primary) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, body.name, body.role || null, body.phone || null, body.email || null, body.is_primary ? 1 : 0).run();
  return json({ ok: true }, { status: 201 });
}

// ── Events / pricing / cross-sell ───────────────────────────────────
export async function createEvent(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !body.account_id || !body.type) return badRequest("account_id and type are required");
  const result = await env.DB.prepare(
    `INSERT INTO events (account_id, type, event_date, venue, pricing_tier_id) VALUES (?, ?, ?, ?, ?)`
  )
    .bind(body.account_id, body.type, body.event_date || null, body.venue || null, body.pricing_tier_id || 1)
    .run();
  return json({ ok: true, id: result.meta.last_row_id }, { status: 201 });
}

export async function getEvent(request, env, id) {
  const event = await env.DB.prepare(
    `SELECT e.*, pt.name AS tier_name, pt.multiplier FROM events e LEFT JOIN pricing_tiers pt ON pt.id = e.pricing_tier_id WHERE e.id = ?`
  ).bind(id).first();
  if (!event) return notFound("event not found");
  const [services, payments, links] = await Promise.all([
    env.DB.prepare(
      `SELECT es.*, COALESCE(s.name, p.name) AS name, COALESCE(s.category, 'Package') AS category,
              CASE WHEN es.package_id IS NOT NULL THEN 1 ELSE 0 END AS is_package
       FROM event_services es
       LEFT JOIN services s ON s.id = es.service_id
       LEFT JOIN packages p ON p.id = es.package_id
       WHERE es.event_id = ?`
    ).bind(id).all(),
    env.DB.prepare(`SELECT * FROM payments WHERE event_id = ? ORDER BY date DESC`).bind(id).all(),
    env.DB.prepare(`SELECT id, staff_name, scope, expires_at, created_at FROM event_staff_links WHERE event_id = ?`).bind(id).all(),
  ]);
  return json({ ...event, services: services.results, payments: payments.results, staff_links: links.results });
}

export async function addEventService(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body || !body.service_id) return badRequest("service_id is required");
  const service = await env.DB.prepare(`SELECT * FROM services WHERE id = ?`).bind(body.service_id).first();
  if (!service) return notFound("service not found");
  await env.DB.prepare(
    `INSERT INTO event_services (event_id, service_id, price_at_booking, is_crosssell) VALUES (?, ?, ?, ?)`
  ).bind(id, body.service_id, service.base_price, body.is_crosssell ? 1 : 0).run();

  await recomputeQuote(env, id);
  return json({ ok: true });
}

export async function applyPackageToEvent(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body || !body.package_id) return badRequest("package_id is required");
  const pkg = await env.DB.prepare(`SELECT * FROM packages WHERE id = ? AND active = 1`).bind(body.package_id).first();
  if (!pkg) return notFound("package not found");
  await env.DB.prepare(
    `INSERT INTO event_services (event_id, package_id, price_at_booking, is_crosssell) VALUES (?, ?, ?, 0)`
  ).bind(id, pkg.id, pkg.base_price).run();

  await recomputeQuote(env, id);
  return json({ ok: true });
}

export async function setEventTier(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body || !body.pricing_tier_id) return badRequest("pricing_tier_id is required");
  await env.DB.prepare(`UPDATE events SET pricing_tier_id = ? WHERE id = ?`).bind(body.pricing_tier_id, id).run();
  await recomputeQuote(env, id);
  return json({ ok: true });
}

async function recomputeQuote(env, eventId) {
  const event = await env.DB.prepare(
    `SELECT e.id, pt.multiplier FROM events e LEFT JOIN pricing_tiers pt ON pt.id = e.pricing_tier_id WHERE e.id = ?`
  ).bind(eventId).first();
  const { results } = await env.DB.prepare(
    `SELECT price_at_booking FROM event_services WHERE event_id = ?`
  ).bind(eventId).all();
  const base = results.reduce((s, r) => s + r.price_at_booking, 0);
  const total = Math.round(base * (event?.multiplier || 1));
  await env.DB.prepare(`UPDATE events SET quote_total = ? WHERE id = ?`).bind(total, eventId).run();
}

export async function addPayment(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body || !body.amount) return badRequest("amount is required");
  await env.DB.prepare(
    `INSERT INTO payments (event_id, amount, method, note) VALUES (?, ?, ?, ?)`
  ).bind(id, Number(body.amount), body.method || null, body.note || null).run();
  await env.DB.prepare(
    `UPDATE events SET advance_paid = advance_paid + ? WHERE id = ?`
  ).bind(Number(body.amount), id).run();
  return json({ ok: true });
}

// ── Catalogue ────────────────────────────────────────────────────────
export async function listServices(request, env) {
  const { results } = await env.DB.prepare(`SELECT * FROM services ORDER BY category, name`).all();
  return json(results);
}
export async function listTiers(request, env) {
  const { results } = await env.DB.prepare(`SELECT * FROM pricing_tiers ORDER BY multiplier`).all();
  return json(results);
}

// ── Packages (fixed bundles you can still add a-la-carte extras on top of) ──
export async function listPackages(request, env) {
  const [{ results: packages }, { results: items }] = await Promise.all([
    env.DB.prepare(`SELECT * FROM packages WHERE active = 1 ORDER BY base_price`).all(),
    env.DB.prepare(
      `SELECT pi.package_id, s.name, pi.quantity FROM package_items pi JOIN services s ON s.id = pi.service_id`
    ).all(),
  ]);
  const byPackage = {};
  for (const it of items) (byPackage[it.package_id] ||= []).push({ name: it.name, quantity: it.quantity });
  return json(packages.map((p) => ({ ...p, items: byPackage[p.id] || [] })));
}

export async function createPackage(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !body.name || !body.base_price) return badRequest("name and base_price are required");
  const result = await env.DB.prepare(`INSERT INTO packages (name, description, base_price) VALUES (?, ?, ?)`)
    .bind(body.name, body.description || null, Number(body.base_price))
    .run();
  const packageId = result.meta.last_row_id;
  if (Array.isArray(body.service_ids)) {
    for (const serviceId of body.service_ids) {
      await env.DB.prepare(`INSERT OR IGNORE INTO package_items (package_id, service_id) VALUES (?, ?)`)
        .bind(packageId, serviceId).run();
    }
  }
  return json({ ok: true, id: packageId }, { status: 201 });
}

// ── Staff links (the tokenised photographer link) ───────────────────
export async function createStaffLink(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !body.event_id || !body.staff_name) return badRequest("event_id and staff_name are required");
  const token = makeToken();
  const expiresAt = body.expires_at || null; // e.g. event date + a few days, set by the caller
  await env.DB.prepare(
    `INSERT INTO event_staff_links (event_id, staff_name, token, scope, expires_at) VALUES (?, ?, ?, ?, ?)`
  ).bind(body.event_id, body.staff_name, token, body.scope || "expenses,support", expiresAt).run();
  const url = new URL(request.url);
  return json({ ok: true, token, url: `${url.origin}/portal/${token}` }, { status: 201 });
}

// ── Reports (blueprint §6) ───────────────────────────────────────────
export async function reportConversion(request, env) {
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN stage = 'Booked' THEN 1 ELSE 0 END) AS booked
     FROM leads WHERE created_at >= datetime('now','-90 days')`
  ).first();
  const pct = row.total ? Math.round((row.booked / row.total) * 1000) / 10 : 0;
  return json({ total: row.total, booked: row.booked, conversion_pct: pct, window: "90 days" });
}

export async function reportSourceRoi(request, env) {
  const { results } = await env.DB.prepare(
    `SELECT
       source,
       COUNT(*) AS leads,
       SUM(CASE WHEN stage = 'Booked' THEN 1 ELSE 0 END) AS booked,
       SUM(CASE WHEN stage = 'Booked' THEN budget_est ELSE 0 END) AS booked_value
     FROM leads GROUP BY source ORDER BY booked_value DESC`
  ).all();
  return json(results);
}
