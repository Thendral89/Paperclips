// Everything behind Cloudflare Access. All of it assumes requireStaff()
// already ran in index.js and returned non-null.

import { json, badRequest, notFound, makeToken, normalizePhone, toCSV, parseCSV } from "../lib/util.js";
import { syncCrmEvent, syncLeadFollowUp } from "../lib/googleCalendar.js";

// ── Dashboard ────────────────────────────────────────────────────────
export async function dashboard(request, env) {
  const [today, overdue, newThisWeek, pendingPayments, upcomingEvents, dueInstallments] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM leads WHERE next_follow_up_date = date('now') AND stage NOT IN ('Won','Lost','Cancelled')`
    ).all(),
    env.DB.prepare(
      `SELECT * FROM leads WHERE next_follow_up_date < date('now') AND stage NOT IN ('Won','Lost','Cancelled') ORDER BY next_follow_up_date ASC`
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
  const search = (params.get("q") || "").trim();

  const clauses = [];
  const binds = [];
  if (stage) { clauses.push("stage = ?"); binds.push(stage); }
  if (since) { clauses.push("created_at >= datetime('now', ?)"); binds.push(`-${Number(since)} days`); }
  if (followUp === "today") { clauses.push("next_follow_up_date = date('now')"); }
  if (followUp === "overdue") { clauses.push("next_follow_up_date < date('now')"); }
  if (search) {
    clauses.push("(name LIKE ? OR phone LIKE ? OR COALESCE(email,'') LIKE ? OR COALESCE(source,'') LIKE ? OR COALESCE(event_type,'') LIKE ?)");
    const term = `%${search}%`;
    binds.push(term, term, term, term, term);
  }

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
  const [activities, account, quotes, history, contacts] = await Promise.all([
    env.DB.prepare(`SELECT * FROM lead_activities WHERE lead_id = ? ORDER BY created_at DESC`).bind(id).all(),
    env.DB.prepare(`SELECT id FROM accounts WHERE lead_id = ?`).bind(id).first(),
    env.DB.prepare(`SELECT * FROM lead_quotes WHERE lead_id = ? ORDER BY version DESC, id DESC`).bind(id).all(),
    env.DB.prepare(`SELECT * FROM lead_status_history WHERE lead_id = ? ORDER BY changed_at DESC, id DESC`).bind(id).all(),
    env.DB.prepare(`SELECT * FROM lead_contacts WHERE lead_id = ? ORDER BY is_primary DESC,id`).bind(id).all(),
  ]);
  return json({ ...lead, activities: activities.results, account_id: account?.id || null, quotes: quotes.results, stage_history: history.results, contacts: contacts.results });
}

export async function createLeadManual(request, env, staff) {
  const body = await request.json().catch(() => null);
  if (!body || !body.name || !body.phone) return badRequest("name and phone are required");
  const { normalizePhone } = await import("../lib/util.js");
  const phone_normalized = normalizePhone(body.phone);
  const result = await env.DB.prepare(
    `INSERT INTO leads (name, phone, phone_normalized, email, source, event_type, event_date, venue, budget_est, referred_by, message, stage)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'New')`
  )
    .bind(
      body.name, body.phone, phone_normalized, body.email || null,
      body.source || "Manual", body.event_type || null, body.event_date || null, body.venue || null,
      body.budget_est ? Number(body.budget_est) : null, body.referred_by || null, body.message || null
    )
    .run();
  const id = result.meta.last_row_id;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO lead_status_history (lead_id, to_stage, changed_by) VALUES (?, 'New', ?)`).bind(id, staff.email),
    env.DB.prepare(`INSERT INTO lead_activities (lead_id, activity_type, description, created_by) VALUES (?, 'Lead Created', 'Lead created', ?)`).bind(id, staff.email)
  ]);
  return json({ ok: true, id }, { status: 201 });
}

const LEAD_CSV_COLUMNS = [
  { key: "id", label: "ID" },
  { key: "name", label: "Name" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
  { key: "source", label: "Source" },
  { key: "event_type", label: "Event Type" },
  { key: "event_date", label: "Event Date" },
  { key: "budget_est", label: "Budget Est" },
  { key: "stage", label: "Stage" },
  { key: "next_follow_up_date", label: "Follow-up Date" },
  { key: "referred_by", label: "Referred By" },
  { key: "message", label: "Message" },
  { key: "lost_reason", label: "Lost/Cancelled Reason" },
  { key: "created_at", label: "Created At" },
  { key: "updated_at", label: "Updated At" },
];

export async function exportLeadsCsv(request, env) {
  const { results } = await env.DB.prepare(`SELECT * FROM leads ORDER BY created_at DESC`).all();
  const csv = toCSV(results, LEAD_CSV_COLUMNS);
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}

// Import format: a CSV with a header row, columns matched case-insensitively
// (spaces or underscores both work — "Event Type" and "event_type" both hit
// r.event_type below via the lookup chain). Only name and phone are
// required; everything else is optional and defaults sensibly.
//
// Dedup rule: a row whose normalized phone matches a lead already in the
// database is SKIPPED, never merged or overwritten. An importer's job is to
// add what's missing, not to silently clobber a lead someone's mid-follow-up
// on — that's what the "duplicate" skip reason in the response is for. Rows
// are also deduped against each other within the same file. Re-running the
// same file twice is safe: the second run skips everything as duplicates.
export async function importLeadsCsv(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !body.csv) return badRequest("csv text is required");
  const { rows } = parseCSV(body.csv);
  if (!rows.length) return badRequest("no data rows found in the CSV");

  const existing = await env.DB.prepare(`SELECT phone_normalized FROM leads`).all();
  const seenPhones = new Set(existing.results.map((r) => r.phone_normalized));

  const field = (r, ...names) => {
    for (const n of names) { const v = r[n]; if (v) return v; }
    return "";
  };

  let created = 0;
  const skipped = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowNum = i + 2; // header is row 1, so the first data row is row 2
    const name = field(r, "name", "lead name", "full name");
    const phone = field(r, "phone", "phone number", "mobile");
    if (!name || !phone) { skipped.push({ row: rowNum, reason: "missing name or phone" }); continue; }
    const phone_normalized = normalizePhone(phone);
    if (!phone_normalized) { skipped.push({ row: rowNum, reason: "phone has no usable digits" }); continue; }
    if (seenPhones.has(phone_normalized)) { skipped.push({ row: rowNum, reason: `duplicate — phone already on file (${name})` }); continue; }

    const budgetRaw = field(r, "budget_est", "budget est", "budget");
    await env.DB.prepare(
      `INSERT INTO leads (name, phone, phone_normalized, email, source, event_type, event_date, budget_est, referred_by, message, stage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'New')`
    ).bind(
      name, phone, phone_normalized, field(r, "email") || null,
      field(r, "source") || "Manual",
      field(r, "event_type", "event type") || null,
      field(r, "event_date", "event date") || null,
      budgetRaw ? Number(budgetRaw) : null,
      field(r, "referred_by", "referred by") || null,
      field(r, "message", "notes") || null
    ).run();
    seenPhones.add(phone_normalized);
    created++;
  }
  return json({ ok: true, created, skipped_count: skipped.length, skipped });
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
  const venue = body.venue !== undefined ? body.venue || null : lead.venue;
  const phone_normalized = body.phone !== undefined ? normalizePhone(phone) : lead.phone_normalized;

  await env.DB.prepare(
    `UPDATE leads SET name = ?, phone = ?, phone_normalized = ?, email = ?, event_type = ?, event_date = ?, venue = ?, budget_est = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(name, phone, phone_normalized, email, event_type, event_date, venue, budget_est, id).run();
  return json({ ok: true });
}

export async function addLeadContact(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body || !body.name) return badRequest("contact name is required");
  const lead = await env.DB.prepare("SELECT id FROM leads WHERE id=?").bind(id).first();
  if (!lead) return notFound("lead not found");
  const existingPrimary = await env.DB.prepare("SELECT id FROM lead_contacts WHERE lead_id=? AND is_primary=1 LIMIT 1").bind(id).first();
  const isPrimary = body.is_primary ? 1 : existingPrimary ? 0 : 1;
  if (isPrimary) await env.DB.prepare("UPDATE lead_contacts SET is_primary=0,updated_at=datetime('now') WHERE lead_id=?").bind(id).run();
  const r = await env.DB.prepare(`INSERT INTO lead_contacts(lead_id,name,role,phone,email,is_primary) VALUES(?,?,?,?,?,?)`)
    .bind(id,body.name,body.role||null,body.phone||null,body.email||null,isPrimary).run();
  return json({ok:true,id:r.meta.last_row_id},{status:201});
}

export async function updateLeadContact(request, env, contactId) {
  const body=await request.json().catch(()=>null);
  const contact=await env.DB.prepare("SELECT * FROM lead_contacts WHERE id=?").bind(contactId).first();
  if(!contact) return notFound("lead contact not found");
  const isPrimary=body.is_primary!==undefined ? (body.is_primary?1:0) : Number(contact.is_primary||0);
  if(isPrimary) await env.DB.prepare("UPDATE lead_contacts SET is_primary=0,updated_at=datetime('now') WHERE lead_id=?").bind(contact.lead_id).run();
  await env.DB.prepare(`UPDATE lead_contacts SET name=?,role=?,phone=?,email=?,is_primary=?,updated_at=datetime('now') WHERE id=?`)
    .bind(body.name??contact.name,body.role??contact.role,body.phone??contact.phone,body.email??contact.email,isPrimary,contactId).run();
  return json({ok:true});
}

export async function deleteLeadContact(request, env, contactId) {
  const contact=await env.DB.prepare("SELECT id,lead_id,is_primary FROM lead_contacts WHERE id=?").bind(contactId).first();
  if(!contact) return notFound("lead contact not found");
  await env.DB.prepare("DELETE FROM lead_contacts WHERE id=?").bind(contactId).run();
  if(Number(contact.is_primary)===1){
    const next=await env.DB.prepare("SELECT id FROM lead_contacts WHERE lead_id=? ORDER BY id LIMIT 1").bind(contact.lead_id).first();
    if(next) await env.DB.prepare("UPDATE lead_contacts SET is_primary=1,updated_at=datetime('now') WHERE id=?").bind(next.id).run();
  }
  return json({ok:true});
}

// Terminal stages: 'Won' (Closed Won — the UI labels it that; the stored
// value stays 'Won' so every existing query/report keyed on it keeps
// working) and the two ways a lead dies: Lost and Cancelled. Both require a
// reason — that's the only way "get feedback on what can be done better"
// actually produces usable data instead of another blank field nobody fills.
const CLOSED_NEGATIVE_STAGES = ["Lost", "Cancelled"];

export async function updateLeadStage(request, env, id, staff) {
  const body = await request.json().catch(() => null);
  if (!body || !body.stage) return badRequest("stage is required");
  if (CLOSED_NEGATIVE_STAGES.includes(body.stage) && !body.lost_reason) {
    return badRequest(`lost_reason is required when marking a lead ${body.stage}`);
  }
  const lead = await env.DB.prepare(`SELECT stage FROM leads WHERE id = ?`).bind(id).first();
  if (!lead) return notFound("lead not found");

  const reason = CLOSED_NEGATIVE_STAGES.includes(body.stage) ? body.lost_reason : null;
  await env.DB.batch([
    env.DB.prepare(`UPDATE leads SET stage = ?, lost_reason = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(body.stage, reason, id),
    env.DB.prepare(`INSERT INTO lead_status_history (lead_id, from_stage, to_stage, changed_by) VALUES (?, ?, ?, ?)`)
      .bind(id, lead.stage, body.stage, staff.email),
  ]);
  await logActivity(
    env, id, "Stage change",
    `${lead.stage} → ${body.stage}${reason ? ` (${reason})` : ""}`,
    staff.email
  );
  return json({ ok: true });
}

export async function setFollowUp(request, env, id, ctx) {
  const body = await request.json().catch(() => null);

  if (!body || !Object.prototype.hasOwnProperty.call(body, "date")) {
    return badRequest("date is required");
  }

  if (
    body.date !== null &&
    body.date !== "" &&
    !/^\d{4}-\d{2}-\d{2}$/.test(body.date)
  ) {
    return badRequest("date must be YYYY-MM-DD or null");
  }

  const followUpDate =
    body.date === "" ? null : body.date;

  const lead = await env.DB.prepare(
    `SELECT id, name, phone, event_type
     FROM leads
     WHERE id = ?`
  )
    .bind(id)
    .first();

  if (!lead) {
    return notFound("lead not found");
  }

  await env.DB.prepare(
    `UPDATE leads
     SET next_follow_up_date = ?,
         updated_at = datetime('now')
     WHERE id = ?`
  )
    .bind(followUpDate, id)
    .run();

  // Calendar sync is deliberately non-critical to the CRM save.
  // If the date was cleared, the sync layer removes the
  // corresponding Google Calendar event.
  ctx?.waitUntil(
    syncLeadFollowUp(env, {
      ...lead,
      next_follow_up_date: followUpDate,
    })
  );

  return json({ ok: true });
}

