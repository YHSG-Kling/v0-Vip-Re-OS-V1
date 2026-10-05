/**
 * lib/kernel/person-identity.ts — THE ONE PERSON IDENTITY / EVIDENCE SERVICE (wave 102, lane 102A;
 * m697). Deterministic, no LLM. Additive UNDER the existing leads and contacts: neither table
 * changes, no reader of either changes, and nothing here is a second converter or a second dedup.
 *
 * SURVIVORS THIS EXTENDS, NEVER REPLACES (OS-CONSTITUTION LAW 1 / 2):
 *   · the identity GATE — first + last NAME and a usable EMAIL (lib/lead-pipeline/
 *     canonical-lead-eligibility.ts) — is the person KEY here: normalised `first|last|email`.
 *     Phone digits CORROBORATE (a same-email record whose name is spelled differently resolves to the
 *     person when the phone agrees), they never key.
 *   · the dedup DECISIONS (lib/lead-pipeline/pipeline-processor.ts findBestMatch + lead_deduplication_log)
 *     stay where they are; a decision is mirrored here as evidence with the same stage and score.
 *   · the lead→contact LINK (leads.contact_id + converted_at, lib/contact-promotion/history-carry.ts)
 *     stays the lineage; the person row's canonical_contact_id is stamped from that same call.
 *   · contacts.contact_id (a per-row secondary uuid) and unified_lead_profile (a per-contact
 *     intelligence profile) are NOT person keys and are untouched.
 *
 * CALLERS (the EXISTING chokepoints only — never a new path):
 *   pipeline-processor.ts (identity gate + every dedup verdict + lead creation), history-carry.ts
 *   (promotion link → canonical_contact_id), contact-management.service.ts mergeContacts,
 *   unknown-sender-identification.ts, open-house/instant-greeting.ts (the kiosk), api/forms/submit
 *   (the submission row), and since wave 102.1 (lane 102E): contact-capture.ts captureContact (ONCE,
 *   inside — every public capture door inherits it: forms, lead magnets, QR, widgets, kiosk),
 *   lib/kernel/crm.ts mergeOrUpdateContactIfDuplicate (the manual dedup verdict, R2),
 *   app/actions/lead-intelligence.ts resolveIdentity (the behavioral_signal writer) and
 *   lib/platform/distribution-engine.ts (R1: a platform lead is re-homed under the RECEIVING tenant).
 *   Each passes the tenant from its own already-resolved context (CLAUDE.md §4) and the client it
 *   already writes with. Every write destructures `{ data, error }` (§3). Before m697 is applied the
 *   tables are absent (42P01 / PGRST205): every function returns `{ ok: false, reason }` — the
 *   caller's primary write is never blocked and the lost link is reported, never thrown.
 *
 * EVIDENCE (LAW 5): a link is an append-only row — entity, method, score, chokepoint, actor, when —
 * plus a field-provenance stamp (THE one writer, enrichment-column-map.ts::stampFieldProvenance) for
 * the identity fields the link was judged on. The ONE new kernel event, `person.identity_linked`
 * (auditOnly), is emitted only where the chokepoint has no event of its own; chokepoints that
 * already emit (RAW_RECORD_PROMOTED, FORM_SUBMISSION_RECEIVED, UNKNOWN_SENDER_IDENTIFIED_AS_LEAD,
 * LEAD_CONVERTED_TO_CONTACT …) pass `existingEvent` and carry person_id on that event instead.
 *
 * READERS: personForContact / personForLead (lib/lead-intelligence/person-timeline.ts folds every
 * linked lead/raw row into ONE timeline; lib/contacts/contact-brief.ts renders the evidence summary).
 * summarizePersonEvidence is pure and carries NO cost key (CLAUDE.md §5: agents see contacts only,
 * never lead cost).
 */

import { stampFieldProvenance, type FieldProvenance } from "@/lib/lead-pipeline/enrichment-column-map"

// ─── Vocabularies (mirrored in m697's inline CHECKs; the proof asserts code == migration) ────────

