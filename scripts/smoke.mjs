// A smoke check of the running console's real DOM.
//
// Every other gate in this repo reads source text or builds it: both would
// pass on a window that renders nothing. This attaches to the dev app's
// WebView2 over the DevTools port (9333, debug builds only) and asserts the
// few things a person actually sees on first contact: the sidebar and its
// New chat tile, no crash panel, the command palette opening with its search
// field focused and its rows listed, Escape closing it and handing focus
// back, and a modal opened from the UI keeping its first field and its focus.
// Past the view walk it drives the six interactions below, ending with the two
// search fields a person types into (the sidebar's chats and Settings'), which
// read only and write nothing.
//
// Usage: node scripts/smoke.mjs
// Needs the dev app running in another terminal: npm run tauri:dev
// Exit 0 when every check passes, 1 when one fails (each line says which).
//
// It talks to the page the way a person does: real key and mouse events over
// the protocol, not synthetic DOM events, because the console's shortcuts and
// focus rules read trusted input. Nothing is installed as a dependency:
// WebSocket, fetch, and the fs/os/path calls that write the temp plugin folder
// come from Node itself, the same as cdp-eval.mjs. The two things a run writes
// (a rule through the rule form, a plugin folder under the temp dir) are
// removed again before it ends.
//
// The checks past the view walk press things, and each says what it proves
// and what it does not:
// - a chat row's menu: proves right-click opens it, that its one mark item
//   ("Mark as read" or "Mark as unread", whichever the row's state calls for)
//   sits after Open and before Rename and closes the menu when pressed, and
//   that Escape closes the menu and hands focus back to the row; not that the
//   other rows in it do their jobs. Pressing the mark item writes the
//   sidebar's own seen map for that chat, which can clear its unread mark.
// - the pane menu in a split: proves a split can be made from the menu and
//   that its rows and Escape behave; not that a split row's effect is what it
//   says (the Layouts menu is the palette's page, not a pane-header control).
// - the palette's Rules group: proves it is offered only while Automations is
//   mounted, and that a rule made through the form reaches the palette and can
//   be removed again; not that running one does what it says. The check seeds
//   its own rule, because the dev profile never holds one: the name and task
//   are typed into the form, the project, harness and machine come from the
//   form's own pickers, and the rule is deleted at the end. When the profile
//   has no project or no installed harness to make one with, the form refuses
//   Save and the check skips, naming the piece that is missing.
// - an armed plugin row: proves Remove arms on the first press, that Escape
//   takes the arm back, and that the plugin is still listed afterwards; it then
//   removes the plugin for real, which proves the second press acts. The dev
//   profile never holds a plugin, so the check makes one: it writes a folder
//   with a .claude-plugin/plugin.json under the temp dir, installs it through
//   Plugins > Install a plugin > Folder by typing the path, and approves the
//   review. A profile that already holds a plugin uses the first one and
//   removes nothing. The temp folder is deleted on every path, and a run that
//   could not finish still tries both cleanups and says what it left behind.
// - the palette's New chat with this setup: proves Ctrl+K offers exactly one
//   such row for the chat on screen, that its sub line is that chat's title,
//   and that pressing it lands on New chat with the same harness chosen in the
//   picker; not that the model, effort, approval word or project it seeds are
//   right (src/chat-setup.test.js covers the rule), and not that a New chat
//   started from it runs. It writes nothing: the only thing it changes is that
//   the chat it opens is no longer marked unread. It skips when the profile
//   has no chats, when the chat carries no readable harness in its pane, or
//   when the row is not offered at all.
// - the sidebar's search: proves a word taken from a title the list is showing
//   narrows the list to the rows that carry it, and that Escape gives the whole
//   list back with the field empty; not that a query finds a chat by anything
//   but its title (the sidebar's filter is title-only), and not that a matching
//   row opens. The Needs you group ignores the query on purpose, so those rows
//   are read as an exception rather than a stray.
// - the settings search: proves a word a person uses for a setting reaches a
//   row whose label does not contain it (the model-endpoint block answers
//   "gateway" from its terms, src/settings-search.js), and that Escape clears
//   the field and brings the sections back; not that pressing a result lands on
//   its row. The search reads the index the app ships, so a missing term fails
//   this line rather than skipping it.
//
// The two searches come last because they change nothing at all: a run that
// leaves a field or a window open would falsify the next check rather than
// this one.
//
// WHAT IT DOES NOT COVER: no chat is created and no message is typed into one,
// so the stream and the transcript are never read. The two writes to the
// profile are the rule the palette check seeds and deletes, and the plugin this
// check installs and removes. Two checks also touch the chat list's own read
// marks and do not put them back: the palette's setup check opens a chat, which
// clears that chat's unread mark, and the menu check presses Mark as read or
// Mark as unread, which writes that one chat's mark in the direction the row
// was drawn, so a run may leave that mark changed. The two searches write
// nothing. No settings are changed and no
// layout is saved or applied. A green run says every view opens, draws, keeps
// the boundary panel away and that the seven interactions above behave; it does
// not say the app works.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port = process.env.OPENREMOTE_CDP_PORT ?? '9333'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []

