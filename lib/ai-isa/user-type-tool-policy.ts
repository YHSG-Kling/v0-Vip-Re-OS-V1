/**
 * lib/ai-isa/user-type-tool-policy.ts
 *
 * Lane 77A — owner verbatim (wave 77): "vendors are not contact type, they
 * are user type. persona tools need to be for true persona types and other
 * user types need their own tools if there are no tools already covered."
 *
 * THE ONE USER-TYPE (SEAT) TOOL TABLE. lib/ai-isa/persona-tool-policy.ts
 * answers "which tools may this CUSTOMER conversation reach" for the six
 * customer personas (buyer/seller/investor/renter/relocation/sphere). This
 * file answers the OTHER question — "which tools may this SIGNED-IN SEAT
 * reach" — for every users.user_type the in-app copilot admits. The two
 * vocabularies are deliberately disjoint (CLAUDE.md §6: one vocabulary per
 * function): a persona is what a person being qualified looks like; a seat
 * is what an authenticated user IS. scripts/user-type-tool-surfaces-guard.ts
 * holds the two apart and goes red if a seat name ever lands in ToolPersona.
 *
 * ── WHERE THE SEAT VOCABULARY COMES FROM (never invented here) ──────────────
 *   users.user_type (users_user_type_check, scripts/check-vocabularies.ts)
 *     + user_role_assignments.role (lib/auth/role-grants.ts — the SAME roster,
 *     read through selectPrimaryRole), canonicalised by the route.
 *   TENANT_ADMIN_USER_TYPES (lib/auth/resolve-user-role.ts) — the operational
 *     admin class: broker / broker_admin / broker_owner / admin / team_lead /
 *     compliance_officer. team_lead is split OUT into its own seat below
 *     because a team is a mini brokerage (CLAUDE.md §4) with its OWN board.
 *   Platform staff: users.platform_role (isPlatformStaffIdentity) — never
 *     user_type='superadmin', which no live row has.
 *   LENDER / TITLE ARE VENDOR CATEGORIES, NOT USER TYPES (owner 2026-09-04;
 *     CLAUDE.md §4): the seat is user_type='vendor' + a user_role_assignments
 *     .vendor_id, and lender-ness is vendors.category resolved through
 *     lib/kernel/lender-linkage.ts::isLenderVendorCategory; a title partner is
 *     a title_company_users row (lib/kernel/portal-auth.ts::requireTitleActor)
 *     or a vendors.category='title' seat.
 *
 * ── THE SEAT → TOOL POLICY TABLE ─────────────────────────────────────────────
 * One table (USER_TYPE_TOOL_POLICY). Every `seatToolNames` entry is a key of
 * lib/ai-isa/user-type-tools.ts::USER_TYPE_SEAT_TOOL_BUILDERS (the proof holds
 * the two together); every builder is a THIN ADAPTER over an existing
 * survivor (never a second implementation, CLAUDE.md §1):
 *
 *   staff (agent / isa / tc)   — the FULL staff toolkit (app/api/internal/
 *       ai-chat/route.ts's agentTools — wave 72B: "no persona split — staff
 *       get the whole toolkit") + BatchData (tier-constricted) + RentCast, and
 *       the CUSTOMER free bundle when acting FOR a contact (buildCustomerFree
 *       Tools with the persona resolved off that tenant-checked contact row).
 *   team_lead                  — everything staff has, PLUS the team board
 *       (teams.team_lead_id-anchored — lib/kernel/resolve-user-team.ts::
 *       resolveLedTeamId), the team's assignment rules and an agent coaching
 *       brief (lib/kernel/agent-coaching.ts::getAgentWeeklyReport) for an
 *       agent ON that team only.
 *   broker_admin (broker / broker_admin / broker_owner / admin /
 *       compliance_officer) — everything staff has, PLUS setup readiness
 *       (app/actions/setup-readiness.ts), a billing summary (subscriptions,
 *       READ only — m467 lets a compliance officer READ the books) and a
 *       compliance summary (compliance_flags + approval_items, tenant-pinned).
 *   vendor                     — SEAT TOOLS ONLY. Own placements/assignments
 *       (vendor_assignments / vendor_jobs / vendor_bookings), invoice and
 *       payout status (vendor_invoices / vendor_payouts), own documents
 *       (app/actions/vendor-documents.ts::getVendorDocuments), ratings and
 *       reviews (vendor_ratings / vendor_reviews), accept/decline a booking
 *       (app/actions/vendor-portal.ts), declare a service area (app/actions/
 *       vendor-service-areas.ts::declareVendorServiceAreaAction), set their
 *       turnaround/availability (vendors.estimated_turnaround_days), and a
 *       message to the agent on a job (sendVendorMessageToAgent). NO staff
 *       tool (lookup_contact searched the whole brokerage book; send_portal_
 *       message / update_contact_status wrote other people's records — the
 *       IDOR this table closes), NO BatchData, NO RentCast.
 *   lender (vendor seat, lender category) — SEAT TOOLS ONLY: their own loan
 *       pipeline (transaction_lenders on vendor_assignments-linked deals —
 *       lenderVendorTransactionIds pinned to the vendor's brokerage), a loan
 *       status / rate-lock update (updateLenderLoanStatus), flag an issue,
 *       the deal's document list (transaction_documents, never a URL) and a
 *       message to the agent (sendLenderMessageToAgent). No BatchData/RentCast.
 *   title (title_company_users row, or vendor seat with category 'title') —
 *       SEAT TOOLS ONLY: their own title/escrow milestones
 *       (transaction_title_escrow), a title-status update (updateTitleStatus)
 *       and a message to the agent (sendTitleMessageToAgent).
 *   platform_staff             — the staff toolkit + BatchData/RentCast (the
 *       platform's own seat; platform sees all tenants — CLAUDE.md §4). The
 *       platform PROSPECT surface is NOT here: lib/platform/prospect-agent-
 *       tools.ts (lane 77B) is a different audience on a different engine.
 *
 * NEVER BatchData on a vendor/lender/title seat (owner, wave 74/75: no
 * BatchData where something cheaper covers the need — and nothing these seats
 * ask is a property-data question at all). The cost TIER constriction
 * (persona-tool-policy.ts::filterToolsByTier) still applies wherever
 * `batchData: true` below.
 *
 * FAIL CLOSED (CLAUDE.md §4): a seat whose identity could not be resolved (a
 * 'vendor' role with no vendor_id grant, a 'lender' grant on a non-lender
 * vendor) gets NO seat tools — lib/ai-isa/user-type-tools.ts refuses to mount
 * them rather than mounting tools that would read nothing or, worse,
 * someone else's rows.
 */