// ── Activities — the typed timeline that replaced plain notes. Stage
// changes and quote status changes log themselves here too (see
// updateLeadStage and the quote handlers below), so this is the one place
// that shows "what's actually happened on this lead", not just what staff
// chose to write down.
const ACTIVITY_TYPES = ["Call", "WhatsApp", "Email", "Meeting", "Site visit", "Quote sent", "Quote viewed", "Stage change", "Note", "Other"];

export async function addActivity(request, env, id, staff) {
  const body = await request.json().catch(() => null);
  if (!body || !body.activity_type) return badRequest("activity_type is required");
  const activity_type = ACTIVITY_TYPES.includes(body.activity_type) ? body.activity_type : "Other";
  await env.DB.prepare(`INSERT INTO lead_activities (lead_id, activity_type, description, created_by) VALUES (?, ?, ?, ?)`)
    .bind(id, activity_type, body.description || null, staff.email).run();
  return json({ ok: true }, { status: 201 });
}

async function logActivity(env, leadId, activity_type, description, created_by) {
  await env.DB.prepare(`INSERT INTO lead_activities (lead_id, activity_type, description, created_by) VALUES (?, ?, ?, ?)`)
    .bind(leadId, activity_type, description || null, created_by || null).run();
}

export async function deleteLead(request, env, id) {
  const lead = await env.DB.prepare(`SELECT id,stage FROM leads WHERE id = ?`).bind(id).first();
  if (!lead) return notFound("lead not found");
  if(request.headers.get("x-delete-confirmation")!=="DOUBLE") return badRequest("Delete requires double confirmation.");
  // A converted lead has become a real customer — that's business history,
  // not a mistaken entry. Block the delete and point at the account instead,
  // same guard style as vendor/account deletes below.
  const account = await env.DB.prepare(`SELECT id FROM accounts WHERE lead_id = ?`).bind(id).first();
  if (account) return badRequest("This lead was converted to a customer account — it can't be deleted. Edit or remove the account instead.");
  const booked = await env.DB.prepare(`SELECT e.id FROM events e JOIN lead_quotes q ON q.id=e.quote_id WHERE q.lead_id=? LIMIT 1`).bind(id).first();
  if(booked) return badRequest("This lead already has a booked Event and cannot be deleted.");

  const { results: quoteIds } = await env.DB.prepare(`SELECT id FROM lead_quotes WHERE lead_id = ?`).bind(id).all();
  await env.DB.batch([
    ...quoteIds.flatMap((q) => [
      env.DB.prepare(`DELETE FROM quote_items WHERE quote_id = ?`).bind(q.id),
      env.DB.prepare(`DELETE FROM quote_comments WHERE quote_id = ?`).bind(q.id),
      env.DB.prepare(`DELETE FROM quote_views WHERE quote_id = ?`).bind(q.id),
      env.DB.prepare(`DELETE FROM quote_engagement_events WHERE quote_id = ?`).bind(q.id),
      env.DB.prepare(`DELETE FROM quote_package_options WHERE quote_id = ?`).bind(q.id),
    ]),
    env.DB.prepare(`DELETE FROM lead_quotes WHERE lead_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM lead_activities WHERE lead_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM lead_status_history WHERE lead_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM leads WHERE id = ?`).bind(id),
  ]);
  return json({ ok: true });
}

// ── Convert lead → account (semi-automatic: stage → Closed Won opens a
// pre-filled confirmation in the UI; this is what that confirmation reads
// and then submits) ──────────────────────────────────────────────────

// Pre-fill data for the "Create account" confirmation screen — read-only,
// creates nothing. Lets staff review/correct before the account is made,
// catching the case where this lead is actually a repeat/referral for a
// customer who already has an account.
export async function getLeadConvertPreview(request, env, id) {
  const lead = await env.DB.prepare(`SELECT * FROM leads WHERE id = ?`).bind(id).first();
  if (!lead) return notFound("lead not found");
  const existing = await env.DB.prepare(`SELECT id FROM accounts WHERE lead_id = ?`).bind(id).first();
  return json({
    already_converted: !!existing,
    account_id: existing?.id || null,
    name: lead.name,
    phone: lead.phone,
    email: lead.email,
    notes: lead.message || "",
  });
}

