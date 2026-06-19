import { useCallback, useEffect, useMemo, useRef } from 'react'
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
  loyaltyEntryActive?: boolean
  loyaltyEntryDisplayValue?: string
  loyaltyEntryFocusToken?: number
  loyaltyMasked?: string | null
  loyaltyPointsBalance?: number | null
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

function customerDisplaySyncKey(input: SyncInput): string {
  const cartSig = input.cart.map((l) => `${l.productId}\t${l.quantity}\t${l.name}`).join('\n')
  return JSON.stringify({
    loggedIn: !!input.session,
    storeName: input.storeName,
    idleHeadline: input.storeConfig.idle.headline,
    idleSubtext: input.storeConfig.idle.subtext,
    cartSig,
    cartTotal: input.cartTotal,
    showChangeView: input.showChangeView,
    lastTotal: input.lastTotal,
    lastChangeDue: input.lastChangeDue,
    lastCardAmount: input.lastCardAmount,
    lastTendered: input.lastTendered,
    pendingSplit: input.pendingSplit,
    refundSession: input.refundSession,
    jobCardLabourActive: input.jobCardLabourActive,
    loyaltyEntryActive: input.loyaltyEntryActive,
    loyaltyEntryDisplayValue: input.loyaltyEntryDisplayValue,
    loyaltyEntryFocusToken: input.loyaltyEntryFocusToken,
    loyaltyMasked: input.loyaltyMasked,
    loyaltyPointsBalance: input.loyaltyPointsBalance,
  })
}

export function useCustomerDisplaySync(input: SyncInput): { publishNow: () => void } {
  const prevSessionRef = useRef<boolean>(false)
  const inputRef = useRef(input)
  inputRef.current = input

  const publishNow = useCallback(() => {
    publishCustomerDisplay(buildCustomerDisplaySnapshot(inputRef.current))
  }, [])

  const displaySyncKey = useMemo(() => customerDisplaySyncKey(input), [
    input.session,
    input.storeName,
    input.storeConfig.idle.headline,
    input.storeConfig.idle.subtext,
    input.cart,
    input.cartTotal,
    input.showChangeView,
    input.lastTotal,
    input.lastChangeDue,
    input.lastCardAmount,
    input.lastTendered,
    input.pendingSplit,
    input.refundSession,
    input.jobCardLabourActive,
    input.loyaltyEntryActive,
    input.loyaltyEntryDisplayValue,
    input.loyaltyEntryFocusToken,
    input.loyaltyMasked,
    input.loyaltyPointsBalance,
  ])

  useEffect(() => {
    const loggedIn = !!input.session
    if (prevSessionRef.current && !loggedIn) {
      clearCustomerDisplaySpotlightSeen()
    }
    if (!prevSessionRef.current && loggedIn) {
      clearCustomerDisplaySpotlightSeen()
    }
    prevSessionRef.current = loggedIn

    publishNow()
  }, [displaySyncKey, publishNow])

  return { publishNow }
}

export function getInitialCustomerDisplayConfig(): CustomerDisplayStoreConfig {
  return readCachedCustomerDisplayConfig()
}
