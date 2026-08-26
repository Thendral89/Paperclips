// Everything behind Cloudflare Access. All of it assumes requireStaff()
// already ran in index.js and returned non-null.

import { json, badRequest, notFound, makeToken } from "../lib/util.js";

// ── Dashboard ────────────────────────────────────────────────────────
export async function dashboard(request, env) {
  const [today, overdue, newThisWeek, pendingPayments, upcomingEvents, dueInstallments] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM leads WHERE next_follow_up_date = date('now') AND stage NOT IN ('Booked','Lost')`
    ).all(),
    env.DB.prepare(
      `SELECT * FROM leads WHERE next_follow_up_date < date('now') AND stage NOT IN ('Booked','Lost') ORDER BY next_follow_up_date ASC`
    ).all(),
    env.DB.prepare(
      `SELECT * FROM leads WHERE created_at >= datetime('now','-7 days') ORDER BY created_at DESC`
    ).all(),
    env.DB.prepare(
      `SELECT e.id, a.name, (e.quote_total - e.advance_paid) AS balance
       FROM events e JOIN accounts a ON a.id = e.account_id
       WHERE (e.quote_total - e.advance_paid) > 0`
    ).all(),
    // Events in the next 7 days, with a live count of incomplete checklist
    // items — this is the "have I arranged everything" warning.
    env.DB.prepare(
      `SELECT e.id, e.type, e.event_date, a.name AS account_name,
              (SELECT COUNT(*) FROM event_checklist ec WHERE ec.event_id = e.id AND ec.done = 0) AS incomplete_checklist_items
       FROM events e JOIN accounts a ON a.id = e.account_id
       WHERE e.event_date BETWEEN date('now') AND date('now', '+7 days')
       ORDER BY e.event_date ASC`
    ).all(),
    env.DB.prepare(
      `SELECT ps.id, ps.event_id, ps.label, ps.amount, ps.due_date, a.name AS account_name
       FROM payment_schedule ps
       JOIN events e ON e.id = ps.event_id JOIN accounts a ON a.id = e.account_id
       WHERE ps.status = 'Pending' AND ps.due_date <= date('now', '+3 days')
       ORDER BY ps.due_date ASC`
    ).all(),
  ]);
  return json({
    todays_followups: today.results,
    overdue_followups: overdue.results,
    new_leads_7d: newThisWeek.results,
    pending_payments: pendingPayments.results,
    upcoming_events: upcomingEvents.results,
    installments_due: dueInstallments.results,
  });
}

// ── Leads ────────────────────────────────────────────────────────────
export async function listLeads(request, env) {
  const params = new URL(request.url).searchParams;
  const stage = params.get("stage");
  const since = params.get("since_days");     // e.g. "7" — created in the last N days
  const followUp = params.get("follow_up");   // "today" | "overdue"

  const clauses = [];
  const binds = [];
  if (stage) { clauses.push("stage = ?"); binds.push(stage); }
  if (since) { clauses.push("created_at >= datetime('now', ?)"); binds.push(`-${Number(since)} days`); }
  if (followUp === "today") { clauses.push("next_follow_up_date = date('now')"); }
  if (followUp === "overdue") { clauses.push("next_follow_up_date < date('now')"); }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = clauses.length ? "" : "LIMIT 200";
  const { results } = await env.DB.prepare(
    `SELECT * FROM leads ${where} ORDER BY created_at DESC ${limit}`
  ).bind(...binds).all();
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

// Edits the lead's own captured details (name/phone/etc.) — separate from
// updateLeadStage, which only ever moves the pipeline stage and is audited
// via lead_status_history. This endpoint fixes typos/updates from a call,
// not a pipeline event, so it deliberately doesn't touch stage or history.
export async function updateLeadDetails(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body) return badRequest("no fields given");
  const lead = await env.DB.prepare(`SELECT * FROM leads WHERE id = ?`).bind(id).first();
  if (!lead) return notFound("lead not found");
  const { normalizePhone } = await import("../lib/util.js");

  const name = body.name ?? lead.name;
  const phone = body.phone ?? lead.phone;
  const email = body.email !== undefined ? body.email || null : lead.email;
  const event_type = body.event_type !== undefined ? body.event_type || null : lead.event_type;
  const event_date = body.event_date !== undefined ? body.event_date || null : lead.event_date;
  const budget_est = body.budget_est !== undefined ? (body.budget_est ? Number(body.budget_est) : null) : lead.budget_est;
  const phone_normalized = body.phone !== undefined ? normalizePhone(phone) : lead.phone_normalized;

  await env.DB.prepare(
    `UPDATE leads SET name = ?, phone = ?, phone_normalized = ?, email = ?, event_type = ?, event_date = ?, budget_est = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(name, phone, phone_normalized, email, event_type, event_date, budget_est, id).run();
  return json({ ok: true });
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
      `SELECT * FROM payments WHERE event_id IN (${placeholders}) ORDER BY date DESC, id DESC`
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

// Fixes a typo'd name/phone/email on the account itself — separate from
// contacts (the bride/groom/planner list), which has its own edit below.
export async function updateAccountDetails(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body) return badRequest("no fields given");
  const account = await env.DB.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(id).first();
  if (!account) return notFound("account not found");
  const name = body.name ?? account.name;
  const phone = body.phone !== undefined ? body.phone || null : account.phone;
  const email = body.email !== undefined ? body.email || null : account.email;
  await env.DB.prepare(`UPDATE accounts SET name = ?, phone = ?, email = ? WHERE id = ?`)
    .bind(name, phone, email, id).run();
  return json({ ok: true });
}

