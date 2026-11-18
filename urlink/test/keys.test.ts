import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import type { KeyEvent } from "@opentui/core";
import { handleKey, insertEdit } from "../src/keys.ts";
import { matchFilter } from "../src/fuzzy.ts";
import { themeNames } from "../src/theme.ts";
import type { AppState, Bookmark } from "../src/types.ts";

function key(name: string, raw = name, shift = false, ctrl = false, meta = false, option = false): KeyEvent {
  return { name, raw, shift, ctrl, meta, option } as KeyEvent;
}

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

test("matchFilter matches by title", () => {
  const items = [bookmark({ id: "1", title: "Cooking pasta" }), bookmark({ id: "2", title: "Running shoes" })];
  const hits = matchFilter("pasta", items);
  assert.deepEqual(hits.map((b) => b.id), ["1"]);
});

test("matchFilter is case-insensitive", () => {
  const items = [bookmark({ id: "1", title: "PRINTER warmup" })];
  assert.deepEqual(matchFilter("printer", items).map((b) => b.id), ["1"]);
});

test("matchFilter returns empty on no match", () => {
  const items = [bookmark({ id: "1", title: "Cooking pasta" })];
  assert.deepEqual(matchFilter("zzz", items), []);
});

test("add opens edit panel in url focus", () => {
  const result = handleKey(state([]), key("a"));
  assert.equal(result.exit, false);
  assert.equal(result.next.edit?.mode, "add");
  assert.equal(result.next.edit?.focus, "url");
});

test("edit flow: tab/down move url -> tags -> title -> description, enter saves", () => {
  let result = handleKey(state([]), key("a"));
  assert.equal(result.next.edit?.focus, "url");

  for (const ch of "https://foo.com") {
    result = handleKey(result.next, key(ch));
  }
  result = handleKey(result.next, key("tab"));
  assert.equal(result.next.edit?.focus, "tags");

  result = handleKey(result.next, key("down"));
  assert.equal(result.next.edit?.focus, "title");

  result = handleKey(result.next, key("down"));
  assert.equal(result.next.edit?.focus, "description");

  result = handleKey(result.next, key("return"));
  assert.equal(result.next.edit, null);
  assert.equal(result.next.bookmarks.length, 1);
  assert.equal(result.next.bookmarks[0]!.title, "foo.com");
});

test("invalid url keeps edit panel open with error", () => {
  let result = handleKey(state([]), key("a"));
  for (const ch of "not a url") {
    result = handleKey(result.next, key(ch));
  }
  result = handleKey(result.next, key("return"));
  assert.equal(result.next.edit?.error, "Invalid URL");
  assert.equal(result.next.edit?.focus, "url");
});

test("enter in url field moves to tags and never saves", () => {
  let result = handleKey(state([]), key("a"));
  for (const ch of "https://foo.com") {
    result = handleKey(result.next, key(ch));
  }
  result = handleKey(result.next, key("return"));
  assert.equal(result.next.edit?.focus, "tags");
  assert.equal(result.next.bookmarks.length, 0);
});

test("enter in url field accepts scheme-less urls and normalizes them", () => {
  let result = handleKey(state([]), key("a"));
  for (const ch of "foo.com") {
    result = handleKey(result.next, key(ch));
  }
  result = handleKey(result.next, key("return"));
  assert.equal(result.next.edit?.focus, "tags");
  assert.equal(result.next.edit?.url, "https://foo.com");
});

test("enter outside url field saves", () => {
  let result = handleKey(state([]), key("a"));
  for (const ch of "https://foo.com") {
    result = handleKey(result.next, key(ch));
  }
  result = handleKey(result.next, key("down"));
  assert.equal(result.next.edit?.focus, "tags");
  result = handleKey(result.next, key("return"));
  assert.equal(result.next.edit, null);
  assert.equal(result.next.bookmarks.length, 1);
});

test("delete archives selected bookmark", () => {
  const result = handleKey(state([bookmark()], { selectedId: "1" }), key("d"));
  assert.equal(result.next.bookmarks[0]!.archived, true);
  assert.equal(result.next.selectedId, null);
});

test("quit exits", () => {
  const result = handleKey(state([]), key("q"));
  assert.equal(result.exit, true);
});

test("s cycles sort modes", () => {
  const start = state([bookmark()], { sortMode: "name" });
  const first = handleKey(start, key("s"));
  assert.equal(first.next.sortMode, "date");
  assert.equal(first.next.status, "sorted by date added");
  const second = handleKey(first.next, key("s"));
  assert.equal(second.next.sortMode, "url");
  const third = handleKey(second.next, key("s"));
  assert.equal(third.next.sortMode, "name");
});

