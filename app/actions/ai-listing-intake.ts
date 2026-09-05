"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { generateObject } from "@/lib/ai/generate"
import { resolveModel } from "@/lib/ai/resolve-model"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { guardContent, attachApprovalSubject } from "@/lib/content-guardian"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { z } from "zod"
import { createHash } from "node:crypto"
import { PROPERTY_TYPES } from "@/lib/constants"

// ============================================
// AI LISTING INTAKE SYSTEM
// Complete workflow for agents creating listings
// with state-specific forms, Dotloop integration,
// and AI-powered assistance
// ============================================

// State-specific form configurations
/* The local 3-state `STATE_FORMS` table went with `aiGetRequiredForms`, its only
 * reader (tombstone below). The canonical 50-state registry — which this file
 * already uses from `generateListingAgreement` — is
 * lib/state-forms/registry.ts:STATE_FORMS / getStateForms. */

/* `ListingIntakeData` went with the local `createListing` it typed (tombstone
 * below). The live input shape is the inline parameter object of
 * `createListingWithSellerContact`, app/actions/listings-kernel.ts:145. */

// ============================================
// 1. AI PROPERTY DATA ENRICHMENT
// ============================================
export async function aiEnrichPropertyData(address: string, _agentId?: string) {
  try {
    // Auth gate — burns paid OpenAI inference. Was previously open: any
    // caller could spoof an agentId and trigger AI calls.
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    // NOT `?? ctx.userId` (m359). Everything this reaches is agents-class —
    // ai_usage_log, brand_voice_profile, guardContent, the dotloop loop and
    // aiGenerateListingDescription all key agents(id). The substitution only
    // fired when the caller had no agents row, i.e. exactly when there was
    // nothing for those queries to match anyway; it bought a wrong-class id in
    // place of an honest refusal. This is the spelling test:identity-fallback
    // could not see until m358.
    const agentId = ctx.agentId
    if (!agentId) return { success: false, error: "No agent profile for this user yet — finish account setup." }

    const supabase = await createClient()

    // AI estimate — used for listing-appointment prep when there's no real
    // listing yet (agent is preparing materials for a seller visit). The
    // real MLS pull happens at go-live time (currently manual entry by
    // admin/agent; auto-pull lives in lib/property/enrichment-chain.ts and
    // is used by listing-presentation-builder, not by this action).
    const enrichmentPrompt = `You are a real estate data analyst. Based on this address, estimate property details.
Address: ${address}

Provide realistic estimates in JSON format:
{
  "beds": number,
  "baths": number,
  "sqft": number,
  "yearBuilt": number,
  "lotSize": number,
  "stories": number,
  "garage": number,
  "pool": boolean,
  "propertyType": "single_family" | "condo" | "townhouse" | "multi_family" | "land" | "commercial" | "other",
  "style": "modern" | "traditional" | "craftsman" | "mediterranean" | "contemporary",
  "roofType": string,
  "hvac": string,
  "estimatedValue": number,
  "estimatedRent": number,
  "schoolDistrict": string,
  "walkScore": number,
  "floodZone": string
}`

    const { object: propertyData } = await generateObject({
      model: resolveModel("openai/gpt-4o-mini"),
      schema: z.object({
        beds: z.number(),
        baths: z.number(),
        sqft: z.number(),
        yearBuilt: z.number(),
        lotSize: z.number(),
        stories: z.number(),
        garage: z.number(),
        pool: z.boolean(),
        // Canonical vocabulary (lib/constants PROPERTY_TYPES). This enum used to be
        // narrowed to three values while the surrounding types allowed six, so a
        // multi-family, land or commercial listing was forced to one of the three and
        // silently mis-typed. One list, used everywhere.
        propertyType: z.enum(PROPERTY_TYPES),
        style: z.string(),
        roofType: z.string(),
        hvac: z.string(),
        estimatedValue: z.number(),
        estimatedRent: z.number(),
        schoolDistrict: z.string(),
        walkScore: z.number(),
        floodZone: z.string(),
      }),
      prompt: enrichmentPrompt,
    })

    // Log the enrichment.
    //
    // VERDICT: STAMP. This is the METERING ledger — tokens_used per action — and
    // unstamped it meters to nobody: any per-brokerage cost roll-up keyed on
    // `brokerage_id` misses the row entirely, while `ai_usage_log_select`
    // (`is_platform_admin() OR brokerage_id IS NULL OR has_brokerage_access(...)
    // OR (is_agent_role() AND agent_id = current_user_agent_id())`, granted to
    // `authenticated`) lets every signed-in user of every OTHER brokerage read it
    // through the NULL clause. The agent keeps their own rows via that last
    // clause, so stamping costs them nothing.
    //
    // CONVENTION MATCHED, not invented: the sibling metering writer
    // lib/ai/cost-tracking.ts::logAIUsage stamps `ai_tool_usage.brokerage_id`
    // from a session-resolved tenant and console.errors a refused insert rather
    // than swallowing it. Same shape here.
    //
    // TENANT SOURCE IS THE SESSION. `ctx` came from getAgentContext() at the top
    // of this function; the `_agentId` parameter is deliberately ignored, so
    // neither the agent nor the brokerage on this row is the caller's to name.
    //
    // The error is destructured because the enclosing try/catch CANNOT see it —
    // supabase-js resolves a refused insert, so a rejected metering write was
    // vanishing silently and the spend went unbilled.
    const { error: usageLogError } = await supabase.from("ai_usage_log").insert({
      agent_id: agentId,
      brokerage_id: ctx.brokerageId,
      action_type: "property_enrichment",
      input_data: { address },
      output_data: propertyData,
      tokens_used: 500,
    })
    if (usageLogError) {
      console.error("[AI Listing Intake] ai_usage_log insert refused (enrichment unmetered):", usageLogError.message)
    }

    return { success: true, data: propertyData }
  } catch (error) {
    console.error("[AI Listing Intake] Enrichment error:", error)
    return handleError(error, "aiEnrichPropertyData")
  }
}

