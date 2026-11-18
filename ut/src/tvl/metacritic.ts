/**
 * Metacritic metadata.
 *
 * Metacritic publishes the data behind its game pages through keyless public
 * endpoints, so no account or personal API key is involved:
 *
 *  - `backend.metacritic.com/finder/metacritic/...` returns search and
 *    popularity lists as JSON (title, year, Metascore, platforms, genres,
 *    summary, card art).
 *  - The public game page carries a schema.org `VideoGame` block plus the
 *    developer/publisher names that the list response omits.
 *
 * Only a single game page is fetched, for the highlighted result, and the
 * result is cached. If Metacritic is unreachable the storefront data is still
 * perfectly usable: every caller treats this module as optional.
 */

import type { Hit } from "./model.ts";
import { fetchJson, fetchText } from "./net.ts";

const FINDER = "https://backend.metacritic.com/finder/metacritic";
const GAME = "https://www.metacritic.com/game";
const IMAGE = "https://www.metacritic.com/a/img/catalog";
const TIMEOUT = 8000;

/** Keep the payload small: search returns the first page only. */
const SEARCH_LIMIT = 20;
const CACHE_MS = 10 * 60 * 1000;
const DETAIL_CACHE_MS = 24 * 60 * 60 * 1000;

export interface McHit {
  id: number;
  title: string;
  slug: string;
  year: number | null;
  releaseDate: string | null;
  metacritic: number | null;
  platforms: string[];
  genres: string[];
  summary: string | null;
  image: string | null;
  url: string;
}

export interface McDetails {
  slug: string;
  title: string | null;
  year: number | null;
  metacritic: number | null;
  platforms: string[];
  genres: string[];
  summary: string | null;
  image: string | null;
  developers: string[];
  publishers: string[];
}

interface CacheEntry<T> {
  at: number;
  value: T;
}

const searchCache = new Map<string, CacheEntry<McHit[]>>();
const detailCache = new Map<string, CacheEntry<McDetails | null>>();

function fresh<T>(entry: CacheEntry<T> | undefined, maxAge: number): entry is CacheEntry<T> {
  return !!entry && Date.now() - entry.at < maxAge;
}

interface McListItem {
  id?: number;
  title?: string;
  slug?: string;
  premiereYear?: number | null;
  releaseDate?: string | null;
  description?: string | null;
  criticScoreSummary?: { score?: number | null } | null;
  platforms?: Array<{ name?: string } | string> | null;
  genres?: Array<{ name?: string } | string> | null;
  image?: {
    bucketPath?: string | null;
    imageUrl?: string | null;
  } | null;
}

interface McListResponse {
  data?: {
    items?: McListItem[];
  };
}

