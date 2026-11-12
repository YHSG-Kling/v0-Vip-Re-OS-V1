/**
 * lib/listings/listing-description-tool.ts — THE AGENT'S AI LISTING-DESCRIPTION
 * TOOL, one server-only seam over the one writer (wave 87, lane 87B).
 *
 * Owner, verbatim (2026-09-28): "listing description can be an ai tool for agents
 * and can assist with a new listing marketing."
 *
 * Lane 86F retired aiGenerateListingDescription (zero callers once the
 * presentation builder moved to lib/listings/listing-description-core.ts). The
 * AGENT-facing capability that door was meant to be is rebuilt HERE, on that same
 * core — never a second writer — and reached from three places:
 *   · the listing surface's description composer (session door:
 *     app/actions/listings-kernel.ts generateListingDescriptionAction);
 *   · the agent copilot (app/api/internal/ai-chat/route.ts, tool
 *     draft_listing_description — session-resolved tenant);
 *   · the new-listing marketing kit (lib/kernel/launch-war-room.ts — the listing
 *     row's tenant), which drafts the description + social caption for the agent
 *     to approve.
 *
 * THE AGENT PICKS THE STYLE (lib/listings/listing-description-styles.ts — one
 * vocabulary, no value-derived rule). COMPLIANCE-FIRST: the core writes with the
 * Fair Housing / brand compliance blocks IN the prompt and grades the MLS copy with
 * postcheckScript + guardContent. Warnings pass through to the agent; a HARD
 * Fair-Housing flag (or a compliance check that could not run — fail closed)
 * WITHHOLDS the copy and leaves it in the approval queue for a human (§5).
 *
 * Nothing here writes listings.public_remarks: the draft lands in
 * listing_marketing_content (the core's save) and in the agent's editor; the
 * agent saves it (saveListingDraftAction) — approval-first.
 *
 * Server-only, never "use server": it trusts the brokerageId it is handed.
 */
import "server-only"
import type { createServiceClient } from "@/lib/supabase/service"
import { generateListingDescriptions } from "@/lib/listings/listing-description-core"
import { normalizeListingDescriptionStyle, type ListingDescriptionStyle } from "@/lib/listings/listing-description-styles"

type Svc = ReturnType<typeof createServiceClient>

type ListingDescriptionDraft =
  | {
      ok: true
      listingId: string
      style: ListingDescriptionStyle
      /** true → the copy below is WITHHELD (hard Fair-Housing flag / check could not run). */
      heldForReview: boolean
      heldReason: string | null
      mlsDescription: string | null
      marketingDescription: string | null
      socialCaption: string | null
      emailTeaser: string | null
      /** postcheckScript + guardContent findings — shown to the agent, never swallowed. */
      warnings: string[]
      contentId: string | null
    }
  | { ok: false; error: string }

/**
 * Pure: may this draft be put in front of the agent to use? Only a HARD
 * Fair-Housing flag or a compliance check that could not run holds it (§5:
 * warnings pass through; nobody-checked never reads as checked-and-fine).
 */
export function descriptionReleaseDecision(input: {
  hardFairHousingFlag: boolean
  guardFailed: boolean
}): { release: true } | { release: false; reason: string } {
  if (input.hardFairHousingFlag) return { release: false, reason: "Held for a human Fair Housing review — the draft is in your approval queue." }
  if (input.guardFailed) return { release: false, reason: "The compliance check could not run — the draft is held rather than shown unchecked." }
  return { release: true }
}

