/** Mirrors server/src/utils/cashRounding.ts — keep in sync. */

export type CashRoundingIncrement = 10 | 20 | 50
export type CashRoundingMode = 'nearest' | 'down' | 'up'

export interface CashRoundingConfig {
  enabled: boolean
  incrementCents: CashRoundingIncrement
  mode: CashRoundingMode
}

export interface CashRoundingSettings {
  enabled?: boolean
  incrementCents?: CashRoundingIncrement
  mode?: CashRoundingMode
}

export const DEFAULT_CASH_ROUNDING: CashRoundingConfig = {
  enabled: false,
  incrementCents: 10,
  mode: 'nearest',
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function cashRoundingFromSettings(
  settings: { cashRounding?: CashRoundingSettings | null } | null | undefined,
): CashRoundingConfig {
  const raw = settings?.cashRounding
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CASH_ROUNDING }
  const incrementRaw = Number(raw.incrementCents)
  const incrementCents: CashRoundingIncrement =
    incrementRaw === 20 ? 20 : incrementRaw === 50 ? 50 : 10
  const modeRaw = String(raw.mode ?? 'nearest')
  const mode: CashRoundingMode =
    modeRaw === 'down' ? 'down' : modeRaw === 'up' ? 'up' : 'nearest'
  return {
    enabled: raw.enabled === true,
    incrementCents,
    mode,
  }
}

export function roundCashAmount(
  amount: number,
  config: CashRoundingConfig,
): { rounded: number; adjustment: number } {
  if (!config.enabled || amount <= 0.005) {
    return { rounded: round2(amount), adjustment: 0 }
  }
  const inc = config.incrementCents
  const cents = Math.round(amount * 100)
  let roundedCents: number
  if (config.mode === 'down') {
    roundedCents = Math.floor(cents / inc) * inc
  } else if (config.mode === 'up') {
    roundedCents = Math.ceil(cents / inc) * inc
  } else {
    roundedCents = Math.round(cents / inc) * inc
  }
  const rounded = round2(roundedCents / 100)
  return { rounded, adjustment: round2(rounded - amount) }
}

export type PaymentSplitInput = {
  merchandiseTotal: number
  loyaltyDiscount?: number
  storeCredit?: number
  onAccount?: number
  cardAmount?: number
  config: CashRoundingConfig
}

export function computeCashPaymentLeg(input: PaymentSplitInput): {
  cashDueExact: number
  cashAmount: number
  cardAmount: number
  cashRoundingAdjustment: number
  payableTotal: number
} {
  const loyaltyDiscount = round2(input.loyaltyDiscount ?? 0)
  const storeCredit = round2(input.storeCredit ?? 0)
  const onAccount = round2(input.onAccount ?? 0)
  const cardAmount = round2(input.cardAmount ?? 0)
  const remainingAfterScOa = round2(input.merchandiseTotal - storeCredit - onAccount - loyaltyDiscount)
  const cardApplied = round2(Math.min(cardAmount, Math.max(0, remainingAfterScOa)))
  const cashDueExact = round2(Math.max(0, remainingAfterScOa - cardApplied))
  const { rounded: cashAmount, adjustment: cashRoundingAdjustment } = roundCashAmount(
    cashDueExact,
    input.config,
  )
  const payableTotal = round2(input.merchandiseTotal + cashRoundingAdjustment)
  return { cashDueExact, cashAmount, cardAmount: cardApplied, cashRoundingAdjustment, payableTotal }
}

export type CheckoutTenderInput = {
  merchandiseTotal: number
  loyaltyDiscount?: number
  storeCredit?: number
  onAccount?: number
  cashReceived: number
  cardReceived: number
  config: CashRoundingConfig
}

export function computeCheckoutTenders(input: CheckoutTenderInput): {
  cashDueExact: number
  cashAmount: number
  cardAmount: number
  cashRoundingAdjustment: number
  payableTotal: number
  covered: number
  amountDue: number
  isComplete: boolean
  changeDue: number
} {
  const loyaltyDiscount = round2(input.loyaltyDiscount ?? 0)
  const storeCredit = round2(input.storeCredit ?? 0)
  const onAccount = round2(input.onAccount ?? 0)
  const leg = computeCashPaymentLeg({
    merchandiseTotal: input.merchandiseTotal,
    loyaltyDiscount,
    storeCredit,
    onAccount,
    cardAmount: input.cardReceived,
    config: input.config,
  })
  const covered = round2(
    input.cashReceived + input.cardReceived + storeCredit + onAccount + loyaltyDiscount,
  )
  const amountDue = round2(Math.max(0, leg.payableTotal - covered))
  const changeDue = round2(Math.max(0, covered - leg.payableTotal))
  return {
    ...leg,
    covered,
    amountDue,
    isComplete: amountDue <= 0.02,
    changeDue,
  }
}

