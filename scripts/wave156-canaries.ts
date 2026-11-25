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

// ── the forms directory (156C) world ─────────────────────────────────────────────────────────────────────────────────────
const fB = u("b", 11), fB2 = u("b", 12), fBSOLO = u("b", 13), fOFF_N = u("0", 1), fOFF_S = u("0", 2), fT1 = u("7", 1), fT2 = u("7", 2)
const fBROKER = u("a", 41), fAG_N = u("a", 42), fAG_S = u("a", 43), fCONTACT = u("a", 44), fVENDOR = u("a", 45), fLEAD = u("a", 46), fSOLO = u("a", 47), fTC = u("a", 48), fDEALAG = u("a", 49), fFOREIGN = u("a", 50)
const fAG_DEAL = u("e", 41), fTXN = u("d", 41), fOFFER = u("d", 42), fBUYER = u("c", 51), fSELLER = u("c", 52)
const FORMS_SEAMS: Record<string, string> = {
  "lib/agentic-os/connector-gateway.ts": "export const PROVIDER_HEALTH_POLICY = {}; export const deriveProviderHealth = () => 'healthy'; export const loadProviderHealth = async () => null; export const callConnector = async () => { globalThis.__P.count('gateway'); return { ok: false, status: 503, error: 'fixture' } }",
  "lib/integrations/resolve-esign-provider.ts": "export const resolveESignProviderForActor = async () => { const w = globalThis.__P; if (w.resolveError) throw new Error(w.resolveError); return { provider: w.provider, providerName: 'docusign', resolvedScope: 'brokerage', isDefault: false, credentials: { apiKey: 'x', profileId: 'p' }, accountId: null, credentialId: 'c' } }; export const resolveESignChoice = async () => ({ ok: false, error: 'stub' })",
  "lib/events/lifecycle-event-core.ts": "export const recordLifecycleEvent = async (svc, brokerageId, input) => { globalThis.__P.push('events', input); return { ok: true, eventId: 'e', deduped: false } }",
  "lib/kernel/manager-signals.ts": "export const SIGNAL_HANDLERS = {}; export const consumeManagerSignals = async () => []; export const publishManagerSignal = async (input) => { globalThis.__P.push('signals', input); return { ok: true, signalId: 's' } }",
  "lib/compliance/agent-readiness-gate.ts": "export const checkAgentTransactable = async () => ({ transactable: true, blockers: [], message: null })",
}
function formsWorld(): MemClient & { objects: Map<string, Uint8Array>; signed: Array<{ path: string; ttl: number }> } {
  const db = memSupabase({
    brokerages: [{ id: fB, name: "Test Realty", plan_tier: "brokerage" }, { id: fB2, name: "Other Realty", plan_tier: "brokerage" }, { id: fBSOLO, name: "Solo Agent Realty", plan_tier: "solo_agent" }],
    locations: [{ id: fOFF_N, brokerage_id: fB, name: "North Office" }, { id: fOFF_S, brokerage_id: fB, name: "South Office" }],
    teams: [{ id: fT1, brokerage_id: fB, name: "North Team", team_lead_id: fLEAD, deleted_at: null }, { id: fT2, brokerage_id: fB, name: "South Team", team_lead_id: null, deleted_at: null }],
    users: [
      { id: fBROKER, brokerage_id: fB, user_type: "broker", status: "active", deleted_at: null, platform_role: null, location_id: null },
      { id: fAG_N, brokerage_id: fB, user_type: "agent", status: "active", deleted_at: null, platform_role: null, location_id: fOFF_N, team_id: fT1 },
      { id: fAG_S, brokerage_id: fB, user_type: "agent", status: "active", deleted_at: null, platform_role: null, location_id: fOFF_S },
      { id: fCONTACT, brokerage_id: fB, user_type: "contact", status: "active", deleted_at: null, platform_role: null, location_id: null },
      { id: fVENDOR, brokerage_id: fB, user_type: "vendor", status: "active", deleted_at: null, platform_role: null, location_id: null },
      { id: fLEAD, brokerage_id: fB, user_type: "team_lead", status: "active", deleted_at: null, platform_role: null, location_id: null, team_id: fT1 },
      { id: fSOLO, brokerage_id: fBSOLO, user_type: "agent", status: "active", deleted_at: null, platform_role: null, location_id: null },
      { id: fTC, brokerage_id: fB, user_type: "tc", status: "active", deleted_at: null, platform_role: null, location_id: null },
      { id: fDEALAG, brokerage_id: fB, user_type: "agent", status: "active", deleted_at: null, platform_role: null, location_id: null, email: "dee@testrealty.example" },
      { id: fFOREIGN, brokerage_id: fB2, user_type: "broker", status: "active", deleted_at: null, platform_role: null, location_id: null },
    ],
    agents: [{ id: fAG_DEAL, user_id: fDEALAG, brokerage_id: fB, is_active: true, status: "active" }],
    team_members: [{ id: u("9", 301), team_id: fT1, user_id: fAG_N, brokerage_id: fB }],
    brokerage_form_library: [], form_packet_bundles: [], form_packet_bundle_items: [], user_role_assignments: [], agent_action_ledger: [],
  }, { uuidIds: true }) as any
  const objects = new Map<string, Uint8Array>(), signed: Array<{ path: string; ttl: number }> = []
  db.objects = objects; db.signed = signed
  db.storage = {
    from: (bucket: string) => ({
      upload: async (path: string, buf: Uint8Array) => (objects.has(`${bucket}/${path}`) ? { data: null, error: { message: "The resource already exists" } } : (objects.set(`${bucket}/${path}`, buf), { data: { path }, error: null })),
      remove: async (paths: string[]) => ({ data: paths.filter((p) => objects.delete(`${bucket}/${p}`)).map((name) => ({ name })), error: null }),
      createSignedUrl: async (path: string, ttl: number) => { signed.push({ path, ttl }); return { data: { signedUrl: `https://signed.example/${bucket}/${path}?expires_in=${ttl}` }, error: null } },
      list: async (prefix: string) => ({ data: [...objects.keys()].filter((k) => k.startsWith(`${bucket}/${prefix}/`) && !k.slice(`${bucket}/${prefix}/`.length).includes("/")).map((k) => ({ name: k.slice(`${bucket}/${prefix}/`.length), id: k })), error: null }),
      copy: async () => ({ data: null, error: { message: "not used" } }),
      download: async (path: string) => { const b = objects.get(`${bucket}/${path}`); return b ? { data: new Blob([b as any]), error: null } : { data: null, error: { message: "Object not found" } } },
    }),
  }
  return db
}
/** A provider with N forms that pages by an offset cursor (DocuSign's documented start_position shape). COUNTED. F007 unlicensed, F013 retired. */
function pagedProvider(n: number) {
  const forms = Array.from({ length: n }, (_, i) => {
    const k = i + 1, id = `F${String(k).padStart(3, "0")}`
    return { formId: id, name: `TX Residential Form ${id}`, issuer: "TXR", stateCode: "TX", category: (["offer", "listing", "addendum", "disclosure", "agency"] as const)[k % 5], version: "2025-01", licensed: k === 7 ? false : undefined, retired: k === 13 ? true : undefined, replacedByFormId: k === 13 ? "F014" : undefined }
  })
  const p = {
    calls: 0, forms,
    async listForms(req: { pageSize?: number; cursor?: string }) {
      p.calls++
      const size = req.pageSize ?? 100, start = Number(req.cursor ?? 0) || 0
      return { success: true, forms: forms.slice(start, start + size), total: forms.length, nextCursor: start + size < forms.length ? String(start + size) : null }
    },
  }
  return p
}
async function callRoute(mod: any, method: "GET" | "POST", url: string, body?: unknown): Promise<{ status: number; json: any }> {
  const init: RequestInit = { method }
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { "content-type": "application/json" } }
  const { NextRequest } = await import("next/server")
  const res: any = await quiet(() => mod[method](new NextRequest(url, init as any)))
  return { status: res.status, json: await res.json().catch(() => ({})) }
}
async function makePdf(fields: string[], marker = ""): Promise<Uint8Array> {
  const { PDFDocument } = await import("pdf-lib")
  const doc = await PDFDocument.create(); const page = doc.addPage(); const form = doc.getForm()
  fields.forEach((f, i) => form.createTextField(f).addToPage(page, { x: 20, y: 700 - i * 24, width: 200, height: 18 }))
  doc.setTitle(`specimen ${marker}`)
  return new Uint8Array(await doc.save())
}
const sha = async (b: Uint8Array) => (await import("node:crypto")).createHash("sha256").update(b).digest("hex")
const goodUpload = (bytes: Uint8Array, over: Record<string, unknown> = {}) => ({ mode: "upload", owner: {}, name: "TX Brokerage Listing Agreement", state: "TX", packetType: "listing", rightsBasis: "association_membership", licenseNote: "TXR member 2026", purpose: "listing", effectiveOn: "2026-01-01", revisionDate: "2025-12-01", checklistKeys: ["listing.agreement"], signerRoles: ["seller", "listing_agent"], fieldMapping: { "Seller Name": "seller.name" }, fileName: "la.pdf", bytes, ...over })

