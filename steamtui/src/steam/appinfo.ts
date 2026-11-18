// Parses appinfo.vdf (binary, "appinfo v29" atoms) for appid->name.
// String atoms are: 0x01 <u32le key-id> <c-string>; key-id 1 = appid, 4 = name.
// Records are delimited by successive appid atoms; the name atom of a record
// is the first key-id-4 atom before the next appid atom.
import assert from "node:assert";
import path from "node:path";

export function parseAppinfoNames(data: Uint8Array): Map<number, string> {
  const decoder = new TextDecoder();
  const atoms: { keyId: number; value: string; end: number }[] = [];
  for (let i = 0; i < data.length - 6; i++) {
    if (data[i] !== 0x01) continue;
    const keyId =
      data[i + 1]! | (data[i + 2]! << 8) | (data[i + 3]! << 16) | (data[i + 4]! << 24);
    const nul = data.indexOf(0, i + 5);
    if (nul === -1 || nul - i > 80) continue;
    const value = decoder.decode(data.subarray(i + 5, nul));
    if (!/^[\x20-\x7e]+$/.test(value)) continue;
    if ((keyId === 1 && /^\d{2,12}$/.test(value)) || keyId === 4) {
      atoms.push({ keyId, value, end: nul + 1 });
      i = nul;
    }
  }
  const names = new Map<number, string>();
  for (let i = 0; i < atoms.length; i++) {
    if (atoms[i]!.keyId !== 1) continue;
    const appid = Number(atoms[i]!.value);
    const nextAppid = atoms[i + 1]?.keyId === 1 ? atoms[i + 1].end : Infinity;
    for (let j = i + 1; j < atoms.length && atoms[j]!.end < nextAppid; j++) {
      if (atoms[j]!.keyId === 4) {
        names.set(appid, atoms[j]!.value);
        break;
      }
    }
  }
  return names;
}

/**
 * Per-appid relative launch executables from appinfo records (binary key 486
 * carries the launch Executable path, e.g. `linux\\game.x86_64` or
 * `win\\game.exe`). Only appids in `targets` are reported.
 */
export interface LaunchRel {
  linux?: string;
  win?: string;
}

export function parseAppinfoLaunch(
  data: Uint8Array,
  targets: Set<number>,
): Map<number, LaunchRel> {
  const decoder = new TextDecoder();
  const out = new Map<number, LaunchRel>();
  let rec = 0;
  const push = (rel: string) => {
    const entry = out.get(rec) ?? (out.set(rec, {}), out.get(rec)!);
    if (/\.exe$/i.test(rel)) entry.win ??= rel;
    else entry.linux ??= rel;
  };
  for (let i = 0; i < data.length - 6; i++) {
    if (data[i] !== 0x01) continue;
    const keyId =
      data[i + 1]! | (data[i + 2]! << 8) | (data[i + 3]! << 16) | (data[i + 4]! << 24);
    const space = data.indexOf(0, i + 5);
    if (space === -1) break;
    const value = decoder.decode(data.subarray(i + 5, space));
    if (keyId === 1 && /^\d{2,12}$/.test(value)) {
      rec = Number(value);
      i = space;
    } else if (keyId === 486 && targets.has(rec) && space - i < 400) {
      const lower = value.toLowerCase();
      if (/^win[\\/]/.test(lower) || /\.exe$/i.test(lower)) push(value);
      else if (!/^macos[\\/]/.test(lower) && !/\.app[\\/]/.test(lower)) push(value); // bare or linux\
      i = space;
    }
  }
  return out;
}

/** Distinct launch executables (keyId 486 string-atoms) per appid — the raw
 * upstream of Steam's "launch options" dropdown (games with >1 entry). */
export function parseAppinfoLaunchExecutables(
  data: Uint8Array,
  targets: Set<number>,
): Map<number, string[]> {
  const decoder = new TextDecoder();
  const out = new Map<number, string[]>();
  let rec = 0;
  for (let i = 0; i < data.length - 6; i++) {
    if (data[i] !== 0x01) continue;
    const keyId =
      data[i + 1]! | (data[i + 2]! << 8) | (data[i + 3]! << 16) | ((data[i + 4]! << 24) >> 0);
    const space = data.indexOf(0, i + 5);
    if (space === -1) break;
    const value = decoder.decode(data.subarray(i + 5, space));
    if (keyId === 1 && /^\d{2,12}$/.test(value)) {
      rec = Number(value);
      i = space;
    } else if (keyId === 486 && targets.has(rec) && space - i < 400) {
      if (/^[\x20-\x7e ]+$/.test(value)) {
        const list = out.get(rec) ?? (out.set(rec, []), out.get(rec)!);
        if (!list.includes(value)) list.push(value);
      }
      i = space;
    }
  }
  return out;
}

