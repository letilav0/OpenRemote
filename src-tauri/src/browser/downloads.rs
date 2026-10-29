//! The tabs' download ledger.
//!
//! The engine reports a download twice: once when it is requested, and once
//! when it finishes. Only the first of the two says where the file is going,
//! and only the second says how it ended, so a row on the console is one entry
//! that both events write to. A finish that matches no start still happened:
//! it becomes a row of its own rather than being dropped, and rather than
//! borrowing an id, because two downloads the console cannot tell apart are
//! worse than none.

use super::Download;

/// Every row a tab has started and not yet finished, in the order they began.
#[derive(Debug, Default)]
pub(crate) struct Ledger {
    next: u64,
    /// (tab, address, id) of each start still waiting for its finish.
    started: Vec<(String, String, u64)>,
}

impl Ledger {
    /// The next row id. Ids are never reused, so a late finish that finds no
    /// start can take a fresh one and still be told apart from every other.
    fn row(&mut self) -> u64 {
        self.next += 1;
        self.next
    }

    /// A download a tab asked for: its row starts now and ends later.
    pub(crate) fn requested(&mut self, tab: &str, url: &str, path: Option<String>) -> Download {
        let id = self.row();
        self.started.push((tab.to_string(), url.to_string(), id));
        Download {
            id,
            tab: tab.to_string(),
            url: url.to_string(),
            path,
            state: "started",
        }
    }

    /// A download that ended. A finish carries its tab and its address and
    /// nothing else, so the newest start with both is the row it came from:
    /// that is the row the console already shows. With no such start the
    /// finish is a row of its own.
    pub(crate) fn finished(
        &mut self,
        tab: &str,
        url: &str,
        path: Option<String>,
        success: bool,
    ) -> Download {
        let id = match self
            .started
            .iter()
            .rposition(|(started_tab, started_url, _)| started_tab == tab && started_url == url)
        {
            Some(at) => self.started.remove(at).2,
            None => self.row(),
        };
        Download {
            id,
            tab: tab.to_string(),
            url: url.to_string(),
            path,
            state: if success { "done" } else { "failed" },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path(p: &str) -> Option<String> {
        Some(p.to_string())
    }

    #[test]
    fn a_download_takes_a_row_of_its_own_when_it_starts() {
        let mut ledger = Ledger::default();
        let row = ledger.requested("tab-1", "https://example.com/a.zip", path("a.zip"));
        assert_eq!(row.id, 1);
        assert_eq!(row.state, "started");
        assert_eq!(row.tab, "tab-1");
        assert_eq!(row.url, "https://example.com/a.zip");
        assert_eq!(row.path.as_deref(), Some("a.zip"));
    }

    #[test]
    fn an_allowed_download_finishes_the_row_its_request_opened() {
        let mut ledger = Ledger::default();
        let started = ledger.requested("tab-1", "https://example.com/a.zip", path("a.zip"));
        let finished = ledger.finished("tab-1", "https://example.com/a.zip", path("a.zip"), true);
        assert_eq!(
            finished.id, started.id,
            "the console updates the row it is already showing"
        );
        assert_eq!(finished.state, "done");
        assert!(
            ledger.started.is_empty(),
            "a finished row is not left waiting for another finish"
        );
    }

    #[test]
    fn a_refused_download_is_one_row_whether_or_not_it_reports_a_finish() {
        let mut ledger = Ledger::default();
        let rows: Vec<Download> = (0..3)
            .map(|_| ledger.finished("tab-1", "https://example.com/refused.bin", None, false))
            .collect();
        assert_eq!(
            rows.iter().map(|row| row.id).collect::<Vec<_>>(),
            vec![1, 2, 3],
            "every unmatched finish is its own row, never id 0 and never a shared one"
        );
        assert!(rows.iter().all(|row| row.state == "failed"));
    }

    #[test]
    fn the_newest_start_with_that_address_is_the_row_that_finishes() {
        let mut ledger = Ledger::default();
        let first = ledger.requested("tab-1", "https://example.com/twice.zip", path("1"));
        let second = ledger.requested("tab-1", "https://example.com/twice.zip", path("2"));
        let done = ledger.finished("tab-1", "https://example.com/twice.zip", path("2"), true);
        assert_eq!(done.id, second.id, "the newer row is the one on screen");
        assert_eq!(
            ledger.started,
            vec![(
                "tab-1".to_string(),
                "https://example.com/twice.zip".to_string(),
                first.id
            )],
            "the earlier start is still waiting for its own finish"
        );
        let other = ledger.finished("tab-1", "https://example.com/twice.zip", path("1"), true);
        assert_eq!(
            other.id, first.id,
            "the earlier finish takes the earlier row"
        );
    }

    #[test]
    fn another_tabs_start_with_the_same_address_is_not_consumed() {
        let mut ledger = Ledger::default();
        let one = ledger.requested("tab-1", "https://example.com/data.csv", path("one"));
        let two = ledger.requested("tab-2", "https://example.com/data.csv", path("two"));
        let done_two = ledger.finished("tab-2", "https://example.com/data.csv", path("two"), true);
        assert_eq!(done_two.id, two.id);
        let done_one = ledger.finished("tab-1", "https://example.com/data.csv", path("one"), true);
        assert_eq!(
            done_one.id, one.id,
            "a finish belongs to the tab that asked"
        );
    }
}
