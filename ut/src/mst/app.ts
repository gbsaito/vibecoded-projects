/**
 * Application state.
 *
 * Owns the tabs, the search coordinator, and every mutation. Pure state and
 * behaviour — no rendering, no key parsing. That split is what lets the
 * state and the bindings be unit tested without a terminal.
 */

import {
  adjustRating,
  applySort,
  hitToEntry,
  Kind,
  MAX_RATING,
  Sort,
  Status,
  STATUS_ALL,
  Theme,
  StreamingService,
  streamingUrl,
  streamingSearchUrl,
  nextSort,
  sortLabel,
  statusLabel,
  type Entry,
  type Hit,
} from "./model.ts";
import { execFile } from "node:child_process";
import { Store } from "./store.ts";
import { SearchCoordinator, type SearchState } from "./providers/index.ts";
import { anilist } from "./providers/anilist.ts";

/** Find a direct streaming link for the given service among external links. */
function findStreamingLink(links: { url: string; site: string; type: string }[], service: StreamingService): string | null {
  const needle = service.toLowerCase();
  for (const l of links) {
    const site = (l.site ?? "").toLowerCase();
    const type = (l.type ?? "").toLowerCase();
    if (type !== "streaming") continue;
    const match =
      site.includes(needle) ||
      (needle === "hbomax" && (site.includes("max") || site.includes("hbo"))) ||
      (needle === "amazon" && (site.includes("amazon") || site.includes("prime"))) ||
      (needle === "disney" && site.includes("disney")) ||
      (needle === "crunchyroll" && site.includes("crunchyroll")) ||
      (needle === "hidive" && site.includes("hidive")) ||
      (needle === "hulu" && site.includes("hulu")) ||
      (needle === "netflix" && site.includes("netflix"));
    if (match) {
      // Clean google-redirect URLs (AniList wraps some links).
      const url = l.url;
      try {
        const u = new URL(url);
        if (u.hostname.includes("google.") && u.searchParams.has("url")) {
          return u.searchParams.get("url")!;
        }
      } catch { /* not a URL */ }
      return url;
    }
  }
  return null;
}
import type { SearchCache } from "./cache.ts";
import type { CliRenderer, Renderable } from "@opentui/core";
import { ImageCache } from "./image-cache.ts";
import { CommandPalette, buildAllCommands } from "./command-palette.ts";
import {
  defaultExportPath,
  expandPath,
  mergeEntries,
  readTransferFile,
  writeTransferFile,
  type ImportMode,
} from "./transfer.ts";

export const Tabs = ["Search", ...STATUS_ALL] as const;
export type TabName = (typeof Tabs)[number];

export const isSearchTab = (t: TabName): boolean => t === "Search";

const MESSAGE_MS = 3200;
export const DEBOUNCE_MS = 280;

export class App {
  tabIndex = 0;
  selected = 0;
  hitSel = 0;

  query = "";
  focused = false;

  statusMsg: string | null = null;
  private statusAt = 0;

  showHelp = false;
  nerd = true;

  hits: Hit[] = [];
  searchLoading = false;
  searchStale = false;
  searchErrors: Array<{ provider: string; message: string }> = [];

  /** Trending/top feed shown when the search box is empty. */
  feed: Hit[] = [];
  feedLoading = false;

  pendingStatus: Status = Status.Watchlist;

  sort: Sort = Sort.Added;
  sortDesc = false;
  grid = false;
  compact = false;
  gridPage = 0;

  theme: Theme = Theme.Dark;
  streamingService: StreamingService = StreamingService.Crunchyroll;

  lastTyped = 0;

  onChange: () => void = () => {};

  viewWidth = 80;
  viewHeight = 24;

  readonly search: SearchCoordinator;
  readonly store: Store;
  private readonly searchCache: SearchCache;
  readonly imageCache: ImageCache;

  commandPalette: CommandPalette;

