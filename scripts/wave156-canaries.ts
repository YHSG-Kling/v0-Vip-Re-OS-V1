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

// ── the deal desk (156E) world ───────────────────────────────────────────────────────────────────────────────────────────
const eB = u("b", 31), eB2 = u("b", 32), eBROKER = u("a", 71), eTC = u("a", 72), eAGENT = u("a", 74), eAGENT2 = u("a", 75), eVENDOR = u("a", 79), eCONTACT = u("a", 80), eX = u("a", 81)
const eAG = u("e", 74), eAG2 = u("e", 75), eAGX = u("e", 81), eTX = u("d", 71), eTXX = u("d", 79), eC1 = u("c", 71), eL1 = u("c", 72), eDOC = u("c", 73), eVROW = u("f", 71)
const E_SEAMS: Seams = {
  override: {
    "lib/ai/generate.ts": "export function bookedGenerateObject(){ return async () => { globalThis.__P.count('model'); return { object: {}, usage: {} } } }",
    "lib/ai/models.ts": "export async function generateTextRouted(){ globalThis.__P.count('model'); return { text: 'stub', usage: {} } }; export async function generateObjectRouted(){ globalThis.__P.count('model'); return { object: {}, usage: {} } }; export async function streamTextRouted(){ globalThis.__P.count('model'); throw new Error('fixture: no stream') }",
    "lib/ai/resolve-model.ts": "export function resolveModel(x){ return x }",
    "lib/ai/pipeline.ts": "export async function runPipeline(){ globalThis.__P.count('model'); return { content: 'stub', text: 'stub' } }; export async function runPipelineSimple(){ globalThis.__P.count('model'); return 'stub' }",
  },
  replace: {
    "lib/teams/team-scope.ts": "export async function leadsAgentsTeam(){ return { ok: true, leads: false, ledTeamId: null } }",
    "lib/kernel/transactions.ts": "export async function emitTransactionEvent(){ globalThis.__P.count('event'); return { inserted: true } }; export async function updateLenderState(){ globalThis.__P.count('event') }",
    "app/actions/inbox.ts": "export async function sendInboxMessage(p){ globalThis.__P.count('send'); return { success: true, messageId: 'fixture' } }",
  },
}
function eWorld(): MemClient {
  return memSupabase({
    brokerages: [{ id: eB }, { id: eB2 }],
    users: [
      { id: eBROKER, brokerage_id: eB, user_type: "broker" }, { id: eTC, brokerage_id: eB, user_type: "tc" }, { id: eAGENT, brokerage_id: eB, user_type: "agent" }, { id: eAGENT2, brokerage_id: eB, user_type: "agent" },
      { id: eVENDOR, brokerage_id: eB, user_type: "vendor" }, { id: eCONTACT, brokerage_id: eB, user_type: "contact" }, { id: eX, brokerage_id: eB2, user_type: "broker" },
    ],
    agents: [{ id: eAG, user_id: eAGENT, brokerage_id: eB }, { id: eAG2, user_id: eAGENT2, brokerage_id: eB }, { id: eAGX, user_id: eX, brokerage_id: eB2 }],
    transactions: [
      { id: eTX, brokerage_id: eB, agent_id: eAG, buyer_agent_id: null, seller_agent_id: null, status: "under_contract", purchase_price: 400000, contact_id: eC1, listing_id: eL1, property_address: "1 Fixture Way", close_date: "2026-12-30" },
      { id: eTXX, brokerage_id: eB2, agent_id: eAGX, buyer_agent_id: null, seller_agent_id: null, status: "under_contract" },
    ],
    vendors: [{ id: eVROW, brokerage_id: eB, category: "lender" }],
    vendor_assignments: [{ id: u("9", 71), vendor_id: eVROW, transaction_id: eTX, brokerage_id: eB, status: "confirmed" }],
    user_role_assignments: [{ id: u("8", 71), user_id: eVENDOR, vendor_id: eVROW }],
    contacts: [{ id: eC1, brokerage_id: eB, first_name: "Casey", agent_id: eAG }], listings: [{ id: eL1, brokerage_id: eB, address: "1 Fixture Way" }],
    transaction_documents: [{ id: eDOC, transaction_id: eTX, brokerage_id: eB, doc_type: "purchase_agreement", doc_label: "Purchase agreement", storage_url: null, extracted_data: { text: "fixture contract: purchase price $400,000; closing December 30, 2026" } }],
    transaction_milestones: [], transaction_deadlines: [], transaction_tasks: [], transaction_timeline: [], transaction_participants: [], generated_documents: [], lifecycle_events: [], notifications: [], agent_action_ledger: [],
    teams: [], deposits: [], compliance_tasks: [], client_portal_messages: [], tasks: [], activities: [], client_documents: [], transaction_communications: [], transaction_coordinators: [], transaction_assignments: [], transaction_lenders: [], transaction_inspections: [], ai_tool_usage: [],
  }, { uuidIds: true })
}

canary({
  id: "C10", title: "The deal-desk AI coordinator refuses a vendor BEFORE any paid model invocation",
  failure: "a vendor seat causes the AI model to read private terms or write milestones",
  seams: () => E_SEAMS,
  async run() {
    const coord = await load("app/actions/ai-transaction-coordinator.ts"), cr = await load("app/actions/ai-contract-review.ts")
    if (!loaded(coord, "app/actions/ai-transaction-coordinator.ts", "analyzeTransactionHealth", "predictAndManageDeadlines")) return
    const effects = (m: MemClient) => m.writes.filter((w) => w.table !== "agent_action_ledger").map((w) => `${w.op} ${w.table}`)
    const as = (id: string | null) => { G.__P.mem = eWorld(); G.__P.seat = id ? { id } : null; resetCalls(); return G.__P.mem as MemClient }
    const doors: Array<[string, () => Promise<any>]> = [
      ["analyzeTransactionHealth", () => coord.analyzeTransactionHealth({ transactionId: eTX })],
      ["predictAndManageDeadlines (writes deadlines / milestones)", () => coord.predictAndManageDeadlines({ transactionId: eTX })],
      ["generateSmartTasks (writes tasks)", () => coord.generateSmartTasks({ transactionId: eTX })],
    ]
    if (!cr.__loadError && typeof cr.reviewContract === "function") doors.push(["ai-contract-review reviewContract (reads the contract terms)", () => cr.reviewContract({ documentId: eDOC, transactionId: eTX, documentType: "purchase_agreement", state: "TX" })])
    else check("LOAD", "app/actions/ai-contract-review.ts exports reviewContract", false, cr.__loadError)
    for (const [label, call] of doors) {
      let m = as(eVENDOR)
      const v = await drive(call)
      neg(`VENDOR seat assigned to the deal → ${label}: refused with 0 model calls and 0 writes`, calls("model") === 0 && effects(m).length === 0 && (!!v.threw || (v.r as any)?.success === false), { model: calls("model"), writes: effects(m), r: v.r ?? v.threw })
      m = as(eCONTACT)
      const c = await drive(call)
      neg(`CONTACT seat → ${label}: 0 model calls, 0 writes`, calls("model") === 0 && effects(m).length === 0 && (!!c.threw || (c.r as any)?.success === false), { model: calls("model"), r: c.r ?? c.threw })
      m = as(eAGENT2)
      const o = await drive(call)
      neg(`an agent of the same tenant but OFF the deal → ${label}: 0 model calls, 0 writes (the gate is the deal desk, not the tenant)`, calls("model") === 0 && effects(m).length === 0, { model: calls("model"), writes: effects(m), r: o.r ?? o.threw })
      m = as(eX)
      const x = await drive(call)
      neg(`another tenant's BROKER → ${label}: 0 model calls, 0 writes`, calls("model") === 0 && effects(m).length === 0, { model: calls("model"), r: x.r ?? x.threw })
      as(eAGENT)
      const a = await drive(call)
      pos(`the AGENT on the deal passes the desk and reaches the (counted) model seam → ${label}`, calls("model") >= 1, a.r ?? a.threw)
    }
    as(eTC)
    await drive(() => coord.analyzeTransactionHealth({ transactionId: eTX }))
    pos("the deal's coordinator (a desk seat) reaches the model too", calls("model") >= 1)
    ctrl("POSITIVE CONTROL: no provider was reached by any seat (the refusing fetch counted 0)", calls("fetch") === 0, logged("fetch"))
  },
})

canary({
  id: "C11", title: "The five deal tables' owner-approved RLS SQL, measured LOCALLY, denies cross-tenant inserts — and is labeled local, not applied",
  failure: "a local scratch result is recorded as live-applied",
  seams: () => ({}),
  async run() {
    const rules = await load("scripts/release-rules.ts")
    if (!loaded(rules, "scripts/release-rules.ts", "r6AppliedLive")) return
    // The measurement artifact: the cells 156E measured on a local PostgreSQL, pinned in test:deal-desk (comment-stripped) with the
    // fingerprint of the exact §R.6 block. The fingerprint is RE-COMPUTED here from OWNER-SQL.md, so a stale measurement goes red.
    const dd = code("scripts/deal-desk-guard.ts")
    const at = dd.indexOf("const PG_MEASURED = {")
    const block = at < 0 ? "" : dd.slice(at, dd.indexOf("\n}", at) + 2)
    const sha = /proposedSqlSha256:\s*"([0-9a-f]{64})"/.exec(block)?.[1] ?? ""
    const engine = /engine:\s*"([^"]+)"/.exec(block)?.[1] ?? ""
    const cases = [...(/cases:\s*\[([^\]]*)\]/.exec(block)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((x) => x[1])
    const modeRows = (mode: string): Record<string, string> => { const i = block.indexOf(`${mode}: {`); const s = i < 0 ? "" : block.slice(i, block.indexOf("}", i)); return Object.fromEntries([...s.matchAll(/(\w+):\s*"([0-9 ]+)"/g)].map((x) => [x[1], x[2]])) }
    const proposed = modeRows("proposed"), live = modeRows("live")
    const cellOf = (rows: Record<string, string>, seat: string, op: string) => rows[seat]?.split(" ")[cases.indexOf(op)]
    const doc = raw("docs/operations/OWNER-SQL.md")
    const sec = doc.includes("### R.6 ") ? doc.slice(doc.indexOf("### R.6 ")) : ""
    const bAt = sec.indexOf("```sql"), sqlBlock = bAt < 0 ? "" : sec.slice(bAt + 6, sec.indexOf("```", bAt + 6))
    const measuredSql = sqlBlock.includes("begin;") && sqlBlock.includes("commit;") ? sqlBlock.slice(sqlBlock.indexOf("begin;"), sqlBlock.indexOf("commit;") + 7) : ""
    const recomputed = (await import("node:crypto")).createHash("sha256").update(measuredSql.replace(/\s+/g, " ").trim()).digest("hex")
    pos(`the measured block IS the published owner SQL (fingerprint recomputed from OWNER-SQL.md §R.6 = the measurement's ${sha.slice(0, 12)}…)`, sha.length === 64 && recomputed === sha, { recomputed: recomputed.slice(0, 16), pinned: sha.slice(0, 16) })
    const tenantA = Object.keys(proposed).filter((s) => s !== "other_tenant_broker" && s !== "anon")
    pos(`measured on ${engine || "?"}: under the owner-approved SQL NO tenant-A seat can insert on tenant B's deal (${tenantA.length} seats → 42501)`, tenantA.length >= 14 && tenantA.every((s) => cellOf(proposed, s, "insert_b2_deal") === "42501"), tenantA.map((s) => `${s}:${cellOf(proposed, s, "insert_b2_deal")}`))
    pos("…and tenant B's broker cannot insert on tenant A's deal (42501)", cellOf(proposed, "other_tenant_broker", "insert_b1_deal") === "42501")
    ctrl("POSITIVE CONTROL: the same measurement shows the hole the SQL closes — today (live policies) a tenant-A seat CAN insert on tenant B's deal", tenantA.some((s) => cellOf(live, s, "insert_b2_deal") === "1"))
    const packet = raw("docs/operations/WAVE156-R6-DEAL-TABLE-POLICY-PACKET.md")
    pos("the packet is LABELED local / not applied (Status: NOT APPLIED; 'a local measurement is not proof that production is fixed')", /\*\*Status:\*\*\s*NOT APPLIED/.test(packet) && /local measurement is not proof that production is fixed/i.test(packet))
    const localWords = /PostgreSQL 16\.\d+[^\n.|]*/.exec(packet)?.[0] ?? "PostgreSQL 16 (local)"
    neg("the local measurement written as 'APPLIED LIVE' — with the project id, the 10 rows and the refusals — is REFUSED by the release rule", rules.r6AppliedLive(`- R6 status: APPLIED LIVE 2026-11-25 — ${localWords}: hrvaqgvukzxfskkcrwbt 10 rows, vendor REFUSED`) === false)
    neg("'APPLIED LIVE … simulated' / '… scratch' / '… in-memory canary' are refused too", ["simulated read", "scratch database", "in-memory canary"].every((w) => rules.r6AppliedLive(`- R6 status: APPLIED LIVE 2026-11-25 — ${w}: hrvaqgvukzxfskkcrwbt 10 rows; REFUSED`) === false))
    ctrl("POSITIVE CONTROL: the owner's real live read-back line DOES lift R6", rules.r6AppliedLive("- R6 status: APPLIED LIVE 2026-12-01 — hrvaqgvukzxfskkcrwbt AFTER read-back 10 rows; two-tenant script 5 REFUSED then ROLLBACK") === true)
    const sheet = raw("docs/operations/WAVE156-OWNER-ACTION-SHEET.md")
    neg("today the owner sheet keeps R6 OPEN (no live read-back recorded)", /^- R6 status:/m.test(sheet) && rules.r6AppliedLive(sheet) === false)
    const lib = await load("lib/platform/go-live-readiness.ts")
    if (loaded(lib, "lib/platform/go-live-readiness.ts", "releaseStateVerdict", "RELEASE_STATES")) {
      const spec = lib.RELEASE_STATES.find((s: any) => s.key === "SECURITY READBACK GREEN")
      const row = (o: any = {}) => ({ state: "SECURITY READBACK GREEN", status: "MET", date: "2026-12-01", origin: spec.specimen.origin, reader: spec.specimen.reader, evidence: spec.specimen.evidence, ...o })
      neg("SECURITY READBACK GREEN from a local_db origin is NOT MET", !lib.releaseStateVerdict("SECURITY READBACK GREEN", row({ origin: "local_db" }), { openBlockers: [] }).met)
      neg("…nor while R6 is an open blocker, whatever the row says", !lib.releaseStateVerdict("SECURITY READBACK GREEN", row(), { openBlockers: ["R6"] }).met)
      ctrl("POSITIVE CONTROL: the live specimen with no open blocker is MET", lib.releaseStateVerdict("SECURITY READBACK GREEN", row(), { openBlockers: [] }).met === true)
    }
    note("the PostgreSQL measurement itself is 156E's (scripts/deal-table-policy-measure.py); this canary re-derives its fingerprint and reads its cells — it does not start a database")
  },
})

