import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runDealKillerRadar } from "@/lib/property-risk/deal-killer-runner"
import type { PropertyRiskInput } from "@/lib/property-risk/buyer-target-analyzer"

/**
 * DEAL-KILLER RADAR sweep — every 6 hours
 * (schedule registered in lib/kernel/cron-dispatch.ts — minute 40, every 6th
 * hour; the cron expression is not spelled here because its slash-star would
 * close this block comment).
 *
 * WHY (wave 26). lib/property-risk/deal-killer-runner.ts:24 runDealKillerRadar
 * had no caller: the radar that flags a buyer's target property BEFORE they
 * write an offer had never scanned anything. This is the trigger.
 *
 * POPULATION: saved_properties (the buyer's own target list) that are not
 * dismissed and resolve to a real listing. The runner proposes a GATED agent
 * heads-up through proposeClientMessage — nothing reaches a client, and nothing
 * reaches the agent either until they approve it.
 *
 * WHAT THE ANALYZER CAN AND CANNOT SEE FROM A CRON (CLAUDE.md §2 — the blind
 * spots are published beside the number, not left implied):
 *   · floodZone     ← listings.flood_zone                    ✅
 *   · daysOnMarket  ← today − listings.listing_date          ✅
 *   · priceCutCount ← listing_price_changes (new < old)      ✅
 *   · compMedian    ← median sold_price of THE SAME BROKERAGE's listings in the
 *                     same city + property_type, sold in the last 180 days
 *                     ✅ (derived here). Tenant-scoped on purpose — see the note
 *                     at compMedianFor; a median over another brokerage's sales
 *                     is both a cross-tenant read and a wrong number.
 *   · quickLists / foreclosureStatus                          ❌ NOT AVAILABLE
 *     Those are BatchData quickList tags, and the only code that reads them
 *     lives inside the fenced scraping area (lib/lead-pipeline/scraper-parsers.ts).
 *     CONSEQUENCE, STATED PLAINLY: the `title_lien` CRITICAL signal and the
 *     `hoa` info signal cannot fire from this cron. The analyzer is silent on a
 *     missing field by design, so nothing is fabricated — but a clean verdict
 *     here does not mean a clean title.
 *
 * COST BOUND: the runner calls generatePersonaCopy (an AI call) per flagged
 * property, so proposals are capped per run and the cap is reported.
 *
 * IDEMPOTENCY: a prior proposal for the same (contact, property) inside 30 days
 * suppresses a repeat — checked against agent_client_messages before the AI
 * call, so a duplicate costs nothing rather than costing a generation.
 *
 * Tenant: platform cron on the service client, gated by the cron secret; every
 * proposal is written under the saved property's own brokerage_id (§4).
 */
export const dynamic = "force-dynamic"
export const maxDuration = 300

const BATCH = 400
const MAX_PROPOSALS = 25
const DEDUPE_DAYS = 30
const COMP_WINDOW_DAYS = 180

type Svc = ReturnType<typeof createServiceClient>

function median(values: number[]): number | null {
  const v = values.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b)
  if (v.length === 0) return null
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

