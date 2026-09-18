/**
 * lib/compliance/required-documents.ts
 *
 * Resolves the required-documents checklist for an offer + audits the deal
 * file against it. Used by submitOfferToCompliance before it advances the
 * offer to compliance.passed.
 *
 * Resolution cascade mirrors the e-sign / SMS / email provider resolver:
 *   agent_user → team → brokerage   (most-specific scope wins)
 *
 * The subscription tier determines which scope settings get used:
 *   - Sole-agent subscription → agent's own list
 *   - Team subscription       → team's list (agent rows under that team
 *                                may override individual classifications)
 *   - Brokerage subscription  → brokerage list (team / agent overrides
 *                                still allowed on top)
 *
 * The resolver returns the UNION of all rows visible to the offer's actor
 * (agent_user_id) — for any (classification, deal_type) pair, the most
 * specific scope's row wins (agent > team > brokerage). is_required +
 * block_on_missing flags from the winning row drive the audit.
 */

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * THE VOCABULARY LIVES IN lib/compliance/document-classifications.ts and is
 * re-exported here so every existing import keeps working. It moved because
 * this module is `import "server-only"` — a client picker cannot render a
 * classification choice without the label map, and it could not reach it
 * without dragging the audit + resolver into the browser bundle.
 *
 * That file MIRRORS the live CHECK on documents.classification AND
 * brokerage_required_documents.classification (m356).
 */
export {
  DOCUMENT_CLASSIFICATION_LABEL,
  SELLER_SIDE_CLASSIFICATIONS,
  ALL_DOCUMENT_CLASSIFICATIONS,
  SIGNATURE_BEARING_CLASSIFICATIONS,
  classificationCarriesSignatures,
  documentClassificationLabel,
} from "./document-classifications"
export type { DocumentClassification } from "./document-classifications"

import type { DocumentClassification } from "./document-classifications"

export interface ResolvedRequiredDoc {
  classification:    DocumentClassification
  scope:             "agent" | "team" | "brokerage"
  block_on_missing:  boolean
  description?:      string | null
  /** brokerage_form_library id of the blank template attached to the winning rule. */
  template_form_id?: string | null
}

export interface ResolveContext {
  brokerageId:   string
  agentUserId?:  string | null   // users.id of the deal's agent
  teamId?:       string | null
  dealType:      "buyer" | "seller" | "dual"
  stateCode?:    string | null
}

/**
 * The outcome of resolving the settings-administered checklist.
 *
 * WHY THIS IS A DISCRIMINATED RESULT AND NOT AN ARRAY. It used to return
 * `ResolvedRequiredDoc[]`, and it did not destructure `error` — so a REFUSED
 * read (RLS, a dropped column, a network fault) arrived as `data: null` and was
 * returned as `[]`, which every caller read as "this brokerage requires
 * nothing". A gate downstream then reported zero missing documents and PASSED.
 * That is the finding-#105 class — "documents_verified passes with zero
 * documents" — reappearing at the settings end of the same gate: the checklist
 * could not be read, and "nobody checked" rendered as "checked and fine"
 * (CLAUDE.md §4). `ok:false` now forces every caller to refuse instead.
 *
 * A read that RAN and returned zero rows is a DIFFERENT fact and stays `ok:true`
 * with an empty list — a brokerage that has configured no checklist requires
 * nothing, and refusing it would be an outage, not a compliance improvement.
 * Callers distinguish the two by `required_total` beside the verdict, exactly as
 * the listing gate already does.
 */
export type ResolveRequiredDocsOutcome =
  | { ok: true;  docs: ResolvedRequiredDoc[] }
  | { ok: false; docs: [];                   error: string }