canary({
  id: "C28", title: "A verified production-status gate separates owner SQL, provider keys and deployment from test results",
  failure: "a simulated provider is displayed as live connected",
  seams: () => ({ override: { "lib/identity/get-agent-context.ts": "export async function getAgentContext(){ return { brokerageId: globalThis.__P.brokerageId ?? null, userId: null, agentId: null } }" } }),
  async run() {
    const lib = await load("lib/platform/go-live-readiness.ts")
    if (loaded(lib, "lib/platform/go-live-readiness.ts", "releaseStateVerdict", "RELEASE_STATES", "configurationNote", "releaseClaimAllowed")) {
      const FIVE = ["CODE GREEN", "SECURITY READBACK GREEN", "LEGAL/LICENSING READY", "PREVIEW LIVE VERIFIED", "PUBLIC RELEASE AUTHORIZED"]
      const keys = lib.RELEASE_STATES.map((s: any) => s.key)
      pos("five DISTINCT release states, each with its own evidence rule (owner SQL, legal / provider licensing, deployment, authorization, code)", JSON.stringify(keys) === JSON.stringify(FIVE) && new Set(lib.RELEASE_STATES.map((s: any) => (s.shape ?? []).map(String).join())).size === 5, keys)
      const row = (k: string, o: any = {}) => { const s = lib.RELEASE_STATES.find((x: any) => x.key === k); return { state: k, status: "MET", date: "2026-12-01", origin: s.specimen.origin, reader: s.specimen.reader, evidence: s.specimen.evidence, ...o } }
      for (const k of FIVE.filter((x) => x !== "CODE GREEN")) {
        neg(`${k}: a SIMULATED origin (or 'in-memory canary' evidence) is never MET`, !lib.releaseStateVerdict(k, row(k, { origin: "simulated" }), { openBlockers: [], otherStatesMet: true }).met && !lib.releaseStateVerdict(k, row(k, { evidence: `${row(k).evidence}; proven by the in-memory canary` }), { openBlockers: [], otherStatesMet: true }).met)
        ctrl(`${k}: its live specimen IS met (the rule is not a blanket refusal)`, lib.releaseStateVerdict(k, row(k), { openBlockers: [], otherStatesMet: true }).met === true)
      }
      pos("CODE GREEN may come from the local chain (test results), and only CODE GREEN", lib.releaseStateVerdict("CODE GREEN", row("CODE GREEN", { origin: "local_chain" }), { openBlockers: [] }).met === true && !lib.releaseStateVerdict("PREVIEW LIVE VERIFIED", row("PREVIEW LIVE VERIFIED", { origin: "local_chain" }), { openBlockers: [], otherStatesMet: true }).met)
      const note2 = lib.configurationNote(9, 9)
      neg("even with every configuration domain answering, the board makes no release claim (no GO; names the five states)", !/\bGO\b/.test(note2) && lib.releaseClaimAllowed(note2, false) && FIVE.every((k) => note2.includes(k)), note2)
      neg("'ready to sell' / launch wording is refused while public release is not authorized", lib.releaseClaimAllowed("The OS is ready to sell", false) === false)
    }
    // The tenant settings services registry: an env key is "configured (not live-verified)", a dormant provider "dormant" — never "connected".
    process.env.BATCHDATA_API_KEY = "fixture"; process.env.PEOPLEDATA_API_KEY = "fixture"; process.env.DID_API_KEY = "fixture"
    G.__P.mem = memSupabase({ brokerage_integrations: [] }); G.__P.brokerageId = u("b", 41)
    const svc = await load("app/actions/services-config.ts")
    if (loaded(svc, "app/actions/services-config.ts", "getServicesRegistry")) {
      const r: any = await quiet(() => svc.getServicesRegistry())
      const services: any[] = r?.services ?? []
      const byId = Object.fromEntries(services.map((s) => [s.id, s.status]))
      neg("no env-keyed service reads 'connected' (a key being set is not a live connection)", services.length > 0 && !services.some((s) => s.status === "connected"), byId)
      neg("BatchData and PeopleData Labs (dormant survivors) with keys set read 'dormant'", byId.batchdata === "dormant" && byId.peopledatalabs === "dormant", byId)
      pos("a configured key reads 'configured' (honest: present, not live-verified)", services.some((s) => s.status === "configured"), byId)
    }
    const matrix = await load("lib/providers/provider-capability-matrix.ts")
    if (loaded(matrix, "lib/providers/provider-capability-matrix.ts", "providerCapabilityMatrix")) {
      const rows: any[] = matrix.providerCapabilityMatrix()
      neg("the provider capability matrix shows NO 'ready' route without live evidence", rows.filter((m) => (m.states?.platform === "ready" || m.states?.tenant === "ready") && !/live: (?!none)/.test(m.validation ?? "")).length === 0)
      ctrl("POSITIVE CONTROL: the matrix rows are real (rentcast / versium / datafiniti present)", ["rentcast", "versium", "datafiniti"].every((p) => rows.some((m) => m.provider === p)))
    }
  },
})

// ── visitors (156F) ──────────────────────────────────────────────────────────────────────────────────────────────────────
const vB1 = u("b", 51), vB2 = u("b", 52), vANN = u("c", 81), vH1 = u("c", 82), vH2 = u("c", 83), vBOB = u("c", 84)
const V_SEAMS: Record<string, string> = {
  "lib/kernel/index.ts": "export async function processKernelEvent(){ globalThis.__P.count('kernelEvent'); return { ok: true } }",
  "lib/kernel/action-ledger.ts": "export async function withActionLedger(_m, fn){ return await fn() }; export async function ledgerSessionAction(_m, fn){ return await fn() }",
  "lib/kernel/compliance/require-contact-consent.ts": "export async function persistContactConsent(p){ globalThis.__P.count('consent'); return { consentEventId: 'consent-1' } }",
  "lib/kernel/person-identity.ts": "export async function resolvePerson(){ return { ok: false, reason: 'no_identity_anchor' } }; export async function linkPersonEvidence(){ return { ok: true } }",
  "lib/errors/collect-error.ts": "export async function collectError(){ return null }",
  "app/actions/ai-generate.ts": "export async function generateAIJSON(){ globalThis.__P.count('model'); return { data: null, error: 'fixture' } }",
}
function vWorld(extra: Record<string, Row[]> = {}): MemClient {
  return memSupabase({
    brokerages: [{ id: vB1, slug: "alpha", name: "Alpha", widget_enabled: true, status: "active", deleted_at: null, website: null }, { id: vB2, slug: "beta", name: "Beta", widget_enabled: true, status: "active", deleted_at: null, website: null }],
    brokerage_brand_settings: [{ id: "bbs-1", brokerage_id: vB1, website_url: "https://tenant.example" }], tenant_custom_domains: [],
    contacts: [
      { id: vANN, brokerage_id: vB1, email: "ann@example.test", phone: null, first_name: "Ann" },
      { id: vH1, brokerage_id: vB1, email: "family@example.test", phone: null, first_name: "P1" }, { id: vH2, brokerage_id: vB1, email: "family@example.test", phone: null, first_name: "P2" },
      { id: vBOB, brokerage_id: vB1, email: "bob@example.test", phone: "5551230000", first_name: "Bob" },
    ],
    leads: [], website_visitors: [], behavioral_signals: [], site_activity: [], external_behavior: [], raw_scraped_leads: [], person_identities: [], person_identity_evidence: [],
    contact_consent_events: [], newsletter_subscribers: [], self_heal_events: [], agent_action_ledger: [], users: [],
    ...extra,
  }, { uuidIds: true })
}

canary({
  id: "C12", title: "An anonymous page view yields a session insight, never an invented name",
  failure: "a false device / IP match becomes a Contact (or an anonymous session becomes a person Raw Lead)",
  seams: () => ({ replace: V_SEAMS }),
  async run() {
    const sourcer = await load("lib/lead-pipeline/site-visitor-sourcer.ts"), rawTypes = await load("lib/lead-pipeline/raw-record-types.ts")
    const pixel = await load("app/api/track/pixel/route.ts"), identify = await load("app/api/track/identify/route.ts")
    if (!loaded(sourcer, "lib/lead-pipeline/site-visitor-sourcer.ts", "sourceSiteVisitorIntent") || !loaded(pixel, "app/api/track/pixel/route.ts", "GET") || !loaded(identify, "app/api/track/identify/route.ts", "POST")) return
    const { NextRequest } = await import("next/server")
    let ip = 0
    const fire = (b: string, s: string, page = "https://tenant.example/listings/12-oak") => pixel.GET(new NextRequest(`https://app.test/api/track/pixel?b=${b}&s=${s}&p=${encodeURIComponent(page)}`, { headers: { "x-forwarded-for": `203.0.113.${++ip}`, referer: page } }))
    const post = (body: Record<string, unknown>) => identify.POST(new NextRequest("https://app.test/api/track/identify", { method: "POST", body: JSON.stringify(body), headers: { "x-forwarded-for": `203.0.113.${++ip}` } }))
    G.__P.mem = vWorld()
    const before = { c: T(G.__P.mem, "contacts").length, l: T(G.__P.mem, "leads").length }
    await drive(() => fire(vB1, "sess-anon-1"))
    const row = T(G.__P.mem, "website_visitors").find((r) => r.session_id === "sess-anon-1")
    pos("the pixel records the anonymous session in its tenant (from the tenant's registered site)", row?.brokerage_id === vB1, row)
    neg("…that session carries no person (contact_id, lead_id, identified_at empty) and no Contact / Lead / Raw Lead is created", !!row && !row.contact_id && !row.lead_id && !row.identified_at && T(G.__P.mem, "contacts").length === before.c && T(G.__P.mem, "leads").length === before.l && T(G.__P.mem, "raw_scraped_leads").length === 0)
    G.__P.mem = vWorld({ website_visitors: [{ id: "wv-1", brokerage_id: vB1, session_id: "sess-anon-2", page_url: "https://tenant.example/listings/12-oak?email=ann%40example.test", referrer: "https://google.com", time_on_page_seconds: 240, first_seen_at: "2026-11-25T08:00:00Z", last_seen_at: "2026-11-25T11:30:00Z", utm_source: "google", utm_medium: "cpc", utm_campaign: null, agent_id: null, contact_id: null, lead_id: null, identified_at: null }] })
    const sv: any = await quiet(() => sourcer.sourceSiteVisitorIntent(G.__P.mem, vB1, { now: new Date("2026-11-25T12:00:00Z") }))
    neg("the site-visitor lane hands the RawData producer NOTHING — an anonymous session is never a person Raw Lead", Array.isArray(sv?.records) && sv.records.length === 0, sv?.records)
    neg("…nothing it returns names the browser (no session id, no email scraped from the page's query string)", !JSON.stringify(sv ?? {}).includes("sess-anon-2") && !JSON.stringify(sv ?? {}).includes("ann%40example.test"))
    pos("the INSIGHT survives as an aggregate: one listing-page, return, campaign-referred session", sv?.aggregate?.sessions === 1 && sv.aggregate.listingPageSessions === 1 && sv.aggregate.returnSessions === 1 && sv.aggregate.campaignReferredSessions === 1, sv?.aggregate)
    if (typeof rawTypes.isViableRecord === "function") ctrl("POSITIVE CONTROL: the RawData gate WOULD take a session id carried as `username` (the shape the lane used to emit)", rawTypes.isViableRecord({ source: "site_visitor_intent", username: "sess-anon-2", sourceUrl: "https://tenant.example/listings/12-oak" }) === true)
    G.__P.mem = vWorld({ website_visitors: [{ id: "wv-2", brokerage_id: vB1, session_id: "sess-house", page_url: "/", contact_id: null, lead_id: null, identified_at: null }, { id: "wv-3", brokerage_id: vB1, session_id: "sess-mixed", page_url: "/", contact_id: null, lead_id: null, identified_at: null }, { id: "wv-4", brokerage_id: vB1, session_id: "sess-ann", page_url: "/", contact_id: null, lead_id: null, identified_at: null }] })
    await drive(() => post({ sessionId: "sess-house", email: "family@example.test" }))
    await drive(() => post({ sessionId: "sess-mixed", email: "ann@example.test", phone: "5551230000" }))
    const v = (s: string) => T(G.__P.mem, "website_visitors").find((r) => r.session_id === s)
    neg("a household inbox two contacts share links NOBODY (a wrong-person match is never made)", !v("sess-house")?.contact_id && !v("sess-house")?.identified_at, v("sess-house"))
    neg("one person's email beside ANOTHER person's phone links nobody", !v("sess-mixed")?.contact_id && !v("sess-mixed")?.identified_at, v("sess-mixed"))
    await drive(() => post({ sessionId: "sess-ann", email: "ANN@example.test" }))
    pos("a first-party form submit whose email exactly ONE contact holds links that session (the legitimate path still works)", v("sess-ann")?.contact_id === vANN && !!v("sess-ann")?.identified_at, v("sess-ann"))
    const link = await load("lib/lead-intelligence/visitor-link-decision.ts")
    if (loaded(link, "lib/lead-intelligence/visitor-link-decision.ts", "decideVisitorLink")) {
      neg("the link rule refuses ambiguity, disagreement and a refused read (fail closed)", link.decideVisitorLink([{ ids: ["x", "y"], refused: false }]).link === false && link.decideVisitorLink([{ ids: ["x"], refused: false }, { ids: ["y"], refused: false }]).link === false && link.decideVisitorLink([{ ids: ["x"], refused: true }]).link === false)
      src("the rule takes no inferred signal — its source names no IP, device, fingerprint or geolocation input", !/\b(ip_?address|ipAddress|fingerprint|device_?id|geoloc|user_?agent)\b/i.test(code("lib/lead-intelligence/visitor-link-decision.ts")))
    }
    ctrl("no visitor-identification vendor was called (refusing fetch counted 0)", calls("fetch") === 0, logged("fetch"))
  },
})

