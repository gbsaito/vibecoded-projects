//! Rauncha — a fast Wayland launcher menu (fuzzel-like).
//! Stack: iced + iced_layershell (wlroots layer-shell). No GTK.

use std::path::PathBuf;

mod app;
mod config;
mod entries;
mod outputs;
mod toggle;

use config::Config;

fn main() {
    // Mango's spawn can lose WAYLAND_DISPLAY; pick the first socket if missing.
    // ponytail: first found only — multi-socket sessions are rare.
    if std::env::var_os("WAYLAND_DISPLAY").is_none() {
        let runtime = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from);
        if let Some(dir) = runtime {
            if let Some(found) = std::fs::read_dir(&dir)
                .ok()
                .and_then(|d| {
                    d.flatten()
                        .map(|e| e.file_name())
                        .find(|n| n.to_string_lossy().starts_with("wayland-"))
                })
            {
                std::env::set_var("WAYLAND_DISPLAY", found);
            }
        }
    }
    // Debug boot trace (remove once the bind mystery is solved).
    let mut trace = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/rauncha.trace")
        .ok();
    use std::io::Write;
    if let Some(t) = trace.as_mut() {
        let _ = writeln!(
            t,
            "boot pid={:?} wd={:?} screen={:?}",
            std::process::id(),
            std::env::var_os("WAYLAND_DISPLAY"),
            outputs::focus_output_size()
        );
    }

    // Single-instance toggle: if an instance is already open, tell it to quit.
    toggle::request_or_announce();

    let config: Config = config::load();
    let screen = outputs::focus_output_size().unwrap_or(app::SCREEN_FALLBACK);

    match app::run(config, screen) {
        Ok(()) => eprintln!("rauncha: run() returned Ok immediately (event loop ended early)"),
        Err(e) => eprintln!("rauncha: {e}"),
    }
}
