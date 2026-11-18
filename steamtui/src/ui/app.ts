import {
  BoxRenderable,
  ImageRenderable,
  TextRenderable,
  createCliRenderer,
  type MouseEvent as TuiMouseEvent,
} from "@opentui/core";
import type { SteamSession, SteamUser } from "../steam/auth";
import type { AccountLibrary, SteamGame } from "../steam/library";
import { loadAllLibraries, librarySignature, achievementsSignature } from "../steam/library";
import { ownedCacheAge } from "../steam/webapi";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { SteamAchievement } from "../steam/achievements";
import { CoverArt } from "../steam/art";
import { AchSchema } from "../steam/schema";
import { AchievementIcons } from "../steam/achicons";
import { launchGame, killRunningGame, isGameRunning, installGame } from "../steam/launch";
import { readApiKey, writeApiKey } from "../steam/webapi";
import { loadLaunchExecutables, loadLaunchOptions } from "../steam/appinfo";
import type { LaunchOption } from "../steam/appinfo";

interface ModalItem {
  api: string;
  title: string;
  desc: string;
  achieved: boolean;
  hidden: boolean;
  iconUrl: string | null;
}

/**
 * Unified achievement list for the modal: schema (web, complete) supplies
 * names/descriptions/icons; the local librarycache supplies unlock state
 * (vecHighlight achieved + vecAchievedHidden vs vecUnachieved). Falls back to
 * local-only entries when no schema is cached yet.
 */
function modalItems(mg: SteamGame, schemaCache: AchSchema, revealed?: Set<string>): ModalItem[] {
  const revealKey = (api: string): string => `${mg.appid}/${api.toLowerCase()}`;
  const isRevealed = (api: string): boolean => !!revealed?.has(revealKey(api));
  const set = mg.achievements?.achievements;
  const achievedIds = new Set<string>();
  const localAch = new Map<string, SteamAchievement>();
  for (const a of [...(set?.achieved ?? []), ...(set?.achievedHidden ?? [])]) {
    achievedIds.add(a.strID.toLowerCase());
    localAch.set(a.strID.toLowerCase(), a);
  }
  const localLocked = new Map<string, SteamAchievement>();
  for (const a of set?.unachieved ?? []) localLocked.set(a.strID.toLowerCase(), a);

  const schema = schemaCache.get(mg.appid) ?? [];
  if (schema.length === 0) {
    // no schema yet: fall back to whatever the local cache carries
    return [...localAch.values(), ...localLocked.values()].map((a) => {
      const gated = a.bHidden && !a.bAchieved && !isRevealed(a.strID);
      return {
        api: a.strID,
        title: gated ? "???" : a.strName || a.strID,
        desc: gated ? "Unlock this achievement to reveal or press space" : a.strDescription,
        achieved: a.bAchieved,
        hidden: a.bHidden,
        iconUrl: a.strImage || null,
      };
    });
  }
  // ponytail: achieved state beyond the librarycache's 12-entry popup lists is
  // unknown — unknown ids render as locked. Upgrade: parse
  // appcache/stats/UserGameStats_* AchievementTimes for full unlock history.
  const mapped = schema.map((s) => {
    const key = s.apiName.toLowerCase();
    const local = localAch.get(key) ?? localLocked.get(key);
    const achieved = achievedIds.has(key);
    // hidden locked achievements are masked, like the Steam client does
    const gated = s.hidden && !achieved && !isRevealed(s.apiName);
    return {
      api: s.apiName,
      title: gated ? "???" : local?.strName || s.name || s.apiName,
      desc: gated ? "Unlock this achievement to reveal or press space" : local?.strDescription || s.description,
      achieved,
      hidden: s.hidden,
      iconUrl: (achieved ? s.iconOpen : s.iconClosed) || null,
    };
  });
  // modal flow: unlocked list first, then the locked section
  return [...mapped.filter((i) => i.achieved), ...mapped.filter((i) => !i.achieved)];
}

/** Rows that fit the library list interior (screen minus chrome). */
function listRows(rendererHeight: number): number {
  return Math.max(1, rendererHeight - 10);
}

function truncate(text: string, width: number): string {
  return text.length <= width ? text.padEnd(width) : `${text.slice(0, width - 1)}…`;
}

/** Greedy word-wrap row count, matching a Text renderable's "word" wrap mode. */
function wrapLines(text: string, width: number): number {
  if (!text) return 1;
  const w = Math.max(6, width);
  let lines = 0;
  for (const para of text.split("\n")) {
    let cur = 0;
    let count = para ? 1 : 0;
    for (const word of para.split(" ")) {
      const add = cur === 0 ? word.length : word.length + 1;
      if (cur + add <= w) cur += add;
      else {
        count++;
        cur = Math.min(word.length, w);
      }
    }
    lines += count;
  }
  return lines;
}

const COMPAT_OPTIONS = ["None", "Proton Experimental", "Proton 8.0", "Proton 9.0"];

const HELP_LINES = [
  "↑/↓ or j/k   move selection",
  "Enter      launch selected / play running",
  "K          kill running game",
  "f          favorite toggle",
  "w          steam web api key",
  "e          launch options (args · backend/exec · compat)",
  "a          achievements",
  "i          installed only",
  "d          toggle demos",
  "h          hide / unhide game",
  "H          toggle hide view",
  "?          help (this screen)",
  ":          user management",
  "q          quit",
];

/** Dropdown label: basename of a launch executable. */
function execLabel(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

// Display-list rows that aren't games (non-selectable fixed rows).
const LIST_HEADER = "__list_header__";
const LIST_DIVIDER = "__list_divider__";
type ListRow = SteamGame | typeof LIST_HEADER | typeof LIST_DIVIDER;
const isGameRow = (row: ListRow): row is SteamGame => row !== LIST_HEADER && row !== LIST_DIVIDER;

interface LaunchConf {
  args: string;
  compat: number;
  exec: string | null;
  backend: number; // index into backendOpts, 0 = Default, -1 = no backend options
  backendArgs: string; // launch args of the chosen backend option
}

function sidebarTitle(game: SteamGame | undefined): string {
  if (!game) return "";
  const name = game.name ?? `App ${game.appid}`;
  const set = game.achievements?.achievements;
  const nTotal = set?.nTotal ?? 0;
  const nAchieved = set?.nAchieved ?? 0;
  const full = nTotal > 0 && nAchieved >= nTotal;
  const icon = full ? "󰔻 " : "";
  return `${icon}${name}`;
}

function sidebarData(game: SteamGame | undefined, lastPlayed: number): string {
  if (!game) return "";
  const set = game.achievements?.achievements;
  const nTotal = set?.nTotal ?? 0;
  const nAchieved = set?.nAchieved ?? 0;
  const achLine = nTotal > 0 ? `Achievements: ${nAchieved}/${nTotal}` : "Achievements: None";
  return [
    `Playtime: ${fmtPlaytime(game.playtimeMinutes)}`,
    `Last played: ${fmtLastPlayed(lastPlayed)}`,
    achLine,
  ].join("\n");
}

function fmtPlaytime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h <= 0) return `${m}m`;
  if (m <= 0) return `${h}h`;
  return `${h}h ${m}m`;
}

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtLastPlayed(unixSeconds: number): string {
  if (!unixSeconds) return "never";
  const d = new Date(unixSeconds * 1000);
  const now = new Date();
  const startOfDay = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  const monthDay = `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;
  const full = `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 365) return monthDay;
  return full;
}

