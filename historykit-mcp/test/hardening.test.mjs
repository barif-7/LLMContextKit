// Regression tests for the P0/P1 hardening fixes (see AUDIT.md):
// cycle guards, null-node tolerance, orphan-vector purge, and
// semantic_search degradation when Ollama is unreachable.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { ensureFtsSchema, upsertConversations } from '../dist/importer.js'

// vec.js reads OLLAMA_* env at module load, so set a dead endpoint BEFORE
// dynamically importing it (static imports would hoist past the assignment).
process.env.OLLAMA_EMBEDDINGS_URL = 'http://127.0.0.1:1/api/embeddings'
process.env.OLLAMA_EMBED_TIMEOUT_MS = '2000'
const { loadVecExtension, getEmbeddingConfig, quoteIdentifier } = await import('../dist/vec.js')
const { executeTool } = await import('../dist/tools.js')

const BASE_SCHEMA = `
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
`

function makeDb(dbPath = ':memory:') {
  const db = new Database(dbPath)
  db.exec(BASE_SCHEMA)
  ensureFtsSchema(db)
  return db
}

function msgNode(id, parent, role, text) {
  return {
    id,
    parent,
    children: [],
    message: {
      id,
      author: { role },
      create_time: 1710000100,
      content: { parts: [text] },
      metadata: {},
    },
  }
}

test('importer terminates on a parent-pointer cycle and keeps valid messages', () => {
  const db = makeDb()
  try {
    const conversation = {
      id: 'conv-cycle',
      title: 'Cycle regression',
      update_time: 1710000300,
      // current_node points INTO the cycle: before the guard, the
      // active-path trace looped forever on cycle-a -> cycle-b -> cycle-a.
      current_node: 'cycle-a',
      mapping: {
        root: msgNode('root', null, 'user', 'root message of a healthy chain'),
        m1: msgNode('m1', 'root', 'assistant', 'a normal reachable reply'),
        'cycle-a': msgNode('cycle-a', 'cycle-b', 'user', 'message inside cycle a'),
        'cycle-b': msgNode('cycle-b', 'cycle-a', 'assistant', 'message inside cycle b'),
      },
    }

    const result = upsertConversations(db, [conversation])
    assert.equal(result.errored_count, 0)
    // The healthy root chain imports; the rootless cycle nodes are skipped.
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE conv_id = 'conv-cycle'`).get().n, 2)
  } finally {
    db.close()
  }
})

test('importer tolerates null mapping nodes', () => {
  const db = makeDb()
  try {
    const conversation = {
      id: 'conv-null-node',
      title: 'Null node regression',
      update_time: 1710000300,
      current_node: 'good-msg',
      mapping: {
        'bad-node': null,
        'good-msg': msgNode('good-msg', 'bad-node', 'user', 'survives a null sibling node'),
      },
    }

    const result = upsertConversations(db, [conversation])
    assert.equal(result.errored_count, 0)
    assert.equal(result.new_count, 1)
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE conv_id = 'conv-null-node'`).get().n, 1)
  } finally {
    db.close()
  }
})

