/**
 * Rendering.
 *
 * OpenTUI's retained renderable tree, absolutely positioned. Row, poster, and
 * detail-line renderables are pooled so a large list only allocates what fits
 * on screen.
 *
 * Colour goes through `fg`/`bg` on the renderable — OpenTUI does not parse
 * ANSI escapes out of a content string.
 */

import {
  ASCIIFontRenderable,
  BoxRenderable,
  ImageRenderable,
  TextRenderable,
  fg,
  imageInfo,
  measureText,
  StyledText,
  type CliRenderer,
  type Renderable,
} from "@opentui/core";
import { App, Tabs, isSearchTab, isWishlistTab } from "./app.ts";
import { Carousel, SIDE_COUNT } from "./carousel.ts";
import {
  hoursPlayed,
  MAX_RATING,
  PLATFORM_LABEL,
  statusLabel,
  sortLabel,
  type Game,
  type Hit,
} from "./model.ts";
import { ImageCache } from "./image-cache.ts";

const colors = {
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

const C = colors;

/** The last values written to a text renderable, so unchanged ones are skipped. */
interface PutState {
  left: number;
  top: number;
  width: number;
  height: number;
  fg: string;
  bg: string;
  text: string;
}

const TAB_ICON_SEARCH = "\uf002";
const TAB_ICON_LIBRARY = "\uf02d";
const TAB_ICON_WISHLIST = "\uf004";

/**
 * Rows reserved around the carousel strip: one blank margin, the large
 * two-row ASCII title, the metadata line, then caption and hint below.
 */
const CAROUSEL_CHROME_ROWS = 6;
const CAROUSEL_AREA_TOP = 4;
const CAROUSEL_TITLE_ROWS = 2;
/** Brightness of cards by distance from the focused one. */
const DIM_LEVELS = [1, 0.82, 0.66, 0.5];

interface Line {
  text?: string;
  fg?: string;
  styled?: StyledText;
}

interface Pool<T> {
  take(i: number): T;
  reset(): void;
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
  };
}

const pad = (s: string, n: number): string =>
  s.length >= n ? s.slice(0, Math.max(0, n)) : s + " ".repeat(n - s.length);

export class Screen {
  private readonly renderer: CliRenderer;
  private readonly root: Renderable;
  private readonly C = C;

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

  private readonly carousel = new Carousel();
  private readonly carouselPosters: Pool<ImageRenderable>;
  private readonly carouselTitle: ASCIIFontRenderable;
  private readonly carouselMeta: TextRenderable;
  private readonly carouselCaption: TextRenderable;
  private readonly carouselHint: TextRenderable;
  private readonly coverPickerText: TextRenderable;

  /** The current app, kept for the animation frame callback. */
  private app: App | null = null;
  /** Identity of the list the carousel is showing; a change snaps the strip. */
  private carouselKey: string | null = null;
  /** Where the strip was last laid out; null when another view owns the body. */
  private carouselViewport: { x: number; y: number; w: number; h: number } | null = null;
  /** What the carousel chrome (title, meta, caption, hint) was built from. */
  private carouselChromeKey = "";

  private scroll = 0;
  private lastTab: string | null = null;
  /** Selection the footer counter was last painted for. */
  private footerSelected = -1;
  private detailImageUrl: string | null = null;
  private readonly imageDims = new Map<string, { width: number; height: number }>();

  private readonly imageCache: ImageCache;

