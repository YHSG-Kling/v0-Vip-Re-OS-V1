// lib/kernel/signal-routing.ts
//
// THE REGISTRY-DERIVED ROUTER — owner ruling (wave 51, 2026-09-10, verbatim): "all kernel
// signals need to understand the signal and determine which managers from the registry"
// and "a signal never routes from a manager to itself." Every reader in
// lib/kernel/event-reactor.ts (blocks D-octies through D-terdecies) picks a FROM (the
// manager whose domain owns the moment) and a TO (the manager whose domain — MANAGERS[key]
// .domain, lib/kernel/manager-registry.ts — covers the next action) for each
// KernelEvent it turns into a manager_signals row. This module is the single place that
// answers "who owns this moment, who acts next" as a PURE function of the event + a small
// context object the reader resolves (kind/listing/contact/etc.) — so a reader calls
// `routeForEvent` instead of hardcoding a `fromManager`/`toManager` literal pair.
//
// `validSignalRoute` is NOT reimplemented here — lib/kernel/manager-signals.ts:58 already
// owns it (publishManagerSignal calls it before every insert) and this module imports it,
// one vocabulary (CLAUDE.md §6) for "is this a legal manager-to-manager route".
//
// STATIC_ROUTES below is the FROM/TO table for every event-family publish in
// event-reactor.ts that does NOT branch on runtime context (verified against the live
// source by scripts/manager-routing-simulator.ts, which fails if a call site's literal
// fromManager/toManager pair disagrees with this table). Events that branch per use case
// (contact type, asset kind, card classification, …) keep their branch INLINE in
// event-reactor.ts — the branch is the routing table for that event, made of explicit,
// auditable `if`s rather than a hidden default — and are named on BRANCHING_EVENTS below so
// the simulator's coverage sweep does not expect a single static pair for them.
//
// video_generation_requested / video_generation_completed are the ctx-driven exception this
// module exists to fix: wave 51 found both stamped FROM data_steward — wrong; the video/
// asset lane publishes FROM Asset Manager (the asset owner), and the TO depends on WHAT the
// render is for. routeVideoGenerationRequested/routeVideoGenerationCompleted below compute
// that from a small ctx object the reader builds from the ai_video_projects row (never a
// second, hand-rolled kind classifier — resolveVideoKind, lib/kernel/video-coordination.ts,
// is reused for the "kind" field, same as the completed-video coordinator already does).

import type { ManagerKey } from "./manager-registry"
import { validSignalRoute as validSignalRouteImpl } from "./manager-signals"

/** Re-exported so callers need only import from this module — one vocabulary (§6). */
export const validSignalRoute = validSignalRouteImpl

export interface SignalRoute {
  from: ManagerKey
  /**
   * null = no manager_signals publish for this case. Two distinct reasons collapse to the
   * same "don't publish" outcome, each named in `reason`:
   *   · the moment stays on the FROM manager's own feed to the individual who asked for it
   *     (never a from===to self-route — CLAUDE.md wave 51) — e.g. an agent's own generic
   *     video project, which the agent already sees on their own dashboard;
   *   · a DEDICATED multi-target coordinator owns the real branching and is called
   *     directly instead of this bus (e.g. publishVideoCoordinationSignals) — the reader
   *     must call that coordinator itself rather than publish a flattened single-TO stand-in.
   */
  to: ManagerKey | null
  /** Why this FROM/TO (or this "don't publish") — audit trail for the allow-list report. */
  reason: string
}

/**
 * Context the video family's routers read. Built by the READER from the ai_video_projects
 * row (id, listing_id, contact_id, video_type, video_metadata) — never trusted from
 * emitter-supplied metadata alone, since two of the five REQUESTED emitters (app/actions/
 * video/create-video-project.ts, app/api/did/generate-video/route.ts) call
 * processKernelEvent directly with no metadata at all. `kind` is resolveVideoKind's result
 * (video_metadata.promo_event_type ?? video_type) — reused, not a second classifier.
 */
