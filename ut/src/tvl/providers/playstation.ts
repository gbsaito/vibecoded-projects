/**
 * PlayStation Store provider.
 *
 * Two keyless public surfaces are combined:
 *
 *  - The storefront's legacy catalogue JSON
 *    (`store.playstation.com/store/api/chihiro/00_09_000/search/...`) is a real
 *    keyword search over the whole catalogue and needs no key or session.
 *  - The store's GraphQL gateway
 *    (`web.np.playstation.com/api/graphql/v1/op`) serves whitelisted persisted
 *    queries, addressed by `extensions.persistedQuery.sha256Hash`. The product
 *    query `metGetProductById` supplies details.
 *
 * Search results from the legacy endpoint carry only square art, so the top
 * few are enriched through `metGetProductById`; its `PORTRAIT_BANNER` is
 * 1440x2160 (2:3) and `?w=600&h=900` returns exactly 600x900.
 */

import { titleRelevance, type Hit, type Platform, type Source } from "../model.ts";
import { fetchJson, HttpError } from "../net.ts";

const GQL = "https://web.np.playstation.com/api/graphql/v1/op";
const LEGACY = "https://store.playstation.com/store/api/chihiro/00_09_000";
const TIMEOUT = 9000;

/** Results enriched with a detail request; keeps a search to one legacy call. */
const SEARCH_LIMIT = 12;
/** Candidates fetched from the legacy search before ranking. */
const SEARCH_POOL = 50;
/** Concurrent detail requests when enriching search results. */
const DETAIL_CONCURRENCY = 4;

/** Whitelisted persisted-query hashes. */
const HASH_PRODUCT_BY_ID = "a128042177bd93dd831164103d53b73ef790d56f51dae647064cb8f9d9fc9d1a";

interface Media {
  role: string;
  type: string;
  url: string;
}

interface ProductResponse {
  data?: {
    productRetrieve?: {
      id: string;
      name: string;
      npTitleId?: string;
      platforms?: string[];
      publisherName?: string | null;
      releaseDate?: string | null;
      descriptions?: Array<{ type: string; value: string }>;
      combinedLocalizedGenres?: Array<{ value: string }>;
      media?: Media[];
      concept?: {
        descriptions?: Array<{ type: string; value: string }>;
        combinedLocalizedGenres?: Array<{ value: string }>;
      };
    };
  };
}

interface LegacyProduct {
  id: string;
  name: string;
  playable_platform?: string[];
  top_category?: string;
  release_date?: string;
  default_sku?: { price?: number } | null;
  images?: Array<{ type: number; url: string }>;
  metadata?: Record<string, { values?: string[] } | undefined>;
}

interface LegacyResponse {
  links?: LegacyProduct[];
  total_results?: number;
}

async function persisted<T>(
  operationName: string,
  variables: Record<string, unknown>,
  hash: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  const params = new URLSearchParams({
    operationName,
    variables: JSON.stringify(variables),
    extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }),
  });
  const doc = await fetchJson<T>(`${GQL}?${params.toString()}`, {
    signal,
    timeoutMs,
    attempts: 2,
    headers: {
      Accept: "application/json",
      "apollo-require-preflight": "true",
      "X-Psn-Store-Locale-Override": "en-us",
    },
  });
  if (!doc || typeof doc !== "object") throw new Error("empty response");
  return doc;
}

const normalizePlatform = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Prefer PS4 when a title covers both, so the label matches the source name. */
const platformOf = (platforms: string[] | undefined): Platform | null => {
  if (!platforms?.length) return null;
  const p = platforms.map(normalizePlatform);
  if (p.includes("PS4")) return "PS4";
  if (p.includes("PS5")) return "PS5";
  return null;
};

const yearOf = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const y = Number(iso.slice(0, 4));
  return Number.isFinite(y) && y > 1950 ? y : null;
};

const stripTags = (s: string): string =>
  s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s*\n\s*/g, "\n")
    .trim();

/** 600x900 portrait art when the title has one, otherwise the key/cover art. */
function artOf(media: Media[] | undefined): string | null {
  if (!media?.length) return null;
  const portrait = media.find((m) => m.role === "PORTRAIT_BANNER")?.url;
  if (portrait) return `${portrait}${portrait.includes("?") ? "&" : "?"}w=600&h=900`;
  return (
    media.find((m) => m.role === "EDITION_KEY_ART")?.url ??
    media.find((m) => m.role === "GAMEHUB_COVER_ART")?.url ??
    null
  );
}

/** Fallback art from a legacy search row: type 10 is the key art. */
function legacyArt(p: LegacyProduct): string | null {
  return p.images?.find((i) => i.type === 10)?.url ?? p.images?.[0]?.url ?? null;
}

function legacyPrice(p: LegacyProduct): string | null {
  const cents = p.default_sku?.price;
  if (cents == null) return null;
  if (cents === 0) return "Free";
  return `$${(cents / 100).toFixed(2)}`;
}

