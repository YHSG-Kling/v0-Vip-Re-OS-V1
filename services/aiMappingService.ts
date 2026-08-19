

import { generateText } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"

export const STANDARD_CRM_STATUSES = [
  "new",
  "contacted",
  "qualified",
  "appointment_booked",
  "signed_agreement",
  "pre_listing",
  "active_listing",
  "contingent",
  "pending",
  "sold",
  "lifetime_customer",
] as const

export type StandardCRMStatus = (typeof STANDARD_CRM_STATUSES)[number]

export const STANDARD_CONTACT_PERSONAS = [
  "first_time_buyer",
  "luxury_buyer",
  "luxury_seller",
  "investor",
  "first_time_seller",
  "motivated_seller",
  "relocating",
  "empty_nester",
  "probate",
  "remote_seller",
  "divorce",
  "upsizers",
  "senior",
  "expired",
  "fsbo",
  "other",
] as const

export type StandardContactPersona = (typeof STANDARD_CONTACT_PERSONAS)[number]

export const STANDARD_CONTACT_TYPES = [
  "buyer",
  "seller",
  "investor",
  "lender",
  "commercial",
  "other",
  "agent",
  "vendor",
  "TC",
] as const

export type StandardContactType = (typeof STANDARD_CONTACT_TYPES)[number]

// `STANDARD_TIMELINES` / `StandardTimeline` — DELETED HERE.
// SURVIVOR: constants/crm-standards.ts:119 (`STANDARD_TIMELINES`), with labels
// at constants/crm-standards.ts:193 (`TIMELINE_LABELS`) and the matching live
// CHECK installed by supabase/migrations/m487.
//
// This was a fourth copy of the timeline vocabulary
// (`0-3_months | 3-6_months | 6-12_months | 12+_months`) and it was DEAD, which
// was checked rather than assumed before deleting it:
//   · this module has no `mapTimeline` — nothing here ever consumed the list;
//   · `grep -rn "STANDARD_TIMELINES\|StandardTimeline"` over the tree matched
//     this file, constants/crm-standards.ts and nothing else. The only import of
//     this module anywhere is `import { aiMappingService } from "./aiMappingService"`
//     (services/supabaseService.ts:5) — the OBJECT, never these two symbols.
// So it normalized nothing on any write path, despite a note in
// constants/crm-standards.ts previously claiming it did.
//
// NOT TOUCHED, because they ARE live: mapStatus and mapPersona below, called by
// services/supabaseService.ts at 154, 157, 184, 189 and 1834, together with the
// `STANDARD_CRM_STATUSES` / `STANDARD_CONTACT_PERSONAS` / `STANDARD_CONTACT_TYPES`
// lists they validate against and their fallback matchers.

export const STANDARD_SOURCES = [
  "website",
  "referral",
  "cold_call",
  "social",
  "other",
  "zillow",
  "realtor.com",
] as const

export type StandardSource = (typeof STANDARD_SOURCES)[number]

/**
 * AI-powered mapping service that converts external/imported field values
 * to standardized internal CRM values for consistency across workflows
 */
