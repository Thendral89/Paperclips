-- Preserve the original accepted commercial value separately from later additions.
ALTER TABLE events ADD COLUMN finalized_quote_total INTEGER;
CREATE INDEX IF NOT EXISTS idx_events_finalized_total ON events(id, finalized_quote_total);
UPDATE events SET finalized_quote_total=quote_total WHERE commercial_finalized_at IS NOT NULL AND finalized_quote_total IS NULL;