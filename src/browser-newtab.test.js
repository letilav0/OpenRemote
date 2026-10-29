// The new tab page's Recent list: the addresses this computer has read, newest
// first, one per address, a handful. And the privacy rule under it: a private
// tab is never recorded, so it can never reach either list.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { RECENT_CAP, recentFor } from './browser-newtab.js'

const visit = (url, title = '', at = 0) => ({ url, title, at })

test('the recent list is the reading record, newest first, one row per address', () => {
  const history = [
    visit('https://a.example/one', 'One'),
    visit('https://b.example/two', 'Two'),
    visit('https://a.example/one', 'One again'),
    visit('https://c.example/three', 'Three'),
  ]
  const rows = recentFor(history)
  // The order history keeps, not re-sorted: the newest is already first.
  assert.deepEqual(rows.map((r) => r.url), [
    'https://a.example/one',
    'https://b.example/two',
    'https://c.example/three',
  ])
  // The first visit of an address keeps its title; the later one is the same row.
  assert.equal(rows[0].title, 'One')
})

test('the list is a handful: the cap is six, and it is pinned', () => {
  assert.equal(RECENT_CAP, 6)
  const history = Array.from({ length: 20 }, (_, i) => visit(`https://e.example/${i}`, `E ${i}`))
  const rows = recentFor(history)
  assert.equal(rows.length, RECENT_CAP)
  assert.equal(rows[0].url, 'https://e.example/0')
  // A caller can ask for fewer; nothing can ask for more than the page draws.
  assert.equal(recentFor(history, { cap: 2 }).length, 2)
})

test('nothing visited, nothing malformed, nothing invented', () => {
  assert.deepEqual(recentFor([]), [])
  assert.deepEqual(recentFor(null), [])
  assert.deepEqual(recentFor(undefined), [])
  // Rows without an address are dropped rather than drawn as an empty line.
  assert.deepEqual(recentFor([visit(''), visit(null), { title: 'no address' }]), [])
  // A row with no title is still a row: the page draws its address instead.
  assert.deepEqual(recentFor([visit('https://a.example', '  ')]), [{ url: 'https://a.example', title: '' }])
})

test('the page draws the list, and a private tab is never recorded', () => {
  const view = readFileSync(new URL('./BrowserView.jsx', import.meta.url), 'utf8')
  const store = readFileSync(new URL('./browser-store.js', import.meta.url), 'utf8')
  // The shell's private flag reaches the console's tab record, or the console
  // cannot tell a private page from a normal one.
  assert.match(store, /private: p\.private === true,/)
  // The visit is recorded only for a page that is not private: the guard comes
  // before the address the visit would record.
  assert.match(view, /if \(current\?\.private\) return\s*\n\s*const url = current\?\.url/)
  // The new tab page reads the same history and opens a row in the tab.
  assert.match(view, /recentFor\(history\)/)
  assert.match(view, /onClick=\{\(\) => openUrl\(entry\.url\)\}/)
  // The quiet address line is the history list's own helper, not a second one.
  assert.match(view, /shownVisitUrl\(entry\.url\)/)
  assert.match(view, /visitLabel\(entry\)/)
})
