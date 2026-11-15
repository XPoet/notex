CREATE TABLE assets_v5 (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  original_name TEXT,
  extension TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  modified_at TEXT
);

INSERT INTO assets_v5 (id, file_name, original_name, extension, relative_path, mime_type, size, width, height, hash, created_at)
SELECT id, file_name, original_name, extension, relative_path, mime_type, size, width, height, hash, created_at FROM assets;

CREATE TABLE note_assets_v5 (
  note_id TEXT NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets_v5 (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (note_id, asset_id)
);

INSERT INTO note_assets_v5 SELECT note_id, asset_id, created_at FROM note_assets;
DROP TABLE note_assets;
DROP TABLE assets;
ALTER TABLE assets_v5 RENAME TO assets;
ALTER TABLE note_assets_v5 RENAME TO note_assets;
CREATE INDEX note_assets_asset_note_index ON note_assets (asset_id, note_id);
CREATE INDEX assets_hash_index ON assets (hash);
