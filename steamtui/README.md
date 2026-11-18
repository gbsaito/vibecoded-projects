# steamtui

Terminal UI (OpenTUI + Bun + TypeScript) for the Steam library: game list with
achievement progress and an achievements sidebar.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/gbsaito/steamtui/master/install.sh | bash
```

Requires a Steam client session on the machine.

## Run

```sh
bun install
bun run dev        # launch TUI (requires a Steam client session)
bun run smoke      # print library/achievement summary
bun run check      # tsc --noEmit
```

## Auth

Local Steam client session reuse:

- `config/loginusers.vdf` → steamId64, accountId, account/persona name
- `config/libraryfolders.vdf` → library folders + installed appids
- `userdata/<accountId>/config/librarycache/<appid>.json` → per-game
  achievements + `achievement_progress.json` → per-app progress

No WebAPI key / login flow.

## Names

- Installed games: `steamapps/appmanifest_*.acf`
- Uninstalled games: `appcache/appinfo.vdf` scan, then public store
  appdetails API (`filters=basic`, no auth), cached for 7 days in
  `~/.cache/steamtui/appnames.json`.
- System tools (Proton, Steamworks, Steam runtimes) are hidden, matching the
  Steam client library.

## Layout

- Header: persona, steamid64, game counts.
- Library box: `▶` selected, `●` installed / `○` not installed, `name nAchieved/nTotal`.
- Achievements box: vertical cover art on top, then game title, playtime line
  directly below it, one blank row, then achievement lines
  (`✓` achieved, `·` unachieved with progress%).

## Controls

- `↑/↓` or `j/k` — move selection
- `enter` — launch selected game through local Steam client
- `K` — kill running game of selected appid
- `f` — toggle favorite
- `d` — toggle demos
- `a` — open achievements modal for selected game (unlocked + locked)
- `e` — launch options (args · backend/exec · compat)
- `w` — Steam Web API key
- `i` — installed only
- `h` / `H` — hide/unhide game, toggle hide view
- `q` — quit / close modal

## Status

- Auth + library + achievements data flow working (smoke).
- TUI render verified in pty (`script -qec`).

## Release

```sh
git tag vX.Y.Z && git push origin vX.Y.Z   # tarball URL used by install.sh is live once the tag exists
gh release create vX.Y.Z --title "steamtui vX.Y.Z" --notes "…"   # creates the GitHub release page
```
