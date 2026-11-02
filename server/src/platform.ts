import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import type { SourceKind } from "@td/shared";

export type Platform = { kind: SourceKind; host: string; distro: string | null };

function readProcVersion(): string {
  try {
    return readFileSync("/proc/version", "utf8");
  } catch {
    return "";
  }
}

export function detectPlatform(
  env: Record<string, string | undefined> = process.env,
  procVersion: string = readProcVersion(),
): Platform {
  const host = hostname();
  if (process.platform === "win32") return { kind: "windows", host, distro: null };
  if (env.WSL_DISTRO_NAME || /microsoft/i.test(procVersion))
    return { kind: "wsl", host, distro: env.WSL_DISTRO_NAME ?? null };
  return { kind: "linux", host, distro: null };
}