import { TENANT_ADMIN_USER_TYPES, isPlatformStaffIdentity } from "@/lib/auth/resolve-user-role"
import { isLenderVendorCategory } from "@/lib/kernel/lender-linkage"
import { VENDOR_CATEGORY_TITLE } from "@/lib/kernel/vendor-categories"

// ─── THE SEAT VOCABULARY ────────────────────────────────────────────────────

export type UserTypeSeat =
  | "staff"
  | "team_lead"
  | "broker_admin"
  | "vendor"
  | "lender"
  | "title"
  | "platform_staff"

export const USER_TYPE_SEATS: readonly UserTypeSeat[] = [
  "staff", "team_lead", "broker_admin", "vendor", "lender", "title", "platform_staff",
]

/** The three seats that are EXTERNAL partners (a vendor company's user) —
 *  never a staff tool, never a property-data tool, own rows only. */
export const PARTNER_SEATS: ReadonlySet<UserTypeSeat> = new Set<UserTypeSeat>(["vendor", "lender", "title"])

/**
 * Canonical role names the in-app copilot admits at all. DERIVED from the
 * tenant roster (never a second copy of it) plus the producing/support seats
 * and the three partner seats. `lender` and `title_agent` are admitted as
 * GRANT spellings (user_role_assignments.role still carries them live) — the
 * seat they resolve to is decided by the vendor category, never by the word.
 */
export const COPILOT_ADMITTED_ROLES: ReadonlySet<string> = new Set<string>([
  ...TENANT_ADMIN_USER_TYPES,
  "agent", "isa", "tc",
  "vendor", "lender", "title_agent",
  "superadmin",
])

export interface ResolveUserTypeSeatInput {
  /** The route's ONE canonical role (selectPrimaryRole → aliases applied). */
  role: string | null | undefined
  /** users.user_type — the seat's own declared identity. */
  userType: string | null | undefined
  /** users.platform_role — platform staff live HERE (CLAUDE.md §4). */
  platformRole: string | null | undefined
  /** vendors.category of the session's vendor grant (selectVendorId), when one resolves. */
  vendorCategory: string | null | undefined
  /** true when the session holds a vendor-bearing grant that resolved to ONE vendor. */
  hasVendorId: boolean
  /** true when the session owns at least one title_company_users row. */
  isTitleUser: boolean
}

