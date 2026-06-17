"use server"

/**
 * Generate the AI landing-page copy + deliverable copy for a lead magnet / home-value page, so the
 * agent's capture page and the thing the user receives are both written for them. Marketing copy only
 * — separate from the kernel-owned portal VIEW + education. Fair-Housing-safe by construction.
 */

import { createClient } from "@/lib/supabase/server"
import { landingPageCopy, magnetDeliverableCopy, magnetHasDeliverable, type MagnetType, type LandingCopy, type MagnetDeliverable } from "@/lib/marketing/lead-magnet-copy"

const VALID: MagnetType[] = ["home_valuation", "buyer_guide", "seller_guide", "market_report", "listing_alert", "open_house", "generic_form"]

export async function generateLeadMagnetCopyAction(input: { magnetType: string; area?: string | null; brand?: string | null }): Promise<{
  success: boolean
  landing?: LandingCopy
  deliverable?: MagnetDeliverable | null
  error?: string
}> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "unauthorized" }

  const magnetType: MagnetType = VALID.includes(input.magnetType as MagnetType) ? (input.magnetType as MagnetType) : "generic_form"
  const ctx = { area: input.area ?? null, brand: input.brand ?? null }
  return {
    success: true,
    landing: landingPageCopy(magnetType, ctx),
    deliverable: magnetHasDeliverable(magnetType) ? magnetDeliverableCopy(magnetType, ctx) : null,
  }
}
