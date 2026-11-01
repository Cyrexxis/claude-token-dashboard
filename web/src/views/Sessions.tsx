import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { SessionList } from "@td/shared";
import { useEffect, useState } from "react";
import type { ViewProps } from "../App";
import { api } from "../api";
import { SessionTable } from "../components/SessionTable";

const PAGE = 50;

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
      <SessionTable items={list.data?.items ?? []} />
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