/**
 * PURE — the ONE place a session's role facts become a seat. Precedence:
 *   platform staff (platform_role, or the legacy user_type 'superadmin' marker)
 *   > a LENDER-category vendor grant → lender
 *   > a title_company_users row, or a title-category vendor grant → title
 *   > any other vendor grant, or a vendor/lender/title role word → vendor
 *     (identity may still be missing — the tool builder fails closed)
 *   > team_lead → team_lead
 *   > the tenant admin roster → broker_admin
 *   > everything else (agent / isa / tc) → staff.
 * A 'lender' grant on a NON-lender vendor is a vendor seat, not a lender
 * seat: the word does not make a lender — the category does (§4).
 */
export function resolveUserTypeSeat(input: ResolveUserTypeSeatInput): UserTypeSeat {
  const role = String(input.role ?? "").trim().toLowerCase()
  const userType = String(input.userType ?? "").trim().toLowerCase()
  if (role === "superadmin" || isPlatformStaffIdentity(userType, input.platformRole)) return "platform_staff"

  const category = String(input.vendorCategory ?? "").trim().toLowerCase()
  if (input.hasVendorId && isLenderVendorCategory(category)) return "lender"
  if (input.isTitleUser || (input.hasVendorId && category === VENDOR_CATEGORY_TITLE)) return "title"
  if (input.hasVendorId || role === "vendor" || role === "lender" || role === "title_agent" || userType === "vendor") return "vendor"

  if (role === "team_lead" || (!role && userType === "team_lead")) return "team_lead"
  if (TENANT_ADMIN_USER_TYPES.has(role) || (!role && TENANT_ADMIN_USER_TYPES.has(userType))) return "broker_admin"
  return "staff"
}

// ─── THE TABLE ──────────────────────────────────────────────────────────────

export interface UserTypeToolPolicy {
  label: string
  /** Who sits in this seat — for the prompt and the docs, one sentence. */
  audience: string
  /** "all" — the route's full staff toolkit is mounted; "none" — no staff tool. */
  staffToolkit: "all" | "none"
  /** Seat-specific tools (keys of user-type-tools.ts's builder registry). */
  seatToolNames: readonly string[]
  /** May BatchData tools (tier-constricted) be mounted at all? */
  batchData: boolean
  /** May RentCast MCP tools be mounted at all? */
  rentCast: boolean
  /** When the copilot is opened ON a contact (tenant-checked), mount the
   *  customer free bundle with THAT contact's persona (lib/ai-isa/customer-
   *  context-tools.ts::buildCustomerFreeTools) — staff acting for a contact. */
  customerPersonaToolsForContact: boolean
  /** What this seat realistically asks the copilot — the prompt's guide. */
  asks: readonly string[]
  /** Lane 79B — what the copilot realistically OFFERS this seat next, each
   *  naming the registered tool (a seat tool, a staff tool, or draft_ai_reply)
   *  in parentheses — the seat-side twin of the persona follow-up menu.
   *  Never a sale: a seat is a colleague, not a prospect. */
  followUps: readonly string[]
  /** Hard rules the prompt states for this seat. */
  rules: readonly string[]
}

const STAFF_ASKS: readonly string[] = [
  "who to call today and what's due (tasks, follow-ups, showings)",
  "a summary of a contact, deal or lead from the context, and the next best action",
  "drafting a client message in the brand voice (draft_ai_reply — never auto-sent)",
  "staging a listing / offer / campaign / open house / video from what they just said",
  "a property or comp lookup — cheapest tool first (our own listings → RentCast → BatchData preview/count)",
]

// Lane 79B — the seat-side follow-up menu. Staff seats act FOR a customer, so
// the offers mirror the customer follow-ups the copilot can stage on their
// behalf (all through the customer bundle when the copilot is open on a
// contact) plus the drafting door.
const STAFF_FOLLOW_UPS: readonly string[] = [
  "draft the next client message in the brand voice for their review — never auto-sent (draft_ai_reply)",
  "stage a callback task for the contact they are working (schedule_callback, when acting for a contact)",
  "send the contact the listings matching the criteria they described (send_matching_listings)",
  "book the seller's no-obligation listing appointment on the agent's own calendar (find_listing_appointment_slots → book_listing_appointment)",
  "queue a home-value review for the agent to run and call back on — the copilot never quotes the number (schedule_home_value_review)",
  "look up a property's facts by address, cheapest source first (lookup_property_facts)",
]

