/**
 * lib/compliance/required-documents.ts
 *
 * Resolves the required-documents checklist for an offer + audits the deal
 * file against it. Used by submitOfferToCompliance before it advances the
 * offer to compliance.passed.
 *
 * Resolution cascade mirrors the e-sign / SMS / email provider resolver:
 *   agent_user → team → brokerage   (most-specific scope wins the rule's TEXT / template)
 *
 * WAVE 145 (lane 145H, owner ruling 21 — "Teams required document checklist should follow the team"):
 *   · A lower scope may ADD a requirement or TIGHTEN one (warning → blocking); it can never LOOSEN a requirement
 *     a higher scope (the brokerage over a team, the team over an agent) or a cited STATE requirement makes
 *     blocking. Before this, a team row with block_on_missing=false silently downgraded the brokerage's blocking
 *     rule for the same document. The brokerage is the supervising licensee; a team is under its licence.
 *   · The deal's TEAM is resolved through THE team resolver (lib/kernel/resolve-user-team.ts) when the caller does
 *     not state it — so a team lead (whose team lives on teams.team_lead_id, not users.team_id) has their team's
 *     checklist applied, and the closing audit (which passed no agent at all) applies the deal agent's team.
 *   · A team's rules move WITH the team into an adopting brokerage (lib/compliance/team-checklist-carry.ts).
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
import {
  PLATFORM_CHECKLIST_VOCABULARY,
  financingKindFor,
  platformFinancingType,
  rowApplicability,
  rowSpecificity,
  type ChecklistContext,
  type ChecklistDimensionColumn,
  type ChecklistStage,
  type ChecklistVocabulary,
} from "./checklist-dimensions"
import { checklistVocabularyFor, financingTypeResolver, loadTenantVocabulary } from "./adaptive-vocabulary"

/**
 * Wave 144A — the brokerage's ADAPTIVE VOCABULARY, read only when it can matter: a stored rule or the
 * question names a contract type / representation that is not a platform value (a brokerage term, an
 * alias). Every other call reads exactly what it read before, with no extra query. A refused read leaves
 * the platform vocabulary in force, under which a brokerage term is UNINTERPRETABLE — the rule then
 * applies as a WARNING naming the dimension, never silently as "not required" and never as a wildcard.
 */
async function checklistVocabularyForCall(supabase: SupabaseClient, brokerageId: string, values: unknown[]): Promise<ChecklistVocabulary> {
  const foreign = values.some((v) => typeof v === "string" && v.trim()
    && !PLATFORM_CHECKLIST_VOCABULARY.lineage("contract_subtype", v.trim()) && !PLATFORM_CHECKLIST_VOCABULARY.lineage("representation", v.trim()))
  if (!foreign) return PLATFORM_CHECKLIST_VOCABULARY
  const v = await loadTenantVocabulary(supabase, brokerageId)
  return v.ok ? checklistVocabularyFor(v.vocabulary) : PLATFORM_CHECKLIST_VOCABULARY
}

export interface ResolvedRequiredDoc {
  classification:    DocumentClassification
  scope:             "agent" | "team" | "brokerage"
  block_on_missing:  boolean
  description?:      string | null
  /** brokerage_form_library id of the blank template attached to the winning rule. */
  template_form_id?: string | null
  /** The winning rule's id, so a notice / ledger row can cite WHICH rule applied. */
  rule_id?:          string | null
  /** The winning rule's stage (m806) — null = due at any stage. */
  required_stage?:   string | null
  /** The winning rule's policy_version (m806; bumped on every edit of the rule). */
  policy_version?:   number | null
  /**
   * Dimensions the rule names that the caller did not state (see checklist-dimensions.ts). A
   * non-empty list means the requirement APPLIES AS A WARNING: it was not possible to confirm the
   * deal falls in the rule's scope, and "could not tell" must not read as "not required".
   */
  unresolved?:       ChecklistDimensionColumn[]
  /**
   * Wave 144A (m847): 'state_requirement' = the rule says a STATE requires the document, cited to an official
   * (.gov / .us) source and approved by a compliance approver (app/actions/compliance/manage-required-docs.ts);
   * null = the brokerage's own policy (every row before m847). A notice may cite `source_url`; it never
   * claims a legal requirement for a row that carries none.
   */
  legal_basis?:      string | null
  source_url?:       string | null
  /**
   * Wave 145 (ruling 21): the HIGHER-scope or cited state-requirement rules that kept this document BLOCKING when the
   * winning (more specific) rule would only have warned — a team / agent rule cannot loosen them. Empty / absent = the
   * winning rule decided alone (every checklist with no lower-scope override reads exactly as before).
   */
  floor_rule_ids?:   string[]
}

