#!/usr/bin/env node
// deskman — manage .desktop launchers from the terminal
import React from "react";
import { render, Text, Box, useApp, useInput } from "ink";
import fs from "node:fs/promises";
import { readFileSync, writeFileSync, realpathSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const LOCAL = path.join(os.homedir(), ".local/share/applications");
const SYSTEM = "/usr/share/applications";
const DESKTOP = path.join(os.homedir(), "Desktop");

// Copy missing system .desktops into local; move loose Desktop ones there.
// Skip names already trashed so trashed system copies don't resurrect on next run.
async function sync() {
  await fs.mkdir(LOCAL, { recursive: true });
  const local = new Set(await fs.readdir(LOCAL));
  let trashed = new Set();
  try {
    trashed = new Set(await fs.readdir(path.join(TRASH, "files")));
  } catch {
    // no trash yet
  }
  try {
    for (const f of await fs.readdir(SYSTEM)) {
      if (!f.endsWith(".desktop") || local.has(f) || trashed.has(f)) continue;
      await fs.copyFile(path.join(SYSTEM, f), path.join(LOCAL, f));
      local.add(f);
    }
  } catch {
    // no system dir — ok
  }
  try {
    for (const f of await fs.readdir(DESKTOP)) {
      if (!f.endsWith(".desktop")) continue;
      await fs.rename(path.join(DESKTOP, f), path.join(LOCAL, f));
    }
  } catch {
    // no Desktop dir — ok
  }
}

async function loadEntries() {
  const files = (await fs.readdir(LOCAL)).filter((f) => f.endsWith(".desktop")).sort();
  return Promise.all(
    files.map(async (file) => {
      const text = await fs.readFile(path.join(LOCAL, file), "utf8");
      const name = text.match(/^Name=(.*)$/m)?.[1] ?? file;
      const hidden = /^NoDisplay\s*=\s*true\s*$/im.test(text);
      return { file, name, hidden };
    })
  );
}

// Toggle NoDisplay in [Desktop Entry]; returns new hidden state.
export function toggleNoDisplay(file, dir = LOCAL) {
  const p = path.join(dir, file);
  const text = readFileSync(p, "utf8");
  if (!/^\[Desktop Entry\]/im.test(text)) return null;
  let out;
  if (/^NoDisplay\s*=\s*true\s*$/im.test(text)) {
    out = text.replace(/^NoDisplay\s*=.*\n?/im, "");
  } else if (/^NoDisplay\s*=/im.test(text)) {
    out = text.replace(/^NoDisplay\s*=.*/im, "NoDisplay=true");
  } else {
    out = text.replace(/^(\[Desktop Entry\][^\n]*\n)/im, "$1NoDisplay=true\n");
  }
  writeFileSync(p, out);
  return /^NoDisplay\s*=\s*true\s*$/im.test(out);
}

// Move to XDG trash (~/.local/share/Trash) with .trashinfo so DEs can restore.
const TRASH = path.join(os.homedir(), ".local/share/Trash");
export async function trashDesktop(file, dir = LOCAL, trashRoot = TRASH) {
  const src = path.join(dir, file);
  const files = path.join(trashRoot, "files");
  const info = path.join(trashRoot, "info");
  await fs.mkdir(files, { recursive: true });
  await fs.mkdir(info, { recursive: true });
  let dest = path.join(files, file);
  for (let n = 2; existsSync(dest); n++) {
    dest = path.join(files, file.replace(/(\.desktop)?$/, `.trash-${n}$1`));
  }
  await fs.rename(src, dest);
  const entry = `[Trash Info]\nPath=${encodeURI(path.resolve(src))}\nDeletionDate=${new Date().toISOString().slice(0, 19)}`;
  await fs.writeFile(path.join(info, path.basename(dest) + ".trashinfo"), entry);
  return path.basename(dest);
}

// Restore a trashed file from its .trashinfo (used by undo).
export async function restoreTrashed(name, trashRoot = TRASH) {
  const files = path.join(trashRoot, "files");
  const info = path.join(trashRoot, "info");
  const infoPath = path.join(info, name + ".trashinfo");
  if (!existsSync(infoPath)) return null;
  const target = decodeURIComponent(
    readFileSync(infoPath, "utf8").match(/^Path=(.*)$/m)?.[1] ?? ""
  );
  if (!target) return null;
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (existsSync(target)) return null; // occupied — don't clobber
  await fs.rename(path.join(files, name), target);
  await fs.rm(infoPath);
  return target;
}

function App({ entries, onAction }) {
  const { exit } = useApp();
  const [filter, setFilter] = React.useState("");
  const [filtering, setFiltering] = React.useState(false);
  const [sel, setSel] = React.useState(0);

  const visible = entries.filter((e) =>
    (e.name + " " + e.file).toLowerCase().includes(filter.toLowerCase())
  );
  const last = Math.max(0, visible.length - 1);
  const cursor = Math.min(sel, last);
  const rowLimit = Math.max(3, (process.stdout.rows ?? 24) - 7);
  const top = Math.max(0, Math.min(cursor, last - rowLimit));
  const shown = visible.slice(top, top + rowLimit);

  const move = (dir) => setSel(Math.max(0, Math.min(cursor + dir, last)));
  const save = (action) => {
    const hit = visible[cursor];
    onAction({ action, file: hit ? hit.file : null });
    exit();
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") return save("quit");
    if (key.escape) {
      setFiltering(false);
      setFilter("");
      return;
    }
    if (filtering) {
      if (key.backspace || key.delete) setFilter((f) => f.slice(0, -1));
      else if (key.return || key.tab) setFiltering(false);
      else if (input) setFilter((f) => f + input);
      return;
    }
    if (key.upArrow || input === "k") return move(-1);
    if (key.downArrow || input === "j") return move(1);
    if (key.pageUp) return move(-rowLimit);
    if (key.pageDown) return move(rowLimit);
    if (key.return) return save("edit");
    if (input === "d") return save("trash");
    if (input === "h") return save("toggle");
    if (input === "u") return save("undo");
    if (input === "q") return save("quit");
    if (input === "/") setFiltering(true);
  });

  const h = React.createElement;
  return h(Box, { flexDirection: "column" },
    h(Box, { marginBottom: 1, flexDirection: "row" }, filtering
      ? h(Text, null, h(Text, { bold: true }, "filter: "), h(Text, { color: "cyan" }, filter), h(Text, { dimColor: true }, "  (esc clear · enter ok)"))
      : h(Text, { dimColor: true }, "/ filter · ↑↓ move · enter edit · d trash · h hide/show · u undo · q quit")
    ),
    shown.map((e, i) => {
      const isSel = top + i === cursor;
      return h(Box, { key: e.file, flexDirection: "row" },
        h(Text, {
          color: isSel ? "black" : undefined,
          backgroundColor: isSel ? "magenta" : undefined,
          bold: isSel,
        }, `${isSel ? "❯ " : "  "}${e.name}${e.hidden ? "  [hidden]" : ""}`, h(Text, { dimColor: true }, "  " + e.file))
      );
    }),
    h(Box, { marginTop: 1 },
      h(Text, { dimColor: true }, visible.length ? `${cursor + 1}/${visible.length}  ${visible[cursor].file}` : "no matches")
    )
  );
}

