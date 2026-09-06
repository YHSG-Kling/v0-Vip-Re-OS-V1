"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { isValidUUID } from "@/lib/validations"
import { revalidatePath } from "next/cache"

// =============================================================================
// AI-POWERED COMPARATIVE MARKET ANALYSIS (CMA) SYSTEM
//
// THERE IS ONE CMA ENGINE AND IT IS NOT IN THIS FILE.
// ---------------------------------------------------------------------------
// Owner ruling: "the same cma should be used for all." This file used to carry
// a SECOND, private valuation stack — its own comp fetch, its own hardcoded
// adjustment constants, and a GPT-4o call that authored `estimatedValue`, the
// number written to cma_reports.recommended_price and shown to sellers. That
// stack has been deleted (tombstones below name what replaced each piece) and
// this action now composes lib/cma/ai-cma-orchestrator.runAiCma — the same
// engine app/actions/home-value.ts, app/actions/calculators.ts,
// lib/workflow/adapters/avm-cma.ts and
// lib/workflow/intelligence/listing-presentation-builder.ts already use.
//
// WHAT THIS FILE STILL OWNS, and why it survives rather than the orchestrator:
//   · the "use server" boundary + auth/contact/tenant gates
//   · PERSISTENCE. runAiCma is pure of DB writes by design ("Callers own
//     persistence"), and this is the only writer of cma_reports — the table
//     read by seller-cma, appraisal-defense, the presentation assembler, the
//     seller portal and the CMA history sheet.
//   · the market_data read behind cma_reports.market_conditions
//   · the pricing-strategy and presentation-script narratives
//
// DIVISION OF LABOUR, stated once so it is not re-blurred: runAiCma produces
// EVERY NUMBER. The models called from this file produce PROSE and may position
// a list price INSIDE the comp-derived range — never outside it, never in its
// absence. See clampToRange below.
// =============================================================================

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

interface CMAParams {
  agentId: string
  propertyAddress: string
  propertyCity: string
  propertyState: string
  propertyZip: string
  propertyType: "single_family" | "condo" | "townhouse" | "multi_family" | "land"
  bedrooms: number
  bathrooms: number
  squareFeet: number
  lotSize?: number
  yearBuilt?: number
  features?: string[]
  condition?: "excellent" | "good" | "fair" | "poor"
  listingType: "seller" | "buyer"
  contactId?: string
  listingId?: string
}

/**
 * The slice of `AiCmaResult` (lib/cma/ai-cma-orchestrator.ts) this file consumes.
 * Structural rather than an import of the concrete type so the "use server"
 * module keeps a dynamic import of the orchestrator and does not pull the comp
 * providers into this bundle at build time.
 */
interface AiCmaResultShape {
  estimatedValueLow: number
  estimatedValueMid: number
  estimatedValueHigh: number
  confidenceScore: number
  adjustedComps: Array<{ comp: any; adjustments: any[]; adjustedPrice: number }>
  pendingComps: Array<{ comp: any; adjustments: any[]; adjustedPrice: number }>
  activeComps: Array<{ comp: any; adjustments: any[]; adjustedPrice: number }>
  compProvenance: unknown
  aiNarrative: string
  citations: string[]
  disclaimers: string[]
}

/**
 * MEASURED-OR-NULL. Every field here was previously non-nullable and therefore
 * had to be filled with something whether or not a market_data row existed —
 * which is how `|| 35` days-on-market, `|| 100` active listings, a median sale
 * price derived from the subject's own square footage, a `[240,245,250,255,260]`
 * price trend commented "Simulated", and a flat 5% appreciation rate all became
 * inputs to a valuation prompt. Nullable types are what make "we do not know"
 * expressible; `pricePerSqFtTrend` and `seasonalFactor` are gone entirely
 * because nothing measured them.
 */
interface MarketTrends {
  averageDaysOnMarket: number | null
  medianSalePrice: number | null
  activeListings: number | null
  monthsOfSupply: number | null
  inventoryLevel: "low" | "balanced" | "high" | "unknown"
  marketType: "sellers" | "balanced" | "buyers" | "unknown"
  appreciationRate: number | null
  marketDataAvailable: boolean
}

interface PricingStrategy {
  recommendedListPrice: number
  priceRangeLow: number
  priceRangeHigh: number
  confidenceLevel: number
  rationale: string
  quickSalePrice: number
  premiumPrice: number
  /**
   * Null when neither the strategist model nor the market feed produced one.
   * This used to fall back to `marketTrends.averageDaysOnMarket`, which itself
   * fell back to a hardcoded 35 — so "sells in about 35 days" was told to
   * sellers in markets no data had ever been collected for.
   */
  daysToSellEstimate: number | null
}

// -----------------------------------------------------------------------------
// AI CMA GENERATION
// -----------------------------------------------------------------------------

/**
 * Generate comprehensive AI-powered CMA report
 */
