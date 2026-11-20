import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type ApiError,
  BUCKETS,
  errorMessage,
  GROUPS,
  LIVE_EVENTS,
  METRICS,
  PROTOCOL,
  ROLLUP_GROUPS,
} from "@td/shared";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import type { Config } from "../config";
import { bus } from "../events";
import { rekeyProjects } from "../ingest/project";
import { getPlanSnapshots, getPlanWindows, recordSnapshots, withPlanPercent } from "../plan";
import type { IngestService } from "../service";
import { getSettings, saveSettings } from "../settings";
import { SERVER_VERSION } from "../version";
import { hostGuard, originGuard } from "./guards";
import {
  BadRequest,
  getBreakdown,
  getPrices,
  getSession,
  getStatus,
  getSummary,
  getTimeseries,
  getWindowTimeseries,
  listSessions,
  listSources,
  listWindowSessions,
  parseRange,
} from "./queries";

export type AppDeps = {
  db: Database;
  config: Config;
  ingest: IngestService;
  startedAt: number;
  webDir: string | null;
};

const PING_MS = 25_000;

function oneOf<T extends string>(
  name: string,
  v: string | undefined,
  allowed: readonly T[],
  dflt: T,
): T {
  if (v === undefined) return dflt;
  if (!allowed.includes(v as T))
    throw new BadRequest(`${name} must be one of ${allowed.join(", ")}`);
  return v as T;
}
async function jsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new BadRequest("body must be JSON");
  }
}
const int = (v: string | undefined) => (v === undefined ? undefined : Number(v));

