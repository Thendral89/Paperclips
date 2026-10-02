-- Paperclip CRM: Resource + Skills + Admin Configuration
-- Safe/additive migration. Does NOT rename/drop the legacy vendors table.
-- Apply after the latest existing migration (use the next migration number).

CREATE TABLE IF NOT EXISTS app_labels (
  label_key   TEXT PRIMARY KEY,
  label_value TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by  TEXT
);

CREATE TABLE IF NOT EXISTS picklist_groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  group_key   TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  description TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS picklist_values (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id    INTEGER NOT NULL REFERENCES picklist_groups(id),
  value_key   TEXT NOT NULL,
  value_label TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  UNIQUE(group_id, value_key)
);

CREATE TABLE IF NOT EXISTS resources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  phone       TEXT,
  email       TEXT,
  notes       TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS skills (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_key   TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS resource_skills (
  resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  skill_id   INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY(resource_id, skill_id)
);

CREATE TABLE IF NOT EXISTS resource_phase_assignments (
  resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  phase       TEXT NOT NULL,
  PRIMARY KEY(resource_id, phase)
);

CREATE TABLE IF NOT EXISTS event_resource_allocations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  resource_id   INTEGER NOT NULL REFERENCES resources(id),
  phase         TEXT NOT NULL,
  role_label    TEXT,
  skill_id      INTEGER REFERENCES skills(id),
  cost          INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'Planned',
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_id, resource_id, phase, skill_id)
);
CREATE INDEX IF NOT EXISTS idx_event_resource_event
  ON event_resource_allocations(event_id);
CREATE INDEX IF NOT EXISTS idx_event_resource_phase
  ON event_resource_allocations(event_id, phase);

CREATE TABLE IF NOT EXISTS event_expense_meta (
  expense_id      INTEGER PRIMARY KEY REFERENCES expenses(id) ON DELETE CASCADE,
  event_code      TEXT,
  client_name     TEXT,
  event_date      TEXT,
  event_type      TEXT
);

-- Backfill the identity tag for existing event-linked expenses.
INSERT OR IGNORE INTO event_expense_meta(expense_id,event_code,client_name,event_date,event_type)
SELECT x.id,
       'EV-' || printf('%06d',e.id) || '-' || replace(COALESCE(a.name,''),' ','-') || '-' || COALESCE(e.event_date,'TBD'),
       a.name,e.event_date,e.type
FROM expenses x
JOIN events e ON e.id=x.event_id
JOIN accounts a ON a.id=e.account_id;

CREATE TABLE IF NOT EXISTS service_deliverables (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id    INTEGER REFERENCES services(id) ON DELETE CASCADE,
  package_id    INTEGER REFERENCES packages(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  timeline_text TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS quote_delivery_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id    INTEGER NOT NULL REFERENCES lead_quotes(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL,
  destination TEXT,
  url         TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Labels. Internal route/entity keys remain stable.
INSERT OR IGNORE INTO app_labels(label_key,label_value) VALUES
 ('nav.dashboard','Dashboard'),
 ('nav.leads','Leads'),
 ('nav.accounts','Customers / Accounts'),
 ('nav.calendar','Calendar'),
 ('nav.events','Events'),
 ('nav.packages','Packages'),
 ('nav.vendors','Resources'),
 ('nav.equipment','Equipment'),
 ('nav.expenses','Expenses'),
 ('nav.financials','Financials'),
 ('nav.reports','Reports'),
 ('nav.settings','Settings'),
 ('event.resources','Resources'),
 ('event.expenses','Expenses'),
 ('quote.services','Services'),
 ('quote.packages','Packages');

-- Picklist groups.
INSERT OR IGNORE INTO picklist_groups(group_key,label,description,sort_order) VALUES
 ('resource_phase','Resource phases','Where a resource can be used in the workflow',10),
 ('resource_skill','Resource skills','Skills available to resources',20),
 ('event_type','Event types','Event types shown on event forms',30),
 ('expense_category','Expense categories','Event/office expense categories',40),
 ('service_category','Service categories','Service catalog categories',50),
 ('post_production_timeline','Post-production timelines','Standard delivery expectations',60);

INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order)
 SELECT id,'pre-production','Pre-Production',10 FROM picklist_groups WHERE group_key='resource_phase';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order)
 SELECT id,'production','Production',20 FROM picklist_groups WHERE group_key='resource_phase';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order)
 SELECT id,'post-production','Post-Production',30 FROM picklist_groups WHERE group_key='resource_phase';

-- Skills from the supplied resource list.
INSERT OR IGNORE INTO skills(skill_key,label) VALUES
 ('sales','Sales'),
 ('marketing','Marketing'),
 ('candid-photographer','Candid Photographer'),
 ('candid-videographer','Candid Videographer'),
 ('traditional-photographer','Traditional Photographer'),
 ('traditional-videographer','Traditional Videographer'),
 ('drone-operator','Drone Operator'),
 ('candid-video-editor','Candid Video Editor'),
 ('traditional-video-editor','Traditional Video Editor'),
 ('reel-video-editor','Reel Video Editor'),
 ('exclusive-pictures','Exclusive Pictures'),
 ('client-reference','Client Reference'),
 ('complete-album-work','Complete album work'),
 ('album-layout-only','Album Layout only'),
 ('social-media-edit','Social media edit'),
 ('album-printing-coordination','Album Printing coordination'),
 ('client-reference-pictures-upload','Client Reference pictures upload');

INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order)
 SELECT id,'sales','Sales',10 FROM picklist_groups WHERE group_key='resource_skill';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order)
 SELECT id,'marketing','Marketing',20 FROM picklist_groups WHERE group_key='resource_skill';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order)
 SELECT id,'candid-photographer','Candid Photographer',30 FROM picklist_groups WHERE group_key='resource_skill';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order)
 SELECT id,'candid-videographer','Candid Videographer',40 FROM picklist_groups WHERE group_key='resource_skill';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order)
 SELECT id,'traditional-photographer','Traditional Photographer',50 FROM picklist_groups WHERE group_key='resource_skill';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order)
 SELECT id,'traditional-videographer','Traditional Videographer',60 FROM picklist_groups WHERE group_key='resource_skill';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order)
 SELECT id,'drone-operator','Drone Operator',70 FROM picklist_groups WHERE group_key='resource_skill';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order)
 SELECT id,'candid-video-editor','Candid Video Editor',80 FROM picklist_groups WHERE group_key='resource_skill';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order)
 SELECT id,'traditional-video-editor','Traditional Video Editor',90 FROM picklist_groups WHERE group_key='resource_skill';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order)
 SELECT id,'reel-video-editor','Reel Video Editor',100 FROM picklist_groups WHERE group_key='resource_skill';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order)
 SELECT id,'exclusive-pictures','Exclusive Pictures',110 FROM picklist_groups WHERE group_key='resource_skill';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order)
 SELECT id,'client-reference','Client Reference',120 FROM picklist_groups WHERE group_key='resource_skill';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order)
 SELECT id,'complete-album-work','Complete album work',130 FROM picklist_groups WHERE group_key='resource_skill';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order)
 SELECT id,'album-layout-only','Album Layout only',140 FROM picklist_groups WHERE group_key='resource_skill';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order)
 SELECT id,'social-media-edit','Social media edit',150 FROM picklist_groups WHERE group_key='resource_skill';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order)
 SELECT id,'album-printing-coordination','Album Printing coordination',160 FROM picklist_groups WHERE group_key='resource_skill';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order)
 SELECT id,'client-reference-pictures-upload','Client Reference pictures upload',170 FROM picklist_groups WHERE group_key='resource_skill';

-- Timeline picklist values exactly as supplied.
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order)
 SELECT id,'exclusive-pictures','Exclusive Pictures — 7–14 days',10 FROM picklist_groups WHERE group_key='post_production_timeline';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order)
 SELECT id,'client-reference','Client Reference — 7–20 days',20 FROM picklist_groups WHERE group_key='post_production_timeline';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order)
 SELECT id,'album-selection','Album Selection — 1 month',30 FROM picklist_groups WHERE group_key='post_production_timeline';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order)
 SELECT id,'album-layout','Album Layout — 4 weeks after album selection',40 FROM picklist_groups WHERE group_key='post_production_timeline';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order)
 SELECT id,'candid-video','Candid Video — 30–45 working days',50 FROM picklist_groups WHERE group_key='post_production_timeline';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order)
 SELECT id,'traditional-video','Traditional Video — 30–60 working days',60 FROM picklist_groups WHERE group_key='post_production_timeline';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order)
 SELECT id,'album-printing','Album Printing — 2 weeks after layout confirmation',70 FROM picklist_groups WHERE group_key='post_production_timeline';
INSERT OR IGNORE INTO picklist_values(group_id,value_key,value_label,sort_order)
 SELECT id,'hard-drive','Hard Drive deliverable — Along with album collection',80 FROM picklist_groups WHERE group_key='post_production_timeline';

-- Seed resources. Same person can belong to multiple phases.
INSERT OR IGNORE INTO resources(name) VALUES
 ('Krithika'),('Aravind'),('Jaffer'),('Alwin'),('Saravanan'),('Majid'),
 ('Shiva'),('Karthi'),('Sangeeth'),('Vignesh JD'),('Kanna Bhai'),('Kamalanna'),
 ('Murugan'),('Vijay'),('Annamalai'),('Pradeep'),('Suresh'),('Nithin'),
 ('Madan'),('Priyan JD'),('Basha Bhai'),('Shubha'),('Abhi'),('Sanjana');

-- Phase memberships.
INSERT OR IGNORE INTO resource_phase_assignments(resource_id,phase)
 SELECT id,'Pre-Production' FROM resources WHERE name IN ('Krithika','Aravind');
