export const when = (ms: number | null) => (ms === null ? "never" : new Date(ms).toLocaleString());
