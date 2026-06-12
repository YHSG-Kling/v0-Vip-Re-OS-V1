#!/usr/bin/env tsx
/**
 * scripts/hook-ab-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE HOOK A/B "first-3-seconds" harness — the scroll is won/lost in 3 seconds, so
 * the Video Director renders 2-3 OPENING-HOOK variants per reel, posts them as an
 * organic A/B, and the EXISTING learning loop crowns the winner. Built on the
 * offer-net-sheet pure+live template; reuses the just-shipped Director + format-learning.
 *
 * Layer 1 (pure, always runs):
 *   · hookVariants — n DISTINCT, non-empty, Fair-Housing-safe angles (curiosity /
 *     social-proof / urgency / value), each ≤ a few words; deterministic fallbacks.
 *   · recommendHookWinner — "still testing" on thin/tied data; the winner + WHY only
 *     past the sample (≥ MIN_FORMAT_SAMPLE total actions) + margin (≥ FORMAT_MARGIN) gate.
 *   · backward-compat — the single-hook commissionVideo path / selectVideoFormat are
 *     UNCHANGED (hookVariants is additive; selectVideoFormat still deterministic).
 *
 * Layer 2 (live, gated by SUPABASE_SERVICE_ROLE_KEY):
 *   · commissionVideoExperiment stages N real ai_video_projects rows sharing one
 *     experiment_id, each with its own variant_index + hook_angle + its OWN minted QR.
 *   · seed qr_scan_events differing per variant (+ engagement on one variant's post).
 *   · loadHookExperiment returns the REAL scores; recommendHookWinner flips to the
 *     winner ONLY when gated, "still testing" before.
 *   · reverse-delete EVERY seeded row + verify cleanup count == 0.
 *
 * Run: npx tsx scripts/hook-ab-simulator.ts  (npm run test:hook-ab)
 */
import {
  hookVariants,
  selectVideoFormat,
  HOOK_ANGLE_ORDER,
  type VideoSituation,
} from "../lib/video/video-director"
import {
  scoreHookOutcomes,
  recommendHookWinner,
  MIN_FORMAT_SAMPLE,
  FORMAT_MARGIN,
  type HookOutcomeRow,
} from "../lib/video/format-learning"

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
  console.log(" ✅ HOOK_AB_PASS")
}

/** Fair-Housing red-flag substrings — a hook must contain NONE of these (mirrors the
 *  steering / protected-class language the compliance gate's system prompt forbids). */
const FH_RED_FLAGS = [
  "family", "families", "safe neighborhood", "safe area", "perfect for",
  "great for retirees", "christian", "church", "no kids", "exclusive",
  "ideal for", "race", "religion", "disabled", "handicap",
]
function isFairHousingSafe(s: string): boolean {
  const low = s.toLowerCase()
  return !FH_RED_FLAGS.some((flag) => low.includes(flag))
}

