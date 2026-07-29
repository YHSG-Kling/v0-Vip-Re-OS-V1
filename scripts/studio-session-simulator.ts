#!/usr/bin/env tsx
/**
 * scripts/studio-session-simulator.ts — Voice Studio Session batch proof.
 *
 * "Book me a week of content" — one spoken command plans + commissions a GATED
 * content calendar of reels across upcoming dates, each routed through the existing
 * Video Director, each landing in the approval queue (pending_review). Nothing
 * auto-publishes.
 *
 * Layer 1 (pure, always runs):
 *   · normalizeStudioSessionDuration: spoken phrase → duration label
 *   · isStudioSessionCommand: recognition gate
 *   · daysForLabel: duration → day count
 *   · upcomingWeekdays (via planStudioSession): spread across Mon–Fri
 *   · compositionHintFor: situation+channel → expected composition hint
 *   · planStudioSession: context → typed batch plan (formats × dates)
 *   · composeSessionPreviewSpoken / composeSessionCommissionSpoken: spoken text
 *
 * Layer 2 (live, gated by SUPABASE_SERVICE_ROLE_KEY):
 *   · Seed a REAL brokerage + REAL agent user + REAL listings (no mocks)
 *   · Run commissionStudioSession → assert N ai_video_projects at pending_review
 *   · Assert studio_sessions anchor row created
 *   · Assert ai_video_projects.studio_session_id linked
 *   · Idempotent re-run → already_commissioned, no duplicate rows
 *   · Reverse-delete ALL test data + assert cleanup count == 0
 *
 * Run: npx tsx scripts/studio-session-simulator.ts  (npm run test:studio-session)
 */

import {
  normalizeStudioSessionDuration,
  isStudioSessionCommand,
  daysForLabel,
  compositionHintFor,
  planStudioSession,
  composeSessionPreviewSpoken,
  composeSessionCommissionSpoken,
  commissionStudioSession,
  type StudioSessionContext,
  type StudioSessionPlan,
} from "../lib/voice/studio-session"
import type { SituationKind, TargetChannel } from "../lib/video/video-director"

// ─── Test harness ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0
const fails: string[] = []
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    fails.push(name + (detail ? ` — ${detail}` : ""))
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}
const report = () => {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed) {
    for (const f of fails) console.log("   - " + f)
    process.exit(1)
  }
  console.log(" ✅ Studio Session verified — voice batch + content calendar + gated commissioning")
}

