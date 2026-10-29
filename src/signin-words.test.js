// The reading the sign-in sheet does over the harness's own words: which
// address to open, which aside belongs before it, and how to name the address
// so it fits on a line. Pinned here so the sheet never has to guess.

import assert from 'node:assert/strict'
import test from 'node:test'
import { addressLabel, addressToOpen, asideAbout, readSignInWords } from './signin-words.js'

// The shape codex prints, shortened: a local server, an authorize address, and
// an aside for machines without a desktop.
const codex = [
  'Starting local login server on http://localhost:1455.',
  'If your browser did not open, navigate to this URL to authenticate:',
  'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoam&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&code_challenge=DRXOnVbPzBi&scope=openid',
  'On a remote or headless machine? Use `codex login --device-auth` instead.',
]

test('the address to open is the authorize one, not the local server', () => {
  assert.match(addressToOpen(codex), /^https:\/\/auth\.openai\.com\/oauth\/authorize\?/)
})

test('a full stop after an address belongs to the sentence', () => {
  const words = ['Open https://example.com/sign-in. Then finish.']
  assert.equal(addressToOpen(words), 'https://example.com/sign-in')
})

test('the aside about a headless machine is lifted verbatim', () => {
  assert.equal(
    asideAbout(codex),
    'On a remote or headless machine? Use `codex login --device-auth` instead.',
  )
  assert.equal(asideAbout(['nothing to see here']), null)
})

test('an address is named by its host, because the query is unreadable', () => {
  assert.equal(addressLabel(codex[2]), 'auth.openai.com')
  assert.equal(addressLabel('http://localhost:1455'), 'localhost:1455')
})

test('with no address there is nothing to open, and the words are kept', () => {
  const read = readSignInWords(['The harness wants a paste of its code.'])
  assert.equal(read.address, null)
  assert.equal(read.aside, null)
  assert.deepEqual(read.words, ['The harness wants a paste of its code.'])
  // Anything that is not a line of words is not a line.
  assert.deepEqual(readSignInWords([null, 3, 'ok']).words, ['ok'])
})
