/**
 * lib/documents/receipt-rules.ts — THE PURE RULES OF RECEIPT → BOOKS (wave 152, lane 152D).
 *
 * Owner (verbatim, 2026-11-11): "document readers should also have the ability to read documents, understand the
 * document and details and input data into fields and summarize. that comes in handy for when receipts are scanned or a
 * picture of them and then ai inputs the data into the financial fields for the brokerage, teams or agents financial
 * records."
 *
 * What lives here is DETERMINISTIC: what kind of money document this is and whether that kind can ever be posted, how a
 * read value is normalized, whether the value the reader proposed is actually on the page it cited, whether the numbers
 * add up, whether this charge is already on the books, and what the tenant is told. No model, no database, no imports —
 * so the expense pickers (client components) read the SAME category vocabulary the receipt suggester writes.
 *
 * The model only PROPOSES (lib/documents/receipt-intake.ts). Nothing here trusts a proposal it cannot check:
 *   · a value whose excerpt is not found on the cited page is LOW confidence and holds the receipt;
 *   · a date whose excerpt shows no year is never given one;
 *   · an amount in a format that is not unambiguous dollars-and-cents is UNKNOWN, never a plausible number;
 *   · an invoice that is still due, a statement or a quote is NEVER a paid expense;
 *   · a refund or credit only REDUCES a recorded expense it is linked to — never a free-standing negative cost.
 */

// ─── THE KIND OF MONEY DOCUMENT ───────────────────────────────────────────────

export const FINANCIAL_DOCUMENT_KINDS = [
  "receipt", "paid_invoice", "payment_proof",
  "refund", "credit_memo",
  "invoice_due", "statement", "quote",
  "not_financial",
] as const
export type FinancialDocumentKind = (typeof FINANCIAL_DOCUMENT_KINDS)[number]

/** expense = proof money left; reversal = money came back against a recorded expense; not_postable = never a cost row. */
type PostingClass = "expense" | "reversal" | "not_postable" | "not_financial"

const KIND_RULES: Record<FinancialDocumentKind, { cls: PostingClass; label: string; whyNot?: string }> = {
  receipt:       { cls: "expense",      label: "Receipt" },
  paid_invoice:  { cls: "expense",      label: "Paid invoice" },
  payment_proof: { cls: "expense",      label: "Payment confirmation" },
  refund:        { cls: "reversal",     label: "Refund" },
  credit_memo:   { cls: "reversal",     label: "Credit" },
  invoice_due:   { cls: "not_postable", label: "Invoice (not yet paid)", whyNot: "An invoice that is still due is a bill, not proof it was paid, so it is not recorded as an expense." },
  statement:     { cls: "not_postable", label: "Account statement",      whyNot: "A statement lists charges that are recorded one receipt at a time, so recording it would count those charges twice." },
  quote:         { cls: "not_postable", label: "Quote or estimate",      whyNot: "A quote is a price offer, not money spent, so it is not recorded as an expense." },
  not_financial: { cls: "not_financial", label: "Not a receipt",         whyNot: "This does not look like a receipt, invoice or payment, so nothing was added to your expenses." },
}

export function financialKindLabel(kind: string | null | undefined): string {
  return KIND_RULES[(kind ?? "") as FinancialDocumentKind]?.label ?? "Unknown document"
}

function kindRule(kind: string | null | undefined) {
  return KIND_RULES[(kind ?? "") as FinancialDocumentKind] ?? KIND_RULES.not_financial
}

// ─── THE ONE EXPENSE CATEGORY VOCABULARY ──────────────────────────────────────
// The values logScopedExpense (app/actions/financials.ts, the ONE business_expenses writer for all three scopes) is
// fed by the brokerage money page, and the values the monthly P&L fold buckets on
// (lib/finance/brokerage-earnings-writer.ts: marketing / office / technology, everything else → operating).

export const EXPENSE_CATEGORIES = ["marketing", "office", "technology", "education", "transportation", "other"] as const
type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]

const CATEGORY_WORDS: Array<[ExpenseCategory, RegExp]> = [
  ["marketing",      /\b(sign|signs|flyer|flyers|postcard|print(ing)?|ads?|advertis\w*|facebook|zillow|realtor\.com|open house|staging|photo(graphy)?|brochure|mailer|vistaprint|canva|lockbox(es)?)\b/i],
  ["technology",     /\b(software|subscription|saas|crm|app|cloud|domain|hosting|laptop|computer|phone|iphone|ipad|monitor|adobe|microsoft|google workspace|dropbox|zoom|internet|wifi)\b/i],
  ["transportation", /\b(fuel|gas|gasoline|diesel|shell|chevron|exxon|bp|mobil|parking|toll|tolls|uber|lyft|taxi|mileage|car wash|airline|flight)\b/i],
  ["education",      /\b(course|class|training|seminar|ce credit|continuing education|webinar|conference|book|books|coaching|license renewal)\b/i],
  ["office",         /\b(office|paper|ink|toner|staples|office depot|officemax|stationery|pens|folders|postage|usps|fedex|ups store|rent|desk|chair|supplies)\b/i],
]

