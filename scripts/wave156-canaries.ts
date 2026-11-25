#!/usr/bin/env tsx
/**
 * scripts/wave156-canaries.ts — wave 156, lane 156P (requested key: test:wave156-canaries). IN-MEMORY, SIMULATED, NEVER LIVE.
 *
 * THE CROSS-LANE CANARIES C01–C30 of the wave-156 directive (156P, the table at lines 405–436; proof standard line 438). Every lane
 * proved its own doors with its own guard; this suite drives the JOURNEYS that cross lanes, on the integrated tree, one canary
 * per row of the table, each with the business outcome driven (POSITIVE) and the named failure driven and caught (NEGATIVE).
 *
 * HOW IT DRIVES. Each canary runs in its OWN child process (this file re-invoked with `--one <ID>`), so each installs exactly the
 * module seams it needs before any product module loads (node:module registerHooks): the session / service clients are the
 * in-memory client (scripts/in-memory-supabase.ts), and every model, provider, payment, e-sign, notification and egress seam is
 * a COUNTED stub — global fetch is replaced by a counter that REFUSES. Product modules are loaded from WAVE156P_ROOT (default:
 * this tree), so the same canaries run against the pre-wave tree for the red-at-base control. A check is one of:
 *   POS  — the business outcome, driven through real exported product code;
 *   NEG  — the named failure, driven and shown to be caught (the product refuses / holds / does not write / does not call);
 *   CTRL — a positive control proving a NEG or an absence claim could see the defect it was written for;
 *   SRC  — a source rule on COMMENT-STRIPPED text (scripts/strip-comments.ts) — a supplement only, never the canary's proof;
 *   LOAD — the module a canary drives loads (a red LOAD at base means the door is ABSENT there, reported as such).
 * A canary passes only when every check passes AND it has at least one POS and one NEG that ran.
 *
 * THE SUBSCRIBER MATRIX (directive 156A proofs, C29): canaries about a tenant-facing surface run per subscriber shape — solo agent,
 * team, single-office brokerage, multi-location brokerage with an office seat — and the parent prints canary × shape → pass.
 *
 * RED AT BASE: `WAVE156P_ROOT=<pre-wave tree> npx tsx scripts/wave156-canaries.ts` — the parent classifies each red canary as
 * DEFECT CAUGHT (its doors load and a driven NEG fails: the previous defect is shown) or ABSENT (the door it drives does not exist).
 *
 * SIMULATED IS NEVER LIVE. Nothing here touches a database, a provider, a model, Stripe, e-sign or a deployment. C11 and C28 are
 * about exactly that distinction: a local / simulated result recorded as live is REFUSED by the release-state rules.
 *
 * BLIND SPOTS (published beside the number, CLAUDE.md §2): the in-memory client has no row security, CHECK constraints, triggers,
 * foreign keys or real concurrency (races are interleaved promises); RLS / storage policies are judged from SQL TEXT and the
 * measured fingerprints the lane guards pin, never executed here; no browser renders a page (the rendering halves of C13 / C29
 * are NOT covered — the server actions whose strings the components render are driven instead); provider documentation
 * (RentCast billing, Datafiniti counts, Versium terms) is modeled by the lane stubs, never called; C24 measures the import graph
 * with the repo's own walker and does not run `next build` (forbidden in a lane); per-canary notes print what each does not cover.
 */
import { registerHooks } from "node:module"
import { readFileSync, existsSync, statSync } from "node:fs"
import { pathToFileURL, fileURLToPath } from "node:url"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { memSupabase, type MemClient, type Row } from "./in-memory-supabase"
import { stripComments } from "./strip-comments"

const WT = process.cwd()
const ROOT = process.env.WAVE156P_ROOT || WT
const SELF = fileURLToPath(import.meta.url)
const G = globalThis as any

