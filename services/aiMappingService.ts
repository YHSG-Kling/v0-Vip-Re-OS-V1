

import { generateText } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"
import type { ContactStatus } from "@/lib/contact-promotion/qualification"
import {
  STANDARD_CONTACT_PERSONAS,
  PERSONA_DESCRIPTIONS,
  type StandardContactPersona,
} from "@/constants/crm-standards"

/**
 * REPOINTED (2026-08-31) onto the one `contacts.status` vocabulary —
 * lib/contact-promotion/qualification.ts CONTACT_STATUSES, the list the m587
 * CHECK enforces (same treatment as the STANDARD_TIMELINES / STANDARD_SOURCES
 * repoints recorded above). The eleven-member journey ladder that stood here
 * (appointment_booked … lifetime_customer) named DEAL/JOURNEY facts carried by
 * buyer_stage, listings.status, transactions and contact_type — no writer ever
 * stored any of them on contacts.status, and once the CHECK is applied an
 * import mapped onto them would be REFUSED ENTIRELY by Postgres (23514), which
 * supabase-js resolves (§3): the row would simply be lost.
 *
 * The mapper's TARGET set is deliberately narrower than the full vocabulary:
 * 'qualified' is EARNED (owner ruling — see qualification.ts; an import cannot
 * confer it, so an external "qualified" lands on 'active'), and
 * 'archived'/'deleted' are outcomes of in-app flows (agent departure, soft
 * delete with deleted_at), never of a CSV cell.
 */
export const STANDARD_CRM_STATUSES = [
  "new",
  "contacted",
  "active",
  "nurture",
  "inactive",
] as const satisfies readonly ContactStatus[]

export type StandardCRMStatus = (typeof STANDARD_CRM_STATUSES)[number]

// `STANDARD_CONTACT_PERSONAS` / `StandardContactPersona` — LOCAL COPY DELETED
// (§1.1 / §6, 2026-08-31). SURVIVOR: constants/crm-standards.ts
// STANDARD_CONTACT_PERSONAS + PERSONA_LABELS + PERSONA_DESCRIPTIONS, imported
// above — REKEYED THERE onto the live contacts_contact_persona_check vocabulary
// (13 values: first_time, luxury, relocated, upsize, downsize, military,
// foreclosure, divorce, probate, senior, expired, fsbo, other).
//
// The copy that stood here was 16 members (first_time_buyer, luxury_buyer,
// motivated_seller, empty_nester, remote_seller, upsizers, …) and mapPersona
// below normalized every imported persona ONTO it — values the live CHECK
// REFUSES, so createContact/updateContact (services/supabaseService.ts:236/268)
// handed Postgres a 23514 on any import that carried a persona, and §3 says
// that refusal kills the whole row. The mapper now targets the survivor's
// vocabulary, with its prompt built from PERSONA_DESCRIPTIONS so the two can
// never drift apart again. The two copies had acquitted each other on the
// orphan census exactly as the STANDARD_SOURCES note below records.

// ── TOMBSTONE (§1, 2026-09-01): `STANDARD_CONTACT_TYPES` / `StandardContactType`
// / `mapContactType` / `fallbackMapContactType` — DELETED, all four DEAD.
// SURVIVORS: lib/contact-types.ts CONTACT_TYPES (the live
// contacts_contact_type_check roster — m593 applied: lead, prospect,
// lifetime_customer, sphere, vendor, referral_partner, buyer, seller, both,
// other) and lib/data-steward/value-normalizer.ts ENUM_VOCABULARIES.contact_type
// — the import-normalization path that IS wired.
//
// The roster here declared FOUR values the live CHECK refuses — lender,
// commercial, agent, TC — yet this never produced a live 23514, because
// `mapContactType` had ZERO callers tree-wide (grep: only its definition and a
// comment; supabaseService consumes only mapStatus/mapPersona). A mapper whose
// target set the database refuses is worse than no mapper, so it goes rather
// than gets repointed. Where each refused concept actually lives:
//   lender     → vendors.category='lender' / users.user_type='lender' /
//                referral_partners.partner_type='mortgage_broker' /
//                lender_applications (FK to vendors)
//   commercial → contacts.property_type='commercial' — a property attribute,
//                not a transaction side
//   agent      → contacts.contact_type='referral_partner' as a contact;
//                internal agents are agents-table rows
//   TC         → users.user_type='tc' (m036 retired the Title-Case spelling) +
//                contacts.tc_user_id
// NOT TOUCHED: mapStatus/mapPersona and their lists — live (see the note below).

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
// `STANDARD_CRM_STATUSES` / `STANDARD_CONTACT_PERSONAS` lists they validate
// against and their fallback matchers. (`STANDARD_CONTACT_TYPES` and its
// mapContactType were dead and are deleted — tombstone above.)

// `STANDARD_SOURCES` / `StandardSource` — DELETED HERE (2026-08-29), the same
// way and for the same reason as the timeline pair above it.
// SURVIVOR: lib/constants/index.ts:152 `LEAD_SOURCES` + `LEAD_SOURCE_LABELS`,
// merged onto FIRST: this list's `social` and `realtor.com` were SPELLINGS of
// members the survivor already had, so they are folded into
// `LEAD_SOURCE_ALIASES` rather than becoming vocabulary members of their own;
// `website`, `referral`, `cold_call`, `zillow` and `other` were already there.
//
// Checked rather than assumed, exactly as the timeline note above records:
//   · this module has NO `mapSource` — nothing here ever consumed the list, so
//     it normalized nothing on any write path;
//   · `grep -rn "STANDARD_SOURCES\|StandardSource"` (comment-stripped) matched
//     this file and constants/crm-standards.ts and nothing else, and that other
//     copy is deleted in the same change;
//   · the only import of this module anywhere is
//     `import { aiMappingService } from "./aiMappingService"`
//     (services/supabaseService.ts:5) — the OBJECT, never these two symbols.
//
// The two copies were invisible to the orphan census because they ACQUITTED
// EACH OTHER — both spell the identifier `STANDARD_SOURCES`, and the census asks
// whether a name occurs in another file, not whether that file reaches this
// module. A dead vocabulary with a same-named twin is cleared forever.

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
- active: Actively being worked (engaged, qualified externally, in a deal, appointment set)
- nurture: Long-term nurture / not ready yet / cold but keep in touch
- inactive: Dormant, lost, dead, unresponsive, or otherwise done for now

