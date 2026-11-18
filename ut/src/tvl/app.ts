/**
 * Application state.
 *
 * Owns the tabs, the search coordinator, and every mutation. Pure state and
 * behaviour — no rendering, no key parsing. That split is what lets the state
 * and the bindings be unit tested without a terminal.
 */

import {
  adjustRating,
  applySort,
  gameKey,
  hitToGame,
  hoursPlayed,
  MAX_RATING,
  nextSort,
  sortLabel,
  Sort,
  Status,
  STATUS_ALL,
  STATUS_FILTERS,
  statusLabel,
  titleRelevance,
  type Game,
  type Hit,
  type Platform,
  type StatusFilter,
} from "./model.ts";
import { execFile } from "node:child_process";
import { Store } from "./store.ts";
import { gamesToExport, writeExport, type ExportFormat, exportPath } from "./export.ts";
import { SearchCoordinator, scoreHit, type SearchState } from "./providers/index.ts";
import { isLandscapeSteamArt, steam } from "./providers/steam.ts";
import { playstation } from "./providers/playstation.ts";
import {
  applyMc,
  details as mcDetails,
  lookupTitle,
  matchMetacritic,
  search as mcSearch,
  type McHit,
} from "./metacritic.ts";

export const Tabs = ["Search", "Library", "Wishlist"] as const;
export type TabName = (typeof Tabs)[number];

export const isSearchTab = (t: TabName): boolean => t === "Search";
export const isLibraryTab = (t: TabName): boolean => t === "Library";
export const isWishlistTab = (t: TabName): boolean => t === "Wishlist";
export const isBrowseTab = (t: TabName): boolean => !isSearchTab(t);

const MESSAGE_MS = 3200;
export const DEBOUNCE_MS = 280;
const DETAIL_DEBOUNCE_MS = 250;
/** Parallel per-title Metacritic lookups while filling a result list. */
const ENRICH_CONCURRENCY = 6;
/** Background metadata warming: enough to make progress without starving the
 * game the user has selected. */
const METADATA_CONCURRENCY = 3;
/** Covers warmed ahead of the selection; enough for a screen or two. */
const ART_WARM_AHEAD = 24;

export class App {
  tabIndex = 0;
  selected = 0;
  hitSel = 0;

  query = "";
  /** True only while `/` has put the query box in edit mode. */
  focused = false;

  /** Status filter inside the Library and Wishlist tabs. */
  filter: StatusFilter = "All";

  statusMsg: string | null = null;
  private statusAt = 0;

  showHelp = false;

  hits: Hit[] = [];
  searchLoading = false;
  searchStale = false;
  searchErrors: Array<{ provider: string; message: string }> = [];

  pendingStatus: Status = Status.Backlog;

  sort: Sort = Sort.Added;
  sortDesc = false;
  compact = false;
  carousel = false;
  coverPickerOpen = false;
  coverOptions: string[] = [];
  coverCycleIndex = 0;
  coverCycleTitle = "";

  lastTyped = 0;

  onChange: () => void = () => {};
  /** Set by the entry point; opens the command palette. */
  openCommandPalette: () => void = () => {};

  viewWidth = 80;
  viewHeight = 24;

  readonly search: SearchCoordinator;
  readonly store: Store;
  private readonly searchCache: import("./cache.ts").SearchCache;
  readonly imageCache: import("./image-cache.ts").ImageCache;

  private metaAbort: AbortController | null = null;
  private metaGen = 0;
  /** The meta generation whose query-level match has already been applied. */
  private metaAppliedGen = -1;
  /** Hit ids currently being looked up / already attempted this search. */
  private readonly enrichInFlight = new Set<string>();
  private readonly enrichTried = new Set<string>();
  private detailTimer: NodeJS.Timeout | null = null;
  /** One metadata job per stored game, shared by selection and prefetching. */
  private readonly enrichJobs = new Map<string, Promise<void>>();
  private readonly metadataQueue: string[] = [];
  private readonly metadataQueued = new Set<string>();
  private readonly metadataTried = new Set<string>();
  /** IDs whose cover art was already checked against the store. */
  private readonly artFixed = new Set<string>();
  private metadataWorkers = 0;
  private readonly lifecycle = new AbortController();

  constructor(
    store: Store,
    cache: import("./cache.ts").SearchCache,
    imageCache: import("./image-cache.ts").ImageCache,
  ) {
    this.store = store;
    this.searchCache = cache;
    this.imageCache = imageCache;
    this.search = new SearchCoordinator(cache, (s: SearchState) => this.applySearch(s));
  }

  /**
   * Start over with fresh data: the search cache and the downloaded art are
   * both fetched again, and the stored art is looked up again in case a
   * better cover has since been published.
   */
  reloadAll(): void {
    this.searchCache.clear();
    this.imageCache.clear();
    this.search.invalidate();
    this.artFixed.clear();
    this.metadataTried.clear();
    this.metadataQueued.clear();
    this.metadataQueue.length = 0;
    this.notify("reloading…");
    for (const g of this.store.games) {
      this.fixSteamArt(g, true);
      // Background warmth: whatever is on screen is promoted by the draw.
      if (g.image) void this.imageCache.warm(g.image);
    }
    this.onChange();
  }

