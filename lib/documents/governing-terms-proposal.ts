// lib/documents/governing-terms-proposal.ts
import "server-only"
// ─────────────────────────────────────────────────────────────────────────────
// A MODEL DOES NOT REWRITE A DEAL'S GOVERNING TERMS (wave 156, lane 156E — directive "Prohibited shortcuts": no AI changing
// legal terms without deterministic authority / human review).
//
// app/actions/ai-contract-review.ts applyContractExtraction used to WRITE model-extracted terms straight onto the deal: the
// purchase price, the close date and the property address on public.transactions, and four deadline milestones. It ran on
// every classified purchase agreement a person uploaded — a client's portal upload included (app/actions/documents.ts
// processDocumentWithAI). Now extracted terms are a PROPOSAL, kept on the deal with the source they came from, and a term
// reaches the deal only when a seat on the deal desk ACCEPTS that field (app/actions/governing-terms.ts
// confirmGoverningTermsAction): desk first, per field, idempotent, counted, with a receipt naming who confirmed which field
// from which source.
//
// THE FIELD LIST IS WHAT THAT WRITER WROTE — derived from it, not invented: three columns of the deal and four deadline
// milestones (the closing date is both). Parties (buyer / seller names), earnest money and compensation were extracted but
// never written by it, so they are not proposed here; nothing here adds a governing term the platform did not already set.
//
// STORE: public.transactions.governing_terms_proposals (jsonb, nullable — migration
// supabase/migrations/m1003-transactions-governing-terms-proposals.sql, additive). No existing store fits both sources: the
// client_documents.ai_metadata bag holds an UPLOADED document's AI output, but a contract PASTED on the contract-review screen
// has no document row (client_documents.document_url is NOT NULL), and one vocabulary per function (CLAUDE.md §6) means one
// store. Until m1003 is applied the write is refused by the database (PGRST204) — that refusal is READ and returned, and the
// deal is unchanged (fail closed: the proposal is lost, the deal is never rewritten).
//
// Every function here takes the SERVICE client and the tenant from a caller that has already decided authority. None decides it.

type Db = { from: (t: string) => any }

/** One proposable governing term: where it comes from in an extraction, and what accepting it writes. */
export const GOVERNING_TERM_FIELDS = {
  purchase_price: { from: "purchasePrice", deal: "purchase_price", milestone: null, kind: "money" },
  close_date: { from: "closingDate", deal: "close_date", milestone: "closing_day", kind: "date" },
  property_address: { from: "propertyAddress", deal: "property_address", milestone: null, kind: "text" },
  inspection_deadline: { from: "inspectionDeadline", deal: null, milestone: "inspection_deadline", kind: "date" },
  appraisal_deadline: { from: "appraisalDeadline", deal: null, milestone: "appraisal_deadline", kind: "date" },
  financing_deadline: { from: "financingDeadline", deal: null, milestone: "financing_deadline", kind: "date" },
} as const
export type GoverningTermField = keyof typeof GOVERNING_TERM_FIELDS
const GOVERNING_TERM_FIELD_KEYS = Object.keys(GOVERNING_TERM_FIELDS) as GoverningTermField[]

export type ProposalSource =
  | { kind: "client_document"; document_id: string; document_name?: string | null }
  | { kind: "pasted_contract_text"; sha256: string; excerpt: string }

export interface GoverningTermsProposal {
  id: string
  source: ProposalSource
  proposed_by: string
  proposed_at: string
  fields: Partial<Record<GoverningTermField, string | number>>
  decisions: Partial<Record<GoverningTermField, { decision: "accepted" | "dismissed"; by: string; at: string }>>
}

