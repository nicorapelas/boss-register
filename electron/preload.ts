import { ipcRenderer, contextBridge } from 'electron'

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
  printReceipt: (transport: unknown, receipt: unknown, opts?: { columns?: number; cut?: boolean }) =>
    ipcRenderer.invoke('pos:receipt:print', { transport, receipt, ...opts }) as Promise<{ ok: boolean; error?: string }>,
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
})