/** Map any spelling (an AI label such as "Office Supplies", a picker value) onto the one vocabulary; unknown → null. */
export function canonicalExpenseCategory(raw: string | null | undefined): ExpenseCategory | null {
  const s = String(raw ?? "").trim().toLowerCase()
  if (!s) return null
  if ((EXPENSE_CATEGORIES as readonly string[]).includes(s)) return s as ExpenseCategory
  if (/market|advertis|sign|photo|staging|print/.test(s)) return "marketing"
  if (/tech|software|subscription|computer|equipment/.test(s)) return "technology"
  if (/transport|travel|mileage|fuel|vehicle|car/.test(s)) return "transportation"
  if (/educat|training|professional development|course|licens/.test(s)) return "education"
  if (/office|supplies|stationery|postage|rent/.test(s)) return "office"
  if (s === "other" || s === "misc" || s === "miscellaneous") return "other"
  return null
}

/** Deterministic suggestion from what the receipt SAYS (merchant + line items) — a model label is only a tie-break. */
function suggestExpenseCategory(input: { merchant: string | null; lineItems: Array<{ description: string | null }>; modelSuggestion?: string | null }): { category: ExpenseCategory; basis: "receipt_text" | "model_suggestion" | "default" } {
  const text = [input.merchant ?? "", ...input.lineItems.map((l) => l.description ?? "")].join(" ")
  for (const [cat, re] of CATEGORY_WORDS) if (re.test(text)) return { category: cat, basis: "receipt_text" }
  const fromModel = canonicalExpenseCategory(input.modelSuggestion)
  if (fromModel) return { category: fromModel, basis: "model_suggestion" }
  return { category: "other", basis: "default" }
}

// ─── THE FIELD CONTRACT (typed destination keys on document_field_extractions) ──

type FieldUnit = "kind" | "text" | "date" | "usd" | "currency_code" | "line_items" | "category" | "expense_id"

export const RECEIPT_FIELDS = {
  "expense.document_kind":  { label: "Document type",    unit: "kind",          destination: null,                              required: true },
  "expense.merchant":       { label: "Merchant",         unit: "text",          destination: "business_expenses.description",   required: true },
  "expense.date":           { label: "Date",             unit: "date",          destination: "business_expenses.expense_date",  required: true },
  "expense.total":          { label: "Total",            unit: "usd",           destination: "business_expenses.amount",        required: true },
  "expense.subtotal":       { label: "Subtotal",         unit: "usd",           destination: null,                              required: false },
  "expense.tax":            { label: "Tax",              unit: "usd",           destination: null,                              required: false },
  "expense.tip":            { label: "Tip",              unit: "usd",           destination: null,                              required: false },
  "expense.balance_due":    { label: "Balance due",      unit: "usd",           destination: null,                              required: false },
  "expense.currency":       { label: "Currency",         unit: "currency_code", destination: null,                              required: true },
  "expense.payment_method": { label: "Payment method",   unit: "text",          destination: null,                              required: false },
  "expense.line_items":     { label: "Line items",       unit: "line_items",    destination: null,                              required: false },
  "expense.category":       { label: "Category",         unit: "category",      destination: "business_expenses.category",      required: true },
} as const satisfies Record<string, { label: string; unit: FieldUnit; destination: string | null; required: boolean }>
type ReceiptFieldKey = keyof typeof RECEIPT_FIELDS

/** The posted expense the receipt became — written once, at post time. */
export const POSTED_EXPENSE_FIELD_KEY = "expense.posted_expense_id"

type Confidence = "high" | "medium" | "low"
type ReviewState = "draft" | "corrected" | "posted" | "rejected"

export interface LineItem { description: string | null; quantity: number | null; amount: number | null; page: number | null; excerpt: string | null; evidence_located: boolean }

/**
 * ONE extracted fact as it is stored in document_field_extractions.field_value_json for an `expense.*` key — the
 * evidence travels WITH the value (directive: document version/hash, page + excerpt, extractor/version/time,
 * confidence or uncertainty reason, normalization, review state, conflict with an authoritative value).
 * `bbox` is null: the reader returns text, not coordinates, and inventing a box would be a fabricated highlight.
 */
