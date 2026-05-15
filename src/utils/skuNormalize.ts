/** Strip leading zeros from digit-only keys so 008632 and 8632 match. */
export function numericSkuKey(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (!digits) return raw.trim().toLowerCase()
  return digits.replace(/^0+/, '') || '0'
}
