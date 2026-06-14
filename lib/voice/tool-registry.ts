/**
 * Voice tool registry — single source of truth for which tools the voice
 * cockpit (ElevenLabs Conv AI + browser STT in internal-ai-assistant.tsx)
 * can invoke, what authority each requires, and which compliance gates
 * MUST fire before dispatch.
 *
 * Why this file exists:
 *   - Audit found tools hardcoded across /api/agent-assistant/tool-call,
 *     handle-voice-command.ts, voice-assistant-panel.tsx, and ElevenLabs
 *     Conv AI registration. Adding a 7th tool requires touching all 4
 *     surfaces and remembering every gate. That's a future-bug factory.
 *   - This registry collapses all four into one declarative table. Each
 *     dispatch path imports `voiceTools` and reads the gates it needs
 *     to enforce. Adding a tool = one row here + one dispatch function.
 *
 * The registry is purely declarative — no functions, no side effects.
 * Dispatchers (route handlers) read the metadata and apply the gates.
 */

export type ComplianceGate =
  | "active_bba"        // requireActiveBBA — NAR 2024 Buyer Broker Agreement
  | "tcpa_outbound"     // enforceTCPACompliance — DNC + consent + quiet hours + RND
  | "evaluate_outbound" // kernel evaluateOutbound — brand voice + Them-First + fair housing
  | "ai_fair_use"       // checkAIFairUse — per-tenant token quota (already wired in generateAIResponse)
  | "dnc_check"         // Direct DNC check (subset of TCPA — used for non-phone channels)
  | "service_role"      // Action runs with service client and skips RLS — must validate brokerage_id manually

export type ToolAuthority =
  | "agent"             // The acting agent only — strictest scope
  | "agent_or_isa"      // Agent or assigned ISA may act
  | "tenant_staff"      // Any agent/admin/team_lead in the brokerage
  | "admin"             // Broker / broker_admin / admin / superadmin
  | "any_authenticated" // Read-only utilities (lookup_contact, get_schedule)

export interface VoiceTool {
  name: string
  category: "lookup" | "draft" | "send" | "schedule" | "stage" | "report"
  authority: ToolAuthority
  /** Gates that MUST fire BEFORE the tool dispatches. Order matters — first failure short-circuits. */
  gates: ComplianceGate[]
  /** When true, the tool writes outbound content visible to a CRM contact. */
  is_outbound: boolean
  /** When true, the tool can initiate a phone/SMS via Twilio/VAPI/Telnyx. */
  is_telco_initiating: boolean
  /** When true, the tool stages or submits a NAR-regulated artifact (offer / BBA / showing). */
  is_nar_regulated: boolean
  /** Human-readable summary for ops / docs. */
  description: string
}

/**
 * Canonical registry. Add new voice tools HERE first; the dispatchers
 * read this declaration to know which gates to enforce.
 */
