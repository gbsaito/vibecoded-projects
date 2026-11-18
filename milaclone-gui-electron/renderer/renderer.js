"use strict";
// Renderer: infinite-canvas board with the milaclone card set (sketch and
// templates aside). Same interaction model as the web app: pan/zoom world
// transform, drag the selected set, snap to 10px, marquee select, inline
// contenteditable edits committed on close, context menu for the rest.

const api = (method, ...args) => window.mila.api(method, args);

const GRID = 10;
const ZOOM_MIN = 0.2, ZOOM_MAX = 3.0;

const stage = document.getElementById("stage");
const world = document.getElementById("world");
const marqueeEl = document.getElementById("marquee");
const hint = document.getElementById("hint");
const crumbEl = document.getElementById("crumb");
const ctxEl = document.getElementById("ctxmenu");

const state = {
  canvas: null, rootId: null,
  items: new Map(), nodes: new Map(),
  selection: new Set(), selectedId: null, selectedLine: null,
  tool: null, cam: { x: 140, y: 100, z: 1 },
  lineDrag: null, imageDrag: null,
  drag: null, marquee: null, panning: null,
  editing: null, lineDraft: null,
  space: false, cutIds: new Set(),
  dropIdx: null, dropColId: null,
};

const COLORS = ["slate", "gray", "teal", "green", "brown", "yellow",
  "orange", "red", "pink", "purple", "blue", "indigo"];
const PALETTE = [["slate", "#1f3a5f"], ["yellow", "#d9a441"], ["orange", "#c4572e"],
  ["brown", "#8a6248"], ["green", "#2e7d4f"], ["teal", "#1a7f7a"], ["blue", "#3b6ea5"],
  ["purple", "#6c4bb8"], ["pink", "#d4527e"], ["red", "#b23a3a"], ["gray", "#c4c7ce"]];

const snap = (v, free) => (free ? v : Math.round(v / GRID) * GRID);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const rid = () => crypto.getRandomValues(new Uint8Array(9))
  .reduce((s, b) => s + b.toString(36).padStart(2, "0"), "").slice(0, 12);
const $ = id => document.getElementById(id);
const stageRect = () => stage.getBoundingClientRect();
const toWorld = (px, py) => ({ x: (px - stageRect().left - state.cam.x) / state.cam.z,
                              y: (py - stageRect().top - state.cam.y) / state.cam.z });
