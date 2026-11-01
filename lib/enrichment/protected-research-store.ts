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
//   · ACCESS: service-role writes only (this module). READS go through `readProtectedAttributes` below — role × purpose ×
//     scope, ledgered both ways (wave 148, lane 148C: the owner named the roles; m914 retires the unaudited direct SELECT policy
//     so the ledgered reader is the only read path). The retention period is still the owner's decision.
//   · NEVER COPIED: no value here is copied onto `contacts`, `enrichment_profile`, a stored persona, a segment or an audience. The
//     persona study (lib/contacts/persona-builder.ts derivePersona, purpose persona_derivation) READS it to shape the person's
//     SERVICE profile; its marketing output is firewalled (lib/contacts/persona-layers.ts) so no protected value or proxy reaches a
//     marketing persona. No ads / targeting / dispatch / eligibility module may import this file or name its table
//     (scripts/lifetime-signals-guard.ts + scripts/persona-compliance-guard.ts, with positive controls). Matching / append (this)
//     is a different act from ad activation (lib/kernel/ads.ts, which refuses protected segmentation at the act —
//     lib/lead-governance/protected-class-signals.ts).
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
// WIDENED BY ROLE × PURPOSE (wave 148, lane 148C; owner ruling 1, 2026-11-01)
// ═════════════════════════════════════════════════════════════════════════════
//
// OWNER RULING (wave 147), verbatim: "Only worry about protected class blocking during the post/ad writing. Release all of the
// protected class blocking so that the data is added to the lead or contact fields so they can be read for researching."
// OWNER RULING (wave 148), verbatim: "the read of protected or prohibited can be used to determine the person's persona so users
// can create ads and posts, etc. around that persona. The admin, platform, agent, team lead, broker, compliance, support, etc.
// should be able to read."
//
// WHAT CHANGED (148C) — the reader was the survivor; it is WIDENED, not twinned:
//   · WHO: every role the owner named now has a door — but each through the PURPOSE its work needs (least privilege by purpose)
//     and within the SCOPE its seat reaches (least privilege by scope): an agent reads only contacts assigned to them, a team lead
//     only their team's, tenant roles their tenant, platform staff any tenant WITH a written justification. The matrix is
//     PROTECTED_READ_MATRIX below and the notes' "Role × purpose matrix" is generated from the same table.
//   · TENANT: the reader no longer trusts the caller to have bound the tenant. A tenant seat must carry its SESSION brokerage and
//     it must equal the request's (`tenant_unverified` / `not_in_tenant` otherwise); platform staff sit above tenants and must say
//     why they are reading (`justification_required`).
//   · DATA RIGHTS: the service purposes (customer_service, persona_derivation) read only values held under a classified right
//     (a provider licence, a first-party statement, a public-web source); an unclassified / unknown source is WITHHELD (named,
//     never its value).
//   · FIELD MINIMISATION: customer_service returns only what a person TOLD us they need to be served (a self-identified language
//     or accessibility attribute); every other field is named in `withheld`, never valued.
//   · AUDIT: both outcomes stay on the action ledger, now with the role class, the scope basis and the justification — field
//     NAMES and counts, never a value.
//   · NEW PURPOSES: customer_service, persona_derivation (the persona study — lib/contacts/persona-builder.ts derivePersona — whose
//     OUTPUT is firewalled in lib/contacts/persona-layers.ts so no protected value or proxy reaches a marketing persona or an
//     audience), support_investigation.
//   · UNCHANGED: the PROHIBITED purposes are refused whoever asks (ad audience / targeting, steering, eligibility, scoring,
//     outreach targeting); an unrecognised purpose is refused (fail closed); platform `marketing` staff read nothing (marketing
//     is the act fair housing restricts — the owner named "platform", and the platform seats that need this are admin + support).

export const PROTECTED_RESEARCH_READ_PURPOSES = [
  "research", "compliance_audit", "data_subject_request", "customer_service", "persona_derivation", "support_investigation",
] as const
export type ProtectedResearchReadPurpose = (typeof PROTECTED_RESEARCH_READ_PURPOSES)[number]