export async function generateAICMA(params: CMAParams) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  // Validate that the caller owns this agentId
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { success: false, error: "Unauthorized" }
  }
  const { data: agentRow, error: agentRowError } = await supabase
    .from("agents")
    .select("id, brokerage_id")
    .eq("id", params.agentId)
    .eq("user_id", user.id)
    .maybeSingle()
  // A refused read resolves, so without this the authorization gate below would
  // read "permission denied" as "that agent isn't you" — and this row is also
  // the tenant fallback for the report written at the end.
  if (agentRowError) {
    return { success: false, error: `Agent lookup refused: ${agentRowError.message}` }
  }
  if (!agentRow) {
    return { success: false, error: "Unauthorized: agentId does not match authenticated user" }
  }

  // ── CONTACTS ONLY, PROVEN HERE — OWNER RULING ──────────────────────────────
  // The comps step below reaches RentCast, and property valuation is a contacts
  // capability. This function used to check `contactId` only at step 6, AFTER the
  // provider had been paid, and it never read the id back against anything — so a
  // caller could hand it an id from any lane and the only thing that ever noticed
  // was the NOT NULL on cma_reports.contact_id, at the very end.
  //
  // The caller is gated too, but a gate that exists only at the caller is one new
  // caller away from being bypassed again. This is the gate that cannot be, and it
  // runs BEFORE anything is spent.
  if (!params.contactId || !isValidUUID(params.contactId)) {
    return { success: false, error: "A contact is required to generate a CMA" }
  }
  const { data: cmaContact, error: cmaContactError } = await supabase
    .from("contacts")
    // brokerage_id rides along on the lookup this function already makes: the
    // report is FILED AGAINST this contact, so the contact's tenant is the
    // report's tenant. See the stamp at the insert below.
    .select("id, brokerage_id")
    .eq("id", params.contactId)
    .maybeSingle()
  // supabase-js RESOLVES a refused query. An unread error here would turn a
  // refusal into "no such contact", which is a different fact — and both must
  // stop the run before a vendor call is made.
  if (cmaContactError) {
    return { success: false, error: `Contact lookup refused: ${cmaContactError.message}` }
  }
  if (!cmaContact) {
    return {
      success: false,
      error: "No contact carries that id. A CMA is filed against a contact, and comps are not purchased for any other identity class.",
    }
  }
  const cmaContactId = cmaContact.id as string

  // TENANT — the contact this report is filed against, then the agents row this
  // function ALREADY proved belongs to the authenticated user. Both are read
  // columns named brokerage_id on a real parent row; neither is an agents.id
  // pressed into service as a tenant.
  //
  // Contact first because the report hangs off the contact and cma_reports.
  // contact_id is NOT NULL. Contacts may legitimately carry no brokerage_id
  // (nullable), and an untenanted contact must not push a NULL onto the report —
  // hence the fall back to the verified agent, which is the same brokerage the
  // readers below use as `ctx.brokerageId`.
  //
  // Why this was load-bearing: updateCMA, deleteCMA and getCMAReports in THIS
  // FILE all narrow with `.eq("brokerage_id", ctx.brokerageId)`. `NULL = <uuid>`
  // is NULL, never true, so a CMA generated here — after paying a comps provider
  // — could not afterwards be listed, updated or deleted by the very agent who
  // generated it.
  const cmaBrokerageId =
    ((cmaContact.brokerage_id as string | null) ?? null) ||
    ((agentRow.brokerage_id as string | null) ?? null)
  if (!cmaBrokerageId) {
    return {
      success: false,
      error:
        "Neither this contact nor your agent profile carries a brokerage, so the CMA would be written where no CMA surface can read it. No comps were purchased.",
    }
  }

  try {
    // ── 1. THE CMA ITSELF — runAiCma, the one engine ─────────────────────────
    // Provider-first comp sourcing (3 SOLD within 6 months, widening to 12 only
    // when short, + 2 ACTIVE + 1 PENDING), state-published appraiser adjustment
    // rates applied per comp DETERMINISTICALLY, a value range computed from the
    // ADJUSTED CLOSED comps alone, provenance, citations and disclaimers.
    //
    // The three functions this replaced are described in the tombstones below.
    // The short version: they bought RentCast comps with no status/window rules,
    // adjusted them with national constants invented in this file ($15,000 a
    // bedroom, $10,000 a bathroom, $1,000 a year of age), and then asked GPT-4o
    // for the property's value. A model's answer to "what is this house worth"
    // became cma_reports.recommended_price, which the seller portal renders, the
    // net sheet prices off, and the appraisal-defense package argues to a
    // licensed appraiser. That is a fabricated measurement and it is gone.
    const { runAiCma } = await import("@/lib/cma/ai-cma-orchestrator")

    const cma = await runAiCma({
      mode: "standard",
      brokerageId: cmaBrokerageId,
      // agents.id is NOT users.id. runAiCma resolves the IDX connection through
      // the agent → team → brokerage cascade off the AUTH user id, which is the
      // one this function has already proven owns params.agentId.
      agentUserId: user.id,
      contactId: cmaContactId,
      subject: {
        address: params.propertyAddress,
        city: params.propertyCity || null,
        state: params.propertyState,
        zip: params.propertyZip || null,
        propertyType: cmaSubjectPropertyType(params.propertyType),
        sqftLiving: params.squareFeet || null,
        bedrooms: params.bedrooms || null,
        // CMAParams carries a single bathroom count, as every caller's form
        // does. Halves are unknown rather than zero-by-assumption.
        fullBaths: params.bathrooms || null,
        halfBaths: null,
        yearBuilt: params.yearBuilt ?? null,
        lotSizeAcres: acresFromLotSize(params.lotSize),
        conditionGrade: CONDITION_GRADE[params.condition ?? ""] ?? null,
        // The seller's own words about what they have done since purchase.
        // runAiCma treats these as NARRATIVE CONTEXT and refuses to turn them
        // into a dollar line — see SELLER_UPGRADE_TREATMENT in the orchestrator.
        sellerUpgrades: (params.features ?? []).map((description) => ({ description })),
      },
    })

    // ── 2. NO CLOSED COMP, NO CMA ────────────────────────────────────────────
    // Refusing here is the whole point of the change. The deleted stack, handed
    // an empty comp array, computed `0/0` for its average, shipped a prompt
    // containing NaN and Infinity, and wrote whatever number the model replied
    // with. A CMA with no comparable sale behind it is not a thin CMA — it is a
    // price with nothing under it, and this product hands that price to
    // consumers and to appraisers. lib/cma/comp-provider.ts already states the
    // same consequence and accepts it: the fix is to connect the provider.
    if (cma.adjustedComps.length === 0 || cma.estimatedValueMid <= 0) {
      return {
        success: false,
        error:
          "No closed comparable sales could be sourced for this property, so no value range can be produced. " +
          cma.disclaimers.join(" "),
        compProvenance: cma.compProvenance,
      }
    }

    // ── 3. Market conditions — the market_data read ──────────────────────────
    const marketTrends = await analyzeMarketTrends(params, supabase)

    // ── 4. Pricing strategy, BOUNDED BY THE COMPS ────────────────────────────
    const cmaSpendActor = { brokerageId: cmaBrokerageId, userId: user.id }
    const pricingStrategy = await generatePricingStrategy(params, cma, marketTrends, cmaSpendActor)

    // ── 5. Presentation script ───────────────────────────────────────────────
    const presentation = await generateCMAPresentation(params, cma, marketTrends, pricingStrategy, cmaSpendActor)

    // ── 6. Save CMA report — columns verified against scripts/schema-snapshot.ts
    // contact_id is NOT NULL on cma_reports; a CMA must be tied to a contact.
    // The id written here is the one the contacts lookup above RETURNED, not the
    // one the caller supplied, so the column can only ever hold a confirmed row.
    const { data: cmaReport, error } = await supabase
      .from("cma_reports")
      .insert({
        brokerage_id: cmaBrokerageId, // resolved above: contact → verified agent
        agent_id: params.agentId,
        contact_id: cmaContactId,
        listing_id: params.listingId ?? null,
        // city/state have no columns on cma_reports — fold into property_address.
        property_address: [params.propertyAddress, params.propertyCity, params.propertyState].filter(Boolean).join(", "),
        property_zip: params.propertyZip ?? null,
        property_type: params.propertyType,
        bedrooms: params.bedrooms,
        bathrooms: params.bathrooms,
        square_feet: params.squareFeet,
        lot_size: params.lotSize ?? null,
        year_built: params.yearBuilt ?? null,
        features: params.features ?? null,
        condition: params.condition ?? null,
        recommended_price: pricingStrategy.recommendedListPrice,
        price_range_low: pricingStrategy.priceRangeLow,
        price_range_high: pricingStrategy.priceRangeHigh,
        // The CLOSED comps — the set the range was computed from and the set
        // written to cma_comparables below. It used to count every row RentCast
        // returned regardless of status, so the number on the report and the
        // number of rows a reader could find never had to agree.
        comparable_count: cma.adjustedComps.length,
        market_conditions: marketTrends.marketType,
        // MEASURED, not assumed. quality_score was never written on insert, so
        // every CMA carried the column default and the CMA tab's quality badge
        // rendered that default as if something had assessed it. runAiCma's
        // confidence is derived from comp count, similarity, price spread and
        // documented haircuts for a widened window / AI-gap-filled mix; it is
        // reported 0..1 and this column stores 0-100. scoreAllComps later
        // overwrites it with the per-comp AI average, which is the same scale.
        quality_score: Math.round(cma.confidenceScore * 100),
        status: "ready", // CHECK: draft|ready|presented|archived
        disclaimer_included: true,
      })
      .select("id")
      .single()

    if (error) throw error

    // ── 7. THE COMPARABLES THEMSELVES ────────────────────────────────────────
    const persisted = await persistComparables(supabase, cmaReport.id, cma)

    revalidatePath("/dashboard/cma")
    return {
      success: true,
      id: cmaReport.id,
      cmaId: cmaReport.id,
      // Retained for the callers that read it (lib/workflow-orchestrator/chains/
      // listing-appt-prep.ts surfaces `valuation` on its step output). It is now
      // the COMPUTED range rather than a model's opinion of one.
      valuation: {
        estimatedValue: cma.estimatedValueMid,
        estimatedValueLow: cma.estimatedValueLow,
        estimatedValueHigh: cma.estimatedValueHigh,
        confidenceLevel: Math.round(cma.confidenceScore * 100),
        // THE RAW SCORE, BESIDE THE PERCENTAGE, AND THE TWO ARE NOT THE SAME UNIT.
        // `confidenceLevel` is 0..100 for display. Every downstream consumer of the
        // ENGINE's output (lib/workflow/intelligence/listing-presentation-builder.ts
        // among them) works in confidenceScore's native 0..1, and a caller reusing
        // this valuation to avoid a second paid run would otherwise have to divide
        // by 100 to recover it — a conversion that is lossy below one percent and,
        // far worse, silently right-looking if forgotten: 0.85 would render as a
        // confidence of 8500%. Carrying both means nobody has to convert.
        confidenceScore: cma.confidenceScore,
        valuationMethod: "Adjusted comparable sales (state appraiser guideline rates)",
        narrative: cma.aiNarrative,
      },
      pricingStrategy,
      // `comparables` keeps the key its callers already read
      // (app/actions/cma-presentation/cma-generator.ts counts `.length`).
      comparables: cma.adjustedComps,
      pendingComparables: cma.pendingComps,
      activeComparables: cma.activeComps,
      marketTrends,
      presentation,
      // NEW, and load-bearing for every consumer that has to say where a number
      // came from: provenance, citations, the mandatory disclaimers, and whether
      // the comp rows a reader will later fetch actually landed.
      compProvenance: cma.compProvenance,
      citations: cma.citations,
      disclaimers: cma.disclaimers,
      qualityScore: Math.round(cma.confidenceScore * 100),
      comparablesPersisted: persisted.comparablesWritten,
      adjustmentsPersisted: persisted.adjustmentsWritten,
      persistenceWarnings: persisted.warnings,
    }
  } catch (error) {
    console.error("[AI CMA] Generation error:", error)
    return { success: false, error: "Failed to generate CMA" }
  }
}

