import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch, subscribeServerReachability } from '../api/client'
import { loadProductPresetsWithMigration, pushProductPresets } from '../api/productPresetsApi'
import type {
  CartLine,
  CreateOpenTabModalInput,
  HouseAccountRow,
  OpenTabDetail,
  OpenTabListItem,
  OpenTabKind,
  Product,
  QuoteDetail,
  QuoteListItem,
  Sale,
  SaleLine,
  SaleRefundPreview,
  SaleRefundSettlement,
  ShiftReport,
} from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { canManageShifts, canOverridePriceOnPos, canRefundSales, isPosManager } from '../auth/permissions'
import {
  AssignPresetModal,
  ConfirmPresetDeleteModal,
  HouseAccountsModal,
  LayByModal,
  OpenTabsModal,
  QuotesModal,
  RefundSaleIdModal,
  ShiftEndModal,
  ScreenKeyboard,
  type ScreenKeyboardAction,
} from '../components'
import {
  assignPresetEntry,
  PRESET_ENTRY_MAX,
  presetEntriesForPath,
  readProductPresets,
  removePresetAt,
  uniquePresetCategories,
  uniquePresetSubCategories,
  type PresetEntry,
  type ProductPresetsState,
} from '../register/posProductPresets'
import { jobCardCustomerDisplay } from '../utils/openTabDisplay'
import { playPosKeySound } from '../audio/posKeySound'
import { PosShell } from '../layouts/PosShell'
import { readPosPrinterSettings, type PosPrinterSettings } from '../printer/posPrinterSettings'
import {
  createClientLocalId,
  enqueueOfflineSale,
  flushOfflineSalesWithTillCode,
  getOfflineSalesSyncStatus,
  getOfflinePendingSalesCount,
  isLikelyNetworkError,
} from '../offline/offlineSalesQueue'
import type { OfflineSyncedItemSummary } from '../offline/offlineSalesQueue'
import { isCatalogSnapshotStale, loadCatalogCache, saveCatalogCache } from '../offline/catalogCache'
import {
  productAvailabilityCaptionWithMode,
  productAvailableUnits,
  productHasSellableStock,
  productTracksInventory,
} from '../utils/productInventory'
import { formatDateDdMmYyyy } from '../utils/dateFormat'
import { hasVolumeTiering, lineTotalsForProduct, type ProductForVolume } from '../utils/volumePrice'

const LAST_RECEIPT_STORAGE_KEY = 'electropos-pos-last-receipt-sale'
const POS_TILL_CODE = (import.meta.env.VITE_POS_TILL_CODE?.trim().toUpperCase() || 'T1').slice(0, 24)
const OFFLINE_OVERSALE_MAX_UNITS = 3
const ONLINE_OVERSALE_MAX_UNITS = 3

type ReceiptPrintPayload = {
  transport: unknown
  receipt: unknown
  columns: number
  cut: boolean
}

type LastReceiptForReprint =
  | { kind: 'sale'; sale: Sale }
  | { kind: 'raw'; payload: ReceiptPrintPayload; successNotice?: string }

type StockOverridePromptState = {
  open: boolean
  scope: 'offline' | 'online'
  productName: string
  available: number
  maxUnits: number
}

