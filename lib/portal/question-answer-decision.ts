// lib/portal/question-answer-decision.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE PORTAL / WEBSITE ANSWER DECISION (wave 155, lane 155F — directive F1, owner ruling R10).
//
// Owner, verbatim (2026-11-19): "portal questions, the ai should answer if the knowledge is in the memory/agent notification as
// well a ding if not especially if the vendor that is attached to the deal is not on the platform."
//
// NOT A SECOND CHATBOT. The three doors that already answer a client keep their surfaces, their prompts and their model calls:
//   · the client education tutor  — lib/education/client-tutor.ts answerTutorQuestion (buyer / seller / homeowner portals);
//   · the lifetime home assistant — app/actions/portal-lifetime.ts askHomeAssistant (lib/portal/home-assistant.ts prompts);
//   · the website widget          — app/api/widget/message/route.ts (visitor token; never a portal sign-in).
// What they lacked, and what this module adds ONCE for all three (CLAUDE.md §1 — build the missing half, never a fourth door):
//   1. a CLASSIFICATION of the question (general education · tenant procedure · THIS contact's deal · a lender / title / vendor
//      fact · a legal or financial judgment · a human preference) plus three guards (prompt injection, fair-housing steering,
//      a forecast asked as fact) — deterministic, before any model;
//   2. a deal-facts reader scoped to the SESSION's tenant and contact, every fact with source + version + scope;
//   3. a deterministic composer: a deal fact is stated only when a record says it; otherwise what IS on file and what must be
//      verified (no model is asked about a closing date, a lender decision, title, signing, insurance or a vendor's promise);
//   4. a claim screen (HALLUC-006): every figure, date or status claim in a model draft must appear in the retrieved sources,
//      or its sentence is stripped — a draft that loses everything is held and the sourced floor answers instead;
//   5. the DING decision and its ONE writer: one actionable task per unresolved question (deduplicated by a tag), a bell to the
//      agent / TC / compliance / the on-platform vendor seat, and — for an OFF-platform lender / title / insurer — the request
//      to the assigned human to contact that party and record the reply;
//   6. the reply recorder: a human-recorded reply or the vendor's own seat (never a chat message claiming to be the vendor)
//      becomes a sourced fact, the question is re-evaluated, the portal follow-up goes out at most once, the task closes with
//      evidence;
//   7. the knowledge-repair marker (F3): an uncertain, held or re-asked answer opens ONE verification task before any content
//      is made from it (lib/customer-intelligence/website-question-topics.ts holds a theme while one is open).
//
// Guidance applied (plugins/ecc/skills/unified-notifications-ops, subordinate to CLAUDE.md): source, severity, route and the
// next operator action are separate fields; ONE owner and ONE task per unresolved item; duplicates collapse onto the open
// task; a low-signal event (a general question answered from a verified source) is folded — no bell. knowledge-ops: one
// canonical home per fact — a recorded vendor reply lives once (contact_memory, sourced to the task), never copied.
//
// Not server-only and no static runtime import: the proof (scripts/portal-answer-guard.ts) drives it over the in-memory
// client, and the topic feeder imports the pure classifier without pulling the readers.

type Db = { from: (t: string) => any }

// ── 1. THE CLASSIFICATION (pure) ─────────────────────────────────────────────────────────────────

export const QUESTION_KINDS = ["general_education", "tenant_procedure", "own_transaction", "vendor_fact", "legal_financial_judgment", "human_preference"] as const
export type QuestionKind = (typeof QUESTION_KINDS)[number]
export type DealFact = "closing_date" | "lender_clearance" | "lender_receipt" | "title_clearance" | "signing_status" | "insurance_confirmation" | "vendor_promise" | "deal_status"
export type DealPartyRole = "lender" | "title" | "insurance"
export type QuestionGuard = "injection" | "steering" | "forecast"
/** notifications.priority's CHECK vocabulary (scripts/check-vocabularies.ts) — the ONE severity model. */
export type QuestionUrgency = "critical" | "high" | "medium" | "low"

export interface QuestionClass {
  kind: QuestionKind
  fact: DealFact | null
  party: DealPartyRole | null
  guard: QuestionGuard | null
  urgency: QuestionUrgency
  /** About THIS person's own deal, money, address or a decision — never counted toward a public topic (PRIV-003). */
  individual: boolean
  /** May count toward a repeated-question topic: general or procedural, no guard, not individual. */
  topicEligible: boolean
}

