import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cacheOfflineLoginPack, getOfflineLoginCacheStatus } from './offlineAuth'
import type { AuthUser } from './types'

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'u1',
    email: 'cashier@example.com',
    role: 'cashier',
    permissions: [],
    allowOfflineLogin: true,
    ...overrides,
  }
}

describe('offlineAuth cache status', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useRealTimers()
  })

  it('reports ready when cached users are present', () => {
    cacheOfflineLoginPack([
      {
        user: makeUser(),
        email: 'cashier@example.com',
        badgeCode: 'STAFF-1',
        passwordHash: '$2a$10$dummy',
      },
    ])

    const status = getOfflineLoginCacheStatus()
    expect(status.ready).toBe(true)
    expect(status.userCount).toBe(1)
    expect(status.stale).toBe(false)
    expect(typeof status.fetchedAt).toBe('string')
  })

  it('marks cache stale after 24h', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    cacheOfflineLoginPack([
      {
        user: makeUser(),
        email: 'cashier@example.com',
        badgeCode: 'STAFF-1',
        passwordHash: '$2a$10$dummy',
      },
    ])

    vi.setSystemTime(new Date('2026-01-02T01:00:00.000Z'))
    const status = getOfflineLoginCacheStatus()
    expect(status.ready).toBe(true)
    expect(status.stale).toBe(true)
  })
})
