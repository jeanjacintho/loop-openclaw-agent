-- "Ignore this kind": what the owner does not want tracked. A new detection
-- that matches a rule is counted and dropped, never recorded.
CREATE TABLE ignore_rules (
  id INTEGER PRIMARY KEY,
  object_kind TEXT,
  type TEXT,
  person_id INTEGER REFERENCES people (id),
  created_at TEXT NOT NULL,
  CHECK (object_kind IS NOT NULL OR type IS NOT NULL OR person_id IS NOT NULL)
);