function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`)
  if (detail) console.log(`      ${detail}`)
}

// The dev watcher restarts the app on every shell save, so the port can be
// down for a few seconds while this starts. Wait for it rather than failing
// on a rebuild that is not the console's problem.
async function targets() {
  const until = Date.now() + 60_000
  while (Date.now() < until) {
    try {
      const answer = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
      if (Array.isArray(answer) && answer.length > 0) return answer
    } catch {
      /* the app is rebuilding: try again */
    }
    await sleep(1000)
  }
  return null
}

const pagesAll = await targets()
if (!pagesAll) {
  console.error(`no page on the DevTools port ${port} in 60 s - is the dev app running (npm run tauri:dev)?`)
  process.exit(1)
}
const pages = pagesAll.filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'))
const page =
  pages.find((t) => /^(https?:\/\/127\.0\.0\.1:5175|tauri:\/\/localhost)/.test(String(t.url))) ??
  pages[0]
if (!page) {
  console.error(`no page on the DevTools port ${port} - is the dev app running?`)
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', () => reject(new Error(`the DevTools connection to ${page.url} failed`)), {
    once: true,
  })
})

let nextId = 1
const waiting = new Map()
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  const settle = waiting.get(message.id)
  if (!settle) return
  waiting.delete(message.id)
  settle(message)
})

function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve) => {
    waiting.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

// Evaluate in the page and answer the value. A thrown error or a rejected
// promise is a failed check, never a silent undefined.
async function evaluate(expression) {
  const message = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  const failure = message.result?.exceptionDetails
  if (failure) {
    throw new Error(failure.exception?.description ?? failure.text ?? 'the page threw')
  }
  return message.result?.result?.value
}

// How a person types: trusted key events, with the modifiers the page reads.
// `text` is what a printable key inserts - without it the page sees the
// keydown (enough for a shortcut) but no character reaches the field.
async function key({ key: name, code, vk, modifiers = 0, text }) {
  const base = { key: name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
  await send('Input.dispatchKeyEvent', { ...base, type: 'keyDown', ...(text ? { text } : {}) })
  await send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
}

async function click(x, y, button = 'left') {
  const base = { x, y, button, buttons: button === 'left' ? 1 : 2, clickCount: 1 }
  await send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' })
  await send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' })
}

async function waitFor(expression, { timeout = 8000, step = 120 } = {}) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (await evaluate(expression)) return true
    await sleep(step)
  }
  return false
}

// The dev app starts on the wizard when its own profile has never been set
// up. The smoke needs the shell, not the tour: seed the one key the shell
// reads (App.jsx, OB_KEY) and reload. This is a dev profile only.
await evaluate(`(() => {
  if (document.querySelector('.sidebar')) return 'shell';
  if (localStorage.getItem('openremote-onboarded') === '1') return 'reload';
  localStorage.setItem('openremote-onboarded', '1');
  location.reload();
  return 'seeded';
})()`)
await sleep(500)
let shellUp = await waitFor("!!document.querySelector('.sidebar')", { timeout: 20000 })
if (!shellUp) {
  await evaluate('location.reload()')
  shellUp = await waitFor("!!document.querySelector('.sidebar')", { timeout: 20000 })
}
record(
  'the dev window reaches the shell',
  shellUp,
  shellUp
    ? `hash ${await evaluate('location.hash') || '(none)'}, ${await evaluate('document.querySelectorAll(".chat-row").length')} chat rows in the sidebar`
    : `body said: ${String(await evaluate('document.body.innerText')).slice(0, 160)}`,
)
if (!shellUp) {
  console.log('\n0 of 5 checks ran: the shell never came up')
  ws.close()
  process.exit(1)
}

// A window somebody left open is not a defect in this build, and it made the
// palette check fail once with a sentence about focus that read like a
// regression: a manual session had left the Settings popup up, so Ctrl+K opened
// over it and the opener was never recorded. Clear any overlay first and say what
// was cleared, so every check below starts from the same place.
const overlayOpen = await evaluate(`(() => {
  const open = ['.kb-palette', '.vp-window', '.dv-modal', '.pn-menu'].find((s) => document.querySelector(s));
  return open ?? null;
})()`)
if (overlayOpen) {
  for (let i = 0; i < 3 && (await evaluate(`!!document.querySelector(${JSON.stringify(overlayOpen)})`)); i += 1) {
    await key({ key: 'Escape', code: 'Escape', vk: 27 })
    await sleep(250)
  }
  const stillOpen = await evaluate(`!!document.querySelector(${JSON.stringify(overlayOpen)})`)
  console.log(
    stillOpen
      ? `NOTE  ${overlayOpen} was open when this started and would not close; a check below may read it as a failure`
      : `NOTE  ${overlayOpen} was open when this started: closed before the first check`,
  )
}

// The pane count is the other piece of a manual session's state that a check reads
// as a defect: the split check needs a single pane to start from, and a two-pane
// window left behind made it report "the window is not a single pane" as if this
// build had done it. Say what was found, so that failure explains itself.
const paneCountAtStart = await evaluate(`document.querySelectorAll('[data-leaf-id]').length`)
if (paneCountAtStart > 1) {
  console.log(
    `NOTE  ${paneCountAtStart} panes were open when this started; the split check needs one and may report the extra as a failure`,
  )
}

// Start from a known place. The app remembers the last view and a previous run
// may have left a popup over it, so a click measured against whatever was on
// screen would be a check on a different window than the one it names.
await evaluate(`(() => {
  const b = [...document.querySelectorAll('.sidebar button')].find((x) => (x.textContent || '').trim() === 'New chat');
  b?.click();
  return 'reset';
})()`)
await waitFor("location.hash === '#new'", { timeout: 5000 })
await sleep(300)

// 1. The sidebar, and the New chat tile on it.
const newChat = await evaluate(`(() => {
  const sb = document.querySelector('.sidebar');
  if (!sb) return null;
  const tile = [...sb.querySelectorAll('button')].find((b) => b.textContent.trim() === 'New chat');
  if (!tile) return null;
  const r = tile.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: tile.textContent.trim(), sbClass: sb.className };
})()`)
record(
  'the sidebar exists and lists the New chat tile',
  Boolean(newChat),
  newChat ? `sidebar "className=${newChat.sbClass}", tile reads "${newChat.text}"` : 'no button reading New chat under .sidebar',
)

// Focus the tile the way a person would, so the palette has somewhere to
// return to after Escape (check 4).
if (newChat) await click(newChat.x, newChat.y)
const opener = await evaluate(`(() => {
  const a = document.activeElement;
  if (!a || a === document.body) return null;
  window.__smokeOpener = a;
  return a.textContent ? a.textContent.trim().slice(0, 40) : a.getAttribute('aria-label') || a.tagName;
})()`)

// 2. No crash panel over the window.
const boundary = await evaluate(`(() => {
  const panel = document.querySelector('.vb');
  return {
    panel: Boolean(panel),
    text: String(document.body.innerText).includes('This view could not be drawn'),
    panels: document.querySelectorAll('.vb').length,
  };
})()`)
record(
  'the view boundary panel is not on screen',
  !boundary.panel && !boundary.text,
  `${boundary.panels} .vb panel(s), the crash sentence ${boundary.text ? 'IS' : 'is not'} in the window text`,
)

// 3. The command palette: Ctrl+K, its search field focused, its rows listed.
// At rest the palette offers its suggestions (four rows on this tree) plus
// whatever Recent holds; the populated list is the searched one, so the row
// count is read after a letter, the way a person finds a chat.
await key({ key: 'k', code: 'KeyK', vk: 75, modifiers: 2 })
const paletteOpen = await waitFor("!!document.querySelector('.kb-palette')")
const atRest = paletteOpen
  ? await evaluate(`(() => {
      const input = document.querySelector('.kb-search input');
      const rows = document.querySelectorAll('.kb-item');
      return {
        rows: rows.length,
        searchFocused: document.activeElement === input,
        activeTag: document.activeElement ? document.activeElement.tagName : '(none)',
        firstRow: rows[0] ? rows[0].textContent.trim().slice(0, 60) : null,
      };
    })()`)
  : null
let searched = null
if (atRest?.searchFocused) {
  await key({ key: 'e', code: 'KeyE', vk: 69, text: 'e' })
  await sleep(250)
  searched = await evaluate(`(() => {
    const rows = document.querySelectorAll('.kb-item');
    const labels = [...document.querySelectorAll('.kb-section-label, .kb-list label, .nc-group-label')].map((l) => l.textContent.trim());
    return {
      rows: rows.length,
      query: document.querySelector('.kb-search input')?.value ?? '',
      first: rows[0] ? rows[0].textContent.trim().slice(0, 60) : null,
      labels: labels.slice(0, 6),
    };
  })()`)
}
record(
  'Ctrl+K opens the palette with its search field focused and its rows listed',
  Boolean(atRest?.searchFocused) && (searched?.rows ?? 0) >= 6,
  atRest
    ? `${atRest.rows} row(s) at rest (first "${atRest.firstRow}"), focus on ${atRest.activeTag}; ` +
      `after typing "${searched?.query ?? ''}": ${searched?.rows ?? 0} row(s), first "${searched?.first ?? ''}"`
    : 'the palette never appeared',
)

// 4. Escape closes it, and focus is back on what opened it.
await key({ key: 'Escape', code: 'Escape', vk: 27 })
const paletteClosed = await waitFor("!document.querySelector('.kb-palette')")
const focusBack = paletteClosed
  ? await evaluate(`(() => {
      const a = document.activeElement;
      return {
        same: Boolean(window.__smokeOpener) && a === window.__smokeOpener,
        on: a ? (a.textContent || '').trim().slice(0, 40) || a.tagName : '(body)',
        body: a === document.body,
      };
    })()`)
  : null
record(
  'Escape closes the palette and focus returns to where it was',
  Boolean(paletteClosed) && Boolean(focusBack?.same),
  paletteClosed
    ? `focus is on "${focusBack.on}"${focusBack.body ? ' (the body)' : ''}, opener was ${opener ? `"${opener}"` : '(none recorded)'}`
    : 'the palette stayed open',
)

// 5. A modal opened from the UI: right-click a chat row, choose Rename, and
// check its first field has focus and Tab stays inside it.
const row = await evaluate(`(() => {
  const r = document.querySelector('.chat-row');
  if (!r) return null;
  const b = r.getBoundingClientRect();
  return { x: b.x + Math.min(40, b.width / 2), y: b.y + b.height / 2, text: r.textContent.trim().slice(0, 40) };
})()`)
let renameModal = null
let tabStayed = null
if (row) {
  await click(row.x, row.y, 'right')
  const menuOpen = await waitFor("!!document.querySelector('.ctx-menu')")
  if (menuOpen) {
    const item = await evaluate(`(() => {
      const items = [...document.querySelectorAll('.ctx-menu .nc-item')];
      const rename = items.find((i) => /rename/i.test(i.textContent));
      if (!rename) return { found: false, labels: items.map((i) => i.textContent.trim()).slice(0, 8) };
      const b = rename.getBoundingClientRect();
      return { found: true, x: b.x + b.width / 2, y: b.y + b.height / 2, label: rename.textContent.trim() };
    })()`)
    if (item.found) {
      await click(item.x, item.y)
      const modalOpen = await waitFor("!!document.querySelector('.dv-modal')")
      if (modalOpen) {
        renameModal = await evaluate(`(() => {
          const modal = document.querySelector('.dv-modal');
          const input = modal.querySelector('.rn-input');
          const focused = document.activeElement;
          return {
            title: (modal.querySelector('.dv-modal-title')?.textContent ?? '').trim(),
            inputFocused: Boolean(input) && focused === input,
            activeTag: focused ? focused.tagName : '(none)',
            activeClass: focused ? focused.className : '',
          };
        })()`)
        // Tab four times: focus must not leave the panel.
        const inside = []
        for (let i = 0; i < 4; i += 1) {
          await key({ key: 'Tab', code: 'Tab', vk: 9 })
          inside.push(
            await evaluate(`(() => {
              const modal = document.querySelector('.dv-modal');
              return Boolean(modal) && modal.contains(document.activeElement);
            })()`),
          )
        }
        tabStayed = inside.every(Boolean)
        await key({ key: 'Escape', code: 'Escape', vk: 27 })
        await waitFor("!document.querySelector('.dv-modal')")
      }
    }
  }
}
record(
  'a modal opened from the UI keeps its first field and its focus',
  Boolean(renameModal?.inputFocused) && tabStayed === true,
  renameModal
    ? `"${renameModal.title}" focused ${renameModal.activeTag}.${renameModal.activeClass}; Tab stayed inside: ${tabStayed}`
    : row
      ? 'the chat row menu or the Rename dialog did not open'
      : 'no .chat-row in the sidebar to rename',
)

// Every view, opened by the app's own route.
//
// A view that cannot render is invisible to every other gate: the tests pass
// because a call site with no import is still valid text, and the build is
// happy because the identifier is only unresolved at runtime. The boundary
// panel catches it in the window, and this walks into every view to make sure
// the panel never appears: no crash panel, a heading or a first control, and
// the pane's own words rather than the boundary's. The route is checked too,
// because a view that was never opened would otherwise pass on the previous
// view's pane - a green line over a visit that did not happen.
//
// Three kinds of destination: routed views (the shell writes the hash), popup
// views (settings, metrics and mobile open over the app, so the hash stays put
// and the check looks inside the popup), and machines, which is Cloud's and is
// visited from Cloud mode.
const paneState = (selector) =>
  evaluate(`(() => {
    const area = document.querySelector('${selector}');
    if (!area) return { why: 'no ${selector}' };
    const vb = area.querySelector('.vb');
    const boundary = vb ? (vb.querySelector('.vb-detail-msg')?.textContent ?? 'the crash panel, with no message') : null;
    const headings = [...area.querySelectorAll('h1, .dv-title, [role="heading"]')]
      .map((h) => (h.textContent || '').trim())
      .filter(Boolean);
    const controls = [...area.querySelectorAll('button, input, textarea, select, [tabindex]')]
      .filter((el) => !(vb && vb.contains(el)) && el.getClientRects().length > 0);
    const text = (area.innerText || '').replace(/\\s+/g, ' ').trim();
    return {
      hash: location.hash,
      boundary,
      heading: headings[0] ?? null,
      controls: controls.length,
      text: text.slice(0, 140),
      crash: text.includes('This view could not be drawn'),
    };
  })()`)

const drewOk = (state) =>
  !state?.why && !state.boundary && !state.crash && (Boolean(state.heading) || state.controls > 0)

const skips = []
const skip = (name, reason) => {
  skips.push({ name, reason })
  console.log(`SKIP  view "${name}" - ${reason}`)
}

const clickSidebar = (match) =>
  evaluate(`(() => {
    const b = [...document.querySelectorAll('.sidebar button')].find((x) => ${match});
    if (!b) return false;
    b.click();
    return true;
  })()`)

const ROUTED = [
  { name: 'new chat', match: `(x.textContent || '').trim() === 'New chat'`, hash: '#new' },
  { name: 'plugins', match: `(x.textContent || '').trim() === 'Plugins'`, hash: '#plugins' },
  { name: 'automations', match: `(x.textContent || '').trim() === 'Automations'`, hash: '#automations' },
  { name: 'account', match: `(x.getAttribute('aria-label') || '').trim() === 'Account'`, hash: '#account' },
]
for (const view of ROUTED) {
  if (!(await clickSidebar(view.match))) {
    record(`view "${view.name}" draws with no boundary panel`, false, 'the sidebar has no control for it')
    continue
  }
  const reached = await waitFor(`location.hash === '${view.hash}'`, { timeout: 5000 })
  await sleep(300)
  const state = await paneState('.split-body')
  record(
    `view "${view.name}" draws with no boundary panel`,
    reached && drewOk(state),
    !reached
      ? `the route did not move: expected ${view.hash}, the window is on ${state?.hash}; pane said "${state?.text ?? ''}"`
      : drewOk(state)
        ? `${state.hash}, heading "${state.heading ?? '(none)'}", ${state.controls} control(s), pane said "${state.text.slice(0, 60)}"`
        : `boundary: "${state.boundary ?? '(none)'}", ${state.hash}; pane said "${state.text}"`,
  )
}

// Machines lives in Cloud mode: the sidebar tile only routes once the mode has
// switched, so the visit is the two clicks a person makes.
const switched = await clickSidebar(`(x.textContent || '').trim() === 'Cloud'`)
await sleep(500)
const machinesClicked = switched && (await clickSidebar(`(x.textContent || '').trim() === 'Machines'`))
if (!machinesClicked) {
  skip('machines', 'the sidebar has no Machines tile in this mode')
} else {
  const reached = await waitFor("location.hash === '#machines'", { timeout: 5000 })
  await sleep(300)
  const state = await paneState('.split-body')
  record(
    'view "machines" draws with no boundary panel',
    reached && drewOk(state),
    !reached
      ? `the route did not move: expected #machines, the window is on ${state?.hash}; pane said "${state?.text ?? ''}"`
      : drewOk(state)
        ? `${state.hash}, heading "${state.heading ?? '(none)'}", ${state.controls} control(s)`
        : `boundary: "${state.boundary ?? '(none)'}"; pane said "${state.text}"`,
  )
  await clickSidebar(`(x.textContent || '').trim() === 'Local'`)
  await sleep(400)
}