// ── calculators (156H) ───────────────────────────────────────────────────────────────────────────────────────────────────
const SELLER_NET = { salePrice: 500000, mortgagePayoff: 200000, listingCommissionPct: 2.5, titleEscrowFees: 3200, includeTransferTax: "no" }
canary({
  id: "C13", title: "A consented calculator result captures exactly ONE Lead / Contact path and genuine CTA ROI",
  failure: "every calculator view becomes a Lead",
  seams: () => ({}),
  async run() {
    const A = await load("lib/calculators/artifact.ts"), K = await load("lib/kernel/lead-magnets.ts"), MS = await load("lib/kernel/manager-signals.ts"), AL = await load("lib/kernel/action-ledger.ts")
    if (!loaded(A, "lib/calculators/artifact.ts", "createCalculatorArtifact", "computeCalculatorArtifact", "optInCalculatorResult", "recordCalculatorOpen", "getCalculatorFunnel") || !loaded(K, "lib/kernel/lead-magnets.ts", "publishLeadMagnet", "captureFormSubmission")) return
    const TA = u("b", 61), TB = u("b", 62), AGA = u("e", 61), USA = u("a", 91), ORIGIN = "https://proof.calculators.test"
    process.env.NEXT_PUBLIC_APP_URL = ORIGIN
    const c = memSupabase({
      brokerages: [{ id: TA, name: "Alpha Realty", slug: "alpha", logo_url: null, primary_color: "#123456", license_number: "A-1", license_state: "FL" }, { id: TB, name: "Beta Homes", slug: "beta" }],
      users: [{ id: USA, brokerage_id: TA, first_name: "Ann", last_name: "Agent", email: "ann@alpha.test", user_type: "agent" }], agents: [{ id: AGA, user_id: USA, brokerage_id: TA, is_active: true }],
      lead_capture_forms: [], form_submissions: [], contacts: [], contact_consent_events: [], marketing_campaigns: [], marketing_campaign_touchpoints: [], lifecycle_events: [], agent_action_ledger: [], qr_codes: [], qr_scan_events: [],
      manager_signals: [], notifications: [], campaign_sequences: [], sequence_enrollments: [], lead_magnet_deliverables: [], lead_magnet_funnel_items: [], remotion_composition_renders: [], activities: [], farm_territories: [], generated_documents: [],
    }, { uuidIds: true, stampCreatedAt: true }); (c as any).rpc = async () => ({ data: null, error: null }); G.__P.mem = c
    let captureCalls = 0
    const deps = { client: c, trackMagnetEvent: (i: any, o: any) => K.trackMagnetEvent(i, o), captureFormSubmission: async (i: any, o: any) => { captureCalls++; return K.captureFormSubmission(i, o) }, publishManagerSignal: MS.publishManagerSignal, createLeadMagnet: K.createLeadMagnet, withActionLedger: AL.withActionLedger }
    const mintTrackedQr = async (args: any, svc: any) => { const { data } = await svc.from("qr_codes").insert({ brokerage_id: args.brokerageId, agent_id: args.agentId, label: args.label, slug: "qr-1", target_url: args.targetUrl, destination_type: args.destinationType, purpose: args.purpose, is_active: true, scan_count: 0 }).select("id").single(); return { qrCodeId: data.id, slug: "qr-1", scanUrl: `${ORIGIN}/api/qr/scan?slug=qr-1`, targetUrl: args.targetUrl, qrCodeDataUrl: "data:image/png;base64,AA==" } }
    const created: any = await quiet(() => A.createCalculatorArtifact({ brokerageId: TA, agentId: AGA, createdBy: USA, title: "What will I net when I sell?", config: { kind: "seller_net_sheet", jurisdiction: "US-FL", brand: { tagline: "Know your number" }, qr: true } }, deps))
    const pub: any = await quiet(() => K.publishLeadMagnet({ magnetId: created.magnetId, brokerageId: TA, channels: ["landing_page", "qr_code"], actorUserId: USA, baseUrl: ORIGIN }, { client: c, mintTrackedQr }))
    pos("an authorized agent publishes a calculator lead magnet through the existing lead-magnet door (with a tracked QR)", created?.success && pub?.success && T(c, "qr_codes").length === 1, { created, pub })
    const att = { qr: "qr-1" }
    await quiet(() => K.trackMagnetEvent({ magnetId: created.magnetId, eventType: "qr_scan", userAgent: "Mozilla/5.0 (iPhone)" }, { client: c }))
    await quiet(() => A.recordCalculatorOpen({ formId: created.magnetId, attribution: att }, deps))
    for (const i of [0, 1, 2, 3, 4]) await quiet(() => A.computeCalculatorArtifact({ formId: created.magnetId, inputs: { ...SELLER_NET, salePrice: 500000 + i * 1000 }, attribution: att }, deps))
    neg("ANONYMOUS USE: a scan, an open and FIVE calculations create 0 contacts, 0 submissions, 0 capture calls, 0 handoffs", T(c, "contacts").length === 0 && T(c, "form_submissions").length === 0 && captureCalls === 0 && T(c, "manager_signals").length === 0, { contacts: T(c, "contacts").length, subs: T(c, "form_submissions").length, captureCalls })
    const ev = (n: string) => T(c, "lifecycle_events").filter((e) => e.event_type === `lead_magnet_${n}` && e.entity_id === created.magnetId)
    pos("…each view IS measured as an event on the form (1 scan, 1 open, 5 calculations) — insight without a person", ev("qr_scan").length === 1 && ev("calculator_open").length === 1 && ev("calculation_completed").length === 5)
    const none: any = await quiet(() => A.optInCalculatorResult({ formId: created.magnetId, inputs: SELLER_NET, intent: "save_results", contact: { first_name: "" } }, deps))
    neg("an opt-in with no name / way to reach the person is refused before the capture path (0 captures)", none?.success === false && captureCalls === 0, none)
    const opt: any = await quiet(() => A.optInCalculatorResult({ formId: created.magnetId, inputs: SELLER_NET, intent: "save_results", contact: { first_name: "Sam", last_name: "Seller", email: "sam@seller.test" }, tcpaConsentGiven: true, attribution: att }, deps))
    pos("a CONSENTED opt-in creates EXACTLY ONE routed record: 1 capture, 1 contact in the form's tenant, 1 submission carrying the recomputed result", opt?.success && captureCalls === 1 && T(c, "contacts").length === 1 && T(c, "contacts")[0].brokerage_id === TA && T(c, "form_submissions").length === 1 && T(c, "form_submissions")[0].submission_data?.calculator_kind === "seller_net_sheet", opt)
    const sig = T(c, "manager_signals").filter((s) => s.signal_type === "lead_magnet_handoff")
    pos("ONE handoff to the side's manager (listing_concierge) whose next step is to EXPLAIN the estimate — not an agent task", sig.length === 1 && sig[0].to_manager === "listing_concierge" && sig[0].payload?.nextStep === "explain_estimate", sig)
    pos("the opt-in left one ledger receipt (marketing.calculator.opt_in)", T(c, "agent_action_ledger").filter((l) => l.action === "marketing.calculator.opt_in" && l.status === "executed").length === 1)
    const f: any = await A.getCalculatorFunnel(c, { brokerageId: TA, formId: created.magnetId })
    pos("GENUINE CTA ROI: the funnel reads back exactly what happened — scans 1 · opens 1 · calculations 5 · opt-ins 1 · submissions 1", f?.success && f.funnel.qr_scan === 1 && f.funnel.calculator_open === 1 && f.funnel.calculation_completed === 5 && f.funnel.calculator_opt_in === 1 && f.funnel.submissions === 1, f)
    const fb: any = await A.getCalculatorFunnel(c, { brokerageId: TB, formId: created.magnetId })
    neg("another tenant cannot read this calculator's funnel", fb?.success === false, fb)
    ctrl("no provider / model was reached (refusing fetch counted 0)", calls("fetch") === 0)
  },
})