// ─── Layer 1: Pure tests ───────────────────────────────────────────────────────
async function main() {
  console.log("══ Studio Session simulator ══\n[Layer 1 · pure planner]")

  // isStudioSessionCommand recognizes the right phrases
  check("'book me a week of content' recognized", isStudioSessionCommand("book me a week of content"))
  check("'schedule a month of reels' recognized", isStudioSessionCommand("schedule a month of reels"))
  check("'plan my content calendar for the week' recognized", isStudioSessionCommand("plan my content calendar for the week"))
  check("'line up a week of videos' recognized", isStudioSessionCommand("line up a week of videos"))
  check("general queries not recognized", !isStudioSessionCommand("what closings are at risk"))
  check("single video commission not recognized", !isStudioSessionCommand("make a market update reel for Instagram"))

  // normalizeStudioSessionDuration
  check("'week' → 'week'", normalizeStudioSessionDuration("book me a week of content") === "week")
  check("'month' → 'month'", normalizeStudioSessionDuration("schedule a month of reels") === "month")
  check("'2 weeks' → '2 weeks'", normalizeStudioSessionDuration("plan 2 weeks of content") === "2 weeks")
  check("'3 days' → '3 days'", normalizeStudioSessionDuration("give me 3 days of content") === "3 days")
  check("default → 'week'", normalizeStudioSessionDuration("plan my content") === "week")

  // daysForLabel
  check("'week' → 5 days", daysForLabel("week") === 5)
  check("'month' → 20 days", daysForLabel("month") === 20)
  check("'2 weeks' → 10 days", daysForLabel("2 weeks") === 10)
  check("'3 days' → 3 days", daysForLabel("3 days") === 3)
  check("'day' → 1 day", daysForLabel("day") === 1)

  // compositionHintFor
  const ALL_KINDS: SituationKind[] = [
    "new_listing", "price_drop", "just_sold", "open_house", "coming_soon",
    "market_update", "cma", "explainer", "presentation", "anniversary",
    "testimonial", "neighborhood",
  ]
  const ALL_CHANNELS: TargetChannel[] = ["tiktok", "instagram", "youtube", "facebook", "email", "portal"]
  let hintOk = true
  for (const kind of ALL_KINDS) {
    for (const channel of ALL_CHANNELS) {
      const hint = compositionHintFor(kind, channel)
      if (!hint || hint.length === 0) { hintOk = false; break }
    }
  }
  check("compositionHintFor returns a non-empty hint for every kind×channel", hintOk)
  check("new_listing × instagram → JustListedReelSquare", compositionHintFor("new_listing", "instagram") === "JustListedReelSquare")
  check("new_listing × youtube → JustListedReelHorizontal", compositionHintFor("new_listing", "youtube") === "JustListedReelHorizontal")
  check("market_update → MarketUpdateReel", compositionHintFor("market_update", "instagram") === "MarketUpdateReel")
  check("explainer → AgentExplainerReel", compositionHintFor("explainer", "tiktok") === "AgentExplainerReel")
  check("anniversary → EquityReportReel", compositionHintFor("anniversary", "email") === "EquityReportReel")

  // planStudioSession — week plan with listings
  const TODAY = "2026-06-13" // Friday; next weekdays are Mon 16 → Fri 20
  const twoListings = [
    { id: "l1", address: "44 Birch Lane" },
    { id: "l2", address: "100 Maple Ave" },
  ]
  const defaultTopics = [
    { kind: "market_update" as SituationKind, label: "local market update" },
    { kind: "neighborhood"  as SituationKind, label: "neighborhood spotlight" },
    { kind: "explainer"     as SituationKind, label: "buyer/seller explainer" },
    { kind: "testimonial"   as SituationKind, label: "client testimonial" },
  ]
  const weekCtx: StudioSessionContext = {
    activeListings: twoListings,
    topics: defaultTopics,
    today: TODAY,
    primaryChannel: "instagram",
  }
  const weekPlan = planStudioSession("week", weekCtx)

  check("week plan has exactly 5 items", weekPlan.items.length === 5)
  check("week plan durationLabel is 'week'", weekPlan.durationLabel === "week")
  check("all items have a valid kind", weekPlan.items.every((it) => ALL_KINDS.includes(it.kind)))
  check("all items target instagram (the context channel)", weekPlan.items.every((it) => it.targetChannel === "instagram"))
  check("all items have a scheduledFor date (YYYY-MM-DD)", weekPlan.items.every((it) => /^\d{4}-\d{2}-\d{2}$/.test(it.scheduledFor)))
  check("scheduled dates are ascending (no out-of-order)", weekPlan.items.every((it, i) => i === 0 || it.scheduledFor >= weekPlan.items[i - 1].scheduledFor))
  check("scheduled dates are weekdays (Mon–Fri)", weekPlan.items.every((it) => {
    const dow = new Date(it.scheduledFor + "T12:00:00Z").getUTCDay()
    return dow >= 1 && dow <= 5
  }))
  check("all items have a compositionHint", weekPlan.items.every((it) => !!it.compositionHint))
  check("listing items reference real listing ids", weekPlan.items.filter((it) => it.entityRef.type === "listing").every((it) => {
    const ref = it.entityRef
    return ref.type === "listing" && twoListings.some((l) => l.id === ref.id)
  }))
  check("topic items reference topic labels", weekPlan.items.filter((it) => it.entityRef.type === "topic").every((it) => {
    const ref = it.entityRef
    return ref.type === "topic" && typeof ref.label === "string" && ref.label.length > 0
  }))
  check("plan preview spoken is non-empty", weekPlan.previewSpoken.length > 0)
  check("plan preview mentions 'week'", weekPlan.previewSpoken.toLowerCase().includes("week"))
  check("plan preview mentions 'approval'", weekPlan.previewSpoken.toLowerCase().includes("approval"))

  // planStudioSession — day plan (single item)
  const dayPlan = planStudioSession("day", weekCtx)
  check("day plan has exactly 1 item", dayPlan.items.length === 1)
  check("day plan durationLabel is 'day'", dayPlan.durationLabel === "day")

  // planStudioSession — no listings → all evergreen
  const noListingCtx: StudioSessionContext = {
    activeListings: [],
    topics: defaultTopics,
    today: TODAY,
    primaryChannel: "tiktok",
  }
  const noListingPlan = planStudioSession("week", noListingCtx)
  check("no-listing plan still produces 5 items from topics", noListingPlan.items.length === 5)
  check("no-listing plan items are all topic type", noListingPlan.items.every((it) => it.entityRef.type === "topic"))

  // Determinism: same inputs → same plan
  const weekPlan2 = planStudioSession("week", weekCtx)
  check("plan is deterministic (same inputs → same output)", JSON.stringify(weekPlan.items) === JSON.stringify(weekPlan2.items))

  // composeSessionPreviewSpoken
  const previewText = composeSessionPreviewSpoken({
    durationLabel: "week",
    items: weekPlan.items,
    listingItems: weekPlan.items.filter((it) => it.entityRef.type === "listing"),
    topicItems: weekPlan.items.filter((it) => it.entityRef.type === "topic"),
  })
  check("preview text is non-empty and mentions 'approval'", previewText.length > 0 && previewText.toLowerCase().includes("approval"))
  check("empty items → 'nothing to schedule'", composeSessionPreviewSpoken({ durationLabel: "week", items: [], listingItems: [], topicItems: [] }).includes("nothing"))

  // composeSessionCommissionSpoken
  const commSpoken = composeSessionCommissionSpoken({ plan: weekPlan, commissioned: 5, skipped: 0, videoProjectIds: ["a","b","c","d","e"] })
  check("commission spoken confirms 5 reels staged", commSpoken.includes("5"))
  check("commission spoken mentions approval", commSpoken.toLowerCase().includes("approv"))
  check("commission spoken mentions compliance", commSpoken.toLowerCase().includes("compliance"))
  const zeroSpoken = composeSessionCommissionSpoken({ plan: weekPlan, commissioned: 0, skipped: 5, videoProjectIds: [] })
  check("zero-commission spoken mentions 'compliance gate'", zeroSpoken.toLowerCase().includes("compliance"))

  // ── Layer 2 (live) ──────────────────────────────────────────────────────────
  const hasCreds =
    !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)

  if (!hasCreds) {
    console.log("\n[Layer 2] ⏭  Skipped — SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  console.log("\n[Layer 2 · live — seed → commission → assert → idempotent → cleanup]")

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()

  // ── Seed: find or create a test brokerage + test user ────────────────────────
  // Reuse an existing test brokerage if present, else insert a minimal one.
  const testBrokerageName = "__STUDIO_SESSION_SIM_BROKERAGE__"
  let brokerageId: string
  {
    const { data: existing } = await svc
      .from("brokerages")
      .select("id")
      .eq("name", testBrokerageName)
      .maybeSingle()
    if (existing?.id) {
      brokerageId = (existing as { id: string }).id
    } else {
      const { data: ins, error } = await svc
        .from("brokerages")
        .insert({ name: testBrokerageName, plan_tier: "solo_agent" })
        .select("id")
        .single()
      if (error || !ins) { console.error("brokerage seed failed:", error); process.exit(1) }
      brokerageId = (ins as { id: string }).id
    }
  }
  console.log(`  brokerage seeded: ${brokerageId}`)

  // Seed a test user in users (not auth.users — the Director only needs users.id)
  const testEmail = `__sim_studio_session_${Date.now()}@example.com`
  let agentUserId: string
  {
    const { data: ins, error } = await svc
      .from("users")
      .insert({
        email: testEmail,
        first_name: "Sim",
        last_name: "StudioAgent",
        user_type: "agent",
        brokerage_id: brokerageId,
      })
      .select("id")
      .single()
    if (error || !ins) { console.error("user seed failed:", error); process.exit(1) }
    agentUserId = (ins as { id: string }).id
  }
  console.log(`  agent user seeded: ${agentUserId}`)

  // Seed 2 active listings
  const listingAddresses = ["44 Birch Lane, Springfield", "100 Maple Ave, Oakdale"]
  const listingIds: string[] = []
  for (const addr of listingAddresses) {
    const { data: ins, error } = await svc
      .from("listings")
      .insert({
        address: addr,
        brokerage_id: brokerageId,
        agent_id: agentUserId,
        status: "active",
      })
      .select("id")
      .single()
    if (error || !ins) { console.error("listing seed failed:", error); process.exit(1) }
    listingIds.push((ins as { id: string }).id)
  }
  console.log(`  listings seeded: ${listingIds.length}`)

  // ── Run the studio session ──────────────────────────────────────────────────
  const liveCtx: StudioSessionContext = {
    activeListings: listingAddresses.map((addr, i) => ({ id: listingIds[i], address: addr })),
    topics: [
      { kind: "market_update" as SituationKind, label: "local market update" },
      { kind: "neighborhood"  as SituationKind, label: "neighborhood spotlight" },
      { kind: "explainer"     as SituationKind, label: "buyer explainer" },
      { kind: "testimonial"   as SituationKind, label: "client testimonial" },
    ],
    today: new Date().toISOString().slice(0, 10),
    primaryChannel: "instagram",
  }
  const livePlan = planStudioSession("week", liveCtx)
  check("live plan has 5 items", livePlan.items.length === 5)

  // Use a deterministic session key for idempotency testing
  const sessionKey = `test:studio:${brokerageId}:${agentUserId}:week:${liveCtx.today}`

  const r = await commissionStudioSession(livePlan, {
    brokerageId,
    agentUserId,
    spokenCommand: "book me a week of content",
    // No copyGenerator → deterministic fallback hooks (no AI spend in test)
    sessionKey,
  }, svc)

  console.log(`  commission result: status=${r.status}, commissioned=${r.commissioned}, skipped=${r.skipped}`)
  check("commission ok or partial (at least 1 staged)", r.ok || r.commissioned > 0)
  check("session id returned", !!r.sessionId)
  check("session key returned matches", r.sessionKey === sessionKey)
  check("at least 1 video project staged", r.videoProjectIds.length > 0)
  check("spoken response non-empty", r.spoken.length > 0)

  // Assert the studio_sessions anchor row exists
  const { data: sessionRow } = await svc
    .from("studio_sessions")
    .select("id, status, commissioned_count, skipped_count, session_key, duration_label")
    .eq("id", r.sessionId!)
    .maybeSingle()
  check("studio_sessions anchor row created", !!sessionRow)
  check("session duration_label is 'week'", (sessionRow as Record<string, unknown>)?.duration_label === "week")
  check("session session_key matches", (sessionRow as Record<string, unknown>)?.session_key === sessionKey)
  check("session commissioned_count matches", (sessionRow as Record<string, unknown>)?.commissioned_count === r.commissioned)

  // Assert staged ai_video_projects are at pending_review
  const { data: videoRows } = await svc
    .from("ai_video_projects")
    .select("id, approval_status, studio_session_id, brokerage_id")
    .in("id", r.videoProjectIds)
  const videoArr = (videoRows ?? []) as Array<{ id: string; approval_status: string; studio_session_id: string | null; brokerage_id: string }>
  check("all staged videos are at pending_review (gated)", videoArr.every((v) => v.approval_status === "pending_review"))
  check("all staged videos link back to the session", videoArr.every((v) => v.studio_session_id === r.sessionId))
  check("all staged videos scoped to the brokerage", videoArr.every((v) => v.brokerage_id === brokerageId))

  // ── Idempotent re-run ─────────────────────────────────────────────────────
  const r2 = await commissionStudioSession(livePlan, {
    brokerageId,
    agentUserId,
    spokenCommand: "book me a week of content (re-run)",
    sessionKey,
  }, svc)
  check("idempotent re-run → already_commissioned", r2.status === "already_commissioned")
  check("idempotent re-run returns same sessionId", r2.sessionId === r.sessionId)
  check("idempotent re-run spoken mentions 'already in the pipeline'", r2.spoken.includes("already in the pipeline"))

  // Count rows before cleanup
  const { count: countBefore } = await svc
    .from("ai_video_projects")
    .select("id", { count: "exact", head: true })
    .in("id", r.videoProjectIds)
  check(`video rows exist before cleanup (count=${countBefore ?? 0})`, (countBefore ?? 0) > 0)

  // ── Cleanup: reverse-delete ALL test data ────────────────────────────────
  // Delete video projects (FK to studio_sessions is SET NULL on delete)
  await svc.from("ai_video_projects").delete().in("id", r.videoProjectIds)

  // Delete studio_sessions
  await svc.from("studio_sessions").delete().eq("id", r.sessionId!)

  // Delete listings
  await svc.from("listings").delete().in("id", listingIds)

  // Delete user
  await svc.from("users").delete().eq("id", agentUserId)

  // Delete brokerage (cascade deletes remaining FK'd rows)
  await svc.from("brokerages").delete().eq("id", brokerageId)

  // Assert cleanup: no ai_video_projects rows remain
  const { count: vpAfter } = await svc
    .from("ai_video_projects")
    .select("id", { count: "exact", head: true })
    .in("id", r.videoProjectIds)
  check("cleanup: ai_video_projects cleanup count == 0", (vpAfter ?? 0) === 0)

  // Assert cleanup: no studio_sessions row remains
  const { data: sessionAfter } = await svc
    .from("studio_sessions")
    .select("id")
    .eq("id", r.sessionId!)
    .maybeSingle()
  check("cleanup: studio_sessions row removed", !sessionAfter)

  // Assert cleanup: no listings remain
  const { count: listingAfter } = await svc
    .from("listings")
    .select("id", { count: "exact", head: true })
    .in("id", listingIds)
  check("cleanup: listings cleanup count == 0", (listingAfter ?? 0) === 0)

  // Assert cleanup: no brokerage remains
  const { data: brokerageAfter } = await svc
    .from("brokerages")
    .select("id")
    .eq("id", brokerageId)
    .maybeSingle()
  check("cleanup: brokerage removed", !brokerageAfter)

  report()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
