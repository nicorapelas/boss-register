import type { SaleExchangePreview } from '../api/types'
import { SaleAdjustIdModal } from './SaleAdjustIdModal'

export type ExchangeSaleIdModalProps = {
  open: boolean
  onClose: () => void
  onSaleLoaded: (data: SaleExchangePreview, enteredSaleId: string) => void
  canBrowseSalesDirectly: boolean
  tillCode?: string
}

export function ExchangeSaleIdModal({
  open,
  onClose,
  onSaleLoaded,
  canBrowseSalesDirectly,
  tillCode,
}: ExchangeSaleIdModalProps) {
  return (
    <SaleAdjustIdModal
      mode="exchange"
      open={open}
      onClose={onClose}
      onExchangeLoaded={onSaleLoaded}
      canBrowseSalesDirectly={canBrowseSalesDirectly}
      tillCode={tillCode}
    />
  )
}
