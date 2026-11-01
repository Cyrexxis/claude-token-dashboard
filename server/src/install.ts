// Installs this checkout as a systemd user service (design: phase 4 local install).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Config, setConfigKey } from "./config";
import { writeConnectionFile } from "./connection";
import type { Platform } from "./platform";

export type Run = (cmd: string[], opts?: { cwd?: string }) => { code: number; out: string };
export type InstallDeps = {
  env: Record<string, string | undefined>;
  config: Config;
  platform: Platform;
  repoDir: string;
  bunPath: string;
  run: Run;
  ask: (question: string) => string | null;
  log: (line: string) => void;
  portFree: (port: number) => boolean;
  sleep: (ms: number) => void;
};

export const SERVICE = "token-dashboard";
// Read by the server; copied into the unit because systemd does not pass the shell's env.
const UNIT_ENV = ["TD_PORT", "TD_CONFIG", "TD_DATA_DIR", "CLAUDE_CONFIG_DIR"];
const START = ["systemctl", "--user", "start", SERVICE];

export function unitPath(env: InstallDeps["env"]): string {
  const base = env.XDG_CONFIG_HOME ?? join(env.HOME ?? "", ".config");
  return join(base, "systemd", "user", `${SERVICE}.service`);
}

export function unitFile(o: { bunPath: string; repoDir: string; env: InstallDeps["env"] }): string {
  const envLines = UNIT_ENV.filter((k) => o.env[k] !== undefined).map(
    (k) => `Environment="${k}=${o.env[k]}"\n`,
  );
  return `[Unit]
Description=Token Dashboard

[Service]
ExecStart="${o.bunPath}" "${o.repoDir}/server/src/cli.ts" serve
WorkingDirectory=${o.repoDir}
${envLines.join("")}Restart=on-failure

[Install]
WantedBy=default.target
`;
}

const url = (d: InstallDeps) => `http://127.0.0.1:${d.config.port}`;

function must(d: InstallDeps, cmd: string[], cwd?: string): void {
  const r = d.run(cmd, cwd ? { cwd } : undefined);
  if (r.code !== 0) throw new Error(`${cmd.join(" ")} failed (${r.code}): ${r.out.trim()}`);
}

function windowsConnectionPath(d: InstallDeps): string {
  const appData = d.run(["cmd.exe", "/c", "echo %APPDATA%"], { cwd: "/mnt/c" });
  const win = appData.out.trim();
  const unix = appData.code === 0 && win ? d.run(["wslpath", "-u", win]) : null;
  const dir = unix?.code === 0 ? unix.out.trim() : "";
  if (!dir) throw new Error("cannot find the Windows %APPDATA% folder");
  return join(dir, "token-dashboard", "server.json");
}

type Target = { path: string; extra: Record<string, unknown> };

function chooseTargets(d: InstallDeps): Target[] {
  const linux: Target = {
    path: d.config.connectionPath,
    extra: { serverLocation: d.platform.kind, start: START },
  };
  if (d.platform.kind !== "wsl") return [linux];
  const answer = (d.ask("Connection files: 1) WSL  2) Windows  3) both [3]: ") ?? "").trim() || "3";
  if (!["1", "2", "3"].includes(answer)) throw new Error(`unknown choice: ${answer}`);
  if (answer === "1") return [linux];
  if (!d.platform.distro)
    throw new Error("WSL_DISTRO_NAME is not set; cannot build the Windows start command");
  const windows: Target = {
    path: windowsConnectionPath(d),
    extra: { serverLocation: "wsl", start: ["wsl.exe", "-d", d.platform.distro, "--", ...START] },
  };
  return answer === "2" ? [windows] : [linux, windows];
}

export function waitHealthy(d: InstallDeps): void {
  for (let i = 0; i < 20; i++) {
    if (i > 0) d.sleep(500);
    if (d.run(["curl", "-sf", `${url(d)}/api/health`]).code === 0) return;
  }
  throw new Error(`server did not answer at ${url(d)}; see: journalctl --user -u ${SERVICE}`);
}

export function setup(d: InstallDeps): void {
  if (d.platform.kind === "windows") throw new Error("setup runs in WSL or Linux");
  if (d.run(["systemctl", "--user", "show-environment"]).code !== 0)
    throw new Error(
      "systemd user services are not available (enable systemd in WSL: /etc/wsl.conf [boot] systemd=true)",
    );
  const active = d.run(["systemctl", "--user", "is-active", SERVICE]).code === 0;
  if (!active && !d.portFree(d.config.port))
    throw new Error(`port ${d.config.port} is in use; stop the other process or set TD_PORT`);
  const targets = chooseTargets(d);
  if (d.run(["bun", "run", "build:web"], { cwd: d.repoDir }).code !== 0)
    throw new Error("web build failed");

  const chosen = targets.map((t) => t.path);
  for (const p of d.config.connectionFiles ?? [d.config.connectionPath])
    if (!chosen.includes(p)) rmSync(p, { force: true });
  for (const t of targets) writeConnectionFile(t.path, url(d), t.extra);
  setConfigKey(d.config.configPath, "connectionFiles", chosen);

  const unit = unitPath(d.env);
  mkdirSync(dirname(unit), { recursive: true });
  writeFileSync(unit, unitFile(d));
  must(d, ["systemctl", "--user", "daemon-reload"]);
  must(d, ["systemctl", "--user", "enable", SERVICE]);
  must(d, ["systemctl", "--user", "restart", SERVICE]);
  waitHealthy(d);
  d.log(`dashboard: ${url(d)}`);
  for (const p of chosen) d.log(`connection file: ${p}`);
}