export interface VideoRouteCtx {
  listingId?: string | null
  contactId?: string | null
  kind?: string | null
}

/**
 * VIDEO_GENERATION_REQUESTED — a render just started. FROM Asset Manager always (CLAUDE.md
 * wave 51, quoting the owner verbatim: "video snippet should be asset manager from" —
 * "video/asset-lane moments … are published FROM asset_manager, the asset owner"). TO
 * branches on what the render is FOR, per the owner's wave-51 examples:
 *   · tied to a listing (listing promo, listing tour, …) → Listing Concierge, who owns the
 *     listing and should know a render is in flight for it.
 *   · tied to a contact (a persona/welcome/situational reel) → Campaign Orchestrator, who
 *     will be the one to DELIVER it once VIDEO_GENERATION_COMPLETED fires (same manager the
 *     completed-side coordinator already hands finished contact reels to — contact_
 *     outreach_ready in lib/kernel/video-coordination.ts).
 *   · a recruiting/talent-pipeline video → Recruiting Manager (no emitter mints this kind
 *     today; the branch exists so a future recruiting-video capability routes correctly
 *     from day one rather than falling through to the generic case).
 *   · a brand/product promo with neither a listing nor a contact → Campaign Orchestrator,
 *     who owns brand/content promotion (lib/kernel/manager-registry.ts:90).
 *   · anything else (an agent's own project — a script rehearsal, a personal explainer, a
 *     presentation chapter with no listing/contact tie) → no cross-manager signal at all;
 *     the requesting agent already sees their own project on their own board. Publishing a
 *     from===to "asset_manager feed" entry here is exactly the wave-51-forbidden shape.
 */
export function routeVideoGenerationRequested(ctx: VideoRouteCtx): SignalRoute {
  const from: ManagerKey = "asset_manager"
  if (ctx.listingId) {
    return {
      from, to: "listing_concierge",
      reason: "listing-tied render (promo/tour/etc.) — Listing Concierge owns the listing this video is for",
    }
  }
  if (ctx.contactId) {
    return {
      from, to: "campaign_orchestrator",
      reason: "contact-tied render (persona/welcome/situational reel) — Campaign Orchestrator will deliver it on completion",
    }
  }
  const kind = (ctx.kind ?? "").toLowerCase()
  if (kind.includes("recruit")) {
    return { from, to: "recruiting_manager", reason: "recruiting/talent-pipeline video — Recruiting Manager's domain" }
  }
  if (kind.includes("product") || kind.includes("brand")) {
    return { from, to: "campaign_orchestrator", reason: "brand/product promo video with no listing/contact tie — Campaign Orchestrator owns brand promotion" }
  }
  return {
    from, to: null,
    reason: "agent's own project (no listing/contact/recruiting tie) — stays on the requesting agent's own surface via Asset Manager's feed, never a cross-manager signal",
  }
}

/**
 * VIDEO_GENERATION_COMPLETED — a render finished. This is NOT a flat single-TO pair: a
 * finished render's real distribution decision is kind-aware (organic vs. promotable,
 * broadcast vs. a personal 1:1 reel for a specific lead/contact) and that branching ALREADY
 * lives, fully built, in lib/kernel/video-coordination.ts's publishVideoCoordinationSignals
 * — campaign_orchestrator always (propose the coordinated rollout), + ads_manager for
 * PROMOTABLE_VIDEO_KINDS (paid promotion), OR a gated 1:1 lead_outreach_ready/
 * contact_outreach_ready email when the reel was commissioned for one person, OR
 * video_compliance_failed when the render failed. That satisfies the owner's own "e.g.
 * campaign_orchestrator proposes distribution on completion through the existing gated
 * path" example verbatim. Re-deriving a second, flatter routing table here would be a
 * second spelling of the same decision (CLAUDE.md §6) — this returns `to: null` so the
 * READER calls the coordinator directly instead of publishing a stand-in signal.
 */
