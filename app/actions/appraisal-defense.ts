"use server"

/**
 * app/actions/appraisal-defense.ts
 *
 * Builds an Appraisal Defense Package: a structured one-pager (the agent
 * can render it as PDF or print directly from the browser) that argues for
 * the contract price using the existing CMA + adjustments data the agent
 * already has on file.
 *
 * This is reused at three points in the lifecycle:
 *   • Post-low-appraisal — submit to the appraiser via Reconsideration
 *   • Pre-appraisal       — leave on the kitchen counter at the appointment
 *   • Buyer-side          — share with buyer to defend their offer
 *
 * Reads from the existing tables created by the CMA system:
 *   • cma_reports           — selected CMA for the listing
 *   • cma_comparables       — comps already chosen by the agent
 *   • cma_price_adjustments — per-feature adjustments (migration 996b)
 *
 * TOMBSTONE (2026-08-27, §1.1): POST /api/listings/[listingId]/appraisal-defense
 * (app/api/listings/[listingId]/appraisal-defense/route.ts) is DELETED. It was
 * the only caller of this action and NOTHING in the tree called the route
 * (repo-wide sweep incl. e2e/workflows/tools/services; it sat in
 * scripts/opposite-missing-baseline.json as a door with no knocker). The
 * SURVIVOR is the UI entry that was the missing half: the CMA report tab —
 * app/dashboard/listings/[id]/cma/tabs/cma-report-tab.tsx (handleBuildDefense)
 * — calls this server action directly with the report id it already holds,
 * where the route had to re-resolve listing → latest CMA first. §5 note: this
 * packet is appraiser-facing, so its content is DETERMINISTIC end to end —
 * comp rows, state-guideline adjustments with their vintage, template bullets
 * over computed numbers; no model-authored text (see one_cma_engine).
 */

import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"

export interface AppraisalDefensePackage {
  generatedAt: string
  subjectProperty: {
    address: string
    listPrice: number | null
    contractPrice: number | null
    sqft: number | null
    bedrooms: number | null
    bathrooms: number | null
    yearBuilt: number | null
  }
  comparables: Array<{
    address: string
    salePrice: number
    saleDate: string | null
    sqft: number | null
    bedrooms: number | null
    bathrooms: number | null
    yearBuilt: number | null
    distanceMi: number | null
    adjustments: Array<{
      label: string
      amount: number
      direction: "add" | "subtract"
      rationale: string | null
      /**
       * cma_price_adjustments.comparable_address — the address the ADJUSTMENT ROW
       * itself records, copied at write time from the comp it was computed
       * against (app/actions/ai-cma.ts:532). Kept beside the joined comp so the
       * packet can SHOW that the two agree, and flag it when they do not.
       *
       * §5: this document reaches a licensed appraiser, so the address is the
       * STORED string, verbatim, and is never composed, normalised or generated.
       * Null on rows written before the column was populated.
       */
      recordedAddress: string | null
      /** TRUE when the adjustment's own recorded address disagrees with the comp
       *  it is filed under. Never silently reconciled — the appraiser is told. */
      addressMismatch: boolean
    }>
    adjustedValue: number
  }>
  /**
   * ADJUSTMENTS THIS REPORT HOLDS THAT NO COMP IN IT CLAIMS.
   *
   * The packet joins adjustments to comps on `comparable_property_id`. Any row
   * whose id matches no comp — a comp deleted after the adjustment was written, a
   * partially-failed comp insert (ai-cma.ts:510 warns about exactly that), or a
   * row carrying no comparable id at all — used to vanish from the packet with no
   * trace, leaving an appraiser a value range whose stored adjustments do not add
   * up to it and nothing but a uuid to ask about. comparable_address is the
   * human-readable fact that makes the gap NAMEABLE. Listed, never dropped, and
   * never folded into the value math.
   */
  unattachedAdjustments: Array<{
    /** The stored address, verbatim. Null when the row recorded none — said as
     *  "address not recorded", never filled in from anywhere else. */
    recordedAddress: string | null
    label: string
    amount: number
    direction: "add" | "subtract"
    rationale: string | null
  }>
  summary: {
    indicatedRangeLow: number
    indicatedRangeHigh: number
    indicatedMidpoint: number
    contractWithinRange: boolean
    spread: number
    perSqftRangeLow: number | null
    perSqftRangeHigh: number | null
  }
  marketContext: {
    activeCount: number | null
    pendingCount: number | null
    avgDaysOnMarket: number | null
    monthsOfSupply: number | null
  } | null
  /** cma_reports.market_conditions — the market classification recorded on the
   *  CMA itself. Null when the CMA recorded none. */
  marketConditionLabel: string | null
  argumentBullets: string[]
}

interface BuildInput {
  cmaReportId: string
  contractPrice?: number
}