  get current(): TabName {
    return Tabs[this.tabIndex];
  }

  /** The carousel is a browse view; the Search tab always keeps its list. */
  carouselActive(): boolean {
    return this.carousel && isBrowseTab(this.current);
  }

  // ------------------------------------------------------------------ search

  private applySearch(s: SearchState): void {
    const q = this.query.trim();
    // Storefront titles carry trademark marks and punctuation, so the query
    // is compared against a folded title: "gran turismo 7" must find
    // "Gran Turismo® 7".
    const ranked = [...s.hits].sort(
      (a, b) =>
        titleRelevance(b.title, q) - titleRelevance(a.title, q) ||
        (a.platform === "PC" ? 0 : 1) - (b.platform === "PC" ? 0 : 1) ||
        scoreHit(b) - scoreHit(a) ||
        a.title.localeCompare(b.title),
    );
    this.hits = ranked;
    this.searchLoading = s.loading;
    this.searchStale = s.stale;
    this.searchErrors = s.errors;
    if (s.generation === this.search.currentGeneration) {
      if (this.hitSel >= this.hits.length) this.hitSel = Math.max(0, this.hits.length - 1);
    }
    for (const h of s.hits) {
      if (h.image) void this.imageCache.warm(h.image);
    }
    // New hits (from a slower storefront) still deserve a score, once the
    // query-level match has been folded in.
    if (this.metaAppliedGen === this.metaGen && this.metaAbort) {
      this.enrichHits(this.metaAbort.signal, this.metaGen);
    }
    this.scheduleDetails();
    this.onChange();
  }

  queryChanged(): void {
    this.lastTyped = Date.now();
  }

  async maybeSearch(): Promise<boolean> {
    // The debounce is armed only while typing, so this may safely run after
    // Tab has already left the box (the query still deserves to be searched).
    if (!isSearchTab(this.current)) return false;
    if (Date.now() - this.lastTyped < DEBOUNCE_MS) return false;
    if (!this.query.trim()) return false;
    await this.runSearch(this.query);
    return true;
  }

  async searchNow(): Promise<void> {
    this.lastTyped = 0;
    if (!this.query.trim()) return;
    await this.runSearch(this.query);
  }

  /**
   * Run the storefront search and, in parallel, look the query up in
   * Metacritic. The storefront hits render first; metadata is folded in when
   * the lookup returns, so a slow or blocked Metacritic never hides results.
   */
  private async runSearch(query: string): Promise<void> {
    const q = query.trim();
    this.metaAbort?.abort();
    const abort = new AbortController();
    this.metaAbort = abort;
    const gen = ++this.metaGen;
    this.metaAppliedGen = -1;
    this.enrichInFlight.clear();
    this.enrichTried.clear();
    // A fresh search defaults to Backlog; an earlier choice must not leak in.
    this.pendingStatus = Status.Backlog;

    // Fold in the query-level match and start per-title lookups as soon as the
    // Metacritic lookup returns. Waiting for the slowest storefront would leave
    // the score column blank for seconds.
    const meta = q ? mcSearch(q, abort.signal, 8000).catch(() => []) : Promise.resolve([]);
    void meta.then((results) => {
      if (gen !== this.metaGen) return;
      if (this.query.trim() !== q || !isSearchTab(this.current)) return;
      this.applyMetadata(results);
      this.metaAppliedGen = gen;
      this.enrichHits(abort.signal, gen);
    });

    await this.search.start(query);
  }

  /** Fold Metacritic matches into the current hit list. */
  private applyMetadata(results: Awaited<ReturnType<typeof mcSearch>>): void {
    if (!results.length) return;
    for (const hit of this.hits) {
      const mc = matchMetacritic(hit.title, hit.year, results);
      if (!mc) continue;
      applyMc(hit, mc);
      if (hit.image) void this.imageCache.warm(hit.image);
    }
    this.scheduleDetails();
    this.onChange();
  }

  /**
   * Look a hit up on Metacritic by its own title and fold the match in. Cheap
   * because `mcSearch` caches, and shared by the background pass and the
   * highlighted-result details fetch.
   */
  private async lookupHit(hit: Hit, signal: AbortSignal): Promise<McHit | null> {
    const term = lookupTitle(hit.title) || hit.title;
    const results = await mcSearch(term, signal, 8000);
    const mc =
      matchMetacritic(hit.title, hit.year, results) ?? matchMetacritic(term, hit.year, results);
    if (!mc) return null;
    applyMc(hit, mc);
    if (hit.image) void this.imageCache.ensure(hit.image);
    this.onChange();
    return mc;
  }

