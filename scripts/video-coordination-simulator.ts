#!/usr/bin/env tsx
/**
 * scripts/video-coordination-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * VIDEO COORDINATION harness — a finished render becomes ONE coordinated TEAM
 * deliverable on the inter-manager bus, proven end-to-end.
 *
 * Layer 1 (pure): the kind → target-manager routing + which kinds are promotable.
 *   · isPromotableVideoKind  — just_listed/just_sold/open_house promotable; others not.
 *   · videoReadyTargets      — campaign_orchestrator ALWAYS; ads_manager promotable-only.
 *
 * Layer 2 (live, gated by SUPABASE_SERVICE_ROLE_KEY):
 *   · seed a COMPLETED ai_video_projects row (promotable kind, video_url set) →
 *   · publishVideoCoordinationSignals (the Asset Manager completion publisher) →
 *     assert manager_signals rows to BOTH campaign_orchestrator AND ads_manager →
 *   · consumeManagerSignals(campaign_orchestrator): a GATED social draft proposed
 *     (status='draft', approval_status='pending' — nothing auto-publishes) →
 *   · consumeManagerSignals(ads_manager): an ad_manager_actions row proposed →
 *   · idempotent rerun — publisher dedupes (no new signals), handlers no-op (no dupes) →
 *   · seed a FAILED project → publisher fires campaign_orchestrator:video_compliance_failed →
 *     consume escalates (notifications, no distribution/spend) →
 *   · loadRecentManagerTalk shows the Asset Manager → Orchestrator/Ads conversation.
 * Reverse-deletes every seeded row; asserts cleanup count == 0.
 *
 * Run: npx tsx scripts/video-coordination-simulator.ts  (npm run test:video-coordination)
 */
