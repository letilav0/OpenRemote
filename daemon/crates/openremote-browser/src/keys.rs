//! Key names, as agents write them (`Enter`, `Control+A`, `Shift+Tab`),
//! turned into what the DevTools protocol's `Input.dispatchKeyEvent`
//! takes: Chrome's own `key` and `code` values and the Windows key code
//! pages read from `keyCode`.

use serde_json::{Value, json};

/// The DevTools protocol's modifier bits.
const ALT: u8 = 1;
const CONTROL: u8 = 2;
const META: u8 = 4;
const SHIFT: u8 = 8;

/// One key press, ready for the protocol.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Press {
    pub key: String,
    pub code: String,
    pub key_code: u32,
    /// What the press types, if anything (nothing while Control, Alt or
    /// Meta is held: Control+A selects, it doesn't type an "a").
    pub text: Option<String>,
    pub modifiers: u8,
}

impl Press {
    /// The key-down and key-up events, in order.
    pub fn events(&self) -> Vec<Value> {
        let mut down = json!({
            "type": if self.text.is_some() { "keyDown" } else { "rawKeyDown" },
            "modifiers": self.modifiers,
            "key": self.key,
            "code": self.code,
            "windowsVirtualKeyCode": self.key_code,
            "nativeVirtualKeyCode": self.key_code,
        });
        if let Some(text) = &self.text {
            down["text"] = json!(text);
            down["unmodifiedText"] = json!(text);
        }
        let up = json!({
            "type": "keyUp",
            "modifiers": self.modifiers,
            "key": self.key,
            "code": self.code,
            "windowsVirtualKeyCode": self.key_code,
            "nativeVirtualKeyCode": self.key_code,
        });
        vec![down, up]
    }
}

/// A chord (`Control+Shift+Tab`) as one press, or why it isn't one.
pub fn parse(chord: &str) -> Result<Press, String> {
    let chord = chord.trim();
    if chord.is_empty() {
        return Err("no key named".into());
    }
    // "+" on its own, or as the last part ("Control++"), is the plus key.
    let (mods, last) = match chord.strip_suffix("++") {
        Some(rest) => (rest, "+"),
        None if chord == "+" => ("", "+"),
        None => match chord.rsplit_once('+') {
            Some((mods, last)) => (mods, last),
            None => ("", chord),
        },
    };
    let mut modifiers = 0;
    for part in mods.split('+').filter(|p| !p.is_empty()) {
        modifiers |= match part.to_ascii_lowercase().as_str() {
            "control" | "ctrl" => CONTROL,
            "shift" => SHIFT,
            "alt" | "option" => ALT,
            "meta" | "cmd" | "command" | "super" | "win" => META,
            _ => {
                return Err(format!(
                    "'{part}' is not a modifier (Control, Shift, Alt, Meta)"
                ));
            }
        };
    }
    let (key, code, key_code, text) = key(last, modifiers & SHIFT != 0)
        .ok_or_else(|| format!("'{last}' is not a key name (try Enter, Tab, ArrowDown, a)"))?;
    let typing = modifiers & (CONTROL | ALT | META) == 0;
    Ok(Press {
        key,
        code,
        key_code,
        text: text.filter(|_| typing),
        modifiers,
    })
}

/// Chrome's key, code, Windows key code and typed text for one key name.
fn key(name: &str, shift: bool) -> Option<(String, String, u32, Option<String>)> {
    let named = |key: &str, code: &str, key_code: u32, text: Option<&str>| {
        Some((
            key.to_string(),
            code.to_string(),
            key_code,
            text.map(str::to_string),
        ))
    };
    match name.to_ascii_lowercase().as_str() {
        "enter" | "return" => return named("Enter", "Enter", 13, Some("\r")),
        "tab" => return named("Tab", "Tab", 9, None),
        "backspace" => return named("Backspace", "Backspace", 8, None),
        "escape" | "esc" => return named("Escape", "Escape", 27, None),
        "space" | " " => return named(" ", "Space", 32, Some(" ")),
        "arrowleft" | "left" => return named("ArrowLeft", "ArrowLeft", 37, None),
        "arrowup" | "up" => return named("ArrowUp", "ArrowUp", 38, None),
        "arrowright" | "right" => return named("ArrowRight", "ArrowRight", 39, None),
        "arrowdown" | "down" => return named("ArrowDown", "ArrowDown", 40, None),
        "delete" | "del" => return named("Delete", "Delete", 46, None),
        "home" => return named("Home", "Home", 36, None),
        "end" => return named("End", "End", 35, None),
        "pageup" => return named("PageUp", "PageUp", 33, None),
        "pagedown" => return named("PageDown", "PageDown", 34, None),
        "insert" => return named("Insert", "Insert", 45, None),
        _ => {}
    }
    let lower = name.to_ascii_lowercase();
    if let Some(n) = lower.strip_prefix('f').and_then(|n| n.parse::<u32>().ok()) {
        if (1..=12).contains(&n) {
            let key = format!("F{n}");
            return Some((key.clone(), key, 111 + n, None));
        }
    }
    let mut chars = name.chars();
    let c = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    if c.is_ascii_alphabetic() {
        let upper = c.to_ascii_uppercase();
        let typed = if shift { upper } else { c.to_ascii_lowercase() };
        return Some((
            typed.to_string(),
            format!("Key{upper}"),
            upper as u32,
            Some(typed.to_string()),
        ));
    }
    if c.is_ascii_digit() {
        return Some((
            c.to_string(),
            format!("Digit{c}"),
            c as u32,
            Some(c.to_string()),
        ));
    }
    // Any other single character types itself.
    Some((c.to_string(), String::new(), 0, Some(c.to_string())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn named_keys_and_chords() {
        let enter = parse("Enter").unwrap();
        assert_eq!(
            (enter.key.as_str(), enter.key_code, enter.text.as_deref()),
            ("Enter", 13, Some("\r"))
        );
        let select_all = parse("Control+A").unwrap();
        assert_eq!(select_all.code, "KeyA");
        assert_eq!(select_all.modifiers, CONTROL);
        assert_eq!(select_all.text, None, "Control+A selects, it types nothing");
        let back_tab = parse("shift+tab").unwrap();
        assert_eq!((back_tab.key.as_str(), back_tab.modifiers), ("Tab", SHIFT));
        let capital = parse("Shift+b").unwrap();
        assert_eq!(capital.text.as_deref(), Some("B"));
        assert_eq!(parse("Control++").unwrap().key, "+");
        assert_eq!(parse("F5").unwrap().key_code, 116);
        assert!(parse("Hyper+A").is_err());
        assert!(parse("Banana").is_err());
        assert!(parse("").is_err());
    }

    #[test]
    fn a_press_is_a_key_down_then_a_key_up() {
        let events = parse("Enter").unwrap().events();
        assert_eq!(events[0]["type"], "keyDown");
        assert_eq!(events[0]["text"], "\r");
        assert_eq!(events[1]["type"], "keyUp");
        assert_eq!(parse("Escape").unwrap().events()[0]["type"], "rawKeyDown");
    }
}
