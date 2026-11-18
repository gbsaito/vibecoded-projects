# PLAN.md — urlink

## Objective

Build a terminal UI bookmark manager inspired by linkding, using OpenTUI
(`@opentui/core` + `@opentui/react`) on Bun with TypeScript + React. The app
saves bookmarks (url, title, description, tags), browses them, fuzzy-finds
them, edits them, and opens the chosen url.

## Design Overview

- Stack: TypeScript, Bun runtime, `@opentui/core` (OpenTUI), `@opentui/react`,
  React 19, Bun as runner.
- Persistence: JSON store at `~/.config/urlink/bookmarks.json` with
  add / edit / delete (delete -> trash/archive) semantics.
- Rendering: OpenTUI renderables (Box / Text / Input / Select / ScrollBox)
  driven by React via `useRenderer`, `useKeyboard`, `useTerminalDimensions`;
  theme tokens.
- URL opening: spawn platform opener (`xdg-open` / `open` / `rundll32`).

## Features

1. Sidebar - the Tags section (heading, All, tags, Trash) at the top,
   toggleable tags (space/enter), the `←/→ move` / `space toggle` hint and the
   "urlink" title below it. Every row shares one inner padding value plus a
   selection gutter that is reserved on all rows, so text never shifts when the
   selection moves. The sidebar width is the base rail width minus one `PAD`,
   so the rail is one cell narrower without changing the TUI proportions.

- Mouse: left click on a sidebar tag row toggles that tag (via
      `onToggleTag`); renderer runs with `useMouse: true.
2. Bookmarks - title (white), #tags (green), description (blue / line below).
3. Edit panel - sections: url, tags, title, description; after a valid url +
   enter/space focus the tags input (space separated). While the tags input is
   focused, ghost text after the caret suggests the best-matching stored tag
   and Tab completes it (repeat Tab cycles the next match); ↑/↓ still move
   between fields, and Tab moves on when no suggestion is pending.
4. Operations - add (a), delete (d -> trash/archive), edit (e).
5. Fuzzy finder - `/`.
6. Themes - Dark, Light, Tokyo Night, Monokai, Everforest and Flexoki (the
   last four dark); `T` opens a theme panel, arrow keys choose, enter applies,
   the choice persists to `~/.config/urlink/config.json`.

7. Import / Export - `x` exports bookmarks (JSON default, CSV via
   `URLINK_EXPORT_FORMAT=csv`) to `URLINK_EXPORT` or a timestamped file in
   `~/.config/urlink`; `i` imports from `URLINK_IMPORT` (JSON default, CSV via
   `URLINK_IMPORT_FORMAT=csv`).

## Phases

- Phase 1 - Basics - sidebar, bookmarks, operations (a/d/e), fuzzy finder (/).
- Phase 2 - New Content - sorting, yank, help menu, undo.
- Phase 3 - Polishment - themes (visual polish), block cursor in the edit panel.
- Phase 4 - Optimization - perf, linux/macos compat, refactor.

## User Decisions

- Switched from Rust/ratatui to TypeScript/OpenTUI per user request, mirroring
  the tasker/modify OpenTUI rewrite pattern.
- OpenCode todo protocol (opentodo plugin) drives phase tracking: phases are
  `### Phase N - <name>` groups whose todos are the features.
- Themes: Dark and Light are the app's own palettes, defined in
  `src/theme.ts`; Tokyo Night mirrors the user's kitty theme
  (`~/.config/kitty/current-theme.conf`). Monokai, Everforest and Flexoki are
  dark-only palettes added on request. Dark is the default. Tokyo Night is the
  exact folke/tokyonight.nvim night palette, except the workspace background is
  `#1a1b27` (the night `bg` with +1 blue) because kitty renders cells matching
  the terminal background as transparent; the +1 keeps it solid and is
  invisible to the eye.
