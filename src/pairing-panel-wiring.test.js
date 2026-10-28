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
  // The sentence inside that guard is "No phones paired." now; the branch that wrote
  // this pin had "Nothing is listening on your network". The point is the same either
  // way: the copy sits inside the guard, never under a read that failed.
  const copy = source.indexOf('No phones paired.')
  assert.ok(guard >= 0, 'the empty state is gated on a list the daemon sent')
  assert.ok(copy > guard, 'the empty-state copy sits inside that guard')
})


test('the code is the whole control: one click shows it, a second hides it', () => {
  // The pill button that used to mint the code is gone. The code arrives on
  // its own, drawn blurred, and the square itself is the control.
  assert.equal(source.includes('Show a code'), false, 'the panel no longer offers a button that reveals the code')
  assert.ok(source.includes('className="qr-tile"'), 'the code sits in the tile')
  assert.ok(source.includes('aria-pressed={shown}'), 'a screen reader is told whether the code is showing')
  assert.ok(
    source.includes('onClick={() => setShown((on) => !on)}'),
    'the click flips that one state and nothing else',
  )
  assert.ok(source.includes('blurred={!shown}'), 'the code is drawn blurred until it is shown')
})

test('a hidden code does not hand its address to the room', () => {
  assert.ok(
    source.includes('shown ? live.url : maskedAddress(live.url)'),
    'the address carries the code in its fragment, so it is masked exactly while the code is',
  )
})

test('the view opens with a code already on screen', () => {
  assert.match(source, /useEffect\(\(\) => \{\s*start\(\)\s*\}/, 'mounting the panel asks the daemon for a code')
})
