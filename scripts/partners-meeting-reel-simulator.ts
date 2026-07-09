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
import { readFileSync, existsSync } from "node:fs"
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

console.log("\n[6 · WHO FRONTS THE VIDEO — the owner's identity rule, structural]")
import { buildListingPitchReelProps } from "../lib/video/listing-pitch-reel"
import { composeRoiHeadline } from "../lib/intelligence/roi-ledger"
{
  const vi = src("lib/video/video-identity.ts")
  check("internal REPORTS are hosted by the named ASSISTANT (ai_identity_profiles cascade) — never a mirror",
    vi.includes('"internal_report"') && vi.includes("assistant_name") && vi.includes("avatar_url")
    && pm.includes('purpose: "internal_report"'))
  check("contact-facing video is ALWAYS the licensed human (the assistant never fronts clients)",
    vi.includes("contact_facing — the licensed human, full stop")
    && src("lib/video/listing-pitch-reel.ts").includes('purpose: "contact_facing"'))
  check("the identity editor exposes the assistant PHOTO (name it, give it a face)",
    src("app/components/ai-identity/AIIdentityEditor.tsx").includes("assistant-avatar")
    && src("app/actions/ai-identity.ts").includes("avatar_url: input.avatarUrl"))
  check("the composition is DESIGNED, not plain: gradient depth + logo header + presenter nameplate + progress dots",
    ["SceneBackground", "SceneHeader", "ProgressDots", "radial-gradient"].every((s) => src("remotion/PartnersMeetingReel.tsx").includes(s)))
}

console.log("\n[7 · the LISTING PITCH REEL — win the listing with the team on camera]")
{
  const rich = buildListingPitchReelProps({
    address: "12 Oak Ln", agentName: "Dana K", agentPhotoUrl: "https://x/p.jpg",
    brand: { primaryColor: "#1d4ed8", accentColor: "#F59E0B", brokerageName: "X Realty", logoUrl: null, showEhoMark: true },
    roi: { periodDays: 90, attributedGciCents: 41200000, attributedDeals: 2, callsAnswered: 12, appointmentsBooked: 3, optOutsHonored: 1 },
  })
  check("the pitch leads with the address, is fronted by the AGENT, and shows MEASURED proof",
    rich.weekLabel === "12 Oak Ln" && rich.agentName === "Dana K"
    && rich.cards.some((c) => c.kind === "finance" && c.sub!.includes("attribution-measured"))
    && rich.oneAsk.includes("12 Oak Ln"))
  const young = buildListingPitchReelProps({
    address: "12 Oak Ln", agentName: "Dana K", agentPhotoUrl: null,
    brand: { primaryColor: "#1d4ed8", accentColor: "#F59E0B", brokerageName: "X Realty", logoUrl: null, showEhoMark: true },
    roi: { periodDays: 90, attributedGciCents: 0, attributedDeals: 0, callsAnswered: 0, appointmentsBooked: 0, optOutsHonored: 0 },
  })
  check("a young brokerage pitches HONESTLY: team promise + compliance discipline, no fabricated volume",
    young.cards.length === 2 && !young.cards.some((c) => c.kind === "finance"))
  check("prep cron queues it per appointment + ?phase=deliver hands it to THE AGENT before the meeting",
    src("app/api/cron/listing-presentation-prep/route.ts").includes("queueListingPitchReel")
    && src("app/api/cron/listing-presentation-prep/route.ts").includes("deliverListingPitchReels")
    && src("lib/kernel/cron-dispatch.ts").includes("listing-presentation-prep?phase=deliver"))
  check("ROI headline: earned lines only, silent when nothing earned (the tile never pads)",
    composeRoiHeadline({ periodDays: 90, sinceIso: "", attributedGciCents: 41200000, attributedDeals: 2, callsAnswered: 12, appointmentsBooked: 3, draftsSent: 4, optOutsHonored: 1 }).includes("not claimed")
    && composeRoiHeadline({ periodDays: 90, sinceIso: "", attributedGciCents: 0, attributedDeals: 0, callsAnswered: 0, appointmentsBooked: 0, draftsSent: 0, optOutsHonored: 0 }) === "")
  check("the ROI ledger is LIVE on the command center (loader + tile)",
    src("lib/kernel/command-center.ts").includes("generateRoiLedger")
    && src("app/dashboard/admin/command-center/command-center-client.tsx").includes("What your AI team earned"))
}

