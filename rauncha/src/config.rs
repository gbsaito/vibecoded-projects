//! Configuration: ~/.config/rauncha/config.toml.
//! Migrated from fuzzel like it never left.

use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Clone, Deserialize)]
#[serde(default, rename_all = "kebab-case")]
pub struct Config {
    pub font: String,
    pub size: f32,
    /// Width as % of the focused output.
    pub width: u32,
    pub lines: usize,
    pub horizontal_pad: i32,
    pub vertical_pad: i32,
    pub inner_pad: f32,
    /// Controls whether the prompt/input row is displayed. When disabled,
    /// the launcher shows only the list and the results count stays hidden.
    pub prompt_visible: bool,
    pub match_counter: bool,
    /// Text shown left of the query, in `colors.prompt` color.
    pub prompt: String,
    pub colors: Colors,
    #[serde(rename = "border")]
    pub border: Border,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, rename_all = "kebab-case")]
pub struct Colors {
    /// RR GG BB AA hex string, like fuzzel (`000000d9`).
    pub background: String,
    /// fuzzel writes this key as `match`.
    #[serde(rename = "match")]
    pub match_: String,
    pub text: String,
    pub prompt: String,
    pub input: String,
    pub placeholder: String,
    pub selection: String,
    pub selection_text: String,
    pub selection_match: String,
    pub counter: String,
    pub border: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct Border {
    pub width: f32,
    pub radius: f32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            font: String::from("JetBrainsMono Nerd Font"),
            size: 16.0,
            width: 25,
            lines: 10,
            horizontal_pad: 16,
            vertical_pad: 16,
            inner_pad: 8.0,
            prompt: String::from("󰥭"),
            prompt_visible: true,
            match_counter: true,
            colors: Colors::default(),
            border: Border::default(),
        }
    }
}

impl Default for Colors {
    fn default() -> Self {
        // Tokyo Night, straight from the fuzzel.ini.
        Self {
            background: String::from("000000d9"),
            text: String::from("c0caf5ff"),
            match_: String::from("ff9e64ff"),
            prompt: String::from("7dcfffff"),
            input: String::from("c0caf5ff"),
            placeholder: String::from("565f89ff"),
            selection: String::from("7aa2f7ff"),
            selection_text: String::from("1a1b26ff"),
            selection_match: String::from("3d59a1ff"),
            counter: String::from("565f89ff"),
            border: String::from("7aa2f7ff"),
        }
    }
}

impl Default for Border {
    fn default() -> Self {
        Self {
            width: 2.0,
            radius: 0.0,
        }
    }
}

pub fn color(s: &str) -> iced::Color {
    let s = s.trim().trim_start_matches('#');
    let bytes = |i: usize| {
        u32::from_str_radix(s.get(i..i + 2).unwrap_or("ff"), 16).unwrap_or(255) as f32 / 255.0
    };
    iced::Color {
        r: bytes(0),
        g: bytes(2),
        b: bytes(4),
        a: bytes(6),
    }
}

/// Config path: $XDG_CONFIG_HOME/rauncha/config.toml, defaults when missing.
pub fn load() -> Config {
    let path = config_path();
    match std::fs::read_to_string(&path) {
        Ok(text) => toml::from_str(&text).unwrap_or_else(|e| {
            eprintln!("rauncha: bad {}: {e} (using defaults)", path.display());
            Config::default()
        }),
        Err(_) => Config::default(),
    }
}

pub fn config_path() -> PathBuf {
    let mut dir = dirs_xdg_config();
    dir.push("rauncha");
    dir.push("config.toml");
    dir
}

fn dirs_xdg_config() -> PathBuf {
    // stdlib only: XDG_CONFIG_HOME or ~/.config.
    std::env::var_os("XDG_CONFIG_HOME")
        .filter(|p| !p.is_empty() && PathBuf::from(p).is_absolute())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let mut home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
            home.push(".config");
            home
        })
}
