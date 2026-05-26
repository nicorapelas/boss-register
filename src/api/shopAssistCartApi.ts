import { apiFetch } from './client'
import type { ShopAssistClaimedCart } from './types'

export async function claimShopAssistCart(token: string) {
  return apiFetch<ShopAssistClaimedCart>('/shop-assist-carts/claim', {
    method: 'POST',
    body: JSON.stringify({ token }),
  })
}
