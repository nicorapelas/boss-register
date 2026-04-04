import { app, ipcMain, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

const AUTH_FILE = 'auth-bundle.dat'

function authFilePath() {
  return path.join(app.getPath('userData'), AUTH_FILE)
}

/** Persist session bundle for offline use; prefers OS-backed encryption when available. */
export function registerAuthIpc() {
  ipcMain.handle('auth:set', async (_event, payload: string) => {
    if (typeof payload !== 'string') return { ok: false as const, error: 'invalid_payload' }
    const file = authFilePath()
    if (safeStorage.isEncryptionAvailable()) {
      const buf = safeStorage.encryptString(payload)
      fs.writeFileSync(file, buf)
    } else {
      fs.writeFileSync(file, payload, 'utf8')
    }
    return { ok: true as const }
  })

  ipcMain.handle('auth:get', async () => {
    const file = authFilePath()
    if (!fs.existsSync(file)) return null
    const raw = fs.readFileSync(file)
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(raw)
      }
      return raw.toString('utf8')
    } catch {
      return null
    }
  })

  ipcMain.handle('auth:clear', async () => {
    const file = authFilePath()
    if (fs.existsSync(file)) fs.unlinkSync(file)
    return { ok: true as const }
  })
}
