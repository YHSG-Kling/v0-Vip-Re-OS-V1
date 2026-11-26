#!/usr/bin/env tsx
/**
 * scripts/follow-on-trigger-guard.ts   (npm run test:follow-on-trigger) — in memory, no DB, no network. SIMULATED.
 * ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 * WAVE 155, LANE 155J3 — directive J3 (lines 419–430), eval REWARD-001 / REWARD-005 / SCOPE-006: a follow-on is EVENT-TRIGGERED or
 * DURABLY SCHEDULED, never a passive promise. Drives the REAL survivors over scripts/in-memory-supabase.ts (no new queue):
 *   · lib/ai-isa/followup-arbiter.ts evidenceFires / normalizeProviderEvidence / supersedeFollowOnsForPerson (the reactor's reply
 *     consumer) — an open is evidence, never readiness; a reply reshapes the queue once; a replayed reply moves nothing;
 *   · lib/kernel/authority-reactions.ts reactToMembershipChange → its private
 *     cancelSeatBundleFollowOns — a seat that left the tenant cancels the pieces queued in its name (another seat's, another
 *     tenant's and an already-claimed piece untouched); a replayed event cancels nothing more;
 *   · executeBundleFollowOnTask — the sender seat and the carrying campaign's end are re-read LIVE before any send;
 *   · lib/outcomes/follow-on-contract.ts followOnContract — directive J3's per-follow-on record read back from a REAL written row,
 *     and the drain's runnable gate (no tenant / no once-key → never executed).
 * SEAMS (counted, never live): the channel send (dispatchItem) and the Contact-engagement arbiter (arbitrate).
 *   A. EVIDENCE (REWARD-001)   B. REPLY + REPLAY (REWARD-005)   C. MEMBERSHIP   D. SEAT + EXPIRY AT EXECUTION
 *   E. THE RECORD (contract)   F. WIRING (stripped source, each absence with a POSITIVE CONTROL)
 * "Now" is derived inside the proof — no calendar date is pinned.
 */
import { registerHooks } from "node:module"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { stripComments } from "./strip-comments"
import { memSupabase, type MemClient, type Row } from "./in-memory-supabase"

const G = { svc: null as MemClient | null }
;(globalThis as any).__J3 = G
const STUBS: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => { const s = globalThis.__J3.svc; if (!s) throw new Error('no client'); return s }",
  "@/lib/kernel/write-sentinel": "export async function sentinelWrite(_s, p){ return await p }",
}
registerHooks({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- node:module ResolveHookSync shape (the repo's idiom)
  resolve(spec: string, ctx: any, next: any) {
    const stub = STUBS[spec]
    if (stub !== undefined) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, d?: string) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n + (d ? ` — ${d}` : "")); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) } }
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const ROOT = process.cwd()
const raw = (p: string) => { try { return readFileSync(join(ROOT, p), "utf8") } catch { return "" } }
const code = (p: string) => stripComments(raw(p))

const NOW = new Date()
const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString()
const H1 = 3_600_000
const B = randomUUID(), B2 = randomUUID()
const SENDER = randomUUID(), OTHER = randomUUID(), C1 = randomUUID(), C2 = randomUUID(), LEAD = randomUUID(), CAMP = randomUUID()

function db(extra: Record<string, Row[]> = {}, opts: { refuse?: Record<string, string> } = {}): MemClient {
  return memSupabase({
    brokerages: [{ id: B }, { id: B2 }],
    users: [{ id: SENDER, brokerage_id: B, status: "active", deleted_at: null }, { id: OTHER, brokerage_id: B, status: "active", deleted_at: null }],
    contacts: [{ id: C1, brokerage_id: B, deleted_at: null }, { id: C2, brokerage_id: B, deleted_at: null }],
    leads: [{ id: LEAD, brokerage_id: B, first_name: "Pat", last_name: "Moore", email: "pat.moore@example.test", phone: null, converted_at: null, mailing_address: null, mailing_city: null, mailing_state: null, mailing_zip: null }],
    orchestrator_tasks: [], campaign_bundles: [], campaign_bundle_items: [], campaign_bundle_dispatches: [], marketing_campaigns: [], social_posts: [], sequence_enrollments: [], agent_action_ledger: [],
    ...extra,
  }, { uuidIds: true, stampCreatedAt: true, refuse: opts.refuse, unique: { orchestrator_tasks: [["payload->>idempotency_key"]] } })
}

