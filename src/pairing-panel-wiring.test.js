// The phone list is null until the daemon answers, and the empty state is a
// claim about the network ("nothing is listening on your network") that only
// an answer can support. A failed read that stored an empty list drew that
// sentence underneath the error saying the read had failed, which is the
// same shape the daemon side had before it was fixed. The panel is JSX, so
// this reads it rather than rendering it: the sentence's guard and the one
// write that used to break it are both literal text.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./PairingSection.jsx', import.meta.url), 'utf8')

test('a phone read that failed leaves the list alone', () => {
  assert.equal(
    source.includes('setPhones([])'),
    false,
    'a failed read must not store an empty list: that draws the empty-state copy under the error that says the read failed',
  )
})

test('the empty state waits for a list that arrived', () => {
  const guard = source.indexOf('phones !== null && phones.length === 0')
  const copy = source.indexOf('Nothing is listening on your network')
  assert.ok(guard >= 0, 'the empty state is gated on a list the daemon sent')
  assert.ok(copy > guard, 'the empty-state copy sits inside that guard')
})
