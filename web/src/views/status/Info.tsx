import type { Status as StatusData } from "@td/shared";
import { when } from "./util";

export function Info({ status }: { status: StatusData }) {
  const i = status.ingest;
  const rows: [string, string][] = [
    ["Server version", status.version],
    ["Protocol", String(status.protocol)],
    ["Schema version", String(status.schemaVersion)],
    ["Started", when(status.startedAt)],
    ["Database", status.dbPath],
    ["Requests stored", status.requests.toLocaleString()],
    [
      "Ingest",
      i.running
        ? "running…"
        : `idle · last run ${when(i.lastRunAt)} · ${i.lastFiles} files · ${i.lastErrors} errors`,
    ],
    ["Prices hash", status.pricesHash?.slice(0, 12) ?? "—"],
    ["Unpriced models", status.unpricedModels.join(", ") || "none"],
  ];
  return (
    <section className="card">
      <h2>Server</h2>
      <table>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th style={{ width: 180 }}>{k}</th>
              <td style={{ whiteSpace: "normal" }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
