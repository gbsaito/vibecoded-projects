/**
 * Nintendo Store provider.
 *
 * The storefront's public search index (Algolia) is the same one the website
 * uses; its search-only key is embedded in the public page, not a personal
 * account key. It returns title, price, platform, genres and a Cloudinary
 * image id. The image is cropped to exactly 600x900 by the delivery URL.
 *
 * DLC and non-game products are filtered out so results match the other
 * storefront providers.
 */

import type { Hit, Platform, Source } from "../model.ts";
import { fetchJson } from "../net.ts";

const ALGOLIA = "https://U3B6GR4UA3-dsn.algolia.net/1/indexes/store_game_en_us/query";
const APP_ID = "U3B6GR4UA3";
const SEARCH_KEY = "a29c6927638bfd8cee23993e51e721c9";
const IMAGE = "https://assets.nintendo.com/image/upload/c_fill,h_900,w_600,f_auto/q_auto";
const TIMEOUT = 8000;

interface AlgoliaResponse {
  hits?: NintendoProduct[];
}

interface NintendoProduct {
  title?: string | null;
  nsuid?: string | null;
  sku?: string | null;
  url?: string | null;
  productImage?: string | null;
  releaseDate?: string | null;
  corePlatforms?: string[] | null;
  platform?: string | null;
  gameGenreLabels?: string[] | null;
  gameGenres?: string[] | null;
  softwareDeveloper?: string | null;
  softwarePublisher?: string | null;
  topLevelCategoryCode?: string | null;
  dlcType?: string | null;
  productType?: string[] | null;
  price?: {
    finalPrice?: number | null;
    regPrice?: number | null;
    discounted?: boolean | null;
  } | null;
}

function cleanTitle(title: string): string {
  return title
    .replace(/[™®©]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function yearOf(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const year = Number(iso.slice(0, 4));
  return Number.isFinite(year) && year > 1950 ? year : null;
}

function platformOf(p: NintendoProduct): Platform | null {
  const names = [...(p.corePlatforms ?? []), p.platform ?? ""].join(" ").toLowerCase();
  if (names.includes("switch 2") || names.includes("switch2")) return "Switch2";
  if (names.includes("switch")) return "Switch";
  return null;
}

function priceOf(p: NintendoProduct): string | null {
  const value = p.price?.finalPrice;
  if (value == null) return null;
  if (value === 0) return "Free";
  return `$${value.toFixed(2)}`;
}

function isGame(p: NintendoProduct): boolean {
  if (p.topLevelCategoryCode && p.topLevelCategoryCode !== "GAMES") return false;
  if (p.dlcType) return false;
  if (p.productType?.some((t) => /dlc|add-?on|season pass/i.test(t))) return false;
  return !!p.title;
}

export const nintendo = {
  id: "nintendo" as Source,
  label: "Nintendo",

  async search(query: string, signal: AbortSignal, timeoutMs: number = TIMEOUT): Promise<Hit[]> {
    const q = query.trim();
    if (!q) return [];

    const doc = await fetchJson<AlgoliaResponse>(ALGOLIA, {
      signal,
      timeoutMs,
      attempts: 2,
      method: "POST",
      body: JSON.stringify({ query: q, hitsPerPage: 30, page: 0 }),
      accept: "application/json",
      headers: {
        "X-Algolia-Application-Id": APP_ID,
        "X-Algolia-API-Key": SEARCH_KEY,
      },
    });

    const hits: Hit[] = [];
    const seen = new Set<string>();
    for (const p of doc.hits ?? []) {
      if (!isGame(p) || !p.title) continue;
      const title = cleanTitle(p.title);
      const key = title.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);

      const nsuid = p.nsuid ?? p.sku ?? p.url ?? title;
      const image = p.productImage ? `${IMAGE}/${p.productImage}` : null;
      const path = p.url?.startsWith("/") ? p.url : p.url ? `/${p.url}` : null;
      const price = priceOf(p);
      const devices = p.corePlatforms?.length ? p.corePlatforms : p.platform ? [p.platform] : [];

      hits.push({
        id: `nintendo:${nsuid}`,
        title,
        year: yearOf(p.releaseDate),
        summary: null,
        image,
        platform: platformOf(p),
        sources: ["nintendo" as Source],
        price,
        metacritic: null,
        developers: p.softwareDeveloper ? [p.softwareDeveloper] : [],
        publishers: p.softwarePublisher ? [p.softwarePublisher] : [],
        platformsAvailable: devices,
        metacriticSlug: null,
        genres: (p.gameGenreLabels ?? p.gameGenres ?? []).filter(Boolean),
        url: path ? `https://www.nintendo.com${path}` : null,
      });
    }
    return hits;
  },
};
