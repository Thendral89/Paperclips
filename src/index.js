// Paperclip Studios — CRM Worker
// One Worker serves the static frontend (via the `ASSETS` binding) AND the
// API (this file). See blueprint §1/§2 for the full architecture.

import { json, unauthorized, notFound } from "./lib/util.js";
import { requireStaff, requireEventLink } from "./lib/auth.js";
import { captureLead } from "./routes/publicRoutes.js";
import * as admin from "./routes/adminRoutes.js";
import * as portal from "./routes/portalRoutes.js";
import { startLogin, handleCallback, logout } from "./routes/authRoutes.js";
import { handleScheduled } from "./cron.js";

// Tiny hand-rolled router — no framework needed for a route table this size.
// Each entry: [method, RegExp with named captures via numbered groups, handler]
const ADMIN_ROUTES = [
  ["GET", /^\/api\/admin\/me$/, async (req, env, staff) => json({ email: staff.email })],
  ["GET", /^\/api\/admin\/dashboard$/, (req, env) => admin.dashboard(req, env)],
  ["GET", /^\/api\/admin\/leads$/, (req, env) => admin.listLeads(req, env)],
  ["POST", /^\/api\/admin\/leads$/, (req, env, staff) => admin.createLeadManual(req, env, staff)],
  ["GET", /^\/api\/admin\/leads\/(\d+)$/, (req, env, staff, [id]) => admin.getLead(req, env, id)],
  ["POST", /^\/api\/admin\/leads\/(\d+)\/stage$/, (req, env, staff, [id]) => admin.updateLeadStage(req, env, id, staff)],
  ["POST", /^\/api\/admin\/leads\/(\d+)\/followup$/, (req, env, staff, [id]) => admin.setFollowUp(req, env, id)],
  ["POST", /^\/api\/admin\/leads\/(\d+)\/notes$/, (req, env, staff, [id]) => admin.addNote(req, env, id, staff)],
  ["POST", /^\/api\/admin\/leads\/(\d+)\/convert$/, (req, env, staff, [id]) => admin.convertLead(req, env, id)],

  ["GET", /^\/api\/admin\/accounts$/, (req, env) => admin.listAccounts(req, env)],
  ["GET", /^\/api\/admin\/accounts\/(\d+)$/, (req, env, staff, [id]) => admin.getAccount360(req, env, id)],

  ["POST", /^\/api\/admin\/events$/, (req, env) => admin.createEvent(req, env)],
  ["GET", /^\/api\/admin\/events\/(\d+)$/, (req, env, staff, [id]) => admin.getEvent(req, env, id)],
  ["POST", /^\/api\/admin\/events\/(\d+)\/services$/, (req, env, staff, [id]) => admin.addEventService(req, env, id)],
  ["POST", /^\/api\/admin\/events\/(\d+)\/tier$/, (req, env, staff, [id]) => admin.setEventTier(req, env, id)],
  ["POST", /^\/api\/admin\/events\/(\d+)\/payments$/, (req, env, staff, [id]) => admin.addPayment(req, env, id)],

  ["GET", /^\/api\/admin\/services$/, (req, env) => admin.listServices(req, env)],
  ["GET", /^\/api\/admin\/tiers$/, (req, env) => admin.listTiers(req, env)],
  ["POST", /^\/api\/admin\/staff-links$/, (req, env) => admin.createStaffLink(req, env)],

  ["GET", /^\/api\/admin\/reports\/conversion$/, (req, env) => admin.reportConversion(req, env)],
  ["GET", /^\/api\/admin\/reports\/source-roi$/, (req, env) => admin.reportSourceRoi(req, env)],
];

const PORTAL_ROUTES = [
  ["GET", /^\/api\/portal\/([a-f0-9]+)$/, (req, env, link) => portal.getScopedEvent(req, env, link)],
  ["POST", /^\/api\/portal\/([a-f0-9]+)\/expenses$/, (req, env, link) => portal.submitExpense(req, env, link)],
  ["POST", /^\/api\/portal\/([a-f0-9]+)\/support$/, (req, env, link) => portal.submitSupportRequest(req, env, link)],
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // 1. Public lead capture — no auth, this is the form embedded on
    //    Instagram/website that replaces the Google Form.
    if (request.method === "POST" && pathname === "/api/leads/capture") {
      return captureLead(request, env).catch((e) => json({ error: String(e) }, { status: 500 }));
    }

    // 1b. Google Sign-In — public by nature (this IS the login flow).
    if (request.method === "GET" && pathname === "/auth/login") return startLogin(request, env);
    if (request.method === "GET" && pathname === "/auth/callback") return handleCallback(request, env);
    if (pathname === "/auth/logout") return logout();

    // 2. Photographer portal API — token in the URL is the credential.
    for (const [method, regex, handler] of PORTAL_ROUTES) {
      if (request.method !== method) continue;
      const m = pathname.match(regex);
      if (!m) continue;
      const link = await requireEventLink(env, m[1]);
      if (!link) return unauthorized("invalid or expired link");
      return handler(request, env, link).catch((e) => json({ error: String(e) }, { status: 500 }));
    }

    // 3. Admin API — gated by the Google Sign-In session cookie. Fails
    //    closed: no valid cookie, no data, regardless of anything else.
    if (pathname.startsWith("/api/admin/")) {
      const staff = await requireStaff(request, env);
      if (!staff) return unauthorized("staff login required — visit /auth/login");
      for (const [method, regex, handler] of ADMIN_ROUTES) {
        if (request.method !== method) continue;
        const m = pathname.match(regex);
        if (!m) continue;
        return handler(request, env, staff, m.slice(1)).catch((e) => json({ error: String(e) }, { status: 500 }));
      }
      return notFound("no matching admin route");
    }

    // 4. Portal page shell — /portal/<token> is a dynamic path, so it never
    //    matches a static asset; serve the portal app's HTML directly.
    if (pathname.startsWith("/portal/")) {
      return env.ASSETS.fetch(new URL("/portal/index.html", url));
    }

    // 5. Admin app shell — same reasoning for any /admin/... deep link, but
    //    also bounce straight to Google sign-in if there's no valid session
    //    yet, rather than showing a blank/broken app.
    if (pathname.startsWith("/admin")) {
      const staff = await requireStaff(request, env);
      if (!staff) return Response.redirect(`${url.origin}/auth/login`, 302);
      return env.ASSETS.fetch(new URL("/admin/index.html", url));
    }

    // 6. Everything else — static files, including the public root page
    //    (the lead capture landing page) — served directly by the assets
    //    binding, no Worker code runs for these.
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },
};
