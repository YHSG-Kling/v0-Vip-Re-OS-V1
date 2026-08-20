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
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
// Tolerate a missing file — every other simulator in this repo does. A file
// that no longer EXISTS trivially satisfies an absence assertion, and throwing
// ENOENT instead turns a legitimate deletion into a crashed sweep.
const src = (p: string) =>
  existsSync(join(process.cwd(), p)) ? readFileSync(join(process.cwd(), p), "utf8") : ""
/** Every file under app/ or lib/ that still mentions the dropped HeyGen column. */
function heygenCloneColumnSites(): string[] {
  const hits: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(join(process.cwd(), dir))) {
      if (name === "node_modules" || name.startsWith(".")) continue
      const rel = `${dir}/${name}`
      if (statSync(join(process.cwd(), rel)).isDirectory()) { walk(rel); continue }
      if (!/\.(ts|tsx)$/.test(name)) continue
      // USE, not mention. The manager-registry entry that DOCUMENTS the purge
      // necessarily names the dropped column in its prose, and a doc string is
      // not a read or a write. Match the column only where it is actually used:
      // selected, filtered on, or assigned in an object literal.
      const text = readFileSync(join(process.cwd(), rel), "utf8")
      const used =
        /heygen_voice_clone_id\s*:/.test(text) ||                    // object-literal write
        /\.eq\(\s*["']heygen_voice_clone_id["']/.test(text) ||        // filter
        /select\([^)]*heygen_voice_clone_id/.test(text)              // projection
      if (used) hits.push(rel)
    }
  }
  walk("app"); walk("lib")
  return hits
}

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
  // Owner corrections (2026-07-09): the HOUSE is the star of listing marketing
  // (photos + status sign + voiceover, no talking head); explainers, market
  // updates and narrated slide decks present with the CIRCLE avatar.
  check("listing marketing: photos + status sign + VOICEOVER — no presenter competing with the home",
    VIDEO_FINISH_SPEC.JustListedReel.presenter === "none"
    && VIDEO_FINISH_SPEC.JustListedReelSquare.presenter === "none"
    && VIDEO_FINISH_SPEC.JustSoldReelSquare.presenter === "none")
  check("explainer / market update / narrated slide decks present with the CIRCLE avatar",
    VIDEO_FINISH_SPEC.AgentExplainerReel.presenter === "circle_pip"
    && VIDEO_FINISH_SPEC.MarketUpdateReel.presenter === "circle_pip"
    && VIDEO_FINISH_SPEC.ListingPresentationSlide.presenter === "circle_pip"
    && VIDEO_FINISH_SPEC.BuyerConsultationSlide.presenter === "circle_pip")
  check("the personal talking head stays full-frame (it IS the message)",
    VIDEO_FINISH_SPEC.AgentTalkingHeadReel.presenter === "did_talking_head")
}

console.log("\n[13 · ONE FINISH LINE + SUPABASE-HOSTED DELIVERY]")
{
  check("finished media is hosted on SUPABASE STORAGE (video-assets bucket), Blob only as fallback — one helper, every upload site",
    src("lib/remotion/media-host.ts").includes('storage.from("video-assets")')
    && src("lib/remotion/render-coordinator.ts").includes("hostRenderedMedia")
    && src("app/api/internal/remotion/render-composition/route.ts").includes("hostRenderedMedia")
    && src("lib/video/reel-voiceover.ts").includes("hostRenderedMedia"))
  check("the newsletter route rides the coordinator finish line (bookends + music + capture + audit) instead of a raw-cut upload",
    src("app/api/internal/remotion/render-newsletter-video/route.ts").includes("finalizeCoordinatedRender")
    && src("app/api/internal/remotion/render-newsletter-video/route.ts").includes("no voiceover_url in input_props"))
  check("the just-listed route rides the finish line too — music + Supabase hosting + companion thumbnail; registry bookends OFF (hybrid D-ID stitches later, never doubled)",
    src("app/api/internal/remotion/render-just-listed/route.ts").includes("finalizeCoordinatedRender")
    && src("app/api/internal/remotion/render-just-listed/route.ts").includes("intent.applyBookends = false")
    && src("app/api/internal/remotion/render-just-listed/route.ts").includes('"VideoCoverThumb"'))
}

