# PROGRESS

## Current task

Idle — awaiting visual test of: prompt-visible toggle, fuzzel config parity
(25% width, 10 lines, None Font family, ff9e64 matches), divider removed,
page-jump scrolling, real translucency (tiny-skia renderer).

## Done

- Prompt-visible config toggle: `prompt-visible = false` hides the prompt +
  counter row; the panel is a plain list.
- Fuzzel config parity ported (width/lines/font/match color), defaults and
  user config both track fuzzel.ini.
- Divider removed from the layout (and its panel_height term).
- Scrolling: window jumps a whole page when the cursor passes the last row
  (fuzzel), no one-row scroll, no wrap.
- Translucency fixed for real: wgpu buffer alpha is dropped by wlroots
  compositors (opaque white test); tiny-skia renders via wl_shm ARGB like
  fuzzel. Verified `ffffff40` renders (64,64,64) — exactly 25% blended.
- Prompt-row crop fix: text_input padding zeroed, panel_height rebuilt.
- NoDisplay shadowing fix: user `.desktop` with `NoDisplay=true` now wins
  over a displayable system copy (was leaking Helix/btop/yazi).

## Notes

- Shell tool's grep gets intercepted here; verify build warnings via
  `cargo build > file` + Read.
- Feed the bind new builds with `./install.sh` (`cargo build --release` + cp
  to ~/.cargo/bin) — `cargo install --path` re-does fingerprint churn each
  call for the same result.

## Next

- Config file path wiring + sample config, polish visual deltas vs fuzzel.
- Launch polish; single-instance toggle socket.