export interface ResolveContext extends ChecklistContext {
  brokerageId:   string
  agentUserId?:  string | null   // users.id of the deal's agent
  /** The deal's team. Stated by the caller, or — when absent and an agent is known — resolved through THE team
   *  resolver (lib/kernel/resolve-user-team.ts; wave 145) only if the brokerage has any team-scope rule. */
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
  | { ok: true;  docs: ResolvedRequiredDoc[]; policy_version: number | null; checklist_fingerprint: string | null }
  | { ok: false; docs: [];                   error: string }

/** The highest policy_version among the winning rules, and a stable fingerprint of exactly which rules applied.
 *  A floor rule (wave 145) is part of "which rules applied", so it is appended as `+<id>` — only when one decided. */
function checklistEvidence(docs: ResolvedRequiredDoc[]): { policy_version: number | null; checklist_fingerprint: string | null } {
  if (docs.length === 0) return { policy_version: null, checklist_fingerprint: null }
  const versions = docs.map(d => d.policy_version).filter((v): v is number => typeof v === "number")
  const fingerprint = docs
    .map(d => `${d.rule_id ?? d.classification}@${d.policy_version ?? 1}${d.block_on_missing ? "!" : "?"}${(d.floor_rule_ids ?? []).map((f) => `+${f}`).join("")}`)
    .sort()
    .join("|")
  return { policy_version: versions.length ? Math.max(...versions) : null, checklist_fingerprint: fingerprint }
}

export async function resolveRequiredDocuments(
  supabase: SupabaseClient,
  ctx: ResolveContext,
): Promise<ResolveRequiredDocsOutcome> {
  // A missing tenant anchor is NOT "nothing required" — it is a gate that cannot
  // run, and it must refuse.
  if (!ctx.brokerageId) {
    return { ok: false, docs: [], error: "no brokerage on the deal — the required-document checklist cannot be resolved" }
  }

  // Pull all rows for the brokerage matching deal_type (+ optional state).
  //
  // `select("*")`, not a column list: the m806 dimensions (required_stage, financing_kind,
  // contract_subtype, representation, policy_version) are WRITTEN, NOT APPLIED until the integrator
  // applies them, and a select that NAMES an absent column is refused whole (42703) — which this
  // resolver would then report as ok:false and EVERY gate would refuse. A star select returns the
  // columns that exist; the absent ones read as undefined = "any" (the wildcard every pre-m806 row is).
  const q = supabase
    .from("brokerage_required_documents")
    .select("*")
    .eq("brokerage_id", ctx.brokerageId)
    .eq("is_required",  true)
    .or(`deal_type.eq.${ctx.dealType},deal_type.eq.dual`)

  // supabase-js RESOLVES refusals — read the error (CLAUDE.md §3).
  const { data: rows, error } = await q
  if (error) {
    return { ok: false, docs: [], error: `required-document checklist could not be read: ${error.message}` }
  }
  if (!rows || rows.length === 0) return { ok: true, docs: [], policy_version: null, checklist_fingerprint: null }

  // THE DEAL'S TEAM (wave 145, ruling 21). Stated by the caller, or — when the brokerage has any team-scope rule and
  // the deal's agent is known — resolved through THE team resolver (lead link → users.team_id → active membership →
  // agents.team_id). Callers used to pass users.team_id alone, which is null for a team LEAD (their team lives on
  // teams.team_lead_id), so a lead's own deals skipped the team checklist; the closing audit passed no team at all.
  // The read is pinned below to THIS brokerage's rows, so a team id from anywhere else can never match a rule.
  let teamId = ctx.teamId ?? null
  if (!teamId && ctx.agentUserId && (rows as any[]).some((r) => r.scope_type === "team")) {
    const { resolveUserTeam } = await import("@/lib/kernel/resolve-user-team")
    teamId = (await resolveUserTeam(supabase, ctx.agentUserId)).teamId
  }

  // Filter to rows applicable to this actor's scopes AND to the question being asked (state,
  // stage, financing, contract subtype, representation — lib/compliance/checklist-dimensions.ts).
  const vocabulary = await checklistVocabularyForCall(supabase, ctx.brokerageId, [
    ctx.contractSubtype, ctx.representation,
    ...(rows as any[]).flatMap((r) => [r.contract_subtype, r.representation]),
  ])
  type Candidate = { row: any; unresolved: ChecklistDimensionColumn[] }
  const applicable: Candidate[] = []
  for (const r of rows as any[]) {
    if (r.state_code && ctx.stateCode && r.state_code !== ctx.stateCode) continue
    const inScope =
      r.scope_type === "brokerage" ? r.scope_id === ctx.brokerageId
      : r.scope_type === "team"    ? !!teamId          && r.scope_id === teamId
      : r.scope_type === "agent"   ? !!ctx.agentUserId && r.scope_id === ctx.agentUserId
      : false
    if (!inScope) continue
    const fit = rowApplicability(r, ctx, vocabulary)
    if (!fit.applies) continue
    applicable.push({ row: r, unresolved: fit.unresolved })
  }

  // Per classification, ONE winner: the most specific SCOPE first (agent > team > brokerage), then
  // the rule that pins down the most dimensions (a state / stage / financing-specific rule beats a
  // generic one at the same scope — before this, two rows at one scope were order-dependent), then
  // the strictest (blocking beats warning). Deterministic by construction.
  const SCOPE_RANK: Record<string, number> = { agent: 2, team: 1, brokerage: 0 }
  const beatsWithinScope = (a: { row: any }, b: { row: any }): boolean => {
    const pa = rowSpecificity(a.row, vocabulary), pb = rowSpecificity(b.row, vocabulary)
    if (pa !== pb) return pa > pb
    return !!a.row.block_on_missing && !b.row.block_on_missing
  }
  const beats = (a: { row: any }, b: { row: any }): boolean => {
    const sa = SCOPE_RANK[a.row.scope_type] ?? -1, sb = SCOPE_RANK[b.row.scope_type] ?? -1
    if (sa !== sb) return sa > sb
    return beatsWithinScope(a, b)
  }
  // Wave 145 (ruling 21): beside the winner, each scope's OWN answer for the document (its best rule) and every cited
  // state requirement — the "floors" a more specific rule may tighten but never loosen.
  const byClass = new Map<string, { winner: Candidate; perScope: Map<string, Candidate>; stateRules: Candidate[] }>()
  for (const cand of applicable) {
    const cls = cand.row.classification as string
    const entry = byClass.get(cls) ?? { winner: cand, perScope: new Map<string, Candidate>(), stateRules: [] as Candidate[] }
    if (!byClass.has(cls)) byClass.set(cls, entry)
    else if (beats(cand, entry.winner)) entry.winner = cand
    const sc = String(cand.row.scope_type)
    const best = entry.perScope.get(sc)
    if (!best || beatsWithinScope(cand, best)) entry.perScope.set(sc, cand)
    if (cand.row.legal_basis === "state_requirement") entry.stateRules.push(cand)
  }

  // A rule that could not be confirmed to cover this deal cannot BLOCK it — it warns, and says why.
  const blocks = (c: Candidate): boolean => !!c.row.block_on_missing && c.unresolved.length === 0
  const docs: ResolvedRequiredDoc[] = Array.from(byClass.values()).map(({ winner, perScope, stateRules }) => {
    const r = winner.row
    const winnerRank = SCOPE_RANK[r.scope_type] ?? -1
    // CONFLICTS RESOLVE TOWARD THE MANDATORY RULE: a higher scope's own answer, or a cited state requirement, that
    // blocks keeps the document blocking when the winning (more specific) rule would only warn.
    const floors = winnerRank < 0 || blocks(winner) ? [] : [
      ...[...perScope.values()].filter((c) => c !== winner && (SCOPE_RANK[c.row.scope_type] ?? 99) < winnerRank),
      ...stateRules.filter((c) => c !== winner),
    ].filter(blocks)
    const floorIds = [...new Set(floors.map((c) => String(c.row.id ?? c.row.classification)))]
    // A cited state requirement in force is cited on the document even when a brokerage / team rule supplies its text.
    const cite = r.legal_basis === "state_requirement" ? r : (stateRules.find(blocks) ?? stateRules[0])?.row ?? null
    return {
      classification:   r.classification as DocumentClassification,
      scope:            r.scope_type as ResolvedRequiredDoc["scope"],
      block_on_missing: blocks(winner) || floors.length > 0,
      description:      r.description ?? null,
      template_form_id: r.template_form_id ?? null,
      rule_id:          (r.id as string | undefined) ?? null,
      required_stage:   (r.required_stage as string | null | undefined) ?? null,
      policy_version:   typeof r.policy_version === "number" ? r.policy_version : null,
      // A floor that blocks was confirmed to cover this deal, so the requirement is not a warning any more.
      unresolved:       floors.length > 0 ? [] : winner.unresolved,
      legal_basis:      (cite?.legal_basis as string | null | undefined) ?? (r.legal_basis as string | null | undefined) ?? null,
      source_url:       (cite?.source_url as string | null | undefined) ?? (r.source_url as string | null | undefined) ?? null,
      ...(floorIds.length ? { floor_rule_ids: floorIds } : {}),
    }
  })
  return { ok: true, docs, ...checklistEvidence(docs) }
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
    /**
     * `documents.transaction_id` — what the title portal and the closing uploads write. The deal
     * file used to be assembled from the offer / listing / contact anchors only, so a closing
     * document filed straight onto the TRANSACTION was invisible to the checklist that was
     * supposed to count it (wave 143, closing stage).
     */
    transactionId?: string | null
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

  if (params.transactionId) {
    const { data, error } = await supabase
      .from("documents")
      .select(COLUMNS)
      .eq("brokerage_id", params.brokerageId)
      .eq("transaction_id", params.transactionId)
      .not("classification", "is", null)
    if (error) return { ok: false, rows: [], error: `deal file (transaction link) could not be read: ${error.message}` }
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
  /**
   * WHICH LIST WAS APPLIED (wave 143). The highest `policy_version` among the winning rules and a
   * fingerprint of exactly which rules (id@version, blocking or warning) answered — so a notice,
   * a compliance-log row or a ledger entry can say "checked against checklist X", and an edit to
   * the list changes the fingerprint. Absent on a pre-m806 database (rules carry no version) —
   * `policy_version` is then null and the fingerprint is rule-ids only.
   */
  policy_version?:        number | null
  checklist_fingerprint?: string | null
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
    policy_version:        null,
    checklist_fingerprint: null,
  }
}

/** Everything the three audits share once the checklist and the deal file are in hand. */
function auditAgainst(required: Extract<ResolveRequiredDocsOutcome, { ok: true }>, file: DealFileDocument[]): AuditResult {
  const evidence = { policy_version: required.policy_version, checklist_fingerprint: required.checklist_fingerprint }
  if (required.docs.length === 0) {
    return {
      required_total: 0, present: [], missing_blocking: [], missing_warning: [],
      required_breakdown: [], unavailable_reason: null, deal_file: file, ...evidence,
    }
  }
  // Anything classified into one of the required categories counts as "present" for that category.
  const presentSet = new Set<DocumentClassification>()
  for (const d of file) if (d.classification) presentSet.add(d.classification)

  const missing_blocking: DocumentClassification[] = []
  const missing_warning:  DocumentClassification[] = []
  for (const r of required.docs) {
    if (presentSet.has(r.classification)) continue
    if (r.block_on_missing) missing_blocking.push(r.classification)
    else                     missing_warning.push(r.classification)
  }
  return {
    required_total:     required.docs.length,
    present:            Array.from(presentSet),
    missing_blocking,
    missing_warning,
    required_breakdown: required.docs,
    unavailable_reason: null,
    deal_file:          file,
    ...evidence,
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
    /** The question's STAGE. Defaults to 'offer' — what this audit has always been asked at. */
    stage?:        ChecklistStage | null
    /**
     * The deal's financing kind. When the caller does not state it, the audit reads it off THE OFFER
     * ITSELF (offers.financing_type) so a brokerage's cash-only or financed-only rule is honoured
     * at every existing door without that door changing. A refused read leaves it unknown, and a
     * rule that needed it then applies as a warning — never silently as "not required".
     */
    financing?:    ChecklistContext["financing"]
    contractSubtype?: ChecklistContext["contractSubtype"]
    representation?:  ChecklistContext["representation"]
  },
): Promise<AuditResult> {
  let financing = params.financing ?? null
  if (financing === null && params.financing === undefined) {
    const { data: offerRow, error: offerErr } = await supabase
      .from("offers")
      .select("financing_type")
      .eq("id", params.offerId)
      .eq("brokerage_id", params.brokerageId)
      .maybeSingle()
    if (!offerErr) {
      const raw = (offerRow as { financing_type?: unknown } | null)?.financing_type
      // Wave 144A: a value that is not a platform financing type (a brokerage term written raw by an older
      // writer) is read through the brokerage's vocabulary, so a term that rolls up to `cash` stays cash.
      const tenant = typeof raw === "string" && raw.trim() && !platformFinancingType(raw) ? await loadTenantVocabulary(supabase, params.brokerageId) : null
      financing = financingKindFor(raw, tenant?.ok ? financingTypeResolver(tenant.vocabulary) : undefined)
    }
  }

  const required = await resolveRequiredDocuments(supabase, {
    brokerageId:  params.brokerageId,
    agentUserId:  params.agentUserId,
    teamId:       params.teamId,
    dealType:     params.dealType,
    stateCode:    params.stateCode,
    stage:        params.stage ?? "offer",
    financing,
    contractSubtype: params.contractSubtype ?? null,
    representation:  params.representation ?? null,
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

  return auditAgainst(required, file.rows)
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
    /** The question's STAGE. Defaults to 'listing' — what this audit has always been asked at. */
    stage?:          ChecklistStage | null
    contractSubtype?: ChecklistContext["contractSubtype"]
    representation?:  ChecklistContext["representation"]
  },
): Promise<AuditResult> {
  const required = await resolveRequiredDocuments(supabase, {
    brokerageId: params.brokerageId,
    agentUserId: params.agentUserId,
    teamId:      params.teamId,
    dealType:    "seller",
    stateCode:   params.stateCode,
    stage:       params.stage ?? "listing",
    contractSubtype: params.contractSubtype ?? null,
    representation:  params.representation ?? null,
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

  return auditAgainst(required, file.rows)
}

/**
 * The deal's agent as a users.id, read off the transaction (wave 145). The side's agent column first (seller →
 * seller_agent_id, buyer → buyer_agent_id), then the primary agent_id; `transactions.*agent_id` are agents.id, crossed
 * to users.id through agents.user_id (the two id spaces are disjoint — CLAUDE.md §3). No agent on the deal → null
 * (only brokerage rules apply, exactly as before). A refused read → ok:false (fail closed).
 */
async function transactionAgentUserId(
  supabase: SupabaseClient, brokerageId: string, transactionId: string, dealType: "buyer" | "seller" | "dual",
): Promise<{ ok: true; userId: string | null } | { ok: false; error: string }> {
  const { data: tx, error: txErr } = await supabase
    .from("transactions")
    .select("agent_id, buyer_agent_id, seller_agent_id")
    .eq("id", transactionId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (txErr) return { ok: false, error: `the deal's agent could not be read: ${txErr.message}` }
  const t = (tx ?? {}) as { agent_id?: string | null; buyer_agent_id?: string | null; seller_agent_id?: string | null }
  const agentId = (dealType === "seller" ? t.seller_agent_id : dealType === "buyer" ? t.buyer_agent_id : null) ?? t.agent_id ?? null
  if (!agentId) return { ok: true, userId: null }
  const { data: agent, error: agentErr } = await supabase
    .from("agents")
    .select("user_id")
    .eq("id", agentId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (agentErr) return { ok: false, error: `the deal's agent could not be read: ${agentErr.message}` }
  return { ok: true, userId: ((agent as { user_id?: string | null } | null)?.user_id) ?? null }
}

/**
 * Audit the deal file of a TRANSACTION — the contract and CLOSING stages of the brokerage's
 * checklist (wave 143: "the brokerage gives the complete list of required documents for each
 * contract type, for compliance including closing").
 *
 * The listing and offer audits above answer "may this go live / go to compliance"; this one
 * answers "is the closing file complete". It reads the deal file from EVERY anchor the deal
 * has — the transaction (title-portal and closing uploads), the offer, the listing and the
 * contacts — through the same loader, and the checklist at the stage the caller names
 * (default 'closing', which also applies every rule due earlier).
 */
export async function auditTransactionDocuments(
  supabase: SupabaseClient,
  params: {
    transactionId:   string
    brokerageId:     string
    offerId?:        string | null
    listingId?:      string | null
    contactIds?:     Array<string | null | undefined>
    agentUserId?:    string | null
    teamId?:         string | null
    dealType:        "buyer" | "seller" | "dual"
    stateCode?:      string | null
    stage?:          ChecklistStage | null
    financing?:      ChecklistContext["financing"]
    contractSubtype?: ChecklistContext["contractSubtype"]
    representation?:  ChecklistContext["representation"]
  },
): Promise<AuditResult> {
  // WAVE 145 (ruling 21): the closing audit used to be asked with NO agent and NO team, so every team- and agent-scope
  // requirement silently fell away at closing. When the caller states neither, the deal's own agent is read off the
  // TRANSACTION (the side's agent, else the primary — agents.id, crossed to users.id through agents.user_id, CLAUDE.md
  // §3) and the team resolves from that agent in the resolver. A refused read is "the audit could not run".
  let agentUserId = params.agentUserId
  if (params.agentUserId === undefined && params.teamId === undefined) {
    const dealAgent = await transactionAgentUserId(supabase, params.brokerageId, params.transactionId, params.dealType)
    if (!dealAgent.ok) return unavailableAudit(dealAgent.error)
    agentUserId = dealAgent.userId
  }
  const required = await resolveRequiredDocuments(supabase, {
    brokerageId:  params.brokerageId,
    agentUserId,
    teamId:       params.teamId,
    dealType:     params.dealType,
    stateCode:    params.stateCode,
    stage:        params.stage ?? "closing",
    financing:    params.financing ?? null,
    contractSubtype: params.contractSubtype ?? null,
    representation:  params.representation ?? null,
  })
  if (!required.ok) return unavailableAudit(required.error)

  const file = await loadDealFileDocuments(supabase, {
    brokerageId:   params.brokerageId,
    transactionId: params.transactionId,
    offerId:       params.offerId,
    listingId:     params.listingId,
    contactIds:    params.contactIds,
  })
  if (!file.ok) return unavailableAudit(file.error)

  return auditAgainst(required, file.rows)
}