console.log("\n[14 · WORD-SYNCED CAPTIONS + THE RENDER PROOF BUTTON]")
{
  check("reel narration uses the TIMESTAMPED TTS path (alignment for word-accurate cues; plain synthesis as fallback)",
    src("lib/video/reel-voiceover.ts").includes("synthesizeSpeechWithTimestamps")
    && src("lib/video/reel-voiceover.ts").includes("alignment"))
  check("client-facing report reels (pitch + Deal Room) build caption cues from the real alignment; the composition renders them",
    src("lib/video/listing-pitch-reel.ts").includes("buildCaptionPlan")
    && src("lib/kernel/deal-room-reel.ts").includes("buildCaptionPlan")
    && src("remotion/PartnersMeetingReel.tsx").includes("CaptionLayer"))
  check("one-click STAGED RENDER PROOF: providers-gated action queues a real video through the full deployed pipeline",
    src("app/actions/superadmin/go-live-readiness.ts").includes("queueRenderPipelineProbeAction")
    && src("app/actions/superadmin/go-live-readiness.ts").includes('"render_probe"')
    && src("app/dashboard/superadmin/connectors/go-live-card.tsx").includes("Queue render proof"))
}

console.log("\n[15 · THE AUTONOMOUS VIDEO PLAYS — the white space the competitive survey confirmed]")
import { detectRateMoment, isTestimonialWorthy, isWalkthroughEligible } from "../lib/video/video-plays"
{
  check("rate moment: an eighth-point 30yr DROP fires with an honest label; rises + noise NEVER manufacture urgency",
    detectRateMoment(662.5, 675).moment === true
    && detectRateMoment(662.5, 675).label.includes("dropped 0.13% to 6.63%")
    && detectRateMoment(675, 662.5).moment === false
    && detectRateMoment(670, 675).moment === false
    && detectRateMoment(null, 675).moment === false)
  check("testimonial-worthy: five stars + real words + no video yet; thin/unrated/already-filmed never become videos",
    isTestimonialWorthy({ rating: 5, review_text: "The team was incredible from listing to closing day, truly.", video_url: null }) === true
    && isTestimonialWorthy({ rating: 4, review_text: "The team was incredible from listing to closing day, truly.", video_url: null }) === false
    && isTestimonialWorthy({ rating: 5, review_text: "Great!", video_url: null }) === false
    && isTestimonialWorthy({ rating: 5, review_text: "The team was incredible from listing to closing day, truly.", video_url: "https://x/v.mp4" }) === false)
  check("walkthrough premiere: marketing-window + ≥5 photos; staged/sold/thin listings skipped",
    isWalkthroughEligible({ lifecycle_stage: "MLS_ACTIVE", photos: [1, 2, 3, 4, 5] }) === true
    && isWalkthroughEligible({ lifecycle_stage: "MLS_ACTIVE", photos: [1, 2] }) === false
    && isWalkthroughEligible({ lifecycle_stage: "SOLD", photos: [1, 2, 3, 4, 5] }) === false)
  check("the Director learned photo_walkthrough — every VIDEO play stages through commissionVideo (direct queueing is reserved for the print STILLS: flyer + door hanger)",
    src("lib/video/video-director.ts").includes('"photo_walkthrough"')
    && src("lib/video/video-plays.ts").includes("commissionVideo")
    && (src("lib/video/video-plays.ts").match(/recordRenderQueued/g) ?? []).length <= 4
    && src("lib/video/video-plays.ts").includes('compositionId: "ListingFlyer"')
    && src("lib/video/video-plays.ts").includes('compositionId: "DoorHanger"'))
  check("wiring: market-moment rides the rates cron tick; testimonial + walkthrough ride the daily video-plays cron (asset_manager-owned)",
    src("app/api/cron/refresh-market-rates/route.ts").includes("runMarketMomentReels")
    && src("app/api/cron/video-plays/route.ts").includes("runTestimonialReels")
    && src("lib/kernel/cron-dispatch.ts").includes("/api/cron/video-plays")
    && src("lib/kernel/manager-registry.ts").includes('"/api/cron/video-plays": "asset_manager"'))
}

