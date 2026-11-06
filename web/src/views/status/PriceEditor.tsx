import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { localDay, type Prices } from "@td/shared";
import { useState } from "react";
import { api, HttpError } from "../../api";

// Exact rates: $0.125/MTok must not round to $0.13.
const rate = (n: number) => `$${n}`;

const template = () =>
  JSON.stringify(
    { schema: 1, updated: localDay(new Date()), currency: "USD", models: [], server_tools: [] },
    null,
    2,
  );

export function PriceEditor() {
  const client = useQueryClient();
  const prices = useQuery({
    queryKey: ["prices"],
    queryFn: ({ signal }) => api<Prices>("/prices", undefined, { signal }),
  });
  // null until the first edit: show the file (or a template) without copying it into state.
  const [text, setText] = useState<string | null>(null);
  const loaded = prices.data;
  const value = text ?? loaded?.localText ?? template();
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
          value={value}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="toolbar" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="primary"
            disabled={save.isPending}
            onClick={() => save.mutate(value)}
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
