-- Google Calendar sync state for CRM events and lead follow-ups.
-- The CRM remains the source of truth; these tables only store the remote
-- Google event ID and the last sync/error state.

CREATE TABLE calendar_event_sync (
  event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  google_event_id TEXT NOT NULL,
  synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_error TEXT
);

CREATE INDEX idx_calendar_event_sync_google_event
  ON calendar_event_sync(google_event_id);

CREATE TABLE calendar_followup_sync (
  lead_id INTEGER PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
  google_event_id TEXT NOT NULL,
  synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_error TEXT
);

CREATE INDEX idx_calendar_followup_sync_google_event
  ON calendar_followup_sync(google_event_id);
