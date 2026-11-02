ALTER TABLE notes ADD COLUMN content_preview TEXT NOT NULL DEFAULT '';

CREATE TABLE note_search_documents (
  document_id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT NOT NULL UNIQUE REFERENCES notes (id) ON DELETE CASCADE
);

CREATE TABLE search_index_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL CHECK (version >= 0)
);

INSERT INTO search_index_state (id, version) VALUES (1, 0);

CREATE INDEX notes_created_list_index ON notes (is_deleted, is_pinned DESC, created_at DESC, id DESC);
CREATE INDEX notes_title_list_index ON notes (is_deleted, is_pinned DESC, title COLLATE NOCASE ASC, id DESC);