  constructor(renderer: CliRenderer, imageCache: ImageCache, root?: Renderable) {
    this.renderer = renderer;
    // Hosted by ut: default to the renderer root, an injected tab container when hosted.
    this.root = root ?? renderer.root;
    this.imageCache = imageCache;

    const text = (fgColor?: string) => this.makeText(fgColor);

    this.headerRight = text(C.dim);
    this.root.add(this.headerRight);
    this.hint = text(C.dim);
    this.searchBox = text();
    this.footer = text(C.dim);
    this.detailLinePool = makePool(this.root, () => text());

    this.detailBox = new BoxRenderable(renderer, {
      position: "absolute",
      flexShrink: 0,
      backgroundColor: C.panel,
      border: ["left"],
      borderColor: C.border,
    });
    this.root.add(this.detailBox);

    this.detailPoster = new ImageRenderable(renderer, {
      position: "absolute",
      flexShrink: 0,
      protocol: "auto",
      fit: "fit",
      onError: () => {},
    });
    this.root.add(this.detailPoster);

    this.help = new BoxRenderable(renderer, {
      position: "absolute",
      flexShrink: 0,
      backgroundColor: C.panel,
      border: ["top", "bottom", "left", "right"],
      borderColor: C.accent,
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
      backgroundColor: C.bar,
    });
    this.root.add(this.tabsBg);

    this.headerTabs = [];
    for (let i = 0; i < Tabs.length; i++) {
      const t = text();
      this.root.add(t);
      this.headerTabs.push(t);
    }
    this.headerRight = text(C.dim);
    this.root.add(this.headerRight);

    for (const r of [this.hint, this.searchBox, this.footer]) this.root.add(r);

    this.listRows = makePool(this.root, () => this.makeText());

    this.carouselPosters = makePool(
      this.root,
      () =>
        new ImageRenderable(renderer, {
          position: "absolute",
          flexShrink: 0,
          protocol: "auto",
          // The card is scaled up, never cropped: "fit" keeps the whole cover
          // visible, and the box is sized to the image's own aspect below.
          fit: "fit",
          onError: () => {},
        }),
    );

    // The carousel's focus frame was removed: a bordered box over kitty image
    // cells makes the terminal repaint the area as black bands.

    this.carouselTitle = new ASCIIFontRenderable(renderer, {
      position: "absolute",
      flexShrink: 0,
      text: "",
      font: "tiny",
      color: C.accent,
      backgroundColor: "transparent",
      selectable: false,
      zIndex: 85,
    });
    this.root.add(this.carouselTitle);
    this.carouselMeta = this.makeText(C.dim);
    this.carouselMeta.zIndex = 85;
    this.root.add(this.carouselMeta);
    this.carouselCaption = this.makeText(C.dim);
    this.carouselCaption.zIndex = 85;
    this.root.add(this.carouselCaption);
    this.carouselHint = this.makeText(C.dim);
    this.carouselHint.zIndex = 85;
    this.root.add(this.carouselHint);

    this.coverPickerText = this.makeText(C.fg);
    this.coverPickerText.zIndex = 90;
    this.root.add(this.coverPickerText);

    this.renderer.setFrameCallback(this.tick);
  }

  /**
   * Advance the carousel spring on every painted frame. Rendering inside the
   * callback requests the next frame, so the strip keeps moving until the
   * spring settles; after that the callback is a no-op.
   *
   * Only the strip is repainted here. Re-running the whole screen layout at
   * frame rate meant rebuilding the header, footer and detail pane (and
   * filtering the library) thirty times a second, which is what made the
   * animation stutter on slower machines.
   */
  private readonly tick = async (deltaTime: number): Promise<void> => {
    const app = this.app;
    if (!app || !app.carouselActive()) return;
    if (this.carousel.settled && !this.carousel.axisActive) return;
    this.carousel.update(deltaTime);
    const view = this.carouselViewport;
    if (!view) {
      this.render(app);
      return;
    }
    this.drawCarousel(app, view.x, view.y, view.w, view.h);
    // The only thing outside the strip that moves while it slides.
    if (app.selected !== this.footerSelected) {
      this.layoutFooter(app, this.renderer.width, this.renderer.height);
    }
    this.renderer.requestRender();
  };

  /** Feed the carousel the left stick; called by the gamepad reader. */
  setCarouselAxis(value: number): void {
    const app = this.app;
    if (!app || !app.carouselActive()) {
      this.carousel.setAxis(0);
      return;
    }
    this.carousel.setAxis(value);
    if (!this.carousel.axisActive) {
      const before = app.selected;
      app.selectCarouselIndex(this.carousel.targetIndex);
      // Keep the footer's counter in step when the stick comes to rest.
      if (app.selected !== before) this.render(app);
    }
    this.renderer.requestRender();
  }

  private makeText(fgColor?: string): TextRenderable {
    return new TextRenderable(this.renderer, {
      position: "absolute",
      flexShrink: 0,
      content: "",
      fg: fgColor ?? C.fg,
    });
  }

  private rendering = false;

  render(app: App): void {
    if (this.rendering) return;
    this.app = app;
    this.rendering = true;
    try {
      const w = this.renderer.width;
      const h = this.renderer.height;

      const MIN_W = 30;
      const MIN_H = 12;

      if (w < MIN_W || h < MIN_H) {
        this.showSizeMessage(w, h, `Terminal too small (${w}x${h}). Minimum: ${MIN_W}x${MIN_H}`);
        this.renderer.requestRender();
        return;
      }

      app.viewWidth = w;
      app.viewHeight = h;
      app.cellAspectRatio = this.cellAspectRatio();

      const bodyTop = this.layoutSearch(app, w);
      this.layoutBody(app, w, h, bodyTop);
      this.layoutDetail(app, w, h);
      this.layoutFooter(app, w, h);
      this.layoutHelp(app, w, h);

      this.renderer.requestRender();
    } finally {
      this.rendering = false;
    }
  }

  private showSizeMessage(w: number, h: number, msg: string): void {
    this.listRows.reset();
    this.hideCarousel();
    this.carouselViewport = null;
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
    this.put(this.footer, { text: msg, fg: C.warn }, 0, Math.floor(h / 2), w, 1, C.bg);
  }

