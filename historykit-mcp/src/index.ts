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
import os from 'os'
import path from 'path'
import fs from 'fs'

import { toolDefinitions, executeTool } from './tools.js'

// ── Locate the HistoryKit database ──────────────────────────────────────

function resolveDbPath(): string {
  if (process.env.HISTORYKIT_DB_PATH) return process.env.HISTORYKIT_DB_PATH

  const home = os.homedir()
  const platform = process.platform

  // Electron's app.getPath('userData') on each platform
  const candidates: string[] = []
  if (platform === 'darwin') {
    candidates.push(path.join(home, 'Library', 'Application Support', 'HistoryKit', 'historykit.db'))
    candidates.push(path.join(home, 'Library', 'Application Support', 'historykit', 'historykit.db'))
  } else if (platform === 'win32') {
    candidates.push(path.join(home, 'AppData', 'Roaming', 'HistoryKit', 'historykit.db'))
  } else {
    candidates.push(path.join(home, '.config', 'HistoryKit', 'historykit.db'))
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }

  throw new Error(
    `HistoryKit database not found. Searched:\n${candidates.map(c => '  ' + c).join('\n')}\n\n` +
    `Set HISTORYKIT_DB_PATH environment variable to override.`
  )
}

// ── Boot ─────────────────────────────────────────────────────────────────

async function main() {
  const dbPath = resolveDbPath()

  // Read-only is safer for an external tool reading data the Electron app
  // also has open. WAL mode means concurrent readers and one writer are OK.
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
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
