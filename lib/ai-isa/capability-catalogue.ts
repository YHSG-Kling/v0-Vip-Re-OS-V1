/**
 * lib/ai-isa/capability-catalogue.ts
 *
 * Lane 75B — owner verbatim (wave 75): "if a brand wants to create a
 * specific tool that should be an option with all of the different
 * capabilities that we have built in this agentic saas os using autonomous
 * ai or we should include a selection of more capabilities like sending a
 * newsletter or market report or maybe even an explainer video of the
 * selling or buying process etc. I think those tools are better suited than
 * random batchdata tools… never give the person a value over the
 * conversation since that is what the agent will speak about once they
 * talk… don't create tools that is not useful for customer care in the real
 * estate business."
 *
 * ONE registry of every customer-care capability an AI-agent surface may
 * offer a buyer/seller/investor/renter/relocation/sphere conversation — a
 * replacement for reaching straight for a BatchData/RentCast property-data
 * tool when the person needs something else entirely (a newsletter signup,
 * a market update, a process explainer, a listing appointment). Every entry
 * is a THIN ADAPTER over an existing survivor (never a duplicate
 * implementation, CLAUDE.md §1):
 *
 *   send_newsletter          → lib/content/newsletter-enrollment.ts
 *                               (enrollContactInNewsletter / enrollLeadInNewsletter)
 *   send_market_report       → lib/market-intelligence/report-builder.ts
 *                               (buildMarketReportAnalysis — the SAME analysis
 *                               app/actions/ai-market-intelligence.ts's staff
 *                               action builds)
 *   send_explainer_video     → lib/video/avatar-explainer.ts
 *                               (commissionAvatarExplainer — the SAME Director
 *                               pipeline every other avatar/explainer video rides)
 *   book_listing_appointment → lib/ai-isa/qualification-signals.ts
 *                               (writeFollowUpActivity/notifyAssignedAgent/
 *                               publishQualificationSignal — the SAME follow-up
 *                               writer book_agent_appointment used) PLUS a NEW
 *                               calendar_events(event_type='listing_appointment')
 *                               row so the EXISTING listing-presentation-prep
 *                               cron (app/api/cron/listing-presentation-prep)
 *                               autonomously preps the CMA + seller drip —
 *                               lane 75C is expected to land a live calendar-
 *                               slot booking helper (owner ruling: "the
 *                               calendar should be hooked up so that the ai
 *                               agent can find a time and day that works…
 *                               and set up the appt right then and the agent
 *                               just confirms it"); until it lands this books
 *                               the EARLIEST valid slot (≥7 days out,
 *                               lib/home-value/listing-appointment.ts's ONE
 *                               7-day-floor definition) in a pending-confirm
 *                               state, which lane 75C's helper can then
 *                               replace call-site-for-call-site.
 *
 * The other six (get_my_context, search_our_listings, request_showing,
 * schedule_callback, send_matching_listings, record_qualification) are KEPT
 * exactly as lib/ai-isa/customer-context-tools.ts already builds them — this
 * file's metadata registry (CAPABILITY_CATALOGUE) documents them alongside
 * the four new ones so the catalogue is the ONE place a scorer, a docs page
 * or a brand's settings toggle can hold the WHOLE list, but their tool
 * BUILDERS are not re-exported here (this file never imports customer-
 * context-tools.ts — that would be a cycle, since that file imports the four
 * NEW builders below; see lib/ai-isa/qualification-signals.ts's header).
 *
 * BRAND-CONFIGURABLE TOOLS (owner: "if a brand wants to create a specific
 * tool that should be an option"): brokerage_settings.settings.
 * ai_agent_capabilities holds a per-capability enable/disable map plus a
 * list of CUSTOM tool definitions that COMPOSE existing catalogue
 * capabilities with the brand's own copy (never a new implementation) —
 * `validateCustomToolDefinition` is the ONE gate that keeps a custom
 * definition honest: every capability id it names must already be in
 * CAPABILITY_CATALOGUE, or the definition is refused.
 */

import { tool } from "ai"
import { z } from "zod"
import { createServiceClient } from "@/lib/supabase/service"
import type { ToolPersona } from "@/lib/ai-isa/persona-tool-policy"
import { publishQualificationSignal } from "@/lib/ai-isa/qualification-signals"

/**
 * A LOCAL mirror of lib/ai-isa/customer-context-tools.ts's
 * CustomerContextToolsContext — deliberately NOT imported (see file header:
 * that file imports FROM this one, so the reverse import would cycle).
 * Structurally identical; any drift is caught by the scoped tsc every lane
 * runs over both files together.
 */
export interface CustomerCapabilityContext {
  brokerageId: string
  contactId?: string | null
  leadId?: string | null
  agentId?: string | null
  persona?: ToolPersona | null
}

// ─── The catalogue's identity ──────────────────────────────────────────────

export type CapabilityId =
  | "get_my_context"
  | "search_our_listings"
  | "request_showing"
  | "schedule_callback"
  | "send_matching_listings"
  | "schedule_home_value_review"
  | "record_qualification"
  | "send_newsletter"
  | "send_market_report"
  | "send_explainer_video"
  | "book_listing_appointment"
  // Lane 76A — persona-realistic customer-care capabilities (see the entries).
  | "get_listing_details"
  | "request_vendor_referral"
  | "capture_referral"
  // Lane 79B — the property rail's two persona tools (lib/ai-isa/property-lookup-tools.ts).
  | "lookup_property_facts"
  | "search_offmarket_opportunities"
  // TOMBSTONE (lane 77A): "get_my_vendor_status" left this union — a vendor
  // is a SEAT, not a customer persona (owner, wave 77). Survivor:
  // lib/ai-isa/user-type-tools.ts::buildGetMyVendorStatusTool, keyed on the
  // session-resolved vendors.id, under lib/ai-isa/user-type-tool-policy.ts.