export async function convertLead(request, env, id) {
  const body = await request.json().catch(() => ({}));
  const lead = await env.DB.prepare(`SELECT * FROM leads WHERE id = ?`).bind(id).first();
  if (!lead) return notFound("lead not found");

  let account = await env.DB.prepare(`SELECT id FROM accounts WHERE lead_id = ?`).bind(id).first();
  let accountId = account?.id || null;

  const name = body.name || lead.name;
  const phone = body.phone || lead.phone;
  const email = body.email !== undefined ? body.email || null : lead.email;
  const address = body.address || null;
  const notes = body.notes !== undefined ? body.notes || null : lead.message || null;

  if (!accountId) {
    const result = await env.DB.prepare(
      `INSERT INTO accounts (lead_id, name, phone, email, address, notes, client_since) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    ).bind(id, name, phone, email, address, notes).run();
    accountId = result.meta.last_row_id;
  } else {
    await env.DB.prepare(`UPDATE accounts SET name=?,phone=?,email=?,address=?,notes=? WHERE id=?`)
      .bind(name,phone,email,address,notes,accountId).run();
  }

  const leadContacts = (await env.DB.prepare(`SELECT * FROM lead_contacts WHERE lead_id=? ORDER BY is_primary DESC,id`).bind(id).all()).results;
  const existingAccountContacts = (await env.DB.prepare(`SELECT * FROM contacts WHERE account_id=?`).bind(accountId).all()).results;
  if (!existingAccountContacts.length) {
    const sourceContacts = leadContacts.length
      ? leadContacts
      : [{name,phone,email,role:null,is_primary:1}];
    for (const contact of sourceContacts) {
      await env.DB.prepare(`INSERT INTO contacts(account_id,name,phone,email,role,is_primary) VALUES(?,?,?,?,?,?)`)
        .bind(accountId,contact.name,contact.phone||null,contact.email||null,contact.role||null,contact.is_primary?1:0).run();
    }
  }

  await env.DB.prepare(`UPDATE leads SET stage='Won',updated_at=datetime('now') WHERE id=?`).bind(id).run();

  // Closed Won is the point where the commercial commitment becomes operational:
  // finalize/accept the latest quote, create the Booking, then create its Event.
  const quote = await env.DB.prepare(
    `SELECT id,status FROM lead_quotes WHERE lead_id=? AND status IN ('Finalized','Accepted','Won') ORDER BY version DESC,id DESC LIMIT 1`
  ).bind(id).first();

  if (quote) {
    if (quote.status === "Finalized") {
      await env.DB.prepare(`UPDATE lead_quotes SET status='Accepted',updated_at=datetime('now') WHERE id=?`).bind(quote.id).run();
    }
    const { convertAcceptedQuote } = await import("./bookingRoutes.js");
    const conversion = await convertAcceptedQuote(request, env, quote.id);
    const payload = await conversion.json().catch(() => ({}));
    if (!conversion.ok) return conversion;
    return json({...payload,account_id:accountId});
  }

  return json({ok:true,account_id:accountId,booking_id:null,event_id:null},{status:201});
}

// ── Quotes — built while a lead is Quoted, before there's an account or
// event yet. Admin controls tier/items/concession; the customer's public
// view can only toggle add-ons (see publicRoutes.js) — everything else,
// including the concession, is read-only to them. view_count/last_viewed_at
// and the quote_views log are the engagement signal: how many times, and
// how recently, has this actually been looked at.
async function computeQuoteTotals(env, quoteId) {
  const quote = await env.DB.prepare(`SELECT q.* FROM lead_quotes q WHERE q.id = ?`).bind(quoteId).first();
  const [{ results: items }, { results: options }] = await Promise.all([
    env.DB.prepare(`SELECT * FROM quote_items WHERE quote_id = ? ORDER BY quote_package_option_id, is_addon, id`).bind(quoteId).all(),
    env.DB.prepare(`SELECT * FROM quote_package_options WHERE quote_id = ? ORDER BY sort_order,id`).bind(quoteId).all(),
  ]);
  const selectedOption=options.find(x=>Number(x.selected)===1);
  const addonTotal=items.filter(i=>Number(i.is_addon)===1 && Number(i.selected)===1).reduce((s,i)=>s+Number(i.price||0)*Number(i.quantity||1),0);
  const customizedServiceTotal=selectedOption
    ? items.filter(i=>Number(i.quote_package_option_id)===Number(selectedOption.id) && Number(i.is_addon)===0 && Number(i.selected)===1)
        .reduce((s,i)=>s+Number(i.price||0)*Number(i.quantity||1),0)
    : 0;
  const legacyBaseTotal=options.length ? 0 : items.filter(i=>Number(i.is_addon)===0 && Number(i.selected)===1).reduce((s,i)=>s+Number(i.price||0)*Number(i.quantity||1),0);
  const subtotal=Number(selectedOption?.price||0)+customizedServiceTotal+addonTotal+legacyBaseTotal;
  const total=Math.max(0,subtotal-Number(quote?.concession_amount||0));
  return {quote,items,options,selectedOption,subtotal,total};
}

export async function createQuote(request, env, id) {
  const body = await request.json().catch(() => ({}));
  const lead = await env.DB.prepare(`SELECT id FROM leads WHERE id = ?`).bind(id).first();
  if (!lead) return notFound("lead not found");
  const packageIds=[...new Set((Array.isArray(body.package_ids)?body.package_ids:[body.package_id]).filter(Boolean).map(Number))];
  for(const packageId of packageIds){
    const pkg=await env.DB.prepare(`SELECT id FROM packages WHERE id=? AND active=1`).bind(packageId).first();
    if(!pkg) return badRequest(`selected package ${packageId} not found or inactive`);
  }
  const token = makeToken();
  const result = await env.DB.prepare(`INSERT INTO lead_quotes (lead_id, token) VALUES (?, ?)`).bind(id, token).run();
  const quoteId=result.meta.last_row_id;
  for(let i=0;i<packageIds.length;i++) await createQuotePackageOptionRecord(env,quoteId,packageIds[i],i,i===0?1:0);
  await env.DB.prepare(`UPDATE leads SET stage=CASE WHEN stage IN ('New','Qualified') THEN 'Quote' ELSE stage END,updated_at=datetime('now') WHERE id=?`).bind(id).run();
  return json({ ok: true, id: quoteId, token }, { status: 201 });
}

export async function listQuotes(request, env) {
  const { results } = await env.DB.prepare(`
    SELECT q.id,q.lead_id,q.status,q.version,q.revision_of_quote_id,q.finalized_at,q.finalized_by,q.concession_amount,q.created_at,q.updated_at,
           l.name AS lead_name,l.phone AS lead_phone,l.event_type,l.event_date,
           CASE WHEN EXISTS(SELECT 1 FROM quote_package_options o WHERE o.quote_id=q.id)
             THEN COALESCE((SELECT o.price FROM quote_package_options o WHERE o.quote_id=q.id AND o.selected=1 LIMIT 1),0)
                + COALESCE((SELECT SUM(i.price*i.quantity) FROM quote_items i WHERE i.quote_id=q.id AND i.quote_package_option_id=(SELECT o2.id FROM quote_package_options o2 WHERE o2.quote_id=q.id AND o2.selected=1 LIMIT 1) AND i.is_addon=0 AND i.selected=1),0)
                + COALESCE((SELECT SUM(i.price*i.quantity) FROM quote_items i WHERE i.quote_id=q.id AND i.is_addon=1 AND i.selected=1),0)
             ELSE COALESCE((SELECT SUM(i.price) FROM quote_items i WHERE i.quote_id=q.id AND i.selected=1),0)
           END AS subtotal,
           (SELECT COUNT(*) FROM quote_package_options o WHERE o.quote_id=q.id) AS package_option_count,
           (SELECT o.label FROM quote_package_options o WHERE o.quote_id=q.id AND o.selected=1 LIMIT 1) AS selected_package
    FROM lead_quotes q JOIN leads l ON l.id=q.lead_id
    ORDER BY q.created_at DESC LIMIT 300
  `).all();
  return json(results.map(q=>({...q,quote_number:`QT-${String(q.id).padStart(4,"0")}`,total:Math.max(0,Number(q.subtotal||0)-Number(q.concession_amount||0))})));
}

export async function getQuote(request, env, quoteId) {
  const { quote, items, options, subtotal, total } = await computeQuoteTotals(env, quoteId);
  if (!quote) return notFound("quote not found");
  const lead = await env.DB.prepare(`SELECT name, event_type, event_date, venue FROM leads WHERE id = ?`).bind(quote.lead_id).first();
  const [views,commentsResult,engagement,packageEngagement] = await Promise.all([
    env.DB.prepare(`SELECT viewed_at FROM quote_views WHERE quote_id = ? ORDER BY viewed_at DESC LIMIT 20`).bind(quoteId).all(),
    env.DB.prepare(`SELECT author, author_name, message, created_at FROM quote_comments WHERE quote_id = ? ORDER BY created_at ASC`).bind(quoteId).all(),
    env.DB.prepare(`SELECT COUNT(*) AS total_events,COUNT(DISTINCT session_key) AS unique_sessions,MIN(created_at) AS first_engaged_at,MAX(created_at) AS last_engaged_at,
      SUM(CASE WHEN event_type LIKE 'package_%' THEN 1 ELSE 0 END) AS package_events,
      SUM(CASE WHEN event_type LIKE 'service_%' THEN 1 ELSE 0 END) AS service_events,
      SUM(CASE WHEN event_type LIKE 'addon_%' THEN 1 ELSE 0 END) AS addon_events,
      SUM(CASE WHEN event_type LIKE '%selected' THEN 1 ELSE 0 END) AS selections
      FROM quote_engagement_events WHERE quote_id=?`).bind(quoteId).first(),
    env.DB.prepare(`SELECT package_id,
      SUM(CASE WHEN event_type='package_viewed' THEN 1 ELSE 0 END) AS views,
      SUM(CASE WHEN event_type='package_expanded' THEN 1 ELSE 0 END) AS expansions,
      SUM(CASE WHEN event_type='package_selected' THEN 1 ELSE 0 END) AS selections
      FROM quote_engagement_events WHERE quote_id=? AND package_id IS NOT NULL GROUP BY package_id`).bind(quoteId).all()
  ]);
  const engagementByPackage=Object.fromEntries(packageEngagement.results.map(x=>[x.package_id,{views:Number(x.views||0),expansions:Number(x.expansions||0),selections:Number(x.selections||0)}]));
  const optionRows=options.map(o=>({...o,details:(()=>{try{return JSON.parse(o.details_json||"{}")}catch{return {}}})(),engagement:engagementByPackage[o.package_id]||{views:0,expansions:0,selections:0}}));
  const comments=commentsResult.results;
  const url = new URL(request.url);
  return json({
    ...quote,lead_name:lead?.name,event_type:lead?.event_type,items,options:optionRows,subtotal,total,
    selected_package_option_id:options.find(x=>Number(x.selected)===1)?.id||null,
    view_log:views.results,comments,engagement_summary:engagement||{total_events:0,unique_sessions:0,first_engaged_at:null,last_engaged_at:null,package_events:0,service_events:0,addon_events:0,selections:0},
    public_url:`${url.origin}/quote/${quote.token}`
  });
}

// Staff reply on the quote's comment thread — visible to the customer next
// time they open the quote link. Not logged as a lead activity: the
// customer's message already is, and the studio doesn't need to notify
// itself of its own reply.
export async function addStaffQuoteComment(request, env, quoteId, staff) {
  const body = await request.json().catch(() => null);
  const message = (body?.message || "").trim();
  if (!message) return badRequest("message is required");
  const quote = await env.DB.prepare(`SELECT id FROM lead_quotes WHERE id = ?`).bind(quoteId).first();
  if (!quote) return notFound("quote not found");
  await env.DB.prepare(`INSERT INTO quote_comments (quote_id, author, author_name, message) VALUES (?, 'studio', ?, ?)`)
    .bind(quoteId, staff.email, message).run();
  return json({ ok: true }, { status: 201 });
}

export async function finalizeQuote(request, env, quoteId, staff) {
  const quote=await env.DB.prepare("SELECT * FROM lead_quotes WHERE id=?").bind(quoteId).first();
  if(!quote) return notFound("quote not found");
  if(["Finalized","Accepted","Won"].includes(quote.status)) return badRequest("this Quote is already finalized");
  if(["Rejected","Expired","Cancelled"].includes(quote.status)) return badRequest("this Quote cannot be finalized from its current status");
  const totals=await computeQuoteTotals(env,quoteId);
  await env.DB.prepare(`UPDATE lead_quotes SET status='Finalized',finalized_at=datetime('now'),finalized_by=?,updated_at=datetime('now') WHERE id=?`)
    .bind(staff?.email||null,quoteId).run();
  await logActivity(env,quote.lead_id,"Quote finalized",`Quote QT-${String(quote.id).padStart(4,"0")} v${quote.version||1} finalized`,staff?.email);
  return json({ok:true,status:"Finalized",total:totals.total,version:quote.version||1});
}

export async function reviseQuote(request, env, quoteId, staff) {
  const quote=await env.DB.prepare("SELECT * FROM lead_quotes WHERE id=?").bind(quoteId).first();
  if(!quote) return notFound("quote not found");
  if(!["Finalized","Accepted","Won"].includes(quote.status)) return badRequest("Only a finalized quote can be revised");
  const maxVersion=await env.DB.prepare("SELECT MAX(version) AS version FROM lead_quotes WHERE lead_id=?").bind(quote.lead_id).first();
  const nextVersion=Number(maxVersion?.version||quote.version||1)+1;
  const token=makeToken();
  const qr=await env.DB.prepare(`INSERT INTO lead_quotes(
    lead_id,token,pricing_tier_id,concession_amount,concession_note,status,valid_until,version,revision_of_quote_id
  ) VALUES(?,?,?,?,?,?,?,?,?)`).bind(
    quote.lead_id,token,quote.pricing_tier_id||null,quote.concession_amount||0,quote.concession_note||null,"Draft",quote.valid_until||null,nextVersion,quote.id
  ).run();
  const newId=qr.meta.last_row_id;
  const options=(await env.DB.prepare("SELECT * FROM quote_package_options WHERE quote_id=? ORDER BY sort_order,id").bind(quoteId).all()).results;
  for(const o of options){
    await env.DB.prepare(`INSERT INTO quote_package_options(quote_id,package_id,label,price,details_json,selected,sort_order) VALUES(?,?,?,?,?,?,?)`)
      .bind(newId,o.package_id,o.label,o.price,o.details_json,o.selected,o.sort_order).run();
  }
  const newOptions=(await env.DB.prepare("SELECT * FROM quote_package_options WHERE quote_id=? ORDER BY sort_order,id").bind(newId).all()).results;
  const oldItems=(await env.DB.prepare("SELECT * FROM quote_items WHERE quote_id=? ORDER BY id").bind(quoteId).all()).results;
  for(const item of oldItems){
    const oldOpt=item.quote_package_option_id ? options.find(o=>Number(o.id)===Number(item.quote_package_option_id)) : null;
    const newOpt=oldOpt ? newOptions.find(o=>Number(o.sort_order)===Number(oldOpt.sort_order)) : null;
    await env.DB.prepare(`INSERT INTO quote_items(quote_id,service_id,package_id,quote_package_option_id,label,price,is_addon,selected,quantity)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(
      newId,item.service_id||null,item.package_id||null,newOpt?.id||null,item.label,item.price,item.is_addon,item.selected,item.quantity||1
    ).run();
  }
  await logActivity(env,quote.lead_id,"Quote revised",`Revision created: QT-${String(newId).padStart(4,"0")} v${nextVersion} from v${quote.version||1}`,staff?.email);
  return json({ok:true,id:newId,version:nextVersion,status:"Draft"},{status:201});
}

export async function updateQuote(request, env, quoteId) {
  const body = await request.json().catch(() => null);
  if (!body) return badRequest("no fields given");
  const quote = await env.DB.prepare(`SELECT * FROM lead_quotes WHERE id = ?`).bind(quoteId).first();
  if (!quote) return notFound("quote not found");
  if(["Finalized","Accepted","Won","Rejected","Expired","Cancelled"].includes(quote.status)) return badRequest("this Quote is locked and cannot be changed");
  const concession_amount = body.concession_amount !== undefined ? Number(body.concession_amount) : quote.concession_amount;
  if(!Number.isFinite(concession_amount) || concession_amount<0) return badRequest("concession_amount must be a valid non-negative number");
  const concession_note = body.concession_note !== undefined ? body.concession_note || null : quote.concession_note;
  const valid_until = body.valid_until !== undefined ? body.valid_until || null : quote.valid_until;
  await env.DB.prepare(
    `UPDATE lead_quotes SET concession_amount = ?, concession_note = ?, valid_until = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(concession_amount, concession_note, valid_until, quoteId).run();
  return json({ ok: true });
}

// Marks the quote Sent and logs it on the lead's activity timeline — the
// moment "we've actually sent this" becomes visible without staff having
// to remember to note it themselves.
export async function sendQuote(request, env, quoteId, staff) {
  const quote = await env.DB.prepare(`SELECT q.*,l.phone,l.name FROM lead_quotes q JOIN leads l ON l.id=q.lead_id WHERE q.id = ?`).bind(quoteId).first();
  if (!quote) return notFound("quote not found");
  if (["Finalized","Accepted","Won"].includes(quote.status)) return badRequest("this Quote is finalized and cannot be sent again");
  const url = new URL(request.url);
  const publicUrl=`${url.origin}/quote/${quote.token}`;
  const message=`Hi ${quote.name || "there"}, your Paperclip Studios quote is ready: ${publicUrl}`;
  await env.DB.prepare(`UPDATE lead_quotes SET status = 'Sent', updated_at = datetime('now') WHERE id = ?`).bind(quoteId).run();
  await logActivity(env, quote.lead_id, "Quote sent", publicUrl, staff.email);
  return json({ ok: true, public_url: publicUrl, phone: quote.phone || null, whatsapp_message: message });
}

export async function deleteQuote(request, env, quoteId) {
  const quote=await env.DB.prepare(`SELECT id,status FROM lead_quotes WHERE id=?`).bind(quoteId).first();
  if(!quote) return notFound("quote not found");
  if(["Finalized","Accepted","Won"].includes(quote.status)) return badRequest("This Quote is finalized/accepted and cannot be deleted.");
  if(request.headers.get("x-delete-confirmation")!=="DOUBLE") return badRequest("Delete requires double confirmation.");
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM quote_comments WHERE quote_id = ?`).bind(quoteId),
    env.DB.prepare(`DELETE FROM quote_views WHERE quote_id = ?`).bind(quoteId),
    env.DB.prepare(`DELETE FROM quote_items WHERE quote_id = ?`).bind(quoteId),
    env.DB.prepare(`DELETE FROM quote_package_options WHERE quote_id = ?`).bind(quoteId),
    env.DB.prepare(`DELETE FROM lead_quotes WHERE id = ?`).bind(quoteId),
  ]);
  return json({ ok: true });
}

export async function reviseEventQuote(request, env, eventId, staff) {
  const event=await env.DB.prepare("SELECT id,quote_id FROM events WHERE id=?").bind(eventId).first();
  if(!event) return notFound("event not found");
  if(!event.quote_id) return badRequest("This event is not linked to a quote");
  const {reviseQuote}=await import("./adminRoutes.js");
  const result=await reviseQuote(request,env,event.quote_id,staff);
  const payload=await result.json().catch(()=>({}));
  if(!result.ok) return result;
  await env.DB.prepare("UPDATE events SET quote_id=?,updated_at=datetime('now') WHERE id=?").bind(payload.id,eventId).run();
  return json({ok:true,event_id:eventId,quote_id:payload.id,version:payload.version});
}

export async function addQuoteItem(request, env, quoteId) {
  const body = await request.json().catch(() => null);
  if (!body || (!body.service_id && !body.package_id)) return badRequest("service_id or package_id is required");
  const quoteState=await env.DB.prepare("SELECT status FROM lead_quotes WHERE id=?").bind(quoteId).first();
  if(!quoteState) return notFound("quote not found");
  if(["Finalized","Accepted","Won","Rejected","Expired","Cancelled"].includes(quoteState.status)) return badRequest("this Quote is locked and cannot be changed");
  if(body.package_id && !body.is_addon){
    const count=await env.DB.prepare("SELECT COUNT(*) AS n FROM quote_package_options WHERE quote_id=?").bind(quoteId).first();
    await createQuotePackageOptionRecord(env,quoteId,Number(body.package_id),Number(count?.n||0),Number(count?.n||0)===0?1:0);
    return json({ok:true,option:true},{status:201});
  }
  let label, price;
  if (body.package_id) {
    const pkg = await env.DB.prepare(`SELECT name, base_price FROM packages WHERE id = ?`).bind(body.package_id).first();
    if (!pkg) return notFound("package not found");
    label=pkg.name; price=pkg.base_price;
  } else {
    const svc = await env.DB.prepare(`SELECT name, base_price FROM services WHERE id = ?`).bind(body.service_id).first();
    if (!svc) return notFound("service not found");
    label=svc.name; price=svc.base_price;
  }
  const optionId=body.option_id ? Number(body.option_id) : null;
  if(optionId){
    const option=await env.DB.prepare(`SELECT id,package_id FROM quote_package_options WHERE id=? AND quote_id=?`).bind(optionId,quoteId).first();
    if(!option) return badRequest("package option does not belong to this quote");
  }
  const isAddon=body.is_addon ? 1 : 0;
  const quotePrice=body.price !== undefined ? Number(body.price) : (optionId && !isAddon ? 0 : price);
  await env.DB.prepare(`INSERT INTO quote_items (quote_id, service_id, package_id, quote_package_option_id, label, price, is_addon, selected, quantity)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`)
    .bind(quoteId, body.service_id || null, optionId ? null : (body.package_id || null), optionId, label, quotePrice, isAddon, Math.max(1,Number(body.quantity||1))).run();
  return json({ok:true},{status:201});
}
export async function removeQuotePackageOption(request, env, optionId) {
  const option=await env.DB.prepare(`SELECT o.id,o.quote_id,q.status FROM quote_package_options o JOIN lead_quotes q ON q.id=o.quote_id WHERE o.id=?`).bind(optionId).first();
  if(!option) return notFound("package option not found");
  if(["Finalized","Accepted","Won","Rejected","Expired","Cancelled"].includes(option.status)) return badRequest("this Quote is locked and cannot be changed");
  await env.DB.prepare("DELETE FROM quote_package_options WHERE id=?").bind(optionId).run();
  const remaining=await env.DB.prepare("SELECT id FROM quote_package_options WHERE quote_id=? ORDER BY sort_order,id").bind(option.quote_id).all();
  if(remaining.results.length && !(await env.DB.prepare("SELECT id FROM quote_package_options WHERE quote_id=? AND selected=1").bind(option.quote_id).first()))
    await env.DB.prepare("UPDATE quote_package_options SET selected=1 WHERE id=?").bind(remaining.results[0].id).run();
  return json({ok:true});
}

