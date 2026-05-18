import { DEFAULT_STORE_NAME } from '../brand'
import type { CustomerDisplayStoreConfig } from './types'
import { CUSTOMER_DISPLAY_CONFIG_CACHE_KEY } from './types'

export const DEFAULT_CUSTOMER_DISPLAY_CONFIG: CustomerDisplayStoreConfig = {
  enabled: true,
  idle: { headline: 'Welcome', subtext: '', imageUrl: '' },
  theme: { backgroundColor: '#0f1419', accentColor: '#3b82f6' },
  footerText: 'All prices include VAT',
}

export function readCachedStoreName(): string {
  try {
    return localStorage.getItem('electropos-store-name-cache')?.trim() || DEFAULT_STORE_NAME
  } catch {
    return DEFAULT_STORE_NAME
  }
}

export function writeCachedStoreName(name: string): void {
  try {
    localStorage.setItem('electropos-store-name-cache', name.trim() || DEFAULT_STORE_NAME)
  } catch {
    // ignore
  }
}

export function readCachedCustomerDisplayConfig(): CustomerDisplayStoreConfig {
  try {
    const raw = localStorage.getItem(CUSTOMER_DISPLAY_CONFIG_CACHE_KEY)
    if (!raw) return { ...DEFAULT_CUSTOMER_DISPLAY_CONFIG }
    const parsed = JSON.parse(raw) as Partial<CustomerDisplayStoreConfig>
    return {
      enabled: parsed.enabled !== false,
      idle: {
        headline: String(parsed.idle?.headline ?? DEFAULT_CUSTOMER_DISPLAY_CONFIG.idle.headline),
        subtext: String(parsed.idle?.subtext ?? ''),
        imageUrl: String(parsed.idle?.imageUrl ?? ''),
      },
      theme: {
        backgroundColor: parsed.theme?.backgroundColor ?? DEFAULT_CUSTOMER_DISPLAY_CONFIG.theme.backgroundColor,
        accentColor: parsed.theme?.accentColor ?? DEFAULT_CUSTOMER_DISPLAY_CONFIG.theme.accentColor,
      },
      footerText: String(parsed.footerText ?? DEFAULT_CUSTOMER_DISPLAY_CONFIG.footerText),
    }
  } catch {
    return { ...DEFAULT_CUSTOMER_DISPLAY_CONFIG }
  }
}

export function writeCachedCustomerDisplayConfig(config: CustomerDisplayStoreConfig): void {
  try {
    localStorage.setItem(CUSTOMER_DISPLAY_CONFIG_CACHE_KEY, JSON.stringify(config))
  } catch {
    // ignore quota errors
  }
}
