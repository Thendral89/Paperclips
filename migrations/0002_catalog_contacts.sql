-- Paperclip Studios CRM — catalog depth + multi-contact accounts
-- Applied via: wrangler d1 migrations apply paperclip-crm --remote (same CI as before)

-- ── Product catalog: fixed packages, still customizable per event ──────
-- A package is a named bundle sold at its own price (not necessarily the sum
-- of its parts — bundling is usually a discount). package_items is a
-- reference/checklist of what's included, used for delivery/ops docs and to
-- pre-fill a package's contents when you're building one — it does not
-- drive pricing. Applying a package to an event still goes through
-- event_services (below), so admins can freely add more a-la-carte add-ons
-- on top of a package exactly like they can today.
CREATE TABLE packages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT,
  base_price  INTEGER NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE package_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id INTEGER NOT NULL REFERENCES packages(id),
  service_id INTEGER NOT NULL REFERENCES services(id),
  quantity   INTEGER NOT NULL DEFAULT 1,
  UNIQUE(package_id, service_id)
);
CREATE INDEX idx_package_items_package ON package_items(package_id);

-- event_services rebuild: a line item now references EITHER an individual
-- service OR a package (never both) — SQLite/D1 don't support altering a
-- column's NOT NULL/nullability in place, so this is the standard
-- create-copy-drop-rename dance. Existing rows (all individual services
-- today) carry over unchanged with package_id left NULL.
ALTER TABLE event_services RENAME TO event_services_old;

CREATE TABLE event_services (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id         INTEGER NOT NULL REFERENCES events(id),
  service_id       INTEGER REFERENCES services(id),
  package_id       INTEGER REFERENCES packages(id),
  price_at_booking INTEGER NOT NULL,
  is_crosssell     INTEGER NOT NULL DEFAULT 0,
  added_at         TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((service_id IS NOT NULL) != (package_id IS NOT NULL))
);

INSERT INTO event_services (id, event_id, service_id, package_id, price_at_booking, is_crosssell, added_at)
  SELECT id, event_id, service_id, NULL, price_at_booking, is_crosssell, added_at FROM event_services_old;

DROP TABLE event_services_old;
CREATE INDEX idx_event_services_event ON event_services(event_id);

-- ── Multi-contact accounts (bride/groom/planner/family, not just one) ──
-- accounts.name/phone/email stay as-is (the primary/first contact, used in
-- lists) — contacts adds the full picture for Customer 360 without
-- touching any existing convertLead/account code.
CREATE TABLE contacts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  name       TEXT NOT NULL,
  role       TEXT,                 -- Bride, Groom, Planner, Parent, Other — free text by design
  phone      TEXT,
  email      TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_contacts_account ON contacts(account_id);

-- ── Loss-reason capture — cheap, real win/loss analytics later ─────────
ALTER TABLE leads ADD COLUMN lost_reason TEXT;

-- ── Seed a couple of real packages so the catalog isn't empty on day 1 ──
-- Edit/replace these to match your real rate card — same as the services
-- seed in 0001, these are starting points, not gospel.
INSERT INTO packages (name, description, base_price) VALUES
  ('Silver Wedding Package', 'Candid photography + traditional photography, 1 day', 95000),
  ('Gold Wedding Package', 'Candid + cinematic video + drone + 30pg album', 195000);

INSERT INTO package_items (package_id, service_id, quantity)
  SELECT p.id, s.id, 1 FROM packages p, services s
  WHERE p.name = 'Silver Wedding Package' AND s.name IN ('Candid photography', 'Traditional photography');

INSERT INTO package_items (package_id, service_id, quantity)
  SELECT p.id, s.id, 1 FROM packages p, services s
  WHERE p.name = 'Gold Wedding Package' AND s.name IN ('Candid photography', 'Cinematic video', 'Drone coverage', 'Album — 30pg premium');
