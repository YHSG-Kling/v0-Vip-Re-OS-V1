#!/usr/bin/env tsx
/**
 * scripts/receipt-intelligence-guard.ts (npm run test:receipt-intelligence) — wave 152, lane 152D.
 * ─────────────────────────────────────────────────────────────────────────────
 * DOCUMENT INTELLIGENCE THAT FILLS REAL FIELDS — RECEIPT → BOOKS. Owner (2026-11-11): "document readers should also
 * have the ability to read documents, understand the document and details and input data into fields and summarize …
 * receipts are scanned or a picture of them and then ai inputs the data into the financial fields for the brokerage,
 * teams or agents financial records."
 *
 * Drives the REAL survivors on the in-memory supabase client (scripts/in-memory-supabase.ts):
 *   lib/documents/ocr-pdf.ts            ocrDocumentFromBuffer (the vision door, with model / afford / chat / book seams)
 *   lib/documents/receipt-intake.ts     intakeReceipt · approveReceipt · rejectReceipt · loadReceiptReview
 *   lib/documents/receipt-rules.ts      the pure rules (kinds, evidence, sums, duplicates, posting, reversal, copy)
 *   lib/documents/field-extraction-ledger.ts  recordFieldExtractions · readDocumentExtractions
 *   lib/documents/autonomy-ratchet.ts   loadGrantsFor (the real fail-closed grant read, seeded managed_agents rows)
 *   lib/kernel/action-ledger.ts         withActionLedger (the real claim / settle / replay on agent_action_ledger)
 *   lib/finance/brokerage-earnings-writer.ts  runBrokerageEarningsRollup (a real cost reader over business_expenses)
 *
 * SIMULATED — no live model, gateway, storage or database call. The model and the vision call are injected seams
 * (canned readings); the expense WRITER is a stand-in for app/actions/financials.ts logScopedExpense, which needs a
 * Next request session — its scope gates are held by test:people-vendor-education-wiring A7/A8, the server actions are
 * proved here (stripped source) to inject exactly logScopedExpense, and its reversal gate IS the real reversalVerdict,
 * called by the stand-in. Every absence assertion carries a positive control.
 *
 * BLIND SPOTS (published beside the result): a real photo's reading quality; whether the routed vision provider
 * accepts a PDF data URL; storage upload / signing (the server action, not driven); the review UI rendering.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { memSupabase, type MemClient, type Row } from "./in-memory-supabase"
import { stripComments, blankStrings } from "./strip-comments"
import { ocrDocumentFromBuffer } from "../lib/documents/ocr-pdf"
import { intakeReceipt, approveReceipt, rejectReceipt, loadReceiptReview, type ReceiptActor } from "../lib/documents/receipt-intake"
import { recordFieldExtractions, readDocumentExtractions } from "../lib/documents/field-extraction-ledger"
import {
  reversalVerdict, reversalMarker, receiptTenantMessage, transactionLinkVerdict, normalizeUsd,
  canonicalExpenseCategory, EXPENSE_CATEGORIES,
} from "../lib/documents/receipt-rules"
import { CDA_FILL_RULE } from "../lib/transactions/cda-closing-policy"
import { runBrokerageEarningsRollup } from "../lib/finance/brokerage-earnings-writer"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"

const ROOT = process.cwd()
const src = (p: string) => readFileSync(join(ROOT, p), "utf8")
let passed = 0, failed = 0
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`) }
}

// ─── fixtures ─────────────────────────────────────────────────────────────────
const NOW = new Date("2026-11-11T15:00:00Z")
const A = "brokerage-a", B = "brokerage-b"
const agent: ReceiptActor = { userId: "u-agent", agentId: "ag-1", teamId: "team-1", brokerageId: A, userType: "agent" }
const agent2: ReceiptActor = { userId: "u-agent-2", agentId: "ag-2", teamId: "team-1", brokerageId: A, userType: "agent" }
const lead: ReceiptActor = { userId: "u-lead", agentId: "ag-3", teamId: "team-1", brokerageId: A, userType: "team_lead" }
const broker: ReceiptActor = { userId: "u-broker", agentId: null, teamId: null, brokerageId: A, userType: "broker" }
const otherTenantAgent: ReceiptActor = { userId: "u-b-agent", agentId: "ag-b", teamId: null, brokerageId: B, userType: "agent" }

const PHOTO = Buffer.from("\xFF\xD8\xFF\xE0-fake-jpeg-office-depot", "binary")
const READING = [
  "=== PAGE 1 ===",
  "OFFICE DEPOT #1234",
  "123 MAIN ST",
  "11/03/2026 2:14 PM",
  "COPY PAPER 2PK     12.99",
  "INK CARTRIDGE      27.00",
  "SUBTOTAL           39.99",
  "TAX                 3.18",
  "TOTAL             $43.17",
  "VISA ****4242",
  "QUALITY_FLAGS: none",
].join("\n")
const f = (value: unknown, excerpt: string | null, confidence = "high", page = 1) => ({ value, page, excerpt, confidence })
const MODEL_RECEIPT = {
  document_kind: "receipt", kind_confidence: "high", kind_evidence: { page: 1, excerpt: "VISA ****4242" },
  merchant: f("OFFICE DEPOT #1234", "OFFICE DEPOT #1234"),
  date: f("2026-11-03", "11/03/2026"),
  total: f("43.17", "TOTAL             $43.17"),
  subtotal: f("39.99", "SUBTOTAL           39.99"),
  tax: f("3.18", "TAX                 3.18"),
  tip: f(null, null), balance_due: f(null, null), currency: f(null, null),
  payment_method: f("VISA ****4242", "VISA ****4242"),
  line_items: [
    { description: "COPY PAPER 2PK", quantity: 1, amount: "12.99", page: 1, excerpt: "COPY PAPER 2PK     12.99" },
    { description: "INK CARTRIDGE", quantity: 1, amount: "27.00", page: 1, excerpt: "INK CARTRIDGE      27.00" },
  ],
  category_suggestion: "office",
  summary: "Office Depot purchase of copy paper and ink on Nov 3, 2026 for $43.17 paid by Visa.",
  problems: [],
}

function seed(extra: Record<string, Row[]> = {}): MemClient {
  return memSupabase({
    documents: [], document_field_extractions: [], policy_decisions: [], agent_action_ledger: [], business_expenses: [],
    transactions: [], managed_agents: [], brokerage_settings: [],
    ...extra,
  }, { uuidIds: true, unique: { agent_action_ledger: [["idempotency_key"]], document_field_extractions: [["document_id", "field_key"]] } })
}

/** The vision seams: capture the exact request the door sends and the usage row it books. */
function visionSeams(reading: string, opts: { afford?: boolean } = {}) {
  const sent: any[] = [], booked: any[] = [], affordAsked: any[] = []
  return {
    sent, booked, affordAsked,
    reader: {
      model: async () => ({ alias: "routed-vision-alias", slug: "routed/vision-slug" }),
      afford: async (brokerageId: string, est: number) => { affordAsked.push({ brokerageId, est }); return opts.afford === false ? { allowed: false, message: "AI reading is not included in this subscription." } : { allowed: true } },
      chat: async (args: any) => { sent.push(args); return { ok: true, content: reading, error: null, usage: { inputTokens: 1700, outputTokens: 140 } } },
      book: async (row: any) => { booked.push(row) },
    },
  }
}

