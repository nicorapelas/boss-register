export interface Product {
  _id: string
  name: string
  sku: string
  category?: string | null
  subCategory?: string | null
  barcode?: string | null
  price: number
  stock: number
  /** Progressive volume unit pricing; ordinals 1..qty. */
  volumeTieringEnabled?: boolean
  volumeTiers?: Array<{ minQty: number; maxQty: number | null; unitPrice: number }>
  /** When false, service/labour — POS does not treat as stock-limited. Default true if omitted. */
  trackInventory?: boolean
  /** Units reserved on active lay-bys (server); omitted/zero for non-tracked in list response */
  layByReservedQty?: number
  /** stock − reserved; null when trackInventory is false */
  availableQty?: number | null
  /** Optional policy flag: block offline oversell even with manager override. */
  strictOfflineStock?: boolean
}

export type CartLine = {
  productId: string
  name: string
  quantity: number
  unitPrice: number
  listUnitPrice?: number
  /** Refund mode: original sale line index for POST /sales/:id/refund */
  refundSaleLineIndex?: number
  /** Refund mode: max quantity refundable on this line (remaining from server). */
  refundQtyMax?: number
  /** Single segment for flat bucket volume price (display); server uses same rule. */
  volumeSegments?: Array<{
    quantity: number
    unitPrice: number
    lineTotal: number
    listUnitPrice?: number
  }>
}

export type ProductPresetsState = {
  entries: Array<{
    productId: string
    category: string
    subCategory: string
    label: string
  }>
  categories: string[]
  subCategoriesByCategory: Record<string, string[]>
}

export interface StoreSettings {
  _id: string
  storeName: string
  storeAddressLines: string[]
  storePhone: string
  storeVatNumber: string
  layByTerms: string
  defaultDepositPercent: number
  defaultExpiryMonths: number
  vatRate: number
  nextLayBySeq: number
  nextQuoteSeq: number
  nextHouseAccountSeq?: number
  productPresets?: ProductPresetsState
}

export interface QuoteListItem {
  _id: string
  sequenceNumber: number
  quoteNumber: string
  customerName: string
  phone: string
  totalInclVat: number
  validUntil: string
  status: string
  createdAt?: string
  isExpired: boolean
}

export interface QuoteDetail {
  _id: string
  createdAt?: string
  sequenceNumber: number
  quoteNumber: string
  customerName: string
  phone: string
  lines: Array<{
    productId: string
    name: string
    sku: string
    quantity: number
    unitPrice: number
    lineTotal: number
    listUnitPrice?: number
  }>
  vatRate: number
  totalInclVat: number
  totalVatAmount: number
  totalNetAmount: number
  validUntil: string
  status: string
  isExpired: boolean
}

export interface LayByListItem {
  _id: string
  layByNumber: string
  customerName: string
  phone: string
  balance: number
  totalInclVat: number
  status: string
  expiresAt: string
}

export interface LayByDetail {
  _id: string
  createdAt?: string
  layByNumber: string
  customerName: string
  phone: string
  lines: Array<{
    productId: string
    name: string
    sku: string
    quantity: number
    unitPrice: number
    lineTotal: number
  }>
  vatRate: number
  totalInclVat: number
  totalVatAmount: number
  totalNetAmount: number
  depositPercentUsed: number
  depositAmount: number
  amountPaid: number
  balance: number
  status: string
  expiresAt: string
  payments: Array<{
    amount: number
    cashAmount: number
    cardAmount: number
    storeCreditAmount?: number
    createdAt: string
  }>
}

/** POST /lay-bys/:id/payments response includes optional tender / change metadata */
export type LayByPaymentResponse = LayByDetail & {
  paymentChangeDue?: number
  paymentTenderedCash?: number
  paymentTenderedCard?: number
  paymentAppliedCash?: number
  paymentAppliedCard?: number
  paymentAppliedStoreCredit?: number
}

export interface SaleLine {
  product: string
  name: string
  quantity: number
  unitPrice: number
  listUnitPrice?: number
  lineTotal: number
}

