"use strict";
// Electron main: one BrowserWindow, the SQLite store lives here.

const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } = require("electron");
const { pathToFileURL } = require("url");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { Store } = require("./db");

// Custom scheme so the renderer can load uploaded images/audio/video safely
// without file:// or webSecurity games.
protocol.registerSchemesAsPrivileged([{ scheme: "milafile", standard: true, stream: true }]);

// Vault home: holds a registry plus one self-contained directory per vault
// (its own board.db + uploads/). Copying a vault directory copies the whole board.
const DATA_DIR = process.env.MILA_DATA
  || (process.argv[2] && !process.argv[2].startsWith("-") ? path.resolve(process.argv[2]) : null)
  || path.join(os.homedir(), ".local/share/milaclone");
const VAULTS_DIR = path.join(DATA_DIR, "vaults");
const REGISTRY = path.join(DATA_DIR, "vaults.json");
fs.mkdirSync(VAULTS_DIR, { recursive: true });

let store = null;
let win = null;
let currentVaultId = null;

function loadRegistry() {
  try {
    const reg = JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
    if (reg && Array.isArray(reg.vaults)) return reg;
  } catch {}
  return { vaults: [], lastId: null };
}
function saveRegistry(reg) {
  fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2), "utf8");
}
function slug(name) {
  return String(name || "vault").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "vault";
}
function readVaults() {
  const reg = loadRegistry();
  return reg.vaults.filter(v => v && v.id && v.dir && fs.existsSync(v.dir));
}
function currentVault() {
  const reg = loadRegistry();
  return reg.vaults.find(v => v.id === currentVaultId) || reg.vaults.find(v => v.id === reg.lastId) || null;
}
function createVaultDir(name) {
  const reg = loadRegistry();
  const id = `v_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const dir = path.join(VAULTS_DIR, `${slug(name)}-${id.slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  const v = { id, name: String(name || "Untitled vault").slice(0, 80), dir };
  reg.vaults.push(v);
  reg.lastId = id;
  saveRegistry(reg);
  return v;
}
function openVault(id) {
  const reg = loadRegistry();
  const v = reg.vaults.find(x => x.id === id);
  if (!v || !fs.existsSync(v.dir)) return null;
  if (store) { store.close(); store = null; }
  store = new Store(v.dir);
  currentVaultId = v.id;
  reg.lastId = v.id;
  saveRegistry(reg);
  return v;
}
function ensureVault() {
  // migrate the old single-store layout into a vault on first run
  const legacyDb = path.join(DATA_DIR, "board.db");
  if (fs.existsSync(legacyDb) && readVaults().length === 0) {
    const v = createVaultDir("My Vault");
    for (const f of ["board.db", "board.db-wal", "board.db-shm", "uploads"]) {
      const src = path.join(DATA_DIR, f), dst = path.join(v.dir, f);
      if (fs.existsSync(src)) { try { fs.renameSync(src, dst); } catch {} }
    }
  }
  let reg = loadRegistry();
  let vaults = readVaults();
  if (!vaults.length) {
    createVaultDir("My Vault");
    reg = loadRegistry();
    vaults = readVaults();
  }
  const pick = vaults.find(v => v.id === reg.lastId) || vaults[vaults.length - 1];
  openVault(pick.id);
}

const vaultIpc = {
  vaultList: () => ({ vaults: readVaults().map(v => ({ id: v.id, name: v.name })), currentId: currentVaultId }),
  vaultCurrent: () => {
    const v = currentVault();
    return v ? { id: v.id, name: v.name, dir: v.dir } : null;
  },
  vaultCreate: name => {
    const v = createVaultDir(name);
    return { id: v.id, name: v.name };
  },
  vaultOpen: id => {
    const v = openVault(id);
    if (!v) return null;
    if (win && !win.isDestroyed()) win.reload(); // renderer reboots into the new vault
    return { id: v.id, name: v.name };
  },
  vaultRename: ({ id, name }) => {
    const reg = loadRegistry();
    const v = reg.vaults.find(x => x.id === id);
    if (!v) return null;
    v.name = String(name || v.name).slice(0, 80);
    saveRegistry(reg);
    return { id: v.id, name: v.name };
  },
  vaultReveal: id => {
    const reg = loadRegistry();
    const v = reg.vaults.find(x => x.id === id);
    if (v && fs.existsSync(v.dir)) shell.showItemInFolder(v.dir);
    return !!v;
  },
};

// One IPC channel dispatching to allow-listed store methods (renderer never
// touches SQLite directly; every path below is server-side logic).
const METHODS = new Set([
  "payload", "createItem", "updateItem", "updateItems", "trashDeep", "restore",
  "trashRoots", "emptyTrash", "copyDeep", "moveDeep", "search", "updateCanvas",
  "todoLists", "rootCanvasId", "replaceItems",
]);

// ponytail: og:image scraping trusts whatever URL the user pastes (desktop app,
// user's own machine). Cap size + timeout; add allowlist if this ever ships.
async function downloadTo(imgUrl) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const res = await fetch(imgUrl, { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const type = res.headers.get("content-type") || "";
    if (!type.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 8_000_000) return { src: null };
    const ext = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[type] || "img";
    const name = `${Date.now()}-thumb.${ext}`;
    fs.writeFileSync(path.join(store.uploadDir, name), buf);
    return { src: "/uploads/" + name };
  } catch { return null; }
}

const pageTitle = html => {
  const m = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, " ").trim().slice(0, 200) : "";
};

