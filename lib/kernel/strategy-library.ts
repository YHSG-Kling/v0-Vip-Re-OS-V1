/**
 * lib/kernel/strategy-library.ts — THE STRATEGY OBJECT + THE PLATFORM STRATEGY LIBRARY (wave 107, lane 107E).
 *
 * Owner: "Managers should stop inventing every plan from scratch." A STRATEGY is a reusable plan —
 * {key, version, tier, objective, eligibility, participating managers, capabilities, playbooks, budget,
 * authority, timing, fatigue rules, exit criteria, outcome metrics} — that managers SELECT by context.
 * ONE object, TWO tiers: `platform` (the VIPAgents library, versioned, immutable once published) and
 * `tenant` (a brokerage's own). A tenant ACTIVATES a platform version; the local OS ADAPTS it (tenant policy
 * overrides budget / authority / timing; tenant history moves eligibility thresholds) and the adaptation is
 * RECORDED beside the activation — the platform version itself never changes.
 *
 * SURVIVORS COMPOSED, NONE REPLACED (audit in the lane notes): every strategy is composed ONLY of
 *   · MANAGERS keys (lib/kernel/manager-registry.ts) — participating managers, in order;
 *   · APP_CAPABILITY_REGISTRY keys owned by that step's manager (lib/agentic-os/capability-ownership.ts
 *     CAPABILITY_MANAGER) — a step a manager cannot serve with a catalogue key names the GAP, it never
 *     invents a capability;
 *   · references to EXISTING playbooks: creative playbooks (lib/marketing/creative-playbooks.ts), qualification
 *     goals (lib/ai-isa/qualification-playbook.ts), campaign-sequence persona / type vocabularies
 *     (campaign_sequences CHECKs), strategy-session moments (lib/kernel/strategy-session.ts), kernel plays
 *     (deal / farm / intent / recruit outreach / dynamic playbook engine) and 106B experience kinds;
 *   · the authority ladder (lib/ai-isa/persona-tool-policy.ts), fatigue scopes (lib/fatigue, contact + agent),
 *     the timeline BUCKETS (constants/crm-standards.ts STANDARD_TIMELINES — never 30/60/90) and roi-ledger
 *     outcome keys (lib/intelligence/roi-ledger.ts RoiLedger).
 *
 * PURE — no I/O, type-only imports — so the mission controller (105B) can read a mission's strategy
 * ownership without pulling the runtime, and the proof asserts every rule directly. The runtime
 * (selectStrategies / activateStrategy / activateLibraryStrategy) is lib/kernel/strategy-engine.ts.
 */
import type { ManagerKey } from "@/lib/kernel/manager-registry"
import type { AppCapability } from "@/lib/agentic-os/app-capability-registry"
import type { AuthorityLevel } from "@/lib/ai-isa/persona-tool-policy"
import type { MissionType } from "@/lib/kernel/missions"
import type { StandardTimeline } from "@/constants/crm-standards"
import type { FatigueRiskLevel } from "@/lib/fatigue/fatigue-display"
import type { RoiLedger } from "@/lib/intelligence/roi-ledger"
import type { ExperienceKind } from "@/lib/ai-isa/lead-action-plan"

// ─── the object ───────────────────────────────────────────────────────────────────────────────
export const STRATEGY_TIERS = ["platform", "tenant"] as const
export type StrategyTier = (typeof STRATEGY_TIERS)[number]
export const STRATEGY_SUBJECT_TYPES = ["contact", "lead", "listing", "territory", "brokerage"] as const
export type StrategySubjectType = (typeof STRATEGY_SUBJECT_TYPES)[number]

/** The facts eligibility is judged on — assembled by the caller from rows it already read (person /
 *  opportunity / territory / twin). A missing fact is UNKNOWN: it fails a clause unless the clause says
 *  `whenKnown` (the strategy's own first step establishes it — e.g. the Data Steward verifies equity). */
export interface StrategyFacts {
  subject_type?: StrategySubjectType
  contact_type?: string
  persona?: string
  intent?: "buyer" | "seller" | "both" | "investor" | "unknown"
  is_past_client?: boolean
  homeowner?: boolean
  months_since_close?: number
  months_since_last_touch?: number
  timeline?: StandardTimeline
  equity_pct?: number
  first_time_buyer?: boolean
  listing_status?: string
  dnc?: boolean
  fatigue_risk?: FatigueRiskLevel
  territory_seller_demand_up?: boolean
  recruiting_need?: boolean
  /** Wave 137E (breadth): contacts.buyer_stage (CHECK vocabulary, e.g. BUYER_TOURING / BUYER_UNDER_CONTRACT). */
  buyer_stage?: string
  /** Wave 137E: contacts.lender_status (cash | needs_pre_approval | pre_approved | unknown). */
  lender_status?: string
}
export type StrategyFact = keyof StrategyFacts

export interface EligibilityClause {
  fact: StrategyFact
  op: "eq" | "neq" | "in" | "gte" | "lte" | "is_true" | "is_false"
  value?: string | number | boolean | readonly (string | number)[]
  /** Unknown fact passes (the strategy itself establishes it); a KNOWN fact is still judged. */
  whenKnown?: boolean
  /** A numeric threshold tenant history may move (adaptStrategy), within [min, max] by `step`. */
  adaptable?: { id: string; min: number; max: number; step: number }
}
export interface StrategyEligibility {
  subjectTypes: readonly StrategySubjectType[]
  all: readonly EligibilityClause[]
  /** At least one must hold (absent/empty = no any-of requirement). */
  any?: readonly EligibilityClause[]
}

/** A reference to an EXISTING playbook / sequence / play — resolved by the proof against the real export. */
export type PlaybookRef =
  | { kind: "creative_playbook"; key: string }
  | { kind: "qualification_goal"; key: string }
  | { kind: "sequence_persona"; key: string }
  | { kind: "sequence_type"; key: string }
  | { kind: "strategy_session"; key: "offer_decision" | "price_change" | "listing_launch" | "buyer_kickoff" }
  | { kind: "kernel_play"; key: keyof typeof KERNEL_PLAY_REFS }
  | { kind: "experience"; key: ExperienceKind }

/** Kernel plays a strategy may ride — file + the exported door (the proof reads stripped source). */
export const KERNEL_PLAY_REFS = Object.freeze({
  deal_play:        { file: "lib/kernel/deal-play.ts",                  door: "runDealPlay" },
  farm_play:        { file: "lib/kernel/farm-play.ts",                  door: "runFarmPlays" },
  intent_campaign:  { file: "lib/kernel/intent-campaign.ts",            door: "runIntentCampaign" },
  recruit_outreach: { file: "lib/agents/recruit-outreach-producer.ts",  door: "produceRecruitOutreach" },
  dynamic_playbook: { file: "lib/intelligence/playbook-engine.ts",      door: "runPlaybookEngineAll" },
})

export interface StrategyStep {
  manager: ManagerKey
  /** Catalogue keys THIS manager owns (CAPABILITY_MANAGER). Empty = the gap below. */
  capabilities: readonly AppCapability[]
  purpose: string
  playbooks: readonly PlaybookRef[]
  /** Named when the manager has no catalogue key for this step — a gap, never an invented capability. */
  gap?: string
}

/** roi-ledger outcome keys (numeric RoiLedger fields) — the outcome engine 107F learns on. */
export type StrategyOutcomeMetric = Exclude<keyof RoiLedger, "periodDays" | "sinceIso" | "headline" | "ledgerAttribution">

export interface StrategyDefinition {
  key: string
  version: number
  tier: StrategyTier
  title: string
  objective: string
  missionType: MissionType
  /** The accountable manager (mission owner). Must be one of the steps' managers. */
  ownerManager: ManagerKey
  eligibility: StrategyEligibility
  steps: readonly StrategyStep[]
  budget: { usd: number; tokens?: number }
  /** The recommended rung (ladder); `approval: "always"` holds every activation for a human. */
  authority: { recommended: AuthorityLevel; approval: "per_authority" | "always" }
  timing: { horizonDays: number; cadenceDays: number; timelineBuckets?: readonly StandardTimeline[] }
  fatigue: { scopes: readonly ("contact" | "agent")[]; maxContactRisk: FatigueRiskLevel; deconflict: true }
  exitCriteria: readonly { metric: string; op: ">=" | "<=" | "=="; target: number }[]
  outcomeMetrics: readonly StrategyOutcomeMetric[]
  /** Library card facts. */
  audience: string
  marketSuitability: readonly string[]
  averageCostUsd: number
  /** Base rank before learned performance (higher first). */
  priority: number
}