export async function updateQuoteItem(request, env, itemId) {
  const body=await request.json().catch(()=>null);
  const item=await env.DB.prepare(`SELECT qi.*,q.status FROM quote_items qi JOIN lead_quotes q ON q.id=qi.quote_id WHERE qi.id=?`).bind(itemId).first();
  if(!item) return notFound("quote item not found");
  if(["Finalized","Accepted","Won","Rejected","Expired","Cancelled"].includes(item.status)) return badRequest("this Quote is locked and cannot be changed");
  if(body?.price !== undefined && (!Number.isFinite(Number(body.price)))) return badRequest("price must be a valid number");
  const price=body?.price !== undefined ? Number(body.price) : Number(item.price||0);
  const quantity=body?.quantity !== undefined ? Math.max(1,Number(body.quantity)) : Number(item.quantity||1);
  const selected=body?.selected !== undefined ? (body.selected?1:0) : Number(item.selected||0);
  const label=body?.label !== undefined ? String(body.label).trim() : item.label;
  await env.DB.prepare(`UPDATE quote_items SET price=?,quantity=?,selected=?,label=? WHERE id=?`)
    .bind(price,quantity,selected,label,itemId).run();
  return json({ok:true});
}

export async function removeQuoteItem(request, env, itemId) {
  const item=await env.DB.prepare("SELECT qi.quote_id,q.status FROM quote_items qi JOIN lead_quotes q ON q.id=qi.quote_id WHERE qi.id=?").bind(itemId).first();
  if(!item) return notFound("quote item not found");
  if(["Finalized","Accepted","Won","Rejected","Expired","Cancelled"].includes(item.status)) return badRequest("this Quote is locked and cannot be changed");
  await env.DB.prepare(`DELETE FROM quote_items WHERE id = ?`).bind(itemId).run();
  return json({ ok: true });
}

export async function listPayments(request, env) {
  const p=new URL(request.url).searchParams;
  const from=p.get("from");
  const to=p.get("to");
  const clauses=[];
  const binds=[];
  if(from){clauses.push("date(p.date) >= date(?)");binds.push(from);}
  if(to){clauses.push("date(p.date) <= date(?)");binds.push(to);}
  const where=clauses.length?"WHERE "+clauses.join(" AND "):"";
  const {results}=await env.DB.prepare(`
    SELECT p.id,p.amount,p.method,p.date,p.note,p.event_id,
           e.event_number,e.type AS event_type,e.event_date,
           a.name AS client_name
    FROM payments p
    JOIN events e ON e.id=p.event_id
    JOIN accounts a ON a.id=e.account_id
    ${where}
    ORDER BY date(p.date) DESC,p.id DESC
    LIMIT 500
  `).bind(...binds).all();
  return json(results);
}

// ── Accounts / Customer 360 ─────────────────────────────────────────
// Lifetime value, booking count, and outstanding balance per account —
// computed here (not stored) so it's always live, never a stale cached
// number that drifts from the underlying events/payments. lifetime_value
// is booked value (sum of quote_total), not cash actually collected —
// that distinction matters for "who's our biggest client" (booked) vs.
// "who owes us money" (balance_due, cash-basis) being two different
// questions the list needs to answer at once.
export async function listAccounts(request, env) {
  const { results } = await env.DB.prepare(
    `SELECT a.*,
            COUNT(e.id) AS event_count,
            COALESCE(SUM(e.quote_total), 0) AS lifetime_value,
            COALESCE(SUM(CASE WHEN (e.quote_total - e.advance_paid) > 0 THEN (e.quote_total - e.advance_paid) ELSE 0 END), 0) AS balance_due
     FROM accounts a
     LEFT JOIN events e ON e.account_id = a.id
     GROUP BY a.id
     ORDER BY lifetime_value DESC`
  ).all();
  return json(results);
}

const ACCOUNT_CSV_COLUMNS = [
  { key: "id", label: "ID" },
  { key: "name", label: "Name" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
  { key: "address", label: "Address" },
  { key: "client_since", label: "Client Since" },
  { key: "is_signature", label: "Signature Client" },
  { key: "notes", label: "Notes" },
];

export async function exportAccountsCsv(request, env) {
  const { results } = await env.DB.prepare(`SELECT * FROM accounts ORDER BY client_since DESC`).all();
  const csv = toCSV(results, ACCOUNT_CSV_COLUMNS);
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="accounts-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}

// Same shape and dedup philosophy as importLeadsCsv above — skip, never
// overwrite. Only name is required (unlike leads, an account migrated from
// an old spreadsheet may genuinely have no phone on file). This creates the
// account row only — it does NOT auto-create a contact (bride/groom/etc.);
// add those from the account page after import if the source data has them,
// since a CSV import is a bulk-migration tool, not a full onboarding flow.
export async function importAccountsCsv(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !body.csv) return badRequest("csv text is required");
  const { rows } = parseCSV(body.csv);
  if (!rows.length) return badRequest("no data rows found in the CSV");

  const existing = await env.DB.prepare(`SELECT phone FROM accounts WHERE phone IS NOT NULL AND phone != ''`).all();
  const seenPhones = new Set(existing.results.map((r) => normalizePhone(r.phone)).filter(Boolean));

  const field = (r, ...names) => {
    for (const n of names) { const v = r[n]; if (v) return v; }
    return "";
  };

  let created = 0;
  const skipped = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowNum = i + 2;
    const name = field(r, "name", "full name", "customer name");
    if (!name) { skipped.push({ row: rowNum, reason: "missing name" }); continue; }
    const phone = field(r, "phone", "phone number", "mobile");
    const normalized = phone ? normalizePhone(phone) : "";
    if (normalized && seenPhones.has(normalized)) { skipped.push({ row: rowNum, reason: `duplicate — phone already on file (${name})` }); continue; }

    await env.DB.prepare(
      `INSERT INTO accounts (name, phone, email, address, notes, is_signature) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      name, phone || null, field(r, "email") || null, field(r, "address") || null,
      field(r, "notes") || null,
      /^(1|true|yes)$/i.test(field(r, "is_signature", "signature")) ? 1 : 0
    ).run();
    if (normalized) seenPhones.add(normalized);
    created++;
  }
  return json({ ok: true, created, skipped_count: skipped.length, skipped });
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
  const makePrimary = body.is_primary ? 1 : 0;
  await env.DB.batch([
    ...(makePrimary ? [env.DB.prepare(`UPDATE contacts SET is_primary=0 WHERE account_id=?`).bind(id)] : []),
    env.DB.prepare(`INSERT INTO contacts (account_id, name, role, phone, email, is_primary) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(id, body.name, body.role || null, body.phone || null, body.email || null, makePrimary)
  ]);
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
  const address = body.address !== undefined ? body.address || null : account.address;
  const notes = body.notes !== undefined ? body.notes || null : account.notes;
  const birth_date = body.birth_date !== undefined ? body.birth_date || null : account.birth_date;
  const anniversary_date = body.anniversary_date !== undefined ? body.anniversary_date || null : account.anniversary_date;
  await env.DB.prepare(`UPDATE accounts SET name = ?, phone = ?, email = ?, address = ?, notes = ?, birth_date = ?, anniversary_date = ? WHERE id = ?`)
    .bind(name, phone, email, address, notes, birth_date, anniversary_date, id).run();
  return json({ ok: true });
}

export async function deleteAccount(request, env, id) {
  if(request.headers.get("x-delete-confirmation")!=="DOUBLE") return badRequest("Delete requires double confirmation.");
  const account = await env.DB.prepare(`SELECT id FROM accounts WHERE id = ?`).bind(id).first();
  if (!account) return notFound("account not found");
  // Any event means real booked history — same "can't delete real business
  // history" guard as vendors/leads. Delete the event(s) first if this was
  // truly a mistaken account.
  const { count } = await env.DB.prepare(`SELECT COUNT(*) AS count FROM events WHERE account_id = ?`).bind(id).first();
  if (count > 0) return badRequest("This customer has event history — remove their event(s) first before deleting the account.");

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM contacts WHERE account_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM accounts WHERE id = ?`).bind(id),
  ]);
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
  const is_primary = body.is_primary !== undefined ? (body.is_primary ? 1 : 0) : contact.is_primary;
  const accountId = contact.account_id;
  await env.DB.batch([
    ...(is_primary ? [env.DB.prepare(`UPDATE contacts SET is_primary=0 WHERE account_id=?`).bind(accountId)] : []),
    env.DB.prepare(`UPDATE contacts SET name = ?, role = ?, phone = ?, email = ?, is_primary = ? WHERE id = ?`)
      .bind(name, role, phone, email, is_primary, contactId)
  ]);
  return json({ ok: true });
}

export async function deleteContact(request, env, contactId) {
  if(request.headers.get("x-delete-confirmation")!=="DOUBLE") return badRequest("Delete requires double confirmation.");
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

export async function listCalendar(request, env) {
  const params = new URL(request.url).searchParams;
  const from = params.get("from");
  const to = params.get("to");
  if (!from || !to) return badRequest("calendar requires from and to (YYYY-MM-DD)");

  const { results: events } = await env.DB.prepare(
    `SELECT e.id, e.type, e.event_date, e.start_time, e.end_time, e.reporting_time, e.venue, e.status,
            a.id AS account_id, a.name AS account_name
     FROM events e JOIN accounts a ON a.id = e.account_id
     WHERE e.event_date BETWEEN ? AND ?
     ORDER BY e.event_date ASC, e.start_time ASC, e.id ASC`
  ).bind(from, to).all();

  const { results: followups } = await env.DB.prepare(
    `SELECT id, name, event_type, next_follow_up_date
     FROM leads
     WHERE next_follow_up_date BETWEEN ? AND ?
     ORDER BY next_follow_up_date ASC, id ASC`
  ).bind(from, to).all();

  return json({ from, to, events, followups });
}

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
    `SELECT e.id, e.type, e.event_date, e.start_time, e.end_time, e.reporting_time, e.venue, e.status,
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

export async function createEvent(request, env, ctx) {
  const body = await request.json().catch(() => null);
  if (!body || !body.account_id || !body.type) return badRequest("account_id and type are required");
  const startDate=body.start_date || body.event_date || null;
  const endDate=body.end_date || body.event_date || startDate;
  if(startDate && endDate && startDate>endDate) return badRequest("event end date must be on or after start date");
  const result = await env.DB.prepare(
    `INSERT INTO events (account_id, type, event_date, start_date, end_date, start_time, end_time, reporting_time, venue, pricing_tier_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(body.account_id, body.type, startDate, startDate, endDate, body.start_time || null, body.end_time || null, body.reporting_time || null, body.venue || null, body.pricing_tier_id || 1)
    .run();
  const eventId = result.meta.last_row_id;

  // Calendar sync is deliberately non-critical to the CRM save.
  if (body.event_date) {
    const account = await env.DB.prepare(`SELECT name FROM accounts WHERE id = ?`).bind(body.account_id).first();
    const event = await env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(eventId).first();
    if (account && event) ctx?.waitUntil(syncCrmEvent(env, event, account));
  }

  await rebuildEventOperations(env,eventId);
  return json({ ok: true, id: eventId }, { status: 201 });
}

// Fixes a typo'd type/venue/date/status on the event itself — separate from
// the pricing/resourcing sub-actions (services, tier, payments) below.
export async function updateEvent(request, env, id, ctx) {
  const body = await request.json().catch(() => null);
  if (!body) return badRequest("no fields given");
  const event = await env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first();
  if (!event) return notFound("event not found");
  const type = body.type ?? event.type;
  const venue = body.venue !== undefined ? body.venue || null : event.venue;
  const event_date = body.event_date !== undefined ? body.event_date || null : event.event_date;
  const start_date = body.start_date !== undefined ? body.start_date || event.start_date || event.event_date : (event.start_date || event.event_date);
  const end_date = body.end_date !== undefined ? body.end_date || event.end_date || start_date : (event.end_date || start_date);
  if(start_date && end_date && start_date>end_date) return badRequest("event end date must be on or after start date");
  const start_time = body.start_time !== undefined ? body.start_time || null : event.start_time;
  const end_time = body.end_time !== undefined ? body.end_time || null : event.end_time;
  const reporting_time = body.reporting_time !== undefined ? body.reporting_time || null : event.reporting_time;
  const status = body.status ?? event.status;
  const allowedStatuses=["Pending","Planning","In-Progress","Completed","Overdue","Cancelled"];
  if(!allowedStatuses.includes(status)) return badRequest("invalid event status");
  if(status==="Completed" && event.status!=="Completed"){
    const pending=await env.DB.prepare("SELECT COUNT(*) AS count FROM event_tasks WHERE event_id=? AND required=1 AND lower(status) NOT IN ('done','completed')").bind(id).first();
    const rule=await env.DB.prepare("SELECT value_json FROM crm_business_rules WHERE rule_key='event.block_completion_pending' AND active=1 ORDER BY id DESC LIMIT 1").first();
    let enabled=true; try{enabled=rule?JSON.parse(rule.value_json||"{}").enabled!==false:true;}catch{}
    if(enabled && Number(pending?.count||0)>0) return badRequest("required Event tasks are still pending");
  }
  await env.DB.prepare(`UPDATE events SET type = ?, venue = ?, event_date = ?, start_date = ?, end_date = ?, start_time = ?, end_time = ?, reporting_time = ?, status = ? WHERE id = ?`)
    .bind(type, venue, event_date, start_date, end_date, start_time, end_time, reporting_time, status, id).run();
  if(status==="Completed"){
    await env.DB.prepare("UPDATE invoices SET locked_at=COALESCE(locked_at,datetime('now')),updated_at=datetime('now') WHERE event_id=?").bind(id).run();
  }
  await rebuildEventOperations(env,id);

  // Calendar sync is deliberately non-critical to the CRM save.
  const account = await env.DB.prepare(`SELECT name FROM accounts WHERE id = ?`).bind(event.account_id).first();
  const updatedEvent = { ...event, type, venue, event_date, start_date, end_date, start_time, end_time, reporting_time, status };
  if (account) ctx?.waitUntil(syncCrmEvent(env, updatedEvent, account));

  return json({ ok: true });
}

export async function deleteEvent(request, env, id) {
  if(request.headers.get("x-delete-confirmation")!=="DOUBLE") return badRequest("Delete requires double confirmation.");
  const event = await env.DB.prepare(`SELECT id FROM events WHERE id = ?`).bind(id).first();
  if (!event) return notFound("event not found");
  // Any payment recorded is real money against this event — block rather
  // than silently destroy financial history. Delete the payment(s) first
  // (which itself reverses advance_paid) if this was truly a mistaken event.
  const { count } = await env.DB.prepare(`SELECT COUNT(*) AS count FROM payments WHERE event_id = ?`).bind(id).first();
  if (count > 0) return badRequest("This event has payment(s) recorded — remove those first before deleting the event.");

  const lockedInvoice=await env.DB.prepare("SELECT id FROM invoices WHERE event_id=? AND locked_at IS NOT NULL LIMIT 1").bind(id).first();
  if(lockedInvoice) return badRequest("This Event has a locked invoice and cannot be deleted.");
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM event_resource_allocations WHERE event_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM event_equipment WHERE event_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM event_services WHERE event_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM event_staff_links WHERE event_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM event_vendors WHERE event_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM payment_schedule WHERE event_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM deliverables WHERE event_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM event_checklist WHERE event_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM event_tasks WHERE event_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM expenses WHERE event_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM feedback WHERE event_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM invoices WHERE event_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM support_requests WHERE event_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM events WHERE id = ?`).bind(id),
  ]);
  return json({ ok: true });
}

