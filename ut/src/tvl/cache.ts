/**
 * Search-result cache: an in-memory LRU backed by a directory of small JSON
 * files, so repeat searches are instant and survive restarts.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hit } from "./model.ts";

interface MemEntry<V> {
  value: V;
  at: number;
}

export class Lru<V> {
  private readonly cap: number;
  private map = new Map<string, MemEntry<V>>();

  constructor(cap: number) {
    this.cap = cap;
  }

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, at: Date.now() });
    while (this.map.size > this.cap) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  entry(key: string): MemEntry<V> | undefined {
    return this.map.get(key);
  }

  touch(key: string): void {
    const hit = this.map.get(key);
    if (!hit) return;
    this.map.delete(key);
    this.map.set(key, hit);
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

const hash = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

export class SearchCache {
  private readonly dir: string;
  private readonly ttlMs: number;
  private mem = new Lru<Hit[]>(256);
  private pendingWrites = new Set<string>();

  constructor(dir: string, ttlMs: number = 7 * 24 * 60 * 60 * 1000) {
    this.dir = dir;
    this.ttlMs = ttlMs;
  }

  private file(key: string): string {
    return join(this.dir, "search", `${hash(key)}.json`);
  }

  peek(query: string): Hit[] | undefined {
    return this.mem.get(normalizeKey(query));
  }

  get(query: string): Hit[] | undefined {
    const key = normalizeKey(query);

    const hot = this.mem.entry(key);
    if (hot) {
      if (Date.now() - hot.at <= this.ttlMs) {
        this.mem.touch(key);
        return hot.value;
      }
      return undefined;
    }

    const f = this.file(key);
    if (!existsSync(f)) return undefined;
    try {
      const doc = JSON.parse(readFileSync(f, "utf8")) as { at: number; hits: Hit[] };
      if (Date.now() - doc.at > this.ttlMs) return undefined;
      this.mem.set(key, doc.hits);
      return doc.hits;
    } catch {
      this.forget(f);
      return undefined;
    }
  }

  set(query: string, hits: Hit[]): void {
    const key = normalizeKey(query);
    this.mem.set(key, hits);
    this.persist(key, hits);
  }

  private persist(key: string, hits: Hit[]): void {
    const f = this.file(key);
    if (this.pendingWrites.has(f)) return;
    this.pendingWrites.add(f);

    setTimeout(() => {
      try {
        mkdirSync(join(this.dir, "search"), { recursive: true });
        const tmp = `${f}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ at: Date.now(), hits }), "utf8");
        renameSync(tmp, f);
        this.sweep();
      } catch {
        /* a cache write failure is never fatal */
      } finally {
        this.pendingWrites.delete(f);
      }
    }, 0);
  }

  private forget(f: string): void {
    try {
      unlinkSync(f);
    } catch {
      /* already gone */
    }
  }

  private sweep(): void {
    const d = join(this.dir, "search");
    if (!existsSync(d)) return;
    let files: string[];
    try {
      files = readdirSync(d);
    } catch {
      return;
    }
    for (const name of files.slice(0, 500)) {
      const f = join(d, name);
      try {
        if (Date.now() - statSync(f).mtimeMs > this.ttlMs) this.forget(f);
      } catch {
        /* ignore */
      }
    }
  }

  /** Drops every cached result, in memory and on disk. */
  clear(): void {
    this.mem.clear();
    this.pendingWrites.clear();
    const d = join(this.dir, "search");
    if (!existsSync(d)) return;
    let files: string[];
    try {
      files = readdirSync(d);
    } catch {
      return;
    }
    for (const name of files) this.forget(join(d, name));
  }
}

function normalizeKey(q: string): string {
  return q.trim().toLowerCase();
}
