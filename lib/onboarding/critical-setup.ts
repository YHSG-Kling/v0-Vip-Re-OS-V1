// lib/onboarding/critical-setup.ts
//
// ─── CRITICAL SETUP REGISTRY (owner round 42) ────────────────────────────────
//
// ONE registry of the setup items the OS now CRITICALLY DEPENDS ON, per role —
// the things that make whole engines no-op (not "nice to finish your profile").
// Each item carries an honest one-line WHY (what breaks/no-ops without it), the
// EXISTING settings surface that fills it, and a DERIVED checker: a predicate
// over facts read from the REAL config tables. No aspirational rows — the
// simulator (scripts/onboarding-readiness-simulator.ts) locks that every
// checker flips false→true purely from loaded facts.
//
// KEEP-ONE POSITIONING (studied, deliberate):
//   • lib/onboarding/setup-readiness.ts is the PER-USER personal checklist
//     ("what do I fill out to do my job") — profile-completeness altitude.
//     This module is the PER-TENANT critical-dependency meter ("which OS
//     engines are dead until someone configures X") — different altitude,
//     different consumers; both read the same real tables, neither stores a
//     status column.
//   • onboarding_steps machinery was studied and NOT reused: its rows are
//     manually-completed curriculum steps (agent_step_completions written by
//     the learner). Seeding these items there would create a SECOND, staleable
//     truth — a step could be "checked off" while the market table is still
//     empty. Derived checkers cannot drift, so the registry read stands alone.
//
// PURE composer + facts loader (client passed in) — NOT "use server", so the
// simulator can drive both. The server-action wrapper lives in
// app/actions/critical-setup.ts; the meter UI in
// app/components/onboarding/critical-setup-meter.tsx.

import type { SupabaseClient } from "@supabase/supabase-js"
import { resolveSeatUsage } from "@/lib/kernel/seat-usage"

type Svc = SupabaseClient<any, any, any>

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export type CriticalTier = "solo_agent" | "team" | "brokerage" | "multi_location"

/** The onboarding principals the OS depends on. brokerage_admin = the tenant
 *  principal (broker OR admin seat — same obligations). */
export type CriticalRole =
  | "brokerage_admin" | "agent" | "team_lead" | "tc" | "compliance" | "vendor"

export const CRITICAL_ROLES: readonly CriticalRole[] = [
  "brokerage_admin", "agent", "team_lead", "tc", "compliance", "vendor",
]

/** The 8 fixed critical-setup categories (owner spec). */
export type CriticalCategory =
  | "territory" | "routing" | "voice" | "connections"
  | "egress" | "seats" | "billing" | "profile"

export const CRITICAL_CATEGORIES: readonly CriticalCategory[] = [
  "territory", "routing", "voice", "connections", "egress", "seats", "billing", "profile",
]

/** Map the app's user_type strings onto the registry's roles (null = role has
 *  no critical-setup obligations here, e.g. platform staff, contacts). */
export function normalizeCriticalRole(userType: string | null | undefined): CriticalRole | null {
  switch ((userType ?? "").toLowerCase()) {
    case "broker": case "broker_owner": case "admin": case "broker_admin": return "brokerage_admin"
    case "agent": case "solo_agent": case "isa": return "agent"
    case "team_lead": case "team_leader": case "teamlead": return "team_lead"
    case "tc": case "transaction_coordinator": return "tc"
    case "compliance_officer": case "compliance_manager": return "compliance"
    case "vendor": return "vendor"
    default: return null
  }
}

// ─── Facts — every field loaded from a REAL table (loader below) ─────────────