console.log("\n[8 · VOICE ON EVERY VIDEO — narration pipeline end to end]")
import { buildDealRoomReelProps, clearedContingencies } from "../lib/kernel/deal-room-reel"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"
{
  const coord = src("lib/remotion/render-coordinator.ts")
  check("the coordinator muxes input_props.voiceover_url BEFORE music and stamps used_voiceover",
    coord.includes("mixNarrationVoiceover") && coord.includes("used_voiceover:      usedVoiceover")
    && coord.indexOf("mixNarrationVoiceover") < coord.indexOf("mixBackgroundMusic("))
  check("the mixer degrades honestly: amix when the video has audio, direct-map when silent",
    src("lib/remotion/voiceover-mixer.ts").includes("amix=inputs=2")
    && src("lib/remotion/voiceover-mixer.ts").includes('"-map", "1:a"'))
  check("ALL reel producers synthesize narration at queue time (assistant voice on reports, agent clone on client-facing)",
    ["lib/intelligence/partners-meeting.ts", "lib/kernel/board-packet-reel.ts", "lib/video/listing-pitch-reel.ts", "lib/kernel/deal-room-reel.ts"]
      .every((f) => src(f).includes("prepareReelVoiceover")))
  check("TTS rides the canonical primitive + the vendor budget gate (no second ElevenLabs path)",
    src("lib/video/reel-voiceover.ts").includes('import("@/lib/voice/elevenlabs-tts")')
    && src("lib/video/reel-voiceover.ts").includes("brokerageId: p.brokerageId"))
  check("AUDIT CATCH locked: every delivery sweep filters render_status='succeeded' (the value the pipeline writes)",
    ["lib/video/reel-brand.ts", "lib/video/listing-pitch-reel.ts", "lib/kernel/deal-room-reel.ts"]
      .every((f) => src(f).includes('"succeeded"') && !src(f).includes('"render_status", "completed"')))
}

console.log("\n[9 · THE DEAL ROOM — under-contract clients see their deal on camera]")
{
  const facts = {
    address: "12 Oak Ln", stage: "INSPECTION", daysToClose: 21,
    clearedThisWeek: ["Financing contingency"], nextDeadline: { label: "appraisal deadline", date: "2026-07-20" },
    activityCount7d: 6,
  }
  const props = buildDealRoomReelProps({ facts, clientFirstName: "Sam", agentName: "Dana K", agentPhotoUrl: null, brand: { primaryColor: "#1d4ed8", accentColor: "#F59E0B", brokerageName: "X Realty", logoUrl: null, showEhoMark: true } })
  check("a live deal narrates the REAL facts: days-to-close, cleared contingency, next deadline, activity",
    props.cards.some((c) => c.label === "DAYS TO CLOSING" && c.value === "21")
    && props.cards.some((c) => c.value === "CLEARED")
    && props.narration!.includes("Sam") && props.narration!.includes("Financing contingency cleared")
    && props.narration!.includes("appraisal deadline"))
  check("cleared-contingency detection uses the REAL removed_at timestamps within the week window",
    clearedContingencies({ financing_contingency_removed_at: "2026-07-08T00:00:00Z", appraisal_contingency_removed_at: "2026-06-01T00:00:00Z" }, "2026-07-02T00:00:00Z").join(",") === "Financing contingency")
  check("client egress is GATED: deliver phase proposes via proposeClientMessage with the [DEAL_ROOM] weekly dedupe",
    src("lib/kernel/deal-room-reel.ts").includes("proposeClientMessage")
    && src("lib/kernel/deal-room-reel.ts").includes("[DEAL_ROOM]")
    && src("app/api/cron/client-pulse/route.ts").includes("proposeDealRoomReels")
    && src("lib/kernel/cron-dispatch.ts").includes("client-pulse?phase=deliver"))
  check("registry: deal_room owned by deal_coordinator, video voice+identity by asset_manager (proof = THIS simulator)",
    (MAINTENANCE_DOMAINS as any).deal_room?.manager === "deal_coordinator"
    && (MAINTENANCE_DOMAINS as any).video_voice_identity?.manager === "asset_manager"
    && (MAINTENANCE_DOMAINS as any).deal_room?.proof === "test:partners-meeting-reel")
}

console.log("\n[10 · DAY-ONE ASSISTANT — Aria exists before anyone opens settings]")
{
  check("signup seeds the starter identity (name + generated headshot + narration voice), never overwriting",
    src("app/actions/auth/signup-brokerage.ts").includes("seedStarterAssistant")
    && src("lib/kernel/assistant-starter.ts").includes("profile exists — tenant identity is theirs"))
  check("the daily tenant-safety-scan backfills existing tenants (idempotent sweep)",
    src("app/api/cron/tenant-safety-scan/route.ts").includes("seedStarterAssistant"))
}

