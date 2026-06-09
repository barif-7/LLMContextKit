import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { executeTool } from '../dist/tools.js'

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      create_time REAL,
      update_time REAL,
      current_node TEXT,
      source TEXT NOT NULL DEFAULT 'chatgpt'
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conv_id TEXT NOT NULL REFERENCES conversations(id),
      parent_id TEXT,
      role TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      word_count INTEGER NOT NULL DEFAULT 0,
      has_code INTEGER NOT NULL DEFAULT 0,
      has_image INTEGER NOT NULL DEFAULT 0,
      has_audio INTEGER NOT NULL DEFAULT 0,
      code_langs TEXT,
      create_time REAL,
      model TEXT,
      finish_reason TEXT,
      branch_index INTEGER NOT NULL DEFAULT 0,
      is_active_branch INTEGER NOT NULL DEFAULT 0,
      depth INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'chatgpt'
    );

    CREATE VIRTUAL TABLE messages_fts USING fts5(
      text,
      content=messages,
      content_rowid=rowid,
      tokenize='porter unicode61'
    );
  `)

  db.prepare(`
    INSERT INTO conversations (id, title, create_time, update_time, current_node, source)
    VALUES ('conv-empty-buckets', 'Dev Music Service Notes', 1710000000, 1710000100, 'msg-general', 'chatgpt')
  `).run()
  db.prepare(`
    INSERT INTO messages (
      id, conv_id, role, text, word_count, has_code, has_image, has_audio, code_langs,
      create_time, branch_index, is_active_branch, depth, source
    )
    VALUES (
      'msg-general', 'conv-empty-buckets', 'user',
      'dev music service current status is indexed for retrieval notes',
      9, 0, 0, 0, NULL, 1710000100, 0, 1, 1, 'chatgpt'
    )
  `).run()
  db.exec(`
    INSERT INTO messages_fts(rowid, text)
    SELECT rowid, text FROM messages;
  `)

  return db
}

test('get_context_pack renders [not in index] for empty buckets', async () => {
  const db = makeDb()
  try {
    const markdown = await executeTool('get_context_pack', { project: 'dev-music-service' }, db)

    assert.match(markdown, /^# Context Pack: dev-music-service/m)
    assert.match(markdown, /## Current state\n\*\*\[not in index\]\*\*/)
    assert.match(markdown, /## Key decisions\n\*\*\[not in index\]\*\*/)
    assert.match(markdown, /## Open loops\n\*\*\[not in index\]\*\*/)
    assert.match(markdown, /## Relevant code\n\*\*\[not in index\]\*\*/)
    assert.match(markdown, /\[conv#msgg\]/)
    assert.match(markdown, /conv-empty-buckets#msg-general/)
  } finally {
    db.close()
  }
})
