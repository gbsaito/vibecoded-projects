#!/usr/bin/env bun
/**
 * ut — the ultimate tracker.
 *
 * One OpenTUI renderer, three trackers behind a host selection menu:
 *   a tracker's q     back to the selection menu
 *   q in the menu     quits the TUI
 *   everything else   goes to the active tracker
 *
 * Trackers keep one shared home under ~/.config/ut: mst/tvl/modify each in
 * their own subdirectory, caches mirrored under ~/.cache/ut.
 */

import { TextRenderable, BoxRenderable, createCliRenderer } from "@opentui/core";
import type { KeyLike, SlotCtx, TrackerSlot } from "./slot.ts";
import { startMst } from "./mst/main.ts";
import { startTvl } from "./tvl/main.ts";
import { startModify } from "./modify/index.ts";
import { Gamepad } from "./mst/gamepad.ts";
import { Store } from "./mst/store.ts";
import { resolvePaths } from "./mst/paths.ts";
import {
  exportJson,
  expandPath,
  mergeEntries,
  readTransferFile,
  writeTransferFile,
} from "./mst/transfer.ts";

const args = process.argv.slice(2);

/** Help text for the TUI and the mst data commands. */
function printUsage(): void {
  console.log(`ut — the ultimate tracker (mst + tvl + Modify)

usage:
  ut                          start the TUI (tracker selection menu)
  ut export [FILE]            write the mst (anime/series) library as JSON
  ut import FILE [--merge]    read a JSON mst library

options:
  --demo      seed demo data into empty libraries on start
  --reload    clear the tvl caches (search + covers) before starting

Trackers and their data (ut owns everything under ~/.config/ut):
  animes        ut/mst/db.json            anime and series
  videogames    ut/tvl/db.json            videogames
  minecraft mods ut/modify/favorites.json Minecraft mods

Without FILE, "ut export" writes JSON to stdout.`);
}

function plural(n: number): string {
  return n === 1 ? "entry" : "entries";
}