// ─── the platform library (seeded with the owner's eight) ─────────────────────────────────────
const NOT_DNC: EligibilityClause = { fact: "dnc", op: "is_false", whenKnown: true }
const NOT_EXHAUSTED: EligibilityClause = { fact: "fatigue_risk", op: "in", value: ["fresh", "moderate"], whenKnown: true }
const CONTACT_FATIGUE = { scopes: ["contact"] as const, maxContactRisk: "moderate" as const, deconflict: true as const }

function def(d: Omit<StrategyDefinition, "tier">): StrategyDefinition { return deepFreeze({ ...d, tier: "platform" as const }) }

/** Every published platform version, oldest first per key. A change is a NEW version appended here;
 *  a published version is never edited (strategyDigest + the m725 trigger hold it). */
export const PLATFORM_STRATEGY_LIBRARY: readonly StrategyDefinition[] = Object.freeze([
  def({
    key: "expired_listing", version: 1, title: "VIPAgents Expired Listing Rescue",
    objective: "Turn an expired listing's owner into a relisting appointment",
    missionType: "campaign", ownerManager: "listing_concierge",
    eligibility: { subjectTypes: ["contact", "lead"], all: [NOT_DNC, NOT_EXHAUSTED], any: [{ fact: "persona", op: "eq", value: "expired" }, { fact: "listing_status", op: "eq", value: "expired" }] },
    steps: [
      { manager: "data_steward", capabilities: ["contact_get"], purpose: "verify the owner and the reachable channels", playbooks: [] },
      { manager: "ai_isa", capabilities: ["isa_qualify"], purpose: "qualify motivation and timeline", playbooks: [{ kind: "qualification_goal", key: "seller_situation" }, { kind: "qualification_goal", key: "timeline" }] },
      { manager: "campaign_orchestrator", capabilities: ["direct_mail_send"], purpose: "the expired-rescue letter + sequence", playbooks: [{ kind: "creative_playbook", key: "expired_rescue" }, { kind: "sequence_persona", key: "expired" }] },
      { manager: "listing_concierge", capabilities: ["cma_generate", "listing_appointment_prep"], purpose: "the relisting appointment with a fresh CMA", playbooks: [{ kind: "strategy_session", key: "price_change" }] },
    ],
    budget: { usd: 40, tokens: 60_000 }, authority: { recommended: 3, approval: "per_authority" },
    timing: { horizonDays: 45, cadenceDays: 7, timelineBuckets: ["immediate", "1-3_months"] }, fatigue: CONTACT_FATIGUE,
    exitCriteria: [{ metric: "appointmentsBooked", op: ">=", target: 1 }],
    outcomeMetrics: ["appointmentsBooked", "attributedDeals", "optOutsHonored"],
    audience: "Owners whose listing expired or was withdrawn", marketSuitability: ["any", "balanced", "buyer_market"], averageCostUsd: 35, priority: 80,
  }),
  def({
    key: "fsbo", version: 1, title: "VIPAgents FSBO Conversion",
    objective: "Earn a for-sale-by-owner seller's listing with an honest value comparison",
    missionType: "campaign", ownerManager: "listing_concierge",
    eligibility: { subjectTypes: ["contact", "lead"], all: [NOT_DNC, NOT_EXHAUSTED], any: [{ fact: "persona", op: "eq", value: "fsbo" }, { fact: "listing_status", op: "eq", value: "fsbo" }] },
    steps: [
      { manager: "data_steward", capabilities: ["contact_get"], purpose: "verify the owner and the property", playbooks: [] },
      { manager: "ai_isa", capabilities: ["isa_qualify"], purpose: "qualify address, representation and timeline", playbooks: [{ kind: "qualification_goal", key: "seller_address" }, { kind: "qualification_goal", key: "representation" }] },
      { manager: "campaign_orchestrator", capabilities: ["marketing_campaign_create"], purpose: "the estimate-comparison nurture", playbooks: [{ kind: "creative_playbook", key: "estimate_comparison" }, { kind: "sequence_persona", key: "fsbo" }] },
      { manager: "listing_concierge", capabilities: ["cma_generate", "listing_appointment_prep"], purpose: "the no-obligation pricing appointment", playbooks: [] },
    ],
    budget: { usd: 30, tokens: 50_000 }, authority: { recommended: 3, approval: "per_authority" },
    timing: { horizonDays: 60, cadenceDays: 7, timelineBuckets: ["immediate", "1-3_months", "3-6_months"] }, fatigue: CONTACT_FATIGUE,
    exitCriteria: [{ metric: "appointmentsBooked", op: ">=", target: 1 }],
    outcomeMetrics: ["appointmentsBooked", "attributedDeals", "optOutsHonored"],
    audience: "Owners selling without an agent", marketSuitability: ["any", "sellers_market"], averageCostUsd: 25, priority: 75,
  }),
  def({
    key: "seller_equity", version: 1, title: "VIPAgents Seller Equity",
    objective: "Show a homeowner what their equity can do and earn the listing conversation",
    missionType: "campaign", ownerManager: "listing_concierge",
    eligibility: { subjectTypes: ["contact"], all: [NOT_DNC, NOT_EXHAUSTED, { fact: "homeowner", op: "is_true", whenKnown: true }, { fact: "intent", op: "neq", value: "buyer", whenKnown: true }, { fact: "equity_pct", op: "gte", value: 20, whenKnown: true, adaptable: { id: "equity_floor_pct", min: 10, max: 50, step: 5 } }] },
    // The owner's order, verbatim: Data Steward find/verify → AI ISA qualify → Campaign nurture → Asset media
    // → Listing Concierge seller experience → Finance economic outcome.
    steps: [
      { manager: "data_steward", capabilities: ["contact_get"], purpose: "find and verify the owner, the property and the equity estimate", playbooks: [{ kind: "kernel_play", key: "intent_campaign" }] },
      { manager: "ai_isa", capabilities: ["isa_qualify"], purpose: "qualify situation and timeline", playbooks: [{ kind: "qualification_goal", key: "seller_situation" }, { kind: "qualification_goal", key: "timeline" }] },
      { manager: "campaign_orchestrator", capabilities: ["marketing_campaign_create"], purpose: "the equity nurture", playbooks: [{ kind: "creative_playbook", key: "anniversary_equity" }, { kind: "creative_playbook", key: "rate_drop_reactivation" }, { kind: "sequence_type", key: "nurture" }] },
      { manager: "asset_manager", capabilities: ["content_repurpose"], purpose: "the equity video / media (reuse before regenerate)", playbooks: [{ kind: "experience", key: "video" }] },
      { manager: "listing_concierge", capabilities: ["cma_generate", "listing_appointment_prep"], purpose: "the seller experience: CMA + appointment prep", playbooks: [{ kind: "experience", key: "appointment" }] },
      { manager: "finance_manager", capabilities: ["report_generate"], purpose: "the economic outcome (attributed revenue vs cost)", playbooks: [] },
    ],
    budget: { usd: 60, tokens: 120_000 }, authority: { recommended: 3, approval: "per_authority" },
    timing: { horizonDays: 90, cadenceDays: 14, timelineBuckets: ["3-6_months", "6-12_months", "12+_months"] }, fatigue: CONTACT_FATIGUE,
    exitCriteria: [{ metric: "appointmentsBooked", op: ">=", target: 1 }],
    outcomeMetrics: ["appointmentsBooked", "attributedDeals", "attributedGciCents", "optOutsHonored"],
    audience: "Homeowners with meaningful equity, not currently buying", marketSuitability: ["any", "appreciating"], averageCostUsd: 55, priority: 70,
  }),
  def({
    key: "sphere_reactivation", version: 1, title: "VIPAgents Sphere Reactivation",
    objective: "Re-open a quiet past-client relationship before a competitor does",
    missionType: "campaign", ownerManager: "sphere_of_influence",
    eligibility: { subjectTypes: ["contact"], all: [NOT_DNC, NOT_EXHAUSTED, { fact: "is_past_client", op: "is_true" }, { fact: "months_since_last_touch", op: "gte", value: 6, adaptable: { id: "quiet_months", min: 3, max: 18, step: 1 } }] },
    steps: [
      { manager: "data_steward", capabilities: ["contact_get"], purpose: "refresh the contact record before reaching out", playbooks: [] },
      { manager: "sphere_of_influence", capabilities: ["handwritten_note_send", "gift_send"], purpose: "the personal touch", playbooks: [] },
      { manager: "campaign_orchestrator", capabilities: ["newsletter_send"], purpose: "the re-engagement sequence", playbooks: [{ kind: "sequence_type", key: "re_engagement" }, { kind: "creative_playbook", key: "rate_drop_reactivation" }, { kind: "creative_playbook", key: "neighbor_brag" }] },
      { manager: "ai_isa", capabilities: ["inbox_reply_send"], purpose: "answer whoever replies", playbooks: [{ kind: "experience", key: "market_update" }] },
    ],
    budget: { usd: 25, tokens: 40_000 }, authority: { recommended: 3, approval: "per_authority" },
    timing: { horizonDays: 60, cadenceDays: 21 }, fatigue: CONTACT_FATIGUE,
    exitCriteria: [{ metric: "draftsSent", op: ">=", target: 1 }],
    outcomeMetrics: ["draftsSent", "appointmentsBooked", "attributedDeals", "optOutsHonored"],
    audience: "Past clients not touched in months", marketSuitability: ["any"], averageCostUsd: 20, priority: 60,
  }),
  def({
    key: "first_time_buyer", version: 2, title: "VIPAgents First-Time Buyer Path",
    objective: "Educate a first-time buyer to a confident first showing",
    missionType: "campaign", ownerManager: "shopping_agent",
    eligibility: { subjectTypes: ["contact", "lead"], all: [NOT_DNC, NOT_EXHAUSTED, { fact: "intent", op: "in", value: ["buyer", "both"], whenKnown: true }], any: [{ fact: "first_time_buyer", op: "is_true" }, { fact: "persona", op: "eq", value: "first_time" }] },
    steps: [
      { manager: "ai_isa", capabilities: ["isa_qualify"], purpose: "qualify criteria and financing", playbooks: [{ kind: "qualification_goal", key: "buyer_criteria" }, { kind: "qualification_goal", key: "financing_status" }] },
      { manager: "campaign_orchestrator", capabilities: ["education_path_get", "education_assign"], purpose: "the first-time-buyer education path", playbooks: [{ kind: "sequence_persona", key: "first_time" }, { kind: "experience", key: "education" }] },
      // v2 (wave 108, owner-approved): the lender pre-approval handoff is a catalogue capability now — the
      // lender is a VENDOR on the brokerage bench (lib/kernel/lender-linkage.ts lenderPreapprovalHandoff).
      { manager: "shopping_agent", capabilities: ["lender_preapproval_handoff", "appointment_schedule", "portal_milestones_get"], purpose: "the lender pre-approval handoff, the buyer kickoff and the first showing", playbooks: [{ kind: "strategy_session", key: "buyer_kickoff" }, { kind: "experience", key: "properties" }] },
    ],
    budget: { usd: 20, tokens: 60_000 }, authority: { recommended: 3, approval: "per_authority" },
    timing: { horizonDays: 120, cadenceDays: 7, timelineBuckets: ["1-3_months", "3-6_months", "6-12_months"] }, fatigue: CONTACT_FATIGUE,
    exitCriteria: [{ metric: "appointmentsBooked", op: ">=", target: 1 }],
    outcomeMetrics: ["appointmentsBooked", "attributedDeals", "optOutsHonored"],
    audience: "First-time buyers", marketSuitability: ["any", "affordable"], averageCostUsd: 15, priority: 65,
  }),
  def({
    key: "listing_launch", version: 2, title: "VIPAgents Listing Launch",
    objective: "Launch a listing with the full bench — media, campaign, ads — in one coordinated week",
    missionType: "campaign", ownerManager: "listing_concierge",
    eligibility: { subjectTypes: ["listing"], all: [{ fact: "listing_status", op: "in", value: ["coming_soon", "active"] }] },
    steps: [
      { manager: "listing_concierge", capabilities: ["listing_publish"], purpose: "stage and publish the launch", playbooks: [{ kind: "kernel_play", key: "deal_play" }, { kind: "strategy_session", key: "listing_launch" }] },
      { manager: "asset_manager", capabilities: ["content_repurpose"], purpose: "the promo reel and social cuts", playbooks: [{ kind: "experience", key: "video" }] },
      { manager: "campaign_orchestrator", capabilities: ["social_post_publish", "newsletter_send"], purpose: "just-listed social + email + neighbors", playbooks: [{ kind: "creative_playbook", key: "open_house_neighbor_vip" }, { kind: "kernel_play", key: "farm_play" }] },
      // v2 (wave 108, owner-approved): the ad draft is the ads_manager's catalogue capability (lib/kernel/ads.ts adCampaignLaunchCapability).
      { manager: "ads_manager", capabilities: ["ad_campaign_launch"], purpose: "the just-listed ad campaign draft (budgeted; live launch stays the ads workspace's approval)", playbooks: [{ kind: "kernel_play", key: "deal_play" }] },
    ],
    budget: { usd: 150, tokens: 150_000 }, authority: { recommended: 3, approval: "per_authority" },
    timing: { horizonDays: 21, cadenceDays: 3 }, fatigue: { scopes: ["contact", "agent"], maxContactRisk: "moderate", deconflict: true },
    exitCriteria: [{ metric: "appointmentsBooked", op: ">=", target: 3 }],
    outcomeMetrics: ["appointmentsBooked", "attributedDeals", "attributedGciCents"],
    audience: "A new or coming-soon listing", marketSuitability: ["any"], averageCostUsd: 140, priority: 90,
  }),
  def({
    key: "recruiting", version: 2, title: "VIPAgents Need-Driven Recruiting",
    objective: "Recruit experienced agents where the twin says capacity is short",
    missionType: "recruiting", ownerManager: "recruiting_manager",
    eligibility: { subjectTypes: ["territory", "brokerage"], all: [{ fact: "recruiting_need", op: "is_true" }] },
    steps: [
      // v2 (wave 108, owner-approved): recruiting outreach is the recruiting_manager's catalogue capability
      // (lib/agents/recruit-outreach-producer.ts recruitOutreachCapability — proposals into the approval gate).
      { manager: "recruiting_manager", capabilities: ["recruit_outreach"], purpose: "target and reach candidate agents", playbooks: [{ kind: "kernel_play", key: "recruit_outreach" }, { kind: "kernel_play", key: "dynamic_playbook" }] },
      { manager: "campaign_orchestrator", capabilities: ["marketing_campaign_create"], purpose: "the recruiting campaign", playbooks: [] },
      { manager: "finance_manager", capabilities: ["report_generate"], purpose: "the offer economics (splits, residuals) the pitch rests on", playbooks: [] },
    ],
    budget: { usd: 100, tokens: 80_000 }, authority: { recommended: 2, approval: "always" },
    timing: { horizonDays: 90, cadenceDays: 14 }, fatigue: { scopes: ["agent"], maxContactRisk: "moderate", deconflict: true },
    exitCriteria: [{ metric: "draftsSent", op: ">=", target: 1 }],
    outcomeMetrics: ["draftsSent", "attributedDeals"],
    audience: "Experienced agents in an under-covered territory", marketSuitability: ["growth", "any"], averageCostUsd: 90, priority: 50,
  }),
  def({
    key: "past_client_referral", version: 1, title: "VIPAgents Past Client Referral",
    objective: "Ask a happy past client for a review and a referral, and capture who they send",
    missionType: "campaign", ownerManager: "sphere_of_influence",
    eligibility: { subjectTypes: ["contact"], all: [NOT_DNC, NOT_EXHAUSTED, { fact: "is_past_client", op: "is_true" }, { fact: "months_since_close", op: "gte", value: 3, whenKnown: true, adaptable: { id: "settle_months", min: 1, max: 12, step: 1 } }] },
    steps: [
      { manager: "sphere_of_influence", capabilities: ["review_request_send", "gift_send"], purpose: "the review ask and the appreciation", playbooks: [{ kind: "creative_playbook", key: "anniversary_equity" }] },
      { manager: "campaign_orchestrator", capabilities: ["newsletter_send"], purpose: "the post-close sequence", playbooks: [{ kind: "sequence_type", key: "post_close" }] },
      { manager: "ai_isa", capabilities: ["lead_create"], purpose: "capture the referred person as a lead (brokerage-owned)", playbooks: [] },
    ],
    budget: { usd: 30, tokens: 30_000 }, authority: { recommended: 3, approval: "per_authority" },
    timing: { horizonDays: 60, cadenceDays: 30 }, fatigue: CONTACT_FATIGUE,
    exitCriteria: [{ metric: "attributedDeals", op: ">=", target: 1 }],
    outcomeMetrics: ["attributedDeals", "attributedGciCents", "optOutsHonored"],
    audience: "Past clients a few months after closing", marketSuitability: ["any"], averageCostUsd: 25, priority: 55,
  }),

  // ─── wave 137E BREADTH (owner: "skills/examples were only for listings; the possibilities are endless") ──
  // Library v3: the full OS beyond listings. Each is a NEW key at v1 (no published version is edited — the
  // immutability rule holds); every step names catalogue keys its manager OWNS or names its gap. Domain sources
  // (the repo's installed skills): real-estate-expert, realestate-analyze/-comps/-invest/-rental/-market/
  // -neighborhood, real-estate:cma-narrative / offer-comparison / market-update / client-email, mortgage-broker-
  // mortgage-lending, recruiter-talent-acquisition, ads-strategy / ads-budget, market-*, geo-content,
  // social-media-manager-*, remotion-best-practices, real-estate-real-estate-marketing (Fair Housing),
  // bookkeeper-financial-reporting, ecc agentic-os / agentic-engineering / autonomous-loops (the bounded loop shape).
  def({
    key: "buyer_search_to_offer", version: 1, title: "VIPAgents Buyer Search to Offer",
    objective: "Carry a searching buyer contact from criteria and pre-approval through tours to an offer decision",
    missionType: "campaign", ownerManager: "shopping_agent",
    // Owner (wave 108): only CONTACTS tour — a lead converts to a contact first, so the subject is a contact.
    eligibility: { subjectTypes: ["contact"], all: [NOT_DNC, NOT_EXHAUSTED, { fact: "intent", op: "in", value: ["buyer", "both"], whenKnown: true }],
      any: [{ fact: "buyer_stage", op: "in", value: ["BUYER_SEARCHING", "BUYER_SEARCH_CONFIGURED", "BUYER_TOUR_ELIGIBLE", "BUYER_TOURING", "BUYER_FINANCIALLY_VERIFIED", "BUYER_OFFER_ELIGIBLE"] }, { fact: "lender_status", op: "eq", value: "needs_pre_approval" }] },
    steps: [
      { manager: "ai_isa", capabilities: ["isa_qualify"], purpose: "confirm criteria, financing and timeline", playbooks: [{ kind: "qualification_goal", key: "buyer_criteria" }, { kind: "qualification_goal", key: "financing_status" }, { kind: "qualification_goal", key: "timeline" }] },
      { manager: "shopping_agent", capabilities: ["lender_preapproval_handoff", "appointment_schedule", "portal_milestones_get"], purpose: "the bench-lender pre-approval handoff, the tours, the portal timeline and the offer decision", playbooks: [{ kind: "strategy_session", key: "buyer_kickoff" }, { kind: "strategy_session", key: "offer_decision" }, { kind: "experience", key: "properties" }] },
      { manager: "campaign_orchestrator", capabilities: ["education_assign"], purpose: "the buyer education between tours (process, offers, inspections)", playbooks: [{ kind: "sequence_type", key: "nurture" }, { kind: "experience", key: "education" }] },
    ],
    budget: { usd: 25, tokens: 60_000 }, authority: { recommended: 3, approval: "per_authority" },
    timing: { horizonDays: 90, cadenceDays: 5, timelineBuckets: ["immediate", "1-3_months", "3-6_months"] }, fatigue: CONTACT_FATIGUE,
    exitCriteria: [{ metric: "appointmentsBooked", op: ">=", target: 2 }],
    outcomeMetrics: ["appointmentsBooked", "attributedDeals", "attributedGciCents", "optOutsHonored"],
    audience: "Buyer contacts searching or touring", marketSuitability: ["any"], averageCostUsd: 20, priority: 68,
  }),
  def({
    key: "seller_valuation_to_listing", version: 1, title: "VIPAgents Seller Valuation to Listing",
    objective: "Turn a seller's valuation question into a priced listing appointment with an honest net picture",
    missionType: "campaign", ownerManager: "listing_concierge",
    eligibility: { subjectTypes: ["contact"], all: [NOT_DNC, NOT_EXHAUSTED, { fact: "intent", op: "in", value: ["seller", "both"], whenKnown: true }, { fact: "homeowner", op: "is_true", whenKnown: true }] },
    steps: [
      { manager: "data_steward", capabilities: ["contact_get"], purpose: "verify the owner, the property and the valuation on the AVM provider chain", playbooks: [{ kind: "kernel_play", key: "intent_campaign" }] },
      { manager: "listing_concierge", capabilities: ["cma_generate", "listing_appointment_prep"], purpose: "the CMA, the pricing conversation and the listing appointment", playbooks: [{ kind: "creative_playbook", key: "zestimate_challenge" }, { kind: "strategy_session", key: "price_change" }, { kind: "experience", key: "appointment" }] },
      { manager: "finance_manager", capabilities: ["report_generate"], purpose: "the seller net picture from the brokerage's own closed economics (never a model-made number)", playbooks: [] },
    ],
    budget: { usd: 30, tokens: 60_000 }, authority: { recommended: 3, approval: "per_authority" },
    timing: { horizonDays: 45, cadenceDays: 7, timelineBuckets: ["immediate", "1-3_months", "3-6_months"] }, fatigue: CONTACT_FATIGUE,
    exitCriteria: [{ metric: "appointmentsBooked", op: ">=", target: 1 }],
    outcomeMetrics: ["appointmentsBooked", "attributedDeals", "attributedGciCents", "optOutsHonored"],
    audience: "Seller contacts asking what their home is worth", marketSuitability: ["any"], averageCostUsd: 25, priority: 72,
  }),
  def({
    key: "investor_property_match", version: 1, title: "VIPAgents Investor Property Match",
    objective: "Keep an investor contact supplied with property-only opportunities and tour the ones that pencil",
    missionType: "campaign", ownerManager: "shopping_agent",
    eligibility: { subjectTypes: ["contact"], all: [NOT_DNC, NOT_EXHAUSTED], any: [{ fact: "persona", op: "eq", value: "investor" }, { fact: "intent", op: "eq", value: "investor" }] },
    steps: [
      { manager: "data_steward", capabilities: ["contact_get"], purpose: "the investor's buy box from the contact record", playbooks: [] },
      { manager: "shopping_agent", capabilities: ["appointment_schedule", "portal_milestones_get"], purpose: "property-only matches and the tours that pencil", playbooks: [{ kind: "experience", key: "properties" }, { kind: "strategy_session", key: "offer_decision" }] },
      { manager: "campaign_orchestrator", capabilities: ["newsletter_send"], purpose: "the investor market update", playbooks: [{ kind: "sequence_persona", key: "investor" }, { kind: "experience", key: "market_update" }] },
    ],
    budget: { usd: 20, tokens: 40_000 }, authority: { recommended: 3, approval: "per_authority" },
    timing: { horizonDays: 120, cadenceDays: 14 }, fatigue: CONTACT_FATIGUE,
    exitCriteria: [{ metric: "appointmentsBooked", op: ">=", target: 1 }],
    outcomeMetrics: ["appointmentsBooked", "attributedDeals", "optOutsHonored"],
    audience: "Investor contacts (property-only)", marketSuitability: ["any"], averageCostUsd: 15, priority: 58,
  }),
  def({
    key: "home_value_review", version: 1, title: "VIPAgents Annual Home Value Review",
    objective: "Give a lifetime client a yearly home value review on their anniversary and keep the relationship warm",
    missionType: "campaign", ownerManager: "sphere_of_influence",
    eligibility: { subjectTypes: ["contact"], all: [NOT_DNC, NOT_EXHAUSTED, { fact: "is_past_client", op: "is_true" }, { fact: "homeowner", op: "is_true", whenKnown: true }, { fact: "months_since_close", op: "gte", value: 11, whenKnown: true, adaptable: { id: "review_months", min: 6, max: 24, step: 1 } }] },
    steps: [
      { manager: "data_steward", capabilities: ["contact_get"], purpose: "refresh the owner record before the review", playbooks: [] },
      { manager: "listing_concierge", capabilities: ["cma_generate"], purpose: "the home value review (CMA on the AVM provider chain)", playbooks: [{ kind: "creative_playbook", key: "anniversary_equity" }] },
      { manager: "sphere_of_influence", capabilities: ["handwritten_note_send"], purpose: "the anniversary note that carries the review", playbooks: [{ kind: "creative_playbook", key: "anniversary_equity" }] },
      { manager: "campaign_orchestrator", capabilities: ["newsletter_send"], purpose: "the post-close market update", playbooks: [{ kind: "sequence_type", key: "post_close" }, { kind: "experience", key: "market_update" }] },
    ],
    budget: { usd: 15, tokens: 30_000 }, authority: { recommended: 3, approval: "per_authority" },
    timing: { horizonDays: 30, cadenceDays: 14 }, fatigue: CONTACT_FATIGUE,
    exitCriteria: [{ metric: "draftsSent", op: ">=", target: 1 }],
    outcomeMetrics: ["draftsSent", "appointmentsBooked", "attributedDeals", "optOutsHonored"],
    audience: "Lifetime clients on their home anniversary", marketSuitability: ["any"], averageCostUsd: 12, priority: 62,
  }),
  def({
    key: "transaction_to_close", version: 1, title: "VIPAgents Contract to Close",
    objective: "Carry an under-contract client to a clean close: deadlines, documents, portal and the closing touch",
    missionType: "transaction", ownerManager: "deal_coordinator",
    eligibility: { subjectTypes: ["contact", "listing"], all: [], any: [{ fact: "buyer_stage", op: "eq", value: "BUYER_UNDER_CONTRACT" }, { fact: "listing_status", op: "in", value: ["pending", "under_contract"] }] },
    steps: [
      { manager: "deal_coordinator", capabilities: ["transaction_advance"], purpose: "advance the transaction through its lifecycle as deadlines clear", playbooks: [{ kind: "sequence_type", key: "transaction" }] },
      { manager: "shopping_agent", capabilities: ["portal_milestones_get"], purpose: "the client-portal timeline and the document explanations", playbooks: [{ kind: "experience", key: "portal_task" }, { kind: "experience", key: "document_explanation" }] },
      { manager: "sphere_of_influence", capabilities: ["gift_send"], purpose: "the closing gift (the lifetime relationship starts here)", playbooks: [] },
      { manager: "finance_manager", capabilities: ["report_generate"], purpose: "the commission and closing economics (deterministic ledger, Finance reviews)", playbooks: [] },
    ],
    budget: { usd: 60, tokens: 40_000 }, authority: { recommended: 3, approval: "per_authority" },
    timing: { horizonDays: 60, cadenceDays: 3 }, fatigue: { scopes: ["contact", "agent"], maxContactRisk: "moderate", deconflict: true },
    exitCriteria: [{ metric: "attributedDeals", op: ">=", target: 1 }],
    outcomeMetrics: ["attributedDeals", "attributedGciCents"],
    audience: "Clients under contract", marketSuitability: ["any"], averageCostUsd: 55, priority: 85,
  }),
  def({
    key: "territory_acquisition", version: 1, title: "VIPAgents Territory Acquisition",
    objective: "Win more seller business in a territory whose demand is rising — farm, content, paid and a measured return",
    missionType: "campaign", ownerManager: "campaign_orchestrator",
    // The territory is the tenant's own farm_territories row (the subject) — never a hard-coded market.
    eligibility: { subjectTypes: ["territory"], all: [{ fact: "territory_seller_demand_up", op: "is_true" }] },
    steps: [
      { manager: "listing_concierge", capabilities: ["listing_demand_report"], purpose: "read seller demand in the territory against the window before", playbooks: [] },
      { manager: "campaign_orchestrator", capabilities: ["direct_mail_send", "social_post_publish"], purpose: "the farm mail drop and the neighborhood social cadence", playbooks: [{ kind: "kernel_play", key: "farm_play" }, { kind: "creative_playbook", key: "neighbor_brag" }, { kind: "creative_playbook", key: "zestimate_challenge" }] },
      { manager: "asset_manager", capabilities: ["content_repurpose"], purpose: "neighborhood video and social cuts (reuse before regenerate)", playbooks: [{ kind: "experience", key: "video" }] },
      { manager: "ads_manager", capabilities: ["ads_performance_report", "ad_campaign_launch"], purpose: "the budgeted territory ad draft against measured paid performance", playbooks: [] },
      { manager: "finance_manager", capabilities: ["report_generate"], purpose: "the acquisition return (attributed revenue vs spend)", playbooks: [] },
    ],
    budget: { usd: 300, tokens: 100_000 }, authority: { recommended: 3, approval: "always" },
    timing: { horizonDays: 90, cadenceDays: 14 }, fatigue: { scopes: ["contact", "agent"], maxContactRisk: "moderate", deconflict: true },
    exitCriteria: [{ metric: "appointmentsBooked", op: ">=", target: 2 }],
    outcomeMetrics: ["appointmentsBooked", "attributedDeals", "attributedGciCents", "optOutsHonored"],
    audience: "A farm territory with rising seller demand", marketSuitability: ["any", "growth"], averageCostUsd: 280, priority: 45,
  }),
  def({
    key: "client_portal_activation", version: 1, title: "VIPAgents Client Portal Activation",
    objective: "Get an active client into their portal — timeline, tasks and document explanations in one place",
    missionType: "campaign", ownerManager: "shopping_agent",
    eligibility: { subjectTypes: ["contact"], all: [NOT_DNC, NOT_EXHAUSTED, { fact: "intent", op: "in", value: ["buyer", "seller", "both"], whenKnown: true }] },
    steps: [
      { manager: "shopping_agent", capabilities: ["portal_milestones_get"], purpose: "the client's portal timeline and next task", playbooks: [{ kind: "experience", key: "portal_task" }] },
      { manager: "campaign_orchestrator", capabilities: ["education_path_get", "education_assign"], purpose: "the document explanations the portal surfaces", playbooks: [{ kind: "experience", key: "document_explanation" }, { kind: "experience", key: "education" }] },
      { manager: "ai_isa", capabilities: ["inbox_reply_send"], purpose: "answer the client's portal questions (compliance-gated)", playbooks: [] },
    ],
    budget: { usd: 10, tokens: 30_000 }, authority: { recommended: 3, approval: "per_authority" },
    timing: { horizonDays: 30, cadenceDays: 7 }, fatigue: CONTACT_FATIGUE,
    exitCriteria: [{ metric: "draftsSent", op: ">=", target: 1 }],
    outcomeMetrics: ["draftsSent", "appointmentsBooked", "optOutsHonored"],
    audience: "Active buyer and seller clients", marketSuitability: ["any"], averageCostUsd: 8, priority: 52,
  }),
  def({
    key: "agent_development_retention", version: 1, title: "VIPAgents Agent Development & Retention",
    objective: "Keep and grow the agents the brokerage has — competency coaching where the twin sees a weakness, economics they can see",
    missionType: "recruiting", ownerManager: "recruiting_manager",
    eligibility: { subjectTypes: ["brokerage", "territory"], all: [] },
    steps: [
      // wave 138C: the named gap is closed — agent_coaching_assign runs the adaptive development cycle (skill-freshness-radar).
      { manager: "recruiting_manager", capabilities: ["agent_coaching_assign"], purpose: "the competency coaching plan for in-development agents", playbooks: [] },
      { manager: "finance_manager", capabilities: ["report_generate"], purpose: "the agent's own production and cap progress (agents see their own economics, never brokerage margin)", playbooks: [] },
    ],
    budget: { usd: 0, tokens: 40_000 }, authority: { recommended: 2, approval: "always" },
    timing: { horizonDays: 90, cadenceDays: 30 }, fatigue: { scopes: ["agent"], maxContactRisk: "moderate", deconflict: true },
    exitCriteria: [{ metric: "attributedDeals", op: ">=", target: 1 }],
    outcomeMetrics: ["attributedDeals"],
    audience: "In-development and at-risk agents", marketSuitability: ["any"], averageCostUsd: 5, priority: 40,
  }),
  def({
    key: "compliance_first_marketing", version: 1, title: "VIPAgents Compliance-First Marketing",
    objective: "Write and review marketing fair-housing-first, and read back opt-outs and complaints before scaling a campaign",
    missionType: "compliance", ownerManager: "compliance_officer",
    eligibility: { subjectTypes: ["brokerage"], all: [] },
    steps: [
      // wave 138C: the named gap is closed — compliance_review is the compliance officer's read-only verdict capability.
      { manager: "compliance_officer", capabilities: ["compliance_review"], purpose: "the fair-housing review of the campaign's copy and audience basis", playbooks: [] },
      { manager: "asset_manager", capabilities: ["content_repurpose"], purpose: "compliance-first scripts (fair housing in the writing prompt, not only the post-hoc scan)", playbooks: [{ kind: "experience", key: "video" }] },
      { manager: "campaign_orchestrator", capabilities: ["campaign_performance_report"], purpose: "the opt-out / reply read-back before the campaign scales", playbooks: [] },
    ],
    budget: { usd: 0, tokens: 30_000 }, authority: { recommended: 1, approval: "always" },
    timing: { horizonDays: 30, cadenceDays: 7 }, fatigue: { scopes: ["contact"], maxContactRisk: "moderate", deconflict: true },
    exitCriteria: [{ metric: "draftsSent", op: ">=", target: 1 }],
    outcomeMetrics: ["optOutsHonored", "draftsSent"],
    audience: "Any brokerage running outbound marketing", marketSuitability: ["any"], averageCostUsd: 2, priority: 35,
  }),
  def({
    key: "commission_residual_review", version: 1, title: "VIPAgents Commission & Residual Review",
    objective: "Give Finance a monthly ledger-true view of commissions, residuals and the accounting connector's health",
    missionType: "brokerage_objective", ownerManager: "finance_manager",
    eligibility: { subjectTypes: ["brokerage"], all: [] },
    steps: [
      { manager: "data_steward", capabilities: ["connectivity_scan"], purpose: "is the accounting connector live before the books are read", playbooks: [] },
      { manager: "finance_manager", capabilities: ["report_generate", "report_export"], purpose: "the commission + residual report from the ledger (no LLM calculates money) and its export", playbooks: [] },
    ],
    budget: { usd: 0, tokens: 10_000 }, authority: { recommended: 1, approval: "per_authority" },
    timing: { horizonDays: 30, cadenceDays: 30 }, fatigue: { scopes: ["agent"], maxContactRisk: "moderate", deconflict: true },
    exitCriteria: [{ metric: "attributedGciCents", op: ">=", target: 1 }],
    outcomeMetrics: ["attributedGciCents", "attributedDeals"],
    audience: "The brokerage's finance desk", marketSuitability: ["any"], averageCostUsd: 0, priority: 30,
  }),
  // ── v4 (wave 138E): the domains 137E left at ONE strategy (investors, transactions/closing, compliance,
  // territory) each get a second — appended at v1, no published version edited. Domain sources: realestate-invest
  // / -rental / real-estate-investment (portfolio review), real-estate-expert + legal-compliance (closing file),
  // recruiter-talent-acquisition + realestate-market (territory capacity), ecc autonomous-loops (bounded cadence).
  def({
    key: "investor_portfolio_review", version: 1, title: "VIPAgents Investor Portfolio Review",
    objective: "Give a past-client investor a property-only value review of what they hold and tour the next acquisition that pencils",
    missionType: "campaign", ownerManager: "sphere_of_influence",
    eligibility: { subjectTypes: ["contact"], all: [NOT_DNC, NOT_EXHAUSTED, { fact: "is_past_client", op: "is_true" }], any: [{ fact: "persona", op: "eq", value: "investor" }, { fact: "intent", op: "eq", value: "investor" }] },
    steps: [
      { manager: "data_steward", capabilities: ["contact_get"], purpose: "the holdings and buy box on the contact record (property-only — no person data leaves it)", playbooks: [] },
      { manager: "listing_concierge", capabilities: ["cma_generate"], purpose: "a value review of each held property on the AVM provider chain", playbooks: [{ kind: "creative_playbook", key: "anniversary_equity" }] },
      { manager: "sphere_of_influence", capabilities: ["handwritten_note_send"], purpose: "the review delivered as a lifetime-client touch", playbooks: [] },
      { manager: "shopping_agent", capabilities: ["appointment_schedule"], purpose: "the review meeting and the next acquisition tour", playbooks: [{ kind: "experience", key: "properties" }] },
    ],
    budget: { usd: 15, tokens: 30_000 }, authority: { recommended: 3, approval: "per_authority" },
    timing: { horizonDays: 60, cadenceDays: 21 }, fatigue: CONTACT_FATIGUE,
    exitCriteria: [{ metric: "appointmentsBooked", op: ">=", target: 1 }],
    outcomeMetrics: ["appointmentsBooked", "attributedDeals", "optOutsHonored"],
    audience: "Past-client investors (property-only)", marketSuitability: ["any"], averageCostUsd: 12, priority: 50,
  }),
  def({
    key: "closing_file_compliance_review", version: 1, title: "VIPAgents Closing File Compliance Review",
    objective: "Audit an under-contract file (documents, disclosures, the dates that govern the deal) before a stage advances",
    missionType: "transaction", ownerManager: "deal_coordinator",
    eligibility: { subjectTypes: ["contact", "listing"], all: [], any: [{ fact: "buyer_stage", op: "eq", value: "BUYER_UNDER_CONTRACT" }, { fact: "listing_status", op: "in", value: ["pending", "under_contract"] }] },
    steps: [
      { manager: "data_steward", capabilities: ["connectivity_scan"], purpose: "the e-sign / document connectors are live before the file is read", playbooks: [] },
      { manager: "compliance_officer", capabilities: [], purpose: "the file audit — disclosures, signatures, deadline conflicts", playbooks: [],
        gap: "the compliance_officer owns no catalogue capability — the file audit runs on lib/kernel/document-compliance-audit.ts outside the capability catalogue" },
      { manager: "shopping_agent", capabilities: ["portal_milestones_get"], purpose: "the client-visible dates that govern the deal", playbooks: [{ kind: "experience", key: "document_explanation" }] },
      { manager: "deal_coordinator", capabilities: ["transaction_advance"], purpose: "advance the stage ONLY once the audit clears (a human approves every advance)", playbooks: [{ kind: "sequence_type", key: "transaction" }] },
    ],
    budget: { usd: 0, tokens: 20_000 }, authority: { recommended: 2, approval: "always" },
    timing: { horizonDays: 45, cadenceDays: 3 }, fatigue: { scopes: ["contact", "agent"], maxContactRisk: "moderate", deconflict: true },
    exitCriteria: [{ metric: "attributedDeals", op: ">=", target: 1 }],
    outcomeMetrics: ["attributedDeals"],
    audience: "Files under contract", marketSuitability: ["any"], averageCostUsd: 1, priority: 70,
  }),
  def({
    key: "territory_capacity_recruiting", version: 1, title: "VIPAgents Territory Capacity Recruiting",
    objective: "Where a territory's seller demand outruns its agent capacity, recruit for that territory before buying more leads",
    missionType: "recruiting", ownerManager: "recruiting_manager",
    // The territory is the tenant's own farm_territories row — never a hard-coded market.
    eligibility: { subjectTypes: ["territory"], all: [{ fact: "territory_seller_demand_up", op: "is_true" }, { fact: "recruiting_need", op: "is_true" }] },
    steps: [
      { manager: "listing_concierge", capabilities: ["listing_demand_report"], purpose: "seller demand and agent capacity in the territory against the window before", playbooks: [] },
      { manager: "ai_isa", capabilities: ["lead_search"], purpose: "the territory's seller leads waiting on capacity (read only)", playbooks: [] },
      { manager: "recruiting_manager", capabilities: ["recruit_outreach"], purpose: "outreach to recruits who farm or live in the territory (proposals into the approval gate)", playbooks: [{ kind: "kernel_play", key: "recruit_outreach" }] },
    ],
    budget: { usd: 0, tokens: 30_000 }, authority: { recommended: 2, approval: "always" },
    timing: { horizonDays: 90, cadenceDays: 30 }, fatigue: { scopes: ["agent"], maxContactRisk: "moderate", deconflict: true },
    exitCriteria: [{ metric: "attributedDeals", op: ">=", target: 1 }],
    outcomeMetrics: ["attributedDeals"],
    audience: "A territory whose seller demand outruns its agent capacity", marketSuitability: ["any", "growth"], averageCostUsd: 2, priority: 42,
  }),
])

