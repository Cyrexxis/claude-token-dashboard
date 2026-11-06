import { KINDS, type Kind, kindLabel } from "./util";

export function WindowTabs({ kind, onChange }: { kind: Kind; onChange: (k: Kind) => void }) {
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
