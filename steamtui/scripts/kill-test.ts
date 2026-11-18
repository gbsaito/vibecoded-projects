// Self-check for launch.ts without touching the real Steam client:
// a fake process carrying SteamAppId=999999 must be found and killed by pid.
import { killRunningGame } from "../src/steam/launch";
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";

const proc = Bun.spawn(["sleep", "60"], {
  env: { ...process.env, SteamAppId: "999999" },
  stdout: "ignore",
  stderr: "ignore",
});
assert.equal(proc.exitCode, null);
await Bun.sleep(200);

const killed = await killRunningGame(999999);
console.log("killed", killed, "pid", proc.pid);

await Bun.sleep(200);
// SIGKILLed child is a zombie until the parent reaps it — check its state.
const statePath = `/proc/${proc.pid}/stat`;
const state = existsSync(statePath) ? readFileSync(statePath, "utf8").split(" ")[2] : null;
assert.ok(state === null || state === "Z", `process should be dead (state=${state})`);
assert.ok(killed >= 1);
console.log("launch selfTest OK");
