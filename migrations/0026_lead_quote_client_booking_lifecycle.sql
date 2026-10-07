-- Lead / Quote / Client / Booking lifecycle alignment
-- Additive and backward-compatible. Existing records remain intact.

-- 1. Lead captures the commercial/event context before conversion.
ALTER TABLE leads ADD COLUMN venue TEXT;

-- 2. Leads can have multiple contacts. The existing lead phone/email remain
-- the primary lead-level fields for backward compatibility.
CREATE TABLE IF NOT EXISTS lead_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT,
  phone TEXT,
  email TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lead_contacts_lead ON lead_contacts(lead_id,is_primary,id);

-- 3. Quote lifecycle/versioning.
ALTER TABLE lead_quotes ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE lead_quotes ADD COLUMN revision_of_quote_id INTEGER REFERENCES lead_quotes(id) ON DELETE SET NULL;
ALTER TABLE lead_quotes ADD COLUMN finalized_at TEXT;
ALTER TABLE lead_quotes ADD COLUMN finalized_by TEXT;
CREATE INDEX IF NOT EXISTS idx_lead_quotes_revision ON lead_quotes(revision_of_quote_id);
CREATE INDEX IF NOT EXISTS idx_lead_quotes_lifecycle ON lead_quotes(lead_id,status,version);

-- 4. Accepted quotes create a Booking; Events remain operational children of Booking.
-- Existing booking records are preserved. This index makes idempotent conversion safe.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_quote_unique
  ON bookings(quote_id)
  WHERE quote_id IS NOT NULL;

-- 5. Booking-level commercial snapshot.
ALTER TABLE bookings ADD COLUMN quote_snapshot_json TEXT;
ALTER TABLE bookings ADD COLUMN finalized_quote_total INTEGER NOT NULL DEFAULT 0;

-- 6. Contacts copied from Lead to Client retain their role/primary semantics.
ALTER TABLE contacts ADD COLUMN role TEXT;

-- 7. Ensure every migrated quote has a sensible version.
UPDATE lead_quotes SET version=1 WHERE version IS NULL OR version < 1;

-- 8. Legacy status values remain readable. Finalized is the new immutable
-- commercial checkpoint; Accepted remains the conversion/commitment state.