function labelColor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length][1];
}
const encodePath = src => encodeURIComponent(String(src).replace(/^\/uploads\//, ""));
const truncateUrl = u => { const s = String(u); return s.length > 44 ? s.slice(0, 41) + "…" : s; };

// Link cards: fetch preview + page title once per URL. undefined = not tried
// yet, null = failed (no retry), {src,title} = resolved.
function applyLinkThumb(it) {
  if (!it.data.url || it.data.thumb !== undefined) return;
  window.mila.fetchMeta(it.data.url).then(meta => {
    // canvas may have changed while fetching; only act if the card still exists
    if (!state.items.has(it.id)) return;
    it.data.thumb = meta ? (meta.src || null) : null;
    // page title fills the card title unless the user typed one
    if (meta && meta.title && !it.data.titleTouched) {
      it.data.title = meta.title;
    }
    updateItem(it);
    refreshItem(it);
  });
}

// -- TipTap doc <-> plain text / html -----------------------------------------
// Minimal-but-real block+inline Markdown, parsed into TipTap-ish doc JSON.
// Notes are edited as plain text; this runs at commit time / on rebuild.
function docFromText(text) {
  const src = String(text ?? "").replace(/\r\n?/g, "\n");
  const HEAD = /^(#{1,4})\s+(\S[\s\S]*)$/;
  const FENCE = /^\s*```(\w*)\s*$/;
  const CLOSE_FENCE = /^\s*```\s*$/;
  const HR = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
  const QUOTE = /^\s*>\s?(.*)$/;
  const UL = /^(\s*)([-*+])\s+(\[[ xX]\]\s+)?(.*)$/;
  const OL = /^(\s*)(\d{1,4})[.)]\s+(.*)$/;

  const inlineNodes = text => {
    const out = [];
    String(text).split("\n").forEach((line, idx) => {
      if (idx) out.push({ type: "hardBreak" });
      if (line) out.push({ type: "text", text: line });
    });
    return out;
  };
  function parseMarkdown(input) {
    const src = String(input).replace(/\r\n?/g, "\n").split("\n");
    const d = { type: "doc", content: [] };
    let i = 0;
    while (i < src.length) {
      const l = src[i], t = l.trim();
      if (!t) { i++; continue; }
      const f = FENCE.exec(l);
      if (f) {
        const code = [];
        i++;
        while (i < src.length && !CLOSE_FENCE.exec(src[i])) { code.push(src[i]); i++; }
        if (i < src.length) i++; // closing fence
        d.content.push({ type: "codeBlock", attrs: { info: f[1] || "" }, content: code.length ? [{ type: "text", text: code.join("\n") }] : [] });
        continue;
      }
      if (HR.exec(l)) { d.content.push({ type: "horizontalRule" }); i++; continue; }
      const h = HEAD.exec(l.replace(/\s+$/, ""));
      if (h) { d.content.push({ type: "heading", attrs: { level: h[1].length }, content: inlineNodes(h[2].trim()) }); i++; continue; }
      const q = QUOTE.exec(l);
      if (q) {
        // accumulate consecutive quote lines, strip the "> " prefix, then re-parse
        const inner = [];
        while (i < src.length) { const m = QUOTE.exec(src[i]); if (!m) break; inner.push(m[1]); i++; }
        const qDoc = parseMarkdown(inner.join("\n"));
        d.content.push({ type: "blockquote", content: qDoc.content });
        continue;
      }
      const lm = matchListLine(l);
      if (lm) {
        const rows = collectListRows(src, i);
        i += rows.length;
        d.content.push(buildList(rows));
        continue;
      }
      const para = [];
      while (i < src.length) {
        const l2 = src[i], t2 = l2.trim();
        if (!t2 || FENCE.exec(l2) || HR.exec(l2) || HEAD.exec(l2.replace(/\s+$/, "")) || QUOTE.exec(l2) || matchListLine(l2)) break;
        para.push(l2); i++;
      }
      if (para.length) d.content.push({ type: "paragraph", content: inlineNodes(para.join("\n")) });
      else i++;
    }
    return d;
  }
  function matchListLine(line) {
    let m = UL.exec(line);
    if (m) return { ordered: false, indent: Math.floor(m[1].length / 2), task: m[3] ? (/x/i.test(m[3]) ? "x" : " ") : null, text: m[4] };
    m = OL.exec(line);
    if (m) return { ordered: true, indent: Math.floor(m[1].length / 2), text: m[3], start: parseInt(m[2], 10) };
    return null;
  }
  function collectListRows(arr, start) {
    const out = [];
    for (let j = start; j < arr.length; j++) {
      const m = matchListLine(arr[j]);
      if (!m) break;
      out.push(m);
    }
    return out;
  }
  function buildList(rows) {
    if (!rows.length) return { type: "paragraph", content: [] };
    const base = rows[0].indent;
    const list = { type: rows[0].ordered ? "orderedList" : "bulletList", attrs: rows[0].ordered ? { start: rows[0].start || 1 } : {}, content: [] };
    let i = 0;
    while (i < rows.length) {
      const r = rows[i];
      const item = { type: "listItem", content: [] };
      const box = r.task === null ? null : (r.task === "x" ? "☑ " : "☐ ");
      item.content.push({ type: "paragraph", content: inlineNodes((box || "") + (r.text || "")) });
      i++;
      const children = [];
      while (i < rows.length && rows[i].indent > base) { children.push(rows[i]); i++; }
      if (children.length) item.content.push(buildList(children));
      list.content.push(item);
    }
    return list;
  }
  return parseMarkdown(src);
}
function docToHtml(doc) {
  if (!doc) return "";
  const marks = { bold: "b", italic: "i", underline: "u" };
  // Minimal inline Markdown subset applied to plain-text nodes.
  const mdInline = s => {
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>");
    s = s.replace(/(^|\s|\(|\[|")_([^_\n]+)_/g, "$1<i>$2</i>");
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
      if (!/^https?:\/\//i.test(url)) return m; // only web links
      const safe = url.replace(/"/g, "&quot;"); // quotes already escaped by esc()
      return `<a href="${safe}" target="_blank" rel="noreferrer">${label}</a>`;
    });
    return s;
  };
  const inline = ns => (ns || []).map(n => {
    if (n.type === "hardBreak") return "<br>";
    if (n.type === "text") {
      let t = mdInline(esc(n.text));
      for (const m of n.marks || []) if (marks[m.type]) t = `<${marks[m.type]}>${t}</${marks[m.type]}>`;
      return t;
    }
    return block(n);
  }).join("");
  const block = n => {
    if (n.type === "paragraph") return `<p>${inline(n.content)}</p>`;
    if (n.type === "heading") { const lv = Math.min(4, Math.max(1, (n.attrs || {}).level || 2)); return `<h${lv}>${inline(n.content)}</h${lv}>`; }
    if (n.type === "bulletList") return `<ul>${(n.content || []).map(block).join("")}</ul>`;
    if (n.type === "orderedList") return `<ol${(n.attrs && n.attrs.start && n.attrs.start !== 1) ? ` start="${n.attrs.start}"` : ""}>${(n.content || []).map(block).join("")}</ol>`;
    if (n.type === "listItem") return `<li>${(n.content || []).map(block).join("")}</li>`;
    if (n.type === "blockquote") return `<blockquote>${(n.content || []).map(block).join("")}</blockquote>`;
    if (n.type === "horizontalRule") return "<hr>";
    if (n.type === "codeBlock") { const code = (n.content || []).map(t => t.text || "").join(""); return `<pre><code>${esc(code)}</code></pre>`; }
    return inline(n.content);
  };
  return (doc.content || []).map(block).join("");
}
function docPlainText(doc) {
  if (!doc) return "";
  const walk = n => n.type === "text" ? (n.text || "")
    : (n.content || []).map(walk).join(n.type === "doc" ? "\n" : "");
  return walk(doc);
}

// -- camera -------------------------------------------------------------------
function applyCam() {
  const { x, y, z } = state.cam;
  world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
  stage.style.backgroundImage = "radial-gradient(var(--grid-dot) 1px, transparent 1px)";
  stage.style.backgroundSize = `${GRID * z}px ${GRID * z}px`;
  stage.style.backgroundPosition = `${x}px ${y}px`;
  drawLines();
}
function zoomAt(px, py, factor) {
  const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, state.cam.z * factor));
  state.cam.x = px - (px - state.cam.x) * (z / state.cam.z);
  state.cam.y = py - (py - state.cam.y) * (z / state.cam.z);
  state.cam.z = z;
  applyCam();
}

// -- rendering ------------------------------------------------------------------
function render() {
  const svg = world.querySelector("#linesvg");
  world.textContent = "";
  world.appendChild(svg || newSvg());
  state.nodes.clear();
  const ordered = [...state.items.values()].sort((a, b) => (a.z || 0) - (b.z || 0));
  for (const it of ordered) if (it.type !== "line" && !it.parentItemId) appendCard(it);
  world.appendChild(world.querySelector("#linedots") || newDots());
  hint.classList.toggle("hidden", state.items.size > 0);
  applyCam();
  drawLines();
}
function newSvg() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = "linesvg";
  return svg;
}
function newDots() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = "linedots";
  return svg;
}

function appendCard(it) {
  if (it.type === "line") { drawLines(); return; }
  if (state.nodes.has(it.id)) return; // already rendered inside its column
  const node = buildCard(it);
  const parent = it.parentItemId ? state.nodes.get(it.parentItemId) : null;
  if (parent) {
    const body = parent.querySelector?.(".col-body");
    // A collapsed parent has no .col-body; leave the card untracked — it
    // renders when the column expands. (Falling back to the world root would
    // park it at body-relative coords.)
    if (body) body.appendChild(node);
    else return;
  } else {
    world.appendChild(node);
  }
  state.nodes.set(it.id, node);
}

function refreshItem(it) {
  if (it.type === "line") { drawLines(); return; }
  const old = state.nodes.get(it.id);
  if (!old) return appendCard(it);
  // A rebuilt column discards its old DOM — child cards included — so forget
  // their tracked nodes too; otherwise renderChildren would skip rebuilding
  // them and the column body would come back empty.
  if (it.type === "column") forgetColumnNodes(it.id);
  const node = buildCard(it);
  old.replaceWith(node);
  state.nodes.set(it.id, node);
  drawLines();
  // A child's size may have changed (body edit, todo row toggled): refit its
  // column so the body grows/shrinks and siblings re-stack below it.
  if (it.parentItemId) {
    const parent = state.items.get(it.parentItemId);
    if (parent) {
      // A fresh node starts at it.w (e.g. 240px) until refitColumn runs —
      // size it to the body now so the side gaps don't vanish, then restack
      // immediately and again after layout settles so the 10px vertical gap
      // is never lost after a recolour / undo.
      const body = state.nodes.get(parent.id)?.querySelector(".col-body");
      if (body) node.style.width = Math.max(120, body.clientWidth) + "px";
      restackColumn(parent);
      requestAnimationFrame(() => restackColumn(parent));
    }
  }
}

// Width-fit children to the column body, grow the body to the lowest child
// and sync the count badge. Safe to call while the column is detached (falls
// back to an estimate from the column width, corrected on the next pass).
function refitColumn(colItem) {
  const colNode = state.nodes.get(colItem.id);
  const body = colNode && colNode.querySelector(".col-body");
  if (!body) return;
  const kids = childrenOf(colItem.id);
  const avail = body.clientWidth || Math.max(120, (colItem.w || 240) - 22);
  let maxBottom = 0;
  for (const child of kids) {
    const cn = state.nodes.get(child.id);
    if (!cn) continue;
    const left = parseFloat(cn.style.left) || 0;
    cn.style.width = Math.max(120, avail - left) + "px";
    maxBottom = Math.max(maxBottom, (child.y || 0) + cn.offsetHeight);
  }
  body.style.height = (kids.length ? maxBottom + 4 : 72) + "px";
  const nEl = colNode.querySelector(".colcap .n");
  if (nEl) { const txt = columnCounter(kids); if (nEl.textContent !== txt) nEl.textContent = txt; }
}

// Vertical stack pass: re-lay the children as a tight, vertically ordered,
// horizontally centered stack from y=2. Runs on every refit so removals and
// content growth resize the column instead of leaving stale gaps (the stack
// always has 10px gaps; positions are persisted when they change).
function restackColumn(colItem) {
  const colNode = state.nodes.get(colItem.id);
  const body = colNode && colNode.querySelector(".col-body");
  if (!body) return;
  const kids = childrenOf(colItem.id);
  const ordered = [...kids].sort((a, b) => (a.y - b.y) || ((a.z || 0) - (b.z || 0)));
  if (ordered.length) {
    const avail = body.clientWidth || Math.max(120, (colItem.w || 240) - 22);
    const heights = ordered.map(k => state.nodes.get(k.id)?.offsetHeight || 0);
    if (heights.every(h => h > 0)) {
      let bottom = 2;
      const changed = [];
      for (let i = 0; i < ordered.length; i++) {
        const k = ordered[i];
        const cn = state.nodes.get(k.id);
        const cw = avail; // fill the column body
        const nx = 0;
        const ny = bottom;
        bottom += heights[i] + 10;
        if (k.x !== nx || k.y !== ny) {
          k.x = nx; k.y = ny;
          if (cn) { cn.style.left = nx + "px"; cn.style.top = ny + "px"; }
          changed.push(k);
        }
      }
      if (changed.length) updateItems(changed); // persist restacked positions
    }
  }
  refitColumn(colItem);
}

// Drop tracked nodes for a column's (transitive) children: call before
// discarding a column's DOM so renderChildren rebuilds them from state.items.
function forgetColumnNodes(parentId) {
  for (const child of childrenOf(parentId)) {
    state.nodes.delete(child.id);
    forgetColumnNodes(child.id);
  }
}

function childrenOf(parentId) {
  return [...state.items.values()].filter(it => it.parentItemId === parentId)
    .sort((a, b) => a.y - b.y);
}

// Quadratic control point for a line: the stored (middle dot) position, else
// the chord midpoint ≡ a straight line.
function curveCtrl(ax, ay, bx, by, it) {
  const c = it && it.data && it.data.curve;
  return c && typeof c.cx === "number" ? { x: c.cx, y: c.cy } : { x: (ax + bx) / 2, y: (ay + by) / 2 };
}
// Point on a quadratic Bézier at parameter t (0.5 = the middle dot's home).
function quadPoint(ax, ay, cx, cy, bx, by, t) {
  const u = 1 - t;
  return { x: u * u * ax + 2 * u * t * cx + t * t * bx,
           y: u * u * ay + 2 * u * t * cy + t * t * by };
}
// Drag an image's corner resize handle
function onImageHandlePointerDown(e) {
  e.stopPropagation();
  e.preventDefault();
  const handle = e.currentTarget;
  const node = handle.closest(".card");
  const it = node && state.items.get(node.dataset.id);
  if (!it) return;
  const p = toWorld(e.clientX, e.clientY);
  state.imageDrag = { id: it.id, corner: handle.dataset.corner,
    startX: p.x, startW: it.w || 240, startXPos: it.x };
  state.selection = new Set([it.id]);
  state.selectedId = it.id;
  paintSelection();
  stage.setPointerCapture(e.pointerId);
}

function imageResizeMove(e) {
  const r = state.imageDrag;
  const it = r && state.items.get(r.id);
  if (!it) { state.imageDrag = null; return; }
  const p = toWorld(e.clientX, e.clientY);
  const dx = p.x - r.startX;
  const left = r.corner.includes("w");
  const minW = 80;
  const newW = Math.max(minW, Math.round((left ? r.startW - dx : r.startW + dx) / GRID) * GRID);
  it.w = newW;
  if (left) it.x = Math.round(r.startXPos + r.startW - newW);
  const node = state.nodes.get(it.id);
  if (node) {
    node.style.width = newW + "px";
    if (left) node.style.left = it.x + "px";
  }
  drawLines();
}

function imageResizeEnd() {
  const r = state.imageDrag;
  state.imageDrag = null;
  if (!r) return;
  const it = state.items.get(r.id);
  if (it) {
    if ((it.type === "image" || it.type === "file") && !it.parentItemId && !it.data.pin) it.data.pin = true;
    updateItem(it);
  }
}

// Topmost card under a client point (world nodes are absolutely positioned).
function cardAtPoint(clientX, clientY) {
  for (const [id, node] of state.nodes) {
    if (!node.classList || !node.classList.contains("card")) continue;
    const r = node.getBoundingClientRect();
    if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom)
      return state.items.get(id) || null;
  }
  return null;
}
const cloneJson = v => (v == null ? v : JSON.parse(JSON.stringify(v)));

function dragLineMove(e) {
  const ld = state.lineDrag;
  const it = ld && state.items.get(ld.id);
  if (!it) { state.lineDrag = null; return; }
  const p = toWorld(e.clientX, e.clientY);
  const dx = p.x - ld.start.x, dy = p.y - ld.start.y;
  if (!ld.moved && Math.abs(dx) + Math.abs(dy) < 3 / state.cam.z) return;
  ld.moved = true;
  const ends = lineAxisEnds(it);
  if (!ends) return;
  const { ax, ay, bx, by } = ends;
  if (ld.role === "from")
    it.data.from = { x: Math.round(p.x), y: Math.round(p.y) };   // free
  else if (ld.role === "to")
    it.data.to = { x: Math.round(p.x), y: Math.round(p.y) };     // free
  else if (ld.role === "mid") {
    // middle dot snaps to the 10px grid: B = grid(p), C = 2B - ½(P0 + P2)
    const sx = Math.round(p.x / GRID) * GRID, sy = Math.round(p.y / GRID) * GRID;
    it.data.curve = { cx: 2 * sx - (ax + bx) / 2, cy: 2 * sy - (ay + by) / 2 };
  } else if (ld.role === "move") {
    if (ld.from && !ld.from.id)
      it.data.from = { x: Math.round(ld.from.x + dx), y: Math.round(ld.from.y + dy) };
    if (ld.to && !ld.to.id)
      it.data.to = { x: Math.round(ld.to.x + dx), y: Math.round(ld.to.y + dy) };
    if (ld.curve) it.data.curve = { cx: ld.curve.cx + dx, cy: ld.curve.cy + dy };
  }
  drawLines();
}

function endLineDrag(e) {
  const ld = state.lineDrag;
  state.lineDrag = null;
  if (!ld) return;
  const it = state.items.get(ld.id);
  if (!it) return;
  if (!ld.moved) {
    // plain click on a stroke: select the line, deselect cards
    state.selectedLine = ld.id;
    state.selection.clear();
    state.selectedId = null;
    paintSelection();
    drawLines();
    return;
  }
  if (ld.role === "from" || ld.role === "to") {
    const p = toWorld(e.clientX, e.clientY);
    const hit = cardAtPoint(e.clientX, e.clientY);
    if (hit && hit.type !== "line") {
      it.data[ld.role] = { id: hit.id }; // dropped on a card: attach
    } else {
      it.data[ld.role] = { x: Math.round(p.x), y: Math.round(p.y) }; // free
    }
  }
  updateItem(it);
  drawLines();
}
const cardHeight = it => {
  const n = state.nodes.get(it.id);
  return n ? n.offsetHeight : 60;
};

const tagHtml = l => `<span class="tag" style="background:${labelColor(l)}">${esc(l)}</span>`;

function labelsRow(node, d) {
  const labels = (d.labels || []).map(l => l.name || l);
  if (!labels.length) return;
  const row = document.createElement("div");
  row.className = "labels";
  row.innerHTML = labels.map(tagHtml).join("");
  node.appendChild(row);
}

function fileIcon(d) {
  const ext = String(d.name || "").split(".").pop().toLowerCase();
  const mime = d.mime || "";
  if (mime.startsWith("image/")) return "🖼";
  if (mime.startsWith("audio/")) return "🎧";
  if (mime.startsWith("video/")) return "🎬";
  return { pdf: "📄", doc: "📄", docx: "📄", txt: "📄", md: "📄",
           zip: "🗜", gz: "🗜", csv: "📊", xlsx: "📊" }[ext] || "📄";
}

function todoRow(t) {
  const row = document.createElement("div");
  row.className = "trow";
  row.style.marginLeft = (t.indent || 0) * 14 + "px";
  const box = document.createElement("div");
  box.className = "box" + (t.done ? " done" : "");
  const wrap = document.createElement("div");
  wrap.style.flex = "1";
  const txt = document.createElement("div");
  txt.className = "txt" + (t.done ? " done" : "") + (t.text ? "" : " empty");
  txt.textContent = t.text || "";
  wrap.appendChild(txt);
  if (t.due) {
    const when = new Date(t.due);
    if (!isNaN(when)) {
      const sub = document.createElement("div");
      sub.className = "sub";
      sub.textContent = when.toLocaleDateString(undefined,
        { weekday: "short", month: "short", day: "numeric" });
      wrap.appendChild(sub);
    }
  }
  if ((t.tags || []).length) {
    const tags = document.createElement("div");
    tags.style.cssText = "display:flex;flex-wrap:wrap";
    for (const tag of t.tags) {
      const chip = document.createElement("span");
      chip.className = "tag";
      chip.style.background = labelColor(tag);
      chip.textContent = tag;
      tags.appendChild(chip);
    }
    wrap.appendChild(tags);
  }
  row.append(box, wrap);
  return row;
}

function buildCard(it) {
  const d = it.data || {};
  const node = document.createElement("div");
  node.className = `card ${it.type}`;
  node.dataset.id = it.id;
  if (it.parentItemId && (it.type === "board" || it.type === "shortcut")) node.classList.add("in-column");
  node.style.left = it.x + "px";
  node.style.top = it.y + "px";
  node.style.width = (it.w || 240) + "px";
  node.style.zIndex = String(1000 + (it.z || 0));
  const colored = it.color && it.color !== "gray";
  if (!["column", "image", "swatch", "file", "link", "heading", "board", "shortcut"].includes(it.type)) {
    if (colored) { node.classList.add("colored"); node.style.borderLeft = `4px solid var(--c-${it.color})`; }
  }
  if (state.selection.has(it.id)) node.classList.add("selected");
  if (state.cutIds.has(it.id)) node.classList.add("cut");

  if (it.type === "heading") {
    const level = Math.min(4, Math.max(1, (d.level || 1)));
    node.classList.add("heading", `h${level}`);
    const body = document.createElement("div");
    body.className = "body";
    body.innerHTML = docToHtml(d.doc || docFromText(d.text || "")) || "<p></p>";
    if (!(d.text || "").trim()) body.classList.add("empty");
    node.appendChild(body);
  } else if (it.type === "note" || it.type === "comment") {
    // note / comment — rich text with background
    const body = document.createElement("div");
    body.className = "body";
    body.innerHTML = docToHtml(d.doc || docFromText(d.text || "")) || "<p></p>";
    node.appendChild(body);
    labelsRow(node, d);
  } else if (it.type === "todo") {
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = d.title || "To-do";
    node.appendChild(title);
    for (const t of d.tasks || []) node.appendChild(todoRow(t));
    labelsRow(node, d);
  } else if (it.type === "link") {
    const editingLink = state.editing && state.editing.id === it.id && state.editing.kind === "linkurl";
    if (!d.url || editingLink) {
      // Empty/editing state: inline URL input, focused, gray placeholder —
      // same pattern as MilaNote's link block instead of a popup.
      const row = document.createElement("div");
      row.className = "linputrow";
      const ico = document.createElement("div");
      ico.className = "linputicon";
      ico.innerHTML = '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M7.5 10.5l3-3M6 12.2l-1.5 1.5a2.4 2.4 0 0 0 3.4 3.4l5-5a2.4 2.4 0 0 0-3.4-3.4M12 6l1.5-1.5a2.4 2.4 0 0 0-3.4-3.4l-5 5a2.4 2.4 0 0 0 3.4 3.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
      const input = document.createElement("input");
      input.className = "linput";
      input.type = "text";
      input.placeholder = "Enter a link URL";
      input.value = d.url || "";
      input.spellcheck = false;
      input.autocomplete = "off";
      input.autocapitalize = "off";
      input.setAttribute("aria-label", "Link URL");
      input.addEventListener("pointerdown", e => e.stopPropagation());
      input.addEventListener("dblclick", e => e.stopPropagation());
      input.addEventListener("keydown", e => {
        // onEditKey (capture) already owns Escape — revert handled there.
        if (!state.editing || state.editing.el !== input) return;
        if (e.key === "Enter") {
          e.preventDefault(); e.stopPropagation();
          commitEdit(); // blur() wouldn't fire if the window never focused
        }
      });
      row.append(ico, input);
      node.appendChild(row);
    } else {
    if (d.thumb) {
      const img = document.createElement("img");
      img.className = "thumb";
      img.src = "milafile://m/" + encodePath(d.thumb);
      img.draggable = false;
      img.alt = "";
      node.appendChild(img);
    }
    const wrap = document.createElement("div");
    wrap.className = "lwrap";
    const host = document.createElement("div");
    host.className = "host";
    host.textContent = truncateUrl(d.url);
    host.title = d.url;
    const open = document.createElement("div");
    open.className = "openline";
    const a = document.createElement("a");
    a.textContent = (d.title || d.url || "Set URL").slice(0, 120);
    a.href = "#";
    const real = d.url;
    a.addEventListener("click", e => { e.preventDefault(); window.mila.openExternal(real); });
    open.appendChild(a);
    wrap.append(host, open);
    node.appendChild(wrap);
    labelsRow(node, d);
    applyLinkThumb(it);
    }
  } else if (it.type === "swatch") {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.style.background = /^#[0-9a-fA-F]{3,8}$/.test(d.hex || "") ? d.hex : "#dddddd";
    const hex = document.createElement("div");
    hex.className = "hex";
    hex.textContent = d.hex || "";
    node.append(chip, hex);
  } else if (it.type === "table") {
    node.classList.add("table");
    const tbl = document.createElement("table");
    for (const r of d.rows || []) {
      const tr = document.createElement("tr");
      for (const c of r) {
        const cell = document.createElement("td");
        cell.textContent = c;
        cell.contentEditable = "plaintext-only";
        if (cell.contentEditable !== "plaintext-only") cell.contentEditable = "true";
        tr.appendChild(cell);
      }
      tbl.appendChild(tr);
    }
    node.appendChild(tbl);
    tableHandlers(tbl, it);
  } else if (it.type === "column") {
    node.classList.add("column");
    const collapsed = !!d.collapsed;
    const cap = document.createElement("div");
    cap.className = "colcap";
    cap.style.cursor = "grab";
    const ico = document.createElement("div");
    ico.className = "colicon";
    // Small solid colour square in the header (no glyph), like milanote.
    ico.style.background = `var(--c-${it.color || "slate"})`;
    const t = document.createElement("div");
    t.className = "coltitle";
    t.textContent = d.title || "Column";
    const n = document.createElement("div");
    n.className = "n";
    n.textContent = columnCounter(childrenOf(it.id));
    const chev = document.createElement("button");
    chev.className = "colchev" + (collapsed ? " collapsed" : "");
    chev.type = "button";
    chev.title = collapsed ? "Expand" : "Collapse";
    chev.innerHTML = '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M4.5 6.8L9 11.3l4.5-4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    cap.append(ico, t, n, chev);
    node.appendChild(cap);
    const renderChildren = () => {
      const body = node.querySelector(".col-body");
      if (!body) return;
      // Node isn't attached to the document yet on first build, so
      // refitColumn falls back to an estimate from the column width; the
      // restack pass (post-mount) corrects it once measurable.
      const estAvail = Math.max(120, (it.w || 240) - 22);
      const kids = childrenOf(it.id);
      for (const child of kids) {
        if (!state.nodes.has(child.id)) {
          const cardNode = buildCard(child);
          cardNode.style.width = estAvail + "px";
          body.appendChild(cardNode);
          state.nodes.set(child.id, cardNode);
        }
      }
      refitColumn(it);
      requestAnimationFrame(() => restackColumn(it));
    };
    cap.addEventListener("dblclick", () => enterEdit(it.id, "field"));
    if (collapsed) {
      node.classList.add("collapsed");
    } else {
      const body = document.createElement("div");
      body.className = "col-body";
      node.appendChild(body);
      renderChildren();
    }
  } else if (it.type === "image") {
    node.classList.add("image");
    if (d.src) {
      const img = document.createElement("img");
      img.src = "milafile://m/" + encodePath(d.src);
      img.draggable = false;
      img.style.width = "100%";
      img.style.display = "block";
      node.appendChild(img);
    }
    const cap = document.createElement("div");
    cap.className = "caption";
    cap.textContent = d.caption || "";
    if (d.caption) node.appendChild(cap);
    // Hover corner handles resize the block (image scales with it)
    for (const corner of ["nw", "ne", "sw", "se"]) {
      const h = document.createElement("div");
      h.className = "rsz " + corner;
      h.dataset.corner = corner;
      h.title = "Resize";
      h.addEventListener("pointerdown", onImageHandlePointerDown);
      node.appendChild(h);
    }
  } else if (it.type === "file") {
    node.classList.add("file");
    const head = document.createElement("div");
    head.className = "fhead";
    const ico = document.createElement("div");
    ico.className = "fico";
    ico.textContent = fileIcon(d);
    const nm = document.createElement("div");
    nm.textContent = d.name || "File";
    head.append(ico, nm);
    node.appendChild(head);
    const open = document.createElement("a");
    open.className = "open";
    open.href = "#";
    open.textContent = "Open ↗";
    open.addEventListener("click", e => { e.preventDefault(); window.mila.openPath(d.src); });
    node.appendChild(open);
    const mime = d.mime || "";
    if (d.src && mime.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = "milafile://m/" + encodePath(d.src);
      img.draggable = false;
      img.style.cssText = "width:100%;margin-top:6px;border-radius:0;display:block";
      node.appendChild(img);
    } else if (d.src && mime.startsWith("audio/")) {
      const media = document.createElement("audio");
      media.src = "milafile://m/" + encodePath(d.src);
      media.controls = true;
      media.style.cssText = "width:100%;margin-top:6px";
      node.appendChild(media);
    } else if (d.src && mime.startsWith("video/")) {
      const media = document.createElement("video");
      media.src = "milafile://m/" + encodePath(d.src);
      media.controls = true;
      media.style.cssText = "width:100%;margin-top:6px;border-radius:0;max-height:220px";
      node.appendChild(media);
    }
    labelsRow(node, d);
  } else if (it.type === "board") {
    // Board tile: a solid colour square (its own colour) with the child
    // canvas name and card count underneath — no glyph inside the square.
    const tile = document.createElement("div");
    tile.className = "boardtile";
    const sq = document.createElement("div");
    sq.className = "bsq";
    sq.style.background = `var(--c-${it.color || it._childColor || "slate"})`;
    const nm = document.createElement("div");
    nm.className = "bnm";
    // a pending rename lives in data.title until updateItem() moves it to
    // the child canvas; prefer it over the (not-yet-refreshed) cached title.
    nm.textContent = d.title || it._childTitle || "Board";
    const cnt = document.createElement("div");
    cnt.className = "bcnt";
    const n = it._childCount || 0;
    cnt.textContent = `${n} card${n === 1 ? "" : "s"}`;
    const txt = document.createElement("div");
    txt.className = "btxt";
    txt.append(nm, cnt);
    tile.append(sq, txt);
    node.appendChild(tile);
  } else if (it.type === "shortcut") {
    // Shortcut to another board — same tile treatment, target board's colour.
    const tile = document.createElement("div");
    tile.className = "boardtile";
    const sq = document.createElement("div");
    sq.className = "bsq";
    sq.style.background = `var(--c-${it.color || (it._target || {}).color || "slate"})`;
    const nm = document.createElement("div");
    nm.className = "bnm";
    nm.textContent = (it._target || {}).title || "Missing board";
    const txt = document.createElement("div");
    txt.className = "btxt";
    txt.appendChild(nm);
    tile.append(sq, txt);
    node.appendChild(tile);
  } else if (it.type === "document") {
    const cap = document.createElement("div");
    cap.className = "cap";
    cap.style.cssText = "display:flex;gap:8px;font-weight:700";
    const t = document.createElement("span");
    t.textContent = d.title || "Document";
    cap.textContent = "📄 ";
    cap.appendChild(t);
    node.appendChild(cap);
    const words = (docPlainText(d.doc).match(/\S+/g) || []).length;
    if (words) {
      const cnt = document.createElement("div");
      cnt.style.cssText = "color:var(--ink-soft);font-size:11.5px;margin-top:4px";
      cnt.textContent = `${words} words · double-click to open`;
      node.appendChild(cnt);
    }
  } else {
    const cap = document.createElement("div");
    cap.className = "cap";
    cap.textContent = d.title || d.text || it.type;
    node.appendChild(cap);
  }
  return node;
}

function tableHandlers(tbl, it) {
  const commit = () => {
    const rows = [...tbl.rows].map(tr =>
      [...tr.cells].map(td => td.textContent.replace(/[\u00a0\n]+/g, " ").trim()));
    it.data.rows = rows;
    it.data.text = rows.map(r => r.join(" | ")).join("\n");
    updateItem(it);
  };
  let touched = null;
  tbl.addEventListener("input", () => { touched = Date.now(); });
  tbl.addEventListener("focusout", () => { if (touched) { touched = null; commit(); } });
}

// -- undo / redo ----------------------------------------------------------------
// Snapshot-based undo of the current canvas. Before every DB mutation we take a
// full payload snapshot of the canvas's items; undo writes the previous
// snapshot back atomically (db.replaceItems, via the allow-listed IPC API).
const UNDO_MAX = 100;
let undoBusy = false;
let undoCaptureSuppressed = 0;
const undoStack = [], redoStack = [];

// One undo entry per user action: capture happens at the top-level entry point
// and everything nested (autoArrange, restackColumn, ...) is suppressed, so a
// single Ctrl+Z always reverts exactly the one thing the user did.
async function withUndo(fn) {
  undoCaptureSuppressed++;
  try { return await fn(); }
  finally { undoCaptureSuppressed--; }
}
async function userAction(fn) {
  await captureUndo();
  return withUndo(fn);
}

async function captureUndo() {
  if (undoCaptureSuppressed > 0) return;
  const payload = await api("payload", state.canvas.id);
  if (payload && payload.items) {
    undoStack.push(JSON.parse(JSON.stringify(payload.items)));
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    redoStack.length = 0;
  }
}

async function performUndo() {
  if (undoBusy || !undoStack.length) return;
  undoBusy = true;
  try {
    const payload = await api("payload", state.canvas.id);
    if (payload && payload.items) redoStack.push(JSON.parse(JSON.stringify(payload.items)));
    const target = undoStack.pop();
    try {
      await api("replaceItems", state.canvas.id, target);
    } catch (err) {
      console.error("undo failed:", err);
      if (redoStack.length) undoStack.push(redoStack.pop());
      return;
    }
    state.selectedLine = null;
    await reloadCurrent();
  } finally {
    undoBusy = false;
  }
}

async function performRedo() {
  if (undoBusy || !redoStack.length) return;
  undoBusy = true;
  try {
    const payload = await api("payload", state.canvas.id);
    if (payload && payload.items) undoStack.push(JSON.parse(JSON.stringify(payload.items)));
    const target = redoStack.pop();
    try {
      await api("replaceItems", state.canvas.id, target);
    } catch (err) {
      console.error("redo failed:", err);
      if (undoStack.length) redoStack.push(undoStack.pop());
      return;
    }
    state.selectedLine = null;
    await reloadCurrent();
  } finally {
    undoBusy = false;
  }
}

// -- store plumbing -----------------------------------------------------------
function setSaveState(s) { const el = $("saveState"); if (el) el.textContent = s || ""; }

async function updateItem(it) {
  await captureUndo();
  setSaveState("saving…");
  await api("updateItem", JSON.parse(JSON.stringify(it)));
  setSaveState("saved");
}
async function updateItems(items) {
  await captureUndo();
  setSaveState("saving…");
  await api("updateItems", items.map(i => JSON.parse(JSON.stringify(
    { id: i.id, x: i.x, y: i.y, w: i.w, h: i.h, z: i.z, parentItemId: i.parentItemId }))));
  setSaveState("saved");
}

function createBody(type) {
  const body = {};
  if (type === "todo") {
    body.title = "To-do";
    body.tasks = [{ id: rid(), text: "", done: false }];
  } else if (type === "link") {
    body.url = ""; body.title = ""; body.titleTouched = false;
  }
  else if (type === "column") body.title = "Column";
  else if (type === "board") body.title = "Untitled board";
  else if (type === "document") body.title = "";
  else if (type === "table") body.rows = [["", "", ""], ["", "", ""]];
  return body;
}

const DEFAULT_W = { note: 240, todo: 240, link: 340, column: 252, board: 152,
  comment: 220, file: 220, table: 360, sketch: 320, document: 220, image: 220, swatch: 128,
  heading: 320 };

// Media batches (multi-file drops/uploads) are grid-reflowed once, at the end —
// not after every card.
let mediaBatchDepth = 0;
let mediaBatchNewIds = [];
function noteMediaCreated(id) {
  if (mediaBatchDepth > 0) { mediaBatchNewIds.push(id); return; }
  autoArrangeMedia([id]);
}

async function createAt(type, wx, wy, extra = {}) {
  return userAction(async () => {
  const body = { canvasId: state.canvas.id, type,
    x: Math.round(snap(wx)), y: Math.round(snap(wy)),
    w: extra.w || DEFAULT_W[type] || 240, data: extra.data || createBody(type) };
  const it = await api("createItem", body);
  state.items.set(it.id, it);
  appendCard(it);
  select(it.id);
  hint.classList.add("hidden");
  if (type === "note" || type === "comment" || type === "heading") enterEdit(it.id, "body");
  else if (type === "todo") enterEdit(it.id, "title");
  else if (type === "link") editLink(it);
  else if (["column", "board", "document"].includes(type)) enterEdit(it.id, "field");
  if (type === "image" || type === "file") noteMediaCreated(it.id);
  return it;
  });
}

// Upload files (from native picker or dropped paths) and spawn cards.
// type: "file" | "image"; wx/wy: world coords where the first card lands.
async function uploadThenCreate(type, wx, wy) {
  return userAction(async () => {
  mediaBatchDepth++;
  try {
    const files = await window.mila.uploadFiles();
    if (!files || !files.length) return 0;
    for (const f of files) {
      await createAt(type, wx, wy, { data: { src: f.src, name: f.name, mime: f.mime } });
      wy += 120; // cascade subsequent cards down
    }
    return files.length;
  } finally {
    mediaBatchDepth--;
    if (mediaBatchDepth === 0 && mediaBatchNewIds.length) {
      const ids = mediaBatchNewIds; mediaBatchNewIds = [];
      await autoArrangeMedia(ids);
    }
  }

  });
}

// -- selection --------------------------------------------------------------
function select(id, extend = false) {
  if (!extend) state.selection.clear();
  if (id) { state.selection.add(id); state.selectedId = id; }
  else state.selectedId = null;
  paintSelection();
}
function paintSelection() {
  for (const [id, node] of state.nodes) {
    node.classList.toggle("selected", state.selection.has(id));
    node.classList.toggle("cut", state.cutIds.has(id));
  }
}
function selectAll() {
  state.selection = new Set([...state.items.values()]
    .filter(it => !it.parentItemId).map(it => it.id));
  state.selectedId = [...state.selection][0] || null;
  paintSelection();
}
function selectedItems() {
  return [...state.items.values()].filter(it => state.selection.has(it.id) &&
    !(it.parentItemId && state.selection.has(it.parentItemId)));
}

// -- arrange images/files into a grid -------------------------------------------
// Equal gap on both axes; columns = ceil(sqrt(n)); reading order (y then x);
// snapped to the 10px grid; grid keeps the old bounding-box origin so it
// doesn't jump around. Shared by the manual action and the automatic
// arrange-on-add behavior.
const isRootMedia = it => (it.type === "image" || it.type === "file") && !it.parentItemId;
// Full layout used by the manual "Arrange as grid" action (reflows everything).
const GAP = 16;
function layoutMediaGrid(items) {
  if (items.length < 2) return null;
  const ordered = [...items].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const n = ordered.length;
  const cols = Math.ceil(Math.sqrt(n));
  const cellW = Math.max(...ordered.map(it => it.w || 240));
  const cellH = Math.max(...ordered.map(it => cardHeight(it)));
  const originX = Math.min(...ordered.map(it => it.x));
  const originY = Math.min(...ordered.map(it => it.y));
  ordered.forEach((it, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    it.x = snap(originX + col * (cellW + GAP));
    it.y = snap(originY + row * (cellH + GAP));
  });
  return ordered;
}
async function arrangeAsGrid() {
  return userAction(async () => {
  const ordered = layoutMediaGrid(selectedItems().filter(isRootMedia));
  if (!ordered) return;
  updateItems(ordered);
  for (const it of ordered) {
    if (!it.data.pin) { it.data.pin = true; await updateItem(it); }
  }
  await reloadCurrent();
  state.selection = new Set(ordered.map(it => it.id));
  state.selectedId = ordered[ordered.length - 1].id;
  paintSelection();
  drawLines();
  showSnackbar(`Arranged ${ordered.length} item${ordered.length === 1 ? "" : "s"} in a grid`, null, null);

  });
}

// Automatic behavior: after adding an image or file, reflow every unpinned
// root image/file into a compact grid. Manually placed/arranged media is
// pinned and never moved. Silent — this is a default behavior, not a mode.
async function autoArrangeMedia(focus) {
  return withUndo(async () => {
  // Reflow only unpinned media into a compact grid — manually arranged items
  // stay put. Called after every image/file add: this is a default behavior.
  const items = [...state.items.values()].filter(i => isRootMedia(i) && !i.data.pin);
  const last = focus == null ? null : (Array.isArray(focus) ? focus[focus.length - 1] : focus);
  if (items.length) {
    const ordered = layoutMediaGrid(items);
    if (ordered) {
      updateItems(ordered);
      await reloadCurrent();
    }
  }
  if (last && state.items.has(last)) {
    state.selection = new Set([last]);
    state.selectedId = last;
    paintSelection();
  }
  drawLines();

  });
}

// Typed column counter: "1 board, 4 cards" / "2 cards" / "0 cards"
function columnCounter(kids) {
  const boards = kids.filter(k => k.type === "board" || k.type === "shortcut").length;
  const cards = kids.length - boards;
  if (!boards && !cards) return "0 cards";
  const parts = [];
  if (boards) parts.push(`${boards} board${boards === 1 ? "" : "s"}`);
  if (cards) parts.push(`${cards} card${cards === 1 ? "" : "s"}`);
  return parts.join(", ");
}

// -- deletion + undo ----------------------------------------------------------
async function deleteSelection() {
  return userAction(async () => {
  const roots = selectedItems();
  if (!roots.length) return;
  const rootIds = roots.map(it => it.id);
  for (const it of roots) await api("trashDeep", it.id);
  await reloadCurrent();
  showSnackbar(`Deleted ${rootIds.length} item${rootIds.length > 1 ? "s" : ""}`, "Undo", async () => {
    await captureUndo();
    for (const id of rootIds) await api("restore", id);
    await reloadCurrent();
  });

  });
}
async function reloadCurrent() {
  const payload = await api("payload", state.canvas.id);
  if (payload) load(payload);
}

// -- editing -------------------------------------------------------------------
function commitEdit() {
  // MUST stay synchronous: enterEdit() calls this before taking focus, and a
  // deferred commit would clear the edit that was just opened. The undo snapshot
  // is taken by updateItem() at the end (it captures before writing).
  const e = state.editing;
  if (!e) return;
  state.editing = null;
  state.editJustEnded = Date.now();
  e.el.removeEventListener("blur", onEditBlur);
  e.el.removeEventListener("keydown", onEditKey, true);
  if (e.kind !== "linkurl") e.el.contentEditable = "false";
  const node = state.nodes.get(e.id);
  if (node) node.classList.remove("editing");
  const it = state.items.get(e.id);
  const text = e.kind === "linkurl" ? ""
    : e.el.innerText.replace(/[\u00a0]/g, " ").replace(/^\n|\n$/g, "");
  if (e.kind === "body") {
    it.data.text = text;
    it.data.doc = docFromText(text);
    // A note whose whole text is a hex colour becomes a swatch (web app rule).
    if (it.type === "note" && /^#[0-9a-fA-F]{6}$/.test(text.trim())) {
      it.type = "swatch";
      it.w = DEFAULT_W.swatch;
      it.data = { hex: text.trim(), text: text.trim() };
    }
  } else if (e.kind === "task") {
    const t = (it.data.tasks || [])[e.index];
    if (t) t.text = text;
  } else if (e.kind === "title") {
    it.data.title = text.slice(0, 200) || (it.type === "todo" ? "To-do" : "");
  } else if (e.kind === "field") {
    it.data.title = text.slice(0, 200);
  } else if (e.kind === "linkurl") {
    // Bare domains get https:// prepended; anything with a scheme is kept.
    // (openExternal/fetchMeta only honor http(s) regardless.)
    let url = String(e.el.value || "").trim();
    if (url && !/^[a-z][a-z0-9+.-]*:/i.test(url)) url = "https://" + url;
    if (url !== (it.data.url || "")) {
      it.data.url = url;
      it.data.thumb = undefined;
      it.data.title = "";
      it.data.titleTouched = false;
    }
  }
  refreshItem(it);
  updateItem(it);
}

function onEditBlur() { commitEdit(); }
function onEditKey(e) {
  const es = state.editing;
  if (!es) return;
  if (e.key === "Escape") {
    e.stopPropagation();
    state.editing = null;
    es.el.removeEventListener("blur", onEditBlur);
    es.el.removeEventListener("keydown", onEditKey, true);
    es.el.contentEditable = "false";
    const n = state.nodes.get(es.id);
    if (n) n.classList.remove("editing");
    refreshItem(state.items.get(es.id));
    return;
  }
  if (es.kind === "task") {
    const it = state.items.get(es.id);
    const tasks = it.data.tasks || [];
    const i = es.index;
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation(); // don't let the window handler see Enter after commit
      commitEdit();
      tasks.splice(i + 1, 0, { id: rid(), text: "", done: false, indent: (tasks[i] && tasks[i].indent) || 0 });
      refreshItem(it);
      updateItem(it).then(() => enterEdit(it.id, "task", i + 1));
      return;
    }
    if (e.key === "Backspace" && !es.el.innerText.trim() && tasks.length > 1) {
      e.preventDefault();
      e.stopPropagation();
      tasks.splice(i, 1);
      state.editing = null;
      es.el.removeEventListener("blur", onEditBlur);
      es.el.removeEventListener("keydown", onEditKey, true);
      es.el.contentEditable = "false";
      refreshItem(it);
      updateItem(it).then(() => enterEdit(it.id, "task", Math.max(0, i - 1)));
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      const cur = tasks[i].indent || 0;
      const prev = i ? tasks[i - 1].indent || 0 : -1;
      if (e.shiftKey) { if (cur > 0) tasks[i].indent = cur - 1; else return; }
      else if (cur <= prev && cur < 4) tasks[i].indent = cur + 1;
      else return;
      tasks[i].text = es.el.innerText.replace(/[\u00a0]/g, " ").replace(/^\n|\n$/g, "");
      state.editing = null;
      es.el.removeEventListener("blur", onEditBlur);
      es.el.removeEventListener("keydown", onEditKey, true);
      es.el.contentEditable = "false";
      refreshItem(it);
      updateItem(it).then(() => enterEdit(it.id, "task", i));
      return;
    }
  } else if (es.kind === "title" && e.key === "Enter") {
    e.preventDefault();
    e.stopPropagation();
    const it = state.items.get(es.id);
    commitEdit();
    enterEdit(it.id, "task", 0);
  } else if (es.kind === "field" && e.key === "Enter") {
    // Board / column / document names: Enter confirms instead of inserting a newline.
    e.preventDefault();
    e.stopPropagation();
    commitEdit();
  }
}

