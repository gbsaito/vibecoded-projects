import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Bookmark } from "./types.ts";
import { normalizeUrl } from "./url.ts";

const FILE_NAME = "bookmarks.json";

export function storePath(): string {
  const override = process.env.URLINK_BOOKMARKS;
  const dir = override ? dirname(override) : join(homedir(), ".config", "urlink");
  return override ? override : join(dir, FILE_NAME);
}

export function importDir(): string {
  const override = process.env.URLINK_IMPORT_DIR;
  return override ?? join(homedir(), ".config", "urlink");
}

export function defaultImportPath(): string {
  const dir = importDir();
  if (!existsSync(dir)) return "";
  const files = readdirSync(dir).filter((f) => /^urlink-export-.*\.json$/.test(f)).sort();
  if (files.length === 0) return "";
  return join(dir, files[files.length - 1]!);
}

export function loadBookmarks(): Bookmark[] {
  try {
    if (!existsSync(storePath())) return [];
    const raw = JSON.parse(readFileSync(storePath(), "utf8")) as { bookmarks?: Bookmark[] };
    const list = Array.isArray(raw.bookmarks) ? raw.bookmarks : [];
    if (!list.every((b) => b && typeof b.id === "string")) return [];
    return list;
  } catch {
    return [];
  }
}

export function saveBookmarks(bookmarks: Bookmark[]): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ bookmarks }, null, 2));
}

export function configPath(): string {
  return join(dirname(storePath()), "config.json");
}

function readConfig(): Record<string, unknown> {
  try {
    if (!existsSync(configPath())) return {};
    const raw = JSON.parse(readFileSync(configPath(), "utf8")) as unknown;
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function loadTheme(): string {
  const theme = readConfig().theme;
  return typeof theme === "string" ? theme : "dark";
}

export function saveTheme(theme: string): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  const config = readConfig();
  config.theme = theme;
  writeFileSync(path, JSON.stringify(config, null, 2));
}

export function defaultExportPath(): string {
  const override = process.env.URLINK_EXPORT;
  if (override) return override;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return join(homedir(), ".config", "urlink", `urlink-export-${stamp}.json`);
}

export type ExportFormat = "json" | "csv";

export function importBookmarks(path: string, format: ExportFormat = "json"): Bookmark[] {
  if (format === "csv") return importBookmarksCsv(path);
  const raw = JSON.parse(readFileSync(path, "utf8")) as { bookmarks?: Bookmark[] };
  const list = Array.isArray(raw.bookmarks) ? raw.bookmarks : [];
  return list.filter((b) => b && typeof b.id === "string");
}

export function exportBookmarks(bookmarks: Bookmark[], path: string, format: ExportFormat = "json"): void {
  mkdirSync(dirname(path), { recursive: true });
  if (format === "csv") {
    const lines = bookmarks.map((b) => [b.url, b.title, b.description, b.tags.join(",")].map(csvField).join(","));
    writeFileSync(path, lines.join("\n") + "\n");
    return;
  }
  writeFileSync(path, JSON.stringify({ bookmarks }, null, 2));
}

function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function parseCsvRow(row: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const c = row[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (row[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      cells.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  return cells;
}

export function importBookmarksCsv(path: string): Bookmark[] {
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const out: Bookmark[] = [];
  lines.forEach((line, idx) => {
    const [url, title, description, tagsText] = parseCsvRow(line);
    const tags = (tagsText ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    if (!url) return;
    out.push({
      id: `imp-${idx + 1}`,
      url: url.trim(),
      title: title?.trim() ?? "",
      description: description?.trim() ?? "",
      tags,
      archived: false,
      createdAt: Date.now(),
    });
  });
  return out;
}

export function upsertBookmark(list: Bookmark[], bookmark: Bookmark): Bookmark[] {
  const idx = list.findIndex((b) => b.id === bookmark.id);
  if (idx >= 0) {
    const next = [...list];
    next[idx] = bookmark;
    return next;
  }
  return [...list, bookmark];
}

export function nextId(list: Bookmark[]): string {
  const max = list.reduce((acc, b) => {
    const n = Number.parseInt(b.id.replace(/^\D+/, ""), 10);
    return Number.isFinite(n) && n > acc ? n : acc;
  }, 0);
  return String(max + 1);
}

const METADATA_CACHE = new Map<string, { title?: string; description?: string }>();

export function clearMetadataCache(url?: string): void {
  if (!url) {
    METADATA_CACHE.clear();
    return;
  }
  METADATA_CACHE.delete(normalizeUrl(url));
}

export async function fetchMetadata(url: string): Promise<{ title?: string; description?: string }> {
  const key = normalizeUrl(url);
  const hit = METADATA_CACHE.get(key);
  if (hit) return hit;
  const meta = await fetchMeta(key);
  if (meta.title || meta.description) {
    METADATA_CACHE.set(key, meta);
  }
  return meta;
}

export function youtubeId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts[0] === "shorts" || parts[0] === "embed" || parts[0] === "live") return parts[1] ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchYouTubeMeta(url: string): Promise<{ title?: string; description?: string }> {
  const id = youtubeId(url);
  if (id) {
    const viaApi = await fetchYouTubeApi(id);
    if (viaApi.title || viaApi.description) return viaApi;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return {};
    const data = (await res.json()) as { title?: string };
    return { title: data.title?.trim() || undefined };
  } catch {
    return {};
  }
}

async function fetchYouTubeApi(id: string): Promise<{ title?: string; description?: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch("https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        videoId: id,
        context: { client: { clientName: "WEB", clientVersion: "2.20240101.00.00" } },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return {};
    const data = (await res.json()) as { videoDetails?: { title?: string; shortDescription?: string } };
    const details = data.videoDetails;
    if (!details) return {};
    return {
      title: details.title?.trim() || undefined,
      description: details.shortDescription?.replace(/\s+/g, " ").trim().slice(0, 500) || undefined,
    };
  } catch {
    return {};
  }
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function stripCdata(text: string): string {
  return text.replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "");
}

export function mediumFeedUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host !== "medium.com") return null;
    const m = u.pathname.match(/^\/@([^/]+)/);
    return m ? `https://medium.com/feed/@${m[1]}` : null;
  } catch {
    return null;
  }
}

export function parseMediumFeed(xml: string, articleUrl: string): { title?: string; description?: string } | null {
  const target = articleUrl.split("?")[0]!.replace(/\/$/, "");
  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
  for (const item of items) {
    const rawLink = stripCdata(item.match(/<link>([\s\S]*?)<\/link>/i)?.[1]?.trim() ?? "");
    const link = decodeXmlEntities(rawLink).split("?")[0]!.replace(/\/$/, "");
    if (!link || link !== target) continue;
    const rawTitle = stripCdata(item.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "");
    const rawDescription = item.match(/<description>([\s\S]*?)<\/description>/i)?.[1]?.trim() ?? "";
    const rawContent = stripCdata(item.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/i)?.[1]?.trim() ?? "");
    const contentParagraphs = [...rawContent.matchAll(/<p>([\s\S]*?)<\/p>/gi)].slice(0, 2).map((m) => m[1]);
    const descriptionHtml = stripCdata(rawDescription) || contentParagraphs.join(" ");
    const title = decodeXmlEntities(rawTitle).replace(/\s+/g, " ").trim();
    const description = decodeXmlEntities(descriptionHtml.replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .replace(/\s+([.,!?;:])/g, "$1")
      .trim()
      .slice(0, 300);
    return { title: title || undefined, description: description || undefined };
  }
  return null;
}

async function fetchMediumMeta(url: string): Promise<{ title?: string; description?: string }> {
  const feed = mediumFeedUrl(url);
  if (!feed) return {};
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(feed, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return {};
    return parseMediumFeed(await res.text(), url) ?? {};
  } catch {
    return {};
  }
}

export function tiktokVideo(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (!["tiktok.com", "m.tiktok.com", "vm.tiktok.com"].includes(host)) return false;
    return /\/video\/\d+/.test(u.pathname) || host === "vm.tiktok.com";
  } catch {
    return false;
  }
}

