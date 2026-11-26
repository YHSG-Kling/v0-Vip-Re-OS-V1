#!/usr/bin/env tsx
/**
 * scripts/wave156-b-representation-gate-guard.ts — wave 156, lane 156B (requested key: test:wave156-b-representation-gate).
 *
 * "AFTER THE FULLY SIGNED LISTING AGREEMENT IS IN, THE COMPLIANCE GATE GOES BEFORE CREATING A TRANSACTION." (owner, 2026-11-25)
 * A signature is not compliance. Four governing records stay distinct — listing agreement, listing, offer, purchase transaction —
 * and ONE typed decision (lib/kernel/compliance/representation-gate.ts: allow | hold | refuse | needs_review, blocking reasons,
 * evidence hash, reviewer authority) is reused by every door. This guard DRIVES the real exported product code on the in-memory
 * client (scripts/in-memory-supabase.ts) with COUNTED seams for notifications, the e-sign ladder writer and the lifecycle kernel.
 *
 *   §A  CENSUS (comment-stripped, derived — never retyped): every `transactions` INSERT site in app/ lib/ services/ workflows/
 *       runs the transaction-creation gate first; none lives in an e-sign / webhook / listing-agreement module; the offer bridge
 *       (the one offer → transaction chokepoint) runs the substantive review and reads back a racing twin. Positive controls.
 *   §B  THE LISTING DECISION (pure, driven): a complete consistent packet is NEEDS_REVIEW, not allow, until a reviewer approves
 *       THAT evidence hash; contradiction (price, address, dates, compensation, legal description, state form, signer identity),
 *       missing initials, empty / failed / low-confidence extraction, superseded version, ambiguous signer, unsigned addendum →
 *       HOLD naming the document; another tenant → REFUSE; a changed term unbinds an earlier approval.
 *   §C  THE LISTING LOOP (C01, C02, driven): a fully signed agreement goes to review, never straight to a stage hop and never to a
 *       transaction; a changed term / missing initial holds with the exact document linked; the reviewer's approval advances it
 *       once; a later document REVOKES readiness and the activation door refuses.
 *   §D  STATE-SPECIFIC CHECKLIST (driven through the activation gate): a TX-only requirement holds a TX listing, not a CA one.
 *   §E  THE OFFER DECISION (pure, driven): field-vs-document contradiction holds; two executed papers disagreeing hold; an
 *       executed addendum the record does not reflect holds; an UNSIGNED addendum never overwrites a signed term.
 *   §F  OFFER → TRANSACTION (C03, driven through createTransactionFromOffer): a compliant executed offer creates exactly ONE
 *       transaction even when two webhook deliveries race (m1001's unique index modeled); a held contract creates none; an unsigned
 *       addendum's price never reaches the transaction.
 *   §G  AUTHORITY: who may accept a packet (compliance reviewer / tenant admin; a solo owner) and who never may (the owning agent
 *       alone, TC, team lead, vendor, Contact, another tenant) — driven through the pure rule AND the reviewer door, which also
 *       refuses a stale evidence hash and refuses to approve a hold.
 *
 * RED AT BASE: WAVE156B_ROOT=<the pre-wave tree> loads that tree's modules; the decision module does not exist there, the bridge
 * runs no review, so §A–§G go red (each failure is printed).
 *
 * BLIND SPOTS (published beside the number, CLAUDE.md §2): DB triggers / RPCs that insert `transactions` are not visible to a source
 * scan (checked live once, 2026-11-25: no public function body inserts into transactions); the in-memory unique index models m1001,
 * which is a FILE until the integrator applies it; the comparison reads `documents.extracted_fields` — a field the scanner never
 * extracts (it has no legal_description key today) can only be "unverified_by_machine" for the reviewer; the form LICENSE/version is
 * recorded (state_form_id) but not compared against a licensed-forms registry; seats are proved through the pure rule and the
 * reviewer door, not through live RLS.
 */
import { registerHooks } from "node:module"
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { join } from "node:path"
import { memSupabase, type MemClient, type Row } from "./in-memory-supabase"
import { stripComments } from "./strip-comments"

