-- Two people who may be the same (same name, no shared handle). Loop never
-- merges them on its own: it asks the owner once, in the digest.
CREATE TABLE person_questions (
  a_id INTEGER NOT NULL REFERENCES people (id),
  b_id INTEGER NOT NULL REFERENCES people (id),
  created_at TEXT NOT NULL,
  asked_at TEXT,
  answer TEXT CHECK (answer IN ('same', 'different')),
  PRIMARY KEY (a_id, b_id),
  CHECK (a_id < b_id)
);
