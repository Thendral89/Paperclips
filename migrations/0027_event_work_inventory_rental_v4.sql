-- Event Work + Inventory/Rental Operations v4
-- Canonical user flow remains Lead -> Quote -> Client -> Event.
-- Booking remains legacy/internal compatibility only.
-- Work is the operational allocation boundary: Service -> Skills -> Resources/Equipment -> Timeline.

-- 1) Event Type / Work configuration picklists.
INSERT OR IGNORE INTO picklist_groups(group_key,label,description,sort_order,active)
VALUES
 ('event_type','Event Type','Overall engagement type for an Event.',20,1),
 ('event_work_group','Work Group','Operational engagement grouping inside an Event.',21,1),
 ('event_work_phase','Work Phase','Execution phase for Work Items.',22,1),
 ('work_status','Work Status','Operational status for Work Items.',23,1),
 ('equipment_allocation_type','Equipment Allocation Type','How equipment is sourced for a Work Item.',24,1),
 ('equipment_status','Equipment Status','Lifecycle status for equipment inventory.',25,1),
 ('equipment_return_condition','Equipment Return Condition','Condition captured when rented equipment is returned.',26,1),
 ('allocation_override_reason','Allocation Override Reason','Reason required when normal skill/availability validation is overridden.',27,1);

INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'wedding','Wedding',10,1 FROM picklist_groups WHERE group_key='event_type';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'wedding-reception','Wedding + Reception (Combo 1)',20,1 FROM picklist_groups WHERE group_key='event_type';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'engagement','Engagement',30,1 FROM picklist_groups WHERE group_key='event_type';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'reception','Reception',40,1 FROM picklist_groups WHERE group_key='event_type';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'pre-wedding','Pre-Wedding',50,1 FROM picklist_groups WHERE group_key='event_type';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'post-wedding','Post-Wedding',60,1 FROM picklist_groups WHERE group_key='event_type';

INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'pre-wedding','Pre-Wedding',10,1 FROM picklist_groups WHERE group_key='event_work_group';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'wedding','Wedding',20,1 FROM picklist_groups WHERE group_key='event_work_group';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'reception','Reception',30,1 FROM picklist_groups WHERE group_key='event_work_group';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'post-wedding','Post-Wedding',40,1 FROM picklist_groups WHERE group_key='event_work_group';

INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'production','Production',10,1 FROM picklist_groups WHERE group_key='event_work_phase';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'post-production','Post-Production',20,1 FROM picklist_groups WHERE group_key='event_work_phase';

INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'not-started','Not Started',10,1 FROM picklist_groups WHERE group_key='work_status';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'assigned','Assigned',20,1 FROM picklist_groups WHERE group_key='work_status';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'in-progress','In Progress',30,1 FROM picklist_groups WHERE group_key='work_status';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'waiting','Waiting',40,1 FROM picklist_groups WHERE group_key='work_status';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'completed','Completed',50,1 FROM picklist_groups WHERE group_key='work_status';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'cancelled','Cancelled',60,1 FROM picklist_groups WHERE group_key='work_status';

INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'owned','Owned',10,1 FROM picklist_groups WHERE group_key='equipment_allocation_type';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'rented','Rented',20,1 FROM picklist_groups WHERE group_key='equipment_allocation_type';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'external','External / Other',30,1 FROM picklist_groups WHERE group_key='equipment_allocation_type';

INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'available','Available',10,1 FROM picklist_groups WHERE group_key='equipment_status';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'maintenance','Maintenance',20,1 FROM picklist_groups WHERE group_key='equipment_status';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'retired','Retired',30,1 FROM picklist_groups WHERE group_key='equipment_status';

INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'good','Good',10,1 FROM picklist_groups WHERE group_key='equipment_return_condition';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'damaged','Damaged',20,1 FROM picklist_groups WHERE group_key='equipment_return_condition';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'missing','Missing',30,1 FROM picklist_groups WHERE group_key='equipment_return_condition';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'other','Other',40,1 FROM picklist_groups WHERE group_key='equipment_return_condition';

INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'resource-unavailable','Resource unavailable',10,1 FROM picklist_groups WHERE group_key='allocation_override_reason';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'client-request','Client requested resource/equipment',20,1 FROM picklist_groups WHERE group_key='allocation_override_reason';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'emergency','Emergency replacement',30,1 FROM picklist_groups WHERE group_key='allocation_override_reason';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'skill-exception','Approved skill exception',40,1 FROM picklist_groups WHERE group_key='allocation_override_reason';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'external-vendor','External vendor',50,1 FROM picklist_groups WHERE group_key='allocation_override_reason';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'availability-conflict','Availability conflict',60,1 FROM picklist_groups WHERE group_key='allocation_override_reason';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'management-override','Management override',70,1 FROM picklist_groups WHERE group_key='allocation_override_reason';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'other','Other',80,1 FROM picklist_groups WHERE group_key='allocation_override_reason';

