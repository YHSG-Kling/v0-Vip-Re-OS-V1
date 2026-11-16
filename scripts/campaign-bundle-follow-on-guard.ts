#!/usr/bin/env tsx
/**
 * scripts/campaign-bundle-follow-on-guard.ts   (npm run test:campaign-bundle-follow-on) — in memory, no DB, no network.
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 153, LANE 153I — CONVERGENCE ROW 71: a campaign bundle's later items are PERSISTED follow-ons that the EXISTING
 * drain actually runs. Drives the REAL survivors over scripts/in-memory-supabase.ts:
 *   · lib/direct-mail/orchestrate-bundle-send.ts orchestrateBundleSend (the click) and executeBundleFollowOnTask /
 *     recoverStaleBundleFollowOns (the drain's executor);
 *   · app/api/cron/queue-drain/route.ts GET — the real cron route, so "the drain runs" is a request, not a claim;
 *   · app/actions/campaign-bundles.ts upsertCampaignBundle — the stable item identity across edits.
 * STUBBED (node:module registerHooks, the canary harness's idiom): the nine channel orchestrators (every send is RECORDED —
 * nothing leaves), the Contact-engagement arbiter (scripted verdicts; its own proofs — test:arbiter-timing — own it), the
 * session / scope resolvers, cron plumbing, and the route's other queues' providers. SIMULATED, never live.
 *
 *   A. THE CLICK — the first item only; the next persisted with origin, dependency, timing policy, expected evidence,
 *      idempotency, and NO contact PII; per-item outcomes (two items on one channel never overwrite each other).
 *   B. THE DRAIN RUNS — the real queue-drain GET executes each due follow-on through the arbiter and the channel
 *      orchestrator, chains to the next item, and a replayed tick sends nothing.
 *   C. ADVERSE — arbiter wait (bounded, re-checked), suppressed Contact (halt → cancelled, chain continues), bundle
 *      deactivated (chain stops), item removed (cancelled, chain continues), changed audience (chain stops), provider
 *      failure (retried, never twice, then failed), gate refusal (never retried), a throw mid-send (outcome unknown, never
 *      re-sent), two concurrent drains (one send), a stale claim (failed, never re-sent), a converted lead (stops), a lead
 *      on a phone channel (skipped), an unrelated tenant's dispatch (refused), an audience piece (no Contact arbiter).
 *   D. THE STABLE ITEM IDENTITY — an edit keeps kept items' ids, deletes only removed items, inserts only new ones;
 *      another tenant's bundle is refused.
 *   E. WIRING — stripped source: the route hands the task type to its executor BEFORE the "no executor registered"
 *      fallback, the route is scheduled, the single synchronous pass is gone; every absence with a positive control.
 */
import { registerHooks } from "node:module"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { stripComments } from "./strip-comments"
import { memSupabase, type MemClient, type Row } from "./in-memory-supabase"

