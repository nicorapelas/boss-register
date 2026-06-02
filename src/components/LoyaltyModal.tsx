import { useEffect } from 'react'
import type { LoyaltyProgramConfig, LoyaltyPurchaseRow } from '../loyalty/types'

export type LoyaltyModalProps = {
  open: boolean
  onClose: () => void
  busy: boolean
  cartTotal: number
  program: LoyaltyProgramConfig | null
  masked: string | null
  balance: number
  purchases: LoyaltyPurchaseRow[]
  purchasesTotal: number
  purchasesLoading: boolean
  pointsRedeem: number
  discount: number
  entryActive: boolean
  onStartPhoneEntry: () => void
  onCancelPhoneEntry: () => void
  onRedeemMax: () => void
  onClear: () => void
}

export function LoyaltyModal({
  open,
  onClose,
  busy,
  cartTotal,
  program,
  masked,
  balance,
  purchases,
  purchasesTotal,
  purchasesLoading,
  pointsRedeem,
  discount,
  entryActive,
  onStartPhoneEntry,
  onCancelPhoneEntry,
  onRedeemMax,
  onClear,
}: LoyaltyModalProps) {
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open || !program?.enabled) return null

  const dueAfterLoyalty = cartTotal - discount

  return (
    <div
      className="open-tabs-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="loyalty-modal-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="open-tabs-dialog quotes-modal-dialog loyalty-modal-dialog">
        <div className="open-tabs-header">
          <h2 id="loyalty-modal-title">Loyalty</h2>
          <button type="button" className="btn ghost open-tabs-close" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="quotes-modal-body loyalty-modal-body">
          {masked ? (
            <p className="register-loyalty-status">
              Member <strong>{masked}</strong> · {balance.toLocaleString()} points available
            </p>
          ) : entryActive ? (
            <p className="register-loyalty-status muted">
              Phone keypad should be on the <strong>customer display</strong> now. Customer enters their number
              there; this till is paused for SKU entry.
            </p>
          ) : (
            <p className="register-loyalty-status muted">
              Tap <strong>Enter phone on display</strong> below to show the loyalty keypad on the customer
              display.
            </p>
          )}

          {discount > 0.005 ? (
            <p className="register-loyalty-redeem-banner" role="status">
              Redeeming <strong>{pointsRedeem.toLocaleString()} pts</strong> — discount{' '}
              <strong>−R {discount.toFixed(2)}</strong>
              <br />
              Sale due after loyalty: <strong>R {dueAfterLoyalty.toFixed(2)}</strong> (subtotal R{' '}
              {cartTotal.toFixed(2)})
            </p>
          ) : masked ? (
            <p className="muted small loyalty-modal-hint">
              Min redeem: {program.minRedeemPoints.toLocaleString()} pts · Max{' '}
              {program.maxRedeemPercent}% of sale
            </p>
          ) : null}

          {masked ? (
            <div className="loyalty-purchase-history-panel">
              <h3 className="loyalty-purchase-history-heading">
                Recent purchases
                {purchasesTotal > 0 ? (
                  <span className="muted"> ({purchasesTotal.toLocaleString()} total)</span>
                ) : null}
              </h3>
              {purchasesLoading ? (
                <p className="muted small">Loading history…</p>
              ) : purchases.length > 0 ? (
                <ul className="loyalty-purchase-list">
                  {purchases.map((p) => (
                    <li key={p._id} className="loyalty-purchase-list-item">
                      <span className="loyalty-purchase-list-date">
                        {p.createdAt
                          ? new Date(p.createdAt).toLocaleDateString(undefined, {
                              day: 'numeric',
                              month: 'short',
                              year: 'numeric',
                            })
                          : '—'}
                      </span>
                      <span className="loyalty-purchase-list-sale">
                        {p.saleId ? `#${p.saleId}` : p._id.slice(-8)}
                        {p.tillCode ? ` · ${p.tillCode}` : ''}
                      </span>
                      <span className="loyalty-purchase-list-total">R {p.total.toFixed(2)}</span>
                      {(p.loyaltyPointsEarned ?? 0) > 0 || (p.loyaltyPointsRedeemed ?? 0) > 0 ? (
                        <span className="loyalty-purchase-list-pts muted small">
                          {(p.loyaltyPointsRedeemed ?? 0) > 0
                            ? `−${p.loyaltyPointsRedeemed?.toLocaleString()}`
                            : ''}
                          {(p.loyaltyPointsEarned ?? 0) > 0
                            ? `${(p.loyaltyPointsRedeemed ?? 0) > 0 ? ' / ' : ''}+${p.loyaltyPointsEarned?.toLocaleString()} pts`
                            : ''}
                        </span>
                      ) : null}
                      {p.refundStatus === 'refunded' ? (
                        <span className="loyalty-purchase-list-refund muted small">Refunded</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">No previous loyalty sales on file.</p>
              )}
            </div>
          ) : null}

          <div className="register-loyalty-actions loyalty-modal-actions">
            <button
              type="button"
              className="btn primary"
              disabled={busy || entryActive}
              onMouseDown={(e) => e.preventDefault()}
              onClick={onStartPhoneEntry}
            >
              {masked ? 'Change phone on display' : 'Enter phone on display'}
            </button>
            {entryActive ? (
              <button type="button" className="btn ghost" disabled={busy} onClick={onCancelPhoneEntry}>
                Cancel phone entry
              </button>
            ) : null}
            {masked ? (
              <>
                <button
                  type="button"
                  className={`btn ghost${pointsRedeem > 0 ? ' register-loyalty-redeem-btn--active' : ''}`}
                  disabled={busy}
                  onClick={onRedeemMax}
                >
                  {pointsRedeem > 0
                    ? `Redeem max (${pointsRedeem.toLocaleString()} pts)`
                    : 'Redeem max'}
                </button>
                <button type="button" className="btn ghost" disabled={busy} onClick={onClear}>
                  Clear loyalty
                </button>
              </>
            ) : null}
          </div>
        </div>
        <div className="open-tabs-header loyalty-modal-footer">
          <button type="button" className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