test("y yanks the selected url", () => {
  const result = handleKey(state([bookmark()], { selectedId: "1" }), key("y"));
  assert.ok(result.next.status?.includes("https://example.com"));
});

test("y without a selection reports it", () => {
  const result = handleKey(state([bookmark()], { selectedId: "missing" }), key("y"));
  assert.equal(result.next.status, "no bookmark selected");
});

test("? opens the help panel and esc closes it", () => {
  const opened = handleKey(state([]), key("?"));
  assert.equal(opened.next.helpOpen, true);
  const closed = handleKey(opened.next, key("escape"));
  assert.equal(closed.next.helpOpen, false);
});

test("u undoes the last edit", () => {
  let result = handleKey(state([bookmark()], { selectedId: "1" }), key("e"));
  result = handleKey(result.next, key("down"));
  result = handleKey(result.next, key("down"));
  for (const ch of "New Title") {
    result = handleKey(result.next, key(ch));
  }
  result = handleKey(result.next, key("return"));
  assert.equal(result.next.bookmarks[0]!.title, "ExampleNew Title");
  const undone = handleKey(result.next, key("u"));
  assert.equal(undone.next.bookmarks[0]!.title, "Example");
});

test("u undoes the last delete", () => {
  let result = handleKey(state([bookmark()], { selectedId: "1" }), key("d"));
  assert.equal(result.next.bookmarks[0]!.archived, true);
  const undone = handleKey(result.next, key("u"));
  assert.equal(undone.next.bookmarks[0]!.archived, false);
});

test("u undoes the last add", () => {
  let result = handleKey(state([]), key("a"));
  for (const ch of "https://foo.com") result = handleKey(result.next, key(ch));
  result = handleKey(result.next, key("down"));
  result = handleKey(result.next, key("return"));
  assert.equal(result.next.bookmarks.length, 1);
  const undone = handleKey(result.next, key("u"));
  assert.equal(undone.next.bookmarks.length, 0);
});

test("u with an empty history reports nothing to undo", () => {
  const result = handleKey(state([]), key("u"));
  assert.equal(result.next.status, "nothing to undo");
});

test("backspace erases the url field", () => {
  let result = handleKey(state([]), key("a"));
  for (const ch of "https://foo.com") {
    result = handleKey(result.next, key(ch));
  }
  for (let i = 0; i < 5; i++) {
    result = handleKey(result.next, key("backspace"));
  }
  assert.equal(result.next.edit?.url, "https://fo");
});

test("insertEdit appends pasted text to the focused field", () => {
  let result = handleKey(state([]), key("a"));
  for (const ch of "https://foo.com") {
    result = handleKey(result.next, key(ch));
  }
  const pasted = insertEdit(result.next.edit!, "bar");
  assert.equal(pasted.url, "https://foo.combar");
});

test("unhandled keys return the same state (no re-render churn)", () => {
  const s = state([bookmark()], { selectedId: "1" });
  const result = handleKey(s, key("z"));
  assert.equal(result.next, s);
});

test("clamped tag navigation is a no-op", () => {
  const s = state([bookmark({ tags: ["work"] })], { tagFilter: [], tagIndex: 2 });
  const result = handleKey(s, key("l"));
  assert.equal(result.next, s);
});

test("undo history is capped at 25 entries", () => {
  const history = Array.from({ length: 150 }, (_, i) => ({ kind: "delete" as const, bookmark: { ...bookmark(), id: String(i) } }));
  let result = handleKey(state([], { history }), key("a"));
  for (const ch of "https://foo.com") {
    result = handleKey(result.next, key(ch));
  }
  result = handleKey(result.next, key("down"));
  result = handleKey(result.next, key("return"));
  assert.equal(result.next.history.length, 25);
});

test("left/right move the caret and typing inserts at it", () => {
  let result = handleKey(state([]), key("a"));
  for (const ch of "abc") {
    result = handleKey(result.next, key(ch));
  }
  result = handleKey(result.next, key("left"));
  result = handleKey(result.next, key("left"));
  result = handleKey(result.next, key("X"));
  assert.equal(result.next.edit?.url, "aXbc");
  assert.equal(result.next.edit?.cursor, 2);
});

