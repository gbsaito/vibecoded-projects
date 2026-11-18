/**
 * Rendering.
 *
 * OpenTUI's retained renderable tree, absolutely positioned. Row, grid-cell
 * and detail-line renderables are pooled so a large list only allocates what
 * fits on screen.
 *
 * Colour goes through `fg`/`bg` on the renderable — OpenTUI does not parse
 * ANSI escapes out of a content string.
 */

import {
  BoxRenderable,
  ImageRenderable,
  TextRenderable,
  fg,
  StyledText,
  t,
  type CliRenderer,
  type Renderable,
} from "@opentui/core";
import { App, GRID_CELL_H, Tabs, isSearchTab } from "./app.ts";
import {
  MAX_RATING,
  Status,
  statusIcon,
  statusLabel,
  sortLabel,
  Theme,
  type Entry,
  type Hit,
} from "./model.ts";
import { ImageCache } from "./image-cache.ts";

const colors = (theme: Theme) => theme === Theme.Light
  ? {
      bg: "#ffffff",
      fg: "#1a1a2e",
      dim: "#6b7280",
      accent: "#2563eb",
      selBg: "#dbeafe",
      selFg: "#1a1a2e",
      warn: "#d97706",
      err: "#dc2626",
      ok: "#16a34a",
      panel: "#f3f4f6",
      border: "#d1d5db",
      bar: "#e5e7eb",
    }
  : {
      bg: "transparent",
      fg: "#d8dee9",
      dim: "#6b7280",
      accent: "#7aa2f7",
      selBg: "#2b3a55",
      selFg: "#ffffff",
      warn: "#e0af68",
      err: "#f7768e",
      ok: "#9ece6a",
      panel: "#11141c",
      border: "#3b4261",
      bar: "#000000",
    };

// Default (dark) palette kept for module-level helpers.
const C = colors(Theme.Dark);

const TAB_ICON_SEARCH = "\uf002";

interface Line {
  text?: string;
  fg?: string;
  styled?: StyledText;
}

interface Pool<T> {
  take(i: number): T;
  reset(): void;
  /** Destroy every renderable and detach it from the tree. */
  clear(): void;
}

function makePool<T extends Renderable>(root: Renderable, make: () => T): Pool<T> {
  const items: T[] = [];
  return {
    take(i) {
      let it = items[i];
      if (!it) {
        it = make();
        root.add(it);
        items[i] = it;
      }
      return it;
    },
    reset() {
      for (const it of items) if (it) it.visible = false;
    },
    clear() {
      for (const it of items) if (it && !it.isDestroyed) it.destroy();
      items.length = 0;
    },
  };
}

const pad = (s: string, n: number): string =>
  s.length >= n ? s.slice(0, Math.max(0, n)) : s + " ".repeat(n - s.length);

const padL = (s: string, n: number): string =>
  s.length >= n ? s.slice(0, Math.max(0, n)) : " ".repeat(n - s.length) + s;

export class Screen {
  private readonly renderer: CliRenderer;
  private readonly root: Renderable;
  private C: ReturnType<typeof colors>;

  private readonly headerTabs: TextRenderable[];
  private readonly headerRight: TextRenderable;
  private readonly hint: TextRenderable;
  private readonly searchBox: TextRenderable;
  private readonly footer: TextRenderable;

  private readonly detailBox: BoxRenderable;
  private readonly detailPoster: ImageRenderable;
  private readonly detailLinePool: Pool<TextRenderable>;

  private readonly help: BoxRenderable;
  private readonly helpLines: Pool<TextRenderable>;
  private readonly tabsBg: BoxRenderable;

  private listRows: Pool<TextRenderable>;
  private readonly gridPosters: Pool<ImageRenderable>;
  private readonly gridCaptions: Pool<TextRenderable>;

  private scroll = 0;
  private lastTab: string | null = null;
  private detailImageUrl: string | null = null;

  private readonly imageCache: ImageCache;

