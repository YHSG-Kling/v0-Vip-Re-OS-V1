// lib/kernel/document-autofile.ts
//
// THE AI AUTO-FILING CLERK — the Deal Coordinator's filing hand.
//
// The live-kernel equivalent of the legacy workflows/document-storage-logic.json
// ("AI Auto-Filing Clerk (Workflow 149)"): a document is uploaded → classify its type
// (purchase agreement / disclosure / inspection / pre-approval / ID / addendum / …) →
// route it to the correct DEAL FOLDER. It kills the #1 transaction-admin chore: a clerk
// hand-sorting every PDF that lands into the right deal's right folder.
//
// ── What "filing" IS in this OS (verified live, no new tables) ────────────────
// The canonical document store is `client_documents` (the portal + agent-facing upload
// table; app/actions/document-center.ts groups it into FOLDERS by document_type). A
// document is FILED when its row carries:
//   · document_type  — the FOLDER key (free-text; drives the Document Center folders).
//   · doc_category   — the canonical CHECK enum (verified live):
//       pre_approval_letter | proof_of_funds | bank_statement | gift_letter | tax_return |
//       employment_verification | offer_form | contract | disclosure | inspection_report |
//       appraisal | title | insurance | other
//   · transaction_id — the DEAL the doc belongs to (the "folder" in deal terms).
//   · ai_metadata    — the filing audit (confidence, signals, classifier source).
// An UNFILED doc is one with no doc_category set yet (the clerk's work queue).
//
// ── In-app filing, NOT Google Drive (what's actually wired) ───────────────────
// The legacy workflow filed into Google Drive folders (Drive: Folder Lookup / Create /
// Upload). This codebase has NO Drive folder API wired: the connector-registry.ts has no
// Drive connector, and Google OAuth (lib/inbound-mail/oauth-fetchers, lib/providers) is
// Gmail/Calendar only — there is no create/list-folder or move-file runtime integration.
// So the clerk performs the CANONICAL IN-APP filing (set the columns above on the row).
// A Drive sync is an honest FOLLOW-UP (would hang off a future Drive connector + the same
// resolveDealFolder output); the clerk never pretends to move a file into a Drive folder
// that does not exist.
//
// ── Classify via an injectable seam, deterministic floor ──────────────────────
// classifyDocumentType is a PURE keyword/extension classifier over the canonical enum —
// the deterministic FALLBACK (and the only thing the unit layer needs). The live runner
// takes an injectable AI classifier seam (gateway by default) and falls back to the pure
// floor whenever the seam is unavailable or low-confidence. HONEST: a low-confidence
// classification leaves the doc UNFILED and flags it for a human — it never misfiles
// silently into the wrong folder.
//
// ── Resolve the deal (the folder) ─────────────────────────────────────────────
// resolveDealFolder is PURE: a doc already stamped with a transaction_id stays on that
// deal; otherwise it matches by the uploader's contact to that contact's single open
// transaction (buyer/seller/contact link). Ambiguous (contact on >1 open deal) or no deal
// → no transaction stamped (the type is still filed; the deal is left for a human).
//
// NOT server-only (simulator-driven). Only ever writes through a caller-supplied /
// service client — never import client-side.

