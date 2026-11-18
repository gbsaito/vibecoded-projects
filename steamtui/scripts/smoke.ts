import { loadAllLibraries } from "../src/steam/library";
import { loadFor } from "../src/steam/library";

const accounts = await loadAllLibraries();
for (const a of accounts) {
  console.log(`user      ${a.user.personaName} (${a.user.accountName})`);
  console.log(`steamid64 ${a.user.steamId64}  accountid ${a.user.accountId}`);
  console.log(`libraries ${a.session.libraries.map((l) => l.path).join(", ")}`);
  const games = await loadFor(a.session);
  console.log(`games     ${games.length}`);
  for (const game of games) {
    const set = game.achievements?.achievements;
    const ach = set ? `${set.nAchieved}/${set.nTotal}` : "-";
    console.log(`${game.installed ? "installed" : "cached   "} ${String(game.appid).padStart(8)} ${ach.padStart(8)}  ${game.name ?? ""}`);
  }
}