/** Uses that may NEVER read a protected attribute, whoever asks (ruling 2: protected traits never select an audience, steer,
 *  decide eligibility, score, or target outreach). */
const PROHIBITED_PROTECTED_READ_PURPOSES = ["ad_audience", "ad_targeting", "steering", "eligibility", "scoring", "outreach_targeting"] as const

/** Research readers: the tenant-admin roster minus team_lead and admin (CLAUDE.md §4 — derive by named subtraction, never copy). */
const ROLES_HELD_OUT_OF_PROTECTED_RESEARCH: ReadonlySet<string> = new Set(["team_lead", "admin"])
export const PROTECTED_RESEARCH_READER_USER_TYPES: ReadonlySet<string> = new Set(
  [...TENANT_ADMIN_USER_TYPES].filter((t) => !ROLES_HELD_OUT_OF_PROTECTED_RESEARCH.has(t)),
)

/** The reader's role CLASS — resolved from the session seat (users.user_type / users.platform_role), or `system` for the
 *  autonomous persona study acting for one tenant. */
/**
 * THE READER CLASSES — derived from users.user_type and users.platform_role by readerRoleOf, never a roster of their own
 * (CLAUDE.md §6; scripts/admin-vocabulary-simulator.ts recognises this list by derivation). Where a class IS one user_type it
 * carries that word (`admin`, `compliance_officer`, `agent`, `team_lead`, `system`); `broker` is the brokerage tier
 * (broker / broker_admin / broker_owner); the three prefixed classes exist only because `support` is a word in BOTH columns
 * (users.user_type 'support' = tenant support staff, users.platform_role 'support' = platform support) and the platform's
 * admin class spans two platform_role values (superadmin, admin).
 */
export const PROTECTED_READER_ROLES = ["platform_admin", "platform_support", "broker", "compliance_officer", "admin", "team_lead", "agent", "tenant_support", "system"] as const
export type ProtectedReaderRole = (typeof PROTECTED_READER_ROLES)[number]
/** How far a role's read reaches: `assigned` = contacts.agent_id is the reader's agents row; `team` = the contact is on a team the
 *  reader leads (teams.team_lead_id → users) or is their own; `tenant` = the session brokerage; `platform` = any tenant, with a
 *  justification; `system` = the one tenant the autonomous study runs for. */
export type ProtectedReadScope = "assigned" | "team" | "tenant" | "platform" | "system"

/**
 * THE ROLE × PURPOSE MATRIX (owner ruling 1). A role absent from a purpose's row is refused (`role_not_admitted`). Every row is a
 * least-privilege decision recorded in the lane notes ("Role × purpose matrix"):
 *   research / compliance_audit — the PROTECTED_RESEARCH_READER_USER_TYPES roster (broker tier + compliance) and platform admins;
 *   data_subject_request        — the tenant-admin roster (the DSR fulfilment gate already ran) and platform admin / support;
 *   customer_service            — the seats that serve the person, each within its scope (field-minimised: accommodations only);
 *   persona_derivation          — the seats that market to the person, each within its scope, and the autonomous study;
 *   support_investigation       — support seats (tenant + platform) and platform admins, always with a justification.
 */
export const PROTECTED_READ_MATRIX: Readonly<Record<ProtectedResearchReadPurpose, Readonly<Partial<Record<ProtectedReaderRole, ProtectedReadScope>>>>> = Object.freeze({
  research: { broker: "tenant", compliance_officer: "tenant", platform_admin: "platform" },
  compliance_audit: { broker: "tenant", compliance_officer: "tenant", platform_admin: "platform" },
  data_subject_request: { broker: "tenant", compliance_officer: "tenant", admin: "tenant", team_lead: "tenant", platform_admin: "platform", platform_support: "platform" },
  customer_service: { agent: "assigned", team_lead: "team", broker: "tenant", admin: "tenant", compliance_officer: "tenant", tenant_support: "tenant", platform_support: "platform" },
  persona_derivation: { agent: "assigned", team_lead: "team", broker: "tenant", admin: "tenant", compliance_officer: "tenant", system: "system" },
  support_investigation: { tenant_support: "tenant", platform_support: "platform", platform_admin: "platform" },
})

