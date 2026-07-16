// lib/contacts/persona-builder.ts
// ─────────────────────────────────────────────────────────────────────────────
// PERSONA-AT-ENRICHMENT (burn-down round 5, approved item 3). Three live
// surfaces read client_detailed_personas (lead-scoring persona join, open-house
// personalized follow-up, persona-aware content generation) but NOTHING wrote
// it — every read came back empty. This builds the persona the moment
// enrichment lands, from REAL enriched signals only:
//   demographics    ← the enrichment profile's verified fields (age/marital/
//                     income/household/home-owner status)
//   psychographics  ← occupation/industry/education (who they are at work)
//   buying_triggers ← detected life events + owner status (what would move them)
//   pain_points     ← honest heuristics keyed to their situation
//   ai_summary      ← one short routed-AI paragraph grounded ONLY in the facts
//                     above (falls back to a deterministic compose — the row
//                     never blocks on the model)
// No unique index on contact_id (live-verified) → check-then-update, one
// persona per contact kept current. agent_id is AGENTS-class (live FK).

import "server-only"

type Svc = { from: (table: string) => any }

export interface PersonaFacts {
  ageRange?: string | null
  maritalStatus?: string | null
  childrenCount?: number | null
  householdSize?: number | null
  householdIncome?: string | null
  homeOwnerStatus?: string | null
  homeValue?: number | string | null
  occupation?: string | null
  industry?: string | null
  education?: string | null
  lifeEvents?: string[] | null
  contactType?: string | null
}

/** Deterministic persona name from the strongest real signals. */
export function derivePersonaName(f: PersonaFacts): string {
  const lifecycle =
    f.homeOwnerStatus?.toLowerCase().includes("own") ? "Homeowner"
    : f.homeOwnerStatus?.toLowerCase().includes("rent") ? "First-Time Buyer"
    : "Prospective Mover"
  const family =
    (f.childrenCount ?? 0) > 0 || (f.householdSize ?? 0) > 2 ? "Family"
    : f.maritalStatus?.toLowerCase().includes("married") ? "Couple"
    : "Individual"
  return `${family} ${lifecycle}`
}

export function derivePersonaType(f: PersonaFacts): string {
  const t = (f.contactType ?? "").toLowerCase()
  if (["seller", "investor", "buyer"].includes(t)) return t
  if (t === "both") return "buyer_seller"
  return f.homeOwnerStatus?.toLowerCase().includes("own") ? "potential_seller" : "buyer"
}

export function deriveBuyingTriggers(f: PersonaFacts): string[] {
  const triggers: string[] = []
  for (const ev of f.lifeEvents ?? []) triggers.push(`life_event:${String(ev).toLowerCase().replace(/\s+/g, "_")}`)
  if ((f.childrenCount ?? 0) > 0) triggers.push("growing_household_space_needs")
  if (f.homeOwnerStatus?.toLowerCase().includes("rent")) triggers.push("rent_to_own_equity_motivation")
  if (f.homeOwnerStatus?.toLowerCase().includes("own")) triggers.push("equity_unlock_or_upsize")
  return triggers
}

export function derivePainPoints(f: PersonaFacts): string[] {
  const pains: string[] = []
  if (f.homeOwnerStatus?.toLowerCase().includes("rent")) pains.push("down_payment_uncertainty", "qualification_anxiety")
  if (f.homeOwnerStatus?.toLowerCase().includes("own")) pains.push("sell_before_buy_timing", "current_rate_lock_in")
  if ((f.childrenCount ?? 0) > 0) pains.push("school_district_constraints")
  if (pains.length === 0) pains.push("market_timing_uncertainty")
  return pains
}

/** Deterministic summary — the honest floor the AI paragraph improves on. */
export function composeFallbackSummary(f: PersonaFacts): string {
  const bits: string[] = []
  if (f.ageRange) bits.push(`${f.ageRange}`)
  if (f.maritalStatus) bits.push(f.maritalStatus)
  if (f.occupation) bits.push(f.occupation)
  if (f.homeOwnerStatus) bits.push(f.homeOwnerStatus)
  const facts = bits.length ? bits.join(", ") : "limited verified data so far"
  return `${derivePersonaName(f)} (${facts}). Triggers: ${deriveBuyingTriggers(f).join(", ") || "none detected yet"}.`
}

/** Build (or refresh) the contact's persona row from enriched facts. */
export async function buildContactPersona(
  svc: Svc,
  params: {
    contactId: string
    brokerageId: string
    agentId: string | null // agents.id (live FK) — resolved by the caller
    facts: PersonaFacts
    /** Injectable for tests; production passes generateTextRouted-backed fn. */
    summarize?: (prompt: string) => Promise<string>
  },
): Promise<{ written: boolean; personaName: string }> {
  const { facts } = params
  const personaName = derivePersonaName(facts)
  const demographics = {
    age_range: facts.ageRange ?? null,
    marital_status: facts.maritalStatus ?? null,
    children_count: facts.childrenCount ?? null,
    household_size: facts.householdSize ?? null,
    household_income: facts.householdIncome ?? null,
    home_owner_status: facts.homeOwnerStatus ?? null,
    home_value: facts.homeValue ?? null,
  }
  const psychographics = {
    occupation: facts.occupation ?? null,
    industry: facts.industry ?? null,
    education: facts.education ?? null,
  }
  const buyingTriggers = deriveBuyingTriggers(facts)
  const painPoints = derivePainPoints(facts)

  let aiSummary = composeFallbackSummary(facts)
  if (params.summarize) {
    try {
      const text = await params.summarize(
        `Write 2 sentences profiling this real-estate contact for their agent, grounded ONLY in these verified facts (no invention): ` +
        `${JSON.stringify({ demographics, psychographics, life_events: facts.lifeEvents ?? [], triggers: buyingTriggers })}. ` +
        `Plain, useful, no hype.`,
      )
      if (text?.trim()) aiSummary = text.trim().slice(0, 900)
    } catch { /* deterministic fallback already set */ }
  }

  const row = {
    contact_id: params.contactId,
    brokerage_id: params.brokerageId,
    agent_id: params.agentId,
    persona_name: personaName,
    persona_type: derivePersonaType(facts),
    demographics,
    psychographics,
    buying_triggers: buyingTriggers,
    pain_points: painPoints,
    ai_summary: aiSummary,
    updated_at: new Date().toISOString(),
  }

  // No unique on contact_id — one persona per contact via check-then-update.
  const { data: existing } = await svc.from("client_detailed_personas")
    .select("id").eq("contact_id", params.contactId).maybeSingle()
  if (existing) {
    const { error } = await svc.from("client_detailed_personas").update(row).eq("id", (existing as any).id)
    return { written: !error, personaName }
  }
  const { error } = await svc.from("client_detailed_personas").insert(row)
  return { written: !error, personaName }
}
