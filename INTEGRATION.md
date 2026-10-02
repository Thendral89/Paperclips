# Integration into the existing Paperclip CRM

The supplied codebase currently has:
- a hand-rolled `ADMIN_ROUTES` table in `src/index.js`;
- an existing `settings` API in `src/routes/adminRoutes.js`;
- a legacy `vendors` table used for outside procurement;
- `event_vendors` for event procurement;
- `services`, `packages`, `package_items`, and quote items;
- event detail already aggregates services, payments, staff links, vendors, expenses, equipment and tasks.
These are extended rather than removed.

## 1. Add migration
Save the SQL as the next migration, for example:
`migrations/0009_resource_configuration.sql`

Then:
`npx wrangler d1 migrations apply DB --remote`

Use the actual D1 binding/migration command already used by this repository if its database name differs.

## 2. Add route module
Save:
`src/routes/configRoutes.js`

Then in `src/index.js` add:
`import * as config from "./routes/configRoutes.js";`

Add these routes inside ADMIN_ROUTES:
```js
["GET", /^\/api\/admin\/config$/, (req, env) => config.getConfig(req, env)],
["GET", /^\/api\/admin\/labels$/, (req, env) => config.listLabels(req, env)],
["POST", /^\/api\/admin\/labels$/, (req, env, staff) => config.updateLabel(req, env, staff)],
["GET", /^\/api\/admin\/picklists$/, (req, env) => config.listPicklists(req, env)],
["POST", /^\/api\/admin\/picklists\/values$/, (req, env) => config.upsertPicklistValue(req, env)],
["POST", /^\/api\/admin\/picklists\/values\/(\d+)\/delete$/, (req, env, staff, [id]) => config.deletePicklistValue(req, env, id)],
["GET", /^\/api\/admin\/resources$/, (req, env) => config.listResources(req, env)],
["POST", /^\/api\/admin\/resources$/, (req, env) => config.saveResource(req, env)],
["POST", /^\/api\/admin\/resources\/(\d+)\/delete$/, (req, env, staff, [id]) => config.deleteResource(req, env, id)],
["GET", /^\/api\/admin\/events\/(\d+)\/resources$/, (req, env, staff, [id]) => config.listEventResources(req, env, id)],
["POST", /^\/api\/admin\/events\/(\d+)\/resources$/, (req, env, staff, [id]) => config.saveEventResource(req, env, id)],
["POST", /^\/api\/admin\/event-resources\/(\d+)\/delete$/, (req, env, staff, [id]) => config.deleteEventResource(req, env, id)],
["GET", /^\/api\/admin\/events\/(\d+)\/expenses$/, (req, env, staff, [id]) => config.listEventExpenses(req, env, id)],
```

## 3. Resource UI
The current `renderVendors()` in `public/admin/index.html` is a procurement/vendor screen. Replace its navigation presentation with a Resources screen backed by `/resources`.

Do NOT delete the legacy `/vendors` APIs yet: existing event procurement rows use `vendors/event_vendors` and must continue to work.

The Resources screen should show:
- Name
- Phase(s)
- Skills
- Active/inactive
- Edit
- Deactivate

The edit modal must use a multi-select checkbox list loaded from `/config` or `/picklists`.

## 4. Admin Settings
Add a `Settings` nav item:
```html
<div class="navlink" data-view="settings">Settings</div>
```

Add to `render()`:
```js
if (state.view === "settings") return renderSettings();
```

Settings tabs:
- Labels
- Picklists
- Resources
- Services & Packages
- Event Workflow
- WhatsApp

Labels are stored by internal key, so changing `nav.accounts` to `Clients` never changes routes or database entity names.

## 5. Event page
Keep the existing event summary at the top. Add a tab strip underneath it:
- Overview
- Services & Quote
- Resources
- Production
- Post-Production
- Payments
- Expenses
- Deliverables

The Overview tab is the frozen/core event information:
client, event type, date, venue, status, quote total, received, balance.

Resources tab calls:
`GET /api/admin/events/:id/resources`

Add allocation with:
- phase
- resource
- skill
- event role
- cost
- status
- notes

Because `resource_phase_assignments` and `resource_skills` are many-to-many, the same person can appear in multiple phases and can have multiple skills.

## 6. Event expense identity
When an expense is created against an event, call `hydrateEventExpenseMeta(env, expenseId)` after the existing insert.

The generated event code is:
`EV-000123-Client-Name-2026-12-20`

This is display/reporting metadata. `event_id` remains the authoritative foreign key.

## 7. Quote WhatsApp
The current `sendQuote()` changes quote status and returns `public_url`. Keep that behavior.

For the UI, add:
```js
function quoteWhatsAppLink(phone, publicUrl, name) {
  const digits = String(phone || "").replace(/\D/g, "");
  const normalized = digits.length === 10 ? `91${digits}` : digits;
  if (!normalized) return null;
  const msg = `Hi${name ? ` ${name}` : ""}, this is Paperclip Studios. Your quotation is ready: ${publicUrl}`;
  return `https://wa.me/${normalized}?text=${encodeURIComponent(msg)}`;
}
```

Add a `Send on WhatsApp` button next to the quote public URL. This opens WhatsApp with the message ready; staff presses Send.

For a fully automatic API send, use Meta's official WhatsApp Cloud API later. Do not make it a required dependency for this CRM.

## 8. Service/package catalog
The existing code already has:
- `services`
- `packages`
- `package_items`
- quote items
- event services

Use those as the catalog. Do not create a second quote engine.

The PDF supplied by the user documents:
Basic ₹75,000; Standard ₹1,10,000; Classic ₹1,60,000; Premium ₹2,20,000; Exclusive ₹3,10,000, plus the listed crew/deliverables and additional services.