/** The library's published edition — v1 the owner's eight (107E), v2 the three owner-approved gaps built
 *  (108H), v3 the full-OS breadth (137E), v4 every OS domain at ≥ 2 strategies (138E). A bump appends; it
 *  never edits a published strategy version. */
export const PLATFORM_STRATEGY_LIBRARY_EDITION = 4

/** The OS domains the platform must cover (owner, wave 137 BREADTH) — the census the proof asserts:
 *  every domain carries ≥ 1 platform strategy and ≥ 1 platform skill example. */
export const OS_DOMAINS = [
  "buyers", "sellers", "investors", "sphere_lifetime", "recruiting_retention", "transactions_closing",
  "lenders_vendors", "marketing_content", "education_coaching", "finance_commission", "compliance", "portals",
  "property_intelligence", "territory_acquisition",
] as const
export type OsDomain = (typeof OS_DOMAINS)[number]

/** Which domains each platform strategy serves — kept BESIDE the definitions so tagging never changes a
 *  published version's digest (strategyDigest covers the definition only). */
export const STRATEGY_DOMAINS: Readonly<Record<string, readonly OsDomain[]>> = Object.freeze({
  expired_listing: ["sellers", "marketing_content"],
  fsbo: ["sellers"],
  seller_equity: ["sellers", "property_intelligence"],
  sphere_reactivation: ["sphere_lifetime"],
  first_time_buyer: ["buyers", "lenders_vendors", "education_coaching"],
  listing_launch: ["sellers", "marketing_content"],
  recruiting: ["recruiting_retention", "finance_commission"],
  past_client_referral: ["sphere_lifetime"],
  buyer_search_to_offer: ["buyers", "lenders_vendors", "portals"],
  seller_valuation_to_listing: ["sellers", "property_intelligence"],
  investor_property_match: ["investors", "property_intelligence"],
  home_value_review: ["sphere_lifetime", "property_intelligence"],
  transaction_to_close: ["transactions_closing", "portals", "finance_commission"],
  territory_acquisition: ["territory_acquisition", "marketing_content"],
  client_portal_activation: ["portals", "education_coaching"],
  agent_development_retention: ["recruiting_retention", "education_coaching"],
  compliance_first_marketing: ["compliance", "marketing_content"],
  commission_residual_review: ["finance_commission"],
  investor_portfolio_review: ["investors", "sphere_lifetime", "property_intelligence"],
  closing_file_compliance_review: ["transactions_closing", "compliance"],
  territory_capacity_recruiting: ["territory_acquisition", "recruiting_retention"],
})

