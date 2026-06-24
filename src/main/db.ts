import Database from 'better-sqlite3'
import path from 'path'
import { app } from 'electron'

let db: Database.Database

export function initDB() {
  const dbPath = path.join(app.getPath('userData'), 'historykit.db')
  db = new Database(dbPath)

  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = normal')
  db.pragma('temp_store = memory')
  db.pragma('mmap_size = 268435456') // 256MB mmap
  db.pragma('cache_size = -64000')   // 64MB cache

  // Recreate the FTS index only when its schema differs from what we want.
  // Dropping unconditionally on every launch left a crash window with no
  // messages_fts at all (db.exec autocommits per statement) and cost a full
  // O(corpus) rebuild at startup.
  const ftsSql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'messages_fts'`)
    .get() as { sql?: string } | undefined)?.sql ?? ''
  const ftsUpToDate = ftsSql.includes(`tokenize='porter unicode61'`) && ftsSql.includes('content=messages')
  if (ftsSql && !ftsUpToDate) {
    db.exec(`
      DROP TRIGGER IF EXISTS messages_ai;
      DROP TRIGGER IF EXISTS messages_ad;
      DROP TRIGGER IF EXISTS messages_au;
      DROP TABLE IF EXISTS messages_fts;
    `)
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id          TEXT PRIMARY KEY,
      title       TEXT,
      create_time REAL,
      update_time REAL,
      current_node TEXT,
      source      TEXT NOT NULL DEFAULT 'chatgpt'
    );

    CREATE TABLE IF NOT EXISTS messages (
      id               TEXT PRIMARY KEY,
      conv_id          TEXT NOT NULL REFERENCES conversations(id),
      parent_id        TEXT,
      role             TEXT NOT NULL,
      text             TEXT NOT NULL DEFAULT '',
      word_count       INTEGER NOT NULL DEFAULT 0,
      has_code         INTEGER NOT NULL DEFAULT 0,
      has_image        INTEGER NOT NULL DEFAULT 0,
      has_audio        INTEGER NOT NULL DEFAULT 0,
      code_langs       TEXT,        -- JSON array
      create_time      REAL,
      model            TEXT,
      finish_reason    TEXT,
      branch_index     INTEGER NOT NULL DEFAULT 0,
      is_active_branch INTEGER NOT NULL DEFAULT 0,
      depth            INTEGER NOT NULL DEFAULT 0,
      source           TEXT NOT NULL DEFAULT 'chatgpt'
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conv    ON messages(conv_id);
    CREATE INDEX IF NOT EXISTS idx_messages_role    ON messages(role);
    CREATE INDEX IF NOT EXISTS idx_messages_time    ON messages(create_time DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_code    ON messages(has_code) WHERE has_code=1;
    CREATE INDEX IF NOT EXISTS idx_messages_image   ON messages(has_image) WHERE has_image=1;
    CREATE INDEX IF NOT EXISTS idx_messages_active  ON messages(conv_id, is_active_branch);

    CREATE TABLE IF NOT EXISTS code_blocks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL REFERENCES messages(id),
      lang       TEXT NOT NULL DEFAULT '',
      code       TEXT NOT NULL,
      position   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_code_message ON code_blocks(message_id);

    CREATE TABLE IF NOT EXISTS attachments (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id    TEXT NOT NULL,
      conv_id       TEXT NOT NULL,
      type          TEXT NOT NULL DEFAULT 'image',
      asset_pointer TEXT,
      name          TEXT,
      mime_type     TEXT,
      width         INTEGER,
      height        INTEGER,
      size_bytes    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_conv ON attachments(conv_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_type ON attachments(type);

    CREATE TABLE IF NOT EXISTS links (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id    TEXT NOT NULL,
      conv_id       TEXT NOT NULL,
      url           TEXT NOT NULL,
      domain        TEXT,
      title         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_links_conv   ON links(conv_id);
    CREATE INDEX IF NOT EXISTS idx_links_domain ON links(domain);

    CREATE TABLE IF NOT EXISTS memories (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id    TEXT NOT NULL,
      conv_id       TEXT NOT NULL,
      text          TEXT NOT NULL,
      create_time   REAL
    );
    CREATE INDEX IF NOT EXISTS idx_memories_conv ON memories(conv_id);
    CREATE INDEX IF NOT EXISTS idx_memories_time ON memories(create_time DESC);

    CREATE TABLE IF NOT EXISTS attachment_contents (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id  TEXT NOT NULL,
      file_name   TEXT,
      file_type   TEXT,
      file_size   INTEGER,
      content     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_att_content_msg ON attachment_contents(message_id);

    -- Provider-specific message metadata kept out of the core messages table
    -- so common search stays lean. One row per message that carries extra
    -- provenance (provider, Claude project, source file, tool/artifact ids).
    CREATE TABLE IF NOT EXISTS message_metadata (
      message_id         TEXT PRIMARY KEY,
      provider           TEXT NOT NULL,
      kind               TEXT,
      model              TEXT,
      stop_reason        TEXT,
      tool_name          TEXT,
      project_uuid       TEXT,
      project_name       TEXT,
      artifact_id        TEXT,
      workspace_path     TEXT,
      imported_from_file TEXT,
      created_at         REAL
    );
    CREATE INDEX IF NOT EXISTS idx_msg_meta_provider ON message_metadata(provider);
    CREATE INDEX IF NOT EXISTS idx_msg_meta_kind     ON message_metadata(kind);
    CREATE INDEX IF NOT EXISTS idx_msg_meta_project  ON message_metadata(project_name);

    CREATE TABLE IF NOT EXISTS claude_design_files (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      conv_id        TEXT NOT NULL,
      message_id     TEXT NOT NULL,
      project_uuid   TEXT,
      project_name   TEXT,
      file_path      TEXT NOT NULL,
      file_name      TEXT,
      file_type      TEXT,
      operation      TEXT NOT NULL,
      source_kind    TEXT NOT NULL,
      content        TEXT,
      hidden         INTEGER NOT NULL DEFAULT 0,
      created_at     REAL
    );
    CREATE INDEX IF NOT EXISTS idx_claude_design_project ON claude_design_files(project_name);
    CREATE INDEX IF NOT EXISTS idx_claude_design_path ON claude_design_files(file_path);
    CREATE INDEX IF NOT EXISTS idx_claude_design_conv ON claude_design_files(conv_id);

    -- FTS5 for full-text search with BM25 ranking. This is an external-content
    -- table backed by messages, so every indexed column must exist on messages.
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text,
      content=messages,
      content_rowid=rowid,
      tokenize='porter unicode61'
    );

    -- Keep FTS in sync
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text)
      VALUES (new.rowid, new.text);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text)
      VALUES('delete', old.rowid, old.text);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text)
      VALUES('delete', old.rowid, old.text);
      INSERT INTO messages_fts(rowid, text)
      VALUES (new.rowid, new.text);
    END;

    CREATE VIRTUAL TABLE IF NOT EXISTS attachment_contents_fts USING fts5(
      content,
      file_name,
      content=attachment_contents,
      content_rowid=id,
      tokenize='porter unicode61'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS claude_design_files_fts USING fts5(
      file_path,
      file_name,
      content,
      project_name,
      content=claude_design_files,
      content_rowid=id,
      tokenize='porter unicode61'
    );
  `)

  migrateColumn('conversations', 'source', `ALTER TABLE conversations ADD COLUMN source TEXT NOT NULL DEFAULT 'chatgpt'`)
  migrateColumn('messages', 'source', `ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'chatgpt'`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_source ON messages(source)`)

  // Triggers keep the index in sync; a full rebuild is only needed when the
  // FTS table was just (re)created.
  if (!ftsUpToDate) {
    db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`)
  }

  return db
}

function migrateColumn(table: string, column: string, sql: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === column)) {
    db.exec(sql)
  }
}

export function getDB() {
  if (!db) throw new Error('Database not initialized')
  return db
}