// ═══ checks ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
type Kind = "POS" | "NEG" | "CTRL" | "SRC" | "LOAD"
interface Res { id: string; pass: number; fail: number; byKind: Record<Kind, { pass: number; fail: number }>; failed: Array<{ kind: Kind; name: string }>; matrix: Record<string, Record<string, boolean>>; notes: string[]; crashed?: string }
const R: Res = { id: "", pass: 0, fail: 0, byKind: { POS: { pass: 0, fail: 0 }, NEG: { pass: 0, fail: 0 }, CTRL: { pass: 0, fail: 0 }, SRC: { pass: 0, fail: 0 }, LOAD: { pass: 0, fail: 0 } }, failed: [], matrix: {}, notes: [] }
function check(kind: Kind, name: string, ok: boolean, detail?: unknown) {
  if (ok) { R.pass++; R.byKind[kind].pass++; console.log(`  ✓ ${kind.padEnd(4)} ${name}`) }
  else { R.fail++; R.byKind[kind].fail++; R.failed.push({ kind, name }); console.log(`  ✗ ${kind.padEnd(4)} ${name}${detail === undefined ? "" : ` — ${safeJson(detail).slice(0, 360)}`}`) }
}
const pos = (n: string, ok: boolean, d?: unknown) => check("POS", n, ok, d)
const neg = (n: string, ok: boolean, d?: unknown) => check("NEG", n, ok, d)
const ctrl = (n: string, ok: boolean, d?: unknown) => check("CTRL", n, ok, d)
const src = (n: string, ok: boolean, d?: unknown) => check("SRC", n, ok, d)
const note = (s: string) => { R.notes.push(s); console.log(`  · NOTE ${s}`) }
/** Record one subscriber-shape cell (C29 matrix). */
const cell = (shape: "solo" | "team" | "brokerage" | "multi-office", ok: boolean) => { (R.matrix[R.id] ??= {})[shape] = ((R.matrix[R.id] ?? {})[shape] ?? true) && ok }
function safeJson(x: unknown): string { try { return JSON.stringify(x) ?? String(x) } catch { return String(x) } }

// ═══ product-module loading (from ROOT) and seams ═════════════════════════════════════════════════════════════════════════
const raw = (f: string): string => { const p = join(ROOT, f); return existsSync(p) ? readFileSync(p, "utf8") : "" }
const code = (f: string): string => stripComments(raw(f))
const realUrl = (p: string) => pathToFileURL(join(ROOT, p)).href
const dataUrl = (c: string) => `data:text/javascript,${encodeURIComponent(c)}`
function aliasPath(rel: string): string | null {
  for (const c of [rel, `${rel}.ts`, `${rel}.tsx`, `${rel}/index.ts`, `${rel}/index.tsx`]) { const p = join(ROOT, c); if (existsSync(p) && !statSync(p).isDirectory()) return p }
  return null
}
interface Seams { replace?: Record<string, string>; override?: Record<string, string>; spec?: Record<string, string> }
const BASE_SPEC: Record<string, string> = {
  "server-only": "export {}",
  "next/cache": "export function revalidatePath(){}; export function revalidateTag(){}; export function unstable_noStore(){}; export function unstable_cache(f){ return f }",
  "next/headers": "export async function headers(){ return globalThis.__P.headers ?? new Map() }; export async function cookies(){ return { get(){}, getAll(){ return [] }, set(){}, delete(){} } }; export async function draftMode(){ return { isEnabled: false } }",
  // A client a module builds for itself is handed the CURRENT in-memory world (nothing reaches a network).
  "@supabase/supabase-js": "export function createClient(){ return new Proxy({}, { get: (_t, k) => globalThis.__P.mem[k] }) }",
}
/** The session / service clients every canary shares: the in-memory world plus an auth seam that answers the current seat. */
const CLIENTS: Record<string, string> = {
  "lib/supabase/service.ts": "export function createServiceClient(){ return globalThis.__P.client() }; export const createAdminClient = createServiceClient",
  "lib/supabase/server.ts": "export async function createClient(){ return globalThis.__P.client() }; export async function createServerClient(){ return globalThis.__P.client() }; export const createServiceRoleClient = async () => globalThis.__P.client()",
}
function installSeams(s: Seams) {
  const replace = { ...CLIENTS, ...(s.replace ?? {}) }
  const override = s.override ?? {}
  const spec = { ...BASE_SPEC, ...(s.spec ?? {}) }
  registerHooks({
    resolve(sp: string, ctx: any, next: any) {
      if (spec[sp] !== undefined) return { url: dataUrl(spec[sp]), shortCircuit: true }
      const aliased = sp.startsWith("@/") ? aliasPath(sp.slice(2)) : null
      const r = aliased ? { url: pathToFileURL(aliased).href, shortCircuit: true } : next(sp, ctx)
      if (String(ctx?.parentURL ?? "").startsWith("data:")) return r
      if (String(r.url ?? "").includes("?real")) return r
      const path = String(r.url ?? "").split("?")[0]
      const rep = Object.keys(replace).find((k) => path === realUrl(k))
      if (rep) return { url: dataUrl(replace[rep]), shortCircuit: true }
      const ov = Object.keys(override).find((k) => path === realUrl(k))
      if (ov) return { url: dataUrl(`export * from ${JSON.stringify(realUrl(ov) + "?real")}; ${override[ov]}`), shortCircuit: true }
      return r
    },
  })
}
const loadErrors: Record<string, string> = {}
async function load(p: string, real = false): Promise<any> {
  if (!existsSync(join(ROOT, p))) { loadErrors[p] = "absent"; return { __loadError: `${p} does not exist in this tree`, __absent: true } }
  try { return await import(realUrl(p) + (real ? "?real" : "")) } catch (e) { loadErrors[p] = String((e as Error)?.message ?? e).slice(0, 220); return { __loadError: loadErrors[p] } }
}
/** LOAD check: the module exists and exports what the canary drives. Returns false (and records ABSENT) when it does not. */
function loaded(mod: any, label: string, ...names: string[]): boolean {
  const missing = names.filter((n) => typeof mod?.[n] === "undefined")
  const ok = !mod?.__loadError && missing.length === 0
  check("LOAD", `${label}${names.length ? ` exports ${names.join(", ")}` : ""}`, ok, mod?.__loadError ?? (missing.length ? { missing } : undefined))
  return ok
}
const quiet = async <X,>(fn: () => Promise<X>): Promise<X> => {
  const l = console.log, w = console.warn, e = console.error, i = console.info
  console.log = console.warn = console.error = console.info = () => {}
  try { return await fn() } finally { console.log = l; console.warn = w; console.error = e; console.info = i }
}
async function drive<X>(fn: () => Promise<X>): Promise<{ r: X | undefined; threw: string | null }> {
  try { return { r: await quiet(fn), threw: null } } catch (e) { return { r: undefined, threw: String((e as Error)?.message ?? e).slice(0, 300) } }
}
const T = (m: MemClient, t: string): Row[] => (m.tables[t] ??= [])

