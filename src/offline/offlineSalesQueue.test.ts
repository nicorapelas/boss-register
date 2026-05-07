import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createClientLocalId,
  enqueueOfflineSale,
  flushOfflineSales,
  getOfflineSalesSyncStatus,
  resolveSyncedSaleLookupId,
} from './offlineSalesQueue'

const apiFetchMock = vi.fn()

vi.mock('../api/client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

function mockElectronOffline() {
  const pendingRows = new Map<string, { payloadJson: string }>()
  ;(window as Window & { electronOffline?: unknown }).electronOffline = {
    enqueueSale: async (clientLocalId: string, payload: unknown) => {
      pendingRows.set(clientLocalId, { payloadJson: JSON.stringify(payload) })
      return { ok: true }
    },
    listPendingSales: async () => ({
      ok: true,
      items: Array.from(pendingRows.entries()).map(([clientLocalId, row]) => ({
        clientLocalId,
        payloadJson: row.payloadJson,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        retryCount: 0,
        lastError: null,
      })),
    }),
    markSaleSynced: async (clientLocalId: string) => {
      pendingRows.delete(clientLocalId)
      return { ok: true }
    },
    markSaleFailed: async () => ({ ok: true }),
    getPendingCount: async () => ({ ok: true, count: pendingRows.size }),
    setCatalog: async () => ({ ok: true }),
    getCatalog: async () => ({ ok: true, products: [], syncedAt: null }),
  }
}

describe('offline sales queue mapping and status', () => {
  beforeEach(() => {
    localStorage.clear()
    apiFetchMock.mockReset()
    mockElectronOffline()
    vi.stubGlobal('navigator', { onLine: true })
  })

  it('resolves offline temp sale id to server sale id after sync', async () => {
    const clientLocalId = createClientLocalId()
    const localTempId = clientLocalId.slice(-10)

    await enqueueOfflineSale(clientLocalId, { items: [{ productId: 'p1', quantity: 1, unitPrice: 10 }] })
    apiFetchMock.mockResolvedValueOnce({
      _id: '6650f67d3ecb4b3d0e9ec123',
      saleId: 'abc123def4',
      cashier: 'u1',
      items: [],
      total: 10,
    })
    await flushOfflineSales(20)

    expect(resolveSyncedSaleLookupId(localTempId)).toBe('abc123def4')
  })

  it('stores last sync error when sync fails', async () => {
    const clientLocalId = createClientLocalId()
    await enqueueOfflineSale(clientLocalId, { items: [{ productId: 'p1', quantity: 1, unitPrice: 10 }] })
    apiFetchMock.mockRejectedValueOnce(new Error('Validation failed'))

    await flushOfflineSales(20)
    const status = getOfflineSalesSyncStatus()
    expect(status.lastAttemptAt).toBeTruthy()
    expect(status.lastError).toContain('Validation failed')
  })
})