export const aiMappingService = {
  /**
   * Maps any external status value to the closest standardized CRM status
   * Uses AI to intelligently determine the best match
   */
  async mapStatus(externalStatus: string): Promise<StandardCRMStatus> {
    try {
      const { text } = await generateText({
        model: resolveModel("openai/gpt-4o-mini"),
        prompt: `You are a CRM data normalization expert for a real estate platform. Map the following external contact status to the CLOSEST matching standard CRM status.

External status: "${externalStatus}"

Standard CRM statuses (choose ONLY from these - these are the EXACT values we use):
- new: Brand new contact, not yet contacted
- contacted: Initial contact made, awaiting response
- qualified: Vetted and qualified as a serious lead
- appointment_booked: Has scheduled appointment to meet
- signed_agreement: Signed buyer/seller agreement
- pre_listing: Seller preparing to list
- active_listing: Property actively listed on market
- contingent: Under contract with contingencies
- pending: Under contract, pending close
- sold: Successfully closed transaction
- lifetime_customer: Past client, now lifetime relationship

Return ONLY the exact status keyword (e.g., "qualified"), nothing else.`,
        temperature: 0.1, // Low temperature for consistency
      })

      const mapped = text.trim().toLowerCase()

      // Validate that the AI returned a valid status
      if (STANDARD_CRM_STATUSES.includes(mapped as StandardCRMStatus)) {
        console.log(`[AI Mapping] Mapped "${externalStatus}" → "${mapped}"`)
        return mapped as StandardCRMStatus
      }

      // Fallback: if AI returns invalid status, default to "new"
      console.warn(`[AI Mapping] Invalid AI response "${mapped}" for "${externalStatus}", defaulting to "new"`)
      return "new"
    } catch (error) {
      console.error("[AI Mapping] Error mapping status:", error)
      // Fallback to simple string matching if AI fails
      return fallbackMapStatus(externalStatus)
    }
  },

  /**
   * Maps any external persona/segment value to standardized contact persona
   */
  async mapPersona(externalPersona: string): Promise<StandardContactPersona> {
    try {
      const { text } = await generateText({
        model: resolveModel("openai/gpt-4o-mini"),
        prompt: `You are a CRM data normalization expert for a real estate platform. Map the following external contact persona to the CLOSEST matching standard persona.

External persona: "${externalPersona}"

Standard contact personas (choose ONLY from these - these are the EXACT values we use):
- first_time_buyer: First-time home buyer
- luxury_buyer: Luxury/high-end property buyer
- luxury_seller: Luxury/high-end property seller
- investor: Real estate investor
- first_time_seller: First time selling a property
- motivated_seller: Needs to sell quickly/urgently
- relocating: Moving to new area for job/life change
- empty_nester: Downsizing after kids leave
- probate: Inherited property, probate sale
- remote_seller: Selling from distance/remotely
- divorce: Divorce-related property sale
- upsizers: Buying larger property, moving up
- senior: Senior citizen with age-specific needs
- expired: Expired listing owner
- fsbo: For Sale By Owner (selling without agent)
- other: Other/unclassified

Return ONLY the exact persona keyword (e.g., "first_time_buyer"), nothing else.`,
        temperature: 0.1,
      })

      const mapped = text.trim().toLowerCase()

      if (STANDARD_CONTACT_PERSONAS.includes(mapped as StandardContactPersona)) {
        console.log(`[AI Mapping] Mapped persona "${externalPersona}" → "${mapped}"`)
        return mapped as StandardContactPersona
      }

      console.warn(`[AI Mapping] Invalid persona response "${mapped}", defaulting to "other"`)
      return "other"
    } catch (error) {
      console.error("[AI Mapping] Error mapping persona:", error)
      return fallbackMapPersona(externalPersona)
    }
  },

  /**
   * Maps any external contact type to standardized contact type
   */
  async mapContactType(externalType: string): Promise<StandardContactType> {
    try {
      const { text } = await generateText({
        model: resolveModel("openai/gpt-4o-mini"),
        prompt: `You are a CRM data normalization expert for a real estate platform. Map the following external contact type to the CLOSEST matching standard type.

External type: "${externalType}"

Standard contact types (choose ONLY from these):
- buyer: Looking to purchase property
- seller: Looking to sell property
- investor: Investment property focus
- lender: Loan officer/mortgage lender
- commercial: Commercial property
- agent: Real estate agent (partner)
- vendor: Service vendor (photographer, stager, etc)
- TC: Transaction Coordinator
- other: Unclassified

Return ONLY the exact type keyword (e.g., "buyer"), nothing else.`,
        temperature: 0.1,
      })

      const mapped = text.trim().toLowerCase()

      if (STANDARD_CONTACT_TYPES.includes(mapped as StandardContactType)) {
        console.log(`[AI Mapping] Mapped type "${externalType}" → "${mapped}"`)
        return mapped as StandardContactType
      }

      console.warn(`[AI Mapping] Invalid type response "${mapped}", defaulting to "other"`)
      return "other"
    } catch (error) {
      console.error("[AI Mapping] Error mapping contact type:", error)
      return fallbackMapContactType(externalType)
    }
  },

  /**
   * Batch map multiple contacts' statuses at once (for imports)
   */
  async batchMapStatuses(statuses: string[]): Promise<StandardCRMStatus[]> {
    const uniqueStatuses = [...new Set(statuses)]
    const mappingPromises = uniqueStatuses.map((status) => this.mapStatus(status))
    const mappedUnique = await Promise.all(mappingPromises)

    // Create a map for O(1) lookups
    const statusMap = new Map<string, StandardCRMStatus>()
    uniqueStatuses.forEach((status, i) => {
      statusMap.set(status, mappedUnique[i])
    })

    // Return mapped statuses in original order
    return statuses.map((status) => statusMap.get(status) || "new")
  },

  /**
   * Batch map multiple personas at once (for imports)
   */
  async batchMapPersonas(personas: string[]): Promise<StandardContactPersona[]> {
    const uniquePersonas = [...new Set(personas)]
    const mappingPromises = uniquePersonas.map((persona) => this.mapPersona(persona))
    const mappedUnique = await Promise.all(mappingPromises)

    const personaMap = new Map<string, StandardContactPersona>()
    uniquePersonas.forEach((persona, i) => {
      personaMap.set(persona, mappedUnique[i])
    })

    return personas.map((persona) => personaMap.get(persona) || "other")
  },
}

