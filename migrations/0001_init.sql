-- Paperclip Studios CRM — initial schema
-- Applied via: wrangler d1 migrations apply paperclip-crm --remote

-- ── Lead management ──────────────────────────────────────────────
CREATE TABLE leads (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL,
  phone               TEXT NOT NULL,
  phone_normalized    TEXT NOT NULL,          -- digits only, used for dedupe matching
  email               TEXT,
  source              TEXT NOT NULL,          -- Instagram | WhatsApp | Facebook | Referral | Website | Manual
  event_type          TEXT,
  event_date          TEXT,
  budget_est          INTEGER,
  stage               TEXT NOT NULL DEFAULT 'New',   -- New, Contacted, Quoted, Follow-up, Booked, Lost
  referred_by         TEXT,
  message              TEXT,
  next_follow_up_date TEXT,
  possible_duplicate_of INTEGER REFERENCES leads(id),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_leads_stage ON leads(stage);
CREATE INDEX idx_leads_phone ON leads(phone_normalized);
CREATE INDEX idx_leads_followup ON leads(next_follow_up_date);

CREATE TABLE lead_status_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id     INTEGER NOT NULL REFERENCES leads(id),
  from_stage  TEXT,
  to_stage    TEXT NOT NULL,
  changed_by  TEXT,
  changed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE lead_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id    INTEGER NOT NULL REFERENCES leads(id),
  author     TEXT,
  note       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Accounts & events ─────────────────────────────────────────────
CREATE TABLE accounts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id      INTEGER REFERENCES leads(id),
  name         TEXT NOT NULL,
  phone        TEXT,
  email        TEXT,
  address      TEXT,
  client_since TEXT NOT NULL DEFAULT (datetime('now')),
  notes        TEXT,
  is_signature INTEGER NOT NULL DEFAULT 0    -- manual "creamy"/premium flag, see blueprint §3
);

CREATE TABLE pricing_tiers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  multiplier REAL NOT NULL DEFAULT 1.0,
  perks      TEXT
);

CREATE TABLE events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      INTEGER NOT NULL REFERENCES accounts(id),
  type            TEXT NOT NULL,
  event_date      TEXT,
  venue           TEXT,
  status          TEXT NOT NULL DEFAULT 'Planned',  -- Planned, In progress, Delivered
  pricing_tier_id INTEGER REFERENCES pricing_tiers(id),
  quote_total     INTEGER NOT NULL DEFAULT 0,
  advance_paid    INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Commercial ─────────────────────────────────────────────────────
CREATE TABLE services (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  base_price INTEGER NOT NULL,
  category   TEXT
);

CREATE TABLE event_services (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id         INTEGER NOT NULL REFERENCES events(id),
  service_id       INTEGER NOT NULL REFERENCES services(id),
  price_at_booking INTEGER NOT NULL,
  is_crosssell     INTEGER NOT NULL DEFAULT 0,
  added_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE payments (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  amount   INTEGER NOT NULL,
  method   TEXT,
  date     TEXT NOT NULL DEFAULT (datetime('now')),
  note     TEXT
);

-- ── Field ops & access ──────────────────────────────────────────────
CREATE TABLE staff (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL,
  phone TEXT,
  role  TEXT
);

CREATE TABLE event_staff_links (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   INTEGER NOT NULL REFERENCES events(id),
  staff_id   INTEGER REFERENCES staff(id),
  staff_name TEXT,                          -- fallback label if staff isn't in the staff table yet
  token      TEXT NOT NULL UNIQUE,
  scope      TEXT NOT NULL DEFAULT 'expenses,support',
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_links_token ON event_staff_links(token);

CREATE TABLE expenses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id     INTEGER NOT NULL REFERENCES events(id),
  link_id      INTEGER REFERENCES event_staff_links(id),
  category     TEXT NOT NULL,
  amount       INTEGER NOT NULL,
  note         TEXT,
  submitted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE support_requests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   INTEGER NOT NULL REFERENCES events(id),
  link_id    INTEGER REFERENCES event_staff_links(id),
  request    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',   -- pending, acknowledged, resolved
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Seed data — edit prices to match your real rate card before going live ──
INSERT INTO pricing_tiers (name, multiplier, perks) VALUES
  ('Standard', 1.0,  'Core team, 15pg album, 4-week delivery'),
  ('Premium', 1.35,  'Senior shooter, drone, 30pg album, 2-week delivery'),
  ('Signature', 1.8, 'Founder-shot, priority date lock, bespoke album, same-week teaser reel');

INSERT INTO services (name, base_price, category) VALUES
  ('Candid photography', 65000, 'Photo'),
  ('Traditional photography', 40000, 'Photo'),
  ('Cinematic video', 85000, 'Video'),
  ('Drone coverage', 18000, 'Add-on'),
  ('Pre-wedding shoot', 22000, 'Cross-sell'),
  ('Live streaming / LED wall', 15000, 'Cross-sell'),
  ('Album — 30pg premium', 25000, 'Album'),
  ('Album — 40pg premium', 32000, 'Album');