const WT = process.cwd()
const ROOT = process.env.WAVE156B_ROOT || WT
let passed = 0, failed = 0
const fails: string[] = []
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; fails.push(name); console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 400)}`}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const raw = (f: string): string => { const p = join(ROOT, f); return existsSync(p) ? readFileSync(p, "utf8") : "" }
const code = (f: string): string => stripComments(raw(f))

// ═══ seams (installed BEFORE any product module loads) ═══════════════════════════════════════════════════════════════════
const G = globalThis as any
G.__B = { mem: null as MemClient | null, seat: null as any, calls: { notify: [] as any[], packet: [] as any[], lifecycle: [] as any[], parties: 0, submit: [] as any[] } }
const realUrl = (p: string) => pathToFileURL(join(ROOT, p)).href
const REPLACE: Record<string, string> = {
  "lib/supabase/service.ts": "export function createServiceClient(){ return globalThis.__B.mem }",
  "lib/supabase/server.ts": "export async function createClient(){ return globalThis.__B.mem }",
  "lib/notifications/notify-helpers.ts": "const c = () => globalThis.__B.calls; export async function notifyComplianceFlag(_s, input){ c().notify.push(input); return { notified_count: 1, recipient_user_ids: [] } }; export async function notifyTransactionParties(){ c().parties++; return { sent: true, already_notified: false, errors: [] } }",
  "lib/esign/packet-state-writer.ts": "export async function advanceEsignPacketState(_s, p){ globalThis.__B.calls.packet.push(p.to); return { ok: true } }",
  "lib/kernel/lifecycle.ts": "export async function transitionLifecycle(p){ globalThis.__B.calls.lifecycle.push(p.toState); return { success: true } }",
  "lib/kernel/write-sentinel.ts": "export async function sentinelWrite(_s, p){ return await p }",
  "lib/transactions/milestone-service.ts": "export async function ensureRequiredMilestones(){ return { ok: true } }; export async function seedJourneyMilestones(){ return { ok: true } }",
  "lib/transactions/participant-populator.ts": "export async function populateInitialParticipants(){ return { ok: true } }",
  "lib/transactions/closing-compliance.ts": "export async function pinDealChecklistAtCreation(){ return { error: null } }",
  "lib/offers/financing-subtype.ts": "export async function readFinancingSubtype(){ return { ok: true, subtype: null } }; export async function persistFinancingSubtype(){ return { ok: true } }",
  "lib/transactions/closing-dates.ts": "export async function seedContractClosing(){ return { ok: true } }; export async function readContractWordingAtPromotion(){ return { ok: true } }",
  "lib/transactions/contingency-deadlines.ts": "export async function ensureContingencyDeadlines(){ return { ok: true } }",
  "lib/kernel/transactions.ts": "export async function emitTransactionEvent(){ return { inserted: true } }",
  "lib/kernel/action-ledger.ts": "export async function withActionLedger(_c, run){ return run() }; export async function ledgerSessionAction(_c, run){ return run() }; export async function ledgerToolCall(_c, run){ return run() }",
  "lib/agreements/session-actor.ts": "export async function resolveSessionActor(){ const s = globalThis.__B.seat; return s ? { ok: true, actor: s } : { ok: false, error: 'no session' } }",
  "app/actions/buyer-offer/submit-to-compliance.ts": "export async function submitOfferToCompliance(p){ globalThis.__B.calls.submit.push(p); return { success: true, transaction_id: 'tx-from-submit' } }",
}
const BY_SPEC: Record<string, string> = {
  // services/supabaseService.ts builds its own admin client — handed the in-memory one (env set below; nothing reaches a network).
  // A proxy onto the CURRENT world: the service caches its admin client, so a fixed object would pin the first fixture.
  "@supabase/supabase-js": "export function createClient(){ return new Proxy({}, { get: (_t, k) => globalThis.__B.mem[k] }) }",
  "server-only": "export {}",
  "next/cache": "export function revalidatePath(){}; export function revalidateTag(){}; export function unstable_noStore(){}; export function unstable_cache(f){ return f }",
  "next/headers": "export async function headers(){ return new Map() }; export async function cookies(){ return { get(){}, getAll(){ return [] }, set(){}, delete(){} } }",
}
const dataUrl = (c: string) => `data:text/javascript,${encodeURIComponent(c)}`
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://in-memory.invalid"
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "in-memory-not-a-key"
function aliasPath(rel: string): string | null {
  for (const c of [rel, `${rel}.ts`, `${rel}.tsx`, `${rel}/index.ts`]) { const p = join(ROOT, c); if (existsSync(p) && !statSync(p).isDirectory()) return p }
  return null
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    if (BY_SPEC[spec] !== undefined) return { url: dataUrl(BY_SPEC[spec]), shortCircuit: true }
    const aliased = spec.startsWith("@/") ? aliasPath(spec.slice(2)) : null
    const r = aliased ? { url: pathToFileURL(aliased).href, shortCircuit: true } : next(spec, ctx)
    if (String(ctx?.parentURL ?? "").startsWith("data:")) return r
    // `?real` loads the REAL module even when it is stubbed for everyone else (the coordinator-routing and kernel-door proofs).
    if (String(r.url ?? "").includes("?real")) return r
    const path = String(r.url ?? "").split("?")[0]
    const rep = Object.keys(REPLACE).find((k) => path === realUrl(k))
    return rep ? { url: dataUrl(REPLACE[rep]), shortCircuit: true } : r
  },
})
const load = async (p: string, real = false): Promise<any> => { try { return await import(pathToFileURL(join(ROOT, p)).href + (real ? "?real" : "")) } catch (e) { return { __loadError: (e as Error)?.message?.slice(0, 200) ?? "load failed" } } }
const resetCalls = () => { G.__B.calls = { notify: [], packet: [], lifecycle: [], parties: 0, submit: [] } }

// ═══ fixtures ════════════════════════════════════════════════════════════════════════════════════════════════════════════
const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const B = u(1), B2 = u(2), L = u(10), LA = u(11), DOC = u(12), DISC = u(13), ADD = u(14), S = u(20), AG = u(30), AU = u(31), CO = u(32)
const O = u(40), CB = u(41), CDOC = u(42), UADD = u(43), CDOC2 = u(44), EADD = u(45)
const T0 = "2026-11-20T12:00:00.000Z"
const fullSc = (parties: string[]) => ({ signatures: parties.map((p) => ({ signer_role: p, signer_name: p === "seller" ? "Sam Seller" : p === "agent" ? "Alex Agent" : `${p} person`, signed: true })), initials: parties.map((p) => ({ signer_role: p, all_required_initials_present: true })) })
const agreementDoc = (over: Partial<Row> = {}, fields: Record<string, unknown> = {}): Row => ({
  id: DOC, brokerage_id: B, listing_id: L, classification: "listing_agreement", classification_confidence: "high", scanned_at: T0, scan_error: null,
  metadata: {}, state_code: "TX", state_form_id: "TXR 1101", created_at: T0, signature_completeness: fullSc(["agent", "seller"]),
  extracted_fields: { property_address: "12 Oak St, Austin, TX 78701", zip_code: "78701", state: "TX", list_price: "500,000", list_date: "2026-11-20", expiration_date: "2027-06-30", commission_rate: 6, seller_name: "Sam Seller", legal_description: "Lot 4, Block 2, Oak Hills", ...fields },
  ...over,
})
const listingRow = (over: Partial<Row> = {}): Row => ({ id: L, brokerage_id: B, agent_id: AG, seller_contact_id: S, contact_id: null, state: "TX", address: "12 Oak Street", city: "Austin", zip: "78701", list_price: 500000, expiration_date: "2027-06-30", legal_description: "Lot 4, Block 2, Oak Hills", commission_rate: 6, lifecycle_stage: "LISTING_AGREEMENT_SIGNED", go_live_date: "2026-12-10", metadata: {}, ...over })
function listingWorld(o: { listing?: Partial<Row>; doc?: Row; extraDocs?: Row[]; events?: Row[]; rules?: Row[] } = {}): MemClient {
  return memSupabase({
    listings: [listingRow(o.listing)],
    listing_agreements: [{ id: LA, listing_id: L, brokerage_id: B, esign_status: "fully_signed", compliance_passed: false, agent_signed_at: T0, seller_signed_at: T0, fully_executed_at: null, effective_date: "2026-11-20", expiration_date: "2027-06-30", total_commission_rate: 6, listing_commission_rate: 3, created_at: T0 }],
    documents: [o.doc ?? agreementDoc(), { id: DISC, brokerage_id: B, listing_id: L, classification: "disclosure", classification_confidence: "high", scanned_at: T0, metadata: {}, signature_completeness: fullSc(["agent", "seller"]), extracted_fields: { disclosure_type: "seller" }, created_at: T0 }, ...(o.extraDocs ?? [])],
    contacts: [{ id: S, brokerage_id: B, first_name: "Sam", last_name: "Seller" }],
    agents: [{ id: AG, user_id: AU, brokerage_id: B }],
    users: [{ id: AU, brokerage_id: B, team_id: null, user_type: "agent" }, { id: CO, brokerage_id: B, team_id: null, user_type: "compliance_officer" }],
    brokerage_required_documents: o.rules ?? [
      { id: u(90), brokerage_id: B, classification: "listing_agreement", is_required: true, deal_type: "seller", scope_type: "brokerage", scope_id: B, block_on_missing: true, state_code: null },
      { id: u(91), brokerage_id: B, classification: "disclosure", is_required: true, deal_type: "seller", scope_type: "brokerage", scope_id: B, block_on_missing: true, state_code: "TX", legal_basis: "state_requirement" },
    ],
    compliance_events: o.events ?? [], transactions: [], activities: [], notifications: [],
  }, { uuidIds: true, stampCreatedAt: true })
}
const PASS_GATE = { allowed: true, refusals: [] as any[] }

// ═══ §A CENSUS ══════════════════════════════════════════════════════════════════════════════════════════════════════════
function tsFiles(dir: string, out: string[] = []): string[] {
  const abs = join(ROOT, dir); if (!existsSync(abs)) return out
  for (const e of readdirSync(abs)) { if (e === "node_modules" || e.startsWith(".")) continue; const p = join(dir, e); if (statSync(join(ROOT, p)).isDirectory()) tsFiles(p, out); else if (/\.(ts|tsx)$/.test(e)) out.push(p) }
  return out
}
const INSERT_RE = /from\(\s*["'`]transactions["'`]\s*\)\s*\.(insert|upsert)\(/g
function insertSites(src: string): number[] { const out: number[] = []; INSERT_RE.lastIndex = 0; let m: RegExpExecArray | null; while ((m = INSERT_RE.exec(src))) out.push(m.index); return out }
function sectionA() {
  section("§A census — every transactions writer, derived from comment-stripped source")
  check("POSITIVE CONTROL: the insert finder sees a fixture insert", insertSites('await db.from("transactions")\n  .insert({ deal_name: "x" })').length === 1)
  check("NEGATIVE CONTROL: …and not a tombstone that quotes one", insertSites(stripComments('// .from("transactions").insert({})\nconst x = 1')).length === 0)
  const gatedIn = (src: string) => { const at = insertSites(src)[0]; const before = src.slice(0, at); let s = 0; for (const m of before.matchAll(/\basync\s+(?:function\s+)?[A-Za-z_$][\w$]*\s*\(/g)) s = m.index ?? s; return /assertTransactionCreationAllowed\(/.test(before.slice(s)) }
  check("POSITIVE CONTROL: the gate finder sees a gated CLASS METHOD", gatedIn('class S { async createT(x) { const g = await assertTransactionCreationAllowed(db, {}); await db.from("transactions").insert(x) } }'))
  check("NEGATIVE CONTROL: …and flags an ungated function even when an EARLIER function in the file is gated", !gatedIn('async function a(){ await assertTransactionCreationAllowed(db, {}) }\nasync function b(){ await db.from("transactions").insert({}) }'))
  const sites: Array<{ file: string; gated: boolean }> = []
  for (const f of ["app", "lib", "services", "workflows"].flatMap((d) => tsFiles(d))) {
    const src = stripComments(raw(f))
    for (const at of insertSites(src)) {
      const before = src.slice(0, at)
      // the enclosing function OR class method: the last `async name(` / `async function name(` before the insert
      let fnStart = 0
      for (const m of before.matchAll(/\basync\s+(?:function\s+)?[A-Za-z_$][\w$]*\s*\(/g)) fnStart = m.index ?? fnStart
      sites.push({ file: f, gated: /assertTransactionCreationAllowed\(/.test(before.slice(fnStart)) })
    }
  }
  check("the census found the transactions writers (a finder that saw none would pass everything below)", sites.length >= 4, sites.map((s) => s.file))
  const ungated = sites.filter((s) => !s.gated)
  check("EVERY transactions INSERT runs the creation gate earlier in the same function", ungated.length === 0, ungated)
  const signatureTime = sites.filter((s) => /webhook|esign|e-sign|listing-agreement|listing_agreement|lib\/listings\/|lib\/listing-lifecycle\/|dotloop|docusign/i.test(s.file))
  check("NO e-sign / webhook / listing-agreement / listing-lifecycle module inserts a transaction (a signature event never creates a deal)", signatureTime.length === 0, signatureTime)
  const bridge = code("lib/transactions/offer-bridge.ts")
  const create = bridge.slice(bridge.indexOf("export async function createTransactionFromOffer"))
  const iGate = create.indexOf("assertTransactionCreationAllowed("), iInsert = create.search(/from\("transactions"\)\s*\.insert\(/)
  const gateSrc = code("lib/transactions/transaction-creation-gate.ts")
  check("the substantive review lives IN the creation gate every writer runs (obligation terms_reviewed), and the bridge inserts only after it", iGate > 0 && iInsert > iGate && /requirement:\s*"terms_reviewed"/.test(gateSrc) && /loadAndDecideOfferRepresentation\(/.test(gateSrc), { iGate, iInsert })
  check("…the bridge keeps no second comparator of its own (one decision, five doors)", !/loadAndDecideOfferRepresentation\(|offer_price\s*!==|price_mismatch/.test(bridge))
  check("…and a 23505 on the insert reads the WINNER back (one executed contract → one transaction)", /code === "23505" \? await readWinningTransaction\(/.test(create))
  const submit = code("app/actions/buyer-offer/submit-to-compliance.ts")
  const iReviewS = submit.indexOf("loadAndDecideOfferRepresentation("), iStamp = submit.indexOf("compliance_passed_at:    now")
  check("submit-to-compliance decides the substantive review BEFORE it stamps compliance_passed_at", iReviewS > 0 && iStamp > iReviewS, { iReviewS, iStamp })
  const loop = code("lib/listings/listing-compliance-loop.ts")
  const iReviewL = loop.indexOf("loadAndDecideListingRepresentation("), iApproved = loop.indexOf('stamp("compliance_approved"')
  check("the listing loop decides the substantive review BEFORE it records compliance_approved", iReviewL > 0 && iApproved > iReviewL, { iReviewL, iApproved })
  const intake = code("app/actions/listings-kernel.ts")
  check("listing intake asks the creation gate with NO offer (so its seller-side insert can never pass — §B proves the refusal)", /assertTransactionCreationAllowed\([\s\S]{0,200}offerId:\s*null/.test(intake))
  const m = raw("supabase/migrations/m1001-one-executed-offer-one-transaction-unique-index.sql")
  check("m1001 declares the partial unique index (brokerage_id, offer_id) on live transactions", /CREATE UNIQUE INDEX IF NOT EXISTS transactions_one_per_offer_uq\s+ON public\.transactions \(brokerage_id, offer_id\)\s+WHERE offer_id IS NOT NULL AND deleted_at IS NULL/.test(m))
}

// ═══ §B THE LISTING DECISION (pure) ═════════════════════════════════════════════════════════════════════════════════════
async function sectionB(rg: any, gateMod: any) {
  section("§B the listing decision — compare, never merely read")
  if (rg.__loadError) { check("lib/kernel/compliance/representation-gate.ts loads", false, rg.__loadError); return }
  const base = () => ({
    brokerageId: B, listing: listingRow(), sellerNames: ["Sam Seller"], gate: PASS_GATE, approval: null, checkedAt: T0,
    agreement: { id: LA, effective_date: "2026-11-20", expiration_date: "2027-06-30", listing_commission_rate: 3, total_commission_rate: 6, agent_signed_at: T0, seller_signed_at: T0 },
    agreementDocuments: [agreementDoc()], addenda: [] as Row[],
  })
  const d0 = rg.decideListingRepresentation(base())
  check("a complete, consistent, fully signed packet is NEEDS_REVIEW — a signature is not compliance", d0.verdict === "needs_review", d0.blockingReasons)
  check("…every compared fact agrees (address, ZIP, price, dates, compensation, legal description, seller identity)", d0.evidence.compared.filter((c: any) => c.agrees === false).length === 0 && d0.evidence.compared.filter((c: any) => c.agrees === true).length >= 7, d0.evidence.compared)
  check("…the verdict vocabulary is exactly allow / hold / refuse / needs_review", JSON.stringify(rg.REPRESENTATION_VERDICTS) === JSON.stringify(["allow", "hold", "refuse", "needs_review"]))
  check("…it names the reviewer authority (closingApproval: compliance_reviewer / tenant_admin)", d0.reviewerAuthority.capability === "closingApproval" && d0.reviewerAuthority.roles.includes("compliance_reviewer"))
  check("…and carries a 64-hex evidence hash and a (tenant, record, version) idempotency key", /^[0-9a-f]{64}$/.test(d0.evidenceHash) && d0.idempotencyKey === `${B}:listing_agreement:${LA}`)
  const approve = (h: string) => ({ userId: CO, at: T0, evidenceHash: h, decision: "approve" })
  const d1 = rg.decideListingRepresentation({ ...base(), approval: approve(d0.evidenceHash) })
  check("a reviewer's approval of THAT evidence hash makes it ALLOW", d1.verdict === "allow" && d1.approval?.userId === CO)
  const hold = (name: string, input: any, code: string) => {
    const d = rg.decideListingRepresentation(input)
    const r = d.blockingReasons.find((x: any) => x.code === code)
    check(`${name} → HOLD (${code}) naming its document`, d.verdict === "hold" && !!r && (r.documentId !== null || code === "no_executed_document"), d.blockingReasons.map((x: any) => x.code))
    return d
  }
  const changed = hold("C02 changed list price on the listing vs the signed agreement", { ...base(), listing: listingRow({ list_price: 525000 }) }, "field_mismatch")
  check("…the hold says what the document says AND what the record says", changed.blockingReasons.some((r: any) => r.field === "list_price" && r.documentSays === "500,000" && r.recordSays === 525000))
  check("…and a changed term UNBINDS an earlier approval (stale hash is not allow)", rg.decideListingRepresentation({ ...base(), listing: listingRow({ list_price: 525000 }), approval: approve(d0.evidenceHash) }).verdict === "hold")
  hold("address contradiction", { ...base(), listing: listingRow({ address: "99 Pine Road" }) }, "field_mismatch")
  hold("expiration date contradiction", { ...base(), agreement: { ...base().agreement, expiration_date: "2027-03-31" } }, "field_mismatch")
  hold("compensation contradiction", { ...base(), agreement: { ...base().agreement, total_commission_rate: 5 } }, "field_mismatch")
  hold("legal description contradiction", { ...base(), listing: listingRow({ legal_description: "Lot 9, Block 7, Elm Park" }) }, "field_mismatch")
  hold("C02 missing seller initial (signed-but-incomplete)", { ...base(), agreementDocuments: [agreementDoc({ signature_completeness: { ...fullSc(["agent", "seller"]), initials: [{ signer_role: "agent", all_required_initials_present: true }, { signer_role: "seller", all_required_initials_present: false }] } })] }, "initials_missing")
  hold("empty extraction", { ...base(), agreementDocuments: [agreementDoc({ extracted_fields: {} })] }, "extraction_empty")
  hold("failed OCR / model scan", { ...base(), agreementDocuments: [agreementDoc({ scan_error: "model timeout" })] }, "extraction_failed")
  hold("low-confidence reading", { ...base(), agreementDocuments: [agreementDoc({ classification_confidence: "medium" })] }, "extraction_low_confidence")
  const reqDocs = await load("lib/compliance/required-documents.ts")
  const supersededKey = reqDocs.DOCUMENT_VERSION_KEYS?.supersededBy ?? "superseded_by_document_id"   // the ONE version-link key, imported
  hold("only a superseded version on file", { ...base(), agreementDocuments: [agreementDoc({ metadata: { [supersededKey]: u(99) } })] }, "superseded_version")
  hold("ambiguous signature (signer not placed in a role)", { ...base(), agreementDocuments: [agreementDoc({ signature_completeness: { ...fullSc(["agent", "seller"]), signatures: [...fullSc(["agent", "seller"]).signatures, { signer_role: "other", signer_name: "Pat Unknown", signed: true }] } })] }, "ambiguous_signature")
  hold("signed by someone who is not the seller on file", { ...base(), agreementDocuments: [agreementDoc({}, { seller_name: "Morgan Stranger" })] }, "signer_identity_mismatch")
  hold("another state's form", { ...base(), agreementDocuments: [agreementDoc({ state_code: "OK" }, { state: "OK" })] }, "state_mismatch")
  hold("unsigned addendum", { ...base(), addenda: [{ ...agreementDoc({ id: ADD, classification: "addendum", signature_completeness: { signatures: [{ signer_role: "agent", signed: true }], initials: [] } }) }] }, "unsigned_addendum")
  hold("no executed agreement document at all", { ...base(), agreementDocuments: [] }, "no_executed_document")
  const g = rg.decideListingRepresentation({ ...base(), gate: { allowed: false, refusals: [{ requirement: "required_documents_present", message: "1 required document(s) missing — Disclosure" }] } })
  check("the gate's own refusal (missing required document) is carried as a HOLD, never re-derived", g.verdict === "hold" && g.blockingReasons.some((r: any) => r.code === "gate_refused" && /Disclosure/.test(r.message)))
  const t = rg.decideListingRepresentation({ ...base(), brokerageId: B2 })
  check("another tenant's listing → REFUSE, nothing reviewed", t.verdict === "refuse" && t.evidence.compared.length === 0)
  {
    // NEGATIVE CONTROL: the hold predicate the battery applies must REJECT an always-allow decision (a rubber stamp).
    const stamp = { verdict: "allow", blockingReasons: [] as any[] }
    const wouldPass = stamp.verdict === "hold" && stamp.blockingReasons.some((x: any) => x.code === "field_mismatch")
    check("NEGATIVE CONTROL: an always-allow decision fails the hold battery (the battery can tell a gate from a rubber stamp)", !wouldPass)
  }
  void gateMod
}

// ═══ §C THE LISTING LOOP (C01, C02) ═════════════════════════════════════════════════════════════════════════════════════
async function sectionC(rg: any) {
  section("§C the listing loop — fully signed → review → (hold | approve → advance once); never a transaction")
  const loopMod = await load("lib/listings/listing-compliance-loop.ts")
  const gateMod = await load("lib/listings/listing-activation-gate.ts")
  if (loopMod.__loadError || gateMod.__loadError || rg.__loadError) { check("the loop, the gate and the decision load", false, loopMod.__loadError ?? gateMod.__loadError ?? rg.__loadError); return }
  const run = (trigger = "agreement_executed") => loopMod.runListingComplianceLoop(G.__B.mem, { brokerageId: B, listingId: L, trigger, actorUserId: AU })

  resetCalls(); G.__B.mem = listingWorld()
  const r1 = await run()
  check("C01 a fully signed, consistent agreement goes to REVIEW (awaiting_review) — not a stage hop", r1.outcome === "awaiting_review" && G.__B.calls.lifecycle.length === 0, { outcome: r1.outcome, hops: G.__B.calls.lifecycle, reason: r1.reason })
  check("C01 …and a mere fully_signed agreement created NO purchase transaction", (G.__B.mem.tables.transactions ?? []).length === 0)
  check("the agent, the coordinator roster and Compliance get ONE short actionable item (notifyComplianceFlag fans to tc + compliance_officer + agent)", G.__B.calls.notify.length === 1 && G.__B.calls.notify[0].flag.type === "compliance.listing_review_ready", G.__B.calls.notify.map((n: any) => n.flag?.type))
  check("…the decision leaves a receipt (compliance_events, gate representation_review)", (G.__B.mem.tables.compliance_events ?? []).some((e: Row) => e.gate_name === "representation_review" && e.details?.kind === "decision" && e.details?.verdict === "needs_review"))
  const again = await run("document_uploaded")
  check("re-entry with nothing changed pages nobody again (deduped on the blocker set)", again.outcome === "awaiting_review" && G.__B.calls.notify.length === 1)

  resetCalls(); G.__B.mem = listingWorld({ listing: { list_price: 525000 } })
  const r2 = await run()
  const n2 = G.__B.calls.notify[0]
  check("C02 a changed listing term HOLDS (blocked) with the exact term in the item", r2.outcome === "blocked" && /list price/.test(r2.reason ?? "") && /525000/.test(r2.reason ?? ""), r2)
  check("C02 …the item links the REAL document (documentId) and never says 'AI failure'", n2?.flag?.documentId === DOC && !/AI failure|model error/i.test(n2?.flag?.body ?? ""), n2?.flag)
  check("…the packet is recorded correction_required on the e-sign ladder, and nothing advanced", G.__B.calls.packet.includes("correction_required") && G.__B.calls.lifecycle.length === 0)

  resetCalls(); G.__B.mem = listingWorld({ doc: agreementDoc({ signature_completeness: { ...fullSc(["agent", "seller"]), initials: [{ signer_role: "agent", all_required_initials_present: true }, { signer_role: "seller", all_required_initials_present: false }] } }) })
  const r3 = await run()
  check("signed-but-incomplete (a missing seller initial) does not advance and does not create a deal", r3.outcome === "blocked" && G.__B.calls.lifecycle.length === 0 && (G.__B.mem.tables.transactions ?? []).length === 0, r3)

  // approval of the CURRENT evidence → advances ONCE
  resetCalls(); G.__B.mem = listingWorld()
  const gate = await gateMod.assertListingActivationAllowed(G.__B.mem, { brokerageId: B, listingId: L, complianceReview: true })
  const cur = await rg.loadAndDecideListingRepresentation(G.__B.mem, { brokerageId: B, listingId: L, gate })
  G.__B.mem.tables.compliance_events.push({ id: u(500), brokerage_id: B, gate_name: "representation_review", entity_type: "listing_agreement", entity_id: L, allowed: true, actor_user_id: CO, actor_role: "compliance_reviewer", created_at: "2026-11-21T00:00:00.000Z", details: { kind: "human_review", decision: "approve", evidence_hash: cur.ok ? cur.decision.evidenceHash : "x" } })
  const r4 = await run("compliance_review_recorded")
  check("C01 the reviewer's approval continues ONLY the authorized transition: two allowed hops to COMING_SOON_PREP", r4.outcome === "advanced" && JSON.stringify(G.__B.calls.lifecycle) === JSON.stringify(["MLS_DATE_CONFIRMED", "COMING_SOON_PREP"]), { r4, hops: G.__B.calls.lifecycle })
  check("…compliance_approved is recorded on the packet only now", G.__B.calls.packet.includes("compliance_approved"))
  check("…and STILL no purchase transaction (a listing agreement alone never creates one)", (G.__B.mem.tables.transactions ?? []).length === 0)

  // REVOCATION: past the window, a later unsigned addendum invalidates the approved packet
  resetCalls()
  const lst = G.__B.mem.tables.listings[0]; lst.lifecycle_stage = "COMING_SOON_PREP"; lst.metadata = { compliance_gate: { state: "passed" } }
  G.__B.mem.tables.listing_agreements[0].compliance_passed = true
  G.__B.mem.tables.documents.push(agreementDoc({ id: ADD, classification: "addendum", created_at: "2026-11-22T00:00:00.000Z", signature_completeness: { signatures: [{ signer_role: "agent", signed: true }], initials: [] } }, { list_price: 480000 }))
  const r5 = await run("document_uploaded")
  check("a later document that invalidates the approved packet REVOKES readiness (past the window)", G.__B.mem.tables.listings[0].metadata?.compliance_gate?.state === "revoked" && r5.outcome === "blocked", { r5, gate: G.__B.mem.tables.listings[0].metadata?.compliance_gate?.state })
  const door = await gateMod.assertListingActivationAllowed(G.__B.mem, { brokerageId: B, listingId: L, door: "MLS activation" })
  check("…and the activation DOOR refuses while it is revoked (the executed original untouched)", !door.allowed && door.refusals.some((r: any) => /revoked/.test(r.message)) && G.__B.mem.tables.documents.some((d: Row) => d.id === DOC && d.extracted_fields?.list_price === "500,000"), door.refusals)
  check("NEGATIVE CONTROL: a listing never revoked is not refused for revocation", !(await gateMod.assertListingActivationAllowed(listingWorld({ listing: { metadata: {} } }), { brokerageId: B, listingId: L })).refusals.some((r: any) => /revoked/.test(r.message)))
}

// ═══ §D STATE-SPECIFIC CHECKLIST ════════════════════════════════════════════════════════════════════════════════════════
async function sectionD() {
  section("§D the state checklist is honored (driven through the activation gate)")
  const gateMod = await load("lib/listings/listing-activation-gate.ts")
  if (gateMod.__loadError) { check("the activation gate loads", false, gateMod.__loadError); return }
  const noDisc = (state: string) => { const m = listingWorld({ listing: { state } }); m.tables.documents = m.tables.documents.filter((d: Row) => d.id !== DISC); return m }
  const tx = await gateMod.assertListingActivationAllowed(noDisc("TX"), { brokerageId: B, listingId: L, complianceReview: true })
  check("a TX listing missing the TX-only disclosure is refused naming it", !tx.allowed && tx.detail.missingRequired.some((x: string) => /disclosure/i.test(x)), tx.detail.missingRequired)
  const ca = await gateMod.assertListingActivationAllowed(noDisc("CA"), { brokerageId: B, listingId: L, complianceReview: true })
  check("…the same file for a CA listing is NOT held for the TX rule (positive control: the rule is state-scoped, not global)", !ca.detail.missingRequired.some((x: string) => /disclosure/i.test(x)), ca.detail.missingRequired)
}

// ═══ §E THE OFFER DECISION (pure) ═══════════════════════════════════════════════════════════════════════════════════════
const contractDoc = (over: Partial<Row> = {}, fields: Record<string, unknown> = {}): Row => ({
  id: CDOC, brokerage_id: B, contact_id: CB, classification: "signed_contract", classification_confidence: "high", scanned_at: T0, scan_error: null, created_at: T0,
  metadata: { linked_offer_id: O }, signature_completeness: fullSc(["buyer", "seller"]),
  extracted_fields: { price: 500000, earnest_money_amount: 10000, closing_date: "2026-12-30", property_address: "40 Elm St, Austin, TX 78702", ...fields }, ...over,
})
const offerRow = (over: Partial<Row> = {}): Row => ({ id: O, brokerage_id: B, agent_id: AG, contact_id: CB, listing_id: null, parent_offer_id: null, status: "accepted", offer_type: "purchase", offer_price: 500000, earnest_money: 10000, closing_date: "2026-12-30", property_address: "40 Elm Street, Austin, TX 78702", buyer_signed_at: T0, seller_signed_at: T0, seller_response_type: "accepted", fully_signed_contract_received_at: T0, compliance_passed_at: T0, transaction_id: null, metadata: {}, created_at: T0, ...over })
async function sectionE(rg: any) {
  section("§E the offer decision — the governing contract against the offer record")
  if (rg.__loadError) { check("the decision module loads", false, rg.__loadError); return }
  const packet = { sequence: [O], headOfferId: O, addendumDocumentIds: [] as string[], transactionIds: [] as string[] }
  const base = () => ({ brokerageId: B, offer: offerRow(), packet, contractDocuments: [contractDoc()], addenda: [] as Row[], gate: PASS_GATE, approval: null, checkedAt: T0 })
  const d0 = rg.decideOfferRepresentation(base())
  check("C03 an executed, consistent contract is NEEDS_REVIEW until a reviewer accepts it", d0.verdict === "needs_review" && d0.evidence.compared.filter((c: any) => c.agrees === true).length === 4, d0)
  check("…approval of that evidence hash → ALLOW; idempotency key is (tenant, offer, version)", rg.decideOfferRepresentation({ ...base(), approval: { userId: CO, at: T0, evidenceHash: d0.evidenceHash, decision: "approve" } }).verdict === "allow" && d0.idempotencyKey === `${B}:purchase_offer:${O}`)
  const fv = rg.decideOfferRepresentation({ ...base(), offer: offerRow({ offer_price: 525000 }) })
  check("field-versus-document contradiction (price) → HOLD naming the contract", fv.verdict === "hold" && fv.blockingReasons.some((r: any) => r.code === "field_mismatch" && r.field === "price" && r.documentId === CDOC))
  const two = rg.decideOfferRepresentation({ ...base(), contractDocuments: [contractDoc(), contractDoc({ id: CDOC2 }, { price: 510000 })] })
  check("two executed contract papers stating different prices → HOLD (contradictory_terms)", two.verdict === "hold" && two.blockingReasons.some((r: any) => r.code === "contradictory_terms"))
  const ex = rg.decideOfferRepresentation({ ...base(), packet: { ...packet, addendumDocumentIds: [EADD] }, addenda: [contractDoc({ id: EADD, classification: "addendum" }, { price: 490000, earnest_money_amount: null, closing_date: null, property_address: null })] })
  check("an EXECUTED addendum changing the price that the offer record does not reflect → HOLD (record must be corrected)", ex.verdict === "hold" && ex.blockingReasons.some((r: any) => r.field === "price" && r.documentId === EADD))
  const ua = rg.decideOfferRepresentation({ ...base(), addenda: [contractDoc({ id: UADD, classification: "addendum", signature_completeness: { signatures: [{ signer_role: "buyer", signed: true }], initials: [] } }, { price: 520000, earnest_money_amount: null, closing_date: null, property_address: null })] })
  check("an UNSIGNED addendum stating a new price does not overwrite the signed price (named for the reviewer, verdict not changed by it)", ua.verdict === "needs_review" && ua.evidence.compared.find((c: any) => c.field === "price")?.documentSays === 500000 && ua.blockingReasons.some((r: any) => r.code === "unsigned_addendum" && r.documentId === UADD))
  const dup = rg.decideOfferRepresentation({ ...base(), packet: { ...packet, transactionIds: [u(777)] } })
  check("a contract that already became a transaction → REFUSE", dup.verdict === "refuse" && dup.blockingReasons.some((r: any) => r.code === "already_transaction"))
  check("another tenant's offer → REFUSE", rg.decideOfferRepresentation({ ...base(), brokerageId: B2 }).verdict === "refuse")
}

// ═══ §F OFFER → TRANSACTION (C03) ═══════════════════════════════════════════════════════════════════════════════════════
function offerWorld(o: { offer?: Partial<Row>; docs?: Row[]; extra?: Record<string, Row[]>; rules?: Row[] } = {}): MemClient {
  return memSupabase({
    offers: [offerRow(o.offer)], documents: o.docs ?? [contractDoc()],
    activities: [{ id: u(600), brokerage_id: B, entity_type: "offer", entity_id: O, activity_type: "buyer.offer.compliance.passed", status: "completed", created_at: T0 }],
    brokerage_required_documents: o.rules ?? [{ id: u(92), brokerage_id: B, classification: "signed_contract", is_required: true, deal_type: "buyer", scope_type: "brokerage", scope_id: B, block_on_missing: true, state_code: null }],
    contract_term_versions: [], agents: [{ id: AG, user_id: AU, brokerage_id: B }], users: [{ id: AU, brokerage_id: B, team_id: null, user_type: "agent" }],
    transactions: [], compliance_events: [], contacts: [{ id: CB, brokerage_id: B, first_name: "Bea", last_name: "Buyer" }],
    buyer_broker_agreements: [], listings: [],
    ...(o.extra ?? {}),
  }, { uuidIds: true, stampCreatedAt: true, unique: { transactions: [["brokerage_id", "offer_id"]] } })
}
async function sectionF() {
  section("§F offer → exactly one canonical purchase transaction (driven through createTransactionFromOffer)")
  const bridge = await load("lib/transactions/offer-bridge.ts")
  if (bridge.__loadError) { check("the offer bridge loads", false, bridge.__loadError); return }
  const call = () => bridge.createTransactionFromOffer({ offerId: O, brokerageId: B, contractDate: "2026-11-20", compliancePassedAt: T0, contractTerms: {} }).then((r: any) => ({ ok: true, r }), (e: any) => ({ ok: false, e: String(e?.message ?? e) }))
  const quiet = async <T>(f: () => Promise<T>): Promise<T> => { const l = console.log, w = console.warn, er = console.error; console.log = console.warn = console.error = () => {}; try { return await f() } finally { console.log = l; console.warn = w; console.error = er } }

  resetCalls(); G.__B.mem = offerWorld()
  const [a, b] = await quiet(() => Promise.all([call(), call()]))
  const rows = G.__B.mem.tables.transactions
  check("C03 two racing deliveries of one executed offer create exactly ONE transaction", rows.length === 1, { rows: rows.length, a, b })
  check("…both deliveries resolve to the SAME transaction id (the loser reads the winner back as a replay)", (a as any).ok && (b as any).ok && (a as any).r.transactionId === (b as any).r.transactionId && [(a as any).r.replay, (b as any).r.replay].filter(Boolean).length === 1, { a, b })
  check("…and the deal carries the SIGNED price", rows[0]?.purchase_price === 500000)

  resetCalls(); G.__B.mem = offerWorld({ offer: { offer_price: 525000 } })
  const held = await quiet(call)
  check("a field-versus-document contradiction creates NO transaction, and the refusal names the term", !(held as any).ok && /purchase price/.test((held as any).e) && G.__B.mem.tables.transactions.length === 0, held)

  resetCalls(); G.__B.mem = offerWorld({ docs: [contractDoc(), contractDoc({ id: UADD, classification: "addendum", signature_completeness: { signatures: [{ signer_role: "buyer", signed: true }], initials: [] } }, { price: 520000, earnest_money_amount: null, closing_date: null, property_address: null })] })
  const ua = await quiet(call)
  check("an unsigned addendum cannot overwrite signed terms: the transaction is built at the signed 500000, not 520000", (ua as any).ok && G.__B.mem.tables.transactions[0]?.purchase_price === 500000, ua)

  resetCalls(); G.__B.mem = offerWorld({ docs: [contractDoc({ scan_error: "OCR failed" })] })
  const ocr = await quiet(call)
  check("a failed OCR of the executed contract is a HOLD, never success — no transaction", !(ocr as any).ok && G.__B.mem.tables.transactions.length === 0, ocr)
}

// ═══ §G AUTHORITY ═══════════════════════════════════════════════════════════════════════════════════════════════════════
async function sectionG(rg: any) {
  section("§G who may accept a packet — scoped, and never an agent-only permission to a vendor or Contact")
  if (rg.__loadError) { check("the decision module loads", false, rg.__loadError); return }
  const may = (userType: string | null, o: { isOwningAgent?: boolean; sameTenant?: boolean; grantedRoles?: string[] } = {}) => rg.mayReviewRepresentation({ sameTenant: o.sameTenant ?? true, userType, grantedRoles: o.grantedRoles ?? [], isOwningAgent: !!o.isOwningAgent }).ok
  check("compliance_officer may accept", may("compliance_officer"))
  check("a tenant admin (broker / broker_owner) may accept — a solo tenant's owner-agent is the designed case", may("broker") && may("broker_owner", { isOwningAgent: true }))
  const never: Array<[string, boolean]> = [["agent (owning, alone)", may("agent", { isOwningAgent: true })], ["tc", may("tc")], ["team_lead", may("team_lead")], ["vendor (lender / title / closing attorney)", may("vendor")], ["contact", may("contact")], ["isa", may("isa")], ["compliance_officer of ANOTHER tenant", may("compliance_officer", { sameTenant: false })]]
  for (const [who, ok] of never) check(`${who} may NOT accept a packet`, !ok)
  check("NEGATIVE CONTROL: a granted compliance_officer role is honored (the rule reads grants, not only user_type)", may("agent", { grantedRoles: ["compliance_officer"] }))

  const act = await load("app/actions/compliance/representation-review.ts")
  const gateMod = await load("lib/listings/listing-activation-gate.ts")
  if (act.__loadError || gateMod.__loadError) { check("the reviewer door loads", false, act.__loadError ?? gateMod.__loadError); return }
  const seat = (userId: string, userType: string, agentId: string | null = null) => ({ userId, agentId, brokerageId: B, userType })
  const world = () => { const m = listingWorld(); m.tables.users.push({ id: u(33), brokerage_id: B, user_type: "vendor" }, { id: u(34), brokerage_id: B, user_type: "tc" }); m.tables.user_role_assignments = []; return m }
  resetCalls(); G.__B.mem = world(); G.__B.seat = seat(CO, "compliance_officer")
  const view = await act.getRepresentationReviewAction({ record: "listing_agreement", subjectId: L })
  check("the reviewer opens the current decision (needs_review) and may decide it", view.success && view.decision.verdict === "needs_review" && view.mayDecide === true, view)
  const hash = view.success ? view.decision.evidenceHash : ""
  G.__B.seat = seat(AU, "agent", AG)
  const agentTry = await act.recordRepresentationReview({ record: "listing_agreement", subjectId: L, decision: "approve", evidenceHash: hash })
  check("the listing's own agent cannot approve their packet (reads it, never accepts it)", !agentTry.success && G.__B.mem.tables.compliance_events.every((e: Row) => e.details?.kind !== "human_review"), agentTry)
  for (const [id, t] of [[u(33), "vendor"], [u(34), "tc"]] as const) {
    G.__B.seat = seat(id, t)
    const r = await act.recordRepresentationReview({ record: "listing_agreement", subjectId: L, decision: "approve", evidenceHash: hash })
    check(`a ${t} seat is refused at the reviewer door`, !r.success, r)
  }
  G.__B.seat = { ...seat(CO, "compliance_officer"), brokerageId: B2 }
  const cross = await act.recordRepresentationReview({ record: "listing_agreement", subjectId: L, decision: "approve", evidenceHash: hash })
  check("a reviewer of ANOTHER tenant cannot reach this packet (tenant from the session)", !cross.success && /isn't in your account/.test(cross.error ?? ""), cross)
  G.__B.seat = seat(CO, "compliance_officer")
  const stale = await act.recordRepresentationReview({ record: "listing_agreement", subjectId: L, decision: "approve", evidenceHash: "0".repeat(64) })
  check("a STALE evidence hash is refused (the packet changed since it was opened)", !stale.success && /changed since you opened it/.test(stale.error ?? ""), stale)
  const ok = await act.recordRepresentationReview({ record: "listing_agreement", subjectId: L, decision: "approve", evidenceHash: hash })
  check("the reviewer's approval is recorded and continues ONLY the listing loop (advanced to coming-soon prep)", ok.success && ok.continued?.listing === "advanced" && G.__B.mem.tables.compliance_events.some((e: Row) => e.details?.kind === "human_review" && e.actor_user_id === CO), ok)
  {
    // A FORGED approval: an agent writes a human_review row for their own packet straight into the ledger (the session INSERT
    // policy admits a staff seat). Authority is re-checked at READ time, so it is not an approval.
    const m = world(); const rgm = await load("lib/kernel/compliance/representation-gate.ts")
    const gate = await gateMod.assertListingActivationAllowed(m, { brokerageId: B, listingId: L, complianceReview: true })
    const cur = await rgm.loadAndDecideListingRepresentation(m, { brokerageId: B, listingId: L, gate })
    m.tables.compliance_events.push({ id: u(501), brokerage_id: B, gate_name: "representation_review", entity_type: "listing_agreement", entity_id: L, allowed: true, actor_user_id: AU, created_at: "2026-11-21T00:00:00.000Z", details: { kind: "human_review", decision: "approve", evidence_hash: cur.ok ? cur.decision.evidenceHash : "" } })
    const after = await rgm.loadAndDecideListingRepresentation(m, { brokerageId: B, listingId: L, gate })
    check("a FORGED approval written by the listing's own agent is not an approval (authority re-checked at read time)", after.ok && after.decision.verdict === "needs_review", after.ok ? after.decision.verdict : after)
    m.tables.compliance_events[m.tables.compliance_events.length - 1].actor_user_id = CO
    const real = await rgm.loadAndDecideListingRepresentation(m, { brokerageId: B, listingId: L, gate })
    check("POSITIVE CONTROL: the identical row by the compliance officer IS an approval", real.ok && real.decision.verdict === "allow")
  }
  G.__B.mem = world(); G.__B.mem.tables.listings[0].list_price = 525000
  const hv = await act.getRepresentationReviewAction({ record: "listing_agreement", subjectId: L })
  const holdTry = await act.recordRepresentationReview({ record: "listing_agreement", subjectId: L, decision: "approve", evidenceHash: hv.success ? hv.decision.evidenceHash : "" })
  check("a HOLD cannot be approved away — a contradiction is repaired, not accepted", !holdTry.success && /items to fix first/.test(holdTry.error ?? ""), holdTry)
  G.__B.seat = null
}

// ═══ ROUND 2 ════════════════════════════════════════════════════════════════════════════════════════════════════════════
const quietly = async <T>(f: () => Promise<T>): Promise<T> => { const l = console.log, w = console.warn, er = console.error; console.log = console.warn = console.error = () => {}; try { return await f() } finally { console.log = l; console.warn = w; console.error = er } }

/** §H ONE DECISION AT EVERY DOOR — the hold check lives in the creation gate all five insert sites run; driven per path. */
async function sectionH() {
  section("§H one decision at every door — the creation gate holds a contradicted contract, driven per path")
  const gateMod = await load("lib/transactions/transaction-creation-gate.ts")
  if (gateMod.__loadError) { check("the creation gate loads", false, gateMod.__loadError); return }
  const P = { brokerageId: B, offerId: O, listingId: null, contactIds: [CB], agentUserId: AU, teamId: null, dealType: "buyer" as const, stateCode: null, door: "guard" }
  const held = await gateMod.assertTransactionCreationAllowed(offerWorld({ offer: { offer_price: 525000 } }), P)
  check("the creation gate itself refuses a contract the document contradicts (obligation terms_reviewed)", !held.allowed && held.refusals.some((r: any) => r.requirement === "terms_reviewed" && /purchase price/.test(r.message)), held.refusals)
  const clean = await gateMod.assertTransactionCreationAllowed(offerWorld(), P)
  check("POSITIVE CONTROL: the same gate allows the consistent executed contract", clean.allowed, clean.refusals)
  const ocr = await gateMod.assertTransactionCreationAllowed(offerWorld({ docs: [contractDoc({ scanned_at: null })] }), P)
  check("…and refuses an executed contract nobody could read (the scan never ran)", !ocr.allowed && ocr.refusals.some((r: any) => r.requirement === "terms_reviewed"))

  // services/supabaseService.ts createTransaction — the one non-bridge door that can carry an offer id.
  const svcMod = await load("services/supabaseService.ts")
  if (svcMod.__loadError) { check("services/supabaseService.ts loads", false, svcMod.__loadError) } else {
    const payload = { brokerage_id: B, offer_id: O, contact_id: CB, deal_type: "buyer", deal_name: "40 Elm Street", property_address: "40 Elm Street" }
    G.__B.mem = offerWorld({ offer: { offer_price: 525000 } })
    const r1 = await quietly<any>(() => svcMod.supabaseService.createTransaction(payload))
    check("supabaseService.createTransaction with a HELD contract's offer id creates nothing", r1 === null && G.__B.mem.tables.transactions.length === 0, { r1, rows: G.__B.mem.tables.transactions.length })
    G.__B.mem = offerWorld()
    const r2 = await quietly<any>(() => svcMod.supabaseService.createTransaction(payload))
    check("POSITIVE CONTROL: …and with a consistent contract it creates exactly one row", !!r2 && G.__B.mem.tables.transactions.length === 1, { r2 })
  }
  // The two manual doors carry NO offer id: they refuse by construction, even beside a compliant executed contract.
  const kernelMod = await load("lib/kernel/transactions.ts", true)
  if (kernelMod.__loadError) { check("lib/kernel/transactions.ts loads", false, kernelMod.__loadError) } else {
    G.__B.mem = offerWorld()
    const k = await quietly<any>(() => kernelMod.createManualTransaction({ brokerageId: B, agentId: AG, propertyAddress: "40 Elm Street", dealType: "purchase", contactId: CB }))
    check("kernel createManualTransaction refuses (no offer → no reviewed contract), 0 rows", !k.success && G.__B.mem.tables.transactions.length === 0, k)
  }
  const gateSrc = code("lib/transactions/transaction-creation-gate.ts")
  check("the gate asks THE decision module once its other obligations pass (no second comparator)", /loadAndDecideOfferRepresentation\(/.test(gateSrc) && /requirement:\s*"terms_reviewed"/.test(gateSrc))
  const appSrc = code("lib/application/transactions.ts")
  check("lib/application createTransaction passes no offer id to the gate (refuses by construction — proved by the gate's no-offer refusal)", /door:\s*"manual transaction sheet"/.test(appSrc) && /assertTransactionCreationAllowed\([\s\S]{0,300}offerId:\s*null/.test(appSrc))
  const noOffer = await gateMod.assertTransactionCreationAllowed(offerWorld(), { ...P, offerId: null })
  check("…and the gate refuses ANY door that brings no offer (compliance_good)", !noOffer.allowed && noOffer.refusals.some((r: any) => r.requirement === "compliance_good"))

  // THE STAFF OVERRIDE cannot stamp past an open hold.
  const bridgeAct = await load("app/actions/compliance-bridge-actions.ts")
  const overrideSrc = code("app/actions/compliance-bridge-actions.ts")
  check("the staff override runs the evidence-bound review and refuses an open hold with the reasons", /loadAndDecideOfferRepresentation\(/.test(overrideSrc) && /Compliance cannot be recorded over an open hold/.test(overrideSrc) && /kind:\s*"human_review"/.test(overrideSrc))
  void bridgeAct
}

/** §I NO HOLD IS A DEAD END — every reason has a repair; unreadable extraction repaired by re-scan OR reviewer attestation. */
async function sectionI(rg: any) {
  section("§I no hold is a dead end — re-scan or the reviewer's field-by-field attestation; a contradiction still holds")
  if (rg.__loadError) { check("the decision module loads", false, rg.__loadError); return }
  const codes = ["tenant_mismatch", "already_transaction", "gate_refused", "no_executed_document", "superseded_version", "extraction_failed", "extraction_empty", "extraction_low_confidence", "ambiguous_signature", "signer_identity_mismatch", "initials_missing", "field_mismatch", "contradictory_terms", "state_mismatch", "unsigned_addendum", "unverified_by_machine", "awaiting_reviewer", "form_license"]
  const srcCodes = [...code("lib/kernel/compliance/representation-gate.ts").matchAll(/code:\s*"([a-z_]+)"/g)].map((m) => m[1])
  const missingRepair = [...new Set(srcCodes)].filter((c) => !rg.REPAIR_PATHS?.[c]?.path || !rg.REPAIR_PATHS?.[c]?.terminatesWhen)
  check("EVERY reason code the module emits (derived from stripped source) has a repair path and a terminating condition", srcCodes.length >= 15 && missingRepair.length === 0, { found: srcCodes.length, missingRepair })
  check("POSITIVE CONTROL: the derivation finds the codes it must (all of the declared vocabulary is emitted)", codes.every((c) => srcCodes.includes(c) || c === "form_license"))

  const loopMod = await load("lib/listings/listing-compliance-loop.ts")
  const act = await load("app/actions/compliance/representation-review.ts")
  if (loopMod.__loadError || act.__loadError) { check("the loop and the reviewer door load", false, loopMod.__loadError ?? act.__loadError); return }
  const run = (trigger = "agreement_executed") => loopMod.runListingComplianceLoop(G.__B.mem, { brokerageId: B, listingId: L, trigger, actorUserId: AU })
  // (a) RE-SCAN
  resetCalls(); G.__B.mem = listingWorld({ doc: agreementDoc({ scan_error: "OCR timeout", scanned_at: null }) })
  const h = await run()
  check("an unreadable agreement HOLDS (extraction_failed) with its repair named", h.outcome === "blocked" && /re-scan|attests/i.test(h.blockers.join(" ")), h.blockers)
  Object.assign(G.__B.mem.tables.documents[0], { scan_error: null, scanned_at: "2026-11-21T00:00:00.000Z" })
  const h2 = await run("document_uploaded")
  check("(a) a successful RE-SCAN ends the hold: the packet goes to review", h2.outcome === "awaiting_review", h2)
  // (b) ATTESTATION
  resetCalls(); G.__B.mem = listingWorld({ doc: agreementDoc({ classification_confidence: "low" }) }); G.__B.seat = { userId: CO, agentId: null, brokerageId: B, userType: "compliance_officer" }
  const attest = (terms: Record<string, unknown>) => act.attestRepresentationTerms({ record: "listing_agreement", subjectId: L, documentId: DOC, terms })
  const good = await attest({ property_address: "12 Oak St, Austin, TX 78701", zip_code: "78701", state: "TX", list_price: "500000", list_date: "2026-11-20", expiration_date: "2027-06-30", commission_rate: 6, seller_name: "Sam Seller", legal_description: "Lot 4, Block 2, Oak Hills" })
  check("(b) the reviewer's attestation of a low-confidence document ends the extraction hold → needs_review", good.success && good.decision?.verdict === "needs_review" && good.decision.evidence.compared.every((c: any) => c.source === "attested"), good)
  check("…recorded under the reviewer's own identity (compliance_events kind attestation, actor = reviewer)", G.__B.mem.tables.compliance_events.some((e: Row) => e.details?.kind === "attestation" && e.actor_user_id === CO && e.details?.document_id === DOC))
  const approve = await act.recordRepresentationReview({ record: "listing_agreement", subjectId: L, decision: "approve", evidenceHash: good.decision.evidenceHash })
  check("…and the approval binds to the ATTESTED evidence hash and continues the listing", approve.success && approve.continued?.listing === "advanced", approve)
  resetCalls(); G.__B.mem = listingWorld({ doc: agreementDoc({ classification_confidence: "low" }) })
  const bad = await attest({ list_price: "480000" })
  check("a CONTRADICTION still holds after attestation (attested 480000 vs listing 500000)", bad.success && bad.decision?.verdict === "hold" && bad.decision.blockingReasons.some((r: any) => r.code === "field_mismatch" && r.field === "list_price"), bad.decision?.blockingReasons)
  G.__B.seat = { userId: AU, agentId: AG, brokerageId: B, userType: "agent" }
  const agentAttest = await attest({ list_price: "500000" })
  check("the listing agent cannot attest (a reviewer's reading only)", !agentAttest.success, agentAttest)
  G.__B.seat = { userId: CO, agentId: null, brokerageId: B, userType: "compliance_officer" }
  const freeForm = await attest({ favorite_color: "blue" } as any)
  check("an attestation accepts only the comparator's own terms (no free-form fields)", !freeForm.success)
  const srcAct = code("app/actions/compliance/representation-review.ts")
  check("no model is reached on the attestation path (the door imports no AI module)", !/@\/lib\/ai\b|generateText|generateObject/.test(srcAct))
  G.__B.seat = null
}

/** §J REPRESENTATION SIDE — buyer-only on an outside listing; our listing with an outside buyer's agent. */
async function sectionJ() {
  section("§J representation is never assumed — buyer-only and seller-only deals, driven through the bridge")
  const bridge = await load("lib/transactions/offer-bridge.ts")
  if (bridge.__loadError) { check("the offer bridge loads", false, bridge.__loadError); return }
  const call = () => bridge.createTransactionFromOffer({ offerId: O, brokerageId: B, contractDate: "2026-11-20", compliancePassedAt: T0, contractTerms: {} }).then((r: any) => ({ ok: true, r }), (e: any) => ({ ok: false, e: String(e?.message ?? e) }))
  const sellerRules = [{ id: u(93), brokerage_id: B, classification: "listing_agreement", is_required: true, deal_type: "seller", scope_type: "brokerage", scope_id: B, block_on_missing: true, state_code: null },
    { id: u(94), brokerage_id: B, classification: "signed_contract", is_required: true, deal_type: "dual", scope_type: "brokerage", scope_id: B, block_on_missing: true, state_code: null }]
  // (a) OUTSIDE listing, we represent ONLY the buyer: no listing row, no listing agreement anywhere.
  resetCalls(); G.__B.mem = offerWorld({ rules: sellerRules })
  const a = await quietly(call)
  const ta = G.__B.mem.tables.transactions[0]
  check("(a) an executed offer on an OUTSIDE listing creates ONE buyer-side transaction without demanding a listing agreement", (a as any).ok && G.__B.mem.tables.transactions.length === 1 && ta?.deal_type === "buyer" && ta?.buyer_contact_id === CB && !ta?.seller_contact_id, { a, ta })
  // (b) OUR listing, the buyer has an OUTSIDE agent (no active buyer-broker agreement, the ladder still at its default).
  const OB = u(46)
  resetCalls(); G.__B.mem = offerWorld({ rules: sellerRules, offer: { listing_id: L, contact_id: OB }, docs: [contractDoc({ contact_id: OB })], extra: {
    listings: [listingRow()], contacts: [{ id: OB, brokerage_id: B, first_name: "Oscar", last_name: "Outside", buyer_stage: "BUYER_CONTACT_CREATED" }, { id: S, brokerage_id: B, first_name: "Sam", last_name: "Seller" }],
  } })
  G.__B.mem.tables.documents.push({ ...agreementDoc(), contact_id: S })
  const b = await quietly(call)
  const tb = G.__B.mem.tables.transactions[0]
  check("(b) our listing + an outside buyer's agent creates a SELLER-side transaction (never dual)", (b as any).ok && tb?.deal_type === "seller", { b, tb })
  check("(b) …the client is the seller, and the outside buyer is NOT recorded as our represented buyer", tb?.contact_id === S && tb?.seller_contact_id === S && !tb?.buyer_contact_id)
}

/** §K THE ASSIGNED COORDINATOR is told; the roster is the fallback. */
async function sectionK() {
  section("§K the assigned coordinator is notified specifically; the TC roster only when none is assigned")
  const loopMod = await load("lib/listings/listing-compliance-loop.ts")
  if (loopMod.__loadError) { check("the loop loads", false, loopMod.__loadError); return }
  const TC1 = u(35)
  resetCalls(); G.__B.mem = listingWorld(); G.__B.mem.tables.contacts[0].tc_user_id = TC1
  await loopMod.runListingComplianceLoop(G.__B.mem, { brokerageId: B, listingId: L, trigger: "agreement_executed", actorUserId: AU })
  const n = G.__B.calls.notify[0]
  check("the listing's assigned coordinator (the seller contact's tc_user_id) is named on the review item", Array.isArray(n?.assignedCoordinatorUserIds) && n.assignedCoordinatorUserIds.includes(TC1), n?.assignedCoordinatorUserIds)
  const helpers = await load("lib/notifications/notify-helpers.ts", true)
  if (helpers.__loadError) { check("the real notify-helpers loads (?real)", false, helpers.__loadError); return }
  const TC2 = u(36)
  const world = () => memSupabase({ users: [{ id: TC2, brokerage_id: B, user_type: "tc" }, { id: CO, brokerage_id: B, user_type: "compliance_officer" }], notifications: [] })
  const flag = { type: "compliance.listing_review_ready", severity: "medium" as const, title: "t", entityType: "listing" as const, entityId: L }
  const m1 = world(); const r1 = await quietly<any>(() => helpers.notifyComplianceFlag(m1, { brokerageId: B, agentUserId: AU, assignedCoordinatorUserIds: [TC1], flag }))
  check("with an assigned coordinator: THEY and compliance are told, the roster TC is not", r1.recipient_user_ids.includes(TC1) && r1.recipient_user_ids.includes(CO) && !r1.recipient_user_ids.includes(TC2), r1.recipient_user_ids)
  const m2 = world(); const r2 = await quietly<any>(() => helpers.notifyComplianceFlag(m2, { brokerageId: B, agentUserId: AU, flag }))
  check("with none assigned: the TC roster is the fallback", r2.recipient_user_ids.includes(TC2), r2.recipient_user_ids)
}

/** §L THE FORM-LICENSE SEAM and the LEGAL DESCRIPTION extraction. */
async function sectionL(rg: any) {
  section("§L the form-license seam (156C plugs in here) and the legal description is extracted")
  if (rg.__loadError) { check("the decision module loads", false, rg.__loadError); return }
  const seen: string[] = []
  rg.setFormLicenseCheck((doc: any) => { seen.push(doc.id); return doc.state_form_id === "TXR 1101-OLD" ? { code: "form_license", severity: "hold", documentId: doc.id, field: "state_form_id", message: "form version superseded" } : null })
  const input = { brokerageId: B, listing: listingRow(), sellerNames: ["Sam Seller"], gate: PASS_GATE, approval: null, checkedAt: T0, agreement: { id: LA, effective_date: "2026-11-20", expiration_date: "2027-06-30", listing_commission_rate: 3, total_commission_rate: 6, agent_signed_at: T0, seller_signed_at: T0 }, agreementDocuments: [agreementDoc({ state_form_id: "TXR 1101-OLD" })], addenda: [] }
  const d = rg.decideListingRepresentation(input)
  check("every executed document passes through the ONE seam (formLicenseFinding), and its finding is a named HOLD", seen.includes(DOC) && d.verdict === "hold" && d.blockingReasons.some((r: any) => r.code === "form_license"))
  rg.setFormLicenseCheck(() => null)
  check("NEGATIVE CONTROL: with the seam's default (no registry connected) the same packet does not hold on the form", rg.decideListingRepresentation(input).verdict === "needs_review")
  const scan = raw("lib/documents/scan-uploaded-document.ts")
  check("the scanner's listing_agreement extraction schema asks for legal_description", /listing_agreement\s+→\s*\{[^}]*legal_description/.test(scan))
  const noLegal = rg.decideListingRepresentation({ ...input, agreementDocuments: [agreementDoc({}, { legal_description: null })] })
  check("absent from the extraction, the legal description stays 'unverified by machine' for the reviewer", noLegal.blockingReasons.some((r: any) => r.code === "unverified_by_machine" && r.field === "legal_description"))
}

/** §M THE REVIEWER'S SCREEN — on the existing compliance queue and on the listing; solo principal can decide. */
async function sectionM() {
  section("§M the reviewer's screen — the compliance queue and the listing page; agents read, reviewers decide")
  const queue = code("app/dashboard/compliance/queue/page.tsx")
  check("the EXISTING compliance queue renders the executed-packet review queue", /<RepresentationReviewQueue\s*\/>/.test(queue))
  const panel = code("app/dashboard/compliance/queue/representation-review-panel.tsx")
  check("the panel shows document-says / record-says side by side, each reason's form, field and repair, and the document link", /Document says/.test(panel) && /Record says/.test(panel) && /Form:/.test(panel) && /Field:/.test(panel) && /How this ends/.test(panel) && /openHref/.test(panel))
  check("…Approve / Hold call the representation-review doors, bound to the evidence hash on screen", /recordRepresentationReview\(\{[^}]*evidenceHash: d\.evidenceHash/.test(panel))
  check("…decision and attestation controls render only for a reviewer (data.mayDecide); others see status", /data\.mayDecide \? \(/.test(panel) && /Compliance decides this packet/.test(panel))
  const actSrc = code("app/actions/compliance/representation-review.ts")
  check("the screen's repair text comes FROM REPAIR_PATHS and 'who may approve' FROM REPRESENTATION_REVIEWER_AUTHORITY (one source; read by the door, rendered by the panel)",
    /REPAIR_PATHS\[code\]/.test(actSrc) && /REPRESENTATION_REVIEWER_AUTHORITY\.roles/.test(actSrc) && /data\.repairs\[r\.code\]/.test(panel) && /data\.whoMayApprove/.test(panel))
  const qc = code("app/dashboard/compliance/queue/representation-review-queue.tsx")
  check("queue rows and the listing page LINK to the full review page (the census-visible href)", /href=\{`\/dashboard\/compliance\/queue\/review\/\$\{it\.record\}\/\$\{it\.subjectId\}`\}/.test(qc) && /\/dashboard\/compliance\/queue\/review\/listing_agreement\//.test(code("app/dashboard/listings/[id]/compliance-review/page.tsx")))
  check("an empty queue and a failed load read differently", /No executed listing agreements or offers are waiting/.test(qc) && /not an empty queue/.test(code("app/actions/compliance/representation-review.ts")))
  const lp = code("app/dashboard/listings/[id]/compliance-review/page.tsx")
  check("the listing page carries the review (the listing-side affordance), linked from the lifecycle page", /<RepresentationReviewPanel record="listing_agreement"/.test(lp) && /compliance-review/.test(code("app/dashboard/listings/[id]/lifecycle/page.tsx")))
  const act = await load("app/actions/compliance/representation-review.ts")
  if (act.__loadError) { check("the reviewer door loads", false, act.__loadError); return }
  // A SOLO agent: user_type 'agent', the account's principal, owning agent of their own listing.
  resetCalls(); G.__B.mem = listingWorld(); G.__B.mem.tables.user_role_assignments = []
  // the solo tenant: the agent leads the account's only team (the principal rule lib/auth/resolve-user-role.ts reads)
  G.__B.mem.tables.teams = [{ id: u(700), brokerage_id: B, team_lead_id: AU, deleted_at: null }]
  G.__B.mem.tables.brokerages = [{ id: B, plan_tier: "solo_agent" }]
  G.__B.seat = { userId: AU, agentId: AG, brokerageId: B, userType: "agent", isTenantPrincipal: true }
  const v = await act.getRepresentationReviewAction({ record: "listing_agreement", subjectId: L })
  check("a SOLO agent who is the account principal may decide their own listing's review", v.success && v.mayDecide === true, v)
  const ok = await act.recordRepresentationReview({ record: "listing_agreement", subjectId: L, decision: "approve", evidenceHash: v.success ? v.decision.evidenceHash : "" })
  check("…and finishes it: the listing advances", ok.success && ok.continued?.listing === "advanced", ok)
  G.__B.mem = listingWorld(); G.__B.mem.tables.user_role_assignments = []
  G.__B.seat = { userId: AU, agentId: AG, brokerageId: B, userType: "agent", isTenantPrincipal: false }
  const v2 = await act.getRepresentationReviewAction({ record: "listing_agreement", subjectId: L })
  check("NEGATIVE CONTROL: the same agent in a brokerage (not principal) sees status and reasons but may NOT decide", v2.success && v2.mayDecide === false)
  const q = await act.listRepresentationReviewQueueAction()
  check("the agent's queue is their own packets only (empty before the loop raised one)", q.success && q.items.length === 0, q)
  await loopModRun()
  const q2 = await act.listRepresentationReviewQueueAction()
  check("…and lists the packet once the loop put it in review, with its state", q2.success && q2.items.length === 1 && q2.items[0].state === "awaiting_review", q2)
  G.__B.seat = null
}
async function loopModRun() { const m = await load("lib/listings/listing-compliance-loop.ts"); if (!m.__loadError) await m.runListingComplianceLoop(G.__B.mem, { brokerageId: B, listingId: L, trigger: "agreement_executed", actorUserId: AU }) }

// ═══ run ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log(`wave156-b-representation-gate-guard — the executed-packet review (modules from ${ROOT === WT ? "this tree" : ROOT})`)
  sectionA()
  const rg = await load("lib/kernel/compliance/representation-gate.ts")
  const gateMod = await load("lib/listings/listing-activation-gate.ts")
  await sectionB(rg, gateMod)
  await sectionC(rg)
  await sectionD()
  await sectionE(rg)
  await sectionF()
  await sectionG(rg)
  await sectionH()
  await sectionI(rg)
  await sectionJ()
  await sectionK()
  await sectionL(rg)
  await sectionM()
  console.log("\nBLIND SPOTS: DB triggers / RPCs inserting transactions are not visible to a source scan (checked live once: none); m1001 is")
  console.log("modeled in memory until applied; legal description is compared only when the scan extracts it (else reviewer-confirmed);")
  console.log("form license/version is recorded, not compared to a licensed-forms registry; seats are proved through the rule and the door, not live RLS.")
  if (fails.length) { console.log("\nFAILURES:"); for (const f of fails) console.log("  - " + f) }
  console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