-- 2) Work Items are the single operational boundary for service/skill/resource/equipment/timeline.
CREATE TABLE IF NOT EXISTS event_work_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  work_group TEXT NOT NULL,
  phase TEXT NOT NULL,
  service_id INTEGER REFERENCES services(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  start_date TEXT,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'Not Started',
  notes TEXT,
  override_reason TEXT,
  override_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_event_work_event_group_phase
  ON event_work_items(event_id,work_group,phase,status,id);
CREATE INDEX IF NOT EXISTS idx_event_work_service
  ON event_work_items(service_id,event_id);

CREATE TABLE IF NOT EXISTS event_work_item_skills (
  work_item_id INTEGER NOT NULL REFERENCES event_work_items(id) ON DELETE CASCADE,
  skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY(work_item_id,skill_id)
);
CREATE INDEX IF NOT EXISTS idx_event_work_skills_skill
  ON event_work_item_skills(skill_id,work_item_id);

-- Optional configuration mapping for automatic Work generation.
CREATE TABLE IF NOT EXISTS service_work_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  event_type_key TEXT,
  work_group TEXT NOT NULL,
  phase TEXT NOT NULL,
  auto_create INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(service_id,event_type_key,work_group,phase)
);
CREATE INDEX IF NOT EXISTS idx_service_work_mappings_lookup
  ON service_work_mappings(service_id,event_type_key,active,sort_order);

-- 3) Existing resource allocations now optionally belong to a Work Item.
ALTER TABLE event_resource_allocations ADD COLUMN work_item_id INTEGER REFERENCES event_work_items(id) ON DELETE SET NULL;
ALTER TABLE event_resource_allocations ADD COLUMN override_reason TEXT;
ALTER TABLE event_resource_allocations ADD COLUMN override_note TEXT;
-- start_at/end_at already exist from migration 0020_resource_allocation_datetime.sql.
UPDATE event_resource_allocations SET start_at=COALESCE(start_at,CASE WHEN allocation_date IS NOT NULL AND start_time IS NOT NULL THEN allocation_date||'T'||start_time END), end_at=COALESCE(end_at,CASE WHEN allocation_date IS NOT NULL AND end_time IS NOT NULL THEN allocation_date||'T'||end_time END), original_estimate=COALESCE(original_estimate,cost,0), actual_paid=COALESCE(actual_paid,0) WHERE start_at IS NULL OR end_at IS NULL OR original_estimate IS NULL OR actual_paid IS NULL;
CREATE INDEX IF NOT EXISTS idx_event_resource_work_item
  ON event_resource_allocations(work_item_id,phase,status);
CREATE INDEX IF NOT EXISTS idx_event_resource_conflict
  ON event_resource_allocations(resource_id,start_at,end_at,status);

-- 4) Existing Equipment remains the reusable inventory master; extend it for asset lifecycle.
ALTER TABLE equipment ADD COLUMN serial_number TEXT;
ALTER TABLE equipment ADD COLUMN status TEXT;
UPDATE equipment SET status='Available' WHERE status IS NULL OR status='';
ALTER TABLE equipment ADD COLUMN purchase_date TEXT;
ALTER TABLE equipment ADD COLUMN purchase_cost INTEGER;
UPDATE equipment SET purchase_cost=0 WHERE purchase_cost IS NULL;
ALTER TABLE equipment ADD COLUMN last_maintenance_date TEXT;
ALTER TABLE equipment ADD COLUMN next_maintenance_date TEXT;
CREATE INDEX IF NOT EXISTS idx_equipment_status
  ON equipment(status,category,name);

