#!/usr/bin/env tsx
/**
 * scripts/next-action-follow-on-guard.ts   (npm run test:next-action-follow-on) — in memory, no DB, no network. SIMULATED.
 * ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 * WAVE 154, LANE 154H — owner ruling R8, directive H7 / H8 / H9 / H11: the arbiter chooses ACTION + CHANNEL + ARTIFACT + MANAGER,
 * and every follow-on is DURABLE work started by a real trigger. Drives the REAL survivors over scripts/in-memory-supabase.ts:
 *   · lib/sphere/lifetime-touch-arbitration.ts arbitrateLifetimeTouch → lib/ai-isa/followup-arbiter.ts arbitratePlannedTouch (the
 *     model is never asked outside the app server — the planner's fallback decides, ledgered), settleLifetimeTouchSend,
 *     executeLifetimeFollowOn, recoverStaleLifetimeFollowOns;
 *   · lib/ai-isa/followup-arbiter.ts derivePersonTiming / screenNextActionCandidates / normalizeProviderEvidence / evidenceFires /
 *     supersedeFollowOnsForPerson (the reactor's reply / opt-out consumer);
 *   · lib/direct-mail/orchestrate-bundle-send.ts orchestrateBundleSend + executeBundleFollowOnTask (reply wins; author spacing is
 *     guidance; the campaign reaches the SMS piece);
 *   · app/api/cron/publish-social-posts/route.ts GET — the real cron route (the author's seat is re-checked at egress).
 * SEAMS (counted, never live): the greeting send, the video request, the agent task, the bundle channel orchestrators, the social
 * publisher. Every provider is an injected seam that COUNTS calls.
 *
 *   A. THE DECISION CONTRACT — one truthful anniversary → a channel / artifact choice, a durable action, a next trigger; a stated
 *      preference, an opted-out channel, an active agent conversation, an unavailable video and fatigue each change the outcome.
 *   B. EVIDENCE — accepted / delivered / opened / clicked / replied / bounced / failed / unknown never interchanged or upgraded.
 *   C. THE DURABLE FOLLOW-ON — every H8 field, no PII; idempotent (pre-read and the modelled m974 unique index); a refused send
 *      persists nothing; the reply-watch ends deliberately on silence; a bounce chooses the agent; unknown is reconciled, not resent.
 *   D. REPLY / OPT-OUT / RACE / RESTART — a reply consumes the watch and cancels stale bundle pieces (another person's and another
 *      tenant's untouched); a delayed reply caught at execution; two concurrent drains → one claim; a stale claim re-queued and the
 *      re-run sends nothing twice; a wrong-tenant payload fires nothing; a revoked seat suspends.
 *   E. THE VIDEO PATH — the Asset Manager request, never the email beside it; delivered → the reply watch; failed or late → exactly
 *      one authorized alternate under the same attribution (the late render is suppressed first); latency — the door returns while
 *      the render is still queued.
 *   F. BUNDLES — a reply since the bundle began stops the stale chain; send_after_minutes reaches the arbiter as guidance; the
 *      campaign id reaches the SMS piece.
 *   G. THE SOCIAL PUBLISH SEAT CHECK — a revoked / removed / moved author's post is held at egress, an active author's post proceeds,
 *      an unreadable seat holds the post scheduled.
 *   H. WIRING (stripped source, each absence with a POSITIVE CONTROL).
 */
import { registerHooks } from "node:module"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { stripComments } from "./strip-comments"
import { memSupabase, type MemClient, type Row } from "./in-memory-supabase"

// ── module seams (only modules the proof never needs for real) ──────────────────────────────────────────────────────────────
const G = {
  svc: null as MemClient | null,
  published: [] as string[],
}
;(globalThis as any).__N154 = G
const STUBS: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => { const s = globalThis.__N154.svc; if (!s) throw new Error('no client'); return s }",
  "@/lib/kernel/write-sentinel": "export async function sentinelWrite(_s, p){ return await p }",
  "next/server": "export const NextResponse = { json: (b, i) => ({ status: (i && i.status) || 200, body: b, json: async () => b }) }",
  "@/app/actions/cron-kernel": "export async function createCronRunContextAction(){ return { success: true, data: { context_id: 'ctx-154h' } } }; export async function recordCronStartAction(){ return { success: true } }; export async function recordCronSuccessAction(){ return { success: true } }; export async function recordCronFailureAction(){ return { success: true } }",
  "@/lib/cron-auth": "export const verifyCronAuth = () => null",
  "@/lib/social/publisher": "export async function publishToSocialPlatform(a){ globalThis.__N154.published.push(String((a && (a.postId || (a.post && a.post.id))) || 'post')); return { success: true, externalPostId: 'ext-' + globalThis.__N154.published.length } }",
  "@/lib/kernel/brand-compliance": "export async function checkBrandCompliance(){ return { passed: true, violations: [] } }",
  "@/lib/social/assemble-disclosures": "export async function assembleSocialDisclosures(){ return { lines: [] } }; export function appendDisclosures(c){ return c }",
  "@/lib/security/secret-crypto": "export function decryptSecret(v){ return v }; export function decryptSecretFields(o){ return o }",
  "@/lib/video/youtube-publish": "export async function sweepYouTubeBackfill(){ return { queued: 0, tenants: 0, notes: [] } }; export async function resolveYouTubePrivacy(){ return 'private' }; export async function recordYouTubePublishOnAsset(){}",
  "@/lib/marketing/humanize-final": "export async function recordDoorPublication(){}",
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

const B = randomUUID(), B2 = randomUUID(), AGENT = randomUUID(), AGENT_USER = randomUUID(), TXN = randomUUID()
const C = { base: randomUUID(), pref: randomUUID(), hist: randomUUID(), opt: randomUUID(), optPortal: randomUUID(), human: randomUUID(), novideo: randomUUID(), fatigue: randomUUID(), other: randomUUID(), vid: randomUUID(), vidFail: randomUUID(), vidLate: randomUUID() }
const NOW = new Date("2026-11-16T15:00:00.000Z")
const ago = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString()
const contact = (id: string, extra: Row = {}): Row => ({ id, brokerage_id: B, first_name: "Pat", last_name: "Rivera", email: `${id.slice(0, 6)}@example.test`, phone: "+18505550100", tcpa_consent: true, email_opt_out: false, email_unsubscribed: false, sms_opt_out: false, phone_opt_out: false, dnc_status: false, has_login: true, video_opt_out: false, deleted_at: null, preferred_contact_time: null, time_zone: null, ...extra })

