-- Equipment rental finance linkage
ALTER TABLE event_equipment ADD COLUMN expense_id INTEGER REFERENCES expenses(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_event_equipment_expense ON event_equipment(expense_id);