canary({
  id: "C04", title: "A brokerage packet plus 250 licensed provider forms are all discoverable by pagination, in ONE picker",
  failure: "the 101st form is hidden, or an unlicensed form / packet is silently available",
  seams: () => ({ replace: FORMS_SEAMS }),
  async run() {
    const route = await load("app/api/forms/provider-library/route.ts")
    if (!loaded(route, "app/api/forms/provider-library/route.ts", "GET")) return
    resetCalls(); G.__P.mem = formsWorld(); G.__P.seat = { id: fBROKER }; G.__P.resolveError = null
    const prov = pagedProvider(250); G.__P.provider = prov
    // The brokerage's OWN packet, added through the real intake door (156C) — it must sit in the same picker as the provider's 250.
    const tp = await load("lib/forms/tenant-form-packets.ts"), intake = await load("lib/forms/form-directory-intake.ts")
    let ownPacketId: string | null = null
    if (loaded(intake, "lib/forms/form-directory-intake.ts", "addFormToLibrary")) {
      const broker: any = await quiet(() => tp.resolvePacketActor(G.__P.mem, fBROKER))
      const added: any = await quiet(async () => intake.addFormToLibrary(G.__P.mem, broker.actor, goodUpload(await makePdf(["Seller Name"], "c04"))))
      ownPacketId = added?.ok ? added.packet.id : null
      pos("the brokerage adds its own licensed listing packet through the directory's upload door", !!ownPacketId, added)
    }
    const expected = prov.forms.filter((f) => f.licensed !== false && f.retired !== true).map((f) => f.formId)
    const got: string[] = []; const entries: any[] = []
    let cursor: string | null = null, first: any = null, rounds = 0
    do {
      const r = await callRoute(route, "GET", `http://x/api/forms/provider-library${cursor ? `?cursor=${cursor}` : ""}`)
      if (!first) first = r
      for (const f of r.json.forms ?? []) got.push(f.formId)
      entries.push(...(r.json.entries ?? []))
      cursor = r.json.nextCursor ?? null; rounds++
    } while (cursor && rounds < 20)
    pos(`every licensed, active provider form is discoverable by walking the cursor (${expected.length} expected; got ${new Set(got).size})`, expected.every((id) => got.includes(id)) && new Set(got).size === expected.length)
    neg("the 101st form (F101) and the FINAL form (F250) are NOT hidden behind a first page of 100", got.includes("F101") && got.includes("F250"), { n: got.length, last: got[got.length - 1] })
    pos("the response states the provider's real total (250) and the walk ends exhausted", first?.json?.total === 250 && first?.json?.exhausted === true && first?.json?.completeness === "complete", { total: first?.json?.total, exhausted: first?.json?.exhausted })
    neg("an UNLICENSED provider form (F007) is never listed; a RETIRED one (F013) is hidden", !got.includes("F007") && !got.includes("F013"))
    if (ownPacketId) pos("ONE picker: the brokerage's own packet is in `entries` beside the provider forms", entries.some((e) => e.packetId === ownPacketId || e.id === ownPacketId) && entries.some((e) => e.source === "connected_provider"), entries.slice(0, 3))
    const dir = await load("lib/forms/provider-form-directory.ts")
    if (loaded(dir, "lib/forms/provider-form-directory.ts", "findProviderFormById", "walkProviderLibrary")) {
      const f007: any = await dir.findProviderFormById(pagedProvider(250), "F007"), f250: any = await dir.findProviderFormById(pagedProvider(250), "F250")
      neg("selecting the unlicensed form by id is REFUSED (license_missing) — not silently available", f007?.ok === false && f007?.refusal?.code === "license_missing", f007)
      pos("selecting the final form by id works", f250?.ok === true)
      const silent: any = await dir.walkProviderLibrary({ async listForms(req: any) { return { success: true, forms: pagedProvider(250).forms.slice(0, req.pageSize ?? 100) } } }, {})
      ctrl("POSITIVE CONTROL: a provider that returns a full page with no cursor is labelled unknown_possibly_truncated, never complete", silent?.ok && silent.completeness === "unknown_possibly_truncated", silent?.completeness)
    }
    // An unlicensed tenant packet (license expired) is not usable by an agent (the packet half of "unlicensed packet silently available").
    if (ownPacketId) {
      const row = T(G.__P.mem, "brokerage_form_library").find((r) => r.id === ownPacketId)!
      const agN: any = await quiet(() => tp.resolvePacketActor(G.__P.mem, fAG_N))
      const before: any = await tp.usableTenantPacketPaths(G.__P.mem, agN.actor, [row.storage_path])
      row.license_expires_at = "2026-01-01"
      const after: any = await tp.usableTenantPacketPaths(G.__P.mem, agN.actor, [row.storage_path])
      neg("a brokerage packet whose license has EXPIRED is no longer usable (not silently available)", before?.usable?.size === 1 && after?.usable?.size === 0, { before: before?.usable?.size, after: after?.usable?.size })
    }
    G.__P.seat = { id: fCONTACT }
    const asContact = await callRoute(route, "GET", "http://x/api/forms/provider-library")
    G.__P.seat = { id: fVENDOR }
    const asVendor = await callRoute(route, "GET", "http://x/api/forms/provider-library")
    neg("a portal CONTACT and a VENDOR seat cannot browse the licensed library (403)", asContact.status === 403 && asVendor.status === 403, [asContact.status, asVendor.status])
    pos("the provider was PAGED (3 calls of 100 for 250), not sampled", prov.calls >= 3, prov.calls)
    // C29 cell: the multi-office agent sees its own office's applicability through the same route.
    G.__P.seat = { id: fAG_N }
    const asAgent = await callRoute(route, "GET", "http://x/api/forms/provider-library")
    cell("multi-office", asAgent.status === 200 && (asAgent.json.forms ?? []).length > 0)
    G.__P.seat = { id: fSOLO }
    const asSolo = await callRoute(route, "GET", "http://x/api/forms/provider-library")
    cell("solo", asSolo.status === 200 && (asSolo.json.forms ?? []).length > 0)
    cell("brokerage", first?.status === 200)
  },
})