function enterEdit(id, kind = "body", index = 0) {
  commitEdit();
  // A gesture may still be in flight when editing starts (e.g. Enter pressed
  // while the mouse button is held on the card). Drop it, otherwise the card
  // keeps following the cursor while its name is being edited.
  if (state.drag) { state.drag = null; clearInsertLine(); }
  if (state.lineDrag) state.lineDrag = null;
  if (state.panning) { state.panning = null; stage.classList.remove("panning"); }
  if (state.marquee) { state.marquee = null; marqueeEl.classList.add("hidden"); }
  const it = state.items.get(id);
  let node = state.nodes.get(id);
  if (!node) return;
  let el;
  if (kind === "body") el = node.querySelector(".body");
  else if (kind === "title") el = node.querySelector(".title");
  else if (kind === "field") el = node.querySelector(".cap span") || node.querySelector(".coltitle")
    || node.querySelector(".boardtile .bnm") || node.querySelector(".cap");
  else if (kind === "linkurl") {
    // The preview card must rebuild into input mode first (it renders an
    // input instead of the preview while in linkurl-editing state).
    if (!node.querySelector(".linput")) {
      state.editing = { id, kind, index, el: null };
      refreshItem(it);
      node = state.nodes.get(id);
      if (!node) return;
    }
    el = node.querySelector(".linput");
  }
  else if (kind === "task") {
    const rows = node.querySelectorAll(".trow .txt");
    el = rows[index];
    if (!el && !state.items.get(id)) return;
    if (!el) {
      it.data.tasks = it.data.tasks || [];
      it.data.tasks.push({ id: rid(), text: "", done: false, indent: 0 });
      refreshItem(it);
      return enterEdit(id, kind, index);
    }
  }
  if (!el) return;
  state.editing = { id, kind, index, el };
  node.classList.add("editing");
  if (kind !== "linkurl") {
    el.contentEditable = "plaintext-only";
    if (el.contentEditable !== "plaintext-only") el.contentEditable = "true";
  }
  el.focus({ preventScroll: true }); // keep the hidden-overflow stage from scrolling
  if (kind === "linkurl") {
    el.setSelectionRange(el.value.length, el.value.length); // cursor at end
  } else {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }
  el.addEventListener("blur", onEditBlur);
  el.addEventListener("keydown", onEditKey, true);
  // Placeholders must follow the live text (hide on first keystroke)
  const toggleEmpty = () => {
    const txt = (el.isContentEditable ? el.innerText : el.value || "").trim();
    el.classList.toggle("empty", !txt);
  };
  el.addEventListener("input", toggleEmpty);
  stage.scrollLeft = 0; stage.scrollTop = 0; // focus scroll-into-view guard
}

