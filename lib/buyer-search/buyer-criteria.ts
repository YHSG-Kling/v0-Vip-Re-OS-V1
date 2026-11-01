/**
 * lib/buyer-search/buyer-criteria.ts
 *
 * Wave 65 — THE single normalized reader of a buyer's saved criteria. Before this, the
 * matcher, the market watch, and the showing brief each read property_preferences with
 * their OWN column lists (drift: each could miss/typo a column — the matcher already had
 * the `preferred_bedrooms`/`price` bug). This is the one place the criteria columns are
 * read + normalized (explicit `preferred_*` wins over AI `inferred_*`), so every consumer
 * agrees and a schema change is a one-line edit.
 *
 * Wave 147 (lane 147C, contract C10) — THE ONE STORE, NOW WRITABLE AND HONEST ABOUT WHO
 * SAID WHAT. The buyer's criteria persist across the portal, mobile, email, SMS, voice and
 * the AI conversation in exactly one place — property_preferences, read here — and every
 * field now carries its PROVENANCE:
 *
 *   said     — the buyer's own words (a typed or spoken turn, a correction, feedback text);
 *              the evidence quote rides with it.
 *   inferred — derived from behaviour (saved / dismissed homes) or a legacy row whose
 *              origin was never recorded. A legacy value is NEVER promoted to "said".
 *   default  — a value the system fills by rule when nothing was said (listing type
 *              "sale").
 *
 * WHY SAID VALUES LIVE IN criteria_provenance AS WELL AS THE COLUMNS. The behaviour learner
 * (lib/behavior-learning/preference-updater.ts) recomputes preferred_price_* and every
 * inferred_* column from saved/dismissed homes and overwrites them. A buyer who SAID
 * "under $600k" would have that number silently replaced by a learned ±15% band. The
 * reader therefore lets a `said` provenance entry's own value win over the column it
 * shadows, and reports the disagreement (`saidOverridesColumn`) instead of hiding it.
 * (The learner itself is outside this lane; the change it needs is recorded in the lane
 * 147C notes under Outside-lane.)
 *
 * FILES ARE NOT THE DATABASE. criteria_provenance / lifestyle_preferences / listing_type
 * arrive with m895 and buyer_criteria_changes with m896, both WRITTEN, NOT APPLIED until
 * the integrator applies them. Until then every read and write here degrades by name
 * (42703 undefined column / 42P01 undefined table / PGRST204) and says so in `note`; the
 * legacy columns keep working exactly as before.
 *
 * FAIR-HOUSING SCOPE: this is the buyer's FILTER store — the exempt data lane
 * (scripts/compliance-scope-simulator.ts EXEMPT_PATH_GLOBS). Nothing here is sanitized and
 * nothing here may import a content gate; the steering check lives on the recommendation
 * path (search-engine.ts / conversational-search.ts → fair-housing.ts).
 */
import { createServiceClient } from "@/lib/supabase/service"
import type { LifestyleAsk } from "./conversation-criteria"

export type CriteriaProvenanceSource = "said" | "inferred" | "default"

/** The editable criteria fields — the vocabulary every provenance entry and change row uses. */
export const CRITERIA_FIELDS = [
  "minPrice", "maxPrice", "minBeds", "minBaths", "cities", "zipCodes", "propertyTypes",
  "mustHaveFeatures", "dealBreakers", "listingType", "lifestyle",
] as const
export type CriteriaField = (typeof CRITERIA_FIELDS)[number]

/** Where a criterion was stated or learned — one vocabulary (m895/m896 CHECK mirrors it). */
export const CRITERIA_CHANNELS = ["portal", "mobile", "email", "sms", "voice", "ai_chat", "agent", "system"] as const
export type CriteriaChannel = (typeof CRITERIA_CHANNELS)[number]