/** @proofSeam the proof asserts this list equals m697's entity_type CHECK (one vocabulary, §6). */
export const PERSON_ENTITY_TYPES = [
  "raw_scraped_lead", "lead", "contact", "open_house_attendee", "form_submission", "behavioral_signal",
] as const
export type PersonEntityType = typeof PERSON_ENTITY_TYPES[number]

/** @proofSeam the proof asserts this list equals m697's match_method CHECK (one vocabulary, §6). */
export const PERSON_MATCH_METHODS = [
  "identity_gate",      // the record's own first+last+email cleared the gate (exact key)
  "email_exact",        // an existing record matched on the normalised email alone
  "phone_corroborated", // email matched, name differed, phone digits agreed
  "dedup_match",        // the pipeline's fuzzy dedup verdict (score = its match_score)
  "promotion_link",     // leads.contact_id + converted_at stamped (history-carry)
  "contact_merge",      // mergeContacts folded a duplicate contact onto the survivor
  "capture_match",      // a public capture (kiosk / form) matched or created the contact by email
] as const
export type PersonMatchMethod = typeof PERSON_MATCH_METHODS[number]

/** actor_type — the agent_action_ledger vocabulary (m687), never a second spelling. */
export type PersonActorType = "manager" | "user" | "agent" | "system"

/** The ONE new kernel event (module-private: emitted only here; the proof asserts the literal). */
const PERSON_IDENTITY_LINKED_EVENT = "person.identity_linked"
const PERSON_CAPABILITY = "person.resolve_identity"

// ─── Pure identity normalisation ────────────────────────────────────────────────────────────────

export interface PersonIdentityInput {
  firstName: string | null | undefined
  lastName: string | null | undefined
  email: string | null | undefined
  phone?: string | null | undefined
}

export interface NormalizedPersonIdentity {
  key: string
  emailNormalized: string
  firstNormalized: string
  lastNormalized: string
  phoneDigits: string | null
}