/** WRITER STAND-IN for logScopedExpense: the same row shape, the REAL reversalVerdict, the same refusal codes. */
function writer(svc: MemClient, actorFor: () => ReceiptActor) {
  const calls: any[] = []
  const post = async (input: any) => {
    calls.push(input)
    const ctx = actorFor()
    const amount = Number(input.amount)
    if (!Number.isFinite(amount) || amount <= 0) return { success: false, error: "amount_invalid" }
    const row: Row = { brokerage_id: ctx.brokerageId, category: input.category, description: input.description, amount, expense_date: input.expenseDate, receipt_url: input.receiptUrl ?? null, agent_id: null, team_id: null }
    if (input.scope === "agent") { if (!ctx.agentId) return { success: false, error: "no_agent_context" }; row.agent_id = ctx.agentId }
    else if (input.scope === "team") row.team_id = input.teamId ?? ctx.teamId
    else if (input.scope === "brokerage" && !["broker", "broker_admin", "broker_owner", "admin"].includes(ctx.userType)) return { success: false, error: "forbidden_brokerage_scope" }
    if (input.reversalOfExpenseId) {
      const { data: original } = await svc.from("business_expenses").select("id, amount, agent_id, team_id").eq("id", input.reversalOfExpenseId).eq("brokerage_id", ctx.brokerageId).maybeSingle()
      const { data: prior } = await svc.from("business_expenses").select("amount").eq("brokerage_id", ctx.brokerageId).ilike("description", `%${reversalMarker(input.reversalOfExpenseId)}%`)
      const already = ((prior ?? []) as any[]).reduce((s, r) => s + Math.abs(Number(r.amount) || 0), 0)
      const v = reversalVerdict({ original: original as any, magnitude: amount, alreadyReversed: already, row: { agent_id: row.agent_id, team_id: row.team_id } })
      if (!v.ok) return { success: false, error: v.code }
      row.amount = -amount
    }
    const { data, error } = await svc.from("business_expenses").insert(row).select("id").single()
    if (error) return { success: false, error: error.message }
    return { success: true, expenseId: (data as any).id as string }
  }
  return { post, calls }
}

const extractSeam = (model: unknown) => async () => ({ ok: true, text: JSON.stringify(model) })
const rowsFor = (svc: MemClient, documentId: string) => svc.tables.document_field_extractions.filter((r) => r.document_id === documentId)
const fieldRow = (svc: MemClient, documentId: string, key: string) => rowsFor(svc, documentId).find((r) => r.field_key === key)

