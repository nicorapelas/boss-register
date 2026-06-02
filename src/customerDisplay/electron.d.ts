import type { CustomerDisplaySnapshot } from './types'

export type CustomerDisplayBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type CustomerDisplayTillSettings = {
  enabled: boolean
  displayId: number | null
  displayBounds: CustomerDisplayBounds | null
}

declare global {
  interface Window {
    electronCustomerDisplay?: {
      listDisplays: () => Promise<
        Array<{
          id: number
          label: string
          bounds: CustomerDisplayBounds
          primary: boolean
        }>
      >
      getTillSettings: () => Promise<CustomerDisplayTillSettings>
      setTillSettings: (settings: CustomerDisplayTillSettings) => Promise<{
        ok: boolean
        error?: string
        settings?: CustomerDisplayTillSettings
      }>
      publish: (snapshot: CustomerDisplaySnapshot) => Promise<{ ok: boolean }>
      focusLoyaltyEntry: () => Promise<{ ok: boolean }>
      test: (mode: 'idle' | 'ready' | 'cart' | 'complete') => Promise<{ ok: boolean }>
      onSnapshot: (listener: (snapshot: CustomerDisplaySnapshot) => void) => () => void
      onFocusLoyaltyPhone: (listener: () => void) => () => void
      sendLoyaltyKey: (action: unknown) => void
      onLoyaltyKey: (listener: (action: unknown) => void) => () => void
    }
  }
}

export {}
