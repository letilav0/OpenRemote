// How wide the browser pane is, and how wide it may be. The pane is a column beside the
// chat, so its width is a preference the console keeps: wide enough to read a page, never
// so wide that the chat beside it stops being a chat.
//
// Pure except for the two storage helpers, which are the same shape every other console
// preference uses (a localStorage key, a defensive read, and a write that answers whether
// it landed).

const KEY = 'openremote-browser-width'

/// The width a first-time pane opens at: wide enough for a page's own layout, and still
/// leaving two thirds of a laptop window to the chat.
export const DEFAULT_PANE_WIDTH = 560

/// The narrowest the pane may be dragged: below this a page's own layout starts folding
/// into its phone shape, which is not what a person widening a desktop pane wants.
export const MIN_PANE_WIDTH = 360

/// The most of the window the pane may take. The chat keeps the rest: a pane that can
/// fill the window is a window, and the chat beside it is the point.
export const MAX_PANE_SHARE = 0.7

/**
 * A pane width that fits the window. `available` is the window's inner width; the pane
 * never takes more than its share of it, and never less than the readable minimum, even
 * in a window too narrow for both.
 */
export function clampPaneWidth(px, available) {
  // `null` and `''` are "no width chosen", not zero: `Number(null)` is 0, and a 0 width
  // clamped to the minimum would open a pane nobody asked for at its narrowest.
  const raw = px == null || px === '' ? Number.NaN : Number(px)
  const width = Number.isFinite(raw) ? raw : DEFAULT_PANE_WIDTH
  const room = Number.isFinite(Number(available)) && Number(available) > 0 ? Number(available) : 0
  const most = room > 0 ? Math.max(MIN_PANE_WIDTH, Math.floor(room * MAX_PANE_SHARE)) : DEFAULT_PANE_WIDTH
  return Math.max(MIN_PANE_WIDTH, Math.min(most, Math.round(width)))
}

/// The width this computer last used, or the default. A value that cannot be read is the
/// default: a pane that fails to open is worse than one at the wrong width.
export function loadPaneWidth() {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw == null) return DEFAULT_PANE_WIDTH
    const value = Number(raw)
    return Number.isFinite(value) ? clampPaneWidth(value, typeof window === 'undefined' ? 0 : window.innerWidth) : DEFAULT_PANE_WIDTH
  } catch {
    return DEFAULT_PANE_WIDTH
  }
}

/// Keep a width for the next pane. False when storage refused, so a caller can say so if
/// it ever needs to (the pane itself has nothing to say: the width is cosmetic).
export function savePaneWidth(px) {
  try {
    localStorage.setItem(KEY, String(Math.round(px)))
    return true
  } catch {
    return false
  }
}
