import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch, loginRequest } from '../api/client'
import type {
  CartLine,
  HouseAccountRow,
  OpenTabDetail,
  OpenTabListItem,
  Product,
  QuoteDetail,
  QuoteListItem,
  Sale,
} from '../api/types'
import { useAuth } from '../auth/AuthContext'
import {
  HouseAccountsModal,
  LayByModal,
  OpenTabsModal,
  QuotesModal,
  ScreenKeyboard,
  type ScreenKeyboardAction,
} from '../components'
import { PosShell } from '../layouts/PosShell'
import { readPosPrinterSettings, type PosPrinterSettings } from '../printer/posPrinterSettings'
import { formatDateDdMmYyyy } from '../utils/dateFormat'

const LAST_RECEIPT_STORAGE_KEY = 'electropos-pos-last-receipt-sale'

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

function persistLastReceiptSale(sale: Sale): void {
  try {
    localStorage.setItem(LAST_RECEIPT_STORAGE_KEY, JSON.stringify(sale))
  } catch {
    /* quota / private mode */
  }
}

export function Register() {
  const { session } = useAuth()
  const isAdmin = session?.user.role === 'admin'
  const [products, setProducts] = useState<Product[]>([])
  const [filter, setFilter] = useState('')
  const [skuInput, setSkuInput] = useState('')
  const [showItemList, setShowItemList] = useState(false)
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
    tabNumber: string
    customerName: string
    phone: string
  } | null>(null)
  const [receiptEnabled, setReceiptEnabled] = useState(() => readPosPrinterSettings().autoPrintReceipt)
  const [printerSettings, setPrinterSettings] = useState<PosPrinterSettings>(() => readPosPrinterSettings())
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [lastSale, setLastSale] = useState<Sale | null>(null)
  const [lastReceiptForReprint, setLastReceiptForReprint] = useState<Sale | null>(() =>
    readStoredLastReceiptSale(),
  )
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

  const voucherKbBlurTimerRef = useRef<number | null>(null)
  const voucherKbFieldRef = useRef<'phone' | 'amount'>('phone')
  const [voucherScreenKbOpen, setVoucherScreenKbOpen] = useState(false)
  const [voucherFormOpen, setVoucherFormOpen] = useState(false)
  const [houseAccountsModalOpen, setHouseAccountsModalOpen] = useState(false)
  const [houseAccountForCheckout, setHouseAccountForCheckout] = useState<HouseAccountRow | null>(null)
  const [onAccountAmountStr, setOnAccountAmountStr] = useState('')
  const [houseAccountFormOpen, setHouseAccountFormOpen] = useState(false)
  const [altPaymentExpanded, setAltPaymentExpanded] = useState(false)
  const [lastOnAccount, setLastOnAccount] = useState<number | null>(null)

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
    if (cart.length === 0) {
      setVoucherFormOpen(false)
      setHouseAccountFormOpen(false)
      setHouseAccountForCheckout(null)
      setOnAccountAmountStr('')
      setAltPaymentExpanded(false)
    }
  }, [cart.length])

  useEffect(() => {
    if (!altPaymentExpanded) {
      setVoucherFormOpen(false)
      setHouseAccountFormOpen(false)
      setVoucherScreenKbOpen(false)
    }
  }, [altPaymentExpanded])

  useEffect(() => {
    if (!voucherFormOpen) setVoucherScreenKbOpen(false)
  }, [voucherFormOpen])

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

  function clearActiveQuote() {
    setActiveQuoteId(null)
    setActiveQuoteBanner(null)
  }

  function resetVoucherForm() {
    setVoucherPhone('')
    setVoucherAmountStr('')
    setVoucherBalanceHint(null)
    setVoucherNameHint('')
    setVoucherFormOpen(false)
    setOnAccountAmountStr('')
    setHouseAccountFormOpen(false)
    setHouseAccountForCheckout(null)
  }

  function cancelVoucherKbBlurHide() {
    if (voucherKbBlurTimerRef.current) {
      clearTimeout(voucherKbBlurTimerRef.current)
      voucherKbBlurTimerRef.current = null
    }
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
        cancelVoucherKbBlurHide()
        setVoucherScreenKbOpen(true)
      },
      onBlur: () => {
        cancelVoucherKbBlurHide()
        voucherKbBlurTimerRef.current = window.setTimeout(() => {
          setVoucherScreenKbOpen(false)
        }, 200)
      },
    }
  }

  const loadProducts = useCallback(async () => {
    setError(null)
    try {
      const list = await apiFetch<Product[]>('/products')
      setProducts(list)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load products')
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
    }
  }, [])

  useEffect(() => {
    if (showChangeView) setVoucherScreenKbOpen(false)
    if (cart.length === 0 && !pendingSplit) setVoucherScreenKbOpen(false)
  }, [showChangeView, cart.length, pendingSplit])

  useEffect(() => {
    const hold = discountHoldRef.current
    return () => {
      if (hold.timer) clearTimeout(hold.timer)
    }
  }, [])

  const itemListKbBlurTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!showItemList) {
      setItemListScreenKbOpen(false)
    }
  }, [showItemList])

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
        })),
      }),
    })
  }

  async function handleLoadQuote(id: string) {
    if (activeOpenTabId) {
      setError('Finish or walk-in from tab before loading a quote')
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
        detail.lines.map((l) => ({
          productId: typeof l.productId === 'string' ? l.productId : String(l.productId),
          name: l.name,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          listUnitPrice: l.listUnitPrice,
        })),
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
        lines: lines.map((l) => ({
          productId: l.productId,
          name: l.name,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          listUnitPrice: l.listUnitPrice,
        })),
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

  function addToCartQty(p: Product, requestedQty: number) {
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
    const avail = p.availableQty ?? p.stock
    if (avail < 1) {
      setError('Out of stock')
      return
    }
    setError(null)
    let partialNotice: string | null = null
    let atStockLimit = false
    setCart((prev) => {
      const i = prev.findIndex((l) => l.productId === p._id)
      if (i >= 0) {
        const next = [...prev]
        const line = next[i]
        const room = avail - line.quantity
        const toAdd = Math.min(requestedQty, room)
        if (toAdd <= 0) {
          atStockLimit = true
          return prev
        }
        if (toAdd < requestedQty) {
          partialNotice = `Added ${toAdd} of ${requestedQty} (${avail} available)`
        }
        next[i] = { ...line, quantity: line.quantity + toAdd }
        return next
      }
      const toAdd = Math.min(requestedQty, avail)
      if (toAdd < 1) return prev
      if (toAdd < requestedQty) {
        partialNotice = `Added ${toAdd} of ${requestedQty} (${avail} available)`
      }
      return [
        ...prev,
        {
          productId: p._id,
          name: p.name,
          quantity: toAdd,
          unitPrice: p.price,
        },
      ]
    })
    if (atStockLimit) {
      setError('This line is already at maximum stock for that product')
      return
    }
    if (partialNotice) setNotice(partialNotice)
  }

  function addToCart(p: Product) {
    addToCartQty(p, 1)
  }

  function bumpQty(productId: string, delta: number) {
    clearActiveQuote()
    setLastSale(null)
    setNotice(null)
    setPendingSplit(null)
    setLastStoreCredit(null)
    setLastOnAccount(null)
    setCart((prev) => {
      const line = prev.find((l) => l.productId === productId)
      if (!line) return prev
      const p = products.find((x) => x._id === productId)
      const max = p ? (p.availableQty ?? p.stock) : 999
      const nextQty = line.quantity + delta
      if (nextQty <= 0) return prev.filter((l) => l.productId !== productId)
      if (nextQty > max) return prev
      return prev.map((l) =>
        l.productId === productId ? { ...l, quantity: nextQty } : l,
      )
    })
  }

  const cartTotal = useMemo(
    () =>
      Math.round(
        cart.reduce((s, l) => s + l.quantity * l.unitPrice, 0) * 100,
      ) / 100,
    [cart],
  )

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
        tabNumber: tab.tabNumber,
        customerName: tab.customerName,
        phone: tab.phone,
      })
      setCart(
        tab.lines.map((l) => ({
          productId: l.productId,
          name: l.name,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          listUnitPrice: l.listUnitPrice,
        })),
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

  async function createOpenTabFromModal(input: {
    tabNumber: string
    customerName: string
    phone: string
    includeCurrentCart: boolean
  }) {
    if (activeOpenTabId) {
      throw new Error('Use “Walk-in” to leave the current tab before creating another')
    }
    const linesPayload = input.includeCurrentCart
      ? cart.map((l) => ({
          productId: l.productId,
          name: l.name,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          listUnitPrice: l.listUnitPrice,
        }))
      : []
    const created = await apiFetch<OpenTabDetail>('/tabs', {
      method: 'POST',
      body: JSON.stringify({
        tabNumber: input.tabNumber,
        customerName: input.customerName,
        phone: input.phone,
        lines: linesPayload,
      }),
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
      tabNumber: created.tabNumber,
      customerName: created.customerName,
      phone: created.phone,
    })
    setCart(
      created.lines.map((l) => ({
        productId: l.productId,
        name: l.name,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        listUnitPrice: l.listUnitPrice,
      })),
    )
    await loadOpenTabsList()
  }

  async function goWalkInSale() {
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
    setNotice('Tab saved · walk-in sale')
  }

  async function submitSale(
    paymentMethod: string,
    payment?: { cashAmount: number; cardAmount: number; tenderedCash?: number; changeDue?: number },
    storeCredit?: { amount: number; phone: string },
    houseAccount?: { id: string; amount: number },
  ) {
    if (cart.length === 0) return
    if (storeCredit && storeCredit.amount > 0.005 && !normalizePhone(storeCredit.phone)) {
      setError('Store voucher requires a phone number')
      return
    }
    if (houseAccount && houseAccount.amount > 0.005 && !houseAccount.id) {
      setError('House account required for on-account charge')
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
    try {
      const body: Record<string, unknown> = {
        items: cart.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
        })),
        paymentMethod,
        payment,
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
      }
      const sale = await apiFetch<Sale>('/sales', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      setLastSale(sale)
      setLastReceiptForReprint(sale)
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
      setError(e instanceof Error ? e.message : 'Checkout failed')
    } finally {
      setBusy(false)
    }
  }

  async function applyPartialPayment(method: 'cash' | 'card') {
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
      prevOa > 0 && oaId ? { id: oaId, amount: prevOa } : undefined,
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
    setOnAccountAmountStr('')
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
        `/lay-bys/credit-balance?phone=${encodeURIComponent(phone)}`,
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
    const { total, cashReceived, cardReceived, onAccountApplied, houseAccountId, houseAccountNumber, houseAccountName } =
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
    const maxVoucher = round2(total - prevCash - prevCard - prevOa)
    if (amt > maxVoucher + 0.01) {
      setError(`Voucher cannot exceed ${maxVoucher.toFixed(2)} (still due)`)
      return
    }

    let balance: number
    try {
      const r = await apiFetch<{ balance: number; name: string }>(
        `/lay-bys/credit-balance?phone=${encodeURIComponent(phone)}`,
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
      prevOa > 0 && oaId ? { id: oaId, amount: prevOa } : undefined,
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
    setOnAccountAmountStr('')
    void postSaleHardwareActions(sale)
  }

  function applyOnAccountUseMax() {
    const total = pendingSplit?.total ?? cartTotal
    const prevCash = pendingSplit?.cashReceived ?? 0
    const prevCard = pendingSplit?.cardReceived ?? 0
    const prevSc = pendingSplit?.storeCreditApplied ?? 0
    const maxByDue = round2(total - prevCash - prevCard - prevSc)
    if (!houseAccountForCheckout) {
      setError('Pick a house account first (ACCOUNTS)')
      return
    }
    const limit = houseAccountForCheckout.creditLimit
    const bal = houseAccountForCheckout.balance
    const headroom = limit != null ? round2(limit - bal) : maxByDue
    const use = round2(Math.min(maxByDue, Math.max(0, headroom)))
    if (use <= 0) {
      setError(limit != null ? 'At credit limit' : 'Nothing to charge')
      return
    }
    setOnAccountAmountStr(String(use))
    setError(null)
  }

  async function applyOnAccountToSale() {
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

    const amt = parseTenderedInput(onAccountAmountStr.trim(), 0)
    if (!Number.isFinite(amt) || amt <= 0) {
      setError('Enter amount to charge on account')
      return
    }

    const total = pendingSplit?.total ?? cartTotal
    const prevCash = pendingSplit?.cashReceived ?? 0
    const prevCard = pendingSplit?.cardReceived ?? 0
    const prevSc = pendingSplit?.storeCreditApplied ?? 0
    const maxByDue = round2(total - prevCash - prevCard - prevSc)
    if (amt > maxByDue + 0.01) {
      setError(`On account cannot exceed ${maxByDue.toFixed(2)} (still due)`)
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
      setPendingSplit({
        total,
        cashReceived: prevCash,
        cardReceived: prevCard,
        storeCreditApplied: prevSc,
        storeCreditPhone: pendingSplit?.storeCreditPhone ?? '',
        onAccountApplied: newOa,
        houseAccountId: acct._id,
        houseAccountNumber: acct.accountNumber,
        houseAccountName: acct.name,
        amountDue,
      })
      setOnAccountAmountStr('')
      setHouseAccountFormOpen(false)
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
      newOa > 0 ? { id: acct._id, amount: newOa } : undefined,
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
    setOnAccountAmountStr('')
    void postSaleHardwareActions(sale)
  }

  async function checkoutCash() {
    await applyPartialPayment('cash')
  }

  async function checkoutCard() {
    await applyPartialPayment('card')
  }

  function pressKey(key: string) {
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
      addToCartQty(match, qtyNum)
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
      // When browsing items, don't hijack typing into the search box.
      if (showItemList) return
      if (e.defaultPrevented) return
      if (isTypingTarget(e.target)) return

      // Avoid repeating characters for long key presses.
      if (e.repeat) return

      if (e.key >= '0' && e.key <= '9') {
        pressKey(e.key)
        return
      }
      if (e.key === '.' || e.key === ',' || e.key === 'NumpadDecimal') {
        pressKey('.')
        return
      }
      if (e.key === '*' || e.key === 'NumpadMultiply') {
        e.preventDefault()
        pressKey('×')
        return
      }
      if (e.key === 'Backspace') {
        pressKey('backspace')
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        addBySku()
        return
      }
      if (e.key === 'Escape') {
        pressKey('clear')
        return
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // pressKey/addBySku/read of refs are stable enough for this listener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showItemList])

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

  async function requestManagerApproval(actionLabel: string) {
    if (!session || session.user.role !== 'admin') {
      setError(`Admin required for ${actionLabel}`)
      return false
    }
    const pin = window.prompt(`Manager PIN required for ${actionLabel}.\nUse admin password:`)
    if (!pin) return false
    try {
      await loginRequest(session.user.email, pin)
      return true
    } catch {
      setError('Manager authentication failed')
      return false
    }
  }

  function priceOverrideLast() {
    if (!isAdmin) {
      setError('Admin required for price override')
      return
    }
    if (cart.length === 0) {
      setError('Add an item to cart first')
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
    if (!isAdmin) {
      setError('Admin required for discount')
      return
    }
    if (cart.length === 0) {
      setError('Add items to cart first')
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
    if (!isAdmin) {
      setError('Admin required for discount')
      return
    }
    if (cart.length === 0) {
      setError('Add items to cart first')
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
    if (!e.isPrimary || cart.length === 0) return
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

  function lineDiscountDisplay(line: CartLine): { show: boolean; pct: number } | null {
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

  function receiptPayloadFromSale(
    sale: Sale,
    opts?: { copyLabel?: string },
  ): {
    transport: unknown
    receipt: unknown
    columns: number
    cut: boolean
  } {
    const cfg = printerSettings.receiptConfig
    const ts = sale.createdAt ?? new Date().toISOString()
    const gross = sale.items.reduce((sum, l) => sum + (l.lineTotal ?? l.quantity * l.unitPrice), 0)
    const total = sale.total ?? gross
    const discountTotal = Math.max(0, gross - total)
    const vatRate = Number(cfg.vatRatePct || 0)
    const taxTotal = vatRate > 0 ? total - total / (1 + vatRate / 100) : 0
    const subtotal = total - taxTotal
    const paymentLabelRaw = (sale.paymentMethod ?? '').toLowerCase()
    const paymentLabel = paymentLabelRaw.includes('split')
      ? 'Split'
      : paymentLabelRaw === 'on_account'
        ? 'On account'
        : paymentLabelRaw.includes('card')
          ? 'Card'
          : paymentLabelRaw.includes('store')
            ? 'Store voucher'
            : 'Cash'

    const tendered = sale.payment?.tenderedCash
    const changeDue = sale.payment?.changeDue

    const onAccountAmt = sale.onAccountAmount ?? 0
    const accountAck =
      onAccountAmt > 0.005
        ? {
            accountNumber: sale.houseAccountNumber?.trim() || '—',
            accountName: sale.houseAccountName?.trim(),
            amount: onAccountAmt,
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
        receiptTitle: cfg.receiptTitle,
        cashierName: session?.user.email,
        tillNumber: '2',
        tillLabel: cfg.tillLabel,
        slipLabel: cfg.slipLabel,
        receiptNumber: sale._id.slice(-8),
        timestampIso: ts,
        paymentLabel,
        copyLabel: opts?.copyLabel,
        accountChargeAck: accountAck,
        lines: sale.items.map((l) => ({
          qty: l.quantity,
          name: l.name,
          unitPrice: l.unitPrice,
          lineTotal: l.lineTotal,
        })),
        subtotal,
        taxTotal: taxTotal > 0.005 ? taxTotal : undefined,
        vatRatePct: vatRate > 0 ? vatRate : undefined,
        vatLabel: cfg.vatLabel,
        subtotalLabel: cfg.subtotalLabel,
        taxTotalLabel: cfg.taxTotalLabel,
        totalDueLabel: cfg.totalDueLabel,
        cashTenderedLabel: cfg.cashTenderedLabel,
        changeDueLabel: cfg.changeDueLabel,
        thankYouLine: cfg.thankYouLine,
        discountTotal: discountTotal > 0.005 ? discountTotal : undefined,
        total,
        tendered,
        changeDue,
      },
    }
  }

  async function printSaleReceiptsToDevice(sale: Sale): Promise<{ ok: boolean; error?: string }> {
    if (!window.electronPos) return { ok: true }
    const dual = saleHasOnAccountCharge(sale)
    const labels = dual ? (['CUSTOMER COPY', 'STORE COPY'] as const) : ([undefined] as const)
    for (const copyLabel of labels) {
      const p = receiptPayloadFromSale(sale, copyLabel ? { copyLabel } : undefined)
      const r = await window.electronPos.printReceipt(p.transport, p.receipt, { columns: p.columns, cut: p.cut })
      if (!r.ok) return { ok: false, error: r.error ?? 'Print failed' }
    }
    return { ok: true }
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
        cashierName: session?.user.email,
        tillNumber: '2',
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

  async function printLastReceipt(sale: Sale) {
    setError(null)
    try {
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
      setError('Admin required to open drawer')
      return
    }
    const approved = await requestManagerApproval('open drawer')
    if (!approved) return
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

  return (
    <div className="register-viewport">
      <PosShell>
        <div className="register-grid">
          <section className="panel panel-products">
            <div className="products-header">
              <div className="products-header-titles">
                <h2>{showItemList ? 'Item List' : 'Register Keys'}</h2>
                {activeTabBanner ? (
                  <div className="register-tab-banner">
                    <span className="register-tab-banner-text">
                      Tab <strong>#{activeTabBanner.tabNumber}</strong> · {activeTabBanner.customerName}
                      {activeTabBanner.phone ? ` · ${activeTabBanner.phone}` : ''}
                    </span>
                    <button type="button" className="btn ghost key-action register-tab-walkin" onClick={() => void goWalkInSale()}>
                      Walk-in
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
                      <button
                        type="button"
                        className="btn ghost key-action register-tab-walkin"
                        onClick={() => void printQuoteById(activeQuoteId)}
                      >
                        Print quote
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="btn ghost key-action"
                onClick={() => setShowItemList((v) => !v)}
              >
                {showItemList ? 'Hide list' : 'Item list'}
              </button>
            </div>

            {!showItemList ? (
              <div className="keys-layout">
                <div className="sku-display" title="SKU, or qty×SKU then ENTER">
                  <span className="muted">&nbsp;</span>
                  <strong>{skuInput}</strong>
                </div>
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
                  <button type="button" className="key-btn key-btn-primary key-btn-enter" onClick={() => pressKey('enter')}>ENTER</button>
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
                <div className="function-grid">
                  <button type="button" className="key-btn key-btn-fn" onClick={voidLastItem} disabled={cart.length === 0}>
                    VOID ITEM
                  </button>
                  <button
                    type="button"
                    className="key-btn key-btn-fn"
                    onClick={() => {
                      setOpenTabsModalOpen(true)
                      void loadOpenTabsList()
                    }}
                  >
                    TABS
                  </button>
                  <button
                    type="button"
                    className="key-btn key-btn-fn"
                    onClick={() => setHouseAccountsModalOpen(true)}
                    title="House accounts (on-account sales)"
                  >
                    ACCOUNTS
                  </button>
                  <button
                    type="button"
                    className="key-btn key-btn-fn"
                    disabled={!!activeOpenTabId}
                    title={activeOpenTabId ? 'Finish or walk-in from tab first' : undefined}
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
                    disabled={!!activeOpenTabId}
                    title={activeOpenTabId ? 'Finish or walk-in from tab first' : undefined}
                    onClick={() => setLayByModalOpen(true)}
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
                    disabled={cart.length === 0}
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
                    className={`key-btn key-btn-fn ${receiptEnabled ? 'key-btn-primary' : ''}`}
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
                <p className="muted item-list-tap-hint">Tap a row below to add it to the cart.</p>
                <div className="product-browser">
                  <ul className="product-list">
                    {filtered.map((p) => (
                      <li key={p._id}>
                        <button
                          type="button"
                          className="product-row"
                          aria-label={
                            p.stock < 1 ? `${p.name} — out of stock` : `Add ${p.name} to cart`
                          }
                          onClick={() => addToCart(p)}
                          disabled={(p.availableQty ?? p.stock) < 1}
                        >
                          <span className="product-name">{p.name}</span>
                          <span className="product-meta">
                            <span className="muted">{p.sku}</span>
                            <span className="product-price">
                              {p.price.toFixed(2)} · {p.availableQty ?? p.stock} available
                            </span>
                          </span>
                        </button>
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
                      onClick={() => setAltPaymentExpanded((v) => !v)}
                    >
                      {altPaymentExpanded ? 'Hide alt payment options' : 'Alt payment options'}
                    </button>
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
                              onClick={() => setHouseAccountFormOpen((v) => !v)}
                              aria-expanded={houseAccountFormOpen}
                            >
                              {houseAccountFormOpen ? 'Hide on account' : 'Charge on account'}
                            </button>
                            <button type="button" className="btn ghost small" onClick={() => setHouseAccountsModalOpen(true)}>
                              ACCOUNTS
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
                              Tap ACCOUNTS to pick a house account.
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
                                  value={onAccountAmountStr}
                                  onChange={(e) => setOnAccountAmountStr(e.target.value)}
                                />
                                <button type="button" className="btn small" disabled={busy} onClick={applyOnAccountUseMax}>
                                  Use max
                                </button>
                                <button
                                  type="button"
                                  className="btn small primary"
                                  disabled={busy}
                                  onClick={() => void applyOnAccountToSale()}
                                >
                                  Apply
                                </button>
                              </div>
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
                <h2>Cart</h2>
                <div className="cart-body">
                  {cart.length === 0 ? (
                    <p className="muted empty-hint cart-empty-msg">Tap a product to add.</p>
                  ) : (
                    <div className="cart-lines">
                      {cart.map((l) => {
                        const disc = lineDiscountDisplay(l)
                        return (
                        <div className="cart-line" key={l.productId}>
                          <div className="cart-line-info">
                            <span className="cart-line-name">{l.name}</span>
                            <span className="cart-line-sub">
                              {disc ? (
                                <>
                                  <span className="cart-line-was">{l.listUnitPrice!.toFixed(2)}</span>
                                  <span className="cart-line-price-arrow"> → </span>
                                </>
                              ) : null}
                              <span className="cart-line-unit">{l.unitPrice.toFixed(2)} each</span>
                              {disc ? (
                                <span className="cart-line-discount-badge">−{disc.pct}%</span>
                              ) : null}
                            </span>
                          </div>
                          <div className="cart-line-actions">
                            <div className="stepper" role="group" aria-label="Quantity">
                              <button
                                type="button"
                                className="stepper-btn"
                                aria-label={`Decrease ${l.name}`}
                                onClick={() => bumpQty(l.productId, -1)}
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
                                onClick={() => bumpQty(l.productId, 1)}
                              >
                                +
                              </button>
                            </div>
                            <span className="cart-line-total">{(l.quantity * l.unitPrice).toFixed(2)}</span>
                          </div>
                        </div>
                        )
                      })}
                    </div>
                  )}
                </div>
                <div className="cart-footer">
                  {cart.length > 0 ? (
                    <div className="register-alt-payment-wrap">
                      <button
                        type="button"
                        className="btn ghost small register-alt-payment-toggle"
                        aria-expanded={altPaymentExpanded}
                        onClick={() => setAltPaymentExpanded((v) => !v)}
                      >
                        {altPaymentExpanded ? 'Hide alt payment options' : 'Alt payment options'}
                      </button>
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
                                onClick={() => setHouseAccountFormOpen((v) => !v)}
                                aria-expanded={houseAccountFormOpen}
                              >
                                {houseAccountFormOpen ? 'Hide on account' : 'Charge on account'}
                              </button>
                              <button type="button" className="btn ghost small" onClick={() => setHouseAccountsModalOpen(true)}>
                                ACCOUNTS
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
                                Tap ACCOUNTS to pick a house account.
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
                                    value={onAccountAmountStr}
                                    onChange={(e) => setOnAccountAmountStr(e.target.value)}
                                  />
                                  <button type="button" className="btn small" disabled={busy} onClick={applyOnAccountUseMax}>
                                    Use max
                                  </button>
                                  <button
                                    type="button"
                                    className="btn small primary"
                                    disabled={busy}
                                    onClick={() => void applyOnAccountToSale()}
                                  >
                                    Apply
                                  </button>
                                </div>
                              </>
                            ) : null}
                          </div>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="total">
                    Total <strong className="total-amount">{cartTotal.toFixed(2)}</strong>
                  </div>
                  <div className="cash-footer">
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
                  </div>
                </div>
                {(error || notice || lastSale) && (
                  <div className="cart-messages">
                    {error && <p className="error">{error}</p>}
                    {notice && <p className="success">{notice}</p>}
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
          saveDisabled={cart.length === 0 || !!activeOpenTabId}
          loadDisabled={!!activeOpenTabId}
        />
        <LayByModal
          open={layByModalOpen}
          onClose={() => setLayByModalOpen(false)}
          cart={cart}
          cartTotal={cartTotal}
          isAdmin={isAdmin}
          onCreated={() => {
            clearActiveQuote()
            setCart([])
            void loadProducts()
          }}
        />
        <HouseAccountsModal
          open={houseAccountsModalOpen}
          onClose={() => setHouseAccountsModalOpen(false)}
          onSelectForCheckout={(row) => {
            setHouseAccountForCheckout(row)
            setHouseAccountFormOpen(true)
          }}
        />
      </PosShell>
    </div>
  )
}
