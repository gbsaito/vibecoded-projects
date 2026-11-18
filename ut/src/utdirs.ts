/**
 * ut's own config/cache layout.
 *
 * All three trackers keep their data under `~/.config/ut/<tracker>/`
 * (mirrored by `~/.cache/ut/<tracker>/` for caches). The standalone
 * per-project dirs (`~/.config/mst` etc.) are gone: ut owns the data.
 */

import { homedir } from "node:os";
import { join } from "node:path";

const configBase = (): string =>
  process.env.XDG_CONFIG_HOME ?? join(homedir() ?? ".", ".config");
const cacheBase = (): string =>
  process.env.XDG_CACHE_HOME ?? join(homedir() ?? ".", ".cache");

/** A tracker's directory inside ut's config dir. */
export function utConfigDir(tracker: string): string {
  return join(configBase(), "ut", tracker);
}

/** A data file inside ut's config dir, e.g. `utConfig("mst", "db.json")`. */
export function utConfig(tracker: string, file: string): string {
  return join(utConfigDir(tracker), file);
}

/** A tracker's cache root, e.g. `utCacheDir("tvl")` → `~/.cache/ut/tvl`. */
export function utCacheDir(tracker: string): string {
  return join(cacheBase(), "ut", tracker);
}
