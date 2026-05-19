import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { Outlet } from 'react-router-dom'
import { apiFetch } from '../api/client'
import type { Product } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { isLikelyNetworkError } from '../offline/offlineSalesQueue'
import { isCatalogSnapshotStale, loadCatalogCache, saveCatalogCache } from '../offline/catalogCache'

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
  catalogError: string | null
  clearCatalogError: () => void
  loadProducts: (opts?: LoadProductsOptions) => Promise<void>
}

const CatalogContext = createContext<CatalogContextValue | null>(null)

export function CatalogProvider() {
  const { session } = useAuth()
  const [products, setProducts] = useState<Product[]>([])
  const [catalogSnapshotSyncedAt, setCatalogSnapshotSyncedAt] = useState<string | null>(null)
  const [catalogSnapshotStale, setCatalogSnapshotStale] = useState(false)
  const [offlineCatalogMode, setOfflineCatalogMode] = useState(false)
  const [catalogReady, setCatalogReady] = useState(false)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const productsRef = useRef(products)
  const loadInFlightRef = useRef<Promise<void> | null>(null)
  productsRef.current = products

  const clearCatalogError = useCallback(() => setCatalogError(null), [])

  const loadProducts = useCallback(async (opts?: LoadProductsOptions) => {
    if (loadInFlightRef.current && !opts?.force) {
      return loadInFlightRef.current
    }

    const run = async () => {
      setCatalogError(null)
      setCatalogLoading(true)
      const hydrateFromCache = opts?.hydrateFromCache !== false
      const shouldHydrateFromCache = hydrateFromCache && productsRef.current.length === 0
      const cached = shouldHydrateFromCache
        ? await loadCatalogCache()
        : { products: [] as Product[], syncedAt: null as string | null }

      if (cached.products.length > 0) {
        setProducts(cached.products)
        setCatalogSnapshotSyncedAt(cached.syncedAt)
        setCatalogSnapshotStale(isCatalogSnapshotStale(cached.syncedAt))
        setCatalogReady(true)
      }

      try {
        const list = await apiFetch<Product[]>('/products')
        setProducts(list)
        const syncedAt = new Date().toISOString()
        setCatalogSnapshotSyncedAt(syncedAt)
        setCatalogSnapshotStale(false)
        setOfflineCatalogMode(false)
        setCatalogReady(true)
        try {
          await saveCatalogCache(list)
        } catch {
          // Non-blocking: UI still uses fresh online list.
        }
      } catch (e) {
        if (cached.products.length > 0 && isLikelyNetworkError(e)) {
          setOfflineCatalogMode(true)
          setCatalogReady(true)
          return
        }
        if (!isLikelyNetworkError(e)) setOfflineCatalogMode(false)
        const message = e instanceof Error ? e.message : 'Failed to load products'
        if (productsRef.current.length > 0) {
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
      setProducts([])
      setCatalogSnapshotSyncedAt(null)
      setCatalogSnapshotStale(false)
      setOfflineCatalogMode(false)
      setCatalogReady(false)
      setCatalogLoading(false)
      setCatalogError(null)
      loadInFlightRef.current = null
      return
    }
    void loadProducts()
  }, [session?.accessToken, loadProducts])

  const value: CatalogContextValue = {
    products,
    setProducts,
    productsRef,
    catalogSnapshotSyncedAt,
    catalogSnapshotStale,
    offlineCatalogMode,
    catalogReady,
    catalogLoading,
    catalogError,
    clearCatalogError,
    loadProducts,
  }

  return (
    <CatalogContext.Provider value={value}>
      <Outlet />
    </CatalogContext.Provider>
  )
}

export function useCatalog(): CatalogContextValue {
  const ctx = useContext(CatalogContext)
  if (!ctx) throw new Error('useCatalog must be used within CatalogProvider')
  return ctx
}
