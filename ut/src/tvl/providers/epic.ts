/**
 * Epic Games Store provider.
 *
 * Keyless public endpoint: `POST https://store.epicgames.com/graphql` with the
 * `searchStoreQuery` operation. The edge in front of it answers Node's
 * HTTP/1.1 client with a Cloudflare challenge, so the request goes over
 * HTTP/2 (see `fetchJsonHttp2`). No key or account is involved.
 *
 * Cover art: `OfferImageTall` is 1200x1600 (3:4). Epic's image service can
 * scale by height (`?resize=1&h=900` -> 675x900) but will not crop to 2:3, so
 * Epic art is a 3:4 portrait; the UI fits it into a 600x900 poster box.
 */

import type { Hit, Platform, Source } from "../model.ts";
import { fetchJsonHttp2 } from "../net.ts";

const GRAPHQL = "https://store.epicgames.com/graphql";
const TIMEOUT = 9000;

const CATEGORY =
  "games/edition/base|bundles/games|games/edition|editors|addons|games/demo|software/edition/base|games/experience|subscription";

const SEARCH_QUERY = `query searchStoreQuery($allowCountries: String, $category: String, $count: Int, $country: String!, $keywords: String, $locale: String, $namespace: String, $itemNs: String, $sortBy: String, $sortDir: String, $start: Int, $tag: String, $releaseDate: String, $withPrice: Boolean = false) {
  Catalog {
    searchStore(allowCountries: $allowCountries, category: $category, count: $count, country: $country, keywords: $keywords, locale: $locale, namespace: $namespace, itemNs: $itemNs, sortBy: $sortBy, sortDir: $sortDir, releaseDate: $releaseDate, start: $start, tag: $tag) {
      elements {
        title
        id
        namespace
        description
        effectiveDate
        keyImages { type url }
        seller { id name }
        productSlug
        urlSlug
        customAttributes { key value }
        categories { path }
        price(country: $country) @include(if: $withPrice) {
          totalPrice {
            discountPrice
            originalPrice
            currencyCode
            fmtPrice(locale: $locale) { originalPrice discountPrice }
          }
        }
      }
      paging { count total }
    }
  }
}`;

interface EpicElement {
  title?: string;
  id?: string;
  namespace?: string;
  description?: string | null;
  effectiveDate?: string | null;
  keyImages?: Array<{ type: string; url: string }>;
  seller?: { id?: string; name?: string };
  productSlug?: string;
  urlSlug?: string;
  customAttributes?: Array<{ key: string; value: string }>;
  categories?: Array<{ path: string }>;
  price?: {
    totalPrice?: {
      discountPrice?: number;
      originalPrice?: number;
      currencyCode?: string;
      fmtPrice?: { originalPrice?: string; discountPrice?: string };
    };
  };
}

interface EpicResponse {
  data?: {
    Catalog?: {
      searchStore?: {
        elements?: EpicElement[];
        paging?: { count: number; total: number };
      };
    };
  };
  errors?: Array<{ message: string }>;
}

const yearOf = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const y = Number(iso.slice(0, 4));
  return Number.isFinite(y) && y > 1950 ? y : null;
};

/** Scale the tall offer image down to 900px tall; the 3:4 aspect is kept. */
export function epicArt(url: string | null | undefined): string | null {
  if (!url) return null;
  return `${url}${url.includes("?") ? "&" : "?"}resize=1&h=900`;
}

export const epic = {
  id: "epic" as Source,
  label: "Epic",

  async search(query: string, signal: AbortSignal, timeoutMs: number = TIMEOUT): Promise<Hit[]> {
    const body = JSON.stringify({
      operationName: "searchStoreQuery",
      variables: {
        allowCountries: "US",
        category: CATEGORY,
        count: 25,
        country: "US",
        keywords: query,
        locale: "en-US",
        namespace: "",
        itemNs: "",
        sortBy: "relevancy",
        sortDir: "DESC",
        releaseDate: null,
        start: 0,
        tag: "",
        withPrice: true,
      },
      query: SEARCH_QUERY,
    });

    const doc = await fetchJsonHttp2<EpicResponse>(GRAPHQL, {
      method: "POST",
      body,
      signal,
      timeoutMs,
      attempts: 2,
      headers: {
        Accept: "application/json",
        Origin: "https://store.epicgames.com",
        Referer: "https://store.epicgames.com/en-US/",
      },
    });

    if (doc.errors?.length) {
      throw new Error(doc.errors.map((e) => e.message).join("; "));
    }

    const elements = doc.data?.Catalog?.searchStore?.elements ?? [];
    const hits: Hit[] = [];

    for (const el of elements) {
      if (!el.title) continue;
      const slug = el.productSlug ?? el.urlSlug;
      const images = el.keyImages ?? [];
      const tall = images.find((i) => i.type === "OfferImageTall")?.url;
      const fallback = images.find((i) => i.type === "Thumbnail")?.url;
      const image = epicArt(tall ?? fallback ?? null);

      const total = el.price?.totalPrice;
      const fmt = total?.fmtPrice?.originalPrice ?? total?.fmtPrice?.discountPrice;
      const price = total?.discountPrice === 0 ? "Free" : (fmt ?? null);

      const genres = (el.customAttributes ?? [])
        .filter((a) => a.key === "genre" || a.key === "genres")
        .flatMap((a) => a.value.split(/,\s*/))
        .filter(Boolean);

      hits.push({
        id: `epic:${el.namespace ?? el.id}`,
        title: el.title,
        year: yearOf(el.effectiveDate),
        summary: el.description ?? null,
        image,
        platform: "PC" as Platform,
        sources: ["epic" as Source],
        price,
        metacritic: null,
        developers: [],
        publishers: el.seller?.name ? [el.seller.name] : [],
        platformsAvailable: ["PC"],
        metacriticSlug: null,
        genres,
        url: slug ? `https://store.epicgames.com/en-US/p/${slug}` : null,
      });
    }
    return hits;
  },
};