test("home/end jump to the field bounds", () => {
  let result = handleKey(state([]), key("a"));
  for (const ch of "abc") {
    result = handleKey(result.next, key(ch));
  }
  result = handleKey(result.next, key("home"));
  result = handleKey(result.next, key("X"));
  assert.equal(result.next.edit?.url, "Xabc");
  result = handleKey(result.next, key("end"));
  result = handleKey(result.next, key("Y"));
  assert.equal(result.next.edit?.url, "XabcY");
});

test("ctrl+backspace deletes the previous word", () => {
  let result = handleKey(state([]), key("a"));
  for (const ch of "hello world") {
    result = handleKey(result.next, key(ch));
  }
  result = handleKey(result.next, key("backspace", "", false, true));
  assert.equal(result.next.edit?.url, "hello ");
});

test("alt+backspace deletes the previous word too", () => {
  let result = handleKey(state([]), key("a"));
  for (const ch of "hello world") {
    result = handleKey(result.next, key(ch));
  }
  result = handleKey(result.next, key("backspace", "", false, false, true));
  assert.equal(result.next.edit?.url, "hello ");
});

test("delete removes the character at the caret", () => {
  let result = handleKey(state([]), key("a"));
  for (const ch of "abc") {
    result = handleKey(result.next, key(ch));
  }
  result = handleKey(result.next, key("home"));
  result = handleKey(result.next, key("delete"));
  assert.equal(result.next.edit?.url, "bc");
});

test("ctrl+left/right jump by word", () => {
  let result = handleKey(state([]), key("a"));
  for (const ch of "one two three") {
    result = handleKey(result.next, key(ch));
  }
  result = handleKey(result.next, key("left", "left", false, true));
  assert.equal(result.next.edit?.cursor, 8);
  result = handleKey(result.next, key("home"));
  result = handleKey(result.next, key("right", "right", false, true));
  assert.equal(result.next.edit?.cursor, 3);
});

test("T opens the theme panel on the active theme", () => {
  const result = handleKey(state([], { themeName: "light" }), key("T"));
  assert.equal(result.next.themeOpen, true);
  assert.equal(result.next.themeIndex, 1);
  assert.equal(result.next.status, null);
});

test("theme panel down/up wraps through the themes", () => {
  let result = handleKey(state([]), key("T"));
  assert.equal(result.next.themeIndex, 0);
  for (let i = 1; i < themeNames.length; i++) {
    result = handleKey(result.next, key("down"));
    assert.equal(result.next.themeIndex, i);
  }
  result = handleKey(result.next, key("down"));
  assert.equal(result.next.themeIndex, 0);
  result = handleKey(result.next, key("up"));
  assert.equal(result.next.themeIndex, themeNames.length - 1);
});

test("theme panel can apply one of the added dark themes", () => {
  let result = handleKey(state([]), key("T"));
  for (let i = 0; i < 3; i++) {
    result = handleKey(result.next, key("down"));
  }
  result = handleKey(result.next, key("return"));
  assert.equal(result.next.themeOpen, false);
  assert.equal(result.next.themeName, "monokai");
  assert.equal(result.next.status, null);
});

test("theme panel enter applies the highlighted theme and closes", () => {
  let result = handleKey(state([]), key("T"));
  result = handleKey(result.next, key("down"));
  result = handleKey(result.next, key("return"));
  assert.equal(result.next.themeOpen, false);
  assert.equal(result.next.themeName, "light");
  assert.equal(result.next.status, null);
});

test("theme panel escape closes without changing the theme", () => {
  let result = handleKey(state([], { themeName: "tokyo-night" }), key("T"));
  result = handleKey(result.next, key("down"));
  result = handleKey(result.next, key("escape"));
  assert.equal(result.next.themeOpen, false);
  assert.equal(result.next.themeName, "tokyo-night");
});

test("browse keys are ignored while the theme panel is open", () => {
  let result = handleKey(state([]), key("T"));
  result = handleKey(result.next, key("a"));
  assert.equal(result.next.edit, null);
  assert.equal(result.next.themeOpen, true);
});

test("tag navigation can reach Trash and enters the trash view", () => {
  let result = handleKey(state([bookmark({ tags: ["work"] })], { tagFilter: [], tagIndex: 0 }), key("l"));
  assert.equal(result.next.tagIndex, 1);
  assert.equal(result.next.view, "saved");
  result = handleKey(result.next, key("l"));
  assert.equal(result.next.tagIndex, 2);
  assert.equal(result.next.view, "trash");
  result = handleKey(result.next, key("h"));
  assert.equal(result.next.view, "saved");
});

