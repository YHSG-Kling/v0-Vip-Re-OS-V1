// lib/kernel/cron-logging.ts
//
// CRON EXECUTION LOGGING KERNEL — Layer 0 ownership
//
// Canonical commands for cron execution logging, failure tracking, records processing,
// and audit trail visibility. All cron jobs must use these commands to ensure
// silent failures are eliminated and correlation IDs enable debugging.
//
// Rules:
//   - Every cron job MUST call createCronRunContext() at start
//   - recordCronStart() must be called immediately after context creation
//   - recordCronSuccess() or recordCronFailure() must be called on completion
//   - Logging failures MUST NOT crash the cron job
//   - Correlation IDs persist across all log entries for trace correlation
//   - Error messages are truncated to 2000 chars for DB safety
//   - Records processed are tracked for audit trail
//   - Status enum: see CRON_SNAPSHOT_STATUSES below. This line used to claim a
//     fourth word, 'partial', that nothing in this module has ever written.
//
// Migration 1053: createCronRunContext() now immediately inserts into
// cron_execution_logs with cron_name + cron_path so the health dashboard
// can identify any cron without touching individual cron files.
// recordCronStart() becomes an UPDATE (not insert) on the same row.

import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "./events"
import { processKernelEvent } from "./notification-engine"
import { v4 as uuidv4 } from "uuid"

// ─── WHY THESE UPSERTS DO NOT NAME expected_interval_hours ───────────────────
//
// The opposite-missing census reports `cron_health_snapshot.expected_interval_hours`
// (and run_count_7d / failure_count_7d) as READ-BY-CODE, WRITTEN-BY-NOBODY —
// lib/platform/ai-ops.ts:34 cronHealth() reads the first to judge staleness.
// It is a FALSE POSITIVE, and the obvious "fix" is actively destructive.
// Measured 2026-08-22 against hrvaqgvukzxfskkcrwbt:
//
//   · scripts/1053-pl-truth-engine-cron-health.sql:110 SEEDS the column
//     per-cron, and all 64 live rows carry a real value (1, 24, 8760, …).
//   · The DDL is `expected_interval_hours int NOT NULL DEFAULT 24`, and
//     run_count_7d / failure_count_7d are `int NOT NULL DEFAULT 0`.
//
// So stamping a derived cadence here would (a) overwrite curated seed values
// and (b) refuse the ENTIRE upsert with 23502 the moment the derivation came
// back null for an unregistered path — and because both upserts below are
// `.then(() => {})` fire-and-forget, that refusal would reach no one and the
// health dashboard would simply stop updating. CLAUDE.md §3: a column written
// by a seed or a DEFAULT reads as writerless without being writerless.
//
// What IS genuinely one-sided is narrower and needs its own decision:
// failure_count_7d / run_count_7d are seeded 0 and NOTHING ever increments
// them, so the ops panel's "failures in 7d" figure is permanently 0. That is a
// rolling recompute, not a stamp, and it is left named rather than guessed at.
//
// ─── THAT DECISION IS NOW TAKEN — recomputeCronSevenDayCounts, below ─────────
//
// BUILT, not deleted: two superadmin surfaces read the STORED columns and both
// were reading a permanent zero —
//
//   · app/actions/superadmin/platform-overview.ts:244 counts a cron as failing
//     when `last_status === "failure" || failure_count_7d > 0`. The second
//     disjunct could never be true, so a cron that failed six times this week
//     and succeeded on its last run counted as healthy.
//   · lib/platform/ai-ops.ts:113 hands `failure7d` to the AI-ops console for
//     every failing/stale cron, and it was always 0.
//
// A THIRD reader, app/actions/pl-truth-engine.ts:379, derives the same two
// numbers at read time from `cron_execution_logs` and IGNORES these columns.
// That is NOT a duplicate to be merged away, and it is worth saying why: the
// pl-truth-engine board is TENANT-SCOPED (`.or(brokerage_id.is.null,
// brokerage_id.eq.…)` at :306), so its run_count_7d answers "runs THIS BROKER
// may see". The stored column is platform-wide, which is the only correct
// number for the two platform-staff surfaces above. Same words, two genuinely
// different questions — so both survive, and this comment is the record that
// the difference is deliberate rather than drift.

// ─── cron_health_snapshot.last_status — THE WHOLE VOCABULARY, IN ONE PLACE ───
//
// Written HERE and nowhere else. scripts/1053-pl-truth-engine-cron-health.sql:86
// claimed four words ('success'|'failure'|'partial'|'running') and the table has
// no CHECK to hold anyone to them (verified against pg_constraint 2026-08-23:
// cron_health_snapshot has ZERO check constraints), so the claim was decoration
// and two of the four words had no writer at all. Readers branched on both.
//
//   'running' — BUILT. createCronRunContext stamps it at the start choke below.
//   'partial' — DELETED at its two read sites; recordCronSuccess/recordCronFailure
//               are binary and no product ruling asks for a middle state.
//               Tombstones: app/dashboard/superadmin/platform/page.tsx.
//
// If a third word is ever wanted, it is written here first and read second.
export const CRON_SNAPSHOT_STATUSES = ["running", "success", "failure"] as const
export type CronSnapshotStatus = (typeof CRON_SNAPSHOT_STATUSES)[number]

// ─── INPUT / OUTPUT TYPES ─────────────────────────────────────────────────────

export interface CronLoggingActorContext {
  brokerageId?: string
}

export interface KernelCronLoggingResult<T = void> {
  success: boolean
  data?: T
  error?: string
}

export interface CronRunContext {
  context_id: string
  cron_name: string
  cron_path: string
  brokerage_id?: string
  started_at: string
  params?: Record<string, any>
  /** WAVE 155 (lane 155R1): true when the door HELD this run — the route returns before any domain write. */
  held?: boolean
  /** WAVE 155 (lane 155R1): the ONE decision the door took for this run (also on the run row's metadata.decision). */
  decision?: CronRunDecision
}