// The shared runtime every seam reads. `client()` returns the current world with an auth seam for the current seat.
G.__P = {
  mem: memSupabase({}) as MemClient, seat: null as null | { id: string; email?: string },
  calls: {} as Record<string, number>, log: {} as Record<string, any[]>, headers: undefined as any,
  client: () => Object.assign(G.__P.mem, { auth: { getUser: async () => ({ data: { user: G.__P.seat ? { id: G.__P.seat.id, email: G.__P.seat.email ?? "seat@example.test", user_metadata: {} } : null }, error: null }), getSession: async () => ({ data: { session: null }, error: null }) } }),
  count: (k: string) => { G.__P.calls[k] = (G.__P.calls[k] ?? 0) + 1 },
  push: (k: string, v: any) => { (G.__P.log[k] ??= []).push(v) },
}
const calls = (k: string): number => G.__P.calls[k] ?? 0
const logged = (k: string): any[] => G.__P.log[k] ?? []
const resetCalls = () => { G.__P.calls = {}; G.__P.log = {} }
/** Global fetch REFUSES and counts — no provider, model, mail, SMS, payment or deployment can leave the process. */
;(globalThis as any).fetch = async (url: unknown) => { G.__P.count("fetch"); G.__P.push("fetch", String(url)); throw new Error("wave156-canaries: network refused (SIMULATED)") }

const u = (p: string, n: number) => `${p}${String(n).padStart(7, "0")}-0000-4000-8000-000000000156`
const T0 = "2026-11-20T12:00:00.000Z"

// ═══ the canaries ═════════════════════════════════════════════════════════════════════════════════════════════════════════
interface Canary { id: string; title: string; failure: string; seams: () => Seams; run: () => Promise<void> }
const CANARIES: Canary[] = []
const canary = (c: Canary) => { CANARIES.push(c) }

