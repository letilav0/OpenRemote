import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bodyPreview,
  capLines,
  capRows,
  MAX_RENDER_LINES,
  MAX_RENDER_ROWS,
  PREVIEW_CHARS,
  shouldRenderLive,
} from './render-budget.js'

test('a live body renders on its first beat and then at most every 100ms', () => {
  assert.equal(shouldRenderLive(0, 1_000), true, 'never rendered before - the first beat renders')
  assert.equal(shouldRenderLive(1_000, 1_040), false, 'inside the window - hold the last HTML')
  assert.equal(shouldRenderLive(1_000, 1_099), false, 'still inside the window')
  assert.equal(shouldRenderLive(1_000, 1_100), true, 'the window has passed - render')
})

test('capRows keeps a bounded diff whole and slices the rest from the top', () => {
  const small = [{ i: 0 }, { i: 1 }]
  assert.deepEqual(capRows(small), { rows: small, hidden: 0 })

  const exact = Array.from({ length: MAX_RENDER_ROWS }, (_, i) => ({ i }))
  assert.equal(capRows(exact).hidden, 0, 'exactly the bound is not truncated')

  const huge = Array.from({ length: MAX_RENDER_ROWS + 3 }, (_, i) => ({ i }))
  const capped = capRows(huge)
  assert.equal(capped.rows.length, MAX_RENDER_ROWS)
  assert.equal(capped.hidden, 3)
  assert.deepEqual(capped.rows[0], { i: 0 }, 'the first rows are the ones shown')
  assert.deepEqual(capped.rows[MAX_RENDER_ROWS - 1], { i: MAX_RENDER_ROWS - 1 })
})

test('capLines keeps short output whole and caps the rest at its first lines', () => {
  assert.deepEqual(capLines('one\ntwo'), { text: 'one\ntwo', hidden: 0 })
  assert.deepEqual(capLines(''), { text: '', hidden: 0 })
  assert.deepEqual(capLines(null), { text: '', hidden: 0 })

  const lines = Array.from({ length: MAX_RENDER_LINES + 2 }, (_, i) => `line ${i}`)
  const capped = capLines(lines.join('\n'))
  assert.equal(capped.text, lines.slice(0, MAX_RENDER_LINES).join('\n'))
  assert.equal(capped.hidden, 2)
  assert.ok(capped.text.startsWith('line 0\nline 1'), 'the head is what shows')
})

test('a long tool body folds even when it is one line', () => {
  assert.equal(bodyPreview('ok').large, false)
  assert.equal(bodyPreview('one\ntwo\nthree').large, false)
  const page = 'x'.repeat(PREVIEW_CHARS + 1)
  const folded = bodyPreview(page)
  assert.equal(folded.large, true)
  assert.equal(folded.size, `${PREVIEW_CHARS + 1} chars`)
  assert.match(folded.fill, /%$/)
  const pageKb = 'x'.repeat(2400)
  assert.match(bodyPreview(pageKb).size, /KB/)
  const many = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n')
  assert.equal(bodyPreview(many).large, true)
})
