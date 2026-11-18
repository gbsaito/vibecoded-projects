/**
 * Cover art from Backloggd (which serves IGDB's covers).
 *
 * IGDB's image CDN is keyless: once the cover id is known the picture can be
 * fetched directly. Backloggd's game pages are slug-addressable and name the
 * cover id, so the pair (slug lookup → image) gives a portrait cover for
 * games whose storefront only publishes a landscape capsule.
 *
 * The covers are 528x704 (2:3-ish), which is exactly what the carousel and
 * the detail pane want.
 */

import { fetchText, HttpError } from "../net.ts";
import { isSameGameTitle, normalizeTitle } from "../model.ts";

const SITE = "https://backloggd.com";
const IMAGE = "https://images.igdb.com/igdb/image/upload";

/**
 * The site serves 403 to anything that does not look like a browser, so a
 * plain user agent is required.
 */
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";

/**
 * The slug Backloggd uses for a title: the words joined by dashes, with
 * apostrophes dropped ("Volvy's Adventure" → "volvys-adventure"). A second
 * game with the same title gets a numeric suffix.
 */
function slugsFor(title: string): string[] {
  const base = normalizeTitle(title)
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) return [];
  return [base, `${base}--1`, `${base}--2`];
}

interface GamePage {
  readonly title: string;
  readonly cover: string;
}

async function gamePage(slug: string, signal: AbortSignal): Promise<GamePage | null> {
  if (igdbBlocked()) return null;
  const html = await fetchText(`${SITE}/games/${slug}/`, {
    signal,
    timeoutMs: 12000,
    attempts: 1,
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": BROWSER_UA,
      Referer: `${SITE}/`,
    },
  }).catch((e: unknown) => {
    // 403 means the host is rate-limiting; stop asking for a while.
    if (e instanceof HttpError && e.status === 403) blockedUntil = Date.now() + 5 * 60_000;
    return "";
  });
  if (!html) return null;

  const title = html
    .match(/<h1[^>]*>([\s\S]{0,120}?)<\/h1>/)?.[1]
    ?.replace(/<[^>]*>/g, "")
    .trim();
  const cover = html.match(/t_cover_big\w*\/(\w+)/)?.[1];
  if (!title || !cover) return null;
  return { title, cover };
}

/**
 * The portrait cover of a game, or null when the site does not know it.
 * The title has to match, otherwise a same-named game would supply the art.
 */
export async function fetchIgdbCover(
  title: string,
  signal: AbortSignal,
): Promise<string | null> {
  for (const slug of slugsFor(title)) {
    const page = await gamePage(slug, signal);
    if (!page) continue;
    // A "this is awkward" page is what the site shows for a missing game.
    if (!isSameGameTitle(page.title, title)) continue;
    return `${IMAGE}/t_cover_big_2x/${page.cover}.jpg`;
  }
  return null;
}

/**
 * Whether the site is currently refusing requests. It rate-limits hard, and
 * a burst of lookups gets the whole host blocked for a while.
 */
let blockedUntil = 0;

/** Skips the lookup while the host is known to be refusing requests. */
export function igdbBlocked(): boolean {
  return Date.now() < blockedUntil;
}
