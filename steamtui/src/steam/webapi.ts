import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";

/**
 * Steam Web API access for library membership. The local caches can't tell
 * "owned but never installed/added to a library folder" apart from stale
 * garbage (libraryfolders.vdf keeps removed apps around), so ownership comes
 * from GetOwnedGames when an API key is available.
 *
 * Key resolution: $STEAM_API_KEY, then ~/.config/steamtui/config.json
 * ({ "apiKey": "..." }). Without a key this module is inert and the caller
 * falls back to locally-derivable membership only.
 */

interface OwnedCacheFile {
  fetchedAt: number;
  owned: number[];
}

// Ownership rarely changes; cache between reloads. R (library reload in the
// TUI) forces a fresh fetch.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const cachePath = (steamId64: string): string => {
  // XDG first, plain ~/.config fallback — env vars aren't always set to the
  // same root in every context the TUI is launched from.
  const dirs = [
    process.env.XDG_CACHE_HOME,
    path.join(process.env.HOME ?? "/tmp", ".cache"),
  ].filter((d): d is string => typeof d === "string" && d.length > 0);
  for (const dir of dirs) {
    const p = path.join(dir, "steamtui", `owned-${steamId64}.json`);
    if (existsSync(p)) return p;
  }
  return path.join(dirs[dirs.length - 1] ?? "/tmp", "steamtui", `owned-${steamId64}.json`);
};

export async function readApiKey(): Promise<string | null> {
  if (process.env.STEAM_API_KEY && /^[0-9a-f]{32}$/i.test(process.env.STEAM_API_KEY.trim())) {
    return process.env.STEAM_API_KEY.trim();
  }
  const dirs = [
    process.env.XDG_CONFIG_HOME,
    path.join(process.env.HOME ?? "/tmp", ".config"),
  ].filter((d): d is string => typeof d === "string" && d.length > 0);
  for (const dir of dirs) {
    try {
      const text = await readFile(path.join(dir, "steamtui", "config.json"), "utf8");
      const key = (JSON.parse(text) as { apiKey?: unknown }).apiKey;
      if (typeof key === "string" && /^[0-9a-f]{32}$/i.test(key.trim())) return key.trim();
    } catch {
      // no file / invalid json in this root — try the next candidate
    }
  }
  return null;
}

async function fetchOwned(key: string, steamId64: string): Promise<number[] | null> {
  const url =
    `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/` +
    `?key=${key}&steamid=${steamId64}&include_played_free_games=1&format=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!res?.ok) return null;
  const body = (await res.json().catch(() => null)) as
    | { response?: { games?: Array<{ appid?: unknown }> } }
    | null;
  const games = body?.response?.games;
  if (!Array.isArray(games)) return null;
  return games
    .map((g) => Number(g.appid))
    .filter((id) => Number.isSafeInteger(id) && id > 0 && id < 2 ** 31);
}

/**
 * Appids the account owns per GetOwnedGames. Fails soft: without a key, or
 * when the network is down, returns the last cached list (or an empty set).
 * `refresh` bypasses the TTL and hits the API again (library reload).
 */
export async function loadOwnedAppIds(steamId64: string, refresh = false): Promise<Set<number>> {
  let cached: OwnedCacheFile | null = null;
  const parse = async (): Promise<OwnedCacheFile | null> => {
    const raw = await Bun.file(cachePath(steamId64)).json().catch(() => null);
    if (
      raw &&
      typeof raw === "object" &&
      typeof (raw as OwnedCacheFile).fetchedAt === "number" &&
      Array.isArray((raw as OwnedCacheFile).owned)
    ) {
      return raw as OwnedCacheFile;
    }
    return null;
  };
  cached = await parse();
  if (!refresh && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return new Set(cached.owned);
  }

  const key = await readApiKey();
  if (!key) return cached ? new Set(cached.owned) : new Set();

  const owned = await fetchOwned(key, steamId64);
  if (owned === null) return cached ? new Set(cached.owned) : new Set();

  const cache: OwnedCacheFile = { fetchedAt: Date.now(), owned };
  const file = cachePath(steamId64);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(cache)).catch(() => {});
  return new Set(owned);
}

/** Milliseconds since the last successful GetOwnedGames fetch (Infinity if never). */
export async function ownedCacheAge(steamId64: string): Promise<number> {
  const raw = await Bun.file(cachePath(steamId64)).json().catch(() => null);
  if (raw && typeof raw === "object" && typeof (raw as OwnedCacheFile).fetchedAt === "number") {
    return Date.now() - (raw as OwnedCacheFile).fetchedAt;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * Persists the key into ~/.config/steamtui/config.json, preserving other
 * fields (e.g. familyAccounts, installCmd). Returns false on invalid input
 * or when no config root is writable.
 */
export async function writeApiKey(key: string): Promise<boolean> {
  const k = key.trim();
  if (!/^[0-9a-f]{32}$/i.test(k)) return false;
  const dirs = [
    process.env.XDG_CONFIG_HOME,
    path.join(process.env.HOME ?? "/tmp", ".config"),
  ].filter((d): d is string => typeof d === "string" && d.length > 0);
  for (const dir of dirs) {
    const file = path.join(dir, "steamtui", "config.json");
    let cfg: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      if (parsed && typeof parsed === "object") cfg = parsed as Record<string, unknown>;
    } catch {
      // no file / invalid json: start from empty
      cfg = {};
    }
    cfg.apiKey = k;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(cfg, null, 2));
      return true;
    } catch {
      // try next candidate root
    }
  }
  return false;
}