// One interactive pass; resolves { action, file | null }.
function runApp(entries) {
  const h = React.createElement;
  process.stdout.write("\x1B[?1049h\x1B[2J\x1B[3J\x1B[H"); // enter alt screen
  return new Promise((resolve) => {
    const { waitUntilExit } = render(h(App, { entries, onAction: resolve }), {
      exitOnCtrlC: false,
    });
    return waitUntilExit();
  });
}

if (process.argv[1]) {
  const argv_real = pathToFileURL(realpathSync(process.argv[1])).href;
  if (argv_real === import.meta.url) {
    const main = async () => {
  await sync();
  const history = [];
  while (true) {
    const entries = await loadEntries();
    const { action, file } = await runApp(entries);
    if (action === "quit") process.stdout.write("\x1B[?1049l"); // leave alt screen — terminal restored as before launch
    if (action === "edit" && file) {
      spawnSync(process.env.EDITOR || "vi", [path.join(LOCAL, file)], {
        stdio: "inherit",
      });
    } else if (action === "toggle" && file) {
      const nowHidden = toggleNoDisplay(file);
      if (nowHidden !== null) history.push({ type: "toggle", file });
    } else if (action === "trash" && file) {
      const dest = await trashDesktop(file);
      history.push({ type: "trash", from: file, to: dest });
    } else if (action === "undo") {
      const last = history.pop();
      if (last?.type === "toggle") toggleNoDisplay(last.file);
      else if (last?.type === "trash") await restoreTrashed(last.to);
    } else if (action === "quit") {
      break;
    }
  }
  process.exit(0);
};

  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
  }
}
