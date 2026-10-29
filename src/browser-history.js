// History's small rules: one entry per page shown, newest first, the same
// address twice in a row is one visit (a title arriving late is the same
// visit, not a new one), the list is capped, and the readings group by the
// day they happened. Pure: no DOM, no clock of its own, so the tests can pin
// the day boundaries. History is this device's reading record only; nothing
// here is sent anywhere.

// Five hundred pages: enough that a week of ordinary reading is there, small
// enough that one localStorage key stays a few tens of kilobytes.
export const HISTORY_CAP = 500

export function recordVisit(entries, { url, title = '', at = 0 } = {}) {
  const list = entries ?? []
  const clean = String(title ?? '').trim()
  if (!url) return list
  if (list[0]?.url === url) {
    // The page is still the same visit: a title that lands a moment later
    // updates that row instead of making a second one.
    return [{ ...list[0], title: clean || list[0].title, at }, ...list.slice(1)]
  }
  return [{ url, title: clean, at }, ...list].slice(0, HISTORY_CAP)
}

export function clearHistory() {
  return []
}

function startOfDay(at) {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date
}

function dayKey(at) {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function dayLabel(at, now) {
  const today = dayKey(now)
  // Yesterday by the calendar, not by subtracting 24 hours: a DST shift makes
  // that subtraction land on today or the day before yesterday.
  const back = startOfDay(now)
  back.setDate(back.getDate() - 1)
  const yesterday = dayKey(back.getTime())
  const key = dayKey(at)
  if (key === today) return 'Today'
  if (key === yesterday) return 'Yesterday'
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric' }).format(at)
}

// [{ label: 'Today', rows: [...] }, ...] newest day first; the rows keep the
// order they were recorded in, which is newest first.
export function groupByDay(entries, now = Date.now()) {
  const groups = []
  for (const entry of entries ?? []) {
    const label = dayLabel(entry.at, now)
    const last = groups[groups.length - 1]
    if (last?.label === label) last.rows.push(entry)
    else groups.push({ label, rows: [entry] })
  }
  return groups
}

// What a row is drawn by: the page's title, or its address when it never had
// one. Never an empty row.
export function visitLabel(entry) {
  const title = String(entry?.title ?? '').trim()
  return title || String(entry?.url ?? '')
}

// The address without its scheme, for the quiet second line under a title.
export function shownVisitUrl(url) {
  return String(url ?? '').replace(/^https?:\/\//i, '').replace(/\/$/, '')
}
