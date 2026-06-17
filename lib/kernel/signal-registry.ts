// lib/kernel/signal-registry.ts
//
// THE SIGNAL REGISTRY — the declared catalog of every inter-manager signal_type on the bus, exactly
// as manager-registry catalogs every egress burn-domain. The Command Center's whole differentiator is
// that managers COORDINATE; this makes that coordination GOVERNED: every signal a manager publishes is
// declared here with its disposition (does a manager CONSUME it, or is it surfaced for a HUMAN on the
// feed?) and the coordination KIND the feed renders it as. test:signal-integrity then proves zero
// orphans — every published signal_type is catalogued, every "handled" type has a real handler, every
// handler is catalogued, and the declared kind matches the live classifier. Pure data (no I/O).

import type { CoordinationKind } from "./coordination-kind"

export type SignalDisposition = "handled" | "feed_only"

export interface SignalSpec {
  /** the manager(s) whose inbox CONSUMES this signal via SIGNAL_HANDLERS (empty = feed-only). */
  consumers: string[]
  /** "handled" = an automated consumer acts on it; "feed_only" = surfaced for a human on the feed. */
  disposition: SignalDisposition
  /** the coordination kind the feed should render it as (must match classifyCoordination). */
  kind: CoordinationKind
  /** one-line purpose, for the catalog. */
  what: string
}

/**
 * Every inter-manager signal_type, declared. Add a row here when you publish a new signal_type —
 * test:signal-integrity fails on any published type that isn't catalogued (the orphan guard).
 */
