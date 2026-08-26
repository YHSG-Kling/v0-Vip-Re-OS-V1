"use server"

/**
 * app/actions/ai-buyer-search-push.ts
 *
 * Agent-initiated action: run an AI property search for a specific buyer
 * and push the results into the buyer's activity feed + portal notification.
 *
 * Flow:
 *   1. Agent runs NL search for buyer ("find 3-bed homes under $600k near good schools")
 *   2. searchPropertiesCore() scores listings from DB
 *   3. Results logged as activity_type='agent_property_push' on the contact
 *   4. Buyer's portal notification created (type: 'market_update')
 *   5. Returns match count and top matches for agent preview
 *
 * Different from alerts (cron-driven): this is an on-demand agent action.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveWriteContextForTenant } from "@/lib/platform/acting-context"
import { searchPropertiesCore, type BuyerSearchResult } from "@/lib/buyer-search/search-engine"

export interface SearchPushResult {
  success: boolean
  matchCount: number
  topMatches: Array<{
    listingId: string
    address: string | null
    price: number | null
    beds: number | null
    baths: number | null
    matchScore: number
    headline: string
  }>
  error?: string
}

/**
 * Run an AI property search on behalf of a buyer contact and push results
 * to their activity feed. Optionally include an agent note shown to the buyer.
 */
export async function searchAndPushToBuyer(params: {
  contactId: string
  searchQuery: string
  agentNote?: string
  maxResults?: number
}): Promise<SearchPushResult> {
  const { contactId, searchQuery, agentNote, maxResults = 10 } = params

  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok || (!ctx.agentId && ctx.userType !== "admin" && ctx.userType !== "superadmin")) {
    return { success: false, matchCount: 0, topMatches: [], error: "Unauthorized" }
  }

  const supabase = ctx.db
  const svc = createServiceClient()

  // Verify the contact belongs to this agent's brokerage
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("id, brokerage_id, user_id, first_name, last_name")
    .eq("id", contactId)
    .eq("brokerage_id", ctx.brokerageId!)
    .maybeSingle()

  if (contactError || !contact) {
    return { success: false, matchCount: 0, topMatches: [], error: "Contact not found" }
  }

  // Run the NL search using the buyer-search engine
  let results: BuyerSearchResult[] = []
  try {
    const searchOutput = await searchPropertiesCore({
      contactId,
      naturalLanguageQuery: searchQuery,
      options: { limit: maxResults, logSignals: true },
    })
    results = searchOutput.results ?? []
  } catch {
    return { success: false, matchCount: 0, topMatches: [], error: "Search failed" }
  }

  if (results.length === 0) {
    return { success: true, matchCount: 0, topMatches: [] }
  }

  // Build the activity payload summarizing the push
  const topAddresses = results
    .slice(0, 3)
    .map((r) => [r.city, r.state].filter(Boolean).join(", ") || "Property")
    .join(", ")

  const activityBody = [
    `Agent searched: "${searchQuery}"`,
    agentNote ? `Note: ${agentNote}` : null,
    `Found ${results.length} match${results.length !== 1 ? "es" : ""}: ${topAddresses}${results.length > 3 ? ` +${results.length - 3} more` : ""}`,
  ]
    .filter(Boolean)
    .join(" · ")

  // Log as activity on the contact record. This row IS the record that the
  // agent pushed these properties — the AI reads it back as outreach that
  // happened, so a lost row is a false memory, not a missing log line.
  const { error: pushActivityError } = await svc.from("activities").insert({
    contact_id: contactId,
    brokerage_id: ctx.brokerageId,
    agent_user_id: ctx.userId,
    activity_type: "agent_property_push",
    description: activityBody,
    metadata: {
      search_query: searchQuery,
      agent_note: agentNote ?? null,
      match_count: results.length,
      listing_ids: results.map((r) => r.listing_id),
    },
  })
  if (pushActivityError) {
    console.error("[aiBuyerSearchPush] agent_property_push activity REJECTED — the contact timeline will not show this push:", pushActivityError.message)
  }

  // Create in-app notification for the buyer (via their portal user_id if set)
  if (contact.user_id) {
    const noteTitle = `${results.length} new propert${results.length !== 1 ? "ies" : "y"} found for you`
    const noteBody = agentNote
      ? `Your agent says: "${agentNote}". ${results[0]?.headline ?? ""}`
      : results[0]?.headline ?? `Your agent found properties matching: ${searchQuery}`

    await svc.from("notifications").insert({
      user_id: contact.user_id,
      brokerage_id: ctx.brokerageId,
      title: noteTitle,
      body: noteBody,
      type: "market_update",
      is_read: false,
      entity_type: "property_search",
      entity_id: contactId,
      priority: "medium",
    })
  }

  const topMatches = results.slice(0, 5).map((r) => ({
    listingId: r.listing_id,
    address: [r.city, r.state].filter(Boolean).join(", ") || null,
    price: r.price ?? null,
    beds: r.bedrooms ?? null,
    baths: r.bathrooms ?? null,
    matchScore: Math.round(r.internal_match_score * 100),
    headline: r.headline,
  }))

  return { success: true, matchCount: results.length, topMatches }
}
