import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { SessionList } from "@td/shared";
import { useEffect, useState } from "react";
import type { ViewProps } from "../App";
import { api } from "../api";
import { fmtDuration, fmtTokens, fmtUsd, projectLabel, sourceLabel } from "../format";

const PAGE = 50;
const when = (ms: number | null) => (ms === null ? "—" : new Date(ms).toLocaleString());

export function Sessions({ range }: ViewProps) {
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: back to page 1 whenever the filter changes
  useEffect(() => setPage(0), [q, range.from, range.to]);

  const params = { ...range, q: q || undefined, limit: PAGE, offset: page * PAGE };
  const list = useQuery({
    queryKey: ["sessions", params],
    queryFn: () => api<SessionList>("/sessions", params),
    placeholderData: keepPreviousData,
  });
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <section className="card">
      <div className="toolbar">
        <h2 style={{ margin: 0, flex: 1 }}>Sessions</h2>
        <input
          type="search"
          placeholder="Search title, project or id"
          aria-label="Search sessions"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      {list.error && <p className="error">{list.error.message}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Project</th>
              <th>Source</th>
              <th>Model</th>
              <th>Last active</th>
              <th className="num">Duration</th>
              <th className="num">Tokens</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.items.map((s) => {
              const t = s.tokens;
              const open = () => {
                location.hash = `#/sessions/${encodeURIComponent(s.id)}`;
              };
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
                  <td className="num">
                    {s.firstTs !== null && s.lastTs !== null
                      ? fmtDuration(s.lastTs - s.firstTs)
                      : "—"}
                  </td>
                  <td className="num">
                    {fmtTokens(t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h)}
                  </td>
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
      {list.data && total === 0 && <p className="muted empty">No sessions in this period.</p>}
      <div className="toolbar" style={{ marginTop: 12, marginBottom: 0 }}>
        <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>
          Previous
        </button>
        <span className="muted">
          Page {page + 1} of {pages} · {total} sessions
        </span>
        <button type="button" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
          Next
        </button>
      </div>
    </section>
  );
}
