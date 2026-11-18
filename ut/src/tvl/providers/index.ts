/**
 * Provider coordination.
 *
 * Every provider answers the same question ("which games match this term?")
 * and returns `Hit`s. Results are merged across providers, de-duplicated by
 * title+year, and ranked so the richest record wins.
 *
 * The coordinator mirrors the search behaviour of the sibling tracker: a
 * generation counter drops stale responses, an in-flight request is aborted
 * when a new one starts, and each provider's results are published as they
 * arrive instead of waiting for the slowest one.
 */

import { titleRelevance, type Hit } from "../model.ts";
import { HttpError, isAbort } from "../net.ts";
import { SearchCache } from "../cache.ts";
import { steam } from "./steam.ts";
import { epic } from "./epic.ts";
import { playstation } from "./playstation.ts";
import { nintendo } from "./nintendo.ts";

export interface Provider {
  id: string;
  label: string;
  search(query: string, signal: AbortSignal, timeoutMs: number): Promise<Hit[]>;
}

export const providers: Provider[] = [steam, epic, playstation, nintendo];

const TIMEOUTS: Record<string, number> = {
  steam: 8000,
  epic: 9000,
  playstation: 12000,
  nintendo: 8000,
};

const DEFAULT_TIMEOUT = 8000;

export interface SearchOutcome {
  hits: Hit[];
  errors: Array<{ provider: string; message: string }>;
  fromCache: boolean;
  stale: boolean;
  tookMs: number;
}

/** De-duplication key: normalised title plus year. */
export function dedupeKey(h: Hit): string {
  const t = h.title.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return h.year ? `${t}:${h.year}` : t;
}

/** Prefer the record with the most information. */
export function scoreHit(h: Hit): number {
  let s = 0;
  if (h.summary) s += 3;
  if (h.image) s += 2;
  if (h.price) s += 1;
  if (h.metacritic !== null) s += 1;
  if (h.year !== null) s += 1;
  if (h.genres.length) s += 1;
  if (h.platform) s += 1;
  return s;
}

export function mergeHits(groups: Hit[][], query = ""): Hit[] {
  const seen = new Map<string, Hit>();
  for (const g of groups) {
    for (const h of g) {
      const key = dedupeKey(h);
      const existing = seen.get(key);
      if (!existing || scoreHit(h) > scoreHit(existing)) seen.set(key, h);
    }
  }
  // How well the title answers the query comes first: a storefront may return
  // a title with no metadata at all (an unannounced game has no year or
  // price), and such a hit would be lost in a richness-first order. Richness
  // then alphabetical keep the order stable between runs; PC versions lead
  // console ones among equal matches.
  return [...seen.values()].sort(
    (a, b) =>
      titleRelevance(b.title, query) - titleRelevance(a.title, query) ||
      (a.platform === "PC" ? 0 : 1) - (b.platform === "PC" ? 0 : 1) ||
      scoreHit(b) - scoreHit(a) ||
      a.title.localeCompare(b.title),
  );
}

export interface SearchRequest {
  signal: AbortSignal;
  onPartial?: (hits: Hit[]) => void;
}

export async function search(
  query: string,
  cache: SearchCache,
  req: SearchRequest,
  provs: readonly Provider[] = providers,
): Promise<SearchOutcome> {
  const t0 = Date.now();
  const q = query.trim();

  const cached = cache.get(q);
  if (cached) {
    return { hits: cached, errors: [], fromCache: true, stale: false, tookMs: 0 };
  }

  const errors: Array<{ provider: string; message: string }> = [];

  const settled = await Promise.all(
    provs.map(async (p): Promise<Hit[]> => {
      const timeoutMs = TIMEOUTS[p.id] ?? DEFAULT_TIMEOUT;
      try {
        const hits = await p.search(q, req.signal, timeoutMs);
        req.onPartial?.(hits);
        return hits;
      } catch (e) {
        if (isAbort(e) || req.signal.aborted) throw e;
        errors.push({
          provider: p.id,
          message: e instanceof HttpError ? e.message : String((e as Error).message ?? e),
        });
        return [];
      }
    }),
  );

  if (req.signal.aborted) throw new HttpError("aborted", "aborted");

  const hits = mergeHits(settled, q).slice(0, 60);

  // Every provider failed and we have nothing fresh: fall back to stale cache.
  if (hits.length === 0 && errors.length === provs.length) {
    const stale = cache.peek(q);
    if (stale?.length) {
      return { hits: stale, errors, fromCache: true, stale: true, tookMs: Date.now() - t0 };
    }
  }

  if (hits.length) cache.set(q, hits);

  return { hits, errors, fromCache: false, stale: false, tookMs: Date.now() - t0 };
}

export class SearchCoordinator {
  private controller: AbortController | null = null;
  private generation = 0;
  private issued: string | null = null;
  private readonly cache: SearchCache;
  private readonly onUpdate: (state: SearchState) => void;
  private readonly provs: readonly Provider[];

  constructor(
    cache: SearchCache,
    onUpdate: (state: SearchState) => void,
    provs: readonly Provider[] = providers,
  ) {
    this.cache = cache;
    this.onUpdate = onUpdate;
    this.provs = provs;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  async start(query: string): Promise<void> {
    const q = query.trim();

    // The same query is already in flight: leave it be. Aborting it here would
    // swallow its completion — the aborted search returns without emitting a
    // final state, so the UI would stay stuck on "searching...".
    if (q === this.issued && this.controller) return;

    this.controller?.abort();
    this.controller = null;

    if (q === this.issued) return;

    const gen = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.issued = q;

    if (!q) {
      this.onUpdate({ hits: [], errors: [], loading: false, stale: false, generation: gen });
      return;
    }

    this.onUpdate({ hits: [], errors: [], loading: true, stale: false, generation: gen });

    const partial: Hit[][] = [];
    const onPartial = (group: Hit[]) => {
      if (gen !== this.generation) return;
      partial.push(group);
      this.onUpdate({
        hits: mergeHits(partial, q).slice(0, 60),
        errors: [],
        loading: true,
        stale: false,
        generation: gen,
      });
    };

    try {
      const outcome = await search(q, this.cache, { signal: controller.signal, onPartial }, this.provs);
      if (gen !== this.generation) return;
      if (outcome.hits.length === 0) this.issued = null;
      this.onUpdate({
        hits: outcome.hits,
        errors: outcome.errors,
        loading: false,
        stale: outcome.stale,
        generation: gen,
      });
    } catch (e) {
      if (gen !== this.generation) return;
      this.issued = null;
      if (isAbort(e)) return;
      this.onUpdate({
        hits: [],
        errors: [{ provider: "search", message: String((e as Error).message ?? e) }],
        loading: false,
        stale: false,
        generation: gen,
      });
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  invalidate(): void {
    this.controller?.abort();
    this.controller = null;
    this.issued = null;
    this.generation++;
  }

  dispose(): void {
    this.invalidate();
  }
}

export interface SearchState {
  hits: Hit[];
  errors: Array<{ provider: string; message: string }>;
  loading: boolean;
  stale: boolean;
  generation: number;
}
