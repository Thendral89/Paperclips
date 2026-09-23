-- Calendar timing fields for CRM events. Existing events remain valid with NULL times.
ALTER TABLE events ADD COLUMN start_time TEXT;
ALTER TABLE events ADD COLUMN end_time TEXT;
ALTER TABLE events ADD COLUMN reporting_time TEXT;