Return ONLY the exact status keyword (e.g., "active"), nothing else.`,
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
        // The persona list is BUILT from the canonical roster + descriptions
        // (constants/crm-standards.ts) — the same vocabulary the live
        // contacts_contact_persona_check enforces — so this prompt can never
        // again offer the model a value Postgres refuses.
        prompt: `You are a CRM data normalization expert for a real estate platform. Map the following external contact persona to the CLOSEST matching standard persona.

External persona: "${externalPersona}"

Standard contact personas (choose ONLY from these - these are the EXACT values we use):
${STANDARD_CONTACT_PERSONAS.map((p) => `- ${p}: ${PERSONA_DESCRIPTIONS[p]}`).join("\n")}

Return ONLY the exact persona keyword (e.g., "first_time"), nothing else.`,
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

  // `mapContactType` stood here — DELETED with its roster; tombstone above
  // STANDARD_CRM_STATUSES' sibling note (SURVIVORS: lib/contact-types.ts
  // CONTACT_TYPES + lib/data-steward/value-normalizer.ts
  // ENUM_VOCABULARIES.contact_type).

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

  // Common variations mapped onto the canonical vocabulary (the journey-ladder
  // targets that stood here — appointment_booked, signed_agreement, …, sold —
  // named deal facts contacts.status never carried; see STANDARD_CRM_STATUSES).
  if (lower.includes("qualified")) return "active" // earned in-app, never by import
  if (lower.includes("active") || lower.includes("working") || lower.includes("hot")) return "active"
  if (lower.includes("cold") || lower.includes("nurture") || lower.includes("long")) return "nurture"
  if (lower.includes("appointment") || lower.includes("scheduled") || lower.includes("meeting")) return "active"
  if (lower.includes("agreement") || lower.includes("signed") || lower.includes("contract")) return "active"
  if (lower.includes("listing") || lower.includes("listed")) return "active"
  if (lower.includes("contingent") || lower.includes("pending")) return "active"
  if (lower.includes("sold") || lower.includes("closed") || lower.includes("won")) return "inactive"
  if (lower.includes("lifetime") || lower.includes("past client")) return "active"
  if (lower.includes("contact") || lower.includes("touch") || lower.includes("reached")) return "contacted"
  if (lower.includes("lost") || lower.includes("dead") || lower.includes("unresponsive")) return "inactive"

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

  // Matchers target the LIVE persona vocabulary (constants/crm-standards.ts — the rekey note
  // there records the merge). The old 16-value spellings arrive here as EXTERNAL input now:
  // "first_time_buyer" → first_time, "empty_nester" → downsize, "upsizers" → upsize, etc.
  // `motivated_seller` (and bare "motivated"/"urgent") deliberately has NO
  // matcher here and falls to "other" — the mapper's no-persona answer. The
  // persona says the SITUATION (probate/divorce/foreclosure/expired/fsbo/senior
  // already name the why), lead_temperature says the urgency, and the scraping
  // pipeline's motivation facts (motivated_seller_signals, motivation_type)
  // keep the fact. Mapping it onto a distress persona would be a guess.
  if (lower.includes("invest") || lower.includes("landlord") || lower.includes("flip")) return "investor"
  if (lower.includes("first") && (lower.includes("buy") || lower.includes("sell") || lower.includes("time"))) return "first_time"
  if (lower.includes("luxury") || lower.includes("high-end") || lower.includes("high end")) return "luxury"
  if (lower.includes("relocat") || lower.includes("transfer") || lower.includes("moving")) return "relocated"
  if (lower.includes("empty") || lower.includes("downsiz") || lower.includes("nest")) return "downsize"
  if (lower.includes("upsize") || lower.includes("upgrade") || lower.includes("move up")) return "upsize"
  if (lower.includes("military") || lower.includes("pcs") || lower.includes("veteran")) return "military"
  if (lower.includes("foreclos") || lower.includes("pre-foreclos") || lower.includes("short sale")) return "foreclosure"
  if (lower.includes("probate") || lower.includes("estate") || lower.includes("inherit")) return "probate"
  if (lower.includes("divorce") || lower.includes("separation")) return "divorce"
  if (lower.includes("senior") || lower.includes("retire") || lower.includes("55+")) return "senior"
  if (lower.includes("expired") || lower.includes("relisting")) return "expired"
  if (lower.includes("fsbo") || lower.includes("for sale by owner") || lower.includes("owner sell")) return "fsbo"

  return "other"
}

// `fallbackMapContactType` stood here — DELETED with `mapContactType` (its only
// caller) and the STANDARD_CONTACT_TYPES roster; see the tombstone at the top of
// this file. Its matchers targeted lender / commercial / agent / TC — values the
// live contacts_contact_type_check refuses (SURVIVOR roster:
// lib/contact-types.ts CONTACT_TYPES; wired normalizer:
// lib/data-steward/value-normalizer.ts ENUM_VOCABULARIES.contact_type).
