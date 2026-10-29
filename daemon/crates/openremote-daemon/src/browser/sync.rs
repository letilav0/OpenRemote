//! Syncing the browser's settings and bookmarks between the devices of one
//! account.
//!
//! The store under [`super::store`] keeps every collection as an append-only
//! op log stamped with a hybrid logical clock, one file per device, and it
//! already merges those files per key: the newest stamp wins, and a deletion
//! is a row whose value is null, so a deletion wins too. A note here is a
//! snapshot of exactly the two collections that follow the account - the
//! settings and the bookmark tree - taken from those rows, so the merge rules
//! are the store's rules rather than a second copy of them. History, cookies,
//! site storage and the tabs to restore are deliberately not in the note:
//! those belong to the device that made them.
//!
//! Two devices converge because merging is per key and order-free: an older
//! snapshot changes nothing, a deleted bookmark stays deleted, and a device
//! with no row for a key adopts the peer's value instead of writing a default
//! over it (the store only ever holds what the user changed). The sequence
//! number and the updated-at are for the engine's dispatch: a note that
//! repeats is skipped without a merge, and a note can be ordered against the
//! last one from the same peer. Merging never looks at either one.
//!
//! A peer that does not know the type ignores the note - the sync engine
//! drops notes whose type it does not match, and this note carries no session
//! id, so a device a version behind cannot mistake it for a chat one - which
//! is what makes shipping it safe.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::store::{BrowserStore, Stamp};

/// The note's `type`, as the sync engine matches it.
pub const NOTE_TYPE: &str = "sync.browser";
/// The note's shape version. A note from another version is ignored rather
/// than guessed at.
pub const VERSION: u64 = 1;
/// The two collections a note carries, and the only two whose rows sync.
const SYNCED: [&str; 2] = ["setting", "bookmark"];

/// One key's row: the stamp it was written at and its value. A null value is
/// the tombstone a deletion leaves, and it is carried so the deletion travels.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Row {
    pub at: Stamp,
    pub val: Value,
}

/// One `sync.browser` note as it travels. `updated_at` is the newest stamp in
/// the snapshot, or 0 for an empty profile; it orders two snapshots, it never
/// merges them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Note {
    pub v: u64,
    pub seq: u64,
    pub updated_at: i64,
    #[serde(default)]
    pub settings: BTreeMap<String, Row>,
    #[serde(default)]
    pub bookmarks: BTreeMap<String, Row>,
}

/// Whether a peer note is one of these, for the engine's dispatch.
pub fn is_browser_note(note: &Value) -> bool {
    note.get("type").and_then(Value::as_str) == Some(NOTE_TYPE)
}

/// The next sequence number for a note this device sends, kept in the store so
/// it does not restart at one after a restart. A row of its own collection, so
/// it never reaches a peer.
pub fn next_seq(store: &mut BrowserStore) -> u64 {
    let seq = store
        .get("sync", "note-seq")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        + 1;
    store.put("sync", "note-seq", json!(seq));
    seq
}

/// The note to send: every synced row with the stamp that made it, deletions
/// included. A snapshot rather than a delta, so a note lost in a reconnect is
/// healed by the next one.
pub fn note(store: &BrowserStore, seq: u64) -> Value {
    let mut settings = BTreeMap::new();
    let mut bookmarks = BTreeMap::new();
    let mut updated_at = 0;
    for col in SYNCED {
        for (key, at, val) in store.rows(col) {
            updated_at = updated_at.max(at.ms);
            let row = Row { at, val };
            if col == "setting" {
                settings.insert(key, row);
            } else {
                bookmarks.insert(key, row);
            }
        }
    }
    let note = Note {
        v: VERSION,
        seq,
        updated_at,
        settings,
        bookmarks,
    };
    let mut value = serde_json::to_value(&note).expect("a note serializes");
    if let Some(map) = value.as_object_mut() {
        map.insert("type".into(), json!(NOTE_TYPE));
    }
    value
}

