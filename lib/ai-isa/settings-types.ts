/**
 * Pure types + constants for AI ISA settings. Lives outside the
 * "use server" action file so client components can import the types
 * and the read-only catalogs/defaults without RPC overhead and without
 * the "Server Actions must be async functions" build constraint.
 */

export interface AIISASettings {
  enabled: boolean
  /**
   * THE AUTO-SEND GATE. `true` (the default, and the live column default) means
   * the ISA may DRAFT a touch but a human must release it; `false` means the
   * brokerage has explicitly authorised the ISA to send on its behalf.
   *
   * BUILT, not invented (CLAUDE.md §1 case 2). `ai_isa_settings.require_broker_approval`
   * has existed since migration 061 (`BOOLEAN NOT NULL DEFAULT TRUE`), is named in
   * the resolver's SELECT list, and had NO reader that acted on it and NO writer
   * that set it — the one thing a broker would look for before letting an AI mail
   * their leads was a column nothing consulted. `rowToSettings` in
   * lib/ai-isa/resolve-isa-settings.ts now folds it in the same way it folds
   * `is_active` → `enabled`: the COLUMN is authoritative over anything stale in
   * the `settings` blob (§6 — one spelling per idea).
   *
   * The DEFAULT is `true` because the failure that matters on this path is sending
   * on someone's behalf without their configured consent (CLAUDE.md §4). A
   * brokerage with no settings row at any tier gets staged drafts, not sends.
   */
  require_broker_approval: boolean
  lead_allowed_channels: ('email' | 'direct_mail')[]
  contact_allowed_channels: ('email' | 'sms' | 'phone' | 'direct_mail')[]
  stale_threshold_days: number
  ghosted_threshold_days: number
  max_touches_lead: number
  max_touches_contact: number
  touch_interval_days: number
  blocked_lifecycle_states: string[]
  auto_enable_on_new_contacts: boolean
  pause_on_agent_assigned: boolean
  default_handoff_action: 'notify_agent' | 'create_task' | 'both'
  suppress_on_outcomes: string[]
  enabled_capabilities?: IsaCapability[]
  pls_auto_send_score_threshold?: number
  pls_auto_send_review_window_hours?: number
  pls_auto_send_cooldown_days?: number
  pls_auto_send_max_per_day?: number
  pls_auto_send_eligible_channels?: ("email" | "sms")[]
}

export const DEFAULT_AISA_SETTINGS: AIISASettings = {
  enabled: true,
  // FAIL CLOSED (§4). Matches the live column default (`NOT NULL DEFAULT TRUE`,
  // migration 061): "nobody configured this" renders as "a human releases it",
  // never as "the AI may send".
  require_broker_approval: true,
  lead_allowed_channels: ['email', 'direct_mail'],
  contact_allowed_channels: ['email', 'sms', 'phone', 'direct_mail'],
  stale_threshold_days: 14,
  ghosted_threshold_days: 21,
  max_touches_lead: 5,
  max_touches_contact: 8,
  touch_interval_days: 3,
  blocked_lifecycle_states: ['representation', 'active_transaction', 'closing', 'do_not_contact'],
  auto_enable_on_new_contacts: false,
  pause_on_agent_assigned: true,
  default_handoff_action: 'both',
  // Wave 98 (98C): canonical dead-end spellings — 'do_not_call' merged onto 'do_not_contact' (§6);
  // a stored legacy spelling still reads correctly through canonicalDeadEnd below.
  suppress_on_outcomes: ['not_interested', 'do_not_contact', 'wrong_number'],
}