export interface CapabilityDefinition {
  id: CapabilityId
  label: string
  /** Why this exists for customer care (owner: "don't create tools that is
   *  not useful for customer care in the real estate business"). */
  usefulFor: string
  /** Which lib/ai-isa/persona-tool-policy.ts personas this capability serves —
   *  the personas the playbook OFFERS it to (PERSONA_QUESTION_GUIDE) and the
   *  gate `isCapabilityEnabled` applies to the catalogue-built tools. `null` =
   *  every persona. NOTE (lane 76A): the six CORE follow-up tools
   *  (schedule_callback, send_matching_listings, schedule_home_value_review,
   *  find/book_listing_appointment, record_qualification, request_showing) are
   *  registered on IDENTITY, not persona, because "buyer" is the UNKNOWN default
   *  and buy+sell ("both") is a live contact_type — withholding the seller
   *  tools from a buyer-defaulted thread would lose the move-up seller.
   *  (Lane 77A: the `vendor` persona exclusion lane 76A carved here is GONE —
   *  a vendor is a seat; lib/ai-isa/user-type-tool-policy.ts.) */
  personas: readonly ToolPersona[] | null
  /** costRankForTool's bucket — every catalogue capability is 0 (free,
   *  internal, no vendor spend), the SAME rank persona-tool-policy.ts's
   *  FREE_INTERNAL_TOOL_NAMES already assigns them. */
  costRank: 0
  /** The kernel manager-signal this capability publishes, so a manager loop
   *  picks it up autonomously (lib/kernel/signal-registry.ts SIGNAL_REGISTRY). */
  signalType: string
  /** True when this capability needs a contactId or leadId to act on — the
   *  same identity gate every follow-up tool already enforces. */
  requiresIdentity: boolean
  /** The survivor this capability is a thin adapter over. */
  survivor: string
}

/**
 * THE registry. `docs/ai-agent-tool-surfaces-2026-09.md`'s capability table
 * and scripts/qualification-playbook-simulator.ts's menu↔catalogue identity
 * check both read this list — one place, never restated (CLAUDE.md §6).
 */
