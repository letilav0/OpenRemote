// The star's small editor: the bookmark's name and folder, Remove, Done.
// Enter, Escape, the backdrop and the X all keep the bookmark as edited,
// because the star saved it before this opened; only Remove takes it away.
// It is the console's dialog family, not a floating pop.

import { useEffect, useRef, useState } from 'react'
import { X } from '@phosphor-icons/react'
import { FOLDERS } from './browser-bookmarks.js'
import { useDialog } from './dialog-focus.js'
import { useBack } from './use-back.js'
import './devices.css'
import './panels.css'

export default function BrowserBookmarkEditor({ mark, fresh, onDone, onRemove }) {
  const panelRef = useRef(null)
  const inputRef = useRef(null)
  const [title, setTitle] = useState(mark.title ?? '')
  const [folder, setFolder] = useState(mark.folder === 'other' ? 'other' : 'bar')
  const latest = useRef(null)
  latest.current = () => onDone({ title: title.trim() || mark.title || mark.url, folder })

  // The dialog hooks take Escape and the focus trap; both paths keep the
  // edit, so Esc here means "done", which is what the star's flow promises.
  useDialog(panelRef, () => latest.current())
  useBack(true, () => latest.current())

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [])

  return (
    <div
      className="dv-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) latest.current()
      }}
    >
      <div
        className="dv-modal dv-modal--form"
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={fresh ? 'Bookmark added' : 'Edit bookmark'}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.target === inputRef.current) {
            e.preventDefault()
            latest.current()
          }
        }}
      >
        <div className="dv-modal-head">
          <span className="dv-modal-title">{fresh ? 'Bookmark added' : 'Edit bookmark'}</span>
          <button type="button" className="dv-modal-close" aria-label="Done" onClick={() => latest.current()}>
            <X size={14} />
          </button>
        </div>
        <label className="bw-field">
          <span>Name</span>
          <input
            ref={inputRef}
            className="bw-field-input"
            value={title}
            spellCheck={false}
            placeholder={mark.title || mark.url}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <div className="bw-field">
          <span>Folder</span>
          <div className="bw-seg" role="radiogroup" aria-label="Folder">
            {Object.entries(FOLDERS).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={folder === id}
                className={folder === id ? 'on' : ''}
                onClick={() => setFolder(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="ctx-modal-actions">
          {/* Removing is its own press: the safe answer (Done) is the primary. */}
          <button type="button" className="pn-btn" onClick={onRemove}>
            Remove
          </button>
          <button type="button" className="pn-btn bw-primary" onClick={() => latest.current()}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
