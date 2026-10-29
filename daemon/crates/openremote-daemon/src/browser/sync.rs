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

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::store::{BrowserStore, CAP_BOOKMARK, CAP_SETTING, Stamp};

/// The note's `type`, as the sync engine matches it.
pub const NOTE_TYPE: &str = "sync.browser";
/// The note's shape version. A note from another version is ignored rather
/// than guessed at.
pub const VERSION: u64 = 1;
/// The two collections a note carries, and the only two whose rows sync.
const SYNCED: [&str; 2] = ["setting", "bookmark"];

/// A note may carry no more rows than the two capped collections can hold
/// together (`store::CAP_SETTING` plus `store::CAP_BOOKMARK`). A real profile
/// is far below that: the console writes tens of settings, and a heavy bookmark
/// collector reaches the low thousands. Being the sum of the store ceilings is
/// the point, because a note this device builds always fits; a peer that sends
/// more rows is not describing a browser.
pub const MAX_NOTE_ROWS: usize = CAP_SETTING + CAP_BOOKMARK;

/// The largest a single row's value may be on the wire. A bookmark row is about
/// 300 bytes and the longest settings value the console writes is a URL a
/// person typed, so 4 KiB is more than ten times the real maximum: a row above
/// it was made up rather than typed. A local row above it is left out of a
/// snapshot (see `note`), because a receiver refuses the whole note for one and
/// that would stop this device's sync to say nothing.
pub const MAX_ROW_BYTES: usize = 4 * 1024;

/// How many keys one note may add to a collection. A note may not introduce
/// more than the collection itself can hold (`store::CAP_SETTING`,
/// `store::CAP_BOOKMARK`), so a device restoring a real profile introduces its
/// rows in one note, and a peer that invents keys is offered exactly one
/// collection's worth. Together with [`MAX_NOTE_ROWS`] this is the third
/// ceiling: one note cannot make this store hold more than a capped store can.
pub const MAX_NEW_SETTINGS: usize = CAP_SETTING;
pub const MAX_NEW_BOOKMARKS: usize = CAP_BOOKMARK;

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
            // A row above the ceiling does not travel, and its stamp does not
            // move `updated_at`: a receiver refuses the whole note for it, so
            // sending it would stop this device's sync over a value no console
            // path writes.
            if serialized_len(&val) > MAX_ROW_BYTES {
                continue;
            }
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

/// Why a peer's note was not read. Every one of these is a whole-note refusal:
/// a note that trips any of them leaves the store exactly as it was, because a
/// half-applied snapshot would be a state neither device sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refused {
    /// Not a `sync.browser` note.
    Type,
    /// A shape version this build does not read.
    Version,
    /// More rows than the two collections can hold together.
    Rows,
    /// One row's value larger than any real one.
    RowTooBig,
    /// More keys this store does not hold than one note may add.
    NewKeys,
}

impl Refused {
    /// The reason as a sentence, for a log line or a test message.
    pub fn reason(self) -> &'static str {
        match self {
            Self::Type => "not a browser note",
            Self::Version => "another shape version",
            Self::Rows => "more rows than a real profile",
            Self::RowTooBig => "a row value above the ceiling",
            Self::NewKeys => "more new keys than one note may add",
        }
    }
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
    /// local ones, and answers how many were taken. A note not newer than the
    /// last one from the same peer changes nothing and is not an error; a note
    /// of another type or version, or one over a ceiling below, is refused
    /// whole (`Refused`) with the store untouched.
    pub fn merge(
        &mut self,
        store: &mut BrowserStore,
        from: &str,
        note: &Value,
    ) -> Result<usize, Refused> {
        if !is_browser_note(note) {
            return Err(Refused::Type);
        }
        let Ok(snapshot) = serde_json::from_value::<Note>(note.clone()) else {
            // A note whose own shape does not parse is a broken peer, not a
            // different protocol: the same refusal as a version this build
            // cannot read.
            return Err(Refused::Version);
        };
        if snapshot.v != VERSION {
            return Err(Refused::Version);
        }
        if self
            .seen
            .get(from)
            .is_some_and(|last| snapshot.seq <= *last)
        {
            return Ok(0);
        }
        // Every ceiling is checked before anything is written: a refusal must
        // leave the store byte for byte as it found it.
        if snapshot.settings.len() + snapshot.bookmarks.len() > MAX_NOTE_ROWS {
            return Err(Refused::Rows);
        }
        for row in snapshot
            .settings
            .values()
            .chain(snapshot.bookmarks.values())
        {
            if serialized_len(&row.val) > MAX_ROW_BYTES {
                return Err(Refused::RowTooBig);
            }
        }
        // The keys this store already holds, tombstones included: a row on one
        // of them is an update, not growth.
        let held: [HashSet<String>; 2] = [
            store
                .rows("setting")
                .into_iter()
                .map(|(k, _, _)| k)
                .collect(),
            store
                .rows("bookmark")
                .into_iter()
                .map(|(k, _, _)| k)
                .collect(),
        ];
        let fresh_settings = snapshot
            .settings
            .keys()
            .filter(|key| !held[0].contains(*key))
            .count();
        let fresh_bookmarks = snapshot
            .bookmarks
            .keys()
            .filter(|key| !held[1].contains(*key))
            .count();
        if fresh_settings > MAX_NEW_SETTINGS || fresh_bookmarks > MAX_NEW_BOOKMARKS {
            return Err(Refused::NewKeys);
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
        Ok(applied)
    }
}