export const CAPABILITY_CATALOGUE: readonly CapabilityDefinition[] = [
  {
    id: "get_my_context",
    label: "Look up my own context",
    usefulFor: "grounding replies in what's already on file instead of re-asking the person to repeat themselves",
    personas: null,
    costRank: 0,
    signalType: "(read-only — no signal)",
    requiresIdentity: true,
    survivor: "lib/ai-isa/customer-context-tools.ts::buildGetMyContextTool",
  },
  {
    id: "search_our_listings",
    label: "Search our active listings",
    usefulFor: "answering \"what do you have\" from the brokerage's own free inventory before reaching for a paid tool",
    personas: null,
    costRank: 0,
    signalType: "(read-only — no signal)",
    requiresIdentity: false,
    survivor: "lib/ai-isa/customer-context-tools.ts::buildSearchOurListingsTool",
  },
  {
    id: "request_showing",
    label: "Request a showing, call, or meeting",
    usefulFor: "the person wants to see a property, meet, or talk right now",
    personas: ["buyer", "seller", "renter", "relocation", "investor", "sphere"],
    costRank: 0,
    signalType: "(notification only — no manager signal)",
    requiresIdentity: true,
    survivor: "lib/ai-isa/customer-context-tools.ts::buildRequestShowingTool",
  },
  {
    id: "schedule_callback",
    label: "Call them back later",
    usefulFor: "they're interested but not ready to talk further right now",
    personas: null,
    costRank: 0,
    signalType: "qualification_call_requested",
    requiresIdentity: true,
    survivor: "lib/ai-isa/customer-context-tools.ts::buildScheduleCallbackTool",
  },
  {
    id: "send_matching_listings",
    label: "Send matching listings",
    usefulFor: "they described buyer/renter/investor criteria — send what matches now (own listings first, then RentCast sale or RENTAL listings) and keep sending as new matches come in",
    personas: ["buyer", "renter", "relocation", "investor"],
    costRank: 0,
    signalType: "qualification_criteria_captured",
    requiresIdentity: true,
    survivor: "lib/ai-isa/customer-context-tools.ts::buildSendMatchingListingsTool",
  },
  {
    id: "schedule_home_value_review",
    label: "Look up their home's value (never spoken)",
    usefulFor: "they mentioned selling, asked what their home is worth, or (a past client) want an equity/anniversary update — record the address and book a callback; the AGENT states the number, never the AI",
    personas: ["seller", "sphere"],
    costRank: 0,
    signalType: "qualification_valuation_handoff",
    requiresIdentity: true,
    survivor: "lib/ai-isa/customer-context-tools.ts::buildScheduleHomeValueReviewTool",
  },
  {
    id: "record_qualification",
    label: "Record what's been learned",
    usefulFor: "capturing intent/persona/criteria/timeline/financing as the conversation reveals them",
    personas: null,
    costRank: 0,
    signalType: "(direct write only — no manager signal)",
    requiresIdentity: true,
    survivor: "lib/ai-isa/customer-context-tools.ts::buildRecordQualificationTool",
  },
  {
    id: "send_newsletter",
    label: "Send the newsletter",
    usefulFor: "someone wants to stay in the loop without committing to a showing or callback yet — the low-pressure \"keep me posted\" ask",
    personas: null,
    costRank: 0,
    signalType: "qualification_newsletter_enrolled",
    requiresIdentity: true,
    survivor: "lib/content/newsletter-enrollment.ts::enrollContactInNewsletter / enrollLeadInNewsletter",
  },
  {
    id: "send_market_report",
    label: "Send a market report for their area",
    usefulFor: "they ask about the market, pricing trends, or \"is now a good time\" for their area — or a past client wants a market update",
    personas: ["buyer", "seller", "renter", "relocation", "investor", "sphere"],
    costRank: 0,
    signalType: "qualification_market_report_sent",
    requiresIdentity: true,
    survivor: "lib/market-intelligence/report-builder.ts::buildMarketReportAnalysis",
  },
  {
    id: "send_explainer_video",
    label: "Send a buying/selling process explainer video",
    usefulFor: "a first-time buyer or an unsure seller wants to understand the STEPS before committing to anything",
    personas: ["buyer", "seller", "renter", "relocation"],
    costRank: 0,
    signalType: "qualification_explainer_video_requested",
    requiresIdentity: true,
    survivor: "lib/video/avatar-explainer.ts::commissionAvatarExplainer",
  },
  {
    id: "book_listing_appointment",
    label: "Book a no-obligation listing appointment",
    usefulFor: "a seller wants an agent to come out (in person or video) and talk it through, no obligation",
    personas: ["seller"],
    costRank: 0,
    signalType: "qualification_appointment_handoff",
    requiresIdentity: true,
    survivor: "lib/home-value/listing-appointment.ts + calendar_events(event_type='listing_appointment')",
  },
  // ── Lane 76A — the persona asks the catalogue did not cover ────────────
  {
    id: "get_listing_details",
    label: "Answer a question about one of our listings",
    usefulFor: "\"is the house on Oak Street still available / what's the price / how many beds / HOA?\" — answered from OUR OWN listings table (free), never invented, never a paid lookup",
    personas: null,
    costRank: 0,
    signalType: "(read-only — no signal)",
    requiresIdentity: false,
    survivor: "lib/ai-isa/capability-catalogue.ts::buildGetListingDetailsTool over listings (same table search_our_listings reads)",
  },
  {
    id: "request_vendor_referral",
    label: "Connect them with a trusted vendor / lender",
    usefulFor: "a buyer who still needs pre-approval wants a lender to talk to (a lender is a VENDOR CATEGORY, CLAUDE.md §4), or a past client / seller needs a plumber, contractor, mover, inspector — from the brokerage's own curated bench",
    personas: ["buyer", "seller", "sphere", "relocation", "renter"],
    costRank: 0,
    signalType: "(notification + follow-up activity only — no manager signal)",
    requiresIdentity: true,
    survivor: "lib/vendor-marketplace/resolve-contact-vendors.ts::resolveContactVendors + lib/kernel/lender-linkage.ts::LENDER_BENCH_CATEGORIES + lib/ai-isa/qualification-signals.ts::scheduleFollowUp/notifyAssignedAgent",
  },
  {
    id: "capture_referral",
    label: "Capture a referral",
    usefulFor: "a past client / sphere contact mentions a friend or family member who is buying, selling or renting — capture them onto the existing referrals rail so the agent follows up",
    personas: ["sphere", "buyer", "seller", "relocation", "renter", "investor"],
    costRank: 0,
    signalType: "referral_received (KernelEvent — the SAME event createReferral emits)",
    requiresIdentity: true,
    survivor: "lib/referrals/referral-record.ts::insertReferralRecord (extracted from app/actions/referrals/referral-actions.ts::createReferral) + lib/contact-pipeline/contact-capture.ts::captureContact",
  },
  // ── Lane 79B — property lookup WITHOUT BatchData (owner, wave 79) ──────
  {
    id: "lookup_property_facts",
    label: "Look up a property's facts by address",
    usefulFor: "\"tell me about 123 Main St\" / \"is it 3 or 4 beds?\" — beds, baths, sqft, year built, type and our own list price when it is our listing; cheapest source first (our records → the tenant's MLS feed → RentCast → public records), NEVER BatchData in a conversation, and NEVER a home value (that is schedule_home_value_review's callback)",
    personas: null,
    costRank: 0,
    signalType: "(read-only — no signal)",
    requiresIdentity: false,
    survivor: "lib/ai-isa/property-lookup-rail.ts::lookupPropertyForConversation + lib/ai-isa/property-lookup-tools.ts::buildLookupPropertyFactsTool",
  },
  {
    id: "search_offmarket_opportunities",
    label: "Show an investor their cached off-market matches",
    usefulFor: "an investor asks what off-market / likely-to-sell properties fit their buy box — read from OUR OWN cache (investor_offmarket_candidates, filled by the platform's acquisition runner), property facts + likelihood band only, never an owner's contact",
    personas: ["investor"],
    costRank: 0,
    signalType: "(read-only — no signal)",
    requiresIdentity: true,
    survivor: "lib/buyer-search/investor-offmarket-runner.ts (writer) + lib/buyer-search/investor-facing.ts::toInvestorFacingCandidates (redaction) + lib/ai-isa/property-lookup-tools.ts::buildSearchOffmarketOpportunitiesTool",
  },
  // TOMBSTONE (lane 77A, CLAUDE.md §1.3): the `get_my_vendor_status` entry
  // lane 76A added here (a vendor persona's own placement/invoice/payout read,
  // resolved by a CONTACT's email/phone) is GONE, together with
  // VENDOR_SAFE_CAPABILITIES and the vendor branch of isCapabilityEnabled.
  // Owner (wave 77): "vendors are not contact type, they are user type."
  // Survivor: lib/ai-isa/user-type-tools.ts::buildGetMyVendorStatusTool — the
  // SAME three reads (vendor_assignments / vendor_invoices / vendor_payouts),
  // now keyed on the SESSION-resolved vendors.id (user_role_assignments.
  // vendor_id, lib/auth/role-grants.ts::selectVendorId) + brokerage_id, never
  // an email/phone match — under lib/ai-isa/user-type-tool-policy.ts.
] as const

export const CAPABILITY_IDS: readonly CapabilityId[] = CAPABILITY_CATALOGUE.map((c) => c.id)

/** PURE — is `id` a real catalogue capability? Used by both the settings
 *  toggle reader and custom-tool-definition validation below. */
