import { type ReactNode, useState } from "react";

/** A full-width chart card whose button widens it to 95 % of the viewport (2.5 % to each edge). */
export function ChartCard({
  title,
  controls,
  children,
}: {
  title: ReactNode;
  controls?: ReactNode;
  children: ReactNode;
}) {
  const [wide, setWide] = useState(false);
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
          onClick={() => setWide(!wide)}
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
