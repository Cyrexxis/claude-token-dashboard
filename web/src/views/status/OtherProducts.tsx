import { useSettings } from "./settings";

export function OtherProducts() {
  const { s, set, error } = useSettings();
  return (
    <section className="card">
      <h2>Other products</h2>
      <p className="muted">
        Shows on the Plan page how much plan % rose while Claude Code on this machine was not
        working: claude.ai chat, Cowork, or Claude Code elsewhere (another computer, the web). It is
        a lower bound: use at the same time as Claude Code can't be told apart, and readings are
        whole percents, so each rise can be off by 1 %.
      </p>
      {error && <p className="error">{error.message}</p>}
      <label className="check">
        <input
          type="checkbox"
          checked={s?.otherProducts ?? false}
          disabled={!s}
          onChange={(e) => set({ otherProducts: e.target.checked })}
        />{" "}
        Show use from other products
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={s?.otherEstimate ?? false}
          disabled={!s?.otherProducts}
          onChange={(e) => set({ otherEstimate: e.target.checked })}
        />{" "}
        Also estimate use while Claude Code was paused (less reliable): a rise after a pause of 15
        minutes or more, minus Claude Code's own share at the window's $ per 1 %, from 2 % on
      </label>
    </section>
  );
}
