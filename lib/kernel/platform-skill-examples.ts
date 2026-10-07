/**
 * lib/kernel/platform-skill-examples.ts — PLATFORM SKILL EXAMPLES across the whole OS, as DATA (wave 137, lane 137E).
 *
 * Owner (wave 137 BREADTH): "skills/examples were only for listings; the possibilities are endless" — buyers,
 * sellers, investors, sphere/lifetime, recruiting, transactions, lenders/vendors, marketing/ads/video/content,
 * education, finance, compliance, portals, property intelligence, territory.
 *
 * NOTHING NEW IS DECLARED HERE BUT DATA. Each example is a SkillDeclaration (lib/kernel/skill-registry.ts — the
 * ONE declaration shape) composed ONLY of catalogue capabilities its manager owns (CAPABILITY_MANAGER), validated
 * AT LOAD by the CURRENT validateSkillDeclaration against the marketplace's own suite set (the evaluators a
 * submission is judged by — skill-marketplace.ts submitSkillListing) AND by the platform evaluator itself
 * (SKILL_EVALUATORS["skill_eval:contract_v1"]), so an example that would be rejected on submission is never
 * offered. An invalid example is EXCLUDED and named in PLATFORM_SKILL_EXAMPLE_REJECTS (fail closed — never
 * offered half-valid).
 *
 * SEED-READY, NOT AUTO-PUBLISHED: the Superadmin → Skill marketplace page offers these as templates; platform
 * staff submit one (publisher "platform") → it is evaluated at once → staff approve → publish. Nothing here
 * writes a listing row.
 *
 * Domain sources (the repo's installed skills, named per example): .claude/skills real-estate-expert,
 * realestate-*, real-estate:cma-narrative / offer-comparison / market-update / client-email, mortgage-broker-*,
 * property-manager-*, sales-qualify, ads-*, market-*, geo-*, social-media-manager-*, recruiter-*, copywriter-*,
 * bookkeeper-financial-reporting, remotion-best-practices; plugins/ecc/skills agentic-os / agentic-engineering /
 * autonomous-loops (the declaration-not-code, kernel-gated loop shape).
 */
import {
  SKILL_EVALUATORS, SKILL_RUN_RECEIPT_SCHEMA, builtinSkill, validateSkillDeclaration,
  type SkillDeclaration, type SkillField,
} from "@/lib/kernel/skill-registry"
import type { OsDomain } from "@/lib/kernel/strategy-library"

const SUITE = "skill_eval:contract_v1"
const UUID = "00000000-0000-4000-8000-000000000000"

interface PlatformSkillExample {
  declaration: SkillDeclaration
  domains: readonly OsDomain[]
  /** The installed skill(s) the example's domain knowledge comes from (named, never imported as code). */
  domainSources: readonly string[]
}

const f = (name: string, type: SkillField["type"], required = true, description?: string): SkillField => ({ name, type, required, ...(description ? { description } : {}) })

function ex(d: Omit<SkillDeclaration, "version" | "outputs" | "evaluation_suite">, domains: readonly OsDomain[], domainSources: readonly string[]): PlatformSkillExample {
  return { declaration: { ...d, version: 1, outputs: SKILL_RUN_RECEIPT_SCHEMA, evaluation_suite: SUITE }, domains, domainSources }
}
const unmeasured = (budget: "none" | "vendor_spend") => ({ usd: 0, tokens: 0, budget, basis: "unmeasured" as const })

