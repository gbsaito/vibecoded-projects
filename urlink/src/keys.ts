import type { KeyEvent } from "@opentui/core";
import type { AppState, Bookmark, EditState, SortMode, UndoEntry } from "./types.ts";
import { copyToClipboard, openUrl, defaultExportPath, defaultImportPath, exportBookmarks, importBookmarks } from "./store.ts";
import { moveSelection, navEntries, visibleBookmarks } from "./selectors.ts";
import { backspaceEdit, deleteEdit, insertEdit, moveCaret, moveFocus, newEdit, saveEdit, setCaret, tagSuggestions, applyTagSuggestion } from "./editOps.ts";
import { isValidUrl, normalizeUrl } from "./url.ts";
import { nextThemeIndex, themeNames } from "./theme.ts";

export interface KeyResult {
  next: AppState;
  exit: boolean;
}

export { insertEdit } from "./editOps.ts";

const UNDO_LIMIT = 25;

export const SORT_MODES: SortMode[] = ["name", "date", "url"];

export function nextSortMode(mode: SortMode): SortMode {
  const idx = SORT_MODES.indexOf(mode);
  return SORT_MODES[(idx + 1) % SORT_MODES.length]!;
}

export function sortLabel(mode: SortMode): string {
  switch (mode) {
    case "date":
      return "date added";
    case "url":
      return "url";
    case "name":
    default:
      return "name";
  }
}

function isEnterKey(key: KeyEvent): boolean {
  return key.name === "return" || key.name === "enter" || key.name === "linefeed" || key.name === "kp-enter";
}

function isPrintable(key: KeyEvent, raw: string): boolean {
  if (key.ctrl) return false;
  if (!raw) return false;
  if ([...raw].length !== 1) return false;
  if (raw < " " || raw === "\t") return false;
  return true;
}

function pushHistory(history: UndoEntry[], entry: UndoEntry): UndoEntry[] {
  return [...history, entry].slice(-UNDO_LIMIT);
}

function editResult(s: AppState, key: KeyEvent): KeyResult {
  const e: EditState = { ...s.edit! };
  const n: AppState = { ...s, edit: e };

  const close = (): KeyResult => {
    n.edit = null;
    return { next: n, exit: false };
  };

  const applyEditKey = (draft: EditState, k: KeyEvent): EditState => {
    const word = !!(k.ctrl || k.meta || k.option);
    if (k.name === "backspace") return backspaceEdit(draft, word);
    if (k.name === "delete") return deleteEdit(draft, word);
    const raw = k.raw ?? "";
    if (!isPrintable(k, raw)) return draft;
    return insertEdit(draft, raw);
  };

  if (key.name === "up") {
    n.edit = moveFocus(e, -1);
    return { next: n, exit: false };
  }
  if (key.name === "down") {
    n.edit = moveFocus(e, 1);
    return { next: n, exit: false };
  }
  if (key.name === "tab") {
    // In the tags field, Tab completes the suggested tag; it only moves to the
    // next field when no suggestion is pending. ↑/↓ always move between fields.
    const sugg = tagSuggestions(s.bookmarks, e);
    if (e.focus === "tags" && sugg.length > 0) {
      n.edit = applyTagSuggestion(e, sugg[0]!);
      return { next: n, exit: false };
    }
    n.edit = moveFocus(e, 1);
    return { next: n, exit: false };
  }
  if (key.name === "left" || key.name === "right") {
    n.edit = moveCaret(e, key.name === "left" ? -1 : 1, !!(key.ctrl || key.meta || key.option));
    return { next: n, exit: false };
  }
  if (key.name === "home" || key.name === "end") {
    n.edit = setCaret(e, key.name === "home" ? "start" : "end");
    return { next: n, exit: false };
  }

  const isEnter = isEnterKey(key);
  if (isEnter) {
    if (e.focus === "url") {
      const url = normalizeUrl(e.url);
      if (!isValidUrl(url)) {
        n.edit = { ...e, error: "Invalid URL" };
        return { next: n, exit: false };
      }
      n.edit = { ...e, url, focus: "tags", error: null };
      return { next: n, exit: false };
    }
    n.edit = null;
    const saved = saveEdit(n.bookmarks, e);
    n.bookmarks = saved.bookmarks;
    n.selectedId = saved.selectedId;
    if (saved.undo) n.history = pushHistory(n.history, saved.undo);
    return { next: n, exit: false };
  }

  if (key.name === "escape") return close();

  if (e.focus === "url") {
    const t = applyEditKey(e, key);
    n.edit = t;
    return { next: n, exit: false };
  }
  if (e.focus === "tags") {
    const t = applyEditKey(e, key);
    n.edit = t;
    return { next: n, exit: false };
  }
  if (e.focus === "title") {
    const t = applyEditKey(e, key);
    n.edit = t;
    return { next: n, exit: false };
  }
  const t = applyEditKey(e, key);
  n.edit = t;
  return { next: n, exit: false };
}