const STAFF_RULES: readonly string[] = [
  "Only take an action when explicitly asked; ask ONE clarifying question when a key parameter is missing.",
  "Never auto-send — draft_ai_reply saves a draft the person reviews and sends.",
  "Commission and brokerage-wide financials are off agent-facing display (CLAUDE.md §5).",
]

export const USER_TYPE_TOOL_POLICY: Record<UserTypeSeat, UserTypeToolPolicy> = {
  staff: {
    label: "Agent / ISA / transaction coordinator copilot",
    audience: "a licensed agent, an inside sales agent or a transaction coordinator working their own book inside the OS",
    staffToolkit: "all",
    seatToolNames: [],
    batchData: true,
    rentCast: true,
    customerPersonaToolsForContact: true,
    asks: STAFF_ASKS,
    followUps: STAFF_FOLLOW_UPS,
    rules: STAFF_RULES,
  },
  team_lead: {
    label: "Team lead copilot",
    audience: "the lead of a team (teams.team_lead_id) — a mini brokerage with its own board, rules and coaching",
    staffToolkit: "all",
    seatToolNames: ["get_team_board", "get_team_assignment_rules", "get_agent_coaching_brief"],
    batchData: true,
    rentCast: true,
    customerPersonaToolsForContact: true,
    asks: [
      ...STAFF_ASKS,
      "how the team is doing this week — production, open deals, unworked leads (get_team_board)",
      "which assignment rules route leads to the team and whether they're firing (get_team_assignment_rules)",
      "a coaching brief for one of their agents before a 1:1 (get_agent_coaching_brief)",
    ],
    followUps: [
      ...STAFF_FOLLOW_UPS,
      "pull the team board before the weekly 1:1s and flag unworked leads (get_team_board)",
      "prepare a coaching brief for the agent they name (get_agent_coaching_brief)",
    ],
    rules: [
      ...STAFF_RULES,
      "The team board is THEIR team only — never another team's agents, never the brokerage's books (m472).",
    ],
  },
  broker_admin: {
    label: "Broker / admin / compliance officer copilot",
    audience: "a broker, broker owner/admin, office admin or compliance officer administering the brokerage",
    staffToolkit: "all",
    seatToolNames: ["get_setup_readiness", "get_billing_summary", "get_compliance_summary"],
    batchData: true,
    rentCast: true,
    customerPersonaToolsForContact: true,
    asks: [
      ...STAFF_ASKS,
      "what's still not set up for the brokerage to run autonomously (get_setup_readiness)",
      "where the subscription stands — plan, period, seats, trial (get_billing_summary — a READ; changes happen in Billing)",
      "open compliance flags by severity and what's waiting for approval (get_compliance_summary)",
    ],
    followUps: [
      ...STAFF_FOLLOW_UPS,
      "walk through what is still not set up for the brokerage to run autonomously (get_setup_readiness)",
      "summarise where the subscription stands before a billing decision — read only (get_billing_summary)",
      "list the open compliance flags by severity so the officer can clear them (get_compliance_summary)",
    ],
    rules: [
      ...STAFF_RULES,
      "Billing here is read-only — seats, plan changes and vendor charges are made in the Billing screens, never by the copilot.",
    ],
  },
  vendor: {
    label: "Vendor portal assistant",
    audience: "a vendor company's user (users.user_type='vendor') — an inspector, contractor, stager, photographer, mover… on the brokerage's bench",
    staffToolkit: "none",
    seatToolNames: [
      "get_my_vendor_status",
      "get_my_jobs_and_bookings",
      "get_my_documents",
      "get_my_ratings",
      "respond_to_booking",
      "update_my_service_area",
      "update_my_availability",
      "send_vendor_message_to_agent",
    ],
    batchData: false,
    rentCast: false,
    customerPersonaToolsForContact: false,
    asks: [
      "where a placement, assignment or job stands, and what's scheduled next (get_my_vendor_status / get_my_jobs_and_bookings)",
      "whether an invoice was received / paid and when a payout lands (get_my_vendor_status)",
      "which documents, W-9 / insurance / licence items are on file or missing (get_my_documents)",
      "how they're rated and what reviewers said, so they can respond (get_my_ratings)",
      "accepting or declining a new booking, with a date (respond_to_booking)",
      "adding a state / ZIP they now cover, or their typical turnaround (update_my_service_area / update_my_availability)",
      "getting a note to the agent on a job (send_vendor_message_to_agent)",
    ],
    followUps: [
      "accept or decline the booking they are looking at, with a date (respond_to_booking)",
      "send the agent a note on the job — a delay, a question, a completed visit (send_vendor_message_to_agent)",
      "update their service area or turnaround so they get matched to more jobs (update_my_service_area / update_my_availability)",
      "point them at the missing W-9 / insurance / licence item so payouts are not held (get_my_documents)",
    ],
    rules: [
      "Their OWN vendor account only — never another vendor's jobs, invoices or payouts, and never a contact's or the brokerage's financials (CLAUDE.md §5).",
      "Never quote or negotiate a price on the brokerage's behalf; a price question goes to the agent.",
      "No property lookups, no lead or contact search — this seat has no such tool.",
    ],
  },
  lender: {
    label: "Lender portal assistant",
    audience: "a loan officer at a lender VENDOR (vendors.category lender / refinance_lender) assigned to the brokerage's transactions",
    staffToolkit: "none",
    seatToolNames: [
      "get_my_loan_pipeline",
      "update_loan_status",
      "flag_loan_issue",
      "list_transaction_documents",
      "send_lender_message_to_agent",
    ],
    batchData: false,
    rentCast: false,
    customerPersonaToolsForContact: false,
    asks: [
      "which of their deals are open and where each loan stands — pre-approval, rate lock and its expiry, appraisal, underwriting, clear-to-close (get_my_loan_pipeline)",
      "moving a loan's status forward or noting a rate-lock (update_loan_status)",
      "flagging a condition or issue the agent needs to act on (flag_loan_issue)",
      "which documents are on a deal and which are still unsigned or missing (list_transaction_documents)",
      "getting a note to the agent on a deal (send_lender_message_to_agent)",
    ],
    followUps: [
      "record the loan status or rate-lock they just described (update_loan_status)",
      "flag the condition the agent needs to act on before it slips (flag_loan_issue)",
      "send the agent a note on the deal (send_lender_message_to_agent)",
      "list the documents still unsigned or missing on the file (list_transaction_documents)",
    ],
    rules: [
      "Only transactions their lender vendor is ASSIGNED to (vendor_assignments) — never another lender's deals, never a borrower they are not on.",
      "Clear-to-close is issued from the portal's own action with its checks — not from this chat.",
      "No property lookups, no contact search — this seat has no such tool.",
    ],
  },
  title: {
    label: "Title / escrow portal assistant",
    audience: "a title or escrow officer (title_company_users, or a vendors.category='title' seat) on the brokerage's closings",
    staffToolkit: "none",
    seatToolNames: ["get_my_title_transactions", "update_title_status", "send_title_message_to_agent"],
    batchData: false,
    rentCast: false,
    customerPersonaToolsForContact: false,
    asks: [
      "which closings they're on and each one's title search / commitment / closing-scheduled dates and open title issues (get_my_title_transactions)",
      "moving a file's title status forward — title search, commitment issued, closing ready, closed (update_title_status)",
      "getting a note to the agent on a closing (send_title_message_to_agent)",
    ],
    followUps: [
      "move the file's title status forward as they report it (update_title_status)",
      "send the agent a note on the closing — a title issue, a scheduling change (send_title_message_to_agent)",
    ],
    rules: [
      "Only transactions their title company is on (title_company_users.transaction_id) — never another file.",
      "Earnest money and wire details are never spoken or changed here (wire-fraud posture); the portal's own screens handle them.",
    ],
  },
  platform_staff: {
    label: "Platform staff copilot",
    audience: "platform staff (users.platform_role) supporting every tenant",
    staffToolkit: "all",
    seatToolNames: [],
    batchData: true,
    rentCast: true,
    customerPersonaToolsForContact: false,
    asks: [
      "which tenants, system errors and AI feedback need attention from the context",
      "explaining a platform feature or process",
    ],
    followUps: [
      "draft the tenant-facing reply for their review (draft_ai_reply)",
      "open the tenant's setup readiness / billing / compliance read so support sees what the broker sees (get_setup_readiness / get_billing_summary / get_compliance_summary)",
    ],
    rules: [
      "Support-investigation posture: read broadly, act narrowly; impersonation is a grant that walks the account and never exceeds it (CLAUDE.md §5).",
    ],
  },
}