export async function getEvent(request, env, id) {
  const event = await env.DB.prepare(
    `SELECT e.*, pt.name AS tier_name, pt.multiplier, a.name AS account_name
     FROM events e LEFT JOIN pricing_tiers pt ON pt.id = e.pricing_tier_id
     JOIN accounts a ON a.id = e.account_id WHERE e.id = ?`
  ).bind(id).first();
  if (!event) return notFound("event not found");
  const quoteHistoryPromise = event.quote_id
    ? env.DB.prepare(`SELECT q.id,q.version,q.status,q.created_at,q.finalized_at,q.revision_of_quote_id,q.concession_amount
       FROM lead_quotes q
       WHERE q.lead_id=(SELECT lead_id FROM lead_quotes WHERE id=?)
       ORDER BY q.version DESC,q.id DESC`).bind(event.quote_id).all()
    : Promise.resolve({results:[]});
  const [services, payments, links, vendors, schedule, deliverables, checklist, tasks, feedback, expenseRowsFull, equipment, resources, resourceRequirements, quoteHistory] = await Promise.all([
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
    env.DB.prepare(`SELECT * FROM feedback WHERE event_id = ? ORDER BY created_at DESC`).bind(id).all(),
    env.DB.prepare(`SELECT * FROM expenses WHERE event_id = ? ORDER BY submitted_at DESC`).bind(id).all(),
    env.DB.prepare(
      `SELECT ee.*, eq.name AS equipment_name, eq.category, eq.owned
       FROM event_equipment ee LEFT JOIN equipment eq ON eq.id = ee.equipment_id WHERE ee.event_id = ?`
    ).bind(id).all(),
    env.DB.prepare(
      `SELECT era.*, r.name AS resource_name, r.resource_type, s.label AS skill_label
       FROM event_resource_allocations era
       JOIN resources r ON r.id = era.resource_id
       LEFT JOIN skills s ON s.id = era.skill_id
       WHERE era.event_id = ?
       ORDER BY CASE era.phase WHEN 'Pre-Production' THEN 1 WHEN 'Production' THEN 2 WHEN 'Post-Production' THEN 3 ELSE 4 END, r.name`
    ).bind(id).all(),
    env.DB.prepare(
      `SELECT err.*, s.label AS skill_label, s.workflow_phase, s.start_offset_days, s.due_offset_days, s.default_cost
       FROM event_resource_requirements err
       LEFT JOIN skills s ON s.id=err.skill_id
       WHERE err.event_id=?
       ORDER BY CASE err.phase WHEN 'Production' THEN 1 WHEN 'Post-Production' THEN 2 ELSE 3 END, err.id`
    ).bind(id).all(),
    quoteHistoryPromise,
  ]);
  // Real cost of running this event — internal staff cost + external vendor
  // cost + ad-hoc reimbursed expenses — set against the quote to show profit.
  const staffCost = links.results.reduce((s, l) => s + (l.cost || 0), 0);
  const vendorCost = vendors.results.reduce((s, v) => s + (v.cost || 0), 0);
  const expenseCost = expenseRowsFull.results.reduce((s, e) => s + (e.amount || 0), 0);
  const resourceEstimatedCost = resources.results.reduce((s,r)=>s + Number(r.original_estimate ?? r.cost ?? 0),0);
  const resourceActualCost = resources.results.reduce((s,r)=>{
    const external=String(r.resource_type||"").toLowerCase().includes("external") || String(r.resource_type||"").toLowerCase().includes("vendor");
    return s + (Number(r.actual_paid||0)>0 ? Number(r.actual_paid) : external ? Number(r.revised_estimate ?? r.cost ?? 0) : Number(r.cost||0));
  },0);
  const resourceCost = resourceActualCost;
  const total_cost = staffCost + resourceCost + vendorCost + expenseCost;

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
    feedback: feedback.results,
    expenses: expenseRowsFull.results,
    equipment: equipment.results,
    resources: resources.results,
    resource_requirements: resourceRequirements.results,
    quote_history: quoteHistory.results,
    cost_breakdown: { staff: staffCost, resources: resourceCost, resource_estimated: resourceEstimatedCost, resource_actual: resourceActualCost, vendors: vendorCost, expenses: expenseCost, total: total_cost },
    profit: event.quote_total - total_cost,
  });
}

export async function addEventService(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body || !body.service_id) return badRequest("service_id is required");
  const service = await env.DB.prepare(`SELECT * FROM services WHERE id = ? AND active=1`).bind(body.service_id).first();
  if (!service) return notFound("service not found or inactive");
  const event = await env.DB.prepare("SELECT commercial_finalized_at FROM events WHERE id=?").bind(id).first();
  if (!event) return notFound("event not found");
  const addedAfterFinalization=event.commercial_finalized_at?1:0;
  await env.DB.prepare(
    `INSERT INTO event_services (event_id, service_id, price_at_booking, is_crosssell, source_type, added_after_finalization)
     VALUES (?, ?, ?, ?, 'manual', ?)`
  ).bind(id, body.service_id, service.base_price, body.is_crosssell ? 1 : 0, addedAfterFinalization).run();

  await recomputeQuote(env, id);
  await refreshEventOperations(env,id);
  return json({ ok: true, added_after_finalization: !!addedAfterFinalization });
}

// Removes one line item (a service or an applied package) from an event —
// the "Line items" list had no way back out before this.
export async function removeEventService(request, env, eventServiceId) {
  const row = await env.DB.prepare(`SELECT es.event_id,es.added_after_finalization,e.commercial_finalized_at
    FROM event_services es JOIN events e ON e.id=es.event_id WHERE es.id=?`).bind(eventServiceId).first();
  if (!row) return notFound("line item not found");
  if(row.commercial_finalized_at && !row.added_after_finalization) return badRequest("Finalized quote items cannot be removed. Add a separate post-finalization adjustment instead.");
  await env.DB.prepare(`DELETE FROM event_services WHERE id = ?`).bind(eventServiceId).run();
  await recomputeQuote(env, row.event_id);
  return json({ ok: true });
}

export async function applyPackageToEvent(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body || !body.package_id) return badRequest("package_id is required");
  const pkg = await env.DB.prepare(`SELECT * FROM packages WHERE id = ? AND active = 1`).bind(body.package_id).first();
  if (!pkg) return notFound("package not found");
  const event=await env.DB.prepare("SELECT commercial_finalized_at FROM events WHERE id=?").bind(id).first();
  if(!event) return notFound("event not found");
  await env.DB.prepare(
    `INSERT INTO event_services (event_id, package_id, price_at_booking, is_crosssell, source_type, added_after_finalization)
     VALUES (?, ?, ?, 0, 'manual', ?)`
  ).bind(id, pkg.id, pkg.base_price, event.commercial_finalized_at?1:0).run();

  await recomputeQuote(env, id);
  await refreshEventOperations(env,id);
  return json({ ok: true });
}

export async function setEventTier(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body || !body.pricing_tier_id) return badRequest("pricing_tier_id is required");
  await env.DB.prepare(`UPDATE events SET pricing_tier_id = ? WHERE id = ?`).bind(body.pricing_tier_id, id).run();
  await recomputeQuote(env, id);
  return json({ ok: true });
}

