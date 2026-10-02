-- Paperclip CRM: Resources become the single operational resource registry.
-- Vendor is a resource type, not a top-level module.
ALTER TABLE resources ADD COLUMN resource_type TEXT NOT NULL DEFAULT 'Person';
CREATE INDEX IF NOT EXISTS idx_resources_type_active ON resources(resource_type, active, name);
INSERT OR IGNORE INTO picklist_groups(group_key,label,description,sort_order,active)
VALUES ('resource_type','Resource types','Categories available when creating a resource',15,1);
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'person','Person',10,1 FROM picklist_groups WHERE group_key='resource_type';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'vendor','Vendor',20,1 FROM picklist_groups WHERE group_key='resource_type';
INSERT OR IGNORE INTO app_labels(label_key,label_value) VALUES
 ('nav.resources','Resources'),('resource.person','Person'),('resource.vendor','Vendor');
INSERT INTO resources(name,resource_type,phone,email,notes,active)
SELECT v.name,'Vendor',v.phone,v.email,v.notes,1
FROM vendors v
WHERE NOT EXISTS (
  SELECT 1 FROM resources r
  WHERE lower(trim(r.name))=lower(trim(v.name)) AND r.resource_type='Vendor'
);