export const voiceTools: Record<string, VoiceTool> = {
  // ── Lookups (read-only, no gates beyond auth) ─────────────────────────────
  lookup_contact: {
    name: "lookup_contact",
    category: "lookup",
    authority: "any_authenticated",
    gates: [],
    is_outbound: false,
    is_telco_initiating: false,
    is_nar_regulated: false,
    description: "Search contacts by name / email / phone within the brokerage.",
  },
  get_today_schedule: {
    name: "get_today_schedule",
    category: "lookup",
    authority: "any_authenticated",
    gates: [],
    is_outbound: false,
    is_telco_initiating: false,
    is_nar_regulated: false,
    description: "Return today's calendar events + appointments for the agent.",
  },
  get_active_listings: {
    name: "get_active_listings",
    category: "lookup",
    authority: "any_authenticated",
    gates: [],
    is_outbound: false,
    is_telco_initiating: false,
    is_nar_regulated: false,
    description: "List active + coming_soon listings owned by the agent.",
  },
  get_pending_offers: {
    name: "get_pending_offers",
    category: "lookup",
    authority: "any_authenticated",
    gates: [],
    is_outbound: false,
    is_telco_initiating: false,
    is_nar_regulated: false,
    description: "List pending / countered / submitted offers owned by the agent.",
  },
  get_transactions_in_progress: {
    name: "get_transactions_in_progress",
    category: "report",
    authority: "any_authenticated",
    gates: [],
    is_outbound: false,
    is_telco_initiating: false,
    is_nar_regulated: false,
    description: "List active transactions with stage + estimated close date.",
  },

  // ── Send (outbound — content gates required) ──────────────────────────────
  send_portal_message: {
    name: "send_portal_message",
    category: "send",
    authority: "agent_or_isa",
    gates: ["evaluate_outbound"],
    is_outbound: true,
    is_telco_initiating: false,
    is_nar_regulated: false,
    description: "Send a portal message to a contact. Runs brand voice + Them-First + fair housing.",
  },

  // ── Stage (NAR-regulated artifacts — BBA gate where required) ────────────
  // These are contract-drafting tools tied to a CRM contact. They are NOT
  // subject to ai_fair_use (a brokerage-level token-quota guard); the kernel
  // BBA gate is the only thing that should block contract drafting.
  stage_offer_packet: {
    name: "stage_offer_packet",
    category: "stage",
    authority: "agent",
    gates: [],  // Soft-checked inside the handler. Offer DRAFTING is permitted
                // without an active BBA so the agent doesn't have to redo the
                // call; the document carries requires_bba_first metadata.
                // Submit-for-signature (Commit L) is the HARD gate that
                // refuses dispatch until BBA is signed.
    is_outbound: false,
    is_telco_initiating: false,
    is_nar_regulated: true,
    description: "Stage a filled offer packet from voice intake. If no active BBA exists, AI must ALSO call stage_bba_packet in the same call to capture BBA terms — offer can't dispatch until BBA is signed.",
  },
  stage_bba_packet: {
    name: "stage_bba_packet",
    category: "stage",
    authority: "agent",
    gates: [],
    is_outbound: false,
    is_telco_initiating: false,
    is_nar_regulated: true,
    description: "Stage a Buyer Broker Agreement (NAR 2024 mandatory artifact) from voice intake. Captures agreement type, commission terms, scope, expiration. Companion to stage_offer_packet — when both are staged, dispatch_transaction_packet sends them together in one e-sign envelope.",
  },
  read_form_status: {
    name: "read_form_status",
    category: "lookup",
    authority: "agent",
    gates: [],
    is_outbound: false,
    is_telco_initiating: false,
    is_nar_regulated: false,
    description: "Read a staged packet's fill status field-by-field. AI uses this to walk unfilled fields aloud to the agent so they can answer in real time instead of staging incomplete and reopening later.",
  },
  next_unfilled_field: {
    name: "next_unfilled_field",
    category: "lookup",
    authority: "agent",
    gates: [],
    is_outbound: false,
    is_telco_initiating: false,
    is_nar_regulated: false,
    description: "Get the next required-but-unfilled field on a staged offer or listing packet with its label, hint, type, and suggested_default. The AI reads the hint to the agent, then calls fill_form_field with the answer (or 'default').",
  },
  fill_form_field: {
    name: "fill_form_field",
    category: "stage",
    authority: "agent",
    gates: [],
    is_outbound: false,
    is_telco_initiating: false,
    is_nar_regulated: true,
    description: "Fill a single field on a staged offer or listing packet. Pass value='default' to apply the field's suggested_default (e.g. closingDate='+45d', commissionPercentage=2.5). Only the contact's assigned agent (or broker/admin) can edit; refuses once the packet is pending_signature or beyond.",
  },
  dispatch_transaction_packet: {
    name: "dispatch_transaction_packet",
    category: "send",
    authority: "agent",
    gates: [],
    is_outbound: true,
    is_telco_initiating: false,
    is_nar_regulated: true,
    description: "Dispatch a staged BBA + offer (or either alone) to the buyer as ONE e-sign envelope via the agent's configured provider. Buyer signs both in sequence in the same packet. Agent normally reviews via emailed link first, then says 'send Jane's offer for signature' — pass contact_id alone and the tool auto-resolves the most recent draft BBA + staged offer for that contact. Optionally pass explicit bba_id / offer_document_id to bypass auto-resolution, or auto_resolve:false to require explicit IDs.",
  },
  stage_listing_packet: {
    name: "stage_listing_packet",
    category: "stage",
    authority: "agent",
    gates: [],
    is_outbound: false,
    is_telco_initiating: false,
    is_nar_regulated: true,
    description: "Stage a listing-agreement packet from voice intake. Voice → conversation → intake → forms → email agent with review link.",
  },
  stage_showing: {
    name: "stage_showing",
    category: "schedule",
    authority: "agent",
    gates: ["active_bba"],
    is_outbound: false,
    is_telco_initiating: false,
    is_nar_regulated: true,
    description: "Schedule a showing for a buyer contact. BBA required (NAR 2024).",
  },

  // ── Activity tracking (no compliance gates) ───────────────────────────────
  create_task: {
    name: "create_task",
    category: "lookup",
    authority: "agent_or_isa",
    gates: [],
    is_outbound: false,
    is_telco_initiating: false,
    is_nar_regulated: false,
    description: "Create a follow-up task or to-do for the agent.",
  },
  log_activity: {
    name: "log_activity",
    category: "lookup",
    authority: "agent_or_isa",
    gates: [],
    is_outbound: false,
    is_telco_initiating: false,
    is_nar_regulated: false,
    description: "Log an activity row (call notes, observation, etc.).",
  },

  // ── Reports ───────────────────────────────────────────────────────────────
  get_income_truth: {
    name: "get_income_truth",
    category: "report",
    authority: "agent",
    gates: [],
    is_outbound: false,
    is_telco_initiating: false,
    is_nar_regulated: false,
    description: "Spoken summary of agent's gap to income goal + this week's ranked actions.",
  },
  get_morning_briefing: {
    name: "get_morning_briefing",
    category: "report",
    authority: "agent",
    gates: [],
    is_outbound: false,
    is_telco_initiating: false,
    is_nar_regulated: false,
    description: "Compose the agent's top-priority action queue into a spoken briefing. Pulls from 6 sources (portal_event / deal_health / listing_health / lifetime_npv / negotiation_strategy / income_gap) via composeAgentActionQueue. The voice cockpit calls this on session start to open with 'three things to act on today' so the AI feels proactive instead of order-taking.",
  },

  // ── Team coordination (the bullpen — read-only, no gates beyond auth) ──────
  // Fan a question across the whole AI manager bench and read back ONE
  // manager-attributed spoken answer. The spoken admin's differentiator: talk
  // to your AI team like a human team. Backends in lib/kernel/{team-query,
  // area-query,morning-standup}; dispatched via lib/voice/team-commands.ts.
  team_query: {
    name: "team_query",
    category: "report",
    authority: "agent_or_isa",
    gates: [],
    is_outbound: false,
    is_telco_initiating: false,
    is_nar_regulated: false,
    description: "Ask the whole team what it knows about a person — 'Hey team, what do you know about the Hendersons?'. Every manager (AI ISA, Shopping Agent, Deal Coordinator, Asset Manager, Ads Manager, Data Steward) answers with ONLY what its own tables know; honest when empty; recommends silence on a withdrawn contact.",
  },
  area_query: {
    name: "area_query",
    category: "report",
    authority: "agent_or_isa",
    gates: [],
    is_outbound: false,
    is_telco_initiating: false,
    is_nar_regulated: false,
    description: "Ask the marketing bench what's happening near a place — 'anything happening near 44 Birch?'. Reports active listings (Listing Concierge), reusable promo reels ready/rendering (Asset Manager), and live ads targeting the area (Ads Manager). Read-only, honest when nothing's running.",
  },
  morning_standup: {
    name: "morning_standup",
    category: "report",
    authority: "agent",
    gates: [],
    is_outbound: false,
    is_telco_initiating: false,
    is_nar_regulated: false,
    description: "The team's ranked top-3 for the day — 'what should I do today?'. Fire drills first (most expensive to ignore), then aging approvals past the 4h SLA, then the single warmest cooling lead. One spoken ranked answer, read-only, honest when the day is clear.",
  },

  // ── Team coordination (acting verbs — the team DOES what you say) ──────────
  // Each delegates to a backend that enforces its OWN gate; nothing sends autonomously.
  standup_action: {
    name: "standup_action",
    category: "send",
    authority: "agent",
    gates: [],  // Re-derives the stand-up live; each item routes to its rail (approval→gate as the
                // agent; reengage→follow-up through the gate; fire is NEVER auto-resolved).
    is_outbound: true,
    is_telco_initiating: false,
    is_nar_regulated: false,
    description: "Act on a ranked stand-up item — 'knock out number two'. Pass ordinal (1/2/3). Routes to the item's rail: an approval is approved AS the agent through the gate, a cooling lead gets a follow-up, a fire drill is never auto-resolved (human judgment).",
  },
  voice_followup: {
    name: "voice_followup",
    category: "send",
    authority: "agent_or_isa",
    gates: ["evaluate_outbound"],  // Brand voice + Them-First + fair housing; proposal→approval re-checks consent.
    is_outbound: true,
    is_telco_initiating: false,
    is_nar_regulated: false,
    description: "Send a follow-up to a contact — 'send the Hendersons a follow-up saying …'. Proposal → approved AS the speaking agent through the gate → consent re-checked → sent. Pass contact_id or person_query, and optional dictation (carried verbatim). Nothing sends until approved.",
  },
  start_marketing: {
    name: "start_marketing",
    category: "send",
    authority: "agent_or_isa",
    gates: [],  // Enrollment itself; EACH campaign step clears its own compliance gate before it touches the contact.
    is_outbound: false,
    is_telco_initiating: false,
    is_nar_regulated: false,
    description: "Enroll a contact in the best active campaign sequence — 'start marketing for the Hendersons'. Pass contact_id or person_query. Each sequence step clears its own compliance gate before it sends.",
  },
  cut_promo: {
    name: "cut_promo",
    category: "draft",
    authority: "agent",
    gates: [],  // Fair Housing pre-flight + cooldown debounce inside the rail; social drafts human-approved.
    is_outbound: false,
    is_telco_initiating: false,
    is_nar_regulated: false,
    description: "Cut a promo reel for a listing — 'cut a promo reel for 44 Birch'. Manual trigger on the canonical Remotion + D-ID + ElevenLabs rail (Fair Housing pre-flight, cooldown debounce). Social drafts still land for human approval. Pass address_query.",
  },

  // -- Studio Session (batch content calendar commissioning) -----------------
  book_studio_session: {
    name: "book_studio_session",
    category: "stage",
    authority: "agent",
    gates: ["evaluate_outbound"],
    is_outbound: false,
    is_telco_initiating: false,
    is_nar_regulated: false,
    description: "Commission a GATED content calendar batch in one spoken command: plans N reels (which formats, which listings/topics, which dates) and stages them via the Video Director at pending_review. Nothing auto-publishes — every reel awaits human approval in the Content Studio. Example: 'book me a week of content', 'schedule a month of reels'.",
  },
}