/**
 * Fallback status mapping using simple string matching (no AI)
 */
function fallbackMapStatus(externalStatus: string): StandardCRMStatus {
  const lower = externalStatus.toLowerCase().trim()

  // Direct matches
  if (STANDARD_CRM_STATUSES.includes(lower as StandardCRMStatus)) {
    return lower as StandardCRMStatus
  }

  // Common variations mapped to specification statuses
  if (lower.includes("active") || lower.includes("working") || lower.includes("hot")) return "qualified"
  if (lower.includes("cold") || lower.includes("nurture") || lower.includes("long")) return "new"
  if (lower.includes("appointment") || lower.includes("scheduled") || lower.includes("meeting"))
    return "appointment_booked"
  if (lower.includes("agreement") || lower.includes("signed") || lower.includes("contract signed"))
    return "signed_agreement"
  if (lower.includes("pre") && lower.includes("list")) return "pre_listing"
  if (lower.includes("listing") || lower.includes("listed")) return "active_listing"
  if (lower.includes("contingent")) return "contingent"
  if (lower.includes("pending") || lower.includes("under contract")) return "pending"
  if (lower.includes("sold") || lower.includes("closed") || lower.includes("won")) return "sold"
  if (lower.includes("lifetime") || lower.includes("past client")) return "lifetime_customer"
  if (lower.includes("contact") || lower.includes("touch") || lower.includes("reached")) return "contacted"
  if (lower.includes("lost") || lower.includes("dead") || lower.includes("unresponsive")) return "new" // Reset to new

  // Default to new for unknown statuses
  return "new"
}

/**
 * Fallback persona mapping (no AI)
 */
function fallbackMapPersona(externalPersona: string): StandardContactPersona {
  const lower = externalPersona.toLowerCase().trim()

  if (STANDARD_CONTACT_PERSONAS.includes(lower as StandardContactPersona)) {
    return lower as StandardContactPersona
  }

  if (lower.includes("first") && lower.includes("buy")) return "first_time_buyer"
  if (lower.includes("first") && lower.includes("sell")) return "first_time_seller"
  if (lower.includes("luxury") && lower.includes("buy")) return "luxury_buyer"
  if (lower.includes("luxury") && lower.includes("sell")) return "luxury_seller"
  if (lower.includes("investor") || lower.includes("investment")) return "investor"
  if (lower.includes("motivat") || lower.includes("urgent") || lower.includes("quick")) return "motivated_seller"
  if (lower.includes("relocat") || lower.includes("transfer") || lower.includes("moving")) return "relocating"
  if (lower.includes("empty") || lower.includes("downsize") || lower.includes("nest")) return "empty_nester"
  if (lower.includes("probate") || lower.includes("estate") || lower.includes("inherit")) return "probate"
  if (lower.includes("remote") || lower.includes("distance") || lower.includes("out of state")) return "remote_seller"
  if (lower.includes("divorce") || lower.includes("separation")) return "divorce"
  if (lower.includes("upsize") || lower.includes("upgrade") || lower.includes("move up")) return "upsizers"
  if (lower.includes("senior") || lower.includes("retire") || lower.includes("55+")) return "senior"
  if (lower.includes("expired") || lower.includes("relisting")) return "expired"
  if (lower.includes("fsbo") || lower.includes("for sale by owner") || lower.includes("owner sell")) return "fsbo"

  return "other"
}

/**
 * Fallback contact type mapping (no AI)
 */
function fallbackMapContactType(externalType: string): StandardContactType {
  const lower = externalType.toLowerCase().trim()

  if (STANDARD_CONTACT_TYPES.includes(lower as StandardContactType)) {
    return lower as StandardContactType
  }

  if (lower.includes("buy") || lower.includes("purchas")) return "buyer"
  if (lower.includes("sell") || lower.includes("list")) return "seller"
  if (lower.includes("invest")) return "investor"
  if (lower.includes("lend") || lower.includes("loan") || lower.includes("mortgage")) return "lender"
  if (lower.includes("commercial") || lower.includes("business")) return "commercial"
  if (lower.includes("agent") || lower.includes("broker") || lower.includes("realtor")) return "agent"
  if (lower.includes("vendor") || lower.includes("service") || lower.includes("contractor")) return "vendor"
  if (lower.includes("tc") || lower.includes("transaction") || lower.includes("coordinator")) return "TC"

  return "other"
}