// ============================================
// 2. AI STATE FORM RECOMMENDER
// ============================================
/* ───────────────────────────────────────────────────────────────────────────────
 * TOMBSTONE — `aiGetRequiredForms` was REMOVED (orphan census, category C).
 *
 * SURVIVOR: `getStateForms(state, "listing")` at lib/state-forms/registry.ts:258
 * (with `getBrokerageRepresentationForm` beside it at :277).
 *
 * IT BECAME AN ORPHAN IN THIS SAME CHANGE, and that is stated plainly rather
 * than glossed: its ONLY caller was `runCompleteListingIntake`, deleted below as
 * a duplicate. Rather than leave a stranded export, it gets its own verdict —
 * and the verdict is that the capability already lives elsewhere, better.
 *
 * THE SURVIVOR IS STRICTLY BETTER, AND THIS FILE ALREADY USES IT. The registry's
 * own header names `app/actions/ai-listing-intake.ts:generateListingAgreement()`
 * as a consumer — so the function in this file that actually runs asks the
 * registry the same question this one answered from a private table:
 *   · COVERAGE: the registry defines ALL 50 STATES explicitly. This function's
 *     local `STATE_FORMS` had THREE — TX, CA, FL — plus a `DEFAULT`.
 *   · THE DEFAULT WAS THE DEFECT. An agent listing in Georgia got
 *     STATE_FORMS.DEFAULT: "Listing Agreement", "Seller's Disclosure",
 *     "Lead-Based Paint Disclosure", "Agency Disclosure" — generic names for a
 *     state whose forms are GAR-numbered. The registry has NO default and
 *     THROWS on an unrecognised state ("Forms unavailable — verify the property
 *     address"), because the property address dictates the forms and a plausible
 *     wrong answer about required disclosures is worse than a refusal.
 *
 * NOT MERGED, with the reason, because two things here have no home on the
 * survivor and pretending otherwise would be the lie this tombstone exists to
 * prevent:
 *
 *   1. THE CONDITIONAL ADDITIONS (HOA package, Pool Safety Disclosure, pre-1978
 *      lead paint, short-sale addendum + lender authorization). These are REAL
 *      product logic and the registry does not have them — StateFormBundle is
 *      { required, addenda, brokerageRepresentation } with no conditional arm.
 *      They are NOT carried over as-is because they were free-text English
 *      names ("HOA Disclosure Package") against a 3-state table, while the
 *      survivor's consumers route FORM IDS to Dotloop and the form library; a
 *      name that is not an id resolves to nothing downstream. Recorded as an
 *      OPEN ITEM on lib/state-forms/registry.ts — per-state conditional addenda
 *      keyed by the same id vocabulary — not as a capability that moved.
 *
 *   2. THE AI "additional forms" STEP. Deliberately NOT carried over. It asked a
 *      model to "list only the form names, one per line" as FREE TEXT, with no
 *      schema and no validation against any form that exists, then returned the
 *      lines as `aiRecommended`. That is the same confabulation shape already
 *      tombstoned in this file for `aiOptimizePhotoOrder` — a model inventing
 *      identifiers for a compliance surface. Required-disclosure lists are the
 *      last place to accept invented names.
 * ────────────────────────────────────────────────────────────────────────────── */

// ============================================
// 3. AI LISTING DESCRIPTION GENERATOR
// ============================================
export async function aiGenerateListingDescription(params: {
  agentId?: string  // ignored — derived from session
  propertyData: any
  style: "luxury" | "family" | "investor" | "first_time_buyer"
  highlights?: string[]
  neighborhood?: string
}) {
  try {
    // Auth gate — burns paid OpenAI inference. Previously accepted a
    // caller-supplied agentId and "fell back" to looking it up in the DB
    // when the session user didn't match, which let any caller drive
    // generation under any other agent's brokerage + brand-voice context.
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    const brokerageId = ctx.brokerageId
    // NOT `?? ctx.userId` (m359). Everything this reaches is agents-class —
    // ai_usage_log, brand_voice_profile, guardContent, the dotloop loop and
    // aiGenerateListingDescription all key agents(id). The substitution only
    // fired when the caller had no agents row, i.e. exactly when there was
    // nothing for those queries to match anyway; it bought a wrong-class id in
    // place of an honest refusal. This is the spelling test:identity-fallback
    // could not see until m358.
    const agentId = ctx.agentId
    if (!agentId) return { success: false, error: "No agent profile for this user yet — finish account setup." }

    const supabase = await createClient()

    // Get agent's brand voice
    const { data: brandVoice } = await supabase
      .from("brand_voice_profile")
      .select("*")
      .eq("agent_id", agentId)
      .maybeSingle()

    const { object: descriptions } = await generateObject({
      model: resolveModel("openai/gpt-4o"),
      schema: z.object({
        mlsDescription: z.string().describe("MLS-compliant description, 500 chars max, no superlatives"),
        marketingDescription: z.string().describe("Marketing headline and paragraph for websites"),
        socialCaption: z.string().describe("Instagram/Facebook caption with hashtags"),
        emailTeaser: z.string().describe("Email preview text, 150 chars"),
        videoScript: z.string().describe("30-second video walkthrough script"),
        seoTitle: z.string().describe("SEO-optimized page title"),
        seoDescription: z.string().describe("Meta description for search engines"),
      }),
      prompt: `You are a real estate copywriter. Generate multiple descriptions for this listing.

Property Details:
${JSON.stringify(params.propertyData, null, 2)}

Target Audience: ${params.style}
Highlights: ${params.highlights?.join(", ") || "None specified"}
Neighborhood: ${params.neighborhood || "Not specified"}
${brandVoice ? `Brand Voice: ${brandVoice.tone}, ${brandVoice.style}` : ""}

IMPORTANT RULES:
- MLS description must be factual, no "best" or "amazing"
- Include Fair Housing compliant language
- Marketing can be more persuasive
- Social should be engaging with relevant hashtags
- All content must be original`,
    })

    // Run compliance + BrandVoice guard on MLS description (the regulated channel)
    const guardResult = await guardContent({
      content:     descriptions.mlsDescription,
      agentId,
      brokerageId,
      contentType: "listing_description",
    }).catch((err) => {
      console.error("[compliance-guard] guardContent threw — treating as guard failure:", err)
      return { flagged: false, guardFailed: true, violations: [], notes: [], content: "", brandVoiceChecked: false, approvalItemId: null }
    })

    // Save generated content. listing_marketing_content is listing/brokerage-scoped
    // (no agent_id/status/target_audience columns) — the audience/style folds into
    // the content blob like the canonical ai-marketing-automation writer.
    //
    // The id is SELECTED now because it is the subject a flagged approval_items row
    // points at. This path generates text before any row exists, so the scan
    // (which must run first — see the ordering ruling in lib/content-guardian)
    // could not name it; the link is stamped immediately after, below.
    const { data: savedContent, error: savedContentError } = await supabase
      .from("listing_marketing_content")
      .insert({
        brokerage_id: brokerageId,
        content_type: "ai_descriptions",
        content: { ...descriptions, target_audience: params.style },
      })
      .select("id")
      .single()
    if (savedContentError) {
      console.error("[AI Listing Intake] listing_marketing_content insert failed:", savedContentError)
    }

    // `approval_items.item_id` — the column the reviewer opens. Called
    // unconditionally: it is a no-op when nothing was flagged (approvalItemId is
    // null) or when the save above was refused, and never throws.
    await attachApprovalSubject(
      (guardResult as { approvalItemId?: string | null }).approvalItemId,
      (savedContent?.id as string | null) ?? null,
    )

    return {
      success: true,
      descriptions,
      guardResult: {
        flagged:    guardResult.flagged,
        violations: guardResult.violations,
        notes:      guardResult.notes,
      },
    }
  } catch (error) {
    console.error("[AI Listing Intake] Description error:", error)
    return handleError(error, "aiGenerateListingDescription")
  }
}

