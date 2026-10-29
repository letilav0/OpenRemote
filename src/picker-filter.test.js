// The one dropdown engine is fed by a dozen callers. Its filter reads the
// item's `name`, and a caller whose row carries the label under another field
// (or no name yet, while a list loads) must not throw on the first keystroke:
// a crash inside the menu is a picker that cannot be searched at all. Pinned
// as a source rule because the suite has no renderer.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./PickerMenu.jsx', import.meta.url), 'utf8')

test('the search filter reads a missing name as empty, not a crash', () => {
  assert.match(
    source,
    /items\.filter\(\(i\) => String\(i\.name \?\? ''\)\.toLowerCase\(\)\.includes\(q\)\)/,
    'a nameless row is an empty match, not a TypeError',
  )
})