  constructor(store: Store, cache: SearchCache, imageCache: ImageCache, renderer: CliRenderer | null = null, root?: Renderable) {
    this.store = store;
    this.searchCache = cache;
    this.imageCache = imageCache;
    this.search = new SearchCoordinator(cache, (s: SearchState) => this.applySearch(s));
    this.commandPalette = new CommandPalette(renderer, root);
    this.commandPalette.app = this;
    this.commandPalette.setCommands(buildAllCommands(this));
    for (const e of store.entries) {
      if (e.image) void imageCache.ensure(e.image);
      if (e.avgRating === null || !e.image || !e.summary) void this.enrich(e);
    }
    // Load the trending feed for the search tab.
    if (isSearchTab(this.current)) void this.loadFeed();
  }

  get current(): TabName {
    return Tabs[this.tabIndex];
  }

  get currentStatus(): Status | null {
    const t = this.current;
    return isSearchTab(t) ? null : (t as Status);
  }

  // ------------------------------------------------------------------ search

  private applySearch(s: SearchState): void {
    this.hits = s.hits;
    this.searchLoading = s.loading;
    this.searchStale = s.stale;
    this.searchErrors = s.errors;
    if (s.generation === this.search.currentGeneration) {
      if (this.hitSel >= this.hits.length) this.hitSel = Math.max(0, this.hits.length - 1);
    }
    for (const h of s.hits) {
      if (h.image) void this.imageCache.ensure(h.image);
    }
    this.onChange();
  }

  queryChanged(): void {
    this.lastTyped = Date.now();
  }

  async maybeSearch(): Promise<boolean> {
    if (!this.focused || !isSearchTab(this.current)) return false;
    if (Date.now() - this.lastTyped < DEBOUNCE_MS) return false;
    if (!this.query.trim()) {
      await this.loadFeed();
      return true;
    }
    await this.search.start(this.query);
    return true;
  }

  async searchNow(): Promise<void> {
    this.lastTyped = 0;
    if (!this.query.trim()) {
      await this.loadFeed();
      return;
    }
    await this.search.start(this.query);
  }

  /** Load the trending/top feed (shown when the search box is empty). */
  async loadFeed(): Promise<void> {
    if (this.feedLoading) return;
    this.feedLoading = true;
    this.onChange();
    try {
      const { anilist } = await import("./providers/anilist.ts");
      const hits = await anilist.trending(new AbortController().signal, 8000);
      this.feed = hits;
      if (!this.query.trim() && isSearchTab(this.current)) {
        this.hits = hits;
        this.hitSel = 0;
        this.searchStale = false;
        this.searchErrors = [];
      }
    } catch {
      /* feed is optional */
    } finally {
      this.feedLoading = false;
      this.onChange();
    }
  }

  clearQuery(): void {
    this.query = "";
    this.hits = [];
    this.hitSel = 0;
    this.search.invalidate();
    this.lastTyped = 0;
    void this.loadFeed();
  }

  get selectedHit(): Hit | undefined {
    return this.hits[this.hitSel];
  }

  addSelectedHit(): Entry | null {
    const hit = this.selectedHit;
    if (!hit) return null;

    const entry = hitToEntry(hit, this.pendingStatus);
    this.store.upsert(entry);
    this.store.save();
    if (entry.image) void this.imageCache.ensure(entry.image);
    this.notify(`added ${hit.title} to ${statusLabel(this.pendingStatus)}`);
    this.clampSelection();
    return entry;
  }

