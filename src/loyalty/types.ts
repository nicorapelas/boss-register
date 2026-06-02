export type LoyaltyProgramConfig = {
  enabled: boolean
  pointsPerRand: number
  redeemValuePerPoint: number
  minRedeemPoints: number
  maxRedeemPercent: number
}

export type LoyaltyLookupResponse = {
  memberId: string | null
  phoneMasked: string
  pointsBalance: number
  program: LoyaltyProgramConfig
  isNew?: boolean
}

export type LoyaltyPurchaseRow = {
  _id: string
  saleId?: string
  createdAt?: string
  tillCode?: string
  total: number
  paymentMethod?: string
  itemCount: number
  loyaltyDiscountAmount?: number
  loyaltyPointsEarned?: number
  loyaltyPointsRedeemed?: number
  refundStatus?: 'partial' | 'refunded'
}

export type LoyaltyPurchaseListResponse = {
  total: number
  purchases: LoyaltyPurchaseRow[]
}

export type LoyaltyKeyAction =
  | { type: 'digit'; digit: string }
  | { type: 'backspace' }
  | { type: 'clear' }
  | { type: 'confirm' }
  | { type: 'cancel' }
