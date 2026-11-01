// lib/voice-admin/intent-interface.ts
// ─────────────────────────────────────────────────────────────────────────────
// C17 — THE ONE INTENT INTERFACE (wave 148, lane 148D). PURE: no I/O, no model, no server-only.
//
// Owner, verbatim (2026-11-01): "when trying to create ads, blogs, etc. the actor/user should be able to
// speak the search and what they want to accomplish in natural language and this should be the case in
// the whole OS."
//
//   interpretIntent({ utterance, modality: voice|text, actor, tenant, screen })
//     → { capability, params, missing[], plan, authority_check }        (this file — deterministic)
//   interpretIntentLive(...) → the same, with the ONE expert-prompted model assist (intent-interface-live.ts)
//   executeIntent(interpretation) → under the manager / authority rails  (intent-interface-live.ts)
//
// WHAT WAS HERE BEFORE — FOUR CLASSIFIERS, EACH SAYING "NOT THE SAME BRAIN" (CLAUDE.md §1, Law 2):
//   1. lib/voice-admin/kernel-command-surface.ts matchIntents        — the kernel lane (SURVIVOR: its phrase
//      table over the capability catalogue and its authorization → operability → confirmation gate order
//      are what this file is built on; nothing in it is replaced).
//   2. app/api/internal/voice-command/route.ts                        — a 30-intent LLM prompt (the shell
//      assistant, the spoken admin, the SMS door).
//   3. app/actions/voice-assistant.ts parseVoiceIntent               — a 12-intent prompt POSTed to
//      /api/ai/analyze (booked to no tenant) + a keyword fallback (the mobile field mic).
//   4. app/actions/voice-assistant/core/parse-intent.ts               — a gatewayChat prompt + a keyword
//      fallback (the Voice Command Center's governed command layer).
// Their CLASSIFIERS are retired onto THIS catalogue (tombstones at each site). Their EXECUTORS are not
// touched: an intent route names, per surface, the executor key that surface already owns
// (`executors`). One vocabulary of intents (§6), one prompt, many existing doors.
//
// WHAT IS NEW (the owner's six utterances had no route at all): six DOMAIN routes, each onto a capability
// that already exists — the listing ad producer, the criteria store, the AI blog writer, the buyer search
// engine, the one open-house scheduling door, the relationship-health ranking. No new service is built.
//
// THE GATE ORDER IS THE KERNEL LANE'S, NOT CONVENIENCE: authority first (never tell someone what they
// could do if they were allowed to), then operability, then missing information (asked, never guessed),
// then confirmation (a mutating step never runs on one sentence), then approval (anything that publishes
// waits for the tenant's approver).

import { APP_CAPABILITY_REGISTRY, type AppCapability, type AppDomain } from "@/lib/agentic-os/app-capability-registry"
import type { ManagerKey } from "@/lib/kernel/manager-registry"
import type { ToolRiskClass } from "@/lib/ai-isa/persona-tool-policy"
import { FEATURE_FLAGS } from "@/lib/security/permission-matrix"
import { RoleManager } from "@/lib/security/role-manager"
import { toCanonicalRole, type CanonicalRole } from "@/lib/security/types"
import { extractCriteriaFromTranscript, extractLifestyleAsks } from "@/lib/buyer-search/conversation-criteria"
import { detectFairHousingViolations } from "@/lib/compliance-rules/fair-housing-patterns"
import { protectedClassReasonFor } from "@/lib/lead-governance/protected-class-signals"
import { resolveSpokenDate, resolveSpokenTime } from "@/lib/voice/spoken-values"
import { voiceCapabilities, humanManager, VOICE_NEVER_SPOKEN } from "./kernel-command-surface"
import { assistantSkillRefusal } from "./assistant-reach"
import { parseTeamCommandText, type ParsedTeamCommand } from "@/lib/voice/parse-team-command"

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export const INTENT_MODALITIES = ["voice", "text"] as const
export type IntentModality = (typeof INTENT_MODALITIES)[number]

/** Where an intent route is EXECUTED. `c17` = by executeIntent in intent-interface-live.ts. */
export const INTENT_SURFACES = ["c17", "team_brain", "field_assistant", "command_layer", "client_portal"] as const
export type IntentSurface = (typeof INTENT_SURFACES)[number]

/** The family names who EXECUTES the route when the one affordance asks (its door). */
export const INTENT_FAMILIES = ["domain", "kernel_signal", "team_brain", "field_assistant", "command_layer", "client_portal"] as const
export type IntentFamily = (typeof INTENT_FAMILIES)[number]

/** Every screen the one affordance (app/components/shared/intent-affordance.tsx) is mounted on. The
 *  guard census holds every `<IntentAffordance screen="…">` to a key here. `bias` breaks a tie toward the
 *  route the screen is for (an "ad" said on the ads screen); it never adds a route that did not match. */
export const INTENT_SCREENS = {
  assistant:      { label: "Always-on assistant (every staff screen, desktop + mobile shell)", bias: [] as string[] },
  voice_center:   { label: "Voice Command Center", bias: [] as string[] },
  ads:            { label: "Ads", bias: ["listing_ad_draft"] },
  blog:           { label: "Blog", bias: ["market_blog_draft"] },
  contacts:       { label: "Contacts (CRM)", bias: ["contact_care_scan", "buyer_interest_search"] },
  open_houses:    { label: "Open houses", bias: ["open_house_schedule"] },
  mobile:         { label: "Mobile assistant", bias: [] as string[] },
} as const
export type IntentScreen = keyof typeof INTENT_SCREENS
export function isIntentScreen(v: unknown): v is IntentScreen {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(INTENT_SCREENS, v)
}

type FeatureKey = keyof typeof FEATURE_FLAGS

export interface IntentParamSpec {
  name: string
  required: boolean
  /** The question asked when this is required and missing — one plain sentence. */
  ask: string
}

export interface IntentRoute {
  key: string
  family: IntentFamily
  label: string
  /** The manager accountable for the work (the Command Center attribution). */
  manager: ManagerKey
  /** The catalogue capability whose scope, owner and operability contract govern this route; null when
   *  the route rides a domain service the catalogue does not list (named in `service`). */
  governedBy: AppCapability | null
  /** The existing service the route executes, as file:function (the survivor, never a new one). */
  service: string
  /** Role gate (lib/security/permission-matrix.ts FEATURE_FLAGS). null = the executing surface's OWN
   *  authority matrix decides (named in `service`) — C17 never second-guesses a surface's gate. */
  feature: FeatureKey | null
  risk: ToolRiskClass
  mutates: boolean
  /** True when the outcome reaches the public / a client — the tenant's approver approves it. */
  publishes: boolean
  /** Lowercase, multi-word, conservative. One phrase belongs to ONE route (guard-held). */
  phrases: readonly string[]
  params: readonly IntentParamSpec[]
  /** One line for the model's catalogue — what the person is asking for. */
  describe: string
  /** Per surface: the executor key that surface already owns for this intent. */
  executors: Partial<Record<IntentSurface, string>>
}

// ─── The six domain routes (the owner's utterances) ──────────────────────────

