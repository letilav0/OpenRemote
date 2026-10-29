// What the cost and thinking-token counters can and cannot know. A usage event
// carries no turn id (daemon/crates/openremote-core/src/events.rs:58-59, 84-85),
// so the only identity it has is its seq: a replayed event is the same seq and
// the fold drops it, while two different seqs always count, even when the
// payloads are identical. That limit is pinned here so nobody assumes a turn
// identity the wire does not carry.

import assert from 'node:assert/strict'
import test from 'node:test'
import { chatFromSession, foldEvent } from './state/reducer.js'

const session = (over = {}) => ({ id: 'c1', status: 'running', workspace: null, updated_at: 2000, ...over })

test('a replayed usage event counts once, and two seqs count as two turns', () => {
  const chat = chatFromSession(session())
  // The same turn's usage delivered twice by a reconnect: the seq is the same,
  // so the fold takes it once.
  foldEvent(chat, { type: 'usage.cost', seq: 5, cost_usd: 0.4 })
  foldEvent(chat, { type: 'usage.cost', seq: 5, cost_usd: 0.4 })
  assert.equal(chat.costUsd, 0.4, 'a replayed frame does not add its cost again')

  foldEvent(chat, { type: 'thinking.tokens', seq: 6, tokens: 42 })
  foldEvent(chat, { type: 'thinking.tokens', seq: 6, tokens: 42 })
  assert.equal(chat.thinkingTokens, 42, 'and does not add its thinking tokens again')

  // A different seq is a different fold, and the console has no way to tell a
  // genuinely new turn from the same turn re-reported under a new seq: that is
  // the limit the daemon has to close with a turn id.
  foldEvent(chat, { type: 'usage.cost', seq: 7, cost_usd: 0.4 })
  foldEvent(chat, { type: 'thinking.tokens', seq: 8, tokens: 42 })
  assert.equal(chat.costUsd, 0.8)
  assert.equal(chat.thinkingTokens, 84)
})