export async function rebuildEventOperations(env,eventId) {
  const event=await env.DB.prepare("SELECT id,start_date,end_date,event_date FROM events WHERE id=?").bind(eventId).first();
  if(!event) return;
  const required=(await env.DB.prepare(`
    SELECT DISTINCT es.service_id,ss.skill_id,s.label,s.workflow_phase,s.start_offset_days,s.due_offset_days
    FROM event_services es JOIN service_skills ss ON ss.service_id=es.service_id
    JOIN skills s ON s.id=ss.skill_id AND s.active=1
    WHERE es.event_id=? AND es.service_id IS NOT NULL
    UNION
    SELECT DISTINCT pi.service_id,ss.skill_id,s.label,s.workflow_phase,s.start_offset_days,s.due_offset_days
    FROM event_services es JOIN package_items pi ON pi.package_id=es.package_id
    JOIN service_skills ss ON ss.service_id=pi.service_id
    JOIN skills s ON s.id=ss.skill_id AND s.active=1
    WHERE es.event_id=? AND es.package_id IS NOT NULL
    ORDER BY workflow_phase,label
  `).bind(eventId,eventId).all()).results;

  await env.DB.prepare("DELETE FROM event_resource_requirements WHERE event_id=? AND generated_by_system=1").bind(eventId).run();
  for(const skill of required){
    await env.DB.prepare(`INSERT INTO event_resource_requirements(event_id,role_label,skill_id,quantity,phase,allocation_date,notes,generated_by_system) VALUES(?,?,?,1,?,?,?,1)`)
      .bind(eventId,skill.label,skill.skill_id,skill.workflow_phase,event.start_date||event.event_date,null).run();
  }

  const existingGenerated=(await env.DB.prepare(`
    SELECT item,phase,template_id,generated_source,done FROM event_checklist
    WHERE event_id=? AND generated_source IS NOT NULL
  `).bind(eventId).all()).results;
  const completed=new Set(existingGenerated.filter(x=>Number(x.done)===1).map(x=>
    [x.generated_source||"",x.template_id||"",x.item||"",x.phase||""].join("|")
  ));
  await env.DB.prepare("DELETE FROM event_checklist WHERE event_id=? AND generated_source IS NOT NULL").bind(eventId).run();

  const insertChecklist=async(item,phase,templateId,source)=>{
    const key=[source||"",templateId||"",item||"",phase||""].join("|");
    await env.DB.prepare("INSERT INTO event_checklist(event_id,item,done,phase,template_id,generated_source) VALUES(?,?,?,?,?,?)")
      .bind(eventId,item,completed.has(key)?1:0,phase,templateId||null,source).run();
  };

  const globalTemplates=(await env.DB.prepare(`
    SELECT id,item,phase FROM checklist_templates
    WHERE active=1 AND service_id IS NULL AND skill_id IS NULL
    ORDER BY phase,sort_order,id
  `).all()).results;
  for(const t of globalTemplates) await insertChecklist(t.item,t.phase,t.id,"template");

  const serviceIds=[...new Set(required.map(x=>Number(x.service_id)).filter(Number.isInteger))];
  if(serviceIds.length){
    const placeholders=serviceIds.map(()=>"?").join(",");
    const serviceTemplates=(await env.DB.prepare(`
      SELECT id,item,phase,service_id FROM checklist_templates
      WHERE active=1 AND service_id IN (${placeholders})
      ORDER BY phase,sort_order,id
    `).bind(...serviceIds).all()).results;
    for(const t of serviceTemplates) await insertChecklist(t.item,t.phase,t.id,"service-template");
  }

  const skillIds=[...new Set(required.map(x=>Number(x.skill_id)).filter(Number.isInteger))];
  if(skillIds.length){
    const placeholders=skillIds.map(()=>"?").join(",");
    const skillTemplates=(await env.DB.prepare(`
      SELECT id,item,phase,skill_id FROM checklist_templates
      WHERE active=1 AND skill_id IN (${placeholders})
      ORDER BY phase,sort_order,id
    `).bind(...skillIds).all()).results;
    for(const t of skillTemplates) await insertChecklist(t.item,t.phase,t.id,"skill-template");
  }

  for(const skill of required) await insertChecklist("Assign resource: "+skill.label,skill.workflow_phase,null,"skill-readiness");

  const allocations=(await env.DB.prepare(`SELECT era.id,era.start_source,era.due_source,s.start_offset_days,s.due_offset_days,era.start_at,era.end_at
    FROM event_resource_allocations era JOIN skills s ON s.id=era.skill_id
    WHERE era.event_id=? AND era.generated_from_skill=1`).bind(eventId).all()).results;
  const base=event.start_date||event.event_date;
  const dateOffset=(date,days)=>{if(!date)return null;const d=new Date(date+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+Number(days||0));return d.toISOString().slice(0,10);};
  for(const a of allocations){
    const start=a.start_source==="skill-rule"?dateOffset(base,a.start_offset_days):a.start_at?.slice(0,10);
    const due=a.due_source==="skill-rule"?dateOffset(base,a.due_offset_days):a.end_at?.slice(0,10);
    const st=start?(start+"T"+(a.start_at?.slice(11,16)||"09:00")):null;
    const en=due?(due+"T"+(a.end_at?.slice(11,16)||"18:00")):null;
    await env.DB.prepare("UPDATE event_resource_allocations SET start_at=?,end_at=?,allocation_date=?,start_time=?,end_time=?,updated_at=datetime('now') WHERE id=?")
      .bind(st,en,st?.slice(0,10)||null,st?.slice(11,16)||null,en?.slice(11,16)||null,a.id).run();
  }
}

export async function refreshEventOperations(request, env, eventId) {
  const event=await env.DB.prepare("SELECT id FROM events WHERE id=?").bind(eventId).first();
  if(!event) return notFound("event not found");
  await rebuildEventOperations(env,eventId);
  return json({ok:true});
}

export async function getEventActivity(request, env, eventId) {
  const [allocationHistory,] = await Promise.all([
    env.DB.prepare(`SELECT h.*,r.name AS resource_name,s.label AS skill_label
      FROM event_resource_allocation_history h
      LEFT JOIN event_resource_allocations era ON era.id=h.allocation_id
      LEFT JOIN resources r ON r.id=era.resource_id
      LEFT JOIN skills s ON s.id=era.skill_id
      WHERE h.event_id=? ORDER BY h.changed_at DESC,h.id DESC`).bind(eventId).all()
  ]);
  return json({allocation_history:allocationHistory.results});
}

async function recomputeQuote(env, eventId) {
  const event=await env.DB.prepare("SELECT quote_snapshot_json,commercial_finalized_at,finalized_quote_total FROM events WHERE id=?").bind(eventId).first();
  const { results } = await env.DB.prepare(
    `SELECT price_at_booking,added_after_finalization FROM event_services WHERE event_id = ?`
  ).bind(eventId).all();
  const lineTotal=results.reduce((s,r)=>s+Number(r.price_at_booking||0),0);
  let total=lineTotal;
  if(event?.commercial_finalized_at){
    const additions=results.filter(r=>Number(r.added_after_finalization)===1).reduce((s,r)=>s+Number(r.price_at_booking||0),0);
    total=Number(event.finalized_quote_total ?? 0)+additions;
  }
  await env.DB.prepare(`UPDATE events SET quote_total = ? WHERE id = ?`).bind(Math.max(0,total),eventId).run();
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
  if(request.headers.get("x-delete-confirmation")!=="DOUBLE") return badRequest("Delete requires double confirmation.");
  const payment = await env.DB.prepare(`SELECT * FROM payments WHERE id = ?`).bind(paymentId).first();
  if (!payment) return notFound("payment not found");
  await env.DB.batch([
    env.DB.prepare(`UPDATE events SET advance_paid = advance_paid - ? WHERE id = ?`).bind(payment.amount, payment.event_id),
    env.DB.prepare(`UPDATE payment_schedule SET status = 'Pending', paid_payment_id = NULL WHERE paid_payment_id = ?`).bind(paymentId),
    env.DB.prepare(`DELETE FROM payments WHERE id = ?`).bind(paymentId),
  ]);
  return json({ ok: true });
}

// ── Event invoices ──────────────────────────────────────────────────
export async function getEventInvoice(request, env, eventId) {
  const invoice=await env.DB.prepare("SELECT * FROM invoices WHERE event_id=? ORDER BY version DESC,id DESC LIMIT 1").bind(eventId).first();
  return json(invoice||null);
}

export async function generateEventInvoice(request, env, eventId) {
  const event=await env.DB.prepare(`SELECT e.*,a.name AS client_name,a.phone,a.email,a.address FROM events e JOIN accounts a ON a.id=e.account_id WHERE e.id=?`).bind(eventId).first();
  if(!event) return notFound("event not found");
  const existing=await env.DB.prepare("SELECT * FROM invoices WHERE event_id=? ORDER BY version DESC,id DESC LIMIT 1").bind(eventId).first();
  if(existing?.locked_at) return badRequest("invoice is locked");
  const items=(await env.DB.prepare(`SELECT es.id,COALESCE(s.name,p.name) AS label,es.price_at_booking,es.is_crosssell,es.added_after_finalization
    FROM event_services es LEFT JOIN services s ON s.id=es.service_id LEFT JOIN packages p ON p.id=es.package_id
    WHERE es.event_id=? ORDER BY es.id`).bind(eventId).all()).results;
  const payments=(await env.DB.prepare("SELECT id,amount,method,date,note FROM payments WHERE event_id=? ORDER BY date,id").bind(eventId).all()).results;
  const version=existing?Number(existing.version||1)+1:1;
  const snapshot={event_id:eventId,client:{name:event.client_name,phone:event.phone,email:event.email,address:event.address},event:{type:event.type,date:event.event_date,venue:event.venue},items,total:Number(event.quote_total||0),payments,generated_at:new Date().toISOString()};
  if(existing){
    await env.DB.prepare("UPDATE invoices SET total_amount=?,snapshot_json=?,version=?,status='Draft',issued_at=NULL,paid_at=NULL,updated_at=datetime('now') WHERE id=?")
      .bind(Number(event.quote_total||0),JSON.stringify(snapshot),version,existing.id).run();
    return json({ok:true,id:existing.id,version});
  }
  const number=`INV-${String(eventId).padStart(4,"0")}`;
  const r=await env.DB.prepare("INSERT INTO invoices(event_id,invoice_number,status,total_amount,snapshot_json,version) VALUES(?,?, 'Draft',?,?,?)")
    .bind(eventId,number,Number(event.quote_total||0),JSON.stringify(snapshot),version).run();
  return json({ok:true,id:r.meta.last_row_id,invoice_number:number,version});
}

export async function issueEventInvoice(request, env, invoiceId) {
  const invoice=await env.DB.prepare("SELECT * FROM invoices WHERE id=?").bind(invoiceId).first();
  if(!invoice) return notFound("invoice not found");
  if(invoice.locked_at) return badRequest("invoice is locked");
  if(invoice.status==="Cancelled") return badRequest("cancelled invoice cannot be issued");
  await env.DB.prepare("UPDATE invoices SET status='Issued',issued_at=datetime('now'),updated_at=datetime('now') WHERE id=?").bind(invoiceId).run();
  return json({ok:true});
}

export async function markInvoicePaid(request, env, invoiceId) {
  const invoice=await env.DB.prepare("SELECT * FROM invoices WHERE id=?").bind(invoiceId).first();
  if(!invoice) return notFound("invoice not found");
  if(invoice.locked_at && invoice.status==="Paid") return json({ok:true});
  await env.DB.prepare("UPDATE invoices SET status='Paid',paid_at=datetime('now'),updated_at=datetime('now') WHERE id=?").bind(invoiceId).run();
  return json({ok:true});
}

// ── Catalogue ────────────────────────────────────────────────────────
export async function listServices(request, env) {
  const { results } = await env.DB.prepare(
    `SELECT s.*,
      COALESCE(GROUP_CONCAT(DISTINCT sk.skill_id),'') AS skill_ids,
      COALESCE(GROUP_CONCAT(DISTINCT k.label),'') AS skills
     FROM services s
     LEFT JOIN service_skills sk ON sk.service_id=s.id
     LEFT JOIN skills k ON k.id=sk.skill_id AND k.active=1
     GROUP BY s.id
     ORDER BY s.sort_order,s.category,s.name`
  ).all();
  return json(results.map(s => ({...s, skill_ids:s.skill_ids?s.skill_ids.split(',').map(Number).filter(Number.isFinite):[]})));
}

export async function saveService(request, env, serviceId) {
  const body=await request.json().catch(()=>null);
  if(!body?.name) return badRequest("name is required");
  const price=Number(body.base_price);
  if(!Number.isFinite(price) || price<0) return badRequest("base_price must be a valid non-negative number");
  const category=body.category||"Production";
  let id=serviceId||body.id;
  if(id){
    const existing=await env.DB.prepare("SELECT id FROM services WHERE id=?").bind(id).first();
    if(!existing) return notFound("service not found");
    await env.DB.prepare(`UPDATE services SET name=?,base_price=?,category=?,internal_code=?,resource_required=?,description=?,active=?,sort_order=? WHERE id=?`)
      .bind(body.name,Math.round(price),category,body.internal_code||null,body.resource_required?1:0,body.description||null,body.active===false?0:1,Number(body.sort_order||0),id).run();
  } else {
    const r=await env.DB.prepare(`INSERT INTO services(name,base_price,category,internal_code,resource_required,description,active,sort_order) VALUES(?,?,?,?,?,?,?,?)`)
      .bind(body.name,Math.round(price),category,body.internal_code||null,body.resource_required?1:0,body.description||null,body.active===false?0:1,Number(body.sort_order||0)).run();
    id=r.meta.last_row_id;
  }
  if(Array.isArray(body.skill_ids)){
    await env.DB.prepare("DELETE FROM service_skills WHERE service_id=?").bind(id).run();
    const skills=body.skill_ids.map(Number).filter(Number.isInteger);
    if(skills.length) await env.DB.batch(skills.map(skillId=>env.DB.prepare("INSERT OR IGNORE INTO service_skills(service_id,skill_id) VALUES(?,?)").bind(id,skillId)));
  }
  return json({ok:true,id});
}
export async function listTiers(request, env) {
  const { results } = await env.DB.prepare(`SELECT * FROM pricing_tiers ORDER BY multiplier`).all();
  return json(results);
}