export interface CriticalSetupFacts {
  tier: CriticalTier
  // territory
  activeMarkets: number              // lead_scraping_markets is_active rows
  // routing
  activeAssignmentRules: number      // assignment_rules is_active rows
  // voice / identity
  brandIdentityConfigured: boolean   // brokerages.logo_url/primary_color or global_settings
  brandVoiceConfigured: boolean      // brand_voice_profile active tenant row
  aiIdentityConfigured: boolean      // ai_identity_profiles scope_type='brokerage'
  // egress posture
  autonomyPostureReviewed: boolean   // managed_agents.config.autonomy_tier set on ≥1 manager
  // connections
  emailProviderConfigured: boolean   // global_settings.from_email/smtp_host or brokerage email cred
  smsProviderConfigured: boolean     // platform_credentials twilio/telnyx/bandwidth/vapi
  zoomConnected: boolean             // platform_credentials platform='zoom' (brokerage-owned)
  accountingConnected: boolean       // brokerage_integrations accounting or quickbooks cred
  socialConnected: boolean           // social_media_accounts active rows
  // seats
  workingSeats: number               // users in SEAT roles for the tenant
  // billing
  billingReady: boolean              // subscriptions active OR a Stripe customer on file
  trialEndsAt: string | null         // brokerages.trial_ends_at
  // tenant profile
  brokerageProfileComplete: boolean  // brokerages.license_number + a contact channel
  listingsCount: number              // listings rows (demo/first listing included)
  // per-user slices (loaded only for the matching role)
  agent?: {
    licenseOnFile: boolean           // agent_licenses.license_number
    voicePrefSet: boolean            // agents.assistant_voice_id / voice_preference
    twinConfigured: boolean          // avatar + cloned voice (Twin Studio) — agent_voice_profiles / agents.voice_id+avatar_id
    calendarConnected: boolean       // platform_credentials scope='calendar' / agent_api_credentials
    pwaInstalled: boolean            // push_subscriptions row (round-41 PWA + web push)
    contactsCount: number            // contacts rows in the tenant (portal-invite readiness)
  }
  teamLead?: {
    teamConfigured: boolean          // teams row led by this user
    splitsSet: boolean               // teams.team_split_type set
    teamBooksConnected: boolean      // team-scoped quickbooks credential
  }
  vendor?: {
    profileComplete: boolean         // vendors.category + phone
    payoutConnected: boolean         // vendor-owned financial/stripe credential
    booksConnected: boolean          // vendor-owned quickbooks credential
    w9OnFile: boolean                // vendor_tax_documents derived status = 'on_file' (round 43)
  }
}

/** All-false / zero facts — what a brand-new tenant looks like before any setup. */
export function emptyCriticalSetupFacts(tier: CriticalTier = "brokerage"): CriticalSetupFacts {
  return {
    tier,
    activeMarkets: 0,
    activeAssignmentRules: 0,
    brandIdentityConfigured: false,
    brandVoiceConfigured: false,
    aiIdentityConfigured: false,
    autonomyPostureReviewed: false,
    emailProviderConfigured: false,
    smsProviderConfigured: false,
    zoomConnected: false,
    accountingConnected: false,
    socialConnected: false,
    workingSeats: 0,
    billingReady: false,
    trialEndsAt: null,
    brokerageProfileComplete: false,
    listingsCount: 0,
    agent: { licenseOnFile: false, voicePrefSet: false, twinConfigured: false, calendarConnected: false, pwaInstalled: false, contactsCount: 0 },
    teamLead: { teamConfigured: false, splitsSet: false, teamBooksConnected: false },
    vendor: { profileComplete: false, payoutConnected: false, booksConnected: false, w9OnFile: false },
  }
}

// ─── THE REGISTRY ────────────────────────────────────────────────────────────

export interface CriticalSetupItem {
  key: string
  role: CriticalRole
  category: CriticalCategory
  title: string
  /** One honest line — what breaks or no-ops without it. */
  why: string
  /** The EXISTING settings surface that fills it. */
  settingHref: string
  /** Tiers the item applies to. Omit = all tiers. */
  tiers?: CriticalTier[]
  /** Honest DB-derived predicate over the loaded facts. */
  checker: (f: CriticalSetupFacts) => boolean
}

const ORG_TIERS: CriticalTier[] = ["team", "brokerage", "multi_location"]

