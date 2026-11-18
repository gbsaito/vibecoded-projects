import path from "node:path";
import { stat, readdir, readFile } from "node:fs/promises";
import { parseVdfFile, type VdfNode } from "../vdf";
import {
  loadAchievementProgress,
  loadAllGameAchievements,
  type GameAchievements,
} from "./achievements";
import { resolveAppMetas } from "./names";
import { readSteamPlaytimes, readSteamLibraries, readSteamUsers, type SteamSession, type SteamUser } from "./auth";
import { loadOwnedAppIds } from "./webapi";

export interface SteamGame {
  appid: number;
  name: string | null;
  installed: boolean;
  sizeBytes: number | null;
  achievements: GameAchievements | null;
  playtimeMinutes: number;
  /** Store type "demo" — shown only when the demos filter is toggled on. */
  demo: boolean;
}

interface AppManifest {
  name: string;
}

async function readAppManifest(libraryPath: string, appid: number): Promise<AppManifest | null> {
  const root = (await parseVdfFile(path.join(libraryPath, "steamapps", `appmanifest_${appid}.acf`))) as
    | VdfNode
    | null;
  const state = root?.AppState as VdfNode | undefined;
  if (!state || typeof state !== "object") return null;
  if (typeof state.name !== "string") return null;
  return { name: state.name };
}

// Steam client hides these system components from the library; steamtui does too.
const TOOL_NAME_PATTERN = /^(Proton|Steamworks|Steam Linux Runtime|Steam Runtime|SteamVR—|HDR Calculator)/i;
const TOOL_TYPES = new Set(["tool", "driver", "config", "hardware"]);

export async function loadLibrary(session: SteamSession): Promise<SteamGame[]> {
  return loadFor(session);
}

export interface AccountLibrary {
  user: SteamUser;
  session: SteamSession;
  games: SteamGame[];
}

/**
 * Apps the running client unlocks on the fly. Each source is optional and
 * read only when it exists on disk, so a machine without either stays with
 * the installed list alone.
 *
 * - luatools (stplug-in): `config/stplug-in/<appid>.lua` — one file per game
 *   (filename = main appid); the addappid()ed appids inside are that game's
 *   own DLCs/sub-apps, not independent library entries.
 * - SLSsteam: `~/.config/SLSsteam/luaappids.yaml` — the manual game list of
 *   the SLSsteam loader (plain YAML ints, `- <appid>` entries or
 *   `addappid(<appid>, ...)` lines; `#` comments are ignored).
 */
async function pathExists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

export async function readLuaToolsAppids(steamRoot: string): Promise<number[]> {
  const dir = path.join(steamRoot, "config", "stplug-in");
  if (!(await pathExists(dir))) return [];
  const files = (await readdir(dir).catch(() => [] as string[])).filter((name) => /^\d+\.lua$/.test(name));
  return files.map((name) => Number(name.slice(0, -4)));
}

