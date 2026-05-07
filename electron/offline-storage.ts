import path from 'node:path'
import { app, ipcMain } from 'electron'
import Database from 'better-sqlite3'

type QueuedSaleRecord = {
  clientLocalId: string
  payloadJson: string
  createdAt: string
  updatedAt: string
  retryCount: number
  lastError: string | null
}

let db: Database.Database | null = null

function nowIso(): string {
  return new Date().toISOString()
}

function getDb(): Database.Database {
  if (db) return db
  const dbPath = path.join(app.getPath('userData'), 'pos-offline.db')
  const instance = new Database(dbPath)
  instance.pragma('journal_mode = WAL')
  instance.pragma('synchronous = NORMAL')
  instance.exec(`
    CREATE TABLE IF NOT EXISTS queued_sales (
      client_local_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_queued_sales_created_at ON queued_sales(created_at);

    CREATE TABLE IF NOT EXISTS local_cache (
      key TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  db = instance
  return instance
}

export function registerOfflineIpc() {
  ipcMain.handle('offline:enqueue-sale', async (_evt, args: { clientLocalId?: unknown; payload?: unknown } | undefined) => {
    const clientLocalId = typeof args?.clientLocalId === 'string' ? args.clientLocalId.trim() : ''
    const payload = args?.payload
    if (!clientLocalId || !payload || typeof payload !== 'object') {
      return { ok: false, error: 'Invalid offline sale payload' }
    }
    try {
      const ts = nowIso()
      const payloadJson = JSON.stringify(payload)
      const conn = getDb()
      const stmt = conn.prepare(`
        INSERT INTO queued_sales (client_local_id, payload_json, created_at, updated_at, retry_count, last_error)
        VALUES (?, ?, ?, ?, 0, NULL)
        ON CONFLICT(client_local_id) DO UPDATE SET
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
      `)
      stmt.run(clientLocalId, payloadJson, ts, ts)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Failed to queue offline sale' }
    }
  })

  ipcMain.handle('offline:list-pending-sales', async (_evt, args: { limit?: unknown } | undefined) => {
    try {
      const limitRaw = Number(args?.limit ?? 20)
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.floor(limitRaw))) : 20
      const conn = getDb()
      const rows = conn
        .prepare(
          `
          SELECT client_local_id, payload_json, created_at, updated_at, retry_count, last_error
          FROM queued_sales
          ORDER BY created_at ASC
          LIMIT ?
        `,
        )
        .all(limit) as Array<{
        client_local_id: string
        payload_json: string
        created_at: string
        updated_at: string
        retry_count: number
        last_error: string | null
      }>
      const items: QueuedSaleRecord[] = rows.map((row) => ({
        clientLocalId: row.client_local_id,
        payloadJson: row.payload_json,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        retryCount: row.retry_count,
        lastError: row.last_error,
      }))
      return { ok: true, items }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Failed to list queued sales', items: [] }
    }
  })

  ipcMain.handle('offline:mark-sale-synced', async (_evt, args: { clientLocalId?: unknown } | undefined) => {
    const clientLocalId = typeof args?.clientLocalId === 'string' ? args.clientLocalId.trim() : ''
    if (!clientLocalId) return { ok: false, error: 'Missing clientLocalId' }
    try {
      const conn = getDb()
      conn.prepare(`DELETE FROM queued_sales WHERE client_local_id = ?`).run(clientLocalId)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Failed to mark sale synced' }
    }
  })

  ipcMain.handle(
    'offline:mark-sale-failed',
    async (_evt, args: { clientLocalId?: unknown; error?: unknown } | undefined) => {
      const clientLocalId = typeof args?.clientLocalId === 'string' ? args.clientLocalId.trim() : ''
      if (!clientLocalId) return { ok: false, error: 'Missing clientLocalId' }
      const errText = typeof args?.error === 'string' ? args.error.slice(0, 500) : 'Sync failed'
      try {
        const conn = getDb()
        conn
          .prepare(
            `
            UPDATE queued_sales
            SET retry_count = retry_count + 1,
                last_error = ?,
                updated_at = ?
            WHERE client_local_id = ?
          `,
          )
          .run(errText, nowIso(), clientLocalId)
        return { ok: true }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'Failed to update queued sale' }
      }
    },
  )

  ipcMain.handle('offline:pending-count', async () => {
    try {
      const conn = getDb()
      const row = conn.prepare(`SELECT COUNT(*) as count FROM queued_sales`).get() as { count: number }
      return { ok: true, count: Number(row.count ?? 0) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Failed to fetch pending count', count: 0 }
    }
  })

  ipcMain.handle('offline:catalog:set', async (_evt, args: { products?: unknown; syncedAt?: unknown } | undefined) => {
    const products = args?.products
    if (!Array.isArray(products)) return { ok: false, error: 'Invalid products payload' }
    const syncedAt = typeof args?.syncedAt === 'string' ? args.syncedAt : nowIso()
    try {
      const conn = getDb()
      conn
        .prepare(
          `
          INSERT INTO local_cache (key, payload_json, updated_at)
          VALUES ('products', ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at
        `,
        )
        .run(JSON.stringify(products), syncedAt)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Failed to cache catalog' }
    }
  })

  ipcMain.handle('offline:catalog:get', async () => {
    try {
      const conn = getDb()
      const row = conn
        .prepare(
          `
          SELECT payload_json, updated_at
          FROM local_cache
          WHERE key = 'products'
        `,
        )
        .get() as { payload_json: string; updated_at: string } | undefined
      if (!row) return { ok: true, products: [], syncedAt: null }
      let products: unknown[] = []
      try {
        products = JSON.parse(row.payload_json) as unknown[]
      } catch {
        products = []
      }
      return { ok: true, products, syncedAt: row.updated_at }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Failed to read cached catalog', products: [], syncedAt: null }
    }
  })
}
