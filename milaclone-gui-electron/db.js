"use strict";
// Storage: port of milaclone's db.js + export-md.js behind Electron IPC.
// Same SQLite schema and JSON data blobs as the web app, so a board.db made by
// either the server version or the Qt desktop port opens here (and vice versa).

const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const RICH_TYPES = new Set(["note", "comment", "heading"]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS canvases (
  id TEXT PRIMARY KEY, title TEXT, parentCanvasId TEXT, color TEXT, createdAt INTEGER,
  icon TEXT, trashedBy TEXT, trashedAt INTEGER
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, canvasId TEXT NOT NULL, parentItemId TEXT, type TEXT,
  x INTEGER, y INTEGER, w INTEGER, h INTEGER, z INTEGER, color TEXT,
  data TEXT, createdAt INTEGER, trashedBy TEXT, trashedAt INTEGER
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS idx_items_canvas ON items(canvasId);
CREATE INDEX IF NOT EXISTS idx_items_parent ON items(parentItemId);
`;

const id = (p = "i_") => p + crypto.randomBytes(9).toString("base64url");
const now = () => Date.now();

function docText(n) {
  if (n.type === "text") return n.text || "";
  return (n.content || []).map(docText).join(n.type === "doc" ? "\n" : "");
}

// db.js toRich: notes/comments keep doc (TipTap JSON) + text (plain).
function toRich(data) {
  if (data.doc) {
    return typeof data.text === "string" ? data : { ...data, text: docText(data.doc).trim() };
  }
  const { title, body, ...rest } = data;
  const text = String(body ?? rest.text ?? "");
  const content = [];
  if (title) content.push({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: String(title) }] });
  if (text || !content.length) content.push(...text.split("\n").map(l => ({
    type: "paragraph", content: l ? [{ type: "text", text: l }] : [],
  })));
  return { ...rest, doc: { type: "doc", content }, text: [title, text].filter(Boolean).join("\n") };
}

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.uploadDir = path.join(dataDir, "uploads");
    fs.mkdirSync(this.uploadDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "board.db"));
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(SCHEMA);
    if (!this.db.prepare("SELECT value FROM meta WHERE key='rootCanvasId'").get()) {
      const rootId = id("c_");
      this.db.exec("BEGIN");
      this.db.prepare("INSERT INTO canvases (id,title,parentCanvasId,color,createdAt) VALUES (?,?,?,?,?)")
        .run(rootId, "Home", null, "slate", now());
      this.db.prepare("INSERT INTO meta (key,value) VALUES ('rootCanvasId',?)").run(rootId);
      this.db.exec("COMMIT");
    }
  }

  close() { this.db.close(); }

  // -- rows -----------------------------------------------------------------
  static item(row) {
    return row && { ...row, data: row.data ? JSON.parse(row.data) : {} };
  }

  getCanvas(cid, allowTrashed = false) {
    const c = this.db.prepare("SELECT * FROM canvases WHERE id=?").get(cid);
    return c && (allowTrashed || !c.trashedBy) ? c : null;
  }

  getItem(iid, allowTrashed = false) {
    return Store.item((() => {
      const r = this.db.prepare("SELECT * FROM items WHERE id=?").get(iid);
      return r && (allowTrashed || !r.trashedBy) ? r : null;
    })());
  }

  itemsForCanvas(cid) {
    return this.db.prepare(
      "SELECT * FROM items WHERE canvasId=? AND trashedBy IS NULL ORDER BY COALESCE(z,0), createdAt, id"
    ).all(cid).map(Store.item);
  }

  maxZ() {
    const r = this.db.prepare("SELECT MAX(z) AS m FROM items").get();
    return Math.max(0, r.m || 0);
  }

  breadcrumb(cid) {
    const trail = [];
    let cur = this.getCanvas(cid);
    for (let guard = 0; cur && guard < 100; guard++) {
      trail.unshift({ id: cur.id, title: cur.title });
      cur = cur.parentCanvasId ? this.getCanvas(cur.parentCanvasId) : null;
    }
    return trail;
  }

  // GET /api/canvas/:id payload: board cards read title/count from child canvas.
  payload(cid) {
    const canvas = this.getCanvas(cid);
    if (!canvas) return null;
    const items = this.itemsForCanvas(cid).map(it => {
      const d = it.data || {};
      if (it.type === "board" && d.childCanvasId) {
        const child = this.getCanvas(d.childCanvasId);
        const count = this.db.prepare(
          "SELECT COUNT(*) c FROM items WHERE canvasId=? AND parentItemId IS NULL AND trashedBy IS NULL"
        ).get(d.childCanvasId).c;
        return { ...it, _childTitle: child ? child.title : "Board", _childCount: count,
                 _childColor: child ? child.color : "slate", _childIcon: (child && child.icon) || "layout-grid" };
      }
      if (it.type === "shortcut") {
        const t = this.getCanvas(d.targetCanvasId);
        return { ...it, _target: t ? { title: t.title, color: t.color, icon: t.icon || "layout-grid" } : null };
      }
      return it;
    });
    return { canvas, items, breadcrumb: this.breadcrumb(cid), rootCanvasId: this.rootCanvasId() };
  }

  rootCanvasId() {
    const r = this.db.prepare("SELECT value FROM meta WHERE key='rootCanvasId'").get();
    return r ? r.value : null;
  }

  // -- writes ---------------------------------------------------------------
  createItem(b) {
    const it = {
      id: id("i_"), canvasId: b.canvasId, parentItemId: b.parentItemId || null,
      type: b.type || "note", x: Math.round(b.x || 60), y: Math.round(b.y || 60),
      w: Math.round(b.w || 240), h: b.h != null ? Math.round(b.h) : null,
      z: this.maxZ() + 1, color: b.color || null, data: b.data || {}, createdAt: now(),
    };
    if (RICH_TYPES.has(it.type)) it.data = toRich(it.data);
    const ins = this.db.prepare(
      "INSERT INTO items (id,canvasId,parentItemId,type,x,y,w,h,z,color,data,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
    if (it.type === "board") {
      const childId = id("c_");
      this.db.exec("BEGIN");
      this.db.prepare("INSERT INTO canvases (id,title,parentCanvasId,color,icon,createdAt) VALUES (?,?,?,?,?,?)")
        .run(childId, it.data.title || "Untitled board", it.canvasId, it.color || "slate", it.data.icon || null, it.createdAt);
      it.data = { childCanvasId: childId };
      ins.run(it.id, it.canvasId, it.parentItemId, it.type, it.x, it.y, it.w, it.h, it.z,
              it.color, JSON.stringify(it.data), it.createdAt);
      this.db.exec("COMMIT");
      const child = this.getCanvas(childId);
      Object.assign(it, { _childTitle: child.title, _childCount: 0, _childColor: child.color, _childIcon: child.icon || "layout-grid" });
    } else {
      ins.run(it.id, it.canvasId, it.parentItemId, it.type, it.x, it.y, it.w, it.h, it.z,
              it.color, JSON.stringify(it.data), it.createdAt);
    }
    return it;
  }

  updateCanvas(cid, fields) {
    const c = this.getCanvas(cid, true);
    if (!c) return null;
    for (const k of ["title", "color", "icon"]) {
      if (typeof fields[k] === "string") c[k] = String(fields[k]).slice(0, k === "title" ? 200 : 100);
    }
    this.db.prepare("UPDATE canvases SET title=?,color=?,icon=? WHERE id=?")
      .run(c.title, c.color, c.icon, cid);
    return c;
  }

  // PATCH /api/item: board title/icon live on the child canvas; card reads them there.
  updateItem(it) {
    this.db.prepare(
      "UPDATE items SET canvasId=?,parentItemId=?,type=?,x=?,y=?,w=?,h=?,z=?,color=?,data=? WHERE id=?"
    ).run(it.canvasId, it.parentItemId, it.type, Math.round(it.x || 0), Math.round(it.y || 0),
          Math.round(it.w || 0), it.h != null ? Math.round(it.h) : null, it.z, it.color,
          JSON.stringify(it.data), it.id);
    if (it.type === "board" && it.data.childCanvasId) {
      const c = this.getCanvas(it.data.childCanvasId, true);
      if (c && (it.data.title != null || it.data.icon != null)) {
        if (it.data.title != null) c.title = String(it.data.title).slice(0, 200);
        if (it.data.icon != null) c.icon = String(it.data.icon);
        this.db.prepare("UPDATE canvases SET title=?,icon=?,color=? WHERE id=?")
          .run(c.title, c.icon, it.color || "slate", c.id);
        delete it.data.title;
        delete it.data.icon;
        this.db.prepare("UPDATE items SET data=? WHERE id=?").run(JSON.stringify(it.data), it.id);
      } else if (c) {
        this.db.prepare("UPDATE canvases SET color=? WHERE id=?").run(it.color || "slate", c.id);
      }
    }
  }

  updateItems(updates) {
    this.db.exec("BEGIN");
    for (const u of updates) {
      // Omitted fields keep their stored values (COALESCE); an explicit
      // parentItemId:null detaches the card from its column.
      const hasParent = Object.prototype.hasOwnProperty.call(u, "parentItemId");
      const sql = "UPDATE items SET x=COALESCE(?,x),y=COALESCE(?,y),w=COALESCE(?,w),h=COALESCE(?,h),z=COALESCE(?,z)"
        + (hasParent ? ",parentItemId=?" : "") + " WHERE id=?";
      const args = [u.x != null ? Math.round(u.x) : null,
                    u.y != null ? Math.round(u.y) : null,
                    u.w != null ? Math.round(u.w) : null,
                    u.h != null ? Math.round(u.h) : null,
                    u.z != null ? u.z : null];
      if (hasParent) args.push(u.parentItemId != null ? u.parentItemId : null);
      args.push(u.id);
      this.db.prepare(sql).run(...args);
    }
    this.db.exec("COMMIT");
  }

  // Replace EVERY item on a canvas with the given array (used by undo/redo).
  // Round-trips the exact stored columns x,y,w,h,z,color,data,parentItemId.
  replaceItems(canvasId, items) {
    this.db.exec("BEGIN");
    try {
      const keep = new Set((items || []).map(i => i.id));
      for (const row of this.db.prepare("SELECT id FROM items WHERE canvasId=? AND trashedBy IS NULL").all(canvasId)) {
        if (!keep.has(row.id)) this.db.prepare("DELETE FROM items WHERE id=?").run(row.id);
      }
      for (const it of items || []) {
        this.db.prepare(
          `INSERT INTO items (id,canvasId,parentItemId,type,x,y,w,h,z,color,data,createdAt,trashedBy,trashedAt)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)
           ON CONFLICT(id) DO UPDATE SET
             canvasId=excluded.canvasId, parentItemId=excluded.parentItemId, type=excluded.type,
             x=excluded.x, y=excluded.y, w=excluded.w, h=excluded.h, z=excluded.z,
             color=excluded.color, data=excluded.data, createdAt=excluded.createdAt,
             trashedBy=NULL, trashedAt=NULL`)
          .run(it.id, canvasId, it.parentItemId || null, it.type || "note",
               Math.round(it.x || 0), Math.round(it.y || 0),
               it.w != null ? Math.round(it.w) : null,
               it.h != null ? Math.round(it.h) : null,
               it.z != null ? it.z : 0, it.color || null,
               JSON.stringify(it.data || {}), it.createdAt || Date.now());
      }
      this.db.exec("COMMIT");
      return true;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // -- trash ----------------------------------------------------------------
  collectSubtree(itemId) {
    const items = [], canvases = [];
    const seen = new Set();
    const addItem = row => {
      if (!row || seen.has(row.id)) return;
      seen.add(row.id);
      items.push(row);
      for (const k of this.db.prepare("SELECT * FROM items WHERE parentItemId=? AND trashedBy IS NULL").all(row.id)) {
        addItem(k);
      }
      const d = row.data ? JSON.parse(row.data) : {};
      if (row.type === "board" && d.childCanvasId) addCanvas(d.childCanvasId);
    };
    const addCanvas = cid => {
      const c = this.getCanvas(cid);
      if (!c || seen.has(cid)) return;
      seen.add(cid);
      canvases.push(c);
      for (const r of this.db.prepare(
        "SELECT * FROM items WHERE canvasId=? AND trashedBy IS NULL AND parentItemId IS NULL").all(cid)) {
        addItem(r);
      }
    };
    addItem(this.db.prepare("SELECT * FROM items WHERE id=?").get(itemId));
    const ids = JSON.stringify(items.map(r => r.id));
    for (const r of this.db.prepare(
      `SELECT * FROM items WHERE type='line' AND trashedBy IS NULL
       AND (json_extract(data,'$.from.id') IN (SELECT value FROM json_each(?))
         OR json_extract(data,'$.to.id') IN (SELECT value FROM json_each(?)))`).all(ids, ids)) {
      addItem(r);
    }
    return { items, canvases };
  }

  trashDeep(itemId) {
    const { items, canvases } = this.collectSubtree(itemId);
    const t = now();
    this.db.exec("BEGIN");
    for (const r of items) {
      this.db.prepare("UPDATE items SET trashedBy=?,trashedAt=? WHERE id=?").run(itemId, t, r.id);
    }
    for (const c of canvases) {
      this.db.prepare("UPDATE canvases SET trashedBy=?,trashedAt=? WHERE id=?").run(itemId, t, c.id);
    }
    this.db.exec("COMMIT");
    return items.length;
  }

  restore(itemId) {
    this.db.exec("BEGIN");
    const n = this.db.prepare("UPDATE items SET trashedBy=NULL,trashedAt=NULL WHERE trashedBy=?").run(itemId).changes
      + this.db.prepare("UPDATE canvases SET trashedBy=NULL,trashedAt=NULL WHERE trashedBy=?").run(itemId).changes;
    const row = this.getItem(itemId);
    // A card whose column was deleted separately comes back loose.
    if (row && row.parentItemId && !this.getItem(row.parentItemId)) {
      const col = this.getItem(row.parentItemId, true);
      this.db.prepare("UPDATE items SET parentItemId=NULL,x=?,y=? WHERE id=?")
        .run(col ? col.x : row.x, col ? col.y : row.y, itemId);
    }
    this.db.exec("COMMIT");
    return n;
  }

  trashRoots() {
    return this.db.prepare("SELECT * FROM items WHERE trashedBy=id ORDER BY trashedAt DESC, id")
      .all().map(Store.item);
  }

  emptyTrash() {
    const srcs = this.db.prepare(
      "SELECT DISTINCT json_extract(data,'$.src') src FROM items WHERE trashedBy IS NOT NULL AND json_extract(data,'$.src') IS NOT NULL"
    ).all().map(r => r.src);
    this.db.exec("BEGIN");
    this.db.prepare("DELETE FROM items WHERE trashedBy IS NOT NULL").run();
    this.db.prepare("DELETE FROM canvases WHERE trashedBy IS NOT NULL").run();
    this.db.exec("COMMIT");
    const orphanSrcs = [];
    for (const src of srcs) {
      if (!src) continue;
      const live = this.db.prepare("SELECT 1 FROM items WHERE json_extract(data,'$.src')=? LIMIT 1").get(src);
      if (!live) {
        orphanSrcs.push(src);
        try { fs.unlinkSync(path.join(this.uploadDir, path.basename(src))); } catch {}
      }
    }
    return orphanSrcs;
  }

  // -- deep copy / move -------------------------------------------------------
  #mapCopy(items, canvases) {
    const m = new Map();
    for (const r of items) m.set(r.id, id("i_"));
    for (const c of canvases) m.set(c.id, id("c_"));
    return m;
  }

  copyDeep(itemId, canvasId, x, y) {
    const { items, canvases } = this.collectSubtree(itemId);
    const m = this.#mapCopy(items, canvases);
    const insC = this.db.prepare("INSERT INTO canvases (id,title,parentCanvasId,color,icon,createdAt) VALUES (?,?,?,?,?,?)");
    const insI = this.db.prepare(
      "INSERT INTO items (id,canvasId,parentItemId,type,x,y,w,h,z,color,data,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
    this.db.exec("BEGIN");
    for (const c of canvases) {
      insC.run(m.get(c.id), c.title, m.get(c.parentCanvasId) || canvasId, c.color, c.icon, now());
    }
    let z = Math.max(0, this.maxZ());
    items.forEach((r, i) => {
      const d = r.data ? JSON.parse(r.data) : {};
      if (i && r.type === "line" && [d.from, d.to].some(e => e && e.id && !m.has(e.id))) return; // stranded
      if (d.childCanvasId) d.childCanvasId = m.get(d.childCanvasId);
      if (d.targetCanvasId && m.has(d.targetCanvasId)) d.targetCanvasId = m.get(d.targetCanvasId);
      for (const e of [d.from, d.to]) if (e && m.has(e.id)) e.id = m.get(e.id);
      const root = i === 0;
      // An explicitly duplicated column child stays in its column; a duplicated
      // root-level card (parentItemId null) lands at root level as before.
      insI.run(m.get(r.id), m.get(r.canvasId) || canvasId, root ? (r.parentItemId || null) : m.get(r.parentItemId) || r.parentItemId || null,
               r.type, root ? x : r.x, root ? y : r.y, r.w, r.h, root ? ++z : r.z, r.color, JSON.stringify(d), now());
    });
    this.db.exec("COMMIT");
    return m.get(itemId);
  }

  moveDeep(itemId, canvasId, x, y) {
    const { items, canvases } = this.collectSubtree(itemId);
    if (canvases.some(c => c.id === canvasId)) return false; // board inside itself
    const nested = new Set(canvases.map(c => c.id));
    const inside = new Set(items.map(r => r.id));
    this.db.exec("BEGIN");
    for (const r of items) {
      if (nested.has(r.canvasId)) continue; // lives on a nested canvas
      const d = r.data ? JSON.parse(r.data) : {};
      if (r.id !== itemId && r.type === "line" &&
          [d.from, d.to].some(e => e && e.id && !inside.has(e.id))) continue;
      const it = Store.item(r);
      if (r.id === itemId) Object.assign(it, { x, y, parentItemId: null, z: this.maxZ() + 1 });
      it.canvasId = canvasId;
      this.db.prepare("UPDATE items SET canvasId=?,parentItemId=?,x=?,y=?,z=? WHERE id=?")
        .run(canvasId, it.parentItemId, it.x, it.y, it.z, it.id);
      if (it.type === "board" && it.data.childCanvasId) {
        this.db.prepare("UPDATE canvases SET parentCanvasId=? WHERE id=?").run(canvasId, it.data.childCanvasId);
      }
    }
    this.db.exec("COMMIT");
    return true;
  }

  // -- search (GET /api/search) ----------------------------------------------
  static snippet(data, q) {
    const lines = [data.title, data.text, data.caption, data.name, data.url,
      ...(data.tasks || []).map(t => t.text)]
      .filter(Boolean).flatMap(s => String(s).split("\n")).map(l => l.trim()).filter(Boolean);
    const hit = lines.find(l => l.toLowerCase().includes(q.toLowerCase())) || lines[0] || "";
    return hit.slice(0, 140);
  }

  search(query) {
    const q = String(query || "").trim().slice(0, 100);
    if (!q) return [];
    const like = "%" + q.replace(/[\\%_]/g, c => "\\" + c) + "%";
    const trail = cid => this.breadcrumb(cid).map(c => c.title);
    const boards = this.db.prepare(
      "SELECT id,title FROM canvases WHERE trashedBy IS NULL AND title LIKE ? ESCAPE '\\' ORDER BY createdAt DESC LIMIT 25"
    ).all(like).map(c => ({ kind: "board", canvasId: c.id, title: c.title, path: trail(c.id) }));
    const cards = this.db.prepare(
      `SELECT id,canvasId,type,data FROM items WHERE trashedBy IS NULL AND type != 'board' AND (
         json_extract(data,'$.text') LIKE ? ESCAPE '\\' OR json_extract(data,'$.title') LIKE ? ESCAPE '\\'
         OR json_extract(data,'$.url') LIKE ? ESCAPE '\\' OR json_extract(data,'$.name') LIKE ? ESCAPE '\\'
         OR json_extract(data,'$.caption') LIKE ? ESCAPE '\\'
         OR EXISTS (SELECT 1 FROM json_each(items.data,'$.tasks') WHERE json_extract(value,'$.text') LIKE ? ESCAPE '\\'))
       ORDER BY createdAt DESC LIMIT 50`
    ).all(like, like, like, like, like, like).map(r => {
      const d = JSON.parse(r.data || "{}");
      return { kind: "item", id: r.id, canvasId: r.canvasId, type: r.type,
               title: Store.snippet(d, q), path: trail(r.canvasId) };
    });
    return [...boards, ...cards];
  }

  todoLists() {
    const canvas = cid => (this.getCanvas(cid) || {}).title || "";
    return this.db.prepare("SELECT * FROM items WHERE type='todo' AND trashedBy IS NULL ORDER BY createdAt, id")
      .all().map(Store.item).map(it => ({
        id: it.id, canvasId: it.canvasId, canvasTitle: canvas(it.canvasId),
        title: it.data.title || "To-do", color: it.color,
        tasks: Array.isArray(it.data.tasks) ? it.data.tasks : [],
      }));
  }
}

module.exports = { Store, RICH_TYPES, toRich };