function openThemePanel(s: AppState): AppState {
  const index = themeNames.indexOf(s.themeName as (typeof themeNames)[number]);
  return {
    ...s,
    themeOpen: true,
    themeIndex: index >= 0 ? index : 0,
    status: null,
  };
}

function themeResult(s: AppState, key: KeyEvent): KeyResult {
  const n: AppState = { ...s };
  if (key.name === "up" || key.name === "k") {
    n.themeIndex = nextThemeIndex(s.themeIndex, -1);
    return { next: n, exit: false };
  }
  if (key.name === "down" || key.name === "j") {
    n.themeIndex = nextThemeIndex(s.themeIndex, 1);
    return { next: n, exit: false };
  }
  if (key.name === "escape" || key.name === "T" || key.name === "t") {
    n.themeOpen = false;
    return { next: n, exit: false };
  }
  if (isEnterKey(key) || key.name === "space") {
    const name = themeNames[s.themeIndex] ?? "dark";
    n.themeName = name;
    n.themeOpen = false;
    n.status = null;
    return { next: n, exit: false };
  }
  return { next: s, exit: false };
}

function clampFuzzy(value: number, max: number): number {
  return Math.max(0, Math.min(max, value));
}

function isSpaceChar(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

function fuzzyWordStart(value: string, at: number): number {
  let i = at;
  while (i > 0 && isSpaceChar(value[i - 1])) i--;
  while (i > 0 && !isSpaceChar(value[i - 1])) i--;
  return i;
}

function fuzzyWordEnd(value: string, at: number): number {
  let i = at;
  while (i < value.length && isSpaceChar(value[i])) i++;
  while (i < value.length && !isSpaceChar(value[i])) i++;
  return i;
}

function fuzzyInsert(s: AppState, ch: string): AppState {
  const at = clampFuzzy(s.fuzzyCaret, s.query.length);
  const next = s.query.slice(0, at) + ch + s.query.slice(at);
  return { ...s, query: next, fuzzyCaret: at + ch.length };
}

function fuzzyBackspace(s: AppState, word: boolean): AppState {
  const at = clampFuzzy(s.fuzzyCaret, s.query.length);
  if (at === 0) return s;
  const start = word ? fuzzyWordStart(s.query, at) : at - 1;
  const next = s.query.slice(0, start) + s.query.slice(at);
  return { ...s, query: next, fuzzyCaret: start };
}

function fuzzyDelete(s: AppState, word: boolean): AppState {
  const at = clampFuzzy(s.fuzzyCaret, s.query.length);
  if (at >= s.query.length) return s;
  const end = word ? fuzzyWordEnd(s.query, at) : at + 1;
  const next = s.query.slice(0, at) + s.query.slice(end);
  return { ...s, query: next, fuzzyCaret: at };
}

function fuzzyMoveCaret(s: AppState, dir: number, word: boolean): number {
  const at = clampFuzzy(s.fuzzyCaret, s.query.length);
  const next = word ? (dir < 0 ? fuzzyWordStart(s.query, at) : fuzzyWordEnd(s.query, at)) : clampFuzzy(at + dir, s.query.length);
  if (next === at) return at;
  return next;
}

function fuzzyResult(s: AppState, key: KeyEvent): KeyResult {
  let n: AppState = { ...s };
  const list = visibleBookmarks(n);
  const idx = list.findIndex((b) => b.id === n.selectedId);

  if (key.name === "escape") {
    n.fuzzyOpen = false;
    n.query = "";
    n.fuzzyCaret = 0;
    return { next: n, exit: false };
  }
  if (key.name === "return" || key.name === "enter" || key.name === "linefeed") {
    const sel = list[idx >= 0 ? idx : 0];
    n.fuzzyOpen = false;
    n.query = "";
    n.fuzzyCaret = 0;
    if (sel) openUrl(sel.url);
    return { next: n, exit: false };
  }
  if (key.name === "up" || key.name === "k") {
    n = moveSelection(n, -1);
    return { next: n, exit: false };
  }
  if (key.name === "down" || key.name === "j") {
    n = moveSelection(n, 1);
    return { next: n, exit: false };
  }
  if (key.name === "left" || key.name === "right") {
    const word = !!(key.ctrl || key.meta || key.option);
    n = { ...n, fuzzyCaret: fuzzyMoveCaret(n, key.name === "left" ? -1 : 1, word) };
    return { next: n, exit: false };
  }
  if (key.name === "home") {
    n = { ...n, fuzzyCaret: 0 };
    return { next: n, exit: false };
  }
  if (key.name === "end") {
    n = { ...n, fuzzyCaret: n.query.length };
    return { next: n, exit: false };
  }
  if (key.name === "backspace" || key.name === "delete") {
    const word = !!(key.ctrl || key.meta || key.option);
    n = key.name === "backspace" ? fuzzyBackspace(n, word) : fuzzyDelete(n, word);
    return { next: n, exit: false };
  }
  const raw = key.raw ?? "";
  if (isPrintable(key, raw)) {
    n = fuzzyInsert(n, raw);
  }
  return { next: n, exit: false };
}

function browseResult(s: AppState, key: KeyEvent): KeyResult {
  let n: AppState = { ...s };

  switch (key.name) {
    case "a": {
      n.edit = newEdit("add", null);
      return { next: n, exit: false };
    }
    case "e": {
      const target = s.bookmarks.find((b) => b.id === s.selectedId) ?? null;
      if (!target || target.archived) return { next: s, exit: false };
      n.edit = newEdit("edit", target);
      return { next: n, exit: false };
    }
    case "d": {
      const target = s.bookmarks.find((b) => b.id === s.selectedId) ?? null;
      if (!target) return { next: s, exit: false };
      if (s.view === "trash") {
        n.bookmarks = n.bookmarks.filter((b) => b.id !== target.id);
        n.history = [...n.history, { kind: "delete" as const, bookmark: { ...target } }].slice(-UNDO_LIMIT);
        n.selectedId = null;
        n.status = "deleted permanently (trash)";
        return { next: n, exit: false };
      }
      if (target.archived) return { next: s, exit: false };
      n.bookmarks = s.bookmarks.map((b) => (b.id === target.id ? { ...b, archived: true } : b));
      if (n.selectedId === target.id) n.selectedId = null;
      n.history = [...n.history, { kind: "delete" as const, bookmark: { ...target } }].slice(-UNDO_LIMIT);
      return { next: n, exit: false };
    }
    case "/": {
      // The fuzzy search always starts empty; never prefill from the selection.
      n.fuzzyOpen = true;
      n.query = "";
      n.fuzzyCaret = 0;
      return { next: n, exit: false };
    }
    case "A": {
      // Shift+A jumps the sidebar rail selection onto Trash and opens that view.
      const entries = navEntries(s.bookmarks);
      n.tagIndex = entries.length - 1;
      n.view = "trash";
      n.tagFilter = [];
      n.status = null;
      return { next: n, exit: false };
    }
    case "r": {
      const target = s.bookmarks.find((b) => b.id === s.selectedId) ?? null;
      if (!target) {
        n.status = "no bookmark selected";
        return { next: n, exit: false };
      }
      if (s.view !== "trash") {
        n.status = "r restores from trash";
        return { next: n, exit: false };
      }
      n.bookmarks = s.bookmarks.map((b) => (b.id === target.id ? { ...b, archived: false } : b));
      if (n.selectedId === target.id) n.selectedId = null;
      n.history = [...n.history, { kind: "restore" as const, bookmark: { ...target } }].slice(-UNDO_LIMIT);
      n.view = "saved";
      n.status = "restored bookmark";
      return { next: n, exit: false };
    }
    case "q":
      return { next: s, exit: true };
    case "o": {
      const sel = s.bookmarks.find((b) => b.id === s.selectedId) ?? null;
      if (!sel) return { next: s, exit: false };
      openUrl(sel.url);
      return { next: n, exit: false };
    }
    case "s": {
      const mode = nextSortMode(s.sortMode);
      n.sortMode = mode;
      n.status = `sorted by ${sortLabel(mode)}`;
      return { next: n, exit: false };
    }
    case "y": {
      const sel = s.bookmarks.find((b) => b.id === s.selectedId) ?? null;
      if (!sel) {
        n.status = "no bookmark selected";
        return { next: n, exit: false };
      }
      const copied = copyToClipboard(sel.url);
      n.status = copied ? `yanked ${sel.url}` : `copy failed: ${sel.url}`;
      return { next: n, exit: false };
    }
    case "x": {
      const path = defaultExportPath();
      const format = (process.env.URLINK_EXPORT_FORMAT ?? "json") === "csv" ? "csv" : "json";
      exportBookmarks(s.bookmarks, path, format);
      n.status = `exported ${s.bookmarks.length} bookmarks -> ${path}`;
      return { next: n, exit: false };
    }
    case "i": {
      const path = process.env.URLINK_IMPORT || defaultImportPath();
      const format = (process.env.URLINK_IMPORT_FORMAT ?? "json") === "csv" ? "csv" : "json";
      if (!path) {
        n.status = "no import file found";
        return { next: n, exit: false };
      }
      const list = importBookmarks(path, format);
      n.bookmarks = list;
      n.selectedId = null;
      n.status = `imported ${list.length} bookmarks`;
      return { next: n, exit: false };
    }
    case "u": {
      const entry = s.history[s.history.length - 1];
      if (!entry) {
        n.status = "nothing to undo";
        return { next: n, exit: false };
      }
      const rest = s.history.slice(0, -1);
      if (entry.kind === "add") {
        n.bookmarks = s.bookmarks.filter((b) => b.id !== entry.bookmark.id);
      } else {
        n.bookmarks = s.bookmarks.map((b) => (b.id === entry.bookmark.id ? { ...b, ...entry.bookmark } : b));
      }
      n.history = rest;
      n.status = `undid ${entry.kind}`;
      n.selectedId = null;
      return { next: n, exit: false };
    }
    case "?": {
      n.helpOpen = true;
      n.status = null;
      return { next: n, exit: false };
    }
    case "t":
    case "T": {
      return { next: openThemePanel(s), exit: false };
    }
    case "return":
    case "enter": {
      const tag = navEntries(s.bookmarks)[s.tagIndex];
      if (tag === "Trash") {
        n.view = "trash";
        n.tagFilter = [];
        n.status = null;
        return { next: n, exit: false };
      }
      if (!tag) return { next: s, exit: false };
      const has = s.tagFilter.includes(tag);
      const tagFilter = has ? s.tagFilter.filter((t) => t !== tag) : [...s.tagFilter, tag];
      n.tagFilter = tagFilter;
      return { next: n, exit: false };
    }
    case "up":
    case "k": {
      n = moveSelection(n, -1);
      return { next: n, exit: false };
    }
    case "down":
    case "j": {
      n = moveSelection(n, 1);
      return { next: n, exit: false };
    }
    case "home": {
      const list = visibleBookmarks(n);
      n.selectedId = list[0]?.id ?? null;
      return { next: n, exit: false };
    }
    case "end": {
      const list = visibleBookmarks(n);
      n.selectedId = list.length > 0 ? list[list.length - 1]!.id : null;
      return { next: n, exit: false };
    }
    case "h":
    case "left": {
      const entries = navEntries(s.bookmarks);
      const nextTagIndex = Math.max(0, Math.min(entries.length - 1, s.tagIndex - 1));
      if (nextTagIndex === s.tagIndex) return { next: s, exit: false };
      n.tagIndex = nextTagIndex;
      if (entries[nextTagIndex] === "Trash") {
        n.view = "trash";
        n.tagFilter = [];
      } else {
        n.view = "saved";
      }
      return { next: n, exit: false };
    }
    case "l":
    case "right": {
      const entries = navEntries(s.bookmarks);
      const nextTagIndex = Math.max(0, Math.min(entries.length - 1, s.tagIndex + 1));
      if (nextTagIndex === s.tagIndex) return { next: s, exit: false };
      n.tagIndex = nextTagIndex;
      if (entries[nextTagIndex] === "Trash") {
        n.view = "trash";
        n.tagFilter = [];
      } else {
        n.view = "saved";
      }
      return { next: n, exit: false };
    }
    case "space": {
      const tag = navEntries(s.bookmarks)[s.tagIndex];
      if (tag === "Trash") {
        n.view = "trash";
        n.tagFilter = [];
        return { next: n, exit: false };
      }
      if (tag === "All") {
        n.tagFilter = [];
        return { next: n, exit: false };
      }
      if (!tag) return { next: s, exit: false };
      const has = s.tagFilter.includes(tag);
      const tagFilter = has ? s.tagFilter.filter((t) => t !== tag) : [...s.tagFilter, tag];
      n.tagFilter = tagFilter;
      return { next: n, exit: false };
    }
    default:
      return { next: s, exit: false };
  }
}

export function handleKey(s: AppState, key: KeyEvent): KeyResult {
  if (s.helpOpen) {
    if (key.name === "escape") {
      const n: AppState = { ...s, helpOpen: false };
      return { next: n, exit: false };
    }
    return { next: s, exit: false };
  }
  if (s.themeOpen) {
    return themeResult(s, key);
  }
  if (s.edit) {
    return editResult(s, key);
  }
  if (s.fuzzyOpen) {
    return fuzzyResult(s, key);
  }
  const r = browseResult(s, key);
  return { next: r.next, exit: r.exit };
}
