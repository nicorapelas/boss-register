import { apiFetch } from '../api/client'

const POS_TILL_CODE = (import.meta.env.VITE_POS_TILL_CODE?.trim().toUpperCase() || 'T1').slice(0, 24)
const APP_VERSION = import.meta.env.VITE_APP_VERSION || '0.0.0'

export type PosTerminalHeartbeatPayload = {
  tillCode: string
  appVersion?: string
  platform?: string
  hostname?: string
  catalogRevision?: number
}

export type PosTerminalStatus = {
  tillCode: string
  displayName?: string
  lastSeenAt: string
  lastIp?: string
  appVersion?: string
  platform?: string
  hostname?: string
  cashierUserId?: string
  cashierDisplayName?: string
  catalogRevision?: number
  online: boolean
  openShiftId?: string
  openShiftOpenedAt?: string
}

export function posTillCode(): string {
  return POS_TILL_CODE
}

export function posAppVersion(): string {
  return APP_VERSION
}

export function buildTerminalHeartbeatBody(catalogRevision?: number | null): PosTerminalHeartbeatPayload {
  const platform =
    typeof window !== 'undefined' && window.electronPlatform
      ? String(window.electronPlatform)
      : typeof navigator !== 'undefined'
        ? navigator.platform
        : undefined
  return {
    tillCode: POS_TILL_CODE,
    appVersion: APP_VERSION,
    platform,
    hostname: typeof window !== 'undefined' ? window.location.hostname || undefined : undefined,
    ...(catalogRevision != null && Number.isFinite(catalogRevision) ? { catalogRevision } : {}),
  }
}

export async function sendPosTerminalHeartbeat(catalogRevision?: number | null): Promise<PosTerminalStatus> {
  return apiFetch<PosTerminalStatus>('/terminals/heartbeat', {
    method: 'POST',
    body: JSON.stringify(buildTerminalHeartbeatBody(catalogRevision)),
  })
}
