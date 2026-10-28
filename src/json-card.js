// A tool body's JSON, as fields the card can draw. A `{ "url": "..." }`
// dump is not a picture of the call. Pure, so the shapes are tested
// without a harness.

import { bodyPreview } from './render-budget.js'

const MAX_FIELDS = 8
const MAX_ITEMS = 3
const MAX_DEPTH = 2

/// An object or array, from a value or from a JSON string. Anything else
/// stays text. A huge string is left unparsed: the card already folds it.
export function readJson(value) {
  if (value && typeof value === 'object') return value
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length > 512_000) return null
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object') return parsed
  } catch {
    return null
  }
  return null
}

/// The picture of one JSON value. `folded` is a long string. `url` is a
/// short address. Nested objects stop at two levels.
export function jsonShape(value, depth = 0) {
  if (value == null) return { kind: 'scalar', text: 'null' }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return { kind: 'scalar', text: String(value) }
  }
  if (typeof value === 'string') return stringShape(value, depth)
  if (Array.isArray(value)) {
    return {
      kind: 'list',
      count: value.length,
      items: value.slice(0, MAX_ITEMS).map((item) => jsonShape(item, depth + 1)),
      more: Math.max(0, value.length - MAX_ITEMS),
    }
  }
  const entries = Object.entries(value)
  return {
    kind: 'object',
    count: entries.length,
    fields: entries.slice(0, MAX_FIELDS).map(([key, val]) => ({
      key,
      mono: isCodeKey(key),
      shape: depth >= MAX_DEPTH ? foldValue(val) : jsonShape(val, depth + 1),
    })),
    more: Math.max(0, entries.length - MAX_FIELDS),
  }
}

/// Words for a folded JSON body: what it is, and how big the long part is.
export function jsonCaption(value) {
  const shape = jsonShape(value)
  const size = foldedSize(shape)
  if (shape.kind === 'list') {
    const noun = shape.count === 1 ? '1 item' : `${shape.count} items`
    return size ? `${noun} · ${size}` : noun
  }
  if (shape.kind === 'object') {
    const keys = shape.fields.map((field) => field.key).slice(0, 3).join(', ')
    const noun = keys || (shape.count === 1 ? '1 field' : `${shape.count} fields`)
    return size ? `${noun} · ${size}` : noun
  }
  return size || 'JSON'
}

export function jsonIsLarge(value) {
  return shapeIsLarge(jsonShape(value))
}

function stringShape(text, depth) {
  const trimmed = text.trim()
  if (/^https?:\/\/\S+$/i.test(trimmed)) {
    return { kind: 'url', href: trimmed, label: urlLabel(trimmed) }
  }
  if (depth < MAX_DEPTH && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
    const nested = readJson(trimmed)
    if (nested) return jsonShape(nested, depth + 1)
  }
  const preview = bodyPreview(text)
  if (preview.large) {
    return { kind: 'folded', size: preview.size, fill: preview.fill, text: preview.text, hidden: preview.hidden }
  }
  return { kind: 'scalar', text }
}

function foldValue(value) {
  const preview = bodyPreview(typeof value === 'string' ? value : JSON.stringify(value))
  return { kind: 'folded', size: preview.size, fill: preview.fill, text: preview.text, hidden: preview.hidden }
}

function foldedSize(shape) {
  if (!shape || typeof shape !== 'object') return null
  if (shape.kind === 'folded') return shape.size
  if (shape.kind === 'object') {
    for (const field of shape.fields) {
      const size = foldedSize(field.shape)
      if (size) return size
    }
  }
  if (shape.kind === 'list') {
    for (const item of shape.items) {
      const size = foldedSize(item)
      if (size) return size
    }
  }
  return null
}

function shapeIsLarge(shape) {
  if (!shape) return false
  if (shape.kind === 'folded') return true
  if (shape.kind === 'object') {
    return shape.more > 0 || shape.fields.some((field) => shapeIsLarge(field.shape))
  }
  if (shape.kind === 'list') {
    return shape.count > MAX_ITEMS || shape.more > 0 || shape.items.some(shapeIsLarge)
  }
  return false
}

function isCodeKey(key) {
  return /code|command|query|text|content|script|body/i.test(key)
}

function urlLabel(href) {
  try {
    const url = new URL(href)
    const path = url.pathname === '/' ? '' : url.pathname
    return `${url.host}${path}`
  } catch {
    return href
  }
}
