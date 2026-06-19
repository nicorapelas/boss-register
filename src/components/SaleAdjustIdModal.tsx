import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../api/client'
import type {
  SaleAdjustmentLookupResponse,
  SaleAdjustmentLookupRow,
  SaleExchangePreview,
  SaleRefundPreview,
} from '../api/types'
import { resolveSyncedSaleLookupId } from '../offline/offlineSalesQueue'
import { verifyManagerBadgeForOverride } from '../register/managerStockOverrideVerify'
import { formatDateDdMmYyyy } from '../utils/dateFormat'
import { ScreenKeyboard, type ScreenKeyboardAction } from './ScreenKeyboard'

export type SaleAdjustMode = 'refund' | 'exchange'

export type SaleAdjustIdModalProps = {
  mode: SaleAdjustMode
  open: boolean
  onClose: () => void
  onRefundLoaded?: (data: SaleRefundPreview, enteredSaleId: string) => void
  onExchangeLoaded?: (data: SaleExchangePreview, enteredSaleId: string) => void
  /** Admin / manager — open sale browser without manager scan. */
  canBrowseSalesDirectly: boolean
  tillCode?: string
}

type View = 'id' | 'manager-verify' | 'lookup'
type LookupRange = 'today' | '7d' | '14d'

function lookupQueryString(q: string, range: LookupRange, tillCode: string): string {
  const sp = new URLSearchParams()
  const now = new Date()
  const to = new Date(now)
  to.setHours(23, 59, 59, 999)
  const from = new Date(now)
  from.setHours(0, 0, 0, 0)
  if (range === '7d') from.setDate(from.getDate() - 6)
  if (range === '14d') from.setDate(from.getDate() - 13)
  sp.set('from', from.toISOString())
  sp.set('to', to.toISOString())
  if (q.trim()) sp.set('q', q.trim())
  if (tillCode.trim()) sp.set('tillCode', tillCode.trim().toUpperCase())
  sp.set('limit', '30')
  return sp.toString()
}

function saleRowLabel(s: SaleAdjustmentLookupRow): string {
  const id = s.saleId ?? s._id.slice(-10)
  const when = s.createdAt ? formatDateDdMmYyyy(s.createdAt) : '—'
  const items = s.items
    .slice(0, 2)
    .map((it) => `${it.quantity}× ${it.name}`)
    .join(', ')
  const more = s.items.length > 2 ? ` +${s.items.length - 2}` : ''
  return `${id} · ${when} · R ${Number(s.total ?? 0).toFixed(2)}${s.tillCode ? ` · ${s.tillCode}` : ''}${items ? ` · ${items}${more}` : ''}`
}

