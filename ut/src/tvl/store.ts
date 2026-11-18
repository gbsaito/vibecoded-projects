/**
 * Persistent library: the tracked games, stored as one JSON document.
 *
 * Writes are atomic (temp file + rename) so a crash mid-save cannot leave a
 * half-written library behind.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { utCacheDir, utConfig } from "../utdirs.ts";
import type { Game, Sort, Status } from "./model.ts";
import { applySort, gameKey, sameGame, Status as S, STATUS_ALL } from "./model.ts";

export const CURRENT_VERSION = 2;

export function configPath(): string {
  return utConfig("tvl", "db.json");
}

export function cacheDir(): string {
  return utCacheDir("tvl");
}

/** Where export files land: `$XDG_EXPORT_HOME/ut/tvl` (default `~/.local/share/ut/tvl`). */
interface Db {
  version: number;
  games: Game[];
}

export function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, contents, "utf8");
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing useful to do */
    }
    throw e;
  }
}

export class Store {
  games: Game[] = [];
  /**
   * Bumped whenever the library changes. Derived views (filtering, sorting)
   * cache their result against this value instead of recomputing per frame.
   */
  revision = 0;
  private path: string | null = null;

  static inMemory(): Store {
    return new Store();
  }

  static load(path: string): Store {
    const s = new Store();
    s.path = path;

    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      s.save();
      return s;
    }

    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (e) {
      throw new Error(`reading ${path}: ${(e as Error).message}`);
    }

    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch (e) {
      throw new Error(`${path} is corrupt: ${(e as Error).message}`);
    }

    let games: Game[];
    if (Array.isArray(doc)) {
      games = doc as Game[];
    } else {
      const list = (doc as Record<string, unknown>).games;
      games = Array.isArray(list) ? (list as Game[]) : [];
    }

    for (const g of games) normalizeGame(g);

    // Keep one record per game across storefronts and across the
    // library/wishlist split. Merges in memory; the next save persists them.
    s.games = dedupeGames(games);
    return s;
  }

  save(): void {
    this.revision++;
    if (!this.path) return;
    const doc: Db = { version: CURRENT_VERSION, games: this.games };
    writeAtomic(this.path, JSON.stringify(doc, null, 2));
  }

  get length(): number {
    return this.games.length;
  }

  isEmpty(): boolean {
    return this.games.length === 0;
  }

  upsert(game: Game): void {
    this.revision++;
    const i = this.games.findIndex((g) => sameGame(g, game));
    if (i >= 0) {
      const prev = this.games[i];
      this.games[i] = {
        ...game,
        // Keep the user's own data when re-adding an existing game.
        status: prev.status,
        rating: prev.rating,
        playtime: prev.playtime,
        wishlist: prev.wishlist,
        hundredPercent: prev.hundredPercent,
        addedAt: prev.addedAt,
        // Prefer the richer metadata.
        summary: game.summary ?? prev.summary,
        image: game.image ?? prev.image,
        year: game.year ?? prev.year,
        price: game.price ?? prev.price,
        metacritic: game.metacritic ?? prev.metacritic,
        developers: game.developers.length ? game.developers : prev.developers,
        publishers: game.publishers.length ? game.publishers : prev.publishers,
        platformsAvailable: game.platformsAvailable.length
          ? game.platformsAvailable
          : prev.platformsAvailable,
        metacriticSlug: game.metacriticSlug ?? prev.metacriticSlug,
        genres: game.genres.length ? game.genres : prev.genres,
        platform: game.platform ?? prev.platform,
        url: game.url ?? prev.url,
        sources: game.sources.length ? game.sources : prev.sources,
      };
    } else {
      this.games.push(game);
    }
  }

  get(id: string): Game | undefined {
    return this.games.find((g) => g.id === id);
  }

  /** Find an existing record by id or by title/year, whichever matches first. */
  findMatch(game: Pick<Game, "id" | "title" | "year">): Game | undefined {
    return this.games.find((g) => sameGame(g, game));
  }

  remove(id: string): Game | undefined {
    const i = this.games.findIndex((g) => g.id === id);
    if (i < 0) return undefined;
    this.revision++;
    return this.games.splice(i, 1)[0];
  }

  sorted(status: Status, sort: Sort, desc: boolean): Game[] {
    const v = this.games.filter((g) => g.status === status);
    return applySort(v, sort, desc);
  }

  counts(): Array<[Status, number]> {
    return STATUS_ALL.map((s) => [s, this.games.filter((g) => g.status === s).length]);
  }
}

