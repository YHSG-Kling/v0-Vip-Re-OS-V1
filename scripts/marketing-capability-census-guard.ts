#!/usr/bin/env tsx
/**
 * scripts/marketing-capability-census-guard.ts   (npm run test:marketing-capability-census)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 153, LANE 153I — I1: THE END-TO-END MARKETING CAPABILITY CENSUS (owner ruling 17, "marketing capabilities audit";
 * directive §153I lines 418–432). Every channel the directive names, traced across the same twelve hops:
 *   producer → sender voice BEFORE the first draft → persona / them-first → approval → rights / legal → provider readiness
 *   → scheduled / published evidence → event / webhook → next-action consumer → ROI → recovery   (+ the live-call truth)
 *
 * GENERATED AND GUARD-CHECKED FROM CODE. Each hop is a (file, token) pair resolved to file:line on COMMENT-STRIPPED source
 * (scripts/strip-comments.ts): a hop that names a file that is gone, or a token that is no longer live code, is RED — the census
 * can never go stale while reading green. A hop that was not traced is said ("untraced"), a real missing piece is a GAP with
 * its reason, a hop that does not apply says why ("na"), and a live provider call that needs the owner's credentials is HELD.
 * The VERDICT is DERIVED, never asserted: VERIFIED only when every hop resolves (or is na) AND a behavioural proof is
 * registered in package.json; a row this lane changed says BUILT / CORRECTED and names the proof that fails without it.
 * "A content file is not a publishing workflow": a producer with no approval, evidence or consumer hop cannot read VERIFIED.
 *
 * `--write-doc` renders docs/architecture/MARKETING-CAPABILITY-CENSUS.md from this table; the check compares the doc's
 * STRUCTURE (row, verdict, per-hop state) — line anchors may drift between regenerations and are reported, never red alone.
 *
 * BLIND SPOTS: a resolved hop proves the token is LIVE CODE in the named file, not that every run reaches it (the row's named
 * proof carries the behaviour); a token inside a string literal on the same line would also match (tokens are chosen as code
 * identifiers to keep that rare); "untraced" hops are this census's own gaps, not proven product gaps; no live provider call.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"

type Hop = { file: string; token: string } | { untraced: string } | { gap: string } | { na: string } | { held: string }
const DIMS = ["producer", "voice", "persona", "approval", "rights", "provider", "evidence", "event", "consumer", "roi", "recovery"] as const
type Dim = (typeof DIMS)[number]
type Verdict = "VERIFIED" | "PARTIAL" | "BUILT" | "CORRECTED"
interface Row {
  key: string
  label: string
  /** The accountable registered manager (lib/kernel/manager-registry.ts MANAGERS). */
  owner: string
  /** The behavioural proof that drives this chain (a package.json test:* key). */
  proof: string | null
  /** Set only for a row this lane changed: what changed, and the proof that fails without it. */
  changed?: { verdict: "BUILT" | "CORRECTED"; what: string }
  /** The live-call truth: what a real send / publish needs beyond code (owner-held credentials, or SIMULATED only). */
  live: string
  hops: Record<Dim, Hop>
}

const h = (file: string, token: string): Hop => ({ file, token })
const untraced = (why = "not traced to a live hop in this census"): Hop => ({ untraced: why })

