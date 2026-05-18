import type { CustomerDisplaySnapshot } from './types'

export function isCustomerDisplayAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.electronCustomerDisplay
}

export function publishCustomerDisplay(snapshot: CustomerDisplaySnapshot): void {
  if (!isCustomerDisplayAvailable()) return
  void window.electronCustomerDisplay!.publish(snapshot)
}