const DOMAIN_ROUTES: IntentRoute[] = [
  {
    key: "listing_ad_draft", family: "domain", label: "Draft a listing ad", manager: "ads_manager",
    governedBy: "ad_campaign_launch", service: "lib/ads/listing-ad-producer.ts:produceListingAdCampaign",
    feature: "campaigns", risk: "LOW_RISK_WRITE", mutates: true, publishes: true,
    phrases: ["create an ad", "make an ad", "build an ad", "write an ad", "draft an ad", "new ad for", "an ad for my", "facebook ad", "instagram ad", "ad for the listing", "ad for this listing"],
    params: [
      { name: "listing", required: true, ask: "Which listing is the ad for? Say the address, or open the listing and ask again." },
      { name: "kind", required: false, ask: "Is it just listed, a price improvement, or just sold?" },
      { name: "outcome", required: false, ask: "What should the ad achieve — showings, leads, or open-house traffic?" },
      { name: "audience", required: false, ask: "Who should it reach? Describe their needs (first-time buyers, relocating, downsizing) — never who they are." },
      { name: "platform", required: false, ask: "Facebook, Instagram, Google or LinkedIn?" },
    ],
    describe: "Create / draft a paid social ad for one of the agent's listings (just listed, price improvement, just sold). Drafted from the listing's facts in the brand voice; the creative waits in the approval queue.",
    executors: { c17: "listing_ad_draft" },
  },
  {
    key: "buyer_interest_search", family: "domain", label: "Find buyers by interest", manager: "shopping_agent",
    governedBy: null, service: "lib/buyer-search/buyer-criteria.ts (property_preferences — the C10 criteria store)",
    feature: "crm", risk: "READ", mutates: false, publishes: false,
    phrases: ["find buyers", "which buyers", "buyers interested in", "buyers looking for", "buyers who want", "any buyers", "who is looking for"],
    params: [{ name: "interest", required: true, ask: "What should the buyers be interested in — acreage, a pool, a city, a price range?" }],
    describe: "Find the agent's buyer contacts whose SAVED criteria (their own stated words) mention an interest — acreage, a pool, a city, a feature.",
    executors: { c17: "buyer_interest_search" },
  },
  {
    key: "market_blog_draft", family: "domain", label: "Write a market blog", manager: "campaign_orchestrator",
    governedBy: "blog_publish", service: "lib/kernel/content-creators.ts:writeBlogPost (+ lib/market-reports/research.ts researchMarket for the verified facts)",
    feature: "content_studio", risk: "LOW_RISK_WRITE", mutates: true, publishes: true,
    phrases: ["write a blog", "draft a blog", "write a post", "blog post", "blog on", "blog about", "write an article", "market update post"],
    params: [
      { name: "topic", required: true, ask: "What should the blog be about?" },
      { name: "area", required: false, ask: "Which area should it cover — a city or ZIP?" },
      { name: "period", required: false, ask: "Which period — this month, this quarter?" },
      { name: "audience", required: false, ask: "Who is it for — buyers, sellers, investors?" },
    ],
    describe: "Write / draft a blog post (e.g. this month's market) grounded in VERIFIED market data for the agent's territory; the draft waits for the approver before it publishes.",
    executors: { c17: "market_blog_draft" },
  },
  {
    key: "property_search", family: "domain", label: "Find homes", manager: "shopping_agent",
    governedBy: null, service: "lib/buyer-search/search-engine.ts:searchPropertiesCore (+ parse-buyer-criteria, the C10 parser)",
    feature: "buyer_portal", risk: "READ", mutates: false, publishes: false,
    phrases: ["find homes", "find a home", "find houses", "search homes", "search for homes", "homes with", "houses with", "find properties", "show me homes", "looking for a home"],
    params: [
      { name: "buyer", required: true, ask: "Which buyer is this search for? Open their contact, or say their name." },
      { name: "criteria", required: true, ask: "What should the home have — area, price, bedrooms, a yard?" },
      { name: "commute_destination", required: false, ask: "A short commute to where — work, downtown, a hospital — and how long a drive still works?" },
    ],
    describe: "Search homes for a buyer from what they want (features, lifestyle such as a yard or a short commute, area, price) — in-house listings and outside sources, each labelled.",
    executors: { c17: "property_search", team_brain: "find_properties" },
  },
  {
    key: "open_house_schedule", family: "domain", label: "Schedule an open house", manager: "listing_concierge",
    governedBy: "appointment_schedule", service: "app/actions/open-house.ts:createOpenHouse (the one scheduling door: open_house · broker_open · virtual_open_house)",
    feature: "listing_creation", risk: "LOW_RISK_WRITE", mutates: true, publishes: false,
    phrases: ["schedule an open house", "schedule a virtual open house", "set up an open house", "book an open house", "host an open house", "plan an open house", "virtual open house", "schedule a broker open", "broker open"],
    params: [
      { name: "listing", required: true, ask: "Which listing is the open house for? Say the address." },
      { name: "kind", required: false, ask: "In person, broker open, or virtual?" },
      { name: "date", required: true, ask: "What day should it be?" },
      { name: "start_time", required: true, ask: "What time does it start?" },
      { name: "end_time", required: true, ask: "And what time does it end?" },
      { name: "join_url", required: false, ask: "What is the https join link (the Zoom meeting) for the virtual open house?" },
    ],
    describe: "Schedule an open house for a listing — in person, broker open, or virtual (needs the https join link).",
    executors: { c17: "open_house_schedule", command_layer: "schedule_open_house" },
  },
  {
    key: "contact_care_scan", family: "domain", label: "Who may need help", manager: "sphere_of_influence",
    governedBy: null, service: "lib/intelligence/health-prioritizer-runner.ts:getHealthPrioritizedContacts",
    feature: "crm", risk: "READ", mutates: false, publishes: false,
    phrases: ["may need help", "might need help", "needs help", "need help", "need attention", "needs attention", "who should i check on", "who needs me", "falling through the cracks", "going cold", "need a check in"],
    params: [],
    describe: "Show which of the person's contacts may need help or attention (relationship cooling, no reply, long silence) — contacts only, never leads, ranked most-at-risk first.",
    executors: { c17: "contact_care_scan" },
  },
]

// ─── The team brain's intents (moved verbatim out of app/api/internal/voice-command/route.ts) ───────────
// The route keeps every executor; it no longer carries a classifier. Feature null: the brain's own gates
// decide (tenantAdminRefusal, isTenancyPrincipal, the platform-staff check on create_tenant_user).

type LegacySeed = [key: string, label: string, manager: ManagerKey, risk: ToolRiskClass, mutates: boolean, phrases: string[], describe: string]

const BRAIN_SEEDS: LegacySeed[] = [
  ["query_showings", "Showings", "shopping_agent", "READ", false, ["my showings", "showings today", "any showings", "upcoming showings"], "asking about today's or upcoming showings"],
  ["query_hot_contacts", "Hot contacts", "ai_isa", "READ", false, ["hot leads", "hot contacts", "who should i call", "top contacts", "who to call"], "asking about hot leads, top contacts, who to call"],
  ["query_tasks", "Tasks", "deal_coordinator", "READ", false, ["my tasks", "my to do", "overdue tasks", "what tasks"], "asking about tasks, to-dos, overdue items"],
  ["query_transactions", "Transactions", "deal_coordinator", "READ", false, ["active deals", "my transactions", "my deals", "active transactions"], "asking about active deals or transactions"],
  ["query_pipeline", "Pipeline", "ai_isa", "READ", false, ["my pipeline", "follow ups needed", "leads in my pipeline"], "asking about leads in pipeline or follow-ups needed"],
  ["create_task", "Create a task", "deal_coordinator", "LOW_RISK_WRITE", true, ["create a task", "add a task", "remind me to", "set a reminder"], "asking to create, add, or set a task reminder"],
  ["schedule_followup", "Schedule a follow-up", "ai_isa", "LOW_RISK_WRITE", true, ["schedule a follow up", "schedule a followup", "follow up next"], "asking to schedule a follow-up"],
  ["morning_standup", "Morning stand-up", "cron_manager", "READ", false, ["what should i do today", "what matters today", "what's my day", "where do i start", "my priorities"], "asking the team what to do / what matters today / priorities (NO specific person named)"],
  ["do_standup_item", "Do a stand-up item", "cron_manager", "LOW_RISK_WRITE", true, ["do number", "knock out number", "knock out the first", "handle number"], "telling the team to DO / knock out / approve a stand-up item BY ITS RANK"],
  ["reject_standup_item", "Reject a stand-up item", "cron_manager", "LOW_RISK_WRITE", true, ["reject number", "kill the second", "kill number", "reject the first"], "REJECTING a stand-up item by rank, optionally with a reason"],
  ["area_query", "Area activity", "listing_concierge", "READ", false, ["happening near", "running in", "anything happening in", "our listings in"], "asking what's happening / running / for sale in an AREA, neighborhood, city, or near a street"],
  ["team_query", "Ask the team", "data_steward", "READ", false, ["hey team", "ask the team", "what's happening with", "what do you know about"], "addressing the whole team OR asking what's happening with a SPECIFIC named person/client/family"],
  ["voice_followup", "Send a follow-up", "ai_isa", "COMMUNICATION", true, ["send a follow up", "follow up with", "send a thank you", "send them a recap"], "asking to SEND a follow-up/thank-you/recap message to a named person"],
  ["start_marketing", "Start marketing for a person", "campaign_orchestrator", "COMMUNICATION", true, ["get marketing going", "push a campaign for", "kick off marketing"], "asking to start/kick off marketing or a campaign for a named person"],
  ["cut_promo", "Cut a listing promo", "asset_manager", "LOW_RISK_WRITE", true, ["promo reel", "cut a promo", "promo video", "video for the new listing"], "asking to create/cut/make a promo video/reel for a LISTING ADDRESS"],
  ["commission_video", "Commission a video", "asset_manager", "LOW_RISK_WRITE", true, ["market update reel", "explainer video", "neighborhood spotlight", "make a video about"], "asking to create an ON-DEMAND video that is NOT a listing promo — market update, CMA/home-value, explainer, neighborhood spotlight, testimonial, anniversary/equity reel"],
  ["studio_session", "Plan a content batch", "asset_manager", "LOW_RISK_WRITE", true, ["week of content", "month of reels", "content calendar", "line up a week"], "asking to BOOK / PLAN a BATCH or CALENDAR of content / reels for a duration"],
  ["optimize_tour", "Optimize a tour", "shopping_agent", "LOW_RISK_WRITE", true, ["optimize the tour", "optimize the route", "fix the route", "sort the showings by drive"], "asking to optimize/fix/re-route a buyer's TOUR by named person"],
  ["closings_at_risk", "Closings at risk", "deal_coordinator", "READ", false, ["closings at risk", "deals at risk", "about to slip", "closings are tight", "deals need attention"], "asking which closings/deals are AT RISK or tight this week"],
  ["send_equity_report", "Send an equity report", "sphere_of_influence", "COMMUNICATION", true, ["equity report", "equity update", "anniversary equity"], "asking to send/run a named person's ANNIVERSARY EQUITY report"],
  ["launch_campaign", "Launch a listing campaign", "campaign_orchestrator", "COMMUNICATION", true, ["launch the campaign", "just listed campaign", "take the campaign live"], "asking to LAUNCH / push / go live with the MARKETING CAMPAIGN for a LISTING ADDRESS"],
  ["query_flight_risk", "Agent flight risk", "recruiting_manager", "READ", false, ["flight risk", "about to leave", "retention risks", "slipping on my team"], "asking which AGENTS are at RETENTION / FLIGHT risk"],
  ["query_vendor_coverage", "Vendor coverage", "data_steward", "READ", false, ["vendor coverage", "vendor gaps", "bench covered", "enough inspectors"], "asking about VENDOR COVERAGE gaps in the bench"],
  ["query_referral_income", "Referral income", "finance_manager", "READ", false, ["referral income", "earned in referrals", "referrals paid me"], "asking about the agent's own AGENT-TO-AGENT referral income"],
  ["draft_save_plays", "Draft retention save-plays", "recruiting_manager", "LOW_RISK_WRITE", true, ["save plays", "draft save plays", "retention outreach"], "COMMANDING the assistant to DRAFT retention SAVE-PLAYS for at-risk agents"],
  ["create_tenant_user", "Create a tenant user (platform)", "data_steward", "LOW_RISK_WRITE", true, ["create a new agent", "invite a tc", "add an admin to", "create a new user"], "a PLATFORM-ADMIN command to CREATE / add / invite a new USER / agent / admin / TC into a brokerage"],
  ["draft_offer", "Draft an offer", "deal_coordinator", "LOW_RISK_WRITE", true, ["draft an offer", "write up an offer", "start an offer"], "asking to DRAFT / prepare an OFFER for a named buyer on a property (a staged draft — signature and submission stay human)"],
  ["draft_listing", "Draft a listing agreement", "listing_concierge", "LOW_RISK_WRITE", true, ["draft a listing agreement", "write up the listing", "start a listing agreement"], "asking to DRAFT / prepare a LISTING AGREEMENT for a named seller/property (a staged draft)"],
]