const FULL_CLASSES = new Set(["FULL_GAME", "PREMIUM_EDITION", "GAME_BUNDLE"]);

/** Reject DLC, avatars, themes and soundtracks; keep full games and bundles. */
function isFullGame(p: LegacyProduct): boolean {
  const cat = p.top_category ?? "";
  if (cat === "add_on" || cat === "theme" || cat === "avatar" || cat === "soundtrack") {
    return false;
  }
  const cls = p.metadata?.store_display_classification?.values?.[0];
  return cls ? FULL_CLASSES.has(cls) : true;
}

/** How well a title matches the query; exact and prefix matches rank first. */
function relevance(title: string, query: string): number {
  return titleRelevance(title, query);
}

const genreLabel = (v: string): string =>
  v
    .toLowerCase()
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");

function legacyGenres(p: LegacyProduct): string[] {
  const values = p.metadata?.genre?.values ?? [];
  return values.map(genreLabel);
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i];
      if (item !== undefined) out[i] = await fn(item);
    }
  });
  await Promise.all(workers);
  return out;
}

export const playstation = {
  id: "playstation" as Source,
  label: "PlayStation",

  /**
   * Keyword search. The legacy catalogue endpoint does the matching, then the
   * best full-game candidates are enriched with 600x900 portrait art.
   */
  async search(query: string, signal: AbortSignal, timeoutMs: number = TIMEOUT): Promise<Hit[]> {
    const q = query.trim();
    if (!q) return [];

    const url = `${LEGACY}/search/US/en/99/${encodeURIComponent(q)}?size=${SEARCH_POOL}`;
    let doc: LegacyResponse;
    try {
      doc = await fetchJson<LegacyResponse>(url, {
        signal,
        timeoutMs,
        attempts: 2,
        headers: { Accept: "application/json" },
      });
    } catch (e) {
      // The legacy catalogue answers 404 when a search has no match; that is an
      // empty result, not a failed source.
      if (e instanceof HttpError && e.status === 404) return [];
      throw e;
    }

    const ranked = (doc.links ?? [])
      .filter((p) => p.name && platformOf(p.playable_platform) && isFullGame(p))
      .map((p, i) => ({ p, i, score: relevance(p.name, q) }))
      .sort((a, b) => b.score - a.score || a.i - b.i);

    const seen = new Set<string>();
    const picked: LegacyProduct[] = [];
    for (const { p } of ranked) {
      const key = p.name.toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(p);
      if (picked.length >= SEARCH_LIMIT) break;
    }

    return mapLimit(picked, DETAIL_CONCURRENCY, (p) => this.detail(p, signal, timeoutMs));
  },

  /** One legacy row plus whatever the detail query can add. */
  async detail(
    p: LegacyProduct,
    signal: AbortSignal,
    timeoutMs: number = TIMEOUT,
  ): Promise<Hit> {
    let detail: Partial<Hit> | null = null;
    try {
      detail = await this.details(p.id, signal, timeoutMs);
    } catch {
      /* the legacy row is enough to show the game */
    }
    return {
      id: `ps:${p.id}`,
      title: detail?.title ?? p.name,
      year: detail?.year ?? yearOf(p.release_date),
      summary: detail?.summary ?? null,
      image: detail?.image ?? legacyArt(p),
      platform: detail?.platform ?? platformOf(p.playable_platform),
      sources: ["playstation" as Source],
      price: legacyPrice(p),
      metacritic: null,
      developers: [],
      publishers: detail?.publishers ?? [],
      platformsAvailable: detail?.platformsAvailable ?? [],
      metacriticSlug: null,
      genres: detail?.genres?.length ? detail.genres : legacyGenres(p),
      url: `https://store.playstation.com/en-us/product/${p.id}`,
    };
  },

  /** Full details for one product id, used to enrich a legacy search row. */
  async details(
    productId: string,
    signal: AbortSignal,
    timeoutMs: number = TIMEOUT,
  ): Promise<Partial<Hit> | null> {
    const doc = await persisted<ProductResponse>(
      "metGetProductById",
      { productId },
      HASH_PRODUCT_BY_ID,
      signal,
      timeoutMs,
    );
    const p = doc.data?.productRetrieve;
    if (!p) return null;

    const descriptions = p.descriptions ?? p.concept?.descriptions ?? [];
    const raw =
      descriptions.find((d) => d.type === "SHORT")?.value ??
      descriptions.find((d) => d.type === "LONG")?.value ??
      null;
    const genres = (p.combinedLocalizedGenres ?? p.concept?.combinedLocalizedGenres ?? []).map(
      (g) => g.value,
    );

    return {
      title: p.name,
      summary: raw ? stripTags(raw) : null,
      year: yearOf(p.releaseDate),
      platform: platformOf(p.platforms),
      publishers: p.publisherName ? [p.publisherName] : [],
      platformsAvailable: p.platforms ?? [],
      genres,
      image: artOf(p.media),
    };
  },
};