INSERT OR IGNORE INTO resource_phase_assignments(resource_id,phase)
 SELECT id,'Production' FROM resources WHERE name IN
 ('Jaffer','Alwin','Saravanan','Majid','Shiva','Karthi','Sangeeth','Vignesh JD','Kanna Bhai','Kamalanna','Murugan','Vijay','Annamalai','Pradeep','Suresh','Nithin','Madan','Priyan JD','Basha Bhai');
INSERT OR IGNORE INTO resource_phase_assignments(resource_id,phase)
 SELECT id,'Post-Production' FROM resources WHERE name IN
 ('Jaffer','Shubha','Madan','Abhi','Sanjana','Krithika');

-- Resource skills.
INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
 SELECT r.id,s.id FROM resources r JOIN skills s ON s.skill_key='sales' WHERE r.name='Krithika';
INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
 SELECT r.id,s.id FROM resources r JOIN skills s ON s.skill_key='marketing' WHERE r.name='Krithika';
INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
 SELECT r.id,s.id FROM resources r JOIN skills s ON s.skill_key IN ('sales','marketing','candid-photographer','candid-videographer','drone-operator') WHERE r.name='Aravind';

INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
 SELECT r.id,s.id FROM resources r JOIN skills s ON s.skill_key IN ('candid-photographer','candid-videographer','traditional-photographer','traditional-videographer','candid-video-editor') WHERE r.name='Jaffer';
INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
 SELECT r.id,s.id FROM resources r JOIN skills s ON s.skill_key='candid-videographer' WHERE r.name='Alwin';
INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
 SELECT r.id,s.id FROM resources r JOIN skills s ON s.skill_key='traditional-photographer' WHERE r.name IN ('Saravanan','Kamalanna','Murugan','Vijay','Suresh');
INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
 SELECT r.id,s.id FROM resources r JOIN skills s ON s.skill_key='traditional-videographer' WHERE r.name IN ('Majid','Kanna Bhai','Annamalai','Basha Bhai');
INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
 SELECT r.id,s.id FROM resources r JOIN skills s ON s.skill_key IN ('candid-photographer','traditional-photographer') WHERE r.name='Shiva';
INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
 SELECT r.id,s.id FROM resources r JOIN skills s ON s.skill_key IN ('traditional-photographer','traditional-videographer') WHERE r.name='Karthi';
INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
 SELECT r.id,s.id FROM resources r JOIN skills s ON s.skill_key='candid-videographer' WHERE r.name IN ('Sangeeth','Nithin','Priyan JD');
INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
 SELECT r.id,s.id FROM resources r JOIN skills s ON s.skill_key='candid-photographer' WHERE r.name IN ('Vignesh JD','Pradeep');
INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
 SELECT r.id,s.id FROM resources r JOIN skills s ON s.skill_key IN ('traditional-videographer','traditional-video-editor') WHERE r.name='Madan';
INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
 SELECT r.id,s.id FROM resources r JOIN skills s ON s.skill_key='traditional-video-editor' WHERE r.name='Abhi';
INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
 SELECT r.id,s.id FROM resources r JOIN skills s ON s.skill_key='reel-video-editor' WHERE r.name='Shubha';
INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
 SELECT r.id,s.id FROM resources r JOIN skills s ON s.skill_key IN ('exclusive-pictures','client-reference','complete-album-work','album-layout-only','social-media-edit','album-printing-coordination') WHERE r.name='Sanjana';
INSERT OR IGNORE INTO resource_skills(resource_id,skill_id)
 SELECT r.id,s.id FROM resources r JOIN skills s ON s.skill_key IN ('client-reference-pictures-upload','album-printing-coordination') WHERE r.name='Krithika';

-- Services/catalog additions from the supplied package PDF.
INSERT OR IGNORE INTO services(name,base_price,category) VALUES
 ('Drone',0,'Additional Service'),
 ('LED Wall (12*8)',0,'Additional Service'),
 ('LED Wall (8*6)',0,'Additional Service'),
 ('LED TV (55 inch)',0,'Additional Service'),
 ('Live streaming',0,'Additional Service'),
 ('360 Degree photobooth',0,'Additional Service'),
 ('Instant Photo printing',0,'Additional Service');

-- Package seed. Existing package names are left untouched if already present.
INSERT OR IGNORE INTO packages(name,description,base_price,active) VALUES
 ('Basic','2 sessions; Traditional photographer 1; Traditional videographer 1; core album/video deliverables',75000,1),
 ('Standard','2 sessions; Traditional photographer 1; Traditional videographer 1; Creative photographer 1',110000,1),
 ('Classic','2 sessions; Traditional photographer 1; Traditional videographer 1; Creative photographer 1; Cinematographer 1',160000,1),
 ('Premium','2 sessions; Traditional photographer 1; Traditional videographer 2; Creative photographer 1; Cinematographer 1; Drone 1',220000,1),
 ('Exclusive','2 sessions; Traditional photographer 2; Traditional videographer 2; Creative photographer 1; Cinematographer 1; Drone 1; LED Wall 12*8; Mixing unit',310000,1);