/** The owner's eight, by key (the seed set the proof checks). */
export const OWNER_SEED_STRATEGY_KEYS = ["expired_listing", "fsbo", "seller_equity", "sphere_reactivation", "first_time_buyer", "listing_launch", "recruiting", "past_client_referral"] as const

// ─── derived views ────────────────────────────────────────────────────────────────────────────
/** Participating managers, in step order (deduped). */
export function participatingManagers(s: Pick<StrategyDefinition, "steps">): ManagerKey[] {
  return [...new Set(s.steps.map((x) => x.manager))]
}
export function strategyCapabilities(s: Pick<StrategyDefinition, "steps">): AppCapability[] {
  return [...new Set(s.steps.flatMap((x) => x.capabilities))]
}
export function strategyGaps(s: Pick<StrategyDefinition, "steps">): Array<{ manager: ManagerKey; gap: string }> {
  return s.steps.filter((x) => x.gap).map((x) => ({ manager: x.manager, gap: x.gap! }))
}
export function strategyRef(s: Pick<StrategyDefinition, "key" | "version">): string { return `${s.key}@v${s.version}` }
export function strategyLabel(s: Pick<StrategyDefinition, "title" | "version">): string { return `${s.title} v${s.version}` }

/** The latest published platform version of a key, or a specific one. */
export function platformStrategy(key: string, version?: number): StrategyDefinition | null {
  const all = PLATFORM_STRATEGY_LIBRARY.filter((s) => s.key === key)
  if (version !== undefined) return all.find((s) => s.version === version) ?? null
  return all.reduce<StrategyDefinition | null>((a, s) => (!a || s.version > a.version ? s : a), null)
}