const INJECTION_RE = /\b(ignore\s+(?:all\s+|any\s+|your\s+|previous\s+|prior\s+|the\s+)*(?:rules|instructions|prompts?|guardrails)|system\s+prompt|tenant[_\s-]?id|brokerage[_\s-]?id|developer\s+mode|jailbreak|act\s+as\s+(?:an?\s+)?(?:admin|administrator|the\s+broker)|show\s+me\s+(?:their|other|another\s+(?:client|agent|brokerage)'?s?)\s+\w+|i\s+am\s+(?:the|your)\s+(?:lender|title\s+(?:company|agent|officer)|underwriter|escrow\s+officer)|this\s+is\s+(?:the|your)\s+(?:lender|title\s+company|underwriter))/i
const STEERING_RE = /\b(?:safe|unsafe|good|bad|dangerous|nice|rough|sketchy|right)\s+(?:neighbou?rhoods?|areas?|part\s+of\s+town|communit(?:y|ies)|street|block)\b|\bfamil(?:y|ies)\s+like\s+(?:mine|ours|us)\b|\bpeople\s+like\s+(?:me|us)\b|\b(?:who\s+lives|what\s+kind\s+of\s+people|demographics?|crime\s+rate|ethnic\w*|racial\w*|religio\w*|minorit\w*)\b|\b(?:would|will|do)\s+(?:we|i)\s+fit\s+in\b/i
const FORECAST_RE = /\b(?:will|going\s+to|gonna|predict\w*|forecast\w*|expect\w*|think)\b[^.?!]{0,40}\b(?:rates?|prices?|values?|market|payments?)\b[^.?!]{0,40}\b(?:drop|fall|go\s+down|come\s+down|rise|go\s+up|crash|increase|decrease|next\s+(?:week|month|year))|\b(?:rates?|prices?|values?)\s+(?:drop|fall|go\s+down|go\s+up|rise)\s+next\b/i
const WIRE_RE = /\b(?:wire|wiring)\b[^.?!]{0,40}\b(?:instructions?|changed|new\s+account|different\s+account|routing)\b|\bnew\s+wire\b/i
const EMOTION_RE = /\b(?:urgent|asap|immediately|today|tonight|tomorrow|worried|scared|panic\w*|upset|angry|furious|stressed|confused|frustrated|nobody\s+(?:is\s+)?answer\w*)\b/i
const OWN_RE = /\b(?:my|our|we|i|me|us|we're|i'm)\b/i
/** "What is clear to close?" asks for a DEFINITION (education); "Did title come back clean?" asks about THIS deal. */
const DEFINITIONAL_RE = /^\s*(?:what\s+(?:is|are|does|do)\s+(?!my\b|our\b|we\b|i\b)|what's\s+(?!my\b|our\b)|how\s+(?:does|do)\s+(?!i\b|we\b)|explain\b|define\b|what\s+happens\s+(?:if|when)\b)/i

const FACT_RULES: ReadonlyArray<{ fact: DealFact; re: RegExp; party: DealPartyRole | null }> = [
  { fact: "lender_clearance", re: /\b(?:clear(?:ed)?\s+(?:me\s+|us\s+)?to\s+close|ctc|loan\s+(?:approv\w*|decision|status|denied|denial)|underwrit\w*|final\s+approval|approved\s+for\s+(?:the|my|our)\s+(?:loan|mortgage)|conditions?\s+(?:cleared|outstanding|left))\b/i, party: "lender" },
  { fact: "lender_receipt", re: /\b(?:closing\s+disclosure|did\s+(?:the|my|our)\s+(?:lender|bank|loan\s+officer)\s+(?:get|receive)|(?:lender|bank|loan\s+officer)\s+(?:receive|received|got|have|has)\s+(?:my|our|the))\b/i, party: "lender" },
  { fact: "title_clearance", re: /\btitle\b[^.?!]{0,40}\b(?:clean|clear\w*|come\s+back|came\s+back|commitment|issues?|liens?|search)\b/i, party: "title" },
  { fact: "insurance_confirmation", re: /\b(?:insurance|binder|insurer|policy)\b[^.?!]{0,40}\b(?:confirm\w*|bound|in\s+place|active|received|set\s+up|done|approved)\b|\bam\s+i\s+insured\b/i, party: "insurance" },
  { fact: "signing_status", re: /\b(?:did|have|has|was|were|is)\b[^.?!]{0,40}\b(?:sign(?:ed)?|executed|countersigned)\b|\bsigning\s+(?:status|appointment)\b/i, party: null },
  { fact: "closing_date", re: /\b(?:closing\s+(?:date|day)|when\s+(?:do|will|are|can)\s+(?:we|i)\s+close|close\s+on|when\s+is\s+(?:the\s+|my\s+|our\s+)?closing|move[-\s]in\s+date|still\s+closing)\b/i, party: null },
  { fact: "vendor_promise", re: /\b(?:appraiser|inspector|title\s+company|lender|escrow\s+officer|loan\s+officer)\b[^.?!]{0,40}\b(?:will|going\s+to|promised|said\s+(?:they|he|she)\s+would|coming|scheduled|show\s+up)\b/i, party: null },
  { fact: "deal_status", re: /\b(?:status\s+of\s+(?:my|our)\s+(?:deal|transaction|purchase|sale|file)|where\s+are\s+we|how(?:'s|\s+is)\s+(?:my|our)\s+(?:deal|closing|purchase|sale|file)|any\s+update)\b/i, party: null },
]
const PARTY_RE: ReadonlyArray<[DealPartyRole, RegExp]> = [
  ["title", /\b(?:title|escrow)\b/i],
  ["insurance", /\b(?:insur\w*|binder)\b/i],
  ["lender", /\b(?:lender|loan|bank|mortgage|underwrit\w*|ctc|clear\s+to\s+close|closing\s+disclosure)\b/i],
]
const JUDGMENT_RE = /\b(?:should\s+(?:i|we)|is\s+it\s+(?:smart|wise|worth|a\s+good\s+idea)|can\s+(?:i|we)\s+(?:sue|back\s+out|cancel|terminate)|legal(?:ly)?|lawyer|attorney|tax\s+(?:deduct\w*|implications?|advice)|can\s+(?:i|we)\s+afford|how\s+much\s+should\s+(?:i|we)\s+offer)\b/i
const PREFERENCE_RE = /\b(?:i\s+(?:would\s+)?prefer|can\s+(?:my\s+agent|you|someone)\s+(?:call|meet|text|email)|schedule\s+(?:a\s+)?(?:call|meeting|showing|tour)|talk\s+to\s+(?:a|my|an?\s+actual)\s+(?:human|person|agent)|call\s+me|reach\s+out\s+to\s+me)\b/i
const PROCEDURE_RE = /\b(?:your\s+(?:office|brokerage|team)|office\s+hours|how\s+do\s+i\s+(?:upload|use|log\s*in|sign\s*in|find|submit|schedule|reset|message)|portal|documents?\s+tab|where\s+(?:can|do)\s+i\s+find|how\s+does\s+(?:this|the)\s+(?:app|portal|site)\s+work)\b/i
/** A personal detail that makes a question one person's case (PRIV-003): money, a street address, a loan / account number. */
const PERSONAL_DETAIL_RE = /\$\s?\d|\b\d[\d,]{2,}\s?(?:k|dollars?)\b|\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,3}\s+(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|ct|court|way|pl|place|cir|circle|ter|terrace|pkwy|parkway)\b|\b(?:loan|account|acct|file|escrow)\s*(?:#|no\.?|number)\s*\w+/i

/** PURE — what the question is, before any model. Deterministic; the same text always yields the same class. */
export function classifyPortalQuestion(text: string | null | undefined): QuestionClass {
  const t = String(text ?? "").trim()
  const guard: QuestionGuard | null = INJECTION_RE.test(t) ? "injection" : STEERING_RE.test(t) ? "steering" : FORECAST_RE.test(t) ? "forecast" : null
  const urgency: QuestionUrgency = WIRE_RE.test(t) ? "critical" : EMOTION_RE.test(t) ? "high" : "medium"
  const own = OWN_RE.test(t)
  const rule = FACT_RULES.find((r) => r.re.test(t)) ?? null
  const party: DealPartyRole | null = rule?.party ?? (rule ? (PARTY_RE.find(([, re]) => re.test(t))?.[0] ?? null) : null)
  let kind: QuestionKind
  let fact: DealFact | null = null
  if (rule && (own || !DEFINITIONAL_RE.test(t))) {
    fact = rule.fact
    kind = party ? "vendor_fact" : "own_transaction"
  } else if (JUDGMENT_RE.test(t)) kind = "legal_financial_judgment"
  else if (PREFERENCE_RE.test(t)) kind = "human_preference"
  else if (PROCEDURE_RE.test(t)) kind = "tenant_procedure"
  else kind = "general_education"
  if (urgency === "critical" && kind === "general_education") kind = "own_transaction"
  const individual = kind === "own_transaction" || kind === "vendor_fact" || kind === "human_preference" || PERSONAL_DETAIL_RE.test(t)
  const topicEligible = !guard && !individual && (kind === "general_education" || kind === "tenant_procedure")
  return { kind, fact, party: fact ? party : null, guard, urgency: kind === "general_education" || kind === "tenant_procedure" ? (urgency === "medium" ? "low" : urgency) : urgency, individual, topicEligible }
}

// ── 2. THE DEAL FACTS (tenant + contact from the caller's session; every fact sourced) ───────────

export interface SourcedFact {
  fact: DealFact
  text: string
  /** `table:row-id.column` — where the statement comes from. */
  source: string
  /** The row's updated_at / created_at — the version the statement was read at. */
  version: string | null
  scope: "own_deal"
  basis: "domain_record" | "agent_recorded" | "vendor_seat"
  /** true = the statement answers the fact; false = it only says what is (not) on file. */
  answers: boolean
}

export interface DealParty { role: DealPartyRole; vendorId: string | null; name: string | null; onPlatform: boolean; seatUserIds: string[] }
export interface DealRef { id: string; address: string | null; status: string | null; agentId: string | null; coordinatorUserId: string | null }
export interface DealContext {
  brokerageId: string
  contactId: string
  /** contacts.agent_id (agents.id) — the assigned human; null when the contact is not in this tenant or has none. */
  agentId: string | null
  deals: DealRef[]
  facts: SourcedFact[]
  parties: DealParty[]
  blindSpots: string[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY = (v: unknown): string | null => { const s = typeof v === "string" ? v.trim().slice(0, 10) : ""; return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null }
const POSITIVE_TITLE = /^(?:clear|cleared|clean|insurable|commitment_issued|approved)$/i

const FACT_LABEL: Readonly<Record<DealFact, string>> = Object.freeze({
  closing_date: "the closing date", lender_clearance: "clear to close on your loan", lender_receipt: "the lender's receipt of your documents",
  title_clearance: "title clearance", signing_status: "the signing status", insurance_confirmation: "your insurance being in place",
  vendor_promise: "their next step", deal_status: "the status of your file",
})
const PARTY_LABEL: Readonly<Record<DealPartyRole, string>> = Object.freeze({ lender: "your lender", title: "the title company", insurance: "your insurance agent" })
const PARTY_CATEGORIES: Readonly<Record<DealPartyRole, readonly string[]>> = Object.freeze({ lender: ["lender", "refinance_lender"], title: ["title"], insurance: ["insurance"] })

/** The facts THIS contact may be told about THEIR OWN open deals, in THIS tenant. Every read reads its error (§3). */
export async function loadDealContext(db: Db, a: { brokerageId: string; contactId: string }): Promise<DealContext> {
  const out: DealContext = { brokerageId: a.brokerageId, contactId: a.contactId, agentId: null, deals: [], facts: [], parties: [], blindSpots: [] }
  if (!UUID.test(a.contactId) || !a.brokerageId) { out.blindSpots.push("no contact in session — no deal read"); return out }
  const { data: c, error: cErr } = await db.from("contacts").select("id, agent_id").eq("id", a.contactId).eq("brokerage_id", a.brokerageId).maybeSingle()
  if (cErr) { out.blindSpots.push(`contact read refused (${cErr.message})`); return out }
  if (!c) { out.blindSpots.push("contact not in this tenant"); return out }
  out.agentId = (c as { agent_id?: string | null }).agent_id ?? null
  const { data: txns, error: tErr } = await db.from("transactions")
    .select("id, status, stage, property_address, property_state, financing_type, close_date, estimated_close_date, contract_closing_date, contract_closing_terms, contract_closing_source, contract_closing_amendment_ref, actual_close_date, agent_id, coordinator_id, updated_at")
    .eq("brokerage_id", a.brokerageId).is("deleted_at", null)
    .or(`contact_id.eq.${a.contactId},buyer_contact_id.eq.${a.contactId},seller_contact_id.eq.${a.contactId}`)
    .not("status", "in", "(lost,archived)").limit(3)
  if (tErr) { out.blindSpots.push(`deal read refused (${tErr.message})`); return out }
  const deals = (txns ?? []) as Array<Record<string, any>>
  if (deals.length === 0) return out
  const ids = deals.map((d) => String(d.id))
  const coordIds = [...new Set(deals.map((d) => d.coordinator_id).filter(Boolean))] as string[]
  const read = async (table: string, cols: string, col = "transaction_id", values: string[] = ids): Promise<Array<Record<string, any>>> => {
    if (values.length === 0) return []
    const { data, error } = await db.from(table).select(cols).eq("brokerage_id", a.brokerageId).in(col, values)
    if (error) { out.blindSpots.push(`${table} read refused (${error.message})`); return [] }
    return (data ?? []) as Array<Record<string, any>>
  }
  const [coords, lenders, titles, milestones, receipts, assigns] = await Promise.all([
    read("transaction_coordinators", "id, user_id", "id", coordIds),
    read("transaction_lenders", "id, transaction_id, lender_name, underwriting_status, clear_to_close_date, updated_at"),
    read("transaction_title_escrow", "id, transaction_id, title_company_name, title_status, title_commitment_date, closing_scheduled_date, updated_at"),
    read("transaction_milestones", "id, transaction_id, milestone_type, milestone_name, status, completed_at, updated_at"),
    read("trid_disclosure_receipts", "id, transaction_id, verification_status, effective_receipt_date, received_at, created_at"),
    read("vendor_assignments", "id, transaction_id, vendor_id, assignment_type, status"),
  ])
  const coordUser = new Map(coords.map((r) => [String(r.id), (r.user_id as string | null) ?? null]))
  const { resolveClosingDates } = await import("@/lib/transactions/closing-dates")
  for (const d of deals) {
    const id = String(d.id)
    const where = d.property_address ? ` for ${d.property_address}` : ""
    out.deals.push({ id, address: d.property_address ?? null, status: d.status ?? null, agentId: d.agent_id ?? null, coordinatorUserId: d.coordinator_id ? coordUser.get(String(d.coordinator_id)) ?? null : null })
    out.facts.push({ fact: "deal_status", text: `Your transaction${where} is ${String(d.status ?? "open").replace(/_/g, " ")}${d.stage ? ` (stage: ${String(d.stage).replace(/_/g, " ").toLowerCase()})` : ""}.`, source: `transactions:${id}.status`, version: d.updated_at ?? null, scope: "own_deal", basis: "domain_record", answers: true })
    // HALLUC-002: the GOVERNING date — the executed contract or the latest EXECUTED amendment (m927), never the estimate.
    const te = titles.find((r) => String(r.transaction_id) === id)
    const dates = resolveClosingDates({ ...d, scheduled_closing_date: te?.closing_scheduled_date ?? null } as never)
    if (dates.actual) out.facts.push({ fact: "closing_date", text: `It closed on ${dates.actual.date}.`, source: `transactions:${id}.actual_close_date`, version: d.updated_at ?? null, scope: "own_deal", basis: "domain_record", answers: true })
    else if (dates.contractual && dates.contractual.source !== "legacy_close_date") {
      const from = dates.contractual.source === "executed_amendment" ? `the executed amendment${dates.contractual.amendmentRef ? ` (${dates.contractual.amendmentRef})` : ""}` : "the executed contract"
      const wording = dates.contractual.terms === "on_or_before" ? "on or before " : dates.contractual.terms === "on" ? "on " : ""
      out.facts.push({ fact: "closing_date", text: `Per ${from}, closing is ${wording}${dates.contractual.date}.`, source: `transactions:${id}.contract_closing_date`, version: d.updated_at ?? null, scope: "own_deal", basis: "domain_record", answers: true })
      if (dates.anticipated?.basis === "title_schedule" && dates.anticipated.date !== dates.contractual.date) out.facts.push({ fact: "closing_date", text: `The closing appointment on file with title / escrow is ${dates.anticipated.date}.`, source: `transaction_title_escrow:${te?.id}.closing_scheduled_date`, version: te?.updated_at ?? null, scope: "own_deal", basis: "domain_record", answers: true })
    } else out.facts.push({ fact: "closing_date", text: "No executed contract closing date is recorded on your file yet.", source: `transactions:${id}.contract_closing_date`, version: d.updated_at ?? null, scope: "own_deal", basis: "domain_record", answers: false })
    // Lender: a recorded clear-to-close only (transaction_lenders / the CTC milestone) — any other state is "not recorded yet".
    const tl = lenders.find((r) => String(r.transaction_id) === id)
    const ctcMs = milestones.find((m) => String(m.transaction_id) === id && /clear_to_close/.test(String(m.milestone_type ?? m.milestone_name ?? "")) && m.status === "completed")
    if (tl && (DAY(tl.clear_to_close_date) || /^(?:clear_to_close|approved)$/i.test(String(tl.underwriting_status ?? "")))) out.facts.push({ fact: "lender_clearance", text: `Your lender's record shows clear to close${DAY(tl.clear_to_close_date) ? ` on ${DAY(tl.clear_to_close_date)}` : ""}.`, source: `transaction_lenders:${tl.id}.clear_to_close_date`, version: tl.updated_at ?? null, scope: "own_deal", basis: "domain_record", answers: true })
    else if (ctcMs) out.facts.push({ fact: "lender_clearance", text: `The clear-to-close milestone was completed${DAY(ctcMs.completed_at) ? ` on ${DAY(ctcMs.completed_at)}` : ""}.`, source: `transaction_milestones:${ctcMs.id}.status`, version: ctcMs.updated_at ?? null, scope: "own_deal", basis: "domain_record", answers: true })
    else out.facts.push({ fact: "lender_clearance", text: "No clear-to-close from your lender is recorded on your file yet.", source: tl ? `transaction_lenders:${tl.id}.underwriting_status` : `transactions:${id}`, version: tl?.updated_at ?? null, scope: "own_deal", basis: "domain_record", answers: false })
    const rc = receipts.filter((r) => String(r.transaction_id) === id).sort((x, y) => String(y.created_at ?? "").localeCompare(String(x.created_at ?? "")))[0]
    if (rc?.verification_status === "lender_confirmed") out.facts.push({ fact: "lender_receipt", text: `The lender confirmed receipt of the Closing Disclosure${DAY(rc.effective_receipt_date ?? rc.received_at) ? ` (receipt date ${DAY(rc.effective_receipt_date ?? rc.received_at)})` : ""}.`, source: `trid_disclosure_receipts:${rc.id}.verification_status`, version: rc.created_at ?? null, scope: "own_deal", basis: "domain_record", answers: true })
    else out.facts.push({ fact: "lender_receipt", text: rc ? "A Closing Disclosure receipt is recorded but the lender has not confirmed it yet." : "No lender receipt is recorded on your file yet.", source: rc ? `trid_disclosure_receipts:${rc.id}.verification_status` : `transactions:${id}`, version: rc?.created_at ?? null, scope: "own_deal", basis: "domain_record", answers: false })
    if (te && POSITIVE_TITLE.test(String(te.title_status ?? ""))) out.facts.push({ fact: "title_clearance", text: `The title record shows "${String(te.title_status).replace(/_/g, " ")}"${DAY(te.title_commitment_date) ? ` (commitment ${DAY(te.title_commitment_date)})` : ""}.`, source: `transaction_title_escrow:${te.id}.title_status`, version: te.updated_at ?? null, scope: "own_deal", basis: "domain_record", answers: true })
    else out.facts.push({ fact: "title_clearance", text: "No title clearance is recorded on your file yet.", source: te ? `transaction_title_escrow:${te.id}.title_status` : `transactions:${id}`, version: te?.updated_at ?? null, scope: "own_deal", basis: "domain_record", answers: false })
    for (const f of ["signing_status", "insurance_confirmation", "vendor_promise"] as DealFact[]) out.facts.push({ fact: f, text: `Nothing on your file confirms ${FACT_LABEL[f]} yet.`, source: `transactions:${id}`, version: d.updated_at ?? null, scope: "own_deal", basis: "domain_record", answers: false })
  }
  // The parties on the deal: who is the lender / title / insurer, and is it ON the platform (a vendor seat linked to it)?
  const vendorIds = [...new Set(assigns.map((r) => r.vendor_id).filter(Boolean))] as string[]
  const vendors = await read("vendors", "id, name, category", "id", vendorIds)
  const seats = vendorIds.length ? await (async () => {
    const { data, error } = await db.from("user_role_assignments").select("user_id, vendor_id").in("vendor_id", vendorIds)
    if (error) { out.blindSpots.push(`vendor seat read refused (${error.message}) — treated as OFF-platform`); return [] }
    return (data ?? []) as Array<{ user_id: string | null; vendor_id: string }>
  })() : []
  for (const role of ["lender", "title", "insurance"] as DealPartyRole[]) {
    const v = vendors.find((x) => PARTY_CATEGORIES[role].includes(String(x.category ?? "").toLowerCase()))
    const tl = lenders[0], te = titles[0]
    const name = v?.name ?? (role === "lender" ? tl?.lender_name ?? null : role === "title" ? te?.title_company_name ?? null : null)
    const seatUserIds = v ? seats.filter((s) => s.vendor_id === v.id && s.user_id).map((s) => s.user_id as string) : []
    if (v || name) out.parties.push({ role, vendorId: v?.id ?? null, name, onPlatform: seatUserIds.length > 0, seatUserIds })
  }
  // Recorded replies (a human from an off-platform party, or the vendor's own seat) — the "memory" the owner names.
  const { data: mem, error: mErr } = await db.from("contact_memory").select("id, entity_id, metadata, created_at")
    .eq("brokerage_id", a.brokerageId).eq("entity_type", "transaction").eq("memory_kind", "agent_note").in("entity_id", ids).is("archived_at", null)
  if (mErr) out.blindSpots.push(`recorded replies read refused (${mErr.message})`)
  for (const m of ((mem ?? []) as Array<{ id: string; entity_id: string; metadata: Record<string, any> | null; created_at: string | null }>).sort((x, y) => String(y.created_at ?? "").localeCompare(String(x.created_at ?? "")))) {
    const md = m.metadata ?? {}
    const f = md.pq_fact as DealFact | undefined
    if (!f || !FACT_LABEL[f] || out.facts.some((x) => x.fact === f && x.answers)) continue
    out.facts.push({ fact: f, text: recordedReplyText(f, md), source: `contact_memory:${m.id}`, version: m.created_at, scope: "own_deal", basis: md.provenance === "vendor_seat" ? "vendor_seat" : "agent_recorded", answers: true })
  }
  return out
}

/** PURE — the client-facing sentence of a recorded reply, composed from its STRUCTURED fields only (a vendor's free-text note is
 *  never shown to the client — CLAUDE.md §5). */
function recordedReplyText(fact: DealFact, md: Record<string, any>): string {
  const who = typeof md.party_name === "string" && md.party_name ? md.party_name : md.party_role && PARTY_LABEL[md.party_role as DealPartyRole] ? PARTY_LABEL[md.party_role as DealPartyRole] : "the responsible party"
  const by = md.provenance === "vendor_seat" ? `recorded by ${who} on the platform` : "recorded by your agent"
  const on = DAY(md.recorded_at) ? ` on ${DAY(md.recorded_at)}` : ""
  const date = DAY(md.value_date)
  if (md.status === "confirmed") return `${capital(who)} confirmed ${FACT_LABEL[fact]}${date ? ` (${date})` : ""} — ${by}${on}.`
  if (md.status === "date" && date) return `${capital(who)} gave ${date} for ${FACT_LABEL[fact]} — ${by}${on}.`
  return `${capital(who)} said ${FACT_LABEL[fact]} is not confirmed yet — ${by}${on}.`
}
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

// ── 3. THE COMPOSER (pure, deterministic — no model states a deal fact) ──────────────────────────

export interface ComposedAnswer { text: string; sources: Array<{ source: string; version: string | null; basis: SourcedFact["basis"] }>; resolved: boolean; missing: string[]; party: DealParty | null }

export function composeDealAnswer(cls: QuestionClass, ctx: DealContext, agentName: string | null): ComposedAnswer {
  const agent = agentName || "your agent"
  const fact: DealFact = cls.fact ?? "deal_status"
  const party = cls.party ? ctx.parties.find((p) => p.role === cls.party) ?? null : null
  if (ctx.deals.length === 0) {
    return { text: `I don't see an open transaction on your file here, so I can't confirm ${FACT_LABEL[fact]}. I've passed your question to ${agent} so they can check.`, sources: [], resolved: false, missing: [FACT_LABEL[fact]], party }
  }
  const answering = ctx.facts.filter((f) => f.fact === fact && f.answers)
  if (answering.length > 0) {
    return { text: `${answering.map((f) => f.text).join(" ")} If anything changes, ${agent} will let you know.`, sources: answering.map((f) => ({ source: f.source, version: f.version, basis: f.basis })), resolved: true, missing: [], party }
  }
  const status = ctx.facts.find((f) => f.fact === "deal_status")
  const onFile = ctx.facts.find((f) => f.fact === fact && !f.answers)
  const who = party?.name ? party.name : cls.party ? PARTY_LABEL[cls.party] : agent
  const known = [status?.text, onFile?.text].filter(Boolean).join(" ")
  const verify = cls.party
    ? `${capital(FACT_LABEL[fact])} has to be confirmed by ${who}; I've asked ${agent} to get that answer and record it. Until then, please don't treat it as confirmed.`
    : `I've asked ${agent} to confirm ${FACT_LABEL[fact]} and get back to you.`
  return { text: `${known ? `Here's what's on your file: ${known} ` : ""}${verify}`, sources: [status, onFile].filter((f): f is SourcedFact => !!f).map((f) => ({ source: f.source, version: f.version, basis: f.basis })), resolved: false, missing: [FACT_LABEL[fact]], party }
}

/** PURE — the guard answers. Identical for every asker whatever their cues (BIAS-002): no input but the agent's name. */
export function guardAnswer(guard: QuestionGuard, agentName: string | null): string {
  const agent = agentName || "your agent"
  switch (guard) {
    case "injection": return `I can only help with your own questions here, and I can't change how this assistant works or show anyone else's information. What can I help you with about your home or your move?`
    case "steering": return `I can't describe a neighborhood by who lives there or whether it suits a particular kind of household — that's a decision only you can make. For objective information, the city or county's public crime map, the school district's own published reports and a visit at different times of day are good places to start, and ${agent} can share objective data such as recent sales and commute times.`
    case "forecast": return `No one can reliably predict where rates or prices will go, so I won't guess. Your lender can quote today's rate for your situation, and ${agent} can walk you through what recent local numbers show.`
  }
}

// ── 4. THE CLAIM SCREEN (HALLUC-006) — a model draft may not add a fact the sources do not carry ──

const CLAIM_PATTERNS: ReadonlyArray<RegExp> = [
  /\$\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m)?\b/gi,
  /\b\d+(?:\.\d+)?\s?%/g,
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/gi,
  /\b\d{2,}\b/g,
  /\b(?:clear(?:ed)?\s+to\s+close|loan\s+(?:is\s+)?approved|you(?:'re|\s+are)\s+approved|title\s+(?:is\s+|came\s+back\s+)?(?:clean|clear)|fully\s+(?:signed|executed)|(?:is|was|been)\s+signed|insurance\s+is\s+(?:bound|in\s+place|confirmed)|funded|guarantee\w*)\b/gi,
]
const norm = (s: string) => s.toLowerCase().replace(/[,\s]+/g, " ").replace(/\s+/g, " ").trim()

/** PURE — strip every sentence carrying a claim (figure, date, deal status) absent from the retrieved sources. */
export function screenDraftAgainstSources(draft: string, sourceTexts: readonly string[]): { text: string; stripped: string[]; held: boolean } {
  const corpus = norm(sourceTexts.join(" \n "))
  const sentences = String(draft ?? "").split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean)
  const kept: string[] = []
  const stripped: string[] = []
  for (const s of sentences) {
    const claims = CLAIM_PATTERNS.flatMap((re) => [...s.matchAll(new RegExp(re.source, re.flags))].map((m) => m[0]))
    const unsupported = claims.filter((c) => !corpus.includes(norm(c).replace(/^\$\s?/, "")))
    if (unsupported.length > 0) stripped.push(s)
    else kept.push(s)
  }
  const text = kept.join(" ").trim()
  // HELD = the screen took something and what is left is too thin to stand alone, or nothing was drafted. A short CLEAN draft ("Happy
  // to help! What area?") is not held (wave 155, lane 155F2): on the widget's conversation it would have replaced every brief turn.
  return { text, stripped, held: text.length === 0 || (stripped.length > 0 && text.length < 20) }
}

/** The deadline race the widget's screened answer runs under (lane 155F2): resolves the value, or null once `ms` passes. The late
 *  promise is caught (never an unhandled rejection) and its value is DISCARDED — a late draft never reaches anyone. */
export async function withinDeadline<T>(p: Promise<T>, ms: number): Promise<{ value: T; ms: number } | { timedOut: true; ms: number }> {
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | null = null
  p.catch(() => undefined)
  try {
    const out = await Promise.race([p.then((value) => ({ value })), new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), Math.max(1, ms)) })])
    return out ? { value: out.value, ms: Date.now() - started } : { timedOut: true, ms: Date.now() - started }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ── 5. THE ANSWER DECISION ────────────────────────────────────────────────────────────────────────

export interface KnowledgeSource {
  id: string; source: "article" | "kb"; title: string; excerpt: string; version: string | null
  /** The ONE ranker's overlap score, and the score the question would earn against itself (every question word in a title). Both
   *  null when the caller's seam does not rank. Confident = the row's title carries every question word (score === maxScore). */
  score?: number | null
  maxScore?: number | null
}

/** PURE — the ranker is CONFIDENT in a row when its title carries every content word of the question, and there are at least two
 *  (a one-word question matches too much). Derived from the ranker's own scale (title ×2 per word) — no tuned threshold. */
export function knowledgeIsConfident(k: KnowledgeSource | undefined): boolean {
  return !!k && typeof k.score === "number" && typeof k.maxScore === "number" && k.maxScore >= 4 && k.score >= k.maxScore
}

/** PURE — the sourced floor sentence of a help row (a question-shaped title is not repeated in front of its own answer). */
function knowledgeFloor(k: KnowledgeSource): string {
  const ex = k.excerpt.trim()
  const body = `${ex}${/[.!?]$/.test(ex) ? "" : "…"}`
  return /\?\s*$/.test(k.title) ? body : `${k.title}: ${body}`
}
export type AnswerState = "sourced" | "unresolved" | "uncertain" | "held" | "refused" | "deferred"

export interface DingPlan {
  notify: boolean
  createTask: boolean
  recipients: Array<"agent" | "tc" | "compliance" | "vendor_liaison">
  urgency: QuestionUrgency
  reason: string
  /** An OFF-platform party the assigned human must contact (and record the reply). */
  offPlatformRequest: DealPartyRole | null
}

/** PURE — notify or not, whom, how urgently. Routing depends on the CLASS and the record only — never on who asked (BIAS-002). */
export function decideQuestionDing(cls: QuestionClass, a: { answered: AnswerState; party: DealParty | null; hasTc: boolean }): DingPlan {
  const none = (reason: string): DingPlan => ({ notify: false, createTask: false, recipients: [], urgency: cls.urgency, reason, offPlatformRequest: null })
  if (cls.guard === "injection") return none("an instruction to the assistant, not a question — refused, nobody paged")
  const base: DingPlan["recipients"] = ["agent"]
  if (cls.urgency === "critical") return { notify: true, createTask: true, recipients: ["agent", ...(a.hasTc ? ["tc" as const] : []), "compliance"], urgency: "critical", reason: "a wire / funds-safety question — a person confirms by a known phone number", offPlatformRequest: null }
  if (cls.guard === "steering") return { notify: true, createTask: false, recipients: base, urgency: "medium", reason: "a neighborhood-character question — answered with objective sources only; the agent may follow up with objective data", offPlatformRequest: null }
  if (cls.guard === "forecast") return { notify: true, createTask: false, recipients: base, urgency: "medium", reason: "a rate / price forecast asked — no prediction given; a money conversation for the agent", offPlatformRequest: null }
  if (cls.kind === "own_transaction" || cls.kind === "vendor_fact") {
    const recipients: DingPlan["recipients"] = ["agent", ...(a.hasTc ? ["tc" as const] : [])]
    if (a.answered === "sourced") return { notify: true, createTask: false, recipients, urgency: cls.urgency, reason: "answered from the record — the agent hears it because it is their client's deal", offPlatformRequest: null }
    const off = cls.party && (!a.party || !a.party.onPlatform) ? cls.party : null
    if (cls.party && a.party?.onPlatform) recipients.push("vendor_liaison")
    return { notify: true, createTask: true, recipients, urgency: cls.urgency === "medium" ? "high" : cls.urgency, reason: off ? `not on file — ${PARTY_LABEL[off]} is not on the platform, so a person must ask and record the reply` : "not on file — needs a person to verify", offPlatformRequest: off }
  }
  if (cls.kind === "legal_financial_judgment") return { notify: true, createTask: true, recipients: base, urgency: cls.urgency, reason: "a legal / financial judgment — the agent (or the right licensed professional) answers", offPlatformRequest: null }
  if (cls.kind === "human_preference") return { notify: true, createTask: true, recipients: base, urgency: cls.urgency, reason: "the person asked for a human", offPlatformRequest: null }
  if (a.answered === "sourced") return cls.urgency === "high" ? { notify: true, createTask: false, recipients: base, urgency: "high", reason: "answered from verified knowledge, but the person sounds worried", offPlatformRequest: null } : none("answered from verified knowledge — folded, no bell")
  return { notify: true, createTask: true, recipients: base, urgency: "low", reason: "the knowledge base did not answer it — the question is preserved for the agent", offPlatformRequest: null }
}

export interface PortalAnswerDecision {
  cls: QuestionClass
  text: string
  answered: AnswerState
  sources: Array<{ source: string; version: string | null; basis?: string }>
  stripped: string[]
  deal: DealContext | null
  party: DealParty | null
  missing: string[]
  plan: DingPlan
  /** Model calls made for this answer (0 for every deterministic branch). */
  modelCalls: number
  /** Wall-clock of the general branch (ms): the surface's model draft, and the claim screen that judged it. null = not run. */
  timing?: { modelMs: number | null; screenMs: number | null }
  /** Lane 155G's situation chooser (lib/video/situation-artifact-choice.ts) for a knowledge-sourced general answer, when the
   *  surface named a recipient. The ARTIFACT only — delivery stays with the rails that own it. */
  artifact?: import("@/lib/video/situation-artifact-choice").ArtifactChoice | null
}

export interface PortalAnswerInput {
  brokerageId: string
  /** The SESSION's contact (portal sign-in). null on the website widget — a visitor token is never a deal sign-in. */
  contactId: string | null
  question: string
  agentName: string | null
  /** The surface's own model call, given the retrieved sources (the tutor / home prompts stay where they are). It may return the
   *  text its tools retrieved beside the draft (`sourceText`) — those are retrieved sources too, so the screen allows them. */
  generalAnswer?: ((a: { sources: KnowledgeSource[] }) => Promise<string | { draft: string | null; sourceText?: string | null } | null>) | null
  /** Extra facts the surface already holds (the home assistant's facts block) — allowed claims for the screen. */
  extraSourceText?: string | null
  /** Lane 155F2: when the ONE ranker is CONFIDENT (knowledgeIsConfident) the sourced row answers deterministically — no model call,
   *  no wait. Opt-in per surface (the public widget); the tutor keeps its own phrasing. */
  deterministicWhenConfident?: boolean
  /** Lane 155F2: the surface is a CONVERSATION (the widget's qualification chat). A draft with no knowledge row that survived the
   *  screen is delivered as is (a question back to the visitor is not an "uncertain answer"); only a HELD draft escalates. */
  conversational?: boolean
  /** Lane 155G (Outside-lane request 2): the chooser's inputs. `recipient` absent = the chooser is not asked. */
  distinctAskers?: number | null
  recipient?: import("@/lib/video/situation-artifact-choice").ArtifactSituation["recipient"]
}

export interface PortalAnswerDeps {
  knowledge?: (db: Db, a: { brokerageId: string; question: string }) => Promise<KnowledgeSource[]>
  dealContext?: typeof loadDealContext
}

/** The help base this tenant may read (published platform-wide or its own) — lib/support/ticket-triage.ts's ONE ranker. */
const defaultKnowledge: NonNullable<PortalAnswerDeps["knowledge"]> = async (db, a) => {
  const { findHelpCandidates, rankHelpCandidates } = await import("@/lib/support/ticket-triage")
  // The ranker's own ceiling for THIS question: the question ranked against itself (every content word in the title).
  const maxScore = rankHelpCandidates(a.question, [{ id: "self", source: "kb", title: a.question, body: "" }], 1)[0]?.score ?? 0
  return (await findHelpCandidates(db as never, a.brokerageId, a.question, 3)).map((c) => ({ id: c.id, source: c.source, title: c.title, excerpt: c.excerpt, version: c.version ?? null, score: c.score, maxScore }))
}

/**
 * THE DECISION. Deterministic for every guard and every deal / vendor fact (no model); a general or procedural question is
 * answered at once from the tenant's verified knowledge (the surface's own model may phrase it, screened against the sources),
 * with the source and its version recorded — no human click (HALLUC-004). Never throws.
 */
export async function decidePortalAnswer(db: Db, input: PortalAnswerInput, deps: PortalAnswerDeps = {}): Promise<PortalAnswerDecision> {
  const cls = classifyPortalQuestion(input.question)
  const agent = input.agentName || "your agent"
  let modelCalls = 0
  const done = (d: Omit<PortalAnswerDecision, "plan" | "modelCalls">, hasTc = false): PortalAnswerDecision => ({ ...d, plan: decideQuestionDing(cls, { answered: d.answered, party: d.party, hasTc }), modelCalls })
  if (cls.guard) return done({ cls, text: guardAnswer(cls.guard, input.agentName), answered: cls.guard === "injection" ? "refused" : "deferred", sources: [], stripped: [], deal: null, party: null, missing: [] })
  if (cls.urgency === "critical") return done({ cls, text: `Please don't send any money based on new or changed wire instructions. Call ${agent} or your title company at a phone number you already know to confirm before you wire anything — I've flagged this for them right now.`, answered: "deferred", sources: [], stripped: [], deal: null, party: null, missing: ["verbal confirmation of wire instructions"] })
  if (cls.kind === "own_transaction" || cls.kind === "vendor_fact") {
    if (!input.contactId) {
      return done({ cls, text: `I can't see or confirm details of a specific transaction here. Please sign in to your client portal for your file, or ${agent} will follow up with you.`, answered: "unresolved", sources: [], stripped: [], deal: null, party: null, missing: [FACT_LABEL[cls.fact ?? "deal_status"]] })
    }
    let ctx: DealContext
    try { ctx = await (deps.dealContext ?? loadDealContext)(db, { brokerageId: input.brokerageId, contactId: input.contactId }) } catch (e) {
      ctx = { brokerageId: input.brokerageId, contactId: input.contactId, agentId: null, deals: [], facts: [], parties: [], blindSpots: [`deal read threw (${e instanceof Error ? e.message : String(e)})`] }
    }
    const c = composeDealAnswer(cls, ctx, input.agentName)
    return done({ cls, text: c.text, answered: c.resolved ? "sourced" : "unresolved", sources: c.sources, stripped: [], deal: ctx, party: c.party, missing: c.missing }, ctx.deals.some((d) => !!d.coordinatorUserId))
  }
  if (cls.kind === "legal_financial_judgment") return done({ cls, text: `That's a decision for you to make with ${agent} — and for a legal or tax question, an attorney or tax professional. I can explain how things generally work, and I've let ${agent} know you asked.`, answered: "deferred", sources: [], stripped: [], deal: null, party: null, missing: [] })
  if (cls.kind === "human_preference") return done({ cls, text: `I've passed this to ${agent} — they'll reach out to you directly.`, answered: "deferred", sources: [], stripped: [], deal: null, party: null, missing: [] })
  // General education / tenant procedure — the verified knowledge, then the surface's own phrasing, screened.
  let kb: KnowledgeSource[] = []
  try { kb = await (deps.knowledge ?? defaultKnowledge)(db, { brokerageId: input.brokerageId, question: input.question }) } catch { kb = [] }
  const sources = kb.map((k) => ({ source: `${k.source === "article" ? "knowledge_articles" : "help_topics_kb"}:${k.id}`, version: k.version }))
  // Lane 155G's chooser (Outside-lane request 2, applied here): the ARTIFACT for a knowledge-sourced answer — a plain answer, an
  // educational video at the topic pool's recurrence floor, an agent task, or no touch. Asked only when the surface names a recipient.
  const chooseArtifact = async (): Promise<PortalAnswerDecision["artifact"]> => {
    if (!input.recipient) return null
    try {
      const { chooseSituationArtifact } = await import("@/lib/video/situation-artifact-choice")
      return chooseSituationArtifact({ kind: "client_question", question: cls, distinctAskers: input.distinctAskers ?? null, sourceFacts: sources.map((s) => ({ fact: s.source, source: s.source, asOf: s.version })), recipient: input.recipient, producer: { avatarReady: null, renderReady: true }, agentAssigned: true })
    } catch { return null }
  }
  // CONFIDENT help row (lane 155F2): answered from the record itself, at once — no model, nothing for the screen to judge.
  if (input.deterministicWhenConfident && knowledgeIsConfident(kb[0])) {
    return { ...done({ cls, text: knowledgeFloor(kb[0]), answered: "sourced", sources, stripped: [], deal: null, party: null, missing: [] }), timing: { modelMs: null, screenMs: null }, artifact: await chooseArtifact() }
  }
  let draft: string | null = null
  let toolSourceText = ""
  const t0 = Date.now()
  if (input.generalAnswer) {
    modelCalls++
    try {
      const r = await input.generalAnswer({ sources: kb })
      if (typeof r === "string") draft = r
      else if (r) { draft = r.draft ?? null; toolSourceText = r.sourceText ?? "" }
    } catch { draft = null }
  }
  const t1 = Date.now()
  const sourceTexts = [...kb.map((k) => `${k.title} ${k.excerpt}`), input.extraSourceText ?? "", toolSourceText]
  const screened = draft ? screenDraftAgainstSources(draft, sourceTexts) : { text: "", stripped: [], held: true }
  const timing = { modelMs: input.generalAnswer ? t1 - t0 : null, screenMs: Date.now() - t1 }
  // A held draft falls back to the help row only when the ranker is CONFIDENT in it (lane 155F2): a row matched on one shared word
  // ("home") is not an answer to this question, and stating it would be the off-topic answer the screen exists to prevent.
  if (kb.length > 0 && (!screened.held || knowledgeIsConfident(kb[0]))) {
    const text = !screened.held ? screened.text : knowledgeFloor(kb[0])
    return { ...done({ cls, text, answered: "sourced", sources, stripped: screened.stripped, deal: null, party: null, missing: [] }), timing, artifact: await chooseArtifact() }
  }
  // Nothing in the tenant's knowledge answers it: a general explanation may still help, but it is UNCERTAIN — no unsourced figure
  // survives the screen, and the question goes to a person and to knowledge repair (F3). A conversation turn that survived the
  // screen is delivered as is (lane 155F2): the visitor is being asked something, not told an unsourced fact.
  const text = !screened.held ? (input.conversational ? screened.text : `${screened.text} ${agent} can confirm how this applies to you.`) : `That's a good question — I don't have a verified answer for it here, so I've passed it to ${agent}.`
  return { ...done({ cls, text, answered: screened.held ? "held" : "uncertain", sources: [], stripped: screened.stripped, deal: null, party: null, missing: ["a verified knowledge article"] }), timing }
}

// ── 6. THE DING (one writer; one task per unresolved question; a bell to the named recipients) ────

export const PORTAL_QUESTION_TASK_SOURCE = "portal_question"
export const KNOWLEDGE_REPAIR_TASK_SOURCE = "knowledge_repair"
export const PORTAL_QUESTION_NOTIFICATION = "portal_question"

/** PURE — FNV-1a, enough to key a dedup tag (no crypto import on this graph). */
function hash(s: string): string { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 } return h.toString(36) }
const normQuestion = (q: string) => q.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()

/** PURE — the unresolved-question key: per person, per deal, per FACT (two phrasings of "are we clear to close" are ONE question). */
export function questionDedupTag(a: { contactId: string | null; sessionId: string | null; dealId: string | null; cls: QuestionClass; question: string }): string {
  const who = a.contactId ? `c${a.contactId}` : `s${a.sessionId ?? "-"}`
  const what = a.cls.fact ? `f:${a.cls.fact}:${a.dealId ?? "-"}` : a.cls.guard ? `g:${a.cls.guard}` : `q:${normQuestion(a.question)}`
  return `pq:${hash(`${who}|${what}`)}`
}

export interface QuestionDingInput {
  brokerageId: string
  contactId: string | null
  sessionId: string | null
  /** contacts.agent_id / chat_sessions.agent_id (agents.id) — the ONE owner of the task. */
  agentId: string | null
  question: string
  decision: PortalAnswerDecision
  surface: "portal_tutor" | "home_assistant" | "website_widget" | "buyer_assistant"
  now?: Date
}
export interface QuestionDingResult { filed: boolean; deduped: boolean; taskId: string | null; notified: number; reopened: boolean; reason: string }

/** Inserts are counted and their refusals read (§3); the action ledger records who / why / which policy (LAW 5). Never throws. */
export async function fileQuestionDing(db: Db, input: QuestionDingInput, deps: { ledger?: typeof import("@/lib/kernel/action-ledger").withActionLedger } = {}): Promise<QuestionDingResult> {
  const plan = input.decision.plan
  const out: QuestionDingResult = { filed: false, deduped: false, taskId: null, notified: 0, reopened: false, reason: plan.reason }
  try {
    if (!plan.notify) return out
    if (!input.agentId) return { ...out, reason: "no assigned agent on the contact / session — nobody to route to (said, never invented)" }
    const now = input.now ?? new Date()
    const d = input.decision
    const deal = d.deal?.deals[0] ?? null
    const tag = questionDedupTag({ contactId: input.contactId, sessionId: input.sessionId, dealId: deal?.id ?? null, cls: d.cls, question: input.question })
    // ONE per unresolved question: an open task (or, for an FYI bell, one in the last day) collapses the repeat.
    const { data: prior, error: priorErr } = await db.from("tasks").select("id, status").eq("brokerage_id", input.brokerageId).eq("source", PORTAL_QUESTION_TASK_SOURCE).contains("tags", [tag]).limit(20)
    if (priorErr) return { ...out, reason: `dedupe read refused (${priorErr.message}) — nothing filed (fail closed)` }
    const priorRows = (prior ?? []) as Array<{ id: string; status: string | null }>
    const open = priorRows.find((r) => r.status !== "completed" && r.status !== "cancelled")
    if (open) return { ...out, deduped: true, taskId: open.id, reason: "the same unresolved question already has an open task — collapsed" }
    if (!plan.createTask) {
      const since = new Date(now.getTime() - 86_400_000).toISOString()
      const { data: bell, error: bellErr } = await db.from("notifications").select("id").eq("brokerage_id", input.brokerageId).eq("type", PORTAL_QUESTION_NOTIFICATION).eq("entity_type", "portal_question").eq("entity_id", tag).gte("created_at", since).limit(1)
      if (bellErr) return { ...out, reason: `bell dedupe read refused (${bellErr.message}) — nothing sent (fail closed)` }
      if ((bell ?? []).length > 0) return { ...out, deduped: true, reason: "the same answered question was already told to the agent today — folded" }
    }
    out.reopened = priorRows.some((r) => r.status === "completed")
    const ledger = deps.ledger ?? (await import("@/lib/kernel/action-ledger")).withActionLedger
    return await ledger<QuestionDingResult>({
      brokerageId: input.brokerageId, action: "portal.question.ding",
      actor: { type: "manager", managerKey: "ai_isa" },
      subject: { type: input.contactId ? "contact" : "chat_session", id: input.contactId ?? input.sessionId ?? null },
      reasonCode: "HUMAN_REQUESTED", reasonDetail: plan.reason.slice(0, 200), channel: "in_app", riskClass: "LOW_RISK_WRITE",
      systemSource: input.surface, detail: { tag, kind: d.cls.kind, fact: d.cls.fact, guard: d.cls.guard, answered: d.answered, recipients: plan.recipients, off_platform: plan.offPlatformRequest, sources: d.sources.map((s) => s.source).slice(0, 6) },
    }, async () => {
      const r: QuestionDingResult = { ...out }
      let entity: { type: string; id: string } = { type: "portal_question", id: tag }
      if (plan.createTask) {
        const party = d.party
        const who = plan.offPlatformRequest ? (party?.name ?? PARTY_LABEL[plan.offPlatformRequest]) : null
        const title = (plan.offPlatformRequest
          ? `Ask ${who} (not on the platform) and record the reply: ${FACT_LABEL[d.cls.fact ?? "deal_status"]}`
          : d.cls.fact ? `Client question — confirm ${FACT_LABEL[d.cls.fact]}` : `Client question: ${input.question}`).slice(0, 200)
        const description = [
          `Question (exact): "${input.question.slice(0, 600)}"`,
          `Asked via: ${input.surface.replace(/_/g, " ")} · ${now.toISOString()}`,
          deal ? `Deal: ${deal.address ?? deal.id} (${deal.status ?? "open"})` : null,
          `Already answered: "${d.text.slice(0, 600)}"`,
          d.missing.length ? `Missing evidence: ${d.missing.join("; ")}` : null,
          `Urgency: ${plan.urgency} — ${plan.reason}`,
          plan.offPlatformRequest
            ? `Next action: contact ${who} directly, then record their reply on this task. Their silence is NOT confirmation; a message claiming to be them is not either.`
            : party?.onPlatform ? `Next action: ${party.name ?? PARTY_LABEL[party.role]} has a seat on the platform and has been asked; confirm with the client once it answers.`
            : `Next action: answer the client (or record the answer on this task).`,
        ].filter(Boolean).join("\n")
        const due = new Date(now.getTime() + (plan.urgency === "critical" ? 1 : plan.urgency === "high" ? 4 : plan.urgency === "medium" ? 24 : 72) * 3_600_000).toISOString()
        const { data: task, error: taskErr } = await db.from("tasks").insert({
          brokerage_id: input.brokerageId, contact_id: input.contactId, assigned_to_agent_id: input.agentId, transaction_id: deal?.id ?? null,
          title, description, due_date: due, priority: plan.urgency === "critical" ? "urgent" : plan.urgency, status: "pending",
          source: PORTAL_QUESTION_TASK_SOURCE, assignee_type: "agent", auto_generated: true,
          tags: [tag, PORTAL_QUESTION_TASK_SOURCE, ...(d.cls.fact ? [`pq_fact:${d.cls.fact}`] : []), ...(plan.offPlatformRequest ? ["pq_vendor_request", `pq_party:${plan.offPlatformRequest}`] : d.cls.party ? [`pq_party:${d.cls.party}`] : []), ...(r.reopened ? ["pq_reopened"] : [])],
        }).select("id").maybeSingle()
        if (taskErr || !task?.id) return { ...r, reason: `task insert refused (${taskErr?.message ?? "no row"})` }
        r.filed = true
        r.taskId = task.id as string
        entity = { type: "task", id: r.taskId }
      }
      // The bell — every recipient is a users.id (agents.id and users.id are DISJOINT, §3).
      const userIds = new Set<string>()
      const { data: ag, error: agErr } = await db.from("agents").select("user_id").eq("id", input.agentId).eq("brokerage_id", input.brokerageId).maybeSingle()
      if (agErr) r.reason += ` · agent seat read refused (${agErr.message})`
      if (ag?.user_id) userIds.add(ag.user_id as string)
      if (plan.recipients.includes("tc") && deal?.coordinatorUserId) userIds.add(deal.coordinatorUserId)
      if (plan.recipients.includes("compliance")) {
        const { data: co, error: coErr } = await db.from("users").select("id").eq("brokerage_id", input.brokerageId).eq("user_type", "compliance_officer").limit(5)
        if (coErr) r.reason += ` · compliance read refused (${coErr.message})`
        for (const u of (co ?? []) as Array<{ id: string }>) userIds.add(u.id)
      }
      const bellTitle = plan.createTask ? `Client question needs you${plan.urgency === "critical" || plan.urgency === "high" ? " (urgent)" : ""}` : "Your client asked — the assistant answered"
      const bellBody = `${plan.createTask ? "" : "FYI: "}"${input.question.slice(0, 200)}" — ${plan.reason}.`
      const rows = [...userIds].map((uid) => ({ user_id: uid, brokerage_id: input.brokerageId, contact_id: input.contactId, type: PORTAL_QUESTION_NOTIFICATION, title: bellTitle, body: bellBody, entity_type: entity.type, entity_id: entity.id, priority: plan.urgency, channel: "in_app", is_read: false }))
      // The ON-platform vendor's seat is asked through its own inbox — the FACT asked, never the client's words (§5).
      if (plan.recipients.includes("vendor_liaison") && d.party?.onPlatform) {
        for (const uid of d.party.seatUserIds) rows.push({ user_id: uid, brokerage_id: input.brokerageId, contact_id: null, type: PORTAL_QUESTION_NOTIFICATION, title: `A client is waiting on ${FACT_LABEL[d.cls.fact ?? "deal_status"]}`, body: `Please update ${deal?.address ?? "the transaction"} in your portal so the client can be answered.`, entity_type: entity.type, entity_id: entity.id, priority: plan.urgency, channel: "in_app", is_read: false })
      }
      if (rows.length > 0) {
        const { data: ins, error: nErr } = await db.from("notifications").insert(rows).select("id")
        if (nErr) r.reason += ` · bell refused (${nErr.message})`
        else r.notified = Array.isArray(ins) ? ins.length : 0
      }
      return r
    }, {
      settle: (r) => (r.filed || r.notified > 0) ? { status: "executed", outcome: r.filed ? "task_filed" : "agent_notified", provider: "in_app", providerRef: r.taskId } : { status: "failed", outcome: "nothing_landed", error: r.reason.slice(0, 300) },
      replay: (claim) => ({ ...out, reason: claim.kind === "refused" ? `action ledger refused the claim (${claim.error}) — nothing filed` : `already recorded (${claim.kind}) — not filed twice` }),
    })
  } catch (e) {
    return { ...out, reason: `ding threw (${e instanceof Error ? e.message : String(e)})` }
  }
}

// ── 7. THE REPLY (F1.7) — authoritative information arrives; nothing is sent twice ───────────────

/**
 * WHO is telling us. The assigned human (agent / TC / admin, gated by the action) records what an OFF-platform party said. An
 * ON-platform vendor never answers here: it updates the domain record through its OWN seat writers (the lender portal's
 * issueClearToClose / updateLenderLoanStatus, the title portal), which then call reevaluateOpenQuestionsForDeal. A message that
 * merely CLAIMS to be the lender / title / vendor carries no seat and is untrusted (INJECT-004).
 */
export type ReplyProvenance =
  | { kind: "staff"; userId: string }
  | { kind: "chat_claim"; text: string }

export interface QuestionReplyInput {
  brokerageId: string
  taskId: string
  provenance: ReplyProvenance
  reply: { status: "confirmed" | "not_yet" | "date"; date?: string | null; note?: string | null }
  now?: Date
}
export interface QuestionReplyResult {
  ok: boolean
  status: "closed" | "re_evaluated" | "refused_untrusted" | "refused"
  memoryId: string | null
  followUpSent: boolean
  followUpDuplicate: boolean
  answer: string | null
  reason: string
}

export interface QuestionReplyDeps {
  /** THE memory writer (lib/agents/contact-memory.ts embedContactMemory). */
  remember?: (row: { brokerageId: string; entityType: "transaction"; entityId: string; memoryKind: "agent_note"; content: string; sourceTable: string; sourceId: string; metadata: Record<string, unknown> }) => Promise<{ ok: boolean; memoryId?: string; error?: string }>
  /** May the Contact be sent this follow-up, on the portal? Default: the arbiter's lawful-channel gate. */
  mayFollowUp?: (db: Db, a: { brokerageId: string; contactId: string }) => Promise<{ ok: boolean; reason: string }>
  /** THE portal egress (lib/portal/portal-message-egress.ts insertPortalMessage). */
  sendPortal?: typeof import("@/lib/portal/portal-message-egress").insertPortalMessage
  dealContext?: typeof loadDealContext
  ledger?: typeof import("@/lib/kernel/action-ledger").withActionLedger
  /** How the authoritative answer is delivered (lane 155F2, item 4). Default: chooseAnswerFollowUp — the EXISTING follow-up arbiter. */
  chooseFollowUp?: (db: Db, a: AnswerFollowUpInput) => Promise<AnswerFollowUpChoice>
}

// ── 7a. THE FOLLOW-UP CHOICE (lane 155F2 — directive F1.7 "let the arbiter decide whether to send the Contact a follow-up") ─────

export interface AnswerFollowUpInput {
  brokerageId: string
  contactId: string
  fact: DealFact
  answer: string
  sources: string[]
  /** Test / caller seams for the arbiter itself (never a second arbiter): the model, its budget, the tenant policy. */
  decide?: import("@/lib/ai-isa/followup-arbiter").ArbiterDecide
  budgetMs?: number
  policy?: import("@/lib/ai-isa/followup-policy").FollowupPolicy
  /** Called once if the arbiter answers after its budget: the written answer already went (stale_answered) — evidence only. */
  onLate?: (late: { optionId: string | null; ms: number }) => void
}
export interface AnswerFollowUpChoice {
  optionId: "answer_on_portal" | "answer_with_video"
  source: "ai" | "deterministic"
  rationale: string
  timedOut: boolean
  /** The options the arbiter was offered (one option = no choice, nothing asked). */
  menu: string[]
}

/**
 * THE EXISTING ARBITER chooses how a client's answered question is delivered: the written answer on the portal (the planned verdict
 * and the timely fallback), or the written answer with a short explainer video when the answer rests on several records. Inside the
 * arbiter's INTERACTIVE latency budget (ARBITER_LATENCY_BUDGET_MS.interactive, 2.5 s — a person is waiting on this answer): over it,
 * the planned verdict runs and a late reply is evidence only (it never sends — the written answer already went). The written answer is
 * never withheld for a render. "Nothing" is not on this menu: the person asked, and the record now answers them. Never throws.
 */
export async function chooseAnswerFollowUp(db: Db, a: AnswerFollowUpInput): Promise<AnswerFollowUpChoice> {
  const answerOpt = { id: "answer_on_portal" as const, kind: "communication" as const, channels: ["in_app" as const], why: [`the client asked about ${FACT_LABEL[a.fact]} on the portal; the record now answers it`, `answer: ${a.answer.slice(0, 240)}`] }
  const videoOpt = { id: "answer_with_video" as const, kind: "video" as const, channels: ["in_app" as const], why: [`the answer rests on ${a.sources.length} records — a short explainer alongside the written answer may help`] }
  const offerVideo = a.sources.length >= 2
  const menu = offerVideo ? [answerOpt, videoOpt] : [answerOpt]
  const planned: AnswerFollowUpChoice = { optionId: "answer_on_portal", source: "deterministic", rationale: offerVideo ? "the planned verdict: the written answer on the portal" : "one way to answer (a single record) — nothing for the arbiter to choose", timedOut: false, menu: menu.map((o) => o.id) }
  if (!offerVideo) return planned
  try {
    const arb = await import("@/lib/ai-isa/followup-arbiter")
    const policy = a.policy ?? (await (await import("@/lib/ai-isa/followup-policy")).loadFollowupPolicy(db as never, a.brokerageId)).policy
    const facts = {
      subject: "contact" as const,
      relationship: { type: "client_with_an_answered_portal_question", persona: null, hasAssignedAgent: true },
      intent: null,
      history: { hoursSinceAnyTouch: null, hoursSinceAgentTouch: null, campaignTouches7d: null, lastChannel: "in_app", portalEducationViews: null },
      journey: { transactionStage: null, nextMilestone: null, openLessons: null, nextLesson: null },
      preferences: [], fatigueRisk: null, localHour: null,
      moment: { key: "client_question_answered", intent: "A client asked a question on the portal and the authoritative answer just arrived. Choose how it is delivered: the written answer on the portal, or the written answer with a short explainer video when the answer has several moving parts.", daysSinceOpen: 0 },
      blindSpots: ["whether the client read their earlier portal messages is not visible here"],
    }
    const d = await arb.arbitrateFollowUp({
      brokerageId: a.brokerageId, facts, menu: { menu, locked: null }, planned: answerOpt, policy,
      latencyBudgetMs: a.budgetMs ?? arb.ARBITER_LATENCY_BUDGET_MS.interactive,
      onLateResult: a.onLate ? (late) => a.onLate!({ optionId: late.decision?.optionId ?? null, ms: late.ms }) : null,
    }, { decide: a.decide })
    const optionId = d.optionId === "answer_with_video" ? "answer_with_video" : "answer_on_portal"
    return { optionId, source: d.source, rationale: d.rationale, timedOut: !!(d as { timedOut?: unknown }).timedOut, menu: planned.menu }
  } catch (e) {
    return { ...planned, rationale: `the planned verdict stands — the arbiter could not be asked (${e instanceof Error ? e.message : String(e)})` }
  }
}

const defaultMayFollowUp: NonNullable<QuestionReplyDeps["mayFollowUp"]> = async (db, a) => {
  const { lawfulChannelsForContact } = await import("@/lib/ai-isa/followup-arbiter")
  const r = await lawfulChannelsForContact(db, a)
  if (!r.ok) return { ok: false, reason: r.reason }
  return r.lawful.has("in_app") ? { ok: true, reason: "in_app lawful (arbiter readiness)" } : { ok: false, reason: `in_app not lawful: ${(r.refusals.in_app ?? []).join("; ") || "refused"}` }
}

/**
 * Record a reply to an open portal-question task. A chat claim is REFUSED as untrusted (the task stays open and says so); a
 * staff reply is the assigned human's (the action gates agent / TC / admin in the session's tenant). The reply becomes
 * ONE sourced memory row, the question is RE-EVALUATED from the record, the portal follow-up is sent at most once per distinct
 * answer, and the task closes with its evidence. A late reply on a closed task re-evaluates the same way — never a second send.
 */
export async function recordQuestionReply(db: Db, input: QuestionReplyInput, deps: QuestionReplyDeps = {}): Promise<QuestionReplyResult> {
  const res = (status: QuestionReplyResult["status"], reason: string, extra: Partial<QuestionReplyResult> = {}): QuestionReplyResult => ({ ok: status === "closed" || status === "re_evaluated", status, memoryId: null, followUpSent: false, followUpDuplicate: false, answer: null, reason, ...extra })
  try {
    const now = input.now ?? new Date()
    const { data: task, error: tErr } = await db.from("tasks").select("id, brokerage_id, contact_id, transaction_id, assigned_to_agent_id, status, tags, description, title")
      .eq("id", input.taskId).eq("brokerage_id", input.brokerageId).eq("source", PORTAL_QUESTION_TASK_SOURCE).maybeSingle()
    if (tErr) return res("refused", `task read refused (${tErr.message})`)
    if (!task) return res("refused", "no portal-question task with that id in this tenant")
    const tags: string[] = Array.isArray(task.tags) ? task.tags : []
    const fact = (tags.find((t) => t.startsWith("pq_fact:"))?.slice(8) ?? null) as DealFact | null
    const role = (tags.find((t) => t.startsWith("pq_party:"))?.slice(9) ?? null) as DealPartyRole | null
    if (input.provenance.kind === "chat_claim") {
      // INJECT-004: no authenticated seat → not the vendor's statement. Nothing is recorded as fact; the human is asked to verify.
      const { error: uErr } = await db.from("tasks").update({ description: `${task.description ?? ""}\nUNTRUSTED (${now.toISOString()}): a message claimed to be from ${role ? PARTY_LABEL[role] : "the vendor"} without an authenticated vendor seat — verify with them directly before anything is recorded.`.slice(0, 4000), tags: [...new Set([...tags, "pq_untrusted_claim"])] })
        .eq("id", task.id).eq("brokerage_id", input.brokerageId)
      return res("refused_untrusted", `a claim to be the vendor without an authenticated vendor seat is untrusted${uErr ? ` (note not written: ${uErr.message})` : ""}`)
    }
    if (!fact || !task.transaction_id || !task.contact_id) return res("refused", "this task is not a deal-fact question — answer the client directly")
    if (input.reply.status === "date" && !DAY(input.reply.date)) return res("refused", "a date reply needs a YYYY-MM-DD date")
    // LAW 5 + "nothing twice": one ledger row per (task, reply); the same submission again replays and records nothing.
    const ledger = deps.ledger ?? (await import("@/lib/kernel/action-ledger")).withActionLedger
    const provUser = input.provenance.userId
    return await ledger<QuestionReplyResult>({
      brokerageId: input.brokerageId, action: "portal.question.reply_record",
      actor: { type: "user", userId: provUser }, subject: { type: "task", id: task.id },
      reasonCode: "HUMAN_REQUESTED", reasonDetail: `${input.provenance.kind} reply on ${fact}: ${input.reply.status}`, channel: "in_app", riskClass: "LOW_RISK_WRITE",
      idempotencyKey: `pq-reply:${task.id}:${hash(`${input.provenance.kind}|${provUser}|${input.reply.status}|${DAY(input.reply.date) ?? ""}`)}`,
      systemSource: "portal_question_reply", detail: { fact, party: role, provenance: input.provenance.kind },
    }, () => recordVerifiedReply(db, { input: input as QuestionReplyInput & { provenance: Exclude<ReplyProvenance, { kind: "chat_claim" }> }, task, tags, fact, role, now, res }, deps), {
      settle: (r) => r.ok ? { status: "executed", outcome: r.status, provider: "in_app", providerRef: r.memoryId } : { status: "failed", outcome: r.status, error: r.reason.slice(0, 300) },
      replay: (claim) => res("refused", claim.kind === "refused" ? `action ledger refused the claim (${claim.error}) — nothing recorded` : `this reply was already recorded (${claim.kind}) — not recorded or sent twice`),
    })
  } catch (e) {
    return res("refused", `reply threw (${e instanceof Error ? e.message : String(e)})`)
  }
}

async function recordVerifiedReply(
  db: Db,
  a: { input: QuestionReplyInput & { provenance: Exclude<ReplyProvenance, { kind: "chat_claim" }> }; task: Record<string, any>; tags: string[]; fact: DealFact; role: DealPartyRole | null; now: Date; res: (status: QuestionReplyResult["status"], reason: string, extra?: Partial<QuestionReplyResult>) => QuestionReplyResult },
  deps: QuestionReplyDeps,
): Promise<QuestionReplyResult> {
  const { input, task, tags, fact, role, now, res } = a
  try {
    const partyName = (task.title as string | null)?.match(/^Ask (.+?) \(not on the platform\)/)?.[1] ?? null
    const metadata = { pq_fact: fact, party_role: role, party_name: partyName, status: input.reply.status, value_date: DAY(input.reply.date) ?? null, provenance: input.provenance.kind, recorded_by_user_id: input.provenance.userId, recorded_at: now.toISOString(), task_id: task.id, vendor_note_private: !!input.reply.note }
    const remember = deps.remember ?? (async (row: Parameters<NonNullable<QuestionReplyDeps["remember"]>>[0]) => (await import("@/lib/agents/contact-memory")).embedContactMemory(row))
    const content = `Recorded reply on ${FACT_LABEL[fact]}: ${input.reply.status}${DAY(input.reply.date) ? ` ${DAY(input.reply.date)}` : ""}${input.reply.note ? ` — ${input.reply.note.slice(0, 400)}` : ""}`
    const mem = await remember({ brokerageId: input.brokerageId, entityType: "transaction", entityId: task.transaction_id, memoryKind: "agent_note", content, sourceTable: "tasks", sourceId: task.id, metadata })
    if (!mem.ok) return res("refused", `the reply was not recorded (${mem.error ?? "memory refused"}) — the task stays open`)
    const ev = await reevaluateQuestionTask(db, { brokerageId: input.brokerageId, task, tags, fact, role, now, evidence: `REPLY (${now.toISOString()}, recorded by staff): ${input.reply.status}${DAY(input.reply.date) ? ` ${DAY(input.reply.date)}` : ""} → memory ${mem.memoryId}` }, deps)
    if (!ev.updated) return res("refused", `the task was not updated (${ev.error ?? "matched no row"})`, { memoryId: mem.memoryId ?? null, followUpSent: ev.followUpSent, followUpDuplicate: ev.followUpDuplicate, answer: ev.answer })
    return res(ev.closed ? "closed" : "re_evaluated", ev.wasClosed ? "a late reply on a closed task — re-evaluated, sent only if the answer changed" : ev.closed ? "answered from the recorded reply; task closed with evidence" : "recorded; the fact is still not confirmed — the task stays open", { memoryId: mem.memoryId ?? null, followUpSent: ev.followUpSent, followUpDuplicate: ev.followUpDuplicate, answer: ev.answer })
  } catch (e) {
    return res("refused", `reply threw (${e instanceof Error ? e.message : String(e)})`)
  }
}

/**
 * RE-EVALUATE one question task from the record: compose the answer again; when it now resolves, the Contact is told on the
 * portal ONCE per distinct answer (the tag pq_followup:<hash> and the egress's ledger cycle both hold it), and the task closes
 * with the evidence. A closed task is re-evaluated too (a late reply) — it is never re-opened and never re-sent the same answer.
 */
async function reevaluateQuestionTask(
  db: Db,
  a: { brokerageId: string; task: Record<string, any>; tags: string[]; fact: DealFact; role: DealPartyRole | null; now: Date; evidence: string; alreadyTold?: AlreadyTold | null },
  deps: QuestionReplyDeps,
): Promise<{ updated: boolean; closed: boolean; wasClosed: boolean; followUpSent: boolean; followUpDuplicate: boolean; answer: string; error?: string }> {
  const { task, tags, fact, role, now } = a
  const cls: QuestionClass = { kind: role ? "vendor_fact" : "own_transaction", fact, party: role, guard: null, urgency: "medium", individual: true, topicEligible: false }
  const ctx = await (deps.dealContext ?? loadDealContext)(db, { brokerageId: a.brokerageId, contactId: task.contact_id })
  const composed = composeDealAnswer(cls, ctx, null)
  let followUpSent = false, followUpDuplicate = false
  let choiceLine = ""
  const extraTags: string[] = []
  const answerTag = `pq_followup:${hash(composed.text)}`
  // The seat writer ALREADY told this client this fact in its own message (the lender's Clear-to-Close portal message): the question
  // closes on that evidence and nothing is sent again — the client hears it once (lane 155F2, item 2).
  const told = composed.resolved && a.alreadyTold && a.alreadyTold.fact === fact && a.alreadyTold.contactId === task.contact_id ? a.alreadyTold : null
  if (told) choiceLine = ` Client already told by ${told.evidence} — not messaged again.`
  else if (composed.resolved && tags.includes(answerTag)) followUpDuplicate = true
  else if (composed.resolved) {
    const gate = await (deps.mayFollowUp ?? defaultMayFollowUp)(db, { brokerageId: a.brokerageId, contactId: task.contact_id })
    const choice = gate.ok && task.assigned_to_agent_id ? await (deps.chooseFollowUp ?? chooseAnswerFollowUp)(db, { brokerageId: a.brokerageId, contactId: task.contact_id, fact, answer: composed.text, sources: composed.sources.map((s) => s.source) }) : null
    if (choice) choiceLine = ` Follow-up: ${choice.optionId.replace(/_/g, " ")} (${choice.source}${choice.timedOut ? ", arbiter over its budget — the planned verdict ran" : ""}: ${choice.rationale.slice(0, 160)}).${choice.optionId === "answer_with_video" ? " The written answer went now; a short explainer video is suggested — request it from the video studio (it is never sent before approval)." : ""}`
    if (choice?.optionId === "answer_with_video") extraTags.push("pq_video_suggested")
    if (gate.ok && task.assigned_to_agent_id) {
      const send = deps.sendPortal ?? (await import("@/lib/portal/portal-message-egress")).insertPortalMessage
      const sent = await send(db, { brokerage_id: a.brokerageId, contact_id: task.contact_id, agent_id: task.assigned_to_agent_id, transaction_id: task.transaction_id, direction: "agent_to_client", channel: "portal", read: false, body: `An update on your question: ${composed.text}` }, { actor: { type: "manager", managerKey: "ai_isa" }, reasonCode: "HUMAN_REQUESTED", reasonDetail: "answer to the client's portal question after the authoritative information arrived", cycle: `${task.id}:${answerTag}`, systemSource: "portal_question_reply" })
      followUpSent = !sent.error
      if (sent.error && /already|not re-sent/.test(sent.error.message)) followUpDuplicate = true
    }
  }
  const wasClosed = task.status === "completed"
  const line = `\n${a.evidence}; client ${told ? "answered by the party's own message" : followUpSent ? "answered on the portal" : followUpDuplicate ? "already answered with this — not re-sent" : composed.resolved ? "not messaged (the follow-up gate refused)" : "still unresolved"}.${choiceLine} Sources: ${composed.sources.map((s) => s.source).join(", ") || "none"}.`
  const patch: Record<string, unknown> = { description: `${task.description ?? ""}${line}`.slice(0, 4000), tags: [...new Set([...tags, ...extraTags, ...(followUpSent || told ? [answerTag] : []), "pq_replied"])], updated_at: now.toISOString() }
  const closes = !wasClosed && composed.resolved
  if (closes) { patch.status = "completed"; patch.completed_at = now.toISOString() }
  const { data: upd, error: uErr } = await db.from("tasks").update(patch).eq("id", task.id).eq("brokerage_id", a.brokerageId).select("id")
  const updated = !uErr && Array.isArray(upd) && upd.length === 1
  return { updated, closed: closes && updated, wasClosed, followUpSent, followUpDuplicate, answer: composed.text, error: uErr?.message }
}

/** The seat writer already told the client this fact in its own message (lane 155F2): close on it, never message twice. */
export interface AlreadyTold { fact: DealFact; contactId: string; evidence: string }

/**
 * THE ON-PLATFORM VENDOR'S ANSWER (F1.7): after a vendor seat writer updates the domain record (the lender portal's
 * issueClearToClose, updateLenderLoanStatus; the title portal), every OPEN portal-question task on that deal is re-evaluated
 * from the record — answered, followed up once, closed with evidence; still-unknown stays open. Tenant-pinned; never throws.
 */
export async function reevaluateOpenQuestionsForDeal(db: Db, a: { brokerageId: string; transactionId: string; now?: Date; alreadyTold?: AlreadyTold | null }, deps: QuestionReplyDeps = {}): Promise<{ evaluated: number; closed: number; followUps: number; errors: string[] }> {
  const out = { evaluated: 0, closed: 0, followUps: 0, errors: [] as string[] }
  if (!a.brokerageId || !a.transactionId) { out.errors.push("no tenant / transaction — nothing re-evaluated (fail closed)"); return out }
  try {
    const now = a.now ?? new Date()
    const { data, error } = await db.from("tasks").select("id, brokerage_id, contact_id, transaction_id, assigned_to_agent_id, status, tags, description, title")
      .eq("brokerage_id", a.brokerageId).eq("transaction_id", a.transactionId).eq("source", PORTAL_QUESTION_TASK_SOURCE).neq("status", "completed").limit(50)
    if (error) { out.errors.push(`open question tasks unreadable (${error.message})`); return out }
    for (const task of (data ?? []) as Array<Record<string, any>>) {
      const tags: string[] = Array.isArray(task.tags) ? task.tags : []
      const fact = (tags.find((t) => t.startsWith("pq_fact:"))?.slice(8) ?? null) as DealFact | null
      if (!fact || !task.contact_id) continue
      const role = (tags.find((t) => t.startsWith("pq_party:"))?.slice(9) ?? null) as DealPartyRole | null
      out.evaluated++
      const ev = await reevaluateQuestionTask(db, { brokerageId: a.brokerageId, task, tags, fact, role, now, evidence: `RECORD UPDATED (${now.toISOString()}) by the party's own seat`, alreadyTold: a.alreadyTold ?? null }, deps)
      if (ev.closed) out.closed++
      if (ev.followUpSent) out.followUps++
      if (!ev.updated) out.errors.push(`task ${task.id}: ${ev.error ?? "not updated"}`)
    }
  } catch (e) {
    out.errors.push(e instanceof Error ? e.message : String(e))
  }
  return out
}

// ── 8. KNOWLEDGE REPAIR (F3) — a shaky answer is verified by a person BEFORE anything is made from it ──

/** PURE — does this answer need its knowledge repaired? Uncertain or held, or the same person asking the same theme again
 *  within the re-ask window after it was answered. */
export const REASK_WINDOW_MINUTES = 60
export function needsKnowledgeRepair(a: { answered: AnswerState; reaskedAfterAnswer: boolean; correctedByHuman?: boolean }): string | null {
  if (a.correctedByHuman) return "a person corrected the answer"
  if (a.answered === "uncertain" || a.answered === "held") return a.answered === "held" ? "the draft carried claims the knowledge does not support" : "no verified knowledge answered it"
  if (a.reaskedAfterAnswer) return "asked again right after it was answered"
  return null
}

/** One open verification task per theme per tenant (dedup by tag). The topic feeder holds the theme while it is open. */
export async function markKnowledgeForRepair(db: Db, a: { brokerageId: string; agentId: string | null; theme: string; reason: string; sources: string[]; now?: Date }): Promise<{ filed: boolean; deduped: boolean; taskId: string | null; error?: string }> {
  try {
    if (!a.agentId) return { filed: false, deduped: false, taskId: null, error: "no assigned agent to verify it" }
    const tag = `kb_repair:${a.theme}`
    const { data: prior, error } = await db.from("tasks").select("id, status").eq("brokerage_id", a.brokerageId).eq("source", KNOWLEDGE_REPAIR_TASK_SOURCE).contains("tags", [tag]).neq("status", "completed").limit(1)
    if (error) return { filed: false, deduped: false, taskId: null, error: `repair dedupe read refused (${error.message})` }
    if ((prior ?? []).length > 0) return { filed: false, deduped: true, taskId: (prior as Array<{ id: string }>)[0].id }
    const now = a.now ?? new Date()
    const { data: t, error: iErr } = await db.from("tasks").insert({
      brokerage_id: a.brokerageId, assigned_to_agent_id: a.agentId, title: `Verify the answer clients get about: ${a.theme.replace(/_/g, " ")}`.slice(0, 200),
      description: `Why: ${a.reason}.\nSources the assistant used: ${a.sources.join(", ") || "none — no verified article covers it"}.\nUntil this is verified, no topic or content is made from this theme.`,
      due_date: new Date(now.getTime() + 72 * 3_600_000).toISOString(), priority: "medium", status: "pending", source: KNOWLEDGE_REPAIR_TASK_SOURCE, assignee_type: "agent", auto_generated: true, tags: [tag, KNOWLEDGE_REPAIR_TASK_SOURCE],
    }).select("id").maybeSingle()
    if (iErr || !t?.id) return { filed: false, deduped: false, taskId: null, error: `repair task refused (${iErr?.message ?? "no row"})` }
    return { filed: true, deduped: false, taskId: t.id as string }
  } catch (e) {
    return { filed: false, deduped: false, taskId: null, error: e instanceof Error ? e.message : String(e) }
  }
}
