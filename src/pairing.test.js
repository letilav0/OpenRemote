import assert from 'node:assert/strict'
import test from 'node:test'
import { pairedLabel, pairingError, phoneName, remainingLabel } from './pairing.js'

test('a code counts down to the second, then says it is gone', () => {
  const now = 1_000_000
  assert.equal(remainingLabel(now + 300_000, now), 'Expires in 5:00')
  assert.equal(remainingLabel(now + 90_000, now), 'Expires in 1:30')
  assert.equal(remainingLabel(now + 9_000, now), 'Expires in 0:09')
  // The daemon's clock and this one are the same machine, but a code that
  // is past its end is past it either way.
  assert.equal(remainingLabel(now - 1, now), 'Expired')
  assert.equal(remainingLabel(now, now), 'Expired')
  assert.equal(remainingLabel(null, now), 'Expired')
  assert.equal(remainingLabel('later', now), 'Expired')
})

test('a paired phone reads in the console shorthand', () => {
  const now = 1_700_000_000_000
  assert.equal(pairedLabel({ paired_at: now - 20_000 }, now), 'Paired just now')
  assert.equal(pairedLabel({ paired_at: now - 5 * 60_000 }, now), 'Paired 5 min ago')
  assert.equal(pairedLabel({ paired_at: now - 3 * 60 * 60_000 }, now), 'Paired 3 h ago')
  assert.equal(pairedLabel({ paired_at: now - 2 * 24 * 60 * 60_000 }, now), 'Paired 2 d ago')
  // A record without a time says only what it knows.
  assert.equal(pairedLabel({}, now), 'Paired')
  assert.equal(pairedLabel(null, now), 'Paired')
})

test('a phone name is cleaned the way the daemon cleans it', () => {
  assert.equal(phoneName('  iPhone   15  '), 'iPhone 15')
  assert.equal(phoneName('a phone\nwith a break'), 'a phone with a break')
  assert.equal(phoneName('x'.repeat(60)).length, 40)
  assert.equal(phoneName(''), 'Phone')
  assert.equal(phoneName('   '), 'Phone')
  assert.equal(phoneName(null), 'Phone')
  assert.equal(phoneName(undefined), 'Phone')
})

test('a phone name cannot carry a direction override past the list', () => {
  // The real characters, not escapes of them: a name written from the right
  // must not reorder the row it is drawn in, and a hidden character must not
  // become a visible column of its own.
  assert.equal(phoneName('Pixel\u202E'), 'Pixel')
  assert.equal(phoneName('\u202E\u200B'), 'Phone')
  assert.equal(phoneName('Pixel\u200B Phone'), 'Pixel Phone')
  assert.equal(phoneName('Pixel\u202Eabc'), 'Pixelabc')
  // A soft hyphen and a zero-width joiner are format characters too, and a
  // byte-order mark in the middle of a name must go rather than become a
  // space the way a whitespace character would.
  assert.equal(phoneName('Pi\u00ADxel\u200D'), 'Pixel')
  assert.equal(phoneName('Pi\uFEFFxel'), 'Pixel')
  // Ordinary names are untouched: accented Latin and CJK are not invisible.
  assert.equal(phoneName('Téléphone de Zoé'), 'Téléphone de Zoé')
  assert.equal(phoneName('山田のスマホ'), '山田のスマホ')
  assert.equal(phoneName('Büro Pixel'), 'Büro Pixel')
  assert.equal(phoneName('电话 Pixel'), '电话 Pixel')
  // The daemon's two: eighty invisibles after a word leave the word, and
  // invisibles alone leave nothing, which is the fallback. The cap counts
  // characters as the daemon does, not UTF-16 units.
  assert.equal(phoneName(`Pixel${'\u200B'.repeat(80)}`), 'Pixel')
  assert.equal(phoneName('\u202E\u200B\uFEFF'), 'Phone')
  assert.equal(Array.from(phoneName('😀'.repeat(60))).length, 40)
})

test('a failure says what happened, in the words the surface shows', () => {
  const noNetwork = Object.assign(new Error('This computer is not on a network.'), { status: 409 })
  assert.equal(pairingError(noNetwork), 'This computer is not on a network.')
  const gone = Object.assign(new Error('That phone is not paired with this computer.'), { status: 404 })
  assert.equal(pairingError(gone), 'That phone is not paired with this computer.')
  // A known shape with no sentence still reads as a sentence.
  assert.equal(pairingError({ status: 409 }), 'This computer cannot take a phone right now.')
  assert.equal(pairingError({ status: 404 }), 'That phone is not paired with this computer.')
  assert.equal(
    pairingError(new Error('The daemon did not answer in time')),
    'The daemon did not answer in time. Try again.',
  )
  assert.equal(
    pairingError(new Error('The console is not connected to its daemon yet.')),
    'The console is not connected to its daemon yet.',
  )
  // fetch throws a TypeError when there is nothing listening at all.
  assert.equal(pairingError(new TypeError('Failed to fetch')), 'The console could not reach its daemon.')
  assert.equal(pairingError(null), 'Pairing failed.')
})