/** Card leg settles at exact merchandise due; keypad may show cash-rounded display total. */
export function cardAmountToApply(
  entered: number,
  exactCardDue: number,
  config: CashRoundingConfig,
): number {
  if (entered > exactCardDue + 0.005) return entered
  if (entered + 0.005 >= exactCardDue) return exactCardDue
  const inc = config.enabled ? config.incrementCents / 100 : 0
  if (inc > 0 && exactCardDue - entered <= inc + 0.005) return exactCardDue
  return entered
}

/** Cash rounding only applies when a cash leg is actually being paid. */
export function effectiveCashRoundingAdjustment(
  cashAmount: number,
  adjustment: number,
): number {
  return cashAmount > 0.005 ? adjustment : 0
}

export function maxCardTender(
  input: Omit<CheckoutTenderInput, 'cashReceived' | 'cardReceived'> & { cardReceived: number },
): number {
  const loyaltyDiscount = round2(input.loyaltyDiscount ?? 0)
  const storeCredit = round2(input.storeCredit ?? 0)
  const onAccount = round2(input.onAccount ?? 0)
  const remainingAfterScOa = round2(
    input.merchandiseTotal - storeCredit - onAccount - loyaltyDiscount,
  )
  return round2(Math.max(0, remainingAfterScOa - input.cardReceived))
}

/** Exact merchandise still due (card / voucher / account — no cash rounding). */
export function exactMerchandiseDue(
  merchandiseTotal: number,
  loyaltyDiscount = 0,
  storeCredit = 0,
  onAccount = 0,
): number {
  return round2(merchandiseTotal - loyaltyDiscount - storeCredit - onAccount)
}

export function checkoutAmountDue(input: CheckoutTenderInput): number {
  return computeCheckoutTenders(input).amountDue
}

export type CartCheckoutDisplay = {
  /** Exact amount due before cash rounding (card / voucher / account). */
  exactTotal: number
  /** Rounded cash leg when the full remainder would be paid in cash. */
  cashPayableAmount: number
  cashRoundingAdjustment: number
  /** Show secondary card-exact hint when rounding would change the cash leg. */
  showCashPayableHint: boolean
  /** Primary register / customer-display total (payable after cash rounding when enabled). */
  displayTotal: number
}

/** Register total area: exact total for card; optional cash-payable hint for cash. */
export function cartCheckoutDisplay(
  merchandiseTotal: number,
  loyaltyDiscount: number,
  config: CashRoundingConfig,
): CartCheckoutDisplay {
  const exactTotal = exactMerchandiseDue(merchandiseTotal, loyaltyDiscount)
  const leg = computeCashPaymentLeg({
    merchandiseTotal,
    loyaltyDiscount,
    storeCredit: 0,
    onAccount: 0,
    cardAmount: 0,
    config,
  })
  const showCashPayableHint =
    config.enabled &&
    leg.cashDueExact > 0.005 &&
    Math.abs(leg.cashAmount - leg.cashDueExact) > 0.005
  return {
    exactTotal,
    cashPayableAmount: leg.cashAmount,
    cashRoundingAdjustment: leg.cashRoundingAdjustment,
    showCashPayableHint,
    displayTotal: leg.payableTotal,
  }
}

/** @deprecated Prefer cartCheckoutDisplay — kept for callers that need legacy payable total. */
export function payableCartTotal(
  merchandiseTotal: number,
  loyaltyDiscount: number,
  config: CashRoundingConfig,
): { payableTotal: number; cashRoundingAdjustment: number } {
  const leg = computeCashPaymentLeg({
    merchandiseTotal,
    loyaltyDiscount,
    storeCredit: 0,
    onAccount: 0,
    cardAmount: 0,
    config,
  })
  return {
    payableTotal: leg.payableTotal,
    cashRoundingAdjustment: leg.cashRoundingAdjustment,
  }
}
