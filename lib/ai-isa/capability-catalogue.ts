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

export interface CapabilityDefinition {
  id: CapabilityId
  label: string
  /** Why this exists for customer care (owner: "don't create tools that is
   *  not useful for customer care in the real estate business"). */
  usefulFor: string
  /** Which lib/ai-isa/persona-tool-policy.ts personas this capability serves.
   *  `null` = every persona (the universal free tools). */
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
    personas: ["buyer", "seller", "renter", "relocation"],
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
    usefulFor: "they described buyer/renter criteria — send what matches now and keep sending as new matches come in",
    personas: ["buyer", "renter", "relocation"],
    costRank: 0,
    signalType: "qualification_criteria_captured",
    requiresIdentity: true,
    survivor: "lib/ai-isa/customer-context-tools.ts::buildSendMatchingListingsTool",
  },
  {
    id: "schedule_home_value_review",
    label: "Look up their home's value (never spoken)",
    usefulFor: "they mentioned selling or asked what their home is worth — record the address and book a callback; the AGENT states the number, never the AI",
    personas: ["seller"],
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
    usefulFor: "they ask about the market, pricing trends, or \"is now a good time\" for their area",
    personas: ["buyer", "seller", "renter", "relocation", "investor"],
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
] as const

export const CAPABILITY_IDS: readonly CapabilityId[] = CAPABILITY_CATALOGUE.map((c) => c.id)

/** PURE — is `id` a real catalogue capability? Used by both the settings
 *  toggle reader and custom-tool-definition validation below. */
export function isCapabilityId(id: string): id is CapabilityId {
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
  if (!def.personas) return true
  if (!persona) return true // persona not yet resolved — do not withhold, the identity gate still applies
  return (def.personas as readonly string[]).includes(persona)
}

// ─── NEW capability #1 — send_newsletter ───────────────────────────────────

export function buildSendNewsletterTool(ctx: CustomerCapabilityContext) {
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

export function buildSendMarketReportTool(ctx: CustomerCapabilityContext) {
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

export function buildSendExplainerVideoTool(ctx: CustomerCapabilityContext) {
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

// ─── Assembly ───────────────────────────────────────────────────────────────

const NEW_CAPABILITY_BUILDERS: Partial<Record<CapabilityId, (ctx: CustomerCapabilityContext) => unknown>> = {
  send_newsletter: buildSendNewsletterTool,
  send_market_report: buildSendMarketReportTool,
  send_explainer_video: buildSendExplainerVideoTool,
  // book_listing_appointment: registered by customer-context-tools.ts (see tombstone above)
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