  constructor(renderer: CliRenderer, imageCache: ImageCache, root?: Renderable) {
    this.renderer = renderer;
    // Hosted by ut: default to the renderer root, an injected tab container when hosted.
    this.root = root ?? renderer.root;
    this.imageCache = imageCache;
    this.C = colors(Theme.Dark);

    const text = (fgColor?: string) =>
      new TextRenderable(renderer, {
        position: "absolute",
        flexShrink: 0,
        content: "",
        fg: fgColor ?? this.C.fg,
      });

    this.headerRight = text(this.C.dim);
    this.root.add(this.headerRight);
    this.hint = text(this.C.dim);
    this.searchBox = text();
    this.footer = text(this.C.dim);
    this.detailLinePool = makePool(this.root, () => text());

    this.detailBox = new BoxRenderable(renderer, {
      position: "absolute",
      flexShrink: 0,
      backgroundColor: this.C.panel,
      border: ["left"],
      borderColor: this.C.border,
    });
    this.root.add(this.detailBox);

    this.detailPoster = new ImageRenderable(renderer, {
      position: "absolute",
      flexShrink: 0,
      protocol: "auto",
      fit: "fit",
      onError: (e) => { console.error("detailPoster load error:", e); },
    });
    this.root.add(this.detailPoster);

    this.help = new BoxRenderable(renderer, {
      position: "absolute",
      flexShrink: 0,
      backgroundColor: this.C.panel,
      border: ["top", "bottom", "left", "right"],
      borderColor: this.C.accent,
      zIndex: 100,
    });
    this.root.add(this.help);

    this.helpLines = makePool(this.root, () => {
      const t = text();
      t.zIndex = 100;
      return t;
    });

    this.tabsBg = new BoxRenderable(renderer, {
      position: "absolute",
      flexShrink: 0,
      backgroundColor: this.C.bar,
    });
    this.root.add(this.tabsBg);

    this.headerTabs = [];
    for (let i = 0; i < Tabs.length; i++) {
      const t = text();
      this.root.add(t);
      this.headerTabs.push(t);
    }
    this.headerRight = text(this.C.dim);
    this.root.add(this.headerRight);

    for (const r of [this.hint, this.searchBox, this.footer]) this.root.add(r);

    this.listRows = makePool(this.root, () => new TextRenderable(this.renderer, { position: 'absolute', flexShrink: 0, content: '', fg: this.C.fg }));
    this.gridCaptions = makePool(this.root, () => text());
    this.gridPosters = makePool(
      this.root,
      () =>
        new ImageRenderable(renderer, {
          position: "absolute",
          flexShrink: 0,
          protocol: "auto",
          fit: "fit",
          onError: () => { /* suppress image load errors in TUI */ },
        }),
    );
  }

  private rendering = false;

  render(app: App): void {
    if (this.rendering) return;
    this.rendering = true;
    try {
      this.C = colors(app.theme);
      const w = this.renderer.width;
      const h = this.renderer.height;

      const MIN_W = 30;
      const MIN_H = 12;

      if (w < MIN_W || h < MIN_H) {
        this.showSizeMessage(app, w, h, `Terminal too small (${w}x${h}). Minimum: ${MIN_W}x${MIN_H}`);
        this.renderer.requestRender();
        return;
      }

      app.viewWidth = w;
      app.viewHeight = h;
      app.cellAspectRatio = this.cellAspectRatio();

      this.layoutSearch(app, w);
      this.layoutBody(app, w, h);
      this.layoutDetail(app, w, h);
      this.layoutFooter(app, w, h);
      this.layoutHelp(app, w, h);

      this.renderer.requestRender();
    } finally {
      this.rendering = false;
    }
  }

  private showSizeMessage(app: App, w: number, h: number, msg: string): void {
    this.listRows.reset();
    this.gridPosters.reset();
    this.gridCaptions.reset();
    this.detailLinePool.reset();
    this.helpLines.reset();
    this.tabsBg.visible = false;
    this.headerRight.visible = false;
    for (const t of this.headerTabs) t.visible = false;
    this.searchBox.visible = false;
    this.hint.visible = false;
    this.footer.visible = false;
    this.detailBox.visible = false;
    this.detailPoster.visible = false;
    this.help.visible = false;
    this.put(this.footer, { text: msg, fg: this.C.warn }, 0, Math.floor(h / 2), w, 1, this.C.bg);
  }

