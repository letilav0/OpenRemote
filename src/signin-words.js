// The harness's sign-in words, read rather than rewritten.
//
// A CLI prints a wall of text when it wants a person to sign in: a notice
// about the local server it started, an authorize address that can be several
// hundred characters long, sometimes a hint for headless machines. The console
// keeps every word the harness said - it never paraphrases - and lifts the two
// things a person acts on: the address to open, and the aside they might need.
// Pure, so the reading is tested without a DOM.

// An address in running text, with the punctuation a sentence puts after it
// taken off: a full stop is part of the sentence, not part of the URL.
const ADDRESS = /https?:\/\/[^\s"'<>]+/g
const TRAILING = /[.,;:!?)\]]+$/

// The address to open. A login prints more than one (the local server it
// started is the short one), and the one worth opening is the longest: an
// authorize URL carries the client, the redirect and the challenge.
export function addressToOpen(words) {
  const found = []
  for (const line of words ?? []) {
    if (typeof line !== 'string') continue
    for (const match of line.match(ADDRESS) ?? []) {
      const address = match.replace(TRAILING, '')
      if (address.includes('://')) found.push(address)
    }
  }
  if (!found.length) return null
  return found.reduce((longest, address) => (address.length > longest.length ? address : longest))
}

// What a person needs to know before the address: the harness's own aside about
// a machine with no desktop, which changes what they should do. Returned
// verbatim, because it is the CLI's sentence.
export function asideAbout(words) {
  for (const line of words ?? []) {
    if (typeof line !== 'string') continue
    if (/\b(headless|remote)\b/i.test(line)) return line.trim()
  }
  return null
}

// The address as a person reads it: the host it belongs to, because the rest
// is a query string no one can hold in their head.
export function addressLabel(address) {
  const text = String(address ?? '')
  const match = text.match(/^https?:\/\/([^/?#]+)/i)
  return match ? match[1] : text
}

// The whole reading: the address, the aside, and every line as it came.
export function readSignInWords(lines) {
  const words = Array.isArray(lines) ? lines.filter((line) => typeof line === 'string') : []
  return { address: addressToOpen(words), aside: asideAbout(words), words }
}
