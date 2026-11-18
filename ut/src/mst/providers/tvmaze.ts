import type { Hit } from "../model.ts";
import { fetchJson } from "../net.ts";

const BASE = "https://api.tvmaze.com";

interface MazeShow {
  id: number;
  name: string;
  premiered: string | null;
  summary: string | null;
  weight: number | null;
  type: string | null;
  genres: string[] | null;
  network: { name: string } | null;
  image: { medium: string | null; original: string | null } | null;
  rating: { average: number | null } | null;
}

interface MazeSearchItem {
  score: number;
  show: MazeShow;
}

export const tvmaze = {
  id: "tvmaze",
  label: "series",
  supportsMovies: false,

  async search(
    query: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<Hit[]> {
    const url = `${BASE}/search/shows?q=${encodeURIComponent(query)}`;
    const doc = await fetchJson<MazeSearchItem[]>(url, {
      signal,
      timeoutMs,
      attempts: 2,
    });
    if (!Array.isArray(doc)) return [];
    return doc.slice(0, 25).map(({ show }) => toHit(show));
  },

  async fetchShow(
    id: number,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<{ episodes: number; image: string | null; summary: string | null; avgRating: number | null; weight: number | null }> {
    const url = `${BASE}/shows/${id}?embed=episodes`;
    const doc = await fetchJson<Record<string, unknown>>(url, {
      signal,
      timeoutMs,
      attempts: 2,
    });
    const rating = (doc.rating as { average?: number | null } | undefined)?.average ?? null;
    return {
      episodes: countEpisodes(doc),
      image:
        (doc.image as { original?: string; medium?: string } | undefined)?.original ??
        (doc.image as { medium?: string } | undefined)?.medium ??
        null,
      summary: (doc.summary as string | null) ?? null,
      avgRating: rating,
      weight: (doc.weight as number | null) ?? null,
    };
  },
};

function toHit(s: MazeShow): Hit {
  const network = s.network?.name ?? null;
  const year = s.premiered ? Number(s.premiered.slice(0, 4)) : null;
  const summary = stripHtml(s.summary);
  const withNetwork = network ? `${summary ? `${summary} — ` : ""}${network}` : summary;

  return {
    id: `tvmaze:${s.id}`,
    title: s.name,
    year: Number.isFinite(year) ? year : null,
    summary: withNetwork ? withNetwork.slice(0, 400) : null,
    image: s.image?.medium ?? s.image?.original ?? null,
    weight: s.weight ?? null,
    avgRating: s.rating?.average ?? null,
    episodes: null,
    provider: "tvmaze",
    format: s.type ?? null,
    genres: s.genres ?? [],
  };
}

interface EmbeddedEpisodes {
  _embedded?: { episodes?: unknown[] };
}

function countEpisodes(doc: Record<string, unknown>): number {
  const embedded = doc._embedded as EmbeddedEpisodes["_embedded"] | undefined;
  const eps = embedded?.episodes;
  return Array.isArray(eps) ? eps.length : 0;
}

function stripHtml(s: string | null): string {
  if (!s) return "";
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