// ============================================
// 4. AI PRICING RECOMMENDATION
// ============================================
/**
 * THE ONE LIST-PRICE RECOMMENDER.
 *
 * MERGED IN (consolidation): `app/actions/ai-market-intelligence.ts:predictPropertyPrice`
 * was a second, caller-less model of the same subject — "what should this
 * property be priced at" — and it has been deleted in favour of this one (see the
 * tombstone at ai-market-intelligence.ts:169). Two things it did that this one did
 * not, both carried over here BEFORE the delete:
 *
 *   1. IT FETCHED ITS OWN COMPARABLES. This action took `comparables` as an
 *      optional parameter and its only surface — ListingIntelligenceCard — has
 *      never supplied any, so every price recommendation the product has ever
 *      shown an agent was generated from the literal string "No comps provided"
 *      (see the note in app/components/dashboard/listings/lifecycle/
 *      listing-intelligence-card.tsx, which flags exactly this). A pricing
 *      opinion with no comps behind it is a guess wearing a number. When the
 *      caller supplies none, the brokerage's own sold inventory in the same zip
 *      and an adjacent-bedroom band is now read and used.
 *   2. IT REPORTED CONFIDENCE, POSITIONING AND TIMING. `confidenceLevel`,
 *      `marketPositioning`, `comparablesSummary` and `marketTiming` are its
 *      output fields, folded into the schema below.
 *
 * `comparableCount`/`comparableSource` are returned so a surface can say WHERE the
 * number came from — an estimate built on zero comps must be legible as one and
 * must never be rendered with the same confidence as one built on twenty.
 */
export async function aiSuggestListPrice(params: {
  agentId?: string  // ignored — derived from session
  propertyData: any
  /** Supply comps to use them verbatim; omit and the brokerage's sold inventory is read. */
  comparables?: any[]
  marketConditions?: "hot" | "balanced" | "cooling"
  motivation?: "quick_sale" | "maximize_price" | "balanced"
}) {
  try {
    // Auth gate — burns paid OpenAI inference.
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }

    // ── Comparables ──────────────────────────────────────────────────────────
    // Caller-supplied comps win. Otherwise fetch them, tenant-anchored: comps
    // come from the caller's OWN brokerage's sold inventory and nowhere else.
    // Columns verified live: listings.zip (text), listings.status CHECK includes
    // 'sold', listings.bedrooms (int), listings.go_live_date (date). There is no
    // listings.close_date, so recency orders by go_live_date.
    let comparables: any[] = Array.isArray(params.comparables) ? params.comparables : []
    let comparableSource: "caller" | "brokerage_sold" | "none" =
      comparables.length > 0 ? "caller" : "none"

    if (comparables.length === 0) {
      const zip = params.propertyData?.zipCode ?? params.propertyData?.zip ?? null
      const beds = Number(params.propertyData?.bedrooms)
      if (typeof zip === "string" && zip.trim().length > 0) {
        const supabase = await createClient()
        let compQuery = supabase
          .from("listings")
          .select("address, city, state, zip, list_price, bedrooms, bathrooms, sqft, property_type, go_live_date, sold_date")
          .eq("brokerage_id", ctx.brokerageId)
          .eq("zip", zip.trim())
          .eq("status", "sold")
          .order("go_live_date", { ascending: false })
          .limit(20)
        if (Number.isFinite(beds)) {
          compQuery = compQuery.gte("bedrooms", beds - 1).lte("bedrooms", beds + 1)
        }
        // supabase-js RESOLVES a refused query — an unread error here would be
        // indistinguishable from "this brokerage has sold nothing in this zip",
        // and the model would then be told there are no comps when in fact the
        // read was blocked. Surfaced rather than silently downgraded.
        const { data: comps, error: compsError } = await compQuery
        if (compsError) {
          return { success: false, error: `Could not read comparable sales: ${compsError.message}` }
        }
        if (comps && comps.length > 0) {
          comparables = comps
          comparableSource = "brokerage_sold"
        }
      }
    }

    const { object: pricing } = await generateObject({
      model: resolveModel("openai/gpt-4o"),
      schema: z.object({
        suggestedListPrice: z.number(),
        priceRangeLow: z.number(),
        priceRangeHigh: z.number(),
        pricePerSqFt: z.number(),
        daysOnMarketEstimate: z.number(),
        competitivePosition: z.enum(["aggressive", "market", "premium"]),
        // ── carried from predictPropertyPrice ──
        confidenceLevel: z.enum(["high", "medium", "low"]),
        marketPositioning: z.enum(["below_market", "at_market", "above_market"]),
        comparablesSummary: z.string(),
        marketTiming: z.object({
          recommendation: z.enum(["list_now", "wait", "price_aggressively"]),
          reasoning: z.string(),
        }),
        // ──────────────────────────────────────
        reasoning: z.string(),
        adjustments: z.array(
          z.object({
            factor: z.string(),
            impact: z.number(),
            explanation: z.string(),
          })
        ),
        marketAnalysis: z.string(),
      }),
      prompt: `You are a real estate pricing expert. Analyze and recommend list price.

Property:
${JSON.stringify(params.propertyData, null, 2)}

Comparables (${comparables.length} ${comparableSource === "brokerage_sold" ? "sold listings from this brokerage in the same zip" : comparableSource === "caller" ? "supplied by the caller" : "available"}):
${comparables.length ? JSON.stringify(comparables, null, 2) : "NONE. State this plainly in comparablesSummary and set confidenceLevel to 'low' — do not present a comp-free estimate as if it were comp-supported."}

Market Conditions: ${params.marketConditions || "balanced"}
Seller Motivation: ${params.motivation || "balanced"}

Provide:
1. Suggested list price with reasoning
2. Price range (low to high)
3. Estimated days on market
4. Key adjustments from comps
5. Market positioning strategy
6. Your confidence, and a one-line summary of what the comparables actually support
7. Market timing advice`,
    })

    return {
      success: true,
      pricing,
      comparableCount: comparables.length,
      comparableSource,
    }
  } catch (error) {
    console.error("[AI Listing Intake] Pricing error:", error)
    return handleError(error, "aiSuggestListPrice")
  }
}

// ============================================
// 5. AI COMPLIANCE CHECKER
// ============================================
/**
 * THE LISTING-COPY COMPLIANCE GATE.
 *
 * activity_type written when this action reviews a REAL listing's public copy.
 * One spelling, used by the writer below and by getListingCopyComplianceGate —
 * a second spelling would make the gate read nothing and report "clean".
 */
const LISTING_COPY_REVIEW_ACTIVITY = "listing.copy.compliance_reviewed"

/**
 * Fingerprint of the exact text that was reviewed.
 *
 * A finding is only about the words it was made against. Without this, editing
 * the remarks would leave the old violation blocking a launch that no longer
 * contains it — or, worse, a CLEAN review would keep vouching for copy the agent
 * has since rewritten. Short sha256 over the trimmed text; not a secret, just an
 * identity for the string.
 */
function listingCopyFingerprint(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex").slice(0, 32)
}

