import { afterEach, expect, test } from "bun:test";
import { api, HttpError, NetworkError } from "../src/api";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const respond = (body: string, status: number) => {
  globalThis.fetch = (async () =>
    new Response(body, { status, headers: { "content-type": "application/json" } })) as never;
};

test("a rejected fetch is a NetworkError", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch");
  }) as never;
  await expect(api("/x")).rejects.toBeInstanceOf(NetworkError);
});

test("a broken JSON body is an HttpError, not a network error", async () => {
  respond("{bad", 200);
  const e = await api("/x").catch((e: unknown) => e);
  expect(e).toBeInstanceOf(HttpError);
  expect((e as HttpError).status).toBe(200);
});

test("an API error body becomes the HttpError message", async () => {
  respond(JSON.stringify({ error: "not_found", message: "no such session" }), 404);
  const e = (await api("/x").catch((e: unknown) => e)) as HttpError;
  expect(e).toBeInstanceOf(HttpError);
  expect(e.message).toBe("no such session");
  expect(e.name).toBe("HttpError");
});

test("a 200 that is not JSON (proxy, other service) is an HttpError, not empty data", async () => {
  globalThis.fetch = (async () =>
    new Response("<html></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })) as never;
  const e = await api("/x").catch((e: unknown) => e);
  expect(e).toBeInstanceOf(HttpError);
  expect((e as HttpError).message).toContain("unexpected response");
});
