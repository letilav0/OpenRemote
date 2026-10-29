// History's rules, and the one surface that shows them.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  HISTORY_CAP,
  clearHistory,
  groupByDay,
  recordVisit,
  shownVisitUrl,
  visitLabel,
} from './browser-history.js'

const at = (day, hour = 12) => new Date(2026, 9, day, hour).getTime()

test('a visit is one entry, newest first, and the cap holds', () => {
  let list = []
  for (let i = 0; i < HISTORY_CAP + 20; i += 1) {
    list = recordVisit(list, { url: `https://e.example/${i}`, title: `E ${i}`, at: at(20) })
  }
  assert.equal(list.length, HISTORY_CAP)
  assert.equal(list[0].url, `https://e.example/${HISTORY_CAP + 19}`)
  // No address is no row: a tab with nothing loaded has not been anywhere.
  assert.deepEqual(recordVisit(list, { url: '', at: at(20) }), list)
})

test('the same address twice in a row is one visit, and a late title updates it', () => {
  const first = recordVisit([], { url: 'https://a.example', title: '', at: at(20, 9) })
  const titled = recordVisit(first, { url: 'https://a.example', title: 'A', at: at(20, 9) })
  assert.equal(titled.length, 1)
  assert.equal(titled[0].title, 'A')
  // Returning to an address later is a new visit, as it should be.
  const again = recordVisit(titled, { url: 'https://b.example', at: at(20, 10) })
  const back = recordVisit(again, { url: 'https://a.example', title: 'A', at: at(20, 11) })
  assert.equal(back.length, 3)
  assert.equal(back[0].url, 'https://a.example')
})

test('readings group by day, newest day first, with the two near days named', () => {
  const now = at(21, 12)
  const list = [
    { url: 'https://today.example', title: 'T', at: at(21, 9) },
    { url: 'https://yesterday.example', title: 'Y', at: at(20, 9) },
    { url: 'https://older.example', title: 'O', at: at(12, 9) },
  ]
  const groups = groupByDay(list, now)
  assert.deepEqual(
    groups.map((g) => g.label),
    ['Today', 'Yesterday', new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric' }).format(at(12))],
  )
  assert.equal(groups[0].rows.length, 1)
  assert.equal(groups[2].rows.length, 1)
})

test('clear empties the list and nothing else', () => {
  assert.deepEqual(clearHistory(), [])
})

test('a row is drawn by its title or its address, and the address is quiet', () => {
  assert.equal(visitLabel({ url: 'https://a.example/x', title: '  ' }), 'https://a.example/x')
  assert.equal(visitLabel({ url: 'https://a.example/x', title: ' X ' }), 'X')
  assert.equal(shownVisitUrl('https://a.example/x/'), 'a.example/x')
  assert.equal(shownVisitUrl('http://b.example'), 'b.example')
})

test('the store records visits per device and the view reaches the surface', () => {
  const store = readFileSync(new URL('./browser-store.js', import.meta.url), 'utf8')
  const view = readFileSync(new URL('./BrowserView.jsx', import.meta.url), 'utf8')
  const modal = readFileSync(new URL('./BrowserHistoryModal.jsx', import.meta.url), 'utf8')
  // Per device, beside the bookmarks, with no daemon route and no account.
  assert.match(store, /export function recordVisit\(/)
  assert.match(store, /localStorage\.setItem\(HISTORY_KEY/)
  assert.doesNotMatch(store, /browser_history/)
  // Reached from the pane's own menu; grouped rows open through the pane.
  assert.match(view, /label: 'History'/)
  assert.match(view, /<BrowserHistoryModal/)
  assert.match(modal, /groupByDay/)
  assert.match(modal, /Clear history/)
})
