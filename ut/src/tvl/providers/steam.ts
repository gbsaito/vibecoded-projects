/**
 * Steam provider.
 *
 * Keyless public endpoints:
 *  - `search/results` returns a JSON envelope whose `results_html` holds the
 *    rendered result rows (app id, title, price, release date).
 *  - `api/appdetails` returns full metadata for a single app id.
 *
 * Cover art: `library_600x900_2x.jpg` is exactly 600x900 (the 1x
 * `library_600x900.jpg` is 300x450 for older titles).
 */

import { isSameGameTitle, type Hit, type Platform, type Source } from "../model.ts";
import { fetchJson, fetchText } from "../net.ts";
import { fetchIgdbCover } from "./igdb.ts";

const SEARCH_URL = "https://store.steampowered.com/search/results/";
const DETAILS_URL = "https://store.steampowered.com/api/appdetails";
const STORE_APP_URL = "https://store.steampowered.com/app";
const ART_URL = "https://cdn.cloudflare.steamstatic.com/steam/apps";

const TIMEOUT = 8000;

interface SearchEnvelope {
  success: number;
  total_count: number;
  results_html: string;
}

interface AppDetails {
  success: boolean;
  data?: {
    name?: string;
    short_description?: string;
    release_date?: { coming_soon: boolean; date: string };
    price_overview?: {
      final_formatted?: string;
      initial_formatted?: string;
      discount_percent?: number;
    };
    genres?: Array<{ description: string }>;
    categories?: Array<{ description: string }>;
    developers?: string[];
    publishers?: string[];
    platforms?: { windows?: boolean; mac?: boolean; linux?: boolean };
    metacritic?: { score: number };
  };
}

const dec = (s: string): string =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");

const stripTags = (s: string): string => dec(s.replace(/<[^>]*>/g, "")).trim();

/** Steam release dates look like "Nov 8, 2013" or "Coming soon". */
function parseYear(date: string | null | undefined): number | null {
  if (!date) return null;
  const m = date.match(/(\d{4})/);
  return m ? Number(m[1]) : null;
}

function parsePrice(html: string): string | null {
  const sale = html.match(/<div class="discount_final_price">\s*([^<]+?)\s*<\/div>/);
  if (sale) return stripTags(sale[1]);
  const plain = html.match(/<div class="search_price">\s*([^<]+?)\s*<\/div>/);
  if (plain) return stripTags(plain[1]);
  const data = html.match(/data-price-final="(\d+)"/);
  if (data) {
    const cents = Number(data[1]);
    if (cents === 0) return "Free";
    return `$${(cents / 100).toFixed(2)}`;
  }
  return null;
}

/** Split the rendered results into one chunk of HTML per app id. */
function splitRows(html: string): Array<{ id: string; html: string }> {
  const out: Array<{ id: string; html: string }> = [];
  const re = /data-ds-appid="(\d+)"/g;
  const marks: Array<{ id: string; at: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) marks.push({ id: m[1], at: m.index });
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].at : html.length;
    out.push({ id: marks[i].id, html: html.slice(marks[i].at, end) });
  }
  return out;
}

/**
 * Steam cover art URLs, tried in order. Prefers vertical (portrait) formats
 * for the TUI carousel, with horizontal fallbacks.
 */
const STEAM_ART_URLS = [
  // Vertical / portrait (preferred for carousel and detail)
  (appId: string) => `${ART_URL}/${appId}/library_600x900_2x.jpg`, // 1200x1800
  (appId: string) => `${ART_URL}/${appId}/library_600x900.jpg`, // 600x900
  (appId: string) => `${ART_URL}/${appId}/header.jpg`, // often vertical-ish
  // Horizontal fallbacks (used if vertical missing)
  (appId: string) => `${ART_URL}/${appId}/library_hero.jpg`, // 1920x620
  (appId: string) => `${ART_URL}/${appId}/capsule_616x353.jpg`, // 616x353
  (appId: string) => `${ART_URL}/${appId}/capsule_231x87.jpg`, // 231x87
];

/**
 * The store moved to hashed asset paths
 * (`store_item_assets/steam/apps/<id>/<hash>/<name>.jpg`) for apps created
 * recently. Those apps have no `library_600x900` on the classic CDN path, so
 * the art has to be read from the app page instead of guessed.
 */
