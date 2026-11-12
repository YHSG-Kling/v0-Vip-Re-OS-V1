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

import type { CopyPersona, AudienceBrief } from "@/lib/kernel/ai-copy"

export type PersonaEntity = "contact" | "lead"

/** The Fair-Housing-safe fields we read per table (everything else is intentionally excluded).
 *  enrichment_profile (jsonb) carries the PeopleData payload — leads hold home ownership ONLY in
 *  there (no first-class column), so reading it completes the lineage raw→leads→contacts→copy. */
export const CONTACT_PERSONA_COLUMNS = "first_name, last_name, contact_type, contact_persona, buyer_stage, home_owner_status, enrichment_profile, last_contacted_at"
// Leads now carry first-class home_owner_status (m233); enrichment_profile remains the fallback.
export const LEAD_PERSONA_COLUMNS = "first_name, last_name, persona, lead_temperature, home_owner_status, enrichment_profile, last_contacted_at"

export interface PersonaContextRow {
  first_name?: string | null
  last_name?: string | null
  contact_type?: string | null
  contact_persona?: string | null
  persona?: string | null
  buyer_stage?: string | null
  lead_temperature?: string | null
  home_owner_status?: string | null
  /** PeopleData enrichment payload (jsonb). Source of truth for leads' home ownership. */
  enrichment_profile?: Record<string, any> | null
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
    // GUARANTEE a persona always resolves — never let a missing/blank persona fail a send. Falls
    // back to the entity kind ("contact"/"lead") so generatePersonaCopy always has an audience.
    audience: (audience && String(audience).trim()) || entity,
    situation: situationBits.join(", ") || null,
  }

  // FACTS — property-relationship signals ONLY. (home_owner_status is a property/finance signal,
  // not a protected class; life_events / income / family size / age are deliberately omitted.)
  // Lineage: prefer the first-class column (contacts), fall back to enrichment_profile (leads hold
  // ownership only in the jsonb), so a lead's copy is as grounded as a contact's.
  const facts: string[] = []
  const owner = (row.home_owner_status ?? row.enrichment_profile?.home_owner_status ?? "").toString().toLowerCase()
  if (owner === "owner" || owner === "homeowner" || owner === "own") facts.push("currently owns their home")
  else if (owner === "renter" || owner === "rent") facts.push("currently renting")
  if (entity === "contact" && row.buyer_stage) facts.push(`buyer journey stage: ${String(row.buyer_stage).replace(/_/g, " ")}`)
  const m = monthsSince(row.last_contacted_at, now)
  if (m !== null && m >= 1) facts.push(`it has been about ${m} month${m === 1 ? "" : "s"} since we last connected`)

  return { persona, facts }
}

// ─── THE AUDIENCE BRIEF (wave 151, lane 151I — "gear it to them first") ─────────────────────────
//
// The person's side of the writing brief, compiled from APPROPRIATELY SOURCED evidence only: the FH-safe persona + facts
// above (by construction — protected-class attributes never become copy facts, whatever the persona label), the stated
// preferences the ONE memory ledger holds (contacts.metadata.context_spine.facts — written from the person's OWN words,
// lib/kernel/conversation-memory.ts; current, unexpired facts only), the spine's stated criteria, and the contact's own
// preference columns. `leadWith` is what THEY said matters — a homeowner who said "less maintenance" gets genuinely useful
// alternatives first, never a seller solicitation. No persona is refused; nothing is deleted; a refused read is NAMED.
// Consumed by the copy engine through CopyRequest.audience (lib/kernel/ai-copy.ts) — the type lives there.

/** The contact columns the audience brief reads — the FH-safe persona set plus the person's own preference columns and the memory spine. */
const AUDIENCE_BRIEF_COLUMNS = `${CONTACT_PERSONA_COLUMNS}, id, preferred_channel, preferred_contact_time, preferred_language, accessibility_preferences, metadata`

type AudienceDb = { from: (table: string) => any }

/** Memory keys that say what the person WANTS or what stands in their way — the them-first opener. */
const LEAD_WITH_KEYS = new Set(["motivation", "barrier", "scenario_choice", "timeline", "price_expectation"])
/** A memory fact whose source names an enrichment / inference is not the person's statement. */
const NOT_THEIR_WORDS = /enrich|infer|model|predict|score/i

function accessibilityList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
  if (v && typeof v === "object") return Object.entries(v as Record<string, unknown>).filter(([, on]) => on === true || (typeof on === "string" && on.trim())).map(([k, on]) => (typeof on === "string" ? `${k}: ${on}` : k))
  return []
}