  async enrich(entry: Entry): Promise<void> {
    const needsEpisodes = !entry.progress || entry.progress.total <= 0;
    const needsRating = entry.avgRating === null;
    const needsImage = !entry.image;
    const needsSummary = !entry.summary;
    const needsLinks = !entry.externalLinks?.length;
    if (!needsEpisodes && !needsRating && !needsImage && !needsSummary && !needsLinks) return;

    let provider = "";
    if (entry.id.startsWith("tvmaze:")) provider = "tvmaze";
    else if (entry.id.startsWith("anilist:")) provider = "anilist";
    else if (entry.provider) provider = entry.provider;
    else if (entry.image?.includes("tvmaze.com")) provider = "tvmaze";
    else if (entry.image?.includes("anilist")) provider = "anilist";

    if (provider === "tvmaze") {
      try {
        const { tvmaze } = await import("./providers/tvmaze.ts");
        const idStr = entry.id.startsWith("tvmaze:") ? entry.id.split(":")[1] : entry.id;
        const num = Number(idStr);
        if (!Number.isFinite(num)) return;
        const full = await tvmaze.fetchShow(num, new AbortController().signal, 9000);
        const cur = this.store.get(entry.id);
        if (!cur) return;
        if (needsEpisodes && full.episodes > 0) cur.progress = { seen: 0, total: full.episodes };
        if (needsImage && full.image) cur.image = full.image;
        if (cur.image) void this.imageCache.ensure(cur.image);
        if (full.avgRating !== null) cur.avgRating = full.avgRating;
        if (full.weight !== null) cur.weight = full.weight;
        if (needsSummary && full.summary) cur.summary = full.summary;
        this.store.save();
      } catch {
        /* metadata is optional */
      }
    } else if (provider === "imdb") {
      // IMDb suggestion only gives title/year/image/cast. Enrich the plot
      // from Wikipedia (single request, unlikely to be rate-limited).
      try {
        const title = entry.title;
        let doc: { title: string; extract?: string; thumbnail?: { source: string } } | null = null;
        for (const cand of [title, `${title} (film)`, `${title} (movie)`]) {
          try {
            const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(cand)}`);
            if (!res.ok) continue;
            const j = await res.json() as { title: string; extract?: string; thumbnail?: { source: string }; description?: string };
            if (j.extract) { doc = j; break; }
          } catch { /* try next */ }
        }
        const cur = this.store.get(entry.id);
        if (!cur || !doc) return;
        if (needsSummary && doc.extract) cur.summary = doc.extract.slice(0, 400);
        if (needsImage && doc.thumbnail?.source) cur.image = doc.thumbnail.source.split("?")[0];
        if (cur.image) void this.imageCache.ensure(cur.image);
        this.store.save();
      } catch {
        /* metadata is optional */
      }
    } else if (provider === "anilist") {
      try {
        const { anilist } = await import("./providers/anilist.ts");
        const num = Number(entry.id.split(":")[1]);
        if (!Number.isFinite(num)) return;
        const full = await anilist.fetchMedia(num, new AbortController().signal, 9000);
        const cur = this.store.get(entry.id);
        if (!cur) return;
        if (needsEpisodes && full.episodes && full.episodes > 0) {
          if (!cur.progress || cur.progress.total <= 0) cur.progress = { seen: 0, total: full.episodes };
        }
        if (needsImage && full.image) cur.image = full.image;
        if (cur.image) void this.imageCache.ensure(cur.image);
        if (full.avgRating !== null) cur.avgRating = full.avgRating;
        if (full.weight !== null) cur.weight = full.weight;
        if (needsSummary && full.summary) cur.summary = full.summary;
        if (full.externalLinks?.length) cur.externalLinks = full.externalLinks;
        this.store.save();
      } catch {
        /* metadata is optional */
      }
    }
  }

  // ------------------------------------------------------------------- views

  visible(): Entry[] {
    const status = this.currentStatus;
    if (status === null) return [];
    const q = this.query.trim().toLowerCase();
    const all = this.store.sorted(status, this.sort, this.sortDesc);
    const filtered = q ? all.filter((e) => e.title.toLowerCase().includes(q)) : all;
    return deduplicateEntries(filtered);
  }

  tabCount(i: number): number {
    const t = Tabs[i];
    if (isSearchTab(t)) return 0;
    return this.store.sorted(t as Status, this.sort, this.sortDesc).length;
  }

  /** Terminal cell height/width in pixels; the UI refreshes it each frame. */
  cellAspectRatio = 2;

  /** Grid cell width derived from the cover aspect (AniList 460x650) and the
   *  terminal font cell, so the poster fills the cell without horizontal
   *  padding and the caption shares the cover's width. */
  gridCellWidth(): number {
    const imageH = GRID_CELL_H - 3;
    const width = imageH * this.cellAspectRatio * (460 / 650);
    return Math.max(8, Math.min(40, Math.round(width)));
  }

  gridColumns(areaWidth: number): number {
    const cellW = this.gridCellWidth();
    const gap = 2;
    return Math.max(1, Math.floor((areaWidth + gap) / (cellW + gap)));
  }

  /** Rows of grid cells that fit in `bodyH` terminal rows. Never pages in a
   *  row that would be clipped off the bottom, so every visible row is whole. */
  gridRows(bodyH: number): number {
    const gap = 2;
    return Math.max(1, Math.min(5, Math.floor((Math.max(0, bodyH) + gap) / (GRID_CELL_H + gap))));
  }

  /** Width of the body (query results) for the current terminal. */
  bodyWidth(): number {
    return this.viewWidth - this.detailWidth(this.viewWidth);
  }

  /** Width of the sidebar/detail pane for a given terminal width.
   *  Scales with the terminal (fraction of w) with min/max bounds, so the
   *  body (query results) and sidebar grow together on zoom. */
  detailWidth(w: number): number {
    const minBodyW = 50;
    if (w < 80) return 0;
    const provisional = Math.floor(w * 0.32);
    const clamped = Math.max(28, Math.min(provisional, 60));
    if (w - clamped < minBodyW) return 0;
    return clamped;
  }

  selectedEntry(): Entry | undefined {
    return this.visible()[this.selected];
  }

  moveSelection(delta: number): void {
    const status = this.currentStatus;
    if (status === null) {
      const n = this.hits.length;
      if (n === 0) return;
      this.hitSel = Math.max(0, Math.min(n - 1, this.hitSel + delta));
      return;
    }
    const n = this.visible().length;
    if (n === 0) return;
    if (!this.grid) {
      // List mode: wrap around (original behaviour).
      this.selected = (this.selected + delta + n) % n;
      return;
    }
    // Grid mode: vertical movement with wrap within the page.
    const bodyW = this.bodyWidth();
    const cols = this.gridColumns(bodyW);
    const rows = this.gridRows(this.viewHeight - 1);
    const perPage = cols * rows;
    const pageStart = this.gridPage * perPage;
    const pageEnd = Math.min(pageStart + perPage, n);
    const pageItems = pageEnd - pageStart;
    if (pageItems === 0) return;
    const posInPage = this.selected - pageStart;
    const col = posInPage % cols;

    if (delta > 0) {
      // down
      const next = this.selected + cols;
      if (next < pageEnd) {
        this.selected = next;
      } else {
        // wrap to top of column
        const topIdx = pageStart + col;
        if (topIdx < pageEnd) this.selected = topIdx;
      }
    } else {
      // up
      const next = this.selected - cols;
      if (next >= pageStart) {
        this.selected = next;
      } else {
        // wrap to bottom of column
        let bottomRow = rows - 1;
        let bottomIdx = pageStart + bottomRow * cols + col;
        while (bottomIdx >= pageEnd) { bottomRow--; bottomIdx = pageStart + bottomRow * cols + col; }
        if (bottomIdx >= pageStart) this.selected = bottomIdx;
      }
    }
  }

  setTab(i: number): void {
    const wasSearch = isSearchTab(this.current);
    this.tabIndex = Math.max(0, Math.min(Tabs.length - 1, i));
    this.selected = 0;
    this.hitSel = 0;
    this.gridPage = 0;
    this.focused = false;
    // Leaving the search tab must drop the query, otherwise it becomes a
    // silent filter on the status tab (and stale hits linger visually).
    if (wasSearch && !isSearchTab(this.current)) this.clearQuery();
    // Returning to the search tab: restore the feed if the query is empty.
    if (!wasSearch && isSearchTab(this.current) && !this.query.trim()) {
      this.hits = this.feed;
      this.hitSel = 0;
      if (this.feed.length === 0 && !this.feedLoading) void this.loadFeed();
    }
    this.clampSelection();
  }

  clampSelection(): void {
    if (this.currentStatus === null) {
      if (this.hitSel >= this.hits.length) this.hitSel = Math.max(0, this.hits.length - 1);
      return;
    }
    const n = this.visible().length;
    if (n === 0) this.selected = 0;
    else if (this.selected >= n) this.selected = n - 1;
  }

  // ---------------------------------------------------------------- mutation

  mutate(fn: (e: Entry) => void): void {
    const e = this.selectedEntry();
    if (!e) return;
    const stored = this.store.get(e.id);
    if (!stored) return;
    fn(stored);
    this.store.save();
    // The edit may have changed a field the active sort is keyed on (rating,
    // remaining), moving the entry. Follow it so the selection stays on the
    // entry the user just edited instead of a fixed index.
    this.selectById(e.id);
  }

  /** Point the selection at the entry with this id, keeping the grid page in
   *  sync. Falls back to clamping when the entry is no longer visible. */
  private selectById(id: string): void {
    const i = this.visible().findIndex((e) => e.id === id);
    if (i < 0) {
      this.clampSelection();
      return;
    }
    this.selected = i;
    if (this.grid) {
      const perPage = this.gridColumns(this.bodyWidth()) * this.gridRows(this.viewHeight - 1);
      if (perPage > 0) this.gridPage = Math.floor(i / perPage);
    }
  }

  deleteSelected(): Entry | undefined {
    const e = this.selectedEntry();
    if (!e) return undefined;
    const removed = this.store.remove(e.id);
    if (removed) {
      this.store.save();
      this.clampSelection();
    }
    return removed;
  }

  rate(dir: "up" | "down"): void {
    const delta = dir === "up" ? 0.5 : -0.5;
    if (this.currentStatus === null) {
      const hit = this.selectedHit;
      if (!hit) return;
      const existing = this.store.get(hit.id);
      const next = adjustRating(existing?.rating ?? null, delta, MAX_RATING);
      const entry = existing ?? hitToEntry(hit, this.pendingStatus);
      entry.rating = next;
      this.store.upsert(entry);
      this.store.save();
      this.notify(`${hit.title}: ${next === null ? "unrated" : `${next}/${MAX_RATING}`}`);
      return;
    }
    this.mutate((e) => {
      e.rating = adjustRating(e.rating, delta, MAX_RATING);
    });
  }

  episode(dir: "up" | "down"): void {
    this.mutate((e) => {
      if (!e.progress) return;
      if (dir === "up") e.progress.seen = Math.min(e.progress.total, e.progress.seen + 1);
      else e.progress.seen = Math.max(0, e.progress.seen - 1);
    });
  }

  setPendingStatus(s: Status): void {
    this.pendingStatus = s;
    this.notify(`Next add files to ${statusLabel(s)}`);
  }

  openCommandPalette(): void {
    this.commandPalette.open(() => {
      this.onChange();
    });
  }

  // ------------------------------------------------------------- import/export

  /** Palette prompt for a JSON export path (pre-filled with a dated name). */
  openExportPrompt(): void {
    this.commandPalette.ask("Export JSON to", defaultExportPath(), (value) => {
      this.exportData(value);
    });
  }

  /** Palette prompt for a JSON import path. */
  openImportPrompt(mode: ImportMode): void {
    const title =
      mode === "merge"
        ? "Merge JSON from"
        : "Replace library from JSON (path)";
    this.commandPalette.ask(title, "", (value) => {
      this.importData(value, mode);
    });
  }

  /** Write the whole library as JSON. Errors land in the status message. */
  exportData(rawPath: string): void {
    try {
      const path = expandPath(rawPath);
      const count = this.store.length;
      writeTransferFile(path, this.store.entries);
      this.notify(
        `exported ${count} ${count === 1 ? "entry" : "entries"} to ${path}`,
      );
    } catch (e) {
      this.notify(`export failed: ${(e as Error).message}`);
    }
    this.onChange();
  }

  /** Load a JSON file into the library, either merging by id or replacing. */
  importData(rawPath: string, mode: ImportMode): void {
    try {
      const path = expandPath(rawPath);
      const file = readTransferFile(path);
      let summary: string;
      if (mode === "merge") {
        const merged = mergeEntries(this.store.entries, file.entries);
        this.store.replaceAll(merged.entries);
        summary = `${merged.added} added, ${merged.updated} updated`;
      } else {
        this.store.replaceAll(file.entries);
        summary = `replaced library with ${file.entries.length}`;
      }
      this.store.save();
      this.adoptEntries();
      const skipped = file.skipped ? `, ${file.skipped} skipped` : "";
      this.notify(
        `imported ${file.entries.length} entries from ${path} (${summary}${skipped})`,
      );
    } catch (e) {
      this.notify(`import failed: ${(e as Error).message}`);
    }
    this.onChange();
  }

  /** Post-import follow-up: posters, missing metadata, and a valid selection. */
  private adoptEntries(): void {
    for (const e of this.store.entries) {
      if (e.image) void this.imageCache.ensure(e.image);
      if (e.avgRating === null || !e.image || !e.summary) void this.enrich(e);
    }
    this.clampSelection();
  }

  toggleNsfw(): void {
    anilist.nsfwEnabled = !anilist.nsfwEnabled;
    this.notify(`NSFW ${anilist.nsfwEnabled ? "enabled" : "disabled"}`);
    if (isSearchTab(this.current) && this.query) void this.searchNow();
    this.onChange();
  }

  setTheme(t: Theme): void {
    this.theme = t;
    this.notify(`Theme set to ${t}`);
    this.onChange();
  }

  setStreamingService(s: StreamingService): void {
    this.streamingService = s;
    this.notify(`Streaming service set to ${s}`);
    this.onChange();
  }

  setStatus(s: Status): void {
    if (this.currentStatus === null) {
      this.pendingStatus = s;
      this.notify(`next add files to ${statusLabel(s)}`);
      return;
    }
    const id = this.selectedEntry()?.id;
    if (id) {
      const e = this.store.get(id);
      if (e) {
        const wasCompleted = e.status === Status.Completed;
        e.status = s;
        if (e.kind === Kind.Series && e.progress) {
          if (s === Status.Completed) {
            e.progress.seen = e.progress.total;
          } else if (wasCompleted) {
            e.progress.seen = 0;
          }
        }
      }
      this.store.save();
    }
    this.clampSelection();
  }

  cycleSort(): void {
    this.sort = nextSort(this.sort);
    this.notify(`sorted by ${sortLabel(this.sort)}`);
  }

  reverseSort(): void {
    this.sortDesc = !this.sortDesc;
    this.notify(`${sortLabel(this.sort)} ${this.sortDesc ? "descending" : "ascending"}`);
  }

  async openStreamingUrl(): Promise<void> {
    const onSearch = isSearchTab(this.current);
    const subject = onSearch ? this.selectedHit : this.selectedEntry();
    const title = subject?.title;
    // Enrich library entries so externalLinks (direct streaming URLs) are
    // populated before opening.
    if (!onSearch && subject && !subject.externalLinks?.length) {
      await this.enrich(subject as Entry);
    }
    const refreshed = onSearch ? this.selectedHit : this.selectedEntry();
    const links = refreshed?.externalLinks ?? subject?.externalLinks ?? [];
    const service = this.streamingService;
    const direct = findStreamingLink(links, service);
    const url = direct ?? (title ? streamingSearchUrl(service, title) : streamingUrl(service));
    this.notify(`opening ${url}`);
    try {
      execFile("xdg-open", [url], () => {});
    } catch {
      /* no browser */
    }
  }

  // ---------------------------------------------------------------- messages

  notify(msg: string): void {
    this.statusMsg = msg;
    this.statusAt = Date.now();
  }

  expireMessage(): void {
    if (this.statusMsg && Date.now() - this.statusAt > MESSAGE_MS) {
      this.statusMsg = null;
    }
  }

  get message(): string | null {
    if (this.searchErrors.length) {
      return `${this.searchErrors.length} provider(s) failed: ${this.searchErrors
        .map((e) => `${e.provider} ${e.message}`)
        .join("; ")}`;
    }
    if (this.searchLoading) return "searching...";
    if (this.searchStale) return "showing cached results (providers unreachable)";
    return this.statusMsg;
  }

  dispose(): void {
    this.search.dispose();
  }
}

export const GRID_CELL_H = 16;

function deduplicateEntries(entries: Entry[]): Entry[] {
  const seen = new Map<string, Entry>();
  for (const e of entries) {
    const key = dedupeEntryKey(e);
    const existing = seen.get(key);
    if (!existing || scoreEntry(e) > scoreEntry(existing)) {
      seen.set(key, e);
    }
  }
  return [...seen.values()];
}

function dedupeEntryKey(e: Entry): string {
  const t = e.title.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return e.year ? `${t}:${e.year}` : t;
}

function scoreEntry(e: Entry): number {
  let s = 0;
  if (e.avgRating !== null) s += 2;
  if (e.weight !== null) s += 1;
  if (e.image !== null) s += 1;
  if (e.summary !== null) s += 1;
  if (e.progress !== null) s += 1;
  if (e.year !== null) s += 1;
  return s;
}
