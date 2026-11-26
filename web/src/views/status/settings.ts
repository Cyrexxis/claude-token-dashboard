import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Settings } from "@td/shared";
import { useState } from "react";
import { api } from "../../api";

/** The saved settings and a setter that saves a change; shared by the Status page sections. */
export function useSettings() {
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
      // Windows change with the settings, and so does each session's plan %.
      return Promise.all(
        ["plan", "sessions", "session"].map((k) => client.invalidateQueries({ queryKey: [k] })),
      );
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
  return { s, set, error: settings.error ?? save.error };
}