// ── shared seams of the representation (156B / 156R) canaries ─────────────────────────────────────────────────────────────
const REP_SEAMS: Record<string, string> = {
  "lib/notifications/notify-helpers.ts": "export async function notifyComplianceFlag(_s, input){ globalThis.__P.push('notify', input); return { notified_count: 1, recipient_user_ids: [] } }; export async function notifyTransactionParties(){ globalThis.__P.count('parties'); return { sent: true, already_notified: false, errors: [] } }",
  "lib/esign/packet-state-writer.ts": "export async function advanceEsignPacketState(_s, p){ globalThis.__P.push('packet', p.to); return { ok: true } }",
  "lib/kernel/lifecycle.ts": "export async function transitionLifecycle(p){ globalThis.__P.push('hop', p.toState); return { success: true } }",
  "lib/kernel/write-sentinel.ts": "export async function sentinelWrite(_s, p){ return await p }",
  "lib/transactions/milestone-service.ts": "export async function ensureRequiredMilestones(){ return { ok: true } }; export async function seedJourneyMilestones(){ return { ok: true } }",
  "lib/transactions/participant-populator.ts": "export async function populateInitialParticipants(){ return { ok: true } }",
  "lib/transactions/closing-compliance.ts": "export async function pinDealChecklistAtCreation(){ return { error: null } }",
  "lib/offers/financing-subtype.ts": "export async function readFinancingSubtype(){ return { ok: true, subtype: null } }; export async function persistFinancingSubtype(){ return { ok: true } }",
  "lib/transactions/closing-dates.ts": "export async function seedContractClosing(){ return { ok: true } }; export async function readContractWordingAtPromotion(){ return { ok: true } }",
  "lib/transactions/contingency-deadlines.ts": "export async function ensureContingencyDeadlines(){ return { ok: true } }",
  "lib/kernel/transactions.ts": "export async function emitTransactionEvent(){ return { inserted: true } }",
  "lib/kernel/action-ledger.ts": "export async function withActionLedger(_c, run){ globalThis.__P.count('ledger'); return run() }; export async function ledgerSessionAction(_c, run){ globalThis.__P.count('ledger'); return run() }; export async function ledgerToolCall(_c, run){ return run() }",
  "lib/agreements/session-actor.ts": "export async function resolveSessionActor(){ const s = globalThis.__P.actor; return s ? { ok: true, actor: s } : { ok: false, error: 'no session' } }",
}
const rB = u("b", 1), rB2 = u("b", 2), rL = u("c", 10), rLA = u("c", 11), rDOC = u("c", 12), rDISC = u("c", 13), rS = u("c", 20), rAG = u("e", 30), rAU = u("a", 31), rCO = u("a", 32), rBU = u("a", 33)
const rO = u("d", 40), rCB = u("c", 41), rCDOC = u("c", 42), rUADD = u("c", 43)
const fullSc = (parties: string[]) => ({ signatures: parties.map((p) => ({ signer_role: p, signer_name: p === "seller" ? "Sam Seller" : p === "agent" ? "Alex Agent" : `${p} person`, signed: true })), initials: parties.map((p) => ({ signer_role: p, all_required_initials_present: true })) })
const agreementDoc = (over: Partial<Row> = {}, fields: Record<string, unknown> = {}): Row => ({
  id: rDOC, brokerage_id: rB, listing_id: rL, classification: "listing_agreement", classification_confidence: "high", scanned_at: T0, scan_error: null,
  metadata: {}, state_code: "TX", state_form_id: "TXR 1101", created_at: T0, signature_completeness: fullSc(["agent", "seller"]),
  extracted_fields: { property_address: "12 Oak St, Austin, TX 78701", zip_code: "78701", state: "TX", list_price: "500,000", list_date: "2026-11-20", expiration_date: "2027-06-30", commission_rate: 6, seller_name: "Sam Seller", legal_description: "Lot 4, Block 2, Oak Hills", ...fields },
  ...over,
})
function listingWorld(o: { listing?: Partial<Row>; doc?: Row; plan?: string } = {}): MemClient {
  return memSupabase({
    brokerages: [{ id: rB, plan_tier: o.plan ?? "brokerage" }],
    listings: [{ id: rL, brokerage_id: rB, agent_id: rAG, seller_contact_id: rS, contact_id: null, state: "TX", address: "12 Oak Street", city: "Austin", zip: "78701", list_price: 500000, expiration_date: "2027-06-30", legal_description: "Lot 4, Block 2, Oak Hills", commission_rate: 6, lifecycle_stage: "LISTING_AGREEMENT_SIGNED", go_live_date: "2026-12-10", metadata: {}, ...o.listing }],
    listing_agreements: [{ id: rLA, listing_id: rL, brokerage_id: rB, esign_status: "fully_signed", compliance_passed: false, agent_signed_at: T0, seller_signed_at: T0, fully_executed_at: null, effective_date: "2026-11-20", expiration_date: "2027-06-30", total_commission_rate: 6, listing_commission_rate: 3, created_at: T0 }],
    documents: [o.doc ?? agreementDoc(), { id: rDISC, brokerage_id: rB, listing_id: rL, classification: "disclosure", classification_confidence: "high", scanned_at: T0, metadata: {}, signature_completeness: fullSc(["agent", "seller"]), extracted_fields: { disclosure_type: "seller" }, created_at: T0 }],
    contacts: [{ id: rS, brokerage_id: rB, first_name: "Sam", last_name: "Seller" }],
    agents: [{ id: rAG, user_id: rAU, brokerage_id: rB }],
    users: [{ id: rAU, brokerage_id: rB, team_id: null, user_type: "agent" }, { id: rCO, brokerage_id: rB, team_id: null, user_type: "compliance_officer" }, { id: rBU, brokerage_id: rB, team_id: null, user_type: "broker" }],
    brokerage_required_documents: [
      { id: u("9", 90), brokerage_id: rB, classification: "listing_agreement", is_required: true, deal_type: "seller", scope_type: "brokerage", scope_id: rB, block_on_missing: true, state_code: null },
      { id: u("9", 91), brokerage_id: rB, classification: "disclosure", is_required: true, deal_type: "seller", scope_type: "brokerage", scope_id: rB, block_on_missing: true, state_code: "TX", legal_basis: "state_requirement" },
    ],
    compliance_events: [], transactions: [], activities: [], notifications: [], user_role_assignments: [], teams: [], brokerage_form_library: [],
  }, { uuidIds: true, stampCreatedAt: true })
}
const contractDoc = (over: Partial<Row> = {}, fields: Record<string, unknown> = {}): Row => ({
  id: rCDOC, brokerage_id: rB, contact_id: rCB, classification: "signed_contract", classification_confidence: "high", scanned_at: T0, scan_error: null, created_at: T0,
  metadata: { linked_offer_id: rO }, signature_completeness: fullSc(["buyer", "seller"]),
  extracted_fields: { price: 500000, earnest_money_amount: 10000, closing_date: "2026-12-30", property_address: "40 Elm St, Austin, TX 78702", ...fields }, ...over,
})
const offerRow = (over: Partial<Row> = {}): Row => ({ id: rO, brokerage_id: rB, agent_id: rAG, contact_id: rCB, listing_id: null, parent_offer_id: null, status: "accepted", offer_type: "purchase", offer_price: 500000, earnest_money: 10000, closing_date: "2026-12-30", property_address: "40 Elm Street, Austin, TX 78702", buyer_signed_at: T0, seller_signed_at: T0, seller_response_type: "accepted", fully_signed_contract_received_at: T0, compliance_passed_at: T0, transaction_id: null, metadata: {}, created_at: T0, ...over })
function offerWorld(o: { offer?: Partial<Row>; docs?: Row[] } = {}): MemClient {
  return memSupabase({
    brokerages: [{ id: rB, plan_tier: "brokerage" }],
    offers: [offerRow(o.offer)], documents: o.docs ?? [contractDoc()],
    activities: [{ id: u("9", 600), brokerage_id: rB, entity_type: "offer", entity_id: rO, activity_type: "buyer.offer.compliance.passed", status: "completed", created_at: T0 }],
    brokerage_required_documents: [{ id: u("9", 92), brokerage_id: rB, classification: "signed_contract", is_required: true, deal_type: "buyer", scope_type: "brokerage", scope_id: rB, block_on_missing: true, state_code: null }],
    contract_term_versions: [], agents: [{ id: rAG, user_id: rAU, brokerage_id: rB }], users: [{ id: rAU, brokerage_id: rB, team_id: null, user_type: "agent" }],
    transactions: [], compliance_events: [], contacts: [{ id: rCB, brokerage_id: rB, first_name: "Bea", last_name: "Buyer" }],
    buyer_broker_agreements: [], listings: [], brokerage_form_library: [], user_role_assignments: [], teams: [],
  }, { uuidIds: true, stampCreatedAt: true, unique: { transactions: [["brokerage_id", "offer_id"]] } })
}

