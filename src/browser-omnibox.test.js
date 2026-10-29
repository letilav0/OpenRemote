// What the address bar suggests while a prefix is typed: the rules that rank
// this device's kept and read addresses, and the wiring that draws them.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { SUGGEST_LIMIT, suggest } from './browser-omnibox.js'

const mark = (url, title, at = 0) => ({ url, title, at })
const visit = (url, title, at = 0) => ({ url, title, at })

test('an empty field suggests nothing, and the cap is the short list', () => {
  assert.deepEqual(suggest({ typed: '   ' }), [])
  const visits = Array.from({ length: SUGGEST_LIMIT + 4 }, (_, i) => visit(`https://e.example/${i}`, `E ${i}`, i))
  assert.equal(suggest({ typed: 'e', visits }).length, SUGGEST_LIMIT)
  assert.equal(SUGGEST_LIMIT, 6)
})

test('a title that starts with the letters beats the same letters inside a title', () => {
  const rows = suggest({
    typed: 'docs',
    visits: [visit('https://a.example/intro-to-docs', 'Intro to docs'), visit('https://b.example/docs-page', 'Docs page')],
  })
  assert.equal(rows[0].url, 'https://b.example/docs-page')
})

test('kept beats a plain visit of the same quality, and recent wins among equals', () => {
  const rows = suggest({
    typed: 'pl',
    marks: [mark('https://kept.example', 'Plex')],
    visits: [visit('https://old.example', 'Plex old', 10), visit('https://new.example', 'Plex new', 20)],
  })
  assert.equal(rows[0].url, 'https://kept.example')
  assert.equal(rows[0].kept, true)
  // Both history hits have the same quality: the newer one is first.
  assert.equal(rows[1].url, 'https://new.example')
  assert.equal(rows[2].url, 'https://old.example')
})

test('one address is one row, and the kept one marks it', () => {
  const url = 'https://both.example/'
  const rows = suggest({ typed: 'both', marks: [mark(url, 'Both')], visits: [visit(url, 'Both')] })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kept, true)
})

test('the list is keyboard reachable from the field and the field keeps focus', () => {
  const view = readFileSync(new URL('./BrowserView.jsx', import.meta.url), 'utf8')
  const list = readFileSync(new URL('./BrowserSuggestions.jsx', import.meta.url), 'utf8')
  assert.match(view, /suggest\(\{ typed: typedLine, marks: bookmarks, visits: history \}\)/)
  assert.match(view, /aria-activedescendant=/)
  assert.match(view, /aria-controls="bw-suggest"/)
  assert.match(view, /setSuggestion\(\(i\) =>/)
  assert.match(list, /role="listbox"/)
  assert.match(list, /role="option"/)
  assert.match(list, /aria-selected=\{i === active\}/)
})
