// Small shared helpers used across every route module.

export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers || {}) },
  });
}

export function badRequest(message) {
  return json({ error: message }, { status: 400 });
}

export function notFound(message = "Not found") {
  return json({ error: message }, { status: 404 });
}

export function unauthorized(message = "Unauthorized") {
  return json({ error: message }, { status: 401 });
}

// Cloudflare's crypto.randomUUID() is available in the Workers runtime —
// used for staff-link tokens. 32 random bytes, hex-encoded, unguessable.
export function makeToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function normalizePhone(phone) {
  return String(phone || "").replace(/[^0-9]/g, "").slice(-10); // last 10 digits, ignores +91/spaces/dashes
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
