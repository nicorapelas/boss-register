import { useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch } from '../api/client'
import type { CartLine, LayByCancelResponse, LayByDetail, LayByListItem, LayByPaymentResponse, StoreSettings } from '../api/types'
import {
  computeLayByCancelSettlement,
  type LayByCancelMode,
  type LayByCancelSettlement,
} from '../utils/laybyCancelSettlement'
import {
  kickCashDrawerIfConfigured,
  readPosPrinterSettings,
  receiptPrintOpts,
  type ReceiptPrintOpts,
} from '../printer/posPrinterSettings'

export type LayByReceiptPrintPayload = {
  transport: unknown
  receipt: unknown
} & ReceiptPrintOpts
import { ScreenKeyboard, type ScreenKeyboardAction } from './ScreenKeyboard'

type LayByKbField =
  | 'searchQ'
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
  canCancelLayBy: boolean
  tillCode: string
  onCreated: () => void
  /** Called after a lay-by installment payment receipt is built (for Print Last). */
  onPaymentReceiptPrinted?: (payloads: LayByReceiptPrintPayload[], successNotice: string) => void
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}

/** Receipt payment lines — match retail sale labels (Card / Cash / Split), not a long parenthetical. */
function layByPaymentReceiptFields(applied: {
  cash: number
  card: number
  storeCredit?: number
  tenderedCash?: number
  changeDue?: number
}): {
  paymentLabel: string
  installmentPaid: number
  paymentTenders?: { cash?: number; card?: number; storeVoucher?: number }
  tenderedCash?: number
  changeDue?: number
} {
  const cash = round2(applied.cash)
  const card = round2(applied.card)
  const storeCredit = round2(applied.storeCredit ?? 0)
  const installmentPaid = round2(cash + card + storeCredit)
  const hasCash = cash > 0.005
  const hasCard = card > 0.005
  const hasSc = storeCredit > 0.005
  const kindCount = [hasCash, hasCard, hasSc].filter(Boolean).length
  let paymentLabel = 'Cash'
  if (kindCount >= 2) paymentLabel = 'Split'
  else if (hasCard) paymentLabel = 'Card'
  else if (hasSc) paymentLabel = 'Store voucher'

  const paymentTenders =
    kindCount >= 2
      ? {
          ...(hasCash ? { cash } : {}),
          ...(hasCard ? { card } : {}),
          ...(hasSc ? { storeVoucher: storeCredit } : {}),
        }
      : undefined

  const rawTendered = applied.tenderedCash ?? cash
  const tenderedCash = rawTendered > 0.005 ? round2(rawTendered) : undefined
  const changeDue =
    applied.changeDue != null && applied.changeDue > 0.005 ? round2(applied.changeDue) : undefined

  return { paymentLabel, installmentPaid, paymentTenders, tenderedCash, changeDue }
}

function vatFromIncl(totalIncl: number, vatRate: number) {
  const net = totalIncl / (1 + vatRate)
  return round2(totalIncl - net)
}

