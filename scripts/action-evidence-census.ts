#!/usr/bin/env tsx
/**
 * scripts/action-evidence-census.ts   (npm run test:action-evidence-census)
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WAVE 147, LANE 147F — owner rulings 11 (the five actions) and LAW 5 (consequential actions leave evidence).
 *
 *   "fix the 5 actions that are silently never recorded" — wave 146 renamed them onto domain.entity.action. This file
 *   PROVES each one's CURRENT behaviour individually, on the REAL action code, and then measures the whole repository.
 *
 * PART I — THE FIVE ACTIONS (runtime, in-memory; the real server actions behind stubbed session / provider seams):
 *   for each of  business_card.scan.identity_crosswalk · business_card.scan.confirm · tenant.custom_domain.attach|verify|detach ·
 *                listing.agreement_amendment.record · life_change.signal.respond
 *     (a) ROW LANDS     — one agent_action_ledger row under the exact name, settled;
 *     (b) REPLAY        — the same call again does NOT act a second time (provider / domain writer counted) and says so;
 *     (c) FAIL CLOSED   — a ledger that refuses the claim (42501 on agent_action_ledger) → the action does not run and the
 *                         caller's answer is a refusal, never a success or a false "already recorded";
 *     (d) VISIBLE TO §14 — scripts/action-ledger-guard.ts §14's OWN door + name regexes (read from its source, not restated)
 *                         read the name from the file — including the computed name behind ledgeredRoutingCall and the
 *                         aliased door `ledger(...)` (`const ledger = deps.ledger ?? withActionLedger`).
 *   A finding in another lane's file (lib/ai-isa/followup-arbiter.ts is lane 147G's) is reported PENDING with its owner —
 *   it does not turn this proof red, and flips to "landed" the moment the owner fixes it.
 *
 * PART II — THE CENSUS (static, STRIPPED source — CLAUDE.md §2):
 *   II.1 every consequential write inside a SERVER ACTION ("use server" files under app/ + lib/) — an insert / upsert /
 *        update / delete on a CHAIN TABLE (the tables scripts/parent-child-graph-guard.ts CHAINS names, read from its
 *        source), or a raw provider send — either reaches the ledger (a ledger door in the function, a same-file helper
 *        that holds one, or an imported lib function that holds one — derived, never listed), or is on ALLOW (a reason
 *        each), or is FROZEN DEBT in scripts/action-evidence-census-baseline.json. A NEW offender is red. A baseline
 *        entry that is no longer an offender is printed (the ratchet can tighten), never red.
 *   II.2 every withActionLedger `replay` hook either reads the claim's kind or is frozen debt — a hook that cannot tell
 *        `refused` from `replay` is the defect class all five actions shared (requirement 6: callers honour refused).
 *   II.3 every ledger door whose action name is COMPUTED is listed with how its names are proven (or not).
 *   Every finder carries a POSITIVE CONTROL (a specimen it must catch) and a look-alike it must NOT catch (a tombstone,
 *   a string literal). Blind spots are printed beside the numbers.
 *
 * Write the baseline (integrator only, after reading the offender list):  ... action-evidence-census.ts --write-baseline
 * Run: NODE_OPTIONS=--max-old-space-size=6000 npx tsx scripts/action-evidence-census.ts
 */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { stripComments, blankStrings, blankComments } from "./strip-comments"
import { stubModule, setSvc } from "./canaries/_harness"
import { memSupabase, type MemClient } from "./in-memory-supabase"
import { LIVE_TABLES } from "./live-tables"

const ROOT = process.cwd()
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8")
const stripped = (rel: string): string => stripComments(read(rel))

