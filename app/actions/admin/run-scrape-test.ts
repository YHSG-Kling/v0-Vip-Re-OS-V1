'use server'

/**
 * app/actions/admin/run-scrape-test.ts
 *
 * Server action wrapper for the scrape dry-run API.
 * CRON_SECRET is a server-only env var — never expose it client-side via
 * NEXT_PUBLIC_. This action keeps the secret on the server and returns
 * the same JSON shape as /api/admin/scrape-test.
 *
 * ─── /api/admin/scrape-test WAS NOT RETIRED (wave 14) ────────────────────────
 * A route census paired that route with this action and marked it for deletion.
 * Left in place, for two independent reasons:
 *   1. OWNER FENCE — "any lead scrapping needs to be left alone." The route is a
 *      DIAGNOSTIC (dry_run: true; it writes nothing to raw_scraped_leads and no
 *      file under lib/lead-pipeline/** changes either way), so collapsing it
 *      would not alter scraper behaviour — but it is inside the fenced surface
 *      and the fence is the owner's, not a lane's, to move.
 *   2. DIFFERENT DOORS, NOT DUPLICATE DOORS. The route authorizes on
 *      `Bearer CRON_SECRET`; this action authorizes on an admin/broker SESSION.
 *      A secret-bearer door is by definition addressable from outside this repo
 *      (a runbook curl, an ops check, the cron's own operator). Nothing here can
 *      prove no such caller exists. UNRESOLVED (CLAUDE.md §1).
 *
 * Both halves are currently unwired — this action has no caller either. The
 * doctrine's answer to that is BUILD the missing half (an admin surface that
 * calls this action), not delete one of the two doors.
 *
 * FOUND, NOT FIXED: the gate below admits any tenant admin/broker and then reads
 * `lead_scraping_markets` by id with NO brokerage predicate (line ~45), even
 * though the select pulls `brokerage_id`. A brokerage admin can preview another
 * tenant's market, its territory phrases and its budget burn. Fenced surface —
 * reported rather than changed.
 */

import { ZenrowsClient, BatchDataClient } from '@/lib/external'
import { buildTerritoryPhrases } from '@/lib/lead-pipeline/source-intent-map'
import {
  type NormalizedScrapedRecord,
  isViableRecord,
} from '@/lib/lead-pipeline/raw-record-types'
import { createClient } from '@/lib/supabase/server'
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

export async function runScrapeTestAction(marketId: string, source: string) {
  const supabase = await createClient()

  // ── Auth: must be a logged-in superadmin / brokerage admin ─────────────────
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { error: 'Unauthorized', status: 401 }
  }

  // Verify the user has admin access (superadmin or brokerage admin)
  const { data: userRow } = await supabase
    .from('users')
    .select('user_type')
    .eq('id', user.id)
    .maybeSingle()

  if (!userRow || !isAdminOrBroker({ user_type: userRow.user_type ?? '' })) {
    return { error: 'Forbidden', status: 403 }
  }

  // ── Load market ─────────────────────────────────────────────────────────────
  const { data: market, error: marketErr } = await supabase
    .from('lead_scraping_markets')
    .select('id, brokerage_id, name, city, state, zip_codes, counties, enabled_sources, monthly_budget_usd, spend_this_month, is_active')
    .eq('id', marketId)
    .single()

  if (marketErr || !market) {
    return { error: 'Market not found', status: 404 }
  }

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
    if (source === 'batchdata_motivated') {
      const batchdata = new BatchDataClient()
      const location  = `${market.city}, ${market.state}`
      const rawSellers = await batchdata.getMotivatedSellerData(location)

      for (const r of rawSellers.slice(0, 10)) {
        const raw       = r as unknown as Record<string, unknown>
        const firstName = (raw.firstName ?? raw.first_name ?? raw.owner_name?.toString().split(' ')[0] ?? '') as string
        const lastName  = (raw.lastName  ?? raw.last_name  ?? raw.owner_name?.toString().split(' ').slice(1).join(' ') ?? '') as string
        const rawScore  = raw.motivationConfidence ?? raw.motivation_score ?? 0.5
        const score     = Math.min(100, Math.max(0, Math.round(Number(rawScore) * (Number(rawScore) <= 1 ? 100 : 1))))
        const idSlug    = `${firstName}-${lastName}-${raw.propertyAddress ?? raw.property_address ?? ''}`
          .toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')

        const record: NormalizedScrapedRecord = {
          sourceRecordId:  `batchdata-${idSlug || Date.now()}`,
          source:          'batchdata_motivated',
          behaviorType:    'motivated_seller',
          intentType:      'seller',
          intentSignals:   [(raw.motivationType ?? raw.motivation_type ?? 'motivated_seller') as string],
          firstName:       firstName || null,
          lastName:        lastName  || null,
          email:           (raw.email  as string | null) ?? null,
          phone:           (raw.phone  as string | null) ?? null,
          city:            (raw.city   as string | null) ?? market.city,
          state:           (raw.state  as string | null) ?? market.state,
          propertyAddress: ((raw.propertyAddress ?? raw.property_address) as string | null) ?? null,
          motivationScore: score,
          rawPayload:      raw,
        }
        if (isViableRecord(record)) previewRecords.push(record)
      }
      estimatedCost = rawSellers.length * 0.005

    } else if (source === 'google_phrase_intent') {
      const zenrows = new ZenrowsClient()
      const samplePhrases = [...phrases.sellerPhrases.slice(0, 2), ...phrases.buyerPhrases.slice(0, 1)]

      for (const phrase of samplePhrases) {
        const html = await zenrows.googleSearch(phrase, { num: 3 }).catch(() => null)
        if (!html) continue
        estimatedCost += 0.002
        previewRecords.push({
          sourceRecordId:  `google-dryrun-${Buffer.from(phrase).toString('base64').slice(0, 20)}`,
          source:          'google_phrase_intent',
          behaviorType:    'search_signal',
          intentType:      phrase.includes('sell') ? 'seller' : 'buyer',
          intentSignals:   [phrase],
          city:            market.city,
          state:           market.state,
          motivationScore: 40,
          rawPayload:      { phrase, html_length: html.length },
        })
      }
    } else {
      return { error: `source '${source}' not supported for dry-run yet`, status: 400 }
    }
  } catch (err) {
    errorMessage = String(err)
  }

  return {
    market: {
      id:              market.id,
      name:            market.name,
      city:            market.city,
      state:           market.state,
      is_active:       market.is_active,
      enabled_sources: market.enabled_sources,
      budget_used_pct: market.monthly_budget_usd
        ? Math.round(((market.spend_this_month ?? 0) / market.monthly_budget_usd) * 100)
        : null,
    },
    source,
    dry_run:            true,
    territory_phrases:  phrases,
    preview_records:    previewRecords,
    would_insert:       previewRecords.length,
    estimated_cost_usd: estimatedCost,
    error:              errorMessage,
    status:             200,
  }
}
