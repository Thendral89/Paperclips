-- Resource allocation scheduling precision
-- Start/end are full date-time values so multi-day post-production work is modeled correctly.
ALTER TABLE event_resource_allocations ADD COLUMN start_at TEXT;
ALTER TABLE event_resource_allocations ADD COLUMN end_at TEXT;

UPDATE event_resource_allocations
SET start_at = CASE
  WHEN allocation_date IS NOT NULL AND start_time IS NOT NULL THEN allocation_date || 'T' || start_time
  ELSE start_at END
WHERE start_at IS NULL;

UPDATE event_resource_allocations
SET end_at = CASE
  WHEN allocation_date IS NOT NULL AND end_time IS NOT NULL THEN allocation_date || 'T' || end_time
  ELSE end_at END
WHERE end_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_resource_allocations_datetime
  ON event_resource_allocations(resource_id, start_at, end_at);