// ─── The field mic's intents (moved out of app/actions/voice-assistant.ts parseVoiceIntent) ─────────────
// (call_contact was listed in the old prompt and handled by NO case in processVoiceCommand's switch — it
// always fell to "I didn't understand". It is not carried: a route that cannot execute is a promise.)
const FIELD_SEEDS: LegacySeed[] = [
  ["get_schedule", "My schedule", "shopping_agent", "READ", false, ["my schedule", "my calendar today", "what's on my calendar", "appointments today"], "calendar queries — today's appointments"],
  ["add_note", "Add a note", "data_steward", "LOW_RISK_WRITE", true, ["add a note", "make a note", "note for", "add note", "make note"], "add a note to a named contact"],
  ["send_property", "Send a property", "shopping_agent", "COMMUNICATION", true, ["send the listing", "send them the property", "send the property"], "send a listing / property address to a named contact"],
  ["request_document", "Request a document", "deal_coordinator", "COMMUNICATION", true, ["request the pre approval", "ask for the pre approval", "request a document", "request the document", "request the preapproval"], "ask a client for a document"],
  ["assign_vendor", "Assign a vendor", "deal_coordinator", "LOW_RISK_WRITE", true, ["assign my stager", "assign my inspector", "assign the vendor", "introduce my vendor", "link the vendor"], "introduce / link a vendor to a contact"],
  ["log_upgrade", "Log a property upgrade", "listing_concierge", "LOW_RISK_WRITE", true, ["they added a", "log an upgrade", "new roof at", "log the renovation"], "record a property upgrade / renovation on a listing"],
  ["set_portal_milestones", "Show / hide a portal milestone", "deal_coordinator", "LOW_RISK_WRITE", true, ["hide the milestone", "hide the inspection milestone", "show the milestone", "milestone from"], "show / hide a milestone on a client's portal"],
  ["ai_work_receipt", "What did the AI do", "cron_manager", "READ", false, ["what did you do", "what did the ai do", "overnight work", "what did the team do", "daily receipt", "ai report", "while i was out", "while i was asleep"], "the spoken receipt of the AI's own work in the last 24 hours"],
]

/** The entities the field mic's executors read (moved from parseVoiceIntent's "Extract Entities" list). */
const FIELD_PARAMS: Record<string, IntentParamSpec[]> = {
  add_note:              [{ name: "contact_name", required: true, ask: "Who is the note about?" }, { name: "note_text", required: true, ask: "What should the note say?" }],
  send_property:         [{ name: "contact_name", required: true, ask: "Who should I send it to?" }, { name: "property_address", required: true, ask: "Which property — the address?" }],
  request_document:      [{ name: "document_name", required: true, ask: "Which document should I request?" }, { name: "contact_name", required: false, ask: "From whom?" }, { name: "due_date", required: false, ask: "By when?" }],
  assign_vendor:         [{ name: "contact_name", required: true, ask: "Which client is the vendor for?" }, { name: "vendor_name", required: true, ask: "Which vendor?" }, { name: "vendor_role", required: false, ask: "What's their role — stager, inspector, lender?" }],
  log_upgrade:           [{ name: "property_address", required: true, ask: "Which listing is the upgrade for?" }, { name: "note_text", required: true, ask: "What was the upgrade?" }, { name: "amount", required: false, ask: "Roughly what did it cost?" }],
  set_portal_milestones: [{ name: "contact_name", required: true, ask: "Whose portal?" }, { name: "milestone_name", required: true, ask: "Which milestone?" }],
}

// ─── The governed command layer's commands (System 6.1, app/actions/voice-assistant/helpers/command-map.ts) ──
const COMMAND_SEEDS: LegacySeed[] = [
  ["generate_net_sheet", "Net sheet", "finance_manager", "READ", false, ["net sheet", "seller proceeds"], "generate a seller net sheet"],
  ["generate_presentation", "Listing presentation", "listing_concierge", "LOW_RISK_WRITE", true, ["listing presentation", "generate the presentation"], "assemble the listing presentation"],
  ["schedule_appointment", "Listing appointment", "listing_concierge", "LOW_RISK_WRITE", true, ["listing appointment"], "schedule the seller's listing appointment"],
  ["schedule_media", "Schedule media", "asset_manager", "LOW_RISK_WRITE", true, ["schedule media", "schedule photos", "book the photographer"], "schedule listing media capture"],
  ["approve_media", "Approve media", "asset_manager", "LOW_RISK_WRITE", true, ["approve the media", "approve the photos"], "approve listing media"],
  ["activate_coming_soon", "Coming soon", "listing_concierge", "LOW_RISK_WRITE", true, ["coming soon"], "activate coming-soon"],
  ["submit_to_mls", "Submit to MLS", "listing_concierge", "LOW_RISK_WRITE", true, ["submit to mls"], "submit the listing to the MLS (the admin activates)"],
  ["activate_mls", "Activate in MLS", "listing_concierge", "LOW_RISK_WRITE", true, ["activate mls", "activate in mls"], "activate the listing in the MLS"],
  ["approve_open_house_marketing", "Approve open-house marketing", "campaign_orchestrator", "LOW_RISK_WRITE", true, ["approve the open house marketing"], "approve the open-house marketing"],
  ["query_buyer_stage", "Buyer stage", "shopping_agent", "READ", false, ["buyer status", "buyer stage", "buyer progress"], "query a buyer's journey stage"],
  ["configure_buyer_search", "Configure buyer search", "shopping_agent", "LOW_RISK_WRITE", true, ["configure the buyer search", "set up the buyer search"], "configure a buyer's saved search"],
  ["lender_confirm_financials", "Lender confirms financials", "finance_manager", "LOW_RISK_WRITE", true, ["confirm the financials", "lender confirms"], "the lender confirms a buyer's financials (vendor seat only)"],
  ["admin_override_financial_gate", "Override the financing gate", "compliance_officer", "LOW_RISK_WRITE", true, ["override the financing gate", "override the financial gate"], "override a buyer's financing gate (resolveFinancialGateOverrideAuthority decides who may)"],
  ["query_listing_status", "Listing status", "listing_concierge", "READ", false, ["listing status", "what stage is the listing"], "query a listing's lifecycle stage"],
]