export interface FieldProvenance {
  source: CriteriaProvenanceSource
  /** The value this entry vouches for (said values survive a learner overwriting the column). */
  value: unknown
  /** The buyer's literal words when `source` is "said"; the learned reason otherwise. */
  evidence: string | null
  channel: CriteriaChannel | null
  /** ISO time the value was said / learned / defaulted. */
  at: string
  reason: string | null
  /** Wave 148D (ruling 9): how sure the parse of that statement was (ParsedBuyerCriteria.confidence). */
  confidence?: "high" | "low" | null
  /** Wave 148D (ruling 9): on what basis the buyer's words are held — never fabricated (ruling 3). */
  consent?: CriteriaConsent | null
}

/**
 * WAVE 148 (lane 148D, owner ruling 9: "buyers' words are recorded; call transcripts save to the criteria
 * store — literal wording, structured interpretation, confidence, consent; corrections keep history").
 * The basis on which a buyer's own words are held in this store. One vocabulary (§6), carried in the
 * jsonb provenance / change evidence (m895 / m896 — no new column). It states what is KNOWN, never more:
 * a call transcript says the AI-call disclosure policy applies, not that this call's announcement played.
 */
/** ONE consent vocabulary (CLAUDE.md §6) — the m916 CHECK's values (CONSENT_BASES below is this same list). Lane 148D's
 *  parallel list ("call_transcript" / "agent_entered" / "system") was merged onto it by the wave-148 integrator:
 *  call_transcript → call_recording_disclosure, agent_entered → agent_attested, system → null (a basis nobody stated is
 *  NOT stated — never assumed). */
export const CRITERIA_CONSENT_BASES = ["self_service_portal", "inbound_message", "call_recording_disclosure", "agent_attested"] as const
export type CriteriaConsentBasis = (typeof CRITERIA_CONSENT_BASES)[number]

export interface CriteriaConsent {
  basis: CriteriaConsentBasis
  /** The record the basis rests on — a signed-in user id, a message id, `voice_call:<id>` (m916 consent_ref). */
  ref?: string | null
  /** What the basis rests on, in words (the disclosure policy, the sign-in, the inbound message). */
  note?: string | null
  /** The record the words came from — `voice_call:<id>`, `message:<id>` — traceable. */
  sourceRef?: string | null
  capturedAt?: string
}

/** PURE: the basis a channel implies AS A FACT when the door states none — the buyer typed in their own signed-in
 *  portal (a signed-in user only), the buyer wrote to us (email / SMS), the buyer's agent entered it (attested by that
 *  agent). A call must state its own basis (the recording disclosure) and anything else is null: "not stated". */
export function defaultCriteriaConsent(
  channel: CriteriaChannel, at: string, sourceRef: string | null = null, actor?: { type?: string; userId?: string | null } | null,
): CriteriaConsent | null {
  if ((channel === "portal" || channel === "mobile") && actor?.type === "user" && actor.userId)
    return { basis: "self_service_portal", ref: actor.userId, note: "Typed or spoken by the buyer in their own signed-in portal.", sourceRef, capturedAt: at }
  if (channel === "email" || channel === "sms")
    return { basis: "inbound_message", ref: sourceRef, note: "The buyer wrote to us; their message is the record.", sourceRef, capturedAt: at }
  if (channel === "agent" && actor?.userId)
    return { basis: "agent_attested", ref: actor.userId, note: "Entered by the buyer's agent on the buyer's behalf.", sourceRef, capturedAt: at }
  return null
}

export type CriteriaProvenanceMap = Partial<Record<CriteriaField, FieldProvenance>>

export interface BuyerCriteria {
  minPrice:        number | null
  maxPrice:        number | null
  minBeds:         number | null
  minBaths:        number | null
  cities:          string[]
  zipCodes:        string[]
  propertyTypes:   string[]
  mustHaveFeatures: string[]
  dealBreakers:    string[]
  confidenceScore: number | null
  /** sale | rent; null = never stated (the search treats null as the for-sale market). */
  listingType?:    "sale" | "rent" | null
  /** The buyer's lifestyle asks (natural light, commute, layout, …) — answered only from source data. */
  lifestyle?:      LifestyleAsk[]
  /** Per-field provenance. A field with no entry is a legacy value: treated as "inferred". */
  provenance?:     CriteriaProvenanceMap
  /** Fields where a said value outranked a different column value (the learner overwrote it). */
  saidOverridesColumn?: CriteriaField[]
  /** Why provenance is partial (m895 not applied, a refused read) — never silent. */
  note?:           string | null
}