canary({
  id: "C05", title: "An authorized TC adds a packet / addendum; e-sign watches the actual result; the final executed version is retained",
  failure: "a Contact / vendor overwrites the packet master, or an unsigned addendum governs the close",
  seams: () => ({ replace: FORMS_SEAMS }),
  async run() {
    const tp = await load("lib/forms/tenant-form-packets.ts"), intake = await load("lib/forms/form-directory-intake.ts"), bun = await load("lib/forms/form-packet-bundles.ts")
    const C = await load("lib/esign/addendum-signature-request.ts"), Tm = await load("lib/offers/governing-terms.ts"), route = await load("app/api/forms/directory/route.ts")
    if (!loaded(intake, "lib/forms/form-directory-intake.ts", "addFormToLibrary", "stageLibraryFormOnDeal") || !loaded(bun, "lib/forms/form-packet-bundles.ts", "createPacketBundle")
      || !loaded(C, "lib/esign/addendum-signature-request.ts", "proposeContractAddendumVersion", "requestAddendumSignatures", "syncAddendumSignatureRequest") || !loaded(Tm, "lib/offers/governing-terms.ts", "recordContractTermsVersion") || !loaded(route, "app/api/forms/directory/route.ts", "POST")) return
    resetCalls(); const db = formsWorld(); G.__P.mem = db
    db.tables.contacts = [{ id: fBUYER, brokerage_id: fB, first_name: "Bea", last_name: "Buyer", email: "bea.buyer@mail.example" }, { id: fSELLER, brokerage_id: fB, first_name: "Sam", last_name: "Seller", email: "sam.seller@mail.example" }]
    db.tables.offers = [{ id: fOFFER, brokerage_id: fB, agent_id: fAG_DEAL, contact_id: fBUYER, listing_id: null, parent_offer_id: null, offer_type: "standard", current_round: 1, status: "accepted", property_address: "12 Oak St", transaction_id: fTXN, metadata: {}, created_at: "2026-10-01T00:00:00Z" }]
    db.tables.transactions = [{ id: fTXN, brokerage_id: fB, agent_id: fAG_DEAL, buyer_agent_id: null, seller_agent_id: null, offer_id: fOFFER, buyer_contact_id: fBUYER, seller_contact_id: fSELLER, property_address: "12 Oak St", property_state: "TX", contract_date: "2026-10-01", contract_closing_date: "2026-12-01", stage: "under_contract" }]
    db.tables.transaction_participants = []
    db.tables.contract_term_versions = [{ id: u("9", 401), brokerage_id: fB, root_offer_id: fOFFER, transaction_id: fTXN, offer_id: fOFFER, document_id: null, version_no: 1, source: "offer", status: "executed", terms: { purchase_price: 500000, closing_date: "2026-12-01" }, executed_at: "2026-10-01T12:00:00Z", recorded_by: fDEALAG, evidence: {}, created_at: "2026-10-01T12:00:00Z" }]
    db.tables.documents = []; db.tables.signature_requests = []; db.tables.notifications = []; db.tables.document_field_extractions = []
    const A = async (id: string): Promise<any> => quiet(() => tp.resolvePacketActor(db, id))
    const broker = (await A(fBROKER)).actor
    const master: any = (await quiet(async () => intake.addFormToLibrary(db, broker, { mode: "upload", owner: {}, name: "TX Amendment to Contract", state: "TX", packetType: "transaction", rightsBasis: "association_membership", licenseNote: "TXR 2026", purpose: "addendum", effectiveOn: "2026-01-01", checklistKeys: ["contract.amendment"], signerRoles: ["buyer", "seller"], fileName: "amendment.pdf", bytes: await makePdf(["Closing Date", "Buyer Signature", "Seller Signature"], "amend") })) as any).packet
    const bundle: any = (await quiet(() => bun.createPacketBundle(db, broker, { kind: "closing", name: "TX Closing Packet", state: "TX" })) as any).bundle
    const masterRowBefore = JSON.stringify(T(db, "brokerage_form_library").find((r) => r.id === master?.id))
    const masterKey = `brokerage-forms/${master?.storage_path}`
    const masterSum = db.objects.get(masterKey) ? await sha(db.objects.get(masterKey)!) : "absent"
    const tc = await A(fTC)
    const fileDep = { file: async (svc: any, i: any) => { db.objects.set(`documents/${i.path}`, i.bytes); const id = globalThis.crypto.randomUUID(); svc.tables.documents.push({ id, brokerage_id: i.brokerageId, transaction_id: i.transactionId, storage_url: `https://x.supabase.co/storage/v1/object/sign/documents/${i.path}?token=t`, document_type: "addendum", metadata: { file_name: i.fileName, ...i.metadata }, signature_completeness: null }); return { ok: true, documentId: id } } }
    const staged: any = await quiet(() => intake.stageLibraryFormOnDeal(db, tc.actor, { packetId: master?.id, transactionId: fTXN }, fileDep))
    const doc = T(db, "documents").find((d) => d.id === staged?.documentId)
    pos("the authorized TC stages the directory addendum on the deal as a WORKING COPY recording the master id, version and checksum", staged?.ok && !!doc && doc.metadata.source_library_form_id === master.id && doc.metadata.source_checksum_sha256 === masterSum, staged)
    const agent = { userId: fDEALAG, brokerageId: fB, userType: "agent", teamId: null }
    const prop: any = await quiet(() => C.proposeContractAddendumVersion(db, agent, { ref: { transactionId: fTXN }, kind: "addendum", documentId: staged?.documentId, terms: { closing_date: "2026-12-20" }, effectiveOn: "2026-11-30", termEvidence: null }))
    const signers = new Map<string, Set<string>>(); let envSeq = 0
    const sb: any = {
      async getSignatureStatus() { return { success: true, total: 2, signed: 2, pending: 0, percentComplete: 100 } },
      async syncDocuments(req: any) { const s = signers.get(req.externalTransactionId) ?? new Set(); return { success: true, documents: [{ externalDocumentId: "d", documentName: "Amendment.pdf", folderName: "", isSigned: s.size >= 2, url: "https://provider.example/signed.pdf", signers: [{ name: "Bea Buyer", email: "bea.buyer@mail.example", role: "buyer", signedAt: s.has("bea.buyer@mail.example") ? "2026-11-25T10:00:00Z" : undefined }, { name: "Sam Seller", email: "sam.seller@mail.example", role: "seller", signedAt: s.has("sam.seller@mail.example") ? "2026-11-25T11:00:00Z" : undefined }] }] } },
      async voidTransaction() { return { success: true } },
    }
    const deps: any = {
      esignChoice: async () => ({ ok: true, kind: "api", providerName: "docusign" }), readiness: async () => ({ transactable: true, blockers: [], message: null }), documentUrl: async (_s: any, url: string) => url,
      dispatch: async () => { envSeq++; G.__P.count("esign_dispatch"); return { ok: true, status: "sent", envelopeId: `ENV-P-${envSeq}`, providerName: "docusign" } },
      provider: async () => sb, fetchBytes: async () => ({ ok: true, bytes: new TextEncoder().encode("%PDF signed amendment") }),
      storeSignedCopy: async (svc: any, i: any) => { const id = globalThis.crypto.randomUUID(); svc.tables.documents.push({ id, brokerage_id: i.brokerageId, transaction_id: i.transactionId, storage_url: "signed", metadata: { sha256: i.sha256 }, signature_completeness: null }); return { ok: true, documentId: id } },
      event: async () => ({}), signal: async () => ({ ok: true }),
    }
    const sent: any = prop?.ok ? await quiet(() => C.requestAddendumSignatures(db, agent, { versionId: prop.versionId, choices: { includeAttorneys: false } }, deps)) : prop
    pos("the deal's agent proposes the addendum ON the TC-staged document and the e-sign door sends ONE tracked request", prop?.ok && sent?.ok && T(db, "signature_requests").length === 1 && calls("esign_dispatch") === 1, sent)
    const rec = (svc: any, input: any) => Tm.recordContractTermsVersion(svc, input, { consequenceDeps: { runClosingCompliance: async () => ({ ran: true, openBlocking: 0, reason: null }) } })
    const unsigned: any = await quiet(() => C.syncAddendumSignatureRequest(db, { brokerageId: fB, requestId: sent?.requestId, source: "cron" }, { ...deps, recordExecuted: rec }))
    neg("while UNSIGNED the addendum does not govern — the e-sign watch records no executed addendum version", T(db, "contract_term_versions").filter((v) => v.status === "executed" && v.source === "addendum").length === 0 && !unsigned?.executed)
    if (typeof Tm.governingContractTerms === "function") {
      const gov: any = await quiet(() => Tm.governingContractTerms(db, fB, { transactionId: fTXN }))
      neg("…and the GOVERNING closing date is still the signed 2026-12-01, never the unsigned 2026-12-20", gov?.ok === true && gov.governing?.terms?.closing_date?.value === "2026-12-01", gov?.governing?.terms?.closing_date)
    }
    signers.set("ENV-P-1", new Set(["bea.buyer@mail.example", "sam.seller@mail.example"]))
    const done: any = await quiet(() => C.syncAddendumSignatureRequest(db, { brokerageId: fB, requestId: sent?.requestId, source: "webhook" }, { ...deps, recordExecuted: rec }))
    const again: any = await quiet(() => C.syncAddendumSignatureRequest(db, { brokerageId: fB, requestId: sent?.requestId, source: "cron" }, { ...deps, recordExecuted: rec }))
    const executed = T(db, "contract_term_versions").filter((v) => v.status === "executed" && v.source === "addendum")
    pos("SIGNED: the e-sign watch records the actual result — ONE executed version, retained with the signed copy", done?.ok && executed.length === 1 && !!executed[0].document_id && executed[0].document_id !== staged?.documentId, { done, n: executed.length })
    if (typeof Tm.governingContractTerms === "function") {
      const gov2: any = await quiet(() => Tm.governingContractTerms(db, fB, { transactionId: fTXN }))
      pos("…and once EXECUTED the addendum governs: the closing date is now 2026-12-20", gov2?.ok === true && gov2.governing?.terms?.closing_date?.value === "2026-12-20", gov2?.governing?.terms?.closing_date)
    }
    neg("a replay of the same webhook records nothing twice", !again?.executedNow && T(db, "contract_term_versions").filter((v) => v.status === "executed" && v.source === "addendum").length === 1)
    pos("the PACKET MASTER is unchanged (row and stored bytes, sha256)", JSON.stringify(T(db, "brokerage_form_library").find((r) => r.id === master?.id)) === masterRowBefore && !!db.objects.get(masterKey) && (await sha(db.objects.get(masterKey)!)) === masterSum)
    const libBefore = JSON.stringify(T(db, "brokerage_form_library")), itemsBefore = T(db, "form_packet_bundle_items").length, docsBefore = T(db, "documents").length
    const tries: number[] = []
    for (const id of [fCONTACT, fVENDOR]) {
      G.__P.seat = { id }
      tries.push((await callRoute(route, "POST", "http://x/api/forms/directory", { action: "add_bundle_item", bundle_id: bundle?.id, library_form_id: master?.id, required_name: "Amendment", is_required: false, requirement_source: "user_supplemental" })).status)
      tries.push((await callRoute(route, "POST", "http://x/api/forms/directory", { action: "retire_form", packet_id: master?.id })).status)
      tries.push((await callRoute(route, "POST", "http://x/api/forms/directory", { action: "stage_on_deal", packet_id: master?.id, transaction_id: fTXN })).status)
    }
    neg("a CONTACT and a VENDOR seat can neither retire / overwrite the master, add to the bundle, nor stage it (403 each; nothing changed)", tries.length === 6 && tries.every((s) => s === 403) && JSON.stringify(T(db, "brokerage_form_library")) === libBefore && T(db, "form_packet_bundle_items").length === itemsBefore && T(db, "documents").length === docsBefore, tries)
    G.__P.seat = { id: fTC }
    const tcAdd = await callRoute(route, "POST", "http://x/api/forms/directory", { action: "stage_on_deal", packet_id: master?.id, transaction_id: fTXN })
    ctrl("POSITIVE CONTROL: the same route admits the authorized TC (the 403s are the seat, not a broken route)", tcAdd.status === 200, tcAdd)
  },
})

