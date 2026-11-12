/**
 * lib/documents/receipt-intake.ts — RECEIPT → BOOKS, THE GOVERNED FLOW (wave 152, lane 152D).
 *
 * UPLOAD / PHOTO / DIGITAL RECEIPT
 *   → document row (tenant + uploader from the SESSION; the bytes' sha256 is the document version)
 *   → READ (lib/documents/ocr-pdf.ts: native text first, the routed vision lane for photos/scans, metered)
 *   → CLASSIFY + EXTRACT (a model PROPOSES through the routed, metered gateway; lib/documents/receipt-rules.ts checks
 *     every proposed value against the page it cites — unknown stays unknown)
 *   → DUPLICATES (same file in this tenant · same merchant + date + total already on the books)
 *   → COST CENTER under the existing authority (agent / team / brokerage — the roster logScopedExpense enforces)
 *   → CATEGORY suggestion · VALIDATION (sums, tax, date, open period, currency, evidence)
 *   → DRAFT FIELDS on the EXISTING ledger (document_field_extractions, one evidenced row per field)
 *   → POLICY DECISION (policy_decisions: green auto-post only under an approved grant; amber review; red refuse)
 *   → on approval: THE ONE WRITER (app/actions/financials.ts logScopedExpense, injected as `postExpense`) inside
 *     withActionLedger (who, why, which document, idempotent per document) → fields stamped verified by the human →
 *     the document carries the posted expense id; the expense carries an in-app link back to the receipt
 *   → confirmation or recovery copy in the tenant message contract.
 *
 * No second accounting system: nothing here inserts into business_expenses. No new OCR repository: the reading is
 * kept on the document row and the facts on the existing extraction ledger. No new arbiter: the decision is the
 * document kernel's policy ledger, the grant is the existing per-manager grant row (autonomy-ratchet.ts loadGrantsFor,
 * fail closed), the evidence is the action ledger. A receipt never touches a transaction's closing figures, a CD or a
 * CDA — the only transaction effect is an evidenced link on the document itself.
 */