export async function readSlsSteamAppids(): Promise<number[]> {
  const file = path.join(process.env.HOME ?? "", ".config", "SLSsteam", "luaappids.yaml");
  if (!(await pathExists(file))) return [];
  const text = await readFile(file, "utf8").catch(() => "");
  const ids: number[] = [];
  for (const line of text.split("\n")) {
    const code = line.match(/addappid\s*\(\s*(\d+)/);
    const entry = line.match(/^\s*(?:-\s*)?(\d+)(?::|\s*$)/);
    const id = code ? Number(code[1]) : entry ? Number(entry[1]) : null;
    if (id !== null && id !== 0 && id < 2 ** 31) ids.push(id);
  }
  return ids;
}

/**
 * Appids the Steam client library itself moved into its hidden collection.
 * The client keeps this cloud-synced, not in the VDF caches:
 * userdata/<acct>/config/cloudstorage/cloud-storage-namespace-*.json holds
 * entries keyed "user-collections.hidden" whose value is
 * {"added": [...], "removed": [...]}. Hidden set = union(added) minus
 * union(removed).
 */
async function readClientHiddenAppIds(steamRoot: string, accountId: string): Promise<Set<number>> {
  const dir = path.join(steamRoot, "userdata", accountId, "config", "cloudstorage");
  const files = (await readdir(dir).catch(() => [] as string[]))
    .filter((name) => /^cloud-storage-namespace.*\.json$/.test(name));
  const hidden = new Set<number>();
  const unhidden = new Set<number>();
  for (const name of files) {
    const raw: unknown = await Bun.file(path.join(dir, name)).json().catch(() => null);
    if (!Array.isArray(raw)) continue;
    for (const entry of raw) {
      if (!Array.isArray(entry) || entry[0] !== "user-collections.hidden") continue;
      let value: unknown = Array.isArray(entry[1]) ? null : (entry[1] as { value?: unknown })?.value;
      if (typeof value === "string") {
        try {
          value = JSON.parse(value) as unknown;
        } catch {
          continue;
        }
      }
      const v = (typeof value === "object" && value !== null ? value : {}) as {
        added?: unknown;
        removed?: unknown;
      };
      for (const id of Array.isArray(v.added) ? v.added : []) {
        if (typeof id === "number") hidden.add(id);
      }
      for (const id of Array.isArray(v.removed) ? v.removed : []) {
        if (typeof id === "number") unhidden.add(id);
      }
    }
  }
  for (const id of unhidden) hidden.delete(id);
  return hidden;
}

/** Union of every present unlocker source. */
export async function readUnlockerAppids(steamRoot: string): Promise<number[]> {
  const [lua, sls] = await Promise.all([readLuaToolsAppids(steamRoot), readSlsSteamAppids()]);
  return [...new Set([...lua, ...sls])];
}

/**
 * Cheap fingerprint of everything that defines library membership and
 * install state on disk: the unlocker lists (luatools/SLSsteam) plus every
 * libraryfolders appmanifest with its mtime. If it changes, a game was
 * added/removed from luatools or installed/uninstalled — a signal for the
 * TUI to reload the library without user input. Ownership (Web API) is not
 * part of this: it's network-fetched and TTL-cached separately.
 */
export async function librarySignature(steamRoot: string): Promise<string> {
  const [unlockers, libraries] = await Promise.all([readUnlockerAppids(steamRoot), readSteamLibraries(steamRoot)]);
  const parts: string[] = ["u:" + unlockers.sort((a, b) => a - b).join(",")];
  for (const library of libraries) {
    const apps = Object.keys(library.apps)
      .map(Number)
      .sort((a, b) => a - b);
    const checked = await Promise.all(
      apps.map(async (appid) => {
        const st = await stat(path.join(library.path, "steamapps", `appmanifest_${appid}.acf`)).catch(() => null);
        return `${appid}:${st ? Math.floor(st.mtimeMs) : "gone"}`;
      }),
    );
    parts.push(`${library.path}>${checked.join(",")}`);
  }
  return parts.join("|");
}

/**
 * Cheap fingerprint of the achievement cache for one account: file count +
 * newest mtime of `userdata/<accountId>/config/librarycache/*.json`. When
 * Steam syncs achievements (e.g. after a game exits) this changes, which lets
 * the TUI refresh achievement counts without a restart.
 */
export async function achievementsSignature(steamRoot: string, accountId: string): Promise<string> {
  const dir = path.join(steamRoot, "userdata", accountId, "config", "librarycache");
  const files = (await readdir(dir).catch(() => [] as string[])).filter((n) => /^\d+\.json$/.test(n));
  if (files.length === 0) return "empty";
  let max = 0;
  for (const name of files) {
    const st = await stat(path.join(dir, name)).catch(() => null);
    if (st && st.mtimeMs > max) max = st.mtimeMs;
  }
  return `${files.length}:${Math.floor(max)}`;
}

export async function loadFor(session: SteamSession, refreshOwnership = false): Promise<SteamGame[]> {
  const installed = new Map<number, { libraryPath: string; sizeBytes: number | null }>();
  // Installed = a real appmanifest_<appid>.acf exists in a library folder.
  // libraryfolders.vdf is used only for sizes, not membership: Steam can write
  // the manifest for a freshly installed game before reflecting the library
  // entry, and stale entries for removed games persist forever.
  for (const library of session.libraries) {
    const dir = path.join(library.path, "steamapps");
    const manifests = (await readdir(dir).catch(() => [] as string[])).filter((n) =>
      /^appmanifest_\d+\.acf$/.test(n),
    );
    const sizes = library.apps;
    for (const m of manifests) {
      const appid = Number(m.slice("appmanifest_".length, -".acf".length));
      if (!Number.isSafeInteger(appid) || appid <= 0 || appid >= 2 ** 31) continue;
      installed.set(appid, { libraryPath: library.path, sizeBytes: Number(sizes[appid]) || null });
    }
  }

  // Library membership, in order of truth: owned licenses (Web API — the
  // only source that includes owned-but-never-installed games), games made
  // playable by unlocker tools read from disk (readUnlockerAppids — present
  // sources only), and anything physically installed. libraryfolders.vdf
  // alone is NOT membership: it keeps stale entries around forever. The
  // achievement-icon cache is deliberately NOT a source either — it lists
  // every game whose schema was ever fetched, including removed demos.
  const [owned, unlockers, clientHidden] = await Promise.all([
    loadOwnedAppIds(session.steamId64, refreshOwnership),
    readUnlockerAppids(session.steamRoot),
    readClientHiddenAppIds(session.steamRoot, session.accountId),
  ]);
  const appids = [...new Set([...installed.keys(), ...owned, ...unlockers])]
    .filter((id) => id < 2 ** 31 && !clientHidden.has(id));

  const [metas, cloud, progress] = await Promise.all([
    resolveAppMetas(session.steamRoot, appids),
    loadAllGameAchievements(session.steamRoot, session.accountId),
    loadAchievementProgress(session.steamRoot, session.accountId),
  ]);

  const games: SteamGame[] = [];
  await Promise.all(
    appids.map(async (appid) => {
      const info = installed.get(appid);
      const manifest = info ? await readAppManifest(info.libraryPath, appid) : null;
      const meta = metas.get(appid);
      const name = manifest?.name ?? meta?.name ?? null;
      // A libraryfolders.vdf apps entry alone doesn't prove installation —
      // stale entries survive uninstalls (materialized as missing
      // appmanifest_<appid>.acf). The manifest is the source of truth.
      const isInstalled = manifest !== null;
      // Unnameable apps (e.g. Valve's own config-only components like Steam Game
      // Notes, appid 2371090 — absent from the store) can't be run or titled.
      if (!name) return;
      if (TOOL_NAME_PATTERN.test(name)) return;
      if (meta?.type && TOOL_TYPES.has(meta.type)) return;
      games.push({
        appid,
        name,
        installed: isInstalled,
        sizeBytes: info?.sizeBytes ?? null,
        achievements: cloud[appid] ?? null,
        playtimeMinutes: Number(session.playtimes[appid]?.playtime ?? 0),
        demo: meta?.type === "demo",
      });
    }),
  );
  games.sort((a, b) => {
    if (a.name === null && b.name === null) return a.appid - b.appid;
    if (a.name === null) return 1;
    if (b.name === null) return -1;
    return a.name.localeCompare(b.name);
  });
  return games;
}

/**
 * Full per-account library: for every Steam account known to the client
 * (loginusers.vdf), resolve that account's own achievements/playtimes and
 * merge them into one account-indexed list. Used for the per-account library.
 */
export async function loadAllLibraries(
  steamRoot: string = "/home/backup/.local/share/Steam",
  refreshOwnership = false,
): Promise<AccountLibrary[]> {
  const users = await readSteamUsers(steamRoot);
  const libraries = await readSteamLibraries(steamRoot);
  const out: AccountLibrary[] = [];
  for (const user of users) {
    const session: SteamSession = {
      ...user,
      steamRoot,
      libraries,
      playtimes: await readSteamPlaytimes(steamRoot, user.accountId),
    };
    const games = await loadFor(session, refreshOwnership);
    out.push({ user, session, games });
  }
  return out;
}
