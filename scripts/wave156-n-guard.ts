#!/usr/bin/env tsx
/**
 * scripts/wave156-n-guard.ts — wave 156, lane 156N. PRIOR-WAVE LOOSE ENDS THAT STILL HARM THE CUSTOMER, DRIVEN.
 *
 * §A  C26 — A VENDOR PAYOUT IS PAID ONCE when the answer to the Stripe transfer is lost. initiateVendorPayout
 *     (app/actions/vendor-payments.ts) is DRIVEN on the in-memory client against a COUNTED Stripe stub that keeps its own ledger of
 *     transfers and honors the Idempotency-Key header the way Stripe does (same key → the original transfer back):
 *       A1 Stripe created the transfer and then timed out → the retry finds it and records it; ONE transfer exists (red at base: two).
 *       A2 the process died between the transfer and the row update → the retry records the transfer on the row (red at base: the
 *          row stays 'pending' with no transfer id forever).
 *       A3 unknown answer and nothing landed → the earnings stay reserved; the retry re-sends under the SAME idempotency key.
 *       A4 a definite refusal → 'failed' and the earnings come back (positive control: the old honest path still works).
 *       A5 the lookup itself fails → nothing new is sent (red at base: a second transfer is attempted).
 * §B  TCPA — a signed listing agreement alone does not clear an automated CAMPAIGN text, while a servicing text (transactional,
 *     conversation, unstated) is still permitted. evaluateOutboundCompliance (lib/kernel/communication-compliance.ts) is DRIVEN with
 *     the in-memory client; the kernel content gate (lib/kernel/compliance.ts) is held by a stripped-source rule with a control.
 * §C  CDA DOORS, BODIES — every CDA update in app/actions/cda-portal.ts pins the tenant AND the admitted deal and is selected and
 *     counted (derived from comment-stripped source, positive control); manualOverrideCdaAction is DRIVEN with a cookie client whose
 *     row security refuses the update silently (red at base: it reported success with nothing written); a wrong-tenant CDA writes
 *     nothing; the door gate asks the shared requireDealDesk (one helper).
 *
 * RED AT BASE: W156N_ROOT=<base tree> runs the same checks against the starting commit.
 * BLIND SPOTS (published): Stripe is a stub — the real Idempotency-Key semantics (24 h key lifetime, 409 while in flight) are
 * modeled, not exercised; the list-by-destination lookup is modeled on the documented v1/transfers filters (not verified live).
 * The kernel content gate is source-checked, not driven (it needs brand-voice and fair-housing seams). dispatchSms does not yet pass
 * the purpose into evaluateOutboundCompliance (integrator request) — §B drives the gate directly. The CDA wrong-PARENT write is
 * held by the source rule (every update pins the admitted deal); only the wrong-tenant and the silent-refusal cases are driven.
 */
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { registerHooks } from "node:module"
import { stripComments } from "./strip-comments"
import { memSupabase, type MemClient, type Row } from "./in-memory-supabase"

const ROOT = process.env.W156N_ROOT || process.cwd()
let passed = 0, failed = 0
const fails: string[] = []
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; fails.push(name); console.log(`  ✗ ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)?.slice(0, 400)}` : ""}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const raw = (f: string) => { const p = join(ROOT, f); return existsSync(p) ? readFileSync(p, "utf8") : "" }

// ── ids ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const u = (p: string, n: number) => `${p}${String(n).padStart(7, "0")}-0000-4000-8000-000000000156`
const B1 = u("b", 1), B2 = u("b", 2)
const U_BROKER = u("a", 1), U_AGENT = u("a", 2), U_CO = u("a", 3), U_X = u("a", 4)
const AG_A = u("e", 1), AG_X = u("e", 2)
const V1 = u("f", 1), E1 = u("c", 1), E2 = u("c", 2)
const TX1 = u("d", 1), TX_X = u("d", 2), CDA1 = u("2", 1), CDA_X = u("2", 2)
const C1 = u("1", 1)

