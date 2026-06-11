# Semantic Search Backfill Post-Mortem — nomic-embed-text baseline

## Config
| | |
|---|---|
| Model | `nomic-embed-text` (768 dims) via Ollama `http://127.0.0.1:11434/api/embeddings` |
| Vector table | `message_vectors` (sqlite-vec vec0, `FLOAT[768]`, dimension derived from config) |
| Machine | Basils-MacBook-Pro.local, arm64 (Apple M2 Pro), Node v22.22.3 |
| Git SHA | d66b36d |
| Run | 2026-06-11T05:16:42Z → 05:25:41Z |

## Headline numbers
- **11,200 / 11,200 eligible messages embedded** (13,693 total; 2,493 skipped by the noise filter: <20 chars or tool/tool_result role). 0 failed messages.
- **538.4 s wall clock ≈ 9 min** — **20.8 msgs/sec**, **28,560 chars/sec** (15.38 M chars sent). chars/sec is the cross-model comparison metric.
- Embed-call latency: min 10 ms / median 17 ms / p95 191 ms / max 300 ms. Sequential (concurrency 1), DB commit batch 50.
- 188 embed calls got context-overflow HTTP 500s and were retried at smaller char counts (8000→6000→4000→2500→1200); all recovered.
- Peak RSS 188 MB. `get_stats` now reports `semantic_indexed_messages: 11200`.

## What gets embedded (the rule)
**prose+code.** `messages.text` is embedded verbatim, head-truncated to 8,000 chars (`OLLAMA_EMBED_CONTEXT_CHARS`). The importer inlines code in the text with ``` fences, so code content IS in the embedding up to the cap. No chunking — one vector per message.

Population: **22.7%** of eligible messages have code; **5.1%** are code-heavy (code/total chars > 0.6); **96** are near-pure code (> 0.9). See `embed-audit.json`.

## Where vector beat FTS
1. **"the database driver broke after a runtime upgrade"** — FTS: 0 results (no keyword overlap). Vector rank 2: *Electron SQLite Fix* — "better-sqlite3 was built for the wrong Node version". The designed paraphrase test passed exactly.
2. **"why Tailscale single hub instead of multi-device sync"** — FTS: 0 results. Vector returned sync-architecture discussions (though not a definitive Tailscale-decision message — partially answered).
3. **"Slack-style search bar component"** — vector's top hit (distance 12.88, the best in the whole eval) is the `SearchBarView` implementation discussion; FTS found only 2 tangential mentions.

## Where FTS carried it (especially code)
- **"protocol interface for swapping audio feature providers"** — both legs missed. The `AudioFeatureProvider` content exists in 5 embedded, code-bearing messages, but nomic did not place the conceptual query near the code. Only `search_code` (LIKE on the identifier) finds it. **Exact-identifier retrieval is still FTS/LIKE territory.**
- **"parse the ChatGPT mapping / current_node tree"** — vector's #1/#3 were semantic look-alikes (LCA binary-tree interview answers); FTS anchored the parser-layer hits. The **fused** result was the best of the three legs.
- **"VIPER plugin filtering architecture"** — FTS surfaced the prose career-summary mentions; vector surfaced code-bearing search/filter implementations. Complementary; fusion interleaved both.

**Empirical read on code coverage:** nomic retrieves code-bearing messages well when the query describes *what the code does* (search bar, filtering UI), but misses when the query hinges on a *specific identifier or niche concept* (AudioFeatureProvider). Vector + FTS fusion is genuinely complementary; `search_code` remains the reliable route for exact symbols.

## Baseline note
Re-run `scripts/eval_retrieval.mjs` after switching the model to qwen3-embedding and diff `retrieval-eval.json` against this run to measure the code-coverage gain.

**Exact swap path (config change only, no code change):**
```bash
export OLLAMA_EMBED_MODEL=qwen3-embedding:4b   # or :8b
export OLLAMA_EMBED_DIMS=2560                  # 4B = 2560; 8B = up to 4096
npm run semantic:rebuild                       # builds, migrates (creates message_vectors_qwen3_embedding_2560 at the new dim), --reset indexes
TELEMETRY_DIR=telemetry/run-qwen3-embedding-<ts> node scripts/eval_retrieval.mjs
```
Non-default models get their own vector table (`message_vectors_<model>_<dims>`), so stale 768-dim nomic vectors cannot collide. Update the `semantic_search` tool description in `src/tools.ts` (it names nomic-embed-text) when the swap actually happens.

Telemetry for a rebuild is captured the same way:
```bash
TELEMETRY_DIR=<run dir> node --import ./scripts/telemetry_fetch_hook.mjs dist/index_embeddings.js --reset
TELEMETRY_DIR=<run dir> node scripts/write_run_json.mjs
TELEMETRY_DIR=<run dir> node scripts/embed_audit.mjs
```