export const CRITICAL_SETUP_ITEMS: CriticalSetupItem[] = [
  // ── BROKERAGE ADMIN — the tenant principal. Covers all 8 categories. ──────
  { key: "admin_markets", role: "brokerage_admin", category: "territory",
    title: "Define your first lead market",
    why: "The entire canonical scrape pipeline no-ops without an active lead_scraping_markets row — zero territories means zero platform-sourced leads, coverage boards, or territory ROI.",
    settingHref: "/dashboard/admin/markets",
    checker: (f) => f.activeMarkets > 0 },
  { key: "admin_assignment_rules", role: "brokerage_admin", category: "routing",
    title: "Set lead assignment rules",
    why: "Engine 2 falls back to default round-robin without an active assignment_rules row — hot leads route by chance, not by your design.",
    settingHref: "/dashboard/admin/assignment-rules",
    checker: (f) => f.activeAssignmentRules > 0 },
  { key: "admin_brand_identity", role: "brokerage_admin", category: "voice",
    title: "Set your brand (logo & colors)",
    why: "Every video outro, postcard, portal, and your hosted /site page renders unbranded platform defaults until a logo/color exists.",
    settingHref: "/settings/branding",
    checker: (f) => f.brandIdentityConfigured },
  { key: "admin_brand_voice", role: "brokerage_admin", category: "voice",
    title: "Teach the AI your brand voice",
    why: "All client-facing copy the managers draft falls back to a generic tone until a brand_voice_profile exists to learn from.",
    settingHref: "/settings/brand-voice",
    checker: (f) => f.brandVoiceConfigured },
  { key: "admin_ai_identity", role: "brokerage_admin", category: "voice",
    title: "Name your AI assistant",
    why: "Site chat, phone reception, and briefings speak as a generic fallback until a named ai_identity_profiles row exists.",
    settingHref: "/dashboard/admin/ai-identity",
    checker: (f) => f.aiIdentityConfigured },
  { key: "admin_autonomy_posture", role: "brokerage_admin", category: "egress",
    title: "Review your AI autonomy posture",
    why: "Until you set a posture (managed_agents autonomy tier) every manager runs on eval-derived defaults — you haven't decided what may send unattended.",
    settingHref: "/dashboard/admin/manager-trust",
    checker: (f) => f.autonomyPostureReviewed },
  { key: "admin_email_provider", role: "brokerage_admin", category: "connections",
    title: "Configure an email sender",
    why: "Approved client emails have no sender until a from-address/SMTP or email credential exists — drafts stage but never deliver.",
    settingHref: "/settings/providers",
    checker: (f) => f.emailProviderConfigured },
  { key: "admin_sms_provider", role: "brokerage_admin", category: "connections",
    title: "Configure SMS / voice",
    why: "Texting and the AI ISA's calls need a Twilio/Telnyx/Vapi credential — without one the calling and SMS rails are dead.",
    settingHref: "/settings/providers",
    checker: (f) => f.smsProviderConfigured },
  { key: "admin_social", role: "brokerage_admin", category: "connections",
    title: "Connect a social account",
    why: "The Campaign Orchestrator stages posts with nowhere to publish until one social account is connected.",
    settingHref: "/dashboard/profile",
    checker: (f) => f.socialConnected },
  { key: "admin_zoom", role: "brokerage_admin", category: "connections",
    title: "Connect Zoom",
    why: "The video-appointment lane can't create meetings until the brokerage Zoom credential exists — booked video consults fall back to phone.",
    settingHref: "/settings/connections",
    checker: (f) => f.zoomConnected },
  { key: "admin_accounting", role: "brokerage_admin", category: "connections",
    title: "Connect accounting (QuickBooks)",
    why: "Commission and P&L exports have nowhere to land until an accounting connection exists — books stay manual.",
    settingHref: "/settings/accounting",
    checker: (f) => f.accountingConnected },
  { key: "admin_invite_seats", role: "brokerage_admin", category: "seats",
    title: "Invite your agents & staff", tiers: ORG_TIERS,
    why: "The AI managers have no pipelines to work until working seats beyond the owner exist (tier matrix: team = 5 seats, brokerage+ unlimited).",
    settingHref: "/dashboard/admin/users",
    checker: (f) => f.workingSeats >= 2 },
  { key: "admin_billing", role: "brokerage_admin", category: "billing",
    title: "Put a payment method on file",
    why: "At trial_ends_at the login gate routes the whole tenant to billing — no card on file means a hard stop for every seat.",
    settingHref: "/dashboard/admin/billing",
    checker: (f) => f.billingReady },
  { key: "admin_brokerage_profile", role: "brokerage_admin", category: "profile",
    title: "Complete brokerage license & contact",
    why: "Compliance docs and every agent's disclosures print your license number; your public pages need a phone/email/website.",
    settingHref: "/dashboard/settings",
    checker: (f) => f.brokerageProfileComplete },
  { key: "admin_first_listing", role: "brokerage_admin", category: "profile",
    title: "Add your first listing (or load the demo)",
    why: "Your hosted site, listing videos, and open-house rails have zero inventory to work with until one listing row exists.",
    settingHref: "/listings",
    checker: (f) => f.listingsCount > 0 },

  // ── AGENT ─────────────────────────────────────────────────────────────────
  { key: "agent_license", role: "agent", category: "profile",
    title: "Put your license on file",
    why: "The compliance gate blocks sending documents for signature until your license number is in agent_licenses.",
    settingHref: "/dashboard/onboarding/license",
    checker: (f) => f.agent?.licenseOnFile ?? false },
  { key: "agent_voice_pref", role: "agent", category: "voice",
    title: "Choose your assistant voice",
    why: "Briefings and your AI assistant speak in a default voice until you pick one — your voice preference personalizes every readout.",
    settingHref: "/dashboard/settings/assistant",
    checker: (f) => f.agent?.voicePrefSet ?? false },
  { key: "agent_twin", role: "agent", category: "voice",
    title: "Set up your AI avatar & voice",
    why: "Your on-camera videos and your AI ISA calls fall back to generic media until your avatar (D-ID) and cloned voice (ElevenLabs) exist — set them up once in Twin Studio.",
    settingHref: "/dashboard/settings/twin-studio",
    checker: (f) => f.agent?.twinConfigured ?? false },
  { key: "agent_calendar", role: "agent", category: "connections",
    title: "Connect your calendar",
    why: "Showings, appointments, and closings double-book blind until a calendar connection exists.",
    settingHref: "/settings/connections",
    checker: (f) => f.agent?.calendarConnected ?? false },
  { key: "agent_mobile", role: "agent", category: "connections",
    title: "Install the mobile app & enable push",
    why: "Approvals and hot-lead alerts can't reach you in the field until the PWA is installed with push enabled (a push_subscriptions row).",
    settingHref: "/settings/notifications",
    checker: (f) => f.agent?.pwaInstalled ?? false },
  { key: "agent_portal_ready", role: "agent", category: "seats",
    title: "Import contacts so clients can be invited",
    why: "The client-portal invite flow has no one to invite until contacts exist — the sphere engine also ranks nothing on an empty book.",
    settingHref: "/crm",
    checker: (f) => (f.agent?.contactsCount ?? 0) > 0 },

  // ── TEAM LEAD (in addition to their agent items — same person, both roles) ─
  { key: "lead_team_structure", role: "team_lead", category: "seats",
    title: "Set up your team", tiers: ORG_TIERS,
    why: "Team rollups, coverage, and the weekly team plan have no team to aggregate until a teams row you lead exists.",
    settingHref: "/dashboard/settings/teams",
    checker: (f) => f.teamLead?.teamConfigured ?? false },
  { key: "lead_team_splits", role: "team_lead", category: "billing",
    title: "Set your team splits", tiers: ORG_TIERS,
    why: "Team P&L and per-agent payouts compute wrong (or not at all) until team_split_type/value are set.",
    settingHref: "/dashboard/settings/teams",
    checker: (f) => f.teamLead?.splitsSet ?? false },
  { key: "lead_team_books", role: "team_lead", category: "connections",
    title: "Connect the team's QuickBooks", tiers: ORG_TIERS,
    why: "Monthly team P&L export has nowhere to land until the team-scoped QuickBooks connection exists.",
    settingHref: "/settings/accounting",
    checker: (f) => f.teamLead?.teamBooksConnected ?? false },

  // ── TC / COMPLIANCE — their consoles work day one; the one critical link is
  //    their own inbox/calendar so handoffs and deadlines reach them. ─────────
  { key: "tc_inbox", role: "tc", category: "connections",
    title: "Connect your email & calendar",
    why: "Closing timelines and doc-chase handoffs sync through your inbox/calendar — nothing reaches you until one is connected.",
    settingHref: "/settings/connections",
    checker: (f) => f.agent?.calendarConnected ?? false },
  { key: "compliance_inbox", role: "compliance", category: "connections",
    title: "Connect your email & calendar",
    why: "CDA routing and violation follow-ups sync through your inbox/calendar — nothing reaches you until one is connected.",
    settingHref: "/settings/connections",
    checker: (f) => f.agent?.calendarConnected ?? false },

  // ── VENDOR ────────────────────────────────────────────────────────────────
  { key: "vendor_profile", role: "vendor", category: "profile",
    title: "Complete your vendor profile & service category",
    why: "Job routing matches on vendors.category and coordination needs your phone — an incomplete profile gets skipped by the assignment rail.",
    settingHref: "/vendor/settings",
    checker: (f) => f.vendor?.profileComplete ?? false },
  { key: "vendor_payout", role: "vendor", category: "billing",
    title: "Connect your payout account",
    why: "Invoice payouts have nowhere to land until your Stripe/financial connection exists — you can bill but not get paid.",
    settingHref: "/vendor/connections",
    checker: (f) => f.vendor?.payoutConnected ?? false },
  { key: "vendor_books", role: "vendor", category: "connections",
    title: "Connect your QuickBooks",
    why: "Paid invoices stay out of your books until your vendor-scoped QuickBooks connection exists.",
    settingHref: "/vendor/connections",
    checker: (f) => f.vendor?.booksConnected ?? false },
  { key: "vendor_w9", role: "vendor", category: "billing",
    title: "Put your W-9 on file",
    why: "Your brokerage partner must 1099-report payments to you — until a signed W-9 is on file every payout and invoice carries a tax-compliance warning on both sides.",
    settingHref: "/vendor/documents",
    checker: (f) => f.vendor?.w9OnFile ?? false },
]