export async function aiCheckListingCompliance(params: {
  agentId?: string  // ignored — derived from session
  description: string
  photos?: string[]
  state: string
  /**
   * When this review is about a REAL listing, its id. Supplying it makes the
   * review part of that listing's record (an `activities` row carrying the
   * listing_id COLUMN, which is what every listing-scoped reader filters on)
   * and lets the launch gate see the finding. Omitted by runCompleteListingIntake,
   * which reviews copy for a listing that does not exist yet.
   */
  listingId?: string
}) {
  try {
    // Auth gate — was previously fully open (no auth check at all).
    // Burns paid OpenAI inference.
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }

    // A listing-scoped review must be about a listing THIS caller can act on.
    // Resolved before the model call so an out-of-tenant id cannot burn inference.
    const supabase = await createClient()
    let scopedListingId: string | null = null
    if (params.listingId) {
      if (!isValidUUID(params.listingId)) {
        return { success: false, error: "Invalid listing ID" }
      }
      const { data: listing, error: listingError } = await supabase
        .from("listings")
        .select("id, brokerage_id")
        .eq("id", params.listingId)
        .maybeSingle()
      if (listingError) {
        return { success: false, error: `Could not load listing: ${listingError.message}` }
      }
      if (!listing || listing.brokerage_id !== ctx.brokerageId) {
        return { success: false, error: "Forbidden" }
      }
      scopedListingId = listing.id as string
    }

    const { object: compliance } = await generateObject({
      model: resolveModel("openai/gpt-4o"),
      schema: z.object({
        isCompliant: z.boolean(),
        overallScore: z.number().min(0).max(100),
        issues: z.array(
          z.object({
            severity: z.enum(["critical", "warning", "suggestion"]),
            category: z.string(),
            issue: z.string(),
            suggestion: z.string(),
            location: z.string().optional(),
          })
        ),
        fairHousingCheck: z.object({
          passed: z.boolean(),
          flaggedPhrases: z.array(z.string()),
        }),
        mlsCompliance: z.object({
          passed: z.boolean(),
          issues: z.array(z.string()),
        }),
        suggestedRevisions: z.string().optional(),
      }),
      prompt: `You are a real estate compliance officer for ${params.state}. Review this listing for compliance issues.

Listing Description:
${params.description}

Check for:
1. Fair Housing violations (no discriminatory language)
2. MLS compliance (no unauthorized claims, proper format)
3. State-specific requirements for ${params.state}
4. Accuracy of claims
5. Required disclosures

Be thorough - missing compliance can result in fines or license issues.`,
    })

    // RECORD IT AGAINST THE LISTING. A Fair Housing finding that lives only in
    // the browser tab it was rendered in is not a compliance record — the broker
    // cannot produce it, the launch gate cannot see it, and re-opening the page
    // loses it. Written to `activities` with the listing_id COLUMN set, which is
    // what the lifecycle page and every other listing-scoped reader filter on.
    let recorded = false
    if (scopedListingId) {
      const criticalIssues = compliance.issues.filter((i) => i.severity === "critical")
      const { error: activityError } = await supabase.from("activities").insert({
        brokerage_id:  ctx.brokerageId,
        // agents-class id (activities.agent_id FKs agents(id)). Null when the
        // caller has no agents row — an honest absence, never ctx.userId.
        agent_id:      ctx.agentId,
        agent_user_id: ctx.userId || null,
        listing_id:    scopedListingId,
        entity_type:   "listing",
        entity_id:     scopedListingId,
        activity_type: LISTING_COPY_REVIEW_ACTIVITY,
        title:         "Listing copy compliance review",
        description:   compliance.isCompliant
          ? `Public copy reviewed for ${params.state} — no blocking issues (score ${compliance.overallScore}/100)`
          : `Public copy reviewed for ${params.state} — ${criticalIssues.length} critical, ${compliance.fairHousingCheck.flaggedPhrases.length} Fair Housing phrase(s) flagged`,
        status:        "completed",
        completed_at:  new Date().toISOString(),
        notes: JSON.stringify({
          state:              params.state,
          overall_score:      compliance.overallScore,
          is_compliant:       compliance.isCompliant,
          fair_housing_passed: compliance.fairHousingCheck.passed,
          flagged_phrases:    compliance.fairHousingCheck.flaggedPhrases,
          mls_passed:         compliance.mlsCompliance.passed,
          mls_issues:         compliance.mlsCompliance.issues,
          critical_issues:    criticalIssues.map((i) => i.issue),
          // The words this verdict is about. The gate refuses to apply a finding
          // to copy that has since been rewritten.
          description_fingerprint: listingCopyFingerprint(params.description),
        }),
      })
      // supabase-js RESOLVES a rejected insert. Dropping this would leave the
      // action reporting a compliance review that was never recorded.
      if (activityError) {
        console.error("[AI Listing Intake] compliance review NOT recorded:", activityError.message)
      } else {
        recorded = true
        revalidatePath(`/dashboard/listings/${scopedListingId}/lifecycle`)
      }
    }

    return { success: true, compliance, recorded }
  } catch (error) {
    console.error("[AI Listing Intake] Compliance error:", error)
    return handleError(error, "aiCheckListingCompliance")
  }
}

/**
 * THE READ SIDE OF THE GATE — what the launch surface is allowed to conclude.
 *
 * aiCheckListingCompliance can tell an agent their public remarks contain a Fair
 * Housing violation. Nothing consumed that: the listing could go to the MLS with
 * the violation still in it, because the launch checklist's only compliance input
 * was auditListingDocuments — a DOCUMENT check that never looks at the marketing
 * copy at all.
 *
 * Returns blockers ONLY for a finding made against the copy as it stands now. If
 * the remarks changed since the review, the finding is reported STALE rather than
 * enforced — enforcing a verdict about words that are no longer there would hold
 * a launch for a violation the agent already fixed.
 */
export async function getListingCopyComplianceGate(listingId: string): Promise<{
  success: boolean
  reviewed: boolean
  stale: boolean
  reviewedAt: string | null
  blockers: string[]
  error?: string
}> {
  const empty = { reviewed: false, stale: false, reviewedAt: null, blockers: [] as string[] }
  if (!isValidUUID(listingId)) {
    return { success: false, ...empty, error: "Invalid listing ID" }
  }

  const supabase = await createClient()

  // RLS scopes both reads to the caller's brokerage. `error` is destructured on
  // BOTH — `const { data }` on a failed read is indistinguishable from "clean",
  // and a compliance gate that reads clean on failure is the whole defect class.
  const [{ data: listing, error: listingError }, { data: rows, error: activityError }] =
    await Promise.all([
      supabase.from("listings").select("public_remarks").eq("id", listingId).maybeSingle(),
      supabase
        .from("activities")
        .select("created_at, notes")
        .eq("listing_id", listingId)
        .eq("activity_type", LISTING_COPY_REVIEW_ACTIVITY)
        .order("created_at", { ascending: false })
        .limit(1),
    ])

  if (listingError || activityError) {
    // Silence is not consent: a gate that could not run says so, and the caller
    // surfaces it as a blocker rather than waving the launch through.
    return {
      success: false,
      ...empty,
      error: listingError?.message ?? activityError?.message ?? "Gate could not run",
    }
  }

  const latest = (rows ?? [])[0]
  if (!latest) return { success: true, ...empty }

  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse((latest.notes as string | null) ?? "{}") as Record<string, unknown>
  } catch {
    return { success: true, reviewed: true, stale: true, reviewedAt: latest.created_at as string, blockers: [] }
  }

  const currentRemarks = ((listing?.public_remarks as string | null) ?? "").trim()
  const reviewedFingerprint = String(parsed.description_fingerprint ?? "")
  const stale =
    !currentRemarks ||
    !reviewedFingerprint ||
    listingCopyFingerprint(currentRemarks) !== reviewedFingerprint

  const blockers: string[] = []
  if (!stale) {
    const flagged = Array.isArray(parsed.flagged_phrases) ? (parsed.flagged_phrases as string[]) : []
    const critical = Array.isArray(parsed.critical_issues) ? (parsed.critical_issues as string[]) : []
    if (parsed.fair_housing_passed === false || flagged.length > 0) {
      blockers.push(
        flagged.length > 0
          ? `Fair Housing: listing copy still contains ${flagged.map((p) => `"${p}"`).join(", ")}`
          : "Fair Housing: listing copy failed review",
      )
    }
    for (const issue of critical) {
      blockers.push(`Listing copy: ${issue}`)
    }
  }

  return { success: true, reviewed: true, stale, reviewedAt: latest.created_at as string, blockers }
}

