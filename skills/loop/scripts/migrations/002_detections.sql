-- Every extraction the poll recorded, kept or not: what the model said about
-- the message (features), what the script decided (band), and the commitment
-- it became. The owner's later confirmations and rejections of those
-- commitments are what the precision by band is measured against.
CREATE TABLE detections (
  id INTEGER PRIMARY KEY,
  item TEXT NOT NULL,
  source TEXT NOT NULL,
  is_commitment INTEGER NOT NULL,
  band TEXT NOT NULL CHECK (band IN ('open', 'candidate', 'drop', 'none', 'update')),
  features_json TEXT,
  commitment_id INTEGER REFERENCES commitments (id),
  at TEXT NOT NULL
);
CREATE INDEX detections_item ON detections (item);

-- One row: how far the open cut has been raised by the owner's corrections.
CREATE TABLE calibration (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  open_raise INTEGER NOT NULL DEFAULT 0,
  raised_at TEXT,
  notified_at TEXT
);
