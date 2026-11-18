import path from "node:path";
import { existsSync } from "node:fs";
import { readdir, mkdir, readFile } from "node:fs/promises";
import { parseVdfFile, type VdfNode } from "../vdf";
import { parseAppinfoLaunch } from "./appinfo";

export const STEAM_URL = (appid: number): string => `steam://rungameid/${appid}`;
export const STEAM_INSTALL_URL = (appid: number): string => `steam://install/${appid}`;

function steamBin(steamRoot: string): string {
  if (process.env.STEAM_BIN) return process.env.STEAM_BIN;
  if (existsSync(path.join(steamRoot, "steam.sh"))) return path.join(steamRoot, "steam.sh");
  return "steam";
}

/**
 * Direct command for an installed game:
 * - native Linux executable → run it itself (no Steam staging window);
 * - Windows-only executable → run through the installed Proton directly
 *   (`proton waitforexitandrun`), which also skips the staging window;
 * - anything else → caller falls back to the `steam://` URL handoff.
 * steam_api still ties the process to the running client for achievements.
 */
export async function directLaunchCommand(
  steamRoot: string,
  appid: number,
  opts?: { exec?: string; compatTool?: string },
): Promise<{ cmd: string; args: string[]; cwd: string; env?: Record<string, string> } | null> {
  const manifest = (await parseVdfFile(
    path.join(steamRoot, "steamapps", `appmanifest_${appid}.acf`),
  )) as VdfNode | null;
  const appState = manifest?.AppState as VdfNode | undefined;
  const installdir = appState?.installdir;
  if (typeof installdir !== "string") return null;
  const data = new Uint8Array(
    await Bun.file(path.join(steamRoot, "appcache", "appinfo.vdf")).arrayBuffer(),
  );
  const rel = parseAppinfoLaunch(data, new Set([appid])).get(appid);
  if (!rel) return null;
  const appDir = path.join(steamRoot, "steamapps", "common", installdir);
  // explicit launch-option selection from the Launch Options modal wins
  const forced = opts?.exec ? path.join(appDir, opts.exec.replace(/\\/g, "/")) : null;
  if (forced && existsSync(forced)) {
    if (/\.exe$/i.test(forced)) {
      const proton = await protonBinFor(steamRoot, opts?.compatTool);
      if (proton) {
        await mkdir(path.join(steamRoot, "steamapps", "compatdata", String(appid)), { recursive: true }).catch(() => {});
        return {
          cmd: proton,
          args: ["waitforexitandrun", forced],
          cwd: steamRoot,
          env: {
            STEAM_COMPAT_CLIENT_INSTALL_PATH: steamRoot,
            STEAM_COMPAT_DATA_PATH: path.join(steamRoot, "steamapps", "compatdata", String(appid)),
            SteamAppId: String(appid),
            SteamGameId: String(appid),
          },
        };
      }
      return null;
    }
    return { cmd: forced, args: [], cwd: path.dirname(forced) };
  }
  if (rel.linux) {
    const exe = path.join(appDir, rel.linux.replace(/\\/g, "/"));
    if (existsSync(exe)) return { cmd: exe, args: [], cwd: path.dirname(exe) };
  }
  if (rel.win) {
    // ponytail: per-game runtime/depot overrides ignored — upgrade: read tool
    // config from appinfo.
    const exe = path.join(appDir, rel.win.replace(/\\/g, "/"));
    const protonBin = await protonBinFor(steamRoot, opts?.compatTool);
    if (protonBin && existsSync(exe)) {
      await mkdir(path.join(steamRoot, "steamapps", "compatdata", String(appid)), { recursive: true }).catch(() => {});
      return {
        cmd: protonBin,
        args: ["waitforexitandrun", exe],
        cwd: steamRoot,
        env: {
          STEAM_COMPAT_CLIENT_INSTALL_PATH: steamRoot,
          STEAM_COMPAT_DATA_PATH: path.join(steamRoot, "steamapps", "compatdata", String(appid)),
          SteamAppId: String(appid),
          SteamGameId: String(appid),
        },
      };
    }
  }
  // appinfo may lack a launch record (e.g. installs done via unlocker paths);
  // fall back to the conventional <installdir>/<installdir>.exe via Proton so
  // the launch stays silent like the rest of the library.
  const fallbackExe = path.join(appDir, `${path.basename(appDir)}.exe`);
  if (existsSync(fallbackExe)) {
    const protonBin = await protonBinFor(steamRoot, opts?.compatTool);
    if (protonBin) {
      await mkdir(path.join(steamRoot, "steamapps", "compatdata", String(appid)), { recursive: true }).catch(() => {});
      return {
        cmd: protonBin,
        args: ["waitforexitandrun", fallbackExe],
        cwd: steamRoot,
        env: {
          STEAM_COMPAT_CLIENT_INSTALL_PATH: steamRoot,
          STEAM_COMPAT_DATA_PATH: path.join(steamRoot, "steamapps", "compatdata", String(appid)),
          SteamAppId: String(appid),
          SteamGameId: String(appid),
        },
      };
    }
  }
  return null;
}