/** A bundle piece as orchestrate-bundle-send.ts writes it (ids only), for the queue-shape proofs. */
const piece = (o: { brokerage?: string; sender?: string; contact?: string | null; lead?: string | null; status?: string; channel?: string; bundle?: string; dispatch?: string; item?: string; campaign?: string | null; key?: string | null }): Row => {
  const dispatch = o.dispatch ?? randomUUID(), item = o.item ?? randomUUID()
  return {
    id: randomUUID(), brokerage_id: o.brokerage ?? B, task_type: "bundle_follow_on", status: o.status ?? "pending", scheduled_for: iso(-60_000), attempts: 0, created_at: iso(-H1), updated_at: iso(-H1),
    payload: {
      ...(o.key === null ? {} : { idempotency_key: o.key ?? `bundle_follow_on:${dispatch}:${item}` }),
      bundle_id: o.bundle ?? randomUUID(), bundle_dispatch_id: dispatch, bundle_item_id: item, origin_item_id: null, depends_on: [],
      item: { channel: o.channel ?? "email", preset_id: randomUUID(), order_index: 1, author_spacing_minutes: null },
      audience: { contact_id: o.contact === undefined ? C1 : o.contact, lead_id: o.lead ?? null }, marketing_campaign_id: o.campaign ?? null,
      sender: { user_id: o.sender ?? SENDER, agent_id: null, agent_user_id: o.sender ?? SENDER, team_id: null }, manager: "campaign_orchestrator",
      qr_scan_url: null, system_source: "proof", timing: { policy: "arbiter", planner: "bundle_follow_on", person_facing: true, arbiter_waits: 0 },
      governance: { contact_engagement: null, outbound: "dispatch", audience: null }, expected_evidence: ["channel_outcome"], deferrals: 0,
    },
  }
}
/** A next-action follow-on as followup-arbiter.ts persistNextActionFollowOn writes it. */
const nextAction = (o: { contact?: string; waits?: string[]; brokerage?: string }): Row => ({
  id: randomUUID(), brokerage_id: o.brokerage ?? B, task_type: "next_action_follow_on", status: "pending", scheduled_for: iso(24 * H1), attempts: 0, created_at: iso(-H1), updated_at: iso(-H1),
  payload: {
    idempotency_key: `next_action_follow_on:${o.brokerage ?? B}:home_anniversary:${randomUUID()}:v1:contact:${o.contact ?? C1}:timer_due`, planner: "lifetime_touch", brokerage_id: o.brokerage ?? B,
    source_event: { type: "home_anniversary", id: randomUUID(), version: 1, at: iso(-2 * H1), causal_parent: null }, subject_type: "contact", subject_id: o.contact ?? C1,
    actor: { agent_id: randomUUID(), campaign_id: null, artifact: null }, manager: "ai_isa", trigger: "timer_due", waits_for: o.waits ?? ["recipient_replied", "delivery_failed", "send_outcome_unknown"],
    condition: "a reply is the next trigger", expected_evidence: ["delivered", "replied"], dependencies: [], eligibility: { channels: ["email"], lawful: ["email"], conversation_owner: "ai", taken_at: iso(-2 * H1) },
    window: { start: iso(-2 * H1), end: iso(24 * H1) }, origin: { candidate: "send_now", verb: "send", channels: ["email"], provider_message_id: "prov-greeting-1" }, notify_agent_on_reply: false, state: "waiting", evaluations: 0, recovery_waits: 0,
  },
})

