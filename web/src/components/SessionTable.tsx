import type { SessionRow } from "@td/shared";
import { fmtDuration, fmtTokens, fmtUsd, projectLabel, sourceLabel } from "../format";

const when = (ms: number | null) => (ms === null ? "—" : new Date(ms).toLocaleString());

export function SessionTable({ items }: { items: SessionRow[] }) {
  return (
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
          {items.map((s) => {
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
  );
}