export async function loadLaunchExecutables(steamRoot: string, target: number): Promise<string[]> {
  try {
    const data = new Uint8Array(
      await Bun.file(path.join(steamRoot, "appcache", "appinfo.vdf")).arrayBuffer(),
    );
    return parseAppinfoLaunchExecutables(data, new Set([target])).get(target) ?? [];
  } catch {
    return [];
  }
}

/** Per-appid launch options from appinfo records: keyId 486 = executable,
 * 487 = args for that option (e.g. `--rendering-driver opengl3` for an
 * OpenGL3 backend choice), keyId 408 = English "using Vulkan (preferred)"
 * label for backend options. Ordered: option N's label ↔ option N. */
export interface LaunchOption {
  exe: string; // relative path as stored (windows-style backslashes)
  args: string; // extra launch args for this option ("" for the default)
  label?: string; // Steam "using Vulkan (preferred)"-style label when found
}

export function parseAppinfoLaunchOptions(
  data: Uint8Array,
  targets: Set<number>,
): Map<number, { options: LaunchOption[]; labels: string[] }> {
  const decoder = new TextDecoder();
  const out = new Map<number, { options: LaunchOption[]; labels: string[] }>();
  let rec = 0;
  let pending: LaunchOption | null = null;
  const entry = (appid: number) =>
    out.get(appid) ?? (out.set(appid, { options: [], labels: [] }), out.get(appid)!);
  const flush = () => {
    if (!pending) return;
    const e = entry(rec);
    const key = `${pending.exe}|${pending.args}`;
    if (!/server/i.test(pending.exe) && !e.options.some((o) => `${o.exe}|${o.args}` === key)) e.options.push(pending);
    pending = null;
  };
  for (let i = 0; i < data.length - 6; i++) {
    if (data[i] !== 0x01) continue;
    const keyId =
      data[i + 1]! | (data[i + 2]! << 8) | (data[i + 3]! << 16) | (data[i + 4]! << 24);
    const space = data.indexOf(0, i + 5);
    if (space === -1) break;
    const value = decoder.decode(data.subarray(i + 5, space));
    if (keyId === 1 && /^\d{2,12}$/.test(value)) {
      flush();
      rec = Number(value);
      i = space;
    } else if (!targets.has(rec) || space - i > 400) {
      // skip
    } else if (keyId === 486 && /^[\x20-\x7e ]+$/.test(value)) {
      flush();
      pending = { exe: value, args: "" };
    } else if (keyId === 487 && pending) {
      pending.args = value;
    } else if (keyId === 408 && /vulkan|opengl/i.test(value)) {
      const labels = entry(rec).labels;
      if (!labels.includes(value)) labels.push(value);
    }
  }
  flush();
  return out;
}

export async function loadLaunchOptions(steamRoot: string, target: number): Promise<LaunchOption[]> {
  try {
    const data = new Uint8Array(
      await Bun.file(path.join(steamRoot, "appcache", "appinfo.vdf")).arrayBuffer(),
    );
    const raw = parseAppinfoLaunchOptions(data, new Set([target])).get(target) ?? { options: [], labels: [] };
    // options for the running platform first; fall back to Windows (Proton)
    const rel = (o: LaunchOption) => o.exe.replace(/\\/g, "/").toLowerCase();
    const plat = process.platform === "win32" ? "win" : process.platform === "darwin" ? "macOS" : "linux";
    let sel = raw.options.filter((o) => rel(o).startsWith(`${plat.toLowerCase()}/`));
    if (!sel.length && plat !== "win") sel = raw.options.filter((o) => rel(o).startsWith("win/"));
    if (!sel.length) sel = raw.options;
    return sel.map((o, i) => ({ ...o, label: raw.labels[i] ?? (o.args || "Default") }));
  } catch {
    return [];
  }
}

export async function selfTest(): Promise<void> {
  const data = new Uint8Array(
    await Bun.file("/home/backup/.local/share/Steam/appcache/appinfo.vdf").arrayBuffer(),
  );
  const names = parseAppinfoNames(data);
  assert.equal(names.get(1118520), "Paralives");
  assert.equal(names.get(1484720), "Dead Estate");
  assert.equal(names.get(1588550), "Cairn");
  assert.ok(names.size > 20, `names.size=${names.size}`);
  const launches = parseAppinfoLaunch(data, new Set([2737300, 1588550]));
  assert.equal(
    launches.get(2737300)?.linux,
    "linux\\garagerally.x86_64",
    `2737300 -> ${JSON.stringify(launches.get(2737300))}`,
  );
  console.log(`appinfo selfTest OK (${names.size} entries)`);
}
