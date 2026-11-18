import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Entry, Sort, Status } from "./model.ts";
import { applySort, MAX_RATING, Status as S } from "./model.ts";

export const CURRENT_VERSION = 2;

interface Db {
  version: number;
  entries: Entry[];
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
  entries: Entry[] = [];
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

    const version =
      doc && typeof doc === "object" && !Array.isArray(doc)
        ? Number((doc as Record<string, unknown>).version ?? 1)
        : 1;

    let entries: Entry[];
    if (Array.isArray(doc)) {
      entries = doc as Entry[];
    } else {
      const list = (doc as Record<string, unknown>).entries;
      entries = Array.isArray(list) ? (list as Entry[]) : [];
    }

    const hadMissingProvider = entries.some((e) => !e.provider);

    for (const e of entries) normalizeEntry(e, version);

    if (version < 2) migrateRatings(entries);

    s.entries = entries;
    if (version < CURRENT_VERSION || hadMissingProvider) s.saveVersioned(CURRENT_VERSION);
    return s;
  }

  private saveVersioned(version: number): void {
    if (!this.path) return;
    const doc: Db = { version, entries: this.entries };
    writeAtomic(this.path, JSON.stringify(doc, null, 2));
  }

  save(): void {
    this.saveVersioned(CURRENT_VERSION);
  }

  get length(): number {
    return this.entries.length;
  }

  isEmpty(): boolean {
    return this.entries.length === 0;
  }

  /** Swap the whole library (import replace), leaving saving to the caller. */
  replaceAll(entries: Entry[]): void {
    this.entries = entries;
  }

  upsert(entry: Entry): void {
    const i = this.entries.findIndex((e) => e.id === entry.id);
    if (i >= 0) {
      const prev = this.entries[i];
      this.entries[i] = {
        ...entry,
        status: prev.status,
        rating: prev.rating,
        progress: prev.progress,
        avgRating: entry.avgRating ?? prev.avgRating,
        weight: entry.weight ?? prev.weight,
        image: entry.image ?? prev.image,
        summary: entry.summary ?? prev.summary,
        year: entry.year ?? prev.year,
        genres: entry.genres?.length ? entry.genres : prev.genres,
        format: entry.format ?? prev.format,
      };
    } else {
      this.entries.push(entry);
    }
  }

  get(id: string): Entry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  getMut(id: string): Entry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  remove(id: string): Entry | undefined {
    const i = this.entries.findIndex((e) => e.id === id);
    if (i < 0) return undefined;
    return this.entries.splice(i, 1)[0];
  }

  sorted(status: Status, sort: Sort, desc: boolean): Entry[] {
    const v = this.entries.filter((e) => e.status === status);
    return applySort(v, sort, desc);
  }

  counts(): Array<[Status, number]> {
    return [S.Watchlist, S.Watching, S.Completed, S.OnHold, S.Dropped].map((s) => [
      s,
      this.entries.filter((e) => e.status === s).length,
    ]);
  }
}

export function normalizeEntry(e: Entry, version: number): Entry {
  e.id = String(e.id);
  e.kind = e.kind ?? "Series";
  e.status = e.status ?? S.Watchlist;
  e.provider = e.provider ?? (e.image?.includes("tvmaze.com") ? "tvmaze" : e.image?.includes("anilist") ? "anilist" : "tvmaze");
  e.rating = e.rating ?? null;
  e.progress = e.progress ?? null;
  e.year = e.year ?? null;
  e.summary = e.summary ?? null;
  e.image = e.image ?? null;
  e.weight = e.weight ?? null;
  const legacy = (e as unknown as Record<string, unknown>).avg_rating;
  e.avgRating = e.avgRating ?? (typeof legacy === "number" ? legacy : null);
  e.genres = e.genres ?? [];
  return e;
}

export function migrateRatings(entries: Entry[]): void {
  for (const e of entries) {
    if (e.rating === null || e.rating === undefined) continue;
    const r = e.rating;
    if (r === 0) {
      e.rating = null;
    } else {
      const scaled = Math.round((r / 10) * MAX_RATING);
      e.rating = Math.min(MAX_RATING, Math.max(1, scaled));
    }
  }
}
