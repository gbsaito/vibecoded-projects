/**
 * tvl — videogame tracker, hosted inside ut.
 *
 * Mirrors mst's slot: the standalone entry point owned the renderer, terminal
 * lifecycle and process cleanup; ut's host (src/main.ts) owns those now. What
 * lives here is the tracker itself, wired onto a hosted root.
 */

import { App, DEBOUNCE_MS } from "./app.ts";
import { handleKey } from "./keys.ts";
import type { KeyEvent } from "@opentui/core";
import { Screen } from "./ui.ts";
import { CommandPalette, buildAllCommands } from "./command-palette.ts";
import { SearchCache } from "./cache.ts";
import { ImageCache } from "./image-cache.ts";
import { clearCaches } from "./reload.ts";
import { Store, cacheDir, configPath } from "./store.ts";
import type { Platform, Source } from "./model.ts";
import type { SlotCtx, TrackerSlot } from "../slot.ts";

export interface TvlOpts {
  demo?: boolean;
  reload?: boolean;
}

/** Demo data so the UI is explorable without touching the network. */
function seedDemo(store: Store): void {
  const rows: Array<{
    id: string;
    title: string;
    status: "Backlog" | "Playing" | "Played" | "Abandoned";
    platform: Platform;
    rating: number | null;
    hours: number | null;
    year: number;
    metacritic: number | null;
    source: Source;
    wishlist?: boolean;
  }> = [
    {
      id: "steam:2050650",
      title: "Resident Evil 4",
      status: "Played",
      platform: "PC",
      rating: 5,
      hours: 22,
      year: 2023,
      metacritic: 93,
      source: "steam",
    },
    {
      id: "steam:2622380",
      title: "Dead Cells",
      status: "Playing",
      platform: "PC",
      rating: 4,
      hours: 31,
      year: 2018,
      metacritic: 89,
      source: "steam",
    },
    {
      id: "ps:UP9000-CUSA07820_00-THELASTOFUSPART2",
      title: "The Last of Us Part II",
      status: "Backlog",
      platform: "PS4",
      rating: 5,
      hours: 40,
      year: 2020,
      metacritic: 93,
      source: "playstation",
    },
    {
      id: "epic:e9a679451d094c1ba3d008b6a01adec5",
      title: "FINAL FANTASY VII REBIRTH",
      status: "Backlog",
      platform: "PC",
      rating: 4,
      hours: 18,
      year: 2025,
      metacritic: 92,
      source: "epic",
    },
    {
      id: "nintendo:70010000000025",
      title: "The Legend of Zelda: Breath of the Wild",
      status: "Backlog",
      platform: "Switch",
      rating: null,
      hours: null,
      year: 2017,
      metacritic: 97,
      source: "nintendo",
      wishlist: true,
    },
  ];

  for (const row of rows) {
    store.upsert({
      id: row.id,
      title: row.title,
      status: row.status,
      rating: row.rating,
      playtime: row.hours ? { hours: row.hours } : null,
      year: row.year,
      summary: "Demo entry. Search for something real to replace it.",
      image: null,
      platform: row.platform,
      sources: [row.source],
      price: null,
      metacritic: row.metacritic,
      developers: [],
      publishers: [],
      platformsAvailable: [],
      metacriticSlug: null,
      genres: [],
      url: null,
      wishlist: row.wishlist === true,
      hundredPercent: false,
      addedAt: Date.now(),
    });
  }
  store.save();
}

function loadTvlStore(demo: boolean): Store {
  let store: Store;
  try {
    store = Store.load(configPath());
  } catch (e) {
    throw new Error(`tvl: ${(e as Error).message}`);
  }
  if (store.isEmpty() && demo) seedDemo(store);
  return store;
}

export function startTvl(ctx: SlotCtx, opts: TvlOpts = {}): TrackerSlot {
  const { renderer, root } = ctx;
  if (opts.reload) {
    const report = clearCaches(cacheDir());
    const what = report.removed.length ? report.removed.join(", ") : "nothing cached";
    console.log(`tvl: cleared ${what} (${report.files} files)`);
  }
  const store = loadTvlStore(opts.demo === true);
  const cache = new SearchCache(cacheDir());
  const imageCache = new ImageCache(cacheDir());

  const app = new App(store, cache, imageCache);
  const screen = new Screen(renderer, imageCache, root);
  const palette = new CommandPalette(renderer, root);
  palette.app = app;
  palette.setCommands(buildAllCommands(app));
  app.openCommandPalette = () => palette.open(() => screen.render(app));

  let active = false;
  let dirty = false;
  let paintQueued = false;
  let shuttingDown = false;
  const paint = () => {
    paintQueued = false;
    if (shuttingDown || !active || !dirty) return;
    dirty = false;
    screen.render(app);
  };
  const schedulePaint = () => {
    dirty = true;
    if (paintQueued) return;
    paintQueued = true;
    setImmediate(paint);
  };

  app.onChange = () => schedulePaint();
  imageCache.setOnChange(() => schedulePaint());

  let debounce: ReturnType<typeof setTimeout> | null = null;
  const armDebounce = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      void app.maybeSearch();
    }, DEBOUNCE_MS);
  };
  const cancelDebounce = () => {
    if (debounce) {
      clearTimeout(debounce);
      debounce = null;
    }
  };

  let ticker: ReturnType<typeof setInterval> | null = null;
  let lastQuery = app.query;

  const key = (k: import("../slot.ts").KeyLike): boolean => {
    if (palette.visible) {
      palette.handleKey(k);
      dirty = true;
      paint();
      return false;
    }
    if (handleKey(app, k as KeyEvent)) return true;
    if (app.query !== lastQuery) {
      lastQuery = app.query;
      if (app.query) armDebounce();
      else cancelDebounce();
    }
    app.expireMessage();
    dirty = true;
    paint();
    return false;
  };

  if (opts.reload) {
    app.reloadAll();
    screen.render(app);
  }

  return {
    name: "videogames",
    key,
    activate(): void {
      active = true;
      dirty = true;
      paint();
      if (!ticker) {
        ticker = setInterval(() => {
          if (app.statusMsg) {
            app.expireMessage();
            dirty = true;
            paint();
          }
        }, 500);
      }
    },
    deactivate(): void {
      active = false;
      if (ticker) {
        clearInterval(ticker);
        ticker = null;
      }
    },
    resize(): void {
      dirty = true;
      paint();
    },
    announce(msg: string): void {
      app.notify(msg);
      dirty = true;
      paint();
    },
    dispose(): void {
      cancelDebounce();
      if (ticker) clearInterval(ticker);
      app.dispose();
    },
  };
}