canary({
  id: "C01", title: "Solo-agent tenant: a fully signed listing agreement is COMPARED by compliance before any eligibility transition",
  failure: "a mere fully_signed flag creates a purchase transaction (or advances the listing unreviewed)",
  seams: () => ({ replace: REP_SEAMS }),
  async run() {
    const loop = await load("lib/listings/listing-compliance-loop.ts")
    const gate = await load("lib/transactions/transaction-creation-gate.ts")
    if (!loaded(loop, "lib/listings/listing-compliance-loop.ts", "runListingComplianceLoop") || !loaded(gate, "lib/transactions/transaction-creation-gate.ts", "assertTransactionCreationAllowed")) return
    const run = (trigger = "agreement_executed") => quiet(() => loop.runListingComplianceLoop(G.__P.mem, { brokerageId: rB, listingId: rL, trigger, actorUserId: rAU }))
    resetCalls(); G.__P.mem = listingWorld({ plan: "solo_agent" })
    const r1: any = await run()
    neg("a fully signed, consistent agreement does NOT advance on the signature alone: no lifecycle hop, outcome awaiting_review", r1?.outcome === "awaiting_review" && logged("hop").length === 0, { outcome: r1?.outcome, hops: logged("hop") })
    neg("…and NO purchase transaction exists after the fully_signed agreement", T(G.__P.mem, "transactions").length === 0)
    neg("…and compliance_approved is NOT stamped on the packet before a human review", !logged("packet").includes("compliance_approved"), logged("packet"))
    const listingOnly: any = await quiet(() => gate.assertTransactionCreationAllowed(G.__P.mem, { brokerageId: rB, offerId: null, listingId: rL, contactIds: [rS], agentUserId: rAU, teamId: null, dealType: "seller", stateCode: "TX", door: "canary C01" }))
    neg("the creation gate refuses a deal built from the listing agreement alone (no executed offer)", listingOnly?.allowed === false, listingOnly?.refusals)
    pos("the decision leaves a receipt in compliance_events (gate representation_review, verdict needs_review)", T(G.__P.mem, "compliance_events").some((e) => e.gate_name === "representation_review" && e.details?.verdict === "needs_review"))
    const act = await load("app/actions/compliance/representation-review.ts")
    if (!loaded(act, "app/actions/compliance/representation-review.ts", "getRepresentationReviewAction", "recordRepresentationReview")) return
    // THE SOLO PRINCIPAL (a seat typed `agent` on a stored plan_tier solo_agent) is the account's reviewer (156B / 156R).
    G.__P.actor = { userId: rAU, agentId: rAG, brokerageId: rB, userType: "agent", isTenantPrincipal: false }
    const view: any = await quiet(() => act.getRepresentationReviewAction({ record: "listing_agreement", subjectId: rL }))
    pos("the solo principal opens their packet in review and MAY decide it", view?.success === true && view?.mayDecide === true && view?.decision?.verdict === "needs_review", view)
    const ok: any = await quiet(() => act.recordRepresentationReview({ record: "listing_agreement", subjectId: rL, decision: "approve", evidenceHash: view?.decision?.evidenceHash ?? "" }))
    pos("the approval bound to the evidence hash continues ONLY the listing (advanced to coming-soon prep)", ok?.success === true && ok?.continued?.listing === "advanced" && JSON.stringify(logged("hop")) === JSON.stringify(["MLS_DATE_CONFIRMED", "COMING_SOON_PREP"]), { ok, hops: logged("hop") })
    neg("…and STILL no purchase transaction (a listing agreement alone never creates one)", T(G.__P.mem, "transactions").length === 0)
    cell("solo", ok?.success === true && T(G.__P.mem, "transactions").length === 0)
    // CONTROL: the same seat in a BROKERAGE is not the reviewer — the tier decides, not the user_type.
    G.__P.mem = listingWorld({ plan: "brokerage" }); await run()
    const v2: any = await quiet(() => act.getRepresentationReviewAction({ record: "listing_agreement", subjectId: rL }))
    const no: any = await quiet(() => act.recordRepresentationReview({ record: "listing_agreement", subjectId: rL, decision: "approve", evidenceHash: v2?.decision?.evidenceHash ?? "" }))
    ctrl("the same `agent` seat in a brokerage cannot approve its own packet (the solo admission is the tier, not the type)", no?.success === false && !T(G.__P.mem, "compliance_events").some((e) => e.details?.kind === "human_review"), no)
    G.__P.actor = { userId: rCO, agentId: null, brokerageId: rB, userType: "compliance_officer", isTenantPrincipal: false }
    const co: any = await quiet(() => act.recordRepresentationReview({ record: "listing_agreement", subjectId: rL, decision: "approve", evidenceHash: v2?.decision?.evidenceHash ?? "" }))
    pos("in the brokerage the compliance officer approves and the listing advances — still no transaction", co?.success === true && T(G.__P.mem, "transactions").length === 0, co)
    cell("brokerage", co?.success === true && T(G.__P.mem, "transactions").length === 0)
  },
})

