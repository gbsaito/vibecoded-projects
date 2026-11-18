/**
 * Export: turn the stored library into a portable data file.
 *
 * Two formats for now:
 *  - `json` — canonical. Mirrors the on-disk db document (`{version, games}`)
 *    and is what the app itself reads back, so an export is a restorable file.
 *    Each game carries its preferred cover (`image`), so picking a cover and
 *    exporting keeps it.
 *  - `csv` — pragmatic second format for spreadsheet / BI use. Nested arrays
 *    (sources, genres, ...) become semicolon-joined strings so one row stays
 *    one line. The preferred cover (`image`) is a column like any other, so a
 *    cover choice survives a CSV export too.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { CURRENT_VERSION, writeAtomic } from "./store.ts";
import type { Game } from "./model.ts";

export const EXPORT_FORMATS = ["json", "csv"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export function exportDir(): string {
  const base = process.env.XDG_EXPORT_HOME ?? join(homedir() ?? ".", ".local", "share");
  return join(base, "ut", "tvl");
}

export function exportFileName(format: ExportFormat, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  const ext = format === "json" ? "json" : "csv";
  return `tvl-export-${stamp}.${ext}`;
}

export function exportPath(format: ExportFormat, now: Date = new Date()): string {
  return join(exportDir(), exportFileName(format, now));
}

/** Render the library as an export document in the given format. */
export function gamesToExport(games: Game[], format: ExportFormat): string {
  if (format === "json") {
    return JSON.stringify({ version: CURRENT_VERSION, games }, null, 2);
  }
  const header = [
    "id",
    "title",
    "year",
    "image",
    "status",
    "rating",
    "playtime_hours",
    "platform",
    "sources",
    "price",
    "metacritic",
    "developers",
    "publishers",
    "platformsAvailable",
    "genres",
    "wishlist",
    "hundredPercent",
    "addedAt",
    "url",
  ];
  const lines = [header.join(",")];
  for (const g of games) {
    lines.push(
      [
        g.id,
        g.title,
        g.year,
        g.image,
        g.status,
        g.rating,
        g.playtime?.hours ?? null,
        g.platform,
        g.sources.join(";"),
        g.price,
        g.metacritic,
        g.developers.join(";"),
        g.publishers.join(";"),
        g.platformsAvailable.join(";"),
        g.genres.join(";"),
        g.wishlist,
        g.hundredPercent,
        g.addedAt,
        g.url,
      ]
        .map((v) => csvCell(v))
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

function csvCell(v: string | number | boolean | null | undefined): string {
  const s = v === null || v === undefined ? "" : String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Atomically write an export file, same contract as the library save. */
export function writeExport(path: string, contents: string): void {
  writeAtomic(path, contents);
}
