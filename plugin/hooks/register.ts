import type { EngineInterface, Register } from "claude-code";
import {
  type Connection,
  connectionPath,
  enqueue,
  readConnection,
  readQueue,
  send,
  writeQueue,
} from "./client";
import { installCommand, isOlder, pluginVersion } from "./install";

type $ = EngineInterface;
const COMMAND = "token-dashboard";
const START_RETRIES = 5;
const END_WAIT_MS = 1_500;

// Module state lives per load. The connection is dropped after a failed send, so a port
// changed by setup is picked up on the next call.
let conn: Connection | null = null;
let toasted = false;
let updateToasted = false;
// Queue writes run one at a time so a flush and an enqueue never overwrite each other.
let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
};

async function connection($: $): Promise<Connection | null> {
  conn ??= await readConnection($);
  if (!conn && !toasted) {
    toasted = true;
    $.ui.toast("Token Dashboard: no server.json found; run /token-dashboard setup");
  }
  return conn;
}

const health = ($: $, c: Connection) => send($, c, "/api/health");

/** Health check; when it fails and setup recorded a start command, run it and wait for health. */
async function connect($: $): Promise<void> {
  const c = await connection($);
  if (!c) return;
  let h = await health($, c);
  if (h === null) {
    conn = null;
    if (c.start?.length) {
      await $.process.run(c.start).catch(() => {});
      for (let i = 0; i < START_RETRIES; i++) {
        h = await health($, c);
        if (h !== null) break;
        await $.clock.sleep(1_000);
      }
    }
  }
  if (h !== null) await offerUpdate($, h).catch(() => {});
  await flush($, c);
}

/** A server older than this mod: say once per load that the update is ready (not on Windows: no installer there). */
async function offerUpdate($: $, healthBody: string): Promise<void> {
  if (updateToasted || (await $.env.get("OS")) === "Windows_NT") return;
  const running = parse(healthBody)?.version;
  const mine = await pluginVersion($);
  if (typeof running !== "string" || !isOlder(running, mine)) return;
  const installed = `${await $.env.get("HOME")}/.local/share/token-dashboard/bin/token-dashboard`;
  // A checkout install updates with git pull + bun run update, not this command.
  const r = await $.process.run(["test", "-x", installed]).catch(() => null);
  if (r?.exitCode !== 0) return;
  updateToasted = true;
  $.ui.toast(`Token Dashboard v${mine} is ready: run /token-dashboard update`);
}

/** The running server's version, null when unreachable or not saying. */
async function serverVersion($: $): Promise<string | null> {
  const c = await readConnection($);
  const v = c && parse(await health($, c))?.version;
  return typeof v === "string" ? v : null;
}

function flush($: $, c: Connection): Promise<void> {
  return serial(async () => {
    const left: string[] = [];
    for (const id of await readQueue($))
      if ((await send($, c, "/api/v1/ingest/trigger", { sessionId: id })) === null) left.push(id);
    await writeQueue($, left);
  });
}

async function trigger($: $, sessionId: string): Promise<void> {
  const c = await connection($);
  const ok = c && (await send($, c, "/api/v1/ingest/trigger", { sessionId })) !== null;
  if (!ok) conn = null;
  if (!ok) return serial(async () => writeQueue($, enqueue(await readQueue($), sessionId)));
  if ((await readQueue($)).length && c) await flush($, c);
}

/** Network work runs on a timer, outside the hook's dispatch: Claude never waits on it. */
const later = ($: $, fn: () => Promise<unknown>) =>
  void $.clock.after(0, () => void fn().catch(() => {}));