canary({
  id: "C02", title: "A changed listing term or a missing initial routes to a compliance HOLD and an exact agent task",
  failure: "AI marks the packet complete on a summary only",
  seams: () => ({ replace: REP_SEAMS }),
  async run() {
    const loop = await load("lib/listings/listing-compliance-loop.ts")
    if (!loaded(loop, "lib/listings/listing-compliance-loop.ts", "runListingComplianceLoop")) return
    const run = () => quiet(() => loop.runListingComplianceLoop(G.__P.mem, { brokerageId: rB, listingId: rL, trigger: "agreement_executed", actorUserId: rAU }))
    resetCalls(); G.__P.mem = listingWorld({ listing: { list_price: 525000 } })
    const r: any = await run()
    const n = logged("notify")[0]
    pos("a list price the executed agreement contradicts HOLDS (blocked) and the reason names the term and both figures", r?.outcome === "blocked" && /list price/i.test(r?.reason ?? "") && /525000|525,000/.test(r?.reason ?? ""), r)
    pos("…the actionable item links the REAL executed document (documentId), not a summary", n?.flag?.documentId === rDOC, n?.flag)
    pos("…the e-sign packet is marked correction_required", logged("packet").includes("correction_required"), logged("packet"))
    neg("…nothing advanced and compliance_approved was never stamped (no 'complete on a summary')", logged("hop").length === 0 && !logged("packet").includes("compliance_approved"), { hops: logged("hop"), packet: logged("packet") })
    resetCalls(); G.__P.mem = listingWorld({ doc: agreementDoc({ signature_completeness: { ...fullSc(["agent", "seller"]), initials: [{ signer_role: "agent", all_required_initials_present: true }, { signer_role: "seller", all_required_initials_present: false }] } }) })
    const r2: any = await run()
    pos("a MISSING seller initial holds the packet (blocked)", r2?.outcome === "blocked", r2)
    neg("…and does not advance or create a deal", logged("hop").length === 0 && T(G.__P.mem, "transactions").length === 0)
    // The "summary" failure: an extraction the scanner could not read (empty / failed / low confidence) is a HOLD, never success.
    resetCalls(); G.__P.mem = listingWorld({ doc: agreementDoc({ scan_error: "OCR failed", extracted_fields: {} }) })
    const r3: any = await run()
    neg("an executed agreement nobody could READ (failed scan) is never marked complete — it holds", r3?.outcome !== "advanced" && !logged("packet").includes("compliance_approved") && logged("hop").length === 0, r3)
    const rg = await load("lib/kernel/compliance/representation-gate.ts")
    if (loaded(rg, "lib/kernel/compliance/representation-gate.ts", "REPAIR_PATHS")) pos("every hold reason carries a terminating repair path (no hold is a dead end)", Object.values(rg.REPAIR_PATHS as Record<string, any>).every((p) => typeof p?.path === "string" && typeof p?.terminatesWhen === "string"), Object.keys(rg.REPAIR_PATHS ?? {}))
    resetCalls(); G.__P.mem = listingWorld()
    const c: any = await run()
    ctrl("POSITIVE CONTROL: the identical consistent, fully initialed packet is NOT held (awaiting_review)", c?.outcome === "awaiting_review", c)
  },
})

