// lib/contacts/persona-builder.ts
// ─────────────────────────────────────────────────────────────────────────────
// PERSONA-AT-ENRICHMENT (burn-down round 5, approved item 3) — the SURVIVOR writer of client_detailed_personas. Three live
// surfaces read that table (lead-scoring persona join, open-house personalized follow-up, persona-aware content generation).
//
// WAVE 148 (lane 148C — owner ruling 1, 2026-11-01: "the read of protected or prohibited can be used to determine the person's
// persona so users can create ads and posts, etc. around that persona"). EXTENDED, not twinned (LAW 1): this file now owns
// `derivePersona` — the AI studies the permitted records and builds a CUSTOMER-SERVICE profile and a NEEDS-BASED, MARKETING-SAFE
// persona, keeping the five layers separate (lib/contacts/persona-layers.ts holds the model, the prompt and the firewall):
//   1 research attributes  — read through the purpose-gated reader (purpose persona_derivation, ledgered); shape SERVICE only;
//                            persisted as NAMES + classes, never values.
//   2 stated needs · 3 behavioural evidence · 4 inferred interests — from customer360For (lib/enrichment/customer-360.ts) and the
//                            buyer-criteria store (lib/buyer-search/buyer-criteria.ts loadBuyerCriteria); nothing re-derived that
//                            PeopleData / the canonical record already hold.
//   5 marketing persona    — built from 2–4 only, firewalled, then (when confident and needs-based) written to
//                            contacts.contact_persona so the EXISTING persona_segment audiences (lib/kernel/ads.ts syncAudience)
//                            select the person — never over a staff-entered persona, never a protected-characteristic persona.
//
// WHAT THE ENRICHMENT-TIME BUILD USED TO DO, AND WHY IT STOPPED (orphan doctrine — the facts moved to their survivors):
//   · it COPIED age / marital status / children / household income / occupation / education into client_detailed_personas.demographics
//     and .psychographics — a second copy of Layer-1 data in a row read by outbound copy. SURVIVORS: the contact's own columns with
//     their provenance stamp (lib/lead-pipeline/enrichment-column-map.ts stampFieldProvenance) and the segregated research store
//     (lib/enrichment/protected-research-store.ts readProtectedAttributes). The columns are written `{}` from now on.
//   · it named the persona "Family Homeowner" / "Couple …" from children and marital status, and pushed the pain point
//     "school_district_constraints" and the trigger "growing_household_space_needs" from childrenCount — familial-status and
//     marital-status PROXIES that reached outbound copy (app/actions/open-house-automation.ts puts pain points in the invitation
//     prompt; lib/services/content-generation.service.ts puts persona_name in the content prompt). No survivor: the capability
//     itself is what ruling 1 forbids. The legacy columns are now written from the marketing-safe layer only.
//   · the life-event triggers (`life_event:<kind>`) left the persona row: a life event is never named or marketed to (ruling 17).

import "server-only"
import {
  AUDIENCE_MIN_CONFIDENCE, PERSONA_LAYERS, PERSONA_PROMPT_VERSION, assertMarketingSafePersona, buildPersonaDerivationPrompt,
  derivePersonaDeterministic, validatePersonaDerivation,
  type MarketingNeed, type PersonaDerivation, type ResearchAttribute,
} from "@/lib/contacts/persona-layers"
import { normalizeContactPersona } from "@/lib/campaigns/contact-sources"

type Svc = { from: (table: string) => any }

/** The m913 column the prior-row read needs — named once and degraded BY NAME when absent (the buyer-criteria idiom: a
 *  written-not-applied column is read beside a fallback, never assumed). Listed for the schema-snapshot regeneration. */
const M913_PRIOR_SELECT = "id, derivation"

export interface PersonaFacts {
  ageRange?: string | null
  maritalStatus?: string | null
  childrenCount?: number | null
  householdSize?: number | null
  householdIncome?: string | null
  homeOwnerStatus?: string | null
  homeValue?: number | string | null
  // m640: the estimated net worth range — a financial-capacity signal for the
  // investor-intent read. Wave 148 (148C): it stays a RESEARCH-LAYER signal (it may inform investor-box matching on the data lane);
  // it never becomes a marketing need, a persona label or an audience (income / net worth are wealth proxies in the owner's
  // protected vocabulary).
  // TOMBSTONE (wave 86, lane 86A): the modeled credit band is DELETED from the persona facts. A
  // persona's pain_points are read INTO OUTBOUND COPY (app/actions/open-house-automation.ts,
  // "Pain Points:" in the invitation prompt), so a MODELED credit band here was a credit band
  // steering outbound messaging — FCRA / fair lending (owner, wave 86: keep the credit band out
  // of outbound copy, eligibility, pricing and steering). The band's one reader is the agent's
  // contact card, labelled "modeled estimate" (app/actions/contact-enrichment.ts::
  // getContactInsights → enrichment-panel.tsx). Guarded by scripts/enrichment-one-rail-guard.ts
  // Layer 8d (the modeled-credit firewall).
  netWorth?: string | null
  occupation?: string | null
  industry?: string | null
  education?: string | null
  lifeEvents?: string[] | null
  contactType?: string | null
}