// ── seams (installed BEFORE any app module loads) ─────────────────────────────────────────────────────────────────────────
const G = globalThis as any
G.__N = {
  mem: null as MemClient | null, seat: null as string | null, rlsRefuseCdaUpdate: false,
  stripe: { transfers: [] as Row[], modes: [] as string[], lookupFails: false, createCalls: 0, lookups: 0, keys: [] as Array<string | null> },
}
G.__N.cookie = () => {
  const m = G.__N.mem as MemClient
  const auth = { getUser: async () => ({ data: { user: G.__N.seat ? { id: G.__N.seat, email: "seat@example.test", user_metadata: {} } : null }, error: null }) }
  return {
    ...m, auth,
    from: (t: string) => {
      const b: any = m.from(t)
      if (t !== "closing_disclosure_agreement" || !G.__N.rlsRefuseCdaUpdate) return b
      // ROW SECURITY REFUSING AN UPDATE: PostgREST answers with no error and zero rows — exactly a matched-nothing write.
      return { ...b, update: (v: unknown) => b.update(v).eq("id", "00000000-0000-4000-8000-000000000000") }
    },
  }
}
G.__N.service = () => Object.assign(G.__N.mem as MemClient, { auth: { getUser: async () => ({ data: { user: null }, error: null }) } })
G.__N.ctx = () => {
  const m = G.__N.mem as MemClient
  const user = G.__N.seat ? (m.tables.users ?? []).find((r: Row) => r.id === G.__N.seat) : null
  const agent = user ? (m.tables.agents ?? []).find((a: Row) => a.user_id === user.id) : null
  return user
    ? { isAuthenticated: true, userId: user.id, agentId: agent?.id ?? null, brokerageId: user.brokerage_id, userType: user.user_type, isImpersonating: false, impersonationMode: null, impersonatorUserId: null }
    : { isAuthenticated: false, userId: "", agentId: null, brokerageId: null, userType: "agent", isImpersonating: false, impersonationMode: null, impersonatorUserId: null }
}
// THE COUNTED STRIPE STUB. A transfer is a row in its own ledger; an Idempotency-Key that was used before hands back the transfer it
// created (Stripe's documented replay); each call consumes one scripted mode.
G.__N.createTransfer = async (a: any) => {
  const S = G.__N.stripe
  S.createCalls++; S.keys.push(a?.idempotencyKey ?? null)
  const mode = S.modes.shift() ?? "ok"
  const prior = a?.idempotencyKey ? S.transfers.find((t: Row) => t.idem === a.idempotencyKey) : null
  if (prior) return { success: true, transferId: prior.id, amount: prior.amount }
  if (mode === "refuse") return { success: false, error: "Stripe refused: insufficient funds (400)", outcome: "refused" }
  if (mode === "timeout_before_create") return { success: false, error: "The operation was aborted due to timeout", outcome: "unknown" }
  const t = { id: `tr_${S.transfers.length + 1}`, amount: Number(a.amount), destination: a.destinationAccountId, transfer_group: a.transferGroup ?? null, metadata: a.metadata ?? {}, idem: a?.idempotencyKey ?? null }
  S.transfers.push(t)
  if (mode === "timeout_after_create") return { success: false, error: "The operation was aborted due to timeout", outcome: "unknown" }
  if (mode === "crash_after_create") throw new Error("the process died after Stripe answered")
  return { success: true, transferId: t.id, amount: t.amount }
}
G.__N.findTransferForPayout = async (p: any) => {
  const S = G.__N.stripe
  S.lookups++
  if (S.lookupFails) return { ok: false, error: "Stripe lookup error (503)" }
  const hit = S.transfers.find((t: Row) => t.destination === p.destinationAccountId && (t.transfer_group === p.payoutId || t.metadata?.payoutId === p.payoutId))
  return hit ? { ok: true, transfer: { id: hit.id, amount: hit.amount, destination: hit.destination } } : { ok: true }
}