/**
 * runAiCma's subject accepts a narrower property-type vocabulary than CMAParams
 * (its adjustment rate tables are published for these three). Anything else is
 * passed as null rather than coerced into "single_family", which would apply a
 * detached-home rate table to land or a duplex.
 */
function cmaSubjectPropertyType(
  t: CMAParams["propertyType"],
): "single_family" | "condo" | "townhouse" | null {
  return t === "single_family" || t === "condo" || t === "townhouse" ? t : null
}

/**
 * CMAParams.lotSize is unlabelled and every caller that sets it reads
 * `listings.lot_size`, which this product stores in SQUARE FEET. runAiCma's
 * rate table prices lot by the ACRE. Passing square feet into an acre field
 * would have multiplied the lot adjustment by ~43,560.
 */
function acresFromLotSize(lotSizeSqft: number | null | undefined): number | null {
  if (lotSizeSqft == null || !Number.isFinite(lotSizeSqft) || lotSizeSqft <= 0) return null
  return lotSizeSqft / 43_560
}

/** CMAParams' condition words → the 1-5 grade the state rate tables use. */
const CONDITION_GRADE: Record<string, number> = {
  excellent: 5,
  good: 4,
  fair: 2,
  poor: 1,
}

/**
 * PERSIST THE COMPARABLES. THIS WRITE DID NOT EXIST.
 *
 * `cma_comparables` had FIVE production readers and ZERO production writers:
 *   · app/actions/seller-cma.ts loadCMAPageData        (the CMA tab's comp table)
 *   · app/actions/appraisal-defense.ts                 (the appraiser packet)
 *   · lib/cma/ai-cma-engine.ts scoreAllComps           (AI comp scoring)
 *   · lib/listing-presentation/section-render.ts       (the seller presentation)
 *   · lib/predictive-listing/run-scoring.ts
 * The only INSERT anywhere in the repo was in a test fixture
 * (scripts/section-render-simulator.ts). So a CMA reported "10 comparables" on
 * a report whose comparable table was empty for every one of those readers:
 * the comp table rendered blank, "Score comps" returned "No comparables found
 * for CMA" every time it was pressed, and buildAppraisalDefensePackage returned
 * `no_comparables` for every CMA this product has ever generated — the packet
 * an agent hands a licensed appraiser could not be built at all.
 *
 * CLOSED COMPS ONLY, AND NOW SAID OUT LOUD ON THE ROW. m498 is applied: the
 * table carries `status`, `price_basis` and `source_provider`, so each row now
 * declares what kind of number it holds instead of leaving a reader to infer it
 * from the column name.
 *
 * The three values are WRITTEN EXPLICITLY rather than left to the m498 DEFAULT.
 * A default is a statement about rows nobody thought about; these rows were
 * thought about, and a writer that relies on a default cannot be read as having
 * decided anything. `source_provider` comes from the comp's OWN `sourceProvider`
 * — the authoritative per-row answer (lib/cma/comp-provider.ts:211) — not from
 * the majority provider on the side, because a side can be mixed.
 *
 * WHY ONLY CLOSED ROWS ARE WRITTEN, unchanged: its price column is named
 * `sale_price`, and writing an ACTIVE listing's ASKING price into it is the
 * exact fabrication this wave exists to remove — appraisal-defense.ts reads that
 * column and calls the rows "closed comparables" in the argument it prints.
 * Pending/active comps are still returned to the caller and still stay off this
 * table. m498's CHECK now makes the mistake unrepresentable anyway: a non-closed
 * row must carry price_basis='list_price' AND a NULL sale_price, and a
 * perplexity-sourced row can never be status='closed' at all — an AI web-search
 * result is not a recorded transaction however confidently it is worded.
 *
 * NOT FATAL, BUT NOT SILENT. The report row is already committed and the comps
 * were already paid for; a refusal here is reported on `persistenceWarnings`
 * rather than thrown away. supabase-js RESOLVES a refused insert, so an unread
 * `{ error }` is precisely how this failure would look identical to success.
 */