  /**
   * Fill in Metacritic data for results that the query-level match missed. A
   * specific query matches directly; a broad one (e.g. "nintendo") returns
   * titles Metacritic never listed, so each remaining hit is looked up by its
   * own title, several at a time, and the list fills in as the answers arrive.
   * Safe to call as results stream in: ids already in flight or already tried
   * this search are skipped.
   */
  private enrichHits(signal: AbortSignal, gen: number): void {
    const targets = this.hits
      .filter(
        (h) => h.metacritic === null && !this.enrichInFlight.has(h.id) && !this.enrichTried.has(h.id),
      )
      .slice(0, 60);
    if (!targets.length) return;
    for (const h of targets) this.enrichInFlight.add(h.id);

    let next = 0;
    const worker = async () => {
      for (;;) {
        const hit = targets[next++];
        if (!hit) return;
        if (signal.aborted || gen !== this.metaGen) return;
        try {
          await this.lookupHit(hit, signal);
        } catch {
          /* metadata is optional */
        } finally {
          this.enrichInFlight.delete(hit.id);
          this.enrichTried.add(hit.id);
        }
      }
    };
    const n = Math.min(ENRICH_CONCURRENCY, targets.length);
    void Promise.all(Array.from({ length: n }, () => worker()));
  }

  clearQuery(): void {
    this.query = "";
    this.search.invalidate();
    this.metaGen++;
    this.metaAbort?.abort();
    this.metaAbort = null;
    this.lastTyped = 0;
    this.hits = [];
    this.hitSel = 0;
    this.scheduleDetails();
  }

  get selectedHit(): Hit | undefined {
    return this.hits[this.hitSel];
  }

  /** Add the highlighted search result to the library. */
  addSelectedHit(): Game | null {
    const hit = this.selectedHit;
    if (!hit) return null;

    // Search still lists games already tracked, but adding one must not create
    // a second copy in the library or steal it from the wishlist.
    const existing = this.store.findMatch(hit);
    if (existing) {
      this.notify(
        `${existing.title} is already in your ${existing.wishlist ? "wishlist" : "library"}`,
      );
      return null;
    }

    const game = hitToGame(hit, this.pendingStatus);
    this.store.upsert(game);
    this.store.save();

    // For Steam games, find the best working art URL. Apps created recently
    // only have hashed asset paths, so the classic CDN guess is often dead.
    if (game.id.startsWith("steam:") && game.image) {
      const appId = game.id.replace(/^steam:/, "");
      void (async () => {
        try {
          const { resolveSteamArt } = await import("./providers/steam.ts");
          const url = await resolveSteamArt(appId, this.lifecycle.signal, undefined, game.title);
          if (url && url !== game.image) {
            game.image = url;
            this.store.save();
            void this.imageCache.ensure(url);
            this.onChange();
          } else if (game.image) {
            void this.imageCache.ensure(game.image);
          }
        } catch {
          /* keep the original URL */
        }
      })();
    } else if (game.image) {
      void this.imageCache.ensure(game.image);
    }

    this.notify(`added ${hit.title} to ${statusLabel(this.pendingStatus)}`);
    this.clampSelection();
    void this.enrich(game);
    return game;
  }

  /** Add the highlighted result to the wishlist, or toggle an existing entry. */
  toggleWishlist(): void {
    if (isSearchTab(this.current)) {
      const hit = this.selectedHit;
      if (!hit) return;
      const existing = this.store.findMatch(hit);
      if (existing) {
        existing.wishlist = !existing.wishlist;
        // Wishlist entries do not keep library progress/status.
        if (existing.wishlist) existing.status = Status.Backlog;
        this.store.save();
        this.notify(existing.wishlist ? `${existing.title} → wishlist` : `${existing.title} → library`);
      } else {
        const game = hitToGame(hit, Status.Backlog);
        game.wishlist = true;
        this.store.upsert(game);
        this.store.save();

        // For Steam games, find the best working art URL.
        if (game.id.startsWith("steam:") && game.image) {
          const appId = game.id.replace(/^steam:/, "");
          void (async () => {
            try {
              const { resolveSteamArt } = await import("./providers/steam.ts");
              const url = await resolveSteamArt(appId, this.lifecycle.signal, undefined, game.title);
              if (url && url !== game.image) {
                game.image = url;
                this.store.save();
                void this.imageCache.ensure(url);
                this.onChange();
              } else if (game.image) {
                void this.imageCache.ensure(game.image);
              }
            } catch {
              /* keep the original URL */
            }
          })();
        } else if (game.image) {
          void this.imageCache.ensure(game.image);
        }

        this.notify(`added ${hit.title} to wishlist`);
      }
      return;
    }

    const game = this.selectedGame();
    if (!game) return;
    const stored = this.store.get(game.id);
    if (!stored) return;
    stored.wishlist = !stored.wishlist;
    // Moving a tracked game to the wishlist drops its library status; a
    // wishlist entry is not "played" or "abandoned".
    if (stored.wishlist) stored.status = Status.Backlog;
    this.store.save();
    this.notify(stored.wishlist ? `${stored.title} → wishlist` : `${stored.title} → library`);
    this.clampSelection();
    this.scheduleDetails();
  }

  /** Toggle the separate "100%" marker, marking the game played when needed. */
  toggleHundred(): void {
    if (!isBrowseTab(this.current)) return;
    this.mutate((g) => {
      g.hundredPercent = !g.hundredPercent;
      if (g.hundredPercent && g.status !== Status.Played) g.status = Status.Played;
    });
    const g = this.selectedGame();
    if (g) {
      const stored = this.store.get(g.id);
      this.notify(`${g.title}: ${stored?.hundredPercent ? "100%" : "not 100%"}`);
    }
    this.clampSelection();
  }