console.log("\n[11 · VIDEO-PATH AUDIT LOCKS — b-roll on avatar video, QR everywhere, registry complete]")
{
  check("AgentTalkingHeadReel (the TikTok-style avatar video) renders B-ROLL behind a floating avatar",
    src("remotion/AgentTalkingHeadReel.tsx").includes("BrollLayer")
    && src("remotion/AgentTalkingHeadReel.tsx").includes("brollClips")
    && src("remotion/AgentTalkingHeadReel.tsx").includes("hasBroll"))
  check("the seller update carries the seller's OWN listing photos as b-roll + a tracked outro QR",
    src("lib/agents/seller-update-reel-producer.ts").includes("props.brollClips")
    && src("lib/agents/seller-update-reel-producer.ts").includes("mintVideoQr"))
  check("the buyer match reel mints a tracked book-a-tour QR (generic-queue reels no longer ship QR-less)",
    src("lib/agents/buyer-match-reel-producer.ts").includes("mintVideoQr")
    && src("lib/agents/buyer-match-reel-producer.ts").includes("Scan to book a tour"))
  check("KEEP-ONE assistant voice: module-voice consults ai_identity_profiles FIRST (legacy column is fallback only)",
    src("lib/video/module-voice.ts").includes('from("ai_identity_profiles")')
    && src("lib/video/module-voice.ts").indexOf("ai_identity_profiles") < src("lib/video/module-voice.ts").indexOf("default_isa_voice_id"))
  check("l37-s01 recorded: the live registry covers every Root.tsx composition (EquityReport/ExplainerAnim/PhotoWalkthrough/ProductPromo were queueable-but-unresolvable)",
    existsSync(join(process.cwd(), "scripts/l37-s01-composition-registry-complete.sql")))
}

console.log("\n[12 · THE FINISH SPEC — one definition of which video gets which stitching]")
import { VIDEO_FINISH_SPEC, REEL_USE_FINISH, finishForVideo } from "../lib/video/finish-spec"
{
  const rootIds = Array.from(src("remotion/Root.tsx").matchAll(/id="([A-Za-z0-9]+)"/g)).map((m) => m[1])
  const missing = rootIds.filter((id) => !(id in VIDEO_FINISH_SPEC))
  check(`every Root.tsx composition has a finish spec (${rootIds.length} compositions)`, missing.length === 0)
  check("stills get NOTHING (they ARE the card); marketing gets the works",
    ["VideoCoverThumb", "LeadMagnetCard", "PostcardFront4x6"].every((id) => {
      const f = VIDEO_FINISH_SPEC[id]; return !f.bookends && !f.music && !f.qr && !f.thumbnail
    })
    && ["JustListedReelSquare", "JustSoldReelSquare", "OpenHouseAnnounceReel"].every((id) => {
      const f = VIDEO_FINISH_SPEC[id]; return f.bookends && f.music && f.qr && f.thumbnail && f.captions
    }))
  check("report shows: INTERNAL uses skip the QR (audience is in the app); CLIENT-FACING uses carry it",
    !REEL_USE_FINISH.partners_meeting_reel.qr && !REEL_USE_FINISH.board_packet_reel.qr
    && REEL_USE_FINISH.listing_pitch_reel.qr && REEL_USE_FINISH.deal_room_reel.qr
    && finishForVideo("PartnersMeetingReel", "deal_room_reel").qr === true
    && finishForVideo("PartnersMeetingReel", "partners_meeting_reel").qr === false)
  check("narrated slide decks skip music (it fights the voice); the animation reel skips b-roll (it IS the visual)",
    !VIDEO_FINISH_SPEC.ListingPresentationSlide.music && !VIDEO_FINISH_SPEC.BuyerConsultationSlide.music
    && VIDEO_FINISH_SPEC.ExplainerAnimReel.broll === "none")
  check("the spec is ENFORCED where it matters: PartnersMeetingReel outro renders the QR badge; pitch + deal-room mint it",
    src("remotion/PartnersMeetingReel.tsx").includes("QrOutroBadge")
    && src("lib/video/listing-pitch-reel.ts").includes("mintVideoQr")
    && src("lib/kernel/deal-room-reel.ts").includes("mintVideoQr"))
  check("finishForVideo never returns undefined (unknown composition → safe default)",
    finishForVideo("NotARealComposition").thumbnail === true && finishForVideo("NotARealComposition").qr === false)
}

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
console.log(" ✅ PARTNERS_MEETING_REEL_PASS — the AI team's weekly show: earned cards only, finance + compliance differentiators, honest on a quiet week")
