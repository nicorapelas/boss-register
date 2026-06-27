import { describe, expect, it } from 'vitest'
import {
  cardAmountToApply,
  cartCheckoutDisplay,
  computeCheckoutTenders,
  effectiveCashRoundingAdjustment,
  maxCardTender,
} from './cashRounding'

const rounding10 = { enabled: true, incrementCents: 10 as const, mode: 'nearest' as const }

describe('cartCheckoutDisplay', () => {
  it('shows exact total for card and separate cash payable when rounding applies', () => {
    const d = cartCheckoutDisplay(49.97, 0, rounding10)
    expect(d.exactTotal).toBe(49.97)
    expect(d.cashPayableAmount).toBe(50)
    expect(d.displayTotal).toBe(50)
    expect(d.cashRoundingAdjustment).toBe(0.03)
    expect(d.showCashPayableHint).toBe(true)
  })

  it('hides cash hint when total is already on increment boundary', () => {
    const d = cartCheckoutDisplay(50, 0, rounding10)
    expect(d.exactTotal).toBe(50)
    expect(d.displayTotal).toBe(50)
    expect(d.showCashPayableHint).toBe(false)
  })
})

describe('card checkout with cash rounding enabled', () => {
  it('accepts exact card total without rounding adjustment', () => {
    const state = computeCheckoutTenders({
      merchandiseTotal: 49.97,
      loyaltyDiscount: 0,
      storeCredit: 0,
      onAccount: 0,
      cashReceived: 0,
      cardReceived: 49.97,
      config: rounding10,
    })
    expect(state.cashRoundingAdjustment).toBe(0)
    expect(state.isComplete).toBe(true)
    expect(maxCardTender({
      merchandiseTotal: 49.97,
      loyaltyDiscount: 0,
      storeCredit: 0,
      onAccount: 0,
      cardReceived: 0,
      config: rounding10,
    })).toBe(49.97)
  })

  it('rounds only the cash leg on split tender', () => {
    const state = computeCheckoutTenders({
      merchandiseTotal: 49.97,
      loyaltyDiscount: 0,
      storeCredit: 0,
      onAccount: 0,
      cashReceived: 0,
      cardReceived: 30,
      config: rounding10,
    })
    expect(state.cashAmount).toBe(20)
    expect(state.cashRoundingAdjustment).toBe(0.03)
    expect(state.payableTotal).toBe(50)
  })

  it('settles card at exact due when keypad shows cash-rounded display total', () => {
    const roundingDown = { enabled: true, incrementCents: 10 as const, mode: 'down' as const }
    expect(cardAmountToApply(21.9, 21.95, roundingDown)).toBe(21.95)
    const state = computeCheckoutTenders({
      merchandiseTotal: 21.95,
      loyaltyDiscount: 0,
      storeCredit: 0,
      onAccount: 0,
      cashReceived: 0,
      cardReceived: 21.95,
      config: roundingDown,
    })
    expect(state.cashRoundingAdjustment).toBe(0)
    expect(state.cashAmount).toBe(0)
    expect(state.isComplete).toBe(true)
    expect(effectiveCashRoundingAdjustment(state.cashAmount, state.cashRoundingAdjustment)).toBe(0)
  })

  it('completes card sale with change when keypad exceeds exact due (same as cash over-tender)', () => {
    const noRounding = { enabled: false, incrementCents: 10 as const, mode: 'nearest' as const }
    const state = computeCheckoutTenders({
      merchandiseTotal: 199.85,
      loyaltyDiscount: 0,
      storeCredit: 0,
      onAccount: 0,
      cashReceived: 0,
      cardReceived: 199.9,
      config: noRounding,
    })
    expect(state.cardAmount).toBe(199.85)
    expect(state.changeDue).toBe(0.05)
    expect(state.isComplete).toBe(true)
  })
})
