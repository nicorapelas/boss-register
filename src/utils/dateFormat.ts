/** POS display: calendar date as DD/MM/YYYY (local timezone). */
export function formatDateDdMmYyyy(input: Date | string | number): string {
  const d = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(d.getTime())) return ''
  const day = String(d.getDate()).padStart(2, '0')
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const year = String(d.getFullYear())
  return `${day}/${month}/${year}`
}