// The popup views: settings, metrics and mobile open over the app rather than
// becoming the route, so the panel itself is what has to draw.
const POPUPS = [
  { name: 'settings', label: 'Settings' },
  { name: 'metrics', label: 'Metrics' },
  { name: 'mobile', label: 'Mobile' },
]
for (const view of POPUPS) {
  const clicked = await clickSidebar(`(x.getAttribute('aria-label') || '').trim() === '${view.label}' || (x.title || '').trim() === '${view.label}'`)
  const opened = clicked && (await waitFor(`!!document.querySelector('.vp-window')`, { timeout: 4000 }))
  if (!opened) {
    record(`view "${view.name}" draws with no boundary panel`, false, clicked ? 'the popup never opened' : 'the sidebar has no control for it')
    continue
  }
  await sleep(300)
  const state = await paneState('.vp-body')
  const title = await evaluate(`document.querySelector('.vp-window')?.getAttribute('aria-label') ?? null`)
  record(
    `view "${view.name}" draws with no boundary panel`,
    drewOk(state),
    drewOk(state)
      ? `popup "${title}", heading "${state.heading ?? '(none)'}", ${state.controls} control(s)`
      : `popup "${title}": boundary "${state.boundary ?? '(none)'}", text "${state.text}"`,
  )
  // Escape closes one layer at a time, and the popup owns its own.
  await key({ key: 'Escape', code: 'Escape', vk: 27 })
  await waitFor("!document.querySelector('.vp-window')", { timeout: 4000 })
  await sleep(200)
}

// ---- the interactions ------------------------------------------------------
//
// Everything above reads; these six press or type. The first four change
// something and undo it, and the last two (the sidebar's search and Settings')
// change nothing at all. Each one asserts what changes on screen, and the
// header says what it proves and what it leaves alone.
//
// (a) A chat row's menu: right-click opens it, its one mark item sits after
// Open and before Rename and closes the menu when pressed, and a second menu
// answers Escape by closing with focus back on the row. Proves those rows are
// where the sidebar's own menu puts them (src/Sidebar.jsx:537 for Open, :545
// for the mark item, :557 for Rename) and that the mark item acts without
// throwing; not that the other rows in the menu do their jobs. The label is
// read rather than asserted: whether the first chat carries the unread mark
// depends on the profile, so the check says which one it found.
const rowMenuTarget = await evaluate(`(() => {
  const r = document.querySelector('.chat-row');
  if (!r) return null;
  r.focus();
  const b = r.getBoundingClientRect();
  return { x: b.x + Math.min(40, b.width / 2), y: b.y + b.height / 2, label: (r.textContent || '').trim().slice(0, 40) };
})()`)
// Open the menu again from the row's current box: the first press through the
// mark item re-renders the row, and a coordinate remembered from before that
// render could land somewhere else.
const openRowMenu = async () => {
  const box = await evaluate(`(() => {
    const r = document.querySelector('.chat-row');
    if (!r) return null;
    r.focus();
    const b = r.getBoundingClientRect();
    return { x: b.x + Math.min(40, b.width / 2), y: b.y + b.height / 2 };
  })()`)
  if (!box) return false
  await click(box.x, box.y, 'right')
  return waitFor("!!document.querySelector('.ctx-menu')", { timeout: 4000 })
}
let rowMenu = null
if (rowMenuTarget) {
  if (await openRowMenu()) {
    // The menu's rows in its own markup: .nc-item-name is the label a person
    // reads (src/ContextMenu.jsx:128), and the menu itself is .nc-menu
    // (src/ContextMenu.jsx:100). Exactly one of the two mark labels belongs in
    // the list, between Open and Rename.
    const menu = await evaluate(`(() => {
      const menu = document.querySelector('.ctx-menu');
      const names = [...menu.querySelectorAll('.nc-item .nc-item-name')].map((n) => (n.textContent || '').trim());
      const marks = names.filter((n) => n === 'Mark as read' || n === 'Mark as unread');
      const mark = marks[0] ?? null;
      const at = names.indexOf(mark);
      const openAt = names.indexOf('Open');
      const renameAt = names.indexOf('Rename');
      const item = [...menu.querySelectorAll('.nc-item')].find(
        (b) => (b.querySelector('.nc-item-name')?.textContent || '').trim() === mark,
      ) ?? null;
      const box = item?.getBoundingClientRect() ?? null;
      return {
        names,
        mark,
        marks: marks.length,
        afterOpen: openAt !== -1 && at > openAt,
        beforeRename: renameAt === -1 || at < renameAt,
        box: box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null,
        menuFocused: document.activeElement === menu,
      };
    })()`)
    let pressed = null
    if (menu.box) {
      await click(menu.box.x, menu.box.y)
      // The menu closes itself when a row is chosen (src/ContextMenu.jsx:64-67:
      // onClose before the row's own action), so nothing may be left over.
      pressed = { closed: await waitFor("!document.querySelector('.nc-menu')", { timeout: 3000 }) }
    }
    // A second menu for the Escape half: pressing the mark item already closed
    // the first one, and closing by key is a separate promise. The row was
    // re-rendered by the mark write, so the focus check below reads the row as
    // it is now rather than a node remembered from before the press.
    const reopened = await openRowMenu()
    let closed = false
    let back = { onRow: false, on: '(none)' }
    if (reopened) {
      await key({ key: 'Escape', code: 'Escape', vk: 27 })
      closed = await waitFor("!document.querySelector('.ctx-menu')", { timeout: 3000 })
      back = await evaluate(`(() => {
        const a = document.activeElement;
        const row = document.querySelector('.chat-row');
        return {
          onRow: Boolean(row) && a === row,
          on: a ? a.tagName + (a.className ? '.' + a.className : '') : '(none)',
        };
      })()`)
    }
    rowMenu = { menu, pressed, reopened, closed, back }
  }
}
record(
  'a chat row menu opens on right-click, its mark item sits between Open and Rename and closes the menu, and Escape closes it with focus back on the row',
  rowMenu?.menu?.marks === 1 &&
    Boolean(rowMenu.menu.afterOpen) &&
    Boolean(rowMenu.menu.beforeRename) &&
    Boolean(rowMenu.pressed?.closed) &&
    Boolean(rowMenu.closed) &&
    Boolean(rowMenu.back.onRow),
  rowMenuTarget
    ? rowMenu
      ? `row "${rowMenuTarget.label}": ${rowMenu.menu.names.length} row(s) "${rowMenu.menu.names.slice(0, 5).join(' / ')}", the mark item was "${rowMenu.menu.mark}" (one of the two: ${rowMenu.menu.marks}, after Open: ${rowMenu.menu.afterOpen}, before Rename: ${rowMenu.menu.beforeRename}), pressing it closed the menu: ${rowMenu.pressed?.closed}, the menu reopened: ${rowMenu.reopened}, Escape closed it: ${rowMenu.closed}, focus after: ${rowMenu.back.on} (on the row: ${rowMenu.back.onRow})`
      : 'the row menu never opened'
    : 'no .chat-row in the sidebar',
)

// (b) The pane header in a split: makes the split with the header's own Split
// right button, reads the rows the header's more-options menu offers there, and
// closes it with Escape, then closes the extra pane with the header's close
// button. Proves the header controls a person presses are there and act; not
// that a split row's effect is what its words say.
//
// Every step starts from a state this check set up itself (New chat, one pane)
// and names the precondition it did not find, so a leftover split or a popup
// from an earlier check cannot make it pass or fail for the wrong reason. It
// addresses the header by its accessible names, not coordinates: the header
// gained a Layouts word button and a chat title beside the split control, which
// is what made the old coordinate-driven version stop finding the menu.
if (!(await clickSidebar(`(x.textContent || '').trim() === 'New chat'`))) {
  record('in a split, the pane header menus work', false, 'precondition: the sidebar has no New chat tile')
} else if (!(await waitFor("location.hash === '#new'", { timeout: 5000 }))) {
  record('in a split, the pane header menus work', false, `precondition: New chat did not open (window is on ${await evaluate('location.hash')})`)
} else {
  const panes = () => evaluate(`document.querySelectorAll('[data-leaf-id]').length`)
  const one = (await waitFor(`document.querySelectorAll('[data-leaf-id]').length === 1`, { timeout: 3000 })) && (await panes()) === 1
  if (!one) {
    record('in a split, the pane header menus work', false, `precondition: the window is not a single pane (${await panes()})`)
  } else {
    // The header's own Split right appears only once the window is already
    // split (SplitArea renders the header when the pane count is above one),
    // so the first split is the pane menu's job: the cursor menu is the one
    // control a person has for it in a single pane. Its row is pressed through
    // the element, never through coordinates.
    // A right-click over a text field opens the text menu, not the pane menu,
    // so each candidate point is checked for the pane menu's own rows before it
    // counts; anything else is dismissed and the next point tried.
    const openPaneMenu = async () => {
      const points = await evaluate(`(() => {
        const pane = document.querySelector('[data-leaf-id]');
        if (!pane) return [];
        const b = pane.getBoundingClientRect();
        return [
          { x: b.x + 12, y: b.y + b.height / 2 },
          { x: b.x + b.width / 2, y: b.y + b.height * 0.3 },
          { x: b.x + b.width / 2, y: b.y + b.height / 2 },
        ];
      })()`)
      for (const p of points ?? []) {
        await click(p.x, p.y, 'right')
        const paneMenuOpen = await waitFor(
          `!!document.querySelector('.ctx-menu') && [...document.querySelectorAll('.ctx-menu .nc-item')].some((i) => /split right/i.test(i.textContent.trim()))`,
          { timeout: 1500 },
        )
        if (paneMenuOpen) return true
        await key({ key: 'Escape', code: 'Escape', vk: 27 })
        await sleep(150)
      }
      return false
    }
    const clickMenuRow = async (source) => {
      // Settle first: the menu clamps itself inside the window in the frame it
      // opens in, and a stale measurement is what broke the old version.
      await sleep(250)
      return evaluate(`(() => {
        const row = [...document.querySelectorAll('.ctx-menu .nc-item')].find((i) => new RegExp('${source}', 'i').test(i.textContent.trim()));
        if (!row) return false;
        row.click();
        return true;
      })()`)
    }
    const splitMade =
      (await openPaneMenu()) &&
      (await clickMenuRow('split right')) &&
      (await waitFor(`document.querySelectorAll('[data-leaf-id]').length === 2`, { timeout: 5000 }))
    let paneMenu = null
    if (splitMade) {
      // The header of the second pane, addressed by role and name.
      const opened = await evaluate(`(() => {
        const panes = [...document.querySelectorAll('[data-leaf-id]')];
        const second = panes[panes.length - 1];
        const b = [...second.querySelectorAll('.split-actions button')].find(
          (x) => (x.getAttribute('aria-label') || '').trim() === 'More split options',
        );
        if (!b) return false;
        b.click();
        return true;
      })()`)
      if (opened && (await waitFor("!!document.querySelector('.ctx-menu')", { timeout: 3000 }))) {
        const labels = await evaluate(`[...document.querySelectorAll('.ctx-menu .nc-item')].map((i) => i.textContent.trim())`)
        await key({ key: 'Escape', code: 'Escape', vk: 27 })
        const closed = await waitFor("!document.querySelector('.ctx-menu')")
        paneMenu = { labels, closed }
      }
      // Close the extra pane with the header's own close button.
      await evaluate(`(() => {
        const panes = [...document.querySelectorAll('[data-leaf-id]')];
        const second = panes[panes.length - 1];
        const b = [...second.querySelectorAll('.split-actions button')].find(
          (x) => (x.getAttribute('aria-label') || '').trim() === 'Close this pane',
        );
        b?.click();
      })()`)
      await waitFor(`document.querySelectorAll('[data-leaf-id]').length === 1`, { timeout: 5000 })
    }
    record(
      'in a split, the pane header menus work',
      splitMade && Boolean(paneMenu?.closed) && (paneMenu?.labels.length ?? 0) >= 4,
      splitMade
        ? paneMenu
          ? `rows "${paneMenu.labels.slice(0, 6).join(' / ')}", Escape closed it: ${paneMenu.closed}, back to ${await panes()} pane(s)`
          : 'the header more-options menu never opened in the split'
        : 'the split never happened (the pane menu or its Split right row did not act)',
    )
  }
}

