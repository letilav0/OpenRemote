// The browser as a right side-pane: the same BrowserView the app used to
// show whole-window, docked beside the chat. The tabs live in the browser
// store, so closing the pane hides the pages instead of closing them -
// reopening shows them where they were.

import { Suspense, lazy } from 'react'

// Loaded on first opening: the browser costs nothing until it is shown.
const BrowserView = lazy(() => import('./BrowserView.jsx'))

export default function BrowserPane({ onClose, askToShow = null, width = null }) {
  return (
    <aside className="bw-pane" aria-label="Browser" style={width ? { flexBasis: `${width}px` } : undefined}>
      <Suspense fallback={null}>
        <BrowserView onClosePane={onClose} askToShow={askToShow} />
      </Suspense>
    </aside>
  )
}