/**
 * Collapse records that are the same game. A library record wins over a
 * wishlist copy; otherwise the first-seen record keeps its identity and the
 * second fills in anything it is missing. Nothing personal is discarded.
 */
function dedupeGames(games: Game[]): Game[] {
  const out: Game[] = [];
  const byId = new Map<string, number>();
  const byKey = new Map<string, number>();

  for (const game of games) {
    const key = gameKey(game.title, game.year);
    const i = byId.get(game.id) ?? byKey.get(key);
    if (i === undefined) {
      const at = out.length;
      out.push(game);
      byId.set(game.id, at);
      byKey.set(key, at);
      continue;
    }

    const merged = mergeDuplicate(out[i], game);
    out[i] = merged;
    byId.set(game.id, i);
    byId.set(merged.id, i);
    byKey.set(key, i);
    byKey.set(gameKey(merged.title, merged.year), i);
  }

  return out;
}

function mergeDuplicate(a: Game, b: Game): Game {
  // A tracked game belongs in the library, not simultaneously on the wishlist.
  const [base, extra] = a.wishlist && !b.wishlist ? [b, a] : [a, b];

  return {
    ...base,
    // Prefer a real library status over a backlog placeholder, but never let a
    // wishlist copy promote itself.
    status: base.wishlist ? S.Backlog : base.status !== S.Backlog ? base.status : extra.status,
    rating: base.rating ?? extra.rating,
    playtime: base.playtime ?? extra.playtime,
    wishlist: base.wishlist && extra.wishlist,
    hundredPercent: base.hundredPercent || extra.hundredPercent,
    addedAt: Math.min(base.addedAt, extra.addedAt),
    summary: base.summary ?? extra.summary,
    image: base.image ?? extra.image,
    year: base.year ?? extra.year,
    price: base.price ?? extra.price,
    metacritic: base.metacritic ?? extra.metacritic,
    developers: base.developers.length ? base.developers : extra.developers,
    publishers: base.publishers.length ? base.publishers : extra.publishers,
    platformsAvailable: base.platformsAvailable.length
      ? base.platformsAvailable
      : extra.platformsAvailable,
    metacriticSlug: base.metacriticSlug ?? extra.metacriticSlug,
    genres: base.genres.length ? base.genres : extra.genres,
    platform: base.platform ?? extra.platform,
    url: base.url ?? extra.url,
    sources: [...new Set([...base.sources, ...extra.sources])],
  };
}

export function normalizeGame(g: Game): Game {
  g.id = String(g.id);
  g.title = g.title ?? "Untitled";

  // Migrate the previous five-status vocabulary. On-hold entries are not
  // currently being played, so they return to the backlog.
  const rawStatus = String(g.status ?? "");
  g.status =
    rawStatus === "Completed"
      ? S.Played
      : rawStatus === "Dropped"
        ? S.Abandoned
        : rawStatus === "OnHold"
          ? S.Backlog
          : (STATUS_ALL as readonly string[]).includes(rawStatus)
            ? (rawStatus as Status)
            : S.Backlog;

  g.rating = g.rating ?? null;
  g.playtime = g.playtime ?? null;
  g.year = g.year ?? null;
  g.summary = g.summary ?? null;
  g.image = g.image ?? null;
  g.platform = g.platform ?? null;
  g.sources = g.sources ?? [];
  g.price = g.price ?? null;

  // v1 stored a 0-10 store score called `score`; v2 stores Metacritic 0-100.
  const legacy = g as unknown as { score?: number | null; metacritic?: number | null };
  if (legacy.metacritic == null && legacy.score != null) {
    legacy.metacritic = legacy.score <= 10 ? Math.round(legacy.score * 10) : legacy.score;
  }
  g.metacritic = legacy.metacritic ?? null;
  delete legacy.score;

  g.developers = g.developers ?? [];
  g.publishers = g.publishers ?? [];
  g.platformsAvailable = g.platformsAvailable ?? [];
  g.metacriticSlug = g.metacriticSlug ?? null;
  g.genres = g.genres ?? [];
  g.url = g.url ?? null;
  g.wishlist = g.wishlist === true;
  // A wishlist entry is a game to get, not a library status.
  if (g.wishlist) g.status = S.Backlog;
  g.hundredPercent = g.hundredPercent === true;
  g.addedAt = g.addedAt ?? Date.now();
  return g;
}
