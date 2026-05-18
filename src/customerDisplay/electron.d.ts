import type { CustomerDisplaySnapshot } from './types'

export type CustomerDisplayTillSettings = {
  enabled: boolean
  displayId: number | null
}

declare global {
  interface Window {
    electronCustomerDisplay?: {
      listDisplays: () => Promise<
        Array<{ id: number; label: string; bounds: Electron.Rectangle; primary: boolean }>
      >
      getTillSettings: () => Promise<CustomerDisplayTillSettings>
      setTillSettings: (settings: CustomerDisplayTillSettings) => Promise<{
        ok: boolean
        error?: string
        settings?: CustomerDisplayTillSettings
      }>
      publish: (snapshot: CustomerDisplaySnapshot) => Promise<{ ok: boolean }>
      test: (mode: 'idle' | 'ready' | 'cart' | 'complete') => Promise<{ ok: boolean }>
      onSnapshot: (listener: (snapshot: CustomerDisplaySnapshot) => void) => () => void
    }
  }
}

export {}
