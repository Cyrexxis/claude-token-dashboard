import { type ReactNode, useState } from "react";

/** localStorage key per chart; storage can be blocked or unavailable, which just means "not widened". */
const storageKey = (id: string) => `td:chart-wide:${id}`;
function loadWide(id: string): boolean {
  try {
    return localStorage.getItem(storageKey(id)) === "1";
  } catch {
    return false;
  }
}
function saveWide(id: string, wide: boolean): void {
  try {
    if (wide) localStorage.setItem(storageKey(id), "1");
    else localStorage.removeItem(storageKey(id));
  } catch {
    // Not saved: the chart still toggles for this visit.
  }
}

/**
 * A full-width chart card whose button widens it to 95 % of the viewport (2.5 % to each edge).
 * The choice is remembered per chart (`id`) in this browser.
 */
export function ChartCard({
  id,
  title,
  controls,
  children,
}: {
  id: string;
  title: ReactNode;
  controls?: ReactNode;
  children: ReactNode;
}) {
  const [wide, setWide] = useState(() => loadWide(id));
  return (
    <section className={wide ? "card wide" : "card"}>
      <div className="toolbar">
        <h2 className="card-title">{title}</h2>
        {controls}
        <button
          type="button"
          className="widen"
          aria-pressed={wide}
          aria-label={wide ? "Narrow chart" : "Widen chart"}
          title={wide ? "Narrow chart" : "Widen chart"}
          onClick={() => {
            setWide(!wide);
            saveWide(id, !wide);
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            {wide ? (
              <path d="M1 8h5m4 0h5M3 5l3 3-3 3m10-6-3 3 3 3" />
            ) : (
              <path d="M1 8h14M4 5 1 8l3 3m8-6 3 3-3 3" />
            )}
          </svg>
        </button>
      </div>
      {children}
    </section>
  );
}
