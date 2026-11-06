import { useQuery } from "@tanstack/react-query";
import type { PlanWindow, PlanWindows } from "@td/shared";
import { useState } from "react";
import { api } from "../../api";
import { ChartCard } from "../../components/ChartCard";
import { findWindow, flipWindow, overlappingWeekly, type WindowId } from "../../plan-math";
import { Timeline } from "./Timeline";
import { type Kind, kindLabel, when } from "./util";
import { WindowCard } from "./WindowCard";
import { WindowSeries } from "./WindowSeries";
import { WindowSessions } from "./WindowSessions";
import { WindowsCard } from "./WindowsCard";

// The Windows card pages through all of history, so the header's period doesn't apply here.
const ALL_TIME = { from: null, to: null };

function usePlanWindows() {
  return useQuery({
    queryKey: ["plan", "windows", ALL_TIME],
    queryFn: ({ signal }) => api<PlanWindows>("/plan/windows", ALL_TIME, { signal }),
  });
}

export function Plan({ kind }: { kind: Kind }) {
  const windows = usePlanWindows();
  // The pick is an identity: the shown window always comes from the latest fetch.
  const [pickedId, setPickedId] = useState<WindowId | null>(null);
  // The kind the pick belongs to, and the 5-hour window shown last, to follow a header flip.
  const [shownKind, setShownKind] = useState(kind);
  const [last5h, setLast5h] = useState<WindowId | null>(null);
  if (windows.error) return <p className="error">{windows.error.message}</p>;
  if (!windows.data) return <p className="muted">Loading…</p>;
  const { current, past } = windows.data;
  const all = [...current, ...past];
  const picked = findWindow(past, pickedId);
  if (!current.length && !past.length)
    return (
      <p className="muted empty">
        No plan readings yet. Start a Claude Code session in WSL with the mod loaded (
        <code>claude --plugin-dir ./plugin</code>).
      </p>
    );
  const win = (k: Kind) => current.find((w) => w.kind === k && w.startMs !== null);
  if (shownKind !== kind) {
    // The header flipped 5-hour/weekly: move to the matching window rather than drop the pick.
    const from = picked ?? win(shownKind);
    if (from?.kind === "five_hour") setLast5h({ kind: from.kind, resetsAt: from.resetsAt });
    setPickedId(flipWindow(from, all, last5h));
    setShownKind(kind);
  }
  const chartWin = picked ?? win(kind);
  // A picked window brings its own readings; a 5-hour one also shows the weekly window it overlaps.
  const chartCurrent = picked ? [picked, ...overlappingWeekly(picked, all).slice(0, 1)] : current;
  // The current row stands for "no pick": choosing it goes back to the current view.
  const isPicked = (w: PlanWindow) =>
    w.current ? picked === null : picked?.kind === w.kind && picked.resetsAt === w.resetsAt;
  const pick = (w: PlanWindow) =>
    setPickedId(w.current ? null : { kind: w.kind, resetsAt: w.resetsAt });
  const none = (k: Kind) => <p className="muted empty">No current {kindLabel(k)} window.</p>;
  return (
    <>
      {current.length > 0 && (
        <div className="tiles">
          {current.map((w) => (
            <WindowCard key={`${w.kind}-${w.resetsAt}`} w={w} />
          ))}
        </div>
      )}
      {picked && (
        <div className="card toolbar">
          <span style={{ flex: 1 }}>
            Charts and sessions show the past {kindLabel(picked.kind)} window{" "}
            {when(picked.startMs ?? 0)} → {when(picked.resetsAt)}.
          </span>
          <button type="button" className="primary" onClick={() => setPickedId(null)}>
            Back to current window
          </button>
        </div>
      )}
      <ChartCard
        id="plan-usage"
        title={`Plan usage in the ${picked ? "selected" : "current"} window`}
      >
        {chartWin ? <Timeline w={chartWin} current={chartCurrent} /> : none(kind)}
      </ChartCard>
      <WindowSeries current={current} picked={picked} kind={kind} />
      {/* Keyed by kind so a flip opens on the page holding the shown window. */}
      <WindowsCard key={kind} kind={kind} all={all} isPicked={isPicked} onPick={pick} />
      <section className="card">
        <h2>Sessions in the {picked ? "selected" : "current"} window</h2>
        {chartWin ? <WindowSessions w={chartWin} /> : none(kind)}
      </section>
    </>
  );
}
