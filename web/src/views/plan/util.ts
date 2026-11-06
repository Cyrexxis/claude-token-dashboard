import { TIMED_PLAN_KINDS, type TimedPlanKind } from "@td/shared";
import { useEffect, useState } from "react";

const KIND_LABEL: Record<string, string> = { five_hour: "5-hour", seven_day: "Weekly" };

export const kindLabel = (kind: string) => KIND_LABEL[kind] ?? kind;

export const pct = (n: number) => `${n.toFixed(1).replace(/\.0$/, "")} %`;

export const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export const hourTick = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export const dayTime = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });

/** Re-renders every 30 s so reset countdowns stay current. */
export function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export type Kind = TimedPlanKind;

export const KINDS = TIMED_PLAN_KINDS;
