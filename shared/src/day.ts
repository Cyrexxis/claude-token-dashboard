const pad = (n: number) => String(n).padStart(2, "0");

/** The local calendar day of `d` as YYYY-MM-DD, the form ranges and rollups use. */
export const localDay = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