const BY_SPEC: Record<string, string> = {
  "server-only": "export {}",
  "next/cache": "export function revalidatePath(){}; export function revalidateTag(){}; export function unstable_noStore(){}; export function unstable_cache(f){ return f }",
  "next/headers": "export async function headers(){ return new Map() }; export async function cookies(){ return { get(){}, getAll(){ return [] }, set(){}, delete(){} } }",
  "@/lib/supabase/server": "export async function createClient(){ return globalThis.__N.cookie() }; export async function createServerClient(){ return globalThis.__N.cookie() }",
  "@/lib/supabase/service": "export function createServiceClient(){ return globalThis.__N.service() }",
  "@/lib/identity": "export const getAgentContext = async () => globalThis.__N.ctx()",
  "@/lib/identity/get-agent-context": "export const getAgentContext = async () => globalThis.__N.ctx()",
  "@/lib/providers/payment": [
    "export const createTransfer = (a) => globalThis.__N.createTransfer(a)",
    "export const findTransferForPayout = (p) => globalThis.__N.findTransferForPayout(p)",
    "export const createCheckoutSession = async () => ({ success: false }); export const retrieveCheckoutSession = async () => ({ success: false })",
  ].join("\n"),
  "@/lib/stripe": "export const stripe = new Proxy({}, { get() { throw new Error('stripe is a seam in this proof — never called') } })",
  "@/lib/kernel/emit": "export const emitKernelEvent = async () => ({ inserted: true }); export const asWriteResult = () => ({ error: null })",
  "@/lib/teams/team-scope": "export async function leadsAgentsTeam(){ return { ok: true, leads: false, ledTeamId: null } }",
}
const dataUrl = (code: string) => `data:text/javascript,${encodeURIComponent(code)}`
function aliasPath(rel: string): string | null {
  for (const c of [rel, `${rel}.ts`, `${rel}.tsx`, `${rel}/index.ts`, `${rel}/index.tsx`]) {
    const p = join(ROOT, c)
    if (existsSync(p) && !statSync(p).isDirectory()) return p
  }
  return null
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    if (BY_SPEC[spec] !== undefined) return { url: dataUrl(BY_SPEC[spec]), shortCircuit: true }
    const aliased = spec.startsWith("@/") ? aliasPath(spec.slice(2)) : null
    return aliased ? { url: pathToFileURL(aliased).href, shortCircuit: true } : next(spec, ctx)
  },
})
const load = async (p: string): Promise<any> => { if (!existsSync(join(ROOT, p))) throw new Error(`${p} does not exist in ${ROOT}`); return import(pathToFileURL(join(ROOT, p)).href) }
const quiet = async <X,>(fn: () => Promise<X>): Promise<X> => {
  const w = console.warn, e = console.error, l = console.log
  console.warn = () => {}; console.error = () => {}; console.log = () => {}
  try { return await fn() } finally { console.warn = w; console.error = e; console.log = l }
}
async function drive<X>(fn: () => Promise<X>): Promise<{ r: any; threw: string | null }> {
  try { return { r: await quiet(fn), threw: null } } catch (e) { return { r: undefined, threw: (e as Error)?.message ?? String(e) } }
}