import {
  isPromotableVideoKind,
  videoReadyTargets,
  resolveVideoKind,
  publishVideoCoordinationSignals,
  PROMOTABLE_VIDEO_KINDS,
} from "../lib/kernel/video-coordination"
import { consumeManagerSignals, loadRecentManagerTalk } from "../lib/kernel/manager-signals"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" VIDEO_COORDINATION_PASS")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Video coordination (one team deliverable) simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · pure — kind → target-manager routing + promotable kinds]")
  for (const k of PROMOTABLE_VIDEO_KINDS) {
    check(`promotable: ${k} is promotable`, isPromotableVideoKind(k))
  }
  check("promotable: open_house_announce normalizes to open_house (promotable)", isPromotableVideoKind("open_house_announce"))
  check("promotable: market_update is NOT promotable", !isPromotableVideoKind("market_update"))
  check("promotable: coming_soon is NOT promotable", !isPromotableVideoKind("coming_soon"))
  check("promotable: null kind is NOT promotable", !isPromotableVideoKind(null))
  check("routing: promotable kind → BOTH campaign_orchestrator + ads_manager",
    JSON.stringify(videoReadyTargets("just_listed")) === JSON.stringify(["campaign_orchestrator", "ads_manager"]))
  check("routing: non-promotable kind → campaign_orchestrator ONLY",
    JSON.stringify(videoReadyTargets("market_update")) === JSON.stringify(["campaign_orchestrator"]))
  check("routing: every list always starts with campaign_orchestrator (always distribute)",
    videoReadyTargets(null)[0] === "campaign_orchestrator")
  check("resolveVideoKind: prefers video_metadata.promo_event_type over video_type",
    resolveVideoKind({ video_metadata: { promo_event_type: "just_sold" }, video_type: "listing_promo" }) === "just_sold")
  check("resolveVideoKind: falls back to video_type when no promo_event_type",
    resolveVideoKind({ video_metadata: {}, video_type: "market_update" }) === "market_update")

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live coordinated deliverable]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `__vidcoord_${Date.now()}__`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    // Pick a real brokerage that has a user (ai_video_projects.agent_id FKs users.id, NOT NULL).
    const { data: seed } = await svc
      .from("users")
      .select("id, brokerage_id")
      .not("brokerage_id", "is", null)
      .limit(1)
      .single()
    const brokerageId = (seed as any).brokerage_id as string
    const agentUserId = (seed as any).id as string

    // ── Seed a COMPLETED, promotable (just_listed) render ──
    const { data: proj } = await svc.from("ai_video_projects").insert({
      brokerage_id: brokerageId,
      agent_id: agentUserId,
      title: `${TAG} Just Listed reel`,
      video_type: "listing_promo",
      video_metadata: { promo_event_type: "just_listed", sim: TAG },
      status: "completed",
      video_url: `https://example.test/${TAG}.mp4`,
      completed_at: new Date().toISOString(),
    }).select("id").single()
    const projectId = (proj as any).id as string
    cleanup.push({ table: "ai_video_projects", id: projectId })

    // ── PUBLISH: the Asset Manager announces the finished render on the bus ──
    const pub = await publishVideoCoordinationSignals(projectId, svc)
    check("publish: ok with both targets reached", pub.ok && pub.published.length === 2)

    const { data: sigs } = await svc.from("manager_signals")
      .select("id, from_manager, to_manager, signal_type, status")
      .eq("entity_id", projectId).eq("signal_type", "video_ready")
    for (const s of (sigs ?? []) as any[]) cleanup.push({ table: "manager_signals", id: s.id })
    const toCO = (sigs ?? []).find((s: any) => s.to_manager === "campaign_orchestrator")
    const toAds = (sigs ?? []).find((s: any) => s.to_manager === "ads_manager")
    check("publish: signal to campaign_orchestrator (distribute) — from asset_manager, open",
      !!toCO && (toCO as any).from_manager === "asset_manager" && (toCO as any).status === "open")
    check("publish: signal to ads_manager (promote) — from asset_manager, open",
      !!toAds && (toAds as any).from_manager === "asset_manager" && (toAds as any).status === "open")

    // ── CONSUME (Campaign Orchestrator): propose a GATED multi-channel distribution ──
    const cCO = await consumeManagerSignals({ brokerageId, toManager: "campaign_orchestrator" }, svc)
    check("consume: campaign_orchestrator consumed video_ready", cCO.consumed >= 1)
    const { data: draft } = await svc.from("social_posts")
      .select("id, status, approval_status, platform, media_urls")
      .contains("media_urls", [`https://example.test/${TAG}.mp4`]).limit(1).maybeSingle()
    if (draft) cleanup.push({ table: "social_posts", id: (draft as any).id })
    check("consume: ONE gated social draft proposed (status='draft', approval_status='pending' — nothing auto-publishes)",
      !!draft && (draft as any).status === "draft" && (draft as any).approval_status === "pending")

    // ── CONSUME (Ads Manager): propose paid promotion into the governed queue ──
    const cAds = await consumeManagerSignals({ brokerageId, toManager: "ads_manager" }, svc)
    check("consume: ads_manager consumed video_ready", cAds.consumed >= 1)
    const { data: adAction } = await svc.from("ad_manager_actions")
      .select("id, action_type, status, action_input")
      .eq("brokerage_id", brokerageId)
      .filter("action_input->>video_project_id", "eq", projectId)
      .limit(1).maybeSingle()
    if (adAction) cleanup.push({ table: "ad_manager_actions", id: (adAction as any).id })
    check("consume: ad_manager_actions row PROPOSED (launch_ad_campaign, status='proposed' — governed spend)",
      !!adAction && (adAction as any).action_type === "launch_ad_campaign" && (adAction as any).status === "proposed")

    // ── IDEMPOTENT RERUN: publisher dedupes, handlers no-op (no duplicates) ──
    const pub2 = await publishVideoCoordinationSignals(projectId, svc)
    check("idempotent: re-publish produced no NEW open signals (deduped on the bus)", pub2.ok)
    const { count: sigCount } = await svc.from("manager_signals")
      .select("id", { count: "exact", head: true })
      .eq("entity_id", projectId).eq("signal_type", "video_ready")
    check("idempotent: still exactly 2 video_ready signals after re-publish", (sigCount ?? 0) === 2)
    // Re-consume (signals are already consumed/deduped → nothing re-proposed)
    await consumeManagerSignals({ brokerageId, toManager: "campaign_orchestrator" }, svc)
    await consumeManagerSignals({ brokerageId, toManager: "ads_manager" }, svc)
    const { count: draftCount } = await svc.from("social_posts")
      .select("id", { count: "exact", head: true })
      .contains("media_urls", [`https://example.test/${TAG}.mp4`])
    check("idempotent: still exactly 1 gated social draft (no duplicate distribution)", (draftCount ?? 0) === 1)
    const { count: adCount } = await svc.from("ad_manager_actions")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .filter("action_input->>video_project_id", "eq", projectId)
    check("idempotent: still exactly 1 proposed ad action (no duplicate spend proposal)", (adCount ?? 0) === 1)

    // ── COMPLIANCE FAILURE: a failed render escalates (never invisible) ──
    const { data: failProj } = await svc.from("ai_video_projects").insert({
      brokerage_id: brokerageId,
      agent_id: agentUserId,
      title: `${TAG} Failed reel`,
      video_type: "listing_promo",
      video_metadata: { promo_event_type: "just_listed", sim: TAG },
      status: "failed",
      error_message: "compliance failed after redraft: Fair Housing violation",
    }).select("id").single()
    const failProjectId = (failProj as any).id as string
    cleanup.push({ table: "ai_video_projects", id: failProjectId })

    const pubFail = await publishVideoCoordinationSignals(failProjectId, svc)
    check("compliance-failed: escalation signal published", pubFail.ok && pubFail.escalated)
    const { data: failSig } = await svc.from("manager_signals")
      .select("id, to_manager, signal_type, from_manager")
      .eq("entity_id", failProjectId).eq("signal_type", "video_compliance_failed").maybeSingle()
    if (failSig) cleanup.push({ table: "manager_signals", id: (failSig as any).id })
    check("compliance-failed: routed asset_manager → campaign_orchestrator",
      !!failSig && (failSig as any).from_manager === "asset_manager" && (failSig as any).to_manager === "campaign_orchestrator")

    const cFail = await consumeManagerSignals({ brokerageId, toManager: "campaign_orchestrator" }, svc)
    check("compliance-failed: campaign_orchestrator consumed (escalated)", cFail.consumed >= 1)
    const { data: failNotifs } = await svc.from("notifications")
      .select("id").eq("entity_id", failProjectId).eq("type", "video_compliance_failed")
    for (const n of (failNotifs ?? []) as any[]) cleanup.push({ table: "notifications", id: n.id })
    check("compliance-failed: escalation notification(s) created (failure not invisible)",
      (failNotifs ?? []).length >= 1)
    // A failed render proposes NO distribution + NO spend.
    const { count: failDrafts } = await svc.from("social_posts")
      .select("id", { count: "exact", head: true }).eq("listing_id", failProjectId)
    check("compliance-failed: no distribution drafts created for a failed render", (failDrafts ?? 0) === 0)

    // ── TALK FEED: the conversation is visible in 'managers talking' ──
    const talk = await loadRecentManagerTalk(brokerageId, 30, svc)
    const distLine = talk.find((t) => t.fromLabel === "Asset Manager" && t.toLabel === "Campaign Orchestrator" && t.status === "consumed")
    const adsLine = talk.find((t) => t.fromLabel === "Asset Manager" && t.toLabel === "Ads Manager" && t.status === "consumed")
    check("talk feed: Asset Manager → Campaign Orchestrator shows with ✓ action", !!distLine && !!distLine.consumedAction)
    check("talk feed: Asset Manager → Ads Manager shows with ✓ action", !!adsLine && !!adsLine.consumedAction)
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("ai_video_projects")
      .select("id", { count: "exact", head: true }).like("title", `${TAG}%`)
    check("cleanup verified — 0 seeded video projects remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