  private put(
    r: TextRenderable,
    line: Line,
    x: number,
    y: number,
    w: number,
    h: number,
    bg?: string,
  ): void {
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
    // The animation loop redraws the same rows every frame. Every setter here
    // talks to the native scene, so an unchanged value is skipped.
    const st = this.putState(r);
    if (st.left !== clampedX) {
      r.left = clampedX;
      st.left = clampedX;
    }
    if (st.top !== clampedY) {
      r.top = clampedY;
      st.top = clampedY;
    }
    if (st.width !== clampedW) {
      r.width = clampedW;
      st.width = clampedW;
    }
    if (st.height !== clampedH) {
      r.height = clampedH;
      st.height = clampedH;
    }
    const fg = line.fg ?? C.fg;
    if (st.fg !== fg) {
      r.fg = fg;
      st.fg = fg;
    }
    if (bg !== undefined && st.bg !== bg) {
      r.bg = bg;
      st.bg = bg;
    }
    if (line.styled) {
      // Styled text is rebuilt every time, so it is always sent.
      r.content = line.styled;
    } else {
      const text = pad(line.text ?? "", clampedW);
      if (st.text !== text) {
        r.content = text;
        st.text = text;
      }
    }
  }

  /**
   * Position and style a renderable only when a value actually changed.
   * Unlike text, `left`/`top` always go through the native scene when written,
   * so the carousel's mostly-static cards must not be re-positioned per frame.
   */
  private place(
    r: Renderable,
    left: number,
    top: number,
    width: number,
    height: number,
    opacity?: number,
    zIndex?: number,
  ): void {
    let st = this.boxStates.get(r);
    if (!st) {
      st = { left: NaN, top: NaN, width: NaN, height: NaN, opacity: NaN, zIndex: NaN };
      this.boxStates.set(r, st);
    }
    if (st.left !== left) {
      r.left = left;
      st.left = left;
    }
    if (st.top !== top) {
      r.top = top;
      st.top = top;
    }
    if (st.width !== width) {
      r.width = width;
      st.width = width;
    }
    if (st.height !== height) {
      r.height = height;
      st.height = height;
    }
    if (opacity !== undefined && st.opacity !== opacity) {
      r.opacity = opacity;
      st.opacity = opacity;
    }
    if (zIndex !== undefined && st.zIndex !== zIndex) {
      r.zIndex = zIndex;
      st.zIndex = zIndex;
    }
  }

  /**
   * The last values written to a text renderable. The carousel animation
   * repaints the same rows many times a second; without this every frame
   * re-sent the whole text to the native scene.
   */
  private readonly putStates = new WeakMap<TextRenderable, PutState>();

  /** The last box geometry written to a renderable, so unchanged frames skip it. */
  private readonly boxStates = new WeakMap<
    Renderable,
    {
      left: number;
      top: number;
      width: number;
      height: number;
      opacity: number;
      zIndex: number;
    }
  >();

  private putState(r: TextRenderable): PutState {
    let st = this.putStates.get(r);
    if (!st) {
      st = { left: NaN, top: NaN, width: NaN, height: NaN, fg: "", bg: "", text: "" };
      this.putStates.set(r, st);
    }
    return st;
  }

  // ------------------------------------------------------------------ search

  /** Query box and hint. Returns the first row the body may use. */
  private layoutSearch(app: App, w: number): number {
    if (app.focused) {
      this.searchBox.visible = true;
      this.hint.visible = true;
      this.put(this.searchBox, { text: ` > ${app.query}` }, 0, 1, w, 1, C.selBg);
      this.put(this.hint, { text: `   ${this.searchHint(app)}`, fg: C.dim }, 0, 2, w, 1, C.bg);
      return 3;
    }

    this.searchBox.visible = false;
    if (isSearchTab(app.current)) {
      this.hint.visible = true;
      const q = app.query.trim();
      const where = q ? ` · "${q}"` : "";
      this.put(
        this.hint,
        { text: ` / search${where} · Enter library · w wishlist`, fg: C.dim },
        0,
        0,
        w,
        1,
        C.bg,
      );
      return 1;
    }
    this.hint.visible = false;
    return 0;
  }

  /** Empty-state copy for the list views. */
  private emptyMessage(app: App, onSearch: boolean): string {
    if (onSearch) {
      return app.query.trim() ? "  no matches" : "  type to search games";
    }
    return `  nothing in ${isWishlistTab(app.current) ? "wishlist" : "library"} (${app.filterLabel})`;
  }

  private searchHint(app: App): string {
    if (!isSearchTab(app.current)) {
      const wishlist = isWishlistTab(app.current);
      const tab = wishlist ? "wishlist" : "library";
      const scope = wishlist ? `${app.visible().length} shown` : `${app.filterLabel}: ${app.visible().length} shown`;
      return `${tab} · ${scope}  ·  ${wishlist ? "" : "f filter  ·  "}Tab/Esc done`;
    }
    if (!app.query.trim()) return "type to search  ·  Enter browses the results";
    if (app.hits.length === 0) {
      return app.searchLoading ? "searching games..." : `no match for "${app.query.trim()}"`;
    }
    const n = app.hits.length;
    return `${n} result${n === 1 ? "" : "s"}  ·  Enter browses  ·  files to: ${statusLabel(app.pendingStatus)}`;
  }