// ─── NEGATIVE INTELLIGENCE — ONE VOCABULARY FOR DEAD ENDS (wave 98, lane 98C; CLAUDE.md §6) ──────
// Dead-end outcomes were spelled differently by every writer: voice_calls.outcome ('not_interested',
// 'opt_out' — live CHECK), ai_isa_activities.outcome via lib/kernel/ai-isa.ts recordAiIsaOutcome
// ('explicit_opt_out', 'not_ready_now', 'wrong_number'), the inbound-suppression intents ('stop',
// 'do_not_call', 'wrong_person'), this file's own former settings options ('do_not_call', 'bad_contact_data'), the record_qualification line 'already represented by an agent: yes',
// and lifecycle_state ('representation', 'long_term_nurture'). Stored values keep their live spellings
// (the CHECKs are the database's truth); every READER maps them onto these seven through
// canonicalDeadEnd, and every new writer uses these spellings.
export const DEAD_END_OUTCOMES = [
  'not_interested',
  'wrong_number',
  'do_not_contact',
  'already_represented',
  'property_sold',
  'postponed',
  'paused',
] as const
export type DeadEndOutcome = (typeof DEAD_END_OUTCOMES)[number]

/** Every live alias → its canonical dead end. A spelling absent here and from DEAD_END_OUTCOMES is
 *  NOT a dead end (e.g. 'disqualified' is a routing verdict, 'no_answer' is a retry). */
const DEAD_END_ALIASES: Readonly<Record<string, DeadEndOutcome>> = {
  opt_out: 'do_not_contact',
  explicit_opt_out: 'do_not_contact',
  do_not_call: 'do_not_contact',
  do_not_text: 'do_not_contact',
  dnc: 'do_not_contact',
  stop: 'do_not_contact',
  unsubscribe: 'do_not_contact',
  wrong_person: 'wrong_number',
  bad_contact_data: 'wrong_number',
  not_ready_now: 'postponed',
  long_term_nurture: 'postponed',
  representation: 'already_represented',
  has_agent: 'already_represented',
  sold: 'property_sold',
  ai_outreach_paused: 'paused',
}

/** PURE — the canonical dead end for any recorded spelling, or null when it is not a dead end. */
export function canonicalDeadEnd(raw: unknown): DeadEndOutcome | null {
  if (typeof raw !== 'string') return null
  const k = raw.trim().toLowerCase()
  if ((DEAD_END_OUTCOMES as readonly string[]).includes(k)) return k as DeadEndOutcome
  return DEAD_END_ALIASES[k] ?? null
}

/** Dead ends that stop outreach WHATEVER the tenant's suppression settings say: an opt-out is the
 *  law (TCPA / CAN-SPAM) and a person represented by another agent is not solicited (NAR Art. 16). */
export const ALWAYS_TERMINAL_DEAD_ENDS: ReadonlySet<DeadEndOutcome> = new Set<DeadEndOutcome>(['do_not_contact', 'already_represented'])

/** The dead ends a broker may choose to suppress on (the settings page's options). `postponed` is
 *  time-bounded (it waits, then ends by itself) and `paused` is a human's own switch — neither is a
 *  suppression rule. */
export const SUPPRESSIBLE_DEAD_ENDS: readonly DeadEndOutcome[] =
  DEAD_END_OUTCOMES.filter((o) => o !== 'postponed' && o !== 'paused')

export type IsaCapability =
  | "qualify_lead"
  | "record_outcome"
  | "transfer_to_agent"
  | "send_email"
  | "send_sms"
  | "send_property_listings"
  | "send_market_update"
  | "book_appointment"
  | "book_listing_consultation"
  | "request_showing_in_house_listing"
  | "process_opt_out"
  | "honor_dnc_request"
  | "answer_listing_status"
  | "answer_transaction_status"
  | "answer_home_value_estimate"
  | "answer_documents_status"
  | "ghost_recovery_outreach"
  | "send_review_request"
  | "predictive_listing_auto_touch"

export interface IsaCapabilityDescriptor {
  key: IsaCapability
  label: string
  description: string
  category: "core" | "outreach" | "booking" | "compliance" | "information" | "ghost" | "reputation"
  requiresConsent: boolean
  riskLevel: "low" | "medium" | "high"
  defaultEnabled: boolean
}

