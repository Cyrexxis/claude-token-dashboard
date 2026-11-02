import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Prices, SourceRow, Status as StatusData } from "@td/shared";
import { useEffect, useState } from "react";
import { api, HttpError } from "../api";
import { localDay } from "../format";

// Exact rates: $0.125/MTok must not round to $0.13.
const rate = (n: number) => `$${n}`;
const when = (ms: number | null) => (ms === null ? "never" : new Date(ms).toLocaleString());
const template = () =>
  JSON.stringify(
    { schema: 1, updated: localDay(new Date()), currency: "USD", models: [], server_tools: [] },
    null,
    2,
  );

function Info({ status }: { status: StatusData }) {
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

function Sources({ status }: { status: StatusData }) {
  const sources = useQuery({ queryKey: ["sources"], queryFn: () => api<SourceRow[]>("/sources") });
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

function PriceEditor() {
  const client = useQueryClient();
  const prices = useQuery({ queryKey: ["prices"], queryFn: () => api<Prices>("/prices") });
  const [text, setText] = useState<string | null>(null);
  const loaded = prices.data;
  useEffect(() => {
    if (loaded && text === null) setText(loaded.localText ?? template());
  }, [loaded, text]);
  const save = useMutation({
    mutationFn: (body: string) =>
      api<{ ok: true; repriced: number }>("/prices/local", undefined, {
        method: "PUT",
        body,
        headers: { "content-type": "application/json" },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["prices"] }),
  });
  const errors =
    save.error instanceof HttpError ? (save.error.body?.errors ?? [save.error.message]) : [];
  if (!loaded) return null;
  return (
    <>
      <section className="card">
        <h2>Local prices</h2>
        <p className="muted">
          Overrides or adds models in <span className="mono">{loaded.localPath}</span>. A model with
          the same id replaces the shipped entry. Shipped prices: {loaded.updated}.
        </p>
        {loaded.localError && (
          <p className="error">File on disk is invalid and ignored: {loaded.localError}</p>
        )}
        <textarea
          aria-label="prices.local.json"
          spellCheck={false}
          value={text ?? ""}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="toolbar" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="primary"
            disabled={save.isPending}
            onClick={() => save.mutate(text ?? "")}
          >
            Save
          </button>
          {save.isSuccess && (
            <span className="muted">Saved · repriced {save.data.repriced} requests</span>
          )}
        </div>
        {errors.length > 0 && (
          <ul className="error">
            {[...new Set(errors)].map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
      </section>
      <section className="card">
        <h2>Price periods in use</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th>From</th>
                <th>To</th>
                <th>Origin</th>
                <th className="num">Input</th>
                <th className="num">Output</th>
                <th className="num">Cache read</th>
                <th className="num">Write 5m</th>
                <th className="num">Write 1h</th>
              </tr>
            </thead>
            <tbody>
              {loaded.periods.map((p) => (
                <tr key={p.id}>
                  <td>{p.modelId}</td>
                  <td>{p.effectiveFrom ?? "release"}</td>
                  <td>{p.effectiveTo ?? "—"}</td>
                  <td>{p.origin}</td>
                  <td className="num">{rate(p.perMtok.input)}</td>
                  <td className="num">{rate(p.perMtok.output)}</td>
                  <td className="num">{rate(p.perMtok.cache_read)}</td>
                  <td className="num">{rate(p.perMtok.cache_write_5m)}</td>
                  <td className="num">{rate(p.perMtok.cache_write_1h)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted">Rates in USD per million tokens.</p>
      </section>
    </>
  );
}

export function Status() {
  const status = useQuery({ queryKey: ["status"], queryFn: () => api<StatusData>("/status") });
  if (status.error) return <p className="error">{status.error.message}</p>;
  if (!status.data) return <p className="muted">Loading…</p>;
  return (
    <>
      <Info status={status.data} />
      <Sources status={status.data} />
      <PriceEditor />
    </>
  );
}
