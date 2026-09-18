// lib/onboarding/setup-readiness.ts
//
// ROLE-AWARE SETUP READINESS — the single, unifying answer to "what do I still need to fill out to do my
// job here, and how does this platform work for me?" The app collects setup across ~24 tables and many
// forms, "onboarded?" was answered four different ways, and no role had a plain-English overview. This is
// the consolidating READ layer: ONE pure spec of what each role must (required) and may (optional) configure,
// each item DETECTED against the REAL settings/identity tables (never a new 5th status column), plus a
// per-role platform overview. Surfaced as a dashboard card + the /dashboard/getting-started page, wired for
// every human role.
//
// Pure spec + resolver here (unit-testable); loadSetupReadiness does the I/O.

import { createServiceClient } from "@/lib/supabase/service"
import type { Tier } from "@/lib/education/onboarding-curriculum"

export type SetupRole =
  | "agent" | "team_lead" | "isa" | "tc" | "compliance_officer"
  | "broker" | "admin" | "superadmin" | "vendor" | "lender"

/** Subscription tier drives WHICH setup steps apply (reuses the canonical Tier). */
export type SetupTier = Tier // "solo_agent" | "team" | "brokerage" | "multi_location"

/**
 * Roles whose onboarding is OPTIONAL — they can use the app immediately without completing setup.
 * Every other onboarding role must finish its required steps. (Business rule.)
 */
const OPTIONAL_ONBOARDING_ROLES = new Set<SetupRole>(["tc", "isa", "compliance_officer"])
/** Roles that are NOT part of onboarding at all — no setup checklist (overview only). (Business rule.) */
const NON_ONBOARDING_ROLES = new Set<SetupRole>(["vendor", "lender", "superadmin"])

/**
 * Map the app's many role/user_type strings (+ legacy aliases) onto the 10 canonical setup roles.
 *
 * `SetupRole` is an OVERVIEW BUCKET, not the users.user_type vocabulary — the two
 * are deliberately different sets (this one has no 'contact', no 'system', no
 * 'support'). "lender" survives here as a bucket even though 'lender' is no longer
 * a storable user_type (owner ruling, 2026-09-04: lender is a vendor CATEGORY):
 * a lender seats as user_type 'vendor' and lands on the "vendor" bucket, which is
 * in NON_ONBOARDING_ROLES exactly like this one, so the behaviour is identical.
 * The 'lender'/'title_agent' aliases below are kept for legacy inputs (the
 * `user_role_assignments.role` grant still spells 'lender', and that column has no
 * CHECK) — they are an alias table, not a claim about what the column stores.
 */
export function normalizeSetupRole(userType: string | null | undefined): SetupRole {
  switch ((userType ?? "").toLowerCase()) {
    case "broker": case "broker_owner": return "broker"
    case "admin": case "broker_admin": return "admin"
    case "superadmin": case "super_admin": case "support": return "superadmin"
    case "tc": case "transaction_coordinator": return "tc"
    case "compliance_officer": case "compliance_manager": return "compliance_officer"
    case "team_lead": case "team_leader": case "teamlead": return "team_lead"
    case "isa": return "isa"
    case "vendor": return "vendor"
    case "lender": case "title_agent": return "lender"
    default: return "agent"
  }
}

export type SetupCategory = "identity" | "compliance" | "ai" | "integrations" | "brokerage" | "team" | "growth"

/** A snapshot of the user's REAL configured state, read from the existing tables. Every field is honest. */
export interface SetupSnapshot {
  // agent / personal
  hasLicense: boolean
  hasEoInsurance: boolean
  hasVoiceClone: boolean
  hasAvatar: boolean
  hasOutreachChannel: boolean   // an active email/calendar OR phone connection
  hasMobilePhone: boolean
  hasProfilePhoto: boolean
  hasPersonalWebsite: boolean
  hasEmailSignature: boolean
  hasSocialAccount: boolean
  hasPayoutAccount: boolean
  hasMotto: boolean             // personal motto/tagline (brand_voice_profile.tagline)
  hasAdditionalBrand: boolean   // brand voice mission / key messages the AI can learn from
  hasAssistantVoice: boolean    // how the agent HEARS the AI (agents.assistant_voice_id / voice_preference)
  hasCommissionContract: boolean // the agent's own commission split (agents.commission_split) — solo tier sets it
  hasEmailOrCalendar: boolean   // staff self-connect surface
  // agent integrations (Connection Center)
  hasCalendar: boolean
  hasMls: boolean               // platform_credentials scope='listing'
  hasCrm: boolean
  hasTransactionEsign: boolean
  hasPodcast: boolean
  hasFinance: boolean           // financial / expense provider
  hasAdManager: boolean         // marketing / ad manager
  hasGoogleBusiness: boolean
  // brokerage
  hasBrokerageLicense: boolean
  hasBrokerageContact: boolean  // brokerage phone/email/website
  hasBranding: boolean
  hasCommissionStructure: boolean
  hasEmailProvider: boolean
  hasSmsProvider: boolean
  hasTeamMembers: boolean
  hasIsaPhone: boolean
  hasAccountingSync: boolean
  hasRecruitingPitch: boolean
  hasOfficeLocations: boolean   // multi-location: ≥1 office set up
  // team
  hasTeamConfig: boolean
  hasTeamBrand: boolean         // team logo/colors (teams.logo_url / primary_color)
}

