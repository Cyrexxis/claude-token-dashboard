# Token Dashboard — Specification

Status: draft · Date: 2026-11-01 · Working name: `token-dashboard` (provisional)

A local dashboard for Claude usage: long-term token statistics by token type, API-equivalent cost at the prices valid at the time of each request, and subscription plan usage (5-hour / weekly windows). Data is collected from Claude Code transcripts and a Claude Code mod, stored in SQLite, and served by a single local program with a React web interface.

---

## 1. Goals and non-goals

### Goals
- Track Claude Code token usage per API request as accurately as the local data allows: input, output, cache read, cache write (5 min / 1 h split), thinking, server tool use, model, speed, service tier, inference region.
- Show API-equivalent cost using the price that was in effect when each request happened.
- Track plan usage over time (5-hour and weekly windows, percent used, reset times), and estimate how much token usage corresponds to plan consumption.
- Support several sources: Claude Code in WSL, Claude Code on Windows (CLI and desktop Code tab), desktop app session metadata, Cowork (once verified), chat (estimates only).
- Keep a permanent history independent of Claude Code's transcript cleanup.
- Live updates in the browser while Claude is working.
- Easy to hand to other users: install the plugin from the GitHub repo, run one slash command.

### Non-goals
- No hosted / multi-user service. Every user runs their own instance; transcripts contain code and prompts and never leave the machine.
- No network access from the running server (see §12).
- No exact token data for claude.ai chat; Anthropic does not expose it locally.
- No automatic price updates from the internet.

---

## 2. Key decisions

| Topic | Decision |
|---|---|
| Server | One self-contained **Bun** program (`bun build --compile`), HTTP API with **Hono**, **`bun:sqlite`** storage, file watcher, ingester, SSE. Web UI files embedded in the program. |
| Web UI | **React + Vite** single-page app, served by the Bun program. Vite is used only for development and the build. No Next.js. Charts use one lightweight charting library; no heavy dashboard framework. |
| Database | SQLite (WAL mode), one file per installation. |
| Live collection | A Claude Code **mod** (plugin with a hooks module) sends plan-usage snapshots and "ingest now" signals. Transcripts remain the source of truth for token counts. |
| Live updates | Server-Sent Events from the server to the browser. |
| Prices | `prices.json` shipped with each release; no fetching. Each entry carries its own effective dates. |
| Distribution | Plugin installed straight from the GitHub repo (relative-path marketplace entry). The mod's `/token-dashboard setup` downloads the prebuilt program for the platform from GitHub Releases. No npm publishing, no built files committed to git. |
| Server location | **WSL server = default, full support.** **Windows server = limited**: Windows-side sources only. |
| Status line | Not used. The mod replaces it. |

---

## 3. Architecture

```
 Claude Code session (WSL or Windows)           Local machine
 ┌────────────────────────────────┐   HTTP    ┌──────────────────────────────────────────┐
 │ token-dashboard mod            │ ────────► │ token-dashboard program (Bun)            │
 │  session.start  → health/start │  127.0.0.1│  ├─ HTTP API (Hono) + bearer token       │
 │  session.measure→ plan snapshot│           │  ├─ Ingester (transcripts → SQLite)      │
 │  turn.complete  → ingest signal│           │  ├─ Watchers (inotify / polling)         │
 │  /token-dashboard commands     │           │  ├─ Pricing engine (prices.json)         │
 └────────────────────────────────┘           │  ├─ SSE event stream                     │
                                              │  └─ Embedded React UI (Vite build)       │
 Transcript files (.jsonl) ─── read ────────► │                                          │
 Desktop app metadata (.json) ── read ──────► │  SQLite database (app-data folder)       │
                                              └──────────────────────────────────────────┘
                                                          ▲ SSE / JSON
                                                   Browser (dashboard)
```

The program runs permanently as a user service (systemd user unit in WSL/Linux, Task Scheduler logon task on Windows).

---

## 4. Data sources

### 4.1 Source catalogue