export async function resolveRequiredDocuments(
  supabase: SupabaseClient,
  ctx: ResolveContext,
): Promise<ResolveRequiredDocsOutcome> {
  // A missing tenant anchor is NOT "nothing required" — it is a gate that cannot
  // run, and it must refuse.
  if (!ctx.brokerageId) {
    return { ok: false, docs: [], error: "no brokerage on the deal — the required-document checklist cannot be resolved" }
  }

  // Pull all rows for the brokerage matching deal_type (+ optional state)
  let q = supabase
    .from("brokerage_required_documents")
    .select("classification, scope_type, scope_id, block_on_missing, description, deal_type, state_code, template_form_id")
    .eq("brokerage_id", ctx.brokerageId)
    .eq("is_required",  true)
    .or(`deal_type.eq.${ctx.dealType},deal_type.eq.dual`)

  // supabase-js RESOLVES refusals — read the error (CLAUDE.md §3).
  const { data: rows, error } = await q
  if (error) {
    return { ok: false, docs: [], error: `required-document checklist could not be read: ${error.message}` }
  }
  if (!rows || rows.length === 0) return { ok: true, docs: [] }

  // Filter to rows applicable to this actor's scopes
  const applicable = rows.filter((r: any) => {
    if (r.state_code && ctx.stateCode && r.state_code !== ctx.stateCode) return false
    if (r.scope_type === "brokerage") return r.scope_id === ctx.brokerageId
    if (r.scope_type === "team")      return !!ctx.teamId      && r.scope_id === ctx.teamId
    if (r.scope_type === "agent")     return !!ctx.agentUserId && r.scope_id === ctx.agentUserId
    return false
  })

  // Per classification, pick the most-specific scope. Order weight:
  //   agent (2) > team (1) > brokerage (0)
  const SCOPE_RANK: Record<string, number> = { agent: 2, team: 1, brokerage: 0 }
  const byClass = new Map<string, any>()
  for (const r of applicable) {
    const existing = byClass.get(r.classification)
    if (!existing || SCOPE_RANK[r.scope_type] > SCOPE_RANK[existing.scope_type]) {
      byClass.set(r.classification, r)
    }
  }

  return {
    ok: true,
    docs: Array.from(byClass.values()).map(r => ({
      classification:   r.classification as DocumentClassification,
      scope:            r.scope_type as ResolvedRequiredDoc["scope"],
      block_on_missing: !!r.block_on_missing,
      description:      r.description ?? null,
      template_form_id: r.template_form_id ?? null,
    })),
  }
}

// ─── The deal file, loaded ONCE ─────────────────────────────────────────────

/**
 * One document in the deal file, with everything a gate needs to answer BOTH
 * halves of the owner's rule about it: is it PRESENT (classification) and is it
 * FULLY EXECUTED (signature_completeness — signatures AND initials, per party).
 *
 * `signature_completeness` is the live `documents.signature_completeness` jsonb
 * written by lib/documents/scan-uploaded-document.ts. INITIALS ARE TRACKED
 * SEPARATELY FROM SIGNATURES inside it — `{ signatures: [{signer_role, signed}],
 * initials: [{signer_role, all_required_initials_present}] }` — which is exactly
 * the distinction the owner draws, and it is read here through the ONE predicate
 * that answers it (lib/compliance/signature-completeness.ts:evaluateExecution).
 */
export interface DealFileDocument {
  id:                     string
  classification:         DocumentClassification | null
  signature_completeness: unknown
  status:                 string | null
}

export type DealFileOutcome =
  | { ok: true;  rows: DealFileDocument[] }
  | { ok: false; rows: [];              error: string }

/**
 * Load every classified document in one deal file, from the SAME anchors the
 * audits below have always counted presence from — the offer link, the listing
 * link (column AND the legacy metadata form), and the deal's contacts. Hoisted
 * out of the two audits so the presence question and the execution question can
 * never be answered off two different reads of the file.
 *
 * FAILS CLOSED: a refused read is `ok:false`, never an empty file. An empty file
 * and an unreadable one are not the same claim, and the second must refuse.
 */
