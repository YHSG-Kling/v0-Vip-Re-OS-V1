"use server"

import { createClient } from "@/lib/supabase/server"
import { PeopleDataClient } from "@/lib/external"
import { OSINTClient } from "@/lib/osint-client"
import { validateEmail, validatePhone } from "@/lib/contact-validation"

const peopleData = new PeopleDataClient()
const osint = new OSINTClient()

// Life change types that indicate real estate intent
const LIFE_CHANGE_TYPES = [
  "divorce",
  "marriage",
  "job_change",
  "relocation",
  "new_baby",
  "death_in_family",
  "retirement",
  "foreclosure",
  "bankruptcy",
  "inheritance",
]

/**
 * Enrich a single contact with PeopleData, OSINT, and validation
 * Skips if already enriched unless forceRefresh is true
 */
export async function enrichContact(
  contactId: string,
  options: {
    forceRefresh?: boolean
    source?: "manual" | "auto" | "ghl_sync" | "import"
  } = {},
): Promise<{ success: boolean; enriched: boolean; error?: string }> {
  const supabase = await createClient()

  try {
    // Get contact
    const { data: contact, error } = await supabase.from("contacts").select("*").eq("id", contactId).single()

    if (error || !contact) {
      return { success: false, enriched: false, error: "Contact not found" }
    }

    // Skip if already enriched (unless force refresh)
    if (contact.enriched_at && !options.forceRefresh) {
      console.log(`[ContactEnrichment] Skipping ${contactId} - already enriched`)
      return { success: true, enriched: false }
    }

    let enrichmentData: any = {}
    const validationResults: any = {}

    // 1. Validate email
    if (contact.email) {
      const emailValidation = await validateEmail(contact.email)
      validationResults.email = emailValidation

      if (emailValidation.isValid) {
        await supabase
          .from("contacts")
          .update({
            email_verified: true,
            email_verification_date: new Date().toISOString(),
          })
          .eq("id", contactId)
      }
    }

    // 2. Validate phone
    if (contact.phone) {
      const phoneValidation = await validatePhone(contact.phone)
      validationResults.phone = phoneValidation

      if (phoneValidation.isValid) {
        await supabase
          .from("contacts")
          .update({
            phone_verified: true,
            phone_verification_date: new Date().toISOString(),
            phone_type: phoneValidation.lineType,
          })
          .eq("id", contactId)
      }
    }

    // 3. Enrich with PeopleData
    const personData = await peopleData.enrichPerson({
      firstName: contact.first_name,
      lastName: contact.last_name,
      email: contact.email,
      phone: contact.phone,
      address: contact.address,
    })

    if (personData) {
      enrichmentData = {
        ...enrichmentData,
        age_range: personData.ageRange,
        gender: personData.gender,
        marital_status: personData.maritalStatus,
        household_income: personData.householdIncome,
        home_owner_status: personData.homeOwnerStatus,
        home_value_estimate: personData.homeValue,
        length_of_residence: personData.lengthOfResidence,
        occupation: personData.occupation,
        education_level: personData.educationLevel,
        linkedin_url: personData.socialProfiles?.linkedin,
        facebook_url: personData.socialProfiles?.facebook,
        twitter_url: personData.socialProfiles?.twitter,
        instagram_url: personData.socialProfiles?.instagram,
        data_source: "peopledata",
        confidence_score: personData.confidenceScore || 70,
      }
    }

    // 4. Run OSINT search
    const osintData = await osint.searchPerson({
      firstName: contact.first_name,
      lastName: contact.last_name,
      email: contact.email,
      phone: contact.phone,
      city: contact.city,
      state: contact.state,
    })

    if (osintData) {
      enrichmentData = {
        ...enrichmentData,
        public_records: osintData.publicRecords || [],
        court_records: osintData.courtRecords || [],
        property_records: osintData.propertyRecords || [],
        life_events: osintData.lifeEvents || [],
        last_life_event_detected: osintData.lifeEvents?.length > 0 ? new Date().toISOString() : null,
      }

      // If OSINT found social profiles, merge them
      if (osintData.socialProfiles) {
        enrichmentData.linkedin_url = enrichmentData.linkedin_url || osintData.socialProfiles.linkedin
        enrichmentData.facebook_url = enrichmentData.facebook_url || osintData.socialProfiles.facebook
        enrichmentData.twitter_url = enrichmentData.twitter_url || osintData.socialProfiles.twitter
      }
    }

    // 5. Save enrichment data
    const { error: upsertError } = await supabase.from("contact_enrichment_data").upsert(
      {
        contact_id: contactId,
        ...enrichmentData,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "contact_id",
      },
    )

    if (upsertError) {
      console.error("[ContactEnrichment] Error saving enrichment data:", upsertError)
    }

    // 6. Process any detected life changes (stored in contact_enrichment_data.life_events)
    // Life events are already stored in the enrichmentData above
    // No separate insertion needed as they're part of contact_enrichment_data

    // 7. Update contact as enriched
    await supabase
      .from("contacts")
      .update({
        enriched_at: new Date().toISOString(),
        enrichment_source: options.source || "auto",
        last_life_change_check: new Date().toISOString(),
      })
      .eq("id", contactId)

    return { success: true, enriched: true }
  } catch (error) {
    console.error("[ContactEnrichment] Error:", error)
    return { success: false, enriched: false, error: String(error) }
  }
}