/** The entities the command layer resolves itself (resolve-entities.ts: address → listing_id, name → contact_id). */
const COMMAND_ENTITY_PARAMS: IntentParamSpec[] = [
  { name: "address", required: false, ask: "Which property — the address?" },
  { name: "contact_name", required: false, ask: "For which client?" },
]

// ─── The client's floor (MOVED verbatim from lib/portal/client-action-router.ts — wave 148D) ──────────────
// A buyer or seller in their portal is an actor of the one interpreter too. Their deterministic floor
// is kept exactly (the client-actor proof pins it): seller price/listing actions first for a seller,
// a showing needs a showing verb AND a property reference, search verbs open a search, else a question.
// The NAR-2024 routing contract (BBA on the tour, never the search) stays in client-action-router.ts.

export type ClientIntent = "showing_request" | "search_refine" | "seller_action" | "question"

const ADDRESS_HINT = /\b(\d{1,6}\s+\w+|st\b|ave\b|rd\b|ln\b|dr\b|blvd\b|street|avenue|road|lane|drive|court|ct\b|place|pl\b)\b/i
const SHOWING_VERB = /\b(see|tour|showing|show me (the|this)|view|visit|walk ?through|book a (time|tour|showing))\b/i
const SEARCH_VERB = /\b(show me more|more like|similar to|find( me)?|search|listings? (like|near|in)|homes? (like|near|in)|what('?s| is) (available|on the market))\b/i
const SELLER_ACTION = /\b((drop|lower|reduce|change|raise|increase|adjust)\b[^.]{0,24}\bprice\b|\bprice\b[^.]{0,24}\b(to|down|drop|change|reduce)\b|re-?list|withdraw|cancel (my|the) listing|take (it|my home) off)/i

/** Pure deterministic intent classifier (the floor). contactType: 'buyer' | 'seller' | 'both' | null. */
export function classifyClientIntent(message: string, contactType: string | null): ClientIntent {
  const m = (message ?? "").toLowerCase()
  const canSell = contactType === "seller" || contactType === "both"

  // Seller listing/price actions take precedence for a seller's own home.
  if (canSell && SELLER_ACTION.test(m)) return "seller_action"
  // "see 123 Oak this weekend" — a showing needs a showing verb AND a property reference.
  if (SHOWING_VERB.test(m) && ADDRESS_HINT.test(m)) return "showing_request"
  // "show me more like 44 Birch" / "find homes near…" — open search.
  if (SEARCH_VERB.test(m)) return "search_refine"
  return "question"
}

/** The client floor's intents as catalogue routes (search_refine IS property_search — one key per idea). */
const CLIENT_ROUTE_FOR: Record<ClientIntent, string> = {
  showing_request: "client_showing_request",
  search_refine: "property_search",
  seller_action: "client_seller_action",
  question: "client_question",
}

const CLIENT_ROUTES: IntentRoute[] = [
  {
    key: "client_showing_request", family: "client_portal", label: "Request a showing", manager: "shopping_agent", governedBy: null,
    service: "lib/portal/client-action-dispatch.ts (requestShowing — the Buyer Broker Agreement is enforced downstream)",
    feature: "buyer_portal", risk: "LOW_RISK_WRITE", mutates: true, publishes: false, phrases: [], params: [],
    describe: "A buyer in their portal asks to SEE / tour a specific property.", executors: { client_portal: "showing_request" },
  },
  {
    key: "client_seller_action", family: "client_portal", label: "Ask your agent to change the listing", manager: "listing_concierge", governedBy: null,
    service: "lib/portal/client-action-dispatch.ts (proposed through the approval gate — the agent decides)",
    feature: "buyer_portal", risk: "LOW_RISK_WRITE", mutates: true, publishes: false, phrases: [], params: [],
    describe: "A seller in their portal asks to change their price or listing — proposed to the agent, never executed.", executors: { client_portal: "seller_action" },
  },
  {
    key: "client_question", family: "client_portal", label: "Ask a question", manager: "shopping_agent", governedBy: null,
    service: "lib/portal/client-action-dispatch.ts (advisory — answered, no action)",
    feature: "buyer_portal", risk: "READ", mutates: false, publishes: false, phrases: [], params: [],
    describe: "A client in their portal asks a question — answered advisory-only.", executors: { client_portal: "question" },
  },
]

function legacyRoutes(seeds: LegacySeed[], family: IntentFamily, surface: IntentSurface, service: string, params: Record<string, IntentParamSpec[]> = {}): IntentRoute[] {
  return seeds.map(([key, label, manager, risk, mutates, phrases, describe]) => ({
    key, family, label, manager, governedBy: null, service, feature: null, risk, mutates,
    publishes: false, phrases, params: params[key] ?? [], describe, executors: { [surface]: key },
  }))
}

// ─── Kernel routes — DERIVED from the survivor's phrase table (no second list) ───────────────────────────

/** Domain → role feature (FEATURE_FLAGS). Derived per catalogue DOMAIN so a new capability lands gated. */
const DOMAIN_FEATURE: Record<AppDomain, FeatureKey | null> = {
  lead_generation: "lead_management", crm: "crm", valuation: "listing_creation", scheduling: "crm",
  transactions: "transaction_dashboard", listings: "listing_creation", marketing: "campaigns", social: "campaigns",
  reporting: "analytics", education: "crm", portal: "crm", reputation: "campaigns", communications: "crm",
  gifting: "campaigns", connectivity: "admin_dashboard", finance: null, compliance: "compliance_dashboard",
}

function kernelRisk(def: (typeof APP_CAPABILITY_REGISTRY)[AppCapability]): ToolRiskClass {
  if (!def.mutates) return "READ"
  if (def.domain === "finance") return "FINANCIAL"
  if (def.verb === "NOTIFY" || def.verb === "PUBLISH") return "COMMUNICATION"
  return "LOW_RISK_WRITE"
}

function kernelRoutes(): IntentRoute[] {
  return voiceCapabilities().map((vc) => ({
    key: vc.capability, family: "kernel_signal" as const, label: vc.def.purpose.replace(/\.$/, ""), manager: vc.manager,
    governedBy: vc.capability, service: "lib/voice-admin/plan-voice-command.ts:planVoiceCommand (a governed manager signal)",
    feature: DOMAIN_FEATURE[vc.def.domain], risk: kernelRisk(vc.def), mutates: vc.mutates,
    publishes: vc.def.verb === "PUBLISH" || vc.def.verb === "NOTIFY", phrases: vc.phrases, params: [],
    describe: vc.def.purpose, executors: { c17: vc.capability },
  }))
}

// ─── THE CATALOGUE ───────────────────────────────────────────────────────────

/**
 * One intent → one key. Where two classifiers spelled the SAME idea, the duplicate is merged here onto ONE
 * key and the surfaces keep their executors (§6): the field mic's hot_leads / deals_at_risk / lookup_contact
 * / create_task, and the command layer's generate_cma / schedule_showing / schedule_open_house.
 */
const SAME_IDEA: Record<string, { surface: IntentSurface; executor: string; phrases: string[]; params?: IntentParamSpec[] }[]> = {
  query_hot_contacts: [{ surface: "field_assistant", executor: "hot_leads", phrases: ["top leads"] }],
  closings_at_risk:   [{ surface: "field_assistant", executor: "deals_at_risk", phrases: [] }],
  create_task:        [{ surface: "field_assistant", executor: "create_task", phrases: [], params: [{ name: "task_title", required: false, ask: "What's the task?" }, { name: "due_date", required: false, ask: "When is it due?" }, { name: "contact_name", required: false, ask: "Who is it about?" }] }],
  contact_get:        [{ surface: "field_assistant", executor: "lookup_contact", phrases: [], params: [{ name: "contact_name", required: false, ask: "Who should I look up?" }] }],
  cma_generate:       [{ surface: "command_layer", executor: "generate_cma", phrases: ["generate cma", "create cma", "make cma", "generate a cma"] }],
  // (the command layer's schedule_showing is in its authority matrix but NOT in COMMAND_MAP — no executor —
  //  so only its spoken phrases join the kernel's appointment route; a route that cannot run is a promise.)
  appointment_schedule: [{ surface: "c17", executor: "appointment_schedule", phrases: ["schedule showing", "book showing", "book a showing"] }],
  property_search:    [{ surface: "client_portal", executor: "search_refine", phrases: [] }],
}

let CATALOGUE_CACHE: IntentRoute[] | null = null

/** PURE: the whole intent catalogue — every intent the OS answers, from any surface. */
export function intentCatalogue(): IntentRoute[] {
  if (CATALOGUE_CACHE) return CATALOGUE_CACHE
  const routes: IntentRoute[] = [
    ...DOMAIN_ROUTES,
    ...CLIENT_ROUTES,
    ...kernelRoutes(),
    ...legacyRoutes(BRAIN_SEEDS, "team_brain", "team_brain", "app/api/internal/voice-command/route.ts (the team brain's executor for this intent)"),
    ...legacyRoutes(FIELD_SEEDS, "field_assistant", "field_assistant", "app/actions/voice-assistant.ts:processVoiceCommand (the field mic's executor)", FIELD_PARAMS),
    ...legacyRoutes(COMMAND_SEEDS, "command_layer", "command_layer", "app/actions/voice-assistant/handle-voice-command.ts (COMMAND_EXECUTORS behind validateAuthority + validateReadiness)",
      Object.fromEntries(COMMAND_SEEDS.map(([key]) => [key, COMMAND_ENTITY_PARAMS]))),
  ]
  for (const [key, extra] of Object.entries(SAME_IDEA)) {
    const r = routes.find((x) => x.key === key)
    if (!r) continue
    for (const e of extra) {
      r.executors = { ...r.executors, [e.surface]: e.executor }
      r.phrases = [...r.phrases, ...e.phrases]
      if (e.params) r.params = [...r.params, ...e.params.filter((p) => !r.params.some((q) => q.name === p.name))]
    }
  }
  CATALOGUE_CACHE = routes
  return routes
}

export function intentRoute(key: string | null | undefined): IntentRoute | null {
  if (!key) return null
  return intentCatalogue().find((r) => r.key === key) ?? null
}

// ─── Text helpers ────────────────────────────────────────────────────────────

function norm(s: string): string {
  return ` ${(s ?? "").toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9$'\s]/g, " ").replace(/\s+/g, " ").trim()} `
}

const ADDRESS_RE = /\b(\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s){0,4}?(?:street|st|avenue|ave|road|rd|lane|ln|drive|dr|court|ct|way|boulevard|blvd|place|pl|circle|cir|trail|trl|parkway|pkwy|terrace|ter)\b\.?)/i
const LATEST_LISTING_RE = /\b(my|our|the)\s+(new|newest|latest|most recent|just listed)\s+listing\b|\bthis listing\b|\bmy listing\b/i
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"] as const

function isoDay(d: Date): string { return d.toISOString().slice(0, 10) }

// ONE SPELLING (§6): a spoken day and a spoken time are resolved by the voice lane's survivors
// (lib/voice/spoken-values.ts resolveSpokenDate / resolveSpokenTime — already used by parse-team-command,
// the showing request and the callback task). Only a day / time the person SAID; null otherwise (asked).
function spokenDate(text: string, now: Date): string | null {
  return resolveSpokenDate(text, isoDay(now))
}

/** "from 1 to 3 pm" / "1-3pm" / "at 11am until 1pm" → the two times SAID (the end's am/pm carries to a bare
 *  start), each resolved by resolveSpokenTime. Never reads a house number as a time: only a range or "at …". */
function spokenTimeRange(text: string): { start: string | null; end: string | null } {
  const range = text.match(/\b(\d{1,2}(?::\d{2})?)\s*(am|pm|a\.m\.|p\.m\.)?\s*(?:-|–|to|until|till)\s*(\d{1,2}(?::\d{2})?)\s*(am|pm|a\.m\.|p\.m\.)/i)
  if (range) {
    const endMeridiem = range[4]
    return { start: resolveSpokenTime(`${range[1]} ${range[2] ?? endMeridiem}`), end: resolveSpokenTime(`${range[3]} ${endMeridiem}`) }
  }
  const single = text.match(/\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.))/i)
  return { start: single ? resolveSpokenTime(single[1]) : null, end: null }
}
function afterPhrase(text: string, re: RegExp): string | null {
  const m = text.match(re)
  if (!m) return null
  const v = (m[m.length - 1] ?? "").replace(/[?.!,;]+$/g, "").trim()
  return v.length >= 2 ? v.slice(0, 120) : null
}

