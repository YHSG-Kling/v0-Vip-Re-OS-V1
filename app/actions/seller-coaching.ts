"use server"

import { createClient }        from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getSellerCoaching }   from "@/lib/seller-coaching"
import { getSellerPersona }    from "@/lib/seller-coaching/persona-utils"
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
    .select("brokerage_id, user_type, role")
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

  // Derive seller persona from contact fields per spec
  let persona: SellerPersona = null

  if (listing.contact_id) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("contact_persona, motivation_score, tags, communication_preference")
      .eq("id", listing.contact_id)
      .single()

    if (contact) {
      persona = getSellerPersona(contact)
    }
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

/**
 * refreshSellerCoaching
 * Forces regeneration of coaching for a listing by invalidating the cache
 * (sets updated_at to epoch so the 7-day check treats it as stale).
 */
export async function refreshSellerCoaching(
  listingId: string
): Promise<GetListingCoachingResult> {
  // Invalidate cache for this listing's stage/persona by clearing updated_at
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  // Resolve caller's brokerage so we can verify listing ownership
  const { data: callerRow } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!callerRow?.brokerage_id) return { success: false, error: "Unauthorized" }

  // Load listing stage + contact to get invalidation key
  const { data: listing } = await supabase
    .from("listings")
    .select("id, lifecycle_stage, contact_id, brokerage_id")
    .eq("id", listingId)
    .single()

  if (!listing) return { success: false, error: "Listing not found" }
  if (listing.brokerage_id !== callerRow.brokerage_id) {
    return { success: false, error: "Forbidden" }
  }

  let persona: SellerPersona = null
  if (listing.contact_id) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("contact_persona, motivation_score, tags, communication_preference")
      .eq("id", listing.contact_id)
      .single()
    if (contact) persona = getSellerPersona(contact)
  }

  // Invalidate: set updated_at to epoch so staleness check forces re-generation
  const svc = createServiceClient()
  await svc
    .from("seller_stage_coaching")
    .update({ updated_at: new Date(0).toISOString() })
    .eq("listing_stage", listing.lifecycle_stage ?? "LEAD")
    .or(persona ? `persona.eq.${persona},persona.is.null` : "persona.is.null")

  // Re-run full generation
  return getListingCoaching(listingId)
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
  _agentUserId?: string  // ignored — derived from session
): Promise<DismissResult> {
  // Auth gate — was previously trusting caller-supplied agentUserId
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }
  const { data: callerRow } = await authClient
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!callerRow?.brokerage_id) return { success: false, error: "Unauthorized" }

  const supabase = createServiceClient()

  // Verify listing belongs to caller's brokerage before logging activity
  const { data: listingRow } = await supabase
    .from("listings")
    .select("brokerage_id")
    .eq("id", listingId)
    .maybeSingle()
  if (!listingRow) return { success: false, error: "Listing not found" }
  if (listingRow.brokerage_id !== callerRow.brokerage_id) {
    return { success: false, error: "Forbidden" }
  }

  const { error } = await supabase.from("activities").insert({
    entity_type:   "listing",
    entity_id:     listingId,
    brokerage_id:  callerRow.brokerage_id,
    user_id:       user.id,  // session-derived, not caller-supplied
    activity_type: "coaching.dismissed",
    status:        "completed",
    metadata:      { source: "seller_coaching_card" },
  })

  if (error) return { success: false, error: error.message }
  return { success: true }
}