const USERS: Row[] = [
  { id: U_BROKER, brokerage_id: B1, user_type: "broker", email: "broker@example.test", platform_role: null },
  { id: U_AGENT, brokerage_id: B1, user_type: "agent", email: "agent@example.test", platform_role: null },
  { id: U_CO, brokerage_id: B1, user_type: "compliance_officer", email: "co@example.test", platform_role: null },
  { id: U_X, brokerage_id: B2, user_type: "compliance_officer", email: "x@example.test", platform_role: null },
]
const AGENTS: Row[] = [{ id: AG_A, user_id: U_AGENT, brokerage_id: B1, team_id: null }, { id: AG_X, user_id: null, brokerage_id: B2, team_id: null }]
function world(extra: Record<string, Row[]> = {}): MemClient {
  return memSupabase({
    users: USERS.map((r) => ({ ...r })), agents: AGENTS.map((r) => ({ ...r })), brokerages: [{ id: B1 }, { id: B2 }],
    vendors: [{ id: V1, brokerage_id: B1 }], user_role_assignments: [], vendor_w9: [], vendor_tax_documents: [],
    vendor_earnings: [
      { id: E1, vendor_id: V1, brokerage_id: B1, net_amount: 1500, gross_amount: 1500, status: "available" },
      { id: E2, vendor_id: V1, brokerage_id: B1, net_amount: 1000, gross_amount: 1000, status: "available" },
    ],
    vendor_payouts: [],
    platform_credentials: [{ id: u("9", 1), owner_type: "vendor", owner_id: V1, platform: "stripe", account_id: "acct_vendor", config: { stripe_onboarding_complete: true } }],
    agent_action_ledger: [], activities: [], notifications: [], self_heal_events: [],
    transactions: [
      { id: TX1, brokerage_id: B1, agent_id: AG_A, status: "under_contract", stage: "CLOSING_PREP", deleted_at: null },
      { id: TX_X, brokerage_id: B2, agent_id: AG_X, status: "under_contract", stage: "CLOSING_PREP", deleted_at: null },
    ],
    closing_disclosure_agreement: [
      { id: CDA1, transaction_id: TX1, brokerage_id: B1, agent_id: AG_A, status: "submitted", revision_number: 1, field_values: {}, manual_override_by: null },
      { id: CDA_X, transaction_id: TX_X, brokerage_id: B2, agent_id: AG_X, status: "submitted", revision_number: 1, field_values: {}, manual_override_by: null },
    ],
    closing_disclosure_agreement_revisions: [], transaction_coordinators: [], transaction_assignments: [], teams: [], contacts: [],
    listing_agreements: [], buyer_broker_agreements: [], offers: [], communication_compliance_log: [], compliance_events: [],
    ...extra,
  }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] } })
}
function fresh(seat: string | null, extra: Record<string, Row[]> = {}) {
  G.__N.mem = world(extra); G.__N.seat = seat; G.__N.rlsRefuseCdaUpdate = false
  G.__N.stripe = { transfers: [], modes: [], lookupFails: false, createCalls: 0, lookups: 0, keys: [] }
}
const T = (t: string): Row[] => (G.__N.mem as MemClient).tables[t] ?? []
const earning = (id: string) => T("vendor_earnings").find((r) => r.id === id)?.status

