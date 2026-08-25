# Paperclip Studios — CRM

Lead management → account conversion → event/pricing → field-staff access, on
Cloudflare Workers (one Worker serves the frontend and the API) + D1. Full
design reasoning lives in the architecture blueprint shared separately in
your Claude conversation — this README is just the "get it running" steps.

## What's already done

- D1 database created: `paperclip-crm` (id `77c26211-5130-48cf-b100-c5b2ce957fd9`)
- Worker subdomain claimed: `pcstudios.workers.dev`
- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` added as GitHub repo secrets

## Admin login: Google Sign-In (not Cloudflare Access)

Cloudflare Access needs a card on file even on its free tier — for a
2-person admin team that's not worth it, so `/admin` is gated by a
hand-rolled Google Sign-In instead: no Cloudflare subscription, no card,
reuses the Google accounts you already have. Code lives in
`src/routes/authRoutes.js` + `src/lib/session.js`; the access rule is
`STAFF_EMAILS` in `wrangler.jsonc` — only those exact emails can sign in.

### 1. Create a Google OAuth Client ID (free, no card)

1. [console.cloud.google.com](https://console.cloud.google.com) → create a project (or use an existing one) → search **Google Auth Platform** in the top search bar (this replaced the old "OAuth consent screen" page). Fill in **Branding** (App name, support email, developer contact email — everything else is optional), then on **Audience** pick **External** and add your 2 staff emails as **Test users** (unpublished apps only allow signed-in test users — exactly the restriction you want).
2. **Clients** tab → **Create client** → Application type **Web application**.
3. **Authorized redirect URIs** → add exactly: `https://pcs--prod.pcstudios.workers.dev/auth/callback`
4. Create. Copy the **Client ID** and **Client secret** shown.

### 2. Fill in the Client ID (not secret — safe to commit)

Edit `wrangler.jsonc` in the repo, replace the two placeholders:
```jsonc
"STAFF_EMAILS": "teampaperclipstudios@gmail.com,REPLACE_WITH_SECOND_ADMIN_EMAIL@gmail.com",
"GOOGLE_CLIENT_ID": "REPLACE_ME.apps.googleusercontent.com"
```
with your real second admin email and the Client ID from step 1.3.

### 3. Add two more GitHub secrets (these ARE sensitive)

Same place as before — repo **Settings → Secrets and variables → Actions**:

| Secret name | Value |
|---|---|
| `GOOGLE_CLIENT_SECRET` | the Client secret from step 1.4 |
| `SESSION_SECRET` | any random 32+ character string — e.g. run `openssl rand -hex 32` in a terminal, or use any password generator; this signs the login cookie, it's not shared with Google |

### 4. Push

Committing the `wrangler.jsonc` edit (and having the two new secrets in
place) triggers the next deploy, which pushes `GOOGLE_CLIENT_SECRET` and
`SESSION_SECRET` into the Worker as real Cloudflare secrets (see
`deploy.yml` — `wrangler secret put`, not committed to the repo). After
that run goes green, visiting `/admin` redirects to a real Google sign-in
screen, and only the two emails in `STAFF_EMAILS` can get past it.

## Product catalog, contacts, loss reasons (added after go-live)

Three additions on top of the original build, all shipped in
`migrations/0002_catalog_contacts.sql` — pure additions, nothing about
Google Sign-In or the working auth flow changed:

- **Packages** — a new **Packages** tab in the admin console. Define a
  named bundle (e.g. "Gold Wedding Package") at its own bundle price —
  tag which services are included for reference (shows on the package
  card and on the event once applied), but the bundle price is whatever
  you set, not automatically the sum of the parts. On an event, click
  **Apply a package** to bill it as one line item, then keep adding
  a-la-carte extras from **Add-ons** exactly as before — packages and
  add-ons happily coexist on the same event and both feed the same
  quote total.
- **Contacts** — each account can now hold more than one contact (bride,
  groom, planner, parent...), each with their own phone/email and a role
  tag. The account's own phone/email field still exists and still shows
  in list views as the primary contact — Contacts is the *additional*
  people, not a replacement.
- **Lost reason** — moving a lead to the "Lost" stage now prompts for why
  (budget / date conflict / competitor / went silent / etc.) and refuses
  the change without one. Feeds real win/loss analytics later — right
  now it's stored and visible on the lead's detail page.

Deliberately **not** added (would be over-engineering at 2 admins):
per-post campaign-level ad attribution — channel-level source tracking
(Instagram/WhatsApp/Facebook/Referral/Website) stays as-is.

Pushing this update: same as any other change — commit, CI applies the
new migration automatically via `wrangler d1 migrations apply --remote`
(already wired in `deploy.yml`), no manual DB step needed.

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
