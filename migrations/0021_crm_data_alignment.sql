-- CRM data alignment / repair
-- Align existing Resource + Picklist data with the approved operational model.
-- Idempotent: safe to apply once through the normal Wrangler migration pipeline.

-- Resource types: keep the approved three values only.
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'internal','Internal',30,1
FROM picklist_groups WHERE group_key='resource_type';

INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'external','External',40,1
FROM picklist_groups WHERE group_key='resource_type';

INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'equipment','Equipment / Vendor',50,1
FROM picklist_groups WHERE group_key='resource_type';

UPDATE picklist_values
SET active=1, value_label='Internal', sort_order=30
WHERE group_id=(SELECT id FROM picklist_groups WHERE group_key='resource_type')
  AND value_key='internal';

UPDATE picklist_values
SET active=1, value_label='External', sort_order=40
WHERE group_id=(SELECT id FROM picklist_groups WHERE group_key='resource_type')
  AND value_key='external';

UPDATE picklist_values
SET active=1, value_label='Equipment / Vendor', sort_order=50
WHERE group_id=(SELECT id FROM picklist_groups WHERE group_key='resource_type')
  AND value_key='equipment';

-- Legacy values remain in history but are no longer selectable.
UPDATE picklist_values
SET active=0
WHERE group_id=(SELECT id FROM picklist_groups WHERE group_key='resource_type')
  AND value_key IN ('person','vendor');

-- Normalize existing resource records to the approved type vocabulary.
UPDATE resources
SET resource_type='Internal', updated_at=datetime('now')
WHERE lower(trim(COALESCE(resource_type,''))) IN ('person','internal','');

UPDATE resources
SET resource_type='External', updated_at=datetime('now')
WHERE lower(trim(COALESCE(resource_type,'')))='external';

UPDATE resources
SET resource_type='Equipment / Vendor', updated_at=datetime('now')
WHERE lower(trim(COALESCE(resource_type,''))) IN ('vendor','equipment','equipment / vendor');

-- Normalize legacy workflow phase values if any exist in existing resource assignments.
UPDATE resource_phase_assignments
SET phase='Pre-Production'
WHERE phase IN ('Pre-wedding','Pre Wedding','Pre Wedding / Pre-production');

UPDATE resource_phase_assignments
SET phase='Production'
WHERE phase IN ('Wedding day','Wedding Day','Wedding');

UPDATE resource_phase_assignments
SET phase='Post-Production'
WHERE phase IN ('Post-wedding','Post Wedding','Post Wedding / Post-production');

-- Normalize event allocation phases too, so old allocations remain visible in the
-- new two-column Event Resource Mapping UI.
UPDATE event_resource_allocations
SET phase='Pre-Production'
WHERE phase IN ('Pre-wedding','Pre Wedding','Pre Wedding / Pre-production');

UPDATE event_resource_allocations
SET phase='Production'
WHERE phase IN ('Wedding day','Wedding Day','Wedding');

UPDATE event_resource_allocations
SET phase='Post-Production'
WHERE phase IN ('Post-wedding','Post Wedding','Post Wedding / Post-production');

-- Reconcile the canonical Paperclip resource directory with its configured skills.
-- These inserts are deliberately name-based because the resource registry predates
-- the skill mapping model and has no stable external identifier.
INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
SELECT r.id,s.id FROM resources r JOIN skills s ON s.skill_key='sales'
WHERE r.name='Krithika';

INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
SELECT r.id,s.id FROM resources r JOIN skills s ON s.skill_key='marketing'
WHERE r.name='Krithika';

INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
SELECT r.id,s.id FROM resources r JOIN skills s ON s.skill_key='sales'
WHERE r.name='Aravind';

INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
SELECT r.id,s.id FROM resources r JOIN skills s ON s.skill_key IN ('marketing','candid-photographer','candid-videographer','drone-operator')
WHERE r.name='Aravind';

INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
SELECT r.id,s.id FROM resources r JOIN skills s
WHERE r.name='Jaffer'
  AND s.skill_key IN ('candid-photographer','candid-videographer','traditional-photographer','traditional-videographer','candid-video-editor');

INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
SELECT r.id,s.id FROM resources r JOIN skills s
WHERE r.name='Alwin' AND s.skill_key='candid-videographer';

INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
SELECT r.id,s.id FROM resources r JOIN skills s
WHERE r.name IN ('Saravanan','Kamalanna','Murugan','Vijay','Suresh')
  AND s.skill_key='traditional-photographer';

INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
SELECT r.id,s.id FROM resources r JOIN skills s
WHERE r.name IN ('Majid','Kanna Bhai','Annamalai','Basha Bhai')
  AND s.skill_key='traditional-videographer';

INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
SELECT r.id,s.id FROM resources r JOIN skills s
WHERE r.name='Shiva' AND s.skill_key IN ('candid-photographer','traditional-photographer');

INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
SELECT r.id,s.id FROM resources r JOIN skills s
WHERE r.name='Karthi' AND s.skill_key IN ('traditional-photographer','traditional-videographer');

INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
SELECT r.id,s.id FROM resources r JOIN skills s
WHERE r.name IN ('Sangeeth','Nithin','Priyan JD')
  AND s.skill_key='candid-videographer';

INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
SELECT r.id,s.id FROM resources r JOIN skills s
WHERE r.name IN ('Vignesh JD','Pradeep')
  AND s.skill_key='candid-photographer';

INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
SELECT r.id,s.id FROM resources r JOIN skills s
WHERE r.name='Madan' AND s.skill_key IN ('traditional-videographer','traditional-video-editor');

INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
SELECT r.id,s.id FROM resources r JOIN skills s
WHERE r.name='Abhi' AND s.skill_key='traditional-video-editor';

INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
SELECT r.id,s.id FROM resources r JOIN skills s
WHERE r.name='Shubha' AND s.skill_key='reel-video-editor';

INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
SELECT r.id,s.id FROM resources r JOIN skills s
WHERE r.name='Sanjana'
  AND s.skill_key IN ('exclusive-pictures','client-reference','complete-album-work','album-layout-only','social-media-edit','album-printing-coordination');

INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
SELECT r.id,s.id FROM resources r JOIN skills s
WHERE r.name='Krithika'
  AND s.skill_key IN ('client-reference-pictures-upload','album-printing-coordination');

-- Reconcile the canonical workflow phases for the named resources.
INSERT OR IGNORE INTO resource_phase_assignments(resource_id,phase)
SELECT id,'Pre-Production' FROM resources WHERE name IN ('Krithika','Aravind');

INSERT OR IGNORE INTO resource_phase_assignments(resource_id,phase)
SELECT id,'Production' FROM resources WHERE name IN
('Jaffer','Alwin','Saravanan','Majid','Shiva','Karthi','Sangeeth','Vignesh JD','Kanna Bhai','Kamalanna','Murugan','Vijay','Annamalai','Pradeep','Suresh','Nithin','Madan','Priyan JD','Basha Bhai','Aravind');

INSERT OR IGNORE INTO resource_phase_assignments(resource_id,phase)
SELECT id,'Post-Production' FROM resources WHERE name IN
('Jaffer','Shubha','Madan','Abhi','Sanjana','Krithika');
