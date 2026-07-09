#!/usr/bin/env tsx
/**
 * scripts/partners-meeting-reel-simulator.ts  (npm run test:partners-meeting-reel) — pure, no DB.
 *
 * Proves the Partners' Meeting RECAP REEL data→video contract (lib/intelligence/partners-meeting-reel-
 * props.ts): WeekInBusiness → branded stat cards, EARNED ONLY (quiet week shows fewer cards, never a
 * fabricated win), with the Finance + Compliance cards (the differentiator) and the narration sourced
 * from the SAME composePartnersMeetingScript the avatar speaks.
 */
import { buildPartnersMeetingReelProps, buildPartnersMeetingRenderRequest } from "../lib/intelligence/partners-meeting-reel-props"
import type { WeekInBusiness } from "../lib/intelligence/partners-meeting"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}`) }
}

const FULL: WeekInBusiness = {
  weekLabel: "the week of 2026-06-15", teamPlays: 3, fireDrills: 1, whispers: 4,
  consentFallbacks: 1, withdrawnRespectfully: 0, handoffs: 9, dissents: 3,
  proposalsSent: 12, proposalsPending: 5, dealsClosed: 2,
  gciClosedThisWeek: 18000, gciWeightedPipeline: 1_200_000,
  complianceReviewed: 31, complianceAdvisories: 4, complianceReleasedOverObjection: 1,
}
const ZERO: WeekInBusiness = {
  weekLabel: "the week of 2026-06-15", teamPlays: 0, fireDrills: 0, whispers: 0,
  consentFallbacks: 0, withdrawnRespectfully: 0, handoffs: 0, dissents: 0,
  proposalsSent: 0, proposalsPending: 0, dealsClosed: 0,
  gciClosedThisWeek: 0, gciWeightedPipeline: 0,
  complianceReviewed: 0, complianceAdvisories: 0, complianceReleasedOverObjection: 0,
}

console.log("\n[1 · a full week → earned cards across team / finance / compliance]")
const full = buildPartnersMeetingReelProps(FULL, { agentName: "Dana", audienceName: "Dana" })
const kinds = full.cards.map((c) => c.kind)
check("deals/plays/drills/whispers/handoffs all rendered as team cards",
  full.cards.some((c) => c.label === "DEALS CLOSED" && c.value === "2") &&
  full.cards.some((c) => c.label === "TEAM PLAYS" && c.value === "3") &&
  full.cards.some((c) => c.label === "DEADLINES SAVED") &&
  full.cards.some((c) => c.label === "APPOINTMENT BRIEFINGS" && c.value === "4") &&
  full.cards.some((c) => c.label === "MANAGER HANDOFFS" && c.value === "9"))
check("FINANCE card shows booked GCI (abbreviated) + pipeline",
  full.cards.some((c) => c.kind === "finance" && c.value === "$18K" && /\$1\.2M weighted/.test(c.sub ?? "")))
check("COMPLIANCE card (the differentiator) shows reviewed + fixes + released-over-objection",
  full.cards.some((c) => c.kind === "compliance" && c.value === "31" && /4 Fair-Housing\/consent fixes caught/.test(c.sub ?? "") && /1 released over objection/.test(c.sub ?? "")))
check("the one ask names the pending queue", full.oneAsk === "5 proposals waiting on you")
check("narration is the spoken meeting script (shared source, no drift)",
  full.narration.startsWith("Dana, good evening") && full.narration.includes("Compliance Officer:"))
check("cards include all three kinds", kinds.includes("team") && kinds.includes("finance") && kinds.includes("compliance"))

console.log("\n[2 · a quiet week is HONEST — no fabricated cards]")
const zero = buildPartnersMeetingReelProps(ZERO, {})
check("zero week emits ZERO stat cards", zero.cards.length === 0)
check("zero week still has the honest clear-queue ask", zero.oneAsk === "Your approval queue is clear")
check("zero week narration fabricates no wins", !zero.narration.includes("closed") && zero.narration.includes("approval queue is clear"))

console.log("\n[3 · partial week → only the earned cards]")
const partial = buildPartnersMeetingReelProps({ ...ZERO, dealsClosed: 1, complianceReviewed: 8, complianceAdvisories: 0 }, {})
check("partial week shows exactly the deals + compliance cards",
  partial.cards.length === 2 && partial.cards.some((c) => c.label === "DEALS CLOSED") &&
  partial.cards.some((c) => c.kind === "compliance" && /all cleared Fair Housing & consent/.test(c.sub ?? "")))

console.log("\n[4 · render request → the render-queue contract]")
const req = buildPartnersMeetingRenderRequest(FULL, { agentName: "Dana" })
check("targets the registered PartnersMeetingReel composition at 1920×1080 / 900 frames",
  req.compositionId === "PartnersMeetingReel" && req.width === 1920 && req.height === 1080 && req.durationInFrames === 900)
check("carries the earned reel props as inputProps (cards + one ask)",
  req.inputProps.cards.length === full.cards.length && req.inputProps.oneAsk === full.oneAsk)

console.log("\n[5 · LIVE WIRING — the show actually runs (composition was orphaned before)]")
import { readFileSync } from "node:fs"
import { join } from "node:path"
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
const pm = src("lib/intelligence/partners-meeting.ts")
check("the weekly producer QUEUES the reel (one per brokerage per week) with the D-ID clip as the avatar PIP",
  pm.includes("queuePartnersMeetingReel") && pm.includes("avatarVideoUrl: avatarClipUrl")
  && pm.includes('PARTNERS_MEETING_REEL_ENTITY = "partners_meeting_reel"'))
check("brand comes from the ONE live resolver (brokerages + brand settings — never HeyGen presets)",
  pm.includes("resolveReelBrand") && src("lib/video/reel-brand.ts").includes("brokerage_brand_settings")
  && !src("lib/video/reel-brand.ts").includes('.from("video_branding_presets")'))
check("branded VideoCoverThumb pass rides input_props.thumbnail_props on both reel producers",
  pm.includes("thumbnail_props") && src("lib/kernel/board-packet-reel.ts").includes("thumbnail_props"))
check("?phase=deliver sweeps completed shows Monday afternoon (route branch + dispatcher schedule)",
  src("app/api/cron/partners-meeting/route.ts").includes("deliverPartnersMeetingReels")
  && src("lib/kernel/cron-dispatch.ts").includes("partners-meeting?phase=deliver"))
check("KEEP-ONE delivery sweep: both reels share deliverCompletedReels (no second sweep)",
  pm.includes("deliverCompletedReels") && src("lib/kernel/board-packet-reel.ts").includes("deliverCompletedReels"))

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
console.log(" ✅ PARTNERS_MEETING_REEL_PASS — the AI team's weekly show: earned cards only, finance + compliance differentiators, honest on a quiet week")