canary({
  id: "C27", title: "Tenant / office / team role changes revoke SUBSEQUENT access to forms and storage",
  failure: "a pre-signed long-lived URL bypasses current authorization",
  seams: () => ({ replace: FORMS_SEAMS }),
  async run() {
    const tp = await load("lib/forms/tenant-form-packets.ts"), intake = await load("lib/forms/form-directory-intake.ts")
    if (!loaded(tp, "lib/forms/tenant-form-packets.ts", "resolvePacketActor", "issueTenantPacketUrl", "usableTenantPacketPaths", "FORM_PACKET_PREVIEW_TTL_SECONDS") || !loaded(intake, "lib/forms/form-directory-intake.ts", "addFormToLibrary")) return
    resetCalls(); const db = formsWorld(); G.__P.mem = db
    const A = async (id: string): Promise<any> => quiet(() => tp.resolvePacketActor(db, id))
    const broker = (await A(fBROKER)).actor
    const add = async (owner: Record<string, unknown>, name: string, marker: string) => ((await quiet(async () => intake.addFormToLibrary(db, broker, goodUpload(await makePdf([marker], marker), { owner, name, packetType: "disclosure", purpose: "disclosure" })))) as any)?.packet
    const wide = await add({}, "Brokerage Disclosure", "wide"), office = await add({ locationId: fOFF_N }, "North Office Disclosure", "north"), team = await add({ teamId: fT1 }, "North Team Disclosure", "team")
    pos("the brokerage registers a brokerage-wide, an OFFICE and a TEAM form through the directory", !!wide && !!office && !!team, { wide: !!wide, office: !!office, team: !!team })
    const agN = (await A(fAG_N)).actor
    const use = async (actor: any, row: any) => ((await tp.usableTenantPacketPaths(db, actor, [row?.storage_path])) as any)?.usable?.size === 1
    pos("the North-office, North-team agent may use all three", (await use(agN, wide)) && (await use(agN, office)) && (await use(agN, team)), agN)
    db.signed.length = 0
    const link: any = await tp.issueTenantPacketUrl(db, agN, T(db, "brokerage_form_library").find((r) => r.id === office?.id), "use")
    neg(`a packet link is minted PER VIEW with a short TTL (${tp.FORM_PACKET_PREVIEW_TTL_SECONDS}s ≤ 1 hour) — never a long-lived URL`, link?.ok && link.ttlSeconds === tp.FORM_PACKET_PREVIEW_TTL_SECONDS && tp.FORM_PACKET_PREVIEW_TTL_SECONDS <= 3600 && db.signed.length === 1 && db.signed[0].ttl <= 3600, link)
    neg("no signed URL is STORED on any library row (nothing for a revoked seat to replay)", T(db, "brokerage_form_library").every((r) => !/signed\.example|token=|expires_in/.test(JSON.stringify(r))))
    // OFFICE change: the agent moves to the South office → the North office form is refused on the NEXT request.
    T(db, "users").find((x) => x.id === fAG_N)!.location_id = fOFF_S
    const moved = (await A(fAG_N)).actor
    const linkAfterMove: any = await tp.issueTenantPacketUrl(db, moved, T(db, "brokerage_form_library").find((r) => r.id === office?.id), "use")
    neg("OFFICE change: after moving to South, the North office form is no longer usable and no new link is minted", !(await use(moved, office)) && linkAfterMove?.ok === false, linkAfterMove)
    ctrl("POSITIVE CONTROL: the brokerage-wide form is still usable after the move (the revocation is scoped, not blanket)", await use(moved, wide))
    // TEAM change: removed from the North team → the team form is refused.
    T(db, "users").find((x) => x.id === fAG_N)!.team_id = null; db.tables.team_members = []
    const noTeam = (await A(fAG_N)).actor
    neg("TEAM change: off the North team, the team form is no longer usable", !(await use(noTeam, team)), noTeam)
    // ROLE change: agent → contact → no actor at all.
    T(db, "users").find((x) => x.id === fAG_N)!.user_type = "contact"
    const asContact: any = await A(fAG_N)
    neg("ROLE change: an agent re-typed as a contact gets NO actor on the next request — no read, no link", asContact?.ok === false, asContact)
    // TENANT change: the seat moves to another brokerage → this brokerage's rows are refused.
    T(db, "users").find((x) => x.id === fAG_N)!.user_type = "agent"; T(db, "users").find((x) => x.id === fAG_N)!.brokerage_id = fB2
    const other = (await A(fAG_N)).actor
    const crossLink: any = await tp.issueTenantPacketUrl(db, other, T(db, "brokerage_form_library").find((r) => r.id === wide?.id), "use")
    neg("TENANT change: a seat now in another brokerage is refused this brokerage's packet (no link)", crossLink?.ok === false && !(await use(other, wide)), crossLink)
    src("the one minting door reads the CURRENT row and seat on every call (packetVisibleTo before createSignedUrl)", (() => { const s = code("lib/forms/tenant-form-packets.ts"); const i = s.indexOf("export async function issueTenantPacketUrl"); const b = s.slice(i, s.indexOf("\nexport ", i + 10)); return b.indexOf("packetVisibleTo(") > 0 && b.indexOf("packetVisibleTo(") < b.indexOf("createSignedUrl(") })())
    note("storage half: only the packet bucket's minting door is driven; the fraud-evidence 300 s view link (156J) and deal documents (document-links guard) are not re-driven here")
  },
})

