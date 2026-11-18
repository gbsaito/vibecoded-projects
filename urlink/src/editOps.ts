import type { Bookmark, EditState, EditSection, UndoEntry } from "./types.ts";
import { hostnameOf, nextId, upsertBookmark } from "./store.ts";
import { normalizeUrl } from "./url.ts";
import { allTags } from "./selectors.ts";

export const EDIT_ORDER: EditSection[] = ["url", "tags", "title", "description"];

export interface SaveResult {
  bookmarks: Bookmark[];
  selectedId: string | null;
  undo?: UndoEntry;
}

export function newEdit(mode: "add" | "edit", target: Bookmark | null): EditState {
  if (mode === "add") {
    return { id: "", mode, url: "", title: "", description: "", tagsText: "", focus: "url", error: null, cursor: 0 };
  }
  if (!target) {
    return { id: "", mode, url: "", title: "", description: "", tagsText: "", focus: "url", error: null, cursor: 0 };
  }
  return {
    id: target.id,
    mode,
    url: target.url,
    title: target.title,
    description: target.description,
    tagsText: target.tags.join(" "),
    focus: "url",
    error: null,
    cursor: target.url.length,
  };
}

export function saveEdit(bookmarks: Bookmark[], edit: EditState): SaveResult {
  if (edit.mode === "add") {
    const created: Bookmark = {
      id: nextId(bookmarks),
      url: normalizeUrl(edit.url),
      title: edit.title.trim() || hostnameOf(normalizeUrl(edit.url)),
      description: edit.description.trim(),
      tags: edit.tagsText
        .split(/\s+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
      archived: false,
      createdAt: Date.now(),
    };
    return { bookmarks: upsertBookmark(bookmarks, created), selectedId: created.id, undo: { kind: "add", bookmark: created } };
  }
  const idx = bookmarks.findIndex((b) => b.id === edit.id);
  if (idx < 0) return { bookmarks, selectedId: null };
  const next = [...bookmarks];
  const before = { ...next[idx]! };
  next[idx] = {
    ...before,
    url: normalizeUrl(edit.url),
    title: edit.title.trim(),
    description: edit.description.trim(),
    tags: edit.tagsText
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
  };
  return { bookmarks: next, selectedId: edit.id, undo: { kind: "edit", bookmark: before } };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// Partial token strictly before the caret (a trailing space means: new word).
function wordBefore(value: string, at: number): string {
  let i = at;
  while (i > 0 && !isSpace(value[i - 1])) i--;
  return value.slice(i, at);
}

const TAG_SUGGEST_LIMIT = 5;

// Ordered tag suggestions for the word before the caret. After accepting one,
// the word matches a tag exactly and the rotation starts past it, so
// consecutive Tab presses cycle through the rest.
export function tagSuggestions(bookmarks: Bookmark[], e: EditState): string[] {
  if (e.focus !== "tags") return [];
  const value = e.tagsText;
  const at = clamp(e.cursor, 0, value.length);
  const word = wordBefore(value, at).toLowerCase();
  const others = new Set(value.toLowerCase().split(/\s+/).filter(Boolean));
  others.delete(word);
  const pool = allTags(bookmarks).filter((t) => {
    const lower = t.toLowerCase();
    return lower.startsWith(word) && !others.has(lower);
  });
  const exactIdx = pool.findIndex((t) => t.toLowerCase() === word);
  if (exactIdx < 0) return pool.slice(0, TAG_SUGGEST_LIMIT);
  if (pool.length === 1) return []; // fully typed sole match: Tab moves on
  const rotated = [...pool.slice(exactIdx + 1), ...pool.slice(0, exactIdx)];
  return rotated.slice(0, TAG_SUGGEST_LIMIT);
}

export function applyTagSuggestion(e: EditState, tag: string): EditState {
  const value = e.tagsText;
  const at = clamp(e.cursor, 0, value.length);
  const start = at - wordBefore(value, at).length;
  let end = at;
  while (end < value.length && !isSpace(value[end])) end++;
  return { ...e, tagsText: value.slice(0, start) + tag + value.slice(end), cursor: start + tag.length };
}

function fieldValue(e: EditState): { section: EditSection; value: string } {
  switch (e.focus) {
    case "url":
      return { section: "url", value: e.url };
    case "tags":
      return { section: "tags", value: e.tagsText };
    case "title":
      return { section: "title", value: e.title };
    case "description":
      return { section: "description", value: e.description };
  }
}

export function fieldLength(e: EditState): number {
  return fieldValue(e).value.length;
}

export function caretOf(e: EditState): number {
  return clamp(e.cursor, 0, fieldLength(e));
}

function setField(e: EditState, section: EditSection, value: string, cursor: number): EditState {
  switch (section) {
    case "url":
      return { ...e, url: value, cursor, error: null };
    case "tags":
      return { ...e, tagsText: value, cursor };
    case "title":
      return { ...e, title: value, cursor };
    case "description":
      return { ...e, description: value, cursor };
  }
}

function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

function wordStart(value: string, at: number): number {
  let i = at;
  while (i > 0 && isSpace(value[i - 1])) i--;
  while (i > 0 && !isSpace(value[i - 1])) i--;
  return i;
}

function wordEnd(value: string, at: number): number {
  let i = at;
  while (i < value.length && isSpace(value[i])) i++;
  while (i < value.length && !isSpace(value[i])) i++;
  return i;
}

export function insertEdit(e: EditState, text: string): EditState {
  const { section, value } = fieldValue(e);
  const at = clamp(e.cursor, 0, value.length);
  const nextValue = value.slice(0, at) + text + value.slice(at);
  return setField(e, section, nextValue, at + text.length);
}

export function backspaceEdit(e: EditState, word = false): EditState {
  const { section, value } = fieldValue(e);
  const at = clamp(e.cursor, 0, value.length);
  if (at === 0) return e;
  const start = word ? wordStart(value, at) : at - 1;
  return setField(e, section, value.slice(0, start) + value.slice(at), start);
}

export function deleteEdit(e: EditState, word = false): EditState {
  const { section, value } = fieldValue(e);
  const at = clamp(e.cursor, 0, value.length);
  if (at >= value.length) return e;
  const end = word ? wordEnd(value, at) : at + 1;
  return setField(e, section, value.slice(0, at) + value.slice(end), at);
}

export function moveCaret(e: EditState, dir: number, word = false): EditState {
  const { value } = fieldValue(e);
  const at = clamp(e.cursor, 0, value.length);
  const next = word ? (dir < 0 ? wordStart(value, at) : wordEnd(value, at)) : clamp(at + dir, 0, value.length);
  if (next === at) return e;
  return { ...e, cursor: next };
}

export function setCaret(e: EditState, position: "start" | "end"): EditState {
  const length = fieldValue(e).value.length;
  const at = position === "start" ? 0 : length;
  if (at === clamp(e.cursor, 0, length)) return e;
  return { ...e, cursor: at };
}

export function moveFocus(draft: EditState, dir: number): EditState {
  const idx = EDIT_ORDER.indexOf(draft.focus);
  const nextIdx = Math.max(0, Math.min(EDIT_ORDER.length - 1, idx + dir));
  if (nextIdx === idx) return draft;
  const focus = EDIT_ORDER[nextIdx]!;
  const next: EditState = { ...draft, focus, error: null };
  return { ...next, cursor: fieldLength(next) };
}