/** PURE — the proposable fields of an extraction (null / empty / malformed values are not proposed). */
function proposalFieldsFrom(extracted: Record<string, unknown> | null | undefined): Partial<Record<GoverningTermField, string | number>> {
  const out: Partial<Record<GoverningTermField, string | number>> = {}
  for (const k of GOVERNING_TERM_FIELD_KEYS) {
    const spec = GOVERNING_TERM_FIELDS[k]
    const v = (extracted ?? {})[spec.from]
    if (spec.kind === "money") { if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v }
    else if (spec.kind === "date") { if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) out[k] = v.slice(0, 10) }
    else if (typeof v === "string" && v.trim()) out[k] = v.trim()
  }
  return out
}

const sourceKey = (s: ProposalSource) => (s.kind === "client_document" ? `doc:${s.document_id}` : `text:${s.sha256}`)
/**
 * wave 156 (lane 156R, round 2) — THE STORED SHAPE carries a REVISION: `{ rev: <integer>, proposals: [...] }`. Every write goes
 * through casWriteProposals, which writes rev + 1 and matches the rev it read. A store written before this change is the bare
 * array (no rev): it is still read here, and its next write upgrades it to the revisioned shape.
 */
const asList = (v: unknown): GoverningTermsProposal[] =>
  Array.isArray(v) ? (v as GoverningTermsProposal[])
  : v && typeof v === "object" && Array.isArray((v as { proposals?: unknown }).proposals) ? ((v as { proposals: GoverningTermsProposal[] }).proposals)
  : []
/** The revision a stored value carries — null for an empty column, a legacy bare array, or an object without an integer rev. */
const revOf = (v: unknown): number | null => {
  const r = v && typeof v === "object" && !Array.isArray(v) ? (v as { rev?: unknown }).rev : undefined
  return typeof r === "number" && Number.isInteger(r) && r >= 0 ? r : null
}

/** The deal's proposals, read on the service client IN the tenant. A refused read is returned (CLAUDE.md §3). */
export async function readGoverningTermsProposals(db: Db, transactionId: string, brokerageId: string): Promise<
  { ok: true; deal: Record<string, unknown>; proposals: GoverningTermsProposal[] } | { ok: false; error: string }
> {
  const { data, error } = await db.from("transactions")
    .select("id, purchase_price, close_date, property_address, governing_terms_proposals")
    .eq("id", transactionId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { ok: false, error: `Could not read the deal's proposed terms: ${error.message}` }
  if (!data) return { ok: false, error: "Transaction not found in your brokerage" }
  return { ok: true, deal: data as Record<string, unknown>, proposals: asList((data as { governing_terms_proposals?: unknown }).governing_terms_proposals) }
}

/**
 * Record a proposal — writes NOTHING but the proposal. Idempotent per source: the same document (or the same pasted text)
 * proposed again keeps its one proposal; while no field of it has been decided, its values are refreshed from the new read.
 * The update is pinned to the deal and the tenant and COUNTED.
 */
export async function recordGoverningTermsProposal(db: Db, input: {
  transactionId: string; brokerageId: string; proposedBy: string; source: ProposalSource; extracted: Record<string, unknown> | null | undefined
}): Promise<{ ok: true; proposalId: string | null; created: boolean; fields: GoverningTermField[] } | { ok: false; error: string }> {
  const fields = proposalFieldsFrom(input.extracted)
  const keys = Object.keys(fields) as GoverningTermField[]
  if (keys.length === 0) return { ok: true, proposalId: null, created: false, fields: [] }
  const newId = crypto.randomUUID()
  // wave 156 (156R): COMPARE-AND-SET — a proposal recorded while someone confirms cannot erase their decision (see casWriteProposals).
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = await readGoverningTermsProposals(db, input.transactionId, input.brokerageId)
    if (!cur.ok) return cur
    const list = cur.proposals.slice()
    const at = list.findIndex((p) => sourceKey(p.source) === sourceKey(input.source))
    let proposalId: string, created = false
    if (at >= 0) {
      proposalId = list[at].id
      if (Object.keys(list[at].decisions ?? {}).length > 0) return { ok: true, proposalId, created: false, fields: keys }
      list[at] = { ...list[at], fields, proposed_at: new Date().toISOString(), proposed_by: input.proposedBy }
    } else {
      proposalId = newId
      created = true
      list.push({ id: proposalId, source: input.source, proposed_by: input.proposedBy, proposed_at: new Date().toISOString(), fields, decisions: {} })
    }
    const w = await casWriteProposals(db, input, cur.deal.governing_terms_proposals, list)
    if (!w.ok) return { ok: false, error: `The proposed terms were not recorded: ${w.error}` }
    if (w.matched === 1) return { ok: true, proposalId, created, fields: keys }
  }
  return { ok: false, error: "The proposed terms were not recorded — the deal's proposals changed at the same moment twice (or the deal did not match in your brokerage). Re-run the read to propose them again." }
}

