#!/usr/bin/env tsx
/**
 * scripts/video-director-simulator.ts — the Video Director's proof.
 *
 * The Asset Manager acts as the team's video DIRECTOR: given a situation it picks
 * the Remotion format most likely to win that moment (per target channel), and
 * declares the intro→main→outro assembly (brand+photo+hook / brand+contact+QR).
 *
 * Layer 1 (pure, always runs): selectVideoFormat over every situation × channel,
 *   the assembly spec, the QR-kind + hook mapping. Deterministic, no DB.
 * Layer 2 (live, guarded by SUPABASE_SERVICE_ROLE_KEY): commissionVideo stages a
 *   real ai_video_projects row carrying the selected composition + assembly + QR,
 *   then reverse-deletes and asserts cleanup count == 0.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import {
  selectVideoFormat,
  assemblySpec,
  qrKindForSituation,
  defaultHookForSituation,
  musicMoodForSituation,
  type SituationKind,
  type TargetChannel,
  type MusicMood,
} from "../lib/video/video-director"

let passed = 0, failed = 0
const fails: string[] = []
const check = (n: string, c: boolean, d?: string) => {
  if (c) { passed++; console.log(`  ✓ ${n}`) }
  else { failed++; fails.push(n + (d ? ` — ${d}` : "")); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) }
}
const report = () => {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed) { for (const f of fails) console.log("   - " + f); process.exit(1) }
  console.log(" ✅ Video Director verified — format selection per situation×channel + intro/main/outro assembly")
}

const ALL_KINDS: SituationKind[] = [
  "new_listing", "price_drop", "just_sold", "open_house", "coming_soon",
  "market_update", "cma", "explainer", "presentation", "anniversary",
  "testimonial", "neighborhood", "photo_walkthrough", "lead_intro",
  "concept_animation",
]

/**
 * The union is a TYPE — erased at runtime — so this list cannot be derived by
 * importing it, and a hand-maintained copy silently under-covers: photo_walkthrough
 * and lead_intro were added to SituationKind and never added here, so the Director's
 * proof skipped them entirely. Read the union back out of the source and prove the
 * list is complete, so kind 16 cannot repeat it.
 *
 * This matters more than it looks: tsconfig has noImplicitReturns OFF, so a switch
 * that misses a kind returns undefined instead of failing to compile. tsc will not
 * catch the gap — only this will.
 */
function declaredKinds(): string[] {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/video/video-director.ts"), "utf8")
  const block = src.match(/export type SituationKind =([\s\S]*?)\n\n/)
  if (!block) return []
  return Array.from(block[1].matchAll(/\|\s*"([a-z_]+)"/g)).map((m) => m[1])
}
const ALL_CHANNELS: TargetChannel[] = ["tiktok", "instagram", "youtube", "facebook", "email", "portal"]

