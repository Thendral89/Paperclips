-- Work resource allocations v1
-- Separate Work allocations from legacy Event Resource allocations so one
-- resource can legitimately serve multiple Work Items on the same Event,
-- provided their time windows do not overlap.

CREATE TABLE IF NOT EXISTS event_work_resource_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id INTEGER NOT NULL REFERENCES event_work_items(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  resource_id INTEGER NOT NULL REFERENCES resources(id),
  skill_id INTEGER REFERENCES skills(id),
  start_at TEXT,
  end_at TEXT,
  original_estimate INTEGER NOT NULL DEFAULT 0,
  revised_estimate INTEGER,
  actual_paid INTEGER NOT NULL DEFAULT 0,
  payment_date TEXT,
  status TEXT NOT NULL DEFAULT 'Planned',
  override_reason TEXT,
  override_note TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_work_resource_work
  ON event_work_resource_allocations(work_item_id,status);
CREATE INDEX IF NOT EXISTS idx_work_resource_event
  ON event_work_resource_allocations(event_id,start_at,end_at);
CREATE INDEX IF NOT EXISTS idx_work_resource_conflict
  ON event_work_resource_allocations(resource_id,start_at,end_at,status);

CREATE TABLE IF NOT EXISTS event_work_resource_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  allocation_id INTEGER REFERENCES event_work_resource_allocations(id) ON DELETE SET NULL,
  work_item_id INTEGER NOT NULL REFERENCES event_work_items(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  reason TEXT,
  note TEXT,
  changed_by TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_work_resource_history_work
  ON event_work_resource_history(work_item_id,changed_at);
CREATE INDEX IF NOT EXISTS idx_work_resource_history_event
  ON event_work_resource_history(event_id,changed_at);