const num = (v: any): number | null => (typeof v === "number" && !Number.isNaN(v)) ? v : null
const arr = (v: any): string[] => Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()) : []

/**
 * The canonical property_preferences criteria column list — the ONE place it's defined.
 * Any consumer that reads buyer criteria selects via this (or calls loadBuyerCriteria) so a
 * column rename/typo can't silently diverge across the matcher / watch / brief / insights.
 */
export const BUYER_CRITERIA_SELECT =
  "preferred_price_min, preferred_price_max, inferred_min_price, inferred_max_price, inferred_beds_min, inferred_baths_min, inferred_cities, inferred_zip_codes, inferred_property_types, inferred_must_have_features, inferred_deal_breakers, confidence_score"

/** The m895 columns (wave 147C). Read beside the legacy list, degraded by name when absent. */
export const BUYER_CRITERIA_STATE_SELECT = "criteria_provenance, lifestyle_preferences, listing_type"

/** Did PostgREST refuse because a column / table does not exist yet (a migration not applied)? */
function isSchemaAbsentError(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!err) return false
  if (err.code === "42703" || err.code === "42P01" || err.code === "PGRST204" || err.code === "PGRST205") return true
  return /does not exist|could not find the .* column|schema cache/i.test(err.message ?? "")
}

/** PURE. Normalize one property_preferences row (legacy columns + optional m895 state). */
function normalizeCriteriaRow(p: Record<string, any>, note: string | null = null): BuyerCriteria {
  const base: BuyerCriteria = {
    minPrice:         num(p.preferred_price_min) ?? num(p.inferred_min_price),
    maxPrice:         num(p.preferred_price_max) ?? num(p.inferred_max_price),
    minBeds:          num(p.inferred_beds_min),
    minBaths:         num(p.inferred_baths_min),
    cities:           arr(p.inferred_cities),
    zipCodes:         arr(p.inferred_zip_codes),
    propertyTypes:    arr(p.inferred_property_types),
    mustHaveFeatures: arr(p.inferred_must_have_features),
    dealBreakers:     arr(p.inferred_deal_breakers),
    confidenceScore:  num(p.confidence_score),
  }
  const provenance: CriteriaProvenanceMap =
    p.criteria_provenance && typeof p.criteria_provenance === "object" && !Array.isArray(p.criteria_provenance)
      ? (p.criteria_provenance as CriteriaProvenanceMap) : {}
  const lifestyle: LifestyleAsk[] = Array.isArray(p.lifestyle_preferences) ? (p.lifestyle_preferences as LifestyleAsk[]) : []
  const listingType = p.listing_type === "rent" || p.listing_type === "sale" ? p.listing_type : null
  const out: BuyerCriteria = { ...base, listingType, lifestyle, provenance, saidOverridesColumn: [], note }

  // A SAID value outranks the column it shadows — the learner may have overwritten the column.
  for (const field of CRITERIA_FIELDS) {
    const prov = provenance[field]
    if (!prov || prov.source !== "said" || prov.value === undefined) continue
    const current = (out as any)[field]
    if (JSON.stringify(current ?? null) !== JSON.stringify(prov.value ?? null)) {
      ;(out as any)[field] = prov.value
      out.saidOverridesColumn!.push(field)
    }
  }
  return out
}

/** PURE. The provenance a field reads as — a legacy value with no entry is "inferred", never "said". */
export function provenanceOf(c: BuyerCriteria, field: CriteriaField): CriteriaProvenanceSource | null {
  const v = (c as any)[field]
  const empty = v == null || (Array.isArray(v) && v.length === 0)
  if (c.provenance?.[field]) return c.provenance[field]!.source
  if (field === "listingType" && v == null) return "default"
  return empty ? null : "inferred"
}