  /** Cycle the platform a game was played on. */
  cyclePlatform(): void {
    if (!isBrowseTab(this.current)) return;
    this.mutate((g) => {
      g.platform = nextPlatform(g.platform);
    });
  }

  /**
   * Fill in details the search result did not carry. One job per game, so the
   * selected game and the background warmer never fetch the same metadata
   * twice.
   */
  async enrich(game: Game): Promise<void> {
    const running = this.enrichJobs.get(game.id);
    if (running) return running;
    const job = this.enrichInternal(game).finally(() => {
      this.enrichJobs.delete(game.id);
    });
    this.enrichJobs.set(game.id, job);
    return job;
  }

  private async enrichInternal(game: Game): Promise<void> {
    const signal = this.lifecycle.signal;
    const cur = this.store.get(game.id);
    if (!cur) return;

    // A game added before the art resolver existed still points at the dead
    // classic CDN path. Repair it before anything else.
    this.fixSteamArt(cur);

    const needsSteam =
      cur.sources.includes("steam") &&
      (!cur.summary ||
        !cur.genres.length ||
        !cur.developers.length ||
        !cur.publishers.length ||
        cur.metacritic === null);
    const needsPs =
      cur.sources.includes("playstation") && (!cur.summary || !cur.genres.length);

    if (needsSteam) {
      const appId = cur.id.replace(/^steam:/, "");
      try {
        const d = await steam.details(appId, signal);
        const stored = this.store.get(cur.id);
        if (stored && d) {
          mergeDetails(stored, d);
          this.store.save();
        }
      } catch {
        /* metadata is optional */
      }
    }

    if (needsPs) {
      const productId = cur.id.replace(/^ps:/, "");
      try {
        const d = await playstation.details(productId, signal);
        const stored = this.store.get(cur.id);
        if (stored && d) {
          mergeDetails(stored, d);
          this.store.save();
        }
      } catch {
        /* metadata is optional */
      }
    }

    await this.enrichWithMetacritic(game);
    if (!signal.aborted) this.onChange();
  }

  /** Resolve Metacritic metadata for a stored game (one or two requests). */
  private async enrichWithMetacritic(game: Game): Promise<void> {
    const cur = this.store.get(game.id);
    if (!cur) return;
    const missing =
      !cur.developers.length ||
      !cur.publishers.length ||
      cur.metacritic === null ||
      !cur.genres.length ||
      !cur.image ||
      !cur.summary;
    if (!missing) return;

    const signal = this.lifecycle.signal;
    try {
      let slug = cur.metacriticSlug;
      if (!slug) {
        const results = await mcSearch(cur.title, signal, 8000);
        const match = matchMetacritic(cur.title, cur.year, results);
        if (!match) return;
        slug = match.slug;
        const stored = this.store.get(game.id);
        if (stored) {
          stored.metacriticSlug = slug;
          stored.metacritic = stored.metacritic ?? match.metacritic;
          stored.platformsAvailable = stored.platformsAvailable.length
            ? stored.platformsAvailable
            : match.platforms;
          stored.genres = stored.genres.length ? stored.genres : match.genres;
          stored.summary = stored.summary ?? match.summary;
          stored.image = stored.image ?? match.image;
        }
      }
      const d = await mcDetails(slug, signal, 8000);
      const stored = this.store.get(game.id);
      if (stored && d) {
        stored.developers = d.developers.length ? d.developers : stored.developers;
        stored.publishers = d.publishers.length ? d.publishers : stored.publishers;
        stored.metacritic = d.metacritic ?? stored.metacritic;
        stored.platformsAvailable = d.platforms.length
          ? d.platforms
          : stored.platformsAvailable;
        stored.genres = stored.genres.length ? stored.genres : d.genres;
        stored.summary = stored.summary ?? d.summary;
        if (d.image) stored.image = stored.image ?? d.image;
        if (d.year) stored.year = stored.year ?? d.year;
      }
      this.store.save();
    } catch {
      /* metadata is optional */
    }
  }

  /** Highlighted search result: one game-page fetch, cached by Metacritic. */
  private async ensureHitDetails(): Promise<void> {
    const hit = this.selectedHit;
    if (!hit) return;
    this.fixSteamArt(hit);
    if (hit.developers.length && hit.publishers.length && hit.metacritic !== null) return;

    const signal = new AbortController().signal;
    // A query-level match may not have reached this hit; resolve it by title.
    if (!hit.metacriticSlug) {
      const mc = await this.lookupHit(hit, signal);
      if (!mc) return;
    }
    const slug = hit.metacriticSlug;
    if (!slug) return;

    try {
      const d = await mcDetails(slug, signal, 8000);
      if (!d) return;
      hit.developers = d.developers.length ? d.developers : hit.developers;
      hit.publishers = d.publishers.length ? d.publishers : hit.publishers;
      hit.metacritic = d.metacritic ?? hit.metacritic;
      hit.platformsAvailable = d.platforms.length ? d.platforms : hit.platformsAvailable;
      hit.genres = hit.genres.length ? hit.genres : d.genres;
      hit.summary = hit.summary ?? d.summary;
      if (d.image) hit.image = hit.image ?? d.image;
      if (hit.image) void this.imageCache.ensure(hit.image);
      this.onChange();
    } catch {
      /* metadata is optional */
    }
  }

