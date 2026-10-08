-- Event operations configuration and event-type-aware checklist templates
-- Adds configurable Work Groups and Event Type targeting for checklist templates.

ALTER TABLE checklist_templates ADD COLUMN event_type_key TEXT;

CREATE INDEX IF NOT EXISTS idx_checklist_templates_event_type
  ON checklist_templates(event_type_key,active,phase,sort_order);

CREATE INDEX IF NOT EXISTS idx_checklist_templates_event_type_service_skill
  ON checklist_templates(event_type_key,service_id,skill_id,active);

INSERT OR IGNORE INTO picklist_groups(group_key,label,description,sort_order,active)
VALUES ('event_work_group','Event Work Groups','Operational groups inside an Event; editable by admins.',75,1);

INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'pre-wedding','Pre-Wedding',10,1 FROM picklist_groups WHERE group_key='event_work_group';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'wedding','Wedding',20,1 FROM picklist_groups WHERE group_key='event_work_group';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'reception','Reception',30,1 FROM picklist_groups WHERE group_key='event_work_group';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'post-wedding','Post-Wedding',40,1 FROM picklist_groups WHERE group_key='event_work_group';

-- Event-type-specific defaults. Global templates remain event_type_key NULL.
INSERT INTO checklist_templates(item,sort_order,phase,event_type_key,active)
SELECT 'Confirm wedding ceremony timeline, family shot list and special moments',200,'Pre-Production','Wedding',1
WHERE NOT EXISTS (
  SELECT 1 FROM checklist_templates WHERE item='Confirm wedding ceremony timeline, family shot list and special moments' AND event_type_key='Wedding'
);

INSERT INTO checklist_templates(item,sort_order,phase,event_type_key,active)
SELECT 'Confirm wedding-day crew call time and venue access',210,'Pre-Production','Wedding',1
WHERE NOT EXISTS (
  SELECT 1 FROM checklist_templates WHERE item='Confirm wedding-day crew call time and venue access' AND event_type_key='Wedding'
);

INSERT INTO checklist_templates(item,sort_order,phase,event_type_key,active)
SELECT 'Verify wedding ceremony coverage and media backup',220,'Production','Wedding',1
WHERE NOT EXISTS (
  SELECT 1 FROM checklist_templates WHERE item='Verify wedding ceremony coverage and media backup' AND event_type_key='Wedding'
);

INSERT INTO checklist_templates(item,sort_order,phase,event_type_key,active)
SELECT 'Confirm reception stage, lighting and programme timeline',230,'Pre-Production','Reception',1
WHERE NOT EXISTS (
  SELECT 1 FROM checklist_templates WHERE item='Confirm reception stage, lighting and programme timeline' AND event_type_key='Reception'
);

INSERT INTO checklist_templates(item,sort_order,phase,event_type_key,active)
SELECT 'Confirm reception guest, family and stage coverage',240,'Production','Reception',1
WHERE NOT EXISTS (
  SELECT 1 FROM checklist_templates WHERE item='Confirm reception guest, family and stage coverage' AND event_type_key='Reception'
);

INSERT INTO checklist_templates(item,sort_order,phase,event_type_key,active)
SELECT 'Verify reception media backup and coverage handover',250,'Production','Reception',1
WHERE NOT EXISTS (
  SELECT 1 FROM checklist_templates WHERE item='Verify reception media backup and coverage handover' AND event_type_key='Reception'
);

INSERT INTO checklist_templates(item,sort_order,phase,event_type_key,active)
SELECT 'Confirm combined Wedding + Reception timeline and crew split',260,'Pre-Production','Wedding + Reception',1
WHERE NOT EXISTS (
  SELECT 1 FROM checklist_templates WHERE item='Confirm combined Wedding + Reception timeline and crew split' AND event_type_key='Wedding + Reception'
);

INSERT INTO checklist_templates(item,sort_order,phase,event_type_key,active)
SELECT 'Verify combined Wedding + Reception coverage and media backup',270,'Production','Wedding + Reception',1
WHERE NOT EXISTS (
  SELECT 1 FROM checklist_templates WHERE item='Verify combined Wedding + Reception coverage and media backup' AND event_type_key='Wedding + Reception'
);
