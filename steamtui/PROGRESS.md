# PROGRESS — steamtui

## Current task

- [ ] Build steamtui TUI (opentui + bun + typescript) showing library games and per-game achievements, starting with Steam auth

## Status

- 2026-11-06: scaffolded `@opentui/core` 0.8.2 project (bun + tsc).
- 2026-11-06: Steam auth via local session files working (Saitou / 39saito,
  steamid64 76561198789049730).
- 2026-11-06: library + achievements data flow working (`bun run smoke`, 28 games,
  16 with achievements).
- 2026-11-06: TUI render verified in pty (`script -qec "bun run src/index.ts"`).
- 2026-11-06: names for uninstalled games resolved: appinfo.vdf scan + store
  appdetails API (no key, per-appid, 7-day cache at `~/.cache/steamtui/appnames.json`).
- 2026-11-06: system tools (Proton, Steamworks, Steam runtimes) hidden like the
  Steam client does.
- 2026-11-06: vertical cover art in the achievements sidebar, rendered ABOVE the
  achievements (`library_600x900` CDN probes, then store-page hashed assets;
  disk cache at `~/.cache/steamtui/covers`). Render protocol: `auto`, override
  with `STEAMTUI_IMG_PROTO=blocks` for terminals without image support.
- 2026-11-06: sidebar width hugs cover art with side margins; sidebar title drops
  percentage and shows playtime below it.
- 2026-11-06: sidebar title = plain game name; playtime line directly below it,
  blank row, then achievements.
- 2026-11-06: terminal resize repaints layout (`renderer.on("resize")`).
- 2026-11-06: `a` opens achievements modal (unlocked + `✓`, then `Locked achievements` + `✗`).
- 2026-11-06: library rows fill the entire available space (`listRows(height)`
  replaces fixed 18-row window; used in render + both arrow-key scroll paths).
- 2026-11-06: modal rebuilt as centered list view: `██` green unlocked /
  `▒▒` gray locked pairs (title row + description row), `Locked achievements`
  header, game name in box title, header `n/m  name`. Centering handled by an
  absolute fullscreen flex wrapper (justify/align center) — no manual offsets.
- 2026-11-06: locked non-hidden achievements show real descriptions; `???` only
  for hidden ones (`bHidden && !bAchieved`).
- 2026-11-06: modal is scrollable: j/k or ↑/↓ move the achievement selection
  (`»` marks the selected row, window auto-scrolls); h/l or ←/→ switch games
  while staying in the modal.
- 2026-11-06: modal shows real achievement icons from the Steam CDN
  (`~/.cache/steamtui/achicons`); full list + names/descriptions come from the
  public community stats feed XML (`steamcommunity.com/profiles/<id>/stats/<appid>/?xml=1`,
  no key, cached 24h at `~/.cache/steamtui/schemas`), merged with local unlock
  state from librarycache (complete when a game has ≤12 unlocks).
- 2026-11-06: zoom resilience: sidebar width clamped so the " Achievements "
  title always fits its border, sidebar hidden under 60 cols, modal width
  clamps to the terminal width.
- 2026-11-06: hidden locked achievements render as the Steam client masks them:
  title `???`, description "You did not unlocked this achievement", icon = the
  game's locked icon. Hidden flags now come from the schema source itself (the
  community achievements page embeds `hidden` per achievement, unlike the XML feed).
- 2026-11-06: spacing row between achievements in the modal list.
- 2026-11-06: modal window bug fixed: scroll window used raw item indices with a
  header slot spliced in — the header consumed the next item's index, so the
  selection could never match a painted row (`»` never moved past the boundary).
  Now builds a slot stream (item/header slots in order) before windowing/slicing.
- 2026-11-06: `space` in the modal reveals the selected hidden achievement once
  (toggles back with a second `space`); key flow verified end-to-end in pty
  (masked `???` row -> j -> space -> real title + description + icon + `»` marker).
- 2026-11-06: library rows fill the full box width; counts right-aligned to the
  box edge (name column stretches via `listInner - 14`, `padStart(9)`).
