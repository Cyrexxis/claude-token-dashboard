import type { MiddlewareHandler } from "hono";

/** Blocks DNS rebinding: only requests addressed to our own loopback host and port. */
export function hostGuard(port: number): MiddlewareHandler {
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return async (c, next) => {
    if (!allowed.has(c.req.header("host") ?? "")) return c.text("forbidden host", 403);
    await next();
  };
}

/** Blocks cross-site writes; requests without Origin (curl, the mod) pass. */
export function originGuard(port: number): MiddlewareHandler {
  const allowed = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  return async (c, next) => {
    const origin = c.req.header("origin");
    const write = c.req.method !== "GET" && c.req.method !== "HEAD";
    if (write && origin !== undefined && !allowed.has(origin))
      return c.text("forbidden origin", 403);
    await next();
  };
}
