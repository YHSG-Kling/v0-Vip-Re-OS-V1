"use server"

import { createClient } from "@/lib/supabase/server"

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

    // Get contact's completed lessons from contact_education_progress
    const { data: progress } = await supabase
      .from("contact_education_progress")
      .select("lesson_key, completed_at")
      .eq("contact_id", params.contactId)
      .not("completed_at", "is", null)

    const completedKeys = new Set((progress || []).map(p => p.lesson_key))

    // Get education resources filtered by persona type
    let query = supabase
      .from("education_resources")
      .select("*")
      .eq("is_active", true)
      .order("sort_order", { ascending: true })

    if (params.personaType) {
      query = query.contains("persona_types", [params.personaType])
    }

    const { data: resources, error } = await query

    if (error) throw error

    // Mark completed resources based on lesson_key matches
    const mappedResources = (resources || []).map(r => ({
      ...r,
      completed: completedKeys.has(r.lesson_key || r.id),
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
    // Get contact preferences
    const { data: contact } = await supabase
      .from("contacts")
      .select("budget_min, budget_max, desired_neighborhoods, property_type, bedrooms_min, bathrooms_min")
      .eq("id", params.contactId)
      .single()

    if (!contact) {
      return { success: true, properties: [] }
    }

    // Build query based on preferences
    let query = supabase
      .from("listings")
      .select("*")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(params.limit || 10)

    // Apply budget filters if set
    if (contact.budget_min) {
      query = query.gte("list_price", contact.budget_min)
    }
    if (contact.budget_max) {
      query = query.lte("list_price", contact.budget_max)
    }
    if (contact.bedrooms_min) {
      query = query.gte("bedrooms", contact.bedrooms_min)
    }

    const { data: listings, error } = await query

    if (error) throw error

    return { success: true, properties: listings || [] }
  } catch (error) {
    console.error("[getRecommendedProperties] Error:", error)
    return { success: false, error: "Failed to fetch recommended properties", properties: [] }
  }
}

// Mark education resource as completed
// Schema: contact_education_progress uses lesson_key (not resource_id) with contact_id, brokerage_id, completed_at
export async function markResourceCompleted(params: {
  contactId: string
  resourceId: string
  brokerageId?: string
  completionData?: Record<string, unknown>
}) {
  const supabase = await createClient()
  
  try {
    // Get brokerage_id if not provided
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
      .from("contact_education_progress")
      .upsert({
        contact_id: params.contactId,
        brokerage_id: brokerageId,
        lesson_key: params.resourceId,
        completed_at: new Date().toISOString(),
      }, { onConflict: "contact_id,lesson_key" })

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
