import { apiFetch } from '../api/client'
import type { Sale } from '../api/types'

type QueuedSaleRow = {
  clientLocalId: string
  payloadJson: string
  createdAt: string
  updatedAt: string
  retryCount: number
  lastError: string | null
}

export type OfflineSyncedItemSummary = {
  productId: string
  name: string
  qty: number
}

const OFFLINE_SALE_ID_MAP_KEY = 'electropos-offline-sale-id-map-v1'
const OFFLINE_SYNC_STATUS_KEY = 'electropos-offline-sync-status-v1'

type OfflineSaleIdMapEntry = {
  clientLocalId: string
  localTempSaleId: string
  serverSaleId?: string
  serverMongoId?: string
  syncedAt?: string
}

type OfflineSyncStatus = {
  lastAttemptAt?: string
  lastSuccessAt?: string
  lastError?: string
}

type OfflineConflictLine = {
  productId: string
  name: string
  qty: number
}

function isNetworkError(err: unknown): boolean {
  if (typeof err === 'string') {
    const msg = err.toLowerCase()
    return msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('load failed')
  }
  if (err && typeof err === 'object') {
    const maybeMessage = 'message' in err ? String((err as { message?: unknown }).message ?? '') : ''
    const maybeCause =
      'cause' in err && (err as { cause?: unknown }).cause != null ? String((err as { cause?: unknown }).cause) : ''
    const text = `${maybeMessage} ${maybeCause}`.toLowerCase()
    if (text.includes('failed to fetch') || text.includes('networkerror') || text.includes('load failed')) return true
  }
  const fallback = String(err ?? '').toLowerCase()
  return fallback.includes('failed to fetch') || fallback.includes('networkerror') || fallback.includes('load failed')
}

