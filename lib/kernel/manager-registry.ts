/**
 * lib/kernel/manager-registry.ts
 *
 * THE canonical map of "which Claude manager owns this activity". The One Command
 * Center aggregates every governed action across many surfaces; this registry makes
 * the multi-manager model explicit and accountable — EVERY activity on the egress is
 * owned by a named manager, with ZERO orphans. Adding a new Command Center queue
 * without assigning it here fails the manager-ownership regression test.
 *
 * Pure module (no imports, no server-only) so both the kernel loader (server) and the
 * Command Center UI (client) share ONE source of truth for manager identity + labels —
 * no drift between a server map and a hand-kept client KIND_LABEL.
 *
 * All 11 managers mirror managed_agents.agent_kind (lib/agents/spawn-helper.ts AgentKind):
 * the 7 core managers + Ads Manager (m193) + AI ISA (m197, lead qualification/nurture) +
 * Recruiting Manager (m215, agent recruiting / talent pipeline — brokerage growth) +
 * Data Steward (m203, data integrity / identity / field stewardship across the lead spine).
 *
 * ── PRESERVED MANAGER BOUNDARIES (the product's governance contract) ──────────
 * Sides of the business map to managers precisely — no blurring:
 *   · AI ISA            — leads (unconsented, ISA + brokerage owned) and ISA
 *                         engagement ACTIVITIES: every outreach/call/message the
 *                         ISA logs while qualifying, until handoff converts the
 *                         lead to a contact.
 *   · Listing Concierge — the SELLER side: listings and in-house SHOWINGS of our
 *                         listings (external buyer agents coming through our door,
 *                         ShowingTime sync, access codes, seller feedback loops).
 *   · Shopping Agent    — the BUYER side: TOURS (taking our buyer out, routes,
 *                         stops) and OFFERS the buyer writes, plus preferences,
 *                         matches and saved properties.
 *   · Deal Coordinator  — post-acceptance: transactions, transaction tasks and
 *                         the deal calendar through closing.
 *   · Sphere Manager    — LIFETIME relationships: closed & past clients, repeat
 *                         and referral cultivation after the deal is done.
 * No additional manager is needed for these splits — each boundary lands cleanly
 * on an existing manager's charter; introducing one would dilute accountability.
 */

export type ManagerKey =
  | "deal_coordinator"
  | "shopping_agent"
  | "listing_concierge"
  | "sphere_of_influence"
  | "campaign_orchestrator"
  | "marketing_agent"
  | "asset_manager"
  | "ads_manager"
  | "ai_isa"
  | "data_steward"
  | "recruiting_manager"

export interface ManagerInfo {
  key:    ManagerKey
  label:  string
  /** One-line domain the manager is accountable for (UI tooltip / grouping). */
  domain: string
}

export const MANAGERS: Record<ManagerKey, ManagerInfo> = {
  deal_coordinator:      { key: "deal_coordinator",      label: "Deal Coordinator",      domain: "Transactions & closings" },
  shopping_agent:        { key: "shopping_agent",        label: "Shopping Agent",        domain: "Buyer journey" },
  listing_concierge:     { key: "listing_concierge",     label: "Listing Concierge",     domain: "Sellers & listings" },
  sphere_of_influence:   { key: "sphere_of_influence",   label: "Sphere Manager",        domain: "Lifetime closed & past clients — repeat & referral" },
  campaign_orchestrator: { key: "campaign_orchestrator", label: "Campaign Orchestrator", domain: "Multi-touch campaigns & content" },
  marketing_agent:       { key: "marketing_agent",       label: "Marketing Manager",     domain: "Brand & promotion" },
  asset_manager:         { key: "asset_manager",         label: "Asset Manager",         domain: "Media & brand library" },
  ads_manager:           { key: "ads_manager",           label: "Ads Manager",           domain: "Paid advertising" },
  ai_isa:                { key: "ai_isa",                label: "AI ISA",                domain: "Lead qualification, nurture & re-engagement" },
  data_steward:          { key: "data_steward",          label: "Data Steward",          domain: "Data integrity, identity & field stewardship" },
  recruiting_manager:    { key: "recruiting_manager",    label: "Recruiting Manager",    domain: "Agent recruiting & talent pipeline (brokerage growth)" },
}

/**
 * Every Command Center queue → its owning manager. `client_message` is resolved
 * per-row from the message's agent_kind (any of the deal-critical managers can
 * propose a client message), so it is intentionally absent here and handled by
 * resolveActionManager.
 */
export const QUEUE_MANAGER: Record<string, ManagerKey> = {
  // Agent-action queues
  marketing:              "marketing_agent",
  asset:                  "asset_manager",
  ads:                    "ads_manager",
  // Content-approval queues
  social:                 "marketing_agent",
  newsletter:             "campaign_orchestrator",
  direct_mail:            "marketing_agent",
  ad_creative:            "ads_manager",
  predictive_listing:     "sphere_of_influence",
  transaction_task:       "deal_coordinator",
  transaction_smart_task: "deal_coordinator",
  agent_followup:         "sphere_of_influence",
  blog:                   "campaign_orchestrator",
  podcast:                "campaign_orchestrator",
}

