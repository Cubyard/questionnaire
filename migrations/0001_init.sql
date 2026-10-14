CREATE TABLE polls (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  questions TEXT NOT NULL,      -- JSON array of questions
  settings TEXT NOT NULL,       -- JSON object
  status TEXT NOT NULL CHECK (status IN ('draft', 'open', 'closed')),
  closes_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE responses (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  respondent_id TEXT NOT NULL,  -- random id the browser keeps, for one-response-per-person
  ip_hash TEXT NOT NULL,        -- salted hash, never the raw address
  answers TEXT NOT NULL,        -- JSON object keyed by question id
  created_at TEXT NOT NULL
);

CREATE INDEX idx_responses_poll ON responses (poll_id, created_at);
CREATE INDEX idx_responses_respondent ON responses (poll_id, respondent_id);