const CANDIDATES: readonly PlatformSkillExample[] = [
  ex({ name: "buyer_tour_booking", manager_owner: "shopping_agent", purpose: "Book a buyer contact's tour on the agent's calendar and read the portal timeline the tour belongs to.",
    inputs: { fields: [f("agentId", "uuid"), f("contactId", "uuid"), f("startsAt", "iso_datetime"), f("durationMin", "number", false)] },
    required_capabilities: ["appointment_schedule", "portal_milestones_get"], risk_class: "LOW_RISK_WRITE", authority_requirement: 1, cost_estimate: unmeasured("none"), tenant_entitlement: "app.access",
    evaluation_fixtures: [{ agentId: UUID, contactId: UUID, startsAt: "2026-10-10T15:00:00.000Z", durationMin: 60 }] },
    ["buyers", "portals"], ["real-estate-expert", "real-estate:offer-comparison"]),
  ex({ name: "buyer_preapproval_referral", manager_owner: "shopping_agent", purpose: "Hand a buyer contact to a bench lender (a vendor) for pre-approval and record the referral.",
    inputs: { fields: [f("contactId", "uuid"), f("lenderVendorId", "uuid", false)] },
    required_capabilities: ["lender_preapproval_handoff"], risk_class: "LOW_RISK_WRITE", authority_requirement: 1, cost_estimate: unmeasured("none"), tenant_entitlement: "app.access",
    evaluation_fixtures: [{ contactId: UUID }] },
    ["buyers", "lenders_vendors"], ["mortgage-broker-mortgage-lending", "mortgage-broker:pre-approval-letter"]),
  ex({ name: "seller_pricing_appointment", manager_owner: "listing_concierge", purpose: "Price a seller's home with a CMA and prepare the listing appointment around it.",
    inputs: { fields: [f("agentId", "uuid"), f("propertyAddress", "string"), f("propertyCity", "string"), f("propertyState", "string"), f("propertyZip", "string"), f("calendarEventId", "uuid"), f("contactId", "uuid"), f("listingId", "uuid", false)] },
    required_capabilities: ["cma_generate", "listing_appointment_prep"], risk_class: "LOW_RISK_WRITE", authority_requirement: 1, cost_estimate: unmeasured("none"), tenant_entitlement: "app.access",
    evaluation_fixtures: [{ agentId: UUID, propertyAddress: "100 Main St", propertyCity: "Anytown", propertyState: "ST", propertyZip: "00000", calendarEventId: UUID, contactId: UUID }] },
    ["sellers", "property_intelligence"], ["real-estate:cma-narrative", "realestate-comps", "real-estate-expert"]),
  ex({ name: "investor_property_cma", manager_owner: "listing_concierge", purpose: "Value an investment property (property-only — no person data) for an investor contact's buy box.",
    inputs: { fields: [f("agentId", "uuid"), f("propertyAddress", "string"), f("propertyCity", "string"), f("propertyState", "string"), f("propertyZip", "string")] },
    required_capabilities: ["cma_generate"], risk_class: "LOW_RISK_WRITE", authority_requirement: 1, cost_estimate: unmeasured("none"), tenant_entitlement: "app.access",
    evaluation_fixtures: [{ agentId: UUID, propertyAddress: "200 Oak Ave", propertyCity: "Anytown", propertyState: "ST", propertyZip: "00000" }] },
    ["investors", "property_intelligence"], ["realestate-invest", "realestate-rental", "real-estate-investment"]),
  ex({ name: "territory_demand_readout", manager_owner: "listing_concierge", purpose: "Read seller demand (seller contacts, listing appointments) for a window against the window before.",
    inputs: { fields: [f("windowDays", "number")] },
    required_capabilities: ["listing_demand_report"], risk_class: "READ", authority_requirement: 0, cost_estimate: unmeasured("none"), tenant_entitlement: "app.access",
    evaluation_fixtures: [{ windowDays: 30 }] },
    ["territory_acquisition", "sellers"], ["realestate-market", "realestate-neighborhood", "real-estate:market-update"]),
  ex({ name: "anniversary_note_and_gift", manager_owner: "sphere_of_influence", purpose: "Mark a lifetime client's home anniversary with a handwritten note and a small gift.",
    inputs: { fields: [f("contactId", "uuid"), f("message", "string", false), f("giftType", "string", false)] },
    required_capabilities: ["handwritten_note_send", "gift_send"], risk_class: "COMMUNICATION", authority_requirement: 3, cost_estimate: unmeasured("vendor_spend"), tenant_entitlement: "app.access",
    evaluation_fixtures: [{ contactId: UUID, message: "Happy home anniversary!" }] },
    ["sphere_lifetime"], ["real-estate-client-communication", "real-estate:client-email", "insurance-agent-client-retention"]),
  ex({ name: "past_client_review_ask", manager_owner: "sphere_of_influence", purpose: "Ask a happy past client for a review (the reputation engine), the opening of a referral conversation.",
    inputs: { fields: [f("contactId", "uuid")] },
    required_capabilities: ["review_request_send"], risk_class: "COMMUNICATION", authority_requirement: 3, cost_estimate: unmeasured("none"), tenant_entitlement: "app.access",
    evaluation_fixtures: [{ contactId: UUID }] },
    ["sphere_lifetime"], ["real-estate-client-communication", "sales-followup"]),
  ex({ name: "recruit_pipeline_outreach", manager_owner: "recruiting_manager", purpose: "Propose stage-appropriate outreach to the brokerage's open recruits (into the approval gate, never sent blind).",
    inputs: { fields: [f("recruitIds", "array", false), f("limit", "number", false)] },
    required_capabilities: ["recruit_outreach"], risk_class: "LOW_RISK_WRITE", authority_requirement: 1, cost_estimate: unmeasured("vendor_spend"), tenant_entitlement: "app.access",
    evaluation_fixtures: [{ limit: 10 }] },
    ["recruiting_retention"], ["recruiter-talent-acquisition", "recruiter:candidate-outreach"]),
  ex({ name: "transaction_stage_advance", manager_owner: "deal_coordinator", purpose: "Advance a transaction to its next valid lifecycle stage once its deadline or document clears.",
    inputs: { fields: [f("transactionId", "uuid"), f("toStatus", "string")] },
    required_capabilities: ["transaction_advance"], risk_class: "LOW_RISK_WRITE", authority_requirement: 1, cost_estimate: unmeasured("none"), tenant_entitlement: "app.access",
    evaluation_fixtures: [{ transactionId: UUID, toStatus: "pending" }] },
    ["transactions_closing"], ["real-estate-expert", "property-manager-property-management"]),
  ex({ name: "client_portal_digest", manager_owner: "shopping_agent", purpose: "Read a client's portal milestone timeline to tell them what is next.",
    inputs: { fields: [f("contactId", "uuid")] },
    required_capabilities: ["portal_milestones_get"], risk_class: "READ", authority_requirement: 0, cost_estimate: unmeasured("none"), tenant_entitlement: "app.access",
    evaluation_fixtures: [{ contactId: UUID }] },
    ["portals", "transactions_closing"], ["real-estate-client-communication"]),
  ex({ name: "listing_video_social_cut", manager_owner: "campaign_orchestrator", purpose: "Distribute a listing or neighborhood video and its social cut to the connected channels.",
    inputs: { fields: [f("videoProjectId", "uuid"), f("assetId", "uuid"), f("channels", "array")] },
    required_capabilities: ["video_distribute", "social_post_publish"], risk_class: "COMMUNICATION", authority_requirement: 3, cost_estimate: unmeasured("vendor_spend"), tenant_entitlement: "social_automation",
    evaluation_fixtures: [{ videoProjectId: UUID, assetId: UUID, channels: ["instagram"] }] },
    ["marketing_content"], ["social-media-manager:video-script", "remotion-best-practices", "ads-video"]),
  ex({ name: "farm_direct_mail_drop", manager_owner: "campaign_orchestrator", purpose: "Submit a farm-territory direct-mail campaign for print and delivery.",
    inputs: { fields: [f("campaignId", "uuid")] },
    required_capabilities: ["direct_mail_send"], risk_class: "COMMUNICATION", authority_requirement: 3, cost_estimate: unmeasured("vendor_spend"), tenant_entitlement: "direct_mail",
    evaluation_fixtures: [{ campaignId: UUID }] },
    ["marketing_content", "territory_acquisition"], ["market-launch", "ads-creative", "copywriter-conversion-psychology"]),
  ex({ name: "seo_market_post", manager_owner: "campaign_orchestrator", purpose: "Publish a drafted market-update post to the brokerage's site / SEO engine.",
    inputs: { fields: [f("postId", "uuid")] },
    required_capabilities: ["blog_publish"], risk_class: "COMMUNICATION", authority_requirement: 3, cost_estimate: unmeasured("vendor_spend"), tenant_entitlement: "seo_blog_engine",
    evaluation_fixtures: [{ postId: UUID }] },
    ["marketing_content"], ["geo-content", "market-seo", "real-estate:market-update"]),
  ex({ name: "paid_listing_ad_draft", manager_owner: "ads_manager", purpose: "Draft a budgeted paid-ad campaign against the window's measured paid performance (live launch stays the ads workspace's approval).",
    inputs: { fields: [f("campaignName", "string"), f("platform", "string"), f("objective", "string"), f("dailyBudget", "number", false), f("lifetimeBudget", "number", false), f("windowDays", "number")] },
    required_capabilities: ["ad_campaign_launch", "ads_performance_report"], risk_class: "LOW_RISK_WRITE", authority_requirement: 1, cost_estimate: unmeasured("vendor_spend"), tenant_entitlement: "app.access",
    evaluation_fixtures: [{ campaignName: "Just listed", platform: "facebook", objective: "leads", dailyBudget: 20, windowDays: 30 }] },
    ["marketing_content", "territory_acquisition"], ["ads-strategy", "ads-budget", "ads-audience"]),
  ex({ name: "client_education_path", manager_owner: "campaign_orchestrator", purpose: "Read a client's learning path and assign the next education resource (buyer / seller education).",
    inputs: { fields: [f("contactId", "uuid"), f("resourceId", "uuid")] },
    required_capabilities: ["education_path_get", "education_assign"], risk_class: "LOW_RISK_WRITE", authority_requirement: 1, cost_estimate: unmeasured("none"), tenant_entitlement: "app.access",
    evaluation_fixtures: [{ contactId: UUID, resourceId: UUID }] },
    ["education_coaching", "buyers"], ["real-estate-client-communication", "copywriter-client-voice-mapping"]),
  ex({ name: "commission_ledger_report", manager_owner: "finance_manager", purpose: "Generate and export the commission / residual report from the ledger (no model calculates money).",
    inputs: { fields: [f("reportType", "string"), f("range", "string", false), f("reportId", "uuid"), f("format", "string")] },
    required_capabilities: ["report_generate", "report_export"], risk_class: "READ", authority_requirement: 0, cost_estimate: unmeasured("none"), tenant_entitlement: "app.access",
    evaluation_fixtures: [{ reportType: "financial", reportId: UUID, format: "csv" }] },
    ["finance_commission"], ["bookkeeper-financial-reporting", "bookkeeper:financial-summary"]),
  ex({ name: "compliant_inbox_reply", manager_owner: "ai_isa", purpose: "Reply in the universal inbox through the compliance gate (fair housing + consent checked before send).",
    inputs: { fields: [f("threadId", "uuid"), f("body", "string")] },
    required_capabilities: ["inbox_reply_send"], risk_class: "COMMUNICATION", authority_requirement: 3, cost_estimate: unmeasured("vendor_spend"), tenant_entitlement: "app.access",
    evaluation_fixtures: [{ threadId: UUID, body: "Thanks — happy to help. When suits you for a call?" }] },
    ["compliance", "buyers", "sellers"], ["real-estate-real-estate-marketing", "legal-compliance", "attorney-ai-regulatory-mapper"]),
  ex({ name: "connector_health_check", manager_owner: "data_steward", purpose: "Report live health of every connector (accounting, e-sign, MLS) before a dependent run — expiry-aware.",
    inputs: { fields: [] },
    required_capabilities: ["connectivity_scan"], risk_class: "READ", authority_requirement: 0, cost_estimate: unmeasured("none"), tenant_entitlement: "app.access",
    evaluation_fixtures: [{}] },
    ["compliance", "lenders_vendors", "finance_commission"], ["ai-compliance-officer-post-market-monitoring"]),
  ex({ name: "lead_qualification_pass", manager_owner: "ai_isa", purpose: "Run AI-ISA qualification (BANT-style criteria, timeline buckets) on a lead and record the outcome.",
    inputs: { fields: [f("leadId", "uuid")] },
    required_capabilities: ["isa_qualify"], risk_class: "LOW_RISK_WRITE", authority_requirement: 1, cost_estimate: unmeasured("none"), tenant_entitlement: "app.access",
    evaluation_fixtures: [{ leadId: UUID }] },
    ["buyers", "sellers"], ["sales-qualify", "sales-rep-sales-strategy"]),
]

