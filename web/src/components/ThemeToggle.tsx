import { useEffect, useState } from "react";

type Theme = "light" | "dark";
/** Also read by the inline script in index.html, which applies it before first paint. */
const STORAGE_KEY = "td:theme";
const darkQuery = () => matchMedia("(prefers-color-scheme: dark)");

function current(): Theme {
  const set = document.documentElement.dataset.theme;
  if (set === "light" || set === "dark") return set;
  return darkQuery().matches ? "dark" : "light";
}

/** Light/dark switch; until clicked, the page follows the OS setting. Shows the theme in use. */
export function ThemeToggle() {
  const [theme, setTheme] = useState(current);

  // While no choice is stored, keep the icon in step with an OS theme change.
  useEffect(() => {
    const mq = darkQuery();
    const sync = () => setTheme(current());
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not saved: the theme still switches for this visit.
    }
    setTheme(next);
  };

  return (
    <button
      type="button"
      className="theme-toggle"
      data-theme-icon={theme}
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      onClick={toggle}
    >
      {/* Sun whose core swells into a moon as a second circle slides over it; the rays spin away. */}
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <mask id="theme-moon-cut">
          <rect width="24" height="24" fill="#fff" />
          <circle className="moon-cut" cx="26" cy="8" r="4.5" fill="#000" />
        </mask>
        <circle
          className="sun-core"
          cx="12"
          cy="12"
          r="5"
          fill="currentColor"
          mask="url(#theme-moon-cut)"
        />
        <g className="sun-rays" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M12 1.5v2M12 20.5v2M1.5 12h2M20.5 12h2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M4.6 19.4L6 18M18 6l1.4-1.4" />
        </g>
      </svg>
    </button>
  );
}