export async function buildAppraisalDefensePackage(
  input: BuildInput,
): Promise<{ success: true; package: AppraisalDefensePackage } | { success: false; error: string }> {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false, error: "unauthenticated" }

  const { data: report } = await supabase
    .from("cma_reports")
    .select(
      `id, brokerage_id, listing_id, property_address, square_feet, bedrooms, bathrooms,
       year_built, recommended_price, price_range_low, price_range_high, market_conditions`,
    )
    .eq("id", input.cmaReportId)
    .maybeSingle()

  if (!report || report.brokerage_id !== auth.brokerageId) {
    return { success: false, error: "cma_not_found" }
  }

  const [{ data: comps }, { data: adjustments }] = await Promise.all([
    supabase
      .from("cma_comparables")
      .select(
        `id, address, sale_price, sale_date, square_feet, bedrooms, bathrooms, distance_miles, adjusted_price`,
      )
      .eq("cma_id", report.id)
      .order("sale_date", { ascending: false }),
    supabase
      .from("cma_price_adjustments")
      // comparable_address is the adjustment row's OWN record of which property it
      // was computed against. Selecting it is what lets this packet name an
      // adjustment it cannot attach, instead of showing a uuid or dropping it.
      .select("comparable_property_id, comparable_address, adjustment_type, adjustment_amount, rationale")
      .eq("cma_report_id", report.id),
  ])

  if (!comps || comps.length === 0) {
    return { success: false, error: "no_comparables" }
  }

  const adjByComp = new Map<string, any[]>()
  for (const a of adjustments ?? []) {
    const k = a.comparable_property_id as string
    if (!adjByComp.has(k)) adjByComp.set(k, [])
    adjByComp.get(k)!.push(a)
  }

  const builtComps = comps.map((c) => {
    const adjs = adjByComp.get(c.id as string) ?? []
    // adjustment_amount is signed (negative subtracts, positive adds);
    // direction is encoded in the sign rather than a separate column.
    const adjustedValue = adjs.length
      ? adjs.reduce((sum, a) => sum + Number(a.adjustment_amount), Number(c.sale_price))
      : c.adjusted_price != null
        ? Number(c.adjusted_price)
        : Number(c.sale_price)
    return {
      address: c.address as string,
      salePrice: Number(c.sale_price),
      saleDate: c.sale_date as string | null,
      sqft: c.square_feet as number | null,
      bedrooms: c.bedrooms as number | null,
      bathrooms: c.bathrooms as number | null,
      yearBuilt: null as number | null, // not on cma_comparables
      distanceMi: c.distance_miles as number | null,
      adjustments: adjs.map((a) => {
        // VERBATIM. The stored string is compared and displayed as-is; only the
        // MISMATCH TEST trims and case-folds, because "123 Main St " and
        // "123 Main St" are the same address and flagging that at an appraiser
        // would be noise. Nothing is rewritten for display.
        const recordedAddress = (a.comparable_address as string | null) ?? null
        const norm = (s: string | null) => (s ?? "").trim().toLowerCase()
        return {
          label: a.adjustment_type as string,
          amount: Math.abs(Number(a.adjustment_amount)),
          direction: (Number(a.adjustment_amount) < 0 ? "subtract" : "add") as "add" | "subtract",
          rationale: (a.rationale as string | null) ?? null,
          recordedAddress,
          addressMismatch: !!recordedAddress && norm(recordedAddress) !== norm(c.address as string),
        }
      }),
      adjustedValue,
    }
  })

  // The rows the join could not place. Computed against the WHOLE comp set for
  // this report, before the top-3 trim below, so "unattached" means "matches no
  // comp on file" and never "did not make the cut".
  const compIds = new Set((comps ?? []).map((c) => c.id as string))
  const unattachedAdjustments = (adjustments ?? [])
    .filter((a) => {
      const id = a.comparable_property_id as string | null
      return !id || !compIds.has(id)
    })
    .map((a) => ({
      recordedAddress: (a.comparable_address as string | null) ?? null,
      label: a.adjustment_type as string,
      amount: Math.abs(Number(a.adjustment_amount)),
      direction: (Number(a.adjustment_amount) < 0 ? "subtract" : "add") as "add" | "subtract",
      rationale: (a.rationale as string | null) ?? null,
    }))

  // Trim to the strongest 3 comps (closest by distance, then most recent sale).
  const ranked = [...builtComps].sort((a, b) => {
    const distDelta = (a.distanceMi ?? 99) - (b.distanceMi ?? 99)
    if (Math.abs(distDelta) > 0.05) return distDelta
    return (b.saleDate ?? "").localeCompare(a.saleDate ?? "")
  })
  const top = ranked.slice(0, 3)

  const adjusted = top.map((c) => c.adjustedValue)
  const indicatedRangeLow = Math.min(...adjusted)
  const indicatedRangeHigh = Math.max(...adjusted)
  const indicatedMidpoint = adjusted.reduce((s, n) => s + n, 0) / adjusted.length

  const contractPrice = input.contractPrice ?? report.recommended_price ?? null
  const contractWithinRange =
    contractPrice != null && contractPrice >= indicatedRangeLow && contractPrice <= indicatedRangeHigh
  const spread = indicatedRangeHigh - indicatedRangeLow

  const perSqfts = top
    .filter((c) => c.sqft && c.sqft > 0)
    .map((c) => c.adjustedValue / (c.sqft as number))
  const perSqftRangeLow = perSqfts.length ? Math.min(...perSqfts) : null
  const perSqftRangeHigh = perSqfts.length ? Math.max(...perSqfts) : null

  const argumentBullets: string[] = []
  argumentBullets.push(
    `Three closed comparables within ${Math.max(...top.map((c) => c.distanceMi ?? 0)).toFixed(1)} miles support an adjusted value range of $${Math.round(indicatedRangeLow).toLocaleString()}–$${Math.round(indicatedRangeHigh).toLocaleString()}.`,
  )
  if (contractPrice != null) {
    argumentBullets.push(
      contractWithinRange
        ? `The contract price of $${contractPrice.toLocaleString()} sits within the indicated range and is supported by the adjusted comp midpoint of $${Math.round(indicatedMidpoint).toLocaleString()}.`
        : `The contract price of $${contractPrice.toLocaleString()} is ${
            contractPrice > indicatedRangeHigh ? "above" : "below"
          } the indicated range; see per-feature adjustments below for justification.`,
    )
  }
  if (perSqftRangeLow != null && perSqftRangeHigh != null) {
    argumentBullets.push(
      `Adjusted price per square foot ranges $${perSqftRangeLow.toFixed(0)}–$${perSqftRangeHigh.toFixed(0)} across the comp set.`,
    )
  }

  // cma_reports.market_conditions is a TEXT LABEL ("sellers" | "balanced" |
  // "buyers" | "unknown") — the value app/actions/ai-cma.ts writes from the
  // market_data read. This block used to treat it as an object and reach for
  // `.active_count`, `.pending_count`, `.avg_dom`, `.months_of_supply`: on a
  // string every one of those is undefined, yet the string is TRUTHY, so the
  // packet always emitted a marketContext block of four nulls. An appraiser
  // reading it saw a market section that had been populated and had nothing in
  // it, rather than one that was honestly absent.
  //
  // The counts live on market_data, which this package does not read; until it
  // does, the market section carries the one fact the CMA actually recorded.
  const marketLabel =
    typeof report.market_conditions === "string" && report.market_conditions.length > 0
      ? report.market_conditions
      : null
  if (marketLabel && marketLabel !== "unknown") {
    argumentBullets.push(
      `At the time of the analysis this area was classified a ${marketLabel} market.`,
    )
  }

  // DISCLOSE THE GAP, IN THE DOCUMENT ITSELF. Template text over counted rows —
  // no model wrote this sentence, and the addresses in it are the stored strings
  // (§5). Silence here would let an appraiser read a value range as fully
  // explained by the adjustments shown when it is not.
  if (unattachedAdjustments.length > 0) {
    const named = unattachedAdjustments
      .map((a) => a.recordedAddress)
      .filter((v): v is string => !!v)
    const unique = Array.from(new Set(named))
    argumentBullets.push(
      `${unattachedAdjustments.length} recorded adjustment(s) on this CMA are not attached to any comparable on file` +
      (unique.length > 0 ? ` (recorded against ${unique.join("; ")})` : " (no address recorded on them)") +
      ` and are therefore NOT included in the adjusted values above.`,
    )
  }
  // Same rule for a comp whose own adjustment rows name a different address.
  const mismatched = top.flatMap((c) =>
    c.adjustments.filter((a) => a.addressMismatch).map((a) => ({ comp: c.address, recorded: a.recordedAddress })),
  )
  if (mismatched.length > 0) {
    argumentBullets.push(
      `${mismatched.length} adjustment(s) shown above record a different subject address than the comparable they are filed under ` +
      `(${Array.from(new Set(mismatched.map((m) => `${m.recorded} vs ${m.comp}`))).join("; ")}); verify before relying on them.`,
    )
  }

  return {
    success: true,
    package: {
      generatedAt: new Date().toISOString(),
      subjectProperty: {
        address: report.property_address as string,
        listPrice: (report.recommended_price as number | null) ?? null,
        contractPrice,
        sqft: (report.square_feet as number | null) ?? null,
        bedrooms: (report.bedrooms as number | null) ?? null,
        bathrooms: (report.bathrooms as number | null) ?? null,
        yearBuilt: (report.year_built as number | null) ?? null,
      },
      comparables: top,
      unattachedAdjustments,
      summary: {
        indicatedRangeLow,
        indicatedRangeHigh,
        indicatedMidpoint,
        contractWithinRange,
        spread,
        perSqftRangeLow,
        perSqftRangeHigh,
      },
      // Null until this package reads market_data. A block of four nulls is not
      // "we looked and the market has no listings"; it is "nothing was read".
      marketContext: null,
      marketConditionLabel: marketLabel,
      argumentBullets,
    },
  }
}
