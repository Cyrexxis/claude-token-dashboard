import { useQuery } from "@tanstack/react-query";
import type { Status as StatusData } from "@td/shared";
import { type ReactNode, useState } from "react";
import { api, HttpError, useLiveEvents } from "./api";
import { presetRange, type Range, type RangePreset } from "./format";
import { useRoute, type View } from "./route";
import { Cost } from "./views/Cost";
import { Overview } from "./views/Overview";
import { Plan } from "./views/Plan";
import { SessionDetail } from "./views/SessionDetail";
import { Sessions } from "./views/Sessions";
import { Status } from "./views/Status";
import { Tokens } from "./views/Tokens";

export type ViewProps = { range: Range };

const NAV: [View, string][] = [
  ["overview", "Overview"],
  ["tokens", "Tokens"],
  ["cost", "Cost"],
  ["plan", "Plan"],
  ["sessions", "Sessions"],
  ["status", "Status"],
];
const PRESETS: [RangePreset, string][] = [
  ["7d", "7 days"],
  ["30d", "30 days"],
  ["90d", "90 days"],
  ["1y", "1 year"],
  ["all", "All time"],
];

export function App() {
  useLiveEvents();
  const route = useRoute();
  const [preset, setPreset] = useState<RangePreset>("30d");
  const range = presetRange(preset);
  const status = useQuery({ queryKey: ["status"], queryFn: () => api<StatusData>("/status") });

  // A network error (not an HTTP error) means the server is not running.
  if (status.error && !(status.error instanceof HttpError))
    return (
      <main className="page center">
        <h1>Server not reachable</h1>
        <p>Is "bun run serve" running?</p>
      </main>
    );

  const views: Record<View, ReactNode> = {
    overview: <Overview range={range} />,
    tokens: <Tokens range={range} />,
    cost: <Cost range={range} />,
    plan: <Plan range={range} />,
    sessions: route.id ? <SessionDetail id={route.id} /> : <Sessions range={range} />,
    status: <Status />,
  };
  const unpriced = status.data?.unpricedModels ?? [];

  return (
    <div className="page">
      <header className="top">
        <strong className="brand">Token Dashboard</strong>
        <nav>
          {NAV.map(([view, label]) => (
            <a
              key={view}
              href={`#/${view}`}
              aria-current={route.view === view ? "page" : undefined}
            >
              {label}
            </a>
          ))}
        </nav>
        <label className="range">
          <span className="sr-only">Period</span>
          <select value={preset} onChange={(e) => setPreset(e.target.value as RangePreset)}>
            {PRESETS.map(([p, label]) => (
              <option key={p} value={p}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </header>
      {unpriced.length > 0 && (
        <div className="banner" role="status">
          Unpriced models: {unpriced.join(", ")} — add a local price on the{" "}
          <a href="#/status">Status</a> page
        </div>
      )}
      <main>{views[route.view]}</main>
    </div>
  );
}
