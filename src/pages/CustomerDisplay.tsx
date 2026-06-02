import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { resolvePosLogoForBackground } from '../theme/posLogo'
import { APP_NAME } from '../brand'
import {
  CUSTOMER_DISPLAY_COMPLETE_MS,
  CUSTOMER_DISPLAY_SPOTLIGHT_MS,
  type CustomerDisplayMode,
  type CustomerDisplaySnapshot,
} from '../customerDisplay/types'
import type { LoyaltyKeyAction } from '../loyalty/types'
import './CustomerDisplay.css'

const LOYALTY_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'] as const

function sendLoyaltyKey(action: LoyaltyKeyAction) {
  window.electronCustomerDisplay?.sendLoyaltyKey(action)
}

function handleLoyaltyPhoneKeyDown(e: KeyboardEvent<HTMLInputElement>) {
  if (e.key >= '0' && e.key <= '9') {
    e.preventDefault()
    sendLoyaltyKey({ type: 'digit', digit: e.key })
    return
  }
  if (e.key === 'Backspace') {
    e.preventDefault()
    sendLoyaltyKey({ type: 'backspace' })
    return
  }
  if (e.key === 'Delete') {
    e.preventDefault()
    sendLoyaltyKey({ type: 'clear' })
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    sendLoyaltyKey({ type: 'confirm' })
    return
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    sendLoyaltyKey({ type: 'cancel' })
  }
}

function formatMoney(n: number): string {
  return `R ${n.toFixed(2)}`
}

function effectiveMode(
  snapshot: CustomerDisplaySnapshot | null,
  localOverride: CustomerDisplayMode | null,
): CustomerDisplayMode {
  if (localOverride) return localOverride
  return snapshot?.mode ?? 'idle'
}