| Source | Location | Data | Accuracy |
|---|---|---|---|
| Claude Code, WSL/Linux | `~/.claude/projects/**/*.jsonl` (respect `CLAUDE_CONFIG_DIR`) | Per-request usage, model, session, cwd, version, entrypoint | Exact |
| Claude Code, Windows | `%USERPROFILE%\.claude\projects\**\*.jsonl` | Same | Exact |
| Subagent transcripts | Inside each session's folder | Same | Exact |
| Desktop app Code sessions | `%LOCALAPPDATA%\Claude-Data\claude_<pkg>\claude-code-sessions\<account>\<org>\local_*.json` | Title, model, effort, `cliSessionId`, `wslConfig`, timestamps | Metadata only, undocumented format |
| Desktop app plan history | `…\Claude-Data\claude_<pkg>\plan-usage-history.json` | Plan samples (`version: 2`, `samples[{t, org, u}]`) | Undocumented; optional, read-only |
| Cowork | `…\Claude-Data\claude_<pkg>\local-agent-mode-sessions\` | **To verify** (no task has been run yet) | Expected exact |
| Mod (`session.measure`) | Pushed by the mod | Plan windows: kind, percent used, reset time; session cost | Exact percentages |
| claude.ai chat | Not stored locally | Only via manual data-export import | Estimate |

The Claude package folder name (`claude_pzs8sxrjxfjjc` on the reference machine) is discovered by globbing `Claude-Data\claude_*`.

### 4.2 Support matrix by server location

| | WSL server (default) | Windows server (limited) |
|---|---|---|
| Claude Code in WSL (incl. desktop Code tab sessions running in WSL) | ✔ watched (inotify) | ✘ |
| Claude Code on Windows | ✔ via `/mnt/c`, polled | ✔ watched |
| Desktop app metadata, plan history, Cowork | ✔ via `/mnt/c`, polled | ✔ watched |
| Mod running in WSL sessions | ✔ `localhost` | ✘ (mod stays silent) |
| Mod running in Windows sessions | ✔ `localhost` (WSL forwards Windows → WSL) | ✔ `localhost` |

Rationale: only Windows → WSL `localhost` works under WSL's default NAT networking. A Windows server reachable from WSL would require mirrored networking or firewall rules, which is out of scope for now.

File-change notifications do not work across `/mnt/c` (9P), so Windows paths seen from WSL are polled (default every 5 s, configurable).

### 4.3 Transcript retention

Claude Code deletes transcripts after `cleanupPeriodDays` (default 30). The database is the long-term record. `/token-dashboard setup` offers (with explicit confirmation) to raise `cleanupPeriodDays` in `~/.claude/settings.json` and in the Windows-side settings file.

---

## 5. Ingestion

### 5.1 Relevant transcript fields (verified on Claude Code 2.1.309)

Line envelope: `type`, `timestamp`, `sessionId`, `requestId`, `cwd`, `version`, `entrypoint` (e.g. `claude-desktop`, CLI), `userType`.

For `type: "assistant"` lines, `message` holds `id`, `model` and `usage`:

```
input_tokens, output_tokens,
cache_read_input_tokens, cache_creation_input_tokens,
cache_creation.ephemeral_5m_input_tokens, cache_creation.ephemeral_1h_input_tokens,
output_tokens_details.thinking_tokens,
server_tool_use.web_search_requests, server_tool_use.web_fetch_requests,
service_tier, speed, inference_geo, iterations[]
```

Other line types seen: `user`, `attachment`, `api-request`, `api-request-shape`, `api-request-blob`, `queue-operation`, `file-history-snapshot`, `custom-title`, `ai-title`, `agent-name`, `agent-color`, `agent-setting`, `tag`, `cost-state`, `last-prompt`, `atis-latch`.

- `api-request*` lines record main-loop requests only (no usage) and are not ingested; see §18.5.
- Session metadata lines (`custom-title`, `ai-title`, `agent-name`, `agent-color`, `agent-setting`, `tag`) are re-appended repeatedly; the latest value wins (an empty `tag` clears it). Stored as columns on `sessions`; display title = custom title, else AI title.
- `cost-state` (one per Claude Code process, written at exit/resume): per-model token and cost totals including side requests (titles, web summaries, classifiers) that have no assistant line. Stored in `cost_states`, one row per `(session, process startTime, model)`, the latest snapshot of a process wins.

### 5.2 Rules
- **One row per API response**, keyed by `(message.id, requestId)`. A single response is written as several lines (one per content block) repeating the same usage; resumed or forked sessions copy earlier lines. Both are deduplicated by this key, globally across files.
- Ignore synthetic messages (model `<synthetic>`, zero usage).
- Store the full raw `usage` object as JSON next to the parsed columns, so new fields can be backfilled later without re-reading files.
- Include subagent transcripts, linked to the parent session.
- Incremental reading: per file, store path, device/inode (or file ID on Windows), size and byte offset; read only appended bytes; detect truncation/replacement and re-read from the start (dedup makes this safe).
- Ingest runs: on start-up (full scan), on watcher events, on poll ticks, and on `POST /api/v1/ingest/trigger` from the mod (targets one session's files).
- After each ingest batch: update daily rollups, emit SSE events.

### 5.3 Source labelling
Each request gets a `source`:
- `wsl-cli`, `wsl-desktop` (entrypoint `claude-desktop`, WSL path), `windows-cli`, `windows-desktop`, `cowork`, `chat-import`, plus the host / distro name.
- Desktop session metadata is joined on `cliSessionId` to add titles and settings.

---

## 6. Plan usage tracking

- The mod sends a snapshot on every `session.measure` event (fires after each main-thread turn and whenever a window moves by a whole percentage point): `{kind, percentUsed, resetsAt}` per window, plus the session's cost.
- The account/org is taken from `$.session.identity()` (fields to verify) so several accounts stay separate.
- Several sessions report the same account-wide numbers; the server stores a snapshot only when a value changed. A window is identified by `(org, kind, resetsAt)`.
- Optional: import `plan-usage-history.json` from the desktop app (read-only, best effort, format undocumented).
- **Estimation (experimental):** per window, relate the percentage increase to the token/cost increase recorded in the same period to estimate "tokens (or API-equivalent dollars) per 1 %". Plan percentages include chat and Cowork; the gap between observed percentage and Code-attributed usage shows non-Code consumption.

---

## 7. Chat and Cowork

- **Cowork:** run one Cowork task, inspect `local-agent-mode-sessions`, and add a parser if transcripts with usage exist. Until then, unsupported.
- **Chat:** optional later feature. The user uploads a claude.ai data export in the dashboard; the server estimates tokens offline (approximate tokenizer/heuristic), clearly labelled as estimates. No calls to the token-counting API (would break the no-network rule) unless added later as an explicit, opt-in user action.

---

## 8. Pricing

### 8.1 Principles
- Anthropic offers no pricing API (the Models API returns no prices). Prices ship as `prices/prices.json` inside each release and change only when the user updates.
- The running server makes no network requests for prices.
- Each price entry has `effective_from` (and optional `effective_to`); a request is priced with the entry valid at its timestamp. Price changes are therefore dated correctly regardless of when the user updates.
- After a price-file update or a local override change, costs are recalculated for the affected models and periods.
- Unknown model → request marked `unpriced`; the dashboard shows a banner. Users can add a local price (`prices.local.json`, editable in the UI) which overrides the shipped file.

### 8.2 Cost dimensions
- Input, output, cache read, cache write 5 min, cache write 1 h, per model.
- Modifiers where applicable: fast mode (`speed`), inference region (`inference_geo`), long-context pricing, service tier.
- Server tools: web search per request (and others as they appear).
- Thinking tokens: already included in `output_tokens` (verified against `cost-state`); stored separately for display only, never priced.

### 8.3 File format (schema version 1)

Real values live in `prices/prices.json`; the example shows the shape.

```json
{
  "schema": 1,
  "updated": "2026-11-01",
  "currency": "USD",
  "models": [
    {
      "id": "claude-haiku-5-5",
      "match": ["claude-haiku-5-5", "claude-haiku-5-5-*"],
      "notes": "why a value is derived rather than quoted",
      "periods": [
        {
          "effective_from": null,
          "effective_to": null,
          "per_mtok": {
            "input": 0.1, "output": 0.5,
            "cache_read": 0.01, "cache_write_5m": 0.125, "cache_write_1h": 0.2
          },
          "long_context": {
            "threshold_input_tokens": 100000,
            "per_mtok": { "input": 0.5, "output": 2.5, "cache_read": 0.05, "cache_write_5m": 0.625, "cache_write_1h": 1 }
          },
          "modifiers": { "speed": { "fast": { "multiplier": 2 } }, "inference_geo": {} }
        }
      ]
    }
  ],
  "server_tools": [
    { "name": "web_search", "periods": [ { "effective_from": null, "per_request": 0.01 } ] }
  ]
}
```

- Dates are `YYYY-MM-DD` (UTC midnight). `effective_from: null` means "since the model's release"; `effective_to` is exclusive, `null` = open. Periods of one model must not overlap.
- `match`: exact ids or a single trailing `*`; the first matching model wins, so dated ids (`claude-opus-4-5-20251101`) never fall back to a shorter family.
- `long_context`: when input + cache read + cache writes exceed the threshold, all five rates switch.
- `modifiers.speed.<speed>.multiplier` multiplies the token cost (not server-tool fees). `inference_geo` is accepted but not yet applied.
- `prices.local.json`: a model with the same `id` replaces the shipped entry; new ids are matched first.
- Each request row stores the computed cost and the `price_period_id` (`<model>@<effective_from|release>@<shipped|local>`). When the price content changes, all requests are repriced and rollups rebuilt.

---

## 9. Database schema (SQLite)

```
installations      id, created_at, server_version, schema_version
sources            id, kind, host, distro, root_path, last_scan_at, enabled
files              id, source_id, path, file_key, size, offset, mtime, session_id, last_ingest_at,
                   error_count, last_error
