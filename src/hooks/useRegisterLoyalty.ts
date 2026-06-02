import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { apiFetch } from '../api/client'
import { scheduleCustomerDisplayLoyaltyFocus } from '../customerDisplay/publish'
import { discountForPoints, maxRedeemPointsForSale } from '../loyalty/calc'
import { maskPhoneForCustomerDisplay, normalizePhone } from '../loyalty/maskPhone'
import type {
  LoyaltyKeyAction,
  LoyaltyLookupResponse,
  LoyaltyProgramConfig,
  LoyaltyPurchaseListResponse,
  LoyaltyPurchaseRow,
} from '../loyalty/types'

function blurRegisterFocusedField(): void {
  const el = document.activeElement
  if (el instanceof HTMLElement) el.blur()
}

const LOYALTY_MAX_DIGITS = 15

type UseRegisterLoyaltyOpts = {
  sessionActive: boolean
  cartTotal: number
  setError: (msg: string | null) => void
  setNotice: (msg: string | null) => void
  /** Called synchronously after loyalty-entry state is committed (publish customer display). */
  onLoyaltyEntryStarted?: () => void
}

export function useRegisterLoyalty({
  sessionActive,
  cartTotal,
  setError,
  setNotice,
  onLoyaltyEntryStarted,
}: UseRegisterLoyaltyOpts) {
  const [loyaltyProgram, setLoyaltyProgram] = useState<LoyaltyProgramConfig | null>(null)
  const [loyaltyPhone, setLoyaltyPhone] = useState('')
  const [loyaltyMemberId, setLoyaltyMemberId] = useState<string | null>(null)
  const [loyaltyMasked, setLoyaltyMasked] = useState<string | null>(null)
  const [loyaltyBalance, setLoyaltyBalance] = useState(0)
  const [loyaltyPurchases, setLoyaltyPurchases] = useState<LoyaltyPurchaseRow[]>([])
  const [loyaltyPurchasesTotal, setLoyaltyPurchasesTotal] = useState(0)
  const [loyaltyPurchasesLoading, setLoyaltyPurchasesLoading] = useState(false)
  const [loyaltyPointsRedeem, setLoyaltyPointsRedeem] = useState(0)
  const [loyaltyEntryActive, setLoyaltyEntryActive] = useState(false)
  const loyaltyEntryActiveRef = useRef(false)
  const [loyaltyEntryDigits, setLoyaltyEntryDigits] = useState('')
  const [loyaltyEntryFocusToken, setLoyaltyEntryFocusToken] = useState(0)

  const setLoyaltyEntryActiveSync = useCallback((active: boolean) => {
    loyaltyEntryActiveRef.current = active
    setLoyaltyEntryActive(active)
  }, [])

  useEffect(() => {
    if (!sessionActive) return
    void apiFetch<LoyaltyProgramConfig>('/loyalty/program')
      .then(setLoyaltyProgram)
      .catch(() => setLoyaltyProgram(null))
  }, [sessionActive])

  const loyaltyDiscount = useMemo(() => {
    if (!loyaltyProgram?.enabled || loyaltyPointsRedeem <= 0) return 0
    return discountForPoints(loyaltyPointsRedeem, loyaltyProgram)
  }, [loyaltyProgram, loyaltyPointsRedeem])

  const loyaltyEntryDisplayValue = useMemo(
    () => maskPhoneForCustomerDisplay(loyaltyEntryDigits),
    [loyaltyEntryDigits],
  )

  const clearLoyalty = useCallback(() => {
    setLoyaltyPhone('')
    setLoyaltyMemberId(null)
    setLoyaltyMasked(null)
    setLoyaltyBalance(0)
    setLoyaltyPointsRedeem(0)
    setLoyaltyPurchases([])
    setLoyaltyPurchasesTotal(0)
    setLoyaltyPurchasesLoading(false)
    setLoyaltyEntryActiveSync(false)
    setLoyaltyEntryDigits('')
  }, [setLoyaltyEntryActiveSync])

  const loadLoyaltyPurchases = useCallback(async (memberId: string) => {
    setLoyaltyPurchasesLoading(true)
    try {
      const result = await apiFetch<LoyaltyPurchaseListResponse>(
        `/loyalty/members/${encodeURIComponent(memberId)}/purchases?limit=8`,
      )
      setLoyaltyPurchases(result.purchases)
      setLoyaltyPurchasesTotal(result.total)
    } catch {
      setLoyaltyPurchases([])
      setLoyaltyPurchasesTotal(0)
    } finally {
      setLoyaltyPurchasesLoading(false)
    }
  }, [])

  const startLoyaltyEntry = useCallback(() => {
    if (!loyaltyProgram?.enabled) {
      setError('Loyalty program is not enabled')
      return
    }
    setError(null)
    setNotice(null)
    loyaltyEntryActiveRef.current = true
    flushSync(() => {
      setLoyaltyEntryActive(true)
      setLoyaltyEntryDigits('')
      setLoyaltyEntryFocusToken((t) => t + 1)
    })
    blurRegisterFocusedField()
    onLoyaltyEntryStarted?.()
    scheduleCustomerDisplayLoyaltyFocus()
  }, [loyaltyProgram?.enabled, setError, setNotice, onLoyaltyEntryStarted])

  useEffect(() => {
    if (!loyaltyEntryActive) return
    blurRegisterFocusedField()
    scheduleCustomerDisplayLoyaltyFocus()
  }, [loyaltyEntryActive, loyaltyEntryFocusToken])

  const cancelLoyaltyEntry = useCallback(() => {
    setLoyaltyEntryActiveSync(false)
    setLoyaltyEntryDigits('')
  }, [setLoyaltyEntryActiveSync])

  const confirmLoyaltyEntry = useCallback(async () => {
    const phone = normalizePhone(loyaltyEntryDigits)
    if (phone.length < 9) {
      setError('Enter a valid cellphone number on the customer display')
      return
    }
    setError(null)
    try {
      const result = await apiFetch<LoyaltyLookupResponse>(`/loyalty/lookup?phone=${encodeURIComponent(phone)}`)
      if (!result.program.enabled) {
        setError('Loyalty program is not enabled')
        return
      }
      setLoyaltyProgram(result.program)
      setLoyaltyPhone(phone)
      setLoyaltyMemberId(result.memberId)
      setLoyaltyMasked(result.phoneMasked)
      setLoyaltyBalance(result.pointsBalance)
      setLoyaltyPointsRedeem(0)
      setLoyaltyPurchases([])
      setLoyaltyPurchasesTotal(0)
      setLoyaltyEntryActiveSync(false)
      setLoyaltyEntryDigits('')
      if (result.memberId) {
        void loadLoyaltyPurchases(result.memberId)
      }
      setNotice(result.isNew ? 'New loyalty member — points will apply on this sale' : `Loyalty linked · ${result.pointsBalance.toLocaleString()} pts`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Loyalty lookup failed')
    }
  }, [loyaltyEntryDigits, setError, setNotice, setLoyaltyEntryActiveSync, loadLoyaltyPurchases])

  const handleLoyaltyKey = useCallback(
    (action: LoyaltyKeyAction) => {
      if (action.type === 'cancel') {
        cancelLoyaltyEntry()
        return
      }
      if (action.type === 'clear') {
        setLoyaltyEntryDigits('')
        return
      }
      if (action.type === 'backspace') {
        setLoyaltyEntryDigits((d) => d.slice(0, -1))
        return
      }
      if (action.type === 'confirm') {
        void confirmLoyaltyEntry()
        return
      }
      if (action.type === 'digit' && /^\d$/.test(action.digit)) {
        setLoyaltyEntryDigits((d) => (d.length >= LOYALTY_MAX_DIGITS ? d : d + action.digit))
      }
    },
    [cancelLoyaltyEntry, confirmLoyaltyEntry],
  )

  useEffect(() => {
    if (!window.electronCustomerDisplay?.onLoyaltyKey) return
    return window.electronCustomerDisplay.onLoyaltyKey((raw) => {
      if (!loyaltyEntryActiveRef.current) return
      handleLoyaltyKey(raw as LoyaltyKeyAction)
    })
  }, [handleLoyaltyKey])

  const applyMaxLoyaltyRedeem = useCallback(() => {
    if (!loyaltyProgram?.enabled || !loyaltyPhone) {
      setError('Link loyalty on the customer display first')
      setNotice(null)
      return
    }
    const maxPts = maxRedeemPointsForSale(cartTotal, loyaltyBalance, loyaltyProgram)
    const discount = discountForPoints(maxPts, loyaltyProgram)
    if (maxPts < loyaltyProgram.minRedeemPoints || maxPts <= 0) {
      if (loyaltyBalance < loyaltyProgram.minRedeemPoints) {
        setError(
          `Balance is ${loyaltyBalance.toLocaleString()} pts — need at least ${loyaltyProgram.minRedeemPoints.toLocaleString()} to redeem`,
        )
      } else {
        setError('Nothing to redeem on this sale (cart total or program max % may limit redemption)')
      }
      setNotice(null)
      return
    }
    if (loyaltyPointsRedeem === maxPts) {
      setError(null)
      setNotice(`Max redeem already applied: ${maxPts.toLocaleString()} pts (−R ${discount.toFixed(2)})`)
      return
    }
    setLoyaltyPointsRedeem(maxPts)
    setError(null)
    setNotice(`Redeeming ${maxPts.toLocaleString()} pts — saves R ${discount.toFixed(2)} on this sale`)
  }, [loyaltyProgram, loyaltyPhone, loyaltyBalance, loyaltyPointsRedeem, cartTotal, setError, setNotice])

  const appendLoyaltyToSaleBody = useCallback(
    (body: Record<string, unknown>) => {
      if (loyaltyPhone && loyaltyProgram?.enabled) {
        body.loyaltyPhone = loyaltyPhone
        if (loyaltyPointsRedeem > 0) body.loyaltyPointsRedeem = loyaltyPointsRedeem
      }
    },
    [loyaltyPhone, loyaltyProgram?.enabled, loyaltyPointsRedeem],
  )

  return {
    loyaltyProgram,
    loyaltyPhone,
    loyaltyMemberId,
    loyaltyMasked,
    loyaltyBalance,
    loyaltyPurchases,
    loyaltyPurchasesTotal,
    loyaltyPurchasesLoading,
    loyaltyPointsRedeem,
    setLoyaltyPointsRedeem,
    loyaltyDiscount,
    loyaltyEntryActive,
    loyaltyEntryActiveRef,
    loyaltyEntryDisplayValue,
    loyaltyEntryFocusToken,
    startLoyaltyEntry,
    cancelLoyaltyEntry,
    clearLoyalty,
    applyMaxLoyaltyRedeem,
    appendLoyaltyToSaleBody,
  }
}