  // -------------------------------------------------------------------- body

  private layoutBody(app: App, w: number, h: number, top: number): void {
    const onSearch = isSearchTab(app.current);
    const bodyH = Math.max(0, h - 1 - top);
    this.listRows.reset();
    this.hideCarousel();
    this.carouselViewport = null;
    this.coverPickerText.visible = false;
    if (!app.carouselActive()) {
      this.carousel.setAxis(0);
      this.carouselKey = null;
    }
    if (bodyH <= 0) return;

    // The carousel owns the full width: its focused card is already the detail.
    const detailW = app.carouselActive() ? 0 : app.detailWidth(w);
    const bodyW = w - detailW;

    if (onSearch) this.drawList(app, onSearch, 0, top, bodyW, bodyH);
    else if (app.carouselActive()) {
      this.carouselViewport = { x: 0, y: top, w: bodyW, h: bodyH };
      this.drawCarousel(app, 0, top, bodyW, bodyH);
    } else if (app.compact) this.drawList(app, onSearch, 0, top, bodyW, bodyH);
    else this.drawCompact(app, 0, top, bodyW, bodyH);

    // Picker stays invisible; 1-9 choose, Esc cancels.
  }

  private hideCarousel(): void {
    this.carouselPosters.reset();
    this.carouselTitle.visible = false;
    this.carouselMeta.visible = false;
    this.carouselCaption.visible = false;
    this.carouselHint.visible = false;
    this.carouselChromeKey = "";
  }

