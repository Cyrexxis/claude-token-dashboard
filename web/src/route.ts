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
    // A new navigation (link or location.hash) makes a history entry with no state; back/forward
    // lands on one marked here, and the browser restores its scroll position on its own.
    const mark = () => history.replaceState({ seen: true }, "");
    if (!history.state) mark();
    const on = (e: HashChangeEvent) => {
      const next = parseHash(location.hash);
      // A hash change keeps the scroll position, so a newly opened view starts at the top. Picking
      // a session on the Sessions view stays put, so the list keeps its place.
      if (!history.state) {
        mark();
        if (next.view !== parseHash(new URL(e.oldURL).hash).view) scrollTo(0, 0);
      }
      setRoute(next);
    };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}