// ─── The composed readiness read (THE SETUP METER) ───────────────────────────

export interface ResolvedCriticalItem extends Omit<CriticalSetupItem, "checker"> {
  configured: boolean
}

export interface CategoryReadiness {
  category: CriticalCategory
  total: number
  done: number
  pct: number
  /** Honest why-lines for every unconfigured item in the category. */
  gaps: Array<{ key: string; title: string; why: string; settingHref: string }>
}

export interface CriticalSetupReadiness {
  role: CriticalRole
  tier: CriticalTier
  items: ResolvedCriticalItem[]
  categories: CategoryReadiness[]
  totalItems: number
  configuredItems: number
  overallPct: number
  /** First unconfigured item in registry order — the "do this next". */
  nextGap: ResolvedCriticalItem | null
  trialEndsAt: string | null
}

/**
 * PURE: resolve the role's registry items for the tenant tier against the
 * loaded facts → per-category % with why-lines for the gaps. Dismissals are a
 * UI-only affordance (localStorage in the meter component) — they NEVER enter
 * this math, so the meter stays honest.
 */
export function composeSetupReadiness(params: {
  role: CriticalRole
  facts: CriticalSetupFacts
}): CriticalSetupReadiness {
  const { role, facts } = params
  const tier = facts.tier

  const items: ResolvedCriticalItem[] = CRITICAL_SETUP_ITEMS
    .filter((i) => i.role === role && (!i.tiers || i.tiers.includes(tier)))
    .map(({ checker, ...meta }) => ({ ...meta, configured: checker(facts) }))

  const byCategory = new Map<CriticalCategory, ResolvedCriticalItem[]>()
  for (const item of items) {
    const list = byCategory.get(item.category) ?? []
    list.push(item)
    byCategory.set(item.category, list)
  }

  const categories: CategoryReadiness[] = CRITICAL_CATEGORIES
    .filter((c) => byCategory.has(c))
    .map((c) => {
      const list = byCategory.get(c)!
      const done = list.filter((i) => i.configured).length
      return {
        category: c,
        total: list.length,
        done,
        pct: list.length === 0 ? 100 : Math.round((done / list.length) * 100),
        gaps: list.filter((i) => !i.configured)
          .map((i) => ({ key: i.key, title: i.title, why: i.why, settingHref: i.settingHref })),
      }
    })

  const configuredItems = items.filter((i) => i.configured).length
  return {
    role, tier, items, categories,
    totalItems: items.length,
    configuredItems,
    overallPct: items.length === 0 ? 100 : Math.round((configuredItems / items.length) * 100),
    nextGap: items.find((i) => !i.configured) ?? null,
    trialEndsAt: facts.trialEndsAt,
  }
}

