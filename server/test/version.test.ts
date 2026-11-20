import { expect, test } from "bun:test";
import plugin from "../../plugin/.claude-plugin/plugin.json";
import { SERVER_VERSION } from "../src/version";

test("server version is the plugin version", () => {
  expect(SERVER_VERSION).toBe(plugin.version);
});
