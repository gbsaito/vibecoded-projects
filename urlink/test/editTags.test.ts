import { test } from "node:test";
import assert from "node:assert/strict";
import type { KeyEvent } from "@opentui/core";
import { handleKey } from "../src/keys.ts";
import { tagSuggestions, applyTagSuggestion } from "../src/editOps.ts";
import { allTags } from "../src/selectors.ts";
import type { AppState, Bookmark, EditState } from "../src/types.ts";

function key(name: string): KeyEvent {
  return { name, raw: name } as KeyEvent;
}

function bookmark(id: string, tags: string[]): Bookmark {
  return { id, url: `https://${id}.com`, title: id, description: "", tags, archived: false, createdAt: 1 };
}

function state(bookmarks: Bookmark[], edit: EditState | null): AppState {
  return {
    bookmarks,
    view: "saved",
    selectedId: null,
    tagFilter: [],
    sortMode: "name",
    query: "",
    fuzzyOpen: false,
    fuzzyCaret: 0,
    helpOpen: false,
    themeName: "dark",
    themeOpen: false,
    themeIndex: 0,
    edit,
    tagIndex: 0,
    status: null,
    history: [],
  };
}

function edit(partial: Partial<EditState>): EditState {
  return { id: "", mode: "add", url: "https://a.com", title: "", description: "", tagsText: "", focus: "tags", error: null, cursor: 0, ...partial };
}

test("tagSuggestions: prefix match on the word before the caret", () => {
  const books = [bookmark("1", ["react"]), bookmark("2", ["webdev", "web", "rust"])];
  assert.deepEqual(tagSuggestions(books, edit({ tagsText: "re", cursor: 2 })), ["react"]);
});

test("tagSuggestions: empty word lists every existing tag", () => {
  const books = [bookmark("1", ["rust"]), bookmark("2", ["react"])];
  assert.deepEqual(tagSuggestions(books, edit({ tagsText: "", cursor: 0 })), [...allTags(books)]);
});

test("tagSuggestions: tags already typed are excluded", () => {
  const books = [bookmark("1", ["react", "rust", "web"])];
  assert.deepEqual(tagSuggestions(books, edit({ tagsText: "rust ", cursor: 5 })), ["react", "web"]);
});

test("tagSuggestions: consecutive Tab cycles away from the exact match", () => {
  const books = [bookmark("1", ["react", "react-router"])];
  assert.deepEqual(tagSuggestions(books, edit({ tagsText: "react", cursor: 5 })), ["react-router"]);
});

test("tagSuggestions: fully typed sole match yields none", () => {
  const books = [bookmark("1", ["react"])];
  assert.deepEqual(tagSuggestions(books, edit({ tagsText: "react", cursor: 5 })), []);
});

test("tagSuggestions: no suggestions outside the tags field", () => {
  const books = [bookmark("1", ["react"])];
  assert.deepEqual(tagSuggestions(books, edit({ tagsText: "re", cursor: 2, focus: "title" })), []);
});

test("tab in tags accepts the displayed suggestion", () => {
  const books = [bookmark("1", ["react", "rust"])];
  const out = handleKey(state(books, edit({ tagsText: "re", cursor: 2 })), key("tab"));
  const e = out.next.edit!;
  assert.equal(e.focus, "tags");
  assert.equal(e.tagsText, "react");
  assert.equal(e.cursor, 5);
});

test("tab with a fully typed sole match moves to the next field", () => {
  const books = [bookmark("1", ["react"])];
  const out = handleKey(state(books, edit({ tagsText: "react", cursor: 5 })), key("tab"));
  assert.equal(out.next.edit!.focus, "title");
});

test("tab outside tags still moves focus", () => {
  const books = [bookmark("1", ["react"])];
  const out = handleKey(state(books, edit({ tagsText: "react", cursor: 5, focus: "url" })), key("tab"));
  assert.equal(out.next.edit!.focus, "tags");
});

test("applyTagSuggestion replaces the partial word with the full tag", () => {
  const e = applyTagSuggestion(edit({ tagsText: "web webd react", cursor: 8 }), "webdev");
  assert.equal(e.tagsText, "web webdev react");
  assert.equal(e.cursor, 10);
});