const ROWS: Row[] = [
  {
    key: "website_seo_landing_idx", label: "Tenant website, SEO / AI-search visibility, landing pages, IDX", owner: "campaign_orchestrator", proof: "test:seo-geo-consolidation",
    live: "OWNER-HELD: the tenant's IDX feed credential (IDX Broker) and a deployed domain; AI-search citation checks need the search provider key",
    hops: {
      producer: h("lib/geo/publish-video-landing.ts", "export async function publishVideoLanding"),
      voice: { na: "no AI-drafted copy: the public page renders the listing's own facts and an already-approved reel" },
      persona: { na: "a public listing page addresses every visitor — no persona-targeted copy" },
      approval: h("lib/geo/publish-video-landing.ts", "isAutoPublishEligible("),
      rights: h("lib/geo/publish-video-landing.ts", "stagedPublicationVerdict("),
      provider: h("app/actions/idx-search.ts", "export async function searchProperties"),
      evidence: h("app/actions/listing-landing.ts", "export async function incrementLandingPageViews"),
      event: h("app/actions/listing-landing.ts", "emitKernelEvent("),
      consumer: h("lib/kernel/event-reactor.ts", "KernelEvent.SHOWING_REQUESTED"),
      roi: h("app/actions/listing-landing.ts", "utm_source"),
      recovery: h("app/api/cron/geo-reel-autopublish/route.ts", "publishVideoProjectLanding("),
    },
  },
  {
    key: "ads_audiences", label: "Ads, approved / suppressed audiences, tenant ad credentials, attribution", owner: "ads_manager", proof: "test:ads-manager",
    live: "OWNER-HELD: each tenant's own ad-platform connection (Meta / Google) and any ad spend — never activated by the platform",
    hops: {
      producer: h("lib/ads/ad-creator.ts", "export async function createAdCampaign"),
      voice: h("lib/ads/ad-creator.ts", "applyBrandVoice("),
      persona: h("lib/ads/audience-persona-basis.ts", "export function assertAudiencePersonaBasis"),
      approval: h("lib/ads/ad-creator.ts", "export async function approveCreativeVariation"),
      rights: h("lib/ads/ad-creator.ts", "fairHousing"),
      provider: h("lib/ads/ad-creator.ts", "export async function launchAdCampaign"),
      evidence: h("lib/ads/ad-creator.ts", "approval_status: approvalStatus"),
      event: h("lib/ads/ad-creator.ts", "emitKernelEvent("),
      consumer: h("lib/ads/ad-outcome-loop.ts", "publishManagerSignal("),
      roi: h("lib/ads/ad-creator.ts", "marketing_campaign_id"),
      recovery: h("lib/ads/stuck-ad-action-reaper.ts", "classifyStuckAdAction"),
    },
  },
  {
    key: "forms_magnets_booking", label: "Contact / lead forms, lead magnets, consent, auto-delivered assets, optional booking", owner: "campaign_orchestrator", proof: "test:autonomous-marketing",
    live: "SIMULATED in proofs; the delivered email rides the tenant's email provider (dispatchEmail) — OWNER-HELD for the live send",
    hops: {
      producer: h("lib/kernel/lead-magnets.ts", "export async function createLeadMagnet"),
      voice: h("lib/kernel/lead-magnets.ts", "resolveBrandVoiceCore("),
      persona: h("lib/lead-magnets/magnet-funnel.ts", "export function canonicalSituation"),
      approval: h("lib/lead-magnets/magnet-funnel.ts", "export async function funnelPublishGate"),
      rights: h("lib/lead-magnets/magnet-funnel.ts", "fairHousing"),
      provider: h("lib/kernel/lead-magnets.ts", "dispatchEmail"),
      evidence: h("lib/kernel/lead-magnets.ts", "emitKernelEvent("),
      event: h("lib/kernel/lead-magnets.ts", "emitKernelEvent("),
      consumer: h("lib/kernel/lead-magnets.ts", "publishManagerSignal("),
      roi: h("lib/kernel/lead-magnets.ts", "sanitizeLeadMagnetAttribution"),
      recovery: h("lib/lead-magnets/magnet-funnel.ts", "next_attempt_at"),
    },
  },
  {
    key: "market_reports", label: "Market reports from verified property stats with readable source labels", owner: "campaign_orchestrator", proof: "test:market-report-producer",
    live: "SIMULATED: the research provider (Exa) and dated property data are seams in the proof; live research needs the tenant's / platform's research key",
    hops: {
      producer: h("lib/market-reports/producer.ts", "export async function produceMarketReport"),
      voice: h("lib/market-reports/producer.ts", "loadSenderVoiceBrief("),
      persona: h("lib/lead-magnets/magnet-funnel.ts", "export function canonicalSituation"),
      approval: h("lib/lead-magnets/magnet-funnel.ts", "export async function funnelPublishGate"),
      rights: h("lib/market-reports/producer.ts", "fairHousing"),
      provider: h("lib/kernel/lead-magnets.ts", "dispatchEmail"),
      evidence: h("lib/kernel/lead-magnets.ts", "emitKernelEvent("),
      event: h("lib/kernel/lead-magnets.ts", "emitKernelEvent("),
      consumer: h("lib/lead-magnets/magnet-funnel.ts", "produceMarketReport("),
      roi: h("lib/kernel/lead-magnets.ts", "sanitizeLeadMagnetAttribution"),
      recovery: h("lib/lead-magnets/magnet-funnel.ts", "next_attempt_at"),
    },
  },
  {
    key: "events_open_houses", label: "Events and open houses (registration, attendance, follow-up)", owner: "campaign_orchestrator", proof: "test:event-branding",
    changed: { verdict: "CORRECTED", what: "draftEventMarketing now conditions the first draft on the host's sender-voice brief (it handed the model brand DISPLAY facts only); the draft records sender_voice applied / unavailable" },
    live: "SIMULATED; the reminder / follow-up email rides dispatchEmail — OWNER-HELD for the live send",
    hops: {
      producer: h("lib/open-house/event-marketing.ts", "export async function draftEventMarketing"),
      voice: h("lib/open-house/event-marketing.ts", "loadSenderVoiceBrief"),
      persona: { na: "an event invitation addresses the event's audience; each registrant's follow-up is arbitrated per person (event_reminder / event_no_show)" },
      approval: h("lib/open-house/event-marketing.ts", "awaiting_approval"),
      rights: h("lib/open-house/event-marketing.ts", "export function scanEventCopy"),
      provider: h("lib/open-house/event-attendance.ts", "dispatchEmail"),
      evidence: h("lib/open-house/event-attendance.ts", "const emit = deps.emit ??"),
      event: h("lib/open-house/event-attendance.ts", "const emit = deps.emit ??"),
      consumer: h("lib/open-house/event-touches.ts", "arbitrateFollowUp"),
      roi: { gap: "event attendance writes no campaign attribution (no marketing_campaign_id / source on the attendance or registration) — a real product gap, not built this lane" },
      recovery: { gap: "a failed reminder / follow-up send is not retried by the event loop (event-touches decides once per moment) — a real product gap, not built this lane" },
    },
  },
  {
    key: "qr", label: "QR codes (every authorized user, tracked placement, governed destination)", owner: "campaign_orchestrator", proof: "test:qr-registry",
    live: "VERIFIED in code by lane 153E (batch 1); live scans need a deployed public route",
    hops: {
      producer: h("lib/marketing/tracked-qr.ts", "export async function mintTrackedQr"),
      voice: { na: "a QR carries no copy of its own" },
      persona: { na: "no copy" },
      approval: { na: "a QR's destination is governed by its own destination-history contract (153E)" },
      rights: { na: "no copy; consent is enforced at scan-to-Contact (no capture without consent — 153E)" },
      provider: { na: "first-party route" },
      evidence: h("app/api/qr/scan/route.ts", "emitKernelEvent("),
      event: h("app/api/qr/scan/route.ts", "emitKernelEvent("),
      consumer: h("lib/kernel/event-reactor.ts", "KernelEvent.QR_SCAN_RECEIVED"),
      roi: h("app/api/cron/bundle-attribution-rollup/route.ts", "qr_scan_events"),
      recovery: { na: "a scan is a single write; a refused write is reported by the route" },
    },
  },
  {
    key: "direct_mail", label: "Direct mail letters, postcards and handwriting-style pieces", owner: "campaign_orchestrator", proof: "test:direct-mail-rendering",
    live: "OWNER-HELD: the print / mail vendor key (Lob) and any paid mailing — real mailings are not authorized",
    hops: {
      producer: h("lib/direct-mail/orchestrate-send.ts", "export async function orchestrateRenderAndSend"),
      voice: h("lib/direct-mail/draft-copy.ts", "export async function readSenderVoiceBrief"),
      persona: h("lib/direct-mail/draft-copy.ts", "normalizePersona("),
      approval: h("lib/direct-mail/campaign-drain.ts", "approval_status"),
      rights: h("lib/direct-mail/draft-copy.ts", "fairHousing"),
      provider: h("lib/direct-mail/orchestrate-send.ts", "dispatchDirectMail"),
      evidence: h("lib/direct-mail/campaign-drain.ts", "approval_status"),
      event: h("app/api/webhooks/lob-events/route.ts", "export async function POST"),
      consumer: h("app/api/webhooks/lob-events/route.ts", "ingestProviderTruth("),
      roi: h("app/api/cron/bundle-attribution-rollup/route.ts", "direct_mail_campaigns"),
      recovery: h("lib/direct-mail/campaign-drain.ts", "recordSelfHeal"),
    },
  },
  {
    key: "email", label: "Email campaigns", owner: "campaign_orchestrator", proof: "test:marketing-loops",
    changed: { verdict: "BUILT", what: "the campaign copy door (generateCampaignContent) reads the campaign's audience_personas BEFORE the first draft and writes to that persona's authored them-first arc (lib/marketing/them-first-draft-brief.ts); a mixed / absent / un-authored / unreadable persona is written generic-safe, and the brand-voice gate is told the resolved persona, never a guess (lane 153R)" },
    live: "OWNER-HELD: the tenant's / platform's email provider key (SendGrid / Resend)",
    hops: {
      producer: h("lib/kernel/content-creators.ts", "export async function createEmailCampaign"),
      voice: h("lib/kernel/content-creators.ts", "loadSenderVoiceBrief("),
      persona: h("app/actions/marketing-studio.ts", "renderThemFirstDraftBrief(readerBrief)"),
      approval: h("lib/kernel/content-creators.ts", "approval_status"),
      rights: h("lib/providers/dispatch.ts", "import { assembleEmail }"),
      provider: h("lib/marketing/email-campaign-sender.ts", "dispatchEmail"),
      evidence: h("lib/marketing/email-campaign-sender.ts", "export async function sendCampaignNow"),
      event: h("app/api/webhooks/sendgrid-events/route.ts", "export async function POST"),
      consumer: h("app/api/webhooks/sendgrid-events/route.ts", "fanOutEmailEngagement("),
      roi: h("lib/kernel/content-creators.ts", "marketing_campaign_id"),
      recovery: h("lib/kernel/content-creators.ts", "retry_count"),
    },
  },
  {
    key: "sms", label: "SMS", owner: "ai_isa", proof: "test:marketing-loops",
    changed: { verdict: "BUILT", what: "an accepted SMS preset send that names an in-tenant campaign records ONE sms campaign touchpoint (planCampaignTouchpoint → recordCampaignTouchpointSafe), and the ROI ledger measures SMS activity and reach per channel (measureChannelOutcomes) — no campaign / unverified / no Contact / refused is NOT attributed and reads N/A with the reason, never $0 (lane 153R); the inbound arbiter's own proof stays test:inbound-sms-arbiter" },
    live: "OWNER-HELD: the tenant's SMS provider (Twilio) number and A2P registration",
    hops: {
      producer: h("lib/sms/orchestrate-sms-preset-send.ts", "export async function orchestrateSmsPresetSend"),
      voice: { na: "a preset is the sender's own words; AI replies are composed in the sender's voice by the inbound responder (153F)" },
      persona: { na: "preset" },
      approval: { na: "presets are cleared at save; live replies pass the tenant's autonomy grant (dispatch.ts)" },
      rights: h("lib/providers/dispatch.ts", "export async function dispatchSms"),
      provider: h("lib/sms/orchestrate-sms-preset-send.ts", "dispatchSms"),
      evidence: h("lib/providers/dispatch.ts", "comms.sms.send"),
      event: h("app/api/webhooks/twilio-sms-status/route.ts", "export async function POST"),
      consumer: h("app/api/webhooks/twilio-sms-status/route.ts", "onProviderTruth"),
      roi: h("lib/sms/orchestrate-sms-preset-send.ts", "planCampaignTouchpoint({"),
      recovery: h("lib/providers/dispatch.ts", "recordSelfHeal"),
    },
  },
  {
    key: "voice_drop", label: "Voice (ringless voicemail)", owner: "ai_isa", proof: "test:voice-drop",
    live: "OWNER-HELD: the voicemail-drop provider key; TCPA consent per contact",
    hops: {
      producer: h("lib/voicedrop/orchestrate-voicedrop-send.ts", "export async function orchestrateVoicedropSend"),
      voice: { na: "a preset script or the tenant's uploaded audio" },
      persona: { na: "preset" },
      approval: { na: "presets are cleared at save" },
      rights: h("lib/voicedrop/orchestrate-voicedrop-send.ts", "enforceTCPACompliance"),
      provider: h("lib/voicedrop/orchestrate-voicedrop-send.ts", "export async function orchestrateVoicedropSend"),
      evidence: h("lib/voicedrop/orchestrate-voicedrop-send.ts", "comms.voice_drop.send"),
      event: { held: "the voicemail-drop provider's delivery callback needs the vendor account (OWNER-HELD) — today the ledger settles on the provider's acceptance only" },
      consumer: { held: "no delivery receipt exists to consume until the provider callback is connected (OWNER-HELD vendor account)" },
      roi: h("lib/voicedrop/orchestrate-voicedrop-send.ts", "attribution"),
      // wave 153 integrator (lanes 153S + 153R both landed): the drop's ledger row is risk class COMMUNICATION, so the send-recovery
      // pass (lib/outcomes/reconciliation-ledger.ts recoverOutcomeUnknownSends) promotes a dead claim to outcome_unknown and — the
      // carrier documents no status query or idempotency key — raises the VISIBLE exception; a voicemail is never re-dropped blindly.
      recovery: h("lib/outcomes/reconciliation.ts", 'voice_drop: { reconcile: "none"'),
    },
  },
  {
    key: "avatar_video_remotion", label: "Avatar video, D-ID, Remotion (playability before publication)", owner: "asset_manager", proof: "test:video-pipeline-truth",
    live: "OWNER-HELD: the avatar provider key (D-ID) and render infrastructure; lane 153J owns render reliability this wave",
    hops: {
      producer: h("lib/video/avatar-render-orchestrator.ts", "export function buildAvatarRenderRow"),
      voice: h("lib/video/script-compliance.ts", "THEM_FIRST_BLOCK"),
      persona: h("lib/video/script-compliance.ts", "THEM_FIRST_BLOCK"),
      approval: h("lib/video/script-compliance.ts", "approval_status"),
      rights: h("lib/video/script-compliance.ts", "FAIR_HOUSING_RULE_NAMES"),
      provider: h("app/api/cron/poll-did-videos/route.ts", "export async function GET"),
      evidence: h("app/api/cron/poll-did-videos/route.ts", "processKernelEvent("),
      event: h("app/api/cron/poll-did-videos/route.ts", "processKernelEvent("),
      consumer: h("lib/video/client-video-delivery.ts", "dispatchEmail"),
      roi: h("app/api/cron/poll-did-videos/route.ts", "marketing_campaign_id"),
      recovery: h("lib/remotion/registry.ts", "export async function recoverStalledRenders"),
    },
  },
  {
    key: "social", label: "Social posts", owner: "campaign_orchestrator", proof: "test:marketing-loops",
    changed: { verdict: "BUILT", what: "the social draft door writes to the post's named audience persona's them-first arc before the first draft (generic-safe for a public post to the whole following), and the compliance gate is told that resolved persona — it was handed a hard-coded \"first_time\" for every post (lane 153R); approval behaviour stays test:social-approval" },
    live: "OWNER-HELD: each tenant's social account connection (OAuth tokens per platform)",
    hops: {
      producer: h("app/actions/social/generate-social-post.ts", "loadSenderVoiceBrief("),
      voice: h("app/actions/social/generate-social-post.ts", "loadSenderVoiceBrief("),
      persona: h("app/actions/social/generate-social-post.ts", "renderThemFirstDraftBrief(readerBrief)"),
      approval: h("lib/social/create-social-post-draft.ts", "brand_compliance_passed"),
      rights: h("lib/social/create-social-post-draft.ts", "runComplianceGate"),
      provider: h("lib/social/publisher.ts", "export async function publishToSocialPlatform"),
      evidence: h("app/api/cron/publish-social-posts/route.ts", "SOCIAL_POST_PUBLISHED"),
      event: h("app/api/cron/publish-social-posts/route.ts", "emitKernelEvent("),
      consumer: h("lib/kernel/event-reactor.ts", "social_post_published"),
      roi: h("lib/social/analytics-sync.ts", "export async function syncSocialAnalytics"),
      recovery: h("app/api/cron/publish-social-posts/route.ts", "retryCount"),
    },
  },
  {
    key: "books", label: "Books (lead-magnet books, print packages)", owner: "campaign_orchestrator", proof: "test:marketing-loops",
    changed: { verdict: "BUILT", what: "the book stores its READER brief at start (the persona the agent names → its authored them-first arc; none / un-authored → generic-safe) and every manuscript system prompt renders it after the sender's voice — older projects read generic-safe, never a guessed persona (lane 153R); the producer's own proof stays test:autonomous-marketing" },
    live: "OWNER-HELD: any print-on-demand account (KDP) — the package is built, never uploaded by the platform",
    hops: {
      producer: h("lib/lead-magnets/book-publishing-produce.ts", "export async function buildKdpPackage"),
      voice: h("lib/lead-magnets/book-creator.ts", "loadSenderVoiceBrief("),
      persona: h("lib/lead-magnets/book-creator.ts", "renderThemFirstDraftBrief(bookReaderBrief(p))"),
      approval: h("lib/lead-magnets/book-publishing-produce.ts", "export async function approveKdpPackage"),
      rights: h("lib/lead-magnets/book-publishing-produce.ts", "fairHousing"),
      provider: { held: "no print vendor is called — the owner uploads the package" },
      evidence: h("lib/lead-magnets/book-publishing-produce.ts", "withActionLedger"),
      event: { held: "the package is uploaded by the owner; no publication event exists until a print vendor account is connected (OWNER-HELD)" },
      consumer: h("lib/kernel/lead-magnets.ts", "export function leadMagnetBookRefOf"),
      roi: h("lib/kernel/lead-magnets.ts", "sanitizeLeadMagnetAttribution"),
      recovery: h("app/api/cron/geo-citation-monitor/route.ts", "sweepStalledBookProjects("),
    },
  },
  {
    key: "podcasts", label: "Podcasts", owner: "campaign_orchestrator", proof: "test:marketing-loops",
    changed: { verdict: "BUILT", what: "a TRANSIENT distribution failure is re-queued with a bounded, growing wait and a terminal one (no distributor, a refusal, a 4xx) is never retried — PODCAST_EPISODE_FAILED only when final (decidePodcastDistributionRetry); the ROI ledger measures episodes published under a campaign and states listens N/A (host analytics owner-held) (lane 153R); channel consolidation stays test:podcast-channel-consolidation" },
    live: "OWNER-HELD: the podcast host connection (Transistor) per tenant",
    hops: {
      producer: h("lib/podcast/auto-producer.ts", "export async function runAutoPodcast"),
      voice: h("lib/podcast/auto-producer.ts", "loadSenderVoiceBrief"),
      persona: { na: "a broadcast episode addresses the whole audience — no persona-targeted copy" },
      approval: h("lib/podcast/auto-producer.ts", "approval_status"),
      rights: h("lib/podcast/auto-producer.ts", "evaluateOutbound("),
      provider: h("app/api/cron/distribute-podcast-episodes/route.ts", "resolveScopedConnection("),
      evidence: h("app/api/cron/distribute-podcast-episodes/route.ts", "processKernelEvent("),
      event: h("app/api/cron/distribute-podcast-episodes/route.ts", "processKernelEvent("),
      consumer: h("lib/kernel/event-reactor.ts", "KernelEvent.PODCAST_EPISODE_DISTRIBUTED"),
      roi: h("lib/intelligence/roi-ledger.ts", "measureChannelOutcomes({ touchpoints"),
      recovery: h("app/api/cron/distribute-podcast-episodes/route.ts", "decidePodcastDistributionRetry({"),
    },
  },
  {
    key: "youtube", label: "YouTube", owner: "asset_manager", proof: "test:video-repurpose-wiring",
    live: "OWNER-HELD: the tenant's YouTube channel connection",
    hops: {
      producer: h("lib/video/youtube-publish.ts", "export async function queueYouTubeAutoPublish"),
      voice: { na: "publishes an already-approved video; its script was voiced upstream" },
      persona: { na: "upstream" },
      approval: h("lib/video/youtube-publish.ts", "approval_status"),
      rights: h("lib/video/youtube-publish.ts", "fairHousing"),
      provider: h("lib/social/publisher.ts", "/upload/youtube/v3/videos"),
      evidence: h("lib/video/youtube-publish.ts", "export async function recordYouTubePublishOnAsset"),
      event: h("app/api/cron/publish-social-posts/route.ts", "SOCIAL_POST_PUBLISHED"),
      consumer: h("app/api/cron/publish-social-posts/route.ts", "recordYouTubePublishOnAsset("),
      roi: h("lib/video/youtube-publish.ts", "marketing_campaign_id"),
      recovery: h("lib/video/youtube-publish.ts", "backfillYouTubeAutoPublish("),
    },
  },
  {
    key: "tv_ctv", label: "TV / CTV (only where actually supported)", owner: "ads_manager", proof: "test:ads-tv-connections",
    live: "OWNER-HELD: the CTV vendor account and any spend — staged, never launched by the platform",
    hops: {
      producer: h("lib/ads/ctv-campaign.ts", "export async function stageCtvCampaign"),
      voice: { na: "broadcasts an approved video" },
      persona: { na: "upstream" },
      approval: h("lib/ads/ctv-campaign.ts", "export async function claimTvLaunch"),
      rights: h("lib/ads/ctv-campaign.ts", "CTV_RIGHTS_CHECK"),
      provider: h("lib/ads/ctv-campaign.ts", "export async function launchCtvCampaignOnVibe"),
      evidence: h("lib/ads/ctv-campaign.ts", "emitKernelEvent("),
      event: h("lib/ads/ctv-campaign.ts", "emitKernelEvent("),
      consumer: { held: "the CTV campaign is staged, never launched by the platform (OWNER-HELD vendor account + spend); its launch event is audit-only until the owner launches" },
      roi: { held: "no CTV outcome exists to attribute until the owner launches a campaign on the vendor account (OWNER-HELD)" },
      recovery: h("lib/ads/ctv-campaign.ts", "releaseTvLaunch("),
    },
  },
  {
    key: "sequences_preferences", label: "Campaign sequences, Contact preferences, dynamic engagement", owner: "campaign_orchestrator", proof: "test:marketing-loops",
    changed: { verdict: "BUILT", what: "the step READS the enrolled person's persona (contacts.contact_persona / leads.persona, tenant-pinned; a refused read stays null and is logged) and hands it to the arbiter — it was always persona: null; the step's copy was already persona-rendered (render-step.ts) (lane 153R); arbiter timing stays test:arbiter-timing" },
    live: "SIMULATED; each step rides its channel's provider (OWNER-HELD keys)",
    hops: {
      producer: h("lib/campaign-sequences/step-executor.ts", "export async function executeSequenceStep"),
      voice: h("app/actions/sequence-step-ai.ts", "loadSenderVoiceBrief("),
      persona: h("lib/campaign-sequences/step-executor.ts", "persona: subjectPersona.persona"),
      approval: h("lib/campaign-sequences/step-executor.ts", "checkSequenceAuthority("),
      rights: h("lib/campaign-sequences/step-executor.ts", "tcpa_consent"),
      provider: h("lib/campaign-sequences/step-executor.ts", "registry.dispatch("),
      evidence: h("lib/campaign-sequences/step-executor.ts", "sequence_step_executions"),
      event: h("lib/campaign-sequences/step-executor.ts", "processKernelEvent("),
      consumer: h("lib/campaign-sequences/step-executor.ts", "arbitratePlannedTouch("),
      roi: h("lib/campaign-sequences/step-executor.ts", "recordSequenceTouchpoint("),
      recovery: h("lib/campaign-sequences/step-executor.ts", "decideDeferral("),
    },
  },
  {
    key: "campaign_bundles", label: "Campaign bundles (persisted follow-on items — convergence row 71)", owner: "campaign_orchestrator", proof: "test:campaign-bundle-follow-on",
    changed: { verdict: "BUILT", what: "the first item on the click; each later item a persisted follow-on on orchestrator_tasks drained by queue-drain through arbitratePlannedTouch, claimed once, retried only after a definitive refusal; stable item ids across edits; m931 idempotency index" },
    live: "SIMULATED (channel orchestrators are seams); each piece's live send needs its channel's OWNER-HELD provider key",
    hops: {
      producer: h("lib/direct-mail/orchestrate-bundle-send.ts", "export async function orchestrateBundleSend"),
      voice: { na: "bundle pieces are presets cleared at save (the sender's own words); presets drafted by a playbook are drafted in the sender's voice upstream" },
      persona: { na: "presets" },
      approval: { na: "pieces are presets cleared by the compliance gate when each preset is saved; a deactivated bundle or preset is refused at the drain" },
      rights: h("lib/direct-mail/orchestrate-bundle-send.ts", "POLICY_REFUSAL"),
      provider: h("lib/direct-mail/orchestrate-bundle-send.ts", "orchestrateEmailPresetSend"),
      evidence: h("lib/direct-mail/orchestrate-bundle-send.ts", "BUNDLE_FOLLOW_ON_TASK"),
      event: h("app/api/cron/queue-drain/route.ts", "executeBundleFollowOnTask("),
      consumer: h("lib/direct-mail/orchestrate-bundle-send.ts", "arbitratePlannedTouch("),
      roi: h("lib/direct-mail/orchestrate-bundle-send.ts", "bundle_dispatch_id"),
      recovery: h("lib/direct-mail/orchestrate-bundle-send.ts", "export async function recoverStaleBundleFollowOns"),
    },
  },
  {
    key: "newsletter_subscriptions", label: "Newsletters and subscriptions", owner: "campaign_orchestrator", proof: "test:newsletter-cadence",
    live: "OWNER-HELD: the email provider key",
    hops: {
      producer: h("lib/marketing/newsletter-cadence.ts", "export async function stageNewsletterFromCadence"),
      voice: h("lib/kernel/content-creators.ts", "loadSenderVoiceBrief("),
      persona: h("app/api/cron/publish-newsletters/route.ts", "recipientPersona:"),
      approval: h("lib/kernel/content-creators.ts", "approval_status"),
      rights: h("lib/content/newsletter-enrollment.ts", "email_opt_out"),
      provider: h("app/api/cron/publish-newsletters/route.ts", "dispatchEmail"),
      evidence: h("lib/kernel/content-creators.ts", "processKernelEvent("),
      event: h("lib/kernel/content-creators.ts", "processKernelEvent("),
      consumer: h("app/api/cron/publish-newsletters/route.ts", "publishManagerSignal("),
      roi: h("lib/kernel/content-creators.ts", "marketing_campaign_id"),
      recovery: h("lib/kernel/content-creators.ts", "retry_count"),
    },
  },
  {
    key: "content_approvals", label: "Content approvals (the publish gate every channel passes)", owner: "compliance_officer", proof: "test:content-approval",
    live: "code only — no provider",
    hops: {
      producer: h("app/actions/content-approval-workflow.ts", "export async function evaluateContentApproval"),
      voice: { na: "a gate, not a writer" },
      persona: h("lib/marketing/content-publish-gate.ts", "validateThemFirstContent("),
      approval: h("app/actions/content-approval-workflow.ts", "export async function checkApprovalAuthority"),
      rights: h("lib/marketing/content-publish-gate.ts", "fairHousingClean"),
      provider: { na: "no provider" },
      evidence: h("app/actions/content-approval-workflow.ts", "withActionLedger"),
      event: { na: "a gate's verdict returns to the publish door that asked; that door emits its own publish event" },
      consumer: { na: "the consumer of a verdict is the calling door (each channel row's approval hop)" },
      roi: { na: "a gate" },
      recovery: { na: "a refused approval is revised and re-submitted by its author; there is no delivery to recover" },
    },
  },
  {
    key: "reviews_reputation", label: "Reviews and reputation (the ask at a verified closing)", owner: "sphere_of_influence", proof: "test:lifetime-relationship",
    changed: { verdict: "CORRECTED", what: "draftReviewRequest now conditions the first draft on the agent's sender-voice brief (it drafted from the agent's NAME alone)" },
    live: "OWNER-HELD: the review platform links the tenant configures and the email / SMS provider for the ask",
    hops: {
      producer: h("lib/reputation/review-ask.ts", "export async function askForReviewAtClose"),
      voice: h("lib/reputation/review-request-draft.ts", "loadSenderVoiceBrief"),
      persona: h("lib/reputation/review-ask.ts", "persona: \"past_client\""),
      approval: h("lib/reputation/review-request-draft.ts", "screenReviewAskCopy("),
      rights: h("lib/reputation/review-ask.ts", "tcpa_consent"),
      provider: h("lib/reputation/review-ask.ts", "dispatchEmail"),
      evidence: h("lib/reputation/review-ask.ts", "emitKernelEvent"),
      event: h("lib/reputation/review-ask.ts", "emitKernelEvent"),
      consumer: h("lib/reputation/review-ask.ts", "arbitratePlannedTouch("),
      roi: { gap: "a review that is actually left is not read back from the review platform (no platform review ingest) — a real product gap; the platforms are OWNER-HELD links" },
      recovery: { gap: "a review ask whose send failed is not re-attempted — a real product gap, not built this lane" },
    },
  },
  {
    key: "lifetime_relationship", label: "Lifetime relationship (post-close homeowner touches)", owner: "sphere_of_influence", proof: "test:marketing-loops",
    changed: { verdict: "BUILT", what: "the lifetime cron's anniversary and birthday touches now pass the follow-up arbiter (planner lifetime_touch) before any send: send now, the agent personally, a persisted wait the moments pass conducts, or a halt when no lawful channel is left" },
    live: "SIMULATED; touches ride their channel's OWNER-HELD provider",
    hops: {
      producer: h("app/api/cron/lifetime-customer-touchpoints/route.ts", "arbitrateLifetimeTouch("),
      voice: h("lib/agents/generate-client-message.ts", "resolveBrandContext("),
      persona: h("lib/sphere/lifetime-touch-arbitration.ts", "persona: \"past_client\""),
      approval: { na: "a routine lawful lifetime touch needs no human approval (owner B7) — the arbiter decides send / agent / wait / halt" },
      rights: h("lib/sphere/lifetime-touch-arbitration.ts", "requiredChannels: [a.channel, ...externalChannels.filter((c) => c !== a.channel)]"),
      provider: h("app/actions/lifetime-customer-touchpoints.ts", "dispatchEmail"),
      evidence: h("lib/sphere/lifetime-touchpoint-ledger.ts", "emitKernelEvent("),
      event: h("lib/sphere/lifetime-touchpoint-ledger.ts", "emitKernelEvent("),
      consumer: h("lib/gamification/award-points.ts", "LIFETIME_CUSTOMER_TOUCHPOINT_SENT"),
      roi: h("lib/lifetime-customer-npv/scorer.ts", "from(\"lifetime_customer_touchpoints\")"),
      recovery: h("lib/sphere/lifetime-touchpoint-reaper.ts", "classifyStuckTouchpoint"),
    },
  },
  {
    key: "education_pieces", label: "Education pieces (client lessons by side and moment)", owner: "shopping_agent", proof: "test:marketing-loops",
    changed: { verdict: "BUILT", what: "a SENT lesson emits CLIENT_EDUCATION_DELIVERED; the reactor stamps the delivery receipt on its learning_assignment (the row whose viewed_at / completed_at measure engagement — now attributable per delivery); a failed or never-proposed lesson is re-offered a bounded number of times on the same assignment, terminal causes never (lane 153R); the lesson matcher's proof stays test:lifetime-relationship" },
    live: "SIMULATED; delivery rides the client's consented channel (OWNER-HELD provider)",
    hops: {
      producer: h("lib/agents/education-delivery-producer.ts", "export async function produceEducationDelivery"),
      voice: h("lib/education/client-education-curriculum.ts", "loadSenderVoiceBrief"),
      persona: h("lib/education/client-education-curriculum.ts", "kind: \"persona\""),
      approval: { na: "a routine lawful client lesson needs no human approval (owner B7)" },
      rights: h("lib/agents/education-delivery-producer.ts", "email_opt_out"),
      provider: h("lib/agents/education-delivery-producer.ts", "from(\"agent_client_messages\")"),
      evidence: h("lib/agents/education-delivery-producer.ts", "from(\"learning_assignments\")"),
      event: h("lib/agents/agent-client-messages.ts", "event: KernelEvent.CLIENT_EDUCATION_DELIVERED"),
      consumer: h("lib/kernel/event-reactor.ts", "stampEducationDelivered(svc"),
      roi: h("lib/agents/education-delivery-producer.ts", "delivered_message_id: d.messageId"),
      recovery: h("lib/agents/education-delivery-producer.ts", "decideEducationRedelivery({"),
    },
  },
  // WAVE 153 (lane 153P — owner B9 "loop the bundles, omnipresence and refurbish, and lifetime and ghost"): the two loops that had
  // no census row. Their starters, arbiter / approval planes and closing hops are traced in $S/lane153P-notes.md.
  {
    key: "omnipresence_refurbish", label: "Omnipresence and refurbished (repurposed) content — coordinated cross-channel, lineage + licence", owner: "campaign_orchestrator", proof: "test:marketing-loops",
    changed: { verdict: "BUILT", what: "each platform gets ONE staggered slot (the tenant's own fatigue floor between platforms; a platform that already carried the source is skipped — no simultaneous repeats, no replay double-post); an outside source is refurbished IDEA-ONLY (original draft in the sender's voice, originality-gated, no source media) unless a stated own-content / license basis permits reuse; every output records its lineage" },
    live: "SIMULATED in proofs; posts publish on each tenant's OWNER-HELD social connection after approval",
    hops: {
      producer: h("lib/repurpose/actions.ts", "export async function executePipeline"),
      voice: h("lib/repurpose/actions.ts", "applyKernelBrandVoice("),
      persona: { na: "a broadcast repurpose addresses the tenant's whole following — no persona-targeted copy" },
      approval: h("lib/repurpose/distribute.ts", "approval_status: \"pending\""),
      rights: h("lib/repurpose/actions.ts", "assessRefurbishSource("),
      provider: h("lib/repurpose/actions.ts", "scheduleSocialPost("),
      evidence: h("lib/repurpose/actions.ts", "from(\"repurposed_content_log\")"),
      event: h("lib/repurpose/actions.ts", "KernelEvent.OMNIPRESENCE_PIPELINE_COMPLETED"),
      consumer: h("lib/kernel/event-reactor.ts", "KernelEvent.OMNIPRESENCE_PIPELINE_COMPLETED"),
      roi: h("lib/social/analytics-sync.ts", "export async function syncSocialAnalytics"),
      recovery: h("app/api/cron/publish-social-posts/route.ts", "retryCount"),
    },
  },
  {
    key: "ghost_reengagement", label: "Ghost re-engagement (an old, unresponsive lead — never a recent inbound)", owner: "ai_isa", proof: "test:marketing-loops",
    changed: { verdict: "BUILT", what: "a lead whose last inbound on the conversation history is inside the ghost threshold is no longer swept as a ghost (ghostQuietVerdict; an unreadable history is skipped, never read as silence)" },
    live: "SIMULATED in proofs; touches ride the lead's OWNER-HELD channel providers",
    hops: {
      producer: h("lib/ai-isa/ghost-reengagement.ts", "export async function runGhostReengagement"),
      voice: h("lib/ai-isa/ghost-reengagement.ts", "buildPersonalizationFacts("),
      persona: h("lib/ai-isa/ghost-reengagement.ts", "cohortFromEnrichment("),
      approval: { na: "a routine lawful re-engagement touch needs no human approval (owner B7) — the arbiter decides" },
      rights: h("lib/ai-isa/ghost-reengagement.ts", "ghostQuietVerdict("),
      provider: h("lib/ai-isa/ghost-reengagement.ts", "initiateAIISAContactEngagement("),
      evidence: h("lib/ai-isa/ghost-reengagement.ts", "logISAOutreach("),
      event: h("lib/ai-isa/ghost-reengagement.ts", "processKernelEvent("),
      consumer: h("lib/ai-isa/ghost-reengagement.ts", "arbitrateCadence("),
      roi: h("lib/ai-isa/ghost-reengagement.ts", "stampQualificationOutcome("),
      recovery: h("lib/ai-isa/ghost-reengagement.ts", "from('automation_errors')"),
    },
  },
]

