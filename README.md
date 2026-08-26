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

## Operations layer — resourcing, real cost/profit, payments, checklists, tasks (added after go-live)

The biggest addition yet, shipped in `migrations/0003_operations.sql`. Every
piece is additive — nothing about auth, packages, or contacts changed.

- **Vendors / procurement** — new **Vendors** tab. This is the "are we using
  our own people or procuring outside" split you asked for: `staff` +
  `event_staff_links` (now with a `role` and `cost` field) is your own team;
  the new `vendors` + `event_vendors` tables are everyone else you pay per
  event — catering, decoration, drone/equipment rental, a partner studio you
  collaborate with on a shoot. Each has its own cost and paid/unpaid status
  against the event.
- **Real event cost & profit** — every event now shows Revenue / Real cost /
  Profit at the top. Real cost = internal staff cost + outside vendor cost +
  reimbursed field expenses (the existing photographer expense submissions)
  — not just what was quoted. This is genuinely new: before this, you could
  see what you billed, not what you made.
- **Payment schedule** — since you confirmed there's no fixed split, this is
  fully manual per event: add installments with a label, amount, and due
  date ("Advance", "Before event", "On delivery", or anything custom), mark
  each paid when it lands. The existing payment ledger (`payments`) still
  records every actual rupee received — the schedule is just the plan.
- **Deliverables** — track album/video production status per event: Not
  started → In progress → Client review → Delivered. This is the "is the
  album pending" answer, per event, not something you have to remember.
- **Pre-event checklist** — one shared checklist (edit the template via the
  `checklist-templates` API for now — no dedicated tab yet, see below)
  snapshotted onto every new event when it's created. The dashboard flags
  any event in the next 7 days that still has incomplete items, and each
  event's detail page shows a live ready/not-ready count.
- **Staff tasks** — assign a task to a specific staff member (or leave it
  unassigned for "anyone on this event") from the event detail page. They
  see and update their own tasks through their existing tokenized portal
  link — no new login system. A staff member can only mark their *own*
  assigned tasks done; the server checks this server-side, not just in the UI.
- **Reports tab** — profitability per event (revenue, real cost, profit,
  margin %) and a trailing 6-month revenue/cost/profit rollup by month —
  this is where "3-month sales," "turnover," and "running profit" live now.
- **Dashboard drill-down** — the KPI tiles (New leads 7d / Today's
  follow-ups / Overdue) are now clickable and take you straight to a
  filtered Leads list instead of just being a number. The dashboard also
  now shows events in the next 7 days with their checklist status, and any
  payment installments due in the next 3 days.
- **Lead editing** — an Edit button on the lead detail page lets you fix a
  captured name/phone/email/event type/date/budget directly, separate from
  moving its pipeline stage.

One honest limitation, not hidden: the checklist template itself (the 6
default items) has no dedicated admin-console tab yet — the API exists
(`GET/POST /api/admin/checklist-templates`, `POST
/api/admin/checklist-templates/:id/remove`) but editing it today means a
couple of API calls, not a form. Say the word if you want that wired into
the UI next; I left it out of this batch to ship the rest sooner rather
than let one more screen hold up everything else.

## Embedding the lead capture form

The public form at `/` replaces the Google Form. It's a 3-step wizard now
(event details → budget → contact info) instead of one long page —
progressive disclosure like this measurably reduces abandonment on mobile,
which is most of your Instagram traffic. Contact info (the highest-friction
field) is asked last, after the visitor's already invested effort on the
easier questions.

Link to it with a `?src=` parameter so the source column fills in correctly:

- Instagram bio link: `https://pcs--prod.pcstudios.workers.dev/?src=instagram`
- WhatsApp broadcast/status: `.../?src=whatsapp`
- Facebook ad destination URL: `.../?src=facebook`
- Shared by an existing client: `.../?src=referral` — this one additionally
  reveals a "Who referred you?" field, so referral leads are traceable

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

## UI overhaul — premium mobile-first redesign (added after go-live)

A full visual and interaction redesign across all three surfaces (admin
console, public lead form, photographer portal) — no backend/schema changes,
purely presentation. Triggered by the operations layer above making the
admin console's screens (especially event detail) too cluttered with
always-visible inline forms.

