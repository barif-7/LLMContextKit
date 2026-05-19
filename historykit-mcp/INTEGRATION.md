# Coding Agent: HistoryKit MCP Integration

You are integrating an MCP (Model Context Protocol) server extension into the
existing HistoryKit project. The MCP server exposes HistoryKit's local SQLite
database as searchable tools that coding agents like Claude Code, Codex, and
Cursor can call mid-task.

This document is a step-by-step integration plan. Execute each step in order.

---

## Context

HistoryKit is an Electron + React app that indexes ChatGPT `conversations.json`
exports into a local SQLite database with these tables:

- `conversations` (id, title, create_time, update_time, current_node)
- `messages` (id, conv_id, role, text, has_code, has_image, is_active_branch, …)
- `code_blocks` (id, message_id, lang, code, position)
- `attachments` (id, message_id, asset_pointer, type, width, height, …)
- `messages_fts` (FTS5 virtual table over messages.text)

The Electron app writes to this database. The MCP server reads from it in
READ-ONLY mode, so the two can run concurrently without locking conflicts.

---

## Step 1 — Place the MCP server files

The MCP server is provided as a self-contained subproject in `historykit-mcp/`.
Copy this folder into the HistoryKit project root so the layout becomes:

```
historykit/
├── src/                    ← existing Electron + React app
├── historykit-mcp/         ← NEW: the MCP server
│   ├── src/
│   │   ├── index.ts        ← stdio server entry
│   │   └── tools.ts        ← 6 MCP tools + SQL
│   ├── package.json
│   └── tsconfig.json
├── package.json
└── ...
```

The MCP server is a SEPARATE npm package with its own `package.json` and
`node_modules`. Do not merge it into the main project. Keeping it isolated
means:

- It can be invoked as a standalone binary by MCP clients
- Its dependencies don't bloat the Electron bundle
- It can be published to npm independently later

---

## Step 2 — Install and build the MCP server

From inside the `historykit-mcp/` folder:

```bash
cd historykit-mcp
npm install
npm run build
```

This produces `historykit-mcp/dist/index.js`, an executable Node script.

Verify it built correctly:

```bash
ls dist/
# Should show: index.js  tools.js
```

---

## Step 3 — Test the MCP server can find the database

The server auto-locates the HistoryKit database based on platform:

- macOS:   `~/Library/Application Support/HistoryKit/historykit.db`
- Linux:   `~/.config/HistoryKit/historykit.db`
- Windows: `%APPDATA%\HistoryKit\historykit.db`

Test that it boots and finds the DB:

```bash
node dist/index.js
```

Expected output (on stderr):

```
[historykit-mcp] connected to /Users/.../historykit.db
[historykit-mcp] ready — 6 tools exposed
```

The process will hang waiting for MCP messages on stdin. Kill it with Ctrl-C.

If you see "HistoryKit database not found", export the path explicitly:

```bash
HISTORYKIT_DB_PATH=/exact/path/to/historykit.db node dist/index.js
```

---

## Step 4 — Add the convenience launcher to the main project

Open the ROOT `historykit/package.json` (not the MCP one). Add these scripts
inside the existing `"scripts"` block:

```json
"mcp:build": "cd historykit-mcp && npm install && npm run build",
"mcp:start": "node historykit-mcp/dist/index.js",
"mcp:install-claude": "node scripts/install-claude-mcp.js"
```

Do not remove or rename any existing scripts. Just add these three.

---

## Step 5 — Create the Claude Desktop / Claude Code installer script

Create `historykit/scripts/install-claude-mcp.js` with this content:

