# HistoryKit MCP Server

An MCP (Model Context Protocol) server that exposes your local ChatGPT
conversation history (indexed by [HistoryKit](../)) as searchable tools for
coding agents.

Instead of manually finding context in HistoryKit's UI and pasting it into a
prompt, the agent calls the search tools directly — zero token cost for
retrieval, exact matches in milliseconds.

## What it does

Compatible with any MCP client: Claude Desktop, Claude Code, Codex, Cursor,
Cline, Continue, etc.

The server runs as a stdio subprocess, reads HistoryKit's SQLite database in
read-only mode, and exposes 6 tools:

- `search_conversations` — FTS5 full-text search across all messages
- `search_code` — search inside code blocks (filterable by language)
- `get_conversation` — retrieve a full conversation thread by ID
- `get_recent` — last N days of messages
- `list_conversations` — browse and filter by title
- `get_stats` — summary statistics about indexed history

## Install

```bash
npm install
npm run build
```

## Run

```bash
npm start
```

The server reads the HistoryKit database from the standard Electron userData
path for your platform. Override with `HISTORYKIT_DB_PATH=/some/path`.

## Use with Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (or
equivalent for your OS):

```json
{
  "mcpServers": {
    "historykit": {
      "command": "node",
      "args": ["/absolute/path/to/historykit-mcp/dist/index.js"]
    }
  }
}
```

Or, from inside the main HistoryKit project, run:

```bash
npm run mcp:install-claude
```

## Architecture

The server is intentionally minimal:

- `src/index.ts` — boots the MCP server, dispatches tool calls
- `src/tools.ts` — defines tool schemas and SQL implementations
- All tool responses are JSON strings, designed for agent consumption

Read-only access (`PRAGMA query_only = ON`) means the server can run while
the Electron app is open and writing. SQLite's WAL mode handles the
concurrency.

## License

MIT