/**
 * wave 156 (lane 156R) — THE COMPARE-AND-SET every write of the proposal store goes through. The store is one jsonb value on the
 * deal, so a write is the read-modify-write of that value; two writers that read the same value must not both land. The UPDATE is
 * pinned to the deal and the tenant AND to the REVISION that was read — one small key, matched with the data API's documented
 * JSON-path filter (`governing_terms_proposals->>rev=eq.<n>`; docs.postgrest.org "Tables and Views" › JSON Columns: "This also
 * works with filters"). The value written carries rev + 1. Which predicate:
 *   · the column was NULL            → `governing_terms_proposals IS NULL` (the first proposal);
 *   · a legacy store (no rev)        → `governing_terms_proposals->>rev IS NULL` (it upgrades to rev 1 on this write; a second
 *                                      legacy-reader then matches nothing, because the rev now exists);
 *   · a revisioned store             → `governing_terms_proposals->>rev = <rev read>`.
 * The rows are COUNTED: 1 = this writer won; 0 = someone else wrote first (or the deal is not in this tenant) and the caller
 * re-reads. Never a blind overwrite, and never the whole value in the request.
 */
async function casWriteProposals(db: Db, at: { transactionId: string; brokerageId: string }, readValue: unknown, list: GoverningTermsProposal[], extra: Record<string, unknown> = {}):
  Promise<{ ok: true; matched: number; written: { rev: number; proposals: GoverningTermsProposal[] } } | { ok: false; error: string }> {
  const rev = revOf(readValue)
  const written = { rev: (rev ?? 0) + 1, proposals: list }
  let q = db.from("transactions").update({ ...extra, governing_terms_proposals: written }).eq("id", at.transactionId).eq("brokerage_id", at.brokerageId)
  q = readValue === null || readValue === undefined ? q.is("governing_terms_proposals", null)
    : rev === null ? q.is("governing_terms_proposals->>rev", null)
    : q.eq("governing_terms_proposals->>rev", String(rev))
  const { data, error } = await q.select("id")
  if (error) return { ok: false, error: error.message }
  return { ok: true, matched: ((data ?? []) as unknown[]).length, written }
}

/**
 * Apply a desk seat's per-field decisions on ONE proposal. The caller has already passed the deal desk for this deal.
 *   · accepted, undecided field → written to the deal's column in the SAME row update that records it as accepted, then its
 *     milestone (if any) upserted;
 *   · dismissed, undecided field → recorded as dismissed, nothing written;
 *   · a field already decided → skipped (a replay changes nothing), and a field the proposal does not carry is refused.
 * The row update is pinned to deal + tenant + the proposal store as read (compare-and-set) and COUNTED; the milestone upsert is on
 * (transaction_id, milestone_name), as the old writer did.
 */
