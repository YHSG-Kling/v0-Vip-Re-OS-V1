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
const asList = (v: unknown): GoverningTermsProposal[] => (Array.isArray(v) ? (v as GoverningTermsProposal[]) : [])

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
    proposalId = crypto.randomUUID()
    created = true
    list.push({ id: proposalId, source: input.source, proposed_by: input.proposedBy, proposed_at: new Date().toISOString(), fields, decisions: {} })
  }
  const { data: saved, error } = await db.from("transactions")
    .update({ governing_terms_proposals: list })
    .eq("id", input.transactionId).eq("brokerage_id", input.brokerageId)
    .select("id")
  if (error) return { ok: false, error: `The proposed terms were not recorded: ${error.message}` }
  if ((saved ?? []).length !== 1) return { ok: false, error: "The proposed terms were not recorded — the deal did not match in your brokerage" }
  return { ok: true, proposalId, created, fields: keys }
}

/**
 * Apply a desk seat's per-field decisions on ONE proposal. The caller has already passed the deal desk for this deal.
 *   · accepted, undecided field → written to the deal (column and / or milestone), then recorded as accepted;
 *   · dismissed, undecided field → recorded as dismissed, nothing written;
 *   · a field already decided → skipped (a replay changes nothing), and a field the proposal does not carry is refused.
 * The deal update is pinned to deal + tenant and COUNTED; the milestone upsert is on (transaction_id, milestone_name), as the
 * old writer did. The decisions are written last, counted.
 */
export async function applyGoverningTermsDecisions(db: Db, input: {
  transactionId: string; brokerageId: string; proposalId: string; accept: string[]; dismiss: string[]; by: string
}): Promise<{ ok: true; applied: GoverningTermField[]; dismissed: GoverningTermField[]; skipped: GoverningTermField[]; source: ProposalSource } | { ok: false; error: string }> {
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
  const milestones: Array<{ transaction_id: string; brokerage_id: string; milestone_name: string; status: string; target_date: string }> = []
  for (const f of accept) {
    const spec = GOVERNING_TERM_FIELDS[f], v = p.fields[f]
    if (spec.deal) patch[spec.deal] = v
    if (spec.milestone) milestones.push({ transaction_id: input.transactionId, brokerage_id: input.brokerageId, milestone_name: spec.milestone, status: "pending", target_date: String(v) })
  }
  if (Object.keys(patch).length > 0) {
    const { data: upd, error } = await db.from("transactions").update(patch).eq("id", input.transactionId).eq("brokerage_id", input.brokerageId).select("id")
    if (error) return { ok: false, error: `The deal was not updated: ${error.message}` }
    if ((upd ?? []).length !== 1) return { ok: false, error: "The deal was not updated — nothing matched it in your brokerage" }
  }
  for (const m of milestones) {
    const { error } = await db.from("transaction_milestones").upsert(m, { onConflict: "transaction_id,milestone_name" })
    if (error) return { ok: false, error: `The ${m.milestone_name.replace(/_/g, " ")} milestone was not set: ${error.message}` }
  }
  const now = new Date().toISOString()
  const decisions = { ...decided }
  for (const f of accept) decisions[f] = { decision: "accepted", by: input.by, at: now }
  for (const f of dismiss) decisions[f] = { decision: "dismissed", by: input.by, at: now }
  list[at] = { ...p, decisions }
  const { data: rec, error: recErr } = await db.from("transactions").update({ governing_terms_proposals: list }).eq("id", input.transactionId).eq("brokerage_id", input.brokerageId).select("id")
  if (recErr) return { ok: false, error: `The decision was applied but not recorded: ${recErr.message}` }
  if ((rec ?? []).length !== 1) return { ok: false, error: "The decision was applied but not recorded — the deal did not match" }
  return { ok: true, applied: accept, dismissed: dismiss, skipped, source: p.source }
}
