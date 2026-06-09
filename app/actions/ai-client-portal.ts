"use server"

import { createClient } from "@/lib/supabase/server"
import { computeDaysOnMarket } from "@/lib/listings/compute-dom"

// Get education resources for a contact based on their persona
export async function getEducationResources(params: {
  contactId: string
  personaType?: string
  brokerageId?: string
}) {
  const supabase = await createClient()
  
  try {
    // Get contact's brokerage if not provided
    let brokerageId = params.brokerageId
    if (!brokerageId) {
      const { data: contact } = await supabase
        .from("contacts")
        .select("brokerage_id")
        .eq("id", params.contactId)
        .single()
      brokerageId = contact?.brokerage_id
    }

    // Post-1043: completion lives on learning_assignments keyed by module_id.
    const { data: progress } = await supabase
      .from("learning_assignments")
      .select("module_id")
      .eq("contact_id", params.contactId)
      .eq("status", "completed")

    const completedIds = new Set(((progress as Array<{ module_id: string }> | null) ?? []).map(p => p.module_id))

    // Catalog comes from learning_modules (canonical store). Persona filter
    // hits audience_personas; brokerage scope is enforced.
    let query = supabase
      .from("learning_modules")
      .select("id, title, summary, body, channels, audience_personas, cover_image_url, estimated_minutes, display_priority, created_at")
      .eq("status", "published")
      .order("display_priority", { ascending: false })
    if (brokerageId) query = query.eq("brokerage_id", brokerageId)
    if (params.personaType) {
      query = query.contains("audience_personas", [params.personaType])
    }

    const { data: resources, error } = await query
    if (error) throw error

    const mappedResources = ((resources as Array<{ id: string }> | null) ?? []).map(r => ({
      ...r,
      completed: completedIds.has(r.id),
    }))

    return { success: true, resources: mappedResources }
  } catch (error) {
    console.error("[getEducationResources] Error:", error)
    return { success: false, error: "Failed to fetch education resources", resources: [] }
  }
}

// Get recommended properties for a contact
export async function getRecommendedProperties(params: {
  contactId: string
  limit?: number
}) {
  const supabase = await createClient()
  
  try {
    // Budget lives on contacts; beds/cities criteria live in property_preferences. The old
    // code selected desired_neighborhoods/bedrooms_min/etc. off contacts (phantom columns) →
    // the query errored and the portal returned no matches.
    const { data: contact } = await supabase
      .from("contacts")
      .select("budget_min, budget_max")
      .eq("id", params.contactId)
      .single()

    if (!contact) {
      return { success: true, properties: [] }
    }

    const { loadBuyerCriteria } = await import("@/lib/buyer-search/buyer-criteria")
    const criteria = await loadBuyerCriteria(supabase as unknown as Parameters<typeof loadBuyerCriteria>[0], params.contactId)

    // Build query based on preferences
    let query = supabase
      .from("listings")
      .select("*")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(params.limit || 10)

    const minPrice = contact.budget_min ?? criteria?.minPrice ?? null
    const maxPrice = contact.budget_max ?? criteria?.maxPrice ?? null
    if (minPrice) {
      query = query.gte("list_price", minPrice)
    }
    if (maxPrice) {
      query = query.lte("list_price", maxPrice)
    }
    if (criteria?.minBeds) {
      query = query.gte("bedrooms", criteria.minBeds)
    }

    const { data: listings, error } = await query

    if (error) throw error

    // DOM is computed from go_live_date — the column does not exist on
    // listings. Materialize it before returning so client UIs can read
    // `days_on_market` directly.
    const properties = (listings || []).map((l: any) => ({
      ...l,
      days_on_market: computeDaysOnMarket(l.go_live_date),
    }))
    return { success: true, properties }
  } catch (error) {
    console.error("[getRecommendedProperties] Error:", error)
    return { success: false, error: "Failed to fetch recommended properties", properties: [] }
  }
}

// Mark education resource as completed
// Post-1043: completion lives on learning_assignments(contact_id, module_id).
// `resourceId` is now a learning_modules.id (uuid).
export async function markResourceCompleted(params: {
  contactId: string
  resourceId: string
  brokerageId?: string
  completionData?: Record<string, unknown>
}) {
  const supabase = await createClient()

  try {
    let brokerageId = params.brokerageId
    if (!brokerageId) {
      const { data: contact } = await supabase
        .from("contacts")
        .select("brokerage_id")
        .eq("id", params.contactId)
        .single()
      brokerageId = contact?.brokerage_id
    }

    const { error } = await supabase
      .from("learning_assignments")
      .upsert({
        brokerage_id:   brokerageId,
        module_id:      params.resourceId,
        contact_id:     params.contactId,
        signal_source:  "self:portal_complete",
        priority_score: 50,
        status:         "completed",
        completed_at:   new Date().toISOString(),
      }, { onConflict: "contact_id,module_id" })

    if (error) throw error

    return { success: true }
  } catch (error) {
    console.error("[markResourceCompleted] Error:", error)
    return { success: false, error: "Failed to mark resource as completed" }
  }
}

// Get client journey milestones
export async function getJourneyMilestones(params: {
  contactId: string
  transactionId?: string
}) {
  const supabase = await createClient()
  
  try {
    let query = supabase
      .from("transaction_milestones")
      .select("*, transactions(*)")
      .order("due_date", { ascending: true })

    if (params.transactionId) {
      query = query.eq("transaction_id", params.transactionId)
    } else {
      // Get milestones for contact's active transaction
      const { data: transactions } = await supabase
        .from("transactions")
        .select("id")
        .eq("contact_id", params.contactId)
        .eq("status", "active")
        .limit(1)

      if (transactions && transactions.length > 0) {
        query = query.eq("transaction_id", transactions[0].id)
      } else {
        return { success: true, milestones: [] }
      }
    }

    const { data: milestones, error } = await query

    if (error) throw error

    return { success: true, milestones: milestones || [] }
  } catch (error) {
    console.error("[getJourneyMilestones] Error:", error)
    return { success: false, error: "Failed to fetch milestones", milestones: [] }
  }
}

// Get agent info for a contact
export async function getContactAgent(params: { contactId: string }) {
  const supabase = await createClient()
  
  try {
    const { data: contact, error } = await supabase
      .from("contacts")
      .select(`
        agent_id,
        agents:agent_id (
          id,
          full_name,
          email,
          phone,
          photo_url,
          bio,
          specializations,
          years_experience,
          avg_days_to_sell,
          transactions_closed
        )
      `)
      .eq("id", params.contactId)
      .single()

    if (error) throw error

    return { success: true, agent: contact?.agents || null }
  } catch (error) {
    console.error("[getContactAgent] Error:", error)
    return { success: false, error: "Failed to fetch agent info", agent: null }
  }
}