// ─── THE CRON DECISION DOOR (wave 155, lane 155R1) ───────────────────────────
//
// 104 crons asked no gate: no halt, authority, spend or approval decided whether the run happened, so the
// platform god switch (lib/platform/platform-controls.ts — emergency mode / AI engine off) and the per-tenant
// staff halt (feature_access_overrides 'autonomy') stopped autonomous SENDS at dispatch but never the cron that
// drafts, renders, scrapes, spends and scores. Now every cron passes ONE door: createCronRunContext (below) for
// the routes that keep a run row, decideCronRun for the few that keep none. The door resolves the cron's manager
// (resolveCronManager) and asks the EXISTING gate (lib/managers/autonomy-gate.ts autonomyDecision) over the
// platform halt and — when the run is tenant-scoped — that tenant's halt. Nothing new decides; the halt switches
// staff already flip now reach the scheduler.
//
// TWO CLASSES, every route in ONE table (scripts/cron-decision-door-guard.ts holds the table to the route tree):
//   · autonomous — HELD under a halt (outreach, content, spend, enrichment, AI authorship, scoring that acts).
//   · obligation — RUNS under a halt and RECORDS why (consent, legal and closing deadlines, billing and provider
//     truth, security, retention, health, queue recovery). Holding one of these would itself be the harm.
// With NO halt in force the decision is "runs" for every class: same writes, same sends, same order as before;
// the only addition is the decision written into the run row's metadata.
// A halt read that fails reads as NOT halted (loadPlatformHalt / loadTenantAutonomyHalt fail open by design — a
// freeze is a deliberate switch, never a DB hiccup); the decision says which halt it saw.
export type CronRunClass = "autonomous" | "obligation"

export interface CronRunDecision {
  outcome: "runs" | "held"
  run_class: CronRunClass | "unclassified"
  manager: string
  reason: string
  platform_halt: boolean
  tenant_halt: boolean | null
  decided_at: string
  rule: "lib/kernel/cron-logging.ts decideCronRun"
}