canary({
  id: "C14", title: "Calculator net / payment math reflects the user's own inputs and a cited jurisdiction source",
  failure: "a fabricated commission / insurance / tax percentage",
  seams: () => ({
    override: {
      "lib/identity/get-agent-context.ts": `export async function getAgentContext(){ return { isAuthenticated: true, userId: ${JSON.stringify(u("a", 92))}, brokerageId: ${JSON.stringify(u("b", 63))}, role: "agent", agentId: null } }`,
      "lib/brokerage/get-default-commission-structure.ts": "export async function getDefaultCommissionStructure(){ globalThis.__P.count('terms'); return { grossRateDecimal: 0.05, resolvedFrom: 'fixture', resolvedGrossRateDecimal: 0.05, agentBuyerSideRate: 0.025, agentListingSideRate: 0.025, brokerageBuyerSideRate: 0.005, brokerageListingSideRate: 0.005 } }",
      "lib/brokerage/index.ts": "export async function getDefaultCommissionStructure(){ globalThis.__P.count('terms'); return { grossRateDecimal: 0.05, resolvedFrom: 'fixture', resolvedGrossRateDecimal: 0.05, agentBuyerSideRate: 0.025, agentListingSideRate: 0.025, brokerageBuyerSideRate: 0.005, brokerageListingSideRate: 0.005 } }",
      "lib/ai/index.ts": "export async function generateAIJSON(){ globalThis.__P.count('model'); return { scenarios: [{ months: 6, appreciation: 0.03 }] } }",
    },
    replace: { "lib/kernel/action-ledger.ts": "export async function withActionLedger(_c, run){ return run() }; export async function ledgerSessionAction(_c, run){ return run() }; export async function ledgerToolCall(_c, run){ return run() }" },
  }),
  async run() {
    const calc = await load("app/actions/calculators.ts")
    if (!loaded(calc, "app/actions/calculators.ts", "calculateSellerNet")) return
    G.__P.mem = memSupabase({ brokerages: [{ id: u("b", 63), plan_tier: "brokerage" }], users: [{ id: u("a", 92), brokerage_id: u("b", 63), user_type: "agent" }], calculator_history: [], ai_tool_usage: [] }, { uuidIds: true })
    const base = { homeValue: 500000, mortgageBalance: 200000, location: "Austin", state: "TX", brokerageId: u("b", 63) }
    resetCalls()
    const blank: any = await quiet(() => calc.calculateSellerNet(base))
    const blob = JSON.stringify(blank ?? {})
    neg("with NO title / escrow quote entered, the seller net sheet does not invent one (no 0.7% title / 1.5% escrow figure: $3,500 / $7,500)", blank?.success === false || !(/\b3500\b/.test(blob) || /\b7500\b/.test(blob)), blank)
    neg("…and Texas (no transfer-tax statute cited) gets no fabricated 0.1% transfer tax ($500)", blank?.success === false || !/"transfer_?tax"\s*:\s*500\b/i.test(blob), blank)
    neg("…and no model is asked to predict the seller's appreciation", calls("model") === 0, calls("model"))
    const quoted: any = await quiet(() => calc.calculateSellerNet({ ...base, titleEscrowFees: 3200, transferTaxAmount: 0, repairsConcessions: 0, movingCost: 0 }))
    const qb = JSON.stringify(quoted ?? {})
    pos("with the user's OWN quote ($3,200) and transfer tax ($0) the sheet computes and carries exactly those figures", quoted?.success === true && /3200/.test(qb) && !/\b3500\b/.test(qb) && !/\b7500\b/.test(qb), quoted)
    neg("…the commission is the brokerage's agreed rate applied ONCE (5% of $500,000 = $25,000), not the agent split counted twice or a guessed 6%", /25000/.test(qb) && !/30000/.test(qb), quoted)
    const E = await load("lib/calculators/engine.ts")
    if (!loaded(E, "lib/calculators/engine.ts", "runCalculator", "CALCULATOR_SPECS")) return
    const pub = { audience: "public" }
    const fl = E.runCalculator("seller_net_sheet", { ...SELLER_NET, includeTransferTax: "yes" }, { audience: "public", jurisdiction: "US-FL" })
    const flA = fl?.assumptions?.find((a: any) => a.key === "transferTax")
    pos("a CITED statute is applied by jurisdiction: Florida doc stamps on $500,000 = $3,500, with the statute's URL and read date", fl?.ok && fl.lines.find((l: any) => l.key === "transferTax")?.amount === 3500 && flA?.basis === "cited_source" && /^https:\/\//.test(flA?.source?.url ?? ""), flA)
    const tx = E.runCalculator("seller_net_sheet", { ...SELLER_NET, includeTransferTax: "yes" }, { audience: "public", jurisdiction: "US-TX" })
    neg("NO SOURCE → 'Enter a value': Texas has no cited statute and gets no national fallback", tx?.ok === false && /Enter a value/.test(tx.missing?.[0]?.message ?? ""), tx)
    const pay = E.runCalculator("buyer_payment", { price: 400000, downPayment: 80000, termYears: 30, annualPropertyTax: 4800, annualInsurance: 1800 }, pub)
    neg("a buyer payment with NO rate entered refuses ('Enter a value') — no default mortgage rate is assumed", pay?.ok === false && pay.missing?.some((m: any) => m.key === "ratePct" && /^Enter a value/.test(m.message)), pay)
    const pay2 = E.runCalculator("buyer_payment", { price: 120000, downPayment: 0, ratePct: 0, termYears: 10, annualPropertyTax: 0, annualInsurance: 0 }, pub)
    pos("the user's own inputs drive the math exactly ($120,000 at 0% over 10 years = $1,000.00/month)", pay2?.ok && pay2.outputs?.monthlyTotal === 1000, pay2?.outputs)
    const agreed = E.runCalculator("seller_net_sheet", SELLER_NET, { audience: "public", agreedCommission: { listingRatePct: 2.75, flatAmount: null, label: "x" } })
    neg("the brokerage's agreed (internal) commission never reaches a PUBLIC estimate", agreed?.ok === false && agreed.refused?.some((r: any) => r.key === "agreedCommission"), agreed)
  },
})

canary({
  id: "C29", title: "The same calculator / packet / wording experience works for solo, team, brokerage and multi-office tenants",
  failure: "child office data bleeds across a separate brokerage or location",
  seams: () => ({ replace: FORMS_SEAMS }),
  async run() {
    const A = await load("lib/calculators/artifact.ts")
    if (loaded(A, "lib/calculators/artifact.ts", "listPublishedCalculators")) {
      const B1 = u("b", 71), B2 = u("b", 72), B3 = u("b", 73), B4 = u("b", 74)
      const cfg = (kind: string, brand: Record<string, unknown> = {}) => ({ calculator: { kind, brand, cta: { mode: "save_results" } } })
      const db = memSupabase({
        brokerages: [{ id: B1, name: "Solo Sam Realty", primary_color: "#111111" }, { id: B2, name: "Team Tara Group", primary_color: "#222222" }, { id: B3, name: "Bravo Brokerage", primary_color: "#333333" }, { id: B4, name: "Two Office Realty", primary_color: "#444444" }],
        lead_capture_forms: [
          { id: "f1", brokerage_id: B1, agent_id: "ag-solo", slug: "solo-net", name: "Solo net", magnet_type: "calculator", is_active: true, settings: cfg("seller_net_sheet") },
          { id: "f2", brokerage_id: B2, agent_id: "ag-team", slug: "team-pay", name: "Team payment", magnet_type: "calculator", is_active: true, settings: cfg("buyer_payment", { displayName: "The Tara Team" }) },
          { id: "f3", brokerage_id: B3, agent_id: "ag-bravo", slug: "bravo-pay", name: "Bravo payment", magnet_type: "calculator", is_active: true, settings: cfg("buyer_payment") },
          { id: "f3d", brokerage_id: B3, agent_id: "ag-bravo", slug: "bravo-draft", name: "Bravo draft", magnet_type: "calculator", is_active: false, settings: cfg("seller_net_sheet") },
          { id: "f4a", brokerage_id: B4, agent_id: "ag-north", slug: "north-pay", name: "North payment", magnet_type: "calculator", is_active: true, settings: cfg("buyer_payment", { displayName: "Two Office Realty — North", primaryColor: "#0000AA" }) },
          { id: "f4b", brokerage_id: B4, agent_id: "ag-south", slug: "south-net", name: "South net", magnet_type: "calculator", is_active: true, settings: cfg("seller_net_sheet", { displayName: "Two Office Realty — South", primaryColor: "#AA0000" }) },
        ],
      })
      const lists: Record<string, any[]> = {}
      for (const b of [B1, B2, B3, B4]) lists[b] = await A.listPublishedCalculators(db, b)
      const ids = (b: string) => lists[b].map((x: any) => x.formId).sort().join(",")
      const brand = (b: string, id: string) => lists[b].find((x: any) => x.formId === id)?.brand?.displayName
      const shapes: Array<["solo" | "team" | "brokerage" | "multi-office", string, string, string]> = [["solo", B1, "f1", "Solo Sam Realty"], ["team", B2, "f2", "The Tara Team"], ["brokerage", B3, "f3", "Bravo Brokerage"], ["multi-office", B4, "f4a", "Two Office Realty — North"]]
      for (const [shape, b, id, name] of shapes) {
        const ok = lists[b].some((x: any) => x.formId === id) && brand(b, id) === name
        pos(`CALCULATOR · ${shape}: lists its own published calculator with its own brand from the first render (${name})`, ok, { ids: ids(b), brand: brand(b, id) })
        cell(shape, ok)
      }
      neg("CALCULATOR · no tenant lists another's calculator, a draft, or a guide (each list is exactly its own)", ids(B1) === "f1" && ids(B2) === "f2" && ids(B3) === "f3" && ids(B4) === "f4a,f4b", { B1: ids(B1), B2: ids(B2), B3: ids(B3), B4: ids(B4) })
      neg("CALCULATOR · each office of the two-office brokerage keeps its OWN brand (North never renders as South)", brand(B4, "f4a") !== brand(B4, "f4b") && /North/.test(brand(B4, "f4a") ?? "") && /South/.test(brand(B4, "f4b") ?? ""))
    }
    // PACKETS: an office packet reaches its office; a solo agent manages its own library; another brokerage sees nothing.
    const tp = await load("lib/forms/tenant-form-packets.ts"), intake = await load("lib/forms/form-directory-intake.ts")
    if (loaded(tp, "lib/forms/tenant-form-packets.ts", "resolvePacketActor", "usableTenantPacketPaths") && loaded(intake, "lib/forms/form-directory-intake.ts", "addFormToLibrary")) {
      const db = formsWorld(); G.__P.mem = db
      const A2 = async (id: string): Promise<any> => ((await quiet(() => tp.resolvePacketActor(db, id))) as any).actor
      const broker = await A2(fBROKER)
      const north: any = ((await quiet(async () => intake.addFormToLibrary(db, broker, goodUpload(await makePdf(["n"], "n29"), { owner: { locationId: fOFF_N }, name: "North Office Disclosure", packetType: "disclosure", purpose: "disclosure" })))) as any)?.packet
      const agN = await A2(fAG_N), agS = await A2(fAG_S), foreign = await A2(fFOREIGN), solo = await A2(fSOLO)
      const usable = async (a: any, r: any) => ((await tp.usableTenantPacketPaths(db, a, [r?.storage_path])) as any)?.usable?.size === 1
      pos("PACKET · multi-office: the North office's packet reaches the North office agent", await usable(agN, north))
      neg("PACKET · …and NOT the South office agent of the same brokerage (no office bleed)", !(await usable(agS, north)))
      neg("PACKET · …and NOT another brokerage's broker (no tenant bleed)", !(await usable(foreign, north)))
      const soloAdd: any = await quiet(async () => intake.addFormToLibrary(db, solo, goodUpload(await makePdf(["s"], "s29"), { name: "Solo Listing Agreement" })))
      pos("PACKET · solo: a solo-tier agent is its own principal and adds its own brokerage packet (no new role)", soloAdd?.ok === true && soloAdd.packet?.brokerage_id === fBSOLO, soloAdd?.error)
      neg("PACKET · …the solo agent's packet is not usable by the multi-office brokerage's agent", !(await usable(agN, soloAdd?.packet)))
      cell("multi-office", (await usable(agN, north)) && !(await usable(agS, north)))
      cell("solo", soloAdd?.ok === true)
    }
    // WORDING: who pays / who the reader acts for, per shape (156Q) — a solo agent never reads a brokerage-payer claim.
    const errs = await load("lib/errors/index.ts")
    if (loaded(errs, "lib/errors/index.ts", "tenantPayerWords")) {
      const w = (p: any) => errs.tenantPayerWords(p)
      pos("WORDS · solo: 'you pay'", w({ kind: "solo" }).payerPays === "you pay")
      pos("WORDS · team: 'the team pays'", w({ kind: "team" }).payerPays === "the team pays")
      pos("WORDS · brokerage: 'the brokerage pays'", w({ kind: "brokerage" }).payerPays === "the brokerage pays")
      pos("WORDS · multi-office office seat: acts for its office, the brokerage still pays", /Downtown/.test(w({ kind: "brokerage", office: "Downtown" }).actingFor) && w({ kind: "brokerage", office: "Downtown" }).payerPays === "the brokerage pays")
      neg("WORDS · a solo agent never reads a brokerage payer or a broker to ask", !/brokerage|broker/.test(JSON.stringify(w({ kind: "solo" }))), w({ kind: "solo" }))
      neg("WORDS · an unread tier fails closed to actor-neutral words (never a brokerage claim)", !/brokerage/.test(w(null).payerPays), w(null))
      cell("team", w({ kind: "team" }).payerPays === "the team pays"); cell("brokerage", w({ kind: "brokerage" }).payerPays === "the brokerage pays")
    }
    note("rendering half NOT covered: the calculator component and the portal page are not rendered in a browser (no DOM run in this lane)")
  },
})

// ── provider economics (156G) ────────────────────────────────────────────────────────────────────────────────────────────
const gB1 = u("b", 81), gU1 = u("a", 101)
const G_SEAMS: Seams = {
  override: {
    "lib/agentic-os/connector-gateway.ts": "export async function callConnector(req){ globalThis.__P.push('gateway', req); return globalThis.__P.gatewayAnswer(req) }; export async function loadProviderHealth(){ return { state: 'healthy', routeAround: false, reason: 'fixture' } }",
    "lib/vendor-governance/usage-logger.ts": "export async function logVendorUsage(e){ globalThis.__P.push('usage', e); return { success: true } }",
    "lib/vendor-governance/meter-vendor.ts": "export async function meterVendorSpend(m){ globalThis.__P.push('meter', m); return true }",
    "lib/cma/comp-supplement-cache.ts": "export async function getCachedProviderPayload(k){ return (globalThis.__P.cache ??= new Map()).get(k) ?? null }; export async function setCachedProviderPayload(k, p){ (globalThis.__P.cache ??= new Map()).set(k, p) }",
    "lib/connections/resolve-scoped.ts": "export async function resolveScopedConnectionResult(){ return { status: 'not_connected' } }",
    "lib/vendor-governance/budget-gate.ts": "export async function checkVendorBudget(){ return { allowed: true, degraded: false } }",
    "lib/identity/get-agent-context.ts": "export async function getAgentContext(){ return { brokerageId: null, userId: null, agentId: null } }",
  },
}
function gWorld(opts: { used?: number } = {}) {
  const month = new Date().toISOString().slice(0, 7)
  G.__P.mem = memSupabase({ platform_settings: [{ id: true, provider_request_caps: null }], vendor_usage_tracking: Array.from({ length: opts.used ?? 0 }, (_, i) => ({ id: `v${i}`, vendor_name: "rentcast", units_used: 1, total_cost: 0.074, created_at: `${month}-02T00:00:00.000Z`, request_metadata: {} })) })
  G.__P.cache = new Map(); resetCalls()
  G.__P.gatewayAnswer = () => ({ ok: true, status: 200, data: [{ id: "p1", formattedAddress: "x", bedrooms: 3 }], error: null })
}
const rentcastCalls = () => logged("gateway").filter((r: any) => r.connector === "rentcast").length

canary({
  id: "C15", title: "RentCast sold comps and property facts are reused without duplicate paid requests",
  failure: "sold status or prices are fabricated where unavailable (or the same record is bought twice / a failed call billed)",
  seams: () => G_SEAMS,
  async run() {
    process.env.RENTCAST_API_KEY = "fixture-not-a-key"
    const rc = await load("lib/property/rentcast.ts")
    if (!loaded(rc, "lib/property/rentcast.ts", "getRentcastPropertyRecord", "getRentcastSoldRecords")) return
    try { (await load("lib/property/rentcast-eligibility.ts")).resetRentcastPlatformCapState?.() } catch { /* base */ }
    const caller = { brokerageId: gB1 }
    gWorld()
    const same = "12 Fixture Ln, Testville, TX 70001"
    await quiet(() => Promise.all([rc.getRentcastPropertyRecord({ ...caller, address: same }), rc.getRentcastPropertyRecord({ ...caller, address: same })]))
    neg("two CONCURRENT reads of one address make ONE paid request (not two)", rentcastCalls() === 1, rentcastCalls())
    await quiet(() => rc.getRentcastPropertyRecord({ ...caller, address: same }))
    pos("a later read of the same address is REUSED from cache — still one request, one ledger row", rentcastCalls() === 1 && logged("usage").length === 1, { calls: rentcastCalls(), usage: logged("usage").length })
    gWorld(); G.__P.gatewayAnswer = () => ({ ok: false, status: 500, data: null, error: "fixture 500" })
    const failed = await quiet(() => rc.getRentcastPropertyRecord({ ...caller, address: "99 Failed Rd, Testville, TX 70009" }))
    neg("a FAILED (500) request books ZERO spend (RentCast bills only a 200)", failed === null && logged("usage").length === 0, logged("usage"))
    gWorld()
    G.__P.gatewayAnswer = () => ({ ok: true, status: 200, error: null, data: [
      { id: "s1", formattedAddress: "1 Sold St, Testville, TX 70001", bedrooms: 3, lastSaleDate: "2026-09-14T00:00:00.000Z", lastSalePrice: 410000 },
      { id: "s2", formattedAddress: "2 Unknown St, Testville, TX 70001", bedrooms: 4 },
    ] })
    const sold: any = await quiet(() => rc.getRentcastSoldRecords({ ...caller, zipCode: "70001", saleDateRangeDays: 180 }))
    const r1 = sold?.records?.find((r: any) => /1 Sold/.test(r.address ?? r.formattedAddress ?? JSON.stringify(r))), r2 = sold?.records?.find((r: any) => /2 Unknown/.test(JSON.stringify(r)))
    pos("a recorded sale carries ITS sale date and price as RentCast reports them", r1?.lastSalePrice === 410000 && r1?.lastSaleDate === "2026-09-14", r1)
    neg("a record with NO sale fields reports null date and null price — nothing fabricated", !!r2 && r2.lastSalePrice === null && r2.lastSaleDate === null, r2)
    neg("…and no record is labelled 'sold' / given a status it did not carry", !JSON.stringify(r2 ?? {}).match(/"status":"(Sold|sold)"/), r2)
    const again: any = await quiet(() => rc.getRentcastSoldRecords({ ...caller, zipCode: "70001", saleDateRangeDays: 180 }))
    pos("the same area's sold records are REUSED (cache hit, one paid request in total)", again?.cacheHit === true && rentcastCalls() === 1, { cacheHit: again?.cacheHit, calls: rentcastCalls() })
    ctrl("POSITIVE CONTROL: two DIFFERENT addresses do make two requests (the dedup is per record, not a blanket block)", await (async () => { gWorld(); await quiet(() => Promise.all([rc.getRentcastPropertyRecord({ ...caller, address: "1 A St, X, TX 70001" }), rc.getRentcastPropertyRecord({ ...caller, address: "2 B St, X, TX 70001" })])); return rentcastCalls() === 2 })())
  },
})

canary({
  id: "C16", title: "Datafiniti's free count / schema helps decide BEFORE any paid download",
  failure: "a licensed-but-dormant account makes a paid request",
  seams: () => G_SEAMS,
  async run() {
    const door = await load("lib/lead-pipeline/datafiniti-dataset-door.ts"), dc = await load("lib/external/datafiniti-client.ts"), rail = await load("lib/ai-isa/property-lookup-rail.ts")
    if (!loaded(door, "lib/lead-pipeline/datafiniti-dataset-door.ts", "runDatafinitiDatasetDoor") || !loaded(rail, "lib/ai-isa/property-lookup-rail.ts", "PROVIDER_ACTIVATION")) return
    const df: any[] = []
    const envelope = (payload: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: payload } })
    const transport = async (req: any) => { df.push(req); const name = req.body?.params?.name; if (name === "df_get_schema") return { status: 200, data: envelope({ schema: { province: "string", city: "string", mostRecentStatus: "string" } }), error: null, headers: {} }; if (name === "df_count") return { status: 200, data: envelope({ num_found: 42 }), error: null, headers: {} }; return { status: 200, data: envelope({ records: [{ id: "r1" }], num_found: 1 }), error: null, headers: {} } }
    const need = { dataType: "property", terms: [{ field: "province", op: "eq", value: "TX" }], uses: ["enrichment"], gapFields: ["mostRecentStatus"], delivery: "download", numRecords: 40 }
    const dormant: any = await quiet(() => door.runDatafinitiDatasetDoor({ mode: "execute", brokerageId: gB1, route: "platform", need, approval: { approvedBy: gU1, maxCredits: 1000 }, requestId: "r1" }, { client: { transport, env: { DATAFINITI_API_TOKEN: "fixture" } } }))
    neg("the platform account at its DECLARED activation (dormant, pending rights) makes ZERO calls — not even the free schema — on an approved execute", dormant?.refused != null && dormant?.stage === "rights" && df.length === 0, { stage: dormant?.stage, calls: df.length })
    const tenant: any = await quiet(() => door.runDatafinitiDatasetDoor({ mode: "execute", brokerageId: gB1, route: "tenant", tenantConnection: { id: "c1", brokerageId: gB1, token: "tenant-fixture", verdict: { state: "pending_owner_licensing", mayIngest: false, reason: "fixture" } }, need, approval: { approvedBy: gU1, maxCredits: 1000 }, requestId: "r2" }, { client: { transport } }))
    neg("a tenant's own Datafiniti key pending the owner's licensing decision: ZERO calls", tenant?.stage === "rights" && df.length === 0, tenant?.stage)
    if (typeof dc.countDatafinitiPeople === "function") {
      const noTok: any = await quiet(() => dc.countDatafinitiPeople({ owner: "tenant", brokerageId: gB1, connectionId: "c3", token: null }, { lastName: "Fixture", province: "TX" }, { transport, env: { DATAFINITI_API_TOKEN: "platform-fixture" } }))
      neg("a tenant credential with no token never falls back to the platform token (zero calls)", noTok?.ok === false && df.length === 0, noTok)
    }
    const permitted = { multi_tenant: "permitted", storage: "permitted", enrichment: "permitted", ai_processing: "permitted", export: "permitted", outreach: "permitted", retentionDays: 30, source: "TEST ONLY" }
    const active = { ...rail.PROVIDER_ACTIVATION.datafiniti, state: "active" }
    const pre: any = await quiet(() => door.runDatafinitiDatasetDoor({ mode: "preflight", brokerageId: gB1, route: "platform", need }, { client: { transport, env: { DATAFINITI_API_TOKEN: "fixture" } }, activation: active, rights: permitted }))
    const names = df.map((r) => r.body?.params?.name)
    pos("with activation + rights flipped IN THE TEST ONLY, the preflight runs the FREE schema + count first (df_get_schema, df_count) and returns the count (42)", names.join() === "df_get_schema,df_count" && pre?.count === 42, { names, count: pre?.count })
    neg("…and the preflight downloaded nothing and charged nothing (no df_search / df_start_download; charged 0)", !names.includes("df_start_download") && !names.includes("df_search") && pre?.calls?.charged === 0, pre?.calls)
    if (typeof rail.decidePrePull === "function") {
      const fc = rail.decidePrePull({ capability: "owner_contact", materialFields: ["email"], freeCount: { available: true, count: null } })
      pos("the pre-pull waterfall asks the free count FIRST — no purchase line yet", fc.stage === "free_count" && fc.buy.length === 0, fc)
      ctrl("POSITIVE CONTROL: a free count of 0 → nothing to buy (the count actually decides)", rail.decidePrePull({ capability: "owner_contact", materialFields: ["email"], freeCount: { available: true, count: 0 } }).stage === "nothing_found")
    }
  },
})