export interface FieldEnvelope {
  v: 1
  value: string | number | LineItem[] | null
  raw: string | null
  unit: FieldUnit
  page: number | null
  excerpt: string | null
  bbox: null
  evidence_located: boolean
  uncertainty: string | null
  destination: string | null
  doc_sha256: string | null
  extractor: string
  read_by: "native_text" | "vision" | "human"
  extracted_at: string
  review_state: ReviewState
  confidence: Confidence
  conflict: { authoritative_value: unknown; source: string } | null
  corrected_from?: unknown
}

// ─── NORMALIZATION — unknown stays unknown ────────────────────────────────────

/** Dollars-and-cents only. "1,234.56", "$43.17", 43.17 → number; "1.234,56" / "43.1" ambiguity / text → null. */
export function normalizeUsd(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && Math.round(raw * 100) === Math.round(raw * 100 * 1e6) / 1e6 ? Math.round(raw * 100) / 100 : null
  if (typeof raw !== "string") return null
  let s = raw.trim().replace(/^usd\s*/i, "").replace(/\s*usd$/i, "").replace(/^\$\s*/, "").replace(/^-\s*\$/, "-")
  const neg = /^\(.*\)$/.test(s) || s.startsWith("-")
  s = s.replace(/^\(|\)$/g, "").replace(/^-/, "")
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{2})?$/.test(s)) return null
  const n = Number(s.replace(/,/g, ""))
  if (!Number.isFinite(n)) return null
  return neg ? -n : n
}

export function normalizeIsoDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim())
  if (!m) return null
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw.trim()) return null
  return raw.trim()
}

function normalizeCurrency(raw: unknown, totalExcerpt: string | null): string | null {
  const s = String(raw ?? "").trim().toUpperCase()
  if (/^[A-Z]{3}$/.test(s)) return s
  if (totalExcerpt && (/\$/.test(totalExcerpt) || /\bUSD\b/i.test(totalExcerpt))) return "USD"
  return null
}

// ─── EVIDENCE: is the proposed value really on the cited page? ────────────────

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim()

/** The page the excerpt was found on (the cited page first, then any page), or null when it is on none. */
function locateExcerpt(pages: Array<{ page: number; text: string }>, citedPage: number | null, excerpt: string | null): number | null {
  if (!excerpt || squash(excerpt).length < 2) return null
  const want = squash(excerpt)
  const ordered = citedPage ? [...pages.filter((p) => p.page === citedPage), ...pages.filter((p) => p.page !== citedPage)] : pages
  for (const p of ordered) if (squash(p.text).includes(want)) return p.page
  return null
}

/** Does the excerpt actually show the amount (43.17 in "TOTAL $43.17")? Commas and $ are ignored. */
function amountInExcerpt(amount: number, excerpt: string | null): boolean {
  if (!excerpt) return false
  const flat = excerpt.replace(/[,$\s]/g, "")
  const fixed = Math.abs(amount).toFixed(2)
  return flat.includes(fixed) || (Number.isInteger(Math.abs(amount)) && new RegExp(`(^|[^\\d.])${Math.abs(amount)}([^\\d.]|$)`).test(flat))
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]

/** Does the excerpt show this date — AND its year? A receipt printed "11/03" carries no year, and none is invented. */
function dateEvidence(iso: string, excerpt: string | null): "shown" | "shown_without_year" | "absent" {
  if (!excerpt) return "absent"
  const [y, mo, d] = iso.split("-").map(Number)
  const e = excerpt.toLowerCase()
  const yy = String(y).slice(2)
  const numeric = new RegExp(`(^|\\D)0?${mo}[/.-]0?${d}(?:[/.-](${y}|${yy}))?(\\D|$)`)
  const isoRe = new RegExp(`${y}-0?${mo}-0?${d}`)
  const named = new RegExp(`${MONTHS[mo - 1]}[a-z]*\\.?\\s+0?${d}(?:st|nd|rd|th)?(?:,?\\s+(${y}|'?${yy}))?`)
  const namedRev = new RegExp(`(^|\\D)0?${d}\\s+${MONTHS[mo - 1]}[a-z]*\\.?(?:,?\\s+(${y}|'?${yy}))?`)
  if (isoRe.test(e)) return "shown"
  for (const re of [numeric, named, namedRev]) {
    const m = re.exec(e)
    if (m) return m.slice(1).some((g) => g === String(y) || g === yy || g === `'${yy}`) ? "shown" : "shown_without_year"
  }
  return "absent"
}

// ─── BUILD THE PROPOSAL FROM ONE READING ──────────────────────────────────────

interface ModelField { value?: unknown; page?: unknown; excerpt?: unknown; confidence?: unknown }

/** One page of the reading, split on the reader's "=== PAGE n ===" markers (a single unmarked page is page 1). */
export function splitPages(text: string): Array<{ page: number; text: string }> {
  const parts = text.split(/^=== PAGE (\d+) ===\s*$/m)
  if (parts.length < 3) return [{ page: 1, text: text.trim() }]
  const out: Array<{ page: number; text: string }> = []
  for (let i = 1; i < parts.length; i += 2) out.push({ page: Number(parts[i]), text: (parts[i + 1] ?? "").trim() })
  return out
}

