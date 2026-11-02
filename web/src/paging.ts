export type Paged = { key: string; page: number };

/** Paging state for filter `key`: a different filter starts over at page 0; the same one is unchanged. */
export const forFilter = (p: Paged, key: string): Paged => (p.key === key ? p : { key, page: 0 });