/** Read + normalize one buyer's criteria from property_preferences (explicit > inferred; said > column). */
export async function loadBuyerCriteria(
  supabase: ReturnType<typeof createServiceClient>, contactId: string,
  opts: { brokerageId?: string | null } = {},
): Promise<BuyerCriteria | null> {
  // The tenant bound is UNCONDITIONAL (CLAUDE.md §4; wave 147 integrator — conditional-tenant-predicate): the service client
  // bypasses RLS, so a caller that does not know the tenant has it resolved from the contact's own row, and a contact whose
  // tenant cannot be resolved gets "unknown" (null) — never a read across every tenant.
  let tenant = opts.brokerageId ?? null
  if (!tenant) {
    const { data: owner, error: ownerErr } = await supabase.from("contacts").select("brokerage_id").eq("id", contactId).maybeSingle()
    if (ownerErr) { console.error("[buyer-criteria] contact tenant read refused:", ownerErr.message); return null }
    tenant = (owner as { brokerage_id?: string | null } | null)?.brokerage_id ?? null
  }
  if (!tenant) { console.error(`[buyer-criteria] no tenant resolvable for contact ${contactId} — refusing an unbounded read`); return null }
  const brokerageId: string = tenant
  // One round trip once m895 is applied; the legacy list again only when the new columns are absent.
  const run = (cols: string) =>
    supabase.from("property_preferences").select(cols).eq("contact_id", contactId).eq("brokerage_id", brokerageId).maybeSingle()
  const full = await run(`${BUYER_CRITERIA_SELECT}, ${BUYER_CRITERIA_STATE_SELECT}`)
  if (!full.error) return full.data ? normalizeCriteriaRow(full.data as Record<string, any>) : null
  if (!isSchemaAbsentError(full.error)) {
    // supabase-js RESOLVES a refusal: say it, and answer "unknown" (null) rather than an empty criteria set.
    console.error("[buyer-criteria] property_preferences read refused:", full.error.message)
    return null
  }
  const legacy = await run(BUYER_CRITERIA_SELECT)
  if (legacy.error) {
    console.error("[buyer-criteria] property_preferences read refused:", legacy.error.message)
    return null
  }
  return legacy.data
    ? normalizeCriteriaRow(legacy.data as Record<string, any>, "Per-field provenance is not stored yet (m895 not applied) — every value reads as inferred.")
    : null
}

// ─── THE ONE WRITER (wave 147C) ──────────────────────────────────────────────

export interface SaveCriteriaResult {
  ok: boolean
  rowId: string | null
  /** false → values were saved but provenance / lifestyle / listing type could not be (m895). */
  provenancePersisted: boolean
  note: string | null
  error: string | null
}

/**
 * Persist the buyer's full criteria (values + provenance) to property_preferences — the ONE
 * writer every conversational channel calls (portal turn, correction, accepted proposal,
 * feedback text). TENANT: `brokerageId` is the caller's verified tenant (the portal gate's,
 * never a request body); a row owned by another tenant is refused, and the update is
 * counted — an UPDATE that matches nothing RESOLVES (CLAUDE.md §3).
 *
 * Column rules: a SAID price goes to preferred_price_* (the explicit columns the reader
 * prefers); every other field goes to its inferred_* column (the live table has no
 * preferred_* for them) and its provenance entry says whether it was said.
 */