const asConfidence = (c: unknown): Confidence => (c === "high" || c === "medium" || c === "low" ? c : "low")
const capConfidence = (c: Confidence, cap: Confidence): Confidence => (["low", "medium", "high"].indexOf(c) > ["low", "medium", "high"].indexOf(cap) ? cap : c)
const pageOf = (p: unknown): number | null => (typeof p === "number" && Number.isInteger(p) && p > 0 ? p : typeof p === "string" && /^\d+$/.test(p) ? Number(p) : null)
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null)

interface ReceiptProposal {
  kind: FinancialDocumentKind
  fields: Record<string, FieldEnvelope>
  confidenceByField: Record<string, Confidence>
  summary: string | null
  problems: string[]
}

export function buildReceiptProposal(input: {
  model: Record<string, unknown>
  pages: Array<{ page: number; text: string }>
  readBy: "native_text" | "vision"
  qualityFlags: string[]
  docSha256: string | null
  extractor: string
  nowIso: string
}): ReceiptProposal {
  const m = input.model ?? {}
  const degraded = input.qualityFlags.some((f) => /blur|cut|glare|dark|low_light|partial|rotated/i.test(f))
  const fields: Record<string, FieldEnvelope> = {}
  const base = (unit: FieldUnit, destination: string | null): Omit<FieldEnvelope, "value" | "raw" | "page" | "excerpt" | "evidence_located" | "uncertainty" | "confidence"> => ({
    v: 1, unit, bbox: null, destination, doc_sha256: input.docSha256, extractor: input.extractor, read_by: input.readBy,
    extracted_at: input.nowIso, review_state: "draft", conflict: null,
  })

  const scalar = (key: ReceiptFieldKey, f: ModelField | undefined, normalize: (raw: unknown, excerpt: string | null) => string | number | null, valueCheck?: (v: string | number, excerpt: string | null) => string | null) => {
    const spec = RECEIPT_FIELDS[key]
    const raw = f?.value ?? null
    const excerpt = str(f?.excerpt)
    const cited = pageOf(f?.page)
    const located = locateExcerpt(input.pages, cited, excerpt)
    let value = raw === null || raw === undefined || raw === "" ? null : normalize(raw, excerpt)
    let uncertainty: string | null = null
    let conf = asConfidence(f?.confidence)
    if (value === null) {
      uncertainty = raw === null || raw === undefined || raw === "" ? "not_shown_on_document" : "value_not_in_a_recognizable_format"
      conf = "low"
    } else if (excerpt && located === null) {
      uncertainty = "excerpt_not_found_on_page"; conf = "low"
    } else if (!excerpt) {
      uncertainty = "no_excerpt_cited"; conf = "low"
    } else if (valueCheck) {
      const why = valueCheck(value, excerpt)
      if (why) { uncertainty = why; conf = "low"; if (why === "year_not_shown") value = null }
    }
    if (degraded) conf = capConfidence(conf, "medium")
    fields[key] = { ...base(spec.unit, spec.destination), value, raw: str(raw), page: located ?? cited, excerpt, evidence_located: located !== null, uncertainty, confidence: conf }
  }

  const fm = (k: string) => (m[k] && typeof m[k] === "object" ? (m[k] as ModelField) : undefined)

  scalar("expense.merchant", fm("merchant"), (r) => str(r))
  scalar("expense.date", fm("date"), (r) => normalizeIsoDate(r), (v, ex) => {
    const ev = dateEvidence(String(v), ex)
    return ev === "shown" ? null : ev === "shown_without_year" ? "year_not_shown" : "date_not_in_excerpt"
  })
  const money = (r: unknown) => normalizeUsd(r)
  const moneyCheck = (v: string | number, ex: string | null) => (amountInExcerpt(Number(v), ex) ? null : "amount_not_in_excerpt")
  scalar("expense.total", fm("total"), money, moneyCheck)
  scalar("expense.subtotal", fm("subtotal"), money, moneyCheck)
  scalar("expense.tax", fm("tax"), money, moneyCheck)
  scalar("expense.tip", fm("tip"), money, moneyCheck)
  scalar("expense.balance_due", fm("balance_due"), money, moneyCheck)
  scalar("expense.payment_method", fm("payment_method"), (r) => str(r))
  scalar("expense.currency", fm("currency"), (r, ex) => normalizeCurrency(r, ex ?? (fields["expense.total"]?.excerpt ?? null)))
  // A currency shown only through the total's "$" is evidenced by the total's excerpt, not by a separate one.
  const cur = fields["expense.currency"]
  if ((cur.value === null || !cur.evidence_located) && fields["expense.total"]?.excerpt) {
    const inferred = normalizeCurrency(null, fields["expense.total"].excerpt)
    if (inferred && (cur.value === null || cur.value === inferred)) {
      fields["expense.currency"] = { ...cur, value: inferred, page: fields["expense.total"].page, excerpt: fields["expense.total"].excerpt, evidence_located: fields["expense.total"].evidence_located, uncertainty: fields["expense.total"].evidence_located ? null : "excerpt_not_found_on_page", confidence: fields["expense.total"].confidence }
    }
  }

  // Line items — each one carries its own evidence.
  const rawItems = Array.isArray(m.line_items) ? (m.line_items as Array<Record<string, unknown>>) : []
  const items: LineItem[] = rawItems.slice(0, 200).map((it) => {
    const excerpt = str(it.excerpt)
    const amount = normalizeUsd(it.amount)
    const located = locateExcerpt(input.pages, pageOf(it.page), excerpt)
    return {
      description: str(it.description),
      quantity: typeof it.quantity === "number" && Number.isFinite(it.quantity) ? it.quantity : null,
      amount,
      page: located ?? pageOf(it.page),
      excerpt,
      evidence_located: located !== null && amount !== null && amountInExcerpt(amount, excerpt),
    }
  })
  const itemsUnlocated = items.filter((i) => !i.evidence_located).length
  fields["expense.line_items"] = {
    ...base("line_items", null), value: items, raw: null, page: items[0]?.page ?? null, excerpt: null,
    evidence_located: items.length > 0 && itemsUnlocated === 0,
    uncertainty: items.length === 0 ? "not_shown_on_document" : itemsUnlocated > 0 ? `${itemsUnlocated}_line_items_not_found_on_page` : null,
    confidence: items.length === 0 ? "low" : itemsUnlocated > 0 ? "low" : degraded ? "medium" : "high",
  }

  // The KIND: the model proposes; the evidence can only make it STRICTER (a "paid" invoice with a balance still due is due).
  const proposedKind = (FINANCIAL_DOCUMENT_KINDS as readonly string[]).includes(String(m.document_kind)) ? (m.document_kind as FinancialDocumentKind) : null
  let kind: FinancialDocumentKind = proposedKind ?? "not_financial"
  const due = fields["expense.balance_due"].value
  const tightened = (kind === "paid_invoice" || kind === "receipt") && typeof due === "number" && due > 0
  if (tightened) kind = "invoice_due"
  // A refund / credit is often printed negative; the books record its MAGNITUDE against the expense it reverses.
  if (KIND_RULES[kind].cls === "reversal") {
    for (const k of ["expense.total", "expense.subtotal", "expense.tax", "expense.tip"]) {
      const f = fields[k]
      if (f && typeof f.value === "number" && f.value < 0) fields[k] = { ...f, value: Math.abs(f.value) }
    }
  }
  fields["expense.document_kind"] = {
    ...base("kind", null), value: kind, raw: str(m.document_kind), page: pageOf(fm("kind_evidence")?.page), excerpt: str(fm("kind_evidence")?.excerpt),
    evidence_located: locateExcerpt(input.pages, pageOf(fm("kind_evidence")?.page), str(fm("kind_evidence")?.excerpt)) !== null,
    uncertainty: proposedKind === null ? "kind_not_recognized" : tightened ? "kind_tightened_by_balance_due" : null,
    confidence: proposedKind === null ? "low" : asConfidence(m.kind_confidence),
  }

  const suggestion = suggestExpenseCategory({ merchant: (fields["expense.merchant"].value as string | null) ?? null, lineItems: items, modelSuggestion: str(m.category_suggestion) })
  fields["expense.category"] = {
    ...base("category", RECEIPT_FIELDS["expense.category"].destination), value: suggestion.category, raw: str(m.category_suggestion), page: null, excerpt: null,
    evidence_located: suggestion.basis === "receipt_text", uncertainty: suggestion.basis === "default" ? "no_category_signal_on_receipt" : null,
    confidence: suggestion.basis === "receipt_text" ? "medium" : "low",
  }

  const confidenceByField: Record<string, Confidence> = {}
  for (const [k, f] of Object.entries(fields)) confidenceByField[k] = f.confidence
  const problems = Array.isArray(m.problems) ? (m.problems as unknown[]).map((p) => str(p)).filter((p): p is string => !!p).slice(0, 10) : []
  return { kind, fields, confidenceByField, summary: str(m.summary), problems }
}

