-- CRM lifecycle/configuration alignment
-- Keeps internal table/entity names stable while making the business vocabulary
-- match the approved product model.

INSERT OR REPLACE INTO app_labels(label_key,label_value) VALUES
 ('nav.accounts','Clients'),
 ('nav.resources','Resources'),
 ('nav.vendors','Resources');

INSERT OR IGNORE INTO picklist_groups(group_key,label,description,sort_order,active)
VALUES
 ('lead_stage','Lead stages','Sales lifecycle for a lead',5,1),
 ('quote_status','Quote statuses','Commercial quote lifecycle',6,1),
 ('event_status','Event statuses','Operational event path',7,1);

INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'new','New',10,1 FROM picklist_groups WHERE group_key='lead_stage';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'qualified','Qualified',20,1 FROM picklist_groups WHERE group_key='lead_stage';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'quote','Quote',30,1 FROM picklist_groups WHERE group_key='lead_stage';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'negotiation','Negotiation',40,1 FROM picklist_groups WHERE group_key='lead_stage';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'won','Won',50,1 FROM picklist_groups WHERE group_key='lead_stage';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'long-pending','Long Pending',60,1 FROM picklist_groups WHERE group_key='lead_stage';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'lost','Lost',70,1 FROM picklist_groups WHERE group_key='lead_stage';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'cancelled','Cancelled',80,1 FROM picklist_groups WHERE group_key='lead_stage';

INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'draft','Draft',10,1 FROM picklist_groups WHERE group_key='quote_status';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'sent','Sent',20,1 FROM picklist_groups WHERE group_key='quote_status';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'viewed','Viewed',30,1 FROM picklist_groups WHERE group_key='quote_status';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'negotiation','Negotiation',40,1 FROM picklist_groups WHERE group_key='quote_status';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'accepted','Accepted',50,1 FROM picklist_groups WHERE group_key='quote_status';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'rejected','Rejected',60,1 FROM picklist_groups WHERE group_key='quote_status';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'expired','Expired',70,1 FROM picklist_groups WHERE group_key='quote_status';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'cancelled','Cancelled',80,1 FROM picklist_groups WHERE group_key='quote_status';

INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'pending','Pending',10,1 FROM picklist_groups WHERE group_key='event_status';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'planning','Planning',20,1 FROM picklist_groups WHERE group_key='event_status';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'in-progress','In-Progress',30,1 FROM picklist_groups WHERE group_key='event_status';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'completed','Completed',40,1 FROM picklist_groups WHERE group_key='event_status';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'overdue','Overdue',50,1 FROM picklist_groups WHERE group_key='event_status';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'cancelled','Cancelled',60,1 FROM picklist_groups WHERE group_key='event_status';

-- Resource types are configurable; Vendor remains as a legacy-compatible value.
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'internal','Internal',30,1 FROM picklist_groups WHERE group_key='resource_type';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'external','External',40,1 FROM picklist_groups WHERE group_key='resource_type';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order,active)
SELECT id,'equipment','Equipment / Vendor',50,1 FROM picklist_groups WHERE group_key='resource_type';
