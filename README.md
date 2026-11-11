# Atlas-Agent

**Atlas-Agent OS · AI-Native Harness, Markdown Brain & Conversational Gateway**  
[atlas-si.com](https://atlas-si.com) · [Architecture and contracts](https://github.com/sergiomonteiro-atlas/atlas-blueprint)

Atlas is a local-first TypeScript runtime. It loads specialists and their living identities from an Obsidian-compatible Vault, executes real configured language models, and requires a separate Reality Auditor verdict before emitting `agent:done`. The Desktop consumes the same graph and telemetry protocol.

This is a new implementation informed by upstream architecture. It does not embed or impersonate Hermes, OpenClaw, GBrain, OpenBot, or Grok, and does not promise free model access. See [REA evidence](docs/REA.md) and [runtime limits](#boundaries).

## Start

Requires Node.js 22+ and npm. From this repository:

```sh
npm ci
npm run check
npm run build
npm test
node dist/cli.js init --from ../atlas-workforce/vault-starter --vault ../atlas-vault
node dist/cli.js graph --vault ../atlas-vault
node dist/cli.js search architecture --vault ../atlas-vault
node dist/cli.js daemon --vault ../atlas-vault
```

`init` uses exclusive copies and preserves every existing file. It refuses source/destination symlinks. Omit `--vault` to use `~/.atlas/vault` or set `ATLAS_VAULT`. `npm link` optionally makes the `atlas` executable available in your shell.

The daemon binds only `127.0.0.1:18790`. Set `ATLAS_TOKEN` to a 24+ character URL-safe secret; otherwise the CLI generates a session token and prints it once for pasting into Atlas Desktop. Keep the token out of URLs and public logs. The desktop retains it in session memory only.

### Configure a real model

Set environment variables in your shell; `.env.example` documents all names but is **not auto-loaded**.

| Variable | Purpose |
| --- | --- |
| `ATLAS_API_BASE` | OpenAI-compatible base URL, defaults to `https://api.openai.com/v1` |
| `ATLAS_API_KEY` | Required for remote models; never stored in the Vault |
| `ATLAS_MODEL` | Builder model name, required for model tasks |
| `ATLAS_AUDITOR_MODEL` | Optional independent reviewer model; defaults to builder model in a fresh context |
| `ATLAS_EMBEDDING_MODEL` | Optional real embedding model; enables semantic search |
| `ATLAS_BRAVE_API_KEY` | Optional Brave Search API key; enables `web_search` tool |
| `ATLAS_ALLOWED_ORIGINS` | Explicit comma-separated browser origins; no wildcards |

Local HTTP model endpoints (`localhost`, `127.0.0.1`, `::1`) may be keyless; remote endpoints require HTTPS and credentials. No credentials means no generated answers, no fake execution, and no inferred approval.

```sh
atlas chat --vault ../atlas-vault
atlas run "@atlas-ai-native-architect Design the Atlas deployment topology" --vault ../atlas-vault
```

The task's specialty is `agents/<division>/<slug>.md`; its identity is `souls/<slug>.soul.md`. Skills are loaded from `skills/<slug>/SKILL.md` or `skills/<slug>/<skill>/SKILL.md`. Missing or ambiguous agents and missing Souls fail explicitly. The starter includes all five Atlas identities, including `atlas-reality-auditor`.

## Runtime modules

| Module | Behavior |
| --- | --- |
| `src/core/harness.ts` | Bounded builder/tool loop → separate critic context → revision or completion; 3 attempts by default |
| `src/soul/loader.ts` | Reloads local specialty, Soul and skill Markdown for each run |
| `src/gbrain/indexer.ts` | YAML frontmatter, tags, `[[WikiLinks]]`, aliases, lexical relevance, optional embedding similarity, file watcher |
| `src/openbot/gateway.ts` | CLI chat and `@slug` routing |
| `src/openbot/adapters.ts` | Explicit Telegram/WhatsApp adapter classes and raw-body HMAC helper |
| `src/telemetry/server.ts` | Authenticated loopback HTTP/WS and slow-consumer protection |

### Graph and memory

Node IDs are normalized relative Vault paths without `.md`. Links resolve exact IDs, then unique basenames/aliases. Ambiguous or missing references appear in `unresolved`; fenced code and image embeds are excluded. All graph payloads match the blueprint v1 contract. YAML errors and limits are exposed in `indexer.warnings`.

Lexical search works without keys. Semantic search calls an explicitly configured embedding provider and computes cosine similarity; lexical ranking is never labeled semantic. The initial semantic path batches up to 32 notes per call and re-embeds on request: suitable for starter Vaults, with persistent embeddings/incremental invalidation left for a future scale step. Configured cloud providers receive the note text that is searched or recalled.

Memory writes validate a kebab-case topic and link names, create unique dated Markdown in `memory/`, and publish through an exclusive hard link from a temporary sibling. Existing notes cannot be overwritten. Hard-link-capable filesystems (NTFS, APFS, ext4) are required for this atomic write path.

### HTTP and WebSocket

All private routes require `Authorization: Bearer <ATLAS_TOKEN>`. `/health` exposes readiness and search mode only. Host headers and browser origins are checked before authentication. Default origins include the loopback development ports 1420, 1430, 5173 and Tauri local origins; the public landing domain is not allowed to read the Vault.

| Method/path | Response |
| --- | --- |
| `GET /health` | Readiness, authentication status and search mode |
| `GET /api/graph` | `GraphPayload` v1 |
| `GET /api/leads` | Graph nodes whose kind is `lead` |
| `GET /api/search?q=...` | `{mode:'lexical',hits:[]}` |
| `GET /api/search?q=...&mode=semantic` | Real embedding search, or 503 when unconfigured |
| `POST /api/run` | `{agentSlug,task}` → audited result; maximum 2 concurrent HTTP runs |
| `POST /api/memory` | `{topic,content,links?}` → `{path}` |

Browser WS clients use `new WebSocket('ws://127.0.0.1:18790/ws', ['atlas-v1', 'atlas-token.' + token])`. The selected protocol is `atlas-v1`; the secret is not sent in the URL. There is no replay history: reconnect by reloading `/api/graph`. Events carry `version`, `id`, `runId`, `agentSlug`, `type`, `timestamp`, and `data`; task text and tool arguments are not broadcast. Types: `agent:start`, `agent:tool_call`, `agent:critic_review`, `agent:done`, `agent:error`, `graph:updated`.

### Channel adapters

Telegram and WhatsApp adapters are exported building blocks, not auto-connected production channels. You must configure provider tokens, account/phone IDs and sender/chat allowlists, verify inbound signatures, persist provider delivery IDs for replay protection, and register the provider webhook with a separately secured public ingress. The loopback daemon does not expose anonymous external webhooks. Adapters send only the reviewed output after the critic passes. Real accounts are not provisioned by this codebase and no live outbound message is sent by tests.

## Boundaries

- A critic verdict is a model quality review with bounded tool evidence, not proof of execution or production certification. The auditor has no tools and cannot independently test artifacts.
- Builder tools are read-only Vault search/read plus explicitly configured web search. There is no arbitrary shell execution, browser control, skill self-modification or unattended external sending in the CLI.
- Chat turns are separate tasks; persistent conversational sessions, resumable jobs and crash-safe task queues are not yet implemented. Episodic memory must be deliberately written through the library or authenticated API.
- The index is an in-memory snapshot (10,000 files, 2MiB per file, 64MiB total, depth32). It skips symlinks and hidden config folders. The Vault must be owned by a trusted local user; path checks do not isolate against a hostile concurrent operating-system account changing directory handles.
- Reads and search disclose private note contents to the configured model when used as tool evidence. Configure a local model for fully local inference. Keys never belong in Markdown.
- The file watcher debounces changes and rescans; it is not a database transaction or an incremental vector index. Standalone graph commands do not require a model.

Tests exercise graph ambiguity, malformed YAML, paths/ADS, symlinks, atomic memory publication, critic rejection and retry, bounded evidence, explicit missing-provider behavior, and real HTTP/WS authorization. Loopback socket tests require a host environment that permits local TCP connections.