function freshDb(extra: Record<string, Row[]> = {}, opts: Parameters<typeof memSupabase>[1] = {}): MemClient {
  return memSupabase({
    brokerages: [{ id: B, plan_tier: "solo" }, { id: B2, plan_tier: "solo" }],
    agents: [{ id: AGENT, brokerage_id: B, user_id: AGENT_USER }],
    users: [{ id: AGENT_USER, brokerage_id: B, user_type: "agent", location_id: null, status: "active", deleted_at: null }],
    agent_voice_profiles: [{ id: randomUUID(), agent_id: AGENT, brokerage_id: B, elevenlabs_voice_id: "voice-1", did_photo_url: "https://storage.example.test/a.png", did_video_url: null }],
    contacts: [
      contact(C.base), contact(C.pref, { preferred_contact_time: "evenings, after work", time_zone: "America/Chicago" }),
      contact(C.hist, { time_zone: "America/New_York" }), contact(C.opt, { email_opt_out: true, has_login: false }),
      contact(C.optPortal, { email_opt_out: true }), contact(C.human), contact(C.novideo, { video_opt_out: true }), contact(C.fatigue),
      contact(C.other), contact(C.vid), contact(C.vidFail), contact(C.vidLate),
    ],
    messages: [
      { id: "h1", brokerage_id: B, contact_id: C.human, direction: "outbound", sender_type: "agent", type: "sms", created_at: ago(10) },
      // three of C.hist's own replies, all at 14:xx New York time, weeks ago (history, not a live conversation)
      { id: "r1", brokerage_id: B, contact_id: C.hist, direction: "inbound", sender_type: "contact", type: "sms", created_at: "2026-10-01T18:10:00.000Z" },
      { id: "r2", brokerage_id: B, contact_id: C.hist, direction: "inbound", sender_type: "contact", type: "sms", created_at: "2026-10-08T18:40:00.000Z" },
      { id: "r3", brokerage_id: B, contact_id: C.hist, direction: "inbound", sender_type: "contact", type: "email", created_at: "2026-10-15T18:05:00.000Z" },
    ],
    buyer_fatigue_scores: [{ brokerage_id: B, contact_id: C.fatigue, risk_level: "high", last_calculated_at: ago(60) }],
    lifetime_customer_touchpoints: [], agent_intro_videos: [], orchestrator_tasks: [], agent_action_ledger: [], activities: [],
    ...extra,
  }, { stampCreatedAt: true, uuidIds: true, unique: { orchestrator_tasks: [["payload->>idempotency_key"]] }, ...opts })
}

type Counted = { sends: Array<{ contactId: string; key: string }>; videos: string[]; tasks: string[] }
function seams(svc: MemClient, ledger = new Set<string>()) {
  const c: Counted = { sends: [], videos: [], tasks: [] }
  return {
    c,
    routeToAgent: async (_s: unknown, a: { contactId: string }) => { c.tasks.push(a.contactId); return true },
    requestVideo: async (_s: unknown, a: { brokerageId: string; contactId: string; agentId: string; yearsAgo: number }) => {
      c.videos.push(a.contactId)
      const id = randomUUID()
      svc.tables.agent_intro_videos.push({ id, brokerage_id: a.brokerageId, contact_id: a.contactId, agent_id: a.agentId, trigger: "home_anniversary", trigger_year: NOW.getUTCFullYear(), delivery_channel: "portal", status: "rendering", video_project_id: randomUUID() })
      return { ok: true, status: "queued", introVideoId: id }
    },
    // the email gate's per-milestone-year ledger cycle (home_anniversary:year_N): an executed cycle REPLAYS, never sends twice
    sendGreeting: async (_s: unknown, p: { subject_id: string; origin?: { years_ago?: number | null } }) => {
      const key = `${p.subject_id}:home_anniversary:year_${p.origin?.years_ago ?? "?"}`
      if (ledger.has(key)) return { success: true, messageId: "replayed" }
      ledger.add(key); c.sends.push({ contactId: p.subject_id, key }); return { success: true, messageId: `prov-${c.sends.length}` }
    },
  }
}

