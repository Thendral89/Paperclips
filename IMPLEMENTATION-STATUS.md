# Paperclip CRM — Implementation Status

This package contains the complete application source from the supplied ZIP with the Resource / Settings / Service Catalogue / Event Resource / WhatsApp changes integrated.

## Included

- Resource pool with the supplied people and skills.
- Pre-Production, Production and Post-Production phase mapping.
- Multi-skill resource assignments.
- Event resource allocation with phase, skill, role, cost, status and notes.
- Resource costs included in event cost/profit calculations.
- Event expenses tagged with event identity (`event_code`, client, date, type).
- Configurable labels and picklists.
- Configurable service catalogue.
- Settings sections for Resources, Picklists, Labels, Services & Packages, Event Workflow and WhatsApp.
- Quote send returns a click-to-WhatsApp link and logs delivery.
- Legacy external Vendor / Procurement tables and APIs are retained.
- WhatsApp uses the free `wa.me` click-to-send flow; it does not require a paid BSP.

## Validation performed

- All JavaScript files passed `node --check`.
- The admin inline JavaScript passed `node --check`.
- Migrations 0001 through 0009 were applied successfully to a temporary SQLite database.
- The resource seed was checked: Aravind is assigned only to Pre-Production and has Sales, Marketing, Candid Photographer, Candid Videographer and Drone Operator skills.

## Deployment

```bash
npm install
npx wrangler d1 migrations apply paperclip-crm --local
npm run dev
```

After local verification:

```bash
npx wrangler d1 migrations apply paperclip-crm --remote
npm run deploy
```

Use the exact D1 database name configured in `wrangler.jsonc` if it differs.

## Security

The `.git` directory is intentionally not included in this delivery ZIP. Reconnect this source tree to the existing Git repository before committing/deploying.