async function persistComparables(
  supabase: Awaited<ReturnType<typeof createClient>>,
  cmaReportId: string,
  cma: { adjustedComps: Array<{ comp: any; adjustments: any[]; adjustedPrice: number }> },
): Promise<{ comparablesWritten: number; adjustmentsWritten: number; warnings: string[] }> {
  const warnings: string[] = []

  const rows = cma.adjustedComps.map((a) => {
    const sqft = a.comp.sqftLiving ?? null
    const baths =
      a.comp.fullBaths != null || a.comp.halfBaths != null
        ? (a.comp.fullBaths ?? 0) + (a.comp.halfBaths ?? 0) * 0.5
        : null
    return {
      cma_id: cmaReportId,
      address: a.comp.address,
      // Every row here is a CLOSED SALE — runAiCma puts nothing else in
      // adjustedComps — and m498 lets the row say so rather than implying it.
      status: "closed",
      price_basis: "closed_sale",
      // The comp's OWN provenance, never the side's majority provider: a side
      // can be mixed, and this column is the per-row answer an appraiser would
      // ask for. NULL only if the sourcing layer somehow published none, which
      // is honest — a fabricated provider name is worse than an absent one.
      source_provider: a.comp.sourceProvider ?? null,
      sale_price: a.comp.salePrice,
      list_price: null,
      price_per_sqft:
        a.comp.pricePerSqft ?? (sqft && sqft > 0 ? Math.round(a.comp.salePrice / sqft) : null),
      bedrooms: a.comp.bedrooms ?? null,
      bathrooms: baths,
      square_feet: sqft,
      days_on_market: a.comp.daysOnMarket ?? null,
      sale_date: a.comp.saleDate ?? null,
      // Null, not 0, when the provider published no distance. appraisal-defense
      // ranks by distance and a 0 would promote an unknown comp to "closest".
      distance_miles: a.comp.distanceMiles ?? null,
      similarity_score: a.comp.similarityScore ?? null,
      adjusted_price: Math.round(a.adjustedPrice),
      adjustments: a.adjustments,
    }
  })

  if (rows.length === 0) return { comparablesWritten: 0, adjustmentsWritten: 0, warnings }

  const { data: inserted, error: compsError } = await supabase
    .from("cma_comparables")
    .insert(rows)
    .select("id, address")

  if (compsError) {
    console.error("[AI CMA] cma_comparables insert refused:", compsError.message)
    warnings.push(
      `The comparables could not be saved (${compsError.message}). The report's value range is correct, but the comp table, AI comp scoring and the appraisal-defense package will read as empty for this CMA.`,
    )
    return { comparablesWritten: 0, adjustmentsWritten: 0, warnings }
  }

  // ── The per-feature adjustments, keyed to the row appraisal-defense joins on ─
  // appraisal-defense.ts groups cma_price_adjustments by `comparable_property_id`
  // and matches it against cma_comparables.id, so the id has to come back from
  // the insert above — an address string would not join.
  const idByAddress = new Map<string, string>()
  for (const r of (inserted ?? []) as Array<{ id: string; address: string }>) {
    if (!idByAddress.has(r.address)) idByAddress.set(r.address, r.id)
  }

  const adjustmentRows = cma.adjustedComps.flatMap((a) => {
    const compRowId = idByAddress.get(a.comp.address)
    if (!compRowId) return []
    return a.adjustments.map((adj: any) => ({
      cma_report_id: cmaReportId,
      comparable_property_id: compRowId,
      comparable_address: a.comp.address,
      adjustment_type: adj.type,
      // Signed. appraisal-defense derives add/subtract from the sign and sums
      // these onto sale_price, so flipping them to absolute values here would
      // silently invert every downward adjustment in the appraiser's packet.
      adjustment_amount: adj.amount,
      // The GUIDELINE YEAR rides on the rationale, because this row is what the
      // appraisal-defense packet shows a licensed appraiser and the vintage of
      // the rate that produced the dollar figure is part of the figure. Until
      // m505 nothing recorded it anywhere, so every adjustment ever written here
      // was a number with no stated basis.
      rationale: `${adj.rationale} (state rate ${adj.rateUsed} ${adj.rateBasis}, ${adj.rateEffectiveYear} guideline vintage)`,
    }))
  })

  let adjustmentsWritten = 0
  if (adjustmentRows.length > 0) {
    const { error: adjError } = await supabase.from("cma_price_adjustments").insert(adjustmentRows)
    if (adjError) {
      console.error("[AI CMA] cma_price_adjustments insert refused:", adjError.message)
      warnings.push(
        `The per-comp adjustments could not be saved (${adjError.message}). The appraisal-defense package will fall back to each comp's stored adjusted price and show no adjustment breakdown.`,
      )
    } else {
      adjustmentsWritten = adjustmentRows.length
    }
  }

  return { comparablesWritten: rows.length, adjustmentsWritten, warnings }
}