  private drawList(app: App, onSearch: boolean, x: number, y: number, w: number, h: number): void {
    this.listRows.reset();

    // Reset scroll offset when switching tabs so rows aren't hidden.
    if (this.lastTab !== app.current) {
      this.lastTab = app.current;
      this.scroll = 0;
    }

    const items: Array<Game | Hit> = onSearch ? app.hits : app.visible();
    const sel = onSearch ? app.hitSel : app.selected;

    if (items.length === 0) {
      this.put(this.listRows.take(0), { text: this.emptyMessage(app, onSearch), fg: C.dim }, x, y, w, 1, C.bg);
      return;
    }

    // Column header: mirrors the row layout.
    const headerText = (() => {
      const rightLabel = onSearch
        ? `${"SCORE".padStart(6)}`
        : `${"HRS".padStart(4)} ${"RATING".padStart(6)}`;
      const rightLen = rightLabel.length;
      const titleW = Math.max(4, w - 5 - rightLen - 1);
      const left = `${"YEAR".padEnd(5)}${"TITLE".padEnd(titleW)}`;
      const gap = Math.max(1, w - left.length - rightLen);
      return `${left}${" ".repeat(gap)}${rightLabel}`;
    })();

    let rowOffset = 0;
    if (headerText) {
      this.put(this.listRows.take(0), { text: headerText, fg: C.dim }, x, y, w, 1, C.bg);
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
      const bg = active ? C.selBg : C.bg;
      const baseFg = active ? C.selFg : C.fg;

      const line = onSearch ? hitLine(item as Hit, w) : gameLine(item as Game, w);
      this.put(t, { ...line, fg: baseFg }, x, y + rowOffset + r, w, 1, bg);
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

  /**
   * Intrinsic size of cached cover art, read from the image header. The real
   * size is needed before the renderable finishes decoding so the poster box
   * matches the source on the first frame — otherwise a portrait default is
   * used and the poster jumps when the terminal is resized.
   */
  private dimensions(url: string, data: Uint8Array): { width: number; height: number } {
    const known = this.imageDims.get(url);
    if (known) return known;
    let dims = { width: 600, height: 900 };
    try {
      const info = imageInfo(data);
      if (info.width > 0 && info.height > 0) dims = { width: info.width, height: info.height };
    } catch {
      /* keep the portrait default for anything the native decoder rejects */
    }
    this.imageDims.set(url, dims);
    return dims;
  }

  private drawCarousel(app: App, x: number, y: number, w: number, h: number): void {
    const items = app.visible();
    this.carousel.setCount(items.length);
    if (items.length === 0) {
      this.put(
        this.carouselHint,
        { text: centre(this.emptyMessage(app, false).trimStart(), w), fg: C.dim },
        x,
        y + Math.floor(h / 2),
        w,
        1,
        C.bg,
      );
      return;
    }

    const key = `${app.current}|${app.filter}|${app.sort}|${app.sortDesc}|${items.length}|${items[0]?.id ?? ""}`;
    if (this.carouselKey !== key) {
      this.carouselKey = key;
      this.carousel.snapTo(app.selected);
    } else if (this.carousel.axisActive) {
      // The stick owns the target while it is deflected. Mirror its nearest
      // card into the app so the title, footer and detail lookups follow.
      app.selectCarouselIndex(this.carousel.targetIndex);
    } else {
      this.carousel.setTarget(app.selected);
    }
    const layout = this.carousel.layout(w, h, CAROUSEL_CHROME_ROWS, CAROUSEL_AREA_TOP);
    const clampRect = (cx: number, cy: number, cw: number, ch: number) => {
      const left = Math.max(x, x + cx);
      const top = Math.max(y, y + cy);
      const right = Math.min(x + w, x + cx + cw);
      const bottom = Math.min(y + h, y + cy + ch);
      const width = Math.max(0, right - left);
      const height = Math.max(0, bottom - top);
      return width >= 1 && height >= 1 ? { left, top, width, height } : null;
    };

    const slots = SIDE_COUNT * 2 + 1;
    for (const card of layout.cards) {
      const slot = ((card.index % slots) + slots) % slots;
      const poster = this.carouselPosters.take(slot);
      const g = items[card.index];
      const rect = g ? clampRect(card.x, card.y, card.width, card.height) : null;
      if (!g || !rect) {
        poster.visible = false;
        continue;
      }

      const level = DIM_LEVELS[Math.min(card.variant, DIM_LEVELS.length - 1)];
      const z = 60 - Math.round(card.depth);
      if (g.image) {
        const cached = this.imageCache.get(g.image);
        if (!cached) void this.imageCache.ensure(g.image);
        if (cached && poster.source !== cached) poster.source = cached;
        if (!cached) poster.source = undefined;
        poster.visible = !!cached;
        if (cached) {
          // The poster box matches the picture's own aspect, so the picture
          // fills it exactly, with no empty band around the art.
          const dims = this.dimensions(g.image, cached);
          const aspect = (dims.width / dims.height) * poster.cellAspectRatio;
          const scale = Math.min(rect.width / aspect, rect.height);
          const pw = Math.max(1, Math.round(aspect * scale));
          const ph = Math.max(1, Math.round(scale));
          this.place(
            poster,
            rect.left + Math.floor((rect.width - pw) / 2),
            rect.top + Math.floor((rect.height - ph) / 2),
            pw,
            ph,
            level,
            z,
          );
        }
      } else {
        poster.source = undefined;
        poster.visible = false;
      }
    }

    const focusedGame = items[layout.focused.index] ?? items[app.selected];
    if (!focusedGame) return;

    // The chrome only depends on the card in the centre and the box size.
    // While the strip slides the same title is repainted at 30 fps otherwise.
    const chromeKey = `${focusedGame.id}\u0000${layout.focused.index}\u0000${items.length}\u0000${x}\u0000${y}\u0000${w}\u0000${layout.titleY}\u0000${layout.labelY}\u0000${layout.hintY}\u0000${app.current}\u0000${app.filter}`;
    if (this.carouselChromeKey === chromeKey) return;
    this.carouselChromeKey = chromeKey;

    // The terminal has one glyph size, so the title is drawn with the large
    // ASCII font and sits below a one-row breathing space from the top edge.
    const titleText = fitAsciiTitle(focusedGame.title, w);
    const titleW = measureText({ text: titleText, font: "tiny" }).width;
    this.carouselTitle.visible = true;
    this.carouselTitle.text = titleText;
    this.carouselTitle.left = x + Math.max(0, Math.floor((w - titleW) / 2));
    this.carouselTitle.top = y + layout.titleY;
    const meta = [
      focusedGame.year,
      focusedGame.metacritic != null ? `${focusedGame.metacritic} meta` : null,
      isWishlistTab(app.current) ? "wishlist" : statusLabel(focusedGame.status),
      focusedGame.hundredPercent ? "100%" : null,
    ]
      .filter(Boolean)
      .join(" · ");
    this.put(
      this.carouselMeta,
      { text: centre(truncate(meta, w), w), fg: C.dim },
      x,
      y + layout.titleY + CAROUSEL_TITLE_ROWS,
      w,
      1,
      C.bg,
    );

    const hrs = hoursPlayed(focusedGame);
    const position = `${layout.focused.index + 1} / ${items.length}`;
    const caption = [
      position,
      isWishlistTab(app.current) ? "wishlist" : statusLabel(focusedGame.status),
      hrs > 0 ? `${hrs} ${hrs === 1 ? "hour" : "hours"}` : null,
    ]
      .filter(Boolean)
      .join("  ·  ");
    this.put(
      this.carouselCaption,
      { text: centre(truncate(caption, w), w), fg: C.dim },
      x,
      y + layout.labelY,
      w,
      1,
      C.bg,
    );
    this.put(
      this.carouselHint,
      { text: centre(truncate("← → move  ·  f filter  ·  v views  ·  ? help", w), w), fg: C.dim },
      x,
      y + layout.hintY,
      w,
      1,
      C.bg,
    );
  }

  private drawCompact(app: App, x: number, y: number, w: number, h: number): void {
    this.listRows.reset();

    const items = app.visible();
    if (items.length === 0) {
      this.put(
        this.listRows.take(0),
        { text: this.emptyMessage(app, false), fg: C.dim },
        x,
        y,
        w,
        1,
        C.bg,
      );
      return;
    }

    const perScreen = Math.max(1, h);
    const sel = app.selected;
    if (sel < this.scroll) this.scroll = sel;
    if (sel >= this.scroll + perScreen) this.scroll = sel - perScreen + 1;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, items.length - perScreen)));