// (c) The palette's Rules group: a query that matches a rule offers the group
// only while Automations is mounted. Proves the group is mounted with the view
// rather than always on, and that a rule made through the form reaches the
// palette; not that running one does what it says. The dev profile never holds
// a rule, so the check makes its own through the form and deletes it again: a
// gate that skips without a populated profile has never opened the door it
// exists to watch.
const goView = async (label, hash) => {
  const clicked = await clickSidebar(`(x.textContent || '').trim() === '${label}'`)
  if (!clicked) return false
  const reached = await waitFor(`location.hash === '${hash}'`, { timeout: 5000 })
  await sleep(300)
  return reached
}

// Click an element the way a person does: real mouse events at its centre, so
// every handler that reads a coordinate (a picker's anchor, a menu's spot)
// gets a real one. A selector that finds nothing is a false answer, never a
// silent pass.
//
// It scrolls the element into view first, because a coordinate below the fold is
// not a click: the window this runs in is whatever size the dev shell opened at, and
// the plugin check spent one run pressing at y=890 in a 640px-tall window, which hit
// nothing and then read as an arm that never happened.
const clickElement = async (selector) => {
  const box = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const b = el.getBoundingClientRect();
    const inside = b.top >= 0 && b.left >= 0 && b.bottom <= window.innerHeight && b.right <= window.innerWidth;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, inside };
  })()`)
  if (!box) return false
  if (!box.inside) return false
  await sleep(120)
  await click(box.x, box.y)
  return true
}

// What the form receives from the keyboard: letters and spaces, key by key,
// with the printable text attached so the field sees each character. A name
// with no digits keeps this honest about what it exercises.
const typeText = async (text) => {
  for (const ch of text) {
    const keyName = ch === ' ' ? ' ' : ch
    const code = ch === ' ' ? 'Space' : `Key${ch.toUpperCase()}`
    const vk = ch === ' ' ? 32 : ch.toUpperCase().charCodeAt(0)
    await key({ key: keyName, code, vk, text: ch })
  }
}

// A React field keeps its value in state fed by the input event a real keystroke
// produces, and per-character key events are not enough for every field in this
// shell: the rule form ended up with `Rule name=""` after `typeText` typed into
// it, which the gate reported itself when it printed the fields' values. This
// focuses the field, replaces what is in it, and inserts the text in one call,
// then reads the value back so a failed insert is a false answer rather than a
// silent one.
const insertInto = async (selector, text) => {
  const focused = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.focus();
    if (typeof el.setSelectionRange === 'function') {
      try { el.setSelectionRange(0, String(el.value ?? '').length) } catch { /* a field that does not select */ }
    }
    return document.activeElement === el;
  })()`)
  if (!focused) return false
  await send('Input.insertText', { text })
  await sleep(120)
  const value = await evaluate(`document.querySelector(${JSON.stringify(selector)})?.value ?? ''`)
  return value === text
}

const ruleNames = () =>
  evaluate(`[...document.querySelectorAll('.am-rule .am-name')].map((n) => (n.textContent || '').trim())`)

// What the rule's own row says about it, in the row's words: the machine's name
// and, when the rule cannot run here, the app's own sentence for why. The check
// quotes that rather than deciding for itself that a missing palette group is a
// defect.
const ruleRowText = (name) =>
  evaluate(`(() => {
    const row = [...document.querySelectorAll('.am-rule')].find(
      (r) => ((r.querySelector('.am-name')?.textContent) || '').trim() === ${JSON.stringify(name)},
    );
    return row ? (row.innerText || '').replace(/\\s+/g, ' ').trim() : null;
  })()`)

// What the row's own Run button says: `Run now` with the button live when the
// rule can run, and the reason with the button off when it cannot. This is the
// app answering, in its own words, the same question the palette answers with the
// same predicate, so a missing Rules group can be attributed to the rule rather
// than to a defect. Every button is returned too, because the first version of
// this probe guessed by position and had to be told apart from a live button.
const ruleRunTitle = (name) =>
  evaluate(`(() => {
    const row = [...document.querySelectorAll('.am-rule')].find(
      (r) => ((r.querySelector('.am-name')?.textContent) || '').trim() === ${JSON.stringify(name)},
    );
    if (!row) return null;
    const buttons = [...row.querySelectorAll('button')].map((b) => ({
      title: (b.title || '').trim(),
      disabled: Boolean(b.disabled),
    }));
    const run = buttons.find((b) => (b.title || '').toLowerCase().includes('run')) ?? null;
    return { runTitle: run ? run.title : null, runOff: Boolean(run && run.disabled), buttons };
  })()`)

// The rule this check makes and then removes. The palette is searched with the
// first three letters of whichever rule the check is about, because a query that
// begins a rule's name is the shortest honest one: it proves the group is offered
// for a rule this run looked for, not that some other row matched.
const smokeRuleName = 'Smoke rule'
const smokeRuleTask = 'Run the smoke rule'

// Seed the check's own subject through the UI, exactly as a person would. On a
// profile that already holds a rule this is a no-op and the first rule is the
// subject, so two runs against one profile behave the same.
const seedRule = async () => {
  await key({ key: 'Escape', code: 'Escape', vk: 27 })
  await sleep(150)
  if (!(await goView('Automations', '#automations'))) {
    return { created: false, name: null, why: 'the Automations view did not open' }
  }
  const before = await ruleNames()
  if (before.length > 0) {
    return {
      created: false,
      name: before[0],
      rules: before,
      rowText: await ruleRowText(before[0]),
      buttons: await ruleRunTitle(before[0]),
      refusedShort: null,
    }
  }

  if (!(await clickElement('.automations header button.dv-act'))) {
    return { created: false, name: null, why: 'Automations has no New rule button' }
  }
  if (!(await waitFor(`!!document.querySelector('[aria-label="New automation"]')`, { timeout: 4000 }))) {
    return { created: false, name: null, why: 'the New rule form did not open' }
  }

  // The name field carries focus when the dialog opens, and this replaces
  // whatever it holds, so the insert cannot append to a template.
  const named = await insertInto('input[aria-label="Rule name"]', smokeRuleName)
  await sleep(120)
  // The form's own gate, read before the task is filled: Save stays refused
  // while the rule is short of the fields it needs. Recording the refusal is
  // what makes the later save a proof that the gate opened, not that a click
  // happened to land.
  const refusedShort = await evaluate(`(() => {
    const b = document.querySelector('.af-foot .dv-connect');
    return Boolean(b && b.disabled && (b.textContent || '').trim() === 'Create rule');
  })()`)
  const tasked = await insertInto('.af-task', smokeRuleTask)
  await sleep(150)
  if (!named || !tasked) {
    await clickElement('.af-foot .dv-act')
    await waitFor(`!document.querySelector('[aria-label="New automation"]')`, { timeout: 3000 })
    return {
      created: false,
      name: null,
      refusedShort,
      why: `the form's own fields did not take the text this check types into them (name ${named ? 'landed' : 'stayed empty'}, task ${tasked ? 'landed' : 'stayed empty'}), so no rule was made; the form is driven for real elsewhere in the app, so treat this as the check's own typing being wrong`,
    }
  }
  const ready = await waitFor(
    `(() => { const b = document.querySelector('.af-foot .dv-connect'); return Boolean(b && !b.disabled); })()`,
    { timeout: 6000 },
  )
  if (!ready) {
    // What is missing is the form's own answer, not this script's guess: every
    // picker marks itself `data-unset` when it holds nothing, and the notes say
    // what a save still needs. The first version of this check read the cells by
    // position and blamed the harness and the project, which the form had; the
    // picker order is harness, permission, model and machine, so position is not
    // a name.
    const form = await evaluate(`(() => {
      const picks = [...document.querySelectorAll('.af-pick')].map((b) => ({
        text: (b.textContent || '').trim(),
        unset: b.hasAttribute('data-unset'),
      }));
      const notes = [...document.querySelectorAll('.af-when-note')].map((n) => (n.textContent || '').trim());
      // When nothing is flagged, the form still knows why it will not save, and
      // the only honest thing the check can do is quote it: a skip that names
      // the wrong field sends a person to fix what was never broken.
      const dialog = document.querySelector('[aria-label="New automation"]');
      const said = (dialog?.innerText ?? '').replace(/\\s+/g, ' ').trim();
      // An input's text is its value, never its innerText, so the form's own
      // sentence says nothing about whether the name and the task arrived. Those
      // are exactly what this check typed, so they are read here.
      const typed = [...(dialog?.querySelectorAll('input, textarea') ?? [])].map((el) => ({
        field: el.getAttribute('aria-label') || el.placeholder || el.type || 'field',
        value: String(el.value ?? '').slice(0, 40),
      }));
      return { unset: picks.filter((p) => p.unset).map((p) => p.text), picks, notes, said, typed };
    })()`)
    await clickElement('.af-foot .dv-act')
    await waitFor(`!document.querySelector('[aria-label="New automation"]')`, { timeout: 3000 })
    const advice = (form.unset ?? [])
      .map((text) =>
        text === 'No machine online'
          ? 'a rule runs on a machine, and this computer is not one: make one of your computers a machine in Machines'
          : text === 'No harness installed'
            ? 'no harness is installed: install one in Plugins'
            : `"${text}" holds nothing: fill it in the form`,
      )
      .join('; ')
    return {
      created: false,
      name: null,
      refusedShort,
      why: `the form refuses Save with the name and task filled; the form itself says these still hold nothing: ${form.unset?.length ? `"${form.unset.join('", "')}"` : '(nothing is flagged, so the form is short of something it does not mark)'}${form.notes.length ? `, and its notes say "${form.notes.join(' | ')}"` : ''}${advice ? `; ${advice}` : ''}${form.said ? `; the form reads "${form.said.slice(0, 240)}"` : ''}${form.typed?.length ? `; the fields hold ${form.typed.map((f) => `${f.field}="${f.value}"`).join(', ')}` : ''}`,
    }
  }

  if (!(await clickElement('.af-foot .dv-connect'))) {
    return { created: false, name: null, refusedShort, why: 'the Create rule button disappeared' }
  }
  const appeared = await waitFor(
    `[...document.querySelectorAll('.am-rule .am-name')].some((n) => (n.textContent || '').trim() === ${JSON.stringify(smokeRuleName)})`,
    { timeout: 8000 },
  )
  if (!appeared) {
    const said = await evaluate(`document.querySelector('.af-error')?.textContent?.trim() ?? null`)
    // Cancel discards on purpose: Escape only raises the form's own warning
    // while a half-written rule is in it, so the dialog would stay open over
    // the next check.
    await clickElement('.af-foot .dv-act')
    await waitFor(`!document.querySelector('[aria-label="New automation"]')`, { timeout: 3000 })
    return {
      created: false,
      name: null,
      refusedShort,
      why: `the save produced no rule${said ? ` (the form said "${said}")` : ''}`,
    }
  }
  return { created: true, name: smokeRuleName, rules: [smokeRuleName], rowText: await ruleRowText(smokeRuleName), buttons: await ruleRunTitle(smokeRuleName), refusedShort }
}