-- 5) Equipment allocations are tied to Work, not directly to the Event UX.
ALTER TABLE event_equipment ADD COLUMN work_item_id INTEGER REFERENCES event_work_items(id) ON DELETE SET NULL;
ALTER TABLE event_equipment ADD COLUMN allocation_type TEXT;
UPDATE event_equipment SET allocation_type=CASE WHEN needs_rental=1 THEN 'Rented' ELSE 'Owned' END WHERE allocation_type IS NULL OR allocation_type='';
ALTER TABLE event_equipment ADD COLUMN vendor_name TEXT;
ALTER TABLE event_equipment ADD COLUMN rental_cost INTEGER;
UPDATE event_equipment SET rental_cost=0 WHERE rental_cost IS NULL;
ALTER TABLE event_equipment ADD COLUMN rental_start_date TEXT;
ALTER TABLE event_equipment ADD COLUMN rental_return_due TEXT;
ALTER TABLE event_equipment ADD COLUMN returned_at TEXT;
ALTER TABLE event_equipment ADD COLUMN return_condition TEXT;
ALTER TABLE event_equipment ADD COLUMN allocation_status TEXT;
UPDATE event_equipment SET allocation_status='Reserved' WHERE allocation_status IS NULL OR allocation_status='';
ALTER TABLE event_equipment ADD COLUMN override_reason TEXT;
ALTER TABLE event_equipment ADD COLUMN override_note TEXT;
ALTER TABLE event_equipment ADD COLUMN allocated_start TEXT;
ALTER TABLE event_equipment ADD COLUMN allocated_end TEXT;
CREATE INDEX IF NOT EXISTS idx_event_equipment_work
  ON event_equipment(work_item_id,allocation_status);
CREATE INDEX IF NOT EXISTS idx_event_equipment_asset_window
  ON event_equipment(equipment_id,allocated_start,allocated_end,allocation_status);

CREATE TABLE IF NOT EXISTS work_item_equipment_requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id INTEGER NOT NULL REFERENCES event_work_items(id) ON DELETE CASCADE,
  equipment_name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_work_equipment_requirements
  ON work_item_equipment_requirements(work_item_id);

-- 6) Inventory procurement and maintenance are auditable and can feed the existing expense ledger.
CREATE TABLE IF NOT EXISTS equipment_procurements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  vendor_name TEXT,
  bill_number TEXT,
  purchase_date TEXT,
  amount INTEGER NOT NULL DEFAULT 0,
  tax_amount INTEGER NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'Unpaid',
  expense_id INTEGER REFERENCES expenses(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_equipment_procurements_equipment
  ON equipment_procurements(equipment_id,purchase_date);

CREATE TABLE IF NOT EXISTS equipment_maintenance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  maintenance_date TEXT,
  vendor_name TEXT,
  amount INTEGER NOT NULL DEFAULT 0,
  next_due_date TEXT,
  expense_id INTEGER REFERENCES expenses(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_equipment_maintenance_equipment
  ON equipment_maintenance(equipment_id,maintenance_date,next_due_date);

-- Existing event equipment rows remain readable. Convert old needs_rental semantics.
UPDATE event_equipment
SET allocation_type=CASE WHEN needs_rental=1 THEN 'Rented' ELSE 'Owned' END
WHERE allocation_type IS NULL OR allocation_type='Owned';

UPDATE equipment
SET status=COALESCE(NULLIF(status,''),'Available')
WHERE status IS NULL OR status='';

-- Seed generic mappings only where they can be inferred safely from service names.
INSERT OR IGNORE INTO service_work_mappings(service_id,event_type_key,work_group,phase,auto_create,sort_order,active)
SELECT s.id,NULL,'Pre-Wedding','Production',1,10,1
FROM services s
WHERE s.active=1 AND lower(s.name) LIKE '%pre%wedding%';

INSERT OR IGNORE INTO service_work_mappings(service_id,event_type_key,work_group,phase,auto_create,sort_order,active)
SELECT s.id,NULL,'Post-Wedding','Production',1,10,1
FROM services s
WHERE s.active=1 AND lower(s.name) LIKE '%post%wedding%';

-- Production is the default for directly shoot-related services; operators can
-- add/remove Work Items later without changing the quotation.
INSERT OR IGNORE INTO service_work_mappings(service_id,event_type_key,work_group,phase,auto_create,sort_order,active)
SELECT s.id,NULL,'Wedding','Production',1,50,1
FROM services s
WHERE s.active=1
  AND lower(s.name) NOT LIKE '%pre%wedding%'
  AND lower(s.name) NOT LIKE '%post%wedding%'
  AND (lower(COALESCE(s.category,'')) LIKE '%photo%'
       OR lower(COALESCE(s.category,'')) LIKE '%video%'
       OR lower(s.name) LIKE '%photograph%'
       OR lower(s.name) LIKE '%videograph%'
       OR lower(s.name) LIKE '%cinematograph%'
       OR lower(s.name) LIKE '%drone%');

-- Do not auto-duplicate generic services into Reception. The Event Manager can
-- add a Reception Work Item from the same Service when the actual schedule requires it.
