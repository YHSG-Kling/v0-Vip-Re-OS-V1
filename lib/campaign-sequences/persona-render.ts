// lib/campaign-sequences/persona-render.ts
//
// PERSONA + ENRICHMENT copy context — the antidote to hard-coded messages. Copy must be written
// to the actual person from what we enriched on their record, NOT a static template string. This
// builds the { persona, facts } context that feeds generatePersonaCopy, pulling from the RIGHT
// table (contacts vs leads — once a lead converts, the leads row is frozen and contacts is the
// system of record, so we read whichever table owns the live record).
//
// FAIR HOUSING is enforced BY CONSTRUCTION: enriched signals that are protected classes —
// familial status (new baby, marriage, divorce, children, household size), income, age, sex,
// religion, national origin, disability — may TIME an outreach upstream, but they are NEVER
// surfaced as copy facts here. Only property-relationship signals (ownership status, buyer stage,
// time since last contact) become facts, so the generated copy is personal AND lawsuit-safe.

import type { CopyPersona } from "@/lib/kernel/ai-copy"

export type PersonaEntity = "contact" | "lead"

/** The Fair-Housing-safe fields we read per table (everything else is intentionally excluded). */
export const CONTACT_PERSONA_COLUMNS = "first_name, last_name, contact_type, contact_persona, buyer_stage, home_owner_status, last_contacted_at"
export const LEAD_PERSONA_COLUMNS = "first_name, last_name, persona, lead_temperature, home_owner_status, last_contacted_at"

export interface PersonaContextRow {
  first_name?: string | null
  last_name?: string | null
  contact_type?: string | null
  contact_persona?: string | null
  persona?: string | null
  buyer_stage?: string | null
  lead_temperature?: string | null
  home_owner_status?: string | null
  last_contacted_at?: string | null
}

export interface PersonaContext {
  persona: CopyPersona
  /** The ONLY facts the copy may use — curated + Fair-Housing-safe. */
  facts: string[]
}

function monthsSince(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.round((now.getTime() - t) / (30 * 86_400_000)))
}

/**
 * Build the persona + safe facts for one record. PURE (no I/O) so the Fair-Housing curation is
 * unit-tested directly. `entity` decides which persona field is authoritative (contacts use
 * contact_persona/contact_type; leads use persona/lead_temperature).
 */
export function buildPersonaContext(row: PersonaContextRow, entity: PersonaEntity, now: Date = new Date()): PersonaContext {
  const name = [row.first_name, row.last_name].filter(Boolean).join(" ").trim() || null
  const audience = entity === "lead" ? "lead" : (row.contact_type ?? "audience")
  // Situation: the persona/stage hint that shapes tone — never a protected class.
  const situationBits: string[] = []
  if (entity === "contact") {
    if (row.buyer_stage) situationBits.push(String(row.buyer_stage).replace(/_/g, " "))
    if (row.contact_persona) situationBits.push(String(row.contact_persona).replace(/_/g, " "))
  } else {
    if (row.persona) situationBits.push(String(row.persona).replace(/_/g, " "))
  }
  const persona: CopyPersona = {
    name,
    audience,
    situation: situationBits.join(", ") || null,
  }

  // FACTS — property-relationship signals ONLY. (home_owner_status is a property/finance signal,
  // not a protected class; life_events / income / family size / age are deliberately omitted.)
  const facts: string[] = []
  const owner = (row.home_owner_status ?? "").toLowerCase()
  if (owner === "owner" || owner === "homeowner" || owner === "own") facts.push("currently owns their home")
  else if (owner === "renter" || owner === "rent") facts.push("currently renting")
  if (entity === "contact" && row.buyer_stage) facts.push(`buyer journey stage: ${String(row.buyer_stage).replace(/_/g, " ")}`)
  const m = monthsSince(row.last_contacted_at, now)
  if (m !== null && m >= 1) facts.push(`it has been about ${m} month${m === 1 ? "" : "s"} since we last connected`)

  return { persona, facts }
}
