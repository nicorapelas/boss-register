import { useCallback, useEffect, useRef, useState } from 'react'
import { useBadgeScanInputFocus } from '../auth/useBadgeScanInputFocus'
import {
  verifyManagerBadgeForOverride,
  verifyManagerFaceForOverride,
  type StockOverrideApprover,
} from '../register/managerStockOverrideVerify'
import { FaceLoginPanel } from './FaceLoginPanel'

export type StockOverrideModalRequest = {
  scope: 'offline' | 'online'
  productName: string
  available: number
  maxUnits: number
  managerScanRequired: boolean
}

type StockOverrideModalProps = {
  request: StockOverrideModalRequest | null
  /** Logged-in manager when self-approval is allowed. */
  selfApprover?: StockOverrideApprover | null
  onClose: () => void
  onApproved: (approver: StockOverrideApprover) => void
}

export function StockOverrideModal({ request, selfApprover, onClose, onApproved }: StockOverrideModalProps) {
  const badgeInputRef = useRef<HTMLInputElement>(null)
  const [badgeCode, setBadgeCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [faceOpen, setFaceOpen] = useState(false)
  const faceUiPointerRef = useRef(false)

  const open = request != null

  useEffect(() => {
    if (!open) {
      setBadgeCode('')
      setError(null)
      setBusy(false)
      setFaceOpen(false)
    }
  }, [open])

  useBadgeScanInputFocus(badgeInputRef, open && request?.managerScanRequired === true && !faceOpen && !busy, {
    pauseRefocus: () => faceUiPointerRef.current,
  })

  const approve = useCallback(
    (approver: StockOverrideApprover) => {
      onApproved(approver)
      setBadgeCode('')
      setError(null)
      setFaceOpen(false)
    },
    [onApproved],
  )

  const handleBadge = useCallback(
    async (code: string) => {
      const trimmed = code.trim()
      if (!trimmed || busy) return
      setBusy(true)
      setError(null)
      try {
        const approver = await verifyManagerBadgeForOverride(trimmed)
        approve(approver)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Manager verification failed')
        setBadgeCode('')
      } finally {
        setBusy(false)
        window.setTimeout(() => badgeInputRef.current?.focus(), 40)
      }
    },
    [approve, busy],
  )

  const handleFace = useCallback(
    async (embedding: number[]) => {
      if (busy) return
      setBusy(true)
      setError(null)
      try {
        const approver = await verifyManagerFaceForOverride(embedding)
        setFaceOpen(false)
        approve(approver)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Manager verification failed')
      } finally {
        setBusy(false)
      }
    },
    [approve, busy],
  )

  if (!open || !request) return null

  const scopeLabel = request.scope === 'offline' ? 'Offline' : 'Online'

  return (
    <div
      className="open-tabs-backdrop modal-backdrop--pos-top"
      role="dialog"
      aria-modal="true"
      aria-labelledby="stock-override-title"
      onMouseDown={(e) => {
        if (!busy && e.target === e.currentTarget) onClose()
      }}
    >
      <div className="open-tabs-dialog quotes-modal-dialog stock-override-modal" style={{ maxWidth: 'min(96vw, 28rem)' }}>
        <div className="open-tabs-header">
          <h2 id="stock-override-title">{scopeLabel} stock override</h2>
          <button type="button" className="btn ghost open-tabs-close" disabled={busy} onClick={onClose}>
            Close
          </button>
        </div>
        <div className="quotes-modal-body">
          <p>
            <strong>{request.productName}</strong> has insufficient stock.
          </p>
          <p className="muted" style={{ marginBottom: '0.5rem' }}>
            Available: {request.available}
          </p>
          <p className="muted">
            Manager can exceed stock by up to <strong>{request.maxUnits}</strong> units.
          </p>
          {request.managerScanRequired ? (
            <>
              <p className="stock-override-scan-hint">Scan manager badge to approve.</p>
              <input
                ref={badgeInputRef}
                type="text"
                className="auth-badge-scan-input stock-override-badge-input"
                autoComplete="off"
                aria-label="Scan manager badge to approve stock override"
                value={badgeCode}
                disabled={busy}
                onChange={(e) => setBadgeCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void handleBadge(e.currentTarget.value)
                  }
                }}
              />
              <div className="stock-override-modal-actions">
                <button
                  type="button"
                  className="btn ghost small"
                  disabled={busy}
                  onClick={() => {
                    setFaceOpen((v) => !v)
                    setError(null)
                  }}
                >
                  {faceOpen ? 'Hide manager face' : 'Manager face'}
                </button>
              </div>
              {faceOpen ? (
                <div
                  className="stock-override-face-wrap"
                  onPointerDown={() => {
                    faceUiPointerRef.current = true
                    window.setTimeout(() => {
                      faceUiPointerRef.current = false
                    }, 400)
                  }}
                >
                  <FaceLoginPanel
                    busy={busy}
                    onLogin={handleFace}
                    onUseBadge={() => setFaceOpen(false)}
                  />
                </div>
              ) : null}
            </>
          ) : (
            <p className="muted">Confirm to approve this override.</p>
          )}
          {error ? <p className="error stock-override-error">{error}</p> : null}
        </div>
        <div className="open-tabs-header stock-override-modal-footer">
          <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          {!request.managerScanRequired && selfApprover ? (
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => approve(selfApprover)}
            >
              Approve override
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