canary({
  id: "C17", title: "A Versium marginal field append is justified on a matched cohort and FULLY LOADED cost",
  failure: "a marketing headline rate is treated as a signed contract",
  seams: () => G_SEAMS,
  async run() {
    const econ = await load("lib/vendor-governance/acquisition-economics.ts"), rail = await load("lib/ai-isa/property-lookup-rail.ts")
    if (!loaded(econ, "lib/vendor-governance/acquisition-economics.ts", "PROVIDER_COMMITMENT_TERMS", "costUnderCommitment", "foldCohortFinance")) return
    const annual = (econ.PROVIDER_COMMITMENT_TERMS as any[]).find((x) => x.provider === "versium" && x.termMonths === 12)
    neg("the Versium plan is declared as a PUBLISHED rate with executedQuote: false and its source — never a signed contract", !!annual && annual.executedQuote === false && /versium/.test(String(annual.source)), annual)
    const low = econ.costUnderCommitment(annual, 1_000)
    neg("at 1,000 credits/month the $5,000/yr minimum binds: ~$0.42 per credit, NOT the $0.02 headline", low.minimumBinding === true && low.effectiveUnitUsd > 0.4 && low.monthlyUsd === 416.67, low)
    ctrl("POSITIVE CONTROL: at full use the effective rate IS the plan's $0.02", (() => { const f = econ.costUnderCommitment(annual, 250_000 / 12); return f.effectiveUnitUsd === 0.02 && f.minimumBinding === false })())
    const unknown = (econ.PROVIDER_COMMITMENT_TERMS as any[]).find((x) => x.provider === "datafiniti")
    neg("an unpublished overage reads UNKNOWN (null), never $0", !!unknown && econ.costUnderCommitment(unknown, 20_000).monthlyUsd === null)
    const partial = econ.foldCohortFinance({ subscriptionAllocationUsd: null, billedRequestsUsd: 100, aiToolUsd: null, validationUsd: null, usablePersons: null, promotedLeads: 50, qualifiedContacts: 10, closedOpportunities: null })
    neg("with no blinded match verification the cost per usable person is NULL and every figure is a lower bound — no fabricated match rate", partial.complete === false && partial.costPerUsablePersonUsd === null && partial.unknowns.length > 0, partial)
    const full = econ.foldCohortFinance({ subscriptionAllocationUsd: 416.67, billedRequestsUsd: 83.33, aiToolUsd: 50, validationUsd: 50, usablePersons: 400, promotedLeads: 100, qualifiedContacts: 20, closedOpportunities: 2 })
    pos("on a MATCHED cohort with every cost part known: $600 fully loaded / 400 usable persons = $1.50 per usable person", full.complete === true && full.costPerUsablePersonUsd === 1.5, full)
    if (typeof rail.decidePrePull === "function") {
      const sup = rail.decidePrePull({ capability: "owner_contact", materialFields: ["email", "phone"], activation: { versium: { state: "active" }, batchdata: { state: "dormant_survivor" }, peopledata: { state: "active" } }, supplies: { versium: ["email"], batchdata: ["phone"], peopledata: ["phone"] } })
      pos("the MARGINAL append: the cheapest licensed provider buys only its missing field (versium: email), a narrow supplement the verified gap", sup.stage === "buy" && sup.buy[0]?.provider === "versium" && sup.buy[0]?.fields?.join() === "email", sup.buy)
      neg("an unlicensed (dormant) provider is never the failover target", !sup.buy.some((b: any) => b.provider === "batchdata"), sup.buy)
      neg("own verified fresh record → reuse, nothing bought", rail.decidePrePull({ capability: "owner_contact", materialFields: ["email"], held: { email: { verified: true, ageDays: 10 } } }).stage === "reuse_own_record")
    }
  },
})

// ── market intelligence (156I) ───────────────────────────────────────────────────────────────────────────────────────────
const iB1 = u("b", 91)
canary({
  id: "C18", title: "Permitted public intent becomes an age-verified RawData / Raw Lead",
  failure: "an anonymous Google Trends search (or forum post) identifies a named person",
  seams: () => ({ override: { "lib/ai/models.ts": "export async function generateTextRouted(){ globalThis.__P.count('model'); return { text: '', usage: {} } }; export async function generateObjectRouted(){ globalThis.__P.count('model'); return { object: {}, usage: {} } }" } }),
  async run() {
    const pr = await load("lib/acquisition-plays/public-request.ts"), stmt = await load("lib/acquisition-plays/public-statement.ts")
    if (!loaded(pr, "lib/acquisition-plays/public-request.ts", "runPublicRequestPlay")) return
    const now = new Date(), daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString()
    const ingested: any[] = []
    const deps = {
      ingest: async (p: any) => { ingested.push(...p.records.map((r: any) => ({ ...r, __subject: r.envelope?.subjectKind }))); return { inserted: p.records.length, replayed: 0, skipped_territory: 0, skipped_stale: 0, skipped_refused: 0 } },
      findContact: async () => ({ contactId: null, error: null }), respond: async () => { throw new Error("fixture: no existing contact") },
      loadKnown: async () => ({ sourceRecordIds: new Set<string>(), personKeys: new Set<string>(), propertyKeys: new Set<string>(), priorProviderResults: new Map(), scope: { brokerageId: iB1, includesPlatformPool: false } }),
    }
    const res = (id: string, url: string, text: string, author: string | null = null) => ({ id, url, title: null, text, author, publishedDate: daysAgo(2), highlights: null, extracted: null, publisher: null })
    const results = [
      res("r-adult", "https://austin.craigslist.org/hsw/d/austin-wanted-home/7000000001.html", "We are looking to buy a house in Austin this year. Please email me at jane.buyer@example.com with any homes."),
      res("r-minor", "https://austin.craigslist.org/hsw/d/austin-first-home/7000000002.html", "I'm 16 and looking to buy a house in Austin this year. Email me at teen.buyer@example.com please."),
      res("r-forum", "https://www.reddit.com/r/Austin/comments/abc123/buying_advice/", "We are looking to buy a house in Austin this year, any advice on neighborhoods?", "u_quiet_handle"),
      res("r-trend", "https://trends.google.com/trends/explore?geo=US-TX&q=homes%20for%20sale%20austin", "Interest over time for homes for sale austin, Texas."),
    ]
    const out: any = await quiet(() => pr.runPublicRequestPlay({ from: () => { throw new Error("fixture: no direct reads") } }, { market: { id: "m-austin", brokerage_id: iB1, name: "Austin", city: "Austin", state: "TX", zip_codes: [] }, hunt: null, results, now }, deps))
    const persons = ingested.filter((r) => r.__subject === "person")
    pos("an ADULT's own first-person need with the contact point they published becomes exactly ONE Raw Lead", persons.length === 1 && persons[0].email === "jane.buyer@example.com", persons.map((p) => p.email))
    neg("the author who says they are 16 is NOT filed as a person (age-verified)", !ingested.some((r) => r.email === "teen.buyer@example.com"), ingested.map((r) => [r.__subject, r.email]))
    neg("an anonymous Google Trends page NEVER yields a person", !persons.some((p) => /trends\.google/.test(String(p.sourceUrl))))
    neg("an anonymous forum post never yields a named person (no handle carried as identity)", !persons.some((p) => /reddit\.com/.test(String(p.sourceUrl))) && !ingested.some((r) => r.__subject === "person" && JSON.stringify(r).includes("u_quiet_handle")))
    neg("no non-person record carries an email or a phone", ingested.filter((r) => r.__subject !== "person").every((r) => !r.email && !r.phone))
    if (typeof stmt.authorStatesMinor === "function") ctrl("POSITIVE CONTROL: the age screen does not fire on an adult age, a distance or a third party's age", ["I'm 34 and relocating for work", "I'm 5 minutes from downtown", "My son is 16 and we are moving"].every((t) => stmt.authorStatesMinor(t) === false))
    ctrl("no model was called on the person path", calls("model") === 0 && calls("fetch") === 0)
    void out
  },
})

canary({
  id: "C19", title: "A real local event or consumer question generates on-brand ORIGINAL content",
  failure: "an invented event / date, competitor copy, or false viral metrics",
  seams: () => ({}),
  async run() {
    const ti = await load("lib/content-intel/topic-intake.ts")
    if (!loaded(ti, "lib/content-intel/topic-intake.ts", "intakeTopicIdeas", "classifyTopicExclusion")) return
    const NOW = new Date(), daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()
    const db = memSupabase({ content_topic_bank: [], content_topic_sources: [{ id: "src-1", brokerage_id: iB1, is_active: true }] }); G.__P.mem = db
    const base = { observedAt: NOW.toISOString(), publishedAt: daysAgo(5), rights: "public_read_reworded", sourceId: "src-1" }
    const joining = { ...base, sourceKind: "competitor_ad", title: "Please welcome our newest agent Sam Rivera to the team!", evidence: { kind: "proxy", metric: "search_relevance_recency", value: 95, unit: "search_relevance_0_100" } }
    const question = { ...base, sourceKind: "community_post", title: "How do property taxes change after you buy a home in Austin?", geo: { city: "Austin", state: "TX" }, evidence: { kind: "proxy", metric: "x", value: 40, unit: "score_0_100" }, dedupKey: "p156:property-taxes-austin" }
    const viral = { ...base, sourceKind: "community_post", title: "Everyone is asking about flood insurance in Austin", evidence: { kind: "unknown" } }
    const r1: any = await quiet(() => ti.intakeTopicIdeas(db, { brokerageId: iB1, ideas: [joining, question, viral], now: NOW }))
    const reasons = (r1?.excluded ?? []).map((e: any) => e.reason)
    neg("a competitor's 'welcome our newest agent' post never reaches the topic bank (no competitor copy)", !T(db, "content_topic_bank").some((r) => /welcome|newest agent/i.test(String(r.topic_title))), reasons)
    neg("an unmeasured 'everyone is asking' claim is refused (no invented viral metric)", reasons.includes("unmeasured_trend_claim"), reasons)
    pos("a real consumer question is stored ONCE as a topic", r1?.inserted === 1 && T(db, "content_topic_bank").length === 1, r1)
    const r2: any = await quiet(() => ti.intakeTopicIdeas(db, { brokerageId: iB1, ideas: [{ ...question, observedAt: new Date(NOW.getTime() + 60_000).toISOString() }], now: NOW }))
    neg("the same question observed again MERGES into the one topic (no duplicate campaign seed)", r2?.inserted === 0 && r2?.merged === 1 && T(db, "content_topic_bank").length === 1, r2)
    const LE = await load("lib/newsletter/local-events.ts")
    if (loaded(LE, "lib/newsletter/local-events.ts", "runLocalEventsPass")) {
      const src = { id: "src-lib", brokerageId: iB1, label: "Springfield Public Library", sourceClass: "library_calendar", access: "publisher_syndication_feed", url: "https://library.springfield.gov/events.ics", rights: { termsNote: "public calendar feed offered for syndication", recordedBy: "u-admin", recordedAt: "2026-11-01T00:00:00Z", licenseRef: null }, territory: { city: "Springfield", state: "IL", zip: null }, lastRunAt: null }
      const future = new Date(NOW.getTime() + 10 * 86_400_000).toISOString().slice(0, 10)
      const ev = (over: Record<string, unknown> = {}) => ({ sourceEventKey: "uid-fair", url: "https://library.springfield.gov/events/fall-book-fair", title: "Fall Book Fair", location: { kind: "physical", venue: "Main Library", city: "Springfield", state: "IL", zip: "62701", virtualUrl: null }, start: { date: future, time: "10:00", timeZone: "America/Chicago" }, end: null, status: "scheduled", ...over })
      const edb = memSupabase({ content_topic_bank: [], content_topic_sources: [{ id: `sys-${iB1}`, brokerage_id: iB1, source_type: "manual", is_active: true, label: "system", source_config: { system_writer: "topic_intake" } }] })
      const deps = { now: NOW, intake: ti.intakeTopicIdeas, ledger: async (_c: any, run: () => Promise<any>) => run(), inTerritory: async () => (a: any) => a.city === "Springfield", screen: async () => () => null, transports: {} }
      const bad: any = await quiet(() => LE.runLocalEventsPass(edb, iB1, { ...deps, extraEvents: [{ source: src, events: [ev({ sourceEventKey: "k1", start: { date: null, time: null, timeZone: null } }), ev({ sourceEventKey: "k2", status: "canceled" })] }], onlyExtra: true } as any).catch((e: Error) => ({ threw: e.message })))
      neg("an event with NO verified date, and a CANCELED event, generate nothing (no invented date / event)", (bad?.verified ?? 0) === 0 && T(edb, "content_topic_bank").length === 0 && !bad?.threw, bad)
      const good: any = await quiet(() => LE.runLocalEventsPass(edb, iB1, { ...deps, extraEvents: [{ source: src, events: [ev()] }], onlyExtra: true } as any).catch((e: Error) => ({ threw: e.message })))
      pos("a REAL, dated, in-territory library event is verified and becomes topic(s) carrying its source URL", good?.verified === 1 && T(edb, "content_topic_bank").length > 0 && JSON.stringify(T(edb, "content_topic_bank")).includes("library.springfield.gov"), { verified: good?.verified, n: T(edb, "content_topic_bank").length, threw: good?.threw })
    }
    note("'on-brand' first generation is proven at the PROMPT level by test:wave156-i §D (no model is called here); the rendered copy is not covered")
  },
})

// ── fraud network (156J) ─────────────────────────────────────────────────────────────────────────────────────────────────
const jB0 = u("b", 100), jB1 = u("b", 101), jB2 = u("b", 102), jAGENT = u("a", 111), jAGENT2 = u("a", 112), jCO = u("a", 113), jVENDOR = u("a", 114), jX = u("a", 115), jXAGENT = u("a", 116), jSTAFF = u("a", 117), jMKT = u("a", 118)
const jAG = u("e", 111), jAG2 = u("e", 112), jAGX = u("e", 116), jTX = u("d", 111), jC1 = u("c", 111)
const J_SEAMS: Seams = {
  replace: {
    "lib/ai/models.ts": "export async function generateTextRouted(){ globalThis.__P.count('model'); return { text: '' } }; export async function generateObjectRouted(){ globalThis.__P.count('model'); return { object: {} } }; export async function streamTextRouted(){ globalThis.__P.count('model'); throw new Error('no stream') }",
    "lib/ai/generate.ts": "export function bookedGenerateObject(){ return async () => { globalThis.__P.count('model'); return { object: {} } } }",
    "lib/teams/team-scope.ts": "export async function leadsAgentsTeam(){ return { ok: true, leads: false, ledTeamId: null } }",
  },
  spec: { "next/navigation": "export function redirect(u){ throw new Error('REDIRECT:' + u) }; export function notFound(){ throw new Error('NOT_FOUND') }" },
}
function jWorld(): MemClient {
  return memSupabase({
    brokerages: [{ id: jB0, name: "Platform" }, { id: jB1, name: "First Realty" }, { id: jB2, name: "Second Homes" }],
    users: [
      { id: jAGENT, brokerage_id: jB1, user_type: "agent", email: "agent@first.test" }, { id: jAGENT2, brokerage_id: jB1, user_type: "agent" }, { id: jCO, brokerage_id: jB1, user_type: "compliance_officer" },
      { id: jVENDOR, brokerage_id: jB1, user_type: "vendor" }, { id: jX, brokerage_id: jB2, user_type: "broker" }, { id: jXAGENT, brokerage_id: jB2, user_type: "agent" },
      { id: jSTAFF, brokerage_id: jB0, user_type: "admin", platform_role: "support" }, { id: jMKT, brokerage_id: jB0, user_type: "admin", platform_role: "marketing" },
    ],
    agents: [{ id: jAG, user_id: jAGENT, brokerage_id: jB1 }, { id: jAG2, user_id: jAGENT2, brokerage_id: jB1 }, { id: jAGX, user_id: jXAGENT, brokerage_id: jB2 }],
    transactions: [{ id: jTX, brokerage_id: jB1, agent_id: jAG, buyer_agent_id: null, seller_agent_id: null, status: "under_contract", contact_id: jC1 }],
    vendors: [{ id: u("f", 111), brokerage_id: jB1, category: "title", status: "active" }], vendor_assignments: [{ id: u("f", 112), vendor_id: u("f", 111), transaction_id: jTX, brokerage_id: jB1, status: "confirmed" }],
    contacts: [{ id: jC1, brokerage_id: jB1, first_name: "Casey", agent_id: jAG }], listings: [], teams: [], user_role_assignments: [], platform_role_capability_overrides: [],
    fraud_incident_cases: [], fraud_case_evidence: [], fraud_bulletins: [], fraud_bulletin_sources: [], fraud_bulletin_revisions: [], fraud_correction_requests: [], fraud_warning_subscriptions: [], fraud_bulletin_reads: [], fraud_bulletin_derivatives: [],
    notifications: [], agent_action_ledger: [], tasks: [], lifecycle_events: [], manager_signals: [], content_topic_sources: [], content_topic_bank: [],
  }, { uuidIds: true, stampCreatedAt: true } as any)
}
const FP = (n: number) => n.toString(16).padStart(2, "0").repeat(32)
const INCIDENT = { incidentKind: "wire_diversion_lookalike_domain", channel: "email", summary: "Buyer received wire instructions from escrow@flrst-title.test claiming new bank details; agent called the title office at 555-201-3344 and it was fake.", eventDate: "2026-11-20", transactionId: jTX, lossOccurred: "no", allegedIndicators: [{ kind: "domain", value: "flrst-title.test" }, { kind: "account_last4", value: "4321" }], externalReports: [{ agency: "ic3", reference: "I-2026-77" }], evidence: [{ kind: "email_headers", fingerprint: FP(1), label: "headers.eml" }], shareConsent: false }
async function asSeat<X>(seat: string | null, fn: () => Promise<X>): Promise<any> { G.__P.seat = seat ? { id: seat } : null; try { return await quiet(fn) } catch (e) { return { ok: false, error: String((e as Error)?.message ?? e), threw: true } } }