/**
 * Load the audience brief for one contact, through the client the caller holds, tenant-pinned (a foreign contact reads as
 * nothing). Never throws: a refused read is NAMED in readErrors and the brief says what it could not see. A null contactId
 * (a broadcast, a lead) is an honest empty brief — never a leads read, never a guess.
 */
export async function loadAudienceBrief(
  db: AudienceDb,
  input: { brokerageId: string; contactId: string | null | undefined; now?: Date },
): Promise<AudienceBrief> {
  const now = input.now ?? new Date()
  const readErrors: string[] = []
  const empty = (): AudienceBrief => ({
    schema: 1, contactId: input.contactId ?? null, name: null, personaLabel: null, audience: null, situation: null, leadWith: [], stated: [],
    preferences: { channel: null, time: null, language: null, format: null, frequency: null, explanationStyle: null, accessibility: [] },
    facts: [], evidenceClass: "none", sources: [], readErrors,
  })
  if (!input.contactId || !input.brokerageId) return empty()
  const { data, error } = await db.from("contacts").select(AUDIENCE_BRIEF_COLUMNS).eq("id", input.contactId).eq("brokerage_id", input.brokerageId).maybeSingle()
  if (error) { readErrors.push(`contacts read refused: ${error.message ?? "unknown"}`); return empty() }
  if (!data) { readErrors.push("no such contact in this tenant"); return empty() }
  const row = data as PersonaContextRow & {
    preferred_channel?: string | null; preferred_contact_time?: string | null; preferred_language?: string | null
    accessibility_preferences?: unknown; metadata?: Record<string, unknown> | null
  }
  const sources: string[] = ["contacts (persona + FH-safe facts)"]
  const ctx = buildPersonaContext(row, "contact", now)

  // The memory ledger — the person's own words, current and unexpired (the ONE reader decides what is current).
  const stated: AudienceBrief["stated"] = []
  const leadWith: string[] = []
  const spine = (row.metadata ?? {}).context_spine as { preferences?: unknown; facts?: unknown } | undefined
  if (spine && typeof spine === "object") {
    try {
      const { currentMemoryFacts } = await import("@/lib/kernel/conversation-memory")
      for (const f of currentMemoryFacts(spine, now)) {
        if (NOT_THEIR_WORDS.test(f.source)) continue
        stated.push({ key: f.key, value: f.value, source: f.source, observedAt: f.observedAt })
        if (LEAD_WITH_KEYS.has(f.key)) leadWith.push(`${f.key.replace(/_/g, " ")}: ${f.value}`)
      }
      if (stated.length) sources.push("contacts.metadata.context_spine.facts (the person's own words, current)")
    } catch (e) {
      readErrors.push(`memory ledger unreadable: ${(e as Error)?.message ?? String(e)}`)
    }
    const prefs = Array.isArray(spine.preferences) ? spine.preferences.filter((p): p is string => typeof p === "string" && p.trim().length > 0) : []
    if (prefs.length) { leadWith.push(...prefs.slice(0, 3)); sources.push("contacts.metadata.context_spine.preferences (stated criteria)") }
  }
  const byKey = (k: string) => stated.find((s) => s.key === k)?.value ?? null
  const preferences: AudienceBrief["preferences"] = {
    channel: byKey("channel_preference") ?? row.preferred_channel ?? null,
    time: byKey("preferred_contact_time") ?? row.preferred_contact_time ?? null,
    language: byKey("language") ?? row.preferred_language ?? null,
    format: byKey("communication_format"),
    frequency: byKey("contact_frequency"),
    explanationStyle: byKey("explanation_style"),
    accessibility: accessibilityList(row.accessibility_preferences),
  }
  if (row.preferred_channel || row.preferred_contact_time || row.preferred_language) sources.push("contacts.preferred_channel/preferred_contact_time/preferred_language")
  if (preferences.accessibility.length) sources.push("contacts.accessibility_preferences")

  return {
    schema: 1,
    contactId: input.contactId,
    name: ctx.persona.name ?? null,
    personaLabel: row.contact_persona ?? null,
    audience: ctx.persona.audience ?? null,
    situation: ctx.persona.situation ?? null,
    leadWith: [...new Set(leadWith)].slice(0, 5),
    stated,
    preferences,
    facts: ctx.facts,
    evidenceClass: stated.length || leadWith.length ? "expressed_interest" : row.contact_persona ? "persona_only" : "none",
    sources,
    readErrors,
  }
}
