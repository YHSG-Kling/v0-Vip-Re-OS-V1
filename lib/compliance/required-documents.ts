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

export async function resolveRequiredDocuments(
  supabase: SupabaseClient,
  ctx: ResolveContext,
): Promise<ResolvedRequiredDoc[]> {
  if (!ctx.brokerageId) return []

  // Pull all rows for the brokerage matching deal_type (+ optional state)
  let q = supabase
    .from("brokerage_required_documents")
    .select("classification, scope_type, scope_id, block_on_missing, description, deal_type, state_code, template_form_id")
    .eq("brokerage_id", ctx.brokerageId)
    .eq("is_required",  true)
    .or(`deal_type.eq.${ctx.dealType},deal_type.eq.dual`)

  const { data: rows } = await q
  if (!rows || rows.length === 0) return []

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

  return Array.from(byClass.values()).map(r => ({
    classification:   r.classification as DocumentClassification,
    scope:            r.scope_type as ResolvedRequiredDoc["scope"],
    block_on_missing: !!r.block_on_missing,
    description:      r.description ?? null,
    template_form_id: r.template_form_id ?? null,
  }))
}

// ─── Audit ──────────────────────────────────────────────────────────────────

export interface AuditResult {
  required_total:        number
  present:               DocumentClassification[]
  missing_blocking:      DocumentClassification[]
  missing_warning:       DocumentClassification[]
  required_breakdown:    ResolvedRequiredDoc[]
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

  if (required.length === 0) {
    return {
      required_total:     0,
      present:            [],
      missing_blocking:   [],
      missing_warning:    [],
      required_breakdown: [],
    }
  }

  // Pull every classified document tied to this offer (via offer_id metadata
  // or via the buyer contact). Anything classified into one of the required
  // categories counts as "present" for that category.
  const presentSet = new Set<DocumentClassification>()

  // 1) Documents linked to this offer via metadata.linked_offer_id
  const { data: byOffer } = await supabase
    .from("documents")
    .select("classification")
    .eq("brokerage_id", params.brokerageId)
    .filter("metadata->>linked_offer_id", "eq", params.offerId)
    .not("classification", "is", null)
  for (const d of byOffer ?? []) {
    if (d.classification) presentSet.add(d.classification as DocumentClassification)
  }

  // 2) Documents linked by buyer contact (PAL, POF, ID lives on the contact)
  if (params.contactId) {
    const { data: byContact } = await supabase
      .from("documents")
      .select("classification")
      .eq("brokerage_id", params.brokerageId)
      .eq("contact_id", params.contactId)
      .not("classification", "is", null)
    for (const d of byContact ?? []) {
      if (d.classification) presentSet.add(d.classification as DocumentClassification)
    }
  }

  const missing_blocking: DocumentClassification[] = []
  const missing_warning:  DocumentClassification[] = []
  for (const r of required) {
    if (!presentSet.has(r.classification)) {
      if (r.block_on_missing) missing_blocking.push(r.classification)
      else                     missing_warning.push(r.classification)
    }
  }

  return {
    required_total:     required.length,
    present:            Array.from(presentSet),
    missing_blocking,
    missing_warning,
    required_breakdown: required,
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

  if (required.length === 0) {
    return { required_total: 0, present: [], missing_blocking: [], missing_warning: [], required_breakdown: [] }
  }

  const presentSet = new Set<DocumentClassification>()

  if (params.listingId) {
    const { data: byListing } = await supabase
      .from("documents")
      .select("classification")
      .eq("brokerage_id", params.brokerageId)
      .filter("metadata->>linked_listing_id", "eq", params.listingId)
      .not("classification", "is", null)
    for (const d of byListing ?? []) {
      if (d.classification) presentSet.add(d.classification as DocumentClassification)
    }
  }

  if (params.sellerContactId) {
    const { data: byContact } = await supabase
      .from("documents")
      .select("classification")
      .eq("brokerage_id", params.brokerageId)
      .eq("contact_id", params.sellerContactId)
      .not("classification", "is", null)
    for (const d of byContact ?? []) {
      if (d.classification) presentSet.add(d.classification as DocumentClassification)
    }
  }

  const missing_blocking: DocumentClassification[] = []
  const missing_warning:  DocumentClassification[] = []
  for (const r of required) {
    if (!presentSet.has(r.classification)) {
      if (r.block_on_missing) missing_blocking.push(r.classification)
      else                     missing_warning.push(r.classification)
    }
  }

  return {
    required_total:     required.length,
    present:            Array.from(presentSet),
    missing_blocking,
    missing_warning,
    required_breakdown: required,
  }
}