// ═══ §A — C26 ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
async function sectionA() {
  section("§A · C26 — a vendor payout interrupted between the Stripe transfer and the row update is paid ONCE")
  const vp = await quiet(() => load("app/actions/vendor-payments.ts"))
  const pay = () => drive(() => vp.initiateVendorPayout({ vendorId: V1, amount: 2500, method: "stripe" }))

  // A1 — Stripe created the transfer, the answer was lost (timeout)
  fresh(U_BROKER); G.__N.stripe.modes = ["timeout_after_create"]
  const a1 = await pay()
  const a1b = await pay()
  const S1 = G.__N.stripe
  check("A1 NEG · Stripe created the transfer and the answer was lost: the retry never pays again — ONE transfer exists for the vendor's 2,500",
    S1.transfers.length === 1, { transfers: S1.transfers.map((t: Row) => t.id), first: a1.r ?? a1.threw, retry: a1b.r ?? a1b.threw })
  const rows1 = T("vendor_payouts")
  check("A1 · the transfer id is reconciled onto the ONE payout row ('processing'), and both earnings read paid out",
    rows1.length === 1 && rows1[0].stripe_transfer_id === "tr_1" && rows1[0].status === "processing" && earning(E1) === "paid_out" && earning(E2) === "paid_out",
    rows1.map((r) => ({ s: r.status, t: r.stripe_transfer_id })))
  check("A1 · the lost answer is reconciled in the SAME call (Stripe is asked before anything is released): the request reads as success, and the retry finds nothing new to pay", a1.r?.success === true && a1b.r?.success === false, { first: a1.r, retry: a1b.r })

  // A2 — the process died between the transfer and the row update
  fresh(U_BROKER); G.__N.stripe.modes = ["crash_after_create"]
  await pay()
  const pending = (({ status, stripe_transfer_id }) => ({ status, stripe_transfer_id }))(T("vendor_payouts")[0] ?? {} as Row) // a SNAPSHOT: the retry updates the same row object in place
  const a2b = await pay()
  const rows2 = T("vendor_payouts")
  check("A2 · after a crash the row was left 'pending' with no transfer id (the interrupted state is real)", pending.status === "pending" && pending.stripe_transfer_id == null, pending)
  check("A2 NEG · the next request reconciles BEFORE any new transfer: the row carries Stripe's transfer id, still ONE transfer",
    G.__N.stripe.transfers.length === 1 && rows2.length === 1 && rows2[0].stripe_transfer_id === "tr_1" && rows2[0].status === "processing", { rows: rows2.map((r) => ({ s: r.status, t: r.stripe_transfer_id })), retry: a2b.r ?? a2b.threw })

  // A3 — unknown answer, nothing landed: earnings stay reserved; the re-send uses the SAME idempotency key
  fresh(U_BROKER); G.__N.stripe.modes = ["timeout_before_create"]
  const a3 = await pay()
  const reserved = earning(E1) === "paid_out" && earning(E2) === "paid_out" && T("vendor_payouts")[0]?.status === "pending"
  check("A3 · an unknown answer never releases the earnings (they stay reserved on a 'pending' payout) and the call does not claim success", a3.r?.success === false && reserved, { r: a3.r, payouts: T("vendor_payouts") })
  const a3b = await pay()
  const keys = G.__N.stripe.keys as Array<string | null>
  check("A3 · the retry re-sends under the SAME idempotency key and Stripe now holds exactly one transfer, recorded on the row",
    keys.length === 2 && !!keys[0] && keys[0] === keys[1] && G.__N.stripe.transfers.length === 1 && T("vendor_payouts")[0]?.stripe_transfer_id === "tr_1", { keys, r: a3b.r })

  // A4 — a definite refusal (positive control: the honest failed path)
  fresh(U_BROKER); G.__N.stripe.modes = ["refuse"]
  const a4 = await pay()
  check("A4 · POSITIVE CONTROL: a definite refusal marks the payout 'failed' and BOTH earnings are available again; nothing was transferred",
    a4.r?.success === false && T("vendor_payouts")[0]?.status === "failed" && earning(E1) === "available" && earning(E2) === "available" && G.__N.stripe.transfers.length === 0, { r: a4.r, rows: T("vendor_payouts") })

  // A5 — the lookup itself fails: nothing new is sent
  fresh(U_BROKER); G.__N.stripe.modes = ["timeout_after_create"]; G.__N.stripe.lookupFails = true
  await pay()
  const a5 = await pay()
  check("A5 NEG · when Stripe cannot be asked, the retry sends NOTHING (one create call in total) and says why", G.__N.stripe.createCalls === 1 && a5.r?.success === false, { calls: G.__N.stripe.createCalls, r: a5.r })

  // provider half: the Idempotency-Key header and the failure classification (pure)
  const pay2 = raw("lib/providers/payment/index.ts")
  const code = stripComments(pay2)
  check("the provider sends the Idempotency-Key header and the transfer_group on the transfer create", /"Idempotency-Key":\s*opts\.idempotencyKey/.test(code) && /form\.transfer_group\s*=\s*params\.transferGroup/.test(code))
  check("the payout writer derives the key from the payout row (same row → same key)", /vendor-payout-\$\{payoutId\}/.test(stripComments(raw("app/actions/vendor-payments.ts"))))
  const realPay = pay2 ? await quiet(() => import(pathToFileURL(join(ROOT, "lib/providers/payment/index.ts")).href + "?real")).catch(() => null) : null
  const tfo = realPay?.transferFailureOutcome
  check("classification: no status / 5xx / 409 / 429 are UNKNOWN; 400 / 402 / 404 are definite refusals",
    typeof tfo === "function" && [null, 500, 503, 409, 429].every((s) => tfo(s) === "unknown") && [400, 402, 404].every((s) => tfo(s) === "refused"))
}

