export interface Product {
  _id: string
  name: string
  sku: string
  barcode?: string | null
  price: number
  stock: number
  /** Units reserved on active lay-bys (server) */
  layByReservedQty?: number
  /** stock − layByReservedQty */
  availableQty?: number
}

export type CartLine = {
  productId: string
  name: string
  quantity: number
  unitPrice: number
  listUnitPrice?: number
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
  lineTotal: number
}

export interface Sale {
  _id: string
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
  /** Charged to house / on-account (AR) */
  onAccountAmount?: number
  houseAccountId?: string
  houseAccountNumber?: string
  houseAccountName?: string
  createdAt?: string
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
