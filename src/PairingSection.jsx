// Pairing a phone by QR code, on the Mobile view.
//
// The daemon does the real work: it holds the one live code, opens a socket
// on the local network while a code is on screen or a phone is paired, and
// keeps the phone records. This component asks for a code, draws it, watches
// for a phone to arrive, and lists the phones that already did - so it needs
// no account, no Cloud, and no network beyond this computer and the phone.

import { useEffect, useRef, useState } from 'react'
import { DeviceMobile } from '@phosphor-icons/react'
import { pairedLabel, pairingApi, pairingError, phoneName, remainingLabel } from './pairing.js'
import { qrRows } from './qr.js'
import './pairing.css'

const TICK_MS = 1000
const POLL_MS = 3000

// Four modules of quiet zone, as the standard asks: a scanner cannot find
// the corners without it.
const QUIET = 4

function QrCard({ url }) {
  let rows = null
  let failed = false
  try {
    rows = qrRows(url)
  } catch {
    failed = true
  }
  if (failed || !rows) {
    // Honest fallback: the address below the code is always readable.
    return <p className="qr-note">This address is too long to draw as a code. Open it on the phone instead.</p>
  }
  const side = rows.length + QUIET * 2
  const dark = []
  rows.forEach((row, y) => {
    row.forEach((module, x) => {
      if (module) dark.push(`M${x + QUIET},${y + QUIET}h1v1h-1z`)
    })
  })
  return (
    <svg className="qr-code" viewBox={`0 0 ${side} ${side}`} role="img" aria-label="Pairing code">
      <rect width={side} height={side} fill="#ffffff" />
      <path d={dark.join('')} fill="#0a0c0f" shapeRendering="crispEdges" />
    </svg>
  )
}

export default function PairingSection() {
  const api = useRef(null)
  if (api.current === null) api.current = pairingApi()
  // The live code, exactly as the daemon minted it; null when nothing is on
  // screen.
  const [live, setLive] = useState(null)
  // null until the first list arrives, so "no phones" is never a guess.
  const [phones, setPhones] = useState(null)
  const [joined, setJoined] = useState(null)
  const [error, setError] = useState(null)
  // The daemon's own complaint about the pairing port (it could not bind at
  // boot with a phone already paired), which no retry here caused.
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let stopped = false
    api.current
      .phones()
      .then((answer) => {
        if (!stopped) {
          setPhones(answer.phones ?? [])
          setNotice(answer.notice ?? null)
        }
      })
      .catch((err) => {
        // The read failing says nothing about the list: an empty one here
        // would draw "nothing is listening on your network" under the error
        // that says the read failed, which the daemon never told us.
        if (!stopped) setError(pairingError(err))
      })
    return () => {
      stopped = true
    }
  }, [])

  // While a code is on screen: count it down, and watch for the phone. A
  // phone that pairs uses the code up, so the arrival is the end of the
  // countdown rather than a second thing to do.
  useEffect(() => {
    if (!live) return undefined
    const before = phones?.length ?? 0
    const tick = setInterval(() => setNow(Date.now()), TICK_MS)
    const poll = setInterval(async () => {
      try {
        const answer = await api.current.phones()
        const list = answer.phones ?? []
        if (list.length > before) {
          const fresh = list.find((phone) => !(phones ?? []).some((known) => known.id === phone.id))
          setJoined(fresh ? phoneName(fresh.name) : 'A phone')
          setPhones(list)
          setLive(null)
        }
      } catch {
        // A poll that fails changes nothing: the code is still on screen,
        // and the countdown still ends it.
      }
    }, POLL_MS)
    return () => {
      clearInterval(tick)
      clearInterval(poll)
    }
  }, [live, phones])

  // The clock runs out: the daemon has already closed the socket, and the
  // card goes away with it.
  useEffect(() => {
    if (!live) return
    if (remainingLabel(live.expires_at, now) === 'Expired') setLive(null)
  }, [live, now])

  const start = async () => {
    setBusy(true)
    setError(null)
    setJoined(null)
    try {
      const mint = await api.current.start()
      setNow(Date.now())
      setLive(mint)
      if (Array.isArray(mint.phones)) setPhones(mint.phones)
      // The daemon opened the port to answer this, so a boot-time complaint
      // about the port is no longer true.
      setNotice(null)
    } catch (err) {
      setError(pairingError(err))
    } finally {
      setBusy(false)
    }
  }

  const stop = async () => {
    setBusy(true)
    setError(null)
    try {
      const answer = await api.current.cancel()
      if (Array.isArray(answer.phones)) setPhones(answer.phones)
      setNotice(answer.notice ?? null)
      // Only a cancel the daemon confirmed takes the card down: if it failed,
      // the code is still live there, and hiding it would hide that.
      setLive(null)
    } catch (err) {
      setError(pairingError(err))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (id) => {
    setError(null)
    try {
      const answer = await api.current.revoke(id)
      setPhones(answer.phones ?? [])
      setNotice(answer.notice ?? null)
    } catch (err) {
      // Already gone is the outcome the click wanted.
      if (err?.status === 404) {
        try {
          const answer = await api.current.phones()
          setPhones(answer.phones ?? [])
        } catch {
          setPhones((list) => (list ?? []).filter((phone) => phone.id !== id))
        }
        return
      }
      setError(pairingError(err))
    }
  }

  return (
    <div className="qr-pair">
      <h2 className="pn-section">Pair a phone</h2>
      <p className="pn-lead">
        Show a code here and scan it with the phone's camera. The phone opens a read-only view of
        this computer's chats, and nothing leaves your local network.
      </p>
      <p className="qr-note">
        The phone and this computer talk straight to each other over the local network, without a
        server in between, and that connection is not encrypted: a device that can watch this
        network's traffic can see the pairing go by. Pair on a network you trust.
      </p>

      {!live && (
        <div className="qr-actions">
          <button className="pn-btn" onClick={start} disabled={busy}>
            Show a code
          </button>
          {joined && <span className="qr-note">{joined} is paired.</span>}
        </div>
      )}

      {live && (
        <div className="qr-card">
          <QrCard url={live.url} />
          <div className="qr-side">
            <p className="qr-wait">
              <span className="qr-dot" />
              Waiting for a phone
            </p>
            <p className="qr-clock">{remainingLabel(live.expires_at, now)}</p>
            <p className="qr-hint">Or open this on the phone:</p>
            <p className="qr-address">{live.url}</p>
            <p className="qr-note">
              If the phone cannot reach this computer, allow OpenRemote through Windows Firewall.
              Both devices must be on the same network.
            </p>
            <button className="pn-btn" onClick={stop} disabled={busy}>
              Stop showing
            </button>
          </div>
        </div>
      )}

      {error && <p className="qr-error">{error}</p>}
      {notice && !error && <p className="qr-error">{notice}</p>}

      {phones !== null && phones.length > 0 && (
        <ul className="qr-phones">
          {phones.map((phone) => (
            <li key={phone.id} className="qr-phone">
              <span className="qr-phone-icon">
                <DeviceMobile size={17} weight="light" />
              </span>
              <span className="qr-phone-name">{phoneName(phone.name)}</span>
              <span className="qr-phone-when">{pairedLabel(phone, now)}</span>
              <button className="pn-btn" onClick={() => revoke(phone.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {phones !== null && phones.length === 0 && (
        <p className="pn-empty">
          No phones paired with this computer. Nothing is listening on your network: the pairing
          port opens only while a code is on screen or a phone is paired.
        </p>
      )}
    </div>
  )
}