console.log("\n[16 · NO HEYGEN + THE ASSISTANT'S WARDROBE (real options for face + voice)]")
import { ASSISTANT_VOICE_OPTIONS, ASSISTANT_FACE_BRIEFS, assistantVoiceLabel } from "../lib/video/assistant-options"
{
  check("D-ID + ElevenLabs ONLY: no live HeyGen network path; voice clones read/write the CANONICAL elevenlabs_voice_id (heygen column dropped live, l38-s01)",
    // Was a per-FILE absence check naming video-voice.types.ts. That file has
    // since been deleted (its SampleManifest/VoiceTrainingJob types described an
    // asynchronous voice-training pipeline this product never had — the
    // ElevenLabs clone is synchronous), and an absence assertion against a
    // deleted file proves nothing. Asserting the CONSTRUCT instead: the column
    // appears NOWHERE under app/ or lib/.
    heygenCloneColumnSites().length === 0
    && existsSync(join(process.cwd(), "scripts/l38-s01-heygen-purge.sql")))
  check("the dead HeyGen-era branding presets + zero-caller updateAgentVideoProfile are GONE (keep-one: resolveReelBrand is the brand source)",
    !src("app/actions/video-generation.ts").includes('.from("video_branding_presets")')
    && !src("app/actions/video-generation.ts").includes("export async function updateAgentVideoProfile"))
  check("assistant VOICE options are curated ElevenLabs PREMADES (≥5 distinct, labeled by style; the old Azure Neural list is gone)",
    ASSISTANT_VOICE_OPTIONS.length >= 5
    && new Set(ASSISTANT_VOICE_OPTIONS.map((v) => v.voiceId)).size === ASSISTANT_VOICE_OPTIONS.length
    && ASSISTANT_VOICE_OPTIONS.every((v) => v.style.length > 10)
    && assistantVoiceLabel("21m00Tcm4TlvDq8ikWAM") === "Rachel"
    && assistantVoiceLabel("custom-clone-id") === null
    && !src("app/actions/video-voice.ts").includes("en-US-JennyNeural"))
  check("assistant FACE options: ≥3 distinct persona briefs render a pick-one gallery (never a real person's photo)",
    ASSISTANT_FACE_BRIEFS.length >= 3
    && new Set(ASSISTANT_FACE_BRIEFS.map((b) => b.key)).size === ASSISTANT_FACE_BRIEFS.length)
  check("the identity editor offers BOTH pickers and the save action persists them (avatar_url + elevenlabs_voice_id)",
    src("app/components/ai-identity/AIIdentityEditor.tsx").includes("Generate face options")
    && src("app/components/ai-identity/AIIdentityEditor.tsx").includes("ASSISTANT_VOICE_OPTIONS")
    && src("app/actions/ai-identity.ts").includes("elevenlabs_voice_id: input.assistantVoiceId"))
}

console.log("\n[17 · VOICE PREVIEW + THE SELLER SCAN CURVE]")
import { buildSellerUpdateMessage } from "../lib/agents/seller-update-reel-producer"
{
  check("every voice card has a PLAY preview (canonical TTS, budget-gated, data-URL playback)",
    src("app/actions/ai-identity.ts").includes("previewAssistantVoiceAction")
    && src("app/actions/ai-identity.ts").includes("audioDataUrl")
    && src("app/components/ai-identity/AIIdentityEditor.tsx").includes("previewAssistantVoiceAction"))
  const withScans = buildSellerUpdateMessage(
    { listingAddress: "12 Oak Ln", showingsThisWeek: 3, interestLabel: "strong", daysOnMarket: 9, listPrice: 500000, videoScans: 37 }, "Dana K", "https://x/v.mp4")
  const noScans = buildSellerUpdateMessage(
    { listingAddress: "12 Oak Ln", showingsThisWeek: 3, interestLabel: "strong", daysOnMarket: 9, listPrice: 500000, videoScans: 0 }, "Dana K", null)
  check("the seller update SPEAKS the scan curve when earned ('your videos drove N scans') and stays silent at zero",
    withScans.body.includes("37 QR scans from interested buyers")
    && !noScans.body.includes("QR scan"))
  check("the scan curve reads the LIVE ledger (qr_codes.scan_count, listing-scoped)",
    src("lib/agents/seller-update-reel-producer.ts").includes('.eq("listing_id", listingId)')
    && src("lib/agents/seller-update-reel-producer.ts").includes("scan_count"))
}

