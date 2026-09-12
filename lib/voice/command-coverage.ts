// lib/voice/command-coverage.ts
//
// VOICE-ADMIN COMMAND COVERAGE MAP — the honest, typed registry of which
// kernel/action commands a spoken command can reach through the ElevenLabs
// conv-ai tool bridge (app/api/agent-assistant/tool-call/route.ts), and which
// canonical commands are NOT speakable yet and exactly why.
//
// RULES OF THIS FILE (enforced by scripts/voice-command-coverage-simulator.ts):
//   • No aspirational rows — every speakable row's toolName is a real `case`
//     in the tool-call route's runTool switch, and every tool the route
//     dispatches has a row here (zero unregistered tools).
//   • A gap that can't be closed honestly stays speakable:false with the
//     concrete reason — never a fake speakable row.
//   • Pure module: no I/O, no server-only imports — importable by the
//     "What can I say?" panel (server component) and the simulator alike.
//
// Why some canonical commands were NOT speakable (the round-35 recurring
// reason): the conv-ai tool webhook is SESSIONLESS by design (ElevenLabs POSTs
// with a shared tool secret; there is no user auth cookie). Kernel commands
// built on the auth-cookie Supabase client (lib/supabase/server createClient)
// ran as `anon` there, and the live RLS on offers/showing_requests/... is
// tenant-scoped `authenticated`-only — the command would always return
// "not found".
//
// ROUND 36 CLOSURE: the cookie-bound kernel commands and the four action-level
// commands now take a sessionless-caller overload (optional injected client /
// verified-actor param; the cookie default preserved for every existing
// caller), so the voice backends run the SAME canonical transitions AFTER
// enforcing an equivalent-or-stricter guard server-side:
//   • reject/counter/withdraw offer → lib/voice/deal-decision.ts (mirrored
//     approvals-queue guard, kernel transitions via injected client)
//   • convert (qualified) lead / reassign contact / broadcast → lib/voice/broker-commands.ts
//     (role guard re-checked from the DB here AND the canonical action re-runs
//     its own gate through the injected client)
//   • showing request → lib/voice/showing-request.ts (ownership here; the
//     NAR-2024 BBA gate inside requestShowing stays absolute)
// The five phantom tool-registry rows are also closed — each now dispatches to
// its canonical home (steer-my-day, decision receipts, Income Truth, studio
// session, requestShowing). Zero rows declared-but-undispatched.

export type VoiceCoverageDomain =
  | "offers"            // deal decisions on inbound offers
  | "deal-documents"    // offer/BBA/listing packets, form fill, e-sign dispatch
  | "approvals"         // unified approvals queue + doc-kernel proposals
  | "contacts"          // CRM contact lookups + touches
  | "leads"             // lead promotion
  | "tasks"             // to-dos
  | "showings"          // showing scheduling
  | "messaging"         // portal messages + follow-ups
  | "marketing-content" // newsletters, email, blog, podcast, video, mail, ads
  | "team-coordination" // the manager-bench spoken commands
  | "broadcast"         // brokerage-wide announcements
  | "reporting"         // read-only briefings + pipelines
  | "scheduling"        // calendar / open house
  | "financial"         // lender/vendor financial-verification confirmations

export interface VoiceCommandCoverageRow {
  /** The canonical kernel/action command this row is about (module.symbol). */
  command: string
  domain: VoiceCoverageDomain
  /** True ONLY when a conv-ai webhook tool actually reaches the command today. */
  speakable: boolean
  /** The tool-call route case that reaches it (null when not speakable). */
  toolName: string | null
  /** Who may speak it — the enforced authority, not an aspiration. */
  guard: string
  /** How the audit trail records the voice origin, relative to the click path. */
  auditParity: string
  /** Required when speakable:false — the concrete, technical reason. */
  notYetReason?: string
  /** Example phrasing for the "What can I say?" panel. */
  sayIt?: string
}

/** Shared audit-parity strings — the two idioms every voice call gets. */
const VOICE_RECEIPT =
  "agent_assistant_tool_calls row per call (input/output/success/latency, session-attributed to the speaking user)"
const BUS_RECEIPT = "manager-bus voice_action signal (lib/voice/voice-bus.ts)"

