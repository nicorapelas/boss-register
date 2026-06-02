import type { CustomerDisplaySnapshot } from './types'

export function isCustomerDisplayAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.electronCustomerDisplay
}

export function publishCustomerDisplay(snapshot: CustomerDisplaySnapshot): void {
  if (!isCustomerDisplayAvailable()) return
  void window.electronCustomerDisplay!.publish(snapshot)
}

/** Move OS + DOM focus to the customer display loyalty phone field. */
export function focusCustomerDisplayLoyaltyEntry(): void {
  if (!isCustomerDisplayAvailable()) return
  void window.electronCustomerDisplay!.focusLoyaltyEntry()
}

/** Retry focus after React/Electron settle (e.g. loyalty modal button click). */
export function scheduleCustomerDisplayLoyaltyFocus(): void {
  focusCustomerDisplayLoyaltyEntry()
  for (const ms of [100, 250, 500, 900, 1500, 2200]) {
    window.setTimeout(() => focusCustomerDisplayLoyaltyEntry(), ms)
  }
}