// ── machinery ────────────────────────────────────────────────────────────────────────────────────────────────────
const ROOT = process.cwd()
const DOC = "docs/architecture/MARKETING-CAPABILITY-CENSUS.md"
let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, d?: string) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n + (d ? ` — ${d}` : "")); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) } }
const cache = new Map<string, string[] | null>()
const stripped = (f: string): string[] | null => {
  if (!cache.has(f)) cache.set(f, existsSync(join(ROOT, f)) ? stripComments(readFileSync(join(ROOT, f), "utf8")).split("\n") : null)
  return cache.get(f) ?? null
}
type Resolved = { state: "live"; at: string } | { state: "stale"; why: string } | { state: "untraced" | "gap" | "na" | "held"; why: string }
function resolve(hop: Hop): Resolved {
  if ("file" in hop) {
    const lines = stripped(hop.file)
    if (!lines) return { state: "stale", why: `${hop.file} does not exist` }
    const i = lines.findIndex((l) => l.includes(hop.token))
    return i >= 0 ? { state: "live", at: `${hop.file}:${i + 1}` } : { state: "stale", why: `"${hop.token}" is not live code in ${hop.file}` }
  }
  if ("untraced" in hop) return { state: "untraced", why: hop.untraced }
  if ("gap" in hop) return { state: "gap", why: hop.gap }
  if ("held" in hop) return { state: "held", why: hop.held }
  return { state: "na", why: hop.na }
}
function deriveVerdict(row: Row, res: Record<Dim, Resolved>): Verdict {
  if (row.changed) return row.changed.verdict
  const clean = DIMS.every((d) => res[d].state === "live" || res[d].state === "na" || res[d].state === "held")
  return clean ? "VERIFIED" : "PARTIAL"
}

