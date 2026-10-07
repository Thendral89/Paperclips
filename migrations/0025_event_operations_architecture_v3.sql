-- Event Operations Architecture v3
-- Turns the approved Event design into the canonical operational model.
-- Additive/backward-compatible: legacy fields and Booking records remain intact.

-- 1) Event identity uses an explicit start/end date window.
ALTER TABLE events ADD COLUMN start_date TEXT;
ALTER TABLE events ADD COLUMN end_date TEXT;

UPDATE events
SET start_date = COALESCE(start_date,event_date),
    end_date = COALESCE(end_date,event_date)
WHERE start_date IS NULL OR end_date IS NULL;

CREATE INDEX IF NOT EXISTS idx_events_date_window ON events(start_date,end_date,status);

-- 2) Skills are the source of operational timing and default cost.
ALTER TABLE skills ADD COLUMN workflow_phase TEXT NOT NULL DEFAULT 'Post-Production';
ALTER TABLE skills ADD COLUMN start_offset_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE skills ADD COLUMN due_offset_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE skills ADD COLUMN default_cost INTEGER NOT NULL DEFAULT 0;

UPDATE skills
SET workflow_phase=CASE
  WHEN lower(label) LIKE '%photograph%' OR lower(label) LIKE '%videograph%' OR lower(label) LIKE '%drone%' THEN 'Production'
  ELSE 'Post-Production'
END
WHERE workflow_phase IS NULL OR workflow_phase='';

-- 3) Resource-specific skill cost overrides.
CREATE TABLE IF NOT EXISTS resource_skill_costs (
  resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  cost INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(resource_id,skill_id)
);
CREATE INDEX IF NOT EXISTS idx_resource_skill_costs_skill
  ON resource_skill_costs(skill_id);

-- 4) Allocation records are the canonical operational work records.
ALTER TABLE event_resource_allocations ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'));
ALTER TABLE event_resource_allocations ADD COLUMN start_source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE event_resource_allocations ADD COLUMN due_source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE event_resource_allocations ADD COLUMN generated_from_skill INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_event_allocations_window
  ON event_resource_allocations(event_id,phase,start_at,end_at);

-- 5) Every meaningful allocation change gets an immutable history record.
CREATE TABLE IF NOT EXISTS event_resource_allocation_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  allocation_id INTEGER NOT NULL REFERENCES event_resource_allocations(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  field_name TEXT,
  old_value TEXT,
  new_value TEXT,
  reason TEXT,
  note TEXT,
  changed_by TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_allocation_history_allocation
  ON event_resource_allocation_history(allocation_id,changed_at);
CREATE INDEX IF NOT EXISTS idx_allocation_history_event
  ON event_resource_allocation_history(event_id,changed_at);

-- 6) Checklist templates can optionally target a Service or Skill.
ALTER TABLE event_checklist ADD COLUMN generated_source TEXT;
CREATE INDEX IF NOT EXISTS idx_event_checklist_generated ON event_checklist(event_id,generated_source);
ALTER TABLE checklist_templates ADD COLUMN service_id INTEGER REFERENCES services(id) ON DELETE SET NULL;
ALTER TABLE checklist_templates ADD COLUMN skill_id INTEGER REFERENCES skills(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_checklist_templates_service_skill
  ON checklist_templates(service_id,skill_id,active,sort_order);

-- 7) Normalize legacy resource terminology into the approved Internal/External model.
UPDATE resources SET resource_type='Internal'
WHERE lower(trim(resource_type)) IN ('person','staff','employee','internal');

UPDATE resources SET resource_type='External'
WHERE lower(trim(resource_type)) IN ('vendor','external','equipment / vendor','equipment/vendor');

INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'internal','Internal',30,1 FROM picklist_groups WHERE group_key='resource_type';

INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'external','External',40,1 FROM picklist_groups WHERE group_key='resource_type';

-- Keep old values readable for historical data, but stop presenting them as the preferred model.
UPDATE picklist_values
SET active=0
WHERE group_id=(SELECT id FROM picklist_groups WHERE group_key='resource_type')
  AND lower(value_label) IN ('person','vendor','equipment / vendor');

-- 8) Normalize legacy checklist vocabulary.
UPDATE checklist_templates SET phase='Pre-Production' WHERE phase IN ('Pre-wedding','Pre Wedding');
UPDATE checklist_templates SET phase='Production' WHERE phase IN ('Wedding day','Wedding Day');
UPDATE checklist_templates SET phase='Post-Production' WHERE phase IN ('Post-wedding','Post Wedding');

UPDATE event_checklist SET phase='Pre-Production' WHERE phase IN ('Pre-wedding','Pre Wedding');
UPDATE event_checklist SET phase='Production' WHERE phase IN ('Wedding day','Wedding Day');
UPDATE event_checklist SET phase='Post-Production' WHERE phase IN ('Post-wedding','Post Wedding');

-- 9) Normalize legacy Event status values.
UPDATE events SET status='Pending' WHERE lower(trim(status)) IN ('planned','pending');
UPDATE events SET status='In-Progress' WHERE lower(trim(status)) IN ('in progress','in-progress');
UPDATE events SET status='Completed' WHERE lower(trim(status)) IN ('delivered','completed');
UPDATE events SET status='Cancelled' WHERE lower(trim(status))='cancelled';
UPDATE events SET status='Planning' WHERE lower(trim(status))='planning';

-- 10) Existing allocation timestamps are preserved; mark them as manual because
-- the old system did not retain a reliable generated/manual source flag.
UPDATE event_resource_allocations
SET start_source=CASE WHEN start_at IS NOT NULL THEN 'manual' ELSE start_source END,
    due_source=CASE WHEN end_at IS NOT NULL THEN 'manual' ELSE due_source END,
    updated_at=COALESCE(updated_at,created_at,datetime('now'))
WHERE generated_from_skill=0;

-- 11) Existing allocation costs remain authoritative historical values.
-- New allocations will use Resource Skill Cost -> Skill Default Cost -> 0.
