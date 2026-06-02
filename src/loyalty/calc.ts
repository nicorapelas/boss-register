import type { LoyaltyProgramConfig } from './types'

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function discountForPoints(points: number, program: LoyaltyProgramConfig): number {
  if (points <= 0 || program.redeemValuePerPoint <= 0) return 0
  return round2(points * program.redeemValuePerPoint)
}

export function maxRedeemPointsForSale(
  saleTotal: number,
  memberBalance: number,
  program: LoyaltyProgramConfig,
): number {
  if (!program.enabled || saleTotal <= 0.005 || memberBalance < program.minRedeemPoints) return 0
  const capByPercent = Math.floor((saleTotal * (program.maxRedeemPercent / 100)) / program.redeemValuePerPoint)
  return Math.max(0, Math.min(Math.floor(memberBalance), capByPercent))
}