const EMPTY_SNAPSHOT: SetupSnapshot = {
  hasLicense: false, hasEoInsurance: false, hasVoiceClone: false, hasAvatar: false, hasOutreachChannel: false,
  hasMobilePhone: false, hasProfilePhoto: false, hasPersonalWebsite: false, hasEmailSignature: false,
  hasSocialAccount: false, hasPayoutAccount: false, hasMotto: false, hasAdditionalBrand: false,
  hasAssistantVoice: false, hasCommissionContract: false, hasEmailOrCalendar: false,
  hasCalendar: false, hasMls: false, hasCrm: false, hasTransactionEsign: false, hasPodcast: false,
  hasFinance: false, hasAdManager: false, hasGoogleBusiness: false,
  hasBrokerageLicense: false, hasBrokerageContact: false, hasBranding: false, hasCommissionStructure: false,
  hasEmailProvider: false, hasSmsProvider: false, hasTeamMembers: false, hasIsaPhone: false,
  hasAccountingSync: false, hasRecruitingPitch: false, hasOfficeLocations: false,
  hasTeamConfig: false, hasTeamBrand: false,
}

export interface SetupItem {
  key: string
  label: string
  roles: SetupRole[]
  required: boolean
  category: SetupCategory
  /** Plain-English "why this matters" for the role. */
  why: string
  /** Deep-link to the EXISTING settings surface that fills it. */
  href: string
  /** Subscription tiers this item applies to. Omit = all tiers. */
  tiers?: SetupTier[]
  detect: (s: SetupSnapshot) => boolean
}

const AGENTISH: SetupRole[] = ["agent", "team_lead"]
const TEAMISH: SetupTier[] = ["team", "brokerage", "multi_location"]
/**
 * "A tenancy with more than one seat to fill." TEAM IS ONE (owner ruling).
 *
 * This was `["brokerage", "multi_location"]` — the SECOND spelling of "org
 * tier" in the codebase, and it disagreed with the first:
 * `lib/onboarding/critical-setup.ts` ORG_TIERS has always been `["team",
 * "brokerage", "multi_location"]`. So the same tenant was told by one
 * onboarding surface that inviting staff was a required setup step and by the
 * other that it did not apply to them. Two spellings of one idea is a defect,
 * not a style choice (CLAUDE.md §6) — merged onto the wider one, which is also
 * the correct one: a team subscription has FIVE seats, so "invite agents &
 * staff" and "set your recruiting pitch" are real, fillable steps for it.
 *
 * Solo stays out, and that is not a tier denial: a solo tenant's 2 seats and
 * its own `commission_contract` item cover it, and nothing here GATES anything
 * — this catalogue only decides which checklist rows render.
 */
const ORG: SetupTier[] = ["team", "brokerage", "multi_location"]

/**
 * THE CATALOG — every user-fillable setup item, mapped to role + tier + required/optional + the real
 * detector. Business rules baked in: for agent / team_lead / broker / admin the substantive steps are
 * REQUIRED; a short elective tail (social, payout) stays optional by nature; tc / isa / compliance are
 * forced optional at resolve time; vendors / lenders are not part of onboarding at all. Order matters:
 * `nextAction` returns the first unfinished REQUIRED item in this order.
 */
