export type CustomerDisplayMode = 'idle' | 'ready' | 'cart' | 'spotlight' | 'complete'

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
  theme?: { backgroundColor: string; accentColor: string }
  spotlight?: { name: string; imageUrl: string }
  complete?: {
    totalPaid: number
    changeDue?: number
    paymentLabel?: string
    token: number
  }
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
