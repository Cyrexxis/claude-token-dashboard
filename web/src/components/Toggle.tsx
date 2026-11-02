import { GROUP_LABEL, type Group } from "@td/shared";

export type ChartMetric = "tokens" | "cost";

/** Tokens/cost switch: pressed buttons, not tabs (there are no tab panels). */
export function MetricToggle({
  value,
  onChange,
}: {
  value: ChartMetric;
  onChange: (v: ChartMetric) => void;
}) {
  return (
    <div className="tabs">
      {(["tokens", "cost"] as const).map((m) => (
        <button key={m} type="button" aria-pressed={m === value} onClick={() => onChange(m)}>
          {m === "tokens" ? "Tokens" : "Cost"}
        </button>
      ))}
    </div>
  );
}

export function GroupSelect<G extends Group>({
  value,
  groups,
  onChange,
}: {
  value: G;
  groups: readonly G[];
  onChange: (g: G) => void;
}) {
  return (
    <label>
      Group by{" "}
      <select value={value} onChange={(e) => onChange(e.target.value as G)}>
        {groups.map((g) => (
          <option key={g} value={g}>
            {GROUP_LABEL[g]}
          </option>
        ))}
      </select>
    </label>
  );
}