async function main() {
  const fa = await import("../lib/ai-isa/followup-arbiter")
  const lt = await import("../lib/sphere/lifetime-touch-arbitration")
  const base = (contactId: string, extra: Partial<Parameters<typeof lt.arbitrateLifetimeTouch>[1]> = {}) => ({ brokerageId: B, contactId, agentId: AGENT, kind: "anniversary" as const, channel: "email" as const, yearsAgo: 3, transactionId: TXN, now: NOW, ...extra })

  // ── A ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section("A — THE DECISION CONTRACT (the real door; the model is not asked outside the app server)")
  {
    const svc = freshDb(); const s = seams(svc)
    const d = await lt.arbitrateLifetimeTouch(svc as never, base(C.base), { routeToAgent: s.routeToAgent, requestVideo: s.requestVideo })
    check("POSITIVE: a consented past client's anniversary → the warm greeting (the planner's cheapest eligible option stands)", d.verdict === "send" && d.plan?.send === true && d.plan.video === false, `${d.verdict}: ${d.reason}`)
    const r = d.record
    check("the record names WHY NOW (event, source evidence, causal parent, tenant, recipient, objective)", !!r && r.whyNow.type === "anniversary_triggered" && r.whyNow.causalParent === TXN && r.whyNow.brokerageId === B && r.whyNow.recipient.id === C.base && r.whyNow.version === 3)
    check("…WHO OWNS IT (registered manager, responsible seat, conversation owner, supporting managers)", !!r && r.owner.manager === "sphere_of_influence" && r.owner.responsibleSeat === AGENT && r.owner.conversationOwner.owner === "ai" && r.owner.supporting.includes("asset_manager"))
    check("…WHAT, ON WHICH CHANNEL, WITH WHICH ARTIFACT (send · email · a written message composed at the gated send door)", !!r && r.action.verb === "send" && r.action.channels.join() === "email" && r.action.artifact?.format === "written_message" && r.action.artifact.readiness === "composed_at_send")
    check("…and NEXT: a reply-watch follow-on, not an orphan", !!r && r.next.kind === "follow_on" && r.next.trigger === "timer_due" && r.next.waitsFor.includes("recipient_replied"))
    check("the avatar greeting was ELIGIBLE (portal sign-in, voice + avatar on file) and recorded as deferred, not silently dropped", !!r && r.deferred.some((x) => x.id === "avatar_greeting") && !r.refused.some((x) => x.id === "avatar_greeting"))
    check("ONE choice — the door never sends all of them (no video requested, no agent task beside the greeting)", s.c.videos.length === 0 && s.c.tasks.length === 0)
    const row = svc.tables.agent_action_ledger.find((x) => x.system_source === "lifetime_touch" && x.subject_id === C.base)
    const na = row?.detail?.next_action
    check("the record is PERSISTED on the door's own decision ledger row (detail.next_action: candidates' gates, refused / deferred, next by option)", !!na && na.contract === "next_action/v1" && !!na.next_by_option?.avatar_greeting && na.next_by_option.agent_personally?.kind === "no_follow_on" && Array.isArray(na.autonomy?.gates) && na.autonomy.gates.length >= 8, JSON.stringify(na ?? row?.detail ?? null).slice(0, 300))
    check("WHEN: no stated preference and no reply history → `evidence_now` (no generic interval)", !!r && r.when.basis === "evidence_now")
  }
  {
    const svc = freshDb(); const s = seams(svc)
    const d = await lt.arbitrateLifetimeTouch(svc as never, base(C.pref), { routeToAgent: s.routeToAgent, requestVideo: s.requestVideo })
    check("A DIFFERENT PREFERENCE → a different outcome: they asked for evenings (Chicago, 09:00 now) → HELD until their window, persisted", d.verdict === "wait" && (svc.tables.lifetime_customer_touchpoints ?? []).some((x) => x.contact_id === C.pref && x.status === "scheduled"), `${d.verdict}: ${d.reason}`)
    check("…and WHEN reads `stated_preference` with the window placed in their time zone", d.record?.when.basis === "stated_preference" && d.record.when.window?.start === 17 && d.record.when.earliestAt > NOW.toISOString(), JSON.stringify(d.record?.when))
  }
  {
    const svc = freshDb(); const s = seams(svc)
    const d = await lt.arbitrateLifetimeTouch(svc as never, base(C.hist), { routeToAgent: s.routeToAgent, requestVideo: s.requestVideo })
    check("NO stated preference but THREE of their own replies at 14:xx New York → WHEN is `interaction_history` around 14:00", d.record?.when.basis === "interaction_history" && d.record.when.window?.start === 14, JSON.stringify(d.record?.when))
  }
  {
    const svc = freshDb(); const s = seams(svc)
    const d = await lt.arbitrateLifetimeTouch(svc as never, base(C.opt), { routeToAgent: s.routeToAgent, requestVideo: s.requestVideo })
    check("AN OPTED-OUT CHANNEL (email opted out, no portal) → HALTED at the door — nothing sent, nothing requested", d.verdict === "halt" && /email/.test(d.reason) && s.c.videos.length === 0 && s.c.tasks.length === 0, `${d.verdict}: ${d.reason}`)
    const d2 = await lt.arbitrateLifetimeTouch(svc as never, base(C.optPortal), { routeToAgent: s.routeToAgent, requestVideo: s.requestVideo })
    check("email opted out BUT a portal sign-in → the email options are REFUSED with the consent reason; the agent task is chosen (cheapest eligible)", d2.verdict === "agent" && d2.routed && !!d2.record?.refused.find((x) => x.id === "send_now" && x.why.some((w) => /consent/.test(w))) && !d2.record.refused.some((x) => x.id === "avatar_greeting"), `${d2.verdict}: ${JSON.stringify(d2.record?.refused)}`)
  }
  {
    const svc = freshDb(); const s = seams(svc)
    const d = await lt.arbitrateLifetimeTouch(svc as never, base(C.human), { routeToAgent: s.routeToAgent, requestVideo: s.requestVideo })
    check("AN ACTIVE AGENT CONVERSATION (a person wrote 10 minutes ago) → HELD with no model call; nothing automated competes", d.verdict === "wait" && d.source === "deterministic" && s.c.videos.length === 0, `${d.verdict}/${d.source}`)
    check("…and the record says a person owns the conversation", d.record?.owner.conversationOwner.owner === "human")
  }
  {
    const svc = freshDb(); const s = seams(svc)
    const d = await lt.arbitrateLifetimeTouch(svc as never, base(C.novideo), { routeToAgent: s.routeToAgent, requestVideo: s.requestVideo })
    check("AN UNAVAILABLE VIDEO (they opted out of video) → the avatar option is REFUSED with the reason; the greeting goes", d.verdict === "send" && !!d.record?.refused.find((x) => x.id === "avatar_greeting" && x.why.some((w) => /opted out of video/.test(w))))
    const svc2 = freshDb({ agent_voice_profiles: [] })
    const d2 = await lt.arbitrateLifetimeTouch(svc2 as never, base(C.base), { routeToAgent: s.routeToAgent, requestVideo: s.requestVideo })
    check("no recorded voice / avatar for the agent → the avatar option is refused (licensing gate) — an unrendered asset is never promised", !!d2.record?.refused.find((x) => x.id === "avatar_greeting" && x.why.some((w) => /licensing/.test(w))))
  }
  {
    const svc = freshDb(); const s = seams(svc)
    const d = await lt.arbitrateLifetimeTouch(svc as never, base(C.fatigue, { agentId: null }), { routeToAgent: s.routeToAgent, requestVideo: s.requestVideo })
    check("FATIGUE high and no agent → an explicit, ledgered `no_action` (silence is a recorded answer, not a gap)", d.verdict === "no_action" && d.record?.action.verb === "no_action" && d.record.next.kind === "no_follow_on" && svc.tables.agent_action_ledger.some((x) => x.subject_id === C.fatigue && x.detail?.next_action), `${d.verdict}: ${d.reason}`)
  }
  {
    // the screener is pure: positive control that it refuses what it must
    const cands = [{ id: "v", verb: "send" as const, channels: ["in_app" as const], artifact: { format: "avatar_video" as const, ref: null, readiness: "unrendered" as const, playableVia: ["in_app" as const], why: "" }, manager: "asset_manager", supporting: [], externalDeliveries: 1, why: [] }, { id: "two", verb: "send" as const, channels: ["email" as const], artifact: null, manager: "x", supporting: [], externalDeliveries: 2, why: [] }, { id: "nv", verb: "send" as const, channels: [], artifact: { format: "avatar_video" as const, ref: null, readiness: "approved_ready" as const, playableVia: [], why: "" }, manager: "x", supporting: [], externalDeliveries: 1, why: [] }]
    const sc = fa.screenNextActionCandidates(cands, [{ gate: "consent", channel: "email", ok: null, why: "contact unreadable" }])
    check("screen: an UNRENDERED asset is never sent; >1 external delivery is refused; a video with no playable channel is refused; an unverified gate FAILS CLOSED", sc.eligible.length === 0 && sc.refused.length === 3 && sc.refused.find((x) => x.id === "two")!.why.some((w) => /not verified/.test(w)), JSON.stringify(sc.refused))
  }

  // ── B ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section("B — EVIDENCE: never interchanged, never upgraded")
  const n = fa.normalizeProviderEvidence
  check("`sent` / `queued` / `executed` = ACCEPTED (never delivered)", n("sent") === "accepted" && n("queued") === "accepted" && n("executed") === "accepted")
  check("`delivered` is delivered (not opened); `opened` only when reported; `clicked` only when reported", n("delivered") === "delivered" && n("opened") === "opened" && n("clicked") === "clicked")
  check("bounced / failed / unknown stay distinct; an unrecognised word is UNKNOWN, never success", n("bounced") === "bounced" && n("failed") === "failed" && n("whatever") === "unknown" && n(null) === "unknown")
  check("only evidence fires: accepted / delivered / opened / clicked fire nothing; replied → recipient_replied; bounced → delivery_failed; unknown → send_outcome_unknown", ["accepted", "delivered", "opened", "clicked"].every((e) => fa.evidenceFires(e as never).length === 0) && fa.evidenceFires("replied")[0] === "recipient_replied" && fa.evidenceFires("bounced")[0] === "delivery_failed" && fa.evidenceFires("unknown")[0] === "send_outcome_unknown")
  check("PROVIDER_EVIDENCE has the eight H11 words exactly once", [...fa.PROVIDER_EVIDENCE].sort().join() === ["accepted", "bounced", "clicked", "delivered", "failed", "opened", "replied", "unknown"].join())

  // ── C ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section("C — THE DURABLE FOLLOW-ON")
  const sendAndSettle = async (svc: MemClient, contactId: string, sent: { success: boolean; messageId?: string | null; error?: string }) => {
    const s = seams(svc)
    const d = await lt.arbitrateLifetimeTouch(svc as never, base(contactId), { routeToAgent: s.routeToAgent, requestVideo: s.requestVideo })
    return { d, settled: await lt.settleLifetimeTouchSend(svc as never, base(contactId), d, sent) }
  }
  {
    const svc = freshDb()
    const { settled } = await sendAndSettle(svc, C.base, { success: true, messageId: "prov-abc" })
    const rows = svc.tables.orchestrator_tasks.filter((t) => t.task_type === fa.NEXT_ACTION_FOLLOW_ON_TASK)
    const p = rows[0]?.payload ?? {}
    check("an accepted greeting persists EXACTLY ONE pending follow-on on orchestrator_tasks", settled.followOn === "persisted" && rows.length === 1 && rows[0].status === "pending", JSON.stringify(settled))
    const fields = ["idempotency_key", "planner", "brokerage_id", "source_event", "subject_type", "subject_id", "actor", "manager", "trigger", "waits_for", "condition", "expected_evidence", "dependencies", "eligibility", "window", "origin", "state", "evaluations", "recovery_waits"]
    check("it carries every H8 field (tenant, source event id / version, actor / subject / artifact, manager, trigger + condition + evidence, dependencies, eligibility snapshot, window, status, key, next evaluation, attempts, recovery)", fields.every((f) => f in p) && p.source_event.version === 3 && rows[0].scheduled_for === p.window.end && typeof rows[0].attempts === "number", fields.filter((f) => !(f in p)).join(","))
    check("the provider reference is kept as ACCEPTED attribution; no contact PII (no email / phone / name) on the task", p.origin.provider_message_id === "prov-abc" && !/@example\.test|\+1850|Rivera/.test(JSON.stringify(p)))
    const again = await lt.settleLifetimeTouchSend(svc as never, base(C.base), (await sendAndSettle(freshDb(), C.base, { success: true })).d, { success: true })
    check("a REPLAYED settle persists no second follow-on (idempotent per tenant · event · version · subject · trigger)", again.followOn === "duplicate" && svc.tables.orchestrator_tasks.filter((t) => t.task_type === fa.NEXT_ACTION_FOLLOW_ON_TASK).length === 1, JSON.stringify(again))
    // the m974 race: a second writer whose pre-read missed (the row is invisible to it) meets the unique index → 23505 → duplicate
    const raced = await fa.persistNextActionFollowOn({ from: (t: string) => { const q = (svc as any).from(t); if (t !== "orchestrator_tasks") return q; const sel = q.select.bind(q); q.select = (...a: unknown[]) => { const r = sel(...a); r.maybeSingle = async () => ({ data: null, error: null }); return r }; return q } } as never, p as never, { scheduledFor: NOW.toISOString(), now: NOW })
    check("a RACING writer whose pre-read missed is refused by the modelled m974 unique index (23505 → already persisted)", raced.duplicate === true && raced.persisted === false && svc.tables.orchestrator_tasks.filter((t) => t.task_type === fa.NEXT_ACTION_FOLLOW_ON_TASK).length === 1, JSON.stringify(raced))
  }
  {
    const svc = freshDb()
    const { settled } = await sendAndSettle(svc, C.base, { success: false, error: "quiet hours" })
    check("a REFUSED send persists nothing and says why (no fake receipt, no orphan)", settled.followOn === "none" && /refused/.test(settled.reason) && svc.tables.orchestrator_tasks.length === 0)
    const bd = await lt.arbitrateLifetimeTouch(svc as never, base(C.base, { kind: "birthday", channel: "sms", yearsAgo: null }), {})
    const bs = await lt.settleLifetimeTouchSend(svc as never, base(C.base, { kind: "birthday", channel: "sms", yearsAgo: null }), bd, { success: true })
    check("a birthday greeting ends with an EXPLICIT `no_follow_on` and its reason (a terminal state, not a missing trigger)", bd.record?.next.kind === "no_follow_on" && bs.followOn === "none" && /no_follow_on/.test(bs.reason), JSON.stringify(bs))
  }
  const later = new Date(NOW.getTime() + 5 * 86_400_000)
  for (const [ev, expect] of [["accepted", "ended"], ["delivered", "ended"], ["bounced", "alternate"], ["unknown", "waiting"]] as const) {
    const svc = freshDb(); await sendAndSettle(svc, C.base, { success: true, messageId: "p1" })
    const task = svc.tables.orchestrator_tasks[0]
    const s = seams(svc)
    const r = await lt.executeLifetimeFollowOn(svc as never, { id: task.id }, { now: () => later, evidence: async () => ev, sendGreeting: s.sendGreeting as never, routeToAgent: s.routeToAgent })
    if (expect === "ended") check(`the reply watch at its window end with evidence ${ev} and NO reply → completed, ended DELIBERATELY (no nag), nothing sent`, r.verdict === "completed" && task.status === "completed" && /ends deliberately/.test(String(task.payload.outcome?.reason)) && s.c.sends.length === 0 && s.c.tasks.length === 0, `${r.verdict}: ${r.reason}`)
    if (expect === "alternate") check("evidence BOUNCED → the authorized alternate with an honest trail (attribution kept)", r.verdict === "alternate" && !!task.payload.outcome?.attribution?.origin, `${r.verdict}: ${r.reason}`)
    if (expect === "waiting") check("evidence UNKNOWN → reconciled first (re-checked later, bounded), NEVER re-sent blindly", r.verdict === "waiting" && task.status === "pending" && s.c.sends.length === 0, `${r.verdict}: ${r.reason}`)
  }

  // ── D ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section("D — REPLY · OPT-OUT · RACE · RESTART")
  {
    const svc = freshDb(); await sendAndSettle(svc, C.base, { success: true })
    const bundleMine: Row = { id: randomUUID(), brokerage_id: B, task_type: "bundle_follow_on", status: "pending", payload: { audience: { contact_id: C.base, lead_id: null }, item: { channel: "sms" } } }
    const bundleOther = { id: randomUUID(), brokerage_id: B, task_type: "bundle_follow_on", status: "pending", payload: { audience: { contact_id: C.other, lead_id: null }, item: { channel: "sms" } } }
    const bundleTenant2 = { id: randomUUID(), brokerage_id: B2, task_type: "bundle_follow_on", status: "pending", payload: { audience: { contact_id: C.base, lead_id: null }, item: { channel: "sms" } } }
    svc.tables.orchestrator_tasks.push(bundleMine, bundleOther, bundleTenant2)
    const s = seams(svc)
    const r = await fa.supersedeFollowOnsForPerson(svc as never, { brokerageId: B, subject: { type: "contact", id: C.base }, reason: "recipient_replied", now: later }, { routeToAgent: s.routeToAgent as never })
    const watch = svc.tables.orchestrator_tasks.find((t) => t.task_type === fa.NEXT_ACTION_FOLLOW_ON_TASK)!
    check("A REPLY WINS: the reply watch is CONSUMED (completed — the reply is the next trigger) and the agent is told", r.consumed === 1 && watch.status === "completed" && r.notified === 1 && s.c.tasks.includes(C.base), JSON.stringify(r))
    check("…the stale bundle piece for the SAME person is cancelled (chain stopped) — no unwanted second communication", bundleMine.status === "cancelled" && bundleMine.payload.outcome?.chain === "stopped")
    check("…another person's piece and another TENANT's piece are untouched (tenant-pinned)", bundleOther.status === "pending" && bundleTenant2.status === "pending")
    const dup = await fa.supersedeFollowOnsForPerson(svc as never, { brokerageId: B, subject: { type: "contact", id: C.base }, reason: "recipient_replied", now: later })
    check("a DUPLICATE reply webhook fires nothing further (the rows are terminal)", dup.consumed === 0 && dup.cancelled === 0)
  }
  {
    const svc = freshDb(); await sendAndSettle(svc, C.base, { success: true })
    const lied = await fa.supersedeFollowOnsForPerson(svc as never, { brokerageId: B, subject: { type: "contact", id: C.base }, reason: "opt_out_all", now: later })
    check("NEGATIVE: an opt-out event whose suppression re-check finds the person NOT suppressed cancels nothing (checkSuppression decides)", lied.cancelled === 0 && svc.tables.orchestrator_tasks[0].status === "pending", JSON.stringify(lied))
    Object.assign(svc.tables.contacts.find((x) => x.id === C.base)!, { email_opt_out: true, sms_opt_out: true, phone_opt_out: true, dnc_status: true })
    const r = await fa.supersedeFollowOnsForPerson(svc as never, { brokerageId: B, subject: { type: "contact", id: C.base }, reason: "opt_out_all", now: later })
    check("a GLOBAL OPT-OUT (confirmed suppressed) cancels every pending follow-on for the person promptly — and is LEDGERED", r.cancelled === 1 && svc.tables.orchestrator_tasks[0].status === "cancelled" && svc.tables.agent_action_ledger.some((x) => x.detail?.follow_on_reconcile?.reason === "opt_out_all"), JSON.stringify(r))
    const svc2 = freshDb(); await sendAndSettle(svc2, C.base, { success: true })
    Object.assign(svc2.tables.contacts.find((x) => x.id === C.base)!, { sms_opt_out: true })
    const smsOnly = await fa.supersedeFollowOnsForPerson(svc2 as never, { brokerageId: B, subject: { type: "contact", id: C.base }, reason: "opt_out_channel", channel: "sms", now: later })
    Object.assign(svc2.tables.contacts.find((x) => x.id === C.base)!, { email_opt_out: true })
    const emailOut = await fa.supersedeFollowOnsForPerson(svc2 as never, { brokerageId: B, subject: { type: "contact", id: C.base }, reason: "opt_out_channel", channel: "email", now: later })
    check("a CHANNEL opt-out cancels only follow-ons riding that channel (sms: none; email: the email watch)", smsOnly.cancelled === 0 && emailOut.cancelled === 1, `${JSON.stringify(smsOnly)} ${JSON.stringify(emailOut)}`)
  }
  {
    const svc = freshDb(); await sendAndSettle(svc, C.base, { success: true })
    svc.tables.messages.push({ id: "late-reply", brokerage_id: B, contact_id: C.base, direction: "inbound", sender_type: "contact", type: "email", created_at: new Date(later.getTime() - 3_600_000).toISOString() })
    const s = seams(svc)
    const r = await lt.executeLifetimeFollowOn(svc as never, { id: svc.tables.orchestrator_tasks[0].id }, { now: () => later, evidence: async () => "delivered", sendGreeting: s.sendGreeting as never, routeToAgent: s.routeToAgent })
    check("a DELAYED / missed reply webhook is caught at execution: the reply consumes the watch, nothing is sent", r.verdict === "completed" && svc.tables.orchestrator_tasks[0].payload.outcome?.trigger === "recipient_replied" && s.c.sends.length === 0, `${r.verdict}: ${r.reason}`)
  }
  {
    const svc = freshDb(); await sendAndSettle(svc, C.base, { success: true })
    const id = svc.tables.orchestrator_tasks[0].id
    const s = seams(svc)
    const dep = { now: () => later, evidence: async () => "bounced" as const, sendGreeting: s.sendGreeting as never, routeToAgent: s.routeToAgent }
    const [x, y] = await Promise.all([lt.executeLifetimeFollowOn(svc as never, { id }, dep), lt.executeLifetimeFollowOn(svc as never, { id }, dep)])
    check("TWO CONCURRENT drains → one claims, the other is skipped (one evaluation, one outcome)", [x.verdict, y.verdict].filter((v) => v === "skipped").length === 1, `${x.verdict} / ${y.verdict}`)
    const z = await lt.executeLifetimeFollowOn(svc as never, { id }, dep)
    check("a REPLAYED drain after settlement matches nothing (skipped)", z.verdict === "skipped")
  }
  {
    const svc = freshDb(); await sendAndSettle(svc, C.base, { success: true })
    const t = svc.tables.orchestrator_tasks[0]
    t.payload = { ...t.payload, brokerage_id: B2 }
    const r = await lt.executeLifetimeFollowOn(svc as never, { id: t.id }, { now: () => later })
    check("a WRONG-TENANT payload fires nothing (cancelled with the reason)", r.verdict === "cancelled" && /wrong tenant/.test(String(t.payload.outcome?.reason ?? t.last_error)))
  }
  {
    const svc = freshDb(); await sendAndSettle(svc, C.base, { success: true })
    svc.tables.users[0].status = "inactive"
    const r = await lt.executeLifetimeFollowOn(svc as never, { id: svc.tables.orchestrator_tasks[0].id }, { now: () => later, evidence: async () => "delivered" })
    check("a REVOKED SEAT suspends the follow-on (kept pending, state suspended) — nothing runs on a seat that no longer exists", r.verdict === "suspended" && svc.tables.orchestrator_tasks[0].status === "pending" && svc.tables.orchestrator_tasks[0].payload.state === "suspended", `${r.verdict}: ${r.reason}`)
  }
  {
    // RESTART: a claim the drain died holding → re-queued under the same key; the re-run's send replays (one external delivery)
    const svc = freshDb(); const ledger = new Set<string>()
    const s1 = seams(svc, ledger); const s2 = seams(svc, ledger)
    const d = await lt.arbitrateLifetimeTouch(svc as never, base(C.vidFail), { arbitrate: async () => ({ choice: "avatar_greeting", decision: { waitHours: null, rationale: "a personal video fits", source: "ai" }, halt: null }), requestVideo: s1.requestVideo, routeToAgent: s1.routeToAgent })
    const task = svc.tables.orchestrator_tasks.find((t) => t.task_type === fa.NEXT_ACTION_FOLLOW_ON_TASK)!
    svc.tables.agent_intro_videos.find((v) => v.contact_id === C.vidFail)!.status = "failed"
    // the first run SENDS the alternate and then "dies" before settling: simulate by sending, then leaving the row running
    await s1.sendGreeting(svc, task.payload)
    task.status = "running"; task.updated_at = new Date(later.getTime() - 3 * 3_600_000).toISOString()
    const rec = await lt.recoverStaleLifetimeFollowOns(svc as never, { now: () => later })
    check("RESTART: a stale claim is RE-QUEUED under its same key (counted)", d.verdict === "video" && rec.recovered === 1 && task.status === "pending", JSON.stringify(rec))
    const r = await lt.executeLifetimeFollowOn(svc as never, { id: task.id }, { now: () => later, sendGreeting: s2.sendGreeting as never, routeToAgent: s2.routeToAgent })
    check("…and the re-run's send REPLAYS on the email gate's ledger cycle — one external delivery in total", r.verdict === "alternate" && s1.c.sends.length + s2.c.sends.length === 1, `${r.verdict}; sends ${s1.c.sends.length}+${s2.c.sends.length}`)
  }

  // ── E ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section("E — THE VIDEO PATH (Asset Manager renders; the Campaign rail delivers only a verified render)")
  const pickVideo = { arbitrate: async () => ({ choice: "avatar_greeting", decision: { waitHours: null, rationale: "a personal video fits this past client", source: "ai" }, halt: null }) }
  {
    const svc = freshDb(); const s = seams(svc)
    let renderDone = false
    const slowRequest = async (x: unknown, a: any) => { const r = await s.requestVideo(x, a); setTimeout(() => { renderDone = true }, 50); return r }
    const t0 = Date.now()
    const d = await lt.arbitrateLifetimeTouch(svc as never, base(C.vid), { ...pickVideo, requestVideo: slowRequest as never, routeToAgent: s.routeToAgent })
    check("video chosen → ONE Asset Manager request, NO email beside it (plan.send false — the cron sends nothing)", d.verdict === "video" && s.c.videos.length === 1 && d.plan?.send === false && d.plan.video === true)
    check("LATENCY: the decision returns while the render is still queued (rendering is asynchronous, never awaited)", !renderDone && Date.now() - t0 < 2_500)
    const task = svc.tables.orchestrator_tasks.find((t) => t.task_type === fa.NEXT_ACTION_FOLLOW_ON_TASK)!
    check("a `video_render_ready` follow-on is persisted with the render as its artifact and the Asset Manager as its manager", !!task && task.payload.trigger === "video_render_ready" && task.payload.actor.artifact?.table === "agent_intro_videos" && task.payload.manager === "asset_manager")
    const early = await lt.executeLifetimeFollowOn(svc as never, { id: task.id }, { now: () => new Date(NOW.getTime() + 3_600_000), sendGreeting: s.sendGreeting as never, routeToAgent: s.routeToAgent })
    check("still rendering INSIDE the window → waits (re-checked, bounded); nothing sent", early.verdict === "waiting" && s.c.sends.length === 0, `${early.verdict}: ${early.reason}`)
    svc.tables.agent_intro_videos.find((v) => v.contact_id === C.vid)!.status = "delivered"
    task.scheduled_for = NOW.toISOString()
    const done = await lt.executeLifetimeFollowOn(svc as never, { id: task.id }, { now: () => new Date(NOW.getTime() + 7_200_000), sendGreeting: s.sendGreeting as never, routeToAgent: s.routeToAgent })
    const watch = svc.tables.orchestrator_tasks.filter((t) => t.task_type === fa.NEXT_ACTION_FOLLOW_ON_TASK && t.payload.trigger === "timer_due")
    check("verified render DELIVERED → video_ready + delivered recorded SEPARATELY; the reply watch is persisted; no alternate sent", done.verdict === "completed" && task.payload.outcome?.evidence?.video_ready === true && watch.length === 1 && s.c.sends.length === 0, `${done.verdict}: ${done.reason}`)
  }
  {
    const svc = freshDb(); const s = seams(svc)
    await lt.arbitrateLifetimeTouch(svc as never, base(C.vidFail), { ...pickVideo, requestVideo: s.requestVideo, routeToAgent: s.routeToAgent })
    svc.tables.agent_intro_videos.find((v) => v.contact_id === C.vidFail)!.status = "failed"
    const task = svc.tables.orchestrator_tasks.find((t) => t.task_type === fa.NEXT_ACTION_FOLLOW_ON_TASK)!
    const r = await lt.executeLifetimeFollowOn(svc as never, { id: task.id }, { now: () => new Date(NOW.getTime() + 3_600_000), sendGreeting: s.sendGreeting as never, routeToAgent: s.routeToAgent })
    check("a FAILED render → the authorized email alternate, ONCE, under the same milestone attribution (never 'the video was sent')", r.verdict === "alternate" && s.c.sends.length === 1 && task.payload.outcome?.alternate === "email" && task.payload.outcome?.attribution?.source_event?.version === 3, `${r.verdict}: ${r.reason}`)
  }
  {
    const svc = freshDb(); const s = seams(svc)
    await lt.arbitrateLifetimeTouch(svc as never, base(C.vidLate), { ...pickVideo, requestVideo: s.requestVideo, routeToAgent: s.routeToAgent })
    const task = svc.tables.orchestrator_tasks.find((t) => t.task_type === fa.NEXT_ACTION_FOLLOW_ON_TASK)!
    const pastWindow = new Date(Date.parse(task.payload.window.end) + 60_000)
    const r = await lt.executeLifetimeFollowOn(svc as never, { id: task.id }, { now: () => pastWindow, sendGreeting: s.sendGreeting as never, routeToAgent: s.routeToAgent })
    const iv = svc.tables.agent_intro_videos.find((v) => v.contact_id === C.vidLate)!
    const sweepWouldDeliver = svc.tables.agent_intro_videos.filter((v) => v.status === "rendering" && v.trigger === "home_anniversary" && ["portal", "both"].includes(v.delivery_channel))
    check("a LATE render (window over, still rendering) is SUPPRESSED first, then the alternate goes — exactly one external delivery", r.verdict === "alternate" && iv.status === "suppressed" && sweepWouldDeliver.length === 0 && s.c.sends.length === 1, `${r.verdict}; iv ${iv.status}; sends ${s.c.sends.length}`)
  }
  {
    const svc = freshDb(); const s = seams(svc)
    const d = await lt.arbitrateLifetimeTouch(svc as never, base(C.vid), { ...pickVideo, requestVideo: async () => ({ ok: false, status: "failed", introVideoId: null, reason: "agent voice/avatar profile not configured" }), routeToAgent: s.routeToAgent })
    const task = svc.tables.orchestrator_tasks.find((t) => t.task_type === fa.NEXT_ACTION_FOLLOW_ON_TASK)!
    check("a render that cannot even be REQUESTED persists the follow-on already due — never a silent drop", d.verdict === "video" && !!task && task.scheduled_for === NOW.toISOString())
    const svcNoEmail = svc
    svcNoEmail.tables.contacts.find((c) => c.id === C.vid)!.email_opt_out = true
    const r = await lt.executeLifetimeFollowOn(svc as never, { id: task.id }, { now: () => later, sendGreeting: s.sendGreeting as never, routeToAgent: s.routeToAgent })
    check("…and with email no longer lawful the alternate is an AGENT TASK, with an honest trail (no email sent)", r.verdict === "alternate" && task.payload.outcome?.alternate === "agent_task" && s.c.sends.length === 0 && s.c.tasks.includes(C.vid), `${r.verdict}: ${r.reason}`)
  }

  // ── F ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section("F — BUNDLES: reply wins · author spacing is guidance · the campaign reaches SMS")
  {
    const bundle = await import("../lib/direct-mail/orchestrate-bundle-send")
    const BUN = randomUUID(), I1 = randomUUID(), I2 = randomUUID(), CAMP = randomUUID(), PRE1 = randomUUID(), PRE2 = randomUUID()
    const mk = () => freshDb({ campaign_bundles: [{ id: BUN, brokerage_id: B, name: "Spring", is_active: true }], campaign_bundle_items: [{ id: I1, bundle_id: BUN, brokerage_id: B, channel: "email", preset_id: PRE1, order_index: 0, send_after_minutes: 0 }, { id: I2, bundle_id: BUN, brokerage_id: B, channel: "sms", preset_id: PRE2, order_index: 1, send_after_minutes: 2880 }], campaign_bundle_dispatches: [] })
    const run = async (svc: MemClient, withReply: boolean) => {
      G.svc = svc
      const senders: Array<{ channel: string; campaign: string | null | undefined }> = []
      const arbInputs: any[] = []
      const dispatchItem = async (_s: unknown, item: { channel: string }, sender: { marketingCampaignId?: string | null }) => { senders.push({ channel: item.channel, campaign: sender.marketingCampaignId }); return { channel: item.channel, preset_id: null, success: true, messageId: `m-${senders.length}` } }
      const res = await bundle.orchestrateBundleSend({ brokerageId: B, bundleId: BUN, contactId: C.base, recipientName: "Pat", mailingAddress: "", city: "", state: "", zip: "", marketingCampaignId: CAMP }, { client: svc as never, dispatchItem: dispatchItem as never, now: () => NOW })
      if (withReply) svc.tables.messages.push({ id: "bundle-reply", brokerage_id: B, contact_id: C.base, direction: "inbound", sender_type: "contact", type: "sms", created_at: new Date(NOW.getTime() + 60_000).toISOString() })
      const task = svc.tables.orchestrator_tasks.find((t) => t.task_type === "bundle_follow_on" && t.status === "pending")!
      const r = await bundle.executeBundleFollowOnTask(svc as never, { id: task.id }, { now: () => new Date(NOW.getTime() + 120_000), arbitrate: async (_s, input) => { arbInputs.push(input); return { choice: "send_now", decision: { kind: "communication", waitHours: null, rationale: "fine" }, halt: null } }, dispatchItem: dispatchItem as never })
      return { res, task, r, senders, arbInputs }
    }
    const ok = await run(mk(), false)
    check("the campaign id rides the click AND the persisted follow-on to the SMS piece (ROI attributable, not N/A)", ok.res.ok && ok.task.payload.marketing_campaign_id === CAMP && ok.senders.find((x) => x.channel === "sms")?.campaign === CAMP, JSON.stringify(ok.senders))
    check("send_after_minutes is CONSUMED: carried as the author's spacing and handed to the arbiter as guidance (never a gate)", ok.task.payload.item.author_spacing_minutes === 2880 && JSON.stringify(ok.arbInputs[0]?.options ?? []).includes("about 2880 minutes") && ok.r.verdict === "sent")
    const replied = await run(mk(), true)
    check("A REPLY since the bundle began STOPS the stale chain: the queued piece is cancelled, nothing sent, no arbiter asked", replied.r.verdict === "cancelled" && replied.senders.filter((x) => x.channel === "sms").length === 0 && replied.arbInputs.length === 0 && /replied/.test(replied.r.reason), `${replied.r.verdict}: ${replied.r.reason}`)
  }

  // ── G ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section("G — THE SOCIAL PUBLISH SEAT CHECK (the real cron route)")
  {
    const U_OK = randomUUID(), U_OFF = randomUUID(), U_GONE = randomUUID(), U_MOVED = randomUUID()
    const post = (id: string, user: string) => ({ id, brokerage_id: B, user_id: user, status: "scheduled", approval_status: "approved", scheduled_for: ago(5), platform: "facebook", content: "Market note", social_account_id: randomUUID() })
    const P_OK = randomUUID(), P_OFF = randomUUID(), P_GONE = randomUUID(), P_MOVED = randomUUID()
    const svc = freshDb({
      users: [{ id: U_OK, brokerage_id: B, user_type: "agent", status: "active", deleted_at: null, location_id: null }, { id: U_OFF, brokerage_id: B, user_type: "agent", status: "inactive", deleted_at: null, location_id: null }, { id: U_GONE, brokerage_id: B, user_type: "agent", status: "active", deleted_at: ago(60), location_id: null }, { id: U_MOVED, brokerage_id: B2, user_type: "agent", status: "active", deleted_at: null, location_id: null }],
      social_posts: [post(P_OK, U_OK), post(P_OFF, U_OFF), post(P_GONE, U_GONE), post(P_MOVED, U_MOVED)],
      locations: [], teams: [], organization_members: [], social_accounts: [], social_publish_log: [],
    })
    G.svc = svc
    const route = await import("../app/api/cron/publish-social-posts/route")
    await route.GET(new Request("http://x/api/cron/publish-social-posts"))
    const st = (id: string) => svc.tables.social_posts.find((p) => p.id === id)!
    check("an INACTIVE author's approved post is HELD at egress (failed, with the reason) — never 'publishing'", st(P_OFF).status === "failed" && /held at egress/.test(String(st(P_OFF).error_message)), `${st(P_OFF).status}: ${st(P_OFF).error_message}`)
    check("a REMOVED author's and a MOVED author's (another workspace) posts are held the same way", st(P_GONE).status === "failed" && st(P_MOVED).status === "failed" && /workspace/.test(String(st(P_MOVED).error_message)))
    check("POSITIVE CONTROL: an ACTIVE member's post passes the seat check and proceeds to the publish rail", st(P_OK).status !== "scheduled" && !/held at egress/.test(String(st(P_OK).error_message ?? "")), `${st(P_OK).status}: ${st(P_OK).error_message}`)
    const svc2 = freshDb({ users: [{ id: U_OK, brokerage_id: B, user_type: "agent", status: "active", deleted_at: null, location_id: null }], social_posts: [post(P_OK, U_OK)] }, { refuse: { users: "permission denied for table users" } })
    G.svc = svc2
    await route.GET(new Request("http://x/api/cron/publish-social-posts"))
    check("an UNREADABLE seat holds the post SCHEDULED for the next tick (fail closed — never published on 'nobody checked')", svc2.tables.social_posts[0].status === "scheduled", svc2.tables.social_posts[0].status)
  }

  // ── I ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section("I — HOT TOPIC → REFURBISH / OMNIPRESENCE: the sessionless starter (154F D2)")
  {
    const rr = await import("../lib/repurpose/refurbish-run")
    const exp = new Date(NOW.getTime() + 3 * 86_400_000).toISOString()
    const topic = (id: string, kind: string, extra: Row = {}, raw: Row = {}): Row => ({ id, brokerage_id: B, topic_title: "Why are homeowners insurance costs rising around Pace?", expires_at: exp, status: "active", raw_data: { intake: { source_kind: kind }, popularity_evidence_type: "proxy", creative_brief: { source_rights: "public_read_reworded" }, ...raw }, ...extra })
    const T = { trend: randomUUID(), chatter: randomUUID(), own: randomUUID(), unmapped: randomUUID(), expired: randomUUID(), norights: randomUUID(), excluded: randomUUID(), weak: randomUUID(), other: randomUUID() }
    const svc = freshDb({
      content_topic_bank: [
        topic(T.trend, "search_demand_trends"), topic(T.chatter, "community_post"), topic(T.own, "own_post_underperformer", {}, { own_performance: { measuredRate: 0.01, baselineRate: 0.03 } }),
        topic(T.unmapped, "nextdoor_digest"), topic(T.expired, "search_demand_trends", { expires_at: ago(60) }), topic(T.norights, "community_post", {}, { creative_brief: { source_rights: "unknown" } }),
        topic(T.excluded, "community_post", { topic_title: "Welcome our new agent to the Gulf Coast team!" }), topic(T.weak, "search_demand_trends", {}, { popularity_evidence_type: "unknown" }),
        { ...topic(T.other, "search_demand_trends"), brokerage_id: B2 },
      ],
      social_media_accounts: [{ id: randomUUID(), brokerage_id: B, platform: "facebook", is_active: true }, { id: randomUUID(), brokerage_id: B, platform: "instagram", is_active: true }],
    }, { unique: { orchestrator_tasks: [["payload->>idempotency_key"]], agent_action_ledger: [["idempotency_key"]] } })
    const map = (k: string) => (({ search_demand_trends: "google_trend", community_post: "public_chatter", own_post_underperformer: "own_underperformer" }) as Record<string, "google_trend" | "public_chatter" | "own_underperformer">)[k] ?? null
    const executed: string[] = []
    const deps = { kindToTrigger: map, execute: async (_s: unknown, a: { topicId: string }) => { executed.push(a.topicId); return { started: true, reason: "creative started (seam)" } } }
    const go = (id: string, d: Record<string, unknown> = deps, brokerageId = B) => rr.startTopicRefurbish(svc as never, { brokerageId, topicId: id, now: NOW }, d as never)
    const tr = await go(T.trend), ch = await go(T.chatter), ow = await go(T.own)
    check("a fresh verified TREND topic reaches the starter → trigger google_trend, routed to BOTH (one original master + variants for 2 connected platforms)", tr.trigger === "google_trend" && tr.route === "both" && tr.started, JSON.stringify(tr))
    check("a fresh verified COMMUNITY topic → trigger public_chatter, started", ch.trigger === "public_chatter" && ch.started, JSON.stringify(ch))
    check("an OWN under-performer (measured below its own baseline) → trigger own_underperformer, started", ow.trigger === "own_underperformer" && ow.started, JSON.stringify(ow))
    const un = await go(T.unmapped)
    check("an UNMAPPED source kind is HELD with its reason — not silently dropped, nothing started", un.route === "hold" && /no Refurbish trigger mapping/.test(un.reason) && !executed.includes(T.unmapped), JSON.stringify(un))
    const unwired = await rr.startTopicRefurbish(svc as never, { brokerageId: B, topicId: T.chatter, now: NOW }, { execute: deps.execute } as never)
    check("with the production mapping NOT yet wired, every kind is held (fail closed until the integrator wires 154G1's export)", unwired.route === "hold" && /no Refurbish trigger mapping/.test(unwired.reason))
    check("a topic whose freshness window ENDED is CLOSED (never published late)", (await go(T.expired)).route === "close")
    check("rights UNKNOWN → held; a joining announcement → excluded before any generation", (await go(T.norights)).route === "hold" && /excluded/.test((await go(T.excluded)).reason))
    const weak = await go(T.weak)
    check("WEAK evidence (popularity unknown) → research first, no creative started", weak.route === "research" && !executed.includes(T.weak))
    const before = executed.length
    const again = await go(T.trend)
    check("ONE verified trend → ONE opportunity: a replay in the same freshness window is a duplicate and starts nothing", again.duplicate === true && executed.length === before, JSON.stringify(again))
    check("another tenant's topic is not reachable (tenant-pinned read)", (await go(T.other)).route === "hold")
    const opp = svc.tables.agent_action_ledger.find((x) => x.system_source === "topic_refurbish_starter" && x.detail?.opportunity?.topic_id === T.trend)
    check("the typed opportunity is ledgered with NO spend and first publication behind approval", opp?.detail?.opportunity?.spend === "none" && opp.detail.opportunity.first_publication === "approval_required")
    const partial = await rr.startTopicRefurbish(freshDb({ content_topic_bank: [topic(T.trend, "search_demand_trends")] }, { unique: { agent_action_ledger: [["idempotency_key"]] } }) as never, { brokerageId: B, topicId: T.trend, now: NOW }, { kindToTrigger: map } as never)
    check("PARTIAL stated, not hidden: with the production creative step the opportunity is READY but nothing is generated (executePipeline is session-bound)", partial.started === false && /PARTIAL/.test(partial.reason), partial.reason)
  }

  // ── H ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section("H — WIRING (stripped source; every absence with a positive control)")
  const reactor = code("lib/kernel/event-reactor.ts")
  const branch = reactor.slice(reactor.indexOf("const FOLLOW_ON_EVENTS"), reactor.indexOf("const FOLLOW_ON_EVENTS") + 2600)
  check("the reactor consumes ISA_REPLY_RECEIVED, CONTACT_DNC_SET and CONTACT_CHANNEL_OPT_OUT into supersedeFollowOnsForPerson", /KernelEvent\.ISA_REPLY_RECEIVED/.test(branch) && /KernelEvent\.CONTACT_DNC_SET/.test(branch) && /KernelEvent\.CONTACT_CHANNEL_OPT_OUT/.test(branch) && (branch.match(/supersedeFollowOnsForPerson\(/g) ?? []).length >= 3)
  const drain = code("app/api/cron/queue-drain/route.ts")
  check("the queue drain routes NEXT_ACTION_FOLLOW_ON_TASK to executeLifetimeFollowOn BEFORE the 'no executor registered' fallback, and recovers stale claims", drain.indexOf("NEXT_ACTION_FOLLOW_ON_TASK") > 0 && drain.indexOf("executeLifetimeFollowOn") > 0 && drain.indexOf("executeLifetimeFollowOn") < drain.indexOf("no executor registered for task_type") && /recoverStaleLifetimeFollowOns\(/.test(drain))
  const cron = code("app/api/cron/lifetime-customer-touchpoints/route.ts")
  const annSend = cron.indexOf("sendAnniversaryMessage(txn.contact_id")
  check("the lifetime cron sends the chosen greeting with video: false and settles it into the follow-on", annSend > 0 && /video:\s*false/.test(cron.slice(annSend, annSend + 160)) && cron.indexOf("settleSend(sent)") > annSend)
  const action = code("app/actions/lifetime-customer-touchpoints.ts")
  const videoGate = /if\s*\(agentId\s*&&\s*opts\?\.video\s*!==\s*false\)\s*\{[\s\S]{0,400}dispatchAnniversaryVideo/
  check("sendAnniversaryMessage fires the avatar video only when the caller did not refuse it (no video beside every email)", videoGate.test(action))
  check("POSITIVE CONTROL: the base shape (an unconditional `if (agentId) { … dispatchAnniversaryVideo`) is what the finder rejects", !videoGate.test("if (agentId) { const { dispatchAnniversaryVideo } = 1 }"))
  const responder = code("lib/communications/inbound-responder.ts")
  const renderOnFastPath = (src: string) => /dispatchAnniversaryVideo|lifetime-touch-arbitration|intro-video-reactor|renderMediaOnLambda|executePipeline\(/.test(src)
  check("LATENCY: the live inbound responder (the 2.5-second path) never imports a render or the lifetime planner", responder.length > 1000 && !renderOnFastPath(responder))
  check("POSITIVE CONTROL: the fast-path finder flags a render import when one is present", renderOnFastPath(`${responder}\nimport { dispatchAnniversaryVideo } from "@/lib/video/intro-video-reactor"`))
  const obs = code("lib/direct-mail/orchestrate-bundle-send.ts")
  check("the bundle loader reads send_after_minutes (the field now has a consumer)", /select\("id, channel, preset_id, order_index, send_after_minutes"\)/.test(obs))
  const smsCall = obs.slice(obs.indexOf("orchestrateSmsPresetSend({"), obs.indexOf("orchestrateSmsPresetSend({") + 400)
  check("the bundle's SMS piece passes the campaign to orchestrateSmsPresetSend", /marketingCampaignId:\s*s\.marketingCampaignId/.test(smsCall))
  check("POSITIVE CONTROL: the base SMS call (no campaign) is rejected by the same finder", !/marketingCampaignId:\s*s\.marketingCampaignId/.test("orchestrateSmsPresetSend({ brokerageId: s.brokerageId, presetId: item.preset_id, toPhone })"))
  const mig = raw("supabase/migrations/m974-next-action-follow-ons-ride-the-orchestrator-queue-once.sql")
  // The RULE, not a waypoint: line 1 states exactly one status (written, or applied with its date) — whichever is true today.
  const m974Line1 = mig.split("\n")[0]
  const m974Status = (/APPLIED LIVE \d{4}-\d{2}-\d{2}/.test(m974Line1) ? 1 : 0) + (m974Line1.startsWith("-- WRITTEN, NOT APPLIED") ? 1 : 0)
  check("m974 states ONE status on line 1 and carries the partial unique index on next_action_follow_on only — no DROP in the migration", m974Status === 1 && /CREATE UNIQUE INDEX IF NOT EXISTS orchestrator_tasks_next_action_follow_on_key[\s\S]*WHERE task_type = 'next_action_follow_on'/.test(mig) && !/^\s*DROP\s/im.test(mig))
  const pub = code("app/api/cron/publish-social-posts/route.ts")
  check("the social publish re-checks the author BEFORE the 'publishing' flag (seat → resolveViewerHierarchy)", pub.indexOf("authorStillAdmits(supabase") > 0 && pub.indexOf("authorStillAdmits(supabase") < pub.indexOf('status: "publishing"') && /resolveViewerHierarchy\(/.test(pub))

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed (SIMULATED: in-memory database, counted seams, no provider called)`)
  if (fail) { for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
