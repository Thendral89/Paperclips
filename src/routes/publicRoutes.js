// Public, unauthenticated routes — the web form that replaces the Google Form.
// This is the ONLY write path into `leads` that doesn't require Cloudflare
// Access, by design: enquirers aren't staff.

import { json, badRequest, normalizePhone } from "../lib/util.js";

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