/** Every seat tool name the table promises, deduplicated — the proof holds
 *  this against user-type-tools.ts's builder registry (no phantom promise). */
export const USER_TYPE_SEAT_TOOL_NAMES: readonly string[] = [
  ...new Set(USER_TYPE_SEATS.flatMap((s) => USER_TYPE_TOOL_POLICY[s].seatToolNames)),
]

// ─── SELECTION (pure) ───────────────────────────────────────────────────────

export interface SeatToolParts {
  /** The route's full staff toolkit (agentTools). */
  staffTools: Record<string, unknown>
  /** user-type-tools.ts's already-built seat tools for this seat. */
  seatTools: Record<string, unknown>
  /** BatchData tools, ALREADY tier-filtered by the caller. */
  batchDataTools: Record<string, unknown>
  rentCastTools: Record<string, unknown>
  /** The customer free bundle for the contact the copilot is acting for, if any. */
  customerTools: Record<string, unknown>
}

/**
 * PURE — the ONE selection every mounting surface builds its `tools:` map
 * through. Applies the seat's policy: staff toolkit only when "all"; seat
 * tools only those the table names (a builder the table does not name for
 * this seat never mounts, even if the caller built it); BatchData/RentCast
 * only when the policy allows; the customer bundle only when the seat may
 * act for a contact. Seat tools are spread LAST so a seat tool can never be
 * shadowed by a same-named staff tool.
 */