export const VOICE_COMMAND_COVERAGE: VoiceCommandCoverageRow[] = [
  // ── OFFERS — the deal-decision family ──────────────────────────────────────
  {
    command: "lib/kernel/transactions.acceptOfferConditionally",
    domain: "offers",
    speakable: true,
    toolName: "accept_offer",
    guard:
      "authority 'agent' (tool-registry role gate at the route) + the approvals-queue decision guard in lib/voice/deal-decision.ts: tenant match, agent self-scope (broker/broker_admin/admin/superadmin/team_lead override brokerage-wide), inbound-only (listing_id set), not a counter row, status pending/submitted",
    auditParity:
      `SAME kernel command the compliance-bridge click calls (acceptOfferConditionallyAction) — same transaction_compliance_log rows (incl. explicit HOLD on compliance failure) + canonical transaction bridge; voice origin: ${VOICE_RECEIPT} + ${BUS_RECEIPT}`,
    sayIt: "“Accept the Hendersons' offer” / “accept the offer on 44 Birch”",
  },
  {
    command: "lib/kernel/offers.acceptOffer",
    domain: "offers",
    speakable: false,
    toolName: null,
    guard: "click paths: offer-workspace action + approvals-queue 'of:' cascade (authenticated session)",
    auditParity: "click path emits OFFER_OS_ACCEPTED lifecycle_events with actor_user_id",
    notYetReason:
      "POLICY, no longer plumbing: the command now takes a client-param overload (round 36), but the spoken accept intentionally keeps landing in acceptOfferConditionally — the STRICTER canonical acceptance whose System-7.1B compliance gate is absolute and records an explicit HOLD. Wiring plain acceptOffer to voice would create a second, weaker spoken accept lane.",
  },
  {
    command: "lib/kernel/offers.rejectOffer",
    domain: "offers",
    speakable: true,
    toolName: "reject_offer",
    guard:
      "authority 'agent' (tool-registry role gate at the route) + the SAME mirrored approvals-queue decision guard as accept_offer in lib/voice/deal-decision.ts: tenant match, agent self-scope (broker/broker_admin/admin/superadmin/team_lead override), inbound-only, not a counter row, status pending/submitted; backend re-checks role for the run_team_command lane",
    auditParity:
      `SAME kernel command the offer-workspace click and the approvals-queue 'of:' reject cascade call (rejectOffer via the round-36 client-param overload) — same OFFER_OS_REJECTED lifecycle event, spoken reason in offers.notes like the cascade's reviewer notes, same negotiation outcome loop; voice origin: ${VOICE_RECEIPT} + ${BUS_RECEIPT}`,
    sayIt: "“Reject the Hendersons' offer — the earnest money is too low”",
  },
  {
    command: "lib/kernel/offers.issueCounterOffer",
    domain: "offers",
    speakable: true,
    toolName: "counter_offer",
    guard:
      "authority 'agent' + the same mirrored decision guard as reject_offer, PLUS an explicit spoken price is REQUIRED (the backend never invents terms — no price, no counter)",
    auditParity:
      `SAME kernel command the seller counter slide-over and approvals-queue cascadeCounterOffer call (issueCounterOffer via the client-param overload) — same counter row (parent_offer_id + round), same OFFER_OS_COUNTERED lifecycle event; voice origin: ${VOICE_RECEIPT} + ${BUS_RECEIPT}`,
    sayIt: "“Counter the Hendersons' offer at 462”",
  },
  {
    command: "lib/kernel/offers.withdrawOffer",
    domain: "offers",
    speakable: true,
    toolName: "withdraw_offer",
    guard:
      "authority 'agent' + tenant match + agent self-scope (same override roles) + still-open status (pending/submitted/countered) — equivalent-or-stricter than the click path (session RLS, no extra role rule); counters excluded from fuzzy matching so a chain row is never picked by guess",
    auditParity:
      `SAME kernel command the offer-workspace withdraw click calls (withdrawOffer via the client-param overload) — same OFFER_OS_WITHDRAWN lifecycle event, spoken reason in offers.notes; voice origin: ${VOICE_RECEIPT} + ${BUS_RECEIPT}`,
    sayIt: "“Withdraw the offer on 44 Birch”",
  },
  {
    command: "offers read — agent's pending/countered/submitted pipeline",
    domain: "offers",
    speakable: true,
    toolName: "get_pending_offers",
    guard: "any authenticated voice session (read-only, agent-scoped by session.agent_id)",
    auditParity: VOICE_RECEIPT,
    sayIt: "“What offers are pending?”",
  },

  // ── APPROVALS ──────────────────────────────────────────────────────────────
  {
    command: "lib/agents/agent-client-messages.approveClientMessage (via standup rail)",
    domain: "approvals",
    speakable: true,
    toolName: "standup_action",
    guard: "authority 'agent' (tool-registry); the backend approves AS the speaking agent through the same gate, consent re-checked; fire drills are never auto-resolved",
    auditParity: `same proposed→approved(by human)→sent audit chain as the dashboard approve button; voice origin: ${VOICE_RECEIPT}`,
    sayIt: "“Knock out number two”",
  },
  {
    command: "lib/documents/kernel-review-core.resolveDeadlineConflictCore / approveStageAdvanceCore",
    domain: "approvals",
    speakable: true,
    toolName: "kernel_resolve",
    guard: "authority 'agent'; autonomy-grant proposals REFUSE by voice (broker policy stays on the dashboard); stage advances run the same advanceStage engine with its compliance gates",
    auditParity: "same cores the Command Center feed buttons call; every resolution lands in policy_decisions; voice origin: " + VOICE_RECEIPT,
    sayIt: "“Approve number one” / “decline number two”",
  },
  {
    command: "lib/documents/kernel-review-core.listOpenKernelProposals",
    domain: "approvals",
    speakable: true,
    toolName: "kernel_proposals",
    guard: "authority 'agent' (read-only)",
    auditParity: VOICE_RECEIPT,
    sayIt: "“Anything waiting on me?”",
  },
  {
    command: "lib/kernel/approval-queue-aggregator.cascadeApprove / cascadeReject",
    domain: "approvals",
    speakable: false,
    toolName: null,
    guard: "click path: /api/approvals/approve|reject (requireAuth; agents scoped to own items, brokers brokerage-wide)",
    auditParity: "click path updates each source table's approval_status with reviewer attribution",
    notYetReason:
      "The session-client wall is GONE (round 36): every decision the cascade's offer lane performs is now individually speakable through the deal-decision lane (accept_offer / reject_offer / counter_offer ride the same kernel commands the cascade calls), and marketing-content approvals ride standup_action's rail. What remains unspoken is only the cascade WRAPPER itself — a queue-UI convenience with no distinct transition of its own; wiring a second spoken path to the same kernel commands would add surface without adding capability (and the aggregator file is owned outside this bridge).",
  },

  // ── CONTACTS ───────────────────────────────────────────────────────────────
  {
    command: "contacts search (brokerage-scoped)",
    domain: "contacts",
    speakable: true,
    toolName: "lookup_contact",
    guard: "any authenticated voice session (read-only, brokerage-anchored)",
    auditParity: VOICE_RECEIPT,
    sayIt: "“Look up the Hendersons”",
  },
  {
    command: "app/actions/listing-lifecycle-core.getListingCurrentStage",
    domain: "reporting",
    speakable: true,
    toolName: "query_listing_status",
    guard: "authority 'agent' (tool-registry) + entity_owner gate at the route: the session's brokerage must own the listing before the read (ports Stack A validateListingAccess into the canonical dispatcher)",
    auditParity: VOICE_RECEIPT,
    sayIt: "“What stage is 44 Birch at?”",
  },
  {
    command: "app/actions/buyer-execution.getBuyerJourney",
    domain: "reporting",
    speakable: true,
    toolName: "query_buyer_stage",
    guard: "authority 'agent' (tool-registry) + entity_owner gate at the route: the session's brokerage must own the contact before the read",
    auditParity: VOICE_RECEIPT,
    sayIt: "“Where are the Hendersons in their buyer journey?”",
  },
  {
    command: "contact detail read (profile + recent activities)",
    domain: "contacts",
    speakable: true,
    toolName: "get_contact_details",
    guard: "any authenticated voice session (read-only, brokerage-anchored)",
    auditParity: VOICE_RECEIPT,
  },
  {
    command: "activities insert + contacts.last_contacted_at bump (the contact note / call log)",
    domain: "contacts",
    speakable: true,
    toolName: "log_activity",
    guard: "authority 'agent_or_isa' (tool-registry role gate); contact must be in the session's brokerage",
    auditParity: `same activities row shape as the CRM log button; voice origin: ${VOICE_RECEIPT} + ${BUS_RECEIPT}`,
    sayIt: "“Log a call with Maria — she wants to see 44 Birch this weekend”",
  },
  {
    command: "contacts.status update",
    domain: "contacts",
    speakable: true,
    toolName: "update_contact_status",
    guard: "any authenticated voice session; write is brokerage-anchored (service_role manual tenant check)",
    auditParity: VOICE_RECEIPT,
    sayIt: "“Mark Bob as cold”",
  },
  {
    command: "app/actions/contact-reassignment.reassignContactAction",
    domain: "contacts",
    speakable: true,
    toolName: "reassign_contact",
    guard:
      "authority 'admin' (tool-registry role gate at the route) + the voice backend (lib/voice/broker-commands.ts) re-checks manager-roles-or-tenancy-principal from the DB, AND the canonical action re-runs requireReassignAuthority through the injected client (round-36 sessionless-caller overload) — double-gated, equivalent to the click path",
    auditParity:
      `SAME canonical action as the CRM click (reassignContactAction) — same per-entity move set (contact, leads, in-flight deal roles, open tasks, active alerts), same CONTACT_REASSIGNED lifecycle_events audit, same in-app notification to the receiving agent; voice origin: ${VOICE_RECEIPT} + ${BUS_RECEIPT}`,
    sayIt: "“Reassign Maria Lopez to Bob Chen”",
  },

  // ── LEADS ──────────────────────────────────────────────────────────────────
  // Round-37 correction: raw→lead promotion is NOT speakable (and has no manual
  // door anywhere) — raw leads move only via the automatic pipeline. The lead
  // verb that remains speakable is converting an already-QUALIFIED lead.
  {
    command: "lib/lead-assignment/assignment-engine.evaluateAndAssignLead (Engine 2 — qualified lead → contact)",
    domain: "leads",
    speakable: true,
    toolName: "convert_lead",
    guard:
      "authority 'admin' (round-33 LEADS POLICY: brokerage principals + platform only — NEVER agent-speakable) + the voice backend re-checks the lead-desk role set from the DB, AND Engine 2's server-side gate REFUSES any lead that is not lead_stage='qualified' + consented (owner round 37: leads convert once qualified — an unqualified lead can never be converted by voice)",
    auditParity:
      `SAME canonical lane as the AI ISA's qualification hook (evaluateAndAssignLead → handleLeadAssigned → createContactFromLead) — same assignment_log + lifecycle_events audit, same admin assignment_rules policy, same in-app agent notification; voice origin: ${VOICE_RECEIPT} + ${BUS_RECEIPT}`,
    sayIt: "“Convert the lead for John Smith” (broker roles only; refused unless the AI ISA qualified them)",
  },

  // ── FINANCIAL (vendor/lender lane) ──────────────────────────────────────────
  // The FIRST cross-party voice tool: a lender is a vendor-USER role, not a
  // contact, and reaches a buyer only through an active vendor_contact_assignment.
  {
    command: "app/actions/buyer-execution.lenderConfirmBuyerFinancials → lib/buyer-execution/multi-party-updates.lenderConfirmFinancialVerification",
    domain: "financial",
    speakable: true,
    toolName: "lender_confirm_financials",
    guard:
      "authority 'vendor' (tool-registry role gate at the route — lender/vendor user_type only, never staff) + the assigned_party gate INSIDE the executor (assertVendorAssignedToContact): resolves user_role_assignments.vendor_id and requires an ACTIVE, unexpired vendor_contact_assignment to THIS contact with 'financial' scope, plus the whole-vendor time box (vendors.access_expires_at) — fails closed; the dispatcher also requires an explicit spoken confirm before the state change (human-in-the-loop)",
    auditParity:
      `SAME executor as the lender portal action (lenderConfirmFinancialVerification) — same emitFinancialVerificationEvent + buyer.financial.lender_confirmed activity with actor_role='lender'; voice origin: ${VOICE_RECEIPT}`,
    sayIt: "“Confirm the Hendersons' pre-approval for 480k” (lender/vendor users assigned to that buyer)",
  },
  {
    command: "app/actions/buyer-lifecycle-core.getBuyerFinancialStatus",
    domain: "financial",
    speakable: true,
    toolName: "get_buyer_financials",
    guard:
      "authority 'financial_staff' (tool-registry role gate at the route — agent/broker/broker_admin/admin/superadmin/compliance_officer/tc) + entity_owner gate at the route: the session's brokerage must own the contact before the read",
    auditParity: VOICE_RECEIPT,
    sayIt: "“Is the Hendersons' financing verified?”",
  },
  {
    command: "app/actions/buyer-lifecycle-core.recordBuyerFinancialVerification",
    domain: "financial",
    speakable: true,
    toolName: "confirm_buyer_financials",
    guard:
      "authority 'financial_staff' (tool-registry role gate at the route — the brokerage's own staff, NOT an assigned lender) + entity_owner gate at the route (the contact must belong to your brokerage); flips the financing gate, so the dispatcher requires an explicit spoken confirm first (human-in-the-loop)",
    auditParity:
      `SAME core the agent/dashboard confirm calls (recordBuyerFinancialVerification → emitFinancialVerificationEvent, verifiedBy 'agent', source 'manual'); voice origin: ${VOICE_RECEIPT}`,
    sayIt: "“Mark the Hendersons pre-approved for 480k from the pre-approval letter”",
  },

  // ── TASKS ──────────────────────────────────────────────────────────────────
  {
    command: "tasks insert (assigned_to_agent_id/created_by_agent_id = agents.id)",
    domain: "tasks",
    speakable: true,
    toolName: "create_task",
    guard: "authority 'agent_or_isa'; requires an agents profile on the session (FK to agents.id)",
    auditParity: `same tasks row shape as the dashboard create; voice origin: ${VOICE_RECEIPT} + ${BUS_RECEIPT}`,
    sayIt: "“Remind me to call the lender Friday”",
  },

  // ── SHOWINGS ───────────────────────────────────────────────────────────────
  {
    command: "app/actions/showings.requestShowing (BBA-gated showing request)",
    domain: "showings",
    speakable: true,
    toolName: "stage_showing",
    guard:
      "authority 'agent' + contact ownership in the voice backend (assigned agent or broker/broker_admin/admin/superadmin/team_lead — the same requireContactOwnership rule as every NAR artifact) + the NAR-2024 BBA gate INSIDE requestShowing (requireActiveBBA, fails closed — a block is spoken back honestly); spoken dates/times resolve conservatively or the backend asks instead of guessing",
    auditParity:
      `SAME canonical action as the buyer portal and agent dashboard (requestShowing via the round-36 sessionless-caller overload) — same showing_requests insert with source='agent_input', same agent/listing-agent/seller notification chain, same client_portal_activity log; voice origin: ${VOICE_RECEIPT} + ${BUS_RECEIPT}`,
    sayIt: "“Schedule a showing for Maria at 44 Birch on Saturday at 2”",
  },
  {
    command: "showings/activities read — today's schedule",
    domain: "scheduling",
    speakable: true,
    toolName: "get_today_schedule",
    guard: "any authenticated voice session (read-only, agent-scoped)",
    auditParity: VOICE_RECEIPT,
    sayIt: "“What's on my schedule today?”",
  },
  {
    command: "lib/wizard-staging/content-staging.stageOpenHouse",
    domain: "scheduling",
    speakable: true,
    toolName: "stage_open_house",
    guard: "any authenticated voice session; staging only — publish/invites stay on their own gates",
    auditParity: `same canonical staging path as the open-house wizard; voice origin: ${VOICE_RECEIPT}`,
    sayIt: "“Schedule an open house for 44 Birch Saturday 1 to 3”",
  },

  // ── MESSAGING ──────────────────────────────────────────────────────────────
  {
    command: "client_portal_messages insert behind kernel evaluateOutbound",
    domain: "messaging",
    speakable: true,
    toolName: "send_portal_message",
    guard: "authority 'agent_or_isa'; DNC + call_stop hard blocks; kernel evaluateOutbound (brand voice + Them-First + fair housing) FAILS CLOSED",
    auditParity: `same compliance evaluation + message row as the portal composer; voice origin: ${VOICE_RECEIPT} + ${BUS_RECEIPT}`,
    sayIt: "“Send Maria a portal message that the inspection moved to Tuesday”",
  },
  {
    command: "lib/kernel/voice-delegation.voiceFollowUp (propose→approve as the agent)",
    domain: "messaging",
    speakable: true,
    toolName: "voice_followup",
    guard: "authority 'agent_or_isa'; evaluate_outbound gate; consent re-checked at approval; nothing sends unapproved",
    auditParity: "full proposed→approved(by the speaking agent)→sent audit chain, same as the dashboard rail; voice origin: " + VOICE_RECEIPT,
    sayIt: "“Follow up with the Hendersons saying I'll call tomorrow”",
  },
  {
    command: "portal message read (recent threads)",
    domain: "messaging",
    speakable: true,
    toolName: "get_recent_messages",
    guard: "any authenticated voice session (read-only, agent-scoped)",
    auditParity: VOICE_RECEIPT,
  },

  // ── BROADCAST ──────────────────────────────────────────────────────────────
  {
    command: "app/actions/communications.notifyBrokerageAgentsAction",
    domain: "broadcast",
    speakable: true,
    toolName: "broadcast_announcement",
    guard:
      "authority 'admin' + tenancy-principal check in the voice backend (isTenancyPrincipal against the DB — the voice session carries the caller's users.id), AND the canonical action re-runs the same principal gate through the injected client (round-36 overload); team leads are always forced to their own team by the action",
    auditParity:
      `SAME canonical action as the composer (notifyBrokerageAgentsAction) — IN-APP ONLY by construction (notifications rows, channel 'in_app'; never email/SMS — no egress), same team_announcement_posted lifecycle_events ledger with honest counters; voice origin: ${VOICE_RECEIPT} + ${BUS_RECEIPT}`,
    sayIt: "“Announce to the team: the office closes at noon Friday”",
  },

  // ── DEAL DOCUMENTS (offer/BBA/listing packets + e-sign) ───────────────────
  {
    command: "voice intake → fillOfferPacket → documents+offers insert (offer staging)",
    domain: "deal-documents",
    speakable: true,
    toolName: "stage_offer_packet",
    guard: "authority 'agent'; requireContactOwnership (assigned agent or broker/admin); BBA dependency tracked (requires_bba_first) — dispatch hard-gated until BBA signed",
    auditParity: `documents.metadata.source='voice_intake_elevenlabs' (the existing voice-origin field) + ${VOICE_RECEIPT}`,
    sayIt: "“Stage an offer for the Hendersons on 44 Birch at 450”",
  },
  {
    command: "voice intake → buyer_broker_agreements draft insert (BBA staging)",
    domain: "deal-documents",
    speakable: true,
    toolName: "stage_bba_packet",
    guard: "authority 'agent'; requireContactOwnership; commission terms required unless showing_only",
    auditParity: `draft row with created_by = speaking user + ${VOICE_RECEIPT}`,
    sayIt: "“Stage a BBA for Jane — exclusive, two and a half percent, seller pays”",
  },
  {
    command: "voice intake → fillListingPacket → documents insert (listing staging)",
    domain: "deal-documents",
    speakable: true,
    toolName: "stage_listing_packet",
    guard: "authority 'agent'; requireContactOwnership on the seller contact",
    auditParity: `documents.metadata.source='voice_intake_elevenlabs' + ${VOICE_RECEIPT}`,
    sayIt: "“Stage a listing agreement for the Garcias at 12 Oak”",
  },
  {
    command: "staged-packet fill status read",
    domain: "deal-documents",
    speakable: true,
    toolName: "read_form_status",
    guard: "authority 'agent'; requireContactOwnership when contact-linked",
    auditParity: VOICE_RECEIPT,
  },
  {
    command: "next required-unfilled field read",
    domain: "deal-documents",
    speakable: true,
    toolName: "next_unfilled_field",
    guard: "authority 'agent'; requireContactOwnership when contact-linked",
    auditParity: VOICE_RECEIPT,
  },
  {
    command: "single-field fill on a staged packet (re-runs the form-fill engine)",
    domain: "deal-documents",
    speakable: true,
    toolName: "fill_form_field",
    guard: "authority 'agent'; requireContactOwnership; refuses once pending_signature/signed/cancelled",
    auditParity: `intake note records 'agent confirmed via voice' per field + ${VOICE_RECEIPT}`,
    sayIt: "“Default” (while walking unfilled fields)",
  },
  {
    command: "e-sign dispatch of staged BBA + offer as one envelope",
    domain: "deal-documents",
    speakable: true,
    toolName: "dispatch_transaction_packet",
    guard: "authority 'agent'; requireContactOwnership; BBA hard gate in the handler; provider resolved per actor (user > brokerage scope)",
    auditParity: `same provider envelope + documents/offers esign status writes as the review-page send; voice origin: ${VOICE_RECEIPT}`,
    sayIt: "“Send Jane's offer for signature”",
  },

  // ── MARKETING CONTENT (staging only — publish gates untouched) ────────────
  {
    command: "lib/wizard-staging/content-staging.stageNewsletterDraft",
    domain: "marketing-content",
    speakable: true,
    toolName: "stage_newsletter_draft",
    guard: "authority 'tenant_staff' (tool-registry role gate at the route); draft only — stages at pending_review, the approval pipeline runs the outbound gates before anything ships — approval/publish gates unchanged",
    auditParity: VOICE_RECEIPT,
    sayIt: "“Create a newsletter about spring inventory”",
  },
  {
    command: "lib/wizard-staging/content-staging.stageEmailCampaign",
    domain: "marketing-content",
    speakable: true,
    toolName: "stage_email_campaign",
    guard: "authority 'tenant_staff' (tool-registry role gate at the route); draft only — stages at pending_review, the approval pipeline runs the outbound gates before anything ships",
    auditParity: VOICE_RECEIPT,
  },
  {
    command: "lib/wizard-staging/content-staging.stageBlogDraft",
    domain: "marketing-content",
    speakable: true,
    toolName: "stage_blog_draft",
    guard: "authority 'tenant_staff' (tool-registry role gate at the route); draft only — stages at pending_review, the approval pipeline runs the outbound gates before anything ships",
    auditParity: VOICE_RECEIPT,
  },
  {
    command: "lib/wizard-staging/content-staging.stagePodcastEpisode",
    domain: "marketing-content",
    speakable: true,
    toolName: "stage_podcast_episode",
    guard: "authority 'tenant_staff' (tool-registry role gate at the route); draft only — stages at pending_review, the approval pipeline runs the outbound gates before anything ships",
    auditParity: VOICE_RECEIPT,
  },
  {
    command: "lib/wizard-staging/content-staging.stageVideoProject",
    domain: "marketing-content",
    speakable: true,
    toolName: "stage_video_project",
    guard: "authority 'tenant_staff' (tool-registry role gate at the route); draft only — stages at pending_review, the approval pipeline runs the outbound gates before anything ships",
    auditParity: VOICE_RECEIPT,
  },
  {
    command: "canonical createDirectMailCampaign via staging wrapper",
    domain: "marketing-content",
    speakable: true,
    toolName: "stage_direct_mail_campaign",
    guard: "any authenticated voice session; feature gate + QR tracking inside the canonical creator",
    auditParity: VOICE_RECEIPT,
  },
  {
    command: "canonical createAdCampaign via staging wrapper",
    domain: "marketing-content",
    speakable: true,
    toolName: "stage_ad_campaign",
    guard: "any authenticated voice session; feature gate + lifecycle event inside the canonical creator; launch stays on the ads dashboard",
    auditParity: VOICE_RECEIPT,
  },
  {
    command: "lib/kernel/voice-delegation.voiceCutPromo (Remotion/D-ID/ElevenLabs rail)",
    domain: "marketing-content",
    speakable: true,
    toolName: "cut_promo",
    guard: "authority 'agent'; Fair-Housing pre-flight + cooldown debounce in the rail; social drafts human-approved",
    auditParity: "same canonical promo rail as the listing button; voice origin: " + VOICE_RECEIPT,
    sayIt: "“Cut a promo reel for 44 Birch”",
  },
  {
    command: "lib/kernel/voice-delegation.voiceStartMarketing (sequence enrollment)",
    domain: "marketing-content",
    speakable: true,
    toolName: "start_marketing",
    guard: "authority 'agent_or_isa'; each sequence step clears its own compliance gate before sending",
    auditParity: "same enrollment rows as the campaign UI; voice origin: " + VOICE_RECEIPT,
    sayIt: "“Start marketing for the Hendersons”",
  },

  // ── TEAM COORDINATION + REPORTING ──────────────────────────────────────────
  {
    command: "free-text bridge → parseTeamCommandText → dispatchTeamCommand (shared with the text command bar)",
    domain: "team-coordination",
    speakable: true,
    toolName: "run_team_command",
    guard: "per-command guards apply downstream (each backend enforces its own gate); deterministic parser — ambiguous text asks for a rephrase instead of mis-routing",
    auditParity: `${VOICE_RECEIPT} + ${BUS_RECEIPT} for the routed command`,
    sayIt: "“What should I do today?”",
  },
  {
    command: "lib/kernel/team-query.runTeamQuery",
    domain: "team-coordination",
    speakable: true,
    toolName: "team_query",
    guard: "authority 'agent_or_isa' (read-only)",
    auditParity: VOICE_RECEIPT,
    sayIt: "“What do you know about the Garcias?”",
  },
  {
    command: "lib/kernel/area-query.runAreaQuery",
    domain: "team-coordination",
    speakable: true,
    toolName: "area_query",
    guard: "authority 'agent_or_isa' (read-only)",
    auditParity: VOICE_RECEIPT,
    sayIt: "“Anything happening near 44 Birch?”",
  },
  {
    command: "lib/kernel/morning-standup.runMorningStandup",
    domain: "team-coordination",
    speakable: true,
    toolName: "morning_standup",
    guard: "authority 'agent' (read-only)",
    auditParity: VOICE_RECEIPT,
    sayIt: "“What's on my plate?”",
  },
  {
    command: "lib/education/agent-guide.answerAgentQuestion",
    domain: "team-coordination",
    speakable: true,
    toolName: "ask_guidance",
    guard: "authority 'agent_or_isa'; answers ONLY from the published curriculum; gaps logged",
    auditParity: VOICE_RECEIPT,
    sayIt: "“How do I set up my voice twin?”",
  },
  {
    command: "lib/buyer-search.searchPropertiesCore (NL buyer match)",
    domain: "team-coordination",
    speakable: true,
    toolName: "find_properties",
    guard: "authority 'agent_or_isa'; Fair-Housing-sanitized explanations; external results display-only",
    auditParity: VOICE_RECEIPT,
    sayIt: "“Find the Hendersons a 3-bed under 500k in Austin”",
  },
  {
    command: "lib/agent-action-queue/composer.composeAgentActionQueue (morning briefing)",
    domain: "reporting",
    speakable: true,
    toolName: "get_morning_briefing",
    guard: "authority 'agent' (read-only)",
    auditParity: VOICE_RECEIPT,
    sayIt: "(spoken automatically at session start)",
  },
  {
    command: "listings read — active + coming_soon",
    domain: "reporting",
    speakable: true,
    toolName: "get_active_listings",
    guard: "any authenticated voice session (read-only, agent-scoped)",
    auditParity: VOICE_RECEIPT,
    sayIt: "“What listings do I have live?”",
  },
  {
    command: "transactions read — under contract through closing prep",
    domain: "reporting",
    speakable: true,
    toolName: "get_transactions_in_progress",
    guard: "any authenticated voice session (read-only, agent-scoped)",
    auditParity: VOICE_RECEIPT,
    sayIt: "“What's under contract?”",
  },
  // ── Round 36 phantom closure — the five declared-but-undispatched registry
  //    rows now dispatch to their CANONICAL homes (stage_showing rides the
  //    requestShowing row above). Zero phantom rows remain — pinned both
  //    directions by scripts/voice-command-coverage-simulator.ts. ──
  {
    command: "lib/intelligence/steer-my-day-runner.getSteerMyDay (who needs you first)",
    domain: "reporting",
    speakable: true,
    toolName: "whos_slipping",
    guard: "authority 'agent_or_isa' (read-only); agent-scoped via the session's agents.id; brokerage-anchored reads",
    auditParity: `same fused lead-warmth + lifetime-health work queue the dashboard digest reads, spoken via the existing pure formatter (lib/voice/voice-report-format.spokenSteerDay); ${VOICE_RECEIPT}`,
    sayIt: "“Who's slipping?”",
  },
  {
    command: "lib/intelligence/decision-receipts-runner.getContactDecisionReceipts (the why trail)",
    domain: "reporting",
    speakable: true,
    toolName: "explain_touches",
    guard: "authority 'agent_or_isa' (read-only); contact must be in the session's brokerage; ambiguous names refuse with a count instead of guessing",
    auditParity: `same decision-receipts trail the glass-box report reads (every send, every skip/block WITH its reason, opens/replies), spoken via spokenReceipts; ${VOICE_RECEIPT}`,
    sayIt: "“Why did the Hendersons get that?”",
  },
  {
    command: "Income Truth engine read — income_forecast_gap_analysis + open recommended actions",
    domain: "reporting",
    speakable: true,
    toolName: "get_income_truth",
    guard: "authority 'agent' (read-only); agent self-scope via the session's agents.id — the SAME scope getLatestGapAction resolves from the cookie session",
    auditParity: `same persisted snapshot + income_gap_recommended_actions rows the Income Truth dashboard reads; ${VOICE_RECEIPT}`,
    sayIt: "“How am I tracking against my income goal?”",
  },
  {
    command: "lib/voice/studio-session.voiceStudioSession (gated content-calendar batch)",
    domain: "marketing-content",
    speakable: true,
    toolName: "book_studio_session",
    guard: "authority 'agent'; every reel routes through the Video Director's commissionVideo — its Fair-Housing/compliance gate runs PER REEL and everything lands at pending_review (nothing auto-publishes); idempotent per session key",
    auditParity: `studio_sessions anchor row + ai_video_projects.studio_session_id links per reel — same rails as the Content Studio; ${VOICE_RECEIPT}`,
    sayIt: "“Book me a week of content”",
  },
]

