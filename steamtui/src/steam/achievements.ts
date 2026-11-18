import { readdir } from "node:fs/promises";
import path from "node:path";

export interface SteamAchievement {
  strID: string;
  strName: string;
  strDescription: string;
  bAchieved: boolean;
  rtUnlocked: number;
  strImage: string;
  bHidden: boolean;
  flMinProgress: number;
  flCurrentProgress: number;
  flMaxProgress: number;
  flAchieved: number;
}

export interface AchievementSet {
  version: number;
  nTotal: number;
  nAchieved: number;
  achieved: SteamAchievement[];
  unachieved: SteamAchievement[];
  achievedHidden: SteamAchievement[];
}

export interface GameAchievements {
  appid: number;
  achievements: AchievementSet;
}

export interface AchievementProgress {
  appid: number;
  unlocked: number;
  total: number;
  percentage: number;
  allUnlocked: boolean;
  cache_time: number;
  vetted: boolean;
}

function cacheDir(steamRoot: string, accountId: string): string {
  return path.join(steamRoot, "userdata", accountId, "config", "librarycache");
}

export async function loadGameAchievements(
  steamRoot: string,
  accountId: string,
  appid: number,
): Promise<GameAchievements | null> {
  const file = Bun.file(path.join(cacheDir(steamRoot, accountId), `${appid}.json`));
  if (!(await file.exists())) return null;
  let raw: unknown;
  try {
    raw = await file.json();
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const entry = raw.find((item) => Array.isArray(item) && item[0] === "achievements");
  if (!Array.isArray(entry) || typeof entry[1] !== "object" || entry[1] === null) return null;
  const body = entry[1] as { version?: number; data?: Record<string, unknown> };
  const data = (body.data ?? {}) as {
    vecHighlight?: SteamAchievement[];
    vecUnachieved?: SteamAchievement[];
    vecAchievedHidden?: SteamAchievement[];
    nTotal?: number;
    nAchieved?: number;
  };
  const achieved = (data.vecHighlight ?? []).filter((a) => a && typeof a === "object");
  const unachieved = (data.vecUnachieved ?? []).filter((a) => a && typeof a === "object");
  const achievedHidden = (data.vecAchievedHidden ?? []).filter((a) => a && typeof a === "object");
  const nAchieved = typeof data.nAchieved === "number" ? data.nAchieved : achieved.length;
  const nTotal = typeof data.nTotal === "number" ? data.nTotal : achieved.length + unachieved.length;
  return {
    appid,
    achievements: {
      version: typeof body.version === "number" ? body.version : 0,
      nTotal,
      nAchieved,
      achieved,
      unachieved,
      achievedHidden,
    },
  };
}

export async function listCachedAppids(steamRoot: string, accountId: string): Promise<number[]> {
  const dir = cacheDir(steamRoot, accountId);
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => /^\d+\.json$/.test(name));
  return names.map((name) => Number(name.slice(0, -5)));
}

export async function loadAllGameAchievements(
  steamRoot: string,
  accountId: string,
): Promise<Record<number, GameAchievements>> {
  const result: Record<number, GameAchievements> = {};
  await Promise.all(
    (await listCachedAppids(steamRoot, accountId)).map(async (appid) => {
      const cache = await loadGameAchievements(steamRoot, accountId, appid);
      if (cache) result[appid] = cache;
    }),
  );
  return result;
}

export async function loadAchievementProgress(steamRoot: string, accountId: string): Promise<AchievementProgress[]> {
  const file = Bun.file(path.join(cacheDir(steamRoot, accountId), "achievement_progress.json"));
  if (!(await file.exists())) return [];
  let raw: { mapCache?: unknown } | null = null;
  try {
    raw = (await file.json()) as { mapCache?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(raw.mapCache)) return [];
  const out: AchievementProgress[] = [];
  for (const pair of raw.mapCache) {
    if (!Array.isArray(pair) || typeof pair[0] !== "number" || typeof pair[1] !== "object") continue;
    const progress = pair[1] as {
      appid?: number;
      unlocked?: number;
      total?: number;
      percentage?: number;
      all_unlocked?: boolean;
      cache_time?: number;
      vetted?: boolean;
    };
    out.push({
      appid: progress.appid ?? Number(pair[0]),
      unlocked: progress.unlocked ?? 0,
      total: progress.total ?? 0,
      percentage: progress.percentage ?? 0,
      allUnlocked: Boolean(progress.all_unlocked),
      cache_time: progress.cache_time ?? 0,
      vetted: Boolean(progress.vetted),
    });
  }
  return out;
}
