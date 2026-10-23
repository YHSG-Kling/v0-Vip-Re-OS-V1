#!/usr/bin/env tsx
/**
 * scripts/feature-certification-guard.ts   (npm run test:feature-certification — pure, no DB, no network)
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────
 * EVERY PLAN-ADVERTISED FEATURE HAS ONE VERDICT, AND THE VERDICT CANNOT OUTRUN THE CODE.
 *
 * Wave 143, lane 143J (owner: "Report every plan-advertised feature as CERTIFIED / PARTIAL / NOT CONFIGURED /
 * UNSUPPORTED / HIDDEN UNTIL AVAILABLE … no misleading paid-plan promises (hide what is not available)").
 * The human-readable result is docs/architecture/FEATURE-CERTIFICATION.md; this script is its proof, and the
 * document is GENERATED from the registry below (`--write-doc`), so the two cannot drift: the guard fails when
 * the committed document differs from what the registry renders.
 *
 * WHAT "ADVERTISED" MEANS HERE (measured on the live database 2026-10-23, project hrvaqgvukzxfskkcrwbt, read-only):
 *   · subscription_tiers.features        8 boolean flags (portal, basic_ai, core_crm, compliance, team_features,
 *                                         accounting_sync; usage_metering + multi_brokerage on multi_location only)
 *   · subscription_tiers.marketing_bullets  EMPTY on all four tiers — the public /pricing page renders no feature
 *                                         list from the database; nothing is promised there but price, trial, seats
 *   · feature_flags                       70 rows, all enabled, rollout 100; 68 open to every tier, 2 multi_location only
 *   · plan_limits                         17 metrics × 4 tiers (the allowances a tenant is shown on the usage page)
 *   · lib/platform/product-demo.ts        7 demo topics the platform's own AI agent walks a prospect through
 *   · app/pricing/page.tsx                the trial, custom-pricing, seat, setup-fee and overage promises
 * Refresh the pinned lists with (read-only):
 *   select tier_name, features from subscription_tiers;
 *   select feature_key from feature_flags order by 1;
 *   -- plan_limits.metric is read from scripts/check-vocabularies.ts (generated), not pinned here.
 *
 * WHAT A VERDICT MEANS (the definitions the guard enforces — CLAUDE.md §7: run it, quote it):
 *   CERTIFIED               every link of UI → ACTION → DOMAIN → DB is a real file / table, ≥ 1 existing proof script
 *                           NAMES the row's files, the row needs NO provider credential or owner decision, and no open
 *                           gap is recorded. It does NOT mean "exercised live": the live database holds 2 brokerages,
 *                           0 offers, 0 leads, 0 video projects and 0 agent_action_ledger rows — nothing here has run for
 *                           a customer yet, and a canary is in-memory by design.
 *   NOT CONFIGURED          code complete and proven in-memory, but the advertised OUTCOME needs a provider credential or
 *                           an owner decision this repository cannot supply (env var names verified to be read by the
 *                           code; tenant connections verified against the platform_credentials.platform CHECK).
 *                           Presence in production is lane 143H's inventory, never assumed here.
 *   PARTIAL                 a link of the chain is missing or an advertised sub-capability is not delivered; the gap says which.
 *   UNSUPPORTED             no implementation exists; the gap says so.
 *   HIDDEN UNTIL AVAILABLE  advertised in the plan catalogue but not deliverable — must not appear on any public surface.
 *
 * WHAT IS DERIVED, NOT PINNED (§2 — assert the RULE, derive the number):
 *   · the plan_limits metric vocabulary (CHECK cache) vs the labels, the writers and the live-stock set;
 *   · which metrics anything COUNTS — derived from the usage_counters writers in app/ + lib/ and held equal to
 *     lib/usage/metric-labels.ts COUNTER_BACKED_METRICS in both directions;
 *   · R28's verdict (PARTIAL iff any plan limit is unmeasured) and the list of unmeasured metrics;
 *   · how many files read each feature_flags key (a key nothing reads is a catalogue entry, said so).
 *
 * BLIND SPOTS (published beside the numbers): "CERTIFIED" is a static-chain + in-memory-proof statement — no live
 * provider call, no rendered page, no human click (Playwright: authored in e2e/feature-certification.spec.ts, WAITING_EXTERNAL
 * on UI_SMOKE_BASE_URL); a proof script that names a file proves nothing about the file's behaviour beyond what that script
 * asserts (the guard checks the NAME link, the human chose the proof); the pinned flag/tier lists are a live census, not a
 * live read; the env check proves the code READS a name, not that it is set anywhere; enforcement (hard cap vs advisory) is
 * not derived — only measurement is.
 */
