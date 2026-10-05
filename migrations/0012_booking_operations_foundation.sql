-- Booking and operational scheduling foundation.
-- Booking is the commercial container; Events are operational occurrences.

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  quote_id INTEGER REFERENCES lead_quotes(id),
  booking_number TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'Booked',
  booked_value INTEGER NOT NULL DEFAULT 0,
  discount INTEGER NOT NULL DEFAULT 0,
  tax INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bookings_account ON bookings(account_id, status);
CREATE INDEX IF NOT EXISTS idx_bookings_quote ON bookings(quote_id);

ALTER TABLE events ADD COLUMN booking_id INTEGER REFERENCES bookings(id);
CREATE INDEX IF NOT EXISTS idx_events_booking ON events(booking_id);

CREATE TABLE IF NOT EXISTS booking_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  payment_date TEXT NOT NULL,
  method TEXT,
  reference TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_booking_payments_booking ON booking_payments(booking_id, payment_date);

CREATE TABLE IF NOT EXISTS event_resource_requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES event_tasks(id) ON DELETE SET NULL,
  role_label TEXT NOT NULL,
  skill_id INTEGER REFERENCES skills(id),
  quantity INTEGER NOT NULL DEFAULT 1,
  phase TEXT NOT NULL CHECK (phase IN ('Pre-Production','Production','Post-Production')),
  session_key TEXT,
  allocation_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_resource_requirements_event ON event_resource_requirements(event_id, phase);
CREATE INDEX IF NOT EXISTS idx_resource_requirements_schedule ON event_resource_requirements(allocation_date, session_key, skill_id);

ALTER TABLE event_resource_allocations ADD COLUMN session_key TEXT;
ALTER TABLE event_resource_allocations ADD COLUMN allocation_date TEXT;
ALTER TABLE event_resource_allocations ADD COLUMN start_time TEXT;
ALTER TABLE event_resource_allocations ADD COLUMN end_time TEXT;

CREATE INDEX IF NOT EXISTS idx_resource_allocations_schedule
  ON event_resource_allocations(resource_id, allocation_date, start_time, end_time);

CREATE INDEX IF NOT EXISTS idx_resource_allocations_session
  ON event_resource_allocations(resource_id, allocation_date, session_key);

INSERT OR IGNORE INTO crm_business_rules(rule_key,label,description,category,value_json) VALUES
 ('booking.create_from_won_quote','Create Booking From Won Quote','Convert a won quote into a booking while preserving the commercial snapshot.','Sales','{"enabled":true}'),
 ('event.resource_time_conflict','Detect Resource Time Conflict','Block or warn when a resource overlaps another event during the same session/time window.','Resources','{"enabled":true,"mode":"block"}'),
 ('event.resource_skill_warning','Require Resource Skill','Warn when an allocated resource does not have the requested skill.','Resources','{"enabled":true}'),
 ('event.auto_create_quote_tasks','Create Tasks From Quote Lines','Generate operational task/resource requirements from quote line items.','Operations','{"enabled":true}');
