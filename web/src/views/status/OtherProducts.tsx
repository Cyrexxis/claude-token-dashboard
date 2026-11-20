import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Settings } from "@td/shared";
import { useState } from "react";
import { api } from "../../api";

export function OtherProducts() {
  const client = useQueryClient();
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => api<Settings>("/settings", undefined, { signal }),
  });
  // Shown in the same click (a controlled checkbox would otherwise snap back until the save
  // returns); the server's answer replaces it.
  const [draft, setDraft] = useState<Settings | null>(null);
  const save = useMutation({
    mutationFn: (s: Settings) =>
      api<Settings>("/settings", undefined, {
        method: "PUT",
        body: JSON.stringify(s),
        headers: { "content-type": "application/json" },
      }),
    onSuccess: (s) => {
      client.setQueryData(["settings"], s);
      return client.invalidateQueries({ queryKey: ["plan"] });
    },
    onSettled: () => setDraft(null),
  });
  const s = draft ?? settings.data;
  const set = (patch: Partial<Settings>) => {
    if (!s) return;
    const next = { ...s, ...patch };
    setDraft(next);
    save.mutate(next);
  };
  return (
    <section className="card">
      <h2>Other products</h2>
      <p className="muted">
        Shows on the Plan page how much plan % rose while Claude Code on this machine was not
        working: claude.ai chat, Cowork, or Claude Code elsewhere (another computer, the web). It is
        a lower bound: use at the same time as Claude Code can't be told apart, and readings are
        whole percents, so each rise can be off by 1 %.
      </p>
      {settings.error && <p className="error">{settings.error.message}</p>}
      {save.error && <p className="error">{save.error.message}</p>}
      <label className="check">
        <input
          type="checkbox"
          checked={s?.otherProducts ?? false}
          disabled={!s}
          onChange={(e) => set({ otherProducts: e.target.checked })}
        />{" "}
        Show use from other products
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={s?.otherEstimate ?? false}
          disabled={!s?.otherProducts}
          onChange={(e) => set({ otherEstimate: e.target.checked })}
        />{" "}
        Also estimate use while Claude Code was paused (less reliable): a rise after a pause of 15
        minutes or more, minus Claude Code's own share at the window's $ per 1 %, from 2 % on
      </label>
    </section>
  );
}