// ═══ §B — TCPA purpose ═══════════════════════════════════════════════════════════════════════════════════════════════════
async function sectionB() {
  section("§B · TCPA — a signed listing agreement supports SERVICING contact, not an automated MARKETING text")
  const cc = await quiet(() => load("lib/kernel/communication-compliance.ts"))
  const contact = (over: Row = {}) => ({ id: C1, brokerage_id: B1, tcpa_consent: false, dnc_status: false, sms_opt_out: false, email_opt_out: false, phone_opt_out: false, direct_mail_opt_out: false, state: "FL", status: "active", opt_out_channels: [], ...over })
  const signed = { listing_agreements: [{ id: u("7", 1), brokerage_id: B1, seller_contact_id: C1, esign_status: "fully_signed" }] }
  const ask = async (purpose: string | undefined, c: Row = contact(), extra: Record<string, Row[]> = signed) => {
    fresh(null, extra)
    const r = await drive(() => cc.evaluateOutboundCompliance({ contact: c, channel: "sms", content: "Hi", actorContext: { brokerageId: B1, actorType: "system" }, ...(purpose ? { channelPurpose: purpose } : {}) }))
    return r.r ?? { threw: r.threw }
  }
  const camp = await ask("campaign")
  check("NEG · a fully signed listing agreement and NO consent record: an automated CAMPAIGN text is refused (no_tcpa_consent)", camp.allowed === false && camp.primaryReason === "no_tcpa_consent", camp)
  for (const p of ["transactional", "conversation", "update"]) {
    const r = await ask(p)
    check(`POS · the same contact: a ${p} (servicing) text is still permitted by the representation`, r.allowed === true, r)
  }
  const unstated = await ask(undefined)
  check("POS · an UNSTATED purpose keeps the previous behavior (servicing is never cut off by a caller that did not say)", unstated.allowed === true, unstated)
  const none = await ask("transactional", contact(), {})
  check("CONTROL · with no agreement and no consent, even a servicing text is refused (the representation is what carried it)", none.allowed === false, none)
  const consented = await ask("campaign", contact({ tcpa_consent: true }))
  check("CONTROL · real consent on file: a campaign text is permitted (the rule narrows representation only)", consented.allowed === true, consented)
  const optedOut = await ask("transactional", contact({ sms_opt_out: true }))
  check("CONTROL · an SMS opt-out still blocks a servicing text (opt-out honored on every purpose)", optedOut.allowed === false, optedOut)

  const ar = await quiet(() => load("lib/kernel/compliance/active-representation.ts"))
  check("the pure rule: campaign is never covered; conversation / update / transactional / unstated are",
    typeof ar.representationConsentCovers === "function" && ar.representationConsentCovers("campaign") === false && ["conversation", "update", "transactional", undefined].every((p) => ar.representationConsentCovers(p) === true))
  const kernel = stripComments(raw("lib/kernel/compliance.ts"))
  const rule = (src: string) => /representationConsentCovers\(\s*params\.channelPurpose\s*\)\s*&&\s*\(await hasActiveRepresentation\(/.test(src)
  check("the kernel content gate (Gate 2) asks the same rule before treating representation as consent (stripped source)", rule(kernel))
  check("POSITIVE CONTROL: the source rule sees an unconditional representation fallback as wrong", !rule("tcpaConsent ||\n (await hasActiveRepresentation(supabase, contact.id, b))"))
  const memo = raw("docs/legal/TCPA-REPRESENTATION-CONSENT-COUNSEL-MEMO-DRAFT.md")
  check("the counsel memo exists, carries the DRAFT banner and lists questions for counsel", /NOT APPROVED FOR USE/.test(memo.split("\n").slice(0, 3).join("\n")) && (memo.match(/^\d+\. /gm) ?? []).length >= 5)
}

// ═══ §C — CDA door bodies ═══════════════════════════════════════════════════════════════════════════════════════════════
/** Every `.from("closing_disclosure_agreement")…update(…)` chain in stripped source, with whether it pins and counts. */
function cdaUpdates(src: string): Array<{ at: number; pinsTenant: boolean; pinsDeal: boolean; counted: boolean }> {
  const out: Array<{ at: number; pinsTenant: boolean; pinsDeal: boolean; counted: boolean }> = []
  const re = /\.from\("closing_disclosure_agreement"\)\s*\.update\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length, depth = 1
    while (i < src.length && depth > 0) { const ch = src[i]; if (ch === "(") depth++; else if (ch === ")") depth--; i++ }
    let j = i
    while (j < src.length) { const rest = src.slice(j).match(/^\s*\.(\w+)\(/); if (!rest) break; j += rest[0].length; let d = 1; while (j < src.length && d > 0) { const ch = src[j]; if (ch === "(") d++; else if (ch === ")") d--; j++ } }
    const tail = src.slice(i, j)
    out.push({ at: src.slice(0, m.index).split("\n").length, pinsTenant: /\.eq\("brokerage_id",/.test(tail), pinsDeal: /\.eq\("transaction_id",\s*cdaDesk\.transactionId\)/.test(tail), counted: /\.select\(/.test(tail) })
  }
  return out
}
async function sectionC() {
  section("§C · app/actions/cda-portal.ts — every CDA write pins the tenant and the admitted deal and counts what it changed")
  const src = stripComments(raw("app/actions/cda-portal.ts"))
  const ups = cdaUpdates(src)
  const bad = ups.filter((x) => !x.pinsTenant || !x.pinsDeal || !x.counted)
  check(`the CDA updates are DERIVED from stripped source (${ups.length} found)`, ups.length >= 10, ups.length)
  check("every CDA update pins brokerage_id, pins transaction_id to the deal the desk admitted, and is .select()ed", ups.length > 0 && bad.length === 0, bad)
  const specimen = cdaUpdates('x.from("closing_disclosure_agreement").update({ a: 1 }).eq("id", id)\nconst y = 1')
  check("POSITIVE CONTROL: the finder flags an update pinned by id alone", specimen.length === 1 && !specimen[0].pinsTenant && !specimen[0].pinsDeal && !specimen[0].counted, specimen)
  const gate = src.slice(src.indexOf("async function cdaDeskGate"))
  check("ONE helper: the CDA gate asks the shared requireDealDesk (lib/transactions/role-guard.ts), not its own call shape of decideDealDesk", /requireDealDesk\(/.test(gate) && !/decideDealDesk\(/.test(gate))
  const doors = [...src.matchAll(/^export\s+async\s+function\s+(\w+)\s*\(/gm)].map((m) => m[1])
  const keep = (src.match(/const cdaDesk = await cdaDeskGate\(auth,/g) ?? []).length
  check(`every door keeps the admitted deal (${keep} of ${doors.length} exported doors)`, doors.length >= 20 && keep === doors.length, { keep, doors: doors.length })

  const cda = await quiet(() => load("app/actions/cda-portal.ts"))
  const override = () => drive(() => cda.manualOverrideCdaAction({ cdaId: CDA1, reason: "Fixture reason that is long enough" }))
  fresh(U_CO)
  const ok = await override()
  check("POSITIVE · compliance records a manual override on its tenant's CDA: success and the row carries the override",
    ok.r?.success === true && T("closing_disclosure_agreement").find((r) => r.id === CDA1)?.manual_override_by === U_CO, ok.r ?? ok.threw)
  fresh(U_CO); G.__N.rlsRefuseCdaUpdate = true
  const silent = await override()
  check("NEG · row security refuses the update silently (no error, zero rows): the door reports a FAILURE, never success",
    silent.r?.success === false && T("closing_disclosure_agreement").find((r) => r.id === CDA1)?.manual_override_by == null, silent.r ?? silent.threw)
  fresh(U_CO)
  const foreign = await drive(() => cda.manualOverrideCdaAction({ cdaId: CDA_X, reason: "Fixture reason that is long enough" }))
  const writes = (G.__N.mem as MemClient).writes.filter((w) => w.table === "closing_disclosure_agreement").length
  check("NEG · another tenant's CDA: refused and nothing is written", foreign.r?.success === false && writes === 0 && T("closing_disclosure_agreement").find((r) => r.id === CDA_X)?.manual_override_by == null, { r: foreign.r, writes })
}

async function main() {
  console.log(`wave156-n-guard — ROOT=${ROOT}`)
  for (const [name, fn] of [["§A", sectionA], ["§B", sectionB], ["§C", sectionC]] as Array<[string, () => Promise<void>]>) {
    try { await fn() } catch (e) { check(`${name} ran to completion`, false, (e as Error)?.stack?.split("\n").slice(0, 4).join(" | ")) }
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed) { console.log(`FAILED:\n  - ${fails.join("\n  - ")}`); process.exit(1) }
}
main().catch((e) => { console.error(e); process.exit(1) })
