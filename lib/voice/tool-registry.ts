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
    gates: ["active_bba"],
    is_outbound: false,
    is_telco_initiating: false,
    is_nar_regulated: true,
    description: "Stage a filled offer packet from voice intake. Voice → conversation → intake → forms → email agent with review link. BBA required (NAR 2024).",
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
