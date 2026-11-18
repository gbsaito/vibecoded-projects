# PROGRESS.md — urlink

## Objective

Terminal bookmark manager inspired by linkding, built with OpenTUI
(`@opentui/core` + `@opentui/react`).

## Design

- JSON store at `~/.config/urlink/bookmarks.json`.
- OpenTUI renderables + React hooks, modal overlays, theme tokens.

## Phases

### Phase 1 - Basics

- [x] Sidebar: urlink title, toggleable tags (space/enter), padding
- [x] Bookmarks: title (white) #tags (green) + description (blue/line below)
- [x] Edit panel: url -> tags -> title -> description flow; after a valid url +
      enter/space focus the tags input (space separated)
- [x] Operations: add (a), delete (d -> trash/archive), edit (e)
- [x] Fuzzy finder (/)

### Phase 2 - New Content

- [x] Sorting (s -> name, date added, etc)
- [x] Yank selection url
- [x] Help menu (with all keybinds)
- [x] Undo for add/edit/delete operations

### Phase 3 - Polishment

- [x] Themes (visual polish)
- [x] Block cursor in the add/edit panel input fields
- [x] Tag autosuggestions while adding/editing a bookmark
- [ ] Experiment with selection styles (background, background + left border, arrow, etc)

### Phase 4 - Optimization

- [ ] Optimize source code for max performance and linux/macos compatibility
- [ ] Refactor code to be more scalable and easier to add features

## Done

- Tag autosuggestions: while the Tags field is focused in the add/edit panel,
  the remainder of the best-matching existing tag is shown as ghost text after
  the caret (faint color), and Tab completes it; repeated Tab presses cycle
  through the next matches (type-ahead, rotation). Suggestions are prefix
  matches against all tags in the store, tags already typed are excluded, and
  when the word exactly matches the only remaining candidate Tab moves to the
  next field again (↑/↓ always move between fields). Demoed: caret at end,
  caret after a space (suggests all remaining tags), mid-word completion, and
  case-insensitive prefixes. Covered by tests in `test/editTags.test.ts`.

- UI: the sidebar was reordered. The Tags section (heading, All, the tag
  entries and Trash) now sits at the top of the rail, the `←/→ move` and
  `space toggle` hint stays at the bottom, and the `urlink` title moved to the
  last line directly below the `space toggle` hint. The hint text itself is
  unchanged.

- UI: every sidebar row now derives its left edge from one shared inner
  padding (`PAD`) plus a selection gutter (`GUTTER`), so the Tags heading, tag
  items, hint and `urlink` all start in the same column; no literal leading
  spaces are used. The `▸` selection marker lives inside the reserved gutter,
  which is painted blank on every row, so item text keeps its column when the
  selection moves. Verified with the OpenTUI test renderer at 100x20, 140x30
  and 90x16 plus a real pty render at 100x20 and after a resize to 90x16:
  heading, items, hint and title all report column 3, and a selection sweep
  through All, #repo, #yt keeps every item label at column 3.

- UI fix: the blank row above the interface was not a stray row but the top
  padding of the two top-level regions: the sidebar's Tags container used
  `padding={1}` and the main column used `style={{ padding: 1 }}`. Both regions
  now take their padding from one shared `PAD` constant in `src/layout.ts`, so
  the top gap is exactly one row — the same value as the left/right padding
  that keeps rows off the sidebar and terminal borders — instead of an
  unexplained extra row. Removing the gap entirely was wrong and was reverted.
  A rectangle dump of the render tree confirms the root and both regions start
  at y=0, with their first content row at y=1. Verified with the test renderer
  and a real pty render at 100x20, 140x30 and after a forced resize to 90x16:
  first sidebar row and first main-panel row report y=1, the main content starts
  one column after the sidebar edge, and heading, items, hint and title all
  report column 3.

- UI fix: the oversized top band was addressed by reducing the sidebar width
  only. An earlier attempt inset the whole interface by `PAD` on all four sides
  and was reverted because it changed the TUI proportions; the root layout is
  unchanged. The rail now uses `sidebarWidth = clamp(width * 0.2) - PAD`, so it
  is one cell narrower than before (20 -> 19 columns at 100 wide, 18 -> 17 at
  90, 28 -> 27 at 140) and the main panel gains that cell. Verified with the
  test renderer and a real pty render at 100x20, 140x30 and after a forced
  resize to 90x16: first sidebar row and first main-panel row both report y=1,
  heading, items, hint and title report column 3, and the main content starts
  one column after the sidebar edge.

- Feature: mouse support shipped. The renderer was switched to
  `useMouse: true`, and the sidebar now handles left-button `down` on the rail
  and toggles the clicked tag through the existing `onToggleTag` callback
  (`All` clears, `Trash` switches to trash). Verified with the OpenTUI test
  renderer and mock mouse: click on the `#repo` row adds the `#repo` filter
  (✓ appears on that row), click again removes it.

