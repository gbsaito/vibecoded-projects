/**
 * JSON import/export.
 *
 * The export envelope is deliberately the same shape as `db.json` plus a
 * `format` marker and an `exportedAt` timestamp, so an exported file is also a
 * usable library file. Import stays tolerant on purpose: it accepts the
 * export envelope, a raw db document (`{ version, entries }`) and the legacy
 * bare-array format, and it runs the same normalisation and rating migration
 * as `Store.load`.
 *
 * Import modes:
 *  - `replace` swaps the whole library for the file's entries.
 *  - `merge` keeps the local library and overwrites entries with matching ids;
 *    new ids are appended. Unlike `Store.upsert`, a match replaces the local
 *    status/rating/progress too — a restore should restore them.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Entry } from "./model.ts";
import {
  CURRENT_VERSION,
  migrateRatings,
  normalizeEntry,
  writeAtomic,
} from "./store.ts";

/** Marker written into exports so a file can be recognised by hand. */
export const TRANSFER_FORMAT = "mst";

export interface TransferDoc {
  format: typeof TRANSFER_FORMAT;
  version: number;
  exportedAt: string;
  entries: Entry[];
}

export interface TransferSummary {
  entries: Entry[];
  /** Version read from the source document. */
  version: number;
  /** Entries dropped because they were not usable (missing id or title). */
  skipped: number;
}

export interface MergeResult {
  entries: Entry[];
  added: number;
  updated: number;
}

export type ImportMode = "merge" | "replace";

/** Serialize the library as a pretty-printed, versioned JSON document. */
export function exportJson(entries: Entry[], now: Date = new Date()): string {
  const doc: TransferDoc = {
    format: TRANSFER_FORMAT,
    version: CURRENT_VERSION,
    exportedAt: now.toISOString(),
    entries,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function readVersion(value: unknown): number {
  if (value === undefined || value === null) return CURRENT_VERSION;
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/** True when the value can become an `Entry` (id and a non-empty title). */
function isUsableEntry(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  const id = rec.id;
  const title = rec.title;
  const hasId =
    (typeof id === "string" && id.trim() !== "") ||
    (typeof id === "number" && Number.isFinite(id));
  return hasId && typeof title === "string" && title.trim() !== "";
}

/**
 * Parse an import document. Throws with a user-facing message when the
 * document is not JSON, has no entries array, or comes from a newer schema.
 */
export function parseTransfer(text: string): TransferSummary {
  let doc: unknown;
  try {
    doc = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (e) {
    throw new Error(`invalid JSON: ${(e as Error).message}`);
  }

  let list: unknown[];
  let version: number;
  if (Array.isArray(doc)) {
    list = doc;
    version = 1;
  } else if (doc && typeof doc === "object") {
    const rec = doc as Record<string, unknown>;
    if (typeof rec.format === "string" && rec.format !== TRANSFER_FORMAT) {
      throw new Error(`not an ${TRANSFER_FORMAT} export (format: ${rec.format})`);
    }
    if (!Array.isArray(rec.entries)) {
      throw new Error('expected a JSON object with an "entries" array');
    }
    list = rec.entries;
    version = readVersion(rec.version);
    if (version > CURRENT_VERSION) {
      throw new Error(
        `file uses version ${version}; this build reads up to ${CURRENT_VERSION}`,
      );
    }
  } else {
    throw new Error('expected a JSON object with an "entries" array');
  }

  const byId = new Map<string, Entry>();
  let invalid = 0;
  for (const raw of list) {
    if (!isUsableEntry(raw)) {
      invalid++;
      continue;
    }
    const entry = { ...(raw as Entry) };
    normalizeEntry(entry, version);
    if (version < 2) migrateRatings([entry]);
    // Later duplicates win: a file is read top to bottom.
    byId.set(entry.id, entry);
  }
  const skipped = invalid;

  const entries = [...byId.values()];
  if (list.length > 0 && entries.length === 0) {
    throw new Error(`no usable entries (${skipped} skipped)`);
  }
  return { entries, version, skipped };
}

/** Merge imported entries into the local library by id. */
export function mergeEntries(current: Entry[], incoming: Entry[]): MergeResult {
  const entries = [...current];
  const index = new Map(entries.map((e, i) => [e.id, i]));
  let added = 0;
  let updated = 0;
  for (const entry of incoming) {
    const i = index.get(entry.id);
    if (i === undefined) {
      index.set(entry.id, entries.length);
      entries.push(entry);
      added++;
    } else {
      entries[i] = entry;
      updated++;
    }
  }
  return { entries, added, updated };
}

/** Resolve `~`, `~/...` and relative paths against the current directory. */
export function expandPath(input: string): string {
  const p = input.trim();
  if (!p) throw new Error("no path given");
  if (p === "~") return homedir();
  if (p === "~/" || p.startsWith("~/")) return join(homedir(), p.slice(2));
  return resolve(p);
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** Suggested export path: `~/mst-export-YYYY-MM-DD-HHMM.json`. */
export function defaultExportPath(now: Date = new Date()): string {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `~/mst-export-${date}-${time}.json`;
}

export function writeTransferFile(
  path: string,
  entries: Entry[],
  now: Date = new Date(),
): void {
  writeAtomic(path, exportJson(entries, now));
}

export function readTransferFile(path: string): TransferSummary {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`reading ${path}: ${(e as Error).message}`);
  }
  try {
    return parseTransfer(text);
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
}