test("delete from the trash purges the bookmark permanently", () => {
  const s = state([bookmark({ archived: true })], { selectedId: "1", view: "trash" });
  const result = handleKey(s, key("d"));
  assert.equal(result.next.bookmarks.length, 0);
  assert.equal(result.next.history.length, 1);
});

test("space on All clears all toggled tag filters", () => {
  const s = state([bookmark({ tags: ["work"] })], { tagFilter: ["work"], tagIndex: 0 });
  const result = handleKey(s, key("space", " "));
  assert.deepEqual(result.next.tagFilter, []);
  assert.equal(result.next.view, "saved");
});

test("/ opens fuzzy with a fresh query, not from the selected title", () => {
  const s = state([bookmark({ id: "1", title: "Cooking pasta", description: "Dinner time" })], { selectedId: "1", query: "old query", fuzzyOpen: false });
  const result = handleKey(s, key("/"));
  assert.equal(result.next.fuzzyOpen, true);
  assert.equal(result.next.query, "");
  assert.equal(result.next.fuzzyCaret, 0);
});

test("/ opens fuzzy with an empty query when no bookmark is selected", () => {
  const result = handleKey(state([]), key("/"));
  assert.equal(result.next.fuzzyOpen, true);
  assert.equal(result.next.query, "");
  assert.equal(result.next.fuzzyCaret, 0);
});

test("A opens the trash view", () => {
  const result = handleKey(state([bookmark({ id: "1", archived: true })], { selectedId: "1", tagFilter: ["work"] }), key("A"));
  assert.equal(result.next.fuzzyOpen, false);
  assert.equal(result.next.view, "trash");
  assert.deepEqual(result.next.tagFilter, []);
});

test("r restores the selected bookmark from trash", () => {
  const result = handleKey(state([bookmark({ id: "1", archived: true })], { selectedId: "1", view: "trash" }), key("r"));
  assert.equal(result.next.bookmarks[0]?.archived, false);
  assert.equal(result.next.view, "saved");
  assert.equal(result.next.status, "restored bookmark");
});

test("r outside trash only reports the intent", () => {
  const result = handleKey(state([bookmark({ id: "1" })], { selectedId: "1" }), key("r"));
  assert.equal(result.next.view, "saved");
  assert.equal(result.next.bookmarks[0]?.archived, false);
  assert.equal(result.next.status, "r restores from trash");
});

test("fuzzy find input supports caret movement and editing", () => {
  let result = handleKey(state([bookmark({ id: "1", title: "Cooking pasta" })], { selectedId: "1", fuzzyOpen: true, query: "Cooking pasta", fuzzyCaret: 13 }), key("left"));
  assert.equal(result.next.fuzzyCaret, 12);
  result = handleKey(result.next, key("home"));
  assert.equal(result.next.fuzzyCaret, 0);
  result = handleKey(result.next, key("delete"));
  assert.equal(result.next.query, "ooking pasta");
  result = handleKey(result.next, key("backspace", "", false, true));
  assert.equal(result.next.query, "ooking pasta");
});

test("fuzzy find input inserts typed text at the caret", () => {
  let result = handleKey(state([], { fuzzyOpen: true, query: "abc", fuzzyCaret: 3 }), key("d"));
  assert.equal(result.next.query, "abcd");
  assert.equal(result.next.fuzzyCaret, 4);
});

test("x exports bookmarks and reports the export path", () => {
  process.env.URLINK_EXPORT = "/tmp/opencode/urlink-export-test.json";
  const result = handleKey(state([]), key("x"));
  assert.equal(result.next.status, "exported 0 bookmarks -> /tmp/opencode/urlink-export-test.json");
  delete process.env.URLINK_EXPORT;
});

test("i imports bookmarks from the path set in URLINK_IMPORT", () => {
  const importPath = "/tmp/opencode/urlink-import-test.json";
  writeFileSync(importPath, JSON.stringify({ bookmarks: [bookmark({ id: "9", url: "https://foo.com", title: "Foo", tags: ["foo"] })] }));
  process.env.URLINK_IMPORT = importPath;
  const result = handleKey(state([]), key("i"));
  assert.equal(result.next.bookmarks.length, 1);
  assert.equal(result.next.bookmarks[0]!.url, "https://foo.com");
  assert.equal(result.next.status, "imported 1 bookmarks");
  delete process.env.URLINK_IMPORT;
});