  private put(r: TextRenderable, line: Line, x: number, y: number, w: number, h: number, bg?: string): void {
    const W = this.renderer.width;
    const H = this.renderer.height;
    const clampedX = Math.max(0, Math.min(x, W - 1));
    const clampedY = Math.max(0, Math.min(y, H - 1));
    const clampedW = Math.max(0, Math.min(w, W - clampedX));
    const clampedH = Math.max(0, Math.min(h, H - clampedY));
    if (clampedW === 0 || clampedH === 0) {
      r.visible = false;
      return;
    }
    r.visible = true;
    r.left = clampedX;
    r.top = clampedY;
    r.width = clampedW;
    r.height = clampedH;
    r.fg = line.fg ?? this.C.fg;
    if (bg !== undefined) r.bg = bg;
    if (line.styled) {
      r.content = line.styled;
    } else {
      r.content = pad(line.text ?? "", clampedW);
    }
    r.requestRender();
  }

  // ------------------------------------------------------------------ search

  private layoutSearch(app: App, w: number): void {
    const show = app.focused;
    this.searchBox.visible = show;
    this.hint.visible = show;
    if (!show) return;

    const marker = app.focused ? ">" : " ";
    this.put(
      this.searchBox,
      { text: ` ${marker} ${app.query}` },
      0,
      1,
      w,
      1,
      this.C.selBg,
    );
    this.put(this.hint, { text: `   ${this.searchHint(app)}`, fg: this.C.dim }, 0, 2, w, 1, this.C.bg);
  }

  /** Empty-state copy for the list views. */
  private emptyMessage(app: App, onSearch: boolean): string {
    if (onSearch) {
      return app.query.trim() ? "  no matches" : "  type to search anime and series";
    }
    return `  nothing filed under ${statusLabel(app.current as Status)}`;
  }

  private searchHint(app: App): string {
    if (!isSearchTab(app.current)) {
      return `filtering ${statusLabel(app.current as Status)}: ${app.visible().length} shown  [Tab/Esc] done`;
    }
    if (!app.query.trim()) {
      const n = app.hits.length;
      if (n > 0) return `${n} trending  ·  Enter adds  ·  / to search`;
      return app.searchLoading ? "loading trending..." : " / to search";
    }
    if (app.hits.length === 0) {
      return app.searchLoading ? "searching anime..." : `no match for "${app.query.trim()}"`;
    }
    const n = app.hits.length;
    const state = app.searchLoading
      ? " (checking series...)"
      : app.searchStale
        ? " (cached - providers unreachable)"
        : "";
    return `${n} result${n === 1 ? "" : "s"}${state}  ·  Enter adds  ·  / to search  ·  files to: ${statusLabel(app.pendingStatus)}`;
  }

  // -------------------------------------------------------------------- body

  private layoutBody(app: App, w: number, h: number): void {
    const onSearch = isSearchTab(app.current);
    const top = app.focused ? 3 : 0;
    const bodyH = Math.max(0, h - 1 - top);
    if (bodyH <= 0) {
      this.listRows.reset();
      this.gridPosters.reset();
      this.gridCaptions.reset();
      return;
    }

    const detailW = app.detailWidth(w);
    const bodyW = w - detailW;

    if (onSearch) this.drawList(app, onSearch, 0, top, bodyW, bodyH);
    else if (app.compact) this.drawList(app, onSearch, 0, top, bodyW, bodyH);
    else if (app.grid) this.drawGrid(app, 0, top, bodyW, bodyH);
    else this.drawCompact(app, 0, top, bodyW, bodyH);
  }