import type { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

// ─────────────────────────────────────────────────────────────────────────────
// Canonical enums (verified live against the client_documents.doc_category CHECK)
// ─────────────────────────────────────────────────────────────────────────────

/** The canonical filing categories — EXACTLY the live client_documents.doc_category CHECK. */
export const DOC_CATEGORIES = [
  "pre_approval_letter",
  "proof_of_funds",
  "bank_statement",
  "gift_letter",
  "tax_return",
  "employment_verification",
  "offer_form",
  "contract",
  "disclosure",
  "inspection_report",
  "appraisal",
  "title",
  "insurance",
  "other",
] as const

export type DocCategory = (typeof DOC_CATEGORIES)[number]

/** Human folder labels (mirrors app/actions/document-center.ts FOLDER_LABELS intent). */
export const DOC_CATEGORY_LABELS: Record<DocCategory, string> = {
  pre_approval_letter: "Pre-Approval Letters",
  proof_of_funds: "Proof of Funds",
  bank_statement: "Bank Statements",
  gift_letter: "Gift Letters",
  tax_return: "Tax Returns",
  employment_verification: "Employment Verification",
  offer_form: "Offers & Purchase Agreements",
  contract: "Contracts & Addenda",
  disclosure: "Disclosures",
  inspection_report: "Inspections",
  appraisal: "Appraisals",
  title: "Title Documents",
  insurance: "Insurance",
  other: "Other / Unsorted",
}

export function isDocCategory(v: string | null | undefined): v is DocCategory {
  return !!v && (DOC_CATEGORIES as readonly string[]).includes(v)
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — PURE classifier (deterministic keyword/extension floor, no I/O)
// ─────────────────────────────────────────────────────────────────────────────

export type Confidence = "high" | "medium" | "low"

export interface DocClassification {
  /** The resolved canonical category (always one of DOC_CATEGORIES). */
  documentType: DocCategory
  confidence: Confidence
  /** Human-readable matched signals (e.g. "matched 'purchase agreement'"). */
  signals: string[]
}

export interface ClassifyHints {
  /** doc_category the uploader/extractor already asserted — a strong prior. */
  declaredCategory?: string | null
  /** True when the upload flow already marked this a financial verification doc. */
  isFinancialVerification?: boolean | null
}

/**
 * Keyword rules — ordered MOST-SPECIFIC first. Each rule maps matched phrases to a
 * canonical doc_category. The match is on a normalized (lowercased) filename-or-text.
 * Phrases are intentionally narrow so a hit is a real signal, not noise.
 */
const KEYWORD_RULES: Array<{ category: DocCategory; phrases: string[] }> = [
  // ── Financing readiness ──────────────────────────────────────────────────
  { category: "pre_approval_letter", phrases: ["pre-approval", "pre approval", "preapproval", "preapproved", "pre-qual", "prequal", "approval letter", "commitment letter", "lender letter"] },
  { category: "proof_of_funds", phrases: ["proof of funds", "pof", "funds verification", "verification of funds", "available funds"] },
  { category: "bank_statement", phrases: ["bank statement", "account statement", "brokerage statement", "investment statement"] },
  { category: "gift_letter", phrases: ["gift letter", "gift of equity", "donor letter"] },
  { category: "tax_return", phrases: ["tax return", "1040", "w-2", "w2 ", "1099", "schedule c", "tax transcript"] },
  { category: "employment_verification", phrases: ["employment verification", "voe", "verification of employment", "pay stub", "paystub", "earnings statement"] },
  // ── The contract spine ───────────────────────────────────────────────────
  { category: "offer_form", phrases: ["purchase agreement", "purchase and sale", "purchase & sale", "psa ", "psa.", "offer to purchase", "residential purchase", "offer form", "counter offer", "counteroffer", "counter-offer"] },
  { category: "contract", phrases: ["addendum", "amendment", "listing agreement", "buyer agency", "buyer-broker", "buyer broker", "representation agreement", "contract", "agreement to ", "lease agreement"] },
  // ── Diligence ──────────────────────────────────────────────────────────────
  { category: "disclosure", phrases: ["disclosure", "lead-based paint", "lead based paint", "seller's property", "transfer disclosure", "tds ", "natural hazard", "agency disclosure"] },
  { category: "inspection_report", phrases: ["inspection report", "home inspection", "inspection summary", "pest inspection", "termite report", "wdi report", "sewer scope", "roof inspection"] },
  { category: "appraisal", phrases: ["appraisal", "appraised value", "valuation report", "uniform residential appraisal", "urar"] },
  { category: "title", phrases: ["title report", "title commitment", "preliminary title", "prelim title", "title insurance", "deed of trust", "warranty deed", "grant deed", "escrow instructions", "closing disclosure", "settlement statement", "alta statement", "wire instructions"] },
  { category: "insurance", phrases: ["insurance", "homeowners policy", "hazard insurance", "binder", "declarations page", "flood insurance"] },
]

/** Government-ID phrases — the legacy "ID" bucket. The live enum has no `id_document`,
 *  so an ID files to `other` but is named honestly via signals (a human folder can split
 *  it later). Kept explicit so the clerk recognizes the type rather than guessing. */
const ID_PHRASES = ["driver's license", "drivers license", "driver license", "passport", "state id", "government id", "photo id", "identification card"]

function normalize(s: string): string {
  return (s ?? "").toString().toLowerCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim()
}

/** Map a free-text declared category onto the canonical enum (synonyms the app uses). */
function coerceDeclared(declared: string | null | undefined): DocCategory | null {
  const d = normalize(declared ?? "")
  if (!d) return null
  if (isDocCategory(declared!)) return declared as DocCategory
  const SYNONYM: Record<string, DocCategory> = {
    "purchase agreement": "offer_form",
    "purchase contract": "offer_form",
    offer: "offer_form",
    "counter offer": "offer_form",
    addendum: "contract",
    "listing agreement": "contract",
    "inspection": "inspection_report",
    "disclosure form": "disclosure",
    "sellers disclosure": "disclosure",
    "title report": "title",
    "closing disclosure": "title",
    "pre approval": "pre_approval_letter",
    "pre approval letter": "pre_approval_letter",
    "lender letter": "pre_approval_letter",
    "pof": "proof_of_funds",
  }
  return SYNONYM[d] ?? null
}

/**
 * classifyDocumentType — PURE filename-or-text → {documentType, confidence, signals}.
 *
 * Deterministic. Precedence:
 *   1. A declared/extracted category that coerces onto the canonical enum → HIGH.
 *   2. A keyword/extension match (most-specific rule first) → MEDIUM (single signal) /
 *      HIGH (multiple corroborating signals).
 *   3. Nothing recognized → {other, low} so the runner leaves it UNFILED for a human.
 * Honest: never invents a category it cannot defend with a signal.
 */
export function classifyDocumentType(
  filenameOrText: string,
  hints: ClassifyHints = {},
): DocClassification {
  const signals: string[] = []

  // 1. Declared category (the upload flow / an extractor already asserted one).
  const declared = coerceDeclared(hints.declaredCategory)
  if (declared) {
    return { documentType: declared, confidence: "high", signals: [`declared category: ${hints.declaredCategory}`] }
  }

  const text = normalize(filenameOrText)
  if (!text) {
    return { documentType: "other", confidence: "low", signals: [] }
  }

  // 2. Keyword rules — collect EVERY matching phrase across all rules. The MOST-SPECIFIC
  //    (longest) matched phrase wins the category, so "closing disclosure" (title) beats
  //    bare "disclosure", and "purchase agreement" (offer_form) beats bare "agreement".
  //    Rule order breaks ties at equal phrase length (most-specific rule listed first).
  const hits: Array<{ category: DocCategory; phrase: string; len: number }> = []
  for (const rule of KEYWORD_RULES) {
    for (const p of rule.phrases) {
      if (text.includes(normalize(p))) {
        hits.push({ category: rule.category, phrase: p.trim(), len: normalize(p).length })
      }
    }
  }
  let best: DocCategory | null = null
  if (hits.length > 0) {
    hits.sort((a, b) => b.len - a.len) // longest (most specific) phrase wins
    best = hits[0].category
    for (const h of hits) signals.push(`matched "${h.phrase}" → ${h.category}`)
  }
  // Distinct corroborating CATEGORIES (not just phrases) drives confidence.
  const distinctCategories = new Set(hits.map((h) => h.category)).size

  // Government ID → other (no canonical id_document enum), but recognized explicitly.
  const idHit = ID_PHRASES.find((p) => text.includes(normalize(p)))
  if (idHit && best === null) {
    return { documentType: "other", confidence: "medium", signals: [`matched ID "${idHit}" → other (no id_document folder; filed to Other)`] }
  }

  // Financial-verification hint corroborates a money doc when text is thin.
  if (best === null && hints.isFinancialVerification) {
    return { documentType: "proof_of_funds", confidence: "medium", signals: ["upload flagged financial verification → proof_of_funds"] }
  }

  if (best === null) {
    return { documentType: "other", confidence: "low", signals: signals.length ? signals : [] }
  }

  // Confidence: a clearly-specific winning phrase (multi-word, ≥12 chars, e.g.
  // "purchase agreement", "inspection report", "pre approval letter") OR ≥2 distinct
  // corroborating categories → HIGH; a single short/generic match → MEDIUM.
  const winningLen = hits[0].len
  const confidence: Confidence = winningLen >= 12 || distinctCategories >= 2 ? "high" : "medium"
  return { documentType: best, confidence, signals }
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — PURE deal-folder resolution
// ─────────────────────────────────────────────────────────────────────────────

/** The minimal doc shape resolveDealFolder needs (a subset of a client_documents row). */
export interface FilableDoc {
  id: string
  transaction_id: string | null
  contact_id: string | null
}

/** The minimal transaction shape (a subset of a transactions row). */
export interface DealRow {
  id: string
  contact_id: string | null
  buyer_contact_id: string | null
  seller_contact_id: string | null
  status: string | null
}

export interface DealResolution {
  /** The transaction the doc should be filed under, or null when undeterminable. */
  transactionId: string | null
  /** How the deal was resolved — for the audit + honest "why unresolved". */
  reason:
    | "already_on_deal"
    | "matched_by_contact"
    | "no_contact"
    | "no_open_deal_for_contact"
    | "ambiguous_multiple_open_deals"
}

/** Open-deal statuses — a doc files to a LIVE deal, not a closed/lost one. */
const OPEN_DEAL_STATUSES = new Set([
  "active", "under_contract", "pending", "in_progress", "open", "contingent", "new",
])

function isOpen(status: string | null): boolean {
  if (!status) return true // null status = treat as live (honest default; closed deals carry a status)
  return OPEN_DEAL_STATUSES.has(status.toLowerCase())
}

/**
 * resolveDealFolder — PURE. Decide which deal (transaction) a doc files under:
 *   · Already stamped with a transaction_id → keep it (already_on_deal).
 *   · Else match by the doc's contact to that contact's SINGLE open transaction
 *     (contact on either side, or the legacy contact_id link).
 *   · No contact → no_contact. No open deal → no_open_deal_for_contact. Contact on
 *     >1 open deal → ambiguous (a human picks — never guess the wrong deal).
 */
export function resolveDealFolder(doc: FilableDoc, transactions: DealRow[]): DealResolution {
  if (doc.transaction_id) {
    return { transactionId: doc.transaction_id, reason: "already_on_deal" }
  }
  if (!doc.contact_id) {
    return { transactionId: null, reason: "no_contact" }
  }
  const cid = doc.contact_id
  const matches = transactions.filter(
    (t) =>
      isOpen(t.status) &&
      (t.contact_id === cid || t.buyer_contact_id === cid || t.seller_contact_id === cid),
  )
  if (matches.length === 0) {
    return { transactionId: null, reason: "no_open_deal_for_contact" }
  }
  if (matches.length > 1) {
    return { transactionId: null, reason: "ambiguous_multiple_open_deals" }
  }
  return { transactionId: matches[0].id, reason: "matched_by_contact" }
}

// ─────────────────────────────────────────────────────────────────────────────
// Injectable AI classifier seam (gateway by default, pure floor as fallback)
// ─────────────────────────────────────────────────────────────────────────────

export interface ClassifierInput {
  filename: string
  /** Extracted text / summary when the upload pipeline produced one (else just the name). */
  text?: string | null
  hints: ClassifyHints
}

/** Returns a classification, or null to fall back to the deterministic floor. */
export type DocClassifier = (input: ClassifierInput) => Promise<DocClassification | null>

/**
 * The real classifier — routes through the AI gateway (gatewayChatJSON), constrained to
 * the canonical enum, then VALIDATES the model's answer against DOC_CATEGORIES (an
 * off-enum answer is rejected → null → the pure floor runs). Returns null on any failure
 * so production never blocks on the gateway. Token-spending; tests inject a stub instead.
 */
export const realDocClassifier: DocClassifier = async (input) => {
  try {
    const { gatewayChatJSON } = await import("@/lib/ai/gateway-chat")
    const enumList = DOC_CATEGORIES.join(", ")
    const res = await gatewayChatJSON<{ documentType?: string; confidence?: string }>({
      model: "openai/gpt-4o-mini",
      maxTokens: 200,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "You are a real-estate transaction filing clerk. Classify the document into EXACTLY ONE of these canonical categories and nothing else: " +
            enumList +
            ". Use ONLY the provided name/text — do not guess beyond it. If you cannot tell, answer documentType \"other\" with confidence \"low\". " +
            'Respond as strict JSON: {"documentType": <one of the categories>, "confidence": "high"|"medium"|"low"}.',
        },
        {
          role: "user",
          content:
            `Filename: ${input.filename}\n` +
            (input.text ? `Extracted text: ${input.text.slice(0, 4000)}\n` : "") +
            (input.hints.declaredCategory ? `Uploader-declared category: ${input.hints.declaredCategory}\n` : "") +
            (input.hints.isFinancialVerification ? "Flagged as financial verification.\n" : ""),
        },
      ],
    })
    const dt = res?.data?.documentType
    const conf = res?.data?.confidence
    if (!isDocCategory(dt ?? null)) return null // off-enum or empty → fall to the floor
    const confidence: Confidence = conf === "high" || conf === "medium" || conf === "low" ? conf : "medium"
    return { documentType: dt as DocCategory, confidence, signals: ["ai-gateway classification"] }
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — LIVE: classify → resolve the deal → FILE the row → record the filing
// ─────────────────────────────────────────────────────────────────────────────

/** Lifecycle event_type for the filing audit (lifecycle_events is the canonical ledger). */
export const AUTOFILE_EVENT = "document.auto_filed"
/** Lifecycle event_type when the clerk leaves a doc unfiled + flags it for a human. */
export const AUTOFILE_FLAGGED_EVENT = "document.autofile_needs_review"

/** Confidence floor for an autonomous file — below this, leave UNFILED + flag a human. */
const FILE_CONFIDENCE_FLOOR: Confidence = "medium"
function meetsFloor(c: Confidence): boolean {
  return c === "high" || c === "medium" // 'low' never auto-files
}

export interface RunAutoFileParams {
  documentId: string
}

export interface RunAutoFileDeps {
  /** Injected classifier; defaults to realDocClassifier (gateway). */
  classifier?: DocClassifier
}

export interface RunAutoFileResult {
  documentId: string
  /** 'filed' — type + (where resolvable) deal stamped. 'flagged' — low confidence, left
   *  unfiled for a human. 'already_filed' — idempotent no-op. 'skipped' — doc missing. */
  outcome: "filed" | "flagged" | "already_filed" | "skipped"
  documentType?: DocCategory
  confidence?: Confidence
  transactionId?: string | null
  dealReason?: DealResolution["reason"]
  signals?: string[]
  /** lifecycle_events.id of the recorded filing / flag. */
  eventId?: string
  reason?: string
}

/**
 * runAutoFile — the live capstone for ONE document.
 *   1. Load the client_documents row (skip if gone).
 *   2. IDEMPOTENT: a row already carrying a canonical doc_category is left untouched.
 *   3. CLASSIFY via the injected seam (gateway) → deterministic floor fallback.
 *   4. Below the confidence floor → leave UNFILED, set ai_metadata.autofile.flagged,
 *      record a needs-review lifecycle event. NEVER misfile.
 *   5. At/above the floor → resolve the deal (resolveDealFolder over the brokerage's open
 *      transactions), then FILE: set doc_category + document_type (folder key) +
 *      transaction_id (when resolved) + ai_metadata.autofile audit. Record the filing on
 *      lifecycle_events. (Drive move would hook here IFF a Drive API existed — it does not.)
 */
export async function runAutoFile(
  params: RunAutoFileParams,
  deps: RunAutoFileDeps = {},
  client?: Svc,
): Promise<RunAutoFileResult> {
  const { documentId } = params
  const classifier = deps.classifier ?? realDocClassifier
  const supabase = client ?? (await import("@/lib/supabase/service")).createServiceClient()
  const now = new Date().toISOString()

  // 1. Load the doc.
  const { data: doc } = await supabase
    .from("client_documents")
    .select("id, brokerage_id, contact_id, transaction_id, document_name, document_type, doc_category, is_financial_verification, ai_metadata")
    .eq("id", documentId)
    .maybeSingle()

  if (!doc) {
    return { documentId, outcome: "skipped", reason: "document not found" }
  }
  const row = doc as {
    id: string
    brokerage_id: string | null
    contact_id: string | null
    transaction_id: string | null
    document_name: string
    document_type: string | null
    doc_category: string | null
    is_financial_verification: boolean | null
    ai_metadata: Record<string, unknown> | null
  }

  // 2. Idempotency — a row already filed (canonical doc_category set) is never re-filed.
  if (isDocCategory(row.doc_category)) {
    return {
      documentId,
      outcome: "already_filed",
      documentType: row.doc_category,
      transactionId: row.transaction_id,
      reason: "doc already carries a canonical category (deduped)",
    }
  }

  const hints: ClassifyHints = {
    declaredCategory: row.document_type ?? null,
    isFinancialVerification: row.is_financial_verification ?? null,
  }

  // 3. Classify — injected seam first, deterministic floor as the guaranteed fallback.
  let classification: DocClassification | null = null
  try {
    classification =
      (await classifier({ filename: row.document_name, text: null, hints })) ?? null
  } catch {
    classification = null
  }
  if (!classification) {
    classification = classifyDocumentType(row.document_name, hints)
  }
  const { documentType, confidence, signals } = classification

  const priorMeta = (row.ai_metadata && typeof row.ai_metadata === "object" ? row.ai_metadata : {}) as Record<string, unknown>

  // 4. Below the floor → leave UNFILED + flag for a human (never misfile).
  if (!meetsFloor(confidence)) {
    await supabase
      .from("client_documents")
      .update({
        ai_metadata: {
          ...priorMeta,
          autofile: {
            status: "needs_review",
            suggested_type: documentType,
            confidence,
            signals,
            classified_at: now,
            source: "ai_autofile_clerk",
          },
        },
      })
      .eq("id", documentId)

    let eventId: string | undefined
    if (row.brokerage_id) {
      const { data: ev } = await supabase
        .from("lifecycle_events")
        .insert({
          brokerage_id: row.brokerage_id,
          entity_type: "document",
          entity_id: documentId,
          event_type: AUTOFILE_FLAGGED_EVENT,
          source: "cron",
          payload: { suggested_type: documentType, confidence, signals, reason: "low_confidence" },
          metadata: { document_name: row.document_name, suggested_type: documentType, confidence },
        })
        .select("id")
        .maybeSingle()
      eventId = (ev as { id?: string } | null)?.id
    }

    return {
      documentId,
      outcome: "flagged",
      documentType,
      confidence,
      signals,
      eventId,
      reason: "confidence below auto-file floor — left unfiled for human review",
    }
  }

  // 5. Resolve the deal (the folder). Pull the brokerage's open deals once.
  let deal: DealResolution = { transactionId: row.transaction_id, reason: row.transaction_id ? "already_on_deal" : "no_contact" }
  if (!row.transaction_id && row.contact_id && row.brokerage_id) {
    const { data: txns } = await supabase
      .from("transactions")
      .select("id, contact_id, buyer_contact_id, seller_contact_id, status")
      .eq("brokerage_id", row.brokerage_id)
      .is("deleted_at", null)
      .limit(500)
    deal = resolveDealFolder(
      { id: row.id, transaction_id: row.transaction_id, contact_id: row.contact_id },
      (txns ?? []) as DealRow[],
    )
  } else if (row.transaction_id) {
    deal = { transactionId: row.transaction_id, reason: "already_on_deal" }
  }

  // FILE the row — set the canonical filing columns. document_type carries the folder key
  // (same value as doc_category so the Document Center groups it correctly); doc_category
  // is the constrained enum; transaction_id is stamped only when the deal resolved.
  const update: Record<string, unknown> = {
    doc_category: documentType,
    document_type: documentType,
    ai_metadata: {
      ...priorMeta,
      autofile: {
        status: "filed",
        document_type: documentType,
        confidence,
        signals,
        deal_reason: deal.reason,
        filed_at: now,
        // Drive sync is a documented follow-up — no Drive folder API is wired in this OS.
        drive_synced: false,
        source: "ai_autofile_clerk",
      },
    },
  }
  if (deal.transactionId && !row.transaction_id) {
    update.transaction_id = deal.transactionId
  }

  await supabase.from("client_documents").update(update).eq("id", documentId)

  // RECORD the filing on the canonical lifecycle_events ledger.
  let eventId: string | undefined
  if (row.brokerage_id) {
    const { data: ev } = await supabase
      .from("lifecycle_events")
      .insert({
        brokerage_id: row.brokerage_id,
        entity_type: "document",
        entity_id: documentId,
        event_type: AUTOFILE_EVENT,
        source: "cron",
        payload: {
          document_type: documentType,
          confidence,
          transaction_id: deal.transactionId ?? null,
          deal_reason: deal.reason,
          drive_synced: false,
        },
        metadata: {
          document_name: row.document_name,
          document_type: documentType,
          folder: DOC_CATEGORY_LABELS[documentType],
          transaction_id: deal.transactionId ?? null,
        },
      })
      .select("id")
      .maybeSingle()
    eventId = (ev as { id?: string } | null)?.id
  }

  return {
    documentId,
    outcome: "filed",
    documentType,
    confidence,
    transactionId: deal.transactionId ?? null,
    dealReason: deal.reason,
    signals,
    eventId,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sweep — the cron entry point over recently-uploaded UNFILED documents
// ─────────────────────────────────────────────────────────────────────────────

export interface SweepResult {
  scanned: number
  filed: number
  flagged: number
  alreadyFiled: number
  skipped: number
  errors: string[]
}

/**
 * runAutoFileSweep — for one brokerage, file every recently-uploaded UNFILED document
 * (no canonical doc_category yet) in the lookback window. Idempotent end-to-end: an
 * already-filed doc is a no-op, so a re-sweep never re-files. Lowest-risk trigger (a
 * sweep, not an inline upload hook — a misfire never blocks an upload).
 */
export async function runAutoFileSweep(
  brokerageId: string,
  deps: RunAutoFileDeps = {},
  client?: Svc,
  opts: { lookbackHours?: number; limit?: number } = {},
): Promise<SweepResult> {
  const supabase = client ?? (await import("@/lib/supabase/service")).createServiceClient()
  const lookbackHours = opts.lookbackHours ?? 72
  const limit = opts.limit ?? 200
  const since = new Date(Date.now() - lookbackHours * 3_600_000).toISOString()

  const result: SweepResult = { scanned: 0, filed: 0, flagged: 0, alreadyFiled: 0, skipped: 0, errors: [] }

  const { data: docs, error } = await supabase
    .from("client_documents")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .is("doc_category", null) // UNFILED — the clerk's work queue
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(limit)

  if (error) {
    result.errors.push(error.message)
    return result
  }

  for (const d of (docs ?? []) as Array<{ id: string }>) {
    result.scanned += 1
    try {
      const r = await runAutoFile({ documentId: d.id }, deps, supabase)
      if (r.outcome === "filed") result.filed += 1
      else if (r.outcome === "flagged") result.flagged += 1
      else if (r.outcome === "already_filed") result.alreadyFiled += 1
      else result.skipped += 1
    } catch (e) {
      result.errors.push(`${d.id}: ${(e as Error).message}`)
    }
  }

  return result
}
