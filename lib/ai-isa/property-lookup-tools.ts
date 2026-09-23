/**
 * lib/ai-isa/property-lookup-tools.ts
 *
 * Lane 79B — the TWO persona property tools that replace the direct BatchData
 * registry entries a customer conversation used to reach (owner: "tools for
 * the ai agents should not be using batchdata tools if there are less
 * expensive tools to look up properties"). Both are FREE-RANKED internal
 * tools (lib/ai-isa/persona-tool-policy.ts::FREE_INTERNAL_TOOL_NAMES) and
 * are catalogued in lib/ai-isa/capability-catalogue.ts; neither imports a
 * BatchData module (scripts/persona-tool-realism-guard.ts holds that line).
 *
 *   lookup_property_facts        — ONE property's facts by address through
 *                                  lib/ai-isa/property-lookup-rail.ts
 *                                  (cache → tenant IDX → RentCast → public
 *                                  records; BatchData never — purpose is
 *                                  "conversation"). Customer audience:
 *                                  valuation figures are stripped by the
 *                                  rail, so a seller's "what's it worth"
 *                                  still routes to schedule_home_value_review
 *                                  (the AGENT speaks the number).
 *   search_offmarket_opportunities — the INVESTOR persona's property-only
 *                                  off-market / most-likely-to-sell matches,
 *                                  read from OUR OWN CACHE
 *                                  (investor_offmarket_candidates — filled by
 *                                  lib/buyer-search/investor-offmarket-
 *                                  runner.ts on the platform's acquisition
 *                                  lane, never by a live pull from inside a
 *                                  customer chat). Rows pass through the
 *                                  SAME reader-boundary redaction the portal
 *                                  cards use (lib/buyer-search/investor-
 *                                  facing.ts::toInvestorFacingCandidates —
 *                                  wave 68/69: "we don't want the investor
 *                                  to try and buy directly to the owner").
 *                                  Identity-gated (the investor's OWN
 *                                  contact row) and persona-gated (investor).
 *
 * TOMBSTONE (CLAUDE.md §1): `toInvestorFacingToolRow` / `toIsaFacingToolRow`
 * / `InvestorFacingPropertyRow` moved here from lib/ai-isa/batchdata-isa-
 * tools.ts (their only remaining reader is the off-market tool below; the
 * BatchData file no longer maps property rows at all).
 */

import { tool } from "ai"
import { z } from "zod"
import { createServiceClient } from "@/lib/supabase/service"
import { deriveLikelihoodBand } from "@/lib/buyer-search/investor-offmarket-match"
import { toInvestorFacingCandidates } from "@/lib/buyer-search/investor-facing"
import { lookupPropertyForConversation } from "@/lib/ai-isa/property-lookup-rail"
import type { CustomerCapabilityContext } from "@/lib/ai-isa/capability-catalogue"

/** A raw property row of any provider/cache shape (moved from batchdata-isa-tools.ts). */
export type PropertyRowLike = Record<string, unknown>

// ─── INVESTOR REDACTION — property fields ONLY (moved from batchdata-isa-tools.ts) ──
// An ALLOWLIST, not a blacklist: a raw row's shape is not one this repo
// controls, so an allowlist can never leak a field its author did not
// anticipate. lib/buyer-search/investor-facing.ts's blacklist redaction is
// applied FIRST on the typed cache row; this mapper then shapes what the model sees.
export interface InvestorFacingPropertyRow {
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  estimatedValue: number | null
  beds: number | null
  baths: number | null
  propertyType: string | null
  quickListTags: string[]
  likelihoodBand: "high" | "medium" | "low"
  /** "batchrank" when a licensed BatchRank verdict was on the row, "signal-based" when
   *  derived from quicklists — the portal UI must label the difference (wave 69). */
  likelihoodBandSource: "batchrank" | "signal-based"
}

function readBatchrankBand(row: PropertyRowLike): "high" | "medium" | "low" | null {
  const intel = row.intel as Record<string, unknown> | undefined
  const raw = intel?.salePropensityCategory ?? row.batchRankCategory ?? row.batchrankCategory ?? row.batchrank_band ?? null
  const s = typeof raw === "string" ? raw.toLowerCase() : null
  return s === "high" || s === "medium" || s === "low" ? s : null
}

/** @proofSeam the investor persona's row mapper — asserted by scripts/batchdata-isa-tools-
 *  simulator.ts against a fixture carrying owner_name/owner_phone/owner_email/equity fields
 *  (positive control: the SAME fixture read through toIsaFacingToolRow still carries them). */
