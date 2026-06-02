export type CustomerDisplayMode = 'idle' | 'ready' | 'cart' | 'spotlight' | 'complete' | 'loyalty-entry'

export type CustomerDisplayLoyaltyEntry = {
  headline: string
  subtext: string
  /** Digits entered so far (customer sees masked display string from POS). */
  displayValue: string
  maxLength: number
}

export type CustomerDisplaySnapshot = {
  mode: CustomerDisplayMode
  storeName: string
  idle?: {
    headline: string
    subtext: string
    imageUrl: string
    backgroundColor: string
    accentColor: string
    footerText: string
  }
  lines?: Array<{ name: string; quantity: number; lineTotal: number }>
  total?: number
  footerText?: string
  theme?: { backgroundColor: string; accentColor: string; textColor?: string }
  spotlight?: { name: string; imageUrl: string }
  complete?: {
    totalPaid: number
    changeDue?: number
    paymentLabel?: string
    token: number
  }
  loyaltyEntry?: CustomerDisplayLoyaltyEntry
  /** Bumped when till requests focus on the loyalty phone field (customer display). */
  loyaltyEntryFocusToken?: number
  /** Shown on cart after loyalty linked (masked). */
  loyaltyMasked?: string
  loyaltyPointsBalance?: number
}

export type CustomerDisplayStoreConfig = {
  enabled: boolean
  idle: {
    headline: string
    subtext: string
    imageUrl: string
  }
  theme: {
    backgroundColor: string
    accentColor: string
  }
  footerText: string
}

export const CUSTOMER_DISPLAY_COMPLETE_MS = 7000
export const CUSTOMER_DISPLAY_SPOTLIGHT_MS = 1500

export const CUSTOMER_DISPLAY_CONFIG_CACHE_KEY = 'electropos-customer-display-config-v1'