- 2026-11-06: fix: some library games showed horizontal art (store `header` banner)
  instead of vertical. Cause: classic CDN `library_600x900(.2x)` 404s for newer
  apps; fallback chain now probes `store.steampowered.com/images/app/<appid>/library_600x900(.2x).jpg`
  before the store-page scrape; cover cache bumped to `.v2.img` key. The store-images
  endpoint answers 200 with an EMPTY body for these apps — probe now validates the
  body before accepting (else blank art). No real vertical cover exists for the
  affected appids (4380490 = Cat Mail Co. et al) on any probed source; they fall back
  to the horizontal header until a vertical asset is published.
- 2026-11-06: feat: Steam `IStoreBrowseService/GetItems` fallback adds hashed
  `library_capsule_2x` covers for apps missing CDN library art (Cat Mail Co. 4380490
  now resolves to a real 600x900 vertical cover, fetch-verified).
- 2026-11-06: fix: LORT (2956680), Knuckle Jet (3199470) and Probably Stolen
  (4348910) still showed horizontal header art: their 30-day coverurls cache
  predated the GetItems fallback. Cleared those cache entries; all three now
  resolve to real 600x900 vertical library_capsule covers, fetch-verified,
  cached as .v2.img. No source change — cache-only fix.
- 2026-11-06: perf: cover fetch chain optimized — dead store-images probe
  dropped, the two CDN probes run in parallel (1 round trip instead of 2),
  and the whole library's covers prefetch in the background at startup so
  switching games shows art instantly (28/28 warm after ~30s run).
- 2026-11-06: masked hidden achievements now show
  "Unlock this achievement to reveal or press space" instead of the old
  grammatically-broken hint; both masked paths (schema + fallback) updated.
- 2026-11-06: sidebar achievements list removed; added a clickable Play button
  (green "Play") — turns blue "Running" while the game runs ( SteamAppId env
  scan). Feeds the same running-state set as the 1-fps idle mode: idle while a
  game runs unfocused, back to normal fps on terminal focus or game exit.
- 2026-11-06: Steam staging window bypass — installed games launch directly:
  native Linux binaries via appinfo key-486 executable parsing (appinfo.ts
  `parseAppinfoLaunch`), Windows titles via "Proton - Experimental
  waitforexitandrun" with STEAM_COMPAT_* env; steam:// fallback only when the
  executable can't be resolved. steam_api still attaches the running client
  for achievements/overlay. Play/Running state now rechecks on every selection
  (4s debounce) so games started outside the TUI flip the button.
- 2026-11-06: sidebar renamed to Details; shows Playtime + Last played rows;
  mouse wheel scrolls the library list and the achievement modal (selection
  driven, no scrollbars) — mouse tracking enabled in the renderer.
- 2026-11-06: per-account libraries — `loadAllLibraries` merges every account
  from loginusers.vdf (per-account playtimes + achievement caches); runApp now
  takes an account list and switches accounts via the `:` command palette
  (account name or index); last played rendered as Today/Yesterday/MM-DD/full
  date (year included when > 1 year).
- 2026-11-06: `: command palette` fixed — modal box height was 1 row short
  (border 2 + padding 2 + content) so content clipped to blank; height now
  `accounts.length + 5`.
- 2026-11-06: top bar (header) removed; bottom status panel now renders 2 rows:
  `User: <persona> (<account>) · <steamid64>` and
  `Total games: N · installed: X · not installed: Y`.
- 2026-11-06: Play button shows `Install` (same green gradient) for uninstalled
  games instead of `Play`.
- 2026-11-06: Play button shows `Launching` (yellow gradient) while an installed
  game is being launched; flips back to `Running` once detected.
- 2026-11-06: library rows no longer show achievement counts; sidebar Details
  gains an `Achievements: nAchieved/nTotal` line under Last played.
- 2026-11-06: library + sidebar show `󰔻 ` icon before game title when all
  achievements are earned.