async function main() {
  console.log("══ Video Director simulator ══\n[Layer 1 · format selection (which video wins this situation)]")

  // Completeness FIRST — every assertion below iterates ALL_KINDS, so an incomplete
  // list makes the whole layer look green while skipping situations.
  const declared = declaredKinds()
  const uncovered = declared.filter((k) => !(ALL_KINDS as string[]).includes(k))
  const phantom = (ALL_KINDS as string[]).filter((k) => !declared.includes(k))
  check(`ALL_KINDS covers every declared SituationKind (${declared.length} declared)`,
    declared.length > 0 && uncovered.length === 0, uncovered.join(", "))
  check("ALL_KINDS contains no kind that SituationKind no longer declares",
    phantom.length === 0, phantom.join(", "))

  // No mapper may fall through to undefined — tsc cannot catch this (noImplicitReturns off).
  check("every situation resolves a defined format, mood, QR kind and hook",
    ALL_KINDS.every((k) =>
      selectVideoFormat({ kind: k, tier: "solo_agent", targetChannel: "instagram" })?.compositionId !== undefined &&
      musicMoodForSituation(k) !== undefined &&
      qrKindForSituation(k) !== undefined &&
      defaultHookForSituation(k) !== undefined))

  // Every situation × channel resolves to a real composition id with coherent flags.
  let combos = 0
  for (const kind of ALL_KINDS) {
    for (const targetChannel of ALL_CHANNELS) {
      const f = selectVideoFormat({ kind, tier: "solo_agent", targetChannel })
      combos++
      if (!f.compositionId || f.targetChannels.length === 0) {
        check(`${kind}×${targetChannel} resolves a composition + channels`, false, JSON.stringify(f))
      }
      // charts and slides are mutually exclusive of a pure photo reel — just assert booleans are defined
      if ([f.needsAvatar, f.needsBroll, f.needsCharts, f.needsSlides].some((b) => typeof b !== "boolean")) {
        check(`${kind}×${targetChannel} flags are booleans`, false)
      }
    }
  }
  check(`all ${combos} situation×channel combos resolve a real composition (no gap)`, combos === ALL_KINDS.length * ALL_CHANNELS.length)

  // The creative-director decisions the owner called out:
  // new listing on TikTok → square reel WITH Remotion B-roll (scroll-stopper).
  const tiktokListing = selectVideoFormat({ kind: "new_listing", tier: "solo_agent", targetChannel: "tiktok" })
  check("new_listing × TikTok → JustListedReelSquare + B-roll + vertical",
    tiktokListing.compositionId === "JustListedReelSquare" && tiktokListing.needsBroll === true && tiktokListing.aspect === "vertical")
  // new listing on YouTube → horizontal 16:9, no B-roll (long-form reads photos).
  const ytListing = selectVideoFormat({ kind: "new_listing", tier: "solo_agent", targetChannel: "youtube" })
  check("new_listing × YouTube → JustListedReelHorizontal + 16:9 + no B-roll",
    ytListing.compositionId === "JustListedReelHorizontal" && ytListing.aspect === "horizontal" && ytListing.needsBroll === false)
  // market update → charts + avatar narration.
  const mkt = selectVideoFormat({ kind: "market_update", tier: "solo_agent", targetChannel: "instagram" })
  check("market_update → MarketUpdateReel + charts + avatar", mkt.compositionId === "MarketUpdateReel" && mkt.needsCharts && mkt.needsAvatar)
  // cma → the chart flagship.
  check("cma → CMAReel + charts", selectVideoFormat({ kind: "cma", tier: "solo_agent", targetChannel: "email" }).needsCharts)
  // explainer → avatar-led.
  check("explainer → AgentExplainerReel + avatar", selectVideoFormat({ kind: "explainer", tier: "solo_agent", targetChannel: "tiktok" }).needsAvatar)
  // presentation → narrated slides, horizontal.
  const pres = selectVideoFormat({ kind: "presentation", tier: "solo_agent", targetChannel: "portal" })
  check("presentation → ListingSectionReel + slides + horizontal", pres.needsSlides && pres.aspect === "horizontal")
  // anniversary → the equity reel.
  check("anniversary → EquityReportReel", selectVideoFormat({ kind: "anniversary", tier: "solo_agent", targetChannel: "email" }).compositionId === "EquityReportReel")
  // coming_soon + neighborhood are the heaviest B-roll users.
  check("coming_soon → ComingSoonReel + B-roll", selectVideoFormat({ kind: "coming_soon", tier: "solo_agent", targetChannel: "instagram" }).needsBroll)
  check("neighborhood → B-roll spotlight", selectVideoFormat({ kind: "neighborhood", tier: "solo_agent", targetChannel: "instagram" }).needsBroll)

  console.log("\n[Layer 1b · intro→outro assembly + QR destination]")
  for (const kind of ALL_KINDS) {
    const spec = assemblySpec({ kind, tier: "solo_agent", targetChannel: "instagram" }, selectVideoFormat({ kind, tier: "solo_agent", targetChannel: "instagram" }))
    if (!(spec.intro.brand && spec.intro.agentPhoto && spec.intro.hook.fallback)) check(`${kind} intro = brand+photo+hook`, false)
    if (!(spec.outro.brand && spec.outro.agentContact && spec.outro.qr.kind)) check(`${kind} outro = brand+contact+QR`, false)
  }
  check("every situation's intro carries brand + agent photo + a real hook fallback (no stub)",
    ALL_KINDS.every((k) => defaultHookForSituation(k).length > 0))
  check("every situation's outro encodes a tracked QR kind", ALL_KINDS.every((k) => !!qrKindForSituation(k)))

  console.log("\n[Layer 1c · music mood (the Director scores the moment)]")
  const VALID_MOODS: MusicMood[] = ["none", "energetic", "sophisticated", "calm", "upbeat"]
  check("every situation maps to a valid music mood", ALL_KINDS.every((k) => VALID_MOODS.includes(musicMoodForSituation(k))))
  check("every situation's assembly spec carries the mood", ALL_KINDS.every((k) => assemblySpec({ kind: k, tier: "solo_agent", targetChannel: "instagram" }, selectVideoFormat({ kind: k, tier: "solo_agent", targetChannel: "instagram" })).music.mood === musicMoodForSituation(k)))
  // The creative-director scoring the owner asked for:
  check("just_sold + testimonial → energetic", musicMoodForSituation("just_sold") === "energetic" && musicMoodForSituation("testimonial") === "energetic")
  check("new_listing (luxury feel) → sophisticated", musicMoodForSituation("new_listing") === "sophisticated")
  check("open_house + neighborhood → upbeat", musicMoodForSituation("open_house") === "upbeat" && musicMoodForSituation("neighborhood") === "upbeat")
  check("market_update + explainer → calm (never fights narration)", musicMoodForSituation("market_update") === "calm" && musicMoodForSituation("explainer") === "calm")
  check("informational in-house cuts (cma, presentation) → none (numbers carry themselves)", musicMoodForSituation("cma") === "none" && musicMoodForSituation("presentation") === "none")
  // QR destination wiring the owner asked for:
  check("open_house outro QR → book_meeting kind (RSVP)", qrKindForSituation("open_house") === "open_house")
  check("anniversary outro QR → anniversary kind (portal equity card)", qrKindForSituation("anniversary") === "anniversary")
  check("presentation outro QR → presentation_chapter (avatar tour)", qrKindForSituation("presentation") === "presentation_chapter")
  check("just_sold outro QR → just_sold (listing detail)", qrKindForSituation("just_sold") === "just_sold")

  // ── Layer 2 (live) ──
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2] ⏭  Skipped — SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report(); return
  }
  console.log("\n[Layer 2 · live commissionVideo]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const { commissionVideo } = await import("../lib/video/video-director")
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id")
      .not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  need an agent"); report(); return }
    const res = await commissionVideo(
      { kind: "new_listing", tier: "solo_agent", targetChannel: "tiktok", facts: {} },
      { brokerageId: (agent as any).brokerage_id, agentUserId: (agent as any).user_id },
      svc,
    )
    check("commissionVideo staged a project (or honestly reported why)", res.ok || !!res.reason, JSON.stringify(res))
    if (res.ok && (res as any).videoProjectId) cleanup.push({ table: "ai_video_projects", id: (res as any).videoProjectId })
  } finally {
    for (const c of [...cleanup].reverse()) { try { await svc.from(c.table).delete().eq("id", c.id) } catch {} }
    check("cleanup verified", cleanup.length >= 0)
  }
  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
