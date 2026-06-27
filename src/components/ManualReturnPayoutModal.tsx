import { useEffect, useRef, useState } from 'react'
import { ScreenKeyboard, type ScreenKeyboardAction } from './ScreenKeyboard'

export type ManualReturnPayoutModalProps = {
  open: boolean
  busy: boolean
  returnTotal: number
  note: string
  creditPhone: string
  onNoteChange: (value: string) => void
  onCreditPhoneChange: (value: string) => void
  onClose: () => void
  onSubmit: (method: 'cash' | 'card' | 'store_credit') => void
}

export function ManualReturnPayoutModal({
  open,
  busy,
  returnTotal,
  note,
  creditPhone,
  onNoteChange,
  onCreditPhoneChange,
  onClose,
  onSubmit,
}: ManualReturnPayoutModalProps) {
  const [kbOpen, setKbOpen] = useState(false)
  const [kbTarget, setKbTarget] = useState<'note' | 'phone'>('note')
  const noteRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (!open) {
      setKbOpen(false)
      setKbTarget('note')
    }
  }, [open])

  useEffect(() => {
    if (!open || !kbOpen) return
    const t = window.setTimeout(() => {
      noteRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 40)
    return () => window.clearTimeout(t)
  }, [open, kbOpen, kbTarget])

  if (!open) return null

  const noteOk = note.trim().length >= 3

  function handleKeyboardAction(action: ScreenKeyboardAction) {
    if (action.type === 'done') {
      setKbOpen(false)
      return
    }
    if (kbTarget === 'note') {
      if (action.type === 'char') onNoteChange(note + action.char)
      else if (action.type === 'backspace') onNoteChange(note.slice(0, -1))
      else if (action.type === 'space') onNoteChange(`${note} `)
      else if (action.type === 'enter') setKbOpen(false)
    } else {
      if (action.type === 'char' && /\d/.test(action.char)) onCreditPhoneChange(creditPhone + action.char)
      else if (action.type === 'backspace') onCreditPhoneChange(creditPhone.slice(0, -1))
      else if (action.type === 'enter') setKbOpen(false)
    }
  }

  return (
    <div
      className="open-tabs-backdrop refund-payout-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="manual-return-payout-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div className="open-tabs-dialog refund-payout-dialog">
        <div className="open-tabs-header">
          <h2 id="manual-return-payout-title">Complete manual return</h2>
          <button type="button" className="btn ghost open-tabs-close" disabled={busy} onClick={onClose}>
            Back
          </button>
        </div>
        <div className={`quotes-modal-body${kbOpen ? ' quotes-modal-body--with-keyboard' : ''}`}>
          <p className="refund-payout-total-line">
            Returning <strong>R {returnTotal.toFixed(2)}</strong>
            <span className="muted small register-manual-return-sub">
              {' '}
              · no original sale record
            </span>
          </p>
          <label className="register-refund-note-field">
            <span className="muted small">Reason / note (required)</span>
            <textarea
              ref={noteRef}
              className="register-refund-note-input"
              rows={2}
              value={note}
              disabled={busy}
              placeholder="e.g. Vector POS sale ~12 Jun, customer has no receipt"
              inputMode={kbOpen && kbTarget === 'note' ? 'none' : 'text'}
              onChange={(e) => onNoteChange(e.target.value)}
              onFocus={() => {
                setKbTarget('note')
                setKbOpen(true)
              }}
            />
          </label>
          {!noteOk ? (
            <p className="error small register-manual-return-note-hint">
              Enter at least 3 characters explaining this return.
            </p>
          ) : null}
          <div className="refund-payout-actions">
            <button
              type="button"
              className="btn checkout-btn cash-checkout-btn"
              disabled={busy || !noteOk}
              onClick={() => onSubmit('cash')}
            >
              {busy ? 'Processing…' : 'Return cash'}
            </button>
            <button
              type="button"
              className="btn checkout-btn card-checkout-btn"
              disabled={busy || !noteOk}
              onClick={() => onSubmit('card')}
            >
              {busy ? 'Processing…' : 'Return card'}
            </button>
          </div>
          <div className="refund-payout-voucher-block">
            <label className="register-refund-note-field">
              <span className="muted small">Phone for store credit (digits)</span>
              <input
                className="register-refund-note-input"
                type="tel"
                inputMode={kbOpen && kbTarget === 'phone' ? 'none' : 'numeric'}
                autoComplete="tel"
                value={creditPhone}
                disabled={busy}
                placeholder="Required for store credit only"
                onChange={(e) => onCreditPhoneChange(e.target.value)}
                onFocus={() => {
                  setKbTarget('phone')
                  setKbOpen(true)
                }}
              />
            </label>
            <p className="muted small register-refund-credit-hint">
              Credits the return amount as store credit on the customer voucher account.
            </p>
            <button
              type="button"
              className="btn checkout-btn storecredit-checkout-btn refund-payout-voucher-btn"
              disabled={busy || !noteOk}
              onClick={() => onSubmit('store_credit')}
            >
              {busy ? 'Processing…' : 'Issue store credit'}
            </button>
          </div>
          <ScreenKeyboard
            visible={kbOpen}
            layout={kbTarget === 'phone' ? 'numeric' : 'full'}
            onAction={handleKeyboardAction}
            className="open-tabs-screen-keyboard register-refund-cart-screen-kb"
          />
        </div>
      </div>
    </div>
  )
}