export function SaleAdjustIdModal({
  mode,
  open,
  onClose,
  onRefundLoaded,
  onExchangeLoaded,
  canBrowseSalesDirectly,
  tillCode = '',
}: SaleAdjustIdModalProps) {
  const [view, setView] = useState<View>('id')
  const [saleId, setSaleId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saleKbOpen, setSaleKbOpen] = useState(false)
  const [lookupKbOpen, setLookupKbOpen] = useState(false)
  const [lookupQ, setLookupQ] = useState('')
  const [lookupRange, setLookupRange] = useState<LookupRange>('7d')
  const [lookupThisTillOnly, setLookupThisTillOnly] = useState(true)
  const [lookupRows, setLookupRows] = useState<SaleAdjustmentLookupRow[]>([])
  const [lookupBusy, setLookupBusy] = useState(false)
  const [managerBadge, setManagerBadge] = useState('')
  const [managerBusy, setManagerBusy] = useState(false)
  const saleIdInputRef = useRef<HTMLInputElement>(null)
  const lookupQInputRef = useRef<HTMLInputElement>(null)
  const managerBadgeRef = useRef<HTMLInputElement>(null)
  const lookupKbBlurTimerRef = useRef<number | null>(null)

  const title = mode === 'refund' ? 'Refund — sale id' : 'Exchange — sale id'
  const previewPath = mode === 'refund' ? 'refund-preview' : 'exchange-preview'

  useEffect(() => {
    return () => {
      if (lookupKbBlurTimerRef.current) clearTimeout(lookupKbBlurTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!open) {
      setView('id')
      setSaleId('')
      setError(null)
      setLoading(false)
      setSaleKbOpen(false)
      setLookupKbOpen(false)
      setLookupQ('')
      setLookupRange('7d')
      setLookupThisTillOnly(true)
      setLookupRows([])
      setLookupBusy(false)
      setManagerBadge('')
      setManagerBusy(false)
      if (lookupKbBlurTimerRef.current) {
        clearTimeout(lookupKbBlurTimerRef.current)
        lookupKbBlurTimerRef.current = null
      }
      return
    }
    const id = window.requestAnimationFrame(() => saleIdInputRef.current?.focus())
    return () => window.cancelAnimationFrame(id)
  }, [open])

  useEffect(() => {
    if (!open || view !== 'lookup') {
      setLookupKbOpen(false)
      return
    }
    const t = window.setTimeout(() => {
      lookupQInputRef.current?.focus()
      setLookupKbOpen(true)
    }, 40)
    return () => window.clearTimeout(t)
  }, [open, view])

  useEffect(() => {
    if (!open || view !== 'lookup' || !lookupKbOpen) return
    const t = window.setTimeout(() => {
      lookupQInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
    }, 40)
    return () => window.clearTimeout(t)
  }, [open, view, lookupKbOpen])

  useEffect(() => {
    if (!open || view !== 'lookup') return
    void loadLookup()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, view])

  const loadPreviewForId = useCallback(
    async (rawId: string) => {
      const id = rawId.trim()
      if (!id) {
        setError('Enter the sale id from the receipt or system')
        return
      }
      setLoading(true)
      setError(null)
      try {
        const lookupId = resolveSyncedSaleLookupId(id)
        if (mode === 'refund') {
          const data = await apiFetch<SaleRefundPreview>(
            `/sales/${encodeURIComponent(lookupId)}/${previewPath}`,
          )
          onRefundLoaded?.(data, lookupId)
        } else {
          const data = await apiFetch<SaleExchangePreview>(
            `/sales/${encodeURIComponent(lookupId)}/${previewPath}`,
          )
          onExchangeLoaded?.(data, lookupId)
        }
        onClose()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load sale')
      } finally {
        setLoading(false)
      }
    },
    [mode, onClose, onExchangeLoaded, onRefundLoaded, previewPath],
  )

  async function loadLookup() {
    setLookupBusy(true)
    setError(null)
    try {
      const qs = lookupQueryString(
        lookupQ,
        lookupRange,
        lookupThisTillOnly ? tillCode : '',
      )
      const data = await apiFetch<SaleAdjustmentLookupResponse>(`/sales/adjustment-lookup?${qs}`)
      setLookupRows(data.sales ?? [])
    } catch (e) {
      setLookupRows([])
      setError(e instanceof Error ? e.message : 'Failed to search sales')
    } finally {
      setLookupBusy(false)
    }
  }

  async function pickSale(row: SaleAdjustmentLookupRow) {
    const id = row.saleId ?? row._id
    await loadPreviewForId(id)
  }

  function openLookupFlow() {
    setError(null)
    if (canBrowseSalesDirectly) {
      setView('lookup')
      return
    }
    setView('manager-verify')
    window.setTimeout(() => managerBadgeRef.current?.focus(), 40)
  }

  async function submitManagerVerify() {
    const code = managerBadge.trim()
    if (!code) {
      setError('Scan or enter manager badge')
      return
    }
    setManagerBusy(true)
    setError(null)
    try {
      await verifyManagerBadgeForOverride(code)
      setManagerBadge('')
      setView('lookup')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Manager verification failed')
      setManagerBadge('')
    } finally {
      setManagerBusy(false)
      window.setTimeout(() => managerBadgeRef.current?.focus(), 40)
    }
  }

  function cancelLookupKbBlurHide() {
    if (lookupKbBlurTimerRef.current) {
      clearTimeout(lookupKbBlurTimerRef.current)
      lookupKbBlurTimerRef.current = null
    }
  }

  function lookupSearchKbHandlers() {
    return {
      onFocus: () => {
        cancelLookupKbBlurHide()
        setLookupKbOpen(true)
        window.setTimeout(() => {
          lookupQInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
        }, 20)
      },
      onBlur: () => {
        cancelLookupKbBlurHide()
        lookupKbBlurTimerRef.current = window.setTimeout(() => {
          setLookupKbOpen(false)
        }, 200)
      },
    }
  }

  function handleScreenKeyboardAction(action: ScreenKeyboardAction) {
    if (view === 'lookup') {
      if (action.type === 'char') {
        setLookupQ((s) => s + action.char)
        return
      }
      if (action.type === 'backspace') {
        setLookupQ((s) => s.slice(0, -1))
        return
      }
      if (action.type === 'space') {
        setLookupQ((s) => s + ' ')
        return
      }
      if (action.type === 'enter') {
        void loadLookup()
        return
      }
      if (action.type === 'done') {
        setLookupKbOpen(false)
      }
      return
    }
    if (action.type === 'backspace') setSaleId((s) => s.slice(0, -1))
    else if (action.type === 'char') setSaleId((s) => s + action.char)
    else if (action.type === 'space') setSaleId((s) => s + ' ')
    else if (action.type === 'enter') void loadPreviewForId(saleId)
    else if (action.type === 'done') setSaleKbOpen(false)
  }

  const screenKbOpen = view === 'lookup' ? lookupKbOpen : view === 'id' ? saleKbOpen : false

  if (!open) return null

  return (
    <div
      className="open-tabs-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sale-adjust-id-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="open-tabs-dialog quotes-modal-dialog"
        style={{ maxWidth: view === 'lookup' ? 'min(96vw, 42rem)' : 'min(96vw, 28rem)' }}
      >
        <div className="open-tabs-header">
          <h2 id="sale-adjust-id-title">{title}</h2>
          <button type="button" className="btn ghost open-tabs-close" onClick={onClose}>
            Close
          </button>
        </div>
        <div
          className={
            screenKbOpen ? 'quotes-modal-body quotes-modal-body--with-keyboard' : 'quotes-modal-body'
          }
        >
          {view === 'id' ? (
            <>
              <p className="muted" style={{ marginBottom: '0.75rem' }}>
                Enter the <strong>10-character sale id</strong> from the receipt or Back Office, or paste the MongoDB{' '}
                <code>_id</code>.
                {mode === 'exchange'
                  ? ' Return lines load into the cart — add replacements, then settle.'
                  : ' The register switches to refund mode with refundable lines in the cart.'}
              </p>
              <div className="quotes-modal-filters" style={{ flexWrap: 'wrap' }}>
                <input
                  ref={saleIdInputRef}
                  className="open-tabs-input"
                  style={{ minWidth: '12rem', flex: '1 1 12rem' }}
                  value={saleId}
                  autoFocus
                  inputMode={saleKbOpen ? 'none' : 'text'}
                  onChange={(e) => setSaleId(e.target.value)}
                  onFocus={() => setSaleKbOpen(true)}
                  onBlur={() => {
                    window.setTimeout(() => setSaleKbOpen(false), 180)
                  }}
                  placeholder="10-char sale id or MongoDB _id"
                  aria-label="Sale id"
                />
                <button
                  type="button"
                  className="btn small"
                  disabled={loading}
                  onClick={() => void loadPreviewForId(saleId)}
                >
                  {loading ? '…' : 'Load sale'}
                </button>
              </div>
              <button
                type="button"
                className="btn ghost small"
                style={{ marginTop: '0.75rem' }}
                disabled={loading}
                onClick={openLookupFlow}
              >
                Find sale without receipt id…
              </button>
            </>
          ) : null}

          {view === 'manager-verify' ? (
            <>
              <p className="muted" style={{ marginBottom: '0.75rem' }}>
                Customer has no receipt? A <strong>manager or admin</strong> must approve searching recent sales.
              </p>
              <div className="quotes-modal-filters" style={{ flexWrap: 'wrap' }}>
                <input
                  ref={managerBadgeRef}
                  className="open-tabs-input"
                  style={{ minWidth: '12rem', flex: '1 1 12rem' }}
                  value={managerBadge}
                  autoFocus
                  onChange={(e) => setManagerBadge(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submitManagerVerify()
                  }}
                  placeholder="Manager badge scan"
                  aria-label="Manager badge"
                  disabled={managerBusy}
                />
                <button
                  type="button"
                  className="btn small"
                  disabled={managerBusy}
                  onClick={() => void submitManagerVerify()}
                >
                  {managerBusy ? '…' : 'Approve'}
                </button>
                <button type="button" className="btn ghost small" onClick={() => setView('id')}>
                  Back
                </button>
              </div>
            </>
          ) : null}

          {view === 'lookup' ? (
            <>
              <p className="muted" style={{ marginBottom: '0.75rem' }}>
                Search recent sales by product name, partial sale id, or legacy receipt number. Tap the correct sale.
              </p>
              <div className="quotes-modal-filters" style={{ flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                <input
                  ref={lookupQInputRef}
                  className="open-tabs-input"
                  style={{ minWidth: '10rem', flex: '1 1 10rem' }}
                  value={lookupQ}
                  inputMode={lookupKbOpen ? 'none' : 'text'}
                  onChange={(e) => setLookupQ(e.target.value)}
                  placeholder="Product name, sale id, receipt no."
                  aria-label="Search sales"
                  {...lookupSearchKbHandlers()}
                />
                <select
                  className="open-tabs-input"
                  value={lookupRange}
                  onChange={(e) => setLookupRange(e.target.value as LookupRange)}
                  aria-label="Date range"
                >
                  <option value="today">Today</option>
                  <option value="7d">Last 7 days</option>
                  <option value="14d">Last 14 days</option>
                </select>
                {tillCode ? (
                  <label className="muted small" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    <input
                      type="checkbox"
                      checked={lookupThisTillOnly}
                      onChange={(e) => setLookupThisTillOnly(e.target.checked)}
                    />
                    This till only ({tillCode})
                  </label>
                ) : null}
                <button type="button" className="btn small" disabled={lookupBusy} onClick={() => void loadLookup()}>
                  {lookupBusy ? '…' : 'Search'}
                </button>
                <button type="button" className="btn ghost small" onClick={() => setView('id')}>
                  Back
                </button>
              </div>
              <div className="sale-adjust-lookup-list" role="list">
                {lookupBusy && lookupRows.length === 0 ? (
                  <p className="muted">Searching…</p>
                ) : null}
                {!lookupBusy && lookupRows.length === 0 ? (
                  <p className="muted">No sales match. Widen the date range or change the search.</p>
                ) : null}
                {lookupRows.map((row) => (
                  <button
                    key={row._id}
                    type="button"
                    className="btn ghost sale-adjust-lookup-row"
                    disabled={loading || row.refundStatus === 'refunded'}
                    title={row.refundStatus === 'refunded' ? 'Already fully refunded' : undefined}
                    onClick={() => void pickSale(row)}
                  >
                    <span className="sale-adjust-lookup-row-main">{saleRowLabel(row)}</span>
                    {row.refundStatus === 'partial' ? (
                      <span className="muted small">Partial return</span>
                    ) : row.refundStatus === 'refunded' ? (
                      <span className="muted small">Fully refunded</span>
                    ) : null}
                  </button>
                ))}
              </div>
            </>
          ) : null}

          {error && <p className="error open-tabs-form-error">{error}</p>}
          <ScreenKeyboard
            visible={screenKbOpen}
            layout="full"
            onAction={handleScreenKeyboardAction}
            className="open-tabs-screen-keyboard quotes-modal-screen-keyboard"
          />
        </div>
      </div>
    </div>
  )
}
