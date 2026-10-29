// The picker takes the keyboard from the control that opened it, so it has to
// give it back, and it owns the outside click that closes it. Both are pinned
// as source rules because the suite has no renderer: the first was a focus
// left on the document body, the second a backdrop press that dismissed the
// dialog behind the menu as well.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./PickerMenu.jsx', import.meta.url), 'utf8')

test('the menu remembers the control that had focus and gives it back on close', () => {
  // Captured during the first render, while the trigger still holds focus,
  // which is also the moment the anchor reads its rect.
  assert.match(source, /const active = typeof document === 'undefined' \? null : document\.activeElement/)
  assert.match(source, /triggerRef\.current = active && active !== document\.body \? active : null/)
  // Handed back from the effect's cleanup, which is the moment the menu leaves.
  // Read the block rather than the file: both of these lines are also true if
  // the restore sits in the effect body, where it would steal focus back to the
  // trigger as the menu opens and leave the search field empty-handed.
  const from = source.indexOf("window.addEventListener('mousedown', close, true)")
  assert.ok(from > 0, 'the menu registers its outside click in an effect')
  const rest = source.slice(from)
  const cleanup = rest.indexOf('return () => {')
  assert.ok(cleanup > 0, 'that effect has a cleanup')
  assert.match(
    rest.slice(cleanup),
    /returnTo\?\.isConnected\) returnTo\.focus\?\.\(\{ preventScroll: true \}\)/,
    'the focus comes back from the cleanup, not from the effect body',
  )
})

test('the outside click is taken in the capture phase and stopped there', () => {
  // React delegates its handlers at the root, so a bubble-phase window
  // listener would run after a dialog's backdrop close and take the dialog
  // down with the menu. Capture runs first, and the press stops here.
  assert.match(source, /window\.addEventListener\('mousedown', close, true\)/)
  assert.match(source, /e\.stopPropagation\(\)\s*\n\s*onClose\(\)/)
  assert.match(source, /window\.removeEventListener\('mousedown', close, true\)/)
})
