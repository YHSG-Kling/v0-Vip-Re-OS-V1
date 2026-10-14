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
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import {
  assembleCausalChain,
  attributedActor,
  canonicalReasonCode,
  recordNonAction,
  replayDispatchResult,
  settleDispatchResult,
  withActionLedger,
  type ActionContext,
  type DispatchLike,
  type LedgerClient,
} from "../lib/kernel/action-ledger"
import { currentCausation, withCausationFrom } from "../lib/kernel/causation"
import { memSupabase } from "./in-memory-supabase"
import { formatPolicyRef, parsePolicyRef } from "../lib/kernel/tenant-policy"

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
    // A later migration may REDEFINE a CHECK (m691 widened reason_code) — compare against the LATEST
    // file that defines the constraint, not the one that first created it (assert the rule, not a waypoint).
    const latestSqlFor = (constraint: string): string => {
      const files = readdirSync(join(root, "supabase/migrations")).filter((f) => /^m\d+.*\.sql$/.test(f))
        .sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10))
      let found = sql
      for (const f of files) {
        const body = read(`supabase/migrations/${f}`).split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
        if (new RegExp(`${constraint}\\s*CHECK`).test(body)) found = body
      }
      return found
    }
    const listIn = (constraint: string): string[] => {
      const m = new RegExp(`${constraint}\\s*CHECK\\s*\\(\\s*\\w+\\s+IN\\s*\\(([^)]*)\\)`, "s").exec(latestSqlFor(constraint))
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

  // ─── wave 98, lane 98B ─────────────────────────────────────────────────────
  console.log("\n[9 · voice / push / portal / social / AI tool — each send is one ledger row; a duplicate cycle sends once]")
  {
    const { ledgerVoiceDial } = await import("../lib/voice/twilio-outbound")
    const { ledgerWebPush } = await import("../lib/providers/web-push")
    const { ledgerSocialPublish } = await import("../lib/social/publisher")
    const { insertPortalMessage } = await import("../lib/portal/portal-message-egress")
    const { ledgerToolExecutions } = await import("../lib/kernel/action-ledger")

    // VOICE
    const v = fakeLedger()
    let dials = 0
    const dial = async () => { dials++; return { ok: true as const, callSid: "CA-1", voiceCallId: "vc-1", fromNumber: "+15550000000" } }
    const vp = { toNumber: "+15615550100", contactId: CONTACT, brokerageId: TENANT, objective: "check in", systemSource: "ai_isa", ledger: { reasonCode: "LIFETIME_TOUCH" as const, cycle: "voice:2026-10-03" } }
    const v1 = await ledgerVoiceDial(vp, dial, { client: v.client })
    const v2 = await ledgerVoiceDial(vp, dial, { client: v.client })
    check("voice: one dial → ONE ledger row comms.voice.call, executed, provider_ref = CallSid", v1.ok && v.rows.length === 1 && v.rows[0]?.action === "comms.voice.call" && v.rows[0]?.status === "executed" && v.rows[0]?.provider_ref === "CA-1")
    check("voice: the same cycle dials ONCE (the retry replays the CallSid)", dials === 1 && v2.ok && (v2 as { callSid?: string }).callSid === "CA-1")
    const vg = fakeLedger()
    await ledgerVoiceDial({ ...vp, ledger: undefined }, async () => ({ ok: false as const, error: "Outbound blocked: no TCPA consent", blocked: true, blockReason: "tcpa" }), { client: vg.client })
    check("voice: a gate refusal settles 'skipped' (nothing dialed; a later cycle may)", vg.rows[0]?.status === "skipped" && vg.rows[0]?.outcome === "tcpa")
    const vc = fakeLedger()
    let ctlDials = 0
    const ctlDial = async () => { ctlDials++; return { ok: true as const, callSid: `CA-${ctlDials}`, voiceCallId: null, fromNumber: "+1" } }
    await ledgerVoiceDial({ ...vp, ledger: undefined }, ctlDial, { client: vc.client })
    await ledgerVoiceDial({ ...vp, ledger: undefined }, ctlDial, { client: vc.client })
    check("POSITIVE CONTROL: voice with NO cycle dials twice and records two rows", ctlDials === 2 && vc.rows.length === 2)

    // PUSH
    const p = fakeLedger()
    let pushes = 0
    const push = async () => { pushes++; return { sent: 1, failed: 0, pruned: 0 } }
    const pp = { userId: CONTACT, title: "Closing tomorrow", body: "x", brokerageId: TENANT, ledger: { cycle: "push_queue:q-1" } }
    await ledgerWebPush(pp, push, { client: p.client })
    const p2 = await ledgerWebPush(pp, push, { client: p.client })
    check("push: one push → ONE row comms.push.send executed", p.rows.length === 1 && p.rows[0]?.action === "comms.push.send" && p.rows[0]?.status === "executed")
    check("push: a re-drained queue row pushes ONCE (replays sent)", pushes === 1 && p2.sent === 1 && !p2.error)
    const pn = fakeLedger()
    await ledgerWebPush({ ...pp, ledger: { cycle: "push_queue:q-2" } }, async () => ({ sent: 0, failed: 0, pruned: 0 }), { client: pn.client })
    check("push: no active subscription settles 'skipped' (honest, not 'executed')", pn.rows[0]?.status === "skipped" && pn.rows[0]?.outcome === "no_active_subscription")

    // PORTAL
    const pl = fakeLedger()
    const inserted: Row[] = []
    const writer = { from: (_t: string) => ({ insert: (row: Row) => ({ select: (_c: string) => ({ maybeSingle: async () => { const r = { id: `pm-${inserted.length + 1}`, ...row }; inserted.push(r); return { data: r, error: null } } }) }) }) }
    const prow = { brokerage_id: TENANT, contact_id: CONTACT, agent_id: "a1", direction: "agent_to_client", channel: "portal", body: "Stage complete", read: false }
    const pm1 = await insertPortalMessage(writer, prow, { actor: { type: "system" }, reasonCode: "TRANSACTION_MILESTONE", cycle: "journey:milestone:Inspection" }, { ledgerClient: pl.client })
    const pm2 = await insertPortalMessage(writer, prow, { actor: { type: "system" }, reasonCode: "TRANSACTION_MILESTONE", cycle: "journey:milestone:Inspection" }, { ledgerClient: pl.client })
    check("portal: one message → ONE row comms.portal.send executed with the message id", !pm1.error && pl.rows.length === 1 && pl.rows[0]?.action === "comms.portal.send" && pl.rows[0]?.provider_ref === "pm-1")
    check("portal: a re-processed journey event posts ONCE", inserted.length === 1 && !pm2.error && pm2.data?.id === "pm-1")

    // SOCIAL
    const so = fakeLedger()
    let posts = 0
    const publish = async () => { posts++; return { success: true, externalPostId: "fb-9", platform: "facebook" } }
    const sl = { brokerageId: TENANT, postId: CONTACT, cycle: `${CONTACT}:facebook:acct` }
    await ledgerSocialPublish("facebook", { content: "x", accessToken: "t", accountId: "acct" }, sl, publish, { client: so.client })
    const s2 = await ledgerSocialPublish("facebook", { content: "x", accessToken: "t", accountId: "acct" }, sl, publish, { client: so.client })
    check("social: one publish → ONE row marketing.social.publish with the external post id", so.rows.length === 1 && so.rows[0]?.action === "marketing.social.publish" && so.rows[0]?.provider_ref === "fb-9")
    check("social: a post whose status flip was lost publishes ONCE on the retry", posts === 1 && s2.success && s2.externalPostId === "fb-9")

    // AI TOOLS
    const at = fakeLedger()
    let commCalls = 0, readCalls = 0
    const registry = {
      send_newsletter: { description: "x", execute: async () => { commCalls++; return { success: true } } },
      get_my_context: { description: "y", execute: async () => { readCalls++; return { ok: true } } },
    }
    const risk = (n: string) => (n === "send_newsletter" ? "COMMUNICATION" : "READ")
    const wrapped = ledgerToolExecutions(registry, { brokerageId: TENANT, subject: { type: "contact", id: CONTACT }, riskClassOf: risk }, { client: at.client })
    await (wrapped.send_newsletter.execute as (a: unknown, o: unknown) => Promise<unknown>)({}, { toolCallId: "call-1" })
    await (wrapped.send_newsletter.execute as (a: unknown, o: unknown) => Promise<unknown>)({}, { toolCallId: "call-1" })
    await (wrapped.get_my_context.execute as (a: unknown, o: unknown) => Promise<unknown>)({}, { toolCallId: "call-2" })
    check("AI tool: a COMMUNICATION tool call → ONE row ai.tool.send_newsletter, risk_class COMMUNICATION", at.rows.length === 1 && at.rows[0]?.action === "ai.tool.send_newsletter" && at.rows[0]?.risk_class === "COMMUNICATION" && at.rows[0]?.status === "executed")
    check("AI tool: the same toolCallId executes ONCE", commCalls === 1)
    check("POSITIVE CONTROL: a READ tool is NOT ledgered and still runs", readCalls === 1 && wrapped.get_my_context === registry.get_my_context)
  }

  console.log("\n[10 · the chokepoints are wired to their REAL callers (stripped source)]")
  {
    const has = (rel: string, re: RegExp) => re.test(code(rel))
    check("placeOutboundAiCall runs through ledgerVoiceDial", has("lib/voice/twilio-outbound.ts", /export async function placeOutboundAiCall[\s\S]{0,400}return ledgerVoiceDial\(/))
    check("sendWebPush runs through ledgerWebPush; the queue drain passes the tenant + the queue row as the cycle", has("lib/providers/web-push.ts", /return ledgerWebPush\(/) && has("app/api/cron/queue-drain/route.ts", /brokerageId:\s*row\.brokerage_id/) && /cycle:\s*`push_queue:\$\{row\.id\}`/.test(stripComments(read("app/api/cron/queue-drain/route.ts"))))
    check("publishToSocialPlatform runs through ledgerSocialPublish; both cron call sites pass a (post, platform, account) cycle", has("lib/social/publisher.ts", /return ledgerSocialPublish\(/) && (stripComments(read("app/api/cron/publish-social-posts/route.ts")).match(/cycle:\s*`\$\{post\.id\}:/g) ?? []).length === 2)
    for (const rel of ["app/actions/portal-messages.ts", "lib/portal/journey-event-handlers.ts", "app/api/internal/ai-chat/route.ts", "lib/kernel/communications.ts"]) {
      check(`portal send routes through insertPortalMessage: ${rel}`, has(rel, /insertPortalMessage\(/))
    }
    check("buildCustomerFreeTools returns its registry through ledgerToolExecutions(riskClassForTool)", has("lib/ai-isa/customer-context-tools.ts", /return ledgerToolExecutions\(out,[\s\S]{0,300}riskClassOf:\s*riskClassForTool/))
    check("POSITIVE CONTROL: the wiring finder sees a specimen and refuses its absence", /insertPortalMessage\(/.test("await insertPortalMessage(svc, row, l)") && !/insertPortalMessage\(/.test("await svc.from(\"client_portal_messages\").insert(row)"))
  }

  console.log("\n[11 · callers say WHY (m687 vocabulary) and pass a deterministic cycle]")
  {
    const callers: Array<[string, RegExp]> = [
      ["lib/ai-isa/lead-action-plan.ts (lead plan release)", /approveClientMessage\([^)]*\{\s*reasonCode:\s*"[A-Z_]+"/],
      ["lib/agents/agent-client-messages.ts (the proposal is the cycle)", /cycle:\s*`agent_client_message:\$\{messageId\}`/],
      ["app/actions/lifetime-customer-touchpoints.ts (LIFETIME_TOUCH + cycle)", /reasonCode:\s*"LIFETIME_TOUCH",\s*cycle/],
      ["lib/workflow/channel-registry.ts (campaign step cycle)", /reasonCode:\s*"CAMPAIGN_STEP"[\s\S]{0,200}cycle:\s*`enrollment:\$\{ctx\.enrollmentId\}:step:\$\{ctx\.step\.id\}`/],
      ["lib/transactions/notification-service.ts (milestone / deadline)", /"TRANSACTION_DEADLINE"[\s\S]{0,80}"TRANSACTION_MILESTONE"[\s\S]{0,400}cycle:/],
      ["lib/offers/outside-agent-record.ts (copy key is the cycle)", /reasonCode:\s*"TRANSACTION_MILESTONE"[\s\S]{0,200}cycle:\s*`outside_agent_copy:\$\{plan\.copyKey\}`/],
      ["lib/kernel/client-welcome.ts (one welcome per contact)", /ledger:\s*\{\s*reasonCode:\s*"CONTACT_WELCOME",\s*cycle:\s*"conversion"/],
    ]
    for (const [label, re] of callers) {
      const rel = label.split(" ")[0]
      check(`passes a reason + cycle: ${label}`, re.test(stripComments(read(rel))))
    }
    for (const rel of ["lib/workflow/adapters/email.ts", "lib/workflow/adapters/sms.ts", "lib/workflow/adapters/direct-mail.ts", "lib/workflow/adapters/newsletter.ts"]) {
      check(`sequence adapter passes sequenceStepLedger(ctx): ${rel}`, /ledger:\s*sequenceStepLedger\(ctx\)/.test(stripComments(read(rel))))
    }
    const codes = new Set(ACTION_REASON_CODES)
    const used = [...new Set(callers.flatMap(([l]) => [...stripComments(read(l.split(" ")[0])).matchAll(/reasonCode:\s*"([A-Z_]+)"/g)].map((m) => m[1])))]
    check("every reasonCode literal those callers write is in the m687 vocabulary (none invented)", used.length > 0 && used.every((c) => codes.has(c)), used.filter((c) => !codes.has(c)).join(","))
    check("POSITIVE CONTROL: an invented code is caught by the same test", !["INVENTED_REASON"].every((c) => codes.has(c)))
  }

  console.log("\n[11b · UNIVERSAL reason codes — one vocabulary, one mapping table, every writer names a WHY (wave 100A)]")
  {
    const ledgerSrc = stripComments(read("lib/kernel/action-ledger.ts"))
    const mapBlock = /const REASON_CODE_MAP = \{([\s\S]*?)\n\} as const/.exec(ledgerSrc)?.[1] ?? ""
    const targets = [...new Set([...mapBlock.matchAll(/:\s*"([A-Z_]+)"/g)].map((m) => m[1]))]
    const codes = new Set(ACTION_REASON_CODES)
    check("REASON_CODE_MAP found and non-trivial (denominator > 0)", targets.length >= 10, `targets=${targets.length}`)
    check("every mapping TARGET is a canonical ACTION_REASON_CODES member (no fourth spelling)", targets.every((c) => codes.has(c)), targets.filter((c) => !codes.has(c)).join(","))
    check("POSITIVE CONTROL: the target reader catches an invented target", !["NOT_A_REAL_CODE"].every((c) => codes.has(c)))

    // The NBA vocabulary: every LeadTouchPlanCode is mapped, and the map agrees with the verdict.
    const planSrc = stripComments(read("lib/ai-isa/lead-action-plan.ts"))
    const planCodes = [...(/export type LeadTouchPlanCode =([\s\S]*?)\n\n/.exec(planSrc)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1])
    const verdictOf = new Map([...(/const ACTION_FOR_CODE[^{]*\{([\s\S]*?)\}\)/.exec(planSrc)?.[1] ?? "").matchAll(/([a-z_]+):\s*"([a-z_]+)"/g)].map((m) => [m[1], m[2]] as const))
    const expected: Record<string, string> = { wait: "WAIT_COOLDOWN", do_nothing: "NO_ACTION_NEEDED", send_touch: "NURTURE_TOUCH", convert: "CONVERSATION_RESPONSE" }
    check("LeadTouchPlanCode and ACTION_FOR_CODE read from source (denominator > 0)", planCodes.length >= 10 && verdictOf.size === planCodes.length, `codes=${planCodes.length} verdicts=${verdictOf.size}`)
    const nbaMiss = planCodes.filter((c) => canonicalReasonCode("nba_plan", c) !== expected[verdictOf.get(c) ?? ""])
    check("every NBA plan code maps to the canonical code its verdict implies (wait → WAIT_COOLDOWN, do_nothing → NO_ACTION_NEEDED, send → NURTURE_TOUCH, convert → CONVERSATION_RESPONSE)", nbaMiss.length === 0, nbaMiss.join(","))
    check("POSITIVE CONTROL: an unmapped plan code is null, not a guess", canonicalReasonCode("nba_plan", "invented_plan_code") === null)

    // The ledger RESOLVES a caller's own spelling (real withActionLedger, in-memory table).
    const resolved = async (over: Partial<ActionContext>): Promise<string> => {
      const { client, rows } = fakeLedger()
      await withActionLedger(ctx({ cycle: null, reasonCode: null, ...over }), async () => ({ success: true, providerKey: "x" }), hooks(0), { client })
      return String(rows[0]?.reason_code)
    }
    check("no reasonCode + systemSource 'sequence' → CAMPAIGN_STEP", await resolved({ systemSource: "sequence" }) === "CAMPAIGN_STEP")
    check("no reasonCode + systemSource 'vendor_booking' → SERVICE_NOTICE (prefix family)", await resolved({ systemSource: "vendor_booking" }) === "SERVICE_NOTICE")
    check("no reasonCode + action ai.tool.* → CONVERSATION_RESPONSE (action family)", await resolved({ action: "ai.tool.send_portal_message" }) === "CONVERSATION_RESPONSE")
    check("an explicit valid reasonCode wins over the systemSource map", await resolved({ systemSource: "sequence", reasonCode: "TRANSACTION_DEADLINE" }) === "TRANSACTION_DEADLINE")
    check("POSITIVE CONTROL: an unmapped systemSource still records UNSPECIFIED (a finding, never a guess)", await resolved({ systemSource: "banana_source" }) === "UNSPECIFIED")

    // Vocabulary lag: a code the LIVE CHECK lacks (a code whose widening migration is not applied yet) is recorded, not dropped.
    {
      const rows: Row[] = []
      const lagClient: LedgerClient = {
        from(table: string) {
          if (table === "brokerages") return fakeLedger().client.from(table)
          let payload: Row = {}
          const b = {
            insert(r: Row) { payload = r; return b },
            update() { return b }, select() { return b }, eq() { return b },
            single() {
              if (payload.reason_code === "NURTURE_TOUCH") return Promise.resolve({ data: null, error: { code: "23514", message: 'new row for relation "agent_action_ledger" violates check constraint "agent_action_ledger_reason_code_check"' } })
              const row = { id: `lag-${rows.length + 1}`, ...payload }; rows.push(row); return Promise.resolve({ data: row, error: null })
            },
            then(res: (v: unknown) => unknown) { return Promise.resolve({ data: [{ id: "lag-1" }], error: null }).then(res) },
          }
          return b
        },
      }
      await withActionLedger(ctx({ cycle: null, reasonCode: "NURTURE_TOUCH" }), async () => ({ success: true, providerKey: "x" }), hooks(0), { client: lagClient })
      check("a 23514 on reason_code (CHECK not widened yet) re-records the row as UNSPECIFIED naming the intended code", rows.length === 1 && rows[0].reason_code === "UNSPECIFIED" && /intended NURTURE_TOUCH/.test(String(rows[0].reason_detail)))
    }

    // CENSUS — every chokepoint call site names a WHY: an explicit reason, a ledger helper, a human
    // approval, or a systemSource the ONE map resolves. Detection reads comment+string-blanked source
    // (a tombstone or a prose mention is not a call site); the argument is read from the
    // comment-blanked source at the same offsets.
    const FNS = ["dispatchEmail", "dispatchSms", "dispatchDirectMail", "placeOutboundAiCall", "insertPortalMessage"]
    const callRe = new RegExp(`\\b(${FNS.join("|")})\\s*\\(`, "g")
    const { blankComments } = await import("./strip-comments")
    const walkTs = (dir: string, out: string[] = []): string[] => {
      for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue
        const rel = `${dir}/${e.name}`
        if (e.isDirectory()) walkTs(rel, out); else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel)
      }
      return out
    }
    const namesWhy = (arg: string): boolean => {
      if (/\breasonCode\b|Ledger\(|\bledger\s*[:,}]|humanApproved\s*:\s*true/.test(arg)) return true
      // The systemSource VALUE (to the end of its line): a literal, a `x ?? "fallback"`, or a ternary
      // of literals. Every literal in it must map; an expression with no literal does not resolve.
      const value = /systemSource\s*:\s*([^\n]*)/.exec(arg)?.[1] ?? ""
      // Only RESULT literals count (at the start, or after `??` / `?` / `:`) — not a comparison operand.
      const lits = [...value.matchAll(/(?:^|\?\?|\?|:)\s*["'`]([a-z0-9_:]+)["'`]/g)].map((x) => x[1])
      return lits.length > 0 && lits.every((lit) => (canonicalReasonCode("system_source", lit) ?? canonicalReasonCode("system_source_prefix", lit)) !== null)
    }
    // A FORWARDER (`dispatchEmail(p)`, `dispatchEmail(params as never)`) passes its caller's object
    // through; the WHY is the caller's, which the stripe / stall / door proofs pin. Counted, published.
    const isForwarder = (arg: string) => /^\s*[A-Za-z_$][\w$]*(\s+as\s+[\w<>[\]]+)?\s*$/.test(arg)
    let forwarders = 0
    const sites: Array<{ at: string; names: boolean }> = []
    for (const rel of [...walkTs("lib"), ...walkTs("app")]) {
      const raw = read(rel)
      if (!callRe.test(raw)) { callRe.lastIndex = 0; continue }
      callRe.lastIndex = 0
      const masked = blankStrings(raw)
      const bare = blankComments(raw)
      let m: RegExpExecArray | null
      while ((m = callRe.exec(masked))) {
        if (/(function|async|export)\s+$/.test(masked.slice(Math.max(0, m.index - 20), m.index))) continue
        let i = m.index + m[0].length, depth = 1
        while (i < masked.length && depth > 0) { const c = masked[i]; if (c === "(") depth++; else if (c === ")") depth--; i++ }
        const arg = bare.slice(m.index + m[0].length, i - 1)
        if (isForwarder(arg)) { forwarders++; continue }
        sites.push({ at: `${rel}:${masked.slice(0, m.index).split("\n").length}`, names: namesWhy(arg) })
      }
    }
    const silent = sites.filter((s) => !s.names)
    console.log(`  · census: ${sites.length} chokepoint call sites (dispatchEmail / dispatchSms / dispatchDirectMail / placeOutboundAiCall / insertPortalMessage) under lib/ + app/, ${forwarders} forwarder(s) excluded; ${silent.length} name no WHY (wave 100A measured 78 of 98 at base 08282ad6c, when only an explicit reasonCode counted and no map existed)`)
    check("the census ran over a non-trivial tree (denominator > 0)", sites.length >= 50, `sites=${sites.length}`)
    check("EVERY chokepoint call site names a canonical WHY (UNSPECIFIED trends to 0)", silent.length === 0, silent.map((s) => s.at).join(" · "))
    check("POSITIVE CONTROL: the census flags a specimen that names no WHY, and passes one that does",
      !namesWhy(`{ brokerageId, to, subject }`) && !namesWhy(`{ systemSource: "banana_source" }`) && !namesWhy(`{ systemSource: spec.systemSource }`)
      && !namesWhy(`{ systemSource: x ? "ai_isa" : "banana_source" }`) && namesWhy(`{ systemSource: r === "ghosted" ? "ghost_recovery" : "ai_isa" }`) && namesWhy(`{ systemSource: "ai_isa" }`) && namesWhy(`{ ledger: { reasonCode: "CAMPAIGN_STEP" } }`)
      && isForwarder("params as never") && !isForwarder("{ to }"))
    console.log("  · blind spots: a `systemSource: args.x ?? \"literal\"` site is judged by its FALLBACK (a caller passing another spelling resolves at run time through the same map, or records UNSPECIFIED); the other ledger writers (web push, social, Stripe lifecycle, AI tool wrapper, recordNonAction) fix their WHY inside the chokepoint and are proven by behaviour in sections 3/9, not by this census")
  }

  console.log("\n[11c · the AI ISA is a SYSTEM actor — never a human seat (wave 100A)]")
  {
    const ISA_TENANT = "33333333-3333-4333-8333-333333333333"
    const ISA_SYS = "44444444-4444-4444-8444-444444444444"
    const HUMAN = "55555555-5555-4555-8555-555555555555"
    const pure = attributedActor({ type: "manager", managerKey: "ai_isa", userId: HUMAN, agentId: "agent-row" }, ISA_SYS)
    check("pure: an ai_isa action names the ISA's system user, not the human beside it", pure.actor.type === "manager" && pure.actor.managerKey === "ai_isa" && pure.actor.userId === ISA_SYS && pure.actor.agentId === null)
    check("pure: the human is kept only as on-behalf-of context", pure.onBehalfOfUserId === HUMAN)
    check("pure: no system identity provisioned → the row names NO user (never the human)", attributedActor({ type: "manager", managerKey: "ai_isa", userId: HUMAN }, null).actor.userId === null)
    const humanIsa = attributedActor({ type: "user", userId: HUMAN }, ISA_SYS)
    check("POSITIVE CONTROL: a HUMAN acting (incl. approving an ISA draft) keeps the human", humanIsa.actor.type === "user" && humanIsa.actor.userId === HUMAN && humanIsa.onBehalfOfUserId === null)
    check("POSITIVE CONTROL: another manager is untouched", attributedActor({ type: "manager", managerKey: "deal_coordinator", userId: HUMAN }, ISA_SYS).actor.userId === HUMAN)

    // End to end: the real ledger resolves the system identity from brokerages.ai_isa_system_user_id.
    const { client, rows } = fakeLedger()
    const withBrokerage: LedgerClient = {
      from(table: string) {
        if (table !== "brokerages") return client.from(table)
        const b = { select() { return b }, eq() { return b }, maybeSingle() { return Promise.resolve({ data: { ai_isa_system_user_id: ISA_SYS }, error: null }) } }
        return b
      },
    }
    await withActionLedger(ctx({ brokerageId: ISA_TENANT, cycle: null, reasonCode: null, systemSource: "ai_isa", actor: { type: "manager", managerKey: "ai_isa", userId: HUMAN } }),
      async () => ({ success: true, providerKey: "sendgrid" }), hooks(0), { client: withBrokerage })
    const r = rows[0] ?? {}
    check("ledger row: actor_type manager, actor_manager_key ai_isa, actor_user_id = the ISA system user", r.actor_type === "manager" && r.actor_manager_key === "ai_isa" && r.actor_user_id === ISA_SYS && r.actor_agent_id === null)
    check("ledger row: the human rides detail.on_behalf_of_user_id, and the WHY resolves to NURTURE_TOUCH", (r.detail as Row | undefined)?.on_behalf_of_user_id === HUMAN && r.reason_code === "NURTURE_TOUCH")
    await withActionLedger(ctx({ brokerageId: ISA_TENANT, cycle: null, reasonCode: "HUMAN_REQUESTED", actor: { type: "user", userId: HUMAN } }),
      async () => ({ success: true, providerKey: "sendgrid" }), hooks(0), { client: withBrokerage })
    check("POSITIVE CONTROL ledger row: a human ISA-desk action keeps the human actor", rows[1]?.actor_type === "user" && rows[1]?.actor_user_id === HUMAN)
    // The NBA's own decisions are the ISA's too.
    const planSrc = stripComments(read("lib/ai-isa/lead-action-plan.ts"))
    check("the NBA's wait / do_nothing decisions are recorded as manager ai_isa", /actor:\s*\{\s*type:\s*"manager",\s*managerKey:\s*"ai_isa"\s*\}/.test(planSrc))
    // ONE resolver: the ledger reads the system identity through lib/auth/isa-actor.ts, never its own query.
    const ledgerSrc = stripComments(read("lib/kernel/action-ledger.ts"))
    check("the ledger resolves the ISA identity through getIsaSystemUserIdCached (no second resolver)", /getIsaSystemUserIdCached\(/.test(ledgerSrc) && !/\.from\(\s*"brokerages"\s*\)/.test(ledgerSrc))
  }

  console.log("\n[12 · 'unknown' rows are settled against outcome_reconciliations]")
  {
    const { settleUnknownAction, UNKNOWN_ABANDON_HOURS } = await import("../lib/outcomes/reconciliation")
    const t0 = "2026-10-01T10:00:00.000Z"
    const now = new Date("2026-10-01T12:00:00.000Z")
    const row = { id: "u1", channel: "sms", subject_type: "contact", subject_id: CONTACT, provider_ref: null, created_at: t0 }
    const claim = (o: Partial<{ provider_ref: string | null; contact_id: string | null; claimed_at: string; verdict: "confirmed" | "contradicted" | "pending" | "unverifiable"; channel: string }>) =>
      ({ id: "c", channel: "sms", provider_ref: "SM1", contact_id: CONTACT, lead_id: null, claimed_at: "2026-10-01T10:02:00.000Z", verdict: "confirmed" as const, ...o })
    const byWindow = settleUnknownAction(row, [claim({})], now)
    check("unknown + a confirmed claim for the same person/channel inside the window → executed with the provider ref", byWindow?.status === "executed" && byWindow.providerRef === "SM1")
    const byRef = settleUnknownAction({ ...row, provider_ref: "SM7", subject_id: null }, [claim({ provider_ref: "SM7", contact_id: null })], now)
    check("unknown + a claim with the SAME provider_ref → settled from that claim", byRef?.status === "executed" && byRef.providerRef === "SM7")
    const contra = settleUnknownAction(row, [claim({ verdict: "contradicted" })], now)
    check("a contradicted claim settles 'failed' (the provider said it did not land)", contra?.status === "failed" && contra.outcome === "reconciled_contradicted")
    check("too young and no claim → stays unknown (null)", settleUnknownAction(row, [], now) === null)
    const late = settleUnknownAction(row, [], new Date(Date.parse(t0) + (UNKNOWN_ABANDON_HOURS + 1) * 3_600_000))
    check("no claim after the abandon window → failed / reconcile_no_evidence, said plainly", late?.status === "failed" && late.outcome === "reconcile_no_evidence" && /no provider record/.test(late.error ?? ""))
    check("POSITIVE CONTROL: a claim for ANOTHER person, or outside the window, does not settle it",
      settleUnknownAction(row, [claim({ contact_id: "someone-else" })], now) === null && settleUnknownAction(row, [claim({ claimed_at: "2026-10-01T11:30:00.000Z" })], now) === null)
    const rn = code("lib/intelligence/reaper-net.ts")
    check("mounted on the EXISTING reaper net (signals lane → manager-signals cron), not a new cron", /domain:\s*"unknown_action_outcomes"[\s\S]{0,200}lane:\s*"signals"[\s\S]{0,400}settleUnknownActions\(/.test(stripComments(read("lib/intelligence/reaper-net.ts"))) && rn.length > 0)
    const led = stripComments(read("lib/outcomes/reconciliation-ledger.ts"))
    check("the live settle UPDATE is guarded on status='unknown' + tenant and COUNTED", /\.eq\("status", "unknown"\)\s*\.select\("id"\)/.test(led) && /upd\.length !== 1/.test(led))
  }

  console.log("\n[13 · lineage: moved lifecycle_events inserters emit through emitKernelEvent]")
  {
    const moved = [
      // wave 98 (lane 98B)
      "lib/lead-intent/lead-opt-out.ts", "lib/lead-intent/inbound-lead-intent.ts", "lib/finance/auto-dispute.ts",
      "lib/transactions/walkthrough-outcome.ts", "lib/direct-mail/mail-unsubscribe.ts", "lib/video/viral-script-share.ts",
      "lib/cma/ai-cma-engine.ts", "lib/pricing/predictive-pricing.ts",
      // wave 100 (lane 100B): 112 sites in 53 modules, plus lib/kernel/reputation.ts (its row + fan-out pair is now one emit)
      "app/actions/business-card/business-card-actions.ts",
      "app/actions/buyer-offers.ts",
      "app/actions/communications.ts",
      "app/actions/contact-reassignment.ts",
      "app/actions/coverage-mode.ts",
      "app/actions/ctv-ads.ts",
      "app/actions/deal-shaky.ts",
      "app/actions/dispatch-showing.ts",
      "app/actions/lead-magnets-actions.ts",
      "app/actions/listing-lifecycle.ts",
      "app/actions/multi-persona.ts",
      "app/actions/portal-offer-decision.ts",
      "app/actions/seller-listing/execution-engine.ts",
      "app/actions/seller-open-house.ts",
      "app/actions/seller-showings.ts",
      "app/actions/social-media-automation.ts",
      "app/actions/social-share.ts",
      "app/actions/transaction-stage-machine.ts",
      "app/actions/vendor-requests.ts",
      "app/actions/video-generation.ts",
      "app/actions/video-repurposing.ts",
      "app/actions/video-voice.ts",
      "app/actions/video/generate-script.ts",
      "app/api/cron/lead-scraping/route.ts",
      "app/api/cron/publish-social-posts/route.ts",
      "app/api/errors/escalate/route.ts",
      "app/api/offers/upload/route.ts",
      "app/api/open-house/attend/route.ts",
      "app/api/providers/inbound/route.ts",
      "app/api/showings/showingtime-webhook/route.ts",
      "app/api/video/engagement/route.ts",
      "app/dashboard/admin/command-center/page.tsx",
      "app/dashboard/settings/widget/actions.ts",
      "lib/ads/ad-creator.ts",
      "lib/ads/ad-manager.ts",
      "lib/ads/chatgpt-campaign.ts",
      "lib/ads/ctv-campaign.ts",
      "lib/ai-isa/convert-buyer-lead-on-intent.ts",
      "lib/ai-isa/inbound-intent-classifier.ts",
      "lib/errors/collect-error.ts",
      "lib/kernel/ai-isa.ts",
      "lib/kernel/ai-tools.ts",
      "lib/kernel/content-creators.ts",
      "lib/kernel/crm.ts",
      "lib/kernel/education.ts",
      "lib/kernel/financial.ts",
      "lib/kernel/lead-magnets.ts",
      "lib/kernel/listings.ts",
      "lib/kernel/offers.ts",
      "lib/kernel/reputation.ts",
      "lib/kernel/transactions.ts",
      "lib/kernel/users.ts",
      "lib/offers/offer-analyzer.ts",
      "lib/offers/offer-extractor.ts",
    ]
    const directInsert = /\.from\(\s*"lifecycle_events"\s*\)\s*\.(insert|upsert)\(/
    for (const rel of moved) {
      const src = stripComments(read(rel))
      check(`${rel}: emits through emitKernelEvent and inserts lifecycle_events directly nowhere`, /emitKernelEvent\(/.test(src) && !directInsert.test(src))
    }
    check("POSITIVE CONTROL: the direct-insert finder sees a specimen", directInsert.test('await svc.from("lifecycle_events").insert({ a: 1 })'))
    const { readdirSync, statSync } = await import("node:fs")
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of readdirSync(join(root, dir))) {
        const rel = `${dir}/${e}`
        if (e === "node_modules" || e.startsWith(".")) continue
        const st = statSync(join(root, rel))
        if (st.isDirectory()) walk(rel, out)
        else if (/\.(ts|tsx)$/.test(e)) out.push(rel)
      }
      return out
    }
    const remaining = [...walk("lib"), ...walk("app")].filter((rel) => rel !== "lib/kernel/emit.ts" && directInsert.test(stripComments(read(rel))))
    // THE RATCHET (wave 100): every module that still inserts lifecycle_events directly is NAMED here
    // with the reason it is not a drop-in. A new direct inserter fails; a moved one prints as stale.
    // The count is DERIVED (remaining.length), never pinned.
    const NOT_MOVED: Record<string, string> = {
      "app/actions/ai-review-automation.ts": "writes lifecycle_events.payload; emitKernelEvent carries metadata only",
      "app/actions/orchestrator.ts": "the orchestrator's own recorder: writes payload/user_id/processed=false and returns the whole row",
      "lib/events/lifecycle-event-core.ts": "recordLifecycleEvent core: writes processed=false + payload for the orchestrator worker and returns the whole row",
      "lib/kernel/document-autofile.ts": "writes lifecycle_events.payload, which the autofile reviewer reads",
      "lib/kernel/lifecycle.ts": "transitionLifecycle IS the state-machine writer: inserts lifecycle.<event> and fans out itself with its own row id",
      // Wave 101C: agent-books, agent-deactivation, managing-broker and unknown-sender-identification
      // MOVED — emitKernelEvent gained its `client` seam (and a nullable entity for a run-level audit).
    }
    const unexplained = remaining.filter((rel) => !(rel in NOT_MOVED))
    const stale = Object.keys(NOT_MOVED).filter((rel) => !remaining.includes(rel))
    console.log(`  · census: ${remaining.length} module(s) under lib/ + app/ still insert lifecycle_events directly (wave 98 end: 63; denominator: every .ts/.tsx under lib/ + app/)`)
    check("RATCHET: every remaining direct inserter is named with its reason (no new direct inserter)", unexplained.length === 0, unexplained.join(", "))
    if (stale.length) console.log(`  · stale NOT_MOVED entries (moved since; delete them): ${stale.join(", ")}`)
    check("POSITIVE CONTROL: the ratchet accuses an unnamed inserter", ["lib/x/new-inserter.ts"].filter((rel) => !(rel in NOT_MOVED)).length === 1)
    check("the census ran over a non-trivial tree and excludes the emitter itself", remaining.length > 0 && !remaining.includes("lib/kernel/emit.ts"))
  }

  console.log("\n[13c · wave 101C — the client seam (4 injected-client audits) + ONE EMIT per event (pairs merged)]")
  {
    // (c) the four injected-client audits now ride emitKernelEvent's client seam.
    const SEAMED = ["lib/agents/agent-books.ts", "lib/agents/agent-deactivation.ts", "lib/kernel/managing-broker.ts", "lib/lead-pipeline/unknown-sender-identification.ts"]
    const directInsert = /\.from\(\s*"lifecycle_events"\s*\)\s*\.(insert|upsert)\(/
    const seamCall = /emitKernelEvent\(\{[^]*?\bclient:\s*svc\b/
    for (const rel of SEAMED) {
      const src = stripComments(read(rel))
      check(`${rel}: audits through emitKernelEvent's client seam (client: svc) and inserts lifecycle_events directly nowhere`, seamCall.test(src) && !directInsert.test(src))
    }
    check("POSITIVE CONTROL: the seam finder rejects an emit without the client and accepts one with it",
      !seamCall.test(`emitKernelEvent({ event: "x", brokerageId })`) && seamCall.test(`emitKernelEvent({\n client: svc, auditOnly: true })`))
    const em = stripComments(read("lib/kernel/emit.ts"))
    check("emit.ts: the seam is `input.client ?? createServiceClient()` inside the try (never throws)", /try\s*\{[^}]*input\.client[^}]*\?\?\s*createServiceClient\(\)/.test(em))
    check("emit.ts: a null-entity event never fans out (shouldFanOut requires an entity)", /!!input\.entityId/.test(em))

    // (b) PAIRS → ONE EMIT. An auditOnly row of a typed event followed by a separate processKernelEvent of
    // the SAME event is the pair shape. Every remaining pair is NAMED with why it is not equivalent; a
    // merged pair that comes back (or a new one) fails. Derived, never pinned.
    // Wave 102C (owner ruling, wave 102 answer 2): the 14 "superset payload" pairs are MERGED — the
    // reactor receives the row's metadata (it forwards it by reference or reads NAMED keys; extra keys
    // harmless), ISA_REPLY_RECEIVED's one emit moved to the fan-out's position so its order is kept,
    // and the business-card vendor pair's two `category` values were in fact one value. The two that
    // remain are GENUINELY DIFFERENT EVENTS (the ruling's keep list).
    const PAIR_NOT_MERGED: Record<string, string> = {
      "lib/kernel/financial.ts#COMMISSION_PAID": "not a pair: the auditOnly row is the pay-status command's (entity agent_commission); the fan-out is createCommissionRecord's, ~440 lines later (entity commission) — two moments, two functions",
      "lib/ai-isa/convert-buyer-lead-on-intent.ts#?":"not one event: the row is the free-form lifecycle.<event> on entity buyer_lifecycle; the fan-out is the typed event on entity contact",
    }
    // Every emitKernelEvent({...}) call as its own balanced block (a lazy regex would span calls).
    const emitBlocks = (src: string): Array<{ blk: string; end: number }> => {
      const out: Array<{ blk: string; end: number }> = []
      const emitRe = /emitKernelEvent\(\{/g
      let m: RegExpExecArray | null
      while ((m = emitRe.exec(src))) {
        let d = 0, e = m.index + "emitKernelEvent".length
        for (; e < src.length; e++) { if (src[e] === "(") d++; else if (src[e] === ")") { d--; if (!d) break } }
        out.push({ blk: src.slice(m.index, e + 1), end: e + 1 })
      }
      return out
    }
    const pairsIn = (src: string): string[] => {
      const out: string[] = []
      for (const { blk, end: e } of emitBlocks(src)) {
        if (!/auditOnly:\s*true/.test(blk)) continue
        const ev = (blk.match(/event:\s*KernelEvent\.([A-Z_]+)/) ?? [])[1] ?? "?"
        // The fan-out of the same event anywhere AFTER the row in the module (an ordered pair can sit
        // a whole pipeline apart — the inbound router's step 6 row and step 8 fan-out).
        const next = src.slice(e)
        for (const pk of next.matchAll(/processKernelEvent\(\{\s*event:\s*([^,\n]+)/g)) {
          const pkEv = (pk[1].match(/KernelEvent\.([A-Z_]+)/) ?? [])[1] ?? "?"
          if ((ev !== "?" && pkEv === ev) || (ev === "?" && /plan\.kernelEvent/.test(pk[1]))) { out.push(ev); break }
        }
      }
      return out
    }
    const { readdirSync: rd, statSync: st } = await import("node:fs")
    const walkAll = (dir: string, out: string[] = []): string[] => {
      for (const e of rd(join(root, dir))) {
        const rel = `${dir}/${e}`
        if (e === "node_modules" || e.startsWith(".")) continue
        if (st(join(root, rel)).isDirectory()) walkAll(rel, out)
        else if (/\.(ts|tsx)$/.test(e)) out.push(rel)
      }
      return out
    }
    const found: string[] = []
    for (const rel of [...walkAll("lib"), ...walkAll("app")]) {
      if (rel === "lib/kernel/emit.ts") continue
      const raw = read(rel)
      if (!raw.includes("auditOnly") || !raw.includes("processKernelEvent")) continue
      for (const ev of pairsIn(stripComments(raw))) found.push(`${rel}#${ev}`)
    }
    const unexplained = [...new Set(found)].filter((k) => !(k in PAIR_NOT_MERGED))
    const staleNames = Object.keys(PAIR_NOT_MERGED).filter((k) => !found.includes(k))
    console.log(`  · census: ${found.length} auditOnly-row + processKernelEvent pair(s) remain (wave 100 end: ~40 incl. the different-event rows; wave 101C merged 21 into one emit). Denominator: every .ts/.tsx under lib/ + app/`)
    check("RATCHET: every remaining audit-row + separate-fan-out pair is NAMED with why one emit is not equivalent", unexplained.length === 0, unexplained.join(", "))
    if (staleNames.length) console.log(`  · stale PAIR_NOT_MERGED entries (merged since; delete them): ${staleNames.join(", ")}`)
    check("POSITIVE CONTROL: the pair finder sees the pre-101C shape", pairsIn(`await emitKernelEvent({ event: KernelEvent.OFFER_AI_EXTRACTED, brokerageId, entityType: "offer", entityId: id, auditOnly: true })\nawait processKernelEvent({ event: KernelEvent.OFFER_AI_EXTRACTED, brokerageId, entityType: "offer", entityId: id })`).length === 1)
    check("CONTROL: the merged shape (one emit, no auditOnly) is not a pair", pairsIn(`await emitKernelEvent({ event: KernelEvent.OFFER_AI_EXTRACTED, brokerageId, entityType: "offer", entityId: id, agentUserId: null })`).length === 0)
    for (const [rel, ev] of [["lib/offers/offer-extractor.ts", "OFFER_AI_EXTRACTED"], ["app/actions/seller-open-house.ts", "CONTACT_CREATED"], ["app/actions/video-voice.ts", "VOICE_CLONE_PROFILE_CREATED"], ["app/actions/business-card/business-card-actions.ts", "BUSINESS_CARD_APPROVED"]] as const) {
      const blocks = emitBlocks(stripComments(read(rel))).filter((b) => new RegExp(`event:\\s*KernelEvent\\.${ev}\\b`).test(b.blk))
      check(`${rel}: ${ev} has an emit that fans out (no auditOnly) and carries the fan-out's own fields`,
        blocks.some((b) => !/auditOnly:\s*true/.test(b.blk)) && (ev !== "BUSINESS_CARD_APPROVED" || blocks.some((b) => /routed_to: "recruit"[^]*?classified_by/.test(b.blk))))
    }
    // Wave 102C — the 14 merged pairs: ONE emit each, fanning out (no auditOnly), carrying the row's
    // metadata as the SUPERSET payload the reactor reads by named key, and no processKernelEvent of that
    // event left behind in the module. The superset is asserted on a named key per site.
    const MERGED_102C: Array<[string, string, RegExp]> = [
      ["app/actions/business-card/business-card-actions.ts", "BUSINESS_CARD_APPROVED", /routed_to: "vendor"[^]*?subject_user_type/],
      ["app/actions/video-voice.ts", "VOICE_CLONE_READY", /quality_score/],
      ["app/actions/video/generate-script.ts", "SCRIPT_GENERATED", /approval_status/],
      ["app/actions/video-generation.ts", "SCRIPT_GENERATED", /approval_status/],
      ["app/actions/video-generation.ts", "VIDEO_HIGH_PERFORMER_DETECTED", /completion_rate/],
      ["app/actions/video-generation.ts", "VIDEO_LOW_PERFORMER_DETECTED", /completion_rate/],
      ["app/api/video/engagement/route.ts", "VIDEO_HIGH_PERFORMER_DETECTED", /completion_rate/],
      ["app/api/video/engagement/route.ts", "VIDEO_LOW_PERFORMER_DETECTED", /completion_rate/],
      ["app/api/cron/publish-social-posts/route.ts", "SOCIAL_POST_FAILED", /retry_count/],
      ["app/actions/video-repurposing.ts", "SNIPPET_CREATED", /platform_target/],
      ["lib/kernel/content-creators.ts", "VIDEO_GENERATION_REQUESTED", /video_type/],
      ["app/actions/seller-listing/execution-engine.ts", "LISTING_AGREEMENT_INITIATED", /stage: "LISTING_AGREEMENT_INITIATED"/],
      ["app/api/offers/upload/route.ts", "OFFER_UPLOADED", /offer_document_url/],
      ["app/api/providers/inbound/route.ts", "ISA_REPLY_RECEIVED", /messageId/],
    ]
    for (const [rel, ev, key] of MERGED_102C) {
      const s = stripComments(read(rel))
      const blocks = emitBlocks(s).filter((b) => new RegExp(`event:\\s*KernelEvent\\.${ev}\\b`).test(b.blk))
      const fanning = blocks.filter((b) => !/auditOnly:\s*true/.test(b.blk))
      const leftover = new RegExp(`processKernelEvent\\(\\{\\s*event:\\s*KernelEvent\\.${ev}\\b`).test(s)
      // `some`: a module may fan the same event out from several branches (business-card's recruit /
      // card / contact emits, merged in 101C) — the merged pair is the branch that carries this key.
      check(`${rel}: ${ev} is ONE emit — fans out, carries the row's metadata (${key.source}), no separate processKernelEvent of it`,
        fanning.some((b) => key.test(b.blk) && /agentUserId:\s*null/.test(b.blk)) && !leftover)
    }
    // ORDER kept for the inbound router: the one ISA_REPLY_RECEIVED emit sits AFTER the opt-out review (step 7).
    const inbound = stripComments(read("app/api/providers/inbound/route.ts"))
    check("inbound router: the ISA_REPLY_RECEIVED emit runs after the opt-out review (review_opt_out) — the pair's order survives the merge",
      inbound.indexOf("review_opt_out") > 0 && inbound.indexOf("review_opt_out") < inbound.indexOf("event: KernelEvent.ISA_REPLY_RECEIVED"))
    check("POSITIVE CONTROL: the leftover finder sees a surviving processKernelEvent of the same event",
      /processKernelEvent\(\{\s*event:\s*KernelEvent\.OFFER_UPLOADED\b/.test(`await processKernelEvent({ event: KernelEvent.OFFER_UPLOADED, brokerageId })`))
    console.log(`  · wave 102C: ${MERGED_102C.length} pairs merged (16 → ${Object.keys(PAIR_NOT_MERGED).length} named as different events)`)
  }

  console.log("\n[13b · audit-only option + executed lineage through a fake PostgREST]")
  {
    const { KernelEvent } = await import("../lib/kernel/events")

    // A local HTTP server stands in for PostgREST: emitKernelEvent runs for REAL (createServiceClient,
    // supabase-js, fetch). Every request is recorded, so "did not fan out" is OBSERVED, not inferred.
    const http = await import("node:http")
    const seen: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = []
    const srv = http.createServer((req, res) => {
      let raw = ""
      req.on("data", (c) => { raw += c })
      req.on("end", () => {
        let body: Record<string, unknown> | null = null
        try { body = raw ? JSON.parse(raw) : null } catch { body = null }
        seen.push({ method: req.method ?? "", path: req.url ?? "", body })
        res.setHeader("content-type", "application/json")
        if (req.method === "POST" && (req.url ?? "").startsWith("/rest/v1/lifecycle_events")) { res.end(JSON.stringify({ id: `le-${seen.length}` })); return }
        res.end("[]")
      })
    })
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()))
    const addr = srv.address() as { port: number }
    const prevUrl = process.env.NEXT_PUBLIC_SUPABASE_URL, prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${addr.port}`
    process.env.SUPABASE_SERVICE_ROLE_KEY = "proof-only-key"
    try {
      const { emitKernelEvent } = await import("../lib/kernel/emit")
      const leRows = () => seen.filter((x) => x.method === "POST" && x.path.startsWith("/rest/v1/lifecycle_events"))

      seen.length = 0
      const audit = await withCausationFrom("evt-parent", () => emitKernelEvent({
        event: KernelEvent.CONTACT_UPDATED, brokerageId: "b-1", entityType: "contact", entityId: "c-1", auditOnly: true,
      }))
      const row = leRows()[0]?.body ?? {}
      check("AUDIT-ONLY: the row is written WITH lineage (causation_id + correlation_id from the scope)",
        audit.inserted && audit.lifecycleEventId !== null && row.causation_id === "evt-parent" && row.correlation_id === "evt-parent", JSON.stringify(row))
      check("AUDIT-ONLY: nothing but the one insert reached the database (no fan-out reads)", seen.length === 1, `${seen.length} request(s)`)

      seen.length = 0
      await withCausationFrom("evt-parent", () => emitKernelEvent({
        event: KernelEvent.CONTACT_UPDATED, brokerageId: "b-1", entityType: "contact", entityId: "c-1",
      }))
      check("POSITIVE CONTROL: the same typed event WITHOUT auditOnly fans out (the reactor reads past the insert)", leRows().length === 1 && seen.length > 1, `${seen.length} request(s)`)

      seen.length = 0
      await emitKernelEvent({ event: "x_free_form_audit", brokerageId: "b-1", entityType: "contact", entityId: "c-1" })
      const freeForm = seen.length
      seen.length = 0
      await emitKernelEvent({ event: KernelEvent.CONTACT_UPDATED, brokerageId: null, entityType: "contact", entityId: "c-1" })
      check("a free-form string never fans out, and neither does a tenant-less typed event (one insert each)", freeForm === 1 && seen.length === 1, `${freeForm} / ${seen.length}`)

      // A MIGRATED inserter, executed: collectError (lib/errors/collect-error.ts) writes its own rows
      // through an injected client and its critical alert through emitKernelEvent.
      seen.length = 0
      const builder = (data: unknown) => {
        const p = Promise.resolve({ data, error: null }) as Promise<{ data: unknown; error: null }> & Record<string, unknown>
        p.select = () => p; p.single = () => p; p.maybeSingle = () => p; p.eq = () => p
        return p
      }
      const fakeClient = { from: (_t: string) => ({ insert: (_r: unknown) => builder({ id: "err-1" }) }) }
      const { collectError } = await import("../lib/errors/collect-error")
      const args = { workflowName: "proof", errorMessage: "boom", severity: "critical", brokerageId: "b-1", client: fakeClient } as unknown as Parameters<typeof collectError>[0]
      const errId = await withCausationFrom("evt-cause", () => collectError(args))
      const alert = leRows()[0]?.body ?? {}
      check("A MIGRATED INSERTER CARRIES CAUSATION: collectError's critical alert row has causation_id = the scope's event",
        errId === "err-1" && alert.event_type === "SYSTEM_HEALTH_ALERT" && alert.causation_id === "evt-cause" && alert.entity_id === "err-1", JSON.stringify(alert))
      seen.length = 0
      await collectError(args)
      check("POSITIVE CONTROL: outside a scope the same inserter writes NO causation (a root event)", leRows().length === 1 && !("causation_id" in (leRows()[0]?.body ?? {})))

      // Wave 101C — THE CLIENT SEAM, executed: the row lands on the INJECTED client; the service URL sees nothing.
      seen.length = 0
      const injected: Array<{ table: string; row: Record<string, unknown> }> = []
      const seamClient = { from: (t: string) => ({ insert: (r: Record<string, unknown>) => { injected.push({ table: t, row: r }); return builder({ id: "le-seam" }) } }) }
      const seamRes = await withCausationFrom("evt-seam", () => emitKernelEvent({
        client: seamClient, auditOnly: true, event: "agent_books_reassigned", brokerageId: "b-1", entityType: "agent", entityId: "a-1",
      }))
      check("CLIENT SEAM: the row is written on the INJECTED client, with lineage, and nothing reaches the service client",
        seamRes.inserted && seamRes.lifecycleEventId === "le-seam" && injected.length === 1 && injected[0].table === "lifecycle_events" && injected[0].row.causation_id === "evt-seam" && seen.length === 0,
        `${injected.length} injected / ${seen.length} service request(s)`)
      seen.length = 0
      await emitKernelEvent({ auditOnly: true, event: "agent_books_reassigned", brokerageId: "b-1", entityType: "agent", entityId: "a-1" })
      check("POSITIVE CONTROL: without the seam the same emit lands on the service client", leRows().length === 1 && injected.length === 1)
      seen.length = 0
      await emitKernelEvent({ event: KernelEvent.UNKNOWN_SENDER_DROPPED, brokerageId: "b-1", entityType: "system", entityId: null })
      check("a NULL-entity typed event (a run-level audit) is written once and never fans out", leRows().length === 1 && seen.length === 1, `${seen.length} request(s)`)
    } finally {
      if (prevUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = prevUrl
      if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey
      srv.close()
    }
  }

  // ── WAVE 102 (102D): WHICH POLICY PERMITTED — agent_action_ledger.policy_ref (m700) ────────────
  console.log("\n[102D · which policy permitted: policy_ref = policy_key@version from the ONE version reader]")
  {
    const seed = () => ({ agent_action_ledger: [], tenant_policy_versions: [{ brokerage_id: TENANT, policy_key: "experiments", version: 1 }, { brokerage_id: TENANT, policy_key: "experiments", version: 2 }, { brokerage_id: "other-tenant", policy_key: "experiments", version: 9 }] })
    const mem = memSupabase(seed())
    const row = () => (mem.tables.agent_action_ledger as any[]).at(-1)
    await withActionLedger(ctx({ cycle: null, policyKey: "experiments" }), async () => ({ success: true, providerKey: "x" }), hooks(null), { client: mem })
    check("a ledgered action under `experiments` records policy_ref experiments@2 (THIS tenant's live version)", row()?.policy_ref === "experiments@2", String(row()?.policy_ref))
    await withActionLedger(ctx({ cycle: null, policyKey: "autonomy_tier:deal_coordinator" }), async () => ({ success: true, providerKey: "x" }), hooks(null), { client: mem })
    check("a key never changed through the versioned writer records @0", row()?.policy_ref === "autonomy_tier:deal_coordinator@0")
    await withActionLedger(ctx({ cycle: null, policyKey: "experiments", policyVersion: 7 }), async () => ({ success: true, providerKey: "x" }), hooks(null), { client: mem })
    check("a caller that already holds the version passes it (no second read)", row()?.policy_ref === "experiments@7")
    await withActionLedger(ctx({ cycle: null }), async () => ({ success: true, providerKey: "x" }), hooks(null), { client: mem })
    check("CONTROL: an action naming no policy records NULL (never an invented ref)", row()?.policy_ref === null)
    await withActionLedger(ctx({ cycle: null, policyKey: "not_a_policy" }), async () => ({ success: true, providerKey: "x" }), hooks(null), { client: mem })
    check("CONTROL: an unregistered key records @unknown (the grammar is m696's)", row()?.policy_ref === "not_a_policy@unknown")
    const refused = memSupabase(seed(), { refuse: { tenant_policy_versions: "permission denied" } })
    let sent = 0
    await withActionLedger(ctx({ cycle: null, policyKey: "experiments" }), async () => { sent++; return { success: true, providerKey: "x" } }, hooks(null), { client: refused })
    const rr = (refused.tables.agent_action_ledger as any[])[0]
    check("a REFUSED version read records @unknown — the action still runs and is still ledgered", sent === 1 && rr?.policy_ref === "experiments@unknown" && rr?.status === "executed")
    const pre700 = memSupabase(seed(), { missingColumns: { agent_action_ledger: ["policy_ref"] } })
    let sent2 = 0
    await withActionLedger(ctx({ cycle: null, policyKey: "experiments" }), async () => { sent2++; return { success: true, providerKey: "x" } }, hooks(null), { client: pre700 })
    const pr = (pre700.tables.agent_action_ledger as any[])[0]
    check("before m700 (column absent): the row is re-written WITHOUT the column and the ref rides detail.policy_ref — never 'unledgered'",
      sent2 === 1 && !!pr && !("policy_ref" in pr) && pr.detail?.policy_ref === "experiments@2" && pr.status === "executed")
    check("formatPolicyRef / parsePolicyRef round-trip; a negative or missing version is `unknown`",
      formatPolicyRef("experiments", 3) === "experiments@3" && formatPolicyRef("experiments", null) === "experiments@unknown" && formatPolicyRef("experiments", -1) === "experiments@unknown"
        && parsePolicyRef("assignment_rule:00000000-0000-4000-8000-000000000001@4")?.version === 4 && parsePolicyRef("Experiments@2") === null)
    const chain = assembleCausalChain([], [{ id: "a1", action: "comms.email.send", status: "executed", reason_code: "CAMPAIGN_STEP", subject_type: "contact", actor_type: "system", created_at: "2026-10-01T00:00:00Z", policy_ref: "experiments@2" }, { id: "a2", action: "comms.sms.send", status: "executed", reason_code: "CAMPAIGN_STEP", subject_type: "contact", actor_type: "system", created_at: "2026-10-01T00:00:01Z", detail: { policy_ref: "experiments@1" } }])
    check("the flight recorder chain carries policyRef (column, else the pre-m700 detail fallback)", chain[0]?.policyRef === "experiments@2" && chain[1]?.policyRef === "experiments@1")
    // m700 text: the column, its format CHECK (derived and exercised), the index.
    const m700 = read("supabase/migrations/m700-policy-ref-on-ledger-and-arm-outcome-evaluations.sql").replace(/--[^\n]*/g, "")
    const fmt = /policy_ref ~ '([^']+)'/.exec(m700)?.[1]
    const re = fmt ? new RegExp(fmt) : null
    check("m700 adds agent_action_ledger.policy_ref with a format CHECK", /ADD COLUMN IF NOT EXISTS policy_ref text/.test(m700) && !!re)
    check("the CHECK admits every ref the writer emits and refuses a mutated one",
      !!re && ["experiments@2", "autonomy_tier:deal_coordinator@0", "assignment_rule:00000000-0000-4000-8000-000000000001@unknown", "newsletter_cadence_policy:brokerage:00000000-0000-4000-8000-00000000000a@3"].every((s) => re.test(s))
        && ["Experiments@2", "experiments@-1", "experiments", "experiments@2.0"].every((s) => !re.test(s)))
    // Wiring (stripped source): the three policy-resolving writers name their key; the recorder reads it; the page shows it.
    const disp = stripComments(read("lib/providers/dispatch.ts"))
    check("WIRED: dispatch names the autonomy posture it consulted (autonomy_tier:<manager>) unless a human approved", /policyKey: params\.ledger\?\.policyKey \?\? \(managerKey && !params\.humanApproved \? managerPolicyKey\("autonomy_tier", managerKey\) : null\)/.test(disp))
    check("WIRED: a sequence A/B send names `experiments`", /policyKey: EXPERIMENTS_POLICY_KEY/.test(code("lib/workflow/channel-registry.ts")))
    check("WIRED: the AI tool mount names the authority ladder for its agent kind", /policyKey: `authority_level:ai_isa`/.test(stripComments(read("lib/ai-isa/customer-context-tools.ts"))))
    check("WIRED: loadExperimentPolicy returns the live version beside the value", /currentPolicyVersion\(svc, brokerageId, EXPERIMENTS_POLICY_KEY\)/.test(code("lib/kernel/experiments.ts")))
    const fr = code("app/actions/flight-recorder.ts")
    // m700 is live: ONE literal column list carries policy_ref on BOTH ledger reads (a column-list
    // variable would hide every column from the readerless-write census — wave 102 integration).
    // Asserted as the RULE, not a count (wave 104D added the mission read): EVERY ledger read in the
    // file selects through ACTION_COLS, and there are at least the two m700 established.
    const frLedgerReads = (stripComments(read("app/actions/flight-recorder.ts")).match(/from\("agent_action_ledger"\)\.select\(/g) ?? []).length
    const frColsReads = (stripComments(read("app/actions/flight-recorder.ts")).match(/from\("agent_action_ledger"\)\.select\(ACTION_COLS\)/g) ?? []).length
    check("WIRED: the flight recorder's ledger reads select policy_ref through the one literal column list (every read)", /const ACTION_COLS =\s*"[^"]*\bpolicy_ref\b[^"]*"/.test(stripComments(read("app/actions/flight-recorder.ts"))) && frLedgerReads >= 2 && frColsReads === frLedgerReads)
    check("WIRED: the AI audit page shows 'permitted by <ref>'", /l\.policyRef/.test(stripComments(read("app/dashboard/admin/ai-audit/page.tsx"))))
    check("POSITIVE CONTROL: the dispatch wiring finder rejects a context without policyKey", !/policyKey:/.test(`return { brokerageId: params.brokerageId, action, channel, actor, subject }`))
  }

  console.log("\n[blind spots]")
  console.log("  · policy_ref (102D): the version is read per ledger row from tenant_policy_versions (one extra read per claim); dispatch names the posture key, not the authority rung it also consulted (that rides the same managed_agents row); the direct-mail bandit names no policy until its 102C kill switch key lands; a human-approved send names no tenant policy")
  console.log("  · lifecycle_events inserters NOT moved are NAMED with their reasons in section 13 (payload/processed writers, injected-client audits, the transition writer, an entity-less row). The finder sees only the literal .from(\"lifecycle_events\").insert( shape — a table-name constant or a single-quoted literal is invisible to it")
  console.log("  · pairs (13c): an auditOnly row + a separate processKernelEvent of the same event were merged into ONE emit wherever the reactor input is byte-equivalent (same event/tenant/entity/ids; the event's reactor readers use no metadata, or the fan-out's metadata is a same-valued superset; agentUserId: null keeps attribution). The finder pairs a row with the SAME typed event fanned out ANYWHERE later in the module — a pair split across functions is named, not merged; a fan-out with no audit row of its own (a bare processKernelEvent) is not a pair and is not counted")
  console.log("  · portal messages: ~30 direct client_portal_messages inserters remain outside insertPortalMessage; the four senders that reach a client on demand are routed")
  console.log("  · AI tool calls are ledgered on the CUSTOMER bundle (buildCustomerFreeTools); the platform prospect agent (no tenant) and the staff toolkit's non-portal tools are not")
  console.log("  · 'unknown' rows with no outcome_reconciliations claim are settled 'failed' after the abandon window — a send that DID leave without a claim (provider timed out AFTER accepting) can then be retried by a LATER cycle")
  console.log("  · the in-memory table models UNIQUE/23505 and filters; it does not model RLS (m687's policy is asserted textually)")

  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
