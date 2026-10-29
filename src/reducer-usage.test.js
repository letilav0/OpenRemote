// The cost and thinking-token counters with the daemon's turn id
// (daemon/crates/openremote-core/src/events.rs:63-68, 95-100). A turn's value
// is its own contribution: re-reported under a new seq it replaces what it said
// before instead of being added again. A payload with turn 0 is an older daemon
// that did not say, so it is added as it always was. The shown totals keep their
// names and stay numbers; the per-turn parts are internal to the record.

import assert from 'node:assert/strict'
import test from 'node:test'
import { chatFromSession, foldEvent, mergeSessionIntoChat } from './state/reducer.js'

const session = (over = {}) => ({ id: 'c1', status: 'running', workspace: null, updated_at: 2000, ...over })
const usage = (seq, turn, cost) => ({ type: 'usage.cost', seq, turn, cost_usd: cost })
const think = (seq, turn, tokens) => ({ type: 'thinking.tokens', seq, turn, tokens })

test('one turn re-reported under a second seq counts once, and the later value wins', () => {
  const chat = chatFromSession(session())
  foldEvent(chat, usage(1, 1, 0.4))
  foldEvent(chat, usage(2, 1, 0.25))
  assert.equal(chat.costUsd, 0.25, 'the turn is replaced, not added again')
  foldEvent(chat, think(3, 1, 40))
  foldEvent(chat, think(4, 1, 25))
  assert.equal(chat.thinkingTokens, 25)
})

test('two different turns add to each other', () => {
  const chat = chatFromSession(session())
  foldEvent(chat, usage(1, 1, 0.4))
  foldEvent(chat, usage(2, 2, 0.1))
  assert.equal(chat.costUsd, 0.5)
  foldEvent(chat, think(3, 1, 40))
  foldEvent(chat, think(4, 2, 2))
  assert.equal(chat.thinkingTokens, 42)
})

test('a turn 0 payload (an older daemon that did not say) is added twice', () => {
  const chat = chatFromSession(session())
  foldEvent(chat, usage(1, 0, 0.4))
  foldEvent(chat, usage(2, 0, 0.1))
  assert.equal(chat.costUsd, 0.5, 'two turn 0 payloads add, as they always did')
  foldEvent(chat, think(3, 0, 40))
  foldEvent(chat, think(4, 0, 2))
  assert.equal(chat.thinkingTokens, 42)
  // And an unknown-turn payload does not disturb a real turn's contribution.
  foldEvent(chat, usage(5, 1, 0.2))
  foldEvent(chat, usage(6, 0, 0.1))
  assert.equal(chat.costUsd, 0.8)
})

test('a chat that already carries a total keeps it and adds a new turn on top', () => {
  const chat = chatFromSession(session())
  foldEvent(chat, usage(1, 1, 0.4))
  const merged = mergeSessionIntoChat(chat, session({ updated_at: 3000 }))
  assert.equal(merged.costUsd, 0.4, 'the poll keeps the folded total')
  foldEvent(merged, usage(2, 2, 0.1))
  assert.equal(merged.costUsd, 0.5, 'and the next turn is added on top of it')
  assert.equal(merged.thinkingTokens, 0)
})
