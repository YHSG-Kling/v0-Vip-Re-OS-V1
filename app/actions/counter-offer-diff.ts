"use server"

/**
 * Server-action wrapper around lib/workflow/intelligence/multi-offer-matrix.
 * buildCounterOfferDiff so client components can fetch counter-offer diffs
 * without leaking service-role access.
 */

import { createClient } from "@/lib/supabase/server"
import { buildCounterOfferDiff, type CounterOfferDiff } from "@/lib/workflow/intelligence/multi-offer-matrix"

export async function loadCounterOfferDiff(input: {
  offerId:        string
  /**
   * Counter terms to compare against the original offer. Pass the fields
   * that changed; everything else is treated as unchanged.
   */
  counterPayload: Record<string, unknown>
}): Promise<{ success: true; diff: CounterOfferDiff } | { success: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  // Verify offer is in user's brokerage
  const { data: offer } = await supabase
    .from("offers")
    .select("id, brokerage_id")
    .eq("id", input.offerId)
    .maybeSingle()
  if (!offer) return { success: false, error: "Offer not found" }

  const { data: userRow } = await supabase
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (userRow?.brokerage_id !== offer.brokerage_id) {
    return { success: false, error: "Forbidden" }
  }

  try {
    const diff = await buildCounterOfferDiff({
      offerId:        input.offerId,
      counterPayload: input.counterPayload,
    })
    return { success: true, diff }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
}
