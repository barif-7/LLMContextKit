#!/usr/bin/env node
import Database from 'better-sqlite3'
import { resolveDbPath } from './dbPath.js'
import { getEmbeddingConfig, loadVecExtension, quoteIdentifier } from './vec.js'

function columnExists(db: Database.Database, table: string, column: string): boolean {
  return db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all()
    .some((row: any) => row.name === column)
}

function migrate() {
  const dbPath = resolveDbPath()
  const config = getEmbeddingConfig()
  const db = new Database(dbPath, { fileMustExist: true })

  try {
    loadVecExtension(db)
    db.exec(`
      CREATE TABLE IF NOT EXISTS message_embeddings (
        message_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        date TEXT NOT NULL,
        source TEXT NOT NULL,
        text_preview TEXT NOT NULL,
        embedded_at TEXT NOT NULL,
        embedding_model TEXT NOT NULL DEFAULT 'nomic-embed-text',
        embedding_dim INTEGER NOT NULL DEFAULT 768,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      );

      CREATE INDEX IF NOT EXISTS idx_message_embeddings_date
        ON message_embeddings(date);
      CREATE INDEX IF NOT EXISTS idx_message_embeddings_conv
        ON message_embeddings(conversation_id);
    `)

    if (!columnExists(db, 'message_embeddings', 'embedding_model')) {
      db.exec(`ALTER TABLE message_embeddings ADD COLUMN embedding_model TEXT NOT NULL DEFAULT 'nomic-embed-text';`)
    }
    if (!columnExists(db, 'message_embeddings', 'embedding_dim')) {
      db.exec(`ALTER TABLE message_embeddings ADD COLUMN embedding_dim INTEGER NOT NULL DEFAULT 768;`)
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_message_embeddings_model_dim
        ON message_embeddings(embedding_model, embedding_dim);
    `)

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${quoteIdentifier(config.vectorTable)} USING vec0(
        message_id TEXT PRIMARY KEY,
        embedding FLOAT[${config.dims}]
      );
    `)
    console.log(`Semantic search schema is ready in ${dbPath}`)
    console.log(`Embedding model: ${config.model} (${config.dims} dims), vector table: ${config.vectorTable}`)
  } finally {
    db.close()
  }
}

migrate()