// -- lines ----------------------------------------------------------------------
// The line's visible endpoints with card-edge clipping applied — the same
// geometry used for rendering, snapping, marquee hit-testing and translate.
function lineAxisEnds(it) {
  const [a, b] = lineEnds(it) || [];
  if (!a || !b) return null;
  let ax = a.x, ay = a.y, bx = b.x, by = b.y;
  if (a.card) { const e = edgePoint(a.card, bx, by); ax = e.x; ay = e.y; }
  if (b.card) { const e = edgePoint(b.card, ax, ay); bx = e.x; by = e.y; }
  return { ax, ay, bx, by, aCard: a.card || null, bCard: b.card || null };
}

function lineEnds(it) {
  const a = it.data.from || {}, b = it.data.to || {};
  const pt = end => {
    if (end.id) {
      // Card may live inside a column — its stored x/y are body-relative, so
      // measure the rendered node and convert back to world coordinates.
      const n = state.nodes.get(end.id);
      const it2 = state.items.get(end.id);
      if (!n || !it2) return null;
      const r = n.getBoundingClientRect();
      const st = stageRect();
      const w = r.width / state.cam.z, h = r.height / state.cam.z;
      const cx = (r.left - st.left - state.cam.x) / state.cam.z + w / 2;
      const cy = (r.top - st.top - state.cam.y) / state.cam.z + h / 2;
      return { x: cx, y: cy, card: { x: cx - w / 2, y: cy - h / 2, w, h } };
    }
    return { x: end.x || 0, y: end.y || 0 };
  };
  return [pt(a), pt(b)];
}