function isCapabilityId(id: string): id is CapabilityId {
  return (CAPABILITY_IDS as readonly string[]).includes(id)
}

// ─── Brand-configurable enable/disable + custom tools ──────────────────────
//
// brokerage_settings.settings.ai_agent_capabilities — the EXISTING generic
// settings jsonb column (lib/kernel/self-book.ts's `settings.self_booking`
// is the precedent for a namespaced key under it; no new column, no
// migration). Shape:
//   { disabled: string[]  // CapabilityId values this brand turned OFF
//     custom: CustomToolDefinition[] }

export interface CustomToolDefinition {
  id: string
  label: string
  /** Brand copy shown to the model as the tool's description — the ONLY
   *  brand-authored part; the composed capabilities still run their real
   *  implementation, never brand-authored logic. */
  copy: string
  /** Which EXISTING catalogue capabilities this custom tool composes — every
   *  id must be in CAPABILITY_CATALOGUE (validateCustomToolDefinition). */
  composesCapabilities: string[]
}

export interface AiAgentCapabilitiesSettings {
  disabled: CapabilityId[]
  custom: CustomToolDefinition[]
}

const DEFAULT_CAPABILITIES_SETTINGS: AiAgentCapabilitiesSettings = { disabled: [], custom: [] }

/** PURE — settings.ai_agent_capabilities → the typed shape, tolerant of a
 *  missing/malformed key (a tenant that never configured this gets every
 *  capability ON and no custom tools — never a hard failure). */
export function parseCapabilitiesSettings(settings: Record<string, unknown> | null | undefined): AiAgentCapabilitiesSettings {
  const raw = (settings as Record<string, unknown> | null | undefined)?.ai_agent_capabilities as
    | { disabled?: unknown; custom?: unknown }
    | undefined
  if (!raw || typeof raw !== "object") return DEFAULT_CAPABILITIES_SETTINGS
  const disabled = Array.isArray(raw.disabled)
    ? raw.disabled.filter((d): d is CapabilityId => typeof d === "string" && isCapabilityId(d))
    : []
  const custom = Array.isArray(raw.custom)
    ? raw.custom
        .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
        .map((c) => ({
          id: typeof c.id === "string" ? c.id.slice(0, 80) : "",
          label: typeof c.label === "string" ? c.label.slice(0, 120) : "",
          copy: typeof c.copy === "string" ? c.copy.slice(0, 2000) : "",
          composesCapabilities: Array.isArray(c.composesCapabilities)
            ? c.composesCapabilities.filter((x): x is string => typeof x === "string")
            : [],
        }))
        .filter((c) => c.id && c.label && c.composesCapabilities.length > 0)
    : []
  return { disabled, custom }
}

export interface CustomToolValidationResult {
  ok: boolean
  /** Capability ids the definition named that are NOT in CAPABILITY_CATALOGUE
   *  — a custom tool may only COMPOSE what already exists (owner ruling). */
  unknownCapabilities: string[]
}

/** PURE — the ONE gate a custom tool definition must pass before it is
 *  stored or offered: every composed capability id must be a REAL catalogue
 *  entry. Never lets a brand's settings smuggle in a made-up capability name
 *  that no builder backs. */
export function validateCustomToolDefinition(def: CustomToolDefinition): CustomToolValidationResult {
  const unknown = def.composesCapabilities.filter((c) => !isCapabilityId(c))
  return { ok: unknown.length === 0 && def.composesCapabilities.length > 0, unknownCapabilities: unknown }
}

let settingsCache: { at: number; brokerageId: string; settings: AiAgentCapabilitiesSettings } | null = null
const SETTINGS_CACHE_TTL_MS = 60_000

/**
 * I/O — reads the brokerage's ai_agent_capabilities settings, short-TTL
 * cached (same posture as brand-playbook-context.ts). Fails OPEN (every
 * capability enabled) on a read error — a settings outage must never take
 * every customer-care tool down with it.
 */
export async function loadEnabledCapabilities(brokerageId: string): Promise<AiAgentCapabilitiesSettings> {
  if (settingsCache && settingsCache.brokerageId === brokerageId && Date.now() - settingsCache.at < SETTINGS_CACHE_TTL_MS) {
    return settingsCache.settings
  }
  try {
    const svc = createServiceClient()
    const { data } = await svc.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
    const settings = parseCapabilitiesSettings((data as { settings?: Record<string, unknown> } | null)?.settings ?? null)
    settingsCache = { at: Date.now(), brokerageId, settings }
    return settings
  } catch {
    return DEFAULT_CAPABILITIES_SETTINGS
  }
}

/** PURE — is `id` allowed for this persona + this brand's settings? */
export function isCapabilityEnabled(id: CapabilityId, persona: ToolPersona | null | undefined, disabled: readonly CapabilityId[]): boolean {
  if (disabled.includes(id)) return false
  const def = CAPABILITY_CATALOGUE.find((c) => c.id === id)
  if (!def) return false
  // (Lane 77A: lane 76A's two `vendor` branches here are gone — see the
  // catalogue tombstone above. Every persona in ToolPersona is a customer.)
  if (!def.personas) return true
  if (!persona) return true // persona not yet resolved — do not withhold, the identity gate still applies
  return (def.personas as readonly string[]).includes(persona)
}

// TOMBSTONE (lane 77A): CONTACT_ONLY_CAPABILITIES (whose only member was
// get_my_vendor_status) is gone with that capability — see the catalogue
// tombstone. request_showing's contact-only registration discipline lives in
// customer-context-tools.ts::buildCustomerFreeTools, unchanged.

// ─── NEW capability #1 — send_newsletter ───────────────────────────────────

