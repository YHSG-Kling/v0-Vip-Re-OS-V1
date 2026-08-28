// lib/kernel/cron-dispatch.ts
//
// THE CRON DISPATCHER — one heartbeat, every schedule. Vercel caps cron jobs at 40 per
// project; this OS runs 100+ scheduled loops. Deployments were failing at config
// validation ("Deployment failed" before the build even started) because vercel.json
// declared every loop as its own platform cron.
//
// The fix is consolidation WITHOUT behavior change: vercel.json keeps ONE per-minute
// cron (/api/cron/dispatch); this registry is the single source of truth for every
// schedule, preserved verbatim from the old vercel.json. Each minute the dispatcher
// computes what is due and fans out internal HTTPS calls (Bearer CRON_SECRET — the
// exact header Vercel itself would send), so every target route runs unchanged.
//
// The simulator closes the drift loop in BOTH directions: every app/api/cron/…/route.ts
// must be registered here, and every registry path must resolve to a real route file —
// adding a cron route without registering it fails the regression.
//
// NOT server-only (simulator-driven); the fetcher is an injectable seam.

export interface CronEntry {
  path: string
  /** Standard 5-field cron (UTC), the subset Vercel supports: each field is
   *  "*", "*\/n", or a comma list of integers. */
  schedule: string
}