// ─── Derived views (the panel + simulator consume these — no hardcoded counts) ──

export interface VoiceCoverageDomainStats {
  domain: VoiceCoverageDomain
  speakable: number
  notYet: number
  rows: VoiceCommandCoverageRow[]
}

/** Group rows by domain, preserving declaration order of domains. */
export function coverageByDomain(): VoiceCoverageDomainStats[] {
  const order: VoiceCoverageDomain[] = []
  const byDomain = new Map<VoiceCoverageDomain, VoiceCommandCoverageRow[]>()
  for (const row of VOICE_COMMAND_COVERAGE) {
    if (!byDomain.has(row.domain)) { byDomain.set(row.domain, []); order.push(row.domain) }
    byDomain.get(row.domain)!.push(row)
  }
  return order.map((domain) => {
    const rows = byDomain.get(domain)!
    return {
      domain,
      speakable: rows.filter((r) => r.speakable).length,
      notYet: rows.filter((r) => !r.speakable).length,
      rows,
    }
  })
}

/** Overall stats — derived, never hardcoded. */
export function coverageStats(): { total: number; speakable: number; notYet: number } {
  const total = VOICE_COMMAND_COVERAGE.length
  const speakable = VOICE_COMMAND_COVERAGE.filter((r) => r.speakable).length
  return { total, speakable, notYet: total - speakable }
}

/** All toolNames the map claims are dispatchable (for the simulator's route parity check). */
export function speakableToolNames(): string[] {
  return Array.from(
    new Set(
      VOICE_COMMAND_COVERAGE.filter((r) => r.speakable && r.toolName).map((r) => r.toolName as string),
    ),
  )
}
