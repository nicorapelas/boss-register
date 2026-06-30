import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useLocation } from 'react-router-dom'
import { apiFetch, fetchProductPhotoObjectUrl, subscribeServerReachability } from '../api/client'
import { loadProductPresetsWithMigration, pushProductPresets } from '../api/productPresetsApi'
import { claimShopAssistCart } from '../api/shopAssistCartApi'
import type {
  CartLine,
  CreateOpenTabModalInput,
  HouseAccountRow,
  HouseAccountStatement,
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
  ManualReturnResult,
  SaleExchangePreview,
  SaleExchangeSettlement,
  SaleExchangeSettlementKind,
  ShiftReport,
  StoreSettings,
} from '../api/types'
import { useCatalog } from '../catalog/CatalogContext'
import { useAuth } from '../auth/AuthContext'
import type { CashierSignInMethod } from '../auth/signInMethod'
import { cashierSignInMethodLabel } from '../auth/signInMethod'
import { StockOverrideModal, type StockOverrideModalRequest } from '../components/StockOverrideModal'
import type { StockOverrideApprover } from '../register/managerStockOverrideVerify'
import { stockOverrideLineFields, stockOverridePayloadFromLine } from '../register/stockOverrideLineFields'
import {
  cardAmountToApply,
  cartCheckoutDisplay,
  cashRoundingFromSettings,
  checkoutAmountDue,
  computeCheckoutTenders,
  DEFAULT_CASH_ROUNDING,
  effectiveCashRoundingAdjustment,
  exactMerchandiseDue,
  maxCardTender,
  type CashRoundingConfig,
  type CheckoutTenderInput,
} from '../register/cashRounding'
import {
  canManageShifts,
  canCancelLayBys,
  canOverridePriceOnPos,
  canRefundSales,
  canManualReturn,
  canExchangeSales,
  canBrowseSalesForAdjustment,
  isPosManager,
  isRoleAdmin,
} from '../auth/permissions'
import {
  AssignPresetModal,
  ConfirmMessageModal,
  ConfirmPresetDeleteModal,
  HouseAccountsModal,
  LayByModal,
  LoyaltyModal,
  OpenTabsModal,
  QuotesModal,
  RefundSaleIdModal,
  ExchangeSaleIdModal,
  ShiftEndModal,
  ManualReturnPayoutModal,
  ScreenKeyboard,
  type ScreenKeyboardAction,
} from '../components'
import { ProductListRow } from '../components/ProductListRow'
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
import { patchProductsStock, type CartStockLine } from '../register/catalogStockPatch'
import {
  canSwitchSaleHold,
  clearActiveSaleHoldSlot,
  heldSaleCartTotal,
  loadSaleHoldSlots,
  parkedSlotLines,
  swapSaleHoldSlots,
  type SaleHoldSlots,
} from '../register/heldSales'
import { setPosSaleInactivityGuard } from '../register/posSaleInactivityGuard'
import { buildProductLookup, findProductInLookup, type ProductLookup } from '../register/productLookup'
import { jobCardCustomerDisplay } from '../utils/openTabDisplay'
import { playPosKeySound } from '../audio/posKeySound'
import { PosShell } from '../layouts/PosShell'
import { usePosTheme } from '../theme/PosThemeContext'
import {
  kickCashDrawerIfConfigured,
  readPosPrinterSettings,
  readRegisterReceiptEnabled,
  writeRegisterReceiptEnabled,
  receiptPrintOpts,
  type PosPrinterSettings,
  type ReceiptPrintOpts,
} from '../printer/posPrinterSettings'
import {
  createClientLocalId,
  enqueueOfflineSale,
  flushOfflineSalesWithTillCode,
  getOfflineSalesSyncStatus,
  getOfflinePendingSalesCount,
  isLikelyNetworkError,
} from '../offline/offlineSalesQueue'
import type { OfflineSyncedItemSummary } from '../offline/offlineSalesQueue'
import { saveCatalogCache } from '../offline/catalogCache'
import {
  productAvailableUnits,
  productHasSellableStock,
  productTracksInventory,
} from '../utils/productInventory'
import { formatDateDdMmYyyy } from '../utils/dateFormat'
import { applyPosThemeToCustomerDisplayConfig } from '../customerDisplay/posThemeColors'
import { buildCustomerDisplaySnapshot, storeConfigFromSettings } from '../customerDisplay/buildSnapshot'
import { readCachedStoreName } from '../customerDisplay/configCache'
import {
  getInitialCustomerDisplayConfig,
  useCustomerDisplaySettingsLoader,
  useCustomerDisplaySync,
} from '../customerDisplay/useCustomerDisplaySync'
import { scheduleCustomerDisplayLoyaltyFocus } from '../customerDisplay/publish'
import { publishProductSpotlight, clearCustomerDisplaySpotlightSeen } from '../customerDisplay/spotlight'
import { DEFAULT_STORE_NAME } from '../brand'
import { paymentTermsShortLabel } from '../houseAccounts/paymentTerms'
import type { CustomerDisplayStoreConfig } from '../customerDisplay/types'
import { useRegisterLoyalty } from '../hooks/useRegisterLoyalty'
import { hasVolumeTiering, lineTotalsForProduct, type ProductForVolume } from '../utils/volumePrice'

const LAST_RECEIPT_STORAGE_KEY = 'electropos-pos-last-receipt-sale'
const POS_TILL_CODE = (import.meta.env.VITE_POS_TILL_CODE?.trim().toUpperCase() || 'T1').slice(0, 24)
const OFFLINE_OVERSALE_MAX_UNITS = 3
const ONLINE_OVERSALE_MAX_UNITS = 3
const SHOPASSIST_CART_QR_PREFIX = 'shopassist-cart:'
const SCANNER_BUFFER_RESET_MS = 250

/** Item list: avoid rendering thousands of DOM rows on touch tills. */
const ITEM_LIST_SEARCH_MIN = 2
const ITEM_LIST_MAX_ROWS = 100

/** Debounce writing 8k+ products to offline cache (was blocking checkout on Posiflex). */
const CATALOG_CACHE_SAVE_DEBOUNCE_MS = 2500

type ReceiptPrintPayload = {
  transport: unknown
  receipt: unknown
} & ReceiptPrintOpts

type LastReceiptForReprint =
  | { kind: 'sale'; sale: Sale }
  | { kind: 'raw'; payload: ReceiptPrintPayload; payloads?: ReceiptPrintPayload[]; successNotice?: string }

type StockOverrideApproval =
  | { approved: true; approver: StockOverrideApprover }
  | { approved: false }

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

type ExchangeSession = {
  routeSaleId: string
  previewSale: Sale
  returnPreview: SaleExchangePreview['return']
  eligibility: SaleExchangePreview['eligibility']
}