export function CustomerDisplayPage() {
  const [snapshot, setSnapshot] = useState<CustomerDisplaySnapshot | null>(null)
  const [localMode, setLocalMode] = useState<CustomerDisplayMode | null>(null)
  const [spotlightVisible, setSpotlightVisible] = useState(false)
  const loyaltyPhoneInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!window.electronCustomerDisplay) return
    return window.electronCustomerDisplay.onSnapshot((next) => {
      setSnapshot(next as CustomerDisplaySnapshot)
    })
  }, [])

  useEffect(() => {
    if (snapshot?.mode !== 'complete' || !snapshot.complete?.token) {
      setLocalMode(null)
      return
    }
    setLocalMode('complete')
    const t = window.setTimeout(() => setLocalMode('ready'), CUSTOMER_DISPLAY_COMPLETE_MS)
    return () => window.clearTimeout(t)
  }, [snapshot?.mode, snapshot?.complete?.token])

  useEffect(() => {
    if (!snapshot?.spotlight?.imageUrl) {
      setSpotlightVisible(false)
      return
    }
    setSpotlightVisible(true)
    const t = window.setTimeout(() => setSpotlightVisible(false), CUSTOMER_DISPLAY_SPOTLIGHT_MS)
    return () => window.clearTimeout(t)
  }, [snapshot?.spotlight?.imageUrl, snapshot?.spotlight?.name])

  const mode = effectiveMode(snapshot, localMode)
  const theme = snapshot?.theme ?? {
    backgroundColor: snapshot?.idle?.backgroundColor ?? '#0f1419',
    accentColor: snapshot?.idle?.accentColor ?? '#3b82f6',
    textColor: '#f4f4f5',
  }

  const style = useMemo(
    () =>
      ({
        '--cd-bg': theme.backgroundColor,
        '--cd-accent': theme.accentColor,
        '--cd-fg': theme.textColor ?? '#f4f4f5',
      }) as CSSProperties,
    [theme.backgroundColor, theme.accentColor, theme.textColor],
  )

  const brandLogoSrc = useMemo(
    () => resolvePosLogoForBackground(theme.backgroundColor),
    [theme.backgroundColor],
  )

  const loyaltyEntryOpen = mode === 'loyalty-entry' && Boolean(snapshot?.loyaltyEntry)
  const showSpotlight =
    !loyaltyEntryOpen && spotlightVisible && snapshot?.spotlight && mode !== 'idle'
  const cartMode =
    !loyaltyEntryOpen &&
    (mode === 'cart' || (showSpotlight && (snapshot?.lines?.length ?? 0) > 0))

  const bindLoyaltyPhoneInput = useCallback(
    (el: HTMLInputElement | null) => {
      loyaltyPhoneInputRef.current = el
      if (!el || !loyaltyEntryOpen) return
      const focus = () => {
        try {
          el.focus({ preventScroll: true })
          const len = el.value.length
          el.setSelectionRange(len, len)
        } catch {
          el.focus()
        }
      }
      focus()
      requestAnimationFrame(focus)
      window.setTimeout(focus, 0)
    },
    [loyaltyEntryOpen],
  )

  const refocusLoyaltyPhoneInput = useCallback(() => {
    const el = loyaltyPhoneInputRef.current
    if (!el) return
    try {
      el.focus({ preventScroll: true })
      const len = el.value.length
      el.setSelectionRange(len, len)
    } catch {
      el.focus()
    }
  }, [])

  useEffect(() => {
    if (!loyaltyEntryOpen) return
    const timers: number[] = []
    const run = () => refocusLoyaltyPhoneInput()
    run()
    for (const ms of [50, 150, 350, 700]) {
      timers.push(window.setTimeout(run, ms))
    }
    return () => {
      for (const t of timers) window.clearTimeout(t)
    }
  }, [loyaltyEntryOpen, snapshot?.loyaltyEntryFocusToken, refocusLoyaltyPhoneInput])

  useEffect(() => {
    if (!window.electronCustomerDisplay?.onFocusLoyaltyPhone) return
    return window.electronCustomerDisplay.onFocusLoyaltyPhone(() => {
      refocusLoyaltyPhoneInput()
      window.setTimeout(refocusLoyaltyPhoneInput, 50)
      window.setTimeout(refocusLoyaltyPhoneInput, 200)
      window.setTimeout(refocusLoyaltyPhoneInput, 500)
    })
  }, [refocusLoyaltyPhoneInput])

  return (
    <div className="customer-display-root" style={style}>
      {showSpotlight ? (
        <div className="customer-display-spotlight" aria-live="polite">
          {snapshot!.spotlight!.imageUrl ? (
            <img src={snapshot!.spotlight!.imageUrl} alt="" className="customer-display-spotlight-img" />
          ) : null}
          <p className="customer-display-spotlight-name">{snapshot!.spotlight!.name}</p>
        </div>
      ) : null}

      {!showSpotlight && mode === 'idle' && snapshot?.idle ? (
        <div className="customer-display-idle">
          <img src={brandLogoSrc} alt={APP_NAME} className="customer-display-brand-logo" decoding="async" />
          <h2 className="customer-display-headline">{snapshot.idle.headline}</h2>
          {snapshot.idle.subtext ? <p className="customer-display-subtext">{snapshot.idle.subtext}</p> : null}
          {snapshot.idle.imageUrl ? (
            <img src={snapshot.idle.imageUrl} alt="" className="customer-display-idle-img" />
          ) : null}
          <p className="customer-display-footer">{snapshot.idle.footerText}</p>
        </div>
      ) : null}

      {loyaltyEntryOpen && snapshot?.loyaltyEntry ? (
        <div className="customer-display-loyalty">
          <img src={brandLogoSrc} alt={APP_NAME} className="customer-display-brand-logo customer-display-brand-logo--compact" decoding="async" />
          <h1 className="customer-display-loyalty-title">{snapshot.loyaltyEntry.headline}</h1>
          <p className="customer-display-loyalty-sub">{snapshot.loyaltyEntry.subtext}</p>
          <input
            ref={bindLoyaltyPhoneInput}
            type="tel"
            inputMode="numeric"
            autoComplete="tel"
            enterKeyHint="done"
            autoFocus
            data-loyalty-phone-input
            aria-label="Cellphone number"
            className="customer-display-loyalty-value customer-display-loyalty-input"
            value={snapshot.loyaltyEntry.displayValue}
            aria-live="polite"
            onKeyDown={handleLoyaltyPhoneKeyDown}
            onPaste={(e) => e.preventDefault()}
            onChange={() => undefined}
          />
          <div className="customer-display-loyalty-pad" role="group" aria-label="Phone keypad">
            {LOYALTY_KEYS.map((key, i) => {
              if (key === '') {
                return <span key={`sp-${i}`} className="customer-display-loyalty-key customer-display-loyalty-key--spacer" />
              }
              const action: LoyaltyKeyAction =
                key === '⌫' ? { type: 'backspace' } : { type: 'digit', digit: key }
              return (
                <button
                  key={key}
                  type="button"
                  className="customer-display-loyalty-key"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    sendLoyaltyKey(action)
                    refocusLoyaltyPhoneInput()
                  }}
                >
                  {key}
                </button>
              )
            })}
          </div>
          <div className="customer-display-loyalty-actions">
            <button
              type="button"
              className="customer-display-loyalty-action customer-display-loyalty-action--ghost"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                sendLoyaltyKey({ type: 'cancel' })
                refocusLoyaltyPhoneInput()
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="customer-display-loyalty-action customer-display-loyalty-action--clear"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                sendLoyaltyKey({ type: 'clear' })
                refocusLoyaltyPhoneInput()
              }}
            >
              Clear
            </button>
            <button
              type="button"
              className="customer-display-loyalty-action customer-display-loyalty-action--primary"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                sendLoyaltyKey({ type: 'confirm' })
                refocusLoyaltyPhoneInput()
              }}
            >
              OK
            </button>
          </div>
        </div>
      ) : null}

      {!showSpotlight && mode === 'ready' ? (
        <div className="customer-display-ready">
          <img src={brandLogoSrc} alt={APP_NAME} className="customer-display-brand-logo" decoding="async" />
          <p className="customer-display-ready-msg">We&apos;re ready to serve you</p>
          {snapshot?.footerText ? <p className="customer-display-footer">{snapshot.footerText}</p> : null}
        </div>
      ) : null}

      {cartMode && snapshot?.lines ? (
        <div className={`customer-display-cart${showSpotlight ? ' customer-display-cart--dimmed' : ''}`}>
          <header className="customer-display-cart-header">
            <img src={brandLogoSrc} alt={APP_NAME} className="customer-display-brand-logo customer-display-brand-logo--compact" decoding="async" />
          </header>
          <ul className="customer-display-lines">
            {snapshot.lines.map((line, i) => (
              <li key={`${line.name}-${i}`} className="customer-display-line">
                <span className="customer-display-line-qty">{line.quantity}×</span>
                <span className="customer-display-line-name">{line.name}</span>
                <span className="customer-display-line-total">{formatMoney(line.lineTotal)}</span>
              </li>
            ))}
          </ul>
          <footer className="customer-display-cart-footer">
            {snapshot.loyaltyMasked ? (
              <p className="customer-display-loyalty-linked">
                Loyalty {snapshot.loyaltyMasked}
                {snapshot.loyaltyPointsBalance != null
                  ? ` · ${snapshot.loyaltyPointsBalance.toLocaleString()} pts`
                  : null}
              </p>
            ) : null}
            <div className="customer-display-total-row">
              <span>Total</span>
              <strong>{formatMoney(snapshot.total ?? 0)}</strong>
            </div>
            {snapshot.footerText ? <p className="customer-display-footer">{snapshot.footerText}</p> : null}
          </footer>
        </div>
      ) : null}

      {!showSpotlight && mode === 'complete' && snapshot?.complete ? (
        <div className="customer-display-complete">
          <h1 className="customer-display-complete-title">Thank you</h1>
          <p className="customer-display-complete-paid">{formatMoney(snapshot.complete.totalPaid)}</p>
          {snapshot.complete.changeDue != null && snapshot.complete.changeDue > 0.005 ? (
            <p className="customer-display-complete-change">
              Change: <strong>{formatMoney(snapshot.complete.changeDue)}</strong>
            </p>
          ) : null}
          {snapshot.footerText ? <p className="customer-display-footer">{snapshot.footerText}</p> : null}
        </div>
      ) : null}
    </div>
  )
}
