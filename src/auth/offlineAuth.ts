import type { SessionBundle, AuthUser } from './types'

type OfflineAuthEntry = {
  method: 'badge' | 'password'
  userId: string
  user: AuthUser
  identityHash: string
  secretHash: string
  updatedAt: string
}

const STORAGE_KEY = 'electropos-offline-auth-v1'
const HASH_NAMESPACE = 'electropos-offline-auth'
const OFFLINE_LOGIN_PACK_KEY = 'electropos-offline-login-pack-v1'
const CACHE_STALE_AFTER_MS = 24 * 60 * 60 * 1000

type OfflineLoginPackUser = {
  user: AuthUser
  email: string
  badgeCode: string | null
  passwordHash: string
  updatedAt?: string
}

type OfflineLoginPackStored = {
  users: OfflineLoginPackUser[]
  fetchedAt?: string
}

function safeReadEntries(): OfflineAuthEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as OfflineAuthEntry[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function safeWriteEntries(entries: OfflineAuthEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, 50)))
  } catch {
    // Ignore localStorage quota/private mode failures.
  }
}

function safeReadOfflinePack(): OfflineLoginPackUser[] {
  try {
    const raw = localStorage.getItem(OFFLINE_LOGIN_PACK_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as OfflineLoginPackStored
    return Array.isArray(parsed?.users) ? parsed.users : []
  } catch {
    return []
  }
}

function safeReadOfflinePackStored(): OfflineLoginPackStored {
  try {
    const raw = localStorage.getItem(OFFLINE_LOGIN_PACK_KEY)
    if (!raw) return { users: [] }
    const parsed = JSON.parse(raw) as OfflineLoginPackStored
    return {
      users: Array.isArray(parsed?.users) ? parsed.users : [],
      fetchedAt: typeof parsed?.fetchedAt === 'string' ? parsed.fetchedAt : undefined,
    }
  } catch {
    return { users: [] }
  }
}

function safeWriteOfflinePack(users: OfflineLoginPackUser[]): void {
  try {
    localStorage.setItem(OFFLINE_LOGIN_PACK_KEY, JSON.stringify({ users }))
  } catch {
    // Ignore localStorage quota/private mode failures.
  }
}

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', data)
  const bytes = Array.from(new Uint8Array(digest))
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function hashIdentity(kind: 'badge' | 'password', value: string): Promise<string> {
  return sha256(`${HASH_NAMESPACE}|id|${kind}|${value.trim().toLowerCase()}`)
}

async function hashSecret(kind: 'badge' | 'password', value: string): Promise<string> {
  return sha256(`${HASH_NAMESPACE}|secret|${kind}|${value}`)
}

function upsertEntry(next: OfflineAuthEntry): void {
  const current = safeReadEntries()
  const filtered = current.filter((entry) => !(entry.method === next.method && entry.userId === next.userId))
  filtered.unshift(next)
  safeWriteEntries(filtered)
}

export function forgetOfflineLoginForUser(userId: string): void {
  const id = userId.trim()
  if (!id) return
  const current = safeReadEntries()
  const filtered = current.filter((entry) => entry.userId !== id)
  safeWriteEntries(filtered)
}

export function cacheOfflineLoginPack(users: OfflineLoginPackUser[]): void {
  const filtered = users
    .filter((u) => u?.user?.allowOfflineLogin === true && typeof u.passwordHash === 'string' && u.passwordHash.length > 0)
    .slice(0, 200)
  safeWriteOfflinePack(filtered)
  try {
    localStorage.setItem(
      OFFLINE_LOGIN_PACK_KEY,
      JSON.stringify({
        users: filtered,
        fetchedAt: new Date().toISOString(),
      } satisfies OfflineLoginPackStored),
    )
  } catch {
    // Ignore localStorage quota/private mode failures.
  }
}

export function getOfflineLoginCacheStatus(): {
  ready: boolean
  userCount: number
  fetchedAt?: string
  stale: boolean
} {
  const stored = safeReadOfflinePackStored()
  const users = stored.users.filter((u) => u.user?.allowOfflineLogin === true)
  const fetchedAtMs = stored.fetchedAt ? Date.parse(stored.fetchedAt) : Number.NaN
  const stale = Number.isFinite(fetchedAtMs) ? Date.now() - fetchedAtMs > CACHE_STALE_AFTER_MS : false
  return {
    ready: users.length > 0,
    userCount: users.length,
    fetchedAt: stored.fetchedAt,
    stale,
  }
}

function offlineBundleFromUser(user: AuthUser): SessionBundle {
  return {
    // Placeholder tokens. Online requests will fail/refresh until network is back.
    accessToken: 'offline-session',
    refreshToken: 'offline-session',
    user,
  }
}

export async function rememberPasswordLogin(email: string, password: string, user: AuthUser): Promise<void> {
  if (!user.allowOfflineLogin) {
    forgetOfflineLoginForUser(user.id)
    return
  }
  const identity = email.trim().toLowerCase()
  if (!identity || !password) return
  const identityHash = await hashIdentity('password', identity)
  const secretHash = await hashSecret('password', password)
  upsertEntry({
    method: 'password',
    userId: user.id,
    user,
    identityHash,
    secretHash,
    updatedAt: new Date().toISOString(),
  })
}

export async function rememberBadgeLogin(badgeCode: string, user: AuthUser): Promise<void> {
  if (!user.allowOfflineLogin) {
    forgetOfflineLoginForUser(user.id)
    return
  }
  const badge = badgeCode.trim()
  if (!badge) return
  const identityHash = await hashIdentity('badge', badge)
  const secretHash = await hashSecret('badge', badge)
  upsertEntry({
    method: 'badge',
    userId: user.id,
    user,
    identityHash,
    secretHash,
    updatedAt: new Date().toISOString(),
  })
}

export async function tryOfflinePasswordLogin(email: string, password: string): Promise<SessionBundle | null> {
  let bcryptCompareSync: ((plain: string, hash: string) => boolean) | null = null
  try {
    const mod = await import('bcryptjs')
    bcryptCompareSync = mod.compareSync
  } catch {
    bcryptCompareSync = null
  }

  const packUsers = safeReadOfflinePack()
  const normalizedEmail = email.trim().toLowerCase()
  if (bcryptCompareSync) {
    for (const entry of packUsers) {
      if (entry.user.allowOfflineLogin !== true) continue
      if ((entry.email ?? '').trim().toLowerCase() !== normalizedEmail) continue
      try {
        if (bcryptCompareSync(password, entry.passwordHash)) {
          return offlineBundleFromUser(entry.user)
        }
      } catch {
        // Continue to fallback cache.
      }
    }
  }

  const identity = email.trim().toLowerCase()
  if (!identity || !password) return null
  const [identityHash, secretHash] = await Promise.all([
    hashIdentity('password', identity),
    hashSecret('password', password),
  ])
  const entry = safeReadEntries().find(
    (item) => item.method === 'password' && item.identityHash === identityHash && item.secretHash === secretHash,
  )
  if (!entry || !entry.user.allowOfflineLogin) return null
  return offlineBundleFromUser(entry.user)
}

export async function tryOfflineBadgeLogin(badgeCode: string): Promise<SessionBundle | null> {
  const packUsers = safeReadOfflinePack()
  const normalizedBadge = badgeCode.trim()
  for (const entry of packUsers) {
    if (entry.user.allowOfflineLogin !== true) continue
    if (!entry.badgeCode || entry.badgeCode.trim() !== normalizedBadge) continue
    return offlineBundleFromUser(entry.user)
  }

  const badge = badgeCode.trim()
  if (!badge) return null
  const [identityHash, secretHash] = await Promise.all([hashIdentity('badge', badge), hashSecret('badge', badge)])
  const entry = safeReadEntries().find(
    (item) => item.method === 'badge' && item.identityHash === identityHash && item.secretHash === secretHash,
  )
  if (!entry || !entry.user.allowOfflineLogin) return null
  return offlineBundleFromUser(entry.user)
}