function cartLinesFromReturnPreview(
  sale: Sale,
  progress: SaleRefundPreview['refund'] | SaleExchangePreview['return'],
): CartLine[] {
  const lines: CartLine[] = []
  for (const prog of progress.lines) {
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

function cartLinesFromRefundPreview(sale: Sale, refund: SaleRefundPreview['refund']): CartLine[] {
  return cartLinesFromReturnPreview(sale, refund)
}

function cartReturnLines(cart: CartLine[]): CartLine[] {
  return cart.filter((l) => l.refundSaleLineIndex != null && l.quantity > 0.005)
}

function cartNewSaleLines(cart: CartLine[]): CartLine[] {
  return cart.filter((l) => l.refundSaleLineIndex == null)
}

function exchangeReturnTotalFromCart(cart: CartLine[]): number {
  return roundCartMoney(cartReturnLines(cart).reduce((s, l) => s + cartLineSubtotal(l), 0))
}

function exchangeNewTotalFromCart(cart: CartLine[]): number {
  return roundCartMoney(cartNewSaleLines(cart).reduce((s, l) => s + cartLineSubtotal(l), 0))
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
      ...(l.addedByUserId ? { addedByUserId: l.addedByUserId } : {}),
      ...(l.addedByDisplayName ? { addedByDisplayName: l.addedByDisplayName } : {}),
      ...(l.addedAt ? { addedAt: l.addedAt } : {}),
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

function appendCashierSignInToSaleBody(
  body: Record<string, unknown>,
  signInMethod: CashierSignInMethod | undefined,
) {
  if (signInMethod) body.cashierSignInMethod = signInMethod
}

function cartContributorKey(l: Pick<CartLine, 'addedByUserId' | 'addedByDisplayName'>): string {
  return `${(l.addedByUserId ?? '').trim()}\t${(l.addedByDisplayName ?? '').trim()}`
}

function cartLineDomKey(line: CartLine): string {
  if (line.refundSaleLineIndex != null) return `refund-${line.refundSaleLineIndex}`
  return `sale-${line.productId}-${cartContributorKey(line)}`
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
    ...stockOverridePayloadFromLine(l),
  }
}

function saleRequestLineBody(l: CartLine) {
  return {
    productId: l.productId,
    name: l.name,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    ...stockOverridePayloadFromLine(l),
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
  const location = useLocation()
  const settingsObscured = location.pathname === '/settings'
  const {
    products,
    setProducts,
    productsRef,
    catalogSnapshotSyncedAt,
    catalogSnapshotStale,
    offlineCatalogMode,
    catalogReady,
    catalogRefreshing,
    catalogError,
    loadProducts,
  } = useCatalog()
  const isAdmin = isPosManager(session?.user)
  const canCancelLayBy = canCancelLayBys(session?.user)
  const isStoreAdmin = isRoleAdmin(session?.user)
  const canRefund = canRefundSales(session?.user)
  const canManualReturnPos = canManualReturn(session?.user)
  const canExchange = canExchangeSales(session?.user)
  const canBrowseSalesForAdjust = canBrowseSalesForAdjustment(session?.user)
  const canShiftEnd = canManageShifts(session?.user)
  const { theme: posTheme } = usePosTheme()
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
  const [customerDisplayConfig, setCustomerDisplayConfig] = useState<CustomerDisplayStoreConfig>(
    getInitialCustomerDisplayConfig,
  )
  const [storeDisplayName, setStoreDisplayName] = useState(() => readCachedStoreName())
  const spotlightAfterCartRef = useRef<Product | null>(null)
  const [saleHoldSlots, setSaleHoldSlots] = useState<SaleHoldSlots>(() => loadSaleHoldSlots())
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
  const [receiptEnabled, setReceiptEnabled] = useState(() => readRegisterReceiptEnabled())
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
  const [lastLoyaltyDiscount, setLastLoyaltyDiscount] = useState<number | null>(null)
  const [lastLoyaltyPoints, setLastLoyaltyPoints] = useState<number | null>(null)
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
  const productLookupRef = useRef<ProductLookup>(buildProductLookup([]))
  const cartRef = useRef<CartLine[]>([])
  const productsByIdRef = useRef<Map<string, Product>>(new Map())
  const scannerRawInputRef = useRef('')
  const scannerRawInputTimerRef = useRef<number | null>(null)
  const catalogCacheSaveTimerRef = useRef<number | null>(null)
  const cartLinesScrollRef = useRef<HTMLDivElement | null>(null)
  const pendingCartScrollKeyRef = useRef<string | null>(null)
  skuInputRef.current = skuInput
  cartRef.current = cart

  const scheduleCatalogCacheSave = useCallback((snapshot: Product[]) => {
    if (catalogCacheSaveTimerRef.current) clearTimeout(catalogCacheSaveTimerRef.current)
    catalogCacheSaveTimerRef.current = window.setTimeout(() => {
      catalogCacheSaveTimerRef.current = null
      void saveCatalogCache(snapshot).catch(() => undefined)
    }, CATALOG_CACHE_SAVE_DEBOUNCE_MS)
  }, [])

  const applyCatalogStockFromCart = useCallback(
    (lines: CartStockLine[], direction: 'sale' | 'refund') => {
      const patched = patchProductsStock(productsRef.current, lines, direction)
      if (patched === productsRef.current) return
      setProducts(patched)
      scheduleCatalogCacheSave(patched)
    },
    [scheduleCatalogCacheSave],
  )

  useEffect(() => {
    productLookupRef.current = buildProductLookup(products)
  }, [products])

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
  const [exchangeSaleIdModalOpen, setExchangeSaleIdModalOpen] = useState(false)
  const [refundSession, setRefundSession] = useState<RefundSession | null>(null)
  const [exchangeSession, setExchangeSession] = useState<ExchangeSession | null>(null)
  const [exchangeExitConfirmOpen, setExchangeExitConfirmOpen] = useState(false)
  const [refundNote, setRefundNote] = useState('')
  const [exchangeNote, setExchangeNote] = useState('')
  const [refundCreditPhone, setRefundCreditPhone] = useState('')
  const [exchangeCreditPhone, setExchangeCreditPhone] = useState('')
  const [exchangeAdminBypass, setExchangeAdminBypass] = useState(false)
  const refundCartKbBlurTimerRef = useRef<number | null>(null)
  const refundCartKbTargetRef = useRef<'note' | 'phone'>('note')
  const refundNoteInputRef = useRef<HTMLTextAreaElement | null>(null)
  const refundPhoneInputRef = useRef<HTMLInputElement | null>(null)
  const [refundCartScreenKbOpen, setRefundCartScreenKbOpen] = useState(false)
  const [refundCartKbTarget, setRefundCartKbTarget] = useState<'note' | 'phone'>('note')
  const [refundPayoutOpen, setRefundPayoutOpen] = useState(false)
  const [exchangePayoutOpen, setExchangePayoutOpen] = useState(false)
  const [manualReturnActive, setManualReturnActive] = useState(false)
  const [manualReturnPayoutOpen, setManualReturnPayoutOpen] = useState(false)
  const [manualReturnNote, setManualReturnNote] = useState('')
  const [manualReturnCreditPhone, setManualReturnCreditPhone] = useState('')
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
  const [loyaltyModalOpen, setLoyaltyModalOpen] = useState(false)
  const [lastOnAccount, setLastOnAccount] = useState<number | null>(null)
  const [cashRoundingConfig, setCashRoundingConfig] = useState<CashRoundingConfig>(DEFAULT_CASH_ROUNDING)
  const [offlinePendingCount, setOfflinePendingCount] = useState(0)
  const [serverReachable, setServerReachable] = useState(true)
  const [productPhotoViewer, setProductPhotoViewer] = useState<Product | null>(null)
  const [productPhotoUrl, setProductPhotoUrl] = useState<string | null>(null)
  const [productPhotoLoading, setProductPhotoLoading] = useState(false)
  const [productPhotoError, setProductPhotoError] = useState<string | null>(null)
  const [offlineSyncStatus, setOfflineSyncStatus] = useState<{
    lastAttemptAt?: string
    lastSuccessAt?: string
    lastError?: string
  }>({})
  const [offlineReconcileModalOpen, setOfflineReconcileModalOpen] = useState(false)
  const [offlineReconcileItems, setOfflineReconcileItems] = useState<OfflineSyncedItemSummary[]>([])
  const [offlineReconcileSyncedAt, setOfflineReconcileSyncedAt] = useState<string | null>(null)
  const [stockOverrideRequest, setStockOverrideRequest] = useState<StockOverrideModalRequest | null>(null)
  const stockOverrideResolveRef = useRef<((result: StockOverrideApproval) => void) | null>(null)
  const altPaymentsOfflineDisabled = offlineCatalogMode

  useEffect(() => subscribeServerReachability(setServerReachable), [])

  useEffect(() => {
    if (!productPhotoViewer || (productPhotoViewer.photoRevision ?? 0) < 1) {
      setProductPhotoUrl((u) => {
        if (u) URL.revokeObjectURL(u)
        return null
      })
      setProductPhotoLoading(false)
      setProductPhotoError(null)
      return
    }
    let cancelled = false
    setProductPhotoLoading(true)
    setProductPhotoError(null)
    void fetchProductPhotoObjectUrl(productPhotoViewer._id, productPhotoViewer.photoRevision ?? 1)
      .then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url)
          return
        }
        setProductPhotoUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev)
          return url
        })
        setProductPhotoLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setProductPhotoError(err instanceof Error ? err.message : 'Could not load photo')
        setProductPhotoLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [productPhotoViewer])

  useEffect(() => {
    return () => {
      if (stockOverrideResolveRef.current) {
        stockOverrideResolveRef.current({ approved: false })
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
    setPosSaleInactivityGuard({
      cartLineCount: cart.length,
      hasPendingSplit: !!pendingSplit,
      parkedSaleLineCount: parkedSlotLines(saleHoldSlots).length,
      layByModalOpen,
    })
    return () =>
      setPosSaleInactivityGuard({
        cartLineCount: 0,
        hasPendingSplit: false,
        parkedSaleLineCount: 0,
        layByModalOpen: false,
      })
  }, [cart.length, pendingSplit, saleHoldSlots, layByModalOpen])

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
        void loadProducts({ hydrateFromCache: false, force: true })
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
    setLastLoyaltyDiscount(null)
    setLastLoyaltyPoints(null)
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
    loyalty.clearLoyalty()
  }

  function switchSaleBlockedReason(): string | null {
    if (refundSession) return 'Exit refund mode before switching sales'
    if (exchangeSession) return 'Exit exchange mode before switching sales'
    if (activeOpenTabId) return 'Close the open tab before switching walk-in sales'
    if (activeQuoteId) return 'Close the quote before switching sales'
    if (pendingSplit) return 'Finish or cancel payment before switching sales'
    if (!canSwitchSaleHold(saleHoldSlots, cart.length)) return 'Nothing to switch'
    return null
  }

  function clearRegisterPaymentState() {
    setPendingSplit(null)
    setLastSale(null)
    setShowChangeView(false)
    setLastChangeDue(null)
    setLastTendered(null)
    setLastCardAmount(null)
    setLastStoreCredit(null)
    setLastOnAccount(null)
    setLastTotal(null)
    setLastLoyaltyDiscount(null)
    setLastLoyaltyPoints(null)
    resetVoucherForm()
    setSkuInput('')
  }

  function toggleHoldSale() {
    const blocked = switchSaleBlockedReason()
    if (blocked) {
      setError(blocked)
      return
    }
    const parkedLines = parkedSlotLines(saleHoldSlots)
    const { next, loadedCart } = swapSaleHoldSlots(saleHoldSlots, cart)
    setSaleHoldSlots(next)
    clearRegisterPaymentState()
    setCart(
      loadedCart.map((l) => {
        const p = products.find((x) => x._id === l.productId)
        return enrichCartLine(p, l)
      }),
    )
    setError(null)
    if (loadedCart.length > 0) {
      setNotice(
        parkedLines.length > 0
          ? `Switched sale (${loadedCart.length} line${loadedCart.length === 1 ? '' : 's'})`
          : `Recalled held sale (${loadedCart.length} line${loadedCart.length === 1 ? '' : 's'})`,
      )
    } else {
      setNotice('Sale on hold — register cleared for next customer')
    }
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
      onPointerDown: (e: React.PointerEvent) => {
        e.preventDefault()
        openRefundCartKeyboard(which)
      },
      onTouchStart: (e: React.TouchEvent) => {
        e.preventDefault()
        openRefundCartKeyboard(which)
      },
      onClick: () => openRefundCartKeyboard(which),
      // Keep refund keyboard sticky on kiosk touch sessions.
      // Blur can fire spuriously while tapping between fields and was
      // immediately closing the keyboard on some Posiflex runs.
      onBlur: () => {},
    }
  }

  function handleRefundCartScreenKeyboardAction(action: ScreenKeyboardAction) {
    const f = refundCartKbTargetRef.current
    const setNote = exchangePayoutOpen ? setExchangeNote : setRefundNote
    const setPhone = exchangePayoutOpen ? setExchangeCreditPhone : setRefundCreditPhone
    if (action.type === 'done') {
      setRefundCartScreenKbOpen(false)
      return
    }
    if (action.type === 'enter') {
      if (f === 'phone') setRefundCartScreenKbOpen(false)
      return
    }
    if (f === 'note') {
      if (action.type === 'char') setNote((s) => s + action.char)
      else if (action.type === 'backspace') setNote((s) => s.slice(0, -1))
      else if (action.type === 'space') setNote((s) => s + ' ')
      return
    }
    if (f === 'phone') {
      if (action.type === 'char' && /\d/.test(action.char)) {
        setPhone((s) => s + action.char)
      } else if (action.type === 'backspace') {
        setPhone((s) => s.slice(0, -1))
      }
    }
  }

  const applyOfflineStockDeduction = useCallback(
    (lines: CartStockLine[]) => {
      applyCatalogStockFromCart(lines, 'sale')
    },
    [applyCatalogStockFromCart],
  )

  useLayoutEffect(() => {
    const key = pendingCartScrollKeyRef.current
    if (!key || showChangeView) return
    pendingCartScrollKeyRef.current = null
    const root = cartLinesScrollRef.current
    if (!root) return
    const el = root.querySelector<HTMLElement>(`[data-cart-line-key="${key}"]`)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [cart, showChangeView])

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
    if (!refundCartScreenKbOpen) return
    if (refundSession && !refundPayoutOpen) return
    if (exchangeSession && !exchangePayoutOpen) return
    if (!refundSession && !exchangeSession) return
    const t = window.setTimeout(() => scrollRefundCartFieldIntoView(refundCartKbTargetRef.current), 40)
    return () => clearTimeout(t)
  }, [refundSession, exchangeSession, refundPayoutOpen, exchangePayoutOpen, refundCartScreenKbOpen, refundCartKbTarget])

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

  const deferredItemListFilter = useDeferredValue(filter)

  const itemListDisplay = useMemo(() => {
    const catalogSize = products.length
    const q = deferredItemListFilter.trim().toLowerCase()
    if (!q || q.length < ITEM_LIST_SEARCH_MIN) {
      return { rows: [] as Product[], catalogSize, mode: 'need-search' as const }
    }
    const rows: Product[] = []
    for (const p of products) {
      if (p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)) {
        rows.push(p)
        if (rows.length >= ITEM_LIST_MAX_ROWS) break
      }
    }
    return {
      rows,
      catalogSize,
      mode: 'results' as const,
      capped: rows.length >= ITEM_LIST_MAX_ROWS,
    }
  }, [products, deferredItemListFilter])

  const productsById = useMemo(() => new Map(products.map((p) => [p._id, p])), [products])
  productsByIdRef.current = productsById

  /** Same pool as BackOffice Products category field: distinct product categories (no Uncategorized). */
  const catalogCategoriesForPresetSuggest = useMemo(() => {
    if (registerLeftPanel !== 'presets' && assignPresetProduct == null) return []
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
  }, [products, registerLeftPanel, assignPresetProduct])

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
    if (exchangeSession) {
      setError('Exit exchange mode before loading a quote')
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
    return findProductInLookup(productLookupRef.current, raw)
  }

  function requestStockOverrideConfirmation(input: {
    scope: 'offline' | 'online'
    productName: string
    available: number
    maxUnits: number
  }) {
    return new Promise<StockOverrideApproval>((resolve) => {
      if (stockOverrideResolveRef.current) stockOverrideResolveRef.current({ approved: false })
      stockOverrideResolveRef.current = resolve
      setStockOverrideRequest({
        ...input,
        managerScanRequired: !isAdmin,
      })
    })
  }

  function settleStockOverrideApproval(approver: StockOverrideApprover) {
    setStockOverrideRequest(null)
    const resolve = stockOverrideResolveRef.current
    stockOverrideResolveRef.current = null
    resolve?.({ approved: true, approver })
  }

  function cancelStockOverrideApproval() {
    setStockOverrideRequest(null)
    const resolve = stockOverrideResolveRef.current
    stockOverrideResolveRef.current = null
    resolve?.({ approved: false })
  }

  const stockOverrideSelfApprover: StockOverrideApprover | null = session?.user
    ? {
        userId: session.user.id,
        displayName: resolveCashierDisplayName(session.user) ?? session.user.email,
      }
    : null

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
    let overrideApprover: StockOverrideApprover | undefined

    const needsOverridePrecheck =
      requestedQty > Math.max(0, avail - currentLineQty) &&
      stockGuard &&
      (currentLineQty > 0 || avail < requestedQty)
    if (needsOverridePrecheck) {
      if (overrideScope === 'offline' && strictOfflineStock) {
        setError(`Offline strict-stock item blocked: ${p.name}`)
        return
      }
      const allowedTotalQty = Math.max(0, avail) + overrideMaxUnits
      overrideMaxAdd = Math.max(0, allowedTotalQty - currentLineQty)
      if (overrideMaxAdd <= 0) {
        setError(`${overrideScope === 'offline' ? 'Offline' : 'Online'} override limit reached for ${p.name} (max +${overrideMaxUnits}).`)
        return
      }
      const approval = await requestStockOverrideConfirmation({
        scope: overrideScope,
        productName: p.name,
        available: Math.max(0, avail),
        maxUnits: overrideMaxUnits,
      })
      if (!approval.approved) return
      overrideApproved = true
      overrideApprover = approval.approver
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
      const markCartScrollTarget = (line: CartLine) => {
        pendingCartScrollKeyRef.current = cartLineDomKey(line)
      }
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
            ...stockOverrideLineFields(overrideScope, avail, overrideApprover),
          }
          const updated = enrichCartLine(p, merged)
          next[i] = updated
          markCartScrollTarget(updated)
          partialNotice =
            overrideAdd < requestedQty
              ? `${overrideScope === 'offline' ? 'Offline' : 'Online'} override added ${overrideAdd} of ${requestedQty} (limit +${overrideMaxUnits})`
              : `${overrideScope === 'offline' ? 'Offline' : 'Online'} stock override approved for ${p.name}${overrideApprover ? ` (${overrideApprover.displayName})` : ''}`
          return next
        }
        if (toAdd < requestedQty) {
          if (approveStockOverride()) {
            const overrideAdd = Math.min(requestedQty, overrideMaxAdd)
            const merged = {
              ...line,
              quantity: line.quantity + overrideAdd,
              ...stockOverrideLineFields(overrideScope, avail, overrideApprover),
            }
            const updated = enrichCartLine(p, merged)
            next[i] = updated
            markCartScrollTarget(updated)
            partialNotice =
              overrideAdd < requestedQty
                ? `${overrideScope === 'offline' ? 'Offline' : 'Online'} override added ${overrideAdd} of ${requestedQty} (limit +${overrideMaxUnits})`
                : `${overrideScope === 'offline' ? 'Offline' : 'Online'} stock override approved for ${p.name}`
            return next
          }
          partialNotice = `Added ${toAdd} of ${requestedQty} (${avail} available)`
        }
        const merged = { ...line, quantity: line.quantity + toAdd }
        const updated = enrichCartLine(p, merged)
        next[i] = updated
        markCartScrollTarget(updated)
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
          ...stockOverrideLineFields(overrideScope, avail, overrideApprover),
          ...stamp,
        }
        const appended = enrichCartLine(p, newLine)
        markCartScrollTarget(appended)
        partialNotice =
          overrideAdd < requestedQty
            ? `${overrideScope === 'offline' ? 'Offline' : 'Online'} override added ${overrideAdd} of ${requestedQty} (limit +${overrideMaxUnits})`
            : `${overrideScope === 'offline' ? 'Offline' : 'Online'} stock override approved for ${p.name}${overrideApprover ? ` (${overrideApprover.displayName})` : ''}`
        return [...prev, appended]
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
            ...stockOverrideLineFields(overrideScope, avail, overrideApprover),
            ...stamp,
          }
          const appended = enrichCartLine(p, newLine)
          markCartScrollTarget(appended)
          partialNotice =
            overrideAdd < requestedQty
              ? `${overrideScope === 'offline' ? 'Offline' : 'Online'} override added ${overrideAdd} of ${requestedQty} (limit +${overrideMaxUnits})`
              : `${overrideScope === 'offline' ? 'Offline' : 'Online'} stock override approved for ${p.name}`
          return [...prev, appended]
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
      const appended = enrichCartLine(p, newLine)
      markCartScrollTarget(appended)
      return [...prev, appended]
    })
    if (atStockLimit) {
      if (!blockedByPolicy) setError('This line is already at maximum stock for that product')
      return
    }
    spotlightAfterCartRef.current = p
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
    let overrideApproverForBump: StockOverrideApprover | undefined
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
        const allowedTotalQty = Math.max(0, max) + overrideMaxUnits
        if (nextTotal > allowedTotalQty) {
          setError(
            `${overrideScopeForBump === 'offline' ? 'Offline' : 'Online'} override limit reached for ${p.name} (max +${overrideMaxUnits}).`,
          )
          return
        }
        const approval = await requestStockOverrideConfirmation({
          scope: overrideScopeForBump,
          productName: p.name,
          available: Math.max(0, max),
          maxUnits: overrideMaxUnits,
        })
        if (!approval.approved) return
        overrideApprovedForBump = true
        overrideApproverForBump = approval.approver
        partialNotice = `${overrideScopeForBump === 'offline' ? 'Offline' : 'Online'} stock override approved for ${p.name}${approval.approver ? ` (${approval.approver.displayName})` : ''}`
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
        const allowedTotalQty = Math.max(0, maxUnits) + overrideMaxUnits
        if (nextTotalCart > allowedTotalQty) {
          blockedByPolicy = true
          setError(
            `${overrideScopeForBump === 'offline' ? 'Offline' : 'Online'} override limit reached for ${pLine.name} (max +${overrideMaxUnits}).`,
          )
          return prev
        }
      }

      return prev.map((l, j) => {
        if (j !== lineIndex) return l
        const overrideFields = overrideApprovedForBump
          ? stockOverrideLineFields(overrideScopeForBump, maxUnits, overrideApproverForBump)
          : {}
        if (!pLine) {
          return { ...l, quantity: nextQty, ...overrideFields }
        }
        return enrichCartLine(pLine, { ...l, quantity: nextQty, ...overrideFields })
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

  const exchangeReturnTotal = useMemo(
    () => (exchangeSession ? exchangeReturnTotalFromCart(cart) : 0),
    [exchangeSession, cart],
  )
  const exchangeNewTotal = useMemo(
    () => (exchangeSession ? exchangeNewTotalFromCart(cart) : 0),
    [exchangeSession, cart],
  )
  const exchangeNetAmount = useMemo(
    () => (exchangeSession ? roundCartMoney(exchangeNewTotal - exchangeReturnTotal) : 0),
    [exchangeSession, exchangeNewTotal, exchangeReturnTotal],
  )
  const exchangeHasReplacements = useMemo(
    () => (exchangeSession ? cartNewSaleLines(cart).some((l) => l.quantity > 0.005) : false),
    [exchangeSession, cart],
  )

  const cartTotal = useMemo(() => {
    const jobCardLabourActive = activeTabBanner?.kind === 'job_card'
    let s = 0
    for (const l of cart) {
      const p = productsById.get(l.productId)
      s += cartLineTotalIncludingJobLabour(l, p, jobCardLabourActive)
    }
    return roundCartMoney(s)
  }, [cart, productsById, activeTabBanner?.kind])

  const parkedSaleLineCount = useMemo(
    () => parkedSlotLines(saleHoldSlots).length,
    [saleHoldSlots],
  )

  const heldSaleHeaderBanner = useMemo(() => {
    if (activeTabBanner || activeQuoteBanner || parkedSaleLineCount === 0) return null
    const parkedLines = parkedSlotLines(saleHoldSlots)
    const total = heldSaleCartTotal(parkedLines)
    return (
      <>
        Sale on hold · {parkedSaleLineCount} line{parkedSaleLineCount === 1 ? '' : 's'} · R {total.toFixed(2)}
        {' — press '}
        <strong>HOLD SALE</strong> to switch
      </>
    )
  }, [activeTabBanner, activeQuoteBanner, parkedSaleLineCount, saleHoldSlots])

  const publishCustomerDisplayNowRef = useRef<() => void>(() => {})

  const loyalty = useRegisterLoyalty({
    sessionActive: !!session,
    cartTotal,
    setError,
    setNotice,
    onLoyaltyEntryStarted: () => {
      setSkuInput('')
      publishCustomerDisplayNowRef.current()
    },
  })
  function closeLoyaltyModal() {
    if (loyalty.loyaltyEntryActive) loyalty.cancelLoyaltyEntry()
    setLoyaltyModalOpen(false)
  }

  const cartCheckout = useMemo(
    () => cartCheckoutDisplay(cartTotal, loyalty.loyaltyDiscount, cashRoundingConfig),
    [cartTotal, loyalty.loyaltyDiscount, cashRoundingConfig],
  )

  function checkoutTenderInput(
    overrides: Partial<{
      total: number
      cashReceived: number
      cardReceived: number
      storeCredit: number
      onAccount: number
    }> = {},
  ): CheckoutTenderInput {
    return {
      merchandiseTotal: overrides.total ?? pendingSplit?.total ?? cartTotal,
      loyaltyDiscount: loyalty.loyaltyDiscount,
      storeCredit: overrides.storeCredit ?? pendingSplit?.storeCreditApplied ?? 0,
      onAccount: overrides.onAccount ?? pendingSplit?.onAccountApplied ?? 0,
      cashReceived: overrides.cashReceived ?? pendingSplit?.cashReceived ?? 0,
      cardReceived: overrides.cardReceived ?? pendingSplit?.cardReceived ?? 0,
      config: cashRoundingConfig,
    }
  }

  function resolveSalePaymentMethod(
    cashApplied: number,
    cardApplied: number,
    storeCredit: number,
    onAccount: number,
  ): string {
    const tenderCount = [
      cashApplied > 0.005,
      cardApplied > 0.005,
      storeCredit > 0.005,
      onAccount > 0.005,
      loyalty.loyaltyDiscount > 0.005,
    ].filter(Boolean).length
    if (tenderCount >= 2 || (cashApplied > 0.005 && cardApplied > 0.005)) return 'split'
    if (
      onAccount > 0.005 &&
      cashApplied < 0.005 &&
      cardApplied < 0.005 &&
      storeCredit < 0.005 &&
      loyalty.loyaltyDiscount < 0.005
    ) {
      return 'on_account'
    }
    if (cardApplied > 0 && cashApplied > 0) return 'split'
    if (cardApplied > 0) return 'card'
    if (cashApplied > 0) return receiptEnabled ? 'cash-receipt' : 'cash-no-receipt'
    if (storeCredit > 0.005) return 'store_credit'
    if (loyalty.loyaltyDiscount > 0.005) return 'loyalty'
    return receiptEnabled ? 'cash-receipt' : 'cash-no-receipt'
  }

  function beginCustomerDisplayLoyaltyPhoneEntry() {
    if (!loyalty.loyaltyProgram?.enabled) {
      setError('Loyalty program is not enabled')
      return
    }
    loyalty.startLoyaltyEntry()
    publishCustomerDisplayNow()
    scheduleCustomerDisplayLoyaltyFocus()
  }

  function openLoyaltyModal() {
    setLoyaltyModalOpen(true)
    if (!loyalty.loyaltyMasked) {
      beginCustomerDisplayLoyaltyPhoneEntry()
    }
  }

  function startLoyaltyPhoneFromModal() {
    beginCustomerDisplayLoyaltyPhoneEntry()
  }

  function onAccountRemainingDueAmount() {
    return checkoutAmountDue(checkoutTenderInput())
  }

  useCustomerDisplaySettingsLoader(session)
  useEffect(() => {
    if (!session) return
    let cancelled = false
    void apiFetch<StoreSettings>('/settings/store')
      .then((s) => {
        if (cancelled) return
        setStoreDisplayName(s.storeName?.trim() || DEFAULT_STORE_NAME)
        setCustomerDisplayConfig(storeConfigFromSettings(s))
        setCashRoundingConfig(cashRoundingFromSettings(s))
      })
      .catch(() => {
        /* use cache */
      })
    return () => {
      cancelled = true
    }
  }, [session?.accessToken])

  const customerDisplayConfigForTill = useMemo(
    () => applyPosThemeToCustomerDisplayConfig(customerDisplayConfig, posTheme),
    [customerDisplayConfig, posTheme],
  )

  const jobCardLabourActive = activeTabBanner?.kind === 'job_card'
  const { publishNow: publishCustomerDisplayNow } = useCustomerDisplaySync({
    session,
    storeConfig: customerDisplayConfigForTill,
    storeName: storeDisplayName,
    cart,
    cartTotal: cartCheckout.displayTotal,
    productsById,
    showChangeView,
    lastTotal: lastTotal,
    lastChangeDue,
    lastCardAmount,
    lastTendered,
    pendingSplit: !!pendingSplit,
    refundSession: !!refundSession,
    jobCardLabourActive,
    loyaltyEntryActive: loyalty.loyaltyEntryActive,
    loyaltyEntryDisplayValue: loyalty.loyaltyEntryDisplayValue,
    loyaltyEntryFocusToken: loyalty.loyaltyEntryFocusToken,
    loyaltyMasked: loyalty.loyaltyMasked,
    loyaltyPointsBalance: loyalty.loyaltyPhone ? loyalty.loyaltyBalance : null,
  })
  publishCustomerDisplayNowRef.current = publishCustomerDisplayNow

  useEffect(() => {
    if (cart.length === 0) clearCustomerDisplaySpotlightSeen()
  }, [cart.length])

  useEffect(() => {
    if (loyalty.loyaltyEntryActiveRef.current) {
      spotlightAfterCartRef.current = null
      return
    }
    const p = spotlightAfterCartRef.current
    if (!p) return
    spotlightAfterCartRef.current = null
    const snapshot = buildCustomerDisplaySnapshot({
      session,
      storeConfig: customerDisplayConfigForTill,
      storeName: storeDisplayName,
      cart,
      cartTotal,
      productsById,
      showChangeView,
      lastTotal,
      lastChangeDue,
      lastCardAmount,
      lastTendered,
      pendingSplit: !!pendingSplit,
      refundSession: !!refundSession,
      jobCardLabourActive,
      loyaltyEntryActive: loyalty.loyaltyEntryActive,
      loyaltyEntryDisplayValue: loyalty.loyaltyEntryDisplayValue,
      loyaltyEntryFocusToken: loyalty.loyaltyEntryFocusToken,
      loyaltyMasked: loyalty.loyaltyMasked,
      loyaltyPointsBalance: loyalty.loyaltyPhone ? loyalty.loyaltyBalance : null,
    })
    void publishProductSpotlight(p, snapshot, () => !loyalty.loyaltyEntryActiveRef.current)
  }, [
    cart,
    session,
    customerDisplayConfigForTill,
    storeDisplayName,
    cartTotal,
    productsById,
    showChangeView,
    lastTotal,
    lastChangeDue,
    lastCardAmount,
    lastTendered,
    pendingSplit,
    refundSession,
    jobCardLabourActive,
    loyalty.loyaltyEntryActive,
    loyalty.loyaltyEntryDisplayValue,
    loyalty.loyaltyEntryFocusToken,
    loyalty.loyaltyMasked,
    loyalty.loyaltyBalance,
    loyalty.loyaltyPhone,
    posTheme,
  ])

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
    if (exchangeSession) {
      setError('Exit exchange mode before opening a tab')
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
            ...stockOverridePayloadFromLine(l),
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
    if (exchangeSession) {
      throw new Error('Exit exchange mode before using tabs')
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
          ...stockOverridePayloadFromLine(l),
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
    if (manualReturnActive) {
      setError('Exit manual return mode before starting a refund')
      return
    }
    if (exchangeSession) {
      setError('Exit exchange mode before starting a refund')
      return
    }
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
    setRefundPayoutOpen(false)
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
    setRefundPayoutOpen(false)
    setCart([])
  }

  function openRefundPayoutStep() {
    if (!refundSession) return
    const lines = cart.filter((l) => l.refundSaleLineIndex !== undefined && l.quantity > 0.005)
    if (!lines.length) {
      setError('Use − / + so at least one line has a quantity to refund')
      return
    }
    if (refundSession.previewSale.refundStatus === 'refunded' || refundSession.refundPreview.remainingTotal <= 0.005) {
      setError('This sale is already fully refunded')
      return
    }
    setError(null)
    setRefundPayoutOpen(true)
  }

  function closeRefundPayoutStep() {
    setRefundPayoutOpen(false)
    setRefundCartScreenKbOpen(false)
    cancelRefundCartKbBlurHide()
  }

  function openExchangePayoutStep() {
    if (!exchangeSession) return
    if (!cartReturnLines(cart).some((l) => l.quantity > 0.005)) {
      setError('Use − / + so at least one return line has quantity')
      return
    }
    if (!cartNewSaleLines(cart).some((l) => l.quantity > 0.005)) {
      setError('Add at least one replacement item before continuing')
      return
    }
    setError(null)
    setExchangePayoutOpen(true)
    setSkuInput('')
  }

  function closeExchangePayoutStep() {
    setExchangePayoutOpen(false)
    setRefundCartScreenKbOpen(false)
    cancelRefundCartKbBlurHide()
  }

  async function exitRefundModePrompt() {
    if (!refundSession) return
    if (!window.confirm('Leave refund mode? The refund cart will be cleared.')) return
    clearRefundModeAndCart()
    setError(null)
  }

  function beginExchangeMode(data: SaleExchangePreview, routeSaleId: string) {
    if (manualReturnActive) {
      setError('Exit manual return mode before starting an exchange')
      return
    }
    if (refundSession) {
      setError('Exit refund mode before starting an exchange')
      return
    }
    const lines = cartLinesFromReturnPreview(data.sale, data.return)
    if (!lines.length) {
      setError('Nothing left to return on this sale')
      return
    }
    if (!data.eligibility.eligible && !(data.eligibility.adminBypassAvailable && isRoleAdmin(session?.user))) {
      setError(
        `Sale is outside the ${data.eligibility.maxDays}-day exchange window (${data.eligibility.daysSinceSale} days ago)`,
      )
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
    setExchangeNote('')
    setExchangeCreditPhone(
      typeof data.sale.storeCreditPhone === 'string' ? data.sale.storeCreditPhone : '',
    )
    setExchangeAdminBypass(false)
    setExchangePayoutOpen(false)
    setRefundCartScreenKbOpen(false)
    cancelRefundCartKbBlurHide()
    setAltPaymentExpanded(false)
    setVoucherFormOpen(false)
    setHouseAccountFormOpen(false)
    setExchangeSession({
      routeSaleId,
      previewSale: data.sale,
      returnPreview: data.return,
      eligibility: data.eligibility,
    })
    setCart(lines)
  }

  function clearExchangeModeAndCart() {
    setExchangeSession(null)
    setExchangeNote('')
    setExchangeCreditPhone('')
    setExchangeAdminBypass(false)
    setExchangePayoutOpen(false)
    setRefundCartScreenKbOpen(false)
    cancelRefundCartKbBlurHide()
    setCart([])
  }

  function exitExchangeModePrompt() {
    if (!exchangeSession) return
    setExchangeExitConfirmOpen(true)
  }

  function confirmExitExchangeMode() {
    setExchangeExitConfirmOpen(false)
    clearExchangeModeAndCart()
    setError(null)
  }

  async function submitExchangeCheckout(settlementKind: SaleExchangeSettlementKind) {
    if (!exchangeSession || busy) return
    const snap = exchangeSession
    const returnLines = cartReturnLines(cart).map((l) => ({
      lineIndex: l.refundSaleLineIndex!,
      quantity: l.quantity,
    }))
    const newLines = cartNewSaleLines(cart).map((l) => ({
      productId: l.productId,
      quantity: l.quantity,
    }))
    if (!returnLines.length) {
      setError('Select at least one item quantity to return')
      return
    }
    if (!newLines.length) {
      setError('Add at least one replacement item to the cart')
      return
    }
    const net = exchangeNetAmount
    if (Math.abs(net) <= 0.005 && settlementKind !== 'even') {
      setError('Even exchange — use Complete exchange')
      return
    }
    if (net > 0.005 && settlementKind !== 'customer_pays_cash') {
      setError('Customer must pay the difference in cash')
      return
    }
    if (net < -0.005 && settlementKind !== 'customer_receives_cash' && settlementKind !== 'customer_receives_store_credit') {
      setError('Customer credit must be paid as cash or store credit')
      return
    }
    if (
      !snap.eligibility.eligible &&
      !(exchangeAdminBypass && isRoleAdmin(session?.user))
    ) {
      setError(
        `Sale is outside the ${snap.eligibility.maxDays}-day exchange window (${snap.eligibility.daysSinceSale} days ago)`,
      )
      return
    }
    if (settlementKind === 'customer_receives_store_credit') {
      const phone = normalizePhone(exchangeCreditPhone)
      if (!phone) {
        setError('Enter the customer phone number for store credit')
        return
      }
    }
    let cashTendered: number | undefined
    let changeDue: number | undefined
    if (settlementKind === 'customer_pays_cash') {
      const due = round2(net)
      const entered = parseTenderedInput(skuInputRef.current, 0)
      if (!Number.isFinite(entered) || entered <= 0.005) {
        setError(`Enter cash tendered on the register keypad (amount due ${due.toFixed(2)})`)
        return
      }
      const tendered = entered
      if (tendered + 0.03 < due) {
        setError(`Enter cash tendered on keypad (amount due ${due.toFixed(2)})`)
        return
      }
      cashTendered = tendered
      changeDue = round2(Math.max(0, tendered - due))
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const body: Record<string, unknown> = {
        note: exchangeNote.trim() || undefined,
        returnLines,
        newLines,
        settlementKind,
        tillCode: POS_TILL_CODE,
        adminBypassEligibility: exchangeAdminBypass || undefined,
      }
      if (cashTendered != null) body.cashTendered = cashTendered
      if (changeDue != null) body.changeDue = changeDue
      if (settlementKind === 'customer_receives_store_credit') {
        body.storeCreditPhone = normalizePhone(exchangeCreditPhone)
      }
      const resp = await apiFetch<{ sale?: Sale; exchangeSettlement?: SaleExchangeSettlement }>(
        `/sales/${encodeURIComponent(snap.routeSaleId)}/exchange`,
        { method: 'POST', body: JSON.stringify(body) },
      )
      const noteTrim = exchangeNote.trim()
      const settlement = resp.exchangeSettlement
      const returnForPrint = cartReturnLines(cart).map((l) => ({
        qty: l.quantity,
        name: l.name,
        unitPrice: l.unitPrice,
        listUnitPrice: l.listUnitPrice,
        lineTotal: cartLineSubtotal(l),
      }))
      const newForPrint = cartNewSaleLines(cart).map((l) => ({
        qty: l.quantity,
        name: l.name,
        unitPrice: l.unitPrice,
        listUnitPrice: l.listUnitPrice,
        lineTotal: cartLineSubtotal(l),
      }))
      setNotice('Exchange recorded — stock and accounts updated where applicable')
      if (resp.sale && settlement) {
        try {
          const printed = await printExchangeReceiptToDevice(resp.sale, noteTrim || undefined, {
            returnLines: returnForPrint,
            newLines: newForPrint,
            returnTotal: settlement.returnTotal,
            newTotal: settlement.newTotal,
            netAmount: settlement.netAmount,
            cashPaidIn: settlement.cashPaidIn,
            cashPaidOut: settlement.cashPaidOut,
            storeCreditIssued: settlement.storeCreditIssued,
            storeCreditPhoneDigits:
              settlementKind === 'customer_receives_store_credit'
                ? normalizePhone(exchangeCreditPhone)
                : undefined,
          })
          if (printed.payload) {
            setLastReceiptForReprint({
              kind: 'raw',
              payload: printed.payload,
              successNotice: 'Exchange receipt printed',
            })
          }
          if (!printed.ok) throw new Error(printed.error ?? 'Exchange receipt print failed')
        } catch (e) {
          setError(
            e instanceof Error
              ? `${e.message} — exchange was saved.`
              : 'Exchange receipt print failed — exchange was saved.',
          )
        }
      }
      applyCatalogStockFromCart(cartReturnLines(cart), 'refund')
      applyCatalogStockFromCart(cartNewSaleLines(cart), 'sale')
      clearExchangeModeAndCart()
      setSkuInput('')
      setPendingSplit(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Exchange failed')
    } finally {
      setBusy(false)
    }
  }

  function beginManualReturnMode() {
    if (!canManualReturnPos) return
    if (refundSession) {
      setError('Exit refund mode before manual return')
      return
    }
    if (exchangeSession) {
      setError('Exit exchange mode before manual return')
      return
    }
    if (activeOpenTabId) {
      setError('Close or complete the open tab before manual return')
      return
    }
    setError(null)
    setNotice(null)
    setCart([])
    setManualReturnNote('')
    setManualReturnCreditPhone('')
    setManualReturnPayoutOpen(false)
    setManualReturnActive(true)
  }

  function clearManualReturnMode() {
    setManualReturnActive(false)
    setManualReturnPayoutOpen(false)
    setManualReturnNote('')
    setManualReturnCreditPhone('')
    setCart([])
  }

  async function exitManualReturnModePrompt() {
    if (!manualReturnActive) return
    if (!window.confirm('Leave manual return mode? The cart will clear.')) return
    clearManualReturnMode()
  }

  function openManualReturnPayoutStep() {
    if (!manualReturnActive || cart.length === 0) return
    setManualReturnPayoutOpen(true)
  }

  function closeManualReturnPayoutStep() {
    setManualReturnPayoutOpen(false)
  }

  async function submitManualReturnCheckout(method: 'cash' | 'card' | 'store_credit') {
    if (!manualReturnActive || busy) return
    const noteTrim = manualReturnNote.trim()
    if (noteTrim.length < 3) {
      setError('Enter a reason for this return (at least 3 characters)')
      return
    }
    if (cart.length === 0) {
      setError('Add at least one product to return')
      return
    }
    if (method === 'store_credit') {
      const phone = normalizePhone(manualReturnCreditPhone)
      if (!phone) {
        setError('Enter the customer phone number for store credit')
        return
      }
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const body: Record<string, unknown> = {
        tillCode: POS_TILL_CODE,
        note: noteTrim,
        payoutMethod: method,
        lines: cart.map((l) => ({ productId: l.productId, quantity: l.quantity })),
      }
      if (method === 'store_credit') {
        body.storeCreditPhone = normalizePhone(manualReturnCreditPhone)
      }
      const resp = await apiFetch<{ manualReturn?: ManualReturnResult }>('/manual-returns', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      const result = resp.manualReturn
      if (!result) {
        throw new Error('Manual return failed')
      }
      setNotice('Manual return recorded — stock updated where applicable')
      const printLines = cart.map((l) => ({
        qty: l.quantity,
        name: l.name,
        unitPrice: l.unitPrice,
        lineTotal: cartLineSubtotal(l),
      }))
      const printed = await printManualReturnReceipt(
        result,
        printLines,
        method,
        noteTrim,
        method === 'store_credit' ? normalizePhone(manualReturnCreditPhone) : undefined,
      )
      if (!printed.ok) {
        setNotice(
          `Manual return saved. Receipt did not print — ${printed.error ?? 'printer error'}.`,
        )
      }
      clearManualReturnMode()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Manual return failed')
    } finally {
      setBusy(false)
    }
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
    const refundLines = cart.filter((l) => l.refundSaleLineIndex !== undefined && l.quantity > 0.005)
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
        const printed = await printRefundReceiptToDevice(refundedSale, noteTrim || undefined, method, {
          lines: refundLinesForPrint,
          refundTotal: refundPrintTotal,
          ...(settlement
            ? {
                cashPaidOut: method === 'cash' ? settlement.netCashOrCardPaidOut : 0,
                cardPaidOut: method === 'card' ? settlement.netCashOrCardPaidOut : 0,
                storeCreditIssued: settlement.storeCreditIssued,
                reversedOnAccount: settlement.reversedOnAccount,
              }
            : {}),
          ...(method === 'store_credit'
            ? { storeCreditPhoneDigits: normalizePhone(refundCreditPhone) }
            : {}),
        })
        if (!printed.ok) {
          setNotice(
            `Sale refunded. Receipt did not print — ${printed.error ?? 'printer error'}. Reprint from history if needed.`,
          )
        }
      }
      applyCatalogStockFromCart(refundLines, 'refund')
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
    cashRoundingAdjustment?: number,
  ) {
    if (refundSession || exchangeSession) return
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
    setLastLoyaltyDiscount(null)
    setLastLoyaltyPoints(null)
    setPendingSplit(null)
    const tabIdForSale = activeOpenTabId
    const soldLines = cart.map((l) => ({ productId: l.productId, quantity: l.quantity }))
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
      loyalty.appendLoyaltyToSaleBody(body)
      appendCashierSignInToSaleBody(body, session?.signInMethod)
      const roundingAdj = effectiveCashRoundingAdjustment(
        payment?.cashAmount ?? 0,
        cashRoundingAdjustment ?? 0,
      )
      if (Math.abs(roundingAdj) > 0.005) {
        body.cashRoundingAdjustment = round2(roundingAdj)
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
      if (!tabIdForSale) {
        setSaleHoldSlots((prev) => clearActiveSaleHoldSlot(prev))
      }
      resetVoucherForm()
      applyCatalogStockFromCart(soldLines, 'sale')
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
        loyalty.appendLoyaltyToSaleBody(body)
        appendCashierSignInToSaleBody(body, session?.signInMethod)
        const offlineRoundingAdj = effectiveCashRoundingAdjustment(
          payment?.cashAmount ?? 0,
          cashRoundingAdjustment ?? 0,
        )
        if (Math.abs(offlineRoundingAdj) > 0.005) {
          body.cashRoundingAdjustment = round2(offlineRoundingAdj)
        }
        try {
          await enqueueOfflineSale(clientLocalId, body)
          applyOfflineStockDeduction(soldLines)
          const pending = await getOfflinePendingSalesCount()
          setOfflinePendingCount(pending)
          const previewJobLabour = activeTabBanner?.kind === 'job_card'
          const queuedSale: Sale = {
            _id: `offline-${clientLocalId}`,
            saleId: clientLocalId.slice(-10),
            tillCode: POS_TILL_CODE,
            cashierSignInMethod: session?.signInMethod,
            cashier: String(session?.user?.id ?? ''),
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
            ...(loyalty.loyaltyDiscount > 0.005
              ? {
                  loyaltyDiscountAmount: round2(loyalty.loyaltyDiscount),
                  loyaltyPointsRedeemed: loyalty.loyaltyPointsRedeem,
                  loyaltyPhoneMasked: loyalty.loyaltyMasked ?? undefined,
                }
              : {}),
            ...(Math.abs(
              effectiveCashRoundingAdjustment(payment?.cashAmount ?? 0, cashRoundingAdjustment ?? 0),
            ) > 0.005
              ? {
                  cashRoundingAdjustment: round2(
                    effectiveCashRoundingAdjustment(
                      payment?.cashAmount ?? 0,
                      cashRoundingAdjustment ?? 0,
                    ),
                  ),
                }
              : {}),
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
          if (!tabIdForSale) {
            setSaleHoldSlots((prev) => clearActiveSaleHoldSlot(prev))
          }
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

  function applySaleCompleteTotals(
    sale: Sale,
    grossTotal: number,
    tenders: {
      tendered: number
      cardAmount: number
      storeCredit: number | null
      onAccount: number | null
      changeDue: number
    },
  ) {
    const loyaltyAmt = Number(sale.loyaltyDiscountAmount ?? 0)
    const loyaltyPts = Math.floor(Number(sale.loyaltyPointsRedeemed ?? 0))
    const roundingAdj = Number(sale.cashRoundingAdjustment ?? 0)
    setLastTotal(round2(grossTotal + roundingAdj))
    setLastLoyaltyDiscount(loyaltyAmt > 0.005 ? loyaltyAmt : null)
    setLastLoyaltyPoints(loyaltyPts > 0 ? loyaltyPts : null)
    setLastTendered(tenders.tendered)
    setLastCardAmount(tenders.cardAmount)
    setLastStoreCredit(tenders.storeCredit)
    setLastOnAccount(tenders.onAccount)
    setLastChangeDue(tenders.changeDue)
    setShowChangeView(true)
  }

  async function applyPartialPayment(method: 'cash' | 'card') {
    if (refundSession || exchangeSession) return
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

    const tenderBase = {
      merchandiseTotal: total,
      loyaltyDiscount: loyalty.loyaltyDiscount,
      storeCredit: prevSc,
      onAccount: prevOa,
      config: cashRoundingConfig,
    }

    const dueState = computeCheckoutTenders({
      ...tenderBase,
      cashReceived: prevCash,
      cardReceived: prevCard,
    })

    if (dueState.amountDue <= 0.005) {
      if (loyalty.loyaltyDiscount <= 0.005) {
        setError('No outstanding amount due')
        return
      }
      const sale = await submitSale(
        'loyalty',
        { cashAmount: 0, cardAmount: 0, tenderedCash: 0, changeDue: 0 },
        prevSc > 0 ? { amount: prevSc, phone: storeCreditPhone } : undefined,
        prevOa > 0 && oaId ? { id: oaId, amount: prevOa, purchaseOrderNumber: poNumber } : undefined,
      )
      if (!sale) return
      loyalty.clearLoyalty()
      applySaleCompleteTotals(sale, total, {
        tendered: 0,
        cardAmount: 0,
        storeCredit: prevSc > 0 ? prevSc : null,
        onAccount: prevOa > 0 ? prevOa : null,
        changeDue: 0,
      })
      setSkuInput('')
      setPendingSplit(null)
      void postSaleHardwareActions(sale)
      return
    }

    const cardMax = maxCardTender({ ...tenderBase, cardReceived: prevCard })
    const fallbackDue = method === 'cash' ? dueState.amountDue : cardMax
    const entered = parseTenderedInput(skuInputRef.current, fallbackDue)
    if (!Number.isFinite(entered) || entered <= 0) {
      setError(`Enter ${method} amount on keypad before pressing ${method.toUpperCase()}`)
      return
    }

    const cardApply =
      method === 'card' ? cardAmountToApply(entered, cardMax, cashRoundingConfig) : entered
    const nextCash = round2(prevCash + (method === 'cash' ? entered : 0))
    const nextCard = round2(prevCard + (method === 'card' ? cardApply : 0))
    const state = computeCheckoutTenders({
      ...tenderBase,
      cashReceived: nextCash,
      cardReceived: nextCard,
    })

    if (!state.isComplete) {
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
        amountDue: state.amountDue,
      })
      setSkuInput('')
      return
    }

    const paymentMethod = resolveSalePaymentMethod(
      state.cashAmount,
      state.cardAmount,
      prevSc,
      prevOa,
    )

    const sale = await submitSale(
      paymentMethod,
      {
        cashAmount: state.cashAmount,
        cardAmount: state.cardAmount,
        tenderedCash: nextCash,
        changeDue: state.changeDue,
      },
      prevSc > 0 ? { amount: prevSc, phone: storeCreditPhone } : undefined,
      prevOa > 0 && oaId ? { id: oaId, amount: prevOa, purchaseOrderNumber: poNumber } : undefined,
      state.cashRoundingAdjustment,
    )
    if (!sale) return
    loyalty.clearLoyalty()
    applySaleCompleteTotals(sale, total, {
      tendered: nextCash,
      cardAmount: state.cardAmount,
      storeCredit: prevSc > 0 ? prevSc : null,
      onAccount: prevOa > 0 ? prevOa : null,
      changeDue: state.changeDue,
    })
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
      amountDue: checkoutAmountDue(
        checkoutTenderInput({
          total,
          cashReceived,
          cardReceived,
          storeCredit: 0,
          onAccount: onAccountApplied,
        }),
      ),
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
      amountDue: checkoutAmountDue(
        checkoutTenderInput({
          total,
          cashReceived,
          cardReceived,
          storeCredit: storeCreditApplied,
          onAccount: 0,
        }),
      ),
    })
  }

  function applyVoucherUseMax() {
    const total = pendingSplit?.total ?? cartTotal
    const prevCash = pendingSplit?.cashReceived ?? 0
    const prevCard = pendingSplit?.cardReceived ?? 0
    const prevSc = pendingSplit?.storeCreditApplied ?? 0
    const prevOa = pendingSplit?.onAccountApplied ?? 0
    const maxVoucher = round2(exactMerchandiseDue(total, loyalty.loyaltyDiscount, prevSc, prevOa) - prevCash - prevCard)
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
    const prevSc = pendingSplit?.storeCreditApplied ?? 0
    const prevOa = pendingSplit?.onAccountApplied ?? 0
    const oaId = pendingSplit?.houseAccountId ?? ''
    const oaNum = pendingSplit?.houseAccountNumber ?? ''
    const oaName = pendingSplit?.houseAccountName ?? ''
    const poNumber = pendingSplit?.purchaseOrderNumber ?? ''
    const maxVoucher = round2(exactMerchandiseDue(total, loyalty.loyaltyDiscount, prevSc, prevOa) - prevCash - prevCard)
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
    const checkoutState = computeCheckoutTenders({
      merchandiseTotal: total,
      loyaltyDiscount: loyalty.loyaltyDiscount,
      storeCredit: newSc,
      onAccount: prevOa,
      cashReceived: prevCash,
      cardReceived: prevCard,
      config: cashRoundingConfig,
    })

    if (!checkoutState.isComplete) {
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
        amountDue: checkoutState.amountDue,
      })
      setVoucherAmountStr('')
      setVoucherFormOpen(false)
      return
    }

    const paymentMethod = resolveSalePaymentMethod(
      checkoutState.cashAmount,
      checkoutState.cardAmount,
      newSc,
      prevOa,
    )

    const sale = await submitSale(
      paymentMethod,
      {
        cashAmount: checkoutState.cashAmount,
        cardAmount: checkoutState.cardAmount,
        tenderedCash: prevCash,
        changeDue: checkoutState.changeDue,
      },
      newSc > 0 ? { amount: newSc, phone } : undefined,
      prevOa > 0 && oaId ? { id: oaId, amount: prevOa, purchaseOrderNumber: poNumber } : undefined,
      checkoutState.cashRoundingAdjustment,
    )
    if (!sale) return
    loyalty.clearLoyalty()
    applySaleCompleteTotals(sale, total, {
      tendered: prevCash,
      cardAmount: checkoutState.cardAmount,
      storeCredit: newSc > 0 ? newSc : null,
      onAccount: prevOa > 0 ? prevOa : null,
      changeDue: checkoutState.changeDue,
    })
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
    const checkoutState = computeCheckoutTenders({
      merchandiseTotal: total,
      loyaltyDiscount: loyalty.loyaltyDiscount,
      storeCredit: prevSc,
      onAccount: newOa,
      cashReceived: prevCash,
      cardReceived: prevCard,
      config: cashRoundingConfig,
    })
    if (!checkoutState.isComplete) {
      setError('Insufficient available account credit. Take an account payment first.')
      return
    }

    const paymentMethod = resolveSalePaymentMethod(
      checkoutState.cashAmount,
      checkoutState.cardAmount,
      prevSc,
      newOa,
    )

    const sale = await submitSale(
      paymentMethod,
      {
        cashAmount: checkoutState.cashAmount,
        cardAmount: checkoutState.cardAmount,
        tenderedCash: prevCash,
        changeDue: checkoutState.changeDue,
      },
      prevSc > 0 ? { amount: prevSc, phone: pendingSplit?.storeCreditPhone ?? '' } : undefined,
      newOa > 0 ? { id: acct._id, amount: newOa, purchaseOrderNumber: poNumber } : undefined,
      checkoutState.cashRoundingAdjustment,
    )
    if (!sale) return
    loyalty.clearLoyalty()
    applySaleCompleteTotals(sale, total, {
      tendered: prevCash,
      cardAmount: checkoutState.cardAmount,
      storeCredit: prevSc > 0 ? prevSc : null,
      onAccount: newOa > 0 ? newOa : null,
      changeDue: checkoutState.changeDue,
    })
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
    if (manualReturnActive) return
    if (exchangeSession) {
      setError('Use Continue to exchange, then settle in the confirmation step')
      return
    }
    await applyPartialPayment('cash')
  }

  async function checkoutCard() {
    if (refundSession) {
      await submitRefundCheckout('card')
      return
    }
    if (manualReturnActive) return
    if (exchangeSession) {
      setError('Exchanges settle with cash or store credit only — not card')
      return
    }
    await applyPartialPayment('card')
  }

  function pressKey(key: string) {
    if (loyalty.loyaltyEntryActiveRef.current) {
      return
    }
    if (refundPayoutOpen) {
      return
    }
    if (exchangePayoutOpen) {
      if (key === 'enter') return
      // Customer owes cash — register keypad is for tender entry only.
      if (exchangeNetAmount <= 0.005) return
    }
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

  async function importShopAssistCart(scannedToken: string) {
    if (refundSession) {
      setError('Exit refund mode before importing a ShopAssist cart')
      return
    }
    if (exchangeSession) {
      setError('Exit exchange mode before importing a ShopAssist cart')
      return
    }
    if (offlineCatalogMode || !serverReachable) {
      setError('ShopAssist cart import needs the server connection')
      return
    }
    if (cartRef.current.length > 0 && !window.confirm('Import ShopAssist cart into the current cart?')) return

    const token = scannedToken.trim()
    if (!token) return

    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const claimed = await claimShopAssistCart(token)
      let imported = 0
      for (const line of claimed.lines) {
        const product =
          productsByIdRef.current.get(line.productId) ??
          findProductBySkuOrBarcode(line.sku) ??
          (line.barcode ? findProductBySkuOrBarcode(line.barcode) : undefined)
        if (!product) {
          setError(`Imported cart, but POS catalog is missing ${line.sku}. Refresh catalog and add it manually.`)
          return
        }
        await addToCartQty(product, line.quantity)
        imported += line.quantity
      }
      setNotice(`Imported ${imported} item${imported === 1 ? '' : 's'} from ShopAssist`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to import ShopAssist cart')
    } finally {
      setBusy(false)
    }
  }

  // Global key handling (barcode scanner -> keyboard events).
  // This page doesn't have a real <input> for SKU entry, so without this listener,
  // scanned digits wouldn't be captured.
  useEffect(() => {
    function resetScannerRawInputSoon() {
      if (scannerRawInputTimerRef.current) clearTimeout(scannerRawInputTimerRef.current)
      scannerRawInputTimerRef.current = window.setTimeout(() => {
        scannerRawInputRef.current = ''
        scannerRawInputTimerRef.current = null
      }, SCANNER_BUFFER_RESET_MS)
    }

    function appendScannerRawInput(key: string) {
      scannerRawInputRef.current = `${scannerRawInputRef.current}${key}`.slice(-512)
      resetScannerRawInputSoon()
      return scannerRawInputRef.current
    }

    function looksLikeShopAssistQrPrefix(value: string) {
      const lower = value.toLowerCase()
      return (
        lower.startsWith(SHOPASSIST_CART_QR_PREFIX) ||
        SHOPASSIST_CART_QR_PREFIX.startsWith(lower)
      )
    }

    function isEditableField(node: EventTarget | null): boolean {
      const el = node as HTMLElement | null
      if (!el) return false
      const tag = el.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        if (el instanceof HTMLInputElement) {
          const t = el.type.toLowerCase()
          if (t === 'button' || t === 'submit' || t === 'reset' || t === 'checkbox' || t === 'radio') {
            return false
          }
          if (el.readOnly || el.disabled) return false
        }
        if (el instanceof HTMLTextAreaElement && (el.readOnly || el.disabled)) return false
        if (el instanceof HTMLSelectElement && el.disabled) return false
        return true
      }
      return el.getAttribute?.('contenteditable') === 'true'
    }

    function isTypingTarget(target: EventTarget | null) {
      // Hardware POS keypads often dispatch keydown with target=<body> while an input is focused.
      return isEditableField(target) || isEditableField(document.activeElement)
    }

    function onKeyDown(e: KeyboardEvent) {
      if (settingsObscured) return
      if (refundSession || refundPayoutOpen || exchangePayoutOpen) return
      if (loyalty.loyaltyEntryActiveRef.current) {
        if (e.key === 'Escape') {
          e.preventDefault()
          playPosKeySound()
          loyalty.cancelLoyaltyEntry()
        }
        return
      }
      // When browsing items, don't hijack typing into the search box.
      if (registerLeftPanel === 'list') return
      if (e.defaultPrevented) return
      if (isTypingTarget(e.target)) return

      // Avoid repeating characters for long key presses.
      if (e.repeat) return

      if (e.key === 'Enter') {
        const rawScan = scannerRawInputRef.current.trim()
        scannerRawInputRef.current = ''
        if (scannerRawInputTimerRef.current) {
          clearTimeout(scannerRawInputTimerRef.current)
          scannerRawInputTimerRef.current = null
        }
        if (rawScan.toLowerCase().startsWith(SHOPASSIST_CART_QR_PREFIX)) {
          e.preventDefault()
          playPosKeySound()
          setSkuInput('')
          void importShopAssistCart(rawScan)
          return
        }
        e.preventDefault()
        playPosKeySound()
        addBySku()
        return
      }

      if (e.key.length === 1) {
        const rawScan = appendScannerRawInput(e.key)
        if (looksLikeShopAssistQrPrefix(rawScan)) {
          e.preventDefault()
          return
        }
      }

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
      if (e.key === 'Escape') {
        scannerRawInputRef.current = ''
        if (scannerRawInputTimerRef.current) {
          clearTimeout(scannerRawInputTimerRef.current)
          scannerRawInputTimerRef.current = null
        }
        playPosKeySound()
        pressKey('clear')
        return
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      if (scannerRawInputTimerRef.current) clearTimeout(scannerRawInputTimerRef.current)
    }
    // pressKey/addBySku/read of refs are stable enough for this listener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerLeftPanel, refundSession, refundPayoutOpen, exchangePayoutOpen, loyalty.cancelLoyaltyEntry, settingsObscured])

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
        accountCredit?: number
        houseAccountNumber?: string
        houseAccountName?: string
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
      /** Exchange slip: return and replacement sections with net settlement. */
      exchangePrintSlice?: {
        returnLines: Array<{ qty: number; name: string; unitPrice: number; listUnitPrice?: number; lineTotal: number }>
        newLines: Array<{ qty: number; name: string; unitPrice: number; listUnitPrice?: number; lineTotal: number }>
        returnTotal: number
        newTotal: number
        netAmount: number
        cashPaidIn?: number
        cashPaidOut?: number
        storeCreditIssued?: number
      }
      exchangeAck?: {
        returnTotal: number
        newTotal: number
        netAmount: number
        cashPaidIn: number
        cashPaidOut: number
        storeCreditIssued?: number
        storeCreditPhoneDisplay?: string
        note?: string
      }
    },
  ): {
    transport: unknown
    receipt: unknown
  } & ReceiptPrintOpts {
    const cfg = printerSettings.receiptConfig
    const ts = sale.createdAt ?? new Date().toISOString()
    const slice = opts?.refundPrintSlice
    const exchangeSlice = opts?.exchangePrintSlice

    type ReceiptRow = {
      qty: number
      name: string
      unitPrice: number
      listUnitPrice?: number
      lineTotal: number
    }

    function mapPrintRow(l: {
      qty: number
      name: string
      unitPrice: number
      listUnitPrice?: number
      lineTotal: number
    }): ReceiptRow {
      return {
        qty: l.qty,
        name: l.name,
        unitPrice: l.unitPrice,
        listUnitPrice: l.listUnitPrice,
        lineTotal: l.lineTotal,
      }
    }

    function saleLineToReceiptRow(l: SaleLine) {
      return {
        qty: l.quantity,
        name: l.name,
        unitPrice: l.unitPrice,
        listUnitPrice: l.listUnitPrice,
        lineTotal: l.lineTotal ?? roundCartMoney(l.quantity * l.unitPrice),
      }
    }

    let receiptLines: ReceiptRow[]
    let lineItemSections: Array<{ heading: string; lines: ReceiptRow[]; sectionSubtotal: number }> | undefined

    if (exchangeSlice) {
      receiptLines = []
      lineItemSections = [
        {
          heading: 'RETURNING',
          lines: exchangeSlice.returnLines.map(mapPrintRow),
          sectionSubtotal: exchangeSlice.returnTotal,
        },
        {
          heading: 'RECEIVING',
          lines: exchangeSlice.newLines.map(mapPrintRow),
          sectionSubtotal: exchangeSlice.newTotal,
        },
      ]
    } else if (slice) {
      receiptLines = slice.lines.map(mapPrintRow)
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
    const loyaltyDiscountAmt = exchangeSlice || slice ? 0 : Math.max(0, Number(sale.loyaltyDiscountAmount ?? 0))
    const merchandiseTotal = exchangeSlice
      ? exchangeSlice.netAmount
      : slice
        ? slice.refundTotal
        : (sale.total ?? gross)
    const lineDiscountTotal = exchangeSlice || slice ? 0 : Math.max(0, gross - merchandiseTotal)
    const cashRoundingAdj = exchangeSlice || slice ? 0 : Number(sale.cashRoundingAdjustment ?? 0)
    const totalBeforeRounding = exchangeSlice
      ? exchangeSlice.netAmount
      : slice
        ? slice.refundTotal
        : round2(Math.max(0, gross - loyaltyDiscountAmt))
    const total = exchangeSlice
      ? round2(Math.abs(exchangeSlice.netAmount))
      : slice
        ? slice.refundTotal
        : round2(totalBeforeRounding + cashRoundingAdj)
    const discountTotal =
      lineDiscountTotal + loyaltyDiscountAmt > 0.005 ? round2(lineDiscountTotal + loyaltyDiscountAmt) : undefined
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

    const tendered = exchangeSlice || slice ? undefined : sale.payment?.tenderedCash
    const changeDue = exchangeSlice || slice ? undefined : sale.payment?.changeDue

    const onAccountAmt = exchangeSlice || slice ? 0 : (sale.onAccountAmount ?? 0)
    const accountAck =
      onAccountAmt > 0.005
        ? {
            accountNumber: sale.houseAccountNumber?.trim() || '—',
            accountName: sale.houseAccountName?.trim(),
            amount: onAccountAmt,
            purchaseOrderNumber: sale.purchaseOrderNumber?.trim(),
          }
        : undefined

    const cashAmt = exchangeSlice || slice ? 0 : Number(sale.payment?.cashAmount ?? 0)
    const cardAmt = exchangeSlice || slice ? 0 : Number(sale.payment?.cardAmount ?? 0)
    const voucherAmt = exchangeSlice || slice ? 0 : Number(sale.storeCreditAmount ?? 0)
    const loyaltyAmt = exchangeSlice || slice ? 0 : loyaltyDiscountAmt
    const loyaltyPts = exchangeSlice || slice ? 0 : Math.max(0, Math.floor(Number(sale.loyaltyPointsRedeemed ?? 0)))
    const loyaltyPtsEarned = exchangeSlice || slice ? 0 : Math.max(0, Math.floor(Number(sale.loyaltyPointsEarned ?? 0)))
    const loyaltyPhoneDisplay =
      !exchangeSlice &&
      !slice &&
      ((typeof sale.loyaltyPhoneMasked === 'string' && sale.loyaltyPhoneMasked.trim()) ||
        (typeof sale.loyaltyPhone === 'string' && sale.loyaltyPhone.trim()))
        ? (sale.loyaltyPhoneMasked?.trim() ||
            maskPhoneForReceipt(typeof sale.loyaltyPhone === 'string' ? sale.loyaltyPhone : ''))
        : null
    const tenderKindCount = exchangeSlice || slice
      ? 0
      : [cashAmt > 0.005, cardAmt > 0.005, voucherAmt > 0.005, loyaltyAmt > 0.005].filter(Boolean).length
    const paymentTenders =
      tenderKindCount >= 2
        ? {
            ...(cashAmt > 0.005 ? { cash: cashAmt } : {}),
            ...(cardAmt > 0.005 ? { card: cardAmt } : {}),
            ...(voucherAmt > 0.005 ? { storeVoucher: voucherAmt } : {}),
            ...(loyaltyAmt > 0.005 ? { loyalty: loyaltyAmt } : {}),
          }
        : undefined
    const loyaltyAck =
      loyaltyPhoneDisplay && (loyaltyPts > 0 || loyaltyAmt > 0.005 || loyaltyPtsEarned > 0)
        ? {
            phoneDisplay: loyaltyPhoneDisplay,
            ...(loyaltyPts > 0 && loyaltyAmt > 0.005 ? { pointsRedeemed: loyaltyPts, amount: loyaltyAmt } : {}),
            ...(loyaltyPtsEarned > 0 ? { pointsEarned: loyaltyPtsEarned } : {}),
            ...(typeof sale.loyaltyPointsBalanceAfter === 'number'
              ? { balanceAfter: sale.loyaltyPointsBalanceAfter }
              : {}),
          }
        : undefined
    const storeVoucherAck =
      !exchangeSlice && !slice && voucherAmt > 0.005
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

    const receiptNumber = sale.saleId ?? sale._id.slice(-8)
    const isNormalSaleReceipt =
      !opts?.refundPrintSlice &&
      !opts?.exchangePrintSlice &&
      !opts?.refundAck &&
      !opts?.exchangeAck &&
      opts?.receiptNumberPrefix == null
    const saleReceiptBarcode = isNormalSaleReceipt
      ? receiptNumber.replace(/[^0-9A-Za-z]/g, '').toUpperCase() || undefined
      : undefined

    return {
      transport: printerSettings.transport,
      ...receiptPrintOpts(printerSettings),
      receipt: {
        headerLines: [cfg.headerLine1, cfg.headerLine2, cfg.headerLine3],
        phone: cfg.phone,
        vatNumber: cfg.vatNumber,
        receiptTitle: opts?.receiptTitle ?? cfg.receiptTitle,
        receiptNumberPrefix: opts?.receiptNumberPrefix,
        cashierName: resolveCashierDisplayName(session?.user),
        cashierSignInLabel:
          cashierSignInMethodLabel(sale.cashierSignInMethod ?? session?.signInMethod) || undefined,
        tillNumber: POS_TILL_CODE,
        tillLabel: cfg.tillLabel,
        slipLabel: cfg.slipLabel,
        receiptNumber,
        ...(saleReceiptBarcode ? { barcodeValue: saleReceiptBarcode, barcodeCompact: true } : {}),
        timestampIso: ts,
        paymentLabel,
        copyLabel: opts?.copyLabel,
        ...(paymentTenders ? { paymentTenders } : {}),
        ...(storeVoucherAck ? { storeVoucherAck } : {}),
        ...(loyaltyAck ? { loyaltyAck } : {}),
        accountChargeAck: accountAck,
        refundAck: opts?.refundAck,
        exchangeAck: opts?.exchangeAck,
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
        discountTotal: (discountTotal ?? 0) > 0.005 ? discountTotal : undefined,
        cashRoundingAdjustment: Math.abs(cashRoundingAdj) > 0.005 ? cashRoundingAdj : undefined,
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
      const r = await window.electronPos.printReceipt(printerSettings.transport, receipt, receiptPrintOpts(printerSettings))
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
      const r = await window.electronPos.printReceipt(p.transport, p.receipt, receiptPrintOpts(printerSettings))
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
      reversedOnAccount?: number
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
    const accountCredit = Math.max(0, Number(printSlice?.reversedOnAccount ?? 0))
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
        ...(accountCredit > 0.005
          ? {
              accountCredit,
              houseAccountNumber: sale.houseAccountNumber?.trim(),
              houseAccountName: sale.houseAccountName?.trim(),
            }
          : {}),
        note: ackNoteParts.join(' · '),
      },
    })
    if (settings.autoOpenDrawer && (refundCash > 0.005 || refundCard > 0.005)) {
      const d = await kickCashDrawerIfConfigured(settings)
      if (!d.ok) return { ok: false, error: d.error ?? 'Refund saved, but drawer failed to open' }
    }
    const r = await window.electronPos.printReceipt(p.transport, p.receipt, {
      columns: p.columns,
      cut: p.cut,
      printDensity: p.printDensity,
      lineSpacing: p.lineSpacing,
      headerBold: p.headerBold,
      skipHardwareLeftMargin: p.skipHardwareLeftMargin,
    })
    if (!r.ok) return { ok: false, error: r.error ?? 'Refund receipt print failed' }
    return { ok: true }
  }

  async function printManualReturnReceipt(
    result: ManualReturnResult,
    lines: Array<{ qty: number; name: string; unitPrice: number; lineTotal: number }>,
    payoutMethod: 'cash' | 'card' | 'store_credit',
    note: string,
    storeCreditPhoneDigits?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!window.electronPos) return { ok: true }
    const settings = readPosPrinterSettings()
    const cfg = settings.receiptConfig
    const total = result.returnTotal
    const returnCash = payoutMethod === 'cash' ? total : 0
    const returnCard = payoutMethod === 'card' ? total : 0
    const returnStoreCredit = payoutMethod === 'store_credit' ? total : 0
    const payoutLabel =
      payoutMethod === 'store_credit' ? 'Store credit' : payoutMethod === 'card' ? 'Card' : 'Cash'
    const digitsForMask = storeCreditPhoneDigits?.replace(/\D/g, '') ?? ''
    const storeCreditPhoneDisplay =
      returnStoreCredit > 0.005 && digitsForMask ? maskPhoneForReceipt(digitsForMask) : undefined
    const receipt = {
      headerLines: [cfg.headerLine1, cfg.headerLine2, cfg.headerLine3],
      phone: cfg.phone,
      vatNumber: cfg.vatNumber,
      receiptTitle: 'MANUAL RETURN',
      receiptNumberPrefix: 'Return',
      receiptNumber: result.returnId,
      cashierName: resolveCashierDisplayName(session?.user),
      tillNumber: POS_TILL_CODE,
      tillLabel: cfg.tillLabel,
      slipLabel: cfg.slipLabel,
      timestampIso: new Date().toISOString(),
      paymentLabel: payoutMethod === 'store_credit' ? 'Return (store credit)' : 'Manual return',
      copyLabel: 'MANUAL RETURN',
      lines,
      subtotal: total,
      total,
      totalDueLabel: 'RETURN TOTAL:',
      thankYouLine: 'PLEASE SIGN BELOW',
      refundAck: {
        refundTotal: total,
        refundCash: returnCash,
        refundCard: returnCard,
        refundStoreCredit: returnStoreCredit > 0.005 ? returnStoreCredit : undefined,
        ...(storeCreditPhoneDisplay && storeCreditPhoneDisplay !== '—'
          ? { storeCreditPhoneDisplay }
          : {}),
        note: [note.trim(), 'No original sale record', `Payout: ${payoutLabel}`].filter(Boolean).join(' · '),
      },
    }
    if (settings.autoOpenDrawer && (returnCash > 0.005 || returnCard > 0.005)) {
      const d = await kickCashDrawerIfConfigured(settings)
      if (!d.ok) return { ok: false, error: d.error ?? 'Return saved, but drawer failed to open' }
    }
    const r = await window.electronPos.printReceipt(
      settings.transport,
      receipt,
      receiptPrintOpts(settings),
    )
    if (!r.ok) return { ok: false, error: r.error ?? 'Return receipt print failed' }
    return { ok: true }
  }

  async function printExchangeReceiptToDevice(
    sale: Sale,
    note?: string,
    printSlice?: {
      returnLines: Array<{ qty: number; name: string; unitPrice: number; listUnitPrice?: number; lineTotal: number }>
      newLines: Array<{ qty: number; name: string; unitPrice: number; listUnitPrice?: number; lineTotal: number }>
      returnTotal: number
      newTotal: number
      netAmount: number
      cashPaidIn?: number
      cashPaidOut?: number
      storeCreditIssued?: number
      storeCreditPhoneDigits?: string
    },
  ): Promise<{ ok: boolean; error?: string; payload?: ReceiptPrintPayload }> {
    if (!printSlice) return { ok: true }
    const settings = readPosPrinterSettings()
    const net = printSlice.netAmount
    const paymentLabel =
      Math.abs(net) <= 0.005
        ? 'Even exchange'
        : net > 0.005
          ? 'Customer pays cash'
          : (printSlice.storeCreditIssued ?? 0) > 0.005
            ? 'Store credit issued'
            : 'Cash paid out'
    const digitsForMask = printSlice.storeCreditPhoneDigits?.replace(/\D/g, '') ?? ''
    const storeCreditPhoneDisplay =
      (printSlice.storeCreditIssued ?? 0) > 0.005 && digitsForMask
        ? maskPhoneForReceipt(digitsForMask)
        : undefined
    const p = receiptPayloadFromSale(sale, {
      copyLabel: 'EXCHANGE',
      receiptTitle: 'EXCHANGE RECEIPT',
      receiptNumberPrefix: 'Exchange',
      totalDueLabel: net >= -0.005 ? 'NET DUE:' : 'CREDIT TO CUSTOMER:',
      paymentLabelOverride: paymentLabel,
      thankYouLine: 'PLEASE SIGN BELOW',
      exchangePrintSlice: printSlice,
      exchangeAck: {
        returnTotal: printSlice.returnTotal,
        newTotal: printSlice.newTotal,
        netAmount: printSlice.netAmount,
        cashPaidIn: printSlice.cashPaidIn ?? 0,
        cashPaidOut: printSlice.cashPaidOut ?? 0,
        storeCreditIssued: printSlice.storeCreditIssued,
        ...(storeCreditPhoneDisplay && storeCreditPhoneDisplay !== '—'
          ? { storeCreditPhoneDisplay }
          : {}),
        note: note?.trim(),
      },
    })
    if (settings.autoOpenDrawer && ((printSlice.cashPaidOut ?? 0) > 0.005 || (printSlice.cashPaidIn ?? 0) > 0.005)) {
      const d = await kickCashDrawerIfConfigured(settings)
      if (!d.ok) return { ok: false, error: d.error ?? 'Exchange saved, but drawer failed to open', payload: p }
    }
    if (!window.electronPos) return { ok: true, payload: p }
    const r = await window.electronPos.printReceipt(p.transport, p.receipt, {
      columns: p.columns,
      cut: p.cut,
      printDensity: p.printDensity,
      lineSpacing: p.lineSpacing,
      headerBold: p.headerBold,
      skipHardwareLeftMargin: p.skipHardwareLeftMargin,
    })
    if (!r.ok) return { ok: false, error: r.error ?? 'Exchange receipt print failed', payload: p }
    return { ok: true, payload: p }
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
      ...receiptPrintOpts(printerSettings),
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
    if (input.method === 'cash') {
      const d = await kickCashDrawerIfConfigured(printerSettings)
      if (!d.ok) return { ok: false, error: d.error ?? 'Drawer failed to open', payload: p }
    }
    const r = await window.electronPos.printReceipt(p.transport, p.receipt, {
      columns: p.columns,
      cut: p.cut,
      printDensity: p.printDensity,
      lineSpacing: p.lineSpacing,
      headerBold: p.headerBold,
      skipHardwareLeftMargin: p.skipHardwareLeftMargin,
    })
    if (!r.ok) return { ok: false, error: r.error ?? 'Account payment receipt print failed', payload: p }
    return { ok: true, payload: p }
  }

  async function printOfflineReconciliationListToDevice(): Promise<{ ok: boolean; error?: string }> {
    if (offlineReconcileItems.length === 0) return { ok: true }
    const cfg = printerSettings.receiptConfig
    const totalUnits = offlineReconcileItems.reduce((sum, item) => sum + item.qty, 0)
    const payload = {
      transport: printerSettings.transport,
      ...receiptPrintOpts(printerSettings),
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
      printDensity: payload.printDensity,
      lineSpacing: payload.lineSpacing,
      headerBold: payload.headerBold,
      skipHardwareLeftMargin: payload.skipHardwareLeftMargin,
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
      ...receiptPrintOpts(printerSettings),
      receipt: {
        headerLines: [],
        receiptTitle: 'SHIFT Z REPORT',
        receiptNumberPrefix: 'Shift',
        receiptNumber: String(report.shiftId).slice(-8),
        cashierName: resolveCashierDisplayName(session?.user),
        tillNumber: report.tillCode,
        tillLabel: cfg.tillLabel,
        slipLabel: cfg.slipLabel,
        timestampIso: new Date().toISOString(),
        paymentLabel: 'Shift summary',
        lines: [],
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
      printDensity: payload.printDensity,
      lineSpacing: payload.lineSpacing,
      headerBold: payload.headerBold,
      skipHardwareLeftMargin: payload.skipHardwareLeftMargin,
    })
  }

  function receiptPayloadFromQuote(q: QuoteDetail): {
    transport: unknown
    receipt: unknown
  } & ReceiptPrintOpts {
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
      ...receiptPrintOpts(printerSettings),
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
      const r = await window.electronPos.printReceipt(p.transport, p.receipt, receiptPrintOpts(printerSettings))
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
        const copies = last.payloads ?? [last.payload]
        if (!window.electronPos) {
          setNotice(last.successNotice ?? 'Receipt printed (web preview)')
          return
        }
        for (const p of copies) {
          const r = await window.electronPos.printReceipt(p.transport, p.receipt, {
            columns: p.columns,
            cut: p.cut,
            printDensity: p.printDensity,
            lineSpacing: p.lineSpacing,
            headerBold: p.headerBold,
            skipHardwareLeftMargin: p.skipHardwareLeftMargin,
          })
          if (!r.ok) {
            setError(r.error ?? 'Receipt print failed')
            return
          }
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
      const pm = (sale.paymentMethod ?? '').toLowerCase()
      if (settings.autoOpenDrawer && pm !== 'on_account') {
        await kickCashDrawerIfConfigured(settings)
      }
      if (settings.autoPrintReceipt && receiptEnabled) {
        await printSaleReceiptsToDevice(sale)
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

  async function printHouseAccountStatementToDevice(account: HouseAccountRow): Promise<{ ok: boolean; error?: string }> {
    if (!window.electronPos?.printHouseAccountStatement) {
      return { ok: false, error: 'Statement print is only available on the POS app' }
    }
    const settings = readPosPrinterSettings()
    setError(null)
    setNotice(null)
    try {
      const statement = await apiFetch<HouseAccountStatement>(
        `/house-accounts/${encodeURIComponent(account._id)}/statement`,
      )
      const r = await window.electronPos.printHouseAccountStatement(
        settings.transport,
        statement,
        receiptPrintOpts(settings),
      )
      if (!r.ok) return { ok: false, error: r.error ?? 'Statement print failed' }
      setNotice(`Statement printed for ${account.accountNumber}`)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Statement print failed' }
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
    <div
      className={`register-viewport${refundSession ? ' register-viewport--refund-mode' : ''}${exchangeSession ? ' register-viewport--exchange-mode' : ''}${manualReturnActive ? ' register-viewport--manual-return-mode' : ''}${settingsObscured ? ' register-viewport--obscured' : ''}`}
      aria-hidden={settingsObscured || undefined}
    >
      <PosShell
        headerBanner={heldSaleHeaderBanner}
        settingsDisabled={cart.length > 0}
        beforeSignOut={() => {
          if (cart.length > 0) {
            setNotice('Clear the cart or complete the sale before signing out.')
            return false
          }
          return true
        }}
      >
        {!catalogReady ? (
          <div className="register-catalog-loader" role="status" aria-live="polite" aria-busy="true">
            <p className="register-catalog-loader-text">Loading catalog…</p>
          </div>
        ) : null}
        {catalogReady && catalogRefreshing ? (
          <p className="register-catalog-refresh-banner muted" role="status" aria-live="polite">
            Updating catalog…
          </p>
        ) : null}
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
          {exchangeSession ? (
            <div className="register-refund-banner register-exchange-banner" role="status" aria-live="polite">
              <span className="register-refund-banner-badge">Exchange</span>
              <span className="register-refund-banner-meta">
                Sale{' '}
                <strong>{exchangeSession.previewSale.saleId ?? exchangeSession.previewSale._id.slice(-10)}</strong>
                {exchangeSession.previewSale.createdAt ? (
                  <>
                    {' '}
                    · {formatDateDdMmYyyy(exchangeSession.previewSale.createdAt)}
                  </>
                ) : null}
                {' · '}
                Returned R {exchangeSession.returnPreview.refundedTotal.toFixed(2)} · Remaining R{' '}
                {exchangeSession.returnPreview.remainingTotal.toFixed(2)}
                {!exchangeSession.eligibility.eligible ? (
                  <>
                    {' · '}
                    <strong>Outside {exchangeSession.eligibility.maxDays}-day window</strong>
                  </>
                ) : null}
              </span>
              <button type="button" className="btn ghost small register-refund-banner-exit" onClick={exitExchangeModePrompt}>
                Exit exchange
              </button>
            </div>
          ) : null}
          {manualReturnActive ? (
            <div className="register-refund-banner register-manual-return-banner" role="status" aria-live="polite">
              <span className="register-refund-banner-badge">Manual return</span>
              <span className="register-refund-banner-meta">
                No original sale record · scan items to return · <strong>admin only</strong>
              </span>
              <button
                type="button"
                className="btn ghost small register-refund-banner-exit"
                onClick={() => void exitManualReturnModePrompt()}
              >
                Exit manual return
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
                  onClick={() => {
                    startTransition(() => {
                      setRegisterLeftPanel((m) => {
                        if (m === 'list') {
                          setFilter('')
                          return 'keys'
                        }
                        return 'list'
                      })
                    })
                  }}
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
                <div
                  className={`sku-display${loyalty.loyaltyEntryActive ? ' sku-display--loyalty-entry' : ''}`}
                  title={
                    loyalty.loyaltyEntryActive
                      ? 'Loyalty phone entry on customer display — register keys paused'
                      : 'SKU, or qty×SKU then ENTER'
                  }
                >
                  {loyalty.loyaltyEntryActive ? (
                    <span className="sku-display-loyalty-hint">
                      Enter phone on the customer display — register keypad paused
                    </span>
                  ) : (
                    <>
                      <span className="muted">&nbsp;</span>
                      <strong>{skuInput}</strong>
                    </>
                  )}
                </div>
                <div
                  className={`keys-buttons-wrap${loyalty.loyaltyEntryActive ? ' keys-buttons-wrap--loyalty-paused' : ''}`}
                >
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
                        disabled={!!switchSaleBlockedReason()}
                        title={
                          switchSaleBlockedReason() ??
                          (parkedSaleLineCount > 0
                            ? `Switch between this sale and held sale (${parkedSaleLineCount} line${parkedSaleLineCount === 1 ? '' : 's'})`
                            : 'Hold this sale and serve another customer')
                        }
                        onClick={() => toggleHoldSale()}
                      >
                        HOLD SALE
                      </button>
                      <button
                        type="button"
                        className="key-btn key-btn-fn"
                        disabled={!!refundSession || !!exchangeSession}
                        title={refundSession ? 'Finish refund first' : exchangeSession ? 'Finish exchange first' : undefined}
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
                              : exchangeSession
                                ? 'Finish exchange first'
                                : manualReturnActive
                                  ? 'Finish manual return first'
                                  : 'Refund — enter sale id from receipt'
                          }
                          disabled={!!exchangeSession || !!manualReturnActive}
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
                      {canManualReturnPos ? (
                        <button
                          type="button"
                          className="key-btn key-btn-fn"
                          title={
                            manualReturnActive
                              ? 'Leave manual return mode (cart will clear)'
                              : refundSession
                                ? 'Finish refund first'
                                : exchangeSession
                                  ? 'Finish exchange first'
                                  : 'Return without sale record (admin)'
                          }
                          disabled={!!refundSession || !!exchangeSession}
                          onClick={() => {
                            if (manualReturnActive) {
                              void exitManualReturnModePrompt()
                              return
                            }
                            if (activeOpenTabId) {
                              setError('Close or complete the open tab before manual return')
                              return
                            }
                            if (cart.length > 0) {
                              setError('Clear the cart before manual return')
                              return
                            }
                            beginManualReturnMode()
                          }}
                        >
                          {manualReturnActive ? 'EXIT RETURN' : 'NO-SALE RETURN'}
                        </button>
                      ) : null}
                      {canExchange ? (
                        <button
                          type="button"
                          className="key-btn key-btn-fn"
                          title={
                            exchangeSession
                              ? 'Leave exchange mode (cart will clear)'
                              : refundSession
                                ? 'Finish refund first'
                                : 'Exchange — return items and add replacements'
                          }
                          disabled={!!refundSession || !!manualReturnActive}
                          onClick={() => {
                            if (exchangeSession) {
                              exitExchangeModePrompt()
                              return
                            }
                            if (activeOpenTabId) {
                              setError('Close or complete the open tab before exchange')
                              return
                            }
                            if (cart.length > 0) {
                              setError('Clear the cart or complete the sale before exchange')
                              return
                            }
                            setExchangeSaleIdModalOpen(true)
                          }}
                        >
                          {exchangeSession ? 'EXIT EXCHANGE' : 'EXCHANGE'}
                        </button>
                      ) : null}
                      {canShiftEnd ? (
                        <button
                          type="button"
                          className="key-btn key-btn-fn"
                          disabled={!!refundSession || !!exchangeSession}
                          title={refundSession ? 'Finish refund first' : exchangeSession ? 'Finish exchange first' : 'Print Z report, then continue or close shift'}
                          onClick={() => setShiftEndModalOpen(true)}
                        >
                          SHIFT END
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="key-btn key-btn-fn"
                        disabled={!!refundSession || !!exchangeSession}
                        title={refundSession ? 'Finish refund first' : exchangeSession ? 'Finish exchange first' : 'House accounts payments'}
                        onClick={openHouseAccountsForPayment}
                      >
                        ACCOUNTS
                      </button>
                      <button
                        type="button"
                        className="key-btn key-btn-fn"
                        disabled={!!activeOpenTabId || !!refundSession || !!exchangeSession}
                        title={
                          refundSession
                            ? 'Finish refund first'
                            : exchangeSession
                              ? 'Finish exchange first'
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
                        disabled={!!activeOpenTabId || !!refundSession || !!exchangeSession || offlineCatalogMode}
                        title={
                          offlineCatalogMode
                            ? 'Lay-by unavailable while offline'
                            : refundSession
                              ? 'Finish refund first'
                              : exchangeSession
                                ? 'Finish exchange first'
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
                        onClick={() =>
                          setReceiptEnabled((v) => {
                            const next = !v
                            writeRegisterReceiptEnabled(next)
                            return next
                          })
                        }
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
                            ? 'Reprint last receipt (sale, lay-by payment, or account payment)'
                            : 'Complete a transaction to enable reprint'
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
                  {itemListDisplay.catalogSize > 0
                    ? `${itemListDisplay.catalogSize.toLocaleString()} products — type at least ${ITEM_LIST_SEARCH_MIN} characters to search. Tap a row to add; long-press for Presets (up to ${PRESET_ENTRY_MAX}).`
                    : 'No products loaded.'}
                </p>
                {itemListDisplay.mode === 'need-search' && itemListDisplay.catalogSize > 0 ? (
                  <p className="muted item-list-search-prompt">
                    Use the search box or on-screen keyboard to find items. SKU scan on the register keys still works
                    for the full catalog.
                  </p>
                ) : null}
                {itemListDisplay.mode === 'results' && itemListDisplay.capped ? (
                  <p className="muted item-list-search-prompt">
                    Showing first {ITEM_LIST_MAX_ROWS} matches — refine your search.
                  </p>
                ) : null}
                <div className="product-browser">
                  <ul className="product-list">
                    {itemListDisplay.rows.map((p) => (
                      <ProductListRow
                        key={p._id}
                        product={p}
                        offlineCatalogMode={offlineCatalogMode}
                        serverReachable={serverReachable}
                        isAdmin={isAdmin}
                        onAdd={onProductRowClick}
                        onAssignPreset={setAssignPresetProduct}
                        onPointerDown={onProductRowPointerDown}
                        onPointerMove={onProductRowPointerMove}
                        onPointerUp={onProductRowPointerUp}
                        onPointerCancel={onProductRowPointerCancel}
                        onShowPhoto={(prod) => {
                          setProductPhotoError(null)
                          setProductPhotoViewer(prod)
                        }}
                      />
                    ))}
                  </ul>
                  {itemListDisplay.mode === 'results' && itemListDisplay.rows.length === 0 ? (
                    <p className="muted empty-hint empty-hint-products">No matching products.</p>
                  ) : null}
                  {itemListDisplay.catalogSize === 0 ? (
                    <p className="muted empty-hint empty-hint-products">
                      No products. Add some in Back Office (admin).
                    </p>
                  ) : null}
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
                  {lastLoyaltyDiscount != null && lastLoyaltyDiscount > 0.005 ? (
                    <div>
                      Loyalty: <strong>−{lastLoyaltyDiscount.toFixed(2)}</strong>
                      {lastLoyaltyPoints != null && lastLoyaltyPoints > 0
                        ? ` (${lastLoyaltyPoints.toLocaleString()} pts)`
                        : ''}
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
                    {loyalty.loyaltyDiscount > 0.005 ? (
                      <div>
                        Loyalty: <strong>−{loyalty.loyaltyDiscount.toFixed(2)}</strong> ({loyalty.loyaltyPointsRedeem} pts)
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
                              {paymentTermsShortLabel(houseAccountForCheckout.paymentTerms)
                                ? ` · ${paymentTermsShortLabel(houseAccountForCheckout.paymentTerms)}`
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
                <h2>
                  {refundSession
                    ? 'Refund cart'
                    : exchangeSession
                      ? 'Exchange cart'
                      : manualReturnActive
                        ? 'Return cart'
                        : 'Cart'}
                </h2>
                <div
                  className={`cart-body${
                    refundSession && refundCartScreenKbOpen && refundPayoutOpen ? ' cart-body--refund-kb-open' : ''
                  }${exchangeSession && refundCartScreenKbOpen && exchangePayoutOpen ? ' cart-body--refund-kb-open' : ''}${
                    refundSession ? ' cart-body--refund-select' : ''
                  }${exchangeSession ? ' cart-body--refund-select cart-body--exchange-build' : ''}`}
                >
                  {cart.length === 0 ? (
                    <p className="muted empty-hint cart-empty-msg">
                      {refundSession
                        ? 'No refundable lines left on this sale.'
                        : exchangeSession
                          ? 'Adjust return quantities and add replacement items.'
                          : 'Tap a product to add.'}
                    </p>
                  ) : (
                    <>
                      {refundSession ? (
                        <p className="muted small register-refund-select-hint" role="note">
                          Tap <strong>−</strong> to remove items the customer is keeping, or reduce quantity on a line.
                        </p>
                      ) : null}
                      {exchangeSession ? (
                        <p className="muted small register-refund-select-hint" role="note">
                          Adjust return quantities with <strong>− / +</strong>, then add replacement items from the list.
                        </p>
                      ) : null}
                    <div className="cart-lines" ref={cartLinesScrollRef}>
                      {cart.map((l, i) => {
                        const lineProduct = productsById.get(l.productId)
                        const jobCardLabourActive = !refundSession && activeTabBanner?.kind === 'job_card'
                        const lineJobLabour = jobCardLabourActive
                          ? jobCardLabourAmountForLine(lineProduct, l.quantity)
                          : 0
                        const disc = lineDiscountDisplay(l)
                        const vol = l.volumeSegments && l.volumeSegments.length > 0
                        const volShowAvg = (l.volumeSegments?.length ?? 0) > 1
                        const refundMax = l.refundQtyMax
                        const isExchangeReturn =
                          exchangeSession && l.refundSaleLineIndex != null && l.quantity > 0.005
                        return (
                        <div
                          className={`cart-line${isExchangeReturn ? ' cart-line--exchange-return' : ''}`}
                          data-cart-line-key={cartLineDomKey(l)}
                          key={l.refundSaleLineIndex != null ? `refund-${l.refundSaleLineIndex}` : `cart-${i}`}
                        >
                          <div className="cart-line-info">
                            <span className="cart-line-name">
                              {isExchangeReturn ? (
                                <span className="cart-line-role-badge cart-line-role-badge--return">Return</span>
                              ) : null}
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
                                {exchangeSession ? 'Return qty' : 'Refund qty'} (max {refundMax.toFixed(2)})
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
                    </>
                  )}
                </div>
                <div className="cart-footer">
                  {(error || notice || lastSale || offlinePendingCount > 0 || catalogError) && (
                    <div className="cart-messages cart-messages--footer-top">
                      {(error || catalogError) && <p className="error">{error ?? catalogError}</p>}
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
                  {cart.length > 0 && !refundSession && !exchangeSession ? (
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
                                {paymentTermsShortLabel(houseAccountForCheckout.paymentTerms)
                                  ? ` · ${paymentTermsShortLabel(houseAccountForCheckout.paymentTerms)}`
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
                  {!refundSession && !exchangeSession && !showChangeView && cart.length > 0 && loyalty.loyaltyProgram?.enabled ? (
                    <button
                      type="button"
                      className={`btn ghost small register-loyalty-open-btn${
                        loyalty.loyaltyMasked || loyalty.loyaltyEntryActive
                          ? ' register-loyalty-open-btn--active'
                          : ''
                      }`}
                      disabled={busy}
                      onClick={openLoyaltyModal}
                    >
                      {loyalty.loyaltyEntryActive
                        ? 'Loyalty — entering phone on display…'
                        : loyalty.loyaltyMasked
                          ? `Loyalty ${loyalty.loyaltyMasked}${
                              loyalty.loyaltyDiscount > 0.005
                                ? ` · −R ${loyalty.loyaltyDiscount.toFixed(2)}`
                                : ` · ${loyalty.loyaltyBalance.toLocaleString()} pts`
                            }`
                          : 'Loyalty'}
                    </button>
                  ) : null}
                  <div className="total">
                    {refundSession ? (
                      <>
                        Refund total <strong className="total-amount">{cartTotal.toFixed(2)}</strong>
                      </>
                    ) : manualReturnActive ? (
                      <>
                        Return total <strong className="total-amount">{cartTotal.toFixed(2)}</strong>
                      </>
                    ) : exchangeSession ? (
                      <div className="cart-total-stack">
                        <div className="cart-total-row muted">
                          <span>Return value</span>
                          <span>−{exchangeReturnTotal.toFixed(2)}</span>
                        </div>
                        {exchangeHasReplacements ? (
                          <>
                            <div className="cart-total-row muted">
                              <span>Replacement value</span>
                              <span>{exchangeNewTotal.toFixed(2)}</span>
                            </div>
                            <div className="cart-total-row cart-total-row--due">
                              <span>{exchangeNetAmount >= -0.005 ? 'Net due' : 'Credit to customer'}</span>
                              <strong className="total-amount">{Math.abs(exchangeNetAmount).toFixed(2)}</strong>
                            </div>
                          </>
                        ) : (
                          <p className="muted small register-exchange-build-hint">
                            Add replacement items from the list to see the net balance.
                          </p>
                        )}
                      </div>
                    ) : loyalty.loyaltyDiscount > 0.005 || cartCheckout.showCashPayableHint ? (
                      <div className="cart-total-stack">
                        {loyalty.loyaltyDiscount > 0.005 ? (
                          <>
                            <div className="cart-total-row muted">
                              <span>Subtotal</span>
                              <span>{cartTotal.toFixed(2)}</span>
                            </div>
                            <div className="cart-total-row cart-total-row--loyalty">
                              <span>Loyalty</span>
                              <span>−{loyalty.loyaltyDiscount.toFixed(2)}</span>
                            </div>
                          </>
                        ) : null}
                        <div className="cart-total-row cart-total-row--due">
                          <span>Total</span>
                          <strong className="total-amount">{cartCheckout.displayTotal.toFixed(2)}</strong>
                        </div>
                        {cartCheckout.showCashPayableHint ? (
                          <div className="cart-total-row muted">
                            <span>Card</span>
                            <span>{cartCheckout.exactTotal.toFixed(2)}</span>
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <>
                        Total <strong className="total-amount">{cartCheckout.displayTotal.toFixed(2)}</strong>
                      </>
                    )}
                  </div>
                  <div
                    className={`cash-footer${refundSession || exchangeSession || manualReturnActive ? ' refund-cart-checkout-footer' : ''}`}
                  >
                    {manualReturnActive ? (
                      <button
                        type="button"
                        className="btn checkout-btn primary refund-continue-btn"
                        disabled={busy || cart.length === 0}
                        onClick={openManualReturnPayoutStep}
                      >
                        Continue to return · R {cartTotal.toFixed(2)}
                      </button>
                    ) : refundSession ? (
                      <button
                        type="button"
                        className="btn checkout-btn primary refund-continue-btn"
                        disabled={
                          busy ||
                          cart.length === 0 ||
                          refundSession.previewSale.refundStatus === 'refunded' ||
                          refundSession.refundPreview.remainingTotal <= 0.005
                        }
                        onClick={openRefundPayoutStep}
                      >
                        Continue to refund · R {cartTotal.toFixed(2)}
                      </button>
                    ) : exchangeSession ? (
                      <button
                        type="button"
                        className="btn checkout-btn primary refund-continue-btn"
                        disabled={
                          busy ||
                          cart.length === 0 ||
                          !cartReturnLines(cart).some((l) => l.quantity > 0.005) ||
                          !cartNewSaleLines(cart).some((l) => l.quantity > 0.005)
                        }
                        onClick={openExchangePayoutStep}
                      >
                        {exchangeHasReplacements
                          ? `Continue to exchange · R ${Math.abs(exchangeNetAmount).toFixed(2)}`
                          : 'Continue to exchange'}
                      </button>
                    ) : (
                      <>
                    <button
                      type="button"
                      className="btn checkout-btn cash-checkout-btn"
                      disabled={busy || cart.length === 0}
                      onClick={() => void checkoutCash()}
                    >
                      {busy ? 'Processing…' : 'Cash'}
                    </button>
                    <button
                      type="button"
                      className="btn checkout-btn card-checkout-btn"
                      disabled={busy || cart.length === 0}
                      onClick={() => void checkoutCard()}
                    >
                      {busy ? 'Processing…' : 'Card'}
                    </button>
                      </>
                    )}
                  </div>
                </div>
              </>
            )}
          </section>
        </div>
        </div>
        {refundPayoutOpen && refundSession ? (
          <div
            className="open-tabs-backdrop refund-payout-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="refund-payout-title"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget && !busy) closeRefundPayoutStep()
            }}
          >
            <div className="open-tabs-dialog refund-payout-dialog">
              <div className="open-tabs-header">
                <h2 id="refund-payout-title">Complete refund</h2>
                <button type="button" className="btn ghost open-tabs-close" disabled={busy} onClick={closeRefundPayoutStep}>
                  Back
                </button>
              </div>
              <div className={`quotes-modal-body${refundCartScreenKbOpen ? ' quotes-modal-body--with-keyboard' : ''}`}>
                <p className="refund-payout-total-line">
                  Refunding <strong>R {cartTotal.toFixed(2)}</strong>
                </p>
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
                <div className="refund-payout-actions">
                  <button
                    type="button"
                    className="btn checkout-btn cash-checkout-btn"
                    disabled={busy}
                    onClick={() => void submitRefundCheckout('cash')}
                  >
                    {busy ? 'Processing…' : 'Refund cash'}
                  </button>
                  <button
                    type="button"
                    className="btn checkout-btn card-checkout-btn"
                    disabled={busy}
                    onClick={() => void submitRefundCheckout('card')}
                  >
                    {busy ? 'Processing…' : 'Refund card'}
                  </button>
                </div>
                <div className="refund-payout-voucher-block">
                  <label className="register-refund-note-field">
                    <span className="muted small">Phone for refund voucher (store credit)</span>
                    <input
                      ref={refundPhoneInputRef}
                      className="register-refund-note-input"
                      type="tel"
                      inputMode={refundCartScreenKbOpen && refundCartKbTarget === 'phone' ? 'none' : 'numeric'}
                      autoComplete="tel"
                      value={refundCreditPhone}
                      onChange={(e) => setRefundCreditPhone(e.target.value)}
                      placeholder="Required for refund voucher only"
                      {...refundCartKbHandlers('phone')}
                    />
                  </label>
                  <p className="muted small register-refund-credit-hint">
                    Refund voucher credits the cash/card portion as store credit. Any voucher used on the original sale is
                    still restored automatically.
                  </p>
                  <button
                    type="button"
                    className="btn checkout-btn storecredit-checkout-btn refund-payout-voucher-btn"
                    disabled={busy}
                    onClick={() => void submitRefundCheckout('store_credit')}
                  >
                    {busy ? 'Processing…' : 'Refund voucher'}
                  </button>
                </div>
                <ScreenKeyboard
                  visible={refundCartScreenKbOpen}
                  layout={refundCartKbTarget === 'phone' ? 'numeric' : 'full'}
                  onAction={handleRefundCartScreenKeyboardAction}
                  className="open-tabs-screen-keyboard register-refund-cart-screen-kb"
                />
              </div>
            </div>
          </div>
        ) : null}
        {exchangePayoutOpen && exchangeSession ? (
          <div
            className="open-tabs-backdrop refund-payout-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="exchange-payout-title"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget && !busy) closeExchangePayoutStep()
            }}
          >
            <div className="open-tabs-dialog refund-payout-dialog">
              <div className="open-tabs-header">
                <h2 id="exchange-payout-title">Complete exchange</h2>
                <button type="button" className="btn ghost open-tabs-close" disabled={busy} onClick={closeExchangePayoutStep}>
                  Back
                </button>
              </div>
              <div className={`quotes-modal-body exchange-payout-body${refundCartScreenKbOpen ? ' quotes-modal-body--with-keyboard' : ''}`}>
                <div className="exchange-payout-scroll">
                  <div className="register-exchange-payout-summary">
                    <div className="cart-total-row muted">
                      <span>Return value</span>
                      <span>−{exchangeReturnTotal.toFixed(2)}</span>
                    </div>
                    <div className="cart-total-row muted">
                      <span>Replacement value</span>
                      <span>{exchangeNewTotal.toFixed(2)}</span>
                    </div>
                    <div className="cart-total-row cart-total-row--due">
                      <span>{exchangeNetAmount >= -0.005 ? 'Net due' : 'Credit to customer'}</span>
                      <strong>{Math.abs(exchangeNetAmount).toFixed(2)}</strong>
                    </div>
                  </div>
                  <label className="register-refund-note-field">
                    <span className="muted small">Exchange note (optional, audit)</span>
                    <textarea
                      ref={refundNoteInputRef}
                      className="register-refund-note-input"
                      rows={2}
                      value={exchangeNote}
                      onChange={(e) => setExchangeNote(e.target.value)}
                      placeholder="Reason or reference"
                      inputMode={refundCartScreenKbOpen && refundCartKbTarget === 'note' ? 'none' : 'text'}
                      {...refundCartKbHandlers('note')}
                    />
                  </label>
                  {exchangeSession && !exchangeSession.eligibility.eligible && isRoleAdmin(session?.user) ? (
                    <label
                      className="register-refund-note-field"
                      style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}
                    >
                      <input
                        type="checkbox"
                        checked={exchangeAdminBypass}
                        onChange={(e) => setExchangeAdminBypass(e.target.checked)}
                      />
                      <span className="muted small">
                        Admin bypass — allow exchange outside {exchangeSession.eligibility.maxDays}-day window
                      </span>
                    </label>
                  ) : null}
                </div>
                <ScreenKeyboard
                  visible={refundCartScreenKbOpen}
                  layout={refundCartKbTarget === 'phone' ? 'numeric' : 'full'}
                  onAction={handleRefundCartScreenKeyboardAction}
                  className="open-tabs-screen-keyboard register-refund-cart-screen-kb"
                />
                <div className="exchange-payout-settle">
                  {Math.abs(exchangeNetAmount) <= 0.005 ? (
                    <button
                      type="button"
                      className="btn checkout-btn primary refund-continue-btn"
                      disabled={busy}
                      onClick={() => void submitExchangeCheckout('even')}
                    >
                      {busy ? 'Processing…' : 'Complete exchange'}
                    </button>
                  ) : exchangeNetAmount > 0.005 ? (
                    <>
                      <p className="muted small register-exchange-cash-hint">
                        Enter tender on the <strong>register keypad</strong>, then confirm below. Amount due:{' '}
                        <strong>R {exchangeNetAmount.toFixed(2)}</strong>
                      </p>
                      <button
                        type="button"
                        className="btn checkout-btn cash-checkout-btn refund-continue-btn"
                        disabled={busy}
                        onClick={() => void submitExchangeCheckout('customer_pays_cash')}
                      >
                        {busy ? 'Processing…' : 'Customer pays cash'}
                      </button>
                    </>
                  ) : (
                    <>
                      <p className="refund-payout-total-line">
                        Pay customer <strong>R {Math.abs(exchangeNetAmount).toFixed(2)}</strong>
                      </p>
                      <div className="refund-payout-actions">
                        <button
                          type="button"
                          className="btn checkout-btn cash-checkout-btn"
                          disabled={busy}
                          onClick={() => void submitExchangeCheckout('customer_receives_cash')}
                        >
                          {busy ? 'Processing…' : 'Pay out cash'}
                        </button>
                      </div>
                      <div className="refund-payout-voucher-block">
                        <label className="register-refund-note-field">
                          <span className="muted small">Phone for store credit (exchange balance)</span>
                          <input
                            ref={refundPhoneInputRef}
                            className="register-refund-note-input"
                            type="tel"
                            inputMode={refundCartScreenKbOpen && refundCartKbTarget === 'phone' ? 'none' : 'numeric'}
                            autoComplete="tel"
                            value={exchangeCreditPhone}
                            onChange={(e) => setExchangeCreditPhone(e.target.value)}
                            placeholder="Required for store credit only"
                            {...refundCartKbHandlers('phone')}
                          />
                        </label>
                        <p className="muted small register-refund-credit-hint">
                          Issue the exchange balance as store credit on this phone number instead of cash from the till.
                        </p>
                        <button
                          type="button"
                          className="btn checkout-btn storecredit-checkout-btn refund-payout-voucher-btn"
                          disabled={busy}
                          onClick={() => void submitExchangeCheckout('customer_receives_store_credit')}
                        >
                          {busy ? 'Processing…' : 'Issue store credit'}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : null}
        <ManualReturnPayoutModal
          open={manualReturnPayoutOpen}
          busy={busy}
          returnTotal={cartTotal}
          note={manualReturnNote}
          creditPhone={manualReturnCreditPhone}
          onNoteChange={setManualReturnNote}
          onCreditPhoneChange={setManualReturnCreditPhone}
          onClose={closeManualReturnPayoutStep}
          onSubmit={(method) => void submitManualReturnCheckout(method)}
        />
        <StockOverrideModal
          request={stockOverrideRequest}
          selfApprover={stockOverrideSelfApprover}
          onClose={cancelStockOverrideApproval}
          onApproved={settleStockOverrideApproval}
        />
        {productPhotoViewer ? (
          <div
            className="open-tabs-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="product-photo-modal-title"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) {
                setProductPhotoViewer(null)
              }
            }}
          >
            <div className="open-tabs-dialog" style={{ maxWidth: 'min(96vw, 28rem)' }}>
              <div className="open-tabs-header">
                <h2 id="product-photo-modal-title" className="product-photo-modal-heading">
                  {productPhotoViewer.name}
                </h2>
                <button
                  type="button"
                  className="btn ghost open-tabs-close"
                  onClick={() => setProductPhotoViewer(null)}
                >
                  Close
                </button>
              </div>
              <div className="quotes-modal-body product-photo-modal-body">
                <p className="muted product-photo-modal-sku">{productPhotoViewer.sku}</p>
                {productPhotoLoading ? <p className="muted">Loading…</p> : null}
                {productPhotoError ? <p className="error">{productPhotoError}</p> : null}
                {productPhotoUrl && !productPhotoLoading ? (
                  <img src={productPhotoUrl} alt="" className="product-photo-modal-img" />
                ) : null}
                <p className="muted help-note" style={{ marginTop: '0.75rem' }}>
                  Photos require a live server connection on this register.
                </p>
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
          canVoidJobCards={isStoreAdmin}
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
        <LoyaltyModal
          open={loyaltyModalOpen}
          onClose={closeLoyaltyModal}
          busy={busy}
          cartTotal={cartTotal}
          program={loyalty.loyaltyProgram}
          masked={loyalty.loyaltyMasked}
          balance={loyalty.loyaltyBalance}
          purchases={loyalty.loyaltyPurchases}
          purchasesTotal={loyalty.loyaltyPurchasesTotal}
          purchasesLoading={loyalty.loyaltyPurchasesLoading}
          pointsRedeem={loyalty.loyaltyPointsRedeem}
          discount={loyalty.loyaltyDiscount}
          entryActive={loyalty.loyaltyEntryActive}
          onStartPhoneEntry={startLoyaltyPhoneFromModal}
          onCancelPhoneEntry={loyalty.cancelLoyaltyEntry}
          onRedeemMax={loyalty.applyMaxLoyaltyRedeem}
          onClear={loyalty.clearLoyalty}
        />
        <LayByModal
          open={layByModalOpen}
          onClose={() => setLayByModalOpen(false)}
          cart={cart}
          cartTotal={cartTotal}
          isAdmin={isAdmin}
          canCancelLayBy={canCancelLayBy}
          tillCode={POS_TILL_CODE}
          onCreated={() => {
            clearActiveQuote()
            setCart([])
            void loadProducts()
          }}
          onPaymentReceiptPrinted={(payloads, successNotice) => {
            setLastReceiptForReprint({
              kind: 'raw',
              payload: payloads[0],
              payloads,
              successNotice,
            })
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
          onPrintStatement={async (row) => {
            const r = await printHouseAccountStatementToDevice(row)
            if (!r.ok) setError(r.error ?? 'Statement print failed')
          }}
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
            canBrowseSalesDirectly={canBrowseSalesForAdjust}
            tillCode={POS_TILL_CODE}
            onSaleLoaded={(data, enteredId) => {
              beginRefundMode(data, enteredId)
            }}
          />
        ) : null}
        {canExchange ? (
          <ExchangeSaleIdModal
            open={exchangeSaleIdModalOpen}
            onClose={() => setExchangeSaleIdModalOpen(false)}
            canBrowseSalesDirectly={canBrowseSalesForAdjust}
            tillCode={POS_TILL_CODE}
            onSaleLoaded={(data, enteredId) => {
              beginExchangeMode(data, enteredId)
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
        <ConfirmMessageModal
          open={exchangeExitConfirmOpen}
          title="Leave exchange mode?"
          stackOnPosOverlay
          confirmLabel="Leave exchange"
          onClose={() => setExchangeExitConfirmOpen(false)}
          onConfirm={confirmExitExchangeMode}
        >
          <p className="muted confirm-preset-delete-body">
            The exchange cart will be cleared and you will return to normal sales.
          </p>
        </ConfirmMessageModal>
      </PosShell>
    </div>
  )
}
