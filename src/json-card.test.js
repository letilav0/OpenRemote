import assert from 'node:assert/strict'
import test from 'node:test'
import { jsonCaption, jsonIsLarge, jsonShape, readJson } from './json-card.js'

test('a one-field call is fields, not a JSON dump', () => {
  const shape = jsonShape({ id: 'opencode' })
  assert.equal(shape.kind, 'object')
  assert.equal(shape.fields[0].key, 'id')
  assert.equal(shape.fields[0].shape.text, 'opencode')
  assert.equal(jsonIsLarge({ id: 'opencode' }), false)
})

test('a url field keeps the address and a short label', () => {
  const field = jsonShape({ url: 'https://opencode.ai/v2/llms.txt' }).fields[0]
  assert.equal(field.shape.kind, 'url')
  assert.equal(field.shape.label, 'opencode.ai/v2/llms.txt')
})

test('a long text field folds and captions the body', () => {
  const value = [{ type: 'text', text: 'x'.repeat(4000) }]
  assert.equal(jsonIsLarge(value), true)
  assert.match(jsonCaption(value), /1 item/)
  assert.match(jsonCaption(value), /KB/)
  const item = jsonShape(value).items[0]
  assert.equal(item.fields.find((field) => field.key === 'text').shape.kind, 'folded')
})

test('a JSON string reads as the object, prose does not', () => {
  assert.equal(readJson('{"id":"opencode"}').id, 'opencode')
  assert.equal(readJson('not json'), null)
  assert.equal(readJson(''), null)
})