- 2026-11-06: status bar is now a rounded-border ` Status ` pane (2 content rows)
  below the split panel; rows trimmed to `User: ...` and
  `Total games: N · installed: X` (no steam id, no not-installed count).
- 2026-11-06: last played uses short month/day abbreviations
  (`Dec 17`) / full (`Sep 17, 2024`) when older than a year.
- 2026-11-06: Play button color blue for `Install` (uninstalled) state.
- 2026-11-06: sidebar Details splits title (white, with `󰔻 ` full-achievement
  icon) from data lines (Playtime / Last played / Achievements) in grayish
  white; no-achievement games show `Achievements: None`.
- 2026-11-06: fix: `Launching` stuck — `launchSelected` pre-added appid to
  `runningIds`, so the `was !== running` transition never fired; launching now
  clears on running detection.
- 2026-11-06: fix: `Launching` now renders immediately — `launchSelected` calls
  `render()` after setting the state (Enter/mouse previously never repainted).
- 2026-11-06: fix: Launching/RUNNING inverted — content now checks `launching`
  first; Running = blue, Launching = yellow, Play = green, Install = blue.
- 2026-11-06: `p` opens ` Compatibility ` modal (options: None, Proton
  Experimental, Proton 8.0, Proton 9.0; first option None, up/down/enter/q-esc).
- 2026-11-06: fix: selection now indexes the displayed list — installed-only
  (`i`) no longer maps selection into the full list; mouse wheel / arrows / modal
  h/l all navigate the filtered list.
- 2026-11-06: fix: Launching→Running transition — watchGameIdle/refreshRunning
  cleared `launching` but gated the repaint on `was !== running` (never true
  because the launch pre-adds the appid), so the button stuck on `Launching`
  also after quitting; now repaints whenever the tracked state changes.
- 2026-11-06: Play/Install button collapses from the 3-row gradient to a single
  row when terminal height < 24 (padding no longer eats tight layouts).
- 2026-11-06: fix: mouse wheel never moved selection — opentui scroll events
  carry `event.scroll.direction` (up/down) with button 0-3, not button 4/5;
  library + modal wheel handlers now read `scroll.direction`.