// ─── Param extraction (rules) — only what the person SAID ────────────────────

export interface ScreenContext {
  /** A contact the page is about (PageContextAssistant / the contact page) — verified at execution. */
  contactId?: string | null
  /** A listing the page is about — verified at execution. */
  listingId?: string | null
}

type Params = Record<string, string | null>

/** PURE: the rules' params for a route. Never fills a value the utterance and screen do not hold. */
function extractRouteParams(route: IntentRoute, utterance: string, ctx: { now: Date; screen?: ScreenContext; actor: IntentActor }): Params {
  const p: Params = {}
  const u = utterance ?? ""
  const screen = ctx.screen ?? {}
  switch (route.key) {
    case "listing_ad_draft": {
      const addr = u.match(ADDRESS_RE)?.[1] ?? null
      p.listing = addr ? `address:${addr.trim()}` : screen.listingId ? `id:${screen.listingId}` : LATEST_LISTING_RE.test(u) ? "latest" : null
      p.kind = /\bjust sold\b|\bsold\b/i.test(u) ? "just_sold" : /\bprice\s+(reduction|improvement|drop|cut|change)\b|\breduced\b/i.test(u) ? "price_reduction" : "just_listed"
      p.audience = afterPhrase(u, /\b(?:targeting|aimed at|to reach|reaching)\s+(.+?)(?=\s+(?:on|in|with|to get|for more)\b|[.?!,]|$)/i)
      p.outcome = afterPhrase(u, /\b(?:to get|for more|to drive|to generate|so we get)\s+(.+?)(?=\s+(?:on|targeting)\b|[.?!,]|$)/i)
      p.platform = u.match(/\b(facebook|instagram|google|linkedin|tiktok)\b/i)?.[1]?.toLowerCase() ?? null
      break
    }
    case "buyer_interest_search": {
      p.interest = afterPhrase(u, /\b(?:interested in|looking for|who want|wanting|that want|searching for|asking for)\s+(?:a |an |the |some )?(.+?)(?=[.?!,]|$)/i)
      break
    }
    case "market_blog_draft": {
      p.topic = afterPhrase(u, /\b(?:blog|post|article)\s+(?:post\s+)?(?:on|about|covering)\s+(.+?)(?=\s+in\s+[A-Z]|[.?!]|$)/)
        ?? afterPhrase(u, /\b(?:blog|post|article)\s+(?:post\s+)?(?:on|about|covering)\s+(.+?)(?=[.?!]|$)/i)
      p.area = u.match(/\bin\s+((?:[A-Z][a-zA-Z'-]+)(?:\s+[A-Z][a-zA-Z'-]+){0,2})\b/)?.[1] ?? u.match(/\b(\d{5})\b/)?.[1] ?? null
      const lower = u.toLowerCase()
      p.period = /\bthis month\b|\bmonth's\b|\bmonthly\b/.test(lower)
        ? `${MONTHS[ctx.now.getUTCMonth()].replace(/^./, (c) => c.toUpperCase())} ${ctx.now.getUTCFullYear()}`
        : /\bthis quarter\b|\bquarter's\b/.test(lower) ? `Q${Math.floor(ctx.now.getUTCMonth() / 3) + 1} ${ctx.now.getUTCFullYear()}` : null
      p.audience = afterPhrase(u, /\bfor\s+(buyers|sellers|investors|first[- ]time buyers|homeowners)\b/i)
      break
    }
    case "property_search": {
      const rules = extractCriteriaFromTranscript(u)
      const life = extractLifestyleAsks(u)
      const c = rules.criteria
      const parts = [
        ...(c.features ?? []), ...(c.cities ?? []), ...(c.zipCodes ?? []),
        c.maxPrice ? `under $${Math.round(c.maxPrice / 1000)}k` : null, c.minBeds ? `${c.minBeds}+ beds` : null,
        ...life.map((a) => a.label),
      ].filter(Boolean) as string[]
      p.criteria = parts.length ? [...new Set(parts)].join(", ") : null
      const commute = life.find((a) => a.kind === "commute")
      p.commute_destination = commute ? (commute.target ?? null) : "n/a"
      if (ctx.actor.contactId && (ctx.actor.userType ?? "").toLowerCase() === "contact") p.buyer = `id:${ctx.actor.contactId}`
      else if (screen.contactId) p.buyer = `id:${screen.contactId}`
      else p.buyer = afterPhrase(u, /\bfor\s+(?:the\s+)?([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)?)\b/) ? `name:${afterPhrase(u, /\bfor\s+(?:the\s+)?([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)?)\b/)}` : null
      break
    }
    case "open_house_schedule": {
      const addr = u.match(ADDRESS_RE)?.[1] ?? null
      p.listing = addr ? `address:${addr.trim()}` : screen.listingId ? `id:${screen.listingId}` : LATEST_LISTING_RE.test(u) ? "latest" : null
      p.kind = /\bvirtual|online|zoom|livestream|live stream\b/i.test(u) ? "virtual_open_house" : /\bbroker'?s?\s+open\b/i.test(u) ? "broker_open" : "open_house"
      p.date = spokenDate(u, ctx.now)
      const t = spokenTimeRange(u)
      p.start_time = t.start
      p.end_time = t.end
      p.join_url = u.match(/\bhttps:\/\/[^\s]+/i)?.[0] ?? null
      break
    }
    case "contact_get": {
      p.contact_name = afterPhrase(u, /\b(?:look up|pull up the contact|pull up|who is|tell me about)\s+(?:the\s+)?(.+?)(?=[.?!,]|$)/i)
      break
    }
    default:
      if (route.executors.command_layer) {
        p.address = u.match(ADDRESS_RE)?.[1]?.trim() ?? null
        p.contact_name = afterPhrase(u, /\bfor\s+(?:the\s+)?([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)?)\b/)
      }
      break
  }
  return p
}

