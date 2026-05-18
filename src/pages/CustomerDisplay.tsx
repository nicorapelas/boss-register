import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import cogniLogo from '../assets/logo-text_bottom1-dark.png'
import { APP_NAME } from '../brand'
import {
  CUSTOMER_DISPLAY_COMPLETE_MS,
  CUSTOMER_DISPLAY_SPOTLIGHT_MS,
  type CustomerDisplayMode,
  type CustomerDisplaySnapshot,
} from '../customerDisplay/types'
import './CustomerDisplay.css'

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
  }

  const style = useMemo(
    () =>
      ({
        '--cd-bg': theme.backgroundColor,
        '--cd-accent': theme.accentColor,
      }) as CSSProperties,
    [theme.backgroundColor, theme.accentColor],
  )

  const showSpotlight = spotlightVisible && snapshot?.spotlight && mode !== 'idle'
  const cartMode = mode === 'cart' || (showSpotlight && (snapshot?.lines?.length ?? 0) > 0)

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
          <img src={cogniLogo} alt={APP_NAME} className="customer-display-brand-logo" decoding="async" />
          <h2 className="customer-display-headline">{snapshot.idle.headline}</h2>
          {snapshot.idle.subtext ? <p className="customer-display-subtext">{snapshot.idle.subtext}</p> : null}
          {snapshot.idle.imageUrl ? (
            <img src={snapshot.idle.imageUrl} alt="" className="customer-display-idle-img" />
          ) : null}
          <p className="customer-display-footer">{snapshot.idle.footerText}</p>
        </div>
      ) : null}

      {!showSpotlight && mode === 'ready' ? (
        <div className="customer-display-ready">
          <img src={cogniLogo} alt={APP_NAME} className="customer-display-brand-logo" decoding="async" />
          <p className="customer-display-ready-msg">We&apos;re ready to serve you</p>
          {snapshot?.footerText ? <p className="customer-display-footer">{snapshot.footerText}</p> : null}
        </div>
      ) : null}

      {cartMode && snapshot?.lines ? (
        <div className={`customer-display-cart${showSpotlight ? ' customer-display-cart--dimmed' : ''}`}>
          <header className="customer-display-cart-header">
            <img src={cogniLogo} alt={APP_NAME} className="customer-display-brand-logo customer-display-brand-logo--compact" decoding="async" />
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
