import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

// Isolated server: fixture transcripts, throwaway DB/config, its own port — never touches the real dashboard.
const PORT = 47899;
const tmp = mkdtempSync(join(tmpdir(), "td-e2e-"));
writeFileSync(join(tmp, "config.json"), JSON.stringify({ windowsRoots: false }));

export default defineConfig({
  testDir: "e2e",
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  webServer: {
    command: "bun run build:web && bun server/src/cli.ts serve",
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    env: {
      TD_PORT: String(PORT),
      TD_DATA_DIR: join(tmp, "data"),
      TD_CONFIG: join(tmp, "config.json"),
      CLAUDE_CONFIG_DIR: join(import.meta.dirname, "fixtures/transcripts/sample"),
    },
  },
});
