import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../api/client'
import type { Sale, SaleRefundPreview } from '../api/types'
import { formatDateDdMmYyyy } from '../utils/dateFormat'
import { ScreenKeyboard, type ScreenKeyboardAction } from './ScreenKeyboard'

export type RefundSaleModalProps = {
  open: boolean
  onClose: () => void
  onRefunded: (sale?: Sale) => void | Promise<void>
  onPrintRefundReceipt?: (sale: Sale, note?: string, payoutMethod?: 'cash' | 'card') => void | Promise<void>
}

type CashierView = { email?: string; displayName?: string; role?: string }

function cashierLabel(c: string | CashierView | undefined): string {
  if (!c || typeof c === 'string') return typeof c === 'string' ? c : '—'
  const bits = [c.displayName, c.email].filter(Boolean)
  return bits.length ? bits.join(' · ') : '—'
}

export function RefundSaleModal({ open, onClose, onRefunded, onPrintRefundReceipt }: RefundSaleModalProps) {
  const [saleId, setSaleId] = useState('')
  const [note, setNote] = useState('')
  const [payoutMethod, setPayoutMethod] = useState<'cash' | 'card'>('cash')
  const [loading, setLoading] = useState(false)
  const [refunding, setRefunding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<Sale | null>(null)
  const [refundPreview, setRefundPreview] = useState<SaleRefundPreview['refund'] | null>(null)
  const [refundQtyByLine, setRefundQtyByLine] = useState<Record<number, string>>({})
  const [saleKbOpen, setSaleKbOpen] = useState(false)
  const [noteKbOpen, setNoteKbOpen] = useState(false)
  const noteInputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (!open || !noteKbOpen) return
    const t = window.setTimeout(() => {
      noteInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
    }, 40)
    return () => window.clearTimeout(t)
  }, [open, noteKbOpen])

  useEffect(() => {
    if (!open) {
      setSaleId('')
      setNote('')
      setPayoutMethod('cash')
      setError(null)
      setPreview(null)
      setRefundPreview(null)
      setRefundQtyByLine({})
      setLoading(false)
      setRefunding(false)
      setSaleKbOpen(false)
      setNoteKbOpen(false)
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
    setPreview(null)
    setRefundPreview(null)
    setRefundQtyByLine({})
    try {
      const data = await apiFetch<SaleRefundPreview>(`/sales/${encodeURIComponent(id)}/refund-preview`)
      const s = data.sale
      setPreview(s)
      setRefundPreview(data.refund)
      const byPm = (s.paymentMethod ?? '').toLowerCase()
      if (byPm.includes('card') && !byPm.includes('cash')) setPayoutMethod('card')
      else setPayoutMethod('cash')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load sale')
    } finally {
      setLoading(false)
    }
  }

  async function submitRefund() {
    const id = saleId.trim()
    if (!id || !preview || !refundPreview) return
    const lines = refundPreview.lines
      .map((l) => ({ lineIndex: l.index, quantity: Number(refundQtyByLine[l.index] ?? 0) }))
      .filter((l) => Number.isFinite(l.quantity) && l.quantity > 0.0001)
    if (!lines.length) {
      setError('Select at least one item quantity to refund')
      return
    }
    setRefunding(true)
    setError(null)
    try {
      const resp = await apiFetch<{ sale?: Sale }>(`/sales/${encodeURIComponent(id)}/refund`, {
        method: 'POST',
        body: JSON.stringify({ note: note.trim() || undefined, payoutMethod, lines }),
      })
      const refundedSale = resp.sale
      if (refundedSale && onPrintRefundReceipt) {
        try {
          await onPrintRefundReceipt(refundedSale, note.trim() || undefined, payoutMethod)
        } catch (e) {
          setError(
            e instanceof Error
              ? `Refund saved, but receipt printing failed: ${e.message}`
              : 'Refund saved, but receipt printing failed',
          )
          setPreview(refundedSale)
          return
        }
      }
      await onRefunded(refundedSale)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Refund failed')
    } finally {
      setRefunding(false)
    }
  }

  return (
    <div
      className="open-tabs-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="refund-sale-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="open-tabs-dialog quotes-modal-dialog" style={{ maxWidth: 'min(96vw, 28rem)' }}>
        <div className="open-tabs-header">
          <h2 id="refund-sale-title">Refund sale</h2>
          <button type="button" className="btn ghost open-tabs-close" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="quotes-modal-body">
          <p className="muted" style={{ marginBottom: '0.75rem' }}>
            Find the <strong>10-character sale id</strong> on the receipt or in Back Office (Sales / receipts). You can
            also paste the MongoDB <code>_id</code> if needed. Choose specific item quantities to return, then settle
            cash or card with the customer at the register.
          </p>
          <div className="quotes-modal-filters" style={{ flexWrap: 'wrap' }}>
            <input
              className="open-tabs-input"
              style={{ minWidth: '12rem', flex: '1 1 12rem' }}
              value={saleId}
              onChange={(e) => setSaleId(e.target.value)}
              onFocus={() => {
                setSaleKbOpen(true)
                setNoteKbOpen(false)
              }}
              onBlur={() => {
                window.setTimeout(() => setSaleKbOpen(false), 180)
              }}
              placeholder="10-char sale id or MongoDB _id"
              aria-label="Sale id"
            />
            <button type="button" className="btn small" disabled={loading} onClick={() => void loadPreview()}>
              {loading ? '…' : 'Load'}
            </button>
          </div>
          {error && <p className="error open-tabs-form-error">{error}</p>}

          {preview && (
            <div
              className="layby-detail-block"
              style={{ marginTop: '0.75rem', textAlign: 'left' as const }}
            >
              {preview.refundStatus === 'refunded' && (
                <p className="error" style={{ marginBottom: '0.5rem' }}>
                  This sale is already marked refunded in the system.
                </p>
              )}
              <p>
                <strong>Total</strong> R {preview.total.toFixed(2)}
              </p>
              {preview.createdAt && (
                <p className="muted small">
                  {formatDateDdMmYyyy(preview.createdAt)} · {cashierLabel(preview.cashier as string | CashierView)}
                </p>
              )}
              {preview.paymentMethod && (
                <p className="muted small">
                  Payment: {preview.paymentMethod}
                  {preview.storeCreditAmount != null && preview.storeCreditAmount > 0.005
                    ? ` · Store credit R ${preview.storeCreditAmount.toFixed(2)}`
                    : ''}
                  {preview.onAccountAmount != null && preview.onAccountAmount > 0.005
                    ? ` · On account R ${preview.onAccountAmount.toFixed(2)}${
                        preview.houseAccountNumber ? ` (${preview.houseAccountNumber})` : ''
                      }`
                    : ''}
                </p>
              )}
              {refundPreview ? (
                <p className="muted small" style={{ marginTop: '0.5rem' }}>
                  Refunded so far: R {refundPreview.refundedTotal.toFixed(2)} · Remaining: R{' '}
                  {refundPreview.remainingTotal.toFixed(2)}
                </p>
              ) : null}
              <ul className="muted small" style={{ margin: '0.5rem 0 0', paddingLeft: '1.1rem' }}>
                {preview.items.map((l, i) => {
                  const progress = refundPreview?.lines.find((x) => x.index === i)
                  const remaining = progress?.remainingQty ?? l.quantity
                  const entered = refundQtyByLine[i] ?? ''
                  return (
                  <li key={i}>
                    {l.name} × {l.quantity} @ R {l.unitPrice.toFixed(2)}
                    <div style={{ display: 'flex', gap: '0.35rem', marginTop: '0.25rem', alignItems: 'center' }}>
                      <span style={{ minWidth: '6rem' }}>Remaining {remaining.toFixed(2)}</span>
                      <input
                        className="open-tabs-input"
                        type="number"
                        min={0}
                        step="0.01"
                        max={remaining}
                        value={entered}
                        onChange={(e) =>
                          setRefundQtyByLine((prev) => ({
                            ...prev,
                            [i]: e.target.value,
                          }))
                        }
                        style={{ width: '6.5rem' }}
                        placeholder="Qty"
                      />
                    </div>
                  </li>
                  )
                })}
              </ul>
              <label className="block" style={{ marginTop: '0.75rem' }}>
                <span className="muted small">Refund payout method</span>
                <select
                  className="open-tabs-input"
                  value={payoutMethod}
                  onChange={(e) => setPayoutMethod(e.target.value === 'card' ? 'card' : 'cash')}
                  style={{ width: '100%', marginTop: '0.25rem' }}
                >
                  <option value="cash">Cash</option>
                  <option value="card">Card</option>
                </select>
              </label>
              <label className="block" style={{ marginTop: '0.75rem' }}>
                <span className="muted small">Note (optional, audit)</span>
                <textarea
                  ref={noteInputRef}
                  className="open-tabs-input"
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  onFocus={() => {
                    setNoteKbOpen(true)
                    setSaleKbOpen(false)
                    window.setTimeout(() => {
                      noteInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
                    }, 20)
                  }}
                  onBlur={() => {
                    window.setTimeout(() => setNoteKbOpen(false), 180)
                  }}
                  placeholder="Reason or reference"
                  style={{ width: '100%', marginTop: '0.25rem', resize: 'vertical' as const }}
                />
              </label>
              <button
                type="button"
                className="btn key-btn-primary"
                style={{ marginTop: '0.75rem', width: '100%' }}
                disabled={refunding || preview.refundStatus === 'refunded' || (refundPreview?.remainingTotal ?? 0) <= 0.005}
                onClick={() => void submitRefund()}
              >
                {refunding ? 'Refunding…' : 'Refund selected items'}
              </button>
            </div>
          )}
        </div>
        <div className="voucher-kb-dock" style={{ padding: '0 0.5rem 0.5rem' }}>
          <ScreenKeyboard
            visible={saleKbOpen || noteKbOpen}
            layout="full"
            onAction={(a: ScreenKeyboardAction) => {
              const target: 'saleId' | 'note' = noteKbOpen ? 'note' : 'saleId'
              if (a.type === 'backspace') {
                if (target === 'saleId') setSaleId((s) => s.slice(0, -1))
                else setNote((s) => s.slice(0, -1))
              } else if (a.type === 'char') {
                if (target === 'saleId') setSaleId((s) => s + a.char)
                else setNote((s) => s + a.char)
              } else if (a.type === 'space') {
                if (target === 'note') setNote((s) => s + ' ')
              } else if (a.type === 'enter') {
                if (target === 'saleId') void loadPreview()
                else setNote((s) => `${s}\n`)
              } else if (a.type === 'done') {
                if (target === 'saleId') setSaleKbOpen(false)
                else setNoteKbOpen(false)
              }
            }}
          />
        </div>
      </div>
    </div>
  )
}
