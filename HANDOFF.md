# HistoryKit Handoff

## Current State

HistoryKit is now an Electron app that imports ChatGPT and Claude exports into the same SQLite database, exposes the indexed data through the MCP server, and adds Claude-specific browsing surfaces in the renderer.

The repo currently includes:
- Claude export import support for `conversations.json`, `design_chats/*.json`, `memories.json`, and Claude project docs
- Claude design/file indexing in SQLite via `claude_design_files` and `claude_design_files_fts`
- Renderer views for Claude design files and a Claude file browser
- A native ChatGPT sync flow that can launch a Chrome debug session and poll auth status
- MCP config wiring for Claude Desktop pointing at the canonical `historykit.db`

Canonical DB:
- `~/Library/Application Support/historykit/historykit.db`

Known current counts after import:
- ChatGPT conversations: 352
- ChatGPT messages: 12,690
- Claude conversations: 54
- Claude messages: 723
- Claude design/file rows: 378

## What Is Already Done

### Claude import and indexing
- Claude export parsing now covers:
  - conversation transcripts
  - design chat tool events
  - attachments
  - links
  - memories
  - project docs
- The importer is repeatable and can be run with:
  - `npm run import:claude -- /Users/basilarif/Downloads/claude-data-export-june9-2026`

### Renderer work
- Added separate sidebar views for:
  - `Design Files`
  - `Claude Files`
- Added a dedicated Sync view auth flow for native ChatGPT sync
- Existing search, browse, profile, sync, and MCP surfaces remain in the app

### Sync/MCP setup
- Claude Desktop config is already set to the project MCP server and canonical DB
- The MCP server build path is:
  - `/Users/basilarif/Desktop/Downloads/Projects/Files - HistoryKit/LLMContextKit/historykit-mcp/dist/index.js`

## Remaining Work

### High priority
1. Tighten the native ChatGPT auth flow.
2. Make the auth flow use a single, canonical Chrome debug profile path.
3. Require a fresh `accessToken` before starting native sync, not just a partially authenticated page state.
4. Surface real auth/DevTools errors instead of collapsing them into generic waiting states.
5. Add a better retry/timeout model for CDP connect and auth polling.

### Medium priority
1. Refactor the auth/probe code so the Electron app and the CLI sync script share the same logic instead of maintaining two different implementations.
2. Add explicit status phases in the UI:
   - launching Chrome
   - waiting for port
   - waiting for sign-in
   - authenticated
   - sync running
   - sync complete / failed
3. Add a more direct way to reset the debug Chrome session when the current profile gets stuck.
4. Improve the Claude file browser so it groups real project files more cleanly and treats tool-generated rows separately from actual file paths.
5. Add a clearer summary of import results in the UI for Claude and ChatGPT sync runs.

### Lower priority
1. Add automated tests for the Claude export parser and the new design-file indexing path.
2. Add UI affordances to jump from Claude design-file entries back into the source conversation.
3. Expand MCP-side memory tooling if that remains a product goal:
   - memory timeline
   - memory conflict detection
   - memory export
   - memory-aware search boosting
   - conversation-to-memory enrichment

## Known Risks

- The native auth flow is still brittle because it depends on Chrome debug targets and a live ChatGPT session.
- The custom CDP/WebSocket path in `src/main/sync.ts` is intentionally dependency-free, but it needs more hardening.
- Tool-generated Claude design rows are indexed alongside real file paths, so some browser entries may need post-processing if the file browser is meant to feel like a literal filesystem.
- The app currently trusts the canonical lowercase `historykit` DB path; older uppercase paths are hard-linked to the same file, but the lowercase path should remain the source of truth.

## Useful Files

- [src/main/db.ts](/Users/basilarif/Desktop/Downloads/Projects/Files%20-%20HistoryKit/LLMContextKit/src/main/db.ts)
- [src/main/parser-claude.ts](/Users/basilarif/Desktop/Downloads/Projects/Files%20-%20HistoryKit/LLMContextKit/src/main/parser-claude.ts)
- [src/main/main.ts](/Users/basilarif/Desktop/Downloads/Projects/Files%20-%20HistoryKit/LLMContextKit/src/main/main.ts)
- [src/main/sync.ts](/Users/basilarif/Desktop/Downloads/Projects/Files%20-%20HistoryKit/LLMContextKit/src/main/sync.ts)
- [src/renderer/src/components/ClaudeDesignView.tsx](/Users/basilarif/Desktop/Downloads/Projects/Files%20-%20HistoryKit/LLMContextKit/src/renderer/src/components/ClaudeDesignView.tsx)
- [src/renderer/src/components/ClaudeFileBrowser.tsx](/Users/basilarif/Desktop/Downloads/Projects/Files%20-%20HistoryKit/LLMContextKit/src/renderer/src/components/ClaudeFileBrowser.tsx)
- [src/renderer/src/components/SyncView.tsx](/Users/basilarif/Desktop/Downloads/Projects/Files%20-%20HistoryKit/LLMContextKit/src/renderer/src/components/SyncView.tsx)
- [scripts/import-claude-export.mjs](/Users/basilarif/Desktop/Downloads/Projects/Files%20-%20HistoryKit/LLMContextKit/scripts/import-claude-export.mjs)

## Verification Commands

```bash
npx tsc --noEmit
npm run build:renderer
npm run import:claude -- /Users/basilarif/Downloads/claude-data-export-june9-2026
npm run sync:chatgpt
```

## Suggested Next Step

Tighten the native ChatGPT auth flow first. That is the highest-risk remaining piece and it is the current point of failure for the sync path.