```javascript
#!/usr/bin/env node
/**
 * Adds HistoryKit to the local Claude Desktop config so the agent can call
 * its tools without manual JSON editing.
 */
const fs = require('fs')
const path = require('path')
const os = require('os')

const platform = process.platform
let configPath
if (platform === 'darwin') {
  configPath = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
} else if (platform === 'win32') {
  configPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')
} else {
  configPath = path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json')
}

const serverPath = path.resolve(__dirname, '..', 'historykit-mcp', 'dist', 'index.js')

if (!fs.existsSync(serverPath)) {
  console.error(`MCP server not built. Run: npm run mcp:build`)
  process.exit(1)
}

let config = {}
if (fs.existsSync(configPath)) {
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) } catch {}
}
config.mcpServers = config.mcpServers || {}
config.mcpServers.historykit = {
  command: 'node',
  args: [serverPath],
}

fs.mkdirSync(path.dirname(configPath), { recursive: true })
fs.writeFileSync(configPath, JSON.stringify(config, null, 2))

console.log(`HistoryKit MCP installed to:`)
console.log(`  ${configPath}`)
console.log(`\nRestart Claude Desktop / Claude Code to load the new server.`)
```

Make it executable:

```bash
chmod +x scripts/install-claude-mcp.js
```

---

## Step 6 — Update the main README

Append this section to the root `historykit/README.md`:

```markdown
## MCP Server (for coding agents)

HistoryKit ships with an MCP server that lets Claude Code, Codex, Cursor, and
other MCP-compatible agents query your conversation history mid-task. Instead
of manually finding context in the UI and pasting it, the agent does the
retrieval autonomously.

### Setup

```bash
npm run mcp:build           # compile the MCP server
npm run mcp:install-claude  # register it with Claude Desktop/Code
```

Restart Claude Desktop and the `historykit` server will appear in your
available tools. From within Claude Code, ask things like:

- "Search my history for previous singleton pattern implementations in Swift"
- "What did I work on last week that involved React hooks?"
- "Show me all conversations about the Patreon interview"

### Tools exposed

| Tool | Purpose |
|---|---|
| `search_conversations` | FTS5 search across all messages |
| `search_code` | Search inside code blocks, optionally by language |
| `get_conversation` | Pull full thread by conv_id |
| `get_recent` | Last N days of messages |
| `list_conversations` | Browse / filter by title |
| `get_stats` | Summary of indexed history |

### Manual configuration

If you use a different MCP client, add this to its config:

```json
{
  "mcpServers": {
    "historykit": {
      "command": "node",
      "args": ["/absolute/path/to/historykit/historykit-mcp/dist/index.js"]
    }
  }
}
```
```

---

## Step 7 — Verify end-to-end

1. Run the Electron app once to ensure the DB has data:
   ```bash
   npm run dev
   ```

2. Quit the app (it will continue to work after — the DB persists).

3. Build and install the MCP server:
   ```bash
   npm run mcp:build
   npm run mcp:install-claude
   ```

4. Restart Claude Desktop / Claude Code.

5. In a new Claude conversation, ask:
   > "Use the historykit MCP server to search my history for 'singleton'"

   Claude should call `search_conversations` and return matching messages
   with conversation IDs.

---

## Constraints — do not violate these

- The MCP server is READ-ONLY against the database. Do not add any write
  operations. The Electron app is the only writer.

- Do not modify the schema of the HistoryKit database to accommodate the MCP
  server. The schema is already correct for these queries.

- Do not embed the MCP server code into the Electron main process. It must
  remain a standalone subprocess so MCP clients can spawn it independently.

- Tool responses must always be JSON strings (already handled in tools.ts —
  do not change to YAML, XML, or plain prose).

- The `process.stderr.write(...)` calls in index.ts are intentional. stdout
  is reserved for the MCP protocol; logging must go to stderr.

---

## Files created in this task

- `historykit-mcp/src/index.ts` (entry, stdio server)
- `historykit-mcp/src/tools.ts` (tool definitions + SQL)
- `historykit-mcp/package.json`
- `historykit-mcp/tsconfig.json`
- `scripts/install-claude-mcp.js` (config installer)
- `README.md` (appended section)
- `package.json` (added 3 scripts)

That is the full integration. No other files should be modified.