function drawLines() {
  const svg = world.querySelector("#linesvg");
  if (!svg) return;
  svg.textContent = "";
  const dots = world.querySelector("#linedots");
  if (dots) dots.textContent = "";
  svg.style.cssText = `position:absolute;top:0;left:0;width:1px;height:1px;overflow:visible;pointer-events:none;`;
  if (dots) dots.style.cssText = `position:absolute;top:0;left:0;width:1px;height:1px;overflow:visible;pointer-events:none;`;
  const NS = "http://www.w3.org/2000/svg";
  for (const it of state.items.values()) {
    if (it.type !== "line") continue;
    const ends = lineAxisEnds(it);
    if (!ends) continue;
    const { ax, ay, bx, by } = ends;
    const ctrl = curveCtrl(ax, ay, bx, by, it);
    const apex = quadPoint(ax, ay, ctrl.x, ctrl.y, bx, by, 0.5);
    const g = document.createElementNS(NS, "g");
    g.dataset.id = it.id;
    const color = it.color && it.color !== "gray" ? `var(--c-${it.color})` : "var(--ink)";
    const selected = state.selectedLine === it.id;
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", `M${ax} ${ay} Q ${ctrl.x} ${ctrl.y} ${bx} ${by}`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", selected ? 2.4 : 2);
    if (it.data.dashed) path.setAttribute("stroke-dasharray", "7 6");
    path.style.pointerEvents = "none"; // hitbox handles pointer gestures
    g.appendChild(path);
    // Invisible fat hitbox so the line is easy to click and drag
    const hit = document.createElementNS(NS, "path");
    hit.setAttribute("d", path.getAttribute("d"));
    hit.setAttribute("fill", "none");
    hit.setAttribute("stroke", "rgba(0,0,0,0)");
    hit.setAttribute("stroke-width", 16);
    hit.style.pointerEvents = "stroke";
    hit.style.cursor = "move";
    hit.classList.add("linehit");
    g.appendChild(hit);
    const arrow = it.data.arrow || "end";
    if (arrow !== "none") {
      // Outward-pointing tangent angles at both ends
      const a1 = Math.atan2(ay - ctrl.y, ax - ctrl.x);
      const a2 = Math.atan2(by - ctrl.y, bx - ctrl.x);
      const ends = arrow === "both" ? [[ax, ay, a1], [bx, by, a2]] : [[bx, by, a2]];
      for (const [ex, ey, ang] of ends) {
        // Barbs extend BACKWARD from the tip (outward angle + π),
        // otherwise the arrowhead renders as "<" instead of ">".
        const barb = ang + Math.PI;
        const h = document.createElementNS(NS, "path");
        h.setAttribute("d", `M${ex} ${ey} L ${ex + 9 * Math.cos(barb - 0.42)} ${ey + 9 * Math.sin(barb - 0.42)} M${ex} ${ey} L ${ex + 9 * Math.cos(barb + 0.42)} ${ey + 9 * Math.sin(barb + 0.42)}`);
        h.setAttribute("stroke", color);
        h.setAttribute("stroke-width", 2);
        h.setAttribute("fill", "none");
        h.style.strokeLinecap = "round";
        h.style.pointerEvents = "none";
        g.appendChild(h);
      }
    }
    if (it.data.label) {
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", apex.x);
      t.setAttribute("y", apex.y - 7);
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("fill", "var(--ink)");
      t.textContent = it.data.label;
      t.style.pointerEvents = "none";
      g.appendChild(t);
    }
    svg.appendChild(g);
    // Selection handles: three draggable dots (extreme = ends, middle = curve)
    if (selected && dots) {
      const dg = document.createElementNS(NS, "g");
      dg.dataset.id = it.id;
      for (const [role, px, py] of [["from", ax, ay], ["mid", apex.x, apex.y], ["to", bx, by]]) {
        const c = document.createElementNS(NS, "circle");
        c.setAttribute("cx", px); c.setAttribute("cy", py); c.setAttribute("r", 4.6);
        c.setAttribute("fill", "#ffffff");
        c.setAttribute("stroke", "var(--ink)");
        c.setAttribute("stroke-width", 1.6);
        c.setAttribute("class", "linedot");
        c.dataset.id = it.id;
        c.dataset.role = role;
        c.style.pointerEvents = "all";
        c.style.cursor = role === "mid" ? "grab" : "move";
        dg.appendChild(c);
      }
      dots.appendChild(dg);
    }
  }
  // #linesvg and #linedots are children of #world, which already carries the
  // camera transform — adding translate/scale here would double-apply it.
}

