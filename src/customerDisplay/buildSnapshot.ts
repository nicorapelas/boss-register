import type { CartLine, Product, StoreSettings } from '../api/types'
import type { SessionBundle } from '../auth/types'
import type { CustomerDisplaySnapshot, CustomerDisplayStoreConfig } from './types'

function roundCartMoney(n: number): number {
  return Math.round(n * 100) / 100
}

function cartLineSubtotal(l: CartLine): number {
  if (l.volumeSegments?.length) {
    return roundCartMoney(l.volumeSegments.reduce((s, g) => s + g.lineTotal, 0))
  }
  return roundCartMoney(l.quantity * l.unitPrice)
}

type BuildInput = {
  session: SessionBundle | null
  storeConfig: CustomerDisplayStoreConfig
  storeName: string
  cart: CartLine[]
  cartTotal: number
  productsById: Map<string, Product>
  showChangeView: boolean
  lastTotal: number | null
  lastChangeDue: number | null
  lastCardAmount: number | null
  lastTendered: number | null
  pendingSplit: boolean
  refundSession: boolean
  jobCardLabourActive: boolean
}

function lineTotalForDisplay(
  l: CartLine,
  p: Product | undefined,
  jobCardLabourActive: boolean,
): number {
  const material = cartLineSubtotal(l)
  if (!jobCardLabourActive) return material
  const per = p?.jobCardLabourPerUnit
  if (per == null || !Number.isFinite(per) || per <= 0) return material
  return roundCartMoney(material + per * l.quantity)
}

export function buildCustomerDisplaySnapshot(input: BuildInput): CustomerDisplaySnapshot {
  const {
    session,
    storeConfig,
    storeName,
    cart,
    cartTotal,
    productsById,
    showChangeView,
    lastTotal,
    lastChangeDue,
    lastCardAmount,
    lastTendered,
    pendingSplit,
    refundSession,
    jobCardLabourActive,
  } = input

  const theme = storeConfig.theme
  const footerText = storeConfig.footerText

  if (!session) {
    return {
      mode: 'idle',
      storeName,
      idle: {
        headline: storeConfig.idle.headline,
        subtext: storeConfig.idle.subtext,
        imageUrl: storeConfig.idle.imageUrl,
        backgroundColor: theme.backgroundColor,
        accentColor: theme.accentColor,
        footerText,
      },
    }
  }

  if (refundSession) {
    return {
      mode: 'ready',
      storeName,
      theme,
      footerText,
    }
  }

  if (showChangeView && lastTotal != null) {
    const cash = lastTendered ?? 0
    const card = lastCardAmount ?? 0
    const paymentLabel =
      card > 0.005 && cash > 0.005 ? 'Split' : card > 0.005 ? 'Card' : cash > 0.005 ? 'Cash' : 'Paid'
    return {
      mode: 'complete',
      storeName,
      theme,
      footerText,
      complete: {
        totalPaid: lastTotal,
        changeDue: lastChangeDue != null && lastChangeDue > 0.005 ? lastChangeDue : undefined,
        paymentLabel,
        token: Date.now(),
      },
    }
  }

  if (cart.length > 0 || pendingSplit) {
    const lines = cart.map((l) => {
      const p = productsById.get(l.productId)
      return {
        name: l.name,
        quantity: l.quantity,
        lineTotal: lineTotalForDisplay(l, p, jobCardLabourActive),
      }
    })
    return {
      mode: 'cart',
      storeName,
      lines,
      total: cartTotal,
      theme,
      footerText,
    }
  }

  return {
    mode: 'ready',
    storeName,
    theme,
    footerText,
  }
}

export function storeConfigFromSettings(settings: StoreSettings): CustomerDisplayStoreConfig {
  const cd = settings.customerDisplay
  return {
    enabled: cd?.enabled !== false,
    idle: {
      headline: cd?.idle?.headline?.trim() || 'Welcome',
      subtext: cd?.idle?.subtext?.trim() ?? '',
      imageUrl: cd?.idle?.imageUrl?.trim() ?? '',
    },
    theme: {
      backgroundColor: cd?.theme?.backgroundColor ?? '#0f1419',
      accentColor: cd?.theme?.accentColor ?? '#3b82f6',
    },
    footerText: cd?.footerText?.trim() || 'All prices include VAT',
  }
}