/**
 * Enrich multiple contacts (for imports/bulk operations)
 */
export async function enrichContactsBatch(
  contactIds: string[],
  options: { source?: "manual" | "auto" | "ghl_sync" | "import" } = {},
): Promise<{ success: number; failed: number; skipped: number }> {
  let success = 0
  let failed = 0
  let skipped = 0

  for (const contactId of contactIds) {
    const result = await enrichContact(contactId, options)
    if (result.success) {
      if (result.enriched) {
        success++
      } else {
        skipped++
      }
    } else {
      failed++
    }

    // Rate limiting - wait 500ms between API calls
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  return { success, failed, skipped }
}

/**
 * Check for life changes on existing enriched contacts
 * Only runs OSINT, skips full enrichment
 */
export async function checkContactLifeChanges(
  contactId: string,
): Promise<{ success: boolean; changesFound: number; error?: string }> {
  const supabase = await createClient()

  try {
    // Get contact
    const { data: contact, error } = await supabase.from("contacts").select("*").eq("id", contactId).single()

    if (error || !contact) {
      return { success: false, changesFound: 0, error: "Contact not found" }
    }

    // Run OSINT search for life events only
    const osintData = await osint.searchLifeEvents({
      firstName: contact.first_name,
      lastName: contact.last_name,
      city: contact.city,
      state: contact.state,
    })

    let changesFound = 0

    if (osintData?.lifeEvents?.length > 0) {
      // Get existing life changes to avoid duplicates
      const { data: existingChanges } = await supabase
        .from("contact_enrichment_data")
        .select("life_events")
        .eq("contact_id", contactId)
        .single()

      const existingEvents = existingChanges?.life_events as any[] || []
      const existingTypes = new Set(existingEvents.map((e) => e.type))

      for (const event of osintData.lifeEvents) {
        // Skip if we already detected this type recently
        if (existingTypes.has(event.type)) continue

        // Update existing record with new life events
        const updatedEvents = [...existingEvents, {
          type: event.type,
          details: event.details,
          detected_at: new Date().toISOString(),
          confidence: event.confidence || 50
        }]

        await supabase.from("contact_enrichment_data").upsert({
          contact_id: contactId,
          life_events: updatedEvents,
          updated_at: new Date().toISOString(),
        })

        changesFound++
      }
    }

    // Update last check timestamp
    await supabase
      .from("contacts")
      .update({
        last_life_change_check: new Date().toISOString(),
      })
      .eq("id", contactId)

    return { success: true, changesFound }
  } catch (error) {
    console.error("[ContactEnrichment] Life change check error:", error)
    return { success: false, changesFound: 0, error: String(error) }
  }
}

/**
 * Get unenriched contacts for batch processing
 */
export async function getUnenrichedContacts(limit = 50): Promise<{ contacts: any[]; count: number }> {
  const supabase = await createClient()

  const { data, error, count } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, email, phone", { count: "exact" })
    .is("enriched_at", null)
    .order("created_at", { ascending: false })
    .limit(limit)

  if (error) {
    console.error("[ContactEnrichment] Error getting unenriched contacts:", error)
    return { contacts: [], count: 0 }
  }

  return { contacts: data || [], count: count || 0 }
}

/**
 * Get contacts needing life change check (not checked in last 30 days)
 */
export async function getContactsNeedingLifeChangeCheck(limit = 50): Promise<{ contacts: any[]; count: number }> {
  const supabase = await createClient()

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const { data, error, count } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, email, city, state", { count: "exact" })
    .not("enriched_at", "is", null) // Only already enriched contacts
    .or(`last_life_change_check.is.null,last_life_change_check.lt.${thirtyDaysAgo}`)
    .order("last_life_change_check", { ascending: true, nullsFirst: true })
    .limit(limit)

  if (error) {
    console.error("[ContactEnrichment] Error getting contacts for life change check:", error)
    return { contacts: [], count: 0 }
  }

  return { contacts: data || [], count: count || 0 }
}

/**
 * Get recent life changes for agent notification
 * Life events are stored in contact_enrichment_data.life_events (JSONB array)
 */
export async function getRecentLifeChanges(agentId?: string, daysBack = 7): Promise<any[]> {
  const supabase = await createClient()

  const cutoffDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString()

  // Get enrichment data with life events
  let query = supabase
    .from("contact_enrichment_data")
    .select(`
      contact_id,
      life_events,
      updated_at
    `)
    .not("life_events", "is", null)
    .gte("updated_at", cutoffDate)
    .order("updated_at", { ascending: false })
    .limit(50)

  const { data: enrichmentData, error } = await query

  if (error) {
    console.error("[ContactEnrichment] Error getting recent life changes:", error)
    return []
  }

  if (!enrichmentData || enrichmentData.length === 0) {
    return []
  }

  // Get contact details for the enrichment records
  const contactIds = enrichmentData.map(e => e.contact_id).filter(Boolean)
  
  const { data: contacts } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, email, phone, agent_id")
    .in("id", contactIds)

  const contactMap = new Map(contacts?.map(c => [c.id, c]) || [])

  // Filter by agent if provided and transform data
  const results = enrichmentData
    .map(e => {
      const contact = contactMap.get(e.contact_id)
      if (!contact) return null
      if (agentId && contact.agent_id !== agentId) return null
      
      // Parse life_events and return recent ones
      const lifeEvents = Array.isArray(e.life_events) ? e.life_events : []
      return lifeEvents.map((event: any) => ({
        ...event,
        contact_id: e.contact_id,
        contact: contact,
        detected_at: event.detected_at || e.updated_at,
      }))
    })
    .filter(Boolean)
    .flat()
    .filter(event => {
      // Filter events within the date range
      const detectedAt = new Date(event.detected_at)
      return detectedAt >= new Date(cutoffDate)
    })

  return results
}

/**
 * Mark life change as notified
 * Note: Life events are now stored in contact_enrichment_data.life_events JSONB
 * This function is a no-op placeholder for backward compatibility
 */
export async function markLifeChangeNotified(changeId: string): Promise<{ success: boolean }> {
  // Life events are stored in JSONB within contact_enrichment_data
  // Marking individual events as notified would require updating the JSONB array
  // For now, return success as this is typically called after displaying the notification
  console.log("[ContactEnrichment] markLifeChangeNotified called for:", changeId)
  return { success: true }
}

// Alias for backward compatibility
export const enrichContactData = enrichContact

/**
 * Get enrichment insights for a contact including enrichment data and recent life changes
 * Life events are stored in contact_enrichment_data.life_events (JSONB array)
 */
export async function getContactInsights(contactId: string): Promise<{
  enrichment: any | null
  lifeChanges: any[]
  lastEnriched: string | null
  error?: string
}> {
  const supabase = await createClient()

  try {
    // Get enrichment data (includes life_events in JSONB)
    const { data: enrichment, error: enrichmentError } = await supabase
      .from("contact_enrichment_data")
      .select("*")
      .eq("contact_id", contactId)
      .single()

    // Extract life changes from enrichment data
    const lifeChanges = Array.isArray(enrichment?.life_events) 
      ? enrichment.life_events 
      : []

    // Get last enriched timestamp from contact
    const { data: contact } = await supabase
      .from("contacts")
      .select("enriched_at")
      .eq("id", contactId)
      .single()

    return {
      enrichment: enrichment || null,
      lifeChanges,
      lastEnriched: contact?.enriched_at || null,
      error: enrichmentError?.message
    }
  } catch (error) {
    console.error("Error getting contact insights:", error)
    return {
      enrichment: null,
      lifeChanges: [],
      lastEnriched: null,
      error: String(error)
    }
  }
}