/**
 * MAINTENANCE / BURN-DOMAIN OWNERSHIP — every audit/cleanup workstream on the egress
 * is owned by a named Claude manager, so as code is cleaned and fixed there is always
 * a manager accountable for keeping that domain on the ONE egress. The ownership
 * simulator asserts every domain maps to a real manager (zero orphan burn types),
 * and each domain lists its runnable proof so the owner is tied to a regression,
 * not just a label.
 */
export const MAINTENANCE_DOMAINS: Record<string, { manager: ManagerKey; proof: string; what: string }> = {
  // ── Data Steward — data integrity across the raw → leads → contacts spine ──
  schema_drift_guard:         { manager: "data_steward", proof: "test:schema-drift",       what: "No code references a column the live table lacks; baseline burn-down ratchet" },
  lossless_promotion:         { manager: "data_steward", proof: "test:data-steward",       what: "raw → leads → contacts moves identity/address/enrichment without loss" },
  import_field_mapping:       { manager: "data_steward", proof: "test:data-steward",       what: "CSV/CRM imports: known fields map, unmapped columns preserved in notes" },
  import_value_normalization: { manager: "data_steward", proof: "test:data-steward",       what: "Imported values reconciled to canonical vocabulary (synonyms + gated AI match)" },
  dedup_merge:                { manager: "data_steward", proof: "test:data-steward",       what: "Dedup merges fill empties and preserve conflicts in notes — never drop" },
  enrichment_conservation:    { manager: "data_steward", proof: "test:data-steward",       what: "PeopleData enrichment lands in first-class columns AND jsonb" },
  consent_suppression:        { manager: "data_steward", proof: "test:lead-pipeline",      what: "TCPA consent/opt-out provenance carries faithfully — no fabricated consent" },
  manager_boundaries:         { manager: "data_steward", proof: "test:manager-ownership",  what: "Buyer/seller/lead/lifetime boundaries preserved: tours+offers=buyer (Shopping), in-house showings=listing side, ISA activities=AI ISA, sphere=lifetime past clients" },
  // ── AI ISA — the qualify → assign → convert chain ──
  qualification_chain:        { manager: "ai_isa",       proof: "test:isa-qualification",  what: "Conversation scoring persists; readiness gates handoff" },
  assignment_routing:         { manager: "ai_isa",       proof: "test:isa-qualification",  what: "Tier-aware routing (solo/team/brokerage/multi-location); preview = engine" },
  lead_conversion:            { manager: "ai_isa",       proof: "test:isa-qualification",  what: "Qualification converts to a lossless contact via the canonical converter" },
  credit_pipeline:            { manager: "ai_isa",       proof: "test:schema-drift",       what: "Credit-readiness nurture (kanban mirrors on contacts; credit_accounts canonical)" },
  briefing_isa_overnight:     { manager: "ai_isa",       proof: "test:isa-qualification",  what: "Overnight handoffs/escalations lead the agent + team-lead morning briefs" },
  voice_isa:                  { manager: "ai_isa",       proof: "test:isa-qualification",  what: "Voice calls feed the SAME rolling qualification + canonical handoff chain as email" },
  transaction_propensity:     { manager: "ai_isa",       proof: "test:propensity",         what: "Signal fusion — intent/engagement/equity/life-event/referral/recency fused into one transparent 'likely to transact in 90 days' score + top reasons (who to re-engage first)" },
  voice_dial_batch:           { manager: "ai_isa",       proof: "test:voice-dial-batch",   what: "AI ISA proposes a batch of CONSENTED high-propensity contacts to call; human approves; consent is RE-CHECKED at approval before any dial (voice is contacts-only, TCPA + ISA-reengage gated)" },
  manager_signal_bus:         { manager: "campaign_orchestrator", proof: "test:manager-signals", what: "Inter-manager bus — managers publish outcomes, addressed managers consume by proposing governed deliverables; every conversation auditable + on the Command Center" },
  team_plays:                 { manager: "campaign_orchestrator", proof: "test:team-plays", what: "The huddle — ≥2 managers with open business on one client convene into ONE co-authored play; fragments superseded (no proposal spam), every play human-approved" },
  appointment_whisper:        { manager: "campaign_orchestrator", proof: "test:whisper",    what: "The Whisper — T-30 hallway briefing: the managers' combined knowledge on the next client whispered to the agent in the user's CONFIGURED assistant voice (audio on EVERY tier; text only when no voice is configured)" },
  fire_drills:                { manager: "deal_coordinator", proof: "test:fire-drill",  what: "The 9pm save — UNCOVERED deadline (contingency live + prerequisite missing) convenes the team: CRITICAL save-plan briefing (assistant voice on every tier), client-calming draft into the gate, audit line on the bus" },
  consent_recovery_chain:     { manager: "data_steward", proof: "test:consent-recovery", what: "Revoked consent is a CHAIN not a flag: fallback to the channel the client still allows (gated) → enrichment re-run for updated contact info → only then a respectful withdraw via the Sphere (history kept, never a delete)" },
  manager_dissent:            { manager: "campaign_orchestrator", proof: "test:manager-dissent", what: "Peer review before the human sees a proposal: a DIFFERENT manager checks Fair Housing (shared pattern list), consent, fire-drill timing + spacing — visible dissent notes; vetoes only for withdrawn/revoked (auditable, no forged approver)" },
  partners_meeting:           { manager: "campaign_orchestrator", proof: "test:partners-meeting", what: "Sunday Night Partners' Meeting — the week presented by the AI team (plays, drills, whispers, recoveries, dissents, deals + the one ask) as D-ID avatar video / assistant-voice audio / memo, every tier" },
  cron_dispatch:              { manager: "data_steward", proof: "test:cron-dispatch", what: "One heartbeat, every schedule — vercel.json keeps ONE per-minute cron; the registry preserves all 100+ loop schedules verbatim (Vercel's 40-cron cap was failing every deployment at config validation); drift closed both directions (route ⇄ registry ⇄ vercel.json)" },
  team_query:                 { manager: "campaign_orchestrator", proof: "test:team-query", what: "'Hey team—' — the bullpen question: ask the voice admin about a person and the FULL bench reports what its OWN tables know (propensity, saves, deals+deadlines, gate, marketing touches+sequences, data hygiene, recruit overlap, bus talk, withdrawn state) in ONE manager-attributed spoken answer; read-only, honest when empty" },
  voice_delegation:           { manager: "campaign_orchestrator", proof: "test:voice-delegation", what: "The handoff after the bullpen: 'send a follow-up' = propose→approve AS the speaking agent through the SAME gate (consent re-checked; dictation verbatim); 'start marketing' = governed sequence enrollment (steps clear the compliance gate); 'cut a promo reel for 44 Birch' = manual trigger on the CANONICAL Remotion+D-ID rail (Fair Housing pre-flight, cooldown debounce, social drafts human-approved); WITHDRAWN refuses outreach" },
  morning_standup:            { manager: "campaign_orchestrator", proof: "test:morning-standup", what: "'Hey team, what should I do today?' — the managers rank the day's top 3 moves: fire drills first (most expensive to ignore), then aging client-message approvals (overdue past the 4h SLA outrank fresh), then the single warmest cooling lead (14d+ quiet, propensity-ranked); one spoken ranked answer, read-only, honest when the day is clear" },
  standup_action:             { manager: "campaign_orchestrator", proof: "test:standup-action", what: "'Knock out number two' — one-breath delegation on a ranked stand-up item: re-derived live (never stale), routed to its rail (approval→approve AS the agent through the gate; reengage→follow-up; fire is NEVER auto-resolved — a save plan is human judgment)" },
  area_query:                 { manager: "campaign_orchestrator", proof: "test:area-query", what: "'Anything happening near 44 Birch?' — the bullpen for a PLACE: the marketing bench reports active listings (Listing Concierge), reusable promo reels ready/rendering (Asset Manager), and live ads targeting the area (Ads Manager); read-only, honest when nothing's running" },
  idle_hands_initiative:      { manager: "campaign_orchestrator", proof: "test:idle-hands", what: "Managers fill silence with governed work: stale listings get social drafts (pending approval), recent closings get just_sold reels (lifecycle policy ON — automatic work never bypasses it), anniversaries get gated notes, missing email/phone self-heals via enrichment, the warmest cooling lead gets a PRE-DRAFTED re-engage (auto-draft ≠ auto-send); the IDLE RULE blocks initiative when a manager's own proposals already pend" },
  manager_office_hours:       { manager: "campaign_orchestrator", proof: "test:office-hours", what: "Drops, not sprays: morning + afternoon drops sweep unread per-proposal approval pings into ONE digest per agent grouped by manager (oldest wait surfaced); swept pings marked read (audit kept), CRITICAL never swept, gate/SLA untouched" },
  outcome_learning:           { manager: "campaign_orchestrator", proof: "test:outcome-learning", what: "The human's approve/reject decisions tune the team: HUMAN decisions only (peer-review vetoes + team-play supersedes excluded), trusted until a real sample (10+) falls below 40% approval — then that manager's INITIATIVE pauses (commands + scheduled duties continue); consulted live by idle-hands. Rejections carry the spoken WHY ('reject number two — too pushy' → agent feedback stored), and the TRUST METER on the Command Center shows rates + reasons per manager" },
  initiative_ledger:          { manager: "campaign_orchestrator", proof: "test:idle-hands", what: "'While you were away' — one leadership card per idle-hands pass that produced work (social drafts, reels, notes, data fixes, pre-drafts, seasonal plays), 12h dedupe; the morning proof the team worked overnight" },
  seasonal_plays:             { manager: "campaign_orchestrator", proof: "test:idle-hands", what: "Quarter-aware campaigns staged INACTIVE once per season (Spring Sellers / Summer Movers / Fall Market Reset / Year-End Gratitude) — the human activates; nothing runs until then; idempotent by season name" },
  persona_copy:               { manager: "campaign_orchestrator", proof: "test:ai-copy", what: "Copy is NEVER hardcoded — every play generates its wording per the contact's persona (name, audience, situation, brand tone) + the real facts through the AI gateway, with a deterministic fallback so a play always produces safe real copy; Fair Housing enforced in the system prompt" },
  commission_forecaster:      { manager: "deal_coordinator", proof: "test:commission-forecaster", what: "Live commission/GCI forecast per agent from the real pipeline (closed YTD + probability-weighted in-progress) → cap distance + pace-to-goal + the 1-2 deals to push; gated agent summary (optional assistant-voice audio); cap read if configured, honestly says so when not" },
  offer_net_sheet:            { manager: "listing_concierge", proof: "test:offer-net-sheet", what: "In-house listing with open offer(s) → side-by-side seller NET PROCEEDS comparison (price − payoff/taxes/HOA/commission/credit) ranked by NET (surfaces the offer that nets the seller most, not the highest price); ONE gated agent summary + a read-only seller-portal VALUE card + an interactive net sheet in the offer view & portal; idempotent per offer-set/24h" },
  closing_watchtower:         { manager: "deal_coordinator", proof: "test:closing-watchtower", what: "The EARLY layer on the date chain — a chain date MOVES (milestone audit trail: lifecycle.milestone.date_changed) → critical path to closing recomputed (binding constraint + slack + ok/tight/at_risk) → ONE gated Deal Coordinator alert with the concrete impact + a plain-language portal value card to BOTH represented sides; idempotent per move-set + per contact/day; no closing date on file → skipped honestly" },
  anniversary_equity:         { manager: "sphere_of_influence", proof: "test:anniversary-equity", what: "Yearly closing-anniversary equity report for past clients: REAL AVM value vs purchase price; equity only when the original loan is on file (else appreciation-only and the copy says so); portal value card (equity_report) + ONE gated agent proposal carrying the ready-to-send anniversary note + optional D-ID+ElevenLabs avatar video when the agent's voice/avatar is configured; one report per contact per YEAR; no valuation → honest skip" },
  listing_appt_prep:          { manager: "listing_concierge", proof: "test:listing-appt-prep", what: "the flagship pre-listing-appointment chain — CMA → presentation → D-ID chapter videos → pre-appointment drip, run-dedupe idempotent per (chain,entity,trigger); pushes a seller-portal value card up front (the flywheel)" },
  financing_pit_stop:         { manager: "deal_coordinator", proof: "test:financing-pit-stop", what: "Deal enters the FINANCING window (financing milestone approaching, or buyer's pre-approval going stale — real stored dates only, else skipped) → parallel rate-refresh RACE across the preferred lender bench (one GATED rate-request draft per preferred lender, nothing auto-sends), known/returned quotes ranked by lowest EFFECTIVE COST (rate + points + amortized fees) → ONE gated Deal Coordinator agent summary + a read-only buyer-portal value card; rates labeled estimates; idempotent one-race-per (deal, financing-window). Complements the Title & Closing Watchtower (date side)" },
  bidding_war_concierge:      { manager: "shopping_agent", proof: "test:bidding-war", what: "Buyer-side bidding-war prep on an OUTSIDE listing — escalation-strategy brief (ceiling+cap+term levers, agent-gated), a buyer-voice 'highest-and-best' cover letter DRAFT (Fair-Housing constrained) for the buyer to approve, and a rapport note to the outside listing agent; one bundle per offer, nothing auto-sends" },
  reverse_prospecting:        { manager: "shopping_agent", proof: "test:reverse-prospecting", what: "A new/coming-soon listing matches the brokerage's OWN buyers by saved criteria (property_preferences) → Shopping Agent proposes a persona-aware buyer note per match (gated) + AI ISA queued as call candidates (bus); one note per (listing, buyer) ever — inventory becomes instant buyer demand" },
  tour_optimizer:             { manager: "shopping_agent", proof: "test:tour-optimizer", what: "Buyer Tour Day Optimizer — a planned tour's stops are geocoded (FREE OSM Nominatim) and ordered nearest-neighbor by drive time (haversine @ 30mph ESTIMATE, labeled 'est.'; un-geocodable stops kept in place with null drive — no fabrication), written back to tour_stops.order_index + drive_time_from_prev_minutes + tours.total_drive_time_minutes + a showing_routes audit row; after completion ONE buyer-portal value card recaps the day (loved/liked counts + per-home feedback + warm next step) and stamps the tour reported; idempotent per tour" },
  vendor_orchestration:       { manager: "deal_coordinator", proof: "test:vendor-orchestration", what: "As a deal crosses each stage the right bench vendor (inspector/lender/title; stager ONLY when staging is enabled in brokerage settings) is proposed PREFERENCE-FIRST (preferred over rating) with a persona-aware quote draft — gated to the agent, one per (txn, service_type), nothing auto-books" },
  objection_library:          { manager: "ai_isa", proof: "test:objection-library", what: "Every ISA-call objection is categorized; the rebuttal that books the most appointments is crowned (min-sample gated) and fed to the next call script — sales intelligence compounding off real conversations; no new table (derived from ai_isa_calls)" },
  referral_radar:             { manager: "sphere_of_influence", proof: "test:referral-radar", what: "Data Steward derives a life-event on a past client (job change, equity milestone, etc.) and the Sphere surfaces BOTH a nudge (internal notification — who to reach + why) AND a persona-aware touchpoint drafted into the gate; one per (contact, event) per 90d; withdrawn excluded" },
  campaign_command_center:    { manager: "campaign_orchestrator", proof: "test:campaign-center", what: "ONE surface for every marketing draft the bench staged across all channels (social/email/newsletter/blog/direct-mail/ads/neighbor-farm/open-house), grouped by play — the agent approves the whole campaign in one place instead of piecemeal" },
  marketing_bench:            { manager: "campaign_orchestrator", proof: "test:marketing-bench", what: "ONE primitive stages a coordinated draft across EVERY channel (social, email, newsletter, blog, direct mail) — each gated to its pending/draft state, idempotent, ID-space + CHECK-constraint correct; the plays just say 'stage these' and the bench handles every table" },
  intent_campaign:            { manager: "data_steward", proof: "test:intent-campaign", what: "The Data Steward leads outbound: SCRAPES motivated sellers (BatchData high-equity/absentee/pre-foreclosure) in active markets + the brokerage's own high-intent buyers, then the bench drafts SITUATION-SPECIFIC email + direct mail to each — gated, scrape is an injectable seam (no test spend)" },
  launch_war_room:            { manager: "campaign_orchestrator", proof: "test:launch-war-room", what: "The new-listing bookend to the Farm Play: a coming-soon/just-listed listing convenes the bench — reel + social/email/newsletter/blog + the FIRST open house scheduled + a coming-soon neighbor farm + a geo ad + one agent summary; all gated, one war room per listing" },
  lookalike_audience:         { manager: "ads_manager", proof: "test:lookalike", what: "First-party lookalike from the CLOSING TABLE: the Ads Manager seeds a lookalike audience from the brokerage's actual closed buyers (who really bought, where) — paid spend chases proven converters, not generic interest segments; staged as a draft ad (min seed guard)" },
  farm_play:                  { manager: "campaign_orchestrator", proof: "test:farm-play", what: "A Team Play for a PLACE — geographic farming, the listing agent's #1 growth engine, run as ONE coordinated multi-manager play on each closed deal: Data Steward stages the neighbor farm (seller-permission-gated), Marketing drafts the 'just sold near you' postcard, Ads stages a geo campaign (draft), Recruiting logs standout wins as talent-pipeline proof, Campaign Orchestrator proposes one agent summary — six managers, nothing sends until seller OK + human approval" },
  client_pulse:               { manager: "listing_concierge", proof: "test:client-pulse", what: "The CLIENT's weekly 'what your team did for you': sellers get showings+feedback, social, reel status, live ads, next deadline with HONEST coverage ('already covered' vs 'on it'); buyers get saves, tours, deal stage; gated (proposed→approved→portal card), one per client per week, empty weeks stay SILENT — answers 'my agent went dark'" },
  voice_results_loop:         { manager: "ai_isa",       proof: "test:manager-signals",    what: "Call outcomes shape the next dial list (cooldowns: recent call 14d, cold outcome 30d, appointment → hand off to the concierge via the bus)" },
  // ── Surface sections owned by their domain managers ──
  briefing_deal_risk:         { manager: "deal_coordinator",  proof: "test:manager-ownership", what: "Deals-at-risk briefing sections" },
  deadline_watcher:           { manager: "deal_coordinator",  proof: "test:deadline-watcher", what: "Inspection/appraisal/financing/walkthrough/closing deadlines within 24h notify the deal parties (was built but never scheduled — found by the domain audit)" },
  briefing_listing_risk:      { manager: "listing_concierge", proof: "test:manager-ownership", what: "Listings-at-risk briefing sections" },
  client_message_gate:        { manager: "campaign_orchestrator", proof: "test:client-extract", what: "Every client-facing AI output proposes → human approves → sends" },
  portal_final_hop:           { manager: "campaign_orchestrator", proof: "test:portal-e2e", what: "End-to-end: approved portal messages render a visible client card; regulated channels (sms/email) hard-block at the consent gate before any send" },
  manager_daily_standup:      { manager: "campaign_orchestrator", proof: "test:manager-ownership", what: "Broker's daily per-manager accountability report (manager-standup.ts); every line manager-attributed" },
  manager_weekly_pnl:         { manager: "campaign_orchestrator", proof: "test:command-center", what: "Broker's weekly per-manager production scorecard (manager-weekly-pnl.ts); WoW outcomes incl. GCI" },
  brokerage_owner_report:     { manager: "campaign_orchestrator", proof: "test:brokerage-pnl", what: "Owner's Report — YTD GCI + company dollar, production by agent, recruiting ROI, referral value (brokerage-pnl.ts)" },
  governed_deliverables_rail: { manager: "campaign_orchestrator", proof: "test:deliverables", what: "Unified rail — every loop's gate proposals rolled up (count, human-approved, by manager + loop); the proof-of-system view" },
  agent_scorecard:            { manager: "deal_coordinator", proof: "test:agent-scorecard", what: "Per-agent production + deal health + education completion + recruiting ROI (agent-scorecard.ts) — agent-management view" },
  mobile_approval_push:       { manager: "campaign_orchestrator", proof: "test:mobile-approval", what: "Two-tier approval push: agent (front line) on every pending approval, manager escalation at 4h (approval latency is the egress's critical path)" },
  egress_coverage_audit:      { manager: "data_steward", proof: "test:egress-coverage", what: "Meta-audit: every burn domain's proof is runnable, every manager owns something, no dangling/orphan ownership — the governance graph stays whole" },
  seller_update_video:        { manager: "listing_concierge", proof: "test:seller-update-video", what: "Weekly seller-update D-ID avatar video proposed into the client-message gate (no HeyGen)" },
  strategy_learning_loop:     { manager: "shopping_agent",    proof: "test:strategy-learning",  what: "Offer/counter outcomes close the loop back to the recommendation that produced them (strategy_outcomes)" },
  strategy_learning_insights: { manager: "shopping_agent",    proof: "test:strategy-insights",  what: "Accumulated outcomes → market intelligence (win rate, deviation, by strategy type) fed back into the next recommendation" },
  referral_closing_loop:      { manager: "sphere_of_influence", proof: "test:referral-closer", what: "Deal close → matching referral closed, partner lifetime value credited, partner thank-you proposed into the gate" },
  recruiting_outreach_loop:   { manager: "recruiting_manager", proof: "test:recruit-outreach", what: "Recruit stage advance / stale recruit → next recruiting outreach proposed into the gate (talent pipeline kept warm)" },
  recruiter_agent_mgmt:       { manager: "recruiting_manager", proof: "test:recruiter-agent-mgmt", what: "Commission & Cap Forecaster loops the Recruiting Manager into agent-management via the bus: an agent who HITS/crosses cap → agent_crushed_cap (recruiting PROOF surfaced to broker/admins); a STALLING agent (real pipeline + big projected miss, or zero production + thin pipeline) → agent_stalling (coaching prompt to the responsible manager, never autonomous to the agent); deal_coordinator → recruiting_manager, dedupe per (recruiting_manager, type, agent)" },
  portal_value_card:          { manager: "campaign_orchestrator", proof: "test:portal-value", what: "The shared portal-value primitive: every contact-touch play (Client Pulse, Referral Radar, Reverse Prospecting) leaves ONE fresh REAL card on the contact's portal each run (transparency_updates, is_visible_to_client=true) drawn from values it already computed — idempotent per (contact, update_type, day), no fabrication, skips when a play has nothing real to say; the portal is always worth returning to" },
  vendor_marketplace_loop:    { manager: "deal_coordinator", proof: "test:vendor-loop", what: "Vendor booked → client intro proposed (Deal Coordinator); service completed → client review request proposed (Sphere) — both gated" },
  education_delivery_loop:    { manager: "shopping_agent", proof: "test:education-delivery", what: "Client at a lifecycle stage → side-appropriate concierge proposes the best-matched lesson into the gate + records the assignment" },
  video_outro_qr:             { manager: "asset_manager", proof: "test:video-qr", what: "AI-made reels carry a SCANNABLE, TRACKED outro QR reusing the existing qr_codes/qr_scan_events backend (no new tables): kind→destination_type map (just_listed/just_sold→listing_detail, open_house→book_meeting, presentation_chapter→video_avatar_tour, anniversary→anniversary_video, newsletter→landing_page); the /api/qr/scan?slug= resolver stays the dynamic indirection (target_url editable, slug never stale); idempotent per (entity,kind) so re-renders reuse one tracked code; default-off + mlsClean-clean (no QR on MLS cuts); a mint failure never blocks the render" },
  video_coordination:         { manager: "campaign_orchestrator", proof: "test:video-coordination", what: "A finished render becomes ONE coordinated team deliverable on the bus: Asset Manager → Campaign Orchestrator (gated multi-channel distribution draft, approval pending) ALWAYS + Ads Manager (proposed paid promotion) for promotable kinds (just_listed/just_sold/open_house) + on render failure → campaign_orchestrator:video_compliance_failed escalation; deduped per ai_video_project, nothing auto-publishes or auto-spends, the polling crons stay as idempotent safety nets" },
  video_director:             { manager: "asset_manager", proof: "test:video-director", what: "The Asset Manager DIRECTS video creation: selectVideoFormat picks the best of the 24 Remotion compositions per situation×target-channel (new_listing×TikTok→JustListedReelSquare+B-roll; ×YouTube→Horizontal 16:9; market/cma→chart reels; explainer→avatar; presentation→narrated slides; anniversary→EquityReportReel), then commissionVideo assembles intro (brand+agent photo+hook) → main (the chosen format) → outro (brand+contact+tracked QR), staging a compliance-gated ai_video_projects row the existing render crons + concatIntroOutro bookends carry; idempotent per (entity,kind), MLS-clean respected, never auto-publishes" },
  director_eval:              { manager: "data_steward", proof: "test:director-eval", what: "Compliance EVAL/REGRESSION harness over the autonomous Video Director (auditor distinct from the audited asset_manager): PROVES the autonomy stays governed by the EXISTING runtime gate (evaluateOutbound) — detectUngroundedClaims flags hook/caption/script facts not in commissionVideo's bounded factStrings (net-new grounding/hallucination coverage); detectFairHousingRisk reuses the ENCODED FAIR_HOUSING_PATTERNS (+ state_protected_classes) and is asserted to AGREE with the real Gate-4 evaluator (no invented rules); evalScopeCreep asserts approval_status stays 'pending_review' (never auto-publishes); evalLearningCannotRewardBlocked asserts a blocked variant never stages → never scored. Pure (CI) + guarded read-only live; exercises the gate, never a new gate" },
  video_broll:                { manager: "asset_manager", proof: "test:video-broll", what: "B-roll picker sources real lifestyle clips from the video_assets scope cascade (agent→team→brokerage, Mediabunny-probed durations) so the Director composites them under needsBroll formats (ComingSoon/Neighborhood/vertical Just-Listed); selectBrollPlan fills/loops/truncates the timeline; honest empty → no B-roll, never a fabricated clip or broken render" },
  explainer_anim:             { manager: "asset_manager", proof: "test:explainer-anim", what: "Animated explainer reel — a real-estate concept as a deterministic moving diagram (equity-over-time draw-on curve / rate-buydown payment bars / closing-timeline stepped path / what-$X/mo-buys price bars) with optional avatar PIP narration; the in-stack answer to Manim (NO Python runtime). Diagram CONTENT is the pure explainerDiagramSpec(topic, facts) output; topic rides situation.facts; geometry reuses lib/charts/geometry; honest hasData=false 'share your numbers' fallback when facts are thin — never fabricates a chart" },
  format_learning:            { manager: "asset_manager", proof: "test:format-learning", what: "The Video Director SELF-IMPROVES: scoreFormatOutcomes turns REAL signals (qr_scan_events on each video's minted QR + social_posts engagement) into per (kind×channel×composition×mood) performance; recommendFormatAdjustment keeps the deterministic default UNLESS a competitor has ≥ a real sample AND beats it by a clear margin (reusing outcome-learning's gating), then returns the learned pick + a human-readable why stamped to video_metadata.format_source; selectVideoFormatLearned with empty data === selectVideoFormat (backward-compatible) — never fabricates, never overrides on thin data" },
  promo_composition:          { manager: "asset_manager", proof: "test:promo-composition", what: "render-just-listed routes the composition per listing_promo event_type through the Director's SituationKind taxonomy instead of hardcoding JustListedReel: just_sold→JustSoldReelSquare (soldPrice/daysOnMarket/above-asking), open_house_*→OpenHouseAnnounceReel (date/time headline), coming_soon→ComingSoonReel (whenString/teaser/broll); just_listed/price_reduction/under_contract keep the legacy vertical 25s organic reel (hybrid D-ID bookends + 9:16 social). Missing required facts → honest fallback to JustListedReel, flagged, never a broken render" },
  hook_ab:                    { manager: "asset_manager", proof: "test:hook-ab", what: "Hook A/B 'first-3-seconds' engine — the Director drafts 2-3 distinct OPENING hook angles (curiosity/social-proof/urgency/value), each independently compliance-gated, and stages them as ai_video_projects rows sharing an experiment_id (+ variant_index + hook_variant) each minting its own tracked QR; format-learning's scoreHookOutcomes + recommendHookWinner crown the winning opener ONLY past the same sample+margin gate (real qr_scan_events + social engagement), stamping hook_source default|learned so future commissions prefer it. Nothing auto-publishes; honest 'still testing' on thin data; single-hook path unchanged" },
  photo_walkthrough:          { manager: "asset_manager", proof: "test:photo-walkthrough", what: "Cinematic photo→walkthrough reel — turns any MLS photo set (listing_media file_url, sort_order asc) into a MOVING property tour so a listing with NO video still gets a scroll-stopping reel: each photo gets a Ken Burns pan/zoom over its own frame window with a cross-fade + narrated tour-beat captions. Motion is the PURE kenBurnsPlan(photos, bodyFrames, opts) output (windows tile the timeline, alternating pans, oversized set capped, sane scale/pan bounds); honest empty → [] so the Director skips it; reuses the JustListedReel brand/QR/voiceover contract" },
  caption_burn_in:            { manager: "asset_manager", proof: "test:captions", what: "Sound-off captions: buildCaptionPlan chunks a script into ≤4-word cues that tile the VO timeline (no overlap, sane dwell), word-accurate from REAL ElevenLabs with-timestamps alignment when present else honest even-distribution ESTIMATE (timingSource flag, never claims sync it lacks); empty script → []; CaptionLayer cue-selection is bounds-safe; additive + default-off across the VO-bearing compositions so existing renders never regress" },
  content_studio:             { manager: "asset_manager", proof: "test:content-studio", what: "The Content Studio — the Asset Manager's command surface that makes the AI creative team VISIBLE and approvable: loadContentStudio aggregates every Director-staged ai_video_projects reel into pending_review + recently-approved groups, each surfacing composition/aspect/channels, music mood, format_source + the learned WHY, the hook A/B (variants + crowned winner via recommendHookWinner's sample+margin gate), caption state, QR/B-roll flags; approveContentItem flips ONE reel through the REAL existing ai_video_projects gate (pending_review→approved, brokerage-scoped, idempotent) — read-only aggregation, gated approve, no new tables" },
  lead_intake_cockpit:        { manager: "data_steward", proof: "test:lead-intake", what: "The Lead Intake Cockpit — read-only command surface over the FRONT of the lifecycle: the live raw_scraped_leads → THE GATE (processRawRecord: enrich/dedup/territory+identity guards) → leads (ai_isa_owner) → contact funnel, folded into stage counts (pending/promoted/rejected/error + converted), per-SOURCE conversion (raw→lead, lead→contact), the GATE-REJECTION breakdown with WHY (unassigned_no_market; territory_mismatch; insufficient identity; duplicate; error), and the top hot seller-intent leads the AI ISA is holding (ai_isa_owner, contact_id NULL, Listing Inventory Radar note + lead_score). Pure helpers unit-testable, honest zeros when empty; NO writes, no new tables — reuses the existing pipeline truth" },
  listing_inventory_radar:    { manager: "data_steward", proof: "test:inventory-radar", what: "Continuously surfaces SELLER-INTENT candidates the scraper bench already scraped (expired/withdrawn, FSBO, absentee, high-equity/pre-foreclosure) from raw_scraped_leads, scores intent 0..1 (documented weights — pre-foreclosure+high-equity outranks a fresh low-equity FSBO) + ranks, then feeds the hottest INTO THE CANONICAL FLOW: PROMOTE through THE GATE (processRawRecord — enrich/dedup/territory+identity guards) into a `leads` row (ai_isa_owner=true, NO portal, NOT a contact), carry the intent score+reasons onto the lead (notes + lead_score floor) so AI ISA prioritizes it, and route data_steward → ai_isa for qualification. The client-facing seller path (data_steward → listing_concierge: gated 'thinking of selling?' brief + Director reel + gated CMA) applies ONLY post-conversion, when the candidate is already a CRM contact (leads.contact_id). Idempotent per (candidate, window); never scrapes, never fabricates contact info, never messages a non-contact, nothing auto-sends" },
}