export async function updateContact(request, env, contactId) {
  const body = await request.json().catch(() => null);
  if (!body) return badRequest("no fields given");
  const contact = await env.DB.prepare(`SELECT * FROM contacts WHERE id = ?`).bind(contactId).first();
  if (!contact) return notFound("contact not found");
  const name = body.name ?? contact.name;
  const role = body.role !== undefined ? body.role || null : contact.role;
  const phone = body.phone !== undefined ? body.phone || null : contact.phone;
  const email = body.email !== undefined ? body.email || null : contact.email;
  await env.DB.prepare(`UPDATE contacts SET name = ?, role = ?, phone = ?, email = ? WHERE id = ?`)
    .bind(name, role, phone, email, contactId).run();
  return json({ ok: true });
}

export async function deleteContact(request, env, contactId) {
  await env.DB.prepare(`DELETE FROM contacts WHERE id = ?`).bind(contactId).run();
  return json({ ok: true });
}

// ── Events / pricing / cross-sell ───────────────────────────────────

// Monday-start week/month bounds for the quick-filter bar. Computed in JS
// (not SQL date() modifiers) so "this week" always means the same thing
// regardless of which day the DB engine thinks a week starts on.
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
function weekBounds(offsetWeeks) {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + diffToMonday + offsetWeeks * 7));
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return [isoDate(monday), isoDate(sunday)];
}
function monthBounds(offsetMonths) {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths, 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths + 1, 0));
  return [isoDate(first), isoDate(last)];
}
const RANGE_PRESETS = {
  last_week: () => weekBounds(-1),
  this_week: () => weekBounds(0),
  next_week: () => weekBounds(1),
  this_month: () => monthBounds(0),
  next_month: () => monthBounds(1),
};

export async function listEvents(request, env) {
  const params = new URL(request.url).searchParams;
  const range = params.get("range") || "all";

  let from = null, to = null;
  if (range === "custom") {
    from = params.get("from");
    to = params.get("to");
    if (!from || !to) return badRequest("custom range requires from and to (YYYY-MM-DD)");
  } else if (RANGE_PRESETS[range]) {
    [from, to] = RANGE_PRESETS[range]();
  } else if (range !== "all") {
    return badRequest("range must be one of: this_week, last_week, next_week, this_month, next_month, custom, all");
  }

  const clauses = [];
  const binds = [];
  if (from && to) {
    clauses.push("e.event_date BETWEEN ? AND ?");
    binds.push(from, to);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const { results } = await env.DB.prepare(
    `SELECT e.id, e.type, e.event_date, e.venue, e.status,
            e.quote_total, e.advance_paid, (e.quote_total - e.advance_paid) AS balance_due,
            a.id AS account_id, a.name AS account_name,
            EXISTS(
              SELECT 1 FROM payment_schedule ps
              WHERE ps.event_id = e.id AND ps.status = 'Pending' AND ps.due_date < date('now')
            ) AS payment_overdue
     FROM events e JOIN accounts a ON a.id = e.account_id
     ${where}
     ORDER BY e.event_date ASC`
  ).bind(...binds).all();

  return json({ range, from, to, events: results });
}

export async function createEvent(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !body.account_id || !body.type) return badRequest("account_id and type are required");
  const result = await env.DB.prepare(
    `INSERT INTO events (account_id, type, event_date, venue, pricing_tier_id) VALUES (?, ?, ?, ?, ?)`
  )
    .bind(body.account_id, body.type, body.event_date || null, body.venue || null, body.pricing_tier_id || 1)
    .run();
  const eventId = result.meta.last_row_id;

  // Snapshot the shared checklist template onto this event — later template
  // edits shouldn't retroactively change events already in progress.
  const { results: template } = await env.DB.prepare(`SELECT item FROM checklist_templates ORDER BY sort_order`).all();
  if (template.length) {
    await env.DB.batch(
      template.map((t) => env.DB.prepare(`INSERT INTO event_checklist (event_id, item) VALUES (?, ?)`).bind(eventId, t.item))
    );
  }
  return json({ ok: true, id: eventId }, { status: 201 });
}

