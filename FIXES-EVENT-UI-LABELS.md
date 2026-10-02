# Paperclip CRM — Event UI & Configurable Labels Fix

## Fixed

1. Event detail is now split into tabs:
   - Overview
   - Resources
   - Production
   - Post-Production
   - Services & Quote
   - Payments
   - Expenses
   - Deliverables
   - Checklist

2. Event Resources are connected to the existing `event_resource_allocations` table and can be allocated/deleted from the Event page.

3. Resource allocation cost is included in the Event cost/profit calculation.

4. Post-Production workflow displays the configured `post_production_timeline` picklist values, with the supplied timeline as a safe UI fallback.

5. Configurable labels are now wired end-to-end:
   Settings -> D1 `app_labels` -> `/api/admin/config` / `/api/admin/labels` -> UI.

6. Navigation labels and Event tab labels use the configured values where their keys exist, with safe fallbacks.

7. Settings now provides a label editor and resource management entry point.

8. The config/resource API routes are registered in `src/index.js`.

9. `npm` scripts use `npx wrangler`, avoiding the Windows `'wrangler' is not recognized` problem when Wrangler is available through npx.

## No new migration is required for these frontend/API fixes.

The Production D1 already contains the Resource configuration tables, as verified separately. Do not apply a new migration solely for these UI changes.

## Deployment

After copying these files into the working branch and testing locally:

```bat
npm install
npm run dev
```

Then commit/push/PR as normal. After merging to `main`:

```bat
npm run deploy
```

`npm run deploy` now invokes `npx wrangler deploy`.