// ─── VALIDATION — sums, tax, date, period, evidence ───────────────────────────

export interface ReceiptIssue { code: string; field: string | null; blocking: boolean; message: string }

const TOLERANCE_USD = 0.02
const num = (f: FieldEnvelope | undefined): number | null => (f && typeof f.value === "number" ? f.value : null)
const human = (f: FieldEnvelope | undefined) => f?.read_by === "human"

export function validateReceipt(fields: Record<string, FieldEnvelope>, opts: { today: string }): ReceiptIssue[] {
  const issues: ReceiptIssue[] = []
  const merchant = fields["expense.merchant"], date = fields["expense.date"], total = fields["expense.total"], currency = fields["expense.currency"]
  if (!merchant || merchant.value === null) issues.push({ code: "merchant_unknown", field: "expense.merchant", blocking: true, message: "We could not read who was paid." })
  if (!date || date.value === null) issues.push({ code: "date_unknown", field: "expense.date", blocking: true, message: date?.uncertainty === "year_not_shown" ? "The receipt shows a day but no year, so the date needs to be entered." : "We could not read the date." })
  if (!total || total.value === null) issues.push({ code: "total_unknown", field: "expense.total", blocking: true, message: "We could not read the total." })
  for (const [key, label] of [["expense.total", "total"], ["expense.date", "date"], ["expense.merchant", "merchant"]] as const) {
    const f = fields[key]
    if (f && f.value !== null && !human(f) && (!f.evidence_located || f.uncertainty)) {
      issues.push({ code: `${label}_evidence_unverified`, field: key, blocking: key !== "expense.merchant", message: `We could not confirm the ${label} against the page it came from.` })
    }
  }
  if (currency && currency.value !== null && currency.value !== "USD") {
    issues.push({ code: "currency_not_usd", field: "expense.currency", blocking: true, message: `This receipt is in ${currency.value}; enter the amount in US dollars that was actually charged.` })
  } else if (!currency || currency.value === null) {
    issues.push({ code: "currency_unknown", field: "expense.currency", blocking: !human(total), message: "We could not tell which currency this receipt is in." })
  }
  const d = typeof date?.value === "string" ? date.value : null
  if (d) {
    if (d > opts.today) issues.push({ code: "date_in_future", field: "expense.date", blocking: true, message: "The date is in the future." })
    const openFrom = `${Number(opts.today.slice(0, 4)) - 1}-01-01`
    if (d < openFrom) issues.push({ code: "date_outside_open_period", field: "expense.date", blocking: true, message: "The date is before last year, so it belongs to a tax year that is likely already filed." })
  }
  // SUMS. subtotal + tax + tip = total; line items = subtotal (or total − tax − tip when no subtotal is printed).
  const t = num(total), sub = num(fields["expense.subtotal"]), tax = num(fields["expense.tax"]) ?? 0, tip = num(fields["expense.tip"]) ?? 0
  const items = Array.isArray(fields["expense.line_items"]?.value) ? (fields["expense.line_items"].value as LineItem[]) : []
  const itemSum = items.length > 0 && items.every((i) => typeof i.amount === "number") ? Math.round(items.reduce((s, i) => s + (i.amount as number), 0) * 100) / 100 : null
  const anyHuman = ["expense.total", "expense.subtotal", "expense.tax", "expense.tip"].some((k) => human(fields[k]))
  if (t !== null && sub !== null && Math.abs(sub + tax + tip - t) > TOLERANCE_USD) {
    issues.push({ code: "total_mismatch", field: "expense.total", blocking: !anyHuman, message: `The subtotal, tax and tip add up to $${(sub + tax + tip).toFixed(2)}, but the total reads $${t.toFixed(2)}.` })
  }
  if (itemSum !== null) {
    const target = sub ?? (t !== null ? Math.round((t - tax - tip) * 100) / 100 : null)
    if (target !== null && Math.abs(itemSum - target) > TOLERANCE_USD) {
      issues.push({ code: "line_items_mismatch", field: "expense.line_items", blocking: !anyHuman, message: `The line items add up to $${itemSum.toFixed(2)}, but the receipt's ${sub !== null ? "subtotal" : "pre-tax amount"} is $${target.toFixed(2)}.` })
    }
  } else if (items.some((i) => i.amount === null)) {
    issues.push({ code: "line_item_amount_unknown", field: "expense.line_items", blocking: false, message: "Some line items have no readable amount." })
  }
  if (t !== null && t <= 0) issues.push({ code: "total_not_positive", field: "expense.total", blocking: true, message: "The total is zero or negative." })
  return issues
}

