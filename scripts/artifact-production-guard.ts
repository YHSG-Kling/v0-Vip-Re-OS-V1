#!/usr/bin/env tsx
/**
 * scripts/artifact-production-guard.ts   (npm run test:artifact-production)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 155, LANE 155G — owner R6 / R9 ("videos should be setup not just for lifetime/birthday … video is an artifact not a
 * channel"); directive 155G G1 / G2, canaries at line 348; eval BIAS-003, BIAS-005, REWARD-001.
 *
 *   §A VARIANT CONTRACT — a platform variant is chosen by the connected permission and the real media; refused without it; a
 *      text post is never presented as a video; an image-only publisher gets an export / handoff, never "published".
 *   §B SITUATION CHOICE — an educational video for a recurring appraisal-contingency question; a plain answer when that is
 *      better (one asker / a fact about their own deal); advice → the agent; unverified market facts → no touch; identical
 *      inputs differing only in a protected-class cue → the same choice (BIAS-005).
 *   §C SERVICE-ACTOR MEDIA JOB — an approved topic master → ONE staged reel with NO session (the Director seam COUNTED), the
 *      creator owner apart from the service actor, replay stages nothing twice; unapproved / expired / no permission / a hard
 *      fair-housing flag (BIAS-003) → zero commissions.
 *   §D COMPLETION DISTRIBUTOR — the verified-playable render only (in-flight / failed render → nothing drafted, nothing marked
 *      distributed); a contact-addressed video never reaches public social; drafts are PENDING, never published; the handoff is
 *      a lineage row, not a post; the outcome names the true transport state.
 *   §E ANNIVERSARY — EXISTING VERIFIED: the lifetime arbiter returns exactly one of message / video / agent task / no touch.
 *   §F WIRING — the cron starts the job and checks egress before every publish call; the private video rides the door; the
 *      catalog maps the staged row; the product-promo end card mints through the one minter (155E carry-in).
 * SIMULATED: no provider and no model is called — the Director, ledger, fair-housing screen and playable resolver are injected
 * and every call is COUNTED; the DB is scripts/in-memory-supabase.ts.
 * BLIND SPOTS: hosted Remotion rendering is UNVERIFIED (license + hosting are the owner's); the tenant OAuth callback does not
 * store the granted scope, so in production most permissions read `unverified` (drafted, labeled; the provider is the final
 * check) until the Outside-lane fix lands; §F proves wiring, not deployment.
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

async function main() {
  const NOW = new Date()
  const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString()
  const DAY = 86_400_000

  // ── §A ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section("§A variant contract")
  const vc = await import("../lib/video/media-variant-contract")
  const { SOCIAL_OAUTH_CONFIGS } = await import("../lib/social/oauth-config")
  check("classifyMediaUrl: mp4 → video, png → image, no extension → unknown (never guessed)", vc.classifyMediaUrl("https://x.test/a/b.mp4?t=1") === "video" && vc.classifyMediaUrl("https://x.test/a.PNG") === "image" && vc.classifyMediaUrl("https://x.test/a") === "unknown")
  for (const [p, spec] of Object.entries(vc.VIDEO_VARIANT_ROUTES)) check(`${p}: the required scope is one the repo's own connect flow requests (${spec.requiredScope})`, SOCIAL_OAUTH_CONFIGS[spec.oauthProvider].scopes.includes(spec.requiredScope))
  const vid = { kind: "video" as const, playable: true, aspect: "1:1", durationSeconds: 45 }
  const granted = vc.decidePlatformVariant({ platform: "tiktok", account: { isActive: true, scope: "user.info.basic,video.publish,video.upload" }, media: vid })
  check("TikTok with video.publish granted → api_publish, permission granted", granted.ok && granted.route === "api_publish" && granted.permission === "granted", JSON.stringify(granted))
  const noPerm = vc.decidePlatformVariant({ platform: "tiktok", account: { isActive: true, scope: "user.info.basic" }, media: vid })
  check("NEGATIVE: TikTok connected WITHOUT video.publish → refused by name", !noPerm.ok && /without video\.publish/.test(noPerm.reason))
  check("NEGATIVE: not connected → refused", !vc.decidePlatformVariant({ platform: "youtube", account: null, media: vid }).ok)
  check("NEGATIVE: inactive connection → refused", !vc.decidePlatformVariant({ platform: "youtube", account: { isActive: false, scope: null }, media: vid }).ok)
  const unverified = vc.decidePlatformVariant({ platform: "youtube", account: { isActive: true, scope: null }, media: vid })
  check("scope not recorded → `unverified` (drafted, labeled), never upgraded to granted", unverified.ok && unverified.permission === "unverified")
  const script = vc.decidePlatformVariant({ platform: "tiktok", account: { isActive: true, scope: "video.publish" }, media: { ...vid, playable: false } })
  check("NEGATIVE: a script / failed render (not playable) → refused on every route", !script.ok && /script or a failed render/.test(script.reason))
  check("NEGATIVE: an image is not a video", !vc.decidePlatformVariant({ platform: "tiktok", account: { isActive: true, scope: "video.publish" }, media: { ...vid, kind: "image" } }).ok)
  check("NEGATIVE: a 16:9 cut on a vertical feed → refused (no crop invented)", !vc.decidePlatformVariant({ platform: "youtube", account: { isActive: true, scope: null }, media: { ...vid, aspect: "16:9" } }).ok)
  check("NEGATIVE: unknown aspect → refused (missing media metadata)", !vc.decidePlatformVariant({ platform: "youtube", account: { isActive: true, scope: null }, media: { ...vid, aspect: null } }).ok)
  check("NEGATIVE: 200 s on YouTube Shorts (60 s) → refused", !vc.decidePlatformVariant({ platform: "youtube", account: { isActive: true, scope: null }, media: { ...vid, durationSeconds: 200 } }).ok)
  const ig = vc.decidePlatformVariant({ platform: "instagram", account: { isActive: true, scope: null }, media: vid })
  check("Instagram (image-only publisher here) → export_handoff, never api_publish", ig.ok && ig.route === "export_handoff")
  check("Pinterest → refused: a still is never passed off as the video", !vc.decidePlatformVariant({ platform: "pinterest", account: { isActive: true, scope: "pins:write" }, media: vid }).ok)
  check("LinkedIn → no video route (the text master covers it)", !vc.decidePlatformVariant({ platform: "linkedin", account: { isActive: true, scope: null }, media: vid }).ok)
  check("EGRESS: a text-only post to TikTok is held — a text post is never presented as a video", !vc.mediaEgressVerdict("tiktok", []).ok)
  check("EGRESS: an image to TikTok is held", !vc.mediaEgressVerdict("tiktok", ["https://x.test/a.jpg"]).ok)
  check("EGRESS: a video to Instagram's image publisher is held (handoff)", !vc.mediaEgressVerdict("instagram", ["https://x.test/a.mp4"]).ok)
  check("EGRESS positive: an mp4 to TikTok passes; an unknown-kind URL passes to the provider; text to LinkedIn passes", vc.mediaEgressVerdict("tiktok", ["https://x.test/a.mp4"]).ok && vc.mediaEgressVerdict("youtube", ["https://x.test/blob/123"]).ok && vc.mediaEgressVerdict("linkedin", []).ok)

  // ── §B ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section("§B situation choice (G2)")
  const sc = await import("../lib/video/situation-artifact-choice")
  const { classifyPortalQuestion } = await import("../lib/portal/question-answer-decision")
  const { QUESTION_TOPIC_FLOOR } = await import("../lib/customer-intelligence/website-question-topics")
  const floor = QUESTION_TOPIC_FLOOR.minDistinctAskers
  const buyer = { type: "contact" as const, videoOptOut: false, playableVia: ["in_app", "email"] as any, writtenVia: ["in_app", "email"] as any }
  const base = { sourceFacts: [], recipient: buyer, producer: { avatarReady: true, renderReady: true }, agentAssigned: true }
  const qAppraisal = classifyPortalQuestion("What is an appraisal contingency?")
  check("the question classifier reads the appraisal-contingency question as general education", qAppraisal.kind === "general_education", qAppraisal.kind)
  const appraisal = sc.chooseSituationArtifact({ ...base, kind: "client_question", question: qAppraisal, distinctAskers: floor })
  check(`appraisal contingency asked by ${floor} (the topic floor) → an EDUCATIONAL VIDEO`, appraisal.chosen === "educational_video" && appraisal.delivery === "separately_governed", appraisal.why)
  const once = sc.chooseSituationArtifact({ ...base, kind: "client_question", question: qAppraisal, distinctAskers: floor - 1 })
  check("NEGATIVE: the same question asked once → a PLAIN ANSWER (a video is made when the question recurs)", once.chosen === "plain_answer", once.why)
  const qOwn = classifyPortalQuestion("When is our closing date?")
  const own = sc.chooseSituationArtifact({ ...base, kind: "client_question", question: qOwn, distinctAskers: 99 })
  check("NEGATIVE: a fact about their own deal → a PLAIN ANSWER even when asked often", qOwn.kind === "own_transaction" && own.chosen === "plain_answer", `${qOwn.kind} → ${own.chosen}`)
  const advice = sc.chooseSituationArtifact({ ...base, kind: "client_question", question: classifyPortalQuestion("Should I waive the appraisal contingency?"), distinctAskers: 99 })
  check("NEGATIVE: advice (should I waive…) → the AGENT, never a video, never AI advice", advice.chosen === "agent_task", advice.why)
  check("NEGATIVE: video opt-out → no video", sc.chooseSituationArtifact({ ...base, recipient: { ...buyer, videoOptOut: true }, kind: "client_question", question: qAppraisal, distinctAskers: 99 }).chosen === "plain_answer")
  check("unknown recurrence fails closed → plain answer", sc.chooseSituationArtifact({ ...base, kind: "client_question", question: qAppraisal, distinctAskers: null }).chosen === "plain_answer")
  const ready = sc.chooseSituationArtifact({ ...base, kind: "client_question", question: qAppraisal, distinctAskers: 1, approvedVideo: { table: "ai_video_projects", id: "v-ok" } })
  check("an APPROVED video on the topic is SENT (never a second one made)", ready.chosen === "educational_video" && ready.verb === "send")
  const cue = sc.chooseSituationArtifact({ ...base, kind: "client_question", question: classifyPortalQuestion("What is an appraisal contingency? We are a Hispanic family."), distinctAskers: floor })
  check("BIAS-005: identical except a protected-class cue → the same choice", cue.chosen === appraisal.chosen, `${cue.chosen} vs ${appraisal.chosen}`)
  const offersNoAgent = sc.chooseSituationArtifact({ ...base, kind: "competing_offers", agentAssigned: false })
  const offers = sc.chooseSituationArtifact({ ...base, kind: "competing_offers" })
  check("competing offers → an option-explainer DRAFT for the agent's review (never sent)", offers.chosen === "educational_video" && offers.verb === "draft")
  check("NEGATIVE: competing offers with no agent to review → nothing drafted", offersNoAgent.chosen === "no_touch")
  check("changed terms with no approved video → the portal card in words now", sc.chooseSituationArtifact({ ...base, kind: "terms_changed" }).chosen === "plain_answer")
  check("NEGATIVE: market evidence with no source / as-of date → no touch (nothing narrated)", sc.chooseSituationArtifact({ ...base, kind: "local_market_evidence", sourceFacts: [{ fact: "median up", source: "", asOf: null }] }).chosen === "no_touch")
  check("verified market evidence → a narrated video", sc.chooseSituationArtifact({ ...base, kind: "local_market_evidence", sourceFacts: [{ fact: "median up", source: "MLS export", asOf: iso(-DAY) }] }).chosen === "educational_video")
  const magnet = sc.chooseSituationArtifact({ ...base, recipient: { type: "audience", videoOptOut: false, playableVia: ["social"], writtenVia: ["social"] }, kind: "lead_magnet_topic", sourceFacts: [{ fact: "x", source: "approved", asOf: iso(0) }] })
  check("lead-magnet topic → a reel PLUS the evergreen guide", magnet.chosen === "educational_video" && magnet.artifacts.length === 2 && magnet.artifacts.includes("written_message"))
  check("anniversary → delegated to the lifetime arbiter (not re-decided)", sc.chooseSituationArtifact({ ...base, kind: "anniversary" }).chosen === "delegated")

  // ── §C ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section("§C service-actor media job (no session)")
  const am = await import("../lib/agents/asset-manager-actions")
  check("RED AT BASE: runApprovedTopicMediaJobs exists (d2d6468c had no producer for media_partial)", typeof (am as any).runApprovedTopicMediaJobs === "function")
  if (typeof (am as any).runApprovedTopicMediaJobs === "function") {
  const { platformScope, tenantScope } = await import("../lib/kernel/tenant-scope")
  const SCOPE = { scope: platformScope("guard: the cron's cross-tenant sweep") }
  const master = (over: Record<string, any> = {}) => ({ id: "post-1", brokerage_id: "b1", agent_id: "ag1", user_id: "u1", content: "Buying this spring? Here is what an appraisal contingency protects.", approval_status: "approved", ai_generated: true, approved_by: "approver-1", approved_at: iso(-3600_000), created_at: iso(-2 * DAY), post_brief: { source: "topic_refurbish", role: "master", topic_id: "t1", topic_expires_at: iso(5 * DAY), rights: "idea_only", media_partial: ["tiktok", "youtube", "instagram", "pinterest"] }, ...over })
  const accounts = [
    { id: "sa-tt", brokerage_id: "b1", agent_id: "ag1", platform: "tiktok", is_active: true, scope: "user.info.basic,video.publish,video.upload" },
    { id: "sa-yt", brokerage_id: "b1", agent_id: "ag1", platform: "youtube", is_active: true, scope: "openid" },
    { id: "sa-ig", brokerage_id: "b1", agent_id: "ag1", platform: "instagram", is_active: true, scope: null },
  ]
  const seams = () => {
    const c = { commission: [] as Array<{ situation: any; opts: any }>, record: [] as any[], screen: 0 }
    const deps = {
      commission: async (_s: any, situation: any, opts: any) => { c.commission.push({ situation, opts }); return { ok: true, status: c.commission.length > 1 ? "already_staged" : "staged", videoProjectId: "vp-1" } },
      record: async (_s: any, row: any) => { c.record.push(row); return { recorded: true } },
      screen: async (_s: any, a: { text: string }) => { c.screen++; return /families like ours|no kids/i.test(a.text) ? { hard: ["FairHousing: familial status steering"], escalated: true } : { hard: [], escalated: false } },
      now: () => NOW,
    }
    return { c, deps }
  }
  {
    const db = memSupabase({ social_posts: [master()], social_media_accounts: accounts.map((a) => ({ ...a })) })
    const { c, deps } = seams()
    const r = await am.runApprovedTopicMediaJobs(db as any, SCOPE,deps)
    const call = c.commission[0]
    check("an approved master → ONE reel staged by the service actor (Director seam COUNTED = 1)", r.commissioned === 1 && c.commission.length === 1, JSON.stringify(r))
    check("no session: the commission carries no cookie / session / impersonation field; autonomous = true", !!call && call.opts.autonomous === true && !Object.keys(call.opts).some((k) => /session|cookie|imperson/i.test(k)))
    const mj = call?.opts.extraMetadata?.media_job
    check("the record names the CREATOR OWNER apart from the SERVICE ACTOR that executed", mj?.creator_owner?.user_id === "u1" && mj?.executed_by?.type === "service" && mj?.executed_by?.manager === "asset_manager" && call?.opts.agentUserId === "u1")
    check("variants by connected permission: TikTok api_publish + Instagram handoff admitted; YouTube (no upload scope) and Pinterest refused", JSON.stringify(call?.opts.extraMetadata?.repurpose?.channels) === JSON.stringify(["tiktok", "instagram_reels"]) && mj?.refused_variants?.map((x: any) => x.platform).sort().join(",") === "pinterest,youtube", JSON.stringify(call?.opts.extraMetadata?.repurpose))
    check("the asset carries usage rights, source facts and privacy", mj?.usage_rights === "idea_only" && Array.isArray(mj?.source_facts) && mj.source_facts.length === 1 && mj?.privacy === "public_marketing")
    const stamped = db.tables.social_posts[0].post_brief?.media_job
    check("the master is stamped with the staged project (one commission per master)", stamped?.video_project_id === "vp-1")
    const send = c.record.find((x) => x.decision === "send_touch")
    check("one ledger decision row (marketing.decision.send_touch) whose subject IS the artifact source", c.record.length === 1 && send?.subject?.type === "social_posts" && send?.actor?.managerKey === "asset_manager")
    const r2 = await am.runApprovedTopicMediaJobs(db as any, SCOPE,deps)
    check("REPLAY: a second tick stages nothing (still 1 commission)", c.commission.length === 1 && r2.commissioned === 0 && r2.scanned === 0)
    check("nothing is published by the job (no social_posts row added, the master untouched but its stamp)", db.tables.social_posts.length === 1 && db.tables.social_posts[0].status === undefined)
  }
  {
    const db = memSupabase({ social_posts: [master({ approved_by: null })], social_media_accounts: accounts.map((a) => ({ ...a })) })
    const { c, deps } = seams()
    await am.runApprovedTopicMediaJobs(db as any, SCOPE,deps)
    check("NEGATIVE: a master nobody approved → zero commissions (the service never self-approves)", c.commission.length === 0)
  }
  {
    const db = memSupabase({ social_posts: [master()], social_media_accounts: accounts.map((a) => ({ ...a })) })
    const { c, deps } = seams()
    const r = await am.runApprovedTopicMediaJobs(db as any, { scope: tenantScope("b2", "guard") }, deps)
    check("NEGATIVE: another tenant's scope sees no master and stages nothing (cross-tenant)", c.commission.length === 0 && r.scanned === 0)
    let refused = false
    try { await am.runApprovedTopicMediaJobs(db as any, { scope: tenantScope(null, "guard") }, deps) } catch { refused = true }
    check("NEGATIVE: a missing tenant id REFUSES (never decays into every tenant)", refused && c.commission.length === 0)
  }
  {
    const db = memSupabase({ social_posts: [master({ post_brief: { ...master().post_brief, topic_expires_at: iso(-DAY) } })], social_media_accounts: accounts.map((a) => ({ ...a })) })
    const { c, deps } = seams()
    const r = await am.runApprovedTopicMediaJobs(db as any, SCOPE,deps)
    check("NEGATIVE: an expired topic → held, zero commissions (never produced late)", c.commission.length === 0 && r.held.length === 1 && c.record[0]?.decision === "do_nothing")
  }
  {
    const db = memSupabase({ social_posts: [master()], social_media_accounts: [{ ...accounts[1] }] })
    const { c, deps } = seams()
    const r = await am.runApprovedTopicMediaJobs(db as any, SCOPE,deps)
    check("NEGATIVE: no platform with permission → held, zero commissions, nothing spent", c.commission.length === 0 && /no platform may carry a video/.test(r.held[0]?.reason ?? ""), r.held[0]?.reason)
  }
  {
    const db = memSupabase({ social_posts: [master({ content: "Perfect for families like ours — no kids allowed nearby." })], social_media_accounts: accounts.map((a) => ({ ...a })) })
    const { c, deps } = seams()
    const r = await am.runApprovedTopicMediaJobs(db as any, SCOPE,deps)
    check("BIAS-003: a hard fair-housing flag in what the reel would say → escalated to a person, zero commissions", c.commission.length === 0 && c.screen === 1 && /escalated to a person/.test(r.held[0]?.reason ?? ""), r.held[0]?.reason)
  }
  {
    const db = memSupabase({ social_posts: [master()], social_media_accounts: accounts.map((a) => ({ ...a })) })
    const { c, deps } = seams()
    const r = await am.runApprovedTopicMediaJobs(db as any, SCOPE,{ ...deps, commission: async (_s: any, situation: any, opts: any) => { c.commission.push({ situation, opts }); return { ok: false, status: "blocked", reason: "video excluded by tier" } } })
    check("NEGATIVE: a refused commission is HELD, the master is NOT stamped (nothing claimed as produced)", r.commissioned === 0 && r.held.length === 1 && !db.tables.social_posts[0].post_brief.media_job)
  }
  } // §C runs only where the job exists (a base run reports the one red above and continues)

  // ── §D ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section("§D completion distributor")
  const { distributeRepurposedVideoAsDraft } = await import("../lib/repurpose/distribute")
  const project = (over: Record<string, any> = {}) => ({ id: "vp-1", brokerage_id: "b1", agent_id: "ag1", title: "Topic reel", video_url: "https://cdn.test/raw.mp4", video_type: "education", contact_id: null, audience_type: "customer_facing", usage_intent: "public_marketing", approval_status: "pending_review", status: "completed", compliance_status: "passed", format: "1:1", duration_seconds: 45,
    video_metadata: { repurpose: { channels: ["tiktok", "instagram_reels", "youtube_shorts"], distribute_as_draft: true }, media_job: { creator_owner: { user_id: "u1", agent_id: "ag1" }, executed_by: { type: "service", manager: "asset_manager" }, master_post_id: "post-1", topic_id: "t1" }, content_kit: { built_at: iso(0), instagram_caption: "What an appraisal contingency protects.", facebook_caption: "f", linkedin_caption: "l", gbp_post: "g", hashtags: ["homebuying"] } }, ...over })
  const seed = (p: Record<string, any>) => memSupabase({ ai_video_projects: [p], agents: [{ id: "ag1", brokerage_id: "b1", user_id: "u1" }], social_media_accounts: [
    { id: "sa-tt", brokerage_id: "b1", agent_id: "ag1", platform: "tiktok", is_active: true, scope: "video.publish" },
    { id: "sa-ig", brokerage_id: "b1", agent_id: "ag1", platform: "instagram", is_active: true, scope: null },
    { id: "sa-yt", brokerage_id: "b1", agent_id: "ag1", platform: "youtube", is_active: true, scope: "openid" },
  ], social_posts: [], repurposed_content_log: [] })
  let playableCalls = 0
  const readyDeps = { playable: async () => { playableCalls++; return { state: "ready" as const, videoUrl: "https://cdn.test/hosted/vp-1.mp4", thumbnailUrl: null } } }
  {
    const db = seed(project())
    const r = await distributeRepurposedVideoAsDraft(db as any, "vp-1", readyDeps)
    const posts = db.tables.social_posts
    const tt = posts.find((p) => p.platform === "tiktok")
    check("a ready render → ONE TikTok draft, PENDING approval (never published)", r.created === 1 && posts.length === 1 && tt?.status === "draft" && tt?.approval_status === "pending", JSON.stringify(r))
    check("the draft carries the VERIFIED-PLAYABLE url, not the raw column", JSON.stringify(tt?.media_urls) === JSON.stringify(["https://cdn.test/hosted/vp-1.mp4"]))
    check("the draft names the variant route / permission and the creator owner apart from the service actor", tt?.post_brief?.variant?.route === "api_publish" && tt?.post_brief?.variant?.permission === "granted" && tt?.post_brief?.creator_owner?.user_id === "u1" && tt?.post_brief?.executed_by?.type === "service" && tt?.user_id === "u1")
    const handoff = db.tables.repurposed_content_log.find((x) => x.platform_target === "instagram")
    check("Instagram → an EXPORT / HANDOFF lineage row, not a social post (true transport state)", r.handoffs === 1 && !posts.some((p) => p.platform === "instagram") && /never published by API/.test(handoff?.notes ?? ""))
    check("YouTube connected without the upload scope → refused by name in the outcome", (r.refused ?? []).some((x) => x.platform === "youtube" && /youtube\.upload/.test(x.reason)))
    check("the project is marked distributed (a replay drafts nothing)", db.tables.ai_video_projects[0].video_metadata.repurpose.distributed === true)
    const again = await distributeRepurposedVideoAsDraft(db as any, "vp-1", readyDeps)
    check("REPLAY: no second draft", again.created === 0 && db.tables.social_posts.length === 1)
  }
  for (const [label, state] of [["in-flight", { state: "in_progress" as const }], ["failed", { state: "none" as const, reason: "render failed" }]] as const) {
    const db = seed(project())
    const r = await distributeRepurposedVideoAsDraft(db as any, "vp-1", { playable: async () => state as any })
    check(`NEGATIVE: a ${label} render → nothing drafted, NOT marked distributed (a failed render is not a published video)`, r.created === 0 && db.tables.social_posts.length === 0 && !db.tables.ai_video_projects[0].video_metadata.repurpose.distributed, JSON.stringify(r))
  }
  {
    const db = seed(project({ contact_id: "c-9" }))
    playableCalls = 0
    const r = await distributeRepurposedVideoAsDraft(db as any, "vp-1", readyDeps)
    check("NEGATIVE: a contact-addressed (private) video never reaches public social — refused before the media is even resolved", r.created === 0 && db.tables.social_posts.length === 0 && playableCalls === 0 && /door/.test(r.error ?? ""), r.error)
  }
  {
    const db = seed(project({ format: "16:9" }))
    const r = await distributeRepurposedVideoAsDraft(db as any, "vp-1", readyDeps)
    check("NEGATIVE: a landscape render → no vertical-feed draft (variant appropriate to platform)", r.created === 0 && (r.refused ?? []).some((x) => x.platform === "tiktok"))
  }

  // ── §E ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section("§E anniversary — EXISTING VERIFIED (lib/sphere/lifetime-touch-arbitration.ts)")
  const lt = await import("../lib/sphere/lifetime-touch-arbitration")
  const ctx = (over: Record<string, any> = {}) => ({ contact: { found: true, hasEmail: true, hasLogin: true, videoOptOut: false, preferredTime: null, timeZone: null }, lawful: { ok: true as const, lawful: ["email", "in_app"] as any, refusals: {} }, ownership: { owner: "ai" as const, why: "no person in it" }, inboundAts: [], avatar: { ok: true, why: "on file" }, videoThisYear: { id: null, status: null }, fatigue: null, policy: { sendWindow: { startHour: 0, endHour: 24 }, maxDeferDays: 1 }, blindSpots: [], ...over })
  const input = (over: Record<string, any> = {}) => ({ brokerageId: "b1", contactId: "c1", agentId: "ag1", kind: "anniversary" as const, channel: "email" as const, yearsAgo: 3, transactionId: "tx1", now: NOW, ...over })
  const verdicts: string[] = []
  for (const choice of ["send_now", "avatar_greeting", "agent_personally"]) {
    const db = memSupabase({ orchestrator_tasks: [], action_ledger: [] })
    const d = await lt.arbitrateLifetimeTouch(db as any, input(), { context: async () => ctx() as any, arbitrate: async () => ({ choice, decision: { waitHours: null, rationale: `chose ${choice}`, source: "deterministic" } }), routeToAgent: async () => true, requestVideo: async () => ({ ok: true, status: "queued", introVideoId: "iv-1" }) })
    verdicts.push(d.verdict)
  }
  const quiet = await lt.arbitrateLifetimeTouch(memSupabase({ action_ledger: [] }) as any, input({ agentId: null }), { context: async () => ctx({ fatigue: "high" }) as any, arbitrate: async () => { throw new Error("must not be asked") } })
  verdicts.push(quiet.verdict)
  check("the anniversary resolves to exactly one of message / video / agent task / no touch", JSON.stringify(verdicts) === JSON.stringify(["send", "video", "agent", "no_action"]), verdicts.join(","))

  // ── §F ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  section("§F wiring (stripped source)")
  const cron = code("app/api/cron/publish-social-posts/route.ts")
  check("the cron starts the service-actor media job", /runApprovedTopicMediaJobs\s*\(/.test(cron))
  const egressAt = [...cron.matchAll(/mediaEgressVerdict\s*\(/g)].map((m) => m.index ?? 0)
  const publishAt = [...cron.matchAll(/publishToSocialPlatform\s*\(/g)].map((m) => m.index ?? 0)
  check("POSITIVE CONTROL: the cron has two publish calls", publishAt.length === 2, String(publishAt.length))
  check("every publish call is preceded by its own egress check", publishAt.length > 0 && publishAt.every((p, i) => egressAt[i] !== undefined && egressAt[i] < p && (i === 0 || egressAt[i] > publishAt[i - 1])))
  check("the private client video is shared only through the door (grantDoorLinksInText)", /grantDoorLinksInText\s*\(/.test(code("lib/video/client-video-delivery.ts")))
  const { documentOpenHref, toDocumentRef } = await import("../lib/storage/signed-doc-url")
  const door = documentOpenHref(toDocumentRef("personal-videos", "b1/vp-9.mp4"))
  check("a docref:// private video opens at the door, never a storage URL", !!door && door.startsWith("/api/documents/open") && !/supabase|storage\/v1/.test(door), String(door))
  const { CONTENT_CATALOG_SOURCES } = await import("../lib/marketing/content-catalog")
  const vsrc = CONTENT_CATALOG_SOURCES.find((s) => s.table === "ai_video_projects")
  const entry = vsrc?.map({ id: "vp-1", agent_id: "ag1", title: "Topic reel", status: "queued", approval_status: "pending_review", video_type: "education", contact_id: null, marketing_campaign_id: null, created_at: iso(0) } as any) as any
  check("the staged reel lands in the catalog as a video ARTIFACT (queued — not posted)", !!entry && entry.status === "queued" && Array.isArray(entry.channels) && !entry.channels.includes("video"), JSON.stringify(entry ?? null).slice(0, 200))
  const promo = code("lib/platform/product-content-autopilot.ts")
  check("155E carry-in: the product-promo end card mints through the ONE minter and sets qrCodeDataUrl", /mintTrackedQr\s*\(/.test(promo) && /qrCodeDataUrl:\s*minted\?\.qrCodeDataUrl\s*\?\?\s*null/.test(promo))
  check("POSITIVE CONTROL: the scanner sees a token it should (the cron's own publish call)", /publishToSocialPlatform\s*\(/.test(cron))

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) { console.log(`FAILED:\n  - ${failures.join("\n  - ")}`); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