// ─── TOMBSTONE · fetchComparableProperties ──────────────────────────────────
// DELETED. Replaced by lib/cma/comp-provider.ts `sourceCompsForCma`, reached
// through lib/cma/ai-cma-orchestrator.ts:183 `runAiCma`.
//
// What it did: one unconditional RentCast pull, `limit: 10`, everything it
// returned treated as a closed sale. No sold-window rule (a sale from four
// years ago counted the same as one from last month), no active or pending
// side at all, no record of which provider served the row, and — when RentCast
// was unconfigured — it returned `[]` and let generation continue.
//
// What replaced it can do everything it did and these besides: the required
// 3 SOLD / 2 ACTIVE / 1 PENDING mix, a 6-month sold window that widens to 12
// only when short and SAYS SO, the brokerage's own IDX feed for the active
// side, a per-row `sourceProvider`, a per-side `CompProvenance`, cost
// telemetry, and the rule that an AI web search may never fill a SOLD slot.

// ─── TOMBSTONE · calculatePropertyAdjustments ───────────────────────────────
// DELETED. Replaced by lib/cma/state-adjustment-rates.ts `computeCompAdjustments`,
// reached through lib/cma/ai-cma-orchestrator.ts:183 `runAiCma`.
//
// What it did: adjusted every comp in every market by constants written into
// this file — $15,000 a bedroom, $10,000 a bathroom, $1,000 per year of age,
// half the comp's own price-per-sqft for floor area, and a flat condition
// ladder topping out at $25,000. Those numbers cite nothing. They were applied
// identically to a bungalow in Ohio and a waterfront condo in Miami, and their
// output was written to a column named `adjusted_price`, which reads as a
// measurement.
//
// The replacement prices sqft, beds, baths, garage, pool, waterfront, view,
// lot, age, condition grade, finished basement, new construction and gated
// against PUBLISHED PER-STATE appraiser rates, records the rate used and its
// basis on every line item, and is deterministic — no model participates in the
// math. Those line items are now persisted to cma_price_adjustments, so the
// appraisal-defense packet can show an appraiser the rate behind each figure.

/**
 * Analyze market trends for the area
 */
async function analyzeMarketTrends(
  params: CMAParams,
  supabase: any
): Promise<MarketTrends> {
  // COLUMNS NAMED EXPLICITLY (verified against scripts/schema-snapshot.ts). The
  // `select("*")` this replaced is how the invented values below hid: nothing
  // ever failed, the reads simply came back undefined and the `||` fallbacks
  // took over on every call.
  //
  // A REFUSED read is not an empty market. supabase-js resolves it, and the old
  // code could not tell the two apart — a permissions failure produced the same
  // "35 days on market, balanced" as a genuinely uncovered city.
  const { data: marketData, error: marketError } = await supabase
    .from("market_data")
    .select(
      "avg_days_on_market, median_sale_price, active_listings, months_of_inventory, market_type, price_trend_pct_1yr, data_date",
    )
    .eq("city", params.propertyCity)
    .eq("state", params.propertyState)
    .order("data_date", { ascending: false })
    .limit(12)

  if (marketError) {
    console.error("[AI CMA] market_data read refused:", marketError.message)
  }

  const latest = (marketData?.[0] ?? null) as {
    avg_days_on_market: number | null
    median_sale_price: number | null
    active_listings: number | null
    months_of_inventory: number | null
    market_type: string | null
    price_trend_pct_1yr: number | null
  } | null

  // ── EVERY FIELD BELOW IS EITHER MEASURED OR NULL ─────────────────────────
  // What was here before, and why each one had to go:
  //   avgDOM      `|| 35`                    — an invented days-on-market
  //   medianPrice `|| params.squareFeet*250` — an invented median SALE PRICE for
  //                                            the whole city, derived from the
  //                                            subject's own floor area
  //   inventory   `|| 100`                   — an invented active-listing count
  //   pricePerSqFtTrend [240,245,250,255,260] — commented "Simulated trend" in
  //                                            the source and returned to callers
  //                                            as a price history
  //   appreciationRate 0.05                  — a hardcoded 5%, interpolated into
  //                                            the valuation prompt as
  //                                            "Annual Appreciation: 5.0%"
  // All five were fed to a model that was then asked what the house was worth.
  const avgDOM = latest?.avg_days_on_market ?? null
  const medianPrice = latest?.median_sale_price ?? null

  // Prefer the market's OWN published classification; fall back to the DOM rule
  // only when a DOM was actually measured. With neither, the market type is
  // unknown, and "unknown" is a legitimate value for cma_reports.market_conditions.
  let marketType: MarketTrends["marketType"] = "unknown"
  if (latest?.market_type === "sellers" || latest?.market_type === "buyers" || latest?.market_type === "balanced") {
    marketType = latest.market_type
  } else if (avgDOM != null) {
    marketType = avgDOM < 20 ? "sellers" : avgDOM > 60 ? "buyers" : "balanced"
  }

  // months_of_inventory is a real column. The old code ignored it and instead
  // divided the active-listing count by a hardcoded 20 "avg sales per month".
  let inventoryLevel: MarketTrends["inventoryLevel"] = "unknown"
  const monthsOfSupply = latest?.months_of_inventory ?? null
  if (monthsOfSupply != null) {
    inventoryLevel = monthsOfSupply < 2 ? "low" : monthsOfSupply > 6 ? "high" : "balanced"
  }

  // The 1-year price trend the market feed publishes, as a rate. Null when the
  // feed carries none — never a stand-in 5%.
  const appreciationRate =
    latest?.price_trend_pct_1yr != null ? latest.price_trend_pct_1yr / 100 : null

  return {
    averageDaysOnMarket: avgDOM,
    medianSalePrice: medianPrice,
    activeListings: latest?.active_listings ?? null,
    monthsOfSupply,
    inventoryLevel,
    marketType,
    appreciationRate,
    /** True when no market_data row covers this city/state at all. */
    marketDataAvailable: latest != null,
  }
}