export const CRON_REGISTRY: CronEntry[] = [
  // ── Recovered dormant loops — built with cron headers but NEVER scheduled in the old
  // vercel.json (found by this registry's drift check). Documented schedules honored;
  // undocumented ones get conservative cadences. All carry their own verifyCronAuth.
  { path: "/api/cron/daily-briefing",                 schedule: "0 6 * * *" },    // documented in route header
  { path: "/api/cron/contingency-scan",               schedule: "0 13 * * *" },   // documented
  { path: "/api/cron/generate-brokerage-fee-charges", schedule: "0 6 * * *" },    // documented
  { path: "/api/cron/listing-presentation-prep",      schedule: "0 17 * * *" },   // documented
  { path: "/api/cron/listing-presentation-prep?phase=deliver", schedule: "0 19 * * *" },
  { path: "/api/cron/retry-errors",                   schedule: "*/30 * * * *" }, // documented (every 30 min)
  { path: "/api/cron/ad-performance-sync",            schedule: "0 */6 * * *" },
  { path: "/api/cron/ads-manager-sweep",              schedule: "0 12 * * *" },
  { path: "/api/cron/brokerage-intelligence-mine",    schedule: "12 4 * * *" }, // (staggered r43)
  { path: "/api/cron/brokerage-pl-rollup",            schedule: "0 3 * * *" },
  { path: "/api/cron/listing-health-scan",            schedule: "14 */6 * * *" }, // (staggered r43)
  { path: "/api/cron/marketing-attribution-engine",   schedule: "0 2 * * *" },
  { path: "/api/cron/journey-conformance-audit",       schedule: "0 3 * * *" },
  { path: "/api/cron/source-conversion-learning",      schedule: "32 4 * * 1" }, // (staggered r43)
  { path: "/api/cron/marketing-campaign-scheduler",   schedule: "*/30 * * * *" },
  { path: "/api/cron/negotiation-strategy-generator", schedule: "0 */4 * * *" },
  { path: "/api/cron/onboarding-progress-tracker",    schedule: "0 10 * * *" },
  { path: "/api/cron/recalculate-roi",                schedule: "15 1 * * *" }, // (staggered r43)
  { path: "/api/cron/review-request-on-close",        schedule: "0 16 * * *" },
  { path: "/api/cron/sync-facebook-audiences",        schedule: "0 */6 * * *" },
  // GEO / AI-search visibility loop ingress — record citation observations for
  // published reels + FAQ landing pages, then raise geo_visibility_gap signals
  // that the manager-signals cron turns into gated regenerate_faq proposals.
  { path: "/api/cron/geo-citation-monitor",           schedule: "37 8 * * *" },
  // Storage orphan sweep — retry the removes that the compensating delete in
  // lib/storage/put-and-sign.ts could not complete. Off-peak and daily: the
  // worklist only ever holds objects whose UNDO was refused, so it is short by
  // construction, and a refused remove is rarely transient enough to be worth
  // hammering hourly.
  { path: "/api/cron/storage-orphan-sweep",           schedule: "48 4 * * *" },
  // Idle-hands initiative — managers fill silence with governed work (hourly).
  { path: "/api/cron/idle-hands",                     schedule: "5 * * * *" }, // (staggered r43)
  // Client Pulse — the weekly "what your team did for you" for sellers + buyers.
  { path: "/api/cron/client-pulse",                   schedule: "22 16 * * 5" }, // (staggered r43)
  { path: "/api/cron/client-pulse?phase=deliver",     schedule: "22 18 * * 5" }, // (staggered r43)
  // Manager office hours — morning + afternoon drops sweep approval pings into one card.
  { path: "/api/cron/office-hours",                   schedule: "15 13,19 * * *" }, // (staggered r43)
  // Farm Play — the marketing bench convenes geographic farming on each closed deal.
  { path: "/api/cron/farm-play",                      schedule: "15 15 * * *" }, // (staggered r43)
  // Intent Campaign — Data Steward scrapes motivated sellers + hot buyers → multi-channel.
  { path: "/api/cron/intent-campaign",                schedule: "32 14 * * 2" }, // (staggered r43)
  // Listing Launch War Room — the bench launches each new/coming-soon listing.
  { path: "/api/cron/launch-war-room",                schedule: "8 */4 * * *" }, // (staggered r43)
  // Lookalike from the closing table — first-party seed audience (weekly).
  { path: "/api/cron/lookalike-audience",             schedule: "22 11 * * 1" }, // (staggered r43)
  // Parallel multi-manager plays (reverse prospecting, vendor orchestration, objections, referrals).
  { path: "/api/cron/reverse-prospecting",            schedule: "7 * * * *" }, // (staggered r43)
  // Investor off-market refresh — Shopping Agent keeps each investor's off-market deal list + portal card current.
  { path: "/api/cron/investor-offmarket-refresh",     schedule: "12 6 * * *" }, // (staggered r43)
  { path: "/api/cron/vendor-orchestration",           schedule: "12 14 * * *" }, // (staggered r43)
  { path: "/api/cron/objection-library",              schedule: "54 13 * * 1" }, // (staggered r43)
  { path: "/api/cron/referral-radar",                 schedule: "22 12 * * 1" }, // (staggered r43)
  { path: "/api/cron/returning-customer-reengagement", schedule: "22 13 * * *" }, // (staggered r43)
  { path: "/api/cron/manager-learning",               schedule: "12 8 * * 1" }, // (staggered r43)
  { path: "/api/cron/commission-forecaster",          schedule: "42 12 * * 1" }, // (staggered r43)
  { path: "/api/cron/quarterly-tax-concierge",        schedule: "32 13 * * *" }, // (staggered r43)
  { path: "/api/cron/manager-eval",                   schedule: "0 6 * * 1" },
  { path: "/api/cron/offer-net-sheet",                schedule: "1,16,31,46 * * * *" }, // (staggered r43)
  { path: "/api/cron/inventory-radar",                schedule: "44 */6 * * *" }, // (staggered r43)
  { path: "/api/cron/geo-reel-autopublish",           schedule: "*/30 * * * *" },
  { path: "/api/cron/bidding-war-concierge",          schedule: "15 */2 * * *" }, // (staggered r43)
  { path: "/api/cron/tour-optimizer",                 schedule: "25,55 * * * *" }, // (staggered r43)
  { path: "/api/cron/closing-watchtower",             schedule: "17 * * * *" }, // (staggered r43)
  { path: "/api/cron/anniversary-equity",             schedule: "12 13 * * *" }, // (staggered r43)
  { path: "/api/cron/equity-trigger",                 schedule: "22 14 * * 1" }, // (staggered r43)
  { path: "/api/cron/regulatory-watcher",             schedule: "22 8 * * 1" }, // (staggered r43)
  { path: "/api/cron/financing-pit-stop",             schedule: "38 */6 * * *" }, // (staggered r43)
  { path: "/api/cron/agent-coaching",                 schedule: "12 7 * * 1" }, // (staggered r43)
  // ── The original vercel.json schedules, preserved verbatim ──
  { path: "/api/cron/appointment-whisper"                 , schedule: "*/10 * * * *" },
  { path: "/api/cron/appointment-noshow"                  , schedule: "35 * * * *" }, // (staggered r43)
  { path: "/api/cron/document-compliance-audit"           , schedule: "0 * * * *" },
  { path: "/api/cron/document-autofile"                   , schedule: "3,18,33,48 * * * *" }, // (staggered r43)
  { path: "/api/cron/document-retention-scan"             , schedule: "54 6 * * 1" }, // (staggered r43)
  { path: "/api/cron/context-spine-refresh"               , schedule: "24 */4 * * *" }, // (staggered r43)
  { path: "/api/cron/marketing-image-regen"               , schedule: "*/10 * * * *" },
  { path: "/api/cron/audience-sync-runner"                , schedule: "*/15 * * * *" },
  { path: "/api/cron/buyer-reel-deliver"                  , schedule: "*/15 * * * *" },
  { path: "/api/cron/enrichment-processor"                , schedule: "11,26,41,56 * * * *" }, // (staggered r43)
  { path: "/api/cron/health-check"                        , schedule: "13,28,43,58 * * * *" }, // (staggered r43)
  { path: "/api/cron/letter-audio-renderer"               , schedule: "*/15 * * * *" },
  { path: "/api/cron/presentation-section-drip"           , schedule: "*/15 * * * *" },
  { path: "/api/cron/publish-social-posts"                , schedule: "*/15 * * * *" },
  { path: "/api/cron/social-analytics-sync"               , schedule: "45 7 * * *" }, // real platform metrics for published posts → social_media_analytics (round 30)
  { path: "/api/property-alerts/run?frequency=instant"    , schedule: "*/15 * * * *" },
  { path: "/api/cron/intro-video-email-backfill"          , schedule: "*/2 * * * *" },
  { path: "/api/cron/listing-promo-hybrid-composite"      , schedule: "*/2 * * * *" },
  { path: "/api/cron/listing-promo-social-publish"        , schedule: "*/2 * * * *" },
  { path: "/api/cron/poll-did-videos"                     , schedule: "*/2 * * * *" },
  // Speed-to-lead — micro-personalized first touch on promotion + 5-min agent-grace ISA jump-in.
  { path: "/api/cron/speed-to-lead"                       , schedule: "*/2 * * * *" },
  { path: "/api/cron/poll-did-avatars"                    , schedule: "*/3 * * * *" },
  { path: "/api/cron/fire-drill"                          , schedule: "27,57 * * * *" }, // (staggered r43)
  { path: "/api/cron/manager-signals"                     , schedule: "23,53 * * * *" }, // (staggered r43)
  { path: "/api/cron/campaign-sequence-steps"             , schedule: "*/5 * * * *" },
  // Lead action plan — touches 2..N for a pre-conversion lead, plus the settings-
  // governed release of the LEAD-recipient proposals the creative producers stage.
  // speed-to-lead only ever fires touch ONE (`first_touched_at IS NULL`), so this is
  // what makes max_touches_lead / touch_interval_days mean anything. Every 15 minutes:
  // the cadence it governs is measured in DAYS, so a tighter tick buys nothing and
  // only re-reads the same rows.
  { path: "/api/cron/lead-action-plan"                    , schedule: "*/15 * * * *" },
  // Unified queue drain — email_queue / push_notification_queue / orchestrator_tasks /
  // drip_campaigns (write-only-ledger burn-down: queues finally get a consumer).
  { path: "/api/cron/queue-drain"                         , schedule: "*/5 * * * *" },
  { path: "/api/cron/composition-render-queue"            , schedule: "*/5 * * * *" },
  { path: "/api/cron/director-reel-render"                , schedule: "*/5 * * * *" },
  { path: "/api/cron/listing-promo-render"                , schedule: "*/5 * * * *" },
  { path: "/api/cron/newsletter-video-render"             , schedule: "*/5 * * * *" },
  { path: "/api/cron/portal-stream-projector"             , schedule: "*/5 * * * *" },
  { path: "/api/cron/agent-health-check"                  , schedule: "0 * * * *" },
  { path: "/api/cron/automation-error-monitor"            , schedule: "0 * * * *" },
  { path: "/api/cron/connector-auto-applier"              , schedule: "0 * * * *" },
  { path: "/api/cron/consent-recovery"                    , schedule: "47 * * * *" }, // (staggered r43)
  { path: "/api/cron/listing-promo-catchup"                      , schedule: "0 * * * *" },
  { path: "/api/cron/open-house-reminder"                 , schedule: "0 * * * *" },
  { path: "/api/cron/predictive-listing-execute"          , schedule: "0 * * * *" },
  { path: "/api/cron/publish-newsletters"                 , schedule: "0 * * * *" },
  { path: "/api/cron/connector-health"                    , schedule: "34 */12 * * *" }, // (staggered r43)
  { path: "/api/fatigue/cron"                             , schedule: "0 */12 * * *" },
  { path: "/api/cron/approval-push"                       , schedule: "52 */2 * * *" }, // (staggered r43)
  { path: "/api/cron/calendar-sync"                       , schedule: "0 */2 * * *" },
  { path: "/api/cron/deal-health-scan"                    , schedule: "0 */4 * * *" },
  { path: "/api/cron/pattern-scan"                        , schedule: "0 */4 * * *" },
  { path: "/api/cron/closing-orchestration"               , schedule: "0 */6 * * *" },
  { path: "/api/cron/dotloop-sync"                        , schedule: "0 */6 * * *" },
  { path: "/api/cron/earnings-rollup"                     , schedule: "0 1 * * *" },
  { path: "/api/cron/partners-meeting"                    , schedule: "22 1 * * 1" }, // (staggered r43)
  { path: "/api/cron/partners-meeting?phase=deliver"      , schedule: "12 16 * * 1" }, // (staggered r43)
  { path: "/api/cron/ghost-detection"                     , schedule: "12 10 * * *" }, // (staggered r43)
  { path: "/api/cron/distribute-podcast-episodes"         , schedule: "0 10 * * 2" },
  { path: "/api/cron/referral-asks"                       , schedule: "22 10 * * 2" }, // (staggered r43)
  { path: "/api/cron/podcast-weekly-auto"                 , schedule: "0 10 * * 3" },
  { path: "/api/cron/competitor-ads-exa"                  , schedule: "0 11 * * *" },
  // Content-intel scan runs an hour BEFORE the ads scan so the Marketing
  // Studio's briefs have the organic + trending picture first (round 5-7).
  { path: "/api/cron/content-intel-scan"                  , schedule: "0 10 * * *" },
  { path: "/api/cron/stale-contact-monitor"               , schedule: "15 11 * * *" }, // (staggered r43)
  { path: "/api/cron/long-term-nurture"                   , schedule: "0 11 * * 1" },
  { path: "/api/cron/recruit-outreach"                    , schedule: "12 11 * * 1" }, // (staggered r43)
  { path: "/api/cron/vendor-review-requests"              , schedule: "42 13 * * *" }, // (staggered r43)
  { path: "/api/cron/weekly-income-digest"                , schedule: "0 13 * * 1" },
  { path: "/api/cron/voice-week-in-review"                , schedule: "30 14 * * 1" },
  { path: "/api/cron/education-delivery"                  , schedule: "0 14 * * 3" },
  { path: "/api/cron/engagement-scores"                   , schedule: "0 2 * * *" },
  { path: "/api/cron/territory-metrics"                   , schedule: "12 2 * * *" }, // (staggered r43)
  { path: "/api/cron/sphere-weekly"                       , schedule: "12 22 * * 0" }, // (staggered r43)
  { path: "/api/cron/revenue-protection-rollup"           , schedule: "15 3 * * *" }, // (staggered r43)
  { path: "/api/cron/billing-dunning"                     , schedule: "0 14 * * *" },
  // Platform Sentinel — daily fleet watch → proposed staff actions with drafted outreach.
  { path: "/api/cron/platform-sentinel"                   , schedule: "12 12 * * *" }, // (staggered r43)
  { path: "/api/cron/webhook-deliveries"                  , schedule: "*/5 * * * *" }, // tenant outbound webhooks: enqueue from lifecycle_events + drain due deliveries (round 24)
  { path: "/api/cron/affiliate-commissions"               , schedule: "0 6 28 * *" }, // monthly MRR commission accrual, idempotent per (referral, period) (round 24)
  { path: "/api/cron/stripe-drift"                        , schedule: "0 9 * * 1" }, // weekly plan-catalog vs Stripe price drift watch — notifies superadmins, never auto-fixes (round 33)
  { path: "/api/cron/ai-overage-billing"                  , schedule: "23 1 1 * *" }, // monthly, 1st 01:23 UTC — bills the CLOSED period's derived AI overage as Stripe invoice items; idempotent per (brokerage, period) via ai_overage_invoices claim (m479)
  { path: "/api/cron/platform-lead-distribution"          , schedule: "0 */2 * * *" }, // batch sweep for platform leads whose inline distribution found no subscriber — speed-to-lead once a zip gains one (round 38)
  { path: "/api/cron/platform-prospect-followup"          , schedule: "0 15 * * *" },
  { path: "/api/cron/support-sla"                         , schedule: "30 * * * *" },
  { path: "/api/cron/showing-lifecycle"                   , schedule: "15 * * * *" },
  { path: "/api/cron/open-house-followup"                 , schedule: "45 * * * *" },
  { path: "/api/cron/voice-call-analysis"                 , schedule: "20 * * * *" },
  { path: "/api/cron/overnight-digest"                    , schedule: "30 12 * * *" },
  { path: "/api/cron/board-packet"                        , schedule: "0 13 1 * *" },
  { path: "/api/cron/board-packet?phase=deliver"          , schedule: "0 13 2 * *" },
  { path: "/api/cron/qbr-invitations"                     , schedule: "42 14 1,2,3,4,5,6,7 1,4,7,10 *" }, // quarterly QBR invites, self-gates to the Q window (round 28) (staggered r43)
  { path: "/api/cron/signature-chase"                     , schedule: "0 15 * * *" },
  { path: "/api/cron/listing-propensity"                  , schedule: "0 14 * * 2" },
  { path: "/api/cron/video-plays"                         , schedule: "30 15 * * *" },
  { path: "/api/cron/photo-intelligence"                  , schedule: "15 5 * * *" },
  { path: "/api/cron/send-email-campaigns"                , schedule: "10,25,40,55 * * * *" },
  { path: "/api/cron/credential-refresh"                  , schedule: "0 7 * * *" },
  { path: "/api/cron/tenant-safety-scan"                  , schedule: "22 4 * * *" }, // (staggered r43)
  { path: "/api/cron/lead-scraping"                       , schedule: "0 5 * * *" },
  { path: "/api/cron/lifetime-npv-forecast-rollup"        , schedule: "15 5 * * *" }, // (staggered r43)
  { path: "/api/cron/market-data-refresh"                 , schedule: "0 5 * * *" },
  { path: "/api/cron/actor-health"                        , schedule: "0 6 * * *" },
  { path: "/api/cron/compliance-monitoring"               , schedule: "22 6 * * *" }, // (staggered r43)
  { path: "/api/cron/contact-enrichment"                  , schedule: "0 6 * * *" },
  { path: "/api/cron/content-intel-reddit"                , schedule: "0 6 * * *" },
  { path: "/api/cron/predictive-listing-scoring"          , schedule: "0 6 * * *" },
  { path: "/api/cron/team-heatmap-snapshot"               , schedule: "42 6 * * *" }, // (staggered r43)
  { path: "/api/deal-health/cron"                         , schedule: "0 6 * * *" },
  { path: "/api/cron/annual-home-value-reports"           , schedule: "0 7 * * *" },
  { path: "/api/cron/blog-cadence-tick"                   , schedule: "0 7 * * *" },
  { path: "/api/cron/newsletter-cadence-tick"             , schedule: "0 7 * * *" },
  { path: "/api/cron/social-cadence-tick"                 , schedule: "15 7 * * *" }, // (staggered r43)
  { path: "/api/cron/content-intel-rss"                   , schedule: "0 7 * * *" },
  { path: "/api/cron/wealth-opportunity-scan"             , schedule: "0 7 * * *" },
  { path: "/api/fatigue/calculate"                        , schedule: "0 7 * * *" },
  { path: "/api/cron/asset-manager-weekly"                , schedule: "32 7 * * 1" }, // (staggered r43)
  { path: "/api/cron/campaign-orchestrator-weekly"        , schedule: "42 7 * * 1" }, // (staggered r43)
  { path: "/api/cron/buyer-market-watch"                  , schedule: "0 8 * * *" },
  { path: "/api/cron/proactive-intelligence"              , schedule: "22 7 * * *" }, // (staggered r43)
  { path: "/api/cron/content-performance-aggregator"      , schedule: "0 8 * * *" },
  { path: "/api/cron/em-receipt-watcher"                  , schedule: "0 8 * * *" },
  { path: "/api/property-alerts/run?frequency=daily"      , schedule: "0 8 * * *" },
  { path: "/api/cron/seller-updates"                      , schedule: "0 8 * * 1" },
  { path: "/api/property-alerts/run?frequency=weekly"     , schedule: "0 8 * * 1" },
  { path: "/api/cron/prompt-calibration"                  , schedule: "12 8 * * 2" }, // (staggered r43)
  { path: "/api/cron/farm-mail-weekly"                    , schedule: "12 8 * * 4" }, // (staggered r43)
  { path: "/api/property-alerts/run?frequency=twice_daily", schedule: "0 8,17 * * *" },
  { path: "/api/cron/bundle-attribution-rollup"           , schedule: "0 9 * * *" },
  { path: "/api/cron/lifetime-customer-touchpoints"       , schedule: "0 9 * * *" },
  { path: "/api/cron/onboarding-health"                   , schedule: "0 9 * * *" },
  { path: "/api/cron/onboarding-reminders"                , schedule: "0 9 * * *" },
  { path: "/api/cron/stale-lead-monitor"                  , schedule: "15 9 * * *" }, // (staggered r43)
  { path: "/api/cron/listing-seller-update-video"         , schedule: "22 9 * * 1" }, // (staggered r43)
  { path: "/api/cron/marketing-agent-weekly"              , schedule: "12 9 * * 1" }, // (staggered r43)
  { path: "/api/cron/voice-distiller-weekly"              , schedule: "0 9 * * 5" },
  { path: "/api/cron/showing-prep"                        , schedule: "15 * * * *" },
  { path: "/api/cron/deadline-watcher"                    , schedule: "45 * * * *" }, // (staggered r43)
  // Offer expiry — the unattended door for PENDING → EXPIRED. `markOfferExpired`
  // is session-gated by design, so without this nothing ever expired an offer
  // whose `offers.response_deadline` had passed. Offset from deadline-watcher.
  { path: "/api/cron/offer-expiry"                        , schedule: "52 * * * *" },
  { path: "/api/cron/marketing-agent-weekly-measure"      , schedule: "30 22 * * 0" },
  { path: "/api/cron/refresh-market-rates"                , schedule: "30 6 * * *" },
  { path: "/api/cron/market-insights-weekly"              , schedule: "30 6 * * 1" },
  { path: "/api/cron/content-intel-exa"                   , schedule: "30 6,14 * * *" },
  { path: "/api/cron/content-intel-apify"                 , schedule: "30 7 * * *" },
  { path: "/api/cron/quarterly-home-value-reports"        , schedule: "30 7 * * *" },
  { path: "/api/cron/sphere-resonance"                    , schedule: "30 7 * * *" },
  { path: "/api/cron/weekly-ai-metrics"                   , schedule: "54 7 * * 1" }, // (staggered r43)
  { path: "/api/cron/variant-outcomes-aggregator"         , schedule: "30 8 * * *" },
  // Permit signal scan — the daily cadence socrata-market-registry.ts described in prose and
  // nobody built: recentPermits() per registered dataset per ACTIVE brokerage market, matched to
  // the tenant's own leads by address, filed into motivated_seller_signals. Off-peak and daily:
  // city portals publish overnight and the 7-day lookback absorbs their backfill.
  { path: "/api/cron/permit-signal-scan"                  , schedule: "40 5 * * *" },
  // Conversation-insights refresh — the TRIGGER for the one conversation_insights
  // writer (updateConversationMemory). Sweeps conversations whose message activity
  // is newer than their stored insight and re-extracts, so the communications-
  // intelligence dashboard, the AI-quality review count and the buyer-search
  // intent merge read live numbers instead of a table nothing ever wrote to.
  // Every 4 hours, capped at 25 AI extractions per run (cost bound in the route).
  { path: "/api/cron/conversation-insights-refresh"       , schedule: "35 */4 * * *" },
]