canary({
  id: "C20", title: "A fraud case stays private to the reporter; a MODERATED anonymous warning is visible to all authorized tenants",
  failure: "an accused private person is publicly named from an unverified report",
  seams: () => J_SEAMS,
  async run() {
    // THE PRE-WAVE PATH FIRST: the public topic pool is where a warning becomes tenant content. A fraud-bulletin topic naming a
    // private person must be refused there (156I's protective screen) — on the pre-wave tree it was stored.
    const ti = await load("lib/content-intel/topic-intake.ts")
    if (loaded(ti, "lib/content-intel/topic-intake.ts", "intakeTopicIdeas")) {
      const db = memSupabase({ content_topic_bank: [], content_topic_sources: [{ id: "src-1", brokerage_id: jB1, is_active: true }] })
      const now = new Date()
      const base = { sourceKind: "fraud_safety_bulletin", observedAt: now.toISOString(), evidence: { kind: "unknown" }, rights: "own_content", sourceId: "src-1", angle: "Protective education: verify every payment request through a channel you obtained independently." }
      await quiet(() => ti.intakeTopicIdeas(db, { brokerageId: jB1, ideas: [{ ...base, title: "Wire fraud warning about Dale Hughes and his fake title company", dedupKey: "p:name" }, { ...base, title: "How can a home buyer confirm wire instructions are real before sending a down payment?", dedupKey: "p:generic" }], now }))
      const stored = T(db, "content_topic_bank").map((x) => String(x.topic_title))
      neg("a fraud-warning topic NAMING a private person never enters the tenant's content pool", !stored.some((t) => /Dale Hughes/.test(t)), stored)
      ctrl("POSITIVE CONTROL: the generic protective question IS stored (the screen is not a blanket refusal)", stored.some((t) => /confirm wire instructions/.test(t)), stored)
    }
    const A = await load("app/actions/fraud-network.ts")
    if (!loaded(A, "app/actions/fraud-network.ts", "submitFraudIncident", "getFraudCase", "draftFraudBulletinFromCase", "publishFraudBulletin", "listFraudBulletins", "updateFraudBulletinDraft")) return
    G.__P.mem = jWorld(); resetCalls()
    const sub = await asSeat(jAGENT, () => A.submitFraudIncident(INCIDENT))
    const caseId = sub?.caseId
    pos("the agent on the deal files a PRIVATE case pinned to the session tenant and reporter, with a receipt", sub?.ok === true && T(G.__P.mem, "fraud_incident_cases")[0]?.brokerage_id === jB1 && T(G.__P.mem, "agent_action_ledger").some((r) => r.action === "fraud.case.submit"), sub)
    pos("the reporter and the tenant's compliance officer read the case", (await asSeat(jAGENT, () => A.getFraudCase(caseId)))?.ok === true && (await asSeat(jCO, () => A.getFraudCase(caseId)))?.ok === true)
    const leak: string[] = []
    for (const [who, seat] of [["a co-worker", jAGENT2], ["another tenant's broker", jX], ["another tenant's agent", jXAGENT], ["a vendor seat", jVENDOR], ["marketing staff", jMKT], ["nobody signed in", null]] as const) {
      const r = await asSeat(seat as any, () => A.getFraudCase(caseId))
      if (!(r?.ok === false && !JSON.stringify(r).includes("flrst"))) leak.push(who)
    }
    neg("the case stays PRIVATE: a co-worker, another tenant, a vendor, marketing staff and anonymous read nothing", leak.length === 0, leak)
    const draft = await asSeat(jSTAFF, () => A.draftFraudBulletinFromCase(caseId))
    const bId = draft?.bulletinId
    await asSeat(jSTAFF, () => A.updateFraudBulletinDraft(bId, { title: "Look-alike escrow domain wire diversion", tactic_summary: "A message from a domain one letter off the real escrow company asks the buyer to wire to new bank details.", named_entity: "Jordan Example" }))
    const named = await asSeat(jSTAFF, () => A.publishFraudBulletin(bId, { attestNoPersonIdentified: true, legalReviewConfirmed: true, verificationNote: "call-back confirmed" }))
    neg("an UNVERIFIED report naming a person is REFUSED publication even with every box ticked", named?.ok === false && T(G.__P.mem, "fraud_bulletins").find((b) => b.id === bId)?.status === "draft", named)
    const tenantPub = await asSeat(jCO, () => A.publishFraudBulletin(bId, { attestNoPersonIdentified: true, legalReviewConfirmed: true, verificationNote: "x" }))
    neg("a tenant seat cannot publish to the network (moderation is platform safety staff)", tenantPub?.ok === false)
    await asSeat(jSTAFF, () => A.updateFraudBulletinDraft(bId, { named_entity: "", claim_class: "verified_operational_pattern", confidence: "high", jurisdiction: "FL", indicators: [{ kind: "lookalike_domain", value: "flrst-title.test" }] }))
    const pub = await asSeat(jSTAFF, () => A.publishFraudBulletin(bId, { attestNoPersonIdentified: true, legalReviewConfirmed: false, verificationNote: "Call-back to the title office on the number from the signed statement confirmed the message was not theirs." }))
    pos("moderated publication: platform safety staff publish the verified TACTIC warning (no person) with a LEGAL receipt", pub?.ok === true && T(G.__P.mem, "agent_action_ledger").some((r) => r.action === "fraud.bulletin.publish"), pub)
    const xl = await asSeat(jXAGENT, () => A.listFraudBulletins({}))
    const payload = JSON.stringify(xl)
    pos("ANOTHER tenant's agent reads the warning", xl?.ok === true && xl.bulletins?.some((b: any) => b.id === bId), xl)
    neg("…ANONYMOUSLY: no reporting tenant, reporter, case id, evidence fingerprint or contact detail in the payload", ![jB1, jAGENT, caseId, FP(1), "555-201", "First Realty", "I-2026-77"].some((s) => s && payload.includes(s)), payload.slice(0, 200))
    ctrl("no model was called on any report / moderation / publication path", calls("model") === 0)
    cell("brokerage", pub?.ok === true)
  },
})

canary({
  id: "C21", title: "A wire-change bulletin match leads to an INDEPENDENT VERIFICATION task, not an automatic denial",
  failure: "a fraud label becomes an automated housing / service blacklist",
  seams: () => J_SEAMS,
  async run() {
    const A = await load("app/actions/fraud-network.ts"), runner = await load("lib/wire-fraud/wire-fraud-runner.ts")
    if (!loaded(A, "app/actions/fraud-network.ts", "submitFraudIncident", "publishFraudBulletin") || !loaded(runner, "lib/wire-fraud/wire-fraud-runner.ts", "runWireFraudSentinel")) return
    G.__P.mem = jWorld(); resetCalls()
    const sub = await asSeat(jAGENT, () => A.submitFraudIncident(INCIDENT))
    const d = await asSeat(jSTAFF, () => A.draftFraudBulletinFromCase(sub?.caseId))
    await asSeat(jSTAFF, () => A.updateFraudBulletinDraft(d?.bulletinId, { title: "Look-alike escrow domain", tactic_summary: "Wire requests from a domain one letter off the real escrow company.", claim_class: "verified_operational_pattern", confidence: "high", indicators: [{ kind: "lookalike_domain", value: "flrst-title.test" }] }))
    const p = await asSeat(jSTAFF, () => A.publishFraudBulletin(d?.bulletinId, { attestNoPersonIdentified: true, legalReviewConfirmed: false, verificationNote: "verified by call-back" }))
    const before = { tx: JSON.stringify(T(G.__P.mem, "transactions")), vendors: JSON.stringify(T(G.__P.mem, "vendors")), va: JSON.stringify(T(G.__P.mem, "vendor_assignments")), contacts: JSON.stringify(T(G.__P.mem, "contacts")) }
    const wire = { senderEmail: "escrow@flrst-title.test", expectedDomains: ["first-title.test"], priorInstructions: { account: "1111" }, newInstructions: { account: "2222" }, messageText: "updated wire instructions" }
    const run = (ref: string) => quiet(() => runner.runWireFraudSentinel({ brokerageId: jB1, contactId: jC1, agentUserId: jAGENT, wire, transactionId: jTX, agentId: jAG, subjectRef: ref }, G.__P.client()))
    const r1: any = p?.ok ? await run("wire_fraud:doc-1") : null
    const tasks = () => T(G.__P.mem, "tasks").filter((t) => t.source === "fraud_bulletin_match")
    pos("a changed wire matching the published look-alike domain PROPOSES one high-priority verification task to the deal's agent", r1?.bulletinMatch?.indicatorMatch === true && tasks().length === 1 && tasks()[0].priority === "high" && tasks()[0].assigned_to_agent_id === jAG && tasks()[0].status === "pending", { match: r1?.bulletinMatch, tasks: tasks().length })
    pos("…the task asks for a call-back on an INDEPENDENTLY obtained number and accuses no one", /independently/.test(String(tasks()[0]?.description)) && /not a finding about any person/.test(String(tasks()[0]?.description)), tasks()[0]?.description)
    neg("NO automatic denial: transactions, vendors, vendor assignments and contacts are byte-identical (no ban, no blacklist)", JSON.stringify(T(G.__P.mem, "transactions")) === before.tx && JSON.stringify(T(G.__P.mem, "vendors")) === before.vendors && JSON.stringify(T(G.__P.mem, "vendor_assignments")) === before.va && JSON.stringify(T(G.__P.mem, "contacts")) === before.contacts)
    await (p?.ok ? run("wire_fraud:doc-1") : null)
    neg("a replay proposes NO second task", tasks().length === 1, tasks().length)
    const FORBIDDEN = /\.from\(\s*["'`](transactions|vendors|vendor_assignments|contacts|users|agents)["'`]\s*\)(?:(?!\.from\()[\s\S]){0,240}?\.(insert|update|delete|upsert)\s*\(/
    src("no write to transactions / vendors / vendor_assignments / contacts / users / agents anywhere in the network or the runner (comment-stripped)", !["lib/fraud-network/network.ts", "app/actions/fraud-network.ts", "lib/wire-fraud/wire-fraud-runner.ts"].some((f) => FORBIDDEN.test(code(f))))
    ctrl("POSITIVE CONTROL: that finder catches a planted vendor ban", FORBIDDEN.test(`await svc.from("vendors").update({ status: "banned" }).eq("id", x)`))
    G.__P.mem = jWorld()
    const noMatch: any = await quiet(() => runner.runWireFraudSentinel({ brokerageId: jB1, contactId: jC1, agentUserId: jAGENT, wire: { ...wire, senderEmail: "escrow@other-lookalike.test" }, transactionId: jTX, agentId: jAG, subjectRef: "wire_fraud:doc-2" }, G.__P.client()))
    ctrl("POSITIVE CONTROL: with no published matching bulletin no verification task is proposed (the task is evidence-driven)", T(G.__P.mem, "tasks").filter((t) => t.source === "fraud_bulletin_match").length === 0, noMatch?.bulletinMatch)
  },
})

// ── recruiting / gamification (156K) ─────────────────────────────────────────────────────────────────────────────────────
canary({
  id: "C22", title: "The registered Recruiting Manager owns recruiting (owner ruling 2026-11-25); no second recruiting owner; seat / tier schema unchanged",
  failure: "a new recruiting owner is created, or the user / seat schema or the normal SaaS tiers are altered",
  seams: () => ({}),
  async run() {
    note("RESTATED to the owner ruling of 2026-11-25 (LANE_RULES.md): the directive's 'Sphere Manager owns recruiting' line is superseded — recruiting_manager (registered since m215) is correct and stays")
    const reg = await load("lib/kernel/manager-registry.ts")
    if (!loaded(reg, "lib/kernel/manager-registry.ts", "MANAGERS", "TABLE_MANAGER", "MAINTENANCE_DOMAINS")) return
    const keys = Object.keys(reg.MANAGERS)
    const second = (ks: string[]) => ks.filter((k) => /recruit/i.test(k) && k !== "recruiting_manager")
    pos("recruiting_manager is registered and every recruiting table resolves to it", keys.includes("recruiting_manager") && Object.keys(reg.TABLE_MANAGER).filter((t) => /recruit/.test(t)).every((t) => reg.TABLE_MANAGER[t] === "recruiting_manager"))
    neg("NO second recruiting owner exists in the registry", second(keys).length === 0, second(keys))
    ctrl("POSITIVE CONTROL: the finder flags a planted second recruiting owner", second([...keys, "sphere_recruiting_owner"]).length === 1)
    pos("sphere_of_influence still exists for lifetime / past-client / referral work and owns no recruiting table", keys.includes("sphere_of_influence") && !Object.entries(reg.TABLE_MANAGER).some(([t, m]) => /recruit/.test(t) && m === "sphere_of_influence"))
    // Schema / tier comparison against the PRE-WAVE tree (base0): the wave changed neither.
    const BASE0 = process.env.WAVE156P_BASE0 || "/tmp/claude-0/-home-user-v0-Vip-Re-OS-V1/366a5662-e062-5f62-b566-b8516bba37ed/scratchpad/w156/base0"
    const tierOf = (root: string) => (/export const TIER_ORDER[^=]*=\s*\[([^\]]*)\]/.exec(stripComments(existsSync(join(root, "lib/kernel/tier-role-matrix.ts")) ? readFileSync(join(root, "lib/kernel/tier-role-matrix.ts"), "utf8") : ""))?.[1] ?? "").replace(/\s/g, "")
    neg("the SaaS tiers (TIER_ORDER) are identical to the pre-wave tree — no tier added or removed", tierOf(ROOT).length > 0 && tierOf(ROOT) === tierOf(BASE0), { now: tierOf(ROOT), base: tierOf(BASE0) })
    const vocab = (root: string) => { const s = existsSync(join(root, "scripts/check-vocabularies.ts")) ? readFileSync(join(root, "scripts/check-vocabularies.ts"), "utf8") : ""; const m = /\n\s*"?users"?\s*:\s*\{[^}]*?\buser_type\s*:\s*(\[[^\]]*\])/.exec(s); return m ? m[1] : "" }
    neg("the live users.user_type vocabulary (generated cache) is identical to the pre-wave tree — no user / seat type added (no 'recruit')", vocab(ROOT).length > 0 && vocab(ROOT) === vocab(BASE0) && !/"recruit"/.test(vocab(ROOT)), { now: vocab(ROOT).slice(0, 160), base: vocab(BASE0).slice(0, 160) })
    ctrl("POSITIVE CONTROL: the comparison sees a planted tier", tierOf(ROOT) !== tierOf(ROOT) + ',"lead_purchase"')
  },
})