// ── Packages (fixed bundles + source-of-truth details) ──
function parseJsonArray(value) {
  if (Array.isArray(value)) return value.map(x=>String(x).trim()).filter(Boolean);
  if (value == null || value === "") return [];
  try { const parsed=JSON.parse(value); return Array.isArray(parsed) ? parsed.map(x=>String(x).trim()).filter(Boolean) : []; } catch {
    return String(value).split(/\r?\n|\s*[,;]\s*/).map(x=>x.trim()).filter(Boolean);
  }
}
function packageDetailsFromRow(row) {
  if(!row) return {sessions_text:null,crew:[],deliverables:[],complimentary:[]};
  return {
    sessions_text: row.sessions_text || null,
    crew: parseJsonArray(row.crew_json),
    deliverables: parseJsonArray(row.deliverables_json),
    complimentary: parseJsonArray(row.complimentary_json)
  };
}
async function upsertPackageDetails(env, packageId, details) {
  if (!details) return;
  const existing=await env.DB.prepare("SELECT * FROM package_details WHERE package_id=?").bind(packageId).first();
  const d={
    sessions_text: details.sessions_text ?? details.sessions ?? existing?.sessions_text ?? null,
    crew: parseJsonArray(details.crew ?? existing?.crew_json),
    deliverables: parseJsonArray(details.deliverables ?? existing?.deliverables_json),
    complimentary: parseJsonArray(details.complimentary ?? existing?.complimentary_json)
  };
  await env.DB.prepare(`INSERT INTO package_details(package_id,sessions_text,crew_json,deliverables_json,complimentary_json,updated_at)
    VALUES(?,?,?,?,?,datetime('now'))
    ON CONFLICT(package_id) DO UPDATE SET
      sessions_text=excluded.sessions_text,
      crew_json=excluded.crew_json,
      deliverables_json=excluded.deliverables_json,
      complimentary_json=excluded.complimentary_json,
      updated_at=datetime('now')`)
    .bind(packageId,d.sessions_text,JSON.stringify(d.crew),JSON.stringify(d.deliverables),JSON.stringify(d.complimentary)).run();
}
async function snapshotPackageDetails(env, packageId) {
  const [pkg,details,items]=await Promise.all([
    env.DB.prepare("SELECT id,name,base_price,description FROM packages WHERE id=? AND active=1").bind(packageId).first(),
    env.DB.prepare("SELECT * FROM package_details WHERE package_id=?").bind(packageId).first(),
    env.DB.prepare(`SELECT pi.service_id,s.name,pi.quantity FROM package_items pi JOIN services s ON s.id=pi.service_id WHERE pi.package_id=? ORDER BY pi.id`).bind(packageId).all()
  ]);
  if(!pkg) return null;
  const d=packageDetailsFromRow(details);
  return {...d, services:items.results.map(x=>({service_id:x.service_id,name:x.name,quantity:Number(x.quantity||1)}))};
}
async function createQuotePackageOptionRecord(env, quoteId, packageId, sortOrder=0, selected=0) {
  const pkg=await env.DB.prepare("SELECT id,name,base_price,active FROM packages WHERE id=?").bind(packageId).first();
  if(!pkg || !pkg.active) throw new Error("package not found or inactive");
  const details=await snapshotPackageDetails(env,packageId);
  const detailsJson=JSON.stringify(details||{});
  await env.DB.prepare(`INSERT INTO quote_package_options(quote_id,package_id,label,price,details_json,selected,sort_order)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(quote_id,package_id) DO UPDATE SET
      label=excluded.label,price=excluded.price,details_json=excluded.details_json,
      sort_order=excluded.sort_order,updated_at=datetime('now')`)
    .bind(quoteId,pkg.id,pkg.name,Number(pkg.base_price||0),detailsJson,selected?1:0,sortOrder).run();
  const option = await env.DB.prepare(`SELECT id FROM quote_package_options WHERE quote_id=? AND package_id=?`).bind(quoteId,pkg.id).first();
  if(option){
    const services = await env.DB.prepare(`SELECT pi.service_id,s.name,pi.quantity
      FROM package_items pi JOIN services s ON s.id=pi.service_id WHERE pi.package_id=? ORDER BY pi.id`).bind(pkg.id).all();
    for(const svc of services.results){
      await env.DB.prepare(`INSERT INTO quote_items
        (quote_id,service_id,package_id,quote_package_option_id,label,price,is_addon,selected,quantity)
        SELECT ?,?,?,?,?,0,0,1,?
        WHERE NOT EXISTS (
          SELECT 1 FROM quote_items WHERE quote_package_option_id=? AND service_id=?
        )`)
        .bind(quoteId,svc.service_id,pkg.id,option.id,svc.name,Number(svc.quantity||1),option.id,svc.service_id).run();
    }
  }
}
export async function listPackages(request, env) {
  const [{ results: packages }, { results: items }, { results: details }] = await Promise.all([
    env.DB.prepare(`SELECT * FROM packages WHERE active = 1 ORDER BY base_price, sort_order, id`).all(),
    env.DB.prepare(
      `SELECT pi.package_id, s.id AS service_id, s.name, pi.quantity FROM package_items pi JOIN services s ON s.id = pi.service_id ORDER BY pi.id`
    ).all(),
    env.DB.prepare(`SELECT * FROM package_details`).all(),
  ]);
  const byPackage = {};
  for (const it of items) (byPackage[it.package_id] ||= []).push({ service_id:it.service_id, name:it.name, quantity:Number(it.quantity||1) });
  const detailMap = Object.fromEntries(details.map(d=>[d.package_id,packageDetailsFromRow(d)]));
  return json(packages.map((p) => ({ ...p, items: byPackage[p.id] || [], details: detailMap[p.id] || {sessions_text:null,crew:[],deliverables:[],complimentary:[]} })));
}

export async function createPackage(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !body.name || body.base_price === undefined) return badRequest("name and base_price are required");
  const result = await env.DB.prepare(`INSERT INTO packages (name, description, base_price) VALUES (?, ?, ?)`)
    .bind(body.name, body.description || null, Number(body.base_price)).run();
  const packageId = result.meta.last_row_id;
  if (Array.isArray(body.service_ids)) {
    await env.DB.batch(body.service_ids.map(serviceId =>
      env.DB.prepare(`INSERT OR IGNORE INTO package_items (package_id, service_id, quantity) VALUES (?, ?, ?)`).bind(packageId, Number(serviceId), 1)
    ));
  }
  await upsertPackageDetails(env, packageId, body.details);
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
    if(body.service_ids.length) await env.DB.batch(body.service_ids.map(serviceId =>
      env.DB.prepare(`INSERT OR IGNORE INTO package_items (package_id, service_id, quantity) VALUES (?, ?, ?)`).bind(packageId, Number(serviceId), 1)
    ));
  }
  await upsertPackageDetails(env, packageId, body.details);
  return json({ ok: true });
}

export async function deletePackage(request, env, packageId) {
  if(request.headers.get("x-delete-confirmation")!=="DOUBLE") return badRequest("Delete requires double confirmation.");
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
  if(request.headers.get("x-delete-confirmation")!=="DOUBLE") return badRequest("Delete requires double confirmation.");
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
  if(request.headers.get("x-delete-confirmation")!=="DOUBLE") return badRequest("Delete requires double confirmation.");
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
  if(request.headers.get("x-delete-confirmation")!=="DOUBLE") return badRequest("Delete requires double confirmation.");
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
  if(request.headers.get("x-delete-confirmation")!=="DOUBLE") return badRequest("Delete requires double confirmation.");
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
  if(request.headers.get("x-delete-confirmation")!=="DOUBLE") return badRequest("Delete requires double confirmation.");
  await env.DB.prepare(`DELETE FROM deliverables WHERE id = ?`).bind(deliverableId).run();
  return json({ ok: true });
}

// ── Pre-event checklist ────────────────────────────────────────────
const CHECKLIST_PHASE_LIST = ["Pre-Production", "Production", "Post-Production"];

// One-off item on THIS event only — doesn't touch the shared template, for
// the case where a specific booking needs something the general checklist
// doesn't (a custom permit, a family request, an unusual venue requirement).
export async function addEventChecklistItem(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body || !body.item) return badRequest("item is required");
  const phase = CHECKLIST_PHASE_LIST.includes(body.phase) ? body.phase : "Pre-wedding";
  await env.DB.prepare(`INSERT INTO event_checklist (event_id, item, phase) VALUES (?, ?, ?)`)
    .bind(id, body.item, phase).run();
  return json({ ok: true }, { status: 201 });
}

export async function removeEventChecklistItem(request, env, itemId) {
  if(request.headers.get("x-delete-confirmation")!=="DOUBLE") return badRequest("Delete requires double confirmation.");
  await env.DB.prepare(`DELETE FROM event_checklist WHERE id = ?`).bind(itemId).run();
  return json({ ok: true });
}

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

const CHECKLIST_PHASES = ["Pre-Production", "Production", "Post-Production"];

export async function addChecklistTemplateItem(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !body.item) return badRequest("item is required");
  const phase = CHECKLIST_PHASES.includes(body.phase) ? body.phase : "Pre-Production";
  const { results } = await env.DB.prepare(`SELECT COALESCE(MAX(sort_order),0) AS m FROM checklist_templates`).all();
  const serviceId=body.service_id?Number(body.service_id):null;
  const skillId=body.skill_id?Number(body.skill_id):null;
  if(serviceId){const row=await env.DB.prepare("SELECT id FROM services WHERE id=? AND active=1").bind(serviceId).first();if(!row)return badRequest("invalid service");}
  if(skillId){const row=await env.DB.prepare("SELECT id FROM skills WHERE id=? AND active=1").bind(skillId).first();if(!row)return badRequest("invalid skill");}
  await env.DB.prepare(`INSERT INTO checklist_templates (item, sort_order, phase, service_id, skill_id, active) VALUES (?, ?, ?, ?, ?, 1)`)
    .bind(body.item, (results[0]?.m || 0) + 1, phase, serviceId, skillId).run();
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
  if(request.headers.get("x-delete-confirmation")!=="DOUBLE") return badRequest("Delete requires double confirmation.");
  await env.DB.prepare(`DELETE FROM event_tasks WHERE id = ?`).bind(taskId).run();
  return json({ ok: true });
}

// ── Equipment — studio-owned gear catalog, plus per-event resourcing so
// "are we ready" covers gear, not just people. See migration 0005: this is
// a readiness checklist, not a cost ledger — a rented item's actual cost
// still goes through Outside vendors, same as before.
export async function listEquipment(request, env) {
  const { results } = await env.DB.prepare(`SELECT * FROM equipment ORDER BY category, name`).all();
  return json(results);
}

export async function createEquipment(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !body.name) return badRequest("name is required");
  const result = await env.DB.prepare(`INSERT INTO equipment (name, category, owned, notes) VALUES (?, ?, ?, ?)`)
    .bind(body.name, body.category || null, body.owned === false ? 0 : 1, body.notes || null).run();
  return json({ ok: true, id: result.meta.last_row_id }, { status: 201 });
}

export async function updateEquipment(request, env, equipId) {
  const body = await request.json().catch(() => null);
  if (!body) return badRequest("no fields given");
  const eq = await env.DB.prepare(`SELECT * FROM equipment WHERE id = ?`).bind(equipId).first();
  if (!eq) return notFound("equipment not found");
  const name = body.name ?? eq.name;
  const category = body.category !== undefined ? body.category || null : eq.category;
  const owned = body.owned !== undefined ? (body.owned ? 1 : 0) : eq.owned;
  await env.DB.prepare(`UPDATE equipment SET name = ?, category = ?, owned = ? WHERE id = ?`)
    .bind(name, category, owned, equipId).run();
  return json({ ok: true });
}

// Blocks the delete if it's assigned to any event, same "don't orphan real
// data" guard used for vendors/packages.
export async function deleteEquipment(request, env, equipId) {
  if(request.headers.get("x-delete-confirmation")!=="DOUBLE") return badRequest("Delete requires double confirmation.");
  const used = await env.DB.prepare(`SELECT COUNT(*) AS n FROM event_equipment WHERE equipment_id = ?`).bind(equipId).first();
  if (used.n > 0) return badRequest(`Can't delete — this is assigned to ${used.n} event(s). Remove it from those events first.`);
  await env.DB.prepare(`DELETE FROM equipment WHERE id = ?`).bind(equipId).run();
  return json({ ok: true });
}

export async function addEventEquipment(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body || (!body.equipment_id && !body.custom_label)) return badRequest("equipment_id or custom_label is required");
  await env.DB.prepare(
    `INSERT INTO event_equipment (event_id, equipment_id, custom_label, needs_rental) VALUES (?, ?, ?, ?)`
  ).bind(id, body.equipment_id || null, body.custom_label || null, body.needs_rental ? 1 : 0).run();
  return json({ ok: true }, { status: 201 });
}

export async function toggleEventEquipmentReady(request, env, eventEquipId) {
  const row = await env.DB.prepare(`SELECT ready FROM event_equipment WHERE id = ?`).bind(eventEquipId).first();
  if (!row) return notFound("event equipment row not found");
  const ready = row.ready ? 0 : 1;
  await env.DB.prepare(`UPDATE event_equipment SET ready = ? WHERE id = ?`).bind(ready, eventEquipId).run();
  return json({ ok: true, ready: !!ready });
}

export async function removeEventEquipment(request, env, eventEquipId) {
  if(request.headers.get("x-delete-confirmation")!=="DOUBLE") return badRequest("Delete requires double confirmation.");
  await env.DB.prepare(`DELETE FROM event_equipment WHERE id = ?`).bind(eventEquipId).run();
  return json({ ok: true });
}