// ============================================
// 6. DOTLOOP INTEGRATION - CREATE OR PULL LOOP
// ============================================
export async function createOrPullDotloop(params: {
  agentId?: string  // ignored — derived from session
  listingId?: string
  propertyAddress: string
  sellerId: string
  transactionType: "listing" | "purchase"
  existingLoopId?: string
}) {
  try {
    // CRITICAL auth gate — was previously taking caller-supplied agentId,
    // resolving it to a brokerage, then using THAT brokerage's stored
    // Dotloop OAuth credentials to call the Dotloop API. Any caller could
    // create/pull loops on any other brokerage's Dotloop account.
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    const brokerageId = ctx.brokerageId

    const supabase = await createClient()

    // Verify the listing (if linking) belongs to caller's brokerage
    if (params.listingId && isValidUUID(params.listingId)) {
      const { data: listingRow } = await supabase
        .from("listings").select("brokerage_id").eq("id", params.listingId).maybeSingle()
      if (!listingRow || listingRow.brokerage_id !== brokerageId) {
        return { success: false, error: "Forbidden: listing not in your brokerage" }
      }
    }

    const serviceClient = createServiceClient()
    const { data: dotloopCred } = await serviceClient
      .from("platform_credentials")
      .select("access_token, account_id")
      .eq("brokerage_id", brokerageId)
      .eq("platform", "dotloop")
      .eq("is_active", true)
      .maybeSingle()
    if (!dotloopCred?.access_token || !dotloopCred?.account_id) {
      return {
        success: false,
        error: "Dotloop is not configured for your brokerage. Go to Settings > Integrations.",
        notConfigured: true,
      }
    }
    const DOTLOOP_API_KEY = dotloopCred.access_token
    const DOTLOOP_PROFILE_ID = dotloopCred.account_id

    // All three Dotloop calls now route through callConnector — single egress, healer-observable,
    // never-throws contract, per-brokerage credentials preserved. The three bare `fetch(...)` calls
    // (loop retrieval, document listing, loop creation) bypassed every layer of the canonical
    // egress pipeline.
    const DOTLOOP_BASE = "https://api-gateway.dotloop.com/public/v2"

    // If existing loop, pull data from it
    if (params.existingLoopId) {
      const loopRes = await callConnector<{ data?: unknown }>({
        connector: "dotloop",
        baseUrl:   DOTLOOP_BASE,
        path:      `/profile/${DOTLOOP_PROFILE_ID}/loop/${params.existingLoopId}`,
        method:    "GET",
        auth:      { style: "bearer", token: DOTLOOP_API_KEY },
      })

      if (!loopRes.ok) {
        throw new Error(`Dotloop API error: ${loopRes.error ?? `HTTP ${loopRes.status ?? "?"}`}`)
      }

      // Get documents — failure here is non-fatal; the loop pull still succeeds with an empty docs list.
      const docsRes = await callConnector<{ data?: unknown[] }>({
        connector: "dotloop",
        baseUrl:   DOTLOOP_BASE,
        path:      `/profile/${DOTLOOP_PROFILE_ID}/loop/${params.existingLoopId}/folder`,
        method:    "GET",
        auth:      { style: "bearer", token: DOTLOOP_API_KEY },
      })

      return {
        success: true,
        loopId: params.existingLoopId,
        loopData: loopRes.data?.data,
        documents: docsRes.ok ? (docsRes.data?.data ?? []) : [],
        pulled: true,
      }
    }

    // Create new loop
    const response = await callConnector<{ data?: { loop_id?: string } }>({
      connector: "dotloop",
      baseUrl:   DOTLOOP_BASE,
      path:      `/profile/${DOTLOOP_PROFILE_ID}/loop`,
      method:    "POST",
      auth:      { style: "bearer", token: DOTLOOP_API_KEY },
      body: {
        name: `${params.propertyAddress} - ${params.transactionType === "listing" ? "Listing" : "Purchase"}`,
        status: "Active",
        transaction_type: params.transactionType === "listing" ? "Listing for Sale" : "Purchase",
        street_address: params.propertyAddress,
      },
    })

    if (!response.ok) {
      throw new Error(`Dotloop API error: ${response.error ?? `HTTP ${response.status ?? "?"}`}`)
    }

    const loopId = response.data?.data?.loop_id

    // Update listing with loop ID — ownership verified above
    if (params.listingId) {
      await supabase.from("listings")
        .update({ dotloop_loop_id: loopId })
        .eq("id", params.listingId)
        .eq("brokerage_id", brokerageId)
    }

    return {
      success: true,
      loopId,
      loopUrl: `https://www.dotloop.com/loop/${loopId}`,
      created: true,
    }
  } catch (error) {
    console.error("[AI Listing Intake] Dotloop error:", error)
    return handleError(error, "createOrPullDotloop")
  }
}

