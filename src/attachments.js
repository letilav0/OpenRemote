// What waits to ride a composer's next message besides its text: pictures
// (pasted, dropped, a screenshot of a page) and elements picked in the
// built-in browser. Kept per composer in a plain module - a chat's id, or
// 'new' for the home screen's - so the browser can hand something to the
// composer the user is looking at without the two knowing each other.
//
// An item is one of:
//   { kind: 'image', name, mime, dataUrl }
//   { kind: 'element', label, details, url, title, dataUrl? }
// `details` is the element as text (role, name, text, selector, a short
// piece of its HTML), sent with the message; `dataUrl` its picture.

const byComposer = new Map()
const listeners = new Set()
let focused = 'new'
let next = 1

function changed() {
  for (const fn of listeners) fn()
}

// The composer the user is in now: the browser's picks go there.
export function setFocusedComposer(key) {
  focused = key || 'new'
}

export function focusedComposer() {
  return focused
}

export function attachments(key) {
  return byComposer.get(key || 'new') ?? []
}

export function addAttachment(item, key = focused) {
  const id = `a${next++}`
  const list = attachments(key)
  byComposer.set(key || 'new', [...list, { ...item, id }])
  changed()
  return id
}

export function removeAttachment(key, id) {
  byComposer.set(key || 'new', attachments(key).filter((a) => a.id !== id))
  changed()
}

export function clearAttachments(key) {
  byComposer.delete(key || 'new')
  changed()
}

// A message's attachments moving with it (the home screen's composer
// becoming a new chat's).
export function moveAttachments(from, to) {
  const list = attachments(from)
  if (!list.length) return
  byComposer.delete(from || 'new')
  byComposer.set(to, [...attachments(to), ...list])
  changed()
}

export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