interface LdVideoGame {
  "@type"?: string | string[];
  name?: string;
  datePublished?: string;
  description?: string;
  image?: string | string[];
  genre?: string | string[];
  gamePlatform?: string | string[];
  aggregateRating?: { ratingValue?: number | string } | null;
  publisher?: Array<{ name?: string } | string> | { name?: string } | string | null;
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function yearOf(date: string | null | undefined): number | null {
  if (!date) return null;
  const match = date.match(/(\d{4})/);
  if (!match) return null;
  const year = Number(match[1]);
  return Number.isFinite(year) && year > 1950 ? year : null;
}

function names(list: Array<{ name?: string } | string> | null | undefined): string[] {
  if (!list) return [];
  const out: string[] = [];
  for (const item of list) {
    const name = typeof item === "string" ? item : item.name;
    const clean = name ? decode(name).trim() : "";
    if (clean && !out.includes(clean)) out.push(clean);
  }
  return out;
}

function listItemToHit(item: McListItem): McHit | null {
  const title = item.title ? decode(item.title).trim() : "";
  const slug = item.slug?.trim();
  if (!title || !slug) return null;
  const bucket = item.image?.bucketPath?.trim();
  const score = item.criticScoreSummary?.score;
  return {
    id: typeof item.id === "number" ? item.id : 0,
    title,
    slug,
    year: item.premiereYear ?? yearOf(item.releaseDate),
    releaseDate: item.releaseDate ?? null,
    // Metacritic reports 0 for titles it has no score for yet; a real
    // Metascore is 1-100.
    metacritic: typeof score === "number" && score > 0 ? score : null,
    platforms: names(item.platforms),
    genres: names(item.genres),
    summary: item.description ? decode(item.description).trim() : null,
    image: bucket ? `${IMAGE}${bucket}` : (item.image?.imageUrl ?? null),
    url: `${GAME}/${slug}/`,
  };
}

/** Remove generic edition labels that storefronts tack onto a title. */
function baseTitle(title: string): string {
  return stripAccents(title)
    .toLowerCase()
    .replace(/[™®©]/g, "")
    .replace(/&/g, "and")
    .replace(
      /\b(?:complete|deluxe|definitive|ultimate|premium|gold|enhanced|collector'?s|special|legendary|standard|launch|game of the year|goty)\s+edition\b/gi,
      "",
    )
    .replace(/[^a-z0-9]+/g, "");
}

function normTitle(title: string): string {
  return stripAccents(title)
    .toLowerCase()
    .replace(/[™®©]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");
}

/** Fold diacritics so "Pokémon" matches "Pokemon". */
function stripAccents(title: string): string {
  return title.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function stripRemakeSuffix(title: string): string {
  return normTitle(title).replace(/(?:remake|remastered|remaster)$/, "");
}

/**
 * A storefront title with platform/edition noise removed, used as a Metacritic
 * lookup term. Nintendo, for example, appends "– Nintendo Switch 2 Edition".
 */
export function lookupTitle(title: string): string {
  return title
    .replace(/\s*[–—-]\s*[^–—-]*(?:edition|version)\b.*$/i, "")
    .replace(/\s*\((?:nintendo\s+)?switch(?:\s*2)?(?:\s+edition)?\)\s*$/i, "")
    .trim();
}

function closeYear(a: number | null, b: number | null): boolean {
  return a === null || b === null || Math.abs(a - b) <= 1;
}

/**
 * Find the Metacritic record for a storefront title. Exact title wins; then
 * edition suffixes are ignored; then "Remake"/"Remastered" suffixes. The
 * year guard keeps a remake from matching the original release.
 */
export function matchMetacritic(
  title: string,
  year: number | null,
  results: readonly McHit[],
): McHit | null {
  if (!results.length) return null;
  const exact = normTitle(title);
  const base = baseTitle(title);
  const bare = stripRemakeSuffix(title);

  return (
    results.find((r) => normTitle(r.title) === exact && closeYear(year, r.year)) ??
    results.find((r) => normTitle(r.title) === exact) ??
    results.find((r) => baseTitle(r.title) === base && closeYear(year, r.year)) ??
    results.find((r) => stripRemakeSuffix(r.title) === bare && closeYear(year, r.year)) ??
    null
  );
}

function dlcTitle(title: string): boolean {
  return /\b(?:dlc|expansion|season pass|add-?on|soundtrack|artbook|art book|cosmetic|skin pack|character pack|weapon pack)\b/i.test(
    title,
  );
}

/** Search the public catalogue. */
export async function search(
  query: string,
  signal: AbortSignal,
  timeoutMs: number = TIMEOUT,
): Promise<McHit[]> {
  const q = query.trim();
  if (!q) return [];
  const key = q.toLowerCase();
  const cached = searchCache.get(key);
  if (fresh(cached, CACHE_MS)) return cached.value;

  const url = `${FINDER}/search/${encodeURIComponent(q)}/web?mcoTypeId=13&offset=0&limit=${SEARCH_LIMIT}`;
  const doc = await fetchJson<McListResponse>(url, {
    signal,
    timeoutMs,
    attempts: 2,
    accept: "application/json",
  });
  const hits = (doc.data?.items ?? [])
    .map(listItemToHit)
    .filter((h): h is McHit => h !== null && !dlcTitle(h.title));

  searchCache.set(key, { at: Date.now(), value: hits });
  return hits;
}

function groupNames(list: string[]): string[] {
  return [...new Set(list.map((s) => decode(s).trim()).filter(Boolean))];
}

function collectHtmlNames(html: string, field: "Developer" | "Publisher"): string[] {
  const out: string[] = [];
  const re = new RegExp(`"${field}","([^"]+)"`, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const raw = match[1];
    let name = raw;
    try {
      name = JSON.parse(`"${raw}"`) as string;
    } catch {
      /* the RSC payload can contain escapes that are not valid JSON alone */
    }
    name = decode(name).trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

function ldName(value: LdVideoGame["publisher"]): string[] {
  if (!value) return [];
  if (typeof value === "string") return [decode(value).trim()];
  if (Array.isArray(value)) {
    return value.flatMap((v) => (typeof v === "string" ? [decode(v).trim()] : v.name ? [decode(v.name).trim()] : []));
  }
  return value.name ? [decode(value.name).trim()] : [];
}

function asList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).map((s) => decode(s).trim()).filter(Boolean);
}

function parseVideoGame(html: string): LdVideoGame | null {
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1]) as LdVideoGame | LdVideoGame[];
      for (const doc of Array.isArray(parsed) ? parsed : [parsed]) {
        const type = Array.isArray(doc["@type"]) ? doc["@type"] : [doc["@type"]];
        if (type.includes("VideoGame")) return doc;
      }
    } catch {
      /* skip malformed blocks */
    }
  }
  return null;
}

