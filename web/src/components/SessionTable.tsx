import { type SessionRow, totalTokens } from "@td/shared";
import { useState } from "react";
import { fmtDuration, fmtTokens, fmtUsd, projectLabel, sourceLabel } from "../format";
import { COLS, type ColId, duration, sortSessions } from "../session-sort";

const when = (ms: number | null) => (ms === null ? "—" : new Date(ms).toLocaleString());

/** `sortable` sorts client-side, so only use it when `items` is the whole list (not one page). */
export function SessionTable({
  items,
  sortable,
  selected,
}: {
  items: SessionRow[];
  sortable?: boolean;
  selected?: string;
}) {
  const [sort, setSort] = useState<{ col: ColId; desc: boolean }>({
    col: "lastActive",
    desc: true,
  });
  const rows = sortable ? sortSessions(items, sort.col, sort.desc) : items;
  // Text columns start A→Z, numbers and dates start largest/newest first.
  const pick = (c: (typeof COLS)[number]) =>
    setSort(
      c.id === sort.col ? { col: c.id, desc: !sort.desc } : { col: c.id, desc: c.align !== "text" },
    );
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {COLS.map((c) => (
              <th
                key={c.label}
                className={c.align === "num" ? "num" : undefined}
                aria-sort={
                  sortable && c.id === sort.col
                    ? sort.desc
                      ? "descending"
                      : "ascending"
                    : undefined
                }
              >
                {sortable ? (
                  <button type="button" className="th-sort" onClick={() => pick(c)}>
                    {c.label}
                    {c.id === sort.col && (sort.desc ? " ▼" : " ▲")}
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
              <tr
                key={s.id}
                className={s.id === selected ? "link selected" : "link"}
                // Mouse convenience; a click on the link itself navigates on its own.
                onClick={(e) => (e.target as Element).closest("a") || open()}
              >
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
                <td className="num">{fmtTokens(totalTokens(s.tokens))}</td>
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
