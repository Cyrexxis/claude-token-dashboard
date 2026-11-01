import type { SessionRow, Tokens } from "@td/shared";
import { useState } from "react";
import { fmtDuration, fmtTokens, fmtUsd, projectLabel, sourceLabel } from "../format";

const when = (ms: number | null) => (ms === null ? "—" : new Date(ms).toLocaleString());
const total = (t: Tokens) => t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
const duration = (s: SessionRow) =>
  s.firstTs !== null && s.lastTs !== null ? s.lastTs - s.firstTs : null;

type Col = {
  label: string;
  num?: boolean;
  text?: boolean;
  key: (s: SessionRow) => string | number;
};
const COLS: Col[] = [
  { label: "Title", text: true, key: (s) => s.title ?? s.id },
  { label: "Project", text: true, key: (s) => projectLabel(s.project, s.cwd) },
  { label: "Source", text: true, key: (s) => sourceLabel(s.sourceKind, s.entrypoint) },
  { label: "Model", text: true, key: (s) => s.model ?? "" },
  { label: "Last active", key: (s) => s.lastTs ?? 0 },
  { label: "Duration", num: true, key: (s) => duration(s) ?? -1 },
  { label: "Tokens", num: true, key: (s) => total(s.tokens) },
  { label: "Cost", num: true, key: (s) => s.costUsd },
];
const LAST_ACTIVE = 4;

export function sortSessions(items: SessionRow[], col: number, desc: boolean): SessionRow[] {
  const key = COLS[col].key;
  return [...items].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const c = typeof x === "string" ? x.localeCompare(String(y)) : x - Number(y);
    return desc ? -c : c;
  });
}

/** `sortable` sorts client-side, so only use it when `items` is the whole list (not one page). */
export function SessionTable({ items, sortable }: { items: SessionRow[]; sortable?: boolean }) {
  const [sort, setSort] = useState({ col: LAST_ACTIVE, desc: true });
  const rows = sortable ? sortSessions(items, sort.col, sort.desc) : items;
  // Text columns start A→Z, numbers and dates start largest/newest first.
  const pick = (col: number) =>
    setSort(col === sort.col ? { col, desc: !sort.desc } : { col, desc: !COLS[col].text });
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {COLS.map((c, i) => (
              <th
                key={c.label}
                className={c.num ? "num" : undefined}
                aria-sort={
                  sortable && i === sort.col ? (sort.desc ? "descending" : "ascending") : undefined
                }
              >
                {sortable ? (
                  <button type="button" className="th-sort" onClick={() => pick(i)}>
                    {c.label}
                    {i === sort.col && (sort.desc ? " ▼" : " ▲")}
                  </button>
                ) : (
                  c.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const open = () => {
              location.hash = `#/sessions/${encodeURIComponent(s.id)}`;
            };
            const d = duration(s);
            return (
              <tr key={s.id} className="link" onClick={open}>
                <td>
                  <a href={`#/sessions/${encodeURIComponent(s.id)}`}>
                    {s.title ?? s.id.slice(0, 8)}
                  </a>
                </td>
                <td>{projectLabel(s.project, s.cwd)}</td>
                <td>{sourceLabel(s.sourceKind, s.entrypoint)}</td>
                <td>{s.model ?? "—"}</td>
                <td>{when(s.lastTs)}</td>
                <td className="num">{d === null ? "—" : fmtDuration(d)}</td>
                <td className="num">{fmtTokens(total(s.tokens))}</td>
                <td className="num">
                  {fmtUsd(s.costUsd)}
                  {s.unpricedRequests > 0 && (
                    <span title={`${s.unpricedRequests} unpriced requests`}> + unpriced</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
