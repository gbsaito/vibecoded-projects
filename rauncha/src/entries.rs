//! Desktop entry backend: XDG data-dir scanning, parsing, filtering, launch.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;

/// A runnable application as shown in the menu.
#[derive(Debug, Clone)]
pub struct Entry {
    pub name: String,
    pub exec: String,
}

/// All displayable entries, with a pre-lowercased name per entry for O(1)-ish
/// case-insensitive filtering.
#[derive(Debug, Default)]
pub struct Store {
    entries: Vec<Entry>,
    lower: Vec<String>,
}

impl Store {
    /// Scan standard XDG dirs. Desktop-id collisions: earlier dir in
    /// $XDG_DATA_DIRS order (user dir first) wins, per the desktop file spec.
    pub fn scan() -> Store {
        let mut best: HashMap<String, Entry> = HashMap::new();
        // Claimed desktop-ids, hidden or not: the first dir to claim an id
        // shadows the rest (spec), including NoDisplay'd files.
        let mut claimed: std::collections::HashSet<String> = std::collections::HashSet::new();

        for dir in data_dirs() {
            let dir = dir.join("applications");
            let Ok(read) = std::fs::read_dir(&dir) else { continue };

            let mut stack = vec![read];
            while let Some(current) = stack.pop() {
                for item in current.flatten() {
                    let path = item.path();
                    if std::fs::metadata(&path)
                        .map(|m| m.is_dir())
                        .unwrap_or(false)
                    {
                        if let Ok(sub) = std::fs::read_dir(&path) {
                            stack.push(sub);
                        }
                        continue;
                    }
                    if !item.file_name().to_string_lossy().ends_with(".desktop") {
                        continue;
                    }
                    let Some(id) = path
                        .strip_prefix(&dir)
                        .ok()
                        .map(|p| p.to_string_lossy().replace('/', "-"))
                    else {
                        continue;
                    };
                    if !claimed.insert(id.clone()) {
                        continue;
                    }
                    if let Some(entry) = parse(&path) {
                        best.insert(id, entry);
                    }
                }
            }
        }

        let mut entries: Vec<Entry> = best.into_values().collect();
        entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        let lower = entries
            .iter()
            .map(|e| e.name.to_lowercase())
            .collect();
        Store { entries, lower }
    }

    /// Entries whose name contains an exact, case-insensitive match.
    pub fn filter<'a>(&'a self, query: &str) -> Vec<&'a Entry> {
        let q = query.to_lowercase();
        if q.is_empty() {
            return self.entries.iter().collect();
        }
        self.entries
            .iter()
            .zip(&self.lower)
            .filter(|(_, l)| l.contains(&q))
            .map(|(e, _)| e)
            .collect()
    }

    /// All items, for the match counter.
    pub fn total(&self) -> usize {
        self.entries.len()
    }
}

/// $XDG_DATA_HOME (default ~/.local/share, first — spec: user dir wins) +
/// $XDG_DATA_DIRS.
fn data_dirs() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join(".local/share"))
        .unwrap_or_else(|| PathBuf::from("nonexistent-user-dir"));
    std::env::var("XDG_DATA_DIRS")
        .unwrap_or_else(|_| String::from("/usr/local/share:/usr/share"))
        .split(':')
        .map(PathBuf::from)
        .fold(vec![home], |mut dirs, d| {
            dirs.push(d);
            dirs
        })
}

/// Parse one .desktop file; None when unshowable (missing fields, NoDisplay,
/// Hidden, not Type=Application).
fn parse(path: &PathBuf) -> Option<Entry> {
    let Ok(text) = std::fs::read_to_string(path) else { return None };

    // Only the [Desktop Entry] section counts.
    let first = text.split("[Desktop Entry]").nth(1)?;
    let mut nodisplay = false;
    let mut hidden = false;
    let mut is_application = false;
    let mut name = None;
    let mut exec = None;
    for line in first.lines().take_while(|l| !l.trim_end().starts_with('[')) {
        let Some((key, value)) = line.split_once('=') else { continue };
        let value = value.trim();
        match key.trim() {
            "Type" => is_application = value == "Application",
            "Name" => {
                if name.is_none() {
                    name = Some(value.to_string());
                }
            }
            "Exec" => {
                if exec.is_none() {
                    exec = Some(value.to_string());
                }
            }
            "NoDisplay" => nodisplay = value.eq_ignore_ascii_case("true"),
            "Hidden" => hidden = value.eq_ignore_ascii_case("true"),
            _ => {}
        }
    }

    if nodisplay || hidden || !is_application {
        return None;
    }

    let name = name?;
    let exec = strip_field_codes(exec?)?;

    Some(Entry { name, exec })
}

/// Drop Exec field codes (%f %F %u %U %i %c %D %d %n %N %v %m %k %%) and
/// surrounding quoting awkwardness; keep the raw command otherwise.
fn strip_field_codes(mut exec: String) -> Option<String> {
    exec.retain(|c| c != '"');
    while let Some(pos) = exec.find('%') {
        let rest = &exec[pos..];
        let Some(next) = rest.chars().nth(1) else { break };
        if next == '%' {
            exec.replace_range(pos..pos + 1, ""); // %% → bare % (drop one %)
        } else {
            let next = next.to_string();
            exec = exec.replacen(&format!("%{next}"), "", 1);
        }
        exec = exec.trim().to_string();
    }
    if exec.is_empty() {
        return None;
    }
    Some(exec)
}

/// Spawn the command detached; panel exits right after.
pub fn launch(exec: &str) {
    // Detach-ish: spawn under sh so quoting in Exec lines survives; rauncha
    // exits right after and the child is reparented by the compositor's init.
    let _ = Command::new("sh").arg("-c").arg(format!("exec {exec}")).spawn();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn field_codes_and_case() {
        assert_eq!(
            strip_field_codes("code %F ".into()).as_deref(),
            Some("code")
        );
        assert_eq!(
            strip_field_codes("sorter -%U".into()).as_deref(),
            Some("sorter -")
        );
        assert_eq!(strip_field_codes("echo 50%%".into()).as_deref(), Some("echo 50%"));
        assert_eq!(strip_field_codes("i".into()).as_deref(), Some("i"));
    }

    #[test]
    fn filter_is_case_insensitive() {
        let store = Store {
            entries: vec![Entry {
                name: "Firefox Web".into(),
                exec: "firefox".into(),
            }],
            lower: vec!["firefox web".into()],
        };
        assert_eq!(store.filter("fire").len(), 1);
        assert_eq!(store.filter("zsh").len(), 0);
    }

    /// Real-directory smoke check + hidden-vs-system-copy regression:
    /// a user NoDisplay'd .desktop must shadow a displayable system one.
    #[test]
    fn scan_finds_apps() {
        let store = Store::scan();
        let names: Vec<&str> = store.entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.len() >= 10, "found {}", names.len());
        assert!(!names.contains(&"Helix"), "user NoDisplay copy leaked");
        assert!(!names.contains(&"Yazi File Manager"));
    }
}
