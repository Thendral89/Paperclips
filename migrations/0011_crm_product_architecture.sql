-- CRM product architecture foundation
-- One-time configurable company profile, branding, business rules, task templates,
-- custom fields, numbering, document templates, audit and AI/MCP permissions.
-- Kept independent from legacy settings so this migration is additive and reversible.

CREATE TABLE IF NOT EXISTS crm_company_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  company_name TEXT NOT NULL DEFAULT 'Paperclip Studios',
  legal_name TEXT,
  phone TEXT,
  email TEXT,
  website TEXT,
  address TEXT,
  tax_id TEXT,
  currency TEXT NOT NULL DEFAULT 'INR',
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  business_type TEXT NOT NULL DEFAULT 'Wedding Photography & Production',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS crm_branding (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  logo_primary_url TEXT,
  logo_light_url TEXT,
  logo_dark_url TEXT,
  favicon_url TEXT,
  primary_color TEXT NOT NULL DEFAULT '#111111',
  secondary_color TEXT NOT NULL DEFAULT '#666666',
  accent_color TEXT NOT NULL DEFAULT '#B08D57',
  background_color TEXT NOT NULL DEFAULT '#F7F5F1',
  surface_color TEXT NOT NULL DEFAULT '#FFFFFF',
  theme_mode TEXT NOT NULL DEFAULT 'system' CHECK (theme_mode IN ('light','dark','system')),
  font_family TEXT NOT NULL DEFAULT 'Inter',
  ui_density TEXT NOT NULL DEFAULT 'comfortable' CHECK (ui_density IN ('compact','comfortable','spacious')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS crm_business_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'General',
  value_json TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS crm_task_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  event_type_key TEXT,
  phase TEXT NOT NULL CHECK (phase IN ('Pre-Production','Production','Post-Production')),
  task_type TEXT NOT NULL DEFAULT 'Task',
  default_title TEXT NOT NULL,
  default_description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  required INTEGER NOT NULL DEFAULT 0,
  auto_create INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS crm_custom_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  object_key TEXT NOT NULL,
  field_key TEXT NOT NULL,
  field_label TEXT NOT NULL,
  field_type TEXT NOT NULL CHECK (field_type IN ('text','long_text','number','date','boolean','select','multi_select','url')),
  options_json TEXT,
  required INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE(object_key, field_key)
);

CREATE TABLE IF NOT EXISTS crm_custom_field_values (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  object_key TEXT NOT NULL,
  record_id INTEGER NOT NULL,
  field_id INTEGER NOT NULL,
  value_text TEXT,
  value_number REAL,
  value_date TEXT,
  value_boolean INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(object_key, record_id, field_id),
  FOREIGN KEY(field_id) REFERENCES crm_custom_fields(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS crm_numbering_sequences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  object_key TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  include_year INTEGER NOT NULL DEFAULT 1,
  next_number INTEGER NOT NULL DEFAULT 1,
  padding INTEGER NOT NULL DEFAULT 4,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS crm_document_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  document_type TEXT NOT NULL,
  body_html TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS crm_ai_permissions (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  mcp_enabled INTEGER NOT NULL DEFAULT 0,
  allowed_read_json TEXT NOT NULL DEFAULT '[]',
  allowed_write_json TEXT NOT NULL DEFAULT '[]',
  confirmation_required_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS crm_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL DEFAULT 'user',
  actor_id TEXT,
  actor_email TEXT,
  action TEXT NOT NULL,
  object_key TEXT,
  record_id INTEGER,
  before_json TEXT,
  after_json TEXT,
  source TEXT NOT NULL DEFAULT 'web',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_crm_rules_category ON crm_business_rules(category, active);
CREATE INDEX IF NOT EXISTS idx_crm_templates_event_phase ON crm_task_templates(event_type_key, phase, active);
CREATE INDEX IF NOT EXISTS idx_crm_custom_fields_object ON crm_custom_fields(object_key, active, sort_order);
CREATE INDEX IF NOT EXISTS idx_crm_custom_values_record ON crm_custom_field_values(object_key, record_id);
CREATE INDEX IF NOT EXISTS idx_crm_audit_object ON crm_audit_log(object_key, record_id, created_at);

INSERT OR IGNORE INTO crm_company_profile(id) VALUES (1);
INSERT OR IGNORE INTO crm_branding(id) VALUES (1);
INSERT OR IGNORE INTO crm_ai_permissions(id) VALUES (1);

INSERT OR IGNORE INTO crm_numbering_sequences(object_key,prefix,include_year,next_number,padding) VALUES
 ('lead','LEAD-',1,1,4),
 ('quote','QT-',1,1,4),
 ('booking','BK-',1,1,4),
 ('event','EV-',1,1,4),
 ('invoice','INV-',1,1,4);

INSERT OR IGNORE INTO crm_business_rules(rule_key,label,description,category,value_json) VALUES
 ('quote.win.create_booking','Convert Won Quote','Create a booking from a won quote.','Sales','{"enabled":true}'),
 ('booking.create.create_events','Create Events','Create operational events from booking/event details.','Operations','{"enabled":true}'),
 ('event.create.default_tasks','Create Default Tasks','Create active task-template items when an event is created.','Operations','{"enabled":true}'),
 ('resource.require_skill','Require Skill Match','Warn when an allocated resource does not have the required skill.','Resources','{"enabled":true}'),
 ('resource.block_conflict','Block Resource Conflict','Prevent overlapping allocation for the same resource/date/session.','Resources','{"enabled":true}'),
 ('event.block_completion_pending','Block Completion With Pending Tasks','Prevent completion while required tasks remain pending.','Operations','{"enabled":true}'),
 ('booking.default_advance','Default Advance','Default advance percentage for new bookings.','Finance','{"percent":30}'),
 ('marketing.anniversary_opportunity','Anniversary Opportunity','Create a marketing opportunity before a client anniversary.','Marketing','{"days_before":30,"enabled":true}'),
 ('marketing.birthday_opportunity','Birthday Opportunity','Create a marketing opportunity before a client birthday.','Marketing','{"days_before":7,"enabled":true}');

INSERT OR IGNORE INTO crm_task_templates(template_key,name,event_type_key,phase,task_type,default_title,sort_order,required,auto_create) VALUES
 ('wedding.client_briefing','Wedding Default','Wedding','Pre-Production','Task','Client briefing',10,1,1),
 ('wedding.crew_confirmation','Wedding Default','Wedding','Pre-Production','Task','Crew confirmation',20,1,1),
 ('wedding.equipment_prep','Wedding Default','Wedding','Pre-Production','Task','Equipment preparation',30,0,1),
 ('wedding.photography','Wedding Default','Wedding','Production','Resource','Photography',10,1,1),
 ('wedding.videography','Wedding Default','Wedding','Production','Resource','Videography',20,0,1),
 ('wedding.cinematography','Wedding Default','Wedding','Production','Resource','Cinematography',30,0,1),
 ('wedding.drone','Wedding Default','Wedding','Production','Resource','Drone',40,0,1),
 ('wedding.backup','Wedding Default','Wedding','Post-Production','Task','Media backup',10,1,1),
 ('wedding.culling','Wedding Default','Wedding','Post-Production','Task','Photo culling',20,0,1),
 ('wedding.editing','Wedding Default','Wedding','Post-Production','Task','Photo editing',30,0,1),
 ('wedding.album','Wedding Default','Wedding','Post-Production','Task','Album design',40,0,1),
 ('wedding.video_edit','Wedding Default','Wedding','Post-Production','Task','Video editing',50,0,1),
 ('wedding.client_review','Wedding Default','Wedding','Post-Production','Task','Client review',60,0,1),
 ('wedding.delivery','Wedding Default','Wedding','Post-Production','Task','Final delivery',70,1,1);