/** PURE: the missing required information, in the order it is asked. A conditional requirement is
 *  decided by the route (a virtual open house needs its join link; a commute needs its destination). */
function missingParams(route: IntentRoute, params: Params): Array<{ param: string; ask: string }> {
  const out: Array<{ param: string; ask: string }> = []
  for (const spec of route.params) {
    const v = params[spec.name]
    let required = spec.required
    if (route.key === "open_house_schedule" && spec.name === "join_url") required = params.kind === "virtual_open_house"
    if (route.key === "property_search" && spec.name === "commute_destination") required = v === null
    if (required && (v === null || v === undefined || v === "")) out.push({ param: spec.name, ask: spec.ask })
  }
  return out
}

// ─── Actor, authority ────────────────────────────────────────────────────────

export interface IntentActor {
  /** users.id (never agents.id — the two spaces are disjoint, CLAUDE.md §3). */
  userId: string
  userType: string | null
  platformRole: string | null
  /** agents.id resolved from agents.user_id, when the actor has an agent row. */
  agentId: string | null
  /** The contact the actor IS (a buyer signed into their portal). */
  contactId?: string | null
  /** That contact's type (buyer · seller · both) — the client floor's seller gate reads it. */
  contactType?: string | null
}

export interface IntentTenant {
  /** The SESSION's tenant — never a request body (CLAUDE.md §4). */
  brokerageId: string
}

export type AuthorityOutcome =
  | "allowed"               // reads run; writes still need confirmation (below)
  | "surface_gates"         // a legacy surface's OWN authority matrix decides (named)
  | "refused_role"          // the actor's role may not do this
  | "refused_never_spoken"  // money / the books / a deal's legal stage — never from a sentence
  | "refused_risk"          // FINANCIAL / LEGAL / IRREVERSIBLE — starts from a card, never a sentence
  | "not_operable"          // the capability's provider is not connected for this tenant

export interface AuthorityCheck {
  outcome: AuthorityOutcome
  allowed: boolean
  role: CanonicalRole | null
  /** Whose rows a read may return (RoleManager.getDataScope): own · team · brokerage · all · self. */
  dataScope: "own" | "team" | "brokerage" | "all" | "self"
  confirmationRequired: boolean
  /** Anything that publishes waits for the tenant's approver (C5 approval authority / approval queues). */
  approvalRequired: boolean
  reasons: string[]
}

const PLATFORM_ROLES = new Set(["superadmin", "admin", "support", "marketing", "platform_admin"])

/** PURE: the actor's canonical role (platform staff read from platform_role — CLAUDE.md §4). */
export function actorRole(actor: IntentActor): CanonicalRole | null {
  if (actor.platformRole && PLATFORM_ROLES.has(actor.platformRole)) return "superadmin"
  return toCanonicalRole(actor.userType)
}

/**
 * PURE: may THIS actor have THIS route, and on what terms. The order is the kernel lane's
 * (kernel-command-surface.ts buildVoicePlan): authority → operability → (missing info, outside) →
 * confirmation → approval. Never-spoken and the risk ceiling are the assistant's ONE rule
 * (assistant-reach.ts assistantSkillRefusal), not a copy of it.
 */
export function checkIntentAuthority(route: IntentRoute, actor: IntentActor, opts: { operable?: boolean | null; blockReason?: string | null } = {}): AuthorityCheck {
  const role = actorRole(actor)
  const base = {
    role,
    dataScope: (role === "contact" ? "self" : role ? RoleManager.getDataScope(role) : "own") as AuthorityCheck["dataScope"],
    confirmationRequired: route.mutates,
    approvalRequired: route.publishes,
  }
  const refuse = (outcome: AuthorityOutcome, reason: string): AuthorityCheck => ({ ...base, outcome, allowed: false, confirmationRequired: false, approvalRequired: false, reasons: [reason] })

  if (route.governedBy && (VOICE_NEVER_SPOKEN as readonly string[]).includes(route.governedBy)) {
    return refuse("refused_never_spoken", "That moves money, writes the books or changes a deal's legal stage — it starts from its own screen, never from a sentence.")
  }
  const riskRefusal = assistantSkillRefusal({ risk_class: route.risk, required_capabilities: route.governedBy ? [route.governedBy] : [] })
  if (riskRefusal) return refuse("refused_risk", `I can't start that from a request — ${riskRefusal}.`)
  if (!role) return refuse("refused_role", "I couldn't verify your role, so I won't start anything (fail closed).")
  if (role === "contact" && route.key !== "property_search" && route.family !== "client_portal") {
    return refuse("refused_role", "From your portal I can search homes, request a showing or pass a request to your agent; everything else goes through your agent.")
  }
  if (role !== "contact" && route.family === "client_portal") {
    return refuse("refused_role", "That is the client's own portal request.")
  }
  if (route.feature === null) {
    if (role === "contact") return refuse("refused_role", "That is a staff command.")
    return { ...base, outcome: "surface_gates", allowed: true, reasons: [`${route.service.split(" ")[0]} applies its own authority matrix before it acts.`] }
  }
  const admitted = role === "superadmin" || (FEATURE_FLAGS[route.feature] ?? []).includes(role)
  if (!admitted) return refuse("refused_role", `Your role (${role.replace(/_/g, " ")}) doesn't include ${route.label.toLowerCase()} — ask your broker if you need it.`)
  if (opts.operable === false) {
    return { ...base, outcome: "not_operable", allowed: false, confirmationRequired: false, approvalRequired: false, reasons: [opts.blockReason ? `I can't do that yet — ${opts.blockReason}` : "I can't do that yet: the provider it needs is not connected."] }
  }
  const reasons: string[] = []
  if (route.mutates) reasons.push("It changes something, so it waits for your yes.")
  if (route.publishes) reasons.push("Anything it produces for the public waits for your brokerage's approver before it goes out.")
  if (base.dataScope === "own") reasons.push("You'll see your own contacts and listings only.")
  return { ...base, outcome: "allowed", allowed: true, reasons }
}

// ─── Compliance boundary: ad audiences only (fair housing on public copy and ad audiences — owner) ──────

/** PURE: a spoken ad audience that names a protected characteristic is DROPPED (the ad still drafts on
 *  location targeting) with the reason. Uses the two existing gates — the protected-class token gate and
 *  the fair-housing phrase list — never a third list (§6). Needs-based audiences pass. */
function screenAdAudience(audience: string | null): { audience: string | null; refusedReason: string | null } {
  if (!audience) return { audience: null, refusedReason: null }
  const tokenReason = protectedClassReasonFor(audience)
  const phrases = detectFairHousingViolations(audience)
  if (tokenReason || phrases.length > 0) {
    return {
      audience: null,
      refusedReason: `I left out the audience "${audience}" — an ad can't be aimed at a protected characteristic (Fair Housing Act § 3604). Describe what they need instead: first-time buyers, relocating, downsizing, investors.`,
    }
  }
  return { audience, refusedReason: null }
}

// ─── The plan ────────────────────────────────────────────────────────────────

export interface IntentPlan {
  /** One sentence the assistant SAYS. */
  summary: string
  /** The steps it will take, in order — what a human reads before saying yes. */
  steps: string[]
  willChange: boolean
  needsConfirmation: boolean
  approval: string | null
  /** The surface that executes it: c17 (this module's executor) or a legacy surface's door. */
  executor: IntentSurface | null
  managerSpoken: string
}

function listingWords(v: string | null): string {
  if (!v) return "the listing"
  if (v === "latest") return "your newest listing"
  if (v.startsWith("address:")) return v.slice(8)
  return "this listing"
}