export function selectToolsForSeat(seat: UserTypeSeat, parts: SeatToolParts): Record<string, unknown> {
  const policy = USER_TYPE_TOOL_POLICY[seat]
  const out: Record<string, unknown> = {}
  if (policy.staffToolkit === "all") Object.assign(out, parts.staffTools)
  if (policy.rentCast) Object.assign(out, parts.rentCastTools)
  if (policy.batchData) Object.assign(out, parts.batchDataTools)
  if (policy.customerPersonaToolsForContact) Object.assign(out, parts.customerTools)
  for (const name of policy.seatToolNames) {
    if (name in parts.seatTools) out[name] = parts.seatTools[name]
  }
  return out
}

// ─── PROMPT (pure) ──────────────────────────────────────────────────────────

/**
 * PURE — the compact seat block every mounting surface appends to its system
 * prompt: who is talking, what they usually ask, which seat tools exist
 * (named exactly, so the model never promises one that is not mounted) and
 * the seat's hard rules. `mountedSeatTools` lets the block list only the
 * tools that actually mounted (a partner seat whose identity failed closed
 * reads "none — say the agent will follow up").
 */
export function seatPromptBlock(seat: UserTypeSeat, mountedSeatTools: readonly string[] = USER_TYPE_TOOL_POLICY[seat].seatToolNames): string {
  const p = USER_TYPE_TOOL_POLICY[seat]
  const lines = [
    `WHO YOU ARE TALKING TO — ${p.label.toUpperCase()}: ${p.audience}.`,
    "WHAT THIS PERSON USUALLY ASKS (answer from the context or the tools below):",
    ...p.asks.map((a) => `- ${a}`),
  ]
  if (p.seatToolNames.length > 0) {
    lines.push(
      mountedSeatTools.length > 0
        ? `SEAT TOOLS AVAILABLE ON THIS SESSION: ${mountedSeatTools.join(", ")}.`
        : "SEAT TOOLS AVAILABLE ON THIS SESSION: none — this account is not linked to a vendor/partner record yet; answer from the context and say the agent will follow up.",
    )
  }
  if (p.staffToolkit === "none") {
    lines.push("You have NO contact search, NO CRM write tools and NO property-data tools on this seat — never claim to have looked something up you could not.")
  }
  // Lane 79B — the seat's own follow-up menu: what to OFFER next, never a sale.
  lines.push("WHAT TO OFFER NEXT (one that fits, never several):", ...p.followUps.map((f) => `- ${f}`))
  lines.push("RULES FOR THIS SEAT:", ...p.rules.map((r) => `- ${r}`))
  return lines.join("\n")
}
