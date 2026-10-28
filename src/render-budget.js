// Render-cost caps for the transcript rail: the fixed bounds that keep a
// big turn displayable. Pure; the view only reads them, tests pin them.
//
// The daemon caps what it lists the same way - a folder listing stops at
// 2000 entries with a truncated flag, and the console answers with a
// "showing the first" note (FolderPickerModal). These notes mirror that
// wording so every truncation in the app reads the same.

/// How often a live body (a token stream) may re-parse its growing text.
/// The token beat is far faster than the eye can read, so 100ms is live
/// enough - and it caps both the parse and the innerHTML rewrite of the
/// growing reply at ~10 a second, where before each token paid both.
export const LIVE_RENDER_MS = 100

/// The most diff rows one tool card renders. A row is a DOM pair (old
/// left, new right), so an uncapped 3000-line write was ~6000 nodes on
/// its own; 500 rows keeps every card bounded and still readable.
export const MAX_RENDER_ROWS = 500

/// The most lines one tool output shows once the reader opens it. The
/// full text stays in the transcript (the daemon's own record); the
/// card shows the head.
export const MAX_RENDER_LINES = 500

/// A tool body past either bound is a wall of text. The card hides it
/// and shows a size mark instead. Short results (a command's few lines)
/// stay inline.
export const PREVIEW_LINES = 8
export const PREVIEW_CHARS = 600

/// Whether a live body may render now: at least LIVE_RENDER_MS since the
/// last accepted render. 0 means "never rendered" - the first beat always
/// passes.
export function shouldRenderLive(lastRenderedAt, now = Date.now()) {
  return now - lastRenderedAt >= LIVE_RENDER_MS
}

/// The rows a diff card shows and how many were held back - the first
/// slice, never the whole walk.
export function capRows(rows) {
  if (rows.length <= MAX_RENDER_ROWS) return { rows, hidden: 0 }
  return { rows: rows.slice(0, MAX_RENDER_ROWS), hidden: rows.length - MAX_RENDER_ROWS }
}

/// The lines a tool output shows and how many were held back.
export function capLines(text) {
  const src = String(text ?? '')
  const lines = src.split('\n')
  if (lines.length <= MAX_RENDER_LINES) return { text: src, hidden: 0 }
  return { text: lines.slice(0, MAX_RENDER_LINES).join('\n'), hidden: lines.length - MAX_RENDER_LINES }
}

/// Whether a tool body should stay folded, plus the words for its size
/// mark. A single long line counts: line caps miss a page with no breaks.
export function bodyPreview(text) {
  const src = String(text ?? '')
  const lines = src === '' ? 0 : src.split('\n').length
  const capped = capLines(src)
  return {
    large: lines > PREVIEW_LINES || src.length > PREVIEW_CHARS,
    chars: src.length,
    lines,
    text: capped.text,
    hidden: capped.hidden,
    size: formatBodySize(src.length, lines),
    fill: meterFill(src.length),
  }
}

function formatBodySize(chars, lines) {
  if (chars >= 1024) {
    const kb = chars / 1024
    return kb >= 10 ? `${Math.round(kb)} KB` : `${kb.toFixed(1)} KB`
  }
  // One long line still wraps into a wall. Count it in characters.
  if (chars > PREVIEW_CHARS) return `${chars} chars`
  if (lines <= 1) return '1 line'
  return `${lines} lines`
}

/// Log scale from the preview bound up to a long page, so a skill file
/// and a short note do not paint the same bar.
function meterFill(chars) {
  const span = Math.log(80_000) - Math.log(PREVIEW_CHARS)
  const t = (Math.log(Math.max(chars, PREVIEW_CHARS)) - Math.log(PREVIEW_CHARS)) / span
  return `${Math.round(Math.min(1, Math.max(0.16, t)) * 100)}%`
}