  /** Selected library/wishlist game: fill missing metadata immediately. */
  private async ensureGameDetails(): Promise<void> {
    const game = this.selectedGame();
    if (!game) return;
    this.fixSteamArt(game);
    await this.enrich(game);
  }

  /**
   * Repair the cover art of a Steam game that shows a landscape picture.
   *
   * Two things go wrong: the classic CDN URL is dead for apps created
   * recently (the game shows no cover at all), and the store's own capsule is
   * landscape (the game shows a wide cover in a portrait cell). Both are
   * replaced with a real portrait cover.
   */
  private fixSteamArt(subject: Hit | Game, force = false): void {
    if (!subject.id.startsWith("steam:")) return;
    if (!subject.image) return;
    if (this.artFixed.has(subject.id)) return;
    this.artFixed.add(subject.id);

    const appId = subject.id.replace(/^steam:/, "");
    void (async () => {
      try {
        const { resolveSteamArt, isLandscapeSteamArt } = await import("./providers/steam.ts");
        // A portrait cover is already right; nothing to look up. A forced
        // reload looks it up anyway, in case a better cover has been published.
        if (!force && !isLandscapeSteamArt(subject.image)) return;
        const url = await resolveSteamArt(appId, this.lifecycle.signal, undefined, subject.title);
        if (!url || url === subject.image) return;
        subject.image = url;
        if ("status" in subject) this.store.save();
        void this.imageCache.ensure(url);
        this.onChange();
      } catch {
        /* keep the old URL */
      }
    })();
  }

  /** Whether a stored game is missing anything the detail views show. */
  private needsMetadata(g: Game): boolean {
    const steam =
      g.sources.includes("steam") &&
      (!g.summary ||
        !g.genres.length ||
        !g.developers.length ||
        !g.publishers.length ||
        g.metacritic === null);
    const ps = g.sources.includes("playstation") && (!g.summary || !g.genres.length);
    const mc =
      !g.developers.length ||
      !g.publishers.length ||
      g.metacritic === null ||
      !g.genres.length ||
      !g.image ||
      !g.summary;
    return steam || ps || mc || this.needsArtCheck(g);
  }

  /**
   * Whether the cover art is a Steam URL that is dead or landscape, and so
   * has to be looked up again.
   */
  private needsArtCheck(g: Game): boolean {
    if (!g.id.startsWith("steam:")) return false;
    if (this.artFixed.has(g.id)) return false;
    if (!g.image) return false;
    return isLandscapeSteamArt(g.image);
  }

  /**
   * Warm metadata and art for the games in the open list, starting with the
   * selection. Looks are bounded so the selected game is never stuck behind a
   * mass import.
   */
  private prefetchMetadata(): void {
    if (!isBrowseTab(this.current)) return;
    const items = this.visible();
    if (!items.length) return;

    const start = Math.max(0, Math.min(this.selected, items.length - 1));
    const ordered = [...items.slice(start), ...items.slice(0, start)];
    for (let i = 0; i < ordered.length; i++) {
      const g = ordered[i];
      // Only the art that can reach the screen soon is warmed. Warming the
      // whole library means reading every cached cover from disk at once,
      // which stalls the UI on a slow machine and on a large library.
      if (i < ART_WARM_AHEAD && g.image) void this.imageCache.warm(g.image);
      if (
        this.needsMetadata(g) &&
        !this.metadataQueued.has(g.id) &&
        !this.enrichJobs.has(g.id) &&
        !this.metadataTried.has(g.id)
      ) {
        this.metadataQueued.add(g.id);
        this.metadataQueue.push(g.id);
      }
    }
    this.pumpMetadata();
  }

  private pumpMetadata(): void {
    if (this.lifecycle.signal.aborted) return;
    while (this.metadataWorkers < METADATA_CONCURRENCY) {
      const id = this.metadataQueue.shift();
      if (id === undefined) break;
      this.metadataQueued.delete(id);

      const game = this.store.get(id);
      if (!game) continue;
      if (this.enrichJobs.has(id)) continue; // the selected game got there first

      this.metadataWorkers++;
      void this.enrich(game)
        .catch(() => {})
        .finally(() => {
          this.metadataWorkers--;
          if (!this.lifecycle.signal.aborted) {
            this.metadataTried.add(id);
            const updated = this.store.get(id);
            if (updated?.image) void this.imageCache.warm(updated.image);
          }
          this.pumpMetadata();
        });
    }
  }

  private scheduleDetails(): void {
    if (this.detailTimer) clearTimeout(this.detailTimer);
    this.detailTimer = setTimeout(() => {
      this.detailTimer = null;
      if (isSearchTab(this.current)) void this.ensureHitDetails();
      else void this.ensureGameDetails();
    }, DETAIL_DEBOUNCE_MS);
  }

  // ------------------------------------------------------------------- views

  /** Last computed filtered/sorted list, keyed by everything it depends on. */
  private visibleCache: { key: string; games: Game[] } | null = null;

