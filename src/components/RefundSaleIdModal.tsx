import { useEffect, useState } from 'react'
import { apiFetch } from '../api/client'
import type { SaleRefundPreview } from '../api/types'
import { ScreenKeyboard, type ScreenKeyboardAction } from './ScreenKeyboard'

export type RefundSaleIdModalProps = {
  open: boolean
  onClose: () => void
  /** Called after a successful refund-preview load; parent enters refund cart mode. */
  onSaleLoaded: (data: SaleRefundPreview, enteredSaleId: string) => void
}

export function RefundSaleIdModal({ open, onClose, onSaleLoaded }: RefundSaleIdModalProps) {
  const [saleId, setSaleId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saleKbOpen, setSaleKbOpen] = useState(false)

  useEffect(() => {
    if (!open) {
      setSaleId('')
      setError(null)
      setLoading(false)
      setSaleKbOpen(false)
    }
  }, [open])

  if (!open) return null

  async function loadPreview() {
    const id = saleId.trim()
    if (!id) {
      setError('Enter the sale id from the receipt or system')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<SaleRefundPreview>(`/sales/${encodeURIComponent(id)}/refund-preview`)
      onSaleLoaded(data, id)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load sale')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="open-tabs-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="refund-sale-id-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="open-tabs-dialog quotes-modal-dialog" style={{ maxWidth: 'min(96vw, 28rem)' }}>
        <div className="open-tabs-header">
          <h2 id="refund-sale-id-title">Refund — sale id</h2>
          <button type="button" className="btn ghost open-tabs-close" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="quotes-modal-body">
          <p className="muted" style={{ marginBottom: '0.75rem' }}>
            Enter the <strong>10-character sale id</strong> from the receipt or Back Office, or paste the MongoDB{' '}
            <code>_id</code>. The register will switch to refund mode and load refundable lines into the cart.
          </p>
          <div className="quotes-modal-filters" style={{ flexWrap: 'wrap' }}>
            <input
              className="open-tabs-input"
              style={{ minWidth: '12rem', flex: '1 1 12rem' }}
              value={saleId}
              onChange={(e) => setSaleId(e.target.value)}
              onFocus={() => setSaleKbOpen(true)}
              onBlur={() => {
                window.setTimeout(() => setSaleKbOpen(false), 180)
              }}
              placeholder="10-char sale id or MongoDB _id"
              aria-label="Sale id"
            />
            <button type="button" className="btn small" disabled={loading} onClick={() => void loadPreview()}>
              {loading ? '…' : 'Load sale'}
            </button>
          </div>
          {error && <p className="error open-tabs-form-error">{error}</p>}
        </div>
        <div className="voucher-kb-dock" style={{ padding: '0 0.5rem 0.5rem' }}>
          <ScreenKeyboard
            visible={saleKbOpen}
            layout="full"
            onAction={(a: ScreenKeyboardAction) => {
              if (a.type === 'backspace') setSaleId((s) => s.slice(0, -1))
              else if (a.type === 'char') setSaleId((s) => s + a.char)
              else if (a.type === 'enter') void loadPreview()
              else if (a.type === 'done') setSaleKbOpen(false)
            }}
          />
        </div>
      </div>
    </div>
  )
}