// ─── Facts loader — honest reads from the REAL tables, nothing invented ──────

// The seat list is NOT restated here. This file carried its own copy, and it had
// drifted from the canonical one in three ways:
//   · it contained "broker_admin", which users.user_type does not admit at all,
//     so that entry could never match a row;
//   · it omitted "broker_owner", which the column DOES admit — a brokerage owner
//     counted as no seat anywhere;
//   · it did not exclude SUSPENDED users, while the user-management page does.
// The result is what the owner reported: the seat number an AGENT saw on the
// setup meter disagreed with the one an ADMIN saw on the users page, for the same
// tenant. One list now — lib/kernel/tier-role-matrix.ts SEAT_ROLES.

export async function loadCriticalSetupFacts(
  svc: Svc,
  params: {
    brokerageId: string
    /** Load the per-user agent slice for this user (agents.user_id). */
    userId?: string | null
    agentId?: string | null
    /** Load the team-lead slice (teams.team_lead_id = userId). */
    includeTeamLead?: boolean
    /** Load the vendor slice for this vendors.id. */
    vendorId?: string | null
  },
): Promise<CriticalSetupFacts> {
  const { brokerageId } = params
  const facts = emptyCriticalSetupFacts()

  const [brk, gs, markets, rules, brandVoice, aiIdentity, managed, smsCred, zoomCred, qbCred,
    acctInt, social, sub, listings] = await Promise.all([
    svc.from("brokerages")
      .select("plan_tier, license_number, phone, email, website, logo_url, primary_color, trial_ends_at, billing_metadata")
      .eq("id", brokerageId).maybeSingle(),
    svc.from("global_settings").select("app_logo_url, primary_color, from_email, smtp_host")
      .eq("brokerage_id", brokerageId).maybeSingle(),
    svc.from("lead_scraping_markets").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("is_active", true),
    svc.from("assignment_rules").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("is_active", true),
    svc.from("brand_voice_profile").select("id").eq("brokerage_id", brokerageId).eq("is_active", true).limit(1),
    svc.from("ai_identity_profiles").select("id", { count: "exact", head: true })
      .eq("scope_type", "brokerage").eq("scope_id", brokerageId).eq("active", true),
    svc.from("managed_agents").select("config").eq("brokerage_id", brokerageId).is("archived_at", null).limit(50),
    svc.from("platform_credentials").select("id").eq("brokerage_id", brokerageId).eq("is_active", true)
      .in("platform", ["twilio", "telnyx", "bandwidth", "vapi"]).limit(1),
    svc.from("platform_credentials").select("id").eq("owner_type", "brokerage").eq("owner_id", brokerageId)
      .eq("platform", "zoom").eq("is_active", true).limit(1),
    svc.from("platform_credentials").select("id").eq("owner_type", "brokerage").eq("owner_id", brokerageId)
      .eq("platform", "quickbooks").eq("is_active", true).limit(1),
    svc.from("brokerage_integrations").select("id").eq("brokerage_id", brokerageId)
      .eq("provider_type", "accounting").limit(1),
    svc.from("social_media_accounts").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("is_active", true),
    svc.from("subscriptions").select("status, stripe_customer_id").eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
    svc.from("listings").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).is("deleted_at", null),
  ])

  const b = (brk.data ?? {}) as any
  const g = (gs.data ?? {}) as any
  const pt = b.plan_tier as string | null
  if (pt === "solo_agent" || pt === "team" || pt === "brokerage" || pt === "multi_location") facts.tier = pt

  facts.activeMarkets = markets.count ?? 0
  facts.activeAssignmentRules = rules.count ?? 0
  facts.brandIdentityConfigured = !!(b.logo_url || b.primary_color || g.app_logo_url || g.primary_color)
  facts.brandVoiceConfigured = ((brandVoice.data ?? []) as any[]).length > 0
  facts.aiIdentityConfigured = (aiIdentity.count ?? 0) > 0
  facts.autonomyPostureReviewed = ((managed.data ?? []) as any[])
    .some((m) => { const c = m?.config; return c && typeof c === "object" && !!(c as any).autonomy_tier })
  const emailCred = await svc.from("platform_credentials").select("id")
    // platform_credentials.scope is the OWNERSHIP level (brokerage|team|agent), not a
