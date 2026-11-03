import type { Bucket } from "@td/shared";

export function fmtTokens(n: number): string {
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units)
    if (Math.abs(n) >= size) return `${(n / size).toFixed(1).replace(/\.0$/, "")}${suffix}`;
  return String(Math.round(n));
}

const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export function fmtUsd(n: number | null): string {
  if (n === null) return "—";
  if (n !== 0 && Math.abs(n) < 0.01) return `$${n.toPrecision(1)}`;
  return usd2.format(n);
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

const pad = (n: number) => String(n).padStart(2, "0");
export const localDay = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export type Range = { from: string | null; to: string | null };
export type RangePreset = "7d" | "30d" | "90d" | "1y" | "all";
const PRESET_DAYS: Record<Exclude<RangePreset, "all">, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "1y": 365,
};

/** "7d" = today and the 6 days before. */
export function presetRange(p: RangePreset, today: Date = new Date()): Range {
  if (p === "all") return { from: null, to: null };
  const from = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - PRESET_DAYS[p] + 1,
  );
  return { from: localDay(from), to: localDay(today) };
}

const dayMs = 86_400_000;
export function rangeDays(r: Range, today: Date = new Date()): number | null {
  if (!r.from) return null;
  const to = r.to ? Date.parse(r.to) : Date.parse(localDay(today));
  return Math.round((to - Date.parse(r.from)) / dayMs) + 1;
}

export function autoBucket(r: Range): Bucket {
  const days = rangeDays(r);
  if (days === null) return "month";
  if (days <= 62) return "day";
  if (days <= 366) return "week";
  return "month";
}

export function sourceLabel(kind: string | null, entrypoint: string | null): string {
  if (!kind) return "—";
  return entrypoint === "claude-desktop" ? `${kind} · desktop` : kind;
}
