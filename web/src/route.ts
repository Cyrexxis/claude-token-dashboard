import { useEffect, useState } from "react";

export type View = "overview" | "plan" | "sessions" | "status";
export type Route = { view: View; id?: string };
const VIEWS: View[] = ["overview", "plan", "sessions", "status"];

export function parseHash(hash: string): Route {
  const [view, ...rest] = hash.replace(/^#\/?/, "").split("/");
  if (!VIEWS.includes(view as View)) return { view: "overview" };
  const id = rest.join("/");
  return id ? { view: view as View, id: decode(id) } : { view: view as View };
}

/** A hand-edited hash can hold a broken escape; keep it raw rather than throw during render. */
function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(location.hash));
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}
