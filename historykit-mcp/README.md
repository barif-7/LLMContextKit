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
read-only mode, and exposes 7 tools:

- `search_conversations` — FTS5 full-text search across all messages
- `semantic_search` — hybrid FTS5 + sqlite-vec semantic search with local Ollama embeddings
- `search_code` — search inside code blocks (filterable by language)
- `get_conversation` — retrieve a full conversation thread by ID
- `get_recent` — last N days of messages
- `list_conversations` — browse and filter by title, with paged minimal enumeration
- `get_stats` — summary statistics about indexed history

## Install

```bash
npm install
npm run build
```

## Semantic Search

Semantic search is local-first. It uses Ollama's `nomic-embed-text` model,
stores vectors in the same HistoryKit SQLite database via `sqlite-vec`, and
does not require OpenAI or Anthropic API keys at runtime.

Install the Ollama model first:

```bash
ollama pull nomic-embed-text
```

Then build the semantic index from existing HistoryKit data:

```bash
npm run semantic:rebuild
```

That command installs dependencies, builds the TypeScript, applies the
idempotent migration, clears any existing semantic vectors, and re-embeds
messages. For incremental indexing of only missing messages, use:

```bash
npm run semantic:update
```

Indexing is resumable. Roughly 11k messages takes about 20-40 minutes on a Mac
mini with `nomic-embed-text`.

You can switch embedding models with environment variables. The vector
dimension must match the model output dimension, and changing models requires a
semantic rebuild:

```bash
OLLAMA_EMBED_MODEL=bge-m3 OLLAMA_EMBED_DIMS=1024 OLLAMA_EMBED_CONTEXT_CHARS=12000 npm run semantic:rebuild
```

Use the same env vars when starting the MCP server so query embeddings use the
same model/table:

```bash
OLLAMA_EMBED_MODEL=bge-m3 OLLAMA_EMBED_DIMS=1024 npm start
```

The default remains `nomic-embed-text` with `768` dimensions for backward
compatibility.

Date filters are opt-in and backward compatible on `search_conversations`,
`search_code`, `semantic_search`, and `list_conversations` via `start_date` and
`end_date` (`YYYY-MM-DD`). `list_conversations` also supports `minimal: true`,
`limit`, and `offset` for enumerating beyond the old 100-result cap.

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
- `src/migrate.ts` — idempotent semantic-search schema migration
- `src/index_embeddings.ts` — resumable Ollama embedding indexer
- All tool responses are JSON strings, designed for agent consumption

Read-only access (`PRAGMA query_only = ON`) means the server can run while
the Electron app is open and writing. SQLite's WAL mode handles the
concurrency.

## Browser sync

The repo includes a Chrome extension at `../historykit-extension/` that syncs
your ChatGPT history directly into the local DB — no manual exports needed.
**Personal use only. Do not publish to the Chrome Web Store.**

### How it works

A local HTTP server (`http_server.ts`) listens on `127.0.0.1:8765` and accepts
conversations POSTed by the Chrome extension. The extension runs in a
chatgpt.com tab, fetches your conversations via ChatGPT's authenticated session,
and sends them to the local server for import.

Sync can be triggered three ways:
- Clicking "Sync now" in the extension popup
- Automatically once per day via `chrome.alarms`
- From the desktop app via `POST /trigger-sync` (long-poll wiring)

### One-time setup

1. Start the HTTP server:

```bash
cd historykit-mcp
npm run build
npm run http
```

2. Load the Chrome extension (unpacked):
   - Open `chrome://extensions/`
   - Enable "Developer mode" (top right)
   - Click "Load unpacked"
   - Select the `historykit-extension/` directory

3. Navigate to [chatgpt.com](https://chatgpt.com) and log in.

4. Click the extension icon and hit "Sync now".

### HTTP server endpoints

| Method | Path                | Description                                     |
|--------|---------------------|-------------------------------------------------|
| GET    | `/health`           | `{"status":"ok"}`                               |
| GET    | `/status`           | DB stats: conversations, messages, days_stale   |
| GET    | `/known-ids`        | `{conv_id: update_time}` for skip-checking      |
| POST   | `/import`           | Upsert conversations; body: `{conversations:[…]}` |
| POST   | `/trigger-sync`     | Triggers any long-polling extension to sync     |
| GET    | `/sync-instruction` | Long-poll; returns `{action:"sync"}` on trigger |

The server binds to `127.0.0.1` only and rejects non-`chrome-extension://`
origins.

## License

MIT