sessions           id (sessionId), source_id, parent_session_id, cwd, project, title, ai_title,
                   agent_name, agent_color, agent_setting, tag,
                   entrypoint, cc_version, first_ts, last_ts, desktop_meta_json
requests           id, message_id, request_id ('' when absent), UNIQUE(message_id, request_id),
                   session_id, agent_id, ts, model, source_id, file_id,
                   input, output, cache_read, cache_write_5m, cache_write_1h,
                   thinking, web_search, web_fetch,
                   service_tier, speed, inference_geo, effort, is_sidechain,
                   cost_usd, price_period_id, unpriced, usage_raw_json
price_periods      id, model_id, effective_from, effective_to, origin (shipped|local), values_json
cost_states        session_id, start_time, ts, model, input, output, thinking, cache_read,
                   cache_write, web_search, cost_usd, total_cost_usd, has_unknown_model_cost
                   PRIMARY KEY(session_id, start_time, model)
plan_snapshots     id, ts, org_id, kind, percent_used, resets_at, session_cost_usd, origin (mod|desktop)
plan_windows       org_id, kind, resets_at, peak_percent, tokens_in_window, cost_in_window
daily_rollups      day, source_id, model, project, token columns…, cost_usd, request_count
live_usage         session_id, turn_id, step_index, ts, model, 4 token counts   (temporary, dropped after ingest)
settings           key, value
```

Indexes on `requests(ts)`, `requests(session_id)`, `requests(model, ts)`, `plan_snapshots(org_id, kind, ts)`. Migrations are versioned and run at start-up.

---

## 10. Server

### 10.1 Runtime
- Bun, compiled to one executable per target: `linux-x64`, `linux-arm64`, `windows-x64` (macOS later).
- Listens on `127.0.0.1` only. Default port `47811`; setup falls back to a free port and records it.
- Checks the `Host` header (only `127.0.0.1:<port>` / `localhost:<port>`) to block DNS-rebinding attacks.
- Environment: `TD_DATA_DIR`, `TD_PORT`, `TD_CONFIG` override defaults (used for development and tests).

### 10.2 Authentication
- `setup` generates a random token stored in the connection file (§11.3).
- Mod requests send `Authorization: Bearer <token>`.
- Browser: `/token-dashboard open` opens `http://127.0.0.1:<port>/auth?t=<one-time code>`; the server exchanges it for an HttpOnly, SameSite=Strict cookie. All API endpoints require the token or the cookie.