export function LayByModal({
  open,
  onClose,
  cart,
  cartTotal,
  isAdmin,
  canCancelLayBy,
  tillCode,
  onCreated,
  onPaymentReceiptPrinted,
}: LayByModalProps) {
  const [settings, setSettings] = useState<StoreSettings | null>(null)
  const [list, setList] = useState<LayByListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [view, setView] = useState<'list' | 'new' | 'detail' | 'cancel'>('list')
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

  const [cancelMode, setCancelMode] = useState<LayByCancelMode>('full_refund')
  const [cancelPct, setCancelPct] = useState('')
  const [cancelStep, setCancelStep] = useState<'summary' | 'mode' | 'preview' | 'payout' | 'done'>('summary')
  const [cancelSettlement, setCancelSettlement] = useState<LayByCancelSettlement | null>(null)
  const [cancelSuccess, setCancelSuccess] = useState<string | null>(null)
  const [drawerNotice, setDrawerNotice] = useState<string | null>(null)

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

  const cancelPreview = useMemo(() => {
    if (!selected || view !== 'cancel') return null
    const pct =
      cancelMode === 'percent_refund' ? Number(cancelPct.replace(',', '.')) : undefined
    return computeLayByCancelSettlement({
      mode: cancelMode,
      amountPaid: selected.amountPaid,
      payments: selected.payments,
      percent: pct,
    })
  }, [selected, view, cancelMode, cancelPct])

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
    setCancelMode('full_refund')
    setCancelPct('')
    setCancelStep('summary')
    setCancelSettlement(null)
    setCancelSuccess(null)
    setDrawerNotice(null)
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
    if (!open) {
      setLayByScreenKbOpen(false)
      if (layByKbBlurTimerRef.current) {
        clearTimeout(layByKbBlurTimerRef.current)
        layByKbBlurTimerRef.current = null
      }
    }
  }, [open])

  useEffect(() => {
    setLayByScreenKbOpen(false)
    if (layByKbBlurTimerRef.current) {
      clearTimeout(layByKbBlurTimerRef.current)
      layByKbBlurTimerRef.current = null
    }
  }, [view])

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
      field === 'searchQ'
        ? searchInputRef.current
        : field === 'customerName'
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
      if (f === 'searchQ' && action.type === 'enter') {
        void refresh()
      }
      setLayByScreenKbOpen(false)
      return
    }
    if (f === 'searchQ') {
      if (action.type === 'char') setSearchQ((s) => s + action.char)
      else if (action.type === 'backspace') setSearchQ((s) => s.slice(0, -1))
      else if (action.type === 'space') setSearchQ((s) => s + ' ')
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
      if (field === 'searchQ' || field === 'customerName') return 'full'
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
    installmentPaid?: number
    paymentTenders?: { cash?: number; card?: number; storeVoucher?: number }
    payment?: { tenderedCash?: number; changeDue?: number }
    receiptTitle: string
    receiptNumber: string
    thankYouLine: string
    timestampIso?: string
    copyLabel?: string
  }): LayByReceiptPrintPayload {
    const printerSettings = readPosPrinterSettings()
    const cfg = printerSettings.receiptConfig
    return {
      transport: printerSettings.transport,
      ...receiptPrintOpts(printerSettings),
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
        ...(input.installmentPaid != null && input.installmentPaid > 0.005
          ? { installmentPaid: input.installmentPaid }
          : {}),
        ...(input.paymentTenders ? { paymentTenders: input.paymentTenders } : {}),
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
        ...(input.payment?.tenderedCash != null && input.payment.tenderedCash > 0.005
          ? { tendered: input.payment.tenderedCash }
          : {}),
        ...(input.payment?.changeDue != null && input.payment.changeDue > 0.005
          ? { changeDue: input.payment.changeDue }
          : {}),
      },
    }
  }

  async function printLayByReceipt(input: {
    detail: LayByDetail
    paymentLabel: string
    installmentPaid?: number
    paymentTenders?: { cash?: number; card?: number; storeVoucher?: number }
    payment?: { tenderedCash?: number; changeDue?: number }
    receiptTitle: string
    receiptNumber: string
    thankYouLine: string
    successMessage: string
    timestampIso?: string
    /** Installment payments always print, ignoring printer auto-print setting. */
    alwaysPrint?: boolean
  }): Promise<{ payloads: LayByReceiptPrintPayload[]; successMessage: string } | null> {
    const settings = readPosPrinterSettings()
    if (!input.alwaysPrint && !settings.autoPrintReceipt) return null
    const labels = ['CUSTOMER COPY', 'ATTACH TO ITEM'] as const
    const payloads = labels.map((copyLabel) => buildLayByReceiptPayload({ ...input, copyLabel }))
    if (!window.electronPos) {
      setPrintNotice(`${input.successMessage} (web preview)`)
      return { payloads, successMessage: input.successMessage }
    }
    if (settings.autoOpenDrawer) {
      const d = await kickCashDrawerIfConfigured(settings)
      if (!d.ok) throw new Error(d.error ?? 'Drawer open failed')
    }
    for (const payload of payloads) {
      const r = await window.electronPos.printReceipt(payload.transport, payload.receipt, receiptPrintOpts(settings))
      if (!r.ok) {
        throw new Error(r.error ?? 'Lay-by receipt print failed')
      }
    }
    setPrintNotice(input.successMessage)
    return { payloads, successMessage: input.successMessage }
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
      const payFields = firstPayment
        ? layByPaymentReceiptFields({
            cash: firstPayment.cashAmount,
            card: firstPayment.cardAmount,
            storeCredit: firstPayment.storeCreditAmount,
            tenderedCash: firstPayment.cashAmount,
            changeDue: 0,
          })
        : layByPaymentReceiptFields({
            cash: paid,
            card: 0,
            tenderedCash: cash,
            changeDue: 0,
          })
      await printLayByReceipt({
        detail: created,
        paymentLabel: payFields.paymentLabel,
        installmentPaid: payFields.installmentPaid,
        paymentTenders: payFields.paymentTenders,
        payment: {
          tenderedCash: payFields.tenderedCash,
          changeDue: payFields.changeDue,
        },
        receiptTitle: 'LAY-BY CREATED',
        receiptNumber: created.layByNumber,
        thankYouLine: 'LAY-BY AGREEMENT CREATED',
        successMessage: 'Lay-by receipt printed',
      })
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
      const payFields = layByPaymentReceiptFields({
        cash: d.paymentAppliedCash ?? 0,
        card: d.paymentAppliedCard ?? 0,
        storeCredit: d.paymentAppliedStoreCredit ?? 0,
        tenderedCash: d.paymentTenderedCash,
        changeDue: ch,
      })
      const printed = await printLayByReceipt({
        detail: d,
        paymentLabel: payFields.paymentLabel,
        installmentPaid: payFields.installmentPaid,
        paymentTenders: payFields.paymentTenders,
        payment: {
          tenderedCash: payFields.tenderedCash,
          changeDue: payFields.changeDue,
        },
        receiptTitle: 'LAY-BY PAYMENT',
        receiptNumber: d.layByNumber,
        thankYouLine: 'LAY-BY PAYMENT RECEIVED',
        successMessage: 'Lay-by payment receipt printed',
        alwaysPrint: true,
      })
      if (printed) {
        onPaymentReceiptPrinted?.(printed.payloads, printed.successMessage)
      }
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

  function beginCancelWizard() {
    if (!selected || !canCancelLayBy) return
    setFormError(null)
    setCancelSuccess(null)
    setDrawerNotice(null)
    setCancelMode('full_refund')
    setCancelPct('')
    setCancelStep('summary')
    setCancelSettlement(null)
    setView('cancel')
  }

  function cancelWizardBack() {
    setFormError(null)
    setLayByScreenKbOpen(false)
    if (cancelStep === 'summary') {
      setView('detail')
      return
    }
    if (cancelStep === 'mode') {
      setCancelStep('summary')
      return
    }
    if (cancelStep === 'preview') {
      setCancelStep('mode')
      return
    }
    if (cancelStep === 'payout' || cancelStep === 'done') {
      setView('list')
      setSelected(null)
      return
    }
  }

  function cancelModeLabel(mode: LayByCancelMode): string {
    if (mode === 'full_refund') return 'Full refund (cash/card back)'
    if (mode === 'percent_refund') return 'Percentage refund (cash/card back)'
    return 'Store voucher / credit (no cash from till)'
  }

  function cancelPercentValid(): boolean {
    if (cancelMode !== 'percent_refund') return true
    const pct = Number(cancelPct.replace(',', '.'))
    return Number.isFinite(pct) && pct > 0 && pct <= 100
  }

  function cancelPreviewValid(): boolean {
    if (!cancelPreview || !selected) return false
    if (!cancelPercentValid()) return false
    if (selected.amountPaid > 0.005 && cancelPreview.refundTotal < 0.005 && cancelMode !== 'full_refund') {
      return false
    }
    return true
  }

  function buildCancelSuccessMessage(settlement: LayByCancelSettlement, phone: string): string {
    const parts: string[] = [`Lay-by cancelled.`]
    if (settlement.refundCash > 0.005) parts.push(`Cash refund R ${settlement.refundCash.toFixed(2)}`)
    if (settlement.refundCard > 0.005) parts.push(`Card refund R ${settlement.refundCard.toFixed(2)}`)
    const credit = round2(settlement.storeCreditIssued + settlement.storeCreditRestored)
    if (credit > 0.005) parts.push(`Store credit R ${credit.toFixed(2)} on ${phone}`)
    if (parts.length === 1 && settlement.refundTotal < 0.005) {
      parts.push('No refund due (nothing paid).')
    }
    return parts.join(' · ')
  }

  async function submitCancelLayBy() {
    if (!selected || !canCancelLayBy || !cancelPreviewValid() || !cancelPreview) return
    setFormError(null)
    setBusy(true)
    try {
      const body: Record<string, unknown> = { mode: cancelMode, tillCode }
      if (cancelMode === 'percent_refund') {
        body.percent = Number(cancelPct.replace(',', '.'))
      }
      const out = await apiFetch<LayByCancelResponse>(`/lay-bys/${selected._id}/cancel`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      const settlement = out.cancelSettlement ?? cancelPreview
      setCancelSettlement(settlement)
      setCancelSuccess(buildCancelSuccessMessage(settlement, selected.phone))
      if (settlement.refundCash > 0.005) {
        setCancelStep('payout')
      } else {
        setCancelStep('done')
      }
      await refresh()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Cancel failed')
    } finally {
      setBusy(false)
    }
  }

  async function openDrawerForCancelPayout() {
    setFormError(null)
    setDrawerNotice(null)
    try {
      const printerSettings = readPosPrinterSettings()
      if (!window.electronPos) {
        setDrawerNotice('Drawer command accepted (web preview)')
        return
      }
      const d = await kickCashDrawerIfConfigured(printerSettings)
      if (!d.ok) throw new Error(d.error ?? 'Drawer open failed')
      setDrawerNotice('Cash drawer opened — pay customer from till.')
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Drawer open failed')
    }
  }

  function finishCancelWizard() {
    setView('list')
    setSelected(null)
    setCancelSettlement(null)
    setCancelSuccess(null)
    setDrawerNotice(null)
    setCancelStep('summary')
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

  function renderCancelSettlementPreview(settlement: LayByCancelSettlement) {
    return (
      <div className="layby-cancel-settlement">
        <div className="layby-cancel-settlement-row">
          <span>Total refund / credit</span>
          <strong>R {settlement.refundTotal.toFixed(2)}</strong>
        </div>
        {settlement.refundCash > 0.005 ? (
          <div className="layby-cancel-settlement-row">
            <span>Cash from till</span>
            <strong>R {settlement.refundCash.toFixed(2)}</strong>
          </div>
        ) : null}
        {settlement.refundCard > 0.005 ? (
          <div className="layby-cancel-settlement-row">
            <span>Card reversal</span>
            <strong>R {settlement.refundCard.toFixed(2)}</strong>
          </div>
        ) : null}
        {settlement.storeCreditRestored > 0.005 ? (
          <div className="layby-cancel-settlement-row">
            <span>Store credit restored</span>
            <strong>R {settlement.storeCreditRestored.toFixed(2)}</strong>
          </div>
        ) : null}
        {settlement.storeCreditIssued > 0.005 ? (
          <div className="layby-cancel-settlement-row">
            <span>Store credit issued</span>
            <strong>R {settlement.storeCreditIssued.toFixed(2)}</strong>
          </div>
        ) : null}
      </div>
    )
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
          <div className="layby-detail-layout">
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
                      autoComplete="off"
                      inputMode={layByScreenKbOpen ? 'none' : 'search'}
                      {...layByKbHandlers('searchQ')}
                    />
                  </label>
                  <div
                    className={
                      layByScreenKbOpen
                        ? 'open-tabs-form-actions open-tabs-form-actions--with-keyboard'
                        : 'open-tabs-form-actions'
                    }
                  >
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
            <ScreenKeyboard
              visible={layByScreenKbOpen}
              onAction={handleLayByScreenKeyboardAction}
              layout={layByKbLayout}
              className="open-tabs-screen-keyboard layby-detail-screen-kb"
            />
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

              {canCancelLayBy && selected.status === 'active' ? (
                <div className="layby-cancel">
                  <button
                    type="button"
                    className="btn ghost open-tabs-void layby-cancel-start-btn"
                    disabled={busy}
                    onClick={beginCancelWizard}
                  >
                    Cancel lay-by…
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

        {view === 'cancel' && selected && (
          <div className="open-tabs-section layby-cancel-wizard layby-detail-layout">
            <div className="layby-modal-scroll">
              <div className="open-tabs-section-head">
                <h3>Cancel {selected.layByNumber}</h3>
                <button type="button" className="btn ghost" disabled={busy} onClick={cancelWizardBack}>
                  {cancelStep === 'payout' || cancelStep === 'done' ? 'Close' : 'Back'}
                </button>
              </div>
              {formError && <p className="error open-tabs-form-error">{formError}</p>}
              {cancelSuccess && (cancelStep === 'payout' || cancelStep === 'done') ? (
                <p className="success open-tabs-form-error" role="status">
                  {cancelSuccess}
                </p>
              ) : null}
              {drawerNotice ? (
                <p className="success open-tabs-form-error" role="status">
                  {drawerNotice}
                </p>
              ) : null}

              {cancelStep === 'summary' ? (
                <>
                  <p className="layby-detail-meta muted">
                    {selected.customerName} · {selected.phone}
                  </p>
                  <div className="layby-summary">
                    <div>Total: {selected.totalInclVat.toFixed(2)}</div>
                    <div>
                      Paid: <strong>{selected.amountPaid.toFixed(2)}</strong>
                    </div>
                    <div>Balance: {selected.balance.toFixed(2)}</div>
                  </div>
                  <p className="muted layby-cancel-hint">
                    Cancelling releases reserved stock. Choose how to settle any amount already paid before confirming.
                  </p>
                  <div className="open-tabs-form-actions">
                    <button type="button" className="btn primary" onClick={() => setCancelStep('mode')}>
                      Continue
                    </button>
                  </div>
                </>
              ) : null}

              {cancelStep === 'mode' ? (
                <>
                  <p className="muted layby-cancel-hint">How should we settle the {selected.amountPaid.toFixed(2)} already paid?</p>
                  <div className="layby-cancel-mode-list">
                    {(['full_refund', 'percent_refund', 'store_credit'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className={`btn layby-cancel-mode-btn${cancelMode === mode ? ' primary' : ' ghost'}`}
                        onClick={() => setCancelMode(mode)}
                      >
                        {cancelModeLabel(mode)}
                      </button>
                    ))}
                  </div>
                  {cancelMode === 'store_credit' ? (
                    <p className="muted layby-cancel-hint">
                      Customer receives store credit on {selected.phone} — not cash from the till.
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
                  {!cancelPercentValid() && cancelMode === 'percent_refund' ? (
                    <p className="error small">Enter a percentage between 1 and 100.</p>
                  ) : null}
                  <div className="open-tabs-form-actions">
                    <button
                      type="button"
                      className="btn primary"
                      disabled={!cancelPercentValid()}
                      onClick={() => setCancelStep('preview')}
                    >
                      Review settlement
                    </button>
                  </div>
                </>
              ) : null}

              {cancelStep === 'preview' && cancelPreview ? (
                <>
                  <p className="muted layby-cancel-hint">
                    Settlement for <strong>{cancelModeLabel(cancelMode)}</strong>
                    {cancelMode === 'percent_refund' ? ` (${cancelPct}%)` : ''}:
                  </p>
                  {renderCancelSettlementPreview(cancelPreview)}
                  {!cancelPreviewValid() ? (
                    <p className="error small">Refund amount must be greater than zero.</p>
                  ) : null}
                  <div className="open-tabs-form-actions">
                    <button
                      type="button"
                      className="btn ghost open-tabs-void"
                      disabled={busy || !cancelPreviewValid()}
                      onClick={() => void submitCancelLayBy()}
                    >
                      {busy ? 'Cancelling…' : 'Confirm cancellation'}
                    </button>
                  </div>
                </>
              ) : null}

              {cancelStep === 'payout' && cancelSettlement ? (
                <>
                  <p className="refund-payout-total-line">
                    Pay customer <strong>R {cancelSettlement.refundCash.toFixed(2)}</strong> cash from the till.
                  </p>
                  {cancelSettlement.refundCard > 0.005 ? (
                    <p className="muted layby-cancel-hint">
                      Also process card reversal of R {cancelSettlement.refundCard.toFixed(2)} on the card terminal.
                    </p>
                  ) : null}
                  <div className="refund-payout-actions">
                    <button
                      type="button"
                      className="btn checkout-btn cash-checkout-btn"
                      disabled={busy}
                      onClick={() => void openDrawerForCancelPayout()}
                    >
                      Open cash drawer
                    </button>
                  </div>
                  <div className="open-tabs-form-actions">
                    <button type="button" className="btn primary" onClick={finishCancelWizard}>
                      Done
                    </button>
                  </div>
                </>
              ) : null}

              {cancelStep === 'done' ? (
                <div className="open-tabs-form-actions">
                  <button type="button" className="btn primary" onClick={finishCancelWizard}>
                    Done
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
