import path from "node:path";
import { parseVdfFile, type VdfNode } from "../vdf";

export interface SteamUser {
  steamId64: string;
  accountId: string;
  accountName: string;
  personaName: string;
}

export interface SteamLibrary {
  path: string;
  apps: Record<string, string>;
}

export interface SteamSession {
  steamId64: string;
  accountId: string;
  accountName: string;
  personaName: string;
  steamRoot: string;
  libraries: SteamLibrary[];
  /** Per-appid playtime (minutes) + last played timestamp from localconfig.vdf. */
  playtimes: Record<string, { lastPlayed: number; playtime: number }>;
}

export interface SteamAppPlaytime {
  lastPlayed: number;
  playtime: number; // minutes
}

const DEFAULT_STEAM_ROOT = "/home/backup/.local/share/Steam";
const STEAM_ID64_OFFSET = 76561197960265728n;

export function getSteamRoot(): string {
  return process.env.STEAM_ROOT ?? DEFAULT_STEAM_ROOT;
}

export function steamIdToAccountId(steamId64: string): string {
  return (BigInt(steamId64) - STEAM_ID64_OFFSET).toString();
}

export async function readSteamUsers(steamRoot: string): Promise<SteamUser[]> {
  const root = (await parseVdfFile(path.join(steamRoot, "config", "loginusers.vdf"))) as VdfNode | null;
  const users = root?.users as VdfNode | undefined;
  const out: SteamUser[] = [];
  if (!users) return out;
  for (const [steamId64, value] of Object.entries(users)) {
    if (typeof value !== "object" || value === null) continue;
    const info = value as VdfNode;
    const user: SteamUser = {
      steamId64,
      accountId: steamIdToAccountId(steamId64),
      accountName: String(info.AccountName ?? ""),
      personaName: String(info.PersonaName ?? ""),
    };
    if (user.accountName) out.push(user);
  }
  return out;
}

export async function readSteamUser(steamRoot: string): Promise<SteamUser | null> {
  const users = await readSteamUsers(steamRoot);
  return users[0] ?? null;
}

export async function readSteamLibraries(steamRoot: string): Promise<SteamLibrary[]> {
  const root = (await parseVdfFile(path.join(steamRoot, "config", "libraryfolders.vdf"))) as VdfNode | null;
  const folders = root?.libraryfolders as VdfNode | undefined;
  if (!folders) return [];
  const out: SteamLibrary[] = [];
  for (const value of Object.values(folders)) {
    if (typeof value !== "object" || value === null) continue;
    const folder = value as VdfNode;
    const folderPath = folder.path;
    if (typeof folderPath !== "string") continue;
    const apps: Record<string, string> = {};
    const rawApps = folder.apps;
    if (typeof rawApps === "object" && rawApps !== null) {
      for (const [appid, size] of Object.entries(rawApps)) {
        if (typeof size === "string") apps[appid] = size;
      }
    }
    out.push({ path: folderPath, apps });
  }
  return out;
}

/** Reads per-app playtime/lastPlayed from <steamRoot>/userdata/<acct>/config/localconfig.vdf. */
export async function readSteamPlaytimes(
  steamRoot: string,
  accountId: string = "828784002",
): Promise<Record<string, SteamAppPlaytime>> {
  const candidates = [
    path.join(steamRoot, "userdata", "828784002", "config", "localconfig.vdf"),
    path.join(steamRoot, "config", "localconfig.vdf"),
  ];
  for (const file of candidates) {
    const doc = (await parseVdfFile(file)) as VdfNode | null;
    const software = (doc?.UserLocalConfigStore as VdfNode | undefined) ?? (doc?.Software as VdfNode | undefined);
    const valve = ((software?.Software as VdfNode | undefined)?.Valve as VdfNode | undefined) ??
      (software?.Valve as VdfNode | undefined);
    const steam =
      (valve?.Steam as VdfNode | undefined) ??
      (software?.Steam as VdfNode | undefined);
    const appsObj =
      (steam?.apps as VdfNode | undefined) ??
      (valve?.apps as VdfNode | undefined) ??
      (software?.apps as VdfNode | undefined) ??
      {};
    const out: Record<string, SteamAppPlaytime> = {};
    for (const [appid, entry] of Object.entries(appsObj)) {
      if (typeof entry !== "object" || entry === null) continue;
      const app = entry as VdfNode;
      out[appid] = {
        lastPlayed: Number(app.LastPlayed ?? 0) || 0,
        playtime: Number(app.Playtime ?? 0) || 0,
      };
    }
    if (Object.keys(out).length > 0) return out;
  }
  return {};
}

export async function resolveSteamSession(steamRoot: string = getSteamRoot()): Promise<SteamSession> {
  const user = await readSteamUser(steamRoot);
  if (!user) {
    throw new Error(`No Steam user session found (expected ${steamRoot}/config/loginusers.vdf)`);
  }
  const libraries = await readSteamLibraries(steamRoot);
  if (libraries.length === 0) {
    throw new Error(`No Steam library folders found (expected ${steamRoot}/config/libraryfolders.vdf)`);
  }
  const playtimes = await readSteamPlaytimes(steamRoot);
  return { ...user, steamRoot, libraries, playtimes };
}