export async function applyGoverningTermsDecisions(db: Db, input: {
  transactionId: string; brokerageId: string; proposalId: string; accept: string[]; dismiss: string[]; by: string
}): Promise<{ ok: true; applied: GoverningTermField[]; dismissed: GoverningTermField[]; skipped: GoverningTermField[]; source: ProposalSource } | { ok: false; error: string }> {
  // wave 156 (lane 156R) — TWO CONFIRMS CANNOT RACE. The decisions AND the deal's columns are written in ONE row update that is a
  // compare-and-set on the proposal store as it was read (casWriteProposals): re-read, apply, update where the stored value is still
  // the one read, count the row. A writer that lost re-reads ONCE — a field the winner already decided is then skipped, so every
  // accepted field reaches the deal exactly once and no decision is overwritten — and a second loss is refused plainly. The
  // milestones (another table) are upserted only by the writer that won, only for the fields it claimed.
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = await readGoverningTermsProposals(db, input.transactionId, input.brokerageId)
    if (!cur.ok) return cur
    const list = cur.proposals.slice()
    const at = list.findIndex((p) => p.id === input.proposalId)
    if (at < 0) return { ok: false, error: "That proposal is not on this deal" }
    const p = list[at]
    const unknown = [...input.accept, ...input.dismiss].filter((f) => !(f in (p.fields ?? {})))
    if (unknown.length) return { ok: false, error: `Not a proposed term on this proposal: ${unknown.join(", ")}` }
    const both = input.accept.filter((f) => input.dismiss.includes(f))
    if (both.length) return { ok: false, error: `A term cannot be both accepted and dismissed: ${both.join(", ")}` }
    const decided = p.decisions ?? {}
    const accept = [...new Set(input.accept)].filter((f) => !decided[f as GoverningTermField]) as GoverningTermField[]
    const dismiss = [...new Set(input.dismiss)].filter((f) => !decided[f as GoverningTermField]) as GoverningTermField[]
    const skipped = [...new Set([...input.accept, ...input.dismiss])].filter((f) => decided[f as GoverningTermField]) as GoverningTermField[]
    if (accept.length === 0 && dismiss.length === 0) return { ok: true, applied: [], dismissed: [], skipped, source: p.source }

    const patch: Record<string, unknown> = {}
    const milestones: Array<{ transaction_id: string; brokerage_id: string; milestone_name: string; status: string; due_date: string }> = []
    for (const f of accept) {
      const spec = GOVERNING_TERM_FIELDS[f], v = p.fields[f]
      if (spec.deal) patch[spec.deal] = v
      if (spec.milestone) milestones.push({ transaction_id: input.transactionId, brokerage_id: input.brokerageId, milestone_name: spec.milestone, status: "pending", due_date: String(v) })
    }
    const now = new Date().toISOString()
    const decisions = { ...decided }
    for (const f of accept) decisions[f] = { decision: "accepted", by: input.by, at: now }
    for (const f of dismiss) decisions[f] = { decision: "dismissed", by: input.by, at: now }
    list[at] = { ...p, decisions }
    const w = await casWriteProposals(db, input, cur.deal.governing_terms_proposals, list, patch)
    if (!w.ok) return { ok: false, error: `The deal was not updated: ${w.error}` }
    if (w.matched !== 1) continue
    for (const m of milestones) {
      const { error } = await db.from("transaction_milestones").upsert(m, { onConflict: "transaction_id,milestone_name" })
      if (error) {
        // The decision row landed but this milestone did not: release the claim on the milestone-carrying fields (one more
        // compare-and-set on the value just written) so the person can accept them again — never a field marked done that is not.
        const owed = accept.filter((f) => GOVERNING_TERM_FIELDS[f].milestone)
        const back = list.slice(); const rest = { ...decisions }
        for (const f of owed) delete rest[f]
        back[at] = { ...p, decisions: rest }
        const r = await casWriteProposals(db, input, w.written, back)
        const released = r.ok && r.matched === 1
        return { ok: false, error: `The ${m.milestone_name.replace(/_/g, " ")} milestone was not set: ${error.message}. ${released ? `${owed.join(", ")} ${owed.length === 1 ? "is" : "are"} back to undecided — accept again.` : `The decision for ${owed.join(", ")} stays recorded although its milestone is not set — tell your coordinator.`}` }
      }
    }
    return { ok: true, applied: accept, dismissed: dismiss, skipped, source: p.source }
  }
  return { ok: false, error: "Someone else decided terms on this proposal at the same moment, twice — nothing was applied by you. Re-open the proposed terms and decide again." }
}