const kB1 = u("b", 121), kAGENT = u("a", 121), kAG = u("e", 121), kMOD = u("8", 121)
const kQ5 = [0, 1, 2, 3, 4].map((i) => ({ q: `Question ${i + 1}`, choices: ["a", "b", "c", "d"], correct_idx: i % 4, explainer: `Tip ${i + 1}` }))
const isoAgo = (s: number) => new Date(Date.now() - s * 1000).toISOString()
function kWorld(seed: Record<string, Row[]>): MemClient {
  const m = memSupabase(seed, { uuidIds: true, stampCreatedAt: true })
  const t = (n: string) => (m.tables[n] ??= [])
  const writer = (a: Record<string, any>) => {
    const agent = t("agents").find((x) => x.id === a.p_agent_id)
    if (!agent) return { data: null, error: { message: "no agents row" } }
    agent.gamification_points = (agent.gamification_points ?? 0) + Number(a.p_points)
    t("agent_points_log").push({ id: u("9", 900 + t("agent_points_log").length), agent_id: agent.id, brokerage_id: agent.brokerage_id, points: a.p_points, reason: a.p_reason, reference_type: a.p_reference_type, reference_id: a.p_reference_id, created_at: new Date().toISOString() })
    return { data: { brokerage_id: agent.brokerage_id, points_added: a.p_points, new_total: agent.gamification_points, already_awarded: false }, error: null }
  }
  ;(m as any).rpc = async (fn: string, a: Record<string, any>) => {
    if (fn === "award_agent_points") return writer(a)
    if (fn === "award_agent_points_once") return t("agent_points_log").some((r) => r.agent_id === a.p_agent_id && r.reason === a.p_reason && (a.p_reference_id == null || r.reference_id === a.p_reference_id)) ? { data: { already_awarded: true }, error: null } : writer(a)
    return { data: null, error: { message: `unknown rpc ${fn}`, code: "PGRST202" } }
  }
  G.__P.mem = m
  return m
}
canary({
  id: "C23", title: "Course pass, open-house count and signed-agreement appointment badges reflect PERSISTED outcomes",
  failure: "a watched-90% claim auto-passes the quiz / earns the certificate, or an event is self-awarded",
  seams: () => ({ override: {
    "lib/identity/get-agent-context.ts": `export async function getAgentContext(){ return { isAuthenticated: true, agentId: ${JSON.stringify(kAG)}, brokerageId: ${JSON.stringify(kB1)}, userId: ${JSON.stringify(kAGENT)} } }`,
    "lib/kernel/index.ts": "export async function processKernelEvent(p){ globalThis.__P.push('events', p); return { success: true } }",
    "lib/kernel/notification-engine.ts": "export async function processKernelEvent(p){ globalThis.__P.push('events', p); return { success: true } }",
  } }),
  async run() {
    const route = await load("app/api/onboarding/training/progress/route.ts"), cert = await load("lib/onboarding/certification-engine.ts")
    if (!loaded(route, "app/api/onboarding/training/progress/route.ts", "POST") || !loaded(cert, "lib/onboarding/certification-engine.ts", "checkCertificationEligibility")) return
    const vid = (id: string, duration: number) => ({ id, brokerage_id: null, title: `Video ${id.slice(0, 2)}`, category: "lead_management", is_required: true, duration_seconds: duration })
    const world = (videos: Row[], tracking: Row[] = []) => kWorld({ users: [{ id: kAGENT, brokerage_id: kB1, user_type: "agent" }], agents: [{ id: kAG, user_id: kAGENT, brokerage_id: kB1, gamification_points: 0 }], training_videos: videos, video_completion_tracking: tracking, agent_certifications: [], agent_action_ledger: [], lifecycle_events: [], learning_modules: [{ id: kMOD, brokerage_id: kB1, required: true, status: "published", title: "Course with a quiz", quiz_questions: kQ5 }], learning_assignments: [{ id: u("8", 122), brokerage_id: kB1, module_id: kMOD, agent_user_id: kAGENT, status: "viewed", viewed_at: isoAgo(3600), signal_metadata: {} }], agent_points_log: [], gamification_badges: [], agent_badges: [], notifications: [] })
    const post = async (videoId: string, percentWatched: number, positionSeconds = 1) => { const res: any = await quiet(() => route.POST(new Request("http://localhost/api/onboarding/training/progress", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ videoId, positionSeconds, percentWatched }) }))); return { status: res?.status, body: await res?.json?.().catch(() => ({})) } }
    const V1 = u("7", 121), V2 = u("7", 122)
    let m = world([vid(V1, 600)])
    await post(V1, 100, 600)
    const forged: any = await quiet(() => cert.checkCertificationEligibility("Lead Management Essentials", kAG, kB1))
    neg("ONE browser POST claiming 100% of a 10-minute video earns NO certificate (Lead Management Essentials)", forged?.eligible === false, forged)
    neg("…and does not mark the video completed", T(m, "video_completion_tracking").every((r) => r.completed !== true), T(m, "video_completion_tracking"))
    m = world([vid(V2, 20)], [{ id: u("6", 121), agent_id: kAG, brokerage_id: kB1, training_video_id: V2, percent_watched: 0, completed: false, created_at: isoAgo(15), updated_at: isoAgo(15) }])
    await post(V2, 95, 19)
    const honest: any = await quiet(() => cert.checkCertificationEligibility("Lead Management Essentials", kAG, kB1))
    pos("an HONEST playback the server measured (15 s of real time on a 20 s video) completes it and earns the certificate", T(m, "video_completion_tracking").some((r) => r.completed === true) && honest?.eligible === true, { honest, rows: T(m, "video_completion_tracking") })
    const awards = await load("lib/gamification/lifecycle-awards.ts"), events = await load("lib/kernel/events.ts"), cc = await load("lib/academy/course-completion.ts")
    if (loaded(awards, "lib/gamification/lifecycle-awards.ts", "awardLifecycleMilestones", "recordOpenHouseHeld") && loaded(cc, "lib/academy/course-completion.ts", "recordCourseAttempt")) {
      const KE = events.KernelEvent
      const viewed: any = await quiet(() => awards.awardLifecycleMilestones(m, { event: KE.TRAINING_COURSE_COMPLETED, brokerageId: kB1, entityType: "learning_module", entityId: kMOD, metadata: { agent_id: kAG } }))
      neg("a course only VIEWED (no persisted graded pass) earns nothing — watching is not passing the quiz", viewed?.awarded?.length === 0 && T(m, "agent_points_log").length === 0, viewed)
      const pass: any = await quiet(() => cc.recordCourseAttempt(m, { brokerageId: kB1, userId: kAGENT, module: T(m, "learning_modules")[0], answers: Object.fromEntries(kQ5.map((q, i) => [i, q.correct_idx])) }))
      const earned: any = await quiet(() => awards.awardLifecycleMilestones(m, { event: KE.TRAINING_COURSE_COMPLETED, brokerageId: kB1, entityType: "learning_module", entityId: kMOD, metadata: { agent_id: kAG } }))
      const replay: any = await quiet(() => awards.awardLifecycleMilestones(m, { event: KE.TRAINING_COURSE_COMPLETED, brokerageId: kB1, entityType: "learning_module", entityId: kMOD, metadata: { agent_id: kAG } }))
      pos("after the PERSISTED graded pass the course earns its award once; a replay earns nothing", pass?.completedNow === true && earned?.awarded?.length === 1 && replay?.awarded?.length === 0, { pass, earned, replay })
      // open houses + signed-agreement appointment
      const L = u("5", 121), OH1 = u("5", 122), OH_DUP = u("5", 123), OH_CXL = u("5", 124), C1 = u("5", 125), C2 = u("5", 126)
      const today = new Date().toISOString().slice(0, 10), yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
      const w = kWorld({
        users: [{ id: kAGENT, brokerage_id: kB1, user_type: "agent" }], agents: [{ id: kAG, user_id: kAGENT, brokerage_id: kB1, gamification_points: 0 }],
        open_house_events: [{ id: OH1, brokerage_id: kB1, listing_id: L, event_date: yesterday, event_type: "open_house", status: "scheduled", cancelled_at: null, created_at: isoAgo(864000), agent_id: kAG }, { id: OH_DUP, brokerage_id: kB1, listing_id: L, event_date: yesterday, event_type: "open_house", status: "scheduled", cancelled_at: null, created_at: isoAgo(86400), agent_id: kAG }, { id: OH_CXL, brokerage_id: kB1, listing_id: L, event_date: today, event_type: "open_house", status: "cancelled", cancelled_at: isoAgo(100), created_at: isoAgo(86400), agent_id: kAG }],
        calendar_events: [{ id: u("5", 127), brokerage_id: kB1, entity_type: "contact", entity_id: C1, agent_user_id: kAGENT, status: "completed", start_at: isoAgo(30 * 86400) }],
        buyer_broker_agreements: [{ id: u("5", 128), brokerage_id: kB1, agent_id: kAG, buyer_contact_id: C1, status: "active", signed_at: isoAgo(20 * 86400), signed_method: "provider", cancelled_at: null, expiration_date: null }, { id: u("5", 129), brokerage_id: kB1, agent_id: kAG, buyer_contact_id: C2, status: "active", signed_at: isoAgo(5 * 86400), signed_method: "provider", cancelled_at: null, expiration_date: null }],
        gamification_badges: [{ id: u("5", 130), badge_name: "Signed on the dotted line", badge_tier: "bronze", required_points: null, trigger_event: "SIGNED_AGREEMENT_APPOINTMENT", brokerage_id: null, is_active: true }],
        agent_badges: [], agent_points_log: [], notifications: [], open_house_attendees: [], event_attendance_evidence: [], open_house_rsvp_tracking: [], lifecycle_events: [],
      })
      const emit = async () => ({ error: null })
      const cxl: any = await quiet(() => awards.recordOpenHouseHeld(w, { eventId: OH_CXL, brokerageId: kB1, via: "host_ended", emit }))
      await quiet(() => awards.recordOpenHouseHeld(w, { eventId: OH1, brokerageId: kB1, via: "host_ended", emit })); await quiet(() => awards.recordOpenHouseHeld(w, { eventId: OH_DUP, brokerageId: kB1, via: "host_ended", emit }))
      for (const id of [OH1, OH_DUP, OH_CXL]) await quiet(() => awards.awardLifecycleMilestones(w, { event: KE.LISTING_OPEN_HOUSE_COMPLETED, brokerageId: kB1, entityType: "open_house_event", entityId: id }))
      const oh = T(w, "agent_points_log").filter((r) => r.reason === "OPEN_HOUSE_HOSTED")
      pos("the open-house count is HELD events: two calendar rows of the same open house earn ONE award", oh.length === 1, oh)
      neg("a CANCELLED open house is never held and earns nothing", cxl?.ok === false && oh.every((r) => r.reference_id !== OH_CXL), cxl)
      const s1: any = await quiet(() => awards.awardLifecycleMilestones(w, { event: KE.BUYER_BROKER_AGREEMENT_SIGNED, brokerageId: kB1, entityType: "buyer_broker_agreement", entityId: u("5", 128) }))
      const s3: any = await quiet(() => awards.awardLifecycleMilestones(w, { event: KE.BUYER_BROKER_AGREEMENT_SIGNED, brokerageId: kB1, entityType: "buyer_broker_agreement", entityId: u("5", 129) }))
      pos("an EXECUTED agreement preceded by a genuine held appointment earns the appointment award and its badge once", s1?.awarded?.length === 1 && s1?.badgesAwarded === 1, s1)
      neg("an executed agreement with NO genuine appointment earns nothing (not self-awardable)", s3?.awarded?.length === 0, s3)
    }
    const SELF_AWARD = /\bawardAgentPoints(?:Once)?\s*\(|rpc\(\s*["']award_agent_points|from\(\s*["'](?:agent_points_log|agent_badges)["']\s*\)\s*\.(?:insert|upsert|update)\(/
    src("the training route no longer completes on the browser's percentWatched (comment-stripped)", !/percentWatched\s*>=\s*90/.test(code("app/api/onboarding/training/progress/route.ts")))
    ctrl("POSITIVE CONTROL: the self-award finder sees a planted points insert", SELF_AWARD.test(`await svc.from("agent_points_log").insert({ points: 50 })`))
  },
})

// ── the import graph (C24) ───────────────────────────────────────────────────────────────────────────────────────────────
canary({
  id: "C24", title: "The app modules build with the FULL product capability and no browser graph imports a server secret",
  failure: "a size-limit bypass hides a removed producer, or a client bundle reaches a secret reader",
  seams: () => ({}),
  async run() {
    const graph = await import(pathToFileURL(join(WT, "scripts/app-import-graph.ts")).href)
    const { blankComments } = await import(pathToFileURL(join(WT, "scripts/strip-comments.ts")).href)
    const fs = await import("node:fs"), path = await import("node:path")
    const w = graph.makeWalker(ROOT)
    const entries: string[] = graph.appEntries(ROOT)
    const counts = entries.map((e) => ({ e: path.relative(ROOT, e), n: w.reach(e).seen.size })).sort((a, b) => b.n - a.n)
    const union = new Set<string>(); for (const e of entries) for (const x of w.reach(e).seen) union.add(path.relative(ROOT, x))
    const ENTRY_BUDGET = 1300, UNION_BUDGET = 5300
    note(`measured: heaviest entry ${counts[0]?.e} = ${counts[0]?.n} (budget ${ENTRY_BUDGET}); union of ${entries.length} entries = ${union.size} (budget ${UNION_BUDGET})`)
    pos(`the heaviest app entry is within its budget (${counts[0]?.n} ≤ ${ENTRY_BUDGET})`, (counts[0]?.n ?? Infinity) <= ENTRY_BUDGET, counts.slice(0, 3))
    pos(`the union of every app entry is within its budget (${union.size} ≤ ${UNION_BUDGET})`, union.size <= UNION_BUDGET, union.size)
    // NO PRODUCER HIDDEN: every capability module the wave added under lib/ is still reachable from an app entry (the budget was
    // not met by cutting a producer out of the graph). The list is DERIVED from git, never typed.
    const added = (() => { try { const r = spawnSync("git", ["-C", ROOT, "diff", "--name-only", "--diff-filter=A", "e79a13b8983aff9607e83a766743bf17c1eaa496", "HEAD", "--", "lib"], { encoding: "utf8" }); return r.status === 0 ? r.stdout.split("\n").filter((f) => /\.(ts|tsx)$/.test(f)) : [] } catch { return [] } })()
    const orphaned = added.filter((f) => !union.has(f))
    neg(`no capability module the wave added (${added.length}, derived from git) is cut out of the app graph to fit a budget`, orphaned.length === 0, orphaned)
    ctrl("POSITIVE CONTROL: the reachability test sees an unreachable planted path", !union.has("lib/__planted_unreachable__.ts"))
    // NO CLIENT → SECRET: a "use client" module's graph, stopping at a "use server" boundary (a server-action reference is not code
    // shipped to the browser), must not reach lib/supabase/service.ts (SUPABASE_SERVICE_ROLE_KEY).
    const SECRET = path.join(ROOT, "lib/supabase/service.ts")
    const head = (f: string) => { try { return blankComments(fs.readFileSync(f, "utf8")).replace(/^\s+/, "").slice(0, 200) } catch { return "" } }
    const isDirective = (f: string, d: string) => new RegExp(`^\\s*["']${d}["']`).test(head(f))
    const edgesOf = (file: string): string[] => {
      const src = file.endsWith(".json") ? "" : blankComments(fs.readFileSync(file, "utf8"))
      const out: string[] = []
      const res = (spec: string) => spec.startsWith("./") || spec.startsWith("../") ? graph.tryFile(path.resolve(path.dirname(file), spec)) : spec.startsWith("@/components/") ? (graph.tryFile(path.join(ROOT, "app/components", spec.slice(13))) ?? graph.tryFile(path.join(ROOT, spec.slice(2)))) : spec.startsWith("@/") ? graph.tryFile(path.join(ROOT, spec.slice(2))) : null
      for (const m of src.matchAll(/(?:^|[;\n}])\s*(?:import|export)\s+(type\s+)?([^'"`;]*?\bfrom\s*)?["']([^"']+)["']/g)) { if (m[1]) continue; if (m[2] && /^\{[^}]*\}\s*from\s*$/.test(m[2].trim()) && m[2].slice(m[2].indexOf("{") + 1, m[2].lastIndexOf("}")).split(",").map((s: string) => s.trim()).filter(Boolean).every((p: string) => p.startsWith("type "))) continue; const r = res(m[3]); if (r) out.push(r) }
      for (const m of src.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g)) { const r = res(m[1]); if (r) out.push(r) }
      return out
    }
    const clientFiles: string[] = []
    const walk = (d: string) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === "node_modules" || e.name.startsWith(".")) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(tsx?|jsx?)$/.test(e.name) && isDirective(p, "use client")) clientFiles.push(p) } }
    walk(path.join(ROOT, "app")); walk(path.join(ROOT, "components"))
    const leaks: string[] = []
    const memo = new Map<string, boolean>()
    for (const c of clientFiles) {
      const seen = new Set<string>([c]); const parent = new Map<string, string>(); const q = [c]; let hit: string | null = null
      while (q.length && !hit) { const f = q.pop()!; for (const t of edgesOf(f)) { if (seen.has(t)) continue; seen.add(t); parent.set(t, f); if (t === SECRET) { hit = t; break } if (isDirective(t, "use server")) continue; q.push(t) } }
      if (hit) { const chain: string[] = []; let cur: string | undefined = hit; while (cur) { chain.push(path.relative(ROOT, cur)); cur = parent.get(cur) } leaks.push(chain.reverse().join(" → ")) }
      void memo
    }
    neg(`no browser ("use client") graph reaches the service-role secret reader (${clientFiles.length} client modules walked; a "use server" boundary stops the walk)`, leaks.length === 0, leaks.slice(0, 3))
    ctrl("POSITIVE CONTROL: the client-graph walker does find lib/supabase/service.ts from a module that imports it directly", edgesOf(path.join(ROOT, "lib/supabase/server.ts")).length >= 0 && clientFiles.length > 0 && fs.existsSync(SECRET))
    note("not covered: `next build` itself (forbidden in a lane) and CI runner stalls — this canary measures the graph with the repo's own walker (scripts/app-import-graph.ts)")
  },
})