    for (let r = 0; r < perScreen; r++) {
      const i = this.scroll + r;
      if (i >= items.length) break;
      const g = items[i];
      const active = i === sel;
      const bg = active ? C.selBg : C.bg;
      const baseFg = active ? C.selFg : C.fg;

      const year = g.year ? `(${g.year})` : "";
      const platform = g.platform ? PLATFORM_LABEL[g.platform] : "";
      const personal = g.rating != null && g.rating > 0 ? ` \uf006 ${g.rating}` : "";
      const title = truncate(g.title, Math.max(4, w - year.length - platform.length - personal.length - 4));
      const leftLine = `${title} ${year} ${platform}`.trimRight() + personal;
      const ratingNum = g.metacritic != null ? String(g.metacritic) : "--";
      const gap1 = Math.max(1, w - leftLine.length - ratingNum.length);
      const line1 = `${leftLine}${" ".repeat(gap1)}${ratingNum}`;
      this.put(this.listRows.take(r), { text: line1, fg: baseFg }, x, y + r, w, 1, bg);
    }
  }

  // ------------------------------------------------------------------ detail

  private layoutDetail(app: App, w: number, h: number): void {
    const show = !app.carouselActive() && app.detailWidth(w) > 0;
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

    const subject = isSearchTab(app.current) ? app.selectedHit : app.selectedGame();
    const imageUrl = subject?.image ?? null;
    const cached = imageUrl ? this.imageCache.get(imageUrl) : null;
    if (imageUrl && !cached) void this.imageCache.ensure(imageUrl);
    const src = cached;

    let textTop = top + 1;
    let textH = dh - 2;
    let textW = maxW;

    if (src && imageUrl && maxW >= 6 && maxH >= 4 && dh >= 8) {
      if (this.detailPoster.source === undefined || this.detailImageUrl !== imageUrl) {
        this.detailPoster.source = src;
        this.detailImageUrl = imageUrl;
      }
      // Fit the poster to the image's real aspect ratio inside (maxW, maxH),
      // then reuse that width for the title/metadata. The intrinsic size is
      // read from the header synchronously, so the box is correct on the first
      // frame and only tracks the terminal (resize/zoom), never decode timing.
      const dims = this.dimensions(imageUrl, src);
      const fit = this.detailPoster.getFittedSize(
        maxW,
        maxH,
        app.cellAspectRatio,
        dims.width,
        dims.height,
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
    subject: Game | Hit | undefined,
    w: number,
    h: number,
  ): Line[] {
    if (h <= 0) return [];
    if (!subject) return [{ text: "nothing selected", fg: C.dim }];

    const out: Line[] = [];
    const push = (text: string, fgColor?: string) => out.push({ text: truncate(text, w), fg: fgColor });

    const onSearch = isSearchTab(app.current);
    const title = onSearch ? (subject as Hit).title : (subject as Game).title;
    push(title, C.selFg);

    const year = subject.year;
    const platform = subject.platform;
    const meta = [year, platform ? PLATFORM_LABEL[platform] : null, subject.price].filter(Boolean);
    push(meta.join(" · "), C.dim);
    push("");

    const mc = subject.metacritic;
    push(`metascore  ${mc != null ? mc : "--"}`, C.dim);
    const developers = (subject.developers ?? []).join(", ");
    const publishers = (subject.publishers ?? []).join(", ");
    if (developers) push(`developer  ${developers}`, C.dim);
    // Self-published titles repeat the developer as the publisher; show it once.
    if (publishers && !sameNames(subject.developers, subject.publishers)) {
      push(`publisher  ${publishers}`, C.dim);
    }
    if ((subject.platformsAvailable ?? []).length) {
      push(`platforms  ${(subject.platformsAvailable ?? []).join(", ")}`, C.dim);
    }

    if (onSearch) {
      const hit = subject as Hit;
      push("");
      for (const chunk of wrap(hit.summary ?? "no summary", w - 1)) push(chunk, C.dim);
      push("");
      push(`Enter adds to ${statusLabel(app.pendingStatus)}  ·  w wishlist`, C.ok);
    } else {
      const g = subject as Game;
      const badges = [
        isWishlistTab(app.current) ? "wishlist" : statusLabel(g.status),
        g.hundredPercent ? "100%" : null,
      ].filter(Boolean);
      push(badges.join(" · "), C.accent);

      const rating = g.rating;
      const star = "\uf006";
      // Space between stars avoids kerning artifacts.
      const filledChunks = Array.from({ length: MAX_RATING }, (_, i) =>
        i < (rating ?? 0) ? fg(C.accent)(`${star} `) : fg(C.dim)(`${star} `),
      );
      out.push({ styled: new StyledText(filledChunks) });

      if (g.playtime) {
        const hrs = g.playtime.hours;
        push(`playtime   ${hrs} ${hrs === 1 ? "hour" : "hours"}`, C.dim);
      }
      if (g.wishlist && !isWishlistTab(app.current)) push("wishlist    yes", C.warn);
      push("");
      for (const chunk of wrap(g.summary ?? "no summary", w - 1)) push(chunk, C.dim);
    }

    return out.slice(0, h);
  }

  // ------------------------------------------------------------------ footer

  private drawCoverPicker(app: App, x: number, y: number, w: number, h: number): void {
    const lines = [
      "pick a cover: press 1-9 (Esc to cancel)",
      `${app.coverOptions.length} vertical covers loaded`,
    ];
    this.coverPickerText.visible = true;
    this.coverPickerText.left = x + 1;
    this.coverPickerText.top = y + 2;
    this.coverPickerText.width = Math.min(w - 2, 40);
    this.coverPickerText.height = lines.length;
    this.coverPickerText.content = lines.join("\\n");
    this.coverPickerText.bg = C.bg;
  }

  /** The right-aligned status word on the footer row. */
  private footerRightText(app: App): string {
    const filter = isSearchTab(app.current) || isWishlistTab(app.current) ? "" : ` ${app.filterLabel}`;
    if (app.compact) return ` compact${filter} `;
    if (app.carouselActive()) {
      const n = app.visible().length;
      return ` carousel ${n > 0 ? app.selected + 1 : 0} / ${n}${filter} `;
    }
    return ` ${sortLabel(app.sort)}${app.sortDesc ? " v" : " ^"}${filter} list `;
  }

  private layoutFooter(app: App, w: number, h: number): void {
    this.footerSelected = app.selected;
    const msg = app.message;
    if (msg) {
      // Hide tabs + background so they cannot linger at a stale row on resize.
      this.tabsBg.visible = false;
      for (const t of this.headerTabs) t.visible = false;
      const color = app.searchErrors.length
        ? C.err
        : app.searchLoading
          ? C.dim
          : app.searchStale
            ? C.warn
            : C.ok;
      this.put(this.footer, { text: ` ${msg}`, fg: color }, 0, h - 1, w, 1, C.bar);
      return;
    }

    this.footer.visible = false;
    this.tabsBg.visible = true;
    this.tabsBg.backgroundColor = C.bar;
    this.tabsBg.left = 0;
    this.tabsBg.top = h - 1;
    this.tabsBg.width = w;
    this.tabsBg.height = 1;
    let x = 0;
    Tabs.forEach((t, i) => {
      const active = i === app.tabIndex;
      const search = isSearchTab(t);
      const icon = search
        ? TAB_ICON_SEARCH
        : isWishlistTab(t)
          ? TAB_ICON_WISHLIST
          : TAB_ICON_LIBRARY;
      const label = search ? "search" : isWishlistTab(t) ? "wishlist" : "library";
      const n = app.tabCount(i);
      const txt = ` ${icon} ${label} ${n} `;
      const r = this.headerTabs[i];
      r.visible = true;
      r.left = x;
      r.top = h - 1;
      r.width = Math.max(1, txt.length);
      r.height = 1;
      r.fg = active ? C.selFg : C.dim;
      r.bg = active ? C.selBg : C.bar;
      r.content = txt;
      x += txt.length;
    });
    for (let i = Tabs.length; i < this.headerTabs.length; i++) this.headerTabs[i].visible = false;

    const rightText = this.footerRightText(app);
    this.headerRight.visible = true;
    this.headerRight.left = w - rightText.length;
    this.headerRight.top = h - 1;
    this.headerRight.width = rightText.length;
    this.headerRight.height = 1;
    this.headerRight.fg = C.dim;
    this.headerRight.bg = C.bar;
    this.headerRight.content = rightText;
  }

  // -------------------------------------------------------------------- help

  private layoutHelp(app: App, w: number, h: number): void {
    this.help.visible = app.showHelp;
    this.helpLines.reset();
    if (!app.showHelp) return;

    const lines = [
      "tvl — help",
      "",
      "  NAVIGATION",
      "    h / l / ← / →   left / right (vim)",
      "    j / k / ↓ / ↑    down / up (vim)",
      "    Tab / 1-3        switch view (search, library, wishlist)",
      "    Shift+Tab        switch view (reverse)",
      "    Home / End       first / last item",
      "",
      "  SEARCH TAB",
      "    /                focus the search box (keeps the query)",
      "                     Steam · Epic · PlayStation · Nintendo",
      "    Enter (in box)   search, then focus the results list",
      "    Enter / c (list) add the highlighted result to the library",
      "    w                add/toggle the highlighted result in wishlist",
      "    Tab / Esc        leave the box, browse the results",
      "",
      "  LIBRARY / WISHLIST",
      "    f                library: cycle status filter (all/backlog/playing/played/abandoned)",
      "    b g y a          library: set status backlog, playing, played, abandoned",
      "    w                move between library and wishlist",
      "    x                toggle 100% completion",
      "    P                cycle platform played on",
      "    = / -            raise / lower rating by 0.5 (max 5, - clears)",
      "    e / E            log / unlog 0.5h of playtime",
      "    D                delete selected",
      "    /                filter the current tab by title",
      "    v                cycle view: list / carousel",
      "    V (shift+v)      toggle compact view",
      "",
      "  SYSTEM",
      "    s / S            sort cycle / reverse",
      "    u                open the store page",
      "    r                refresh cover art (Steam)",
      "    R (shift+r)      reload everything (cache, art)",
      "    : / p            command palette",
      "    : export         export library (JSON / CSV)",
      "    ? (browse)       help",
      "    q (browse) / Ctrl-C  quit",
      "",
      "  START-UP",
      "    --reload / -r    clear the cache and refetch everything",
      "    --demo           fill an empty library with sample games",
      "    --path <file>    use a different library file",
      "",
      "  HELP   ? close help",
    ];

    const bw = Math.min(w, 62);
    const bh = Math.min(lines.length + 2, h);
    const by = Math.max(0, Math.floor((h - bh) / 2));
    const bx = Math.max(0, Math.floor((w - bw) / 2));

    this.help.left = bx;
    this.help.top = by;
    this.help.width = bw;
    this.help.height = bh;

    const interior = bh - 2;
    for (let i = 0; i < Math.min(lines.length, interior); i++) {
      this.put(
        this.helpLines.take(i),
        { text: lines[i], fg: i === 0 ? C.accent : C.fg },
        bx + 2,
        by + 1 + i,
        bw - 4,
        1,
        C.bg,
      );
    }
  }
}

// ---------------------------------------------------------------- line format

/** Case-insensitive set comparison, used to hide a duplicated publisher row. */
function sameNames(a: string[] | undefined, b: string[] | undefined): boolean {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) return false;
  const left = aa.map((s) => s.trim().toLowerCase()).sort();
  const right = bb.map((s) => s.trim().toLowerCase()).sort();
  return left.every((name, i) => name === right[i]);
}