export async function saveBuyerCriteria(
  svc: ReturnType<typeof createServiceClient>,
  input: { brokerageId: string; contactId: string; criteria: BuyerCriteria },
): Promise<SaveCriteriaResult> {
  const { brokerageId, contactId, criteria } = input
  const fail = (error: string): SaveCriteriaResult => ({ ok: false, rowId: null, provenancePersisted: false, note: null, error })
  if (!brokerageId || !contactId) return fail("A verified tenant and contact are required to save criteria")

  const { data: existing, error: readError } = await svc.from("property_preferences")
    .select("id, brokerage_id").eq("contact_id", contactId).maybeSingle()
  if (readError) return fail(`Criteria row read refused: ${readError.message}`)
  if (existing && (existing as { brokerage_id: string | null }).brokerage_id && (existing as { brokerage_id: string }).brokerage_id !== brokerageId) {
    return fail("This buyer's criteria belong to a different brokerage — refused")
  }

  const prov = criteria.provenance ?? {}
  const said = (f: CriteriaField) => prov[f]?.source === "said"
  const now = new Date().toISOString()
  const values: Record<string, unknown> = {
    inferred_min_price:          criteria.minPrice,
    inferred_max_price:          criteria.maxPrice,
    inferred_beds_min:           criteria.minBeds,
    inferred_baths_min:          criteria.minBaths,
    inferred_cities:             criteria.cities,
    inferred_zip_codes:          criteria.zipCodes,
    inferred_property_types:     criteria.propertyTypes,
    inferred_must_have_features: criteria.mustHaveFeatures,
    inferred_deal_breakers:      criteria.dealBreakers,
    updated_at:                  now,
  }
  if (said("minPrice")) values.preferred_price_min = criteria.minPrice
  if (said("maxPrice")) values.preferred_price_max = criteria.maxPrice

  let rowId: string
  if (existing) {
    rowId = (existing as { id: string }).id
    const { data: updated, error: updError } = await svc.from("property_preferences")
      .update(values).eq("id", rowId).eq("brokerage_id", brokerageId).select("id")
    if (updError) return fail(`Criteria update refused: ${updError.message}`)
    if (!updated || (updated as unknown[]).length !== 1) return fail("Criteria update matched no row under this tenant — nothing was saved")
  } else {
    const { data: inserted, error: insError } = await svc.from("property_preferences")
      .insert({ ...values, contact_id: contactId, brokerage_id: brokerageId }).select("id").single()
    if (insError || !inserted) return fail(`Criteria insert refused: ${insError?.message ?? "no row returned"}`)
    rowId = (inserted as { id: string }).id
  }

  const { data: stateRows, error: stateError } = await svc.from("property_preferences")
    .update({
      criteria_provenance:   prov,
      lifestyle_preferences: criteria.lifestyle ?? [],
      listing_type:          criteria.listingType ?? null,
    })
    .eq("id", rowId).eq("brokerage_id", brokerageId).select("id")
  if (stateError) {
    if (isSchemaAbsentError(stateError)) {
      return { ok: true, rowId, provenancePersisted: false, note: "Criteria values saved; per-field provenance, lifestyle asks and listing type wait for m895.", error: null }
    }
    return { ok: true, rowId, provenancePersisted: false, note: `Criteria values saved; provenance write refused: ${stateError.message}`, error: null }
  }
  const persisted = !!stateRows && (stateRows as unknown[]).length === 1
  return { ok: true, rowId, provenancePersisted: persisted, note: persisted ? null : "Provenance update matched no row", error: null }
}

// ─── Criteria change records (m896 buyer_criteria_changes) ───────────────────

export const CRITERIA_CHANGE_TRIGGERS = ["stated", "corrected", "feedback", "saved", "dismissed", "toured", "priority_change"] as const
export type CriteriaChangeTrigger = (typeof CRITERIA_CHANGE_TRIGGERS)[number]
export const CRITERIA_CHANGE_STATUSES = ["proposed", "applied", "accepted", "rejected", "superseded"] as const
export type CriteriaChangeStatus = (typeof CRITERIA_CHANGE_STATUSES)[number]

/** One change to one field, with the reason the buyer reads and can edit or reject. */
export interface CriteriaChangeDraft {
  field: CriteriaField
  previous: unknown
  proposed: unknown
  provenance: CriteriaProvenanceSource
  trigger: CriteriaChangeTrigger
  /** Plain words the buyer reads: `You said "under 600k"` / `You saved 2 homes above $600k`. */
  reason: string
  evidence: Record<string, unknown>
  /** applied = already in the criteria (buyer may undo); proposed = waits for the buyer. */
  status: "proposed" | "applied"
  channel: CriteriaChannel
}

