# PLAN — ut (ultimate tracker)

## Objective

Merge the three standalone OpenTUI trackers — `mst` (anime/series), `tvl`
(videogames) and `Modify` (Minecraft mods) — into a single TUI application,
`ut`. The Tab key alternates between the three trackers inside one terminal
window. Same stack: TypeScript + Bun + `@opentui/core` (OpenTUI), and `ut` is
on PATH.

## Design

- **Single renderer, tab containers.** `ut` owns one `createCliRenderer`
  instance. Each tracker lives in its own `BoxRenderable` container added to
  the renderer root; only the active tracker's container is attached. A
  hidden-but-attached container does not re-lay-out its children when shown
  again, so switching detaches the old box and attaches the new one.
- **Slot contract.** `src/slot.ts` defines `TrackerSlot` (key/activate/
  deactivate/resize/announce/dispose) and `SlotCtx` (renderer, root, quit).
  Each tracker is wrapped into this contract by its own module
  (`src/mst/main.ts`, `src/tvl/main.ts`, `src/modify/index.ts`).
- **Key routing.** A single `renderer.keyInput.on("keypress")` handler in
  `src/main.ts` intercepts plain Tab (next tracker) and Shift+Tab (previous
  tracker); everything else is forwarded to the active slot. A slot returning
  true requests quit for the whole app. The focused renderable is blurred
  when switching so an input in one tracker never swallows another's keys.
- **Per-tracker data.** Trackers keep their original data directories:
  `~/.config/mst/db.json`, `~/.config/tvl/db.json`,
  `~/.config/modify/favorites.json`. Merging the UI does not merge libraries.
- **Headless CLI kept.** `ut export [FILE]` and `ut import FILE [--merge]`
  operate on the mst library (same envelope as `mst export/import`).
  `--demo` seeds empty libraries, `--reload` clears tvl's caches.
- **Shared gamepad.** One gamepad reader (mst's) feeds keys to the active
  tracker. tvl's analog-stick/DPad reader is dropped in the merged app.
- **Failure isolation.** If a tracker fails to start (corrupt library), its
  slot is replaced with an error slot that shows the message instead of
  taking the whole TUI down.

## Key decisions

- Tab (and Shift+Tab) is reserved for tracker switching at the host level.
  The trackers' internal tab cycling (status tabs in mst, Search/Library/
  Wishlist in tvl) stays reachable through digits 1-5 / 1-3 and Shift+Tab.
- Modify's internal Tab toggle (Mods / Resource Packs) was remapped to `t`
  so Tab is free for tracker switching.
- Both trackers keep their own XDG paths so existing libraries are untouched.

## Phases

- [x] Phase 1 — Scaffold `ut`, vendored sources, slot contract, host renderer.
- [x] Phase 2 — mst, tvl and Modify hosted as slots with tab switching.
- [x] Phase 3 — Typecheck, PTY smoke tests, bun link onto PATH.

## Open questions

- None.