// ─── DUPLICATES — the same file, or the same charge already on the books ──────

function merchantTokens(m: string | null): string[] {
  return String(m ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !["the", "inc", "llc", "store", "corp", "company"].includes(w))
}

export interface DuplicateFinding { exactFile: { documentId: string; postedExpenseId: string | null } | null; sameCharge: Array<{ expenseId: string; description: string; amount: number; expenseDate: string }> }

export function findReceiptDuplicates(input: {
  sameHashDocuments: Array<{ id: string; postedExpenseId: string | null }>
  candidateExpenses: Array<{ id: string; description: string | null; amount: number | string | null; expense_date: string | null }>
  merchant: string | null
  date: string | null
  total: number | null
}): DuplicateFinding {
  const posted = input.sameHashDocuments.find((d) => d.postedExpenseId) ?? input.sameHashDocuments[0] ?? null
  const tokens = merchantTokens(input.merchant)
  const sameCharge = input.date === null || input.total === null ? [] : input.candidateExpenses.filter((e) => {
    if (String(e.expense_date ?? "").slice(0, 10) !== input.date) return false
    if (Math.abs(Number(e.amount) - (input.total as number)) > 0.005) return false
    if (tokens.length === 0) return true
    const desc = String(e.description ?? "").toLowerCase()
    return tokens.some((tk) => desc.includes(tk))
  }).map((e) => ({ expenseId: e.id, description: String(e.description ?? ""), amount: Number(e.amount), expenseDate: String(e.expense_date ?? "").slice(0, 10) }))
  return { exactFile: posted ? { documentId: posted.id, postedExpenseId: posted.postedExpenseId } : null, sameCharge }
}

