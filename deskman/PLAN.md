# PLAN — deskman

## Objective

`deskman` is an interactive TUI (Node + Ink) to manage `.desktop` launcher files. The user's desktop menu shows too many entries; deskman makes it easy to hide (`NoDisplay=true`) or edit launchers.

## On-startup sync

Every launch, before showing the UI:

1. Ensure `~/.local/share/applications/` exists.
2. Copy any `*.desktop` from `/usr/share/applications/` into it, skipping files that already exist (system files stay pristine; local overrides rule per XDG spec).
3. Move any `*.desktop` sitting on `~/Desktop/` into the same directory.

## UI

fzf-style list of all `.desktop` files in `~/.local/share/applications`, sorted by name (`Name=` key from the file, filename as fallback). Schema is a subtree:

- `/` enters filter mode (case-insensitive substring on `Name` and filename). `Esc`/`Enter` leave the mode (`Esc` also clears the query), so `d` never collides with typing.
- `↑↓`, `j/k`, `PgUp/PgDn` move the selection; the window scrolls for long lists.
- `Enter` — edit the file with `$EDITOR` (Ink unmounts, editor runs on real terminal, list re-renders on return).
- `d` — move the selected file to the XDG trash (`~/.local/share/Trash/files` + matching `.trashinfo` under `info/`, suffixed on collision) so desktop environments can still restore it. Startup sync skips names already in the trash, so trashed system copies do not come back on the next launch.
- `h` — toggle `NoDisplay=true` in the `[Desktop Entry]` section:
  - line present with `true` → line removed (show again)
  - line present with other value → set to `true`
  - no line → inserted right after the `[Desktop Entry]` header
- `u` — undo the most recent `h`/`d` action, one step at a time (in-session history): re-toggles `NoDisplay`, or restores a trashed file to its original spot via its `.trashinfo`.
- `q` or `Ctrl+C` quits. The list UI runs in the terminal's alternate screen buffer, so on quit the screen returns to exactly what preceded the launch — nothing printed, nothing left behind.

- Files marked hidden render with a `[hidden]` tag but stay in the list.

## Tech

Node ESM, `ink` + `react`, no other runtime deps. Single file (`index.js`), plain JavaScript.

## Decisions

- User chose `/`-triggered filter mode over bare type-to-filter (avoids `d` conflict).
- Hiding uses `NoDisplay=true` rather than deleting or `Hidden=` (least destructive, reversible, works on both GNOME and KDE).
- Loop re-renders after every editor run / toggle so the list reflects on-disk state.
