// Full achievement schema for a game, scraped from the player's own
// community achievements page (no key needed) — the same icons/names/
// descriptions the Steam client shows, including hidden flags. The userdata
// librarycache only carries a truncated subset (vecHighlight/vecUnachieved
// are popup lists, not the full archive).
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const STATS_URL = "https://steamcommunity.com/profiles";
const TTL_MS = 24 * 3600 * 1000;
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";

export interface SteamAchSchemaItem {
  apiName: string;
  name: string;
  description: string;
  hidden: boolean;
  iconClosed: string;
  iconOpen: string;
}

interface CachedSchema {
  at: number;
  items: SteamAchSchemaItem[];
}

const CACHE_DIR = path.join(process.env.XDG_CACHE_HOME ?? path.join(process.env.HOME ?? "/tmp", ".cache"), "steamtui", "schemas");

function fileFor(appid: number): string {
  return path.join(CACHE_DIR, `${appid}.v2.json`);
}

function readCache(appid: number): CachedSchema | null {
  try {
    if (!existsSync(fileFor(appid))) return null;
    const parsed = JSON.parse(readFileSync(fileFor(appid), "utf8")) as CachedSchema;
    return parsed?.items?.length ? parsed : null;
  } catch {
    return null;
  }
}

/** Achievement objects in the page's embedded react-query JSON, escaped as \". */
function unescapeJsonString(s: string): string {
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s.replace(/\\(["\\])/g, "$1");
  }
}

function parsePage(html: string, appid: number): SteamAchSchemaItem[] {
  const plain = html.replace(/\\"/g, '"');
  const obj =
    /\{"internal_key":(\d+),"api_name":"([^"]+)","name":"((?:[^"\\]|\\.)*)","description":"((?:[^"\\]|\\.)*)","hidden":(true|false),"archived":false,"icon_achieved":"([0-9a-f]{40})\.jpg","icon_unachieved":"([0-9a-f]{40})\.jpg","groupid":\d/g;
  const cdn = "https://shared.fastly.steamstatic.com/community_assets/images/apps";
  const items: SteamAchSchemaItem[] = [];
  for (const m of plain.matchAll(obj)) {
    items.push({
      apiName: m[2]!,
      name: unescapeJsonString(m[3]!),
      description: unescapeJsonString(m[4]!),
      hidden: m[5] === "true",
      iconOpen: `${cdn}/${appid}/${m[6]}.jpg`,
      iconClosed: `${cdn}/${appid}/${m[7]}.jpg`,
    });
  }
  return items;
}

export class AchSchema {
  private readonly steamId64: string;
  private readonly mem = new Map<number, CachedSchema>();
  private readonly pending = new Set<number>();

  constructor(steamId64: string) {
    this.steamId64 = steamId64;
  }

  /** Cached (fresh or stale-fallback) schema items, or null. */
  get(appid: number): SteamAchSchemaItem[] | null {
    const mem = this.mem.get(appid);
    if (mem) return mem.items;
    const disk = readCache(appid);
    if (disk) {
      this.mem.set(appid, disk);
      return disk.items;
    }
    return null;
  }

  isFresh(appid: number): boolean {
    const cached = this.mem.get(appid) ?? readCache(appid);
    return !!cached && Date.now() - cached.at < TTL_MS;
  }

  /** Load the schema for an appid; calls update(items) when ready or null on failure. */
  ensure(appid: number, update: (items: SteamAchSchemaItem[] | null) => void): Promise<void> {
    if (this.isFresh(appid) && this.get(appid)) {
      update(this.get(appid));
      return Promise.resolve();
    }
    if (this.pending.has(appid)) return Promise.resolve();
    this.pending.add(appid);
    return this.fetchSchema(appid).then((items) => {
        this.pending.delete(appid);
        if (items && items.length > 0) {
          const cached: CachedSchema = { at: Date.now(), items };
          this.mem.set(appid, cached);
          try {
            mkdirSync(CACHE_DIR, { recursive: true });
            writeFileSync(fileFor(appid), JSON.stringify(cached));
          } catch {
            /* cache write is best-effort */
          }
        }
        update(items && items.length > 0 ? items : this.get(appid));
      })
      .catch(() => {
        this.pending.delete(appid);
        update(this.get(appid));
      });
  }

  private async fetchSchema(appid: number): Promise<SteamAchSchemaItem[]> {
    const res = await fetch(`${STATS_URL}/${this.steamId64}/stats/${appid}/achievements/`, {
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`schema ${res.status}`);
    const items = parsePage(await res.text(), appid);
    if (items.length === 0) throw new Error("empty schema");
    return items;
  }
}