/** Pure: one cron field against a value. Supports "*", "*\/n", "a,b,c". */
export function cronFieldMatches(field: string, value: number): boolean {
  if (field === "*") return true
  const step = field.match(/^\*\/(\d+)$/)
  if (step) return value % Number(step[1]) === 0
  return field.split(",").some((part) => Number(part) === value)
}

/** Pure: is this schedule due at this UTC minute? (minute hour dom month dow) */
export function isDue(schedule: string, at: Date): boolean {
  const fields = schedule.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const [min, hour, dom, month, dow] = fields
  return (
    cronFieldMatches(min, at.getUTCMinutes()) &&
    cronFieldMatches(hour, at.getUTCHours()) &&
    cronFieldMatches(dom, at.getUTCDate()) &&
    cronFieldMatches(month, at.getUTCMonth() + 1) &&
    cronFieldMatches(dow, at.getUTCDay())
  )
}

/** Pure: every registered path due at this minute. */
export function duePaths(at: Date): string[] {
  return CRON_REGISTRY.filter((c) => isDue(c.schedule, at)).map((c) => c.path)
}

/** Injectable seam: how a due path gets invoked (tests inject; prod uses fetch). */
export type CronFetcher = (url: string, headers: Record<string, string>) => Promise<{ ok: boolean; status: number }>