// ─── TOMBSTONE · generateAIValuation ────────────────────────────────────────
// DELETED. Replaced by the value range lib/cma/ai-cma-orchestrator.ts:183
// `runAiCma` COMPUTES — median of the adjusted CLOSED comps, low/high at ∓3% of
// the extremes — with the model demoted to writing the narrative that explains
// it (`AiCmaResult.aiNarrative`).
//
// THIS IS THE FABRICATION THIS WAVE EXISTS TO REMOVE, stated plainly so it is
// not reintroduced by someone who thinks it was only a prompt.
//
// It sent GPT-4o a property description and asked for `"estimatedValue": number`.
// Whatever the model replied became `valuation.estimatedValue`, which became
// `pricingStrategy.recommendedListPrice` and `priceRangeLow/High`, which became
// cma_reports.recommended_price / price_range_low / price_range_high. From
// there the number is rendered on the seller portal, priced off by the net
// sheet, quoted by the price-adjustment recommender, and printed in the
// appraisal-defense package an agent hands to a licensed appraiser at the
// property. A generative model authored a figure in a column whose name states
// it was measured.
//
// Three details worth keeping on the record:
//   1. The MARKET FACTS in that prompt were themselves invented — see the note
//      in analyzeMarketTrends. The model was told a 5% appreciation rate and a
//      median sale price derived from the subject's own square footage.
//   2. With no comparables the reduce/length divisions produced NaN and the
//      `Math.min(...[])` / `Math.max(...[])` produced Infinity and -Infinity,
//      all of which were interpolated into the prompt as text. The model was
//      handed "Average Adjusted Value: $NaN" and still returned a price, and
//      that price was still written and still shown. generateAICMA now refuses
//      before this point when no closed comp was sourced.
//   3. The fallback multiplied the comp average by a `seasonalFactor` — 1.03 in
//      spring, 0.97 in winter — invented in this file with no citation.
//
// The same defect was found and fixed in app/actions/home-value.ts, which used
// to ask a chat model to "Provide exactly 3 comparable sales" and rendered the
// invented addresses to homeowners as recent sales. Its fix was to adopt
// runAiCma. This is the same fix on the agent-facing side, and it is why the
// owner's ruling — "the same cma should be used for all" — is worth enforcing:
// the two lanes did not merely differ in quality, one of them was making the
// number up.

/**
 * Generate pricing strategy recommendations
 */
async function generatePricingStrategy(
  params: CMAParams,
  cma: AiCmaResultShape,
  marketTrends: MarketTrends,
  /** Tenant + actor for the AI cost ledger. `cmaBrokerageId` came off the
   *  CONTACT row (falling back to the agents row this function already proved
   *  belongs to the authenticated user) — a row, never a caller argument. */
  spendActor: { brokerageId: string | null; userId: string | null },
): Promise<PricingStrategy> {
  // ── THE RANGE IS THE COMPS' RANGE ────────────────────────────────────────
  // It used to be `estimatedValue × (1 ∓ rangeMultiplier)` where estimatedValue
  // was the model's answer and rangeMultiplier was 3/5/7% picked off the market
  // type — so both the number and the width around it were manufactured here.
  // These three now come from runAiCma, which derives them from the ADJUSTED
  // CLOSED comps: mid is their median, low/high sit 3% outside the extremes.
  const low = cma.estimatedValueLow
  const mid = cma.estimatedValueMid
  const high = cma.estimatedValueHigh
  const confidenceLevel = Math.round(cma.confidenceScore * 100)

  /**
   * A LIST PRICE IS A STRATEGY, A VALUE IS A MEASUREMENT.
   *
   * The model is still allowed to say WHERE in the comp-supported range to list
   * — that is a genuine judgement an agent pays for, and it is why this call
   * survives the merge rather than being deleted with the rest. What it may not
   * do is leave the range. Outside [low, high] the figure is no longer supported
   * by any comparable sale, and cma_reports.recommended_price is read by the
   * seller portal, the net sheet and the appraisal-defense package as though a
   * comp stands behind it.
   */
  const clampToRange = (n: unknown): number | null => {
    const v = typeof n === "number" && Number.isFinite(n) ? n : null
    if (v == null || v <= 0) return null
    return Math.round(Math.min(high, Math.max(low, v)))
  }

  const domLine =
    marketTrends.averageDaysOnMarket != null
      ? `Average days on market: ${marketTrends.averageDaysOnMarket}`
      : "Average days on market: not reported for this area"

  const prompt = `As a real estate pricing strategist, recommend a pricing strategy for this ${params.listingType === "seller" ? "listing" : "purchase"}.

The valuation below was produced from adjusted closed comparable sales using published state appraiser adjustment rates. It is not yours to revise.
  Supported range: $${Math.round(low).toLocaleString()} – $${Math.round(high).toLocaleString()}
  Midpoint:        $${Math.round(mid).toLocaleString()}
  Closed comps behind it: ${cma.adjustedComps.length}
  Confidence: ${confidenceLevel}/100

Market type: ${marketTrends.marketType}
${domLine}
Listing type: ${params.listingType}

HARD RULE: recommendedListPrice MUST fall inside the supported range above. Do not
recommend a figure outside it, and do not restate the range. Your judgement is
WHERE within it to list and why.

Provide strategic pricing recommendations in JSON:
{
  "recommendedListPrice": number,
  "rationale": string,
  "quickSaleDiscount": number (percentage),
  "premiumPricing": number (percentage),
  "estimatedDaysToSell": number,
  "pricingTips": string[]
}`

  try {
    const { text } = await generateText({
      brokerageId: spendActor.brokerageId,
      userId: spendActor.userId,
      model: "openai/gpt-4o-mini",
      prompt,
    })

    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const strategy = JSON.parse(jsonMatch[0])
      return {
        recommendedListPrice: clampToRange(strategy.recommendedListPrice) ?? Math.round(mid),
        priceRangeLow: Math.round(low),
        priceRangeHigh: Math.round(high),
        confidenceLevel,
        rationale: strategy.rationale || "Based on adjusted comparable sales analysis",
        // Quick-sale and premium are POSITIONS WITHIN the supported range, not
        // excursions past its ends. The old code multiplied out from the model's
        // estimate and routinely produced a "premium price" no comp reached.
        quickSalePrice:
          clampToRange(mid * (1 - Math.abs(Number(strategy.quickSaleDiscount) || 5) / 100)) ??
          Math.round(low),
        premiumPrice:
          clampToRange(mid * (1 + Math.abs(Number(strategy.premiumPricing) || 3) / 100)) ??
          Math.round(high),
        // Null rather than an invented 35 when neither the model nor the market
        // feed produced one.
        daysToSellEstimate:
          (typeof strategy.estimatedDaysToSell === "number" ? strategy.estimatedDaysToSell : null) ??
          marketTrends.averageDaysOnMarket,
      }
    }
  } catch (error) {
    console.error("[AI CMA] Pricing strategy error:", error)
  }

  // Fallback strategy — still the comps' own numbers, no model involved.
  return {
    recommendedListPrice: Math.round(mid),
    priceRangeLow: Math.round(low),
    priceRangeHigh: Math.round(high),
    confidenceLevel,
    rationale:
      `Based on ${cma.adjustedComps.length} adjusted closed comparable sale(s) and current market conditions.`,
    quickSalePrice: clampToRange(mid * 0.95) ?? Math.round(low),
    premiumPrice: clampToRange(mid * 1.03) ?? Math.round(high),
    daysToSellEstimate: marketTrends.averageDaysOnMarket,
  }
}

