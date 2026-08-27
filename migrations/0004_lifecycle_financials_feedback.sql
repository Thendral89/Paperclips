-- ── Lead lifecycle: distinguish Cancelled from Lost, both still need a
-- reason. Stage itself is unconstrained TEXT (no CHECK in 0001), so no
-- migration needed to add "Cancelled" as a value — enforced in app code.
-- We reuse the existing lost_reason column for both Lost and Cancelled
-- (one "why did this end" field is enough; a second column would just be
-- the same data under a different name). Renamed nowhere — every existing
-- query/report keyed on lost_reason keeps working untouched.

-- ── Event Planner: give the flat pre-event checklist real phase grouping
-- (pre-wedding prep / wedding day / post-wedding delivery), so the addon
-- checklist actually maps to how a shoot really unfolds instead of one
-- undifferentiated list. Existing rows default to 'Pre-wedding' since
-- every current template item is prep work.
ALTER TABLE checklist_templates ADD COLUMN phase TEXT NOT NULL DEFAULT 'Pre-wedding';
ALTER TABLE event_checklist ADD COLUMN phase TEXT NOT NULL DEFAULT 'Pre-wedding';

-- Seed Wedding day / Post-wedding template items so new events get a
-- populated checklist across all three phases out of the box, not just
-- Pre-wedding. Editing/removing these later doesn't touch past events
-- (same snapshot-on-create behavior as the original six).
INSERT INTO checklist_templates (item, sort_order, phase) VALUES
  ('Backup equipment & batteries packed', 7, 'Wedding day'),
  ('Team briefed on shot list & timeline', 8, 'Wedding day'),
  ('Second shooter / drone confirmed on-site', 9, 'Wedding day'),
  ('Raw footage backed up (2 copies)', 10, 'Post-wedding'),
  ('Edit timeline shared with client', 11, 'Post-wedding'),
  ('Album / prints proofing sent', 12, 'Post-wedding'),
  ('Final delivery confirmed', 13, 'Post-wedding'),
  ('Feedback link sent to client', 14, 'Post-wedding');

-- ── Customer feedback: sentiment-gated. Positive responses are routed to
-- your Google review link client-side (see settings below) and never
-- stored here — only negative feedback needs an internal record to act
-- on. `status` tracks whether you've followed up.
CREATE TABLE feedback (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id     INTEGER NOT NULL REFERENCES events(id),
  account_id   INTEGER NOT NULL REFERENCES accounts(id),
  sentiment    TEXT NOT NULL,             -- Positive, Negative
  rating       INTEGER,                   -- optional 1-5, either sentiment
  comment      TEXT,
  status       TEXT NOT NULL DEFAULT 'Open',  -- Open, Resolved (Negative only)
  action_taken TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_feedback_event ON feedback(event_id);
CREATE INDEX idx_feedback_status ON feedback(status);

-- Public feedback link is per-event, keyed by an opaque token rather than
-- the guessable numeric event id (same reasoning as event_staff_links).
-- Generated on demand from the event detail page, not at creation — most
-- events never need it until delivery.
ALTER TABLE events ADD COLUMN feedback_token TEXT;
CREATE UNIQUE INDEX idx_events_feedback_token ON events(feedback_token);

-- ── Financials: monthly running cost, broken out by category, set against
-- that month's revenue for a real P&L (not just per-event profitability,
-- which events already tracked before this migration).
CREATE TABLE monthly_costs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  month      TEXT NOT NULL,   -- 'YYYY-MM'
  category   TEXT NOT NULL,   -- Rent, Salaries, Ad spend, Equipment, Software, Other
  amount     INTEGER NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(month, category)
);
CREATE INDEX idx_monthly_costs_month ON monthly_costs(month);

-- ── Promotions log — what you ran during a slow month and what it
-- produced. Deliberately a plain log, not an ad-attribution engine: you
-- record the campaign and its result, reports surface which months need
-- one.
CREATE TABLE promotions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  channel            TEXT,      -- Instagram, Google Ads, WhatsApp, Referral push, Other
  start_date         TEXT,
  end_date           TEXT,
  cost               INTEGER NOT NULL DEFAULT 0,
  leads_generated    INTEGER,
  bookings_generated INTEGER,
  outcome_notes      TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Settings — single key/value store for the handful of business-level
-- config values that aren't per-record data (currently just the Google
-- review link). Not a vars/secret concern: this is business data staff
-- edit from the admin UI, not deploy-time config.
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
INSERT INTO settings (key, value) VALUES ('google_review_link', '');