- Feature: shared layout constants. All padding/margins now come from
  `src/layout.ts` (`PAD`, `MODAL_VERTICAL_PAD`, `MODAL_HORIZONTAL_PAD`,
  `PANEL_SECTION_GAP`, `BOOKMARK_VERTICAL_GAP`), replacing ad-hoc `padding={1}`
  / `height={1}` values across the sidebar, main panel, fuzzy search, modals and
  bookmark list. Bookmark entries are wrapped in a scrollbox child with
  `rowGap={BOOKMARK_VERTICAL_GAP}` (0), keeping entries adjacent with zero
  vertical space between bookmarks. Typecheck clean; render re-verified.
  (Later: clicking `All` from the trash view returns to the saved view.)

- Phase 3: Tokyo Night now uses the folke/tokyonight.nvim night palette
  (`bg_dark`, `fg_gutter`, `bg_highlight`, `fg`, `green`, `blue`,
  `bg_visual`, `comment`, `fg_dark`). The workspace background is `#1a1b27`,
  the night background shifted by one step in blue, because kitty paints cells
  that exactly match the terminal background as transparent. Typecheck clean,
  58/58 tests pass, and a pty render confirmed the solid background.

- Phase 3: theme apply no longer writes a status line (the `theme: ...`
  message is gone). The sort indicator moved from the bottom bar to a new top
  bar; the status line now only shows transient messages. Typecheck clean,
  58/58 tests pass, and a pty render confirmed sort renders on top.

- Phase 3: reduced the gap between the top of the main area and the sort bar by
  dropping the padded column wrapper and the bookmark-list padding; the sort
  bar now sits flush at the top with the list directly below it. Reverted that
  layout change and moved the sort indicator back to the bottom bar as
  requested; typecheck clean, 58/58 tests pass.

- Phase 3: added the dark-only Monokai, Everforest and Flexoki palettes to the
  theme panel, which now lists six themes (Dark, Light, Tokyo Night, Monokai,
  Everforest, Flexoki). Each theme row shows its own swatches and the active
  theme marker. Typecheck clean, 57/57 tests pass, and a pty smoke test
  opened the panel and applied Flexoki.

- Phase 3: import / export shipped. `x` exports bookmarks (JSON default, CSV via
  `URLINK_EXPORT_FORMAT`) to `URLINK_EXPORT` or a timestamped file in
  `~/.config/urlink`; `i` imports from `URLINK_IMPORT` (JSON default, CSV via
  `URLINK_IMPORT_FORMAT`) or, when the flag is unset, from the latest
  `urlink-export-*.json` in `~/.config/urlink` (`defaultImportPath`).
  Typecheck clean, 62/62 tests pass, and a pty render confirmed export status
  output. Later runs: 74/74 tests pass.

- Phase 3: fixed delete semantics. The sidebar tag rail now includes a
  `Trash` entry (after `All`); ←/→/space/enter navigate into it and switch the
  view to trash, moving back out restores the saved view. In the trash view,
  `d` now deletes permanently instead of re-archiving. Typecheck clean, 64/64
  tests pass.

- Phase 3: pressing space while the tag rail is on `All` now clears every
  toggled tag filter. Mouse wheel scrolling over the bookmark list moves the
  selection via the new `onMouseScroll` handler on the content box. Typecheck
  clean, 65/65 tests pass.

- Phase 3: fuzzy find input reworked into a proper caret-driven input at the
  top (with `search:` label). `/` always opens with an empty query and caret at
  0, never prefilled from the selected bookmark; typing inserts at caret,
  ←/→ move (ctrl/alt = word), home/end, ⌫/delete delete (ctrl/alt = word),
  escape/enter close. Typecheck clean, 70/70 tests pass.

- Phase 3: fuzzy search replaced with case-insensitive substring matching
  (`matchFilter`); `printer` now recognizes `PRINTER`. Typecheck clean, 68/68
  tests pass.

- Phase 3: sidebar `Tags` heading aligned with the `urlink` title column via a
  shared `padding={1}` on the tags container; selection marker gutter kept.
  Typecheck clean, 68/68 tests pass. pty check: both at column 2.

- UI fix: Tokyo Night painted the workspace in the kitty background colour
  (`#1a1b26`), so the theme looked transparent. The workspace now uses Tokyo
  Night storm (`#1f2335`) while the sidebar stays `#16161e`, keeping the
  palette but reading as a solid surface. Typecheck clean, 53/53 tests pass,
  and a pty render confirmed the new background is emitted.

- Phase 3: added three themes in `src/theme.ts` — Dark and Light (urlink's own
  palettes) and Tokyo Night (matching the kitty theme) — with `T` opening a
  theme panel that shows swatches and the current selection; ↑/↓ choose, enter
  applies, esc closes, and the choice persists to `~/.config/urlink/config.json`.
  Dark is the default. Typecheck clean, 53/53 tests pass, and a pty smoke test
  confirmed the panel opens and applies Light.

