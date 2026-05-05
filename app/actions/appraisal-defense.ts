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
    }>
    adjustedValue: number
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
      `id, brokerage_id, listing_id, subject_address, subject_sqft, subject_beds, subject_baths,
       subject_year_built, list_price, market_context`,
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
        `id, address, sale_price, sale_date, sqft, bedrooms, bathrooms, year_built, distance_mi`,
      )
      .eq("report_id", report.id)
      .order("sale_date", { ascending: false }),
    supabase
      .from("cma_price_adjustments")
      .select("comparable_id, label, amount, direction, rationale")
      .eq("report_id", report.id),
  ])

  if (!comps || comps.length === 0) {
    return { success: false, error: "no_comparables" }
  }

  const adjByComp = new Map<string, any[]>()
  for (const a of adjustments ?? []) {
    if (!adjByComp.has(a.comparable_id)) adjByComp.set(a.comparable_id, [])
    adjByComp.get(a.comparable_id)!.push(a)
  }

  const builtComps = comps.map((c) => {
    const adjs = adjByComp.get(c.id) ?? []
    const adjustedValue = adjs.reduce(
      (sum, a) => sum + (a.direction === "subtract" ? -1 : 1) * Number(a.amount),
      Number(c.sale_price),
    )
    return {
      address: c.address as string,
      salePrice: Number(c.sale_price),
      saleDate: c.sale_date as string | null,
      sqft: c.sqft as number | null,
      bedrooms: c.bedrooms as number | null,
      bathrooms: c.bathrooms as number | null,
      yearBuilt: c.year_built as number | null,
      distanceMi: c.distance_mi as number | null,
      adjustments: adjs.map((a) => ({
        label: a.label as string,
        amount: Number(a.amount),
        direction: a.direction as "add" | "subtract",
        rationale: (a.rationale as string | null) ?? null,
      })),
      adjustedValue,
    }
  })

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

  const contractPrice = input.contractPrice ?? report.list_price ?? null
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

  const market = (report.market_context ?? null) as any

  return {
    success: true,
    package: {
      generatedAt: new Date().toISOString(),
      subjectProperty: {
        address: report.subject_address as string,
        listPrice: (report.list_price as number | null) ?? null,
        contractPrice,
        sqft: (report.subject_sqft as number | null) ?? null,
        bedrooms: (report.subject_beds as number | null) ?? null,
        bathrooms: (report.subject_baths as number | null) ?? null,
        yearBuilt: (report.subject_year_built as number | null) ?? null,
      },
      comparables: top,
      summary: {
        indicatedRangeLow,
        indicatedRangeHigh,
        indicatedMidpoint,
        contractWithinRange,
        spread,
        perSqftRangeLow,
        perSqftRangeHigh,
      },
      marketContext: market
        ? {
            activeCount: market.active_count ?? null,
            pendingCount: market.pending_count ?? null,
            avgDaysOnMarket: market.avg_dom ?? null,
            monthsOfSupply: market.months_of_supply ?? null,
          }
        : null,
      argumentBullets,
    },
  }
}
