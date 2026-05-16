import { memo, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { Product } from '../api/types'
import {
  productAvailabilityCaptionWithMode,
  productHasSellableStock,
  productTracksInventory,
} from '../utils/productInventory'

export type ProductListRowProps = {
  product: Product
  offlineCatalogMode: boolean
  serverReachable: boolean
  isAdmin: boolean
  onAdd: (e: MouseEvent<HTMLButtonElement>, p: Product) => void
  onAssignPreset: (p: Product) => void
  onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>, p: Product) => void
  onPointerMove: (e: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLButtonElement>) => void
  onPointerCancel: (e: ReactPointerEvent<HTMLButtonElement>) => void
  onShowPhoto: (p: Product) => void
}

export const ProductListRow = memo(function ProductListRow({
  product: p,
  offlineCatalogMode,
  serverReachable,
  isAdmin,
  onAdd,
  onAssignPreset,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onShowPhoto,
}: ProductListRowProps) {
  const canTapProduct =
    productHasSellableStock(p) ||
    (productTracksInventory(p) && (offlineCatalogMode || !serverReachable || isAdmin))
  const showPhotoBtn = serverReachable && (p.photoRevision ?? 0) > 0

  return (
    <li>
      <div className={`product-row${!canTapProduct ? ' product-row--dimmed' : ''}`}>
        <button
          type="button"
          className="product-row-main"
          aria-label={canTapProduct ? `Add ${p.name} to cart` : `${p.name} — out of stock`}
          onClick={(e) => onAdd(e, p)}
          onPointerDown={(e) => onPointerDown(e, p)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onContextMenu={(e) => {
            e.preventDefault()
            if (!canTapProduct) return
            onAssignPreset(p)
          }}
          title="Tap to add · Long-press or right-click to assign to preset"
          disabled={!canTapProduct}
        >
          <span className="product-name">{p.name}</span>
          <span className="product-meta muted">{p.sku}</span>
          <span className="product-price">
            {p.price.toFixed(2)} · {productAvailabilityCaptionWithMode(p, offlineCatalogMode)}
          </span>
        </button>
        {showPhotoBtn ? (
          <button
            type="button"
            className="btn ghost product-row-photo-btn"
            aria-label={`Show photo for ${p.name}`}
            title="Product photo"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onShowPhoto(p)
            }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
          </button>
        ) : null}
      </div>
    </li>
  )
})
