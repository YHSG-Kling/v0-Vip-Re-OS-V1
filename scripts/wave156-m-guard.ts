#!/usr/bin/env tsx
/**
 * scripts/wave156-m-guard.ts — wave 156, lane 156M: THE OS-WIDE ARBITER AS A LOGICAL CONTRACT OVER THE EXISTING KERNEL.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 * Owner: "typed decisions, one accountable decider, deterministic enforcement at the action sink, no second kernel". Everything is
 * SIMULATED: the REAL exported product doors run on the in-memory PostgREST (scripts/in-memory-supabase.ts); only the service-client
 * constructor, `server-only`, next/cache and the kernel-event emitter are replaced; fetch throws (no provider, no network, no model);
 * every model is an injected seam that COUNTS calls.
 *   A. SINK REFUSALS at real doors — initiateCommissionPayout (payout sink), dispatchSms (outbound sink, a stated origin) and the generic
 *      door withActionLedger: one refusal per reason (decision_missing · decision_other_tenant · decision_other_office · decision_expired ·
 *      decision_superseded · unverified_untrusted_origin), each with ZERO seams reached, ONE decision row, and a POSITIVE CONTROL that runs.
 *   B. THE SHARED DOOR WRITES THE RECORD — a session write / an autonomous write / a wait decision written through the ledger doors carry
 *      detail.governance; the census of every ledger-door call site in app/ + lib/ (stripped source, derived, denominator published).
 *   C. THE SEND RECEIPT CARRIES THE ARBITER'S VERDICT — dispatchEmail's settled row holds the de-confliction verdict (allowed and refused),
 *      and the claim's own detail (the persisted send intent) survives the settle.
 *   D. ONE ACCOUNTABLE DECIDER — the decider per conflict class, derived from stripped source; no class has two, none has zero.
 *   E. FAST PATH — a counted slow model past the interactive budget: the fallback answers in time, the late result is judged against
 *      fresh state and never sent as a second reply; a money / legal question goes to a person with no model call.
 *   F. THE OWNER-HELD ADJUDICATION TABLE covers EXACTLY the census's owner-held set (derived from coverage/os-arbitration-coverage.json
 *      — run `npx tsx scripts/os-coverage-ledger.ts --json` first); every row carries one recommendation from the six.
 *   G. THE FROZEN-GAP RATCHET is byte-identical to the starting commit's.
 * Rules asserted, never waypoints: counts are derived and printed, not pinned. Root override: WAVE156_M_ROOT=<tree> (run from that tree).
 * BLIND SPOTS: the superseded check compares only facts whose versions BOTH the decision and the door name (a door that names no version —
 * the payout sink's commission row — cannot be judged superseded); the office check runs only when both sides name an office; the census
 * reads literal actor / trust spellings inside the call (a context built elsewhere and passed by name reads "dynamic"); the in-memory
 * client models filters and unique keys, not RLS or real concurrency.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { execFileSync } from "node:child_process"
import { performance } from "node:perf_hooks"
import { registerHooks } from "node:module"
import { stripComments, blankComments, blankStrings } from "./strip-comments"
import { memSupabase, type Row } from "./in-memory-supabase"

const ROOT = resolve(process.env.WAVE156_M_ROOT ?? process.cwd())
const G = globalThis as any
G.__M156 = { svc: null as unknown }
const STUB: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export function createServiceClient(){ const s = globalThis.__M156.svc; if (!s) throw new Error('156M: no world bound'); return s }; export const createClient = createServiceClient",
  "@/lib/supabase/server": "export async function createClient(){ const s = globalThis.__M156.svc; if (!s) throw new Error('156M: no world bound'); return new Proxy(s, { get(t, p) { if (p === 'auth') return { getUser: async () => ({ data: { user: globalThis.__M156.user ?? null }, error: null }) }; return t[p] } }) }; export const createServerClient = createClient",
  "next/cache": "export const revalidatePath = () => {}; export const revalidateTag = () => {}",
  "@/lib/kernel/emit": "export function isKernelEventValue(){ return true }; export async function emitKernelEvent(){ return { inserted: false, lifecycleEventId: null, fanOutOk: true, error: null } }; export function asWriteResult(){ return { data: null, error: null } }",
  "@/lib/kernel/notification-engine": "export async function processKernelEvent(){}",
}
registerHooks({ resolve(spec: string, ctx: any, next: any) { const b = STUB[spec]; return b !== undefined ? { url: `data:text/javascript,${encodeURIComponent(b)}`, shortCircuit: true } : next(spec, ctx) } })
for (const k of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "SENDGRID_API_KEY", "STRIPE_SECRET_KEY", "RESEND_API_KEY", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) delete process.env[k]
G.fetch = async () => { G.__M156.fetches = (G.__M156.fetches ?? 0) + 1; throw new Error("no network in the 156M guard") }
process.on("unhandledRejection", () => { /* fire-and-forget echoes in the doors; counted by nobody, fatal to nothing */ })

let pass = 0, fail = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { pass++; console.log(`  ✓ ${name}`) } else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}
const section = (t: string) => console.log(`\n── ${t}`)
const raw = (p: string) => { try { return readFileSync(join(ROOT, p), "utf8") } catch { return "" } }
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => { const o = { e: console.error, w: console.warn, l: console.log }; console.error = console.warn = console.log = () => {}; try { return await fn() } finally { console.error = o.e; console.warn = o.w; console.log = o.l } }
const mod = (p: string) => import(join(ROOT, p))

const B = "b6b6b6b6-0000-4000-8000-000000000156", B2 = "b7b7b7b7-0000-4000-8000-000000000156"
const U = "c6c6c6c6-0000-4000-8000-000000000156", X = "e6e6e6e6-0000-4000-8000-000000000156", CONV = "f6f6f6f6-0000-4000-8000-000000000156"
const O1 = "a6a6a6a6-0000-4000-8000-000000000001", O2 = "a6a6a6a6-0000-4000-8000-000000000002"
const RECORD_TABLES = new Set(["agent_action_ledger", "tenant_policy_versions"])

/** A world: memSupabase + `{count, head}` selects + a counter of every non-record table touched (a "seam"). */
function world(seed: Record<string, Row[]> = {}) {
  const mem = memSupabase({ agent_action_ledger: [], ...seed }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] } }) as any
  const touched: string[] = []
  const client = new Proxy(mem, {
    get(t, p) {
      if (p !== "from") return t[p as string]
      return (table: string) => {
        touched.push(table)
        const b = t.from(table)
        let count: { head: boolean } | null = null
        const sel = b.select
        b.select = (c?: string, o?: { count?: string; head?: boolean }) => { if (o?.count) count = { head: !!o.head }; return sel.call(b, c) }
        const then = b.then
        b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => then.call(b, (r: { data: unknown; error: unknown }) => res(count ? { ...r, count: Array.isArray(r.data) ? r.data.length : 0, data: count.head ? null : r.data } : r), rej)
        return b
      }
    },
  })
  G.__M156.svc = client
  G.__M156.fetches = 0
  return { client, mem, seams: () => touched.filter((x) => !RECORD_TABLES.has(x)).length + (G.__M156.fetches ?? 0), rows: () => mem.tables.agent_action_ledger as Row[] }
}