function gameLine(g: Game, w: number): Line {
  const year = g.year ? String(g.year) : "????";
  const hrs = g.playtime ? String(g.playtime.hours) : "--";

  const hrsCol = hrs.padStart(4);
  const ratingCol = (g.rating != null ? g.rating.toFixed(1) : "--").padStart(6);
  const rightContent = `${hrsCol} ${ratingCol}`;

  const personal = g.rating != null && g.rating > 0 ? ` \uf006 ${g.rating}` : "";
  const titleWidth = Math.max(4, w - rightContent.length - year.length - personal.length - 3);
  const title = truncate(g.title, titleWidth);

  const leftContent = `${year} ${title}${personal}`;
  const gap = Math.max(1, w - leftContent.length - rightContent.length);
  return { text: `${leftContent}${" ".repeat(gap)}${rightContent}` };
}

function hitLine(h: Hit, w: number): Line {
  const year = h.year ? String(h.year) : "????";
  const score = h.metacritic != null ? String(h.metacritic) : "--";

  const rightContent = score.padStart(6);
  const titleWidth = Math.max(4, w - rightContent.length - year.length - 2);
  const title = truncate(h.title, titleWidth);

  const leftContent = `${year} ${title}`;
  const gap = Math.max(1, w - leftContent.length - rightContent.length);
  return { text: `${leftContent}${" ".repeat(gap)}${rightContent}` };
}

function truncate(s: string, n: number): string {
  if (n <= 0) return "";
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 3)) + "...";
}

/** Centre a line in `w` cells without changing its visible width. */
function centre(s: string, w: number): string {
  const text = truncate(s, w);
  const left = Math.max(0, Math.floor((w - text.length) / 2));
  return " ".repeat(left) + text;
}

/** Fit an upper-case title into `width` cells of the large ASCII font. */
function fitAsciiTitle(text: string, width: number): string {
  if (width <= 0) return "";
  const clean = text.toUpperCase();
  const fits = (s: string) => measureText({ text: s, font: "tiny" }).width <= width;
  if (fits(clean)) return clean;

  const ellipsis = "...";
  let best = "";
  for (let i = 1; i <= clean.length; i++) {
    const prefix = clean.slice(0, i).trimEnd();
    const candidate = `${prefix}${ellipsis}`;
    if (!fits(candidate)) break;
    best = candidate;
  }
  if (best) return best;

  // Too narrow even for an ellipsis: keep as many glyphs as fit.
  for (let i = 1; i <= clean.length; i++) {
    const prefix = clean.slice(0, i).trimEnd();
    if (!fits(prefix)) break;
    best = prefix;
  }
  return best;
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
