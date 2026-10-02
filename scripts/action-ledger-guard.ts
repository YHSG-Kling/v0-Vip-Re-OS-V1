/**
 * ACTION LEDGER + FLIGHT RECORDER + CAUSATION — the proof (wave 97, lane 97A).
 *
 * Runs the REAL ledger (lib/kernel/action-ledger.ts) and the REAL causation scope
 * (lib/kernel/causation.ts) against an in-memory table that enforces the m687 UNIQUE
 * idempotency_key the way Postgres does (23505). No network, no live rows.
 *
 *   1. a duplicate idempotency key does not double-send (sequential AND concurrent);
 *      positive control: with no cycle the same call DOES send twice;
 *   2. a provider timeout settles 'unknown' and is NOT retried; positive control: an ordinary
 *      failure IS retried (attempts 2);
 *   3. wait / do_nothing are recorded (status skipped, reason code), unknown codes → UNSPECIFIED;
 *   4. causation threads parent → child (event scope → child scope keeps the root; the ledger row
 *      carries the cause); the chain explains an action root-first; positive control outside a scope;
 *   5. the flight recorder takes its tenant from the SESSION (detector + positive control on a
 *      specimen that takes brokerageId from its arguments);
 *   6. degrade: an absent table proceeds unledgered; any other refusal with a key fails closed;
 *   7. chokepoints: the three dispatchers run inside withActionLedger, the kernel processor opens
 *      the scope, emitKernelEvent writes the lineage and survives PGRST204;
 *   8. m687 agrees with the code (vocabularies DERIVED from both sides, not pinned).
 * Scans read stripped source (scripts/strip-comments.ts).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import {
  assembleCausalChain,
  recordNonAction,
  replayDispatchResult,
  settleDispatchResult,
  withActionLedger,
  type ActionContext,
  type DispatchLike,
  type LedgerClient,
} from "../lib/kernel/action-ledger"
import { currentCausation, withCausationFrom } from "../lib/kernel/causation"

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const root = process.cwd()
const read = (rel: string) => readFileSync(join(root, rel), "utf8")
const code = (rel: string) => blankStrings(stripComments(read(rel)))
// Only the ledger's PUBLIC surface is imported (what the product calls); its vocabularies are
// read from the module's own source so the proof never widens the export surface.
const ACTION_LEDGER_GATE_KEY = "action_ledger_gate"
function vocabFromSource(name: string): string[] {
  const src = stripComments(read("lib/kernel/action-ledger.ts"))
  const m = new RegExp(`const ${name}\\s*=\\s*\\[([^\\]]*)\\]`, "s").exec(src)
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : []
}
const ACTION_STATUSES = vocabFromSource("ACTION_STATUSES")
const ACTION_ACTOR_TYPES = vocabFromSource("ACTION_ACTOR_TYPES")
const ACTION_REASON_CODES = vocabFromSource("ACTION_REASON_CODES")

// ─── in-memory agent_action_ledger with Postgres' UNIQUE semantics ───────────
type Row = Record<string, unknown>
function fakeLedger(opts: { insertError?: { code: string; message: string } } = {}) {
  const rows: Row[] = []
  let seq = 0
  const client: LedgerClient = {
    from(_table: string) {
      const filters: Array<[string, unknown]> = []
      let op: "select" | "insert" | "update" = "select"
      let payload: Row = {}
      const match = (r: Row) => filters.every(([k, v]) => r[k] === v)
      const run = (): { data: unknown; error: { code: string; message: string } | null } => {
        if (op === "insert") {
          if (opts.insertError) return { data: null, error: opts.insertError }
          const key = payload.idempotency_key
          if (key != null && rows.some((r) => r.idempotency_key === key)) {
            return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint agent_action_ledger_idempotency_key_key" } }
          }
          const row = { id: `row-${++seq}`, attempts: 1, ...payload }
          rows.push(row)
          return { data: [row], error: null }
        }
        if (op === "update") {
          const hit = rows.filter(match)
          for (const r of hit) Object.assign(r, payload)
          return { data: hit.map((r) => ({ id: r.id })), error: null }
        }
        return { data: rows.filter(match), error: null }
      }
      const b = {
        insert(row: Row) { op = "insert"; payload = row; return b },
        update(patch: Row) { op = "update"; payload = patch; return b },
        select(_c?: string) { return b },
        eq(k: string, v: unknown) { filters.push([k, v]); return b },
        single() { const r = run(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }) },
        maybeSingle() { const r = run(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : null, error: r.error }) },
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return Promise.resolve(run()).then(res, rej) },
      }
      return b
    },
  }
  return { client, rows }
}

const TENANT = "11111111-1111-4111-8111-111111111111"
const CONTACT = "22222222-2222-4222-8222-222222222222"
function ctx(over: Partial<ActionContext> = {}): ActionContext {
  return {
    brokerageId: TENANT, action: "comms.email.send", channel: "email",
    actor: { type: "manager", managerKey: "deal_coordinator" },
    subject: { type: "contact", id: CONTACT }, reasonCode: "TRANSACTION_DEADLINE",
    cycle: "deadline-abc:2026-10-02", riskClass: "COMMUNICATION", ...over,
  }
}
const hooks = (cost: number | null) => ({
  settle: (r: DispatchLike) => settleDispatchResult(r, cost),
  replay: replayDispatchResult,
})

async function main() {
  console.log("\n[1 · a duplicate idempotency key does not double-send]")
  {
    const { client, rows } = fakeLedger()
    let sends = 0
    const send = async (): Promise<DispatchLike> => { sends++; return { success: true, providerKey: "sendgrid", messageId: "msg-1" } }
    const a = await withActionLedger(ctx(), send, hooks(0.001), { client })
    const b = await withActionLedger(ctx(), send, hooks(0.001), { client })
    check("first call sends and settles executed", a.success && rows[0]?.status === "executed" && rows[0]?.provider_ref === "msg-1")
    check("second call with the same cycle does NOT send (provider called once)", sends === 1, `sends=${sends}`)
    check("the retry replays the winner's message id", b.success === true && b.messageId === "msg-1")
    check("one ledger row for the key", rows.length === 1)
    check("idempotency key is deterministic tenant:subject_type:subject:action:cycle",
      rows[0]?.idempotency_key === `${TENANT}:contact:${CONTACT}:comms.email.send:deadline-abc:2026-10-02`)
    check("cost recorded on the executed row", rows[0]?.cost_usd === 0.001)

    // concurrent race: the loser's insert is refused 23505 while the winner is still in flight
    const race = fakeLedger()
    let raceSends = 0
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const slow = async (): Promise<DispatchLike> => { raceSends++; await gate; return { success: true, providerKey: "sendgrid", messageId: "m-race" } }
    const p1 = withActionLedger(ctx(), slow, hooks(null), { client: race.client })
    await new Promise((r) => setTimeout(r, 5))
    const p2 = await withActionLedger(ctx(), slow, hooks(null), { client: race.client })
    release()
    await p1
    check("concurrent duplicate: the 23505 loser re-reads the winner and is refused in-flight", p2.success === false && p2.providerKey === ACTION_LEDGER_GATE_KEY && /in flight/.test(p2.error ?? ""))
    check("concurrent duplicate: provider called once", raceSends === 1, `sends=${raceSends}`)

    // POSITIVE CONTROL: no cycle → recorded but not de-duplicated → two sends
    const ctl = fakeLedger()
    let ctlSends = 0
    const ctlSend = async (): Promise<DispatchLike> => { ctlSends++; return { success: true, providerKey: "sendgrid" } }
    await withActionLedger(ctx({ cycle: null }), ctlSend, hooks(null), { client: ctl.client })
    await withActionLedger(ctx({ cycle: null }), ctlSend, hooks(null), { client: ctl.client })
    check("POSITIVE CONTROL: without a cycle the same call sends twice (the key is what stops it)", ctlSends === 2 && ctl.rows.length === 2 && ctl.rows.every((r) => r.idempotency_key === null))
  }

  console.log("\n[2 · a timeout is 'unknown' and is not retried]")
  {
    const { client, rows } = fakeLedger()
    let calls = 0
    const timesOut = async (): Promise<DispatchLike> => { calls++; return { success: false, providerKey: "twilio", error: "ETIMEDOUT: provider did not answer" } }
    await withActionLedger(ctx({ action: "comms.sms.send" }), timesOut, hooks(null), { client })
    check("provider timeout settles status 'unknown'", rows[0]?.status === "unknown" && rows[0]?.outcome === "provider_timeout")
    const again = await withActionLedger(ctx({ action: "comms.sms.send" }), timesOut, hooks(null), { client })
    check("the retry does NOT call the provider", calls === 1, `calls=${calls}`)
    check("the retry is refused with an unknown-outcome reason", !again.success && again.providerKey === ACTION_LEDGER_GATE_KEY && /unknown/.test(again.error ?? ""))

    const thrown = fakeLedger()
    await withActionLedger(ctx(), async () => { throw new Error("Request timed out after 30000ms") }, hooks(null), { client: thrown.client }).catch(() => null)
    check("a THROWN timeout also settles 'unknown'", thrown.rows[0]?.status === "unknown")

    // POSITIVE CONTROL: an ordinary failure IS retried (nothing left the building)
    const ctl = fakeLedger()
    let ctlCalls = 0
    const flaky = async (): Promise<DispatchLike> => { ctlCalls++; return ctlCalls === 1 ? { success: false, providerKey: "sendgrid", error: "401 invalid api key" } : { success: true, providerKey: "sendgrid", messageId: "m2" } }
    await withActionLedger(ctx(), flaky, hooks(null), { client: ctl.client })
    const second = await withActionLedger(ctx(), flaky, hooks(null), { client: ctl.client })
    check("POSITIVE CONTROL: a plain failure is re-claimed and retried (attempts 2, executed)", ctlCalls === 2 && second.success && ctl.rows[0]?.attempts === 2 && ctl.rows[0]?.status === "executed")

    const gated = settleDispatchResult({ success: false, providerKey: "deconflict_gate", error: "Outbound deferred" }, null)
    check("a *_gate refusal is 'skipped' (nothing sent; a later cycle may send)", gated.status === "skipped" && gated.outcome === "deconflict_gate")
  }

  console.log("\n[3 · wait / do_nothing are recorded]")
  {
    const { client, rows } = fakeLedger()
    const r = await recordNonAction({ ...ctx(), decision: "do_nothing", reasonCode: "NO_ACTION_NEEDED", reasonDetail: "intent flat for 14 days" }, { client })
    check("do_nothing recorded as status skipped", r.recorded && rows[0]?.status === "skipped" && rows[0]?.outcome === "do_nothing")
    check("do_nothing action is agent.decision.do_nothing with its reason", rows[0]?.action === "agent.decision.do_nothing" && rows[0]?.reason_code === "NO_ACTION_NEEDED")
    await recordNonAction({ ...ctx(), decision: "wait", reasonCode: "WAIT_COOLDOWN", until: "2026-10-05" }, { client: fakeLedger().client })
    const w = fakeLedger()
    await recordNonAction({ ...ctx(), decision: "wait", reasonCode: "WAIT_COOLDOWN", until: "2026-10-05" }, { client: w.client })
    check("wait recorded with its until", w.rows[0]?.action === "agent.decision.wait" && (w.rows[0]?.detail as Row)?.until === "2026-10-05")
    const bogus = fakeLedger()
    await recordNonAction({ ...ctx(), decision: "do_nothing", reasonCode: "BECAUSE_I_SAID" }, { client: bogus.client })
    check("an unknown reason code is recorded as UNSPECIFIED (never an invented code)", bogus.rows[0]?.reason_code === "UNSPECIFIED")
    const named = fakeLedger()
    let namedSends = 0
    await withActionLedger(ctx({ action: "sendEmail", cycle: null }), async () => { namedSends++; return { success: true, providerKey: "s" } as DispatchLike }, hooks(null), { client: named.client })
    check("POSITIVE CONTROL: a non domain.entity.action name is refused by the ledger (no row) and the send still goes", named.rows.length === 0 && namedSends === 1)
  }

  console.log("\n[4 · causation threads parent → child]")
  {
    check("POSITIVE CONTROL: outside any scope the cause is null", currentCausation().causationId === null && currentCausation().correlationId === null)
    const seen: Array<{ c: string | null; r: string | null }> = []
    const { client, rows } = fakeLedger()
    await withCausationFrom("evt-root", async () => {
      seen.push({ c: currentCausation().causationId, r: currentCausation().correlationId })
      await new Promise((r) => setTimeout(r, 1)) // survives an await hop
      await withCausationFrom("evt-child", async () => {
        seen.push({ c: currentCausation().causationId, r: currentCausation().correlationId })
        await withActionLedger(ctx({ cycle: null }), async () => ({ success: true, providerKey: "sendgrid" }), hooks(null), { client })
      })
    })
    check("root scope: cause = root, correlation = root", seen[0]?.c === "evt-root" && seen[0]?.r === "evt-root")
    check("child scope: cause = child, correlation stays the ROOT", seen[1]?.c === "evt-child" && seen[1]?.r === "evt-root")
    check("the ledger row records the event it was caused by", rows[0]?.causation_id === "evt-child" && rows[0]?.correlation_id === "evt-root")
    check("explicit causation wins over the scope", (await (async () => {
      const f = fakeLedger()
      await withCausationFrom("evt-x", () => withActionLedger(ctx({ cycle: null, causationId: "evt-explicit" }), async () => ({ success: true, providerKey: "s" }), hooks(null), { client: f.client }))
      return f.rows[0]?.causation_id === "evt-explicit"
    })()))
    check("scope does not leak after it closes", currentCausation().causationId === null)

    const chain = assembleCausalChain(
      [
        { id: "evt-root", event_type: "TRANSACTION_DEADLINE_APPROACHING", entity_type: "transaction", entity_id: "t1", created_at: "2026-10-02T10:00:00Z", causation_id: null },
        { id: "evt-child", event_type: "TASK_CREATED", entity_type: "transaction", entity_id: "t1", created_at: "2026-10-02T10:00:01Z", causation_id: "evt-root", correlation_id: "evt-root" },
      ],
      [{ id: "a1", action: "comms.email.send", status: "executed", reason_code: "TRANSACTION_DEADLINE", subject_type: "contact", subject_id: CONTACT, actor_type: "manager", created_at: "2026-10-02T10:00:02Z", causation_id: "evt-child", correlation_id: "evt-root" }],
    )
    const act = chain.find((l) => l.kind === "action")
    check("the chain is time-ordered (root, child, action)", chain.map((l) => l.id).join(",") === "evt-root,evt-child,a1")
    check("'why did the AI send this?' — the action's because is root-first", act?.because?.join(">") === "TRANSACTION_DEADLINE_APPROACHING>TASK_CREATED" && act?.reasonCode === "TRANSACTION_DEADLINE")
    const cyc = assembleCausalChain([{ id: "e1", event_type: "A", entity_type: "x", entity_id: "y", created_at: "t", causation_id: "e2" }, { id: "e2", event_type: "B", entity_type: "x", entity_id: "y", created_at: "t", causation_id: "e1" }], [])
    check("a causation cycle terminates", cyc.length === 2)
  }

  console.log("\n[5 · the flight recorder's tenant comes from the session]")
  {
    const tenantFromArgs = (src: string): string[] => {
      const findings: string[] = []
      const sig = /export\s+async\s+function\s+(\w+)\s*\(([^)]*)\)/g
      let m: RegExpExecArray | null
      while ((m = sig.exec(src))) if (/brokerage/i.test(m[2])) findings.push(`${m[1]} takes a tenant argument`)
      if (!/ctx\.brokerageId/.test(src)) findings.push("tenant is not read from the session context")
      const gateAt = src.search(/resolveTenantAdmin\s*\(/)
      const svcAt = src.search(/createServiceClient\s*\(\s*\)/)
      if (gateAt < 0 || svcAt < 0 || gateAt > svcAt) findings.push("service client before the gate")
      const froms = (src.match(/\.from\(/g) ?? []).length
      const pinned = (src.match(/\.eq\(\s*"?brokerage_id"?|\.eq\("brokerage_id"/g) ?? []).length
      if (pinned < froms) findings.push(`${froms - pinned} read(s) not pinned to the tenant`)
      return findings
    }
    const live = stripComments(read("app/actions/flight-recorder.ts"))
    const f = tenantFromArgs(live)
    check("getEntityCausalChain: no tenant argument, session tenant, gate before service client, every read pinned", f.length === 0, f.join("; "))
    check("the file is a 'use server' module and the export is async", /^"use server"/.test(live.trim()) && /export async function getEntityCausalChain/.test(live))
    const specimen = `"use server"\nexport async function bad(input: { brokerageId: string }) { const svc = createServiceClient(); await resolveTenantAdmin(); return svc.from("x").select("*") }`
    check("POSITIVE CONTROL: the detector flags a specimen that takes brokerageId from its arguments", tenantFromArgs(specimen).length >= 3)
    check("a survivor surface mounts it (app/dashboard/admin/ai-audit)", /getEntityCausalChain\s*\(/.test(stripComments(read("app/dashboard/admin/ai-audit/page.tsx"))))
  }

  console.log("\n[6 · degrades until m687 is applied; fails closed otherwise]")
  {
    const absent = fakeLedger({ insertError: { code: "PGRST205", message: "Could not find the table 'public.agent_action_ledger' in the schema cache" } })
    let sent = 0
    const r = await withActionLedger(ctx(), async () => { sent++; return { success: true, providerKey: "sendgrid" } as DispatchLike }, hooks(null), { client: absent.client })
    check("table absent (PGRST205) → the send proceeds unledgered", sent === 1 && r.success)
    let sent42 = 0
    const r42 = await withActionLedger(ctx(), async () => { sent42++; return { success: true, providerKey: "sendgrid" } as DispatchLike }, hooks(null), { client: fakeLedger({ insertError: { code: "42P01", message: "relation does not exist" } }).client })
    check("42P01 → unledgered (read, logged, not thrown) and the send proceeds", sent42 === 1 && r42.success)
    const nonAct = await recordNonAction({ ...ctx(), decision: "wait" }, { client: fakeLedger({ insertError: { code: "PGRST205", message: "no table" } }).client })
    check("a wait before m687 degrades quietly (not recorded, no error surfaced)", nonAct.recorded === false && !nonAct.error)
    check("POSITIVE CONTROL: the vocabulary reader finds the module's lists", ACTION_STATUSES.length === 5 && ACTION_ACTOR_TYPES.length === 4 && ACTION_REASON_CODES.includes("UNSPECIFIED"))
    const refused = fakeLedger({ insertError: { code: "42501", message: "permission denied" } })
    let sent2 = 0
    const r2 = await withActionLedger(ctx(), async () => { sent2++; return { success: true, providerKey: "sendgrid" } as DispatchLike }, hooks(null), { client: refused.client })
    check("any other refusal with an idempotency key FAILS CLOSED (no send)", sent2 === 0 && !r2.success && r2.providerKey === ACTION_LEDGER_GATE_KEY)
    let sent3 = 0
    await withActionLedger(ctx({ cycle: null }), async () => { sent3++; return { success: true, providerKey: "sendgrid" } as DispatchLike }, hooks(null), { client: fakeLedger({ insertError: { code: "42501", message: "permission denied" } }).client })
    check("a recording-only claim (no key) does not take the channel down", sent3 === 1)
  }

  console.log("\n[7 · wired at the chokepoints]")
  {
    const disp = stripComments(read("lib/providers/dispatch.ts"))
    for (const fn of ["dispatchEmail", "dispatchSms", "dispatchDirectMail"]) {
      const at = disp.indexOf(`export async function ${fn}`)
      const head = at >= 0 ? disp.slice(at, at + 600) : ""
      check(`${fn} runs inside withActionLedger`, /return\s+withActionLedger\s*\(\s*ledgerContextFor\(/.test(head))
    }
    const wrapped = (disp.match(/return\s+withActionLedger\s*\(/g) ?? []).length
    const closers = (disp.match(/\},\s*dispatchLedgerHooks\(/g) ?? []).length
    check("every ledger wrapper is closed with its settle/replay hooks", wrapped === 3 && closers === 3, `wrapped=${wrapped} closers=${closers}`)
    check("POSITIVE CONTROL: the wrapper finder sees a specimen", /return\s+withActionLedger\s*\(\s*ledgerContextFor\(/.test("return withActionLedger(ledgerContextFor(\"a.b.c\", \"email\", p, null), async () => {"))
    const ne = code("lib/kernel/notification-engine.ts")
    check("processKernelEvent opens the causation scope for the event it processes", /withCausationFrom\s*\(\s*params\.lifecycleEventId/.test(ne))
    const em = stripComments(read("lib/kernel/emit.ts"))
    check("emitKernelEvent writes causation_id / correlation_id from the scope", /currentCausation\s*\(\s*\)/.test(em) && /row\.causation_id\s*=/.test(em) && /row\.correlation_id\s*=/.test(em))
    check("emitKernelEvent survives PGRST204 (writes the event without lineage, does not drop it)", /PGRST204/.test(em) && /delete\s+row\.causation_id/.test(em))
  }

  console.log("\n[8 · m687 agrees with the code]")
  {
    const sqlRaw = read("supabase/migrations/m687-action-ledger-and-event-causation.sql")
    const sql = sqlRaw.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
    const listIn = (constraint: string): string[] => {
      const m = new RegExp(`${constraint}\\s*CHECK\\s*\\(\\s*\\w+\\s+IN\\s*\\(([^)]*)\\)`, "s").exec(sql)
      return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort() : []
    }
    const same = (a: readonly string[], b: string[]) => a.length > 0 && [...a].sort().join(",") === b.join(",")
    check("status CHECK == ACTION_STATUSES", same(ACTION_STATUSES, listIn("agent_action_ledger_status_check")))
    check("actor_type CHECK == ACTION_ACTOR_TYPES", same(ACTION_ACTOR_TYPES, listIn("agent_action_ledger_actor_type_check")))
    check("reason_code CHECK == ACTION_REASON_CODES", same(ACTION_REASON_CODES, listIn("agent_action_ledger_reason_code_check")))
    check("POSITIVE CONTROL: the CHECK reader finds nothing for an absent constraint", listIn("no_such_check").length === 0)
    check("UNIQUE idempotency_key", /UNIQUE\s*\(\s*idempotency_key\s*\)/.test(sql))
    check("RLS enabled with a tenant-scoped SELECT and no client write policy",
      /ENABLE ROW LEVEL SECURITY/.test(sql) && /has_brokerage_access\(brokerage_id\)/.test(sql) && !/FOR\s+(INSERT|UPDATE|DELETE|ALL)/.test(sql))
    check("index on (brokerage_id, subject_type, subject_id)", /\(brokerage_id,\s*subject_type,\s*subject_id/.test(sql))
    check("lifecycle_events gains nullable causation_id + correlation_id", /ADD COLUMN IF NOT EXISTS causation_id\s+uuid/.test(sql) && /ADD COLUMN IF NOT EXISTS correlation_id\s+uuid/.test(sql))
    check("the migration carries a status header on line 1", /^-- ── (WRITTEN, NOT APPLIED|APPLIED LIVE)/.test(sqlRaw))
  }

  console.log("\n[blind spots]")
  console.log("  · direct lifecycle_events inserters that bypass emitKernelEvent (e.g. lib/lead-intent/lead-opt-out.ts) write no lineage")
  console.log("  · voice (lib/voice/twilio-outbound.ts placeOutboundAiCall), push, portal messages and provider calls outside lib/providers/dispatch.ts are not ledgered yet")
  console.log("  · callers that pass no ledger.reasonCode record UNSPECIFIED; no caller passes a cycle yet, so de-duplication is opt-in")
  console.log("  · the in-memory table models UNIQUE/23505 and filters; it does not model RLS (m687's policy is asserted textually)")

  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
