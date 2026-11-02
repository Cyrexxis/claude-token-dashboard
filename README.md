# Token Dashboard

A local dashboard for your Claude usage: token statistics by type, API-equivalent cost at the
prices valid at the time of each request, and subscription plan usage (5-hour and weekly windows).

It reads Claude Code transcripts, stores them in SQLite, and serves a React dashboard from one
local Bun program. A Claude Code mod (plugin) sends plan readings and "ingest now" signals so the
dashboard updates live.

**Privacy:** everything stays on your machine. The server listens on `127.0.0.1` only and makes
no outbound network connections (`bun run check:network` enforces this). No telemetry, no CDNs.

> Status: phases 1–3 and the local part of phase 4 are done. There are no prebuilt releases
> yet, so you run it from a checkout. Linux and WSL are supported; a Windows-side server is not
> built yet. See [SPEC.md](SPEC.md) §17 for the roadmap.

---

## Setup

### Requirements

- [Bun](https://bun.sh) 1.4 or newer
- Linux or WSL with systemd user services (`systemctl --user` must work)
- Claude Code, for the mod and the transcripts it reads

### Install

```sh
git clone https://github.com/Cyrexxis/claude-token-dashboard.git token-dashboard
cd token-dashboard
bun install
bun run setup
```

`bun run setup` asks which connection files to write (WSL, Windows, or both), builds the web UI,
installs a systemd user service called `token-dashboard`, starts it, and waits until it answers.
It prints the dashboard link, by default **http://127.0.0.1:47811**.

On first start the server scans every transcript it finds, so the first page load may take a
moment on a large history.

### Load the mod

The mod gives the Plan view its data and makes the dashboard update after every turn. Without
it you still get tokens and cost, picked up by the file watcher, but no plan usage.

Either load it for one session:

```sh
claude --plugin-dir ./plugin
```

or install it from the repo, which works as a plugin marketplace:

```sh
claude plugin marketplace add /path/to/token-dashboard
claude plugin install token-dashboard@token-dashboard
```

On session start the mod checks that the server is up and starts the service if it is not.

### Update and uninstall

```sh
git pull
bun run update      # bun install + web build + service restart
bun run uninstall   # removes the service and connection files, keeps the database and config
```

---

## Using it

Open **http://127.0.0.1:47811**, or run `/token-dashboard open` inside Claude Code.

| View | What it shows |
|---|---|
| **Overview** | Totals for the chosen period, API-equivalent cost vs. your subscription, cache hit ratio, tokens and cost over time, and breakdowns by project and by model |
| **Plan** | The current 5-hour and weekly windows, a usage timeline, tokens/cost inside the window, sessions in the window, and a list of past windows you can pick |
| **Sessions** | All sessions with source, project, model, duration, tokens and cost; click one for per-request detail |
| **Status** | Data sources, last scans, ingest errors, versions, prices |

Tips:

- Legend entries are buttons: click one to hide or show that series. Cache reads start hidden
  in token charts because they dwarf everything else.
- Plan % also counts claude.ai chat and Cowork, which this dashboard cannot see, so
  "tokens per 1 %" reads low on days you also chat.
- `/token-dashboard status` in Claude Code shows the service state, connection and sources.

### Command line

Run these from the checkout:

| Command | Does |
|---|---|
| `bun run stats` | Prints totals by model and source, unpriced models, and a transcript vs. cost-state check |
| `bun run scan` | Ingests all transcripts once and exits |
| `bun run reprice` | Recomputes every cost from the price files (after editing prices) |
| `bun run serve` | Runs the server in the foreground (what the service runs) |

### Files and configuration

| | Location (Linux / WSL) |
|---|---|
| Database | `~/.local/share/token-dashboard/data/token-dashboard.db` |
| Config | `~/.config/token-dashboard/config.json` (optional) |
| Local price overrides | `~/.config/token-dashboard/prices.local.json` |
| Connection file (read by the mod) | `~/.config/token-dashboard/server.json` |
| Logs | `journalctl --user -u token-dashboard` |

`config.json` keys, all optional:

```json
{
  "subscriptionMonthlyUsd": 200,
  "extraRoots": ["/path/to/another/.claude"],
  "windowsRoots": "auto",
  "pollIntervalMs": 5000
}
```

- `subscriptionMonthlyUsd` turns on the "vs. subscription" tile.
- `extraRoots` adds more `.claude` folders to scan; `windowsRoots: "auto"` also scans the Windows
  side from WSL (`false` turns that off).
- `connectionFiles` is written by `setup`; leave it alone.

Environment variables: `TD_PORT` (default 47811), `TD_DATA_DIR`, `TD_CONFIG`, and
`CLAUDE_CONFIG_DIR`. `setup` copies them into the service, so set them before running it.

Your history is kept even after Claude Code deletes old transcripts. To keep more transcripts
on disk in the first place, raise `cleanupPeriodDays` in Claude Code's settings.

### Troubleshooting

- **Dashboard does not load:** `systemctl --user status token-dashboard`, then the logs above.
- **Port 47811 is busy:** set `TD_PORT` and run `bun run setup` again.
- **No plan data:** the mod is not loaded in your Claude Code session (see *Load the mod*).
- **"unpriced requests":** a model is missing from `prices/prices.json`; add it to
  `prices.local.json` and run `bun run reprice`.

---

## Development

### Layout

```
server/   Bun + Hono: API, ingester, file watcher, pricing, SQLite, SSE, CLI (server/src/cli.ts)
web/      Vite + React dashboard (views in web/src/views, charts with Recharts)
shared/   Types shared by server and web: API shapes, price-file schema
plugin/   The Claude Code mod (plugin/hooks/register.ts)
prices/   prices.json shipped with the program
fixtures/ Sample transcripts for tests
SPEC.md   The specification: architecture, data rules, decisions, roadmap
```

### Run it locally

```sh
bun install
systemctl --user stop token-dashboard   # dev uses the same port as the installed service
bun run dev
```

`bun run dev` starts the server and Vite with hot reload on **http://127.0.0.1:5173**. Vite
proxies `/api` to port 47811. Start the service again when you are done. To keep your real data
out of development, set `TD_DATA_DIR` and `TD_CONFIG` to scratch folders first.

`bun run serve` alone serves the last `bun run build:web` output on port 47811.

### Checks

Run all of these before committing:

```sh
bun run typecheck
bun run lint            # biome; `bunx biome check --write .` fixes formatting
bun test
bun run check:network   # fails if server code makes network calls
bun run test:mod        # mod tests, needs the claude CLI
```

### Conventions

- **SPEC.md is the source of truth.** Read the relevant section before changing behaviour, and
  update it when a decision changes.
- The server must stay offline: no `fetch`, HTTP clients or sockets besides the listener.
- New query logic gets a test in `server/test`; pure web helpers (like `web/src/plan-math.ts`)
  get one in `web/test`.
- Prefer reusing what exists: `TimeChart` draws every stacked bar and area chart,
  `buildSeries` in `server/src/api/queries.ts` builds every series, `MetricToggle` and
  `GroupSelect` are the shared toggles.
- A known limitation is marked in code with `shortcut: <the limit>, <when to upgrade>`.
- Commits use Conventional Commits: `fix(web): …`, `feat: …`, `refactor(server): …`.

### For agents

Start with this README, then SPEC.md (§3 architecture, §10 server, §14 views, §17 phases), then
the code the task touches. Run the checks above and report their output; do not claim a UI
change works without loading it in the browser or saying you did not. The installed service
may be running the code from before your change; restart it (`systemctl --user restart
token-dashboard`) or use `bun run dev` to see your change. Plans and specs under
`docs/superpowers/` are working notes and stay untracked.
