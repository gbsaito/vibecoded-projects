# PLAN — steamtui

## Objective

Build a TUI with opentui + bun + typescript that shows the user's Steam library
(installed + uninstalled games) and, for the selected game, its achievements.

## Design

- Auth: local Steam client session reuse (loginusers.vdf / libraryfolders.vdf /
  librarycache).
- Data: per-app achievements from
  `userdata/<accountId>/config/librarycache/<appid>.json`
  (`achievements` section, `mapCache` progress in `achievement_progress.json`).
- TUI: `@opentui/core` imperative renderer, Box/Text renderables, keyInput.

## Decisions

- Local session auth (user choice) over WebAPI key flow.
- Librarycache covers all library apps (installed via libraryfolders).

## Features

- [ ] Game list (installed / not installed) with achievement counts.
- [ ] Sidebar with selected game's achievements.

## Next moves

- [ ] User verification of TUI in terminal.
- [ ] Optional: uninstalled-game name enrichment, friend achievements, notification hooks.
