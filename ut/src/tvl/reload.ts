/**
 * Cache reset for `tvl --reload`.
 *
 * Everything the app caches lives under one directory: the search results and
 * the downloaded cover art. Wiping it makes the next run fetch everything again
 * from the network.
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ReloadReport {
  /** Directories that were removed, by name. */
  readonly removed: string[];
  /** How many files were deleted in total. */
  readonly files: number;
}

/** How many files a directory holds, for the report. */
function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const p = join(dir, name);
    try {
      if (statSync(p).isDirectory()) n += countFiles(p);
      else n++;
    } catch {
      /* ignore */
    }
  }
  return n;
}

/**
 * Delete the cached search results and cover art, so the next run starts
 * from scratch. The library itself is never touched.
 */
export function clearCaches(cacheRoot: string): ReloadReport {
  const removed: string[] = [];
  let files = 0;

  for (const name of ["search", "images"]) {
    const dir = join(cacheRoot, name);
    if (!existsSync(dir)) continue;
    files += countFiles(dir);
    try {
      rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    } catch {
      /* leave it in place rather than fail the start-up */
    }
  }

  return { removed, files };
}