/**
 * GUARDED-TABLE OWNERSHIP — every table under the schema-drift guard has an owning
 * manager, so every remaining baseline entry (and any future drift) lands on a named
 * manager's burn-down list. The ownership simulator derives the table list from the
 * live snapshot: adding a guarded table without an owner FAILS the regression.
 */
export const TABLE_MANAGER: Record<string, ManagerKey> = {
  contacts:                     "data_steward",
  leads:                        "ai_isa",
  raw_scraped_leads:            "data_steward",
  property_preferences:         "shopping_agent",
  listings:                     "listing_concierge",
  property_matches:             "shopping_agent",
  saved_properties:             "shopping_agent",
  agent_client_messages:        "campaign_orchestrator",
  remotion_composition_renders: "asset_manager",
  notifications:                "campaign_orchestrator",
  assignment_log:               "ai_isa",
  ai_daily_briefings:           "ai_isa",
  ai_isa_call_batches:          "ai_isa",
  manager_signals:              "campaign_orchestrator",
  transactions:                 "deal_coordinator",
  // Buyer side: the buyer WRITES offers (pre-acceptance) and goes on tours.
  offers:                       "shopping_agent",
  tours:                        "shopping_agent",
  tour_stops:                   "shopping_agent",
  // Seller side: in-house showings OF our listings (external buyer agents,
  // ShowingTime sync, access codes) belong to the listing's manager.
  showings:                     "listing_concierge",
  tasks:                        "deal_coordinator",
  // The activity ledger is dominated by ISA engagement records (outreach, calls,
  // messages while qualifying) — the AI ISA is accountable for it.
  activities:                   "ai_isa",
  calendar_events:              "deal_coordinator",
}

