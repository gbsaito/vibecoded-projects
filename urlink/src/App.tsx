import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { type KeyEvent, type MouseEvent } from "@opentui/core";
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/react";
import { decodePasteBytes, type PasteEvent } from "@opentui/core";
import type { AppState, Bookmark, EditState } from "./types.ts";
import { handleKey, sortLabel } from "./keys.ts";
import { insertEdit, tagSuggestions } from "./editOps.ts";
import { allTags, moveSelection, visibleBookmarks } from "./selectors.ts";
import { getTheme, normalizeThemeName } from "./theme.ts";
import { fetchMetadata, loadBookmarks, loadTheme, saveBookmarks, saveTheme } from "./store.ts";
import { isValidUrl } from "./url.ts";
import { PAD } from "./layout.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { BookmarkList } from "./components/BookmarkList.tsx";
import { EditPanel } from "./components/EditPanel.tsx";
import { HelpPanel } from "./components/HelpPanel.tsx";
import { ThemePanel } from "./components/ThemePanel.tsx";
import { BlinkingCursor } from "./components/BlinkingCursor.tsx";

function initialState(): AppState {
  return {
    bookmarks: loadBookmarks(),
    view: "saved",
    selectedId: null,
    tagFilter: [],
    sortMode: "name",
    query: "",
    fuzzyOpen: false,
    fuzzyCaret: 0,
    helpOpen: false,
    themeName: normalizeThemeName(loadTheme()),
    themeOpen: false,
    themeIndex: 0,
    edit: null,
    tagIndex: 0,
    status: null,
    history: [],
  };
}