let pass = 0, fail = 0
const failures: string[] = []
const pending: string[] = []
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function outsideLane(name: string, landed: boolean, owner: string, detail = ""): void {
  if (landed) { pass++; console.log(`  ✓ ${name} (landed)`) }
  else { pending.push(`${name} — owner ${owner}${detail ? ` — ${detail}` : ""}`); console.log(`  ◌ PENDING (outside lane, ${owner}): ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// SEAMS — installed BEFORE any action module is imported (the resolve hook reads the map per resolution)
// ═════════════════════════════════════════════════════════════════════════════════════════════════
type Recorder = {
  ctx: Record<string, unknown> | null
  connector: Array<{ method: string; url: string }>
  amendments: number
  engage: number
  signals: number
}
const G = globalThis as unknown as { __147F: Recorder }
G.__147F = { ctx: null, connector: [], amendments: 0, engage: 0, signals: 0 }
const STUB_DIR = mkdtempSync(join(tmpdir(), "action-evidence-census-"))
/** A FILE stub: re-exports the real module (so every other importer keeps its names) and overrides the named doors. */
function fileStub(spec: string, realRel: string | null, overrides: string): void {
  const real = realRel ? `export * from ${JSON.stringify(pathToFileURL(join(ROOT, realRel)).href)}\n` : ""
  const file = join(STUB_DIR, `${spec.replace(/[^a-z0-9]+/gi, "_")}.mjs`)
  writeFileSync(file, `${real}${overrides}\n`)
  stubModule(spec, pathToFileURL(file).href)
}
stubModule("next/cache", "export const revalidatePath = () => {}; export const revalidateTag = () => {}; export const unstable_cache = (f) => f; export const unstable_noStore = () => {}")
// node:dns → "no record yet" (the DNS probe is free and read-only; the claim under test is the routing call). The stub
// imports the un-prefixed builtin so the hook does not resolve it back to itself.
stubModule("node:dns", "import real from 'dns'; const nx = async () => { const e = new Error('nx'); e.code = 'ENOTFOUND'; throw e }; export const promises = { ...real.promises, resolve4: nx, resolveCname: nx }; export default { ...real, promises }")
fileStub("@/lib/auth/require-caller", "lib/auth/require-caller.ts",
  "export const requireCaller = async () => ({ ok: true, ...globalThis.__147F.ctx }); export const requireCallerWithAgent = async () => ({ ok: true, ...globalThis.__147F.ctx })")
fileStub("@/lib/platform/acting-context", "lib/platform/acting-context.ts",
  "export const resolveWriteContextForTenant = async () => ({ ok: true, ...globalThis.__147F.ctx }); export const resolveActingContext = async () => ({ ok: true, ...globalThis.__147F.ctx })")
fileStub("@/lib/billing/billing-access", "lib/billing/billing-access.ts",
  "export const mayUseAndAfford = async () => ({ allowed: true, reason: 'action-evidence-census stub' })")
// The routing layer's ONE transport — every attach / status / detach is COUNTED here; nothing leaves the process.
fileStub("@/lib/agentic-os/connector-gateway", "lib/agentic-os/connector-gateway.ts",
  "export const callConnector = async (req) => { globalThis.__147F.connector.push({ method: req.method ?? 'GET', url: String(req.url) }); return { ok: true, status: 200, data: { name: 'x', verified: true, verification: [] } } }")
// The amendment's DOMAIN writer (lib/listings/listing-agreement-terms.ts — proven by test:listing-coming-soon-live-date) is
// counted, not re-proven: this file proves the ACTION's ledger wrap around it.
fileStub("@/lib/listings/listing-agreement-terms", "lib/listings/listing-agreement-terms.ts",
  "export const recordListingAgreementAmendment = async () => { globalThis.__147F.amendments++; return { ok: true, id: 'ctv-' + globalThis.__147F.amendments, agreementId: 'agr-1', versionNo: globalThis.__147F.amendments + 1, changed: ['coming_soon_street_address_authorized'] } }")
fileStub("@/lib/events/lifecycle-event-core", "lib/events/lifecycle-event-core.ts",
  "export const recordLifecycleEvent = async () => ({ ok: true, event: { id: 'evt' }, deduped: false })")

// ── tenant fixture ───────────────────────────────────────────────────────────────────────────────
const B = "b1470000-0000-4000-8000-0000000000f1"
const U = "u1470000-0000-4000-8000-0000000000f1"
const A = "a1470000-0000-4000-8000-0000000000f1"
const C = "c1470000-0000-4000-8000-0000000000f1"
const SCAN = "5ca00000-0000-4000-8000-0000000000f1"
const L = "11470000-0000-4000-8000-0000000000f1"
const DOC = "d1470000-0000-4000-8000-0000000000f1"
const LEDGER_UNIQUE = { agent_action_ledger: [["idempotency_key"]] }
function seed(): Record<string, Record<string, unknown>[]> {
  return {
    brokerages: [{ id: B, plan_tier: "brokerage", slug: "f147", name: "Lane F Realty" }],
    users: [{ id: U, brokerage_id: B, user_type: "broker_owner", first_name: "Fay", last_name: "Lane" }],
    agents: [{ id: A, user_id: U, brokerage_id: B }],
    contacts: [{ id: C, brokerage_id: B, first_name: "Dana", last_name: "Card", email: "dana@example.test", phone: null, address: null, enrichment_profile: {}, notes: null, contact_type: "buyer" }],
    business_card_scans: [{ id: SCAN, brokerage_id: B, agent_id: A, contact_id: C, review_status: "approved", extracted_data: { first_name: "Dana", last_name: "Card", email: "dana@example.test" }, subject_notes: null, card_subject_type: "contact", classified_by: "picker" }],
    listings: [{ id: L, brokerage_id: B, agent_id: A, address: "1 Ledger Ln" }],
    tenant_custom_domains: [],
    agent_action_ledger: [],
  }
}
const ledgerRows = (svc: MemClient, action: string): Record<string, unknown>[] =>
  ((svc as unknown as { tables?: Record<string, Record<string, unknown>[]> }).tables?.agent_action_ledger ?? []).filter((r) => r.action === action)
async function rows(svc: MemClient, table: string, where: Record<string, unknown> = {}): Promise<Record<string, unknown>[]> {
  let q: any = (svc as any).from(table).select("*")
  for (const [k, v] of Object.entries(where)) q = q.eq(k, v)
  const { data } = await q
  return (data ?? []) as Record<string, unknown>[]
}
const asRows = async (svc: MemClient, action: string) => (await rows(svc, "agent_action_ledger")).filter((r) => r.action === action)

/** A frozen clock for the span of one call — the custom-domain cycles are timestamps, so "the same request twice"
 *  is the same instant twice. Restored in `finally`. */
async function atInstant<T>(iso: string, fn: () => Promise<T>): Promise<T> {
  const Real = Date
  const fixed = new Real(iso).getTime()
  class Frozen extends Real {
    constructor(...args: any[]) { if (args.length) super(...(args as [any])); else super(fixed) }
    static now(): number { return fixed }
  }
  ;(globalThis as any).Date = Frozen
  try { return await fn() } finally { (globalThis as any).Date = Real }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// §14 — the guard's OWN finders, read from its source (never restated here)
// ═════════════════════════════════════════════════════════════════════════════════════════════════
function section14Finder(): { doors: RegExp; value: RegExp; alias: RegExp | null; aliasAware: boolean } | null {
  const g = stripComments(read("scripts/action-ledger-guard.ts"))
  const d = g.match(/const DOORS = \/(.+)\/g\n/)?.[1]
  const v = g.match(/window\.match\(\/(.+?)\/\)\?\.\[1\]/)?.[1]
  const a = g.match(/const ALIAS_DOOR = \/(.+)\/g\n/)?.[1]
  if (!d || !v) return null
  return { doors: new RegExp(d, "g"), value: new RegExp(v), alias: a ? new RegExp(a, "g") : null, aliasAware: !!a }
}
/** §14's walk over ONE source text: every door's argument window → the literal / template / union names after `action:`.
 *  Aliased doors are added exactly as §14 adds them — with §14's own ALIAS_DOOR regex (absent → §14 is not alias-aware). */
function namesSeenBy14(f: NonNullable<ReturnType<typeof section14Finder>>, src: string): string[] {
  const out: string[] = []
  const doorSources = [f.doors.source]
  if (f.alias) {
    for (const m of src.matchAll(new RegExp(f.alias.source, "g"))) doorSources.push(`\\b${m[1]}\\s*(?:<[^>]*>)?\\s*\\(`)
  }
  const doors = new RegExp(doorSources.join("|"), "g")
  for (const m of src.matchAll(doors)) {
    const window = src.slice(m.index!, m.index! + 1500)
    const value = window.match(f.value)?.[1] ?? ""
    for (const lit of value.matchAll(/"([^"]+)"|`([^`]+)`/g)) out.push(lit[1] ?? lit[2])
  }
  return out
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// PART I — THE FIVE ACTIONS
// ═════════════════════════════════════════════════════════════════════════════════════════════════
type FiveRow = { action: string; at: string; lands: boolean; replay: boolean; closed: boolean; visible: boolean; verdict: string }
const FIVE: FiveRow[] = []
const lineOf = (rel: string, needle: string): string => {
  const i = read(rel).split("\n").findIndex((l) => l.includes(needle))
  return `${rel}:${i + 1}`
}

async function partOne(): Promise<void> {
  console.log("\n══ PART I — the five actions, each driven on its REAL code ══")
  const f14 = section14Finder()
  check("§14's door + name regexes are readable from scripts/action-ledger-guard.ts (this proof uses the guard's own finders)", !!f14)
  if (!f14) return
  check("POSITIVE CONTROL (§14 finders): a literal door, a ledgeredRoutingCall door and a two-segment name are all read",
    JSON.stringify(namesSeenBy14(f14, `await withActionLedger({ action: "a.b.c" })\nawait ledgeredRoutingCall({ action: "x.y" })`)) === JSON.stringify(["a.b.c", "x.y"]))

  // ── 1+2. business card ─────────────────────────────────────────────────────────────────────────
  {
    console.log("\n  [business_card.scan.confirm — app/actions/business-card/business-card-actions.ts]")
    const svc = memSupabase(seed(), { unique: LEDGER_UNIQUE })
    setSvc(svc)
    G.__147F.ctx = { brokerageId: B, agentId: A, userId: U, userType: "broker_owner" }
    const bc = await import("../app/actions/business-card/business-card-actions")
    const fields = { first_name: "Dana", last_name: "Card-Lee", email: "dana@example.test" }
    const first = await bc.confirmBusinessCardScan({ scanId: SCAN, fields })
    const after1 = await asRows(svc, "business_card.scan.confirm")
    const lands = first.ok === true && after1.length === 1 && after1[0].status === "executed"
    check("ROW LANDS: one ledger row, executed, the correction applied", lands, JSON.stringify({ first, n: after1.length, status: after1[0]?.status }))
    const contactAfter1 = (await rows(svc, "contacts", { id: C }))[0]
    const second = await bc.confirmBusinessCardScan({ scanId: SCAN, fields })
    const after2 = await asRows(svc, "business_card.scan.confirm")
    const replay = second.ok === false && /already recorded/.test(String((second as any).error)) && after2.length === 1 && (await rows(svc, "contacts", { id: C }))[0]?.updated_at === contactAfter1?.updated_at
    check("REPLAY: the SAME confirmation again does not act a second time and says it was already recorded (was: a ms-timestamp key ran it twice)", replay, JSON.stringify(second))
    const different = await bc.confirmBusinessCardScan({ scanId: SCAN, fields: { ...fields, last_name: "Card" } })
    check("CONTROL: a DIFFERENT correction is a new action (a second row), not a replay", different.ok === true && (await asRows(svc, "business_card.scan.confirm")).length === 2, JSON.stringify(different))
    const refusing = memSupabase(seed(), { refuse: { agent_action_ledger: "permission denied for table agent_action_ledger" } })
    setSvc(refusing)
    const before = JSON.stringify((await rows(refusing, "contacts", { id: C }))[0])
    const refused = await bc.confirmBusinessCardScan({ scanId: SCAN, fields })
    const closed = refused.ok === false && /could not be recorded, so nothing was changed/.test(String((refused as any).error)) && !/already recorded/.test(String((refused as any).error)) && JSON.stringify((await rows(refusing, "contacts", { id: C }))[0]) === before
    check("FAIL CLOSED: a refused claim changes nothing and says it could not be recorded (was: 'already recorded')", closed, JSON.stringify(refused))
    const names = namesSeenBy14(f14, stripped("app/actions/business-card/business-card-actions.ts"))
    const visible = names.includes("business_card.scan.confirm") && names.includes("business_card.scan.identity_crosswalk")
    check("VISIBLE TO §14: both business-card names are read by the guard's own finder", visible, JSON.stringify(names))
    FIVE.push({ action: "business_card.scan.confirm", at: lineOf("app/actions/business-card/business-card-actions.ts", `action: "business_card.scan.confirm"`), lands, replay, closed, visible, verdict: "FIXED — key was `${scan}:${now}` (no replay, ever) → a fingerprint of what was confirmed; replay hook said 'already recorded' for a refusal → per-kind message" })

    console.log("\n  [business_card.scan.identity_crosswalk — the vendor / recruit card's paid B2B2C crosswalk]")
    // The crosswalk is module-private (best-effort evidence inside a vendor/recruit routing); its ledger wrap is proven on
    // the source and through the REAL ledger with the same context + hooks shape (no second implementation).
    const src = stripped("app/actions/business-card/business-card-actions.ts")
    const fn = src.slice(src.indexOf("async function crosswalkBusinessIdentity("), src.indexOf("async function stampCardProvenance("))
    const keyed = /idempotencyKey:\s*`business_card_crosswalk:\$\{scanId\}`/.test(fn)
    const hookAware = /replay:\s*\(claim\)\s*=>\s*claim\.kind === "refused"/.test(fn) && /skipped:\s*`ledger_refused: \$\{claim\.error\}`/.test(fn)
    const runsInside = /withActionLedger<IdentityCrosswalkEvidence \| null>\([\s\S]*?async \(\) => \{[\s\S]*?runVersiumBusinessIdentityLeg\(/.test(fn)
    const { withActionLedger } = await import("../lib/kernel/action-ledger")
    const led = memSupabase(seed(), { unique: LEDGER_UNIQUE })
    let paid = 0
    const call = () => withActionLedger<{ skipped: string | null } | null>(
      { brokerageId: B, action: "business_card.scan.identity_crosswalk", actor: { type: "user", userId: U, agentId: A }, subject: { type: "business_card_scan", id: SCAN }, reasonCode: "HUMAN_REQUESTED", idempotencyKey: `business_card_crosswalk:${SCAN}`, riskClass: "LOW_RISK_WRITE", systemSource: "business-card-actions" },
      async () => { paid++; return { skipped: null } },
      { settle: () => ({ status: "executed", outcome: "no_match", provider: "versium" }), replay: (claim) => (claim.kind === "refused" ? { skipped: `ledger_refused: ${claim.error}` } : null) },
      { client: led },
    )
    await call(); await call()
    const cwLands = keyed && runsInside && ledgerRows(led, "business_card.scan.identity_crosswalk").length === 1
    const cwReplay = paid === 1
    const ref = memSupabase(seed(), { refuse: { agent_action_ledger: "permission denied" } })
    paid = 0
    const r = await withActionLedger<{ skipped: string | null } | null>(
      { brokerageId: B, action: "business_card.scan.identity_crosswalk", actor: { type: "user", userId: U }, subject: { type: "business_card_scan", id: SCAN }, idempotencyKey: `business_card_crosswalk:${SCAN}` },
      async () => { paid++; return { skipped: null } },
      { settle: () => ({ status: "executed", outcome: "x" }), replay: (claim) => (claim.kind === "refused" ? { skipped: `ledger_refused: ${claim.error}` } : null) },
      { client: ref },
    )
    const cwClosed = paid === 0 && /^ledger_refused: /.test(String(r?.skipped)) && hookAware
    check("ROW LANDS: one row per scan (the key is the scan), the paid leg runs INSIDE the claim", cwLands, `keyed=${keyed} inside=${runsInside}`)
    check("REPLAY: a second crosswalk of the same scan does not pay twice", cwReplay)
    check("FAIL CLOSED: a refused claim makes no paid call and leaves evidence NAMING the refusal on the scan (was: null — no trace)", cwClosed, `hookAware=${hookAware} paid=${paid}`)
    FIVE.push({ action: "business_card.scan.identity_crosswalk", at: lineOf("app/actions/business-card/business-card-actions.ts", `action: "business_card.scan.identity_crosswalk"`), lands: cwLands, replay: cwReplay, closed: cwClosed, visible, verdict: "FIXED (evidence only) — the replay hook returned null for a refusal, so the scan carried no trace; it now records `ledger_refused: <error>` (no paid call either way)" })
  }

  // ── 3. custom domains (attach · verify · detach) ───────────────────────────────────────────────
  {
    console.log("\n  [tenant.custom_domain.attach | verify | detach — app/actions/custom-domains.ts, through ledgeredRoutingCall]")
    process.env.VERCEL_TOKEN = "action-evidence-census-fake"
    process.env.VERCEL_PROJECT_ID = "prj_action_evidence_census"
    const svc = memSupabase(seed(), { unique: LEDGER_UNIQUE, uuidIds: true })
    setSvc(svc)
    G.__147F.ctx = { brokerageId: B, userId: U, userType: "broker_owner" }
    G.__147F.connector = []
    const cd = await import("../app/actions/custom-domains")
    const T1 = "2026-10-31T12:00:00.000Z"
    const add = await atInstant(T1, () => cd.addCustomDomainAction("homes.lanef147.test"))
    const row = (await rows(svc, "tenant_custom_domains"))[0]
    const posts = () => G.__147F.connector.filter((c) => c.method === "POST").length
    const gets = () => G.__147F.connector.filter((c) => c.method === "GET").length
    const dels = () => G.__147F.connector.filter((c) => c.method === "DELETE").length
    const attachLands = add.ok === true && (await asRows(svc, "tenant.custom_domain.attach")).length === 1 && posts() === 1
    check("attach ROW LANDS: one row, one routing POST", attachLands, JSON.stringify({ ok: add.ok, posts: posts(), err: (add as any).error }))
    const id = String(row?.id)
    const v1 = await atInstant(T1, () => cd.checkCustomDomainStatusAction(id))
    const getsAfter1 = gets()
    const v2 = await atInstant(T1, () => cd.checkCustomDomainStatusAction(id))
    const verifyLands = v1.ok === true && (await asRows(svc, "tenant.custom_domain.verify")).length === 1
    const verifyReplay = v2.ok === true && gets() === getsAfter1 && (await asRows(svc, "tenant.custom_domain.verify")).length === 1
    check("verify ROW LANDS: one row for one check", verifyLands, JSON.stringify(v1).slice(0, 200))
    check("verify REPLAY: the same check at the same instant does not ask the routing layer again (a later check is a new read — by design)", verifyReplay, `gets ${getsAfter1} → ${gets()}`)
    const T2 = "2026-10-31T12:05:00.000Z"
    const d1 = await atInstant(T2, () => cd.removeCustomDomainAction(id))
    const delsAfter1 = dels()
    const d2 = await atInstant(T2, () => cd.removeCustomDomainAction(id))
    const detachLands = d1.ok === true && (await asRows(svc, "tenant.custom_domain.detach")).length === 1 && delsAfter1 === 1
    const detachReplay = d2.ok === true && dels() === delsAfter1
    check("detach ROW LANDS: one row, one routing DELETE", detachLands, `dels=${delsAfter1}`)
    check("detach REPLAY: removing again does not detach twice (the cycle is the connect)", detachReplay, `dels ${delsAfter1} → ${dels()}`)
    // attach replay: the SAME connect cycle again — under the frozen clock a revive reuses (row id, connect instant).
    const reAdd = await atInstant(T1, () => cd.addCustomDomainAction("homes.lanef147.test"))
    const revived = (await rows(svc, "tenant_custom_domains", { id }))[0] as any
    const attachReplay = reAdd.ok === true && posts() === 1 && revived?.verification?.registered_with_vercel !== true
    check("attach REPLAY: the same connect cycle does not POST again, and the row claims nothing about the routing layer", attachReplay, JSON.stringify({ posts: posts(), v: revived?.verification }))

    // ── refusals ──
    const refusing = memSupabase(seed(), { refuse: { agent_action_ledger: "permission denied for table agent_action_ledger" }, uuidIds: true })
    setSvc(refusing)
    G.__147F.connector = []
    const rAdd = await atInstant(T1, () => cd.addCustomDomainAction("refused.lanef147.test"))
    const rRow = (await rows(refusing, "tenant_custom_domains"))[0] as any
    const attachClosed = rAdd.ok === false && /could not be recorded, so it was not attempted/.test(String((rAdd as any).error)) && posts() === 0 && rRow?.verification?.registered_with_vercel !== true && rRow?.status === "pending_dns"
    check("attach FAIL CLOSED: no routing POST, ok:false naming why, the row stays pending_dns and claims NO registration (was: ok:true + registered_with_vercel:true)", attachClosed, JSON.stringify({ rAdd, posts: posts(), v: rRow?.verification }))
    const rId = String(rRow?.id)
    const beforeCheck = JSON.stringify((await rows(refusing, "tenant_custom_domains", { id: rId }))[0])
    const rCheck = await atInstant(T2, () => cd.checkCustomDomainStatusAction(rId))
    const verifyClosed = rCheck.ok === false && gets() === 0 && JSON.stringify((await rows(refusing, "tenant_custom_domains", { id: rId }))[0]) === beforeCheck
    check("verify FAIL CLOSED: no routing GET, ok:false, the row is not patched (was: patched as 'routing unavailable')", verifyClosed, JSON.stringify(rCheck))
    const rDel = await atInstant(T2, () => cd.removeCustomDomainAction(rId))
    const rGone = (await rows(refusing, "tenant_custom_domains", { id: rId }))[0] as any
    const audit = (await rows(refusing, "audit_log")).find((a: any) => a.action === "custom_domain_removed" && a.entity_id === rId) as any
    const detachClosed = rDel.ok === true && dels() === 0 && rGone?.status === "removed" && /routing detach failed: the action ledger refused/.test(String(rGone?.error_detail)) && (audit ? audit.new_values?.routing_detached !== true && audit.after?.routing_detached !== true : true)
    check("detach FAIL CLOSED: no routing DELETE; the host stops being served (row removed) and the row + audit say the detach did NOT run (was: routing_detached:true)", detachClosed, JSON.stringify({ rDel, dels: dels(), error_detail: rGone?.error_detail }))
    const names = namesSeenBy14(f14, stripped("app/actions/custom-domains.ts"))
    const visible = ["tenant.custom_domain.attach", "tenant.custom_domain.verify", "tenant.custom_domain.detach"].every((n) => names.includes(n))
    check("VISIBLE TO §14: attach + verify (computed inside ledgeredRoutingCall, literal at its call sites and in its typed union) and detach are read", visible, JSON.stringify([...new Set(names)]))
    const mutated = stripped("app/actions/custom-domains.ts").replace(`action: "tenant.custom_domain.attach", rowId`, `action: "custom_domain.attach", rowId`)
    check("POSITIVE CONTROL: the same finder reads a call site mutated to the pre-146 two-segment name (so §14 would flag it)", namesSeenBy14(f14, mutated).includes("custom_domain.attach"))
    const at = (n: string) => lineOf("app/actions/custom-domains.ts", n === "detach" ? `action: "tenant.custom_domain.detach",` : `action: "tenant.custom_domain.${n}", rowId`)
    FIVE.push({ action: "tenant.custom_domain.attach", at: at("attach"), lands: attachLands, replay: attachReplay, closed: attachClosed, visible, verdict: "FIXED — a refused claim became `routing_unavailable` + registered_with_vercel:true + ok:true; now ok:false, row untouched" })
    FIVE.push({ action: "tenant.custom_domain.verify", at: at("verify"), lands: verifyLands, replay: verifyReplay, closed: verifyClosed, visible, verdict: "FIXED — same defect as attach (row patched as routing-unavailable); the per-check cycle is deliberate" })
    FIVE.push({ action: "tenant.custom_domain.detach", at: at("detach"), lands: detachLands, replay: detachReplay, closed: detachClosed, visible, verdict: "FIXED — a refused detach audited routing_detached:true; now recorded as not run (row still removed — the safe direction)" })
  }

  // ── 4. listing agreement amendment ─────────────────────────────────────────────────────────────
  {
    console.log("\n  [listing.agreement_amendment.record — app/actions/seller-listing/listing-agreement-amendment.ts]")
    const svc = memSupabase(seed(), { unique: LEDGER_UNIQUE })
    setSvc(svc)
    G.__147F.ctx = { brokerageId: B, userId: U, userType: "broker_owner" }
    G.__147F.amendments = 0
    const am = await import("../app/actions/seller-listing/listing-agreement-amendment")
    const input = { listingId: L, documentId: DOC, executedOn: "2026-10-30", comingSoonStreetAddressAuthorized: true }
    const a1 = await am.recordListingAgreementAmendmentAction(input)
    const lands = a1.success === true && (await asRows(svc, "listing.agreement_amendment.record")).length === 1 && G.__147F.amendments === 1
    check("ROW LANDS: one row, the domain writer ran once", lands, JSON.stringify(a1))
    const a2 = await am.recordListingAgreementAmendmentAction(input)
    const replay = a2.success === false && /already recorded/.test(String(a2.error)) && G.__147F.amendments === 1
    check("REPLAY: the same amendment document again does not record a second version", replay, JSON.stringify(a2))
    const refusing = memSupabase(seed(), { refuse: { agent_action_ledger: "permission denied" } })
    setSvc(refusing)
    G.__147F.amendments = 0
    const a3 = await am.recordListingAgreementAmendmentAction(input)
    const closed = a3.success === false && /ledger refused/.test(String(a3.error)) && G.__147F.amendments === 0
    check("FAIL CLOSED: a refused claim records no amendment and names the refusal", closed, JSON.stringify(a3))
    const src = stripped("app/actions/seller-listing/listing-agreement-amendment.ts")
    check("the `unknown` claim is no longer reported as a refusal (wording fix)", /claim\.kind === "unknown" \? "an earlier attempt/.test(src))
    const visible = namesSeenBy14(f14, src).includes("listing.agreement_amendment.record")
    check("VISIBLE TO §14", visible)
    FIVE.push({ action: "listing.agreement_amendment.record", at: lineOf("app/actions/seller-listing/listing-agreement-amendment.ts", `action: "listing.agreement_amendment.record"`), lands, replay, closed, visible, verdict: "NO CHANGE to behaviour (already correct since 146); one wording fix — an `unknown` claim read 'the action ledger refused: unknown'" })
  }

  // ── 5. life change responder (lane 147G's file — proven, never edited here) ───────────────────
  {
    console.log("\n  [life_change.signal.respond — lib/ai-isa/followup-arbiter.ts (lane 147G owns the file)]")
    const svc = memSupabase(seed(), { unique: LEDGER_UNIQUE })
    setSvc(svc)
    const arb = await import("../lib/ai-isa/followup-arbiter")
    G.__147F.engage = 0
    const deps = {
      recordSignal: async () => ({ id: "sig-1" }),
      engage: async () => { G.__147F.engage++; return { success: true, channel: "email" } },
    }
    const input = { brokerageId: B, subject: { type: "contact" as const, id: C }, signalType: "relocation_detected", source: "action-evidence-census", now: new Date("2026-10-31T09:00:00Z") }
    const r1 = await arb.respondToLifeChangeSignal(svc as any, input as any, deps as any)
    const lands = (await asRows(svc, "life_change.signal.respond")).length === 1 && G.__147F.engage === 1 && r1.action === "isa_engagement"
    check("ROW LANDS: one row, the ISA engaged once", lands, JSON.stringify(r1).slice(0, 200))
    const r2 = await arb.respondToLifeChangeSignal(svc as any, input as any, deps as any)
    const replay = r2.action === "replayed" && G.__147F.engage === 1
    check("REPLAY: the same signal the same day does not engage twice", replay, JSON.stringify(r2).slice(0, 160))
    const refusing = memSupabase(seed(), { refuse: { agent_action_ledger: "permission denied" } })
    G.__147F.engage = 0
    const r3 = await arb.respondToLifeChangeSignal(refusing as any, input as any, deps as any)
    const closed = G.__147F.engage === 0
    check("FAIL CLOSED: a refused claim does not engage the person", closed, JSON.stringify(r3).slice(0, 200))
    outsideLane("a refused claim is labelled as a refusal, not 'replayed' (\"already answered today\")", r3.action === "refused", "147G",
      "lib/ai-isa/followup-arbiter.ts respondToLifeChangeSignal: `replay: () => out` answers EVERY non-acting claim with the pre-set 'replayed' — make it `replay: (claim) => claim.kind === \"refused\" ? refused(`the action ledger refused: ${claim.error}`, subjectClass) : out`")
    const names = namesSeenBy14(f14, stripped("lib/ai-isa/followup-arbiter.ts"))
    const visible = names.includes("life_change.signal.respond")
    check("VISIBLE TO §14: the aliased door `ledger<…>(` (const ledger = deps.ledger ?? withActionLedger) is read — §14 was blind to it before this wave", visible, `aliasAware=${f14.aliasAware}`)
    FIVE.push({ action: "life_change.signal.respond", at: lineOf("lib/ai-isa/followup-arbiter.ts", `action: "life_change.signal.respond"`), lands, replay, closed, visible, verdict: "NO CHANGE here (lane 147G's file) — behaviour correct and closed; a refusal is MISLABELLED 'replayed' (Outside-lane 147G); §14 made alias-aware so the name is seen" })
  }

  console.log("\n  ── five-action table ──")
  for (const r of FIVE) console.log(`  ${r.action.padEnd(40)} ${r.at.padEnd(70)} lands=${r.lands} replay=${r.replay} closed=${r.closed} §14=${r.visible} — ${r.verdict}`)
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// PART II — THE CENSUS
// ═════════════════════════════════════════════════════════════════════════════════════════════════
const BASELINE_FILE = "scripts/action-evidence-census-baseline.json"
interface Baseline { note: string; generated: string; writes: string[]; replayHooks: string[] }

/** The ledger doors a function may reach directly. The dispatch / voice / push / social / portal chokepoints each run
 *  withActionLedger themselves (test:action-ledger §7 + §10 prove it); the census DERIVES every other ledgered lib
 *  function below, so this list is only the door TOKENS, never a list of "known good" callers. */
const DOOR_TOKENS = ["withActionLedger", "ledgeredRoutingCall", "ledgerToolExecutions", "ledgerVoiceDial", "ledgerWebPush", "ledgerSocialPublish", "insertPortalMessage", "dispatchEmail", "dispatchSms", "dispatchDirectMail"]
const DOOR_RE = new RegExp(`\\b(?:${DOOR_TOKENS.join("|")})\\s*(?:<[^>]*>)?\\s*\\(`)
/** Raw provider SDK sends — an outbound message that left WITHOUT a dispatch chokepoint (published list; a send through
 *  a wrapper is judged by whether the wrapper reaches the ledger). */
const SEND_TOKENS: Array<[string, RegExp]> = [
  ["twilio.messages.create", /\.messages\.create\s*\(/],
  ["twilio.calls.create", /\.calls\.create\s*\(/],
  ["resend.emails.send", /\.emails\.send\s*\(/],
  ["sendgrid.send", /\bsgMail\.send\s*\(/],
  ["nodemailer.sendMail", /\.sendMail\s*\(/],
]
/** WRITE ON A CHAIN TABLE: `.from("t")` then, in the same statement, insert / upsert / update / delete. */
const FROM_RE = /\.from\(\s*["'`]([a-z0-9_]+)["'`]\s*\)/g
const WRITE_RE = /\.(insert|upsert|update|delete)\s*\(/

/** The published ALLOW-LIST — a consequential-looking write that is not an act needing a ledger row, each with WHY. */
const ALLOW: Record<string, string> = {}

/** The chain tables, read from scripts/parent-child-graph-guard.ts CHAINS (parent / child of every arrow) — the repo's
 *  one definition; never a second list here. */
function chainTablesFrom(src: string): Set<string> {
  const code = blankComments(src)
  const masked = blankStrings(code)
  const at = masked.indexOf("export const CHAINS")
  if (at < 0) return new Set()
  const open = masked.indexOf("[", masked.indexOf("=", at))
  let depth = 0, end = -1
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i]
    if (ch === "[") depth++
    else if (ch === "]") { depth--; if (depth === 0) { end = i; break } }
  }
  if (end < 0) return new Set()
  const slice = code.slice(open, end)
  return new Set([...slice.matchAll(/\b(?:parent|child):\s*"([a-z0-9_]+)"/g)].map((m) => m[1]))
}

/** Top-level declarations of one (comment-blanked) source: [name, start, end]. A boundary is a line at brace depth 0 that
 *  starts a declaration; a function's extent runs to the next boundary. */
function topLevelFunctions(code: string): Array<{ name: string; start: number; end: number; exported: boolean }> {
  const masked = blankStrings(code)
  const out: Array<{ name: string; start: number; exported: boolean }> = []
  const bounds: number[] = []
  let depth = 0, lineStart = 0
  for (let i = 0; i <= masked.length; i++) {
    if (i === lineStart) {
      const line = masked.slice(i, masked.indexOf("\n", i) < 0 ? masked.length : masked.indexOf("\n", i))
      if (depth === 0 && /^(?:export\s|async\s|function\s|const\s|let\s|class\s|type\s|interface\s|declare\s)/.test(line)) {
        bounds.push(i)
        const fn = /^(export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(line)
          ?? /^(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/.exec(line)
        if (fn) out.push({ name: fn[2], start: i, exported: !!fn[1] })
      }
    }
    const ch = masked[i]
    if (ch === "{") depth++
    else if (ch === "}") depth = Math.max(0, depth - 1)
    else if (ch === "\n") lineStart = i + 1
  }
  return out.map((f) => ({ ...f, end: bounds.find((b) => b > f.start) ?? masked.length }))
}

interface CensusInputs { files: Map<string, string>; chain: Set<string> }
interface WriteHit { key: string; file: string; fn: string; target: string; ledgered: boolean }

/** Every server-action function's consequential writes, and whether it reaches the ledger. */
function censusWrites(inp: CensusInputs, ledgeredLib: Set<string>): WriteHit[] {
  const hits: WriteHit[] = []
  for (const [file, raw] of inp.files) {
    const code = blankComments(raw)
    if (!/^\s*["']use server["']/.test(code)) continue
    const masked = blankStrings(code)
    const fns = topLevelFunctions(code)
    // A same-file function holding a door (directly or through another same-file function) counts as a door.
    const local = new Set<string>()
    for (let round = 0; round < 3; round++) {
      for (const f of fns) {
        const body = masked.slice(f.start, f.end)
        if (DOOR_RE.test(body) || [...local, ...ledgeredLib].some((n) => n !== f.name && new RegExp(`\\b${n}\\s*\\(`).test(body))) local.add(f.name)
      }
    }
    for (const f of fns) {
      const bodyCode = code.slice(f.start, f.end)
      const bodyMask = masked.slice(f.start, f.end)
      const targets = new Set<string>()
      for (const m of bodyCode.matchAll(FROM_RE)) {
        if (!inp.chain.has(m[1])) continue
        const at = m.index ?? 0
        if (!/\.from\(/.test(bodyMask.slice(at, at + 7))) continue // the `.from(` token is inside a string specimen
        const next = bodyMask.indexOf(".from(", at + 6)
        const stmt = bodyMask.slice(at, Math.min(next === -1 ? bodyMask.length : next, at + 700))
        if (WRITE_RE.test(stmt)) targets.add(m[1])
      }
      for (const [name, re] of SEND_TOKENS) if (re.test(bodyMask)) targets.add(`send:${name}`)
      if (targets.size === 0) continue
      const ledgered = local.has(f.name)
      for (const t of targets) hits.push({ key: `${file}::${f.name}::${t}`, file, fn: f.name, target: t, ledgered })
    }
  }
  return hits
}

/** Every lib function (any file) that holds a ledger door directly or through another such function — DERIVED. */
function ledgeredLibFunctions(files: Map<string, string>): Set<string> {
  const bodies: Array<{ name: string; body: string }> = []
  for (const [file, raw] of files) {
    if (!file.startsWith("lib/")) continue
    const code = blankComments(raw)
    const masked = blankStrings(code)
    for (const f of topLevelFunctions(code)) if (f.exported) bodies.push({ name: f.name, body: masked.slice(f.start, f.end) })
  }
  const out = new Set<string>()
  for (const b of bodies) if (DOOR_RE.test(b.body)) out.add(b.name)
  for (let round = 0; round < 4; round++) {
    let grew = false
    const names = [...out]
    for (const b of bodies) {
      if (out.has(b.name)) continue
      if (names.some((n) => new RegExp(`\\b${n}\\s*\\(`).test(b.body))) { out.add(b.name); grew = true }
    }
    if (!grew) break
  }
  return out
}

interface ReplayHit { key: string; file: string; fn: string; verdict: "aware" | "blind" | "delegated" | "no_hook" }
/** Every withActionLedger call (and alias) → how its `replay` hook treats the claim. */
function censusReplayHooks(files: Map<string, string>, ledgerSrc: string): ReplayHit[] {
  const out: ReplayHit[] = []
  const awareNamed = (name: string, src: string): boolean => {
    const m = new RegExp(`function\\s+${name}\\s*\\(\\s*([A-Za-z_$][\\w$]*)[\\s\\S]{0,800}?\\n\\}`).exec(src)
    return !!m && new RegExp(`\\b${m[1]}\\.kind\\b|"error" in ${m[1]}|\\b${m[1]}\\.entry\\b`).test(m[0])
  }
  for (const [file, raw] of files) {
    const code = blankComments(raw)
    if (file === "lib/kernel/action-ledger.ts") continue // the ledger itself defines the door
    const masked = blankStrings(code)
    const aliases = [...masked.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*[^\n;]*\bwithActionLedger\b(?!\s*(?:<[^>]*>)?\s*\()/g)].map((m) => m[1])
    const door = new RegExp(`\\b(?:withActionLedger${aliases.map((a) => `|${a}`).join("")})\\s*(?:<[^>]*>)?\\s*\\(`, "g")
    if (!door.test(masked)) continue
    door.lastIndex = 0
    const fns = topLevelFunctions(code)
    const ordinal = new Map<string, number>()
    for (const m of masked.matchAll(door)) {
      const at = m.index ?? 0
      if (/function\s*$/.test(masked.slice(Math.max(0, at - 30), at))) continue // a declaration, not a call
      // the call's argument span: match the opening paren to its close on the string-blanked text
      const open = masked.indexOf("(", at + m[0].length - 1)
      let depth = 0, close = masked.length
      for (let i = open; i < masked.length; i++) { const ch = masked[i]; if (ch === "(") depth++; else if (ch === ")") { depth--; if (depth === 0) { close = i; break } } }
      const span = masked.slice(open, close)
      const enclosing = fns.filter((f) => f.start <= at && at < f.end).pop()?.name ?? "(module)"
      const n = (ordinal.get(enclosing) ?? 0) + 1
      ordinal.set(enclosing, n)
      const key = `${file}::${enclosing}::${n}`
      const r = /\breplay\s*:\s*/.exec(span) ?? /\breplay\s*\(/.exec(span)
      let verdict: ReplayHit["verdict"]
      if (!r) verdict = "no_hook"
      else {
        const rest = span.slice(r.index + r[0].length)
        const param = /^(?:async\s*)?\(\s*([A-Za-z_$][\w$]*)?\s*(?::[^)]*)?\)\s*(?::[^=]*)?=>/.exec(rest) ?? (/^\(/.test(r[0].slice(-1)) ? /^\s*([A-Za-z_$][\w$]*)?/.exec(rest) : null)
        if (param) {
          const p = param[1]
          const body = rest.slice(param[0].length, param[0].length + 900)
          verdict = p && !p.startsWith("_") && new RegExp(`\\b${p}\\.kind\\b|"error" in ${p}|\\b${p}\\.entry\\b|\\b${p}\\.error\\b|\\(\\s*${p}\\s*\\)`).test(body) ? "aware" : "blind"
        } else {
          const ref = /^([A-Za-z_$][\w$.]*)/.exec(rest)?.[1] ?? ""
          verdict = ref && (awareNamed(ref, code) || awareNamed(ref, ledgerSrc)) ? "aware" : "delegated"
        }
      }
      out.push({ key, file, fn: enclosing, verdict })
    }
  }
  return out
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, e.name)
    if (e.isDirectory()) { if (!/^(node_modules|\.next)$/.test(e.name)) walk(rel, out) }
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(rel)
  }
  return out
}

async function partTwo(): Promise<void> {
  console.log("\n══ PART II — the repository-wide action-evidence census (stripped source) ══")
  const write = process.argv.includes("--write-baseline")
  const chain = chainTablesFrom(read("scripts/parent-child-graph-guard.ts"))
  const live = new Set<string>(LIVE_TABLES as readonly string[])
  const childKeys = (stripComments(read("scripts/parent-child-graph-guard.ts")).match(/\bchild:\s*"[a-z0-9_]+"/g) ?? []).length
  check(`the chain tables are read from scripts/parent-child-graph-guard.ts CHAINS (${chain.size} tables from ${childKeys} arrows) and every one is LIVE`,
    chain.size > 0 && [...chain].every((t) => live.has(t)), [...chain].filter((t) => !live.has(t)).join(", "))
  check("POSITIVE CONTROL (chain parse): a specimen CHAINS literal yields exactly its parent/child tables, not a mirror or a comment",
    JSON.stringify([...chainTablesFrom(`// child: "ghost"\nexport const CHAINS: X[] = [ { arrows: [ { parent: "a", child: "b", mirrors: [{ table: "m" }] }, { parent: null, child: "c" } ] } ]\nconst OTHER = [{ child: "z" }]`)].sort()) === JSON.stringify(["a", "b", "c"]))

  const files = new Map<string, string>()
  for (const rel of [...walk("lib"), ...walk("app")]) files.set(rel, read(rel))
  const ledgeredLib = ledgeredLibFunctions(files)
  const serverFiles = [...files].filter(([, s]) => /^\s*["']use server["']/.test(blankComments(s))).length

  // ── positive controls on the write finder ──
  {
    const spec = new Map<string, string>([["app/actions/zz-spec.ts", [
      `"use server"`,
      `// TOMBSTONE: svc.from("chain_t").insert({}) moved to lib/x.ts:1`,
      `const SPECIMEN = \`await svc.from("chain_t").insert({ a: 1 })\``,
      `async function helper() { return withActionLedger(ctx, run, hooks) }`,
      `export async function bare() { await svc.from("chain_t").insert({ a: 1 }) }`,
      `export async function wrapped() { return withActionLedger(ctx, async () => svc.from("chain_t").update({ a: 1 }).eq("id", 1), hooks) }`,
      `export async function viaHelper() { await svc.from("chain_t").delete().eq("id", 1); await helper() }`,
      `export async function viaLib() { await svc.from("chain_t").upsert({ a: 1 }); await libLedgered() }`,
      `export async function texts() { await client.messages.create({ to: "x" }) }`,
      `export async function other() { await svc.from("not_chain").insert({ a: 1 }) }`,
    ].join("\n")]])
    const h = censusWrites({ files: spec, chain: new Set(["chain_t"]) }, new Set(["libLedgered"]))
    const by = (fn: string) => h.filter((x) => x.fn === fn)
    check("POSITIVE CONTROL (writes): an unledgered chain write and a raw provider send are offenders",
      by("bare").length === 1 && !by("bare")[0].ledgered && by("texts").length === 1 && by("texts")[0].target === "send:twilio.messages.create" && !by("texts")[0].ledgered)
    check("POSITIVE CONTROL (writes): a write inside withActionLedger, behind a same-file ledgered helper, or behind a DERIVED ledgered lib function is ledgered",
      by("wrapped")[0]?.ledgered === true && by("viaHelper")[0]?.ledgered === true && by("viaLib")[0]?.ledgered === true)
    check("POSITIVE CONTROL (writes): a TOMBSTONE, a string specimen and a non-chain table are NOT writes (stripped + blankStrings)",
      h.every((x) => x.fn !== "(module)") && by("other").length === 0 && h.length === 5)
  }

  // ── II.1 consequential writes ──
  const hits = censusWrites({ files, chain }, ledgeredLib)
  const ledgered = hits.filter((h) => h.ledgered)
  const allowed = hits.filter((h) => !h.ledgered && ALLOW[h.key])
  const offenders = hits.filter((h) => !h.ledgered && !ALLOW[h.key]).map((h) => h.key).sort()
  const filesWithOffenders = new Set(offenders.map((k) => k.split("::")[0]))
  console.log(`  · ${serverFiles} "use server" files under lib/ + app/; ${hits.length} consequential write site(s) (function × target) in them: ${ledgered.length} reach the ledger, ${allowed.length} allow-listed, ${offenders.length} do not (in ${filesWithOffenders.size} files)`)
  console.log(`  · derived ledgered lib functions (hold a door directly or through one another): ${ledgeredLib.size}`)

  // ── II.2 replay hooks ──
  const hooks = censusReplayHooks(files, stripComments(read("lib/kernel/action-ledger.ts")))
  {
    const spec = new Map<string, string>([["lib/zz-spec.ts", [
      `export async function a() { return withActionLedger(c, run, { settle, replay: () => null }) }`,
      `export async function b() { return withActionLedger(c, run, { settle, replay: (claim) => claim.kind === "refused" ? x : y }) }`,
      `export async function c2() { return withActionLedger(c, run, { settle, replay: (_c) => out }) }`,
      `export async function d() { return withActionLedger(c, run, { settle, replay: replayDispatchResult }) }`,
      `export async function e() { const ledger = deps.ledger ?? withActionLedger\n  return ledger<T>(c, run, { settle, replay: () => out }) }`,
      `// replay: () => ok — a comment`,
    ].join("\n")]])
    const h = censusReplayHooks(spec, `export function replayDispatchResult(claim: NonActingClaim): DispatchLike {\n  if (claim.kind === "refused") return x\n  return y\n}`)
    const v = (fn: string) => h.find((x) => x.fn === fn)?.verdict
    check("POSITIVE CONTROL (replay hooks): `() => …` and `(_c) => …` are BLIND, `(claim) => claim.kind…` is aware, a named adapter that reads the kind is aware, an ALIASED door is seen, a comment is not a hook",
      v("a") === "blind" && v("b") === "aware" && v("c2") === "blind" && v("d") === "aware" && v("e") === "blind" && h.length === 5, JSON.stringify(h))
  }
  const blind = hooks.filter((h) => h.verdict === "blind").map((h) => h.key).sort()
  const counts = (["aware", "blind", "delegated", "no_hook"] as const).map((k) => `${k} ${hooks.filter((h) => h.verdict === k).length}`).join(" · ")
  console.log(`  · ${hooks.length} withActionLedger call(s) (aliases included) under lib/ + app/: ${counts}`)
  for (const h of hooks.filter((x) => x.verdict === "delegated" || x.verdict === "no_hook")) console.log(`      ${h.verdict}: ${h.key} (hooks passed by reference — judged where they are built, not here)`)

  // ── II.3 computed-name doors ──
  {
    const computed: string[] = []
    for (const [file, raw] of files) {
      const masked = blankStrings(blankComments(raw))
      for (const m of masked.matchAll(/\bwithActionLedger\s*(?:<[^>]*>)?\s*\(/g)) {
        const win = blankComments(raw).slice(m.index!, m.index! + 1500)
        const v = /\baction:\s*([^,\n}]+)/.exec(win)?.[1]?.trim() ?? ""
        if (v && !/^["'`]/.test(v) && file !== "lib/kernel/action-ledger.ts") computed.push(`${file}: action: ${v.slice(0, 60)}`)
      }
    }
    console.log(`  · ${computed.length} withActionLedger door(s) pass a COMPUTED action name (published — §14 reads a computed name only where the helper is itself a door with literal call sites, e.g. ledgeredRoutingCall, or through the ledger's runtime refusal):`)
    for (const c of computed.slice(0, 40)) console.log(`      ${c}`)
    if (computed.length > 40) console.log(`      … ${computed.length - 40} more`)
  }

  // ── the ratchet ──
  if (write) {
    const b: Baseline = {
      note: "FROZEN DEBT (wave 147, lane 147F): server-action consequential writes that do not reach the action ledger, and withActionLedger replay hooks that cannot tell `refused` from `replay`. Only ever SHRINKS: a fixed entry is removed by re-running with --write-baseline; a new offender is red.",
      generated: new Date().toISOString().slice(0, 10),
      writes: offenders,
      replayHooks: blind,
    }
    writeFileSync(join(ROOT, BASELINE_FILE), JSON.stringify(b, null, 2) + "\n")
    console.log(`  · baseline WRITTEN: ${offenders.length} write offender(s), ${blind.length} blind replay hook(s) → ${BASELINE_FILE}`)
  }
  const base = existsSync(join(ROOT, BASELINE_FILE)) ? (JSON.parse(read(BASELINE_FILE)) as Baseline) : null
  check(`the frozen baseline exists (${BASELINE_FILE})`, !!base)
  if (base) {
    const baseW = new Set(base.writes), baseH = new Set(base.replayHooks)
    const newW = offenders.filter((k) => !baseW.has(k))
    const newH = blind.filter((k) => !baseH.has(k))
    const fixedW = base.writes.filter((k) => !offenders.includes(k))
    const fixedH = base.replayHooks.filter((k) => !blind.includes(k))
    console.log(`  · ratchet: writes ${offenders.length} now / ${base.writes.length} frozen (${fixedW.length} fixed since — tighten with --write-baseline) · blind replay hooks ${blind.length} now / ${base.replayHooks.length} frozen (${fixedH.length} fixed since)`)
    check(`no NEW unledgered consequential write in a server action (${newW.length ? newW.join("; ") : "0 new"})`, newW.length === 0)
    check(`no NEW refusal-blind replay hook (${newH.length ? newH.join("; ") : "0 new"})`, newH.length === 0)
    for (const k of offenders.filter((k) => baseW.has(k)).slice(0, 12)) console.log(`      frozen: ${k}`)
    if (offenders.length > 12) console.log(`      … ${offenders.length - 12} more frozen write offenders (the full list is the baseline file)`)
  }
  check("the five actions' replay hooks are all claim-aware (none of them is in the blind set)",
    !blind.some((k) => /business-card-actions\.ts::(crosswalkBusinessIdentity|confirmBusinessCardScan)::|custom-domains\.ts::(ledgeredRoutingCall|removeCustomDomainAction)::|listing-agreement-amendment\.ts::/.test(k)))

  console.log("\n  [blind spots — published beside the numbers]")
  console.log("  · granularity is FUNCTION-level: a function that ledgers one act and writes another chain table outside the run reads as ledgered")
  console.log("  · only writes LEXICALLY inside a \"use server\" file are attributed; a write delegated to a non-\"use server\" lib module is judged in that module only if it is itself a server action")
  console.log("  · ledgered lib functions are matched by NAME (a same-named unledgered function elsewhere would read as ledgered — over-approximation)")
  console.log("  · a top-level function's extent runs to the next top-level declaration; a class method or an object-literal action is attributed to its enclosing declaration")
  console.log("  · provider sends are the five raw SDK shapes listed above; a fetch() to a provider URL is not recognised (test:egress-coverage owns raw egress)")
  console.log("  · a replay hook is 'aware' when it reads the claim's kind / error / entry; whether its per-kind answer is HONEST is proven only for the five actions (Part I)")
  console.log("  · chain tables are the parent-child graph's CHAINS; a consequential table outside every chain (e.g. a pure ledger) is not counted")
}

async function main(): Promise<void> {
  await partOne()
  await partTwo()
  console.log(`\n RESULT: ${pass} passed, ${fail} failed${pending.length ? `, ${pending.length} pending (outside lane)` : ""}`)
  for (const p of pending) console.log(`   ◌ ${p}`)
  for (const f of failures) console.log(`   ✗ ${f}`)
  process.exit(fail > 0 ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