/**
 * Generate CMA presentation content
 */
async function generateCMAPresentation(
  params: CMAParams,
  cma: AiCmaResultShape,
  marketTrends: MarketTrends,
  pricingStrategy: PricingStrategy,
  /** Same provenance as generatePricingStrategy above. */
  spendActor: { brokerageId: string | null; userId: string | null },
) {
  // Every comp named to the script writer carries its own source, so the script
  // cannot describe an AI-web-search row as a provider-reported sale — and the
  // pending/active rows are labelled ASKING PRICES, because "comparables
  // analyzed: 10" with six of them still for sale is how an active listing gets
  // narrated to a seller as a recent sale.
  const compLines = cma.adjustedComps
    .map(
      (a, i) =>
        `  ${i + 1}. ${a.comp.address} — sold $${Math.round(a.comp.salePrice).toLocaleString()} on ${a.comp.saleDate}, adjusted to $${Math.round(a.adjustedPrice).toLocaleString()}`,
    )
    .join("\n")

  const marketLines = [
    `Market type: ${marketTrends.marketType}`,
    marketTrends.averageDaysOnMarket != null
      ? `Average days on market: ${marketTrends.averageDaysOnMarket}`
      : "Average days on market: not reported for this area",
    `Inventory: ${marketTrends.inventoryLevel}`,
    marketTrends.marketDataAvailable
      ? null
      : "NOTE: no market-data record covers this city, so market context is limited to what the comparables themselves show. Do not state market statistics.",
  ]
    .filter(Boolean)
    .join("\n")

  const prompt = `Create a professional CMA presentation script for a real estate agent to present to their ${params.listingType === "seller" ? "seller" : "buyer"} client.

Property: ${params.propertyAddress}, ${params.propertyCity}, ${params.propertyState}
Recommended list price: $${pricingStrategy.recommendedListPrice.toLocaleString()}
Comp-supported range: $${pricingStrategy.priceRangeLow.toLocaleString()} – $${pricingStrategy.priceRangeHigh.toLocaleString()}

CLOSED COMPARABLE SALES (the only figures behind the valuation):
${compLines}

Still on the market (ASKING prices — never describe these as sales):
${
  [...cma.pendingComps, ...cma.activeComps]
    .map((a) => `  • ${a.comp.address} — asking $${Math.round(a.comp.salePrice).toLocaleString()} (${a.comp.status})`)
    .join("\n") || "  (none reported)"
}

MARKET:
${marketLines}

HARD RULES:
  - Use ONLY the comparables listed above. Do not add, recall or infer any other
    property, address, sale price or sale date.
  - Never describe an active or pending listing as a sale.
  - Do not state a market statistic that is not given above.

Generate a compelling presentation with:
1. Executive Summary (2-3 sentences)
2. Market Overview (3-4 key points)
3. Pricing Rationale (why this price makes sense)
4. Comparable Analysis Summary
5. Recommended Strategy
6. Next Steps

Keep it conversational and client-focused. Format as JSON:
{
  "executiveSummary": string,
  "marketOverview": string[],
  "pricingRationale": string,
  "comparablesSummary": string,
  "recommendedStrategy": string,
  "nextSteps": string[],
  "talkingPoints": string[]
}`

  try {
    const { text } = await generateText({
      brokerageId: spendActor.brokerageId,
      userId: spendActor.userId,
      model: "openai/gpt-4o",
      prompt,
    })

    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      // The mandatory disclaimers ride WITH the script rather than being left
      // for a downstream surface to remember. runAiCma builds them from what
      // actually happened — which provider served each side, whether the sold
      // window had to be widened, whether any row came off a web search.
      return { ...JSON.parse(jsonMatch[0]), disclaimers: cma.disclaimers }
    }
  } catch (error) {
    console.error("[AI CMA] Presentation error:", error)
  }

  // Fallback presentation — states only what was measured.
  return {
    executiveSummary: `Based on ${cma.adjustedComps.length} adjusted closed comparable sale(s), we recommend listing at $${pricingStrategy.recommendedListPrice.toLocaleString()} within a supported range of $${pricingStrategy.priceRangeLow.toLocaleString()}–$${pricingStrategy.priceRangeHigh.toLocaleString()}.`,
    marketOverview: [
      `Market type: ${marketTrends.marketType}`,
      marketTrends.averageDaysOnMarket != null
        ? `Average days on market: ${marketTrends.averageDaysOnMarket}`
        : "Average days on market: not reported for this area",
      `Inventory levels: ${marketTrends.inventoryLevel}`,
    ],
    pricingRationale: pricingStrategy.rationale,
    comparablesSummary: `Analyzed ${cma.adjustedComps.length} closed comparable sale(s)${
      cma.activeComps.length + cma.pendingComps.length > 0
        ? `, plus ${cma.activeComps.length} active and ${cma.pendingComps.length} pending listing(s) for market direction`
        : ""
    }.`,
    recommendedStrategy: "Strategic pricing within the comparable-supported range.",
    nextSteps: ["Review and approve pricing", "Schedule listing photos", "Prepare property for showings"],
    talkingPoints: [
      `${cma.adjustedComps.length} closed comparable sale(s) behind the range`,
      `Confidence ${Math.round(cma.confidenceScore * 100)}/100`,
    ],
    disclaimers: cma.disclaimers,
  }
}

/**
 * Update CMA with new data
 */
export async function updateCMAReport(cmaId: string, updates: Partial<any>) {
  if (!isValidUUID(cmaId)) {
    return { success: false, error: "Invalid CMA ID" }
  }

  // Auth gate — previously open. Any caller could mutate any CMA in the
  // database (the price-strategy / valuation report that goes to sellers).
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  const supabase = createServiceClient()

  try {
    // Strip caller-supplied tenant-control fields from the update payload
    const safeUpdates = { ...updates }
    delete safeUpdates.brokerage_id
    delete safeUpdates.id
    delete safeUpdates.agent_id

    const { data, error } = await supabase
      .from("cma_reports")
      .update({
        ...safeUpdates,
        updated_at: new Date().toISOString(),
      })
      .eq("id", cmaId)
      .eq("brokerage_id", ctx.brokerageId)
      .select()
      .single()

    if (error) throw error

    revalidatePath("/dashboard/cma")
    return { success: true, cma: data }
  } catch (error) {
    console.error("[AI CMA] Update error:", error)
    return { success: false, error: "Failed to update CMA" }
  }
}