function readStoredLastReceiptSale(): Sale | null {
  try {
    const raw = localStorage.getItem(LAST_RECEIPT_STORAGE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as Sale
    if (!data || typeof data._id !== 'string') return null
    return data
  } catch {
    return null
  }
}

function roundCartMoney(n: number) {
  return Math.round(n * 100) / 100
}

type RefundSession = {
  routeSaleId: string
  previewSale: Sale
  refundPreview: SaleRefundPreview['refund']
}

function cartLinesFromRefundPreview(sale: Sale, refund: SaleRefundPreview['refund']): CartLine[] {
  const lines: CartLine[] = []
  for (const prog of refund.lines) {
    if (prog.remainingQty <= 0.005) continue
    const item = sale.items[prog.index]
    if (!item) continue
    const pid = item.product ? String(item.product) : `__refund_line_${prog.index}`
    lines.push({
      productId: pid,
      name: item.name,
      quantity: prog.remainingQty,
      unitPrice: item.unitPrice,
      listUnitPrice: item.listUnitPrice,
      refundSaleLineIndex: prog.index,
      refundQtyMax: prog.remainingQty,
      volumeSegments: undefined,
    })
  }
  return lines
}

function enrichCartLine(p: Product | undefined, line: CartLine): CartLine {
  if (!p) {
    return { ...line, volumeSegments: undefined }
  }
  const pf: ProductForVolume = p
  if (!hasVolumeTiering(pf)) {
    return { ...line, volumeSegments: undefined }
  }
  const { volumeSegments, displayUnitPrice } = lineTotalsForProduct(pf, line.quantity)
  return {
    ...line,
    unitPrice: displayUnitPrice,
    listUnitPrice: p.price,
    volumeSegments,
  }
}

function cartLineSubtotal(l: CartLine) {
  if (l.volumeSegments?.length) {
    return roundCartMoney(l.volumeSegments.reduce((s, g) => s + g.lineTotal, 0))
  }
  return roundCartMoney(l.quantity * l.unitPrice)
}

function jobCardLabourAmountForLine(product: Product | undefined, quantity: number): number {
  const per = product?.jobCardLabourPerUnit
  if (per == null || !Number.isFinite(per) || per <= 0) return 0
  return roundCartMoney(per * quantity)
}

function cartLineTotalIncludingJobLabour(
  l: CartLine,
  product: Product | undefined,
  jobCardLabourActive: boolean,
): number {
  const material = cartLineSubtotal(l)
  if (!jobCardLabourActive) return material
  return roundCartMoney(material + jobCardLabourAmountForLine(product, l.quantity))
}

function saleItemsForOfflineReceiptPreview(
  cart: CartLine[],
  products: Product[],
  jobCardLabourActive: boolean,
): Sale['items'] {
  const items: Sale['items'] = []
  for (const l of cart) {
    const p = products.find((x) => x._id === l.productId)
    const lineTotal = cartLineSubtotal(l)
    items.push({
      product: l.productId,
      name: l.name,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      listUnitPrice: l.listUnitPrice,
      lineTotal,
    })
    if (jobCardLabourActive) {
      const lab = jobCardLabourAmountForLine(p, l.quantity)
      if (lab > 0.0001) {
        items.push({
          name: `Labour — ${l.name}`,
          quantity: 1,
          unitPrice: lab,
          lineTotal: lab,
        })
      }
    }
  }
  return items
}

function cartHasVolumePricedLine(cart: CartLine[], products: Product[]) {
  return cart.some((l) => {
    const p = products.find((x) => x._id === l.productId)
    return p && hasVolumeTiering(p)
  })
}

function resolveCashierDisplayName(user: { displayName?: string; email?: string } | null | undefined): string | undefined {
  const byProfile = user?.displayName?.trim()
  if (byProfile) return byProfile
  const raw = user?.email?.split('@')[0]?.trim()
  if (!raw) return undefined
  const cleaned = raw.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return undefined
  return cleaned
    .split(' ')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function cartContributorKey(l: Pick<CartLine, 'addedByUserId' | 'addedByDisplayName'>): string {
  return `${(l.addedByUserId ?? '').trim()}\t${(l.addedByDisplayName ?? '').trim()}`
}

function lineAttributionFromSession(user: { id?: string; displayName?: string; email?: string } | null | undefined): Pick<
  CartLine,
  'addedByUserId' | 'addedByDisplayName' | 'addedAt'
> {
  return {
    addedByUserId: user?.id ? String(user.id) : undefined,
    addedByDisplayName: resolveCashierDisplayName(user) ?? 'Staff',
    addedAt: new Date().toISOString(),
  }
}

function totalCartQtyForProduct(cartLines: CartLine[], productId: string): number {
  return cartLines.reduce((s, l) => s + (l.productId === productId ? l.quantity : 0), 0)
}

function openTabPersistLineBody(l: CartLine) {
  return {
    productId: l.productId,
    name: l.name,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    listUnitPrice: l.listUnitPrice,
    ...(l.addedByUserId ? { addedByUserId: l.addedByUserId } : {}),
    ...(l.addedByDisplayName ? { addedByDisplayName: l.addedByDisplayName } : {}),
    ...(l.addedAt ? { addedAt: l.addedAt } : {}),
  }
}

function saleRequestLineBody(l: CartLine) {
  return {
    productId: l.productId,
    name: l.name,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    stockOverrideApproved: l.stockOverrideApproved === true,
    stockOverrideScope: l.stockOverrideScope,
    stockOverrideAvailableQty: l.stockOverrideAvailableQty,
    ...(l.addedByUserId ? { addedByUserId: l.addedByUserId } : {}),
    ...(l.addedByDisplayName ? { addedByDisplayName: l.addedByDisplayName } : {}),
    ...(l.addedAt ? { addedAt: l.addedAt } : {}),
  }
}

function persistLastReceiptSale(sale: Sale): void {
  try {
    localStorage.setItem(LAST_RECEIPT_STORAGE_KEY, JSON.stringify(sale))
  } catch {
    /* quota / private mode */
  }
}

export function Register() {
  const { session } = useAuth()
  const isAdmin = isPosManager(session?.user)
  const canRefund = canRefundSales(session?.user)
  const canShiftEnd = canManageShifts(session?.user)
  const [products, setProducts] = useState<Product[]>([])
  const [filter, setFilter] = useState('')
  const [skuInput, setSkuInput] = useState('')
  const [registerLeftPanel, setRegisterLeftPanel] = useState<'keys' | 'presets' | 'list'>('keys')
  const [presetsState, setPresetsState] = useState(() => readProductPresets())
  const [assignPresetProduct, setAssignPresetProduct] = useState<Product | null>(null)
  const [presetDeleteIndex, setPresetDeleteIndex] = useState<number | null>(null)
  const [presetNav, setPresetNav] = useState<
    | { screen: 'categories' }
    | { screen: 'subs'; category: string }
    | { screen: 'items'; category: string; subCategory: string }
  >({ screen: 'categories' })
  const [itemListScreenKbOpen, setItemListScreenKbOpen] = useState(false)
  const [cart, setCart] = useState<CartLine[]>([])
  const [openTabsModalOpen, setOpenTabsModalOpen] = useState(false)
  const [quotesModalOpen, setQuotesModalOpen] = useState(false)
  const [quotesList, setQuotesList] = useState<QuoteListItem[]>([])
  const [quotesLoading, setQuotesLoading] = useState(false)
  const [activeQuoteId, setActiveQuoteId] = useState<string | null>(null)
  const [activeQuoteBanner, setActiveQuoteBanner] = useState<{
    quoteNumber: string
    validUntil: string
  } | null>(null)
  const [layByModalOpen, setLayByModalOpen] = useState(false)
  const [openTabsList, setOpenTabsList] = useState<OpenTabListItem[]>([])
  const [openTabsLoading, setOpenTabsLoading] = useState(false)
  const [activeOpenTabId, setActiveOpenTabId] = useState<string | null>(null)
  const [activeTabBanner, setActiveTabBanner] = useState<{
    kind: OpenTabKind
    tabNumber: string
    jobNumber?: string
    customerName: string
    phone: string
  } | null>(null)
  const [receiptEnabled, setReceiptEnabled] = useState(() => readPosPrinterSettings().autoPrintReceipt)
  const [printerSettings, setPrinterSettings] = useState<PosPrinterSettings>(() => readPosPrinterSettings())
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [lastSale, setLastSale] = useState<Sale | null>(null)
  const [lastReceiptForReprint, setLastReceiptForReprint] = useState<LastReceiptForReprint | null>(() => {
    const sale = readStoredLastReceiptSale()
    return sale ? { kind: 'sale', sale } : null
  })
  const [showChangeView, setShowChangeView] = useState(false)
  const [lastChangeDue, setLastChangeDue] = useState<number | null>(null)
  const [lastTendered, setLastTendered] = useState<number | null>(null)
  const [lastCardAmount, setLastCardAmount] = useState<number | null>(null)
  const [lastTotal, setLastTotal] = useState<number | null>(null)
  const [pendingSplit, setPendingSplit] = useState<{
    total: number
    cashReceived: number
    cardReceived: number
    storeCreditApplied: number
    storeCreditPhone: string
    onAccountApplied: number
    houseAccountId: string
    houseAccountNumber: string
    houseAccountName: string
    purchaseOrderNumber: string
    amountDue: number
  } | null>(null)
  const [voucherPhone, setVoucherPhone] = useState('')
  const [voucherAmountStr, setVoucherAmountStr] = useState('')
  const [voucherBalanceHint, setVoucherBalanceHint] = useState<number | null>(null)
  const [voucherNameHint, setVoucherNameHint] = useState('')
  const [lastStoreCredit, setLastStoreCredit] = useState<number | null>(null)

  // Refs so global key handling always sees the latest buffer/products
  const skuInputRef = useRef(skuInput)
  const productsRef = useRef(products)
  skuInputRef.current = skuInput
  productsRef.current = products

  const discountHoldRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null
    longPressDone: boolean
    startX: number
    startY: number
  }>({ timer: null, longPressDone: false, startX: 0, startY: 0 })
  const skipNextDiscountClickRef = useRef(false)

  const productPresetHoldRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null
    longPressDone: boolean
    startX: number
    startY: number
  }>({ timer: null, longPressDone: false, startX: 0, startY: 0 })
  const skipNextProductAddRef = useRef(false)

  const presetItemDeleteHoldRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null
    longPressDone: boolean
    startX: number
    startY: number
    entryIndex: number | null
  }>({ timer: null, longPressDone: false, startX: 0, startY: 0, entryIndex: null })
  const skipNextPresetItemTapRef = useRef(false)

  const LONG_PRESET_ASSIGN_MS = 550
  const PRESET_POINTER_MOVE_PX = 14

  const voucherKbBlurTimerRef = useRef<number | null>(null)
  const voucherKbFieldRef = useRef<'phone' | 'amount'>('phone')
  const voucherPhoneInputRef = useRef<HTMLInputElement | null>(null)
  const voucherAmountInputRef = useRef<HTMLInputElement | null>(null)
  const [voucherScreenKbOpen, setVoucherScreenKbOpen] = useState(false)
  const [voucherFormOpen, setVoucherFormOpen] = useState(false)
  const [houseAccountsModalOpen, setHouseAccountsModalOpen] = useState(false)
  const [houseAccountsModalMode, setHouseAccountsModalMode] = useState<'checkout' | 'payment'>('checkout')
  const [refundSaleIdModalOpen, setRefundSaleIdModalOpen] = useState(false)
  const [refundSession, setRefundSession] = useState<RefundSession | null>(null)
  const [refundNote, setRefundNote] = useState('')
  const [refundCreditPhone, setRefundCreditPhone] = useState('')
  const refundCartKbBlurTimerRef = useRef<number | null>(null)
  const refundCartKbTargetRef = useRef<'note' | 'phone'>('note')
  const refundNoteInputRef = useRef<HTMLTextAreaElement | null>(null)
  const refundPhoneInputRef = useRef<HTMLInputElement | null>(null)
  const [refundCartScreenKbOpen, setRefundCartScreenKbOpen] = useState(false)
  const [refundCartKbTarget, setRefundCartKbTarget] = useState<'note' | 'phone'>('note')
  const [shiftEndModalOpen, setShiftEndModalOpen] = useState(false)
  const [houseAccountForCheckout, setHouseAccountForCheckout] = useState<HouseAccountRow | null>(null)
  const [houseAccountPaymentTarget, setHouseAccountPaymentTarget] = useState<HouseAccountRow | null>(null)
  const [houseAccountPaymentAmountStr, setHouseAccountPaymentAmountStr] = useState('')
  const [houseAccountPaymentMethod, setHouseAccountPaymentMethod] = useState<'cash' | 'card'>('cash')
  const [houseAccountPaymentKbOpen, setHouseAccountPaymentKbOpen] = useState(false)
  const [onAccountPoNumber, setOnAccountPoNumber] = useState('')
  const [onAccountPoKbOpen, setOnAccountPoKbOpen] = useState(false)
  const [houseAccountFormOpen, setHouseAccountFormOpen] = useState(false)
  const [altPaymentExpanded, setAltPaymentExpanded] = useState(false)
  const [lastOnAccount, setLastOnAccount] = useState<number | null>(null)
  const [offlinePendingCount, setOfflinePendingCount] = useState(0)
  const [catalogSnapshotSyncedAt, setCatalogSnapshotSyncedAt] = useState<string | null>(null)
  const [catalogSnapshotStale, setCatalogSnapshotStale] = useState(false)
  const [offlineCatalogMode, setOfflineCatalogMode] = useState(false)
  const [serverReachable, setServerReachable] = useState(true)
  const [offlineSyncStatus, setOfflineSyncStatus] = useState<{
    lastAttemptAt?: string
    lastSuccessAt?: string
    lastError?: string
  }>({})
  const [offlineReconcileModalOpen, setOfflineReconcileModalOpen] = useState(false)
  const [offlineReconcileItems, setOfflineReconcileItems] = useState<OfflineSyncedItemSummary[]>([])
  const [offlineReconcileSyncedAt, setOfflineReconcileSyncedAt] = useState<string | null>(null)
  const [stockOverridePrompt, setStockOverridePrompt] = useState<StockOverridePromptState>({
    open: false,
    scope: 'offline',
    productName: '',
    available: 0,
    maxUnits: OFFLINE_OVERSALE_MAX_UNITS,
  })
  const stockOverrideResolveRef = useRef<((approved: boolean) => void) | null>(null)
  const altPaymentsOfflineDisabled = offlineCatalogMode

  useEffect(() => subscribeServerReachability(setServerReachable), [])

  useEffect(() => {
    return () => {
      if (stockOverrideResolveRef.current) {
        stockOverrideResolveRef.current(false)
        stockOverrideResolveRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    // Keep an up-to-date copy for actions (print / drawer).
    setPrinterSettings(readPosPrinterSettings())
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'electropos-pos-printer-settings') setPrinterSettings(readPosPrinterSettings())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const s = await loadProductPresetsWithMigration()
        if (!cancelled) setPresetsState(s)
      } catch {
        if (!cancelled) {
          setPresetsState(readProductPresets())
          setNotice('Presets could not load from server — using this device until sync works.')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  function persistPresets(next: ProductPresetsState, prev: ProductPresetsState) {
    void pushProductPresets(next).catch(() => {
      setNotice('Could not sync presets to the server.')
      setPresetsState(prev)
    })
  }

  useEffect(() => {
    if (cart.length === 0) {
      setVoucherFormOpen(false)
      setHouseAccountFormOpen(false)
      setHouseAccountForCheckout(null)
      setOnAccountPoNumber('')
      setOnAccountPoKbOpen(false)
      setAltPaymentExpanded(false)
    }
  }, [cart.length])

  useEffect(() => {
    if (!altPaymentExpanded) {
      setVoucherFormOpen(false)
      setHouseAccountFormOpen(false)
      setVoucherScreenKbOpen(false)
      setOnAccountPoKbOpen(false)
    }
  }, [altPaymentExpanded])

  useEffect(() => {
    if (!altPaymentsOfflineDisabled) return
    setAltPaymentExpanded(false)
    setVoucherFormOpen(false)
    setHouseAccountFormOpen(false)
    setVoucherScreenKbOpen(false)
    setOnAccountPoKbOpen(false)
  }, [altPaymentsOfflineDisabled])

  useEffect(() => {
    if (!voucherFormOpen) setVoucherScreenKbOpen(false)
  }, [voucherFormOpen])

  useEffect(() => {
    if (!offlineCatalogMode) return
    setLayByModalOpen(false)
  }, [offlineCatalogMode])

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      const result = await flushOfflineSalesWithTillCode(POS_TILL_CODE, 20)
      const pending = await getOfflinePendingSalesCount()
      const syncStatus = getOfflineSalesSyncStatus()
      if (cancelled) return
      setOfflinePendingCount(pending)
      setOfflineSyncStatus(syncStatus)
      if (result.synced > 0) {
        setNotice(`Synced ${result.synced} offline sale${result.synced === 1 ? '' : 's'}.`)
        if (result.syncedItems.length > 0) {
          if (isAdmin) {
            setOfflineReconcileItems(result.syncedItems)
            setOfflineReconcileSyncedAt(new Date().toISOString())
            setOfflineReconcileModalOpen(true)
          } else {
            const units = result.syncedItems.reduce((sum, item) => sum + item.qty, 0)
            setNotice(
              `Synced ${result.synced} offline sale${result.synced === 1 ? '' : 's'} (${units} unit${units === 1 ? '' : 's'}). Ask manager to run stock reconciliation.`,
            )
          }
        }
        void loadProducts({ hydrateFromCache: false })
      }
    }
    void tick()
    const timer = window.setInterval(() => {
      void tick()
    }, 10000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  function parseTenderedInput(raw: string, fallback: number): number {
    const tenderedRaw = raw.trim()
    if (!tenderedRaw) return fallback
    if (tenderedRaw.includes('.') || tenderedRaw.includes(',')) {
      return Number(tenderedRaw.replace(',', '.'))
    }
    const digitsOnly = tenderedRaw.replace(/\D/g, '')
    if (!digitsOnly) return Number.NaN
    const n = Number(digitsOnly)
    if (!Number.isFinite(n)) return Number.NaN
    // Keypad has no implicit "cents" mode: digits are whole currency units (500 ≠ 50000).
    return n
  }

  /** New unit price from keypad (decimals with . or ,; whole digits = currency units). */
  function parseOverrideUnitPrice(raw: string): number | null {
    const t = raw.trim()
    if (!t) return null
    if (t.includes('.') || t.includes(',')) {
      const n = Number(t.replace(',', '.'))
      if (!Number.isFinite(n) || n < 0) return null
      return Math.round(n * 100) / 100
    }
    const digitsOnly = t.replace(/\D/g, '')
    if (!digitsOnly) return null
    const n = Number(digitsOnly)
    if (!Number.isFinite(n) || n < 0) return null
    return Math.round(n * 100) / 100
  }

  function round2(n: number) {
    return Math.round(n * 100) / 100
  }

  function normalizePhone(raw: string) {
    return raw.replace(/\D/g, '')
  }

  function maskPhoneForReceipt(digits: string) {
    const d = digits.replace(/\D/g, '')
    if (!d) return '—'
    if (d.length <= 4) return `***${d}`
    return `*** *** ${d.slice(-4)}`
  }

  function clearActiveQuote() {
    setActiveQuoteId(null)
    setActiveQuoteBanner(null)
  }

  function closeQuoteFromCart() {
    clearActiveQuote()
    setCart([])
    setPendingSplit(null)
    setLastSale(null)
    setShowChangeView(false)
    setLastChangeDue(null)
    setLastTendered(null)
    setLastCardAmount(null)
    setLastStoreCredit(null)
    setLastOnAccount(null)
    setLastTotal(null)
    resetVoucherForm()
    setNotice('Quote closed. Cart cleared.')
  }

  function resetVoucherForm() {
    setVoucherPhone('')
    setVoucherAmountStr('')
    setVoucherBalanceHint(null)
    setVoucherNameHint('')
    setVoucherFormOpen(false)
    setOnAccountPoNumber('')
    setOnAccountPoKbOpen(false)
    setHouseAccountFormOpen(false)
    setHouseAccountForCheckout(null)
  }

  function openHouseAccountsForCheckout() {
    if (altPaymentsOfflineDisabled) {
      setError('Alt payment options are unavailable while offline')
      return
    }
    setHouseAccountsModalMode('checkout')
    setHouseAccountsModalOpen(true)
  }

  function openHouseAccountsForPayment() {
    setHouseAccountsModalMode('payment')
    setHouseAccountsModalOpen(true)
  }

  function onAccountRemainingDueAmount() {
    const total = pendingSplit?.total ?? cartTotal
    const prevCash = pendingSplit?.cashReceived ?? 0
    const prevCard = pendingSplit?.cardReceived ?? 0
    const prevSc = pendingSplit?.storeCreditApplied ?? 0
    return round2(total - prevCash - prevCard - prevSc)
  }

  function cancelVoucherKbBlurHide() {
    if (voucherKbBlurTimerRef.current) {
      clearTimeout(voucherKbBlurTimerRef.current)
      voucherKbBlurTimerRef.current = null
    }
  }

  function cancelRefundCartKbBlurHide() {
    if (refundCartKbBlurTimerRef.current) {
      clearTimeout(refundCartKbBlurTimerRef.current)
      refundCartKbBlurTimerRef.current = null
    }
  }

  function scrollVoucherFieldIntoView(which: 'phone' | 'amount') {
    const target = which === 'phone' ? voucherPhoneInputRef.current : voucherAmountInputRef.current
    target?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
  }

  function patchVoucherDecimalString(s: string, action: ScreenKeyboardAction): string {
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
    if (action.type === 'space') return s
    return s
  }

  function handleHouseAccountPaymentKeyboardAction(action: ScreenKeyboardAction) {
    if (action.type === 'enter' || action.type === 'done') {
      setHouseAccountPaymentKbOpen(false)
      return
    }
    setHouseAccountPaymentAmountStr((s) => patchVoucherDecimalString(s, action))
  }

  function handleOnAccountPoKeyboardAction(action: ScreenKeyboardAction) {
    if (action.type === 'enter' || action.type === 'done') {
      setOnAccountPoKbOpen(false)
      return
    }
    if (action.type === 'char') {
      setOnAccountPoNumber((s) => s + action.char)
      return
    }
    if (action.type === 'backspace') {
      setOnAccountPoNumber((s) => s.slice(0, -1))
      return
    }
    if (action.type === 'space') {
      setOnAccountPoNumber((s) => s + ' ')
    }
  }

  function handleVoucherScreenKeyboardAction(action: ScreenKeyboardAction) {
    const f = voucherKbFieldRef.current
    if (action.type === 'enter' || action.type === 'done') {
      setVoucherScreenKbOpen(false)
      return
    }
    if (f === 'phone') {
      if (action.type === 'char' && /\d/.test(action.char)) {
        setVoucherPhone((s) => s + action.char)
        setVoucherBalanceHint(null)
        setVoucherNameHint('')
      } else if (action.type === 'backspace') {
        setVoucherPhone((s) => s.slice(0, -1))
        setVoucherBalanceHint(null)
        setVoucherNameHint('')
      }
      return
    }
    if (f === 'amount') {
      setVoucherAmountStr((s) => patchVoucherDecimalString(s, action))
      return
    }
  }

  function voucherKbHandlers(which: 'phone' | 'amount') {
    return {
      onFocus: () => {
        voucherKbFieldRef.current = which
        cancelRefundCartKbBlurHide()
        setRefundCartScreenKbOpen(false)
        cancelVoucherKbBlurHide()
        setVoucherScreenKbOpen(true)
        window.setTimeout(() => scrollVoucherFieldIntoView(which), 20)
      },
      onBlur: () => {
        cancelVoucherKbBlurHide()
        voucherKbBlurTimerRef.current = window.setTimeout(() => {
          setVoucherScreenKbOpen(false)
        }, 200)
      },
    }
  }

  function scrollRefundCartFieldIntoView(which: 'note' | 'phone') {
    const target = which === 'note' ? refundNoteInputRef.current : refundPhoneInputRef.current
    target?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
  }

  function openRefundCartKeyboard(which: 'note' | 'phone') {
    refundCartKbTargetRef.current = which
    setRefundCartKbTarget(which)
    cancelRefundCartKbBlurHide()
    cancelVoucherKbBlurHide()
    setVoucherScreenKbOpen(false)
    setRefundCartScreenKbOpen(true)
    window.setTimeout(() => scrollRefundCartFieldIntoView(which), 20)
  }

  function refundCartKbHandlers(which: 'note' | 'phone') {
    return {
      onFocus: () => openRefundCartKeyboard(which),
      // Some touchscreen kiosk sessions don't fire focus consistently.
      // Open keyboard on pointer/tap as a fallback.
      onPointerDown: () => openRefundCartKeyboard(which),
      onTouchStart: () => openRefundCartKeyboard(which),
      onClick: () => openRefundCartKeyboard(which),
      // Keep refund keyboard sticky on kiosk touch sessions.
      // Blur can fire spuriously while tapping between fields and was
      // immediately closing the keyboard on some Posiflex runs.
      onBlur: () => {},
    }
  }

  function handleRefundCartScreenKeyboardAction(action: ScreenKeyboardAction) {
    const f = refundCartKbTargetRef.current
    if (action.type === 'done') {
      setRefundCartScreenKbOpen(false)
      return
    }
    if (action.type === 'enter') {
      if (f === 'phone') setRefundCartScreenKbOpen(false)
      return
    }
    if (f === 'note') {
      if (action.type === 'char') setRefundNote((s) => s + action.char)
      else if (action.type === 'backspace') setRefundNote((s) => s.slice(0, -1))
      else if (action.type === 'space') setRefundNote((s) => s + ' ')
      return
    }
    if (f === 'phone') {
      if (action.type === 'char' && /\d/.test(action.char)) {
        setRefundCreditPhone((s) => s + action.char)
      } else if (action.type === 'backspace') {
        setRefundCreditPhone((s) => s.slice(0, -1))
      }
    }
  }

  const loadProducts = useCallback(async (opts?: { hydrateFromCache?: boolean }) => {
    setError(null)
    const hydrateFromCache = opts?.hydrateFromCache !== false
    const shouldHydrateFromCache = hydrateFromCache && productsRef.current.length === 0
    const cached = shouldHydrateFromCache ? await loadCatalogCache() : { products: [], syncedAt: null as string | null }
    if (cached.products.length > 0) {
      setProducts(cached.products)
      setCatalogSnapshotSyncedAt(cached.syncedAt)
      setCatalogSnapshotStale(isCatalogSnapshotStale(cached.syncedAt))
    }

    try {
      const list = await apiFetch<Product[]>('/products')
      setProducts(list)
      const syncedAt = new Date().toISOString()
      setCatalogSnapshotSyncedAt(syncedAt)
      setCatalogSnapshotStale(false)
      setOfflineCatalogMode(false)
      try {
        await saveCatalogCache(list)
      } catch {
        // Non-blocking: UI still uses fresh online list.
      }
    } catch (e) {
      if (cached.products.length > 0 && isLikelyNetworkError(e)) {
        setOfflineCatalogMode(true)
        setNotice(
          `Server unavailable. Using offline catalog snapshot${cached.syncedAt ? ` from ${new Date(cached.syncedAt).toLocaleString()}` : ''
          }.`,
        )
        return
      }
      if (!isLikelyNetworkError(e)) setOfflineCatalogMode(false)
      const message = e instanceof Error ? e.message : 'Failed to load products'
      if (productsRef.current.length > 0) {
        const lower = message.toLowerCase()
        if (
          lower.includes('unauthorized') ||
          lower.includes('session expired') ||
          lower.includes('invalid refresh token')
        ) {
          setError(`Catalog refresh failed: ${message}. Please sign out and sign in again.`)
        } else {
          setError(`Catalog refresh failed: ${message}. Displayed stock may be stale.`)
        }
        return
      }
      setError(message)
    }
  }, [])

  const applyOfflineStockDeduction = useCallback(async (lines: CartLine[]) => {
    const qtyByProduct = new Map<string, number>()
    for (const line of lines) {
      const next = (qtyByProduct.get(line.productId) ?? 0) + Math.max(0, Number(line.quantity) || 0)
      qtyByProduct.set(line.productId, next)
    }
    if (qtyByProduct.size === 0) return

    const updatedProducts = productsRef.current.map((p) => {
      const qty = qtyByProduct.get(p._id)
      if (!qty || !productTracksInventory(p)) return p

      const nextStock = Math.max(0, Math.round((Number(p.stock ?? 0) - qty) * 1000) / 1000)
      const nextAvailableRaw =
        p.availableQty == null ? null : Math.round((Number(p.availableQty ?? 0) - qty) * 1000) / 1000
      const nextAvailable = nextAvailableRaw == null ? null : Math.max(0, nextAvailableRaw)

      return {
        ...p,
        stock: nextStock,
        availableQty: nextAvailable,
      }
    })

    setProducts(updatedProducts)
    try {
      await saveCatalogCache(updatedProducts)
    } catch {
      // Non-blocking: in-memory stock is already updated for this session.
    }
  }, [])

  useEffect(() => {
    void loadProducts()
  }, [loadProducts])

  useEffect(() => {
    if (activeTabBanner?.phone) {
      setVoucherPhone((prev) => prev || normalizePhone(activeTabBanner.phone))
    }
  }, [activeTabBanner?.phone])

  useEffect(() => {
    return () => {
      if (voucherKbBlurTimerRef.current) clearTimeout(voucherKbBlurTimerRef.current)
      if (refundCartKbBlurTimerRef.current) clearTimeout(refundCartKbBlurTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (showChangeView) setVoucherScreenKbOpen(false)
    if (cart.length === 0 && !pendingSplit) setVoucherScreenKbOpen(false)
    if (showChangeView) setRefundCartScreenKbOpen(false)
  }, [showChangeView, cart.length, pendingSplit])

  useEffect(() => {
    if (!refundSession || !refundCartScreenKbOpen) return
    const t = window.setTimeout(() => scrollRefundCartFieldIntoView(refundCartKbTargetRef.current), 40)
    return () => clearTimeout(t)
  }, [refundSession, refundCartScreenKbOpen, refundCartKbTarget])

  useEffect(() => {
    if (!voucherFormOpen || !voucherScreenKbOpen) return
    const t = window.setTimeout(() => {
      scrollVoucherFieldIntoView(voucherKbFieldRef.current)
    }, 40)
    return () => window.clearTimeout(t)
  }, [voucherFormOpen, voucherScreenKbOpen])

  useEffect(() => {
    const hold = discountHoldRef.current
    return () => {
      if (hold.timer) clearTimeout(hold.timer)
    }
  }, [])

  const itemListKbBlurTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (registerLeftPanel !== 'list') {
      setItemListScreenKbOpen(false)
    }
  }, [registerLeftPanel])

  useEffect(() => {
    const ph = productPresetHoldRef
    const sh = presetItemDeleteHoldRef
    return () => {
      if (ph.current.timer) clearTimeout(ph.current.timer)
      if (sh.current.timer) clearTimeout(sh.current.timer)
    }
  }, [])

  useEffect(() => {
    if (registerLeftPanel !== 'presets') {
      setPresetNav({ screen: 'categories' })
    }
  }, [registerLeftPanel])

  useEffect(() => {
    return () => {
      if (itemListKbBlurTimerRef.current) clearTimeout(itemListKbBlurTimerRef.current)
    }
  }, [])

  function cancelItemListKbBlurHide() {
    if (itemListKbBlurTimerRef.current) {
      clearTimeout(itemListKbBlurTimerRef.current)
      itemListKbBlurTimerRef.current = null
    }
  }

  function handleItemListScreenKeyboardAction(action: ScreenKeyboardAction) {
    if (action.type === 'char') {
      setFilter((f) => f + action.char)
      return
    }
    if (action.type === 'backspace') {
      setFilter((f) => f.slice(0, -1))
      return
    }
    if (action.type === 'space') {
      setFilter((f) => f + ' ')
      return
    }
    if (action.type === 'enter' || action.type === 'done') {
      setItemListScreenKbOpen(false)
    }
  }

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return products
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q),
    )
  }, [products, filter])

  /** Same pool as BackOffice Products category field: distinct product categories (no Uncategorized). */
  const catalogCategoriesForPresetSuggest = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const p of products) {
      const raw = p.category?.trim()
      if (!raw || raw.toLowerCase() === 'uncategorized') continue
      const k = raw.toLowerCase()
      if (seen.has(k)) continue
      seen.add(k)
      out.push(raw)
    }
    out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    return out
  }, [products])

  const presetCategories = useMemo(
    () => uniquePresetCategories(presetsState.entries),
    [presetsState.entries],
  )

  const presetSubCategories = useMemo(() => {
    if (presetNav.screen !== 'subs') return []
    return uniquePresetSubCategories(presetsState.entries, presetNav.category)
  }, [presetNav, presetsState.entries])

  const presetItemsForNav = useMemo(() => {
    if (presetNav.screen !== 'items') return []
    return presetEntriesForPath(
      presetsState.entries,
      presetNav.category,
      presetNav.subCategory,
    )
  }, [presetNav, presetsState.entries])

  const loadOpenTabsList = useCallback(async () => {
    setOpenTabsLoading(true)
    try {
      const list = await apiFetch<OpenTabListItem[]>('/tabs/open')
      setOpenTabsList(list)
    } catch {
      /* non-fatal */
    } finally {
      setOpenTabsLoading(false)
    }
  }, [])

  const loadQuotesList = useCallback(async (q: string, phone: string) => {
    setQuotesLoading(true)
    try {
      const qs = new URLSearchParams()
      if (q.trim()) qs.set('q', q.trim())
      const ph = normalizePhone(phone)
      if (ph) qs.set('phone', ph)
      const path = qs.toString() ? `/quotes?${qs}` : '/quotes'
      const list = await apiFetch<QuoteListItem[]>(path)
      setQuotesList(list)
    } catch {
      setQuotesList([])
    } finally {
      setQuotesLoading(false)
    }
  }, [])

  async function handleSaveQuote(input: { customerName: string; phone: string }) {
    await apiFetch('/quotes', {
      method: 'POST',
      body: JSON.stringify({
        customerName: input.customerName,
        phone: input.phone,
        items: cart.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          listUnitPrice: l.listUnitPrice,
        })),
      }),
    })
  }

  async function handleLoadQuote(id: string) {
    if (refundSession) {
      setError('Exit refund mode before loading a quote')
      return
    }
    if (activeOpenTabId) {
      setError('Finish or close tab before loading a quote')
      return
    }
    if (cart.length > 0 && !window.confirm('Replace current cart with this quote?')) return
    setError(null)
    try {
      const detail = await apiFetch<QuoteDetail>(`/quotes/${id}`)
      if (detail.status !== 'open') {
        setError('Quote is no longer open')
        return
      }
      if (detail.isExpired) {
        setError('Quote has expired')
        return
      }
      setActiveQuoteId(detail._id)
      setActiveQuoteBanner({
        quoteNumber: detail.quoteNumber,
        validUntil: detail.validUntil,
      })
      setCart(
        detail.lines.map((l) => {
          const pid = typeof l.productId === 'string' ? l.productId : String(l.productId)
          const p = products.find((x) => x._id === pid)
          return enrichCartLine(p, {
            productId: pid,
            name: l.name,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            listUnitPrice: l.listUnitPrice,
          })
        }),
      )
      setQuotesModalOpen(false)
      setNotice(`Loaded quote ${detail.quoteNumber}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load quote')
    }
  }

  async function persistActiveTabLinesFor(tabId: string, lines: CartLine[]) {
    await apiFetch(`/tabs/${tabId}/lines`, {
      method: 'PUT',
      body: JSON.stringify({
        lines: lines.map(openTabPersistLineBody),
      }),
    })
  }

  function findProductBySkuOrBarcode(raw: string): Product | undefined {
    const q = raw.trim()
    if (!q) return undefined
    const numeric = q.replace(/\D/g, '')
    const qLower = q.toLowerCase()
    const all = productsRef.current
    return (
      all.find((p) => p.sku.toLowerCase() === qLower) ??
      all.find((p) => (p.barcode ?? '').toLowerCase() === qLower) ??
      all.find((p) => p.sku.replace(/\D/g, '') === numeric) ??
      all.find((p) => (p.barcode ?? '').replace(/\D/g, '') === numeric)
    )
  }

  function requestStockOverrideConfirmation(input: {
    scope: 'offline' | 'online'
    productName: string
    available: number
    maxUnits: number
  }) {
    return new Promise<boolean>((resolve) => {
      if (stockOverrideResolveRef.current) stockOverrideResolveRef.current(false)
      stockOverrideResolveRef.current = resolve
      setStockOverridePrompt({
        open: true,
        scope: input.scope,
        productName: input.productName,
        available: input.available,
        maxUnits: input.maxUnits,
      })
    })
  }

  function settleStockOverrideConfirmation(approved: boolean) {
    setStockOverridePrompt((prev) => ({ ...prev, open: false }))
    const resolve = stockOverrideResolveRef.current
    stockOverrideResolveRef.current = null
    resolve?.(approved)
  }

  async function addToCartQty(p: Product, requestedQty: number) {
    if (refundSession) {
      setError('Exit refund mode to add items')
      return
    }
    clearActiveQuote()
    setLastSale(null)
    setNotice(null)
    setShowChangeView(false)
    setLastChangeDue(null)
    setLastTendered(null)
    setLastCardAmount(null)
    setLastStoreCredit(null)
    setLastOnAccount(null)
    setLastTotal(null)
    setPendingSplit(null)
    if (requestedQty < 1 || !Number.isFinite(requestedQty)) {
      setError('Quantity must be a whole number of at least 1')
      return
    }
    const avail = productAvailableUnits(p)
    const hasOfflineSignal = offlineCatalogMode || !serverReachable
    const stockGuard = productTracksInventory(p)
    const overrideScope: 'offline' | 'online' = hasOfflineSignal ? 'offline' : 'online'
    const overrideMaxUnits = overrideScope === 'offline' ? OFFLINE_OVERSALE_MAX_UNITS : ONLINE_OVERSALE_MAX_UNITS
    const strictOfflineStock = (p as Product & { strictOfflineStock?: boolean }).strictOfflineStock === true
    setError(null)
    let partialNotice: string | null = null
    let atStockLimit = false
    let blockedByPolicy = false
    const currentLineQty = totalCartQtyForProduct(cart, p._id)
    let overrideApproved = false
    let overrideMaxAdd = 0

    const needsOverridePrecheck =
      requestedQty > Math.max(0, avail - currentLineQty) &&
      stockGuard &&
      (currentLineQty > 0 || avail < requestedQty)
    if (needsOverridePrecheck) {
      if (overrideScope === 'offline' && strictOfflineStock) {
        setError(`Offline strict-stock item blocked: ${p.name}`)
        return
      }
      if (!isAdmin) {
        setError(`Insufficient stock for ${p.name}. Manager override required while ${overrideScope}.`)
        return
      }
      const allowedTotalQty = Math.max(0, avail) + overrideMaxUnits
      overrideMaxAdd = Math.max(0, allowedTotalQty - currentLineQty)
      if (overrideMaxAdd <= 0) {
        setError(`${overrideScope === 'offline' ? 'Offline' : 'Online'} override limit reached for ${p.name} (max +${overrideMaxUnits}).`)
        return
      }
      const ok = await requestStockOverrideConfirmation({
        scope: overrideScope,
        productName: p.name,
        available: Math.max(0, avail),
        maxUnits: overrideMaxUnits,
      })
      if (!ok) return
      overrideApproved = true
    }

    const approveStockOverride = () => {
      if (overrideApproved) return true
      if (!stockGuard) return false
      if (overrideScope === 'offline' && strictOfflineStock) {
        blockedByPolicy = true
        setError(`Offline strict-stock item blocked: ${p.name}`)
        return false
      }
      if (!isAdmin) {
        blockedByPolicy = true
        setError(`Insufficient stock for ${p.name}. Manager override required while ${overrideScope}.`)
        return false
      }
      const allowedTotalQty = Math.max(0, avail) + overrideMaxUnits
      overrideMaxAdd = Math.max(0, allowedTotalQty - currentLineQty)
      if (overrideMaxAdd <= 0) {
        blockedByPolicy = true
        setError(`${overrideScope === 'offline' ? 'Offline' : 'Online'} override limit reached for ${p.name} (max +${overrideMaxUnits}).`)
        return false
      }
      blockedByPolicy = true
      return false
    }
    if (avail < 1 && !approveStockOverride()) {
      if (!blockedByPolicy) setError(`Out of stock: ${p.name}`)
      return
    }
    setCart((prev) => {
      const stamp = lineAttributionFromSession(session?.user)
      const i = prev.findIndex((l) => l.productId === p._id && cartContributorKey(l) === cartContributorKey(stamp))
      if (i >= 0) {
        const next = [...prev]
        const line = next[i]
        const sumP = totalCartQtyForProduct(prev, p._id)
        const room = avail - sumP
        const toAdd = Math.min(requestedQty, room)
        if (toAdd <= 0) {
          if (!approveStockOverride()) {
            atStockLimit = true
            return prev
          }
          const overrideAdd = Math.min(requestedQty, overrideMaxAdd)
          if (overrideAdd <= 0) {
            atStockLimit = true
            return prev
          }
          const merged = {
            ...line,
            quantity: line.quantity + overrideAdd,
            stockOverrideApproved: true,
            stockOverrideScope: overrideScope,
            stockOverrideAvailableQty: Math.max(0, avail),
          }
          next[i] = enrichCartLine(p, merged)
          partialNotice =
            overrideAdd < requestedQty
              ? `${overrideScope === 'offline' ? 'Offline' : 'Online'} override added ${overrideAdd} of ${requestedQty} (limit +${overrideMaxUnits})`
              : `${overrideScope === 'offline' ? 'Offline' : 'Online'} stock override approved for ${p.name}`
          return next
        }
        if (toAdd < requestedQty) {
          if (approveStockOverride()) {
            const overrideAdd = Math.min(requestedQty, overrideMaxAdd)
            const merged = {
              ...line,
              quantity: line.quantity + overrideAdd,
              stockOverrideApproved: true,
              stockOverrideScope: overrideScope,
              stockOverrideAvailableQty: Math.max(0, avail),
            }
            next[i] = enrichCartLine(p, merged)
            partialNotice =
              overrideAdd < requestedQty
                ? `${overrideScope === 'offline' ? 'Offline' : 'Online'} override added ${overrideAdd} of ${requestedQty} (limit +${overrideMaxUnits})`
                : `${overrideScope === 'offline' ? 'Offline' : 'Online'} stock override approved for ${p.name}`
            return next
          }
          partialNotice = `Added ${toAdd} of ${requestedQty} (${avail} available)`
        }
        const merged = { ...line, quantity: line.quantity + toAdd }
        next[i] = enrichCartLine(p, merged)
        return next
      }
      const sumPNew = totalCartQtyForProduct(prev, p._id)
      const toAdd = Math.min(requestedQty, avail - sumPNew)
      if (toAdd < 1) {
        if (!approveStockOverride()) return prev
        const overrideAdd = Math.min(requestedQty, overrideMaxAdd)
        if (overrideAdd < 1) return prev
        const newLine: CartLine = {
          productId: p._id,
          name: p.name,
          quantity: overrideAdd,
          unitPrice: p.price,
          stockOverrideApproved: true,
          stockOverrideScope: overrideScope,
          stockOverrideAvailableQty: Math.max(0, avail),
          ...stamp,
        }
        partialNotice =
          overrideAdd < requestedQty
            ? `${overrideScope === 'offline' ? 'Offline' : 'Online'} override added ${overrideAdd} of ${requestedQty} (limit +${overrideMaxUnits})`
            : `${overrideScope === 'offline' ? 'Offline' : 'Online'} stock override approved for ${p.name}`
        return [...prev, enrichCartLine(p, newLine)]
      }
      if (toAdd < requestedQty) {
        if (approveStockOverride()) {
          const overrideAdd = Math.min(requestedQty, overrideMaxAdd)
          if (overrideAdd < 1) return prev
          const newLine: CartLine = {
            productId: p._id,
            name: p.name,
            quantity: overrideAdd,
            unitPrice: p.price,
            stockOverrideApproved: true,
            stockOverrideScope: overrideScope,
            stockOverrideAvailableQty: Math.max(0, avail),
            ...stamp,
          }
          partialNotice =
            overrideAdd < requestedQty
              ? `${overrideScope === 'offline' ? 'Offline' : 'Online'} override added ${overrideAdd} of ${requestedQty} (limit +${overrideMaxUnits})`
              : `${overrideScope === 'offline' ? 'Offline' : 'Online'} stock override approved for ${p.name}`
          return [...prev, enrichCartLine(p, newLine)]
        }
        partialNotice = `Added ${toAdd} of ${requestedQty} (${avail} available)`
      }
      const newLine: CartLine = {
        productId: p._id,
        name: p.name,
        quantity: toAdd,
        unitPrice: p.price,
        ...stamp,
      }
      return [...prev, enrichCartLine(p, newLine)]
    })
    if (atStockLimit) {
      if (!blockedByPolicy) setError('This line is already at maximum stock for that product')
      return
    }
    if (overrideApproved && !partialNotice) {
      setNotice(`${overrideScope === 'offline' ? 'Offline' : 'Online'} stock override approved for ${p.name}`)
      return
    }
    if (partialNotice) setNotice(partialNotice)
  }

  function addToCart(p: Product) {
    void addToCartQty(p, 1)
  }

  function bumpRefundLineQty(saleLineIndex: number, delta: number) {
    clearActiveQuote()
    setLastSale(null)
    setNotice(null)
    setPendingSplit(null)
    setLastStoreCredit(null)
    setLastOnAccount(null)
    setCart((prev) => {
      const row = prev.find((l) => l.refundSaleLineIndex === saleLineIndex)
      if (!row || row.refundQtyMax == null) return prev
      const maxQ = row.refundQtyMax
      const nextQty = roundCartMoney(row.quantity + delta)
      if (nextQty <= 0) return prev.filter((l) => l.refundSaleLineIndex !== saleLineIndex)
      if (nextQty > maxQ + 0.0001) return prev
      return prev.map((l) =>
        l.refundSaleLineIndex === saleLineIndex ? { ...l, quantity: nextQty } : l,
      )
    })
  }

  async function bumpCartLineAtIndex(lineIndex: number, delta: number) {
    if (delta === 0) return
    clearActiveQuote()
    setLastSale(null)
    setNotice(null)
    setPendingSplit(null)
    setLastStoreCredit(null)
    setLastOnAccount(null)
    let blockedByPolicy = false
    let partialNotice: string | null = null
    const baseLine = cart[lineIndex]
    if (!baseLine) return
    if (baseLine.refundSaleLineIndex !== undefined) {
      bumpRefundLineQty(baseLine.refundSaleLineIndex, delta)
      return
    }
    const productId = baseLine.productId
    const p = products.find((x) => x._id === productId)
    const max = p ? productAvailableUnits(p) : 999
    const sumP = totalCartQtyForProduct(cart, productId)
    const nextTotal = sumP + delta
    const hasOfflineSignalForBump = offlineCatalogMode || !serverReachable
    const overrideScopeForBump: 'offline' | 'online' = hasOfflineSignalForBump ? 'offline' : 'online'
    let overrideApprovedForBump = false
    if (nextTotal > max && delta > 0) {
      const overrideMaxUnits =
        overrideScopeForBump === 'offline' ? OFFLINE_OVERSALE_MAX_UNITS : ONLINE_OVERSALE_MAX_UNITS
      const stockGuard = !!p && productTracksInventory(p)
      const strictOfflineStock = !!p && (p as Product & { strictOfflineStock?: boolean }).strictOfflineStock === true
      if (stockGuard) {
        if (overrideScopeForBump === 'offline' && strictOfflineStock) {
          setError(`Offline strict-stock item blocked: ${p.name}`)
          return
        }
        if (!isAdmin) {
          setError(`Insufficient stock for ${p.name}. Manager override required while ${overrideScopeForBump}.`)
          return
        }
        const allowedTotalQty = Math.max(0, max) + overrideMaxUnits
        if (nextTotal > allowedTotalQty) {
          setError(
            `${overrideScopeForBump === 'offline' ? 'Offline' : 'Online'} override limit reached for ${p.name} (max +${overrideMaxUnits}).`,
          )
          return
        }
        const ok = await requestStockOverrideConfirmation({
          scope: overrideScopeForBump,
          productName: p.name,
          available: Math.max(0, max),
          maxUnits: overrideMaxUnits,
        })
        if (!ok) return
        overrideApprovedForBump = true
        partialNotice = `${overrideScopeForBump === 'offline' ? 'Offline' : 'Online'} stock override approved for ${p.name}`
      }
    }

    setCart((prev) => {
      const line = prev[lineIndex]
      if (!line || line.productId !== productId) return prev
      if (line.refundSaleLineIndex !== undefined) return prev
      const pLine = products.find((x) => x._id === line.productId)
      const maxUnits = pLine ? productAvailableUnits(pLine) : 999
      const sumAll = totalCartQtyForProduct(prev, line.productId)
      const nextTotalCart = sumAll + delta

      if (delta > 0 && pLine && !hasVolumeTiering(pLine)) {
        const stamp = lineAttributionFromSession(session?.user)
        if (cartContributorKey(line) !== cartContributorKey(stamp)) {
          const newRow: CartLine = {
            productId: line.productId,
            name: line.name,
            quantity: delta,
            unitPrice: line.unitPrice,
            listUnitPrice: line.listUnitPrice,
            stockOverrideApproved: line.stockOverrideApproved,
            stockOverrideScope: line.stockOverrideScope,
            stockOverrideAvailableQty: line.stockOverrideAvailableQty,
            ...stamp,
          }
          const withVol = enrichCartLine(pLine, newRow)
          const ins = [...prev]
          ins.splice(lineIndex + 1, 0, withVol)
          return ins
        }
      }

      const nextQty = line.quantity + delta
      if (nextQty <= 0) return prev.filter((_l, j) => j !== lineIndex)
      if (nextTotalCart > maxUnits) {
        const overrideMaxUnits =
          overrideScopeForBump === 'offline' ? OFFLINE_OVERSALE_MAX_UNITS : ONLINE_OVERSALE_MAX_UNITS
        const stockGuard = !!pLine && productTracksInventory(pLine)
        const strictOfflineStock =
          !!pLine && (pLine as Product & { strictOfflineStock?: boolean }).strictOfflineStock === true
        if (!stockGuard || delta < 0) return prev
        if (!overrideApprovedForBump) return prev
        if (overrideScopeForBump === 'offline' && strictOfflineStock) {
          blockedByPolicy = true
          setError(`Offline strict-stock item blocked: ${pLine.name}`)
          return prev
        }
        if (!isAdmin) {
          blockedByPolicy = true
          setError(`Insufficient stock for ${pLine.name}. Manager override required while ${overrideScopeForBump}.`)
          return prev
        }
        const allowedTotalQty = Math.max(0, maxUnits) + overrideMaxUnits
        if (nextTotalCart > allowedTotalQty) {
          blockedByPolicy = true
          setError(
            `${overrideScopeForBump === 'offline' ? 'Offline' : 'Online'} override limit reached for ${pLine.name} (max +${overrideMaxUnits}).`,
          )
          return prev
        }
        blockedByPolicy = true
        return prev
      }

      return prev.map((l, j) => {
        if (j !== lineIndex) return l
        if (!pLine) {
          return {
            ...l,
            quantity: nextQty,
            ...(overrideApprovedForBump
              ? {
                  stockOverrideApproved: true,
                  stockOverrideScope: overrideScopeForBump,
                  stockOverrideAvailableQty: Math.max(0, maxUnits),
                }
              : {}),
          }
        }
        return enrichCartLine(pLine, {
          ...l,
          quantity: nextQty,
          ...(overrideApprovedForBump
            ? {
                stockOverrideApproved: true,
                stockOverrideScope: overrideScopeForBump,
                stockOverrideAvailableQty: Math.max(0, maxUnits),
              }
            : {}),
        })
      })
    })
    if (!blockedByPolicy && partialNotice) setNotice(partialNotice)
  }

  function bumpCartLineQty(lineIndex: number, delta: number) {
    const line = cart[lineIndex]
    if (!line) return
    if (line.refundSaleLineIndex !== undefined) {
      bumpRefundLineQty(line.refundSaleLineIndex, delta)
      return
    }
    void bumpCartLineAtIndex(lineIndex, delta)
  }

  const cartTotal = useMemo(() => {
    const jobCardLabourActive = activeTabBanner?.kind === 'job_card'
    let s = 0
    for (const l of cart) {
      const p = products.find((x) => x._id === l.productId)
      s += cartLineTotalIncludingJobLabour(l, p, jobCardLabourActive)
    }
    return roundCartMoney(s)
  }, [cart, products, activeTabBanner?.kind])

  useEffect(() => {
    if (!activeOpenTabId || busy) return
    const id = activeOpenTabId
    const lines = cart
    const t = window.setTimeout(() => {
      void persistActiveTabLinesFor(id, lines).catch((e) =>
        setError(e instanceof Error ? e.message : 'Failed to save tab'),
      )
    }, 650)
    return () => clearTimeout(t)
  }, [cart, activeOpenTabId, busy])

  async function selectOpenTab(id: string) {
    if (refundSession) {
      setError('Exit refund mode before opening a tab')
      return
    }
    if (id === activeOpenTabId) {
      setOpenTabsModalOpen(false)
      return
    }
    if (!activeOpenTabId && cart.length > 0) {
      setError('Check out or clear the current sale before opening a tab')
      return
    }
    setError(null)
    try {
      if (activeOpenTabId) {
        await persistActiveTabLinesFor(activeOpenTabId, cart)
      }
      const tab = await apiFetch<OpenTabDetail>(`/tabs/${id}`)
      clearActiveQuote()
      setActiveOpenTabId(id)
      setActiveTabBanner({
        kind: tab.kind ?? 'tab',
        tabNumber: tab.tabNumber,
        jobNumber: tab.jobNumber,
        customerName: tab.customerName,
        phone: tab.phone,
      })
      setCart(
        tab.lines.map((l) => {
          const p = products.find((x) => x._id === l.productId)
          return enrichCartLine(p, {
            productId: l.productId,
            name: l.name,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            listUnitPrice: l.listUnitPrice,
            ...(l.addedByUserId ? { addedByUserId: l.addedByUserId } : {}),
            ...(l.addedByDisplayName ? { addedByDisplayName: l.addedByDisplayName } : {}),
            ...(l.addedAt ? { addedAt: l.addedAt } : {}),
          })
        }),
      )
      setOpenTabsModalOpen(false)
      await loadOpenTabsList()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open tab')
    }
  }

  async function voidOpenTabById(id: string) {
    setError(null)
    try {
      await apiFetch(`/tabs/${id}`, { method: 'DELETE' })
      if (id === activeOpenTabId) {
        setActiveOpenTabId(null)
        setActiveTabBanner(null)
        clearActiveQuote()
        setCart([])
        setLastSale(null)
        setShowChangeView(false)
        setLastChangeDue(null)
        setLastTendered(null)
        setLastCardAmount(null)
        setLastStoreCredit(null)
        setLastOnAccount(null)
        setLastTotal(null)
        setPendingSplit(null)
      }
      await loadOpenTabsList()
      setOpenTabsModalOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not void tab')
    }
  }

  async function createOpenTabFromModal(input: CreateOpenTabModalInput) {
    if (refundSession) {
      throw new Error('Exit refund mode before using tabs')
    }
    if (activeOpenTabId) {
      throw new Error('Use “Close tab” to leave the current tab before creating another')
    }
    const linesPayload = input.includeCurrentCart ? cart.map(openTabPersistLineBody) : []
    const created = await apiFetch<OpenTabDetail>('/tabs', {
      method: 'POST',
      body: JSON.stringify(
        input.mode === 'job_card'
          ? {
              kind: 'job_card',
              customerName: input.customerName,
              phone: input.phone,
              itemCheckedIn: input.itemCheckedIn,
              jobDescription: input.jobDescription,
              attachmentNote: input.attachmentNote,
              lines: linesPayload,
            }
          : {
              tabNumber: input.tabNumber,
              customerName: input.customerName,
              phone: input.phone,
              lines: linesPayload,
            },
      ),
    })
    setLastSale(null)
    setNotice(null)
    setShowChangeView(false)
    setLastChangeDue(null)
    setLastTendered(null)
    setLastCardAmount(null)
    setLastStoreCredit(null)
    setLastOnAccount(null)
    setLastTotal(null)
    setPendingSplit(null)
    setError(null)
    clearActiveQuote()
    setActiveOpenTabId(created._id)
    setActiveTabBanner({
      kind: created.kind ?? 'tab',
      tabNumber: created.tabNumber,
      jobNumber: created.jobNumber,
      customerName: created.customerName,
      phone: created.phone,
    })
    setCart(
      created.lines.map((l) => {
        const p = products.find((x) => x._id === l.productId)
        return enrichCartLine(p, {
          productId: l.productId,
          name: l.name,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          listUnitPrice: l.listUnitPrice,
          ...(l.addedByUserId ? { addedByUserId: l.addedByUserId } : {}),
          ...(l.addedByDisplayName ? { addedByDisplayName: l.addedByDisplayName } : {}),
          ...(l.addedAt ? { addedAt: l.addedAt } : {}),
        })
      }),
    )
    if (input.mode === 'job_card') {
      const jobNo = created.jobNumber ?? created.tabNumber
      const printed = await printJobCardOpeningSlips({
        jobNumber: jobNo,
        customerName: created.customerName,
        phone: created.phone ?? '',
        itemCheckedIn: created.itemCheckedIn ?? input.itemCheckedIn,
        jobDescription: created.jobDescription ?? input.jobDescription,
        attachmentNote: created.attachmentNote ?? input.attachmentNote,
      })
      if (!printed.ok) {
        setNotice(`Job card ${jobNo} opened — slip print failed (${printed.error ?? 'printer error'})`)
      }
    }
    await loadOpenTabsList()
  }

  async function closeActiveTabSession() {
    if (!activeOpenTabId) return
    setError(null)
    try {
      await persistActiveTabLinesFor(activeOpenTabId, cart)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save tab')
      return
    }
    setActiveOpenTabId(null)
    setActiveTabBanner(null)
    clearActiveQuote()
    setCart([])
    setPendingSplit(null)
    setLastSale(null)
    setShowChangeView(false)
    setLastChangeDue(null)
    setLastTendered(null)
    setLastCardAmount(null)
    setLastStoreCredit(null)
    setLastOnAccount(null)
    setLastTotal(null)
    setNotice(activeTabBanner?.kind === 'job_card' ? 'Job card saved · closed' : 'Tab saved · tab closed')
  }

  function beginRefundMode(data: SaleRefundPreview, routeSaleId: string) {
    const lines = cartLinesFromRefundPreview(data.sale, data.refund)
    if (!lines.length) {
      setError('Nothing left to refund on this sale')
      return
    }
    clearActiveQuote()
    setPendingSplit(null)
    setShowChangeView(false)
    setLastSale(null)
    setLastChangeDue(null)
    setLastTendered(null)
    setLastCardAmount(null)
    setLastStoreCredit(null)
    setLastOnAccount(null)
    setLastTotal(null)
    setError(null)
    setNotice(null)
    setRefundNote('')
    setRefundCreditPhone(
      typeof data.sale.storeCreditPhone === 'string' ? data.sale.storeCreditPhone : '',
    )
    setRefundCartScreenKbOpen(false)
    cancelRefundCartKbBlurHide()
    setAltPaymentExpanded(false)
    setVoucherFormOpen(false)
    setHouseAccountFormOpen(false)
    setRefundSession({
      routeSaleId,
      previewSale: data.sale,
      refundPreview: data.refund,
    })
    setCart(lines)
  }

  function clearRefundModeAndCart() {
    setRefundSession(null)
    setRefundNote('')
    setRefundCreditPhone('')
    setRefundCartScreenKbOpen(false)
    cancelRefundCartKbBlurHide()
    setCart([])
  }

  async function exitRefundModePrompt() {
    if (!refundSession) return
    if (!window.confirm('Leave refund mode? The refund cart will be cleared.')) return
    clearRefundModeAndCart()
    setError(null)
  }

  async function submitRefundCheckout(method: 'cash' | 'card' | 'store_credit') {
    if (!refundSession || busy) return
    const lines = cart
      .filter((l) => l.refundSaleLineIndex !== undefined && l.quantity > 0.005)
      .map((l) => ({ lineIndex: l.refundSaleLineIndex!, quantity: l.quantity }))
    if (!lines.length) {
      setError('Use − / + so at least one line has a quantity to refund')
      return
    }
    const snap = refundSession
    if (snap.previewSale.refundStatus === 'refunded' || snap.refundPreview.remainingTotal <= 0.005) {
      setError('This sale is already fully refunded')
      return
    }
    if (method === 'store_credit') {
      const phone = normalizePhone(refundCreditPhone)
      if (!phone) {
        setError('Enter the customer phone number for store credit')
        return
      }
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const id = snap.routeSaleId
      const body: Record<string, unknown> = {
        note: refundNote.trim() || undefined,
        payoutMethod: method,
        lines,
      }
      if (method === 'store_credit') {
        body.storeCreditPhone = normalizePhone(refundCreditPhone)
      }
      const resp = await apiFetch<{ sale?: Sale; refundSettlement?: SaleRefundSettlement }>(
        `/sales/${encodeURIComponent(id)}/refund`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      )
      const refundedSale = resp.sale
      const noteTrim = refundNote.trim()
      const refundLinesForPrint = cart
        .filter((l) => l.refundSaleLineIndex !== undefined && l.quantity > 0.005)
        .map((l) => ({
          qty: l.quantity,
          name: l.name,
          unitPrice: l.unitPrice,
          listUnitPrice: l.listUnitPrice,
          lineTotal: cartLineSubtotal(l),
        }))
      const refundPrintTotal = round2(refundLinesForPrint.reduce((s, x) => s + x.lineTotal, 0))
      const settlement = resp.refundSettlement
      setNotice('Sale refunded — stock and accounts updated where applicable')
      if (refundedSale) {
        try {
          const printed = await printRefundReceiptToDevice(refundedSale, noteTrim || undefined, method, {
            lines: refundLinesForPrint,
            refundTotal: refundPrintTotal,
            ...(settlement
              ? {
                  cashPaidOut: method === 'cash' ? settlement.netCashOrCardPaidOut : 0,
                  cardPaidOut: method === 'card' ? settlement.netCashOrCardPaidOut : 0,
                  storeCreditIssued: settlement.storeCreditIssued,
                }
              : {}),
            ...(method === 'store_credit'
              ? { storeCreditPhoneDigits: normalizePhone(refundCreditPhone) }
              : {}),
          })
          if (!printed.ok) throw new Error(printed.error ?? 'Refund receipt print failed')
        } catch (e) {
          setError(
            e instanceof Error
              ? `${e.message} — refund was saved. Start a new refund from REFUND if you need another line.`
              : 'Refund receipt print failed — refund was saved.',
          )
        }
      }
      await loadProducts()
      clearRefundModeAndCart()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Refund failed')
    } finally {
      setBusy(false)
    }
  }

  async function submitSale(
    paymentMethod: string,
    payment?: { cashAmount: number; cardAmount: number; tenderedCash?: number; changeDue?: number },
    storeCredit?: { amount: number; phone: string },
    houseAccount?: { id: string; amount: number; purchaseOrderNumber?: string },
  ) {
    if (refundSession) return
    if (cart.length === 0) return
    if (storeCredit && storeCredit.amount > 0.005 && !normalizePhone(storeCredit.phone)) {
      setError('Store voucher requires a phone number')
      return
    }
    if (houseAccount && houseAccount.amount > 0.005 && !houseAccount.id) {
      setError('House account required for on-account charge')
      return
    }
    if (houseAccount && houseAccount.amount > 0.005 && !(houseAccount.purchaseOrderNumber ?? '').trim()) {
      setError('Purchase order number required for on-account charge')
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    setLastSale(null)
    setShowChangeView(false)
    setLastChangeDue(null)
    setLastTendered(null)
    setLastCardAmount(null)
    setLastStoreCredit(null)
    setLastOnAccount(null)
    setLastTotal(null)
    setPendingSplit(null)
    const tabIdForSale = activeOpenTabId
    const clientLocalId = createClientLocalId()
    try {
      const body: Record<string, unknown> = {
        items: cart.map(saleRequestLineBody),
        paymentMethod,
        payment,
        clientLocalId,
        tillCode: POS_TILL_CODE,
        ...(tabIdForSale ? { openTabId: tabIdForSale } : {}),
        ...(activeQuoteId ? { quoteId: activeQuoteId } : {}),
      }
      if (storeCredit && storeCredit.amount > 0.005) {
        body.storeCreditAmount = round2(storeCredit.amount)
        body.storeCreditPhone = normalizePhone(storeCredit.phone)
      }
      if (houseAccount && houseAccount.amount > 0.005) {
        body.onAccountAmount = round2(houseAccount.amount)
        body.houseAccountId = houseAccount.id
        body.purchaseOrderNumber = houseAccount.purchaseOrderNumber?.trim()
      }
      const sale = await apiFetch<Sale>('/sales', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      setLastSale(sale)
      setLastReceiptForReprint({ kind: 'sale', sale })
      persistLastReceiptSale(sale)
      if (tabIdForSale) {
        setActiveOpenTabId(null)
        setActiveTabBanner(null)
      }
      clearActiveQuote()
      setCart([])
      resetVoucherForm()
      await loadProducts()
      return sale
    } catch (e) {
      if (!navigator.onLine || isLikelyNetworkError(e)) {
        const body: Record<string, unknown> = {
          items: cart.map(saleRequestLineBody),
          paymentMethod,
          payment,
          clientLocalId,
          tillCode: POS_TILL_CODE,
          ...(tabIdForSale ? { openTabId: tabIdForSale } : {}),
          ...(activeQuoteId ? { quoteId: activeQuoteId } : {}),
        }
        if (storeCredit && storeCredit.amount > 0.005) {
          body.storeCreditAmount = round2(storeCredit.amount)
          body.storeCreditPhone = normalizePhone(storeCredit.phone)
        }
        if (houseAccount && houseAccount.amount > 0.005) {
          body.onAccountAmount = round2(houseAccount.amount)
          body.houseAccountId = houseAccount.id
          body.purchaseOrderNumber = houseAccount.purchaseOrderNumber?.trim()
        }
        try {
          await enqueueOfflineSale(clientLocalId, body)
          await applyOfflineStockDeduction(cart)
          const pending = await getOfflinePendingSalesCount()
          setOfflinePendingCount(pending)
          const previewJobLabour = activeTabBanner?.kind === 'job_card'
          const queuedSale: Sale = {
            _id: `offline-${clientLocalId}`,
            saleId: clientLocalId.slice(-10),
            tillCode: POS_TILL_CODE,
            cashier: String(session?.user?.id ?? ''),
<<<<<<< HEAD
            items: cart.map((l) => ({
              product: l.productId,
              name: l.name,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              listUnitPrice: l.listUnitPrice,
              lineTotal: cartLineSubtotal(l),
              ...(l.addedByUserId ? { addedByUserId: l.addedByUserId } : {}),
              ...(l.addedByDisplayName ? { addedByDisplayName: l.addedByDisplayName } : {}),
              ...(l.addedAt ? { addedAt: l.addedAt } : {}),
            })),
            total: roundCartMoney(cart.reduce((s, l) => s + cartLineSubtotal(l), 0)),
=======
            items: saleItemsForOfflineReceiptPreview(cart, products, previewJobLabour),
            total: roundCartMoney(
              cart.reduce(
                (s, l) =>
                  s +
                  cartLineTotalIncludingJobLabour(
                    l,
                    products.find((x) => x._id === l.productId),
                    previewJobLabour,
                  ),
                0,
              ),
            ),
>>>>>>> 4307f62 (tuesday fro 86)
            paymentMethod,
            payment,
            ...(storeCredit && storeCredit.amount > 0.005
              ? {
                  storeCreditAmount: round2(storeCredit.amount),
                  storeCreditPhone: normalizePhone(storeCredit.phone),
                }
              : {}),
            ...(houseAccount && houseAccount.amount > 0.005
              ? {
                  onAccountAmount: round2(houseAccount.amount),
                  houseAccountId: houseAccount.id,
                }
              : {}),
            createdAt: new Date().toISOString(),
          }
          setLastSale(queuedSale)
          setLastReceiptForReprint({ kind: 'sale', sale: queuedSale })
          persistLastReceiptSale(queuedSale)
          if (tabIdForSale) {
            setActiveOpenTabId(null)
            setActiveTabBanner(null)
          }
          clearActiveQuote()
          setCart([])
          resetVoucherForm()
          setNotice(`Sale saved offline, stock adjusted locally, and queued for sync (${pending} pending).`)
          return queuedSale
        } catch (offlineErr) {
          setError(offlineErr instanceof Error ? offlineErr.message : 'Failed to queue offline sale')
          return
        }
      }
      setError(e instanceof Error ? e.message : 'Checkout failed')
    } finally {
      setBusy(false)
    }
  }

  async function applyPartialPayment(method: 'cash' | 'card') {
    if (refundSession) return
    setError(null)
    const total = pendingSplit?.total ?? cartTotal
    const prevCash = pendingSplit?.cashReceived ?? 0
    const prevCard = pendingSplit?.cardReceived ?? 0
    const prevSc = pendingSplit?.storeCreditApplied ?? 0
    const storeCreditPhone = pendingSplit?.storeCreditPhone ?? ''
    const prevOa = pendingSplit?.onAccountApplied ?? 0
    const oaId = pendingSplit?.houseAccountId ?? ''
    const oaNum = pendingSplit?.houseAccountNumber ?? ''
    const oaName = pendingSplit?.houseAccountName ?? ''
    const poNumber = pendingSplit?.purchaseOrderNumber ?? ''
    const due = round2(total - prevCash - prevCard - prevSc - prevOa)
    if (due <= 0) {
      setError('No outstanding amount due')
      return
    }

    const entered = parseTenderedInput(skuInputRef.current, due)
    if (!Number.isFinite(entered) || entered <= 0) {
      setError(`Enter ${method} amount on keypad before pressing ${method.toUpperCase()}`)
      return
    }

    if (method === 'card' && entered > due) {
      setError(`Card amount cannot exceed amount due (${due.toFixed(2)})`)
      return
    }

    const nextCash = round2(prevCash + (method === 'cash' ? entered : 0))
    const nextCard = round2(prevCard + (method === 'card' ? entered : 0))
    const covered = round2(nextCash + nextCard + prevSc + prevOa)
    const remaining = round2(total - covered)

    if (remaining > 0) {
      setPendingSplit({
        total,
        cashReceived: nextCash,
        cardReceived: nextCard,
        storeCreditApplied: prevSc,
        storeCreditPhone,
        onAccountApplied: prevOa,
        houseAccountId: oaId,
        houseAccountNumber: oaNum,
        houseAccountName: oaName,
        purchaseOrderNumber: poNumber,
        amountDue: remaining,
      })
      setSkuInput('')
      return
    }

    const coveredTotal = round2(nextCash + nextCard + prevSc + prevOa)
    const change = round2(Math.max(0, coveredTotal - total))
    const remainingAfterScOa = round2(total - prevSc - prevOa)
    const cardApplied = round2(Math.min(nextCard, remainingAfterScOa))
    const cashApplied = round2(Math.max(0, remainingAfterScOa - cardApplied))
    const tenderCount = [cashApplied > 0.005, cardApplied > 0.005, prevSc > 0.005, prevOa > 0.005].filter(
      Boolean,
    ).length
    const paymentMethod =
      tenderCount >= 2 || (cashApplied > 0.005 && cardApplied > 0.005)
        ? 'split'
        : prevOa > 0.005 && cashApplied < 0.005 && cardApplied < 0.005 && prevSc < 0.005
          ? 'on_account'
          : cardApplied > 0 && cashApplied > 0
            ? 'split'
            : cardApplied > 0
              ? 'card'
              : cashApplied > 0
                ? receiptEnabled
                  ? 'cash-receipt'
                  : 'cash-no-receipt'
                : prevSc > 0.005
                  ? 'store_credit'
                  : receiptEnabled
                    ? 'cash-receipt'
                    : 'cash-no-receipt'

    const sale = await submitSale(
      paymentMethod,
      {
        cashAmount: cashApplied,
        cardAmount: cardApplied,
        tenderedCash: nextCash,
        changeDue: change,
      },
      prevSc > 0 ? { amount: prevSc, phone: storeCreditPhone } : undefined,
      prevOa > 0 && oaId ? { id: oaId, amount: prevOa, purchaseOrderNumber: poNumber } : undefined,
    )
    if (!sale) return
    setLastTotal(total)
    setLastTendered(nextCash)
    setLastCardAmount(cardApplied)
    setLastStoreCredit(prevSc > 0 ? prevSc : null)
    setLastOnAccount(prevOa > 0 ? prevOa : null)
    setLastChangeDue(change)
    setShowChangeView(true)
    setSkuInput('')
    setHouseAccountForCheckout(null)
    setOnAccountPoNumber('')
    setOnAccountPoKbOpen(false)
    void postSaleHardwareActions(sale)
  }

  async function fetchVoucherBalance() {
    const phone = normalizePhone(voucherPhone)
    if (!phone) {
      setError('Enter a phone number')
      return
    }
    setError(null)
    try {
      const r = await apiFetch<{ balance: number; name: string }>(
        `/store-credit/balance?phone=${encodeURIComponent(phone)}`,
      )
      setVoucherBalanceHint(r.balance)
      setVoucherNameHint(r.name ?? '')
    } catch (e) {
      setVoucherBalanceHint(null)
      setVoucherNameHint('')
      setError(e instanceof Error ? e.message : 'Balance lookup failed')
    }
  }

  function removeVoucherFromSplit() {
    if (!pendingSplit || pendingSplit.storeCreditApplied <= 0) return
    const { total, cashReceived, cardReceived, onAccountApplied, houseAccountId, houseAccountNumber, houseAccountName, purchaseOrderNumber } =
      pendingSplit
    setPendingSplit({
      total,
      cashReceived,
      cardReceived,
      storeCreditApplied: 0,
      storeCreditPhone: '',
      onAccountApplied,
      houseAccountId,
      houseAccountNumber,
      houseAccountName,
      purchaseOrderNumber,
      amountDue: round2(total - cashReceived - cardReceived - onAccountApplied),
    })
  }

  function removeOnAccountFromSplit() {
    if (!pendingSplit || pendingSplit.onAccountApplied <= 0) return
    const { total, cashReceived, cardReceived, storeCreditApplied, storeCreditPhone } = pendingSplit
    setPendingSplit({
      total,
      cashReceived,
      cardReceived,
      storeCreditApplied,
      storeCreditPhone,
      onAccountApplied: 0,
      houseAccountId: '',
      houseAccountNumber: '',
      houseAccountName: '',
      purchaseOrderNumber: '',
      amountDue: round2(total - cashReceived - cardReceived - storeCreditApplied),
    })
  }

  function applyVoucherUseMax() {
    const total = pendingSplit?.total ?? cartTotal
    const prevCash = pendingSplit?.cashReceived ?? 0
    const prevCard = pendingSplit?.cardReceived ?? 0
    const prevOa = pendingSplit?.onAccountApplied ?? 0
    const maxVoucher = round2(total - prevCash - prevCard - prevOa)
    if (voucherBalanceHint === null) {
      setError('Check balance first')
      return
    }
    const use = round2(Math.min(voucherBalanceHint, maxVoucher))
    if (use <= 0) {
      setError('No amount to apply')
      return
    }
    setVoucherAmountStr(String(use))
    setError(null)
  }

  async function applyVoucherToSale() {
    if (altPaymentsOfflineDisabled) {
      setError('Alt payment options are unavailable while offline')
      return
    }
    if (refundSession) return
    if (cart.length === 0 || busy) return
    setError(null)
    const phone = normalizePhone(voucherPhone)
    if (!phone) {
      setError('Enter phone number for store voucher')
      return
    }
    const amt = parseTenderedInput(voucherAmountStr.trim(), 0)
    if (!Number.isFinite(amt) || amt <= 0) {
      setError('Enter voucher amount')
      return
    }

    const total = pendingSplit?.total ?? cartTotal
    const prevCash = pendingSplit?.cashReceived ?? 0
    const prevCard = pendingSplit?.cardReceived ?? 0
    const prevOa = pendingSplit?.onAccountApplied ?? 0
    const oaId = pendingSplit?.houseAccountId ?? ''
    const oaNum = pendingSplit?.houseAccountNumber ?? ''
    const oaName = pendingSplit?.houseAccountName ?? ''
    const poNumber = pendingSplit?.purchaseOrderNumber ?? ''
    const maxVoucher = round2(total - prevCash - prevCard - prevOa)
    if (amt > maxVoucher + 0.01) {
      setError(`Voucher cannot exceed ${maxVoucher.toFixed(2)} (still due)`)
      return
    }

    let balance: number
    try {
      const r = await apiFetch<{ balance: number; name: string }>(
        `/store-credit/balance?phone=${encodeURIComponent(phone)}`,
      )
      balance = r.balance
      setVoucherBalanceHint(r.balance)
      setVoucherNameHint(r.name ?? '')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not verify balance')
      return
    }
    if (amt > balance + 0.01) {
      setError('Insufficient store credit')
      return
    }

    const newSc = round2(amt)
    const amountDue = round2(total - prevCash - prevCard - newSc - prevOa)

    if (amountDue > 0.02) {
      setPendingSplit({
        total,
        cashReceived: prevCash,
        cardReceived: prevCard,
        storeCreditApplied: newSc,
        storeCreditPhone: phone,
        onAccountApplied: prevOa,
        houseAccountId: oaId,
        houseAccountNumber: oaNum,
        houseAccountName: oaName,
        purchaseOrderNumber: poNumber,
        amountDue,
      })
      setVoucherAmountStr('')
      setVoucherFormOpen(false)
      return
    }

    const nextCash = prevCash
    const nextCard = prevCard
    const coveredTotal = round2(nextCash + nextCard + newSc + prevOa)
    const change = round2(Math.max(0, coveredTotal - total))
    const remainingAfterScOa = round2(total - newSc - prevOa)
    const cardApplied = round2(Math.min(nextCard, remainingAfterScOa))
    const cashApplied = round2(Math.max(0, remainingAfterScOa - cardApplied))

    const tenderCount = [cashApplied > 0.005, cardApplied > 0.005, newSc > 0.005, prevOa > 0.005].filter(Boolean)
      .length
    const paymentMethod =
      tenderCount >= 2 || (cashApplied > 0.005 && cardApplied > 0.005)
        ? 'split'
        : prevOa > 0.005 && cashApplied < 0.005 && cardApplied < 0.005 && newSc < 0.005
          ? 'on_account'
          : cardApplied > 0 && cashApplied > 0
            ? 'split'
            : cardApplied > 0
              ? 'card'
              : cashApplied > 0
                ? receiptEnabled
                  ? 'cash-receipt'
                  : 'cash-no-receipt'
                : newSc > 0.005
                  ? 'store_credit'
                  : 'on_account'

    const sale = await submitSale(
      paymentMethod,
      {
        cashAmount: cashApplied,
        cardAmount: cardApplied,
        tenderedCash: nextCash,
        changeDue: change,
      },
      newSc > 0 ? { amount: newSc, phone } : undefined,
      prevOa > 0 && oaId ? { id: oaId, amount: prevOa, purchaseOrderNumber: poNumber } : undefined,
    )
    if (!sale) return
    setLastTotal(total)
    setLastTendered(nextCash)
    setLastCardAmount(cardApplied)
    setLastStoreCredit(newSc > 0 ? newSc : null)
    setLastOnAccount(prevOa > 0 ? prevOa : null)
    setLastChangeDue(change)
    setShowChangeView(true)
    setSkuInput('')
    setVoucherFormOpen(false)
    setHouseAccountForCheckout(null)
    void postSaleHardwareActions(sale)
  }

  async function applyOnAccountToSale() {
    if (altPaymentsOfflineDisabled) {
      setError('Alt payment options are unavailable while offline')
      return
    }
    if (refundSession) return
    if (cart.length === 0 || busy) return
    setError(null)
    if (!houseAccountForCheckout) {
      setError('Pick a house account (ACCOUNTS)')
      return
    }
    let acct = houseAccountForCheckout
    try {
      acct = await apiFetch<HouseAccountRow>(`/house-accounts/${houseAccountForCheckout._id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load account')
      return
    }
    if (acct.status !== 'active') {
      setError('Account is not active')
      return
    }
    setHouseAccountForCheckout(acct)

    const amt = onAccountRemainingDueAmount()
    if (!Number.isFinite(amt) || amt <= 0) {
      setError('Enter amount to charge on account')
      return
    }

    const total = pendingSplit?.total ?? cartTotal
    const prevCash = pendingSplit?.cashReceived ?? 0
    const prevCard = pendingSplit?.cardReceived ?? 0
    const prevSc = pendingSplit?.storeCreditApplied ?? 0
    const poNumber = onAccountPoNumber.trim().slice(0, 120)
    if (!poNumber) {
      setError('Enter purchase order number')
      return
    }
    const nextBal = round2(acct.balance + amt)
    if (acct.creditLimit != null && nextBal > round2(acct.creditLimit) + 0.02) {
      setError('Would exceed credit limit')
      return
    }

    const newOa = round2(amt)
    const amountDue = round2(total - prevCash - prevCard - prevSc - newOa)
    if (amountDue > 0.02) {
      setError('Insufficient available account credit. Take an account payment first.')
      return
    }

    const nextCash = prevCash
    const nextCard = prevCard
    const coveredTotal = round2(nextCash + nextCard + prevSc + newOa)
    const change = round2(Math.max(0, coveredTotal - total))
    const remainingAfterScOa = round2(total - prevSc - newOa)
    const cardApplied = round2(Math.min(nextCard, remainingAfterScOa))
    const cashApplied = round2(Math.max(0, remainingAfterScOa - cardApplied))

    const tenderCount = [cashApplied > 0.005, cardApplied > 0.005, prevSc > 0.005, newOa > 0.005].filter(Boolean)
      .length
    const paymentMethod =
      tenderCount >= 2 || (cashApplied > 0.005 && cardApplied > 0.005)
        ? 'split'
        : newOa > 0.005 && cashApplied < 0.005 && cardApplied < 0.005 && prevSc < 0.005
          ? 'on_account'
          : cardApplied > 0 && cashApplied > 0
            ? 'split'
            : cardApplied > 0
              ? 'card'
              : cashApplied > 0
                ? receiptEnabled
                  ? 'cash-receipt'
                  : 'cash-no-receipt'
                : prevSc > 0.005
                  ? 'store_credit'
                  : 'on_account'

    const sale = await submitSale(
      paymentMethod,
      {
        cashAmount: cashApplied,
        cardAmount: cardApplied,
        tenderedCash: nextCash,
        changeDue: change,
      },
      prevSc > 0 ? { amount: prevSc, phone: pendingSplit?.storeCreditPhone ?? '' } : undefined,
      newOa > 0 ? { id: acct._id, amount: newOa, purchaseOrderNumber: poNumber } : undefined,
    )
    if (!sale) return
    setLastTotal(total)
    setLastTendered(nextCash)
    setLastCardAmount(cardApplied)
    setLastStoreCredit(prevSc > 0 ? prevSc : null)
    setLastOnAccount(newOa > 0 ? newOa : null)
    setLastChangeDue(change)
    setShowChangeView(true)
    setSkuInput('')
    setHouseAccountFormOpen(false)
    setHouseAccountForCheckout(null)
    setOnAccountPoNumber('')
    setOnAccountPoKbOpen(false)
    void postSaleHardwareActions(sale)
  }

  async function checkoutCash() {
    if (refundSession) {
      await submitRefundCheckout('cash')
      return
    }
    await applyPartialPayment('cash')
  }

  async function checkoutCard() {
    if (refundSession) {
      await submitRefundCheckout('card')
      return
    }
    await applyPartialPayment('card')
  }

  async function checkoutRefundStoreCredit() {
    if (!refundSession) return
    await submitRefundCheckout('store_credit')
  }

  function pressKey(key: string) {
    if (refundSession && key !== 'clear') {
      return
    }
    setLastSale(null)
    setError(null)
    setNotice(null)
    if (key === 'clear') {
      setSkuInput('')
      return
    }
    if (key === 'backspace') {
      setSkuInput((prev) => prev.slice(0, -1))
      return
    }
    if (key === '.') {
      setSkuInput((prev) => (prev.includes('.') ? prev : `${prev}.`))
      return
    }
    if (key === '×') {
      setSkuInput((prev) => {
        if (prev.includes('×') || prev.includes('*')) return prev
        return `${prev}×`
      })
      return
    }
    if (key === 'enter') {
      addBySku()
      return
    }
    setSkuInput((prev) => `${prev}${key}`)
  }

  function addBySku(override?: string) {
    if (refundSession) {
      setError('Scanner/keypad SKU entry is off during refund — adjust quantities in the cart')
      return
    }
    const q = (override ?? skuInputRef.current).trim()
    if (!q) {
      setError('Enter SKU or qty×SKU (e.g. 100×48)')
      return
    }

    const normalized = q.replace(/\*/g, '×')
    const mul = normalized.indexOf('×')
    if (mul >= 0) {
      const qtyStr = normalized.slice(0, mul).trim()
      const skuStr = normalized.slice(mul + 1).trim()
      if (!qtyStr || !skuStr) {
        setError('Use qty×SKU then ENTER (e.g. 100×48)')
        return
      }
      if (qtyStr.includes('.') || qtyStr.includes(',')) {
        setError('Quantity must be a whole number')
        return
      }
      const qtyNum = Number(qtyStr)
      if (!Number.isFinite(qtyNum) || qtyNum < 1 || !Number.isInteger(qtyNum)) {
        setError('Quantity must be a whole number of at least 1')
        return
      }
      if (qtyNum > 999_999) {
        setError('Quantity too large')
        return
      }
      const match = findProductBySkuOrBarcode(skuStr)
      if (!match) {
        setError(`No item found for "${skuStr}"`)
        return
      }
      void addToCartQty(match, qtyNum)
      setSkuInput('')
      return
    }

    const match = findProductBySkuOrBarcode(q)
    if (!match) {
      setError(`No item found for "${q}"`)
      return
    }
    addToCart(match)
    setSkuInput('')
  }

  // Global key handling (barcode scanner -> keyboard events).
  // This page doesn't have a real <input> for SKU entry, so without this listener,
  // scanned digits wouldn't be captured.
  useEffect(() => {
    function isTypingTarget(target: EventTarget | null) {
      const el = target as HTMLElement | null
      if (!el) return false
      const tag = el.tagName?.toLowerCase()
      if (!tag) return false
      if (tag === 'input' || tag === 'textarea') return true
      return el.getAttribute?.('contenteditable') === 'true'
    }

    function onKeyDown(e: KeyboardEvent) {
      if (refundSession) return
      // When browsing items, don't hijack typing into the search box.
      if (registerLeftPanel === 'list') return
      if (e.defaultPrevented) return
      if (isTypingTarget(e.target)) return

      // Avoid repeating characters for long key presses.
      if (e.repeat) return

      if (e.key >= '0' && e.key <= '9') {
        playPosKeySound()
        pressKey(e.key)
        return
      }
      if (e.key === '.' || e.key === ',' || e.key === 'NumpadDecimal') {
        playPosKeySound()
        pressKey('.')
        return
      }
      if (e.key === '*' || e.key === 'NumpadMultiply') {
        e.preventDefault()
        playPosKeySound()
        pressKey('×')
        return
      }
      if (e.key === 'Backspace') {
        playPosKeySound()
        pressKey('backspace')
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        playPosKeySound()
        addBySku()
        return
      }
      if (e.key === 'Escape') {
        playPosKeySound()
        pressKey('clear')
        return
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // pressKey/addBySku/read of refs are stable enough for this listener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerLeftPanel, refundSession])

  function voidLastItem() {
    clearActiveQuote()
    setError(null)
    setNotice(null)
    setLastSale(null)
    setCart((prev) => {
      if (prev.length === 0) return prev
      const next = [...prev]
      next.pop()
      return next
    })
  }

  function priceOverrideLast() {
    if (refundSession) {
      setError('Price override is not available in refund mode')
      return
    }
    if (!canOverridePriceOnPos(session?.user)) {
      setError('Not allowed to override price on this login')
      return
    }
    if (cart.length === 0) {
      setError('Add an item to cart first')
      return
    }
    const lastP = products.find((x) => x._id === cart[cart.length - 1].productId)
    if (lastP && hasVolumeTiering(lastP)) {
      setError('Price override is not available for products with volume tier pricing')
      return
    }
    const fromKey = skuInputRef.current.trim()
    if (!fromKey) {
      setError('Enter new unit price on keypad (use . for cents), then tap PRICE OVERRIDE')
      return
    }
    const value = parseOverrideUnitPrice(fromKey)
    if (value === null) {
      setError('Invalid price — tap CL and enter a valid amount (e.g. 12.99)')
      return
    }
    resetCartAfterPricingEdit()
    setCart((prev) => {
      if (prev.length === 0) return prev
      const next = [...prev]
      const last = next[next.length - 1]
      next[next.length - 1] = {
        ...last,
        listUnitPrice: undefined,
        unitPrice: value,
      }
      return next
    })
    setSkuInput('')
    setNotice('Price override applied to last cart item')
  }

  function readDiscountPercent(scope: 'line' | 'cart'): number | null {
    const fromKey = skuInputRef.current.trim().replace(',', '.')
    let pct: number | undefined
    if (fromKey !== '') {
      const n = Number(fromKey)
      if (Number.isFinite(n) && n >= 0 && n <= 100) {
        pct = n
      } else {
        setError(
          scope === 'line'
            ? 'Enter a percent (0–100) on the keypad, then tap DISCOUNT % (last line only)'
            : 'Enter a percent (0–100) on the keypad, then hold DISCOUNT % (whole cart)',
        )
        return null
      }
    }

    if (pct === undefined) {
      const raw = window.prompt(
        scope === 'line'
          ? 'Discount percent (0–100) for the last cart line:'
          : 'Discount percent (0–100) for the whole cart:',
      )
      if (raw === null || raw.trim() === '') {
        setError(
          scope === 'line'
            ? 'Type the discount on the keypad (e.g. 10 for 10%), then tap DISCOUNT % (last line)'
            : 'Type the discount on the keypad, then hold DISCOUNT % (whole cart)',
        )
        return null
      }
      const n = Number(raw.replace(',', '.'))
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        setError('Enter a percent between 0 and 100')
        return null
      }
      pct = n
    }

    return pct
  }

  function resetCartAfterPricingEdit() {
    clearActiveQuote()
    setLastSale(null)
    setShowChangeView(false)
    setLastChangeDue(null)
    setLastTendered(null)
    setLastCardAmount(null)
    setLastStoreCredit(null)
    setLastOnAccount(null)
    setLastTotal(null)
    setPendingSplit(null)
    setError(null)
  }

  function applyLastLineDiscountPercent() {
    if (refundSession) {
      setError('Discounts are not available in refund mode')
      return
    }
    if (!canOverridePriceOnPos(session?.user)) {
      setError('Not allowed to apply discounts on this login')
      return
    }
    if (cart.length === 0) {
      setError('Add items to cart first')
      return
    }
    const last = cart[cart.length - 1]
    const lastP = products.find((x) => x._id === last.productId)
    if (lastP && hasVolumeTiering(lastP)) {
      setError('Discounts cannot be applied to volume tier lines — use a new sale for a different price')
      return
    }

    const pct = readDiscountPercent('line')
    if (pct === null) return

    if (pct === 0) {
      setNotice('No discount applied')
      setSkuInput('')
      return
    }
    const factor = 1 - pct / 100
    resetCartAfterPricingEdit()
    setCart((prev) => {
      if (prev.length === 0) return prev
      const next = [...prev]
      const i = next.length - 1
      const line = next[i]
      const listUnitPrice = line.listUnitPrice ?? line.unitPrice
      const newUnit = Math.round(line.unitPrice * factor * 100) / 100
      next[i] = { ...line, listUnitPrice, unitPrice: newUnit }
      return next
    })
    setSkuInput('')
    setNotice(`${pct}% discount applied to last cart line`)
  }

  function applyWholeCartDiscountPercent() {
    if (refundSession) {
      setError('Discounts are not available in refund mode')
      return
    }
    if (!canOverridePriceOnPos(session?.user)) {
      setError('Not allowed to apply discounts on this login')
      return
    }
    if (cart.length === 0) {
      setError('Add items to cart first')
      return
    }
    if (cartHasVolumePricedLine(cart, products)) {
      setError('Remove volume-priced lines before applying a whole-cart discount')
      return
    }

    const pct = readDiscountPercent('cart')
    if (pct === null) return

    if (pct === 0) {
      setNotice('No discount applied')
      setSkuInput('')
      return
    }
    const factor = 1 - pct / 100
    resetCartAfterPricingEdit()
    setCart((prev) =>
      prev.map((line) => {
        const listUnitPrice = line.listUnitPrice ?? line.unitPrice
        const newUnit = Math.round(line.unitPrice * factor * 100) / 100
        return { ...line, listUnitPrice, unitPrice: newUnit }
      }),
    )
    setSkuInput('')
    setNotice(`${pct}% discount applied to whole cart`)
  }

  const LONG_DISCOUNT_MS = 550
  const DISCOUNT_MOVE_PX = 14

  function onDiscountPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    if (!e.isPrimary || cart.length === 0 || refundSession) return
    const h = discountHoldRef.current
    if (h.timer) clearTimeout(h.timer)
    h.longPressDone = false
    h.startX = e.clientX
    h.startY = e.clientY
    h.timer = setTimeout(() => {
      h.timer = null
      h.longPressDone = true
      applyWholeCartDiscountPercent()
    }, LONG_DISCOUNT_MS)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onDiscountPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const h = discountHoldRef.current
    if (!h.timer) return
    const dx = e.clientX - h.startX
    const dy = e.clientY - h.startY
    if (dx * dx + dy * dy > DISCOUNT_MOVE_PX * DISCOUNT_MOVE_PX) {
      clearTimeout(h.timer)
      h.timer = null
    }
  }

  function onDiscountPointerUp(e: React.PointerEvent<HTMLButtonElement>) {
    const h = discountHoldRef.current
    const hadTimer = h.timer !== null
    if (h.timer) {
      clearTimeout(h.timer)
      h.timer = null
    }
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
    if (h.longPressDone) {
      h.longPressDone = false
      skipNextDiscountClickRef.current = true
      return
    }
    if (hadTimer) {
      skipNextDiscountClickRef.current = true
      applyLastLineDiscountPercent()
    }
  }

  function onDiscountPointerCancel(e: React.PointerEvent<HTMLButtonElement>) {
    const h = discountHoldRef.current
    if (h.timer) {
      clearTimeout(h.timer)
      h.timer = null
    }
    h.longPressDone = false
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  function onDiscountClick(e: React.MouseEvent<HTMLButtonElement>) {
    if (skipNextDiscountClickRef.current) {
      skipNextDiscountClickRef.current = false
      e.preventDefault()
      return
    }
    applyLastLineDiscountPercent()
  }

  function onProductRowPointerDown(e: React.PointerEvent<HTMLButtonElement>, p: Product) {
    const canTapProduct = productHasSellableStock(p) || (productTracksInventory(p) && (offlineCatalogMode || !serverReachable || isAdmin))
    if (!e.isPrimary || !canTapProduct) return
    const h = productPresetHoldRef.current
    if (h.timer) clearTimeout(h.timer)
    h.longPressDone = false
    h.startX = e.clientX
    h.startY = e.clientY
    h.timer = setTimeout(() => {
      h.timer = null
      h.longPressDone = true
      setAssignPresetProduct(p)
    }, LONG_PRESET_ASSIGN_MS)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onProductRowPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const h = productPresetHoldRef.current
    if (!h.timer) return
    const dx = e.clientX - h.startX
    const dy = e.clientY - h.startY
    if (dx * dx + dy * dy > PRESET_POINTER_MOVE_PX * PRESET_POINTER_MOVE_PX) {
      clearTimeout(h.timer)
      h.timer = null
    }
  }

  function onProductRowPointerUp(e: React.PointerEvent<HTMLButtonElement>) {
    const h = productPresetHoldRef.current
    if (h.timer) {
      clearTimeout(h.timer)
      h.timer = null
    }
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    if (h.longPressDone) {
      h.longPressDone = false
      skipNextProductAddRef.current = true
    }
  }

  function onProductRowPointerCancel(e: React.PointerEvent<HTMLButtonElement>) {
    const h = productPresetHoldRef.current
    if (h.timer) {
      clearTimeout(h.timer)
      h.timer = null
    }
    h.longPressDone = false
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  function onProductRowClick(e: React.MouseEvent<HTMLButtonElement>, p: Product) {
    if (skipNextProductAddRef.current) {
      skipNextProductAddRef.current = false
      e.preventDefault()
      return
    }
    if (refundSession) {
      setError('Exit refund mode to sell from the catalog')
      return
    }
    addToCart(p)
  }

  function presetEntryPathLabel(entry: PresetEntry, productName?: string) {
    const leaf = productName ?? entry.label
    return `${entry.category} › ${entry.subCategory} › ${leaf}`
  }

  function onPresetItemPointerDown(e: React.PointerEvent<HTMLButtonElement>, entryIndex: number) {
    if (!e.isPrimary) return
    const h = presetItemDeleteHoldRef.current
    if (h.timer) clearTimeout(h.timer)
    h.longPressDone = false
    h.entryIndex = entryIndex
    h.startX = e.clientX
    h.startY = e.clientY
    h.timer = setTimeout(() => {
      h.timer = null
      h.longPressDone = true
      setPresetDeleteIndex(entryIndex)
    }, LONG_PRESET_ASSIGN_MS)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onPresetItemPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const h = presetItemDeleteHoldRef.current
    if (!h.timer) return
    const dx = e.clientX - h.startX
    const dy = e.clientY - h.startY
    if (dx * dx + dy * dy > PRESET_POINTER_MOVE_PX * PRESET_POINTER_MOVE_PX) {
      clearTimeout(h.timer)
      h.timer = null
    }
  }

  function onPresetItemPointerUp(e: React.PointerEvent<HTMLButtonElement>) {
    const h = presetItemDeleteHoldRef.current
    if (h.timer) {
      clearTimeout(h.timer)
      h.timer = null
    }
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    if (h.longPressDone) {
      h.longPressDone = false
      h.entryIndex = null
      skipNextPresetItemTapRef.current = true
    }
  }

  function onPresetItemPointerCancel(e: React.PointerEvent<HTMLButtonElement>) {
    const h = presetItemDeleteHoldRef.current
    if (h.timer) {
      clearTimeout(h.timer)
      h.timer = null
    }
    h.longPressDone = false
    h.entryIndex = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  function onPresetItemClick(e: React.MouseEvent<HTMLButtonElement>, entry: PresetEntry) {
    if (skipNextPresetItemTapRef.current) {
      skipNextPresetItemTapRef.current = false
      e.preventDefault()
      return
    }
    if (refundSession) {
      setError('Exit refund mode to sell from presets')
      return
    }
    const p = products.find((x) => x._id === entry.productId)
    if (!p) {
      setError(
        'This preset points to a removed product. Long-press the row or use Remove to clear it.',
      )
      return
    }
    addToCart(p)
  }

  function removePresetEntryAt(entryIndex: number) {
    setPresetsState((prev) => {
      const next = removePresetAt(prev, entryIndex)
      persistPresets(next, prev)
      return next
    })
    setPresetDeleteIndex(null)
    setNotice('Preset removed')
  }

  function lineDiscountDisplay(line: CartLine): { show: boolean; pct: number } | null {
    if (line.volumeSegments && line.volumeSegments.length > 0) return null
    const list = line.listUnitPrice
    if (list == null || list <= 0) return null
    if (line.unitPrice >= list - 0.0001) return null
    const pct = Math.round((1 - line.unitPrice / list) * 100)
    if (pct <= 0) return null
    return { show: true, pct }
  }

  function saleHasOnAccountCharge(sale: Sale): boolean {
    return (sale.onAccountAmount ?? 0) > 0.005
  }

  function saleUsesStoreCredit(sale: Sale): boolean {
    return (sale.storeCreditAmount ?? 0) > 0.005
  }

  function receiptPayloadFromSale(
    sale: Sale,
    opts?: {
      copyLabel?: string
      receiptTitle?: string
      receiptNumberPrefix?: string
      thankYouLine?: string
      totalDueLabel?: string
      paymentLabelOverride?: string
      refundAck?: {
        refundTotal: number
        refundCash: number
        refundCard: number
        refundStoreCredit?: number
        storeCreditPhoneDisplay?: string
        note?: string
      }
      /** Refund slip only: line items and total for this refund (original sale document is unchanged). */
      refundPrintSlice?: {
        lines: Array<{ qty: number; name: string; unitPrice: number; listUnitPrice?: number; lineTotal: number }>
        refundTotal: number
        cashPaidOut?: number
        cardPaidOut?: number
        storeCreditIssued?: number
      }
    },
  ): {
    transport: unknown
    receipt: unknown
    columns: number
    cut: boolean
  } {
    const cfg = printerSettings.receiptConfig
    const ts = sale.createdAt ?? new Date().toISOString()
    const slice = opts?.refundPrintSlice

    function saleLineToReceiptRow(l: SaleLine) {
      return {
        qty: l.quantity,
        name: l.name,
        unitPrice: l.unitPrice,
        listUnitPrice: l.listUnitPrice,
        lineTotal: l.lineTotal ?? roundCartMoney(l.quantity * l.unitPrice),
      }
    }

    type ReceiptRow = {
      qty: number
      name: string
      unitPrice: number
      listUnitPrice?: number
      lineTotal: number
    }

    let receiptLines: ReceiptRow[]
    let lineItemSections: Array<{ heading: string; lines: ReceiptRow[]; sectionSubtotal: number }> | undefined

    if (slice) {
      receiptLines = slice.lines.map((l) => ({
        qty: l.qty,
        name: l.name,
        unitPrice: l.unitPrice,
        listUnitPrice: l.listUnitPrice,
        lineTotal: l.lineTotal,
      }))
      lineItemSections = undefined
    } else {
      const items = sale.items
      const label = (it: SaleLine) => it.addedByDisplayName?.trim() || 'Not attributed'
      const labels = items.map(label)
      const distinct = new Set(labels)
      if (distinct.size <= 1) {
        receiptLines = items.map(saleLineToReceiptRow)
        lineItemSections = undefined
      } else {
        receiptLines = []
        const order: string[] = []
        const seen = new Set<string>()
        for (const lb of labels) {
          if (!seen.has(lb)) {
            seen.add(lb)
            order.push(lb)
          }
        }
        lineItemSections = order.map((headingKey) => {
          const secItems = items.filter((_it, i) => labels[i] === headingKey)
          const inner = secItems.map(saleLineToReceiptRow)
          const sectionSubtotal = inner.reduce(
            (s, r) => s + (r.lineTotal ?? roundCartMoney(r.qty * r.unitPrice)),
            0,
          )
          return { heading: `Supplied by ${headingKey}`, lines: inner, sectionSubtotal }
        })
      }
    }

    const flatForTotals = lineItemSections?.length ? lineItemSections.flatMap((s) => s.lines) : receiptLines
    const gross = flatForTotals.reduce(
      (sum, l) => sum + (l.lineTotal ?? roundCartMoney(l.qty * l.unitPrice)),
      0,
    )
    const total = slice ? slice.refundTotal : (sale.total ?? gross)
    const discountTotal = Math.max(0, gross - total)
    const vatRate = Number(cfg.vatRatePct || 0)
    const taxTotal = vatRate > 0 ? total - total / (1 + vatRate / 100) : 0
    const subtotal = total - taxTotal
    const paymentLabelRaw = (sale.paymentMethod ?? '').toLowerCase()
    const paymentLabel = opts?.paymentLabelOverride
      ? opts.paymentLabelOverride
      : paymentLabelRaw.includes('split')
      ? 'Split'
      : paymentLabelRaw === 'on_account'
        ? 'On account'
        : paymentLabelRaw.includes('card')
          ? 'Card'
          : paymentLabelRaw.includes('store')
            ? 'Store voucher'
            : 'Cash'

    const tendered = slice ? undefined : sale.payment?.tenderedCash
    const changeDue = slice ? undefined : sale.payment?.changeDue

    const onAccountAmt = slice ? 0 : (sale.onAccountAmount ?? 0)
    const accountAck =
      onAccountAmt > 0.005
        ? {
            accountNumber: sale.houseAccountNumber?.trim() || '—',
            accountName: sale.houseAccountName?.trim(),
            amount: onAccountAmt,
            purchaseOrderNumber: sale.purchaseOrderNumber?.trim(),
          }
        : undefined

    const cashAmt = slice ? 0 : Number(sale.payment?.cashAmount ?? 0)
    const cardAmt = slice ? 0 : Number(sale.payment?.cardAmount ?? 0)
    const voucherAmt = slice ? 0 : Number(sale.storeCreditAmount ?? 0)
    const tenderKindCount = slice
      ? 0
      : [cashAmt > 0.005, cardAmt > 0.005, voucherAmt > 0.005].filter(Boolean).length
    const paymentTenders =
      tenderKindCount >= 2
        ? {
            ...(cashAmt > 0.005 ? { cash: cashAmt } : {}),
            ...(cardAmt > 0.005 ? { card: cardAmt } : {}),
            ...(voucherAmt > 0.005 ? { storeVoucher: voucherAmt } : {}),
          }
        : undefined
    const storeVoucherAck =
      !slice && voucherAmt > 0.005
        ? {
            phoneDisplay: maskPhoneForReceipt(
              typeof sale.storeCreditPhone === 'string' ? sale.storeCreditPhone : '',
            ),
            amount: voucherAmt,
            ...(typeof sale.storeCreditBalanceAfter === 'number'
              ? { balanceAfter: sale.storeCreditBalanceAfter }
              : {}),
          }
        : undefined

    return {
      transport: printerSettings.transport,
      columns: printerSettings.columns,
      cut: printerSettings.cut,
      receipt: {
        headerLines: [cfg.headerLine1, cfg.headerLine2, cfg.headerLine3],
        phone: cfg.phone,
        vatNumber: cfg.vatNumber,
        receiptTitle: opts?.receiptTitle ?? cfg.receiptTitle,
        receiptNumberPrefix: opts?.receiptNumberPrefix,
        cashierName: resolveCashierDisplayName(session?.user),
        tillNumber: POS_TILL_CODE,
        tillLabel: cfg.tillLabel,
        slipLabel: cfg.slipLabel,
        receiptNumber: sale.saleId ?? sale._id.slice(-8),
        timestampIso: ts,
        paymentLabel,
        copyLabel: opts?.copyLabel,
        ...(paymentTenders ? { paymentTenders } : {}),
        ...(storeVoucherAck ? { storeVoucherAck } : {}),
        accountChargeAck: accountAck,
        refundAck: opts?.refundAck,
        ...(lineItemSections && lineItemSections.length > 0 ? { lineItemSections, lines: [] } : { lines: receiptLines }),
        subtotal,
        taxTotal: taxTotal > 0.005 ? taxTotal : undefined,
        vatRatePct: vatRate > 0 ? vatRate : undefined,
        vatLabel: cfg.vatLabel,
        subtotalLabel: cfg.subtotalLabel,
        taxTotalLabel: cfg.taxTotalLabel,
        totalDueLabel: opts?.totalDueLabel ?? cfg.totalDueLabel,
        cashTenderedLabel: cfg.cashTenderedLabel,
        changeDueLabel: cfg.changeDueLabel,
        thankYouLine: opts?.thankYouLine ?? cfg.thankYouLine,
        discountTotal: discountTotal > 0.005 ? discountTotal : undefined,
        total,
        tendered,
        changeDue,
      },
    }
  }

  async function printJobCardOpeningSlips(info: {
    jobNumber: string
    customerName: string
    phone: string
    itemCheckedIn?: string
    jobDescription?: string
    attachmentNote?: string
  }): Promise<{ ok: boolean; error?: string }> {
    if (!window.electronPos) return { ok: true }
    const cfg = printerSettings.receiptConfig
    const ts = new Date().toISOString()
    const barcodeValue = info.jobNumber.replace(/[^0-9A-Za-z]/g, '').toUpperCase()
    const copies = [
      { copyLabel: 'WORKSHOP COPY', hints: ['Attach this slip to the item being serviced.'], printAttachmentNote: true },
      { copyLabel: 'CUSTOMER COPY', hints: ['Customer keeps this slip. Present when collecting work.'], printAttachmentNote: false },
    ] as const
    for (const { copyLabel, hints, printAttachmentNote } of copies) {
      const receipt = {
        headerLines: [cfg.headerLine1, cfg.headerLine2, cfg.headerLine3],
        phone: cfg.phone,
        vatNumber: cfg.vatNumber,
        receiptTitle: 'JOB CARD',
        receiptNumberPrefix: 'Job',
        receiptNumber: info.jobNumber,
        barcodeValue: barcodeValue || undefined,
        cashierName: resolveCashierDisplayName(session?.user),
        tillNumber: POS_TILL_CODE,
        tillLabel: cfg.tillLabel,
        slipLabel: cfg.slipLabel,
        timestampIso: ts,
        paymentLabel: 'Open job — add charges then checkout',
        lines: [] as Array<{ qty: number; name: string; unitPrice: number; lineTotal: number }>,
        subtotal: 0,
        total: 0,
        jobCardOpenSlip: {
          customerName: jobCardCustomerDisplay(info.customerName),
          phone: info.phone,
          itemCheckedIn: info.itemCheckedIn,
          jobDescription: info.jobDescription,
          attachmentNote: info.attachmentNote,
          printAttachmentNote,
          hintLines: [...hints],
        },
        thankYouLine: cfg.thankYouLine,
        copyLabel,
        compactTopMargin: true,
      }
      const r = await window.electronPos.printReceipt(printerSettings.transport, receipt, {
        columns: printerSettings.columns,
        cut: printerSettings.cut,
      })
      if (!r.ok) return { ok: false, error: r.error ?? 'Print failed' }
    }
    return { ok: true }
  }

  async function printSaleReceiptsToDevice(sale: Sale): Promise<{ ok: boolean; error?: string }> {
    if (!window.electronPos) return { ok: true }
    const dual = saleHasOnAccountCharge(sale) || saleUsesStoreCredit(sale)
    const labels = dual ? (['CUSTOMER COPY', 'STORE COPY'] as const) : ([undefined] as const)
    for (const copyLabel of labels) {
      const p = receiptPayloadFromSale(sale, copyLabel ? { copyLabel } : undefined)
      const r = await window.electronPos.printReceipt(p.transport, p.receipt, { columns: p.columns, cut: p.cut })
      if (!r.ok) return { ok: false, error: r.error ?? 'Print failed' }
    }
    return { ok: true }
  }

  async function printRefundReceiptToDevice(
    sale: Sale,
    note?: string,
    payoutMethod?: 'cash' | 'card' | 'store_credit',
    printSlice?: {
      lines: Array<{ qty: number; name: string; unitPrice: number; listUnitPrice?: number; lineTotal: number }>
      refundTotal: number
      cashPaidOut?: number
      cardPaidOut?: number
      storeCreditIssued?: number
      /** Digits-only phone used for refund voucher payout (masked on slip). */
      storeCreditPhoneDigits?: string
    },
  ): Promise<{ ok: boolean; error?: string }> {
    if (!window.electronPos) return { ok: true }
    const settings = readPosPrinterSettings()
    const settledBy = payoutMethod ?? sale.refundPayoutMethod ?? 'cash'
    const refundTxnTotal = printSlice?.refundTotal ?? sale.total
    const hasExplicit =
      printSlice &&
      (printSlice.cashPaidOut !== undefined ||
        printSlice.cardPaidOut !== undefined ||
        printSlice.storeCreditIssued !== undefined)
    let refundCash = 0
    let refundCard = 0
    let refundStoreCredit = 0
    if (hasExplicit) {
      refundCash = Math.max(0, Number(printSlice!.cashPaidOut ?? 0))
      refundCard = Math.max(0, Number(printSlice!.cardPaidOut ?? 0))
      refundStoreCredit = Math.max(0, Number(printSlice!.storeCreditIssued ?? 0))
    } else {
      refundCash = settledBy === 'cash' ? refundTxnTotal : 0
      refundCard = settledBy === 'card' ? refundTxnTotal : 0
    }
    const payoutLabel =
      settledBy === 'store_credit'
        ? 'Store credit'
        : settledBy === 'card'
          ? 'Card'
          : 'Cash'
    const ackNoteParts = [note?.trim(), `Payout: ${payoutLabel}`].filter(Boolean)
    const digitsForMask = printSlice?.storeCreditPhoneDigits?.replace(/\D/g, '') ?? ''
    const storeCreditPhoneDisplay =
      refundStoreCredit > 0.005 && digitsForMask
        ? maskPhoneForReceipt(digitsForMask)
        : undefined
    const p = receiptPayloadFromSale(sale, {
      copyLabel: 'REFUND',
      receiptTitle: 'REFUND RECEIPT',
      receiptNumberPrefix: 'Refund',
      totalDueLabel: 'REFUND TOTAL:',
      paymentLabelOverride: settledBy === 'store_credit' ? 'Refund (store credit)' : 'Refund',
      thankYouLine: 'PLEASE SIGN BELOW',
      refundPrintSlice: printSlice,
      refundAck: {
        refundTotal: refundTxnTotal,
        refundCash,
        refundCard,
        refundStoreCredit: refundStoreCredit > 0.005 ? refundStoreCredit : undefined,
        ...(storeCreditPhoneDisplay && storeCreditPhoneDisplay !== '—'
          ? { storeCreditPhoneDisplay }
          : {}),
        note: ackNoteParts.join(' · '),
      },
    })
    const r = await window.electronPos.printReceipt(p.transport, p.receipt, { columns: p.columns, cut: p.cut })
    if (!r.ok) return { ok: false, error: r.error ?? 'Refund receipt print failed' }
    if (settings.autoOpenDrawer && (refundCash > 0.005 || refundCard > 0.005)) {
      const d = await window.electronPos.kickDrawer(settings.transport)
      if (!d.ok) return { ok: false, error: d.error ?? 'Refund saved, receipt printed, but drawer failed to open' }
    }
    return { ok: true }
  }

  function houseAccountPaymentReceiptPayload(input: {
    account: HouseAccountRow
    amount: number
    method: 'cash' | 'card'
  }): ReceiptPrintPayload {
    const cfg = printerSettings.receiptConfig
    const nowIso = new Date().toISOString()
    return {
      transport: printerSettings.transport,
      columns: printerSettings.columns,
      cut: printerSettings.cut,
      receipt: {
        headerLines: [cfg.headerLine1, cfg.headerLine2, cfg.headerLine3],
        phone: cfg.phone,
        vatNumber: cfg.vatNumber,
        receiptTitle: 'ACCOUNT PAYMENT',
        receiptNumberPrefix: 'Account',
        cashierName: resolveCashierDisplayName(session?.user),
        tillNumber: POS_TILL_CODE,
        tillLabel: cfg.tillLabel,
        slipLabel: cfg.slipLabel,
        receiptNumber: input.account.accountNumber,
        timestampIso: nowIso,
        paymentLabel: input.method === 'cash' ? 'Cash' : 'Card',
        lines: [
          {
            qty: 1,
            name: `Payment to ${input.account.accountNumber}${input.account.name ? ` · ${input.account.name}` : ''}`,
            unitPrice: input.amount,
            lineTotal: input.amount,
          },
        ],
        subtotal: input.amount,
        total: input.amount,
        totalDueLabel: 'PAYMENT AMOUNT:',
        balanceRemaining: Math.max(0, input.account.balance),
        thankYouLine: 'Account payment recorded',
      },
    }
  }

  async function printHouseAccountPaymentReceiptToDevice(input: {
    account: HouseAccountRow
    amount: number
    method: 'cash' | 'card'
  }): Promise<{ ok: boolean; error?: string; payload: ReceiptPrintPayload }> {
    const p = houseAccountPaymentReceiptPayload(input)
    if (!window.electronPos) return { ok: true, payload: p }
    const r = await window.electronPos.printReceipt(p.transport, p.receipt, { columns: p.columns, cut: p.cut })
    if (!r.ok) return { ok: false, error: r.error ?? 'Account payment receipt print failed', payload: p }
    return { ok: true, payload: p }
  }

  async function printOfflineReconciliationListToDevice(): Promise<{ ok: boolean; error?: string }> {
    if (offlineReconcileItems.length === 0) return { ok: true }
    const cfg = printerSettings.receiptConfig
    const totalUnits = offlineReconcileItems.reduce((sum, item) => sum + item.qty, 0)
    const payload = {
      transport: printerSettings.transport,
      columns: printerSettings.columns,
      cut: printerSettings.cut,
      receipt: {
        headerLines: [cfg.headerLine1, cfg.headerLine2, cfg.headerLine3].filter((x) => typeof x === 'string' && x.trim()),
        phone: cfg.phone,
        vatNumber: cfg.vatNumber,
        receiptTitle: 'OFFLINE STOCK CHECK',
        receiptNumberPrefix: 'Till',
        receiptNumber: POS_TILL_CODE,
        cashierName: resolveCashierDisplayName(session?.user),
        tillNumber: POS_TILL_CODE,
        tillLabel: cfg.tillLabel,
        slipLabel: cfg.slipLabel,
        timestampIso: offlineReconcileSyncedAt ?? new Date().toISOString(),
        paymentLabel: 'Offline sync reconciliation',
        lines: offlineReconcileItems.map((item) => ({
          qty: item.qty,
          name: item.name,
          unitPrice: 0,
          lineTotal: 0,
        })),
        subtotal: totalUnits,
        taxTotal: 0,
        total: totalUnits,
        totalDueLabel: 'Total units:',
        thankYouLine: 'Verify on-hand qty and report discrepancies.',
        compactTopMargin: true,
      },
    }
    if (!window.electronPos) return { ok: true }
    const r = await window.electronPos.printReceipt(payload.transport, payload.receipt, {
      columns: payload.columns,
      cut: payload.cut,
    })
    if (!r.ok) return { ok: false, error: r.error ?? 'Failed to print reconciliation list' }
    return { ok: true }
  }

  async function printShiftReportToDevice(report: ShiftReport): Promise<void> {
    if (!window.electronPos) return
    const cfg = printerSettings.receiptConfig
    const s = report.summary
    const payload = {
      transport: printerSettings.transport,
      columns: printerSettings.columns,
      cut: printerSettings.cut,
      receipt: {
        headerLines: [cfg.headerLine1, cfg.headerLine2, cfg.headerLine3],
        phone: cfg.phone,
        vatNumber: cfg.vatNumber,
        receiptTitle: 'SHIFT Z REPORT',
        receiptNumberPrefix: 'Shift',
        receiptNumber: String(report.shiftId).slice(-8),
        cashierName: resolveCashierDisplayName(session?.user),
        tillNumber: report.tillCode,
        tillLabel: cfg.tillLabel,
        slipLabel: cfg.slipLabel,
        timestampIso: new Date().toISOString(),
        paymentLabel: 'Shift summary',
        lines: [{ qty: 1, name: 'Shift report', unitPrice: s.turnover, lineTotal: s.turnover }],
        shiftReport: {
          turnover: s.turnover,
          cashSales: s.cashSales,
          cardSales: s.cardSales,
          voucherTotal: s.voucherTotal,
          onAccountTotal: s.onAccountTotal,
          refundTotal: s.refundTotal,
          refundCashTotal: s.refundCashTotal,
          refundCardTotal: s.refundCardTotal,
          refundCount: s.refundCount,
          refundCashierNames: s.refundCashierNames,
          refundDetails: (s.refundDetails ?? []).map((r) => ({
            saleId: r.saleId,
            cashierName: r.cashierName || (r.cashierId ? r.cashierId.slice(-6) : 'Cashier'),
            method: r.method,
            refundTotal: r.refundTotal,
            refundCash: r.refundCash,
            refundCard: r.refundCard,
          })),
          layByCompletions: s.layByCompletions,
          layByPaymentCount: s.layByPaymentCount,
          layByPaymentCashTotal: s.layByPaymentCashTotal,
          layByPaymentCardTotal: s.layByPaymentCardTotal,
          layByPaymentStoreCreditTotal: s.layByPaymentStoreCreditTotal,
          layByPaymentTotal: s.layByPaymentTotal,
          quoteConversions: s.quoteConversions,
          tabClosures: s.tabClosures,
          cashierSales: s.cashierSales.map((c) => ({
            cashierName: c.cashierName || c.cashierId.slice(-6),
            salesCount: c.salesCount,
            total: c.total,
          })),
          priceOverrides: (s.priceOverrides ?? []).map((o) => ({
            saleId: o.saleId,
            cashierName: o.cashierName || (o.cashierId ? o.cashierId.slice(-6) : 'Cashier'),
            itemName: o.itemName,
            quantity: o.quantity,
            listUnitPrice: o.listUnitPrice,
            overriddenUnitPrice: o.overriddenUnitPrice,
            lineDiscount: o.lineDiscount,
          })),
          cashDifferences: report.cashDifferences.map((d) => ({
            kind: d.kind,
            amount: d.amount,
            note: d.note,
          })),
        },
        subtotal: s.turnover,
        total: s.turnover,
      },
    }
    await window.electronPos.printReceipt(payload.transport, payload.receipt, {
      columns: payload.columns,
      cut: payload.cut,
    })
  }

  function receiptPayloadFromQuote(q: QuoteDetail): {
    transport: unknown
    receipt: unknown
    columns: number
    cut: boolean
  } {
    const cfg = printerSettings.receiptConfig
    const ts = q.createdAt ?? new Date().toISOString()
    const total = q.totalInclVat
    const taxTotal = q.totalVatAmount > 0.005 ? q.totalVatAmount : undefined
    const subtotal = q.totalNetAmount
    const vatRatePct = (q.vatRate ?? 0) * 100
    const baseHeader = [cfg.headerLine1, cfg.headerLine2, cfg.headerLine3].filter(
      (x) => typeof x === 'string' && x.trim().length > 0,
    ) as string[]
    const extra: string[] = []
    if (q.customerName?.trim()) extra.push(q.customerName.trim())
    if (q.phone?.trim()) extra.push(`Tel ${q.phone.trim()}`)

    const validStr = formatDateDdMmYyyy(q.validUntil)
    const thankYou = (q.isExpired ? 'EXPIRED — ' : '') + `Quotation valid until ${validStr}`

    return {
      transport: printerSettings.transport,
      columns: printerSettings.columns,
      cut: printerSettings.cut,
      receipt: {
        headerLines: [...baseHeader, ...extra],
        phone: cfg.phone,
        vatNumber: cfg.vatNumber,
        receiptTitle: 'QUOTATION',
        receiptNumberPrefix: 'Quote',
        receiptNumber: q.quoteNumber,
        cashierName: resolveCashierDisplayName(session?.user),
        tillNumber: POS_TILL_CODE,
        tillLabel: cfg.tillLabel,
        slipLabel: cfg.slipLabel,
        timestampIso: ts,
        paymentLabel: 'Quotation only (not a receipt)',
        lines: q.lines.map((l) => ({
          qty: l.quantity,
          name: l.name,
          unitPrice: l.unitPrice,
          lineTotal: l.lineTotal,
        })),
        subtotal,
        taxTotal,
        vatRatePct: typeof taxTotal === 'number' && vatRatePct > 0.005 ? vatRatePct : undefined,
        vatLabel: cfg.vatLabel,
        subtotalLabel: cfg.subtotalLabel,
        taxTotalLabel: cfg.taxTotalLabel,
        totalDueLabel: 'Quote total (incl. VAT):',
        thankYouLine: thankYou,
        total,
        compactTopMargin: true,
      },
    }
  }

  async function printQuoteById(id: string) {
    setError(null)
    try {
      const detail = await apiFetch<QuoteDetail>(`/quotes/${id}`)
      const p = receiptPayloadFromQuote(detail)
      if (!window.electronPos) {
        setNotice('Quote slip would print on the configured POS printer (Electron).')
        return
      }
      const r = await window.electronPos.printReceipt(p.transport, p.receipt, { columns: p.columns, cut: p.cut })
      if (!r.ok) {
        setError(r.error ?? 'Print failed')
        return
      }
      setNotice('Quote printed')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Print failed')
    }
  }

  async function printLastReceipt(last: LastReceiptForReprint) {
    setError(null)
    try {
      if (last.kind === 'raw') {
        if (!window.electronPos) {
          setNotice(last.successNotice ?? 'Receipt printed (web preview)')
          return
        }
        const r = await window.electronPos.printReceipt(last.payload.transport, last.payload.receipt, {
          columns: last.payload.columns,
          cut: last.payload.cut,
        })
        if (!r.ok) {
          setError(r.error ?? 'Receipt print failed')
          return
        }
        setNotice(last.successNotice ?? 'Receipt printed')
        return
      }
      const sale = last.sale
      if (!window.electronPos) {
        setNotice('Receipt printed (web preview)')
        return
      }
      const r = await printSaleReceiptsToDevice(sale)
      if (!r.ok) {
        setError(r.error ?? 'Receipt print failed')
        return
      }
      setNotice(saleHasOnAccountCharge(sale) ? 'Printed customer + store copies' : 'Receipt printed')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Receipt print failed')
    }
  }

  async function postSaleHardwareActions(sale: Sale) {
    if (!window.electronPos) return
    try {
      const settings = readPosPrinterSettings()
      if (settings.autoPrintReceipt && receiptEnabled) {
        await printSaleReceiptsToDevice(sale)
      }
      const pm = (sale.paymentMethod ?? '').toLowerCase()
      if (settings.autoOpenDrawer && pm !== 'on_account') {
        await window.electronPos.kickDrawer(settings.transport)
      }
    } catch {
      // Silent: do not block checkout UX.
    }
  }

  async function openDrawer() {
    if (!isAdmin) {
      setError('Manager permission required to open drawer')
      return
    }
    setError(null)
    try {
      if (!window.electronPos) {
        setNotice('Drawer command accepted (web preview)')
        return
      }
      const result = await window.electronPos.kickDrawer(printerSettings.transport)
      if (!result.ok) {
        setError(result.error ?? 'Drawer command failed')
        return
      }
      setNotice('Drawer opened')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Drawer command failed')
    }
  }

  async function submitHouseAccountPayment() {
    if (!houseAccountPaymentTarget || busy) return
    setError(null)
    setNotice(null)
    const amount = round2(parseTenderedInput(houseAccountPaymentAmountStr.trim(), 0))
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('Enter payment amount')
      return
    }
    setBusy(true)
    try {
      const latest = await apiFetch<HouseAccountRow>(`/house-accounts/${houseAccountPaymentTarget._id}`)
      if (latest.status !== 'active') {
        setError('Account is not active')
        return
      }
      if (amount > latest.balance + 0.01) {
        setError(`Payment cannot exceed owed balance ${latest.balance.toFixed(2)}`)
        return
      }
      const updated = await apiFetch<HouseAccountRow>(`/house-accounts/${houseAccountPaymentTarget._id}/payments`, {
        method: 'POST',
        body: JSON.stringify({
          amount,
          cashAmount: houseAccountPaymentMethod === 'cash' ? amount : 0,
          cardAmount: houseAccountPaymentMethod === 'card' ? amount : 0,
          note: `POS payment (${houseAccountPaymentMethod})`,
        }),
      })
      setHouseAccountPaymentTarget(updated)
      if (houseAccountForCheckout && houseAccountForCheckout._id === updated._id) {
        setHouseAccountForCheckout(updated)
      }
      const printed = await printHouseAccountPaymentReceiptToDevice({
        account: updated,
        amount,
        method: houseAccountPaymentMethod,
      })
      if (!printed.ok) {
        setError(printed.error ?? 'Payment saved but receipt print failed')
      }
      setLastReceiptForReprint({
        kind: 'raw',
        payload: printed.payload,
        successNotice: 'Account payment receipt printed',
      })
      if (window.electronPos && houseAccountPaymentMethod === 'cash') {
        const settings = readPosPrinterSettings()
        if (settings.autoOpenDrawer) {
          const d = await window.electronPos.kickDrawer(settings.transport)
          if (!d.ok) setError(d.error ?? 'Payment saved, but drawer failed to open')
        }
      }
      setNotice(
        `Account ${updated.accountNumber} paid ${amount.toFixed(2)} · Remaining balance ${updated.balance.toFixed(2)}`,
      )
      setHouseAccountPaymentAmountStr('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to record account payment')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`register-viewport${refundSession ? ' register-viewport--refund-mode' : ''}`}>
      <PosShell
        beforeSignOut={() => {
          if (cart.length > 0) {
            setNotice('Clear the cart or complete the sale before signing out.')
            return false
          }
          return true
        }}
      >
        <div className="register-main-stack">
          {refundSession ? (
            <div className="register-refund-banner" role="status" aria-live="polite">
              <span className="register-refund-banner-badge">Refund</span>
              <span className="register-refund-banner-meta">
                Sale{' '}
                <strong>{refundSession.previewSale.saleId ?? refundSession.previewSale._id.slice(-10)}</strong>
                {refundSession.previewSale.createdAt ? (
                  <>
                    {' '}
                    · {formatDateDdMmYyyy(refundSession.previewSale.createdAt)}
                  </>
                ) : null}
                {' · '}
                Already refunded R {refundSession.refundPreview.refundedTotal.toFixed(2)} · Remaining R{' '}
                {refundSession.refundPreview.remainingTotal.toFixed(2)}
              </span>
              <button type="button" className="btn ghost small register-refund-banner-exit" onClick={() => void exitRefundModePrompt()}>
                Exit refund
              </button>
            </div>
          ) : null}
          <div className="register-grid">
          <section className="panel panel-products">
            <div className="products-header">
              <div className="products-header-titles">
                <h2>
                  {registerLeftPanel === 'list'
                    ? 'Item List'
                    : registerLeftPanel === 'presets'
                      ? 'Presets'
                      : 'Register Keys'}
                </h2>
                {activeTabBanner ? (
                  <div className="register-tab-banner">
                    <span className="register-tab-banner-text">
                      {activeTabBanner.kind === 'job_card' ? (
                        <>
                          Job card <strong>{activeTabBanner.jobNumber ?? activeTabBanner.tabNumber}</strong>
                        </>
                      ) : (
                        <>
                          Tab <strong>#{activeTabBanner.tabNumber}</strong>
                        </>
                      )}
                      {' · '}
                      {activeTabBanner.kind === 'job_card'
                        ? jobCardCustomerDisplay(activeTabBanner.customerName)
                        : activeTabBanner.customerName}
                      {activeTabBanner.phone ? ` · ${activeTabBanner.phone}` : ''}
                    </span>
                    <button type="button" className="btn ghost key-action register-tab-walkin" onClick={() => void closeActiveTabSession()}>
                      {activeTabBanner.kind === 'job_card' ? 'Close job card' : 'Close tab'}
                    </button>
                  </div>
                ) : null}
                {activeQuoteBanner ? (
                  <div className="register-tab-banner register-quote-banner">
                    <span className="register-tab-banner-text">
                      Quote <strong>{activeQuoteBanner.quoteNumber}</strong>
                      {' · valid until '}
                      {formatDateDdMmYyyy(activeQuoteBanner.validUntil)}
                      {' · snapshot prices'}
                    </span>
                    {activeQuoteId ? (
                      <div className="register-tab-banner-actions">
                        <button
                          type="button"
                          className="btn ghost key-action register-tab-walkin"
                          onClick={() => void printQuoteById(activeQuoteId)}
                        >
                          Print quote
                        </button>
                        <button
                          type="button"
                          className="btn ghost key-action register-tab-walkin"
                          onClick={closeQuoteFromCart}
                        >
                          Close quote
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <div className="products-header-actions">
                <button
                  type="button"
                  className="btn ghost key-action"
                  onClick={() => setRegisterLeftPanel((m) => (m === 'presets' ? 'keys' : 'presets'))}
                >
                  {registerLeftPanel === 'presets' ? 'Register keys' : 'Presets'}
                </button>
                <button
                  type="button"
                  className="btn ghost key-action"
                  onClick={() => setRegisterLeftPanel((m) => (m === 'list' ? 'keys' : 'list'))}
                >
                  {registerLeftPanel === 'list' ? 'Hide list' : 'Item list'}
                </button>
                {isAdmin && offlineReconcileItems.length > 0 ? (
                  <button
                    type="button"
                    className="btn ghost key-action"
                    onClick={() => setOfflineReconcileModalOpen(true)}
                    title="Reopen latest offline stock reconciliation list"
                  >
                    Reconciliation
                  </button>
                ) : null}
              </div>
            </div>

            {registerLeftPanel === 'keys' ? (
              <div className="keys-layout">
                <div className="sku-display" title="SKU, or qty×SKU then ENTER">
                  <span className="muted">&nbsp;</span>
                  <strong>{skuInput}</strong>
                </div>
                <div className="keys-buttons-wrap">
                  <div className="keys-main-pad">
                    <div className="keys-grid">
                      <button type="button" className="key-btn" onClick={() => pressKey('7')}>7</button>
                      <button type="button" className="key-btn" onClick={() => pressKey('8')}>8</button>
                      <button type="button" className="key-btn" onClick={() => pressKey('9')}>9</button>
                      <button type="button" className="key-btn key-btn-danger" onClick={() => pressKey('clear')}>CL</button>
                      <button type="button" className="key-btn" onClick={() => pressKey('4')}>4</button>
                      <button type="button" className="key-btn" onClick={() => pressKey('5')}>5</button>
                      <button type="button" className="key-btn" onClick={() => pressKey('6')}>6</button>
                      <button type="button" className="key-btn" onClick={() => pressKey('backspace')}>⌫</button>
                      <button type="button" className="key-btn" onClick={() => pressKey('1')}>1</button>
                      <button type="button" className="key-btn" onClick={() => pressKey('2')}>2</button>
                      <button type="button" className="key-btn" onClick={() => pressKey('3')}>3</button>
                      <button
                        type="button"
                        className="key-btn key-btn-primary key-btn-enter"
                        aria-label="Enter"
                        title="Enter"
                        onClick={() => pressKey('enter')}
                      >
                        ↵
                      </button>
                      <button type="button" className="key-btn" onClick={() => pressKey('0')}>0</button>
                      <button type="button" className="key-btn" onClick={() => pressKey('.')}>.</button>
                      <button
                        type="button"
                        className="key-btn"
                        title="Quantity × SKU (then ENTER)"
                        onClick={() => pressKey('×')}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                  <div className="keys-function-pad">
                    <div className="function-grid">
                      <button
                        type="button"
                        className="key-btn key-btn-fn"
                        onClick={voidLastItem}
                        disabled={cart.length === 0}
                      >
                        VOID ITEM
                      </button>
                      <button
                        type="button"
                        className="key-btn key-btn-fn"
                        disabled={!!refundSession}
                        title={refundSession ? 'Finish refund first' : undefined}
                        onClick={() => {
                          setOpenTabsModalOpen(true)
                          void loadOpenTabsList()
                        }}
                      >
                        TABS
                      </button>
                      {canRefund ? (
                        <button
                          type="button"
                          className="key-btn key-btn-fn"
                          title={
                            refundSession
                              ? 'Leave refund mode (cart will clear)'
                              : 'Refund — enter sale id from receipt'
                          }
                          onClick={() => {
                            if (refundSession) {
                              void exitRefundModePrompt()
                              return
                            }
                            if (activeOpenTabId) {
                              setError('Close or complete the open tab before refund')
                              return
                            }
                            if (cart.length > 0) {
                              setError('Clear the cart or complete the sale before refund')
                              return
                            }
                            setRefundSaleIdModalOpen(true)
                          }}
                        >
                          {refundSession ? 'EXIT REFUND' : 'REFUND'}
                        </button>
                      ) : null}
                      {canShiftEnd ? (
                        <button
                          type="button"
                          className="key-btn key-btn-fn"
                          disabled={!!refundSession}
                          title={refundSession ? 'Finish refund first' : 'Print Z report, then continue or close shift'}
                          onClick={() => setShiftEndModalOpen(true)}
                        >
                          SHIFT END
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="key-btn key-btn-fn"
                        disabled={!!refundSession}
                        title={refundSession ? 'Finish refund first' : 'House accounts payments'}
                        onClick={openHouseAccountsForPayment}
                      >
                        ACCOUNTS
                      </button>
                      <button
                        type="button"
                        className="key-btn key-btn-fn"
                        disabled={!!activeOpenTabId || !!refundSession}
                        title={
                          refundSession
                            ? 'Finish refund first'
                            : activeOpenTabId
                              ? 'Finish or close tab first'
                              : undefined
                        }
                        onClick={() => {
                          setQuotesModalOpen(true)
                          void loadQuotesList('', '')
                        }}
                      >
                        QUOTE
                      </button>
                      <button
                        type="button"
                        className="key-btn key-btn-fn"
                        disabled={!!activeOpenTabId || !!refundSession || offlineCatalogMode}
                        title={
                          offlineCatalogMode
                            ? 'Lay-by unavailable while offline'
                            : refundSession
                              ? 'Finish refund first'
                              : activeOpenTabId
                                ? 'Finish or close tab first'
                                : undefined
                        }
                        onClick={() => {
                          if (offlineCatalogMode) {
                            setError('Lay-by is unavailable while offline')
                            return
                          }
                          setLayByModalOpen(true)
                        }}
                      >
                        LAY-BY
                      </button>
                      <button
                        type="button"
                        className="key-btn key-btn-fn"
                        title="Enter price on keypad, then tap (last cart line)"
                        onClick={() => priceOverrideLast()}
                      >
                        PRICE OVERRIDE
                      </button>
                      <button
                        type="button"
                        className="key-btn key-btn-fn key-btn-discount"
                        title="Tap: last line · Hold: whole cart"
                        disabled={cart.length === 0 || !!refundSession}
                        onPointerDown={onDiscountPointerDown}
                        onPointerMove={onDiscountPointerMove}
                        onPointerUp={onDiscountPointerUp}
                        onPointerCancel={onDiscountPointerCancel}
                        onClick={onDiscountClick}
                      >
                        DISCOUNT %
                      </button>
                      <button
                        type="button"
                        className={`key-btn key-btn-fn ${receiptEnabled ? 'key-btn-receipt-on' : 'key-btn-receipt-off'}`}
                        onClick={() => setReceiptEnabled((v) => !v)}
                      >
                        {receiptEnabled ? 'RECEIPT ON' : 'RECEIPT OFF'}
                      </button>
                      <button
                        type="button"
                        className="key-btn key-btn-fn"
                        disabled={!lastReceiptForReprint || busy}
                        onClick={() => lastReceiptForReprint && void printLastReceipt(lastReceiptForReprint)}
                        title={
                          lastReceiptForReprint
                            ? 'Reprint last completed sale receipt'
                            : 'Complete a sale to enable reprint'
                        }
                      >
                        PRINT LAST
                      </button>
                      <button type="button" className="key-btn key-btn-fn" onClick={() => void openDrawer()}>
                        OPEN DRAWER
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ) : registerLeftPanel === 'presets' ? (
              <div className="presets-layout">
                <div className="presets-nav-header">
                  {presetNav.screen !== 'categories' ? (
                    <button
                      type="button"
                      className="btn ghost key-action presets-back-btn"
                      onClick={() => {
                        if (presetNav.screen === 'items') {
                          setPresetNav({ screen: 'subs', category: presetNav.category })
                        } else {
                          setPresetNav({ screen: 'categories' })
                        }
                      }}
                    >
                      ← Back
                    </button>
                  ) : (
                    <span className="presets-back-spacer" aria-hidden />
                  )}
                  <p className="muted presets-breadcrumb">
                    {presetNav.screen === 'categories' && 'Choose a category'}
                    {presetNav.screen === 'subs' ? (
                      <>
                        <strong>{presetNav.category}</strong>
                        <span className="presets-breadcrumb-sub"> · choose sub-category</span>
                      </>
                    ) : null}
                    {presetNav.screen === 'items' ? (
                      <>
                        <strong>{presetNav.category}</strong>
                        <span> › </span>
                        <strong>{presetNav.subCategory}</strong>
                        <span className="presets-breadcrumb-sub"> · choose item</span>
                      </>
                    ) : null}
                  </p>
                </div>
                <p className="muted presets-hint">
                  Category → sub-category → item. Assign from Item list (long-press or right-click a product). On the
                  item screen, long-press a row to remove that preset (max {PRESET_ENTRY_MAX} items).
                </p>
                <div className="presets-screen">
                  {presetNav.screen === 'categories' ? (
                    presetCategories.length === 0 ? (
                      <p className="muted presets-empty">No presets yet. Open Item list and assign products.</p>
                    ) : (
                      <ul className="preset-nav-list">
                        {presetCategories.map((cat) => (
                          <li key={cat}>
                            <button
                              type="button"
                              className="preset-nav-tile"
                              onClick={() => setPresetNav({ screen: 'subs', category: cat })}
                            >
                              {cat}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )
                  ) : null}
                  {presetNav.screen === 'subs' ? (
                    <ul className="preset-nav-list">
                      {presetSubCategories.map((sub) => (
                        <li key={sub}>
                          <button
                            type="button"
                            className="preset-nav-tile"
                            onClick={() =>
                              setPresetNav({
                                screen: 'items',
                                category: presetNav.category,
                                subCategory: sub,
                              })
                            }
                          >
                            {sub}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {presetNav.screen === 'items' ? (
                    presetItemsForNav.length === 0 ? (
                      <p className="muted presets-empty">No items in this sub-category. Use Back.</p>
                    ) : (
                    <ul className="preset-item-nav-list">
                      {presetItemsForNav.map(({ entry, index }) => {
                        const p = products.find((x) => x._id === entry.productId)
                        const title = p ? p.name : entry.label
                        const stale = !p
                        return (
                          <li key={`${index}-${entry.productId}`} className="preset-item-nav-li">
                            <button
                              type="button"
                              className={`preset-item-tile ${stale ? 'preset-item-tile--stale' : ''}`}
                              onClick={(e) => onPresetItemClick(e, entry)}
                              onPointerDown={(e) => onPresetItemPointerDown(e, index)}
                              onPointerMove={onPresetItemPointerMove}
                              onPointerUp={onPresetItemPointerUp}
                              onPointerCancel={onPresetItemPointerCancel}
                              title={
                                stale
                                  ? 'Product missing — long-press to remove or tap Remove'
                                  : 'Tap to add to cart · Long-press to remove preset'
                              }
                            >
                              <span className="preset-item-tile-title">{title}</span>
                              {p ? (
                                <span className="preset-item-tile-meta muted">{p.sku}</span>
                              ) : (
                                <span className="preset-item-tile-meta preset-item-tile-stale-msg">
                                  No longer in catalog
                                </span>
                              )}
                            </button>
                            {stale ? (
                              <button
                                type="button"
                                className="btn ghost small preset-item-remove-inline"
                                onClick={() => removePresetEntryAt(index)}
                              >
                                Remove preset
                              </button>
                            ) : null}
                          </li>
                        )
                      })}
                    </ul>
                    )
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="item-list-layout">
                <input
                  className="search touch-search"
                  type="search"
                  inputMode={itemListScreenKbOpen ? 'none' : 'search'}
                  enterKeyHint="search"
                  placeholder="Search name or SKU…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  onFocus={() => {
                    cancelItemListKbBlurHide()
                    setItemListScreenKbOpen(true)
                  }}
                  onBlur={() => {
                    cancelItemListKbBlurHide()
                    itemListKbBlurTimerRef.current = window.setTimeout(() => {
                      setItemListScreenKbOpen(false)
                    }, 200)
                  }}
                  autoComplete="off"
                />
                <p className="muted item-list-tap-hint">
                  Tap a row to add. Long-press or right-click to add to the Presets menu (category → sub-category →
                  item, up to {PRESET_ENTRY_MAX}).
                </p>
                <div className="product-browser">
                  <ul className="product-list">
                    {filtered.map((p) => (
                      <li key={p._id}>
                        {(() => {
                          const canTapProduct =
                            productHasSellableStock(p) || (productTracksInventory(p) && (offlineCatalogMode || !serverReachable || isAdmin))
                          return (
                        <button
                          type="button"
                          className="product-row"
                          aria-label={
                            canTapProduct
                              ? `Add ${p.name} to cart`
                              : `${p.name} — out of stock`
                          }
                          onClick={(e) => onProductRowClick(e, p)}
                          onPointerDown={(e) => onProductRowPointerDown(e, p)}
                          onPointerMove={onProductRowPointerMove}
                          onPointerUp={onProductRowPointerUp}
                          onPointerCancel={onProductRowPointerCancel}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            if (!canTapProduct) return
                            setAssignPresetProduct(p)
                          }}
                          title="Tap to add · Long-press or right-click to assign to preset"
                          disabled={!canTapProduct}
                        >
                          <span className="product-name">{p.name}</span>
                          <span className="product-meta">
                            <span className="muted">{p.sku}</span>
                            <span className="product-price">
                              {p.price.toFixed(2)} · {productAvailabilityCaptionWithMode(p, offlineCatalogMode)}
                            </span>
                          </span>
                        </button>
                          )
                        })()}
                      </li>
                    ))}
                  </ul>
                  {filtered.length === 0 && (
                    <p className="muted empty-hint empty-hint-products">
                      No products. Add some in Back Office (admin).
                    </p>
                  )}
                </div>
                <ScreenKeyboard
                  visible={itemListScreenKbOpen}
                  onAction={handleItemListScreenKeyboardAction}
                />
              </div>
            )}
          </section>

          <section className="panel panel-cart">
            {showChangeView && lastChangeDue !== null ? (
              <div className="cart-change-view cart-change-view--complete">
                <h2>Sale complete</h2>
                <div className="change-summary muted" aria-live="polite">
                  <div>Total: <strong>{(lastTotal ?? 0).toFixed(2)}</strong></div>
                  <div>Cash: <strong>{(lastTendered ?? 0).toFixed(2)}</strong></div>
                  <div>Card: <strong>{(lastCardAmount ?? 0).toFixed(2)}</strong></div>
                  {lastStoreCredit != null && lastStoreCredit > 0 ? (
                    <div>
                      Store voucher: <strong>{lastStoreCredit.toFixed(2)}</strong>
                    </div>
                  ) : null}
                  {lastOnAccount != null && lastOnAccount > 0 ? (
                    <div>
                      On account: <strong>{lastOnAccount.toFixed(2)}</strong>
                    </div>
                  ) : null}
                </div>
                <div className="change-amount" role="status">
                  Change due {(lastChangeDue ?? 0).toFixed(2)}
                </div>
                <p className="muted">Next item scanned/added will return to cart.</p>
              </div>
            ) : pendingSplit ? (
              <div className="cart-change-view cart-change-view--incomplete">
                <div className="cart-change-scroll">
                  <h2>Sale incomplete</h2>
                  <div className="change-summary muted" aria-live="polite">
                    <div>Total: <strong>{pendingSplit.total.toFixed(2)}</strong></div>
                    <div>Cash received: <strong>{pendingSplit.cashReceived.toFixed(2)}</strong></div>
                    <div>Card received: <strong>{pendingSplit.cardReceived.toFixed(2)}</strong></div>
                    {pendingSplit.storeCreditApplied > 0 ? (
                      <div>
                        Store voucher: <strong>{pendingSplit.storeCreditApplied.toFixed(2)}</strong>
                      </div>
                    ) : null}
                    {pendingSplit.onAccountApplied > 0 ? (
                      <div>
                        On account ({pendingSplit.houseAccountNumber}):{' '}
                        <strong>{pendingSplit.onAccountApplied.toFixed(2)}</strong>
                        {pendingSplit.purchaseOrderNumber ? ` · PO ${pendingSplit.purchaseOrderNumber}` : ''}
                      </div>
                    ) : null}
                  </div>
                  <div className="amount-due-label">Amount due</div>
                  <div className="change-amount amount-due-value" role="status">
                    {pendingSplit.amountDue.toFixed(2)}
                  </div>
                  <div className="register-alt-payment-wrap">
                    <button
                      type="button"
                      className="btn ghost small register-alt-payment-toggle"
                      aria-expanded={altPaymentExpanded}
                      disabled={altPaymentsOfflineDisabled}
                      onClick={() => setAltPaymentExpanded((v) => !v)}
                    >
                      {altPaymentExpanded ? 'Hide alt payment options' : 'Alt payment options'}
                    </button>
                    {altPaymentsOfflineDisabled ? (
                      <p className="muted small" style={{ marginTop: '0.35rem' }}>
                        Alt payment options unavailable while offline.
                      </p>
                    ) : null}
                    {altPaymentExpanded ? (
                      <>
                        <div className="register-voucher-panel">
                          <div className="register-voucher-toolbar">
                            <button
                              type="button"
                              className="btn ghost small"
                              onClick={() => setVoucherFormOpen((v) => !v)}
                              aria-expanded={voucherFormOpen}
                            >
                              {voucherFormOpen ? 'Hide voucher' : 'Apply voucher'}
                            </button>
                          </div>
                          {voucherFormOpen ? (
                            <>
                              <div className="register-voucher-title">Store voucher</div>
                              <div className="register-voucher-row">
                                <input
                                  ref={voucherPhoneInputRef}
                                  className="register-voucher-input"
                                  type="tel"
                                  inputMode={voucherScreenKbOpen ? 'none' : 'numeric'}
                                  autoComplete="tel"
                                  placeholder="Phone"
                                  value={voucherPhone}
                                  onChange={(e) => {
                                    setVoucherPhone(e.target.value)
                                    setVoucherBalanceHint(null)
                                    setVoucherNameHint('')
                                  }}
                                  {...voucherKbHandlers('phone')}
                                />
                                <button
                                  type="button"
                                  className="btn small"
                                  disabled={busy}
                                  onClick={() => void fetchVoucherBalance()}
                                >
                                  Balance
                                </button>
                              </div>
                              {voucherBalanceHint !== null ? (
                                <p className="muted register-voucher-balance">
                                  Available {voucherBalanceHint.toFixed(2)}
                                  {voucherNameHint ? ` · ${voucherNameHint}` : ''}
                                </p>
                              ) : null}
                              <div className="register-voucher-row">
                                <input
                                  ref={voucherAmountInputRef}
                                  className="register-voucher-input"
                                  type="text"
                                  inputMode={voucherScreenKbOpen ? 'none' : 'decimal'}
                                  placeholder="Amount"
                                  value={voucherAmountStr}
                                  onChange={(e) => setVoucherAmountStr(e.target.value)}
                                  {...voucherKbHandlers('amount')}
                                />
                                <button type="button" className="btn small" disabled={busy} onClick={applyVoucherUseMax}>
                                  Use max
                                </button>
                                <button
                                  type="button"
                                  className="btn small primary"
                                  disabled={busy}
                                  onClick={() => void applyVoucherToSale()}
                                >
                                  Apply
                                </button>
                              </div>
                              <ScreenKeyboard
                                visible={voucherScreenKbOpen}
                                onAction={handleVoucherScreenKeyboardAction}
                                className="open-tabs-screen-keyboard register-voucher-screen-kb"
                              />
                            </>
                          ) : null}
                        </div>
                        {pendingSplit.storeCreditApplied > 0 ? (
                          <button
                            type="button"
                            className="btn ghost small register-voucher-remove"
                            onClick={removeVoucherFromSplit}
                          >
                            Remove voucher
                          </button>
                        ) : null}
                        <div className="register-voucher-panel">
                          <div className="register-voucher-toolbar">
                            <button
                              type="button"
                              className="btn ghost small"
                              onClick={openHouseAccountsForCheckout}
                            >
                              Charge on account
                            </button>
                          </div>
                          {houseAccountForCheckout ? (
                            <p className="muted register-voucher-balance" style={{ marginTop: '0.35rem' }}>
                              Selected <strong>{houseAccountForCheckout.accountNumber}</strong>
                              {houseAccountForCheckout.name ? ` · ${houseAccountForCheckout.name}` : ''} · Owed{' '}
                              {houseAccountForCheckout.balance.toFixed(2)}
                              {houseAccountForCheckout.creditLimit != null
                                ? ` · Limit ${houseAccountForCheckout.creditLimit.toFixed(2)}`
                                : ''}
                            </p>
                          ) : (
                            <p className="muted register-voucher-balance" style={{ marginTop: '0.35rem' }}>
                              Tap Charge on account to pick a house account.
                            </p>
                          )}
                          {houseAccountFormOpen ? (
                            <>
                              <div className="register-voucher-title">On account (AR)</div>
                              <div className="register-voucher-row">
                                <input
                                  className="register-voucher-input"
                                  type="text"
                                  inputMode="decimal"
                                  placeholder="Amount"
                                  value={onAccountRemainingDueAmount().toFixed(2)}
                                  readOnly
                                />
                                <input
                                  className="register-voucher-input"
                                  type="text"
                                  placeholder="Purchase order no."
                                  value={onAccountPoNumber}
                                  onChange={(e) => setOnAccountPoNumber(e.target.value)}
                                  inputMode={onAccountPoKbOpen ? 'none' : 'text'}
                                  onFocus={() => setOnAccountPoKbOpen(true)}
                                />
                                <button
                                  type="button"
                                  className="btn small primary"
                                  disabled={busy}
                                  onClick={() => void applyOnAccountToSale()}
                                >
                                  Apply
                                </button>
                              </div>
                              <ScreenKeyboard
                                visible={onAccountPoKbOpen}
                                onAction={handleOnAccountPoKeyboardAction}
                                className="open-tabs-screen-keyboard register-voucher-screen-kb"
                              />
                            </>
                          ) : null}
                        </div>
                        {pendingSplit.onAccountApplied > 0 ? (
                          <button
                            type="button"
                            className="btn ghost small register-voucher-remove"
                            onClick={removeOnAccountFromSplit}
                          >
                            Remove on account
                          </button>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                </div>
                <div className="cart-change-sticky-footer">
                  <div className="cash-footer">
                    <button
                      type="button"
                      className="btn checkout-btn cash-checkout-btn"
                      disabled={busy}
                      onClick={() => void checkoutCash()}
                    >
                      {busy ? 'Processing…' : 'Cash'}
                    </button>
                    <button
                      type="button"
                      className="btn checkout-btn card-checkout-btn"
                      disabled={busy}
                      onClick={() => void checkoutCard()}
                    >
                      {busy ? 'Processing…' : 'Card'}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <>
                <h2>{refundSession ? 'Refund cart' : 'Cart'}</h2>
                <div
                  className={`cart-body${refundSession && refundCartScreenKbOpen ? ' cart-body--refund-kb-open' : ''}`}
                >
                  {cart.length === 0 ? (
                    <p className="muted empty-hint cart-empty-msg">
                      {refundSession ? 'No refundable lines left on this sale.' : 'Tap a product to add.'}
                    </p>
                  ) : (
                    <div className="cart-lines">
<<<<<<< HEAD
                      {cart.map((l, i) => {
=======
                      {cart.map((l) => {
                        const lineProduct = products.find((x) => x._id === l.productId)
                        const jobCardLabourActive = !refundSession && activeTabBanner?.kind === 'job_card'
                        const lineJobLabour = jobCardLabourActive
                          ? jobCardLabourAmountForLine(lineProduct, l.quantity)
                          : 0
>>>>>>> 4307f62 (tuesday fro 86)
                        const disc = lineDiscountDisplay(l)
                        const vol = l.volumeSegments && l.volumeSegments.length > 0
                        const volShowAvg = (l.volumeSegments?.length ?? 0) > 1
                        const refundMax = l.refundQtyMax
                        return (
                        <div
                          className="cart-line"
                          key={l.refundSaleLineIndex != null ? `refund-${l.refundSaleLineIndex}` : `cart-${i}`}
                        >
                          <div className="cart-line-info">
                            <span className="cart-line-name">
                              {l.name}
                              {vol ? <span className="muted cart-line-vol-badge"> · Volume</span> : null}
                            </span>
                            <span className="cart-line-sub">
                              {disc ? (
                                <>
                                  <span className="cart-line-was">{l.listUnitPrice!.toFixed(2)}</span>
                                  <span className="cart-line-price-arrow"> → </span>
                                </>
                              ) : null}
                              <span className="cart-line-unit">
                                {l.unitPrice.toFixed(2)} {vol && volShowAvg ? 'avg' : 'each'}
                              </span>
                              {disc ? (
                                <span className="cart-line-discount-badge">−{disc.pct}%</span>
                              ) : null}
                            </span>
                            {refundMax != null ? (
                              <span className="muted cart-line-volume-breakdown register-refund-line-cap">
                                Refund qty (max {refundMax.toFixed(2)})
                              </span>
                            ) : null}
                            {l.volumeSegments && l.volumeSegments.length > 1 ? (
                              <span className="muted cart-line-volume-breakdown">
                                {l.volumeSegments.map((s, i, arr) => (
                                  <span key={i}>
                                    {s.quantity} × {s.unitPrice.toFixed(2)}
                                    {i < arr.length - 1 ? ' · ' : ''}
                                  </span>
                                ))}
                              </span>
                            ) : null}
                            {lineJobLabour > 0.0001 ? (
                              <span className="muted cart-line-volume-breakdown">
                                Incl. job labour +{lineJobLabour.toFixed(2)}
                              </span>
                            ) : null}
                          </div>
                          <div className="cart-line-actions">
                            <div className="stepper" role="group" aria-label="Quantity">
                              <button
                                type="button"
                                className="stepper-btn"
                                aria-label={`Decrease ${l.name}`}
                                onClick={() => bumpCartLineQty(i, -1)}
                              >
                                −
                              </button>
                              <span className="stepper-value" aria-live="polite">
                                {l.quantity}
                              </span>
                              <button
                                type="button"
                                className="stepper-btn"
                                aria-label={`Increase ${l.name}`}
                                onClick={() => bumpCartLineQty(i, 1)}
                              >
                                +
                              </button>
                            </div>
                            <span className="cart-line-total">
                              {cartLineTotalIncludingJobLabour(l, lineProduct, jobCardLabourActive).toFixed(2)}
                            </span>
                          </div>
                        </div>
                        )
                      })}
                    </div>
                  )}
                </div>
                <div className="cart-footer">
                  {cart.length > 0 && !refundSession ? (
                    <div className="register-alt-payment-wrap">
                      <button
                        type="button"
                        className="btn ghost small register-alt-payment-toggle"
                        aria-expanded={altPaymentExpanded}
                        disabled={altPaymentsOfflineDisabled}
                        onClick={() => setAltPaymentExpanded((v) => !v)}
                      >
                        {altPaymentExpanded ? 'Hide alt payment options' : 'Alt payment options'}
                      </button>
                      {altPaymentsOfflineDisabled ? (
                        <p className="muted small" style={{ marginTop: '0.35rem' }}>
                          Alt payment options unavailable while offline.
                        </p>
                      ) : null}
                      {altPaymentExpanded ? (
                        <>
                          <div className="register-voucher-panel">
                            <div className="register-voucher-toolbar">
                              <button
                                type="button"
                                className="btn ghost small"
                                onClick={() => setVoucherFormOpen((v) => !v)}
                                aria-expanded={voucherFormOpen}
                              >
                                {voucherFormOpen ? 'Hide voucher' : 'Apply voucher'}
                              </button>
                            </div>
                            {voucherFormOpen ? (
                              <>
                                <div className="register-voucher-title">Store voucher</div>
                                <div className="register-voucher-row">
                                  <input
                                    ref={voucherPhoneInputRef}
                                    className="register-voucher-input"
                                    type="tel"
                                    inputMode={voucherScreenKbOpen ? 'none' : 'numeric'}
                                    autoComplete="tel"
                                    placeholder="Phone"
                                    value={voucherPhone}
                                    onChange={(e) => {
                                      setVoucherPhone(e.target.value)
                                      setVoucherBalanceHint(null)
                                      setVoucherNameHint('')
                                    }}
                                    {...voucherKbHandlers('phone')}
                                  />
                                  <button
                                    type="button"
                                    className="btn small"
                                    disabled={busy}
                                    onClick={() => void fetchVoucherBalance()}
                                  >
                                    Balance
                                  </button>
                                </div>
                                {voucherBalanceHint !== null ? (
                                  <p className="muted register-voucher-balance">
                                    Available {voucherBalanceHint.toFixed(2)}
                                    {voucherNameHint ? ` · ${voucherNameHint}` : ''}
                                  </p>
                                ) : null}
                                <div className="register-voucher-row">
                                  <input
                                    ref={voucherAmountInputRef}
                                    className="register-voucher-input"
                                    type="text"
                                    inputMode={voucherScreenKbOpen ? 'none' : 'decimal'}
                                    placeholder="Amount"
                                    value={voucherAmountStr}
                                    onChange={(e) => setVoucherAmountStr(e.target.value)}
                                    {...voucherKbHandlers('amount')}
                                  />
                                  <button type="button" className="btn small" disabled={busy} onClick={applyVoucherUseMax}>
                                    Use max
                                  </button>
                                  <button
                                    type="button"
                                    className="btn small primary"
                                    disabled={busy}
                                    onClick={() => void applyVoucherToSale()}
                                  >
                                    Apply
                                  </button>
                                </div>
                                <ScreenKeyboard
                                  visible={voucherScreenKbOpen}
                                  onAction={handleVoucherScreenKeyboardAction}
                                  className="open-tabs-screen-keyboard register-voucher-screen-kb"
                                />
                              </>
                            ) : null}
                          </div>
                          <div className="register-voucher-panel">
                            <div className="register-voucher-toolbar">
                              <button
                                type="button"
                                className="btn ghost small"
                                onClick={openHouseAccountsForCheckout}
                              >
                                Charge on account
                              </button>
                            </div>
                            {houseAccountForCheckout ? (
                              <p className="muted register-voucher-balance" style={{ marginTop: '0.35rem' }}>
                                Selected <strong>{houseAccountForCheckout.accountNumber}</strong>
                                {houseAccountForCheckout.name ? ` · ${houseAccountForCheckout.name}` : ''} · Owed{' '}
                                {houseAccountForCheckout.balance.toFixed(2)}
                                {houseAccountForCheckout.creditLimit != null
                                  ? ` · Limit ${houseAccountForCheckout.creditLimit.toFixed(2)}`
                                  : ''}
                              </p>
                            ) : (
                              <p className="muted register-voucher-balance" style={{ marginTop: '0.35rem' }}>
                                Tap Charge on account to pick a house account.
                              </p>
                            )}
                            {houseAccountFormOpen ? (
                              <>
                                <div className="register-voucher-title">On account (AR)</div>
                                <div className="register-voucher-row">
                                  <input
                                    className="register-voucher-input"
                                    type="text"
                                    inputMode="decimal"
                                    placeholder="Amount"
                                    value={onAccountRemainingDueAmount().toFixed(2)}
                                    readOnly
                                  />
                                <input
                                  className="register-voucher-input"
                                  type="text"
                                  placeholder="Purchase order no."
                                  value={onAccountPoNumber}
                                  onChange={(e) => setOnAccountPoNumber(e.target.value)}
                                  inputMode={onAccountPoKbOpen ? 'none' : 'text'}
                                  onFocus={() => setOnAccountPoKbOpen(true)}
                                />
                                  <button
                                    type="button"
                                    className="btn small primary"
                                    disabled={busy}
                                    onClick={() => void applyOnAccountToSale()}
                                  >
                                    Apply
                                  </button>
                                </div>
                                <ScreenKeyboard
                                  visible={onAccountPoKbOpen}
                                  onAction={handleOnAccountPoKeyboardAction}
                                  className="open-tabs-screen-keyboard register-voucher-screen-kb"
                                />
                              </>
                            ) : null}
                          </div>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                  {refundSession && cart.length > 0 ? (
                    <>
                      <label className="register-refund-note-field">
                        <span className="muted small">Refund note (optional, audit)</span>
                        <textarea
                          ref={refundNoteInputRef}
                          className="register-refund-note-input"
                          rows={2}
                          value={refundNote}
                          onChange={(e) => setRefundNote(e.target.value)}
                          placeholder="Reason or reference"
                          inputMode={refundCartScreenKbOpen && refundCartKbTarget === 'note' ? 'none' : 'text'}
                          {...refundCartKbHandlers('note')}
                        />
                      </label>
                      <label className="register-refund-note-field">
                        <span className="muted small">Phone for refund voucher (required for Refund voucher)</span>
                        <input
                          ref={refundPhoneInputRef}
                          className="register-refund-note-input"
                          type="tel"
                          inputMode={refundCartScreenKbOpen && refundCartKbTarget === 'phone' ? 'none' : 'numeric'}
                          autoComplete="tel"
                          value={refundCreditPhone}
                          onChange={(e) => setRefundCreditPhone(e.target.value)}
                          placeholder="Digits only — credit loads onto this account"
                          {...refundCartKbHandlers('phone')}
                        />
                      </label>
                      <p className="muted small register-refund-credit-hint">
                        Refund voucher: credits the cash/card portion of this refund as store credit. Any voucher used on
                        the original sale is still restored automatically.
                      </p>
                    </>
                  ) : null}
                  <div className="total">
                    {refundSession ? 'Refund total' : 'Total'}{' '}
                    <strong className="total-amount">{cartTotal.toFixed(2)}</strong>
                  </div>
                  <div className={`cash-footer${refundSession ? ' refund-cart-checkout-footer' : ''}`}>
                    <button
                      type="button"
                      className="btn checkout-btn cash-checkout-btn"
                      disabled={
                        busy ||
                        cart.length === 0 ||
                        (refundSession != null &&
                          (refundSession.previewSale.refundStatus === 'refunded' ||
                            refundSession.refundPreview.remainingTotal <= 0.005))
                      }
                      onClick={() => void checkoutCash()}
                    >
                      {busy ? 'Processing…' : refundSession ? 'Refund cash' : 'Cash'}
                    </button>
                    <button
                      type="button"
                      className="btn checkout-btn card-checkout-btn"
                      disabled={
                        busy ||
                        cart.length === 0 ||
                        (refundSession != null &&
                          (refundSession.previewSale.refundStatus === 'refunded' ||
                            refundSession.refundPreview.remainingTotal <= 0.005))
                      }
                      onClick={() => void checkoutCard()}
                    >
                      {busy ? 'Processing…' : refundSession ? 'Refund card' : 'Card'}
                    </button>
                    {refundSession ? (
                      <button
                        type="button"
                        className="btn checkout-btn storecredit-checkout-btn"
                        disabled={
                          busy ||
                          cart.length === 0 ||
                          refundSession.previewSale.refundStatus === 'refunded' ||
                          refundSession.refundPreview.remainingTotal <= 0.005
                        }
                        onClick={() => void checkoutRefundStoreCredit()}
                      >
                        {busy ? 'Processing…' : 'Refund voucher'}
                      </button>
                    ) : null}
                  </div>
                  {refundSession && cart.length > 0 ? (
                    <ScreenKeyboard
                      visible={refundCartScreenKbOpen}
                      layout={refundCartKbTarget === 'phone' ? 'numeric' : 'full'}
                      onAction={handleRefundCartScreenKeyboardAction}
                      className="open-tabs-screen-keyboard register-refund-cart-screen-kb"
                    />
                  ) : null}
                </div>
                {(error || notice || lastSale || offlinePendingCount > 0) && (
                  <div className="cart-messages">
                    {error && <p className="error">{error}</p>}
                    {notice && <p className="success">{notice}</p>}
                    {offlinePendingCount > 0 && (
                      <p className="success" role="status">
                        Offline sync queue: {offlinePendingCount} pending sale{offlinePendingCount === 1 ? '' : 's'}
                      </p>
                    )}
                    {(offlineSyncStatus.lastSuccessAt || offlineSyncStatus.lastError) && (
                      <p className={offlineSyncStatus.lastError ? 'error' : 'muted'} role="status">
                        Offline sync:{' '}
                        {offlineSyncStatus.lastSuccessAt
                          ? `last success ${new Date(offlineSyncStatus.lastSuccessAt).toLocaleString()}`
                          : 'no successful sync yet'}
                        {offlineSyncStatus.lastError ? ` · last error: ${offlineSyncStatus.lastError}` : ''}
                      </p>
                    )}
                    {catalogSnapshotSyncedAt && (
                      <p className={catalogSnapshotStale ? 'error' : 'muted'} role="status">
                        Catalog snapshot:{' '}
                        {catalogSnapshotStale ? 'stale' : 'fresh'} · last sync{' '}
                        {new Date(catalogSnapshotSyncedAt).toLocaleString()}
                      </p>
                    )}
                    {lastSale && (
                      <p className="success" role="status">
                        Sale recorded · total {lastSale.total.toFixed(2)} · thank you
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
          </section>
        </div>
        </div>
        {stockOverridePrompt.open ? (
          <div
            className="open-tabs-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="stock-override-title"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) settleStockOverrideConfirmation(false)
            }}
          >
            <div className="open-tabs-dialog quotes-modal-dialog" style={{ maxWidth: 'min(96vw, 28rem)' }}>
              <div className="open-tabs-header">
                <h2 id="stock-override-title">
                  {stockOverridePrompt.scope === 'offline' ? 'Offline' : 'Online'} stock override
                </h2>
                <button
                  type="button"
                  className="btn ghost open-tabs-close"
                  onClick={() => settleStockOverrideConfirmation(false)}
                >
                  Close
                </button>
              </div>
              <div className="quotes-modal-body">
                <p>
                  <strong>{stockOverridePrompt.productName}</strong> has insufficient stock.
                </p>
                <p className="muted" style={{ marginBottom: '0.5rem' }}>
                  Available: {stockOverridePrompt.available}
                </p>
                <p className="muted">
                  Manager can exceed stock by up to <strong>{stockOverridePrompt.maxUnits}</strong> units.
                </p>
              </div>
              <div className="open-tabs-header" style={{ justifyContent: 'flex-end', gap: '0.5rem' }}>
                <button type="button" className="btn ghost" onClick={() => settleStockOverrideConfirmation(false)}>
                  Cancel
                </button>
                <button type="button" className="btn primary" onClick={() => settleStockOverrideConfirmation(true)}>
                  Approve override
                </button>
              </div>
            </div>
          </div>
        ) : null}
        <AssignPresetModal
          open={assignPresetProduct != null}
          product={assignPresetProduct}
          presetsState={presetsState}
          catalogCategories={catalogCategoriesForPresetSuggest}
          catalogProducts={products}
          onClose={() => setAssignPresetProduct(null)}
          onAssign={(replaceAtIndex, category, subCategory) => {
            const prod = assignPresetProduct
            if (!prod) return
            setPresetsState((prev) => {
              const next = assignPresetEntry(prev, prod, category, subCategory, replaceAtIndex)
              persistPresets(next, prev)
              return next
            })
            setAssignPresetProduct(null)
            setNotice('Preset saved — open Presets to browse category → sub-category → item.')
          }}
        />
        <ConfirmPresetDeleteModal
          open={presetDeleteIndex !== null}
          pathLabel={
            presetDeleteIndex != null && presetsState.entries[presetDeleteIndex]
              ? presetEntryPathLabel(
                  presetsState.entries[presetDeleteIndex],
                  products.find((x) => x._id === presetsState.entries[presetDeleteIndex].productId)?.name,
                )
              : ''
          }
          onClose={() => setPresetDeleteIndex(null)}
          onConfirm={() => {
            if (presetDeleteIndex === null) return
            removePresetEntryAt(presetDeleteIndex)
          }}
        />
        <OpenTabsModal
          open={openTabsModalOpen}
          onClose={() => setOpenTabsModalOpen(false)}
          tabs={openTabsList}
          loading={openTabsLoading}
          onRefresh={loadOpenTabsList}
          activeOpenTabId={activeOpenTabId}
          canIncludeWalkInCart={!activeOpenTabId}
          walkInLineCount={cart.length}
          onSelectTab={(id) => void selectOpenTab(id)}
          onVoidTab={(id) => void voidOpenTabById(id)}
          onCreateTab={(input) => createOpenTabFromModal(input)}
        />
        <QuotesModal
          open={quotesModalOpen}
          onClose={() => setQuotesModalOpen(false)}
          quotes={quotesList}
          loading={quotesLoading}
          onRefresh={loadQuotesList}
          onLoadQuote={(id) => void handleLoadQuote(id)}
          onSaveQuote={(input) => handleSaveQuote(input)}
          onPrintQuote={(id) => printQuoteById(id)}
          saveDisabled={cart.length === 0 || !!activeOpenTabId || !!refundSession}
          loadDisabled={!!activeOpenTabId || !!refundSession}
        />
        <LayByModal
          open={layByModalOpen}
          onClose={() => setLayByModalOpen(false)}
          cart={cart}
          cartTotal={cartTotal}
          isAdmin={isAdmin}
          receiptEnabled={receiptEnabled}
          tillCode={POS_TILL_CODE}
          onCreated={() => {
            clearActiveQuote()
            setCart([])
            void loadProducts()
          }}
        />
        <HouseAccountsModal
          open={houseAccountsModalOpen}
          onClose={() => setHouseAccountsModalOpen(false)}
          actionLabel={houseAccountsModalMode === 'payment' ? 'Take a payment' : 'Use for checkout'}
          helperText={
            houseAccountsModalMode === 'payment'
              ? 'Select an account and record a customer payment against the amount owed.'
              : 'Select an account to charge the current sale (on account). Create or edit accounts in Back Office.'
          }
          onSelectAccount={(row) => {
            if (houseAccountsModalMode === 'payment') {
              setHouseAccountPaymentTarget(row)
              setHouseAccountPaymentAmountStr('')
              setHouseAccountPaymentMethod('cash')
              setHouseAccountPaymentKbOpen(true)
              return
            }
            setHouseAccountForCheckout(row)
            setHouseAccountFormOpen(true)
            setOnAccountPoNumber('')
            setOnAccountPoKbOpen(false)
          }}
        />
        {offlineReconcileModalOpen ? (
          <div
            className="open-tabs-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="offline-reconcile-title"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setOfflineReconcileModalOpen(false)
            }}
          >
            <div className="open-tabs-dialog quotes-modal-dialog" style={{ maxWidth: 'min(96vw, 34rem)' }}>
              <div className="open-tabs-header">
                <h2 id="offline-reconcile-title">Back Online - Stock Reconciliation</h2>
                <button type="button" className="btn ghost open-tabs-close" onClick={() => setOfflineReconcileModalOpen(false)}>
                  Close
                </button>
              </div>
              <div className="quotes-modal-body">
                <p className="muted" style={{ marginBottom: '0.75rem' }}>
                  Offline sales synced. Please verify physical stock counts for these items.
                </p>
                <p className="muted" style={{ marginBottom: '0.5rem' }}>
                  Synced at {new Date(offlineReconcileSyncedAt ?? new Date().toISOString()).toLocaleString()} ·{' '}
                  {offlineReconcileItems.length} item{offlineReconcileItems.length === 1 ? '' : 's'} ·{' '}
                  {offlineReconcileItems.reduce((sum, item) => sum + item.qty, 0)} units
                </p>
                <ul
                  className="open-tabs-list"
                  style={{ maxHeight: '48vh', overflowY: 'auto', overflowX: 'hidden', paddingRight: '0.25rem' }}
                >
                  {offlineReconcileItems.map((item) => (
                    <li
                      key={item.productId}
                      className="open-tabs-row"
                      style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem' }}
                    >
                      <span>{item.name}</span>
                      <strong>{item.qty}</strong>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="open-tabs-header" style={{ justifyContent: 'flex-end', gap: '0.5rem' }}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    void (async () => {
                      const printed = await printOfflineReconciliationListToDevice()
                      if (!printed.ok) {
                        setError(printed.error ?? 'Failed to print reconciliation list')
                        return
                      }
                      setNotice('Offline reconciliation list printed')
                    })()
                  }}
                >
                  Print reconciliation list
                </button>
                <button type="button" className="btn ghost" onClick={() => setOfflineReconcileModalOpen(false)}>
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {houseAccountPaymentTarget ? (
          <div
            className="open-tabs-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="house-acct-payment-title"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget && !busy) {
                setHouseAccountPaymentTarget(null)
                setHouseAccountPaymentKbOpen(false)
              }
            }}
          >
            <div className="open-tabs-dialog quotes-modal-dialog">
              <div className="open-tabs-header">
                <h2 id="house-acct-payment-title">Take account payment</h2>
                <button
                  type="button"
                  className="btn ghost open-tabs-close"
                  disabled={busy}
                  onClick={() => {
                    setHouseAccountPaymentTarget(null)
                    setHouseAccountPaymentKbOpen(false)
                  }}
                >
                  Close
                </button>
              </div>
              <div className="quotes-modal-body">
                <p className="muted" style={{ marginBottom: '0.35rem' }}>
                  <strong>{houseAccountPaymentTarget.accountNumber}</strong>
                  {houseAccountPaymentTarget.name ? ` · ${houseAccountPaymentTarget.name}` : ''}
                </p>
                <p className="muted" style={{ marginBottom: '0.75rem' }}>
                  Owed {houseAccountPaymentTarget.balance.toFixed(2)}
                  {houseAccountPaymentTarget.creditLimit != null
                    ? ` · Limit ${houseAccountPaymentTarget.creditLimit.toFixed(2)}`
                    : ''}
                </p>
                <div className="register-voucher-row">
                  <input
                    className="register-voucher-input"
                    type="text"
                    inputMode={houseAccountPaymentKbOpen ? 'none' : 'decimal'}
                    placeholder="Payment amount"
                    value={houseAccountPaymentAmountStr}
                    onChange={(e) => setHouseAccountPaymentAmountStr(e.target.value)}
                    onFocus={() => setHouseAccountPaymentKbOpen(true)}
                  />
                  <button
                    type="button"
                    className={`btn small ${houseAccountPaymentMethod === 'cash' ? 'primary' : ''}`}
                    disabled={busy}
                    onClick={() => setHouseAccountPaymentMethod('cash')}
                  >
                    Cash
                  </button>
                  <button
                    type="button"
                    className={`btn small ${houseAccountPaymentMethod === 'card' ? 'primary' : ''}`}
                    disabled={busy}
                    onClick={() => setHouseAccountPaymentMethod('card')}
                  >
                    Card
                  </button>
                  <button
                    type="button"
                    className="btn small primary"
                    disabled={busy}
                    onClick={() => void submitHouseAccountPayment()}
                  >
                    {busy ? 'Saving…' : 'Record payment'}
                  </button>
                </div>
                <ScreenKeyboard
                  visible={houseAccountPaymentKbOpen}
                  onAction={handleHouseAccountPaymentKeyboardAction}
                  layout="decimal"
                  className="open-tabs-screen-keyboard register-voucher-screen-kb"
                />
              </div>
            </div>
          </div>
        ) : null}
        {canRefund ? (
          <RefundSaleIdModal
            open={refundSaleIdModalOpen}
            onClose={() => setRefundSaleIdModalOpen(false)}
            onSaleLoaded={(data, enteredId) => {
              beginRefundMode(data, enteredId)
            }}
          />
        ) : null}
        {canShiftEnd ? (
          <ShiftEndModal
            open={shiftEndModalOpen}
            tillCode={POS_TILL_CODE}
            onClose={() => setShiftEndModalOpen(false)}
            onPrintReport={async (report) => {
              await printShiftReportToDevice(report)
            }}
          />
        ) : null}
      </PosShell>
    </div>
  )
}
