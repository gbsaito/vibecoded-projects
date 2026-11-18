export const Status = {
  Watchlist: "Watchlist",
  Watching: "Watching",
  Completed: "Completed",
  OnHold: "OnHold",
  Dropped: "Dropped",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

export const STATUS_ALL: readonly Status[] = [
  Status.Watchlist,
  Status.Watching,
  Status.Completed,
  Status.OnHold,
  Status.Dropped,
];

const STATUS_LABEL: Record<Status, string> = {
  Watchlist: "watchlist",
  Watching: "watching",
  Completed: "completed",
  OnHold: "on hold",
  Dropped: "dropped",
};

const STATUS_ICON: Record<Status, string> = {
  Watchlist: "\uf087",
  Watching: "\uf06e",
  Completed: "\uf00c",
  OnHold: "\uf04c",
  Dropped: "\uf00d",
};

export const statusLabel = (s: Status): string => STATUS_LABEL[s];
export const statusIcon = (s: Status): string => STATUS_ICON[s];

export const Kind = {
  Movie: "Movie",
  Series: "Series",
} as const;
export type Kind = (typeof Kind)[keyof typeof Kind];

export const MAX_RATING = 5;

export interface Progress {
  seen: number;
  total: number;
}

export interface Entry {
  id: string;
  title: string;
  kind: Kind;
  status: Status;
  rating: number | null;
  progress: Progress | null;
  year: number | null;
  summary: string | null;
  image: string | null;
  weight: number | null;
  avgRating: number | null;
  provider: string;
  format?: string | null;
  genres?: string[];
  externalLinks?: ExternalLink[];
}

export const Sort = {
  Added: "Added",
  Title: "Title",
  Year: "Year",
  MyRating: "MyRating",
  Community: "Community",
  Popularity: "Popularity",
  Remaining: "Remaining",
} as const;
export type Sort = (typeof Sort)[keyof typeof Sort];

export const SORT_ALL: readonly Sort[] = [
  Sort.Added,
  Sort.Title,
  Sort.Year,
  Sort.MyRating,
  Sort.Community,
  Sort.Popularity,
  Sort.Remaining,
];

const SORT_LABEL: Record<Sort, string> = {
  Added: "added",
  Title: "title",
  Year: "year",
  MyRating: "my rating",
  Community: "community rating",
  Popularity: "popularity",
  Remaining: "remaining",
};

export const sortLabel = (s: Sort): string => SORT_LABEL[s];

export function nextSort(s: Sort): Sort {
  const i = SORT_ALL.indexOf(s);
  return SORT_ALL[(i + 1) % SORT_ALL.length];
}

export const Theme = {
  Dark: "Dark",
  Light: "Light",
} as const;
export type Theme = (typeof Theme)[keyof typeof Theme];

export const StreamingService = {
  Crunchyroll: "crunchyroll",
  Netflix: "netflix",
  Hulu: "hulu",
  HiDive: "hidive",
  Disney: "disney",
  Amazon: "amazon",
  HboMax: "hbomax",
} as const;
export type StreamingService = (typeof StreamingService)[keyof typeof StreamingService];

export const STREAMING_LABEL: Record<StreamingService, string> = {
  crunchyroll: "Crunchyroll",
  netflix: "Netflix",
  hulu: "Hulu",
  hidive: "HiDive",
  disney: "Disney+",
  amazon: "Amazon Prime",
  hbomax: "HBO Max",
};

export const streamingUrl = (s: StreamingService): string => {
  switch (s) {
    case "crunchyroll": return "https://www.crunchyroll.com";
    case "netflix": return "https://www.netflix.com";
    case "hulu": return "https://www.hulu.com";
    case "hidive": return "https://www.hidive.com";
    case "disney": return "https://www.disneyplus.com";
    case "amazon": return "https://www.amazon.com";
    case "hbomax": return "https://www.max.com";
  }
};

/** Build a search URL for a title on the chosen streaming service. */
export const streamingSearchUrl = (s: StreamingService, title: string): string => {
  const q = encodeURIComponent(title);
  switch (s) {
    case "crunchyroll": return `https://www.crunchyroll.com/search?q=${q}`;
    case "netflix": return `https://www.netflix.com/search?q=${q}`;
    case "hulu": return `https://www.hulu.com/search?q=${q}`;
    case "hidive": return `https://www.hidive.com/search?q=${q}`;
    case "disney": return `https://www.disneyplus.com/search/${q}`;
    case "amazon": return `https://www.amazon.com/s?k=${q}`;
    case "hbomax": return `https://www.max.com/search?q=${q}`;
  }
};

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const cmpN = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0);

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

function hasValue(s: Sort, e: Entry): boolean {
  switch (s) {
    case Sort.Added:
    case Sort.Title:
      return true;
    case Sort.Year:
      return e.year !== null;
    case Sort.MyRating:
      return e.rating !== null;
    case Sort.Community:
      return e.avgRating !== null;
    case Sort.Popularity:
      return e.weight !== null;
    case Sort.Remaining:
      return e.progress !== null;
  }
}

export function applySort(entries: Entry[], s: Sort, descending: boolean): Entry[] {
  const isAdded = s === Sort.Added;
  if (isAdded) return entries;

  switch (s) {
    case Sort.Title:
      entries.sort(
        (a, b) => cmp(a.title.toLowerCase(), b.title.toLowerCase()) || cmp(a.id, b.id),
      );
      break;
    case Sort.Year:
      entries.sort((a, b) => cmpOpt(a.year, b.year, cmpN, true) || cmp(a.title, b.title));
      break;
    case Sort.MyRating:
      entries.sort((a, b) => cmpOpt(a.rating, b.rating, cmpN, true) || cmp(a.title, b.title));
      break;
    case Sort.Community:
      entries.sort(
        (a, b) => cmpOpt(a.avgRating, b.avgRating, cmpN, true) || cmp(a.title, b.title),
      );
      break;
    case Sort.Popularity:
      entries.sort((a, b) => cmpOpt(a.weight, b.weight, cmpN, true) || cmp(a.title, b.title));
      break;
    case Sort.Remaining:
      entries.sort((a, b) => cmpN(remaining(a), remaining(b)) || cmp(a.title, b.title));
      break;
  }

  if (descending) {
    const known: Entry[] = [];
    const unknown: Entry[] = [];
    for (const e of entries) (hasValue(s, e) ? known : unknown).push(e);
    known.reverse();
    entries.length = 0;
    entries.push(...known, ...unknown);
  }
  return entries;
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

export function remaining(e: Entry): number {
  if (!e.progress) return 0;
  return Math.max(0, e.progress.total - e.progress.seen);
}

export interface ExternalLink {
  url: string;
  site: string;
  type: string;
}

export interface Hit {
  id: string;
  title: string;
  kind?: Kind;
  year: number | null;
  summary: string | null;
  image: string | null;
  weight: number | null;
  avgRating: number | null;
  episodes: number | null;
  provider: string;
  format: string | null;
  genres: string[];
  externalLinks?: ExternalLink[];
}

export function hitToEntry(h: Hit, status: Status = Status.Watchlist): Entry {
  return {
    id: h.id,
    title: h.title,
    kind: h.kind ?? Kind.Series,
    status,
    rating: null,
    progress: h.episodes ? { seen: 0, total: h.episodes } : null,
    year: h.year,
    summary: h.summary,
    image: h.image,
    weight: h.weight,
    avgRating: h.avgRating,
    provider: h.provider,
    format: h.format,
    genres: h.genres,
    externalLinks: h.externalLinks,
  };
}