export interface CriteriaChangeRow extends CriteriaChangeDraft {
  /** Who proposed (created) and who decided the change, and when it was decided — read back for the agent's change history. */
  proposedByUserId?: string | null
  decidedByUserId?: string | null
  decidedAt?: string | null
  id: string
  created_at?: string
}

/** Record change drafts for one buyer. Degrades by name when m896 is not applied. */
export async function recordCriteriaChanges(
  svc: ReturnType<typeof createServiceClient>,
  input: { brokerageId: string; contactId: string; changes: CriteriaChangeDraft[]; actorUserId?: string | null },
): Promise<{ persisted: boolean; ids: string[]; note: string | null }> {
  if (input.changes.length === 0) return { persisted: true, ids: [], note: null }
  const rows = input.changes.map((c) => ({
    brokerage_id:   input.brokerageId,
    contact_id:     input.contactId,
    field:          c.field,
    previous_value: c.previous ?? null,
    proposed_value: c.proposed ?? null,
    provenance:     c.provenance,
    trigger:        c.trigger,
    reason:         c.reason,
    evidence:       c.evidence ?? {},
    status:         c.status,
    channel:        c.channel,
    created_by_user_id: input.actorUserId ?? null,
  }))
  const { data, error } = await svc.from("buyer_criteria_changes").insert(rows).select("id")
  if (error) {
    if (isSchemaAbsentError(error)) return { persisted: false, ids: [], note: "Change history waits for m896 (buyer_criteria_changes) — the changes were applied/proposed in this response only." }
    return { persisted: false, ids: [], note: `Change history write refused: ${error.message}` }
  }
  return { persisted: true, ids: ((data ?? []) as Array<{ id: string }>).map((r) => r.id), note: null }
}

/** The buyer's open proposals + recent applied changes (one tenant, one contact). */
export async function loadCriteriaChanges(
  svc: ReturnType<typeof createServiceClient>,
  input: { brokerageId: string; contactId: string; statuses?: CriteriaChangeStatus[]; limit?: number },
): Promise<{ rows: CriteriaChangeRow[]; note: string | null }> {
  const { data, error } = await svc.from("buyer_criteria_changes")
    .select("id, field, previous_value, proposed_value, provenance, trigger, reason, evidence, status, channel, created_at, created_by_user_id, decided_by_user_id, decided_at")
    .eq("brokerage_id", input.brokerageId).eq("contact_id", input.contactId)
    .in("status", input.statuses ?? ["proposed", "applied"])
    .order("created_at", { ascending: false }).limit(input.limit ?? 20)
  if (error) {
    return { rows: [], note: isSchemaAbsentError(error) ? "Change history waits for m896." : `Change history read refused: ${error.message}` }
  }
  return {
    rows: ((data ?? []) as Array<Record<string, any>>).map((r) => ({
      id: r.id, field: r.field, previous: r.previous_value, proposed: r.proposed_value, provenance: r.provenance,
      trigger: r.trigger, reason: r.reason, evidence: r.evidence ?? {}, status: r.status, channel: r.channel, created_at: r.created_at,
      // Who proposed and who decided (the agent sees whether a change came from the buyer, the system or a colleague).
      proposedByUserId: r.created_by_user_id ?? null, decidedByUserId: r.decided_by_user_id ?? null, decidedAt: r.decided_at ?? null,
    })),
    note: null,
  }
}

/**
 * Settle one change: accept a proposal, or reject (undo) a proposal / an applied change.
 * Counted: a decision that matches no open row under this tenant + contact is a failure,
 * never a quiet success (an already-decided or foreign change id).
 */