### 10.3 API (`/api/v1`, JSON)

Write (mod):
| Method & path | Purpose |
|---|---|
| `GET /api/health` | `{ok, version, protocol}` — unauthenticated, no data |
| `POST /sessions` | Register session: id, cwd, surface, Claude Code version, org, platform |
| `POST /plan-snapshots` | Plan windows + session cost; deduplicated by value |
| `POST /ingest/trigger` | Ingest one session's transcript now |
| `POST /live-usage` | Optional per-step counts for live display; replaced by ingested rows |

Read (UI): `GET /summary`, `/timeseries?metric=&group=&from=&to=&bucket=`, `/sessions`, `/sessions/:id`, `/models`, `/projects`, `/plan/windows`, `/plan/snapshots`, `/prices`, `/sources`, `/status`.

Admin (UI): `PUT /prices/local`, `POST /sources/:id/rescan`, `POST /import/chat-export` (later).

Every write carries an idempotency key (e.g. `session:turn:step`, `org:kind:resetsAt:percent`) so retries never double-count. Requests carry `X-TD-Protocol`; the server rejects unknown major versions with a clear "update the plugin / server" message.

### 10.4 Live updates (SSE)
`GET /api/v1/events` streams:
- `usage.updated` `{sessionIds, from, to}`
- `plan.snapshot` `{org, kind, percentUsed, resetsAt}`
- `session.started` / `session.ended`
- `prices.updated`, `ingest.status`

