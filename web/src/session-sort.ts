import { type SessionRow, totalTokens } from "@td/shared";
import { sourceLabel } from "./format";

export type ColId =
  | "title"
  | "project"
  | "source"
  | "model"
  | "lastActive"
  | "duration"
  | "tokens"
  | "cost";
export type Col = {
  id: ColId;
  label: string;
  /** "text" sorts A→Z first; "num" is right-aligned; null is a date (newest first, left-aligned). */
  align: "num" | "text" | null;
  key: (s: SessionRow) => string | number;
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

export function sortSessions(items: SessionRow[], col: ColId, desc: boolean): SessionRow[] {
  const key = COLS.find((c) => c.id === col)?.key;
  if (!key) return items;
  return [...items].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const c = typeof x === "string" ? x.localeCompare(String(y)) : x - Number(y);
    return desc ? -c : c;
  });
}