export async function settleCriteriaChange(
  svc: ReturnType<typeof createServiceClient>,
  input: { brokerageId: string; contactId: string; changeId: string; status: "accepted" | "rejected"; decidedByUserId: string | null },
): Promise<{ ok: boolean; row: CriteriaChangeRow | null; error: string | null }> {
  const { data, error } = await svc.from("buyer_criteria_changes")
    .update({ status: input.status, decided_by_user_id: input.decidedByUserId, decided_at: new Date().toISOString() })
    .eq("id", input.changeId).eq("brokerage_id", input.brokerageId).eq("contact_id", input.contactId)
    .in("status", ["proposed", "applied"])
    .select("id, field, previous_value, proposed_value, provenance, trigger, reason, evidence, status, channel, created_by_user_id, decided_by_user_id, decided_at")
  if (error) return { ok: false, row: null, error: isSchemaAbsentError(error) ? "Change history is not available yet (m896 not applied)" : error.message }
  const rows = (data ?? []) as Array<Record<string, any>>
  if (rows.length !== 1) return { ok: false, row: null, error: "That change is not open for this buyer (already decided, or not theirs)" }
  const r = rows[0]
  return {
    ok: true,
    row: { id: r.id, field: r.field, previous: r.previous_value, proposed: r.proposed_value, provenance: r.provenance, trigger: r.trigger, reason: r.reason, evidence: r.evidence ?? {}, proposedByUserId: r.created_by_user_id ?? null, decidedByUserId: r.decided_by_user_id ?? null, decidedAt: r.decided_at ?? null, status: r.status, channel: r.channel },
    error: null,
  }
}

// ─── The buyer's own words (m916 buyer_criteria_utterances — wave 148, lane 148E, owner ruling 9) ──
//
// Owner (2026-11-01): "Buyers' words are recorded; call transcripts save to the criteria store — literal wording,
// structured interpretation, confidence, consent; corrections keep history." The per-field provenance above keeps a
// QUOTE per field and buyer_criteria_changes keeps every change with its reason; what no row kept was the WHOLE
// utterance — the buyer's literal lines from a call, an email, a text or a portal turn — beside what the parser made of
// it, how confident it was and on what consent basis it was captured. One row per utterance (idempotent on its source:
// a re-analysed call or a re-delivered webhook writes nothing new), linked from each change it produced through
// `evidence.utterance_id`. Corrections are NOT edits of this row: they are new change rows (trigger "corrected"), so the
// history keeps both what was heard and what the buyer later fixed. The intent interface (lane 148D, C17) reaches this
// store through criteria-turn.ts recordStatedCriteriaTurn — the one writer — never a second utterance table.

/** Where an utterance came from — one vocabulary (m916 CHECK buyer_criteria_utterances_source_kind_check mirrors it). */
export const UTTERANCE_SOURCE_KINDS = ["portal_turn", "call_transcript", "inbound_email", "inbound_sms", "intent_interface", "agent_entry", "system_import"] as const
export type UtteranceSourceKind = (typeof UTTERANCE_SOURCE_KINDS)[number]

/**
 * The basis on which the buyer's words were captured (m916 CHECK mirrors it). NEVER fabricated: a basis is stated by
 * the door that heard the words, or derived only where it is a fact of the channel (the buyer typed in their own
 * portal; the buyer wrote to us). A call with no stated disclosure is recorded with consent_basis NULL — "not stated",
 * never "consented".
 */
export const CONSENT_BASES = CRITERIA_CONSENT_BASES
export type ConsentBasis = CriteriaConsentBasis

export interface BuyerUtteranceDraft {
  channel: CriteriaChannel
  sourceKind: UtteranceSourceKind
  /** The call id / message id / turn key — the idempotency anchor (unique per contact + source kind). */
  sourceRef: string
  /** The buyer's literal words (buyer lines only on a labelled transcript). */
  literal: string
  /** What the parser made of it: criteria, lifestyle asks, deal-breakers, priority, gaps, which passes ran. */
  interpretation: Record<string, unknown>
  confidence: "high" | "low"
  consent: { basis: ConsentBasis; ref?: string | null } | null
  appliedChangeCount: number
  createdByUserId?: string | null
}

export interface BuyerUtteranceRow {
  id: string
  channel: string
  sourceKind: string
  sourceRef: string | null
  literal: string
  interpretation: Record<string, unknown>
  confidence: string
  consentBasis: string | null
  appliedChangeCount: number
  createdAt: string | null
}