export function createApp({ db, config, ingest, startedAt, webDir }: AppDeps): Hono {
  const app = new Hono();
  app.use(hostGuard(config.port), originGuard(config.port));

  app.onError((e, c) => {
    if (e instanceof BadRequest)
      return c.json<ApiError>({ error: "bad_request", message: e.message }, 400);
    console.error(e);
    return c.json<ApiError>({ error: "internal", message: errorMessage(e) }, 500);
  });

  app.get("/api/health", (c) => c.json({ ok: true, version: SERVER_VERSION, protocol: PROTOCOL }));

  app.use("/api/v1/*", async (c, next) => {
    const sent = c.req.header("x-td-protocol");
    if (sent !== undefined && Number.parseInt(sent, 10) !== PROTOCOL)
      return c.json<ApiError>(
        {
          error: "protocol",
          message: `Server speaks protocol ${PROTOCOL}, client sent ${sent}. Update the plugin or the server (/token-dashboard update).`,
        },
        400,
      );
    await next();
  });

  const v1 = new Hono();
  v1.get("/summary", (c) =>
    c.json(getSummary(db, parseRange(c.req.query()), config.subscriptionMonthlyUsd)),
  );
  v1.get("/timeseries", (c) => {
    const q = c.req.query();
    return c.json(
      getTimeseries(db, {
        ...parseRange(q),
        metric: oneOf("metric", q.metric, METRICS, "tokens"),
        group: oneOf("group", q.group, ROLLUP_GROUPS, "type"),
        bucket: oneOf("bucket", q.bucket, BUCKETS, "day"),
      }),
    );
  });
  v1.get("/breakdown", (c) => {
    const q = c.req.query();
    return c.json(
      getBreakdown(db, {
        ...parseRange(q),
        metric: oneOf("metric", q.metric, METRICS, "tokens"),
        by: oneOf("by", q.by, ["project", "model"] as const, "project"),
        group: oneOf("group", q.group, ROLLUP_GROUPS, "type"),
      }),
    );
  });
  v1.get("/sessions", (c) => {
    const q = c.req.query();
    const list = listSessions(db, {
      ...parseRange(q),
      q: q.q,
      limit: int(q.limit),
      offset: int(q.offset),
    });
    return c.json({ ...list, items: withPlanPercent(db, list.items, Date.now()) });
  });
  v1.get("/sessions/:id", (c) => {
    const s = getSession(db, c.req.param("id"));
    if (!s) return c.json<ApiError>({ error: "not_found", message: "no such session" }, 404);
    const [session] = withPlanPercent(db, [s.session], Date.now());
    return c.json({ ...s, session });
  });
  v1.get("/plan/windows", (c) => {
    const s = getSettings(db);
    const other = s.otherProducts ? { estimate: s.otherEstimate } : undefined;
    return c.json(getPlanWindows(db, parseRange(c.req.query()), Date.now(), other));
  });
  v1.get("/settings", (c) => c.json(getSettings(db)));
  v1.put("/settings", async (c) => c.json(saveSettings(db, await jsonBody(c.req.raw))));
  v1.get("/plan/sessions", (c) => {
    const q = c.req.query();
    return c.json(listWindowSessions(db, Number(q.fromMs), Number(q.toMs)));
  });
  v1.get("/plan/timeseries", (c) => {
    const q = c.req.query();
    return c.json(
      getWindowTimeseries(db, {
        metric: oneOf("metric", q.metric, METRICS, "tokens"),
        group: oneOf("group", q.group, GROUPS, "type"),
        fromMs: Number(q.fromMs),
        toMs: Number(q.toMs),
        stepMs: Number(q.stepMs),
        sessionId: q.sessionId || undefined,
      }),
    );
  });
  v1.get("/plan/snapshots", (c) => c.json(getPlanSnapshots(db, parseRange(c.req.query()))));
  v1.get("/sources", (c) => c.json(listSources(db)));
  v1.get("/prices", async (c) =>
    c.json(await getPrices(db, config.localPricesPath, ingest.localPricesError())),
  );
  v1.get("/status", (c) =>
    c.json(getStatus(db, { startedAt, dbPath: config.dbPath, ingest: ingest.state() })),
  );

  v1.put("/prices/local", async (c) => {
    const r = await ingest.saveLocalPrices(await c.req.text());
    if (!r.ok)
      return c.json<ApiError>(
        { error: "invalid_prices", message: "prices.local.json is invalid", errors: r.errors },
        400,
      );
    return c.json(r);
  });
  v1.post("/plan-snapshots", async (c) => {
    const { stored, confirmed } = recordSnapshots(db, await jsonBody(c.req.raw), Date.now());
    for (const p of [...stored, ...confirmed]) bus.emit("plan.snapshot", p);
    return c.json({ stored: stored.length });
  });
  v1.post("/ingest/trigger", async (c) => {
    const body = (await jsonBody(c.req.raw)) as { sessionId?: unknown } | null;
    const id = body?.sessionId;
    if (typeof id !== "string" || id.length < 1 || id.length > 200)
      throw new BadRequest("sessionId must be a string of 1 to 200 characters");
    ingest
      .ingestSession(id)
      .catch((e) => console.error(`ingest trigger ${id} failed: ${errorMessage(e)}`));
    return c.json({ queued: true }, 202);
  });
  v1.post("/projects/rekey", (c) => {
    const sessionIds = rekeyProjects(db);
    if (sessionIds.length) bus.emit("usage.updated", { sessionIds, from: 0, to: Date.now() });
    return c.json({ sessions: sessionIds.length });
  });
  v1.post("/sources/:id/rescan", (c) => {
    const id = Number(c.req.param("id"));
    const known = db.query("SELECT 1 FROM sources WHERE id = ?").get(id);
    if (!known) return c.json<ApiError>({ error: "not_found", message: "no such source" }, 404);
    ingest.rescanSource(id).catch((e) => console.error(`rescan ${id} failed: ${errorMessage(e)}`));
    return c.json({ queued: true }, 202);
  });

  v1.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const forward = LIVE_EVENTS.map((event) => {
        const listener = (data: unknown) =>
          void stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {});
        bus.on(event, listener);
        return () => bus.off(event, listener);
      });
      const ping = setInterval(() => void stream.write(": ping\n\n").catch(() => {}), PING_MS);
      await new Promise<void>((resolve) =>
        stream.onAbort(() => {
          clearInterval(ping);
          for (const off of forward) off();
          resolve();
        }),
      );
    }),
  );
  app.route("/api/v1", v1);

  if (webDir && existsSync(join(webDir, "index.html"))) app.use("*", serveStatic({ root: webDir }));
  else app.get("/", (c) => c.text("UI not built: run bun run build:web", 503));

  return app;
}