/** Purposes that read only values held under a CLASSIFIED data right (the service purposes — a study or a service decision
 *  must not rest on a value whose right to use is unknown). Research / audit / DSR / investigation see everything held. */
const RIGHTS_GATED_PURPOSES: ReadonlySet<ProtectedResearchReadPurpose> = new Set(["customer_service", "persona_derivation"])
/** customer_service is FIELD-MINIMISED to what the person told us they need to be served. */
const SERVICE_ACCOMMODATION_CLASSES: ReadonlySet<string> = new Set(["language", "disability_health"])
const JUSTIFICATION_MIN_CHARS = 12

/** PURE — the reader's role class from the session seat. Platform `marketing` resolves to null on purpose (see header). */
function readerRoleOf(actor: ProtectedAttributeReadRequest["actor"]): ProtectedReaderRole | null {
  if (!actor.userId && !actor.userType && !actor.platformRole && actor.systemSource) return "system"
  const pr = actor.platformRole ?? null
  if (isPlatformStaffRole(pr)) return pr === "support" ? "platform_support" : pr === "marketing" ? null : "platform_admin"
  const t = String(actor.userType ?? "")
  if (t === "compliance_officer") return "compliance_officer"
  if (t === "team_lead") return "team_lead"
  if (t === "admin") return "admin"
  if (t === "agent") return "agent"
  if (t === "support") return "tenant_support"
  if (PROTECTED_RESEARCH_READER_USER_TYPES.has(t)) return "broker" // the roster minus the classes named above = the broker tier
  return null
}

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
const CLASSIFIED_RIGHTS = /^(provider_licensed|first_party|public_web):/

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

/** PURE — why this purpose may not see this value (null = it may). Field minimisation + data rights, per purpose. */
function withholdReasonFor(purpose: ProtectedResearchReadPurpose, e: AttributeAccessEnvelope): string | null {
  if (RIGHTS_GATED_PURPOSES.has(purpose) && !CLASSIFIED_RIGHTS.test(e.dataRights)) {
    return `held under ${e.dataRights} — a ${purpose.replace(/_/g, " ")} read uses only values whose right to use is classified`
  }
  if (purpose === "customer_service" && !(e.basis === "self_identified" && SERVICE_ACCOMMODATION_CLASSES.has(String(e.protectedClass ?? "")))) {
    return "customer service reads only what the person told us they need to be served (a self-identified language or accessibility attribute)"
  }
  return null
}

export interface ProtectedAttributeReadRequest {
  brokerageId: string
  contactId: string
  purpose: string
  /** WHY this read — required for platform staff (they sit above tenants) and for every support_investigation. Ledgered. */
  purposeNote?: string | null
  /** The SESSION-verified reader. `userType` is users.user_type; `platformRole` users.platform_role; `brokerageId` the SESSION
   *  brokerage (users.brokerage_id — never a body field). `systemSource` names the autonomous caller when no user acts. */
  actor: { userId: string | null; userType: string | null; platformRole?: string | null; brokerageId?: string | null; systemSource?: string | null }
}

export type ProtectedReadRefusal =
  | "prohibited_purpose" | "unknown_purpose" | "role_not_admitted" | "not_in_tenant" | "tenant_unverified" | "out_of_scope"
  | "justification_required" | "unreadable"

export type ProtectedAttributeRead =
  | {
      ok: true
      purpose: ProtectedResearchReadPurpose
      role: ProtectedReaderRole
      scope: ProtectedReadScope
      attributes: AttributeAccessEnvelope[]
      /** Fields this purpose may not see — NAMED with the reason, never valued. */
      withheld: Array<{ field: string; protectedClass: string | null; reason: string }>
      evidenced: boolean
    }
  | { ok: false; refused: ProtectedReadRefusal; reason: string; evidenced: boolean; role?: ProtectedReaderRole | null }