/**
 * Record one utterance. Idempotent on (contact, source kind, source ref): a replay returns the existing row's id and
 * writes nothing. Degrades BY NAME until m916 is applied (42P01 / PGRST205) and says so; any other refusal is reported.
 */
export async function recordBuyerUtterance(
  svc: ReturnType<typeof createServiceClient>,
  input: { brokerageId: string; contactId: string; draft: BuyerUtteranceDraft },
): Promise<{ id: string | null; persisted: boolean; replay: boolean; note: string | null }> {
  const d = input.draft
  const literal = d.literal.trim().slice(0, 4000)
  if (!input.brokerageId || !input.contactId || !literal) return { id: null, persisted: false, replay: false, note: "Nothing to record (no tenant, contact or words)." }
  const row = {
    brokerage_id: input.brokerageId,
    contact_id: input.contactId,
    channel: d.channel,
    source_kind: d.sourceKind,
    source_ref: d.sourceRef.slice(0, 300),
    literal_text: literal,
    interpretation: d.interpretation ?? {},
    confidence: d.confidence,
    consent_basis: d.consent?.basis ?? null,
    consent_ref: d.consent?.ref ?? null,
    applied_change_count: Math.max(0, Math.round(d.appliedChangeCount)),
    created_by_user_id: d.createdByUserId ?? null,
  }
  const { data, error } = await svc.from("buyer_criteria_utterances")
    .upsert(row, { onConflict: "contact_id,source_kind,source_ref", ignoreDuplicates: true }).select("id")
  if (error) {
    if (isSchemaAbsentError(error)) return { id: null, persisted: false, replay: false, note: "The buyer's words wait for m916 (buyer_criteria_utterances) — the criteria change itself was still recorded." }
    return { id: null, persisted: false, replay: false, note: `Utterance record refused: ${error.message}` }
  }
  const inserted = ((data ?? []) as Array<{ id: string }>)[0]
  if (inserted) return { id: inserted.id, persisted: true, replay: false, note: null }
  // ignoreDuplicates resolves EMPTY on a replay — read the existing row's id under the same tenant + contact.
  const { data: prior, error: priorError } = await svc.from("buyer_criteria_utterances").select("id")
    .eq("brokerage_id", input.brokerageId).eq("contact_id", input.contactId).eq("source_kind", d.sourceKind).eq("source_ref", row.source_ref).maybeSingle()
  if (priorError) return { id: null, persisted: false, replay: true, note: `Utterance replay read refused: ${priorError.message}` }
  return { id: (prior as { id: string } | null)?.id ?? null, persisted: !!prior, replay: true, note: prior ? null : "Utterance upsert matched nothing and no prior row exists" }
}

/** The buyer's recent words with what we understood (one tenant, one contact) — the "what you told us" view. */
export async function loadBuyerUtterances(
  svc: ReturnType<typeof createServiceClient>,
  input: { brokerageId: string; contactId: string; limit?: number },
): Promise<{ rows: BuyerUtteranceRow[]; note: string | null }> {
  const { data, error } = await svc.from("buyer_criteria_utterances")
    .select("id, channel, source_kind, source_ref, literal_text, interpretation, confidence, consent_basis, applied_change_count, created_at")
    .eq("brokerage_id", input.brokerageId).eq("contact_id", input.contactId)
    .order("created_at", { ascending: false }).limit(input.limit ?? 10)
  if (error) return { rows: [], note: isSchemaAbsentError(error) ? "What you've told us is kept once m916 is applied." : `Utterance read refused: ${error.message}` }
  return {
    rows: ((data ?? []) as Array<Record<string, any>>).map((r) => ({
      id: r.id, channel: r.channel, sourceKind: r.source_kind, sourceRef: r.source_ref ?? null, literal: r.literal_text,
      interpretation: r.interpretation ?? {}, confidence: r.confidence, consentBasis: r.consent_basis ?? null,
      appliedChangeCount: Number(r.applied_change_count ?? 0), createdAt: r.created_at ?? null,
    })),
    note: null,
  }
}
