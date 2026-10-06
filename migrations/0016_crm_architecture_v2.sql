-- CRM architecture v2 foundation
-- Phase 1: package/service configuration, quote engagement, event commercial snapshot,
-- checklist phases, invoice foundation and multi-tenant-ready tenant registry.
-- Backward-compatible: existing Booking tables are retained for historical data,
-- but new accepted quotes no longer require a Booking record.

CREATE TABLE IF NOT EXISTS crm_tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO crm_tenants(id,tenant_key,name) VALUES (1,'paperclip','Paperclip Studios');

-- Service operational metadata. Catalog remains reusable configuration.
ALTER TABLE services ADD COLUMN internal_code TEXT;
ALTER TABLE services ADD COLUMN resource_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE services ADD COLUMN description TEXT;
ALTER TABLE services ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE services ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_services_internal_code
  ON services(internal_code) WHERE internal_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_services_active_sort
  ON services(active, sort_order, id);

CREATE TABLE IF NOT EXISTS service_skills (
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY(service_id, skill_id)
);
CREATE INDEX IF NOT EXISTS idx_service_skills_skill ON service_skills(skill_id);

ALTER TABLE packages ADD COLUMN internal_code TEXT;
ALTER TABLE packages ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_packages_internal_code
  ON packages(internal_code) WHERE internal_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_packages_active_sort
  ON packages(active, sort_order, id);

-- Checklist is an operational control board, grouped into the three agreed phases.
ALTER TABLE checklist_templates ADD COLUMN phase TEXT NOT NULL DEFAULT 'Pre-Production';
ALTER TABLE checklist_templates ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE event_checklist ADD COLUMN phase TEXT NOT NULL DEFAULT 'Pre-Production';
ALTER TABLE event_checklist ADD COLUMN template_id INTEGER REFERENCES checklist_templates(id);

CREATE INDEX IF NOT EXISTS idx_checklist_templates_phase
  ON checklist_templates(active, phase, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_event_checklist_phase
  ON event_checklist(event_id, phase, done, id);

-- Meaningful quote engagement only. No scroll/mouse/keystroke telemetry.
CREATE TABLE IF NOT EXISTS quote_engagement_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id INTEGER NOT NULL REFERENCES lead_quotes(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'quote_opened',
      'package_viewed',
      'package_expanded',
      'service_viewed',
      'addon_viewed',
      'package_selected',
      'service_selected',
      'addon_selected'
    )
  ),
  quote_item_id INTEGER REFERENCES quote_items(id) ON DELETE SET NULL,
  package_id INTEGER REFERENCES packages(id) ON DELETE SET NULL,
  service_id INTEGER REFERENCES services(id) ON DELETE SET NULL,
  session_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_quote_engagement_quote_time
  ON quote_engagement_events(quote_id, created_at);
CREATE INDEX IF NOT EXISTS idx_quote_engagement_quote_type
  ON quote_engagement_events(quote_id, event_type);

ALTER TABLE quote_views ADD COLUMN session_key TEXT;
CREATE INDEX IF NOT EXISTS idx_quote_views_quote_time
  ON quote_views(quote_id, viewed_at);

-- Accepted quote -> Event keeps a historical commercial snapshot.
ALTER TABLE events ADD COLUMN quote_id INTEGER REFERENCES lead_quotes(id);
ALTER TABLE events ADD COLUMN quote_snapshot_json TEXT;
ALTER TABLE events ADD COLUMN commercial_finalized_at TEXT;
CREATE INDEX IF NOT EXISTS idx_events_quote ON events(quote_id);

-- Event payment schedule is already supported by the legacy event-level model.
-- Invoice is a financial document tied to the Event, not a separate workflow object.
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  invoice_number TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'Draft',
  issued_at TEXT,
  paid_at TEXT,
  total_amount INTEGER NOT NULL DEFAULT 0,
  snapshot_json TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  locked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invoices_event ON invoices(event_id, status);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status, issued_at);

-- Explicitly mark the Booking workflow as legacy. Existing records remain intact.
INSERT OR IGNORE INTO crm_business_rules(
  rule_key,label,description,category,value_json
) VALUES (
  'architecture.accepted_quote.create_event',
  'Create Event From Accepted Quote',
  'Accepted quotes create the Client relationship and one operational Event directly. Booking is legacy only.',
  'Architecture',
  '{"enabled":true,"default_one_event":true}'
);

INSERT OR IGNORE INTO crm_business_rules(
  rule_key,label,description,category,value_json
) VALUES (
  'quote.engagement.meaningful_only',
  'Track Meaningful Quote Engagement',
  'Track quote/package/service interactions only. Do not collect scrolling, mouse movement or keystroke telemetry.',
  'Sales',
  '{"enabled":true}'
);

INSERT OR IGNORE INTO crm_business_rules(
  rule_key,label,description,category,value_json
) VALUES (
  'event.invoice.lock_on_completion',
  'Lock Invoice On Event Completion',
  'Invoices become locked when an Event is completed; corrections use controlled revision/cancellation.',
  'Finance',
  '{"enabled":true}'
);

-- Seed phase metadata for the existing checklist template.
UPDATE checklist_templates
SET phase='Pre-Production'
WHERE phase IS NULL OR phase='';

-- Future tenant isolation is implemented only when request/auth context is available.
-- Do not infer a tenant from user input or leave cross-tenant filtering implicit.
