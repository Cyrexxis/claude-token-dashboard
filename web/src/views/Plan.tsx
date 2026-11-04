import { skipToken, useQuery } from "@tanstack/react-query";
import {
  type Group,
  isTimedPlanKind,
  type PlanSnapshots,
  type PlanWindow,
  type PlanWindows,
  type SessionList,
  TIMED_PLAN_KINDS,
  type TimedPlanKind,
  type Timeseries,
} from "@td/shared";
import { useEffect, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../api";
import { axisProps, seriesColor, tooltipStyle } from "../chart-theme";
import { ChartCard } from "../components/ChartCard";
import { SessionTable } from "../components/SessionTable";
import { TimeChart } from "../components/TimeChart";
import { GroupSelect, MetricToggle } from "../components/Toggle";
import { fmtDuration, fmtTokens, fmtUsd, localDay } from "../format";
import {
  findWindow,
  fiveHourByWeek,
  mergeReadings,
  overlappingWeekly,
  type WindowId,
  type WindowPage,
  weeklyByQuarter,
  windowTicks,
} from "../plan-math";
import type { ViewProps } from "../types";

const KIND_LABEL: Record<string, string> = { five_hour: "5-hour", seven_day: "Weekly" };
const kindLabel = (kind: string) => KIND_LABEL[kind] ?? kind;
const pct = (n: number) => `${n.toFixed(1).replace(/\.0$/, "")} %`;
const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const hourTick = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const dayTick = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const dayTime = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
const CHAT_NOTE =
  "Plan % also counts claude.ai chat and Cowork, so this reads low on days you also chat.";

/** Re-renders every 30 s so reset countdowns stay current. */
function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function usePlanWindows(range: ViewProps["range"]) {
  return useQuery({
    queryKey: ["plan", "windows", range],
    queryFn: ({ signal }) => api<PlanWindows>("/plan/windows", range, { signal }),
  });
}

function WindowCard({ w }: { w: PlanWindow }) {
  const now = useNow();
  return (
    <div className="tile">
      <div className="label">{kindLabel(w.kind)} window</div>
      <div className="value">{pct(w.peakPercent)}</div>
      <div className="bar" role="presentation">
        <span style={{ width: `${Math.min(w.peakPercent, 100)}%` }} />
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
    </div>
  );
}

type Kind = TimedPlanKind;
const KINDS = TIMED_PLAN_KINDS;

function WindowTabs({ kind, onChange }: { kind: Kind; onChange: (k: Kind) => void }) {
  return (
    <div className="tabs">
      {KINDS.map((k) => (
        <button key={k} type="button" aria-pressed={k === kind} onClick={() => onChange(k)}>
          {kindLabel(k)}
        </button>
      ))}
    </div>
  );
}

/** Snapshots covering the window; the API filters by local day, so this over-fetches a little. */
function useWindowPoints(w: PlanWindow) {
  const range = { from: localDay(new Date(w.startMs ?? 0)), to: localDay(new Date(w.resetsAt)) };
  return useQuery({
    queryKey: ["plan", "snapshots", range],
    queryFn: ({ signal }) => api<PlanSnapshots>("/plan/snapshots", range, { signal }),
  });
}

/** The 5-hour view also shows the weekly line; the weekly view shows only itself. */
function Timeline({ w, current }: { w: PlanWindow; current: PlanWindow[] }) {
  const now = useNow();
  // The weekly window's range also holds the weekly reading that carries into a 5-hour window.
  const points = useWindowPoints(current.find((c) => c.kind === "seven_day") ?? w);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set(["seven_day"]));
  if (points.error) return <p className="error">{points.error.message}</p>;
  if (!points.data) return <p className="muted">Loading…</p>;
  const start = w.startMs ?? 0;
  const rows = mergeReadings(points.data.points, current, start, w.resetsAt);
  const shown = w.kind === "five_hour" ? KINDS : [w.kind];
  const axis = axisProps;
  const color = (k: string) => seriesColor(k, (KINDS as readonly string[]).indexOf(k));
  const toggle = (k: string) =>
    setHidden((h) => {
      const next = new Set(h);
      if (!next.delete(k)) next.add(k);
      return next;
    });
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={rows}>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis
          {...axis}
          dataKey="ts"
          type="number"
          scale="time"
          domain={[start, w.resetsAt]}
          ticks={windowTicks(w.kind, start, w.resetsAt)}
          tickFormatter={w.kind === "five_hour" ? hourTick : dayTick}
        />
        <YAxis {...axis} domain={[0, 100]} tickFormatter={(v) => `${v}%`} width={44} />
        <Tooltip
          labelFormatter={(v) => when(Number(v))}
          formatter={(v) => pct(Number(v))}
          contentStyle={tooltipStyle}
        />
        {shown.length > 1 ? (
          // Same clickable legend as TimeChart, so the weekly line can be switched off.
          <Legend
            content={() => (
              <div className="legend">
                {shown.map((k) => (
                  <button
                    type="button"
                    key={k}
                    aria-pressed={!hidden.has(k)}
                    onClick={() => toggle(k)}
                  >
                    <span className="swatch" style={{ background: color(k) }} />
                    {kindLabel(k)}
                  </button>
                ))}
              </div>
            )}
          />
        ) : (
          <Legend />
        )}
        <ReferenceLine
          x={now}
          stroke="var(--muted)"
          strokeDasharray="3 3"
          label={{ value: "now", position: "insideTopRight", fill: "var(--muted)", fontSize: 11 }}
        />
        {shown.map((k) => (
          <Line
            key={k}
            dataKey={k}
            name={kindLabel(k)}
            type="stepAfter"
            stroke={color(k)}
            // The weekly view has a plain legend, so nothing can be hidden there.
            hide={shown.length > 1 && hidden.has(k)}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

function WindowSessions({ w }: { w: PlanWindow }) {
  const params = { fromMs: w.startMs ?? 0, toMs: w.resetsAt };
  const list = useQuery({
    queryKey: ["plan", "sessions", params],
    queryFn: ({ signal }) => api<SessionList>("/plan/sessions", params, { signal }),
  });
  if (list.error) return <p className="error">{list.error.message}</p>;
  if (!list.data) return <p className="muted">Loading…</p>;
  if (!list.data.items.length) return <p className="muted empty">No sessions in this window.</p>;
  return (
    <>
      <SessionTable items={list.data.items} sortable />
      <p className="muted note">
        Tokens and cost count only requests inside the window; duration is the whole session.
      </p>
    </>
  );
}

const STEP_MS: Record<Kind, number> = { five_hour: 5 * 60_000, seven_day: 3 * 3_600_000 };
const GROUPS: Group[] = ["type", "model", "source", "project"];
const slotLabel = (kind: Kind) => (b: string) =>
  kind === "five_hour" ? hourTick(Number(b)) : dayTime(Number(b));

/** Tokens or cost in the current window, 5-minute slots for 5-hour, 3-hour slots for weekly. */
function WindowSeries({
  current,
  picked,
  tabKind,
  setKind,
}: {
  current: PlanWindow[];
  picked: PlanWindow | null;
  tabKind: Kind;
  setKind: (k: Kind) => void;
}) {
  const kind = picked && isTimedPlanKind(picked.kind) ? picked.kind : tabKind;
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const [group, setGroup] = useState<Group>("type");
  const w = picked ?? current.find((c) => c.kind === kind && c.startMs !== null);
  const params = w && {
    fromMs: w.startMs ?? 0,
    toMs: w.resetsAt,
    stepMs: STEP_MS[kind],
    metric,
    group,
  };
  const q = useQuery({
    queryKey: ["plan", "timeseries", params],
    queryFn: params
      ? ({ signal }) => api<Timeseries>("/plan/timeseries", params, { signal })
      : skipToken,
  });
  return (
    <ChartCard
      title={`${metric === "tokens" ? "Tokens" : "API-equivalent cost"} in the ${picked ? "selected" : "current"} window`}
      controls={
        <>
          <MetricToggle value={metric} onChange={setMetric} />
          <GroupSelect value={group} groups={GROUPS} onChange={setGroup} />
          {!picked && <WindowTabs kind={kind} onChange={setKind} />}
        </>
      }
    >
      {!w && <p className="muted empty">No current {kindLabel(kind)} window.</p>}
      {q.error && <p className="error">{q.error.message}</p>}
      {w && !q.data && !q.error && <p className="muted">Loading…</p>}
      {w && q.data && (
        <TimeChart
          // Remount per metric so the cache-read default applies to tokens only.
          key={metric}
          data={q.data}
          kind="bar"
          height={320}
          format={metric === "cost" ? fmtUsd : fmtTokens}
          label={slotLabel(kind)}
          // Cache reads dwarf every other type and would flatten the chart.
          defaultHidden={metric === "tokens" ? ["cacheRead"] : []}
        />
      )}
    </ChartCard>
  );
}

const perPct = (v: number | null, f: (n: number) => string) => (v === null ? "—" : f(v));

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
function WindowStrip({
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

/** Windows of one kind, a page at a time; the table and the strip share a hover highlight. */
function WindowsCard({
  kind,
  setKind,
  all,
  isPicked,
  onPick,
}: {
  kind: Kind;
  setKind: (k: Kind) => void;
  all: PlanWindow[];
  isPicked: (w: PlanWindow) => boolean;
  onPick: (w: PlanWindow) => void;
}) {
  // Page by its fromMs; null (or a page of the other tab) = the current page.
  const [pageId, setPageId] = useState<number | null>(null);
  // The window under the pointer, by resetsAt; local so hovering doesn't re-render the charts.
  const [hovered, setHovered] = useState<number | null>(null);
  const listed = all.filter((w) => w.kind === kind && w.startMs !== null);
  // 5-hour windows page by week, weekly windows by quarter; newest first, opening on the current page.
  const pages = kind === "five_hour" ? fiveHourByWeek(all) : weeklyByQuarter(all, Date.now());
  const found = pages.findIndex((p) => p.fromMs === pageId);
  const pageIdx =
    found >= 0
      ? found
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
      <div className="toolbar">
        <h2 className="card-title">Windows</h2>
        <WindowTabs kind={kind} onChange={setKind} />
      </div>
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
              {page.current && " (current)"} · {rows.length} windows
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

export function Plan({ range }: ViewProps) {
  const windows = usePlanWindows(range);
  // One 5-hour/weekly choice drives every tab group on the page.
  const [kind, setKind] = useState<Kind>("five_hour");
  // The pick is an identity: the shown window always comes from the latest fetch.
  const [pickedId, setPickedId] = useState<WindowId | null>(null);
  if (windows.error) return <p className="error">{windows.error.message}</p>;
  if (!windows.data) return <p className="muted">Loading…</p>;
  const { current, past } = windows.data;
  const picked = findWindow(past, pickedId);
  if (!current.length && !past.length)
    return (
      <p className="muted empty">
        No plan readings yet. Start a Claude Code session in WSL with the mod loaded (
        <code>claude --plugin-dir ./plugin</code>).
      </p>
    );
  const win = (k: Kind) => current.find((w) => w.kind === k && w.startMs !== null);
  const chartWin = picked ?? win(kind);
  // A picked window brings its own readings; a 5-hour one also shows the weekly window it overlaps.
  const chartCurrent = picked
    ? [picked, ...overlappingWeekly(picked, [...current, ...past]).slice(0, 1)]
    : current;
  const tableWin = picked ?? win(kind);
  // The current row stands for "no pick": choosing it goes back to the current view.
  const isPicked = (w: PlanWindow) =>
    w.current ? picked === null : picked?.kind === w.kind && picked.resetsAt === w.resetsAt;
  const pick = (w: PlanWindow) =>
    setPickedId(w.current ? null : { kind: w.kind, resetsAt: w.resetsAt });
  const none = (k: Kind) => <p className="muted empty">No current {kindLabel(k)} window.</p>;
  return (
    <>
      {current.length > 0 && (
        <div className="tiles">
          {current.map((w) => (
            <WindowCard key={`${w.kind}-${w.resetsAt}`} w={w} />
          ))}
        </div>
      )}
      {picked && (
        <div className="card toolbar">
          <span style={{ flex: 1 }}>
            Charts and sessions show the past {kindLabel(picked.kind)} window{" "}
            {when(picked.startMs ?? 0)} → {when(picked.resetsAt)}.
          </span>
          <button type="button" className="primary" onClick={() => setPickedId(null)}>
            Back to current window
          </button>
        </div>
      )}
      <ChartCard
        title={`Plan usage in the ${picked ? "selected" : "current"} window`}
        controls={!picked && <WindowTabs kind={kind} onChange={setKind} />}
      >
        {chartWin ? <Timeline w={chartWin} current={chartCurrent} /> : none(kind)}
      </ChartCard>
      <WindowSeries current={current} picked={picked} tabKind={kind} setKind={setKind} />
      <section className="card">
        <div className="toolbar">
          <h2 className="card-title">Sessions in the {picked ? "selected" : "current"} window</h2>
          {!picked && <WindowTabs kind={kind} onChange={setKind} />}
        </div>
        {tableWin ? <WindowSessions w={tableWin} /> : none(kind)}
      </section>
      <WindowsCard
        kind={kind}
        setKind={setKind}
        all={[...current, ...past]}
        isPicked={isPicked}
        onPick={pick}
      />
    </>
  );
}