  private drawList(app: App, onSearch: boolean, x: number, y: number, w: number, h: number): void {
    // Rebuild the row pool each render so StyledText content is always applied
    // fresh (OpenTUI can skip updates on reused renderables). Destroy the
    // previous pool's renderables first: hiding them only left them attached,
    // so the render tree grew on every frame.
    if (this.listRows) this.listRows.clear();
    this.listRows = makePool(this.root, () => new TextRenderable(this.renderer, { position: 'absolute', flexShrink: 0, content: '', fg: this.C.fg }));
    this.gridPosters.reset();
    this.gridCaptions.reset();

    // Reset scroll offset when switching tabs so rows aren't hidden.
    if (this.lastTab !== app.current) {
      this.lastTab = app.current;
      this.scroll = 0;
    }

    const items: Array<Entry | Hit> = onSearch ? app.hits : app.visible();
    const sel = onSearch ? app.hitSel : app.selected;

    if (items.length === 0) {
      this.put(this.listRows.take(0), { text: this.emptyMessage(app, onSearch), fg: this.C.dim }, x, y, w, 1, this.C.bg);
      return;
    }

    // Column header: mirrors hitLine/entryLine layout.
    const headerText = (() => {
      const rightLabel = `${"EP".padStart(3)} ${"RATING".padStart(6)}`;
      const rightLen = rightLabel.length;
      // Leave one cell for the gap so the line never overflows the width
      // (which was cropping the trailing "G" of "RATING").
      const titleW = Math.max(4, w - 5 - rightLen - 1);
      const left = `${"YEAR".padEnd(5)}${"TITLE".padEnd(titleW)}`;
      const gap = Math.max(1, w - left.length - rightLen);
      return `${left}${" ".repeat(gap)}${rightLabel}`;
    })();

    let rowOffset = 0;
    if (headerText) {
      this.put(this.listRows.take(0), { text: headerText, fg: this.C.dim }, x, y, w, 1, this.C.bg);
      rowOffset = 1;
    }

    const availH = h - rowOffset;
    if (sel < this.scroll) this.scroll = sel;
    if (sel >= this.scroll + availH) this.scroll = sel - availH + 1;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, items.length - availH)));

    for (let r = 0; r < availH; r++) {
      const i = this.scroll + r;
      const t = this.listRows.take(rowOffset + r);
      if (i >= items.length) {
        t.visible = false;
        continue;
      }
      const active = i === sel;
      const item = items[i];
      const bg = active ? this.C.selBg : this.C.bg;
      const baseFg = active ? this.C.selFg : this.C.fg;

      if (onSearch) {
        const hit = hitLine(item as Hit, app, w);
        this.put(t, { styled: hit.styled, fg: baseFg }, x, y + rowOffset + r, w, 1, bg);
      } else {
        const entry = entryLine(item as Entry, w);
        this.put(t, { styled: entry.styled, fg: baseFg }, x, y + rowOffset + r, w, 1, bg);
      }
    }
  }

  private cellAspectRatio(): number {
    const res = this.renderer.resolution;
    const tw = this.renderer.terminalWidth;
    const th = this.renderer.terminalHeight;
    if (!res || tw <= 0 || th <= 0) return 2;
    const cellW = res.width / tw;
    const cellH = res.height / th;
    return cellW > 0 ? cellH / cellW : 2;
  }

  private drawGrid(app: App, x: number, y: number, w: number, h: number): void {
    this.listRows.reset();
    this.gridPosters.reset();
    this.gridCaptions.reset();

    const items = app.visible();
    if (items.length === 0) {
      this.put(
        this.listRows.take(0),
        { text: this.emptyMessage(app, false), fg: this.C.dim },
        x,
        y,
        w,
        1,
        this.C.bg,
      );
      return;
    }

    const cellW = app.gridCellWidth();
    const cellH = GRID_CELL_H;
    const gap = 2;

    // Guard against tiny terminals where a cell cannot fit.
    if (w < cellW || h < cellH + 2) {
      this.listRows.reset();
      this.gridPosters.reset();
      this.gridCaptions.reset();
      this.put(this.listRows.take(0), { text: "Terminal too small for grid view", fg: C.dim }, x, y, w, 1, C.bg);
      return;
    }

    const rows = app.gridRows(h);
    const cols = app.gridColumns(w);
    const perPage = cols * rows;

    const totalPages = Math.ceil(items.length / perPage);
    const page = Math.min(app.gridPage, totalPages - 1);
    app.gridPage = page;
    const start = page * perPage;
    const end = Math.min(start + perPage, items.length);

    const gridW = cols * cellW + (cols - 1) * gap;
    const leftMargin = Math.max(0, Math.floor((w - gridW) / 2));
    const gridH = rows * cellH + (rows - 1) * gap;
    const topMargin = Math.max(0, Math.floor((h - gridH - 1) / 2));

    for (let k = 0; k < perPage; k++) {
      const i = start + k;
      if (i >= end) break;

      const e = items[i];
      const active = i === app.selected;
      const col = k % cols;
      const row = Math.floor(k / cols);
      const cx = leftMargin + col * (cellW + gap);
      const cy = y + topMargin + row * (cellH + gap);

      const caption = this.gridCaptions.take(k);
      caption.visible = true;
      caption.left = cx;
      caption.top = cy + cellH - 3;
      caption.width = cellW;
      caption.height = 3;
      caption.bg = active ? this.C.selBg : this.C.bg;
      caption.fg = active ? this.C.selFg : this.C.dim;
      // Year on the left, personal rating (star + value) right-aligned on the
      // same line. Only shown when rated, like the list/compact views.
      const year = String(e.year ?? "????");
      const personal = e.rating != null && e.rating > 0 ? `\uf006 ${e.rating}` : "";
      const yearLine = personal
        ? pad(truncate(year, Math.max(1, cellW - personal.length - 1)), cellW - personal.length) + personal
        : pad(year, cellW);
      caption.content =
        pad(truncate(e.title, cellW), cellW) +
        "\n" +
        yearLine +
        "\n" +
        pad("", cellW);

      if (e.image) {
        const poster = this.gridPosters.take(k);
        const cached = this.imageCache.get(e.image);
        if (!cached) void this.imageCache.ensure(e.image);
        if (cached && poster.source !== cached) poster.source = cached;
        if (!cached) poster.source = undefined;
        poster.visible = !!cached;
        poster.left = Math.max(0, cx);
        poster.top = Math.max(0, cy);
        poster.width = Math.max(1, Math.min(cellW, w - cx));
        poster.height = Math.max(1, Math.min(cellH - 3, h - cy));
      } else {
        const p = this.gridPosters.take(k);
        p.source = undefined;
        p.visible = false;
      }
    }
  }

  private drawCompact(app: App, x: number, y: number, w: number, h: number): void {
    this.listRows.reset();
    this.gridPosters.reset();
    this.gridCaptions.reset();

    const items = app.visible();
    if (items.length === 0) {
      this.put(
        this.listRows.take(0),
        { text: this.emptyMessage(app, false), fg: this.C.dim },
        x,
        y,
        w,
        1,
        this.C.bg,
      );
      return;
    }

    // Each entry takes 2 rows: title (year) + genres.
    const perScreen = Math.max(1, Math.floor(h / 2));
    const sel = app.selected;
    if (sel < this.scroll) this.scroll = sel;
    if (sel >= this.scroll + perScreen) this.scroll = sel - perScreen + 1;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, items.length - perScreen)));

    for (let r = 0; r < perScreen; r++) {
      const i = this.scroll + r;
      if (i >= items.length) break;
      const e = items[i];
      const active = i === sel;
      const bg = active ? this.C.selBg : this.C.bg;
      const baseFg = active ? this.C.selFg : this.C.fg;

      const year = e.year ? `(${e.year})` : "";
      // Personal rating inline after the title (only shown when rated).
      const personal = e.rating != null && e.rating > 0 ? ` \uf006 ${e.rating}` : "";
      const title = truncate(e.title, Math.max(4, w - year.length - personal.length - 4));
      const leftLine = `${title} ${year}${personal}`.trimRight();
      const ratingNum = e.avgRating ? e.avgRating.toFixed(1) : "--";
      const gap1 = Math.max(1, w - leftLine.length - ratingNum.length);
      const line1 = `${leftLine}${" ".repeat(gap1)}${ratingNum}`;
      this.put(this.listRows.take(r * 2), { text: line1, fg: baseFg }, x, y + r * 2, w, 1, bg);

      const genres = (e.genres ?? []).slice(0, 4).join(", ") || "—";
      this.put(this.listRows.take(r * 2 + 1), { text: `${truncate(genres, w)}`, fg: this.C.dim }, x, y + r * 2 + 1, w, 1, bg);
    }
  }

  // ------------------------------------------------------------------ detail

  private layoutDetail(app: App, w: number, h: number): void {
    const show = app.detailWidth(w) > 0;
    this.detailBox.visible = show;
    this.detailPoster.visible = show;
    this.detailLinePool.reset();
    if (!show) {
      this.detailImageUrl = null;
      return;
    }

    const dw = app.detailWidth(w);
    const dx = w - dw;
    const top = 1;
    const dh = h - 2;

    this.detailBox.left = dx;
    this.detailBox.top = top;
    this.detailBox.width = dw;
    this.detailBox.height = dh;

    const maxW = Math.max(4, dw - 4);
    const maxH = Math.max(4, Math.min(Math.floor(maxW * 1.4), Math.floor(dh * 0.55)));

    const subject = isSearchTab(app.current) ? app.selectedHit : app.selectedEntry();
    const imageUrl = subject?.image ?? null;
    const cached = imageUrl ? this.imageCache.get(imageUrl) : null;
    // Warm the cache in the background; show the poster only once normalized
    // bytes are available (raw PNGs can have chunks OpenTUI can't decode).
    if (imageUrl && !cached) void this.imageCache.ensure(imageUrl);
    const src = cached;

    let textTop = top + 1;
    let textH = dh - 2;
    // Labels share the cover's fitted width so they never spill past it.
    let textW = maxW;

    if (src && maxW >= 6 && maxH >= 4 && dh >= 8) {
      // Track by reference/identity, not byte length (which can collide).
      const srcChanged = this.detailImageUrl !== imageUrl;
      // Re-set source when it was cleared (hidden) or the image changed.
      if (this.detailPoster.source === undefined || this.detailImageUrl !== imageUrl) {
        this.detailPoster.source = src;
        this.detailImageUrl = imageUrl;
      }
      // Fit the poster to the image's real aspect ratio inside (maxW, maxH),
      // then reuse that width for the title/metadata.
      const img = srcChanged ? null : this.detailPoster.image;
      const fit = this.detailPoster.getFittedSize(
        maxW,
        maxH,
        this.detailPoster.cellAspectRatio,
        img?.width ?? 460,
        img?.height ?? 650,
      );
      const posterW = Math.max(1, Math.min(maxW, Math.round(fit.width)));
      const posterH = Math.max(1, Math.min(maxH, Math.round(fit.height)));
      textW = posterW;
      this.detailPoster.visible = true;
      this.detailPoster.left = dx + 2;
      this.detailPoster.top = top + 1;
      this.detailPoster.width = posterW;
      this.detailPoster.height = posterH;
      textTop = top + 1 + posterH + 1;
      textH = dh - posterH - 3;
    } else {
      this.detailPoster.source = undefined;
      this.detailPoster.visible = false;
      this.detailImageUrl = null;
    }

    const lines = this.buildDetailLines(app, subject, textW, textH);
    for (let i = 0; i < lines.length; i++) {
      this.put(this.detailLinePool.take(i), lines[i], dx + 2, textTop + i, textW, 1);
    }
  }

  private buildDetailLines(
    app: App,
    subject: Entry | Hit | undefined,
    w: number,
    h: number,
  ): Line[] {
    if (h <= 0) return [];
    if (!subject) return [{ text: "nothing selected", fg: this.C.dim }];

    const out: Line[] = [];
    const push = (text: string, fgColor?: string) => out.push({ text: truncate(text, w), fg: fgColor });

    const onSearch = isSearchTab(app.current);
    const title = onSearch ? (subject as Hit).title : (subject as Entry).title;
    push(title, this.C.selFg);

    const year = onSearch ? (subject as Hit).year : (subject as Entry).year;
    const format = onSearch ? (subject as Hit).format : (subject as Entry).format;
    const episodes = onSearch ? (subject as Hit).episodes : (subject as Entry).progress?.total;
    const meta = [year, format, episodes ? `${episodes} ep` : null].filter(Boolean);
    push(meta.join(" · "), this.C.dim);
    push("");

    if (onSearch) {
      const hit = subject as Hit;
      push(`community  ${hit.avgRating?.toFixed(1) ?? "--"}   popularity ${hit.weight ?? "--"}`, this.C.dim);
      push(`provider   ${hit.provider}`, this.C.dim);
      if (hit.genres.length) push(hit.genres.slice(0, 6).join(", "), this.C.dim);
      push("");
      for (const chunk of wrap(hit.summary ?? "no summary", w - 1)) push(chunk, this.C.dim);
      push("");
      push(`Enter adds to ${statusLabel(app.pendingStatus)}`, this.C.ok);
    } else {
      const e = subject as Entry;
      push(statusLabel(e.status), this.C.accent);

      const rating = e.rating;
      const star = "\uf006";
      // Space between stars avoids kerning artifacts that make the last star
      // render larger than the rest.
      const filledChunks = Array.from({ length: MAX_RATING }, (_, i) =>
        i < (rating ?? 0) ? fg(this.C.accent)(`${star} `) : fg(this.C.dim)(`${star} `),
      );
      out.push({ styled: new StyledText(filledChunks) });

      if (e.progress) {
        const p = e.progress;
        const pct = p.total ? Math.round((p.seen / p.total) * 100) : 0;
        const barW = Math.max(4, Math.min(w - 10, 24));
        const fill = Math.round((pct / 100) * barW);
        push(
          `${"█".repeat(fill)}${"░".repeat(Math.max(0, barW - fill))} ${p.seen}/${p.total}`,
          this.C.dim,
        );
      }

      push(`community  ${e.avgRating?.toFixed(1) ?? "--"}   pop ${e.weight ?? "--"}`, this.C.dim);
      if (e.genres?.length) push(e.genres.slice(0, 6).join(", "), this.C.dim);
      push("");
      for (const chunk of wrap(e.summary ?? "no summary", w - 1)) push(chunk, this.C.dim);
    }

    return out.slice(0, h);
  }

  // ------------------------------------------------------------------ footer

  /** The right-aligned status word on the footer row. */
  private footerRightText(app: App, h: number): string {
    if (app.compact) return ` compact `;
    if (app.grid) {
      const rows = app.gridRows(h - 1);
      const cols = app.gridColumns(app.bodyWidth());
      const perPage = cols * rows;
      const totalPages = Math.max(1, Math.ceil(app.visible().length / perPage));
      const page = Math.min(app.gridPage, totalPages - 1) + 1;
      return ` Page ${page} / ${totalPages} `;
    }
    return ` ${sortLabel(app.sort)}${app.sortDesc ? " v" : " ^"} list `;
  }

  private layoutFooter(app: App, w: number, h: number): void {
    const msg = app.message;
    if (msg) {
      // Hide tabs + background so they cannot linger at a stale row on resize.
      this.tabsBg.visible = false;
      for (const t of this.headerTabs) t.visible = false;
      const color = app.searchErrors.length
        ? this.C.err
        : app.searchLoading
          ? this.C.dim
          : app.searchStale
            ? this.C.warn
            : this.C.ok;
      this.put(this.footer, { text: ` ${msg}`, fg: color }, 0, h - 1, w, 1, this.C.bar);
      return;
    }

    // Hide any leftover message renderable when showing the tabs.
    this.footer.visible = false;
    this.tabsBg.visible = true;
    this.tabsBg.backgroundColor = this.C.bar;
    this.tabsBg.left = 0;
    this.tabsBg.top = h - 1;
    this.tabsBg.width = w;
    this.tabsBg.height = 1;
    let x = 0;
    Tabs.forEach((t, i) => {
      const active = i === app.tabIndex;
      const icon = isSearchTab(t) ? TAB_ICON_SEARCH : statusIcon(t as Status);
      const label = isSearchTab(t) ? "search" : statusLabel(t as Status);
      const n = isSearchTab(t) ? app.hits.length : app.tabCount(i);
      const txt = ` ${icon} ${label} ${n} `;
      const r = this.headerTabs[i];
      r.visible = true;
      r.left = x;
      r.top = h - 1;
      r.width = Math.max(1, txt.length);
      r.height = 1;
      r.fg = active ? this.C.selFg : this.C.dim;
      r.bg = active ? this.C.selBg : this.C.bar;
      r.content = txt;
      x += txt.length;
    });
    for (let i = Tabs.length; i < this.headerTabs.length; i++) this.headerTabs[i].visible = false;

    const rightText = this.footerRightText(app, h);
    this.headerRight.visible = true;
    this.headerRight.left = w - rightText.length;
    this.headerRight.top = h - 1;
    this.headerRight.width = rightText.length;
    this.headerRight.height = 1;
    this.headerRight.fg = this.C.dim;
    this.headerRight.bg = this.C.bar;
    this.headerRight.content = rightText;
  }

  // -------------------------------------------------------------------- help

  private layoutHelp(app: App, w: number, h: number): void {
    this.help.visible = app.showHelp;
    this.helpLines.reset();
    if (!app.showHelp) return;

    const lines = [
      "mst — help",
      "",
      "  NAVIGATION",
      "    h / l / ← / →   left / right (vim)",
      "    j / k / ↓ / ↑    down / up (vim)",
      "    Shift+← / →      grid: previous / next page",
      "    Tab / 1-5        switch view (1-5 = watchlist..dropped)",
      "    Shift+Tab        switch view (reverse)",
      "    Home / End       first / last item",
      "",
      "  SEARCH TAB",
      "    /                focus the box (keeps the query)",
      "    type             live search, debounced: anime",
      "    Enter (in box)   search, then focus the results list",
      "    Enter / c (list) add the highlighted result",
      "    Tab / Esc        leave the box, browse results",
      "    : / Ctrl-P / p   open command palette",
      "",
      "  STATUS / EDITING",
      "    w W C o d        set status (o = on hold)",
      "    = / -            raise / lower rating by 0.5 (max 5, - clears)",
      "    e / E            episode watched / unwatched",
      "    D                delete selected",
      "    /                filter the current tab",
      "    v                toggle grid view",
      "    V (shift+v)     toggle compact view",
      "",
      "  SYSTEM",
      "    s / S            sort cycle / reverse",
      "    n                toggle NSFW search",
      "    u                open streaming URL",
      "    : / p            palette: import / export JSON",
      "    ? ,              help / settings",
      "    q / Ctrl-C       quit",
      "",
      "  CONTROLLER (DualShock 4)",
      "    d-pad / left stick  move selection",
      "    right stick        grid: previous / next page",
      "    ✕ / ○ / △ / □      enter / escape / help / grid view",
      "    L1 / R1            previous / next view",
      "    L2 / R2            lower / raise rating",
      "    L3 / R3            episode unwatched / watched",
      "    Share / Options    command palette / sort cycle",
      "",
      "  HELP   ? close help",
    ];

    // Wide enough for the controller bindings.
    const bw = Math.min(w, 66);
    // Clamp to the screen so the bottom border is never cut off.
    const bh = Math.min(lines.length + 2, h);
    const by = Math.max(0, Math.floor((h - bh) / 2));
    const bx = Math.max(0, Math.floor((w - bw) / 2));

    this.help.left = bx;
    this.help.top = by;
    this.help.width = bw;
    this.help.height = bh;

    // Only draw lines that fit between the top and bottom borders.
    const interior = bh - 2;
    for (let i = 0; i < Math.min(lines.length, interior); i++) {
      this.put(
        this.helpLines.take(i),
        { text: lines[i], fg: i === 0 ? this.C.accent : this.C.fg },
        bx + 2,
        by + 1 + i,
        bw - 4,
        1,
        this.C.bg,
      );
    }
  }
}