const rulesIn = async (label, hash, query) => {
  // Any menu or popup left by an earlier check is dismissed first: a check that
  // fails on the previous check's state is worse than no check.
  await key({ key: 'Escape', code: 'Escape', vk: 27 })
  await sleep(120)
  if (!(await goView(label, hash))) return null
  await key({ key: 'k', code: 'KeyK', vk: 75, modifiers: 2 })
  if (!(await waitFor("!!document.querySelector('.kb-palette')"))) return null
  // The groups the palette offers before a query is typed, so a failed search can
  // be told apart from a group that never appeared: the two mean different
  // things to the person reading the failure.
  const atRest = await evaluate(
    `[...document.querySelectorAll('.kb-group-label')].map((l) => l.textContent.trim())`,
  )
  await insertInto('.kb-search input', query)
  await sleep(250)
  const seen = await evaluate(`(() => {
    const groups = [...document.querySelectorAll('.kb-group')].map((g) => ({
      label: (g.querySelector('.kb-group-label')?.textContent || '').trim(),
      rows: [...g.querySelectorAll('.kb-item .kb-name')].map((n) => (n.textContent || '').trim()),
    }));
    const rules = groups.find((g) => g.label === 'Rules');
    const palette = document.querySelector('.kb-palette');
    return {
      labels: groups.map((g) => g.label),
      rulesRows: rules ? rules.rows : [],
      hasRules: groups.some((g) => g.label === 'Rules'),
      said: (palette?.innerText ?? '').replace(/\\s+/g, ' ').trim().slice(0, 300),
    };
  })()`)
  await key({ key: 'Escape', code: 'Escape', vk: 27 })
  await waitFor("!document.querySelector('.kb-palette')", { timeout: 4000 })
  return { ...seen, atRest }
}

// Remove the rule this run made, by the same two presses a person uses: the
// row's trash, then the row's own confirmation. Every path that created one
// calls this, including the ones that skip: a gate that leaves its subject in
// the profile has changed what it was asked to observe.
const removeSeededRule = async (name) => {
  await clickSidebar(`(x.textContent || '').trim() === 'Automations'`)
  await sleep(300)
  const armed = await clickElement(`button[aria-label=${JSON.stringify(`Remove ${name}`)}]`)
  const armedUp =
    armed &&
    (await waitFor(
      `[...document.querySelectorAll('.am-rule button')].some((b) => (b.textContent || '').trim() === 'Remove it and its schedule')`,
      { timeout: 3000 },
    ))
  if (armedUp) await clickElement('.am-rule button.pn-btn--danger')
  const removed = await waitFor(
    `![...document.querySelectorAll('.am-rule .am-name')].some((n) => (n.textContent || '').trim() === ${JSON.stringify(name)})`,
    { timeout: 8000 },
  )
  return {
    removed,
    note: removed
      ? ''
      : `the rule "${name}" is still in this profile: remove it by hand in Automations (its trash, then Remove it and its schedule) before the next run`,
  }
}
const seed = await seedRule()
const rulesQuery = seed.name ? seed.name.trim().slice(0, 3).toLowerCase() || 'rul' : 'rul'
// The reads, and then the removal, in a `try`: every one of them drives the real
// window and any of them can throw (a closed socket, an element that vanished
// mid-flight). Without the `finally` a throw here would leave the rule this run
// made in the profile it was only supposed to observe, and the next run would
// start against a profile this one changed.
let onAutomations = null
let onPlugins = null
let byFullName = null
let cleaned = { removed: !seed.created, note: '' }
try {
  onAutomations = seed.name ? await rulesIn('Automations', '#automations', rulesQuery) : null
  onPlugins = seed.name ? await rulesIn('Plugins', '#plugins', rulesQuery) : null
  // The same view searched by the rule's whole name, because a group that appears
  // for the full name and not for three letters points at the ranking rather than
  // at the gating, and the two need different fixes.
  byFullName = seed.name ? await rulesIn('Automations', '#automations', seed.name) : null
} finally {
  if (seed.created) cleaned = await removeSeededRule(seed.name)
}

if (!seed.name) {
  skip('the rule the form makes', seed.why ?? 'no rule to look for and none could be made')
  skip('the palette rules group', seed.why ?? 'no rule to look for and none could be made')
} else {
  // The form's own gate, which this run is the only thing that ever exercises: a
  // half-filled rule cannot be saved, the save makes a row, and the row can be
  // removed again. All three are facts this run caused and then read back.
  record(
    'a rule made through the form is refused until it is filled, and can be removed again',
    Boolean(seed.created ? seed.refusedShort : true) && Boolean(seed.name) && cleaned.removed,
    `Save was refused before the task: ${seed.refusedShort ?? '(no form opened)'}; the rule reached the list: ${Boolean(seed.name)}; created by this run: ${seed.created}; removed again: ${cleaned.removed}${cleaned.note ? `; ${cleaned.note}` : ''}; the row reads "${seed.rowText ?? '(none)'}"; its buttons: ${JSON.stringify(seed.buttons?.buttons ?? null)}`,
  )

  // The palette's Rules group is a group of rules that can run here, so it can
  // only be asserted where this profile holds one. The app answers that question
  // itself, twice and from one predicate: the row's Run button is disabled with
  // the reason in its title, and the palette filters on the same answer. So a
  // disabled Run whose title names the machine is the app saying "this rule
  // cannot run here", and the palette rightly offers no row for it. That is a
  // skip with the app's own sentence, not a defect and not a pass on an empty
  // list. The first run of this check, on 2026-10-28, made a rule and searched
  // for its own name: the palette offered only Chats on both views.
  if (onAutomations?.hasRules && onPlugins && !onPlugins.hasRules) {
    record(
      "the palette's Rules group appears only while Automations is mounted",
      true,
      `Automations: "${onAutomations.labels.join(', ')}"; Plugins: "${onPlugins.labels.join(', ')}"; the query was "${rulesQuery}" and the subject was "${seed.name}" (${seed.created ? 'created for this check' : 'already in the profile'})`,
    )
  } else if (seed.buttons?.runOff) {
    skip(
      'the palette rules group',
      `this rule cannot run here, and the app says so itself: its Run button is off with "${seed.buttons?.runTitle}". The palette offers a run row only for a rule that can run, so there is no group to gate. ${String(seed.buttons?.runTitle ?? '').includes('not answered') ? 'The machine list has not answered in this profile' : 'Bring that machine online'}, then run again`,
    )
  } else if (byFullName?.hasRules) {
    // The whole name finds it and three letters do not, so the group works and
    // the ranking is what hid it: the check's own query was the wrong probe.
    skip(
      'the palette rules group',
      `the group is there: searched by the rule's whole name the palette offered "${byFullName.labels.join(', ')}" with the row "${byFullName.rulesRows.join(', ') || '(none)'}", while the three-letter query "${rulesQuery}" offered only "${onAutomations?.labels.join(', ') ?? '(no groups)'}". So the gating works and the query is what missed it; use the whole name in this check once the ranking is understood`,
    )
  } else {
    skip(
      'the palette rules group',
      `not established here: with the rule "${seed.name}" in the profile whose Run button is live, the palette searched for "${rulesQuery}" offered ${onAutomations ? `"${onAutomations.labels.join(', ') || '(no groups)'}"` : 'no palette'} on Automations and ${onPlugins ? `"${onPlugins.labels.join(', ') || '(no groups)'}"` : 'no palette'} on Plugins, and searched by the whole name it offered "${byFullName?.labels?.join(', ') ?? '(no palette)'}"; before any query it offered "${onAutomations?.atRest?.join(', ') ?? '(none)'}". That is either the search or the group's assembly, and this run cannot tell which`,
    )
  }
}


// (d) An armed plugin row: the first press on Remove arms it, Escape takes the
// arm back, and the plugin is still in the list; then the same two presses
// remove it, so this check proves both halves and leaves the profile as it
// found it. The dev profile never holds a plugin, so the check makes one from a
// folder it writes itself and installs it through the dialog's typed Folder
// path. A profile that already holds a plugin uses the first row and removes
// nothing.
const smokePluginName = 'smoke-plugin'

// The installed plugin rows, with the button that removes each one. Built-in
// harnesses carry an On/Off button and no Remove, so the row's own actions are
// the filter rather than a section heading.
const pluginRows = () =>
  evaluate(`[...document.querySelectorAll('.pn-row--stack')].map((row) => {
    const buttons = [...row.querySelectorAll('.pn-actions button')];
    const label = (b) => (b.textContent || '').trim();
    const remove = buttons.find((b) => label(b) === 'Remove');
    const armed = buttons.find((b) => label(b) === 'Remove it');
    const target = remove ?? armed;
    // Scrolled into view before it is measured: a coordinate below the fold is not
    // a press, and the dev shell's window is whatever size it opened at.
    target?.scrollIntoView({ block: 'center', inline: 'nearest' });
    const box = target?.getBoundingClientRect() ?? null;
    const inside = Boolean(box) && box.top >= 0 && box.bottom <= window.innerHeight;
    return {
      name: (row.querySelector('.pn-name')?.textContent || '').trim(),
      buttons: buttons.map(label),
      removeBox: box && inside ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null,
      remove: Boolean(remove),
      armed: Boolean(armed),
    };
  })`)

