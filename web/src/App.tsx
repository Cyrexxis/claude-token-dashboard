import { useQuery } from "@tanstack/react-query";
import type { Status as StatusData } from "@td/shared";
import { type ReactNode, useState } from "react";
import { api, NetworkError, useLiveEvents } from "./api";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { presetRange, type Range, type RangePreset } from "./format";
import { type Route, useRoute, type View } from "./route";
import { Overview } from "./views/Overview";
import { Plan } from "./views/Plan";
import { Sessions } from "./views/Sessions";
import { Status } from "./views/Status";

const NAV: [View, string][] = [
  ["overview", "Overview"],
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

function viewFor(route: Route, range: Range): ReactNode {
  switch (route.view) {
    case "overview":
      return <Overview range={range} />;
    case "plan":
      return <Plan range={range} />;
    case "sessions":
      return <Sessions range={range} id={route.id} />;
    case "status":
      return <Status />;
  }
}

export function App() {
  useLiveEvents();
  const route = useRoute();
  const [preset, setPreset] = useState<RangePreset>("30d");
  const range = presetRange(preset);
  const status = useQuery({
    queryKey: ["status"],
    queryFn: ({ signal }) => api<StatusData>("/status", undefined, { signal }),
  });

  // No response at all means the server is not running; a bad response is shown by the views.
  if (status.error instanceof NetworkError)
    return (
      <main className="page center">
        <h1>Server not reachable</h1>
        <p>Is "bun run serve" running?</p>
      </main>
    );

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
      <main>
        <ErrorBoundary key={route.view}>{viewFor(route, range)}</ErrorBoundary>
      </main>
    </div>
  );
}
