#!/usr/bin/env tsx
/**
 * scripts/marketing-loops-guard.ts   (npm run test:marketing-loops)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 153, LANE 153P — owner B9: "loop the bundles, omnipresence and refurbish, and lifetime and ghost. we need another plane
 * or whatever starts an arbiter on [them]"; B11 "audit and fix any partials in marketing capability census"; plus lane 153K's
 * carried marketing-producer findings. Each loop: its STARTER (a verified cron / reactor that hands due work on) → the arbiter or
 * approval plane → execution → receipt / lineage → the next item, with the adverse cases the brief names.
 *
 *   §A STARTERS — each loop's trigger is a scheduled cron / event consumer that reaches its door (stripped source, positive control).
 *   §B LIFETIME — the REAL arbitratePlannedTouch on memSupabase (no model: the planner verdict stands): send · opted-out halt ·
 *      a person owns the conversation → held → a PERSISTED deferral (replay writes no second row) · the moments pass conducts it.
 *   §C GHOST — ghostQuietVerdict: an old quiet lead is a ghost; a recent inbound is not; an unreadable history is not silence.
 *   §D OMNIPRESENCE — one staggered slot per platform (the tenant's fatigue floor), never simultaneous; a replay skips every
 *      platform that already carried the source; a second format on the same platform is not a second post.
 *   §E REFURBISH — an external source without a stated licence is refused; no source = no lineage; owned content carries its
 *      licence by ownership; every URL door asks the gate; outputs record lineage.
 *   §F 153K FINDINGS — sender literals refused by name; video social posts approved only by an approver of a PUBLIC video;
 *      SOCIAL_POST_PUBLISHED is not emitted on generation.
 *   §G BUNDLES — the follow-on door halts on no lawful channel (wiring; behaviour is test:campaign-bundle-follow-on).
 * SIMULATED: no provider is called; the model is never asked (outside the application server the door keeps the planner verdict).
 * BLIND SPOTS: §A proves wiring, not that the cron is deployed; §F's approver resolver is a seam (requirePublishApprover has its own
 * proof); omnipresence lineage dedup keys on source_id, so two runs of the SAME external URL through two fresh pipelines are two
 * sources (each run is a new pipeline id) — said, not hidden.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { memSupabase } from "./in-memory-supabase"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const failures: string[] = []
const check = (label: string, cond: boolean, detail?: string) => { if (cond) { pass++; console.log(`  ✓ ${label}`) } else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) } }
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const ROOT = process.cwd()
const code = (p: string) => { try { return stripComments(readFileSync(join(ROOT, p), "utf8")) } catch { return "" } }
const calls = (src: string, fn: string) => new RegExp(`\\b${fn.replace(/[.$]/g, "\\$&")}\\s*\\(`).test(src)

async function main() {
  // ── §A ─────────────────────────────────────────────────────────────────────────────────────────────
  section("§A — every loop has a STARTER that hands due work to its door (no click needed when the trigger is a schedule / event)")
  check("POSITIVE CONTROL: the call finder sees a call and refuses a comment", calls("x = await runGhostReengagement(b, 7)", "runGhostReengagement") && !calls(stripComments("// runGhostReengagement(b, 7)"), "runGhostReengagement"))
  const dispatch = code("lib/kernel/cron-dispatch.ts")
  for (const [cron, door] of [["lifetime-customer-touchpoints", "arbitrateLifetimeTouch"], ["ghost-detection", "runGhostReengagement"], ["queue-drain", "executeBundleFollowOnTask"]] as const) {
    check(`/api/cron/${cron} is scheduled (lib/kernel/cron-dispatch.ts)`, dispatch.includes(`/api/cron/${cron}"`))
    check(`/api/cron/${cron} calls ${door}( — the loop starts on the schedule`, calls(code(`app/api/cron/${cron}/route.ts`), door))
  }
  check("omnipresence's automatic starter: video completion → distributeRepurposedVideoAsDraft (lib/orchestrator/internal.ts)", calls(code("lib/orchestrator/internal.ts"), "distributeRepurposedVideoAsDraft"))
  check("refurbish's automatic starter: a finished broadcast reel → the Asset Manager's repurpose_shorts_handoff (manager-signals)", code("lib/kernel/manager-signals.ts").includes(`"asset_manager:repurpose_shorts_handoff"`) && calls(code("lib/kernel/manager-signals.ts"), "planRepurposeChannels"))
  const arbSrc = code("lib/ai-isa/followup-arbiter.ts")
  check("the lifetime_touch planner row is in ARBITER_PLANNER_ENTRY_POINTS (door lib/sphere/lifetime-touch-arbitration.ts)", /lifetime_touch:\s*\{\s*planner:\s*"app\/api\/cron\/lifetime-customer-touchpoints\/route\.ts",\s*door:\s*"lib\/sphere\/lifetime-touch-arbitration\.ts",\s*via:\s*"arbitratePlannedTouch"/.test(arbSrc))
  check("the lifetime door calls arbitratePlannedTouch( and requires the touch's channel (halt on no lawful channel)", calls(code("lib/sphere/lifetime-touch-arbitration.ts"), "arbitratePlannedTouch") && code("lib/sphere/lifetime-touch-arbitration.ts").includes("requiredChannels: [a.channel]"))
  const cronSrc = code("app/api/cron/lifetime-customer-touchpoints/route.ts")
  const annIdx = cronSrc.indexOf("sendAnniversaryMessage(txn.contact_id"), bdayIdx = cronSrc.indexOf("sendBirthdayMessage(contact.id")
  const askA = cronSrc.lastIndexOf('kind: "anniversary"', annIdx), askB = cronSrc.lastIndexOf('kind: "birthday"', bdayIdx)
  check("the anniversary send is reached only after the arbiter (arbiterSays … kind anniversary precedes sendAnniversaryMessage)", annIdx > 0 && askA > 0 && askA < annIdx)
  check("the birthday send is reached only after the arbiter", bdayIdx > 0 && askB > 0 && askB < bdayIdx)
  check("the moments pass conducts an ARBITER-DEFERRED anniversary (it no longer only reconciles every home_anniversary row)", /deferred_by\s*\)?\s*===\s*"lifetime_touch"/.test(code("lib/sphere/followup-moments.ts").replace(/\?\./g, ".")) || code("lib/sphere/followup-moments.ts").includes('?.deferred_by === "lifetime_touch"'))

  // ── §B ─────────────────────────────────────────────────────────────────────────────────────────────
  section("§B — LIFETIME through the REAL arbitratePlannedTouch (memSupabase; the model is never asked)")
  const { arbitrateLifetimeTouch } = await import("../lib/sphere/lifetime-touch-arbitration")
  const B = "11111111-1111-4111-8111-111111111111"
  const C_OK = "22222222-2222-4222-8222-222222222222", C_OPT = "33333333-3333-4333-8333-333333333333", C_HUMAN = "44444444-4444-4444-8444-444444444444", C_IN = "55555555-5555-4555-8555-555555555555"
  const AGENT = "66666666-6666-4666-8666-666666666666"
  const now = new Date("2026-11-16T15:00:00.000Z")
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString()
  const contact = (id: string, extra: Record<string, unknown> = {}) => ({ id, brokerage_id: B, email: `${id.slice(0, 4)}@example.test`, phone: "+15555550100", tcpa_consent: true, email_opt_out: false, email_unsubscribed: false, sms_opt_out: false, phone_opt_out: false, dnc_status: false, ...extra })
  const svc = memSupabase({
    contacts: [contact(C_OK), contact(C_OPT, { email_opt_out: true }), contact(C_HUMAN), contact(C_IN)],
    messages: [
      { id: "m1", brokerage_id: B, contact_id: C_HUMAN, direction: "outbound", sender_type: "agent", type: "sms", created_at: minutesAgo(10) },
      { id: "m2", brokerage_id: B, contact_id: C_IN, direction: "outbound", sender_type: "ai", type: "ai", created_at: minutesAgo(600) },
      { id: "m3", brokerage_id: B, contact_id: C_IN, direction: "inbound", sender_type: "contact", type: "sms", created_at: minutesAgo(60) },
    ],
    lifetime_customer_touchpoints: [],
  }, { stampCreatedAt: true, uuidIds: true })
  const routed: string[] = []
  const deps = { routeToAgent: async (_s: unknown, a: { contactId: string }) => { routed.push(a.contactId); return true } }
  const base = { brokerageId: B, agentId: AGENT, now }
  const ok = await arbitrateLifetimeTouch(svc as never, { ...base, contactId: C_OK, kind: "anniversary", channel: "email", yearsAgo: 3 }, deps)
  check("POSITIVE RUN: a consented past client's anniversary → send (the planner verdict stands without the model)", ok.verdict === "send", `${ok.verdict}: ${ok.reason}`)
  const opt = await arbitrateLifetimeTouch(svc as never, { ...base, contactId: C_OPT, kind: "anniversary", channel: "email", yearsAgo: 2 }, deps)
  check("ADVERSE: an opted-out Contact is HALTED at the door (no lawful channel) — nothing is sent", opt.verdict === "halt" && /email/.test(opt.reason), `${opt.verdict}: ${opt.reason}`)
  const before = (svc.tables.lifetime_customer_touchpoints ?? []).length
  const held = await arbitrateLifetimeTouch(svc as never, { ...base, contactId: C_HUMAN, kind: "birthday", channel: "sms" }, deps)
  check("ADVERSE: the agent took the thread (a person wrote 10 minutes ago) → HELD, no automated touch on top", held.verdict === "wait" && held.source === "deterministic", `${held.verdict}/${held.source}: ${held.reason}`)
  const deferredRows = (svc.tables.lifetime_customer_touchpoints ?? []).filter((r) => r.contact_id === C_HUMAN)
  check("the hold is PERSISTED as a scheduled touchpoint (deferred_by lifetime_touch) — a wait is never a dropped touch", deferredRows.length === 1 && deferredRows[0].status === "scheduled" && deferredRows[0].touchpoint_type === "birthday" && deferredRows[0].engagement_data?.deferred_by === "lifetime_touch", JSON.stringify(deferredRows))
  await arbitrateLifetimeTouch(svc as never, { ...base, contactId: C_HUMAN, kind: "birthday", channel: "sms" }, deps)
  check("ADVERSE: a REPLAY of the same held touch writes no second deferral (idempotent per contact · type · due date)", (svc.tables.lifetime_customer_touchpoints ?? []).filter((r) => r.contact_id === C_HUMAN).length === 1 && (svc.tables.lifetime_customer_touchpoints ?? []).length === before + 1)
  const inbound = await arbitrateLifetimeTouch(svc as never, { ...base, contactId: C_IN, kind: "birthday", channel: "sms" }, deps)
  check("a RECENT INBOUND (they wrote an hour ago, after our last touch) is answered now — never deferred like an old quiet relationship", inbound.verdict === "send", `${inbound.verdict}: ${inbound.reason}`)
  const agentDoor = await arbitrateLifetimeTouch(svc as never, { ...base, contactId: C_OK, kind: "anniversary", channel: "email", yearsAgo: 3 }, { ...deps, arbitrate: async () => ({ choice: "agent_personally", decision: { waitHours: null, rationale: "the agent's personal note lands better", source: "model" }, halt: null }) })
  check("the arbiter's 'agent personally' choice writes the agent task (routeToAgent) — the next item is a person's", agentDoor.verdict === "agent" && agentDoor.routed && routed.includes(C_OK))
  const broken = await arbitrateLifetimeTouch(svc as never, { ...base, contactId: C_OK, kind: "anniversary", channel: "email" }, { ...deps, arbitrate: async () => { throw new Error("provider down") } })
  check("ADVERSE: an arbiter that cannot run is a WAIT (said), never a send nobody decided", broken.verdict === "wait" && /arbiter unavailable/.test(broken.reason))
  const ledger = (svc.tables.agent_action_ledger ?? []).filter((r) => String(r.action ?? "").startsWith("followup.decision") || r.system_source === "lifetime_touch")
  check("every real arbitration was LEDGERED (LAW 5) under the lifetime_touch planner", ledger.length >= 3, `${ledger.length} ledger rows`)

  // ── §C ─────────────────────────────────────────────────────────────────────────────────────────────
  section("§C — GHOST: an old quiet person is not a recent inbound")
  const { ghostQuietVerdict } = await import("../lib/ai-isa/reengagement-policy")
  const g = (lastInboundAt: string | null, historyReadable = true) => ghostQuietVerdict({ lastInboundAt, historyReadable, thresholdDays: 14, now })
  check("POSITIVE: no inbound on record → a ghost", g(null).ghost === true)
  check("POSITIVE: last inbound 40 days ago (threshold 14) → a ghost", g(new Date(now.getTime() - 40 * 86_400_000).toISOString()).ghost === true)
  const recent = g(new Date(now.getTime() - 3 * 86_400_000).toISOString())
  check("ADVERSE: a recent inbound (3 days ago) is NOT treated as a ghost", recent.ghost === false && (recent as { reason: string }).reason === "recent_inbound")
  check("ADVERSE: an unreadable history is NOT read as silence (skipped)", g(null, false).ghost === false)
  const ghostSrc = code("lib/ai-isa/ghost-reengagement.ts")
  check("the ghost runner reads the conversation history's latest INBOUND and skips a non-ghost before any touch", ghostSrc.includes(".eq('direction', 'inbound')") && calls(ghostSrc, "ghostQuietVerdict") && ghostSrc.indexOf("ghostQuietVerdict(") < ghostSrc.indexOf("arbitrateCadence("))

  // ── §D ─────────────────────────────────────────────────────────────────────────────────────────────
  section("§D — OMNIPRESENCE: coordinated, staggered, never simultaneous repeats")
  const { planOmnipresenceSchedule, omnipresenceSourceKey } = await import("../lib/repurpose/omnipresence-plan")
  const key = omnipresenceSourceKey("video_project", "v1")
  const fresh = planOmnipresenceSchedule({ platforms: ["instagram", "facebook", "linkedin"], sourceKey: key, carried: [], now, gapHours: 48 })
  const times = fresh.map((s) => s.at)
  check("POSITIVE: every platform gets ONE slot", fresh.length === 3 && fresh.every((s) => s.at && !s.skip))
  check("never simultaneous: no two platforms share a slot", new Set(times).size === times.length)
  check("cross-channel fatigue HOLDS the second channel by the tenant's floor (48h after the first)", Date.parse(times[1]!) - Date.parse(times[0]!) === 48 * 3_600_000 && times[0] === now.toISOString())
  const replay = planOmnipresenceSchedule({ platforms: ["instagram", "facebook", "linkedin"], sourceKey: key, carried: [{ platform: "instagram", sourceKey: key, at: now.toISOString() }, { platform: "facebook", sourceKey: key, at: new Date(now.getTime() + 48 * 3_600_000).toISOString() }], now, gapHours: 48 })
  check("ADVERSE: a REPLAY skips every platform that already carried the source (no double-post)", replay.filter((s) => s.skip === "already_carried").map((s) => s.platform).join() === "instagram,facebook")
  check("…and the one new platform waits the floor after the LAST carried slot (no burst on re-run)", replay.find((s) => s.platform === "linkedin")?.at === new Date(now.getTime() + 96 * 3_600_000).toISOString())
  check("POSITIVE CONTROL: another source's lineage does not block this one", planOmnipresenceSchedule({ platforms: ["instagram"], sourceKey: key, carried: [{ platform: "instagram", sourceKey: "video_project:other", at: null }], now, gapHours: 48 })[0].skip === null)
  check("a duplicate platform in the format list is ONE post", planOmnipresenceSchedule({ platforms: ["instagram", "instagram"], sourceKey: key, carried: [], now, gapHours: 48 }).length === 1)
  const actSrc = code("lib/repurpose/actions.ts")
  check("executePipeline schedules each post at its planned slot (never `new Date()` for every platform) and refuses on unreadable lineage", calls(actSrc, "planOmnipresenceSchedule") && actSrc.includes("scheduledFor: slot?.at") && actSrc.includes("repurpose history could not be read"))
  check("the completion-side distributor staggers its drafts (scheduled_for from the planner) and keeps them PENDING approval", calls(code("lib/repurpose/distribute.ts"), "planOmnipresenceSchedule") && code("lib/repurpose/distribute.ts").includes("scheduled_for: slots.get(cfg.platform)") && code("lib/repurpose/distribute.ts").includes('approval_status: "pending"'))

  // ── §E ─────────────────────────────────────────────────────────────────────────────────────────────
  section("§E — REFURBISH: lineage + licence")
  const { assessRefurbishSource } = await import("../lib/repurpose/shared")
  const noLic = assessRefurbishSource({ sourceType: "video_url", ownedSourceId: null, sourceUrl: "https://example.test/someone-elses.mp4", rightsBasis: null })
  check("ADVERSE: an external asset WITHOUT a stated licence is refused (no_license)", !noLic.allowed && (noLic as { reason: string }).reason === "no_license")
  const noLin = assessRefurbishSource({ sourceType: "video_url", ownedSourceId: null, sourceUrl: null, rightsBasis: "licensed" })
  check("ADVERSE: an asset with no source at all is refused (no_lineage)", !noLin.allowed && (noLin as { reason: string }).reason === "no_lineage")
  check("ADVERSE: an invented basis is refused (only own_content / licensed)", !assessRefurbishSource({ sourceType: "video_url", ownedSourceId: null, sourceUrl: "https://x.test/a", rightsBasis: "fair_use" }).allowed)
  const owned = assessRefurbishSource({ sourceType: "podcast_episode", ownedSourceId: "e1", sourceUrl: null, rightsBasis: null })
  check("POSITIVE: the tenant's own row carries its lineage and licence by ownership", owned.allowed && (owned as { lineage: string }).lineage === "podcast_episode:e1" && (owned as { license: string }).license === "tenant_owned")
  const lic = assessRefurbishSource({ sourceType: "video_url", ownedSourceId: null, sourceUrl: "https://x.test/a.mp4", rightsBasis: "licensed" })
  check("POSITIVE: an external source with a stated licence is allowed and its lineage is the original's URL", lic.allowed && (lic as { lineage: string }).lineage === "url:https://x.test/a.mp4")
  for (const fn of ["repurposeVideoUrl", "repurposeUrlToBrandedVideo", "repurposeUrlToBlogPost", "repurposeUrlToPodcast", "executePipeline"]) {
    const i = actSrc.indexOf(`export async function ${fn}(`)
    const body = i < 0 ? "" : actSrc.slice(i, actSrc.indexOf("\nexport ", i + 10) > 0 ? actSrc.indexOf("\nexport ", i + 10) : undefined)
    check(`${fn} asks the refurbish gate before it generates anything`, calls(body, "assessRefurbishSource"))
  }
  check("the blog / podcast refurbishes record their lineage + licence (repurposed_content_log notes)", (actSrc.match(/notes: `lineage \$\{rights\.lineage\} · licence \$\{rights\.license\}`/g) ?? []).length === 2)
  check("the distributor records lineage per drafted post", code("lib/repurpose/distribute.ts").includes('from("repurposed_content_log")'))

  // ── §F ─────────────────────────────────────────────────────────────────────────────────────────────
  section("§F — lane 153K carried findings in marketing producers")
  check("POSITIVE CONTROL: the literal finder sees a live fallback", /\?\?\s*"noreply@vipre\.io"/.test('const f = process.env.X ?? "noreply@vipre.io"'))
  check("no `?? \"noreply@vipre.io\"` sender in the preset email orchestrator; unset is refused by name", !/noreply@vipre\.io/.test(code("lib/email/orchestrate-email-preset-send.ts")) && code("lib/email/orchestrate-email-preset-send.ts").includes("sender_unset:OUTBOUND_EMAIL_FROM"))
  for (const f of ["app/actions/ai-newsletter.ts", "app/api/cron/publish-newsletters/route.ts"]) check(`no \`?? "platform.com"\` sender in ${f}; unset is refused by name`, !/platform\.com/.test(code(f)) && /sender_unset:\s*NEWSLETTER_FROM_DOMAIN|sender_unset:NEWSLETTER_FROM_DOMAIN/.test(code(f)))
  const pubCron = code("app/api/cron/publish-newsletters/route.ts")
  check("the newsletter cron DEFERS before it CLAIMS when the sender domain is unset (no stranded 'sending' campaign)", pubCron.indexOf("sender_unset:NEWSLETTER_FROM_DOMAIN") > 0 && pubCron.indexOf("sender_unset:NEWSLETTER_FROM_DOMAIN") < pubCron.indexOf('.update({ status: "sending" })'))
  const { insertVideoSocialPostForApproval } = await import("../lib/social/video-post-approval")
  const vsvc = memSupabase({ social_posts: [] }, { uuidIds: true })
  const publicVideo = { video_type: "listing_tour", audience_type: "public", usage_intent: "public_marketing", contact_id: null, learning_module_id: null, approval_status: "approved", status: "completed", compliance_status: "passed", video_url: "https://cdn.test/v.mp4" }
  const { PUBLIC_MARKETING_VIDEO_TYPES } = await import("../lib/video/public-video")
  if (!(PUBLIC_MARKETING_VIDEO_TYPES as readonly string[]).includes(publicVideo.video_type)) publicVideo.video_type = (PUBLIC_MARKETING_VIDEO_TYPES as readonly string[])[0]
  const personal = await insertVideoSocialPostForApproval(vsvc as never, { brokerageId: B, approverUserId: "u-approver", project: { ...publicVideo, contact_id: C_OK }, post: { platform: "instagram" } }, { requireApprover: async () => ({ ok: true }) })
  check("ADVERSE: a video addressed to a contact (personal) is REFUSED — no public post is inserted", !personal.ok && (vsvc.tables.social_posts ?? []).length === 0, personal.reason ?? "")
  const notApprover = await insertVideoSocialPostForApproval(vsvc as never, { brokerageId: B, approverUserId: "u-agent", project: publicVideo, post: { platform: "instagram" } }, { requireApprover: async () => ({ ok: false, reason: "you are not an approver of this social_post" }) })
  const row1 = (vsvc.tables.social_posts ?? []).find((r) => r.id === notApprover.postId)
  check("a public video by a NON-approver → the post waits PENDING (draft), never 'approved' by nobody", notApprover.ok && !notApprover.released && row1?.approval_status === "pending" && row1?.status === "draft")
  const approver = await insertVideoSocialPostForApproval(vsvc as never, { brokerageId: B, approverUserId: "u-approver", project: publicVideo, post: { platform: "facebook" } }, { requireApprover: async () => ({ ok: true }) })
  const row2 = (vsvc.tables.social_posts ?? []).find((r) => r.id === approver.postId)
  check("POSITIVE: an approver's release → approved + scheduled with approved_by recorded", approver.released && row2?.approval_status === "approved" && row2?.status === "scheduled" && row2?.approved_by === "u-approver")
  for (const f of ["app/actions/video/distribute-video.ts", "lib/kernel/video.ts"]) {
    const src = code(f)
    check(`${f} inserts its video social post through the approval helper (no literal approval_status "approved" on a social_posts insert)`, calls(src, "insertVideoSocialPostForApproval") && !/from\("social_posts"\)\s*\.insert\(\{[^}]*approval_status:\s*"approved"/s.test(src))
  }
  check("POSITIVE CONTROL: the emission finder sees the REAL publish emit in the cron", /SOCIAL_POST_PUBLISHED/.test(code("app/api/cron/publish-social-posts/route.ts")))
  check("generateSocialPost no longer emits SOCIAL_POST_PUBLISHED on mere generation", !/SOCIAL_POST_PUBLISHED/.test(code("app/actions/ai-content-generation.tsx")))

  // ── §G ─────────────────────────────────────────────────────────────────────────────────────────────
  section("§G — BUNDLES: the follow-on door (behaviour: test:campaign-bundle-follow-on)")
  const bundle = code("lib/direct-mail/orchestrate-bundle-send.ts")
  check("the bundle follow-on asks arbitratePlannedTouch with the item's channel REQUIRED, and a halt skips the piece (opted out → not sent)", calls(bundle, "arbitratePlannedTouch") && bundle.includes("requiredChannels: [arbiterChannel]") && /if \(arb\.halt\) return await skipItem\(/.test(bundle))

  console.log(`\n BLIND SPOTS: §A proves wiring, not deployment; §B runs the real door with the model refused (the planner verdict) — a model's choice is a seam in two cases (agent / thrown arbiter); §F's approver resolver is a seam (requirePublishApprover has its own proof); omnipresence lineage keys on source_id. No provider was called.`)
  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ MARKETING_LOOPS_FAIL\n" + failures.map((f) => `   - ${f}`).join("\n")); process.exit(1) }
  console.log(" ✅ MARKETING_LOOPS_OK")
}

main().catch((e) => { console.error(e); process.exit(1) })