console.log("\n[18 · HEYGEN GONE FROM THE SCHEMA + D-ID V4 EXPRESSIVE ENGINE]")
{
  const sweep = ["lib/kernel/video.ts", "lib/kernel/brand-compliance.ts", "lib/kernel/marketing.ts",
    "lib/ai-isa/isa-outreach-logger.ts", "app/actions/listing-media.ts", "app/actions/video/create-video-project.ts",
    "app/dashboard/listings/[id]/media/components/video-panel.tsx", "app/components/features/video/VideosDashboard.tsx"]
  check("ZERO heygen_* COLUMN references remain (l39-s01 dropped the five ai_video_projects columns live; canonical provider_* everywhere)",
    // `.replace(/\/\/.*|\* .*/g, "")` used to stand here. Besides being the wrong way to
    // remove a line comment, its second alternative deleted from any `* ` to end of line —
    // which is a multiplication in live code, not a comment. Measured over the 8 files
    // this sweep reads, it blanked 117,663 characters across 9,111 lines that are code.
    sweep.every((f) => !/heygen_(avatar_id|voice_id|template_id|video_id|status)\b/.test(stripComments(src(f))))
    && existsSync(join(process.cwd(), "scripts/l39-s01-heygen-columns-drop.sql")))
  check("the snapshot tracks provider_avatar_id/provider_voice_id/provider_template_id (drift guard sees the real schema)",
    ["provider_avatar_id", "provider_voice_id", "provider_template_id"].every((c) => {
      const m = src("scripts/schema-snapshot.ts").match(/^  ai_video_projects: \[(.*?)\],$/m)
      return !!m && m[1].includes(`"${c}"`)
    }))
  check("the dead HeyGen cost-fallback module is DELETED (zero callers; D-ID is the only engine choice)",
    !existsSync(join(process.cwd(), "lib/marketing/video-provider-cost.ts")))
  check("D-ID V4 EXPRESSIVE (owner rule): expressive avatars (@avt_ ids) submit to /expressives with a sentiment mapped from the agent's expression; photo avatars keep /talks; the poller covers both",
    src("lib/did/index.ts").includes('didPost("/expressives"')
    && src("lib/did/index.ts").includes("sentiment_id")
    && src("lib/did/index.ts").includes('includes("@avt_")')
    && src("app/api/cron/poll-did-videos/route.ts").includes('"expressives"'))

  // ── THE CODE HALF OF THE PURGE (l39) ──────────────────────────────────────
  // The schema stopped saying HeyGen; the CODE still did. app/actions/
  // heygen-avatars.ts read agent_avatar_assets and called api.elevenlabs.io,
  // and generateHeyGenVideo posted to api.d-id.com — the names were kept "for
  // backward-compat with existing importers". A name is not a compatibility
  // surface: anyone auditing which vendors this platform pays, or grepping for
  // HeyGen before an integration decision, found a live-looking HeyGen surface
  // that does not exist. Worse, the failure strings shipped it to users — an
  // agent whose D-ID render failed was told "HeyGen video generation failed".
  const RENAMED: Array<[string, string]> = [
    ["generateHeyGenVideo",  "generateAvatarVideo"],
    ["getHeyGenVideoStatus", "getAvatarVideoStatus"],
    ["submitToHeyGen",       "submitAvatarVideoRender"],
    ["getHeyGenAvatars",     "getDidAvatars"],
    ["listHeygenVoices",     "listElevenLabsVoices"],
    ["HeyGenAvatar",         "AvatarOption"],
    ["HeyGenVoice",          "VoiceOption"],
    ["heygenStatus",         "providerStatus"],
  ]
  const CODE = ["app/actions/avatar-voice-catalog.ts", "app/actions/external-services.ts",
    "app/actions/video-generation.ts", "app/actions/video/create-video-project.ts",
    "app/components/features/education/EducationEditor.tsx",
    "app/dashboard/videos/board/page.tsx", "lib/kernel/video.ts"]
  // Comments are stripped: these files legitimately DISCUSS the purge.
  const code = (f: string) => stripComments(src(f))
  for (const [old, now] of RENAMED) {
    check(`${old} is gone from live code — it is ${now}`,
      CODE.every((f) => !new RegExp(`\\b${old}\\b`).test(code(f))))
  }
  check("the file itself is renamed (it lists D-ID avatars and ElevenLabs voices)",
    !existsSync(join(process.cwd(), "app/actions/heygen-avatars.ts"))
    && existsSync(join(process.cwd(), "app/actions/avatar-voice-catalog.ts")))
  check("…and no importer still points at the old path",
    CODE.every((f) => !/heygen-avatars/.test(code(f))))
  check("NO USER-FACING STRING blames HeyGen for a D-ID failure",
    CODE.every((f) => !/(error|error_message)[:\s].*HeyGen/i.test(code(f))))

  // The ONE deliberate survivor. Legacy training assets were rendered by HeyGen
  // before the purge and are still hosted there — the player must keep matching
  // the real domain or those videos stop playing.
  check("legacy training playback still recognises heygen.com (deliberate — those assets exist)",
    src("app/dashboard/onboarding/training/[id]/video-player-client.tsx").includes('url.includes("heygen.com")'))
}