  visible(): Game[] {
    if (!isBrowseTab(this.current)) return [];
    // The carousel redraws on every animation frame, and each draw asks for
    // this list. Building it means scanning the whole library (and sorting),
    // so it is computed once per change rather than once per frame.
    const key = `${this.tabIndex}\u0000${this.filter}\u0000${this.query}\u0000${this.sort}\u0000${this.sortDesc}\u0000${this.store.revision}\u0000${this.store.games.length}`;
    if (this.visibleCache?.key === key) return this.visibleCache.games;

    const wantWishlist = isWishlistTab(this.current);
    let all = this.store.games.filter((g) => g.wishlist === wantWishlist);
    // Status is a library concept. Wishlist entries have no library status and
    // are not hidden by a filter left over from the library tab.
    if (!wantWishlist && this.filter !== "All") {
      all = all.filter((g) => g.status === this.filter);
    }
    const q = this.query.trim().toLowerCase();
    if (q) all = all.filter((g) => g.title.toLowerCase().includes(q));
    const games = deduplicateGames(applySort(all, this.sort, this.sortDesc));
    this.visibleCache = { key, games };
    return games;
  }

  tabCount(i: number): number {
    const t = Tabs[i];
    if (isSearchTab(t)) return this.hits.length;
    const wantWishlist = isWishlistTab(t);
    return this.store.games.filter((g) => g.wishlist === wantWishlist).length;
  }

  get filterLabel(): string {
    return this.filter === "All" ? "all" : statusLabel(this.filter);
  }

  cycleFilter(): void {
    if (!isBrowseTab(this.current)) return;
    // Wishlist entries are not in a library status bucket.
    if (isWishlistTab(this.current)) return;
    const i = STATUS_FILTERS.indexOf(this.filter);
    this.filter = STATUS_FILTERS[(i + 1) % STATUS_FILTERS.length];
    this.selected = 0;
    this.notify(`filter: ${this.filterLabel}`);
    this.scheduleDetails();
  }

  /** Cycle the browse view: list → carousel → list. */
  cycleView(): void {
    if (!isBrowseTab(this.current)) return;
    if (this.compact) this.compact = false;
    else if (!this.carousel) this.carousel = true;
    else this.carousel = false;
    this.selected = 0;
    this.scheduleDetails();
    this.prefetchMetadata();
  }

  /** Terminal cell height/width in pixels; the UI refreshes it each frame. */
  cellAspectRatio = 2;

  bodyWidth(): number {
    return this.viewWidth - this.detailWidth(this.viewWidth);
  }

  /** Width of the sidebar/detail pane for a given terminal width. */
  detailWidth(w: number): number {
    const minBodyW = 50;
    if (w < 80) return 0;
    const provisional = Math.floor(w * 0.32);
    const clamped = Math.max(28, Math.min(provisional, 60));
    if (w - clamped < minBodyW) return 0;
    return clamped;
  }

  selectedGame(): Game | undefined {
    return this.visible()[this.selected];
  }

  /** Follow the carousel's continuous stick target without restarting it. */
  selectCarouselIndex(index: number): void {
    const n = this.visible().length;
    if (n === 0) return;
    const next = Math.max(0, Math.min(n - 1, Math.round(index)));
    if (next === this.selected) return;
    this.selected = next;
    this.scheduleDetails();
  }

  moveSelection(delta: number): void {
    if (isSearchTab(this.current)) {      const n = this.hits.length;
      if (n === 0) return;
      this.hitSel = Math.max(0, Math.min(n - 1, this.hitSel + delta));
      this.scheduleDetails();
      return;
    }
    const n = this.visible().length;
    if (n === 0) return;
    if (this.carousel) {
      // A carousel is a position in a library, not a ring: stop at the ends.
      this.selected = Math.max(0, Math.min(n - 1, this.selected + delta));
      this.scheduleDetails();
      return;
    }
    this.selected = (this.selected + delta + n) % n;
    this.scheduleDetails();
  }

  setTab(i: number): void {
    const wasSearch = isSearchTab(this.current);
    this.tabIndex = Math.max(0, Math.min(Tabs.length - 1, i));
    this.selected = 0;
    this.hitSel = 0;
    this.filter = "All";
    // Tabs open in browse mode; `/` enters the query box.
    this.focused = false;
    // Leaving the search tab must drop the query, otherwise it becomes a
    // silent filter on the library tab (and stale hits linger visually).
    if (wasSearch && !isSearchTab(this.current)) this.clearQuery();
    this.clampSelection();
    this.scheduleDetails();
    this.prefetchMetadata();
  }

  clampSelection(): void {
    if (isSearchTab(this.current)) {
      if (this.hitSel >= this.hits.length) this.hitSel = Math.max(0, this.hits.length - 1);
      return;
    }
    const n = this.visible().length;
    if (n === 0) this.selected = 0;
    else if (this.selected >= n) this.selected = n - 1;
  }

  // ---------------------------------------------------------------- mutation

  mutate(fn: (g: Game) => void): void {
    const g = this.selectedGame();
    if (!g) return;
    const stored = this.store.get(g.id);
    if (!stored) return;
    fn(stored);
    this.store.save();
  }

  deleteSelected(): Game | undefined {
    const g = this.selectedGame();
    if (!g) return undefined;
    const removed = this.store.remove(g.id);
    if (removed) {
      this.store.save();
      this.clampSelection();
    }
    return removed;
  }