/**
 * Get CMA reports for agent
 */
export async function getCMAReports(agentId: string, filters?: { status?: string; contactId?: string }) {
  if (!isValidUUID(agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  // Auth gate — previously open. Any caller could read any agent's CMAs
  // by passing the agent_id.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  const supabase = createServiceClient()

  try {
    // Always scope by caller's brokerage; agent_id narrows within it.
    let query = supabase
      .from("cma_reports")
      .select("*")
      .eq("brokerage_id", ctx.brokerageId)
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false })

    if (filters?.status) {
      query = query.eq("status", filters.status)
    }
    if (filters?.contactId) {
      query = query.eq("contact_id", filters.contactId)
    }

    const { data, error } = await query

    if (error) throw error

    return { success: true, reports: data }
  } catch (error) {
    console.error("[AI CMA] Fetch error:", error)
    return { success: false, error: "Failed to fetch CMA reports" }
  }
}

/**
 * AI-powered price adjustment recommendation
 */
export async function getAIPriceAdjustmentRecommendation(
  cmaId: string,
  currentListPrice: number,
  daysOnMarket: number,
  showingCount: number,
  feedbackSummary?: string
) {
  if (!isValidUUID(cmaId)) {
    return { success: false, error: "Invalid CMA ID" }
  }

  // Auth gate — burns paid AI inference and reads sensitive CMA data.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  const supabase = createServiceClient()

  try {
    // COLUMNS VERIFIED LIVE. This read was `select("*")` and the prompt below then
    // interpolated `cma.ai_valuation?.estimatedValue` and `cma.market_trends?.marketType`
    // — NEITHER COLUMN EXISTS on cma_reports (checked against
    // information_schema.columns: the valuation lives in recommended_price /
    // price_range_low / price_range_high and the market read is market_conditions).
    // `select("*")` is why nothing ever complained: the optional chains resolved
    // to undefined and the prompt shipped "AI Estimated Value: $Unknown / Market
    // Type: Unknown" on EVERY call. So every price-adjustment recommendation this
    // action has ever produced was made with no knowledge of what the CMA
    // concluded — it was reasoning from days-on-market and showing count alone
    // while presenting itself as an adjustment to a valuation it never saw.
    // The columns are now named explicitly, which is also what stops the next
    // phantom from hiding.
    const { data: cma, error: cmaError } = await supabase
      .from("cma_reports")
      .select("id, recommended_price, price_range_low, price_range_high, market_conditions, property_address, comparable_count")
      .eq("id", cmaId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()

    // A refused read must not fall through to "CMA not found" and must certainly
    // not fall through to a paid model call.
    if (cmaError) {
      console.error("[AI CMA] price adjustment CMA read failed:", cmaError.message)
      return { success: false, error: "Could not load that CMA." }
    }
    if (!cma) {
      return { success: false, error: "CMA not found" }
    }

    const valuationLine =
      cma.recommended_price != null
        ? `- CMA recommended price: $${Number(cma.recommended_price).toLocaleString()}` +
          (cma.price_range_low != null && cma.price_range_high != null
            ? ` (range $${Number(cma.price_range_low).toLocaleString()}–$${Number(cma.price_range_high).toLocaleString()})`
            : "")
        : "- CMA recommended price: not recorded on this report"

    const prompt = `As a real estate pricing strategist, analyze this listing's performance and recommend a price adjustment.

CURRENT SITUATION:
- Original List Price: $${currentListPrice.toLocaleString()}
- Days on Market: ${daysOnMarket}
- Number of Showings: ${showingCount}
- Showings per Week: ${(showingCount / Math.max(1, daysOnMarket / 7)).toFixed(1)}
- Feedback Summary: ${feedbackSummary || "No specific feedback"}

ORIGINAL VALUATION:
${valuationLine}
- Comparables used: ${cma.comparable_count ?? "not recorded"}
- Market conditions at the time of the CMA: ${cma.market_conditions || "not recorded"}

BENCHMARKS:
- If showings/week < 2 in seller's market = overpriced
- If showings/week < 1 in balanced market = significantly overpriced
- If DOM > 2x market average with low showings = price reduction needed

Provide adjustment recommendation in JSON:
{
  "recommendedAction": "reduce" | "hold" | "increase",
  "suggestedNewPrice": number,
  "percentageChange": number,
  "rationale": string,
  "urgency": "immediate" | "soon" | "monitor",
  "expectedImpact": string
}`

    const { text } = await generateText({
      brokerageId: ctx.brokerageId,
      userId: ctx.userId,
      agentId: ctx.agentId,
      model: "openai/gpt-4o",
      prompt,
    })

    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const recommendation = JSON.parse(jsonMatch[0])
      
      // Log recommendation onto the canonical cma_price_adjustments columns
      // (cma_report_id/adjustment_type/adjustment_amount/rationale). The legacy
      // cma_id/current_price/recommended_price/recommendation/days_on_market/showing_count
      // columns never existed on the live table.
      // supabase-js RESOLVES a refused insert, so this `await` reported a logged
      // recommendation whether or not one was stored. `logged` carries the truth
      // to the caller instead; the recommendation itself is still returned,
      // because the model call is already paid for.
      const { error: adjustmentError } = await supabase.from("cma_price_adjustments").insert({
        cma_report_id: cmaId,
        adjustment_type: "price_recommendation",
        adjustment_amount: (recommendation.suggestedNewPrice ?? currentListPrice) - currentListPrice,
        rationale: `Recommended ${recommendation.recommendedAction ?? "adjustment"}: $${currentListPrice.toLocaleString()} → $${(recommendation.suggestedNewPrice ?? currentListPrice).toLocaleString()} (${recommendation.percentageChange ?? 0}%). DOM ${daysOnMarket}, ${showingCount} showings. ${recommendation.rationale ?? ""}`.trim(),
      })
      if (adjustmentError) {
        console.error("[AI CMA] cma_price_adjustments insert refused:", adjustmentError.message)
      }

      return { success: true, recommendation, logged: !adjustmentError }
    }

    return { success: false, error: "Failed to generate recommendation" }
  } catch (error) {
    console.error("[AI CMA] Price adjustment error:", error)
    return { success: false, error: "Failed to get price adjustment recommendation" }
  }
}