/** PURE: the load-time gate — the marketplace's own validator + the platform evaluator. Not a builtin name. */
function examineExample(e: PlatformSkillExample): string[] {
  const errors: string[] = []
  if (builtinSkill(e.declaration.name)) errors.push(`name_reserved_by_builtin:${e.declaration.name}`)
  const v = validateSkillDeclaration(e.declaration, { knownEvaluationSuites: new Set(Object.keys(SKILL_EVALUATORS)) })
  errors.push(...v.errors)
  const evaluator = SKILL_EVALUATORS[e.declaration.evaluation_suite]
  if (!evaluator) errors.push(`no_evaluator:${e.declaration.evaluation_suite}`)
  else for (const c of evaluator(e.declaration).checks) if (!c.ok) errors.push(`eval:${c.name}${c.detail ? `(${c.detail})` : ""}`)
  if (e.domains.length === 0) errors.push("no_domain")
  if (e.domainSources.length === 0) errors.push("no_domain_source")
  return errors
}

const examined = CANDIDATES.map((e) => ({ e, errors: examineExample(e) }))

/** The examples that passed — offered to platform staff as marketplace templates (never auto-published). */
export const PLATFORM_SKILL_EXAMPLES: readonly PlatformSkillExample[] = Object.freeze(examined.filter((x) => x.errors.length === 0).map((x) => x.e))

/** Every candidate that FAILED the load-time gate, with why (the proof asserts this is empty). */
export const PLATFORM_SKILL_EXAMPLE_REJECTS: ReadonlyArray<{ name: string; errors: string[] }> = Object.freeze(
  examined.filter((x) => x.errors.length > 0).map((x) => ({ name: x.e.declaration.name, errors: x.errors })),
)
