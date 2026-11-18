import { test } from "node:test";
import assert from "node:assert/strict";
import { matchFilter } from "../src/fuzzy.ts";
import { visibleBookmarks } from "../src/selectors.ts";
import type { AppState, Bookmark } from "../src/types.ts";

function bookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    id: "1",
    url: "https://example.com",
    title: "Example",
    description: "",
    tags: [],
    archived: false,
    createdAt: 1,
    ...overrides,
  };
}

function state(bookmarks: Bookmark[], extra: Partial<AppState> = {}): AppState {
  return {
    bookmarks,
    view: "saved",
    selectedId: null,
    tagFilter: [],
    sortMode: "name",
    query: "",
    fuzzyOpen: false,
    fuzzyCaret: 0,
    themeName: "dark",
    themeOpen: false,
    themeIndex: 0,
    edit: null,
    tagIndex: 0,
    status: null,
    helpOpen: false,
    history: [],
    ...extra,
  };
}

test("visibleBookmarks filters by tag", () => {
  const items = [
    bookmark({ id: "1", title: "A", tags: ["work"] }),
    bookmark({ id: "2", title: "B", tags: ["personal"] }),
  ];
  const result = visibleBookmarks(state(items, { tagFilter: ["work"] }));
  assert.deepEqual(result.map((b) => b.id), ["1"]);
});

test("visibleBookmarks hides archived in saved view", () => {
  const items = [bookmark({ id: "1", archived: true })];
  assert.deepEqual(visibleBookmarks(state(items)).map((b) => b.id), []);
  assert.deepEqual(visibleBookmarks(state(items, { view: "trash" })).map((b) => b.id), ["1"]);
});

test("visibleBookmarks sorts by name", () => {
  const items = [bookmark({ id: "1", title: "B" }), bookmark({ id: "2", title: "A" })];
  assert.deepEqual(visibleBookmarks(state(items)).map((b) => b.id), ["2", "1"]);
});
