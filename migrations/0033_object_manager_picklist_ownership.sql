-- Make picklist ownership configurable per CRM object/module.
-- Existing ownership is inferred once to preserve current forms and behavior.
ALTER TABLE picklist_groups ADD COLUMN object_key TEXT NOT NULL DEFAULT 'general';

UPDATE picklist_groups SET object_key = CASE
  WHEN group_key LIKE 'resource_%' THEN 'resources'
  WHEN group_key LIKE 'event_%' OR group_key LIKE 'post_production_%' THEN 'events'
  WHEN group_key LIKE 'lead_%' THEN 'leads'
  WHEN group_key LIKE 'account_%' OR group_key LIKE 'client_%' THEN 'accounts'
  WHEN group_key LIKE 'package_%' OR group_key LIKE 'service_%' THEN 'packages'
  WHEN group_key LIKE 'equipment_%' THEN 'inventory'
  WHEN group_key LIKE 'expense_%' THEN 'expenses'
  WHEN group_key LIKE 'financial_%' OR group_key LIKE 'payment_%' THEN 'financials'
  ELSE 'general'
END;

CREATE INDEX IF NOT EXISTS idx_picklist_groups_object ON picklist_groups(object_key,active,sort_order);
