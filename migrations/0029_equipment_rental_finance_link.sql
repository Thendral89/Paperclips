-- Equipment rental finance linkage
ALTER TABLE event_equipment ADD COLUMN expense_id INTEGER REFERENCES expenses(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_event_equipment_expense ON event_equipment(expense_id);

ALTER TABLE event_equipment ADD COLUMN rental_idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_equipment_rental_idempotency ON event_equipment(rental_idempotency_key) WHERE rental_idempotency_key IS NOT NULL;
