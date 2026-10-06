-- Backfill operational checklists for existing Events that currently have none.
-- Existing non-empty event checklists are left untouched.
INSERT INTO event_checklist(event_id,item,done,phase,template_id)
SELECT e.id,t.item,0,t.phase,t.id
FROM events e
CROSS JOIN checklist_templates t
WHERE t.active=1
  AND NOT EXISTS (SELECT 1 FROM event_checklist c WHERE c.event_id=e.id);