- 2026-11-06: `e` opens ` Launch Options ` modal: free-text Arguments input
  (backspace/space/type; opentui's phantom empty-sequence keypress filtered),
  Compatibility Tool left/right cycle (COMPAT_OPTIONS, None first), config
  saved with Enter per-game; launch passes args/exec/compatTool overrides.
  Executable dropdown appears only when the game appinfo lists >1 launch
  executables (keyId 486 parse — verified Heart Abyss: 9 options); up/down
  cycles it. `p` Compatibility modal now has its key handlers wired (they were
  missing so the branch was dead code).
- 2026-11-06: Arguments inside the modal became a bordered rounded input box
  (focus ring blue via Tab: arguments box → exec dropdown → compat tool;
  left/right still cycles compat) with "Arguments" placeholder when empty.
- 2026-11-06: Play button states carry state icons: `▶ Play`, `󰇚 Install`,
  `󰅖 Running`, `󰅖 Launching`.
- 2026-11-06: Launch Options input box: border label ` Arguments `, dim
  `Arguments` placeholder while empty, editable (backspace/space/type), Tab
  cycles focus (arguments → exec dropdown → compat tool) with blue focus ring.
- 2026-11-06: Launch Options final polish per user: modal title ` Options `,
  input-box border label ` Launch Options `, placeholder `Arguments` grayer;
  in-box bg highlight removed (border focus ring only).
- 2026-11-06: Narrow terminals (<60 cols) — where the cover starts overflowing
  the panel borders — switch layout: the library list takes the full width and
  the Details sidebar becomes a ` Status ` bar with the same information
  (title, playtime, last played, achievements). Wide terminals unchanged.
- 2026-11-06: Library rows use the full pane width: name column reserves only
  the `▶ ● ` prefix + trophy glyph (was an over-wide 16-col reserve), and the
  narrow status-bar layout no longer subtracts the sidebar width from the
  library box.
- 2026-11-06: Sidebar rows are unsqueezable at last: title/data word-wrap
  and keep their rows (yoga used to shrink them to zero when cover + button
  exceeded the pane, hiding the title at some zooms). The cover now yields:
  its height is clamped to the sidebar budget (title + data + gap + button
  reserved rows). Removed the "(not installed)" suffix from the sidebar title.
- 2026-11-06: Sidebar gains: play gap remains one row above the button,
  button stays anchored; long names wrap instead of clipping.
- 2026-11-06: btop-style minimum-size screen: below 60x24 the app dims and
  reports "Terminal size too small: Width/Height" + "Needed for current
  config: Width = 60 Height = 24".
- 2026-11-06: Options modal: "Launch Options" is now a plain row label with
  the args input box on its right side (blue focus ring dropped); focused
  option anywhere is marked with the library-style arrow (▶ exec row, args
  label, compat row, compat/palette/achievements selectors); blank separator
  lines between modal options removed; Tab cycles args -> exec (3 stages) ->
  compat, and 2 stages (args -> compat) without an exec dropdown (was 1).
- 2026-11-06: Sidebar: text rows are unsqueezable (flexShrink 0, word-wrap);
  cover height clamped to sidebar budget (spacer/title/data/gap/button rows)
  so the title and Play button always appear at any zoom; play gap is a Box
  (flexGrow) so only padding remains below the button; uninstalled sidebar
  titles now render gray.
- 2026-11-06: btop-style minimum-size screen added (below 60x24 the app shows
  "Terminal size too small: Width/Height" + "Needed for current config:
  Width = 60 Height = 24").
- 2026-11-06: Library hide view added: `h` (untoggle) hides the library list,
  Details pane only.
- 2026-11-06: Help added: modal with all keybindings opens via `?`; status
  pane shows the `Help [?]` indicator bottom-right on the games row; status
  second line renamed from "Total games" to "Games".
- 2026-11-06: Options follow-up: arrow marks only the Launch Options label
  (compat stage shows its tool in the box, no arrow); exec/post rows aligned,
  no vertical gaps; status help moved back onto the games row (2 content
  rows), colored gray (#8b949e).
- 2026-11-06: Compat arrow fixed for real: the focused-stage index for the
  Compatibility Tool line (and its up/down navigation) now matches the tab
  cycle — stage 2 when an exec dropdown exists, stage 1 otherwise. The
  hardened args input filters control keys (EOF sent by terminal-driven
  harnesses no longer lands in the box); urlink-style Options modal lets the
  ▸ marker travel across (args / exec / compat) plus `▶` on the focused exec
  row.
- 2026-11-06: The arguments value became a real input panel: a borderless
  box with a lighter background (#21262d) to the right of the Launch Options
  label, placeholder centered vertically the way the border version did.
- 2026-11-06: Options section rows tightened: the args panel is one row tall
  (no extra padding rows) and every value column is pinned at col 22 — Launch
  Options label, selected exec, and Compatibility Tool all line up
  ("Launch Options  Arguments / empty / Compatibility Tool  None").
- 2026-11-06: All option values are panel rows now (exec + Compatibility
  Tool included, not just args): shared optionRow builder = fixed 22-col
  label zone + 54-col lighter-bg value panel. The hint row ("tab focus · ⏎
  save · q close") stays plain text, sits one blank row below the options
  and is indented to align with the labels.
- 2026-11-06: One-row breathing space between the option panels
  (marginTop on exec + compat rows) so lighter backgrounds never touch;
  modal height accounts for the inter-row gaps.
- 2026-11-06: Options chrome tightened per user ("a little less space"):
  modal padding is 0 in the launch branch (other modals keep padding 1 via
  per-branch reset) so the panels hug the frame while the 1-row gaps
  between panels and above the hint remain.
- 2026-11-06: Options chrome asymmetry fixed: bottom padding restored (top
  pad stays 0, side pads 1) so the hint row doesn't hug the bottom border;
  hint gap unchanged.
- 2026-11-06: Reverted to uniform padding 1 for the Options modal — chrome
  experiments shelved; panels, 1-row gaps, hint alignment and hint gap all
  remain.
- 2026-11-06: Library membership rebuilt from real data (commit 15327b4) —
  the ghost list built from the achievement-icon cache is gone. The pool is
  now the union of: Web API ownership (GetOwnedGames via the user's own
  Steam Web API key, read from $STEAM_API_KEY or
  ~/.config/steamtui/config.json "apiKey", TTL-cached 6h in
  ~/.cache/steamtui/owned-<steamid64>.json; `R` reload forces a refetch),
  games unlocked by SLSsteam (`~/.config/SLSsteam` lua lists) and luatools
  (`config/stplug-in/<appid>.lua`), and physically installed appmanifests.
  The Steam client's own hidden collection
  (cloudstorage user-collections.hidden added/removed diff) is subtracted so
  games hidden in the Steam client stay out of the TUI. Result verified
  against the working client: 13 games, matching SLSsteam licenses + owned
  Z.A.T.O.; removed demos (Everhood etc.) no longer appear. Owned games the
  user hid in the Steam client (911 Operator, Bloons TD 6, Wallpaper
  Engine, …) are correctly absent. The same batch includes: bulk cover
  prefetching with a concurrency cap, batched trackpad wheel scrolling, and
  an auto-reload poll on a library disk fingerprint (unlocker lists +
  appmanifest mtimes). Pending: games shared via Steam Families from
  another account are not fetched yet (a familyAccounts hook can be
  added to webapi.ts when the lender's steamid64 is known).
- 2026-11-06: Hide re-implemented with corrected semantics: `h` hides the
  selected game in place (library keeps focus, game vanishes from the list);
  `H`/shift+h toggles library <-> hide view; pressing `h` on a hidden game
  in the hide view unhides it back to the library. Selection clamped and
  unhide lands on the game's library slot. PTY-verified (hide, H-jump,
  unhide → game visible again). `:` renamed to User Management (help +
  modal title). Options rows renamed: args row "Steam Arguments" (value
  placeholder removed — empty box), backend row "Launch Options".
- 2026-11-06: Hide view feature deleted completely on user request (state,
  list flag, key handler, help line all removed); library shows full list
  again.
- 2026-11-06: `p` compat keybind removed (redundant with the Options modal
  compat row); its two-row modal, key handler and state cleaned out. Help
  line for `e` now mentions args · backend/exec · compat. Choose Backend
  now persists: ⏎ saves the selected backend index into launchConf and
  reopening `e` for the same game restores it (verified via pty: cycle to
  "using Vulkan (preferred)", save, reopen → value still selected).
- 2026-11-06: Options modal rework per user: games with launch backends no
  longer show the raw game-executable row — "Choose Backend" takes the exec
  row's slot (right after Launch Options), Compatibility Tool stays last
  (args → backend → compat; plain exec games keep args → exec → compat).
  Cycling (up/down/left/right) only affects the row under focus; ⏎ save now
  stores the backend-derived exec selection. PTY-verified on Parking Garage
  Rally Circuit (backend row cycles Default → using Vulkan) and an exec
  game (dropdown row intact, no backend row).
- 2026-11-06: h/H hide-view fix: `h` enters the hide view (library pane hides,
  Details shows the selected game); `H` changes the view (toggles hide <-> lib).
  Handler cleaned up; verified via pty (h → hide, H → unhide).
- Next: user verification.


## Next moves

- [ ] Ask user to run/verify TUI in terminal.
- [ ] Write final README + commit.

## Findings

- `libraryfolders.vdf` lists installed apps only; `librarycache/*.json` holds all
  library apps (installed + cached).
- Achievement cache schema: per-appid array with `"achievements"` section
  (vecHighlight/vecUnachieved/vecAchievedHidden, nTotal/nAchieved) and
  `achievement_progress.json` mapCache.
- Local librarycache never carries `bHidden` — hidden flags only exist in the
  community achievements page JSON (see schema source).