// ─── THE POSTING DECISION ─────────────────────────────────────────────────────

export type ReceiptAction = "post" | "hold_for_review" | "refuse_duplicate" | "not_postable" | "not_a_receipt"

interface PostingDecision { action: ReceiptAction; color: "green" | "amber" | "red"; reasons: string[] }

/**
 * AUTO-POST ONLY when an EXISTING approved policy names this exact low-risk case (a grant on finance_manager's policy row,
 * read fail-closed in receipt-intake.ts) AND every required fact is high-confidence, evidenced on its page, unduplicated
 * and under the grant's own ceiling. Otherwise the ordinary default: a DRAFT held for human review.
 */
export function decideReceiptPosting(input: {
  kind: FinancialDocumentKind
  fields: Record<string, FieldEnvelope>
  issues: ReceiptIssue[]
  duplicates: DuplicateFinding
  autopost: { ceilingUsd: number } | null
}): PostingDecision {
  const rule = kindRule(input.kind)
  if (rule.cls === "not_financial") return { action: "not_a_receipt", color: "red", reasons: [rule.whyNot!] }
  if (rule.cls === "not_postable") return { action: "not_postable", color: "red", reasons: [rule.whyNot!] }
  if (input.duplicates.exactFile) return { action: "refuse_duplicate", color: "red", reasons: ["This exact file was already uploaded" + (input.duplicates.exactFile.postedExpenseId ? " and recorded." : ".")] }
  const reasons: string[] = []
  const blocking = input.issues.filter((i) => i.blocking)
  if (blocking.length) reasons.push(...blocking.map((i) => i.message))
  if (rule.cls === "reversal") reasons.push("A refund or credit is recorded only against the expense it reverses — choose that expense.")
  if (input.duplicates.sameCharge.length) reasons.push("An expense with the same merchant, date and total is already recorded.")
  if (reasons.length) return { action: "hold_for_review", color: "amber", reasons }
  if (!input.autopost) return { action: "hold_for_review", color: "amber", reasons: ["No approved auto-post policy covers receipts for this account, so a person confirms before anything is recorded."] }
  const required = (Object.keys(RECEIPT_FIELDS) as ReceiptFieldKey[]).filter((k) => RECEIPT_FIELDS[k].required && k !== "expense.category" && k !== "expense.document_kind")
  const weak = required.filter((k) => input.fields[k]?.confidence !== "high" || !input.fields[k]?.evidence_located)
  if (weak.length) return { action: "hold_for_review", color: "amber", reasons: [`Not every required fact was read with high confidence from the page (${weak.map((k) => RECEIPT_FIELDS[k].label.toLowerCase()).join(", ")}).`] }
  const total = num(input.fields["expense.total"])
  if (total === null || total > input.autopost.ceilingUsd) return { action: "hold_for_review", color: "amber", reasons: [`The total is above the $${input.autopost.ceilingUsd.toFixed(2)} your auto-post policy allows.`] }
  return { action: "post", color: "green", reasons: ["Approved auto-post policy: clean, evidenced, unduplicated and under the policy ceiling."] }
}

/** The grant shape on finance_manager's policy row: `receipt_autopost:<kind>:max_usd=<n>`. Anything else authorizes nothing. */
export function autopostGrantFor(grants: Set<string>, kind: FinancialDocumentKind): { ceilingUsd: number } | null {
  if (kindRule(kind).cls !== "expense") return null
  for (const g of grants) {
    const m = /^receipt_autopost:([a-z_]+):max_usd=(\d+(?:\.\d{1,2})?)$/.exec(g)
    if (m && m[1] === kind && Number(m[2]) > 0) return { ceilingUsd: Number(m[2]) }
  }
  return null
}