// ---------------------------------------------------------------- line format

function entryLine(e: Entry, w: number): { styled: import("@opentui/core").StyledText } {
  const year = e.year ? String(e.year) : "????";
  const eps = e.progress?.total ? `${e.progress.total}` : "--";

  const avgRating = e.avgRating ?? 0;
  // Fixed-width columns so header and rows align like a table.
  const epsCol = eps.padStart(3);
  const ratingCol = avgRating.toFixed(1).padStart(6);
  const rightContent = `${epsCol} ${ratingCol}`;
  const rightLen = rightContent.length;

  // Personal rating inline after the title (only shown when rated).
  const personal = e.rating != null && e.rating > 0 ? ` \uf006 ${e.rating}` : "";
  const titleWidth = Math.max(4, w - rightLen - year.length - personal.length - 3);
  const title = truncate(e.title, titleWidth);

  const leftContent = `${year} ${title}${personal}`;
  const gap = Math.max(1, w - leftContent.length - rightLen);

  const chunks = [
    fg("#d8dee9")(leftContent),
    fg("#6b7280")(" ".repeat(gap)),
    fg("#d8dee9")(rightContent),
  ];
  const styled = new StyledText(chunks);
  return { styled };
}

function hitLine(h: Hit, app: App, w: number): { styled: import("@opentui/core").StyledText } {
  const year = h.year ? String(h.year) : "????";
  const eps = h.episodes ? `${h.episodes}` : "--";

  const avgRating = h.avgRating ?? 0;
  // Search: EP + RATING only (no personal stars column).
  const epsCol = eps.padStart(3);
  const ratingCol = avgRating.toFixed(1).padStart(6);
  const rightContent = `${epsCol} ${ratingCol}`;
  const rightLen = epsCol.length + 1 + ratingCol.length;

  const titleWidth = Math.max(4, w - rightLen - year.length - 2);
  const title = truncate(h.title, titleWidth);

  const leftContent = `${year} ${title}`;
  const gap = Math.max(1, w - leftContent.length - rightLen);

  const chunks = [
    fg("#d8dee9")(leftContent),
    fg("#6b7280")(" ".repeat(gap)),
    fg("#d8dee9")(rightContent),
  ];
  const styled = new StyledText(chunks);
  return { styled };
}

function truncate(s: string, n: number): string {
  if (n <= 0) return "";
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 3)) + "...";
}

function wrap(s: string, w: number): string[] {
  if (w <= 4) return [truncate(s, 40)];
  const out: string[] = [];
  let line = "";
  for (const word of s.split(/\s+/)) {
    if (line.length + word.length + 1 > w) {
      if (line) out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}
