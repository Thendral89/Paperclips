-- Task metadata required by the configurable operational engine.
ALTER TABLE event_tasks ADD COLUMN phase TEXT NOT NULL DEFAULT 'Pre-Production';
ALTER TABLE event_tasks ADD COLUMN required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_tasks ADD COLUMN template_id INTEGER REFERENCES crm_task_templates(id);
ALTER TABLE event_tasks ADD COLUMN source_quote_item_id INTEGER REFERENCES quote_items(id);

CREATE INDEX IF NOT EXISTS idx_event_tasks_phase ON event_tasks(event_id, phase, status);
