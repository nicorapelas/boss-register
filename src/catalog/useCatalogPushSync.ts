import { useEffect, useRef } from 'react'
import { fetchCatalogRevision } from './catalogSync'

const CATALOG_SYNC_POLL_MS = 30_000

/** Poll server catalog revision; reload products when Back Office pushes an update. */
export function useCatalogPushSync(
  sessionActive: boolean,
  loadProducts: (opts?: { hydrateFromCache?: boolean; force?: boolean }) => Promise<void>,
) {
  const revisionRef = useRef<number | null>(null)
  const baselineSetRef = useRef(false)

  useEffect(() => {
    if (!sessionActive) {
      revisionRef.current = null
      baselineSetRef.current = false
      return
    }

    let cancelled = false

    const check = async () => {
      try {
        const rev = await fetchCatalogRevision()
        if (cancelled || rev == null) return

        if (!baselineSetRef.current) {
          revisionRef.current = rev
          baselineSetRef.current = true
          return
        }

        if (revisionRef.current != null && rev > revisionRef.current) {
          revisionRef.current = rev
          void loadProducts({ hydrateFromCache: false, force: true })
        }
      } catch {
        // Non-blocking: tills keep last catalog until next successful poll.
      }
    }

    void check()
    const timer = window.setInterval(() => {
      void check()
    }, CATALOG_SYNC_POLL_MS)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [sessionActive, loadProducts])
}
