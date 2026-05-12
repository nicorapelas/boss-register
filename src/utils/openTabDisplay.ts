/** Shown when a job card has no customer name — no fake value stored in DB. */
export const JOB_CARD_CUSTOMER_FALLBACK = 'Not specified'

export function jobCardCustomerDisplay(customerName: string | undefined | null): string {
  const t = (customerName ?? '').trim()
  return t || JOB_CARD_CUSTOMER_FALLBACK
}
