// OpenRemote's page-side helper for agents. It runs in an isolated world
// of the page, so the page's own scripts can neither see it nor break it
// by changing built-ins, and it holds no privilege: it only reads and
// nudges the page, as the page's own scripts could.
//
// snapshot() reads the page the way assistive technology does - roles,
// names, states - as indented lines, and gives each element an agent can
// act on a ref (e1, e2, ...). Actions name elements by those refs. A ref
// stays with its element for as long as the page lives, so a second
// snapshot reuses the first one's refs.
(() => {
  if (globalThis.__openremote) return

  const refs = new Map()
  const ids = new WeakMap()
  let next = 1
  // The snapshot's budget in characters: past it, the rest is cut with a note.
  const BUDGET = 60000
  const OPTIONS_SHOWN = 25
  const ACCENT = '#dca24b'

  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title', 'base'])
  const INPUT_ROLES = {
    button: 'button', submit: 'button', reset: 'button', image: 'button', file: 'button', color: 'button',
    checkbox: 'checkbox', radio: 'radio', range: 'slider', search: 'searchbox', number: 'spinbutton',
  }
  // Roles whose name is their own text (a button says what it does).
  const NAMED_BY_CONTENT = new Set([
    'button', 'link', 'heading', 'cell', 'columnheader', 'rowheader', 'option', 'tab', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'treeitem', 'tooltip', 'switch', 'checkbox', 'radio', 'clickable',
  ])
  // Named by content only when they hold nothing actionable of their own;
  // a cell full of links shows the links instead.
  const CONTAINERS = new Set(['cell', 'columnheader', 'rowheader', 'treeitem', 'tab', 'menuitem', 'option', 'clickable'])
  // Roles that can be acted on, so they always get a ref.
  const ACTIONABLE = new Set([
    'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'checkbox', 'radio', 'slider',
    'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'clickable',
  ])

  function refOf(el) {
    let ref = ids.get(el)
    if (!ref) {
      ref = `e${next++}`
      ids.set(el, ref)
      refs.set(ref, new WeakRef(el))
    }
    return ref
  }

  function byRef(ref) {
    const el = refs.get(String(ref).replace(/^\[?ref=/, '').replace(/\]$/, ''))?.deref()
    if (!el || !el.isConnected) throw new Error(`${ref} is not on the page any more; take a new snapshot`)
    return el
  }

  const clean = (s, max = 160) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim()
    return t.length > max ? `${t.slice(0, max - 1)}…` : t
  }
  const quote = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

  function hidden(el) {
    if (el.getAttribute('aria-hidden') === 'true') return true
    if (el.localName === 'input' && el.type === 'hidden') return true
    if (typeof el.checkVisibility === 'function') {
      // An option inside a closed list reads as invisible; it isn't hidden.
      if (el.localName === 'option' || el.localName === 'optgroup') return false
      return !el.checkVisibility({ checkVisibilityCSS: true })
    }
    const style = el.ownerDocument.defaultView.getComputedStyle(el)
    return style.display === 'none' || style.visibility === 'hidden'
  }

  function insideSectioning(el) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (['article', 'aside', 'main', 'nav', 'section'].includes(p.localName)) return true
    }
    return false
  }

  function hasOwnName(el) {
    return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') || el.hasAttribute('title')
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role')
    if (explicit && explicit.trim()) {
      const role = explicit.trim().split(/\s+/)[0]
      return role === 'presentation' || role === 'none' ? null : role
    }
    switch (el.localName) {
      case 'a':
      case 'area':
        return el.hasAttribute('href') ? 'link' : null
      case 'button':
        return 'button'
      case 'input': {
        const type = (el.getAttribute('type') || 'text').toLowerCase()
        if (type === 'hidden') return null
        if (el.hasAttribute('list') && ['text', 'search', 'email', 'tel', 'url'].includes(type)) return 'combobox'
        return INPUT_ROLES[type] || 'textbox'
      }
      case 'textarea':
        return 'textbox'
      case 'select':
        return el.multiple || el.size > 1 ? 'listbox' : 'combobox'
      case 'option':
        return 'option'
      case 'img':
        return el.getAttribute('alt') === '' && !hasOwnName(el) ? null : 'img'
      case 'svg':
        return hasOwnName(el) || el.querySelector(':scope > title') ? 'img' : null
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        return 'heading'
      case 'nav':
        return 'navigation'
      case 'main':
        return 'main'
      case 'header':
        return insideSectioning(el) ? null : 'banner'
      case 'footer':
        return insideSectioning(el) ? null : 'contentinfo'
      case 'aside':
        return 'complementary'
      case 'form':
        return hasOwnName(el) ? 'form' : null
      case 'section':
        return hasOwnName(el) ? 'region' : null
      case 'article':
        return 'article'
      case 'ul': case 'ol': case 'menu':
        return 'list'
      case 'li':
        return 'listitem'
      case 'table':
        return 'table'
      case 'tr':
        return 'row'
      case 'th':
        return el.getAttribute('scope') === 'row' ? 'rowheader' : 'columnheader'
      case 'td':
        return 'cell'
      case 'dialog':
        return 'dialog'
      case 'summary':
        return 'button'
      case 'details': case 'fieldset':
        return 'group'
      case 'p':
        return 'paragraph'
      case 'blockquote':
        return 'blockquote'
      case 'pre':
        return 'code'
      case 'hr':
        return 'separator'
      case 'progress':
        return 'progressbar'
      case 'meter':
        return 'meter'
      case 'iframe': case 'frame':
        return 'iframe'
      case 'video':
        return 'video'
      case 'audio':
        return 'audio'
      case 'dt':
        return 'term'
      case 'dd':
        return 'definition'
      case 'label':
        return null
    }
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return 'textbox'
    // Pages built from plain boxes with click handlers: a box that shows a
    // pointer (and whose parent doesn't) is offered as clickable, or the
    // agent could never press it.
    if (el.hasAttribute('onclick') || el.tabIndex >= 0) return 'clickable'
    const view = el.ownerDocument.defaultView
    if (view.getComputedStyle(el).cursor === 'pointer') {
      const parent = el.parentElement
      if (!parent || view.getComputedStyle(parent).cursor !== 'pointer') return 'clickable'
    }
    return null
  }

  // An element's text as a person reads it: hidden parts left out,
  // pictures by their description, form fields by their value.
  function textOf(node, depth = 0) {
    if (depth > 30) return ''
    if (node.nodeType === Node.TEXT_NODE) return node.data
    if (node.nodeType !== Node.ELEMENT_NODE) return ''
    const el = node
    if (SKIP.has(el.localName) || hidden(el)) return ''
    if (el.localName === 'img') return el.getAttribute('alt') || ''
    // A field inside a label says its value; a box or button says nothing.
    if (el.localName === 'input') {
      return ['password', 'checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'hidden'].includes(el.type) ? '' : el.value || ''
    }
    if (el.localName === 'br') return ' '
    const label = el.getAttribute('aria-label')
    if (label && depth > 0) return label
    let out = ''
    const kids = el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes
    for (const kid of kids) {
      out += kid.nodeType === Node.ELEMENT_NODE && kid.localName === 'slot'
        ? ` ${[...kid.assignedNodes({ flatten: true })].map((n) => textOf(n, depth + 1)).join(' ')} `
        : kid.nodeType === Node.ELEMENT_NODE ? ` ${textOf(kid, depth + 1)} ` : textOf(kid, depth + 1)
      if (out.length > 400) break
    }
    return out
  }

  function nameOf(el, role, byContent = true) {
    const doc = el.ownerDocument
    const by = el.getAttribute('aria-labelledby')
    if (by) {
      const text = by.split(/\s+/).map((id) => doc.getElementById(id)).filter(Boolean).map((n) => textOf(n)).join(' ')
      if (clean(text)) return clean(text)
    }
    const label = el.getAttribute('aria-label')
    if (label && clean(label)) return clean(label)
    const tag = el.localName
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const type = (el.getAttribute('type') || '').toLowerCase()
      if (['button', 'submit', 'reset'].includes(type)) {
        return clean(el.value || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : ''))
      }
      if (type === 'image') return clean(el.alt || el.value || 'Submit')
      if (el.labels?.length) {
        const text = clean([...el.labels].map((l) => textOf(l)).join(' '))
        if (text) return text
      }
      if (el.title) return clean(el.title)
      if (el.placeholder) return clean(el.placeholder)
      return ''
    }
    if (tag === 'img' || tag === 'area') return clean(el.getAttribute('alt') || el.title || '')
    if (tag === 'svg') return clean(el.querySelector(':scope > title')?.textContent || '')
    if (tag === 'fieldset') return clean(el.querySelector(':scope > legend')?.textContent || '')
    if (tag === 'table') return clean(el.caption?.textContent || '')
    if (tag === 'iframe' || tag === 'frame') return clean(el.title || el.name || '')
    if (byContent && NAMED_BY_CONTENT.has(role)) {
      const text = clean(textOf(el))
      if (text) return text
    }
    return clean(el.title || '')
  }

  function states(el, role) {
    const out = []
    const aria = (name) => el.getAttribute(`aria-${name}`)
    if (role === 'heading') out.push(`level=${aria('level') || el.localName.slice(1) || 2}`)
    const checked = el.localName === 'input' && (el.type === 'checkbox' || el.type === 'radio')
      ? (el.indeterminate ? 'mixed' : el.checked)
      : aria('checked') === 'mixed' ? 'mixed' : aria('checked') === 'true'
    if (checked === 'mixed') out.push('checked=mixed')
    else if (checked) out.push('checked')
    if (el.disabled || aria('disabled') === 'true') out.push('disabled')
    if (aria('expanded') === 'true' || (el.localName === 'details' && el.open)) out.push('expanded')
    if (aria('pressed') === 'true') out.push('pressed')
    if (el.selected || aria('selected') === 'true') out.push('selected')
    if (el.required || aria('required') === 'true') out.push('required')
    if (el.readOnly && (role === 'textbox' || role === 'searchbox')) out.push('readonly')
    if (el.ownerDocument.activeElement === el && el !== el.ownerDocument.body) out.push('focused')
    if (role === 'link') {
      const href = el.getAttribute('href') || ''
      if (href && !href.startsWith('javascript:')) {
        let shown = href
        try {
          const url = new URL(href, el.baseURI)
          shown = url.origin === location.origin ? url.pathname + url.search + url.hash : url.href
        } catch {}
        out.push(`url=${clean(shown, 120)}`)
      }
    }
    return out
  }

  // What a field holds, for the end of its line. Passwords never show.
  function valueOf(el, role) {
    if (el.localName === 'input' && el.type === 'password') return el.value ? '••••••••' : ''
    if (el.localName === 'select') {
      return clean([...el.selectedOptions].map((o) => o.label || o.text).join(', '))
    }
    if (role === 'textbox' || role === 'searchbox' || role === 'combobox' || role === 'spinbutton' || role === 'slider') {
      if ('value' in el && typeof el.value === 'string') return clean(el.value, 300)
      if (el.isContentEditable) return clean(textOf(el), 300)
      const now = el.getAttribute('aria-valuetext') || el.getAttribute('aria-valuenow')
      return now ? clean(now) : ''
    }
    if (role === 'progressbar' || role === 'meter') {
      const v = el.getAttribute('aria-valuenow') ?? el.value
      return v != null ? String(v) : ''
    }
    return ''
  }

  function childrenOf(el) {
    if (el.localName === 'iframe' || el.localName === 'frame') {
      try {
        const doc = el.contentDocument
        return doc?.body ? [doc.body] : []
      } catch {
        return []
      }
    }
    const root = el.shadowRoot || el
    const out = []
    for (const kid of root.childNodes) {
      if (kid.nodeType === Node.ELEMENT_NODE && kid.localName === 'slot') {
        const assigned = kid.assignedNodes({ flatten: true })
        out.push(...(assigned.length ? assigned : kid.childNodes))
      } else out.push(kid)
    }
    return out
  }

  function snapshot() {
    const lines = []
    let size = 0
    let cut = false
    const emit = (depth, text) => {
      if (cut) return
      const line = `${'  '.repeat(depth)}- ${text}`
      size += line.length + 1
      if (size > BUDGET) {
        cut = true
        return
      }
      lines.push(line)
    }

    // Walks a node's children at `depth`, gathering loose text into lines.
    // Answers whether anything was emitted and the text alone when only
    // text was found (so a parent can put it on its own line).
    function walk(node, depth) {
      let text = ''
      const pending = []
      const flush = () => {
        const t = clean(text, 400)
        if (t) pending.push({ text: t })
        text = ''
      }
      for (const kid of childrenOf(node)) {
        if (cut) break
        if (kid.nodeType === Node.TEXT_NODE) {
          text += kid.data
          continue
        }
        if (kid.nodeType !== Node.ELEMENT_NODE) continue
        const el = kid
        if (SKIP.has(el.localName) || hidden(el)) continue
        if (el.localName === 'br') {
          text += ' '
          continue
        }
        // A caption or legend already named its table or group.
        if ((el.localName === 'caption' && node.localName === 'table') || (el.localName === 'legend' && node.localName === 'fieldset')) continue
        const role = roleOf(el)
        if (!role) {
          // A field's label already named the field: keep only what it holds.
          if (el.localName === 'label' && el.control) {
            flush()
            pending.push(...walk(el, depth).filter((i) => i.text == null))
            continue
          }
          // A plain box: its contents belong to the parent's level.
          const inner = collect(el, depth)
          if (inner.only != null) text += ` ${inner.only} `
          else {
            flush()
            pending.push(...inner.items)
          }
          continue
        }
        flush()
        pending.push({ el, role })
      }
      flush()
      return pending
    }

    // A plain box's contents, without emitting: either text only, or items.
    function collect(el, depth) {
      const items = walk(el, depth)
      if (items.every((i) => i.text != null)) return { only: items.map((i) => i.text).join(' '), items }
      return { only: null, items }
    }

    function render(items, depth) {
      for (const item of items) {
        if (cut) return
        if (item.text != null) {
          emit(depth, `text: ${item.text}`)
          continue
        }
        const { el, role } = item
        // A container role holding actionable things is named only by its
        // own label, and its contents speak for themselves.
        const inner0 = CONTAINERS.has(role) ? walk(el, depth + 1) : null
        const holds = inner0?.some((i) => i.text == null)
        // A focusable wrapper around a whole section is no button: its
        // contents are what can be pressed.
        if (role === 'clickable' && holds) {
          render(inner0, depth)
          continue
        }
        const name = nameOf(el, role, !holds)
        const actionable = ACTIONABLE.has(role) || role === 'iframe' || el.localName === 'summary'
        // A picture with no description says nothing an agent can use.
        if (role === 'img' && !name) continue
        const parts = [role]
        if (name) parts.push(quote(name))
        for (const s of states(el, role)) parts.push(`[${s}]`)
        if (actionable) parts.push(`[ref=${refOf(el)}]`)
        let head = parts.join(' ')
        const value = valueOf(el, role)
        if (el.localName === 'select') {
          emit(depth, value ? `${head}: ${value}` : head)
          const options = [...el.options]
          options.slice(0, OPTIONS_SHOWN).forEach((o) => {
            emit(depth + 1, `option ${quote(clean(o.label || o.text))}${o.selected ? ' [selected]' : ''}`)
          })
          if (options.length > OPTIONS_SHOWN) emit(depth + 1, `text: …${options.length - OPTIONS_SHOWN} more options`)
          continue
        }
        if (role === 'iframe' && !el.contentDocument) {
          emit(depth, `${head} (another site's frame: not readable from here)`)
          continue
        }
        if (value) {
          emit(depth, `${head}: ${value}`)
          continue
        }
        // Named by its own text: its text is already said.
        if (name && NAMED_BY_CONTENT.has(role)) {
          const inner = walk(el, depth + 1).filter((i) => i.text == null)
          emit(depth, head)
          render(inner, depth + 1)
          continue
        }
        const inner = inner0 || walk(el, depth + 1)
        // Spacers and empty boxes: nothing to say, nothing to press.
        if (!inner.length && !name && !actionable && parts.length === 1) continue
        if (inner.length && inner.every((i) => i.text != null)) {
          emit(depth, `${head}: ${clean(inner.map((i) => i.text).join(' '), 400)}`)
        } else {
          emit(depth, head)
          render(inner, depth + 1)
        }
      }
    }

    const body = document.body || document.documentElement
    render(walk(body, 0), 0)
    if (cut) lines.push(`- text: (the page goes on; scroll and take another snapshot, or look for text with wait)`)
    if (!lines.length) lines.push('- text: (the page shows nothing readable yet)')
    return lines.join('\n')
  }

  // Where to press an element: scrolled into view, its middle, in the
  // page's own pixels. Says what covers it, if something does.
  function point(ref) {
    const el = byRef(ref)
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    const box = el.getBoundingClientRect()
    if (box.width === 0 && box.height === 0) throw new Error(`${ref} takes no space on the page (hidden?)`)
    let x = box.left + box.width / 2
    let y = box.top + box.height / 2
    // An element inside a frame: add the frames' own places.
    let covered = null
    let win = el.ownerDocument.defaultView
    const local = { x, y }
    while (win && win.frameElement) {
      const frame = win.frameElement.getBoundingClientRect()
      x += frame.left
      y += frame.top
      win = win.parent
    }
    const hit = el.ownerDocument.elementFromPoint(local.x, local.y)
    const ours = hit && (hit === el || el.contains(hit) || hit.contains?.(el) || (el.labels && [...el.labels].includes(hit)))
    if (hit && !ours) covered = describe(hit)
    return { x, y, covered }
  }

  function describe(el) {
    const role = roleOf(el) || el.localName
    const name = nameOf(el, role)
    return name ? `${role} ${quote(name)}` : role
  }

  // Focus a field for typing; `clear` selects what it holds so typing
  // replaces it.
  function focusField(ref, clear) {
    const el = byRef(ref)
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    el.focus()
    if (clear) {
      if (typeof el.select === 'function' && 'value' in el) el.select()
      else if (el.isContentEditable) {
        const range = el.ownerDocument.createRange()
        range.selectNodeContents(el)
        const sel = el.ownerDocument.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)
      }
    }
    const editable = el.isContentEditable || ['input', 'textarea'].includes(el.localName)
    return { editable, focused: el.ownerDocument.activeElement === el }
  }

  // Set a field's value without real typing (engines with no trusted
  // input): the native setter, so frameworks that track values see it.
  function setValue(ref, text, clear) {
    const el = byRef(ref)
    el.focus()
    if ('value' in el && (el.localName === 'input' || el.localName === 'textarea')) {
      const proto = el.localName === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
      setter.call(el, clear ? text : el.value + text)
    } else if (el.isContentEditable) {
      if (clear) el.textContent = ''
      el.ownerDocument.execCommand('insertText', false, text)
    } else throw new Error(`${ref} is not a field you can type into`)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }

  function selectOptions(ref, values) {
    const el = byRef(ref)
    if (el.localName !== 'select') throw new Error(`${ref} is not a list of options`)
    const wanted = values.map((v) => String(v).trim().toLowerCase())
    const chosen = []
    for (const o of el.options) {
      const hit = wanted.includes(o.value.toLowerCase()) || wanted.includes(clean(o.label || o.text).toLowerCase())
      if (hit && (el.multiple || !chosen.length)) chosen.push(o)
      if (el.multiple) o.selected = hit
    }
    if (!chosen.length) throw new Error(`none of ${values.join(', ')} is an option of ${ref}`)
    if (!el.multiple) el.value = chosen[0].value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return chosen.map((o) => clean(o.label || o.text))
  }

  // Scroll an element (or the page) by a distance, for engines without
  // real wheel input.
  function scrollBy(ref, dx, dy) {
    const target = ref ? byRef(ref) : document.scrollingElement || document.documentElement
    target.scrollBy({ left: dx, top: dy, behavior: 'instant' })
    return { x: window.scrollX, y: window.scrollY }
  }

  function click(ref) {
    const el = byRef(ref)
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    el.click()
    return true
  }

  // A brief outline around the element an agent just acted on, so the
  // person watching sees where. Drawn in a closed shadow root, so the
  // page's styles can't touch it and its scripts can't find it.
  let host = null
  function outline(ref) {
    let el
    try {
      el = byRef(ref)
    } catch {
      return false
    }
    const box = el.getBoundingClientRect()
    if (!host || !host.isConnected) {
      host = document.createElement('openremote-mark')
      host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647'
      host._root = host.attachShadow({ mode: 'closed' })
      document.documentElement.appendChild(host)
    }
    const mark = document.createElement('div')
    mark.style.cssText = `position:fixed;left:${box.left - 3}px;top:${box.top - 3}px;width:${box.width + 6}px;height:${box.height + 6}px;border:2px solid ${ACCENT};border-radius:6px;box-sizing:border-box;pointer-events:none;transition:opacity .3s ease`
    host._root.appendChild(mark)
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    setTimeout(() => {
      mark.style.opacity = '0'
      setTimeout(() => mark.remove(), reduce ? 0 : 320)
    }, 900)
    return true
  }

  function element(ref) {
    return byRef(ref)
  }

  function rect(ref) {
    const el = byRef(ref)
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    const box = el.getBoundingClientRect()
    return { x: box.left + window.scrollX, y: box.top + window.scrollY, width: box.width, height: box.height }
  }

  function text() {
    return document.body ? document.body.innerText : ''
  }

  function page() {
    const doc = document.scrollingElement || document.documentElement
    return {
      url: location.href,
      title: document.title,
      width: Math.max(doc.scrollWidth, window.innerWidth),
      height: Math.max(doc.scrollHeight, window.innerHeight),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scroll: { x: window.scrollX, y: window.scrollY },
      dpr: window.devicePixelRatio || 1,
    }
  }

  // The file picker behind an element: the element itself when it is one,
  // else the one a styled upload button stands in for (often hidden).
  function fileInput(ref) {
    const el = byRef(ref)
    if (el.localName === 'input' && el.type === 'file') return el
    const inside = el.querySelector?.('input[type=file]')
    if (inside) return inside
    if (el.localName === 'label' && el.control?.type === 'file') return el.control
    for (let p = el.parentElement, n = 0; p && n < 4; p = p.parentElement, n++) {
      const near = p.querySelector('input[type=file]')
      if (near) return near
    }
    return null
  }

  // A short CSS path to an element, for the agent to name it by.
  function selectorOf(el) {
    const parts = []
    for (let node = el; node && node.nodeType === Node.ELEMENT_NODE && parts.length < 5; node = node.parentElement) {
      if (node.id && node.ownerDocument.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(node.id)}`)
        break
      }
      let part = node.localName
      const classes = [...node.classList].filter((c) => !/\d{3,}|^css-|^_/.test(c)).slice(0, 2)
      if (classes.length) part += classes.map((c) => `.${CSS.escape(c)}`).join('')
      const parent = node.parentElement
      if (parent) {
        const same = [...parent.children].filter((c) => c.localName === node.localName)
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`
      }
      parts.unshift(part)
    }
    return parts.join(' > ')
  }

  // What a picked element is, for a chat: the agent gets this as text.
  function describeFully(el) {
    const role = roleOf(el) || el.localName
    const box = el.getBoundingClientRect()
    const html = el.outerHTML || ''
    return {
      role,
      name: nameOf(el, role),
      tag: el.localName,
      text: clean(el.innerText || el.textContent || '', 600),
      selector: selectorOf(el),
      html: html.length > 1500 ? `${html.slice(0, 1499)}…` : html,
      rect: { x: box.left + window.scrollX, y: box.top + window.scrollY, width: box.width, height: box.height },
      url: location.href,
      title: document.title,
    }
  }

  // The element picker: the element under the pointer is outlined, a click
  // picks it (the page never sees that click), Esc gives up. The choice
  // goes out through the binding the browser added to this world.
  let picking = null
  function pick(on) {
    if (picking) {
      picking.stop()
      picking = null
    }
    if (!on) return true
    const box = document.createElement('div')
    box.style.cssText = `position:fixed;pointer-events:none;border:2px solid ${ACCENT};border-radius:4px;box-sizing:border-box;display:none`
    const label = document.createElement('div')
    label.style.cssText = `position:fixed;pointer-events:none;padding:2px 6px;border-radius:4px;background:${ACCENT};color:#0a0c0f;font:12px system-ui,sans-serif;display:none;max-width:320px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis`
    if (!host || !host.isConnected) {
      host = document.createElement('openremote-mark')
      host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647'
      host._root = host.attachShadow({ mode: 'closed' })
      document.documentElement.appendChild(host)
    }
    host._root.append(box, label)
    let current = null
    const send = (payload) => {
      try {
        globalThis.__openremotePick(JSON.stringify(payload))
      } catch {}
    }
    const move = (e) => {
      const el = e.composedPath?.()[0] instanceof Element ? e.composedPath()[0] : e.target
      if (!(el instanceof Element) || el === current) return
      current = el
      const r = el.getBoundingClientRect()
      box.style.display = label.style.display = 'block'
      Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
      label.textContent = describe(el)
      Object.assign(label.style, { left: `${Math.max(0, r.left)}px`, top: `${Math.max(0, r.top - 22)}px` })
    }
    const swallow = (e) => {
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
    }
    const choose = (e) => {
      swallow(e)
      const el = current || e.target
      pick(false)
      if (el instanceof Element) send(describeFully(el))
    }
    const key = (e) => {
      if (e.key !== 'Escape') return
      swallow(e)
      pick(false)
      send({ cancel: true })
    }
    const opts = { capture: true }
    window.addEventListener('pointermove', move, opts)
    for (const type of ['pointerdown', 'mousedown', 'mouseup']) window.addEventListener(type, swallow, opts)
    window.addEventListener('click', choose, opts)
    window.addEventListener('keydown', key, opts)
    picking = {
      stop() {
        window.removeEventListener('pointermove', move, opts)
        for (const type of ['pointerdown', 'mousedown', 'mouseup']) window.removeEventListener(type, swallow, opts)
        window.removeEventListener('click', choose, opts)
        window.removeEventListener('keydown', key, opts)
        box.remove()
        label.remove()
      },
    }
    return true
  }

  Object.defineProperty(globalThis, '__openremote', {
    value: Object.freeze({
      snapshot, point, focusField, setValue, selectOptions, scrollBy, click, outline, element, rect, text, page, fileInput, pick,
    }),
  })
})()