// provider family — filtering it by "email"/"calendar"/"financial" matched nothing, so
// this setup check could never be satisfied no matter what the tenant connected.
    .eq("brokerage_id", brokerageId).eq("is_active", true).in("platform", ["sendgrid", "resend", "postmark", "mailgun", "gmail", "outlook"]).limit(1)
  facts.emailProviderConfigured = !!(g.from_email || g.smtp_host) || ((emailCred.data ?? []) as any[]).length > 0
  facts.smsProviderConfigured = ((smsCred.data ?? []) as any[]).length > 0
  facts.zoomConnected = ((zoomCred.data ?? []) as any[]).length > 0
  facts.accountingConnected = ((acctInt.data ?? []) as any[]).length > 0 || ((qbCred.data ?? []) as any[]).length > 0
  facts.socialConnected = (social.count ?? 0) > 0
  // Seats count PEOPLE, across both role sources. This is the same number the
  // users page and Settings show — the three disagreed before.
  facts.workingSeats = (await resolveSeatUsage(svc, brokerageId)).seatCount
  const s = (sub.data ?? {}) as any
  const bm = (b.billing_metadata && typeof b.billing_metadata === "object") ? b.billing_metadata : {}
  facts.billingReady = s.status === "active" || !!s.stripe_customer_id || !!(bm as any).stripe_customer_id
  facts.trialEndsAt = b.trial_ends_at ?? null
  facts.brokerageProfileComplete = !!b.license_number && !!(b.phone || b.email || b.website)
  facts.listingsCount = listings.count ?? 0

  // ── per-user agent slice (also serves tc/compliance inbox checks) ──────────
  if (params.userId) {
    const [agentRow, lic, agentCal, staffCal, push, contacts, avp] = await Promise.all([
      params.agentId
        ? svc.from("agents").select("assistant_voice_id, voice_preference, voice_id, avatar_id").eq("id", params.agentId).maybeSingle()
        : Promise.resolve({ data: null } as any),
      params.agentId
        ? svc.from("agent_licenses").select("license_number").eq("agent_id", params.agentId).limit(1)
        : Promise.resolve({ data: [] } as any),
      params.agentId
        ? svc.from("platform_credentials").select("id").eq("owner_type", "agent").eq("owner_id", params.agentId)
            .eq("is_active", true).in("platform", ["google_calendar", "gmail", "outlook", "sendgrid", "resend", "postmark", "mailgun"]).limit(1)
        : Promise.resolve({ data: [] } as any),
      svc.from("platform_credentials").select("id").eq("agent_user_id", params.userId)
        .eq("is_active", true).in("platform", ["google_calendar", "gmail", "outlook", "sendgrid", "resend", "postmark", "mailgun"]).limit(1),
      svc.from("push_subscriptions").select("id").eq("user_id", params.userId).is("disabled_at", null).limit(1),
      svc.from("contacts").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId),
      // Twin (avatar + cloned voice) — the training-output mirror; agents.voice_id/
      // avatar_id below are the canonical use-this pointers. Either satisfies "set up".
      params.agentId
        ? svc.from("agent_voice_profiles").select("elevenlabs_voice_id, did_avatar_id, avatar_url").eq("agent_id", params.agentId)
        : Promise.resolve({ data: [] } as any),
    ])
    const a = (agentRow.data ?? {}) as any
    const apiCal = params.agentId
      ? await svc.from("agent_api_credentials").select("id").eq("agent_id", params.agentId)
          .eq("is_active", true).in("service_type", ["calendar", "email"]).limit(1)
      : { data: [] as any[] }
    facts.agent = {
      licenseOnFile: !!((lic.data ?? [])[0] as any)?.license_number,
      voicePrefSet: !!a.assistant_voice_id || (!!a.voice_preference && a.voice_preference !== "default"),
      calendarConnected:
        ((agentCal.data ?? []) as any[]).length > 0 ||
        ((staffCal.data ?? []) as any[]).length > 0 ||
        ((apiCal.data ?? []) as any[]).length > 0,
      pwaInstalled: ((push.data ?? []) as any[]).length > 0,
      contactsCount: contacts.count ?? 0,
      twinConfigured: (() => {
        const vps = (avp.data ?? []) as any[]
        const hasVoice = vps.some((v) => !!v.elevenlabs_voice_id) || !!a.voice_id
        // A re-hosted avatar_url (poll cron's download step) counts as "set up"
        // too — it's the profile-facing signal; did_avatar_id is the raw D-ID id.
        const hasAvatar = vps.some((v) => !!v.did_avatar_id || !!v.avatar_url) || !!a.avatar_id
        return hasVoice && hasAvatar
      })(),
    }
  }

  // ── team-lead slice ────────────────────────────────────────────────────────
  if (params.includeTeamLead && params.userId) {
    const { data: team } = await svc.from("teams")
      .select("id, team_split_type")
      .eq("brokerage_id", brokerageId).eq("team_lead_id", params.userId)
      .is("deleted_at", null).limit(1).maybeSingle()
    const t = (team ?? null) as any
    let teamBooks = false
    if (t?.id) {
      const { data: qb } = await svc.from("platform_credentials").select("id")
        .eq("owner_type", "team").eq("owner_id", t.id)
        .eq("platform", "quickbooks").eq("is_active", true).limit(1)
      teamBooks = ((qb ?? []) as any[]).length > 0
    }
    facts.teamLead = {
      teamConfigured: !!t,
      splitsSet: t?.team_split_type !== null && t?.team_split_type !== undefined && !!t,
      teamBooksConnected: teamBooks,
    }
  }

  // ── vendor slice ───────────────────────────────────────────────────────────
  if (params.vendorId) {
    const [{ data: v }, payout, qb, taxDoc] = await Promise.all([
      svc.from("vendors").select("category, phone, status, name").eq("id", params.vendorId).maybeSingle(),
      svc.from("platform_credentials").select("id").eq("owner_type", "vendor").eq("owner_id", params.vendorId)
        .eq("is_active", true).in("platform", ["stripe", "plaid", "quickbooks"]).limit(1),
      svc.from("platform_credentials").select("id").eq("owner_type", "vendor").eq("owner_id", params.vendorId)
        .eq("platform", "quickbooks").eq("is_active", true).limit(1),
      svc.from("vendor_tax_documents").select("status, vendor_name_at_filing")
        .eq("vendor_id", params.vendorId).maybeSingle(),
    ])
    const vr = (v ?? {}) as any
    // W-9 (round 43): same derivation as lib/vendors/w9.ts deriveW9Status —
    // on_file only while the vendors.name still matches the filing snapshot
    // (a legal-name change after filing expires the certification). A missing
    // table (pre-migration m275) reads as an honest false.
    const td = (taxDoc?.data ?? null) as any
    const filedName = ((td?.vendor_name_at_filing as string | null) ?? "").trim().toLowerCase()
    const currentName = ((vr.name as string | null) ?? "").trim().toLowerCase()
    facts.vendor = {
      profileComplete: !!vr.category && !!vr.phone,
      payoutConnected: ((payout.data ?? []) as any[]).length > 0,
      booksConnected: ((qb.data ?? []) as any[]).length > 0,
      w9OnFile: td?.status === "on_file" && !(filedName && currentName && filedName !== currentName),
    }
  }

  return facts
}