export interface Sale {
  _id: string
  /** 10 hex characters — primary id for receipts and refunds (Mongo _id remains for internal refs) */
  saleId?: string
  /** Register / till code snapshot from POS device config. */
  tillCode?: string
  cashier: string
  items: SaleLine[]
  total: number
  quoteId?: string
  paymentMethod?: string
  payment?: {
    cashAmount?: number
    cardAmount?: number
    tenderedCash?: number
    changeDue?: number
  }
  /** Amount paid from store voucher / credit account */
  storeCreditAmount?: number
  /** Normalized digits-only phone used for redemption (present on create-sale response when voucher applied). */
  storeCreditPhone?: string
  /** Account balance immediately after redemption (create-sale response only). */
  storeCreditBalanceAfter?: number
  /** Charged to house / on-account (AR) */
  onAccountAmount?: number
  houseAccountId?: string
  houseAccountNumber?: string
  houseAccountName?: string
  purchaseOrderNumber?: string
  createdAt?: string
  /** Server marks partial/full refunds */
  refundStatus?: 'partial' | 'refunded'
  refundedAt?: string
  refundNote?: string
  refundPayoutMethod?: 'cash' | 'card' | 'store_credit'
  refundPayoutAmount?: number
}

/** POST /sales/:id/refund settlement breakdown (POS receipt / audit). */
export interface SaleRefundSettlement {
  refundTotal: number
  reversedStoreCredit: number
  reversedOnAccount: number
  netCashOrCardPaidOut: number
  storeCreditIssued: number
}

export interface SaleRefundPreview {
  sale: Sale
  refund: {
    refundedTotal: number
    remainingTotal: number
    lines: Array<{ index: number; soldQty: number; refundedQty: number; remainingQty: number }>
  }
}

export interface ShiftCashDifference {
  kind: 'over' | 'under'
  amount: number
  note?: string
  source: 'pos' | 'backoffice'
  createdAt: string
}

export interface ShiftSummary {
  /** Retail sale totals this shift minus refunds recorded this shift (same till). */
  turnover: number
  /** Net cash tenders: gross cash from retail sales minus refund payouts by cash. */
  cashSales: number
  /** Net card tenders: gross card from retail sales minus refund payouts by card. */
  cardSales: number
  voucherTotal: number
  onAccountTotal: number
  refundTotal: number
  refundCashTotal: number
  refundCardTotal: number
  refundCount: number
  refundCashierNames?: string[]
  refundDetails?: Array<{
    saleId?: string
    cashierId?: string
    cashierName?: string
    method?: 'cash' | 'card' | 'store_credit'
    refundTotal: number
    refundCash: number
    refundCard: number
  }>
  layByCompletions: number
  /** Number of lay-by payments (deposit + installments) recorded during this shift window. */
  layByPaymentCount: number
  /** Lay-by payment tender totals recorded during this shift window. */
  layByPaymentCashTotal: number
  layByPaymentCardTotal: number
  layByPaymentStoreCreditTotal: number
  layByPaymentTotal: number
  quoteConversions: number
  tabClosures: number
  /** Per cashier: gross retail totals minus refunds attributed to that cashier’s original sales. */
  cashierSales: Array<{ cashierId: string; cashierName?: string; salesCount: number; total: number }>
  priceOverrides?: Array<{
    saleId?: string
    cashierId?: string
    cashierName?: string
    itemName: string
    quantity: number
    listUnitPrice: number
    overriddenUnitPrice: number
    lineDiscount: number
  }>
}

export interface ShiftReport {
  shiftId: string
  tillCode: string
  openedAt: string
  status: 'open' | 'closed'
  summary: ShiftSummary
  cashDifferences: ShiftCashDifference[]
}

/** GET /house-accounts */
export interface HouseAccountRow {
  _id: string
  accountNumber: string
  name: string
  phone: string
  balance: number
  creditLimit: number | null
  status: string
  updatedAt?: string
}

/** Open bar tab summary (GET /tabs/open) */
export interface OpenTabListItem {
  _id: string
  tabNumber: string
  customerName: string
  phone: string
  lineCount: number
  total: number
  updatedAt?: string
}

/** Full open tab (GET /tabs/:id) */
export interface OpenTabDetail {
  _id: string
  tabNumber: string
  customerName: string
  phone: string
  lines: Array<{
    productId: string
    name: string
    quantity: number
    unitPrice: number
    listUnitPrice?: number
  }>
  updatedAt?: string
}
