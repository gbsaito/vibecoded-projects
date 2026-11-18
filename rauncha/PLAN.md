# Rauncha

A fuzzy-free launcher: Wayland layer-shell menu launcher like fuzzel/rofi, built with
iced + iced_layershell. No GTK.

## Objective

Win+Space on mango spawns `rauncha`; it shows every `.desktop` entry (skipping
`NoDisplay=true`, `Type!=Application`, hidden entries) below a prompt, filtered by
exact case-insensitive substring match. Enter launches, Esc quits, up/down selects.
Second spawn of the binary toggles (closes) an already-open instance, so the same
compositor bind works both ways.

## Stack

- Rust
- iced 0.14 (UI toolkit)
- iced_layershell 0.19 (wlr layer-shell protocol; mango is wlroots-based)
- smithay-client-toolkit via the layer-shell stack (no GTK)
- serde + toml for config

## Design

Independent components, each replaceable:

- `src/main.rs` — argument handling, single-instance toggle, boots the app.
- `src/config.rs` — TOML config (`~/.config/rauncha/config.toml`), keys mirror
  fuzzel.ini where possible (font, colors, padding, lines, width) so migrating from
  fuzzel is a copy-paste.
- `src/entries.rs` — desktop entry backend: XDG data-dir scanning, INI-ish parsing,
  `NoDisplay`/`Hidden`/`Type` filtering, exec field-code stripping, launch logic.
- `src/app.rs` — iced program: prompt text input, filtered list, selection state,
  key handling, fuzzel-like styling from config.

Visual default = user's fuzzel Tokyo Night theme: JetBrainsMono Nerd Font 16,
transparent-ish black panel (bg 000000d9, 85% alpha), blue prompt/selection border
(7aa2f7), orange matches (ff9e84), 10 visible lines, counter bottom-right, 2px
border, radius 0, 25% screen width.

## Performance

- Entries scanned and parsed once at startup; filter is a linear scan with
  pre-lowercased names, O(n) per keystroke — fine for tens of thousands.
- List shows a fixed window of `lines` results, no re-render of non-visible rows.
- Single instance confirmed via Unix socket IPC before the heavy GUI boots.

## User decisions

- Compositor bind stays `$mod+space = spawn,$launcher`; user points
  `launcher = "rauncha"` in mango config. Toggle handled in-process.
- Same visual as current fuzzel (Tokyo Night) at first; theme fully configurable.
- No icons initially (fuzzel config has `icons-enabled=no`).