/** Resolve the manager accountable for a maintenance/burn domain (never undefined). */
export function resolveMaintenanceManager(domain: string): ManagerInfo {
  const entry = MAINTENANCE_DOMAINS[domain]
  return entry ? MANAGERS[entry.manager] : FALLBACK_MANAGER
}

/** Resolve the manager accountable for a guarded table's data integrity (never undefined). */
export function resolveTableManager(table: string): ManagerInfo {
  const key = TABLE_MANAGER[table]
  return key ? MANAGERS[key] : FALLBACK_MANAGER
}

/** Fallback owner for any activity not yet mapped — surfaced so nothing is ever truly orphaned. */
export const FALLBACK_MANAGER: ManagerInfo = {
  key: "marketing_agent", label: "Operations", domain: "Unassigned — needs an owner",
}

/**
 * Resolve the owning manager for a Command Center action. For `client_message` the
 * owner is the proposing manager (its agent_kind); for every other queue it's the
 * static QUEUE_MANAGER owner. Never returns undefined (zero-orphan guarantee).
 */
export function resolveActionManager(queue: string, agentKind?: string | null): ManagerInfo {
  if (queue === "client_message") {
    if (agentKind && agentKind in MANAGERS) return MANAGERS[agentKind as ManagerKey]
    return FALLBACK_MANAGER
  }
  const key = QUEUE_MANAGER[queue]
  return key ? MANAGERS[key] : FALLBACK_MANAGER
}
