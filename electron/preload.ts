import { ipcRenderer, contextBridge } from 'electron'

contextBridge.exposeInMainWorld('electronPlatform', process.platform)

contextBridge.exposeInMainWorld('electronApp', {
  quit: () => ipcRenderer.invoke('app:quit'),
})

contextBridge.exposeInMainWorld('ipcRenderer', {
  on(...args: Parameters<typeof ipcRenderer.on>) {
    const [channel, listener] = args
    return ipcRenderer.on(channel, (event, ...rest) => listener(event, ...rest))
  },
  off(...args: Parameters<typeof ipcRenderer.off>) {
    const [channel, ...omit] = args
    return ipcRenderer.off(channel, ...omit)
  },
  send(...args: Parameters<typeof ipcRenderer.send>) {
    const [channel, ...omit] = args
    return ipcRenderer.send(channel, ...omit)
  },
  invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
    const [channel, ...omit] = args
    return ipcRenderer.invoke(channel, ...omit)
  },
})

contextBridge.exposeInMainWorld('electronAuth', {
  setBundle: (json: string) => ipcRenderer.invoke('auth:set', json) as Promise<{ ok: boolean; error?: string }>,
  getBundle: () => ipcRenderer.invoke('auth:get') as Promise<string | null>,
  clear: () => ipcRenderer.invoke('auth:clear') as Promise<{ ok: boolean }>,
})

contextBridge.exposeInMainWorld('electronPos', {
  openDrawer: (transport?: unknown) =>
    ipcRenderer.invoke('pos:drawer:open', transport ? { transport } : undefined) as Promise<{ ok: boolean; error?: string }>,
  kickDrawer: (transport: unknown) =>
    ipcRenderer.invoke('pos:drawer:kick', { transport }) as Promise<{ ok: boolean; error?: string }>,
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
    ) => ipcRenderer.invoke('pos:receipt:print', { transport, receipt, ...opts }) as Promise<{ ok: boolean; error?: string }>,
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
    ) =>
      ipcRenderer.invoke('pos:statement:print', { transport, statement, ...opts }) as Promise<{
        ok: boolean
        error?: string
      }>,
})

contextBridge.exposeInMainWorld('electronCustomerDisplay', {
  listDisplays: () =>
    ipcRenderer.invoke('customer-display:list-displays') as Promise<
      Array<{ id: number; label: string; bounds: Electron.Rectangle; primary: boolean }>
    >,
  listLineDisplays: () =>
    ipcRenderer.invoke('customer-display:list-line-displays') as Promise<
      Array<{ path: string; label: string }>
    >,
  getTillSettings: () =>
    ipcRenderer.invoke('customer-display:get-till-settings') as Promise<{
      enabled: boolean
      driver: 'monitor' | 'ncr-2x20'
      displayId: number | null
      displayBounds: { x: number; y: number; width: number; height: number } | null
      lineDisplayPath: string | null
    }>,
  setTillSettings: (settings: {
    enabled: boolean
    driver: 'monitor' | 'ncr-2x20'
    displayId: number | null
    displayBounds: { x: number; y: number; width: number; height: number } | null
    lineDisplayPath: string | null
  }) =>
    ipcRenderer.invoke('customer-display:set-till-settings', settings) as Promise<{
      ok: boolean
      error?: string
      settings?: {
        enabled: boolean
        driver: 'monitor' | 'ncr-2x20'
        displayId: number | null
        displayBounds: { x: number; y: number; width: number; height: number } | null
        lineDisplayPath: string | null
      }
    }>,
  publish: (snapshot: unknown) => {
    ipcRenderer.send('customer-display:publish', snapshot)
  },
  focusLoyaltyEntry: () =>
    ipcRenderer.invoke('customer-display:focus-loyalty-entry') as Promise<{ ok: boolean }>,
  test: (mode: 'idle' | 'ready' | 'cart' | 'complete') =>
    ipcRenderer.invoke('customer-display:test', mode) as Promise<{ ok: boolean }>,
  testLineDisplay: () =>
    ipcRenderer.invoke('customer-display:test-line-display') as Promise<{
      ok: boolean
      error?: string
      path?: string
    }>,
  getLineDisplayDebug: () =>
    ipcRenderer.invoke('customer-display:get-line-display-debug') as Promise<{
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
    }>,
  onSnapshot: (listener: (snapshot: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: unknown) => listener(snapshot)
    ipcRenderer.on('customer-display:snapshot', handler)
    return () => ipcRenderer.off('customer-display:snapshot', handler)
  },
  onFocusLoyaltyPhone: (listener: () => void) => {
    const handler = () => listener()
    ipcRenderer.on('customer-display:focus-loyalty-phone', handler)
    return () => ipcRenderer.off('customer-display:focus-loyalty-phone', handler)
  },
  sendLoyaltyKey: (action: unknown) => {
    ipcRenderer.send('customer-display:loyalty-key', action)
  },
  onLoyaltyKey: (listener: (action: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: unknown) => listener(action)
    ipcRenderer.on('register:loyalty-key', handler)
    return () => ipcRenderer.off('register:loyalty-key', handler)
  },
})

contextBridge.exposeInMainWorld('electronOffline', {
  enqueueSale: (clientLocalId: string, payload: unknown) =>
    ipcRenderer.invoke('offline:enqueue-sale', { clientLocalId, payload }) as Promise<{ ok: boolean; error?: string }>,
  listPendingSales: (limit = 20) =>
    ipcRenderer.invoke('offline:list-pending-sales', { limit }) as Promise<{
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
    }>,
  markSaleSynced: (clientLocalId: string) =>
    ipcRenderer.invoke('offline:mark-sale-synced', { clientLocalId }) as Promise<{ ok: boolean; error?: string }>,
  markSaleFailed: (clientLocalId: string, error: string) =>
    ipcRenderer.invoke('offline:mark-sale-failed', { clientLocalId, error }) as Promise<{ ok: boolean; error?: string }>,
  getPendingCount: () =>
    ipcRenderer.invoke('offline:pending-count') as Promise<{ ok: boolean; error?: string; count: number }>,
  setCatalog: (products: unknown[], syncedAt?: string, catalogRevision?: number) =>
    ipcRenderer.invoke('offline:catalog:set', { products, syncedAt, catalogRevision }) as Promise<{
      ok: boolean
      error?: string
    }>,
  getCatalog: () =>
    ipcRenderer.invoke('offline:catalog:get') as Promise<{
      ok: boolean
      error?: string
      products: unknown[]
      syncedAt: string | null
      catalogRevision: number | null
    }>,
})
