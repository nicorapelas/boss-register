/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string
  readonly VITE_APP_VERSION: string
  readonly VITE_POS_TILL_CODE?: string
  /** ncr | posiflex — receipt printer connection defaults for this till build */
  readonly VITE_POS_TERMINAL_PROFILE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface Window {
  electronPlatform?: NodeJS.Platform
  electronApp?: {
    quit: () => Promise<void>
  }
  ipcRenderer?: import('electron').IpcRenderer
  electronAuth?: {
    setBundle: (json: string) => Promise<{ ok: boolean; error?: string }>
    getBundle: () => Promise<string | null>
    clear: () => Promise<{ ok: boolean }>
  }
  electronPos?: {
    openDrawer: (transport?: unknown) => Promise<{ ok: boolean; error?: string }>
    kickDrawer: (transport: unknown) => Promise<{ ok: boolean; error?: string }>
    printReceipt: (
      transport: unknown,
      receipt: unknown,
      opts?: {
        columns?: number
        cut?: boolean
        printDensity?: 'light' | 'normal' | 'dark'
        lineSpacing?: number
        headerBold?: boolean
        skipHardwareLeftMargin?: boolean
      },
    ) => Promise<{ ok: boolean; error?: string }>
    printHouseAccountStatement: (
      transport: unknown,
      statement: unknown,
      opts?: {
        columns?: number
        cut?: boolean
        printDensity?: 'light' | 'normal' | 'dark'
        lineSpacing?: number
        skipHardwareLeftMargin?: boolean
      },
    ) => Promise<{ ok: boolean; error?: string }>
  }
  electronOffline?: {
    enqueueSale: (clientLocalId: string, payload: unknown) => Promise<{ ok: boolean; error?: string }>
    listPendingSales: (limit?: number) => Promise<{
      ok: boolean
      error?: string
      items: Array<{
        clientLocalId: string
        payloadJson: string
        createdAt: string
        updatedAt: string
        retryCount: number
        lastError: string | null
      }>
    }>
    markSaleSynced: (clientLocalId: string) => Promise<{ ok: boolean; error?: string }>
    markSaleFailed: (clientLocalId: string, error: string) => Promise<{ ok: boolean; error?: string }>
    getPendingCount: () => Promise<{ ok: boolean; error?: string; count: number }>
    setCatalog: (
      products: unknown[],
      syncedAt?: string,
      catalogRevision?: number,
    ) => Promise<{ ok: boolean; error?: string }>
    getCatalog: () => Promise<{
      ok: boolean
      error?: string
      products: unknown[]
      syncedAt: string | null
      catalogRevision: number | null
    }>
  }
}
