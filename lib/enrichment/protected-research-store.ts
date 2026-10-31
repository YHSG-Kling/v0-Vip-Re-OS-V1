// lib/enrichment/protected-research-store.ts
//
// THE SEGREGATED RESEARCH HOME — writer (wave 145, lane 145F; owner ruling 12: "There should be no protected fair housing protected
// attributes holding back any enrichment syncing as it is a major road block when needing that research.").
//
// Enrichment syncing proceeds; the protected / sensitive fields a provider returns are STORED — never dropped, never exposed:
//   · STORE: public.protected_research_attributes (m864) — one row per (contact, provider, the vendor's verbatim field), with the
//     protected class it bears, the BASIS (Versium's are vendor-MODELED — never a self-identified fact), the provenance (provider,
//     capability, retrieved_at, match confidence) and first-observed / value-changed stamps (a re-capture of an unchanged value
//     moves retrieved_at only — the field / provenance CHANGE is what is dated, ruling 11's grain).
//   · ACCESS: RLS — service-role writes only (this module), SELECT for platform staff or a same-tenant compliance_officer (the
//     existing access-control helpers). The roles and the retention period are the owner's decision (Still open in the lane notes).
//   · NEVER EXPOSED: nothing here is copied onto `contacts`, `enrichment_profile`, a persona, a segment or a prompt; no ads /
//     targeting / dispatch / eligibility module may import this file or name its table (scripts/lifetime-signals-guard.ts, with a
//     positive control). Matching / append (this) is a different act from ad activation (lib/kernel/ads.ts, which refuses protected
//     segmentation at the act — lib/lead-governance/protected-class-signals.ts).
// Safe write: tenant-anchored (the contact is read by id AND brokerage_id first), every `{ error }` read, every write COUNTED.
// Never throws.

import type { VersiumProtectedResearchField } from "@/lib/external/versium-client"
import { fieldProvenanceForDisplay, type FieldProvenance, type FieldProvenanceLine } from "@/lib/lead-pipeline/enrichment-column-map"
import { protectedClassReasonFor } from "@/lib/lead-governance/protected-class-signals"
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
import { isPlatformStaffRole } from "@/lib/platform/platform-staff-roster"

type Svc = { from: (table: string) => any }

const TABLE = "protected_research_attributes"

/**
 * The store's own transfer class (owner ruling 24 × ruling 12 — wave 145, lane 145Z). The brokerage-transfer rail must NOT name
 * this table (the firewall above), so the store declares its class itself: derived_readonly — vendor-modeled research held under
 * the SOURCE tenant's access control and provenance; never moved or copied across accounts; the adopting tenant re-enriches
 * gap-only under its own provider account. scripts/transfer-classification-guard.ts counts it in the FK-child census.
 * @proofSeam read only by scripts/transfer-classification-guard.ts (no runtime reader — the rail never touches the table).
 */
export const PROTECTED_RESEARCH_TRANSFER_CLASS = Object.freeze({
  table: TABLE,
  cls: "derived_readonly" as const,
  rule: "RESEARCH-ONLY PROTECTED ATTRIBUTES (ruling 12) — vendor-modeled, held under the source tenant's access control and provenance for authorized research; never moved or copied across accounts (the target re-enriches gap-only under its own provider account); self-declared by its firewalled store",
})

export interface ProtectedResearchWrite {
  ok: boolean
  inserted: number
  changed: number
  unchanged: number
  error?: string
}

/**
 * Store one paid row's protected fields for ONE contact of ONE tenant. Idempotent per (contact, provider, field): an unchanged
 * value re-stamps retrieved_at; a changed value also moves value_changed_at; a new field is inserted with its provenance.
 */
