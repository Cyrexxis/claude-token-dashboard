import { useQuery } from "@tanstack/react-query";
import type { Status as StatusData } from "@td/shared";
import { api } from "../../api";
import { Info } from "./Info";
import { OtherProducts } from "./OtherProducts";
import { PriceEditor } from "./PriceEditor";
import { Sources } from "./Sources";

export function Status() {
  const status = useQuery({
    queryKey: ["status"],
    queryFn: ({ signal }) => api<StatusData>("/status", undefined, { signal }),
  });
  if (status.error) return <p className="error">{status.error.message}</p>;
  if (!status.data) return <p className="muted">Loading…</p>;
  return (
    <>
      <Info status={status.data} />
      <Sources status={status.data} />
      <OtherProducts />
      <PriceEditor />
    </>
  );
}
