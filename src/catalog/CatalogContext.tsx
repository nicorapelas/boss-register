import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { apiFetch } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import type { Product } from '../api/types'
import { isLikelyNetworkError } from '../offline/offlineSalesQueue'
import {
  getWarmCatalogSnapshot,
  isCatalogSnapshotStale,
  loadCatalogCache,
  saveCatalogCache,
} from '../offline/catalogCache'
import { fetchCatalogRevision } from './catalogSync'
import { useCatalogPushSync } from './useCatalogPushSync'

type LoadProductsOptions = {
  hydrateFromCache?: boolean
  /** Force a new server fetch even if one is already in flight. */
  force?: boolean
}

type CatalogContextValue = {
  products: Product[]
  setProducts: React.Dispatch<React.SetStateAction<Product[]>>
  productsRef: React.MutableRefObject<Product[]>
  catalogSnapshotSyncedAt: string | null
  catalogSnapshotStale: boolean
  offlineCatalogMode: boolean
  catalogReady: boolean
  catalogLoading: boolean
  catalogRefreshing: boolean
  catalogError: string | null
  clearCatalogError: () => void
  loadProducts: (opts?: LoadProductsOptions) => Promise<void>
}

const CatalogContext = createContext<CatalogContextValue | null>(null)

function initialCatalogState() {
  const warm = getWarmCatalogSnapshot()
  const hasProducts = (warm?.products.length ?? 0) > 0
  return {
    products: warm?.products ?? [],
    catalogSnapshotSyncedAt: warm?.syncedAt ?? null,
    catalogSnapshotStale: isCatalogSnapshotStale(warm?.syncedAt ?? null),
    catalogReady: hasProducts,
  }
}

export function CatalogProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth()
  const initial = initialCatalogState()
  const [products, setProducts] = useState<Product[]>(initial.products)
  const [catalogSnapshotSyncedAt, setCatalogSnapshotSyncedAt] = useState<string | null>(
    initial.catalogSnapshotSyncedAt,
  )
  const [catalogSnapshotStale, setCatalogSnapshotStale] = useState(initial.catalogSnapshotStale)
  const [offlineCatalogMode, setOfflineCatalogMode] = useState(false)
  const [catalogReady, setCatalogReady] = useState(initial.catalogReady)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogRefreshing, setCatalogRefreshing] = useState(false)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const productsRef = useRef(products)
  const loadInFlightRef = useRef<Promise<void> | null>(null)
  const sessionActiveRef = useRef(false)
  productsRef.current = products

  const clearCatalogError = useCallback(() => setCatalogError(null), [])

  const loadProducts = useCallback(async (opts?: LoadProductsOptions) => {
    if (loadInFlightRef.current && !opts?.force) {
      return loadInFlightRef.current
    }

    const run = async () => {
      setCatalogError(null)
      const force = opts?.force === true
      const hydrateFromCache = opts?.hydrateFromCache !== false

      let cached = {
        products: [] as Product[],
        syncedAt: null as string | null,
        catalogRevision: null as number | null,
      }
      if (hydrateFromCache) {
        cached = await loadCatalogCache()
      }

      let productCount = productsRef.current.length
      if (cached.products.length > 0 && productCount === 0) {
        setProducts(cached.products)
        productCount = cached.products.length
        setCatalogSnapshotSyncedAt(cached.syncedAt)
        setCatalogSnapshotStale(isCatalogSnapshotStale(cached.syncedAt))
      }
      if (productCount > 0) {
        setCatalogReady(true)
        setCatalogLoading(false)
      } else {
        setCatalogLoading(true)
      }

      if (!sessionActiveRef.current) {
        setCatalogLoading(false)
        setCatalogRefreshing(false)
        return
      }

      let serverRevision: number | null = null
      serverRevision = await fetchCatalogRevision()

      const localRevision = cached.catalogRevision
      const revisionMatches =
        !force &&
        serverRevision != null &&
        localRevision != null &&
        serverRevision === localRevision &&
        productCount > 0

      if (revisionMatches) {
        setCatalogRefreshing(false)
        setCatalogLoading(false)
        setOfflineCatalogMode(false)
        return
      }

      const background = productCount > 0
      if (background) {
        setCatalogRefreshing(true)
        setCatalogLoading(false)
      }

      try {
        const list = await apiFetch<Product[]>('/products')
        const rev = serverRevision ?? (await fetchCatalogRevision())
        setProducts(list)
        const syncedAt = new Date().toISOString()
        setCatalogSnapshotSyncedAt(syncedAt)
        setCatalogSnapshotStale(false)
        setOfflineCatalogMode(false)
        setCatalogReady(true)
        try {
          await saveCatalogCache(list, rev)
        } catch {
          /* non-blocking */
        }
      } catch (e) {
        if (productCount > 0 && isLikelyNetworkError(e)) {
          setOfflineCatalogMode(true)
          setCatalogReady(true)
          return
        }
        if (!isLikelyNetworkError(e)) setOfflineCatalogMode(false)
        const message = e instanceof Error ? e.message : 'Failed to load products'
        if (productCount > 0) {
          const lower = message.toLowerCase()
          if (
            lower.includes('unauthorized') ||
            lower.includes('session expired') ||
            lower.includes('invalid refresh token')
          ) {
            setCatalogError(`Catalog refresh failed: ${message}. Please sign out and sign in again.`)
          } else {
            setCatalogError(`Catalog refresh failed: ${message}. Displayed stock may be stale.`)
          }
          setCatalogReady(true)
          return
        }
        setCatalogError(message)
      } finally {
        setCatalogLoading(false)
        setCatalogRefreshing(false)
      }
    }

    const task = run()
    loadInFlightRef.current = task
    try {
      await task
    } finally {
      if (loadInFlightRef.current === task) loadInFlightRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!session) {
      sessionActiveRef.current = false
      setCatalogError(null)
      loadInFlightRef.current = null
      return
    }
    if (!sessionActiveRef.current) {
      sessionActiveRef.current = true
      void loadProducts()
    }
  }, [session, loadProducts])

  useCatalogPushSync(!!session, loadProducts)

  const value: CatalogContextValue = {
    products,
    setProducts,
    productsRef,
    catalogSnapshotSyncedAt,
    catalogSnapshotStale,
    offlineCatalogMode,
    catalogReady,
    catalogLoading,
    catalogRefreshing,
    catalogError,
    clearCatalogError,
    loadProducts,
  }

  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>
}

export function useCatalog(): CatalogContextValue {
  const ctx = useContext(CatalogContext)
  if (!ctx) throw new Error('useCatalog must be used within CatalogProvider')
  return ctx
}