/** Full details, including developer/publisher names, for one slug. */
export async function details(
  slug: string,
  signal: AbortSignal,
  timeoutMs: number = TIMEOUT,
): Promise<McDetails | null> {
  const cached = detailCache.get(slug);
  if (fresh(cached, DETAIL_CACHE_MS)) return cached.value;

  const html = await fetchText(`${GAME}/${encodeURIComponent(slug)}/`, {
    signal,
    timeoutMs,
    attempts: 2,
  });
  const ld = parseVideoGame(html);
  if (!ld && !html.includes('"Developer"')) {
    detailCache.set(slug, { at: Date.now(), value: null });
    return null;
  }

  const developers = groupNames(collectHtmlNames(html, "Developer"));
  const publishers = groupNames(collectHtmlNames(html, "Publisher"));
  const ldPublishers = groupNames(ldName(ld?.publisher ?? null));
  // A self-published game lists only the developer. Use schema.org's publisher
  // as a fallback, but drop duplicates when both fields are present.
  const publisherNames =
    publishers.length > 0
      ? publishers
      : ldPublishers.filter((p) => !developers.includes(p)).length
        ? ldPublishers.filter((p) => !developers.includes(p))
        : ldPublishers;

  const score = ld?.aggregateRating?.ratingValue;
  const metacritic =
    typeof score === "number" ? Math.round(score) : typeof score === "string" ? Number(score) : null;

  const value: McDetails = {
    slug,
    title: ld?.name ? decode(ld.name).trim() : null,
    year: yearOf(ld?.datePublished),
    metacritic: typeof metacritic === "number" && metacritic > 0 ? metacritic : null,
    platforms: asList(ld?.gamePlatform),
    genres: asList(ld?.genre),
    summary: ld?.description ? decode(ld.description).trim() : null,
    image: asList(ld?.image)[0] ?? null,
    developers,
    publishers: publisherNames,
  };
  detailCache.set(slug, { at: Date.now(), value });
  return value;
}

/** Merge a Metacritic record into a storefront hit without losing store data. */
export function applyMc(hit: Hit, mc: McHit): void {
  hit.metacritic = mc.metacritic ?? hit.metacritic;
  hit.platformsAvailable = mc.platforms.length ? mc.platforms : hit.platformsAvailable;
  hit.genres = hit.genres.length ? hit.genres : mc.genres;
  hit.summary = hit.summary ?? mc.summary;
  hit.image = hit.image ?? mc.image;
  hit.metacriticSlug = mc.slug;
  hit.url = hit.url ?? mc.url;
}