The UI (TanStack Query) invalidates only the affected queries. Expected latency: about 1 s for WSL sessions; a few seconds for Windows sessions without the mod (poll interval), about 1 s with the mod.

---

## 11. The Claude Code mod

### 11.1 Events
| Event | Action |
|---|---|
| `session.start` | Read connection file; `GET /api/health`; if unreachable run the start command, then retry health a few times; `POST /sessions`; flush queued items |
| `session.measure` | `POST /plan-snapshots` |
| `turn.step` (optional) | `POST /live-usage` from the step result's `usage` |
| `turn.complete` | `POST /ingest/trigger` |
| `session.end` | Final trigger and queue flush within the short end budget |

Rules:
- Hooks call `next(e)` first and send requests without awaiting them; the mod never delays Claude.
- Failed requests go to a bounded queue in `$.store` and are resent once the server is reachable.
- If no connection file exists (e.g. WSL session while the server runs on Windows), the mod stays silent apart from one notice.

### 11.2 Commands
| Command | Behaviour |
|---|---|
| `/token-dashboard setup` | Detect platform (WSL / Linux / Windows) → show the plan and ask for confirmation → download program `v<plugin version>` for the platform from GitHub Releases, verify checksum → install to app-data folder → create data folder, token, connection file(s) → register service → offer `cleanupPeriodDays` change → wait for health → print dashboard link. From a Windows session: offer "install into WSL (recommended)" or "Windows server (limited)". |
| `/token-dashboard update` | Offered when the plugin's version is newer than the installed program. Download the new program → stop service → swap (keep previous for rollback) → start → run DB migrations → verify health. |
| `/token-dashboard status` | Service state, connection, protocol versions, sources with last scan time, unpriced models, log location. |
| `/token-dashboard open` | Open the dashboard in the default browser with a one-time login link: `wslview` or `cmd.exe /c start` in WSL (`xdg-open` is often missing there), `xdg-open` on Linux, `cmd /c start` on Windows. The link is also printed as a fallback. |
| `/token-dashboard uninstall` | Remove service and program; keep the database unless the user explicitly asks to delete it. |

Downloads and service management use `$.process.run` / `$.process.spawn` (`curl` on Linux/WSL, `curl.exe` or PowerShell on Windows). Progress is shown via `$.ui.status`. These commands work in Claude Code sessions (CLI, desktop Code tab, IDE); not in chat or Cowork.

### 11.3 Connection file
Linux/WSL: `~/.config/token-dashboard/server.json` · Windows: `%APPDATA%\token-dashboard\server.json`

```json
{
  "url": "http://127.0.0.1:47811",
  "token": "…",
  "protocol": 1,
  "serverLocation": "wsl",
  "start": ["systemctl", "--user", "start", "token-dashboard"]
}
```

For a WSL server, setup also writes the Windows-side file (via `/mnt/c`) with `"start": ["wsl.exe", "-d", "<distro>", "--", "systemctl", "--user", "start", "token-dashboard"]`. Plugin `userConfig` can override `url` for unusual setups.

