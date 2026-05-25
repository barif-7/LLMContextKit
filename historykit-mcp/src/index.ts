#!/usr/bin/env node
/**
 * HistoryKit MCP server.
 *
 * Exposes the local HistoryKit SQLite database as MCP tools so that Claude
 * Code, Codex, Cursor and other MCP-compatible coding agents can search
 * ChatGPT conversation history mid-task.
 *
 * Communicates over stdio (standard MCP transport).
 *
 * Usage:
 *   node dist/index.js
 *
 * The DB path is read from $HISTORYKIT_DB_PATH or defaults to the standard
 * Electron userData location for macOS.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import Database from 'better-sqlite3'

import { toolDefinitions, executeTool } from './tools.js'
import { resolveDbPath } from './dbPath.js'
import { loadVecExtension } from './vec.js'

// ── Boot ─────────────────────────────────────────────────────────────────

async function main() {
  const dbPath = resolveDbPath()

  // Read-only is safer for an external tool reading data the Electron app
  // also has open. WAL mode means concurrent readers and one writer are OK.
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  loadVecExtension(db)
  db.pragma('journal_mode = WAL')
  db.pragma('query_only = ON')

  // Log to stderr (stdout is reserved for MCP protocol traffic)
  process.stderr.write(`[historykit-mcp] connected to ${dbPath}\n`)

  const server = new Server(
    { name: 'historykit', version: '1.0.0' },
    { capabilities: { tools: {} } }
  )

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions,
  }))

  // Call tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    try {
      const result = await executeTool(name, args ?? {}, db)
      return { content: [{ type: 'text', text: result }] }
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
        isError: true,
      }
    }
  })

  // Connect stdio
  const transport = new StdioServerTransport()
  await server.connect(transport)

  process.stderr.write(`[historykit-mcp] ready — ${toolDefinitions.length} tools exposed\n`)

  // Clean shutdown
  process.on('SIGINT', () => { db.close(); process.exit(0) })
  process.on('SIGTERM', () => { db.close(); process.exit(0) })
}

main().catch(err => {
  process.stderr.write(`[historykit-mcp] fatal: ${err.message}\n`)
  process.exit(1)
})