export function parseTikTokPage(html: string): { title?: string; description?: string } {
  const raw = html.match(/"itemStruct"\s*:\s*\{[\s\S]*?"desc"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
  if (!raw) return {};
  let desc = raw;
  try {
    desc = JSON.parse(`"${raw}"`) as string;
  } catch {
    /* keep the raw capture */
  }
  const title = desc.replace(/\s+/g, " ").trim().slice(0, 200);
  return { title: title || undefined };
}

async function fetchTikTokMeta(url: string): Promise<{ title?: string; description?: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return {};
    return parseTikTokPage(await res.text());
  } catch {
    return {};
  }
}

async function fetchMeta(url: string): Promise<{ title?: string; description?: string }> {
  if (youtubeId(url)) {
    const yt = await fetchYouTubeMeta(url);
    if (yt.title || yt.description) return yt;
  }
  if (tiktokVideo(url)) {
    const tt = await fetchTikTokMeta(url);
    if (tt.title || tt.description) return tt;
  }
  if (mediumFeedUrl(url)) {
    const medium = await fetchMediumMeta(url);
    if (medium.title || medium.description) return medium;
  }
  return fetchHtmlMeta(url);
}

async function fetchHtmlMeta(url: string): Promise<{ title?: string; description?: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return {};
    const html = await res.text();
    const title =
      html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i)?.[1]?.trim() ||
      html.match(/<meta[^>]+name=["']twitter:title["'][^>]*content=["']([^"']*)["']/i)?.[1]?.trim() ||
      html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ||
      "";
    const description =
      html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i)?.[1]?.trim() ||
      html.match(/<meta[^>]+name=["']twitter:description["'][^>]*content=["']([^"']*)["']/i)?.[1]?.trim() ||
      html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1]?.trim() ||
      "";
    return { title: title || undefined, description: description || undefined };
  } catch {
    return {};
  }
}

export function hostnameOf(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname;
  } catch {
    return url;
  }
}

export function copyToClipboard(text: string): boolean {
  if (!text) return false;
  const isLinux = process.platform === "linux";
  const candidates: Array<[string, string[]]> =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : process.platform === "win32"
        ? [["clip", []]]
        : process.env.WAYLAND_DISPLAY
          ? [
              ["wl-copy", []],
              ["xclip", ["-selection", "clipboard"]],
              ["xsel", ["--clipboard", "--input"]],
            ]
          : [
              ["xclip", ["-selection", "clipboard"]],
              ["xsel", ["--clipboard", "--input"]],
              ["wl-copy", []],
            ];
  for (const [cmd, args] of candidates) {
    try {
      const res = spawnSync(cmd, args, { input: text, timeout: 1000, stdio: ["pipe", "ignore", "ignore"] });
      if (!res.error && res.status === 0) return true;
    } catch {
      /* try the next clipboard tool */
    }
  }
  if (isLinux || process.platform === "darwin") {
    try {
      const encoded = Buffer.from(text, "utf8").toString("base64");
      process.stdout.write(`\x1b]52;c;${encoded}\x07`);
    } catch {
      /* noop */
    }
  }
  return false;
}

export function openUrl(url: string): void {
  if (!url) return;
  const child = spawn(
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open",
    [url],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  child.on("error", () => {
    /* opener missing or failed to spawn — ignore */
  });
}