/// A value's size on the wire, which is what a peer pays for.
fn serialized_len(val: &Value) -> usize {
    serde_json::to_vec(val).map_or(usize::MAX, |bytes| bytes.len())
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

    /// A note built by hand, the way a peer sends one: every row carries the
    /// same stamp, which is all a ceiling test needs.
    fn built(seq: u64, settings: Vec<(String, Value)>, bookmarks: Vec<(String, Value)>) -> Value {
        let stamp = Stamp {
            ms: 1,
            n: 0,
            dev: "device-x".into(),
        };
        let rows = |pairs: Vec<(String, Value)>| {
            pairs
                .into_iter()
                .map(|(key, val)| {
                    (
                        key,
                        Row {
                            at: stamp.clone(),
                            val,
                        },
                    )
                })
                .collect::<BTreeMap<_, _>>()
        };
        let note = Note {
            v: VERSION,
            seq,
            updated_at: 1,
            settings: rows(settings),
            bookmarks: rows(bookmarks),
        };
        let mut value = serde_json::to_value(&note).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("type".into(), json!(NOTE_TYPE));
        value
    }

    /// Every byte this device has written, name and content: a refused note
    /// must leave all of it as it found it. The store keeps its files in the
    /// `browser` folder under the data folder the test made.
    fn log_bytes(dir: &std::path::Path) -> Vec<(String, Vec<u8>)> {
        let mut files: Vec<(String, Vec<u8>)> = std::fs::read_dir(dir.join("browser"))
            .unwrap()
            .flatten()
            .map(|entry| {
                (
                    entry.file_name().to_string_lossy().into_owned(),
                    std::fs::read(entry.path()).unwrap(),
                )
            })
            .collect();
        files.sort();
        files
    }

    /// `n` invented settings keys, none of them held here yet.
    fn invented(n: usize, tag: &str) -> Vec<(String, Value)> {
        (0..n).map(|i| (format!("{tag}{i}"), json!(i))).collect()
    }

    #[test]
    fn a_setting_changed_on_one_device_reaches_the_other() {
        let (a_dir, mut a) = fresh();
        let (_b_dir, mut b) = fresh();
        a.set_setting("search", json!("duckduckgo"));
        let mut received = Received::default();
        assert_eq!(received.merge(&mut b, "device-a", &snapshot(&mut a)), Ok(1));
        assert_eq!(b.settings()["search"], "duckduckgo");

        // The change made on B afterwards is newer and travels back.
        b.set_setting("search", json!("google"));
        assert_eq!(received.merge(&mut a, "device-b", &snapshot(&mut b)), Ok(1));
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
        let _ = received.merge(&mut b, "device-a", &snapshot(&mut a));
        let _ = received.merge(&mut c, "device-a", &snapshot(&mut a));
        assert_eq!(b.bookmarks().len(), 1);
        assert_eq!(c.bookmarks().len(), 1);

        a.remove_bookmark(&saved.id);
        assert_eq!(
            received.merge(&mut b, "device-a", &snapshot(&mut a)),
            Ok(1),
            "the tombstone is newer than B's copy"
        );
        assert!(b.bookmarks().is_empty());

        // C still holds the bookmark: its older snapshot must not bring it
        // back, on B or on A.
        let stale = snapshot(&mut c);
        assert_eq!(received.merge(&mut b, "device-c", &stale), Ok(0));
        assert_eq!(received.merge(&mut a, "device-c", &stale), Ok(0));
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
        assert_eq!(received.merge(&mut b, "device-a", &snapshot(&mut a)), Ok(2));
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
        assert_eq!(received.merge(&mut b, "device-a", &first), Ok(1));
        // The same note again: taken once, then skipped.
        assert_eq!(received.merge(&mut b, "device-a", &first), Ok(0));
        b.set_setting("search", json!("google"));

        let mut future = first.clone();
        future["v"] = json!(VERSION + 1);
        assert_eq!(
            received.merge(&mut b, "device-a", &future),
            Err(Refused::Version)
        );
        assert_eq!(
            b.settings()["search"],
            "google",
            "an unknown version is not guessed at"
        );

        let mut foreign = first.clone();
        foreign["type"] = json!("sync.events");
        assert!(!is_browser_note(&foreign));
        assert_eq!(
            received.merge(&mut b, "device-a", &foreign),
            Err(Refused::Type)
        );
        assert_eq!(b.settings()["search"], "google");

        // A stamp naming something that is not a device id cannot be kept: it
        // would become a log file name.
        let mut bad = first.clone();
        bad["settings"]["search"]["at"]["dev"] = json!("../../escape");
        assert_eq!(
            received.merge(&mut b, "device-x", &bad),
            Ok(0),
            "a row naming no device is skipped, the note is read"
        );
        assert_eq!(b.settings()["search"], "google");
    }

    #[test]
    fn the_ceilings_are_pinned_to_the_numbers_the_doc_names() {
        // The behaviour tests below scale with the constants on purpose (they
        // describe the rule at whatever the ceiling is); these four lines are
        // where the numbers themselves are pinned. Raising one is a decision
        // that moves the doc and this test in the same commit.
        assert_eq!(CAP_SETTING, 200, "settings a peer may fill");
        assert_eq!(CAP_BOOKMARK, 5_000, "bookmarks a peer may fill");
        assert_eq!(MAX_NOTE_ROWS, 5_200, "rows one note may carry");
        assert_eq!(MAX_ROW_BYTES, 4 * 1024, "bytes one row's value may use");
    }

    #[test]
    fn a_note_over_the_row_ceiling_is_refused_whole() {
        let (dir, mut store) = fresh();
        let mut received = Received::default();
        // One row past what the two capped collections can hold together. The
        // keys are invented too, so a higher row ceiling would let this note
        // reach the key ceiling instead: the refusal has to name the row one.
        let over = built(1, invented(MAX_NOTE_ROWS + 1, "k"), Vec::new());
        let before = log_bytes(dir.path());
        assert_eq!(
            received.merge(&mut store, "device-a", &over),
            Err(Refused::Rows),
            "{}",
            Refused::Rows.reason()
        );
        assert!(store.rows("setting").is_empty(), "nothing landed");
        assert_eq!(log_bytes(dir.path()), before, "not a byte was written");
    }

    #[test]
    fn a_note_at_the_row_ceiling_is_read_and_leaves_the_store_at_its_caps() {
        let (_dir, mut store) = fresh();
        let mut received = Received::default();
        // Exactly the sum of the two collection caps, which is the largest a
        // legal note can be: a store this device filled through the browser.
        let full = built(1, invented(CAP_SETTING, "s"), invented(CAP_BOOKMARK, "b"));
        assert_eq!(
            received.merge(&mut store, "device-a", &full),
            Ok(CAP_SETTING + CAP_BOOKMARK)
        );
        assert_eq!(store.rows("setting").len(), CAP_SETTING);
        assert_eq!(store.rows("bookmark").len(), CAP_BOOKMARK);

        // A peer that keeps inventing keys is refused at the ceiling: the new
        // key does not land and the rows already held stay.
        let more = built(
            2,
            invented(CAP_SETTING, "s"),
            invented(CAP_BOOKMARK + 1, "b"),
        );
        let before = store.rows("bookmark");
        assert_eq!(
            received.merge(&mut store, "device-b", &more),
            Err(Refused::Rows),
            "one row more than the note may carry is refused whole"
        );
        let extra = built(3, Vec::new(), invented(1, "z"));
        assert_eq!(
            received.merge(&mut store, "device-c", &extra),
            Ok(0),
            "a new bookmark key at the ceiling is refused, the note is not"
        );
        assert_eq!(store.rows("bookmark"), before);
        assert_eq!(store.rows("bookmark").len(), CAP_BOOKMARK);
    }

    #[test]
    fn a_row_value_above_the_ceiling_is_refused_whole() {
        let (dir, mut store) = fresh();
        let mut received = Received::default();
        let oversized = built(
            1,
            Vec::new(),
            vec![(
                "b0".to_string(),
                json!({"url": "https://example.com/", "title": "x".repeat(MAX_ROW_BYTES)}),
            )],
        );
        let before = log_bytes(dir.path());
        assert_eq!(
            received.merge(&mut store, "device-a", &oversized),
            Err(Refused::RowTooBig),
            "{}",
            Refused::RowTooBig.reason()
        );
        assert!(store.rows("bookmark").is_empty());
        assert_eq!(log_bytes(dir.path()), before);
    }

    #[test]
    fn more_new_keys_than_a_collection_holds_is_refused_whole() {
        let (dir, mut store) = fresh();
        let mut received = Received::default();
        // The largest introduction a collection allows is its own cap.
        assert_eq!(
            received.merge(
                &mut store,
                "device-a",
                &built(1, invented(CAP_SETTING, "s"), Vec::new())
            ),
            Ok(CAP_SETTING)
        );
        let over = built(2, invented(CAP_SETTING + 1, "n"), Vec::new());
        let before = log_bytes(dir.path());
        assert_eq!(
            received.merge(&mut store, "device-b", &over),
            Err(Refused::NewKeys),
            "{}",
            Refused::NewKeys.reason()
        );
        assert_eq!(store.rows("setting").len(), CAP_SETTING);
        assert_eq!(log_bytes(dir.path()), before);
    }

    #[test]
    fn a_snapshot_leaves_out_a_local_row_above_the_ceiling() {
        let (_dir, mut store) = fresh();
        store.set_setting("search", json!("duckduckgo"));
        store.set_setting("huge", json!("x".repeat(MAX_ROW_BYTES)));
        let sent = note(&store, 1);
        assert_eq!(sent["settings"]["search"]["val"], "duckduckgo");
        assert!(
            sent["settings"].get("huge").is_none(),
            "a row a peer would refuse the note for does not travel"
        );
    }
}
