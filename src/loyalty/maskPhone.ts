export function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, '')
}

/** Mask for cashier UI — last 4 digits visible. */
export function maskPhone(phone: string): string {
  const digits = normalizePhone(phone)
  if (digits.length <= 4) return '****'
  const last4 = digits.slice(-4)
  if (digits.length <= 7) return `*** ${last4}`
  return `*** *** ${last4}`
}

/** Customer display while typing — show grouped digits with middle hidden once long enough. */
export function maskPhoneForCustomerDisplay(digits: string): string {
  const d = normalizePhone(digits)
  if (d.length <= 4) return d
  if (d.length <= 7) return `${'*'.repeat(Math.max(0, d.length - 4))}${d.slice(-4)}`
  const visible = 3
  return `${d.slice(0, visible)}${'*'.repeat(d.length - visible - 4)}${d.slice(-4)}`
}