// ── the closing (156D) world ─────────────────────────────────────────────────────────────────────────────────────────────
const dB = u("b", 21), dB2 = u("b", 22), dBROKER = u("a", 61), dAGENT = u("a", 62), dVENDOR = u("a", 63), dTC = u("a", 64), dX = u("a", 65), dCONTACT = u("a", 66), dLENDER = u("a", 67), dOFFDEAL = u("a", 68), dCO = u("a", 69)
const dAG = u("e", 61), dAGX = u("e", 62), dAGB = u("e", 63)
const dTX_GA = u("d", 61), dTX_NY = u("d", 62), dTX_NC = u("d", 63), dTX_CLOSED = u("d", 64), dTX_NEW = u("d", 65)
const dV_ATTY = u("f", 61), dV_LENDER = u("f", 63), dC1 = u("c", 61), dCDA = u("c", 62)
const D_SEAMS: Record<string, string> = {
  "lib/teams/team-scope.ts": "export async function leadsAgentsTeam(){ return { ok: true, leads: false, ledTeamId: null } }",
  "lib/transactions/cda-esign.ts": "export async function dispatchCdaSignerEsign(){ globalThis.__P.count('esign'); return { mode: 'in_app', provider: null, reason: 'fixture', dispatched: false } }",
}
function dWorld(): MemClient {
  return memSupabase({
    brokerages: [{ id: dB, offers_cda: true, non_cda_payout_default: null, plan_tier: "brokerage" }, { id: dB2 }],
    contacts: [{ id: dC1, brokerage_id: dB, agent_id: dAG, first_name: "Casey" }],
    users: [
      { id: dBROKER, brokerage_id: dB, user_type: "broker" }, { id: dAGENT, brokerage_id: dB, user_type: "agent" }, { id: dVENDOR, brokerage_id: dB, user_type: "vendor" }, { id: dTC, brokerage_id: dB, user_type: "tc" },
      { id: dX, brokerage_id: dB2, user_type: "broker" }, { id: dCONTACT, brokerage_id: dB, user_type: "contact" }, { id: dLENDER, brokerage_id: dB, user_type: "vendor" }, { id: dOFFDEAL, brokerage_id: dB, user_type: "agent" }, { id: dCO, brokerage_id: dB, user_type: "compliance_officer" },
    ],
    agents: [{ id: dAG, user_id: dAGENT, brokerage_id: dB }, { id: dAGX, user_id: dX, brokerage_id: dB2 }, { id: dAGB, user_id: dOFFDEAL, brokerage_id: dB }],
    transactions: [
      { id: dTX_GA, brokerage_id: dB, agent_id: dAG, contact_id: dC1, deleted_at: null, status: "under_contract", stage: "CLOSING_PREP", property_state: "GA", financing_type: "conventional", deal_type: "buyer", created_at: "2026-09-01T00:00:00Z" },
      { id: dTX_NY, brokerage_id: dB, agent_id: dAG, status: "under_contract", property_state: "NY", financing_type: "conventional", deal_type: "seller", created_at: "2026-09-01T00:00:00Z" },
      { id: dTX_NC, brokerage_id: dB, agent_id: dAG, status: "under_contract", property_state: "NC", financing_type: "conventional", deal_type: "buyer", created_at: "2026-09-01T00:00:00Z" },
      { id: dTX_CLOSED, brokerage_id: dB, agent_id: dAG, status: "closed", stage: "CLOSED", property_state: "NC", financing_type: "conventional", deal_type: "buyer", created_at: "2026-06-01T00:00:00Z" },
      { id: dTX_NEW, brokerage_id: dB, agent_id: dAG, status: "under_contract", property_state: "NC", financing_type: "cash", deal_type: "buyer", created_at: "2026-11-20T00:00:00Z" },
    ],
    vendors: [{ id: dV_ATTY, brokerage_id: dB, category: "attorney", name: "Peach Law LLC" }, { id: dV_LENDER, brokerage_id: dB, category: "lender", name: "First Mortgage" }],
    vendor_assignments: [
      { id: u("9", 61), vendor_id: dV_ATTY, transaction_id: dTX_GA, brokerage_id: dB, assignment_type: "other", status: "confirmed" },
      { id: u("9", 62), vendor_id: dV_LENDER, transaction_id: dTX_GA, brokerage_id: dB, assignment_type: "lender", status: "confirmed" },
    ],
    user_role_assignments: [{ id: u("8", 61), user_id: dVENDOR, vendor_id: dV_ATTY }, { id: u("8", 62), user_id: dLENDER, vendor_id: dV_LENDER }],
    transaction_participants: [], transaction_title_escrow: [{ id: u("c", 63), transaction_id: dTX_GA, brokerage_id: dB, title_company_name: "Peach Title" }],
    transaction_documents: [], transaction_tasks: [], transaction_timeline: [], agent_action_ledger: [], tenant_policy_versions: [],
    closing_disclosure_agreement: [{ id: dCDA, transaction_id: dTX_GA, brokerage_id: dB, agent_id: dAG, status: "approved", broker_approved_at: null, revision_number: 1, field_values: {}, generated_pdf_url: null }],
    documents: [], notifications: [], commission_distributions: [], agent_commissions: [], commission_adjustments: [], trid_disclosure_receipts: [], contract_term_versions: [],
    offers: [], document_field_extractions: [], transaction_coordinators: [], transaction_milestones: [], contact_memory: [], tasks: [], closing_disclosure_agreement_revisions: [], transaction_vendor_services: [],
    brokerage_settings: [], trid_timeline: [], transaction_compliance_log: [], teams: [], lifecycle_events: [], policy_decisions: [], transaction_lenders: [], knowledge_articles: [],
  }, { uuidIds: true })
}
const party = (id: string, x: Record<string, unknown>) => ({ id, name: String(x.name ?? id), ...x })

