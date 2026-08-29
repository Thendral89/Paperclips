-- Lets a customer message the studio directly from the public quote page
-- (ask about an add-on, request a change) and the studio reply from the
-- admin quote view. One flat table, both directions — a message thread,
-- not a support-ticket system. A customer message also logs a lead
-- activity so it surfaces on the lead's timeline without the admin having
-- to remember to check every open quote.

CREATE TABLE quote_comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id    INTEGER NOT NULL REFERENCES lead_quotes(id),
  author      TEXT NOT NULL,   -- 'customer' | 'studio'
  author_name TEXT,            -- staff email when author = 'studio'; NULL for a customer message
  message     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_quote_comments_quote ON quote_comments(quote_id);
