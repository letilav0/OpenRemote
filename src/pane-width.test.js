// The browser pane's width: one preference, clamped to the window it is drawn in.
import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_PANE_WIDTH, MAX_PANE_SHARE, MIN_PANE_WIDTH, clampPaneWidth } from './pane-width.js'

test('a width is clamped to what the window can give it', () => {
  // A laptop window: the default fits, and a drag to a wide value stops at the share.
  assert.equal(clampPaneWidth(DEFAULT_PANE_WIDTH, 1440), DEFAULT_PANE_WIDTH)
  assert.equal(clampPaneWidth(2000, 1440), Math.floor(1440 * MAX_PANE_SHARE))
  // Below the readable minimum the pane stops: a page at 200px is a phone layout.
  assert.equal(clampPaneWidth(120, 1440), MIN_PANE_WIDTH)
  // A narrow window never produces a pane wider than the window's share.
  const narrow = 500
  assert.ok(clampPaneWidth(900, narrow) <= Math.max(MIN_PANE_WIDTH, Math.floor(narrow * MAX_PANE_SHARE)))
})

test('a width that is not a number is the default, not a broken pane', () => {
  assert.equal(clampPaneWidth(Number.NaN, 1440), DEFAULT_PANE_WIDTH)
  assert.equal(clampPaneWidth('wide', 1440), DEFAULT_PANE_WIDTH)
  assert.equal(clampPaneWidth(null, 1440), DEFAULT_PANE_WIDTH)
  // No window to measure (a test, or a first render) still answers something usable.
  assert.equal(clampPaneWidth(DEFAULT_PANE_WIDTH, 0), DEFAULT_PANE_WIDTH)
})