- Phase 3: edit panel inputs now track a caret — ←/→ move it, ctrl/alt+←/→ jump by word, home/end jump to the field bounds, ⌫/delete remove one character (ctrl/alt: whole word), and typing inserts at the caret. The caret resets to the end of the field when switching fields. Typecheck clean, 41/41 tests pass.

- Phase 3: the block cursor in the edit panel fields (and the fuzzy search line) now blinks at ~530ms through a shared `BlinkingCursor` component, resetting to visible when typing or changing fields. Typecheck clean, 35/35 tests pass.

- UI fix: the add/edit and help modal overlay no longer paints a solid full-screen background (`theme.overlay` removed from `Theme`), so terminal transparency and the wallpaper stay visible behind the panel; the panel surface itself remains solid, the bookmark list stays rendered behind the modal, and its scrollbox is unfocused while a modal is open. Typecheck clean, 35/35 tests pass.

- Phase 4 (partial): TikTok video captions are parsed from the page hydration JSON (`tiktokVideo` / `parseTikTokPage`), so the title fills with the real caption. Instagram posts remain unsupported: the page is login-walled with no public OG metadata or caption, and Instagram oEmbed requires an access token. Typecheck clean, 35/35 tests pass.

- Phase 4 (partial): metadata compatibility checked for common sites. GitHub and X work out of the box. Medium pages return 403, so Medium uses the author RSS feed (`mediumFeedUrl` / `parseMediumFeed`) for title plus first-paragraph description; only posts still in the recent feed are covered. Reddit is network-blocked here (403 on HTML, JSON and RSS, and on third-party proxies), so it has no client-side fix. Typecheck clean, 32/32 tests pass.

- Phase 4 (partial): YouTube URLs now use the player API (`fetchYouTubeApi`) for title + description because scraping `youtube.com/watch` returns a 429 "sorry" page; oEmbed then HTML scrape are fallbacks, and watch/youtu.be/shorts/embed/live shapes are supported. Typecheck clean, 28/28 tests pass.

- Phase 4 (partial): no-op keys now return the same state ref (no re-render churn); undo history capped at 25 entries (user decision); edit-state logic extracted to `src/editOps.ts` with shared URL helpers in `src/url.ts`; list sorting deduped via shared `sortCompare`. Typecheck clean, 26/26 tests pass.

- Phase 4 (partial): URL metadata fetch now cached per normalized URL (`src/store.ts`); fetch skipped when edit panel already has title+description filled (App). Repeat fetches ~0ms, first fetch network-bound (~0.7s in tests). Typecheck clean, 26/26 tests pass.

- Phase 1 - Basics shipped: sidebar, bookmark list, add/edit/delete ops,
  fuzzy finder, JSON store, key handling, tests. Typecheck clean, 15/15 tests
  pass, TUI renders under Bun + OpenTUI React. Edit panel later fixed to match
  tasker design (centered overlay, backspace, paste). Auto-fetch on add now
  fills title/description (og/twitter/<title>) with "fetching..." indicator.

- UI fixes: bookmark list rows no longer wrap (single line, ellipsis);
  Enter in the URL field always fetches and moves to Tags (never saves),
  scheme-less URLs are normalized to https://; panel and sidebar widths are
  derived from terminal dimensions so layout follows terminal zoom/resize.

- Phase 2 (partial): `s` cycles sort modes (name, date added, url) and `y`
  yanks the selected URL to the system clipboard (wl-copy/xclip/xsel, with an
  OSC 52 fallback). A one-line footer shows the last action and current sort.

- Phase 2 (complete): help panel (`?`) lists all keybinds; undo (`u`) reverts
  the last add / edit / delete via a history stack (edit snapshots now taken
  before mutation — bug found and fixed).

- Phase 2 (complete): trash view keybinds shipped — `A` (shift+a) opens the
  Trash view straight from browse mode; `r` restores the selected bookmark
  from trash back to saved (new undoable `restore` history kind). Help panel
  lists both. Typecheck clean, 73/73 tests pass.

- UI: sidebar now lists an "All" entry under "Tags"; selecting it clears the
  tag filter and shows all bookmarks. (Sidebar rewrite crash fixed — app was
  crashing on render right after the sort `s` keypress, which looked like a
  sorting failure.)

## Current Task

- [x] Add the theme panel (`T`) with Dark, Light and Tokyo Night, persisted
      across runs.
- [x] Give Tokyo Night a solid workspace background (`#1f2335`) so it no
      longer blends into the kitty background.
- [x] Add the dark-only Monokai, Everforest and Flexoki themes.
- [x] Align Tokyo Night with folke/tokyonight.nvim while keeping a solid
      workspace background.

## Next Moves

- Phase 3: selection style experiments.
- Phase 4: performance and refactor work.

## Blocked / Open Questions

- URL metadata auto-fetch (last two) not implemented.