const A = "autonomous" as const
const O = "obligation" as const
/** Every cron route (key = the segment after /api/cron/) with its class and the reason for it. */
export const CRON_RUN_CLASS: Readonly<Record<string, readonly [CronRunClass, string]>> = {
  "actor-health": [O, "health: probes scraper actors and records alive/dead"],
  "ad-performance-sync": [O, "provider truth: real ad spend and results — spend at Meta/Google must stay visible while AI is halted"],
  "ads-manager-sweep": [A, "spend: proposes and launches ad spend"],
  "affiliate-commissions": [O, "billing: monthly affiliate commission accrual on real MRR"],
  "agent-coaching": [A, "AI authorship: per-agent coaching briefs"],
  "agent-health-check": [O, "health: escalates stalled agent sessions"],
  "ai-callback-dispatch": [A, "outreach: AI places the callback call"],
  "ai-overage-billing": [O, "billing: bills the closed period's AI overage (m479)"],
  "anniversary-equity": [A, "outreach: anniversary equity reports to past clients"],
  "annual-home-value-reports": [A, "outreach: annual home-value touchpoints"],
  "appointment-noshow": [A, "outreach: no-show re-book and re-engage"],
  "appointment-whisper": [A, "AI authorship: pre-appointment voice briefings"],
  "approval-push": [A, "alerts: approval reminders and manager escalations"],
  "asset-manager-weekly": [A, "spend: spawns the Asset Manager managed agent"],
  "audience-sync-runner": [A, "spend: pushes audience members to paid ad audiences"],
  "automation-error-monitor": [O, "health: escalates automation breach state and credential rotation"],
  "bidding-war-concierge": [A, "AI authorship: competitive-offer plays"],
  "billing-dunning": [O, "billing: past-due payment recovery ladder"],
  "blog-cadence-tick": [A, "content: generates blog posts"],
  "board-packet": [A, "content: the monthly board packet document"],
  "brand-listening": [A, "spend: paid brand-mention listening"],
  "brokerage-intelligence-mine": [A, "scoring that acts: pattern insights for brokers"],
  "brokerage-pl-rollup": [O, "billing: nightly brokerage P&L and payout truth"],
  "bundle-attribution-rollup": [A, "scoring: campaign bundle attribution counts"],
  "buyer-consultation-prep": [A, "content: pre-builds buyer consultation decks"],
  "buyer-market-watch": [A, "outreach: buyer market matches and alerts"],
  "buyer-reel-deliver": [A, "outreach: proposes finished buyer reels to buyers"],
  "calendar-sync": [O, "provider truth: pulls calendar events from the connected provider"],
  "campaign-orchestrator-weekly": [A, "spend: spawns the Campaign Orchestrator managed agent"],
  "campaign-sequence-steps": [A, "outreach: executes campaign sequence steps"],
  "capability-radar": [A, "spend: external search for new capabilities"],
  "capacity-guardian": [A, "scoring that acts: workload rebalancing"],
  "carrier-registration-tick": [O, "provider truth: lands ported numbers and walks A2P/toll-free registration (carrier compliance)"],
  "client-pulse": [A, "outreach: weekly client pulse proposals"],
  "closing-orchestration": [O, "closing deadlines: pending closing actions per transaction"],
  "closing-watchtower": [O, "closing deadlines: chain-date moves on live deals"],
  "commission-forecaster": [A, "AI authorship: commission and cap forecasts"],
  "competitor-ads-exa": [A, "spend: paid competitor ad search"],
  "compliance-monitoring": [O, "legal: license / CE / ethics lapse warnings and blockers"],
  "composition-render-queue": [A, "spend: renders video compositions"],
  "connector-auto-applier": [A, "acts: auto-applies connector healing proposals"],
  "connector-health": [O, "health: connector fleet health and expiry alerts"],
  "consent-recovery": [A, "outreach: fallback-channel contact and enrichment after a consent revocation (the revocation itself is honored at write time)"],
  "contact-enrichment": [A, "enrichment: paid contact enrichment"],
  "content-intel-apify": [A, "spend: paid scraping ingest"],
  "content-intel-community": [A, "spend: community topic research"],
  "content-intel-exa": [A, "spend: paid search ingest"],
  "content-intel-reddit": [A, "content: topic bank scrape"],
  "content-intel-rss": [A, "content: news topic intake"],
  "content-intel-scan": [A, "spend: competitor content scan"],
  "content-performance-aggregator": [A, "scoring that acts: topic performance scores"],
  "context-spine-refresh": [A, "AI authorship: contact conversation summaries"],
  "contingency-scan": [O, "legal deadlines: contingency deadlines within 3 days"],
  "conversation-insights-refresh": [A, "AI authorship: conversation insights"],
  "credential-refresh": [O, "security: refreshes expiring provider credentials"],
  "daily-briefing": [A, "AI authorship: daily agent briefings"],
  "deadline-watcher": [O, "legal deadlines: calendar deadline watcher"],
  "deal-health-scan": [A, "scoring that acts: deal health scores and at-risk events"],
  "deal-killer-radar": [A, "AI authorship: deal-killer risk copy"],
  "did-agent-sync": [A, "spend: provider avatar agent sync"],
  "did-result-url-rehost-sweep": [O, "retention: re-hosts paid renders before the provider URL expires"],
  "director-reel-render": [A, "spend: renders directed videos"],
  "dispatch": [O, "the scheduler itself: every due route decides at its own door"],
  "distribute-podcast-episodes": [A, "content: syndicates podcast episodes"],
  "document-autofile": [A, "AI authorship: classifies and files uploaded documents"],
  "document-compliance-audit": [O, "legal: deal document compliance audit"],
  "document-retention-scan": [O, "retention: flags documents past their retention window"],
  "dotloop-sync": [O, "provider truth: signed transaction documents from the e-sign provider"],
  "dual-transaction-timing": [A, "AI authorship: move-up choreography between two managers"],
  "earnings-rollup": [O, "billing: commission and cap earnings truth"],
  "education-delivery": [A, "outreach: stage lessons to clients"],
  "em-receipt-watcher": [O, "legal deadlines: earnest-money receipt against the contract's due date"],
  "engagement-scores": [A, "scoring that acts: engagement scores"],
  "enrichment-processor": [A, "enrichment: lead and contact enrichment queue"],
  "equity-trigger": [A, "outreach: past-client equity triggers"],
  "esign-doc-sync": [O, "provider truth: signed envelopes from the e-sign provider"],
  "farm-mail-weekly": [A, "spend: farm mail dispatch"],
  "farm-play": [A, "outreach: geographic farming play"],
  "financing-pit-stop": [O, "closing deadlines: financing milestone and stale pre-approval watch"],
  "fire-drill": [O, "legal deadlines: uncovered contract deadlines inside 48h"],
  "generate-brokerage-fee-charges": [O, "billing: periodic brokerage fee charges (idempotent per period)"],
  "geo-citation-monitor": [A, "spend: AI-search citation monitoring"],
  "geo-reel-autopublish": [A, "content: publishes video landing pages"],
  "ghost-detection": [A, "outreach: ghosted-lead re-engagement"],
  "health-check": [O, "health: platform health checks and cron counters"],
  "identity-orphan-sweep": [O, "security: reconciles orphaned identities"],
  "idle-hands": [A, "content: proactive manager drafts"],
  "intent-campaign": [A, "spend: paid intent scraping"],
  "intro-video-email-backfill": [A, "outreach: welcome video into the portal"],
  "inventory-radar": [A, "scoring that acts: seller-intent candidates"],
  "investor-offmarket-refresh": [A, "outreach: investor off-market matches"],
  "journey-conformance-audit": [O, "legal: replays journey transitions against the constitutional contract (deterministic audit)"],
  "launch-war-room": [A, "content: listing launch plays"],
  "lead-action-plan": [A, "outreach: ISA lead action plans"],
  "lead-scraping": [A, "spend: paid lead scraping"],
  "letter-audio-renderer": [A, "spend: renders letter audio"],
  "lifetime-customer-touchpoints": [A, "outreach: lifetime customer touches"],
  "lifetime-npv-forecast-rollup": [A, "scoring: NPV and income forecasts"],
  "listing-appointment-reminders": [A, "outreach: listing appointment reminders"],
  "listing-health-scan": [A, "scoring that acts: listing health and interventions"],
  "listing-presentation-prep": [A, "content: pre-builds listing presentations"],
  "listing-promo-catchup": [A, "content: listing promo dispatch"],
  "listing-promo-hybrid-composite": [A, "spend: composites promo renders"],
  "listing-promo-render": [A, "spend: kicks off promo renders"],
  "listing-promo-social-publish": [A, "content: publishes promo video to social"],
  "listing-propensity": [A, "scoring that acts: ready-to-list briefs"],
  "listing-seller-update-video": [A, "content: seller update video hand-off"],
  "local-intel": [A, "spend: local intelligence pulls"],
  "long-term-nurture": [A, "outreach: long-term nurture touches"],
  "lookalike-audience": [A, "spend: paid lookalike indicators"],
  "manager-eval": [O, "safety: deterministic red-team eval of the AI team (no outbound) — what tells staff the halt can lift"],
  "manager-learning": [A, "acts: writes learned adjustments into tenant settings"],
  "manager-signals": [A, "acts: manager bus heartbeat"],
  "market-data-refresh": [A, "spend: market data pulls"],
  "market-insights-weekly": [A, "AI authorship: market insights"],
  "marketing-agent-weekly-measure": [A, "scoring: marketing plan outcomes"],
  "marketing-agent-weekly": [A, "spend: spawns the Marketing managed agent"],
  "marketing-attribution-engine": [A, "scoring: attribution models"],
  "marketing-campaign-scheduler": [A, "outreach: launches scheduled campaigns"],
  "marketing-image-regen": [A, "spend: regenerates images"],
  "message-needs-response": [O, "human alert: a client message is waiting — when AI is halted a person must answer"],
  "negotiation-strategy-generator": [A, "AI authorship: negotiation strategies"],
  "network-intelligence": [A, "scoring: network benchmarks"],
  "newsletter-cadence-tick": [A, "content: generates newsletters"],
  "newsletter-video-render": [A, "spend: renders newsletter videos"],
  "nothing-dropped-sweep": [A, "acts: publishes drop-risk signals to managers"],
  "notification-delivery-escalation": [O, "queue recovery: escalates failed notification deliveries"],
  "objection-library": [A, "AI authorship: objection library"],
  "offer-expiry": [O, "legal: expires offers past their own terms"],
  "offer-net-sheet": [A, "AI authorship: per-offer net sheets"],
  "office-hours": [A, "alerts: batches approval pings"],
  "onboarding-health": [A, "outreach: stalled onboarding nudges"],
  "onboarding-progress-tracker": [A, "outreach: onboarding nudges"],
  "onboarding-reminders": [A, "outreach: onboarding and mentorship reminders"],
  "open-house-followup": [A, "outreach: open-house follow-up"],
  "open-house-reminder": [A, "outreach: open-house reminder promos"],
  "overnight-digest": [A, "AI authorship: overnight digest"],
  "partners-meeting": [A, "AI authorship: partners' meeting presentation"],
  "pattern-scan": [A, "spend: AI pattern detection"],
  "permit-signal-scan": [A, "enrichment: permit signals"],
  "photo-intelligence": [A, "spend: vision analysis and hero fill"],
  "platform-lead-distribution": [A, "acts: distributes platform leads to subscribers"],
  "platform-product-autopilot": [A, "content: platform acquisition content"],
  "platform-prospect-followup": [A, "outreach: platform prospect pitches"],
  "platform-sentinel": [O, "health: daily fleet watch"],
  "podcast-weekly-auto": [A, "content: generates podcast episodes"],
  "poll-did-avatars": [O, "provider truth: completes already-paid avatar jobs the webhook missed"],
  "poll-did-videos": [O, "provider truth: completes already-paid video renders the webhook missed"],
  "portal-stream-projector": [O, "provider truth: projects recorded deal events into the client portal (no AI authorship)"],
  "predictive-listing-execute": [A, "outreach: predictive listing auto-touches"],
  "predictive-listing-scoring": [A, "scoring that acts: queues auto-send touches"],
  "presentation-section-drip": [A, "outreach: pre-listing drip"],
  "proactive-intelligence": [A, "acts: fires proactive detectors"],
  "prompt-calibration": [A, "acts: recalibrates prompts"],
  "publish-newsletters": [A, "outreach: publishes newsletters"],
  "publish-social-posts": [A, "outreach: publishes social posts"],
  "qbr-invitations": [A, "outreach: QBR invitations"],
  "quarterly-home-value-reports": [A, "outreach: quarterly home-value emails"],
  "quarterly-tax-concierge": [A, "outreach: estimated-tax reminders to agents (advisory, not the brokerage's own filing)"],
  "queue-drain": [O, "queue recovery: drains deferred queues (each send still passes dispatch's own autonomy gate)"],
  "recalculate-roi": [A, "scoring: campaign ROI"],
  "recruit-outreach": [A, "outreach: recruiting outreach"],
  "referral-asks": [A, "outreach: referral asks"],
  "referral-radar": [A, "outreach: referral radar"],
  "refresh-market-rates": [A, "data: market rate snapshots"],
  "regulatory-watcher": [A, "spend: paid regulatory search that heals law rules autonomously"],
  "retry-errors": [O, "queue recovery: retries scheduled errors"],
  "returning-customer-reengagement": [A, "outreach: returning customer re-engagement"],
  "revenue-protection-rollup": [A, "scoring: revenue protection score"],
  "reverse-prospecting": [A, "outreach: reverse prospecting"],
  "review-request-on-close": [A, "outreach: review asks"],
  "review-response-auto-publish": [A, "content: publishes review responses"],
  "seller-updates": [A, "outreach: seller updates"],
  "send-email-campaigns": [A, "outreach: sends scheduled email campaigns"],
  "showing-lifecycle": [A, "outreach: showing feedback requests and reminders"],
  "showing-prep": [A, "AI authorship: showing briefings"],
  "signature-chase": [O, "closing deadlines: stalled signature nudges to the agent and broker"],
  "social-analytics-sync": [A, "data: social engagement metrics"],
  "social-cadence-tick": [A, "content: generates social posts"],
  "source-conversion-learning": [A, "scoring: source conversion advice"],
  "speed-to-lead": [A, "outreach: speed-to-lead contact"],
  "sphere-resonance": [A, "outreach: sphere life-event touches"],
  "sphere-weekly": [A, "spend: spawns the Sphere managed agent"],
  "stale-contact-monitor": [A, "outreach: stale contact touches"],
  "stale-lead-monitor": [A, "outreach: stale lead processing"],
  "stale-listing-sphere-sweep": [A, "acts: publishes sphere hand-offs"],
  "storage-orphan-sweep": [O, "retention: removes orphaned uploaded bytes"],
  "stripe-drift": [O, "billing: plan catalog drift against the payment provider"],
  "support-sla": [O, "health: support SLA breach escalation"],
  "sync-facebook-audiences": [A, "spend: syncs paid ad audiences"],
  "task-due": [O, "deadlines: task-due notices to the owning human"],
  "task-overdue": [O, "deadlines: task-overdue notices to the owning human"],
  "team-heatmap-snapshot": [A, "scoring: team heatmap"],
  "team-optimization": [A, "acts: team optimization cycle"],
  "tenant-safety-scan": [O, "security: tenant isolation scan"],
  "territory-metrics": [A, "scoring: territory metrics"],
  "tour-optimizer": [A, "acts: tour sequencing"],
  "variant-outcomes-aggregator": [A, "scoring that acts: mail variant bandit"],
  "vendor-follow-up-cadence": [A, "outreach: vendor follow-ups"],
  "vendor-orchestration": [A, "outreach: vendor bench orchestration"],
  "vendor-review-requests": [A, "outreach: vendor review requests"],
  "video-plays": [A, "content: autonomous video plays"],
  "voice-call-analysis": [A, "spend: AI call transcript analysis"],
  "voice-distiller-weekly": [A, "spend: per-agent voice distiller"],
  "voice-week-in-review": [A, "AI authorship: spoken weekly brief"],
  "wealth-opportunity-scan": [A, "AI authorship: wealth opportunity narratives"],
  "webhook-deliveries": [O, "queue recovery: tenant outbound webhook deliveries"],
  "weekly-ai-metrics": [A, "scoring: AI feedback metrics"],
  "weekly-income-digest": [A, "outreach: weekly income digest email"],
  "wire-fraud-sentinel": [O, "security: wire-fraud detection"],
  "zoom-transcript-reconcile": [O, "provider truth: recovers transcripts the webhook missed"],
}