export function postingClassFor(kind: FinancialDocumentKind): PostingClass { return kindRule(kind).cls }

// ─── REVERSALS — a refund reduces the expense it is linked to, never more ─────

/** PURE gate the ONE writer (logScopedExpense) applies before it books a negative row. */
export function reversalVerdict(input: {
  original: { id: string; amount: number | string; agent_id: string | null; team_id: string | null } | null
  magnitude: number
  alreadyReversed: number
  row: { agent_id: string | null; team_id: string | null }
}): { ok: true } | { ok: false; code: "reversal_original_not_found" | "reversal_original_not_an_expense" | "reversal_exceeds_original" | "reversal_scope_mismatch" } {
  if (!input.original) return { ok: false, code: "reversal_original_not_found" }
  const orig = Number(input.original.amount)
  if (!Number.isFinite(orig) || orig <= 0) return { ok: false, code: "reversal_original_not_an_expense" }
  if (input.magnitude - (orig - input.alreadyReversed) > 0.005) return { ok: false, code: "reversal_exceeds_original" }
  if ((input.original.agent_id ?? null) !== (input.row.agent_id ?? null) || (input.original.team_id ?? null) !== (input.row.team_id ?? null)) {
    return { ok: false, code: "reversal_scope_mismatch" }
  }
  return { ok: true }
}

/** The marker a reversal row's description carries, so the cumulative cap can find earlier reversals of the same expense. */
export function reversalMarker(originalExpenseId: string): string { return `(reverses expense ${originalExpenseId})` }

// ─── TRANSACTION LINK — only on evidence ──────────────────────────────────────

/** A receipt is linked to a deal only when its own text shows that deal's street number AND street name. */
export function transactionLinkVerdict(pagesText: string, propertyAddress: string | null): "evidenced" | "not_evidenced" {
  const m = /^\s*(\d+)\s+([A-Za-z0-9]+)/.exec(String(propertyAddress ?? ""))
  if (!m) return "not_evidenced"
  const t = pagesText.toLowerCase()
  return new RegExp(`(^|\\D)${m[1]}\\s+${m[2].toLowerCase()}\\b`).test(t) ? "evidenced" : "not_evidenced"
}

// ─── WHAT THE TENANT IS TOLD (the charter's message contract) ─────────────────

export interface TenantMessage { whatHappened: string; whatItAffects: string; saved: string; whoActs: string; action: string }

export function receiptTenantMessage(action: ReceiptAction | "posted" | "rejected" | "unreadable" | "not_saved", detail?: { reason?: string | null }): TenantMessage {
  switch (action) {
    case "post":
    case "posted":
      return { whatHappened: "Your receipt was read and recorded as an expense.", whatItAffects: "It now counts in your expense totals and reports.", saved: "The receipt is kept with the expense.", whoActs: "You can correct it from your expenses.", action: "View expenses" }
    case "hold_for_review":
      return { whatHappened: "We found a receipt, but some amounts need review before they can be recorded.", whatItAffects: "Nothing has been added to your expenses yet.", saved: "The receipt and what we read from it are saved for review.", whoActs: "You, or an account admin who keeps these books, can confirm it.", action: "Review the receipt" }
    case "refuse_duplicate":
      return { whatHappened: "This receipt was already uploaded.", whatItAffects: "It was not recorded a second time, so your totals are unchanged.", saved: "The earlier copy is kept.", whoActs: "No action is needed unless this is a different purchase.", action: "Open the earlier receipt" }
    case "not_postable":
    case "not_a_receipt":
      return { whatHappened: detail?.reason ?? "This document was not recorded as an expense.", whatItAffects: "Your expense totals are unchanged.", saved: "The document is saved with what we read from it.", whoActs: "You can upload the receipt or payment confirmation instead.", action: "Upload a receipt" }
    case "rejected":
      return { whatHappened: "You declined this receipt.", whatItAffects: "Nothing was added to your expenses.", saved: "The receipt and what we read are kept for your records.", whoActs: "You can upload it again if this was a mistake.", action: "Back to expenses" }
    case "unreadable":
      return { whatHappened: "We saved your receipt, but could not read it.", whatItAffects: "Nothing has been added to your expenses yet.", saved: "The file is saved.", whoActs: "You can enter the amounts yourself, or retake the photo in good light.", action: "Enter the details" }
    case "not_saved":
      return { whatHappened: "We read your receipt, but could not save the details for review.", whatItAffects: "Nothing has been added to your expenses.", saved: "The file itself is saved; the reading was not.", whoActs: "Please try again in a moment; if it keeps happening, contact platform support.", action: "Try again" }
  }
}
