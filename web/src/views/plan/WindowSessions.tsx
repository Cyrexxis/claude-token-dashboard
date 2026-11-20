import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { PlanWindow, SessionList } from "@td/shared";
import { api } from "../../api";
import { SessionTable } from "../../components/SessionTable";

export function WindowSessions({ w }: { w: PlanWindow }) {
  const params = { fromMs: w.startMs ?? 0, toMs: w.resetsAt };
  const list = useQuery({
    queryKey: ["plan", "sessions", params],
    queryFn: ({ signal }) => api<SessionList>("/plan/sessions", params, { signal }),
    placeholderData: keepPreviousData,
  });
  if (list.error) return <p className="error">{list.error.message}</p>;
  if (!list.data) return <p className="muted">Loading…</p>;
  if (!list.data.items.length) return <p className="muted empty">No sessions in this window.</p>;
  return (
    <>
      <SessionTable items={list.data.items} sortable usdPerPercent={w.usdPerPercent ?? null} />
      <p className="muted note">
        Tokens and cost count only requests inside the window; duration is the whole session. Est. %
        is that cost at this window's $ per 1 %; claude.ai chat also moves plan %, so it is a rough
        figure.
      </p>
    </>
  );
}