export const SIGNAL_REGISTRY: Record<string, SignalSpec> = {
  // ── Handled — an automated manager inbox consumes and acts (gated) ──
  isa_call_appointment:    { consumers: ["shopping_agent", "listing_concierge"], disposition: "handled", kind: "handoff",    what: "AI ISA booked an appointment on a dial-batch call — concierge proposes the prep follow-up" },
  deal_closed:             { consumers: ["sphere_of_influence"],                 disposition: "handled", kind: "update",     what: "a deal closed — the client crosses into lifetime territory; Sphere proposes the welcome" },
  price_reduced:           { consumers: ["shopping_agent"],                      disposition: "handled", kind: "update",     what: "price drop on an in-house listing — Shopping Agent re-matches buyers who saved it" },
  seller_intent_hot:       { consumers: ["ai_isa", "listing_concierge"],         disposition: "handled", kind: "update",     what: "a seller's intent went hot — routed for an ISA call + listing concierge prep" },
  content_winner:          { consumers: ["ads_manager"],                         disposition: "handled", kind: "update",     what: "a winning organic post — Ads Manager proposes promoting it (gated paid spend)" },
  video_ready:             { consumers: ["campaign_orchestrator", "ads_manager"],disposition: "handled", kind: "handoff",    what: "a Director video finished — distribute (orchestrator) + promote promotable kinds (ads)" },
  video_compliance_failed: { consumers: ["campaign_orchestrator"],              disposition: "handled", kind: "alert",      what: "a video failed compliance — escalate to the approval queue, never auto-publish" },
  recruit_activated:       { consumers: ["deal_coordinator"],                    disposition: "handled", kind: "update",     what: "a recruited agent was provisioned — Deal Coordinator wires them into production tracking" },
  agent_first_close:       { consumers: ["recruiting_manager"],                  disposition: "handled", kind: "update",     what: "a recruited agent closed their first deal — recruiting ROI's first datapoint + celebrate" },
  agent_crushed_cap:       { consumers: ["recruiting_manager"],                  disposition: "handled", kind: "escalation", what: "a current agent blew past cap — surface as recruiting proof to the broker" },
  agent_stalling:          { consumers: ["recruiting_manager"],                  disposition: "handled", kind: "escalation", what: "a recruited agent is stalling on production — flag for a check-in" },
  deal_autopsy_completed:  { consumers: ["recruiting_manager"],                  disposition: "handled", kind: "alert",      what: "a won/lost-deal autopsy finished — feed the coaching/recruiting learning" },
  contact_withdrawn:       { consumers: ["sphere_of_influence"],                 disposition: "handled", kind: "alert",      what: "every channel revoked + no new contact info — mark withdrawn, inform the agent, preserve history" },
  showing_feedback_routed: { consumers: ["listing_concierge"],                   disposition: "handled", kind: "update",     what: "the week's buyer-showing feedback routed a play (price pressure / strong interest / presentation) — concierge proposes a gated seller recommendation (manager-orchestrated, not a passive task)" },
  listing_stall_predicted: { consumers: ["listing_concierge"],                   disposition: "handled", kind: "update",     what: "a listing is heading for a stall (DOM past the area's pace, showings drying up, no offers) BEFORE expiry — concierge proposes an early gated marketing-refresh/price-strategy recommendation" },
  home_value_seller_intent:{ consumers: ["listing_concierge"],                   disposition: "handled", kind: "update",     what: "a homeowner requested a home value (home-value tool / valuation magnet) — the strongest INBOUND seller signal; concierge proposes a gated precise-CMA follow-up so the team responds like a listing lead, not a lead left in the inbox" },
  buyer_stall_predicted:   { consumers: ["shopping_agent"],                       disposition: "handled", kind: "update",     what: "a buyer has toured a lot with no offer written (fatigue / expectations / drifting away) — the buyer-side counterpart to listing-stall; Shopping Agent proposes a gated reset (recalibrate expectations or re-energize with fresh matches)" },

  // ── Feed-only — surfaced on the Command Center for a HUMAN (no automated consumer by design) ──
  creative_fatigue:               { consumers: [], disposition: "feed_only", kind: "alert",      what: "an ad creative's performance is fatiguing — refresh advised" },
  first_touch_deferred:           { consumers: [], disposition: "feed_only", kind: "deferral",   what: "a manager yielded the first touch to another (soft dissent — 'you've got this')" },
  deferral_stall_nudge:           { consumers: [], disposition: "feed_only", kind: "deferral",   what: "a deferred touch has stalled past its window — nudge to pick it back up" },
  relist_recovery:                { consumers: [], disposition: "feed_only", kind: "handoff",    what: "a listing expired/withdrawn — re-list recovery outreach + recommend a call" },
  offer_rejection_recovery:       { consumers: [], disposition: "feed_only", kind: "handoff",    what: "a buyer's offer was rejected — same-day regroup call routed to the ISA" },
  rate_lock_watch:                { consumers: [], disposition: "feed_only", kind: "handoff",    what: "a rate-lock window is worth watching for a financing client" },
  reverse_prospecting_call_candidate:{ consumers: [], disposition: "feed_only", kind: "handoff", what: "an MLS reverse-prospecting match surfaced a call candidate" },
  stale_preapproval_reengage:     { consumers: [], disposition: "feed_only", kind: "handoff",    what: "a pre-approval went stale — re-engage the buyer before it lapses" },
  referral_reciprocity:           { consumers: [], disposition: "feed_only", kind: "update",     what: "a referral partner is owed reciprocity — surface the give-back" },
  channel_order_recommendation:   { consumers: [], disposition: "feed_only", kind: "update",     what: "the learned best lead channel for this brokerage (advisory)" },
  copy_variant_promoted:          { consumers: [], disposition: "feed_only", kind: "update",     what: "an A/B copy variant won on reply rate and was promoted" },
  health_lifecycle_play:          { consumers: [], disposition: "feed_only", kind: "update",     what: "a decaying relationship routed to the right manager for a re-engagement play" },
  second_opinion_requested:       { consumers: [], disposition: "feed_only", kind: "update",     what: "a strategic play asked a second manager for a complementary read (the huddle)" },
  source_allocation_advice:       { consumers: [], disposition: "feed_only", kind: "update",     what: "lead-source enable/disable advice from real conversion + ROI" },
  source_lifetime_health_advice:  { consumers: [], disposition: "feed_only", kind: "update",     what: "lead-source lifetime-quality advice (relationships that LAST, not just first close)" },
  win_story:                      { consumers: [], disposition: "feed_only", kind: "update",     what: "a farm-area win worth telling the neighborhood (social proof)" },
  trid_disclosure_clock:          { consumers: [], disposition: "feed_only", kind: "update",     what: "a TRID disclosure clock is ticking on a deal — keep the timeline honest" },
  journey_conformance_violation:  { consumers: [], disposition: "feed_only", kind: "alert",      what: "a contact's journey drifted off its required path — flag for review" },
  net_sheet_surprise:             { consumers: [], disposition: "feed_only", kind: "alert",      what: "a net-sheet figure shifted enough to surprise the seller — get ahead of it" },
  wire_fraud_risk:                { consumers: [], disposition: "feed_only", kind: "update",     what: "a wire-fraud risk signal on a closing — verify before any funds move" },
  document_compliance_finding:    { consumers: [], disposition: "feed_only", kind: "alert",      what: "a document-compliance audit finding needs a human's eyes" },
  regulatory_change_detected:     { consumers: [], disposition: "feed_only", kind: "alert",      what: "a real-estate regulatory change was detected that touches the gates" },
  license_risk_escalated:         { consumers: [], disposition: "feed_only", kind: "escalation", what: "an AI-sentinel license/authority risk escalated for review" },
  launch_war_room_convened:       { consumers: [], disposition: "feed_only", kind: "escalation", what: "a listing launch war-room convened the team" },
  fire_drill_opened:              { consumers: [], disposition: "feed_only", kind: "escalation", what: "a fire-drill opened — the team converges on an urgent situation" },
  farm_play_convened:             { consumers: [], disposition: "feed_only", kind: "escalation", what: "a farm play convened the managers around a neighborhood opportunity" },
  bidding_war_convened:           { consumers: [], disposition: "feed_only", kind: "escalation", what: "a bidding-war concierge convened the team around multiple offers" },
  first_touch_claimed:            { consumers: [], disposition: "feed_only", kind: "handoff",    what: "a manager claimed the first touch on a new lead (the bullpen race resolved)" },
  open_house_lead_handoff:        { consumers: [], disposition: "feed_only", kind: "handoff",    what: "the hot, unrepresented buyer leads from a Listing Concierge open house handed to the AI ISA to qualify — the seller-event → buyer-pipeline bridge, made visible on the bus" },
  dual_transaction_timing:        { consumers: [], disposition: "feed_only", kind: "update",     what: "MOVE-UP coordination — a 'both' contact selling their current home AND buying the next; the Listing Concierge ↔ Shopping Agent timing play (ramp the buyer search as the sale closes, prep a sale-contingent offer, or align close dates) made visible on the bus so the two sides never drift out of sync" },
  stage_stalled:                  { consumers: [], disposition: "feed_only", kind: "update",     what: "a contact has sat in a legal lifecycle stage TOO LONG with nothing in motion (the quiet failure journey-conformance's illegal-transition check misses) — surfaced to the manager who owns that stage (AI ISA / Shopping Agent / Listing Concierge / Deal Coordinator) by dwell-vs-ceiling" },
  listing_marketing_ready:        { consumers: [], disposition: "feed_only", kind: "handoff",    what: "a listing reached coming-soon or went live — the Listing Concierge → Campaign Orchestrator marketing handoff, made visible on the bus (the kernel-event fanout still enrolls the sequences; this makes the team coordination legible)" },
  offer_docs_ready:               { consumers: [], disposition: "feed_only", kind: "handoff",    what: "a signed offer packet passed the completeness scan (all required forms present + signed) — the Deal Coordinator handoff that the docs are verified and ready to send to the listing agent (the agent is also notified)" },
  agent_overloaded:               { consumers: [], disposition: "feed_only", kind: "escalation", what: "capacity guardian flagged an agent's load — surfaced for the broker (advisory)" },
}

/** Look up a signal's spec (undefined = uncatalogued, which test:signal-integrity fails on). */
export function signalSpec(signalType: string): SignalSpec | undefined {
  return SIGNAL_REGISTRY[signalType]
}

/** Every catalogued signal_type. */
export function registeredSignalTypes(): string[] {
  return Object.keys(SIGNAL_REGISTRY)
}