export async function getEvent(request, env, id) {
  const event = await env.DB.prepare(
    `SELECT e.*, pt.name AS tier_name, pt.multiplier FROM events e LEFT JOIN pricing_tiers pt ON pt.id = e.pricing_tier_id WHERE e.id = ?`
  ).bind(id).first();
  if (!event) return notFound("event not found");
  const [services, payments, links, vendors, schedule, deliverables, checklist, tasks] = await Promise.all([
    env.DB.prepare(
      `SELECT es.*, COALESCE(s.name, p.name) AS name, COALESCE(s.category, 'Package') AS category,
              CASE WHEN es.package_id IS NOT NULL THEN 1 ELSE 0 END AS is_package
       FROM event_services es
       LEFT JOIN services s ON s.id = es.service_id
       LEFT JOIN packages p ON p.id = es.package_id
       WHERE es.event_id = ?`
    ).bind(id).all(),
    env.DB.prepare(`SELECT * FROM payments WHERE event_id = ? ORDER BY date DESC, id DESC`).bind(id).all(),
    env.DB.prepare(`SELECT id, staff_name, role, cost, scope, expires_at, created_at FROM event_staff_links WHERE event_id = ?`).bind(id).all(),
    env.DB.prepare(
      `SELECT ev.*, v.name AS vendor_name, v.category AS vendor_category FROM event_vendors ev JOIN vendors v ON v.id = ev.vendor_id WHERE ev.event_id = ?`
    ).bind(id).all(),
    env.DB.prepare(`SELECT * FROM payment_schedule WHERE event_id = ? ORDER BY due_date ASC`).bind(id).all(),
    env.DB.prepare(`SELECT * FROM deliverables WHERE event_id = ? ORDER BY due_date ASC`).bind(id).all(),
    env.DB.prepare(`SELECT * FROM event_checklist WHERE event_id = ? ORDER BY id ASC`).bind(id).all(),
    env.DB.prepare(
      `SELECT et.*, esl.staff_name FROM event_tasks et LEFT JOIN event_staff_links esl ON esl.id = et.link_id WHERE et.event_id = ? ORDER BY et.created_at DESC`
    ).bind(id).all(),
  ]);
  // Real cost of running this event — internal staff cost + external vendor
  // cost + ad-hoc reimbursed expenses — set against the quote to show profit.
  const staffCost = links.results.reduce((s, l) => s + (l.cost || 0), 0);
  const vendorCost = vendors.results.reduce((s, v) => s + (v.cost || 0), 0);
  const { results: expenseRows } = await env.DB.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM expenses WHERE event_id = ?`).bind(id).all();
  const expenseCost = expenseRows[0]?.total || 0;
  const total_cost = staffCost + vendorCost + expenseCost;

  return json({
    ...event,
    services: services.results,
    payments: payments.results,
    staff_links: links.results,
    vendors: vendors.results,
    payment_schedule: schedule.results,
    deliverables: deliverables.results,
    checklist: checklist.results,
    tasks: tasks.results,
    cost_breakdown: { staff: staffCost, vendors: vendorCost, expenses: expenseCost, total: total_cost },
    profit: event.quote_total - total_cost,
  });
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

// Corrects a fat-fingered payment by removing it, not silently editing a
// recorded transaction — also reverses it out of the event's advance_paid,
// and clears the payment_schedule link if this payment was an installment.
export async function deletePayment(request, env, paymentId) {
  const payment = await env.DB.prepare(`SELECT * FROM payments WHERE id = ?`).bind(paymentId).first();
  if (!payment) return notFound("payment not found");
  await env.DB.batch([
    env.DB.prepare(`UPDATE events SET advance_paid = advance_paid - ? WHERE id = ?`).bind(payment.amount, payment.event_id),
    env.DB.prepare(`UPDATE payment_schedule SET status = 'Pending', paid_payment_id = NULL WHERE paid_payment_id = ?`).bind(paymentId),
    env.DB.prepare(`DELETE FROM payments WHERE id = ?`).bind(paymentId),
  ]);
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

export async function updatePackage(request, env, packageId) {
  const body = await request.json().catch(() => null);
  if (!body) return badRequest("no fields given");
  const pkg = await env.DB.prepare(`SELECT * FROM packages WHERE id = ?`).bind(packageId).first();
  if (!pkg) return notFound("package not found");
  const name = body.name ?? pkg.name;
  const description = body.description !== undefined ? body.description || null : pkg.description;
  const base_price = body.base_price !== undefined ? Number(body.base_price) : pkg.base_price;
  await env.DB.prepare(`UPDATE packages SET name = ?, description = ?, base_price = ? WHERE id = ?`)
    .bind(name, description, base_price, packageId).run();
  if (Array.isArray(body.service_ids)) {
    await env.DB.prepare(`DELETE FROM package_items WHERE package_id = ?`).bind(packageId).run();
    for (const serviceId of body.service_ids) {
      await env.DB.prepare(`INSERT OR IGNORE INTO package_items (package_id, service_id) VALUES (?, ?)`)
        .bind(packageId, serviceId).run();
    }
  }
  return json({ ok: true });
}

// Soft delete (active = 0, same flag listPackages already filters on) —
// events that already applied this package keep their price_at_booking
// snapshot untouched, so past quotes never change retroactively.
export async function deletePackage(request, env, packageId) {
  await env.DB.prepare(`UPDATE packages SET active = 0 WHERE id = ?`).bind(packageId).run();
  return json({ ok: true });
}

// ── Staff links (the tokenised photographer link) ───────────────────
export async function createStaffLink(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !body.event_id || !body.staff_name) return badRequest("event_id and staff_name are required");
  const token = makeToken();
  const expiresAt = body.expires_at || null; // e.g. event date + a few days, set by the caller
  await env.DB.prepare(
    `INSERT INTO event_staff_links (event_id, staff_name, role, cost, token, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(body.event_id, body.staff_name, body.role || null, body.cost ? Number(body.cost) : 0, token, body.scope || "expenses,support,tasks", expiresAt).run();
  const url = new URL(request.url);
  return json({ ok: true, token, url: `${url.origin}/portal/${token}` }, { status: 201 });
}

// Fixes a typo'd role/cost on a staff assignment — leaves the token/scope
// alone so an already-shared portal link keeps working.
export async function updateStaffLink(request, env, linkId) {
  const body = await request.json().catch(() => null);
  if (!body) return badRequest("no fields given");
  const link = await env.DB.prepare(`SELECT * FROM event_staff_links WHERE id = ?`).bind(linkId).first();
  if (!link) return notFound("staff link not found");
  const staff_name = body.staff_name ?? link.staff_name;
  const role = body.role !== undefined ? body.role || null : link.role;
  const cost = body.cost !== undefined ? Number(body.cost) : link.cost;
  await env.DB.prepare(`UPDATE event_staff_links SET staff_name = ?, role = ?, cost = ? WHERE id = ?`)
    .bind(staff_name, role, cost, linkId).run();
  return json({ ok: true });
}

// Removing a staff assignment also un-assigns (not deletes) any tasks that
// were pointed at them, so a task never silently vanishes.
export async function deleteStaffLink(request, env, linkId) {
  await env.DB.batch([
    env.DB.prepare(`UPDATE event_tasks SET link_id = NULL WHERE link_id = ?`).bind(linkId),
    env.DB.prepare(`DELETE FROM event_staff_links WHERE id = ?`).bind(linkId),
  ]);
  return json({ ok: true });
}

// ── Vendors / procurement — the "resources from outside" half ───────
export async function listVendors(request, env) {
  const { results } = await env.DB.prepare(`SELECT * FROM vendors ORDER BY category, name`).all();
  return json(results);
}

export async function createVendor(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !body.name) return badRequest("name is required");
  const result = await env.DB.prepare(
    `INSERT INTO vendors (name, category, phone, email, notes) VALUES (?, ?, ?, ?, ?)`
  ).bind(body.name, body.category || null, body.phone || null, body.email || null, body.notes || null).run();
  return json({ ok: true, id: result.meta.last_row_id }, { status: 201 });
}

