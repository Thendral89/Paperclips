-- CRM finalization and operational controls
-- Additive only. Existing commercial/operational history remains intact.

ALTER TABLE accounts ADD COLUMN birth_date TEXT;
ALTER TABLE accounts ADD COLUMN anniversary_date TEXT;

ALTER TABLE event_services ADD COLUMN source_type TEXT NOT NULL DEFAULT 'quote';
ALTER TABLE event_services ADD COLUMN added_after_finalization INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_services ADD COLUMN source_quote_item_id INTEGER REFERENCES quote_items(id);

ALTER TABLE event_resource_allocations ADD COLUMN original_estimate INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_resource_allocations ADD COLUMN revised_estimate INTEGER;
ALTER TABLE event_resource_allocations ADD COLUMN actual_paid INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_resource_allocations ADD COLUMN payment_date TEXT;
ALTER TABLE event_resource_allocations ADD COLUMN cost_notes TEXT;
UPDATE event_resource_allocations SET original_estimate=COALESCE(cost,0) WHERE original_estimate=0;

CREATE INDEX IF NOT EXISTS idx_event_services_event_final
  ON event_services(event_id, added_after_finalization, id);
CREATE INDEX IF NOT EXISTS idx_accounts_dates
  ON accounts(anniversary_date, birth_date);
CREATE INDEX IF NOT EXISTS idx_resource_allocations_date
  ON event_resource_allocations(resource_id, allocation_date, start_time, end_time);

-- Preserve the old field as a historical compatibility field; new workflow
-- derives commercial value from finalized Quote/Event Service snapshots.
INSERT OR IGNORE INTO crm_business_rules(rule_key,label,description,category,value_json)
VALUES
 ('event.commercial.lock_after_quote','Lock Commercial Quote After Acceptance',
  'Accepted Quote creates a finalized commercial snapshot. Later additions are explicitly marked as post-finalization.',
  'Finance','{"enabled":true}'),
 ('event.resource.cost_history','Preserve Resource Cost History',
  'Original estimate is never overwritten; revised estimate and actual paid are stored separately.',
  'Resources','{"enabled":true}');