export async function runApp(accounts: AccountLibrary[]): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    backgroundColor: "#0b0f14",
    useMouse: true,
  });
  let accountIdx = 0;
  // last-used account index, persisted so a restart reopens on the last user
  const lastAccountCachePath = () => {
    const xdg = process.env.XDG_CACHE_HOME ?? path.join(process.env.HOME ?? "/tmp", ".cache");
    return path.join(xdg, "steamtui", "last-account.json");
  };
  try {
    const raw = JSON.parse(await Bun.file(lastAccountCachePath()).text()) as { lastAccountIdx?: unknown };
    const idx = Number(raw?.lastAccountIdx);
    if (Number.isInteger(idx) && idx >= 0 && idx < accounts.length) accountIdx = idx;
  } catch {
    // first run or corrupt cache: default to first account
  }
  let games: SteamGame[] = accounts[accountIdx]?.games ?? [];
  let session: SteamSession = accounts[accountIdx]?.session ?? ({} as SteamSession);

  const root = new BoxRenderable(renderer, {
    id: "root",
    flexGrow: 1,
    flexDirection: "column",
    padding: 1,
    gap: 1,
    backgroundColor: "#0b0f14",
  });
  renderer.root.add(root);

  const body = new BoxRenderable(renderer, { id: "body", flexGrow: 1, flexDirection: "row", gap: 1 });
  root.add(body);

  const listBox = new BoxRenderable(renderer, {
    id: "library",
    flexGrow: 1,
    flexDirection: "column",
    border: true,
    borderStyle: "rounded",
    borderColor: "#2b3440",
    title: " Library ",
    titleColor: "#c9d1d9",
    padding: 1,
  });
  const listText = new TextRenderable(renderer, { id: "library-lines", content: "", width: "100%" });
  listBox.add(listText);
  body.add(listBox);

  const sideBox = new BoxRenderable(renderer, {
    id: "achievements",
    flexShrink: 0,
    flexDirection: "column",
    gap: 0,
    border: true,
    borderStyle: "rounded",
    borderColor: "#2b3440",
    title: " Details ",
    titleColor: "#c9d1d9",
    padding: 1,
  });
  const cover = new ImageRenderable(renderer, {
    id: "cover",
    protocol: process.env.STEAMTUI_IMG_PROTO === "blocks" ? "blocks" : "auto",
    fit: "fit",
    flexShrink: 0,
    alignSelf: "center",
  });
  const coverSpacer = new TextRenderable(renderer, { id: "achievements-cover-spacer", content: "", fg: "#c9d1d9", flexShrink: 0 });
  // unsqueezable text rows: word-wraped, the cover yields instead (counted in
  // the sidebar budget); yoga would otherwise shrink these to 0 rows (title
  // disappears at some zooms) since the button and cover are flexShrink 0
  const sideTitle = new TextRenderable(renderer, { id: "achievements-title", content: "", fg: "#f0f6fc", wrapMode: "word", flexShrink: 0 });
  const sideData = new TextRenderable(renderer, { id: "achievements-data", content: "", fg: "#8b949e", wrapMode: "word", flexShrink: 0 });
  // Bottom-anchored Play button; three stepped rows fake a subtle gradient.
  const playGap = new BoxRenderable(renderer, { id: "play-gap", flexGrow: 1, flexShrink: 0 });
  const playBtn = new BoxRenderable(renderer, {
    id: "play-button",
    height: 3,
    alignSelf: "stretch",
    flexShrink: 0,
  });
  const playRowTop = new BoxRenderable(renderer, { id: "play-row-top", height: 1, backgroundColor: "#3fb950" });
  const playRowMid = new BoxRenderable(renderer, {
    id: "play-row-mid",
    height: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#2ea043",
  });
  const playRowBot = new BoxRenderable(renderer, { id: "play-row-bot", height: 1, backgroundColor: "#238a38" });
  const playLbl = new TextRenderable(renderer, { id: "play-label", content: "Play", fg: "#ffffff" });
  playRowMid.add(playLbl);
  playBtn.add(playRowTop);
  playBtn.add(playRowMid);
  playBtn.add(playRowBot);
  sideBox.add(cover);
  sideBox.add(coverSpacer);
  sideBox.add(sideTitle);
  sideBox.add(sideData);
  sideBox.add(playGap);
  sideBox.add(playBtn);
  body.add(sideBox);

  const modalOverlay = new BoxRenderable(renderer, {
    position: "absolute",
    backgroundColor: "#0b0f14",
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    width: "100%",
    height: "100%",
  });
  renderer.root.add(modalOverlay);

  // btop-style minimum-size screen: dims the app and says what is needed
  const MIN_W = 60;
  const MIN_H = 24;
  const tooSmall = new BoxRenderable(renderer, {
    id: "too-small",
    position: "absolute",
    width: "100%",
    height: "100%",
    backgroundColor: "#0b0f14",
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    gap: 1,
  });
  const tooSmallTitle = new TextRenderable(renderer, { id: "too-small-title", content: "Terminal size too small:", fg: "#f0f6fc" });
  const tooSmallCur = new TextRenderable(renderer, { id: "too-small-cur", content: "", fg: "#f85149" });
  const tooSmallNeed = new TextRenderable(renderer, { id: "too-small-need", content: "Needed for current config:", fg: "#f0f6fc" });
  const tooSmallMin = new TextRenderable(renderer, { id: "too-small-min", content: `Width = ${MIN_W}  Height = ${MIN_H}`, fg: "#3fb950" });
  for (const t of [tooSmallTitle, tooSmallCur, tooSmallNeed, tooSmallMin]) tooSmall.add(t);
  renderer.root.add(tooSmall);
  tooSmall.visible = false;
  const modalBox = new BoxRenderable(renderer, {
    backgroundColor: "#0b0f14",
    border: true,
    borderStyle: "rounded",
    borderColor: "#2b3440",
    title: " My achievements ",
    titleColor: "#9be9a8",
    padding: 1,
    flexDirection: "column",
    gap: 0,
    width: 80,
    height: 28,
  });
  const modalName = new TextRenderable(renderer, { id: "modal-name", content: "", fg: "#f0f6fc" });
  // Option rows (Steam Arguments / exec / Compatibility Tool): fixed label
  // zone (22 cols: marker + padded label) + panel-style value (lighter bg,
  // no border) so all values align on one column
  const optionRow = (id: string) => {
    const row = new BoxRenderable(renderer, {
      id,
      flexDirection: "row",
      alignItems: "center",
      width: "100%",
      height: 1,
      flexShrink: 0,
    });
    const label = new TextRenderable(renderer, { id: `${id}-label`, content: "", fg: "#c9d1d9", width: 22, flexShrink: 0 });
    const panel = new BoxRenderable(renderer, {
      id: `${id}-panel`,
      backgroundColor: "#21262d",
      width: 54,
      height: 1,
      flexShrink: 0,
    });
    const value = new TextRenderable(renderer, { id: `${id}-value`, content: "", fg: "#c9d1d9" });
    panel.add(value);
    row.add(label);
    row.add(panel);
    return { row, label, value };
  };
  const argsRow = optionRow("args-row");
  const execRow = optionRow("exec-row");
  const compatRow = optionRow("compat-row");
  const backendRow = optionRow("backend-row");
  // a one-row breathing space between panels so backgrounds don't touch
  execRow.row.marginTop = 1;
  compatRow.row.marginTop = 1;
  backendRow.row.marginTop = 1;
  for (const r of [argsRow, execRow, compatRow, backendRow]) r.row.visible = false;
  const paletteLines = new TextRenderable(renderer, { id: "palette-lines", content: "", fg: "#c9d1d9", width: "100%" });
  // pooled achievement rows: icon + title/description
  interface ModalRow {
    row: BoxRenderable;
    icon: ImageRenderable;
    title: TextRenderable;
    desc: TextRenderable;
  }
  const modalRowPool: ModalRow[] = [];
  const ensurePool = (n: number): void => {
    while (modalRowPool.length < n) {
      const row = new BoxRenderable(renderer, { id: `modal-row-${modalRowPool.length}`, flexDirection: "row", gap: 1, flexShrink: 0, height: 3 });
      const icon = new ImageRenderable(renderer, {
        id: `modal-icon-${modalRowPool.length}`,
        protocol: process.env.STEAMTUI_IMG_PROTO === "blocks" ? "blocks" : "auto",
        fit: "fit",
        width: 4,
        height: 2,
        flexShrink: 0,
      });
      const col = new BoxRenderable(renderer, { id: `modal-col-${modalRowPool.length}`, flexDirection: "column" });
      const title = new TextRenderable(renderer, { id: `modal-title-${modalRowPool.length}`, content: "", fg: "#f0f6fc" });
      const desc = new TextRenderable(renderer, { id: `modal-desc-${modalRowPool.length}`, content: "", fg: "#9be9a8" });
      col.add(title);
      col.add(desc);
      row.add(icon);
      row.add(col);
      modalBox.add(row);
      modalRowPool.push({ row, icon, title, desc });
    }
  };
  modalBox.add(argsRow.row);
  modalBox.add(execRow.row);
  modalBox.add(backendRow.row);
  modalBox.add(compatRow.row);
  modalBox.add(modalName);
  modalBox.add(paletteLines);
  modalOverlay.add(modalBox);
  modalOverlay.visible = false;

  let modalOpen = false;
  let modalGame: SteamGame | null = null;
  let modalSel = 0;
  let modalScroll = 0;
  let modalFirst = 0;
  const revealed = new Set<string>();
  let paletteOpen = false;
  let paletteSel = 0;
  let compatSel = 0; // Compatibility Tool row selection inside the Options modal
  let installedOnly = false;
  let showDemos = false; // d toggles demos in the library view
  let launchOpen = false;
  let webApiOpen = false;
  let webApiInput = "";
  let webApiCurrent: string | null = null;
  let launchExecs: string[] = [];
  let launchExecSel = 0;
  let launchArgs = "";
  let launchExec: string | null = null; // explicit launch option selection (per game)
  let launchFocus = 0; // 0 = arguments box, 1 = exec dropdown, 2 = compat tool (when a dropdown exists)
  let backendOpts: LaunchOption[] = [{ exe: "", args: "" }]; // "Launch Options" row entries for current game
  let backendSel = 0; // backendSel index into backendOpts (0 = "Default")
  let hiddenIds = new Set<number>(); // appids moved into the hide view with h
  let hideView = false; // true = browsing the hide view (hidden games list)
  // Hide state persists per account so hidden games stay hidden across runs.
  const hiddenCachePath = (accountId: string | number) => {
    const xdg = process.env.XDG_CACHE_HOME ?? path.join(process.env.HOME ?? "/tmp", ".cache");
    return path.join(xdg, "steamtui", `hidden-${accountId}.json`);
  };
  const loadHidden = async () => {
    try {
      const arr = JSON.parse(await Bun.file(hiddenCachePath(session.accountId)).text());
      if (Array.isArray(arr)) {
        for (const id of arr) {
          if (typeof id === "number" && id >= 0 && id < 2 ** 31) hiddenIds.add(id);
        }
      }
    } catch {
      // first run or corrupt cache: start empty
    }
    render();
  };
  const saveHidden = async () => {
    await mkdir(path.dirname(hiddenCachePath(session.accountId)), { recursive: true });
    await Bun.write(hiddenCachePath(session.accountId), JSON.stringify([...hiddenIds]));
  };
  void loadHidden();
  let favorites = new Set<number>(); // favorited appids (top "Favorites" section)
  const favoritesCachePath = (accountId: string | number) => {
    const xdg = process.env.XDG_CACHE_HOME ?? path.join(process.env.HOME ?? "/tmp", ".cache");
    return path.join(xdg, "steamtui", `favorites-${accountId}.json`);
  };
  const loadFavorites = async () => {
    try {
      const arr = JSON.parse(await Bun.file(favoritesCachePath(session.accountId)).text());
      if (Array.isArray(arr)) {
        for (const id of arr) {
          if (typeof id === "number" && id >= 0 && id < 2 ** 31) favorites.add(id);
        }
      }
    } catch {
      // first run or corrupt cache: start empty
    }
    render();
  };
  const saveFavorites = async () => {
    await mkdir(path.dirname(favoritesCachePath(session.accountId)), { recursive: true });
    await Bun.write(favoritesCachePath(session.accountId), JSON.stringify([...favorites]));
  };
  void loadFavorites();
  let helpOpen = false;
  const launchConf = new Map<number, LaunchConf>();
  // Launch options persist per account across TUI restarts (args/backend/exec/compat).
  const launchCachePath = (accountId: string | number) => {
    const xdg = process.env.XDG_CACHE_HOME ?? path.join(process.env.HOME ?? "/tmp", ".cache");
    return path.join(xdg, "steamtui", `launch-${accountId}.json`);
  };
  const saveLaunchConf = async (appid: number, conf: LaunchConf) => {
    const all = [...launchConf.entries()].map(([k, v]) => ({ appid: k, ...v }));
    await mkdir(path.dirname(launchCachePath(session.accountId)), { recursive: true });
    await Bun.write(launchCachePath(session.accountId), JSON.stringify(all));
  };
  const loadLaunchConfs = async () => {
    try {
      const arr = JSON.parse(await Bun.file(launchCachePath(session.accountId)).text());
      if (Array.isArray(arr)) {
        for (const e of arr) {
          const g = e as Partial<LaunchConf> & { appid?: number };
          if (typeof g.appid !== "number") continue;
          launchConf.set(g.appid, {
            args: typeof g.args === "string" ? g.args : "",
            compat: typeof g.compat === "number" ? g.compat : 0,
            exec: typeof g.exec === "string" ? g.exec : null,
            backend: typeof g.backend === "number" ? g.backend : -1,
            backendArgs: typeof g.backendArgs === "string" ? g.backendArgs : "",
          });
        }
      }
    } catch {
      // first run or corrupt cache: start empty
    }
    render();
  };
  void loadLaunchConfs();

  const switchAccount = (idx: number) => {
    if (idx < 0 || idx >= accounts.length) return;
    accountIdx = idx;
    // remember as the last-used account so a restart reopens on it
    void (async () => {
      await mkdir(path.dirname(lastAccountCachePath()), { recursive: true });
      await Bun.write(lastAccountCachePath(), JSON.stringify({ lastAccountIdx: idx }));
    })();
    games = accounts[idx]!.games;
    session = accounts[idx]!.session;
    hiddenIds = new Set(); // per-account hide state
    void loadHidden();
    favorites = new Set(); // per-account favorites
    void loadFavorites();
    launchConf.clear();
    void loadLaunchConfs();
    selected = Math.max(0, Math.min(selected, games.length - 1));
    offset = 0;
    modalOpen = false;
    modalGame = null;
    modalSel = 0;
    modalFirst = 0;
    paletteOpen = false;
    paletteSel = 0;
    launchOpen = false;
    webApiOpen = false;
    webApiInput = "";
    render();
  };

  const statusPane = new BoxRenderable(renderer, {
    id: "status-pane",
    flexShrink: 0,
    flexDirection: "column",
    border: true,
    borderStyle: "rounded",
    borderColor: "#2b3440",
    title: " Status ",
    titleColor: "#c9d1d9",
    padding: 0,
    width: "100%",
    height: 5,
  });
  const statusText = new TextRenderable(renderer, { id: "status-lines", content: "", fg: "#8b949e", flexGrow: 1 });
  const statusHelp = new TextRenderable(renderer, { id: "status-help", content: "Help [?]", fg: "#8b949e", textAlign: "right", flexShrink: 0, alignSelf: "flex-end" });
  const statusRow = new BoxRenderable(renderer, { id: "status-row", flexDirection: "row", justifyContent: "space-between", width: "100%", height: 2 });
  statusRow.add(statusText);
  statusRow.add(statusHelp);
  statusPane.add(statusRow);
  root.add(statusPane);
  let selected = Math.max(0, games.findIndex((game) => (game.achievements?.achievements.nTotal ?? 0) > 0));
  let currentGame: SteamGame | null = null;
  let offset = 0;
  const coverCache = new CoverArt(session.steamRoot);
  const schemaCache = new AchSchema(session.steamId64);
  const iconCache = new AchievementIcons();
  let coverAppid = -1;

  // Running-game tracking drives the Play/Running button and the idle fps mode.
  // Rechecked on each selection with a small debounce so games launched
  // outside the TUI (e.g. straight from Steam) are picked up.
  const runningIds = new Set<number>();
  let runCheckId = -1;
  let runCheckAt = 0;
  let launching = false;
  const refreshRunning = (appid: number, onDone?: () => void) => {
    if (!appid) return;
    const now = Date.now();
    if (appid === runCheckId && now - runCheckAt < 4_000) {
      onDone?.();
      return;
    }
    runCheckId = appid;
    runCheckAt = now;
    void isGameRunning(appid).then((running) => {
      const was = runningIds.has(appid);
      const wasLaunching = launching;
      if (running) runningIds.add(appid);
      else runningIds.delete(appid);
      launching = false;
      if (was !== running || wasLaunching) render();
      onDone?.();
    });
  };
  const launchSelected = () => {
    const game = currentGame;
    if (!game || runningIds.has(game.appid)) return;
    if (!game.installed) {
      // uninstalled: hand off to Steam's install flow instead of a launch
      void installGame(session.steamRoot, game.appid);
      return;
    }
    launching = true;
    const conf = launchConf.get(game.appid);
    launchGame(
      session.steamRoot,
      game.appid,
      conf
        ? {
            args: [conf.args, conf.backendArgs].filter(Boolean).join(" ") || undefined,
            exec: conf.exec ?? undefined,
            compatTool: COMPAT_OPTIONS[conf.compat],
          }
        : undefined,
    );
    runningIds.add(game.appid);
    render();
    watchGameIdle(game.appid);
  };
  playBtn.onMouseDown = () => launchSelected();

  // Scroll wheel routes through the selection (no scrollbars): wheel up/down
  // move it like the arrow keys; inside the modal they move achievements.
  // Trackpads emit many wheel events per gesture — rendering synchronously
  // on each is what made scrolling feel choppy, so deltas are batched per
  // surface and applied as a single larger selection move per redraw window.
  // Visible list = current view (library vs hide view) minus/plus hidden
  // games; hidden is per-appid so h/H and account switches stay consistent.
  const visibleGames = () => {
    const pool = installedOnly ? games.filter((g) => g.installed) : games;
    const filtered = showDemos ? pool : pool.filter((g) => !g.demo);
    return hideView
      ? filtered.filter((g) => hiddenIds.has(g.appid))
      : filtered.filter((g) => !hiddenIds.has(g.appid));
  };
  // display order: favorites section first (top), then the rest — only when
  // the current pool has at least one favorite. Header/divider are fixed,
  // non-selectable sentinel rows.
  const displayGames = (): ListRow[] => {
    const pool = visibleGames();
    const favs = pool.filter((g) => favorites.has(g.appid));
    if (favs.length === 0) return pool;
    return [LIST_HEADER, ...favs, LIST_DIVIDER, ...pool.filter((g) => !favorites.has(g.appid))];
  };

  const moveSelection = (delta: number) => {
    const list = displayGames();
    if (list.length === 0) return;
    const isFixed = (i: number) => {
      const row = list[i];
      return row === undefined || row === LIST_HEADER || row === LIST_DIVIDER;
    };
    let next = selected;
    const dir = delta >= 0 ? 1 : -1;
    let remaining = Math.abs(delta);
    while (remaining > 0) {
      next += dir;
      if (next < 0) { next = 0; remaining = 0; }
      else if (next >= list.length) { next = list.length - 1; remaining = 0; }
      else if (isFixed(next)) { continue; }
      else { remaining--; }
    }
    // never land on a fixed row (e.g. clamp hit the header): walk past it
    while (isFixed(next) && next < list.length - 1) next++;
    while (isFixed(next) && next > 0) next--;
    selected = next;
    if (selected < offset) offset = selected;
    if (selected >= offset + listRows(renderer.height)) offset = selected - listRows(renderer.height) + 1;
    render();
  };
  // Trackpad wheel events arrive in bursts — rendering synchronously on each
  // is what made scrolling feel choppy, so deltas are batched per surface
  // and applied as one larger selection move per redraw window.
  const makeScrollBatch = (apply: (d: number) => void) => {
    let dist = 0;
    let flush: ReturnType<typeof setTimeout> | null = null;
    return (delta: number) => {
      dist += delta;
      if (flush) return;
      flush = setTimeout(() => {
        flush = null;
        const d = dist;
        dist = 0;
        if (d !== 0) apply(d);
      }, 20);
    };
  };
  const scrollList = makeScrollBatch(moveSelection);
  const scrollModal = makeScrollBatch((d) => {
    if (!modalGame) return;
    const total = modalItems(modalGame, schemaCache, revealed).length;
    modalSel = Math.max(0, Math.min(total - 1, modalSel + d));
    render();
  });
  listBox.onMouseScroll = (event) => {
    if (event.scroll?.direction === "down") return scrollList(1);
    if (event.scroll?.direction === "up") return scrollList(-1);
  };
  modalBox.onMouseScroll = (event) => {
    if (event.scroll?.direction === "down") return scrollModal(1);
    if (event.scroll?.direction === "up") return scrollModal(-1);
  };
  modalOverlay.onMouseScroll = (event) => {
    if (event.scroll?.direction === "down") return scrollModal(1);
    if (event.scroll?.direction === "up") return scrollModal(-1);
  };

  const updateCover = () => {
    const game = currentGame;
    if (!game) return;
    const bytes = coverCache.get(game.appid);
    if (bytes) {
      cover.source = bytes;
      coverAppid = game.appid;
      return;
    }
    // same appid but no cached art yet: fetch already in flight
    if (game.appid === coverAppid) return;
    coverAppid = game.appid;
    cover.source = undefined;
    coverCache.ensure(game.appid, (appid, fetched) => {
      if (fetched && coverAppid === appid) cover.source = fetched;
    });
  };

  const render = () => {
    // below the minimum the layout overflows: show the btop-style screen instead
    if (renderer.width < MIN_W || renderer.height < MIN_H) {
      tooSmallCur.content = `Width = ${renderer.width}  Height = ${renderer.height}`;
      tooSmall.visible = true;
      modalOverlay.visible = false;
      return;
    }
    tooSmall.visible = false;
    argsRow.row.visible = launchOpen;
    execRow.row.visible = launchOpen;
    compatRow.row.visible = launchOpen;
    backendRow.row.visible = launchOpen;
    const tight = renderer.height < 24;
    // selection drives both the list and the sidebar budget below
    // display list includes fixed sentinel rows (Favorites header / divider)
    const list = displayGames();
    const selRow = list[selected];
    const selGame = selRow !== undefined && isGameRow(selRow) ? selRow : undefined;
    const artH = Math.max(10, Math.floor((renderer.height - 8) * 0.6));
    const artW = Math.max(12, Math.ceil(artH * (2 / 3) * cover.cellAspectRatio));
    const sideW = Math.min(artW + 8, Math.max(18, renderer.width - 34));
    sideBox.width = sideW;
    // sidebar rows budget: once title/data/gap/button are reserved, the cover
    // yields whatever remains (text rows are unsqueezable and word-wrapped)
    const sideInner = Math.max(8, renderer.height - 11); // body − status − border/padding
    const btnH = tight ? 1 : 3;
    const dataStr = selGame ? sidebarData(selGame, session.playtimes[selGame.appid]?.lastPlayed ?? 0) : "";
    const titleLines = selGame ? wrapLines(sidebarTitle(selGame), sideW - 4) : 0;
    const dataLines = selGame ? wrapLines(dataStr, sideW - 4) : 0;
    const reserved = 1 + titleLines + dataLines + 1 + btnH; // spacer/title/data/gap/button
    const coverH = Math.max(4, Math.min(artH, sideInner - reserved));
    cover.height = coverH;
    cover.width = Math.max(12, Math.ceil(coverH * (2 / 3) * cover.cellAspectRatio));

    if (helpOpen) {
      modalBox.title = " Help ";
      modalBox.width = 70;
      modalBox.padding = 1;
      modalBox.height = Math.min(Math.max(3, HELP_LINES.length + 4), renderer.height - 2);
      modalName.content = HELP_LINES.join("\n");
      paletteLines.content = ""; // help content lives in modalName only
      for (const e of modalRowPool) e.row.visible = false;
      modalOverlay.visible = true;
      return;
    }

    if (paletteOpen) {
      modalBox.title = " User Management ";
      modalBox.width = 70;
      modalBox.padding = 1;
      modalBox.height = Math.min(Math.max(3, accounts.length + 5), renderer.height - 2);
      modalName.content = accounts
        .map((a, i) => `${i === paletteSel ? "▶ " : "  "}${a.user.accountName ?? a.user.personaName}  ${a.user.steamId64}`)
        .join("\n");
      paletteLines.content = "";
      for (const e of modalRowPool) e.row.visible = false;
      modalOverlay.visible = true;
      return;
    }

    if (webApiOpen) {
      modalBox.title = " Steam Web API ";
      modalBox.width = 78;
      modalBox.borderColor = "#58a6ff";
      modalBox.padding = 1;
      modalBox.height = Math.min(Math.max(8, 8), renderer.height - 2);
      modalName.content =
        `Current key: ${webApiCurrent ?? "not set"}\n\nType a new 32-hex key to replace it, Enter to save.\nEsc to cancel.`;
      paletteLines.content = webApiInput ? `${webApiInput}_` : "> ";
      for (const e of modalRowPool) e.row.visible = false;
      modalOverlay.visible = true;
      return;
    }

    if (launchOpen) {
      modalBox.title = " Options ";
      modalBox.width = 80;
      modalBox.borderColor = "#58a6ff"; // urlink-style accent frame
      const hasExecs = launchExecs.length > 1;
      const hasBackends = backendOpts.length > 1;
      // a game with backend choices gets the "Launch Options" row in the
      // exec row's slot; the raw exec-file row is dropped
      const showExec = !hasBackends && hasExecs;
      const compatStage = hasBackends || showExec ? 2 : 1;
      const backendStage = hasBackends ? 1 : -1;
      // option rows: fixed label zone (22 cols: marker + padded label) +
      // panel-style value (lighter bg, no border) so values share one column
      argsRow.label.content = `${launchFocus === 0 ? "▸ " : "  "}${"Steam Arguments".padEnd(20)}`;
      argsRow.value.content = launchArgs ? `${launchArgs}_` : "";
      argsRow.value.fg = launchArgs ? "#f0f6fc" : launchFocus === 0 ? "#8b949e" : "#59636e";
      execRow.row.visible = showExec;
      execRow.label.content = `${launchFocus === 1 ? "▸ " : "  "}`;
      execRow.value.content = showExec ? execLabel(launchExecs[launchExecSel!] ?? launchExecs[0]!) : "";
      compatRow.label.content = `${launchFocus === compatStage ? "▸ " : "  "}${"Compatibility Tool".padEnd(20)}`;
      compatRow.value.content = COMPAT_OPTIONS[compatSel] ?? "None";
      backendRow.row.visible = hasBackends;
      backendRow.label.content = `${launchFocus === backendStage ? "▸ " : "  "}${"Launch Options".padEnd(20)}`;
      backendRow.value.content = backendOpts[backendSel] ? backendOpts[backendSel]!.label || backendOpts[backendSel]!.args || "Default" : "Default";
      backendRow.value.fg = launchFocus === backendStage ? "#f0f6fc" : "#59636e";
      modalName.content = "";
      // the empty modalName row is the gap; hint aligned with the labels
      paletteLines.content = "  tab focus · ⏎ save · q close";
      const rows = 2 + (showExec ? 1 : 0) + (hasBackends ? 1 : 0);
      modalBox.height = Math.max(8, Math.min(rows + (rows - 1) + 6, renderer.height - 2)); // rows + inter-row gaps + chrome
      // achievements rows are pooled children of modalBox: hide them when
      // another surface (launch/help/palette) owns the modal
      for (const e of modalRowPool) e.row.visible = false;
      modalOverlay.visible = true;
      return;
    }

    if (modalOpen && modalGame) {
      const mg = modalGame;
      // centered overlay with a scrolling list of achievement pairs
      const mw = Math.max(40, Math.min(80, renderer.width - 4));
      const innerRows = Math.max(2, renderer.height - 7);
      const items = modalItems(mg, schemaCache, revealed);
      const unlockedItems = items.filter((i) => i.achieved);
      const lockedItems = items.filter((i) => !i.achieved);
      const set = mg.achievements?.achievements;
      const maxChars = Math.max(10, mw - 9);

      type Slot = { kind: "item"; idx: number } | { kind: "header" };
      // slot stream: unlocked pairs, "Locked achievements" header, locked
      // pairs; each item keeps one blank row below it (achievement spacing)
      const headerAt = unlockedItems.length;
      const hasHeader = lockedItems.length > 0;
      const stream: Slot[] = [];
      for (let i = 0; i < items.length; i++) {
        if (i === headerAt && hasHeader) stream.push({ kind: "header" });
        stream.push({ kind: "item", idx: i });
      }
      const rowsFor = (s: Slot): number => (s.kind === "header" ? 2 : 3);
      // stream positions for item indices (header sits before the locked ones)
      const posOf = (idx: number): number =>
        idx + (hasHeader && headerAt < items.length && idx >= headerAt ? 1 : 0);
      // window of up to `rows` rows starting at stream position `first`
      const windowAt = (first: number): { slots: Slot[]; rows: number } => {
        const slots: Slot[] = [];
        let rows = 0;
        let i = first;
        while (i < stream.length) {
          const s = stream[i]!;
          const h = rowsFor(s);
          if (rows + h > innerRows) break;
          slots.push(s);
          rows += h;
          i++;
        }
        return { slots, rows };
      };

      let win = windowAt(modalFirst);
      const selPos = modalSel < items.length ? posOf(modalSel) : 0;
      if (selPos < modalFirst) modalFirst = selPos;
      if (!win.slots.some((s) => s.kind === "item" && s.idx === modalSel)) {
        let f = modalFirst;
        while (f < stream.length && !windowAt(f).slots.some((s) => s.kind === "item" && s.idx === modalSel)) f++;
        if (f < stream.length) {
          modalFirst = f;
          win = windowAt(modalFirst);
        }
      }

      ensurePool(win.slots.length);
      for (let p = 0; p < modalRowPool.length; p++) {
        const entry = modalRowPool[p]!;
        const slot = win.slots[p];
        if (!slot) {
          entry.row.visible = false;
          continue;
        }
        entry.row.visible = true;
        if (slot.kind === "header") {
          entry.icon.visible = false;
          entry.title.content = "Locked achievements";
          entry.title.fg = "#8b949e";
          entry.desc.content = "";
          continue;
        }
        const it = items[slot.idx]!;
        if (it.achieved) {
          entry.title.fg = "#9be9a8";
        } else {
          entry.title.fg = "#c9d1d9";
        }
        entry.desc.fg = "#8b949e";
        entry.title.content = `${slot.idx === modalSel ? "▶ " : ""}${truncate(it.title, maxChars).trimEnd()}`;
        entry.desc.content = truncate(it.desc, maxChars).trimEnd();
        // square Steam icon: colored (open) when unlocked, gray (closed) when locked
        const bytes = iconCache.get(mg.appid, it.api, it.achieved);
        if (bytes) {
          entry.icon.source = bytes;
        } else {
          entry.icon.source = undefined;
          if (it.iconUrl) iconCache.ensure(mg.appid, it.api, it.achieved, it.iconUrl, () => render());
        }
        entry.icon.visible = true;
      }

      modalName.content = `${set ? `${set.nAchieved}/${set.nTotal}` : "—"}  ${mg.name ?? `App ${mg.appid}`}`;
      modalBox.width = mw;
      modalBox.padding = 1;
      modalBox.height = Math.min(win.rows + 5, renderer.height - 2);
      modalBox.title = mg.name ? ` My achievements — ${mg.name} ` : " My achievements ";
      modalOverlay.visible = true;
      return;
    }

    listBox.visible = true;
    modalOverlay.visible = false;

    const rows = listRows(renderer.height);
    const end = Math.min(list.length, offset + rows);
    // rows span the full library box: name column stretches, counts right-aligned
    const usableW = Math.max(24, renderer.width - 2); // root padding
    const listBoxW = Math.max(24, usableW - sideW - 1); // gap column to sidebar
    const listInner = Math.max(20, listBoxW - 4); // border(2) + padding(2)
    // "▶ ● " prefix (4) + full-achievement trophy glyph (2)
    const nameCol = Math.max(10, listInner - 6);
    const lines: string[] = [];
    for (let i = offset; i < end; i++) {
      const row = list[i]!;
      const marker = i === selected ? "▶" : " ";
      if (row === LIST_HEADER) {
        lines.push("  Favorites");
        continue;
      }
      if (row === LIST_DIVIDER) {
        lines.push("─".repeat(Math.max(4, nameCol - 2)));
        continue;
      }
      const installed = row.installed ? "●" : "○";
      const set = row.achievements?.achievements;
      const nTotal = set?.nTotal ?? 0;
      const nAchieved = set?.nAchieved ?? 0;
      const full = nTotal > 0 && nAchieved >= nTotal;
      const title = full ? `󰔻 ${row.name ?? `App ${row.appid}`}` : row.name ?? `App ${row.appid}`;
      lines.push(`${marker} ${installed} ${truncate(title, nameCol)}`);
    }
    while (lines.length < rows) lines.push("");
    listText.content = lines.join("\n");

    currentGame = selGame ?? null;
    sideTitle.content = sidebarTitle(selGame);
    sideTitle.fg = selGame?.installed ? "#f0f6fc" : "#8b949e"; // uninstalled titles gray
    sideData.content = dataStr;
    updateCover();
    if (selGame) refreshRunning(selGame.appid);

    const run = runningIds.has(selGame?.appid ?? -1);
    const colors = launching
      ? { top: "#e3b34a", mid: "#cf9a2e", bot: "#b07f1f" }
      : run
        ? { top: "#4d8de0", mid: "#316dca", bot: "#2758a8" }
        : selGame?.installed
          ? { top: "#3fb950", mid: "#2ea043", bot: "#238a38" }
          : { top: "#4d8de0", mid: "#316dca", bot: "#2758a8" };
    playRowTop.backgroundColor = colors.top;
    playRowMid.backgroundColor = colors.mid;
    playRowBot.backgroundColor = colors.bot;
    playLbl.content = launching ? "󰅖 Launching" : run ? "󰅖 Running" : selGame?.installed ? "▶ Play" : "󰇚 Install";
    playBtn.height = btnH;
    playRowTop.visible = !tight;
    playRowBot.visible = !tight;

    const installedCount = games.filter((g) => g.installed).length;
    const userLines = [
      `User: ${session.personaName} (${session.accountName})`,
      `Games: ${games.length}  ·  installed: ${installedCount}`,
    ];
    statusPane.height = 4;
    statusText.content = userLines.join("\n");
  };

  render();

  // Warm the cover cache for the whole library in the background so switching
  // games shows art instantly instead of fetching on selection, and detect
  // games already running (launched outside the TUI) for the Play button.
  // Ordering is nearest-to-selection first so the visible window loads first.
  const warmCovers = (list: SteamGame[]) => {
    const near = list
      .map((game, i) => ({ game, d: Math.abs(i - selected) }))
      .sort((a, b) => a.d - b.d)
      .map((e) => e.game.appid);
    void coverCache.warm(near, (appid, fetched) => {
      if (fetched && currentGame?.appid === appid) cover.source = fetched;
    });
    for (const game of list) if (game.installed) refreshRunning(game.appid);
  };
  warmCovers(games);

  // Auto-reload: patch the accounts array in place, swap the active session,
  // keep the selection on the same game, and warm covers/running state for
  // anything new. Used by the change-detection poll (no manual keybind).
  const applyReload = (fresh: AccountLibrary[]) => {
    if (!fresh.length) return;
    const keep = currentGame?.appid ?? null;
    accounts.splice(0, accounts.length, ...fresh);
    accountIdx = Math.min(accountIdx, accounts.length - 1);
    games = accounts[accountIdx]!.games;
    session = accounts[accountIdx]!.session;
    // keep the per-account hide state: a library reload must not resurrect
    // (or drop) TUI-hidden games just because the underlying lists changed
    const idx = visibleGames().findIndex((g) => g.appid === keep);
    if (idx >= 0) selected = idx;
    else selected = Math.max(0, visibleGames().length - 1);
    offset = Math.max(0, Math.min(offset, selected));
    render();
    warmCovers(games);
  };

  // Poll a cheap disk fingerprint (luatools lists + install manifests) so
  // games added/removed via luatools, or installed/uninstalled anywhere,
  // appear/vanish within seconds of the change — no restart, no keybind.
  // Ownership data is TTL-cached in the library, so polls stay local-only.
  let lastSignature: string | null = null;
  let lastAchievementsSignature: string | null = null;
  let reloading = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const pollLibrary = async () => {
    const steamRoot = session.steamRoot;
    if (reloading || !steamRoot) return;
    const sig = await librarySignature(steamRoot).catch(() => null);
    const achSig = await achievementsSignature(steamRoot, session.accountId).catch(() => "");
    const ownedStaleMs = await ownedCacheAge(session.steamId64).catch(() => Number.POSITIVE_INFINITY);
    const ownedStale = ownedStaleMs > 10 * 60 * 1000; // auto-refresh owned lists lazily
    if (sig === null) return;
    if (sig === lastSignature && achSig === lastAchievementsSignature && !ownedStale) {
      lastSignature = sig;
      lastAchievementsSignature = achSig;
      return;
    }
    lastSignature = sig;
    lastAchievementsSignature = achSig;
    reloading = true;
    try {
      applyReload(await loadAllLibraries(steamRoot, ownedStale));
    } finally {
      reloading = false;
    }
  };
  void pollLibrary(); // primes lastSignature without reloading on startup
  pollTimer = setInterval(() => void pollLibrary(), 4000);

  renderer.on("resize", () => {
    render();
  });

  // Idle while a launched game runs: drop the render loop to ~1 fps so the TUI
  // cost vanishes behind the game; restore normal speed when the terminal is
  // focused again or the game exits.
  const normalFps = renderer.targetFps;
  let terminalFocused = true;
  let idleTimer: ReturnType<typeof setInterval> | null = null;
  const applyFps = () => {
    renderer.targetFps = runningIds.size > 0 && !terminalFocused ? 1 : normalFps;
  };
  renderer.on("focus", () => {
    terminalFocused = true;
    applyFps();
  });
  renderer.on("blur", () => {
    terminalFocused = false;
    applyFps();
  });
  const watchGameIdle = (appid: number) => {
    applyFps();
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = setInterval(() => {
      void isGameRunning(appid).then((running) => {
        const was = runningIds.has(appid);
        const wasLaunching = launching;
        if (running) runningIds.add(appid);
        else runningIds.delete(appid);
        launching = false;
        if (was !== running || wasLaunching) {
          applyFps();
          render();
        }
        if (!running && idleTimer) {
          clearInterval(idleTimer);
          idleTimer = null;
        }
      });
    }, 5_000);
  };

  renderer.keyInput.on("keypress", (key) => {
    if (paletteOpen) {
      if (key.name === "q" || key.name === "escape") {
        paletteOpen = false;
        render();
        return;
      }
      if (key.name === "up" || key.name === "down") {
        paletteSel = Math.max(0, Math.min(accounts.length - 1, paletteSel + (key.name === "down" ? 1 : -1)));
        render();
        return;
      }
      if (key.name === "return") {
        switchAccount(paletteSel);
        return;
      }
      return;
    }
    if (launchOpen) {
      if (key.name === "q" || key.name === "escape") {
        launchOpen = false;
        render();
        return;
      }
      if (key.name === "return") {
        const game = currentGame;
        if (game) {
          const conf: LaunchConf = {
            args: launchArgs,
            compat: compatSel,
            exec: launchExec,
            backend: backendOpts.length > 1 ? backendSel : -1,
            backendArgs: backendOpts.length > 1 ? (backendOpts[backendSel]?.args ?? "") : "",
          };
          launchConf.set(game.appid, conf);
          void saveLaunchConf(game.appid, conf);
        }
        launchOpen = false;
        render();
        return;
      }
      const hasExecs = launchExecs.length > 1;
      const hasBackends = backendOpts.length > 1;
      // same rule as render: backend row replaces the exec row
      const showExec = !hasBackends && hasExecs;
      const backendStage = hasBackends ? 1 : -1;
      const compatStage = hasBackends || showExec ? 2 : 1;
      const stages = compatStage + 1;
      if (key.name === "tab") {
        launchFocus = (launchFocus + 1) % stages;
        render();
        return;
      }
      // cycling keys only affect the row under focus
      if (backendStage >= 0 && launchFocus === backendStage && (key.name === "up" || key.name === "down" || key.name === "left" || key.name === "right")) {
        const n = backendOpts.length;
        const dir = key.name === "down" || key.name === "right" ? 1 : -1;
        backendSel = (backendSel + dir + n) % n;
        launchExec = backendSel > 0 ? (backendOpts[backendSel]?.exe || null) : null;
        render();
        return;
      }
      if (showExec && launchFocus === 1 && (key.name === "up" || key.name === "down")) {
        launchExecSel = Math.max(0, Math.min(launchExecs.length - 1, launchExecSel + (key.name === "down" ? 1 : -1)));
        launchExec = launchExecs[launchExecSel] ?? null;
        render();
        return;
      }
      if (launchFocus === compatStage && (key.name === "up" || key.name === "down" || key.name === "left" || key.name === "right")) {
        const n = COMPAT_OPTIONS.length;
        const dir = key.name === "down" || key.name === "right" ? 1 : -1;
        compatSel = (compatSel + dir + n) % n;
        render();
        return;
      }
      if (launchFocus === 0) {
        if (key.name === "backspace") launchArgs = launchArgs.slice(0, -1);
        else if (key.name === "space") launchArgs += " ";
        // append the raw sequence so shifted letters keep their case; opentui's
        // phantom keypress (name only, empty sequence) is filtered out
        else if (key.name && key.name.length === 1 && key.sequence && key.sequence >= " ") launchArgs += key.sequence;
        else return;
        render();
        return;
      }
      return;
    }
    if (webApiOpen) {
      if (key.name === "escape") {
        webApiOpen = false;
        webApiInput = "";
        render();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        const v = webApiInput.trim();
        if (/^[0-9a-fA-F]{32}$/.test(v)) {
          void writeApiKey(v).then(() => {
            webApiOpen = false;
            webApiInput = "";
            render();
          });
          return;
        }
        webApiInput = "";
        render();
        return;
      }
      if (key.name === "backspace") webApiInput = webApiInput.slice(0, -1);
      else if (key.name && key.name.length === 1 && key.sequence && key.sequence >= " " && key.sequence <= "~") webApiInput += key.sequence;
      else return;
      render();
      return;
    }
    if (key.name === "w") {
      if (modalOpen || launchOpen || paletteOpen || helpOpen) return;
      void readApiKey().then((k) => {
        webApiCurrent = k;
        webApiInput = "";
        webApiOpen = true;
        render();
      });
      return;
    }
    if (key.name === "e") {
      if (modalOpen) return;
      const game = currentGame;
      if (!game) return;
      const conf = launchConf.get(game.appid);
      launchArgs = conf?.args ?? "";
      compatSel = conf?.compat ?? 0;
      launchExec = conf?.exec ?? null;
      launchExecs = [];
      launchExecSel = 0;
      launchFocus = 0;
      backendSel = Math.max(0, conf?.backend ?? 0); // restore saved backend pick
      launchOpen = true;
      render();
      void loadLaunchExecutables(session.steamRoot, game.appid).then(async (execs) => {
        if (!launchOpen || currentGame?.appid !== game.appid) return;
        launchExecs = execs;
        launchExecSel = Math.max(0, execs.findIndex((x) => x === launchExec));
        if (launchExec) launchExec = execs[launchExecSel] ?? launchExec;
        const bopts = await loadLaunchOptions(session.steamRoot, game.appid);
        if (!launchOpen || currentGame?.appid !== game.appid) return;
        backendOpts = bopts;
        backendSel = bopts.length
          ? Math.min(Math.max(0, conf?.backend ?? backendSel), bopts.length - 1)
          : 0;
        if (!(bopts.length || execs.length > 1)) launchExec = null;
        render();
      });
      return;
    }
    if (key.name === ":") {
      if (modalOpen) return;
      paletteOpen = true;
      paletteSel = 0;
      render();
      return;
    }
    if (key.name === "i") {
      if (modalOpen) return;
      installedOnly = !installedOnly;
      selected = 0;
      offset = 0;
      render();
      return;
    }
    if (key.name === "d") {
      if (modalOpen) return;
      showDemos = !showDemos;
      selected = 0;
      offset = 0;
      render();
      return;
    }
    if (modalOpen) {
      if (key.name === "q") {
        modalOpen = false;
        render();
        return;
      }
      // j/k or up/down: navigate achievements in the modal
      if (key.name === "j" || key.name === "down" || key.name === "k" || key.name === "up") {
        const total = modalGame ? modalItems(modalGame, schemaCache, revealed).length : 0;
        if (key.name === "j" || key.name === "down") modalSel = Math.min(total - 1, modalSel + 1);
        else modalSel = Math.max(0, modalSel - 1);
        render();
        return;
      }
      // space: reveal/hide the selected hidden achievement (one-time peek)
      if (key.name === "space") {
        if (modalGame) {
          const it = modalItems(modalGame, schemaCache, revealed)[modalSel];
          if (it && it.hidden && !it.achieved) {
            const k = `${modalGame.appid}/${it.api.toLowerCase()}`;
            if (revealed.has(k)) revealed.delete(k);
            else revealed.add(k);
            render();
          }
        }
        return;
      }
      // h/l or left/right: change game while staying in the modal
      if (key.name === "h" || key.name === "left" || key.name === "l" || key.name === "right") {
        if (key.name === "h" || key.name === "left") moveSelection(-1);
        else moveSelection(1);
        modalGame = currentGame;
        modalSel = 0;
        modalScroll = 0;
        modalFirst = 0;
        if (modalGame) void schemaCache.ensure(modalGame.appid, () => render());
        return;
      }
      return;
    }
    if (key.sequence?.[0] === "H") {
      // H (shift+h): change view (toggle library <-> hide view)
      hideView = !hideView;
      render();
      return;
    }
    if (key.name === "h") {
      // h: in the library → hide the selected game (moves it into the hide
      // view without switching focus); in the hide view → unhide the game
      const game = displayGames()[selected];
      if (!game || !isGameRow(game)) return;
      if (hideView) {
        hiddenIds.delete(game.appid);
        hideView = false; // back to the library view
        void saveHidden();
        const pool = installedOnly ? games.filter((g) => g.installed) : games;
        selected = Math.max(0, pool.findIndex((g) => g.appid === game.appid));
        offset = 0;
        render();
        return;
      }
      hiddenIds.add(game.appid);
      void saveHidden();
      selected = Math.max(0, Math.min(selected, visibleGames().length - 1));
      offset = Math.max(0, Math.min(offset, selected));
      render();
      return;
    }
    if (key.name === "f") {
      if (modalOpen || launchOpen || paletteOpen || helpOpen) return;
      const game = displayGames()[selected];
      if (!game || !isGameRow(game)) return;
      if (favorites.has(game.appid)) favorites.delete(game.appid);
      else favorites.add(game.appid);
      void saveFavorites();
      render();
      return;
    }
    if (key.name === "?") {
      helpOpen = !helpOpen;
      render();
      return;
    }
    if (key.name === "q") {
      // hard-exit: clear every background timer/interval the TUI owns before
      // destroying the renderer, so the shell regains the prompt cleanly
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      if (idleTimer) clearInterval(idleTimer);
      idleTimer = null;
      renderer.destroy();
      process.exit(0);
    }
    if (key.name === "a") {
      modalOpen = true;
      modalGame = currentGame;
      modalSel = 0;
      modalScroll = 0;
      modalFirst = 0;
      if (modalGame) void schemaCache.ensure(modalGame.appid, () => render());
      render();
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      launchSelected();
      return;
    }
    if (key.sequence?.[0] === "K") {
      const game = currentGame;
      if (game) void killRunningGame(game.appid).then(() => refreshRunning(game.appid));
      return;
    }
    if (key.name === "j" || key.name === "k") {
      moveSelection(key.name === "j" ? 1 : -1);
      return;
    }
    if (key.name !== "up" && key.name !== "down") return;
    moveSelection(key.name === "down" ? 1 : -1);
  });
}
