// Google Sign-In, hand-rolled — no library, just the standard OAuth
// authorization-code flow. Trust model: we exchange the code for an access
// token via a direct server-to-server HTTPS call to Google using our client
// secret, then ask Google's own userinfo endpoint who that token belongs to.
// We never trust anything the browser hands us except the one-time code.

import { createSession, sessionCookieHeader, readCookie } from "../lib/session.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

function randomState() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function startLogin(request, env) {
  const url = new URL(request.url);
  const redirectUri = `${url.origin}/auth/callback`;
  const state = randomState();

  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("prompt", "select_account");

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl.toString(),
      "Set-Cookie": `oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}

export async function handleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = readCookie(request, "oauth_state");

  if (!code || !state || state !== expectedState) {
    return htmlError("Login failed — the request expired or was tampered with. Try signing in again.");
  }

  const redirectUri = `${url.origin}/auth/callback`;
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return htmlError("Google didn't accept that login attempt. Try again.");
  const tokens = await tokenRes.json();

  const userRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!userRes.ok) return htmlError("Couldn't confirm who you are with Google. Try again.");
  const profile = await userRes.json();
  const email = (profile.email || "").toLowerCase();

  const staffList = (env.STAFF_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!staffList.includes(email)) {
    return htmlError(`${email} isn't on the studio's staff list. Ask an owner to add it to STAFF_EMAILS if this is wrong.`, 403);
  }

  const session = await createSession(email, env.SESSION_SECRET);
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/admin",
      "Set-Cookie": sessionCookieHeader("session", session, 60 * 60 * 24 * 14),
    },
  });
}

export function logout() {
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": "session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    },
  });
}

function htmlError(message, status = 400) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;max-width:420px;margin:80px auto;text-align:center;color:#211D18;">
      <h2>Sign-in problem</h2><p>${message}</p><p><a href="/auth/login">Try again</a></p></body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}