async function main() {
  console.log("\n[1 · the reader — a photo really reaches the vision lane, metered, entitlement first]")
  {
    const v = visionSeams(READING)
    const r = await ocrDocumentFromBuffer({ buffer: PHOTO, mime: "image/jpeg", brokerageId: A, userId: "u-agent", manager: "finance_manager" }, v.reader)
    const part = v.sent[0]?.messages?.[0]?.content ?? []
    const sendsImage = (content: any[]) => Array.isArray(content) && content.some((c) => c?.type === "image_url" && typeof c.image_url?.url === "string" && c.image_url.url === `data:image/jpeg;base64,${PHOTO.toString("base64")}`)
    check("the vision call carries the document as an image part (the full data URL of the bytes)", sendsImage(part), part.map((c: any) => c.type))
    // POSITIVE CONTROL — the pre-152D shape (80 characters of the data URL inside a TEXT prompt) fails the same checker.
    const legacy = [{ type: "text", text: `Extract every readable character.\n[document attached: data:image/jpeg;base64,${PHOTO.toString("base64").slice(0, 60)}…]` }]
    check("PC: the old text-placeholder request is recognised as NOT sending the image", !sendsImage(legacy))
    check("the model is the routing table's (resolved through the seam), never a literal in the reader", v.sent[0]?.model === "routed/vision-slug")
    check("entitlement + budget asked BEFORE the call, for the session tenant", v.affordAsked.length === 1 && v.affordAsked[0].brokerageId === A)
    check("the spend is BOOKED to the tenant (feature document_image_scan, gateway token counts, manager)", v.booked.length === 1 && v.booked[0].brokerageId === A && v.booked[0].feature === "document_image_scan" && v.booked[0].inputTokens === 1700 && v.booked[0].manager === "finance_manager" && v.booked[0].contextExtra?.token_basis === "gateway_usage", v.booked[0])
    check("pages, quality flags and the bytes' sha256 come back with the text", r.success && r.reader === "vision" && r.pages?.length === 1 && Array.isArray(r.quality_flags) && r.quality_flags.length === 0 && /^[0-9a-f]{64}$/.test(r.sha256 ?? ""), r)
    const refused = visionSeams(READING, { afford: false })
    const r2 = await ocrDocumentFromBuffer({ buffer: PHOTO, mime: "image/jpeg", brokerageId: A }, refused.reader)
    check("ADVERSE: a tenant without AI entitlement — no model call, nothing booked, an honest failure", !r2.success && refused.sent.length === 0 && refused.booked.length === 0 && /not included/.test(r2.error ?? ""))
    const textOnly = await ocrDocumentFromBuffer({ buffer: PHOTO, mime: "image/jpeg", brokerageId: A, allowVision: false }, v.reader)
    check("allowVision:false keeps a text-layer-only caller off the vision lane", !textOnly.success && v.sent.length === 1)
    const email = await ocrDocumentFromBuffer({ buffer: Buffer.from("<p>Thanks for your order</p><p>Total: $19.99</p>"), mime: "text/html", brokerageId: A }, visionSeams("x").reader)
    check("a digital (email/html) receipt is read natively — no model call", email.success && email.reader === "native_text" && /Total: \$19\.99/.test(email.text))
    const blurry = visionSeams(READING.replace("QUALITY_FLAGS: none", "QUALITY_FLAGS: blurry, rotated"))
    const r3 = await ocrDocumentFromBuffer({ buffer: PHOTO, mime: "image/jpeg", brokerageId: A }, blurry.reader)
    check("quality flags are parsed off the reading (blurry, rotated) and kept out of the page text", JSON.stringify(r3.quality_flags) === JSON.stringify(["blurry", "rotated"]) && !/QUALITY_FLAGS/.test(r3.text))
  }

  console.log("\n[2 · a clear photo receipt fills the correct DRAFT fields — nothing is posted]")
  let heldDoc = ""
  {
    const svc = seed()
    const v = visionSeams(READING)
    const w = writer(svc, () => agent)
    const out = await intakeReceipt(svc, { actor: agent, file: { buffer: PHOTO, mime: "image/jpeg", name: "receipt.jpg" }, objectPath: `${A}/u-agent/x.jpg` }, { reader: v.reader, extract: extractSeam(MODEL_RECEIPT), postExpense: w.post, now: () => NOW })
    heldDoc = out.documentId ?? ""
    const doc = svc.tables.documents[0]
    check("held for a person (no approved grant) with the contract copy", out.ok && out.state === "held" && out.message.whatHappened === "We found a receipt, but some amounts need review before they can be recorded.", out)
    check("NOTHING on the books — the writer was never called", svc.tables.business_expenses.length === 0 && w.calls.length === 0)
    const total = fieldRow(svc, heldDoc, "expense.total")?.field_value_json
    check("expense.total = 43.17 on page 1, its words found there, high confidence, destination business_expenses.amount", total?.value === 43.17 && total?.page === 1 && total?.evidence_located === true && fieldRow(svc, heldDoc, "expense.total")?.confidence === "high" && total?.destination === "business_expenses.amount", total)
    check("merchant / date / currency / category / payment method filled", fieldRow(svc, heldDoc, "expense.merchant")?.field_value_json.value === "OFFICE DEPOT #1234" && fieldRow(svc, heldDoc, "expense.date")?.field_value_json.value === "2026-11-03" && fieldRow(svc, heldDoc, "expense.currency")?.field_value_json.value === "USD" && fieldRow(svc, heldDoc, "expense.category")?.field_value_json.value === "office" && fieldRow(svc, heldDoc, "expense.payment_method")?.field_value_json.value === "VISA ****4242")
    check("every fact carries the document version (sha256), extractor, read-by and time", rowsFor(svc, heldDoc).every((r) => /^[0-9a-f]{64}$/.test(r.field_value_json.doc_sha256 ?? "") && r.field_value_json.extractor === "receipt_reader@1" && r.field_value_json.read_by === "vision" && r.field_value_json.extracted_at === NOW.toISOString()))
    check("the document row: tenant + uploader from the session, object path (no URL stored), page text, non-authoritative summary", doc.brokerage_id === A && doc.metadata.uploaded_by === "u-agent" && doc.storage_url === null && doc.metadata.storage_object_path === `${A}/u-agent/x.jpg` && /OFFICE DEPOT/.test(doc.content) && /Office Depot/.test(doc.summary ?? "") && doc.classification === "other", doc)
    check("an AMBER policy decision with the reason recorded before anything acts", svc.tables.policy_decisions.some((p) => p.document_id === heldDoc && p.decision === "amber" && p.target_type === "receipt_expense"))
    const review = await loadReceiptReview(svc, { actor: agent, documentId: heldDoc }, { now: () => NOW })
    const t = review.ok ? review.review.fields.find((x) => x.key === "expense.total") : null
    check("PAGE EVIDENCE VISIBLE: the review read returns page + quoted words + located for each value", !!t && t.page === 1 && /\$43\.17/.test(t.excerpt ?? "") && t.evidenceLocated === true && review.ok && review.review.pages[0].text.includes("TOTAL"), t)
    const approved = await approveReceipt(svc, { actor: agent, documentId: heldDoc }, { postExpense: w.post, now: () => NOW })
    const row = svc.tables.business_expenses[0]
    check("approve → THE writer runs once: agent book, amount 43.17, date, category, merchant, in-app receipt link", approved.ok && approved.state === "posted" && w.calls.length === 1 && row?.agent_id === "ag-1" && row?.amount === 43.17 && row?.expense_date === "2026-11-03" && row?.category === "office" && row?.description === "OFFICE DEPOT #1234" && row?.receipt_url === `/dashboard/financials/expenses/receipts/${heldDoc}`, { approved, row })
    check("the trail: every receipt fact stamped verified by the reviewer + the posted expense id on the ledger", rowsFor(svc, heldDoc).every((r) => r.verified_by_user_id === "u-agent" && r.verified_at) && fieldRow(svc, heldDoc, "expense.posted_expense_id")?.field_value_json.value === row?.id)
    const led = svc.tables.agent_action_ledger.find((l) => l.action === "finance.expense.post_from_document")
    check("withActionLedger evidence: who (the user), why, FINANCIAL, executed, provider_ref = the expense", !!led && led.status === "executed" && led.actor_type === "user" && led.actor_user_id === "u-agent" && led.risk_class === "FINANCIAL" && led.provider_ref === row?.id, led)
    const again = await approveReceipt(svc, { actor: agent, documentId: heldDoc }, { postExpense: w.post, now: () => NOW })
    check("DUPLICATE CALL: approving again posts nothing new (idempotent per document)", again.ok && again.state === "posted" && svc.tables.business_expenses.length === 1 && w.calls.length === 1)
    const rejectPosted = await rejectReceipt(svc, { actor: agent, documentId: heldDoc })
    check("a posted receipt cannot be declined away (the refund path undoes money, not a delete)", !rejectPosted.ok && svc.tables.business_expenses.length === 1)
  }

  console.log("\n[3 · multi-page invoice — coherent line items across pages; a wrong line holds]")
  {
    const pages = "=== PAGE 1 ===\nACME SIGN CO\nINVOICE 5521\nDate: Oct 28, 2026\nYARD SIGN 24x36   2   80.00\nRIDER SIGN         1   25.00\n=== PAGE 2 ===\nPOST INSTALL       1   45.00\nSUBTOTAL 150.00\nTAX 12.38\nTOTAL DUE $162.38\nPAID - VISA 1881\nBALANCE DUE 0.00\nQUALITY_FLAGS: none"
    const model = {
      document_kind: "paid_invoice", kind_confidence: "high", kind_evidence: { page: 2, excerpt: "PAID - VISA 1881" },
      merchant: f("ACME SIGN CO", "ACME SIGN CO"), date: f("2026-10-28", "Oct 28, 2026"),
      total: f("162.38", "TOTAL DUE $162.38", "high", 2), subtotal: f("150.00", "SUBTOTAL 150.00", "high", 2), tax: f("12.38", "TAX 12.38", "high", 2),
      tip: f(null, null), balance_due: f("0.00", "BALANCE DUE 0.00", "high", 2), currency: f(null, null), payment_method: f("VISA 1881", "PAID - VISA 1881", "high", 2),
      line_items: [
        { description: "YARD SIGN 24x36", quantity: 2, amount: "80.00", page: 1, excerpt: "YARD SIGN 24x36   2   80.00" },
        { description: "RIDER SIGN", quantity: 1, amount: "25.00", page: 1, excerpt: "RIDER SIGN         1   25.00" },
        { description: "POST INSTALL", quantity: 1, amount: "45.00", page: 2, excerpt: "POST INSTALL       1   45.00" },
      ],
      category_suggestion: "marketing", summary: "Paid sign invoice", problems: [],
    }
    const svc = seed()
    const out = await intakeReceipt(svc, { actor: agent, file: { buffer: Buffer.from("pdf-bytes-invoice-5521"), mime: "image/png", name: "inv.png" }, objectPath: `${A}/u-agent/i.png` }, { reader: visionSeams(pages).reader, extract: extractSeam(model), now: () => NOW })
    const items = fieldRow(svc, out.documentId!, "expense.line_items")?.field_value_json
    const review = await loadReceiptReview(svc, { actor: agent, documentId: out.documentId! }, { now: () => NOW })
    check("three line items located on pages 1, 1, 2 — they sum to the subtotal (no mismatch issue)", items?.value?.length === 3 && items.value.map((i: any) => i.page).join(",") === "1,1,2" && items.value.every((i: any) => i.evidence_located) && review.ok && !review.review.issues.some((i) => i.code === "line_items_mismatch"), review.ok ? review.review.issues : review)
    check("the total cites page 2, where it is printed", fieldRow(svc, out.documentId!, "expense.total")?.field_value_json.page === 2)
    const bad = { ...model, line_items: [...model.line_items.slice(0, 2), { description: "POST INSTALL", quantity: 1, amount: "54.00", page: 2, excerpt: "POST INSTALL       1   54.00" }] }
    const svc2 = seed()
    const out2 = await intakeReceipt(svc2, { actor: agent, file: { buffer: Buffer.from("pdf-bytes-invoice-5521-b"), mime: "image/png", name: "inv.png" }, objectPath: `${A}/u-agent/j.png` }, { reader: visionSeams(pages).reader, extract: extractSeam(bad), now: () => NOW })
    const r2 = await loadReceiptReview(svc2, { actor: agent, documentId: out2.documentId! }, { now: () => NOW })
    check("ADVERSE: a line read as 54.00 (not on the page, and the sum breaks) → held, line_items_mismatch blocking", out2.state === "held" && r2.ok && r2.review.issues.some((i) => i.code === "line_items_mismatch" && i.blocking), r2.ok ? r2.review.issues : r2)
  }

  console.log("\n[4 · total mismatch holds; a person's correction is human evidence]")
  {
    const svc = seed()
    const w = writer(svc, () => agent)
    const model = { ...MODEL_RECEIPT, total: f("48.17", "TOTAL $48.17") }
    const reading = READING.replace("TOTAL             $43.17", "TOTAL $48.17")
    const out = await intakeReceipt(svc, { actor: agent, file: { buffer: Buffer.from("mismatch-bytes"), mime: "image/jpeg", name: "m.jpg" }, objectPath: `${A}/u-agent/m.jpg` }, { reader: visionSeams(reading).reader, extract: extractSeam(model), postExpense: w.post, now: () => NOW })
    const r = await loadReceiptReview(svc, { actor: agent, documentId: out.documentId! }, { now: () => NOW })
    check("subtotal 39.99 + tax 3.18 ≠ total 48.17 → held with a blocking total_mismatch", out.state === "held" && r.ok && r.review.issues.some((i) => i.code === "total_mismatch" && i.blocking))
    const tryPost = await approveReceipt(svc, { actor: agent, documentId: out.documentId! }, { postExpense: w.post, now: () => NOW })
    check("approve without fixing it is REFUSED and nothing reaches the writer", !tryPost.ok && w.calls.length === 0 && /add up/.test(tryPost.reasons[0] ?? ""), tryPost.reasons)
    const fixed = await approveReceipt(svc, { actor: agent, documentId: out.documentId!, corrections: { "expense.total": "43.17" } }, { postExpense: w.post, now: () => NOW })
    const tot = fieldRow(svc, out.documentId!, "expense.total")?.field_value_json
    check("corrected total → posts 43.17; the field keeps corrected_from 48.17 and read_by human", fixed.ok && svc.tables.business_expenses[0]?.amount === 43.17 && tot?.corrected_from === 48.17 && tot?.read_by === "human", { fixed, tot })
    const badFix = await approveReceipt(seed(), { actor: agent, documentId: "nope", corrections: { "expense.total": "1.234,56" } }, { postExpense: w.post })
    check("ADVERSE: a receipt id that is not in the account reads as absent", !badFix.ok && /not in your account/.test(badFix.message.whatHappened))
    check("an ambiguous amount format is UNKNOWN, never a plausible number", normalizeUsd("1.234,56") === null && normalizeUsd("43.1") === null && normalizeUsd("$1,234.56") === 1234.56 && normalizeUsd("(5.00)") === -5)
  }

  console.log("\n[5 · duplicates — the same file is refused; the same charge holds until a person confirms]")
  {
    const svc = seed()
    const w = writer(svc, () => agent)
    const first = await intakeReceipt(svc, { actor: agent, file: { buffer: PHOTO, mime: "image/jpeg", name: "r.jpg" }, objectPath: `${A}/u-agent/1.jpg` }, { reader: visionSeams(READING).reader, extract: extractSeam(MODEL_RECEIPT), postExpense: w.post, now: () => NOW })
    await approveReceipt(svc, { actor: agent, documentId: first.documentId! }, { postExpense: w.post, now: () => NOW })
    const again = await intakeReceipt(svc, { actor: agent, file: { buffer: PHOTO, mime: "image/jpeg", name: "r-again.jpg" }, objectPath: `${A}/u-agent/2.jpg` }, { reader: visionSeams(READING).reader, extract: extractSeam(MODEL_RECEIPT), postExpense: w.post, now: () => NOW })
    check("the SAME FILE again → refused as a duplicate, linked to the earlier receipt, totals unchanged", !again.ok && again.state === "duplicate" && svc.tables.business_expenses.length === 1 && svc.tables.documents.find((d) => d.id === again.documentId)?.metadata.receipt_review.duplicates.exactFile.documentId === first.documentId, again)
    const tryAgain = await approveReceipt(svc, { actor: agent, documentId: again.documentId! }, { postExpense: w.post, now: () => NOW })
    check("ADVERSE: approving the duplicate anyway is refused", !tryAgain.ok && svc.tables.business_expenses.length === 1)
    // A different photo of the SAME purchase (different bytes) — caught by merchant + date + total on the books.
    const photo2 = await intakeReceipt(svc, { actor: agent, file: { buffer: Buffer.from("another-photo-same-purchase"), mime: "image/jpeg", name: "r2.jpg" }, objectPath: `${A}/u-agent/3.jpg` }, { reader: visionSeams(READING).reader, extract: extractSeam(MODEL_RECEIPT), postExpense: w.post, now: () => NOW })
    check("a second photo of the same purchase → held: same merchant, date and total already recorded", photo2.state === "held" && svc.tables.documents.find((d) => d.id === photo2.documentId)?.metadata.receipt_review.duplicates.sameCharge.length === 1)
    const noConfirm = await approveReceipt(svc, { actor: agent, documentId: photo2.documentId! }, { postExpense: w.post, now: () => NOW })
    const confirmed = await approveReceipt(svc, { actor: agent, documentId: photo2.documentId!, confirmNotDuplicate: true }, { postExpense: w.post, now: () => NOW })
    check("refused until the person confirms it is a different purchase; then it posts", !noConfirm.ok && confirmed.ok && svc.tables.business_expenses.length === 2)
    // A duplicate check that cannot run holds — never posts blind.
    const blind = memSupabase({ documents: [], document_field_extractions: [], policy_decisions: [], agent_action_ledger: [], business_expenses: [], managed_agents: [] }, { uuidIds: true, refuse: { business_expenses: "permission denied for table business_expenses" } })
    const held = await intakeReceipt(blind, { actor: agent, file: { buffer: Buffer.from("blind"), mime: "image/jpeg", name: "b.jpg" }, objectPath: `${A}/u-agent/b.jpg` }, { reader: visionSeams(READING).reader, extract: extractSeam(MODEL_RECEIPT), now: () => NOW })
    check("ADVERSE: the duplicate read is refused → held with 'could not check', not posted", held.state === "held" && blind.tables.documents[0]?.metadata.receipt_review.issues.some((i: any) => i.code === "duplicate_check_unavailable"))
  }

  console.log("\n[6 · the same receipt in two tenants stays isolated]")
  {
    const svc = seed()
    const wA = writer(svc, () => agent)
    const a = await intakeReceipt(svc, { actor: agent, file: { buffer: PHOTO, mime: "image/jpeg", name: "r.jpg" }, objectPath: `${A}/u-agent/1.jpg` }, { reader: visionSeams(READING).reader, extract: extractSeam(MODEL_RECEIPT), postExpense: wA.post, now: () => NOW })
    await approveReceipt(svc, { actor: agent, documentId: a.documentId! }, { postExpense: wA.post, now: () => NOW })
    const wB = writer(svc, () => otherTenantAgent)
    const b = await intakeReceipt(svc, { actor: otherTenantAgent, file: { buffer: PHOTO, mime: "image/jpeg", name: "r.jpg" }, objectPath: `${B}/u-b-agent/1.jpg` }, { reader: visionSeams(READING).reader, extract: extractSeam(MODEL_RECEIPT), postExpense: wB.post, now: () => NOW })
    check("tenant B's identical file is NOT a duplicate of tenant A's (and A's expense is not B's same charge)", b.state === "held" && !svc.tables.documents.find((d) => d.id === b.documentId)?.metadata.receipt_review.duplicates.exactFile && svc.tables.documents.find((d) => d.id === b.documentId)?.metadata.receipt_review.duplicates.sameCharge.length === 0)
    const peek = await loadReceiptReview(svc, { actor: otherTenantAgent, documentId: a.documentId! })
    const steal = await approveReceipt(svc, { actor: otherTenantAgent, documentId: a.documentId! }, { postExpense: wB.post, now: () => NOW })
    check("ADVERSE: tenant B cannot read or approve tenant A's receipt — it reads as absent", !peek.ok && !steal.ok && /not in your account/.test(steal.message.whatHappened) && wB.calls.length === 0)
    const ext = await readDocumentExtractions(svc, { brokerageId: B, documentIds: [a.documentId!] })
    check("the exported extraction reader is tenant-pinned (B asking for A's document gets no rows)", ext.ok && ext.rows.length === 0)
  }

  console.log("\n[7 · who may post where — an unauthorized user cannot post to the brokerage's books]")
  {
    const svc = seed()
    const w = writer(svc, () => agent)
    const out = await intakeReceipt(svc, { actor: agent, file: { buffer: PHOTO, mime: "image/jpeg", name: "r.jpg" }, objectPath: `${A}/u-agent/1.jpg` }, { reader: visionSeams(READING).reader, extract: extractSeam(MODEL_RECEIPT), postExpense: w.post, now: () => NOW })
    const asAgent = await approveReceipt(svc, { actor: agent, documentId: out.documentId!, scope: "brokerage" }, { postExpense: w.post, now: () => NOW })
    check("ADVERSE: an agent choosing the brokerage's books is refused BEFORE the writer, in plain words", !asAgent.ok && w.calls.length === 0 && /account admin who keeps the brokerage's books/.test(asAgent.reasons[0] ?? ""), asAgent.reasons)
    const wl = writer(svc, () => lead)
    const leadDoc = await intakeReceipt(svc, { actor: lead, file: { buffer: Buffer.from("lead-receipt"), mime: "image/jpeg", name: "l.jpg" }, objectPath: `${A}/u-lead/1.jpg` }, { reader: visionSeams(READING).reader, extract: extractSeam({ ...MODEL_RECEIPT, total: f("43.17", "TOTAL             $43.17") }), postExpense: wl.post, now: () => NOW })
    const asLead = await approveReceipt(svc, { actor: lead, documentId: leadDoc.documentId!, scope: "brokerage", confirmNotDuplicate: true }, { postExpense: wl.post, now: () => NOW })
    check("ADVERSE: a team lead administers but does not keep the brokerage's books (m472) — refused", !asLead.ok && wl.calls.length === 0)
    const other = await approveReceipt(svc, { actor: agent2, documentId: out.documentId! }, { postExpense: w.post, now: () => NOW })
    const otherRead = await loadReceiptReview(svc, { actor: agent2, documentId: out.documentId! })
    check("ADVERSE: another agent in the same account cannot open or approve someone else's receipt", !other.ok && !otherRead.ok && w.calls.length === 0)
    for (const seat of [{ userId: "u-vendor", agentId: null, teamId: null, brokerageId: A, userType: "vendor" }, { userId: "u-contact", agentId: null, teamId: null, brokerageId: A, userType: "client" }] as ReceiptActor[]) {
      const vs = visionSeams(READING)
      const docsBefore = svc.tables.documents.length
      const r = await intakeReceipt(svc, { actor: seat, file: { buffer: Buffer.from(`seat-${seat.userType}`), mime: "image/jpeg", name: "s.jpg" }, objectPath: `${A}/${seat.userId}/s.jpg` }, { reader: vs.reader, extract: extractSeam(MODEL_RECEIPT), now: () => NOW })
      check(`ADVERSE: a ${seat.userType} seat keeps no books here — refused before any row, file read or model call`, !r.ok && r.documentId === null && svc.tables.documents.length === docsBefore && vs.sent.length === 0 && /keeps none of them/.test(r.message.whatHappened))
    }
    const wb = writer(svc, () => broker)
    const asBroker = await approveReceipt(svc, { actor: broker, documentId: out.documentId!, scope: "brokerage" }, { postExpense: wb.post, now: () => NOW })
    check("the broker (books-keeper roster) may post it to the brokerage's books", asBroker.ok && svc.tables.business_expenses.some((r) => r.agent_id === null && r.team_id === null && r.amount === 43.17))
  }

  console.log("\n[8 · an invoice never becomes a paid expense; statements and quotes neither]")
  {
    for (const [kind, label] of [["invoice_due", "Invoice (not yet paid)"], ["statement", "Account statement"], ["quote", "Quote or estimate"]] as const) {
      const svc = seed()
      const w = writer(svc, () => agent)
      const out = await intakeReceipt(svc, { actor: agent, file: { buffer: Buffer.from(`k-${kind}`), mime: "image/jpeg", name: "k.jpg" }, objectPath: `${A}/u-agent/k.jpg` }, { reader: visionSeams(READING).reader, extract: extractSeam({ ...MODEL_RECEIPT, document_kind: kind }), postExpense: w.post, now: () => NOW })
      const post = await approveReceipt(svc, { actor: agent, documentId: out.documentId! }, { postExpense: w.post, now: () => NOW })
      check(`${label} → not postable, archived, and approving it is refused`, out.state === "not_postable" && svc.tables.documents[0].status === "archived" && !post.ok && w.calls.length === 0 && svc.tables.business_expenses.length === 0, { state: out.state, post: post.reasons })
    }
    const svc = seed()
    const out = await intakeReceipt(svc, { actor: agent, file: { buffer: Buffer.from("paid-claim-but-due"), mime: "image/jpeg", name: "d.jpg" }, objectPath: `${A}/u-agent/d.jpg` }, { reader: visionSeams(READING + "\nBALANCE DUE 43.17").reader, extract: extractSeam({ ...MODEL_RECEIPT, document_kind: "paid_invoice", balance_due: f("43.17", "BALANCE DUE 43.17") }), now: () => NOW })
    check("ADVERSE: 'paid invoice' with a balance still due is tightened to an unpaid invoice — not postable", out.state === "not_postable" && fieldRow(svc, out.documentId!, "expense.document_kind")?.field_value_json.value === "invoice_due" && fieldRow(svc, out.documentId!, "expense.document_kind")?.field_value_json.uncertainty === "kind_tightened_by_balance_due")
  }

  console.log("\n[9 · a refund reverses — and the cost readers net it]")
  {
    const orig = { id: "exp-1", amount: 120, agent_id: null, team_id: null }
    check("reversalVerdict: within the original on the same books → ok", reversalVerdict({ original: orig, magnitude: 40, alreadyReversed: 0, row: { agent_id: null, team_id: null } }).ok)
    check("ADVERSE: a refund larger than what is left is refused (cumulative)", (reversalVerdict({ original: orig, magnitude: 90, alreadyReversed: 40, row: { agent_id: null, team_id: null } }) as any).code === "reversal_exceeds_original")
    check("ADVERSE: a refund on DIFFERENT books than the original is refused", (reversalVerdict({ original: orig, magnitude: 10, alreadyReversed: 0, row: { agent_id: "ag-1", team_id: null } }) as any).code === "reversal_scope_mismatch")
    check("ADVERSE: a refund with no recorded original is refused (never a free-standing negative cost)", (reversalVerdict({ original: null, magnitude: 10, alreadyReversed: 0, row: { agent_id: null, team_id: null } }) as any).code === "reversal_original_not_found")

    const svc = seed({
      brokerages: [{ id: A }],
      agent_commissions: [{ brokerage_id: A, gross_commission: 10000, agent_commission: 7000, brokerage_commission: 3000, net_to_agent: 7000, net_to_brokerage: 3000, transaction_id: "tx-1", agent_id: "ag-1", close_date: "2026-11-05" }],
      business_expenses: [{ id: "exp-1", brokerage_id: A, agent_id: null, team_id: null, category: "marketing", description: "SIGNS PLUS — yard signs", amount: 120, expense_date: "2026-11-02" }],
      brokerage_earnings: [], brokerage_p_l: [],
    })
    await runBrokerageEarningsRollup(svc as any, NOW)
    const before = svc.tables.brokerage_p_l.find((r) => r.brokerage_id === A)?.marketing_expenses
    const refundModel = { ...MODEL_RECEIPT, document_kind: "refund", merchant: f("SIGNS PLUS", "SIGNS PLUS"), total: f("-40.00", "REFUND TOTAL -$40.00"), subtotal: f(null, null), tax: f(null, null), line_items: [], date: f("2026-11-09", "11/09/2026") }
    const refundReading = "=== PAGE 1 ===\nSIGNS PLUS\n11/09/2026\nRETURN 1 YARD SIGN\nREFUND TOTAL -$40.00\nQUALITY_FLAGS: none"
    const wb = writer(svc, () => broker)
    const out = await intakeReceipt(svc, { actor: broker, file: { buffer: Buffer.from("refund-slip"), mime: "image/jpeg", name: "refund.jpg" }, objectPath: `${A}/u-broker/r.jpg` }, { reader: visionSeams(refundReading).reader, extract: extractSeam(refundModel), postExpense: wb.post, now: () => NOW })
    check("a refund slip is held until it is linked to the expense it reverses (magnitude 40.00 kept)", out.state === "held" && fieldRow(svc, out.documentId!, "expense.total")?.field_value_json.value === 40)
    const unlinked = await approveReceipt(svc, { actor: broker, documentId: out.documentId!, scope: "brokerage" }, { postExpense: wb.post, now: () => NOW })
    check("ADVERSE: approving a refund without choosing the original is refused", !unlinked.ok && wb.calls.length === 0 && /reverses/.test(unlinked.reasons[0] ?? ""))
    const linked = await approveReceipt(svc, { actor: broker, documentId: out.documentId!, scope: "brokerage", reversalOfExpenseId: "exp-1", corrections: { "expense.category": "marketing" } }, { postExpense: wb.post, now: () => NOW })
    const rev = svc.tables.business_expenses.find((r) => r.amount < 0)
    check("linked → a NEGATIVE row of 40.00 on the brokerage's books, marked as the reversal of exp-1", linked.ok && rev?.amount === -40 && String(rev?.description).includes(reversalMarker("exp-1")) && wb.calls[0]?.reversalOfExpenseId === "exp-1" && wb.calls[0]?.amount === 40, { linked, rev })
    svc.tables.brokerage_p_l.length = 0
    await runBrokerageEarningsRollup(svc as any, NOW)
    const after = svc.tables.brokerage_p_l.find((r) => r.brokerage_id === A)?.marketing_expenses
    check("THE COST READER NETS IT: brokerage P&L marketing 120 → 80 after the reversal", before === 120 && after === 80, { before, after })
  }

  console.log("\n[10 · unknown stays unknown — merchant and date flagged, never invented]")
  {
    const svc = seed()
    const reading = "=== PAGE 1 ===\n11/03 2:14 PM\nTOTAL $18.40\nQUALITY_FLAGS: blurry"
    const model = { ...MODEL_RECEIPT, merchant: f(null, null), date: f("2026-11-03", "11/03 2:14 PM"), total: f("18.40", "TOTAL $18.40"), subtotal: f(null, null), tax: f(null, null), line_items: [], payment_method: f(null, null), kind_evidence: { page: 1, excerpt: "TOTAL $18.40" } }
    const out = await intakeReceipt(svc, { actor: agent, file: { buffer: Buffer.from("faded"), mime: "image/jpeg", name: "faded.jpg" }, objectPath: `${A}/u-agent/f.jpg` }, { reader: visionSeams(reading).reader, extract: extractSeam(model), now: () => NOW })
    const d = fieldRow(svc, out.documentId!, "expense.date")?.field_value_json
    const m = fieldRow(svc, out.documentId!, "expense.merchant")?.field_value_json
    const r = await loadReceiptReview(svc, { actor: agent, documentId: out.documentId! }, { now: () => NOW })
    check("a date printed without a year is NOT given one (value null, uncertainty year_not_shown)", d?.value === null && d?.uncertainty === "year_not_shown", d)
    check("an unread merchant stays null (not_shown_on_document), recorded as a flagged row", m?.value === null && m?.uncertainty === "not_shown_on_document" && fieldRow(svc, out.documentId!, "expense.merchant")?.confidence === "low")
    check("both are BLOCKING issues and the receipt is held", out.state === "held" && r.ok && r.review.issues.some((i) => i.code === "merchant_unknown" && i.blocking) && r.review.issues.some((i) => i.code === "date_unknown" && i.blocking))
    check("a blurry photo caps confidence below high", fieldRow(svc, out.documentId!, "expense.total")?.confidence === "medium")
    const dayFirst = seed()
    const dfReading = READING.replace("11/03/2026 2:14 PM", "03/11/2026 2:14 PM")
    const df = await intakeReceipt(dayFirst, { actor: agent, file: { buffer: Buffer.from("day-first"), mime: "image/jpeg", name: "df.jpg" }, objectPath: `${A}/u-agent/df.jpg` }, { reader: visionSeams(dfReading).reader, extract: extractSeam({ ...MODEL_RECEIPT, date: f("2026-11-03", "03/11/2026") }), now: () => NOW })
    const dfDate = fieldRow(dayFirst, df.documentId!, "expense.date")?.field_value_json
    check("ADVERSE: '03/11/2026' is not read as Nov 3 (no day/month guess) — date_not_in_excerpt, LOW, held", dfDate?.uncertainty === "date_not_in_excerpt" && dfDate?.evidence_located === true && fieldRow(dayFirst, df.documentId!, "expense.date")?.confidence === "low" && df.state === "held", dfDate)
    const fabricated = { ...MODEL_RECEIPT, total: f("43.17", "TOTAL $43.17 (estimated)") }
    const svc2 = seed()
    const out2 = await intakeReceipt(svc2, { actor: agent, file: { buffer: Buffer.from("fab"), mime: "image/jpeg", name: "x.jpg" }, objectPath: `${A}/u-agent/x.jpg` }, { reader: visionSeams(READING).reader, extract: extractSeam(fabricated), now: () => NOW })
    const t2 = fieldRow(svc2, out2.documentId!, "expense.total")?.field_value_json
    check("ADVERSE: a value whose quoted words are not on the page is LOW and holds (excerpt_not_found_on_page)", t2?.evidence_located === false && t2?.uncertainty === "excerpt_not_found_on_page" && out2.state === "held")
    const unreadable = await intakeReceipt(seed(), { actor: agent, file: { buffer: Buffer.from("blank"), mime: "image/jpeg", name: "blank.jpg" }, objectPath: `${A}/u-agent/blank.jpg` }, { reader: visionSeams("=== PAGE 1 ===\n[illegible]\nQUALITY_FLAGS: dark").reader, extract: extractSeam(MODEL_RECEIPT), now: () => NOW })
    check("an unreadable photo → saved, 'could not read it', nothing extracted or posted", unreadable.state === "unreadable" && unreadable.message.whatHappened === "We saved your receipt, but could not read it.")
  }

  console.log("\n[11 · signed contract terms are never silently overwritten; the CDA stays agent-filled]")
  {
    const svc = seed({ document_field_extractions: [{ id: "x1", document_id: "doc-contract", brokerage_id: A, field_key: "price", field_value_json: 500000, confidence: "high", extraction_model: "router:document_classification", verified_at: "2026-10-01T00:00:00Z", verified_by_user_id: "u-tc" }] })
    const re = await recordFieldExtractions(svc as any, { documentId: "doc-contract", brokerageId: A, fields: { price: 450000, closing_date: "2026-12-01" }, confidence: "high", extractionModel: "router:document_classification" })
    const price = svc.tables.document_field_extractions.find((r) => r.field_key === "price")
    check("a re-scan reading a DIFFERENT price leaves the human-verified price untouched (and says so)", price?.field_value_json === 500000 && re.preservedVerified === 1 && re.recorded === 1)
    const refusedRead = memSupabase({ document_field_extractions: [] }, { refuse: { document_field_extractions: "permission denied" } })
    const blind = await recordFieldExtractions(refusedRead as any, { documentId: "d", brokerageId: A, fields: { price: 1 }, confidence: "high", extractionModel: "x" })
    check("ADVERSE: when the verified rows cannot be read, NOTHING is written (no blind overwrite) and the refusal is returned", blind.recorded === 0 && !!blind.error && refusedRead.writes.length === 0)
    const contractModel = { document_kind: "not_financial", kind_confidence: "high", kind_evidence: { page: 1, excerpt: "RESIDENTIAL PURCHASE AGREEMENT" }, summary: "A purchase agreement." }
    const svc2 = seed()
    const out = await intakeReceipt(svc2, { actor: agent, file: { buffer: Buffer.from("contract"), mime: "image/jpeg", name: "contract.jpg" }, objectPath: `${A}/u-agent/c.jpg` }, { reader: visionSeams("=== PAGE 1 ===\nRESIDENTIAL PURCHASE AGREEMENT\nPrice $500,000\nQUALITY_FLAGS: none").reader, extract: extractSeam(contractModel), now: () => NOW })
    check("a contract sent to the receipt reader → 'not a receipt'; only expense.* keys written; no contract field touched", out.state === "not_a_receipt" && rowsFor(svc2, out.documentId!).every((r) => String(r.field_key).startsWith("expense.")) && svc2.tables.business_expenses.length === 0)
    check("CDA_FILL_RULE: the agent fills, the AI never fills", CDA_FILL_RULE.agentFills === true && CDA_FILL_RULE.aiFills === false)
    // The receipt modules touch ONLY these tables, and write none of the deal's closing / CDA tables.
    const ALLOWED = new Set(["documents", "document_field_extractions", "business_expenses", "policy_decisions", "transactions", "managed_agents"])
    const tablesIn = (code: string) => [...code.matchAll(/\.from\(\s*"([a-z_]+)"\s*\)/g)].map((m) => m[1])
    const files = ["lib/documents/receipt-intake.ts", "lib/documents/receipt-rules.ts", "lib/documents/ocr-pdf.ts"]
    const touched = files.flatMap((p) => tablesIn(stripComments(src(p))))
    check("the receipt modules read/write only documents, the extraction ledger, business_expenses (read), policy decisions, transactions (read) and grants", touched.length > 0 && touched.every((t) => ALLOWED.has(t)), touched)
    const intakeCode = blankStrings(stripComments(src("lib/documents/receipt-intake.ts")))
    check("the receipt flow never inserts into business_expenses itself (the ONE writer does) and never updates transactions",
      !/from\("business_expenses"\)[\s\S]{0,80}\.(insert|update|upsert|delete)\(/.test(stripComments(src("lib/documents/receipt-intake.ts")))
      && !/from\("transactions"\)[\s\S]{0,80}\.(insert|update|upsert|delete)\(/.test(stripComments(src("lib/documents/receipt-intake.ts")))
      && intakeCode.length > 0)
    // POSITIVE CONTROL — a specimen that writes the CDA / books directly is caught by the same two scans.
    const specimen = `const a = await svc.from("closing_disclosure_agreement").update({ total: 1 }); await svc.from("business_expenses").insert(row)`
    check("PC: a specimen writing the CDA and inserting an expense directly is caught", !tablesIn(specimen).every((t) => ALLOWED.has(t)) && /from\("business_expenses"\)[\s\S]{0,80}\.(insert|update|upsert|delete)\(/.test(specimen))
    check("transaction link only on evidence: the receipt must show the deal's street number + name", transactionLinkVerdict("SIGN INSTALL AT 742 EVERGREEN TER", "742 Evergreen Terrace, Springfield") === "evidenced" && transactionLinkVerdict("OFFICE DEPOT 123 MAIN ST", "742 Evergreen Terrace") === "not_evidenced")
    const svc3 = seed({ transactions: [{ id: "tx-9", brokerage_id: A, property_address: "742 Evergreen Terrace" }] })
    const out3 = await intakeReceipt(svc3, { actor: agent, file: { buffer: PHOTO, mime: "image/jpeg", name: "r.jpg" }, objectPath: `${A}/u-agent/t.jpg`, transactionId: "tx-9" }, { reader: visionSeams(READING).reader, extract: extractSeam(MODEL_RECEIPT), now: () => NOW })
    check("ADVERSE: an Office Depot receipt the agent tagged to a deal is NOT linked (its text shows no deal address)", !svc3.tables.documents[0].transaction_id && svc3.tables.documents[0].metadata.receipt_review.transaction_link.verdict === "not_evidenced" && out3.state === "held")
  }

  console.log("\n[12 · auto-post ONLY under an existing approved grant, for that exact clean case]")
  {
    const grantRow = (shape: string) => ({ id: "ma-1", brokerage_id: A, agent_kind: "finance_manager", archived_at: null, updated_at: "2026-11-01T00:00:00Z", config: { expense_grants: [shape] } })
    const svc = seed({ managed_agents: [grantRow("receipt_autopost:receipt:max_usd=100")] })
    const w = writer(svc, () => agent)
    const out = await intakeReceipt(svc, { actor: agent, file: { buffer: PHOTO, mime: "image/jpeg", name: "r.jpg" }, objectPath: `${A}/u-agent/a.jpg` }, { reader: visionSeams(READING).reader, extract: extractSeam(MODEL_RECEIPT), postExpense: w.post, now: () => NOW })
    const led = svc.tables.agent_action_ledger.find((l) => l.action === "finance.expense.post_from_document")
    check("grant receipt_autopost:receipt:max_usd=100 + a clean $43.17 receipt → posted by policy (manager actor), no human verified stamp", out.state === "posted" && svc.tables.business_expenses.length === 1 && led?.actor_type === "manager" && led?.actor_manager_key === "finance_manager" && rowsFor(svc, out.documentId!).every((r) => !r.verified_by_user_id), { state: out.state, led })
    check("its GREEN policy decision is on the ledger", svc.tables.policy_decisions.some((p) => p.document_id === out.documentId && p.decision === "green"))
    const over = seed({ managed_agents: [grantRow("receipt_autopost:receipt:max_usd=20")] })
    const o2 = await intakeReceipt(over, { actor: agent, file: { buffer: PHOTO, mime: "image/jpeg", name: "r.jpg" }, objectPath: `${A}/u-agent/o.jpg` }, { reader: visionSeams(READING).reader, extract: extractSeam(MODEL_RECEIPT), postExpense: writer(over, () => agent).post, now: () => NOW })
    check("ADVERSE: above the grant's own ceiling → held", o2.state === "held" && over.tables.business_expenses.length === 0)
    const other = seed({ managed_agents: [grantRow("receipt_autopost:paid_invoice:max_usd=500")] })
    const o3 = await intakeReceipt(other, { actor: agent, file: { buffer: PHOTO, mime: "image/jpeg", name: "r.jpg" }, objectPath: `${A}/u-agent/p.jpg` }, { reader: visionSeams(READING).reader, extract: extractSeam(MODEL_RECEIPT), postExpense: writer(other, () => agent).post, now: () => NOW })
    check("ADVERSE: a grant for a DIFFERENT kind authorizes nothing here → held", o3.state === "held" && other.tables.business_expenses.length === 0)
    const blurry = seed({ managed_agents: [grantRow("receipt_autopost:receipt:max_usd=100")] })
    const o4 = await intakeReceipt(blurry, { actor: agent, file: { buffer: PHOTO, mime: "image/jpeg", name: "r.jpg" }, objectPath: `${A}/u-agent/q.jpg` }, { reader: visionSeams(READING.replace("QUALITY_FLAGS: none", "QUALITY_FLAGS: blurry")).reader, extract: extractSeam(MODEL_RECEIPT), postExpense: writer(blurry, () => agent).post, now: () => NOW })
    check("ADVERSE: a blurry photo is never auto-posted, even under the grant", o4.state === "held" && blurry.tables.business_expenses.length === 0)
    const refusedGrants = memSupabase({ documents: [], document_field_extractions: [], policy_decisions: [], agent_action_ledger: [], business_expenses: [], transactions: [] }, { uuidIds: true, refuse: { managed_agents: "permission denied" } })
    const o5 = await intakeReceipt(refusedGrants, { actor: agent, file: { buffer: PHOTO, mime: "image/jpeg", name: "r.jpg" }, objectPath: `${A}/u-agent/g.jpg` }, { reader: visionSeams(READING).reader, extract: extractSeam(MODEL_RECEIPT), postExpense: writer(refusedGrants, () => agent).post, now: () => NOW })
    check("ADVERSE: the grant read is refused → fail CLOSED, held", o5.state === "held" && refusedGrants.tables.business_expenses.length === 0)
  }

  console.log("\n[13 · decline keeps the evidence and posts nothing]")
  {
    const svc = seed()
    const w = writer(svc, () => agent)
    const out = await intakeReceipt(svc, { actor: agent, file: { buffer: PHOTO, mime: "image/jpeg", name: "r.jpg" }, objectPath: `${A}/u-agent/1.jpg` }, { reader: visionSeams(READING).reader, extract: extractSeam(MODEL_RECEIPT), postExpense: w.post, now: () => NOW })
    const rej = await rejectReceipt(svc, { actor: agent, documentId: out.documentId!, reason: "personal purchase" }, { now: () => NOW })
    check("declined → archived, every fact kept and marked rejected, a RED decision, nothing posted", rej.ok && svc.tables.documents[0].status === "archived" && rowsFor(svc, out.documentId!).length > 5 && rowsFor(svc, out.documentId!).every((r) => r.field_value_json.review_state === "rejected") && svc.tables.policy_decisions.some((p) => p.recommended_action === "receipt_rejected_by_human") && svc.tables.business_expenses.length === 0)
    const after = await approveReceipt(svc, { actor: agent, documentId: out.documentId! }, { postExpense: w.post, now: () => NOW })
    check("ADVERSE: a declined receipt cannot be approved afterwards", !after.ok && w.calls.length === 0)
  }

  console.log("\n[14 · the extraction reader (exported for the term comparison) unwraps every stored shape]")
  {
    const svc = memSupabase({ document_field_extractions: [
      { id: "1", document_id: "d", brokerage_id: A, field_key: "expense.total", field_value_json: { v: 1, value: 43.17, page: 1, excerpt: "TOTAL $43.17", evidence_located: true, uncertainty: null }, confidence: "high" },
      { id: "2", document_id: "d", brokerage_id: A, field_key: "price", field_value_json: { value: 500000, page: 3 }, confidence: "high" },
      { id: "3", document_id: "d", brokerage_id: A, field_key: "closing_date", field_value_json: "2026-12-01", confidence: "medium" },
    ] })
    const r = await readDocumentExtractions(svc as any, { brokerageId: A, documentIds: ["d"] })
    const by = r.ok ? Object.fromEntries(r.rows.map((x) => [x.fieldKey, x])) : {}
    check("envelope → value + page + excerpt; legacy {value,page} → value + page; bare scalar → value, evidence null",
      r.ok && (by as any)["expense.total"].value === 43.17 && (by as any)["expense.total"].evidence.excerpt === "TOTAL $43.17" && (by as any).price.value === 500000 && (by as any).price.evidence.page === 3 && (by as any).closing_date.value === "2026-12-01" && (by as any).closing_date.evidence === null)
    const refused = memSupabase({}, { refuse: { document_field_extractions: "denied" } })
    const rr = await readDocumentExtractions(refused as any, { brokerageId: A, documentIds: ["d"] })
    check("ADVERSE: a refused ledger read is an error, never 'no facts'", !rr.ok)
  }

  console.log("\n[15 · tenant copy follows the message contract — no internals, no payer claims]")
  {
    const states = ["post", "posted", "hold_for_review", "refuse_duplicate", "not_postable", "not_a_receipt", "rejected", "unreadable", "not_saved"] as const
    const bad = /(error:|exception|stack|pgrst|supabase|sql|rls|gateway|api key|token|brokerage pays|billed to your brokerage|ocr)/i
    const all = states.map((s) => receiptTenantMessage(s))
    check("every state answers what happened · what it affects · saved · who acts · one action", all.every((m) => [m.whatHappened, m.whatItAffects, m.saved, m.whoActs, m.action].every((x) => typeof x === "string" && x.length > 3)))
    check("no stack / provider / SQL / credential words and no 'brokerage pays' claim in any of them", all.every((m) => !bad.test(Object.values(m).join(" "))))
    check("PC: the scan catches a message that leaks an internal", bad.test("PGRST204: column not found"))
  }

  console.log("\n[16 · the wiring — the ONE writer, the doors, the dialog, the verify door, the registry, the guard chain]")
  {
    const actions = stripComments(src("app/actions/financials.ts"))
    const injected = (code: string) => (code.match(/postExpense:\s*logScopedExpense\b/g) ?? []).length
    check("the receipt server actions inject exactly logScopedExpense as the writer (intake + approve)", injected(actions) >= 2)
    check("PC: a door that injected some other writer is not counted", injected("{ postExpense: createExpenseRecord }") === 0)
    check("logScopedExpense applies the real reversal gate before a negative row, and skips the accounting push for it",
      /reversalVerdict\(/.test(actions) && /row\.amount\s*=\s*-amount/.test(actions) && /input\.scope === "brokerage" && !isReversal/.test(actions))
    check("every receipt door resolves the actor from the session (getAgentContext), never a body tenant",
      /async function sessionReceiptActor[\s\S]{0,200}getAgentContext\(\)/.test(actions) && !/brokerageId:\s*input\.brokerageId/.test(actions))
    const dialog = stripComments(src("app/dashboard/financials/expenses/components/add-expense-dialog.tsx"))
    check("the Add Expense dialog saves through logScopedExpense with the ONE category vocabulary (it could not save before)",
      /logScopedExpense\(/.test(dialog) && !/\bcreateExpense\(/.test(dialog) && /EXPENSE_CATEGORIES/.test(dialog) && !/"Meals & Entertainment"/.test(dialog))
    check("the category mapper folds the old labels onto the vocabulary (Marketing → marketing, Office Supplies → office)", canonicalExpenseCategory("Marketing") === "marketing" && canonicalExpenseCategory("Office Supplies") === "office" && canonicalExpenseCategory("Professional Development") === "education" && EXPENSE_CATEGORIES.includes("other"))
    const verify = stripComments(src("app/actions/document-extractions.ts"))
    check("the deal-file verify door hides receipt facts and refuses to verify them", /\.not\("field_key",\s*"like",\s*"expense\.%"\)/.test(verify) && /startsWith\("expense\."\)/.test(verify))
    check("PC: a verify door without the exclusion is caught", !/\.not\("field_key",\s*"like",\s*"expense\.%"\)/.test(`svc.from("document_field_extractions").select("*").eq("brokerage_id", b)`))
    const reader = stripComments(src("lib/documents/ocr-pdf.ts"))
    check("the reader sends an image part and no longer pastes the data URL into a text prompt", /type:\s*"image_url"/.test(reader) && !/document attached:/.test(reader) && !/dataUri\.slice\(/.test(reader))
    check("no model name or id is written in the new reader / receipt modules (routed at call time)", !["lib/documents/ocr-pdf.ts", "lib/documents/receipt-intake.ts", "lib/documents/receipt-rules.ts"].some((p) => /\b(gpt-|claude-|gemini-|sonnet|haiku|opus)\b/i.test(stripComments(src(p)))))
    // Lane 152E's comparison (wrong party / wrong property against the statement) needs the parties read OFF the
    // statement — the scanner asks for them on BOTH settlement classifications, as printed, null when not printed.
    const scanPrompt = src("lib/documents/scan-uploaded-document.ts")
    const listFor = (cls: string) => (new RegExp(`\\n\\s*${cls}\\s*→\\s*\\{([^}]*)\\}`).exec(scanPrompt)?.[1] ?? "")
    check("the scanner reads buyer_names / seller_names / property_address off the CD and the preliminary statement (null when not printed)",
      ["closing_disclosure", "preliminary_closing_statement"].every((c) => /buyer_names\[\]/.test(listFor(c)) && /seller_names\[\]/.test(listFor(c)) && /property_address/.test(listFor(c)))
      && /use null for any the statement\s+does not print/.test(scanPrompt))
    check("PC: a field list without the parties is caught", !/buyer_names\[\]/.test(listFor("hoa_documents")))
    const grantRoute = stripComments(src("lib/documents/autonomy-ratchet.ts"))
    check("a receipt grant routes to finance_manager's policy row (expense_grants)", /receipt_autopost:[\s\S]{0,120}finance_manager[\s\S]{0,60}expense_grants/.test(grantRoute))
    const domain = (MAINTENANCE_DOMAINS as Record<string, { manager: string; proof: string; coOwners?: string[] }>).receipt_to_books
    check("registry: receipt_to_books owned by finance_manager, co-owned by deal_coordinator, proof test:receipt-intelligence", domain?.manager === "finance_manager" && domain?.proof === "test:receipt-intelligence" && domain?.coOwners?.includes("deal_coordinator") === true)
    const pkg = JSON.parse(src("package.json")) as { scripts: Record<string, string> }
    check("package.json registers the proof and the guard chain runs it", /receipt-intelligence-guard\.ts/.test(pkg.scripts["test:receipt-intelligence"] ?? "") && /npm run test:receipt-intelligence\b/.test(pkg.scripts.guard ?? ""))
  }

  console.log(`\nBLIND SPOTS: a real photo's reading quality (canned readings here); whether the routed vision provider accepts a PDF data URL; the storage upload and signed-URL mint (the server action, not driven); the review page rendering; the writer stand-in replaces logScopedExpense's session (its gates: test:people-vendor-education-wiring A7/A8).`)
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); console.log(`\nRESULT: ${passed} passed, ${failed + 1} failed`); process.exit(1) })
