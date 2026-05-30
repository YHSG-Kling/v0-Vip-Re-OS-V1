/**
 * Sprint 9 — Marketing campaign audience resolver.
 *
 * Takes a marketing_campaigns row's audience criteria and returns the list
 * of contact_ids that match. Explicit audience_contact_ids takes precedence
 * over criteria-based resolution.
 *
 * Criteria available on marketing_campaigns:
 *   audience_personas         → contacts.contact_persona
 *   audience_generations      → derived from age_range (no DOB on contacts)
 *   audience_age_segs         → contacts.age_range
 *   audience_lead_source_tags → contacts.source_family
 *   audience_buyer_stages     → contacts.buyer_stage
 *
 * Tenant-isolated: only contacts in the campaign's brokerage_id are returned.
 * The DNC / TCPA gate is NOT applied here — that's done per-send in the
 * publisher. This resolver answers "who COULD receive this campaign" not
 * "who should ACTUALLY get sent to right now".
 */

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"

export interface AudienceCriteria {
  personas?:        string[]
  generations?:     string[]
  ageSegs?:         string[]
  leadSourceTags?:  string[]
  buyerStages?:     string[]
  /** When set, overrides criteria — exact contact list pinned by author. */
  contactIds?:      string[]
}

export interface ResolvedAudience {
  contactIds:     string[]
  resolvedAt:     string
  /** How many contacts in the brokerage were considered. */
  candidateCount: number
}

export async function resolveCampaignAudience(
  supabase:    SupabaseClient,
  brokerageId: string,
  criteria:    AudienceCriteria,
): Promise<ResolvedAudience> {
  // Explicit override wins
  if (criteria.contactIds && criteria.contactIds.length > 0) {
    const { data, error } = await supabase
      .from("contacts")
      .select("id")
      .in("id", criteria.contactIds)
      .eq("brokerage_id", brokerageId)
    if (error) {
      return { contactIds: [], resolvedAt: new Date().toISOString(), candidateCount: 0 }
    }
    const ids = ((data ?? []) as Array<{ id: string }>).map(r => r.id)
    return {
      contactIds:     ids,
      resolvedAt:     new Date().toISOString(),
      candidateCount: ids.length,
    }
  }

  // Build the OR-of-criteria — empty arrays match anything (no filter).
  let q = supabase
    .from("contacts")
    .select("id, contact_persona, age_range, source_family, buyer_stage")
    .eq("brokerage_id", brokerageId)
    .limit(5000)

  if (criteria.personas && criteria.personas.length > 0) {
    q = q.in("contact_persona", criteria.personas)
  }
  if (criteria.buyerStages && criteria.buyerStages.length > 0) {
    q = q.in("buyer_stage", criteria.buyerStages)
  }
  if (criteria.ageSegs && criteria.ageSegs.length > 0) {
    q = q.in("age_range", criteria.ageSegs)
  }
  if (criteria.leadSourceTags && criteria.leadSourceTags.length > 0) {
    q = q.in("source_family", criteria.leadSourceTags)
  }

  const { data, error } = await q
  if (error) {
    return { contactIds: [], resolvedAt: new Date().toISOString(), candidateCount: 0 }
  }

  let rows = (data ?? []) as Array<{ id: string; age_range: string | null }>

  // Generations require post-filter — contacts has age_range (e.g. '18-30'),
  // not date_of_birth, so map age_range → generational cohort.
  if (criteria.generations && criteria.generations.length > 0) {
    const wanted = new Set(criteria.generations)
    rows = rows.filter(r => wanted.has(ageRangeToCohort(r.age_range)))
  }

  const ids = rows.map(r => r.id)
  return {
    contactIds:     ids,
    resolvedAt:     new Date().toISOString(),
    candidateCount: ids.length,
  }
}

/**
 * Map contacts.age_range to a generational cohort label (loose mapping —
 * cohorts overlap age ranges, so we pick the dominant cohort for each band).
 *
 * Today (2026):
 *   gen_z       ≈ ages 14-29  → "18-30"
 *   millennial  ≈ ages 30-45  → "30-50" lower half
 *   gen_x       ≈ ages 46-61  → "30-50" upper half + "50-65" lower half
 *   boomer      ≈ ages 62-80  → "50-65" upper half + "65+"
 *   silent      ≈ ages 80+    → "65+"
 */
function ageRangeToCohort(ageRange: string | null | undefined): string {
  if (!ageRange) return "unknown"
  switch (ageRange) {
    case "18-30": return "gen_z"
    case "30-50": return "millennial"   // best single-mapping; gen_x lives partly here too
    case "50-65": return "gen_x"
    case "65+":   return "boomer"
    default:      return "unknown"
  }
}
