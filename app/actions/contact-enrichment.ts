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

    // 5. Save enrichment data directly to the contacts table
    const { error: updateError } = await supabase
      .from("contacts")
      .update({
        // Demographic data
        age_range: enrichmentData.age_range,
        gender: enrichmentData.gender,
        marital_status: enrichmentData.marital_status,
        household_income: enrichmentData.household_income,
        home_owner_status: enrichmentData.home_owner_status,
        home_value_estimate: enrichmentData.home_value_estimate,
        length_of_residence: enrichmentData.length_of_residence,
        occupation: enrichmentData.occupation,
        education_level: enrichmentData.education_level,
        // Social profiles
        linkedin_url: enrichmentData.linkedin_url,
        facebook_url: enrichmentData.facebook_url,
        twitter_url: enrichmentData.twitter_url,
        instagram_url: enrichmentData.instagram_url,
        // Life events and OSINT data
        life_events: enrichmentData.life_events || [],
        last_life_event_detected: enrichmentData.last_life_event_detected,
        public_records: enrichmentData.public_records || [],
        court_records: enrichmentData.court_records || [],
        property_records: enrichmentData.property_records || [],
        // Metadata
        data_source: enrichmentData.data_source,
        confidence_score: enrichmentData.confidence_score || 70,
      })
      .eq("id", contactId)

    if (updateError) {
      console.error("[ContactEnrichment] Error saving enrichment data:", updateError)
      return { success: false, enriched: false, error: updateError.message }
    }

    // 6. Update contact enrichment tracking metadata
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
      // Get existing life events from the contact
      const { data: contactData } = await supabase
        .from("contacts")
        .select("life_events")
        .eq("id", contactId)
        .single()

      const existingEvents = (contactData?.life_events as any[]) || []
      const existingTypes = new Set(existingEvents.map((e: any) => e.type))

      for (const event of osintData.lifeEvents) {
        // Skip if we already detected this type recently
        if (existingTypes.has(event.type)) continue

        // Add new life event to the array
        const updatedEvents = [
          ...existingEvents,
          {
            type: event.type,
            details: event.details,
            detected_at: new Date().toISOString(),
            confidence: event.confidence || 50,
          },
        ]

        // Update contact with new life events
        await supabase
          .from("contacts")
          .update({
            life_events: updatedEvents,
            last_life_event_detected: new Date().toISOString(),
          })
          .eq("id", contactId)

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
 * Life events are stored in contacts.life_events (JSONB array)
 */
export async function getRecentLifeChanges(agentId?: string, daysBack = 7): Promise<any[]> {
  const supabase = await createClient()

  const cutoffDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString()

  // Get contacts with recent life events
  let query = supabase
    .from("contacts")
    .select("id, first_name, last_name, email, phone, agent_id, life_events, last_life_event_detected")
    .not("life_events", "is", null)
    .gte("last_life_event_detected", cutoffDate)
    .order("last_life_event_detected", { ascending: false })
    .limit(50)

  // Filter by agent if provided
  if (agentId) {
    query = query.eq("agent_id", agentId)
  }

  const { data: contacts, error } = await query

  if (error) {
    console.error("[ContactEnrichment] Error getting recent life changes:", error)
    return []
  }

  if (!contacts || contacts.length === 0) {
    return []
  }

  // Transform data - expand life events from each contact
  const results = contacts
    .map((contact) => {
      const lifeEvents = (contact.life_events as any[]) || []
      
      // Return life events with contact info
      return lifeEvents
        .filter((event: any) => {
          // Only include events detected within the time window
          const detectedAt = new Date(event.detected_at || contact.last_life_event_detected || 0)
          return detectedAt >= new Date(cutoffDate)
        })
        .map((event: any) => ({
          ...event,
          contact_id: contact.id,
          contact: {
            id: contact.id,
            first_name: contact.first_name,
            last_name: contact.last_name,
            email: contact.email,
            phone: contact.phone,
            agent_id: contact.agent_id,
          },
          detected_at: event.detected_at || contact.last_life_event_detected,
        }))
    })
    .flat()

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
 * All enrichment data is stored directly on the contacts table
 */
export async function getContactInsights(contactId: string): Promise<{
  enrichment: any | null
  lifeChanges: any[]
  lastEnriched: string | null
  error?: string
}> {
  const supabase = await createClient()

  try {
    // Get contact with all enrichment data
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select(`
        id,
        enriched_at,
        enrichment_source,
        confidence_score,
        data_source,
        age_range,
        gender,
        marital_status,
        household_income,
        home_owner_status,
        home_value_estimate,
        length_of_residence,
        occupation,
        education_level,
        linkedin_url,
        facebook_url,
        twitter_url,
        instagram_url,
        life_events,
        last_life_event_detected,
        public_records,
        court_records,
        property_records
      `)
      .eq("id", contactId)
      .maybeSingle()

    if (contactError) {
      return {
        enrichment: null,
        lifeChanges: [],
        lastEnriched: null,
        error: contactError.message,
      }
    }

    // Extract life changes from contact data
    const lifeChanges = (contact?.life_events as any[]) || []

    // Build enrichment object from contact data
    const enrichment = contact
      ? {
          age_range: contact.age_range,
          gender: contact.gender,
          marital_status: contact.marital_status,
          household_income: contact.household_income,
          home_owner_status: contact.home_owner_status,
          home_value_estimate: contact.home_value_estimate,
          length_of_residence: contact.length_of_residence,
          occupation: contact.occupation,
          education_level: contact.education_level,
          linkedin_url: contact.linkedin_url,
          facebook_url: contact.facebook_url,
          twitter_url: contact.twitter_url,
          instagram_url: contact.instagram_url,
          public_records: contact.public_records,
          court_records: contact.court_records,
          property_records: contact.property_records,
          data_source: contact.data_source,
          confidence_score: contact.confidence_score,
        }
      : null

    return {
      enrichment,
      lifeChanges,
      lastEnriched: contact?.enriched_at || null,
    }
  } catch (error) {
    console.error("Error getting contact insights:", error)
    return {
      enrichment: null,
      lifeChanges: [],
      lastEnriched: null,
      error: String(error),
    }
  }
}
