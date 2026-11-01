import { useQuery } from "@tanstack/react-query";
import type { Prices } from "@td/shared";
import type { ViewProps } from "../App";
import { api } from "../api";
import { SeriesView } from "./Tokens";

export function Cost({ range }: ViewProps) {
  const prices = useQuery({ queryKey: ["prices"], queryFn: () => api<Prices>("/prices") });
  // A price change is marked on the bucket that contains its effective date.
  const marks = (buckets: string[]) =>
    (prices.data?.periods ?? []).flatMap((p) => {
      if (!p.effectiveFrom || !buckets.length) return [];
      if (p.effectiveFrom < buckets[0]) return [];
      if (range.to && p.effectiveFrom > range.to) return [];
      const at = buckets.filter((b) => b <= (p.effectiveFrom as string)).at(-1);
      return at ? [{ day: at, label: `${p.modelId} price change` }] : [];
    });
  return (
    <SeriesView
      range={range}
      metric="cost"
      groups={["model", "source", "project"]}
      title="API-equivalent cost at historical prices"
      marks={marks}
    />
  );
}
