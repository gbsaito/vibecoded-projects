import type { Hit } from "../model.ts";
import { fetchJson } from "../net.ts";

const ENDPOINT = "https://graphql.anilist.co";

const SEARCH_QUERY = `
query ($search: String, $page: Int, $perPage: Int, $isAdult: Boolean) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    media(
      type: ANIME
      search: $search
      isAdult: $isAdult
      sort: SEARCH_MATCH
    ) {
      id
      title { romaji english native }
      seasonYear
      format
      episodes
      averageScore
      popularity
      genres
      description(asHtml: false)
      siteUrl
      externalLinks { url site type }
      coverImage { extraLarge large }
      studios(isMain: true) { nodes { name } }
    }
  }
}`;

interface AniListMedia {
  id: number;
  title: { romaji: string | null; english: string | null; native: string | null };
  seasonYear: number | null;
  format: string | null;
  episodes: number | null;
  averageScore: number | null;
  popularity: number | null;
  genres: string[] | null;
  description: string | null;
  siteUrl: string | null;
  externalLinks: Array<{ url: string; site: string; type: string }> | null;
  coverImage: { extraLarge: string | null; large: string | null };
  studios: { nodes: Array<{ name: string }> } | null;
}

interface AniListResponse {
  data?: {
    Page?: { pageInfo?: { hasNextPage: boolean }; media?: AniListMedia[] | null };
    Media?: AniListMedia | null;
  };
  errors?: Array<{ message: string }>;
}

const MEDIA_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    title { romaji english native }
    seasonYear
    format
    episodes
    averageScore
    popularity
    genres
    description(asHtml: false)
    siteUrl
    externalLinks { url site type }
    coverImage { extraLarge large }
  }
}`;

export const anilist = {
  id: "anilist",
  label: "anime",
  supportsMovies: false,
  nsfwEnabled: false,

  async fetchMedia(
    id: number,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<{ avgRating: number | null; weight: number | null; episodes: number | null; image: string | null; summary: string | null; externalLinks: Array<{ url: string; site: string; type: string }> }> {
    const doc = await fetchJson<AniListResponse>(ENDPOINT, {
      method: "POST",
      body: JSON.stringify({ query: MEDIA_QUERY, variables: { id } }),
      signal,
      timeoutMs,
      attempts: 2,
    });
    const m = doc.data?.Media;
    if (!m) throw new Error("media not found");
    const avg = m.averageScore === null || m.averageScore === 0 ? null : m.averageScore / 10;
    return {
      avgRating: avg,
      weight: m.popularity ?? null,
      episodes: m.episodes ?? null,
      image: m.coverImage?.extraLarge ?? m.coverImage?.large ?? null,
      summary: m.description ? clean(m.description, null) : null,
      externalLinks: m.externalLinks ?? [],
    };
  },

  async trending(
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<Hit[]> {
    const query = "query ($page: Int, $perPage: Int, $isAdult: Boolean) { Page(page: $page, perPage: $perPage) { pageInfo { hasNextPage } media(type: ANIME, isAdult: $isAdult, sort: TRENDING_DESC) { id title { romaji english native } seasonYear format episodes averageScore popularity genres description(asHtml: false) siteUrl externalLinks { url site type } coverImage { extraLarge large } studios(isMain: true) { nodes { name } } } } }";
    // AniList caps perPage at 50; fetch two pages in parallel for ~100.
    const [doc1, doc2] = await Promise.all([
      fetchJson<AniListResponse>(ENDPOINT, {
        method: "POST",
        body: JSON.stringify({ query, variables: { page: 1, perPage: 50, isAdult: anilist.nsfwEnabled } }),
        signal,
        timeoutMs,
        attempts: 2,
      }),
      fetchJson<AniListResponse>(ENDPOINT, {
        method: "POST",
        body: JSON.stringify({ query, variables: { page: 2, perPage: 50, isAdult: anilist.nsfwEnabled } }),
        signal,
        timeoutMs,
        attempts: 2,
      }),
    ]);
    if (doc1.errors?.length) throw new Error(doc1.errors.map((e) => e.message).join("; "));
    const media = [...(doc1.data?.Page?.media ?? []), ...(doc2.data?.Page?.media ?? [])];
    const hits = media.map(toHit);
    // Filter NSFW (ecchi/hentai) unless explicitly enabled.
    if (!anilist.nsfwEnabled) {
      return hits.filter((h) => !h.genres.some((g) => /ecchi|hentai/i.test(g)));
    }
    return hits;
  },

  async search(
    query: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<Hit[]> {
    const doc = await fetchJson<AniListResponse>(ENDPOINT, {
      method: "POST",
      body: JSON.stringify({
        query: SEARCH_QUERY,
        variables: { search: query, page: 1, perPage: 25, isAdult: anilist.nsfwEnabled },
      }),
      signal,
      timeoutMs,
      attempts: 2,
    });

    if (doc.errors?.length) {
      throw new Error(doc.errors.map((e) => e.message).join("; "));
    }

    const media = doc.data?.Page?.media ?? [];
    return media.map(toHit);
  },
};

function toHit(m: AniListMedia): Hit {
  const title = m.title.english ?? m.title.romaji ?? m.title.native ?? "Untitled";
  const studio = m.studios?.nodes?.[0]?.name ?? null;

  const avg = m.averageScore === null || m.averageScore === 0 ? null : m.averageScore / 10;

  return {
    id: `anilist:${m.id}`,
    title,
    year: m.seasonYear ?? null,
    summary: clean(m.description, studio),
    image: m.coverImage.extraLarge ?? m.coverImage.large ?? null,
    weight: m.popularity ?? null,
    avgRating: avg,
    episodes: m.episodes ?? null,
    provider: "anilist",
    format: m.format ?? null,
    genres: m.genres ?? [],
    externalLinks: m.externalLinks ?? [],
  };
}

function clean(desc: string | null, studio: string | null): string | null {
  const noBreaks = (desc ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "");
  const decoded = noBreaks
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
  const base = decoded.replace(/\s+/g, " ").trim();
  const withStudio = studio ? `${base}${base ? " — " : ""}${studio}` : base;
  if (!withStudio) return null;
  return withStudio.length > 400 ? `${withStudio.slice(0, 397)}...` : withStudio;
}
