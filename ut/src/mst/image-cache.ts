import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

/** How long to hold off re-fetching a URL after a failure. */
const RETRY_MS = 30_000;

export class ImageCache {
  private readonly dir: string;
  private readonly mem = new Map<string, Uint8Array>();
  private readonly memCap = 50;
  /** URLs with a fetch in flight, so concurrent renders don't re-request. */
  private readonly pending = new Set<string>();
  /** URLs that failed, held off until this timestamp, then retried. */
  private readonly retryAfter = new Map<string, number>();
  private onChange: () => void = () => {};

  constructor(dir: string) {
    this.dir = join(dir, "images");
    try { mkdirSync(this.dir, { recursive: true }); } catch { /* ignore */ }
  }

  setOnChange(cb: () => void): void {
    this.onChange = cb;
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
      // Refresh recency.
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

  async ensure(url: string): Promise<void> {
    if (this.mem.has(url) || this.pending.has(url)) return;
    const until = this.retryAfter.get(url);
    if (until !== undefined && Date.now() < until) return;
    // A memory miss with the file on disk is a hit: load it, never re-fetch.
    if (this.get(url)) return;
    this.pending.add(url);
    try {
      const res = await fetch(url);
      if (!res.ok) {
        this.retryAfter.set(url, Date.now() + RETRY_MS);
        return;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100) {
        this.retryAfter.set(url, Date.now() + RETRY_MS);
        return;
      }
      const data = new Uint8Array(normalizeImage(buf));
      this.memSet(url, data);
      const f = this.file(url);
      writeFileSync(f, data);
      this.retryAfter.delete(url);
      this.onChange();
    } catch {
      this.retryAfter.set(url, Date.now() + RETRY_MS);
    } finally {
      this.pending.delete(url);
    }
  }

  private file(url: string): string {
    const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
    const ext = url.split("?")[0].split(".").pop() || "jpg";
    return join(this.dir, `${hash}.${ext}`);
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