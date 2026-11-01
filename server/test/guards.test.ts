import { expect, test } from "bun:test";
import { Hono } from "hono";
import { hostGuard, originGuard } from "../src/api/guards";

const app = new Hono()
  .use(hostGuard(47811), originGuard(47811))
  .get("/", (c) => c.text("ok"))
  .post("/", (c) => c.text("ok"));

const call = (method: string, headers: Record<string, string>) =>
  app.request("http://x/", { method, headers: { host: "127.0.0.1:47811", ...headers } });

test("hostGuard allows only our host and port", async () => {
  for (const host of ["127.0.0.1:47811", "localhost:47811"])
    expect((await call("GET", { host })).status).toBe(200);
  for (const host of ["evil.example:47811", "127.0.0.1:5173", "localhost", ""])
    expect((await call("GET", { host })).status).toBe(403);
});

test("originGuard blocks cross-site writes only", async () => {
  expect((await call("POST", {})).status).toBe(200); // no Origin: curl, the mod
  for (const origin of ["http://127.0.0.1:47811", "http://localhost:47811"])
    expect((await call("POST", { origin })).status).toBe(200);
  for (const origin of [
    "https://evil.example",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:47811.evil.example",
    "null",
  ])
    expect((await call("POST", { origin })).status).toBe(403);
  // Reads are protected by the browser's same-origin policy.
  expect((await call("GET", { origin: "https://evil.example" })).status).toBe(200);
});
