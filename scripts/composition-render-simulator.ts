#!/usr/bin/env tsx
/**
 * scripts/composition-render-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 39 m172 — generic-render dispatch harness.
 *
 * The actual @remotion/renderer call needs Chromium + ffmpeg (no egress /
 * no binary in CI or the agent sandbox). This harness exercises the REAL
 * dispatch-decision layer (lib/remotion/render-decision.ts) that the
 * generic render endpoint + composition-render-queue cron route every
 * render through: still-vs-video routing, queue-claim eligibility,
 * bookend suppression for stills, RenderIntent reconstruction from a
 * queued row, and the input-props/defaults fallback. It proves the
 * connective logic that makes Asset Manager start_render /
 * restart_failed_render produce a video for EVERY registered composition,
 * not just the two with bespoke endpoints — without rendering a frame.
 *
 * Run:  npx tsx scripts/composition-render-simulator.ts
 * Exit: 0 = all checks pass, 1 = any failure (CI gate).
 */
import {
  isStillComposition,
  outputContentType,
  outputExtension,
  isPickableStatus,
  shouldApplyBookends,
  buildRenderIntent,
  resolveInputProps,
  needsThumbnailPass,
  resolveThumbnailProps,
  type QueuedRenderRow,
} from "../lib/remotion/render-decision"
import type { RemotionCompositionRow } from "../lib/remotion/registry"

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(name + (detail ? ` — ${detail}` : ""))
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

// Minimal registry-row factory — only the fields the pure decision layer
// reads. Durations mirror the real remotion/Root.tsx registrations.
function row(over: Partial<RemotionCompositionRow>): RemotionCompositionRow {
  return {
    composition_id:           "X",
    display_name:             "X",
    category:                 "listing",
    orientation:              "square",
    width:                    1080,
    height:                   1080,
    duration_frames:          360,
    fps:                      30,
    requires_did_avatar:      false,
    requires_voiceover:       false,
    tier_access:              ["solo_agent"],
    is_active:                true,
    seo_title:                null,
    seo_description:          null,
    thumbnail_composition_id: null,
    asset_manager_notes:      null,
    last_rendered_at:         null,
    supports_bookends:        true,
    stock_intro_category:     "brand_intro",
    stock_outro_category:     "logo_outro",
    ...over,
  }
}

// ── 1. Still vs moving routing across the real registry durations ────────────
function testStillVsMoving() {
  console.log("\n[Still vs moving — real registry durations]")
  // Moving (renderMedia → mp4):
  const moving: Array<[string, number]> = [
    ["JustListedReel", 750],
    ["JustListedReelSquare", 360],
    ["JustSoldReelSquare", 360],
    ["AgentTalkingHeadReel", 420],
    ["AgentExplainerReel", 540],
    ["MarketUpdateReel", 480],
    ["ListingPresentationSlide", 180],
    ["ComingSoonReel", 360],
    ["OpenHouseAnnounceReel", 360],
    ["TestimonialReel", 420],
    ["NeighborhoodSpotlightReel", 480],
    ["JustListedReelHorizontal", 600],
    ["BuyerConsultationSlide", 180],
    ["AffordabilitySnapshotReel", 450],
    ["NewsletterDigestVideo", 600],
  ]
  for (const [id, frames] of moving) {
    check(`${id} (${frames}f) → moving/mp4`, !isStillComposition(frames) && outputContentType(frames) === "video/mp4" && outputExtension(frames) === "mp4")
  }
  // Stills (renderStill → png):
  const stills: Array<[string, number]> = [
    ["VideoCoverThumb", 1],
    ["LeadMagnetCard", 1],
    ["NewsletterDigestThumb", 1],
    ["PostcardFront4x6", 1],
    ["PostcardBack4x6", 1],
    ["PostcardFront6x9", 1],
    ["PostcardBack6x9", 1],
  ]
  for (const [id, frames] of stills) {
    check(`${id} (${frames}f) → still/png`, isStillComposition(frames) && outputContentType(frames) === "image/png" && outputExtension(frames) === "png")
  }
  check("0-frame edge → still (defensive)", isStillComposition(0))
}

// ── 2. Queue-claim eligibility ───────────────────────────────────────────────
function testPickable() {
  console.log("\n[Queue-claim eligibility — only 'queued' is pickable]")
  check("queued → pickable", isPickableStatus("queued"))
  check("rendering → NOT pickable (in-flight)", !isPickableStatus("rendering"))
  check("succeeded → NOT pickable (terminal)", !isPickableStatus("succeeded"))
  check("failed → NOT pickable (Asset Manager decides restart)", !isPickableStatus("failed"))
  check("cancelled → NOT pickable", !isPickableStatus("cancelled"))
}