import { readFileSync, existsSync, writeFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { walkTs } from "./runtime-roots"
import { LIVE_TABLES } from "./live-tables"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { CANARY_KEYS } from "./canaries/_registry"
import { PRODUCT_DEMO_TOPICS } from "../lib/platform/product-demo"
import { METRIC_LABELS, COUNTER_BACKED_METRICS, LIVE_STOCK_METRICS, PLAN_CARD_METRICS, planCardAllowances, allowanceLine } from "../lib/usage/metric-labels"

const ROOT = process.cwd()
const DOC_PATH = "docs/architecture/FEATURE-CERTIFICATION.md"
const ROUTES_PATH = "e2e/feature-certification.routes.json"

let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ── the live census this registry was written against (2026-10-23, read-only SELECTs) ────────────
export const LIVE_CENSUS_DATE = "2026-10-23"
export const LIVE_TIER_FLAG_KEYS = ["portal", "basic_ai", "core_crm", "compliance", "team_features", "accounting_sync", "usage_metering", "multi_brokerage"] as const
export const LIVE_FEATURE_FLAG_KEYS = [
  "knowledge_management", "ai_content_generation", "ai_listing_generation", "ai_social_content", "ai_campaign_automation",
  "ai_compliance_checking", "ai_conversation_analysis", "ai_isa", "ai_lead_prediction", "ai_video_generation",
  "agent_dashboard", "brokerage_dashboard", "campaign_roi_dashboard", "commission_reports", "compliance_reports",
  "custom_reports", "multi_location_dashboard", "team_dashboard", "direct_mail_integration", "email_outbound",
  "phone_voicemail", "sms_outbound", "social_media_posting", "whatsapp_messaging", "contact_enrichment",
  "contact_lifecycle_tracking", "ghosted_reengagement", "lead_assignment_auto", "lead_scoring", "buyer_education",
  "isa_reengagement_approval", "lifetime_learning_portal", "seller_education", "cma_presentation", "listing_lifecycle",
  "listing_media", "prelisting_repairs", "ad_creator", "ads_audiences", "ads_campaigns", "competitor_monitor",
  "content_performance_predictor", "direct_mail", "email_campaigns", "listing_marketing_tiers", "marketing_studio",
  "newsletter_engine", "omnipresence_repurposer", "podcast_generation", "repurposing", "seo_blog_engine",
  "social_automation", "agent_onboarding", "ai_setup_assistant", "brand_setup", "integration_setup", "training_library",
  "training_progress", "brokerage_settings", "multi_location_settings", "provider_override", "team_management",
  "commission_waterfall", "document_esign", "milestone_tracking", "multi_offer_handling", "transaction_orchestration",
  "snippet_generation", "video_generation", "voice_clone",
] as const
/** The commercial promises /pricing makes (app/pricing/page.tsx, lib/platform/public-tiers.ts). */
export const PRICE_CLAIMS = ["trial", "tiers", "custom_pricing", "seat_bands", "seat_packages", "overage"] as const

export type Verdict = "CERTIFIED" | "PARTIAL" | "NOT CONFIGURED" | "UNSUPPORTED" | "HIDDEN UNTIL AVAILABLE"
export const VERDICTS: readonly Verdict[] = ["CERTIFIED", "PARTIAL", "NOT CONFIGURED", "UNSUPPORTED", "HIDDEN UNTIL AVAILABLE"]

export interface Row {
  id: string
  name: string
  /** Where it is advertised: flag:<feature_flags key> · tier:<features key> · limit:<plan_limits metric> · demo:<topic> · price:<claim> · core:<capability not in the plan catalogue>. */
  advertised: string[]
  route: string | null
  ui: string[]
  actions: string[]
  domain: string[]
  tables: string[]
  /** package.json test:* keys. */
  proofs: string[]
  /** scripts/canaries keys (in-memory end-to-end chains). */
  canaries: string[]
  /** env:NAME (read by the code) · conn:<platform_credentials.platform> · table:<live table> · owner:<free text decision>. */
  needs: string[]
  verdict: Verdict
  /** Required for every verdict but CERTIFIED: what is missing, said plainly. May be derived. */
  gap: string | ((d: Derived) => string)
  /** Free-text context that does not change the verdict. */
  note?: string
  /** HIDDEN / UNSUPPORTED rows: phrases that must appear on no public surface. */
  publicTerms?: string[]
  /** The lane that owns the next change to this row this wave. */
  lane?: string
}

export interface Derived {
  unmeasured: string[]
  measured: string[]
  vocab: string[]
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE REGISTRY
// ═════════════════════════════════════════════════════════════════════════════════════════════════
const SENDGRID = ["env:SENDGRID_API_KEY", "env:SENDGRID_FROM_EMAIL"]
export const ROWS: Row[] = [
  { id: "R01", name: "Listings — intake, lifecycle, media, CMA, marketing tier", advertised: ["flag:listing_lifecycle", "flag:listing_media", "flag:prelisting_repairs", "flag:cma_presentation", "flag:listing_marketing_tiers"],
    route: "/dashboard/listings", ui: ["app/dashboard/listings"], actions: ["app/actions/listing-lifecycle-core.ts", "app/actions/listings-kernel.ts"], domain: ["lib/listing-lifecycle", "lib/listings", "lib/cma"],
    tables: ["listings", "lifecycle_events", "listing_agreements"], proofs: ["test:listing-offer-lifecycle", "test:listing-activation-gate", "test:listing-stage-gate"], canaries: ["listing-lifecycle"], needs: [], verdict: "CERTIFIED", gap: "",
    note: "An MLS/IDX-VERIFIED go-live date needs a tenant IDX connection (conn:idxbroker); until one exists the date stays 'unverified'. The MLS live-date column is lane 143A's.", lane: "143A" },
  { id: "R02", name: "Offers, counters and multi-offer comparison", advertised: ["flag:multi_offer_handling"],
    route: "/dashboard/offers", ui: ["app/dashboard/offers"], actions: ["app/actions/seller-offers.ts", "app/actions/offer-intents.ts"], domain: ["lib/offers", "lib/transactions/auto-execute-offer.ts"],
    tables: ["offers"], proofs: ["test:multi-offer-rules", "test:offer-auto-execute", "test:offer-gate-enforcement"], canaries: ["offer-lifecycle"], needs: [], verdict: "CERTIFIED", gap: "",
    note: "The outside-listing email loop (offer to an outside agent, reply matched back, versioned counters) is lane 143A's.", lane: "143A" },
  { id: "R03", name: "Transactions — orchestration, milestones, closing coordination", advertised: ["flag:transaction_orchestration", "flag:milestone_tracking"],
    route: "/dashboard/transactions", ui: ["app/dashboard/transactions"], actions: ["app/actions/transactions.ts", "app/actions/ai-transaction-coordinator.ts"], domain: ["lib/kernel/transactions.ts", "lib/transactions"],
    tables: ["transactions"], proofs: ["test:transaction-creation-gate", "test:closing-orchestration-integrity", "test:transaction-stage-status"], canaries: ["transaction-provider"], needs: [], verdict: "CERTIFIED", gap: "" },
  { id: "R04", name: "Legal forms, FormWizard and e-signature", advertised: ["flag:document_esign"],
    route: "/dashboard/forms", ui: ["app/dashboard/forms"], actions: ["app/actions/forms-kernel.ts"], domain: ["lib/esign", "lib/forms"],
    tables: ["brokerage_form_library"], proofs: ["test:form-wizard-esign", "test:esign-execution-loop", "test:esign-default-rule"], canaries: ["form-wizard"], needs: ["conn:docusign"], verdict: "NOT CONFIGURED",
    gap: "Code complete and proven in-memory; signature completion events need a tenant e-sign connection (DocuSign by default) — the live platform_credentials table holds 0 rows. The platform-Media packet source (hook 142B SOURCE (a)) is lane 143B's.", lane: "143B" },
  { id: "R05", name: "Commission waterfall and CDA ledger", advertised: ["flag:commission_waterfall", "flag:commission_reports"],
    route: "/dashboard/financials", ui: ["app/dashboard/transactions/[id]/cda", "app/dashboard/financials"], actions: ["app/actions/cda-portal.ts", "app/actions/financial-kernel.ts"], domain: ["lib/commission", "lib/kernel/financial.ts"],
    tables: ["agent_commissions"], proofs: ["test:cda-closing-flow", "test:commission-finalization", "test:commission-ledger-sync"], canaries: ["cda-closing", "commission-payment"], needs: [], verdict: "CERTIFIED", gap: "",
    note: "CDA e-signature completion rides R04's connection. Effective-dated agent/team agreements and the referral waterfall are lane 143C's.", lane: "143C" },
  { id: "R06", name: "CRM — contacts, lifecycle, lead scoring, automatic lead assignment", advertised: ["tier:core_crm", "flag:contact_lifecycle_tracking", "flag:lead_assignment_auto", "flag:lead_scoring"],
    route: "/crm", ui: ["app/crm"], actions: ["app/actions/contacts.ts", "app/actions/contact-intelligence.ts"], domain: ["lib/crm", "lib/lead-scoring", "lib/lead-assignment"],
    tables: ["contacts", "leads", "activities"], proofs: ["test:crm-boundaries", "test:lead-score-consolidation", "test:assignment-rules-authz"], canaries: ["lead", "buyer", "seller"], needs: [], verdict: "CERTIFIED", gap: "" },
  { id: "R07", name: "AI ISA, follow-up decisioning, re-engagement and handoff", advertised: ["tier:basic_ai", "demo:overview", "flag:ai_isa", "flag:ai_conversation_analysis", "flag:ai_lead_prediction", "flag:ghosted_reengagement", "flag:isa_reengagement_approval"],
    route: "/dashboard/ai-isa/settings", ui: ["app/dashboard/ai-isa"], actions: ["app/actions/ai-isa-settings.ts", "app/actions/ai-isa/engage-contact.ts"], domain: ["lib/ai-isa"],
    tables: ["activities", "contacts"], proofs: ["test:isa-reengagement", "test:isa-qualification", "test:ai-agent-surfaces"], canaries: ["ai-by-your-side", "communication"], needs: [], verdict: "CERTIFIED", gap: "",
    note: "Delivery of a chosen action rides R08–R10. Replacing fixed cadences with manager reasoning is lane 143E's.", lane: "143E" },
  { id: "R08", name: "Outbound email delivery", advertised: ["flag:email_outbound"],
    route: "/dashboard/communications", ui: ["app/dashboard/communications"], actions: ["app/actions/communications.ts"], domain: ["lib/email", "lib/providers"],
    tables: ["email_queue"], proofs: ["test:outbound-sender", "test:egress-send-guard", "test:mail-unsubscribe"], canaries: ["communication"], needs: SENDGRID, verdict: "NOT CONFIGURED",
    gap: "Code complete and proven in-memory; sending needs the platform email provider credential and sender address." },
  { id: "R09", name: "SMS, AI voice calls and voicemail", advertised: ["flag:sms_outbound", "flag:phone_voicemail"],
    route: "/dashboard/admin/phone-settings", ui: ["app/dashboard/admin/phone-settings"], actions: ["app/actions/voice-tenancy.ts"], domain: ["lib/voice", "lib/sms"],
    tables: ["tenant_phone_numbers", "voice_calls"], proofs: ["test:outbound-call-gates", "test:phone-plan", "test:voice-billing-rail"], canaries: ["communication"], needs: ["env:TWILIO_ACCOUNT_SID", "env:TWILIO_AUTH_TOKEN", "env:ELEVENLABS_API_KEY"], verdict: "NOT CONFIGURED",
    gap: "Code complete and proven in-memory; numbers, SMS and AI voice need the telephony and voice-synthesis credentials (the VAPI path is retired — placeOutboundAiCall runs on Twilio + ElevenLabs). Phone overage rates are 'price_not_configured' until the owner administers them." },
  { id: "R10", name: "WhatsApp and social direct messages", advertised: ["flag:whatsapp_messaging"],
    route: "/dashboard/communications/inbox", ui: ["app/dashboard/communications/inbox"], actions: ["app/actions/social-dm.ts"], domain: ["lib/providers", "lib/communication-spine"],
    tables: ["conversations"], proofs: [], canaries: ["communication"], needs: [], verdict: "PARTIAL",
    gap: "Built — the inbound webhook verifies Meta's signature and fails closed (503 without the app secret, 401 on a bad one) and replies go out through the tenant's own connected Business number inside the customer window — but NO proof script names the signature verifier (lib/meta/verify-signature.ts is referenced by 0 scripts), the webhook route or the social-dm send path, so its fail-closed behaviour is asserted by nothing. It also needs env:META_APP_SECRET and a tenant conn:facebook connection (0 exist). Closing the proof gap is a fixture-only test (lane 143K)." },
  { id: "R11", name: "Email campaigns and newsletters", advertised: ["flag:email_campaigns", "flag:newsletter_engine"],
    route: "/dashboard/campaigns", ui: ["app/dashboard/campaigns"], actions: ["app/actions/email-campaigns.ts", "app/actions/ai-newsletter.ts"], domain: ["lib/marketing/email-campaign-sender.ts", "lib/marketing/cadence-policy.ts", "lib/newsletter"],
    tables: ["email_campaigns", "email_sends"], proofs: ["test:outbound-sender", "test:newsletter-cadence", "test:marketing-campaign-wiring"], canaries: ["autonomous-marketing"], needs: SENDGRID, verdict: "NOT CONFIGURED",
    gap: "Authoring, approval and the sender are complete and proven in-memory; delivery rides R08's provider credential. email_sends holds 0 rows." },
  { id: "R12", name: "Direct mail", advertised: ["flag:direct_mail", "flag:direct_mail_integration"],
    route: null, ui: ["app/dashboard/campaigns"], actions: ["app/actions/ai-direct-mail.ts", "app/actions/direct-mail.ts"], domain: ["lib/direct-mail"],
    tables: ["direct_mail_recipients"], proofs: ["test:direct-mail-copy", "test:direct-mail-identity-class", "test:mail-address-suppression"], canaries: ["autonomous-marketing"], needs: ["env:LOB_API_KEY", "env:LOB_RETURN_ADDRESS_ID", "env:LOB_POSTCARD_BACK_ID"], verdict: "NOT CONFIGURED",
    gap: "Code complete and proven in-memory; printing and mailing need the print-provider credential and its return-address / postcard-back ids." },
  { id: "R13", name: "Social posting, automation and repurposing", advertised: ["flag:social_media_posting", "flag:social_automation", "flag:ai_social_content", "flag:omnipresence_repurposer", "flag:repurposing"],
    route: "/dashboard/social", ui: ["app/dashboard/social"], actions: ["app/actions/social-media-automation.ts", "app/actions/social-share.ts"], domain: ["lib/social", "lib/repurpose", "lib/marketing/social-cadence.ts", "lib/marketing/stuck-social-post-policy.ts", "lib/kernel/command-center.ts"],
    tables: ["social_posts", "social_media_accounts"], proofs: ["test:social-approval", "test:social-cadence", "test:stuck-social-post-reaper"], canaries: ["autonomous-marketing"], needs: ["env:META_APP_ID", "env:LINKEDIN_CLIENT_ID", "conn:facebook", "conn:linkedin"], verdict: "NOT CONFIGURED",
    gap: "Drafting, approval and the publisher are complete and proven in-memory; publishing needs the platform OAuth apps and a tenant connection per network (0 connections exist). social_posts holds 3 rows." },
  { id: "R14", name: "Ads — creator, audiences, campaigns, competitor monitor, performance prediction", advertised: ["flag:ad_creator", "flag:ads_audiences", "flag:ads_campaigns", "flag:competitor_monitor", "flag:content_performance_predictor"],
    route: "/dashboard/marketing/competitors", ui: ["app/dashboard/marketing/competitors"], actions: ["app/actions/fb-audience-templates.ts", "app/actions/chatgpt-ads.ts", "app/actions/content-prediction.ts"], domain: ["lib/ads", "lib/kernel/ads.ts"],
    tables: ["ad_campaigns", "facebook_custom_audiences"], proofs: ["test:ads-manager", "test:ad-creative-consent", "test:audience-exclusion"], canaries: ["autonomous-marketing"], needs: ["conn:facebook"], verdict: "NOT CONFIGURED",
    gap: "Code complete and proven in-memory (housing special-ad-category and consent gates included); syncing audiences and running campaigns needs a tenant ad-account connection (0 exist)." },
  { id: "R15", name: "Video generation, avatar explainers and snippets", advertised: ["demo:video_marketing", "flag:video_generation", "flag:ai_video_generation", "flag:snippet_generation"],
    route: "/dashboard/videos", ui: ["app/dashboard/videos"], actions: ["app/actions/video-generation.ts", "app/actions/video/create-video-project.ts"], domain: ["lib/video", "lib/remotion"],
    tables: ["ai_video_projects", "video_generation_queue"], proofs: ["test:video-pipeline-truth", "test:video-pipeline-reaper", "test:video-script-compliance"], canaries: ["video-pipeline"], needs: ["env:DID_API_KEY", "env:ELEVENLABS_API_KEY"], verdict: "NOT CONFIGURED",
    gap: "Code complete; every video table holds 0 rows so no render has ever run for a tenant — the video canary is in-memory by design. Rendering needs the avatar / voice credentials and the Remotion render host (lane 143F).", lane: "143F" },
  { id: "R16", name: "Twin studio — avatar and voice clone", advertised: ["flag:voice_clone"],
    route: "/dashboard/settings/twin-studio", ui: ["app/dashboard/settings/twin-studio"], actions: ["app/actions/twin-studio.ts"], domain: ["lib/did", "lib/elevenlabs"],
    tables: ["agent_voice_profiles", "agent_avatar_assets"], proofs: ["test:twin-lifecycle", "test:did-integration", "test:did-consent"], canaries: ["ai-by-your-side"], needs: ["env:DID_API_KEY", "env:ELEVENLABS_API_KEY"], verdict: "NOT CONFIGURED",
    gap: "Code complete and proven in-memory; cloning needs the avatar and voice provider credentials." },
  { id: "R17", name: "Podcasts — script, voice, episodes, distribution", advertised: ["flag:podcast_generation"],
    route: "/dashboard/marketing/podcast", ui: ["app/dashboard/marketing/podcast"], actions: ["app/actions/podcast-generation.ts"], domain: ["lib/podcast"],
    tables: ["podcast_episodes", "podcast_distribution_channels"], proofs: ["test:podcast-channel-consolidation", "test:credential-cascade-refusal"], canaries: [], needs: ["env:ELEVENLABS_API_KEY", "owner:a podcast-hosting account per show (distribution channel credentials)"], verdict: "NOT CONFIGURED",
    gap: "Scripting, voice and the distribution record are built; audio needs the voice provider and distribution needs a per-show hosting credential. podcast_episodes holds 0 rows; podcast completeness is lane 143F's.", lane: "143F" },
  { id: "R18", name: "SEO and blog engine", advertised: ["flag:seo_blog_engine"],
    route: "/dashboard/marketing/seo", ui: ["app/dashboard/marketing/seo"], actions: ["app/actions/blog.ts", "app/actions/marketing-intelligence.ts"], domain: ["lib/blog", "lib/geo"],
    tables: ["blog_posts", "seo_keywords"], proofs: ["test:blog-writer-merge", "test:seo-geo-consolidation"], canaries: [], needs: [], verdict: "CERTIFIED", gap: "" },
  { id: "R19", name: "Marketing studio, AI content and campaign ROI", advertised: ["flag:marketing_studio", "flag:ai_content_generation", "flag:ai_listing_generation", "flag:ai_campaign_automation", "flag:campaign_roi_dashboard"],
    route: "/dashboard/marketing/studio", ui: ["app/dashboard/marketing/studio"], actions: ["app/actions/marketing-studio.ts", "app/actions/ai-content-generation.tsx"], domain: ["lib/content-generation", "lib/campaigns"],
    tables: ["ai_generated_content", "marketing_campaigns"], proofs: ["test:marketing-campaign-wiring", "test:compliance-scope", "test:ai-content-wiring"], canaries: ["autonomous-marketing"], needs: [], verdict: "CERTIFIED", gap: "" },
  { id: "R20", name: "Dashboards and reports", advertised: ["flag:agent_dashboard", "flag:brokerage_dashboard", "flag:team_dashboard", "flag:multi_location_dashboard", "flag:compliance_reports"],
    route: "/dashboard/reports", ui: ["app/dashboard/reports", "app/dashboard/reporting"], actions: ["app/actions/reporting-kernel.ts"], domain: ["lib/kernel/reporting.ts", "lib/kernel/intelligence-report.ts", "lib/dashboard"],
    tables: ["activities"], proofs: ["test:reporting-scope", "test:dashboard-data-layer", "test:intelligence-report"], canaries: [], needs: [], verdict: "CERTIFIED", gap: "",
    note: "Reports are a fixed set (summary, source performance, campaign ROI, reputation, autonomy impact, coaching signals) with CSV / PDF export and email — see R21 for the user-defined builder." },
  { id: "R21", name: "Custom (user-defined) reports", advertised: ["flag:custom_reports"],
    route: null, ui: [], actions: [], domain: [], tables: [], proofs: [], canaries: [], needs: [], verdict: "HIDDEN UNTIL AVAILABLE",
    gap: "No report builder exists: app/dashboard/reports renders a fixed report set. feature_flags.custom_reports is enabled for every tier, so the catalogue promises it. Nothing in app/ or lib/ reads the key, so no screen shows it; the owner should disable the flag (statement under 'Open owner decisions' below) until a builder exists.",
    publicTerms: ["custom report", "report builder"] },
  { id: "R22", name: "Compliance — monitoring, AI compliance checking, closing documents", advertised: ["tier:compliance", "flag:ai_compliance_checking"],
    route: "/dashboard/compliance", ui: ["app/dashboard/compliance"], actions: ["app/actions/compliance-monitoring.ts"], domain: ["lib/compliance", "lib/listings/listing-compliance-loop.ts", "lib/transactions/offer-compliance-loop.ts"],
    tables: ["compliance_flags"], proofs: ["test:compliance-gate", "test:listing-compliance-loop", "test:offer-compliance-loop"], canaries: ["listing-lifecycle", "offer-lifecycle"], needs: [], verdict: "CERTIFIED", gap: "",
    note: "Brokerage required-document checklists and closing-statement comparison are lane 143B's.", lane: "143B" },
  { id: "R23", name: "Settings, teams, locations and provider choice", advertised: ["tier:team_features", "tier:multi_brokerage", "flag:brokerage_settings", "flag:team_management", "flag:multi_location_settings", "flag:provider_override"],
    route: "/dashboard/settings", ui: ["app/dashboard/settings"], actions: ["app/actions/settings/provider-settings-actions.ts", "app/actions/admin/locations.ts"], domain: ["lib/settings", "lib/teams"],
    tables: ["brokerage_settings", "teams", "locations"], proofs: ["test:settings-authz", "test:team-membership", "test:brokerage-settings-columns"], canaries: ["seat"], needs: [], verdict: "CERTIFIED", gap: "",
    note: "The two multi_location-only flags (multi_location_dashboard, multi_location_settings) are read by NO code: the restriction exists in the catalogue row, not in a gate. app/actions/admin/locations.ts is role-gated (isAdminOrBroker) and never asks the tier, so any tenant admin or broker can open /dashboard/admin/locations on any plan — whether that is intended (brokerage-tier offices use locations: seat-usage reads locations.managing_broker_user_id) or a revenue leak is the owner's decision, not a defect to enforce unasked." },
  { id: "R24", name: "Onboarding, setup assistant and training", advertised: ["flag:agent_onboarding", "flag:ai_setup_assistant", "flag:brand_setup", "flag:integration_setup", "flag:training_library", "flag:training_progress"],
    route: "/dashboard/onboarding", ui: ["app/dashboard/onboarding"], actions: ["app/actions/onboarding-decisions.ts", "app/actions/onboarding/training.ts", "app/actions/admin/onboarding-steps.ts"], domain: ["lib/onboarding", "lib/kernel/onboarding-fallbehind.ts", "lib/education/onboarding-curriculum.ts"],
    tables: ["brokerage_settings"], proofs: ["test:onboarding-journey", "test:onboarding-steps", "test:onboarding-curriculum"], canaries: ["subscriber"], needs: [], verdict: "CERTIFIED", gap: "" },
  { id: "R25", name: "Education and knowledge", advertised: ["flag:buyer_education", "flag:seller_education", "flag:lifetime_learning_portal", "flag:knowledge_management"],
    route: "/dashboard/education", ui: ["app/dashboard/education"], actions: ["app/actions/education-kernel.ts", "app/actions/portal-education.ts"], domain: ["lib/education"],
    tables: ["learning_modules", "learning_assignments"], proofs: ["test:client-education", "test:education-delivery", "test:adaptive-development"], canaries: ["ai-by-your-side"], needs: [], verdict: "CERTIFIED", gap: "" },
  { id: "R26", name: "Client portals", advertised: ["tier:portal", "demo:deals_portal"],
    route: "/portal/login", ui: ["app/portal"], actions: ["app/actions/portal-settings.ts", "app/actions/portal-offer-decision.ts"], domain: ["lib/portal", "lib/kernel/portal-auth.ts"],
    tables: ["client_portal_messages", "portal_contact_invites"], proofs: ["test:buyer-portal-offer-intent", "test:portal-showing-feed", "test:external-portal-identity"], canaries: ["buyer", "seller"], needs: [], verdict: "CERTIFIED", gap: "" },
  { id: "R27", name: "Accounting sync (QuickBooks)", advertised: ["tier:accounting_sync"],
    route: "/settings/accounting", ui: ["app/settings/accounting"], actions: ["app/actions/accounting-sync.ts"], domain: ["lib/finance", "lib/providers/accounting"],
    tables: ["accounting_sync_log"], proofs: ["test:accounting-scopes", "test:credential-cascade-refusal"], canaries: [], needs: ["env:QUICKBOOKS_CLIENT_ID", "env:QUICKBOOKS_CLIENT_SECRET", "conn:quickbooks"], verdict: "NOT CONFIGURED",
    gap: "Code complete and proven in-memory; syncing needs the QuickBooks OAuth app and a tenant connection (0 exist). QuickBooks is a ledger sync, never a bank transfer." },
  { id: "R28", name: "Usage metering and plan allowances", advertised: ["tier:usage_metering", ...((CHECK_VOCABULARIES.plan_limits?.metric ?? []).map((m) => `limit:${m}`))],
    route: "/dashboard/settings/usage", ui: ["app/dashboard/settings/usage", "app/settings/billing"], actions: ["app/actions/usage-overview.ts", "app/actions/billing.ts", "app/actions/superadmin/plan-catalog.ts"], domain: ["lib/usage", "lib/billing/ai-overage.ts"],
    tables: ["usage_counters", "plan_limits"], proofs: ["test:usage-period", "test:seat-display", "test:plan-catalog"], canaries: [], needs: [], verdict: "PARTIAL",
    gap: (d) => d.unmeasured.length === 0
      ? ""
      : `${d.unmeasured.length} of ${d.vocab.length} plan limits have NO measurement behind them (${d.unmeasured.join(", ")}): the usage and billing pages now say "Not measured yet" instead of a green 0%, and plan cards no longer name them. Their writers belong at the send / storage choke points (lib/ — outside this lane).`,
    note: "Stock metrics (contacts, active transactions, seats) are counted live at read time; flow metrics need a usage_counters writer. ai_voice_minutes is metered on the phone-plan rail under a different allowance spelling (features.limits.included_voice_minutes) — one vocabulary per function (§6) is an owner decision." },
  { id: "R29", name: "Subscription billing and the pricing-page promises", advertised: ["price:trial", "price:tiers", "price:custom_pricing", "price:seat_bands", "price:seat_packages", "price:overage"],
    route: "/pricing", ui: ["app/pricing", "app/signup"], actions: ["app/actions/billing.ts"], domain: ["lib/billing"],
    tables: ["subscription_tiers", "subscriptions"], proofs: ["test:billing-convergence", "test:plan-catalog", "test:seat-packages"], canaries: ["subscriber", "commercial-platform", "coupon"], needs: ["env:STRIPE_SECRET_KEY", "owner:the Stripe webhook signing secret STRIPE_WEBHOOK_SECRET (resolved by name through lib/billing/stripe-account-scope.ts PLATFORM_ONLY_STRIPE_ENV, not a literal process.env read)", "owner:Stripe products and prices (owner ruling: none created yet)"], verdict: "NOT CONFIGURED",
    gap: "Code complete and proven in-memory; checkout refuses with 'price_not_configured' until the owner creates the Stripe products and prices. Prices are administered rows (subscription_tiers); multi_location is quoted by a person, never checked out." },
  { id: "R30", name: "Live agent and AI reception", advertised: ["demo:live_agent", "demo:reception_isa"],
    route: "/get-started", ui: ["app/get-started"], actions: ["app/get-started/actions.ts"], domain: ["lib/live-agent", "lib/voice", "lib/did"],
    tables: ["platform_prospects"], proofs: ["test:did-live-agent", "test:platform-live-agent", "test:live-agent-identity"], canaries: ["ai-by-your-side"], needs: ["env:DID_API_KEY", "env:TWILIO_ACCOUNT_SID"], verdict: "NOT CONFIGURED",
    gap: "Code complete and proven in-memory; the talking agent needs the avatar credential and the reception line needs the telephony credentials." },
  { id: "R31", name: "Recruiting operations", advertised: ["demo:recruiting_ops"],
    route: null, ui: ["app/recruiting"], actions: ["app/actions/recruiting-roi.ts"], domain: ["lib/recruiting", "lib/recruit-pipeline", "lib/agents/recruit-outreach-producer.ts"],
    tables: ["recruits"], proofs: ["test:recruit-outreach", "test:recruiting-roi", "test:stale-recruit-reaper"], canaries: [], needs: [], verdict: "CERTIFIED", gap: "",
    note: "Outreach delivery rides R08 / R09." },
  { id: "R32", name: "Lead engine — acquisition, enrichment and routing", advertised: ["demo:lead_engine"],
    route: "/leads", ui: ["app/leads"], actions: ["app/actions/lead-intelligence.ts"], domain: ["lib/lead-pipeline"],
    tables: ["leads"], proofs: ["test:lead-pipeline", "test:lead-intake-pipeline", "test:lead-flow"], canaries: ["lead", "lead-magnet"], needs: ["env:VERSIUM_API_KEY"], verdict: "NOT CONFIGURED",
    gap: "Raw-lead → dedup → enrichment → gate → lead → ISA → contact is built and proven in-memory; enrichment and look-alike research need the data-provider credential. leads holds 0 rows.", lane: "143D" },
  { id: "R33", name: "Support and help (tenant-scoped, AI-triaged)", advertised: ["core:support"],
    route: "/dashboard/support", ui: ["app/dashboard/support"], actions: ["app/actions/support.ts"], domain: ["lib/support"],
    tables: ["support_tickets", "support_ticket_messages"], proofs: ["test:support-isolation", "test:support-lane", "test:support-console"], canaries: ["support-isolation"], needs: [], verdict: "CERTIFIED", gap: "",
    note: "support_tickets holds 0 rows — the lane is proven in-memory only." },
  { id: "R34", name: "Reputation and review requests", advertised: ["core:reputation"],
    route: "/dashboard/reputation", ui: ["app/dashboard/reputation"], actions: ["app/actions/reputation-kernel.ts"], domain: ["lib/reputation"],
    tables: ["review_requests"], proofs: ["test:openhouse-reputation-wiring", "test:ai-authored-record"], canaries: [], needs: [], verdict: "CERTIFIED", gap: "",
    note: "The post-close request exists (app/api/cron/review-request-on-close) with a configurable delay in days; the owner's 'always ask at closing' reasoning is lane 143E's.", lane: "143E" },
  { id: "R35", name: "Tenant websites and landing pages", advertised: ["core:websites"],
    route: null, ui: ["app/site"], actions: ["app/actions/settings/public-site-links.ts"], domain: [],
    tables: ["brokerage_settings"], proofs: [], canaries: ["custom-domain"], needs: [], verdict: "PARTIAL",
    gap: "Landing pages (/lm/[slug]) are not yet rendered inside the tenant website / custom domain, and there is no lib/website or lib/tenant-site module at the base commit — lane 143G builds the convergence.", lane: "143G" },
  { id: "R36", name: "Lead magnets", advertised: ["core:lead_magnets"],
    route: "/dashboard/marketing/lead-magnets", ui: ["app/dashboard/marketing/lead-magnets"], actions: ["app/actions/lead-magnets-actions.ts", "app/actions/lead-magnet-capture.ts"], domain: ["lib/lead-magnets", "lib/marketing/lead-magnet-intent.ts"],
    tables: ["lead_magnets", "lead_capture_forms"], proofs: ["test:lead-magnet-creation", "test:lead-magnet-flow", "test:lead-magnet-routing"], canaries: ["lead-magnet"], needs: [], verdict: "CERTIFIED", gap: "",
    note: "AI-generated usable assets (not only suggestions) are lane 143F's.", lane: "143F" },
  { id: "R37", name: "Vendors and marketplace", advertised: ["core:vendors"],
    route: "/dashboard/vendors", ui: ["app/dashboard/vendors"], actions: ["app/actions/vendor-marketplace.ts"], domain: ["lib/vendor-marketplace", "lib/vendors", "lib/agents/vendor-loop-producer.ts", "lib/kernel/vendor-orchestration.ts"],
    tables: ["vendors", "vendor_bookings"], proofs: ["test:vendor-loop", "test:vendor-orchestration", "test:vendor-categories"], canaries: [], needs: [], verdict: "CERTIFIED", gap: "" },
  { id: "R38", name: "Contact enrichment", advertised: ["flag:contact_enrichment"],
    route: null, ui: ["app/crm/contacts"], actions: ["app/actions/contacts.ts"], domain: ["lib/enrichment"],
    tables: ["contacts"], proofs: ["test:immediate-enrichment", "test:enrichment-one-rail"], canaries: ["immediate-enrichment"], needs: ["env:VERSIUM_API_KEY"], verdict: "NOT CONFIGURED",
    gap: "Code complete and proven in-memory (missing-field-only, consent, budget); lookups need the data-provider credential.", lane: "143D" },
]

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// PURE CHECKERS (fixtures below prove each one still recognises the defect it was written for)
// ═════════════════════════════════════════════════════════════════════════════════════════════════
export interface Ctx {
  exists: (rel: string) => boolean
  isDir: (rel: string) => boolean
  hasPageUnder: (dir: string) => boolean
  /** comment-stripped source ("" when missing). */
  src: (rel: string) => string
  liveTables: ReadonlySet<string>
  canaries: ReadonlySet<string>
  /** package.json test:* key → scripts/<file>.ts (repo-relative) or null. */
  proofScript: (key: string) => string | null
  platformVocab: ReadonlySet<string>
  envRead: (name: string) => boolean
}
const stem = (p: string) => p.replace(/\.(ts|tsx)$/, "")
/**
 * PURE: does this (comment-stripped) proof script NAME one of the row's files? A script names a file when it spells a
 * repo path (`app/…` / `lib/…`, with or without a `../` or `@/` prefix and an extension) that IS the anchor, sits UNDER an
 * anchor directory, or is a directory the anchor sits under (`app/actions/settings` names `app/actions/settings/x`).
 * Comments are already blanked by the caller — a tombstone naming a file is not a reference (§2).
 */
export function proofNames(scriptSrc: string, anchors: string[]): boolean {
  const refs = new Set<string>()
  for (const m of scriptSrc.matchAll(/(?<![A-Za-z0-9_])((?:app|lib)\/[A-Za-z0-9_\-\[\]\/.]+)/g)) {
    const r = stem(m[1].replace(/[./]+$/, ""))
    if (r.includes("/")) refs.add(r) // a bare `lib` / `app` is every file's ancestor — it names nothing
  }
  return anchors.some((a) => [...refs].some((r) => r === a || r.startsWith(a + "/") || a.startsWith(r + "/")))
}
const ADVERT_RE = /^(flag|tier|limit|demo|price|core):[a-z0-9_]+$/

export function rowDefects(row: Row, ctx: Ctx, derived: Derived): string[] {
  const d: string[] = []
  const bad = (m: string) => d.push(`${row.id} ${m}`)
  if (!VERDICTS.includes(row.verdict)) bad(`verdict "${row.verdict}" is not one of the five`)
  if (!/^R\d{2}$/.test(row.id)) bad("id is not R<nn>")
  if (row.advertised.length === 0) bad("advertises nothing — a row with no promise is not a feature row")
  for (const a of row.advertised) if (!ADVERT_RE.test(a)) bad(`advertised item "${a}" is not kind:key`)
  for (const dir of row.ui) if (!ctx.isDir(dir) || !ctx.hasPageUnder(dir)) bad(`ui "${dir}" is not a route directory holding a page.tsx`)
  if (row.route && !ctx.exists(`app${row.route}/page.tsx`)) bad(`route "${row.route}" has no app${row.route}/page.tsx`)
  for (const a of row.actions) {
    if (!ctx.exists(a)) { bad(`action "${a}" does not exist`); continue }
    if (!/export\s+(async\s+function|const\s+\w+\s*=\s*async)/.test(ctx.src(a))) bad(`action "${a}" exports no async function`)
  }
  for (const dom of row.domain) if (!ctx.exists(dom)) bad(`domain "${dom}" does not exist`)
  for (const t of row.tables) if (!ctx.liveTables.has(t)) bad(`table "${t}" is not a live table`)
  const anchors = [...row.actions, ...row.domain, ...row.ui].map(stem)
  for (const k of row.proofs) {
    const script = ctx.proofScript(k)
    if (!script) { bad(`proof "${k}" is not a package.json test key naming an existing script`); continue }
    if (!proofNames(ctx.src(script), anchors)) bad(`proof "${k}" names none of this row's files — a decorative citation`)
  }
  for (const c of row.canaries) if (!ctx.canaries.has(c) || !ctx.exists(`scripts/canaries/${c}.ts`)) bad(`canary "${c}" is not in CANARY_KEYS or has no scripts/canaries file`)
  for (const n of row.needs) {
    const [kind, ...rest] = n.split(":"); const val = rest.join(":")
    if (kind === "env") { if (!ctx.envRead(val)) bad(`need env:${val} — no code reads process.env.${val}`) }
    else if (kind === "conn") { if (!ctx.platformVocab.has(val)) bad(`need conn:${val} — not in the platform_credentials.platform CHECK`) }
    else if (kind === "table") { if (!ctx.liveTables.has(val)) bad(`need table:${val} — not a live table`) }
    else if (kind === "owner") { if (!val.trim()) bad("need owner: has no text") }
    else bad(`need "${n}" has an unknown kind`)
  }
  const gap = typeof row.gap === "function" ? row.gap(derived) : row.gap
  switch (row.verdict) {
    case "CERTIFIED":
      if (row.proofs.length === 0) bad("CERTIFIED with no proof")
      if (row.needs.length) bad("CERTIFIED but needs a credential / owner decision — that is NOT CONFIGURED")
      if (gap.trim()) bad("CERTIFIED but records an open gap")
      if (!row.ui.length || !row.actions.length) bad("CERTIFIED with no UI or no action in the chain")
      break
    case "NOT CONFIGURED":
      if (!row.needs.length) bad("NOT CONFIGURED names no dependency")
      if (!gap.trim()) bad("NOT CONFIGURED states no gap")
      if (row.proofs.length === 0 || !row.ui.length) bad("NOT CONFIGURED claims 'code complete' with no proof or no UI")
      break
    case "PARTIAL":
      if (!gap.trim()) bad("PARTIAL states no gap")
      if (!row.ui.length) bad("PARTIAL with no UI at all is UNSUPPORTED")
      break
    case "UNSUPPORTED":
    case "HIDDEN UNTIL AVAILABLE":
      if (!gap.trim()) bad(`${row.verdict} states no reason`)
      if (row.verdict === "HIDDEN UNTIL AVAILABLE" && !(row.publicTerms ?? []).length) bad("HIDDEN names no publicTerms to keep off public surfaces")
      break
  }
  return d
}

export function coverageDefects(rows: Row[], universe: Record<string, readonly string[]>): string[] {
  const d: string[] = []
  const seen = new Map<string, string[]>()
  for (const r of rows) for (const a of r.advertised) { const k = a; seen.set(k, [...(seen.get(k) ?? []), r.id]) }
  for (const [kind, keys] of Object.entries(universe)) {
    for (const key of keys) {
      const owners = seen.get(`${kind}:${key}`) ?? []
      if (owners.length === 0) d.push(`${kind}:${key} is advertised by the catalogue but no row certifies it`)
      if (owners.length > 1) d.push(`${kind}:${key} is claimed by ${owners.join(" and ")} — one feature, one verdict`)
    }
    for (const a of seen.keys()) if (a.startsWith(`${kind}:`) && !keys.includes(a.slice(kind.length + 1))) d.push(`${a} is certified but is not in the ${kind} catalogue (phantom)`)
  }
  return d
}

/** Which plan_limits metrics does ANYTHING count? Derived from the usage_counters writers (stripped source; definitions excluded). */
export function deriveWriterMetrics(files: Array<{ rel: string; src: string }>): Set<string> {
  const out = new Set<string>()
  for (const { rel, src } of files) {
    if (rel === "lib/usage/log-media-usage.ts" || rel === "lib/usage/check-cap.ts" || rel === "lib/usage/metric-labels.ts") continue
    const consts = new Map<string, string>()
    for (const m of src.matchAll(/(?:export\s+)?const\s+([A-Z_]+)\s*=\s*["']([a-z_]+)["']/g)) consts.set(m[1], m[2])
    for (const m of src.matchAll(/logMediaUsage\(\s*\{([\s\S]{0,500}?)\}\s*\)/g)) {
      const lit = /metric\s*:\s*["']([a-z_]+)["']/.exec(m[1]); const ref = /metric\s*:\s*([A-Z_]+)/.exec(m[1])
      if (lit) out.add(lit[1]); else if (ref && consts.has(ref[1])) out.add(consts.get(ref[1])!)
    }
    for (const m of src.matchAll(/incrementUsage\(\s*[^,]+,\s*["']([a-z_]+)["']/g)) out.add(m[1])
  }
  return out
}

/** PURE: every env var name the (comment-stripped) code READS — `process.env.X`, `process.env["X"]`, and the quoted names a file resolves through `process.env[name]`. Prose naming a variable is not a read. */
export function collectEnvNames(files: Array<{ src: string }>): Set<string> {
  const out = new Set<string>()
  for (const { src } of files) {
    for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) out.add(m[1])
    for (const m of src.matchAll(/process\.env\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]/g)) out.add(m[1])
    if (/process\.env\[/.test(src)) for (const m of src.matchAll(/["']([A-Z][A-Z0-9_]{5,})["']/g)) out.add(m[1])
  }
  return out
}

/** PURE: every place code GATES on a subscription_tiers.features key by literal — `isTierFeatureIncluded(x, "key")` or `resolveFeatureEntitlement({ …, featureKey: "key" })`. (Comments are blanked by the caller.) */
export function tierFlagGateCalls(files: Array<{ rel: string; src: string }>, keys: readonly string[]): string[] {
  const out: string[] = []
  for (const { rel, src } of files) {
    for (const m of src.matchAll(/(?:isTierFeatureIncluded|resolveFeatureEntitlement)\s*\(([\s\S]{0,240}?)\)/g)) {
      for (const k of keys) if (new RegExp(`["']${k}["']`).test(m[1])) out.push(`${rel}: ${k}`)
    }
  }
  return out
}

/** A plan allowance invented in code: `features.x || 1000`, or the invented key names the live features object never carried. */
export function inventedAllowances(src: string): string[] {
  const hits: string[] = []
  for (const m of src.matchAll(/\bfeatures\??\.\w+\s*\|\|\s*\d[\d_]*/g)) hits.push(m[0])
  for (const m of src.matchAll(/\b(ai_calls_monthly|video_minutes_monthly|ai_calls_limit|storage_limit_bytes|voice_minutes_limit)\b/g)) hits.push(m[0])
  for (const m of src.matchAll(/tierLimits\.\w+\s*\|\|\s*\d[\d_]*/g)) hits.push(m[0])
  return hits
}

export function publicLeak(row: Row, surfaces: Array<{ rel: string; src: string }>): string[] {
  const out: string[] = []
  for (const t of row.publicTerms ?? []) for (const s of surfaces) if (s.src.toLowerCase().includes(t.toLowerCase())) out.push(`${row.id} "${t}" appears on ${s.rel}`)
  return out
}

// ── the document and the e2e route list are GENERATED from the registry ────────────────────────
export function renderDoc(rows: Row[], derived: Derived, flagReads: Record<string, number>): string {
  const by = (v: Verdict) => rows.filter((r) => r.verdict === v)
  const gapOf = (r: Row) => (typeof r.gap === "function" ? r.gap(derived) : r.gap)
  const rowOf = (adv: string) => rows.find((r) => r.advertised.includes(adv))?.id ?? "—"
  const L: string[] = []
  L.push("# Feature certification — what the plans advertise, and what is true")
  L.push("")
  L.push("<!-- GENERATED by scripts/feature-certification-guard.ts (--write-doc). Do not edit by hand: the guard fails when this file differs from the registry. -->")
  L.push("")
  L.push(`Wave 143, lane 143J. Live census read-only on ${LIVE_CENSUS_DATE} (project hrvaqgvukzxfskkcrwbt). Proof: \`npx tsx scripts/feature-certification-guard.ts\` (package.json key to add: \`"test:feature-certification": "tsx scripts/feature-certification-guard.ts"\`).`)
  L.push("")
  L.push("## How to read a verdict")
  L.push("")
  L.push("| Verdict | Means |")
  L.push("|---|---|")
  L.push("| CERTIFIED | Every link UI → action → domain → database is a real file / live table, at least one existing proof script names the row's files, the row needs no provider credential or owner decision, and no gap is open. It does **not** mean exercised live. |")
  L.push("| NOT CONFIGURED | Code complete and proven in-memory, but the advertised outcome needs a credential or owner decision this repository cannot supply. Presence in production is lane 143H's inventory, never assumed here. |")
  L.push("| PARTIAL | A link is missing or an advertised sub-capability is not delivered; the gap says which. |")
  L.push("| UNSUPPORTED | No implementation exists. |")
  L.push("| HIDDEN UNTIL AVAILABLE | Advertised in the plan catalogue but not deliverable — kept off every public surface until it is. |")
  L.push("")
  L.push("**Nothing here has run for a customer.** The live database holds 2 brokerages, 2 subscriptions, 0 offers, 0 leads, 0 video projects, 0 podcast episodes, 0 email sends, 0 support tickets, 0 `agent_action_ledger` rows and 0 `platform_credentials` rows. Every chain below is proven by repository proofs and in-memory canaries (`npm run test:canaries`: 34 chains, 479 steps) — never by a live provider call.")
  L.push("")
  L.push("## What the plans actually advertise (measured)")
  L.push("")
  L.push(`- \`subscription_tiers.marketing_bullets\` is **empty on all four tiers**: the public /pricing page renders no feature list from the database. Its promises are price, the trial, seat bands, seat packages, custom pricing and overage — row R29. No allowance number is hard-coded on any public surface (guarded).`)
  L.push(`- \`subscription_tiers.features\` carries ${LIVE_TIER_FLAG_KEYS.length} boolean flags; **no code reads any of them as a gate** — they describe the plan, they do not enforce it. Entitlement is the subscription state plus \`feature_flags\`.`)
  L.push(`- \`feature_flags\` holds ${LIVE_FEATURE_FLAG_KEYS.length} rows, all enabled at 100 % rollout; 2 are multi_location-only. ${Object.values(flagReads).filter((n) => n === 0).length} of the ${LIVE_FEATURE_FLAG_KEYS.length} keys are read by **no file** in app/ or lib/ — they are catalogue entries; the feature they name is gated by the paid-capability resolver (\`mayUseAndAfford\`), not by the key.`)
  L.push(`- \`plan_limits\` holds ${derived.vocab.length} metrics per tier; ${derived.measured.length} are measured (counted by a writer or counted live), **${derived.unmeasured.length} are not**.`)
  L.push("")
  L.push("## Summary")
  L.push("")
  L.push("| Verdict | Rows |")
  L.push("|---|---|")
  for (const v of VERDICTS) L.push(`| ${v} | ${by(v).length}${by(v).length ? " — " + by(v).map((r) => r.id).join(", ") : ""} |`)
  L.push("")
  L.push("## Feature rows")
  L.push("")
  L.push("| Id | Feature | Verdict | UI route | Action → domain → tables | Proofs · canaries | Needs / gap |")
  L.push("|---|---|---|---|---|---|---|")
  for (const r of rows) {
    const chain = `${r.actions.map((a) => "`" + a + "`").join(", ") || "—"} → ${r.domain.map((a) => "`" + a + "`").join(", ") || "—"} → ${r.tables.join(", ") || "—"}`
    const ev = `${r.proofs.join(", ") || "—"}${r.canaries.length ? " · " + r.canaries.join(", ") : ""}`
    const needs = r.needs.length ? "needs " + r.needs.join(", ") + ". " : ""
    const gap = gapOf(r)
    L.push(`| ${r.id} | ${r.name}${r.lane ? ` (${r.lane})` : ""} | **${r.verdict}** | ${r.route ? "`" + r.route + "`" : "—"} | ${chain} | ${ev} | ${(needs + gap + (r.note ? " " + r.note : "")).trim().replace(/\|/g, "/") || "—"} |`)
  }
  L.push("")
  L.push("## Catalogue → row (every advertised key has exactly one verdict)")
  L.push("")
  L.push("| `feature_flags.feature_key` | Row | Verdict | Files that read the key |")
  L.push("|---|---|---|---|")
  for (const k of LIVE_FEATURE_FLAG_KEYS) {
    const id = rowOf(`flag:${k}`); const r = rows.find((x) => x.id === id)
    L.push(`| ${k} | ${id} | ${r?.verdict ?? "—"} | ${flagReads[k] ?? 0} |`)
  }
  L.push("")
  L.push("| `subscription_tiers.features` key | Row | Verdict | Gate reads it |")
  L.push("|---|---|---|---|")
  for (const k of LIVE_TIER_FLAG_KEYS) { const id = rowOf(`tier:${k}`); const r = rows.find((x) => x.id === id); L.push(`| ${k} | ${id} | ${r?.verdict ?? "—"} | no (descriptive) |`) }
  L.push("")
  L.push("| `plan_limits.metric` | Label | Measured by | Plan cards may name it |")
  L.push("|---|---|---|---|")
  for (const m of derived.vocab) {
    const by2 = COUNTER_BACKED_METRICS.has(m) ? "usage_counters writer" : LIVE_STOCK_METRICS.has(m) ? "live count at read time" : "**nothing — Not measured yet**"
    L.push(`| ${m} | ${METRIC_LABELS[m] ?? "—"} | ${by2} | ${PLAN_CARD_METRICS.includes(m) ? "yes" : "no"} |`)
  }
  L.push("")
  L.push("| Platform demo topic (`lib/platform/product-demo.ts`) | Row | Verdict |")
  L.push("|---|---|---|")
  for (const t of PRODUCT_DEMO_TOPICS) { const id = rowOf(`demo:${t}`); L.push(`| ${t} | ${id} | ${rows.find((x) => x.id === id)?.verdict ?? "—"} |`) }
  L.push("")
  L.push("| /pricing promise | Row | Verdict |")
  L.push("|---|---|---|")
  for (const c of PRICE_CLAIMS) { const id = rowOf(`price:${c}`); L.push(`| ${c} | ${id} | ${rows.find((x) => x.id === id)?.verdict ?? "—"} |`) }
  L.push("")
  L.push("## Open owner decisions this audit surfaced")
  L.push("")
  L.push("1. `feature_flags.custom_reports` is enabled for every tier but no report builder exists (R21). Disable it until one does — a data change, owner approval required, NOT applied here: `update feature_flags set enabled = false where feature_key = 'custom_reports';`")
  L.push("2. `plan_limits.ai_voice_minutes` and `subscription_tiers.features.limits.included_voice_minutes` are two spellings of one allowance; only the second is metered. Choose the allowance of record (§6).")
  L.push(`3. The ${derived.unmeasured.length} unmeasured plan limits (${derived.unmeasured.join(", ")}) have no writer. Until one lands they are not shown as usage and not named on plan cards; decide whether to build the writers or retire the rows.`)
  L.push("4. The two multi_location-only flags are read by no gate (R23): the restriction is in the catalogue row only, and any tenant admin or broker can open the locations admin on any plan. Decide whether locations are a top-tier feature (then gate it with the paid-capability resolver) or a brokerage-tier one (then set the flags to match).")
  L.push("")
  return L.join("\n") + "\n"
}

export function renderRoutes(rows: Row[]): string {
  const publicRoutes = ["/login", "/pricing", "/get-started", "/signup", "/trust", "/demo", "/portal/login"]
  const protectedRoutes = rows.filter((r) => r.route && !publicRoutes.includes(r.route) && !r.route.startsWith("/pricing")).map((r) => ({ id: r.id, verdict: r.verdict, route: r.route }))
  return JSON.stringify({ _: "GENERATED by scripts/feature-certification-guard.ts (--write-doc). e2e/feature-certification.spec.ts reads it.", publicRoutes, protectedRoutes }, null, 2) + "\n"
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log("══════════════════════════════════════════════════════════════")
  console.log(" Feature certification — every advertised feature has one verdict")
  console.log("══════════════════════════════════════════════════════════════")

  // ── the real context ──────────────────────────────────────────────────────
  const srcCache = new Map<string, string>()
  const src = (rel: string) => { if (!srcCache.has(rel)) srcCache.set(rel, existsSync(join(ROOT, rel)) && statSync(join(ROOT, rel)).isFile() ? stripComments(readFileSync(join(ROOT, rel), "utf8")) : ""); return srcCache.get(rel)! }
  const exists = (rel: string) => existsSync(join(ROOT, rel))
  const isDir = (rel: string) => exists(rel) && statSync(join(ROOT, rel)).isDirectory()
  const hasPageUnder = (dir: string): boolean => {
    const abs = join(ROOT, dir)
    if (!existsSync(abs) || !statSync(abs).isDirectory()) return false
    for (const n of readdirSync(abs)) {
      const p = join(abs, n)
      if (n === "page.tsx") return true
      if (statSync(p).isDirectory() && hasPageUnder(join(dir, n))) return true
    }
    return false
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }
  const proofScript = (key: string): string | null => {
    const cmd = pkg.scripts[key]; if (!cmd || !key.startsWith("test:")) return null
    const m = /scripts\/([A-Za-z0-9._\/-]+\.ts)/.exec(cmd); return m && exists(`scripts/${m[1]}`) ? `scripts/${m[1]}` : null
  }
  const runtime = [...walkTs(join(ROOT, "app")), ...walkTs(join(ROOT, "lib"))].map((f) => ({ abs: f, rel: f.slice(ROOT.length + 1).replace(/\\/g, "/") }))
  const runtimeSrc = runtime.map((f) => ({ rel: f.rel, src: stripComments(readFileSync(f.abs, "utf8")) }))
  const envNames = collectEnvNames(runtimeSrc)
  const platformVocab = new Set<string>(CHECK_VOCABULARIES.platform_credentials?.platform ?? [])
  const ctx: Ctx = { exists, isDir, hasPageUnder, src, liveTables: new Set(LIVE_TABLES), canaries: new Set<string>(CANARY_KEYS), proofScript, platformVocab, envRead: (n) => envNames.has(n) }

  const vocab = [...(CHECK_VOCABULARIES.plan_limits?.metric ?? [])].sort()
  const measured = vocab.filter((m) => COUNTER_BACKED_METRICS.has(m) || LIVE_STOCK_METRICS.has(m))
  const unmeasured = vocab.filter((m) => !COUNTER_BACKED_METRICS.has(m) && !LIVE_STOCK_METRICS.has(m))
  const derived: Derived = { vocab, measured, unmeasured }

  // ── P · positive controls ──────────────────────────────────────────────────
  console.log("\n[P · positive controls — each checker still recognises the defect it was written for]")
  const fx: Ctx = {
    exists: (r) => ["app/dash/page.tsx", "app/actions/a.ts", "lib/dom.ts", "scripts/proof.ts", "scripts/canaries/ok.ts", "app/pub/page.tsx"].includes(r),
    isDir: (r) => r === "app/dash" || r === "app/nopage",
    hasPageUnder: (r) => r === "app/dash",
    src: (r) => (r === "app/actions/a.ts" ? "export async function go() {}" : r === "scripts/proof.ts" ? "touches app/actions/a and lib/dom" : r === "app/actions/sync.ts" ? "export function go() {}" : ""),
    liveTables: new Set(["t_live"]), canaries: new Set(["ok"]),
    proofScript: (k) => (k === "test:proof" ? "scripts/proof.ts" : k === "test:other" ? "scripts/other.ts" : null),
    platformVocab: new Set(["docusign"]), envRead: (n) => n === "SENDGRID_API_KEY",
  }
  const good: Row = { id: "R99", name: "fx", advertised: ["flag:x"], route: null, ui: ["app/dash"], actions: ["app/actions/a.ts"], domain: ["lib/dom.ts"], tables: ["t_live"], proofs: ["test:proof"], canaries: ["ok"], needs: [], verdict: "CERTIFIED", gap: "" }
  const dd = (r: Partial<Row>) => rowDefects({ ...good, ...r }, fx, derived)
  check("P1 a complete CERTIFIED fixture row has no defect", dd({}).length === 0, dd({}).join("; "))
  check("P2 a ui directory with no page.tsx, a route with no page, a missing action, an action with no async export, a missing domain and a phantom table are each caught",
    dd({ ui: ["app/nopage"] }).length === 1 && dd({ route: "/nowhere" }).length === 1 && dd({ actions: ["app/actions/missing.ts"] }).length === 1 &&
    rowDefects({ ...good, actions: ["app/actions/sync.ts"] }, { ...fx, exists: (r) => fx.exists(r) || r === "app/actions/sync.ts" }, derived).length === 1 &&
    dd({ domain: ["lib/missing.ts"] }).length === 1 && dd({ tables: ["t_phantom"] }).length === 1)
  check("P3 a proof key that is not a test key, a proof whose script exists but names none of the row's files (decorative), and a phantom canary are caught",
    dd({ proofs: ["test:none"] }).length === 1 && dd({ proofs: ["test:other"] }).length === 1 &&
    rowDefects({ ...good, proofs: ["test:proof"], actions: ["app/actions/a.ts"], domain: ["lib/dom.ts"] }, { ...fx, src: (r) => (r === "scripts/proof.ts" ? "touches nothing relevant" : fx.src(r)) }, derived).length === 1 &&
    dd({ canaries: ["ghost"] }).length === 1)
  check("P4 a CERTIFIED row that needs a credential, records a gap or has no proof is caught; so is a NOT CONFIGURED row with no dependency, a PARTIAL without a gap and a HIDDEN row with no publicTerms",
    dd({ needs: ["env:SENDGRID_API_KEY"] }).length === 1 && dd({ gap: "something open" }).length === 1 && dd({ proofs: [] }).length === 1 &&
    dd({ verdict: "NOT CONFIGURED", needs: [], gap: "x" }).length === 1 && dd({ verdict: "PARTIAL", gap: "" }).length === 1 &&
    dd({ verdict: "HIDDEN UNTIL AVAILABLE", ui: [], actions: [], domain: [], tables: [], proofs: [], canaries: [], gap: "no builder" }).length === 1 &&
    dd({ verdict: "NOT CONFIGURED", needs: ["env:SENDGRID_API_KEY"], gap: "needs key" }).length === 0)
  check("P5 a need naming an env var no code reads, a platform outside the CHECK, a phantom table, or an unknown kind is caught; a verified one is not",
    dd({ verdict: "NOT CONFIGURED", needs: ["env:NOPE_KEY"], gap: "g" }).length === 1 && dd({ verdict: "NOT CONFIGURED", needs: ["conn:ghostsign"], gap: "g" }).length === 1 &&
    dd({ verdict: "NOT CONFIGURED", needs: ["table:t_phantom"], gap: "g" }).length === 1 && dd({ verdict: "NOT CONFIGURED", needs: ["magic:x"], gap: "g" }).length === 1 &&
    dd({ verdict: "NOT CONFIGURED", needs: ["conn:docusign"], gap: "g" }).length === 0 && dd({ verdict: "bogus" as Verdict }).length >= 1)
  const univ = { flag: ["a", "b"] }
  const cov = (rows: Array<Partial<Row>>) => coverageDefects(rows.map((r) => ({ ...good, ...r })), univ)
  check("P6 coverage: an uncovered catalogue key, a key claimed by two rows and a phantom key are each caught; an exact cover is clean",
    cov([{ advertised: ["flag:a"] }]).length === 1 && cov([{ advertised: ["flag:a", "flag:b"] }, { id: "R98", advertised: ["flag:b"] }]).length === 1 &&
    cov([{ advertised: ["flag:a", "flag:b", "flag:c"] }]).length === 1 && cov([{ advertised: ["flag:a"] }, { id: "R98", advertised: ["flag:b"] }]).length === 0)
  const wm = deriveWriterMetrics([
    { rel: "x/a.ts", src: `await logMediaUsage({ brokerageId, metric: "tts_characters", quantity: 1 })\nawait incrementUsage(id, "llm_calls", 1)` },
    { rel: "x/v.ts", src: `export const VIDEO_METER_METRIC = "video_minutes" as const\nawait logMediaUsage({ brokerageId, metric: VIDEO_METER_METRIC, quantity: 1 })` },
    { rel: "lib/usage/check-cap.ts", src: `incrementUsage(x, "emails_sent", 1)` },
  ])
  check("P7 the writer census finds a literal logMediaUsage metric, an incrementUsage literal and a metric passed by named constant; it ignores the definition modules",
    wm.has("tts_characters") && wm.has("llm_calls") && wm.has("video_minutes") && !wm.has("emails_sent") && wm.size === 3)
  check("P8 a metric named only in a comment is not a writer (a tombstone is not a call site, §2)",
    deriveWriterMetrics([{ rel: "x/c.ts", src: stripComments(`// await incrementUsage(id, "emails_sent", 1)\n/* logMediaUsage({ metric: "sms_sent" }) */\nconst a = 1`) }]).size === 0)
  check("P9 invented allowances are caught in the shapes that shipped (`features?.x || 1000`, the absent key names, `tierLimits.x || N`); the plan_limits join and a tombstone are not",
    inventedAllowances("const a = features?.ai_calls_monthly || 1000").length === 2 && inventedAllowances("const c = tier.features.storage_gb || 5").length === 1 &&
    inventedAllowances("const a = tierLimits.ai_calls_limit || 10000").length === 2 && inventedAllowances("const limit = realLimits.get('llm_calls')").length === 0 &&
    inventedAllowances(stripComments("// features?.ai_calls_monthly || 1000 stood here\nconst a = 1")).length === 0)
  const envFx = collectEnvNames([
    { src: "const a = process.env.DIRECT_KEY; const b = process.env['BRACKET_KEY']" },
    { src: 'const NAMES = ["TABLE_RESOLVED_KEY"]; const v = process.env[NAMES[0]]' },
    { src: stripComments("// process.env.COMMENT_ONLY_KEY (retired)\nconst x = 1") },
    { src: 'const NAMES = ["NOT_AN_ENV_READ"]' },
  ])
  check("P12 the env census finds direct, bracketed and table-resolved reads; a name in a comment, or in a file that never reads process.env[...], is not a read (VAPI_API_KEY lived in prose only — the guard caught it)",
    envFx.has("DIRECT_KEY") && envFx.has("BRACKET_KEY") && envFx.has("TABLE_RESOLVED_KEY") && !envFx.has("COMMENT_ONLY_KEY") && !envFx.has("NOT_AN_ENV_READ"))
  check("P13 a proof 'names' a file only by a real path: the file, a path under it, or a directory above it — a bare `lib/` or an unrelated path is not a name",
    proofNames("reads app/actions/settings", ["app/actions/settings/x"]) && proofNames("from '../lib/dom'", ["lib/dom"]) && proofNames("lib/dom/sub/file.ts", ["lib/dom"]) &&
    !proofNames("see lib/ and app/ only", ["lib/dom"]) && !proofNames("lib/other", ["lib/dom"]) && !proofNames("", ["lib/dom"]))
  const gf = tierFlagGateCalls([
    { rel: "x/a.ts", src: 'if (isTierFeatureIncluded(tier.features, "accounting_sync")) go()' },
    { rel: "x/b.ts", src: 'await resolveFeatureEntitlement({ brokerageId, featureKey: "usage_metering" })' },
    { rel: "x/c.ts", src: stripComments('// isTierFeatureIncluded(f, "portal") stood here\nconst a = 1') },
    { rel: "x/d.ts", src: 'await resolveFeatureEntitlement({ brokerageId, featureKey })' },
  ], LIVE_TIER_FLAG_KEYS)
  check("P14 the tier-flag gate finder sees a literal isTierFeatureIncluded / resolveFeatureEntitlement call; a comment and a variable-keyed call are not literal gates",
    gf.length === 2 && gf.includes("x/a.ts: accounting_sync") && gf.includes("x/b.ts: usage_metering"))
  const cardRows = [
    { metric: "ai_tokens_monthly", limit_value: 10000000 }, { metric: "video_minutes", limit_value: "150" }, { metric: "contacts_count", limit_value: 2000 },
    { metric: "storage_gb", limit_value: 50 }, { metric: "emails_sent", limit_value: 5000 }, { metric: "live_avatar_minutes", limit_value: -1 }, { metric: "not_a_metric", limit_value: 3 },
  ]
  const cards = planCardAllowances(cardRows)
  check("P15 a plan card names a MEASURED allowance only: unmeasured rows (storage, email) and unknown metrics are dropped, -1 is Unlimited, a numeric string is read, and the lines read as 'Label: value'",
    cards.map((c) => c.metric).join(",") === "ai_tokens_monthly,video_minutes,live_avatar_minutes,contacts_count" && cards.find((c) => c.metric === "live_avatar_minutes")!.limit === null &&
    allowanceLine(cards[0]) === "AI usage (tokens): 10,000,000 / mo" && allowanceLine(cards[2]) === "Live AI minutes: Unlimited" && allowanceLine(cards[3]) === "Contacts: 2,000" && planCardAllowances([]).length === 0)
  const hidden: Row = { ...good, verdict: "HIDDEN UNTIL AVAILABLE", publicTerms: ["custom report"] }
  check("P10 a HIDDEN feature named on a public surface is caught (case-insensitively); a clean surface is not",
    publicLeak(hidden, [{ rel: "app/pricing/page.tsx", src: "Build Custom Reports in minutes" }]).length === 1 && publicLeak(hidden, [{ rel: "app/pricing/page.tsx", src: "Pricing" }]).length === 0)
  const docA = renderDoc([{ ...good, id: "R01" }], derived, {}), docB = renderDoc([{ ...good, id: "R01", verdict: "PARTIAL", gap: "x" }], derived, {})
  check("P11 the generated document changes when a verdict changes — the document-sync check below is sensitive to exactly that drift", docA !== docB && docA.includes("**CERTIFIED**") && docB.includes("**PARTIAL**"))

  // ── A · the registry against the repository ───────────────────────────────
  console.log("\n[A · the registry against the repository — every link of every chain]")
  const defects = ROWS.flatMap((r) => rowDefects(r, ctx, derived))
  check(`A1 all ${ROWS.length} rows resolve: ui route, action, domain, live table, proof (naming the row's files), canary, dependency`, defects.length === 0, defects.join(" | "))
  check("A2 row ids are unique and in order", new Set(ROWS.map((r) => r.id)).size === ROWS.length && ROWS.every((r, i) => r.id === `R${String(i + 1).padStart(2, "0")}`))

  // ── C · catalogue coverage ────────────────────────────────────────────────
  console.log("\n[C · catalogue coverage — what the plans advertise vs what the registry certifies]")
  const universe: Record<string, readonly string[]> = { flag: LIVE_FEATURE_FLAG_KEYS, tier: LIVE_TIER_FLAG_KEYS, limit: vocab, demo: PRODUCT_DEMO_TOPICS, price: PRICE_CLAIMS }
  const covDefects = coverageDefects(ROWS, universe)
  check(`C1 every feature_flags key (${LIVE_FEATURE_FLAG_KEYS.length}), tier flag (${LIVE_TIER_FLAG_KEYS.length}), plan_limits metric (${vocab.length}), demo topic (${PRODUCT_DEMO_TOPICS.length}) and /pricing promise (${PRICE_CLAIMS.length}) has exactly one row`, covDefects.length === 0, covDefects.join(" | "))
  const flagReads: Record<string, number> = {}
  for (const k of LIVE_FEATURE_FLAG_KEYS) { const re = new RegExp(`["'\`]${k}["'\`]`); flagReads[k] = runtimeSrc.filter((f) => re.test(f.src)).length }
  const unread = LIVE_FEATURE_FLAG_KEYS.filter((k) => flagReads[k] === 0)
  console.log(`    feature_flags keys read by no file in app/ or lib/: ${unread.length} of ${LIVE_FEATURE_FLAG_KEYS.length} (catalogue entries — the feature is gated by the paid-capability resolver, not the key)`)
  const pricingSrc = src("app/pricing/page.tsx") + src("lib/platform/public-tiers.ts")
  check("C2 each /pricing promise the registry certifies is still made by the page (trial, custom pricing, annual/setup fee, seat bands via the DB-driven loader)",
    /free trial/i.test(pricingSrc) && /Custom pricing|custom-priced/i.test(pricingSrc) && /isCustomPricedTier/.test(pricingSrc) && /setup/i.test(pricingSrc))

  const tierGates = tierFlagGateCalls(runtimeSrc, LIVE_TIER_FLAG_KEYS)
  check("C3 no code gates on a subscription_tiers.features key by literal — which keeps the certification document's sentence 'they describe the plan, they do not enforce it' TRUE (a gate that appears here must move that sentence and the rows)", tierGates.length === 0, tierGates.join(" | "))

  // ── M · the plan-limit measurement rule ───────────────────────────────────
  console.log("\n[M · plan limits — a number is shown only if something counted it]")
  const writers = deriveWriterMetrics(runtimeSrc)
  const writersNotCounted = [...writers].filter((m) => !COUNTER_BACKED_METRICS.has(m))
  const countedNoWriter = [...COUNTER_BACKED_METRICS].filter((m) => !writers.has(m))
  console.log(`    usage_counters writers found in code: ${[...writers].sort().join(", ")}`)
  check("M1 COUNTER_BACKED_METRICS equals the metrics some writer in app/ + lib/ increments — in BOTH directions (a new writer or a removed one fails until the set moves)",
    writersNotCounted.length === 0 && countedNoWriter.length === 0, `writer not declared: ${writersNotCounted.join(",") || "-"}; declared with no writer: ${countedNoWriter.join(",") || "-"}`)
  check("M2 every plan_limits metric in the CHECK cache has a label, and every label is a real metric (no phantom, no raw column name on a page)",
    vocab.every((m) => m in METRIC_LABELS) && Object.keys(METRIC_LABELS).every((m) => vocab.includes(m)), `unlabelled: ${vocab.filter((m) => !(m in METRIC_LABELS)).join(",") || "-"}; phantom: ${Object.keys(METRIC_LABELS).filter((m) => !vocab.includes(m)).join(",") || "-"}`)
  check("M3 the live-stock and counter-backed sets are real metrics, disjoint, and every plan-card metric is a measured one",
    [...LIVE_STOCK_METRICS, ...COUNTER_BACKED_METRICS].every((m) => vocab.includes(m)) && [...LIVE_STOCK_METRICS].every((m) => !COUNTER_BACKED_METRICS.has(m)) && PLAN_CARD_METRICS.every((m) => measured.includes(m)))
  const r28 = ROWS.find((r) => r.id === "R28")!
  check(`M4 R28's verdict follows the derivation: ${unmeasured.length} unmeasured metric(s) ⇒ ${unmeasured.length ? "PARTIAL" : "CERTIFIED"}, and its gap names every one`,
    r28.verdict === (unmeasured.length ? "PARTIAL" : "CERTIFIED") && unmeasured.every((m) => (typeof r28.gap === "function" ? r28.gap(derived) : r28.gap).includes(m)))
  console.log(`    measured (${measured.length}): ${measured.join(", ")}\n    unmeasured (${unmeasured.length}): ${unmeasured.join(", ") || "none"}`)
  const SURFACES = ["app/settings/billing/page.tsx", "app/settings/billing/usage-section.tsx", "app/settings/billing/upgrade-modal.tsx", "app/dashboard/admin/usage/page.tsx", "app/dashboard/settings/usage/page.tsx", "app/actions/usage-overview.ts"]
  const invented = SURFACES.flatMap((f) => inventedAllowances(src(f)).map((h) => `${f}: ${h}`))
  check("M5 no billing / usage surface invents a plan allowance (`features.x || N`, or a key the live features object never carried) — comments blanked, so a tombstone naming the old code is not a hit", invented.length === 0, invented.join(" | "))
  const overview = src("app/actions/usage-overview.ts"), usagePage = src("app/dashboard/settings/usage/page.tsx"), section = src("app/settings/billing/usage-section.tsx"), billingPage = src("app/settings/billing/page.tsx")
  check("M6 the usage overview reads both refusals, counts stock metrics live from the SESSION's brokerage, tags every metric with its source, and imports the one label table",
    /countersError/.test(overview) && /limitsError/.test(overview) && /source:\s*MetricSnapshot\["source"\]/.test(overview) && /resolveSeatUsage\(/.test(overview) && /from\("contacts"\)[\s\S]{0,120}ctx\.brokerageId/.test(overview) && /from\("transactions"\)[\s\S]{0,160}TRANSACTION_STATUSES_OPEN/.test(overview) && /@\/lib\/usage\/metric-labels/.test(overview) && !/const METRIC_LABELS/.test(overview))
  check("M7 both usage surfaces render 'Not measured yet' for an unmeasured metric instead of a progress bar, and the billing card is fed by the overview (no getBillingUsage, no hard-coded limits)",
    /Not measured yet/.test(usagePage) && /Not measured yet/.test(section) && /loadUsageOverview\(\)/.test(billingPage) && !/getBillingUsage/.test(billingPage) && /overview=\{usageOverview\}/.test(billingPage))

  // ── V · verdict honesty ───────────────────────────────────────────────────
  console.log("\n[V · verdict honesty — the promise and the verdict agree]")
  const counts: Record<string, number> = {}
  for (const v of VERDICTS) counts[v] = ROWS.filter((r) => r.verdict === v).length
  console.log(`    rows by verdict: ${VERDICTS.map((v) => `${v} ${counts[v]}`).join(" · ")}  (denominator: ${ROWS.length} rows, ${LIVE_FEATURE_FLAG_KEYS.length} flags, ${LIVE_TIER_FLAG_KEYS.length} tier flags, ${vocab.length} limits, ${PRODUCT_DEMO_TOPICS.length} demo topics, ${PRICE_CLAIMS.length} pricing promises)`)
  const PUBLIC_SURFACES = ["app/pricing/page.tsx", "app/get-started/page.tsx", "app/signup/page.tsx", "app/trust/page.tsx", "app/demo/page.tsx", "lib/platform/product-demo.ts", "lib/platform/public-tiers.ts"].map((rel) => ({ rel, src: src(rel) }))
  const leaks = ROWS.filter((r) => r.verdict === "HIDDEN UNTIL AVAILABLE" || r.verdict === "UNSUPPORTED").flatMap((r) => publicLeak(r, PUBLIC_SURFACES))
  check("V1 no HIDDEN / UNSUPPORTED feature is named on a public marketing surface (pricing, get-started, signup, trust, demo, the AI agent's demo script, the tier loader)", leaks.length === 0, leaks.join(" | "))
  const numeric = PUBLIC_SURFACES.flatMap((s) => [...s.src.matchAll(/\b\d[\d,]*\s*(?:AI calls|GB\b|video minutes|contacts\b|tokens\b|SMS\b|emails\b)/gi)].map((m) => `${s.rel}: ${m[0]}`))
  check("V2 no public surface hard-codes an allowance number (they all come from plan_limits / subscription_tiers rows)", numeric.length === 0, numeric.join(" | "))
  check("V3 every NOT CONFIGURED row names at least one dependency and none claims CERTIFIED; the five verdicts are all defined", ROWS.filter((r) => r.verdict === "NOT CONFIGURED").every((r) => r.needs.length > 0) && VERDICTS.length === 5)

  // ── D · the generated document and the e2e route list ─────────────────────
  console.log("\n[D · generated artifacts — the document and the Playwright route list cannot drift from the registry]")
  const docText = renderDoc(ROWS, derived, flagReads), routesText = renderRoutes(ROWS)
  if (process.argv.includes("--write-doc")) { writeFileSync(join(ROOT, DOC_PATH), docText); writeFileSync(join(ROOT, ROUTES_PATH), routesText); console.log(`    wrote ${DOC_PATH} and ${ROUTES_PATH}`) }
  const onDisk = existsSync(join(ROOT, DOC_PATH)) ? readFileSync(join(ROOT, DOC_PATH), "utf8") : ""
  const routesOnDisk = existsSync(join(ROOT, ROUTES_PATH)) ? readFileSync(join(ROOT, ROUTES_PATH), "utf8") : ""
  check(`D1 ${DOC_PATH} is exactly what the registry renders (regenerate: npx tsx scripts/feature-certification-guard.ts --write-doc)`, onDisk === docText)
  check(`D2 ${ROUTES_PATH} is exactly what the registry renders`, routesOnDisk === routesText)
  const spec = src("e2e/feature-certification.spec.ts")
  check("D3 the Playwright certification spec exists, reads the generated route list, covers desktop / tablet / phone through the config's projects, and skips (never passes) without a deployed URL or a session",
    /feature-certification\.routes\.json/.test(spec) && /UI_SMOKE_BASE_URL|E2E_BASE_URL/.test(spec + src("playwright.config.ts")) && /E2E_AUTH_STATE/.test(spec) && /tablet-chromium/.test(src("playwright.config.ts")) && /mobile-chromium/.test(src("playwright.config.ts")))

  console.log("\n    BLIND SPOTS: CERTIFIED is a static-chain + in-memory-proof statement (no live provider call, no rendered page); a proof is checked for NAMING the row's files, not for asserting the right thing about them; the flag / tier lists are a live census pinned at " + LIVE_CENSUS_DATE + ", not a live read; env checks prove the code reads a name, not that it is set; enforcement strength (hard cap vs advisory) is not derived — only measurement; the Playwright spec is authored, not run (WAITING_EXTERNAL: UI_SMOKE_BASE_URL, E2E_AUTH_STATE).")
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail) { console.log("FAILURES:\n  - " + fails.join("\n  - ")); process.exit(1) }
  console.log("✅ FEATURE_CERTIFICATION_PASS — every advertised feature has one verdict the code supports")
}
// Runs only when invoked directly, so a tool (or another proof) can import ROWS / the checkers without executing the guard.
if (process.argv[1] && /feature-certification-guard\.ts$/.test(process.argv[1])) main().catch((e) => { console.error(e); process.exit(1) })