/** PURE: what will happen, in words. */
function explainPlan(route: IntentRoute, params: Params, authority: AuthorityCheck, missing: Array<{ param: string; ask: string }>): IntentPlan {
  const who = humanManager(route.manager)
  const executor: IntentSurface | null = (route.executors.c17 ? "c17" : (Object.keys(route.executors)[0] as IntentSurface | undefined)) ?? null
  let steps: string[]
  switch (route.key) {
    case "listing_ad_draft":
      steps = [
        `Read the facts of ${listingWords(params.listing)} (price, beds, baths, city) from the listing record — nothing invented.`,
        `Draft a ${params.kind === "just_sold" ? "just-sold" : params.kind === "price_reduction" ? "price-improvement" : "just-listed"} ad in your brand voice${params.outcome ? `, built to ${params.outcome}` : ""}${params.platform ? ` for ${params.platform}` : ""}, fair-housing clean by construction, with your approved media.`,
        params.audience ? `Aim it at ${params.audience} (needs-based) around the listing's location.` : "Target the listing's area (location only — never a protected characteristic).",
        "Put the creative in the ad approval queue: no spend and nothing runs until your approver says yes.",
      ]
      break
    case "buyer_interest_search":
      steps = [
        `Read saved buyer criteria for "${params.interest ?? "…"}" — only what the buyers said themselves (C10 store).`,
        authority.dataScope === "own" ? "Limit it to your own contacts." : "Across the brokerage's buyer contacts you can see.",
        "List them with the words they used, so you know why each one matched.",
      ]
      break
    case "market_blog_draft":
      steps = [
        `Pull VERIFIED market data for ${params.area ?? "your farm territory / brokerage market"}${params.period ? ` (${params.period})` : ""} — sourced and dated; a number with no source is left out, never guessed.`,
        `Write the post on "${params.topic ?? "…"}"${params.audience ? ` for ${params.audience}` : ""} in your brand voice, fair-housing checked in the prompt and after.`,
        "Save it as a draft for your approver — it publishes only after approval.",
      ]
      break
    case "property_search":
      steps = [
        `Search for ${params.buyer?.startsWith("name:") ? params.buyer.slice(5) : "this buyer"}: ${params.criteria ?? "…"}${params.commute_destination && params.commute_destination !== "n/a" ? `, commute to ${params.commute_destination}` : ""}.`,
        "Fill the gaps from what they told us before (their saved criteria), labelled 'you said'.",
        "Show in-house listings and outside sources, each labelled for what it is.",
      ]
      break
    case "open_house_schedule":
      steps = [
        `Schedule a ${params.kind === "virtual_open_house" ? "virtual open house" : params.kind === "broker_open" ? "broker open" : "open house"} at ${listingWords(params.listing)}${params.date ? ` on ${params.date}` : ""}${params.start_time ? ` from ${params.start_time}` : ""}${params.end_time ? ` to ${params.end_time}` : ""}.`,
        params.kind === "virtual_open_house" ? "Attendance is recorded when an invited guest joins through the event's join door — an anonymous click is not attendance." : "Visitors sign in at the kiosk with the consent form.",
        "Invitations and promotion wait for your approval.",
      ]
      break
    case "contact_care_scan":
      steps = [
        "Rank your contacts by relationship health — long silence, no replies, cooling engagement.",
        "Show who may need help first, with the reason in plain words — contacts only, never leads.",
        "Nothing is sent; you decide how to reach out.",
      ]
      break
    default:
      steps = [`${who.replace(/^your /, "Your ")} takes it: ${route.label.toLowerCase()}.`]
  }
  const needsConfirmation = authority.allowed && missing.length === 0 && authority.confirmationRequired
  let summary: string
  if (!authority.allowed) summary = authority.reasons[0] ?? "I can't do that from here."
  else if (missing.length > 0) summary = missing[0].ask
  else if (needsConfirmation) summary = `${route.label}: ${steps[0]} Say yes and ${who} will take it.`
  else summary = `${who.replace(/^your /, "Your ")} is on it — ${route.label.toLowerCase()}.`
  return {
    summary, steps, willChange: route.mutates, needsConfirmation,
    approval: route.publishes ? "Your brokerage's approver approves it before anything is published." : null,
    executor, managerSpoken: who,
  }
}

// ─── Matching ────────────────────────────────────────────────────────────────

export interface RouteMatch { route: IntentRoute; phrase: string; score: number }

/** PURE: every route the utterance names, most specific first (longest phrase; a screen's bias breaks
 *  ties). Substring-on-normalised-text, like the survivor's matchIntents: it misses a paraphrase (the
 *  model assist or the speaker recovers) and never invents an intent from an unrelated sentence. */
export function matchRoutes(utterance: string, screen?: IntentScreen | null): RouteMatch[] {
  const text = norm(utterance)
  if (text.trim().length === 0) return []
  const bias = new Set<string>(screen ? INTENT_SCREENS[screen].bias : [])
  const hits = new Map<string, RouteMatch>()
  for (const route of intentCatalogue()) {
    for (const raw of route.phrases) {
      const phrase = raw.toLowerCase().trim()
      if (!phrase) continue
      if (!text.includes(` ${phrase} `) && !text.includes(` ${phrase}`)) continue
      const score = phrase.length + (bias.has(route.key) ? 0.5 : 0)
      const prev = hits.get(route.key)
      if (!prev || prev.score < score) hits.set(route.key, { route, phrase, score })
    }
  }
  return [...hits.values()].sort((a, b) => b.score - a.score)
}

// ─── C17: interpretIntent ────────────────────────────────────────────────────

export interface InterpretIntentInput {
  utterance: string
  modality: IntentModality
  actor: IntentActor
  tenant: IntentTenant
  screen?: IntentScreen | null
  context?: ScreenContext
  now?: Date
  /** Live operability for the governing capability (resolveAllAppCapabilities) — absent = not checked. */
  operable?: Partial<Record<AppCapability, boolean>>
  blockReason?: Partial<Record<AppCapability, string>>
  /** Params the caller already holds (a model assist, a prior clarification turn). Rules win on conflict. */
  extraParams?: Params
  /** Force a route (the model's pick, re-checked here against the catalogue). */
  routeKey?: string | null
}

export interface IntentInterpretation {
  utterance: string
  modality: IntentModality
  screen: IntentScreen | null
  /** The intent route key — the ONE vocabulary (null = nothing the OS can act on was heard). */
  capability: string | null
  governedBy: AppCapability | null
  family: IntentFamily | null
  manager: ManagerKey | null
  params: Params
  missing: Array<{ param: string; ask: string }>
  /** The question to ask next (the first missing item), or null. Never a guess. */
  clarification: string | null
  plan: IntentPlan
  authority_check: AuthorityCheck
  executors: Partial<Record<IntentSurface, string>>
  confidence: "high" | "medium" | "low"
  via: "rules" | "model" | "rules+model" | "none"
  /** Other routes the sentence also named — offered, never run silently. */
  alternatives: string[]
  /** Compliance notes (an ad audience dropped, …) — said, never swallowed. */
  notes: string[]
  /**
   * WAVE 148 (148Z — lane 148D Still open 1): THE TEAM-COMMAND FLOOR, PICKED HERE. When the sentence is not a domain
   * capability, the team dispatcher's own command (offer verbs, manager status, run_skill, the broker verbs, stand-up …) is
   * named by THIS module through the deterministic floor (lib/voice/parse-team-command.ts parseTeamCommandText), and the two
   * surfaces that execute it (the Command Center bar, the spoken admin's run_team_command) read it from here — they no
   * longer pick commands themselves. Null for a domain route, for a client in their portal, and when nothing matched.
   * Executed by dispatchTeamCommand under its own gates (unchanged).
   */
  teamCommand: ParsedTeamCommand | null
}

/** PURE. The team-command floor, asked only when no DOMAIN route owns the sentence (and never for a client actor). */
function teamCommandFloor(utterance: string, top: IntentRoute | null, role: CanonicalRole | null): ParsedTeamCommand | null {
  if (role === "contact" || top?.family === "domain") return null
  return parseTeamCommandText(utterance)
}

const NONE_PLAN: IntentPlan = {
  summary: "I didn't catch something I can act on. Try saying what you want done — \"create an ad for 12 Oak Street\", \"find buyers interested in acreage\", \"who may need help?\"",
  steps: [], willChange: false, needsConfirmation: false, approval: null, executor: null, managerSpoken: "",
}

