import type { PlanWindow } from "@td/shared";
import { fmtDuration, fmtTokens, fmtUsd } from "../../format";
import { dayTime, hourTick, kindLabel, otherPct, pct, useNow } from "./util";

export function WindowCard({ w }: { w: PlanWindow }) {
  const now = useNow();
  return (
    <div className="tile">
      <div className="label">{kindLabel(w.kind)} window</div>
      <div className="value">{pct(w.percent)}</div>
      <div className="bar" role="presentation">
        <span style={{ width: `${Math.min(w.percent, 100)}%` }} />
      </div>
      <div className="sub">
        resets in {fmtDuration(Math.max(w.resetsAt - now, 0))} ·{" "}
        {w.kind === "seven_day" ? dayTime(w.resetsAt) : hourTick(w.resetsAt)}
      </div>
      {w.usdPerPercent !== null && w.tokensPerPercent !== null && (
        <div className="sub">
          {fmtUsd(w.usdPerPercent)} · {fmtTokens(w.tokensPerPercent)} tokens per 1 % (Claude Code
          only)
        </div>
      )}
      {otherPct(w) !== null && (
        <div className="sub">Other products: {otherPct(w) === "—" ? "none seen" : otherPct(w)}</div>
      )}
    </div>
  );
}