function edgePoint(card, towardX, towardY) {
  const cx = card.x + card.w / 2, cy = card.y + card.h / 2;
  const dx = towardX - cx, dy = towardY - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const sx = dx !== 0 ? (card.w / 2) / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? (card.h / 2) / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

// -- pointer interactions -------------------------------------------------------
stage.addEventListener("wheel", e => {
  e.preventDefault();
  if (e.ctrlKey) {
    zoomAt(e.clientX - stageRect().left, e.clientY - stageRect().top, Math.pow(1.0016, -e.deltaY));
  } else {
    state.cam.x -= e.deltaX;
    state.cam.y -= e.deltaY;
    applyCam();
  }
}, { passive: false });

stage.addEventListener("pointerdown", e => {
  hideCtx();
  if (e.target.closest(".pill")) return; // UI pills handle their own clicks
  if (e.target.closest("#linesvg") || e.target.closest("#linedots")) return; // world owns line gestures
  if (e.button === 1 || state.space) {
    state.panning = { sx: e.clientX, sy: e.clientY, cx: state.cam.x, cy: state.cam.y };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add("panning");
    return;
  }
  if (e.button !== 0) return;
  const card = e.target.closest(".card");
  if (state.tool === "line") {
    const p = toWorld(e.clientX, e.clientY);
    if (card && !state.lineDraft) {
      state.lineDraft = { from: { id: card.dataset.id } };
      return;
    }
    if (state.lineDraft) {
      const to = card ? { id: card.dataset.id } : { x: snap(p.x), y: snap(p.y) };
      createAt("line", 0, 0, { data: { from: state.lineDraft.from, to, arrow: "end", dashed: false, label: "", text: "" }, w: 1 })
        .then(() => { state.lineDraft = null; setTool(null); });
      return;
    }
    state.lineDraft = { from: { x: snap(p.x), y: snap(p.y) } };
    return;
  }
  if (state.tool) {
    const inColumn = !!columnAt(e.clientX, e.clientY);
    if (card && !inColumn && !["column", "board"].includes(state.tool)) return;
    if (state.tool === "image" || state.tool === "file") {
      setTool(null);
      const p = toWorld(e.clientX, e.clientY);
      uploadThenCreate(state.tool, p.x - 60, p.y - 60).then(n => { if (n) showSnackbar(n + " file" + (n > 1 ? "s" : "") + " added"); });
      return;
    }
    if (state.tool === "line") return;
    const p = toWorld(e.clientX, e.clientY);
    const ty = state.tool;
    const cx = e.clientX, cy = e.clientY;
    setTool(null);
    createAt(ty, p.x - (ty === "board" ? 76 : 120), p.y - 40)
      .then(created => { if (created) appendToColumnAt(cx, cy, created.id); });
    return;
  }
  if (!card) {
    const add = e.ctrlKey || e.metaKey;
    if (!add) select(null);
    state.marquee = { sx: e.clientX - stageRect().left, sy: e.clientY - stageRect().top,
                      add, base: new Set(state.selection) };
    marqueeEl.classList.remove("hidden");
    marqueeEl.style.cssText += ";left:0;top:0;width:0;height:0";
    moveMarquee(e);
    stage.setPointerCapture(e.pointerId);
  }
});

stage.addEventListener("pointermove", e => {
  if (state.imageDrag) { imageResizeMove(e); return; }
  if (state.lineDrag) { dragLineMove(e); return; }
  if (state.panning) {
    state.cam.x = state.panning.cx + e.clientX - state.panning.sx;
    state.cam.y = state.panning.cy + e.clientY - state.panning.sy;
    applyCam();
    return;
  }
  if (state.marquee) moveMarquee(e);
  if (state.drag && !state.editing) dragMove(e);
});
window.addEventListener("pointercancel", () => {
  if (state.drag) { state.drag = null; clearInsertLine(); }
});
// A release outside the stage (over the rail, a menu, or the window edge)
// never reaches the stage handler — without this the card stays glued.
window.addEventListener("pointerup", e => {
  if (state.drag && !stage.contains(e.target)) { state.drag = null; clearInsertLine(); }
});

function moveMarquee(e) {
  const { sx, sy } = state.marquee;
  const cx = e.clientX - stageRect().left, cy = e.clientY - stageRect().top;
  marqueeEl.style.left = Math.min(sx, cx) + "px";
  marqueeEl.style.top = Math.min(sy, cy) + "px";
  marqueeEl.style.width = Math.abs(cx - sx) + "px";
  marqueeEl.style.height = Math.abs(cy - sy) + "px";
}

stage.addEventListener("pointerup", async e => {
  if (state.imageDrag) { imageResizeEnd(); return; }
  if (state.lineDrag) { endLineDrag(e); return; }
  if (state.panning) { state.panning = null; stage.classList.remove("panning"); return; }
  if (state.marquee) {
    const r = marqueeEl.getBoundingClientRect();
    const mA = toWorld(r.left, r.top), mB = toWorld(r.right, r.bottom);
    const sel = new Set(state.marquee.add ? state.marquee.base : []);
    for (const it of state.items.values()) {
      if (it.type === "line" || it.parentItemId) continue;
      const h = cardHeight(it);
      if (mA.x < it.x + (it.w || 240) && mB.x > it.x && mA.y < it.y + h && mB.y > it.y) sel.add(it.id);
    }
    // lines: any sampled point of the curve inside the rect selects the line
    for (const it of state.items.values()) {
      if (it.type !== "line") continue;
      const [pa, pb] = lineEnds(it) || [];
      if (!pa || !pb) continue;
      let ax = pa.x, ay = pa.y, bx = pb.x, by = pb.y;
      if (pa.card) { const e2 = edgePoint(pa.card, bx, by); ax = e2.x; ay = e2.y; }
      if (pb.card) { const e2 = edgePoint(pb.card, ax, ay); bx = e2.x; by = e2.y; }
      const ctrl = curveCtrl(ax, ay, bx, by, it);
      let hit = false;
      for (let i = 0; i <= 20 && !hit; i++) {
        const p = quadPoint(ax, ay, ctrl.x, ctrl.y, bx, by, i / 20);
        if (p.x >= mA.x && p.x <= mB.x && p.y >= mA.y && p.y <= mB.y) hit = true;
      }
      if (hit) sel.add(it.id);
    }
    for (const it of [...state.items.values()]) {
      if (it.type === "column" && sel.has(it.id) && it.parentItemId) sel.add(it.parentItemId);
      if (it.parentItemId && sel.has(it.parentItemId) &&
          state.items.get(it.parentItemId)?.type === "column") sel.add(it.id);
    }
    state.selection = sel;
    const selLine = [...sel].find(id => state.items.get(id)?.type === "line");
    state.selectedLine = selLine || null;
    state.selectedId = [...sel].find(id => state.items.get(id)?.type !== "line") || [...sel][0] || null;
    paintSelection();
    state.marquee = null;
    marqueeEl.classList.add("hidden");
    drawLines(); // show handles on a marquee-selected line
    return;
  }
  if (state.drag) {
    if (state.drag.moved) {
      // media the user placed manually are pinned — grid auto-flow stops touching them
      const pinned = [];
      for (const id of state.drag.ids) {
        const it = state.items.get(id);
        if (it && (it.type === "image" || it.type === "file") && !it.parentItemId && !it.data.pin) {
          it.data.pin = true;
          pinned.push(it);
        }
      }
      await updateItems(selectedItems());
      for (const it of pinned) await updateItem(it);
    }
    dropIntoColumn(e).catch(err => console.error("dropIntoColumn failed:", err));
    state.drag = null;
    clearInsertLine();
  }
});

function dragMove(e) {
  const p = toWorld(e.clientX, e.clientY);
  const dx = p.x - state.drag.wx, dy = p.y - state.drag.wy;
  if (!state.drag.moved && Math.abs(dx) + Math.abs(dy) < 3 / state.cam.z) return;
  state.drag.moved = true;
  const lead = state.items.get(state.drag.leadId);
  const [bx, by] = state.drag.base[lead.id];
  const nx = snap(bx + dx, e.shiftKey), ny = snap(by + dy, e.shiftKey);
  const sdx = nx - bx, sdy = ny - by;
  for (const id of state.drag.ids) {
    const it = state.items.get(id);
    if (!it) continue;
    const [px, py] = state.drag.base[id];
    it.x = px + sdx;
    it.y = py + sdy;
    it.z = Math.max(it.z || 0, state.drag.z);
    const node = state.nodes.get(id);
    if (node) { node.style.left = it.x + "px"; node.style.top = it.y + "px"; }
    if (it.type === "line") {
      const o = state.drag.orig[id];
      if (o.from && o.from.x != null)
        it.data.from = { x: Math.round(o.from.x + sdx), y: Math.round(o.from.y + sdy) };
      if (o.to && o.to.x != null)
        it.data.to = { x: Math.round(o.to.x + sdx), y: Math.round(o.to.y + sdy) };
      if (o.curve) it.data.curve = { cx: o.curve.cx + sdx, cy: o.curve.cy + sdy };
    }
  }
  updateInsertLine(e);
  drawLines();
}

function columnAt(clientX, clientY) {
  const st = stage.getBoundingClientRect();
  const p = toWorld(clientX, clientY);
  let found = null;
  for (const node of state.nodes.values()) {
    if (!node.classList.contains("column")) continue;
    const r = node.getBoundingClientRect();
    const cx = (r.left - st.left - state.cam.x) / state.cam.z;
    const cy = (r.top - st.top - state.cam.y) / state.cam.z;
    const cw = r.width / state.cam.z, ch = r.height / state.cam.z;
    if (p.x >= cx - 10 && p.x <= cx + cw + 10 && p.y >= cy - 10 && p.y <= cy + ch + 10) { found = node; break; }
  }
  return found;
}

// Stack `list` of cards into `colItem` at `insertAt` (absolute index into the
// children order) or at the bottom when null. Re-lays the whole column compactly
// after the insert. Used by click-append (null) and drag-drop (insertAt).
async function stackIntoColumn(colItem, list, insertAt = null) {
  const avail = Math.max(120, (colItem.w || 240) - 22);
  const existing = [...state.items.values()]
    .filter(k => k.parentItemId === colItem.id && !list.includes(k))
    .sort((a, b) => (a.y - b.y) || ((a.z || 0) - (b.z || 0)));
  const seq = insertAt == null
    ? [...existing, ...list]
    // clamp index into [0, existing.length]; new cards keep creation order
    : [...existing.slice(0, Math.min(Math.max(insertAt, 0), existing.length)), ...list,
       ...existing.slice(Math.min(Math.max(insertAt, 0), existing.length))];
  let bottom = 2;
  const changed = [];
  for (const it of seq) {
    const h = state.nodes.get(it.id)?.offsetHeight || 60;
    const cw = avail; // children fill the column body edge-to-edge
    it.parentItemId = colItem.id;
    it.x = 0;
    it.y = bottom;
    bottom += h + 10;
    changed.push(it);
  }
  // update live nodes so the layout stays correct without a reload
  for (const it of changed) {
    const cn = state.nodes.get(it.id);
    if (cn) { cn.style.left = it.x + "px"; cn.style.top = it.y + "px"; }
  }
  if (changed.length) await updateItems(changed);
  const body = findColBody(colItem.id);
  if (body) body.style.height = (seq.length ? bottom - 6 : 72) + "px";
  return seq;
}

function findColBody(colId) {
  const n = state.nodes.get(colId);
  return n && n.querySelector(".col-body");
}

// Compute the slot index + line position for a column-body under the pointer.
// Returns { idx, lineY } with lineY in body-relative pixels. Dragged cards are
// excluded from the count so the insertion indicator tracks the cursor.
function insertSlotFor(colBody, clientX, clientY, excludeIds) {
  const body = colBody;
  const skip = excludeIds || state.drag?.ids || [];
  const kids = [...body.querySelectorAll(".card")]
    .map(n => state.items.get(n.dataset.id)).filter(Boolean)
    .filter(it => !skip.includes(it.id))
    .sort((a, b) => a.y - b.y);
  const br = body.getBoundingClientRect();
  const st = stageRect();
  const bodyTop = (br.top - st.top - state.cam.y) / state.cam.z;
  const my = toWorld(clientX, clientY).y - bodyTop;
  let idx = 0;
  for (const k of kids) {
    const n = state.nodes.get(k.id);
    const h = n ? n.offsetHeight : 60;
    if (my <= k.y + h / 2) break;
    idx++;
  }
  let lineY;
  // Empty column: put the hint at the BOTTOM of the gray placeholder area,
  // not at its top edge (which reads as "above the gray background").
  if (!kids.length) lineY = Math.max(2, body.clientHeight - 4);
  // ... chained cases kept below for non-empty columns
  if (idx === 0 && kids.length) lineY = Math.max(0, kids[0].y - 7);
  else if (idx === kids.length && kids.length) {
    const l = kids[kids.length - 1];
    const n = state.nodes.get(l.id);
    lineY = l.y + (n ? n.offsetHeight : 60) + 3;
  } else if (idx > 0 && idx < kids.length) {
    lineY = kids[idx].y - 7;
  }
  return { idx, lineY, count: kids.length };
}

function updateInsertLine(e) {
  const colNode = columnAt(e.clientX, e.clientY);
  const ids = state.drag.ids.filter(id => {
    const it = state.items.get(id);
    return it && it.type !== "column";
  });
  const body = colNode && colNode.querySelector(".col-body");
  if (!body || !ids.length) {
    clearInsertLine();
    return;
  }
  const { idx, lineY } = insertSlotFor(body, e.clientX, e.clientY);
  state.dropIdx = idx;
  state.dropColId = colNode.dataset.id;
  let line = body.querySelector(".insertline");
  if (!line) {
    line = document.createElement("div");
    line.className = "insertline";
    body.appendChild(line);
  }
  line.style.top = (lineY + 1) + "px";
}

function clearInsertLine() {
  document.querySelectorAll(".insertline").forEach(el => el.remove());
  state.dropIdx = null;
  state.dropColId = null;
}

// Append a freshly created card to the column under (clientX, clientY), if any.
// Placed below the column's existing children; expands a collapsed column.
// Returns true when the card was re-parented. Re-parents the existing DOM node
// in place (no full reload) so an editor opened for the new card keeps focus.
async function appendToColumnAt(clientX, clientY, createdId) {
  return userAction(async () => {
  const colNode = columnAt(clientX, clientY);
  if (!colNode) return false;
  const colItem = state.items.get(colNode.dataset.id);
  const it = state.items.get(createdId);
  if (!colItem || colItem.type !== "column" || !it || it.type === "column") return false;
  const editing = state.editing && state.editing.id === it.id ? state.editing : null;
  const kind = editing && editing.kind, index = editing && editing.index;
  // Persist the parent/position, expand a collapsed column, then rebuild from
  // the store. Rebuilding avoids moving a focused node mid-edit (which used to
  // blur/commit and swap it). Reopen the editor afterwards.
  await stackIntoColumn(colItem, [it]);
  if (colItem.data.collapsed) { colItem.data.collapsed = false; await updateItem(colItem); }
  await reloadCurrent();
  select(createdId);
  if (kind) enterEdit(createdId, kind, index || 0);
  return true;
  });
}

async function dropIntoColumn(e) {
  return withUndo(async () => {
  const ids = state.drag.ids;
  const colEl = columnAt(e.clientX, e.clientY);
  const colId = colEl ? colEl.dataset.id : null;
  const intoColumn = !!colId;
  let changed = false;
  if (intoColumn) {
    const colItem = state.items.get(colId);
    const list = [];
    for (const id of ids) {
      const it = state.items.get(id);
      if (!it || it.type === "column") continue;
      if (it.id === colId || it.parentItemId === colId) continue;
      list.push(it);
    }
    if (list.length && colItem && colItem.type === "column") {
      const insertAt = (state.dropColId === colId && state.dropIdx != null) ? state.dropIdx : null;
      await stackIntoColumn(colItem, list, insertAt);
      if (colItem.data.collapsed) { colItem.data.collapsed = false; await updateItem(colItem); }
      changed = true;
    }
  } else {
    for (const id of ids) {
      const it = state.items.get(id);
      if (!it || it.type === "column") continue;
      if (it.parentItemId && !state.selection.has(it.parentItemId)) {
        // dragged out of a column without that column in the selection -> detach to root
        const p = toWorld(e.clientX, e.clientY);
        await api("updateItems", [{ id, x: Math.round(p.x - 40), y: Math.round(p.y - 20),
          w: it.w, h: it.h, parentItemId: null, z: it.z }]);
        it.parentItemId = null;
        it.x = Math.round(p.x - 40);
        it.y = Math.round(p.y - 20);
        changed = true;
      }
    }
  }
  if (changed) await reloadCurrent();
  });
}

// -- card events ------------------------------------------------------------------
world.addEventListener("pointerdown", e => {
  if (state.tool) return; // rail tool armed: stage handler owns the click
  const dot = e.target.closest && e.target.closest(".linedot");
  if (dot) {
    e.stopPropagation();
    const p = toWorld(e.clientX, e.clientY);
    state.lineDrag = { id: dot.dataset.id, role: dot.dataset.role, moved: false,
      // snapshots for whole-line translation
      from: null, to: null, curve: null, start: p };
    const it = state.items.get(state.lineDrag.id);
    if (it) {
      state.lineDrag.from = cloneJson(it.data.from);
      state.lineDrag.to = cloneJson(it.data.to);
      state.lineDrag.curve = it.data.curve ? { ...it.data.curve } : null;
    }
    stage.setPointerCapture(e.pointerId);
    return;
  }
  const lineG = e.target.closest && e.target.closest("#linesvg g");
  if (lineG) {
    // left-click a stroke: select on release if it didn't move; drag = translate line
    e.stopPropagation();
    const p = toWorld(e.clientX, e.clientY);
    const it = state.items.get(lineG.dataset.id);
    state.lineDrag = { id: lineG.dataset.id, role: "move", moved: false, start: p,
      from: it ? cloneJson(it.data.from) : null,
      to: it ? cloneJson(it.data.to) : null,
      curve: it && it.data.curve ? { ...it.data.curve } : null };
    stage.setPointerCapture(e.pointerId);
    return;
  }
  const node = e.target.closest(".card");
  if (!node) return;
  const id = node.dataset.id;
  const it = state.items.get(id);
  if (!it) return;
  if (state.editing && state.editing.id !== id) commitEdit();
  else if (state.editing) return;
  if (e.target.closest(".colchev") && it.type === "column") {
    e.stopPropagation();
    it.data.collapsed = !it.data.collapsed;
    refreshItem(it);
    updateItem(it);
    return;
  }
  if (e.target.closest(".trow .box")) {
    const idx = [...node.querySelectorAll(".trow")].indexOf(e.target.closest(".trow"));
    const t = it.data.tasks[idx];
    t.done = !t.done;
    refreshItem(it);
    updateItem(it);
    return;
  }
  if (e.target.closest(".colcap") && it.type === "column") {
    if (e.detail === 2) return; // dblclick handled separately
  }
  if (e.ctrlKey || e.metaKey) {
    if (state.selection.has(id)) state.selection.delete(id);
    else select(id, true);
    return;
  }
  if (!state.selection.has(id)) select(id);
  const p = toWorld(e.clientX, e.clientY);
  const ids = selectedItems().map(i => i.id);
  const base = {};
  const orig = {};
  for (const sid of ids) {
    const i2 = state.items.get(sid);
    base[sid] = [i2.x, i2.y];
    if (i2.type === "line")
      orig[sid] = { from: cloneJson(i2.data.from), to: cloneJson(i2.data.to), curve: i2.data.curve ? { ...i2.data.curve } : null };
  }
  const z = Math.max(0, ...[...state.items.values()].map(i => i.z || 0)) + 1;
  state.drag = { ids, base, orig, leadId: id, wx: p.x, wy: p.y, moved: false, z };
});

world.addEventListener("dblclick", e => {
  const node = e.target.closest(".card");
  if (!node) return;
  const id = node.dataset.id;
  const it = state.items.get(id);
  if (!it) return;
  if (it.type === "board" && it.data.childCanvasId) return openCanvas(it.data.childCanvasId);
  if (it.type === "shortcut" && it.data.targetCanvasId) return openCanvas(it.data.targetCanvasId);
  if (it.type === "document") return openDocument(it);
  if (it.type === "image") return showImage(it.id);
  if (e.target.closest(".trow .box")) return;
  if (it.type === "note" || it.type === "comment" || it.type === "heading") return enterEdit(id, "body");
  if (it.type === "todo") {
    if (!e.target.closest(".trow")) return enterEdit(id, "title");
    const idx = [...node.querySelectorAll(".trow")].indexOf(e.target.closest(".trow"));
    return enterEdit(id, "task", idx);
  }
  if (it.type === "link") return editLink(it);
  if (it.type === "column") return;
  enterEdit(id, "field");
});

stage.addEventListener("dblclick", e => {
  if (e.target.closest(".card")) return;
  const p = toWorld(e.clientX, e.clientY);
  createAt("note", p.x - 120, p.y - 40);
});

// -- context menu -------------------------------------------------------------------
function hideCtx() { ctxEl.classList.add("hidden"); }
document.addEventListener("pointerdown", e => {
  if (!e.target.closest("#ctxmenu")) hideCtx();
}, true);

world.addEventListener("contextmenu", e => {
  const node = e.target.closest(".card");
  const svgHit = e.target.closest && e.target.closest("#linesvg g");
  if (svgHit) {
    e.preventDefault();
    ctxMenu(e.clientX, e.clientY, svgHit.dataset.id, "line");
    return;
  }
  if (!node) {
    e.preventDefault();
    blankMenu(e.clientX, e.clientY);
    return;
  }
  e.preventDefault();
  const id = node.dataset.id;
  if (state.items.get(id)?.type === "line") return;
  if (!state.selection.has(id)) select(id);
  ctxMenu(e.clientX, e.clientY, id);
});

// -- tools (rail) --------------------------------------------------------------
function setTool(t) {
  if (state.tool === "line" && t !== "line") state.lineDraft = null;
  state.tool = t;
  stage.classList.toggle("tooling", !!t);
  for (const b of document.querySelectorAll("#rail [data-tool]"))
    b.classList.toggle("armed", b.dataset.tool === t);
}

// Create a tool's block at world coords (cx, cy) — the point that should
// become the card's vertical center. Used by rail click (viewport center,
// cascading) and rail drag-drop (drop point). Line gets a default horizontal
// arrow when dragged in; image/file open the picker since nothing sensible
// exists without a file.
async function createToolAt(type, cx, cy) {
  if (type === "image" || type === "file") {
    await uploadThenCreate(type, cx - 60, cy - 60);
    return;
  }
  if (type === "line") {
    await createAt("line", cx, cy, {
      data: { from: { x: cx, y: cy }, to: { x: cx + 240, y: cy },
              arrow: "end", dashed: false, label: "", text: "" },
      w: 1,
    });
    return;
  }
  const w = DEFAULT_W[type] || 240;
  await createAt(type, cx - w / 2, cy - 40);
}

// Rail: single click creates the block on the canvas (Line is the one
// exception — it arms the tool because it needs two points); every rail
// button is draggable onto the canvas to place the block exactly there.
// The drag ghost is the actual block markup, not the rail button.
let railCascade = 0;

// A detached, off-screen card to use as the drag image — the same DOM the
// real card gets, so the ghost is the block itself (empty note body, link
// input row, board tile, column cap, …).
function railDragGhost(type) {
  if (type === "line") {
    // A straight 45° arrow line, like what lands on the canvas — never a card.
    const div = document.createElement("div");
    div.innerHTML = '<svg width="96" height="96" viewBox="0 0 96 96" aria-hidden="true">'
      + '<path d="M10 86 L78 18" fill="none" stroke="var(--ink-soft)" stroke-width="2.5" stroke-linecap="round"/>'
      + '<path d="M78 18 L66 20 M78 18 L76 30" fill="none" stroke="var(--ink-soft)" stroke-width="2.5" stroke-linecap="round"/>'
      + '</svg>';
    div.style.cssText = "position:fixed;left:-10000px;top:0;pointer-events:none;opacity:.9";
    return div;
  }
  const it = { id: "drag-preview", canvasId: state.canvas.id, parentItemId: null,
    type, x: 0, y: 0, w: DEFAULT_W[type] || 240, h: null, z: 0, color: null,
    data: createBody(type), createdAt: 0 };
  if (type === "board") { it._childTitle = "Untitled board"; it._childCount = 0; it._childColor = "slate"; it._childIcon = "layout-grid"; }
  if (type === "shortcut") { it._target = null; }
  const node = buildCard(it);
  node.style.position = "fixed";
  node.style.left = "-10000px";
  node.style.top = "0";
  node.style.pointerEvents = "none";
  node.style.opacity = "0.9";
  return node;
}

document.querySelectorAll("#rail [data-tool]").forEach(b => {
  b.draggable = true;
  b.addEventListener("dragstart", e => {
    const type = b.dataset.tool;
    e.dataTransfer.setData("application/x-milaclone-tool", type);
    e.dataTransfer.effectAllowed = "copy";
    const ghost = railDragGhost(type);
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, 26);
    b.addEventListener("dragend", () => ghost.remove(), { once: true });
  });
  b.addEventListener("click", () => {
    const type = b.dataset.tool;
    if (type === "line") return setTool(state.tool === "line" ? null : "line");
    const r = stageRect();
    const c = toWorld(r.left + r.width / 2, r.top + r.height / 2);
    railCascade = (railCascade + 1) % 6;
    createToolAt(type, c.x + railCascade * 36, c.y + railCascade * 28);
  });
});

