// Two access models, per blueprint §5:
//
// 1. Staff (Owner/Team) — Cloudflare Access sits IN FRONT of /admin and
//    /api/admin* at the edge. Access only forwards a request here after a
//    successful login, and it stamps the verified email on this header:
//        Cf-Access-Authenticated-User-Email
//    We fail CLOSED: if that header is missing, we refuse the request —
//    even before you've finished setting up an Access application, so
//    /api/admin* is never accidentally wide open.
//
// 2. Photographer / field staff — a long random token in the URL maps to
//    exactly one event_staff_links row. No login, no session — the token
//    IS the credential, scoped server-side to one event_id.

export function requireStaff(request) {
  const email = request.headers.get("Cf-Access-Authenticated-User-Email");
  if (!email) return null;
  return { email };
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