export function toInvestorFacingToolRow(row: PropertyRowLike): InvestorFacingPropertyRow {
  const addr = (row.address as Record<string, unknown>) ?? {}
  const building = (row.building as Record<string, unknown>) ?? {}
  const valuation = (row.valuation as Record<string, unknown>) ?? {}
  const quickListsRaw =
    (Array.isArray(row.quickLists) && row.quickLists) ||
    (Array.isArray(row.quick_lists) && row.quick_lists) ||
    (Array.isArray(row.quicklists) && row.quicklists) ||
    (Array.isArray(row.tags) && row.tags) ||
    []
  const quickListTags = (quickListsRaw as unknown[]).filter((x): x is string => typeof x === "string")
  const { band, source } = deriveLikelihoodBand(quickListTags, readBatchrankBand(row))

  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null)
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

  return {
    address: str(addr.street) ?? str(row.propertyAddress) ?? str(row.property_address) ?? str(row.address) ?? null,
    city: str(addr.city) ?? str(row.propertyCity) ?? str(row.city) ?? null,
    state: str(addr.state) ?? str(row.propertyState) ?? str(row.state) ?? null,
    zip: str(addr.zip) ?? str(row.propertyZip) ?? str(row.zip) ?? null,
    estimatedValue: num(valuation.estimatedValue) ?? num(row.estimatedValue) ?? num(row.estimated_value) ?? null,
    beds: num(building.bedroomCount) ?? num(row.beds) ?? null,
    baths: num(building.bathroomCount) ?? num(row.baths) ?? null,
    propertyType: str(building.propertyType) ?? str(row.propertyType) ?? str(row.property_type) ?? null,
    quickListTags,
    likelihoodBand: band,
    likelihoodBandSource: source,
  }
}

/** Identity mapper — the positive control the proof reads the SAME fixture through. */
export function toIsaFacingToolRow(row: PropertyRowLike): PropertyRowLike {
  return row
}

// ─── TOOL BUILDERS ──────────────────────────────────────────────────────────

const AddressShape = {
  street: z.string().describe("Street address line, e.g. '123 Main St'"),
  city: z.string().nullable().describe("City, or null"),
  state: z.string().nullable().describe("Two-letter state code, or null"),
  zip: z.string().nullable().describe("ZIP code, or null"),
}

/**
 * lookup_property_facts — free-ranked, identity-optional. The rail never
 * reaches BatchData for purpose "conversation"; the audience is always
 * "customer" on a persona surface, so no valuation figure is returned.
 */
export function buildLookupPropertyFactsTool(ctx: CustomerCapabilityContext) {
  return tool({
    description:
      "Look up the FACTS of one property by address — beds, baths, square feet, year built, property type, and whether it is one of our active listings (with its list price). Cheapest source first: our own records, the brokerage's MLS feed, then a public listing/records lookup. NEVER returns a home value or estimate: if the person wants to know what a home is worth, offer schedule_home_value_review (the agent brings the number). Use when someone asks about a specific address.",
    inputSchema: z.object(AddressShape),
    execute: async (args: { street: string; city: string | null; state: string | null; zip: string | null }) => {
      const r = await lookupPropertyForConversation({
        brokerageId: ctx.brokerageId,
        purpose: "conversation",
        audience: "customer",
        address: { street: args.street, city: args.city, state: args.state, zip: args.zip },
        contactId: ctx.contactId ?? null,
        agentId: ctx.agentId ?? null,
      })
      if (!r.found || !r.facts) {
        return {
          success: false,
          error: "No record found for that address from our own records, the MLS feed or public sources. Confirm the address with the person; if they own it and want its value reviewed, offer schedule_home_value_review.",
          rungsTried: r.rungsTried,
        }
      }
      return { success: true, facts: r.facts, rungsTried: r.rungsTried }
    },
  })
}

/**
 * search_offmarket_opportunities — the investor persona's own cached
 * off-market / most-likely-to-sell matches. Own-DB read only.
 */
export function buildSearchOffmarketOpportunitiesTool(ctx: CustomerCapabilityContext & { contactId: string }) {
  return tool({
    description:
      "For an INVESTOR: list the off-market / most-likely-to-sell properties already matched to their buy box (property facts, likelihood band and signal tags only — never an owner's name or contact details; the brokerage makes any approach). Reads the matches the platform has already found; if there are none yet, say the agent will run a search and offer send_matching_listings for on-market inventory.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(10).nullable().describe("How many to return (default 5, max 10)"),
    }),
    execute: async (args: { limit: number | null }) => {
      const svc = createServiceClient()
      const { data, error } = await svc
        .from("investor_offmarket_candidates")
        .select("property_address, city, state, zip, beds, baths, property_type, estimated_value, quicklists, batchrank_band, fit_score, matched_at, owner_name, equity_percent")
        .eq("brokerage_id", ctx.brokerageId)
        .eq("contact_id", ctx.contactId)
        .is("dismissed_at", null)
        .order("fit_score", { ascending: false })
        .limit(args.limit ?? 5)
      if (error) return { success: false, error: `off-market matches could not be read: ${error.message}` }
      // Reader-boundary redaction FIRST (drops owner_* / equity_percent on the typed
      // row), then the allowlist mapper shapes what the model sees.
      const redacted = toInvestorFacingCandidates((data ?? []) as Array<Record<string, unknown>>, "investor")
      const rows = redacted.map((r) => toInvestorFacingToolRow(r as PropertyRowLike))
      return { success: true, count: rows.length, matches: rows, note: rows.length === 0 ? "No cached matches yet — the agent will run a search against the buy box." : "Property facts only; the brokerage handles any owner approach." }
    },
  })
}
