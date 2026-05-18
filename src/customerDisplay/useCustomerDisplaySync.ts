import { useEffect, useRef } from 'react'
import { apiFetch } from '../api/client'
import type { CartLine, Product, StoreSettings } from '../api/types'
import type { SessionBundle } from '../auth/types'
import { buildCustomerDisplaySnapshot, storeConfigFromSettings } from './buildSnapshot'
import {
  readCachedCustomerDisplayConfig,
  writeCachedCustomerDisplayConfig,
  writeCachedStoreName,
} from './configCache'
import { DEFAULT_STORE_NAME } from '../brand'
import type { CustomerDisplayStoreConfig } from './types'
import { publishCustomerDisplay } from './publish'
import { clearCustomerDisplaySpotlightSeen } from './spotlight'

type SyncInput = {
  session: SessionBundle | null
  storeConfig: CustomerDisplayStoreConfig
  storeName: string
  cart: CartLine[]
  cartTotal: number
  productsById: Map<string, Product>
  showChangeView: boolean
  lastTotal: number | null
  lastChangeDue: number | null
  lastCardAmount: number | null
  lastTendered: number | null
  pendingSplit: boolean
  refundSession: boolean
  jobCardLabourActive: boolean
}

export function useCustomerDisplaySettingsLoader(session: SessionBundle | null) {
  useEffect(() => {
    if (!session) return
    let cancelled = false
    void apiFetch<StoreSettings>('/settings/store')
      .then((s) => {
        if (cancelled) return
        const cfg = storeConfigFromSettings(s)
        writeCachedCustomerDisplayConfig(cfg)
        writeCachedStoreName(s.storeName ?? DEFAULT_STORE_NAME)
      })
      .catch(() => {
        // keep cached config
      })
    return () => {
      cancelled = true
    }
  }, [session?.accessToken])
}

export function useCustomerDisplaySync(input: SyncInput): void {
  const prevSessionRef = useRef<boolean>(false)

  useEffect(() => {
    const loggedIn = !!input.session
    if (prevSessionRef.current && !loggedIn) {
      clearCustomerDisplaySpotlightSeen()
    }
    if (!prevSessionRef.current && loggedIn) {
      clearCustomerDisplaySpotlightSeen()
    }
    prevSessionRef.current = loggedIn

    const snapshot = buildCustomerDisplaySnapshot(input)
    publishCustomerDisplay(snapshot)
  }, [
    input.session,
    input.storeName,
    input.storeConfig,
    input.cart,
    input.cartTotal,
    input.productsById,
    input.showChangeView,
    input.lastTotal,
    input.lastChangeDue,
    input.lastCardAmount,
    input.lastTendered,
    input.pendingSplit,
    input.refundSession,
    input.jobCardLabourActive,
  ])
}

export function getInitialCustomerDisplayConfig(): CustomerDisplayStoreConfig {
  return readCachedCustomerDisplayConfig()
}
