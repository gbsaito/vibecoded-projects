import path from "node:path";
import { parseAppinfoNames } from "./appinfo";

export interface AppMeta {
  name: string | null;
  type: string | null;
}

const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;

function cachePath(steamRoot: string): string {
  const xdgCache = process.env.XDG_CACHE_HOME ?? path.join(process.env.HOME ?? "/tmp", ".cache");
  return path.join(xdgCache, "steamtui", "appnames.json");
}

async function readCache(steamRoot: string): Promise<Map<number, AppMeta>> {
  const out = new Map<number, AppMeta>();
  const file = Bun.file(cachePath(steamRoot));
  if (!(await file.exists())) return out;
  let raw: Record<string, { name?: unknown; type?: unknown; fetchedAt?: unknown }> | null = null;
  try {
    raw = await file.json();
  } catch {
    return out;
  }
  const now = Date.now();
  for (const [appid, entry] of Object.entries(raw ?? {})) {
    if (typeof entry !== "object") continue;
    if (typeof entry.fetchedAt !== "number" || now - entry.fetchedAt > CACHE_TTL_MS) continue;
    out.set(
      Number(appid),
      {
        name: typeof entry.name === "string" ? entry.name : null,
        type: typeof entry.type === "string" ? entry.type : null,
      },
    );
  }
  return out;
}

async function writeCache(steamRoot: string, metas: Map<number, AppMeta>): Promise<void> {
  const obj: Record<string, { name: string | null; type: string | null; fetchedAt: number }> = {};
  const now = Date.now();
  for (const [appid, meta] of metas) {
    if (meta.name === null && meta.type === null) continue;
    obj[appid] = { name: meta.name, type: meta.type, fetchedAt: now };
  }
  const file = cachePath(steamRoot);
  await Bun.write(file, JSON.stringify(obj)).catch(() => {});
}

async function fetchMetas(appids: number[]): Promise<Map<number, AppMeta>> {
  const out = new Map<number, AppMeta>();
  // store API 2026: bulk appdetails lists return HTTP 400 — request one appid at a time
  for (let i = 0; i < appids.length; i += 5) {
    const chunk = appids.slice(i, i + 5);
    const results = await Promise.allSettled(
      chunk.map(async (appid) => {
        const res = await fetch(
          `https://store.steampowered.com/api/appdetails?appids=${appid}&filters=basic`,
          { headers: { "User-Agent": "steamtui/0.1" }, signal: AbortSignal.timeout(10_000) },
        );
        if (!res.ok) return;
        const body = (await res.json()) as Record<
          string,
          { success?: boolean; data?: { name?: string; type?: string } } | null
        >;
        const entry = body[String(appid)];
        if (entry?.success && entry.data) {
          out.set(appid, { name: entry.data.name ?? null, type: entry.data.type ?? null });
        }
      }),
    );
    void results;
  }
  return out;
}

/**
 * Resolve display metadata for appids:
 * 1. cached store lookups (< 7 days old),
 * 2. appinfo.vdf scan (offline fallback),
 * 3. fresh store API lookup for the rest (single batched request).
 */
export async function resolveAppMetas(steamRoot: string, appids: number[]): Promise<Map<number, AppMeta>> {
  const metas = await readCache(steamRoot);
  const missing = appids.filter((appid) => !metas.has(appid));

  try {
    const data = new Uint8Array(
      await Bun.file(path.join(steamRoot, "appcache", "appinfo.vdf")).arrayBuffer(),
    );
    for (const [appid, name] of parseAppinfoNames(data)) {
      if (missing.includes(appid) && !metas.has(appid)) metas.set(appid, { name, type: null });
    }
  } catch {
    // appinfo.vdf missing; fall through to the store API
  }

  const stillMissing = appids.filter(
    (appid) => !metas.has(appid) || metas.get(appid)!.type === null,
  );
  if (stillMissing.length > 0) {
    const fetched = await fetchMetas(stillMissing);
    for (const [appid, meta] of fetched) metas.set(appid, meta);
    if (fetched.size > 0) {
      // merge union into a fresh map so stale entries keep their timestamps
      const toSave = new Map([...metas, ...fetched]);
      await writeCache(steamRoot, toSave);
    }
  }
  return metas;
}