/** A reply body as an object; null when missing or not JSON (a proxy, another service on the port). */
function parse(text: string | null): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text ?? "");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function statusText($: $): Promise<string> {
  const path = await connectionPath($);
  const c = await readConnection($);
  const queued = (await readQueue($)).length;
  const lines = [`Connection file: ${path ?? "unknown"}`];
  if (!c) return [...lines, "Not found: run /token-dashboard setup"].join("\n");
  const health = await send($, c, "/api/health");
  if (health === null)
    return [
      ...lines,
      `Server ${c.url} not reachable (run /token-dashboard setup)`,
      `Queued ingest triggers: ${queued}`,
    ].join("\n");
  const h = parse(health) as { version?: string; protocol?: number } | null;
  if (!h)
    return [
      ...lines,
      `Server ${c.url}: unexpected response (not a token-dashboard server?)`,
      `Queued ingest triggers: ${queued}`,
    ].join("\n");
  lines.push(`Server ${c.url}: version ${h.version}, protocol ${h.protocol}`);
  const s = parse(await send($, c, "/api/v1/status")) as {
    requests?: number;
    unpricedModels?: string[];
    ingest?: { lastRunAt: number | null; lastErrors: number };
  } | null;
  if (s) {
    const last = s.ingest?.lastRunAt ? new Date(s.ingest.lastRunAt).toLocaleString() : "never";
    lines.push(
      `Requests stored: ${s.requests ?? 0}`,
      `Last ingest: ${last}, errors: ${s.ingest?.lastErrors ?? 0}`,
      `Unpriced models: ${s.unpricedModels?.join(", ") || "none"}`,
    );
  }
  lines.push(`Queued ingest triggers: ${queued}`);
  return lines.join("\n");
}

/** Opens the dashboard: wslview, then cmd.exe in WSL; xdg-open on Linux; cmd on Windows. */
async function openText($: $): Promise<string> {
  const c = await readConnection($);
  if (!c) return "No server.json found; run /token-dashboard setup";
  const tries =
    (await $.env.get("OS")) === "Windows_NT"
      ? [["cmd", "/c", "start", "", c.url]]
      : (await $.env.get("WSL_DISTRO_NAME"))
        ? [
            ["wslview", c.url],
            ["cmd.exe", "/c", "start", c.url],
          ]
        : [["xdg-open", c.url]];
  for (const argv of tries) {
    const r = await $.process.run(argv).catch(() => null);
    if (r?.exitCode === 0) return `Opened ${c.url}`;
  }
  return `Open ${c.url} in your browser`;
}

function registerCommand($: $) {
  return $.command.register({
    name: COMMAND,
    description: "Token Dashboard: setup | update | status | open | uninstall",
    argumentHint: "setup|update|status|open|uninstall",
  });
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    const r = await next(e);
    await registerCommand($);
    later($, () => connect($));
    return r;
  });

  // /clear starts a new session without a session.start; commands are per session, so declare it again.
  on("classic.SessionStart", async ($, e, next) => {
    const r = await next(e);
    if (e.source === "clear") await registerCommand($);
    return r;
  });

  on("turn.complete", async ($, e, next) => {
    const r = await next(e);
    // Subagent turns are covered by the main turn's trigger (it re-reads the session's subagent files).
    if (!e.agentId) later($, async () => trigger($, await $.session.id()));
    return r;
  });

  on("session.measure", async ($, e, next) => {
    const r = await next(e);
    const moved = e.changed.includes("rateLimits") || e.changed.includes("cost");
    if (moved && e.rateLimits.length)
      later($, async () => {
        const c = await connection($);
        // Not queued: plan % is cumulative, the next reading carries it (design decision).
        if (c)
          await send($, c, "/api/v1/plan-snapshots", {
            windows: e.rateLimits,
            sessionCostUsd: e.cost?.usd,
          });
      });
    return r;
  });

  on("session.end", async ($, e, next) => {
    const r = await next(e);
    // The process may exit right after: send inline, bounded, instead of on a timer.
    const wait = Math.min(END_WAIT_MS, Math.max(next.budget.remainingMs - 200, 0));
    await Promise.race([trigger($, e.sessionId).catch(() => {}), $.clock.sleep(wait)]);
    return r;
  });

  on("command.run", { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim();
    if (arg === "status") return { text: await statusText($) };
    if (arg === "open") return { text: await openText($) };
    if (arg === "setup" || arg === "update" || arg === "uninstall")
      return { text: await installCommand($, arg, await serverVersion($)) };
    return { text: "Usage: /token-dashboard setup | update | status | open | uninstall" };
  });
};