/// A device id a peer's stamp may name: the store's own ids are simple, so a
/// stamp that would name anything else - a path, an empty name, a name too
/// long for a file - is not a row this device can keep.
fn usable_device(dev: &str) -> bool {
    !dev.is_empty()
        && dev.len() <= 64
        && dev
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The receipt side: what arrived from each peer, and what was taken from it.
#[derive(Default)]
pub struct Received {
    /// The last sequence merged from each peer, so a repeated note is skipped
    /// without walking its rows. Merging is idempotent either way; this only
    /// saves the walk.
    seen: HashMap<String, u64>,
}

impl Received {
    /// Takes a peer's snapshot into the store, keeping only rows newer than the
    /// local ones, and answers how many were taken. A note of another type or
    /// version, or one not newer than the last from the same peer, changes
    /// nothing.
    pub fn merge(&mut self, store: &mut BrowserStore, from: &str, note: &Value) -> usize {
        if !is_browser_note(note) {
            return 0;
        }
        let Ok(snapshot) = serde_json::from_value::<Note>(note.clone()) else {
            return 0;
        };
        if snapshot.v != VERSION {
            return 0;
        }
        if self
            .seen
            .get(from)
            .is_some_and(|last| snapshot.seq <= *last)
        {
            return 0;
        }
        self.seen.insert(from.to_string(), snapshot.seq);
        let mut applied = 0;
        for (key, row) in &snapshot.settings {
            if usable_device(&row.at.dev) && store.merge_row("setting", key, &row.at, &row.val) {
                applied += 1;
            }
        }
        for (key, row) in &snapshot.bookmarks {
            if usable_device(&row.at.dev) && store.merge_row("bookmark", key, &row.at, &row.val) {
                applied += 1;
            }
        }
        applied
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::store::Bookmark;

    fn fresh() -> (tempfile::TempDir, BrowserStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = BrowserStore::open(dir.path());
        (dir, store)
    }

    fn mark(url: &str, title: &str) -> Bookmark {
        Bookmark {
            id: String::new(),
            url: url.into(),
            title: title.into(),
            folder: "bar".into(),
            position: 0.0,
            added: 0,
        }
    }

    /// The next note this device would send.
    fn snapshot(store: &mut BrowserStore) -> Value {
        let seq = next_seq(store);
        note(store, seq)
    }

    #[test]
    fn a_setting_changed_on_one_device_reaches_the_other() {
        let (a_dir, mut a) = fresh();
        let (_b_dir, mut b) = fresh();
        a.set_setting("search", json!("duckduckgo"));
        let mut received = Received::default();
        assert_eq!(received.merge(&mut b, "device-a", &snapshot(&mut a)), 1);
        assert_eq!(b.settings()["search"], "duckduckgo");

        // The change made on B afterwards is newer and travels back.
        b.set_setting("search", json!("google"));
        assert_eq!(received.merge(&mut a, "device-b", &snapshot(&mut b)), 1);
        assert_eq!(a.settings()["search"], "google");
        // And the copy on disk carries it after a restart, in the other
        // device's own log rather than this one's.
        drop(a);
        let a = BrowserStore::open(a_dir.path());
        assert_eq!(a.settings()["search"], "google");
    }

    #[test]
    fn a_bookmark_deleted_on_one_device_stays_deleted_on_the_other() {
        let (a_dir, mut a) = fresh();
        let (b_dir, mut b) = fresh();
        let (_c_dir, mut c) = fresh();
        let saved = a.save_bookmark(mark("https://example.com/", "Example"));
        let mut received = Received::default();
        received.merge(&mut b, "device-a", &snapshot(&mut a));
        received.merge(&mut c, "device-a", &snapshot(&mut a));
        assert_eq!(b.bookmarks().len(), 1);
        assert_eq!(c.bookmarks().len(), 1);

        a.remove_bookmark(&saved.id);
        assert_eq!(
            received.merge(&mut b, "device-a", &snapshot(&mut a)),
            1,
            "the tombstone is newer than B's copy"
        );
        assert!(b.bookmarks().is_empty());

        // C still holds the bookmark: its older snapshot must not bring it
        // back, on B or on A.
        let stale = snapshot(&mut c);
        assert_eq!(received.merge(&mut b, "device-c", &stale), 0);
        assert_eq!(received.merge(&mut a, "device-c", &stale), 0);
        assert!(b.bookmarks().is_empty());
        assert!(a.bookmarks().is_empty());

        // A restart does not resurrect it: the tombstone is a row on disk.
        drop(b);
        let b = BrowserStore::open(b_dir.path());
        assert!(b.bookmarks().is_empty());
        drop(a);
        let a = BrowserStore::open(a_dir.path());
        assert!(a.bookmarks().is_empty());
    }

    #[test]
    fn a_device_with_nothing_stored_adopts_the_peer_value() {
        let (_a_dir, mut a) = fresh();
        let (_b_dir, mut b) = fresh();
        a.set_setting("search", json!("duckduckgo"));
        a.set_setting("home", json!("https://example.com/"));
        assert!(b.settings().is_empty());

        let mut received = Received::default();
        assert_eq!(received.merge(&mut b, "device-a", &snapshot(&mut a)), 2);
        // Nothing was written here first, so there is no default for the remote
        // value to lose to: the peer's row is the row.
        assert_eq!(b.settings()["search"], "duckduckgo");
        assert_eq!(b.settings()["home"], "https://example.com/");
        // B's own snapshot now carries them, unchanged, for the next device.
        let back = snapshot(&mut b);
        assert_eq!(back["settings"]["search"]["val"], "duckduckgo");
    }

    #[test]
    fn another_version_a_repeat_or_a_foreign_note_changes_nothing() {
        let (_a_dir, mut a) = fresh();
        let (_b_dir, mut b) = fresh();
        a.set_setting("search", json!("duckduckgo"));
        let mut received = Received::default();
        let first = snapshot(&mut a);
        assert_eq!(received.merge(&mut b, "device-a", &first), 1);
        // The same note again: taken once, then skipped.
        assert_eq!(received.merge(&mut b, "device-a", &first), 0);
        b.set_setting("search", json!("google"));

        let mut future = first.clone();
        future["v"] = json!(VERSION + 1);
        assert_eq!(received.merge(&mut b, "device-a", &future), 0);
        assert_eq!(
            b.settings()["search"],
            "google",
            "an unknown version is not guessed at"
        );

        let mut foreign = first.clone();
        foreign["type"] = json!("sync.events");
        assert!(!is_browser_note(&foreign));
        assert_eq!(received.merge(&mut b, "device-a", &foreign), 0);
        assert_eq!(b.settings()["search"], "google");

        // A stamp naming something that is not a device id cannot be kept: it
        // would become a log file name.
        let mut bad = first.clone();
        bad["settings"]["search"]["at"]["dev"] = json!("../../escape");
        assert_eq!(received.merge(&mut b, "device-x", &bad), 0);
        assert_eq!(b.settings()["search"], "google");
    }
}
