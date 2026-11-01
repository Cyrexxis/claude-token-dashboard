import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type ApiError, type Bucket, type Group, type Metric, PROTOCOL } from "@td/shared";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import type { Config } from "../config";
import { bus } from "../events";
import { getPlanSnapshots, getPlanWindows, recordSnapshots } from "../plan";
import type { IngestService } from "../service";
import { SERVER_VERSION } from "../version";
import { hostGuard, originGuard } from "./guards";
import {
  BadRequest,
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

const SSE_EVENTS = ["usage.updated", "prices.updated", "ingest.status", "plan.snapshot"] as const;
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
    return c.json<ApiError>({ error: "internal", message: (e as Error).message }, 500);
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
        metric: oneOf<Metric>("metric", q.metric, ["tokens", "cost", "requests"], "tokens"),
        group: oneOf<Group>("group", q.group, ["type", "model", "source", "project"], "type"),
        bucket: oneOf<Bucket>("bucket", q.bucket, ["day", "week", "month"], "day"),
      }),
    );
  });
  v1.get("/sessions", (c) => {
    const q = c.req.query();
    return c.json(
      listSessions(db, { ...parseRange(q), q: q.q, limit: int(q.limit), offset: int(q.offset) }),
    );
  });
  v1.get("/sessions/:id", (c) => {
    const s = getSession(db, c.req.param("id"));
    return s
      ? c.json(s)
      : c.json<ApiError>({ error: "not_found", message: "no such session" }, 404);
  });
  v1.get("/plan/windows", (c) => c.json(getPlanWindows(db, parseRange(c.req.query()), Date.now())));
  v1.get("/plan/sessions", (c) => {
    const q = c.req.query();
    return c.json(listWindowSessions(db, Number(q.fromMs), Number(q.toMs)));
  });
  v1.get("/plan/timeseries", (c) => {
    const q = c.req.query();
    return c.json(
      getWindowTimeseries(db, {
        metric: oneOf<Metric>("metric", q.metric, ["tokens", "cost", "requests"], "tokens"),
        group: oneOf<Group>(
          "group",
          q.group,
          ["type", "model", "source", "project", "agent"],
          "type",
        ),
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
    const points = recordSnapshots(db, await jsonBody(c.req.raw), Date.now());
    for (const p of points) bus.emit("plan.snapshot", p);
    return c.json({ stored: points.length });
  });
  v1.post("/ingest/trigger", async (c) => {
    const body = (await jsonBody(c.req.raw)) as { sessionId?: unknown } | null;
    const id = body?.sessionId;
    if (typeof id !== "string" || id.length < 1 || id.length > 200)
      throw new BadRequest("sessionId must be a string of 1 to 200 characters");
    ingest
      .ingestSession(id)
      .catch((e) => console.error(`ingest trigger ${id} failed: ${(e as Error).message}`));
    return c.json({ queued: true }, 202);
  });
  v1.post("/sources/:id/rescan", (c) => {
    const id = Number(c.req.param("id"));
    const known = db.query("SELECT 1 FROM sources WHERE id = ?").get(id);
    if (!known) return c.json<ApiError>({ error: "not_found", message: "no such source" }, 404);
    ingest
      .rescanSource(id)
      .catch((e) => console.error(`rescan ${id} failed: ${(e as Error).message}`));
    return c.json({ queued: true }, 202);
  });

  v1.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const forward = SSE_EVENTS.map((event) => {
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
