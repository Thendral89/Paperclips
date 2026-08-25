// Two access models, per blueprint §5 — revised: Google Sign-In instead of
// Cloudflare Access, so no Cloudflare card is required (chosen because this
// app has exactly 2 admin users who already have Google accounts).
//
// 1. Staff (Owner/Team) — a signed session cookie set by /auth/callback
//    after Google confirms who they are and their email is checked against
//    STAFF_EMAILS. We verify the cookie's HMAC signature ourselves; nothing
//    is trusted from the request that we didn't sign.
//
// 2. Photographer / field staff — unchanged: a long random token in the URL
//    maps to exactly one event_staff_links row. No login, no session.

import { verifySession, readCookie } from "./session.js";

export async function requireStaff(request, env) {
  const token = readCookie(request, "session");
  if (!token) return null;
  const payload = await verifySession(token, env.SESSION_SECRET);
  if (!payload) return null;
  return { email: payload.email };
}

export async function requireEventLink(env, token) {
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT * FROM event_staff_links WHERE token = ?`
  )
    .bind(token)
    .first();
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}
