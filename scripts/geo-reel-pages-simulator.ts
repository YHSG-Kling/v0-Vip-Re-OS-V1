#!/usr/bin/env tsx
/**
 * scripts/geo-reel-pages-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * GEO REEL PAGES — auto-publish every COMPLIANT + BROKER-APPROVED reel to a
 * public, AI-search-citable /v/[slug] page.
 *
 * Layer 1 (pure, always runs — CI gate):
 *   · the schema.org VideoObject builder produces the right fields from a sample
 *     reel, wires thumbnailUrl = the VideoCoverThumb OG image, and is HONEST when
 *     a field is absent (no null pollution).
 *   · the auto-publish ELIGIBILITY predicate: ONLY a completed + compliance-passed
 *     + approved + unpublished reel is eligible; a pending / blocked / un-approved
 *     reel is NOT.
 *
 * Layer 2 (live, guarded on SUPABASE creds): seeds a REAL completed + approved +
 * compliant ai_video_projects reel, runs the REAL publishVideoProjectLanding,
 * asserts exactly ONE /v/[slug] published row, idempotent rerun (no double-
 * publish), and that a NON-approved reel is NOT published; then reverse-deletes
 * and asserts the cleanup count == 0. No mocks, no stubs, no demo data.
 *
 * Run:  npx tsx scripts/geo-reel-pages-simulator.ts   (npm run test:geo-reel-pages)
 * Exit: 0 = all pass, 1 = any failure (CI gate).
 */
import {
  buildVideoObjectJsonLd,
  isAutoPublishEligible,
  type AutoPublishReel,
} from "../lib/geo/video-landing"

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ── Layer 1: schema.org VideoObject from a sample reel ──────────────────────
function testVideoObjectFromReel() {
  console.log("\n[Layer 1 — schema.org VideoObject builder (sample reel)]")
  const ld = buildVideoObjectJsonLd({
    name:          "Just Listed — 44 Birch Ln, Brickell",
    description:   "A 3-bed waterfront condo. Presented by Jane Doe.",
    thumbnailUrl:  "https://cdn.example.test/covers/44-birch-cover.jpg", // VideoCoverThumb OG image
    contentUrl:    "https://cdn.example.test/reels/44-birch.mp4",
    uploadDate:    "2026-06-12T00:00:00Z",
    durationSec:   25,
    publisherName: "VIP Realty",
    pageUrl:       "https://app.viprealestateos.com/v/just-listed-44-birch-abc12345",
  })
  check("@type VideoObject", ld["@type"] === "VideoObject")
  check("required name/description/contentUrl/uploadDate present", !!ld.name && !!ld.description && !!ld.contentUrl && !!ld.uploadDate)
  check("thumbnailUrl wired to the VideoCoverThumb cover image",
    Array.isArray(ld.thumbnailUrl) && (ld.thumbnailUrl as string[])[0] === "https://cdn.example.test/covers/44-birch-cover.jpg")
  check("contentUrl is the reel mp4", ld.contentUrl === "https://cdn.example.test/reels/44-birch.mp4")
  check("duration → ISO-8601 PT25S", ld.duration === "PT25S")
  check("page url carried", ld.url === "https://app.viprealestateos.com/v/just-listed-44-birch-abc12345")
  check("publisher Organization", (ld.publisher as { ["@type"]?: string; name?: string } | undefined)?.["@type"] === "Organization")

  // HONESTY — absent fields are OMITTED, not emitted as null/empty.
  const sparse = buildVideoObjectJsonLd({
    name: "Market Update", description: "This month in Tampa.", thumbnailUrl: null,
    contentUrl: "https://cdn.example.test/reels/mkt.mp4", uploadDate: "2026-06-12T00:00:00Z",
    durationSec: null, publisherName: null,
    pageUrl: "https://app.viprealestateos.com/v/market-update-xyz",
  })
  check("absent thumbnail → key omitted (honest, no null pollution)", !("thumbnailUrl" in sparse))
  check("absent duration → key omitted", !("duration" in sparse))
  check("absent publisher → key omitted", !("publisher" in sparse))
}

// ── Layer 1: the auto-publish eligibility predicate ─────────────────────────
function testEligibility() {
  console.log("\n[Layer 1 — auto-publish eligibility predicate]")
  const approvedCompliantDone: AutoPublishReel = {
    status: "completed", complianceStatus: "passed", approvalStatus: "approved",
    videoUrl: "https://cdn.example.test/reels/x.mp4", isPublished: false,
  }
  check("completed + passed + approved + unpublished → ELIGIBLE", isAutoPublishEligible(approvedCompliantDone))

  check("pending_review approval → NOT eligible",
    !isAutoPublishEligible({ ...approvedCompliantDone, approvalStatus: "pending_review" }))
  check("rejected approval → NOT eligible",
    !isAutoPublishEligible({ ...approvedCompliantDone, approvalStatus: "rejected" }))
  check("draft approval → NOT eligible",
    !isAutoPublishEligible({ ...approvedCompliantDone, approvalStatus: "draft" }))
  check("compliance not_evaluated → NOT eligible",
    !isAutoPublishEligible({ ...approvedCompliantDone, complianceStatus: "not_evaluated" }))
  check("compliance failed → NOT eligible",
    !isAutoPublishEligible({ ...approvedCompliantDone, complianceStatus: "failed" }))
  check("compliance needs_review → NOT eligible",
    !isAutoPublishEligible({ ...approvedCompliantDone, complianceStatus: "needs_review" }))
  check("status generating (still rendering) → NOT eligible",
    !isAutoPublishEligible({ ...approvedCompliantDone, status: "generating" }))
  check("status failed → NOT eligible",
    !isAutoPublishEligible({ ...approvedCompliantDone, status: "failed" }))
  check("no video_url (no artifact to host) → NOT eligible",
    !isAutoPublishEligible({ ...approvedCompliantDone, videoUrl: null }))
  check("already published → NOT eligible (idempotent)",
    !isAutoPublishEligible({ ...approvedCompliantDone, isPublished: true }))
}

