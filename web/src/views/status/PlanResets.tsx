import { useSettings } from "./settings";

export function PlanResets() {
  const { s, set, error } = useSettings();
  return (
    <section className="card">
      <h2>Plan resets</h2>
      <p className="muted">
        When plan % falls to this value or below, the Plan page starts a new window: the limit was
        reset. A smaller fall is a rescale after a plan change and stays in the same window.
      </p>
      {error && <p className="error">{error.message}</p>}
      <label>
        New window when plan % falls to{" "}
        <input
          // Remounts with the saved value, so an invalid entry snaps back.
          key={s?.resetPercent}
          type="number"
          min={0}
          max={100}
          step={1}
          defaultValue={s?.resetPercent}
          disabled={!s}
          style={{ width: "5em" }}
          onBlur={(e) => {
            const v = e.target.valueAsNumber;
            if (s && v >= 0 && v <= 100 && v !== s.resetPercent) set({ resetPercent: v });
            else if (s) e.target.value = String(s.resetPercent);
          }}
        />{" "}
        % or below
      </label>
    </section>
  );
}
