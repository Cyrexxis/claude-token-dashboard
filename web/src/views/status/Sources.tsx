import { useMutation, useQuery } from "@tanstack/react-query";
import type { SourceRow, Status as StatusData } from "@td/shared";
import { useState } from "react";
import { api } from "../../api";
import { when } from "./util";

export function Sources({ status }: { status: StatusData }) {
  const sources = useQuery({
    queryKey: ["sources"],
    queryFn: ({ signal }) => api<SourceRow[]>("/sources", undefined, { signal }),
  });
  const [clickedAt, setClickedAt] = useState<number | null>(null);
  // Disabled until an ingest run finishes after the click (status refreshes on ingest.status events).
  const busy =
    status.ingest.running || (clickedAt !== null && (status.ingest.lastRunAt ?? 0) < clickedAt);
  const rescan = useMutation({
    mutationFn: (id: number) => api(`/sources/${id}/rescan`, undefined, { method: "POST" }),
    onError: () => setClickedAt(null), // no run will follow a failed POST
  });
  return (
    <section className="card">
      <h2>Sources</h2>
      {rescan.error && <p className="error">{rescan.error.message}</p>}
      {sources.error && <p className="error">{sources.error.message}</p>}
      {!sources.data && !sources.error && <p className="muted">Loading…</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Kind</th>
              <th>Host</th>
              <th>Root</th>
              <th>Last scan</th>
              <th className="num">Files</th>
              <th className="num">With errors</th>
              <th>Last error</th>
              <th className="num">Requests</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sources.data?.map((s) => (
              <tr key={s.id}>
                <td>{s.kind}</td>
                <td>{[s.host, s.distro].filter(Boolean).join(" · ") || "—"}</td>
                <td className="mono">{s.rootPath}</td>
                <td>{when(s.lastScanAt)}</td>
                <td className="num">{s.files}</td>
                <td className="num">{s.filesWithErrors}</td>
                <td className={s.lastError ? "error" : "muted"}>{s.lastError ?? "—"}</td>
                <td className="num">{s.requests.toLocaleString()}</td>
                <td>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setClickedAt(Date.now());
                      rescan.mutate(s.id);
                    }}
                  >
                    Rescan
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