/** "/app/api/cron/x/route.ts" | "/api/cron/x" | "x" → "x" (the CRON_RUN_CLASS key). */
export function cronRouteKey(cronPath: string, cronName?: string): string {
  const m = /(?:^|\/)api\/cron\/([^?]+?)(?:\/route\.ts)?(?:\?.*)?$/.exec(cronPath)
  return m ? m[1] : (cronName ?? cronPath).replace(/^\/+|\/+$/g, "")
}

/**
 * THE DECISION (no write). Platform halt first, then — only for a tenant-scoped run — that tenant's halt, both
 * read through their existing loaders and judged by autonomyDecision. An autonomous run under a halt is HELD; an
 * obligation runs and its decision says why. A route missing from CRON_RUN_CLASS is held as autonomous under a
 * halt (scripts/cron-decision-door-guard.ts keeps that set empty).
 */
export async function resolveCronDecision(
  input: { cron_path: string; cron_name?: string; brokerage_id?: string | null },
  client?: ReturnType<typeof createServiceClient>,
): Promise<CronRunDecision> {
  const key = cronRouteKey(input.cron_path, input.cron_name)
  const entry = CRON_RUN_CLASS[key]
  const { resolveCronManager } = await import("@/lib/kernel/manager-registry")
  const { autonomyDecision, loadTenantAutonomyHalt } = await import("@/lib/managers/autonomy-gate")
  const { loadPlatformHalt } = await import("@/lib/platform/platform-controls")
  const manager = resolveCronManager(`/api/cron/${key}`).key
  const platformHalt = await loadPlatformHalt(client)
  const tenantHalt = input.brokerage_id ? await loadTenantAutonomyHalt(input.brokerage_id, client) : null
  const gate = autonomyDecision({ managerKey: manager, effective: null, platformHalt, tenantHalt: tenantHalt ?? undefined })
  const base = { manager, platform_halt: platformHalt.halted, tenant_halt: tenantHalt ? tenantHalt.halted : null, decided_at: new Date().toISOString(), rule: "lib/kernel/cron-logging.ts decideCronRun" as const }
  if (!gate.held) return { ...base, outcome: "runs", run_class: entry ? entry[0] : "unclassified", reason: "no halt in force" }
  if (entry?.[0] === "obligation") return { ...base, outcome: "runs", run_class: "obligation", reason: `runs under halt: ${entry[1]} (halt: ${gate.reason})` }
  return { ...base, outcome: "held", run_class: entry ? "autonomous" : "unclassified", reason: entry ? `held: ${gate.reason}` : `held: unclassified cron, held as autonomous until classed in CRON_RUN_CLASS (halt: ${gate.reason})` }
}