const HASHED_ASSET_RE =
  /https:\/\/shared\.akamai\.steamstatic\.com\/store_item_assets\/steam\/apps\/(\d+)\/([a-f0-9]+)\/([A-Za-z0-9_]+)\.(jpg|png|webp)/g;

/** Asset names that are vertical enough to fill a portrait cell. */
const PORTRAIT_ASSETS = new Set(["library_600x900_2x", "library_600x900", "library_cover_600x900"]);

/** Asset names that are landscape, so the cover needs to be looked up again. */
const LANDSCAPE_ASSETS = new Set([
  "capsule_616x353",
  "capsule_231x87",
  "capsule_184x69",
  "capsule_sm_120",
  "header",
  "header_292x136",
  "library_hero",
  "page_bg_raw",
  "movie_232x130",
]);

/**
 * Whether a Steam art URL is known to be landscape. Such a cover has to be
 * replaced with a portrait one before it looks right in the carousel.
 */
export function isLandscapeSteamArt(url: string | null | undefined): boolean {
  if (!url) return false;
  // The classic CDN path: only these names are ever used there.
  const classic = url.match(/\/steam\/apps\/\d+\/([A-Za-z0-9_]+)\./)?.[1];
  if (classic) return LANDSCAPE_ASSETS.has(assetStem(classic));
  // The hashed asset path.
  const hashed = url.match(/store_item_assets\/steam\/apps\/\d+\/[a-f0-9]+\/([A-Za-z0-9_]+)\./)?.[1];
  if (hashed) return LANDSCAPE_ASSETS.has(assetStem(hashed));
  return false;
}

/**
 * The store appends `_alt_assets_0` to some asset names, so the name is
 * matched on its stem.
 */
function assetStem(name: string): string {
  return name.replace(/_alt_assets_\d+$/, "");
}

/** Build the best available cover URL for a Steam app id. */
function steamArtUrl(appId: string): string {
  return STEAM_ART_URLS[0](appId);
}

/**
 * Read the cover art URLs an app page actually links. The store page lists
 * the real asset files, including the portrait ones under the hashed path.
 * Returns the portrait URL when there is one, else the store's own capsule
 * (the widest landscape the store publishes).
 */
export function steamArtUrlsFromPage(html: string): { portrait: string | null; wide: string | null } {
  let portrait: string | null = null;
  let capsule: string | null = null;
  let header: string | null = null;
  for (const m of html.matchAll(HASHED_ASSET_RE)) {
    const url = m[0];
    const name = assetStem(m[3]);
    if (PORTRAIT_ASSETS.has(name)) {
      if (!portrait) portrait = url;
    } else if (name === "capsule_616x353") {
      if (!capsule) capsule = url;
    } else if (name === "header") {
      if (!header) header = url;
    }
  }
  return { portrait, wide: capsule ?? header };
}

/**
 * Try multiple Steam art URLs until one works (HEAD request).
 * Returns the first URL that returns 200 OK.
 */
