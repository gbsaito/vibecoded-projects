import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { loadAllLibraries, readUnlockerAppids } from "../src/steam/library";
import { readSteamLibraries, readSteamUsers, readSteamPlaytimes } from "../src/steam/auth";
import { loadOwnedAppIds } from "../src/steam/webapi";
import { resolveAppMetas } from "../src/steam/names";

const steamRoot = "/home/backup/.local/share/Steam";
const users = await readSteamUsers(steamRoot);
const libraries = await readSteamLibraries(steamRoot);
for (const u of users) {
  const session = {
    ...u,
    steamRoot,
    libraries,
    playtimes: await readSteamPlaytimes(steamRoot, u.accountId),
  };
  const owned = await loadOwnedAppIds(session.steamId64, true);
  const unlockers = await readUnlockerAppids(steamRoot);
  const hidden = new Set<number>();
  const unhidden = new Set<number>();
  const dir = path.join(steamRoot, "userdata", session.accountId, "config", "cloudstorage");
  const files = (await readdir(dir).catch(() => [] as string[])).filter((n) => /^cloud-storage-namespace.*\.json$/.test(n));
  for (const name of files) {
    const raw: unknown = await Bun.file(path.join(dir, name)).json().catch(() => null);
    if (!Array.isArray(raw)) continue;
    for (const entry of raw) {
      if (!Array.isArray(entry) || entry[0] !== "user-collections.hidden") continue;
      let value: unknown = Array.isArray(entry[1]) ? null : (entry[1] as { value?: unknown })?.value;
      if (typeof value === "string") {
        try {
          value = JSON.parse(value as string);
        } catch {
          continue;
        }
      }
      const v = (typeof value === "object" && value !== null ? value : {}) as { added?: unknown; removed?: unknown };
      for (const id of Array.isArray(v.added) ? v.added : []) if (typeof id === "number") hidden.add(id);
      for (const id of Array.isArray(v.removed) ? v.removed : []) if (typeof id === "number") unhidden.add(id);
    }
  }
  for (const id of unhidden) hidden.delete(id);
  console.log("hidden:", [...hidden].sort((a, b) => a - b).join(","));
  const appids = [...new Set([...owned, ...unlockers])].filter((id) => id < 2 ** 31);
  const metas = await resolveAppMetas(steamRoot, appids);
  for (const id of [...owned].sort((a, b) => a - b)) {
    const meta = metas.get(id);
    const viaUnlocker = unlockers.includes(id);
    const isHidden = hidden.has(id);
    const tool = meta?.type && ["tool", "driver", "config", "hardware"].includes(meta.type);
    console.log(`  owned ${id} viaUnlocker=${viaUnlocker} hidden=${isHidden} tool=${tool} name=${JSON.stringify(meta?.name)} type=${JSON.stringify(meta?.type)}`);
  }
}