const collapseName = (v: string | null | undefined): string =>
  (v ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()

/**
 * PURE — the identity-gate key. Returns null when the gate would refuse (no usable first + last +
 * email): a person is never minted on a phone, a name or an address alone.
 * @proofSeam the proof asserts the key rule directly (same person → same key; different email → different key).
 */
export function normalizePersonIdentity(input: PersonIdentityInput): NormalizedPersonIdentity | null {
  const first = collapseName(input.firstName)
  const last = collapseName(input.lastName)
  const email = (input.email ?? "").trim().toLowerCase()
  if (!first || !last || !email || !email.includes("@")) return null
  const digits = (input.phone ?? "").replace(/\D/g, "")
  // Same rule as fuzzy-matcher.ts::normalizePhone (digits only); a US number drops its leading 1 so
  // "+1 (555) 010-0100" and "5550100100" corroborate each other.
  const phoneDigits = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits
  return {
    key: `${first}|${last}|${email}`,
    emailNormalized: email,
    firstNormalized: first,
    lastNormalized: last,
    phoneDigits: phoneDigits.length >= 7 ? phoneDigits : null,
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────────────────────────

type Client = any

export interface PersonRow {
  id: string
  brokerage_id: string
  identity_key: string
  email_normalized: string
  first_name_normalized: string
  last_name_normalized: string
  phone_digits: string | null
  canonical_contact_id: string | null
  converted_at: string | null
  first_seen_at: string | null
  last_seen_at: string | null
  evidence_count: number
}

export interface PersonEvidenceRow {
  id: string
  person_id: string
  entity_type: PersonEntityType
  entity_id: string
  match_method: PersonMatchMethod
  match_score: number
  source: string
  observed_at: string | null
  actor_type: PersonActorType
  actor_user_id: string | null
  detail: Record<string, unknown> | null
}

export interface PersonActor {
  type: PersonActorType
  /** users.id of a human actor; null for the system / the AI ISA. */
  userId?: string | null
}

export type ResolvePersonResult =
  | { ok: true; personId: string; created: boolean; matchMethod: "identity_gate" | "phone_corroborated"; matchScore: number; identity: NormalizedPersonIdentity }
  | { ok: false; reason: string }

export interface ResolvePersonParams extends PersonIdentityInput {
  /** The tenant — from the caller's already-resolved context, never a request body. */
  brokerageId: string | null | undefined
}

const PERSON_COLS = "id, brokerage_id, identity_key, email_normalized, first_name_normalized, last_name_normalized, phone_digits, canonical_contact_id, converted_at, first_seen_at, last_seen_at, evidence_count"
const EVIDENCE_COLS = "id, person_id, entity_type, entity_id, match_method, match_score, source, observed_at, actor_type, actor_user_id, detail"

const errText = (e: unknown): string => (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e))

// ─── resolvePerson ──────────────────────────────────────────────────────────────────────────────

/**
 * Resolve (find or create) THE person a record's identity names, inside one tenant.
 *   1. exact identity-gate key → that person;
 *   2. else same normalised email AND phone digits agree → that person (phone corroborates a
 *      re-spelled name); the person's phone is filled if it was empty;
 *   3. else a new person row (first-seen now).
 * Deterministic; fail closed: no tenant → refused; no gate-usable identity → refused (no person is
 * minted on a phone, a name or an address alone).
 */
export async function resolvePerson(client: Client, params: ResolvePersonParams): Promise<ResolvePersonResult> {
  const brokerageId = params.brokerageId ?? null
  if (!brokerageId) return { ok: false, reason: "no_tenant" }
  const identity = normalizePersonIdentity(params)
  if (!identity) return { ok: false, reason: "no_identity_anchor" }

  try {
    const { data: exact, error: exactErr } = await client
      .from("person_identities")
      .select(PERSON_COLS)
      .eq("brokerage_id", brokerageId)
      .eq("identity_key", identity.key)
      .maybeSingle()
    if (exactErr) return { ok: false, reason: `person_identities read refused: ${errText(exactErr)}` }
    if (exact) return { ok: true, personId: (exact as PersonRow).id, created: false, matchMethod: "identity_gate", matchScore: 1, identity }

    // Corroboration: same email, phone agrees, name spelled differently.
    if (identity.phoneDigits) {
      const { data: byEmail, error: emailErr } = await client
        .from("person_identities")
        .select(PERSON_COLS)
        .eq("brokerage_id", brokerageId)
        .eq("email_normalized", identity.emailNormalized)
      if (emailErr) return { ok: false, reason: `person_identities read refused: ${errText(emailErr)}` }
      const corroborated = ((byEmail ?? []) as PersonRow[]).find((p) => p.phone_digits && p.phone_digits === identity.phoneDigits)
      if (corroborated) return { ok: true, personId: corroborated.id, created: false, matchMethod: "phone_corroborated", matchScore: 0.9, identity }
    }

    const now = new Date().toISOString()
    const { data: created, error: insertErr } = await client
      .from("person_identities")
      .insert({
        brokerage_id: brokerageId,
        identity_key: identity.key,
        email_normalized: identity.emailNormalized,
        first_name_normalized: identity.firstNormalized,
        last_name_normalized: identity.lastNormalized,
        phone_digits: identity.phoneDigits,
        first_seen_at: now,
        last_seen_at: now,
        evidence_count: 0,
        created_at: now,
        updated_at: now,
      })
      .select("id")
      .single()
    if (insertErr || !created) {
      // 23505 — a concurrent resolver minted the same key first: re-read, never a second person.
      if ((insertErr as { code?: string } | null)?.code === "23505") {
        const { data: again, error: againErr } = await client
          .from("person_identities").select("id").eq("brokerage_id", brokerageId).eq("identity_key", identity.key).maybeSingle()
        if (!againErr && again) return { ok: true, personId: (again as { id: string }).id, created: false, matchMethod: "identity_gate", matchScore: 1, identity }
      }
      return { ok: false, reason: `person_identities insert refused: ${errText(insertErr ?? "no row returned")}` }
    }
    return { ok: true, personId: (created as { id: string }).id, created: true, matchMethod: "identity_gate", matchScore: 1, identity }
  } catch (err) {
    return { ok: false, reason: `person_identities unavailable: ${errText(err)}` }
  }
}

// ─── linkPersonEvidence ─────────────────────────────────────────────────────────────────────────

export interface LinkPersonEvidenceParams {
  brokerageId: string | null | undefined
  personId: string
  entityType: PersonEntityType
  entityId: string
  matchMethod: PersonMatchMethod
  /** 0..1 — the dedup pass's own match_score where the link mirrors a dedup verdict. */
  matchScore: number
  /** The chokepoint that judged it ('pipeline_processor', 'history_carry', 'contact_merge', …). */
  source: string
  actor?: PersonActor | null
  observedAt?: string | null
  /** Free-form evidence detail (stage, dedup log details, …). Never a cost key — see summarize. */
  detail?: Record<string, unknown> | null
  /** The identity the link was judged on → a field-provenance stamp rides in detail.provenance. */
  identity?: NormalizedPersonIdentity | null
  /** The chokepoint's OWN kernel event carries person_id; when set, no person.identity_linked emit. */
  existingEvent?: string | null
}

export type LinkPersonEvidenceResult =
  | { ok: true; evidenceId: string | null; duplicate: boolean }
  | { ok: false; reason: string }

/**
 * Append ONE evidence row (idempotent on (person, entity_type, entity_id, match_method)), bump the
 * person's evidence_count / last_seen_at, and — only where the chokepoint has no event of its own —
 * emit the one auditOnly kernel event `person.identity_linked` through emitKernelEvent.
 */
export async function linkPersonEvidence(client: Client, params: LinkPersonEvidenceParams): Promise<LinkPersonEvidenceResult> {
  const brokerageId = params.brokerageId ?? null
  if (!brokerageId) return { ok: false, reason: "no_tenant" }
  if (!(PERSON_ENTITY_TYPES as readonly string[]).includes(params.entityType)) return { ok: false, reason: `unknown entity_type ${params.entityType}` }
  if (!(PERSON_MATCH_METHODS as readonly string[]).includes(params.matchMethod)) return { ok: false, reason: `unknown match_method ${params.matchMethod}` }
  const score = Number.isFinite(params.matchScore) ? Math.max(0, Math.min(1, Number(params.matchScore.toFixed(3)))) : 0
  const now = params.observedAt ?? new Date().toISOString()
  const actorType: PersonActorType = params.actor?.type ?? "system"
  const actorUserId = params.actor?.userId ?? null

  try {
    const { data: existing, error: existingErr } = await client
      .from("person_identity_evidence")
      .select("id")
      .eq("person_id", params.personId)
      .eq("entity_type", params.entityType)
      .eq("entity_id", params.entityId)
      .eq("match_method", params.matchMethod)
      .maybeSingle()
    if (existingErr) return { ok: false, reason: `person_identity_evidence read refused: ${errText(existingErr)}` }
    if (existing) return { ok: true, evidenceId: (existing as { id: string }).id, duplicate: true }

    // FIELD PROVENANCE through THE one writer: which identity fields the link was judged on, from
    // which chokepoint, why, and who.
    const provenance: Record<string, FieldProvenance> | null = params.identity
      ? stampFieldProvenance(
          ["first_name", "last_name", "email", ...(params.identity.phoneDigits ? ["phone"] : [])],
          { source: params.source, capability: PERSON_CAPABILITY, purpose: "acquisition", retrievedAt: now, matchConfidence: score, actor: actorUserId },
        )
      : null
    const detail = { ...(params.detail ?? {}), ...(provenance ? { provenance } : {}) }

    const { data: inserted, error: insertErr } = await client
      .from("person_identity_evidence")
      .insert({
        brokerage_id: brokerageId,
        person_id: params.personId,
        entity_type: params.entityType,
        entity_id: params.entityId,
        match_method: params.matchMethod,
        match_score: score,
        source: params.source,
        observed_at: now,
        actor_type: actorType,
        actor_user_id: actorUserId,
        detail,
        created_at: now,
      })
      .select("id")
      .single()
    if (insertErr || !inserted) {
      if ((insertErr as { code?: string } | null)?.code === "23505") return { ok: true, evidenceId: null, duplicate: true }
      return { ok: false, reason: `person_identity_evidence insert refused: ${errText(insertErr ?? "no row returned")}` }
    }
    const evidenceId = (inserted as { id: string }).id

    // The person row is a pointer; its counters move as evidence lands. Best-effort, error READ.
    const { data: personRow, error: personErr } = await client
      .from("person_identities").select("evidence_count").eq("id", params.personId).eq("brokerage_id", brokerageId).maybeSingle()
    if (!personErr && personRow) {
      const { error: bumpErr } = await client
        .from("person_identities")
        .update({ evidence_count: ((personRow as { evidence_count?: number }).evidence_count ?? 0) + 1, last_seen_at: now, updated_at: now })
        .eq("id", params.personId)
        .eq("brokerage_id", brokerageId)
      if (bumpErr) console.warn("[person-identity] evidence_count not bumped:", errText(bumpErr))
    }

    if (!params.existingEvent) {
      const { emitKernelEvent } = await import("@/lib/kernel/emit")
      const emitted = await emitKernelEvent({
        client, auditOnly: true,
        event: PERSON_IDENTITY_LINKED_EVENT,
        brokerageId,
        entityType: "person_identity",
        entityId: params.personId,
        actorUserId: actorUserId ?? undefined,
        metadata: { evidence_id: evidenceId, linked_entity_type: params.entityType, linked_entity_id: params.entityId, match_method: params.matchMethod, match_score: score, source: params.source },
      })
      if (emitted.error) console.warn("[person-identity] person.identity_linked not recorded:", emitted.error)
    }
    return { ok: true, evidenceId, duplicate: false }
  } catch (err) {
    return { ok: false, reason: `person_identity_evidence unavailable: ${errText(err)}` }
  }
}

// ─── markPersonConverted ────────────────────────────────────────────────────────────────────────

export interface MarkPersonConvertedParams {
  brokerageId: string | null | undefined
  personId: string
  /** contacts.id — the PRIMARY key, never contacts.contact_id. */
  contactId: string
  convertedAt?: string | null
  /** A merge re-points an already-converted person at the surviving contact. Default: fill if empty. */
  override?: boolean
}

/** Stamp canonical_contact_id (+ converted_at) on the person — from the SAME call that stamps
 *  leads.contact_id (history-carry), or from mergeContacts re-pointing at the survivor. */
export async function markPersonConverted(client: Client, params: MarkPersonConvertedParams): Promise<{ ok: true; changed: boolean } | { ok: false; reason: string }> {
  const brokerageId = params.brokerageId ?? null
  if (!brokerageId) return { ok: false, reason: "no_tenant" }
  try {
    const { data: row, error: readErr } = await client
      .from("person_identities").select("id, canonical_contact_id").eq("id", params.personId).eq("brokerage_id", brokerageId).maybeSingle()
    if (readErr) return { ok: false, reason: `person_identities read refused: ${errText(readErr)}` }
    if (!row) return { ok: false, reason: "person not found in tenant" }
    const current = (row as { canonical_contact_id: string | null }).canonical_contact_id
    if (current === params.contactId) return { ok: true, changed: false }
    if (current && !params.override) return { ok: true, changed: false }
    const now = params.convertedAt ?? new Date().toISOString()
    const { error: updErr } = await client
      .from("person_identities")
      .update({ canonical_contact_id: params.contactId, converted_at: now, updated_at: now })
      .eq("id", params.personId)
      .eq("brokerage_id", brokerageId)
    if (updErr) return { ok: false, reason: `person_identities update refused: ${errText(updErr)}` }
    return { ok: true, changed: true }
  } catch (err) {
    return { ok: false, reason: `person_identities unavailable: ${errText(err)}` }
  }
}

// ─── Readers ────────────────────────────────────────────────────────────────────────────────────

export interface PersonView {
  person: PersonRow
  evidence: PersonEvidenceRow[]
}

async function personViewFor(client: Client, brokerageId: string, entityType: PersonEntityType, entityId: string): Promise<{ ok: true; view: PersonView | null } | { ok: false; reason: string }> {
  try {
    // A contact's person is the one whose canonical_contact_id names it; else (and for every other
    // entity) the person an evidence row links the entity to.
    let personId: string | null = null
    if (entityType === "contact") {
      const { data: canon, error: canonErr } = await client
        .from("person_identities").select("id").eq("brokerage_id", brokerageId).eq("canonical_contact_id", entityId).limit(1)
      if (canonErr) return { ok: false, reason: `person_identities read refused: ${errText(canonErr)}` }
      personId = ((canon ?? []) as Array<{ id: string }>)[0]?.id ?? null
    }
    if (!personId) {
      const { data: links, error: linkErr } = await client
        .from("person_identity_evidence").select("person_id").eq("brokerage_id", brokerageId).eq("entity_type", entityType).eq("entity_id", entityId).limit(1)
      if (linkErr) return { ok: false, reason: `person_identity_evidence read refused: ${errText(linkErr)}` }
      personId = ((links ?? []) as Array<{ person_id: string }>)[0]?.person_id ?? null
    }
    if (!personId) return { ok: true, view: null }
    const { data: person, error: personErr } = await client
      .from("person_identities").select(PERSON_COLS).eq("id", personId).eq("brokerage_id", brokerageId).maybeSingle()
    if (personErr) return { ok: false, reason: `person_identities read refused: ${errText(personErr)}` }
    if (!person) return { ok: true, view: null }
    const { data: evidence, error: evErr } = await client
      .from("person_identity_evidence").select(EVIDENCE_COLS).eq("brokerage_id", brokerageId).eq("person_id", personId).order("observed_at", { ascending: true })
    if (evErr) return { ok: false, reason: `person_identity_evidence read refused: ${errText(evErr)}` }
    return { ok: true, view: { person: person as PersonRow, evidence: (evidence ?? []) as PersonEvidenceRow[] } }
  } catch (err) {
    return { ok: false, reason: `person identity unavailable: ${errText(err)}` }
  }
}

/** The person a contact IS (canonical_contact_id, else any evidence naming it) with every evidence row — tenant-pinned. */
export async function personForContact(client: Client, params: { brokerageId: string | null | undefined; contactId: string }) {
  if (!params.brokerageId) return { ok: false as const, reason: "no_tenant" }
  return personViewFor(client, params.brokerageId, "contact", params.contactId)
}

/** The person a lead belongs to (evidence naming the lead) with every evidence row — tenant-pinned. */
export async function personForLead(client: Client, params: { brokerageId: string | null | undefined; leadId: string }) {
  if (!params.brokerageId) return { ok: false as const, reason: "no_tenant" }
  return personViewFor(client, params.brokerageId, "lead", params.leadId)
}

// ─── resolveSurvivorPerson (wave 102.1, R2) ─────────────────────────────────────────────────────

export interface ResolveSurvivorPersonParams {
  brokerageId: string | null | undefined
  /** The record a dedup verdict named as the SURVIVOR (duplicate_of_lead_id / duplicate_of_contact_id / an older raw row). */
  survivor: { entityType: PersonEntityType; entityId: string }
  /** The survivor's own identity fields — the person is KEYED on these when it has no person yet. */
  survivorIdentity: PersonIdentityInput
  /** The duplicate record's identity — used only when the survivor's identity cannot clear the gate. */
  recordIdentity?: PersonIdentityInput | null
}

export type ResolveSurvivorPersonResult =
  | { ok: true; personId: string; created: boolean; via: "survivor_evidence" | "survivor_identity" | "record_identity"; identity: NormalizedPersonIdentity | null }
  | { ok: false; reason: string }

/**
 * R2 (wave 102.1): two emails are two persons UNTIL a dedup verdict says otherwise. A verdict
 * "<record> is a duplicate of <survivor>" links the record onto the SURVIVOR's person — found by the
 * survivor's existing evidence first, else resolved (find or create) from the SURVIVOR's identity,
 * else from the record's own — so a re-spelled or second email never mints a second person for a
 * record the pipeline already judged to be the same human. The gate key itself is unchanged.
 */
export async function resolveSurvivorPerson(client: Client, params: ResolveSurvivorPersonParams): Promise<ResolveSurvivorPersonResult> {
  const brokerageId = params.brokerageId ?? null
  if (!brokerageId) return { ok: false, reason: "no_tenant" }
  const existing = await personViewFor(client, brokerageId, params.survivor.entityType, params.survivor.entityId)
  if (!existing.ok) return { ok: false, reason: existing.reason }
  if (existing.view) {
    return { ok: true, personId: existing.view.person.id, created: false, via: "survivor_evidence", identity: normalizePersonIdentity(params.survivorIdentity) }
  }
  const bySurvivor = await resolvePerson(client, { brokerageId, ...params.survivorIdentity })
  if (bySurvivor.ok) return { ok: true, personId: bySurvivor.personId, created: bySurvivor.created, via: "survivor_identity", identity: bySurvivor.identity }
  if (bySurvivor.reason !== "no_identity_anchor") return { ok: false, reason: bySurvivor.reason }
  if (!params.recordIdentity) return { ok: false, reason: "no_identity_anchor" }
  const byRecord = await resolvePerson(client, { brokerageId, ...params.recordIdentity })
  if (!byRecord.ok) return byRecord
  return { ok: true, personId: byRecord.personId, created: byRecord.created, via: "record_identity", identity: byRecord.identity }
}

// ─── Pure summary for agent-facing surfaces ─────────────────────────────────────────────────────

export interface PersonEvidenceSummary {
  personId: string
  /** 0..1 — the strongest method's score, lifted by corroborating rows; never a guess above 1. */
  confidence: number
  evidenceCount: number
  /** Chokepoints that contributed ('pipeline_processor', 'history_carry', …), deduplicated. */
  sources: string[]
  /** Linked entity kinds and counts ('lead': 2, 'raw_scraped_lead': 3 …). */
  linked: Partial<Record<PersonEntityType, number>>
  /** Human lines: how we know this is the same person. No cost key ever (CLAUDE.md §5). */
  how: string[]
  convertedAt: string | null
}

const METHOD_LABEL: Record<PersonMatchMethod, string> = {
  identity_gate: "same name and email",
  email_exact: "same email",
  phone_corroborated: "same email, phone agrees",
  dedup_match: "dedup match",
  promotion_link: "promoted lead → contact",
  contact_merge: "merged contact",
  capture_match: "captured by email",
}

const COST_KEY = /cost|spend|usd|price|budget/i

/**
 * PURE — fold a person's evidence into the agent-facing summary. Strips every cost key from any
 * detail it would surface (none is surfaced; the rule is asserted so a future detail cannot leak).
 * @proofSeam the proof asserts the no-cost rule and the confidence fold directly.
 */
export function summarizePersonEvidence(view: PersonView): PersonEvidenceSummary {
  const linked: Partial<Record<PersonEntityType, number>> = {}
  const sources = new Set<string>()
  let best = 0
  let corroborating = 0
  const how: string[] = []
  for (const e of view.evidence) {
    linked[e.entity_type] = (linked[e.entity_type] ?? 0) + 1
    if (e.source) sources.add(e.source)
    const s = Number(e.match_score) || 0
    if (s > best) best = s
    else if (s >= 0.75) corroborating++
    const safeDetail = e.detail ? Object.fromEntries(Object.entries(e.detail).filter(([k]) => !COST_KEY.test(k))) : null
    const stage = safeDetail && typeof safeDetail.stage === "string" ? ` at ${safeDetail.stage}` : ""
    how.push(`${e.entity_type.replace(/_/g, " ")} — ${METHOD_LABEL[e.match_method] ?? e.match_method}${stage} (${Math.round(s * 100)}%)`)
  }
  const confidence = Math.min(1, best + Math.min(0.1, corroborating * 0.025))
  return {
    personId: view.person.id,
    confidence: Number(confidence.toFixed(3)),
    evidenceCount: view.evidence.length,
    sources: [...sources].sort(),
    linked,
    how,
    convertedAt: view.person.converted_at ?? null,
  }
}