canary({
  id: "C03", title: "A fully executed accepted offer creates exactly ONE real transaction after offer compliance",
  failure: "a webhook replay creates two transactions, or unsigned / contradicted terms create one",
  seams: () => ({ replace: REP_SEAMS }),
  async run() {
    const bridge = await load("lib/transactions/offer-bridge.ts")
    if (!loaded(bridge, "lib/transactions/offer-bridge.ts", "createTransactionFromOffer")) return
    const call = () => bridge.createTransactionFromOffer({ offerId: rO, brokerageId: rB, contractDate: "2026-11-20", compliancePassedAt: T0, contractTerms: {} }).then((r: any) => ({ ok: true, r }), (e: any) => ({ ok: false, e: String(e?.message ?? e) }))
    resetCalls(); G.__P.mem = offerWorld()
    const [a, b]: any[] = await quiet(() => Promise.all([call(), call()]))
    const rows = T(G.__P.mem, "transactions")
    pos("an executed, consistent offer becomes a purchase transaction at the SIGNED price", rows[0]?.purchase_price === 500000 && rows[0]?.offer_id === rO, rows[0])
    neg("two racing webhook deliveries create exactly ONE transaction", rows.length === 1, { rows: rows.length })
    neg("…both deliveries resolve to the SAME transaction id (the loser reads the winner back as a replay)", a?.ok && b?.ok && a.r?.transactionId === b.r?.transactionId, { a, b })
    resetCalls(); G.__P.mem = offerWorld({ offer: { offer_price: 525000 } })
    const held: any = await quiet(call)
    neg("a price the executed contract contradicts creates NO transaction and the refusal names the term", !held.ok && /price/i.test(held.e ?? "") && T(G.__P.mem, "transactions").length === 0, held)
    resetCalls(); G.__P.mem = offerWorld({ docs: [contractDoc(), contractDoc({ id: rUADD, classification: "addendum", signature_completeness: { signatures: [{ signer_role: "buyer", signed: true }], initials: [] } }, { price: 520000, earnest_money_amount: null, closing_date: null, property_address: null })] })
    const ua: any = await quiet(call)
    neg("an UNSIGNED addendum's price never governs: the deal is built at the signed 500000, not 520000", ua.ok && T(G.__P.mem, "transactions")[0]?.purchase_price === 500000, { ua, price: T(G.__P.mem, "transactions")[0]?.purchase_price })
    resetCalls(); G.__P.mem = offerWorld({ docs: [contractDoc({ scan_error: "OCR failed" })] })
    const ocr: any = await quiet(call)
    neg("an executed contract nobody could read is a HOLD, never a transaction", !ocr.ok && T(G.__P.mem, "transactions").length === 0, ocr)
  },
})

