# Paperclip Studios — CRM

Lead management → account conversion → event/pricing → field-staff access, on
Cloudflare Workers (one Worker serves the frontend and the API) + D1. Full
design reasoning lives in the architecture blueprint shared separately in
your Claude conversation — this README is just the "get it running" steps.

## What's already done

- D1 database created: `paperclip-crm` (id `77c26211-5130-48cf-b100-c5b2ce957fd9`)
- Worker subdomain claimed: `pcstudios.workers.dev`
- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` added as GitHub repo secrets

## What's left — two steps

### 1. Push this code, then push again

The first push to `main` runs `.github/workflows/deploy.yml`, which applies
`migrations/0001_init.sql` to your D1 database and deploys the Worker. Check
the **Actions** tab on GitHub to watch it run. Once green, the app is live at:

- Public lead form: `https://pcs--prod.pcstudios.workers.dev/`
- Admin console: `https://pcs--prod.pcstudios.workers.dev/admin`

### 2. Lock down `/admin` with Cloudflare Access — do this before sharing the link

Right now `/admin` and `/api/admin/*` will refuse every request (they fail
closed with a 401 if there's no `Cf-Access-Authenticated-User-Email` header —
see `src/lib/auth.js`). That's deliberate: the app is safe by default, but
useless to your team until Access is switched on in front of it. Steps:

1. Cloudflare dashboard → **Zero Trust** → **Access** → **Applications** → **Add an application** → **Self-hosted**.
2. Domain: `pcs--prod.pcstudios.workers.dev`, path: `/admin*` (and a second application, or an additional path rule, for `/api/admin*`).
3. Add a policy: **Allow**, rule type **Emails**, list your team's email addresses (the ones in `wrangler.jsonc`'s `STAFF_EMAILS`, or whoever should have access — Access enforces the real login, that var is just a UI label).
4. Save. Cloudflare Access is free for up to 50 users, so this costs nothing.

Once that's live, visiting `/admin` prompts a one-time-code email login before
anything loads — no passwords for you to manage.

## Embedding the lead capture form

The public form at `/` replaces the Google Form. Link to it with a `?src=`
parameter so the source column fills in correctly:

- Instagram bio link: `https://pcs--prod.pcstudios.workers.dev/?src=instagram`
- WhatsApp broadcast/status: `.../?src=whatsapp`
- Facebook ad destination URL: `.../?src=facebook`

No `?src=` at all defaults to "Website."

## Generating a photographer's event link

From the admin console: **Accounts → an account → an event → Field staff
access → Generate link**. Copy the resulting URL and send it directly —
that link is the only credential needed; there's no login for them.

## Two things intentionally left as stubs

Both are coded up to the point where they need a credential you haven't
given me — rather than fake them, they're clearly marked `TODO` so nothing
pretends to work when it doesn't:

- **Calendar sync** (`src/routes/adminRoutes.js`, `setFollowUp`) — once you
  can share a Google service account with access to the "Paperclip Studios
  CRM Sync" calendar (or its calendar ID + OAuth client), I'll wire this in
  as a couple of `fetch()` calls to the Calendar API.
- **Booked-confirmation email / 48h stale-lead alert email** — the Cron
  Trigger (`src/cron.js`) already flags stale leads hourly and they surface
  on the dashboard's Overdue list; sending an actual email needs a Resend
  API key (free tier, 3,000 emails/month) added as one more GitHub secret.

## Local development (optional)

Not required — everything ships through GitHub Actions. If you want to run
it on your own machine later: install Node.js, then `npx wrangler dev`
(prompts a one-time Cloudflare login) runs the app locally against a local
copy of the D1 schema.
