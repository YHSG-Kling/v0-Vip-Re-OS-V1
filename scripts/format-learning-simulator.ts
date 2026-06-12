#!/usr/bin/env tsx
/**
 * scripts/format-learning-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FORMAT-LEARNING harness — the Video Director becomes SELF-IMPROVING. Real
 * video performance (QR scans + social engagement) feeds back so the Director's
 * format/channel/mood choice LEARNS what actually converts per brokerage — gated
 * EXACTLY like the trust model (lib/kernel/outcome-learning): never fabricate,
 * never override the sensible default until the data is strong (≥ MIN_FORMAT_SAMPLE
 * AND a clear FORMAT_MARGIN). Built on the offer-net-sheet pure+live template.
 *
 * Layer 1 (pure, always runs):
 *   · scoreFormatOutcomes — scans+engagement fold into per-cell mean signal,
 *     max-scaled to a 0..1 score; empty input → empty map (no fabrication).
 *   · recommendFormatAdjustment — returns the DEFAULT on thin data, on a TIE, and
 *     on a well-sampled-but-thin-MARGIN competitor; returns the LEARNED winner ONLY
 *     past the sample+margin gate, with a human-readable WHY.
 *   · backward-compat — selectVideoFormatLearned(situation, EMPTY) === selectVideoFormat.
 *
 * Layer 2 (live, gated by SUPABASE_SERVICE_ROLE_KEY):
 *   · seed Director-staged ai_video_projects across TWO formats for ONE kind +
 *     qr_codes + qr_scan_events (the loser gets few scans, the winner many) for one
 *     brokerage; loadFormatOutcomes returns the REAL scores; the recommendation
 *     flips to the learned winner ONLY when the gate is met; reverse-delete +
 *     cleanup count == 0.
 *
 * Run: npx tsx scripts/format-learning-simulator.ts  (npm run test:format-learning)
 */
import {
  scoreFormatOutcomes,
  recommendFormatAdjustment,
  MIN_FORMAT_SAMPLE,
  FORMAT_MARGIN,
  type VideoOutcomeRow,
} from "../lib/video/format-learning"
import {
  selectVideoFormat,
  selectVideoFormatLearned,
  type VideoSituation,
} from "../lib/video/video-director"

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
  console.log(" ✅ FORMAT_LEARNING_PASS")
}