// ============================================
// 7. AI DOCUMENT STATUS CHECKER
// ============================================
export async function aiCheckDocumentStatus(params: { loopId: string; agentId?: string }) {
  try {
    // Same Dotloop credential-leak fix as createOrPullDotloop — derive
    // brokerage from session, never trust caller-supplied agentId.
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    const brokerageId = ctx.brokerageId

    const serviceClient2 = createServiceClient()
    const { data: dotloopCred2 } = await serviceClient2
      .from("platform_credentials")
      .select("access_token, account_id")
      .eq("brokerage_id", brokerageId)
      .eq("platform", "dotloop")
      .eq("is_active", true)
      .maybeSingle()
    if (!dotloopCred2?.access_token || !dotloopCred2?.account_id) {
      return {
        success: false,
        error: "Dotloop is not configured for your brokerage. Go to Settings > Integrations.",
        notConfigured: true,
      }
    }
    const DOTLOOP_API_KEY = dotloopCred2.access_token
    const DOTLOOP_PROFILE_ID = dotloopCred2.account_id

    // Fetch documents from Dotloop — routed through callConnector for single egress + healer
    // observability (matches the three other Dotloop calls in this file).
    const response = await callConnector<{ data?: Array<{ name?: string; documents?: any[] }> }>({
      connector: "dotloop",
      baseUrl:   "https://api-gateway.dotloop.com/public/v2",
      path:      `/profile/${DOTLOOP_PROFILE_ID}/loop/${params.loopId}/folder`,
      method:    "GET",
      auth:      { style: "bearer", token: DOTLOOP_API_KEY },
    })
    if (!response.ok) {
      return { success: false, error: `Dotloop API error: ${response.error ?? `HTTP ${response.status ?? "?"}`}` }
    }

    const folders = response.data ?? {}
    const documents: any[] = []

    for (const folder of folders.data || []) {
      for (const doc of folder.documents || []) {
        documents.push({
          id: doc.document_id,
          name: doc.name,
          folder: folder.name,
          status: doc.is_signed ? "signed" : doc.signature_pending ? "pending_signature" : "not_started",
          signedDate: doc.signed_date,
        })
      }
    }

    const summary = {
      total: documents.length,
      signed: documents.filter((d) => d.status === "signed").length,
      pending: documents.filter((d) => d.status === "pending_signature").length,
      notStarted: documents.filter((d) => d.status === "not_started").length,
    }

    // AI recommendation
    const { text: recommendation } = await generateText({
      brokerageId,
      userId: ctx.userId,
      agentId: ctx.agentId,
      model: resolveModel("openai/gpt-4o-mini"),
      prompt: `As a transaction coordinator, review these document statuses and provide a brief action recommendation:

${documents.map((d) => `- ${d.name}: ${d.status}`).join("\n")}

Summary: ${summary.signed}/${summary.total} signed, ${summary.pending} pending, ${summary.notStarted} not started

Provide a 1-2 sentence recommendation for the agent.`,
    })

    return {
      success: true,
      documents,
      summary,
      aiRecommendation: recommendation,
    }
  } catch (error) {
    console.error("[AI Listing Intake] Document status error:", error)
    return handleError(error, "aiCheckDocumentStatus")
  }
}

// ============================================
// 8. CREATE COMPLETE LISTING
// ============================================
/* ─────────────────────────────────────────────────────────────────────────────
 * TOMBSTONE — `createListing(params: ListingIntakeData)` was REMOVED here.
 *
 * SURVIVOR: `createListingWithSellerContact` at
 * app/actions/listings-kernel.ts:145 — the canonical listing-creation door, the
 * one ListingCreateSheet and the FormWizard listing flow actually call.
 *
 * THE MERGE THAT UNBLOCKED THIS IS DONE. The previous note here (and on the
 * orchestrator below) recorded, correctly, that this copy could NOT simply be
 * deleted: alone among the three listing-creation paths it also opened the
 * seller-side `transactions` row and created the transaction-provider container
 * (the Dotloop loop, writing back `listings.dotloop_loop_id`) — so deleting it
 * would have LOST capability rather than removed a duplicate, which is the one
 * forbidden outcome. It named the unblocking work precisely: "fold the
 * transaction-row + provider-container creation into
 * `createListingWithSellerContact`". That fold is now made, at
 * app/actions/listings-kernel.ts Step 4 of that function, corrections included
 * (deal_type/status spelled as the live CHECK admits them, dotloop opened only
 * when the brokerage's RESOLVED provider is dotloop, both steps non-fatal, and
 * the loop-id write-back destructured).
 *
 * SO THE MERGE MOVED CAPABILITY *INTO* THE PRODUCT, not out of it. This copy had
 * NO CALLER but `runCompleteListingIntake`, which had no caller either — meaning
 * that for as long as both existed, EVERY listing the product actually created
 * got a `listings` row and no deal row and no provider container. The doors that
 * run now do all three.
 *
 * NOT MERGED, deliberately: this copy's `sellerId` brokerage-ownership check.
 * The survivor does not take a caller-supplied seller id at all — it creates or
 * attaches the seller contact itself from the caller's own tenant
 * (createOrAttachSellerContact), so there is no foreign id to validate. A check
 * against an input that cannot exist is not a behaviour to carry over.
 * ───────────────────────────────────────────────────────────────────────────── */

// ============================================
// 9. AI PHOTO ORDERING OPTIMIZER — REMOVED
// ============================================
/* ─────────────────────────────────────────────────────────────────────────────
 * TOMBSTONE — `aiOptimizePhotoOrder` was REMOVED (orphan burn-down, Lane A).
 *
 * SURVIVOR: `app/actions/photo-management.ts:optimizePhotoOrder` (declared at
 * app/actions/photo-management.ts:336), wired to the media manager's "Optimize
 * order" button at
 * app/dashboard/listings/[id]/media/media-manager-client.tsx:180, with the rule
 * editor beside it at
 * app/dashboard/listings/[id]/media/components/photo-ordering-rules-card.tsx.
 *
 * NOTHING WAS MERGED, because this function had nothing the survivor lacks and
 * one thing the survivor is right not to have:
 *
 *   · IT COULD NOT SEE THE PHOTOS. Its whole input was `photos: string[]` — a
 *     list of URL STRINGS interpolated into a TEXT prompt. No image was ever
 *     sent to a vision model, so "analyze these listing photos and determine the
 *     optimal order" was the model ranking filenames. Its `optimizedOrder`,
 *     `heroPhoto` and per-photo `suggestions` were confabulated from URL text.
 *   · IT PERSISTED NOTHING. It returned indices into an array the caller passed
 *     in. The survivor writes `listing_media.sort_order` and revalidates.
 *   · The survivor orders by the CLASSIFIED `room_type` and `ai_quality_score`
 *     already on each media row, honours the agent's saved
 *     `photo_ordering_rules` sequence, and falls back to the MLS default —
 *     facts about the actual images rather than guesses about their URLs.
 *
 * Per-photo quality feedback (the one output class this action gestured at)
 * lives at `app/actions/photo-management.ts:validatePhotoQuality` (line 597) and
 * `analyzePhoto` (line 81), both of which look at the real image.
 * ───────────────────────────────────────────────────────────────────────────── */