export const ISA_CAPABILITY_CATALOG: IsaCapabilityDescriptor[] = [
  { key: "qualify_lead", label: "Qualify lead", description: "Run qualification scripts, capture timeline/budget/motivation/lender status.", category: "core", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  { key: "record_outcome", label: "Record call outcome", description: "Log call/conversation outcome (qualified, not_ready_now, opt_out, etc.).", category: "core", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  { key: "transfer_to_agent", label: "Transfer call to live agent", description: "Hot-transfer the call to the assigned agent or duty agent when caller asks for a human or ISA can't resolve.", category: "core", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  { key: "send_email", label: "Send outbound email", description: "Send qualification or follow-up emails. Required for unconsented leads (email is one of two allowed channels).", category: "outreach", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  { key: "send_sms", label: "Send outbound SMS", description: "Send SMS messages. ONLY runs against consented contacts — TCPA-gated regardless of this toggle.", category: "outreach", requiresConsent: true, riskLevel: "medium", defaultEnabled: false },
  { key: "send_property_listings", label: "Send matched property listings", description: "Text or email a list of matched properties to qualified buyers.", category: "outreach", requiresConsent: true, riskLevel: "low", defaultEnabled: false },
  { key: "send_market_update", label: "Send local market update", description: "Send seller/lifetime customer their personalized monthly market snapshot.", category: "outreach", requiresConsent: true, riskLevel: "low", defaultEnabled: false },
  { key: "book_appointment", label: "Book agent consultation", description: "Schedule a buyer or seller consultation with the assigned agent on their calendar.", category: "booking", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  { key: "book_listing_consultation", label: "Book listing appointment", description: "Schedule a listing consultation specifically (price strategy, walkthrough, etc.).", category: "booking", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  { key: "request_showing_in_house_listing", label: "Request showing on in-house listing (unrepresented buyer)", description: "ONLY for IN-HOUSE listings + buyers without an agent. Finds availability with the listing agent and books the showing. Will NOT book on cooperating brokerage listings or for represented buyers.", category: "booking", requiresConsent: true, riskLevel: "medium", defaultEnabled: false },
  { key: "process_opt_out", label: "Process opt-out / DNC", description: "Detect and honor opt-out requests immediately (writes to platform_suppression_list).", category: "compliance", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  { key: "honor_dnc_request", label: "Honor DNC request mid-call", description: "End call gracefully and add caller to DNC if they request to be removed.", category: "compliance", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  { key: "answer_listing_status", label: "Answer 'what's the status of my listing?'", description: "Look up the contact's listing and report current stage, recent activity, showings, offers.", category: "information", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  { key: "answer_transaction_status", label: "Answer 'what's the status of my closing?'", description: "Look up the contact's transaction and report milestones, deadlines, blockers.", category: "information", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  { key: "answer_home_value_estimate", label: "Answer 'what's my home worth?'", description: "Run a quick AVM and report current estimated home value to lifetime customers.", category: "information", requiresConsent: false, riskLevel: "low", defaultEnabled: false },
  { key: "answer_documents_status", label: "Answer 'where are we on documents?'", description: "Report compliance and document checklist status for the contact's active transaction.", category: "information", requiresConsent: false, riskLevel: "low", defaultEnabled: true },
  { key: "ghost_recovery_outreach", label: "Run ghost recovery sequence", description: "Re-engage contacts who have gone quiet (after configured ghosted_threshold_days).", category: "ghost", requiresConsent: true, riskLevel: "medium", defaultEnabled: false },
  { key: "send_review_request", label: "Send review request post-close", description: "Auto-send the post-close review request to lifetime customers.", category: "reputation", requiresConsent: true, riskLevel: "low", defaultEnabled: false },
  { key: "predictive_listing_auto_touch", label: "Auto-send touches to likely sellers", description: "When a contact's Predictive Listing Score crosses the threshold, automatically queue a soft check-in touch (with configurable review window). Sensitive life events (divorce, foreclosure, death) are always excluded — those require human judgement.", category: "outreach", requiresConsent: true, riskLevel: "high", defaultEnabled: false },
]

/** Default capability set when no per-brokerage config exists. */
export function defaultEnabledCapabilities(): IsaCapability[] {
  return ISA_CAPABILITY_CATALOG.filter((c) => c.defaultEnabled).map((c) => c.key)
}

/** One recorded dead end for a person, already on the canonical vocabulary. */
export interface DeadEndEvidence {
  outcome: DeadEndOutcome
  /** When it was recorded (null = the source carries no time). */
  at: Date | null
  /** Where it was read (table.column) — the evidence line on the decision. */
  source: string
  /** `postponed` only — the end of the requested quiet period. */
  until?: Date | null
}

/**
 * PURE — every dead end already RECORDED for one lead, on the canonical vocabulary. Each source is an
 * existing writer (nothing here invents a fact):
 *   · ai_isa_activities.outcome (activity_type 'outcome_recorded') — lib/kernel/ai-isa.ts recordAiIsaOutcome
 *   · voice_calls.outcome — the voice call close (live CHECK: 'not_interested', 'opt_out', …)
 *   · leads.qualification_summary — record_qualification's `already represented by an agent: yes|no`
 *     line (lib/ai-isa/customer-context-tools.ts, which names THIS reader as the one it was waiting for);
 *     the NEWEST line wins, so a later "no" clears an earlier "yes"
 *   · leads.long_term_nurture_until — recordAiIsaOutcome 'not_ready_now' → postponed until that date
 * Called by lib/ai-isa/lead-action-plan.ts advanceLeadActionPlans (the lead sweep) and, keyed by
 * contact, loadContactNbaContext (the contact NBA, wave 100). `property_sold` is written by
 * lib/kernel/ai-isa.ts recordObservedDeadEnd onto ai_isa_activities (the platform observes a sale).
 */
export function deadEndsFromLeadSources(input: {
  isaOutcomes?: ReadonlyArray<{ outcome: string | null; created_at: string | null }>
  callOutcomes?: ReadonlyArray<{ outcome: string | null; created_at: string | null }>
  qualificationSummary?: string | null
  longTermNurtureUntil?: string | null
  /** Wave 100 (100B): the contact NBA feeds the SAME sources keyed by contact. Only the evidence
   *  label of the qualification line changes (contacts.qualification_summary); default 'lead'. */
  subject?: 'lead' | 'contact'
}): DeadEndEvidence[] {
  const out: DeadEndEvidence[] = []
  const at = (v: string | null | undefined) => (v && Number.isFinite(new Date(v).getTime()) ? new Date(v) : null)
  for (const r of input.isaOutcomes ?? []) {
    const o = canonicalDeadEnd(r.outcome)
    if (!o) continue
    // A not_ready_now outcome is `postponed`; its end date lives on the lead (long_term_nurture_until).
    if (o === "postponed") continue
    out.push({ outcome: o, at: at(r.created_at), source: "ai_isa_activities.outcome" })
  }
  for (const r of input.callOutcomes ?? []) {
    const o = canonicalDeadEnd(r.outcome)
    if (o && o !== "postponed") out.push({ outcome: o, at: at(r.created_at), source: "voice_calls.outcome" })
  }
  const lines = [...(input.qualificationSummary ?? "").matchAll(/already represented by an agent:\s*(yes|no)/gi)]
  if (lines.length > 0 && lines[lines.length - 1][1].toLowerCase() === "yes") {
    out.push({ outcome: "already_represented", at: null, source: input.subject === 'contact' ? "contacts.qualification_summary" : "leads.qualification_summary" })
  }
  const until = at(input.longTermNurtureUntil)
  if (until) out.push({ outcome: "postponed", at: null, until, source: "leads.long_term_nurture_until" })
  return out
}