export async function persistProtectedResearch(
  svc: Svc,
  target: { contactId: string; brokerageId: string },
  fields: readonly VersiumProtectedResearchField[],
  provenance: Pick<FieldProvenance, "source" | "capability" | "retrievedAt" | "matchConfidence"> | null,
  opts: { now?: Date } = {},
): Promise<ProtectedResearchWrite> {
  const res: ProtectedResearchWrite = { ok: true, inserted: 0, changed: 0, unchanged: 0 }
  if (fields.length === 0) return res
  if (!target.contactId || !target.brokerageId) return { ...res, ok: false, error: "contactId and brokerageId are both required" }
  if (!provenance) return { ...res, ok: false, error: "no provenance — a research row is never stored without its source" }
  try {
    const now = (opts.now ?? new Date()).toISOString()
    // Tenant anchor: the contact must be THIS brokerage's (the service client bypasses RLS; the predicate is the gate).
    const { data: contact, error: cErr } = await svc.from("contacts").select("id").eq("id", target.contactId).eq("brokerage_id", target.brokerageId).maybeSingle()
    if (cErr) return { ...res, ok: false, error: `contact read refused: ${cErr.message}` }
    if (!contact) return { ...res, ok: false, error: "contact not in this tenant" }

    // What is already held for this contact from this provider — the CHANGE is what gets dated.
    const { data: held, error: hErr } = await svc.from(TABLE).select("id, source_field, attribute_value")
      .eq("brokerage_id", target.brokerageId).eq("contact_id", target.contactId).eq("provider", provenance.source)
    if (hErr) return { ...res, ok: false, error: `research read refused: ${hErr.message}` }
    const byField = new Map(((held ?? []) as Array<{ id: string; source_field: string; attribute_value: string }>).map((r) => [r.source_field, r]))

    for (const f of fields) {
      const prior = byField.get(f.sourceField)
      if (!prior) {
        const { data, error } = await svc.from(TABLE).insert({
          brokerage_id: target.brokerageId, contact_id: target.contactId, provider: provenance.source, capability: provenance.capability,
          source_field: f.sourceField, attribute_value: f.value, attribute_class: f.protectedClass, basis: f.basis, purpose: "research",
          match_confidence: provenance.matchConfidence ?? null, retrieved_at: provenance.retrievedAt, first_observed_at: now, value_changed_at: now,
        }).select("id")
        if (error) return { ...res, ok: false, error: `research insert refused (${f.sourceField}): ${error.message}` }
        if ((data ?? []).length !== 1) return { ...res, ok: false, error: `research insert wrote ${(data ?? []).length} rows (${f.sourceField})` }
        res.inserted++
        continue
      }
      const changed = prior.attribute_value !== f.value
      const patch: Record<string, unknown> = { retrieved_at: provenance.retrievedAt, match_confidence: provenance.matchConfidence ?? null, capability: provenance.capability, updated_at: now }
      if (changed) Object.assign(patch, { attribute_value: f.value, attribute_class: f.protectedClass, value_changed_at: now })
      const { data, error } = await svc.from(TABLE).update(patch).eq("id", prior.id).eq("brokerage_id", target.brokerageId).select("id")
      if (error) return { ...res, ok: false, error: `research update refused (${f.sourceField}): ${error.message}` }
      if ((data ?? []).length !== 1) return { ...res, ok: false, error: `research update matched ${(data ?? []).length} rows (${f.sourceField})` }
      if (changed) res.changed++
      else res.unchanged++
    }
    return res
  } catch (e) {
    return { ...res, ok: false, error: `threw: ${e instanceof Error ? e.message : String(e)}` }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// THE PURPOSE-GATED READER — the missing half (wave 147, lane 147A; owner ruling 2, 2026-10-31)
// ═════════════════════════════════════════════════════════════════════════════
//
// OWNER RULING, verbatim: "Only worry about protected class blocking during the post/ad writing. Release all of the protected
// class blocking so that the data is added to the lead or contact fields so they can be read for researching."
//
// WHAT WAS MEASURED AT 4d527cc3: ingestion already RELEASES (the wave-15 / wave-145 rulings): every lawful provider attribute is
// stored — BatchData / PeopleData demographics on the contacts columns with a field_provenance stamp (enrichment-column-map.ts,
// the ONE writer), Versium's protected fields here (m864) — and the classifier LABELS, never strips, on every data lane
// (protected-class-signals.ts: the only refusing arm is the ad-audience act). What did NOT exist was a READER: m864 had a writer
// and RLS, and nothing in the product could read it for research — "stored, never readable" is the block the ruling releases.
//
// THE RULE THIS READER ENFORCES (at the read, where the use is known):
//   · RESEARCH purposes are admitted — `research`, `compliance_audit`, `data_subject_request` (the subject's own right to know).
//   · PROHIBITED purposes are refused whoever asks — ad audience / targeting, steering, eligibility, scoring, outreach targeting.
//     Fair-housing blocking at WRITE time stays in the public-copy / ad paths (lanes E/G, protected-class-signals.ts arm 3).
//   · An unrecognised purpose is refused (fail closed — a gate that cannot tell the use never passes).
//   · WHO: research / audit → a same-tenant compliance_officer or broker / broker_owner / broker_admin (the tenant-admin roster by
//     NAMED SUBTRACTION: minus team_lead, minus admin), or platform staff; a data-subject request → the tenant-admin roster (the
//     DSR fulfilment gate already ran). The actor is the caller's SESSION-verified identity, never a body field.
//   · EVIDENCE BOTH WAYS: a granted read is `research.protected_attribute.read` and a refusal `research.protected_attribute.refuse`
//     on the action ledger — field NAMES and counts, never a value.
//   · EVERY ATTRIBUTE comes back in its ACCESS ENVELOPE { provenance, confidence, freshness, data_rights, purposes, access_class }
//     derived from the stored stamp (one rule, no second store to drift).

export const PROTECTED_RESEARCH_READ_PURPOSES = ["research", "compliance_audit", "data_subject_request"] as const
export type ProtectedResearchReadPurpose = (typeof PROTECTED_RESEARCH_READ_PURPOSES)[number]

/** Uses that may NEVER read a protected attribute, whoever asks (ruling 2: protected traits never select an audience, steer,
 *  decide eligibility, score, or target outreach). */
const PROHIBITED_PROTECTED_READ_PURPOSES = ["ad_audience", "ad_targeting", "steering", "eligibility", "scoring", "outreach_targeting"] as const

/** Research readers: the tenant-admin roster minus team_lead and admin (CLAUDE.md §4 — derive by named subtraction, never copy). */
const ROLES_HELD_OUT_OF_PROTECTED_RESEARCH: ReadonlySet<string> = new Set(["team_lead", "admin"])
export const PROTECTED_RESEARCH_READER_USER_TYPES: ReadonlySet<string> = new Set(
  [...TENANT_ADMIN_USER_TYPES].filter((t) => !ROLES_HELD_OUT_OF_PROTECTED_RESEARCH.has(t)),
)

export type AttributeAccessClass = "protected_research" | "operational"

/** The envelope every attribute this reader returns travels in. */
export interface AttributeAccessEnvelope {
  field: string
  value: unknown
  provenance: Pick<FieldProvenanceLine, "source" | "capability" | "retrievedAt" | "purpose" | "actor"> | null
  confidence: string | null
  freshness: { retrievedAt: string | null; freshForDays: number | null; fresh: boolean | null }
  /** Under whose rights the value is held — a provider's licence (the tenant's account), a first-party statement, or unknown. */
  dataRights: string
  /** The uses this value may be READ for. */
  purposes: readonly string[]
  accessClass: AttributeAccessClass
  /** The protected class (m864 vocabulary) or the classifier's reason, when protected. */
  protectedClass: string | null
  basis: string | null
}

const PROVIDER_DATA_RIGHTS: Readonly<Record<string, string>> = {
  versium: "provider_licensed:versium", peopledata: "provider_licensed:peopledata", batchdata: "provider_licensed:batchdata",
  batchdata_skip_trace: "provider_licensed:batchdata", rentcast: "provider_licensed:rentcast", exa: "public_web:exa", zenrows: "public_web:zenrows",
  perplexity: "public_web:perplexity", staff: "first_party:staff_entered", contact: "first_party:self_service",
}
/** PURE — the rights class a value is held under, from its stored source. An unknown source says so. */
function dataRightsForSource(source: string | null | undefined, purpose?: string | null): string {
  const s = String(source ?? "").trim().toLowerCase()
  if (purpose === "conversation") return "first_party:stated_in_conversation"
  return PROVIDER_DATA_RIGHTS[s] ?? (s ? `unclassified:${s}` : "unknown")
}

/** Provider refresh windows in days (lib/enrichment/provider-dedup.ts PROVIDER_FRESHNESS_DAYS carries the profile families; a
 *  research row is re-stamped on every paid re-capture, so its window is the same provider's). */
const PROVIDER_FRESH_DAYS: Readonly<Record<string, number>> = { versium: 180, peopledata: 90 }

/** PURE — the access envelope of one attribute from its stored provenance stamp. */
function attributeAccessEnvelope(input: {
  field: string
  value: unknown
  provenance: FieldProvenanceLine | null
  protectedClass?: string | null
  basis?: string | null
  now?: Date
}): AttributeAccessEnvelope {
  const reason = input.protectedClass ?? protectedClassReasonFor(input.field)
  // This reader emits protected columns and research rows only; financial columns keep their own allowlisted path (CLAUDE.md §5 —
  // the credit-band firewall in test:enrichment-one-rail), so the class here is protected_research or operational.
  const accessClass: AttributeAccessClass = reason ? "protected_research" : "operational"
  const p = input.provenance
  const days = p ? PROVIDER_FRESH_DAYS[String(p.source).toLowerCase()] ?? null : null
  const at = p?.retrievedAt ?? null
  const ageDays = at ? ((input.now ?? new Date()).getTime() - new Date(at).getTime()) / 86_400_000 : null
  return {
    field: input.field,
    value: input.value,
    provenance: p ? { source: p.source, capability: p.capability, retrievedAt: p.retrievedAt, purpose: p.purpose, actor: p.actor } : null,
    confidence: p?.matchConfidence ?? null,
    freshness: { retrievedAt: at, freshForDays: days, fresh: days !== null && ageDays !== null && Number.isFinite(ageDays) ? ageDays >= 0 && ageDays <= days : null },
    dataRights: dataRightsForSource(p?.source ?? null, p?.purpose ?? null),
    purposes: accessClass === "protected_research" ? PROTECTED_RESEARCH_READ_PURPOSES : ["outreach", "service", ...PROTECTED_RESEARCH_READ_PURPOSES],
    accessClass,
    protectedClass: reason ?? null,
    basis: input.basis ?? null,
  }
}

export interface ProtectedAttributeReadRequest {
  brokerageId: string
  contactId: string
  purpose: string
  /** The SESSION-verified reader. `userType` is users.user_type; `platformRole` users.platform_role. */
  actor: { userId: string | null; userType: string | null; platformRole?: string | null }
}

export type ProtectedAttributeRead =
  | { ok: true; purpose: ProtectedResearchReadPurpose; attributes: AttributeAccessEnvelope[]; evidenced: boolean }
  | { ok: false; refused: "prohibited_purpose" | "unknown_purpose" | "role_not_admitted" | "not_in_tenant" | "unreadable"; reason: string; evidenced: boolean }

/** The purpose → refusal verdict (PURE). */
function protectedReadVerdict(req: Pick<ProtectedAttributeReadRequest, "purpose" | "actor">):
  { allowed: true; purpose: ProtectedResearchReadPurpose } | { allowed: false; refused: "prohibited_purpose" | "unknown_purpose" | "role_not_admitted"; reason: string } {
  const purpose = String(req.purpose ?? "").trim()
  if ((PROHIBITED_PROTECTED_READ_PURPOSES as readonly string[]).includes(purpose)) {
    return { allowed: false, refused: "prohibited_purpose", reason: `protected attributes are never read for ${purpose} — fair housing forbids protected traits or proxies in audience selection, steering, eligibility or targeting` }
  }
  if (!(PROTECTED_RESEARCH_READ_PURPOSES as readonly string[]).includes(purpose)) {
    return { allowed: false, refused: "unknown_purpose", reason: `"${purpose || "(none)"}" is not a research purpose — refused (a gate that cannot tell the use never passes)` }
  }
  const p = purpose as ProtectedResearchReadPurpose
  const type = String(req.actor.userType ?? "")
  const platform = isPlatformStaffRole(req.actor.platformRole ?? null)
  const admitted = platform || (p === "data_subject_request" ? TENANT_ADMIN_USER_TYPES.has(type) : PROTECTED_RESEARCH_READER_USER_TYPES.has(type))
  if (!admitted) return { allowed: false, refused: "role_not_admitted", reason: `${type || "an unidentified reader"} may not read protected research attributes for ${p}` }
  return { allowed: true, purpose: p }
}

/**
 * Read one contact's protected attributes for an admitted purpose. Never throws. Both outcomes are ledgered (evidenced: false
 * means the ledger could not record it — said, not hidden). The service client is the caller's AFTER its session gate.
 */
export async function readProtectedAttributes(
  svc: Svc,
  req: ProtectedAttributeReadRequest,
  opts: { ledgerClient?: Svc; now?: Date } = {},
): Promise<ProtectedAttributeRead> {
  const verdict = protectedReadVerdict(req)
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const ledgerCtx = {
    brokerageId: req.brokerageId,
    actor: { type: (req.actor.userId ? "user" : "system") as "user" | "system", userId: req.actor.userId },
    subject: { type: "contact", id: req.contactId },
    reasonCode: "COMPLIANCE_NOTICE",
    riskClass: "READ",
    systemSource: "protected_research_reader",
  }
  if (!verdict.allowed) {
    let evidenced = false
    await withActionLedger(
      { ...ledgerCtx, action: "research.protected_attribute.refuse", reasonDetail: verdict.reason.slice(0, 500), detail: { purpose: req.purpose, refused: verdict.refused, user_type: req.actor.userType ?? null } },
      async () => { evidenced = true; return verdict },
      // WAVE 147 (147Z — census II.2): a refusal the ledger could not record is NOT evidenced — said, never assumed.
      { settle: () => ({ status: "skipped", outcome: `refused:${verdict.refused}` }), replay: (claim) => { if (claim.kind === "refused") evidenced = false; return verdict } },
      { client: opts.ledgerClient ?? svc },
    ).catch(() => { evidenced = false })
    return { ok: false, refused: verdict.refused, reason: verdict.reason, evidenced }
  }

  let evidenced = false
  const result = await withActionLedger<ProtectedAttributeRead>(
    { ...ledgerCtx, action: "research.protected_attribute.read", reasonDetail: `protected attributes read for ${verdict.purpose}`, detail: { purpose: verdict.purpose, user_type: req.actor.userType ?? null } },
    async () => {
      evidenced = true
      try {
        const { data: contact, error: cErr } = await svc.from("contacts").select("*").eq("id", req.contactId).eq("brokerage_id", req.brokerageId).maybeSingle()
        if (cErr) return { ok: false, refused: "unreadable", reason: `contact read refused: ${cErr.message}`, evidenced }
        if (!contact) return { ok: false, refused: "not_in_tenant", reason: "contact not in this tenant", evidenced }
        const row = contact as Record<string, unknown>
        const stamps = fieldProvenanceForDisplay((row.enrichment_profile ?? null) as Record<string, unknown> | null, { includeFinancials: true })
        const attributes: AttributeAccessEnvelope[] = []
        // (1) the protected-class COLUMNS on the contact (BatchData / PeopleData demographics, stored with their stamp).
        for (const [col, value] of Object.entries(row)) {
          if (value === null || value === undefined || value === "") continue
          if (!protectedClassReasonFor(col)) continue
          attributes.push(attributeAccessEnvelope({ field: col, value, provenance: stamps[col] ?? null, now: opts.now }))
        }
        // (2) the segregated research rows (m864) — vendor-modeled, with their own provenance.
        const { data: held, error: hErr } = await svc.from(TABLE)
          .select("source_field, attribute_value, attribute_class, basis, provider, capability, match_confidence, retrieved_at")
          .eq("brokerage_id", req.brokerageId).eq("contact_id", req.contactId)
        if (hErr) return { ok: false, refused: "unreadable", reason: `research store read refused: ${hErr.message}`, evidenced }
        for (const r of (held ?? []) as Array<Record<string, string | null>>) {
          attributes.push(attributeAccessEnvelope({
            field: String(r.source_field), value: r.attribute_value, protectedClass: r.attribute_class, basis: r.basis, now: opts.now,
            provenance: { source: String(r.provider ?? "unknown"), capability: r.capability ?? null, retrievedAt: r.retrieved_at ?? null, matchConfidence: r.match_confidence ?? null, purpose: "enrichment", actor: null },
          }))
        }
        return { ok: true, purpose: verdict.purpose, attributes, evidenced }
      } catch (e) {
        return { ok: false, refused: "unreadable", reason: `threw: ${e instanceof Error ? e.message : String(e)}`, evidenced }
      }
    },
    {
      settle: (r) => r.ok
        ? { status: "executed", outcome: `read:${r.attributes.length}`, provider: "protected_research_store" }
        : { status: "failed", outcome: r.refused, error: r.reason },
      // WAVE 147 (147Z — census II.2): fail CLOSED on every non-acting claim — and name WHICH (a refused ledger vs a replay).
      replay: (claim) => ({ ok: false, refused: "unreadable", reason: claim.kind === "refused" ? `the action ledger refused this read (${claim.error}) — nothing was read (fail closed)` : "the ledger did not admit this read (already recorded / in flight) — nothing was read", evidenced: false }),
    },
    { client: opts.ledgerClient ?? svc },
  )
  return { ...result, evidenced } as ProtectedAttributeRead
}