async function main() {
  const fa = await import("../lib/ai-isa/followup-arbiter")
  const ar = await import("../lib/kernel/authority-reactions")
  const bundle = await import("../lib/direct-mail/orchestrate-bundle-send")
  const fc = await import("../lib/outcomes/follow-on-contract")

  // ══ A ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("A · EVIDENCE — an open or a click is evidence, never readiness (REWARD-001); unknown is never upgraded")
  for (const e of ["opened", "clicked", "delivered", "accepted"] as const) check(`'${e}' fires NO follow-on trigger (no touch escalates on it)`, fa.evidenceFires(e).length === 0, JSON.stringify(fa.evidenceFires(e)))
  check("a reply fires exactly the reply trigger", JSON.stringify(fa.evidenceFires("replied")) === JSON.stringify(["recipient_replied"]))
  check("unknown fires only 'send_outcome_unknown' (reconciled first, never a resend trigger)", JSON.stringify(fa.evidenceFires("unknown")) === JSON.stringify(["send_outcome_unknown"]))
  check("an unrecognised provider word reads 'unknown', never 'delivered'", fa.normalizeProviderEvidence("pixel_loaded") === "unknown" && fa.normalizeProviderEvidence("open") === "opened")
  check("POSITIVE CONTROL: the escalation finder sees a trigger when one fires", fa.evidenceFires("bounced").length === 1)

  // ══ B ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("B · A REAL REPLY → the queue reshapes ONCE; the live conversation makes the one fresh decision; replay moves nothing (REWARD-005)")
  {
    const s = db(); G.svc = s
    const watch = nextAction({ waits: ["recipient_replied", "delivery_failed"] })
    const stale = piece({ contact: C1 })
    const other = piece({ contact: C2 })
    const foreign = piece({ contact: C1, brokerage: B2 })
    s.tables.orchestrator_tasks.push(watch, stale, other, foreign)
    const r1 = await fa.supersedeFollowOnsForPerson(s as never, { brokerageId: B, subject: { type: "contact", id: C1 }, reason: "recipient_replied", now: NOW, eventRef: "isa_reply_received:msg-1" })
    const st = (id: string) => s.tables.orchestrator_tasks.find((t) => t.id === id)?.status
    check("the reply CONSUMES the reply-watch (completed) and CANCELS the stale bundle piece — 1 + 1", r1.consumed === 1 && r1.cancelled === 1 && st(watch.id) === "completed" && st(stale.id) === "cancelled", JSON.stringify(r1))
    check("another person's piece and another tenant's piece are untouched", st(other.id) === "pending" && st(foreign.id) === "pending")
    check("nothing queued for C1 is left pending — the next step is the live conversation's ONE fresh decision, not a stale plan", s.tables.orchestrator_tasks.filter((t) => t.brokerage_id === B && (t.payload?.subject_id === C1 || t.payload?.audience?.contact_id === C1) && t.status === "pending").length === 0)
    const ledgerAfter1 = s.tables.agent_action_ledger.length
    check("the reshape is ledgered once (LAW 5)", ledgerAfter1 >= 1 && s.tables.agent_action_ledger.some((l) => JSON.stringify(l.detail ?? {}).includes("follow_on_reconcile")))
    const r2 = await fa.supersedeFollowOnsForPerson(s as never, { brokerageId: B, subject: { type: "contact", id: C1 }, reason: "recipient_replied", now: NOW, eventRef: "isa_reply_received:msg-1" })
    check("REPLAY of the same reply: 0 consumed, 0 cancelled, no new ledger row (zero additional sends or attributions)", r2.consumed === 0 && r2.cancelled === 0 && s.tables.agent_action_ledger.length === ledgerAfter1, JSON.stringify(r2))
  }

  // ══ C ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("C · A CHANGED MEMBERSHIP cancels the work queued in that seat's name (and nothing else)")
  {
    const s = db(); G.svc = s
    s.tables.users.find((u) => u.id === SENDER)!.status = "suspended"
    const mine = piece({ sender: SENDER }), others = piece({ sender: OTHER }), foreign = piece({ sender: SENDER, brokerage: B2 }), claimed = piece({ sender: SENDER, status: "running" })
    s.tables.orchestrator_tasks.push(mine, others, foreign, claimed)
    const ev = { event: "user_role_changed", brokerageId: B, entityType: "user", entityId: SENDER, metadata: { newRole: "agent" } }
    const r = await ar.reactToMembershipChange(s as never, ev, { now: NOW })
    const st = (id: string) => s.tables.orchestrator_tasks.find((t) => t.id === id)?.status
    check("the seat is GONE and its ONE pending piece is cancelled (chain stopped, trigger membership_changed)", r.decision === "gone" && r.followOnsCancelled === 1 && st(mine.id) === "cancelled" && s.tables.orchestrator_tasks.find((t) => t.id === mine.id)?.payload?.outcome?.trigger === "membership_changed", JSON.stringify(r))
    check("another seat's piece, another tenant's piece and an already-CLAIMED piece are untouched", st(others.id) === "pending" && st(foreign.id) === "pending" && st(claimed.id) === "running")
    const row = s.tables.agent_action_ledger.find((l) => l.action === "membership.queue.recheck")
    check("ledgered by the Data Steward with the follow-on count on the outcome", !!row && /follow_ons=1/.test(String(row.outcome ?? "")), String(row?.outcome))
    const replay = await ar.reactToMembershipChange(s as never, ev, { now: NOW })
    check("REPLAY of the same seat event cancels nothing more", (replay.followOnsCancelled ?? 0) === 0 && s.tables.orchestrator_tasks.filter((t) => t.status === "cancelled").length === 1)
    const live = db(); G.svc = live
    const keep = piece({ sender: SENDER }); live.tables.orchestrator_tasks.push(keep)
    const rl = await ar.reactToMembershipChange(live as never, ev, { now: NOW })
    check("NEGATIVE CONTROL: a seat that still sits in the tenant cancels nothing", rl.decision !== "gone" && (rl.followOnsCancelled ?? 0) === 0 && live.tables.orchestrator_tasks[0].status === "pending", JSON.stringify(rl))
  }

  // ══ D ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("D · AT EXECUTION — the sender seat and the campaign's end are re-read LIVE; a refused or expired piece never sends")
  let writtenNext: Row | undefined
  {
    const setup = (o: { seat?: Partial<Row> | null; campaign?: Partial<Row> | null; refuse?: Record<string, string> } = {}) => {
      const s = db({}, { refuse: o.refuse }); G.svc = s
      if (o.seat === null) s.tables.users = s.tables.users.filter((u) => u.id !== SENDER)
      else if (o.seat) Object.assign(s.tables.users.find((u) => u.id === SENDER)!, o.seat)
      const bundleId = randomUUID(), dispatch = randomUUID()
      const items = [0, 1, 2].map((i) => ({ id: randomUUID(), bundle_id: bundleId, brokerage_id: B, channel: "email", preset_id: randomUUID(), order_index: i, send_after_minutes: 0 }))
      s.tables.campaign_bundles.push({ id: bundleId, brokerage_id: B, name: "Spring market", is_active: true })
      s.tables.campaign_bundle_items.push(...items)
      s.tables.campaign_bundle_dispatches.push({ id: dispatch, brokerage_id: B, bundle_id: bundleId, contact_id: null, lead_id: LEAD, dispatched_at: iso(-2 * H1), channel_outcomes: {} })
      if (o.campaign !== null) s.tables.marketing_campaigns.push({ id: CAMP, brokerage_id: B, status: "live", scheduled_end_at: iso(7 * 24 * H1), completed_at: null, ...(o.campaign ?? {}) })
      const t = piece({ contact: null, lead: LEAD, bundle: bundleId, dispatch, item: items[1].id, campaign: CAMP })
      t.payload.item.preset_id = items[1].preset_id
      s.tables.orchestrator_tasks.push(t)
      const sends: string[] = []
      let asked = 0
      const deps = {
        now: () => NOW,
        dispatchItem: (async (_s: unknown, item: { channel: string }) => { sends.push(item.channel); return { channel: item.channel, preset_id: null, success: true, messageId: `prov-${sends.length}` } }) as never,
        arbitrate: (async () => { asked++; return { choice: "send_now", decision: { kind: "send_now", waitHours: null, rationale: "now" }, halt: null } }) as never,
      }
      return { s, t, sends, deps, asked: () => asked }
    }
    const ok = setup()
    const v = await bundle.executeBundleFollowOnTask(ok.s as never, { id: ok.t.id }, ok.deps)
    check("live seat + live campaign → the piece is sent ONCE and the read expiry is on its outcome (readback)", v.verdict === "sent" && ok.sends.length === 1 && ok.s.tables.orchestrator_tasks.find((x) => x.id === ok.t.id)?.payload?.outcome?.expires_at === iso(7 * 24 * H1), `${v.verdict} ${v.reason}`)
    writtenNext = ok.s.tables.orchestrator_tasks.find((x) => x.status === "pending" && x.id !== ok.t.id)
    const again = await bundle.executeBundleFollowOnTask(ok.s as never, { id: ok.t.id }, ok.deps)
    check("REPLAY of the same task → skipped, 0 more sends (REWARD-005)", again.verdict === "skipped" && ok.sends.length === 1)
    for (const [label, seat] of [["suspended", { status: "suspended" }], ["moved to another tenant", { brokerage_id: B2 }], ["removed", { deleted_at: iso(-H1) }], ["deleted (no row)", null]] as const) {
      const x = setup({ seat: seat as never })
      const r = await bundle.executeBundleFollowOnTask(x.s as never, { id: x.t.id }, x.deps)
      check(`sender ${label} → cancelled, chain stopped, 0 sends, 0 arbiter calls`, r.verdict === "cancelled" && /sending seat/.test(r.reason) && x.sends.length === 0 && x.asked() === 0 && x.s.tables.orchestrator_tasks.filter((t) => t.status === "pending").length === 0, `${r.verdict} ${r.reason}`)
    }
    const unread = setup({ refuse: { users: "permission denied for table users" } })
    const ru = await bundle.executeBundleFollowOnTask(unread.s as never, { id: unread.t.id }, unread.deps)
    check("an UNREADABLE seat holds (re-asked later), never sends and never cancels", ru.verdict === "retry" && /seat could not be read/.test(ru.reason) && unread.sends.length === 0 && unread.s.tables.orchestrator_tasks.find((t) => t.id === unread.t.id)?.status === "pending", `${ru.verdict} ${ru.reason}`)
    const exp = setup({ campaign: { scheduled_end_at: iso(-H1) } })
    const re = await bundle.executeBundleFollowOnTask(exp.s as never, { id: exp.t.id }, exp.deps)
    check("EXPIRY passed (campaign end an hour ago) → the queued piece does not run: cancelled 'expired', 0 sends", re.verdict === "cancelled" && /expired/.test(re.reason) && exp.sends.length === 0, `${re.verdict} ${re.reason}`)
    for (const status of ["ended", "archived"]) {
      const x = setup({ campaign: { status, scheduled_end_at: null } })
      const r = await bundle.executeBundleFollowOnTask(x.s as never, { id: x.t.id }, x.deps)
      check(`a campaign that is '${status}' ends its queued piece — 0 sends`, r.verdict === "cancelled" && /expired/.test(r.reason) && x.sends.length === 0, `${r.verdict} ${r.reason}`)
    }
    const noEnd = setup({ campaign: { scheduled_end_at: null } })
    const rn = await bundle.executeBundleFollowOnTask(noEnd.s as never, { id: noEnd.t.id }, noEnd.deps)
    check("NO end recorded → no expiry is invented: the piece is sent", rn.verdict === "sent" && noEnd.sends.length === 1, `${rn.verdict} ${rn.reason}`)
    const campRefused = setup({ refuse: { marketing_campaigns: "permission denied" } })
    const rc = await bundle.executeBundleFollowOnTask(campRefused.s as never, { id: campRefused.t.id }, campRefused.deps)
    check("an UNREADABLE campaign holds — never sends", rc.verdict === "retry" && /campaign could not be read/.test(rc.reason) && campRefused.sends.length === 0, `${rc.verdict} ${rc.reason}`)
  }

  // ══ E ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("E · THE RECORD — directive J3's fields read back from a REAL written row; the drain's runnable gate")
  {
    check("the real writer persisted the next piece", !!writtenNext)
    const c = fc.followOnContract(writtenNext as never)
    check("bundle row: shape, due trigger, owner (campaign_orchestrator + seat), asset id, channel, tenant, once-key, last state", c.shape === "bundle" && c.due_trigger.trigger === "previous_item_settled" && c.owner.manager === "campaign_orchestrator" && c.owner.seat === SENDER && !!c.asset.id && c.channel[0] === "email" && c.tenant === B && !!c.once_key && c.last_state === "pending", JSON.stringify(c))
    check("bundle row: runnable, no gaps", c.runnable && c.gaps.length === 0, JSON.stringify(c.gaps))
    const n = fc.followOnContract(nextAction({}) as never)
    check("next-action row: trigger, waits_for, owner, channel, expiry (window end), receipt, recovery counters", n.shape === "next_action" && n.due_trigger.trigger === "timer_due" && n.due_trigger.waits_for.includes("recipient_replied") && n.owner.manager === "ai_isa" && n.channel[0] === "email" && !!n.expires_at && n.receipt === "prov-greeting-1" && n.recovery.waits === 0 && n.runnable, JSON.stringify(n))
    const noKey = fc.followOnContract(piece({ key: null }) as never)
    check("POSITIVE CONTROL: a row with NO once-key is NOT runnable (a re-run could not be at-most-once)", !noKey.runnable && /once-key/.test(noKey.refusal ?? "") && noKey.gaps.includes("once_key"))
    const noTenant = fc.followOnContract({ ...piece({}), brokerage_id: null } as never)
    check("POSITIVE CONTROL: a row with NO tenant is NOT runnable", !noTenant.runnable && /tenant/.test(noTenant.refusal ?? ""))
    check("seatStanding: live / gone / unreadable", fc.seatStanding({ row: { brokerage_id: B, status: null, deleted_at: null }, error: null }, B).standing === "live" && fc.seatStanding({ row: { brokerage_id: B, status: "inactive", deleted_at: null }, error: null }, B).standing === "gone" && fc.seatStanding({ row: null, error: { message: "x" } }, B).standing === "unreadable")
    check("followOnExpired: unknown never expires; past expires; future does not", !fc.followOnExpired(null, NOW) && fc.followOnExpired(iso(-1000), NOW) && !fc.followOnExpired(iso(1000), NOW))
  }

  // ══ F ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section("F · WIRING (stripped source)")
  {
    const drain = code("app/api/cron/queue-drain/route.ts")
    const gateBeforeExecutors = (src: string) => {
      const g = src.indexOf("followOnContract(")
      const b = src.indexOf("executeBundleFollowOnTask(supabase")
      const l = src.indexOf("executeLifetimeFollowOn(supabase")
      return g > 0 && b > g && l > g && /if \(!contract\.runnable\)/.test(src)
    }
    check("the drain asks followOnContract(...).runnable BEFORE either follow-on executor", gateBeforeExecutors(drain))
    check("POSITIVE CONTROL: the finder fails when the gate is absent", !gateBeforeExecutors(drain.replace(/followOnContract\(/g, "contractOf(")))
    const reactions = code("lib/kernel/authority-reactions.ts")
    check("the membership reaction calls cancelSeatBundleFollowOns inside its 'gone' branch", /if \(decision !== "gone"\)[\s\S]*cancelSeatBundleFollowOns\(svc/.test(reactions))
    const importsBundle = (src: string) => /["']@\/lib\/direct-mail\/orchestrate-bundle-send["']/.test(src)
    check("GRAPH: the membership reaction does NOT import the bundle module (measured +9 modules on app/crm/page.tsx)", !importsBundle(reactions))
    check("POSITIVE CONTROL: the import finder sees the bundle module when it is imported", importsBundle(`${reactions}\nconst m = await import("@/lib/direct-mail/orchestrate-bundle-send")`))
    const reactor = code("lib/kernel/event-reactor.ts")
    check("the reactor routes USER_ROLE_CHANGED / USER_TEAM_ASSIGNED to reactToMembershipChange and ISA_REPLY_RECEIVED to supersedeFollowOnsForPerson", /reactToMembershipChange\(svc/.test(reactor) && /ISA_REPLY_RECEIVED[\s\S]{0,400}supersedeFollowOnsForPerson\(svc[^)]*recipient_replied/.test(reactor))
    const exec = code("lib/direct-mail/orchestrate-bundle-send.ts")
    const order = (src: string) => { const seat = src.indexOf("seatStanding({"), exp = src.indexOf("followOnExpired(expiresAt"), send = src.indexOf("withSendIntent(intentKey"); return seat > 0 && exp > seat && send > exp }
    check("the bundle executor re-reads the seat and the expiry BEFORE its send", order(exec))
    check("POSITIVE CONTROL: the order finder fails when the seat read is missing", !order(exec.replace("seatStanding({", "seatOf({")))
    check("no TOMBSTONE counted as a call site: the stripped source differs from raw where comments name these symbols", code("lib/outcomes/follow-on-contract.ts").length < raw("lib/outcomes/follow-on-contract.ts").length)
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed (SIMULATED: in-memory database, counted seams, no provider or model called)`)
  if (fail) { for (const f of fails) console.log(`   ✗ ${f}`); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