$("trashBtn").addEventListener("click", openTrash);
$("searchBtn").addEventListener("click", openSearch);
$("upBtn").addEventListener("click", goUp);
$("vaultBtn").addEventListener("click", openVaultDialog);

// -- context menu -----------------------------------------------------------------
function ctxMenu(px, py, id, kind) {
  const it = state.items.get(id);
  if (!it) return;
  const items = [];
  if (kind === "line") {
    for (const [name, val] of [["Arrow →", "end"], ["Arrow ↔", "both"], ["No arrow", "none"]])
      items.push({ html: name, hot: false, action: () => { it.data.arrow = val; updateItem(it); } });
    items.push({ html: (it.data.dashed ? "✓ " : "") + "Dashed",
      action: () => { it.data.dashed = !it.data.dashed; updateItem(it); } });
    items.push({ html: (it.data.label ? "✓ " : "") + "Label…",
      action: () => promptDialog("Line label", it.data.label || "", v => {
        it.data.label = v; it.data.text = v; updateItem(it);
      }) });
    items.push({ sep: true });
    items.push({ html: "Delete line", hot: true, action: async () => {
      await captureUndo();
      await api("trashDeep", id);
      await reloadCurrent();
    } });
  } else {
    items.push({ html: "Edit", action: () => {
      if (it.type === "note" || it.type === "comment" || it.type === "heading") enterEdit(id, "body");
      else if (it.type === "todo") enterEdit(id, "task", 0);
      else if (it.type === "link") editLink(it);
      else if (it.type === "document") openDocument(it);
      else enterEdit(id, "field");
    } });
    items.push({ html: "Duplicate", action: async () => {
      const newId = await api("copyDeep", id, state.canvas.id, it.x + 30, it.y + 30);
      await reloadCurrent();
      const copy = state.items.get(newId);
      if (copy && isRootMedia(copy)) await autoArrangeMedia(newId);
    } });
    items.push({ sep: true });
    const pal = document.createElement("div");
    pal.className = "mgroup";
    const row = document.createElement("div");
    row.style.cssText = "display:flex;flex-wrap:wrap;gap:5px;padding:6px 10px";
    for (const c of ["none", ...COLORS]) {
      const sw = document.createElement("button");
      sw.className = "sw";
      sw.title = c;
      sw.style.cssText =
        `width:18px;height:18px;border-radius:0;border:1px solid var(--rail-border);cursor:pointer;` +
        (c === "none" ? "background:repeating-linear-gradient(45deg,#fff,#fff 3px,#eee 3px,#eee 6px)" : `background:var(--c-${c})`);
      sw.addEventListener("click", () => {
        it.color = c === "none" ? null : c;
        if (it.type === "board") it._childColor = it.color || "slate";
        updateItem(it);
        refreshItem(it);
        hideCtx();
      });
      row.appendChild(sw);
    }
    items.push({ el: [pal, row] });
    items.push({ sep: true });
    items.push({ html: "Labels…", action: () => labelsDialog(id) });
    items.push({ html: "Bring to front", action: async () => {
      it.z = (await api("payload", [state.canvas.id])).items
        .reduce((m, i) => Math.max(m, i.z || 0), 0) + 1;
      updateItem(it);
      refreshItem(it);
    } });
    const imgCount = selectedItems().filter(isRootMedia).length;
    if (imgCount >= 2) items.push({ html: "Arrange as grid (Ctrl+G)", action: () => arrangeAsGrid() });
    items.push({ sep: true });
    items.push({ html: "Delete", hot: true, action: deleteSelection });
  }
  showMenu(px, py, items);
}

function blankMenu(px, py) {
  const p = toWorld(px, py);
  const items = ["note", "heading", "todo", "link", "board", "column", "comment", "document", "table"].map(t =>
    ({ html: t[0].toUpperCase() + t.slice(1), action: () => createAt(t, p.x - 120, p.y - 40) }));
  items.push({ sep: true });
  items.push({ html: "Paste", action: pasteClipboard, disabled: !clipboard });
  items.push({ html: "Select all", action: selectAll });
  showMenu(px, py, items);
}

function showMenu(px, py, items) {
  ctxEl.textContent = "";
  for (const item of items) {
    if (item.sep) {
      const s = document.createElement("div");
      s.className = "msep";
      ctxEl.appendChild(s);
      continue;
    }
    if (item.el) {
      for (const el of item.el) ctxEl.appendChild(el);
      continue;
    }
    const mi = document.createElement("div");
    mi.className = "mi" + (item.hot ? " hot" : "") + (item.disabled ? " disabled" : "");
    mi.textContent = item.html;
    if (item.disabled) mi.style.opacity = ".45";
    mi.addEventListener("click", () => { hideCtx(); if (!item.disabled) item.action(); });
    ctxEl.appendChild(mi);
  }
  ctxEl.classList.remove("hidden");
  const r = ctxEl.getBoundingClientRect();
  ctxEl.style.left = Math.min(px, window.innerWidth - r.width - 8) + "px";
  ctxEl.style.top = Math.min(py, window.innerHeight - r.height - 8) + "px";
}

// -- clipboard (internal copy/cut/paste via copyDeep/moveDeep) ----------------
let clipboard = null; // { ids: [], move }

// Ctrl/Cmd+D: duplicate selection, placed to the right of the selection's
// bounding box, preserving the internal layout.
async function duplicateSelectionRight() {
  return userAction(async () => {
  const roots = selectedItems();
  if (!roots.length) return;
  const boxes = roots.map(it => ({ x: it.x, y: it.y, w: it.w || 240, h: cardHeight(it) }));
  const leftEdge = Math.min(...boxes.map(b => b.x));
  const rightEdge = Math.max(...boxes.map(b => b.x + b.w));
  const GAP = 48; // snap-friendly gap to the right of the selection
  const dx = rightEdge + GAP - leftEdge;
  const newIds = [];
  for (const it of roots) {
    const newId = await api("copyDeep", it.id, state.canvas.id, Math.round(it.x + dx), Math.round(it.y));
    if (newId) newIds.push(newId);
  }
  if (!newIds.length) return;
  await reloadCurrent();
  state.selection = new Set(newIds);
  state.selectedId = newIds[newIds.length - 1];
  paintSelection();

  });
}

async function copySelection(move) {
  const roots = selectedItems();
  if (!roots.length) return;
  const ids = roots.map(i => i.id);
  clipboard = { ids, move };
  // cut marks: grayscale/translucent until paste or cancel
  state.cutIds = move ? new Set(ids) : new Set();
  paintSelection();
  const n = ids.length;
  showSnackbar(move
    ? `Cut ${n} card${n === 1 ? "" : "s"} — Paste to move`
    : `Copied ${n} card${n === 1 ? "" : "s"}`, null, null);
}

async function pasteClipboard() {
  return userAction(async () => {
  if (!clipboard) return;
  const p = toWorld(window.innerWidth / 2, window.innerHeight / 2);
  const { ids, move } = clipboard;
  const OFFSET = 28; // stair cascade so cards don't overlap exactly
  if (move) {
    clipboard = null;
    for (let k = 0; k < ids.length; k++)
      await api("moveDeep", ids[k], state.canvas.id, Math.round(p.x + k * OFFSET), Math.round(p.y + k * OFFSET));
  } else {
    clipboard = null;
    const newIds = [];
    for (let k = 0; k < ids.length; k++) {
      const newId = await api("copyDeep", ids[k], state.canvas.id,
        Math.round(p.x + k * OFFSET), Math.round(p.y + k * OFFSET));
      if (newId) newIds.push(newId);
    }
    if (newIds.length) {
      state.selection = new Set(newIds);
      state.selectedId = newIds[newIds.length - 1];
      paintSelection();
      const last = state.items.get(newIds[newIds.length - 1]);
      if (last && isRootMedia(last)) await autoArrangeMedia(newIds[newIds.length - 1]);
      await reloadCurrent();
      state.selection = new Set(newIds);
      state.selectedId = newIds[newIds.length - 1];
      paintSelection();
      return;
    }
  }
  state.cutIds = new Set();
  await reloadCurrent();
  state.selection = new Set(ids);
  state.selectedId = ids[ids.length - 1];
  paintSelection();

  });
}

// -- snackbar --------------------------------------------------------------------
let snackTimer = null;
function showSnackbar(text, actionLabel, action) {
  const bar = $("snackbar");
  $("snack-text").textContent = text;
  const btn = bar.querySelector("button");
  if (btn) btn.remove();
  if (actionLabel) {
    const b = document.createElement("button");
    b.textContent = actionLabel;
    b.addEventListener("click", () => { bar.classList.add("hidden"); action(); });
    bar.appendChild(b);
  }
  bar.classList.remove("hidden");
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => bar.classList.add("hidden"), 5000);
}
const toast = t => showSnackbar(t, null, null);

// -- vaults ---------------------------------------------------------------------
let vaultSelectedId = null;

async function openVaultDialog() {
  const el = $("vaultDialog");
  const list = $("vaultList");
  const data = await window.mila.vaultList();
  list.textContent = "";
  vaultSelectedId = data.currentId;
  for (const v of data.vaults) {
    const row = document.createElement("div");
    row.className = "vr" + (v.id === data.currentId ? " active" : "");
    row.dataset.id = v.id;
    const name = document.createElement("span");
    name.textContent = v.name;
    row.appendChild(name);
    if (v.id === data.currentId) {
      const cur = document.createElement("span");
      cur.className = "vcur";
      cur.textContent = "open";
      row.appendChild(cur);
    }
    row.addEventListener("click", () => {
      list.querySelectorAll(".vr").forEach(r => r.classList.remove("sel"));
      row.classList.add("sel");
      vaultSelectedId = v.id;
    });
    row.addEventListener("dblclick", async () => {
      if (v.id !== data.currentId) { el.close(); await window.mila.vaultOpen(v.id); }
    });
    list.appendChild(row);
  }
  el.showModal();
}

$("vaultCreate").addEventListener("click", async () => {
  const name = $("vaultNewName").value.trim();
  if (!name) return;
  const v = await window.mila.vaultCreate(name);
  $("vaultNewName").value = "";
  $("vaultDialog").close();
  await window.mila.vaultOpen(v.id); // switches + reloads into the new vault
});
$("vaultRename").addEventListener("click", async () => {
  if (!vaultSelectedId) return showSnackbar("Select a vault first", null, null);
  const name = $("vaultNewName").value.trim();
  if (!name) return;
  await window.mila.vaultRename({ id: vaultSelectedId, name });
  $("vaultNewName").value = "";
  $("vaultDialog").close();
  openVaultDialog();
});
$("vaultReveal").addEventListener("click", () => {
  if (vaultSelectedId) window.mila.vaultReveal(vaultSelectedId);
});
$("vaultClose").addEventListener("click", () => $("vaultDialog").close());

// -- image viewer --------------------------------------------------------------
// Double-click an image card: gray translucent overlay, image centered,
// ←/→ move through the images on the canvas.
function imageViewerList() {
  return [...state.items.values()]
    .filter(it => it.type === "image")
    .sort((a, b) => (a.y - b.y) || (a.x - b.x) || ((a.z || 0) - (b.z || 0)));
}
let imgIndex = -1;