// ── Expenses — one ledger for everything spent: event-tied (shows up on
// that event's cost breakdown, as before) and general/office spend
// (event_id left blank — rent, software, misc supplies). Previously the
// only way to log an expense was through the staff portal on a specific
// event; this adds admin-side create/edit/delete and makes event_id
// optional so non-event spend has a home too, rather than needing
// monthly_costs (fixed recurring totals) to cover something it wasn't
// built for (itemized, dated, individually-editable entries).
export async function listExpenses(request, env) {
  const params = new URL(request.url).searchParams;
  const eventId = params.get("event_id");
  const category = params.get("category");
  const clauses = [];
  const binds = [];
  if (eventId) { clauses.push("ex.event_id = ?"); binds.push(eventId); }
  if (category) { clauses.push("ex.category = ?"); binds.push(category); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { results } = await env.DB.prepare(
    `SELECT ex.*, e.type AS event_type, a.name AS account_name
     FROM expenses ex
     LEFT JOIN events e ON e.id = ex.event_id
     LEFT JOIN accounts a ON a.id = e.account_id
     ${where} ORDER BY ex.submitted_at DESC`
  ).bind(...binds).all();
  return json(results);
}

export async function createExpense(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !body.category || !body.amount) return badRequest("category and amount are required");
  const result = await env.DB.prepare(
    `INSERT INTO expenses (event_id, category, amount, note, submitted_at) VALUES (?, ?, ?, ?, datetime('now'))`
  ).bind(body.event_id || null, body.category, Number(body.amount), body.note || null).run();
  return json({ ok: true, id: result.meta.last_row_id }, { status: 201 });
}

export async function updateExpense(request, env, expenseId) {
  const body = await request.json().catch(() => null);
  if (!body) return badRequest("no fields given");
  const ex = await env.DB.prepare(`SELECT * FROM expenses WHERE id = ?`).bind(expenseId).first();
  if (!ex) return notFound("expense not found");
  const event_id = body.event_id !== undefined ? body.event_id || null : ex.event_id;
  const category = body.category ?? ex.category;
  const amount = body.amount !== undefined ? Number(body.amount) : ex.amount;
  const note = body.note !== undefined ? body.note || null : ex.note;
  await env.DB.prepare(`UPDATE expenses SET event_id = ?, category = ?, amount = ?, note = ? WHERE id = ?`)
    .bind(event_id, category, amount, note, expenseId).run();
  return json({ ok: true });
}

export async function deleteExpense(request, env, expenseId) {
  if(request.headers.get("x-delete-confirmation")!=="DOUBLE") return badRequest("Delete requires double confirmation.");
  await env.DB.prepare(`DELETE FROM expenses WHERE id = ?`).bind(expenseId).run();
  return json({ ok: true });
}

// ── Reports (blueprint §6) ───────────────────────────────────────────
export async function reportConversion(request, env) {
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN stage = 'Won' THEN 1 ELSE 0 END) AS booked
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
       SUM(CASE WHEN stage = 'Won' THEN 1 ELSE 0 END) AS booked,
       SUM(CASE WHEN stage = 'Won' THEN budget_est ELSE 0 END) AS booked_value
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

// Trailing 12-month rollup — "turnover", "running profit", and now a real
// P&L: event-level numbers (revenue/cost, unchanged meaning) plus actual
// cash collected that month and the month's running business overhead
// (rent/salaries/ad spend/etc. from monthly_costs), so net_profit reflects
// money in vs. money out, not just booked value vs. per-event cost.
export async function reportMonthly(request, env) {
  const [{ results: eventRows }, { results: paymentRows }, { results: overheadRows }] = await Promise.all([
    env.DB.prepare(
      `SELECT
         strftime('%Y-%m', e.event_date) AS month,
         COUNT(*) AS events,
         SUM(e.quote_total) AS revenue,
         SUM(COALESCE((SELECT SUM(cost) FROM event_staff_links WHERE event_id = e.id), 0)
           + COALESCE((SELECT SUM(cost) FROM event_vendors WHERE event_id = e.id), 0)
           + COALESCE((SELECT SUM(amount) FROM expenses WHERE event_id = e.id), 0)) AS cost
       FROM events e
       WHERE e.event_date >= date('now', '-12 months')
       GROUP BY month ORDER BY month ASC`
    ).all(),
    env.DB.prepare(
      `SELECT strftime('%Y-%m', date) AS month, SUM(amount) AS cash_collected
       FROM payments WHERE date >= date('now', '-12 months') GROUP BY month`
    ).all(),
    env.DB.prepare(`SELECT month, SUM(amount) AS overhead_cost FROM monthly_costs GROUP BY month`).all(),
  ]);
  const cashByMonth = Object.fromEntries(paymentRows.map((r) => [r.month, r.cash_collected]));
  const overheadByMonth = Object.fromEntries(overheadRows.map((r) => [r.month, r.overhead_cost]));
  return json(
    eventRows.map((r) => {
      const cash_collected = cashByMonth[r.month] || 0;
      const overhead_cost = overheadByMonth[r.month] || 0;
      return {
        ...r,
        profit: r.revenue - r.cost, // per-event booked value vs. per-event cost, as before
        cash_collected,
        overhead_cost,
        net_profit: cash_collected - r.cost - overhead_cost, // cash actually in vs. everything actually out
      };
    })
  );
}

// Quarter-over-quarter view of the same event-level numbers — "how is the
// business progressing" at a coarser grain than month-to-month noise.
export async function reportQuarterly(request, env) {
  const { results } = await env.DB.prepare(
    `SELECT
       strftime('%Y', e.event_date) || '-Q' || ((CAST(strftime('%m', e.event_date) AS INTEGER) + 2) / 3) AS quarter,
       COUNT(*) AS events,
       SUM(e.quote_total) AS revenue,
       SUM(COALESCE((SELECT SUM(cost) FROM event_staff_links WHERE event_id = e.id), 0)
         + COALESCE((SELECT SUM(cost) FROM event_vendors WHERE event_id = e.id), 0)
         + COALESCE((SELECT SUM(amount) FROM expenses WHERE event_id = e.id), 0)) AS cost
     FROM events e
     WHERE e.event_date >= date('now', '-24 months')
     GROUP BY quarter ORDER BY quarter ASC`
  ).all();
  return json(results.map((r) => ({ ...r, profit: r.revenue - r.cost })));
}

// Calendar-month seasonality, collapsed across all years of history — which
// months of the year (not which specific month) tend to be slow. This is
// the "when should we run a promotion" view; the promotions log (below)
// is where you record what you actually ran and what it produced.
export async function reportSeasonality(request, env) {
  const { results } = await env.DB.prepare(
    `SELECT strftime('%m', event_date) AS month_num, COUNT(*) AS events, COALESCE(SUM(quote_total),0) AS revenue
     FROM events WHERE event_date IS NOT NULL GROUP BY month_num ORDER BY month_num ASC`
  ).all();
  return json(results);
}

// ── Financials: monthly running cost, broken out by category ─────────
export async function listMonthlyCosts(request, env) {
  const params = new URL(request.url).searchParams;
  const month = params.get("month"); // optional 'YYYY-MM' filter
  const clauses = [];
  const binds = [];
  if (month) { clauses.push("month = ?"); binds.push(month); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { results } = await env.DB.prepare(`SELECT * FROM monthly_costs ${where} ORDER BY month DESC, category ASC`)
    .bind(...binds).all();
  return json(results);
}

// One row per (month, category) — re-saving the same month+category updates
// the existing figure instead of creating a duplicate, so correcting last
// month's rent entry doesn't double it in the P&L.
export async function setMonthlyCost(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !body.month || !body.category || body.amount === undefined) {
    return badRequest("month (YYYY-MM), category, and amount are required");
  }
  await env.DB.prepare(
    `INSERT INTO monthly_costs (month, category, amount, note) VALUES (?, ?, ?, ?)
     ON CONFLICT(month, category) DO UPDATE SET amount = excluded.amount, note = excluded.note`
  ).bind(body.month, body.category, Number(body.amount), body.note || null).run();
  return json({ ok: true }, { status: 201 });
}

export async function deleteMonthlyCost(request, env, costId) {
  if(request.headers.get("x-delete-confirmation")!=="DOUBLE") return badRequest("Delete requires double confirmation.");
  await env.DB.prepare(`DELETE FROM monthly_costs WHERE id = ?`).bind(costId).run();
  return json({ ok: true });
}

// ── Promotions log — a plain record of what ran and what it produced, not
// an ad-attribution engine. reportSeasonality tells you WHEN to run one;
// this is where you record that you did and whether it worked.
export async function listPromotions(request, env) {
  const { results } = await env.DB.prepare(`SELECT * FROM promotions ORDER BY start_date DESC, id DESC`).all();
  return json(results);
}

export async function createPromotion(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !body.name) return badRequest("name is required");
  const result = await env.DB.prepare(
    `INSERT INTO promotions (name, channel, start_date, end_date, cost) VALUES (?, ?, ?, ?, ?)`
  ).bind(body.name, body.channel || null, body.start_date || null, body.end_date || null, body.cost ? Number(body.cost) : 0).run();
  return json({ ok: true, id: result.meta.last_row_id }, { status: 201 });
}

// Covers both editing the setup fields and recording the outcome later —
// the outcome is only known after the promotion has run.
export async function updatePromotion(request, env, promoId) {
  const body = await request.json().catch(() => null);
  if (!body) return badRequest("no fields given");
  const p = await env.DB.prepare(`SELECT * FROM promotions WHERE id = ?`).bind(promoId).first();
  if (!p) return notFound("promotion not found");
  const name = body.name ?? p.name;
  const channel = body.channel !== undefined ? body.channel || null : p.channel;
  const start_date = body.start_date !== undefined ? body.start_date || null : p.start_date;
  const end_date = body.end_date !== undefined ? body.end_date || null : p.end_date;
  const cost = body.cost !== undefined ? Number(body.cost) : p.cost;
  const leads_generated = body.leads_generated !== undefined ? Number(body.leads_generated) : p.leads_generated;
  const bookings_generated = body.bookings_generated !== undefined ? Number(body.bookings_generated) : p.bookings_generated;
  const outcome_notes = body.outcome_notes !== undefined ? body.outcome_notes || null : p.outcome_notes;
  await env.DB.prepare(
    `UPDATE promotions SET name=?, channel=?, start_date=?, end_date=?, cost=?, leads_generated=?, bookings_generated=?, outcome_notes=? WHERE id=?`
  ).bind(name, channel, start_date, end_date, cost, leads_generated, bookings_generated, outcome_notes, promoId).run();
  return json({ ok: true });
}

export async function deletePromotion(request, env, promoId) {
  if(request.headers.get("x-delete-confirmation")!=="DOUBLE") return badRequest("Delete requires double confirmation.");
  await env.DB.prepare(`DELETE FROM promotions WHERE id = ?`).bind(promoId).run();
  return json({ ok: true });
}

// ── Settings — the handful of business-level values staff edit from the
// admin UI (currently just the Google review link). Not deploy config —
// see wrangler.jsonc/README for why that's a different, secret-managed path.
export async function getSettings(request, env) {
  const { results } = await env.DB.prepare(`SELECT key, value FROM settings`).all();
  return json(Object.fromEntries(results.map((r) => [r.key, r.value])));
}

export async function updateSetting(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !body.key) return badRequest("key is required");
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(body.key, body.value ?? "").run();
  return json({ ok: true });
}

// ── Feedback — sentiment-gated: positive responses route to your Google
// review link client-side and are never stored (see the public feedback
// route); only negative feedback needs an internal record to act on.
export async function getFeedbackLink(request, env, id) {
  const event = await env.DB.prepare(`SELECT id, feedback_token FROM events WHERE id = ?`).bind(id).first();
  if (!event) return notFound("event not found");
  let token = event.feedback_token;
  if (!token) {
    token = makeToken();
    await env.DB.prepare(`UPDATE events SET feedback_token = ? WHERE id = ?`).bind(token, id).run();
  }
  const url = new URL(request.url);
  return json({ ok: true, token, url: `${url.origin}/feedback/${token}` });
}

export async function listFeedback(request, env) {
  const params = new URL(request.url).searchParams;
  const status = params.get("status"); // optional filter, e.g. "Open"
  const clauses = ["f.sentiment = 'Negative'"]; // the action queue is inherently negative-only
  const binds = [];
  if (status) { clauses.push("f.status = ?"); binds.push(status); }
  const { results } = await env.DB.prepare(
    `SELECT f.*, e.type AS event_type, e.event_date, a.name AS account_name
     FROM feedback f JOIN events e ON e.id = f.event_id JOIN accounts a ON a.id = f.account_id
     WHERE ${clauses.join(" AND ")} ORDER BY f.created_at DESC`
  ).bind(...binds).all();
  return json(results);
}

export async function updateFeedback(request, env, feedbackId) {
  const body = await request.json().catch(() => null);
  if (!body) return badRequest("no fields given");
  const f = await env.DB.prepare(`SELECT * FROM feedback WHERE id = ?`).bind(feedbackId).first();
  if (!f) return notFound("feedback not found");
  const status = body.status ?? f.status;
  const action_taken = body.action_taken !== undefined ? body.action_taken || null : f.action_taken;
  await env.DB.prepare(`UPDATE feedback SET status = ?, action_taken = ? WHERE id = ?`)
    .bind(status, action_taken, feedbackId).run();
  return json({ ok: true });
}