export async function updateVendor(request, env, vendorId) {
  const body = await request.json().catch(() => null);
  if (!body) return badRequest("no fields given");
  const vendor = await env.DB.prepare(`SELECT * FROM vendors WHERE id = ?`).bind(vendorId).first();
  if (!vendor) return notFound("vendor not found");
  const name = body.name ?? vendor.name;
  const category = body.category !== undefined ? body.category || null : vendor.category;
  const phone = body.phone !== undefined ? body.phone || null : vendor.phone;
  await env.DB.prepare(`UPDATE vendors SET name = ?, category = ?, phone = ? WHERE id = ?`)
    .bind(name, category, phone, vendorId).run();
  return json({ ok: true });
}

// Blocks the delete if the vendor is actually booked on any event, rather
// than silently orphaning event_vendors rows — same spirit as the package
// soft-delete, just enforced differently since vendors have no active flag.
export async function deleteVendor(request, env, vendorId) {
  const used = await env.DB.prepare(`SELECT COUNT(*) AS n FROM event_vendors WHERE vendor_id = ?`).bind(vendorId).first();
  if (used.n > 0) return badRequest(`Can't delete — this vendor is booked on ${used.n} event(s). Remove them from those events first.`);
  await env.DB.prepare(`DELETE FROM vendors WHERE id = ?`).bind(vendorId).run();
  return json({ ok: true });
}