function derivePersonaType(contactType: string | null | undefined, homeOwnerStatus: string | null | undefined): string {
  const t = (contactType ?? "").toLowerCase()
  if (["seller", "investor", "buyer"].includes(t)) return t
  if (t === "both") return "buyer_seller"
  return homeOwnerStatus?.toLowerCase().includes("own") ? "potential_seller" : "buyer"
}

// PeopleData's ranges are free-text ("$500K-$1M", "$1M+", "650-700", "<600") — this
// pulls the first number out (in thousands for net worth, so "$1M" -> 1000) rather
// than assuming one exact format, since the provider is not contractually bound to one.
function firstNumber(range: string | null | undefined): number | null {
  if (!range) return null
  const m = range.match(/([\d,.]+)\s*(K|M)?/i)
  if (!m) return null
  const n = Number(m[1].replace(/,/g, ""))
  if (!Number.isFinite(n)) return null
  const unit = m[2]?.toUpperCase()
  return unit === "M" ? n * 1000 : n
}

/** True when the range's low end reads as $500K+ net worth (investor/cash-buyer capacity). */
function isHighNetWorthRange(range: string | null | undefined): boolean {
  const n = firstNumber(range)
  return n !== null && n >= 500
}

// TOMBSTONE (wave 86, lane 86A): the sub-650 credit-range predicate is DELETED with the credit-band
// persona fact above — it turned a MODELED credit band into a "credit qualification risk" pain point,
// which the open-house invitation prompt then wrote outbound copy from. No survivor: the capability
// itself is what the FCRA / fair-lending ruling forbids (the band stays display-only on the card).

/** Needs-based pain points — what outbound copy (the open-house invitation) may lean on. Keyed by the ONE needs vocabulary. */
const PAINS_FOR_NEED: Readonly<Record<MarketingNeed, readonly string[]>> = {
  relocation_research: ["unfamiliar_market", "remote_decision_making"], first_home_guidance: ["down_payment_uncertainty", "process_unfamiliarity"],
  investor_interest: ["cash_flow_uncertainty"], downsizing: ["sell_before_buy_timing", "upkeep_burden"], more_space: ["space_constraints", "sell_before_buy_timing"],
  luxury_property: ["limited_comparable_inventory"], selling_on_own: ["pricing_uncertainty", "paperwork_complexity"], relisting_after_expired: ["stalled_listing"],
  distressed_property_options: ["time_pressure"], home_value_curiosity: ["value_uncertainty"], equity_planning: ["current_rate_lock_in"],
  expressed_criteria: ["inventory_match"], acreage_and_land: ["usable_land_uncertainty"], new_construction: ["builder_contract_complexity"],
}

export interface DerivePersonaInput {
  brokerageId: string
  contactId: string
  /** The SESSION-verified actor (or the autonomous system caller) — handed to the reader, which re-checks role, tenant and scope. */
  actor: { userId: string | null; userType: string | null; platformRole?: string | null; brokerageId?: string | null; systemSource?: string | null }
  agentId?: string | null
  hints?: { homeOwnerStatus?: string | null; contactType?: string | null }
  /** Research-layer signals computed by the caller from Layer-1 facts (e.g. investment capacity) — stored with Layer 1, never marketing. */
  researchSignals?: string[]
}

export interface DerivePersonaResult {
  ok: boolean
  written: boolean
  marketingSafe: boolean
  persona: PersonaDerivation | null
  research: { read: boolean; refused: string | null; fieldsConsidered: number; withheld: number }
  contactPersonaWritten: string | null
  notes: string[]
  error?: string
}

/** The default model call — the routed text model, booked through generateTextRouted's own usage path (ai_tool_usage). */
async function defaultGenerate(brokerageId: string, system: string, prompt: string): Promise<string> {
  const { generateTextRouted } = await import("@/lib/ai/models")
  const { text } = await generateTextRouted({ feature: "enrichment_persona_summary", brokerageId, system, prompt, temperature: 0.4, maxTokens: 1400 })
  return text
}