export async function loadDealFileDocuments(
  supabase: SupabaseClient,
  params: {
    brokerageId: string
    offerId?:    string | null
    listingId?:  string | null
    contactIds?: Array<string | null | undefined>
  },
): Promise<DealFileOutcome> {
  if (!params.brokerageId) {
    return { ok: false, rows: [], error: "no brokerage on the deal — the deal file cannot be read" }
  }
  const COLUMNS = "id, classification, signature_completeness, status"
  const byId = new Map<string, DealFileDocument>()
  const absorb = (rows: any[] | null) => {
    for (const d of rows ?? []) {
      byId.set(d.id as string, {
        id:                     d.id as string,
        classification:         (d.classification ?? null) as DocumentClassification | null,
        signature_completeness: d.signature_completeness ?? null,
        status:                 (d.status ?? null) as string | null,
      })
    }
  }

  if (params.offerId) {
    const { data, error } = await supabase
      .from("documents")
      .select(COLUMNS)
      .eq("brokerage_id", params.brokerageId)
      .filter("metadata->>linked_offer_id", "eq", params.offerId)
      .not("classification", "is", null)
    if (error) return { ok: false, rows: [], error: `deal file (offer link) could not be read: ${error.message}` }
    absorb(data)
  }

  if (params.listingId) {
    // documents.listing_id is what lib/documents/upload-document.ts writes; the
    // metadata form is honoured for any row written that way. Both, because a
    // seller-side form legitimately arrives on either anchor.
    const { data: byColumn, error: colErr } = await supabase
      .from("documents")
      .select(COLUMNS)
      .eq("brokerage_id", params.brokerageId)
      .eq("listing_id", params.listingId)
      .not("classification", "is", null)
    if (colErr) return { ok: false, rows: [], error: `deal file (listing column) could not be read: ${colErr.message}` }
    absorb(byColumn)

    const { data: byMeta, error: metaErr } = await supabase
      .from("documents")
      .select(COLUMNS)
      .eq("brokerage_id", params.brokerageId)
      .filter("metadata->>linked_listing_id", "eq", params.listingId)
      .not("classification", "is", null)
    if (metaErr) return { ok: false, rows: [], error: `deal file (listing metadata) could not be read: ${metaErr.message}` }
    absorb(byMeta)
  }

  for (const contactId of params.contactIds ?? []) {
    if (!contactId) continue
    const { data, error } = await supabase
      .from("documents")
      .select(COLUMNS)
      .eq("brokerage_id", params.brokerageId)
      .eq("contact_id", contactId)
      .not("classification", "is", null)
    if (error) return { ok: false, rows: [], error: `deal file (contact ${contactId}) could not be read: ${error.message}` }
    absorb(data)
  }

  return { ok: true, rows: Array.from(byId.values()) }
}

// ─── Audit ──────────────────────────────────────────────────────────────────

export interface AuditResult {
  required_total:        number
  present:               DocumentClassification[]
  missing_blocking:      DocumentClassification[]
  missing_warning:       DocumentClassification[]
  required_breakdown:    ResolvedRequiredDoc[]
  /**
   * NON-NULL means THE AUDIT COULD NOT RUN. Every gate must refuse on it.
   *
   * An audit that could not read the checklist, or could not read the deal file,
   * previously returned the same all-zero shape as a clean file — so "nobody
   * checked" was indistinguishable from "checked and fine". The reason is now
   * carried beside the numbers so a caller cannot accidentally read a fault as a
   * pass, and the empty lists below are NOT a verdict when this is set.
   */
  unavailable_reason:    string | null
  /** The rows of the deal file the audit actually saw (empty when unavailable). */
  deal_file:             DealFileDocument[]
}

/** The shape returned when the audit could not run — never a pass. */
function unavailableAudit(reason: string): AuditResult {
  return {
    required_total:     0,
    present:            [],
    missing_blocking:   [],
    missing_warning:    [],
    required_breakdown: [],
    unavailable_reason: reason,
    deal_file:          [],
  }
}

/**
 * Audit the deal file for an offer against the resolved required-documents
 * checklist. Looks at `documents` rows tied to the offer's contact_id OR
 * offer_id via metadata.linked_offer_id — both surfaces are normal upload
 * targets.
 *
 * Returns:
 *   - required_total: how many classifications are required by the brokerage
 *   - present: which of those are already in the deal file
 *   - missing_blocking: required + block_on_missing=true, not present → BLOCKS submit
 *   - missing_warning:  required + block_on_missing=false, not present → WARNING
 */
