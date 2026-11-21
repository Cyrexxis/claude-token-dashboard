// Installs this checkout as a systemd user service (design: phase 4 local install).
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  /** The running compiled program (program mode), else null. */
  programPath: string | null;
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

/** Inside a quoted systemd value: `\` and `"` are escapes, `%` starts a specifier. */
const esc = (v: string) => v.replace(/[\\"]/g, "\\$&").replace(/%/g, "%%");

export function programDir(env: InstallDeps["env"]): string {
  return join(env.HOME ?? "", ".local", "share", SERVICE, "bin");
}
export const installedProgram = (env: InstallDeps["env"]) => join(programDir(env), SERVICE);

type UnitTarget = { bunPath: string; repoDir: string } | { program: string };

export function unitFile(o: { env: InstallDeps["env"] } & UnitTarget): string {
  const envLines = UNIT_ENV.filter((k) => o.env[k] !== undefined).map(
    (k) => `Environment="${esc(`${k}=${o.env[k]}`)}"\n`,
  );
  const [exec, dir] =
    "program" in o
      ? [`"${esc(o.program)}" serve`, ""]
      : [
          `"${esc(o.bunPath)}" "${esc(o.repoDir)}/server/src/cli.ts" serve`,
          `WorkingDirectory=${o.repoDir}\n`,
        ];
  return `[Unit]
Description=Token Dashboard

[Service]
ExecStart=${exec}
${dir}${envLines.join("")}Restart=on-failure

[Install]
WantedBy=default.target
`;
}

/** Reads the `Environment="K=V"` lines back (undoing `esc`). */
export function unitEnv(unitText: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of unitText.matchAll(/^Environment="(.*)"$/gm)) {
    const kv = (m[1] ?? "").replace(/\\(.)|%%/g, (_, c) => c ?? "%");
    const i = kv.indexOf("=");
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

/** Puts the running program at its install path (old one kept as `.prev`); false when nothing was copied. */
function installProgram(d: InstallDeps, from: string): boolean {
  const dest = installedProgram(d.env);
  mkdirSync(programDir(d.env), { recursive: true });
  if (from === dest) return false; // copying a file onto itself would truncate it
  const tmp = `${dest}.tmp`;
  try {
    copyFileSync(from, tmp);
    chmodSync(tmp, 0o755);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e; // the installed program stays untouched
  }
  if (existsSync(dest)) renameSync(dest, `${dest}.prev`);
  renameSync(tmp, dest); // atomic; replacing a running program is fine on Linux
  return true;
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
  if (!d.programPath) {
    d.log("building the web UI…");
    if (d.run(["bun", "run", "build:web"], { cwd: d.repoDir }).code !== 0)
      throw new Error("web build failed");
  }

  const chosen = targets.map((t) => t.path);
  for (const p of d.config.connectionFiles ?? [d.config.connectionPath])
    if (!chosen.includes(p)) rmSync(p, { force: true });
  for (const t of targets) writeConnectionFile(t.path, url(d), t.extra);
  setConfigKey(d.config.configPath, "connectionFiles", chosen);

  d.log(`installing and starting the ${SERVICE} service…`);
  const unit = unitPath(d.env);
  mkdirSync(dirname(unit), { recursive: true });
  if (d.programPath) {
    installProgram(d, d.programPath);
    writeFileSync(unit, unitFile({ env: d.env, program: installedProgram(d.env) }));
  } else {
    rmSync(programDir(d.env), { recursive: true, force: true });
    writeFileSync(unit, unitFile(d));
  }
  must(d, ["systemctl", "--user", "daemon-reload"]);
  must(d, ["systemctl", "--user", "enable", SERVICE]);
  must(d, ["systemctl", "--user", "restart", SERVICE]);
  waitHealthy(d);
  d.log(`dashboard: ${url(d)}`);
  for (const p of chosen) d.log(`connection file: ${p}`);
}

function updateProgram(d: InstallDeps, from: string): void {
  const unit = unitPath(d.env);
  const oldUnit = readFileSync(unit, "utf8");
  const dest = installedProgram(d.env);
  d.log("installing the new version…");
  const copied = installProgram(d, from);
  try {
    writeFileSync(unit, unitFile({ env: unitEnv(oldUnit), program: dest }));
    must(d, ["systemctl", "--user", "daemon-reload"]);
    must(d, ["systemctl", "--user", "restart", SERVICE]);
    waitHealthy(d);
  } catch {
    if (copied)
      existsSync(`${dest}.prev`) ? renameSync(`${dest}.prev`, dest) : rmSync(dest, { force: true });
    writeFileSync(unit, oldUnit);
    d.run(["systemctl", "--user", "daemon-reload"]);
    d.run(["systemctl", "--user", "restart", SERVICE]);
    // The old program can refuse to start too, e.g. when the new one already migrated the database.
    let back = true;
    try {
      waitHealthy(d);
    } catch {
      back = false;
    }
    throw new Error(
      `update failed, ${back ? "previous version restored" : "and the previous version did not start either"}; see: journalctl --user -u ${SERVICE}`,
    );
  }
  d.log(`updated: ${url(d)}`);
}

export function update(d: InstallDeps): void {
  if (!existsSync(unitPath(d.env)))
    throw new Error(
      d.programPath
        ? "not installed; run /token-dashboard setup"
        : "not installed; run: bun run setup",
    );
  if (d.programPath) {
    updateProgram(d, d.programPath);
    return;
  }
  d.log("installing dependencies and building the web UI…");
  must(d, ["bun", "install"], d.repoDir);
  must(d, ["bun", "run", "build:web"], d.repoDir);
  must(d, ["systemctl", "--user", "restart", SERVICE]);
  waitHealthy(d);
  d.log(`updated: ${url(d)}`);
}

export function uninstall(d: InstallDeps): void {
  d.run(["systemctl", "--user", "disable", "--now", SERVICE]); // fails when never installed
  rmSync(unitPath(d.env), { force: true });
  rmSync(programDir(d.env), { recursive: true, force: true });
  d.run(["systemctl", "--user", "daemon-reload"]);
  for (const p of d.config.connectionFiles ?? [d.config.connectionPath]) rmSync(p, { force: true });
  if (existsSync(d.config.configPath))
    setConfigKey(d.config.configPath, "connectionFiles", undefined);
  d.log(`removed the ${SERVICE} service and its connection files`);
  d.log(`kept the database (${d.config.dbPath}) and config (${dirname(d.config.configPath)})`);
}