export async function GET(request: Request) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "deal-killer-radar",
    cron_path: "/app/api/cron/deal-killer-radar/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[DealKillerRadar] Failed to record cron start:", startRecordResult.error)
  }

  try {
    const supabase: Svc = createServiceClient()
    const dedupeSince = new Date(Date.now() - DEDUPE_DAYS * 86_400_000).toISOString()
    const compSince = new Date(Date.now() - COMP_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10)

    const { data: saved, error: savedError } = await supabase
      .from("saved_properties")
      .select("id, brokerage_id, contact_id, listing_id, property_address, list_price, dismissed")
      .not("listing_id", "is", null)
      .not("contact_id", "is", null)
      .neq("dismissed", true)
      .order("saved_at", { ascending: false })
      .limit(BATCH)
    if (savedError) throw new Error(`saved_properties read refused: ${savedError.message}`)

    const rows = (saved ?? []) as Record<string, any>[]
    const listingIds = [...new Set(rows.map((r) => r.listing_id as string).filter(Boolean))]

    // ── Listings behind those targets ────────────────────────────────────────
    const listingById = new Map<string, Record<string, any>>()
    for (let i = 0; i < listingIds.length; i += 200) {
      const slice = listingIds.slice(i, i + 200)
      const { data: listings, error: listingsError } = await supabase
        .from("listings")
        .select("id, list_price, flood_zone, listing_date, city, state, property_type, address")
        .in("id", slice)
      if (listingsError) throw new Error(`listings read refused: ${listingsError.message}`)
      for (const l of (listings ?? []) as Record<string, any>[]) listingById.set(l.id, l)
    }

    // ── Price-cut counts, one read for the whole batch ───────────────────────
    const priceCuts = new Map<string, number>()
    for (let i = 0; i < listingIds.length; i += 200) {
      const slice = listingIds.slice(i, i + 200)
      const { data: changes, error: changesError } = await supabase
        .from("listing_price_changes")
        .select("listing_id, old_price, new_price")
        .in("listing_id", slice)
        .limit(2000)
      if (changesError) throw new Error(`listing_price_changes read refused: ${changesError.message}`)
      for (const c of (changes ?? []) as Record<string, any>[]) {
        const oldP = Number(c.old_price), newP = Number(c.new_price)
        if (Number.isFinite(oldP) && Number.isFinite(newP) && newP < oldP) {
          priceCuts.set(c.listing_id, (priceCuts.get(c.listing_id) ?? 0) + 1)
        }
      }
    }

    // ── Comp median per (brokerage, city, property_type), computed once ─────
    // SCOPED PER BROKERAGE, and the cache key carries the tenant. This sweep runs
    // across every tenant on the cron secret, so a median keyed on (city, type)
    // alone would have let ONE brokerage's sold prices set the comp another
    // brokerage's radar judges its buyer's target against — a cross-tenant read
    // of exactly the kind CLAUDE.md §4 exists to make impossible, and a wrong
    // answer as well as a leak: a market median is only meaningful over data the
    // tenant actually has. A thin sample yields a null median, which the analyzer
    // is already silent on, rather than a borrowed one.
    const compCache = new Map<string, number | null>()
    async function compMedianFor(brokerageId: string, city: string | null, propertyType: string | null): Promise<number | null> {
      if (!city) return null
      const key = `${brokerageId}|${city.toLowerCase()}|${(propertyType ?? "").toLowerCase()}`
      if (compCache.has(key)) return compCache.get(key) ?? null
      let q = supabase
        .from("listings")
        .select("sold_price")
        .eq("brokerage_id", brokerageId)
        .eq("city", city)
        .not("sold_price", "is", null)
        .gte("sold_date", compSince)
        .limit(200)
      if (propertyType) q = q.eq("property_type", propertyType)
      const { data: sold, error: soldError } = await q
      if (soldError) {
        // A refused comp read must not be read as "no comps" — record it and
        // leave compMedian null so the analyzer stays silent rather than
        // asserting a price gap it could not measure.
        console.error("[DealKillerRadar] comp read refused:", soldError.message)
        compCache.set(key, null)
        return null
      }
      const m = median(((sold ?? []) as Record<string, any>[]).map((s) => Number(s.sold_price)))
      compCache.set(key, m)
      return m
    }

    let scanned = 0
    let flagged = 0
    let proposed = 0
    let deduped = 0
    let clean = 0
    let refused = 0
    let capped = false
    const refusals: Array<{ savedPropertyId: string; error: string }> = []
    const byRiskLevel: Record<string, number> = {}

    for (const r of rows) {
      scanned += 1
      const listing = listingById.get(r.listing_id as string)
      if (!listing || !r.brokerage_id) continue

      const address = (listing.address as string | null) ?? (r.property_address as string | null) ?? "this property"
      const listPrice = Number(listing.list_price ?? r.list_price ?? 0)
      if (!Number.isFinite(listPrice) || listPrice <= 0) continue

      let daysOnMarket: number | null = null
      if (listing.listing_date) {
        const t = new Date(listing.listing_date as string).getTime()
        if (Number.isFinite(t)) daysOnMarket = Math.floor((Date.now() - t) / 86_400_000)
      }

      const risk: PropertyRiskInput = {
        listPrice,
        floodZone: (listing.flood_zone as string | null) ?? null,
        compMedian: await compMedianFor(r.brokerage_id as string, listing.city as string | null, listing.property_type as string | null),
        daysOnMarket,
        priceCutCount: priceCuts.get(r.listing_id as string) ?? 0,
        // Not reachable from a cron — see the header's blind-spot note.
        quickLists: null,
        foreclosureStatus: null,
      }

      // Dedupe BEFORE the AI call: a duplicate must cost nothing.
      const { data: prior, error: priorError } = await supabase
        .from("agent_client_messages")
        .select("id")
        .eq("brokerage_id", r.brokerage_id)
        .eq("entity_id", r.contact_id)
        .eq("agent_kind", "shopping_agent")
        .eq("subject", `Pre-offer red flags — ${address}`)
        .gte("created_at", dedupeSince)
        .limit(1)
      if (priorError) {
        // FAIL CLOSED: an unreadable dedupe table must not license a repeat.
        refused += 1
        if (refusals.length < 20) refusals.push({ savedPropertyId: r.id, error: `dedupe read: ${priorError.message}` })
        continue
      }
      if (prior && prior.length > 0) {
        deduped += 1
        continue
      }

      if (proposed >= MAX_PROPOSALS) {
        capped = true
        continue
      }

      try {
        const result = await runDealKillerRadar({
          brokerageId: r.brokerage_id,
          contactId: r.contact_id,
          propertyAddress: address,
          risk,
        }, supabase)
        byRiskLevel[result.riskLevel] = (byRiskLevel[result.riskLevel] ?? 0) + 1
        if (!result.flagged) { clean += 1; continue }
        flagged += 1
        if (result.ok) proposed += 1
        else {
          refused += 1
          if (refusals.length < 20) refusals.push({ savedPropertyId: r.id, error: "proposeClientMessage refused" })
        }
      } catch (e) {
        refused += 1
        if (refusals.length < 20) refusals.push({ savedPropertyId: r.id, error: e instanceof Error ? e.message : String(e) })
      }
    }

    const payload = {
      scanned,
      batch_cap: BATCH,
      batch_capped: rows.length >= BATCH,
      flagged,
      proposed,
      deduped,
      clean,
      by_risk_level: byRiskLevel,
      proposal_cap: MAX_PROPOSALS,
      proposal_capped: capped,
      refused,
      refusals,
      blind_spots: [
        "quickLists / foreclosureStatus come from BatchData and the reader is inside the fenced scraping area — the title_lien CRITICAL signal and the hoa signal CANNOT fire from this cron",
        "compMedian is derived from same-city, same-property-type listings sold in the last 180 days, not from an AVM",
      ],
    }
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: scanned,
      output_count: proposed,
      metadata: payload,
    })
    return NextResponse.json({ success: true, ...payload })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[DealKillerRadar] failed:", message)
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