// ── 3. Bookend suppression for stills ────────────────────────────────────────
function testBookends() {
  console.log("\n[Bookends — moving follows flag, stills always off]")
  check("moving + supports_bookends → bookends ON", shouldApplyBookends(row({ duration_frames: 360, supports_bookends: true })))
  check("moving + !supports_bookends → bookends OFF", !shouldApplyBookends(row({ duration_frames: 360, supports_bookends: false })))
  // A postcard could carry supports_bookends=true by mistake; the still
  // guard must still force it off (a PNG has no video track to concat).
  check("still + supports_bookends → bookends FORCED OFF", !shouldApplyBookends(row({ duration_frames: 1, supports_bookends: true })))
}

// ── 4. RenderIntent reconstruction from a queued row ─────────────────────────
function testIntent() {
  console.log("\n[RenderIntent reconstruction from a queued row]")
  const agentScoped: QueuedRenderRow = {
    brokerage_id:   "brk-1",
    composition_id: "JustSoldReelSquare",
    agent_user_id:  "agent-9",
    entity_type:    "listing",
    entity_id:      "listing-3",
    scope_type:     "agent",
    scope_id:       "agent-9",
    input_props:    { soldPrice: "$640,000" },
  }
  const i = buildRenderIntent(agentScoped, "brokerage")
  check("intent carries brokerageId", i.brokerageId === "brk-1")
  check("intent carries resolved callerTier", i.callerTier === "brokerage")
  check("intent carries compositionId", i.compositionId === "JustSoldReelSquare")
  check("agent scope passes through (personal-brand cascade)", i.scopeType === "agent" && i.scopeId === "agent-9")
  check("entity refs pass through", i.entityType === "listing" && i.entityId === "listing-3")
  check("agentUserId passes through", i.agentUserId === "agent-9")

  // Null scope_id (legacy row) falls back to the brokerage id.
  const legacy: QueuedRenderRow = {
    brokerage_id: "brk-2", composition_id: "MarketUpdateReel",
    agent_user_id: null, entity_type: null, entity_id: null,
    scope_type: "brokerage", scope_id: null, input_props: null,
  }
  const j = buildRenderIntent(legacy, "team")
  check("null scope_id → brokerage fallback", j.scopeId === "brk-2" && j.scopeType === "brokerage")
  check("null entity refs stay null", j.entityType === null && j.entityId === null)
}

// ── 5. Input-props / defaults fallback ───────────────────────────────────────
function testProps() {
  console.log("\n[Input-props resolution — empty → registry defaults]")
  check("undefined props → undefined (use defaultProps)", resolveInputProps(undefined) === undefined)
  check("null props → undefined (use defaultProps)", resolveInputProps(null) === undefined)
  check("empty object → undefined (use defaultProps)", resolveInputProps({}) === undefined)
  const r = resolveInputProps({ address: "123 Main", price: "$625,000" })
  check("populated props pass through", !!r && r.address === "123 Main" && r.price === "$625,000")
}

// ── 6. Companion thumbnail pass (share/OG/AI-search discoverability) ─────────
function testThumbnailPass() {
  console.log("\n[Companion thumbnail — moving with declared thumb only]")
  check("moving + thumbnail_composition_id → thumbnail pass ON",
    needsThumbnailPass(row({ duration_frames: 360, thumbnail_composition_id: "VideoCoverThumb" })))
  check("moving + no thumbnail declared → pass OFF",
    !needsThumbnailPass(row({ duration_frames: 360, thumbnail_composition_id: null })))
  // A still IS the image — never gets a separate thumbnail render even if a
  // thumbnail_composition_id is (incorrectly) declared on it.
  check("still → thumbnail pass FORCED OFF",
    !needsThumbnailPass(row({ duration_frames: 1, thumbnail_composition_id: "VideoCoverThumb" })))

  // Thumbnail props travel under input_props.thumbnail_props; video props
  // are NOT reused (cover card has its own shape).
  check("thumbnail_props present → resolved", (() => {
    const r = resolveThumbnailProps({ address: "123 Main", thumbnail_props: { title: "Just Listed", kind: "listing" } })
    return !!r && r.title === "Just Listed" && r.kind === "listing"
  })())
  check("no thumbnail_props → undefined (use thumb defaults)", resolveThumbnailProps({ address: "123 Main" }) === undefined)
  check("empty thumbnail_props → undefined", resolveThumbnailProps({ thumbnail_props: {} }) === undefined)
  check("null input_props → undefined", resolveThumbnailProps(null) === undefined)
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Composition-render dispatch simulator (m172)")
  console.log("══════════════════════════════════════════════════")
  testStillVsMoving()
  testPickable()
  testBookends()
  testIntent()
  testProps()
  testThumbnailPass()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    process.exit(1)
  }
  console.log(" ✅ All composition-render dispatch checks passed")
}

main()
