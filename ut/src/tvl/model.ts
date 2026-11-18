/**
 * Domain model for the game tracker.
 *
 * A game is a `Game` (title, year, cover art, sources) tracked in a `Status`
 * bucket, with a personal rating and a playtime log. `Hit` is the search-side
 * shape: a candidate game that is not yet tracked.
 */

export const Status = {
  Backlog: "Backlog",
  Playing: "Playing",
  Played: "Played",
  Abandoned: "Abandoned",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

export const STATUS_ALL: readonly Status[] = [
  Status.Backlog,
  Status.Playing,
  Status.Played,
  Status.Abandoned,
];

export type StatusFilter = Status | "All";
export const STATUS_FILTERS: readonly StatusFilter[] = ["All", ...STATUS_ALL];

const STATUS_LABEL: Record<Status, string> = {
  Backlog: "backlog",
  Playing: "playing",
  Played: "played",
  Abandoned: "abandoned",
};

const STATUS_ICON: Record<Status, string> = {
  Backlog: "\uf087", // bookmark
  Playing: "\uf06e", // play
  Played: "\uf00c", // check
  Abandoned: "\uf00d", // times
};

export const statusLabel = (s: Status): string => STATUS_LABEL[s];
export const statusIcon = (s: Status): string => STATUS_ICON[s];

/** Where a game came from. Multiple sources can list the same game. */
export const Source = {
  Steam: "steam",
  Epic: "epic",
  PlayStation: "playstation",
  Nintendo: "nintendo",
} as const;
export type Source = (typeof Source)[keyof typeof Source];

export const SOURCE_LABEL: Record<Source, string> = {
  steam: "Steam",
  epic: "Epic",
  playstation: "PlayStation",
  nintendo: "Nintendo",
};

/** Storefront a game is played on. Not the same as the data source. */
export const Platform = {
  PC: "PC",
  PS4: "PS4",
  PS5: "PS5",
  Switch: "Switch",
  Switch2: "Switch2",
  Xbox: "Xbox",
} as const;
export type Platform = (typeof Platform)[keyof typeof Platform];

export const PLATFORM_LABEL: Record<Platform, string> = {
  PC: "PC",
  PS4: "PS4",
  PS5: "PS5",
  Switch: "Switch",
  Switch2: "Switch 2",
  Xbox: "Xbox",
};

export const PLATFORM_ORDER: readonly (Platform | null)[] = [
  null,
  Platform.PC,
  Platform.PS4,
  Platform.PS5,
  Platform.Switch,
  Platform.Switch2,
  Platform.Xbox,
];

export const MAX_RATING = 5;

/** Hours played. `null` means "not started". */
export interface Playtime {
  hours: number;
}

export interface Game {
  id: string;
  title: string;
  status: Status;
  rating: number | null;
  playtime: Playtime | null;
  year: number | null;
  summary: string | null;
  /** Cover art, 600x900 where the source allows it. */
  image: string | null;
  platform: Platform | null;
  /** Storefront(s) the game is available on. */
  sources: Source[];
  /** Price as displayed by the store, e.g. "$59.99". */
  price: string | null;
  /** Metacritic score, 0-100. */
  metacritic: number | null;
  /** Metadata from Metacritic (fetched lazily). */
  developers: string[];
  publishers: string[];
  /** Platforms the game is available on, e.g. "PC", "PlayStation 5". */
  platformsAvailable: string[];
  /** Metacritic slug, used to fetch developer/publisher details. */
  metacriticSlug: string | null;
  genres: string[];
  /** Store page, opened with `u`. */
  url: string | null;
  /** Wishlist entries live in their own tab, like a second library. */
  wishlist: boolean;
  /** Separate from status: finished 100%, not merely played. */
  hundredPercent: boolean;
  addedAt: number;
}

/**
 * Stable identity for a tracked game. Storefronts give the same game different
 * ids, so title + year is what keeps one record per game across sources and
 * across the library/wishlist split. Case, punctuation, diacritics and spacing
 * are ignored; a known year must match.
 */
export function gameKey(title: string, year: number | null): string {
  const folded = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const slug = folded.replace(/[^a-z0-9]+/g, "");
  // Non-Latin titles can fold to an empty slug; fall back to their raw text so
  // different games do not collapse into one empty key.
  const identity = slug || folded.replace(/\s+/g, " ").trim();
  return year === null ? identity : `${identity}:${year}`;
}

export function sameGame(
  a: Pick<Game, "id" | "title" | "year">,
  b: Pick<Game, "id" | "title" | "year">,
): boolean {
  return a.id === b.id || gameKey(a.title, a.year) === gameKey(b.title, b.year);
}

/**
 * Fold a title down to its searchable words: lower case, no diacritics, no
 * trademark marks and no punctuation. Storefronts decorate their titles
 * ("Gran Turismo® 7", "Sang: The Desert Blade"), so a raw comparison against
 * what the user typed never matches.
 *
 * Apostrophes are dropped rather than turned into a separator, so "Volvy's
 * Adventure" folds to "volvys adventure" and not "volvy s adventure".
 */
export function normalizeTitle(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u00ae\u2122\u00a9\u2117\u2120]/g, "")
    .toLowerCase()
    .replace(/['\u2019\u02bc\u055a]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Whether a word in the title starts a run of initials that spells `token`,
 * e.g. "yomi" against "your only move is hustle" (Y + O + M + I) or "zato"
 * against "z a t o i love the world".
 */
function spellsInitials(token: string, words: readonly string[]): boolean {
  const target = token.toUpperCase();
  if (!target) return false;
  for (let start = 0; start < words.length; start++) {
    let acc = "";
    for (let i = start; i < words.length && acc.length < target.length; i++) {
      acc += (words[i][0] ?? "").toUpperCase();
    }
    if (acc.startsWith(target)) return true;
  }
  return false;
}

/**
 * How well a title answers a query. Exact and prefix matches win, then an
 * abbreviation of the title ("yomi hustle" for "Your Only Move Is Hustle"),
 * then a whole-word match, then a partial one; a title that shares no word
 * with the query scores zero.
 */
export function titleRelevance(title: string, query: string): number {
  const t = normalizeTitle(title);
  const q = normalizeTitle(query);
  if (!q || !t) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(t)) return 70;
  if (t.includes(q)) return 60;
  const tokens = q.split(" ").filter(Boolean);
  const words = t.split(" ");
  const matched = tokens.filter((tok) => t.includes(tok) || spellsInitials(tok, words)).length;
  if (matched === tokens.length) {
    // Every word answered: an abbreviation of the title ("yomi hustle" for
    // "Your Only Move Is Hustle") sits just below a prefix match.
    const abbreviated = tokens.some((tok) => !t.includes(tok));
    if (abbreviated) return 75;
  }
  return matched === 0 ? 0 : (matched / tokens.length) * 40;
}

/**
 * Whether two titles name the same game.
 *
 * This is much stricter than `titleRelevance`, which is for ranking. Cover art
 * must belong to the game itself: "Into the Wind" is not
 * "Whispered Secrets: Into the Wind Collector's Edition", even though the
 * words match. A trailing year or edition marker is allowed.
 */
export function isSameGameTitle(candidate: string, title: string): boolean {
  const c = normalizeTitle(candidate);
  const t = normalizeTitle(title);
  if (!c || !t) return false;
  if (c === t) return true;
  if (!c.startsWith(`${t} `)) return false;
  const rest = c.slice(t.length + 1);
  // "into the wind 2026", "dressmaker deluxe edition", ...
  return /^\d{4}$/.test(rest) || /^(deluxe|ultimate|complete|definitive|remastered|goty|enhanced|anniversary|collector|standard|ultimate deluxe)[\w\s]*$/.test(rest);
}

export const Sort = {
  Added: "Added",
  Title: "Title",
  Year: "Year",
  MyRating: "MyRating",
  Metacritic: "Metacritic",
  Playtime: "Playtime",
} as const;
export type Sort = (typeof Sort)[keyof typeof Sort];

export const SORT_ALL: readonly Sort[] = [
  Sort.Added,
  Sort.Title,
  Sort.Year,
  Sort.MyRating,
  Sort.Metacritic,
  Sort.Playtime,
];

const SORT_LABEL: Record<Sort, string> = {
  Added: "added",
  Title: "title",
  Year: "year",
  MyRating: "my rating",
  Metacritic: "metacritic",
  Playtime: "playtime",
};

export const sortLabel = (s: Sort): string => SORT_LABEL[s];

export function nextSort(s: Sort): Sort {
  const i = SORT_ALL.indexOf(s);
  return SORT_ALL[(i + 1) % SORT_ALL.length];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const cmpN = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0);
/** Platform rank for ordering: PC versions before console ones. */
const platformRank = (p: Platform | null): number => {
  const i = PLATFORM_ORDER.indexOf(p);
  return i < 0 ? PLATFORM_ORDER.length - 1 : i;
};
const cmpPlatform = (a: Platform | null, b: Platform | null): number => platformRank(a) - platformRank(b);

function cmpOpt<T>(
  a: T | null,
  b: T | null,
  inner: (x: T, y: T) => number,
  swap: boolean,
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return swap ? inner(b, a) : inner(a, b);
}

function hasValue(s: Sort, g: Game): boolean {
  switch (s) {
    case Sort.Added:
    case Sort.Title:
      return true;
    case Sort.Year:
      return g.year !== null;
    case Sort.MyRating:
      return g.rating !== null;
    case Sort.Metacritic:
      return g.metacritic !== null;
    case Sort.Playtime:
      return g.playtime !== null;
  }
}

export function applySort(games: Game[], s: Sort, descending: boolean): Game[] {
  if (s === Sort.Added) return games;

  switch (s) {
    case Sort.Title:
      games.sort(
        (a, b) =>
          cmp(a.title.toLowerCase(), b.title.toLowerCase()) ||
          cmpPlatform(a.platform, b.platform) ||
          cmp(a.id, b.id),
      );
      break;
    case Sort.Year:
      games.sort(
        (a, b) =>
          cmpOpt(a.year, b.year, cmpN, true) ||
          cmp(a.title, b.title) ||
          cmpPlatform(a.platform, b.platform),
      );
      break;
    case Sort.MyRating:
      games.sort(
        (a, b) =>
          cmpOpt(a.rating, b.rating, cmpN, true) ||
          cmp(a.title, b.title) ||
          cmpPlatform(a.platform, b.platform),
      );
      break;
    case Sort.Metacritic:
      games.sort(
        (a, b) =>
          cmpOpt(a.metacritic, b.metacritic, cmpN, true) ||
          cmp(a.title, b.title) ||
          cmpPlatform(a.platform, b.platform),
      );
      break;
    case Sort.Playtime:
      games.sort(
        (a, b) =>
          cmpOpt(a.playtime?.hours ?? null, b.playtime?.hours ?? null, cmpN, true) ||
          cmp(a.title, b.title) ||
          cmpPlatform(a.platform, b.platform),
      );
      break;
  }

  if (descending) {
    const known: Game[] = [];
    const unknown: Game[] = [];
    for (const g of games) (hasValue(s, g) ? known : unknown).push(g);
    known.reverse();
    games.length = 0;
    games.push(...known, ...unknown);
  }
  return games;
}

/** Step a personal rating by `delta` (0.5 increments), clamped to [0, max].
 *  Returns null when the rating falls to 0 (cleared / unrated). */
export function adjustRating(
  current: number | null,
  delta: number,
  max: number = MAX_RATING,
): number | null {
  const next = Math.round(((current ?? 0) + delta) * 2) / 2;
  if (next <= 0) return null;
  return Math.min(max, Math.max(0, next));
}

export function hoursPlayed(g: Game): number {
  return g.playtime?.hours ?? 0;
}

/** A search result: a candidate game, not yet tracked. */
export interface Hit {
  id: string;
  title: string;
  year: number | null;
  summary: string | null;
  image: string | null;
  platform: Platform | null;
  sources: Source[];
  price: string | null;
  metacritic: number | null;
  developers: string[];
  publishers: string[];
  platformsAvailable: string[];
  metacriticSlug: string | null;
  genres: string[];
  url: string | null;
}

export function hitToGame(h: Hit, status: Status = Status.Backlog): Game {
  return {
    id: h.id,
    title: h.title,
    status,
    rating: null,
    playtime: null,
    year: h.year,
    summary: h.summary,
    image: h.image,
    platform: h.platform,
    sources: h.sources.length ? h.sources : [],
    price: h.price,
    metacritic: h.metacritic,
    developers: h.developers,
    publishers: h.publishers,
    platformsAvailable: h.platformsAvailable,
    metacriticSlug: h.metacriticSlug,
    genres: h.genres,
    url: h.url,
    wishlist: false,
    hundredPercent: false,
    addedAt: Date.now(),
  };
}
