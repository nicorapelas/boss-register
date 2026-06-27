/** Resolve customer-display idle image URL from store settings. */
export function resolveStoreIdleImageUrl(idle?: {
  imageUrl?: string
  idleImageRevision?: number
}): string {
  const rev = idle?.idleImageRevision ?? 0
  if (rev > 0) {
    const base = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ?? ''
    return base ? `${base}/settings/store/idle-image?v=${rev}` : ''
  }
  return idle?.imageUrl?.trim() ?? ''
}
