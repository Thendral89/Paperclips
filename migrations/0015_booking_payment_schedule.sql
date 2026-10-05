-- Booking-level commercial payment schedule.
CREATE TABLE IF NOT EXISTS booking_payment_schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  due_date TEXT,
  amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Due',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_booking_payment_schedule_booking
  ON booking_payment_schedule(booking_id, due_date, id);