// ── Layer 2: live publish against the real schema ───────────────────────────
async function liveLayer() {
  console.log("\n[Layer 2 — live auto-publish (real schema)]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.")
    return
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { publishVideoProjectLanding } = await import("../lib/geo/publish-video-landing")
  const svc = createServiceClient()
  const TAG = `__georeelsim_${Date.now()}__`
  const cleanup: string[] = []   // ai_video_projects ids

  try {
    // ai_video_projects.agent_id is a NOT-NULL FK to users; resolve a real
    // brokerage+user via the agents join (mirrors the live schema exactly).
    const { data: who } = await svc.from("agents")
      .select("user_id, brokerage_id").not("user_id", "is", null).limit(1).maybeSingle()
    const w = who as { user_id: string | null; brokerage_id: string | null } | null
    if (!w?.user_id || !w?.brokerage_id) { console.log("  ⏭  Skipped — need an agent with a user + brokerage."); return }
    const brokerageId = w.brokerage_id
    const agentUserId = w.user_id

    // Seed ONE approved + compliant + completed reel → should publish.
    const { data: ok } = await svc.from("ai_video_projects").insert({
      brokerage_id:      brokerageId,
      agent_id:          agentUserId,
      title:             `${TAG} Just Listed`,
      video_type:        "listing_promo",
      status:            "completed",
      compliance_status: "passed",
      approval_status:   "approved",
      video_url:         `https://example.test/${TAG}.mp4`,
      thumbnail_url:     `https://example.test/${TAG}-cover.jpg`,
      duration_seconds:  25,
      is_published:      false,
    }).select("id").single()
    if (!ok) throw new Error("approved reel seed failed")
    const okId = (ok as { id: string }).id
    cleanup.push(okId)

    // Seed ONE NON-approved (pending_review) reel → must NOT publish.
    const { data: pend } = await svc.from("ai_video_projects").insert({
      brokerage_id:      brokerageId,
      agent_id:          agentUserId,
      title:             `${TAG} Pending`,
      video_type:        "listing_promo",
      status:            "completed",
      compliance_status: "passed",
      approval_status:   "pending_review",
      video_url:         `https://example.test/${TAG}-pending.mp4`,
      is_published:      false,
    }).select("id").single()
    if (!pend) throw new Error("pending reel seed failed")
    const pendId = (pend as { id: string }).id
    cleanup.push(pendId)

    // 1. Publish the approved reel.
    const res = await publishVideoProjectLanding({ projectId: okId, brokerageId })
    check("approved+compliant+completed reel publishes", res.ok === true && !!res.slug, res.reason)

    const { data: row1 } = await svc.from("ai_video_projects")
      .select("is_published, public_slug, published_at").eq("id", okId).single()
    const r1 = row1 as { is_published: boolean; public_slug: string | null; published_at: string | null }
    check("reel flipped is_published=true", r1.is_published === true)
    check("public_slug minted", !!r1.public_slug && r1.public_slug === res.slug)
    check("published_at stamped", !!r1.published_at)

    // Exactly ONE published row for this slug.
    const { count: slugCount } = await svc.from("ai_video_projects")
      .select("id", { count: "exact", head: true })
      .eq("public_slug", res.slug!).eq("is_published", true)
    check("exactly ONE /v/[slug] published row", (slugCount ?? 0) === 1)

    // 2. Idempotent rerun — same slug, no double-publish.
    const res2 = await publishVideoProjectLanding({ projectId: okId, brokerageId })
    check("rerun is idempotent (same slug)", res2.ok === true && res2.slug === res.slug)
    const { count: stillOne } = await svc.from("ai_video_projects")
      .select("id", { count: "exact", head: true })
      .eq("public_slug", res.slug!).eq("is_published", true)
    check("still exactly ONE row after rerun (no double-publish)", (stillOne ?? 0) === 1)

    // 3. NON-approved reel is NOT published.
    const resPend = await publishVideoProjectLanding({ projectId: pendId, brokerageId })
    check("pending_review reel is REFUSED (not publishable)", resPend.ok === false)
    const { data: rowP } = await svc.from("ai_video_projects")
      .select("is_published, public_slug").eq("id", pendId).single()
    const rp = rowP as { is_published: boolean; public_slug: string | null }
    check("pending reel stays unpublished (no public page)", rp.is_published === false && rp.public_slug === null)

    // 4. Reverse-delete + cleanup count == 0.
    for (const id of cleanup) await svc.from("ai_video_projects").delete().eq("id", id)
    cleanup.length = 0
    const { count: leftover } = await svc.from("ai_video_projects")
      .select("id", { count: "exact", head: true }).ilike("title", `${TAG}%`)
    check("reverse-delete leaves cleanup count == 0", (leftover ?? 0) === 0)
  } catch (e) {
    check("live layer ran without throwing", false, (e as Error).message)
  } finally {
    for (const id of cleanup) { try { await svc.from("ai_video_projects").delete().eq("id", id) } catch { /* best-effort */ } }
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" GEO reel pages — auto-publish simulator (m222)")
  console.log("══════════════════════════════════════════════════")
  testVideoObjectFromReel()
  testEligibility()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ All GEO reel-page checks passed")
}
main()
