import { apiFetch, isServerReachable } from '../api/client'
import { isPosManager } from '../auth/permissions'
import type { AuthUser } from '../auth/types'

export type StockOverrideApprover = {
  userId: string
  displayName: string
}

function safeReadOfflinePackUsers(): Array<{
  user: AuthUser
  badgeCode: string | null
}> {
  try {
    const raw = localStorage.getItem('electropos-offline-login-pack-v1')
    if (!raw) return []
    const parsed = JSON.parse(raw) as { users?: Array<{ user: AuthUser; badgeCode: string | null }> }
    return Array.isArray(parsed?.users) ? parsed.users : []
  } catch {
    return []
  }
}

function approverFromUser(user: AuthUser): StockOverrideApprover {
  return {
    userId: user.id,
    displayName: user.displayName?.trim() || user.email,
  }
}

export function verifyManagerBadgeOffline(badgeCode: string): StockOverrideApprover {
  const normalized = badgeCode.trim()
  if (!normalized) throw new Error('Badge code required')
  const match = safeReadOfflinePackUsers().find(
    (entry) =>
      entry.badgeCode?.trim() === normalized ||
      entry.user.email.toLowerCase() === normalized.toLowerCase(),
  )
  if (!match) throw new Error('Invalid badge')
  if (!isPosManager(match.user)) throw new Error('POS manager approval required')
  return approverFromUser(match.user)
}

export async function verifyManagerBadgeForOverride(badgeCode: string): Promise<StockOverrideApprover> {
  if (!isServerReachable()) {
    return verifyManagerBadgeOffline(badgeCode)
  }
  const res = await apiFetch<{ approver: StockOverrideApprover }>('/auth/verify-manager-badge', {
    method: 'POST',
    body: JSON.stringify({ badgeCode }),
  })
  return res.approver
}

export async function verifyManagerFaceForOverride(embedding: number[]): Promise<StockOverrideApprover> {
  if (!isServerReachable()) {
    throw new Error('Manager face approval requires an online connection')
  }
  const res = await apiFetch<{ approver: StockOverrideApprover }>('/auth/verify-manager-face', {
    method: 'POST',
    body: JSON.stringify({ embedding }),
  })
  return res.approver
}
