export type HouseAccountPaymentTerms = '' | 'cod' | '7_days' | '30_days' | 'end_of_month'

const LABELS: Record<string, string> = {
  cod: 'COD',
  '7_days': '7 days',
  '30_days': '30 days',
  end_of_month: 'End of month',
}

export function paymentTermsShortLabel(value: string | undefined | null): string | null {
  if (!value) return null
  return LABELS[value] ?? value
}