function buildSendNewsletterTool(ctx: CustomerCapabilityContext) {
  return tool({
    description: "Enrol the person in the brand's newsletter so they keep hearing from us without committing to anything else right now. Use when they ask to \"stay in the loop\", \"keep me posted\", or similar — a low-pressure ask.",
    inputSchema: z.object({}),
    execute: async () => {
      const { enrollContactInNewsletter, enrollLeadInNewsletter } = await import("@/lib/content/newsletter-enrollment")
      const outcome = ctx.contactId
        ? await enrollContactInNewsletter({ contactId: ctx.contactId, brokerageId: ctx.brokerageId })
        : ctx.leadId
        ? await enrollLeadInNewsletter({ leadId: ctx.leadId, brokerageId: ctx.brokerageId })
        : null
      if (!outcome) return { success: false, error: "No contact or lead is linked to this conversation yet" }
      if (!outcome.enrolled && outcome.reason !== "already_subscribed" && outcome.reason !== "rekeyed") {
        return { success: false, reason: outcome.reason }
      }
      await publishQualificationSignal({
        brokerageId: ctx.brokerageId,
        toManager: "campaign_orchestrator", // wave 50 ruling — newsletter promotion is campaign_orchestrator's domain
        signalType: "qualification_newsletter_enrolled",
        message: "AI qualification enrolled the person in the brand newsletter",
        contactId: ctx.contactId ?? null,
        leadId: ctx.leadId ?? null,
        payload: { reason: outcome.reason, scope: outcome.scope ?? null },
      })
      return { success: true, enrolled: true, alreadySubscribed: outcome.reason === "already_subscribed" }
    },
  })
}

// ─── NEW capability #2 — send_market_report ────────────────────────────────

function buildSendMarketReportTool(ctx: CustomerCapabilityContext) {
  return tool({
    description: "Prepare and send a market report/update for the person's area — overall condition, price trend direction, and inventory level. Use when they ask about the market, pricing trends, or whether now is a good time. Speak only the CONDITION and TREND back to them (e.g. \"a balanced market, prices holding steady\") — never quote a specific dollar figure from the report.",
    inputSchema: z.object({
      city: z.string().nullable().describe("City for the report, or null"),
      state: z.string().nullable().describe("Two-letter state code, or null"),
      zip: z.string().nullable().describe("ZIP code, or null"),
    }),
    execute: async ({ city, zip }: { city: string | null; state: string | null; zip: string | null }) => {
      if (!ctx.contactId && !ctx.leadId) return { success: false, error: "No contact or lead is linked to this conversation yet" }
      const { buildMarketReportAnalysis } = await import("@/lib/market-intelligence/report-builder")
      const result = await buildMarketReportAnalysis({ brokerageId: ctx.brokerageId, city: city ?? undefined, zipCode: zip ?? undefined })
      if (!result.success) return { success: false, error: result.error }

      // Also enrols the standing newsletter channel (send_newsletter's own
      // survivor, reused rather than a second enrollment write, §6) so
      // ongoing market_update sections keep reaching them — this ONE report
      // is answered now, and the relationship continues without a second tool call.
      const { enrollContactInNewsletter, enrollLeadInNewsletter } = await import("@/lib/content/newsletter-enrollment")
      if (ctx.contactId) await enrollContactInNewsletter({ contactId: ctx.contactId, brokerageId: ctx.brokerageId }).catch(() => null)
      else if (ctx.leadId) await enrollLeadInNewsletter({ leadId: ctx.leadId, brokerageId: ctx.brokerageId }).catch(() => null)

      await publishQualificationSignal({
        brokerageId: ctx.brokerageId,
        toManager: "campaign_orchestrator",
        signalType: "qualification_market_report_sent",
        message: `AI qualification sent a market report for ${city ?? zip ?? "the area"}`,
        contactId: ctx.contactId ?? null,
        leadId: ctx.leadId ?? null,
        payload: { city, zip, marketCondition: result.report.marketCondition, trendDirection: result.report.trendDirection },
      })

      // Only the CONDITION/TREND/INVENTORY fields — never a dollar figure
      // (avgPriceChange, hotNeighborhoods[].avgPrice, competitorAnalysis
      // prices) reaches the model's return value here.
      return {
        success: true,
        marketCondition: result.report.marketCondition,
        trendDirection: result.report.trendDirection,
        inventoryLevel: result.report.inventoryLevel,
        summary: result.report.summary,
      }
    },
  })
}

// ─── NEW capability #3 — send_explainer_video ──────────────────────────────

function buildSendExplainerVideoTool(ctx: CustomerCapabilityContext) {
  return tool({
    description: "Commission and send a short explainer video walking the person through the BUYING or SELLING process — what to expect, step by step. Use when a first-time buyer or an unsure seller wants to understand the process before committing to anything, not for property-specific questions.",
    inputSchema: z.object({
      focus: z.enum(["buying_process", "selling_process"]).describe("Which process to explain"),
    }),
    execute: async ({ focus }: { focus: "buying_process" | "selling_process" }) => {
      if (!ctx.agentId) return { success: false, error: "No agent is assigned to present this video yet" }
      const svc = createServiceClient()
      const { data: agent } = await svc.from("agents").select("user_id").eq("id", ctx.agentId).maybeSingle()
      const agentUserId = (agent as { user_id?: string } | null)?.user_id ?? null
      if (!agentUserId) return { success: false, error: "Could not resolve the agent's account" }

      const { commissionAvatarExplainer } = await import("@/lib/video/avatar-explainer")
      const topic = focus === "buying_process"
        ? "Explain the step-by-step home-buying process so a buyer knows what to expect from offer to closing"
        : "Explain the step-by-step home-selling process so a seller knows what to expect from listing to closing"
      const audience = focus === "buying_process" ? "a buyer new to the process" : "a seller new to the process"
      const result = await commissionAvatarExplainer({
        brokerageId: ctx.brokerageId,
        agentUserId,
        topic,
        audience,
        presetId: focus === "buying_process" ? "buyer_education" : null,
      })
      if (!result.ok) return { success: false, error: result.reason }

      // NOT "video_generation_requested" (lib/kernel/signal-registry.ts:316) —
      // that signal's FROM is fixed to asset_manager and its TO is routed by
      // lib/kernel/signal-routing.ts::routeVideoGenerationRequested off the
      // ai_video_projects row's OWN entity association (listing/contact/
      // recruiting/brand). commissionAvatarExplainer does not emit it (that
      // function only inserts the row), and republishing it here FROM ai_isa
      // would be a second, conflicting spelling of the same signal name
      // (CLAUDE.md §6). This is a DISTINCT moment — the ISA commissioned a
      // video for a qualification conversation — with its own registered name.
      await publishQualificationSignal({
        brokerageId: ctx.brokerageId,
        toManager: "asset_manager",
        signalType: "qualification_explainer_video_requested",
        message: `AI qualification commissioned a ${focus.replace("_", " ")} explainer video`,
        contactId: ctx.contactId ?? null,
        leadId: ctx.leadId ?? null,
        payload: { focus, videoProjectId: result.videoProjectId, status: result.status },
      })

      return { success: true, status: result.status, videoProjectId: result.videoProjectId }
    },
  })
}

