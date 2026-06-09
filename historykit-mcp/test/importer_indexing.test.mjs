import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { ensureFtsSchema, upsertConversations } from '../dist/importer.js'

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
  `)
  ensureFtsSchema(db)
  return db
}

test('sync importer indexes side tables and attachment FTS for changed conversations', () => {
  const db = makeDb()
  try {
    const conversation = {
      id: 'conv-sync-indexing',
      title: 'Sync indexing regression',
      create_time: 1710000000,
      update_time: 1710000300,
      current_node: 'bio-msg',
      mapping: {
        root: { id: 'root', parent: null, children: ['user-msg'], message: null },
        'user-msg': {
          id: 'user-msg',
          parent: 'root',
          children: ['tool-msg'],
          message: {
            id: 'user-msg',
            author: { role: 'user' },
            create_time: 1710000100,
            content: {
              parts: [
                'Please review https://example.com/docs\n```swift\nlet synced = true\n```',
                {
                  content_type: 'file',
                  name: 'SyncExample.swift',
                  mime_type: 'text/x-swift',
                  size_bytes: 34,
                },
              ],
            },
            metadata: {},
          },
        },
        'tool-msg': {
          id: 'tool-msg',
          parent: 'user-msg',
          children: ['bio-msg'],
          message: {
            id: 'tool-msg',
            author: { role: 'tool' },
            create_time: 1710000200,
            content: { parts: ['struct SyncExample { let indexed = true }'] },
            metadata: {},
          },
        },
        'bio-msg': {
          id: 'bio-msg',
          parent: 'tool-msg',
          children: [],
          message: {
            id: 'bio-msg',
            author: { role: 'assistant' },
            recipient: 'bio',
            create_time: 1710000300,
            content: { parts: ['User cares about sync indexing parity.'] },
            metadata: {},
          },
        },
      },
    }

    const result = upsertConversations(db, [conversation])

    assert.equal(result.new_count, 1)
    assert.equal(result.message_count, 3)
    assert.equal(result.code_block_count, 1)
    assert.equal(result.attachment_count, 1)
    assert.equal(result.file_content_count, 1)
    assert.equal(result.link_count, 1)
    assert.equal(result.memory_count, 1)

    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM code_blocks').get().n, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attachments').get().n, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM links').get().n, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 1)

    const file = db.prepare('SELECT * FROM attachment_contents').get()
    assert.equal(file.message_id, 'user-msg')
    assert.equal(file.file_name, 'SyncExample.swift')
    assert.match(file.content, /struct SyncExample/)

    const ftsHit = db.prepare(`
      SELECT ac.file_name
      FROM attachment_contents ac
      WHERE ac.id IN (
        SELECT rowid FROM attachment_contents_fts WHERE attachment_contents_fts MATCH 'SyncExample'
      )
    `).get()
    assert.equal(ftsHit.file_name, 'SyncExample.swift')
  } finally {
    db.close()
  }
})