/** PURE: C17's deterministic interpretation. The live module adds the model assist on a miss. */
export function interpretIntent(input: InterpretIntentInput): IntentInterpretation {
  const now = input.now ?? new Date()
  const screen = input.screen && isIntentScreen(input.screen) ? input.screen : null
  const role = actorRole(input.actor)
  // A client in their portal is routed by the client floor (moved here — one interpreter for every actor).
  const clientKey = role === "contact" && !input.routeKey ? CLIENT_ROUTE_FOR[classifyClientIntent(input.utterance, input.actor.contactType ?? null)] : null
  const matches = clientKey ? [] : matchRoutes(input.utterance, screen)
  const forced = intentRoute(input.routeKey)
  const top = forced ?? intentRoute(clientKey) ?? matches[0]?.route ?? null
  if (!top) {
    return {
      utterance: input.utterance, modality: input.modality, screen, capability: null, governedBy: null, family: null, manager: null,
      params: {}, missing: [], clarification: null, plan: NONE_PLAN,
      authority_check: { outcome: "allowed", allowed: false, role, dataScope: "own", confirmationRequired: false, approvalRequired: false, reasons: [] },
      executors: {}, confidence: "low", via: "none", alternatives: [], notes: [],
      teamCommand: teamCommandFloor(input.utterance, null, role),
    }
  }
  const rulesParams = extractRouteParams(top, input.utterance, { now, screen: input.context, actor: input.actor })
  const params: Params = { ...(input.extraParams ?? {}) }
  for (const [k, v] of Object.entries(rulesParams)) if (v !== null && v !== undefined) params[k] = v
  for (const spec of top.params) if (!(spec.name in params)) params[spec.name] = null

  const notes: string[] = []
  if (top.key === "listing_ad_draft") {
    const screened = screenAdAudience(params.audience ?? null)
    params.audience = screened.audience
    if (screened.refusedReason) notes.push(screened.refusedReason)
  }
  const operable = top.governedBy ? input.operable?.[top.governedBy] : undefined
  const authority = checkIntentAuthority(top, input.actor, { operable: operable ?? null, blockReason: top.governedBy ? input.blockReason?.[top.governedBy] ?? null : null })
  const missing = authority.allowed ? missingParams(top, params) : []
  const plan = explainPlan(top, params, authority, missing)
  const second = matches.find((m) => m.route.key !== top.key)
  const confidence: IntentInterpretation["confidence"] = forced ? "medium" : !second || (matches[0].score - second.score) >= 4 ? "high" : "medium"
  return {
    utterance: input.utterance, modality: input.modality, screen,
    capability: top.key, governedBy: top.governedBy, family: top.family, manager: top.manager,
    params, missing, clarification: missing[0]?.ask ?? null, plan, authority_check: authority,
    executors: top.executors, confidence, via: forced ? "model" : "rules",
    alternatives: matches.filter((m) => m.route.key !== top.key).slice(0, 3).map((m) => m.route.key),
    notes,
    teamCommand: teamCommandFloor(input.utterance, top, role),
  }
}

// ─── Re-checking the model (pure — the live module calls it on every model answer) ─────

/** The model's typed answer (the zod schema lives beside the call, in intent-interface-live.ts). */
export interface ModelIntentPick {
  route: string
  params: Array<{ name: string; value: string }>
  confidence: "high" | "medium" | "low"
  needs_human: boolean
  reason: string
}

const NORMALISED_PARAMS = new Set(["date", "start_time", "end_time", "period"])

/**
 * PURE: keep only what the model may contribute. A route not in the catalogue is dropped; a param the
 * route does not declare is dropped; a value the person's words do not contain is dropped (dates / times
 * are RE-DERIVED from the utterance, never taken from the model); needs_human is a refusal, never a route.
 */
export function recheckModelPick(pick: ModelIntentPick, utterance: string, now: Date): { routeKey: string | null; params: Params; notes: string[] } {
  const notes: string[] = []
  if (pick.needs_human) return { routeKey: null, params: {}, notes: ["That needs a person — it starts from its own screen, never from a sentence."] }
  const route = intentRoute(pick.route)
  if (!route) return { routeKey: null, params: {}, notes: pick.route && pick.route !== "none" ? [`The model named "${pick.route}", which is not a route — ignored.`] : [] }
  const lower = utterance.toLowerCase()
  const declared = new Set(route.params.map((p) => p.name))
  const params: Params = {}
  for (const { name, value } of pick.params ?? []) {
    if (!declared.has(name) || NORMALISED_PARAMS.has(name)) continue
    const v = String(value ?? "").trim()
    if (!v || !lower.includes(v.toLowerCase())) { if (v) notes.push(`Dropped ${name} "${v}" — not in what was said.`); continue }
    params[name] = v
  }
  if (declared.has("date")) params.date = spokenDate(utterance, now)
  if (declared.has("start_time") || declared.has("end_time")) {
    const t = spokenTimeRange(utterance)
    params.start_time = t.start
    params.end_time = t.end
  }
  return { routeKey: route.key, params, notes }
}

// ─── Matching a buyer's SAID criteria to an interest (pure — buyer_interest_search) ─────

/** PURE: the word stem a buyer's own criteria are matched on ("acreage" → "acre", "pools" → "pool"). */
export function interestStem(interest: string): string | null {
  const word = (interest ?? "").toLowerCase().replace(/^(a|an|the|some|more)\s+/, "").split(/[^a-z0-9]+/).filter((w) => w.length >= 3)[0]
  if (!word) return null
  const stem = word.replace(/(age|ing|es|s)$/, "")
  return stem.length >= 3 ? stem : word
}

/** PURE: does one buyer's SAID criteria mention the interest — and not as a deal-breaker? Returns their words. */
export function criteriaMentions(row: { features?: unknown; types?: unknown; cities?: unknown; dealBreakers?: unknown; lifestyle?: unknown }, stem: string): string | null {
  const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
  if (strings(row.dealBreakers).some((d) => d.toLowerCase().includes(stem))) return null
  const said = [...strings(row.features), ...strings(row.types), ...strings(row.cities)]
  const life = Array.isArray(row.lifestyle) ? (row.lifestyle as Array<{ label?: unknown; evidence?: unknown }>).flatMap((a) => [a?.label, a?.evidence]).filter((x): x is string => typeof x === "string") : []
  return [...said, ...life].find((s) => s.toLowerCase().includes(stem)) ?? null
}

// ─── THE ONE PROMPT (model assist — consumed by intent-interface-live.ts) ─────

/**
 * The expert prompt (preamble standard, wave 148): role and mandate, the tenant and the person it serves,
 * the facts it may rely on and may never invent, the decision it owns, a typed output contract, the
 * compliance boundary (fair housing on public copy and ad audiences only), the escalation rule. Its output
 * is RE-CHECKED in code (intent-interface-live.ts recheckModelPick): a route not in the catalogue is
 * dropped, a param value the person did not say is dropped, and missing information is ASKED.
 */
export function intentSystemPrompt(input: { brandName: string | null; role: CanonicalRole | null; screen: IntentScreen | null; modality: IntentModality }): string {
  const catalogue = intentCatalogue()
    .map((r) => `- ${r.key}: ${r.describe}${r.params.length ? ` [params: ${r.params.map((p) => `${p.name}${p.required ? "*" : ""}`).join(", ")}]` : ""}`)
    .join("\n")
  return [
    `ROLE AND MANDATE: You are the chief of staff of ${input.brandName ?? "this real-estate brokerage"}'s operating system — one command center with an expert manager for every area (an inside-sales ISA, a buyer agent, a listing concierge, a transaction coordinator, a campaign manager, an ads manager, an asset manager, a sphere manager, finance, compliance, recruiting, a data steward). A licensed agent, broker or staff member has just ${input.modality === "voice" ? "SPOKEN" : "typed"} a request on the ${input.screen ? INTENT_SCREENS[input.screen].label : "assistant"} screen. Your job is to understand exactly what they want done and hand it to the right specialist, the way a brilliant, unflappable chief of staff would — quickly, precisely, never inventing.`,
    `THE PERSON: their role is ${input.role ? input.role.replace(/_/g, " ") : "unknown"}. They are busy (often driving or between showings), they speak naturally, and they expect you to know the business. The brokerage's clients are people at an important moment of their lives; everything the team does is a reflection of this agent's business. Be kind, neighbourly and exact.`,
    "WHAT YOU MAY RELY ON: only the request between the triple quotes, the screen name, and the catalogue below. Nothing else exists for this task.",
    "WHAT YOU MUST NEVER INVENT: a name, an address, a listing, a date, a time, a price, a link, an audience or an outcome the person did not say. A param value must be copied from their words (dates and times may be normalised: \"Saturday\", \"1 to 3 pm\"). If a required param (marked *) was not said, leave it out — the application will ASK; a missing field is fine, a guessed one is a defect.",
    "THE DECISION YOU OWN: choosing ONE route key from the catalogue (or \"none\") and extracting the params they said. You do not execute anything, you do not answer the request, and you never decide whether they are allowed — the application's authority rails decide that after you.",
    `CATALOGUE (route: what it is for [params, * = required]):\n${catalogue}`,
    "COMPLIANCE BOUNDARY: fair housing applies to PUBLIC MARKETING COPY and AD AUDIENCES. For an ad, an audience is captured only as needs (first-time buyers, relocating, downsizing, investors) — if they describe an audience by race, colour, religion, sex, disability, familial status (children, families with kids), national origin, age or any protected characteristic, leave the audience param empty. Buyer search criteria are the buyer's own stated wishes and are captured as said; never infer household, age or demographics.",
    "ESCALATION: anything that moves money, writes the books, changes a deal's legal stage, signs, or submits a contract is route \"none\" with needs_human true — those start from their own screen with a human. If two routes fit equally, pick the more specific one and set confidence \"medium\". If nothing fits, route \"none\" with confidence \"low\".",
    "OUTPUT CONTRACT: JSON matching the schema exactly — { route, params: [{ name, value }], confidence: high|medium|low, needs_human, reason }. `reason` is one short sentence a human could read.",
  ].join("\n\n")
}