/**
 * Lookup helper — returns the registry entry or undefined.
 * Dispatchers should reject calls for unknown tool names.
 */
export function getVoiceTool(name: string): VoiceTool | undefined {
  return voiceTools[name]
}

/**
 * Returns the list of compliance gates a tool MUST pass. Empty array means
 * read-only / no gates beyond authority.
 */
export function gatesFor(name: string): ComplianceGate[] {
  return voiceTools[name]?.gates ?? []
}

/**
 * Returns whether a tool is allowed for the given user_type.
 */
export function authorityAllows(toolName: string, userType: string): boolean {
  const tool = voiceTools[toolName]
  if (!tool) return false
  switch (tool.authority) {
    case "any_authenticated": return true
    case "agent":             return userType === "agent" || userType === "broker" || userType === "broker_admin" || userType === "admin" || userType === "superadmin" || userType === "team_lead"
    case "agent_or_isa":      return ["agent", "isa", "team_lead", "broker", "broker_admin", "admin", "superadmin"].includes(userType)
    case "tenant_staff":      return ["agent", "isa", "tc", "team_lead", "broker", "broker_admin", "admin", "superadmin"].includes(userType)
    case "admin":             return ["broker", "broker_admin", "admin", "superadmin"].includes(userType)
    default:                  return false
  }
}
