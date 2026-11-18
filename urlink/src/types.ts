export interface Bookmark {
  id: string;
  url: string;
  title: string;
  description: string;
  tags: string[];
  archived: boolean;
  createdAt: number;
}

export type View = "saved" | "trash";
export type SortMode = "name" | "date" | "url";
export type EditSection = "url" | "tags" | "title" | "description";

export type UndoEntry =
  | { kind: "add"; bookmark: Bookmark }
  | { kind: "edit"; bookmark: Bookmark }
  | { kind: "delete"; bookmark: Bookmark }
  | { kind: "restore"; bookmark: Bookmark };

export interface EditState {
  id: string;
  mode: "add" | "edit";
  url: string;
  title: string;
  description: string;
  tagsText: string;
  focus: EditSection;
  error: string | null;
  cursor: number;
  fetching?: boolean;
}

export interface AppState {
  bookmarks: Bookmark[];
  view: View;
  selectedId: string | null;
  tagFilter: string[];
  sortMode: SortMode;
  query: string;
  fuzzyOpen: boolean;
  fuzzyCaret: number;
  helpOpen: boolean;
  themeName: string;
  themeOpen: boolean;
  themeIndex: number;
  edit: EditState | null;
  tagIndex: number;
  status: string | null;
  history: UndoEntry[];
}
