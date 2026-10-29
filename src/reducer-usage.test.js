// The cost and thinking-token counters with the daemon's turn id
// (daemon/crates/openremote-core/src/events.rs:63-68, 95-100). A turn that is
// present owns its contribution, including turn 0, which the daemon's first
// turn is: re-reported under a new seq it replaces what it said instead of
// being added again. A payload with no turn (null, or absent from an older
// daemon) is added as it always was. The shown totals keep their names and stay
// numbers; the per-turn parts are internal to the record.

import assert from 'node:assert/strict'
import test from 'node:test'
import { chatFromSession, foldEvent, mergeSessionIntoChat } from './state/reducer.js'

const session = (over = {}) => ({ id: 'c1', status: 'running', workspace: null, updated_at: 2000, ...over })
const usage = (seq, turn, cost) => ({ type: 'usage.cost', seq, turn, cost_usd: cost })
const think = (seq, turn, tokens) => ({ type: 'thinking.tokens', seq, turn, tokens })
const untold = (seq, cost) => ({ type: 'usage.cost', seq, cost_usd: cost })

test('one turn re-reported under a second seq counts once, and the later value wins', () => {
  const chat = chatFromSession(session())
  foldEvent(chat, usage(1, 0, 0.4))
  foldEvent(chat, usage(2, 0, 0.25))
  assert.equal(chat.costUsd, 0.25, 'the turn is replaced, not added again')
  foldEvent(chat, think(3, 0, 40))
  foldEvent(chat, think(4, 0, 25))
  assert.equal(chat.thinkingTokens, 25)
})

test('two different turns add to each other', () => {
  const chat = chatFromSession(session())
  foldEvent(chat, usage(1, 0, 0.4))
  foldEvent(chat, usage(2, 1, 0.1))
  assert.equal(chat.costUsd, 0.5)
  foldEvent(chat, think(3, 0, 40))
  foldEvent(chat, think(4, 1, 2))
  assert.equal(chat.thinkingTokens, 42)
})

test('turn 0 is a real turn: it replaces itself, and another turn adds on top', () => {
  // The daemon's first turn is 0 (supervisor.rs's current_turn), which is why
  // the wire field is optional rather than reserving 0 for "not said".
  const chat = chatFromSession(session())
  foldEvent(chat, usage(1, 0, 0.4))
  foldEvent(chat, usage(2, 0, 0.25))
  assert.equal(chat.costUsd, 0.25, 'turn 0 owns its contribution')
  foldEvent(chat, usage(3, 1, 0.1))
  assert.equal(chat.costUsd, 0.35, 'and a later turn still adds to it')
  foldEvent(chat, think(4, 0, 40))
  foldEvent(chat, think(5, 0, 25))
  assert.equal(chat.thinkingTokens, 25)
})

test('a payload with no turn (an older daemon that did not say) is added twice', () => {
  const chat = chatFromSession(session())
  foldEvent(chat, usage(1, null, 0.4))
  foldEvent(chat, usage(2, null, 0.1))
  assert.equal(chat.costUsd, 0.5, 'two no-turn payloads add, as they always did')
  foldEvent(chat, untold(3, 0.1))
  assert.equal(chat.costUsd, 0.6, 'and an absent field adds the same way')
  foldEvent(chat, think(4, null, 40))
  foldEvent(chat, think(5, undefined, 2))
  assert.equal(chat.thinkingTokens, 42)
  // A no-turn payload does not disturb a real turn's contribution.
  foldEvent(chat, usage(6, 0, 0.2))
  foldEvent(chat, usage(7, null, 0.1))
  assert.ok(Math.abs(chat.costUsd - 0.9) < 1e-9, `cost is ${chat.costUsd}`)
})

test('a chat that already carries a total keeps it and adds a new turn on top', () => {
  const chat = chatFromSession(session())
  foldEvent(chat, usage(1, 0, 0.4))
  const merged = mergeSessionIntoChat(chat, session({ updated_at: 3000 }))
  assert.equal(merged.costUsd, 0.4, 'the poll keeps the folded total')
  foldEvent(merged, usage(2, 1, 0.1))
  assert.equal(merged.costUsd, 0.5, 'and the next turn is added on top of it')
  assert.equal(merged.thinkingTokens, 0)
})