  /**
   * Write the stored library out to a portable file. JSON is the canonical,
   * reloadable format; CSV is the spreadsheet-friendly second opinion. The file
   * lands in the export dir with a timestamped name.
   */
  exportLibrary(format: ExportFormat): void {
    const games = [...this.store.games];
    const contents = gamesToExport(games, format);
    const path = exportPath(format);
    writeExport(path, contents);
    this.notify(`exported ${games.length} games to ${path}`);
  }

  rate(dir: "up" | "down"): void {
    const delta = dir === "up" ? 0.5 : -0.5;
    if (isSearchTab(this.current)) {
      const hit = this.selectedHit;
      if (!hit) return;
      const existing = this.store.findMatch(hit);
      const next = adjustRating(existing?.rating ?? null, delta, MAX_RATING);
      const game = existing ?? hitToGame(hit, this.pendingStatus);
      game.rating = next;
      this.store.upsert(game);
      this.store.save();
      this.notify(`${hit.title}: ${next === null ? "unrated" : `${next}/${MAX_RATING}`}`);
      return;
    }
    this.mutate((g) => {
      g.rating = adjustRating(g.rating, delta, MAX_RATING);
    });
  }

  /** Log playtime in half-hour steps. */
  playtime(dir: "up" | "down"): void {
    const delta = dir === "up" ? 0.5 : -0.5;
    this.mutate((g) => {
      const next = Math.max(0, Math.round(((g.playtime?.hours ?? 0) + delta) * 2) / 2);
      g.playtime = next > 0 ? { hours: next } : null;
    });
  }

  setPendingStatus(s: Status): void {
    this.pendingStatus = s;
    this.notify(`Next add files to ${statusLabel(s)}`);
  }

  cycleSort(): void {
    this.sort = nextSort(this.sort);
    this.notify(`sorted by ${sortLabel(this.sort)}`);
  }

  reverseSort(): void {
    this.sortDesc = !this.sortDesc;
    this.notify(`${sortLabel(this.sort)} ${this.sortDesc ? "descending" : "ascending"}`);
  }

  setStatus(s: Status): void {
    if (isSearchTab(this.current)) {
      // A search result is filed as backlog/playing/played. "Abandoned" is a
      // library decision, and its keys (a/d) read as add/delete, so they must
      // not silently send the next add there.
      if (s === Status.Abandoned) return;
      this.pendingStatus = s;
      this.notify(`next add files to ${statusLabel(s)}`);
      return;
    }
    // Wishlist entries are not tracked in a library status bucket.
    if (isWishlistTab(this.current)) return;
    const id = this.selectedGame()?.id;
    if (id) {
      const g = this.store.get(id);
      if (g) {
        g.status = s;
        // Moving to "played" logs a nominal hour so the entry is not blank.
        if (s === Status.Played && !g.playtime) g.playtime = { hours: 1 };
        if (s === Status.Played) this.notify(`${g.title}: played`);
      }
      this.store.save();
    }
    this.clampSelection();
  }

  /** Open the store page for the selected game. */
  openStorePage(): void {
    const g = isSearchTab(this.current) ? null : this.selectedGame();
    const url = g?.url ?? (isSearchTab(this.current) ? this.selectedHit?.url : null);
    if (!url) {
      this.notify("no store page for this entry");
      return;
    }
    this.notify(`opening ${url}`);
    try {
      execFile("xdg-open", [url], () => {});
    } catch {
      /* no browser */
    }
  }

  /** Refresh cover art from SteamGridDB (prefers vertical 600x900 grids). */
  async refreshCoverArt(): Promise<void> {
    const game = isSearchTab(this.current) ? null : this.selectedGame();
    const hit = isSearchTab(this.current) ? this.selectedHit : null;
    const title = game?.title ?? hit?.title;
    const appId = game?.id?.replace(/^steam:/, "") ?? hit?.id?.replace(/^steam:/, "");

    if (!title || !appId) {
      this.notify("select a Steam game to refresh its cover");
      return;
    }

    this.notify(`fetching cover for ${title}…`);
    const signal = this.lifecycle.signal;

    try {
      const { steam } = await import("./providers/steam.ts");
      const url = await steam.fetchGridDbCover(appId, title, signal);
      if (!url) {
        this.notify(`no alternative cover found for ${title}`);
        return;
      }

      const target = game ?? hit;
      if (!target) return;

      if (game) {
        game.image = url;
        this.store.save();
      } else if (hit) {
        hit.image = url;
      }
      if (target.image) void this.imageCache.ensure(target.image);
      this.notify(`cover updated for ${title}`);
      this.onChange();
    } catch {
      this.notify(`failed to fetch cover for ${title}`);
    }
  }