export function routeVideoGenerationCompleted(): SignalRoute {
  return {
    from: "asset_manager",
    to: null,
    reason: "delegates to publishVideoCoordinationSignals (lib/kernel/video-coordination.ts) — kind-aware, multi-target (campaign_orchestrator always, ads_manager for promotable kinds, or a gated 1:1 lead/contact outreach-ready signal, or a compliance-failed escalation), never a flat single TO",
  }
}

/**
 * Static (event value -> route) table for every NON-branching event-family publish in
 * event-reactor.ts. Verified against the live source by scripts/manager-routing-
 * simulator.ts's STATIC_ROUTES coverage sweep — a call site whose literal fromManager/
 * toManager disagrees with its entry here fails that proof. Video events are handled by
 * the dedicated functions above, not this table (their TO is context-dependent).
 */
export const STATIC_ROUTES: Record<string, { from: ManagerKey; to: ManagerKey }> = {
  deal_health_score_updated:         { from: "data_steward", to: "deal_coordinator" },
  deal_at_risk_detected:             { from: "data_steward", to: "deal_coordinator" },
  listing_health_score_updated:      { from: "data_steward", to: "listing_concierge" },
  listing_at_risk_detected:          { from: "data_steward", to: "listing_concierge" },
  lead_sla_breached:                 { from: "data_steward", to: "ai_isa" },
  buyer_fatigue_detected:            { from: "data_steward", to: "shopping_agent" },
  video_high_performer_detected:     { from: "asset_manager", to: "campaign_orchestrator" },
  video_low_performer_detected:      { from: "asset_manager", to: "campaign_orchestrator" },
  campaign_roi_updated:              { from: "finance_manager", to: "campaign_orchestrator" },
  subscription_cancelled:            { from: "finance_manager", to: "data_steward" },
  social_post_failed:                { from: "cron_manager", to: "campaign_orchestrator" },
  agent_license_failed:              { from: "recruiting_manager", to: "compliance_officer" },
  appointment_no_show:               { from: "data_steward", to: "ai_isa" },
  listing_stage_transition_failed:   { from: "listing_concierge", to: "compliance_officer" },
  sequence_paused_on_reply:          { from: "campaign_orchestrator", to: "ai_isa" },
  message_needs_response:            { from: "data_steward", to: "ai_isa" },
  onboarding_completed:              { from: "recruiting_manager", to: "campaign_orchestrator" },
  task_due:                          { from: "data_steward", to: "deal_coordinator" },
  commission_paid:                   { from: "finance_manager", to: "deal_coordinator" },
  review_received:                   { from: "data_steward", to: "sphere_of_influence" },
  website_visitor_identified:        { from: "data_steward", to: "campaign_orchestrator" },
  task_completed:                    { from: "deal_coordinator", to: "finance_manager" },
  listing_archived:                  { from: "listing_concierge", to: "data_steward" },
  listing_unarchived:                { from: "listing_concierge", to: "data_steward" },
  lead_scored:                       { from: "data_steward", to: "ai_isa" },
  contact_scored:                    { from: "data_steward", to: "sphere_of_influence" },
  lead_assignment_failed:            { from: "data_steward", to: "ai_isa" },
  lead_import_completed:             { from: "data_steward", to: "ai_isa" },
  contact_dedup_merged:              { from: "data_steward", to: "sphere_of_influence" },
  newsletter_sent:                   { from: "cron_manager", to: "campaign_orchestrator" },
  subscription_created:              { from: "finance_manager", to: "data_steward" },
  negotiation_strategy_drafted:      { from: "deal_coordinator", to: "compliance_officer" },
  cron_failed:                       { from: "cron_manager", to: "data_steward" },
  deal_health_changed:               { from: "data_steward", to: "deal_coordinator" },
  consent_received:                  { from: "ai_isa", to: "compliance_officer" },
  buyer_under_contract:              { from: "shopping_agent", to: "deal_coordinator" },
  earnest_money_milestone_completed: { from: "finance_manager", to: "deal_coordinator" },
  agent_license_submitted:           { from: "recruiting_manager", to: "compliance_officer" },
  cma_generated:                     { from: "listing_concierge", to: "campaign_orchestrator" },
  referral_received:                 { from: "data_steward", to: "sphere_of_influence" },
  lead_assigned:                     { from: "data_steward", to: "ai_isa" },
  vendor_assigned_to_transaction:    { from: "data_steward", to: "deal_coordinator" },
  home_value_seller_intent:          { from: "ai_isa", to: "listing_concierge" },
  lead_ready_for_assignment:         { from: "data_steward", to: "ai_isa" },
  inspection_completed:              { from: "deal_coordinator", to: "finance_manager" },
  agent_license_verified:            { from: "recruiting_manager", to: "compliance_officer" },
  stale_lead_alert:                  { from: "data_steward", to: "ai_isa" },
  price_alert_triggered:             { from: "listing_concierge", to: "campaign_orchestrator" },
  listing_agreement_initiated:       { from: "listing_concierge", to: "compliance_officer" },
  showing_requested:                 { from: "listing_concierge", to: "ai_isa" },
  esign_envelope_requested:          { from: "compliance_officer", to: "deal_coordinator" },
  marketing_campaign_ended:          { from: "ai_isa", to: "campaign_orchestrator" },
  system_sync_completed:             { from: "data_steward", to: "finance_manager" },
  agent_escalated_to_human:          { from: "ai_isa", to: "recruiting_manager" },
  neighborhood_report_generated:     { from: "listing_concierge", to: "campaign_orchestrator" },
  script_generated:                  { from: "asset_manager", to: "campaign_orchestrator" },
  voice_clone_ready:                 { from: "asset_manager", to: "campaign_orchestrator" },
  snippet_created:                   { from: "asset_manager", to: "campaign_orchestrator" },
  content_repurposed:                { from: "asset_manager", to: "campaign_orchestrator" },
  omnipresence_pipeline_completed:   { from: "asset_manager", to: "campaign_orchestrator" },
  podcast_episode_generated:         { from: "asset_manager", to: "campaign_orchestrator" },
  podcast_episode_failed:            { from: "asset_manager", to: "campaign_orchestrator" },
  training_course_completed:         { from: "recruiting_manager", to: "compliance_officer" },
  script_variation_created:          { from: "asset_manager", to: "campaign_orchestrator" },
  voice_clone_profile_created:       { from: "asset_manager", to: "campaign_orchestrator" },
  voice_clone_training_started:      { from: "asset_manager", to: "campaign_orchestrator" },
  voice_clone_default_set:           { from: "asset_manager", to: "campaign_orchestrator" },
  snippet_scheduled:                 { from: "asset_manager", to: "campaign_orchestrator" },
  repurpose_batch_completed:         { from: "asset_manager", to: "campaign_orchestrator" },
  video_performance_updated:         { from: "asset_manager", to: "campaign_orchestrator" },
  podcast_episode_distributed:       { from: "asset_manager", to: "campaign_orchestrator" },
  newsletter_scheduled:              { from: "cron_manager", to: "campaign_orchestrator" },
  daily_briefing_generated:          { from: "cron_manager", to: "data_steward" },
  setup_assistant_escalated:         { from: "recruiting_manager", to: "data_steward" },
  onboarding_stalled:                { from: "data_steward", to: "recruiting_manager" },
  open_house_marketing_started:      { from: "listing_concierge", to: "campaign_orchestrator" },
  open_house_contact_resolved:       { from: "listing_concierge", to: "ai_isa" },
  authority_blocked:                 { from: "compliance_officer", to: "campaign_orchestrator" },
  contact_enrichment_failed:         { from: "data_steward", to: "ai_isa" },
  business_card_uploaded:            { from: "data_steward", to: "sphere_of_influence" },
  open_house_attendee_captured:      { from: "listing_concierge", to: "ai_isa" },
  contact_enrichment_queued:         { from: "data_steward", to: "ai_isa" },
  isa_qualification_started:         { from: "ai_isa", to: "data_steward" },
  isa_outreach_sent:                 { from: "ai_isa", to: "data_steward" },
  isa_reply_received:                { from: "ai_isa", to: "data_steward" },
  isa_max_touches_reached:           { from: "ai_isa", to: "data_steward" },
  qr_scan_received:                  { from: "campaign_orchestrator", to: "data_steward" },
  marketing_campaign_created:        { from: "campaign_orchestrator", to: "data_steward" },
  marketing_campaign_launched:       { from: "campaign_orchestrator", to: "data_steward" },
}