export function createClientLocalId(): string {
  const rand = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Math.random()}`
  return `pos-${Date.now()}-${rand}`
}

function safeReadIdMap(): Record<string, OfflineSaleIdMapEntry> {
  try {
    const raw = localStorage.getItem(OFFLINE_SALE_ID_MAP_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, OfflineSaleIdMapEntry>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function safeWriteIdMap(map: Record<string, OfflineSaleIdMapEntry>): void {
  try {
    localStorage.setItem(OFFLINE_SALE_ID_MAP_KEY, JSON.stringify(map))
  } catch {
    // Ignore quota/private mode failures; refund lookup fallback remains server-side.
  }
}

function tempSaleIdFromClientLocalId(clientLocalId: string): string {
  return clientLocalId.slice(-10)
}

function readSyncStatus(): OfflineSyncStatus {
  try {
    const raw = localStorage.getItem(OFFLINE_SYNC_STATUS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as OfflineSyncStatus
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeSyncStatus(next: OfflineSyncStatus): void {
  try {
    localStorage.setItem(OFFLINE_SYNC_STATUS_KEY, JSON.stringify(next))
  } catch {
    // Ignore localStorage quota/private mode failures.
  }
}

export async function enqueueOfflineSale(clientLocalId: string, payload: Record<string, unknown>): Promise<void> {
  if (!window.electronOffline) throw new Error('Offline queue is unavailable in browser mode')
  const resp = await window.electronOffline.enqueueSale(clientLocalId, payload)
  if (!resp.ok) throw new Error(resp.error ?? 'Could not queue offline sale')
  const map = safeReadIdMap()
  map[clientLocalId] = {
    ...map[clientLocalId],
    clientLocalId,
    localTempSaleId: tempSaleIdFromClientLocalId(clientLocalId),
  }
  safeWriteIdMap(map)
}

export async function flushOfflineSales(limit = 20): Promise<{
  synced: number
  skipped: number
  failed: number
  syncedItems: OfflineSyncedItemSummary[]
}> {
  writeSyncStatus({ ...readSyncStatus(), lastAttemptAt: new Date().toISOString() })
  if (!window.electronOffline || !navigator.onLine) return { synced: 0, skipped: 0, failed: 0, syncedItems: [] }
  const pending = await window.electronOffline.listPendingSales(Math.max(limit, 100))
  if (!pending.ok) return { synced: 0, skipped: 0, failed: 0, syncedItems: [] }
  let rows = pending.items as QueuedSaleRow[]
  const tillCode = (localStorage.getItem('electropos-pos-till-code') ?? '').trim().toUpperCase()
  if (tillCode) {
    try {
      const requested = await apiFetch<{ clientLocalIds: string[] }>(
        `/sales/offline-conflicts/retry-requests?tillCode=${encodeURIComponent(tillCode)}`,
      )
      const requestedSet = new Set((requested.clientLocalIds ?? []).map((x) => String(x)))
      if (requestedSet.size > 0) {
        rows = [...rows].sort((a, b) => {
          const ap = requestedSet.has(a.clientLocalId) ? 0 : 1
          const bp = requestedSet.has(b.clientLocalId) ? 0 : 1
          if (ap !== bp) return ap - bp
          return a.createdAt.localeCompare(b.createdAt)
        })
      }
    } catch {
      // Non-blocking: regular queue order still works.
    }
  }
  rows = rows.slice(0, limit)

  let synced = 0
  let skipped = 0
  let failed = 0
  const syncedItemsMap = new Map<string, OfflineSyncedItemSummary>()

  for (const row of rows) {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(row.payloadJson) as Record<string, unknown>
    } catch {
      failed += 1
      await window.electronOffline.markSaleFailed(row.clientLocalId, 'Corrupt payload JSON')
      continue
    }

    try {
      const syncedSale = await apiFetch<Sale>('/sales', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      try {
        await apiFetch(`/sales/offline-conflicts/by-client/${encodeURIComponent(row.clientLocalId)}/resolve`, {
          method: 'POST',
        })
      } catch {
        // Non-blocking: sale already synced.
      }
      const rawItems = Array.isArray(payload.items) ? payload.items : []
      for (const rawItem of rawItems) {
        if (!rawItem || typeof rawItem !== 'object') continue
        const item = rawItem as { productId?: unknown; quantity?: unknown; name?: unknown }
        const productId = typeof item.productId === 'string' ? item.productId : ''
        if (!productId) continue
        const qty = Number(item.quantity ?? 0)
        if (!Number.isFinite(qty) || qty <= 0) continue
        const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : productId
        const existing = syncedItemsMap.get(productId)
        if (existing) {
          existing.qty += qty
        } else {
          syncedItemsMap.set(productId, { productId, name, qty })
        }
      }
      const map = safeReadIdMap()
      const existing = map[row.clientLocalId] ?? {
        clientLocalId: row.clientLocalId,
        localTempSaleId: tempSaleIdFromClientLocalId(row.clientLocalId),
      }
      map[row.clientLocalId] = {
        ...existing,
        serverSaleId: typeof syncedSale.saleId === 'string' ? syncedSale.saleId : undefined,
        serverMongoId: typeof syncedSale._id === 'string' ? syncedSale._id : undefined,
        syncedAt: new Date().toISOString(),
      }
      safeWriteIdMap(map)
      await window.electronOffline.markSaleSynced(row.clientLocalId)
      writeSyncStatus({ ...readSyncStatus(), lastSuccessAt: new Date().toISOString(), lastError: undefined })
      synced += 1
    } catch (e) {
      if (isNetworkError(e)) {
        writeSyncStatus({ ...readSyncStatus(), lastError: 'Network unreachable during sync' })
        skipped += 1
        break
      }
      failed += 1
      writeSyncStatus({
        ...readSyncStatus(),
        lastError: e instanceof Error ? e.message : 'Failed to sync offline sale',
      })
      await window.electronOffline.markSaleFailed(
        row.clientLocalId,
        e instanceof Error ? e.message : 'Failed to sync offline sale',
      )
      const rawItems = Array.isArray(payload.items) ? payload.items : []
      const conflictLinesMap = new Map<string, OfflineConflictLine>()
      for (const rawItem of rawItems) {
        if (!rawItem || typeof rawItem !== 'object') continue
        const item = rawItem as { productId?: unknown; quantity?: unknown; name?: unknown }
        const productId = typeof item.productId === 'string' ? item.productId : ''
        if (!productId) continue
        const qty = Number(item.quantity ?? 0)
        if (!Number.isFinite(qty) || qty <= 0) continue
        const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : productId
        const existing = conflictLinesMap.get(productId)
        if (existing) existing.qty += qty
        else conflictLinesMap.set(productId, { productId, name, qty })
      }
      try {
        await apiFetch('/sales/offline-conflicts', {
          method: 'POST',
          body: JSON.stringify({
            clientLocalId: row.clientLocalId,
            tillCode: (payload as { tillCode?: unknown }).tillCode,
            scope: 'offline',
            errorMessage: e instanceof Error ? e.message : 'Failed to sync offline sale',
            lines: Array.from(conflictLinesMap.values()),
          }),
        })
      } catch {
        // Non-blocking: local queue remains source of truth on this till.
      }
    }
  }

  return { synced, skipped, failed, syncedItems: Array.from(syncedItemsMap.values()) }
}

export async function flushOfflineSalesWithTillCode(tillCode: string, limit = 20) {
  try {
    localStorage.setItem('electropos-pos-till-code', tillCode.trim().toUpperCase())
  } catch {
    // Ignore storage failures.
  }
  return flushOfflineSales(limit)
}

export async function getOfflinePendingSalesCount(): Promise<number> {
  if (!window.electronOffline) return 0
  const resp = await window.electronOffline.getPendingCount()
  if (!resp.ok) return 0
  return Math.max(0, Number(resp.count ?? 0))
}

export function isLikelyNetworkError(err: unknown): boolean {
  return isNetworkError(err)
}

export function resolveSyncedSaleLookupId(inputId: string): string {
  const id = inputId.trim()
  if (!id) return id
  const map = safeReadIdMap()
  const entries = Object.values(map)
  const match =
    map[id] ??
    entries.find(
      (entry) =>
        entry.localTempSaleId === id || entry.serverSaleId === id || entry.serverMongoId === id || entry.clientLocalId === id,
    )
  if (!match) return id
  return match.serverSaleId || match.serverMongoId || match.clientLocalId || id
}

export function getOfflineSalesSyncStatus(): OfflineSyncStatus {
  return readSyncStatus()
}
