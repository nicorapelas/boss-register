import { useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch } from '../api/client'
import type { CartLine, LayByDetail, LayByListItem, LayByPaymentResponse, StoreSettings } from '../api/types'
import { readPosPrinterSettings } from '../printer/posPrinterSettings'
import { ScreenKeyboard, type ScreenKeyboardAction } from './ScreenKeyboard'

type LayByKbField =
  | 'customerName'
  | 'phone'
  | 'depositPct'
  | 'cashIn'
  | 'cardIn'
  | 'payCash'
  | 'payCard'
  | 'cancelPct'

export type LayByModalProps = {
  open: boolean
  onClose: () => void
  cart: CartLine[]
  cartTotal: number
  isAdmin: boolean
  receiptEnabled: boolean
  tillCode: string
  onCreated: () => void
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}

function vatFromIncl(totalIncl: number, vatRate: number) {
  const net = totalIncl / (1 + vatRate)
  return round2(totalIncl - net)
}

export function LayByModal({ open, onClose, cart, cartTotal, isAdmin, receiptEnabled, tillCode, onCreated }: LayByModalProps) {
  const [settings, setSettings] = useState<StoreSettings | null>(null)
  const [list, setList] = useState<LayByListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [view, setView] = useState<'list' | 'new' | 'detail'>('list')
  const [selected, setSelected] = useState<LayByDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [paySuccess, setPaySuccess] = useState<string | null>(null)
  const [printNotice, setPrintNotice] = useState<string | null>(null)
  const [searchQ, setSearchQ] = useState('')
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  const [customerName, setCustomerName] = useState('')
  const [phone, setPhone] = useState('')
  const [depositPct, setDepositPct] = useState<number>(30)
  const [expiresAt, setExpiresAt] = useState('')
  const [cashIn, setCashIn] = useState('')
  const [cardIn, setCardIn] = useState('')

  const [payCash, setPayCash] = useState('')
  const [payCard, setPayCard] = useState('')

  const [cancelMode, setCancelMode] = useState<'full_refund' | 'percent_refund' | 'store_credit'>('full_refund')
  const [cancelPct, setCancelPct] = useState('')

  const [layByScreenKbOpen, setLayByScreenKbOpen] = useState(false)
  const layByKbFieldRef = useRef<LayByKbField>('customerName')
  const [layByKbLayout, setLayByKbLayout] = useState<'full' | 'decimal' | 'tel' | 'numeric'>('full')
  const layByKbBlurTimerRef = useRef<number | null>(null)
  const customerNameInputRef = useRef<HTMLInputElement | null>(null)
  const phoneInputRef = useRef<HTMLInputElement | null>(null)
  const depositPctInputRef = useRef<HTMLInputElement | null>(null)
  const cashInInputRef = useRef<HTMLInputElement | null>(null)
  const cardInInputRef = useRef<HTMLInputElement | null>(null)
  const payCashInputRef = useRef<HTMLInputElement | null>(null)
  const payCardInputRef = useRef<HTMLInputElement | null>(null)
  const cancelPctInputRef = useRef<HTMLInputElement | null>(null)

  const vatRate = settings?.vatRate ?? 0.14

  const depositPercent = useMemo(() => {
    if (typeof depositPct === 'number' && Number.isFinite(depositPct)) return depositPct
    return settings?.defaultDepositPercent ?? 30
  }, [depositPct, settings])

  const depositAmount = round2((cartTotal * depositPercent) / 100)
  const vatTotal = vatFromIncl(cartTotal, vatRate)

  async function refresh(queryRaw?: string) {
    setLoading(true)
    try {
      const q = (queryRaw ?? searchQ).trim()
      const [s, l] = await Promise.all([
        apiFetch<StoreSettings>('/settings/store'),
        apiFetch<LayByListItem[]>(q ? `/lay-bys/active?q=${encodeURIComponent(q)}` : '/lay-bys/active'),
      ])
      setSettings(s)
      setList(l)
    } catch {
      /* non-fatal */
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    setView('list')
    setSelected(null)
    setFormError(null)
    setCustomerName('')
    setPhone('')
    setDepositPct(30)
    setExpiresAt('')
    setCashIn('')
    setCardIn('')
    setPayCash('')
    setPayCard('')
    setPaySuccess(null)
    setPrintNotice(null)
    setSearchQ('')
    setLayByScreenKbOpen(false)
    setLayByKbLayout('full')
    void refresh()
  }, [open])

  useEffect(() => {
    if (!open || view !== 'list') return
    const t = window.setTimeout(() => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(t)
  }, [open, view])

  useEffect(() => {
    return () => {
      if (layByKbBlurTimerRef.current) clearTimeout(layByKbBlurTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!open || view === 'list') {
      setLayByScreenKbOpen(false)
      if (layByKbBlurTimerRef.current) {
        clearTimeout(layByKbBlurTimerRef.current)
        layByKbBlurTimerRef.current = null
      }
    }
  }, [open, view])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  function cancelLayByKbBlurHide() {
    if (layByKbBlurTimerRef.current) {
      clearTimeout(layByKbBlurTimerRef.current)
      layByKbBlurTimerRef.current = null
    }
  }

  function scrollLayByFieldIntoView(field: LayByKbField) {
    const target =
      field === 'customerName'
        ? customerNameInputRef.current
        : field === 'phone'
          ? phoneInputRef.current
          : field === 'depositPct'
            ? depositPctInputRef.current
            : field === 'cashIn'
              ? cashInInputRef.current
              : field === 'cardIn'
                ? cardInInputRef.current
                : field === 'payCash'
                  ? payCashInputRef.current
                  : field === 'payCard'
                    ? payCardInputRef.current
                    : cancelPctInputRef.current
    target?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
  }

  useEffect(() => {
    if (!open || !layByScreenKbOpen) return
    const t = window.setTimeout(() => {
      scrollLayByFieldIntoView(layByKbFieldRef.current)
    }, 40)
    return () => window.clearTimeout(t)
  }, [open, layByScreenKbOpen, view])

  function patchDecimalString(s: string, action: ScreenKeyboardAction): string {
    if (action.type === 'char') {
      const c = action.char
      if (/\d/.test(c)) return s + c
      if (c === '.' || c === ',') {
        const t = s.replace(',', '.')
        if (t.includes('.')) return s
        return s + '.'
      }
      return s
    }
    if (action.type === 'backspace') return s.slice(0, -1)
    if (action.type === 'space') return s + ' '
    return s
  }

  function handleLayByScreenKeyboardAction(action: ScreenKeyboardAction) {
    const f = layByKbFieldRef.current
    if (action.type === 'enter' || action.type === 'done') {
      setLayByScreenKbOpen(false)
      return
    }
    if (f === 'customerName') {
      if (action.type === 'char') setCustomerName((s) => s + action.char)
      else if (action.type === 'backspace') setCustomerName((s) => s.slice(0, -1))
      else if (action.type === 'space') setCustomerName((s) => s + ' ')
      return
    }
    if (f === 'phone') {
      if (action.type === 'char') setPhone((s) => s + action.char)
      else if (action.type === 'backspace') setPhone((s) => s.slice(0, -1))
      else if (action.type === 'space') setPhone((s) => s + ' ')
      return
    }
    if (f === 'depositPct') {
      if (action.type === 'char' && /\d/.test(action.char)) {
        setDepositPct((prev) => {
          const d = (String(prev).replace(/\D/g, '') + action.char).slice(0, 3)
          const n = d === '' ? 0 : parseInt(d, 10)
          return Number.isFinite(n) ? Math.min(100, n) : prev
        })
      } else if (action.type === 'backspace') {
        setDepositPct((prev) => {
          const d = String(prev).replace(/\D/g, '').slice(0, -1)
          if (d === '') return 0
          const n = parseInt(d, 10)
          return Number.isFinite(n) ? Math.min(100, n) : 0
        })
      }
      return
    }
    if (f === 'cashIn') setCashIn((s) => patchDecimalString(s, action))
    else if (f === 'cardIn') setCardIn((s) => patchDecimalString(s, action))
    else if (f === 'payCash') setPayCash((s) => patchDecimalString(s, action))
    else if (f === 'payCard') setPayCard((s) => patchDecimalString(s, action))
    else if (f === 'cancelPct') setCancelPct((s) => patchDecimalString(s, action))
  }

  function layByKbHandlers(which: LayByKbField) {
    function layoutForField(field: LayByKbField): 'full' | 'decimal' | 'tel' | 'numeric' {
      if (field === 'customerName') return 'full'
      if (field === 'phone') return 'tel'
      if (field === 'depositPct') return 'numeric'
      return 'decimal'
    }
    return {
      onFocus: () => {
        layByKbFieldRef.current = which
        setLayByKbLayout(layoutForField(which))
        cancelLayByKbBlurHide()
        setLayByScreenKbOpen(true)
        window.setTimeout(() => scrollLayByFieldIntoView(which), 20)
      },
      onBlur: () => {
        cancelLayByKbBlurHide()
        layByKbBlurTimerRef.current = window.setTimeout(() => {
          setLayByScreenKbOpen(false)
        }, 200)
      },
    }
  }

  function buildLayByReceiptPayload(input: {
    detail: LayByDetail
    paymentLabel: string
    payment?: { tenderedCash?: number; changeDue?: number }
    receiptTitle: string
    receiptNumber: string
    thankYouLine: string
    timestampIso?: string
    copyLabel?: string
  }): {
    transport: unknown
    receipt: unknown
    columns: number
    cut: boolean
  } {
    const printerSettings = readPosPrinterSettings()
    const cfg = printerSettings.receiptConfig
    return {
      transport: printerSettings.transport,
      columns: printerSettings.columns,
      cut: printerSettings.cut,
      receipt: {
        headerLines: [
          cfg.headerLine1,
          cfg.headerLine2,
          cfg.headerLine3,
          `Customer: ${input.detail.customerName}`,
          `Phone: ${input.detail.phone}`,
        ],
        phone: cfg.phone,
        vatNumber: cfg.vatNumber,
        receiptTitle: input.receiptTitle,
        receiptNumberPrefix: 'Lay-by',
        showReceiptNumberLine: false,
        receiptNumber: input.receiptNumber,
        barcodeValue: input.receiptNumber,
        copyLabel: input.copyLabel,
        tillNumber: tillCode,
        tillLabel: cfg.tillLabel,
        slipLabel: cfg.slipLabel,
        timestampIso: input.timestampIso ?? input.detail.createdAt ?? new Date().toISOString(),
        paymentLabel: input.paymentLabel,
        lines: input.detail.lines.map((l) => ({
          qty: l.quantity,
          name: l.name,
          unitPrice: l.unitPrice,
          lineTotal: l.lineTotal,
        })),
        subtotal: input.detail.totalNetAmount,
        taxTotal: input.detail.totalVatAmount,
        vatRatePct: input.detail.vatRate > 0 ? input.detail.vatRate * 100 : undefined,
        vatLabel: cfg.vatLabel,
        subtotalLabel: cfg.subtotalLabel,
        taxTotalLabel: cfg.taxTotalLabel,
        totalDueLabel: cfg.totalDueLabel,
        cashTenderedLabel: cfg.cashTenderedLabel,
        changeDueLabel: cfg.changeDueLabel,
        thankYouLine: input.thankYouLine,
        total: input.detail.totalInclVat,
        balanceRemaining: input.detail.balance,
        tendered: input.payment?.tenderedCash,
        changeDue: input.payment?.changeDue,
      },
    }
  }

  async function printLayByReceipt(input: {
    detail: LayByDetail
    paymentLabel: string
    payment?: { tenderedCash?: number; changeDue?: number }
    receiptTitle: string
    receiptNumber: string
    thankYouLine: string
    successMessage: string
    timestampIso?: string
  }) {
    if (!receiptEnabled) return
    const settings = readPosPrinterSettings()
    if (!settings.autoPrintReceipt) return
    if (!window.electronPos) {
      setPrintNotice(`${input.successMessage} (web preview)`)
      return
    }
    const labels = ['CUSTOMER COPY', 'ATTACH TO ITEM'] as const
    for (const copyLabel of labels) {
      const payload = buildLayByReceiptPayload({ ...input, copyLabel })
      const r = await window.electronPos.printReceipt(payload.transport, payload.receipt, {
        columns: payload.columns,
        cut: payload.cut,
      })
      if (!r.ok) {
        throw new Error(r.error ?? 'Lay-by receipt print failed')
      }
    }
    setPrintNotice(input.successMessage)
  }

  async function openDrawerForLayByCash(cashTendered: number) {
    if (cashTendered <= 0.005) return
    if (!window.electronPos) return
    const settings = readPosPrinterSettings()
    if (!settings.autoOpenDrawer) return
    const r = await window.electronPos.kickDrawer(settings.transport)
    if (!r.ok) throw new Error(r.error ?? 'Drawer open failed')
  }

  async function openDetail(id: string) {
    setFormError(null)
    setPaySuccess(null)
    setBusy(true)
    try {
      const d = await apiFetch<LayByDetail>(`/lay-bys/${id}`)
      setSelected(d)
      setView('detail')
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setBusy(false)
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setFormError(null)
    if (cart.length === 0) {
      setFormError('Add items to the cart first')
      return
    }
    const name = customerName.trim()
    const ph = phone.trim()
    if (!name || !ph) {
      setFormError('Name and phone are required')
      return
    }
    const cash = round2(Number(cashIn.replace(',', '.')) || 0)
    const card = round2(Number(cardIn.replace(',', '.')) || 0)
    const paid = round2(cash + card)
    if (paid < depositAmount - 0.01) {
      setFormError(`Deposit is at least ${depositAmount.toFixed(2)}`)
      return
    }
    setBusy(true)
    try {
      const body: Record<string, unknown> = {
        customerName: name,
        phone: ph,
        items: cart.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
        })),
        firstPayment: { cashAmount: cash, cardAmount: card },
        tillCode,
      }
      if (isAdmin && depositPct !== (settings?.defaultDepositPercent ?? 30)) {
        body.depositPercentOverride = depositPct
      }
      if (isAdmin && expiresAt.trim()) {
        body.expiresAtOverride = new Date(expiresAt).toISOString()
      }
      const created = await apiFetch<LayByDetail>('/lay-bys', { method: 'POST', body: JSON.stringify(body) })
      const firstPayment = created.payments[0]
      const paymentLabel = firstPayment
        ? `Deposit paid ${firstPayment.amount.toFixed(2)} (cash ${firstPayment.cashAmount.toFixed(2)}, card ${firstPayment.cardAmount.toFixed(2)})`
        : `Deposit paid ${paid.toFixed(2)}`
      await printLayByReceipt({
        detail: created,
        paymentLabel,
        payment: firstPayment
          ? {
              tenderedCash: firstPayment.cashAmount,
              changeDue: 0,
            }
          : {
              tenderedCash: cash,
              changeDue: 0,
            },
        receiptTitle: 'LAY-BY CREATED',
        receiptNumber: created.layByNumber,
        thankYouLine: 'LAY-BY AGREEMENT CREATED',
        successMessage: 'Lay-by receipt printed',
      })
      await openDrawerForLayByCash(cash)
      onCreated()
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not create lay-by')
    } finally {
      setBusy(false)
    }
  }

  async function handleAddPayment(e: React.FormEvent) {
    e.preventDefault()
    if (!selected) return
    setFormError(null)
    setPaySuccess(null)
    const cash = round2(Number(payCash.replace(',', '.')) || 0)
    const card = round2(Number(payCard.replace(',', '.')) || 0)
    const total = round2(cash + card)
    if (total < 0.01) {
      setFormError('Enter a payment amount')
      return
    }
    setBusy(true)
    try {
      const d = await apiFetch<LayByPaymentResponse>(`/lay-bys/${selected._id}/payments`, {
        method: 'POST',
        body: JSON.stringify({ cashAmount: cash, cardAmount: card, tillCode }),
      })
      const applied = round2(
        (d.paymentAppliedCash ?? 0) + (d.paymentAppliedCard ?? 0) + (d.paymentAppliedStoreCredit ?? 0),
      )
      const ch = d.paymentChangeDue ?? 0
      await printLayByReceipt({
        detail: d,
        paymentLabel: `Installment ${applied.toFixed(2)} (cash ${(d.paymentAppliedCash ?? 0).toFixed(2)}, card ${(d.paymentAppliedCard ?? 0).toFixed(2)})`,
        payment: {
          tenderedCash: d.paymentTenderedCash ?? 0,
          changeDue: ch,
        },
        receiptTitle: 'LAY-BY PAYMENT',
        receiptNumber: d.layByNumber,
        thankYouLine: 'LAY-BY PAYMENT RECEIVED',
        successMessage: 'Lay-by payment receipt printed',
      })
      await openDrawerForLayByCash(d.paymentTenderedCash ?? cash)
      setSelected(d)
      setPayCash('')
      setPayCard('')
      if (ch > 0.01) {
        setPaySuccess(
          `Change owing ${ch.toFixed(2)} · ${applied.toFixed(2)} applied to this lay-by (tendered cash ${(d.paymentTenderedCash ?? 0).toFixed(2)}, card ${(d.paymentTenderedCard ?? 0).toFixed(2)}). Balance ${d.balance.toFixed(2)}.`,
        )
      } else {
        setPaySuccess(`Payment ${applied.toFixed(2)} applied. Balance ${d.balance.toFixed(2)}.`)
      }
      await refresh()
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Payment failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleComplete() {
    if (!selected) return
    setFormError(null)
    setBusy(true)
    try {
      await apiFetch(`/lay-bys/${selected._id}/complete`, { method: 'POST', body: JSON.stringify({ tillCode }) })
      await refresh()
      setView('list')
      setSelected(null)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not complete')
    } finally {
      setBusy(false)
    }
  }

  async function handleCancel() {
    if (!selected || !isAdmin) return
    if (!window.confirm(`Cancel lay-by ${selected.layByNumber}?`)) return
    setFormError(null)
    setBusy(true)
    try {
      const body: Record<string, unknown> = { mode: cancelMode }
      if (cancelMode === 'percent_refund') body.percent = Number(cancelPct.replace(',', '.')) || 0
      await apiFetch(`/lay-bys/${selected._id}/cancel`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      await refresh()
      setView('list')
      setSelected(null)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Cancel failed')
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    <div
      className="open-tabs-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="layby-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="open-tabs-dialog layby-modal-dialog">
        <div className="open-tabs-header">
          <h2 id="layby-title">Lay-by</h2>
          <button type="button" className="btn ghost open-tabs-close" onClick={onClose}>
            Close
          </button>
        </div>

        {view === 'list' && (
          <div className="layby-modal-scroll">
            <div className="open-tabs-section">
              <div className="open-tabs-section-head">
                <h3>Open lay-bys</h3>
                <div className="open-tabs-section-head-actions">
                  <button type="button" className="btn ghost" disabled={loading} onClick={() => void refresh()}>
                    {loading ? 'Loading…' : 'Refresh'}
                  </button>
                  <button
                    type="button"
                    className="btn primary small"
                    disabled={busy || cart.length === 0}
                    onClick={() => {
                      setView('new')
                      setFormError(null)
                      if (settings) setDepositPct(settings.defaultDepositPercent)
                    }}
                    title={cart.length === 0 ? 'Add items to cart first' : undefined}
                  >
                    New lay-by
                  </button>
                </div>
              </div>
              <div className="layby-field-row">
                <label className="open-tabs-field">
                  <span>Search / scan lay-by barcode</span>
                  <input
                    ref={searchInputRef}
                    className="open-tabs-input"
                    value={searchQ}
                    onChange={(e) => setSearchQ(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void refresh(searchQ)
                      }
                    }}
                    placeholder="Scan barcode or type lay-by number"
                  />
                </label>
                <div className="open-tabs-form-actions">
                  <button type="button" className="btn ghost" disabled={loading} onClick={() => void refresh(searchQ)}>
                    Search
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={loading}
                    onClick={() => {
                      setSearchQ('')
                      void refresh('')
                    }}
                  >
                    Clear
                  </button>
                </div>
              </div>
              {list.length === 0 && !loading ? (
                <p className="muted open-tabs-empty">No active lay-bys.</p>
              ) : (
                <ul className="open-tabs-list">
                  {list.map((t) => (
                    <li key={t._id} className="open-tabs-li">
                      <div className="open-tabs-li-main">
                        <span className="open-tabs-li-title">
                          <strong>{t.layByNumber}</strong> · {t.customerName}
                        </span>
                        <span className="muted open-tabs-li-phone">{t.phone}</span>
                        <span className="open-tabs-li-total">Bal {t.balance.toFixed(2)}</span>
                      </div>
                      <div className="open-tabs-li-actions">
                        <button
                          type="button"
                          className="btn small"
                          disabled={busy}
                          onClick={() => {
                            setSearchQ('')
                            void openDetail(t._id)
                          }}
                        >
                          Open
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {view === 'new' && (
          <form className="open-tabs-new layby-form-compact layby-new-form" onSubmit={(e) => void handleCreate(e)}>
            <div className="layby-modal-scroll">
              <div className="open-tabs-section-head">
                <h3>New lay-by</h3>
                <button type="button" className="btn ghost" onClick={() => setView('list')}>
                  Back
                </button>
              </div>
              {formError && <p className="error open-tabs-form-error">{formError}</p>}
              {printNotice && (
                <p className="success open-tabs-form-error" role="status">
                  {printNotice}
                </p>
              )}
              <p className="muted layby-receipt-preview layby-receipt-one-line">
                {settings?.storeName && <strong>{settings.storeName}</strong>}
                {settings?.storePhone && <span> · {settings.storePhone}</span>}
                {settings?.storeVatNumber && <span> · VAT {settings.storeVatNumber}</span>}
              </p>
              <div className="layby-field-row">
                <label className="open-tabs-field">
                  <span>Name</span>
                  <input
                    ref={customerNameInputRef}
                    className="open-tabs-input"
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    inputMode={layByScreenKbOpen ? 'none' : 'text'}
                    {...layByKbHandlers('customerName')}
                  />
                </label>
                <label className="open-tabs-field">
                  <span>Phone</span>
                  <input
                    ref={phoneInputRef}
                    className="open-tabs-input"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    inputMode={layByScreenKbOpen ? 'none' : 'tel'}
                    {...layByKbHandlers('phone')}
                  />
                </label>
              </div>
              {isAdmin ? (
                <div className="layby-field-row">
                  <label className="open-tabs-field">
                    <span>Deposit %</span>
                    <input
                      ref={depositPctInputRef}
                      className="open-tabs-input"
                      type="number"
                      min={0}
                      max={100}
                      value={depositPct}
                      onChange={(e) => setDepositPct(Number(e.target.value))}
                      inputMode={layByScreenKbOpen ? 'none' : 'numeric'}
                      {...layByKbHandlers('depositPct')}
                    />
                  </label>
                  <label className="open-tabs-field">
                    <span>Expiry override</span>
                    <input
                      className="open-tabs-input layby-input-datetime"
                      type="datetime-local"
                      value={expiresAt}
                      onChange={(e) => setExpiresAt(e.target.value)}
                    />
                  </label>
                </div>
              ) : null}
              <div className="layby-summary layby-summary-cols">
                <div title="Total incl. VAT">
                  Total <strong>{cartTotal.toFixed(2)}</strong>
                </div>
                <div title={`VAT ${Math.round(vatRate * 100)}%`}>
                  VAT <strong>{vatTotal.toFixed(2)}</strong>
                </div>
                <div title={`Deposit ${depositPercent}%`}>
                  Deposit <strong>{depositAmount.toFixed(2)}</strong>
                </div>
              </div>
              <p className="muted layby-terms-snippet layby-terms-clamp">{settings?.layByTerms || '—'}</p>
              <div className="layby-field-row">
                <label className="open-tabs-field">
                  <span>Pay cash</span>
                  <input
                    ref={cashInInputRef}
                    className="open-tabs-input"
                    value={cashIn}
                    onChange={(e) => setCashIn(e.target.value)}
                    inputMode={layByScreenKbOpen ? 'none' : 'decimal'}
                    {...layByKbHandlers('cashIn')}
                  />
                </label>
                <label className="open-tabs-field">
                  <span>Pay card</span>
                  <input
                    ref={cardInInputRef}
                    className="open-tabs-input"
                    value={cardIn}
                    onChange={(e) => setCardIn(e.target.value)}
                    inputMode={layByScreenKbOpen ? 'none' : 'decimal'}
                    {...layByKbHandlers('cardIn')}
                  />
                </label>
              </div>
            </div>
            <ScreenKeyboard
              visible={layByScreenKbOpen}
              onAction={handleLayByScreenKeyboardAction}
              layout={layByKbLayout}
              className="open-tabs-screen-keyboard layby-new-form-keyboard"
            />
            <div
              className={
                layByScreenKbOpen
                  ? 'open-tabs-form-actions open-tabs-form-actions--with-keyboard'
                  : 'open-tabs-form-actions'
              }
            >
              <button type="button" className="btn ghost" onClick={() => setView('list')}>
                Cancel
              </button>
              <button type="submit" className="btn primary" disabled={busy || cart.length === 0}>
                {busy ? 'Creating…' : 'Create & take deposit'}
              </button>
            </div>
          </form>
        )}

        {view === 'detail' && selected && (
          <div className="open-tabs-section layby-detail layby-detail-layout">
            <div className="layby-modal-scroll">
              <div className="open-tabs-section-head">
                <h3>{selected.layByNumber}</h3>
                <button type="button" className="btn ghost" onClick={() => setView('list')}>
                  Back
                </button>
              </div>
              {formError && <p className="error open-tabs-form-error">{formError}</p>}
              {printNotice && (
                <p className="success open-tabs-form-error" role="status">
                  {printNotice}
                </p>
              )}
              {paySuccess && (
                <p className="success open-tabs-form-error" role="status">
                  {paySuccess}
                </p>
              )}
              <p className="layby-detail-meta muted">
                {selected.customerName} · {selected.phone}
                <br />
                Expires {new Date(selected.expiresAt).toLocaleString()}
              </p>
              <div className="layby-summary">
                <div>Total: {selected.totalInclVat.toFixed(2)}</div>
                <div>VAT: {selected.totalVatAmount.toFixed(2)}</div>
                <div>Paid: {selected.amountPaid.toFixed(2)}</div>
                <div>
                  Balance: <strong>{selected.balance.toFixed(2)}</strong>
                </div>
              </div>
              <ul className="layby-lines">
                {selected.lines.map((l, i) => (
                  <li key={i}>
                    {l.name} × {l.quantity} @ {l.unitPrice.toFixed(2)} = {l.lineTotal.toFixed(2)}
                  </li>
                ))}
              </ul>
              <h4 className="layby-payments-h">Payments</h4>
              <ul className="layby-payments">
                {selected.payments.map((p, i) => (
                  <li key={i}>
                    {new Date(p.createdAt).toLocaleString()}: {p.amount.toFixed(2)} (cash {p.cashAmount.toFixed(2)}, card{' '}
                    {p.cardAmount.toFixed(2)})
                  </li>
                ))}
              </ul>

              {selected.balance > 0.02 ? (
                <form onSubmit={(e) => void handleAddPayment(e)}>
                  <label className="open-tabs-field">
                    <span>Add payment — cash</span>
                    <input
                      ref={payCashInputRef}
                      className="open-tabs-input"
                      value={payCash}
                      onChange={(e) => setPayCash(e.target.value)}
                      inputMode={layByScreenKbOpen ? 'none' : 'decimal'}
                      {...layByKbHandlers('payCash')}
                    />
                  </label>
                  <label className="open-tabs-field">
                    <span>Add payment — card</span>
                    <input
                      ref={payCardInputRef}
                      className="open-tabs-input"
                      value={payCard}
                      onChange={(e) => setPayCard(e.target.value)}
                      inputMode={layByScreenKbOpen ? 'none' : 'decimal'}
                      {...layByKbHandlers('payCard')}
                    />
                  </label>
                  <div
                    className={
                      layByScreenKbOpen
                        ? 'open-tabs-form-actions open-tabs-form-actions--with-keyboard'
                        : 'open-tabs-form-actions'
                    }
                  >
                    <button type="submit" className="btn primary" disabled={busy}>
                      Record payment
                    </button>
                  </div>
                </form>
              ) : null}

              {selected.balance <= 0.02 && selected.status === 'active' ? (
                <div className="open-tabs-form-actions">
                  <button type="button" className="btn primary" disabled={busy} onClick={() => void handleComplete()}>
                    Complete pickup (stock out)
                  </button>
                </div>
              ) : null}

              {isAdmin && selected.status === 'active' ? (
                <div className="layby-cancel">
                  <h4>Cancel (admin)</h4>
                  <label className="open-tabs-field">
                    <span>Mode</span>
                    <select
                      className="open-tabs-input"
                      value={cancelMode}
                      onChange={(e) => setCancelMode(e.target.value as typeof cancelMode)}
                    >
                      <option value="full_refund">Full refund (cash/card back)</option>
                      <option value="percent_refund">Percentage refund (cash/card back)</option>
                      <option value="store_credit">Store voucher / credit (no cash)</option>
                    </select>
                  </label>
                  {cancelMode === 'store_credit' ? (
                    <p className="muted layby-cancel-hint">
                      Customer receives the amount paid as spendable in-store credit on this phone number — not cash from
                      the till.
                    </p>
                  ) : null}
                  {cancelMode === 'percent_refund' ? (
                    <label className="open-tabs-field">
                      <span>Refund % of amount paid</span>
                      <input
                        ref={cancelPctInputRef}
                        className="open-tabs-input"
                        value={cancelPct}
                        onChange={(e) => setCancelPct(e.target.value)}
                        inputMode={layByScreenKbOpen ? 'none' : 'decimal'}
                        {...layByKbHandlers('cancelPct')}
                      />
                    </label>
                  ) : null}
                  <button type="button" className="btn ghost open-tabs-void" disabled={busy} onClick={() => void handleCancel()}>
                    Cancel lay-by
                  </button>
                </div>
              ) : null}
            </div>
            <ScreenKeyboard
              visible={layByScreenKbOpen}
              onAction={handleLayByScreenKeyboardAction}
              layout={layByKbLayout}
              className="open-tabs-screen-keyboard layby-detail-screen-kb"
            />
          </div>
        )}
      </div>
    </div>
  )
}