// The temp folder the check installs from: one manifest, the only file the
// daemon needs (a name of lowercase letters, digits and dashes), and nothing
// else, so the review has no powers or parts to ask about.
const writePluginFolder = async () => {
  const root = await mkdtemp(join(tmpdir(), 'openremote-smoke-'))
  const folder = join(root, smokePluginName)
  await mkdir(join(folder, '.claude-plugin'), { recursive: true })
  await writeFile(
    join(folder, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify({ name: smokePluginName, version: '0.0.1', description: 'A plugin the smoke installs and removes.' }, null, 2)}\n`,
  )
  return { root, folder }
}

// Drive the install the way a person does: the header's Install a plugin, the
// Folder kind (the dialog opens on it), the path typed into its field, Read the
// plugin, then Install on the review. A control that is missing is reported as
// a step the smoke cannot drive; a refusal is reported with the app's sentence.
const installFromFolder = async (folder) => {
  if (!(await clickElement('.pg-head .dv-act'))) {
    return { why: 'the Plugins header has no Install a plugin button' }
  }
  if (!(await waitFor(`!!document.querySelector('[aria-label="Install a plugin"]')`, { timeout: 5000 }))) {
    return { why: 'the Install a plugin dialog did not open' }
  }
  // The dialog opens on Folder; pressing it is what a person does to be sure,
  // and a dialog that lost that default would be caught here rather than by a
  // path typed into the Git field.
  const folderKind = await evaluate(`(() => {
    const chip = [...document.querySelectorAll('.pn-pick button')].find((b) => (b.textContent || '').trim() === 'Folder');
    if (!chip) return false;
    chip.click();
    return true;
  })()`)
  if (!folderKind) return { why: 'the install dialog offers no Folder kind' }
  if (!(await insertInto('[aria-label="Install a plugin"] .dv-command', folder))) {
    await clickElement('[aria-label="Install a plugin"] .dv-modal-close')
    return { why: 'the folder path could not be typed into the install dialog' }
  }
  await clickElement('[aria-label="Install a plugin"] .dv-connect')
  const reviewed = await waitFor(`!!document.querySelector('.pg-review-actions')`, { timeout: 15000 })
  if (!reviewed) {
    // An approval screen that asks the smoke to run a command is a branch this
    // gate cannot answer, and it says so with the screen's own shape rather
    // than a generic timeout.
    const needsCommand = await evaluate(`Boolean(document.querySelector('[role="dialog"] .pg-command--block'))`)
    const said = await evaluate(
      `document.querySelector('[aria-label="Install a plugin"] .pn-error')?.textContent?.trim() ?? null`,
    )
    await clickElement('[aria-label="Install a plugin"] .dv-modal-close')
    return {
      why: needsCommand
        ? 'the approval screen asked to run a command, which this smoke cannot answer'
        : (said ?? 'the review never appeared after reading the folder'),
      command: needsCommand,
      refused: Boolean(said),
    }
  }
  await clickElement('.pg-review-actions .dv-act')
  const installed = await waitFor(
    `[...document.querySelectorAll('.pn-name')].some((n) => (n.textContent || '').trim().startsWith(${JSON.stringify(smokePluginName)}))`,
    { timeout: 15000 },
  )
  if (!installed) {
    const said = await evaluate(
      `document.querySelector('[role="dialog"] .pn-error')?.textContent?.trim() ?? null`,
    )
    const closed = await clickElement('.pg-review-actions .pn-btn')
    if (!closed) await clickElement('[role="dialog"] .dv-modal-close')
    return { why: said ?? 'the install did not put a row in the list', refused: Boolean(said) }
  }
  return { installed: true }
}

const pluginState = { name: null, created: false, tempRoot: null, why: null, refused: false }
let pluginArm = null
try {
  await key({ key: 'Escape', code: 'Escape', vk: 27 })
  await sleep(150)
  if (!(await goView('Plugins', '#plugins'))) {
    pluginState.why = 'the Plugins view did not open'
  } else {
    // The Installed tab is not the default: Discover is.
    await evaluate(`(() => {
      const tab = [...document.querySelectorAll('.pg-tab')].find((b) => (b.textContent || '').trim() === 'Installed');
      if (tab) tab.click();
      return Boolean(tab);
    })()`)
    await waitFor(`!!document.querySelector('.pg-installed-view')`, { timeout: 5000 })
    await sleep(200)
    const existing = (await pluginRows()).find((r) => r.remove)
    if (existing) {
      pluginState.name = existing.name
    } else {
      const written = await writePluginFolder()
      pluginState.tempRoot = written.root
      const install = await installFromFolder(written.folder)
      if (install.installed) {
        const after = (await pluginRows()).find((r) => r.name.startsWith(smokePluginName))
        pluginState.created = true
        pluginState.name = after?.name ?? smokePluginName
      } else {
        pluginState.why = install.why
        pluginState.refused = Boolean(install.refused)
      }
    }
  }
  if (pluginState.name) {
    const before = (await pluginRows()).filter((r) => r.remove).length
    const subject = (await pluginRows()).find((r) => r.name === pluginState.name && r.removeBox)
    if (!subject) {
      pluginState.why = `the row for "${pluginState.name}" has no Remove button`
    } else {
      // Press it, and if the row's arm did not appear, measure again and press once
      // more before calling it: the list is live (a plugin install or a beat can
      // move a row between the measure and the press), and a person looking at the
      // button would simply press again. The check still requires the arm to show.
      let armsUp = false
      for (let press = 0; press < 2 && !armsUp; press += 1) {
        const row = (await pluginRows()).find((r) => r.name === pluginState.name && r.removeBox)
        if (!row) break
        await click(row.removeBox.x, row.removeBox.y)
        armsUp = await waitFor(
          `[...document.querySelectorAll('.pn-row--stack')].some((r) => [...r.querySelectorAll('.pn-actions button')].some((b) => (b.textContent || '').trim() === 'Remove it'))`,
          { timeout: 3000 },
        )
      }
      await key({ key: 'Escape', code: 'Escape', vk: 27 })
      await sleep(250)
      const armedAfterEscape = (await pluginRows()).find((r) => r.name === pluginState.name)?.armed ?? false
      // The pane's documented rule is that an arm ends when the row stops being
      // what the person is looking at, and it implements that on blur and on
      // scrolling. If Escape did not take the arm back, this click is that same
      // rule doing the cleanup, so the row is never left armed; the assertion
      // above still fails and names the key rather than the state.
      if (armedAfterEscape) {
        await clickElement('.pg-installed-view .pn-section')
        await sleep(250)
      }
      const settled = await pluginRows()
      const rowNow = settled.find((r) => r.name === pluginState.name)
      pluginArm = {
        before,
        after: settled.filter((r) => r.remove).length,
        armsUp,
        armedAfterEscape,
        armedAfterBlur: rowNow?.armed ?? false,
        stillListed: Boolean(rowNow),
      }
    }
  }
} catch (err) {
  // A throw from the page still has to end in a check line and still has to
  // run the cleanups below: the shape of the output is part of the gate.
  pluginState.why = `the drive threw: ${err?.message ?? err}`
} finally {
  // Both cleanups run whatever happened above: the plugin this run installed
  // and the folder it wrote. A cleanup that cannot finish is said in the
  // failure detail instead of being left as a dirty profile.
  let removed = !pluginState.created
  let removalNote = ''
  if (pluginState.created && pluginState.name) {
    let row = null
    try {
      row = (await pluginRows()).find((r) => r.name === pluginState.name) ?? null
    } catch {
      row = null
    }
    if (row) {
      if (!row.armed && row.removeBox) await click(row.removeBox.x, row.removeBox.y)
      const armedUp = await waitFor(
        `[...document.querySelectorAll('.pn-row--stack')].some((r) => [...r.querySelectorAll('.pn-actions button')].some((b) => (b.textContent || '').trim() === 'Remove it'))`,
        { timeout: 3000 },
      )
      if (armedUp) await clickElement('.pn-row--stack .pn-btn--danger')
      removed = await waitFor(
        `![...document.querySelectorAll('.pn-name')].some((n) => (n.textContent || '').trim().startsWith(${JSON.stringify(pluginState.name)}))`,
        { timeout: 10000 },
      )
    }
    if (!removed) {
      removalNote = `the plugin "${pluginState.name}" is still installed: remove it by hand in Plugins > Installed (its Remove, then Remove it) before the next run`
    }
  }
  if (pluginState.tempRoot) {
    await rm(pluginState.tempRoot, { recursive: true, force: true }).catch(() => {})
  }
  pluginState.removed = removed
  pluginState.removalNote = removalNote
}

if (!pluginState.name) {
  skip(
    'the armed plugin row',
    pluginState.why
      ? `${pluginState.why}; the check needs a plugin it can install from a folder it writes`
      : 'no plugin could be installed in this profile',
  )
} else {
  record(
    'arming a plugin row and pressing Escape cancels the arm and removes nothing',
    Boolean(pluginArm?.armsUp) &&
      pluginArm?.armedAfterEscape === false &&
      pluginArm?.after === pluginArm?.before &&
      pluginState.removed,
    `subject "${pluginState.name}" (${pluginState.created ? 'installed from a temp folder by this run' : 'already in the profile, so nothing was created'}); armed on the first press: ${pluginArm?.armsUp}; still armed after Escape: ${pluginArm?.armedAfterEscape}; after the fallback blur: ${pluginArm?.armedAfterBlur}; still listed: ${pluginArm?.stillListed}; Remove buttons ${pluginArm?.before} -> ${pluginArm?.after}; removed again: ${pluginState.removed}${pluginState.removalNote ? `; ${pluginState.removalNote}` : ''}${pluginState.why ? `; ${pluginState.why}` : ''}`,
  )
}

// (e) The sidebar's search reads, and only reads: a word taken from a title the
// list is already showing narrows the list to the rows that carry it, and Escape
// gives the whole list back with the field empty. Proves the field is wired to
// the list's filter and that Escape clears it; not that a query finds a chat by
// anything other than its title, because the sidebar's filter is title-only
// (src/Sidebar.jsx:158-163), and not that a matching row opens.
//
// The Needs you group ignores the query on purpose (a starving chat is not
// hidden by a word typed for something else), so those rows are excluded from
// the "every row still shown matches" assertion rather than excused afterwards.
const sidebarSearch = { why: null, run: null }
try {
  await key({ key: 'Escape', code: 'Escape', vk: 27 })
  await sleep(150)
  const sidebarField = await evaluate(`(() => {
    const el = document.querySelector('label.side-tile.search input');
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  })()`)
  // Every row the list is drawing, with the title a person reads and whether it
  // sits in the group the search deliberately leaves alone.
  const sidebarRows = () =>
    evaluate(`[...document.querySelectorAll('.chat-row[data-chat-row]')].map((r) => ({
      id: r.getAttribute('data-chat-row'),
      title: ((r.querySelector('.chat-title')?.textContent) || '').trim(),
      waiting: Boolean(r.closest('.sb-needs')),
    }))`)
  if (!sidebarField) {
    sidebarSearch.why = 'the sidebar renders no search field (label.side-tile.search input, src/Sidebar.jsx:743)'
  } else {
    const before = await sidebarRows()
    // The word comes from a title the list is showing, so the check reads the
    // same on a profile with one chat and on one with fifty: the longest word
    // of four letters or more is a word a person can type into the field.
    const words = before
      .filter((r) => !r.waiting)
      .flatMap((r) => r.title.split(/[^A-Za-z0-9]+/))
      .filter((w) => w.length >= 4)
      .sort((a, b) => b.length - a.length)
    const word = words[0] ?? null
    const subject = word ? before.find((r) => !r.waiting && r.title.toLowerCase().includes(word.toLowerCase())) : null
    if (!before.length) {
      sidebarSearch.why = 'the profile shows no chats, so a search has nothing to narrow'
    } else if (!word || !subject) {
      sidebarSearch.why = `no shown chat outside Needs you has a word of four letters in its title (titles: ${before.map((r) => `"${r.title}"`).join(', ')})`
    } else {
      // Focus it the way a person does, then insert the word whole: per-character
      // keys do not reach this shell's React fields (see insertInto).
      await click(sidebarField.x, sidebarField.y)
      const typed = await insertInto('label.side-tile.search input', word)
      await sleep(250)
      const after = await sidebarRows()
      const low = word.toLowerCase()
      const strays = after.filter((r) => !r.waiting && !r.title.toLowerCase().includes(low))
      const stillShown = after.some((r) => r.id === subject.id)
      // Escape in the field clears it (src/Sidebar.jsx:736-742), then a second
      // Escape leaves the field so nothing is left focused by this check.
      await key({ key: 'Escape', code: 'Escape', vk: 27 })
      await sleep(250)
      const back = await sidebarRows()
      const value = await evaluate(`document.querySelector('label.side-tile.search input')?.value ?? null`)
      const restored = back.length === before.length && back.every((r) => before.some((b) => b.id === r.id))
      await key({ key: 'Escape', code: 'Escape', vk: 27 })
      sidebarSearch.run = {
        word,
        typed,
        before: before.length,
        after: after.length,
        strays,
        stillShown,
        titles: after.map((r) => r.title).slice(0, 5),
        restored,
        value,
      }
    }
  }
} catch (err) {
  sidebarSearch.why = `the drive threw: ${err?.message ?? err}`
}
if (sidebarSearch.why || !sidebarSearch.run) {
  skip('the sidebar search', sidebarSearch.why ?? 'the check ended without a result')
} else {
  const run = sidebarSearch.run
  record(
    'the sidebar search narrows to the rows that match and Escape gives the list back',
    Boolean(run?.typed) && run.strays.length === 0 && run.stillShown && run.restored && run.value === '',
    `typed "${run.word}": ${run.before} row(s) before, ${run.after} after (titles after "${run.titles.join(' / ')}"); rows the word does not match: ${run.strays.length}${run.strays.length ? ` ("${run.strays.map((r) => r.title).join('", "')}")` : ''}; the row it came from still shown: ${run.stillShown}; Escape gave back ${run.before} row(s): ${run.restored}, field reads "${run.value}"`,
  )
}

// (f) "New chat with this setup": with a chat on screen, Ctrl+K offers one row
// of that name whose sub line is the chat's title, and pressing it lands on New
// chat with the chat's harness already chosen. Proves the row is offered and
// that the seed reaches New chat's own picker; not that the model, effort,
// approval word or project are right (src/chat-setup.test.js owns the rule). It
// writes nothing.
const newWithSetup = { why: null, run: null }

// The checks after this one expect the window on New chat, not on whichever
// chat this check opened. This runs on every path, including the skips.
const backToNewChat = async () => {
  for (let i = 0; i < 2; i += 1) {
    if (await evaluate("location.hash === '#new' && !document.querySelector('.kb-palette')")) return true
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('.sidebar button')].find((x) => (x.textContent || '').trim() === 'New chat');
      b?.click();
      return Boolean(b);
    })()`)
    await waitFor("location.hash === '#new'", { timeout: 5000 })
    await key({ key: 'Escape', code: 'Escape', vk: 27 })
    await sleep(200)
  }
  return evaluate("location.hash === '#new' && !document.querySelector('.kb-palette')")
}