### 11.4 Service registration
- **WSL / Linux:** systemd user unit `~/.config/systemd/user/token-dashboard.service` (`Restart=on-failure`), enabled and started via `systemctl --user`. Logs via `journalctl --user -u token-dashboard`.
- **Windows:** Task Scheduler task "TokenDashboard", trigger at logon, no admin rights, hidden window, restart on failure.
- **Open question:** WSL may stop the distro shortly after the last Windows-side process using it exits, even with systemd services running. If confirmed, setup also registers a hidden Windows logon task running `wsl.exe -d <distro> -- token-dashboard keepalive`. Data is never lost either way (transcripts are re-read later); only live availability is affected.

### 11.5 Implementation notes
- Resolve folders with `$.env.get`: `HOME` / `USERPROFILE`, `CLAUDE_CONFIG_DIR` (default `<home>/.claude`), `XDG_CONFIG_HOME`, `APPDATA`, `LOCALAPPDATA`. Detect Windows via `OS === "Windows_NT"`.
- `$.fs.read` refuses files over 4 MiB. If the mod ever needs data from a transcript (normally the server reads them), use `$.process.run(["grep", …])` on Linux/WSL instead of reading the whole file.

---

## 12. Network and privacy policy

- The running server makes **no outbound network connections**. It listens on `127.0.0.1` only.
- Enforced by a CI check that fails the build if server code imports or calls network clients (`fetch`, `node:http(s)` client, `net.connect`, etc.) outside the listener.
- The only internet access in the whole project: `/token-dashboard setup` and `/token-dashboard update` download the program from GitHub Releases, triggered explicitly by the user. The plugin itself is fetched by Claude Code from GitHub when the user installs/updates it.
- No telemetry, no external fonts or CDNs; all UI assets are embedded.
- The README states this policy explicitly.

---

## 13. Locations and configuration