// ─── capability #4 — book_listing_appointment ─────────────────────────────
// TOMBSTONE (wave 75 integration, CLAUDE.md §1.1): this file's earliest-slot
// buildBookListingAppointmentTool (calendar_events row at the first valid day,
// no live calendar read) is RETIRED onto the CALENDAR-BACKED survivor
// lib/ai-isa/listing-appointment.ts (findAgentAppointmentSlots +
// bookListingAppointment) driven by lib/ai-isa/customer-context-tools.ts::
// buildFindListingAppointmentSlotsTool / buildBookListingAppointmentTool
// (lane 75C). The catalogue keeps the capability id so the brand toggle,
// persona allowlist and follow-up menu still govern it; registration happens
// in buildCustomerFreeTools, which honours settings.disabled for this id.

// ─── Lane 76A capability #5 — get_listing_details ──────────────────────────
// "Is the house on Oak Street still available? What's the price? HOA?" — the
// single most common buyer/renter question on a live call (Noem/Hyperleap
// receptionist intake). Answered from OUR OWN listings table — the SAME table
// search_our_listings reads — never a paid lookup, never invented. Public,
// listing-facing fields only: showing_instructions / seller_walkaway_price /
// commission_rate / marketing_budget are internal and never selected.
export function buildGetListingDetailsTool(ctx: CustomerCapabilityContext) {
  return tool({
    description: "Answer a question about ONE specific listing of ours by address — availability/status, list price, beds/baths, square footage, property type, year built, HOA dues, and the public remarks. Free — use before any paid lookup. If nothing matches, say the agent will confirm; never invent details.",
    inputSchema: z.object({
      address: z.string().describe("The street address (or enough of it to match) the person asked about"),
      city: z.string().nullable().describe("City, or null"),
    }),
    execute: async ({ address, city }: { address: string; city: string | null }) => {
      const hint = address.replace(/[%,]/g, "").trim().slice(0, 80)
      if (hint.length < 3) return { success: false, error: "Need at least a street name to look a listing up" }
      const svc = createServiceClient()
      let q = svc
        .from("listings")
        .select("id, address, city, state, zip, status, list_price, bedrooms, bathrooms, sqft, property_type, year_built, hoa_dues, has_pool, public_remarks, open_house_event_date")
        .eq("brokerage_id", ctx.brokerageId)
        .is("deleted_at", null)
        .ilike("address", `%${hint}%`)
        .limit(3)
      if (city) q = q.ilike("city", `%${city.replace(/[%,]/g, "").slice(0, 60)}%`)
      const { data, error } = await q
      if (error) return { success: false, error: error.message }
      const rows = (data ?? []).map((l: Record<string, unknown>) => ({
        ...l,
        public_remarks: typeof l.public_remarks === "string" ? (l.public_remarks as string).slice(0, 600) : null,
      }))
      if (rows.length === 0) return { success: true, found: false, message: "No listing of ours matches that address — offer to have the agent confirm." }
      return { success: true, found: true, listings: rows }
    },
  })
}

