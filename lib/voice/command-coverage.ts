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
// Why some canonical commands are NOT speakable (the recurring reason):
//   The conv-ai tool webhook is SESSIONLESS by design (ElevenLabs POSTs with a
//   shared tool secret; there is no user auth cookie). Kernel commands built
//   on the auth-cookie Supabase client (lib/supabase/server createClient) run
//   as `anon` there, and the live RLS on offers/showing_requests/... is
//   tenant-scoped `authenticated`-only — the command would always return
//   "not found". Closing those gaps honestly requires the kernel command to
//   accept an injected client (like approveClientMessage / dispatchTeamCommand
//   already do) — a change owned by the kernel files, not this bridge.

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
      "Runs on the auth-cookie client (createClient) — sessionless webhook executes as anon and live RLS on offers is authenticated-only. The spoken accept lands in acceptOfferConditionally instead (the stricter, compliance-gated canonical acceptance).",
  },
  {
    command: "lib/kernel/offers.rejectOffer",
    domain: "offers",
    speakable: false,
    toolName: null,
    guard: "click paths: offer-workspace action + approvals-queue 'of:' cascade (authenticated session)",
    auditParity: "click path emits OFFER_OS_REJECTED lifecycle_events; notes carry the reason",
    notYetReason:
      "Session-client-bound (createClient + offers RLS authenticated-only) — cannot execute from the sessionless conv-ai webhook without forking the transition; needs a client-param overload of the kernel command (owned by lib/kernel/offers.ts, off-limits this round).",
  },
  {
    command: "lib/kernel/offers.issueCounterOffer",
    domain: "offers",
    speakable: false,
    toolName: null,
    guard: "click paths: seller counter slide-over + approvals-queue cascadeCounterOffer (authenticated session)",
    auditParity: "click path emits OFFER_OS_COUNTERED lifecycle_events; counter row carries parent_offer_id + round",
    notYetReason:
      "Session-client-bound (createClient select + insert under offers RLS) — same reason as rejectOffer; not executable from the sessionless webhook without forking.",
  },
  {
    command: "lib/kernel/offers.withdrawOffer",
    domain: "offers",
    speakable: false,
    toolName: null,
    guard: "click path: offer-workspace withdraw action (authenticated session)",
    auditParity: "click path emits OFFER_OS_WITHDRAWN lifecycle_events",
    notYetReason: "Session-client-bound — same reason as rejectOffer.",
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
      "No conv-ai tool reaches the unified queue cascade yet, and its offer lane ('of:') delegates to the session-client-bound kernel offer commands — the same wall as rejectOffer. Marketing-content approvals by voice ride standup_action's rail today.",
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
    speakable: false,
    toolName: null,
    guard: "click path: requireReassignAuthority (broker/admin session)",
    auditParity: "click path moves contact + open work with tenancy checks and activity trail",
    notYetReason:
      "Auth-cookie-gated server action (requireReassignAuthority reads the session) — not executable from the sessionless webhook; needs a client/actor-param core extracted from the action.",
  },

  // ── LEADS ──────────────────────────────────────────────────────────────────
  {
    command: "app/actions/lead-promotion/promote-lead.promoteLead",
    domain: "leads",
    speakable: false,
    toolName: null,
    guard: "click path: authenticated session (createClient getUser) + brokerage checks",
    auditParity: "click path writes the promotion trail on leads/contacts",
    notYetReason:
      "Session-gated server action (auth.getUser on the cookie client) — the sessionless webhook cannot authenticate as the speaking user; needs an actor-param service core.",
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
    speakable: false,
    toolName: null,
    guard: "click path: authenticated session; requireActiveBBA (NAR 2024) inside the action",
    auditParity: "click path inserts showing_requests with source attribution ('agent_input'/'buyer_portal')",
    notYetReason:
      "Canonical requestShowing runs on the auth-cookie client and showing_requests RLS is tenant/authenticated-only — not executable from the sessionless webhook without forking the insert + notification chain. The tool-registry's stage_showing row is declared but has never had a dispatcher (phantom row — kept non-speakable here on purpose).",
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
    speakable: false,
    toolName: null,
    guard: "click path: tenancy-principal only (isTenancyPrincipal on the authenticated session)",
    auditParity: "click path fans out in-app notifications with principal attribution",
    notYetReason:
      "Principal gate resolves the caller from the auth cookie (getAgentContext) — sessionless webhook cannot satisfy it; needs an actor-param core before a broadcast can be spoken.",
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
    guard: "any authenticated voice session; draft only — approval/publish gates unchanged",
    auditParity: VOICE_RECEIPT,
    sayIt: "“Create a newsletter about spring inventory”",
  },
  {
    command: "lib/wizard-staging/content-staging.stageEmailCampaign",
    domain: "marketing-content",
    speakable: true,
    toolName: "stage_email_campaign",
    guard: "any authenticated voice session; draft only",
    auditParity: VOICE_RECEIPT,
  },
  {
    command: "lib/wizard-staging/content-staging.stageBlogDraft",
    domain: "marketing-content",
    speakable: true,
    toolName: "stage_blog_draft",
    guard: "any authenticated voice session; draft only",
    auditParity: VOICE_RECEIPT,
  },
  {
    command: "lib/wizard-staging/content-staging.stagePodcastEpisode",
    domain: "marketing-content",
    speakable: true,
    toolName: "stage_podcast_episode",
    guard: "any authenticated voice session; draft only",
    auditParity: VOICE_RECEIPT,
  },
  {
    command: "lib/wizard-staging/content-staging.stageVideoProject",
    domain: "marketing-content",
    speakable: true,
    toolName: "stage_video_project",
    guard: "any authenticated voice session; draft only",
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
  {
    command: "tool-registry rows with no dispatcher: get_income_truth, whos_slipping, explain_touches, book_studio_session, stage_showing",
    domain: "reporting",
    speakable: false,
    toolName: null,
    guard: "declared in lib/voice/tool-registry.ts only",
    auditParity: "n/a — never dispatched",
    notYetReason:
      "Declared in the tool registry but no dispatch surface implements them (phantom rows found by this coverage audit) — the tool-call route throws 'Unknown tool' for all five. Kept non-speakable until a real handler exists.",
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