function parseJsonObject(text: string): unknown {
  const s = String(text ?? "")
  const a = s.indexOf("{"), b = s.lastIndexOf("}")
  if (a < 0 || b <= a) return null
  try { return JSON.parse(s.slice(a, b + 1)) } catch { return null }
}

/**
 * Study one contact's permitted records and build the five-layer persona. Never throws. Ledgered as `contact.persona.derive`
 * (the research read inside it is ledgered separately by the reader). The tenant is the caller's verified one.
 */
export async function derivePersona(
  svc: Svc,
  input: DerivePersonaInput,
  opts: { generate?: (system: string, prompt: string) => Promise<string>; now?: Date; ledgerClient?: Svc } = {},
): Promise<DerivePersonaResult> {
  const empty: DerivePersonaResult = { ok: false, written: false, marketingSafe: false, persona: null, research: { read: false, refused: null, fieldsConsidered: 0, withheld: 0 }, contactPersonaWritten: null, notes: [] }
  if (!input.brokerageId || !input.contactId) return { ...empty, error: "brokerageId and contactId are both required" }
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const run = async (): Promise<DerivePersonaResult> => {
    const notes: string[] = []
    try {
      // ── layers 2–4: the canonical reads (Customer 360 + the buyer's own criteria) ──
      const { customer360For } = await import("@/lib/enrichment/customer-360")
      const c360 = await customer360For(svc, input.brokerageId, { type: "contact", id: input.contactId }, { now: opts.now })
      if (!c360.ok) return { ...empty, error: `customer 360 refused: ${c360.reason}` }
      const view = c360.view
      for (const w of view.warnings) notes.push(`c360: ${w}`)
      const { loadBuyerCriteria } = await import("@/lib/buyer-search/buyer-criteria")
      const criteria = await loadBuyerCriteria(svc as never, input.contactId, { brokerageId: input.brokerageId }).catch(() => null)

      // ── layer 1: the purpose-gated research read (persona_derivation) — a refusal is SAID and the persona still derives from 2–4 ──
      const { readProtectedAttributes } = await import("@/lib/enrichment/protected-research-store")
      const read = await readProtectedAttributes(svc, { brokerageId: input.brokerageId, contactId: input.contactId, purpose: "persona_derivation", actor: input.actor }, { now: opts.now, ledgerClient: opts.ledgerClient })
      const research: ResearchAttribute[] = read.ok
        ? read.attributes.map((a, i) => ({ id: `R1-${i + 1}`, field: a.field, protectedClass: a.protectedClass, basis: a.basis, dataRights: a.dataRights, value: a.value }))
        : []
      if (!read.ok) notes.push(`research layer not read (${read.refused}): ${read.reason}`)

      // ── prior row: our own last contact_persona write is never read back as evidence ──
      const prior = await svc.from("client_detailed_personas").select(`${M913_PRIOR_SELECT}`).eq("contact_id", input.contactId).eq("brokerage_id", input.brokerageId).maybeSingle()
      const priorRow = prior.error ? null : (prior.data as { id?: string; derivation?: Record<string, any> | null } | null)
      if (prior.error) notes.push(`prior persona unread (${prior.error.message}) — m913 not applied? the derivation record is written on the legacy columns only`)
      const ownPriorPersona = (priorRow?.derivation?.wrote_contact_persona as string | undefined) ?? null

      const sources = { view, criteria, research, ownPriorPersona, hints: input.hints }
      const floor = derivePersonaDeterministic(sources)
      let persona: PersonaDerivation = floor
      // ── the expert study (the model) — validated element by element; any failure keeps the deterministic floor ──
      try {
        const brokerage = await svc.from("brokerages").select("name").eq("id", input.brokerageId).maybeSingle()
        const first = (view.fields["identity.preferred_name"]?.value ?? view.fields["identity.first_name"]?.value ?? null) as string | null
        const { system, prompt } = buildPersonaDerivationPrompt({
          brokerageName: (brokerage.data as { name?: string } | null)?.name ?? null, agentName: null, firstName: first,
          evidence: floor.evidence, research, service: floor.service.communication,
        })
        const text = await (opts.generate ? opts.generate(system, prompt) : defaultGenerate(input.brokerageId, system, prompt))
        const raw = parseJsonObject(text)
        if (raw) persona = validatePersonaDerivation(raw, { evidence: floor.evidence, research, fallback: floor })
        else notes.push("the model returned no JSON object — the deterministic persona stands")
      } catch (e) {
        notes.push(`model unavailable (${e instanceof Error ? e.message : String(e)}) — the deterministic persona stands`)
      }

      // ── the last independent check: a persona that fails it never persists its marketing layer ──
      const researchValues = research.map((r) => (typeof r.value === "string" || typeof r.value === "number" ? String(r.value) : "")).filter(Boolean)
      let safe = assertMarketingSafePersona(persona.marketing, researchValues)
      if (!safe.ok) {
        notes.push(`marketing persona refused at the final check (${safe.violations.join("; ")}) — the deterministic floor replaces it`)
        persona = { ...persona, marketing: floor.marketing, firewall: { ...persona.firewall, refused: [...persona.firewall.refused, ...safe.violations.map((v) => ({ path: "final_check", reason: v }))] } }
        safe = assertMarketingSafePersona(persona.marketing, researchValues)
      }

      // ── persist the five layers (values of Layer 1 never leave memory) ──
      const now = (opts.now ?? new Date()).toISOString()
      const pains = persona.marketing.needs.flatMap((n) => PAINS_FOR_NEED[n.need]).filter((p, i, a) => a.indexOf(p) === i)
      const legacy = {
        // agents-class (live FK): the caller's, else the contact's own owner — never blanked by a card-triggered study.
        contact_id: input.contactId, brokerage_id: input.brokerageId, agent_id: input.agentId ?? view.ownership?.agentId ?? null,
        persona_name: persona.marketing.headline, persona_type: derivePersonaType(input.hints?.contactType ?? (view.fields["lifecycle.contact_type"]?.value as string | null) ?? null, input.hints?.homeOwnerStatus ?? (view.fields["property.home_owner_status"]?.value as string | null) ?? null),
        demographics: {}, psychographics: {},
        buying_triggers: persona.marketing.needs.map((n) => n.need),
        pain_points: pains.length ? pains : ["market_timing_uncertainty"],
        ai_summary: persona.service.summary,
        updated_at: now,
      }
      const layered = {
        ...legacy,
        stated_needs: floor.evidence.stated, behavioural_evidence: floor.evidence.behaviour, inferred_interests: floor.evidence.inferred,
        research_layer: {
          fields: research.map((r) => ({ id: r.id, field: r.field, protected_class: r.protectedClass, basis: r.basis, data_rights: r.dataRights })),
          read: { ok: read.ok, purpose: "persona_derivation", refused: read.ok ? null : read.refused, evidenced: read.evidenced, withheld: read.ok ? read.withheld.length : 0 },
          signals: input.researchSignals ?? [],
          influence: "service_profile_only",
        },
        marketing_persona: safe.ok ? persona.marketing : null,
        marketing_safe: safe.ok,
        service_profile: persona.service,
        derivation: {
          prompt_version: PERSONA_PROMPT_VERSION, layers: PERSONA_LAYERS, source: persona.source, derived_at: now,
          actor: { user_id: input.actor.userId, user_type: input.actor.userType, platform_role: input.actor.platformRole ?? null, system_source: input.actor.systemSource ?? null },
          firewall: persona.firewall, escalate: persona.escalate, wrote_contact_persona: ownPriorPersona,
        },
        derived_at: now,
      }

      // ── layer 5 → the existing audience path: contacts.contact_persona (needs-based, confident, never over a staff value) ──
      let contactPersonaWritten: string | null = null
      const cp = persona.marketing.campaignPersona
      if (safe.ok && cp && persona.marketing.audienceEligible) {
        const current = (view.fields["lifecycle.contact_persona"]?.value as string | null | undefined) ?? null
        const canon = normalizeContactPersona(current)
        const ours = current !== null && current === ownPriorPersona
        if (current === cp) contactPersonaWritten = cp
        else if (canon === null || canon === "other" || ours) {
          let q = svc.from("contacts").update({ contact_persona: cp }).eq("id", input.contactId).eq("brokerage_id", input.brokerageId)
          q = current === null ? q.is("contact_persona", null) : q.eq("contact_persona", current)
          const { data: upd, error: updErr } = await q.select("id")
          if (updErr) notes.push(`contact_persona not written: ${updErr.message}`)
          else if ((upd ?? []).length !== 1) notes.push(`contact_persona not written: the row changed underneath (${(upd ?? []).length} matched)`)
          else contactPersonaWritten = cp
        } else notes.push(`contact_persona "${current}" was set by a person — the derived "${cp}" never overwrites it`)
        if (contactPersonaWritten) (layered.derivation as Record<string, unknown>).wrote_contact_persona = contactPersonaWritten
      } else if (cp && !persona.marketing.audienceEligible) {
        notes.push(`derived persona "${cp}" is below the audience confidence floor (${AUDIENCE_MIN_CONFIDENCE}) — not written to contacts.contact_persona`)
      }

      const written = await writePersonaRow(svc, priorRow?.id ?? null, layered, legacy, notes, input)
      return {
        ok: true, written, marketingSafe: safe.ok, persona, contactPersonaWritten, notes,
        research: { read: read.ok, refused: read.ok ? null : read.refused, fieldsConsidered: research.length, withheld: read.ok ? read.withheld.length : 0 },
      }
    } catch (e) {
      return { ...empty, notes, error: `threw: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
  return withActionLedger<DerivePersonaResult>(
    {
      brokerageId: input.brokerageId,
      action: "contact.persona.derive",
      actor: { type: input.actor.userId ? "user" : "system", userId: input.actor.userId },
      subject: { type: "contact", id: input.contactId },
      reasonCode: input.actor.userId ? "HUMAN_REQUESTED" : "UNSPECIFIED",
      reasonDetail: input.actor.userId ? "persona study requested from the contact card" : `autonomous persona study (${input.actor.systemSource ?? "system"})`,
      riskClass: "LOW_RISK_WRITE",
      systemSource: input.actor.systemSource ?? "persona_builder",
      detail: { prompt_version: PERSONA_PROMPT_VERSION },
    },
    run,
    {
      settle: (r) => r.ok
        ? { status: "executed", outcome: `persona:${r.persona?.marketing.primaryNeed ?? "none"} safe:${r.marketingSafe} contact_persona:${r.contactPersonaWritten ?? "unchanged"}`, provider: r.persona?.source ?? null }
        : { status: "failed", outcome: "persona_not_derived", error: r.error ?? null },
      replay: (claim) => ({ ...empty, error: claim.kind === "refused" ? `the action ledger refused this derivation (${claim.error}) — nothing was derived (fail closed)` : "a derivation for this contact is already recorded / in flight" }),
    },
    { client: opts.ledgerClient ?? svc },
  )
}

/** Check-then-write, tenant-pinned, COUNTED. Falls back to the legacy columns only when m913's columns are absent (PGRST204). */
async function writePersonaRow(svc: Svc, existingId: string | null, layered: Record<string, unknown>, legacy: Record<string, unknown>, notes: string[], input: DerivePersonaInput): Promise<boolean> {
  let id = existingId
  if (!id) {
    const { data: found, error: fErr } = await svc.from("client_detailed_personas").select("id").eq("contact_id", input.contactId).eq("brokerage_id", input.brokerageId).maybeSingle()
    if (fErr) { notes.push(`persona row lookup refused: ${fErr.message}`); return false }
    id = (found as { id?: string } | null)?.id ?? null
  }
  const attempt = async (row: Record<string, unknown>) => id
    ? svc.from("client_detailed_personas").update(row).eq("id", id).eq("brokerage_id", input.brokerageId).select("id")
    : svc.from("client_detailed_personas").insert(row).select("id")
  let { data, error } = await attempt(layered)
  if (error && /PGRST204|42703|column/i.test(`${error.code ?? ""} ${error.message ?? ""}`)) {
    notes.push(`m913 five-layer columns absent (${error.message}) — wrote the legacy columns only; the layers are NOT stored until m913 is applied`)
    ;({ data, error } = await attempt(legacy))
  }
  if (error) { notes.push(`persona row write refused: ${error.message}`); return false }
  if ((data ?? []).length !== 1) { notes.push(`persona row write matched ${(data ?? []).length} rows`); return false }
  return true
}

/**
 * Build (or refresh) the contact's persona row at enrichment time — the enrichment orchestrator's existing call. Now the
 * AUTONOMOUS persona study (system actor, purpose persona_derivation). `facts` keeps its shape for the caller; the protected facts
 * in it are NOT copied anywhere — Layer 1 is read through the reader with its provenance. `summarize` is accepted and unused (the
 * study's model call needs a larger output budget than the caller's 180-token summary — Outside-lane note in the lane notes).
 */
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
  const f = params.facts
  const res = await derivePersona(svc, {
    brokerageId: params.brokerageId, contactId: params.contactId, agentId: params.agentId,
    actor: { userId: null, userType: null, platformRole: null, brokerageId: params.brokerageId, systemSource: "enrichment_pipeline" },
    hints: { homeOwnerStatus: f.homeOwnerStatus ?? null, contactType: f.contactType ?? null },
    researchSignals: isHighNetWorthRange(f.netWorth) ? ["investment_capacity_signal"] : [],
  })
  return { written: res.written, personaName: res.persona?.marketing.headline ?? "Needs not yet known" }
}
