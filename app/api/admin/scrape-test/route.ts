import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { ZenrowsClient, BatchDataClient } from "@/lib/external"
import { buildTerritoryPhrases } from "@/lib/lead-pipeline/source-intent-map"
import {
  type NormalizedScrapedRecord,
  isViableRecord,
} from "@/lib/lead-pipeline/raw-record-types"

export const dynamic = "force-dynamic"

/**
 * GET /api/admin/scrape-test?marketId=xxx&source=batchdata_motivated&dryRun=true
 *
 * Returns a preview of what the scraper would produce for a given market + source
 * WITHOUT writing anything to raw_scraped_leads.
 *
 * Auth: Bearer CRON_SECRET (same secret used by the cron itself)
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const marketId = searchParams.get("marketId")
  const source   = searchParams.get("source") ?? "batchdata_motivated"

  if (!marketId) {
    return NextResponse.json({ error: "marketId is required" }, { status: 400 })
  }

  const supabase = await createClient()

  // Load the market — all geography from DB, zero hardcoded
  const { data: market, error: marketErr } = await supabase
    .from("lead_scraping_markets")
    .select("id, brokerage_id, name, city, state, zip_codes, counties, enabled_sources, monthly_budget_usd, spend_this_month, is_active")
    .eq("id", marketId)
    .single()

  if (marketErr || !market) {
    return NextResponse.json({ error: "Market not found", details: marketErr?.message }, { status: 404 })
  }

  // Build territory phrases regardless of source — always returned for inspection
  const phrases = buildTerritoryPhrases({
    city:      market.city,
    state:     market.state,
    zip_codes: market.zip_codes,
    counties:  market.counties,
  })

  const previewRecords: NormalizedScrapedRecord[] = []
  let estimatedCost = 0
  let errorMessage: string | null = null

  try {
    if (source === "batchdata_motivated") {
      const batchdata = new BatchDataClient()
      const location  = `${market.city}, ${market.state}`
      const rawSellers = await batchdata.getMotivatedSellerData(location)

      // Inline normalization for dry-run preview (mirrors normalizeBatchDataRecord logic in the cron route)
      for (const r of rawSellers.slice(0, 10)) {
        const raw        = r as Record<string, unknown>
        const firstName  = (raw.firstName ?? raw.first_name ?? raw.owner_name?.toString().split(' ')[0] ?? '') as string
        const lastName   = (raw.lastName  ?? raw.last_name  ?? raw.owner_name?.toString().split(' ').slice(1).join(' ') ?? '') as string
        const rawScore   = raw.motivationConfidence ?? raw.motivation_score ?? 0.5
        const score      = Math.min(100, Math.max(0, Math.round(Number(rawScore) * (Number(rawScore) <= 1 ? 100 : 1))))
        const idSlug     = `${firstName}-${lastName}-${raw.propertyAddress ?? raw.property_address ?? ''}`
          .toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
        const record: NormalizedScrapedRecord = {
          sourceRecordId:  `batchdata-${idSlug || Date.now()}`,
          source:          "batchdata_motivated",
          behaviorType:    "motivated_seller",
          intentType:      "seller",
          intentSignals:   [(raw.motivationType ?? raw.motivation_type ?? 'motivated_seller') as string],
          firstName:       firstName || null,
          lastName:        lastName  || null,
          email:           (raw.email  as string | null) ?? null,
          phone:           (raw.phone  as string | null) ?? null,
          city:            (raw.city   as string | null) ?? market.city,
          state:           (raw.state  as string | null) ?? market.state,
          propertyAddress: (raw.propertyAddress ?? raw.property_address) as string | null ?? null,
          motivationScore: score,
          rawPayload:      raw,
        }
        if (isViableRecord(record)) previewRecords.push(record)
      }
      estimatedCost = rawSellers.length * 0.005
    } else if (source === "google_phrase_intent") {
      const zenrows = new ZenrowsClient()
      const samplePhrases = [...phrases.sellerPhrases.slice(0, 2), ...phrases.buyerPhrases.slice(0, 1)]
      for (const phrase of samplePhrases) {
        const html = await zenrows.googleSearch(phrase, { num: 3 }).catch(() => null)
        if (!html) continue
        estimatedCost += 0.002
        // Return phrase as a signal record for inspection
        previewRecords.push({
          sourceRecordId:  `google-dryrun-${Buffer.from(phrase).toString('base64').slice(0, 20)}`,
          source:          "google_phrase_intent",
          behaviorType:    "search_signal",
          intentType:      phrase.includes('sell') ? 'seller' : 'buyer',
          intentSignals:   [phrase],
          city:            market.city,
          state:           market.state,
          motivationScore: 40,
          rawPayload:      { phrase, html_length: html.length },
        })
      }
    } else {
      return NextResponse.json({ error: `source '${source}' not supported for dry-run yet` }, { status: 400 })
    }
  } catch (err) {
    errorMessage = String(err)
  }

  return NextResponse.json({
    market: {
      id:               market.id,
      name:             market.name,
      city:             market.city,
      state:            market.state,
      is_active:        market.is_active,
      enabled_sources:  market.enabled_sources,
      budget_used_pct:  market.monthly_budget_usd
        ? Math.round(((market.spend_this_month ?? 0) / market.monthly_budget_usd) * 100)
        : null,
    },
    source,
    dry_run:          true,
    territory_phrases: phrases,
    preview_records:   previewRecords,
    would_insert:     previewRecords.length,
    estimated_cost_usd: estimatedCost,
    error:            errorMessage,
  })
}