canary({
  id: "C06", title: "Georgia / North Carolina attorney settlement uses the SOURCED jurisdiction policy reference",
  failure: "code always requires a generic title-company seat",
  seams: () => ({ replace: D_SEAMS }),
  async run() {
    const cp = await load("lib/transactions/closing-parties.ts")
    if (!loaded(cp, "lib/transactions/closing-parties.ts", "assessClosingTeam", "closingDocumentOwner")) return
    const base = (o: Record<string, unknown>) => ({ stateCode: "GA", financingType: "conventional", dealType: "buyer", participants: [], settlement: null, ...o })
    const gaAtty = cp.assessClosingTeam(base({ participants: [party("a1", { party_role: "settlement_attorney", name: "Peach Law", represents: "neutral_settlement_agent" })], settlement: { kind: "attorney", participantId: "a1", basis: "contract_named" } }))
    pos("GA: an ATTORNEY settlement agent completes the closing team — no title-company finding, no gap", !gaAtty.findings.some((f: any) => f.key === "state_requires_attorney_closing" || String(f.key).startsWith("state_gap")), gaAtty.findings)
    neg("GA: nothing demands a title-company SEAT when an attorney conducts the closing", !gaAtty.findings.some((f: any) => /title/.test(String(f.key)) && f.severity !== "info") && !JSON.stringify(gaAtty).includes("title_company_required"), gaAtty.findings.map((f: any) => f.key))
    const gaTitle = cp.assessClosingTeam(base({ participants: [party("t1", { party_role: "title_company", name: "Peach Title" })], settlement: { kind: "title_company", participantId: "t1", basis: "contract_named" } }))
    const gaF = gaTitle.findings.find((f: any) => f.key === "state_requires_attorney_closing")
    pos("GA: a title-company settlement agent is routed to a human with the GEORGIA source cited (gabar.org)", !!gaF && gaF.severity === "needs_human" && /gabar\.org/.test(gaF.source?.url ?? ""), gaF)
    const nc = cp.assessClosingTeam(base({ stateCode: "NC", participants: [party("t1", { party_role: "title_company" })], settlement: { kind: "title_company", participantId: "t1", basis: "party_confirmed" } }))
    pos("NC: the same rule reads North Carolina's own source (ncbar.gov opinion)", nc.findings.some((f: any) => f.key === "state_requires_attorney_closing" && /ncbar\.gov/.test(f.source?.url ?? "")))
    const tx = cp.assessClosingTeam(base({ stateCode: "TX" }))
    neg("an unsupported state ASKS a human and invents no requirement (no hardcoded 50-state answer)", tx.state?.status === "unsupported" && !tx.findings.some((f: any) => String(f.key).startsWith("state_gap")), tx.state)
    const states = await load("lib/state-forms/closing-participants.ts")
    src("the GA / NC answers come FROM the sourced state table (lib/state-forms/closing-participants.ts), not restated", !states.__loadError && /closing-participants/.test(code("lib/transactions/closing-parties.ts")))
    // The door: recording a title company as settlement agent on a GA deal opens a counsel-review task (driven through the desk).
    const act = await load("app/actions/transactions.ts")
    if (loaded(act, "app/actions/transactions.ts", "recordClosingPartyAction", "setSettlementAgentAction")) {
      G.__P.mem = dWorld(); G.__P.seat = { id: dBROKER }
      const t: any = await quiet(() => act.recordClosingPartyAction({ transaction_id: dTX_GA, party_role: "title_company", name: "Peach Title" }))
      const pid = T(G.__P.mem, "transaction_participants").find((p) => p.name === "Peach Title")?.id
      const s: any = await quiet(() => act.setSettlementAgentAction(dTX_GA, { kind: "title_company", participantId: pid, basis: "contract_named" }))
      pos("driven: a title-company settlement agent on the GA deal is SAVED and opens a high-priority counsel-review task with the source", t?.success && s?.success && T(G.__P.mem, "transaction_tasks").some((k) => /counsel|attorney/i.test(`${k.title} ${k.description}`) && /gabar|Georgia/i.test(`${k.description}`)), { t, s, tasks: T(G.__P.mem, "transaction_tasks").map((k) => k.title) })
    }
  },
})

