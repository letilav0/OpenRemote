// The Browser section in Settings: the words a person types for what the
// browser keeps, the rows that say where each thing lives, and the two
// actions that clear from here. The rest is pinned as source: the view draws
// those rows and calls the store's own functions rather than restating them.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { SECTIONS, SETTINGS_ENTRIES, searchSettings } from './settings-search.js'

const browserRows = SETTINGS_ENTRIES.filter((e) => e.section === 'browser')

test('the Browser section exists, in the System group, with its own tab', () => {
  const section = SECTIONS.find((s) => s.id === 'browser')
  assert.ok(section, 'a Browser section is in the tab list')
  assert.equal(section.label, 'Browser')
  assert.equal(section.group, 'system')
  assert.equal(section.phone, false)
  // The section's own row answers the words a person types for its contents.
  const own = SETTINGS_ENTRIES.find((e) => e.key === 'browser')
  for (const word of ['browser', 'history', 'cookies', 'bookmarks', 'downloads', 'clear']) {
    assert.ok(own.terms.includes(word), `the section row carries "${word}"`)
  }
})

test('a person finds the section by the words they would type', () => {
  for (const [word, key] of [
    ['history', 'browser-history'],
    ['cookies', 'browser-profile'],
    ['bookmarks', 'browser-bookmarks'],
    ['downloads', 'browser-downloads'],
    ['clear', 'browser-history-clear'],
  ]) {
    const rows = searchSettings(word, SETTINGS_ENTRIES)
    assert.ok(rows.some((e) => e.key === key), `"${word}" reaches ${key}`)
    assert.ok(rows.some((e) => e.section === 'browser'), `"${word}" reaches the section`)
  }
})

test('the rows say where the browser keeps each thing', () => {
  // Facts first, then the actions: each fact names its home in words.
  const byKey = Object.fromEntries(browserRows.map((e) => [e.key, e]))
  assert.match(byKey['browser-bookmarks'].detail, /on this computer/i)
  assert.match(byKey['browser-history'].detail, /on this computer only/i)
  assert.match(byKey['browser-history'].detail, /private tab/i)
  assert.match(byKey['browser-profile'].detail, /cookies/i)
  assert.match(byKey['browser-profile'].detail, /browser's own menu/i, 'says where it is cleared')
  assert.match(byKey['browser-downloads'].detail, /Downloads folder/i)
  // Nothing offered here is an action that cannot act: the profile row has no
  // clear button, and its sentence sends the person to the pane.
  assert.equal(
    browserRows.some((e) => /cookies-clear|profile-clear/.test(e.key)),
    false,
    'no dead "clear cookies" action in the index',
  )
})

test('the view draws the section and calls the store its rules live in', () => {
  const view = readFileSync(new URL('./SettingsView.jsx', import.meta.url), 'utf8')
  assert.match(view, /data-stg="browser"/)
  for (const key of [
    'browser-bookmarks',
    'browser-history',
    'browser-profile',
    'browser-downloads',
    'browser-history-clear',
    'browser-bookmarks-clear',
    'browser-downloads-open',
  ]) {
    assert.match(view, new RegExp(`data-stg="${key}"`), `${key} is drawn`)
  }
  // Clearing reads the store: its clear, its remove, its state. No second copy.
  assert.match(view, /from '\.\/browser-store\.js'/)
  assert.match(view, /clearHistory\(\)/)
  assert.match(view, /removeBookmark\(mark\.id\)/)
  assert.match(view, /useSyncExternalStore\(subscribeBrowser, getBrowserState\)/)
  // The shell call the pane's download row already makes.
  assert.match(view, /callShell\('browser_reveal', \{ path: lastDownload\.path \}\)/)
  // Both clears ask once, through the shared armed-row rule.
  assert.match(view, /armRow\(current, 'browser-history-clear'\)/)
  assert.match(view, /armRow\(current, 'browser-bookmarks-clear'\)/)
})
