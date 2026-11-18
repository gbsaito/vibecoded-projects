/**
 * mst — anime/series tracker, hosted inside ut.
 *
 * The standalone entry point owned the renderer, the terminal lifecycle, the
 * gamepad and the headless export/import CLI; all of that now lives in ut's
 * host (src/main.ts). What remains here is the tracker: store, caches, screen,
 * debounce, status ticker and the key bindings, wired onto a hosted root.
 */

import { App, DEBOUNCE_MS } from "./app.ts";
import { handleKey, type KeyLike } from "./keys.ts";
import { Screen } from "./ui.ts";
import { Status } from "./model.ts";
import { Store } from "./store.ts";
import { resolvePaths } from "./paths.ts";
import { SearchCache } from "./cache.ts";
import { ImageCache } from "./image-cache.ts";
import type { SlotCtx, TrackerSlot } from "../slot.ts";

/** Demo data so the UI is explorable without touching the network. */
function seedDemo(store: Store): void {
  const rows: Array<[string, string, Status, number | null, number, number, number]> = [
    ["anilist:20", "Naruto", Status.Watching, 4, 220, 80, 734249],
    ["anilist:16498", "Attack on Titan", Status.Watching, 5, 89, 92, 500000],
    ["anilist:5114", "Higurashi When They Cry", Status.OnHold, 3, 74, 88, 210000],
    ["anilist:11061", "Hunter x Hunter", Status.Watchlist, null, 148, 90, 300000],
  ];

  for (const [id, title, status, rating, total, avg, weight] of rows) {
    store.upsert({
      id,
      title,
      kind: "Series",
      status,
      rating,
      progress: { seen: 0, total },
      year: 2000 + (weight % 24),
      summary: "Demo entry. Search for something real to replace it.",
      image: null,
      weight,
      avgRating: avg / 10,
      provider: "anilist",
      format: "TV",
      genres: [],
    });
  }
  store.save();
}

function loadStore(dbPath: string, demo: boolean): Store {
  const store = Store.load(dbPath);
  if (store.isEmpty() && demo) seedDemo(store);
  return store;
}

/**
 * Build the mst tracker onto the host's renderer and root container.
 * Throws when the library cannot be loaded (the host reports it as a slot).
 */
export function startMst(ctx: SlotCtx, opts: { demo?: boolean } = {}): TrackerSlot {
  const { renderer, root } = ctx;
  const paths = resolvePaths(null);
  const store = loadStore(paths.db, opts.demo === true);
  const cache = new SearchCache(paths.cache);
  const imageCache = new ImageCache(paths.cache);

  const app = new App(store, cache, imageCache, renderer, root);
  const screen = new Screen(renderer, imageCache, root);

  let active = false;
  let dirty = false;
  let lastQuery = app.query;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;

  const paint = () => {
    if (!active) return;
    dirty = false;
    screen.render(app);
  };
  const schedulePaint = () => {
    dirty = true;
    paint();
  };
  app.onChange = () => schedulePaint();
  imageCache.setOnChange(() => schedulePaint());

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

  return {
    name: "animes",

    key(k: KeyLike): boolean {
      if (handleKey(app, k)) return true;
      if (app.query !== lastQuery) {
        lastQuery = app.query;
        if (app.query) armDebounce();
        else cancelDebounce();
      }
      app.expireMessage();
      dirty = true;
      paint();
      return false;
    },

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
