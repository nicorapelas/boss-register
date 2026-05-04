/**
 * Client-side copy of server flat bucket volume logic (for cart display; server is authoritative).
 */

export type VolumeTierInput = { minQty: number; maxQty: number | null; unitPrice: number }

export type ProductForVolume = {
  price: number
  volumeTieringEnabled?: boolean
  volumeTiers?: VolumeTierInput[] | null
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function unitPriceForLineQuantity(
  quantity: number,
  basePrice: number,
  volumeTieringEnabled: boolean,
  volumeTiers: VolumeTierInput[] | null | undefined,
): number {
  const bp = round2(basePrice)
  if (!volumeTieringEnabled || !volumeTiers?.length || quantity < 1) {
    return bp
  }
  const sorted = [...volumeTiers].sort((a, b) => b.minQty - a.minQty)
  for (const t of sorted) {
    if (quantity < t.minQty) continue
    if (t.maxQty != null && quantity > t.maxQty) continue
    return round2(t.unitPrice)
  }
  return bp
}

export function expandVolumeLineSegments(
  quantity: number,
  basePrice: number,
  volumeTieringEnabled: boolean,
  volumeTiers: VolumeTierInput[] | null | undefined,
): Array<{ quantity: number; unitPrice: number; lineTotal: number; listUnitPrice?: number }> {
  const bp = round2(basePrice)
  if (quantity < 1) {
    return [{ quantity: 0, unitPrice: bp, lineTotal: 0, listUnitPrice: undefined }]
  }
  if (!volumeTieringEnabled || !volumeTiers?.length) {
    const lineTotal = round2(quantity * bp)
    return [{ quantity, unitPrice: bp, lineTotal, listUnitPrice: undefined }]
  }
  const u = unitPriceForLineQuantity(quantity, bp, true, volumeTiers)
  const lineTotal = round2(quantity * u)
  const useList = u < bp - 0.0001
  return [{ quantity, unitPrice: u, lineTotal, listUnitPrice: useList ? bp : undefined }]
}

export function hasVolumeTiering(p: ProductForVolume): boolean {
  return Boolean(p.volumeTieringEnabled && p.volumeTiers && p.volumeTiers.length > 0)
}

export function lineTotalsForProduct(p: ProductForVolume, quantity: number): {
  volumeSegments: ReturnType<typeof expandVolumeLineSegments>
  lineTotal: number
  displayUnitPrice: number
} {
  const segs = expandVolumeLineSegments(quantity, p.price, Boolean(p.volumeTieringEnabled), p.volumeTiers)
  const lineTotal = round2(segs.reduce((s, g) => s + g.lineTotal, 0))
  const displayUnitPrice = quantity > 0 ? round2(lineTotal / quantity) : p.price
  return { volumeSegments: segs, lineTotal, displayUnitPrice: round2(displayUnitPrice) }
}