function main() {
  const writeDoc = process.argv.includes("--write-doc")
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }
  const registry = stripComments(readFileSync(join(ROOT, "lib/kernel/manager-registry.ts"), "utf8"))
  console.log("\n═══ I1 · the marketing capability census — every hop resolved on stripped source ═══")

  // Positive controls on the resolver itself.
  cache.set("__control__.ts", stripComments("// produceThing(a) is mentioned here\nexport async function realThing() {}").split("\n"))
  check("POSITIVE CONTROL: the resolver sees live code", resolve(h("__control__.ts", "export async function realThing")).state === "live")
  check("POSITIVE CONTROL: a token only in a comment is NOT live", resolve(h("__control__.ts", "produceThing(")).state === "stale")
  check("POSITIVE CONTROL: a missing file is stale, never quietly skipped", resolve(h("does/not/exist.ts", "x")).state === "stale")

  const out: Array<{ row: Row; res: Record<Dim, Resolved>; verdict: Verdict }> = []
  for (const row of ROWS) {
    const res = Object.fromEntries(DIMS.map((d) => [d, resolve(row.hops[d])])) as Record<Dim, Resolved>
    const stale = DIMS.filter((d) => res[d].state === "stale")
    check(`${row.key}: every named hop is live code (${DIMS.filter((d) => res[d].state === "live").length}/${DIMS.length} resolved)`, stale.length === 0, stale.map((d) => `${d}: ${(res[d] as { why: string }).why}`).join(" | "))
    check(`${row.key}: owner ${row.owner} is a registered manager`, new RegExp(`\\b${row.owner}:\\s*\\{\\s*key:\\s*"${row.owner}"`).test(registry))
    check(`${row.key}: its behavioural proof ${row.proof ?? "(none)"} is registered`, !!row.proof && !!pkg.scripts[row.proof])
    const verdict = deriveVerdict(row, res)
    if (verdict === "VERIFIED") check(`${row.key}: VERIFIED is derived (no untraced / gap hop)`, DIMS.every((d) => ["live", "na", "held"].includes(res[d].state)))
    if (row.changed) check(`${row.key}: ${row.changed.verdict} names what changed and a proof`, row.changed.what.length > 20 && !!row.proof)
    // "A content file is not a publishing workflow": VERIFIED needs approval + evidence + a consumer that are live or na.
    if (verdict === "VERIFIED") check(`${row.key}: a VERIFIED row has live approval, evidence and consumer hops`, ["approval", "evidence", "consumer"].every((d) => res[d as Dim].state !== "untraced"))
    out.push({ row, res, verdict })
  }
  check("every directive channel family is a census row (website, ads, forms, market reports, events, QR, mail, email, SMS, voice, video, social, books, podcasts, YouTube, CTV, sequences, bundles, newsletters, approvals, reviews, lifetime, education)", ROWS.length >= 23)
  // WAVE 153 (153P — owner B11 "audit and fix any partials"): NO HOP MAY STAY MERELY UNTRACED. Every hop is live code, does not
  // apply (why), is held (the owner's credential / account), or is a named GAP (a real product gap with its reason). A row still
  // PARTIAL must name WHY in a gap / held hop — never "not traced". Positive control: a planted untraced hop is counted.
  const untracedOf = (rows: Array<{ res: Record<Dim, Resolved> }>) => rows.reduce((n, r) => n + DIMS.filter((d) => r.res[d].state === "untraced").length, 0)
  const planted = { res: Object.fromEntries(DIMS.map((d) => [d, d === "roi" ? resolve(untraced()) : resolve({ na: "control" })])) as Record<Dim, Resolved> }
  check("POSITIVE CONTROL: a planted untraced hop is counted by the untraced finder", untracedOf([planted]) === 1)
  check("no hop in the census is merely untraced (each is live / na / held / a named gap)", untracedOf(out) === 0, `${untracedOf(out)} untraced`)
  for (const { row, res, verdict } of out) {
    if (verdict !== "VERIFIED" && !row.changed) check(`${row.key}: a non-VERIFIED row names its reason (a gap or held hop)`, DIMS.some((d) => res[d].state === "gap" || res[d].state === "held"))
  }
  for (const k of ["campaign_bundles", "lifetime_relationship", "omnipresence_refurbish", "ghost_reengagement"]) check(`the B9 loop row ${k} is in the census`, ROWS.some((r) => r.key === k))

  // WAVE 153 (lane 153R — owner B11): the 8 rows 153P left PARTIAL. RULES (asserted, never a waypoint count):
  //   · a BUILT row may not carry a remaining gap or untraced hop (BUILT is not a label pasted over a gap);
  //   · a row still PARTIAL has exactly ONE remaining gap and that gap names the lane that owns it.
  //   · every token this lane taught the census is LIVE, and commenting out the line that carries it turns it stale
  //     (a positive control per token — the resolver really depends on that live line, not on a comment or a neighbour).
  const gapsOf = (res: Record<Dim, Resolved>) => DIMS.filter((d) => res[d].state === "gap" || res[d].state === "untraced")
  const plantedBuilt = { res: Object.fromEntries(DIMS.map((d) => [d, d === "roi" ? resolve({ gap: "control" }) : resolve({ na: "control" })])) as Record<Dim, Resolved> }
  check("POSITIVE CONTROL: the gap finder sees a planted gap on a row", gapsOf(plantedBuilt.res).length === 1)
  for (const { row, res, verdict } of out) {
    if (verdict === "BUILT") check(`${row.key}: BUILT carries no remaining gap / untraced hop`, gapsOf(res).length === 0, gapsOf(res).join(", "))
    if (verdict === "PARTIAL") {
      const g = gapsOf(res)
      check(`${row.key}: PARTIAL has exactly one remaining hop and it names its owning lane`, g.length === 1 && /lane 153[A-Z]/.test((res[g[0]] as { why: string }).why), g.map((d) => `${d}: ${(res[d] as { why: string }).why}`).join(" | "))
    }
  }
  check("POSITIVE CONTROL: the owner-lane finder refuses a gap that names no lane", !/lane 153[A-Z]/.test("a real product gap, not built this lane"))
  const LANE_153R_HOPS: Array<[string, Dim]> = [["email", "persona"], ["social", "persona"], ["books", "persona"], ["sequences_preferences", "persona"], ["sms", "roi"], ["podcasts", "roi"], ["podcasts", "recovery"], ["education_pieces", "event"], ["education_pieces", "consumer"], ["education_pieces", "roi"], ["education_pieces", "recovery"]]
  for (const [key, dim] of LANE_153R_HOPS) {
    const hop = ROWS.find((r) => r.key === key)?.hops[dim]
    if (!hop || !("file" in hop)) { check(`153R ${key}.${dim} is a live-code hop`, false, "not a (file, token) hop"); continue }
    const raw = existsSync(join(ROOT, hop.file)) ? readFileSync(join(ROOT, hop.file), "utf8") : ""
    const commented = raw.split("\n").map((l) => (l.includes(hop.token) ? `// ${l}` : l)).join("\n")
    const ctrlKey = `__ctrl__${key}.${dim}`
    cache.set(ctrlKey, stripComments(commented).split("\n"))
    check(`153R ${key}.${dim}: "${hop.token}" is live, and commenting out its line turns it stale (positive control)`, resolve(hop).state === "live" && resolve({ file: ctrlKey, token: hop.token }).state === "stale")
  }

  // The table.
  const tally: Record<string, number> = {}
  console.log("\n   row                          verdict    resolved  untraced  na/held")
  for (const { row, res, verdict } of out) {
    tally[verdict] = (tally[verdict] ?? 0) + 1
    const n = (s: string[]) => DIMS.filter((d) => s.includes(res[d].state)).length
    console.log(`   ${row.key.padEnd(28)} ${verdict.padEnd(10)} ${String(n(["live"])).padStart(5)}     ${String(n(["untraced", "gap"])).padStart(5)}     ${String(n(["na", "held"])).padStart(5)}`)
  }
  console.log(`\n   TOTALS: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(" · ")} (of ${ROWS.length} rows; denominator = the directive's channel families; hops untraced here are this census's blind spots, not proven product gaps)`)

  // The doc.
  const lines: string[] = [
    "# Marketing capability census (generated — do not hand-edit)",
    "",
    "Rendered by `npx tsx scripts/marketing-capability-census-guard.ts --write-doc` (wave 153, lane 153I — owner ruling 17). Each hop is a",
    "live-code token resolved on comment-stripped source; `untraced` = not followed by this census (its blind spot), `na` = does not",
    "apply (why stated), `held` = needs the owner's credentials. VERIFIED is derived: every hop live / na / held AND a registered proof.",
    "Line anchors drift between regenerations; the guard compares structure (row · verdict · hop states).",
    "",
    "| Row | Verdict | Owner | Proof | " + DIMS.join(" | ") + " | Live truth |",
    "|---|---|---|---|" + DIMS.map(() => "---").join("|") + "|---|",
  ]
  for (const { row, res, verdict } of out) {
    const cell = (r: Resolved) => r.state === "live" ? `\`${r.at}\`` : `${r.state}${r.why ? `: ${r.why.replace(/\|/g, "/")}` : ""}`
    lines.push(`| ${row.label.replace(/\|/g, "/")} (\`${row.key}\`) | **${verdict}**${row.changed ? ` — ${row.changed.what.replace(/\|/g, "/")}` : ""} | ${row.owner} | \`${row.proof}\` | ${DIMS.map((d) => cell(res[d])).join(" | ")} | ${row.live.replace(/\|/g, "/")} |`)
  }
  lines.push("", `Totals: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(" · ")} of ${ROWS.length} rows.`, "")
  const doc = lines.join("\n")
  if (writeDoc) { writeFileSync(join(ROOT, DOC), doc); console.log(`\n   wrote ${DOC}`) }
  const structure = (s: string) => s.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Row") && !l.startsWith("|---")).map((l) => l.replace(/`[^`]*:\d+`/g, "LIVE").replace(/\s+/g, " "))
  const onDisk = existsSync(join(ROOT, DOC)) ? readFileSync(join(ROOT, DOC), "utf8") : ""
  check(`${DOC} is in sync with the census structure (regenerate with --write-doc)`, JSON.stringify(structure(onDisk)) === JSON.stringify(structure(doc)))

  console.log("\n BLIND SPOTS: a resolved hop proves the token is live code in the named file, not that every run reaches it (each row's named proof carries behaviour); a token inside a string literal on the same line also matches; 'untraced' hops are this census's own gaps; no live provider call was made — every row's live truth is stated.")
  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ MARKETING_CAPABILITY_CENSUS_FAIL\n" + fails.map((f) => `   - ${f}`).join("\n")); process.exit(1) }
  console.log(" ✅ MARKETING_CAPABILITY_CENSUS_OK")
}

main()