- **New design-token palette** — replaced the old flat purple scheme with a
  warm "premium photography brand" palette (ink/paper/brass-accent, plus
  success/warning/critical semantic colors) defined once as CSS custom
  properties (`:root` in each file's `<style>` block) and reused everywhere,
  so a future palette tweak is a one-line change per file, not a find/replace.
- **Admin console — forms moved off the page, into modals.** Every screen
  that used to show a permanent inline "Add ___" form now shows a **+ Add**
  button (in the card header, or a floating action button for a view's one
  primary action) that opens a bottom-sheet modal — full-screen-feeling on
  mobile, centered dialog on desktop. This is the single biggest change:
  event detail alone used to show 5 forms at once whether you needed them
  or not; now it shows your data first, with 6 individual + Add affordances
  in place of that wall of inputs. Toast notifications confirm every save
  (bottom-center, auto-dismiss) instead of a full page reload/silence.
- **Genuine mobile responsiveness, not just "doesn't break."** The sidebar
  nav becomes a sticky horizontal-scroll bar under 820px; the two-column
  KPI/grid layouts (`.row2`, `.kpis`) that had **no mobile fallback before**
  — a real pre-existing bug — now stack to one column under 640px. Verified
  at both desktop (1280px) and mobile (390px) viewports via Playwright.
- **Progress bars** on the two "how close are we" numbers that matter most:
  pre-event checklist completion, and payment received-vs-total on the
  event's payment schedule card.
- **Public lead form & photographer portal** — same palette applied for
  brand consistency, plus a small serif/sans font pairing (Fraunces for
  headings, Inter for body — loaded from Google Fonts, standard practice for
  a public-facing site) for a more premium, editorial feel than the
  previous single-typeface look. The lead form's 3-step wizard and the
  portal's inline expense/support/task forms were left structurally as-is —
  the portal in particular is a one-handed, in-the-field, single-purpose
  page for a photographer mid-shoot, where the modal pattern would add
  friction rather than remove it.

Nothing about auth, the API, or the database changed in this batch — it's a
pure front-end delivery, safe to deploy independently of any data concerns.

## Click-reduction + rename + free WhatsApp (added after go-live)

A competitive-research-driven pass, benchmarked against Bloom, HoneyBook,
Dubsado, Táve, Studio Ninja, Sprout Studio, Picsello, and ShootQ/Iris Works —
see the conversation for the full comparison. Backend additions only, no
schema changes; every new route follows the existing edit/delete-with-guard
pattern already used for leads.

- **Inline edit/delete everywhere a list exists** — the real ask behind
  "too many clicks": Leads, Customers/Accounts, Packages, Vendors, Contacts,
  and every event-detail sub-list (staff, vendors, payment schedule,
  deliverables, tasks) now have a ✎ edit and (where safe) a ✕ delete icon
  right in the row — no detour through a detail page just to fix a typo.
  This also closed a real pre-existing gap: Vendors, Contacts, and every
  event sub-list previously had **no edit or delete at all** — you could
  add but never correct or remove one.
- **Guardrails on the deletes that touch money or history**: a vendor can't
  be deleted while booked on an event (fix the event first); a paid
  installment can't be edited or deleted (correct it via the payments
  ledger instead — deleting a payment there properly reverses the event's
  `advance_paid`, unlike a straight row deletion would); a package delete
  is a soft delete (`active = 0`) so events that already applied it keep
  their booked price untouched.
- **"Accounts" renamed to "Customers / Accounts"** in the nav and every
  heading — cosmetic only, the API/database still say `account` throughout,
  so nothing else needed to change.
- **Free click-to-WhatsApp** — a 💬 button next to any phone number (lead
  detail, account detail, each contact) opens WhatsApp with a message
  pre-filled; a human still taps Send. Zero cost, zero setup, no Meta
  Business verification — deliberately chosen over the paid WhatsApp
  Business API (~₹0.115/utility message plus most providers' ₹1,000–2,500/
  month platform fee) to keep the zero-cost posture the rest of this build
  has held to throughout.
- **Sidebar gets a quiet photography motif** — a soft brass aperture-ring
  line-art watermark, low-opacity, no real photos involved (pending real
  portfolio shots to swap in later if wanted).

Deliberately **not** built this round, and why: contracts/e-signature, a
client-facing branded portal, and a Kanban pipeline view were all flagged
as the biggest remaining gaps vs. the competitive set above, but each is
new database surface, not a UI tweak — worth doing once, not rushed
alongside a click-reduction pass. Same reasoning applies to paid WhatsApp
automation and real gallery-delivery storage (both have ongoing costs that
deserve their own explicit go-ahead, not a default).

## Events tab + responsive primary action (added after go-live)

Direct response to feedback that the previous batch's FAB was easy to miss
on desktop, and that there was no way to see events by date range. Root
cause was architectural, not cosmetic: there was no top-level Events view
at all (events only existed inside an Account drill-down or unfiltered in
Reports), and the FAB — a mobile convention — was the only "add" affordance
on every screen, desktop included.

- **New `GET /api/admin/events`** — every event, joined with account name,
  status, and balance due, computed server-side (`adminRoutes.js`,
  `listEvents`). Accepts `?range=this_week|last_week|next_week|this_month|
  next_month|custom|all`; `custom` requires `&from=&to=` (`YYYY-MM-DD`).
  Week bounds are Monday–Sunday, computed in JS (not SQL date modifiers) so
  "this week" means the same thing regardless of engine defaults. An
  unrecognized `range`, or `custom` missing a bound, returns 400.
- **New "Events" nav tab** — a real list view with a segmented quick-filter
  bar (All / This week / Last week / Next week / This month / Next month /
  Custom range), a status pill per row, and a "Payment overdue" flag
  (derived from any `payment_schedule` row past its due date and still
  Pending) so a payment problem is visible without opening the event.
  "+ New event" here includes a customer picker, since this list isn't
  scoped to one account the way the in-account "New event" flow is.
- **Responsive primary action, applied everywhere the FAB existed** (Leads,
  Customers/Accounts → event creation, Packages, Vendors, and the new
  Events tab): at ≥820px a labeled button sits in the page header, next to
  the title, always visible, never scrolled out of view; below 820px it
  reverts to the FAB, which is the correct convention there. One handler,
  two renderings (`setPrimaryAction()` in `admin/index.html`) — no
  per-screen breakpoint logic to maintain going forward.
- **Fixed a latent status-pill coloring bug** found while building this:
  multi-word statuses ("In progress", "Client review") weren't getting
  their color class because the old code only stripped whitespace instead
  of matching the CSS's PascalCase names — now `In progress` correctly
  reads as the in-progress accent color instead of falling back to
  unstyled.

Deliberately **not** built this round: a calendar/month-grid view and
drag-to-reschedule. The list + quick-filters covers the stated need ("what's
coming up this week/month") without the extra surface area of a full
calendar component — worth adding later only if list view proves
insufficient in practice.

## Local development (optional)

Not required — everything ships through GitHub Actions. If you want to run
it on your own machine later: install Node.js, then `npx wrangler dev`
(prompts a one-time Cloudflare login) runs the app locally against a local
copy of the D1 schema.