/** Picks the Proton binary: compat tool override > Experimental > first Proton dir. */
async function protonBinFor(steamRoot: string, compatTool?: string): Promise<string | null> {
  if (compatTool && compatTool !== "None") {
    const p = path.join(steamRoot, "steamapps", "common", compatTool, "proton");
    if (existsSync(p)) return p;
  }
  const experimental = path.join(steamRoot, "steamapps", "common", "Proton - Experimental", "proton");
  if (existsSync(experimental)) return experimental;
  const dir = path.join(steamRoot, "steamapps", "common");
  const candidates = (await readdir(dir).catch(() => [] as string[]))
    .filter((name) => /^Proton/i.test(name) && existsSync(path.join(dir, name, "proton")))
    .sort();
  return candidates[0] ? path.join(dir, candidates[0], "proton") : null;
}

/**
 * Silent install backend: an external installer command (e.g. `steamcmd +login
 * <user> <pass> +app_update <appid> +quit` or an Accela/Excella-style depot
 * downloader). Resolution order: per-appid override in
 * ~/.config/steamtui/config.json (`installCmd: { "<appid>": "<cmd>" }`) >
 * $STEAMTUI_INSTALL_CMD > (none → hand off to the local Steam client
 * `steam://install/<appid>`, which surfaces Steam's own install UI).
 */
const splitCmd = (raw: string): string[] | undefined => {
  const parts = raw.split(" ").map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
};

const envInstallCmd = (): string[] | undefined => splitCmd(process.env.STEAMTUI_INSTALL_CMD ?? "");

const configInstallCmd = async (appid: number): Promise<string[] | undefined> => {
  const dirs = [
    process.env.XDG_CONFIG_HOME,
    path.join(process.env.HOME ?? "/tmp", ".config"),
  ].filter((d): d is string => typeof d === "string" && d.length > 0);
  for (const dir of dirs) {
    try {
      const text = await readFile(path.join(dir, "steamtui", "config.json"), "utf8");
      const cfg = JSON.parse(text) as { installCmd?: Record<string, unknown> };
      const entry = cfg.installCmd?.[String(appid)];
      if (typeof entry === "string" && entry.trim()) return splitCmd(entry);
    } catch {
      // no config / invalid json / not found — try next candidate root
    }
  }
  return undefined;
};

/** Silent install command for an appid: per-game config override wins, then env. */
export async function installCmdFor(appid: number): Promise<string[] | undefined> {
  const perGame = await configInstallCmd(appid);
  if (perGame) return perGame;
  return envInstallCmd();
}

/** Asks the local Steam client to install the game (opens its install dialog),
 *  or runs a resolved silent installer command (per-game override / env) when set. */
export async function installGame(steamRoot: string, appid: number, opts?: { cmd?: string[] }): Promise<void> {
  const cmd = opts?.cmd ?? (await installCmdFor(appid));
  if (cmd && cmd.length) {
    Bun.spawn(cmd, {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      detached: true,
    });
    return;
  }
  Bun.spawn([steamBin(steamRoot), STEAM_INSTALL_URL(appid)], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
    detached: true,
  });
}

/** Launches the game through the local Steam client (does not block the TUI). */
export async function launchGame(
  steamRoot: string,
  appid: number,
  opts?: { args?: string; exec?: string; compatTool?: string },
): Promise<void> {
  const direct = await directLaunchCommand(steamRoot, appid, opts);
  if (direct) {
    // split user launch options: word + quoted tokens, quotes stripped
    const extra = opts?.args?.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((t) => t.replaceAll('"', "")) ?? [];
    Bun.spawn([direct.cmd, ...direct.args, ...extra], {
      cwd: direct.cwd,
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      detached: true,
      env: { ...process.env, ...direct.env, SteamAppId: String(appid), SteamGameId: String(appid) },
    });
  } else {
    Bun.spawn([steamBin(steamRoot), STEAM_URL(appid)], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      detached: true,
    });
  }
}

/** Finds every process whose environment carries SteamAppId=<appid> and kills it. */
export async function killRunningGame(appid: number): Promise<number> {
  const pids = await findGamePids(appid);
  let killed = 0;
  for (const pid of pids) process.kill(pid, "SIGKILL");
  return pids.length;
}

async function findGamePids(appid: number): Promise<number[]> {
  const pids = (await readdir("/proc").catch(() => [] as string[])).filter((p) => /^\d+$/.test(p));
  const out: number[] = [];
  for (const pid of pids) {
    try {
      const env = await readFile(`/proc/${pid}/environ`);
      if (!env.toString().split("\x00").includes(`SteamAppId=${appid}`)) continue;
      out.push(Number(pid));
    } catch {
      continue;
    }
  }
  return out;
}

/** True while at least one process carries SteamAppId=<appid>. */
export async function isGameRunning(appid: number): Promise<boolean> {
  return (await findGamePids(appid)).length > 0;
}