// ─── Lane 76A capability #6 — request_vendor_referral ──────────────────────
// A buyer who "hasn't talked to a lender yet" (Lofty's 'AI: Need Financing'
// tag, Alma's Mortgage Pre-Qual hand-off) and a past client who needs a
// plumber/contractor/mover are the two vendor asks every competitor routes.
// Survivors: resolveContactVendors (the SAME curated, tier-gated, portal-
// visible bench the contact's own portal shows — never an un-curated vendor
// row), LENDER_BENCH_CATEGORIES (a lender is a VENDOR CATEGORY, never a user
// type — CLAUDE.md §4), and the follow-up writer/notifier every other
// follow-up tool uses. Returns business contact details only (name, phone,
// website, rating) — never a vendor's financials or another client's data.
// Module-private (lane 77C, orphan census round 22): reached only through
// NEW_CAPABILITY_BUILDERS below — no importer and no proof names it.
function buildRequestVendorReferralTool(ctx: CustomerCapabilityContext) {
  return tool({
    description: "Offer an intro to a trusted vendor from the brokerage's own bench — a LENDER when a buyer still needs pre-approval or a past client asks about refinancing, or a contractor / inspector / mover / plumber / cleaner etc. when they need one. Use only when THEY ask or accept the offer; returns up to 3 vetted names and tells the agent to make the intro.",
    inputSchema: z.object({
      category: z.string().describe("What kind of vendor — e.g. lender, inspector, contractor, mover, plumber, handyman, cleaner, insurance, title"),
      need: z.string().describe("In their words, what they need it for"),
    }),
    execute: async ({ category, need }: { category: string; need: string }) => {
      if (!ctx.contactId && !ctx.leadId) return { success: false, error: "No contact or lead is linked to this conversation yet" }
      const svc = createServiceClient()
      const wanted = category.trim().toLowerCase()
      const { LENDER_BENCH_CATEGORIES, isLenderVendorCategory } = await import("@/lib/kernel/lender-linkage")
      const wantsLender = isLenderVendorCategory(wanted) || /refinanc|mortgage|pre-?approv|financ/.test(wanted)

      // Audience tags from the contact's OWN row (lead-only threads use the
      // brokerage-wide bench — entries with no audience_tags).
      let audienceTags: string[] = []
      if (ctx.contactId) {
        const { data: c } = await svc.from("contacts").select("contact_type, contact_persona, buyer_stage").eq("id", ctx.contactId).eq("brokerage_id", ctx.brokerageId).maybeSingle()
        const { buildVendorAudienceTags } = await import("@/lib/vendor-marketplace/resolve-contact-vendors")
        audienceTags = buildVendorAudienceTags({
          contactType: (c as { contact_type?: string | null } | null)?.contact_type ?? null,
          contactPersona: (c as { contact_persona?: string | null } | null)?.contact_persona ?? null,
          buyerStage: (c as { buyer_stage?: string | null } | null)?.buyer_stage ?? null,
        }).audienceTags
      }
      const { resolveContactVendors } = await import("@/lib/vendor-marketplace/resolve-contact-vendors")
      const bench = await resolveContactVendors(svc, {
        contactId: ctx.contactId ?? "", brokerageId: ctx.brokerageId, teamId: null, stage: null, audienceTags,
      })
      const matches = bench.filter((v) => {
        const cat = (v.category ?? "").toLowerCase()
        if (wantsLender) return (LENDER_BENCH_CATEGORIES as readonly string[]).includes(cat) || isLenderVendorCategory(cat)
        return cat === wanted || cat.includes(wanted) || wanted.includes(cat)
      }).slice(0, 3)

      // The agent makes the intro — logged as a follow-up on the SAME rail
      // every other follow-up tool uses, never a bare insert.
      const { scheduleFollowUp, notifyAssignedAgent } = await import("@/lib/ai-isa/qualification-signals")
      await scheduleFollowUp(ctx, {
        activityType: "call",
        scheduledAt: new Date().toISOString(),
        notes: `Vendor intro requested — ${wantsLender ? "lender" : category}: ${need}${matches.length ? `\nBench matches: ${matches.map((m) => m.name).filter(Boolean).join(", ")}` : "\n(no bench match — agent to source)"}`,
        title: `Vendor referral requested: ${wantsLender ? "lender" : category}`,
      })
      await notifyAssignedAgent(ctx, {
        type: "vendor_referral_requested",
        title: `Client wants a ${wantsLender ? "lender" : category} intro`,
        body: need.slice(0, 300),
        entityType: ctx.contactId ? "contact" : "lead",
        entityId: (ctx.contactId ?? ctx.leadId) as string,
      })
      return {
        success: true,
        category: wantsLender ? "lender" : category,
        vendors: matches.map((m) => ({ name: m.name, category: m.category, phone: m.phone, website: m.website, rating: m.rating, preferred: m.preferred })),
        agentWillIntroduce: true,
        note: matches.length ? "Share the names; the agent makes the introduction." : "No vetted match on the bench yet — tell them the agent will send a recommendation.",
      }
    },
  })
}

