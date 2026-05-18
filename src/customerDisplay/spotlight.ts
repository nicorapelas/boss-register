import { fetchProductPhotoObjectUrl } from '../api/client'
import type { Product } from '../api/types'
import type { CustomerDisplaySnapshot } from './types'
import { publishCustomerDisplay } from './publish'

const spotlightSeenProductIds = new Set<string>()

export function clearCustomerDisplaySpotlightSeen(): void {
  spotlightSeenProductIds.clear()
}

export async function publishProductSpotlight(
  product: Product,
  baseSnapshot: CustomerDisplaySnapshot,
): Promise<void> {
  if ((product.photoRevision ?? 0) < 1) return
  if (spotlightSeenProductIds.has(product._id)) return
  spotlightSeenProductIds.add(product._id)
  try {
    const imageUrl = await fetchProductPhotoObjectUrl(product._id, product.photoRevision ?? 1)
    publishCustomerDisplay({
      ...baseSnapshot,
      spotlight: { name: product.name, imageUrl },
    })
  } catch {
    // Photo fetch failed — cart snapshot will still update via normal sync
  }
}
