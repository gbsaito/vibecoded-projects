import type { Hit } from "../model.ts";
import { anilist } from "./anilist.ts";
import { HttpError, isAbort } from "../net.ts";
import { SearchCache } from "../cache.ts";

export interface Provider {
  id: string;
  label: string;
  supportsMovies: boolean;
  search(query: string, signal: AbortSignal, timeoutMs: number): Promise<Hit[]>;
}

export const providers: Provider[] = [anilist];

export const providerById = (id: string): Provider | undefined =>
  providers.find((p) => p.id === id);

const TIMEOUTS: Record<string, number> = {
  anilist: 5000,
  tvmaze: 5000,
};

const DEFAULT_TIMEOUT = 8000;

export interface SearchOutcome {
  hits: Hit[];
  errors: Array<{ provider: string; message: string }>;
  fromCache: boolean;
  stale: boolean;
  tookMs: number;
}

export function mergeHits(groups: Hit[][]): Hit[] {
  const seen = new Map<string, Hit>();
  for (const g of groups) {
    for (const h of g) {
      const key = dedupeKey(h);
      const existing = seen.get(key);
      if (!existing || scoreHit(h) > scoreHit(existing)) {
        seen.set(key, h);
      }
    }
  }
  return [...seen.values()];
}

function scoreHit(h: Hit): number {
  let s = 0;
  if (h.avgRating !== null) s += 2;
  if (h.weight !== null) s += 1;
  if (h.image !== null) s += 1;
  if (h.summary !== null) s += 1;
  if (h.episodes !== null) s += 1;
  if (h.year !== null) s += 1;
  return s;
}

function dedupeKey(h: Hit): string {
  const t = h.title.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return h.year ? `${t}:${h.year}` : t;
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

  const hits = mergeHits(settled).slice(0, 50);

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
  private busy = false;
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

    this.controller?.abort();
    this.controller = null;

    if (q === this.issued) return;

    const gen = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.issued = q;
    this.busy = true;

    if (!q) {
      this.busy = false;
      this.onUpdate({ hits: [], errors: [], loading: false, stale: false, generation: gen });
      return;
    }

    this.onUpdate({ hits: [], errors: [], loading: true, stale: false, generation: gen });

    const partial: Hit[][] = [];
    const onPartial = (group: Hit[]) => {
      if (gen !== this.generation) return;
      partial.push(group);
      this.onUpdate({
        hits: mergeHits(partial).slice(0, 50),
        errors: [],
        loading: true,
        stale: false,
        generation: gen,
      });
    };

    try {
      const outcome = await search(q, this.cache, {
        signal: controller.signal,
        onPartial,
      }, this.provs);
      if (gen !== this.generation) return;
      this.busy = false;
      if (outcome.hits.length === 0) {
        this.issued = null;
      }
      this.onUpdate({
        hits: outcome.hits,
        errors: outcome.errors,
        loading: false,
        stale: outcome.stale,
        generation: gen,
      });
    } catch (e) {
      if (gen !== this.generation) return;
      this.busy = false;
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