/** Headless `ut export` / `ut import` for the mst library. */
function runTransferCli(kind: "export" | "import", rest: string[]): void {
  const file = rest.find((a) => !a.startsWith("-")) ?? null;
  const { db } = resolvePaths(null);
  try {
    const store = Store.load(db);
    if (kind === "export") {
      if (file === null || file === "-") {
        process.stdout.write(exportJson(store.entries));
        return;
      }
      const out = expandPath(file);
      writeTransferFile(out, store.entries);
      console.log(`exported ${store.length} ${plural(store.length)} to ${out}`);
      return;
    }

    if (!file) {
      console.error("ut: import needs a JSON file: ut import FILE [--merge]");
      process.exitCode = 1;
      return;
    }
    const source = expandPath(file);
    const doc = readTransferFile(source);
    if (rest.includes("--merge")) {
      const merged = mergeEntries(store.entries, doc.entries);
      store.replaceAll(merged.entries);
      store.save();
      const skipped = doc.skipped ? `, ${doc.skipped} skipped` : "";
      console.log(
        `imported ${doc.entries.length} ${plural(doc.entries.length)} from ${source} (${merged.added} added, ${merged.updated} updated${skipped})`,
      );
    } else {
      store.replaceAll(doc.entries);
      store.save();
      const skipped = doc.skipped ? `, ${doc.skipped} skipped` : "";
      console.log(
        `imported ${doc.entries.length} ${plural(doc.entries.length)} from ${source} (library replaced${skipped})`,
      );
    }
  } catch (e) {
    console.error(`ut: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

/** A slot that shows why a tracker failed instead of taking the TUI down. */
function errorSlot(
  renderer: SlotCtx["renderer"],
  root: SlotCtx["root"],
  name: string,
  message: string,
): TrackerSlot {
  const text = new TextRenderable(renderer, {
    position: "absolute",
    content: `${name} failed to start: ${message}`,
    fg: "#f7768e",
  });
  text.left = 2;
  text.top = 2;
  root.add(text);
  return {
    name,
    key: () => false,
    activate: () => {},
    deactivate: () => {},
    resize: () => {},
    announce: () => {},
    dispose: () => {},
  };
}

async function main(): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const cmd = args.find((a) => !a.startsWith("-"));
  if (cmd === "export" || cmd === "import") {
    runTransferCli(cmd, args.slice(args.indexOf(cmd) + 1));
    return;
  }

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: false,
    screenMode: "alternate-screen",
    consoleMode: "disabled",
    openConsoleOnError: false,
    targetFps: 30,
  });

  // One container per tracker. The active one is attached to the renderer
  // root; the inactive ones are detached until their tab is shown. (Hiding a
  // BoxRenderable does not re-lay-out its children when it is shown again.)
  const boxes = ["mst", "tvl", "modify"].map((_name) => {
    const box = new BoxRenderable(renderer, {
      width: "100%",
      height: "100%",
    });
    return box;
  });

  // Full-screen selection menu, shown at start and whenever a tracker's `q`
  // asks to leave it. `q` in the menu itself quits the TUI.
  const menuBox = new BoxRenderable(renderer, { width: "100%", height: "100%" });
  const menuText = new TextRenderable(renderer, {
    position: "absolute",
    left: 4,
    top: 2,
    fg: "#a9b1d6",
  });
  menuBox.add(menuText);
  let menuOpen = false;
  let menuSel = 0;

  const renderMenu = () => {
    menuText.content = [
      "",
      "ut — the ultimate tracker",
      "",
      ...slots.map((s, i) => (i === menuSel ? `▸ ${s.name}` : `  ${s.name}`)),
      "",
      "↑/k ↓/j: move · enter: open · q: quit",
    ].join("\n");
  };

  const showMenu = () => {
    if (shuttingDown || menuOpen) return;
    slots[current]?.deactivate();
    blurFocused();
    // Only detach when attached: removing a never-attached box makes OpenTUI
    // log a warning onto the screen.
    if (renderer.root.getChildren().includes(boxes[current]!)) {
      renderer.root.remove(boxes[current]!);
    }
    renderer.root.add(menuBox);
    menuOpen = true;
    menuSel = 0;
    renderMenu();
    renderer.requestRender();
  };

  const openTracker = (i: number) => {
    if (shuttingDown) return;
    renderer.root.remove(menuBox);
    menuOpen = false;
    show(i);
  };

  const slots: TrackerSlot[] = [];
  let current = 0;
  let shuttingDown = false;
  let gamepad: Gamepad | null = null;

  function shutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const s of slots) {
      try {
        s.deactivate();
        s.dispose();
      } catch {
        /* one broken tracker must not block the exit */
      }
    }
    gamepad?.close();
    try {
      renderer.stop();
      renderer.destroy();
    } catch {
      /* the terminal may already be gone */
    }
    process.exit(0);
  }

  const make = async (i: number): Promise<TrackerSlot> => {
    const ctx: SlotCtx = { renderer, root: boxes[i]!, quit: shutdown };
    try {
      if (i === 0) return startMst(ctx, { demo: args.includes("--demo") });
      if (i === 1) {
        return startTvl(ctx, {
          demo: args.includes("--demo"),
          reload: args.includes("--reload"),
        });
      }
      return await startModify(ctx);
    } catch (e) {
      return errorSlot(renderer, boxes[i]!, ["animes", "videogames", "minecraft mods"][i]!, (e as Error).message);
    }
  };

  for (let i = 0; i < boxes.length; i++) slots.push(await make(i));

  const blurFocused = () => {
    const f = renderer.currentFocusedRenderable as { blur?: () => void } | null;
    f?.blur?.();
  };

  const show = (next: number) => {
    if (shuttingDown) return;
    if (next !== current) {
      slots[current]!.deactivate();
      blurFocused();
      if (renderer.root.getChildren().includes(boxes[current]!)) {
        renderer.root.remove(boxes[current]!);
      }
      current = next;
      renderer.root.add(boxes[current]!);
    } else if (!renderer.root.getChildren().includes(boxes[current]!)) {
      renderer.root.add(boxes[current]!);
    }
    slots[current]!.activate();
    slots[current]!.announce(`${slots[current]!.name} · q: tracker menu`);
    // Force a full layout after attach: tvl's carousel live-loop and
    // setImmediate paints start before the box is attached, so the carousel
    // never paints.
    renderer.requestRender();
  };

  // One route for keyboard and gamepad: menu keys while the menu shows,
  // everything else to the active tracker (returning true = back to menu).
  const routeKey = (k: KeyLike) => {
    if (k.ctrl && (k.name === "c" || k.name === "d")) {
      shutdown();
      return;
    }
    if (menuOpen) {
      if (k.name === "up" || k.name === "k") {
        menuSel = (menuSel + slots.length - 1) % slots.length;
      } else if (k.name === "down" || k.name === "j" || k.name === "tab") {
        menuSel = (menuSel + 1) % slots.length;
      } else if (k.name === "enter" || k.name === "return") {
        openTracker(menuSel);
      } else if (k.name === "q") {
        shutdown();
      }
      renderMenu();
      renderer.requestRender();
      return;
    }
    if (slots[current]?.key(k)) showMenu();
  };

  renderer.keyInput.on("keypress", routeKey);

  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  renderer.on("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      slots[current]?.resize();
    }, 80);
  });

  // One gamepad for the whole TUI; its buttons feed the active tracker's keys.
  gamepad = Gamepad.detect();
  if (gamepad) {
    const pad = gamepad;
    setInterval(() => {
      if (shuttingDown) return;
      for (const k of pad.poll(Date.now())) routeKey(k);
    }, 30);
  }

  showMenu();
  renderer.start();

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

// Noise from undici and the experimental FFI flag is harmless; keep stderr clean.
const _origConsoleError = console.error;
console.error = (...a: unknown[]) => {
  const msg = a.map((x) => String(x)).join(" ");
  if (
    msg.includes("socket idle timeout") ||
    msg.includes("UND_ERR_INFO") ||
    msg.includes("InformationalError") ||
    msg.includes("FFI is an experimental feature")
  ) {
    return;
  }
  _origConsoleError(...a);
};

process.on("uncaughtException", (err) => {
  const msg = String((err as { message?: unknown })?.message ?? err ?? "");
  if (
    msg.includes("socket idle timeout") ||
    msg.includes("UND_ERR_INFO") ||
    msg.includes("InformationalError") ||
    msg.includes("FFI is an experimental feature")
  ) {
    return;
  }
  console.error("uncaughtException:", err);
});

process.on("unhandledRejection", (reason) => {
  const msg = String((reason as { message?: unknown })?.message ?? reason ?? "");
  if (
    msg.includes("socket idle timeout") ||
    msg.includes("UND_ERR_INFO") ||
    msg.includes("InformationalError")
  ) {
    return;
  }
  console.error("unhandledRejection:", reason);
});

const _origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (
  chunk: string | Uint8Array,
  encoding?: BufferEncoding | ((err?: Error | null) => void),
  cb?: (err?: Error | null) => void,
) => {
  const msg = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
  if (
    msg.includes("socket idle timeout") ||
    msg.includes("UND_ERR_INFO") ||
    msg.includes("InformationalError") ||
    msg.includes("FFI is an experimental feature")
  ) {
    if (typeof encoding === "function") encoding(null);
    else if (cb) cb(null);
    return true;
  }
  return _origStderrWrite(chunk as never, encoding as never, cb);
};

await main();