export const SETUP_ITEMS: SetupItem[] = [
  // ── Agent / team lead: everything needed to transact + have the AI team work for them (all required) ──
  { key: "license", label: "Add your real-estate license", roles: AGENTISH, required: true, category: "compliance",
    why: "You can't put a document out for signature until your license is on file — the compliance gate blocks it.",
    href: "/dashboard/onboarding/license", detect: (s) => s.hasLicense },
  { key: "eo_insurance", label: "Add your E&O insurance", roles: AGENTISH, required: true, category: "compliance",
    why: "Errors & Omissions coverage is required to transact and protects you on every deal.",
    href: "/dashboard/onboarding/license", detect: (s) => s.hasEoInsurance },
  { key: "mobile_phone", label: "Add your mobile number", roles: AGENTISH, required: true, category: "identity",
    why: "Your AI ISA and clients reach you here — and it stamps your outreach as really from you.",
    href: "/dashboard/profile", detect: (s) => s.hasMobilePhone },
  { key: "outreach_channel", label: "Connect email or phone", roles: AGENTISH, required: true, category: "integrations",
    why: "Connect at least one channel so your managers can actually send the drafts they prepare for you.",
    href: "/settings/connections", detect: (s) => s.hasOutreachChannel },
  { key: "voice_clone", label: "Create your voice twin", roles: AGENTISH, required: true, category: "ai",
    why: "Your ElevenLabs voice clone lets the AI ISA call and your videos speak in YOUR voice — the core differentiator.",
    href: "/dashboard/settings/twin-studio", detect: (s) => s.hasVoiceClone },
  { key: "avatar", label: "Set up your video avatar", roles: AGENTISH, required: true, category: "ai",
    why: "A D-ID avatar turns listing + market updates into personal on-camera videos without you filming.",
    href: "/dashboard/settings/twin-studio", detect: (s) => s.hasAvatar },
  { key: "assistant_voice", label: "Choose your assistant voice", roles: AGENTISH, required: true, category: "ai",
    why: "Pick how you HEAR your AI assistant — your own cloned voice or a chosen one.",
    href: "/dashboard/settings/assistant", detect: (s) => s.hasAssistantVoice },
  { key: "commission_contract", label: "Set your commission contract", roles: ["agent"], required: true, category: "brokerage", tiers: ["solo_agent"],
    why: "As a solo agent you set your own commission split so deals compute your payout and P&L. (On a team/brokerage, your admin sets this for you.)",
    href: "/settings/commission", detect: (s) => s.hasCommissionContract },
  { key: "profile_photo", label: "Add a profile photo", roles: AGENTISH, required: true, category: "identity",
    why: "Your headshot brands every video outro, portal, and public page.",
    href: "/dashboard/profile", detect: (s) => s.hasProfilePhoto },
  { key: "email_signature", label: "Set your email signature", roles: AGENTISH, required: true, category: "identity",
    why: "Signs the emails your managers send on your behalf.",
    href: "/dashboard/profile", detect: (s) => s.hasEmailSignature },
  { key: "agent_motto", label: "Set your personal motto / tagline", roles: AGENTISH, required: false, category: "growth",
    why: "Your own motto rides on your postcards, videos, and pages — a solo agent's line wins over the team/brokerage tagline.",
    href: "/settings/brand-voice", detect: (s) => s.hasMotto },
  { key: "additional_brand", label: "Add brand details for the AI to learn from", roles: AGENTISH, required: false, category: "growth",
    why: "Your mission + key messages teach the AI to write and speak in your voice across everything it drafts.",
    href: "/settings/brand-voice", detect: (s) => s.hasAdditionalBrand },
  { key: "personal_website", label: "Add your personal website", roles: AGENTISH, required: false, category: "growth",
    why: "Links from your marketing and QR codes back to your own site.",
    href: "/dashboard/profile", detect: (s) => s.hasPersonalWebsite },
  { key: "social_accounts", label: "Connect social accounts", roles: AGENTISH, required: false, category: "growth",
    why: "Lets the Campaign Orchestrator publish approved posts to your channels.",
    href: "/dashboard/profile", detect: (s) => s.hasSocialAccount },
  { key: "payout", label: "Connect a payout account", roles: AGENTISH, required: false, category: "integrations",
    why: "Stripe Connect routes referral and revenue-share payouts to you.",
    href: "/settings/connections", detect: (s) => s.hasPayoutAccount },
  // ── Agent integrations (Connection Center) — bring your own tools in. All optional add-ons. ──
  { key: "calendar", label: "Connect your calendar", roles: AGENTISH, required: false, category: "integrations",
    why: "Syncs showings, appointments, and closings so nothing double-books.",
    href: "/settings/connections", detect: (s) => s.hasCalendar },
  { key: "mls", label: "Connect your MLS / IDX", roles: AGENTISH, required: false, category: "integrations",
    why: "Pulls live listings + comps so your CMAs, videos, and buyer matches use real inventory.",
    href: "/settings/connections", detect: (s) => s.hasMls },
  { key: "crm", label: "Connect your CRM", roles: AGENTISH, required: false, category: "integrations",
    why: "Two-way sync with your existing CRM so contacts and activity stay in one place.",
    href: "/settings/connections", detect: (s) => s.hasCrm },
  { key: "transaction_esign", label: "Connect transaction & e-sign", roles: AGENTISH, required: false, category: "integrations",
    why: "Lets the Deal Coordinator send documents for signature and track them to close.",
    href: "/settings/connections", detect: (s) => s.hasTransactionEsign },
  { key: "ad_manager", label: "Connect your ad manager", roles: AGENTISH, required: false, category: "growth",
    why: "Lets the Ads Manager run + optimize paid campaigns on your accounts.",
    href: "/settings/connections", detect: (s) => s.hasAdManager },
  { key: "google_business", label: "Connect Google Business Profile", roles: AGENTISH, required: false, category: "growth",
    why: "Posts updates + reviews to your GBP so your local presence stays fresh.",
    href: "/dashboard/profile", detect: (s) => s.hasGoogleBusiness },
  { key: "podcast", label: "Connect podcast syndication", roles: AGENTISH, required: false, category: "growth",
    why: "Publishes your AI-produced episodes to your podcast host automatically.",
    href: "/settings/connections", detect: (s) => s.hasPodcast },
  { key: "finance", label: "Connect finance / expense software", roles: AGENTISH, required: false, category: "integrations",
    why: "Syncs commissions + expenses so your income truth and P&L stay accurate.",
    href: "/settings/connections", detect: (s) => s.hasFinance },
  { key: "team_config", label: "Configure your team split", roles: ["team_lead"], required: true, category: "team", tiers: TEAMISH,
    why: "Set your team's split so production and P&L roll up correctly for your agents.",
    href: "/dashboard/settings/teams", detect: (s) => s.hasTeamConfig },
  { key: "team_brand", label: "Set your team logo & colors", roles: ["team_lead"], required: true, category: "team", tiers: TEAMISH,
    why: "Your team brand overrides the brokerage's on your team's videos, postcards, and pages — agents inherit it.",
    href: "/dashboard/settings/teams", detect: (s) => s.hasTeamBrand },

  // ── Broker / admin: the org foundations. Also the admin who runs a SOLO agent's setup (all tiers). ──
  { key: "brokerage_license", label: "Add license & address", roles: ["broker", "admin"], required: true, category: "brokerage",
    why: "Your license and details appear on compliance docs and every agent's disclosures.",
    href: "/dashboard/settings", detect: (s) => s.hasBrokerageLicense },
  { key: "brokerage_contact", label: "Add brokerage phone, email & website", roles: ["broker", "admin"], required: false, category: "brokerage",
    why: "Optional contact details that appear on your brand footer, portal, and outreach.",
    href: "/dashboard/settings", detect: (s) => s.hasBrokerageContact },
  { key: "branding", label: "Set the brand (logo & colors)", roles: ["broker", "admin"], required: true, category: "brokerage",
    why: "The logo and colors brand every video, page, postcard, and portal.",
    href: "/settings/branding", detect: (s) => s.hasBranding },
  { key: "commission_structure", label: "Set up each agent's commission", roles: ["broker", "admin"], required: true, category: "brokerage",
    why: "Admins set the commission plan for each agent per their subscription tier — required before deals compute payouts and P&L.",
    href: "/settings/commission", detect: (s) => s.hasCommissionStructure },
  { key: "email_provider", label: "Configure an email sender", roles: ["broker", "admin"], required: true, category: "integrations",
    why: "An email sender lets managers deliver approved client messages for agents who haven't self-connected.",
    href: "/settings/providers", detect: (s) => s.hasEmailProvider },
  { key: "sms_provider", label: "Configure SMS / voice", roles: ["broker", "admin"], required: true, category: "integrations",
    why: "Twilio/Telnyx powers texting and the AI ISA's calls.",
    href: "/settings/providers", detect: (s) => s.hasSmsProvider },
  // Inviting a team + offices only apply to org tiers (a solo agent has no team to invite).
  { key: "invite_team", label: "Invite agents & staff", roles: ["broker", "admin"], required: true, category: "team", tiers: ORG,
    why: "Invite agents and staff so the AI team can start working their pipelines.",
    href: "/dashboard/admin/users", detect: (s) => s.hasTeamMembers },
  { key: "office_locations", label: "Set up your office locations", roles: ["broker", "admin"], required: true, category: "brokerage", tiers: ["multi_location"],
    why: "Multi-location brokerages scope agents, teams, and roll-ups per office — set them up so per-office reporting works.",
    href: "/dashboard/admin/users", detect: (s) => s.hasOfficeLocations },
  { key: "isa_phone", label: "Provision an AI ISA phone number", roles: ["broker", "admin"], required: false, category: "ai",
    why: "A dedicated number lets the AI ISA call and qualify leads around the clock.",
    href: "/dashboard/settings/isa-calling", detect: (s) => s.hasIsaPhone },
  { key: "recruiting_pitch", label: "Set your recruiting pitch", roles: ["broker", "admin"], required: false, category: "growth", tiers: ORG,
    why: "Powers the Recruiting Manager's outreach to the agents you want to attract.",
    // /dashboard/recruiting never had a page.tsx, so this checklist item sent the
    // broker to a 404 — and brokerages.recruiting_pitch had no writer anywhere, so
    // the item could never be completed either. Both halves are fixed: the editor is
    // app/dashboard/recruiting-roi/recruiting-pitch-panel.tsx (Pipeline tab), on the
    // canonical recruiting surface that /admin/recruiting-hub was retired into.
    href: "/dashboard/recruiting-roi", detect: (s) => s.hasRecruitingPitch },
  { key: "accounting", label: "Connect accounting (QuickBooks/Xero)", roles: ["broker", "admin"], required: false, category: "integrations",
    why: "Syncs commissions and expenses so your P&L is always current.",
    href: "/settings/accounting", detect: (s) => s.hasAccountingSync },

  // ── Staff (ISA / TC / Compliance): self-connect essentials — OPTIONAL onboarding (forced at resolve). ──
  { key: "staff_email", label: "Connect your email & calendar", roles: ["isa", "tc", "compliance_officer"], required: false, category: "integrations",
    why: "Connect your inbox and calendar so your handoffs, tasks, and closings stay in sync.",
    href: "/settings/connections", detect: (s) => s.hasEmailOrCalendar },
]