console.log("\n[19 · THE MOVING ASSISTANT + SENTIMENT-FROM-CONTENT (V4 era)]")
import { ASSISTANT_EXPRESSIVE_AVATARS } from "../lib/video/assistant-options"
import { sentimentForSituation } from "../lib/video/video-director"
import { stripComments } from "./strip-comments"
{
  check("expressive presenter options exist and every id carries the @avt_ marker lib/did routes to /expressives",
    ASSISTANT_EXPRESSIVE_AVATARS.length >= 1
    && ASSISTANT_EXPRESSIVE_AVATARS.every((a) => a.avatarId.includes("@avt_")))
  check("the identity chain carries expressiveAvatarId (profile column → resolver → the weekly-show producer submits actorId)",
    src("lib/video/video-identity.ts").includes("did_expressive_avatar_id")
    && src("lib/intelligence/partners-meeting.ts").includes("actorId: identity.expressiveAvatarId")
    && src("app/actions/ai-identity.ts").includes("did_expressive_avatar_id: input.assistantExpressiveAvatarId"))
  check("the editor offers Photo-only vs moving presenter vs custom @avt_ id",
    src("app/components/ai-identity/AIIdentityEditor.tsx").includes("ASSISTANT_EXPRESSIVE_AVATARS")
    && src("app/components/ai-identity/AIIdentityEditor.tsx").includes("Photo only"))
  check("SENTIMENT-FROM-CONTENT: wins are happy, analysis is serious, default warm-neutral; the director render uses it as the fallback performance",
    sentimentForSituation("just_sold") === "happy" && sentimentForSituation("testimonial") === "happy"
    && sentimentForSituation("market_update") === "serious" && sentimentForSituation("explainer") === "neutral"
    && src("app/api/cron/director-reel-render/route.ts").includes("sentimentForSituation"))
  check("client-facing rule intact: contact_facing identity NEVER returns an assistant/expressive presenter",
    src("lib/video/video-identity.ts").includes("contact_facing — the licensed human, full stop"))
}

console.log("\n[20 · ONE PERSONA EVERYWHERE — the portal wears the AGENT'S face, chat remembers]")
{
  const route = src("app/api/portal/ai-chat/route.ts")
  check("PORTAL RULE (owner): the contact's chat shows THEIR AGENT (photo + name) with the assistant disclosed as the AI, reviewed by the agent",
    route.includes("agentPhotoUrl") && route.includes("identityOnly")
    && src("app/components/features/portal/ai/PortalAIAssistant.tsx").includes("AI, reviewed by your agent"))
  check("CONTINUITY: the context spine (shared memory across calls, videos, chat) rides the portal prompt — referenced naturally, never contradicted, never invented beyond",
    route.includes("context_spine") && route.includes("WHAT THE TEAM ALREADY KNOWS"))
  check("the prompt frames the team correctly: the assistant works FOR the agent",
    route.includes("you are the assistant, ${agentName} is their agent"))
  check("DAY-ONE INTRO: the seeded assistant introduces itself on camera (D-ID from its generated headshot; a render failure never blocks the seed)",
    src("lib/kernel/assistant-starter.ts").includes("MEET YOUR ASSISTANT")
    && src("lib/kernel/assistant-starter.ts").includes("the intro is a delight, not a dependency"))
}