| | Linux / WSL | Windows |
|---|---|---|
| Program | `~/.local/share/token-dashboard/bin/` (current + previous) | `%LOCALAPPDATA%\token-dashboard\bin\` |
| Database | `~/.local/share/token-dashboard/data/token-dashboard.db` | `%LOCALAPPDATA%\token-dashboard\data\` |
| Local prices | `~/.config/token-dashboard/prices.local.json` | `%APPDATA%\token-dashboard\prices.local.json` |
| Connection file | `~/.config/token-dashboard/server.json` | `%APPDATA%\token-dashboard\server.json` |
| Logs | journald | `%LOCALAPPDATA%\token-dashboard\logs\` |

Nothing durable lives in the plugin cache (`~/.claude/plugins/cache/…`), which Claude Code replaces on updates and deletes 14 days later. Uninstalling the plugin does not delete history.

---

## 14. Dashboard views

1. **Overview** — totals for selectable period; API-equivalent cost vs. subscription price; tokens by type (stacked); cache hit ratio; current plan windows with reset countdown.
2. **Tokens over time** — stacked area/bar by token type; group by model, source, project; day/week/month buckets.
3. **Cost over time** — API-equivalent cost at historical prices; marks where prices changed; unpriced banner.
4. **Plan usage** — timeline of 5-hour and weekly windows with percentage curves; token/cost overlay; tokens-per-percent estimate (experimental).
5. **Sessions** — list with source, project, title, model, duration, tokens, cost; detail page with per-request table, subagents and cache behaviour.
6. **Models & projects** — breakdowns and trends.
7. **Sources & status** — data sources, last scan, file counts, ingest errors, versions, price file version, local price editor.

All views update live via SSE.

---

## 15. Repository layout

```
/
├─ SPEC.md
├─ README.md
├─ .claude-plugin/marketplace.json     # one entry: { "name": "token-dashboard", "source": "./plugin" }
├─ plugin/                             # Claude Code plugin (no package.json + lockfile at its root)
│  ├─ .claude-plugin/plugin.json       # version = release version
│  ├─ hooks/hooks.json                 # { "modules": ["./register.ts"] }
│  ├─ hooks/register.ts                # the mod
│  ├─ hooks/*.test.ts                  # claude plugin test
│  └─ types/index.d.ts                 # $.state / $.store contract
├─ server/                             # Bun + Hono: API, ingester, watchers, pricing, DB, SSE
├─ web/                                # Vite + React UI
├─ shared/                             # protocol types, price-file schema
├─ prices/prices.json
├─ fixtures/                           # sample transcripts and desktop metadata for tests
└─ .github/workflows/
   ├─ ci.yml                           # lint, tests, network-policy check, build on Linux + Windows
   └─ release.yml                      # on tag: build programs, attach to GitHub Release with checksums
```

Bun workspaces tie `server`, `web` and `shared` together. The Vite build output is embedded into the compiled program.

### Release flow
1. Bump the version in `plugin/.claude-plugin/plugin.json` and the server; commit; tag `vX.Y.Z`.
2. `release.yml` builds `token-dashboard-<os>-<arch>[.exe]` and `checksums.txt`, attaches them to the GitHub Release.
3. Users run `claude plugin update`, then `/token-dashboard update`. If the release is not published yet, the mod says so and asks to retry later.

No built files are committed; no npm publishing.

---

## 16. Development and testing

- **Daily development:** `bun run dev` starts Vite (UI with hot reload) and the Bun server; Vite proxies `/api` to the server. The mod is loaded with `claude --plugin-dir ./plugin` (or `CLAUDE_CODE_PLUGIN_DIRS` for desktop sessions).
- **Mod tests:** `claude plugin test ./plugin`.
- **Server tests:** `bun test` with fixtures covering duplicate lines, resumed sessions, subagents, truncated files, unknown models, price period boundaries.
- **Install-flow test:** `claude plugin marketplace add <repo folder>` with a dev marketplace name (`token-dashboard-dev`); remove afterwards.
- **Fresh-user test:** `CLAUDE_CONFIG_DIR=~/cc-sandbox claude`, install from GitHub, delete the folder afterwards.
- **Isolation:** `TD_DATA_DIR`, `TD_PORT`, service name `token-dashboard-dev`, and a configurable release download URL (pointing to a local build or a test release).

---

## 17. Phases

1. **Core** — scaffolding (Bun workspaces), schema + migrations, transcript parser + ingester with dedup, watchers/polling, price engine with `prices.json`, fixtures and tests. Examine `api-request` lines.
2. **API + UI** — Hono API, auth, SSE, React dashboard (overview, tokens, cost, sessions, status).
3. **Mod** — health/start, plan snapshots, ingest triggers, offline queue, `status` and `open` commands; plan usage views.
4. **Distribution** — release workflow, `setup` / `update` / `uninstall`, systemd and Task Scheduler, connection files, Windows-server mode, WSL keepalive (if needed), retention setting.
5. **Extras** — Cowork parser (after verification), chat export import (estimates), tokens-per-percent estimation, optional in-app panel.

---

## 18. Open questions / to verify

1. Does WSL shut down the distro (and the service) when no Windows-side process holds it? → keepalive task needed?
2. Cowork: where are transcripts stored and do they contain usage?
3. Fields returned by `$.session.identity()` (account / org IDs) in the mod API.
4. ~~Are thinking tokens included in `output_tokens`?~~ **Resolved (phase 1):** yes, included. `iterations[]` had a single entry equal to the top-level usage in all samples; stored raw in `usage_raw_json`, revisit if multi-entry ones appear.
5. ~~Do `api-request*` transcript lines record side requests?~~ **Resolved (phase 1):** no. They record main-loop requests only (params, no usage; linked via the assistant line's `requestRef`). Side requests (titles, web summaries, classifiers) appear only in `cost-state` totals.
6. `session.measure` and `$.process` behaviour in desktop-hosted Code sessions on Windows and WSL.
7. `bun build --compile`: embedding the Vite output and `bun:sqlite` on `windows-x64`.
8. Release authenticity: checksums from the same release only protect against corruption; consider GitHub artifact attestations (verified when `gh` is available) or signing.
9. Format and usefulness of the desktop app's `plan-usage-history.json` (currently samples with empty `u`).
10. Window semantics for per-model weekly limits and "extra usage" (shown in the desktop usage card) and whether the mod receives them.