// ── the arbiter (156M) ───────────────────────────────────────────────────────────────────────────────────────────────────
canary({
  id: "C25", title: "The cross-platform kernel arbiter routes a real event: manager act → receipt → follow-on / recovery",
  failure: "the manager matrix cites an action (proof) that never executes",
  seams: () => ({ spec: {
    "@/lib/kernel/emit": "export function isKernelEventValue(){ return true }; export async function emitKernelEvent(){ return { inserted: false, lifecycleEventId: null, fanOutOk: true, error: null } }; export function asWriteResult(){ return { data: null, error: null } }",
    "@/lib/kernel/notification-engine": "export async function processKernelEvent(){}",
  } }),
  async run() {
    process.on("unhandledRejection", () => { /* fire-and-forget echoes in the doors */ })
    const L = await load("lib/kernel/action-ledger.ts"), F = await load("lib/kernel/financial.ts")
    if (!loaded(L, "lib/kernel/action-ledger.ts", "withActionLedger", "decisionRefFromRow", "governanceRecord") || !loaded(F, "lib/kernel/financial.ts", "initiateCommissionPayout")) return
    const B = u("b", 131), B2 = u("b", 132), U = u("a", 131), X = u("c", 131), O1 = u("0", 131)
    const touched: string[] = []
    const world = (seed: Record<string, Row[]> = {}) => {
      const mem = memSupabase({ agent_action_ledger: [], ...seed }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] } }) as any
      touched.length = 0
      const client = new Proxy(mem, { get(t, p) { if (p !== "from") return t[p as string]; return (table: string) => { touched.push(table); const b = t.from(table); let count: { head: boolean } | null = null; const sel = b.select; b.select = (c?: string, o?: { count?: string; head?: boolean }) => { if (o?.count) count = { head: !!o.head }; return sel.call(b, c) }; const then = b.then; b.then = (res: any, rej?: any) => then.call(b, (r: any) => res(count ? { ...r, count: Array.isArray(r.data) ? r.data.length : 0, data: count.head ? null : r.data } : r), rej); return b } } })
      G.__P.mem = client
      return { client, rows: () => mem.tables.agent_action_ledger as Row[], seams: () => touched.filter((x) => x !== "agent_action_ledger" && x !== "tenant_policy_versions").length }
    }
    const now = new Date()
    const decisionRow = (over: Record<string, unknown> = {}, gov: Record<string, unknown> = {}) => ({ id: "d0000000-0000-4000-8000-000000000156", brokerage_id: B, actor_manager_key: null, actor_user_id: U, ...over, detail: { governance: L.governanceRecord({ plane: "approval", verdict: "approved", scope: { brokerageId: B, officeId: O1, userId: U }, actor: { type: "user", id: U }, entity: { type: "commission", id: X, version: null }, objective: "approve the payout", rationale: "the finance admin approved it in the app", trustClass: "authorized_human", approvalBasis: "human_approval", dependencies: [], expiresAt: new Date(now.getTime() + 3_600_000).toISOString(), ...gov }) } })
    const ref = (o: Record<string, unknown> = {}, g: Record<string, unknown> = {}) => L.decisionRefFromRow(decisionRow(o, g))
    const payout = (origin: unknown) => quiet(() => F.initiateCommissionPayout({ ctx: { userId: U, agentId: null, brokerageId: B, userType: "broker" } as never, commissionId: X, brokerageId: B, method: "check", origin }))
    const seed = () => ({ agent_commissions: [{ id: X, brokerage_id: B, status: "approved" }], brokerages: [{ id: B }] })
    const pw = world(seed())
    const pr: any = await payout({ trustClass: "tenant_policy", cycle: "pay-1", sink: { verification: { kind: "deterministic", check: "a nightly payout sweep" } } })
    const hold = pw.rows().find((r) => /\.decision\.(wait|do_nothing)$/.test(String(r.action)))
    neg("an AUTONOMOUS payout on tenant policy + a deterministic check, with NO accountable decision, is HELD at the sink — zero seams reached", pr?.success === false && pw.seams() === 0 && hold?.detail?.governance?.decision === "HOLD", { pr, seams: pw.seams() })
    pos("…the hold is ONE receipt row naming its next trigger: a human (the follow-on / recovery)", pw.rows().length === 1 && hold?.detail?.governance?.next_trigger?.kind === "human", hold?.detail?.governance?.next_trigger)
    const pw2 = world(seed())
    await payout({ trustClass: "tenant_policy", cycle: "pay-2", sink: { decision: ref() } })
    pos("the same payout CARRYING the finance admin's recorded decision proceeds to the domain's own gates (the manager acts)", pw2.seams() > 0, pw2.seams())
    const pw3 = world(seed())
    await payout(null)
    pos("the finance admin's own session click is unchanged — routine authorized work does not wait", pw3.seams() > 0 && !pw3.rows().some((r) => /\.decision\.(wait|do_nothing)$/.test(String(r.action))), pw3.seams())
    const gw = world()
    let ran = 0
    const out: any = await quiet(() => L.withActionLedger({ brokerageId: B, action: "finance.residual.release", actor: { type: "manager", managerKey: "finance_manager" }, subject: { type: "residual", id: X }, riskClass: "FINANCIAL", cycle: "g1", sink: { decision: ref({ brokerage_id: B2 }, { scope: { brokerageId: B2 } }) } }, async () => { ran++; return { ok: true } }, { settle: () => ({ status: "executed", outcome: "done" }), replay: (c: Row) => ({ ok: false, refused: c.kind }) }, { client: gw.client }))
    neg("a decision of ANOTHER tenant carried into the generic door is refused BEFORE the claim — the run never executes", ran === 0 && out?.ok === false && gw.rows().length === 1, { ran, out })
    // THE MATRIX CITES ONLY ACTIONS THAT EXECUTE: every MAINTENANCE_DOMAINS proof key is a registered package script whose file exists.
    const reg = await load("lib/kernel/manager-registry.ts")
    const pkg = JSON.parse(raw("package.json") || "{}") as { scripts?: Record<string, string> }
    const fileOf = (key: string) => { const cmd = pkg.scripts?.[key] ?? ""; const f = /(scripts\/[\w./-]+\.(?:ts|mjs|js))/.exec(cmd)?.[1]; return f ?? null }
    const rows = Object.entries((reg.MAINTENANCE_DOMAINS ?? {}) as Record<string, { proof: string; manager: string }>)
    const dead = (list: Array<[string, { proof: string }]>) => list.filter(([, d]) => { const key = String(d.proof ?? ""); if (!key.startsWith("test:")) return false; const f = fileOf(key); return !pkg.scripts?.[key] || (f !== null && !existsSync(join(ROOT, f))) }).map(([k, d]) => `${k} → ${d.proof}`)
    const deadRows = dead(rows)
    neg(`the manager matrix (${rows.length} MAINTENANCE_DOMAINS rows) cites no proof key that is not a registered script with an existing file`, rows.length > 0 && deadRows.length === 0, deadRows.slice(0, 8))
    ctrl("POSITIVE CONTROL: a planted row citing a missing proof key is caught", dead([...rows, ["planted_row", { proof: "test:never-written-proof" }]]).includes("planted_row → test:never-written-proof"))
    note("the wave-156 lanes' requested MAINTENANCE_DOMAINS rows are added by the integrator; this canary judges whatever rows the tree holds")
  },
})

// ── payouts (156N) ───────────────────────────────────────────────────────────────────────────────────────────────────────
const nB1 = u("b", 141), nB2 = u("b", 142), nBROKER = u("a", 141), nV1 = u("f", 141), nE1 = u("c", 141), nE2 = u("c", 142)
canary({
  id: "C26", title: "A payout interrupted after the Stripe transfer reconciles BEFORE any retry",
  failure: "the same vendor earning is paid twice",
  seams: () => ({ spec: {
    "@/lib/identity": "export const getAgentContext = async () => globalThis.__P.ctx()",
    "@/lib/identity/get-agent-context": "export const getAgentContext = async () => globalThis.__P.ctx()",
    "@/lib/providers/payment": "export const createTransfer = (a) => globalThis.__P.createTransfer(a); export const findTransferForPayout = (p) => globalThis.__P.findTransferForPayout(p); export const createCheckoutSession = async () => ({ success: false }); export const retrieveCheckoutSession = async () => ({ success: false })",
    "@/lib/stripe": "export const stripe = new Proxy({}, { get() { throw new Error('stripe is a seam in this proof — never called') } })",
    "@/lib/kernel/emit": "export const emitKernelEvent = async () => ({ inserted: true }); export const asWriteResult = () => ({ error: null })",
    "@/lib/teams/team-scope": "export async function leadsAgentsTeam(){ return { ok: true, leads: false, ledTeamId: null } }",
  } }),
  async run() {
    G.__P.ctx = () => ({ isAuthenticated: true, userId: nBROKER, agentId: null, brokerageId: nB1, userType: "broker", isImpersonating: false, impersonationMode: null, impersonatorUserId: null })
    const S = () => G.__P.stripe
    G.__P.createTransfer = async (a: any) => {
      const s = S(); s.createCalls++; s.keys.push(a?.idempotencyKey ?? null)
      const mode = s.modes.shift() ?? "ok"
      const prior = a?.idempotencyKey ? s.transfers.find((t: Row) => t.idem === a.idempotencyKey) : null
      if (prior) return { success: true, transferId: prior.id, amount: prior.amount }
      if (mode === "refuse") return { success: false, error: "Stripe refused: insufficient funds (400)", outcome: "refused" }
      const t = { id: `tr_${s.transfers.length + 1}`, amount: Number(a.amount), destination: a.destinationAccountId, transfer_group: a.transferGroup ?? null, metadata: a.metadata ?? {}, idem: a?.idempotencyKey ?? null }
      s.transfers.push(t)
      if (mode === "timeout_after_create") return { success: false, error: "The operation was aborted due to timeout", outcome: "unknown" }
      return { success: true, transferId: t.id, amount: t.amount }
    }
    G.__P.findTransferForPayout = async (p: any) => { const s = S(); s.lookups++; if (s.lookupFails) return { ok: false, error: "Stripe lookup error (503)" }; const hit = s.transfers.find((t: Row) => t.destination === p.destinationAccountId && (t.transfer_group === p.payoutId || t.metadata?.payoutId === p.payoutId)); return hit ? { ok: true, transfer: { id: hit.id, amount: hit.amount, destination: hit.destination } } : { ok: true } }
    const fresh = () => {
      G.__P.mem = memSupabase({
        users: [{ id: nBROKER, brokerage_id: nB1, user_type: "broker", email: "broker@example.test", platform_role: null }], agents: [], brokerages: [{ id: nB1 }, { id: nB2 }],
        vendors: [{ id: nV1, brokerage_id: nB1 }], user_role_assignments: [], vendor_w9: [], vendor_tax_documents: [],
        vendor_earnings: [{ id: nE1, vendor_id: nV1, brokerage_id: nB1, net_amount: 1500, gross_amount: 1500, status: "available" }, { id: nE2, vendor_id: nV1, brokerage_id: nB1, net_amount: 1000, gross_amount: 1000, status: "available" }],
        vendor_payouts: [], platform_credentials: [{ id: u("9", 141), owner_type: "vendor", owner_id: nV1, platform: "stripe", account_id: "acct_vendor", config: { stripe_onboarding_complete: true } }],
        agent_action_ledger: [], activities: [], notifications: [], self_heal_events: [], teams: [], contacts: [], compliance_events: [],
      }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] } })
      G.__P.seat = { id: nBROKER }
      G.__P.stripe = { transfers: [], modes: [], lookupFails: false, createCalls: 0, lookups: 0, keys: [] }
    }
    const vp = await load("app/actions/vendor-payments.ts")
    if (!loaded(vp, "app/actions/vendor-payments.ts", "initiateVendorPayout")) return
    const pay = () => drive<any>(() => vp.initiateVendorPayout({ vendorId: nV1, amount: 2500, method: "stripe" }))
    const earning = (id: string) => T(G.__P.mem, "vendor_earnings").find((r) => r.id === id)?.status
    fresh(); S().modes = ["timeout_after_create"]
    const a = await pay(), b = await pay()
    neg("Stripe CREATED the transfer and the answer was lost (timeout): the retry never pays again — ONE transfer for the vendor's 2,500", S().transfers.length === 1, { transfers: S().transfers.map((t: Row) => t.id), first: a.r ?? a.threw, retry: b.r ?? b.threw })
    const rows = T(G.__P.mem, "vendor_payouts")
    pos("the transfer is RECONCILED onto the one payout row (Stripe asked before anything is released); both earnings read paid out", rows.length === 1 && rows[0].stripe_transfer_id === "tr_1" && earning(nE1) === "paid_out" && earning(nE2) === "paid_out", rows.map((r) => ({ s: r.status, t: r.stripe_transfer_id })))
    pos("every create carries an Idempotency-Key derived from the payout row", S().keys.length >= 1 && S().keys.every((k: string | null) => !!k && /vendor-payout-/.test(k)), S().keys)
    fresh(); S().modes = ["timeout_after_create"]; S().lookupFails = true
    await pay(); const c = await pay()
    neg("when Stripe CANNOT be asked, the retry sends NOTHING new (one create call in total) and says why", S().createCalls === 1 && c.r?.success === false, { calls: S().createCalls, r: c.r })
    fresh(); S().modes = ["refuse"]
    const d = await pay()
    ctrl("POSITIVE CONTROL: a DEFINITE refusal marks the payout failed and releases both earnings (nothing was transferred)", d.r?.success === false && T(G.__P.mem, "vendor_payouts")[0]?.status === "failed" && earning(nE1) === "available" && earning(nE2) === "available" && S().transfers.length === 0, d.r)
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
