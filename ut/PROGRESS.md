# PROGRESS — ut

## Current task

- [x] Remove the individual standalone projects: copy-verified legacy data
  into `~/.config/ut/` (db.json/favorites.json/config.json, byte-identical),
  moved `~/.cache/{mst,tvl,modify}` (166MB, covers/images) under `~/.cache/ut/`,
  then deleted `~/.config/{mst,tvl,modify}` and their cache dirs. utdirs.ts is
  now pure path helpers (migrateData dropped); migration test removed since
  the legacy dirs no longer exist. `tsc --noEmit` clean.

- [x] Replace tracker cycling with a selection menu (src/main.ts): TUI starts
  on a full-screen menu listing mst/tvl/modify; arrows/j/k move, enter opens,
  q quits the TUI. Inside a tracker, q returns to the menu instead of
  quitting; Ctrl+C/Ctrl+D still quit. Tab now goes back to trackers' own
  internal tab bindings. `tsc --noEmit` clean; commit pending user test.

- [x] Verify all three trackers render + switch, fix found bugs, trim Modify sidebar.

## Done

- Fixed `bin/ut` PATH wrapper (resolves real path via `readlink -f`).
- Removed leftover tvl per-frame debug log (`/tmp/opencode/ut.log`).
- Fixed tvl `deactivate()` never clearing `active` — tvl kept painting after tab switch.
- Modify favorites: atomic saves (tmp+rename) and a `.corrupt` backup when
  `favorites.json` is unparseable, so a bad file is never silently wiped.
- Modify visuals: sidebar narrowed to 74/26, help overlay restyled to the
  shared palette (panel `#11141c`, accent border). mst/tvl sidebars untouched;
  palettes were already shared across the three trackers.
- Verified in a real PTY: three-tab switching, favorite toggle persisted,
  corrupt-file backup created, `tsc --noEmit` clean.

- Scaffolded `~/Projects/ut` (bun + TypeScript + `@opentui/core@0.7.0`),
  vendored mst, tvl and Modify sources under `src/`.
- `src/slot.ts` defines the hosted-tracker contract; each tracker is wrapped:
  mst and tvl as slots in their `main.ts`, Modify as `startModify()` factory.
- Host `src/main.ts`: one renderer, per-tracker Box containers, Tab /
  Shift+Tab switching, key dispatch, shared gamepad, SIGINT/SIGTERM quit,
  mst headless `export`/`import` CLI.
- Ports: Screen and command palettes now accept an injected root container;
  Modify's key handler became a function (quit signal, `t` remapped from Tab).
- `tsc --noEmit` clean.

## Next moves

- Confirm all three trackers render and switch in a PTY; fix the tvl tab
  render if the last run showed a blank second slot.
- `bun link` the package so `ut` is on PATH; update this file and PLAN.md.
- Git commit the whole project.

## Notes

- OpenTUI quirk: a `BoxRenderable` hidden at construction (or while its
  children are added) never re-lays-out when shown. Host therefore attaches
  only the active box and re-attaches on switch.
- TVL's internal tabs now use digits 1-3 and Shift+Tab; plain Tab switches
  trackers. Modify's mod/resource pack toggle is now `t`.
- Host key routing is one `routeKey(k)` shared by keyboard and gamepad: menu
  keys while the menu shows, everything else to the active tracker. A slot's
  `key()` returning true now means "back to the menu", not quit.
- Paths live in `src/utdirs.ts`: ut owns `~/.config/ut/<tracker>/…` and
  `~/.cache/ut/<tracker>/…`. The standalone dirs are retired and deleted;
  a one-time migration (now removed from the code) seeded ut's home.
- The individual project repos `~/Projects/{mst,tvl,Modify}` were archived
  (unpushed history, no remotes) to
  `~/Projects/.retired-tracker-projects-2026-11-10.tar.gz`, then deleted.
  Delete that tarball when you're sure ut covers all three.
