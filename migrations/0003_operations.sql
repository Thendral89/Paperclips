-- Paperclip Studios CRM — operations layer: vendors/procurement, real event
-- cost & profit, payment installments, deliverables, pre-event checklist,
-- staff tasks. Applied the same way as every prior migration (CI, --remote).

-- ── Vendors — the "procured outside" half of resourcing ────────────────
-- staff = your own people (already existed). vendors = everyone else you
-- pay for a specific event: drone operators, caterers, decorators, rented
-- equipment, a partner studio you're collaborating with.
CREATE TABLE vendors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  category   TEXT,      -- Catering, Decoration, Drone/Equipment, Makeup, Venue, Partner studio, Other
  phone      TEXT,
  email      TEXT,
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE event_vendors (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id       INTEGER NOT NULL REFERENCES events(id),
  vendor_id      INTEGER NOT NULL REFERENCES vendors(id),
  role           TEXT,                        -- what they're doing on THIS event
  cost           INTEGER NOT NULL DEFAULT 0,   -- what you pay them — a real cost against this event
  payment_status TEXT NOT NULL DEFAULT 'Unpaid',  -- Unpaid, Partially paid, Paid
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_event_vendors_event ON event_vendors(event_id);

-- Internal staff already had assignment (event_staff_links) but no cost —
-- can't compute true event profit without it. Additive columns only.
ALTER TABLE event_staff_links ADD COLUMN role TEXT;     -- "Lead photographer", "Drone operator"... overrides staff.role for this event
ALTER TABLE event_staff_links ADD COLUMN cost INTEGER NOT NULL DEFAULT 0;  -- what you're paying THIS person for THIS event
ALTER TABLE staff ADD COLUMN day_rate INTEGER;          -- optional reference rate, not authoritative — event_staff_links.cost is
-- Existing links predate the "tasks" portal scope — extend them so today's
-- photographers immediately get the new Tasks section without regenerating links.
UPDATE event_staff_links SET scope = scope || ',tasks' WHERE scope NOT LIKE '%tasks%';

-- ── Payment installments — "what's paid, what's next, when's it due" ───
-- payments (existing table) stays the ledger of money actually received.
-- payment_schedule is the PLAN — deliberately free-form per event since
-- you confirmed there's no fixed split, every deal is different.
CREATE TABLE payment_schedule (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        INTEGER NOT NULL REFERENCES events(id),
  label           TEXT NOT NULL,      -- "Advance", "Before event", "On delivery", or anything custom
  amount          INTEGER NOT NULL,
  due_date        TEXT,
  status          TEXT NOT NULL DEFAULT 'Pending',  -- Pending, Paid
  paid_payment_id INTEGER REFERENCES payments(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_payment_schedule_event ON payment_schedule(event_id);
CREATE INDEX idx_payment_schedule_due ON payment_schedule(due_date);

-- ── Deliverables — album/video/etc. production pipeline per event ──────
CREATE TABLE deliverables (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id     INTEGER NOT NULL REFERENCES events(id),
  name         TEXT NOT NULL,        -- "Wedding album", "Highlight reel", "Raw footage handover"
  status       TEXT NOT NULL DEFAULT 'Not started',  -- Not started, In progress, Client review, Delivered
  due_date     TEXT,
  delivered_at TEXT,
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_deliverables_event ON deliverables(event_id);

-- ── Pre-event readiness checklist — one shared template, per-event copies ─
-- Template lives here; creating an event snapshots it into event_checklist
-- so later template edits don't retroactively change past events.
CREATE TABLE checklist_templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE event_checklist (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  item     TEXT NOT NULL,
  done     INTEGER NOT NULL DEFAULT 0,
  done_at  TEXT
);
CREATE INDEX idx_event_checklist_event ON event_checklist(event_id);

INSERT INTO checklist_templates (item, sort_order) VALUES
  ('Photographer(s) assigned', 1),
  ('Any outside vendors/equipment confirmed', 2),
  ('Advance payment received', 3),
  ('Venue & timing confirmed with client', 4),
  ('Shot list / special requests shared with team', 5),
  ('Contract signed', 6);

-- ── Staff tasks — assigned by admin, updated by staff via their portal link ─
CREATE TABLE event_tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   INTEGER NOT NULL REFERENCES events(id),
  link_id    INTEGER REFERENCES event_staff_links(id),  -- who it's assigned to
  task       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'Pending',  -- Pending, In progress, Done
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_event_tasks_event ON event_tasks(event_id);
CREATE INDEX idx_event_tasks_link ON event_tasks(link_id);