export interface ResolvedSetupItem extends Omit<SetupItem, "detect"> { done: boolean }

export interface RoleOverview {
  /** One line: what this role is here to accomplish. */
  mission: string
  /** The AI managers working alongside this role. */
  aiTeam: string[]
  /** What they can do the moment setup is done. */
  youCanNow: string[]
}

export interface SetupReadiness {
  role: SetupRole
  tier: SetupTier
  items: ResolvedSetupItem[]
  requiredTotal: number
  requiredDone: number
  optionalTotal: number
  optionalDone: number
  /** % of REQUIRED items complete (0..100). Optional items never block. */
  pct: number
  /** First unfinished required item (the "do this next"), or null when required setup is complete. */
  nextAction: ResolvedSetupItem | null
  isComplete: boolean
  overview: RoleOverview
}

/**
 * PURE: resolve the role's items for its subscription tier against a snapshot → completion, next action,
 * and the platform overview. Applies the business rules: tc/isa/compliance items are forced OPTIONAL; roles
 * not part of onboarding (vendor/lender/superadmin) get NO checklist; items are filtered by tier.
 */
export function resolveSetupReadiness(role: SetupRole, snapshot: SetupSnapshot, tier: SetupTier = "brokerage"): SetupReadiness {
  const optionalRole = OPTIONAL_ONBOARDING_ROLES.has(role)
  const items: ResolvedSetupItem[] = NON_ONBOARDING_ROLES.has(role)
    ? []
    : SETUP_ITEMS
        .filter((i) => i.roles.includes(role) && (!i.tiers || i.tiers.includes(tier)))
        // Business rule: for tc/isa/compliance every step is optional (they can work without finishing setup).
        .map(({ detect, required, ...rest }) => ({ ...rest, required: optionalRole ? false : required, done: detect(snapshot) }))

  const required = items.filter((i) => i.required)
  const optional = items.filter((i) => !i.required)
  const requiredDone = required.filter((i) => i.done).length
  const optionalDone = optional.filter((i) => i.done).length
  const pct = required.length === 0 ? 100 : Math.round((requiredDone / required.length) * 100)
  const nextAction = required.find((i) => !i.done) ?? optional.find((i) => !i.done) ?? null

  return {
    role, tier, items,
    requiredTotal: required.length, requiredDone,
    optionalTotal: optional.length, optionalDone,
    pct, nextAction, isComplete: requiredDone === required.length,
    overview: ROLE_OVERVIEW[role],
  }
}

