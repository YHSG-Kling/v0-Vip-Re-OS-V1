"use server"

import { createClient }        from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getSellerCoaching }   from "@/lib/seller-coaching"
import type { SellerPersona, SellerCoachingContent } from "@/lib/seller-coaching"

interface GetListingCoachingResult {
  success: boolean
  coaching?: SellerCoachingContent
  listingStage?: string
  persona?: SellerPersona
  generatedAt?: string
  error?: string
}

/**
 * getListingCoaching
 * Loads the listing + seller contact persona, then returns the appropriate
 * coaching content — either from cache or freshly AI-generated.
 */
export async function getListingCoaching(
  listingId: string
): Promise<GetListingCoachingResult> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const { data: userRow } = await supabase
    .from("users")
    .select("brokerage_id, role")
    .eq("id", user.id)
    .single()

  if (!userRow?.brokerage_id) return { success: false, error: "No brokerage" }

  // Load listing — respect agent scope
  let listingQuery = supabase
    .from("listings")
    .select("id, lifecycle_stage, contact_id, brokerage_id")
    .eq("id", listingId)
    .eq("brokerage_id", userRow.brokerage_id)

  if (userRow.role === "agent") {
    listingQuery = listingQuery.eq("assigned_agent_id", user.id)
  }

  const { data: listing, error: listingError } = await listingQuery.single()
  if (listingError || !listing) return { success: false, error: "Listing not found" }

  // Load seller persona from the contact record
  let persona: SellerPersona = null

  if (listing.contact_id) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("contact_persona")
      .eq("id", listing.contact_id)
      .single()

    const rawPersona = contact?.contact_persona as string | null
    const validPersonas: SellerPersona[] = [
      "motivated", "skeptical", "emotional", "investor", "indecisive", "analytical",
    ]
    persona = (validPersonas.includes(rawPersona as SellerPersona) ? rawPersona : null) as SellerPersona
  }

  try {
    const coaching = await getSellerCoaching(
      listing.lifecycle_stage ?? "LEAD",
      persona,
      listing.brokerage_id ?? userRow.brokerage_id
    )

    return {
      success:      true,
      coaching,
      listingStage: listing.lifecycle_stage ?? "LEAD",
      persona,
      generatedAt:  new Date().toISOString(),
    }
  } catch (err: any) {
    return { success: false, error: err?.message ?? "Coaching generation failed" }
  }
}

interface DismissResult {
  success: boolean
  error?: string
}

/**
 * dismissCoachingCard
 * Records a coaching.dismissed activity for analytics.
 * Dismissed state is session-only in UI — not persisted per listing.
 */
export async function dismissCoachingCard(
  listingId: string,
  agentUserId: string
): Promise<DismissResult> {
  // Use service client to bypass RLS on activities insert
  const supabase = createServiceClient()

  const { error } = await supabase.from("activities").insert({
    entity_type:   "listing",
    entity_id:     listingId,
    user_id:       agentUserId,
    activity_type: "coaching.dismissed",
    status:        "completed",
    metadata:      { source: "seller_coaching_card" },
  })

  if (error) return { success: false, error: error.message }
  return { success: true }
}