/**
 * THE DOOR for a cron that keeps NO run row of its own. Decides, and — only when a halt is in force (a hold, or an
 * obligation running under a halt) — records that decision as one terminal cron_execution_logs row, so the hold or
 * the exemption is evidenced. With no halt it writes nothing: exactly today's behavior.
 */
export async function decideCronRun(input: { cron_name: string; cron_path: string; brokerage_id?: string | null }): Promise<{ held: boolean; decision: CronRunDecision }> {
  const supabase = createServiceClient()
  const decision = await resolveCronDecision(input, supabase)
  if (decision.platform_halt || decision.tenant_halt) {
    const { error } = await supabase.from("cron_execution_logs").insert({
      id: uuidv4(), brokerage_id: input.brokerage_id ?? null, cron_name: input.cron_name, cron_path: input.cron_path,
      status: "completed", started_at: decision.decided_at, completed_at: decision.decided_at, duration_ms: 0, records_processed: 0,
      metadata: { decision, decision_record_only: true },
    })
    if (error) console.error("[cron-kernel] decideCronRun decision record refused:", error.message)
  }
  return { held: decision.outcome === "held", decision }
}

// The decision is carried onto the same run row by recordCronStart / recordCronProgress (both REPLACE metadata),
// in-process: the route calls them in the same invocation. Bounded so a run that never closes cannot grow it.
const carriedDecisions = new Map<string, CronRunDecision>()
function carryDecision(contextId: string, decision: CronRunDecision): void {
  carriedDecisions.set(contextId, decision)
  if (carriedDecisions.size > 500) carriedDecisions.delete(carriedDecisions.keys().next().value as string)
}
function carried(contextId: string): { decision?: CronRunDecision } {
  const d = carriedDecisions.get(contextId)
  return d ? { decision: d } : {}
}

// ─── COMMAND 1: createCronRunContext ──────────────────────────────────────────

export interface CreateCronRunContextInput {
  cron_name: string      // e.g., "daily-briefing"
  cron_path: string      // e.g., "/app/api/cron/daily-briefing/route.ts"
  brokerage_id?: string  // optional, for scoped logging
  params?: Record<string, any> // input parameters for debugging
}