/** Per-role plain-English platform overview — the "what is this and how do I work here" every role was missing. */
export const ROLE_OVERVIEW: Record<SetupRole, RoleOverview> = {
  agent: {
    mission: "Turn leads into clients into closed deals — with an AI team doing the busywork so you sell.",
    aiTeam: ["AI ISA qualifies & calls your leads", "Shopping Agent runs the buyer journey", "Listing Concierge runs your sellers", "Deal Coordinator drives deals to close", "Sphere Manager keeps past clients for life"],
    youCanNow: ["Approve AI-drafted texts, emails & videos in one place", "Send listing & market videos in your own voice", "See your ranked next-best actions every morning"],
  },
  team_lead: {
    mission: "Everything an agent does, plus lead a team — balance capacity, mentor, and grow team production.",
    aiTeam: ["Your agents' AI managers roll up to you", "Recruiting Manager helps you add & keep talent", "Finance Manager gives you team P&L"],
    youCanNow: ["See team pipeline, fatigue & coaching signals", "Set team splits so P&L rolls up right", "Get the weekly ranked team plan"],
  },
  isa: {
    mission: "Qualify inbound leads fast and hand warm ones to agents — with the AI ISA multiplying your reach.",
    aiTeam: ["AI ISA auto-calls & texts new leads", "Data Steward keeps lead identity clean", "Shopping Agent picks up your handoffs"],
    youCanNow: ["Watch the AI qualify leads 24/7", "Approve dial batches for your hottest leads", "Hand off qualified leads with full context"],
  },
  tc: {
    mission: "Drive every deal to close — catch missing docs, at-risk deals, and stalled closings before they slip.",
    aiTeam: ["Deal Coordinator flags at-risk deals & missing docs", "Compliance Officer pre-flights every document", "Finance Manager tracks the closing financials"],
    youCanNow: ["See closings due this week & what's blocking them", "Clear interventions from one queue", "Keep every file audit-ready"],
  },
  compliance_officer: {
    mission: "Keep the brokerage clean — triage the compliance queue, clear violations, and approve CDAs.",
    aiTeam: ["Compliance Officer AI pre-screens all outbound", "Data Steward enforces consent & DNC", "Deal Coordinator routes CDAs to you"],
    youCanNow: ["Work a prioritized compliance queue", "Approve/deny CDAs & released-over-objection items", "See license & TRID readiness at a glance"],
  },
  broker: {
    mission: "Run the brokerage — recruit & retain agents, oversee compliance & finances, and grow the business.",
    aiTeam: ["All 14 managers report to your Command Center", "Recruiting Manager works your talent pipeline", "Finance Manager runs brokerage P&L", "The AI Executive Standup ranks your week"],
    youCanNow: ["Approve the whole team's AI work in one place", "See the weekly ROI-ranked org plan + one ask", "Watch retention, recruiting & P&L boards live"],
  },
  admin: {
    mission: "Stand up and run the brokerage's configuration — users, branding, providers, billing, and setup.",
    aiTeam: ["Managers you configure work every pipeline", "Data Steward guards data integrity", "Finance Manager needs your commission setup"],
    youCanNow: ["Invite the team & assign roles", "Configure branding, providers & commissions", "Open the Command Center once setup is done"],
  },
  superadmin: {
    mission: "Operate the platform above every brokerage — providers, channels, and tenant health.",
    aiTeam: ["Every brokerage's managers run on your platform config", "Locked to D-ID + ElevenLabs by design"],
    youCanNow: ["Set platform video/voice providers", "Enable direct-mail & video channels", "Oversee all tenants"],
  },
  vendor: {
    mission: "Deliver your assigned jobs on time — inspections, staging, photography, lending, and more.",
    aiTeam: ["Vendor coordination routes jobs to you", "Compliance keeps RESPA-safe referrals clean"],
    youCanNow: ["See open, due-soon & overdue jobs", "Sync your calendar for real availability", "Build your portfolio to win more work"],
  },
  lender: {
    mission: "Move loan files to clear-to-close — track active loans, closings, and stalled files.",
    aiTeam: ["Deal Coordinator shares transaction milestones", "Finance Manager tracks closing financials"],
    youCanNow: ["See active loans & closings this week", "Catch stalled files early", "Stay in sync on every shared deal"],
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// I/O — gather the REAL snapshot from the existing tables (role-gated so we never over-query), then resolve.

export async function loadSetupReadiness(params: {
  userId: string
  role: SetupRole
  brokerageId: string | null
  agentId: string | null
  client?: ReturnType<typeof createServiceClient>
}): Promise<SetupReadiness> {
  const svc = params.client ?? createServiceClient()
  const { role, userId, brokerageId, agentId } = params
  const snap: SetupSnapshot = { ...EMPTY_SNAPSHOT }
  let tier: SetupTier = "brokerage"
  const isAgentish = role === "agent" || role === "team_lead"
  const isBrokerAdmin = role === "broker" || role === "admin"
  const isStaff = role === "isa" || role === "tc" || role === "compliance_officer"

  const has = (r: { data: unknown } | { count: number | null }) => {
    if ("count" in r) return (r.count ?? 0) > 0
    return Array.isArray((r as any).data) ? (r as any).data.length > 0 : !!(r as any).data
  }

  try {
    // Subscription tier drives which steps apply (canonical: brokerages.plan_tier).
    if (brokerageId) {
      const { data: planRow } = await svc.from("brokerages").select("plan_tier").eq("id", brokerageId).maybeSingle()
      const pt = (planRow as any)?.plan_tier as string | null
      if (pt === "solo_agent" || pt === "team" || pt === "brokerage" || pt === "multi_location") tier = pt
    }

    // Personal (agent/team_lead) reads.
    if (isAgentish && agentId) {
      const [lic, voice, apiCred, agentCreds, social, agentRow, brand] = await Promise.all([
        svc.from("agent_licenses").select("license_number, eo_policy_number").eq("agent_id", agentId).limit(1),
        svc.from("agent_voice_profiles").select("elevenlabs_voice_id, did_avatar_id").eq("agent_id", agentId).limit(5),
        svc.from("agent_api_credentials").select("service_type").eq("agent_id", agentId).eq("is_active", true).in("service_type", ["email", "calendar"]).limit(10),
        // ALL of the agent's Connection Center creds in one pull — scope tells us which domain each is.
        svc.from("platform_credentials").select("scope, platform").eq("owner_type", "agent").eq("owner_id", agentId).eq("is_active", true).limit(50),
        svc.from("social_media_accounts").select("platform").eq("agent_id", agentId).eq("is_active", true).limit(50),
        svc.from("agents").select("phone_mobile, profile_image_url, voice_id, assistant_voice_id, avatar_id, assistant_avatar_id, voice_preference, commission_split").eq("id", agentId).maybeSingle(),
        svc.from("brand_voice_profile").select("tagline, mission_statement, key_brand_messages").eq("agent_id", agentId).maybeSingle(),
      ])
      const licRow = (lic.data ?? [])[0] as any
      snap.hasLicense = !!licRow?.license_number
      snap.hasEoInsurance = !!licRow?.eo_policy_number
      const vps = (voice.data ?? []) as any[]
      const a = (agentRow.data ?? {}) as any
      const bv = (brand.data ?? {}) as any
      snap.hasVoiceClone = vps.some((v) => v.elevenlabs_voice_id) || !!a.voice_id
      snap.hasAvatar = vps.some((v) => v.did_avatar_id) || !!a.avatar_id
      snap.hasAssistantVoice = !!a.assistant_voice_id || (!!a.voice_preference && a.voice_preference !== "default")
      snap.hasMobilePhone = !!a.phone_mobile
      snap.hasProfilePhoto = !!a.profile_image_url
      snap.hasCommissionContract = a.commission_split !== null && a.commission_split !== undefined
      snap.hasMotto = !!(bv.tagline ?? "").trim()
      snap.hasAdditionalBrand = !!(bv.mission_statement ?? "").trim() || (Array.isArray(bv.key_brand_messages) ? bv.key_brand_messages.length > 0 : !!bv.key_brand_messages)

      // Connection Center domains, from platform_credentials.scope + agent_api_credentials.service_type.
      const scopes = new Set(((agentCreds.data ?? []) as any[]).map((c) => c.scope))
      const svcTypes = new Set(((apiCred.data ?? []) as any[]).map((c) => c.service_type))
      const socialPlatforms = ((social.data ?? []) as any[]).map((s) => String(s.platform ?? "").toLowerCase())
      const emailConn = svcTypes.has("email") || scopes.has("email")
      snap.hasCalendar = svcTypes.has("calendar") || scopes.has("calendar")
      snap.hasEmailOrCalendar = emailConn || snap.hasCalendar
      snap.hasOutreachChannel = emailConn || scopes.has("phone")
      snap.hasMls = scopes.has("listing")
      snap.hasCrm = scopes.has("crm")
      snap.hasTransactionEsign = scopes.has("transaction") || scopes.has("esign")
      snap.hasPodcast = scopes.has("podcast")
      snap.hasFinance = scopes.has("financial")
      snap.hasAdManager = scopes.has("marketing")
      snap.hasPayoutAccount = ((agentCreds.data ?? []) as any[]).some((c) => c.platform === "stripe" || c.scope === "financial")
      snap.hasSocialAccount = socialPlatforms.some((p) => !p.includes("google") || (!p.includes("business") && !p.includes("gmb")))
      snap.hasGoogleBusiness = socialPlatforms.some((p) => p.includes("google") && (p.includes("business") || p.includes("gmb")))
    }
    // User-row personal fields (all roles).
    const { data: u } = await svc.from("users").select("personal_website_url, email_signature, phone").eq("id", userId).maybeSingle()
    const ur = (u ?? {}) as any
    snap.hasPersonalWebsite = !!ur.personal_website_url
    snap.hasEmailSignature = !!ur.email_signature
    if (!snap.hasMobilePhone) snap.hasMobilePhone = !!ur.phone

    // Staff / external self-connect (email or calendar).
    if (isStaff) {
      const { data } = await svc.from("agent_api_credentials").select("id").eq("brokerage_id", brokerageId ?? "").eq("is_active", true).limit(50)
      // agent_api_credentials is keyed by agent_id; for non-agent staff we accept a user-scoped platform cred instead.
      // platform_credentials.scope is the OWNERSHIP level (brokerage|team|agent), not a
      // provider family — filtering it by "email"/"calendar"/"financial" matched nothing.
      // CALENDAR half — still a user-scoped credential: a calendar belongs to
      // the person whose day it is, so there is no team or brokerage fallback.
      const pcCal = await svc.from("platform_credentials").select("id").eq("agent_user_id", userId).eq("is_active", true).in("platform", ["google_calendar"]).limit(1)

      // EMAIL half — WALKS THE CASCADE (orphan burn-down, lane E).
      //
      // This probe used to ask one question: does a credential exist with
      // agent_user_id = this user? That is USER scope only, and it is the wrong
      // question for exactly the staff this branch covers. The provider model is
      // documented at lib/inbound-mail/resolve-user-provider.ts:6 — agents and
      // team_leads are independent contractors on their OWN Gmail/Outlook, while
      // brokerage staff (TC, compliance_officer, broker_admin) work the
      // BROKERAGE's domain through a transactional provider whose credential is
      // held at brokerage scope with agent_user_id NULL.
      //
      // So a TC whose email was genuinely connected — by their broker, at
      // brokerage scope, which is the only way it is ever connected for them —
      // matched nothing here and was told to "Connect your email & calendar"
      // (the staff_email item at :249) forever, with no action available that
      // would have cleared it. The readiness surface was NARROWER than reality,
      // which is the direction that nags a user about work already done.
      //
      // resolveInboundEmailProviderForUser is the resolver written for this and
      // never called: it walks user → team → brokerage over the same
      // platform_credentials table, restricted to the inbound-email platforms,
      // and returns null only when NONE of the three levels has one.
      // The middle rung of the cascade needs the user's team. users.team_id is a
      // live column; a NULL simply means the team rung cannot match, which is
      // the same outcome the resolver produces for a user with no team.
      const { data: teamRow, error: teamErr } = await svc
        .from("users").select("team_id").eq("id", userId).maybeSingle()
      if (teamErr) {
        // supabase-js RESOLVES a refused read. Reported rather than treated as
        // "no team", which would silently skip a rung of the cascade.
        console.warn("[setup-readiness] team lookup refused — team-scoped email credentials will not be seen:", teamErr.message)
      }

      const { resolveInboundEmailProviderForUser } = await import("@/lib/inbound-mail/resolve-user-provider")
      const inboundEmail = await resolveInboundEmailProviderForUser({
        userId,
        teamId: (teamRow as { team_id?: string | null } | null)?.team_id ?? null,
        brokerageId,
      })

      snap.hasEmailOrCalendar = ((data ?? []).length > 0 && !!agentId) || has(pcCal) || !!inboundEmail
    }

    // Brokerage foundations (broker/admin).
    if (isBrokerAdmin && brokerageId) {
      const [brk, gs, comm, sms, isaPhone, acct, team, locs] = await Promise.all([
        svc.from("brokerages").select("license_number, recruiting_pitch, logo_url, primary_color, phone, email, website").eq("id", brokerageId).maybeSingle(),
        svc.from("global_settings").select("app_logo_url, primary_color, from_email, smtp_host").eq("brokerage_id", brokerageId).maybeSingle(),
        svc.from("commission_structures").select("id").eq("brokerage_id", brokerageId).limit(1),
        svc.from("platform_credentials").select("id").eq("brokerage_id", brokerageId).eq("is_active", true).in("platform", ["twilio", "telnyx", "bandwidth"]).limit(1),
        svc.from("tenant_phone_numbers").select("id").eq("brokerage_id", brokerageId).eq("is_active", true).limit(1),
        svc.from("brokerage_integrations").select("id").eq("brokerage_id", brokerageId).eq("provider_type", "accounting").limit(1),
        svc.from("users").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId).not("user_type", "in", "(contact,vendor,system,admin)"),
        svc.from("locations").select("id").eq("brokerage_id", brokerageId).limit(1),
      ])
      const b = (brk.data ?? {}) as any, g = (gs.data ?? {}) as any
      snap.hasBrokerageLicense = !!b.license_number
      snap.hasBrokerageContact = !!(b.phone || b.email || b.website)
      snap.hasRecruitingPitch = !!b.recruiting_pitch
      // Branding is set if EITHER the wizard (global_settings) OR the brokerage row carries a logo/color.
      snap.hasBranding = !!(g.app_logo_url || g.primary_color || b.logo_url || b.primary_color)
      snap.hasEmailProvider = !!(g.from_email || g.smtp_host)
      snap.hasCommissionStructure = has(comm)
      snap.hasSmsProvider = has(sms)
      snap.hasIsaPhone = has(isaPhone)
      snap.hasAccountingSync = has(acct)
      snap.hasTeamMembers = (team.count ?? 0) > 0
      snap.hasOfficeLocations = has(locs)
    }

    // Team-lead team config + brand.
    if (role === "team_lead") {
      const { data } = await svc.from("teams").select("team_split_type, team_split_percent, team_split_value, logo_url, primary_color").eq("team_lead_id", userId).limit(1).maybeSingle()
      const t = (data ?? {}) as any
      // Same correction as lib/onboarding/critical-setup.ts:splitsSet — the old
      // test was `team_split_type IS NOT NULL` against a column that is
      // DEFAULT 'percent', so it reported configured for every team that had
      // ever existed while the value the commission waterfall reads was NULL.
      // Test the value on the branch the type selects; 0 is a valid answer.
      snap.hasTeamConfig = t.team_split_type === "flat"
        ? t.team_split_value !== null && t.team_split_value !== undefined
        : t.team_split_percent !== null && t.team_split_percent !== undefined
      snap.hasTeamBrand = !!(t.logo_url || t.primary_color)
    }
  } catch (err) {
    console.error("[setup-readiness] snapshot read failed:", err)
  }

  return resolveSetupReadiness(role, snap, tier)
}