try {
  await key({ key: 'Escape', code: 'Escape', vk: 27 })
  await sleep(150)
  // The sidebar's own row: its data-chat-row is the chat id and its .chat-title
  // is the title the sub line is supposed to repeat (src/Sidebar.jsx:639 and
  // :662, the row markup in the chat list).
  const firstChat = await evaluate(`(() => {
    const row = document.querySelector('.chat-row[data-chat-row]');
    if (!row) return null;
    const b = row.getBoundingClientRect();
    return {
      id: row.getAttribute('data-chat-row'),
      title: (row.querySelector('.chat-title')?.textContent || '').trim(),
      x: b.x + b.width / 2,
      y: b.y + b.height / 2,
    };
  })()`)
  if (!firstChat) {
    newWithSetup.why = 'the sidebar shows no chat rows, so there is no chat to copy a setup from'
  } else {
    await click(firstChat.x, firstChat.y)
    const opened = await waitFor(`location.hash === ${JSON.stringify(`#${firstChat.id}`)}`, { timeout: 5000 })
    // The chat has to be drawn before its facts row can be read: the hash moves
    // before the record is loaded on a cold chat.
    const chatDrawn = opened && (await waitFor("!!document.querySelector('.chatview .cv-facts')", { timeout: 5000 }))
    // The chat's facts row is where its own harness is written; the first
    // .cv-fact is that name (src/ChatView.jsx:828). With no readable harness
    // there is no value to compare New chat's picker against, so the check
    // says so and skips rather than guessing one.
    const harness = chatDrawn
      ? await evaluate(
          `(document.querySelector('.chatview .cv-facts .cv-fact')?.textContent || '').trim()`,
        )
      : ''
    if (!opened) {
      newWithSetup.why = `the row "${firstChat.title}" did not open: the window is on ${(await evaluate('location.hash')) || '(none)'}`
    } else if (!chatDrawn) {
      newWithSetup.why = `the chat "${firstChat.title}" opened but its view never drew a facts row (.chatview .cv-facts)`
    } else if (!harness) {
      newWithSetup.why = `the chat "${firstChat.title}" shows no harness in its facts row (.cv-facts .cv-fact, src/ChatView.jsx:828)`
    } else {
      await key({ key: 'k', code: 'KeyK', vk: 75, modifiers: 2 })
      const palette = await waitFor("!!document.querySelector('.kb-palette')", { timeout: 4000 })
      if (!palette) {
        newWithSetup.why = 'Ctrl+K did not open the palette on the chat'
      } else {
        // The row's own name minus its last word, typed whole: per-character
        // keys do not land in this shell's React fields (see insertInto).
        const typed = await insertInto('.kb-search input', 'new chat with')
        await sleep(250)
        // The rows the palette is drawing, in its own markup: .kb-item is the
        // row, .kb-name its name and .kb-sub its sub line
        // (src/CommandPalette.jsx:1310-1316), and the setup row's sub is the
        // focused chat's title (src/CommandPalette.jsx:526).
        const rows = await evaluate(`[...document.querySelectorAll('.kb-item')].map((i) => {
          const b = i.getBoundingClientRect();
          return {
            name: (i.querySelector('.kb-name')?.textContent || '').trim(),
            sub: (i.querySelector('.kb-sub')?.textContent || '').trim(),
            box: { x: b.x + b.width / 2, y: b.y + b.height / 2 },
          };
        })`)
        const setupRows = rows.filter((r) => r.name === 'New chat with this setup')
        if (!typed) {
          await key({ key: 'Escape', code: 'Escape', vk: 27 })
          newWithSetup.why = 'the palette search field did not take the typed words (insertInto read a different value back)'
        } else if (setupRows.length === 0) {
          await key({ key: 'Escape', code: 'Escape', vk: 27 })
          newWithSetup.why = `the palette offered no row named "New chat with this setup" for the chat "${firstChat.title}"; it offered ${rows.map((r) => `"${r.name}"`).join(', ') || 'nothing'}`
        } else if (setupRows.length > 1) {
          await key({ key: 'Escape', code: 'Escape', vk: 27 })
          newWithSetup.run = { duplicates: setupRows.length, rows: rows.map((r) => r.name), harness, title: firstChat.title }
        } else {
          const offered = setupRows[0]
          await click(offered.box.x, offered.box.y)
          const closed = await waitFor("!document.querySelector('.kb-palette')", { timeout: 4000 })
          const landed = await waitFor("location.hash === '#new'", { timeout: 5000 })
          // New chat's harness picker carries data-picker="harness" and shows
          // the chosen harness's own name (src/NewChat.jsx:1216-1227).
          const pickerReady =
            landed && (await waitFor(`!!document.querySelector('button[data-picker="harness"]')`, { timeout: 5000 }))
          const picker = pickerReady
            ? await evaluate(`(() => {
                const b = document.querySelector('button[data-picker="harness"]');
                return b
                  ? { text: (b.textContent || '').trim(), unset: b.getAttribute('data-unset') === 'true' }
                  : null;
              })()`)
            : null
          newWithSetup.run = {
            typed,
            rows: rows.map((r) => r.name),
            sub: offered.sub,
            title: firstChat.title,
            harness,
            closed,
            landed,
            picker,
          }
        }
      }
    }
  }
} catch (err) {
  newWithSetup.why = `the drive threw: ${err?.message ?? err}`
} finally {
  newWithSetup.back = await backToNewChat()
}

if (newWithSetup.run?.duplicates) {
  record(
    'the palette offers one "New chat with this setup" row for the chat on screen',
    false,
    `the palette offered ${newWithSetup.run.duplicates} rows of that name for the chat "${newWithSetup.run.title}"; rows were ${newWithSetup.run.rows.map((r) => `"${r}"`).join(', ')}`,
  )
} else if (newWithSetup.why || !newWithSetup.run) {
  skip('the palette new chat with this setup', newWithSetup.why ?? 'the check ended without a result')
} else {
  const run = newWithSetup.run
  record(
    'the palette offers "New chat with this setup" for the chat on screen and it lands on New chat with the same harness',
    run.typed && run.sub === run.title && run.closed && run.landed && Boolean(run.picker) &&
      !run.picker.unset && run.picker.text === run.harness,
    `chat "${run.title}" (harness "${run.harness}"); the row's sub line read "${run.sub}"; rows offered for the query: ${run.rows.map((r) => `"${r}"`).join(', ')}; the palette closed on the press: ${run.closed}; the window reached #new: ${run.landed}; New chat's harness picker read "${run.picker?.text ?? '(no picker)'}" (unset: ${run.picker?.unset ?? '(none)'}); back on New chat afterwards: ${newWithSetup.back}`,
  )
}

// (g) Settings search reads too: a word a person would type for a setting
// reaches a row whose label does not contain it, because the index carries the
// words people use beside the labels (src/settings-search.js). "gateway" is one
// of those words: no static label holds it and the model-endpoint block's terms
// do. Then Escape clears the field and the sections come back. Proves the field,
// the terms and the clearing; not that pressing a result lands on its row.
const settingsSearch = { why: null, run: null }
// The window is left as this check found it on every path, including the skips:
// a check that fails on the next one's leftover popup is worse than no check.
const closeSettingsWindow = async () => {
  for (let i = 0; i < 3; i += 1) {
    if (!(await evaluate("!!document.querySelector('.vp-window')"))) return true
    await key({ key: 'Escape', code: 'Escape', vk: 27 })
    await sleep(200)
  }
  return !(await evaluate("!!document.querySelector('.vp-window')"))
}
const drawn = (selector) =>
  evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].filter((el) => el.getClientRects().length > 0).length`)
try {
  await key({ key: 'Escape', code: 'Escape', vk: 27 })
  await sleep(150)
  const settingsOpener = await evaluate(`(() => {
    const b = [...document.querySelectorAll('.sidebar button')].find(
      (x) => ((x.getAttribute('aria-label') || '').trim() === 'Settings') || ((x.title || '').trim() === 'Settings'),
    );
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`)
  if (!settingsOpener) {
    settingsSearch.why = 'the sidebar has no Settings control'
  } else {
    await click(settingsOpener.x, settingsOpener.y)
    const opened = await waitFor("!!document.querySelector('.vp-window')", { timeout: 4000 })
    if (!opened) {
      settingsSearch.why = 'the Settings window did not open from the sidebar'
    } else {
      await sleep(300)
      const fieldSelector = '.stg-search input[aria-label="Search settings"]'
      const hasField = await evaluate(`Boolean(document.querySelector(${JSON.stringify(fieldSelector)}))`)
      const sectionsBefore = await drawn('.stg-section')
      const resultsBefore = await drawn('.stg-result')
      if (!hasField) {
        settingsSearch.why = 'the Settings window renders no search field (.stg-search input, src/SettingsView.jsx:623)'
      } else if (sectionsBefore < 1) {
        settingsSearch.why = `the Settings window showed no drawn section to restore (${sectionsBefore})`
      } else {
        const word = 'gateway'
        const typed = await insertInto(fieldSelector, word)
        const resultsAppeared = await waitFor(
          `[...document.querySelectorAll('.stg-result')].some((el) => el.getClientRects().length > 0)`,
          { timeout: 4000 },
        )
        const shown = await evaluate(`(() => {
          const rows = [...document.querySelectorAll('.stg-result')].filter((el) => el.getClientRects().length > 0);
          return {
            rows: rows.length,
            labels: rows.map((r) => ((r.querySelector('.stg-result-name')?.textContent) || '').trim()),
            lead: ((document.querySelector('.stg-lead')?.textContent) || '').trim(),
            empty: ((document.querySelector('.stg-empty-name')?.textContent) || '').trim(),
          };
        })()`)
        const low = word.toLowerCase()
        const synonym = (shown.labels ?? []).some((l) => !l.toLowerCase().includes(low))
        await key({ key: 'Escape', code: 'Escape', vk: 27 })
        await sleep(250)
        const cleared = await evaluate(`document.querySelector(${JSON.stringify(fieldSelector)})?.value ?? null`)
        const sectionsAfter = await drawn('.stg-section')
        const resultsAfter = await drawn('.stg-result')
        const popupClosed = await closeSettingsWindow()
        settingsSearch.run = {
          word,
          typed,
          resultsBefore,
          resultsAppeared,
          shown,
          synonym,
          sectionsBefore,
          cleared,
          sectionsAfter,
          resultsAfter,
          popupClosed,
        }
      }
      if (!settingsSearch.run) await closeSettingsWindow()
    }
  }
} catch (err) {
  settingsSearch.why = `the drive threw: ${err?.message ?? err}`
  await closeSettingsWindow().catch(() => false)
}
if (settingsSearch.why || !settingsSearch.run) {
  skip('the settings search', settingsSearch.why ?? 'the check ended without a result')
} else {
  const run = settingsSearch.run
  record(
    'the settings search reaches a synonym and Escape brings the sections back',
    Boolean(run?.typed) && run.resultsAppeared && run.synonym && run.cleared === '' && run.sectionsAfter === run.sectionsBefore && run.resultsAfter === 0 && run.popupClosed,
    `typed "${run.word}": ${run.resultsBefore} drawn result(s) before, ${run.shown.rows} after (labels "${run.shown.labels.join(' / ')}"; the lead reads "${run.shown.lead}"${run.shown.empty ? `; the panel reads "${run.shown.empty}"` : ''}); a label without the word: ${run.synonym}; Escape cleared the field: "${run.cleared}", sections ${run.sectionsBefore} -> ${run.sectionsAfter}, results ${run.resultsAfter}; the window is closed again: ${run.popupClosed}`,
  )
}

// ---- the browser's three surfaces tonight ----
//
// Five checks in the order a person meets them: find the pane open (toggling
// only when it is not already there), load the dev server, keep the page on
// the bookmarks bar, read it in History, and leave the address field without
// losing the window.

const paneAlready = await evaluate("!!document.querySelector('.bw-bar input')")
if (!paneAlready) await key({ key: 'b', code: 'KeyB', vk: 66, modifiers: 2 | 8 })
const paneOpen = await waitFor("!!document.querySelector('.bw-bar input')", { timeout: 8000 })
record(
  'the browser pane opens from Ctrl+Shift+B with its address bar',
  paneOpen,
  paneOpen ? `${paneAlready ? 'the pane was already open' : 'Ctrl+Shift+B opened the pane'}, with its .bw-bar input` : 'Ctrl+Shift+B did not open the pane',
)

if (!paneOpen) {
  skip('the browser surfaces', 'the pane never opened')
} else {
  const run = { loaded: false, address: '', tabs: 0, starred: false, chip: '', bar: 0, history: false, historyRow: '', escaped: false, stillThere: false }
  try {
    await insertInto('.bw-bar input', 'http://127.0.0.1:5175')
    await key({ key: 'Enter', code: 'Enter', vk: 13, modifiers: 0 })
    run.loaded = await waitFor(
      "(() => { const i = document.querySelector('.bw-bar input'); const t = [...document.querySelectorAll('[role=\"tab\"]')].filter((el) => el.getClientRects().length > 0); return Boolean(i) && i.value.includes('127.0.0.1') && t.length > 0; })()",
      { timeout: 15000 },
    )
    run.address = await evaluate("document.querySelector('.bw-bar input')?.value ?? ''")
    run.tabs = await evaluate("document.querySelectorAll('[role=\"tab\"]').length")
    record(
      'the pane loads the dev server and shows its address',
      run.loaded,
      run.loaded ? 'field reads "' + run.address + '", ' + run.tabs + ' tab(s)' : 'the field reads "' + run.address + '" with ' + run.tabs + ' tab(s)',
    )

    const starPressed = await evaluate("(() => { const b = document.querySelector('.bw-bar .bw-star'); if (!b || b.disabled) return false; b.click(); return true; })()")
    run.starred = starPressed && (await waitFor("[...document.querySelectorAll('.bw-marks .bw-mark')].length > 0", { timeout: 5000 }))
    run.bar = await evaluate("document.querySelectorAll('.bw-marks .bw-mark').length")
    run.stored = await evaluate("(() => { try { const raw = JSON.parse(localStorage.getItem('openremote-browser-bookmarks') || '{}'); return (raw.marks || []).some((m) => m.url === 'http://127.0.0.1:5175'); } catch { return false } })()")
    run.chip = await evaluate("([...document.querySelectorAll('.bw-marks .bw-mark-title')][0]?.textContent ?? '').trim()")
    record(
      'the star puts the page on the bookmarks bar as one chip',
      run.starred && run.bar === 1 && run.chip.length > 0 && run.stored,
      starPressed ? run.bar + ' chip(s), first reads "' + run.chip + '", stored: ' + run.stored : 'no enabled .bw-star beside the address bar',
    )

    // The row is enabled once the view has the visit; the store write and the
    // next render are one beat apart, so wait for the durable fact first.
    await waitFor("(() => { try { const raw = JSON.parse(localStorage.getItem('openremote-browser-history') || '{}'); return (raw.visits || []).some((v) => String(v.url || '').includes('127.0.0.1:5175')); } catch { return false } })()", { timeout: 8000 })
    const more = await evaluate("(() => { const b = [...document.querySelectorAll('.bw-bar button')].find((x) => /^More/.test(x.getAttribute('title') || x.getAttribute('aria-label') || '')); if (!b) return false; b.click(); return true; })()")
    const menuOpen = more && (await waitFor("!!document.querySelector('.ctx-menu')", { timeout: 4000 }))
    let why = more ? 'the More menu did not open' : 'no More button in the bar'
    if (menuOpen) {
      why = await evaluate("(() => { const r = [...document.querySelectorAll('.ctx-menu .nc-item')].find((i) => /^History/.test(i.textContent.trim())); if (!r) return 'the menu has no History row'; if (r.disabled) return 'the History row is disabled'; r.click(); return 'clicked'; })()")
      if (why === 'clicked') run.history = await waitFor("!!document.querySelector('.bw-history')", { timeout: 4000 })
      if (run.history) {
        run.historyRow = await evaluate("([...document.querySelectorAll('.bw-history-row')].map((x) => (x.textContent || '').trim()).find((t) => /127\\.0\\.0\\.1/.test(t)) ?? '')")
        await key({ key: 'Escape', code: 'Escape', vk: 27 })
        await waitFor("!document.querySelector('.bw-history')", { timeout: 4000 })
      }
    }
    record(
      'History lists the address the pane loaded',
      run.history && run.historyRow.length > 0,
      run.history ? 'the row reads "' + run.historyRow + '"' : why,
    )

    await evaluate("document.querySelector('.bw-bar input')?.focus()")
    await key({ key: 'Escape', code: 'Escape', vk: 27 })
    await sleep(200)
    run.stillThere = await evaluate("Boolean(document.querySelector('.bw-bar')) && Boolean(document.querySelector('.sidebar'))")
    record(
      'Escape in the address field keeps the pane and the console',
      run.stillThere,
      run.stillThere ? 'the pane and the sidebar are still drawn' : 'the pane or the sidebar disappeared after Escape',
    )
  } catch (err) {
    skip('the browser surfaces', 'the drive threw: ' + (err?.message ?? err))
  }
}
const passed = results.filter((r) => r.pass).length
console.log(
  `\n${passed} of ${results.length} checks passed${skips.length ? `, ${skips.length} skipped (${skips.map((s) => s.name).join(', ')})` : ''}`,
)
ws.close()
process.exit(passed === results.length ? 0 : 1)