// ─── Lane 76A capability #7 — capture_referral ─────────────────────────────
// The past-client conversation every referral program is built around
// ("anyone you know thinking of buying or selling?"). Survivors:
// captureContact (Track B — the SAME capture the staff createReferral dialog
// runs, source 'referral', no TCPA consent implied — the referred person
// never consented to anything) and insertReferralRecord (the ONE referrals
// insert, extracted from createReferral so both write the same row). The
// referrer is LOCKED to ctx: contacts.id → referrer_contact_id; a lead-only
// referrer lands in the free-text referred_by column (never in a contacts
// slot — a leads.id is not a contacts.id).
// Module-private (lane 77C, orphan census round 22): reached only through
// NEW_CAPABILITY_BUILDERS below — no importer and no proof names it (the two
// mentions in app/actions/referrals/referral-actions.ts and
// lib/referrals/referral-record.ts are prose naming this survivor).
function buildCaptureReferralTool(ctx: CustomerCapabilityContext) {
  return tool({
    description: "Capture a referral when the person mentions someone ELSE who is thinking of buying, selling or renting. Only with their permission to pass the name along. Needs the referred person's name and at least a phone or email; the agent follows up.",
    inputSchema: z.object({
      referred_first_name: z.string().describe("The referred person's first name"),
      referred_last_name: z.string().nullable(),
      referred_phone: z.string().nullable().describe("Their phone, or null"),
      referred_email: z.string().nullable().describe("Their email, or null"),
      what_they_need: z.string().describe("Buying / selling / renting, area, timing — in the referrer's words"),
      permission_given: z.boolean().describe("Did the referrer explicitly OK passing the name along?"),
    }),
    execute: async (args: { referred_first_name: string; referred_last_name: string | null; referred_phone: string | null; referred_email: string | null; what_they_need: string; permission_given: boolean }) => {
      if (!ctx.contactId && !ctx.leadId) return { success: false, error: "No contact or lead is linked to this conversation yet" }
      if (!args.permission_given) return { success: false, error: "Ask the referrer if it's OK to pass the name along before capturing it" }
      if (!args.referred_phone && !args.referred_email) return { success: false, error: "Need a phone or email for the referred person" }
      const svc = createServiceClient()

      // Who is referring — read off the LOCKED ctx row, never a model argument.
      let referrerName = "a client"
      if (ctx.contactId) {
        const { data: c } = await svc.from("contacts").select("first_name, last_name").eq("id", ctx.contactId).eq("brokerage_id", ctx.brokerageId).maybeSingle()
        referrerName = [(c as { first_name?: string | null } | null)?.first_name, (c as { last_name?: string | null } | null)?.last_name].filter(Boolean).join(" ") || referrerName
      } else if (ctx.leadId) {
        const { data: l } = await svc.from("leads").select("first_name, last_name").eq("id", ctx.leadId).eq("brokerage_id", ctx.brokerageId).maybeSingle()
        referrerName = [(l as { first_name?: string | null } | null)?.first_name, (l as { last_name?: string | null } | null)?.last_name].filter(Boolean).join(" ") || referrerName
      }

      const { captureContact } = await import("@/lib/contact-pipeline/contact-capture")
      let referredContactId: string | null = null
      try {
        const captured = await captureContact({
          brokerageId: ctx.brokerageId,
          first_name: args.referred_first_name,
          last_name: args.referred_last_name ?? null,
          email: args.referred_email ?? null,
          phone: args.referred_phone ?? null,
          source: "referral",
          tcpa_consent: false,
          notes: `Referred by ${referrerName} via AI conversation: ${args.what_they_need}`.slice(0, 500),
        })
        referredContactId = captured.contactId
      } catch (e) {
        return { success: false, error: `Could not capture the referred person: ${(e as Error).message}` }
      }

      const { insertReferralRecord } = await import("@/lib/referrals/referral-record")
      const inserted = await insertReferralRecord(svc, {
        brokerageId: ctx.brokerageId,
        agentId: ctx.agentId ?? null,
        referredContactId,
        referrerContactId: ctx.contactId ?? null,
        referredBy: ctx.contactId ? null : referrerName,
        sourceContactName: referrerName,
        referralName: [args.referred_first_name, args.referred_last_name].filter(Boolean).join(" "),
        referralSource: "ai_conversation",
        notes: args.what_they_need,
      })
      if (!inserted.ok) return { success: false, error: inserted.error }

      // The SAME kernel event the staff dialog emits — sequences keyed on
      // referral_received enroll from either door.
      try {
        const { emitKernelEvent } = await import("@/lib/kernel/emit")
        const { KernelEvent } = await import("@/lib/kernel/events")
        await emitKernelEvent({
          entityType: "contact",
          entityId: referredContactId,
          brokerageId: ctx.brokerageId,
          event: KernelEvent.REFERRAL_RECEIVED,
          contactId: referredContactId,
          metadata: { referral_id: inserted.id, source: "ai_conversation", referrer_contact_id: ctx.contactId ?? null, referrer_lead_id: ctx.contactId ? null : ctx.leadId ?? null },
        })
      } catch (e) {
        console.error("[capability-catalogue] referral_received emit failed (referral row already written):", e)
      }
      const { notifyAssignedAgent } = await import("@/lib/ai-isa/qualification-signals")
      await notifyAssignedAgent(ctx, {
        type: "referral_captured",
        title: `${referrerName} referred ${args.referred_first_name}`,
        body: args.what_they_need.slice(0, 300),
        entityType: "contact",
        entityId: referredContactId,
      })
      return { success: true, referralId: inserted.id, referredContactId, note: "Thank them — the agent will reach out to the person they referred." }
    },
  })
}

// ─── TOMBSTONE (lane 77A) — lane 76A capability #8, get_my_vendor_status ──
// buildGetMyVendorStatusTool is GONE from this file. It resolved a VENDOR by
// matching a contact's email/phone against the brokerage's vendors table —
// the wrong identity class for a seat: a vendor who talks to the OS is a
// signed-in user (users.user_type='vendor', user_role_assignments.vendor_id),
// never a contacts row. Survivor: lib/ai-isa/user-type-tools.ts::
// buildGetMyVendorStatusTool (SAME three reads, keyed on the session-resolved
// vendors.id + brokerage_id), mounted under lib/ai-isa/user-type-tool-policy.ts.

// ─── Assembly ───────────────────────────────────────────────────────────────

const NEW_CAPABILITY_BUILDERS: Partial<Record<CapabilityId, (ctx: CustomerCapabilityContext) => unknown>> = {
  send_newsletter: buildSendNewsletterTool,
  send_market_report: buildSendMarketReportTool,
  send_explainer_video: buildSendExplainerVideoTool,
  // book_listing_appointment: registered by customer-context-tools.ts (see tombstone above)
  // Lane 76A — identity-gated (the caller checks contactId/leadId first).
  // get_listing_details needs NO identity and is registered unconditionally
  // by customer-context-tools.ts::buildCustomerFreeTools beside search_our_listings.
  request_vendor_referral: buildRequestVendorReferralTool,
  capture_referral: buildCaptureReferralTool,
  // get_my_vendor_status: moved to lib/ai-isa/user-type-tools.ts (lane 77A tombstone above)
}

/**
 * Builds ONLY the four NEW catalogue tools (never the six "keep" ones —
 * those stay built by customer-context-tools.ts itself), filtered by
 * identity (contactId/leadId already checked by the caller before this is
 * invoked), persona, and the brand's own settings toggle. This is what
 * lib/ai-isa/customer-context-tools.ts::buildCustomerFreeTools spreads into
 * its own bundle — the missing half this lane builds.
 */
export async function buildNewCatalogueTools(
  ctx: CustomerCapabilityContext,
  settings: AiAgentCapabilitiesSettings,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const [id, builder] of Object.entries(NEW_CAPABILITY_BUILDERS) as Array<[CapabilityId, (ctx: CustomerCapabilityContext) => unknown]>) {
    if (!isCapabilityEnabled(id, ctx.persona, settings.disabled)) continue
    out[id] = builder(ctx)
  }
  return out
}