export async function addEventVendor(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body || !body.vendor_id) return badRequest("vendor_id is required");
  await env.DB.prepare(
    `INSERT INTO event_vendors (event_id, vendor_id, role, cost) VALUES (?, ?, ?, ?)`
  ).bind(id, body.vendor_id, body.role || null, body.cost ? Number(body.cost) : 0).run();
  return json({ ok: true }, { status: 201 });
}

export async function markEventVendorPaid(request, env, eventVendorId) {
  await env.DB.prepare(`UPDATE event_vendors SET payment_status = 'Paid' WHERE id = ?`).bind(eventVendorId).run();
  return json({ ok: true });
}

export async function updateEventVendor(request, env, eventVendorId) {
  const body = await request.json().catch(() => null);
  if (!body) return badRequest("no fields given");
  const ev = await env.DB.prepare(`SELECT * FROM event_vendors WHERE id = ?`).bind(eventVendorId).first();
  if (!ev) return notFound("event vendor not found");
  const role = body.role !== undefined ? body.role || null : ev.role;
  const cost = body.cost !== undefined ? Number(body.cost) : ev.cost;
  await env.DB.prepare(`UPDATE event_vendors SET role = ?, cost = ? WHERE id = ?`).bind(role, cost, eventVendorId).run();
  return json({ ok: true });
}

export async function deleteEventVendor(request, env, eventVendorId) {
  await env.DB.prepare(`DELETE FROM event_vendors WHERE id = ?`).bind(eventVendorId).run();
  return json({ ok: true });
}

// ── Payment schedule — the plan; `payments` (above) stays the ledger ──
export async function addPaymentScheduleItem(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body || !body.label || !body.amount) return badRequest("label and amount are required");
  await env.DB.prepare(
    `INSERT INTO payment_schedule (event_id, label, amount, due_date) VALUES (?, ?, ?, ?)`
  ).bind(id, body.label, Number(body.amount), body.due_date || null).run();
  return json({ ok: true }, { status: 201 });
}

export async function markPaymentScheduleItemPaid(request, env, scheduleId) {
  const body = await request.json().catch(() => ({}));
  const item = await env.DB.prepare(`SELECT * FROM payment_schedule WHERE id = ?`).bind(scheduleId).first();
  if (!item) return notFound("payment schedule item not found");
  const result = await env.DB.prepare(
    `INSERT INTO payments (event_id, amount, method, note) VALUES (?, ?, ?, ?)`
  ).bind(item.event_id, item.amount, body?.method || null, `Installment: ${item.label}`).run();
  await env.DB.batch([
    env.DB.prepare(`UPDATE payment_schedule SET status = 'Paid', paid_payment_id = ? WHERE id = ?`)
      .bind(result.meta.last_row_id, scheduleId),
    env.DB.prepare(`UPDATE events SET advance_paid = advance_paid + ? WHERE id = ?`).bind(item.amount, item.event_id),
  ]);
  return json({ ok: true });
}