const MIME_BY_EXT = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg",
  ".wav": "audio/wav", ".ogg": "audio/ogg", ".pdf": "application/pdf", ".txt": "text/plain",
  ".md": "text/markdown", ".json": "application/json" };
const mimeFor = fp => MIME_BY_EXT[path.extname(String(fp)).toLowerCase()] || "application/octet-stream";

async function fetchLinkMeta(url) {
  try {
    // YouTube needs no scraping: deterministic thumbnail + oEmbed title
    const yt = url.match(/(?:youtube\.com\/watch\?[^#]*v=|youtu\.be\/)([\w-]{11})/);
    if (yt) {
      const direct = await downloadTo(`https://i.ytimg.com/vi/${yt[1]}/hqdefault.jpg`);
      const oe = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`)
        .then(r => r.ok ? r.json() : null).catch(() => null);
      return { src: direct && direct.src, title: (oe && oe.title) || "" };
    }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const res = await fetch(url, { signal: ctl.signal,
      headers: { "user-agent": "Mozilla/5.0 (Milaclone link preview)" } });
    clearTimeout(t);
    // no res.ok check: 404 pages still carry a <title> worth showing
    const html = (await res.text()).slice(0, 300000);
    const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
      || html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
    const src = m ? await downloadTo(new URL(m[1], url).href) : { src: null }; // resolve relative URLs
    return { src: src && src.src, title: pageTitle(html) };
  } catch { return null; }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 780,
    title: "Milaclone",
    backgroundColor: "#efeff1",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  let harnessRan = false;
  if (process.env.MILA_TEST_SHOT) {
    // Smoke harness: boot, drive the renderer, screenshot, exit. Guard against
    // vault-switch reloads re-triggering it.
    win.webContents.on("did-finish-load", () => {
      if (harnessRan) return;
      harnessRan = true;
      setTimeout(async () => {
      try {
        const driver = require(process.env.MILA_DRIVER || "./test-driver.js");
        await driver.run(win.webContents);
      } catch (e) {
        console.error("driver failed:", e);
        app.exit(1);
        return;
      }
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.MILA_TEST_SHOT, img.toPNG());
      app.exit(0);
      }, 700);
    });
  }
}

app.whenReady().then(() => {
  ensureVault();
  app.setName("Milaclone");
  if (app.setDesktopFileName) app.setDesktopFileName("milaclone");
  protocol.handle("milafile", req => {
    // milafile://m/<name> -> uploads/<name>, basename-pinned so encoded paths
    // can't climb out of the upload dir.
    const name = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, "");
    const safe = path.basename(name);
    return net.fetch(pathToFileURL(path.join(store.uploadDir, safe)).toString());
  });
  if (process.env.MILA_TEST_SHOT) {
    // deterministic asset for the smoke driver's image card
    fs.writeFileSync(path.join(store.uploadDir, "test.png"),
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR4nGP8//8/AzGAiShVowoJAgCXCDPTL6sMxAAAAABJRU5ErkJggg==", "base64"));
  }
  for (const [name, fn] of Object.entries(vaultIpc)) ipcMain.handle(name, (_e, a) => fn(a));
  ipcMain.handle("api", (_e, method, args) => {
    if (!METHODS.has(method)) throw new Error("bad method");
    return store[method](...(args || []));
  });
  ipcMain.handle("openExternal", (_e, url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
  ipcMain.handle("openPath", (_e, src) => {
    if (typeof src !== "string" || !src.startsWith("/uploads/")) return false;
    return shell.openPath(path.join(store.uploadDir, path.basename(src)));
  });
  ipcMain.handle("fetchMeta", (_e, url) => {
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) return null;
    return fetchLinkMeta(url);
  });
  ipcMain.handle("uploadFiles", async (_e, filePaths) => {
    // no arg -> native multi-select picker; array of paths -> bulk/direct upload
    const paths = Array.isArray(filePaths) && filePaths.length
      ? filePaths
      : (await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"] })).filePaths;
    if (!paths.length) return [];
    const out = [];
    for (const fp of paths) {
      const base = path.basename(fp);
      const name = `${Date.now()}-${Math.floor(Math.random() * 1e6)}-${base}`;
      try { fs.copyFileSync(fp, path.join(store.uploadDir, name)); } catch { continue; }
      out.push({ src: "/uploads/" + name, name: base, mime: mimeFor(fp) });
    }
    return out;
  });
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (store) store.close();
  app.quit();
});
