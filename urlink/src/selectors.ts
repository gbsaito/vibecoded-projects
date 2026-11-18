import type { AppState, Bookmark, SortMode } from "./types.ts";
import { matchFilter } from "./fuzzy.ts";

export function visibleBookmarks(state: AppState): Bookmark[] {
  const base = state.view === "trash" ? state.bookmarks.filter((b) => b.archived) : state.bookmarks.filter((b) => !b.archived);
  const tags = new Set(state.tagFilter);
  const filtered = tags.size === 0 ? base : base.filter((b) => b.tags.some((t) => tags.has(t)));
  const matched = state.query.trim().length > 0 ? matchFilter(state.query, filtered) : filtered;
  const sorted = [...matched].sort((a, b) => sortCompare(a, b, state.sortMode));
  return sorted;
}

export function allTags(bookmarks: Bookmark[]): string[] {
  const set = new Set<string>();
  for (const b of bookmarks) {
    for (const t of b.tags) if (t) set.add(t);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

export function navEntries(bookmarks: Bookmark[]): string[] {
  return ["All", ...allTags(bookmarks), "Trash"];
}

export function moveSelection(state: AppState, delta: number): AppState {
  const list = visibleBookmarks(state);
  const idx = list.findIndex((b) => b.id === state.selectedId);
  const next = idx >= 0 ? idx + delta : delta > 0 ? 0 : list.length - 1;
  const clamped = Math.max(0, Math.min(list.length - 1, next));
  const target = list[clamped];
  if (!target) return state;
  if (state.selectedId === target.id) return state;
  return { ...state, selectedId: target.id };
}

export function sortCompare(a: Bookmark, b: Bookmark, mode: SortMode): number {
  switch (mode) {
    case "date":
      return b.createdAt - a.createdAt;
    case "url":
      return a.url.localeCompare(b.url);
    case "name":
    default:
      return a.title.localeCompare(b.title);
  }
}