const realFetcher: CronFetcher = async (url, headers) => {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(55_000) })
  return { ok: res.ok, status: res.status }
}

export interface DispatchResult {
  due: number
  dispatched: number
  failures: Array<{ path: string; error: string }>
}

/**
 * Fan out every due cron for this minute. Targets keep their own verifyCronAuth —
 * the dispatcher forwards the same Bearer CRON_SECRET header Vercel would send.
 */
export async function dispatchDueCrons(
  opts: { now?: Date; fetcher?: CronFetcher; baseUrl?: string } = {},
): Promise<DispatchResult> {
  const now = opts.now ?? new Date()
  const fetcher = opts.fetcher ?? realFetcher
  const base = (opts.baseUrl
    ?? process.env.CRON_DISPATCH_BASE_URL
    ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : null)
    ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null))
  if (!base) throw new Error("[cron-dispatch] no base URL (CRON_DISPATCH_BASE_URL / VERCEL_PROJECT_PRODUCTION_URL)")
  const secret = process.env.CRON_SECRET
  if (!secret) throw new Error("[cron-dispatch] CRON_SECRET not configured")

  const due = duePaths(now)
  const failures: Array<{ path: string; error: string }> = []
  const results = await Promise.allSettled(
    due.map((path) => fetcher(`${base}${path}`, { authorization: `Bearer ${secret}` })),
  )
  results.forEach((r, i) => {
    if (r.status === "rejected") failures.push({ path: due[i], error: String(r.reason?.message ?? r.reason) })
    else if (!r.value.ok) failures.push({ path: due[i], error: `HTTP ${r.value.status}` })
  })
  return { due: due.length, dispatched: due.length - failures.length, failures }
}