import "server-only"
import { createHash } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { ocrDocumentFromBuffer, type ReaderSeams } from "./ocr-pdf"
import { recordFieldExtractions, readDocumentExtractions, type DocumentExtraction } from "./field-extraction-ledger"
import { recordPolicyDecision } from "./policy-decisions"
import { loadGrantsFor } from "./autonomy-ratchet"
import { withActionLedger } from "@/lib/kernel/action-ledger"
import { isBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"
import {
  RECEIPT_FIELDS, POSTED_EXPENSE_FIELD_KEY, FINANCIAL_DOCUMENT_KINDS,
  buildReceiptProposal, validateReceipt, findReceiptDuplicates, decideReceiptPosting, autopostGrantFor, postingClassFor,
  splitPages, normalizeUsd, normalizeIsoDate, canonicalExpenseCategory, financialKindLabel, receiptTenantMessage,
  transactionLinkVerdict, reversalMarker,
  type FieldEnvelope, type FinancialDocumentKind, type ReceiptIssue, type DuplicateFinding, type TenantMessage, type ReceiptAction, type LineItem,
} from "./receipt-rules"

type Svc = SupabaseClient<any, any, any>

/** documents.document_type for a receipt (no CHECK on that column; documents.classification stays 'other' — the deal-file taxonomy is not widened for books). */
const RECEIPT_DOCUMENT_TYPE = "expense_receipt"
/** The PRIVATE bucket receipts already live in (app/actions/financials.ts attachExpenseReceipt). */
export const RECEIPT_BUCKET = "receipts"
const RECEIPT_EXTRACTOR = "receipt_reader@1"

/** The SESSION actor — resolved by the calling server action, never from a request body (CLAUDE.md §4). */
export interface ReceiptActor { userId: string; agentId: string | null; teamId: string | null; brokerageId: string; userType: string }

type ExpenseScope = "agent" | "team" | "brokerage"

/** What the ONE writer takes — app/actions/financials.ts logScopedExpense's input, verbatim. */
interface ScopedExpenseRequest {
  scope: ExpenseScope
  category: string
  description: string
  amount: number
  expenseDate: string
  teamId?: string | null
  agentId?: string | null
  receiptUrl?: string | null
  reversalOfExpenseId?: string | null
}

interface ReceiptSeams {
  reader?: ReaderSeams
  /** The routed, metered text call that proposes the fields. */
  extract?: (input: { system: string; prompt: string; brokerageId: string; userId: string }) => Promise<{ ok: boolean; text: string | null; error?: string | null }>
  grants?: (svc: Svc, brokerageId: string) => Promise<Set<string>>
  /** THE ONE WRITER. Required to post; the server action passes logScopedExpense. */
  postExpense?: (input: ScopedExpenseRequest) => Promise<{ success: boolean; expenseId?: string; error?: string }>
  now?: () => Date
}

type ReviewStateName = "reading" | "unreadable" | "held" | "posting" | "posted" | "duplicate" | "not_postable" | "not_a_receipt" | "rejected" | "not_saved"

interface ReceiptOutcome {
  ok: boolean
  documentId: string | null
  state: ReviewStateName
  message: TenantMessage
  reasons: string[]
  expenseId?: string | null
  /** INTERNAL detail for the flight recorder — never rendered to the tenant. */
  internal?: string | null
}

const EXTRACTION_SYSTEM = "You read receipts, invoices and payment documents for a real-estate business's books. Output JSON only — no prose, no markdown."

function extractionPrompt(pagesText: string): string {
  return `Read the document text below (pages are marked "=== PAGE n ==="). Return ONLY this JSON object:
{
  "document_kind": "receipt" | "paid_invoice" | "payment_proof" | "refund" | "credit_memo" | "invoice_due" | "statement" | "quote" | "not_financial",
  "kind_confidence": "high" | "medium" | "low",
  "kind_evidence": { "page": <n>, "excerpt": "<words copied from that page that show what this document is>" },
  "merchant":       { "value": "<the business that was paid>", "page": <n>, "excerpt": "<verbatim>", "confidence": "high" | "medium" | "low" },
  "date":           { "value": "YYYY-MM-DD", "page": <n>, "excerpt": "<verbatim>", "confidence": "..." },
  "total":          { "value": "<the amount exactly as printed, e.g. 43.17>", "page": <n>, "excerpt": "<verbatim>", "confidence": "..." },
  "subtotal":       { ...same shape... },
  "tax":            { ...same shape... },
  "tip":            { ...same shape... },
  "balance_due":    { ...same shape... },
  "currency":       { "value": "<ISO code only if printed, else null>", "page": <n>, "excerpt": "<verbatim>", "confidence": "..." },
  "payment_method": { "value": "<e.g. VISA ending 1234, cash, check 1042>", "page": <n>, "excerpt": "<verbatim>", "confidence": "..." },
  "line_items": [ { "description": "<as printed>", "quantity": <number or null>, "amount": "<as printed>", "page": <n>, "excerpt": "<the whole line, verbatim>" } ],
  "category_suggestion": "marketing" | "office" | "technology" | "education" | "transportation" | "other",
  "summary": "<one or two sentences: who was paid, for what, when, how much, and anything that looks wrong>",
  "problems": ["<anything unreadable, contradictory or unusual>"]
}
Rules:
- Every excerpt is copied VERBATIM from the page it cites, so it can be found on that page.
- Use null for any value the document does not show. Never compute, total, convert, round or estimate a number.
- Never supply a year that is not printed. If only a month and day are printed, return null for date.
- "paid_invoice" only when the document shows it was paid (a PAID mark, a payment method, or a zero balance). An invoice with an amount still due is "invoice_due".
- A refund or a credit is "refund" or "credit_memo", never "receipt".
- A contract, addendum, disclosure, closing statement, settlement statement or any other non-payment document is "not_financial".

DOCUMENT TEXT:
${pagesText}`
}

async function defaultExtract(input: { system: string; prompt: string; brokerageId: string; userId: string }) {
  try {
    const { generateTextRouted } = await import("@/lib/ai/models")
    const { text } = await generateTextRouted({ brokerageId: input.brokerageId, userId: input.userId, feature: "document_classification", system: input.system, prompt: input.prompt, temperature: 0, maxTokens: 2_000 })
    return { ok: true, text }
  } catch (e) {
    return { ok: false, text: null, error: (e as Error).message }
  }
}

const defaultGrants = (svc: Svc, brokerageId: string) => loadGrantsFor(svc, brokerageId, "finance_manager", "expense_grants")

/** The in-app locator a posted expense carries (`business_expenses.receipt_url`). It authorizes nothing: the receipt page gates the reader. */
function receiptLink(documentId: string): string { return `/dashboard/financials/expenses/receipts/${documentId}` }

const STATE_FOR: Record<ReceiptAction, ReviewStateName> = {
  post: "posting", hold_for_review: "held", refuse_duplicate: "duplicate", not_postable: "not_postable", not_a_receipt: "not_a_receipt",
}

// ─── cost center under the EXISTING authority ─────────────────────────────────

function proposeScope(actor: ReceiptActor): ExpenseScope | null {
  if (actor.agentId) return "agent"
  if (isBrokerageFinanceAdmin({ user_type: actor.userType })) return "brokerage"
  if (actor.teamId) return "team"
  return null
}

/**
 * WHO MAY BRING A RECEIPT AT ALL: a seat that keeps some books — an agent's, a team's, or (books-keeper roster) the
 * brokerage's. A Contact or a vendor seat keeps none here (contacts, lenders and vendors see no financials but their
 * own — CLAUDE.md §5), so the door refuses BEFORE a file is stored or AI is spent on the tenant's budget.
 */
export function mayKeepReceipts(actor: ReceiptActor): boolean {
  return proposeScope(actor) !== null
}

const NO_BOOKS_COPY: TenantMessage = {
  whatHappened: "Receipts are recorded on an agent's, a team's or the brokerage's books, and this sign-in keeps none of them.",
  whatItAffects: "Nothing was uploaded or recorded.",
  saved: "Nothing was saved.",
  whoActs: "An account admin can confirm your seat if you should be keeping expenses.",
  action: "Back",
}

/**
 * The same three gates logScopedExpense applies (it applies them AGAIN at the write — this is the pre-gate the proof
 * can drive). Brokerage books: the brokerage-money roster (isBrokerageFinanceAdmin, which holds team_lead out — m472).
 */
function resolveScope(actor: ReceiptActor, requested: ExpenseScope | null, teamId: string | null | undefined):
  { ok: true; scope: ExpenseScope; teamId: string | null } | { ok: false; code: string } {
  const finance = isBrokerageFinanceAdmin({ user_type: actor.userType })
  const scope = requested ?? proposeScope(actor)
  if (scope === "agent") return actor.agentId ? { ok: true, scope, teamId: null } : { ok: false, code: "no_agent_context" }
  if (scope === "team") {
    const team = teamId ?? actor.teamId
    if (!team) return { ok: false, code: "no_team_context" }
    if (!finance && actor.userType !== "team_lead" && team !== actor.teamId) return { ok: false, code: "forbidden_team_scope" }
    return { ok: true, scope, teamId: team }
  }
  if (scope === "brokerage") return finance ? { ok: true, scope, teamId: null } : { ok: false, code: "forbidden_brokerage_scope" }
  return { ok: false, code: "no_scope" }
}

const WRITER_COPY: Record<string, string> = {
  forbidden_brokerage_scope: "Only an account admin who keeps the brokerage's books can record a brokerage expense.",
  forbidden_team_scope: "You can record team expenses only for your own team.",
  team_not_in_brokerage: "That team is not part of this account.",
  no_team_context: "Choose the team this expense belongs to.",
  no_agent_context: "Your agent profile is not set up yet, so this cannot go on an agent's books.",
  forbidden_agent_scope: "Only an account admin who keeps the books can record an expense for another agent.",
  reversal_original_not_found: "The expense this refund reverses could not be found in your books.",
  reversal_original_not_an_expense: "A refund can only reverse a recorded expense.",
  reversal_exceeds_original: "The refund is larger than what is left of the expense it reverses.",
  reversal_scope_mismatch: "A refund must be recorded on the same books as the expense it reverses.",
  amount_invalid: "The total must be a positive dollar amount.",
  date_invalid: "The date must be a full date.",
  description_required: "The merchant is needed before this can be recorded.",
}
const writerCopy = (code: string | null | undefined) => WRITER_COPY[String(code ?? "")] ?? "The expense could not be recorded."

// ─── reads ────────────────────────────────────────────────────────────────────

async function loadReceiptDocument(svc: Svc, actor: ReceiptActor, documentId: string):
  Promise<{ ok: true; doc: { id: string; status: string; metadata: Record<string, any>; content: string | null; summary: string | null; transaction_id: string | null } } | { ok: false; reason: string; internal?: string }> {
  // TENANT PIN: the actor's brokerage AND the receipt type — another tenant's receipt (or a deal document) reads as absent.
  const { data, error } = await svc
    .from("documents")
    .select("id, status, metadata, content, summary, transaction_id")
    .eq("id", documentId)
    .eq("brokerage_id", actor.brokerageId)
    .eq("document_type", RECEIPT_DOCUMENT_TYPE)
    .maybeSingle()
  if (error) return { ok: false, reason: "The receipt could not be opened right now.", internal: error.message }
  if (!data) return { ok: false, reason: "That receipt is not in your account." }
  const metadata = ((data as any).metadata ?? {}) as Record<string, any>
  // WHO MAY SEE / ACT: the uploader, or an account admin who keeps the brokerage's books.
  if (metadata.uploaded_by !== actor.userId && !isBrokerageFinanceAdmin({ user_type: actor.userType })) {
    return { ok: false, reason: "That receipt belongs to someone else's books." }
  }
  return { ok: true, doc: { id: String((data as any).id), status: String((data as any).status), metadata, content: ((data as any).content as string | null) ?? null, summary: ((data as any).summary as string | null) ?? null, transaction_id: ((data as any).transaction_id as string | null) ?? null } }
}

async function findDuplicates(svc: Svc, brokerageId: string, documentId: string, sha: string | null, merchant: string | null, date: string | null, total: number | null):
  Promise<{ ok: true; found: DuplicateFinding } | { ok: false; error: string }> {
  // A REFUSED duplicate read is not "no duplicates" — the receipt is held, never posted blind (CLAUDE.md §3).
  let sameHash: Array<{ id: string; postedExpenseId: string | null }> = []
  if (sha) {
    const { data, error } = await svc.from("documents").select("id, metadata").eq("brokerage_id", brokerageId).eq("document_type", RECEIPT_DOCUMENT_TYPE).eq("metadata->>file_sha256", sha)
    if (error) return { ok: false, error: `duplicate-file read refused: ${error.message}` }
    sameHash = ((data ?? []) as Array<{ id: string; metadata: any }>)
      .filter((d) => d.id !== documentId && d.metadata?.receipt_review?.state !== "rejected")
      .map((d) => ({ id: d.id, postedExpenseId: (d.metadata?.receipt_review?.posted_expense_id as string | undefined) ?? null }))
  }
  let candidates: Array<{ id: string; description: string | null; amount: number | null; expense_date: string | null }> = []
  if (date && total !== null) {
    // Every writer that can land a charge (manual entry, the kernel writer, a future books import) lands it HERE.
    const { data, error } = await svc.from("business_expenses").select("id, description, amount, expense_date").eq("brokerage_id", brokerageId).eq("expense_date", date)
    if (error) return { ok: false, error: `duplicate-charge read refused: ${error.message}` }
    candidates = (data ?? []) as typeof candidates
  }
  return { ok: true, found: findReceiptDuplicates({ sameHashDocuments: sameHash, candidateExpenses: candidates, merchant, date, total }) }
}

async function updateReview(svc: Svc, documentId: string, brokerageId: string, patch: { status?: string; review: Record<string, unknown>; extra?: Record<string, unknown>; metadata: Record<string, any> }): Promise<string | null> {
  const { data, error } = await svc
    .from("documents")
    .update({ ...(patch.extra ?? {}), ...(patch.status ? { status: patch.status } : {}), metadata: { ...patch.metadata, receipt_review: { ...(patch.metadata.receipt_review ?? {}), ...patch.review } }, updated_at: new Date().toISOString() })
    .eq("id", documentId)
    .eq("brokerage_id", brokerageId)
    .select("id")
  if (error) return error.message
  if (!Array.isArray(data) || data.length !== 1) return "the receipt row was not updated"
  return null
}

function fieldsFromRows(rows: DocumentExtraction[]): Record<string, FieldEnvelope> {
  const out: Record<string, FieldEnvelope> = {}
  for (const r of rows) if (r.envelope && r.fieldKey in RECEIPT_FIELDS) out[r.fieldKey] = r.envelope as unknown as FieldEnvelope
  return out
}

const today = (now: Date) => now.toISOString().slice(0, 10)

// ─── INTAKE ───────────────────────────────────────────────────────────────────

export async function intakeReceipt(
  svc: Svc,
  input: { actor: ReceiptActor; file: { buffer: Buffer; mime: string; name: string | null }; objectPath: string; transactionId?: string | null },
  seams: ReceiptSeams = {},
): Promise<ReceiptOutcome> {
  const { actor } = input
  if (!mayKeepReceipts(actor)) return { ok: false, documentId: null, state: "not_saved", message: NO_BOOKS_COPY, reasons: [], internal: `seat ${actor.userType} keeps no books` }
  const now = (seams.now ?? (() => new Date()))()
  const sha = createHash("sha256").update(input.file.buffer).digest("hex")

  const baseMeta: Record<string, any> = {
    uploaded_by: actor.userId,
    uploaded_by_agent_id: actor.agentId,
    file_sha256: sha,
    storage_bucket: RECEIPT_BUCKET,
    storage_object_path: input.objectPath,
    mime: input.file.mime,
    file_name: input.file.name,
    receipt_review: { state: "reading" },
  }
  const { data: inserted, error: insErr } = await svc
    .from("documents")
    .insert({ brokerage_id: actor.brokerageId, document_type: RECEIPT_DOCUMENT_TYPE, status: "review", classification: "other", storage_url: null, metadata: baseMeta })
    .select("id")
    .single()
  if (insErr || !inserted) return { ok: false, documentId: null, state: "not_saved", message: receiptTenantMessage("not_saved"), reasons: [], internal: insErr?.message ?? "no row" }
  const documentId = String((inserted as any).id)

  // READ — native text, or the routed vision lane (metered, entitlement asked first).
  const read = await ocrDocumentFromBuffer({ buffer: input.file.buffer, mime: input.file.mime, fileName: input.file.name, brokerageId: actor.brokerageId, userId: actor.userId, manager: "finance_manager" }, seams.reader ?? {})
  if (!read.success) {
    await recordPolicyDecision(svc, { brokerageId: actor.brokerageId, documentId, targetType: "receipt_expense", verdict: { decision: "red", reasons: ["the receipt could not be read"], recommendedAction: "enter_by_hand_or_retake", requiredApproverRole: null }, evidence: { sha256: sha, reader_error: read.error ?? null } })
    const err = await updateReview(svc, documentId, actor.brokerageId, { metadata: baseMeta, review: { state: "unreadable", reader_error: read.error ?? null }, extra: { scan_error: read.error ?? "unreadable", scanned_at: now.toISOString() } })
    return { ok: false, documentId, state: "unreadable", message: receiptTenantMessage("unreadable"), reasons: [], internal: [read.error, err].filter(Boolean).join("; ") }
  }
  const pages = read.pages && read.pages.length ? read.pages : splitPages(read.text)
  const pagesText = pages.map((p) => `=== PAGE ${p.page} ===\n${p.text}`).join("\n")

  // PROPOSE — a model reads the text and proposes; nothing it says is used unchecked.
  const extracted = await (seams.extract ?? defaultExtract)({ system: EXTRACTION_SYSTEM, prompt: extractionPrompt(pagesText), brokerageId: actor.brokerageId, userId: actor.userId })
  let model: Record<string, unknown> | null = null
  if (extracted.ok && extracted.text) {
    const m = extracted.text.match(/\{[\s\S]*\}/)
    try { model = m ? (JSON.parse(m[0]) as Record<string, unknown>) : null } catch { model = null }
  }
  if (!model) {
    const err = await updateReview(svc, documentId, actor.brokerageId, { metadata: baseMeta, review: { state: "unreadable", reader_error: extracted.error ?? "the reading could not be understood" }, extra: { content: pagesText, scan_error: "extraction_unparsed", scanned_at: now.toISOString() } })
    return { ok: false, documentId, state: "unreadable", message: receiptTenantMessage("unreadable"), reasons: [], internal: [extracted.error, err].filter(Boolean).join("; ") }
  }

  const proposal = buildReceiptProposal({ model, pages, readBy: read.reader ?? "vision", qualityFlags: read.quality_flags ?? [], docSha256: sha, extractor: RECEIPT_EXTRACTOR, nowIso: now.toISOString() })
  const f = proposal.fields
  const merchant = typeof f["expense.merchant"].value === "string" ? f["expense.merchant"].value : null
  const date = typeof f["expense.date"].value === "string" ? f["expense.date"].value : null
  const total = typeof f["expense.total"].value === "number" ? f["expense.total"].value : null

  // TRANSACTION LINK — only on evidence the receipt itself shows (a scanned receipt never touches a deal's figures).
  let linkedTransactionId: string | null = null
  let transactionLink: Record<string, unknown> | null = null
  if (input.transactionId) {
    const { data: tx, error: txErr } = await svc.from("transactions").select("id, property_address").eq("id", input.transactionId).eq("brokerage_id", actor.brokerageId).maybeSingle()
    const verdict = !txErr && tx ? transactionLinkVerdict(pagesText, ((tx as any).property_address as string | null) ?? null) : "not_evidenced"
    if (verdict === "evidenced") linkedTransactionId = String((tx as any).id)
    transactionLink = { requested: input.transactionId, verdict, reason: txErr ? "transaction read refused" : !tx ? "not in this account" : null }
  }

  const dup = await findDuplicates(svc, actor.brokerageId, documentId, sha, merchant, date, total)
  const issues: ReceiptIssue[] = validateReceipt(f, { today: today(now) })
  if (!dup.ok) issues.push({ code: "duplicate_check_unavailable", field: null, blocking: true, message: "We could not check whether this charge is already recorded." })
  const duplicates: DuplicateFinding = dup.ok ? dup.found : { exactFile: null, sameCharge: [] }

  const grants = await (seams.grants ?? defaultGrants)(svc, actor.brokerageId)
  const decision = decideReceiptPosting({ kind: proposal.kind, fields: f, issues, duplicates, autopost: autopostGrantFor(grants, proposal.kind) })

  // DRAFT FIELDS on the existing ledger — one evidenced row per fact; a write that did not land is said.
  const recorded = await recordFieldExtractions(svc, { documentId, brokerageId: actor.brokerageId, fields: f, confidence: "low", confidenceByField: proposal.confidenceByField, extractionModel: `${RECEIPT_EXTRACTOR}:${read.reader ?? "vision"}` })
  if (recorded.error) {
    const err = await updateReview(svc, documentId, actor.brokerageId, { metadata: baseMeta, review: { state: "not_saved" }, extra: { content: pagesText, scan_error: "draft_fields_not_saved" } })
    return { ok: false, documentId, state: "not_saved", message: receiptTenantMessage("not_saved"), reasons: [], internal: [recorded.error, err].filter(Boolean).join("; ") }
  }

  await recordPolicyDecision(svc, {
    brokerageId: actor.brokerageId, transactionId: linkedTransactionId, documentId, targetType: "receipt_expense",
    verdict: { decision: decision.color, reasons: decision.reasons, recommendedAction: decision.action, requiredApproverRole: decision.action === "hold_for_review" ? "uploader_or_finance_admin" : null },
    evidence: { sha256: sha, kind: proposal.kind, read_by: read.reader ?? null, quality_flags: read.quality_flags ?? [], issues: issues.map((i) => i.code), duplicates, autopost_grant: decision.action === "post" },
  })

  const proposedScope = proposeScope(actor)
  const reviewState = STATE_FOR[decision.action]
  const updErr = await updateReview(svc, documentId, actor.brokerageId, {
    metadata: baseMeta,
    status: decision.action === "hold_for_review" || decision.action === "post" ? "review" : "archived",
    review: { state: reviewState, kind: proposal.kind, issues, duplicates, reasons: decision.reasons, proposed_scope: proposedScope, read_by: read.reader ?? null, quality_flags: read.quality_flags ?? [], ...(transactionLink ? { transaction_link: transactionLink } : {}) },
    extra: {
      // The AI summary is a reading aid, never an authoritative record.
      summary: proposal.summary,
      extracted_fields: model,
      content: pagesText,
      classification_confidence: f["expense.document_kind"].confidence,
      scanned_at: now.toISOString(),
      scan_error: null,
      ...(linkedTransactionId ? { transaction_id: linkedTransactionId } : {}),
    },
  })
  if (updErr) return { ok: false, documentId, state: "not_saved", message: receiptTenantMessage("not_saved"), reasons: decision.reasons, internal: updErr }

  if (decision.action === "post") {
    // AUTO-POST under the approved grant — the same governed writer path a person's approval takes.
    return approveReceipt(svc, { actor, documentId, scope: proposedScope, viaPolicy: true }, seams)
  }
  const message = receiptTenantMessage(decision.action, { reason: decision.reasons[0] ?? null })
  return { ok: decision.action === "hold_for_review", documentId, state: reviewState, message, reasons: decision.reasons }
}

// ─── APPROVE → THE ONE WRITER ─────────────────────────────────────────────────

function applyCorrection(prev: FieldEnvelope | undefined, key: string, raw: string, actorId: string, nowIso: string): { ok: true; env: FieldEnvelope } | { ok: false; reason: string } {
  const spec = (RECEIPT_FIELDS as Record<string, { label: string; unit: string; destination: string | null }>)[key]
  if (!spec || spec.unit === "line_items") return { ok: false, reason: `${key} cannot be corrected here` }
  const s = raw.trim()
  let value: string | number | null
  switch (spec.unit) {
    case "usd": value = normalizeUsd(s); break
    case "date": value = normalizeIsoDate(s); break
    case "currency_code": value = /^[A-Za-z]{3}$/.test(s) ? s.toUpperCase() : null; break
    case "kind": value = (FINANCIAL_DOCUMENT_KINDS as readonly string[]).includes(s) ? s : null; break
    case "category": value = canonicalExpenseCategory(s); break
    default: value = s ? s.slice(0, 200) : null
  }
  if (value === null) return { ok: false, reason: `"${s}" is not a valid ${spec.label.toLowerCase()}` }
  const base: FieldEnvelope = prev ?? {
    v: 1, value: null, raw: null, unit: spec.unit as FieldEnvelope["unit"], page: null, excerpt: null, bbox: null, evidence_located: false, uncertainty: null,
    destination: spec.destination, doc_sha256: null, extractor: "human", read_by: "human", extracted_at: nowIso, review_state: "draft", confidence: "high", conflict: null,
  }
  return { ok: true, env: { ...base, value, read_by: "human", uncertainty: null, confidence: "high", review_state: "corrected", corrected_from: prev?.value ?? null, extracted_at: nowIso, extractor: `human:${actorId}` } }
}

export async function approveReceipt(
  svc: Svc,
  input: { actor: ReceiptActor; documentId: string; corrections?: Record<string, string>; scope?: ExpenseScope | null; teamId?: string | null; confirmNotDuplicate?: boolean; reversalOfExpenseId?: string | null; viaPolicy?: boolean },
  seams: ReceiptSeams = {},
): Promise<ReceiptOutcome> {
  const { actor } = input
  const now = (seams.now ?? (() => new Date()))()
  const loaded = await loadReceiptDocument(svc, actor, input.documentId)
  if (!loaded.ok) return { ok: false, documentId: input.documentId, state: "held", message: { ...receiptTenantMessage("hold_for_review"), whatHappened: loaded.reason }, reasons: [loaded.reason], internal: loaded.internal ?? null }
  const doc = loaded.doc
  const review = (doc.metadata.receipt_review ?? {}) as Record<string, any>
  if (review.state === "posted") {
    return { ok: true, documentId: doc.id, state: "posted", message: receiptTenantMessage("posted"), reasons: ["already recorded"], expenseId: review.posted_expense_id ?? null }
  }
  if (review.state === "rejected" || review.state === "duplicate") {
    const reason = review.state === "rejected" ? "This receipt was declined; upload it again to record it." : "This exact file was already uploaded."
    return { ok: false, documentId: doc.id, state: review.state, message: receiptTenantMessage(review.state === "rejected" ? "rejected" : "refuse_duplicate"), reasons: [reason] }
  }
  const postExpense = seams.postExpense
  if (!postExpense) return { ok: false, documentId: doc.id, state: "held", message: receiptTenantMessage("hold_for_review"), reasons: ["no expense writer"], internal: "approveReceipt called without the expense writer" }

  const ledger = await readDocumentExtractions(svc, { brokerageId: actor.brokerageId, documentIds: [doc.id], keyPrefix: "expense." })
  if (!ledger.ok) return { ok: false, documentId: doc.id, state: "held", message: receiptTenantMessage("hold_for_review"), reasons: ["The receipt details could not be loaded."], internal: ledger.error }
  const fields = fieldsFromRows(ledger.rows)

  // Human corrections — each one becomes human evidence on its own field; the AI's value is kept as corrected_from.
  for (const [key, raw] of Object.entries(input.corrections ?? {})) {
    if (typeof raw !== "string" || raw.trim() === "") continue
    const c = applyCorrection(fields[key], key, raw, actor.userId, now.toISOString())
    if (!c.ok) return { ok: false, documentId: doc.id, state: "held", message: { ...receiptTenantMessage("hold_for_review"), whatHappened: c.reason }, reasons: [c.reason] }
    fields[key] = c.env
  }

  const kind = (fields["expense.document_kind"]?.value ?? "not_financial") as FinancialDocumentKind
  const cls = postingClassFor(kind)
  const merchant = typeof fields["expense.merchant"]?.value === "string" ? (fields["expense.merchant"].value as string) : null
  const date = typeof fields["expense.date"]?.value === "string" ? (fields["expense.date"].value as string) : null
  const total = typeof fields["expense.total"]?.value === "number" ? (fields["expense.total"].value as number) : null
  const issues = validateReceipt(fields, { today: today(now) })
  const dup = await findDuplicates(svc, actor.brokerageId, doc.id, (doc.metadata.file_sha256 as string | undefined) ?? null, merchant, date, total)
  const refuse = (reasons: string[], action: ReceiptAction = "hold_for_review"): ReceiptOutcome =>
    ({ ok: false, documentId: doc.id, state: STATE_FOR[action] === "posting" ? "held" : STATE_FOR[action], message: { ...receiptTenantMessage(action, { reason: reasons[0] }), ...(action === "hold_for_review" ? { whatHappened: reasons[0] ?? "Some details still need review." } : {}) }, reasons })

  if (cls === "not_financial") return refuse([financialKindLabel(kind) + " — this is not a receipt, so it cannot be recorded as an expense."], "not_a_receipt")
  if (cls === "not_postable") return refuse([`${financialKindLabel(kind)} — this is not proof of payment, so it is not recorded as an expense.`], "not_postable")
  if (!dup.ok) return refuse(["We could not check whether this charge is already recorded; nothing was recorded."])
  if (dup.found.exactFile?.postedExpenseId) return refuse(["This exact file was already recorded as an expense."], "refuse_duplicate")
  const blocking = issues.filter((i) => i.blocking)
  if (blocking.length) return refuse(blocking.map((i) => i.message))
  if (dup.found.sameCharge.length && !input.confirmNotDuplicate) return refuse(["An expense with the same merchant, date and total is already recorded. Confirm this is a different purchase to record it."])
  if (cls === "reversal" && !input.reversalOfExpenseId) return refuse(["Choose the expense this refund reverses."])
  if (merchant === null || date === null || total === null) return refuse(["The merchant, date and total are needed."])

  const scope = resolveScope(actor, input.scope ?? (review.proposed_scope as ExpenseScope | null) ?? null, input.teamId)
  if (!scope.ok) return refuse([writerCopy(scope.code)])

  const category = canonicalExpenseCategory(String(fields["expense.category"]?.value ?? "")) ?? "other"
  const request: ScopedExpenseRequest = {
    scope: scope.scope,
    category,
    description: cls === "reversal" ? `Refund — ${merchant} ${reversalMarker(String(input.reversalOfExpenseId))}` : merchant,
    amount: total,
    expenseDate: date,
    teamId: scope.teamId,
    receiptUrl: receiptLink(doc.id),
    ...(cls === "reversal" ? { reversalOfExpenseId: input.reversalOfExpenseId ?? null } : {}),
  }
  const result = await withActionLedger(
    {
      brokerageId: actor.brokerageId,
      action: "finance.expense.post_from_document",
      actor: input.viaPolicy ? { type: "manager", managerKey: "finance_manager", userId: actor.userId } : { type: "user", userId: actor.userId, agentId: actor.agentId },
      subject: { type: "document", id: doc.id },
      idempotencyKey: `receipt_post:${doc.id}`,
      riskClass: "FINANCIAL",
      reasonCode: "HUMAN_REQUESTED",
      reasonDetail: input.viaPolicy ? "receipt auto-posted under the account's approved receipt grant" : "receipt approved by a person on the review page",
      detail: { kind, scope: scope.scope, amount: total, expense_date: date, category, corrected_fields: Object.keys(input.corrections ?? {}), confirmed_not_duplicate: input.confirmNotDuplicate === true, reversal_of: input.reversalOfExpenseId ?? null, sha256: doc.metadata.file_sha256 ?? null },
    },
    () => postExpense(request),
    {
      settle: (r) => (r.success
        ? { status: "executed", outcome: "expense_recorded", provider: "business_expenses", providerRef: r.expenseId ?? null, costUsd: null }
        : { status: "failed", outcome: "writer_refused", error: r.error ?? null }),
      replay: (claim) => (claim.kind === "replay"
        ? { success: true, expenseId: claim.entry.provider_ref ?? undefined }
        : { success: false, error: claim.kind === "refused" ? "ledger_refused" : `earlier_attempt_${claim.kind}` }),
    },
    { client: svc },
  )

  if (!result.success) {
    await updateReview(svc, doc.id, actor.brokerageId, { metadata: doc.metadata, review: { state: "held", last_error: result.error ?? null, last_attempt_at: now.toISOString() } })
    return refuse([writerCopy(result.error)])
  }
  const expenseId = result.expenseId ?? null

  // THE TRAIL: every field carries the review outcome; a person's approval stamps verified_by on the ledger rows.
  const nowIso = now.toISOString()
  const finalFields: Record<string, FieldEnvelope> = {}
  for (const [k, env] of Object.entries(fields)) finalFields[k] = { ...env, review_state: "posted" }
  finalFields[POSTED_EXPENSE_FIELD_KEY] = {
    v: 1, value: expenseId, raw: null, unit: "expense_id", page: null, excerpt: null, bbox: null, evidence_located: false, uncertainty: null,
    destination: "business_expenses.id", doc_sha256: (doc.metadata.file_sha256 as string | undefined) ?? null, extractor: input.viaPolicy ? "policy:receipt_autopost" : `human:${actor.userId}`,
    read_by: "human", extracted_at: nowIso, review_state: "posted", confidence: "high", conflict: null,
  }
  const confidenceByField: Record<string, "high" | "medium" | "low"> = {}
  for (const [k, env] of Object.entries(finalFields)) confidenceByField[k] = env.confidence
  const rewrite = await recordFieldExtractions(svc, { documentId: doc.id, brokerageId: actor.brokerageId, fields: finalFields, confidence: "low", confidenceByField, extractionModel: `${RECEIPT_EXTRACTOR}:reviewed` })
  let trailError: string | null = rewrite.error ?? null
  if (!input.viaPolicy) {
    const { data: stamped, error: stampErr } = await svc
      .from("document_field_extractions")
      .update({ verified_by_user_id: actor.userId, verified_at: nowIso })
      .eq("document_id", doc.id)
      .eq("brokerage_id", actor.brokerageId)
      .in("field_key", Object.keys(finalFields))
      .select("id")
    if (stampErr) trailError = [trailError, `verification stamp refused: ${stampErr.message}`].filter(Boolean).join("; ")
    else if (!Array.isArray(stamped) || stamped.length === 0) trailError = [trailError, "verification stamp matched no rows"].filter(Boolean).join("; ")
  }
  await recordPolicyDecision(svc, {
    brokerageId: actor.brokerageId, transactionId: doc.transaction_id, documentId: doc.id, targetType: "receipt_expense", targetId: expenseId,
    verdict: { decision: "green", reasons: [input.viaPolicy ? "posted under the approved receipt grant" : "a person reviewed and approved the receipt"], recommendedAction: input.viaPolicy ? "receipt_auto_posted" : "receipt_posted_by_human", requiredApproverRole: null },
    evidence: { expense_id: expenseId, scope: scope.scope, kind, corrected_fields: Object.keys(input.corrections ?? {}), reversal_of: input.reversalOfExpenseId ?? null },
  })
  const docErr = await updateReview(svc, doc.id, actor.brokerageId, {
    metadata: doc.metadata, status: "complete",
    review: { state: "posted", posted_expense_id: expenseId, decided_by: actor.userId, decided_at: nowIso, via: input.viaPolicy ? "policy" : "person", scope: scope.scope, last_error: null },
  })
  if (docErr) trailError = [trailError, `receipt state not updated: ${docErr}`].filter(Boolean).join("; ")
  return { ok: true, documentId: doc.id, state: "posted", message: receiptTenantMessage("posted"), reasons: [], expenseId, internal: trailError }
}

// ─── REJECT — evidence kept, nothing posted ───────────────────────────────────

export async function rejectReceipt(svc: Svc, input: { actor: ReceiptActor; documentId: string; reason?: string | null }, seams: ReceiptSeams = {}): Promise<ReceiptOutcome> {
  const { actor } = input
  const now = (seams.now ?? (() => new Date()))()
  const loaded = await loadReceiptDocument(svc, actor, input.documentId)
  if (!loaded.ok) return { ok: false, documentId: input.documentId, state: "held", message: { ...receiptTenantMessage("hold_for_review"), whatHappened: loaded.reason }, reasons: [loaded.reason], internal: loaded.internal ?? null }
  const doc = loaded.doc
  if (doc.metadata.receipt_review?.state === "posted") {
    const reason = "This receipt is already recorded. To undo it, upload the refund or correct the expense."
    return { ok: false, documentId: doc.id, state: "posted", message: { ...receiptTenantMessage("posted"), whatHappened: reason }, reasons: [reason] }
  }
  const ledger = await readDocumentExtractions(svc, { brokerageId: actor.brokerageId, documentIds: [doc.id], keyPrefix: "expense." })
  if (ledger.ok) {
    const fields = fieldsFromRows(ledger.rows)
    for (const k of Object.keys(fields)) fields[k] = { ...fields[k], review_state: "rejected" }
    await recordFieldExtractions(svc, { documentId: doc.id, brokerageId: actor.brokerageId, fields, confidence: "low", confidenceByField: Object.fromEntries(Object.entries(fields).map(([k, e]) => [k, e.confidence])), extractionModel: `${RECEIPT_EXTRACTOR}:reviewed` })
  }
  await recordPolicyDecision(svc, { brokerageId: actor.brokerageId, documentId: doc.id, targetType: "receipt_expense", verdict: { decision: "red", reasons: [input.reason?.trim() || "declined by a person"], recommendedAction: "receipt_rejected_by_human", requiredApproverRole: null }, evidence: { decided_by: actor.userId } })
  const err = await updateReview(svc, doc.id, actor.brokerageId, { metadata: doc.metadata, status: "archived", review: { state: "rejected", decided_by: actor.userId, decided_at: now.toISOString(), reason: input.reason?.trim()?.slice(0, 500) || null } })
  if (err) return { ok: false, documentId: doc.id, state: "held", message: receiptTenantMessage("not_saved"), reasons: [], internal: err }
  return { ok: true, documentId: doc.id, state: "rejected", message: receiptTenantMessage("rejected"), reasons: [] }
}

// ─── THE REVIEW READ (side-by-side page + proposal) ───────────────────────────

export async function loadReceiptReview(svc: Svc, input: { actor: ReceiptActor; documentId: string }, seams: ReceiptSeams = {}) {
  const { actor } = input
  const now = (seams.now ?? (() => new Date()))()
  const loaded = await loadReceiptDocument(svc, actor, input.documentId)
  if (!loaded.ok) return { ok: false as const, error: loaded.reason }
  const doc = loaded.doc
  const ledger = await readDocumentExtractions(svc, { brokerageId: actor.brokerageId, documentIds: [doc.id], keyPrefix: "expense." })
  if (!ledger.ok) return { ok: false as const, error: "The receipt details could not be loaded right now." }
  const fields = fieldsFromRows(ledger.rows)
  const review = (doc.metadata.receipt_review ?? {}) as Record<string, any>
  const kind = (fields["expense.document_kind"]?.value ?? review.kind ?? null) as FinancialDocumentKind | null
  const verifiedBy = ledger.rows.find((r) => r.verifiedByUserId)?.verifiedByUserId ?? null
  return {
    ok: true as const,
    review: {
      documentId: doc.id,
      state: (review.state ?? "held") as ReviewStateName,
      kind,
      kindLabel: financialKindLabel(kind),
      summary: doc.summary,
      pages: splitPages(doc.content ?? ""),
      qualityFlags: (review.quality_flags ?? []) as string[],
      readBy: (review.read_by ?? null) as string | null,
      storage: { bucket: String(doc.metadata.storage_bucket ?? RECEIPT_BUCKET), objectPath: String(doc.metadata.storage_object_path ?? ""), mime: String(doc.metadata.mime ?? "") },
      fields: (Object.keys(RECEIPT_FIELDS) as Array<keyof typeof RECEIPT_FIELDS>).filter((k) => k !== "expense.line_items").map((k) => {
        const e = fields[k]
        return {
          key: k, label: RECEIPT_FIELDS[k].label, destination: RECEIPT_FIELDS[k].destination,
          value: e ? (e.value as string | number | null) : null, page: e?.page ?? null, excerpt: e?.excerpt ?? null,
          evidenceLocated: e?.evidence_located ?? false, uncertainty: e?.uncertainty ?? (e ? null : "not_read"), confidence: e?.confidence ?? "low",
          readBy: e?.read_by ?? null, correctedFrom: (e?.corrected_from as string | number | null | undefined) ?? null,
        }
      }),
      lineItems: (Array.isArray(fields["expense.line_items"]?.value) ? fields["expense.line_items"].value : []) as LineItem[],
      issues: validateReceipt(fields, { today: today(now) }),
      duplicates: (review.duplicates ?? { exactFile: null, sameCharge: [] }) as DuplicateFinding,
      reasons: (review.reasons ?? []) as string[],
      proposedScope: (review.proposed_scope ?? proposeScope(actor)) as ExpenseScope | null,
      canPostBrokerage: isBrokerageFinanceAdmin({ user_type: actor.userType }),
      postingClass: kind ? postingClassFor(kind) : "not_financial",
      postedExpenseId: (review.posted_expense_id ?? null) as string | null,
      verifiedByUserId: verifiedBy,
      transactionLink: (review.transaction_link ?? null) as Record<string, unknown> | null,
      message: review.state === "posted" ? receiptTenantMessage("posted") : review.state === "rejected" ? receiptTenantMessage("rejected") : review.state === "unreadable" ? receiptTenantMessage("unreadable") : receiptTenantMessage("hold_for_review"),
    },
  }
}

/** The review queue: the actor's own receipts awaiting review — or every one in the account for an admin who keeps the books. */
export async function listReceiptReviews(svc: Svc, input: { actor: ReceiptActor; limit?: number }) {
  const { actor } = input
  let q = svc.from("documents").select("id, created_at, summary, status, metadata")
    .eq("brokerage_id", actor.brokerageId).eq("document_type", RECEIPT_DOCUMENT_TYPE).eq("status", "review")
  if (!isBrokerageFinanceAdmin({ user_type: actor.userType })) q = q.eq("metadata->>uploaded_by", actor.userId)
  const { data, error } = await q.order("created_at", { ascending: false }).limit(input.limit ?? 25)
  if (error) return { ok: false as const, error: "Receipts waiting for review could not be loaded right now." }
  return {
    ok: true as const,
    rows: ((data ?? []) as Array<Record<string, any>>).map((d) => ({
      documentId: String(d.id), createdAt: String(d.created_at ?? ""), summary: (d.summary as string | null) ?? null,
      state: String(d.metadata?.receipt_review?.state ?? "held"), kindLabel: financialKindLabel(d.metadata?.receipt_review?.kind ?? null),
      fileName: (d.metadata?.file_name as string | null) ?? null,
    })),
  }
}
