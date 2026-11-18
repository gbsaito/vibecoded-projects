/**
 * Image cache: cover art fetched once, kept in a small in-memory LRU and
 * mirrored to disk.
 *
 * PNGs are normalized before they are stored, because OpenTUI's native decoder
 * rejects PNGs carrying ancillary chunks (it reports "unsupported image color
 * space"). Only IHDR/IDAT/IEND are kept.
 */

import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

/** Fetches allowed to touch the network at once. */
const FETCH_CONCURRENCY = 6;

interface FetchJob {
  readonly url: string;
  readonly resolve: () => void;
}

export class ImageCache {
  private readonly dir: string;
  private readonly mem = new Map<string, Uint8Array>();
  private readonly memCap = 50;
  private onChange: () => void = () => {};
  /** Visible art queued ahead of background prefetches. */
  private readonly high: FetchJob[] = [];
  private readonly low: FetchJob[] = [];
  private readonly jobs = new Map<string, FetchJob>();
  private readonly waiters = new Map<string, Promise<void>>();
  private active = 0;

  constructor(dir: string) {
    this.dir = join(dir, "images");
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch {
      /* ignore */
    }
  }

  setOnChange(cb: () => void): void {
    this.onChange = cb;
  }

  /**
   * Drops the in-memory copies. The files on disk are left alone; use the
   * reload helper to remove those as well.
   */
  clear(): void {
    this.mem.clear();
  }

  private memSet(url: string, data: Uint8Array): void {
    if (this.mem.has(url)) this.mem.delete(url);
    this.mem.set(url, data);
    while (this.mem.size > this.memCap) {
      const oldest = this.mem.keys().next();
      if (oldest.done) break;
      this.mem.delete(oldest.value);
    }
  }

  get(url: string): Uint8Array | null {
    if (this.mem.has(url)) {
      const v = this.mem.get(url)!;
      this.mem.delete(url);
      this.mem.set(url, v);
      return v;
    }
    const f = this.file(url);
    if (existsSync(f)) {
      try {
        const buf = readFileSync(f);
        if (buf.length < 100) return null;
        const data = new Uint8Array(normalizeImage(buf));
        this.memSet(url, data);
        return data;
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Load art needed on screen now. Repeated calls while the download is in
   * flight share one request; that matters because the render loop asks for
   * the same poster on every frame.
   */
  ensure(url: string, priority = true): Promise<void> {
    const waiting = this.waiters.get(url);
    if (waiting) {
      if (priority) this.promote(url);
      return waiting;
    }
    if (this.mem.has(url)) return Promise.resolve();

    const f = this.file(url);
    if (existsSync(f)) {
      try {
        const buf = readFileSync(f);
        if (buf.length >= 100) {
          this.memSet(url, new Uint8Array(buf));
          return Promise.resolve();
        }
      } catch {
        /* fall through and refetch */
      }
    }

    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    const job: FetchJob = { url, resolve };
    this.waiters.set(url, promise);
    this.jobs.set(url, job);
    (priority ? this.high : this.low).push(job);
    this.pump();
    return promise;
  }

  /** Queue art for later, behind anything the user is looking at. */
  warm(url: string): Promise<void> {
    return this.ensure(url, false);
  }

  /** Move a queued background image to the front when it becomes visible. */
  private promote(url: string): void {
    const job = this.jobs.get(url);
    if (!job) return;
    const i = this.low.indexOf(job);
    if (i < 0) return;
    this.low.splice(i, 1);
    this.high.unshift(job);
  }

  private pump(): void {
    while (this.active < FETCH_CONCURRENCY) {
      const job = this.high.shift() ?? this.low.shift();
      if (!job) break;
      this.active++;
      void this.fetch(job.url).finally(() => {
        this.jobs.delete(job.url);
        this.waiters.delete(job.url);
        this.active--;
        job.resolve();
        this.pump();
      });
    }
  }

  private async fetch(url: string): Promise<void> {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100) return;
      const data = new Uint8Array(normalizeImage(buf));
      this.memSet(url, data);
      writeFileSync(this.file(url), data);
      this.onChange();
    } catch {
      /* ignore */
    }
  }

  private file(url: string): string {
    const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
    // CDN URLs often have no extension (Epic) or carry query parameters (PS).
    // Never use the final path segment as an extension: it can exceed NAME_MAX.
    const ext = /\.(png|jpe?g|webp|gif)(?:$|\?)/i.exec(url)?.[1]?.toLowerCase() ?? "img";
    return join(this.dir, `${hash}.${ext === "jpeg" ? "jpg" : ext}`);
  }
}

/**
 * Normalize an image (PNG) by stripping non-essential chunks that OpenTUI's
 * native decoder can't handle ("unsupported image color space"). Keeps only
 * IHDR, IDAT, IEND. Non-PNG data is returned unchanged.
 */
function normalizeImage(buf: Buffer): Buffer {
  // PNG signature
  if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
    return buf; // not PNG, leave alone
  }
  const out: Buffer[] = [buf.subarray(0, 8)]; // signature
  let pos = 8;
  while (pos < buf.length) {
    if (pos + 12 > buf.length) break;
    const length = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const chunkEnd = pos + 12 + length;
    if (chunkEnd > buf.length) break;
    // Keep only IHDR, IDAT, IEND.
    if (type === "IHDR" || type === "IDAT" || type === "IEND") {
      out.push(buf.subarray(pos, chunkEnd));
    }
    pos = chunkEnd;
    if (type === "IEND") break;
  }
  return Buffer.concat(out);
}