/** Build N identical outcome rows in a cell (the per-video sample). */
function rows(n: number, base: Omit<VideoOutcomeRow, "scans" | "engagement">, scans: number, engagement: number): VideoOutcomeRow[] {
  return Array.from({ length: n }, () => ({ ...base, scans, engagement }))
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Format-learning simulator")
  console.log("══════════════════════════════════════════════════")

  // The Director stamps video_type, so the recommender groups on it. just_listed is
  // the video_type for the new_listing situation; tiktok is the channel.
  const KIND = "just_listed"
  const CHANNEL = "tiktok"
  const DEFAULT_COMP = "JustListedReelSquare" // selectVideoFormat's new_listing/tiktok pick
  const WINNER_COMP = "JustSoldReelSquare"    // a DIFFERENT composition that out-converts

  console.log("\n[Layer 1 · scoreFormatOutcomes math]")

  // Default cell: 12 videos, low signal (10 scans + 0 engagement each).
  // Winner cell: 12 videos, high signal (100 scans + 50 engagement each).
  const scoredStrong = scoreFormatOutcomes([
    ...rows(12, { kind: KIND, channel: CHANNEL, compositionId: DEFAULT_COMP, mood: "sophisticated" }, 10, 0),
    ...rows(12, { kind: KIND, channel: CHANNEL, compositionId: WINNER_COMP, mood: "energetic" }, 100, 50),
  ])
  const defKey = `${KIND}|${CHANNEL}|${DEFAULT_COMP}|sophisticated`.toLowerCase()
  const winKey = `${KIND}|${CHANNEL}|${WINNER_COMP}|energetic`.toLowerCase()
  check("scoreFormatOutcomes: default cell sample = 12", scoredStrong.cells[defKey]?.sample === 12, `got ${scoredStrong.cells[defKey]?.sample}`)
  check("scoreFormatOutcomes: default cell meanSignal = 10 (10 scans + 0 eng / video)",
    scoredStrong.cells[defKey]?.meanSignal === 10, `got ${scoredStrong.cells[defKey]?.meanSignal}`)
  check("scoreFormatOutcomes: winner cell meanSignal = 150 (100 scans + 50 eng / video)",
    scoredStrong.cells[winKey]?.meanSignal === 150, `got ${scoredStrong.cells[winKey]?.meanSignal}`)
  check("scoreFormatOutcomes: winner is the max → score 1.0, default max-scaled to 10/150",
    scoredStrong.cells[winKey]?.score === 1 && Math.abs((scoredStrong.cells[defKey]?.score ?? 0) - 10 / 150) < 1e-9,
    `win=${scoredStrong.cells[winKey]?.score} def=${scoredStrong.cells[defKey]?.score}`)
  check("scoreFormatOutcomes: totals accrue (winner 12×100 scans, 12×50 eng)",
    scoredStrong.cells[winKey]?.totalScans === 1200 && scoredStrong.cells[winKey]?.totalEngagement === 600)

  // Empty input → empty map, no fabrication.
  const empty = scoreFormatOutcomes([])
  check("scoreFormatOutcomes: empty input → empty cells + maxMeanSignal 0 (no fabrication)",
    Object.keys(empty.cells).length === 0 && empty.maxMeanSignal === 0)

  console.log("\n[Layer 1 · recommendFormatAdjustment gate — default on thin/tied, learned only past the gate]")

  const fallback = { compositionId: DEFAULT_COMP, mood: "sophisticated" as const }
  const sit = { kind: KIND, channel: CHANNEL }

  // (1) No data → default.
  const recEmpty = recommendFormatAdjustment(sit, empty, fallback)
  check("recommend: NO data → default kept (source 'default', default comp)",
    recEmpty.source === "default" && recEmpty.compositionId === DEFAULT_COMP)

  // (2) Strong + well-sampled winner → LEARNED override past the gate.
  const recStrong = recommendFormatAdjustment(sit, scoredStrong, fallback)
  check("recommend: well-sampled winner clearly beating default → LEARNED override",
    recStrong.source === "learned" && recStrong.compositionId === WINNER_COMP, `got ${recStrong.source}/${recStrong.compositionId}`)
  check("recommend: learned WHY names sample size, both comps, scores + the gate",
    recStrong.why.includes(`${WINNER_COMP}`) && recStrong.why.includes(`${DEFAULT_COMP}`) &&
    recStrong.why.toLowerCase().includes("out-converted") && recStrong.why.includes(`${MIN_FORMAT_SAMPLE}`),
    recStrong.why)
  check("recommend: learned pick also carries the winner's mood (energetic)", recStrong.mood === "energetic")

  // (3) THIN SAMPLE winner (huge signal but only MIN-1 videos) → default (honest).
  const scoredThin = scoreFormatOutcomes([
    ...rows(12, { kind: KIND, channel: CHANNEL, compositionId: DEFAULT_COMP, mood: "sophisticated" }, 10, 0),
    ...rows(MIN_FORMAT_SAMPLE - 1, { kind: KIND, channel: CHANNEL, compositionId: WINNER_COMP, mood: "energetic" }, 1000, 1000),
  ])
  const recThin = recommendFormatAdjustment(sit, scoredThin, fallback)
  check(`recommend: winner with < MIN_FORMAT_SAMPLE (${MIN_FORMAT_SAMPLE - 1}) videos → DEFAULT (thin data, honest)`,
    recThin.source === "default" && recThin.compositionId === DEFAULT_COMP, `got ${recThin.source}/${recThin.compositionId}`)

  // (4) TIED signal (winner sampled enough but margin < FORMAT_MARGIN) → default.
  //     default mean 100, competitor mean 105 → max-scale: def 100/105≈0.952, comp 1.0,
  //     delta ≈ 0.048 < FORMAT_MARGIN (0.1) → no override.
  const scoredTied = scoreFormatOutcomes([
    ...rows(12, { kind: KIND, channel: CHANNEL, compositionId: DEFAULT_COMP, mood: "sophisticated" }, 100, 0),
    ...rows(12, { kind: KIND, channel: CHANNEL, compositionId: WINNER_COMP, mood: "energetic" }, 105, 0),
  ])
  const recTied = recommendFormatAdjustment(sit, scoredTied, fallback)
  check(`recommend: well-sampled but margin < FORMAT_MARGIN (${FORMAT_MARGIN}) → DEFAULT (noise, honest)`,
    recTied.source === "default" && recTied.compositionId === DEFAULT_COMP, `got ${recTied.source}/${recTied.compositionId}`)

  console.log("\n[Layer 1 · backward-compat: selectVideoFormatLearned(EMPTY) === selectVideoFormat]")

  const situations: VideoSituation[] = ([
    "new_listing", "price_drop", "just_sold", "open_house", "coming_soon",
    "market_update", "cma", "explainer", "presentation", "anniversary",
    "testimonial", "neighborhood",
  ] as const).flatMap((kind) =>
    (["tiktok", "instagram", "youtube", "facebook", "email", "portal"] as const).map((targetChannel) => ({
      kind, tier: "solo_agent" as const, targetChannel,
    })),
  )
  let backCompatOk = true
  for (const s of situations) {
    const plain = selectVideoFormat(s)
    const learned = selectVideoFormatLearned(s, empty)
    if (learned.formatSource !== "default" || learned.format.compositionId !== plain.compositionId ||
        learned.format.aspect !== plain.aspect || JSON.stringify(learned.format) !== JSON.stringify(plain)) {
      backCompatOk = false
      console.log(`    ✗ mismatch for ${s.kind}/${s.targetChannel}: ${learned.format.compositionId} vs ${plain.compositionId}`)
    }
  }
  check("backward-compat: selectVideoFormatLearned with EMPTY data === selectVideoFormat for ALL 72 situations",
    backCompatOk)

  // And the learned layer DOES override when fed the strong scored map for the
  // matching situation (new_listing/tiktok → just_listed/tiktok cell).
  const learnedStrong = selectVideoFormatLearned({ kind: "new_listing", tier: "solo_agent", targetChannel: "tiktok" }, scoredStrong)
  check("learned layer: strong scored map flips new_listing/tiktok to the learned winner",
    learnedStrong.formatSource === "learned" && learnedStrong.format.compositionId === WINNER_COMP,
    `${learnedStrong.formatSource}/${learnedStrong.format.compositionId}`)

  // ── Layer 2 · live (gated) ─────────────────────────────────────────────────
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live load + flip]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  console.log("\n[Layer 2 · live loadFormatOutcomes → real scores → gated flip]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const { loadFormatOutcomes } = await import("../lib/video/format-learning")
  const svc = createServiceClient()
  const TAG = `FmtLearn${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id")
      .not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const brokerageId = (agent as any).brokerage_id as string
    const agentUserId = (agent as any).user_id as string // ai_video_projects.agent_id FK → users.id
    const agentRowId  = (agent as any).id as string      // qr_codes.agent_id FK → agents.id

    // Two formats for ONE kind (just_listed/tiktok). Each gets MIN_FORMAT_SAMPLE+2
    // staged Director rows. The DEFAULT format's videos get a FEW scans each; the
    // WINNER format's videos get MANY — so the winner clears the sample+margin gate.
    const N = MIN_FORMAT_SAMPLE + 2
    const VURL_DEF = `https://cdn.example.com/${TAG}-def.mp4`
    const VURL_WIN = `https://cdn.example.com/${TAG}-win.mp4`

    // One tracked qr_codes row per format (scans accrue here per the Director's stamp).
    const { data: qrDef } = await svc.from("qr_codes").insert({
      brokerage_id: brokerageId, agent_id: agentRowId, label: `${TAG}-def`,
      slug: `${TAG}-def`.toLowerCase(), target_url: "https://app.example.com/x",
      purpose: "general", destination_type: "listing_detail", is_active: true, scan_count: 0, lead_count: 0,
    }).select("id").single()
    cleanup.push({ table: "qr_codes", id: (qrDef as any).id })
    const { data: qrWin } = await svc.from("qr_codes").insert({
      brokerage_id: brokerageId, agent_id: agentRowId, label: `${TAG}-win`,
      slug: `${TAG}-win`.toLowerCase(), target_url: "https://app.example.com/y",
      purpose: "general", destination_type: "listing_detail", is_active: true, scan_count: 0, lead_count: 0,
    }).select("id").single()
    cleanup.push({ table: "qr_codes", id: (qrWin as any).id })

    // Stage N Director rows per format. Director-staged shape: video_type + the
    // video_metadata stamps loadFormatOutcomes groups on (composition_id,
    // target_channels, music_mood, qr_code_id) + video_url for engagement.
    const stage = async (comp: string, mood: string, qrId: string, videoUrl: string) => {
      const { data } = await svc.from("ai_video_projects").insert({
        brokerage_id: brokerageId, agent_id: agentUserId,
        title: `${TAG} ${comp}`, script_content: "x", status: "remotion_pending",
        video_type: KIND, format: "9:16", audience_type: "customer_facing",
        is_ai_generated: true, approval_status: "pending_review",
        video_url: videoUrl,
        video_metadata: {
          director_key: `${TAG}:${comp}:${Math.random()}`,
          composition_id: comp, target_channels: [CHANNEL], music_mood: mood, qr_code_id: qrId,
          requested_via: "asset_manager",
        },
      }).select("id").single()
      cleanup.push({ table: "ai_video_projects", id: (data as any).id })
    }
    for (let i = 0; i < N; i++) await stage(DEFAULT_COMP, "sophisticated", (qrDef as any).id, VURL_DEF)
    for (let i = 0; i < N; i++) await stage(WINNER_COMP, "energetic", (qrWin as any).id, VURL_WIN)

    // Real scans: DEFAULT qr gets 1 scan, WINNER qr gets many. Engagement on the
    // WINNER's distributed post (media_urls contains its video_url).
    await svc.from("qr_scan_events").insert({
      qr_code_id: (qrDef as any).id, brokerage_id: brokerageId, is_first_scan: true,
    })
    cleanup.push({ table: "qr_scan_events", id: "__by_qr_def__" }) // marker; deleted by qr cascade below
    for (let i = 0; i < 50; i++) {
      const { data: sc } = await svc.from("qr_scan_events").insert({
        qr_code_id: (qrWin as any).id, brokerage_id: brokerageId, is_first_scan: i === 0,
      }).select("id").single()
      cleanup.push({ table: "qr_scan_events", id: (sc as any).id })
    }
    const { data: post } = await svc.from("social_posts").insert({
      brokerage_id: brokerageId, platform: "tiktok", post_type: "custom", content: TAG,
      media_urls: [VURL_WIN], status: "published", approval_status: "approved",
      engagement_data: { views: 500, engagement: 200, comments: 30, shares: 20 },
    }).select("id").single()
    cleanup.push({ table: "social_posts", id: (post as any).id })

    // loadFormatOutcomes returns the REAL scores for this brokerage.
    const live = await loadFormatOutcomes(brokerageId, svc)
    const liveDefKey = `${KIND}|${CHANNEL}|${DEFAULT_COMP}|sophisticated`.toLowerCase()
    const liveWinKey = `${KIND}|${CHANNEL}|${WINNER_COMP}|energetic`.toLowerCase()
    check("live: loadFormatOutcomes found BOTH seeded cells with the right sample (N each)",
      live.cells[liveDefKey]?.sample === N && live.cells[liveWinKey]?.sample === N,
      `def=${live.cells[liveDefKey]?.sample} win=${live.cells[liveWinKey]?.sample}`)
    check("live: default cell totalScans = N×1 = " + N + " (real qr_scan_events)",
      live.cells[liveDefKey]?.totalScans === N * 1, `got ${live.cells[liveDefKey]?.totalScans}`)
    check("live: winner cell totalScans = N×50 (real qr_scan_events accrued to its qr_code_id)",
      live.cells[liveWinKey]?.totalScans === N * 50, `got ${live.cells[liveWinKey]?.totalScans}`)
    check("live: winner cell totalEngagement = N×750 (500+200+30+20 from the distributed post)",
      live.cells[liveWinKey]?.totalEngagement === N * 750, `got ${live.cells[liveWinKey]?.totalEngagement}`)

    // The recommendation FLIPS to the learned winner — gate met on REAL data.
    const recLive = recommendFormatAdjustment(sit, live, fallback)
    check("live: recommendation FLIPS to the learned winner (gate met on real scans + engagement)",
      recLive.source === "learned" && recLive.compositionId === WINNER_COMP, `got ${recLive.source}/${recLive.compositionId}`)
    check("live: learned WHY is human-readable + names the real winning composition",
      recLive.why.includes(WINNER_COMP) && recLive.why.toLowerCase().includes("learned from"))

    // And before the gate would be met (pretend only the default existed), the
    // default holds — prove honesty by scoring only the default's rows.
    const defOnly = scoreFormatOutcomes(
      rows(N, { kind: KIND, channel: CHANNEL, compositionId: DEFAULT_COMP, mood: "sophisticated" },
        live.cells[liveDefKey]?.totalScans / N, 0))
    const recDefOnly = recommendFormatAdjustment(sit, defOnly, fallback)
    check("live: with ONLY the default sampled (no competitor) → DEFAULT held (honest)",
      recDefOnly.source === "default")
  } finally {
    for (const c of [...cleanup].reverse()) {
      if (c.id === "__by_qr_def__") continue // its scan rows cascade-delete with qrDef
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    // Reverse-delete verified — 0 seeded ai_video_projects remain for this run.
    const { count } = await svc.from("ai_video_projects").select("id", { count: "exact", head: true })
      .like("title", `${TAG}%`)
    check("cleanup verified — 0 seeded ai_video_projects rows remain", (count ?? 0) === 0, `remaining ${count}`)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