// ============================================
// 10. COMPLETE LISTING INTAKE WORKFLOW — REMOVED
// ============================================
/* ─────────────────────────────────────────────────────────────────────────────
 * TOMBSTONE — `runCompleteListingIntake` was REMOVED (orphan census, category C).
 *
 * SURVIVOR: `createListingWithSellerContact` at
 * app/actions/listings-kernel.ts:145.
 *
 * THE RECORDED BLOCKER IS GONE, so the recorded verdict is executed rather than
 * restated a third time. The note that stood here said, in as many words: "WHAT
 * WOULD UNBLOCK IT: fold the transaction-row + provider-container creation into
 * `createListingWithSellerContact` (the canonical door), at which point this
 * orchestrator and the local `createListing` can both go, with that function as
 * the named survivor." That fold is now made (listings-kernel.ts Step 4). Both
 * are gone. The survivor is named.
 *
 * NOTHING IS LOST, checked step by step against what this orchestrator did:
 *   1. aiEnrichPropertyData      — reachable: ListingIntelligenceCard
 *      (app/components/dashboard/listings/lifecycle/listing-intelligence-card.tsx)
 *   2. aiGetRequiredForms        — DELETED IN THE SAME CHANGE, because this
 *      orchestrator was its only caller. Survivor: lib/state-forms/registry.ts
 *      getStateForms — all 50 states, no DEFAULT, and already the registry that
 *      generateListingAgreement in this file uses. Its own tombstone is above.
 *   3. aiGenerateListingDescription — reachable: ListingDescriptionComposer
 *   4. aiSuggestListPrice        — reachable: ListingIntelligenceCard
 *   5. aiCheckListingCompliance  — reachable: ListingIntelligenceCard
 *   6. createListing (local)     — MERGED onto the survivor; see the tombstone above
 * All five AI steps remain exported from this file and remain wired to the
 * surfaces above. Only the uncalled orchestration of them is gone.
 *
 * AND WIRING IT WOULD HAVE BEEN WRONG, which is why it is deleted rather than
 * given a caller: step 6 CREATES A LISTING, and the product creates listings
 * through the FormWizard packet flow
 * (app/dashboard/listings/listings-new-button.tsx → the survivor). Giving this a
 * surface would have stood up a SECOND listing-creation door beside the real
 * one — the exact duplication this burn-down exists to remove.
 * ───────────────────────────────────────────────────────────────────────────── */

// ============================================
// WORKFLOW OS — generate listing agreement draft
// ============================================
/**
 * Generates an AI-drafted listing agreement for a seller contact.
 * Called by the draft_document workflow adapter when document_type = "listing_agreement".
 */
/**
 * Stage a LISTING AGREEMENT PACKET for the agent to complete in FormWizard.
 *
 * Same pattern as generateOfferDraft — a workflow can't fully fill a listing
 * agreement (it needs seller's legal name, listing price strategy, commission,
 * dates, marketing terms). This action prepares the packet:
 *   - Required forms for the property state
 *   - AI-prefilled known fields (seller, property, agent)
 *   - Flagged unknown fields the agent must finalize
 *   - status = needs_agent_input
 *   - Notification linking to the listing FormWizard
 *
 * Not marketing content — no brand-voice / them-first checks apply.
 */