canary({
  id: "C07", title: "Different buyer / seller closing attorneys, and the outside (off-platform) vendor is confirmed by the deal's agent",
  failure: "one attorney role is assumed to represent every party",
  seams: () => ({ replace: D_SEAMS }),
  async run() {
    const cp = await load("lib/transactions/closing-parties.ts"), act = await load("app/actions/transactions.ts")
    if (!loaded(cp, "lib/transactions/closing-parties.ts", "assessClosingTeam", "decideClosingPartyDraft", "PARTY_REPRESENTS")) return
    const base = (o: Record<string, unknown>) => ({ stateCode: "NY", financingType: "conventional", dealType: "buyer", participants: [], settlement: null, ...o })
    const both = cp.assessClosingTeam(base({ participants: [party("b", { party_role: "buyer_attorney" }), party("s", { party_role: "seller_attorney" })] }))
    const rep = Object.fromEntries(both.parties.map((p: any) => [p.id, p.represents]))
    pos("NY: a buyer's attorney and a seller's attorney are two distinct counsel, each representing its own side", rep.b === "buyer" && rep.s === "seller" && !both.findings.some((f: any) => String(f.key).startsWith("state_gap")), rep)
    const one = cp.assessClosingTeam(base({ participants: [party("a", { party_role: "settlement_attorney" })] }))
    neg("NY: ONE side-less attorney does not satisfy both sides — both gaps stay open (never everyone's lawyer)", ["buyer_closing_attorney", "seller_closing_attorney"].every((r) => one.findings.some((f: any) => f.key === `state_gap:${r}`)), one.findings.map((f: any) => f.key))
    neg("no representation value means 'all parties'", Array.isArray(cp.PARTY_REPRESENTS) && !cp.PARTY_REPRESENTS.some((v: string) => /all|both|every/i.test(v)), cp.PARTY_REPRESENTS)
    neg("a buyer's attorney cannot be recorded as representing the seller", cp.decideClosingPartyDraft({ partyRole: "buyer_attorney", represents: "seller", name: "Jane Counsel" }).ok === false)
    ctrl("POSITIVE CONTROL: a side-specific role states its own side", (() => { const d = cp.decideClosingPartyDraft({ partyRole: "seller_attorney", represents: null, name: "Sam Counsel" }); return d.ok && d.represents === "seller" })())
    if (!loaded(act, "app/actions/transactions.ts", "recordClosingPartyAction", "confirmClosingPartyFactAction")) return
    G.__P.mem = dWorld(); G.__P.seat = { id: dBROKER }
    const vendorsBefore = T(G.__P.mem, "vendors").length, usersBefore = T(G.__P.mem, "users").length
    const off: any = await quiet(() => act.recordClosingPartyAction({ transaction_id: dTX_NY, party_role: "seller_attorney", name: "Off Platform Law PC", email: "closings@example.test" }))
    const row = T(G.__P.mem, "transaction_participants").find((p) => p.name === "Off Platform Law PC")
    const task = T(G.__P.mem, "transaction_tasks").find((t) => t.category === "closing_party_confirmation")
    pos("the OUTSIDE attorney is recorded on the deal (session tenant) and a confirmation task goes to the deal's agent", off?.success && row?.brokerage_id === dB && task?.assigned_user_id === dAGENT && task?.responsible_participant_id === row?.id && row?.represents === "seller", { off, task })
    neg("…NO vendor, user or seat is created for an off-platform party", T(G.__P.mem, "vendors").length === vendorsBefore && T(G.__P.mem, "users").length === usersBefore)
    pos("…the record leaves a receipt in the action ledger", T(G.__P.mem, "agent_action_ledger").some((r) => r.action === "transaction.closing_party.record"))
    G.__P.seat = { id: dVENDOR }
    const v: any = await quiet(() => act.recordClosingPartyAction({ transaction_id: dTX_NY, party_role: "buyer_attorney", name: "Sneaky" }))
    neg("a VENDOR seat is refused by the deal desk and writes nothing", v?.success === false && !T(G.__P.mem, "transaction_participants").some((p) => p.name === "Sneaky"), v)
  },
})

canary({
  id: "C08", title: "A lender-confirmed TRID receipt and a correctly changed final Closing Disclosure",
  failure: "an agent-created receipt masquerades as lender confirmation",
  seams: () => ({ replace: D_SEAMS }),
  async run() {
    const trid = await load("lib/compliance/trid-disclosure-clock-evidence.ts")
    if (!loaded(trid, "lib/compliance/trid-disclosure-clock-evidence.ts", "recordTridReceiptEvidence")) return
    const receipt = { brokerageId: dB, transactionId: dTX_GA, version: 1, issuerName: "First Mortgage", senderRole: "creditor", deliveryMethod: "email", receivedAt: "2026-11-18T15:00:00Z", receiptTimezone: "America/New_York", receiptEvidence: "lender_statement", lenderContactName: "Loan officer (by phone)", today: "2026-11-20" }
    G.__P.mem = dWorld()
    await quiet(() => trid.recordTridReceiptEvidence(G.__P.mem, { ...receipt, actor: { userId: dLENDER, kind: "lender", lenderVendorId: dV_LENDER } }))
    const l = T(G.__P.mem, "trid_disclosure_receipts")[0]
    pos("the ASSIGNED lender's receipt is lender-confirmed (source lender_portal)", l?.verification_status === "lender_confirmed" && l?.source === "lender_portal", l)
    G.__P.mem = dWorld()
    await quiet(() => trid.recordTridReceiptEvidence(G.__P.mem, { ...receipt, actor: { userId: dAGENT, kind: "agent" } }))
    const a = T(G.__P.mem, "trid_disclosure_receipts")[0]
    neg("an AGENT-reported receipt is recorded pending_lender_confirmation — never lender-confirmed", !!a && a.verification_status === "pending_lender_confirmation" && a.source === "agent_reported", a)
    G.__P.mem = dWorld()
    const w: any = await quiet(() => trid.recordTridReceiptEvidence(G.__P.mem, { ...receipt, newWaitDetermination: "no_new_wait", actor: { userId: dAGENT, kind: "agent" } }))
    neg("an agent cannot record the LENDER's waiting-period determination", w?.ok === false && T(G.__P.mem, "trid_disclosure_receipts").length === 0, w)
    const cp = await load("lib/transactions/closing-parties.ts")
    if (loaded(cp, "lib/transactions/closing-parties.ts", "closingDisclosureConsequence")) {
      const c = cp.closingDisclosureConsequence({ changedTerms: ["closing_cost_contribution"], financing: "financed" })
      pos("a changed closing credit requires a CORRECTED final CD reviewed by a human", c.correctedCdRequired === true && c.reviewBy === "human", c)
      neg("…the waiting period is NOT restarted automatically — the lender decides (12 CFR 1026.19(f)(2)(ii))", c.restartsWaitAutomatically === false && c.waitRestartDecidedBy === "lender", c)
      ctrl("POSITIVE CONTROL: a change with no settlement figure needs no corrected disclosure", !cp.closingDisclosureConsequence({ changedTerms: ["possession_terms"], financing: "financed" }).correctedCdRequired)
      pos("AI may compare and route, never issue or fabricate a Closing Disclosure", cp.CLOSING_STATEMENT_AI_RULE?.mayIssue === false && cp.CLOSING_STATEMENT_AI_RULE?.mayFabricate === false)
    }
  },
})