// ── the seams ───────────────────────────────────────────────────────────────────────────────────────────────────
interface SendCall { channel: string; args: Record<string, any> }
interface ArbCall { input: Record<string, any> }
const H = {
  svc: null as MemClient | null,
  sends: [] as SendCall[],
  arbCalls: [] as ArbCall[],
  /** Scripted per-channel outcome; default success with a fresh provider id. */
  outcome: {} as Record<string, (args: any) => any>,
  arbitrate: (_input: any): any => ({ choice: "send_now", decision: { kind: "send_now", waitHours: null, rationale: "now is fine" }, halt: null }),
  session: { brokerageId: "", agentScopeId: "" },
  cron: { success: null as any, failure: null as any },
}
;(globalThis as any).__B153 = {
  get svc() { return H.svc },
  send: (channel: string, args: any) => {
    H.sends.push({ channel, args })
    const f = H.outcome[channel]
    if (f) return f(args)
    const id = `prov-${channel}-${H.sends.length}`
    return { success: true, messageId: id, jobId: id, socialPostIds: [id], distributionLogIds: [id], adCampaignId: id, rendered: true }
  },
  arbitrate: (input: any) => { H.arbCalls.push({ input }); return H.arbitrate(input) },
  session: () => H.session,
  cron: H.cron,
}
const sendStub = (channel: string, fn: string) => `export async function ${fn}(a){ return globalThis.__B153.send(${JSON.stringify(channel)}, a) }`
const STUBS: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => { const s = globalThis.__B153.svc; if (!s) throw new Error('no client'); return s }",
  "./orchestrate-preset-send": sendStub("direct_mail", "orchestratePresetSend"),
  "@/lib/email/orchestrate-email-preset-send": sendStub("email", "orchestrateEmailPresetSend"),
  "@/lib/sms/orchestrate-sms-preset-send": sendStub("sms", "orchestrateSmsPresetSend"),
  "@/lib/portal/orchestrate-portal-push-send": sendStub("portal_push", "orchestratePortalPushSend"),
  "@/lib/voicedrop/orchestrate-voicedrop-send": sendStub("voicedrop", "orchestrateVoicedropSend"),
  "@/lib/social/orchestrate-social-preset-publish": sendStub("social_post", "orchestrateSocialPresetPublish"),
  "@/lib/podcast/orchestrate-podcast-preset-publish": sendStub("podcast_episode", "orchestratePodcastPresetPublish"),
  "@/lib/ads/orchestrate-ad-retarget-send": sendStub("ad_retarget", "orchestrateAdRetargetSend"),
  "@/lib/ai-isa/followup-arbiter": "export async function arbitratePlannedTouch(svc, input){ return globalThis.__B153.arbitrate(input) }",
  "@/lib/contacts/resolve-mailing-address": "export async function resolveMailingAddressForContact(){ return { street: '12 Gulf Breeze Pkwy', city: 'Pace', state: 'FL', zip: '32571' } }",
  // queue-drain route plumbing (its other queues are empty in this proof)
  "@/lib/cron-auth": "export const verifyCronAuth = () => null",
  "@/app/actions/cron-kernel": "export async function createCronRunContextAction(){ return { success: true, data: { context_id: 'ctx-153i' } } }; export async function recordCronStartAction(){}; export async function recordCronSuccessAction(a){ globalThis.__B153.cron.success = a }; export async function recordCronFailureAction(a){ globalThis.__B153.cron.failure = a }",
  "@/lib/providers/dispatch": "export async function dispatchEmail(){ throw new Error('no email queue in this proof') }",
  "@/lib/providers/web-push": "export const isWebPushConfigured = () => false; export async function sendWebPush(){ return { ok: false } }",
  "@/lib/campaign-sequences/enrollment-engine": "export async function enrollContact(){ return { success: false, error: 'not in this proof' } }",
  "@/lib/did/live-session-metering": "export async function sweepStaleLiveAgentSessions(){ return { swept: 0, errors: [] } }",
  "@/lib/knowledge/embedding-service": "export async function processPendingEmbeddings(){ return { processed: 0, succeeded: 0, failed: 0 } }",
  // the bundle builder's session seams
  "next/cache": "export function revalidatePath(){}",
  "@/lib/identity/policy-scope": "export async function resolvePolicyScopeAccess(){ const s = globalThis.__B153.session(); return { brokerageScopeId: s.brokerageId, canEditAgent: true, canEditTeam: false, canEditBrokerage: true, agentScopeId: s.agentScopeId, teamScopeIds: [] } }; export function buildScopeFilters(a){ return [`scope_type.eq.brokerage`] }",
  "@/lib/identity/get-agent-context": "export async function getAgentContext(){ const s = globalThis.__B153.session(); return { brokerageId: s.brokerageId } }",
}
registerHooks({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- node:module ResolveHookSync shape (the repo's idiom)
  resolve(spec: string, ctx: any, next: any) {
    const stub = STUBS[spec]
    if (stub !== undefined) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

// ── the proof's plumbing ────────────────────────────────────────────────────────────────────────────────────────
let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, d?: string) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n + (d ? ` — ${d}` : "")); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) } }
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const ROOT = process.cwd()
const raw = (p: string) => { try { return readFileSync(join(ROOT, p), "utf8") } catch { return "" } }
const code = (p: string) => stripComments(raw(p))

const B = randomUUID(), B2 = randomUUID(), AGENT = randomUUID(), AGENT_USER = randomUUID()
const C1 = randomUUID(), C2 = randomUUID(), LEAD = randomUUID(), LEAD2 = randomUUID()
const P = { email: randomUUID(), sms: randomUUID(), mail: randomUUID(), email2: randomUUID(), social: randomUUID() }

function freshDb(extra: Record<string, Row[]> = {}): MemClient {
  return memSupabase({
    brokerages: [{ id: B }, { id: B2 }],
    contacts: [
      { id: C1, brokerage_id: B, first_name: "Dana", last_name: "Rivera", email: "dana.rivera@example.test", phone: "+18505550101", deleted_at: null, agent_id: AGENT },
      { id: C2, brokerage_id: B, first_name: "Sam", last_name: "Lee", email: "sam.lee@example.test", phone: "+18505550102", deleted_at: null, agent_id: AGENT },
    ],
    leads: [
      { id: LEAD, brokerage_id: B, first_name: "Pat", last_name: "Moore", email: "pat.moore@example.test", phone: "+18505550103", converted_at: null, mailing_address: "4 Elm St", mailing_city: "Destin", mailing_state: "FL", mailing_zip: "32541" },
      { id: LEAD2, brokerage_id: B, first_name: "Kim", last_name: "Ng", email: "kim.ng@example.test", phone: null, converted_at: new Date().toISOString(), mailing_address: null, mailing_city: null, mailing_state: null, mailing_zip: null },
    ],
    campaign_bundles: [], campaign_bundle_items: [], campaign_bundle_dispatches: [], orchestrator_tasks: [], direct_mail_campaigns: [],
    ...extra,
  }, { uuidIds: true, stampCreatedAt: true, unique: { orchestrator_tasks: [["payload->>idempotency_key"]] } })
}
function seedBundle(db: MemClient, items: Array<{ channel: string; preset_id: string }>, opts: { brokerageId?: string; active?: boolean } = {}): { bundleId: string; itemIds: string[] } {
  const bundleId = randomUUID()
  const brokerage = opts.brokerageId ?? B
  db.tables.campaign_bundles.push({ id: bundleId, brokerage_id: brokerage, name: `Bundle ${bundleId.slice(0, 4)}`, is_active: opts.active ?? true, scope_type: "brokerage", scope_id: brokerage })
  const itemIds = items.map((it, i) => {
    const id = randomUUID()
    db.tables.campaign_bundle_items.push({ id, bundle_id: bundleId, brokerage_id: brokerage, channel: it.channel, preset_id: it.preset_id, order_index: i, send_after_minutes: 0 })
    return id
  })
  return { bundleId, itemIds }
}
const tasks = (db: MemClient, dispatchId?: string) => db.tables.orchestrator_tasks.filter((t) => t.task_type === "bundle_follow_on" && (!dispatchId || t.payload?.bundle_dispatch_id === dispatchId))
const pendingOf = (db: MemClient, dispatchId: string) => tasks(db, dispatchId).filter((t) => t.status === "pending")
const reset = (db: MemClient) => { H.svc = db; H.sends.length = 0; H.arbCalls.length = 0; H.outcome = {}; H.arbitrate = () => ({ choice: "send_now", decision: { kind: "send_now", waitHours: null, rationale: "now is fine" }, halt: null }) }
const clickArgs = (bundleId: string, contactId = C1) => ({
  brokerageId: B, bundleId, contactId, agentId: AGENT, agentUserId: AGENT_USER, userId: AGENT_USER,
  recipientName: "Dana Rivera", mailingAddress: "", city: "", state: "", zip: "", recipientFirstName: "Dana", recipientLastName: "Rivera",
  recipientEmail: "dana.rivera@example.test", recipientPhone: "+18505550101", qrScanUrl: "https://qr.tenant.invalid/q/abc", systemSource: "crm_contact_bundle_send",
})