export async function generateListingAgreement(params: {
  brokerageId: string
  contactId?: string | null
  agentUserId?: string | null
  /** 2-letter US state code from the PROPERTY ADDRESS — required. */
  state: string
  documentId?: string | null
  propertyAddress?: string
  listingId?: string | null
}): Promise<{ success: boolean; documentId?: string; error?: string }> {
  try {
    const supabase = await createClient()

    const { getStateForms } = await import("@/lib/state-forms/registry")
    const forms = getStateForms(params.state, "listing")
    const state = params.state.trim().toUpperCase()

    // Prefill known fields
    let sellerName: string | null = null
    let sellerEmail: string | null = null
    if (params.contactId) {
      const { data: c } = await supabase
        .from("contacts").select("first_name, last_name, email")
        .eq("id", params.contactId).maybeSingle()
      if (c) {
        sellerName  = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || null
        sellerEmail = c.email ?? null
      }
    }

    let propertyAddress = params.propertyAddress ?? null
    let listPrice: number | null = null
    if (params.listingId) {
      const { data: l } = await supabase
        .from("listings").select("address, list_price").eq("id", params.listingId).maybeSingle()
      if (l) {
        propertyAddress = l.address ?? propertyAddress
        listPrice = l.list_price ?? null
      }
    }

    let agentName: string | null = null
    let brokerageName: string | null = null
    if (params.agentUserId) {
      const { data: u } = await supabase
        .from("users").select("first_name, last_name").eq("id", params.agentUserId).maybeSingle()
      if (u) agentName = `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || null
    }
    const { data: brokerage } = await supabase
      .from("brokerages").select("name").eq("id", params.brokerageId).maybeSingle()
    if (brokerage) brokerageName = brokerage.name ?? null

    const packet = {
      packet_type: "listing_agreement",
      state,
      created_at: new Date().toISOString(),
      forms: {
        required: forms.required,
        addenda:  forms.addenda,
        brokerage_representation: forms.brokerageRepresentation,
      },
      prefilled: {
        seller_legal_name: sellerName,
        seller_email:      sellerEmail,
        property_address:  propertyAddress,
        suggested_list_price: listPrice,
        agent_name:        agentName,
        brokerage_name:    brokerageName,
      },
      needs_agent_input: [
        { field: "seller_legal_name_verified", reason: "Must match deed / driver's license", suggested: sellerName },
        { field: "list_price",                  reason: "Strategy decision with seller (CMA-driven)" },
        { field: "commission_structure",        reason: "Listing-side commission + offered to buyer agent" },
        { field: "listing_term_days",           reason: "Typical 90 / 180 days" },
        { field: "marketing_obligations",       reason: "Photography, video, MLS, open house plan" },
        { field: "seller_responsibilities",     reason: "Disclosures, repairs, showing access" },
        { field: "go_live_date",                reason: "MLS active date" },
      ],
      formwizard_url: params.listingId
        ? `/dashboard/listings/${params.listingId}/edit`
        : "/dashboard/listings/new",
    }

    // MERGE, NEVER REPLACE — the listing twin of the offer-side defect fixed in
    // wave 9 (ai-offer-creation.ts:generateOfferDraft).
    //
    // The listing staging path INSERTs the document with
    // `content = { intake, filledPacket }` and then calls this function
    // immediately (draft-listing-from-voice.ts — the second path,
    // api/workflow/intake/listing, was a duplicate of it and has been retired
    // onto it).
    // Assigning `content` wholesale replaced that with a prefill shape carrying
    // NO `filledPacket`, and assigning `metadata` wholesale dropped whatever the
    // stager had put there. `filledPacket` is the ONLY thing
    // scanListingPacketCompleteness reads, so the completeness scan was left
    // permanently unable to verify an AI-staged listing agreement — and with
    // that scan now failing closed, an un-merged write here would refuse every
    // AI-staged listing at markAgreementSigned instead. Load-bearing in both
    // directions, exactly as on the offer side.
    //
    // The two shapes share no keys, so a top-level merge is lossless.
    if (params.documentId) {
      const { data: existingDoc, error: existingErr } = await supabase
        .from("documents")
        .select("content, metadata")
        .eq("id", params.documentId)
        .eq("brokerage_id", params.brokerageId)
        .maybeSingle()
      if (existingErr) {
        console.error("[AI Listing Intake] Could not read the staged document before merging the packet — refusing to overwrite it blind:", existingErr.message)
        return handleError(existingErr, "generateListingAgreement")
      }

      let priorContent: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse((existingDoc?.content as string | null) ?? "{}")
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) priorContent = parsed
      } catch { /* unparseable prior content is replaced, not merged */ }
      const priorMetadata = (existingDoc?.metadata ?? {}) as Record<string, unknown>

      const packetUpdate = {
        content: JSON.stringify({ ...priorContent, ...packet }, null, 2),
        status: "needs_agent_input",
        metadata: {
          ...priorMetadata,           // keeps packet_type and anything else staged
          state,
          packet_type: "listing_agreement",
          required_forms: forms.required,
          available_addenda: forms.addenda,
          brokerage_representation_form: forms.brokerageRepresentation,
          prefilled: packet.prefilled,
          unknown_fields: packet.needs_agent_input.map(f => f.field),
          formwizard_url: packet.formwizard_url,
        },
        updated_at: new Date().toISOString(),
      }
      // CHECKED: a silently-dropped update here is what produced the unverifiable
      // packet, and supabase-js RESOLVES a refused write.
      const { error: packetWriteErr } = await supabase
        .from("documents")
        .update(packetUpdate)
        .eq("id", params.documentId)
        // tenant anchor (scope burn-down): document must belong to the workflow's brokerage
        .eq("brokerage_id", params.brokerageId)
      if (packetWriteErr) {
        console.error("[AI Listing Intake] Packet did not persist to the document row:", packetWriteErr.message)
        return handleError(packetWriteErr, "generateListingAgreement")
      }
    }

    // Notify the agent — the packet awaits their review/finalization
    if (params.agentUserId) {
      void Promise.resolve(supabase.from("notifications").insert({
        user_id: params.agentUserId,
        brokerage_id: params.brokerageId,
        type: "listing_agreement_packet_ready",
        title: `Listing agreement packet ready for ${sellerName ?? "seller"}`,
        body: `Required ${state} forms staged with prefilled fields. Open the listing FormWizard to set price, commission, and term before sending for signature.`,
        priority: "high",
        entity_type: "document",
        entity_id: params.documentId ?? null,
        channel: "in_app",
      })).catch(() => {})
    }

    return { success: true, documentId: params.documentId ?? undefined }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: msg }
  }
}

// ============================================
// WORKFLOW OS — generate listing landing page
// ============================================
/**
 * Creates or updates a listing micro-site / landing page.
 * Called by the listing_landing_page workflow adapter.
 */
export async function generateListingLandingPage(params: {
  brokerageId: string
  agentUserId: string
  templateId?: string
  slug?: string
  contactId?: string | null
  listingId?: string | null
}): Promise<{
  success: boolean
  pageId?: string
  pageUrl?: string
  slug?: string
  error?: string
}> {
  try {
    const supabase = await createClient()

    const pageSlug = params.slug ?? `listing-${Math.random().toString(36).slice(2, 9)}`

    // listing_landing_pages.slug is GLOBALLY unique — correctly so, since it resolves a
    // public URL (/listing/[slug]) and one address must mean one page. But the upsert
    // below conflicts on that global key with a CALLER-SUPPLIED slug, so passing another
    // brokerage's slug silently overwrote their published page: content, listing_id,
    // contact_id and brokerage_id all rewritten to the caller's.
    //
    // The read staying global is right. The write must not cross tenants.
    const { data: slugHolder } = await supabase
      .from("listing_landing_pages")
      .select("brokerage_id")
      .eq("slug", pageSlug)
      .maybeSingle()
    const holderBrokerageId = (slugHolder as { brokerage_id?: string | null } | null)?.brokerage_id ?? null
    if (holderBrokerageId && holderBrokerageId !== params.brokerageId) {
      return {
        success: false,
        error: `The address "${pageSlug}" already has a landing page at another brokerage. Choose a different link name.`,
      }
    }

    // Fetch listing data if linked
    let listingData: Record<string, unknown> = {}
    if (params.listingId) {
      const { data: listing } = await supabase
        .from("listings")
        .select("address, city, state, list_price, bedrooms, bathrooms, sqft, public_remarks, photos")
        .eq("id", params.listingId)
        .maybeSingle()
      if (listing) listingData = listing as Record<string, unknown>
    }

    // ── THE TEMPLATE THE COLUMN ALWAYS MEANT (owner ruling 2026-09-05) ────────
    // Resolved agent > brokerage > global from content_templates, the table that
    // was already live and carrying this exact shape. A refused lookup is
    // REPORTED, not folded into "no template configured": those are different
    // facts and an agent debugging why their template did not apply must not be
    // told it does not exist (§3 — supabase-js resolves refusals).
    const { resolveLandingTemplate, applyLandingTemplateToPrompt } = await import("@/lib/marketing/landing-template")
    const templateChoice = await resolveLandingTemplate(supabase, {
      brokerageId: params.brokerageId,
      agentId: params.agentUserId ?? null,
      explicitTemplateId: params.templateId ?? null,
    })
    if (templateChoice.lookupFailed) {
      console.error(
        `[listing-landing] template lookup REFUSED for brokerage ${params.brokerageId} — the page is still generated free-form, but this is NOT "no template configured":`,
        templateChoice.reason,
      )
    } else if (templateChoice.reason) {
      console.warn(`[listing-landing] ${templateChoice.reason}`)
    }

    // Generate AI description for the landing page
    const basePrompt = `Write a compelling property landing page headline and description.
Property: ${JSON.stringify(listingData)}.
Output a JSON object with: headline (string, max 80 chars), subheadline (string, max 120 chars), body (string, max 300 chars).
Them-first: focus on what the buyer gains, not agent promotion.`
    // The template STEERS the model. It is never executed or interpolated as code —
    // these rows are tenant-authored, and a template that could execute would be a
    // tenant-authored code path.
    const prompt = applyLandingTemplateToPrompt(basePrompt, templateChoice.template)

    let pageContent: Record<string, string> = {
      headline: `Beautiful Home — ${listingData.address ?? "Available Now"}`,
      subheadline: "Contact us to schedule a showing",
      body: "",
    }

    try {
      const { generateTextRouted } = await import("@/lib/ai/models")
      const { text } = await generateTextRouted({
        feature: "listing_landing_page",
        messages: [{ role: "user", content: prompt }],
      })
      const parsed = JSON.parse(text.replace(/```json|```/g, "").trim())
      if (parsed?.headline) pageContent = parsed
    } catch { /* use defaults */ }

    const { data: page, error } = await supabase
      .from("listing_landing_pages")
      .upsert({
        brokerage_id: params.brokerageId,
        contact_id: params.contactId ?? null,
        // RESOLVED 2026-09-05 (the note that stood here recorded this as an open
        // owner question; the owner said templates are wanted). The column now
        // records the template that ACTUALLY shaped this page — the resolved one,
        // not the one that was asked for. Those differ whenever an agent names a
        // template that is not an active listing-page template in their brokerage,
        // and storing the request rather than the outcome would make the page claim
        // a provenance it does not have.
        //
        // m606 gave the column its id class: it FKs content_templates ON DELETE SET
        // NULL, so a published page with its own URL and lead history outlives the
        // template that shaped it. NULL means genuinely free-form.
        template_id: templateChoice.template?.id ?? null,
        listing_id: params.listingId ?? null,
        slug: pageSlug,
        content: pageContent,
        status: "published",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: "slug" })
      .select("id")
      .maybeSingle()

    if (error) throw error

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.platform.com"
    const pageUrl = `${baseUrl}/p/${pageSlug}`

    return { success: true, pageId: page?.id, pageUrl, slug: pageSlug }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: msg }
  }
}
