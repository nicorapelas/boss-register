import { useEffect, useState } from 'react'
import { apiFetch } from '../api/client'
import type { ShiftReport } from '../api/types'

type Props = {
  open: boolean
  tillCode: string
  onClose: () => void
  onPrintReport: (report: ShiftReport) => Promise<void> | void
}

export function ShiftEndModal({ open, tillCode, onClose, onPrintReport }: Props) {
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<ShiftReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [diffOpen, setDiffOpen] = useState(false)
  const [kind, setKind] = useState<'over' | 'under'>('over')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    if (!open) return
    setDiffOpen(false)
    setKind('over')
    setAmount('')
    setNote('')
    setError(null)
    setBusy(true)
    void apiFetch<ShiftReport>('/shifts/z-report', {
      method: 'POST',
      body: JSON.stringify({ tillCode }),
    })
      .then(async (r) => {
        setReport(r)
        await onPrintReport(r)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load shift report'))
      .finally(() => setBusy(false))
  }, [open, tillCode, onPrintReport])

  if (!open) return null

  async function submitDifference() {
    if (!report) return
    const val = Number(amount)
    if (!Number.isFinite(val) || val <= 0) {
      setError('Enter a valid amount')
      return
    }
    if (!note.trim()) {
      setError('Reason note required')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await apiFetch(`/shifts/${report.shiftId}/differences`, {
        method: 'POST',
        body: JSON.stringify({ kind, amount: val, note, source: 'pos' }),
      })
      const refreshed = await apiFetch<ShiftReport>('/shifts/z-report', {
        method: 'POST',
        body: JSON.stringify({ tillCode }),
      })
      setReport(refreshed)
      setDiffOpen(false)
      setAmount('')
      setNote('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save difference')
    } finally {
      setBusy(false)
    }
  }

  async function closeAndStartNext() {
    if (!report) return
    setBusy(true)
    setError(null)
    try {
      await apiFetch(`/shifts/${report.shiftId}/close-start-next`, { method: 'POST', body: '{}' })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to close shift')
    } finally {
      setBusy(false)
    }
  }

  const s = report?.summary

  return (
    <div className="open-tabs-backdrop" role="dialog" aria-modal="true" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="open-tabs-dialog quotes-modal-dialog" style={{ maxWidth: 'min(96vw, 34rem)' }}>
        <div className="open-tabs-header">
          <h2>Shift end / Z-clear</h2>
          <button type="button" className="btn ghost open-tabs-close" onClick={onClose}>Close</button>
        </div>
        <div className="quotes-modal-body">
          <p className="muted">Till <strong>{tillCode}</strong>. Shift report is printed when this dialog opens.</p>
          {error && <p className="error">{error}</p>}
          {busy && !report ? <p className="muted">Loading…</p> : null}
          {s ? (
            <div className="layby-detail-block" style={{ textAlign: 'left' }}>
              <p><strong>Turnover:</strong> {s.turnover.toFixed(2)}</p>
              <p className="muted small">Cash {s.cashSales.toFixed(2)} · Card {s.cardSales.toFixed(2)} · Voucher {s.voucherTotal.toFixed(2)} · Accounts {s.onAccountTotal.toFixed(2)}</p>
              <p className="muted small">Lay-bys {s.layByCompletions} · Quotes {s.quoteConversions} · Tabs {s.tabClosures}</p>
              <p className="muted small">Refunds {s.refundCount} · Cash {s.refundCashTotal.toFixed(2)} · Card {s.refundCardTotal.toFixed(2)} · Total {s.refundTotal.toFixed(2)}</p>
              <p className="muted small">Cashier sales: {s.cashierSales.map((x) => `${x.cashierName || x.cashierId.slice(-6)} (${x.salesCount})`).join(', ') || 'none'}</p>
            </div>
          ) : null}
          {diffOpen && (
            <div className="layby-detail-block" style={{ marginTop: '0.65rem', textAlign: 'left' }}>
              <label>Difference type
                <select value={kind} onChange={(e) => setKind(e.target.value as 'over' | 'under')}>
                  <option value="over">Over</option>
                  <option value="under">Under</option>
                </select>
              </label>
              <label>Amount
                <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
              </label>
              <label>Reason
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Explain difference" />
              </label>
              <button type="button" className="btn" disabled={busy} onClick={() => void submitDifference()}>Save Difference</button>
            </div>
          )}
          <div style={{ display: 'flex', gap: '0.6rem', marginTop: '0.8rem', flexWrap: 'wrap' }}>
            <button type="button" className="btn ghost" onClick={onClose}>Continue Shift</button>
            <button type="button" className="btn ghost" onClick={() => setDiffOpen((v) => !v)}>Cash Difference</button>
            <button type="button" className="btn primary" disabled={busy || !report} onClick={() => void closeAndStartNext()}>Close Shift & Start Next</button>
          </div>
        </div>
      </div>
    </div>
  )
}
