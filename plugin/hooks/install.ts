import type { EngineInterface, ProcessRunInit } from "claude-code";

type $ = EngineInterface;
type Action = "setup" | "update" | "uninstall";

const RELEASES = "https://github.com/Cyrexxis/claude-token-dashboard/releases/download";
const ARCH: Record<string, string> = { x86_64: "x64", aarch64: "arm64" };
const SESSIONS: Record<string, string> = { Both: "both", WSL: "wsl", Windows: "windows" };

export async function pluginVersion($: $): Promise<string> {
  const { version } = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`));
  return String(version);
}

/** Numeric `x.y.z` compare: a is older than b. */
export function isOlder(a: string, b: string): boolean {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
}

/** /token-dashboard setup|update|uninstall: fetches the release program, verifies it and runs it. */
export async function installCommand(
  $: $,
  action: Action,
  serverVersion: string | null,
): Promise<string> {
  // A command that can't start or times out reads as a failed run, with the reason as stderr.
  const run = (argv: string[], init?: ProcessRunInit) =>
    $.process.run(argv, init).catch((e: unknown) => ({
      exitCode: -1,
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
    }));
  const output = (r: { exitCode: number; stdout: string; stderr: string }) => {
    const text = (r.stdout + r.stderr).trim();
    return r.exitCode === 0 ? text : `Failed: ${text}`;
  };
  // null: the dialog was dismissed, or nobody can answer it (-p).
  const ask = (question: string, options: string[]) =>
    $.ui.ask(question, options).catch(() => null);
  const interactive = `Run /token-dashboard ${action} in an interactive session.`;

  if ((await $.env.get("OS")) === "Windows_NT")
    return `Run /token-dashboard ${action} in a WSL session.`;
  if ((await run(["systemctl", "--user", "show-environment"])).exitCode !== 0)
    return "systemd user services are not available (enable systemd in WSL: /etc/wsl.conf [boot] systemd=true)";

  const version = await pluginVersion($);
  // Never a downgrade: a server as new as this mod or newer is left alone.
  if (action === "update" && serverVersion && !isOlder(serverVersion, version))
    return `Already up to date (v${serverVersion}).`;
  if (action === "setup" && serverVersion && isOlder(version, serverVersion))
    return `A newer Token Dashboard (v${serverVersion}) is running; update the plugin first: claude plugin update token-dashboard`;

  // update and uninstall act on the installed program only; a checkout install is managed from the checkout.
  const home = await $.env.get("HOME");
  const installed = `${home}/.local/share/token-dashboard/bin/token-dashboard`;
  if (action !== "setup" && (await run(["test", "-x", installed])).exitCode !== 0) {
    const config = (await $.env.get("XDG_CONFIG_HOME")) || `${home}/.config`;
    const unit = `${config}/systemd/user/token-dashboard.service`;
    if ((await run(["test", "-f", unit])).exitCode !== 0)
      return "Token Dashboard is not installed.";
    const there = action === "update" ? "git pull and bun run update" : "bun run uninstall";
    return `Installed from a checkout: run ${there} there.`;
  }
  if (action === "uninstall") {
    const ok = await ask("Uninstall Token Dashboard? The database and settings are kept.", [
      "Uninstall",
      "Cancel",
    ]);
    if (ok === null) return interactive;
    if (ok !== "Uninstall") return "Cancelled.";
    return output(await run([installed, "uninstall"], { timeoutMs: 300_000 }));
  }

  const machine = (await run(["uname", "-m"])).stdout.trim();
  const arch = ARCH[machine];
  if (!arch) return `Unsupported CPU: ${machine}`;
  const asset = `token-dashboard-linux-${arch}`;

  let sessions: string | undefined;
  if (action === "setup" && (await $.env.get("WSL_DISTRO_NAME"))) {
    const choice = await ask("Which Claude Code sessions should find the dashboard?", [
      "Both",
      "WSL",
      "Windows",
    ]);
    if (choice === null) return interactive;
    sessions = SESSIONS[choice];
    if (!sessions) return "Cancelled.";
  }

  const [question, yes] =
    action === "setup"
      ? [
          `Download Token Dashboard v${version} (linux-${arch}), install it as the systemd user service token-dashboard and start it?`,
          "Install",
        ]
      : [`Update Token Dashboard to v${version}?`, "Update"];
  const ok = await ask(question, [yes, "Cancel"]);
  if (ok === null) return interactive;
  if (ok !== yes) return "Cancelled.";

  const made = await run(["mktemp", "-d"]);
  if (made.exitCode !== 0) return output(made);
  const tmp = made.stdout.trim();
  try {
    $.ui.status("Token Dashboard: downloading…");
    const base = (await $.env.get("TD_RELEASE_URL")) || `${RELEASES}/v${version}/`;
    for (const name of [asset, "checksums.txt"]) {
      const r = await run(["curl", "-fsSL", "-o", `${tmp}/${name}`, `${base}${name}`], {
        timeoutMs: 600_000,
      });
      if (r.exitCode === 22 && r.stderr.includes("404"))
        return `Release v${version} is not published yet; try again later.`;
      if (r.exitCode !== 0) return `Download failed: ${r.stderr.trim()}`;
    }
    const sum = await run(["sha256sum", "-c", "--ignore-missing", "checksums.txt"], { cwd: tmp });
    if (sum.exitCode !== 0) return "Checksum mismatch: the download was not installed.";
    const program = `${tmp}/${asset}`;
    const chmod = await run(["chmod", "+x", program]);
    if (chmod.exitCode !== 0) return output(chmod);
    const argv =
      action === "setup"
        ? [program, "setup", "--connection-files", sessions ?? "wsl"]
        : [program, "update"];
    return output(await run(argv, { timeoutMs: 300_000 }));
  } finally {
    await run(["rm", "-rf", tmp]);
    $.ui.status(undefined);
  }
}
