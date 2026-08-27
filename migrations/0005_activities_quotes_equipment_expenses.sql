-- ── Lead activities — replaces the plain notes list with a typed timeline
-- (Call, WhatsApp, Email, Meeting, Site visit, Quote sent, Quote viewed,
-- Note, Other) so "what's actually happened on this lead" is legible at a
-- glance instead of undifferentiated free text. Existing lead_notes rows
-- are carried over as activity_type='Note' before the old table is retired
-- — no history lost.
CREATE TABLE lead_activities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id       INTEGER NOT NULL REFERENCES leads(id),
  activity_type TEXT NOT NULL,
  description   TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_lead_activities_lead ON lead_activities(lead_id);

INSERT INTO lead_activities (lead_id, activity_type, description, created_by, created_at)
  SELECT lead_id, 'Note', note, author, created_at FROM lead_notes;

DROP TABLE lead_notes;

-- ── Quotes — sent while a lead is in "Quoted" (Quote in progress). Admin
-- builds it (tier + base package + optional add-ons + an admin-only
-- concession); the customer views it on a token-gated public page where
-- they can toggle add-ons on/off to explore options but everything else
-- is read-only. Every view is logged, both as a running counter on the
-- quote and as individual timestamped rows, so staff can see not just
-- "viewed" but how many times and how recently — the actual engagement
-- signal for prioritising a lead.
CREATE TABLE lead_quotes (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id            INTEGER NOT NULL REFERENCES leads(id),
  token              TEXT NOT NULL,
  pricing_tier_id    INTEGER REFERENCES pricing_tiers(id),
  concession_amount  INTEGER NOT NULL DEFAULT 0,
  concession_note    TEXT,
  status             TEXT NOT NULL DEFAULT 'Draft',  -- Draft, Sent, Viewed, Accepted, Rejected, Expired
  valid_until        TEXT,
  view_count         INTEGER NOT NULL DEFAULT 0,
  last_viewed_at     TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_lead_quotes_token ON lead_quotes(token);
CREATE INDEX idx_lead_quotes_lead ON lead_quotes(lead_id);

CREATE TABLE quote_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id   INTEGER NOT NULL REFERENCES lead_quotes(id),
  service_id INTEGER REFERENCES services(id),
  package_id INTEGER REFERENCES packages(id),
  label      TEXT NOT NULL,               -- snapshotted name, stable even if the catalog changes later
  price      INTEGER NOT NULL,
  is_addon   INTEGER NOT NULL DEFAULT 0,  -- 0 = base/included, 1 = optional and customer-toggleable
  selected   INTEGER NOT NULL DEFAULT 1   -- current include/exclude state
);
CREATE INDEX idx_quote_items_quote ON quote_items(quote_id);

CREATE TABLE quote_views (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id  INTEGER NOT NULL REFERENCES lead_quotes(id),
  viewed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_quote_views_quote ON quote_views(quote_id);

-- ── Equipment resourcing — the other half of "are we event-ready" besides
-- staff. A studio-owned catalog (owned=1) plus a per-event checklist that
-- also accepts one-off items not in the catalog (custom_label). Anything
-- flagged needs_rental=1 is the trigger to add a matching cost line under
-- Outside vendors — this table tracks READINESS, not cost; the vendor
-- flow (already built) tracks the money.
CREATE TABLE equipment (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  category   TEXT,                      -- Camera, Lens, Drone, Lighting, Audio, Other
  owned      INTEGER NOT NULL DEFAULT 1, -- 1 = studio-owned, 0 = always rented
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE event_equipment (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id      INTEGER NOT NULL REFERENCES events(id),
  equipment_id  INTEGER REFERENCES equipment(id),
  custom_label  TEXT,
  needs_rental  INTEGER NOT NULL DEFAULT 0,
  ready         INTEGER NOT NULL DEFAULT 0,
  notes         TEXT
);
CREATE INDEX idx_event_equipment_event ON event_equipment(event_id);

-- ── Expenses — event_id becomes optional so office/miscellaneous spend
-- (not tied to any shoot) can live in the same ledger as event costs
-- instead of needing a fake event to attach to. SQLite can't ALTER a
-- column's NOT NULL in place, so this is the standard rebuild: new table,
-- copy, drop, rename. Nothing else about the table changes — same columns,
-- same meaning, existing per-event cost totals are unaffected.
CREATE TABLE expenses_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id     INTEGER REFERENCES events(id),
  link_id      INTEGER REFERENCES event_staff_links(id),
  category     TEXT NOT NULL,
  amount       INTEGER NOT NULL,
  note         TEXT,
  submitted_at TEXT
);
INSERT INTO expenses_new (id, event_id, link_id, category, amount, note, submitted_at)
  SELECT id, event_id, link_id, category, amount, note, submitted_at FROM expenses;
DROP TABLE expenses;
ALTER TABLE expenses_new RENAME TO expenses;
CREATE INDEX idx_expenses_event ON expenses(event_id);
CREATE INDEX idx_expenses_category ON expenses(category);