/**
 * Event families whose reader branches per use case at runtime (contact type, card
 * classification, buyer/seller side, …) instead of a single static pair — the branch
 * itself, in event-reactor.ts, IS the routing table for these, kept inline so every
 * candidate destination stays visible next to the DB lookup that picks one. Named here so
 * the simulator's coverage sweep expects a branch, not a STATIC_ROUTES entry, and can still
 * assert every branch destination is a real MANAGERS key and never equals the branch's FROM.
 */
export const BRANCHING_EVENTS: Record<string, { from: ManagerKey; candidates: ManagerKey[]; reason: string }> = {
  isa_appointment_scheduled: { from: "ai_isa", candidates: ["shopping_agent", "listing_concierge"], reason: "branches on the contact's contact_type" },
  ai_isa_handoff_to_agent:   { from: "ai_isa", candidates: ["listing_concierge", "shopping_agent", "data_steward"], reason: "branches on the contact's contact_type; unresolved routes to data_steward (the field gap is its stewardship domain) rather than guessing or self-routing to ai_isa" },
  isa_outreach_paused:       { from: "ai_isa", candidates: ["listing_concierge", "shopping_agent"], reason: "branches on the contact's contact_type; unresolved/lead-side publishes nothing" },
  form_submission_received:  { from: "campaign_orchestrator", candidates: ["listing_concierge", "shopping_agent"], reason: "owner ruling (wave 51): a submitted form goes through the ONE welcome path (deliverConversionWelcome); the visibility trail goes from the form's owner to whichever welcome manager resolveWelcomeManagers picked for the contact's contact_type (seller/buyer); an untyped contact publishes nothing" },
  isa_qualified_lead:        { from: "ai_isa", candidates: ["listing_concierge", "shopping_agent", "data_steward"], reason: "branches on motivationToContactType(leads.motivation_type ?? lead_type)" },
  business_card_approved:    { from: "data_steward", candidates: ["sphere_of_influence", "ai_isa", "recruiting_manager", "asset_manager"], reason: "branches on metadata.card_subject_type" },
  video_generation_requested:{ from: "asset_manager", candidates: ["listing_concierge", "campaign_orchestrator", "recruiting_manager"], reason: "branches on the ai_video_projects row — see routeVideoGenerationRequested" },
}

/**
 * THE DISPATCHER a reader calls instead of hardcoding a fromManager/toManager literal pair.
 * `ctx` carries whatever runtime discriminators the event needs (only the video family
 * needs one today — every other event family is either a STATIC_ROUTES pair or an inline
 * BRANCHING_EVENTS decision the reader still makes itself, since a DB-lookup branch belongs
 * next to the query that resolves it, not hidden behind a generic ctx blob). Returns null
 * for an event this module does not (yet) cover — the caller's own allow-list entry, not a
 * silent guess, is the fallback for those.
 */
export function routeForEvent(event: string, ctx?: VideoRouteCtx): SignalRoute | null {
  if (event === "video_generation_requested") return routeVideoGenerationRequested(ctx ?? {})
  if (event === "video_generation_completed") return routeVideoGenerationCompleted()
  const stat = STATIC_ROUTES[event]
  if (stat) return { from: stat.from, to: stat.to, reason: "STATIC_ROUTES table entry" }
  return null
}
