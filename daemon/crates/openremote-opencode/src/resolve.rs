//! OpenCode CLI resolution: every install we know about, then the newest
//! one that exists.
//!
//! OpenCode Desktop v2 migrates the shared database (`session_v2`, no
//! `session` table). The v1 binary OpenRemote's installer drops in
//! `~/.opencode/bin` then exits at `opencode serve` with "Database is
//! not empty and has no session table". When both exist, the newer
//! binary is the one that can open that database. A single install is
//! used as-is, with no version probe.

use std::env;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use openremote_harness::Resolution;
use openremote_harness::paths::{home_dir, local_app_data, under, which};

pub(crate) fn resolve_impl(override_path: Option<PathBuf>) -> Resolution {
    // An override is authoritative: an injected daemon never leaks to the
    // machine's real CLIs, and an install test can make this harness
    // appear by materializing exactly this path.
    if let Some(path) = override_path {
        if path.is_file() {
            return Resolution::Executable(path);
        }
        return Resolution::Unavailable;
    }
    let mut found = Vec::new();
    if let Some(exe) = which(binary_name(cfg!(windows))) {
        push_unique(&mut found, exe);
    }
    let appdata = env::var_os("APPDATA").map(PathBuf::from);
    for path in candidates(cfg!(windows), home_dir().as_deref(), appdata.as_deref()) {
        push_unique(&mut found, path);
    }
    if let Some(exe) = desktop_cli(local_app_data().as_deref()) {
        push_unique(&mut found, exe);
    }
    for path in roaming_clis(appdata.as_deref()) {
        push_unique(&mut found, path);
    }
    match found.len() {
        0 => Resolution::Unavailable,
        1 => Resolution::Executable(found.remove(0)),
        _ => {
            let versions: Vec<Option<(u32, u32, u32)>> =
                found.iter().map(|path| cli_version(path)).collect();
            let index = prefer_newer(&versions);
            Resolution::Executable(found.swap_remove(index))
        }
    }
}

fn binary_name(windows: bool) -> &'static str {
    if windows { "opencode.exe" } else { "opencode" }
}

fn candidates(windows: bool, home: Option<&Path>, appdata: Option<&Path>) -> Vec<PathBuf> {
    let name = binary_name(windows);
    let mut out: Vec<PathBuf> = home
        .map(|h| under(h, &[".opencode", "bin", name]))
        .into_iter()
        .collect();
    if windows {
        // npm's global bin dir only carries sh/cmd shims; the native
        // binary lives inside the package (verified layout:
        // %APPDATA%\npm\node_modules\opencode-ai\bin\opencode.exe).
        if let Some(appdata) = appdata {
            out.push(under(
                appdata,
                &["npm", "node_modules", "opencode-ai", "bin", "opencode.exe"],
            ));
        }
    }
    out
}

/// OpenCode Desktop's bundled CLI. Stable path, not the versioned copy
/// under `%APPDATA%\ai.opencode.desktop\cli`.
fn desktop_cli(local: Option<&Path>) -> Option<PathBuf> {
    let local = local?;
    let exe = under(
        local,
        &[
            "Programs",
            "@opencodedesktop",
            "resources",
            "opencode-cli.exe",
        ],
    );
    exe.is_file().then_some(exe)
}

/// `%APPDATA%\ai.opencode.desktop\cli\<version>\opencode-cli.exe`. The
/// version segment changes with the desktop app, so the directory is
/// listed rather than pinned.
fn roaming_clis(appdata: Option<&Path>) -> Vec<PathBuf> {
    let Some(appdata) = appdata else {
        return Vec::new();
    };
    let root = under(appdata, &["ai.opencode.desktop", "cli"]);
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        push_unique(&mut out, entry.path().join("opencode-cli.exe"));
    }
    out
}

fn push_unique(out: &mut Vec<PathBuf>, path: PathBuf) {
    if !path.is_file() {
        return;
    }
    let key = path.to_string_lossy().to_ascii_lowercase();
    if out
        .iter()
        .any(|have| have.to_string_lossy().to_ascii_lowercase() == key)
    {
        return;
    }
    out.push(path);
}

/// First `x.y.z` in a `--version` line. v1 prints `1.19.3`; v2 prints
/// `opencode v2.1.2`.
pub(crate) fn parse_cli_version(text: &str) -> Option<(u32, u32, u32)> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.') {
                i += 1;
            }
            let token = &text[start..i];
            let mut parts = token.split('.');
            if let (Some(major), Some(minor), Some(patch)) =
                (parts.next(), parts.next(), parts.next())
            {
                if let (Ok(major), Ok(minor), Ok(patch)) =
                    (major.parse(), minor.parse(), patch.parse())
                {
                    return Some((major, minor, patch));
                }
            }
            continue;
        }
        i += 1;
    }
    None
}

/// Index of the newest version. A missing version loses to any number.
/// Ties keep the earlier candidate, so PATH still wins when two installs
/// report the same version.
pub(crate) fn prefer_newer(versions: &[Option<(u32, u32, u32)>]) -> usize {
    let mut best = 0;
    let mut best_ver = (0, 0, 0);
    for (index, version) in versions.iter().enumerate() {
        let version = version.unwrap_or((0, 0, 0));
        if index == 0 || version > best_ver {
            best = index;
            best_ver = version;
        }
    }
    best
}

fn cli_version(path: &Path) -> Option<(u32, u32, u32)> {
    let mut command = Command::new(path);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(openremote_harness::creation_flags());
    }
    let output = command.output().ok()?;
    parse_cli_version(&String::from_utf8_lossy(&output.stdout))
        .or_else(|| parse_cli_version(&String::from_utf8_lossy(&output.stderr)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_installer_root_comes_first_on_both() {
        let home = Path::new("home");
        let appdata = Path::new("appdata");
        assert_eq!(
            candidates(false, Some(home), Some(appdata)),
            [under(home, &[".opencode", "bin", "opencode"])]
        );
        let win = candidates(true, Some(home), Some(appdata));
        assert_eq!(win[0], under(home, &[".opencode", "bin", "opencode.exe"]));
        assert_eq!(win.len(), 2);
    }

    #[test]
    fn parses_both_version_spellings() {
        assert_eq!(parse_cli_version("1.19.3\n"), Some((1, 19, 3)));
        assert_eq!(parse_cli_version("opencode v2.1.2\n"), Some((2, 1, 2)));
        assert_eq!(parse_cli_version("no version here"), None);
    }

    #[test]
    fn newer_install_wins_and_ties_keep_path() {
        assert_eq!(prefer_newer(&[Some((1, 19, 3)), Some((2, 1, 2))]), 1);
        assert_eq!(prefer_newer(&[Some((2, 1, 2)), Some((2, 1, 2))]), 0);
        assert_eq!(prefer_newer(&[None, Some((2, 0, 0))]), 1);
    }
}