export function App() {
  const { width, height } = useTerminalDimensions();
  const [state, setState] = useState<AppState>(initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const firstSave = useRef(true);
  const setStateSafe = (updater: (s: AppState) => AppState) => setState(updater);

  useKeyboard((key: KeyEvent) => {
    const before = stateRef.current;
    const result = handleKey(before, key);
    if (result.next !== before) setStateSafe(() => result.next);
    if (result.exit) {
      process.exit(0);
      return;
    }
    const after = result.next;
    const fromUrl = before.edit && before.edit.focus === "url" ? before.edit : null;
    const toTags = after.edit && after.edit.focus === "tags" ? after.edit : null;
    const shouldFetch = !!toTags && isValidUrl(toTags.url) && (!after.edit || after.edit.mode === "add" || !after.edit.title.trim() || !after.edit.description.trim());
    if (fromUrl && toTags && shouldFetch && isValidUrl(toTags.url)) {
      const url = toTags.url.trim();
      setStateSafe((s) => (s.edit ? { ...s, edit: { ...s.edit, fetching: true, error: null } } : s));
      void (async () => {
        const meta = await fetchMetadata(url);
        setStateSafe((s) => {
          if (!s.edit) return s;
          const nextEdit: EditState = { ...s.edit, fetching: false };
          let out: AppState = { ...s, edit: nextEdit };
          if (nextEdit.focus === "tags") {
            const cur = s.edit;
            const next: EditState = { ...cur, fetching: false };
            if (meta.title && !cur.title.trim()) {
              next.title = meta.title ?? "";
              out = { ...out, edit: next };
            }
            if (meta.description && !cur.description.trim()) {
              next.description = meta.description ?? "";
              out = { ...out, edit: next };
            }
          }
          return out;
        });
      })();
    }
  });

  usePaste((event: PasteEvent) => {
    const text = decodePasteBytes(event.bytes);
    const s = stateRef.current;
    if (!s.edit) return;
    const next = insertEdit(s.edit, text);
    if (next === s.edit) return;
    setStateSafe(() => ({ ...s, edit: next }));
  });

  const theme = getTheme(state.themeName);
  // The rail is one PAD narrower than the base width so the sidebar width
  // matches the one-row gap above the UI, without changing the TUI proportions.
  const sidebarWidth = Math.max(18, Math.min(28, Math.floor(width * 0.2)) - PAD);
  const panelWidth = Math.max(36, Math.min(78, width - 6));
  const baseBookmarks = useMemo(
    () => (state.view === "trash" ? state.bookmarks.filter((b) => b.archived) : state.bookmarks.filter((b) => !b.archived)),
    [state.bookmarks, state.view],
  );
  const tagFilter = useMemo(() => state.tagFilter.filter((t) => baseBookmarks.some((b) => b.tags.includes(t))), [state.tagFilter, baseBookmarks]);
  const bookmarks = useMemo(() => visibleBookmarks({ ...state, tagFilter }), [state.bookmarks, state.view, state.tagFilter, state.query, state.sortMode, tagFilter]);
  const tags = useMemo(() => allTags(baseBookmarks), [baseBookmarks]);

  useEffect(() => {
    if (firstSave.current) {
      firstSave.current = false;
      return;
    }
    saveBookmarks(state.bookmarks);
  }, [state.bookmarks]);

  useEffect(() => {
    saveTheme(state.themeName);
  }, [state.themeName]);

  const moveTag = (dir: number) => {
    setStateSafe((s) => {
      const entries = ["All", ...allTags(s.bookmarks), "Trash"];
      const next = Math.max(0, Math.min(entries.length - 1, s.tagIndex + dir));
      const nextState: AppState = { ...s, tagIndex: next };
      const entry = entries[next];
      if (entry === "Trash") {
        nextState.view = "trash";
        nextState.tagFilter = [];
      } else {
        nextState.view = "saved";
      }
      return nextState;
    });
  };

  const toggleTag = (tag: string) => {
    setStateSafe((s) => {
      if (tag === "Trash") {
        return { ...s, view: "trash", tagFilter: [] };
      }
      if (tag === "All") {
        // Clicking All from the Trash view must return to the saved view.
        return { ...s, view: "saved", tagFilter: [] };
      }
      if (s.tagFilter.includes(tag)) {
        return { ...s, view: "saved", tagFilter: s.tagFilter.filter((t) => t !== tag) };
      }
      return { ...s, view: "saved", tagFilter: [...s.tagFilter, tag] };
    });
  };

  let content: ReactNode;
  if (state.fuzzyOpen) {
    content = (
      <box flexDirection="column" height="100%">
        <box padding={PAD}>
          <text fg={theme.dim}>
            search: {state.query.slice(0, state.fuzzyCaret)}
            <BlinkingCursor theme={theme} resetKey={state.query} />
            {state.query.slice(state.fuzzyCaret)}
          </text>
        </box>
        <box flexGrow={1}>
          <BookmarkList bookmarks={bookmarks} selectedId={state.selectedId} theme={theme} />
        </box>
      </box>
    );
  } else {
    content = <BookmarkList bookmarks={bookmarks} selectedId={state.selectedId} theme={theme} focused={!state.edit && !state.helpOpen && !state.themeOpen} />;
  }

  return (
    <box flexDirection="column" height="100%" width="100%" style={{ backgroundColor: theme.bg }}>
      <box flexDirection="row" height="100%" width="100%">
        <Sidebar
          theme={theme}
          width={sidebarWidth}
          entries={["All", ...tags, "Trash"]}
          tagIndex={state.tagIndex}
          tagFilter={state.tagFilter}
          onMoveTag={moveTag}
          onToggleTag={toggleTag}
        />
        <box flexGrow={1} style={{ padding: PAD }} flexDirection="column">
          <box flexGrow={1} onMouseScroll={(e: MouseEvent) => {
            const dir = e.scroll?.direction;
            if (dir === "down") setStateSafe((s) => moveSelection(s, 1));
            if (dir === "up") setStateSafe((s) => moveSelection(s, -1));
          }}>
            {content}
            {state.edit ? (
              <EditPanel
                edit={state.edit}
                theme={theme}
                width={panelWidth}
                tagSuggest={state.edit.focus === "tags" ? tagSuggestions(state.bookmarks, state.edit) : []}
              />
            ) : null}
            {state.helpOpen ? <HelpPanel theme={theme} width={panelWidth} /> : null}
            {state.themeOpen ? (
              <ThemePanel theme={theme} width={panelWidth} activeName={state.themeName} index={state.themeIndex} />
            ) : null}
          </box>
          <box height={1} flexDirection="row">
            <text flexGrow={1} fg={theme.dim} wrapMode="none">
              {state.status ?? ""}
            </text>
            <text fg={theme.faint}>sort: {sortLabel(state.sortMode)}</text>
          </box>
        </box>
      </box>
    </box>
  );
}
