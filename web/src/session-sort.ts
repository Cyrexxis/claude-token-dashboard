import { type SessionRow, totalTokens } from "@td/shared";
import { fmtPercent, sourceLabel } from "./format";

export type ColId =
  | "title"
  | "project"
  | "source"
  | "model"
  | "lastActive"
  | "duration"
  | "tokens"
  | "cost"
  | "fiveHour"
  | "weekly"
  | "estimate";
export type Col = {
  id: ColId;
  label: string;
  /** "text" sorts A→Z first; "num" is right-aligned; null is a date (newest first, left-aligned). */
  align: "num" | "text" | null;
  key: (s: SessionRow) => string | number;
  /** Cell text, when it differs from the sort key. */
  show?: (s: SessionRow) => string;
};

export const duration = (s: SessionRow) =>
  s.firstTs !== null && s.lastTs !== null ? s.lastTs - s.firstTs : null;

export const COLS: Col[] = [
  { id: "title", label: "Title", align: "text", key: (s) => s.title ?? s.id },
  { id: "project", label: "Project", align: "text", key: (s) => s.projectLabel ?? "—" },
  {
    id: "source",
    label: "Source",
    align: "text",
    key: (s) => sourceLabel(s.sourceKind, s.entrypoint),
  },
  { id: "model", label: "Model", align: "text", key: (s) => s.model ?? "" },
  { id: "lastActive", label: "Last active", align: null, key: (s) => s.lastTs ?? 0 },
  { id: "duration", label: "Duration", align: "num", key: (s) => duration(s) ?? -1 },
  { id: "tokens", label: "Tokens", align: "num", key: (s) => totalTokens(s.tokens) },
  { id: "cost", label: "Cost", align: "num", key: (s) => s.costUsd },
];

const pct = (id: ColId, label: string, of: (s: SessionRow) => number | null | undefined): Col => ({
  id,
  label,
  align: "num",
  key: (s) => of(s) ?? -1,
  show: (s) => fmtPercent(of(s)),
});

/** Whole-session 5-hour and weekly estimates; or, with a window's USD per 1 %, its part of each session. */
export const percentCols = (usdPerPercent?: number | null): Col[] =>
  usdPerPercent === undefined
    ? [
        pct("fiveHour", "5h %", (s) => s.planPercent?.five_hour),
        pct("weekly", "Week %", (s) => s.planPercent?.seven_day),
      ]
    : [pct("estimate", "Est. %", (s) => (usdPerPercent ? s.costUsd / usdPerPercent : null))];

export function sortSessions(
  items: SessionRow[],
  col: ColId,
  desc: boolean,
  cols: Col[] = COLS,
): SessionRow[] {
  const key = cols.find((c) => c.id === col)?.key;
  if (!key) return items;
  return [...items].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const c = typeof x === "string" ? x.localeCompare(String(y)) : x - Number(y);
    return desc ? -c : c;
  });
}