test('one malformed conversation does not abort the batch', () => {
  const db = makeDb()
  try {
    const good = {
      id: 'conv-good',
      title: 'Good conversation',
      update_time: 1710000300,
      current_node: 'g1',
      mapping: { g1: msgNode('g1', null, 'user', 'a perfectly fine message') },
    }
    const bad = { title: 'No id at all', update_time: 1710000300, mapping: {} }

    const result = upsertConversations(db, [bad, good])
    assert.equal(result.errored_count, 1)
    assert.equal(result.new_count, 1)
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM conversations`).get().n, 1)
  } finally {
    db.close()
  }
})

test('index_embeddings purges orphaned vectors left by re-imports', () => {
  const config = getEmbeddingConfig()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-orphan-test-'))
  const dbPath = path.join(dir, 'historykit.db')
  const db = makeDb(dbPath)
  try {
    loadVecExtension(db)
    db.exec(`
      CREATE TABLE message_embeddings (
        message_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        date TEXT NOT NULL,
        source TEXT NOT NULL,
        text_preview TEXT NOT NULL,
        embedded_at TEXT NOT NULL,
        embedding_model TEXT NOT NULL DEFAULT 'nomic-embed-text',
        embedding_dim INTEGER NOT NULL DEFAULT 768
      );
      CREATE VIRTUAL TABLE ${quoteIdentifier(config.vectorTable)} USING vec0(
        message_id TEXT PRIMARY KEY,
        embedding FLOAT[${config.dims}]
      );
    `)

    // One embedded message that still has metadata, one orphaned vector
    // whose metadata was deleted by a conversation re-import.
    db.prepare(`INSERT INTO conversations (id, title) VALUES ('c1', 'Conv')`).run()
    db.prepare(`
      INSERT INTO messages (id, conv_id, role, text, create_time)
      VALUES ('kept', 'c1', 'user', 'kept message text that is long enough', 1710000100)
    `).run()
    db.prepare(`
      INSERT INTO message_embeddings (message_id, conversation_id, role, date, source, text_preview, embedded_at, embedding_model, embedding_dim)
      VALUES ('kept', 'c1', 'user', '2024-03-09', 'chatgpt', 'kept', '2024-03-09T00:00:00Z', ?, ?)
    `).run(config.model, config.dims)
    const vec = new Float32Array(config.dims).fill(0.5)
    const insertVec = db.prepare(`INSERT INTO ${quoteIdentifier(config.vectorTable)}(message_id, embedding) VALUES (?, ?)`)
    insertVec.run('kept', vec)
    insertVec.run('orphan', vec)
    db.close()

    // No pending messages -> the script purges orphans and exits without
    // ever calling Ollama.
    const out = execFileSync(process.execPath, [path.join(import.meta.dirname, '..', 'dist', 'index_embeddings.js')], {
      env: { ...process.env, HISTORYKIT_DB_PATH: dbPath },
      encoding: 'utf8',
    })
    assert.match(out, /Purged 1 orphaned vector/)

    const check = new Database(dbPath, { readonly: true })
    loadVecExtension(check)
    assert.equal(check.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdentifier(config.vectorTable)}`).get().n, 1)
    assert.equal(check.prepare(`SELECT message_id FROM ${quoteIdentifier(config.vectorTable)}`).get().message_id, 'kept')
    check.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('semantic_search degrades to FTS-only when Ollama is unreachable', async () => {
  const config = getEmbeddingConfig()
  const db = makeDb()
  try {
    loadVecExtension(db)
    db.exec(`
      CREATE TABLE message_embeddings (
        message_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        date TEXT NOT NULL,
        source TEXT NOT NULL,
        text_preview TEXT NOT NULL,
        embedded_at TEXT NOT NULL,
        embedding_model TEXT NOT NULL DEFAULT 'nomic-embed-text',
        embedding_dim INTEGER NOT NULL DEFAULT 768
      );
      CREATE VIRTUAL TABLE ${quoteIdentifier(config.vectorTable)} USING vec0(
        message_id TEXT PRIMARY KEY,
        embedding FLOAT[${config.dims}]
      );
    `)
    db.prepare(`INSERT INTO conversations (id, title) VALUES ('c1', 'Degradation test')`).run()
    db.prepare(`
      INSERT INTO messages (id, conv_id, role, text, create_time, is_active_branch)
      VALUES ('m1', 'c1', 'user', 'tell me about gravitational lensing please', 1710000100, 1)
    `).run()
    db.prepare(`
      INSERT INTO message_embeddings (message_id, conversation_id, role, date, source, text_preview, embedded_at, embedding_model, embedding_dim)
      VALUES ('m1', 'c1', 'user', '2024-03-09', 'chatgpt', 'preview', '2024-03-09T00:00:00Z', ?, ?)
    `).run(config.model, config.dims)
    db.prepare(`INSERT INTO ${quoteIdentifier(config.vectorTable)}(message_id, embedding) VALUES (?, ?)`)
      .run('m1', new Float32Array(config.dims).fill(0.5))

    const res = JSON.parse(await executeTool('semantic_search', { query: 'gravitational lensing', k: 5 }, db))
    assert.equal(res.semantic_degraded, true)
    assert.match(res.degraded_reason, /FTS-only/)
    assert.equal(res.result_count, 1)
    assert.equal(res.results[0].message_id, 'm1')
    assert.equal(res.results[0].vector_rank, null)
  } finally {
    db.close()
  }
})
