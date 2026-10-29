// The new tab page's Recent list: the addresses this window has read, newest
// first, one row per address, a handful. It reads browser-history.js's record
// and nothing else: no fetch, no account, and a private tab is never recorded
// there (see the pane's visit effect), so it can never appear here.
//
// Why six: the page is a search box with a glanceable list under it. Six fills
// two short rows at the page's own width, and a longer list would push the page
// and turn the new tab into a history screen, which the pane's menu already has.

// The number the page draws. Exported so the test pins it and the page cannot
// quietly grow into a second history list.
export const RECENT_CAP = 6

/**
 * The rows the new tab page shows, from the history list (newest first):
 * one per address, keeping the first visit's title, at most `cap` of them.
 * A row with no address is not a row; a row with no title is drawn by its
 * address (visitLabel, the same rule the history list uses).
 */
export function recentFor(history, { cap = RECENT_CAP } = {}) {
  const limit = Number.isInteger(cap) && cap > 0 ? cap : RECENT_CAP
  const seen = new Set()
  const rows = []
  for (const entry of history ?? []) {
    const url = String(entry?.url ?? '')
    if (!url || seen.has(url)) continue
    seen.add(url)
    rows.push({ url, title: String(entry?.title ?? '').trim() })
    if (rows.length >= limit) break
  }
  return rows
}
