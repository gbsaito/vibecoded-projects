// Terminal cover art for a Steam app, sourced the same way as ~/Projects/ut (tvl):
// classic CDN `library_600x900(.2x)` probes, then the store's hashed asset paths
// read from the app page. Images are cached on disk under ~/.cache/steamtui/covers.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ART_URL = "https://cdn.cloudflare.steamstatic.com/steam/apps";
const STORE_APP_URL = "https://store.steampowered.com/app";
const URL_TTL_MS = 30 * 24 * 3600 * 1000;
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";

export class CoverArt {
  private readonly dir: string;
  private readonly urlFile: string;
  private readonly data = new Map<number, Uint8Array>();
  private urls: Record<number, { url: string; at: number }> = {};
  private urlsLoaded = false;
  private pending = new Set<number>();

  constructor(steamRoot: string) {
    void steamRoot;
    const cacheRoot = process.env.XDG_CACHE_HOME ?? path.join(process.env.HOME ?? "/tmp", ".cache");
    this.dir = path.join(cacheRoot, "steamtui", "covers");
    this.urlFile = path.join(cacheRoot, "steamtui", "coverurls.json");
  }

  /** Cached bytes for an app, or null. */
  get(appid: number): Uint8Array | null {
    const mem = this.data.get(appid);
    if (mem) return mem;
    const file = path.join(this.dir, `${appid}.v2.img`);
    if (!existsSync(file)) return null;
    try {
      const bytes = new Uint8Array(normalizeImage(readFileSync(file)));
      this.data.set(appid, bytes);
      return bytes;
    } catch {
      return null;
    }
  }

  /**
   * Load the cover for an app and call `update(appid, bytes)` when ready
   * (bytes may be null on failure). Immediate results clear `pending` early;
   * repeat calls during the download are deduped.
   */
  ensure(appid: number, update: (appid: number, bytes: Uint8Array | null) => void): Promise<void> {
    if (this.get(appid)) {
      update(appid, this.get(appid));
      return Promise.resolve();
    }
    if (this.pending.has(appid)) return Promise.resolve();
    this.pending.add(appid);
    return this.fetch(appid)
      .then((bytes) => {
        this.pending.delete(appid);
        if (bytes) this.data.set(appid, bytes);
        update(appid, bytes ?? null);
      })
      .catch(() => {
        this.pending.delete(appid);
        update(appid, null);
      });
  }