export async function auditOfferDocuments(
  supabase: SupabaseClient,
  params: {
    offerId:       string
    brokerageId:   string
    contactId?:    string | null
    agentUserId?:  string | null
    teamId?:       string | null
    dealType:      "buyer" | "seller" | "dual"
    stateCode?:    string | null
  },
): Promise<AuditResult> {
  const required = await resolveRequiredDocuments(supabase, {
    brokerageId:  params.brokerageId,
    agentUserId:  params.agentUserId,
    teamId:       params.teamId,
    dealType:     params.dealType,
    stateCode:    params.stateCode,
  })
  if (!required.ok) return unavailableAudit(required.error)

  // Read the deal file even when nothing is required — an execution check
  // downstream still needs the rows, and "nothing required" must be reported
  // with the file it looked at rather than with an empty stand-in.
  const file = await loadDealFileDocuments(supabase, {
    brokerageId: params.brokerageId,
    offerId:     params.offerId,
    contactIds:  [params.contactId],
  })
  if (!file.ok) return unavailableAudit(file.error)

  if (required.docs.length === 0) {
    return {
      required_total:     0,
      present:            [],
      missing_blocking:   [],
      missing_warning:    [],
      required_breakdown: [],
      unavailable_reason: null,
      deal_file:          file.rows,
    }
  }

  // Anything classified into one of the required categories counts as
  // "present" for that category.
  const presentSet = new Set<DocumentClassification>()
  for (const d of file.rows) {
    if (d.classification) presentSet.add(d.classification)
  }

  const missing_blocking: DocumentClassification[] = []
  const missing_warning:  DocumentClassification[] = []
  for (const r of required.docs) {
    if (!presentSet.has(r.classification)) {
      if (r.block_on_missing) missing_blocking.push(r.classification)
      else                     missing_warning.push(r.classification)
    }
  }

  return {
    required_total:     required.docs.length,
    present:            Array.from(presentSet),
    missing_blocking,
    missing_warning,
    required_breakdown: required.docs,
    unavailable_reason: null,
    deal_file:          file.rows,
  }
}

/**
 * Audit the deal file for a LISTING against the seller-side required-documents
 * checklist. A listing agreement is only executable (and may auto-create a
 * listing) when, besides both-party signatures/initials, all required listing
 * documents are present. Presence is resolved from `documents` classified rows
 * tied to the listing (metadata.linked_listing_id) and/or the seller contact.
 */
export async function auditListingDocuments(
  supabase: SupabaseClient,
  params: {
    brokerageId:     string
    sellerContactId?: string | null
    agentUserId?:    string | null
    teamId?:         string | null
    stateCode?:      string | null
    listingId?:      string | null
  },
): Promise<AuditResult> {
  const required = await resolveRequiredDocuments(supabase, {
    brokerageId: params.brokerageId,
    agentUserId: params.agentUserId,
    teamId:      params.teamId,
    dealType:    "seller",
    stateCode:   params.stateCode,
  })
  if (!required.ok) return unavailableAudit(required.error)

  // The listing file, read through the SHARED loader — documents.listing_id
  // (what lib/documents/upload-document.ts actually writes), the legacy
  // metadata.linked_listing_id form, and the seller contact. All three, because
  // a seller-side form legitimately arrives on any of them; and error-checked,
  // because a refused read is not an empty file.
  const file = await loadDealFileDocuments(supabase, {
    brokerageId: params.brokerageId,
    listingId:   params.listingId,
    contactIds:  [params.sellerContactId],
  })
  if (!file.ok) return unavailableAudit(file.error)

  if (required.docs.length === 0) {
    return {
      required_total: 0, present: [], missing_blocking: [], missing_warning: [],
      required_breakdown: [], unavailable_reason: null, deal_file: file.rows,
    }
  }

  const presentSet = new Set<DocumentClassification>()
  for (const d of file.rows) {
    if (d.classification) presentSet.add(d.classification)
  }

  const missing_blocking: DocumentClassification[] = []
  const missing_warning:  DocumentClassification[] = []
  for (const r of required.docs) {
    if (!presentSet.has(r.classification)) {
      if (r.block_on_missing) missing_blocking.push(r.classification)
      else                     missing_warning.push(r.classification)
    }
  }

  return {
    required_total:     required.docs.length,
    present:            Array.from(presentSet),
    missing_blocking,
    missing_warning,
    required_breakdown: required.docs,
    unavailable_reason: null,
    deal_file:          file.rows,
  }
}
