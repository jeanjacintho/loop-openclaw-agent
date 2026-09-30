CREATE TABLE meta (
  schema_version INTEGER NOT NULL
);

-- One row per person Loop has seen; the owner is the row with is_owner = 1.
CREATE TABLE people (
  id INTEGER PRIMARY KEY,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'unknown'
    CHECK (role IN ('investor', 'customer', 'team', 'partner', 'other', 'unknown')),
  org TEXT,
  is_owner INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX people_one_owner ON people (is_owner) WHERE is_owner = 1;

CREATE TABLE handles (
  person_id INTEGER NOT NULL REFERENCES people (id),
  kind TEXT NOT NULL CHECK (kind IN ('email', 'phone', 'plow')),
  value_norm TEXT NOT NULL,
  UNIQUE (kind, value_norm)
);

-- The current state of each commitment. Every column after `band` is derived
-- from its events (ledger.ts `project`) and rewritten with each event.
CREATE TABLE commitments (
  id INTEGER PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction IN ('i_owe', 'they_owe')),
  type TEXT NOT NULL CHECK (type IN ('promise', 'request', 'delegation', 'waiting', 'decision')),
  debtor_id INTEGER NOT NULL REFERENCES people (id),
  creditor_id INTEGER NOT NULL REFERENCES people (id),
  what TEXT NOT NULL,
  what_norm TEXT NOT NULL,
  object_kind TEXT NOT NULL CHECK (object_kind IN ('file', 'intro', 'reply', 'meeting', 'decision', 'other')),
  features_json TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  band TEXT NOT NULL CHECK (band IN ('open', 'candidate')),
  status TEXT NOT NULL CHECK (status IN ('candidate', 'open', 'snoozed', 'done', 'dropped')),
  deadline_kind TEXT NOT NULL CHECK (deadline_kind IN ('date', 'event', 'none')),
  deadline_at TEXT,
  deadline_text TEXT,
  deadline_event TEXT,
  deadline_certainty TEXT,
  expect_until TEXT,
  closed_by TEXT,
  last_nudged_at TEXT,
  last_drafted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX commitments_status ON commitments (status, direction);

CREATE TABLE evidence (
  id INTEGER PRIMARY KEY,
  commitment_id INTEGER NOT NULL REFERENCES commitments (id),
  role TEXT NOT NULL CHECK (role IN ('origin', 'update', 'resolution')),
  source TEXT NOT NULL CHECK (source IN ('gmail', 'imessage', 'plow')),
  item TEXT NOT NULL,
  thread TEXT,
  quote TEXT,
  author_id INTEGER REFERENCES people (id),
  at TEXT NOT NULL,
  UNIQUE (commitment_id, item, role)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  commitment_id INTEGER NOT NULL REFERENCES commitments (id),
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  actor TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX events_commitment ON events (commitment_id, id);

CREATE TABLE edges (
  from_id INTEGER NOT NULL REFERENCES commitments (id),
  to_id INTEGER NOT NULL REFERENCES commitments (id),
  kind TEXT NOT NULL CHECK (kind IN ('blocks')),
  PRIMARY KEY (from_id, to_id, kind)
);