// Only lets you fix a Pending installment — once it's Paid it's linked to a
// real payments-ledger row, so editing/deleting it here would desync the two.
export async function updatePaymentScheduleItem(request, env, scheduleId) {
  const body = await request.json().catch(() => null);
  if (!body) return badRequest("no fields given");
  const item = await env.DB.prepare(`SELECT * FROM payment_schedule WHERE id = ?`).bind(scheduleId).first();
  if (!item) return notFound("payment schedule item not found");
  if (item.status === "Paid") return badRequest("This installment is already marked paid — edit the payment in the ledger instead.");
  const label = body.label ?? item.label;
  const amount = body.amount !== undefined ? Number(body.amount) : item.amount;
  const due_date = body.due_date !== undefined ? body.due_date || null : item.due_date;
  await env.DB.prepare(`UPDATE payment_schedule SET label = ?, amount = ?, due_date = ? WHERE id = ?`)
    .bind(label, amount, due_date, scheduleId).run();
  return json({ ok: true });
}

export async function deletePaymentScheduleItem(request, env, scheduleId) {
  const item = await env.DB.prepare(`SELECT status FROM payment_schedule WHERE id = ?`).bind(scheduleId).first();
  if (!item) return notFound("payment schedule item not found");
  if (item.status === "Paid") return badRequest("This installment is already marked paid — it can't be deleted.");
  await env.DB.prepare(`DELETE FROM payment_schedule WHERE id = ?`).bind(scheduleId).run();
  return json({ ok: true });
}

// ── Deliverables — post-event production pipeline ────────────────────
export async function addDeliverable(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body || !body.name) return badRequest("name is required");
  await env.DB.prepare(
    `INSERT INTO deliverables (event_id, name, due_date, notes) VALUES (?, ?, ?, ?)`
  ).bind(id, body.name, body.due_date || null, body.notes || null).run();
  return json({ ok: true }, { status: 201 });
}

export async function updateDeliverableStatus(request, env, deliverableId) {
  const body = await request.json().catch(() => null);
  if (!body || !body.status) return badRequest("status is required");
  const deliveredAt = body.status === "Delivered" ? "datetime('now')" : "NULL";
  await env.DB.prepare(
    `UPDATE deliverables SET status = ?, delivered_at = ${deliveredAt} WHERE id = ?`
  ).bind(body.status, deliverableId).run();
  return json({ ok: true });
}

// Fixes name/due date/notes — separate from updateDeliverableStatus above,
// which only ever moves the production-pipeline status.
export async function updateDeliverable(request, env, deliverableId) {
  const body = await request.json().catch(() => null);
  if (!body) return badRequest("no fields given");
  const d = await env.DB.prepare(`SELECT * FROM deliverables WHERE id = ?`).bind(deliverableId).first();
  if (!d) return notFound("deliverable not found");
  const name = body.name ?? d.name;
  const due_date = body.due_date !== undefined ? body.due_date || null : d.due_date;
  await env.DB.prepare(`UPDATE deliverables SET name = ?, due_date = ? WHERE id = ?`)
    .bind(name, due_date, deliverableId).run();
  return json({ ok: true });
}

export async function deleteDeliverable(request, env, deliverableId) {
  await env.DB.prepare(`DELETE FROM deliverables WHERE id = ?`).bind(deliverableId).run();
  return json({ ok: true });
}

// ── Pre-event checklist ────────────────────────────────────────────
export async function toggleChecklistItem(request, env, itemId) {
  const item = await env.DB.prepare(`SELECT done FROM event_checklist WHERE id = ?`).bind(itemId).first();
  if (!item) return notFound("checklist item not found");
  const done = item.done ? 0 : 1;
  await env.DB.prepare(
    `UPDATE event_checklist SET done = ?, done_at = ${done ? "datetime('now')" : "NULL"} WHERE id = ?`
  ).bind(done, itemId).run();
  return json({ ok: true, done: !!done });
}