console.log("\n[21 · THE EXPRESSIVE LOOP, CLOSED — engine recorded, never guessed]")
{
  const did = src("lib/did/index.ts")
  check("generateVideo RECORDS the engine on every return path (talks = V2 photo, expressives = V4)",
    did.includes('engine?: "talks" | "expressives"')
    && (did.match(/engine: isV4Expressive \? "expressives" : "talks"/g) ?? []).length >= 3)
  check("the director render stamps provider_metadata.mode='expressive' from the RECORDED engine; the poll cron keys off the record (prefix survives only for legacy rows)",
    src("app/api/cron/director-reel-render/route.ts").includes('r.engine === "expressives" ? "expressive"')
    && src("app/api/cron/poll-did-videos/route.ts").includes("RECORDED provider_metadata.mode"))
  check("the persisted D-ID copy rides the SUPABASE media host (storage-first, blob fallback) — no bare blob put",
    did.includes("hostRenderedMedia") && !did.includes('await put(`workflow-video/'))
  check("an expressive render with no photo is a VIDEO, not mislabeled audio (the weekly show's kind check)",
    src("lib/intelligence/partners-meeting.ts").includes('identity.expressiveAvatarId || identity.avatarPhotoUrl ? "video" : "audio"'))
}

console.log("\n[22 · THE FLYWHEEL FOUNDATION + THE STUDIO'S V4 FUTURE, STRUCTURAL]")
{
  check("SENTIMENT RECORDED at commission (video_metadata.sentiment) — you can't learn what you don't record; outcome-learning reads it like format-learning reads composition_id",
    src("lib/video/video-director.ts").includes("sentiment: sentimentForSituation(situation.kind)"))
  check("the PERFORMED expression is recorded on the render (provider_metadata.expression_used) — the flywheel's outcome dimension",
    src("app/api/cron/director-reel-render/route.ts").includes("expression_used"))
  check("STRUCTURAL V4 INHERITANCE: the Studio's avatar ids pass straight through resolveAvatarSource as actorId, and lib/did routes @avt_ ids to /expressives — the day D-ID ships custom expressive avatar creation, every agent inherits V4 with ZERO pipeline change",
    src("lib/did/index.ts").includes("if (input.actorId) return { actorId: input.actorId }")
    && src("lib/did/index.ts").includes('includes("@avt_")'))
}

console.log("\n[23 · PRINT TOP-OF-LINE — the LISTING FLYER closes the family the QR system anticipated]")
{
  const rootIds2 = Array.from(src("remotion/Root.tsx").matchAll(/id="([A-Za-z0-9]+)"/g)).map((m) => m[1])
  check("ListingFlyer exists: 8.5x11 @ 300 DPI print still (2625x3375 bleed canvas), registered in Root + the finish spec (stills ARE the deliverable)",
    rootIds2.includes("ListingFlyer")
    && src("remotion/ListingFlyer.tsx").includes("2625") && src("remotion/ListingFlyer.tsx").includes("3375")
    && VIDEO_FINISH_SPEC.ListingFlyer.bookends === false && VIDEO_FINISH_SPEC.ListingFlyer.music === false
    && existsSync(join(process.cwd(), "scripts/l41-s01-listing-flyer.sql")))
  check("the flyer carries the full print discipline: hero + price band + facts strip + agent block + tracked QR + EHO/license footer",
    ["heroImageUrl", "qrCodeDataUrl", "Equal Housing Opportunity", "agentPhone", "statusLine"].every((s2) => src("remotion/ListingFlyer.tsx").includes(s2)))
  check("the flyer play runs on the video-plays cron: photo-rich marketing-window listings, idempotent per listing, finished PNG delivered to THE AGENT",
    src("lib/video/video-plays.ts").includes("runListingFlyers")
    && src("lib/video/video-plays.ts").includes('"listing_flyer"')
    && src("lib/video/video-plays.ts").includes("Scan to tour")
    && src("app/api/cron/video-plays/route.ts").includes("runListingFlyers"))
  check("image generation is on the CURRENT model (gpt-image-1 via the AI Gateway) — flyer/postcard image inputs are top-of-line",
    src("lib/ai/image-generation.ts").includes("gpt-image-1"))
}

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
console.log(" ✅ PARTNERS_MEETING_REEL_PASS — the AI team's weekly show: earned cards only, finance + compliance differentiators, honest on a quiet week")