  /** Cycle through available SteamGridDB covers for the selected game. */
  async cycleCoverArt(): Promise<void> {
    const game = isSearchTab(this.current) ? null : this.selectedGame();
    const title = game?.title ?? this.selectedHit?.title;
    if (!title) {
      this.notify("select a game to cycle covers");
      return;
    }
    if (this.coverCycleTitle !== title) {
      this.coverOptions = [];
      this.coverCycleIndex = 0;
      this.coverCycleTitle = title;
    }
    if (!this.coverOptions.length) {
      this.notify(`loading covers for ${title}…`);
      try {
        const { steam } = await import("./providers/steam.ts");
        const urls = await steam.listGridDbCovers(title, this.lifecycle.signal);
        if (!urls.length) {
          this.notify(`no covers found for ${title}`);
          return;
        }
        this.coverOptions = urls;
        if (game?.image && !this.coverOptions.includes(game.image)) {
          this.coverOptions.unshift(game.image);
        }
        this.coverCycleIndex = 0;
      } catch {
        this.notify(`failed to load covers for ${title}`);
        return;
      }
    }
    const url = this.coverOptions[this.coverCycleIndex % this.coverOptions.length];
    this.coverCycleIndex = (this.coverCycleIndex + 1) % this.coverOptions.length;
    const target = game ?? this.selectedHit;
    if (!target) return;
    target.image = url;
    if (game) this.store.save();
    void this.imageCache.ensure(url);
    this.notify(`cover ${this.coverCycleIndex}/${this.coverOptions.length}`);
    this.onChange();
  }

  /** Open a picker of vertical SteamGridDB covers for the selected game. */
  async openCoverPicker(): Promise<void> {
    const game = isSearchTab(this.current) ? null : this.selectedGame();
    const title = game?.title ?? this.selectedHit?.title;
    if (!title) {
      this.notify("select a game to pick a cover");
      return;
    }
    this.notify(`loading covers for ${title}…`);
    try {
      const { steam } = await import("./providers/steam.ts");
      const urls = await steam.listGridDbCovers(title, this.lifecycle.signal);
      if (!urls.length) {
        this.notify(`no covers found for ${title}`);
        return;
      }
      this.coverOptions = urls;
      this.coverPickerOpen = true;
      this.onChange();
    } catch {
      this.notify(`failed to load covers for ${title}`);
    }
  }

  /** Choose a cover from the picker by 1-based index. */
  chooseCover(index: number): void {
    this.notify(`cover pick ${index}`);
    const url = this.coverOptions[index - 1];
    if (!url) return;
    const game = isSearchTab(this.current) ? null : this.selectedGame();
    const hit = isSearchTab(this.current) ? this.selectedHit : null;
    const target = game ?? hit;
    if (!target) return;
    target.image = url;
    if (game) this.store.save();
    void this.imageCache.ensure(url);
    this.coverPickerOpen = false;
    this.coverOptions = [];
    this.notify(`cover updated`);
    this.onChange();
  }

  closeCoverPicker(): void {
    this.coverPickerOpen = false;
    this.coverOptions = [];
    this.onChange();
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
      return `${this.searchErrors.length} source(s) failed: ${this.searchErrors
        .map((e) => `${e.provider} ${e.message}`)
        .join("; ")}`;
    }
    return this.statusMsg;
  }

  dispose(): void {
    if (this.detailTimer) clearTimeout(this.detailTimer);
    this.detailTimer = null;
    this.lifecycle.abort();
    this.metadataQueue.length = 0;
    this.metadataQueued.clear();
    this.metaAbort?.abort();
    this.search.dispose();
  }
}

function nextPlatform(p: Platform | null): Platform | null {
  const order: Array<Platform | null> = ["PC", "PS4", "PS5", "Switch", "Switch2", "Xbox", null];
  const i = order.indexOf(p);
  return order[(i + 1) % order.length];
}

/** Merge storefront details without clobbering richer existing values. */
function mergeDetails(g: Game, d: Partial<Hit>): void {
  if (d.title) g.title = g.title ?? d.title;
  if (d.summary) g.summary = g.summary ?? d.summary;
  if (d.year) g.year = g.year ?? d.year;
  if (d.price) g.price = g.price ?? d.price;
  if (d.metacritic != null) g.metacritic = d.metacritic;
  if (d.developers?.length) g.developers = g.developers.length ? g.developers : d.developers;
  if (d.publishers?.length) g.publishers = g.publishers.length ? g.publishers : d.publishers;
  if (d.platformsAvailable?.length) {
    g.platformsAvailable = g.platformsAvailable.length ? g.platformsAvailable : d.platformsAvailable;
  }
  if (d.genres?.length) g.genres = g.genres.length ? g.genres : d.genres;
  if (d.image) g.image = g.image ?? d.image;
  if (d.url) g.url = g.url ?? d.url;
}

function deduplicateGames(games: Game[]): Game[] {
  const seen = new Map<string, Game>();
  for (const g of games) {
    const key = gameKey(g.title, g.year);
    const existing = seen.get(key);
    if (!existing || scoreGame(g) > scoreGame(existing)) seen.set(key, g);
  }
  return [...seen.values()];
}

function scoreGame(g: Game): number {
  let s = 0;
  if (g.summary) s += 2;
  if (g.image) s += 1;
  if (g.year !== null) s += 1;
  if (g.genres.length) s += 1;
  if (g.platform) s += 1;
  if (g.metacritic !== null) s += 1;
  if (g.developers.length) s += 1;
  if (hoursPlayed(g) > 0) s += 1;
  return s;
}