type Verdict =
  | { allowed: true; purpose: ProtectedResearchReadPurpose; role: ProtectedReaderRole; scope: ProtectedReadScope }
  | { allowed: false; refused: ProtectedReadRefusal; reason: string; role: ProtectedReaderRole | null }

/** The purpose → role → tenant → justification verdict (PURE). Scope (assigned / team) is resolved against the rows next. */
function protectedReadVerdict(req: ProtectedAttributeReadRequest): Verdict {
  const purpose = String(req.purpose ?? "").trim()
  const role = readerRoleOf(req.actor)
  if ((PROHIBITED_PROTECTED_READ_PURPOSES as readonly string[]).includes(purpose)) {
    return { allowed: false, role, refused: "prohibited_purpose", reason: `protected attributes are never read for ${purpose} — fair housing forbids protected traits or proxies in audience selection, steering, eligibility or targeting` }
  }
  if (!(PROTECTED_RESEARCH_READ_PURPOSES as readonly string[]).includes(purpose)) {
    return { allowed: false, role, refused: "unknown_purpose", reason: `"${purpose || "(none)"}" is not a research purpose — refused (a gate that cannot tell the use never passes)` }
  }
  const p = purpose as ProtectedResearchReadPurpose
  const scope = role ? PROTECTED_READ_MATRIX[p][role] : undefined
  if (!role || !scope) {
    const who = req.actor.platformRole === "marketing" ? "platform marketing staff" : String(req.actor.userType ?? "") || (req.actor.platformRole ? `platform ${req.actor.platformRole}` : "an unidentified reader")
    return { allowed: false, role, refused: "role_not_admitted", reason: `${who} may not read protected research attributes for ${p}` }
  }
  if (scope === "platform") {
    if (String(req.purposeNote ?? "").trim().length < JUSTIFICATION_MIN_CHARS) {
      return { allowed: false, role, refused: "justification_required", reason: `platform staff read a tenant's protected attributes only with a written justification (≥ ${JUSTIFICATION_MIN_CHARS} characters) — it is ledgered with the read` }
    }
  } else {
    const sessionTenant = String(req.actor.brokerageId ?? "").trim()
    if (!sessionTenant) return { allowed: false, role, refused: "tenant_unverified", reason: "the reader's session brokerage was not supplied — a tenant read is never bound from the request alone (fail closed)" }
    if (sessionTenant !== req.brokerageId) return { allowed: false, role, refused: "not_in_tenant", reason: "the reader's session brokerage is not this contact's brokerage" }
  }
  if (p === "support_investigation" && String(req.purposeNote ?? "").trim().length < JUSTIFICATION_MIN_CHARS) {
    return { allowed: false, role, refused: "justification_required", reason: `a support investigation names its case (≥ ${JUSTIFICATION_MIN_CHARS} characters, e.g. the ticket) — ledgered with the read` }
  }
  return { allowed: true, purpose: p, role, scope }
}