async function main() {
  const bundleMod = await import("../lib/direct-mail/orchestrate-bundle-send")
  const route = await import("../app/api/cron/queue-drain/route")
  const runDrain = async () => { H.cron.success = null; const res = await route.GET(new Request("http://localhost/api/cron/queue-drain")); return { status: res.status, body: await res.json() as any } }

  // ══ A ═══════════════════════════════════════════════════════════════════════════════════════════════════════
  section("A · the click sends the FIRST item and persists the next — never the whole bundle at once")
  const db = freshDb(); reset(db)
  const b1 = seedBundle(db, [{ channel: "email", preset_id: P.email }, { channel: "sms", preset_id: P.sms }, { channel: "direct_mail_postcard", preset_id: P.mail }])
  const r = await bundleMod.orchestrateBundleSend(clickArgs(b1.bundleId))
  check("the click sends exactly ONE piece (the first item, email) — the old single pass fired all three", H.sends.length === 1 && H.sends[0].channel === "email", JSON.stringify(H.sends.map((s) => s.channel)))
  check("the result says the next piece (sms) is persisted and 2 remain", r.ok === true && r.followOn?.scheduled === true && r.followOn.channel === "sms" && r.followOn.remaining === 2, JSON.stringify(r.followOn))
  const d1 = r.bundleDispatchId as string
  const root = tasks(db, d1).find((t) => t.payload.bundle_item_id === b1.itemIds[0])
  const next = tasks(db, d1).find((t) => t.payload.bundle_item_id === b1.itemIds[1])
  check("the first item's record is terminal evidence (completed, its provider id on the outcome)", root?.status === "completed" && typeof root.payload.outcome?.message_id === "string")
  check("the follow-on is PENDING on orchestrator_tasks with origin item, dependency, audience, timing policy, governance and expected evidence",
    next?.status === "pending" && next.payload.origin_item_id === b1.itemIds[0] && JSON.stringify(next.payload.depends_on) === JSON.stringify([b1.itemIds[0]]) &&
      next.payload.audience.contact_id === C1 && next.payload.timing.policy === "arbiter" && next.payload.timing.person_facing === true &&
      /arbitratePlannedTouch\(sms\)/.test(next.payload.governance.contact_engagement) && next.payload.expected_evidence.length > 0 && next.brokerage_id === B)
  check("the idempotency key names the dispatch and the item", next?.payload.idempotency_key === `bundle_follow_on:${d1}:${b1.itemIds[1]}`)
  const payloadText = JSON.stringify(tasks(db, d1).map((t) => t.payload))
  check("ADVERSE (PII): no task payload carries the contact's name, email or phone — ids and channel keys only", !/dana|rivera|example\.test|8505550101/i.test(payloadText))
  check("POSITIVE CONTROL: the PII finder sees the email when it is present", /example\.test/i.test(JSON.stringify({ e: "dana.rivera@example.test" })))
  const dispRow = db.tables.campaign_bundle_dispatches.find((d) => d.id === d1)
  check("the dispatch's channel_outcomes keeps the rollup's per-channel key AND a per-item entry", dispRow?.channel_outcomes?.email?.success === true && dispRow?.channel_outcomes?.items?.[b1.itemIds[0]]?.status === "completed")
  const dupe = await (async () => { const before = tasks(db, d1).length; await bundleMod.recoverStaleBundleFollowOns(db); return tasks(db, d1).length === before })()
  check("nothing is stale right after the click (recovery touches nothing)", dupe)

  // ══ B ═══════════════════════════════════════════════════════════════════════════════════════════════════════
  section("B · the REAL queue-drain route runs each follow-on through the arbiter and the orchestrator, then chains")
  const t1 = await runDrain()
  check("tick 1: the route answers 200 and counts one completed bundle task", t1.status === 200 && t1.body?.queues?.orchestrator_tasks?.completed === 1, JSON.stringify(t1.body?.queues?.orchestrator_tasks))
  check("tick 1: the SMS piece went out once, after the arbiter was asked for THIS person on the sms channel",
    H.sends.length === 2 && H.sends[1].channel === "sms" && H.sends[1].args.toPhone === "+18505550101" && H.arbCalls.length === 1 &&
      H.arbCalls[0].input.subject?.id === C1 && JSON.stringify(H.arbCalls[0].input.requiredChannels) === JSON.stringify(["sms"]) && H.arbCalls[0].input.planner === "bundle_follow_on")
  const smsTask = tasks(db, d1).find((t) => t.payload.bundle_item_id === b1.itemIds[1])
  check("tick 1: the sms task is completed with its provider id and the arbiter's decision on the evidence", smsTask?.status === "completed" && smsTask.payload.outcome?.decision?.kind === "send_now" && !!smsTask.executed_at && smsTask.attempts === 1)
  check("tick 1: the next item (postcard) is persisted pending with the sms item as its origin", pendingOf(db, d1).length === 1 && pendingOf(db, d1)[0].payload.origin_item_id === b1.itemIds[1])
  await runDrain()
  check("tick 2: the postcard went out once, addressed from the LIVE contact row (resolved at send time, never stored)", H.sends.length === 3 && H.sends[2].channel === "direct_mail" && H.sends[2].args.zip === "32571" && H.sends[2].args.qrScanUrl === "https://qr.tenant.invalid/q/abc")
  check("tick 2: the last item leaves nothing pending — the chain is complete (3 records, all completed)", pendingOf(db, d1).length === 0 && tasks(db, d1).length === 3 && tasks(db, d1).every((t) => t.status === "completed"))
  await runDrain(); await runDrain()
  check("ADVERSE (double event / replayed tick): two more ticks send nothing", H.sends.length === 3)
  check("the cron run recorded its counts (the route's own evidence)", H.cron.success?.metadata?.orchestrator_tasks !== undefined)

  // ══ C ═══════════════════════════════════════════════════════════════════════════════════════════════════════
  section("C · adverse paths — every one resolves without a second send")
  const one = async (items: Array<{ channel: string; preset_id: string }>, contactId = C1) => {
    const bx = seedBundle(db, items)
    const rx = await bundleMod.orchestrateBundleSend(clickArgs(bx.bundleId, contactId))
    return { ...bx, dispatchId: rx.bundleDispatchId as string }
  }
  const drainOne = async (dispatchId: string, deps: Parameters<typeof bundleMod.executeBundleFollowOnTask>[2] = {}) => {
    const t = pendingOf(db, dispatchId)[0]
    return t ? bundleMod.executeBundleFollowOnTask(db, { id: t.id }, deps) : { verdict: "none" as const, reason: "no pending task" }
  }

  // C1 — the arbiter waits
  reset(db)
  const w = await one([{ channel: "email", preset_id: P.email }, { channel: "sms", preset_id: P.sms }])
  H.arbitrate = () => ({ choice: "wait", decision: { kind: "wait", waitHours: 6, rationale: "they asked for evenings" }, halt: null })
  const wv = await drainOne(w.dispatchId)
  const wt = tasks(db, w.dispatchId).find((t) => t.payload.bundle_item_id === w.itemIds[1])
  check("arbiter WAIT: nothing sent, the task is pending again with scheduled_for ~6h out and the wait counted", wv.verdict === "waiting" && H.sends.length === 1 && wt?.status === "pending" && Date.parse(wt.scheduled_for) > Date.now() + 5 * 3_600_000 && wt.payload.timing.arbiter_waits === 1)
  await runDrain()
  check("a tick before the held moment does not send it", H.sends.length === 1 && tasks(db, w.dispatchId).find((t) => t.payload.bundle_item_id === w.itemIds[1])?.status === "pending")
  wt!.scheduled_for = new Date(Date.now() - 60_000).toISOString()
  H.arbitrate = () => ({ choice: "send_now", decision: { kind: "send_now", waitHours: null, rationale: "evening now" }, halt: null })
  await runDrain()
  check("once due, the arbiter is asked again and the piece goes once", H.sends.length === 2 && H.sends[1].channel === "sms" && tasks(db, w.dispatchId).find((t) => t.payload.bundle_item_id === w.itemIds[1])?.status === "completed")

  // C2 — suppressed Contact on this channel (halt) → cancelled, the chain continues
  reset(db)
  const s = await one([{ channel: "email", preset_id: P.email }, { channel: "sms", preset_id: P.sms }, { channel: "email", preset_id: P.email2 }])
  H.arbitrate = (input: any) => input.requiredChannels?.[0] === "sms"
    ? { choice: "send_now", decision: { kind: "send_now", waitHours: null, rationale: "-" }, halt: { reason: "no_lawful_channel" } }
    : { choice: "send_now", decision: { kind: "send_now", waitHours: null, rationale: "ok" }, halt: null }
  const sv = await drainOne(s.dispatchId)
  check("SUPPRESSED (no lawful sms channel): the sms piece is cancelled, never sent", sv.verdict === "cancelled" && H.sends.length === 1 && /no lawful/.test(tasks(db, s.dispatchId).find((t) => t.payload.bundle_item_id === s.itemIds[1])?.last_error ?? ""))
  check("…and the chain continues to the next lawful piece (the second email is pending)", pendingOf(db, s.dispatchId).length === 1 && pendingOf(db, s.dispatchId)[0].payload.bundle_item_id === s.itemIds[2])
  await drainOne(s.dispatchId)
  const dispS = db.tables.campaign_bundle_dispatches.find((d) => d.id === s.dispatchId)
  check("two pieces on ONE channel are both recorded per item; the channel key keeps the first success", H.sends.length === 2 && dispS?.channel_outcomes?.items?.[s.itemIds[0]]?.success === true && dispS?.channel_outcomes?.items?.[s.itemIds[2]]?.success === true && dispS?.channel_outcomes?.items?.[s.itemIds[1]]?.status === "cancelled")

  // C3 — bundle deactivated mid-chain → the chain stops
  reset(db)
  const dz = await one([{ channel: "email", preset_id: P.email }, { channel: "sms", preset_id: P.sms }, { channel: "direct_mail_postcard", preset_id: P.mail }])
  db.tables.campaign_bundles.find((x) => x.id === dz.bundleId)!.is_active = false
  const dzv = await drainOne(dz.dispatchId)
  check("DEACTIVATED bundle: the pending piece is cancelled, nothing sent, no further item persisted", dzv.verdict === "cancelled" && H.sends.length === 1 && pendingOf(db, dz.dispatchId).length === 0 && tasks(db, dz.dispatchId).length === 2)

  // C4 — item removed after the send began → cancelled, chain continues
  reset(db)
  const rm = await one([{ channel: "email", preset_id: P.email }, { channel: "sms", preset_id: P.sms }, { channel: "direct_mail_postcard", preset_id: P.mail }])
  db.tables.campaign_bundle_items.splice(db.tables.campaign_bundle_items.findIndex((i) => i.id === rm.itemIds[1]), 1)
  const rmv = await drainOne(rm.dispatchId)
  check("REMOVED item: cancelled with the reason, nothing sent, the postcard is next", rmv.verdict === "cancelled" && H.sends.length === 1 && pendingOf(db, rm.dispatchId)[0]?.payload.bundle_item_id === rm.itemIds[2])

  // C5 — changed audience (contact removed) → the chain stops
  reset(db)
  const au = await one([{ channel: "email", preset_id: P.email }, { channel: "sms", preset_id: P.sms }], C2)
  db.tables.contacts.find((c) => c.id === C2)!.deleted_at = new Date().toISOString()
  const auv = await drainOne(au.dispatchId)
  check("CHANGED AUDIENCE (contact removed): cancelled, nothing sent, the chain stops", auv.verdict === "cancelled" && H.sends.length === 1 && pendingOf(db, au.dispatchId).length === 0)
  db.tables.contacts.find((c) => c.id === C2)!.deleted_at = null

  // C6 — provider failure → retried later, never twice; then failed and the chain moves on
  reset(db)
  const pf = await one([{ channel: "email", preset_id: P.email }, { channel: "sms", preset_id: P.sms }, { channel: "email", preset_id: P.email2 }])
  H.outcome.sms = () => ({ success: false, error: "provider 503 temporarily unavailable" })
  const pfv = await drainOne(pf.dispatchId)
  const pft = tasks(db, pf.dispatchId).find((t) => t.payload.bundle_item_id === pf.itemIds[1])!
  check("PROVIDER FAILURE: one attempt, the same piece rescheduled (deferral 1) — no next item yet", pfv.verdict === "retry" && H.sends.length === 2 && pft.status === "pending" && pft.payload.deferrals === 1 && Date.parse(pft.scheduled_for) > Date.now() && pendingOf(db, pf.dispatchId).length === 1)
  for (let i = 0; i < 4; i++) { pft.scheduled_for = new Date(Date.now() - 1000).toISOString(); if (pft.status === "pending") await bundleMod.executeBundleFollowOnTask(db, { id: pft.id }) }
  check("…after the deferral policy's cap the piece is FAILED (each attempt one send, never two at once) and the chain continues", pft.status === "failed" && H.sends.filter((x) => x.channel === "sms").length === 4 && pendingOf(db, pf.dispatchId)[0]?.payload.bundle_item_id === pf.itemIds[2], `sms sends ${H.sends.filter((x) => x.channel === "sms").length}, status ${pft.status}`)

  // C7 — a gate refusal is never retried
  reset(db)
  const gr = await one([{ channel: "email", preset_id: P.email }, { channel: "sms", preset_id: P.sms }])
  H.outcome.sms = () => ({ success: false, error: "contact opted out of sms" })
  const grv = await drainOne(gr.dispatchId)
  check("GATE REFUSAL (opted out): cancelled at once, never rescheduled", grv.verdict === "cancelled" && tasks(db, gr.dispatchId).find((t) => t.payload.bundle_item_id === gr.itemIds[1])?.status === "cancelled")

  // C8 — a throw mid-send is outcome unknown → failed, never re-sent
  reset(db)
  const th = await one([{ channel: "email", preset_id: P.email }, { channel: "sms", preset_id: P.sms }])
  H.outcome.sms = () => { throw new Error("socket hang up") }
  const thv = await drainOne(th.dispatchId)
  const tht = tasks(db, th.dispatchId).find((t) => t.payload.bundle_item_id === th.itemIds[1])!
  check("A THROW MID-SEND: failed 'outcome unknown', not rescheduled", thv.verdict === "failed" && tht.status === "failed" && /outcome unknown/.test(tht.last_error ?? ""))
  await runDrain()
  check("…and a later tick never re-sends it", H.sends.filter((x) => x.channel === "sms").length === 1)

  // C9 — two concurrent drains claim one task → one send
  reset(db)
  const cc = await one([{ channel: "email", preset_id: P.email }, { channel: "sms", preset_id: P.sms }])
  const ccTask = pendingOf(db, cc.dispatchId)[0]
  const [ra, rb] = await Promise.all([bundleMod.executeBundleFollowOnTask(db, { id: ccTask.id }), bundleMod.executeBundleFollowOnTask(db, { id: ccTask.id })])
  check("CONCURRENT DRAINS: exactly one sends, the other is skipped by the counted claim", H.sends.filter((x) => x.channel === "sms").length === 1 && [ra.verdict, rb.verdict].sort().join(",") === "sent,skipped", `${ra.verdict},${rb.verdict}`)

  // C10 — a stale claim is failed, never re-sent; the chain continues
  reset(db)
  const st = await one([{ channel: "email", preset_id: P.email }, { channel: "sms", preset_id: P.sms }, { channel: "email", preset_id: P.email2 }])
  const stTask = pendingOf(db, st.dispatchId)[0]
  stTask.status = "running"; stTask.updated_at = new Date(Date.now() - 30 * 60_000).toISOString()
  const rec = await bundleMod.recoverStaleBundleFollowOns(db)
  check("STALE CLAIM (drain died mid-send): failed 'outcome unknown', not re-sent, the next item persisted", rec.recovered === 1 && stTask.status === "failed" && /outcome unknown/.test(stTask.last_error ?? "") && H.sends.length === 1 && pendingOf(db, st.dispatchId)[0]?.payload.bundle_item_id === st.itemIds[2])
  const fresh = pendingOf(db, st.dispatchId)[0]; fresh.status = "running"; fresh.updated_at = new Date().toISOString()
  const rec2 = await bundleMod.recoverStaleBundleFollowOns(db)
  check("POSITIVE CONTROL: a claim still in flight (just now) is NOT touched", rec2.recovered === 0 && fresh.status === "running")
  fresh.status = "pending"

  // C11 — leads: a converted lead stops; a lead on a phone channel is skipped
  reset(db)
  const lb = seedBundle(db, [{ channel: "email", preset_id: P.email }, { channel: "sms", preset_id: P.sms }, { channel: "email", preset_id: P.email2 }])
  const lr = await bundleMod.orchestrateBundleSend({ ...clickArgs(lb.bundleId), contactId: undefined, leadId: LEAD, recipientPhone: null })
  const lv = await drainOne(lr.bundleDispatchId as string)
  check("LEAD on a phone channel: skipped (a lead is reached by email or mail only), the chain continues", lv.verdict === "cancelled" && H.sends.length === 1 && /email or mail only/.test(tasks(db, lr.bundleDispatchId as string).find((t) => t.payload.bundle_item_id === lb.itemIds[1])?.last_error ?? "") && pendingOf(db, lr.bundleDispatchId as string).length === 1)
  const lb2 = seedBundle(db, [{ channel: "email", preset_id: P.email }, { channel: "email", preset_id: P.email2 }])
  const lr2 = await bundleMod.orchestrateBundleSend({ ...clickArgs(lb2.bundleId), contactId: undefined, leadId: LEAD2, recipientEmail: "kim.ng@example.test" })
  const lv2 = await drainOne(lr2.bundleDispatchId as string)
  check("CONVERTED LEAD: the chain stops — the contact's own consent governs (conversion finality)", lv2.verdict === "cancelled" && /became a contact/.test(lv2.reason) && pendingOf(db, lr2.bundleDispatchId as string).length === 0)

  // C12 — an unrelated tenant's dispatch is never read across the tenant line
  reset(db)
  const xt = await one([{ channel: "email", preset_id: P.email }, { channel: "sms", preset_id: P.sms }])
  const xTask = pendingOf(db, xt.dispatchId)[0]
  db.tables.campaign_bundle_dispatches.find((d) => d.id === xt.dispatchId)!.brokerage_id = B2
  const xv = await bundleMod.executeBundleFollowOnTask(db, { id: xTask.id })
  check("UNRELATED TENANT: a task whose dispatch is another tenant's is refused (tenant-pinned read) and nothing is sent", xv.verdict === "cancelled" && H.sends.length === 1)

  // C13 — an audience piece (social) is not a Contact touch: no Contact arbiter, staged for its own approval gate
  reset(db)
  const so = await one([{ channel: "email", preset_id: P.email }, { channel: "social_post", preset_id: P.social }])
  const sov = await drainOne(so.dispatchId)
  check("AUDIENCE PIECE (social): staged through its orchestrator with NO Contact-arbiter call; the record names its own plane", sov.verdict === "sent" && H.arbCalls.length === 0 && H.sends[1].channel === "social_post" && /social approval gate/.test(tasks(db, so.dispatchId).find((t) => t.payload.bundle_item_id === so.itemIds[1])?.payload.governance.audience ?? ""))

  // C15 — the INJECTED-CLIENT path lane 153H's canary C5 drives (no service-client stub; a fresh client handed in):
  // complete an item → exactly ONE persisted follow-on → drained through the arbiter → a replay persists no second follow-on.
  {
    const c5 = freshDb()
    const c5Sends: string[] = []
    const seam = async (_s: unknown, item: { channel: string; preset_id: string | null }) => { c5Sends.push(item.channel); return { channel: item.channel, preset_id: item.preset_id, success: true, messageId: `c5-${c5Sends.length}` } }
    const cb5 = seedBundle(c5, [{ channel: "email", preset_id: P.email }, { channel: "sms", preset_id: P.sms }, { channel: "email", preset_id: P.email2 }])
    H.svc = null // prove nothing reaches the module-level client
    const r5 = await bundleMod.orchestrateBundleSend(clickArgs(cb5.bundleId), { client: c5 as never, dispatchItem: seam as never })
    const pend5 = c5.tables.orchestrator_tasks.filter((t) => t.status === "pending")
    check("C5 shape · the click on an INJECTED client persists exactly ONE pending follow-on (and sent one piece)", r5.ok && pend5.length === 1 && c5Sends.length === 1)
    let asked = 0
    const v5 = await bundleMod.executeBundleFollowOnTask(c5 as never, { id: pend5[0].id }, { dispatchItem: seam as never, arbitrate: async (_s, input) => { asked++; return { choice: "send_now", decision: { kind: "send_now", waitHours: null, rationale: `ok for ${String((input as any).planner)}` }, halt: null } } })
    check("C5 shape · the follow-on drains through the arbiter seam and sends once, persisting the NEXT follow-on", v5.verdict === "sent" && asked === 1 && c5Sends.length === 2 && c5.tables.orchestrator_tasks.filter((t) => t.status === "pending").length === 1)
    const replay = await bundleMod.executeBundleFollowOnTask(c5 as never, { id: pend5[0].id }, { dispatchItem: seam as never })
    check("C5 shape · a replayed completion is skipped and persists NO second follow-on", replay.verdict === "skipped" && c5Sends.length === 2 && c5.tables.orchestrator_tasks.length === 3)
    H.svc = db
  }

  // C14 — the persist is idempotent (pre-read + the modelled m931 UNIQUE)
  reset(db)
  const id1 = await one([{ channel: "email", preset_id: P.email }, { channel: "sms", preset_id: P.sms }])
  const before = tasks(db, id1.dispatchId).length
  const pend = pendingOf(db, id1.dispatchId)[0]
  const clone = { ...pend, id: randomUUID() }
  const ins = await db.from("orchestrator_tasks").insert(clone)
  check("IDEMPOTENCY: a second row with the same key is refused 23505 (m931's partial UNIQUE, modelled)", (ins as any).error?.code === "23505" && tasks(db, id1.dispatchId).length === before)

  // ══ D ═══════════════════════════════════════════════════════════════════════════════════════════════════════
  section("D · the stable item identity — an edit keeps kept items' ids")
  const { upsertCampaignBundle } = await import("../app/actions/campaign-bundles")
  reset(db)
  H.session = { brokerageId: B, agentScopeId: AGENT }
  const ed = seedBundle(db, [{ channel: "email", preset_id: P.email }, { channel: "sms", preset_id: P.sms }, { channel: "direct_mail_postcard", preset_id: P.mail }])
  const up = await upsertCampaignBundle({ id: ed.bundleId, name: "Edited", scope_type: "brokerage", scope_id: B, items: [
    { channel: "direct_mail_postcard", preset_id: P.mail, order_index: 0, send_after_minutes: 0 },
    { channel: "email", preset_id: P.email, order_index: 1, send_after_minutes: 0 },
    { channel: "social_post", preset_id: P.social, order_index: 2, send_after_minutes: 0 },
  ] })
  const after = db.tables.campaign_bundle_items.filter((i) => i.bundle_id === ed.bundleId)
  const byPiece = (ch: string) => after.find((i) => i.channel === ch)
  check("the edit succeeds", up.success === true, up.error)
  check("KEPT pieces keep their ids and take their new order (postcard 0, email 1)", byPiece("direct_mail_postcard")?.id === ed.itemIds[2] && byPiece("direct_mail_postcard")?.order_index === 0 && byPiece("email")?.id === ed.itemIds[0] && byPiece("email")?.order_index === 1)
  check("the REMOVED piece (sms) is deleted; the NEW piece (social) is inserted with a new id", !byPiece("sms") && !!byPiece("social_post") && !ed.itemIds.includes(byPiece("social_post")!.id) && after.length === 3)
  const foreign = seedBundle(db, [{ channel: "email", preset_id: P.email }], { brokerageId: B2 })
  const upX = await upsertCampaignBundle({ id: foreign.bundleId, name: "Steal", items: [{ channel: "sms", preset_id: P.sms, order_index: 0, send_after_minutes: 0 }] })
  check("ADVERSE: another tenant's bundle is refused and its items are untouched", upX.success === false && db.tables.campaign_bundle_items.filter((i) => i.bundle_id === foreign.bundleId).length === 1 && db.tables.campaign_bundle_items.find((i) => i.bundle_id === foreign.bundleId)?.channel === "email")

  // ══ E ═══════════════════════════════════════════════════════════════════════════════════════════════════════
  section("E · wiring — stripped source, each absence with a positive control")
  const qd = code("app/api/cron/queue-drain/route.ts")
  const routeIdx = qd.indexOf("bundleFollowOns.BUNDLE_FOLLOW_ON_TASK")
  const fallbackIdx = qd.indexOf("no executor registered for task_type")
  check("queue-drain hands BUNDLE_FOLLOW_ON_TASK to executeBundleFollowOnTask BEFORE the 'no executor registered' fallback", routeIdx > 0 && fallbackIdx > routeIdx && /bundleFollowOns\.executeBundleFollowOnTask\(supabase, task\)/.test(qd))
  check("queue-drain runs the stale-claim recovery once per tick", /bundleFollowOns\.recoverStaleBundleFollowOns\(supabase\)/.test(qd))
  check("queue-drain is a scheduled cron (lib/kernel/cron-dispatch.ts)", /"\/api\/cron\/queue-drain"\s*,\s*schedule:\s*"[^"]+"/.test(code("lib/kernel/cron-dispatch.ts")))
  const ob = code("lib/direct-mail/orchestrate-bundle-send.ts")
  const clickBody = ob.slice(ob.indexOf("export async function orchestrateBundleSend"), ob.indexOf("export async function executeBundleFollowOnTask"))
  check("the click no longer loops every item through a sender (the single synchronous pass is gone)", !/for\s*\(\s*const\s+item\s+of\s+items\s*\)/.test(clickBody) && /dispatchBundleItem\)?\(svc,\s*first,/.test(clickBody))
  check("POSITIVE CONTROL: the loop finder sees the old shape", /for\s*\(\s*const\s+item\s+of\s+items\s*\)/.test("for (const item of items) {"))
  check("a person-facing follow-on asks arbitratePlannedTouch with the item's channel as requiredChannels", /requiredChannels:\s*\[arbiterChannel\]/.test(ob) && /planner:\s*"bundle_follow_on"/.test(ob))
  check("the follow-on timing never reads the stored send_after_minutes (owner ruling: order only, the arbiter times it)", !/send_after_minutes/.test(ob))
  const cb = code("app/actions/campaign-bundles.ts")
  check("upsertCampaignBundle no longer deletes every item by bundle_id alone on an edit", !/from\("campaign_bundle_items"\)\.delete\(\)\.eq\("bundle_id",\s*bundleId\)\s*\n/.test(cb) && /syncBundleItems\(svc,\s*brokerageId,\s*bundleId,\s*input\.items\)/.test(cb))
  // The RULE, not the waypoint (CLAUDE.md §2): line 1 is the lane's WRITTEN line until applied, then the integrator's APPLIED LIVE stamp.
  check("the m931 migration exists with a status line (the WRITTEN header or the APPLIED LIVE stamp for lane 153I) and the partial UNIQUE on the idempotency key",
    /^-- (?:WRITTEN, NOT APPLIED \(wave 153, lane 153I\) — the integrator applies via Supabase MCP; DROP INDEX \/ DROP COLUMN and storage\.objects policies are owner SQL|── APPLIED LIVE \d{4}-\d{2}-\d{2} via Supabase MCP \(project hrvaqgvukzxfskkcrwbt\) — wave 153, lane 153I ── read back: \S[^\n]*)\n/.test(raw("supabase/migrations/m931-bundle-follow-ons-ride-the-orchestrator-queue-once.sql")) &&
      /CREATE UNIQUE INDEX IF NOT EXISTS orchestrator_tasks_bundle_follow_on_key[\s\S]*\(\(payload->>'idempotency_key'\)\)[\s\S]*WHERE task_type = 'bundle_follow_on'/.test(raw("supabase/migrations/m931-bundle-follow-ons-ride-the-orchestrator-queue-once.sql")))

  console.log("\n BLIND SPOTS: the nine channel orchestrators and the arbiter are SEAMS here (each has its own proof: test:egress-send-guard / test:direct-mail-rendering / test:arbiter-timing); RLS is not modelled (every read is tenant-pinned in code and asserted with an unrelated-tenant case); the m931 UNIQUE is modelled by the in-memory client here (applied live 2026-11-16, read back by the integrator); a deferral re-check after a refused READ (hold) is driven only through the provider-refusal path; the route's other five queues run against empty tables; no live send, no live database.")
  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ CAMPAIGN_BUNDLE_FOLLOW_ON_FAIL\n" + fails.map((f) => `   - ${f}`).join("\n")); process.exit(1) }
  console.log(" ✅ CAMPAIGN_BUNDLE_FOLLOW_ON_OK")
}

main().catch((e) => { console.error(e); process.exit(1) })