export async function createCronRunContext(
  input: CreateCronRunContextInput,
): Promise<KernelCronLoggingResult<CronRunContext>> {
  try {
    const context_id = uuidv4()
    const started_at = new Date().toISOString()

    const context: CronRunContext = {
      context_id,
      cron_name: input.cron_name,
      cron_path: input.cron_path,
      brokerage_id: input.brokerage_id,
      started_at,
      params: input.params,
    }

    // Persist immediately so cron_name is stored in cron_execution_logs
    // from the very first moment. recordCronStart() then re-stamps the same
    // row 'started' (NOT 'running' — that word is the SNAPSHOT's, and the
    // ledger's CHECK is started|completed|failed|timeout, which does not admit
    // it; the previous wording here named a status this module has never
    // written to this table).
    //
    // THE TENANT WAS ACCEPTED AND THEN DROPPED. `CreateCronRunContextInput`
    // has carried `brokerage_id?` since it was written, and the returned
    // `CronRunContext` reports it back — but the row itself never received it, so
    // a caller that passed one got no effect anywhere. Two things read the column
    // and both were reading a NULL that no caller could change:
    //
    //   · `app/actions/system-health.ts:getCronExecutionLogs` filters
    //     `.eq("brokerage_id", ctx.brokerageId)` for the broker health page, and
    //     `NULL = <uuid>` is NULL — so a scoped run could never appear on the
    //     surface of the brokerage it ran for.
    //   · `recordCronSuccess` / `recordCronFailure` below read `logEntry
    //     .brokerage_id` and fall back to the literal string `"system"` when it is
    //     null, which is what every kernel event from this module has carried.
    //
    // NULL IS STILL THE RIGHT ANSWER FOR A PLATFORM-WIDE SWEEP, and that is the
    // majority of this tree's crons: a run that iterates every brokerage belongs
    // to none of them, and filing it under one would put a platform outage inside
    // a single tenant's console. Those rows are NOT lost — two surfaces read this
    // ledger with NO brokerage predicate at all (`app/actions/pl-truth-engine.ts:
    // getCronHealth` and `lib/kernel/scraping.ts:loadScrapingDiagnostics`), which
    // is what makes an untenanted platform run readable rather than invisible.
    const supabase = createServiceClient()
    // WAVE 155 (lane 155R1): THE DOOR — one decision per run, recorded on this row (see resolveCronDecision).
    const decision = await resolveCronDecision(input, supabase)
    const held = decision.outcome === "held"
    const { error: insertError } = await supabase
      .from("cron_execution_logs")
      .insert({
        id:           context_id, // correlation key (no context_id column; id is the key)
        brokerage_id: input.brokerage_id ?? null,
        cron_name:    input.cron_name,
        cron_path:    input.cron_path,
        status:       held ? "completed" : "started", // a HELD run is terminal at once: it did no work (CHECK: started|completed|failed|timeout)
        started_at,
        ...(held ? { completed_at: started_at, duration_ms: 0, records_processed: 0 } : {}),
        metadata:     { ...(input.params ? { params: input.params } : {}), decision },
      })

    if (insertError) {
      // Log but don't fail — the cron should continue even if logging breaks
      console.error("[cron-kernel] createCronRunContext insert error:", insertError.message)
    }
    // A held run stamps no 'running' snapshot (it is not running) and the route returns on `held`.
    if (held) return { success: true, data: { ...context, held: true, decision } }
    carryDecision(context_id, decision)

    // ── THE 'running' HALF, BUILT AT THE START CHOKE ─────────────────────────
    //
    // Four surfaces already branch on `last_status === "running"` (the platform
    // totals tile and its badge) and NOTHING had ever written the word, so the
    // tile was hard-wired to 0 and the badge was unreachable markup.
    //
    // `last_run_at` IS DELIBERATELY NOT TOUCHED HERE, and that is the whole
    // safety of this stamp. Every staleness reader — pl-truth-engine.ts:364,
    // platform-overview.ts:222, ai-ops.ts cronHealth() — measures age from
    // `last_run_at`. Stamping it at START would make a cron that hangs and never
    // returns look FRESHER the longer it hangs, which is the exact inversion of
    // what a health board is for. So a run that dies without reaching
    // recordCronSuccess/recordCronFailure leaves the row at 'running' over a
    // stale `last_run_at`, and all three badge sites already gate their status
    // pill on `!is_stale` — the stale pill wins, which is the honest answer.
    //
    // Fire-and-forget with a READ error, not a swallowed one (CLAUDE.md §3):
    // supabase-js RESOLVES a refusal, so an undestructured call here would make
    // "the snapshot refused my write" indistinguishable from success.
    const { error: snapshotError } = await supabase
      .from("cron_health_snapshot")
      .upsert({
        cron_name:   input.cron_name,
        cron_path:   input.cron_path,
        last_status: "running" satisfies CronSnapshotStatus,
        updated_at:  started_at,
      }, { onConflict: "cron_name" })

    if (snapshotError) {
      console.error("[cron-kernel] createCronRunContext snapshot start-stamp refused:", snapshotError.message)
    }

    return { success: true, data: { ...context, held: false, decision } }
  } catch (error) {
    console.error("[cron-kernel] createCronRunContext error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

// ─── COMMAND 2: recordCronStart ───────────────────────────────────────────────

export interface RecordCronStartInput {
  context_id: string
  input_count?: number  // optional: number of items to process
  /**
   * Optional tenant, for the FALLBACK INSERT path below only.
   *
   * That path runs when `createCronRunContext`'s row is missing, so it is
   * reconstructing a row from nothing — it already loses `cron_path` to the
   * literal "unknown". Without this, it also loses the tenant, and the
   * reconstructed row can never appear on the brokerage health page even when
   * the run was scoped. Callers that hold the context can pass
   * `context.brokerage_id` straight through; a platform-wide sweep passes
   * nothing and the row stays untenanted, which is correct for it.
   */
  brokerage_id?: string
}

export async function recordCronStart(
  input: RecordCronStartInput,
): Promise<KernelCronLoggingResult> {
  try {
    const supabase = createServiceClient()

    // Update the row created in createCronRunContext to 'running'.
    // Falls back to insert if the row doesn't exist (e.g. insert failed above).
    const { error: updateError } = await supabase
      .from("cron_execution_logs")
      .update({
        // 'started' is the only legal non-terminal status (CHECK: started|completed|failed|timeout)
        status:   "started",
        metadata: { ...carried(input.context_id), ...(input.input_count != null ? { input_count: input.input_count } : {}) }, // 155R1: keep the door's decision on the row
      })
      .eq("id", input.context_id)
      .eq("status", "started")

    if (updateError) {
      // Row may not exist if createCronRunContext insert failed — insert now
      const { error: insertError } = await supabase
        .from("cron_execution_logs")
        .insert({
          id:           input.context_id,
          brokerage_id: input.brokerage_id ?? null, // see RecordCronStartInput
          cron_path:    "unknown", // NOT NULL; original context lost on this fallback path
          status:       "started",
          started_at:   new Date().toISOString(),
          metadata:     { input_count: input.input_count },
        })
      if (insertError) {
        console.error("[cron-kernel] recordCronStart fallback insert error:", insertError.message)
        return { success: false, error: insertError.message }
      }
    }

    return { success: true }
  } catch (error) {
    console.error("[cron-kernel] recordCronStart error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

// ─── COMMAND 3: recordCronProgress ────────────────────────────────────────────

export interface RecordCronProgressInput {
  context_id: string
  records_processed?: number
  metadata_delta?: Record<string, any>
}

export async function recordCronProgress(
  input: RecordCronProgressInput,
): Promise<KernelCronLoggingResult> {
  try {
    const supabase = createServiceClient()

    const { error } = await supabase
      .from("cron_execution_logs")
      .update({
        records_processed: input.records_processed,
        metadata:          input.metadata_delta && { ...carried(input.context_id), ...input.metadata_delta }, // 155R1: keep the door's decision
      })
      .eq("id", input.context_id)
      .eq("status", "started")

    if (error) {
      console.error("[cron-kernel] recordCronProgress error:", error.message)
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (error) {
    console.error("[cron-kernel] recordCronProgress error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

// ─── COMMAND 4: recordCronSuccess ────────────────────────────────────────────

export interface RecordCronSuccessInput {
  context_id: string
  output_count?: number
  records_processed?: number
  metadata?: Record<string, any>
}

export interface RecordCronSuccessOutput {
  completed_at: string
  duration_ms: number
}

export async function recordCronSuccess(
  input: RecordCronSuccessInput,
): Promise<KernelCronLoggingResult<RecordCronSuccessOutput>> {
  try {
    carriedDecisions.delete(input.context_id) // 155R1: the run closes; its decision is already on the row
    const supabase = createServiceClient()
    const completed_at = new Date().toISOString()

    const { data: logEntry, error: readError } = await supabase
      .from("cron_execution_logs")
      .select("*")
      .eq("id", input.context_id)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (readError || !logEntry) {
      console.error("[cron-kernel] recordCronSuccess read error:", readError?.message)
      return { success: false, error: "Could not find cron log entry" }
    }

    const duration_ms = new Date(completed_at).getTime() - new Date(logEntry.started_at).getTime()

    const { error: updateError } = await supabase
      .from("cron_execution_logs")
      .update({
        status:            "completed", // CHECK: started|completed|failed|timeout
        completed_at,
        duration_ms,
        records_processed: input.records_processed ?? logEntry.records_processed,
        metadata: {
          ...logEntry.metadata,
          output_count: input.output_count,
          ...input.metadata,
        },
      })
      .eq("id", input.context_id)

    if (updateError) {
      console.error("[cron-kernel] recordCronSuccess update error:", updateError.message)
      return { success: false, error: updateError.message }
    }

    // Upsert cron_health_snapshot so health dashboard sees the latest run
    if (logEntry.cron_name) {
      await sentinelWrite(supabase, supabase
        .from("cron_health_snapshot")
        .upsert({
          cron_name:              logEntry.cron_name,
          cron_path:              logEntry.cron_path ?? null,
          last_run_at:            completed_at,
          last_status:            "success",
          last_duration_ms:       duration_ms,
          last_records_processed: input.records_processed ?? logEntry.records_processed ?? 0,
          last_error_message:     null,
          updated_at:             completed_at,
        }, { onConflict: "cron_name" }), { table: "cron_health_snapshot", flow: "cron_health_snapshot_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" }) // fire-and-forget; don't fail the cron
    }

    try {
      await processKernelEvent({
        event:      KernelEvent.CRON_COMPLETED_SUCCESS,
        brokerageId: logEntry.brokerage_id || "system",
        entityType: "cron",
        entityId:   input.context_id,
      })
    } catch { /* event failure must not crash logging */ }

    return { success: true, data: { completed_at, duration_ms } }
  } catch (error) {
    console.error("[cron-kernel] recordCronSuccess error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

// ─── COMMAND 5: recordCronFailure ────────────────────────────────────────────

export interface RecordCronFailureInput {
  context_id: string
  error: Error | string
  stage?: string
  context_snapshot?: Record<string, any>
}

export interface RecordCronFailureOutput {
  completed_at: string
  duration_ms: number
}

export async function recordCronFailure(
  input: RecordCronFailureInput,
): Promise<KernelCronLoggingResult<RecordCronFailureOutput>> {
  try {
    carriedDecisions.delete(input.context_id) // 155R1: the run closes; its decision is already on the row
    const supabase = createServiceClient()
    const completed_at = new Date().toISOString()

    const { data: logEntry, error: readError } = await supabase
      .from("cron_execution_logs")
      .select("*")
      .eq("id", input.context_id)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (readError || !logEntry) {
      console.error("[cron-kernel] recordCronFailure read error:", readError?.message)
      return { success: false, error: "Could not find cron log entry" }
    }

    const duration_ms   = new Date(completed_at).getTime() - new Date(logEntry.started_at).getTime()
    const errorMessage  = input.error instanceof Error ? input.error.message : String(input.error)
    const truncatedError = errorMessage.slice(0, 2000)
    const stack = input.error instanceof Error ? input.error.stack : undefined

    const { error: updateError } = await supabase
      .from("cron_execution_logs")
      .update({
        status:        "failed", // CHECK: started|completed|failed|timeout
        completed_at,
        duration_ms,
        error_message: truncatedError,
        metadata: {
          ...logEntry.metadata,
          stage:            input.stage,
          context_snapshot: input.context_snapshot,
          error_stack:      stack?.slice(0, 1000),
        },
      })
      .eq("id", input.context_id)

    if (updateError) {
      console.error("[cron-kernel] recordCronFailure update error:", updateError.message)
      return { success: false, error: updateError.message }
    }

    // Upsert cron_health_snapshot with failure state
    if (logEntry.cron_name) {
      await sentinelWrite(supabase, supabase
        .from("cron_health_snapshot")
        .upsert({
          cron_name:              logEntry.cron_name,
          cron_path:              logEntry.cron_path ?? null,
          last_run_at:            completed_at,
          last_status:            "failure",
          last_duration_ms:       duration_ms,
          last_records_processed: logEntry.records_processed ?? 0,
          last_error_message:     truncatedError,
          updated_at:             completed_at,
        }, { onConflict: "cron_name" }), { table: "cron_health_snapshot", flow: "cron_health_snapshot_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })
    }

    try {
      await processKernelEvent({
        event:       KernelEvent.CRON_FAILED,
        brokerageId: logEntry.brokerage_id || "system",
        entityType:  "cron",
        entityId:    input.context_id,
      })
    } catch { /* event failure must not crash logging */ }

    return { success: true, data: { completed_at, duration_ms } }
  } catch (error) {
    console.error("[cron-kernel] recordCronFailure error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

// ─── COMMAND 6: recomputeCronSevenDayCounts ──────────────────────────────────
//
// THE ROLLING RECOMPUTE THE HEADER NOTE LEFT NAMED. `run_count_7d` and
// `failure_count_7d` are `int NOT NULL DEFAULT 0`, seeded 0 by
// scripts/1053-pl-truth-engine-cron-health.sql:110, and until this function no
// code path had ever moved either one. Two platform-staff surfaces read them
// (platform-overview.ts:232 / ai-ops.ts:113); both showed a permanent zero.
//
// WHY A RECOMPUTE AND NOT AN INCREMENT. A 7-day window has to DECAY. An
// increment in recordCronSuccess/recordCronFailure would only ever climb, so a
// cron that failed on Monday would still read "1 failure in 7d" in October. The
// counts are therefore derived from the ledger and OVERWRITTEN, never added to.
//
// WHY EXACT COUNTS AND NOT A PAGED SCAN. `cron_execution_logs` receives one row
// per run per cron and vercel.json runs the dispatcher every minute, so a 7-day
// window is tens of thousands of rows — well past PostgREST's default page. A
// paged scan that silently stopped at the first page would write an UNDERCOUNT
// and the surface would present it as truth, which is the same class of defect
// this function exists to close. `head: true, count: "exact"` is bounded by the
// number of crons instead of the number of runs and cannot truncate.
//
// TWO VOCABULARIES, AND THE LEDGER'S IS THE ONE USED HERE.
// `cron_execution_logs.status` CHECK = started|completed|failed|timeout
// (verified against pg_constraint 2026-08-23). `cron_health_snapshot
// .last_status` = running|success|failure. Counting the SNAPSHOT's word against
// the LEDGER's column is precisely the bug pl-truth-engine.ts:326 documents
// having already paid for once, so LEDGER_FAILURE_STATUSES is the ledger's
// spelling and a timeout counts as a failure: the run did not complete.
export const LEDGER_FAILURE_STATUSES = ["failed", "timeout"] as const

export interface RecomputeCronSevenDayCountsOutput {
  cronsExamined: number
  rowsUpdated:   number
}

export async function recomputeCronSevenDayCounts(
  now: Date = new Date(),
): Promise<KernelCronLoggingResult<RecomputeCronSevenDayCountsOutput>> {
  try {
    const supabase = createServiceClient()
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()

    // PLATFORM-WIDE ON PURPOSE — no brokerage predicate. Both readers of these
    // columns are platform-staff-gated; the tenant-scoped answer to the same
    // question is pl-truth-engine.ts:379 and stays there.
    const { data: snapshots, error: snapshotError } = await supabase
      .from("cron_health_snapshot")
      .select("cron_name, run_count_7d, failure_count_7d")

    if (snapshotError) return { success: false, error: snapshotError.message }
    const rows = snapshots ?? []

    let rowsUpdated = 0

    // Batched so a 64-row snapshot does not open 128 simultaneous sockets.
    const BATCH = 8
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH)
      const results = await Promise.all(batch.map(async (row: any) => {
        const name = row.cron_name as string

        const runQ = supabase
          .from("cron_execution_logs")
          .select("id", { count: "exact", head: true })
          .eq("cron_name", name)
          .gte("started_at", since)

        const failQ = supabase
          .from("cron_execution_logs")
          .select("id", { count: "exact", head: true })
          .eq("cron_name", name)
          .gte("started_at", since)
          .in("status", [...LEDGER_FAILURE_STATUSES])

        const [runR, failR] = await Promise.all([runQ, failQ])

        // A REFUSED COUNT IS NOT A ZERO. Writing 0 over a refusal would render
        // "the ledger would not answer" as "this cron is clean", which is the
        // failure mode CLAUDE.md §2 names: a guard that cannot see reports zero
        // and reads as a clean bill of health. Skip the row and keep the last
        // known-good number instead.
        if (runR.error || failR.error) {
          console.error(
            `[cron-kernel] recomputeCronSevenDayCounts refused for ${name}:`,
            runR.error?.message ?? failR.error?.message,
          )
          return false
        }

        const run7d  = runR.count ?? 0
        const fail7d = failR.count ?? 0
        if (run7d === row.run_count_7d && fail7d === row.failure_count_7d) return false

        const { error: writeError } = await supabase
          .from("cron_health_snapshot")
          .update({ run_count_7d: run7d, failure_count_7d: fail7d, updated_at: now.toISOString() })
          .eq("cron_name", name)

        if (writeError) {
          console.error(`[cron-kernel] recomputeCronSevenDayCounts write refused for ${name}:`, writeError.message)
          return false
        }
        return true
      }))
      rowsUpdated += results.filter(Boolean).length
    }

    return { success: true, data: { cronsExamined: rows.length, rowsUpdated } }
  } catch (error) {
    console.error("[cron-kernel] recomputeCronSevenDayCounts error:", error)
    return { success: false, error: error instanceof Error ? error.message : "Unknown error" }
  }
}