export async function listChecklistTemplates(request, env) {
  const { results } = await env.DB.prepare(`SELECT * FROM checklist_templates ORDER BY sort_order`).all();
  return json(results);
}

export async function addChecklistTemplateItem(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !body.item) return badRequest("item is required");
  const { results } = await env.DB.prepare(`SELECT COALESCE(MAX(sort_order),0) AS m FROM checklist_templates`).all();
  await env.DB.prepare(`INSERT INTO checklist_templates (item, sort_order) VALUES (?, ?)`)
    .bind(body.item, (results[0]?.m || 0) + 1).run();
  return json({ ok: true }, { status: 201 });
}

export async function removeChecklistTemplateItem(request, env, itemId) {
  await env.DB.prepare(`DELETE FROM checklist_templates WHERE id = ?`).bind(itemId).run();
  return json({ ok: true });
}

// ── Staff tasks — admin assigns, staff update via their portal link ──
export async function addEventTask(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body || !body.task) return badRequest("task is required");
  await env.DB.prepare(
    `INSERT INTO event_tasks (event_id, link_id, task) VALUES (?, ?, ?)`
  ).bind(id, body.link_id || null, body.task).run();
  return json({ ok: true }, { status: 201 });
}

export async function updateEventTask(request, env, taskId) {
  const body = await request.json().catch(() => null);
  if (!body) return badRequest("no fields given");
  const t = await env.DB.prepare(`SELECT * FROM event_tasks WHERE id = ?`).bind(taskId).first();
  if (!t) return notFound("task not found");
  const task = body.task ?? t.task;
  const link_id = body.link_id !== undefined ? body.link_id || null : t.link_id;
  await env.DB.prepare(`UPDATE event_tasks SET task = ?, link_id = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(task, link_id, taskId).run();
  return json({ ok: true });
}

export async function deleteEventTask(request, env, taskId) {
  await env.DB.prepare(`DELETE FROM event_tasks WHERE id = ?`).bind(taskId).run();
  return json({ ok: true });
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

// Per-event profit — revenue (quote_total) minus real cost (internal staff +
// external vendors + reimbursed expenses). This is the "what did we actually
// make on this event" number, not just what was billed.
export async function reportProfitability(request, env) {
  const { results: events } = await env.DB.prepare(
    `SELECT e.id, e.type, e.event_date, e.quote_total, a.name AS account_name,
            COALESCE((SELECT SUM(cost) FROM event_staff_links WHERE event_id = e.id), 0) AS staff_cost,
            COALESCE((SELECT SUM(cost) FROM event_vendors WHERE event_id = e.id), 0) AS vendor_cost,
            COALESCE((SELECT SUM(amount) FROM expenses WHERE event_id = e.id), 0) AS expense_cost
     FROM events e JOIN accounts a ON a.id = e.account_id
     ORDER BY e.event_date DESC`
  ).all();
  const rows = events.map((e) => {
    const cost = e.staff_cost + e.vendor_cost + e.expense_cost;
    const profit = e.quote_total - cost;
    return { ...e, cost, profit, margin_pct: e.quote_total ? Math.round((profit / e.quote_total) * 1000) / 10 : 0 };
  });
  const totals = rows.reduce(
    (acc, r) => ({ revenue: acc.revenue + r.quote_total, cost: acc.cost + r.cost, profit: acc.profit + r.profit }),
    { revenue: 0, cost: 0, profit: 0 }
  );
  return json({ events: rows, totals });
}

// Trailing 6-month revenue/cost/profit rollup — "3-month sale", "turnover",
// "running profit" all read off this one report.
export async function reportMonthly(request, env) {
  const { results } = await env.DB.prepare(
    `SELECT
       strftime('%Y-%m', e.event_date) AS month,
       COUNT(*) AS events,
       SUM(e.quote_total) AS revenue,
       SUM(COALESCE((SELECT SUM(cost) FROM event_staff_links WHERE event_id = e.id), 0)
         + COALESCE((SELECT SUM(cost) FROM event_vendors WHERE event_id = e.id), 0)
         + COALESCE((SELECT SUM(amount) FROM expenses WHERE event_id = e.id), 0)) AS cost
     FROM events e
     WHERE e.event_date >= date('now', '-6 months')
     GROUP BY month ORDER BY month ASC`
  ).all();
  return json(results.map((r) => ({ ...r, profit: r.revenue - r.cost })));
}