export async function findWorkingSteamArt(
  appId: string,
  signal: AbortSignal,
): Promise<string | null> {
  for (const urlFn of STEAM_ART_URLS.slice(0, 2)) {
    const url = urlFn(appId);
    try {
      const res = await fetch(url, { method: "HEAD", signal });
      if (res.ok) return url;
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * The cover art for one Steam app.
 *
 * Older apps keep their art on the classic CDN path. Apps created recently
 * only have hashed asset paths, so their art has to be read from the app page.
 * Portrait art is preferred; when the publisher has not uploaded one, the
 * widest landscape asset is used instead, so the game still shows a cover.
 *
 * When a title is given, SteamGridDB is consulted as well: it holds proper
 * 600x900 portrait covers for many recent games whose store page only has
 * the landscape capsule.
 */
export async function resolveSteamArt(
  appId: string,
  signal: AbortSignal,
  timeoutMs: number = TIMEOUT,
  title?: string,
): Promise<string | null> {
  const classic = await findWorkingSteamArt(appId, signal);
  if (classic) return classic;

  if (title) {
    const grid = await fetchSteamGridDbCover(appId, title, signal);
    if (grid) return grid;
    // Backloggd serves IGDB's portrait covers, which cover the games whose
    // store page only has a landscape capsule.
    const igdb = await fetchIgdbCover(title, signal);
    if (igdb) return igdb;
  }

  const page = await fetchText(`${STORE_APP_URL}/${appId}/?l=english&cc=US`, {
    signal,
    timeoutMs,
    attempts: 2,
    headers: { Accept: "text/html", Referer: "https://store.steampowered.com/" },
  }).catch(() => "");
  if (!page) return null;

  const { portrait, wide } = steamArtUrlsFromPage(page);
  return portrait ?? wide;
}

/**
 * SteamGridDB API integration (requires STEAMGRIDDB_API_KEY environment variable).
 * Returns a vertical grid URL if available.
 */
async function fetchSteamGridDbCover(
  appId: string,
  title: string,
  signal: AbortSignal,
): Promise<string | null> {
  const apiKey = process.env.STEAMGRIDDB_API_KEY ?? "317c97221a01dc0c92152bb0d8eebfa7";
  if (!apiKey) return null;

  try {
    // SteamGridDB knows the game by its Steam app id, which is exact. The
    // title search is only a fallback for the games it has not linked yet.
    const byAppId = await steamGridDbIdForSteamApp(appId, signal);
    if (byAppId) {
      const url = await steamGridDbPortrait(byAppId, signal);
      if (url) return url;
    }

    // The autocomplete lists several games with similar names, and the first
    // one is often a different game entirely ("DressMaker" for "Dressmaker",
    // or a bundle that merely shares the words). Only a title that names the
    // same game is used.
    const searchUrl = `https://www.steamgriddb.com/api/v2/search/autocomplete/${encodeURIComponent(title)}`;
    const searchRes = await fetch(searchUrl, {
      signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    });
    if (!searchRes.ok) return null;
    const searchData = (await searchRes.json()) as {
      data?: Array<{ id: number; name: string; url: string; width: number; height: number; type: string }>;
    };
    if (!searchData.data?.length) return null;

    const candidates = searchData.data.filter((c) => isSameGameTitle(c.name, title));

    for (const c of candidates) {
      const url = await steamGridDbPortrait(c.id, signal);
      if (url) return url;
    }
    return null;
  } catch {
    return null;
  }
}

/** The SteamGridDB game id that links to a Steam app id, if there is one. */
async function steamGridDbIdForSteamApp(
  appId: string,
  signal: AbortSignal,
): Promise<number | null> {
  const apiKey = process.env.STEAMGRIDDB_API_KEY ?? "317c97221a01dc0c92152bb0d8eebfa7";
  if (!apiKey) return null;
  try {
    const res = await fetch(`https://www.steamgriddb.com/api/v2/games/steam/${appId}`, {
      signal,
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    const doc = (await res.json()) as { success?: boolean; data?: { id: number } };
    return doc.success && doc.data ? doc.data.id : null;
  } catch {
    return null;
  }
}

/** The best portrait (2:3-ish) grid of one SteamGridDB game. */
async function steamGridDbPortrait(gameId: number, signal: AbortSignal): Promise<string | null> {
  const apiKey = process.env.STEAMGRIDDB_API_KEY ?? "317c97221a01dc0c92152bb0d8eebfa7";
  if (!apiKey) return null;
  try {
    const gridsRes = await fetch(`https://www.steamgriddb.com/api/v2/grids/game/${gameId}`, {
      signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    });
    if (!gridsRes.ok) return null;
    const gridsData = (await gridsRes.json()) as {
      data?: Array<{ url: string; width: number; height: number; type: string }>;
    };
    if (!gridsData.data?.length) return null;

    // Prefer vertical grids (portrait) close to 600x900 (2:3 ratio)
    const vertical = gridsData.data
      .filter((g) => g.height > g.width)
      .sort((a, b) => {
        const aRatio = a.width / a.height;
        const bRatio = b.width / b.height;
        const target = 2 / 3;
        return Math.abs(aRatio - target) - Math.abs(bRatio - target);
      });

    return vertical[0]?.url ?? null;
  } catch {
    return null;
  }
}

export const steam = {
  id: "steam" as Source,
  label: "Steam",

  async search(query: string, signal: AbortSignal, timeoutMs: number = TIMEOUT): Promise<Hit[]> {
    const url =
      `${SEARCH_URL}?term=${encodeURIComponent(query)}&start=0&count=30&infinite=1` +
      `&cc=us&l=english&v=1`;
    const doc = await fetchJson<SearchEnvelope>(url, {
      signal,
      timeoutMs,
      attempts: 2,
      headers: { Accept: "application/json", Referer: "https://store.steampowered.com/" },
    });
    if (!doc || typeof doc.results_html !== "string") return [];

    const hits: Hit[] = [];
    for (const row of splitRows(doc.results_html)) {
      const titleM = row.html.match(/<span class="title">([\s\S]*?)<\/span>/);
      if (!titleM) continue;
      const title = stripTags(titleM[1]);
      if (!title) continue;

      const dateM = row.html.match(
        /<div class="search_released responsive_secondrow">\s*([\s\S]*?)\s*<\/div>/,
      );
      const year = parseYear(dateM ? stripTags(dateM[1]) : null);
      const price = parsePrice(row.html);

      hits.push({
        id: `steam:${row.id}`,
        title,
        year,
        summary: null,
        image: steamArtUrl(row.id),
        platform: "PC" as Platform,
        sources: ["steam" as Source],
        price: price === "Free" ? "Free" : price,
        metacritic: null,
        developers: [],
        publishers: [],
        platformsAvailable: ["PC"],
        metacriticSlug: null,
        genres: [],
        url: `https://store.steampowered.com/app/${row.id}/`,
      });
    }
    return hits;
  },

  /** Full metadata for one app id; used to fill in what search omits. */
  async details(
    appId: string,
    signal: AbortSignal,
    timeoutMs: number = TIMEOUT,
  ): Promise<Partial<Hit> | null> {
    const url = `${DETAILS_URL}?appids=${encodeURIComponent(appId)}&cc=us&l=en`;
    const doc = await fetchJson<Record<string, AppDetails>>(url, { signal, timeoutMs, attempts: 2 });
    const d = doc?.[appId]?.data;
    if (!d) return null;
    return {
      title: d.name ?? undefined,
      summary: d.short_description ?? undefined,
      year: parseYear(d.release_date?.date),
      price:
        d.price_overview?.final_formatted ??
        d.price_overview?.initial_formatted ??
        undefined,
      metacritic: d.metacritic?.score ?? undefined,
      developers: d.developers ?? [],
      publishers: d.publishers ?? [],
      platformsAvailable:
        d.platforms?.windows || d.platforms?.mac || d.platforms?.linux ? ["PC"] : undefined,
      genres: d.genres?.map((g) => g.description) ?? [],
    };
  },

  /** 600x900 art for an app id, falling back to the 300x450 variant. */
  artUrl(appId: string): string {
    return steamArtUrl(appId);
  },

  /** Try SteamGridDB first (if API key set), then fall back to Steam CDN multi-format search. */
  async fetchGridDbCover(appId: string, title: string, signal: AbortSignal): Promise<string | null> {
    const gridDb = await fetchSteamGridDbCover(appId, title, signal);
    if (gridDb) return gridDb;
    return findWorkingSteamArt(appId, signal);
  },
  /** List vertical SteamGridDB cover URLs for a title (for the picker). */
  async listGridDbCovers(title: string, signal: AbortSignal): Promise<string[]> {
    const apiKey = process.env.STEAMGRIDDB_API_KEY ?? "317c97221a01dc0c92152bb0d8eebfa7";
    if (!apiKey) return [];
    try {
      const searchUrl = `https://www.steamgriddb.com/api/v2/search/autocomplete/${encodeURIComponent(title)}`;
      const searchRes = await fetch(searchUrl, { signal, headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` } });
      if (!searchRes.ok) return [];
      const searchData = (await searchRes.json()) as { data?: Array<{ id: number }> };
      if (!searchData.data?.length) return [];
      const gameId = searchData.data[0].id;
      const gridsUrl = `https://www.steamgriddb.com/api/v2/grids/game/${gameId}`;
      const gridsRes = await fetch(gridsUrl, { signal, headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` } });
      if (!gridsRes.ok) return [];
      const gridsData = (await gridsRes.json()) as { data?: Array<{ url: string; width: number; height: number; type: string }> };
      if (!gridsData.data?.length) return [];
      return gridsData.data
        .filter((g) => g.height > g.width)
        .sort((a, b) => Math.abs(a.width / a.height - 2 / 3) - Math.abs(b.width / b.height - 2 / 3))
        .map((g) => g.url)
        .slice(0, 9);
    } catch {
      return [];
    }
  },
};