/** Resolve an `assigned` / `team` scope against the rows (service client, tenant-pinned). Tenant / platform / system pass. */
async function scopeAdmits(
  svc: Svc,
  req: ProtectedAttributeReadRequest,
  scope: ProtectedReadScope,
): Promise<{ ok: true } | { ok: false; refused: "out_of_scope" | "not_in_tenant" | "unreadable"; reason: string }> {
  if (scope !== "assigned" && scope !== "team") return { ok: true }
  if (!req.actor.userId) return { ok: false, refused: "out_of_scope", reason: "an assigned / team read needs the reader's session user" }
  const { data: contact, error: cErr } = await svc.from("contacts").select("id, agent_id, team_id").eq("id", req.contactId).eq("brokerage_id", req.brokerageId).maybeSingle()
  if (cErr) return { ok: false, refused: "unreadable", reason: `contact scope read refused: ${cErr.message}` }
  if (!contact) return { ok: false, refused: "not_in_tenant", reason: "contact not in this tenant" }
  // agents.id and users.id are DISJOINT (CLAUDE.md §3) — cross via agents.user_id.
  const { data: own, error: aErr } = await svc.from("agents").select("id").eq("user_id", req.actor.userId).eq("brokerage_id", req.brokerageId)
  if (aErr) return { ok: false, refused: "unreadable", reason: `reader agent read refused: ${aErr.message}` }
  const ownAgentIds = new Set(((own ?? []) as Array<{ id: string }>).map((a) => a.id))
  const c = contact as { agent_id?: string | null; team_id?: string | null }
  if (c.agent_id && ownAgentIds.has(c.agent_id)) return { ok: true }
  if (scope === "team") {
    const { data: led, error: tErr } = await svc.from("teams").select("id").eq("brokerage_id", req.brokerageId).eq("team_lead_id", req.actor.userId)
    if (tErr) return { ok: false, refused: "unreadable", reason: `led-team read refused: ${tErr.message}` }
    if (c.team_id && ((led ?? []) as Array<{ id: string }>).some((t) => t.id === c.team_id)) return { ok: true }
    return { ok: false, refused: "out_of_scope", reason: "a team lead reads only contacts on a team they lead (teams.team_lead_id) or their own" }
  }
  return { ok: false, refused: "out_of_scope", reason: "an agent reads only contacts assigned to them (contacts.agent_id)" }
}

/**
 * Read one contact's protected attributes for an admitted purpose. Never throws. Both outcomes are ledgered (evidenced: false
 * means the ledger could not record it — said, not hidden). The service client is the caller's AFTER its session gate; the
 * tenant, the role and the scope are re-checked HERE (the reader no longer trusts the caller to have bound them).
 */
