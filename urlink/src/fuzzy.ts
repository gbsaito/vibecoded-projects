import type { Bookmark } from "./types.ts";

export function matchFilter(query: string, items: Bookmark[]): Bookmark[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const out: Bookmark[] = [];
  for (const b of items) {
    const hay = `${b.title} ${b.url} ${b.description} ${b.tags.join(" ")}`.toLowerCase();
    if (hay.includes(q)) out.push(b);
  }
  return out;
}