canary({
  id: "C09", title: "A no-CDA closing passes the right broker compliance; opting into the CDA applies by EFFECTIVE policy",
  failure: "an old closed deal is blocked, or a dummy CDA is inserted",
  seams: () => ({ replace: D_SEAMS }),
  async run() {
    const pol = await load("lib/transactions/cda-closing-policy.ts")
    if (!loaded(pol, "lib/transactions/cda-closing-policy.ts", "loadEffectiveCdaModes", "decideDealCdaSwitch", "noCdaClosingProof", "resolveCdaMode")) return
    const m = dWorld(); G.__P.mem = m
    m.tables.tenant_policy_versions.push({ id: u("7", 61), brokerage_id: dB, policy_key: "cda_policy", version: 1, value: { offers_cda: true, non_cda_payout_default: null, effective_at: "2026-11-01T00:00:00Z", scope: "brokerage" }, previous: { offers_cda: false, non_cda_payout_default: "direct_deposit", effective_at: null, scope: "brokerage" }, created_at: "2026-11-01T00:00:00Z" })
    const cdaBefore = T(m, "closing_disclosure_agreement").length
    const eff: any = await quiet(() => pol.loadEffectiveCdaModes(m, { brokerageId: dB, transactionIds: [dTX_CLOSED, dTX_NEW] }))
    pos("opting INTO the CDA is prospective: a deal opened after the opt-in gets the CDA", eff?.ok && eff.deals?.[dTX_NEW]?.mode === "cda" && eff.current?.mode === "cda", eff?.deals)
    neg("…the deal CLOSED under no-CDA stays no-CDA (never retroactively blocked)", eff?.ok && eff.deals?.[dTX_CLOSED]?.mode === "no_cda", eff?.deals?.[dTX_CLOSED])
    const sw = pol.decideDealCdaSwitch({ effective: { mode: "no_cda" }, target: "cda", dealStatus: "closed", cdaRow: null, reason: "opted in to CDA this month" })
    neg("a closed deal accepts no CDA switch", sw.ok === false && sw.error === "deal_completed", sw)
    neg("no DUMMY CDA row is inserted by reading the policy (writes 0, CDA rows unchanged)", m.writes.length === 0 && T(m, "closing_disclosure_agreement").length === cdaBefore)
    const proof = pol.noCdaClosingProof({ cdaMode: pol.resolveCdaMode({ offersCda: false }), transaction: { status: "closed", compliance_passed_at: "2026-11-10T00:00:00Z" }, finalSettlement: { documentId: "doc-final", uploadedAt: "2026-11-10T00:00:00Z", uploadedBy: dTC, uploadedByType: "staff" }, commissions: [{ id: "c1", status: "paid", deposit_received_at: "2026-11-11T00:00:00Z", deposit_received_by: dBROKER, paid_at: "2026-11-12T00:00:00Z" }], openBlockingCompliance: 0, lifetimeHoldOpen: false })
    pos("a valid no-CDA close: final settlement + receipt + compliance are the proof; nothing missing; no CDA required", proof.mode === "no_cda" && proof.missing.length === 0 && proof.blocksClosing === false, proof.missing)
    const bad = pol.noCdaClosingProof({ cdaMode: pol.resolveCdaMode({ offersCda: false }), transaction: { status: "closed" }, finalSettlement: null, commissions: [], openBlockingCompliance: 1, lifetimeHoldOpen: false })
    ctrl("POSITIVE CONTROL: a no-CDA close with no settlement and open compliance is NOT a complete proof", bad.missing.length > 0)
    pos("a CDA never blocks a close in either mode", pol.resolveCdaMode({ offersCda: true }).blocksClosing === false && pol.resolveCdaMode({ offersCda: false }).blocksClosing === false)
  },
})

canary({
  id: "C30", title: "A consumer question gets the correct portal help, or an agent / vendor task, plus education",
  failure: "an unknown closing attorney / lender fact is fabricated by the model",
  seams: () => ({ replace: D_SEAMS }),
  async run() {
    const qad = await load("lib/portal/question-answer-decision.ts")
    if (!loaded(qad, "lib/portal/question-answer-decision.ts", "decidePortalAnswer", "classifyPortalQuestion")) return
    let modelCalls = 0
    const ask = (question: string, draft = "Your lender is Fabricated Mortgage Company.") => quiet<any>(() => qad.decidePortalAnswer(G.__P.mem, { brokerageId: dB, contactId: dC1, question, agentName: "Avery", generalAnswer: async () => { modelCalls++; return draft } }, { knowledge: async () => [] }))
    const m = dWorld(); G.__P.mem = m
    m.tables.vendor_assignments = m.tables.vendor_assignments.filter((x) => x.vendor_id !== dV_LENDER)
    modelCalls = 0
    const lender = await ask("Who is our lender?").catch((e: Error) => ({ text: `threw ${e.message}` }))
    neg("'Who is our lender?' with nothing recorded: the model's invented name NEVER reaches the client", !/Fabricated/.test(lender.text ?? ""), { text: lender.text, modelCalls })
    neg("…and the model is not asked at all (0 calls) — the fact comes from the record or not at all", modelCalls === 0, modelCalls)
    pos("…the client is told it is not recorded and that their agent has been asked (a task is planned)", /not recorded/i.test(lender.text ?? "") && /Avery/.test(lender.text ?? "") && lender.plan?.createTask === true, lender)
    modelCalls = 0
    const atty = await ask("Who is my closing attorney?", "Your closing attorney is John Fabricated of Fabricated & Co, 555-0100.").catch((e: Error) => ({ text: `threw ${e.message}` }))
    neg("'Who is my closing attorney?' with nothing recorded: no invented name or phone", !/Fabricated|555-0100/.test(atty.text ?? "") && modelCalls === 0, { text: atty.text, modelCalls })
    if (typeof qad.fileQuestionDing === "function") {
      const ding: any = await quiet(() => qad.fileQuestionDing(G.__P.mem, { brokerageId: dB, contactId: dC1, sessionId: null, agentId: dAG, question: "Who is our lender?", decision: lender, surface: "portal_tutor" }))
      pos("the ding files ONE task for the agent (the promise 'your agent has been asked' is true)", ding?.filed === true && T(G.__P.mem, "tasks").length === 1, ding)
    }
    m.tables.transaction_participants.push({ id: u("4", 62), transaction_id: dTX_GA, brokerage_id: dB, name: "Peach Law LLC", party_role: "buyer_attorney", represents: "buyer", fact_source: "party_confirmed", fact_confirmed_at: "2026-11-20T10:00:00Z" })
    m.tables.vendor_assignments.push({ id: u("9", 69), vendor_id: dV_LENDER, transaction_id: dTX_GA, brokerage_id: dB, assignment_type: "lender", status: "confirmed" })
    modelCalls = 0
    const ok = await ask("Who is my closing attorney?"), okL = await ask("Who is our lender?")
    pos("a CONFIRMED attorney and an on-platform lender are stated FROM THE RECORD (with whom the attorney represents), still 0 model calls", /Peach Law LLC/.test(ok.text ?? "") && /buyer/.test(ok.text ?? "") && /First Mortgage/.test(okL.text ?? "") && modelCalls === 0, { a: ok.text, l: okL.text })
    ctrl("POSITIVE CONTROL: a general education question is still education (the fact rule is narrow)", qad.classifyPortalQuestion("What does a closing attorney do?").fact == null)
    // C29 portal cell — the same answer path for a contact of a solo agent's tenant (the record decides, not the shape).
    cell("brokerage", /Peach Law LLC/.test(ok.text ?? ""))
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
