import type { CustomerDisplaySnapshot } from './types'

export type CustomerDisplayBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type CustomerDisplayDriver = 'monitor' | 'ncr-2x20'

export type CustomerDisplayTillSettings = {
  enabled: boolean
  driver: CustomerDisplayDriver
  displayId: number | null
  displayBounds: CustomerDisplayBounds | null
  lineDisplayPath: string | null
}

export type CustomerDisplayLineDevice = {
  path: string
  label: string
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
      listLineDisplays: () => Promise<CustomerDisplayLineDevice[]>
      getTillSettings: () => Promise<CustomerDisplayTillSettings>
      setTillSettings: (settings: CustomerDisplayTillSettings) => Promise<{
        ok: boolean
        error?: string
        settings?: CustomerDisplayTillSettings
      }>
      publish: (snapshot: CustomerDisplaySnapshot) => void
      focusLoyaltyEntry: () => Promise<{ ok: boolean }>
      test: (mode: 'idle' | 'ready' | 'cart' | 'complete') => Promise<{ ok: boolean }>
      testLineDisplay: () => Promise<{ ok: boolean; error?: string; path?: string }>
      getLineDisplayDebug: () => Promise<{
        driverVersion: string
        hidReportSize: number
        lastSnapshotMode: string | null
        lastLineCount: number
        lastTotal: number | null
        mappedLine1: string
        mappedLine2: string
        lastWrittenLine1: string
        lastWrittenLine2: string
        lastError: string | null
        writeCount: number
        skippedDuplicate: number
      }>
      onSnapshot: (listener: (snapshot: CustomerDisplaySnapshot) => void) => () => void
      onFocusLoyaltyPhone: (listener: () => void) => () => void
      sendLoyaltyKey: (action: unknown) => void
      onLoyaltyKey: (listener: (action: unknown) => void) => () => void
    }
  }
}

export {}