/** PURE, stable: a digest of a definition (FNV-1a over canonical JSON) — the immutability witness the
 *  library row carries (strategy_library.definition_digest). */
export function strategyDigest(s: StrategyDefinition): string {
  const json = canonicalJson(s)
  let h = 0x811c9dc5
  for (let i = 0; i < json.length; i++) { h ^= json.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return `fnv1a:${h.toString(16).padStart(8, "0")}:${json.length}`
}
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`
  return JSON.stringify(v ?? null)
}
function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o as object)) deepFreeze(v) }
  return o
}

// ─── eligibility (deterministic) ──────────────────────────────────────────────────────────────
export interface EligibilityVerdict { eligible: boolean; failed: string[]; unknown: string[] }

function clauseHolds(c: EligibilityClause, facts: StrategyFacts, thresholds: Readonly<Record<string, number>>): "pass" | "fail" | "unknown" {
  const v = facts[c.fact]
  if (v === undefined || v === null) return c.whenKnown ? "pass" : "unknown"
  const target = c.adaptable && typeof thresholds[c.adaptable.id] === "number" ? thresholds[c.adaptable.id] : c.value
  switch (c.op) {
    case "eq": return v === target ? "pass" : "fail"
    case "neq": return v !== target ? "pass" : "fail"
    case "in": return Array.isArray(target) && (target as readonly unknown[]).includes(v) ? "pass" : "fail"
    case "gte": return typeof v === "number" && typeof target === "number" && v >= target ? "pass" : "fail"
    case "lte": return typeof v === "number" && typeof target === "number" && v <= target ? "pass" : "fail"
    case "is_true": return v === true ? "pass" : "fail"
    case "is_false": return v === false ? "pass" : "fail"
  }
}
const clauseText = (c: EligibilityClause) => `${c.fact} ${c.op}${c.value !== undefined ? ` ${JSON.stringify(c.value)}` : ""}`

/** PURE: does the strategy apply to these facts? An unknown fact FAILS CLOSED unless the clause is
 *  `whenKnown`. `thresholds` are the tenant-adapted values of the adaptable clauses.
 *  @proofSeam scripts/strategy-engine-guard.ts asserts the fail-closed / whenKnown / adapted-threshold rule on it directly; rankStrategies is its product caller */
export function evaluateEligibility(s: Pick<StrategyDefinition, "eligibility">, facts: StrategyFacts, thresholds: Readonly<Record<string, number>> = {}): EligibilityVerdict {
  const failed: string[] = [], unknown: string[] = []
  if (facts.subject_type && !s.eligibility.subjectTypes.includes(facts.subject_type)) failed.push(`subject_type ${facts.subject_type} not in ${s.eligibility.subjectTypes.join("|")}`)
  for (const c of s.eligibility.all) { const r = clauseHolds(c, facts, thresholds); if (r === "fail") failed.push(clauseText(c)); else if (r === "unknown") unknown.push(c.fact) }
  const any = s.eligibility.any ?? []
  if (any.length) {
    const rs = any.map((c) => clauseHolds(c, facts, thresholds))
    if (!rs.includes("pass")) { if (rs.every((r) => r === "unknown")) unknown.push(any.map((c) => c.fact).join("|")); else failed.push(`none of ${any.map(clauseText).join(" / ")}`) }
  }
  return { eligible: failed.length === 0 && unknown.length === 0, failed, unknown }
}

// ─── adaptation (tenant policy + tenant history → a recorded adaptation; the version never changes) ──
/** brokerage_settings.settings.strategy_overrides[key] (tenant policy, versioned — lib/kernel/tenant-policy.ts). */
export interface StrategyPolicyOverride { budgetUsd?: number; authority?: AuthorityLevel; approval?: "per_authority" | "always"; cadenceDays?: number; horizonDays?: number }
/** What the tenant's own history says (107F seam): conversion on this strategy vs the platform benchmark. */
export interface StrategyHistory { sample: number; conversionRate: number | null; benchmarkRate: number | null }
export const HISTORY_MIN_SAMPLE = 30

export interface StrategyAdaptation {
  ref: string
  digest: string
  budget: { usd: number; tokens?: number }
  authority: { recommended: AuthorityLevel; approval: "per_authority" | "always" }
  timing: { horizonDays: number; cadenceDays: number }
  thresholds: Record<string, number>
  changes: Array<{ field: string; from: unknown; to: unknown; source: "tenant_policy" | "tenant_history"; reason: string }>
}

/** PURE: adapt a version to a tenant. Policy overrides clamp to sane bounds and may only TIGHTEN authority
 *  below the recommended rung or raise it to no more than 6; history moves an adaptable threshold ONE step
 *  (tighten when the tenant converts < 0.8× the benchmark, loosen when > 1.2×, both on ≥ HISTORY_MIN_SAMPLE).
 *  Every change is recorded with its source and reason. */
export function adaptStrategy(s: StrategyDefinition, policy: StrategyPolicyOverride | null | undefined, history: StrategyHistory | null | undefined): StrategyAdaptation {
  const changes: StrategyAdaptation["changes"] = []
  const budget = { ...s.budget }
  const authority = { ...s.authority }
  const timing = { horizonDays: s.timing.horizonDays, cadenceDays: s.timing.cadenceDays }
  if (policy) {
    if (typeof policy.budgetUsd === "number" && Number.isFinite(policy.budgetUsd) && policy.budgetUsd >= 0 && policy.budgetUsd <= 100_000 && policy.budgetUsd !== budget.usd) {
      changes.push({ field: "budget.usd", from: budget.usd, to: policy.budgetUsd, source: "tenant_policy", reason: "strategy_overrides.budgetUsd" }); budget.usd = policy.budgetUsd
    }
    if (typeof policy.authority === "number" && Number.isInteger(policy.authority) && policy.authority >= 0 && policy.authority <= 6 && policy.authority !== authority.recommended) {
      changes.push({ field: "authority.recommended", from: authority.recommended, to: policy.authority, source: "tenant_policy", reason: "strategy_overrides.authority" }); authority.recommended = policy.authority
    }
    if ((policy.approval === "always" || policy.approval === "per_authority") && policy.approval !== authority.approval) {
      changes.push({ field: "authority.approval", from: authority.approval, to: policy.approval, source: "tenant_policy", reason: "strategy_overrides.approval" }); authority.approval = policy.approval
    }
    for (const f of ["cadenceDays", "horizonDays"] as const) {
      const v = policy[f]
      if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 365 && v !== timing[f]) { changes.push({ field: `timing.${f}`, from: timing[f], to: v, source: "tenant_policy", reason: `strategy_overrides.${f}` }); timing[f] = v }
    }
  }
  const thresholds: Record<string, number> = {}
  const adaptable = [...s.eligibility.all, ...(s.eligibility.any ?? [])].filter((c) => c.adaptable && typeof c.value === "number")
  for (const c of adaptable) {
    const a = c.adaptable!, base = c.value as number
    let next = base
    if (history && history.sample >= HISTORY_MIN_SAMPLE && history.conversionRate !== null && history.benchmarkRate !== null && history.benchmarkRate > 0) {
      const ratio = history.conversionRate / history.benchmarkRate
      // A "gte" threshold tightens UPWARD (fewer, better-fitting subjects); an "lte" one tightens downward.
      const dir = c.op === "lte" ? -1 : 1
      if (ratio < 0.8) next = base + dir * a.step
      else if (ratio > 1.2) next = base - dir * a.step
      next = Math.min(a.max, Math.max(a.min, next))
      if (next !== base) changes.push({ field: `threshold.${a.id}`, from: base, to: next, source: "tenant_history", reason: `tenant conversion ${(history.conversionRate * 100).toFixed(1)}% vs benchmark ${(history.benchmarkRate * 100).toFixed(1)}% on ${history.sample} outcomes` })
    }
    thresholds[a.id] = next
  }
  return { ref: strategyRef(s), digest: strategyDigest(s), budget, authority, timing, thresholds, changes }
}

// ─── ranking (pure) ───────────────────────────────────────────────────────────────────────────
/** Learned performance per strategy key (107F seam). `score` in [0,1]; absent = unlearned. */
export interface StrategyPerformance { score: number; sample: number; benchmarkRate?: number | null; tenantRate?: number | null; source: string }
export interface StrategyCandidate { definition: StrategyDefinition; adaptation: StrategyAdaptation; activationId: string | null }
export interface RankedStrategy extends StrategyCandidate { rank: number; score: number; eligibility: EligibilityVerdict; performance: StrategyPerformance | null; why: string }

/** PURE: eligible candidates (optionally only those a manager participates in), ranked by base priority
 *  + learned performance (a learned score ≥ HISTORY_MIN_SAMPLE outweighs priority by up to 50 points);
 *  ties break on key — deterministic. `facts: null` = BROKERAGE scope (a manager planning its week): no
 *  subject to judge, so eligibility is deferred to each subject and said so in the verdict. */
export function rankStrategies(candidates: readonly StrategyCandidate[], facts: StrategyFacts | null, opts: { manager?: ManagerKey | null; performance?: Readonly<Record<string, StrategyPerformance>> } = {}): RankedStrategy[] {
  const out: RankedStrategy[] = []
  for (const c of candidates) {
    if (opts.manager && !participatingManagers(c.definition).includes(opts.manager)) continue
    const eligibility: EligibilityVerdict = facts ? evaluateEligibility(c.definition, facts, c.adaptation.thresholds) : { eligible: true, failed: [], unknown: ["(brokerage scope — eligibility is judged per subject)"] }
    if (!eligibility.eligible) continue
    const perf = opts.performance?.[c.definition.key] ?? null
    const learned = perf && perf.sample >= HISTORY_MIN_SAMPLE ? Math.max(0, Math.min(1, perf.score)) * 50 : 0
    const score = c.definition.priority + learned
    out.push({ ...c, rank: 0, score, eligibility, performance: perf, why: `${strategyLabel(c.definition)}: ${facts ? "eligible" : "active (brokerage scope)"}; priority ${c.definition.priority}${learned ? ` + learned ${learned.toFixed(1)} (n=${perf!.sample}, ${perf!.source})` : " (unlearned)"}` })
  }
  out.sort((a, b) => b.score - a.score || a.definition.key.localeCompare(b.definition.key))
  out.forEach((r, i) => { r.rank = i + 1 })
  return out
}

// ─── facts from rows callers already hold ─────────────────────────────────────────────────────
const TIMELINES: readonly string[] = ["immediate", "1-3_months", "3-6_months", "6-12_months", "12+_months", "researching"]
/** PURE: StrategyFacts from a contacts row (CONTACT_CONTEXT_COLUMNS shape). Absent columns stay unknown. */
export function factsFromContactRow(row: Record<string, unknown>, now: Date = new Date()): StrategyFacts {
  const type = typeof row.contact_type === "string" ? row.contact_type : undefined
  const persona = typeof row.contact_persona === "string" ? row.contact_persona : undefined
  const months = (iso: unknown) => typeof iso === "string" && Number.isFinite(Date.parse(iso)) ? Math.floor((now.getTime() - Date.parse(iso)) / (30.44 * 86_400_000)) : undefined
  const owner = typeof row.home_owner_status === "string" ? /own/i.test(row.home_owner_status) && !/rent/i.test(row.home_owner_status) : undefined
  return {
    subject_type: "contact",
    contact_type: type,
    persona,
    intent: type === "buyer" || type === "seller" || type === "both" || type === "investor" ? type : undefined,
    is_past_client: type === "lifetime_customer" || row.lifecycle_state === "lifetime_customer" ? true : type ? false : undefined,
    homeowner: owner,
    months_since_last_touch: months(row.last_contacted_at),
    timeline: typeof row.timeline === "string" && TIMELINES.includes(row.timeline) ? (row.timeline as StandardTimeline) : undefined,
    first_time_buyer: persona === "first_time" ? true : undefined,
    dnc: row.dnc_status === true ? true : row.dnc_status === false ? false : undefined,
    buyer_stage: typeof row.buyer_stage === "string" ? row.buyer_stage : undefined,
    lender_status: typeof row.lender_status === "string" ? row.lender_status : undefined,
  }
}

// ─── the mission controller's read (105B participation) ───────────────────────────────────────
export const STRATEGY_EVIDENCE_KIND = "strategy"
/** PURE: the strategy a mission runs, from its evidence (activateStrategy writes it) — owner, managers in
 *  order and capabilities as SNAPSHOTTED at activation, so the controller needs no lookup. */
export function strategyOwnershipOf(evidence: ReadonlyArray<Record<string, unknown>> | null | undefined): { ref: string; owner: ManagerKey; managers: ManagerKey[]; capabilities: AppCapability[] } | null {
  const e = (evidence ?? []).find((x) => x && x.kind === STRATEGY_EVIDENCE_KIND && typeof x.ref === "string")
  if (!e || typeof e.owner !== "string" || !Array.isArray(e.managers)) return null
  return { ref: e.ref as string, owner: e.owner as ManagerKey, managers: (e.managers as unknown[]).filter((m): m is ManagerKey => typeof m === "string"), capabilities: Array.isArray(e.capabilities) ? (e.capabilities as AppCapability[]) : [] }
}
