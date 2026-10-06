-- Ensure every new Event has an operational three-phase checklist out of the box.
-- Existing custom checklist templates are preserved; seed only when the template catalog is empty.
INSERT INTO checklist_templates(item,sort_order,phase,active)
SELECT 'Confirm client brief, venue and event timeline',10,'Pre-Production',1
WHERE NOT EXISTS (SELECT 1 FROM checklist_templates);
INSERT INTO checklist_templates(item,sort_order,phase,active)
SELECT 'Confirm team, resource allocation and responsibilities',20,'Pre-Production',1
WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE item='Confirm team, resource allocation and responsibilities');
INSERT INTO checklist_templates(item,sort_order,phase,active)
SELECT 'Confirm equipment, batteries and backup gear',30,'Pre-Production',1
WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE item='Confirm equipment, batteries and backup gear');
INSERT INTO checklist_templates(item,sort_order,phase,active)
SELECT 'Final client follow-up and production briefing',40,'Pre-Production',1
WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE item='Final client follow-up and production briefing');
INSERT INTO checklist_templates(item,sort_order,phase,active)
SELECT 'Team check-in and event start',50,'Production',1
WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE item='Team check-in and event start');
INSERT INTO checklist_templates(item,sort_order,phase,active)
SELECT 'Capture planned coverage and key moments',60,'Production',1
WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE item='Capture planned coverage and key moments');
INSERT INTO checklist_templates(item,sort_order,phase,active)
SELECT 'Backup and verify captured media',70,'Production',1
WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE item='Backup and verify captured media');
INSERT INTO checklist_templates(item,sort_order,phase,active)
SELECT 'Ingest, organize and back up project files',80,'Post-Production',1
WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE item='Ingest, organize and back up project files');
INSERT INTO checklist_templates(item,sort_order,phase,active)
SELECT 'Complete editing, review and client deliverables',90,'Post-Production',1
WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE item='Complete editing, review and client deliverables');
