-- Preserve the original accepted commercial value separately from later additions.
ALTER TABLE events ADD COLUMN finalized_quote_total INTEGER;
CREATE INDEX IF NOT EXISTS idx_events_finalized_total ON events(id, finalized_quote_total);