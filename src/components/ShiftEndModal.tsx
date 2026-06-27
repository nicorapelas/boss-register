import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../api/client'
import type { ShiftCloseStartNextResponse, ShiftReport, ShiftSummary } from '../api/types'
import { formatDateDdMmYyyy } from '../utils/dateFormat'

type Props = {
  open: boolean
  tillCode: string
  onClose: () => void
  onPrintReport: (report: ShiftReport) => Promise<void> | void
}

type ShiftEndedSummary = {
  tillCode: string
  zNumber?: number | null
  openedAt: string
  closedAt: string
  summary: ShiftSummary
}

function formatMoney(amount: number): string {
  return amount.toFixed(2)
}

function formatTimeHm(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function shiftSalesCount(summary: ShiftSummary): number {
  return summary.cashierSales.reduce((total, row) => total + row.salesCount, 0)
}

function shiftDurationLabel(openedAt: string, closedAt: string): string {
  const ms = new Date(closedAt).getTime() - new Date(openedAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return ''
  const totalMin = Math.floor(ms / 60_000)
  const hours = Math.floor(totalMin / 60)
  const minutes = totalMin % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function ShiftEndedConfirmation({
  ended,
  onDismiss,
}: {
  ended: ShiftEndedSummary
  onDismiss: () => void
}) {
  const s = ended.summary
  const salesCount = shiftSalesCount(s)
  const duration = shiftDurationLabel(ended.openedAt, ended.closedAt)
  const zLabel = ended.zNumber != null ? ` · Z${ended.zNumber}` : ''

  return (
    <div className="open-tabs-backdrop" role="dialog" aria-modal="true" aria-labelledby="shift-ended-title">
      <div className="open-tabs-dialog quotes-modal-dialog shift-ended-dialog" style={{ maxWidth: 'min(96vw, 34rem)' }}>
        <div className="shift-ended-header">
          <h2 id="shift-ended-title">Shift Ended</h2>
          <p className="muted shift-ended-subtitle">
            Till <strong>{ended.tillCode}</strong>
            {zLabel}
            {' · '}
            {formatDateDdMmYyyy(ended.closedAt)}
          </p>
        </div>
        <div className="quotes-modal-body shift-ended-body">
          <p className="shift-ended-turnover" aria-label={`Turnover ${formatMoney(s.turnover)}`}>
            R {formatMoney(s.turnover)}
          </p>
          <p className="muted small shift-ended-turnover-label">Turnover</p>

          <div className="shift-ended-stats" role="list">
            <div className="shift-ended-stat" role="listitem">
              <span className="shift-ended-stat-value">{salesCount}</span>
              <span className="shift-ended-stat-label">Sales</span>
            </div>
            <div className="shift-ended-stat" role="listitem">
              <span className="shift-ended-stat-value">R {formatMoney(s.cashSales)}</span>
              <span className="shift-ended-stat-label">Cash</span>
            </div>
            <div className="shift-ended-stat" role="listitem">
              <span className="shift-ended-stat-value">R {formatMoney(s.cardSales)}</span>
              <span className="shift-ended-stat-label">Card</span>
            </div>
            <div className="shift-ended-stat" role="listitem">
              <span className="shift-ended-stat-value">{s.refundCount}</span>
              <span className="shift-ended-stat-label">Refunds</span>
            </div>
          </div>

          {(s.voucherTotal > 0.005 ||
            s.onAccountTotal > 0.005 ||
            s.layByCompletions > 0 ||
            s.quoteConversions > 0 ||
            s.tabClosures > 0) && (
            <p className="muted small shift-ended-extra">
              {s.voucherTotal > 0.005 ? `Voucher R ${formatMoney(s.voucherTotal)}` : null}
              {s.onAccountTotal > 0.005 ? ` · On account R ${formatMoney(s.onAccountTotal)}` : null}
              {s.layByCompletions > 0 ? ` · Lay-bys ${s.layByCompletions}` : null}
              {s.quoteConversions > 0 ? ` · Quotes ${s.quoteConversions}` : null}
              {s.tabClosures > 0 ? ` · Tabs ${s.tabClosures}` : null}
            </p>
          )}

          {s.refundCount > 0 ? (
            <p className="muted small shift-ended-extra">
              Refund total R {formatMoney(s.refundTotal)}
              {s.refundCashTotal > 0.005 || s.refundCardTotal > 0.005
                ? ` (cash R ${formatMoney(s.refundCashTotal)} · card R ${formatMoney(s.refundCardTotal)})`
                : null}
            </p>
          ) : null}

          <p className="muted small shift-ended-timing">
            {formatTimeHm(ended.openedAt)} – {formatTimeHm(ended.closedAt)}
            {duration ? ` · ${duration}` : ''}
          </p>

          <p className="muted small shift-ended-next">Next shift is now open on this till.</p>

          <div className="shift-ended-actions">
            <button type="button" className="btn primary" onClick={onDismiss}>
              Continue
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function ShiftEndModal({ open, tillCode, onClose, onPrintReport }: Props) {
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<ShiftReport | null>(null)
  const [ended, setEnded] = useState<ShiftEndedSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [diffOpen, setDiffOpen] = useState(false)
  const [kind, setKind] = useState<'over' | 'under'>('over')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const onPrintReportRef = useRef(onPrintReport)
  onPrintReportRef.current = onPrintReport
  /** One fetch + print per dialog open (survives StrictMode re-run and parent re-renders). */
  const loadStartedRef = useRef(false)

  useEffect(() => {
    if (!open) {
      loadStartedRef.current = false
      setEnded(null)
      return
    }
    if (loadStartedRef.current) return
    loadStartedRef.current = true

    setDiffOpen(false)
    setKind('over')
    setAmount('')
    setNote('')
    setError(null)
    setEnded(null)
    setReport(null)
    setBusy(true)
    void apiFetch<ShiftReport>('/shifts/z-report', {
      method: 'POST',
      body: JSON.stringify({ tillCode }),
    })
      .then(async (r) => {
        setReport(r)
        await onPrintReportRef.current(r)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load shift report'))
      .finally(() => setBusy(false))
  }, [open, tillCode])

  if (!open) return null

  if (ended) {
    return (
      <ShiftEndedConfirmation
        ended={ended}
        onDismiss={() => {
          setEnded(null)
          onClose()
        }}
      />
    )
  }

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
      const result = await apiFetch<ShiftCloseStartNextResponse>(
        `/shifts/${report.shiftId}/close-start-next`,
        { method: 'POST', body: '{}' },
      )
      const closed = result.closedShift
      setEnded({
        tillCode: closed.tillCode,
        zNumber: closed.zNumber,
        openedAt: closed.openedAt,
        closedAt: closed.closedAt,
        summary: closed.summary ?? report.summary,
      })
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
            <button type="button" className="btn primary" disabled={busy || !report} onClick={() => void closeAndStartNext()}>
              {busy ? 'Closing…' : 'Close Shift & Start Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
