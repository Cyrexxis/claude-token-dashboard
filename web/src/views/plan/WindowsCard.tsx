import type { PlanWindow } from "@td/shared";
import { useState } from "react";
import { fmtTokens, fmtUsd } from "../../format";
import { fiveHourByWeek, weeklyByQuarter } from "../../plan-math";
import { type Kind, kindLabel, pct, when } from "./util";
import { WindowStrip } from "./WindowStrip";

const CHAT_NOTE =
  "Plan % also counts claude.ai chat and Cowork, so this reads low on days you also chat.";

const perPct = (v: number | null, f: (n: number) => string) => (v === null ? "—" : f(v));

/** Windows of one kind, a page at a time; the table and the strip share a hover highlight. */
export function WindowsCard({
  kind,
  all,
  isPicked,
  onPick,
}: {
  kind: Kind;
  all: PlanWindow[];
  isPicked: (w: PlanWindow) => boolean;
  onPick: (w: PlanWindow) => void;
}) {
  // Page by its fromMs; null (or a page of the other tab) = the current page.
  const [pageId, setPageId] = useState<number | null>(null);
  // The window under the pointer, by resetsAt; local so hovering doesn't re-render the charts.
  const [hovered, setHovered] = useState<number | null>(null);
  const listed = all.filter((w) => w.kind === kind && w.startMs !== null);
  // 5-hour windows page by week, weekly windows by quarter; newest first, opening on the page
  // holding the shown window (the current row stands for "no pick"), else the current page.
  const pages = kind === "five_hour" ? fiveHourByWeek(all) : weeklyByQuarter(all, Date.now());
  const found = pages.findIndex((p) => p.fromMs === pageId);
  const shown = pages.findIndex((p) => p.windows.some(isPicked));
  const pageIdx =
    found >= 0
      ? found
      : shown >= 0
        ? shown
        : Math.max(
            pages.findIndex((p) => p.current),
            0,
          );
  const page = pages[pageIdx];
  const rows = page ? page.windows : listed;
  const unit = kind === "five_hour" ? "week" : "quarter";
  const quarter = (ms: number) => {
    const d = new Date(ms);
    return `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}`;
  };
  return (
    <section className="card">
      <h2>Windows</h2>
      {rows.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Start → reset</th>
                <th className="num">Peak</th>
                <th className="num">Tokens</th>
                <th className="num">Cost</th>
                <th className="num">$ per 1 %</th>
                <th className="num">Tokens per 1 %</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => {
                const cls = [
                  "link",
                  w.lowSignal && "faded",
                  isPicked(w) && "selected",
                  w.resetsAt === hovered && "hover",
                ];
                return (
                  <tr
                    key={`${w.kind}-${w.resetsAt}`}
                    className={cls.filter(Boolean).join(" ")}
                    title={w.lowSignal ? "Under 5 %: per-1 % figures are noisy" : undefined}
                    // Mouse convenience; the button is the real (keyboard) target and handles its own clicks.
                    onClick={(e) => (e.target as Element).closest("button") || onPick(w)}
                    onMouseEnter={() => setHovered(w.resetsAt)}
                    onMouseLeave={() => setHovered(null)}
                  >
                    <td>
                      <button
                        type="button"
                        className="row-pick"
                        aria-pressed={isPicked(w)}
                        onClick={() => onPick(w)}
                      >
                        {when(w.startMs ?? 0)} → {when(w.resetsAt)}
                      </button>
                      {w.current && <span className="muted"> (current)</span>}
                    </td>
                    <td className="num">{pct(w.peakPercent)}</td>
                    <td className="num">{fmtTokens(w.tokens)}</td>
                    <td className="num">{fmtUsd(w.costUsd)}</td>
                    <td className="num">{perPct(w.usdPerPercent, fmtUsd)}</td>
                    <td className="num">{perPct(w.tokensPerPercent, fmtTokens)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">
          No {kindLabel(kind)} windows in this {page ? unit : "period"}.
        </p>
      )}
      {page && (
        <>
          <WindowStrip
            kind={kind}
            page={page}
            isPicked={isPicked}
            onPick={onPick}
            hovered={hovered}
            onHover={setHovered}
          />
          <div className="toolbar window-pager">
            <button
              type="button"
              disabled={pageIdx + 1 >= pages.length}
              onClick={() => setPageId(pages[pageIdx + 1]?.fromMs ?? null)}
            >
              ← Older {unit}
            </button>
            <span className="muted">
              {kind === "five_hour"
                ? `${when(page.fromMs)} → ${when(page.toMs)}`
                : quarter(page.fromMs)}
              {page.current && " (current)"} · {rows.length}{" "}
              {rows.length === 1 ? "window" : "windows"}
            </span>
            <button
              type="button"
              disabled={pageIdx === 0}
              onClick={() => setPageId(pages[pageIdx - 1]?.fromMs ?? null)}
            >
              Newer {unit} →
            </button>
          </div>
        </>
      )}
      <p className="muted note">
        Pick a window to show it in the charts and sessions. Per-1 % figures are Claude Code only,
        counted up to the last plan reading. {CHAT_NOTE}
      </p>
    </section>
  );
}