export async function readProtectedAttributes(
  svc: Svc,
  req: ProtectedAttributeReadRequest,
  opts: { ledgerClient?: Svc; now?: Date } = {},
): Promise<ProtectedAttributeRead> {
  const first = protectedReadVerdict(req)
  let verdict: Verdict = first
  if (first.allowed) {
    const sc = await scopeAdmits(svc, req, first.scope).catch((e) => ({ ok: false as const, refused: "unreadable" as const, reason: `threw: ${e instanceof Error ? e.message : String(e)}` }))
    if (!sc.ok) verdict = { allowed: false, refused: sc.refused, reason: sc.reason, role: first.role }
  }
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  const role = verdict.role
  const ledgerCtx = {
    brokerageId: req.brokerageId,
    actor: { type: (req.actor.userId ? "user" : "system") as "user" | "system", userId: req.actor.userId },
    subject: { type: "contact", id: req.contactId },
    reasonCode: "COMPLIANCE_NOTICE",
    riskClass: "READ",
    systemSource: req.actor.systemSource ? `protected_research_reader:${req.actor.systemSource}` : "protected_research_reader",
  }
  const auditDetail = {
    purpose: req.purpose, role_class: role, user_type: req.actor.userType ?? null, platform_role: req.actor.platformRole ?? null,
    justification: req.purposeNote ? String(req.purposeNote).slice(0, 300) : null, system_source: req.actor.systemSource ?? null,
  }
  if (!verdict.allowed) {
    const refusal = verdict
    let evidenced = false
    await withActionLedger(
      { ...ledgerCtx, action: "research.protected_attribute.refuse", reasonDetail: refusal.reason.slice(0, 500), detail: { ...auditDetail, refused: refusal.refused } },
      async () => { evidenced = true; return refusal },
      // WAVE 147 (147Z — census II.2): a refusal the ledger could not record is NOT evidenced — said, never assumed.
      { settle: () => ({ status: "skipped", outcome: `refused:${refusal.refused}` }), replay: (claim) => { if (claim.kind === "refused") evidenced = false; return refusal } },
      { client: opts.ledgerClient ?? svc },
    ).catch(() => { evidenced = false })
    return { ok: false, refused: refusal.refused, reason: refusal.reason, evidenced, role }
  }

  const granted = verdict
  let evidenced = false
  const result = await withActionLedger<ProtectedAttributeRead>(
    { ...ledgerCtx, action: "research.protected_attribute.read", reasonDetail: `protected attributes read for ${granted.purpose} (${granted.role}, ${granted.scope} scope)`, detail: { ...auditDetail, purpose: granted.purpose, scope: granted.scope } },
    async () => {
      evidenced = true
      try {
        const { data: contact, error: cErr } = await svc.from("contacts").select("*").eq("id", req.contactId).eq("brokerage_id", req.brokerageId).maybeSingle()
        if (cErr) return { ok: false, refused: "unreadable", reason: `contact read refused: ${cErr.message}`, evidenced, role: granted.role }
        if (!contact) return { ok: false, refused: "not_in_tenant", reason: "contact not in this tenant", evidenced, role: granted.role }
        const row = contact as Record<string, unknown>
        const stamps = fieldProvenanceForDisplay((row.enrichment_profile ?? null) as Record<string, unknown> | null, { includeFinancials: true })
        const all: AttributeAccessEnvelope[] = []
        // (1) the protected-class COLUMNS on the contact (BatchData / PeopleData demographics, stored with their stamp).
        for (const [col, value] of Object.entries(row)) {
          if (value === null || value === undefined || value === "") continue
          if (!protectedClassReasonFor(col)) continue
          all.push(attributeAccessEnvelope({ field: col, value, provenance: stamps[col] ?? null, now: opts.now }))
        }
        // (2) the segregated research rows (m864) — vendor-modeled, with their own provenance.
        const { data: held, error: hErr } = await svc.from(TABLE)
          .select("source_field, attribute_value, attribute_class, basis, provider, capability, match_confidence, retrieved_at")
          .eq("brokerage_id", req.brokerageId).eq("contact_id", req.contactId)
        if (hErr) return { ok: false, refused: "unreadable", reason: `research store read refused: ${hErr.message}`, evidenced, role: granted.role }
        for (const r of (held ?? []) as Array<Record<string, string | null>>) {
          all.push(attributeAccessEnvelope({
            field: String(r.source_field), value: r.attribute_value, protectedClass: r.attribute_class, basis: r.basis, now: opts.now,
            provenance: { source: String(r.provider ?? "unknown"), capability: r.capability ?? null, retrievedAt: r.retrieved_at ?? null, matchConfidence: r.match_confidence ?? null, purpose: "enrichment", actor: null },
          }))
        }
        const attributes: AttributeAccessEnvelope[] = []
        const withheld: Array<{ field: string; protectedClass: string | null; reason: string }> = []
        for (const e of all) {
          const why = withholdReasonFor(granted.purpose, e)
          if (why) withheld.push({ field: e.field, protectedClass: e.protectedClass, reason: why })
          else attributes.push(e)
        }
        return { ok: true, purpose: granted.purpose, role: granted.role, scope: granted.scope, attributes, withheld, evidenced }
      } catch (e) {
        return { ok: false, refused: "unreadable", reason: `threw: ${e instanceof Error ? e.message : String(e)}`, evidenced, role: granted.role }
      }
    },
    {
      settle: (r) => r.ok
        ? { status: "executed", outcome: `read:${r.attributes.length} withheld:${r.withheld.length}`, provider: "protected_research_store" }
        : { status: "failed", outcome: r.refused, error: r.reason },
      // WAVE 147 (147Z — census II.2): fail CLOSED on every non-acting claim — and name WHICH (a refused ledger vs a replay).
      replay: (claim) => ({ ok: false, refused: "unreadable", reason: claim.kind === "refused" ? `the action ledger refused this read (${claim.error}) — nothing was read (fail closed)` : "the ledger did not admit this read (already recorded / in flight) — nothing was read", evidenced: false, role: granted.role }),
    },
    { client: opts.ledgerClient ?? svc },
  )
  return { ...result, evidenced } as ProtectedAttributeRead
}