async function main(): Promise<void> {
  const L = await mod("lib/kernel/action-ledger.ts")
  const hasNew = typeof L.decisionRefFromRow === "function" && Array.isArray(L.SINK_CLASSES)
  console.log(`  root: ${ROOT}${hasNew ? "" : "  (the 156M exports are ABSENT here — every driven check below reads that as red)"}`)
  const gapsOf = (g: unknown, risk: string | null): string[] => L.assembleCausalChain([], [{ id: "r", action: "x.decision.wait", status: "skipped", reason_code: "UNSPECIFIED", subject_type: "contact", actor_type: "system", created_at: "2026-01-01T00:00:00.000Z", risk_class: risk, detail: { governance: g } }])[0].contractGaps ?? ["governance"]
  const now = new Date()
  // A persisted ALLOW decision (an approval) on this tenant, office O1, valid for an hour, that READ conversation CONV at version m-1.
  const decisionRow = (over: Record<string, unknown> = {}, gov: Record<string, unknown> = {}) => ({
    id: "d0000000-0000-4000-8000-000000000156", brokerage_id: B, actor_manager_key: null, actor_user_id: U, ...over,
    detail: { governance: L.governanceRecord({ plane: "approval", verdict: "approved", scope: { brokerageId: B, officeId: O1, userId: U }, actor: { type: "user", id: U },
      entity: { type: "contact", id: X, version: null }, objective: "approve the follow-up", rationale: "the agent approved it in the app",
      trustClass: "authorized_human", approvalBasis: "human_approval", dependencies: [{ type: "conversation", id: CONV, version: "m-1" }], expiresAt: new Date(now.getTime() + 3_600_000).toISOString(), ...gov }) },
  })
  const ref = (over: Record<string, unknown> = {}, gov: Record<string, unknown> = {}) => (hasNew ? L.decisionRefFromRow(decisionRow(over, gov)) : { id: "d", brokerageId: B, decider: U })

  // ══ A ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("A · deterministic enforcement at the sink — one refusal per reason at a REAL door, zero seams, one row; each with a positive control")
  {
    check("the typed decision is READ from a persisted ALLOW row (id, tenant, office, decider, expiry, the facts it read); a HOLD / DENY row authorizes nothing (null)",
      hasNew && ref()?.brokerageId === B && ref()?.officeId === O1 && ref()?.decider === U && Array.isArray(ref()?.dependencies) && (ref()?.dependencies as Row[]).some((f) => f.type === "conversation" && f.version === "m-1")
      && L.decisionRefFromRow(decisionRow({}, { verdict: "pending" })) === null && L.decisionRefFromRow(decisionRow({}, { verdict: "rejected" })) === null && L.decisionRefFromRow({ id: null } as never) === null, JSON.stringify(ref()))
    const reasons = new Set<string>()
    const sms = (dispatch: any, origin: any) => quiet(() => dispatch.dispatchSms({ brokerageId: B, to: "+15555550156", message: "Following up on your question.", contactId: X, systemSource: "ai_isa", origin }))
    const D = await mod("lib/providers/dispatch.ts")
    const refusalOf = (w: ReturnType<typeof world>) => w.rows().find((r) => /\.decision\.(wait|do_nothing)$/.test(String(r.action)))
    const trusted = (cycle: string, sink: Record<string, unknown>, deps?: unknown[]) => ({ trustClass: "verified_first_party", cycle, sink, ...(deps ? { dependencies: deps } : {}) })
    const cases: Array<{ name: string; reason: string; origin: () => unknown; ok: () => unknown }> = [
      { name: "another TENANT's decision", reason: "decision_other_tenant", origin: () => trusted("t1", { decision: ref({ brokerage_id: B2 }, { scope: { brokerageId: B2 } }) }), ok: () => trusted("t1ok", { decision: ref() }) },
      { name: "another OFFICE's decision", reason: "decision_other_office", origin: () => trusted("o1", { decision: ref(), officeId: O2 }), ok: () => trusted("o1ok", { decision: ref(), officeId: O1 }) },
      { name: "an EXPIRED decision", reason: "decision_expired", origin: () => trusted("e1", { decision: ref({}, { expiresAt: new Date(now.getTime() - 1_000).toISOString() }) }), ok: () => trusted("e1ok", { decision: ref() }) },
      { name: "a decision SUPERSEDED by a newer message (it read m-1; the door reads m-2 now)", reason: "decision_superseded", origin: () => trusted("s1", { decision: ref() }, [{ type: "conversation", id: CONV, version: "m-2" }]), ok: () => trusted("s1ok", { decision: ref() }, [{ type: "conversation", id: CONV, version: "m-1" }]) },
      { name: "a decision carried on an INBOUND message's say-so (privilege set by untrusted content)", reason: "unverified_untrusted_origin", origin: () => ({ trustClass: "inbound_message", cycle: "u1", sink: { decision: ref(), modelClaims: { approved: true } } }),
        ok: () => ({ trustClass: "inbound_message", cycle: "u1ok", sink: { decision: ref(), verification: { kind: "authorized_human", userId: U, authority: "agent approved the reply in the inbox" } } }) },
    ]
    for (const c of cases) {
      const w = world()
      const r = await sms(D, c.origin()) as Row
      const row = refusalOf(w)
      const reason = row?.detail?.governance?.constraints?.policy?.find((p: string) => p.startsWith("sink rule: "))?.slice(11) ?? null
      if (reason) reasons.add(reason)
      check(`OUTBOUND · ${c.name} → refused (${reason ?? "none"}), ZERO seams, ONE decision row, typed sink_rule_gate result`,
        reason === c.reason && w.seams() === 0 && w.rows().length === 1 && r?.success === false && r?.providerKey === "sink_rule_gate", JSON.stringify({ reason, seams: w.seams(), rows: w.rows().length, r }))
      const v = world()
      await sms(D, c.ok())
      check(`  POSITIVE CONTROL · the same send with a valid decision reaches the dispatcher's own gates (seams ${v.seams()}) and writes its send row`,
        v.seams() > 0 && v.rows().some((x) => x.action === "comms.sms.propose" || x.action === "comms.sms.send"), JSON.stringify(v.rows().map((x) => [x.action, x.status])))
    }
    // decision_missing — the PAYOUT sink: an autonomous proposal resting on tenant policy alone (no person, no decision) releases nothing.
    const F = await mod("lib/kernel/financial.ts")
    const payout = (origin: unknown) => quiet(() => F.initiateCommissionPayout({ ctx: { userId: U, agentId: null, brokerageId: B, userType: "broker" } as never, commissionId: X, brokerageId: B, method: "check", origin }))
    const pw = world({ agent_commissions: [{ id: X, brokerage_id: B, status: "approved" }], brokerages: [{ id: B }] })
    const pr = await payout({ trustClass: "tenant_policy", cycle: "pay-1", sink: { verification: { kind: "deterministic", check: "a nightly payout sweep" } } }) as Row
    const prow = refusalOf(pw)
    const preason = prow?.detail?.governance?.constraints?.policy?.find((p: string) => p.startsWith("sink rule: "))?.slice(11) ?? null
    if (preason) reasons.add(preason)
    check("PAYOUT · an autonomous payout on tenant policy + a deterministic check, NO decision → HOLD decision_missing, zero seams, one row (RED at base: it ran)",
      preason === "decision_missing" && pw.seams() === 0 && pw.rows().length === 1 && pr?.success === false && prow?.detail?.governance?.decision === "HOLD" && prow?.detail?.governance?.next_trigger?.kind === "human", JSON.stringify({ preason, seams: pw.seams(), pr }))
    const pw2 = world({ agent_commissions: [{ id: X, brokerage_id: B, status: "approved" }], brokerages: [{ id: B }] })
    await payout({ trustClass: "tenant_policy", cycle: "pay-2", sink: { decision: ref() } })
    check("  POSITIVE CONTROL · the same payout CARRYING the finance admin's recorded decision runs its own gates (finance roster, release gate)", pw2.seams() > 0, `seams ${pw2.seams()}`)
    const pw3 = world({ agent_commissions: [{ id: X, brokerage_id: B, status: "approved" }], brokerages: [{ id: B }] })
    await payout(null)
    check("  NEGATIVE CONTROL · the finance admin's OWN session click (no origin) is unchanged — routine authorized work does not wait", pw3.seams() > 0 && !refusalOf(pw3), `seams ${pw3.seams()}`)
    // The generic door: withActionLedger refuses a carried decision of another tenant before the claim; its run is never called.
    const gw = world()
    let ran = 0
    const out = await quiet(() => L.withActionLedger({ brokerageId: B, action: "finance.residual.release", actor: { type: "manager", managerKey: "finance_manager" }, subject: { type: "residual", id: X }, riskClass: "FINANCIAL", cycle: "g1", sink: { decision: ref({ brokerage_id: B2 }, { scope: { brokerageId: B2 } }) } },
      async () => { ran++; return { ok: true } }, { settle: () => ({ status: "executed", outcome: "done" }), replay: (c: Row) => ({ ok: false, refused: c.kind, error: c.error }) }, { client: gw.client })) as Row
    check("GENERIC DOOR · withActionLedger refuses a carried decision of another tenant BEFORE the claim: run never called, one decision row, typed replay",
      ran === 0 && out?.ok === false && out?.refused === "refused" && gw.rows().length === 1 && /\.decision\.do_nothing$/.test(String(gw.rows()[0]?.action)), JSON.stringify({ ran, out, rows: gw.rows().map((r) => r.action) }))
    const gw2 = world()
    await quiet(() => L.withActionLedger({ brokerageId: B, action: "finance.residual.release", actor: { type: "manager", managerKey: "finance_manager" }, subject: { type: "residual", id: X }, riskClass: "FINANCIAL", cycle: "g2", sink: { decision: ref() } },
      async () => { ran++; return { ok: true } }, { settle: () => ({ status: "executed", outcome: "done" }), replay: () => ({ ok: false }) }, { client: gw2.client }))
    check("  POSITIVE CONTROL · the same call carrying this tenant's valid decision runs once and settles executed", ran === 1 && gw2.rows()[0]?.status === "executed")
    const declared = hasNew ? (L.SINK_REASONS as string[]).filter((r: string) => r.startsWith("decision_") && r !== "decision_expired") : []
    check(`every 156M refusal reason declared in SINK_REASONS was produced at a real door (${declared.join(", ")}) — derived from the vocabulary, not retyped`,
      declared.length >= 4 && declared.every((r) => reasons.has(r)) && reasons.has("decision_expired") && reasons.has("unverified_untrusted_origin"), JSON.stringify([...reasons]))
    // SINK CLASS — derived from each sink door's channel in stripped source; every door's channel maps to a class, and none to two.
    const files = walk(["app", "lib"])
    const sinkChannels = new Set<string>()
    for (const f of files) for (const m of blankComments(raw(f)).matchAll(/channel:\s*"([a-z_]+_sink)"/g)) sinkChannels.add(m[1])
    const unmapped = [...sinkChannels].filter((c) => !hasNew || L.sinkClassOf({ channel: c, action: "x.y.z" }) === null)
    check(`every sink door channel in app/ + lib/ (${[...sinkChannels].sort().join(", ")}) maps to a sink class; the outbound proposal maps by its action`,
      sinkChannels.size >= 8 && unmapped.length === 0 && hasNew && L.sinkClassOf({ channel: "sms", action: "comms.sms.propose" }) === "outbound_send" && L.sinkClassOf({ channel: null, action: "ai.tool.x" }) === null, `unmapped: ${unmapped.join(", ")}`)
    check("POSITIVE CONTROL · the channel finder sees a planted door and ignores one named only in a comment",
      [...blankComments(`const r = ledgerToolCall({ channel: "planted_sink" })\n// channel: "ghost_sink"`).matchAll(/channel:\s*"([a-z_]+_sink)"/g)].map((m) => m[1]).join() === "planted_sink")
  }

  // ══ B ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("B · the shared door writes the record — and the census of every ledger-door call site (derived, with its denominator)")
  {
    const w = world()
    await quiet(() => L.ledgerSessionAction({ brokerageId: B, action: "finance.invoice.approve", actor: { type: "user", userId: U }, subject: { type: "vendor_invoice", id: X }, riskClass: "FINANCIAL", cycle: "b1" }, async () => ({ success: true }), { client: w.client }))
    const s = w.rows()[0]?.detail?.governance
    check("a SESSION write (ledgerSessionAction, no record passed) now carries a contract-COMPLETE governance block for FINANCIAL, written by the door (RED at base: facts only)",
      s?.written_by === "ledger_door" && s?.decision === "ALLOW" && s?.trust_class === "authorized_human" && gapsOf(s, "FINANCIAL").length === 0, JSON.stringify({ s, gaps: gapsOf(s, "FINANCIAL") }))
    await quiet(() => L.withActionLedger({ brokerageId: B, action: "marketing.audience.refresh", actor: { type: "manager", managerKey: "ads_manager" }, subject: { type: "audience", id: X }, riskClass: "FINANCIAL", cycle: "b2" }, async () => ({ ok: true }), { settle: () => ({ status: "executed", outcome: "done" }), replay: () => ({ ok: false }) }, { client: w.client }))
    const a = w.rows().find((r) => r.action === "marketing.audience.refresh")?.detail?.governance
    check("an AUTONOMOUS write with no stated trust class carries the record but its trust class stays NULL — a named gap (trust_class), never a guessed 'trusted'",
      !!a && a.trust_class === null && gapsOf(a, "FINANCIAL").includes("trust_class") && a.decision === "ALLOW", JSON.stringify(gapsOf(a, "FINANCIAL")))
    const until = new Date(now.getTime() + 86_400_000).toISOString()
    await quiet(() => L.recordNonAction({ brokerageId: B, domain: "followup", decision: "wait", until, actor: { type: "manager", managerKey: "ai_isa" }, subject: { type: "contact", id: X }, cycle: "b3", trustClass: "tenant_policy", approvalBasis: "policy_permitted" }, { client: w.client }))
    const wt = w.rows().find((r) => r.action === "followup.decision.wait")?.detail?.governance
    check("a WAIT decision (recordNonAction) reads RESCHEDULE with its expiry and a time trigger at `until` — complete", wt?.decision === "RESCHEDULE" && wt?.next_trigger?.at === until && wt?.expires_at === until && gapsOf(wt, null).length === 0, JSON.stringify(gapsOf(wt, null)))
    const own = L.governanceRecord({ plane: "closing", verdict: "pass", scope: { brokerageId: B }, actor: { type: "user", id: U }, rationale: "the caller's own record" })
    await quiet(() => L.ledgerSessionAction({ brokerageId: B, action: "closing.file.verify", actor: { type: "user", userId: U }, subject: { type: "transaction", id: X }, riskClass: "LEGAL", cycle: "b4", detail: { governance: own } }, async () => ({ success: true }), { client: w.client }))
    const kept = w.rows().find((r) => r.action === "closing.file.verify")?.detail?.governance
    check("NEGATIVE CONTROL · a caller's OWN record is kept (plane closing / rationale), never replaced by the door's", kept?.plane === "closing" && kept?.rationale === "the caller's own record" && kept?.written_by === undefined)
    // CENSUS — every call of a ledger door in app/ + lib/ (blankStrings for the token, blankComments for the literal text).
    const DOORS = ["withActionLedger", "ledgerSessionAction", "ledgerToolCall", "recordNonAction"]
    const finder = (src: string) => {
      const code = blankComments(src), bare = blankStrings(src)
      const out: Array<{ door: string; actor: string; trust: boolean }> = []
      for (const m of bare.matchAll(new RegExp(`\\b(${DOORS.join("|")})\\s*(?:<[^()]*?>)?\\s*\\(`, "g"))) {
        if (/function\s+$/.test(bare.slice(Math.max(0, m.index! - 12), m.index!))) continue
        let depth = 0, i = m.index! + m[0].length - 1, end = i
        for (; i < bare.length; i++) { const ch = bare[i]; if (ch === "(") depth++; else if (ch === ")") { depth--; if (depth === 0) { end = i; break } } }
        const arg = code.slice(m.index!, end).slice(0, 4000)
        const actor = /actor:\s*\{\s*type:\s*"(\w+)"/.exec(arg)?.[1] ?? "dynamic"
        out.push({ door: m[1], actor, trust: /\btrustClass\s*:/.test(arg) || /\bgovernance\s*:/.test(arg) })
      }
      return out
    }
    const files = walk(["app", "lib"]).filter((f) => f !== "lib/kernel/action-ledger.ts")
    const all = files.flatMap((f) => finder(raw(f)).map((h) => ({ ...h, f })))
    const byDoor = Object.fromEntries(DOORS.map((d) => [d, all.filter((h) => h.door === d).length]))
    const human = all.filter((h) => h.actor === "user" || h.actor === "agent").length
    const autonomousNoTrust = all.filter((h) => (h.actor === "manager" || h.actor === "system") && !h.trust)
    const dynamic = all.filter((h) => h.actor === "dynamic").length
    console.log(`  · CENSUS: ${all.length} ledger-door call sites in ${new Set(all.map((h) => h.f)).size} files (${Object.entries(byDoor).map(([k, v]) => `${k} ${v}`).join(" · ")}) — every one reaches insertLedgerRow, so every one now writes a record.`)
    console.log(`    complete by construction (a person acting): ${human} · autonomous with a stated trust / own record: ${all.filter((h) => (h.actor === "manager" || h.actor === "system") && h.trust).length} · autonomous with NO stated trust (record written, trust_class a named gap): ${autonomousNoTrust.length} in ${new Set(autonomousNoTrust.map((h) => h.f)).size} files · actor built elsewhere (dynamic): ${dynamic}`)
    const ledgerSrc = stripComments(raw("lib/kernel/action-ledger.ts"))
    const doorsReach = /withBaseGovernance\(/.test(/async function insertLedgerRow[\s\S]*?\n}\n/.exec(ledgerSrc)?.[0] ?? "") && /insertLedgerRow\(/.test(/async function claimAction[\s\S]*?\n}\n/.exec(ledgerSrc)?.[0] ?? "") && /insertLedgerRow\(/.test(/export async function recordNonAction[\s\S]*?\n}\n/.exec(ledgerSrc)?.[0] ?? "")
    check("WIRING · the ONE insert (insertLedgerRow) builds the record, and both the claim and the decision row go through it (stripped source)", doorsReach)
    check(`the census found every door (denominator ${all.length} > 0 for each of the four doors)`, DOORS.every((d) => byDoor[d] > 0), JSON.stringify(byDoor))
    const planted = finder(`await withActionLedger({ brokerageId: b, actor: { type: "manager", managerKey: "x" } }, run, hooks)\n// ledgerSessionAction({ actor: { type: "user" } })\nconst s = "recordNonAction("`)
    check("POSITIVE CONTROL · the census finder counts a planted call (actor manager, no trust) and ignores a tombstone comment and a string", planted.length === 1 && planted[0].actor === "manager" && !planted[0].trust, JSON.stringify(planted))
  }

  // ══ C ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("C · the send receipt carries the arbiter's verdict (the de-confliction decision, ONE decider)")
  {
    const D = await mod("lib/providers/dispatch.ts")
    const send = () => quiet(() => D.dispatchEmail({ brokerageId: B, to: "client@example.test", subject: "Your showing", html: "<p>See you at 3.</p>", contactId: X, ledger: { cycle: `c-${Math.random()}` } }))
    const w = world({ contacts: [], email_suppressions: [], deconflict_suppression_log: [], isa_outreach_log: [] })
    await send()
    const row = w.rows().find((r) => r.action === "comms.email.send")
    const dg = row?.detail?.governance?.deconflict
    check("ALLOWED · the settled send row carries the de-confliction verdict (allowed, decider ai_isa, touches vs cap) on its own governance block",
      !!row && row.status !== "proposed" && dg?.allowed === true && dg?.decider === "ai_isa" && typeof dg?.touches_in_window === "number" && typeof dg?.policy_max === "number", JSON.stringify({ status: row?.status, dg }))
    check("…and the settle kept what the claim wrote: the persisted send intent and the dispatch-plane record", !!row?.detail?.send_intent && row?.detail?.governance?.plane === "dispatch", JSON.stringify(Object.keys(row?.detail ?? {})))
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `t-${i}`, brokerage_id: B, contact_id: X, channel: "email", sent_at: new Date(now.getTime() - i * 60_000).toISOString(), created_at: new Date(now.getTime() - i * 60_000).toISOString() }))
    const w2 = world({ contacts: [], email_suppressions: [], deconflict_suppression_log: [], isa_outreach_log: many, email_sends: many.map((m) => ({ ...m })) })
    const r2 = await send() as Row
    const row2 = w2.rows().find((r) => r.action === "comms.email.send")
    check("REFUSED (over-touch) · the refusal row carries the verdict (allowed false) beside the conflict record (decider, loser's next trigger)",
      r2?.providerKey === "deconflict_gate" && row2?.detail?.governance?.deconflict?.allowed === false && !!row2?.detail?.governance?.arbitration, JSON.stringify({ pk: r2?.providerKey, g: row2?.detail?.governance?.deconflict }))
    const w3 = world()
    await quiet(() => D.dispatchEmail({ brokerageId: B, to: "someone@example.test", subject: "Hi", html: "<p>Hi</p>", ledger: { cycle: "c-none" } }))
    const row3 = w3.rows().find((r) => r.action === "comms.email.send")
    check("NEGATIVE CONTROL · a send the gate never ran for (no contact / lead) carries NO verdict — absent, never a guessed 'allowed'", !!row3 && row3.detail?.governance?.deconflict === undefined)
  }

  // ══ D ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("D · one accountable decider per conflict class (derived from stripped source)")
  {
    const finder = (src: string): Array<{ cls: string; decider: string }> => {
      const code = blankComments(src)
      const out: Array<{ cls: string; decider: string }> = []
      for (const m of code.matchAll(/\bcls:\s*"([a-z_]+)"\s*,\s*decider:\s*([^,}\n]+)/g)) out.push({ cls: m[1], decider: m[2].trim() })
      for (const m of code.matchAll(/\bconflictClass:\s*([^\n]*?),\s*(?:\/\/[^\n]*\n\s*)?decider:\s*([^,}\n]+)/g)) for (const c of m[1].matchAll(/(?<![=!]==\s*)"([a-z_]+)"/g)) out.push({ cls: c[1], decider: m[2].trim() }) // a literal COMPARED against (`type === "transaction"`) is a condition, not a class
      return out
    }
    const hits = walk(["app", "lib"]).filter((f) => f !== "lib/kernel/action-ledger.ts").flatMap((f) => finder(raw(f)).map((h) => ({ ...h, f })))
    const byClass = new Map<string, Set<string>>()
    for (const h of hits) { if (!byClass.has(h.cls)) byClass.set(h.cls, new Set()); byClass.get(h.cls)!.add(h.decider) }
    const classes: string[] = hasNew ? L.CONFLICT_CLASSES : ["same_contact", "same_campaign", "same_transaction_terms", "competing_provider_spend"]
    console.log(`  · deciders: ${classes.map((c) => `${c} → {${[...(byClass.get(c) ?? [])].join(" | ")}}`).join(" · ")}`)
    const two = classes.filter((c) => (byClass.get(c)?.size ?? 0) > 1), none = classes.filter((c) => (byClass.get(c)?.size ?? 0) === 0)
    check("NO conflict class has two deciders (RED at base: same_contact was decided by the AI ISA AND by a delegation's assignee)", two.length === 0, two.map((c) => `${c}: ${[...byClass.get(c)!].join(" + ")}`).join("; "))
    check("NO conflict class has none", none.length === 0, none.join(", "))
    const stray = [...byClass.keys()].filter((c) => !classes.includes(c))
    check("every class a writer records is in the ONE vocabulary (an unmapped class would read null on the record)", stray.length === 0, stray.join(", "))
    const spec = stripComments(raw("lib/kernel/autonomy-budgets.ts"))
    const envelopes = [...spec.matchAll(/^\s{2}([a-z_]+):\s*\{\s*manager:\s*"([a-z_]+)"/gm)].map((m) => [m[1], m[2]])
    const reg = stripComments(raw("lib/kernel/manager-registry.ts"))
    const unregistered = envelopes.filter(([, m]) => !new RegExp(`\\b${m}\\s*:`).test(reg))
    check(`competing_provider_spend's decider is each envelope's ONE owner (${envelopes.map(([e, m]) => `${e}→${m}`).join(", ")}), every owner a registered manager`, envelopes.length > 0 && unregistered.length === 0, JSON.stringify(unregistered))
    const planted = finder(`x({ cls: "same_contact", decider: "ai_isa" })\ny({ conflictClass: "same_contact", decider: "listing_concierge" })\n// z({ cls: "same_contact", decider: "ghost" })`)
    check("POSITIVE CONTROL · the finder sees a planted SECOND decider for one class and ignores a commented one", new Set(planted.filter((p) => p.cls === "same_contact").map((p) => p.decider)).size === 2 && !planted.some((p) => p.decider.includes("ghost")))
    const tern = finder(`a({ conflictClass: t === "transaction" ? "same_transaction_terms" : "entity_version", decider: row.m })`).map((p) => p.cls).sort().join()
    check("POSITIVE CONTROL · a ternary's branches are classes, its compared operand is not", tern === "entity_version,same_transaction_terms", tern)
  }

  // ══ E ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("E · the fast path — a counted slow model past the interactive budget")
  {
    const arb = await mod("lib/ai-isa/followup-arbiter.ts")
    const { platformFollowupPolicy } = await mod("lib/ai-isa/followup-policy.ts")
    const facts = { subject: "contact", relationship: { type: "contact", persona: null, hasAssignedAgent: true }, intent: null, history: { hoursSinceAnyTouch: 2, hoursSinceAgentTouch: null, campaignTouches7d: 0, lastChannel: "sms", portalEducationViews: null }, journey: { transactionStage: null, nextMilestone: null, openLessons: null, nextLesson: null }, preferences: [], fatigueRisk: null, localHour: 11, moment: { key: "inbound", intent: "answer their question", daysSinceOpen: 0 }, blindSpots: [] }
    const reply = { id: "reply", kind: "communication", channels: ["sms"], why: ["answer the person"] }
    const menu = { menu: [reply, { id: "notify_human", kind: "agent_intervention", channels: ["human_task"], why: ["a person"] }], locked: null }
    const model = { calls: 0 }
    const late: unknown[] = []
    const budget = arb.ARBITER_LATENCY_BUDGET_MS.interactive
    const slowMs = budget + 400
    const t0 = performance.now()
    const d = await arb.arbitrateFollowUp({ brokerageId: B, facts, menu, planned: reply, policy: platformFollowupPolicy(), latencyBudgetMs: budget, onLateResult: (l: unknown) => { late.push(l) } },
      { decide: () => { model.calls++; return new Promise((r) => setTimeout(() => r({ optionId: "notify_human", channel: null, format: null, waitHours: null, rationale: "late judgment", evidence: ["intent"], confidence: 0.9 }), slowMs)) } })
    const ms = performance.now() - t0
    check(`a model ${slowMs} ms slow against the ${budget} ms interactive budget: the planned fallback answered in ${Math.round(ms)} ms (deterministic, timed out)`, ms < slowMs && d.source === "deterministic" && d.optionId === "reply" && !!d.timedOut, JSON.stringify({ ms: Math.round(ms), d: [d.source, d.optionId, d.timedOut] }))
    await new Promise((r) => setTimeout(r, slowMs - budget + 200))
    check("the late answer is handed over ONCE as evidence (1 model call, 1 late hand-off) — the arbiter never executes it", model.calls === 1 && late.length === 1)
    const own = { humanOwnedUntil: null, ownedReason: null, humanEngagedAt: null, lastOutboundAt: null, lastInboundAt: null }
    const decidedAt = new Date(Date.now() - 5_000).toISOString()
    const stale = arb.lateResultDisposition({ decidedAt, fallbackAnswered: true, fallbackOptionId: "reply", lateOptionId: "notify_human", ownership: own, now: new Date() })
    const fresh = arb.lateResultDisposition({ decidedAt, fallbackAnswered: false, fallbackDispatchFailed: true, fallbackOptionId: "reply", lateOptionId: "notify_human", ownership: own, now: new Date() })
    const newer = arb.lateResultDisposition({ decidedAt, fallbackAnswered: false, fallbackOptionId: "reply", lateOptionId: "notify_human", ownership: { ...own, lastInboundAt: new Date().toISOString() }, now: new Date() })
    check("NO SECOND REPLY · answered → stale_answered; a newer message → stale_newer_inbound (its own evaluation); a FAILED fallback → re_arbitrate on fresh state (never the late answer's own send)",
      stale.disposition === "stale_answered" && newer.disposition === "stale_newer_inbound" && fresh.disposition === "re_arbitrate", JSON.stringify([stale.disposition, newer.disposition, fresh.disposition]))
    const unreadable = arb.lateResultDisposition({ decidedAt, fallbackAnswered: false, fallbackOptionId: "reply", lateOptionId: "notify_human", ownership: null, now: new Date() })
    check("FAIL CLOSED · an unreadable thread at settlement acts on nothing (the completion net redrives — the question is not abandoned)", unreadable.disposition === "stale_unreadable")
    const money = arb.interactiveTurnVerdict({ body: "What will my monthly payment be if rates drop?", intent: { primary: "financing_question", confidence: 92 }, knownContact: true, isPublic: false, ownership: own, now: new Date() })
    const routine = arb.interactiveTurnVerdict({ body: "What time is the open house?", intent: { primary: "showing_request", confidence: 92 }, knownContact: true, isPublic: false, ownership: own, now: new Date() })
    check("MONEY / LEGAL never automated · a financing question goes to a person on the fast path with NO planning call", money.path === "fast" && (money as Row).optionId === "notify_human", JSON.stringify(money))
    check("  NEGATIVE CONTROL · a routine question is answered on the fast path (no gratuitous human wait)", routine.path === "fast" ? (routine as Row).optionId === "reply" : routine.path === "deliberate", JSON.stringify(routine))
    const resp = stripComments(raw("lib/communications/inbound-responder.ts"))
    check("WIRING · the responder passes the INTERACTIVE budget and a late-result settler that re-reads ownership before anything (stripped source)",
      /latencyBudgetMs:\s*ARBITER_LATENCY_BUDGET_MS\.interactive/.test(resp) && /settleLateResult[\s\S]{0,600}loadConversationOwnership\(/.test(resp) && /lateResultDisposition\(/.test(resp))
  }

  // ══ F ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("F · the owner-held adjudication table covers exactly the census's owner-held set")
  {
    const RECS = ["observation-only", "deterministic rule owner", "existing manager", "human/platform authority", "wire-to-product", "retire onto survivor"]
    const jsonPath = join(ROOT, "coverage/os-arbitration-coverage.json")
    const doc = raw("docs/architecture/WAVE156-OWNER-HELD-ADJUDICATION.md")
    if (!existsSync(jsonPath)) {
      check("the census artifact exists (run `npx tsx scripts/os-coverage-ledger.ts --json` first — an on-demand file outside git)", false, jsonPath)
    } else {
      const census = JSON.parse(readFileSync(jsonPath, "utf8")) as { rows: Array<{ id: string; state: string }> }
      const held = new Set(census.rows.filter((r) => r.state === "owner-held").map((r) => r.id))
      const tableRows = [...doc.matchAll(/^\|\s*`([^`]+)`\s*\|([^\n]*)$/gm)].filter((m) => !/^(id|row)$/.test(m[1]))
      const ids = new Set(tableRows.map((m) => m[1]))
      const missing = [...held].filter((id) => !ids.has(id)), extra = [...ids].filter((id) => !held.has(id))
      check(`the table has ONE row per census owner-held row (census ${held.size}, table ${ids.size}, rows ${tableRows.length})`, held.size > 0 && missing.length === 0 && extra.length === 0 && tableRows.length === ids.size, `missing ${missing.slice(0, 5).join(", ")} · extra ${extra.slice(0, 5).join(", ")}`)
      const bad = tableRows.filter((m) => RECS.filter((r) => m[2].includes(`**${r}**`)).length !== 1).map((m) => m[1])
      check("every row carries exactly ONE recommendation from the six, and evidence (file:line) and an owner question", bad.length === 0 && tableRows.every((m) => /\.(ts|tsx|sql|json|md):\d+/.test(m[2]) && /\?/.test(m[2])), bad.slice(0, 5).join(", "))
      const noLink = census.rows.filter((r) => r.state === "missing").length
      check(`the no-link rows are reconciled in the doc (census missing ${noLink}; the doc names that count)`, new RegExp(`\\b${noLink}\\b`).test(doc.split(/^## /m).find((s) => /^No-link/i.test(s)) ?? ""), String(noLink))
    }
    check("POSITIVE CONTROL · the row finder reads a table row and ignores the header", [...`| id | rec |\n|---|---|\n| \`x:y\` | **observation-only** a.ts:1 why? |`.matchAll(/^\|\s*`([^`]+)`\s*\|([^\n]*)$/gm)].length === 1)
  }

  // ══ G ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("G · the frozen-gap ratchet is unchanged")
  {
    const BASE = "b261c4746f1e1d46151f387d620c5b2d7b79355a"
    let base = ""
    try { base = execFileSync("git", ["show", `${BASE}:scripts/os-coverage-ledger-baseline.json`], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 }) } catch { base = "" }
    const cur = raw("scripts/os-coverage-ledger-baseline.json")
    check("scripts/os-coverage-ledger-baseline.json is byte-identical to the starting commit's (no gap was added, none hidden)", base.length > 0 && cur === base, `base ${base.length} bytes · now ${cur.length} bytes`)
  }

  // ══ H (round 2) ═══════════════════════════════════════════════════════════════════════════════════════════════════════
  section("H · a REAL caller carries a decision — a held send approved by a person is released carrying that approval (red at base: no release door)")
  {
    const D = await mod("lib/providers/dispatch.ts")
    const has = typeof D.approveHeldSend === "function" && typeof D.releaseApprovedSend === "function"
    check("the approval door and the release door exist (dispatch.ts approveHeldSend / releaseApprovedSend)", has)
    if (has) {
      const seed = () => ({ contacts: [{ id: X, brokerage_id: B, phone: "+15555550156", email: "x@example.test", tcpa_consent: true, dnc_status: false, state: "FL" }], messages: [{ id: "m-1", brokerage_id: B, contact_id: X, direction: "inbound", created_at: new Date(now.getTime() - 60_000).toISOString() }], email_suppressions: [], deconflict_suppression_log: [], isa_outreach_log: [] })
      const w = world(seed())
      const propose = (cycle: string) => quiet(() => D.dispatchSms({ brokerageId: B, to: "+15555550156", message: "Following up.", contactId: X, systemSource: "ai_isa", origin: { trustClass: "model_output", cycle } }))
      await propose("h-1")
      const hold = w.rows().find((r) => r.action === "comms.decision.wait")
      const ap = await D.approveHeldSend(w.client, { brokerageId: B, holdId: hold?.id, approverUserId: U, authority: "approval queue" }) as Row
      const sendsBefore = w.rows().filter((r) => r.action === "comms.sms.send").length
      await quiet(() => D.releaseApprovedSend(w.client, { brokerageId: B, approvalId: ap.approvalId }))
      const sends = w.rows().filter((r) => r.action === "comms.sms.send").length
      const prop = w.rows().find((r) => r.action === "comms.sms.propose")
      check("POSITIVE · the approved hold is released ONCE carrying the approval: the sink ALLOWs it and the dispatcher's own send row follows", ap.ok && sends === sendsBefore + 1 && prop?.detail?.governance?.decision === "ALLOW", JSON.stringify({ ap, sends }))
      await quiet(() => D.releaseApprovedSend(w.client, { brokerageId: B, approvalId: ap.approvalId }))
      check("  at most once · the same approval released again sends nothing new", w.rows().filter((r) => r.action === "comms.sms.send").length === sends)
      const foreign = await quiet(() => D.releaseApprovedSend(w.client, { brokerageId: B2, approvalId: ap.approvalId })) as Row
      check("ANOTHER TENANT'S approval · refused before anything else is read (approval_gate)", foreign?.providerKey === "approval_gate")
      await propose("h-2")
      const hold2 = w.rows().filter((r) => r.action === "comms.decision.wait").find((r) => r.id !== hold?.id)
      const ap2 = await D.approveHeldSend(w.client, { brokerageId: B, holdId: hold2?.id, approverUserId: U, authority: "approval queue", ttlMinutes: -1 }) as Row
      const exp = await quiet(() => D.releaseApprovedSend(w.client, { brokerageId: B, approvalId: ap2.approvalId })) as Row
      check("an EXPIRED approval · refused at the sink (decision_expired), nothing sent", exp?.providerKey === "sink_rule_gate" && w.rows().some((r) => (r.detail?.governance?.constraints?.policy ?? []).includes("sink rule: decision_expired")))
      await propose("h-3")
      const hold3 = w.rows().filter((r) => r.action === "comms.decision.wait").find((r) => r.id !== hold?.id && r.id !== hold2?.id)
      const ap3 = await D.approveHeldSend(w.client, { brokerageId: B, holdId: hold3?.id, approverUserId: U, authority: "approval queue" }) as Row
      ;(w.mem.tables.messages as Row[]).push({ id: "m-2", brokerage_id: B, contact_id: X, direction: "inbound", created_at: new Date().toISOString() })
      const sup = await quiet(() => D.releaseApprovedSend(w.client, { brokerageId: B, approvalId: ap3.approvalId })) as Row
      check("a SUPERSEDED approval (they wrote again after it) · refused at the sink (decision_superseded), nothing sent", sup?.providerKey === "sink_rule_gate" && w.rows().some((r) => (r.detail?.governance?.constraints?.policy ?? []).includes("sink rule: decision_superseded")))
      const wrong = await D.approveHeldSend(w.client, { brokerageId: B2, holdId: hold3?.id, approverUserId: U, authority: "x" }) as Row
      check("NEGATIVE · another tenant cannot approve this tenant's hold", !wrong.ok)
    }
  }

  // ══ I (round 2) ═══════════════════════════════════════════════════════════════════════════════════════════════════════
  section("I · origin trust stated ONCE at the shared boundaries (the kernel event processor, the verified cron scheduler)")
  {
    const CA = await mod("lib/kernel/causation.ts")
    const has = typeof CA.withOriginTrust === "function" && typeof CA.enterOriginTrust === "function"
    check("the scope carries origin trust (causation.ts withOriginTrust / enterOriginTrust)", has)
    if (has) {
      const w = world()
      const act = (action: string, extra: Row = {}) => L.withActionLedger({ brokerageId: B, action, actor: { type: "manager", managerKey: "deal_coordinator" }, subject: { type: "transaction", id: X }, riskClass: "LOW_RISK_WRITE", cycle: action, ...extra }, async () => ({ ok: true }), { settle: () => ({ status: "executed", outcome: "done" }), replay: () => ({ ok: false }) }, { client: w.client })
      await CA.withOriginTrust("verified_first_party", "kernel_event_processor", () => quiet(() => act("kernel.reaction.probe")))
      const r1 = w.rows().find((r) => r.action === "kernel.reaction.probe")?.detail?.governance
      check("a reaction's autonomous row takes the processor's origin trust, and SAYS where it came from", r1?.trust_class === "verified_first_party" && r1?.trust_source === "boundary:kernel_event_processor", JSON.stringify(r1 && { t: r1.trust_class, s: r1.trust_source }))
      await CA.withOriginTrust("verified_first_party", "kernel_event_processor", () => quiet(() => act("kernel.reaction.stated", { trustClass: "model_output" })))
      const r2 = w.rows().find((r) => r.action === "kernel.reaction.stated")?.detail?.governance
      check("NEGATIVE · a STATED trust class always wins over the boundary's", r2?.trust_class === "model_output" && r2?.trust_source === "stated")
      await CA.withOriginTrust("verified_first_party", "kernel_event_processor", () => quiet(() => L.withActionLedger({ brokerageId: B, action: "kernel.reaction.human", actor: { type: "user", userId: U }, subject: { type: "transaction", id: X }, cycle: "hum" }, async () => ({ ok: true }), { settle: () => ({ status: "executed", outcome: "done" }), replay: () => ({ ok: false }) }, { client: w.client })))
      check("NEGATIVE · a person acting keeps authorized_human", w.rows().find((r) => r.action === "kernel.reaction.human")?.detail?.governance?.trust_class === "authorized_human")
      await quiet(() => act("kernel.reaction.outside"))
      check("NEGATIVE · outside any boundary the gap stays a named gap (null) — never a guess", w.rows().find((r) => r.action === "kernel.reaction.outside")?.detail?.governance?.trust_class === null)
      const CR = await mod("lib/cron-auth.ts")
      process.env.CRON_SECRET = "156m-test-secret"
      const cronRun = async () => { const denied = CR.verifyCronAuth(new Request("http://x/api/cron/probe", { headers: { authorization: "Bearer 156m-test-secret" } })); if (denied) return "denied"; await Promise.resolve(); await quiet(() => act("intel.cron.probe")); return "ran" }
      const ran = await cronRun()
      const r3 = w.rows().find((r) => r.action === "intel.cron.probe")?.detail?.governance
      check("a cron run that passed verifyCronAuth states tenant_policy for its autonomous rows (boundary:cron_scheduler)", ran === "ran" && r3?.trust_class === "tenant_policy" && r3?.trust_source === "boundary:cron_scheduler", JSON.stringify(r3 && { t: r3.trust_class, s: r3.trust_source }))
      const badRun = async () => { const denied = CR.verifyCronAuth(new Request("http://x/api/cron/probe", { headers: { authorization: "Bearer wrong" } })); return denied ? denied.status : 0 }
      check("NEGATIVE · a refused cron credential states nothing (401) — the boundary only speaks for a verified scheduler", (await badRun()) === 401)
      delete process.env.CRON_SECRET
      const ne = stripComments(raw("lib/kernel/notification-engine.ts"))
      check("WIRING · the kernel event processor opens the boundary on its own re-entry (stripped source)", /withOriginTrust\(\s*"verified_first_party",\s*"kernel_event_processor"/.test(ne))
      // The census split: the 'autonomous, no stated trust' sites now covered by a shared boundary, derived from code.
      const DOORS = /\b(withActionLedger|ledgerSessionAction|ledgerToolCall|recordNonAction)\s*(?:<[^()]*?>)?\s*\(/g
      const files = walk(["app", "lib"]).filter((f) => f !== "lib/kernel/action-ledger.ts")
      const reactionGraph = new Set<string>(["lib/kernel/notification-engine.ts", "lib/kernel/event-reactor.ts"])
      for (const hub of ["lib/kernel/notification-engine.ts", "lib/kernel/event-reactor.ts"]) for (const m of stripComments(raw(hub)).matchAll(/(?:from\s*|import\(\s*)["']@\/(lib\/[^"']+)["']/g)) for (const ext of [".ts", ".tsx", "/index.ts"]) if (existsSync(join(ROOT, m[1] + ext))) reactionGraph.add(m[1] + ext)
      const sites: Array<{ f: string; cls: string }> = []
      for (const f of files) {
        const src = raw(f), bare = blankStrings(src), code = blankComments(src)
        for (const m of bare.matchAll(DOORS)) {
          if (/function\s+$/.test(bare.slice(Math.max(0, m.index! - 12), m.index!))) continue
          let depth = 0, i = m.index! + m[0].length - 1, end = i
          for (; i < bare.length; i++) { const ch = bare[i]; if (ch === "(") depth++; else if (ch === ")") { depth--; if (depth === 0) { end = i; break } } }
          const arg = code.slice(m.index!, end).slice(0, 4000)
          const actor = /actor:\s*\{\s*type:\s*"(\w+)"/.exec(arg)?.[1] ?? "dynamic"
          if (!(actor === "manager" || actor === "system")) continue
          if (/\btrustClass\s*:|\bgovernance\s*:|\bdoorTrust\(/.test(arg)) { if (/\bdoorTrust\(/.test(arg)) sites.push({ f, cls: `stated at the door (${/doorTrust\(\s*"([a-z_]+)"/.exec(arg)?.[1] ?? "?"})` }); continue }
          const cls = /^app\/api\/cron\//.test(f) && /\bverifyCronAuth\(/.test(code) ? "cron_scheduler (boundary)"
            : reactionGraph.has(f) ? "kernel_event_processor (boundary)"
            : /^app\/api\/(webhooks|voice)\//.test(f) ? "remains: provider-signed webhook — each verifies its own signature; no shared boundary to state it once"
            : /^app\/(actions|api)\//.test(f) ? "remains: a request door acting for a visitor / provider event — its trust is that door's to state"
            : "remains: a library function — covered at run time when called under a cron or a reaction, not provable statically"
          sites.push({ f, cls })
        }
      }
      const by = new Map<string, number>()
      for (const s of sites) by.set(s.cls, (by.get(s.cls) ?? 0) + 1)
      const covered = sites.filter((s) => /\(boundary\)$/.test(s.cls)).length
      const atDoor = sites.filter((s) => /^stated at the door/.test(s.cls)).length
      const remain = sites.length - covered - atDoor
      console.log(`  · TRUST-CLASS DENOMINATOR: ${sites.length} autonomous ledger-door call sites stated no trust class at round 1; ${covered} sit in a shared boundary that states it (statically proven), ${atDoor} now state it at their own door (DOOR_TRUST), ${remain} remain:`)
      for (const [k, v] of [...by.entries()].sort((a, b) => b[1] - a[1])) console.log(`      ${v} × ${k}`)
      check(`the census derives the split (denominator ${sites.length} > 0; ${covered} covered by a boundary; ${atDoor} stated at the door)`, sites.length > 0 && covered > 0)
      const doorRemain = sites.filter((s) => /^remains: (a request door|provider-signed webhook)/.test(s.cls))
      check(`every request door and provider-signed webhook now states its own origin trust (${doorRemain.length} left: ${doorRemain.map((s) => s.f).join(", ")})`, doorRemain.length === 0)
      const anon = sites.filter((s) => /anonymous_public_request/.test(s.cls)).length, trusted = sites.filter((s) => /(signature_verified_provider|internal_shared_secret)/.test(s.cls)).length
      check(`NEGATIVE · no anonymous door is stated trusted: ${anon} anonymous public requests read inbound_message, ${trusted} verified provider doors read verified_first_party`, L.DOOR_TRUST?.anonymous_public_request === "inbound_message" && L.DOOR_TRUST?.signature_verified_provider === "verified_first_party" && anon > 0 && trusted > 0)
    }
  }

  // ══ K (round 3) ═══════════════════════════════════════════════════════════════════════════════════════════════════════
  section("K · the APPROVAL QUEUE door — a held send reaches a person in the existing Command Center (red at base: no queue item, no door)")
  {
    const CC = await mod("app/actions/command-center.ts")
    const KC = await mod("lib/kernel/command-center.ts")
    const D = await mod("lib/providers/dispatch.ts")
    const has = typeof KC.loadHeldSendActions === "function" && typeof D.declineHeldSend === "function"
    check("the queue reader and the decline door exist (lib/kernel/command-center.ts loadHeldSendActions, dispatch.ts declineHeldSend)", has)
    if (has) {
      const BROKER = U, AGENT = "c6c6c6c6-0000-4000-8000-0000000000a6", OTHER = "c6c6c6c6-0000-4000-8000-0000000000b7"
      const seed = () => ({
        contacts: [{ id: X, brokerage_id: B, phone: "+15555550158", email: "k@example.test", tcpa_consent: true, dnc_status: false, state: "FL" }],
        messages: [{ id: "m-1", brokerage_id: B, contact_id: X, direction: "inbound", created_at: new Date(now.getTime() - 120_000).toISOString() }],
        users: [{ id: BROKER, brokerage_id: B, user_type: "broker" }, { id: AGENT, brokerage_id: B, user_type: "agent" }, { id: OTHER, brokerage_id: B2, user_type: "broker" }],
        email_suppressions: [], deconflict_suppression_log: [], isa_outreach_log: [],
      })
      const w = world(seed())
      const hold = async (cycle: string) => { await quiet(() => D.dispatchSms({ brokerageId: B, to: "+15555550158", message: `Reply ${cycle}`, contactId: X, systemSource: "ai_isa", origin: { trustClass: "model_output", cycle } })); return w.rows().filter((r) => r.action === "comms.decision.wait").at(-1) as Row }
      const as = (id: string | null) => { G.__M156.user = id ? { id } : null }
      const h1 = await hold("k-1")
      const listB = await KC.loadHeldSendActions(w.client, B, 50, new Date())
      const listB2 = await KC.loadHeldSendActions(w.client, B2, 50, new Date())
      check("READER · this tenant's queue lists the held send with who / what / why from the row; another tenant's queue lists nothing",
        listB.some((a: Row) => a.id === h1?.id && a.queue === "held_send" && /Held by the send gate/.test(a.rationale) && a.actionInput.channel === "sms") && listB2.length === 0, JSON.stringify(listB.map((a: Row) => [a.id, a.queue])))
      as(AGENT)
      const byAgent = await quiet(() => CC.approveAgentAction({ queue: "held_send", actionId: h1?.id })) as Row
      check("NEGATIVE · an agent seat (no approval authority — requireApprover) is refused; nothing sent", byAgent?.ok === false && /Not authorized/.test(String(byAgent.error)) && !w.rows().some((r) => r.action === "comms.sms.send"))
      as(OTHER)
      const byOther = await quiet(() => CC.approveAgentAction({ queue: "held_send", actionId: h1?.id })) as Row
      check("NEGATIVE · another tenant's broker: the hold is not found in their brokerage; nothing sent", byOther?.ok === false && /not in your brokerage/.test(String(byOther.error)) && !w.rows().some((r) => r.action === "comms.sms.send"), JSON.stringify(byOther))
      as(BROKER)
      await quiet(() => CC.approveAgentAction({ queue: "held_send", actionId: h1?.id }))
      await quiet(() => CC.approveAgentAction({ queue: "held_send", actionId: h1?.id }))
      const sends = w.rows().filter((r) => r.action === "comms.sms.send")
      const prop = w.rows().find((r) => r.action === "comms.sms.propose")
      const sess = w.rows().filter((r) => r.action === "comms.held_send.approve" && r.brokerage_id === B)
      check("  the other tenant's refused attempt left ITS OWN receipt, under its own brokerage (failed), never one in this tenant", w.rows().some((r) => r.action === "comms.held_send.approve" && r.brokerage_id === B2 && r.status === "failed"))
      check("POSITIVE · the broker approves (double-clicked): exactly ONE send reaches the dispatcher, the release CARRIES the approval (ALLOW, verified by the approver), one session receipt",
        sends.length === 1 && prop?.detail?.governance?.decision === "ALLOW" && prop?.detail?.governance?.verification?.kind === "authorized_human" && sess.length === 1, JSON.stringify({ sends: sends.length, sess: sess.length }))
      const h2 = await hold("k-2")
      const dec = await quiet(() => CC.rejectAgentAction({ queue: "held_send", actionId: h2?.id })) as Row
      const after = await quiet(() => CC.approveAgentAction({ queue: "held_send", actionId: h2?.id })) as Row
      const listed = (await KC.loadHeldSendActions(w.client, B, 50, new Date())).some((a: Row) => a.id === h2?.id)
      check("DECLINE · the broker declines: a terminal decision; approving it later is refused; it leaves the queue", dec?.ok === true && after?.ok === false && /already closed/.test(String(after.error)) && !listed, JSON.stringify({ dec, after }))
      const h3 = await hold("k-3")
      await D.approveHeldSend(w.client, { brokerageId: B, holdId: h3?.id, approverUserId: BROKER, authority: "approved earlier, window lapsed", ttlMinutes: -1 })
      const exp = await quiet(() => CC.approveAgentAction({ queue: "held_send", actionId: h3?.id })) as Row
      check("EXPIRED · an approval that lapsed is refused with the sentence the row shows, nothing sent, and the hold is closed", exp?.ok === false && /lapsed/.test(String(exp.error)) && !(await KC.loadHeldSendActions(w.client, B, 50, new Date())).some((a: Row) => a.id === h3?.id), JSON.stringify(exp))
      const h4 = await hold("k-4")
      ;(w.mem.tables.messages as Row[]).push({ id: "m-9", brokerage_id: B, contact_id: X, direction: "inbound", created_at: new Date(Date.now() + 1000).toISOString() })
      const moved = await quiet(() => CC.approveAgentAction({ queue: "held_send", actionId: h4?.id })) as Row
      check("THREAD MOVED ON · they wrote again after the draft: approving it is refused at the sink (superseded) with the sentence the row shows, the hold closes", moved?.ok === false && /moved on/.test(String(moved.error)) && w.rows().filter((r) => r.action === "comms.sms.send").length === 1, JSON.stringify(moved))
      const src = stripComments(raw("app/actions/command-center.ts"))
      check("WIRING · both existing doors route held_send to the one helper, AFTER requireApprover, under ledgerSessionAction (stripped source)",
        /export async function approveAgentAction[\s\S]*?requireApprover\(\)[\s\S]*?queue === "held_send"\) return heldSendDecision\("approve"/.test(src) && /export async function rejectAgentAction[\s\S]*?requireApprover\(\)[\s\S]*?queue === "held_send"\) return heldSendDecision\("decline"/.test(src) && /async function heldSendDecision[\s\S]*?ledgerSessionAction\(/.test(src))
      const lw = world()
      await quiet(() => L.withActionLedger({ brokerageId: B, action: "marketing.listing_landing_view.record", actor: { type: "system", userId: null }, ...L.doorTrust("anonymous_public_request"), subject: { type: "listing", id: X }, cycle: "dt" }, async () => ({ ok: true }), { settle: () => ({ status: "executed", outcome: "done" }), replay: () => ({ ok: false }) }, { client: lw.client }))
      const dg = lw.rows()[0]?.detail?.governance
      check("DOOR TRUST · a public page's ledger row records what the door verified: inbound_message, trust_source anonymous_public_request (never trusted)", dg?.trust_class === "inbound_message" && dg?.trust_source === "anonymous_public_request", JSON.stringify(dg && [dg.trust_class, dg.trust_source]))
    }
  }

  // ══ J (round 2) ═══════════════════════════════════════════════════════════════════════════════════════════════════════
  section("J · lane 156N's request — a CAMPAIGN text never rides a signed representation as consent (refused at dispatch); a servicing text does")
  {
    const D = await mod("lib/providers/dispatch.ts")
    const seed = () => ({ contacts: [{ id: X, brokerage_id: B, phone: "+15555550157", tcpa_consent: false, dnc_status: false, state: "FL" }], transactions: [{ id: "tx-j", brokerage_id: B, contact_id: X, buyer_contact_id: null, seller_contact_id: null, status: "active", deleted_at: null }], deconflict_suppression_log: [], isa_outreach_log: [], email_suppressions: [], listing_agreements: [], buyer_broker_agreements: [], offers: [] })
    const sms = (purpose: string) => { world(seed()); return quiet(() => D.dispatchSms({ brokerageId: B, to: "+15555550157", message: "A note for you.", contactId: X, channelPurpose: purpose })) as Promise<Row> }
    const campaign = await sms("campaign")
    const servicing = await sms("transactional")
    check("a CAMPAIGN text to a contact with an active representation and no TCPA consent is refused at the consent gate", campaign?.success === false && campaign?.providerKey === "compliance_gate", JSON.stringify(campaign))
    check("  NEGATIVE CONTROL · a SERVICING (transactional) text to the same contact passes the consent gate (refused, if at all, by a later gate)", servicing?.providerKey !== "compliance_gate", JSON.stringify(servicing))
  }

  console.log("\n BLIND SPOTS (round 3): §K's sends fail at the provider (no credentials, fetch refused) — 'exactly one send' counts the dispatcher's send rows; on the live table a FAILED release is re-claimed by a second click (attempts + 1, by design), while the in-memory table has no attempts default, so that re-claim reads as in flight. §I's census classifies by path and literal spelling; the 41 library functions are covered only at run time under a cron / reaction scope (published, not proven).")
  console.log("\n BLIND SPOTS: SIMULATED throughout (in-memory PostgREST, fetch throws, counted model seam). The superseded check needs both the decision and the door to name a fact's version; the office check needs both to name an office; the census reads literal actor / trust spellings (a context built elsewhere reads 'dynamic'); the decider finder reads literal `cls:` / `conflictClass:` sites (a class computed elsewhere is not seen until it is spelled).")
  console.log(`\nGUARD_RESULT wave156-m: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(` failed: ${failures.join(" | ")}`); process.exit(1) }
}

function walk(dirs: string[]): string[] {
  const out: string[] = []
  const go = (d: string) => {
    const abs = join(ROOT, d)
    if (!existsSync(abs)) return
    for (const n of readdirSync(abs)) {
      if (n === "node_modules" || n.startsWith(".")) continue
      const p = join(d, n)
      if (statSync(join(ROOT, p)).isDirectory()) go(p)
      else if (/\.(ts|tsx)$/.test(n) && !/\.d\.ts$/.test(n)) out.push(p)
    }
  }
  dirs.forEach(go)
  return out
}

main().catch((e) => { console.error(e); process.exit(1) })