// ═══ child / parent ═══════════════════════════════════════════════════════════════════════════════════════════════════════
async function child(id: string) {
  const c = CANARIES.find((x) => x.id === id)
  if (!c) { console.error(`unknown canary ${id}`); process.exit(2) }
  R.id = id
  installSeams(c.seams())
  console.log(`\n═══ ${c.id} · ${c.title}`)
  console.log(`    failure that must be caught: ${c.failure}`)
  try { await c.run() } catch (e) { R.crashed = String((e as Error)?.stack ?? e).slice(0, 600); check("LOAD", `${id} ran to the end (threw)`, false, R.crashed) }
  console.log(`@@P156 ${JSON.stringify(R)}`)
  process.exit(0)
}

function parent() {
  const only = (process.env.WAVE156P_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean)
  const list = CANARIES.filter((c) => !only.length || only.includes(c.id))
  const TSX = join(WT, "node_modules/.bin/tsx")
  console.log(`wave156-canaries — the cross-lane canaries, SIMULATED in memory (modules from ${ROOT === WT ? "this tree" : ROOT})`)
  const results: Res[] = []
  for (const c of list) {
    const p = spawnSync(TSX, [SELF, "--one", c.id], { cwd: WT, env: process.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 300_000 })
    const out = `${p.stdout ?? ""}`
    const line = out.split("\n").find((l) => l.startsWith("@@P156 "))
    process.stdout.write(out.split("\n").filter((l) => !l.startsWith("@@P156 ")).join("\n"))
    if (line) results.push(JSON.parse(line.slice(7)))
    else {
      console.log(`  ✗ LOAD ${c.id} produced no result (exit ${p.status}${p.signal ? `, ${p.signal}` : ""}) ${String(p.stderr ?? "").slice(-600)}`)
      results.push({ ...JSON.parse(JSON.stringify(R)), id: c.id, fail: 1, crashed: "no result", failed: [{ kind: "LOAD", name: "child produced no result" }] })
    }
  }
  // ── verdicts ──
  const verdict = (r: Res) => r.fail === 0 && r.byKind.POS.pass > 0 && r.byKind.NEG.pass > 0
  const red = (r: Res) => {
    if (verdict(r)) return "pass"
    const loadFail = r.failed.some((f) => f.kind === "LOAD")
    const negFail = r.failed.some((f) => f.kind === "NEG")
    if (negFail && !r.failed.every((f) => f.kind === "LOAD")) return loadFail ? "RED · DEFECT CAUGHT (+ some doors absent)" : "RED · DEFECT CAUGHT"
    if (loadFail) return "RED · ABSENT (door not in this tree)"
    return "RED · " + (r.byKind.POS.pass === 0 ? "no positive ran" : r.byKind.NEG.pass === 0 ? "no negative ran" : "outcome not reached")
  }
  console.log("\n═══ SUMMARY (SIMULATED — in-memory client, counted stubs, refusing fetch; nothing here is live) ═══")
  for (const r of results) {
    const c = CANARIES.find((x) => x.id === r.id)!
    console.log(`  ${verdict(r) ? "✓" : "✗"} ${r.id}  ${red(r).padEnd(44)} POS ${r.byKind.POS.pass}/${r.byKind.POS.pass + r.byKind.POS.fail} · NEG ${r.byKind.NEG.pass}/${r.byKind.NEG.pass + r.byKind.NEG.fail} · CTRL ${r.byKind.CTRL.pass}/${r.byKind.CTRL.pass + r.byKind.CTRL.fail} · SRC ${r.byKind.SRC.pass}/${r.byKind.SRC.pass + r.byKind.SRC.fail}  ${c.title.slice(0, 70)}`)
  }
  const shapes = ["solo", "team", "brokerage", "multi-office"]
  const mrows = results.filter((r) => r.matrix?.[r.id])
  if (mrows.length) {
    console.log("\n═══ SUBSCRIBER MATRIX (canary × shape → pass; '-' = shape not applicable to that canary; SIMULATED) ═══")
    console.log(`  ${"canary".padEnd(8)}${shapes.map((s) => s.padEnd(14)).join("")}`)
    for (const r of mrows) console.log(`  ${r.id.padEnd(8)}${shapes.map((s) => (r.matrix[r.id][s] === undefined ? "-" : r.matrix[r.id][s] ? "pass" : "FAIL").padEnd(14)).join("")}`)
  }
  const passedN = results.filter(verdict).length
  const checks = results.reduce((a, r) => a + r.pass, 0), failsN = results.reduce((a, r) => a + r.fail, 0)
  console.log(`\n RESULT: ${passedN} of ${results.length} canaries passed · ${checks} checks passed, ${failsN} failed (SIMULATED)`)
  console.log(` RESULT: ${checks} passed, ${failsN} failed`)
  process.exit(passedN === results.length && failsN === 0 ? 0 : 1)
}

const oneAt = process.argv.indexOf("--one")
if (oneAt > 0) void child(process.argv[oneAt + 1])
else parent()
