# Paperclip CRM — Resource, Settings, Service Catalogue & WhatsApp integration

This ZIP contains the existing Paperclip CRM source plus the Resource/Settings changes integrated into the actual project files.

## What is included

- `migrations/0009_resource_configuration.sql`
  - Resources and multi-skill mapping
  - Pre-Production / Production / Post-Production phase mapping
  - Event resource allocations
  - Event expense identity metadata
  - Configurable labels and picklists
  - Post-production timeline values
  - Additional service catalogue seed values
  - Package seed values from the supplied package information
- `src/routes/configRoutes.js`
  - Admin configuration APIs
  - Resource CRUD/deactivation
  - Skill/picklist management
  - Service catalogue CRUD
  - Event resource allocation
  - Event expense lookup
- `src/routes/adminRoutes.js`
  - Event detail now includes resource allocations
  - Resource costs are included in event cost/profit
  - Event expenses expose event identity
  - Quote sending returns a click-to-WhatsApp URL
  - Event expense create/update maintains event metadata
- `src/index.js`
  - Configuration/resource/service/event-resource routes registered in the existing admin router
- `public/admin/index.html`
  - Resources navigation
  - Settings navigation
  - Resource management screen
  - Settings tabs for Resources, Picklists, Labels, Services & Packages, Event Workflow and WhatsApp
  - Event resource allocation UI
  - Quote send opens the pre-filled WhatsApp link when a client phone is available

## Architecture decisions

### Resources vs Vendors

The existing `vendors` / `event_vendors` tables are retained because they represent outside procurement.

Internal people are stored separately in:

- `resources`
- `skills`
- `resource_skills`
- `resource_phase_assignments`
- `event_resource_allocations`

This avoids breaking existing procurement data.

### WhatsApp

The implementation deliberately uses a free click-to-WhatsApp flow:

1. Staff sends the quote from the CRM.
2. The CRM creates the public quote URL.
3. The CRM creates a `wa.me` URL with a pre-filled message.
4. WhatsApp opens on the staff device.
5. Staff reviews and presses Send.

No paid BSP is required for this flow. Automatic Cloud API sending is a separate integration and may incur Meta message charges.

Configured business number:
`7200457659`

## Deployment

First validate locally:

```bash
npm install
npx wrangler d1 migrations apply paperclip-crm --local
npm run dev
```

Then apply the migration to the production D1 database:

```bash
npx wrangler d1 migrations apply paperclip-crm --remote
```

Use the exact D1 database name/binding configured in `wrangler.jsonc` if it differs.

Then deploy:

```bash
npm run deploy
```

## Important

The migration intentionally does not rename or delete the legacy `vendors` table.

Aravind is seeded only in Pre-Production, matching the supplied resource list. His skills are Sales, Marketing, Candid Photographer, Candid Videographer and Drone Operator.

The package/service seed does not invent individual prices that were not specified in the supplied source material.
