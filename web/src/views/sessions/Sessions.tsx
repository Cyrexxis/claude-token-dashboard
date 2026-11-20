import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { SessionList } from "@td/shared";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { SessionTable } from "../../components/SessionTable";
import { forFilter } from "../../paging";
import type { ViewProps } from "../../types";
import { SessionDetail } from "./SessionDetail";

const PAGE = 50;

/** `id` (from the URL) pins a session; without it the most recently active one is shown and followed. */
export function Sessions({ range, id }: ViewProps & { id?: string }) {
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);
  // The page belongs to one filter: a new filter reads page 0 in the same render, so no stale-offset request.
  const filterKey = `${q}|${range.from}|${range.to}`;
  const [stored, setPaged] = useState({ key: filterKey, page: 0 });
  const paged = forFilter(stored, filterKey);
  // Store the reset during render, so going back to an earlier filter also starts at page 0.
  if (paged !== stored) setPaged(paged);
  const page = paged.page;
  const setPage = (p: number) => setPaged({ key: filterKey, page: p });

  const params = { ...range, q: q || undefined, limit: PAGE, offset: page * PAGE };
  const list = useQuery({
    queryKey: ["sessions", params],
    queryFn: ({ signal }) => api<SessionList>("/sessions", params, { signal }),
    placeholderData: keepPreviousData,
  });
  // All time, not the period: the active session is shown even if the list filters it out.
  const latest = useQuery({
    queryKey: ["sessions", { limit: 1 }],
    queryFn: ({ signal }) => api<SessionList>("/sessions", { limit: 1 }, { signal }),
  });
  const shown = id ?? latest.data?.items[0]?.id;
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <>
      {id && (
        <div className="card toolbar">
          <span style={{ flex: 1 }}>Showing a picked session.</span>
          <button
            type="button"
            className="primary"
            onClick={() => {
              location.hash = "#/sessions";
            }}
          >
            Back to active session
          </button>
        </div>
      )}
      {shown && <SessionDetail id={shown} />}
      {latest.data && !shown && <p className="muted empty">No sessions yet.</p>}
      <section className="card">
        <div className="toolbar">
          <h2 className="card-title">Sessions</h2>
          <input
            type="search"
            placeholder="Search title, project or id"
            aria-label="Search sessions"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        {list.error && <p className="error">{list.error.message}</p>}
        <SessionTable items={list.data?.items ?? []} selected={shown} />
        <p className="muted note">
          5h % and Week % estimate the plan use of each whole session: each part at the $ per 1 % of
          the window it ran in. claude.ai chat also moves plan %, so they are rough figures.
        </p>
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
    </>
  );
}