  /**
   * Prefetch a batch of covers for later instant use. Resolves URLs first in
   * bulk — the store items API accepts several ids per call, so one round
   * trip replaces the per-app HEAD/API/scrape chain — then downloads with a
   * small concurrency cap so startup doesn't saturate the connection.
   */
  async warm(appids: number[], update?: (appid: number, bytes: Uint8Array | null) => void): Promise<void> {
    const todo = appids.filter((id) => !this.get(id) && !this.pending.has(id));
    if (todo.length === 0) return;
    if (!this.urlsLoaded) {
      this.urlsLoaded = true;
      try {
        this.urls = (await Bun.file(this.urlFile).json()) as typeof this.urls;
      } catch {
        this.urls = {};
      }
    }
    // Bulk-resolve URLs for every app missing a cached one (TTL 30 days).
    const missing = todo.filter((id) => !this.urls[id] || Date.now() - this.urls[id]!.at >= URL_TTL_MS);
    const BATCH = 25;
    for (let i = 0; i < missing.length; i += BATCH) {
      const chunk = missing.slice(i, i + BATCH);
      const res = await fetch(
        `https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(
          JSON.stringify({
            ids: chunk.map((appid) => ({ appid })),
            context: { country_code: "US" },
            data_request: { include_assets: true },
          }),
        )}`,
        { headers: { "User-Agent": BROWSER_UA }, signal: AbortSignal.timeout(15_000) },
      ).catch(() => null);
      if (!res?.ok) break; // fall back to the per-app path for the leftovers
      const j = (await res.json().catch(() => null)) as {
        response?: {
          store_items?: Array<{ appid?: number | string; assets?: Record<string, string> }>;
        };
      } | null;
      const items = j?.response?.store_items ?? [];
      for (const item of items) {
        const appid = Number(item.appid);
        const assets = item.assets;
        if (!appid || !assets) continue;
        const lib = assets.library_capsule_2x ?? assets.library_capsule ?? assets.library_cover_2x;
        if (lib) this.urls[appid] = { url: `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/${lib}`, at: Date.now() };
      }
      if (i + BATCH < missing.length) await Bun.sleep(150); // politeness gap between batches
    }
    await Bun.write(this.urlFile, JSON.stringify(this.urls)).catch(() => {});

    // Download with a small concurrency cap, nearest-first is up to the caller.
    let index = 0;
    const worker = async () => {
      while (index < todo.length) {
        const appid = todo[index++]!;
        await this.ensure(appid, (id, bytes) => update?.(id, bytes));
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, todo.length) }, worker));
  }

  private async fetch(appid: number): Promise<Uint8Array | null> {
    const url = await this.resolveUrl(appid);
    if (!url) return null;
    const res = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const buf = normalizeImage(Buffer.from(await res.arrayBuffer()));
    if (buf.length < 100) return null;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(path.join(this.dir, `${appid}.v2.img`), buf);
    return buf;
  }

  /** Vertical art URL for an app: classic CDN probes first, then the store page. */
  private async resolveUrl(appid: number): Promise<string | null> {
    if (!this.urlsLoaded) {
      this.urlsLoaded = true;
      try {
        this.urls = (await Bun.file(this.urlFile).json()) as typeof this.urls;
      } catch {
        this.urls = {};
      }
    }
    const cached = this.urls[appid];
    if (cached && Date.now() - cached.at < URL_TTL_MS) return cached.url;

    const url = await this.probeUrl(appid);
    if (url) {
      this.urls[appid] = { url, at: Date.now() };
      await Bun.write(this.urlFile, JSON.stringify(this.urls)).catch(() => {});
    }
    return url;
  }

  private async probeUrl(appid: number): Promise<string | null> {
    // CDN first, both size variants in one round trip.
    const names = ["library_600x900_2x.jpg", "library_600x900.jpg"];
    const heads = await Promise.allSettled(
      names.map((name) =>
        fetch(`${ART_URL}/${appid}/${name}`, { method: "HEAD", signal: AbortSignal.timeout(8_000) }),
      ),
    );
    const hit = heads.find((r) => r.status === "fulfilled" && r.value.ok);
    if (hit) return (hit as PromiseFulfilledResult<Response>).value.url;
    if (heads.every((r) => r.status === "rejected")) return null; // CDN unreachable; the page scrape would fail too
    // Steam's store items API carries a hashed library cover for apps the CDN
    // does not expose (e.g. Cat Mail Co.); this is the same asset family the
    // store-page scrape would find, served directly.
    try {
      const res = await fetch(
        `https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(
          JSON.stringify({
            ids: [{ appid }],
            context: { country_code: "US" },
            data_request: { include_assets: true },
          }),
        )}`,
        { headers: { "User-Agent": BROWSER_UA }, signal: AbortSignal.timeout(12_000) },
      );
      if (res.ok) {
        const j = (await res.json()) as {
          response?: { store_items?: Array<{ assets?: Record<string, string> }> };
        };
        const assets = j?.response?.store_items?.[0]?.assets;
        const lib = assets?.library_capsule_2x ?? assets?.library_capsule;
        if (lib) return `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/${lib}`;
      }
    } catch {
      // fall through to the store page scrape
    }
    // Newer apps only publish hashed asset paths listed on the store page.
    try {
      const res = await fetch(`${STORE_APP_URL}/${appid}/?l=english&cc=US`, {
        headers: { "User-Agent": BROWSER_UA, Accept: "text/html" },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) return null;
      const html = await res.text();
      let header: string | null = null;
      for (const m of html.matchAll(
        /https:\/\/shared\.[a-z0-9]+\.steamstatic\.com\/store_item_assets\/steam\/apps\/\d+\/[a-f0-9]+\/([A-Za-z0-9_]+)\.(jpg|png|webp)/g,
      )) {
        const stem = m[1]!.replace(/_alt_assets_\d+$/, "");
        if (["library_600x900_2x", "library_600x900", "library_cover_600x900"].includes(stem)) {
          return m[0];
        }
        if (stem === "header" && !header) header = m[0];
      }
      return header;
    } catch {
      return null;
    }
  }
}

/**
 * Strip PNG chunks the native decoder rejects ("unsupported image color
 * space"), keeping only IHDR/IDAT/IEND; other formats pass through unchanged.
 */
export function normalizeImage(buf: Buffer): Buffer {
  if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
    return buf;
  }
  const out: Buffer[] = [buf.subarray(0, 8)];
  let pos = 8;
  while (pos + 12 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const chunkEnd = pos + 12 + length;
    if (chunkEnd > buf.length) break;
    if (type === "IHDR" || type === "IDAT" || type === "IEND") out.push(buf.subarray(pos, chunkEnd));
    pos = chunkEnd;
    if (type === "IEND") break;
  }
  return Buffer.concat(out);
}
