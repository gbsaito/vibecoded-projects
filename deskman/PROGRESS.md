# PROGRESS — deskman

## Done

- Project scaffolded (package.json, Ink/React deps, ESM).
- Startup sync implemented (`index.js#sync`): copy system `.desktop`s missing locally, move from `~/Desktop`; skips names already in the XDG trash so trashed entries do not resurrect.
- fzf-style list UI: filter mode via `/`, arrow/vim navigation, scrolling window for long lists.
- `Enter` → `$EDITOR` (Ink unmounts during editor, re-renders after).
- `d` → trash the file (XDG trash: `files/` + `.trashinfo`, collision-suffixed); `h` → toggle `NoDisplay`; `u` → undo last toggle/trash.
- Self-check script (`test.js`) covers `toggleNoDisplay` (4 shapes), `trashDesktop` (move, .trashinfo, collision) and `restoreTrashed` (restore, unknown name) — all PASS.

## Current

Committed. TUI now runs in the alternate screen buffer (`\x1B[?1049h` on start, `\x1B[?1049l` on quit) so quitting restores the terminal to exactly what it was before launch — no list, no remnant. Awaiting user confirmation.

## Next

Manual run (`deskman`): confirm `d` sends entry to Trash (restorable from file manager) and `h` shows/hides it in the app menu.