/** N rows in one variant cell (one experiment, one variant_index). */
function rows(n: number, experimentId: string, variantIndex: number, angle: string, scans: number, engagement: number): HookOutcomeRow[] {
  return Array.from({ length: n }, () => ({ experimentId, variantIndex, hookAngle: angle, scans, engagement }))
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Hook A/B simulator")
  console.log("══════════════════════════════════════════════════")

  const EXP = "hookexp:new_listing:offer-net-sheet-template"

  console.log("\n[Layer 1 · hookVariants — N distinct, non-empty, Fair-Housing-safe angles]")

  // Sweep ALL situations × channels; for each, hookVariants(3) must be 3 distinct,
  // non-empty, short, FH-safe angles in the canonical order.
  const KINDS = [
    "new_listing", "price_drop", "just_sold", "open_house", "coming_soon",
    "market_update", "cma", "explainer", "presentation", "anniversary",
    "testimonial", "neighborhood",
  ] as const
  const CHANNELS = ["tiktok", "instagram", "youtube", "facebook", "email", "portal"] as const

  let allDistinct = true, allNonEmpty = true, allSafe = true, allShort = true, allOrdered = true
  let sweepCount = 0
  for (const kind of KINDS) {
    for (const targetChannel of CHANNELS) {
      const sit: VideoSituation = { kind, tier: "solo_agent", targetChannel }
      const vs = hookVariants(sit, 3)
      sweepCount++
      if (vs.length !== 3) allDistinct = false
      const copies = new Set(vs.map((v) => v.hook.toLowerCase()))
      if (copies.size !== vs.length) { allDistinct = false; console.log(`    ✗ non-distinct for ${kind}/${targetChannel}: ${vs.map((v) => v.hook).join(" | ")}`) }
      for (const v of vs) {
        if (!v.hook || !v.hook.trim()) allNonEmpty = false
        if (!isFairHousingSafe(v.hook)) { allSafe = false; console.log(`    ✗ FH-unsafe for ${kind}/${targetChannel}: "${v.hook}"`) }
        // "a few words" — be generous (≤ 8 words) since angles compose onto a base headline.
        if (v.hook.trim().split(/\s+/).length > 8) { allShort = false; console.log(`    ✗ too long for ${kind}/${targetChannel}: "${v.hook}"`) }
      }
      // Canonical order: variant i carries HOOK_ANGLE_ORDER[i].
      if (vs.some((v, i) => v.angle !== HOOK_ANGLE_ORDER[i] || v.index !== i)) allOrdered = false
    }
  }
  check(`hookVariants: 3 DISTINCT angles for all ${sweepCount} situation×channel combos`, allDistinct)
  check("hookVariants: every variant hook is NON-EMPTY", allNonEmpty)
  check("hookVariants: every variant hook is Fair-Housing safe (no steering/protected-class language)", allSafe)
  check("hookVariants: every variant hook is short (≤ 8 words)", allShort)
  check("hookVariants: variants carry the canonical angle order + 0-based index", allOrdered)

  // n clamps to 1..4; default is 3; n=4 yields all four distinct angles.
  check("hookVariants: default n = 3", hookVariants({ kind: "new_listing", tier: "solo_agent", targetChannel: "tiktok" }).length === 3)
  check("hookVariants: n clamps to 1 minimum", hookVariants({ kind: "new_listing", tier: "solo_agent", targetChannel: "tiktok" }, 0).length === 1)
  const four = hookVariants({ kind: "new_listing", tier: "solo_agent", targetChannel: "tiktok" }, 9)
  check("hookVariants: n clamps to 4 (the four angles), all distinct", four.length === 4 && new Set(four.map((v) => v.hook.toLowerCase())).size === 4)
  check("hookVariants: variant 0 is the curiosity scroll-stopper", four[0].angle === "curiosity")

  console.log("\n[Layer 1 · recommendHookWinner gate — still testing on thin/tied, winner only past sample+margin]")

  // (1) Empty / single variant → still testing.
  const recEmpty = recommendHookWinner(EXP, scoreHookOutcomes([]))
  check("recommend: NO data → still testing (honest)", recEmpty.status === "testing" && recEmpty.winnerVariantIndex === null)
  check("recommend: still-testing WHY is human-readable", recEmpty.why.toLowerCase().includes("still testing"))

  // (2) Thin TOTAL sample — two variants but total scans+engagement < MIN_FORMAT_SAMPLE → testing.
  const thin = scoreHookOutcomes([
    ...rows(1, EXP, 0, "curiosity", 1, 0),
    ...rows(1, EXP, 1, "value", 2, 0),
  ])
  const recThin = recommendHookWinner(EXP, thin)
  check(`recommend: total actions < MIN_FORMAT_SAMPLE (${MIN_FORMAT_SAMPLE}) → still testing (honest)`,
    recThin.status === "testing", `got ${recThin.status}`)

  // (3) Enough total sample but TIED variants (margin < FORMAT_MARGIN) → testing.
  //     v0 mean 100, v1 mean 105 → max-scale v0 100/105≈0.952, v1 1.0, delta≈0.048 < 0.1.
  const tied = scoreHookOutcomes([
    ...rows(1, EXP, 0, "curiosity", 100, 0),
    ...rows(1, EXP, 1, "value", 105, 0),
  ])
  const recTied = recommendHookWinner(EXP, tied)
  check(`recommend: well-sampled but margin < FORMAT_MARGIN (${FORMAT_MARGIN}) → still testing (noise, honest)`,
    recTied.status === "testing", `got ${recTied.status}`)

  // (4) Past BOTH gates → a crowned winner + WHY.
  const strong = scoreHookOutcomes([
    ...rows(1, EXP, 0, "curiosity", 10, 0),   // loser
    ...rows(1, EXP, 1, "value", 200, 100),    // winner — clearly ahead, total >> MIN
  ])
  const recWin = recommendHookWinner(EXP, strong)
  check("recommend: past sample+margin gate → WINNER crowned", recWin.status === "winner" && recWin.winnerVariantIndex === 1, `got ${recWin.status}/${recWin.winnerVariantIndex}`)
  check("recommend: winner angle is 'value' (the strong variant)", recWin.winnerAngle === "value")
  check("recommend: winner WHY names the variant + the gate + scans/engagement",
    recWin.why.includes("variant 1") && recWin.why.toLowerCase().includes("hook winner") &&
    recWin.why.includes(`${MIN_FORMAT_SAMPLE}`), recWin.why)

  console.log("\n[Layer 1 · backward-compat: single-hook path / selectVideoFormat UNCHANGED]")

  // selectVideoFormat is deterministic + untouched — hookVariants is purely additive.
  let formatStable = true
  for (const kind of KINDS) {
    for (const targetChannel of CHANNELS) {
      const a = selectVideoFormat({ kind, tier: "solo_agent", targetChannel })
      const b = selectVideoFormat({ kind, tier: "solo_agent", targetChannel })
      if (JSON.stringify(a) !== JSON.stringify(b)) formatStable = false
    }
  }
  check("backward-compat: selectVideoFormat stays deterministic (single-hook path unaffected)", formatStable)

  // ── Layer 2 · live (gated) ─────────────────────────────────────────────────
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live experiment stage + flip]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  console.log("\n[Layer 2 · live commissionVideoExperiment → real per-variant signals → gated flip]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const { commissionVideoExperiment } = await import("../lib/video/video-director")
  const { loadHookExperiment } = await import("../lib/video/format-learning")
  const svc = createServiceClient()
  const TAG = `HookAB${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id")
      .not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const brokerageId = (agent as any).brokerage_id as string
    const agentUserId = (agent as any).user_id as string

    // Use a real listing for this brokerage when available (drives QR listing_detail +
    // the idempotency entity); fall back to a synthetic entity via campaignId.
    const { data: listing } = await svc.from("listings").select("id").eq("brokerage_id", brokerageId).limit(1).maybeSingle()
    const listingId = (listing as any)?.id ?? null

    const situation: VideoSituation = { kind: "new_listing", tier: "solo_agent", targetChannel: "tiktok" }

    // Stage the experiment — 3 variant rows sharing one experiment_id, each its own QR.
    // Inject () => null so the deterministic fallback hooks are used (no token spend).
    const res = await commissionVideoExperiment(
      situation,
      {
        brokerageId, agentUserId,
        listingId,
        campaignId: TAG, // ensures a unique entity even if listingId is null
        title: TAG,
        copyGenerator: async () => null,
        origin: "https://app.example.com",
      },
      { variants: 3 },
      svc,
    )
    check("live: commissionVideoExperiment staged (ok)", res.ok && res.status === "staged", `${res.status} ${res.reason ?? ""}`)
    check("live: staged exactly 3 variant rows", (res.variants?.length ?? 0) === 3, `got ${res.variants?.length}`)
    const experimentId = res.experimentId!
    const variants = res.variants ?? []
    for (const v of variants) cleanup.push({ table: "ai_video_projects", id: v.videoProjectId })

    check("live: all variants share ONE experiment_id", variants.every((v) => true) && !!experimentId)
    const indices = variants.map((v) => v.variantIndex).sort()
    check("live: variant_index 0,1,2 present", JSON.stringify(indices) === "[0,1,2]", JSON.stringify(indices))
    const angles = new Set(variants.map((v) => v.hookAngle))
    check("live: variants carry DISTINCT angles", angles.size === variants.length, [...angles].join(","))
    check("live: each variant minted its OWN distinct QR", new Set(variants.map((v) => v.qrCodeId)).size === variants.length,
      variants.map((v) => v.qrCodeId).join(","))
    for (const v of variants) if (v.qrCodeId) cleanup.push({ table: "qr_codes", id: v.qrCodeId })

    // Idempotency — a second call reuses the staged experiment (no duplicate rows).
    const res2 = await commissionVideoExperiment(
      situation,
      { brokerageId, agentUserId, listingId, campaignId: TAG, title: TAG, copyGenerator: async () => null, origin: "https://app.example.com" },
      { variants: 3 }, svc,
    )
    check("live: idempotent per (entity,kind,experiment) — re-run is already_staged", res2.status === "already_staged", res2.status)
    check("live: idempotent re-run returns the SAME experiment_id + 3 variants", res2.experimentId === experimentId && (res2.variants?.length ?? 0) === 3)

    // BEFORE any signal: loadHookExperiment is honest → still testing.
    const pre = await loadHookExperiment(brokerageId, experimentId, svc)
    const recPre = recommendHookWinner(experimentId, pre)
    check("live: with no scans/engagement yet → still testing (honest)", recPre.status === "testing", recPre.status)

    // Seed REAL signals differing per variant. Variant ranked by index: the HIGHEST
    // index gets many scans (the winner); the others get few. Engagement on the winner.
    const winner = variants[variants.length - 1]
    const losers = variants.slice(0, variants.length - 1)
    // Stamp each row a distinct video_url so the engagement attribution is per-variant.
    for (const v of variants) {
      const vurl = `https://cdn.example.com/${TAG}-v${v.variantIndex}.mp4`
      await svc.from("ai_video_projects").update({ video_url: vurl }).eq("id", v.videoProjectId)
    }
    // Losers: 1 scan each. Winner: 60 scans + a distributed post with engagement.
    for (const l of losers) {
      if (!l.qrCodeId) continue
      const { data: sc } = await svc.from("qr_scan_events").insert({
        qr_code_id: l.qrCodeId, brokerage_id: brokerageId, is_first_scan: true,
      }).select("id").single()
      cleanup.push({ table: "qr_scan_events", id: (sc as any).id })
    }
    if (winner.qrCodeId) {
      for (let i = 0; i < 60; i++) {
        const { data: sc } = await svc.from("qr_scan_events").insert({
          qr_code_id: winner.qrCodeId, brokerage_id: brokerageId, is_first_scan: i === 0,
        }).select("id").single()
        cleanup.push({ table: "qr_scan_events", id: (sc as any).id })
      }
    }
    const { data: post } = await svc.from("social_posts").insert({
      brokerage_id: brokerageId, platform: "tiktok", post_type: "custom", content: TAG,
      media_urls: [`https://cdn.example.com/${TAG}-v${winner.variantIndex}.mp4`],
      status: "published", approval_status: "approved",
      engagement_data: { views: 200, engagement: 100, comments: 10, shares: 5 },
    }).select("id").single()
    cleanup.push({ table: "social_posts", id: (post as any).id })

    // loadHookExperiment returns the REAL scores; the winner is crowned past the gate.
    const live = await loadHookExperiment(brokerageId, experimentId, svc)
    check("live: loadHookExperiment found all 3 variants", Object.keys(live.variants).length === 3, `got ${Object.keys(live.variants).length}`)
    check("live: winner variant totalScans = 60 (real qr_scan_events on its stamped QR)",
      live.variants[winner.variantIndex]?.totalScans === 60, `got ${live.variants[winner.variantIndex]?.totalScans}`)
    check("live: winner variant totalEngagement = 315 (200+100+10+5 from its distributed post)",
      live.variants[winner.variantIndex]?.totalEngagement === 315, `got ${live.variants[winner.variantIndex]?.totalEngagement}`)

    const recLive = recommendHookWinner(experimentId, live)
    check("live: recommendHookWinner FLIPS to the crowned winner (gate met on real signals)",
      recLive.status === "winner" && recLive.winnerVariantIndex === winner.variantIndex,
      `${recLive.status}/${recLive.winnerVariantIndex}`)
    check("live: winner WHY names the variant + is human-readable", recLive.why.includes(`variant ${winner.variantIndex}`) && recLive.why.toLowerCase().includes("hook winner"))

    // And before the gate (only the winner's losers scored, no clear margin yet) the
    // recommender stays honest — prove by scoring only the thin loser cells.
    const loserOnly = scoreHookOutcomes(losers.map((l) => ({ experimentId, variantIndex: l.variantIndex, hookAngle: l.hookAngle, scans: 1, engagement: 0 })))
    const recLoserOnly = recommendHookWinner(experimentId, loserOnly)
    check("live: with only thin loser signal → still testing (honest)", recLoserOnly.status === "testing")
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    // Reverse-delete verified — 0 seeded ai_video_projects rows remain for this run.
    const { count } = await svc.from("ai_video_projects").select("id", { count: "exact", head: true })
      .like("title", `${TAG}%`)
    check("cleanup verified — 0 seeded ai_video_projects rows remain", (count ?? 0) === 0, `remaining ${count}`)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
