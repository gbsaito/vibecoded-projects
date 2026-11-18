// Achievement icons, fetched straight from the Steam CDN URLs found in the
// schema feed (iconOpen for unlocked, iconClosed for locked) and cached on
// disk under ~/.cache/steamtui/achicons/<appid>.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { normalizeImage } from "./art";

const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";

const ROOT = path.join(process.env.XDG_CACHE_HOME ?? path.join(process.env.HOME ?? "/tmp", ".cache"), "steamtui", "achicons");

export class AchievementIcons {
  private readonly mem = new Map<string, Uint8Array>();
  private readonly pending = new Set<string>();

  private file(appid: number, api: string, achieved: boolean): string {
    return path.join(ROOT, `${appid}`, `${api}-${achieved ? "open" : "closed"}.img`);
  }

  get(appid: number, api: string, achieved: boolean): Uint8Array | null {
    const key = `${appid}/${api}/${achieved}`;
    const mem = this.mem.get(key);
    if (mem) return mem;
    const file = this.file(appid, api, achieved);
    if (!existsSync(file)) return null;
    try {
      const bytes = new Uint8Array(normalizeImage(readFileSync(file)));
      this.mem.set(key, bytes);
      return bytes;
    } catch {
      return null;
    }
  }

  /** Fetch the icon lazily; calls update(bytes) once ready (null on failure). */
  ensure(
    appid: number,
    api: string,
    achieved: boolean,
    url: string,
    update: (bytes: Uint8Array | null) => void,
  ): void {
    const cached = this.get(appid, api, achieved);
    if (cached) {
      update(cached);
      return;
    }
    const key = `${appid}/${api}/${achieved}`;
    if (this.pending.has(key)) return;
    this.pending.add(key);
    const finish = (bytes: Uint8Array | null) => {
      this.pending.delete(key);
      update(bytes);
    };
    if (!url) {
      finish(null);
      return;
    }
    fetch(url, {
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(15_000),
    })
      .then(async (res) => {
        if (!res.ok) return finish(null);
        const buf = normalizeImage(Buffer.from(await res.arrayBuffer()));
        if (buf.length < 50) return finish(null);
        try {
          mkdirSync(path.join(ROOT, `${appid}`), { recursive: true });
          writeFileSync(this.file(appid, api, achieved), buf);
        } catch {
          /* best effort */
        }
        const bytes = new Uint8Array(buf);
        this.mem.set(key, bytes);
        finish(bytes);
      })
      .catch(() => finish(null));
  }
}