export async function draftListingDescriptionForListing(
  svc: Svc,
  params: {
    /** The VERIFIED tenant — a session's, or the listing row's own. */
    brokerageId: string
    listingId: string
    style?: unknown
    /** users.id for the AI cost ledger actor. */
    actorUserId?: string | null
    /** agents.id of the author when the caller has one; else the listing's agent. */
    actorAgentId?: string | null
    highlights?: string[]
    source: "agent_tool" | "agent_copilot" | "new_listing_kit"
  },
): Promise<ListingDescriptionDraft> {
  const { data: listing, error: listingErr } = await svc
    .from("listings")
    .select("id, agent_id, address, city, state, zip, list_price, bedrooms, bathrooms, sqft, year_built, lot_size, property_type, status, public_remarks")
    .eq("id", params.listingId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()
  if (listingErr) return { ok: false, error: `Listing description: listing read refused: ${listingErr.message}` }
  if (!listing) return { ok: false, error: "Listing description refused: that listing is not in your brokerage." }
  const l = listing as Record<string, any>

  const agentId: string | null = params.actorAgentId ?? l.agent_id ?? null
  if (!agentId) return { ok: false, error: "Listing description refused: the listing has no agent and you have no agent profile." }

  const style = normalizeListingDescriptionStyle(params.style)
  const res = await generateListingDescriptions(svc, {
    brokerageId: params.brokerageId,
    agentId,
    userId: params.actorUserId ?? null,
    listingId: l.id,
    style,
    highlights: params.highlights,
    source: params.source,
    propertyData: {
      address: l.address, city: l.city, state: l.state, zip: l.zip,
      listPrice: l.list_price, beds: l.bedrooms, baths: l.bathrooms, sqft: l.sqft,
      yearBuilt: l.year_built, lotSize: l.lot_size, propertyType: l.property_type, status: l.status,
      // MERGED from the retired Marketing Studio enhancer (enhanceListingDescription,
      // app/actions/ai-marketing-automation.ts — tombstone there): the listing's CURRENT
      // public remarks ride along, so a REWRITE restyles what the agent already wrote
      // rather than inventing past it. Absent on a new listing.
      currentPublicRemarks: typeof l.public_remarks === "string" && l.public_remarks.trim() ? l.public_remarks.trim() : null,
    },
  })
  if (!res.success) return { ok: false, error: res.error }

  const decision = descriptionReleaseDecision({
    hardFairHousingFlag: res.hardFairHousingFlag,
    guardFailed: !!res.guardResult.guardFailed,
  })
  const warnings = [...res.complianceWarnings, ...res.guardResult.violations, ...res.guardResult.notes]
  const d = res.descriptions
  return {
    ok: true,
    listingId: l.id,
    style,
    heldForReview: !decision.release,
    heldReason: decision.release ? null : decision.reason,
    mlsDescription: decision.release ? d.mlsDescription : null,
    marketingDescription: decision.release ? d.marketingDescription : null,
    socialCaption: decision.release ? d.socialCaption : null,
    emailTeaser: decision.release ? d.emailTeaser : null,
    warnings,
    contentId: res.contentId,
  }
}

/**
 * The newest AI description draft on file for a listing (the new-listing kit's, or
 * an earlier tool run's) — what the composer offers to load. Tenant-pinned.
 * A draft the core recorded as hard-flagged is never offered.
 */
export async function latestListingDescriptionDraft(
  svc: Svc,
  params: { brokerageId: string; listingId: string },
): Promise<{ ok: true; draft: { contentId: string; generatedAt: string | null; style: string | null; mlsDescription: string | null; socialCaption: string | null; source: string | null } | null } | { ok: false; error: string }> {
  const { data, error } = await svc
    .from("listing_marketing_content")
    .select("id, content, generated_at")
    .eq("brokerage_id", params.brokerageId)
    .eq("listing_id", params.listingId)
    .eq("content_type", "ai_descriptions")
    .order("generated_at", { ascending: false })
    .limit(5)
  if (error) return { ok: false, error: `Listing description drafts read refused: ${error.message}` }
  for (const row of (data as Array<{ id: string; content: Record<string, any> | null; generated_at: string | null }> | null) ?? []) {
    const c = row.content ?? {}
    if (c.hard_fair_housing_flag === true) continue
    return {
      ok: true,
      draft: {
        contentId: row.id, generatedAt: row.generated_at,
        style: typeof c.style === "string" ? c.style : null,
        mlsDescription: typeof c.mlsDescription === "string" ? c.mlsDescription : null,
        socialCaption: typeof c.socialCaption === "string" ? c.socialCaption : null,
        source: typeof c.source === "string" ? c.source : null,
      },
    }
  }
  return { ok: true, draft: null }
}