function showImage(id) {
  const list = imageViewerList();
  const idx = list.findIndex(it => it.id === id);
  if (idx < 0) return;
  imgIndex = idx;
  const it = list[idx];
  const d = it.data || {};
  $("imgFull").src = "milafile://m/" + encodePath(d.src || "");
  $("imgFull").alt = d.caption || d.name || "";
  $("imgCount").textContent = `${idx + 1} / ${list.length}`;
  $("imgCaption").textContent = d.caption || "";
  $("imageDialog").showModal();
}

function stepImage(dir) {
  const list = imageViewerList();
  if (!list.length) return;
  if (imgIndex < 0) imgIndex = 0;
  else imgIndex = (imgIndex + dir + list.length) % list.length;
  showImage(list[imgIndex].id);
}

function closeImageViewer() {
  const el = $("imageDialog");
  if (el.open) el.close();
  imgIndex = -1;
}

$("imgClose").addEventListener("click", closeImageViewer);
$("imgPrev").addEventListener("click", () => stepImage(-1));
$("imgNext").addEventListener("click", () => stepImage(1));
$("imageDialog").addEventListener("click", e => {
  if (e.target === e.currentTarget || e.target === $("imgFull")) closeImageViewer();
});
window.addEventListener("keydown", e => {
  if (!$("imageDialog").open) return;
  if (e.key === "ArrowLeft") { e.preventDefault(); e.stopImmediatePropagation(); stepImage(-1); }
  else if (e.key === "ArrowRight") { e.preventDefault(); e.stopImmediatePropagation(); stepImage(1); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); closeImageViewer(); }
}, true);

// -- dialogs -----------------------------------------------------------------------
function editLink(it) {
  enterEdit(it.id, "linkurl");
}

function promptDialog(title, initial, cb) {  const el = $("promptDialog");
  $("promptTitle").textContent = title;
  $("promptBox").value = initial;
  el.showModal();
  $("promptBox").focus();
  $("promptOk").onclick = () => { el.close(); cb($("promptBox").value.trim()); };
  $("promptCancel").onclick = () => el.close();
  $("promptBox").onkeydown = e => {
    if (e.key === "Enter") { e.preventDefault(); $("promptOk").click(); }
  };
}

function labelsDialog(id) {
  const it = state.items.get(id);
  const el = $("labelsDialog");
  const cur = ((it.data.labels) || []).map(l => l.name || l).join(", ");
  $("labelsBox").value = cur;
  el.showModal();
  $("labelsSave").onclick = () => {
    const names = $("labelsBox").value.split(",").map(s => s.trim()).filter(Boolean).slice(0, 12);
    it.data.labels = names.map(n => ({ name: n }));
    updateItem(it);
    refreshItem(it);
    el.close();
  };
  $("labelsClear").onclick = () => {
    it.data.labels = [];
    updateItem(it);
    refreshItem(it);
    el.close();
  };
}

function openDocument(it) {
  const el = $("docDialog");
  const d = it.data;
  const setTitle = t => {
    d.title = t.slice(0, 200);
    it.data.title = d.title;
  };
  $("docTitle").textContent = d.title || "Untitled document";
  $("docBody").innerHTML = docToHtml(d.doc || docFromText(d.text || "")) || "<p></p>";
  $("docTitle").oninput = () => { setTitle($("docTitle").textContent.trim()); updateItem(it); refreshItem(it); };
  $("docBody").oninput = () => {
    d.text = $("docBody").innerText;
    d.doc = docFromText(d.text);
    updateItem(it);
    const words = (d.text.match(/\S+/g) || []).length;
    $("docCount").textContent = words ? `${words} words` : "";
  };
  el.showModal();
  const initWords = ((d.text || "").match(/\S+/g) || []).length;
  $("docCount").textContent = initWords ? `${initWords} words` : "";
  setTimeout(() => $("docBody").focus(), 50);
}

// -- trash -------------------------------------------------------------------------
async function openTrash() {
  const el = $("trashDialog");
  const list = $("trashList");
  list.textContent = "";
  let sel = null;
  const roots = await api("trashRoots");
  for (const r of roots) {
    const row = document.createElement("div");
    row.className = "tr";
    row.dataset.id = r.id;
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = (r.data && (r.data.title || r.data.text || r.data.name || r.data.hex)) ||
      (r.type === "board" ? (r._childTitle || "Board") : r.type);
    const ty = document.createElement("span");
    ty.className = "ty";
    ty.textContent = r.type;
    row.append(nm, ty);
    row.addEventListener("click", () => {
      list.querySelectorAll(".tr.sel").forEach(x => x.classList.remove("sel"));
      row.classList.add("sel");
      sel = r.id;
    });
    list.appendChild(row);
  }
  $("trashRestore").onclick = async () => {
    if (sel) { await api("restore", sel); await reloadCurrent(); openTrash(); }
  };
  $("trashEmpty").onclick = async () => {
    await api("emptyTrash");
    await reloadCurrent();
    el.close();
  };
  el.showModal();
}

// -- search ---------------------------------------------------------------------------
async function openSearch() {
  const el = $("searchDialog");
  const box = $("searchBox");
  const res = $("searchResults");
  res.textContent = "";
  box.value = "";
  el.showModal();
  box.focus();
  box.oninput = async () => {
    const q = box.value.trim();
    if (!q) { res.textContent = ""; return; }
    const hits = await api("search", q);
    res.textContent = "";
    for (const h of hits.slice(0, 30)) {
      const row = document.createElement("div");
      row.className = "sr";
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = h.title || "(untitled)";
      const p = document.createElement("span");
      p.className = "p";
      p.textContent = (h.path || []).join(" / ");
      const k = document.createElement("span");
      k.className = "k";
      k.textContent = h.kind === "board" ? "board" : h.type || "";
      row.append(k, t, p);
      row.addEventListener("click", async () => {
        el.close();
        await openCanvas(h.canvasId);
        if (h.id) {
          // A hit inside a collapsed column can't be measured — expand it first
          let it = state.items.get(h.id);
          for (let col = it && it.parentItemId ? state.items.get(it.parentItemId) : null;
               col; col = col.parentItemId ? state.items.get(col.parentItemId) : null) {
            if (col.data && col.data.collapsed) {
              col.data.collapsed = false;
              await updateItem(col);
              await reloadCurrent();
              it = state.items.get(h.id);
            }
          }
          select(h.id);
          let node = state.nodes.get(h.id);
          if (node) {
            const r = node.getBoundingClientRect();
            const st = stageRect();
            const wx = (r.left - st.left - state.cam.x) / state.cam.z + (r.width / state.cam.z) / 2;
            const wy = (r.top - st.top - state.cam.y) / state.cam.z + (r.height / state.cam.z) / 2;
            state.cam.x = window.innerWidth / 2 - wx * state.cam.z;
            state.cam.y = window.innerHeight / 2 - wy * state.cam.z;
            applyCam();
          }
        }
      });
      res.appendChild(row);
    }
  };
}

// -- keyboard ---------------------------------------------------------------------------
window.addEventListener("keydown", async e => {
    if (e.key === " " && !state.editing &&
      !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName) &&
      !document.activeElement.isContentEditable) {
    state.space = true;
    stage.style.cursor = "grab";
    e.preventDefault();
    return;
  }
  if (state.editing) return;
  if (Date.now() - (state.editJustEnded || 0) < 120) return; // key that just committed an edit
  const tag = document.activeElement.tagName;
  if (/^(INPUT|TEXTAREA)$/.test(tag) || document.activeElement.isContentEditable) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
    e.preventDefault();
    selectAll();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && e.shiftKey) {
    e.preventDefault();
    performRedo();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    performUndo();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
    e.preventDefault();
    performRedo();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
    copySelection(false);
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
    e.preventDefault();
    duplicateSelectionRight();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "x") {
    copySelection(true);
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
    pasteClipboard();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    openSearch();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g") {
    e.preventDefault();
    arrangeAsGrid();
  } else if (e.key === "Delete" || e.key === "Backspace") {
    if (state.selection.size) { e.preventDefault(); deleteSelection(); }
    else if (state.selectedLine) {
      e.preventDefault();
      const id = state.selectedLine;
      state.selectedLine = null;
      captureUndo().then(() => api("trashDeep", id)).then(reloadCurrent);
    }
  } else if (e.key === "Escape") {
    if (clipboard) { clipboard = null; state.cutIds = new Set(); paintSelection(); }
    if (state.tool) setTool(null);
    else if (state.selectedLine) { state.selectedLine = null; drawLines(); paintSelection(); }
    else select(null);
  } else if (e.altKey && e.key === "ArrowUp") {
    e.preventDefault();
    goUp();
  } else if (e.key.startsWith("Arrow") && state.selection.size) {
    e.preventDefault();
    const dx = { ArrowLeft: -GRID, ArrowRight: GRID, ArrowUp: 0, ArrowDown: 0 }[e.key];
    const dy = { ArrowUp: -GRID, ArrowDown: GRID, ArrowLeft: 0, ArrowRight: 0 }[e.key];
    for (const it of selectedItems()) {
      it.x += dx; it.y += dy;
      if ((it.type === "image" || it.type === "file") && !it.parentItemId && !it.data.pin) it.data.pin = true;
      const n = state.nodes.get(it.id);
      if (n) { n.style.left = it.x + "px"; n.style.top = it.y + "px"; }
    }
    drawLines();
    updateItems(selectedItems());
    for (const it of selectedItems()) if (it.data.pin) await updateItem(it);
  } else if (e.key === "Enter" && state.selectedId && !state.selection.size) {
    const it = state.items.get(state.selectedId);
    if (it) {
      if (it.type === "note" || it.type === "comment" || it.type === "heading") enterEdit(it.id, "body");
      else if (it.type === "todo") enterEdit(it.id, "task", 0);
      else if (it.type === "document") openDocument(it);
      else enterEdit(it.id, "field");
    }
  } else if (e.key === "Enter" && state.selection.size) {
    deleteSelection();
  }
});
window.addEventListener("keyup", e => {
  if (e.key === " ") {
    state.space = false;
    if (!state.editing) stage.style.cursor = "";
  }
});

// -- navigation --------------------------------------------------------------------------
async function openCanvas(cid) {
  await commitEditIfAny();
  const payload = await api("payload", cid);
  if (!payload) return;
  load(payload);
  state.cam = { x: 140, y: 100, z: 1 };
  applyCam();
}
async function goUp() {
  if (state.canvas.parentCanvasId) await openCanvas(state.canvas.parentCanvasId);
  else toast("Already at the top board");
}
async function commitEditIfAny() {
  if (state.editing) commitEdit();
}

// -- load/boot ---------------------------------------------------------------------------
function crumb() {
  const trail = (state.breadcrumb || []);
  crumbEl.innerHTML = trail.map((c, i) =>
    `<span data-cid="${c.id}" class="${i === trail.length - 1 ? "here" : "jump"}">${esc(c.title || "Board")}</span>`
  ).join('<span style="opacity:.5"> / </span>');
  crumbEl.querySelectorAll(".jump").forEach(el =>
    el.addEventListener("click", () => openCanvas(el.dataset.cid)));
}

function load(payload) {
  state.canvas = payload.canvas;
  state.rootId = payload.rootCanvasId;
  state.breadcrumb = payload.breadcrumb;
  state.items = new Map(payload.items.map(it => [it.id, it]));
  state.selection.clear();
  state.selectedId = null;
  state.selectedLine = null;
  state.lineDrag = null;
  state.editing = null;
  render();
  crumb();
}

async function boot() {
  const rootId = await api("rootCanvasId");
  const payload = await api("payload", rootId);
  load(payload);
  const v = await window.mila.vaultCurrent();
  if (v) {
    $("vaultBtn").textContent = "Vault: " + v.name;
    document.title = `Milaclone — ${v.name}`;
  }
}

// test driver hook -----------------------------------------------------------------------
window.__mila = {
  state,
  createAt, enterEdit, commitEdit, select, deleteSelection, openCanvas, goUp,
  refreshItem, setTool, showSnackbar, openDocument, labelsDialog, reloadCurrent,
  arrangeAsGrid, duplicateSelectionRight,
};

// OS file drag/drop -> upload via main (copies into uploads dir) -> create cards.
// Type decided by mime: images become "image" cards, everything else "file".
const onFilesDrop = async e => {
  e.preventDefault();
  // Rail tool dragged onto the canvas → create that block at the drop point
  const tool = e.dataTransfer ? e.dataTransfer.getData("application/x-milaclone-tool") : "";
  if (tool) {
    const p = toWorld(e.clientX, e.clientY);
    createToolAt(tool, p.x, p.y);
    return;
  }
  const files = [...(e.dataTransfer ? e.dataTransfer.files : [])];
  if (!files.length) return;
  const p = toWorld(e.clientX, e.clientY);
  mediaBatchDepth++;
  try {
    let n = 0;
    for (const f of files) {
      const type = String(f.type || "").startsWith("image/") ? "image" : "file";
      const fp = f.path || window.mila.getPathForFile(f);
      const ups = await window.mila.uploadFiles([fp]);
      const u = ups && ups[0];
      if (!u) continue;
      await createAt(type, p.x, p.y + n * 120, { data: { src: u.src, name: u.name, mime: u.mime } });
      n++;
    }
    return n;
  } finally {
    mediaBatchDepth--;
    if (mediaBatchDepth === 0 && mediaBatchNewIds.length) {
      const ids = mediaBatchNewIds; mediaBatchNewIds = [];
      await autoArrangeMedia(ids);
    }
  }
};

document.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "drop"; });
document.addEventListener("drop", onFilesDrop);

boot();
