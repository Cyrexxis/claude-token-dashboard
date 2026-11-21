# Token Dashboard

A local dashboard for your Claude usage: token statistics by type, API-equivalent cost at the
prices valid at the time of each request, and subscription plan usage (5-hour and weekly windows).

It reads Claude Code transcripts, stores them in SQLite, and serves a React dashboard from one
local Bun program. A Claude Code mod (plugin) sends plan readings and "ingest now" signals so the
dashboard updates live.

**Privacy:** everything stays on your machine. The server listens on `127.0.0.1` only and makes
no outbound network connections (`bun run check:network` enforces this). No telemetry, no CDNs.

> Status: phases 1–3 and the Linux/WSL release part of phase 4 are done. A Windows-side
> server is not built yet. See [SPEC.md](SPEC.md) §17 for the roadmap.

---

## Install

In a terminal:

```sh
claude plugin marketplace add Cyrexxis/claude-token-dashboard
claude plugin install token-dashboard@token-dashboard
```

then, in a Claude Code session:

```
/token-dashboard setup
```

`setup` downloads the program for your machine from the GitHub Release that matches the plugin,
checks its checksum, asks which connection files to write (WSL, Windows, or both), installs a
systemd user service called `token-dashboard`, starts it, and waits until it answers. It prints
the dashboard link, by default **http://127.0.0.1:47811**. In WSL, run it from a WSL session; a
Windows session refuses it.

Requirements: Linux or WSL with systemd user services (`systemctl --user` must work), `curl` and
`sha256sum`. You do not need Bun.

On first start the server scans every transcript it finds, so the first page load may take a
moment on a large history.

### Update and uninstall

```sh
claude plugin update token-dashboard
```

then `/token-dashboard update` in a session. It does nothing if the server is already as new as
the plugin. If the new program fails to start, the previous one is put back.

`/token-dashboard uninstall` removes the service, the program and the connection files. It keeps
the database and config.

The mod gives the Plan view its data and makes the dashboard update after every turn. Without it
you still get tokens and cost, picked up by the file watcher, but no plan usage. On session start
it checks that the server is up and starts the service if it is not.

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

### Command line (checkout / development)

These commands are for a checkout (see Development); the plugin install does not need them:

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
| Installed program (plugin install; the previous one is kept as `.prev`) | `~/.local/share/token-dashboard/bin/token-dashboard` |
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
`CLAUDE_CONFIG_DIR`. For the plugin path, set them before starting Claude Code (the mod passes its environment to
the program); `setup` copies them into the service and `update` keeps the service's existing values.

Your history is kept even after Claude Code deletes old transcripts. To keep more transcripts
on disk in the first place, raise `cleanupPeriodDays` in Claude Code's settings.

### Troubleshooting

- **Dashboard does not load:** `systemctl --user status token-dashboard`, then the logs above.
- **Port 47811 is busy:** set `TD_PORT` and run `/token-dashboard setup` again.
- **No plan data:** the mod is not loaded in your Claude Code session (see *Install*).
- **"unpriced requests":** a model is missing from `prices/prices.json`; add it to
  `prices.local.json`; prices reload automatically (`bun run reprice` is the checkout command).

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

### Run from a checkout

```sh
git clone https://github.com/Cyrexxis/claude-token-dashboard.git token-dashboard
cd token-dashboard
bun install
bun run setup       # also: bun run update, bun run uninstall
claude --plugin-dir ./plugin
```

Needs [Bun](https://bun.sh) 1.4 or newer. `bun run setup` builds the web UI and installs a
service that runs the checkout. It removes a program installed by `/token-dashboard setup`
(`~/.local/share/token-dashboard/bin/`), so the two installs never compete.

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

### Releasing

1. Bump `version` in `plugin/.claude-plugin/plugin.json`. It is the only version.
2. Run `bun run test:mod` and `bun run test:e2e`.
3. Commit, tag `v<version>`, and push the tag.

`.github/workflows/release.yml` checks that the tag matches `plugin.json`, runs the checks,
builds `token-dashboard-linux-x64`, `token-dashboard-linux-arm64` and `checksums.txt`, and attaches
them to a GitHub Release.

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
