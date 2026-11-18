/**
 * Where mst keeps its files.
 *
 * Default: db under the XDG config dir, cache under the XDG cache dir.
 * `--path <dir>` makes the run self-contained — `db.json` and the cache all
 * live under that one directory, so alternate/test data never mixes with the
 * real profile (and `~/.cache/mst` is never touched).
 */

import { join } from "node:path";
import { utCacheDir, utConfig } from "../utdirs.ts";

export interface Paths {
  /** `db.json` location. */
  db: string;
  /** Root holding the `search/` and `images/` caches. */
  cache: string;
}

export function resolvePaths(dir: string | null): Paths {
  if (dir) {
    return { db: join(dir, "db.json"), cache: join(dir, "cache") };
  }
  // `~/.config/ut/mst/db.json` and `~/.cache/ut/mst`; the host migrates
  // standalone-mst data in on start.
  return { db: utConfig("mst", "db.json"), cache: utCacheDir("mst") };
}

/** Read the value of a `--flag value` argument, or null when absent. */
export function argValue(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}
