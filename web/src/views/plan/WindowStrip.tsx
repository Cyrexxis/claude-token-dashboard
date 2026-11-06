import type { PlanWindow } from "@td/shared";
import { type WindowPage, windowTicks } from "../../plan-math";
import { type Kind, pct, useNow, when } from "./util";

const DAY = 86_400_000;

/** Strip marks: days for a week of 5-hour windows, months for a quarter of weekly ones. Labels sit mid-span. */
function stripMarks(kind: Kind, from: number, to: number) {
  if (kind === "five_hour") {
    // The midnight before `from` brings in the first day's label.
    const noons = windowTicks("seven_day", from - DAY, to).map((t) => t + DAY / 2);
    return {
      ticks: windowTicks("seven_day", from, to),
      labels: noons.map((t) => ({
        at: t,
        text: new Date(t).toLocaleDateString(undefined, { weekday: "short", day: "numeric" }),
      })),
    };
  }
  const months = [0, 1, 2].map((i) => {
    const d = new Date(from);
    return new Date(d.getFullYear(), d.getMonth() + i, 1).getTime();
  });
  return {
    ticks: months.slice(1),
    labels: months.map((t) => ({
      at: t + 15 * DAY,
      text: new Date(t).toLocaleDateString(undefined, { month: "short" }),
    })),
  };
}

/**
 * The page as a lane: one bar per window over its whole span, filled where it had activity (whole
 * days for a weekly window, so skipped days stay empty), the fill stronger the higher the window's peak.
 */
export function WindowStrip({
  kind,
  page,
  isPicked,
  onPick,
  hovered,
  onHover,
}: {
  kind: Kind;
  page: WindowPage;
  isPicked: (w: PlanWindow) => boolean;
  onPick: (w: PlanWindow) => void;
  hovered: number | null;
  onHover: (resetsAt: number | null) => void;
}) {
  const now = useNow();
  const { fromMs, toMs } = page;
  const clamp = (ms: number) => Math.min(Math.max(ms, fromMs), toMs);
  const at = (ms: number) => ((clamp(ms) - fromMs) / (toMs - fromMs)) * 100;
  const { ticks, labels } = stripMarks(kind, fromMs, toMs);
  return (
    <div className="window-strip">
      <div className="lane" />
      {ticks.map((t) => (
        <span key={t} className="tick" style={{ left: `${at(t)}%` }} />
      ))}
      {labels
        .filter((l) => l.at > fromMs && l.at < toMs)
        .map((l) => (
          <span key={l.at} className="day" style={{ left: `${at(l.at)}%` }}>
            {l.text}
          </span>
        ))}
      {page.windows.map((w) => {
        const start = w.startMs ?? 0;
        const len = w.resetsAt - start;
        const label = `${when(start)} → ${when(w.resetsAt)} · peak ${pct(w.peakPercent)}`;
        // 0 % is a light tint, 100 % the full accent.
        const fill = `color-mix(in srgb, var(--accent) ${25 + Math.min(w.peakPercent, 100) * 0.75}%, transparent)`;
        return (
          <button
            key={w.resetsAt}
            type="button"
            className={w.resetsAt === hovered ? "window-bar hover" : "window-bar"}
            style={{ left: `${at(start)}%`, width: `${at(w.resetsAt) - at(start)}%` }}
            aria-pressed={isPicked(w)}
            aria-label={label}
            title={label}
            onClick={() => onPick(w)}
            onMouseEnter={() => onHover(w.resetsAt)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(w.resetsAt)}
            onBlur={() => onHover(null)}
          >
            {w.activity.map(([a, b]) => (
              <span
                key={a}
                className="fill"
                style={{
                  left: `${((a - start) / len) * 100}%`,
                  width: `${((b - a) / len) * 100}%`,
                  background: fill,
                }}
              />
            ))}
          </button>
        );
      })}
      {page.current && now > fromMs && now < toMs && (
        <span className="now" style={{ left: `${at(now)}%` }} />
      )}
    </div>
  );
}
