// lib/lead-pipeline/scraper-parsers.ts
// Pure parsing/normalization for the scraping layer. Extracted from the
// lead-scraping cron so the same logic powers both the live cron and the
// scraper simulator (scripts/scraper-simulator.ts) — these functions are the
// most regression-prone part of scraping and were previously untestable while
// embedded in a route file. No network, no DB: HTML/JSON in, canonical
// NormalizedScrapedRecord[] out, filtered by the shared viability gate.

import * as cheerio from "cheerio"
import { isViableRecord, type NormalizedScrapedRecord } from "./raw-record-types"

export interface MarketGeo {
  city: string | null
  state: string | null
}

export interface PropertySearchParams {
  min_price?: number | null
  max_price?: number | null
  min_beds?: number | null
  min_baths?: number | null
}

/** Build a property-search URL for the given portal from market + filter params. */
export function buildPropertySearchUrl(
  site: string,
  market: { city: string; state: string },
  params: PropertySearchParams,
): string {
  const location = encodeURIComponent(`${market.city}, ${market.state}`)

  switch (site) {
    case "zillow":
      // fsbo:true + fsba:false targets for-sale-by-owner only (seller intent),
      // excluding agent inventory. cmsn (coming-soon) is pre-listing seller intent.
      return `https://www.zillow.com/${market.city.toLowerCase().replace(/ /g, "-")}-${market.state.toLowerCase()}/fsbo/?searchQueryState=${encodeURIComponent(
        JSON.stringify({
          pagination: {},
          mapBounds: {},
          filterState: {
            price: { min: params.min_price, max: params.max_price },
            beds: { min: params.min_beds },
            baths: { min: params.min_baths },
            fsbo: { value: true },
            fsba: { value: false },
            cmsn: { value: true },
          },
        }),
      )}`

    case "realtor":
      // show-fsbo restricts to for-sale-by-owner listings (seller leads).
      return `https://www.realtor.com/realestateandhomes-search/${market.city.replace(/ /g, "_")}_${market.state}/price-${params.min_price || 0}-${params.max_price || 10000000}/beds-${params.min_beds || 1}/show-fsbo`

    case "redfin":
      // include=forSaleByOwner restricts to by-owner listings (seller leads).
      return `https://www.redfin.com/city/${market.city.replace(/ /g, "-")}/${market.state}/filter/min-price=${params.min_price || 0},max-price=${params.max_price || 10000000},min-beds=${params.min_beds || 1},include=forSaleByOwner`

    case "trulia":
      return `https://www.trulia.com/${market.state}/${market.city.replace(/ /g, "_")}/`

    default:
      return `https://www.zillow.com/${location}/`
  }
}

/**
 * Parse property search HTML from Zillow, Realtor, Redfin, or Trulia.
 * Returns only records that pass the viability gate.
 */
export function parsePropertySearchResults(
  html: string,
  site: string,
  market: MarketGeo,
): NormalizedScrapedRecord[] {
  const $ = cheerio.load(html)
  const records: NormalizedScrapedRecord[] = []

  if (site === "zillow") {
    // Zillow embeds listing data in a <script type="application/json"> containing
    // the key "listResults" (or "cat1.searchResults.listResults" in newer builds).
    $('script[type="application/json"]').each((_, el) => {
      try {
        const raw = $(el).html() ?? ""
        if (!raw.includes("listResults") && !raw.includes("zpid")) return
        const json = JSON.parse(raw)
        // Traverse common nested paths where listResults appears
        const listResults: unknown[] =
          json?.cat1?.searchResults?.listResults ??
          json?.listResults ??
          json?.searchPageState?.cat1?.searchResults?.listResults ??
          []
        for (const item of listResults) {
          const listing = item as Record<string, unknown>
          const address = (listing.address as string | undefined) ?? (listing.streetAddress as string | undefined)
          const zpid   = String(listing.zpid ?? listing.id ?? `zillow-${Date.now()}-${Math.random()}`)
          if (!address) continue
          const record: NormalizedScrapedRecord = {
            sourceRecordId: `zillow-${zpid}`,
            source: "zillow",
            behaviorType: "fsbo_listing",
            intentType: "seller",
            intentSignals: ["by_owner", "fsbo"],
            propertyAddress: address,
            city: (listing.city as string | null | undefined) ?? market.city,
            state: (listing.state as string | null | undefined) ?? market.state,
            zip: (listing.zipcode as string | null | undefined) ?? null,
            motivationScore: 40,
            sourceUrl: listing.detailUrl
              ? `https://www.zillow.com${listing.detailUrl}`
              : null,
            rawPayload: listing,
          }
          records.push(record)
        }
      } catch {
        // malformed JSON block — skip silently
      }
    })
  } else if (site === "realtor") {
    // Realtor.com property cards
    $('[data-testid="property-card"]').each((_, el) => {
      const addressEl  = $(el).find('[data-testid="card-address"]')
      const line1      = addressEl.first().text().trim()
      const line2      = addressEl.last().text().trim()
      const address    = line1 ? `${line1}${line2 ? `, ${line2}` : ""}` : null
      const href       = $(el).find('a').first().attr('href') ?? null
      const pid        = href?.split('/').filter(Boolean).pop() ?? `realtor-${Date.now()}-${Math.random()}`
      const priceText  = $(el).find('[data-testid="card-price"]').first().text().replace(/[^0-9]/g, '')
      if (!address) return
      const record: NormalizedScrapedRecord = {
        sourceRecordId: `realtor-${pid}`,
        source: "realtor",
        behaviorType: "fsbo_listing",
        intentType: "seller",
        intentSignals: ["by_owner", "fsbo"],
        propertyAddress: address,
        city: market.city,
        state: market.state,
        motivationScore: 40,
        sourceUrl: href ? `https://www.realtor.com${href}` : null,
        rawPayload: { address, href, price: priceText ? Number(priceText) : null },
      }
      records.push(record)
    })
  } else if (site === "redfin") {
    // Redfin uses data-rf-test-name attributes on listing cards
    $('[data-rf-test-name="mapHomeCard"], .HomeCard, .home-card').each((_, el) => {
      const address   = $(el).find('[data-rf-test-name="homecard-address"], .address').first().text().trim() || null
      const href      = $(el).find('a').first().attr('href') ?? null
      const pid       = href?.split('/').filter(Boolean).pop() ?? `redfin-${Date.now()}-${Math.random()}`
      if (!address) return
      const record: NormalizedScrapedRecord = {
        sourceRecordId: `redfin-${pid}`,
        source: "redfin",
        behaviorType: "fsbo_listing",
        intentType: "seller",
        intentSignals: ["by_owner", "fsbo"],
        propertyAddress: address,
        city: market.city,
        state: market.state,
        motivationScore: 40,
        sourceUrl: href ? `https://www.redfin.com${href}` : null,
        rawPayload: { address, href },
      }
      records.push(record)
    })
  } else {
    // Generic fallback: grab any element that looks like a property address
    $('[class*="address"], [class*="Address"]').each((_, el) => {
      const address = $(el).text().trim()
      if (address.length < 5 || address.length > 120) return
      const record: NormalizedScrapedRecord = {
        sourceRecordId: `${site}-${Date.now()}-${Math.random()}`,
        source: site,
        behaviorType: "fsbo_listing",
        intentType: "seller",
        intentSignals: ["by_owner", "fsbo"],
        propertyAddress: address,
        city: market.city,
        state: market.state,
        motivationScore: 35,
        sourceUrl: null,
        rawPayload: { address },
      }
      records.push(record)
    })
  }

  return records.filter(isViableRecord)
}

/**
 * Parse Craigslist real-estate listing HTML.
 * Returns only FSBO / property listing rows that pass the viability gate.
 */
export function parseCraigslistHtml(html: string): NormalizedScrapedRecord[] {
  const $ = cheerio.load(html)
  const records: NormalizedScrapedRecord[] = []

  $('.result-row, .cl-search-result').each((_, el) => {
    const titleEl  = $(el).find('.result-title, .titlestring').first()
    const title    = titleEl.text().trim()
    const listingId = ($(el).attr('data-pid') ?? `cl-${Date.now()}-${Math.random()}`).toString()
    const href     = titleEl.attr('href') ?? $(el).find('a.result-title').first().attr('href') ?? ''
    const priceText = $(el).find('.result-price').first().text().replace(/[^0-9]/g, '')
    const isFsbo   = /\b(by owner|fsbo|for sale by owner)\b/i.test(title)

    if (title.length < 5) return

    const record: NormalizedScrapedRecord = {
      sourceRecordId: listingId,
      source: "craigslist_fsbo",
      behaviorType: isFsbo ? "fsbo_listing" : "property_listing",
      intentType: "seller",
      intentSignals: isFsbo ? ["fsbo_listed"] : ["craigslist_listing"],
      propertyAddress: title.slice(0, 100),
      motivationScore: isFsbo ? 75 : 45,
      sourceUrl: href.startsWith("http") ? href : `https://craigslist.org${href}`,
      rawPayload: {
        title,
        listing_id: listingId,
        price: priceText ? Number(priceText) : null,
      },
    }
    records.push(record)
  })

  return records.filter(isViableRecord)
}

/**
 * Normalize a raw BatchData motivated-seller record into the canonical shape.
 * The motivationScore is clamped to [0, 100].
 */
export function normalizeBatchDataRecord(
  record: Record<string, unknown>,
  market: MarketGeo,
): NormalizedScrapedRecord {
  const firstName = (record.firstName ?? record.first_name ?? record.owner_name?.toString().split(' ')[0] ?? '') as string
  const lastName  = (record.lastName  ?? record.last_name  ??
    (record.owner_name?.toString().split(' ').slice(1).join(' ') ?? '')) as string

  const rawScore  = record.motivationConfidence ?? record.motivation_score ?? 0.5
  const score     = Math.min(100, Math.max(0, Math.round(Number(rawScore) * (Number(rawScore) <= 1 ? 100 : 1))))

  const idSlug = `${firstName}-${lastName}-${record.propertyAddress ?? record.property_address ?? ''}`
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')

  // Expired listings come from BatchData (the 'expired' motivation trigger → quickList
  // 'expired-listing'). A BatchData record labeled 'expired' (or carrying an expired/canceled/
  // failed listing quickList) is an EXPIRED-LISTING lead, not a generic motivated seller — tag it
  // so it flows under the expired_listing source with the right intent.
  const motivation = (record.motivationType ?? record.motivation_type ?? 'motivated_seller') as string
  const quickLists = (Array.isArray(record.quickLists) ? record.quickLists : []) as string[]
  const isExpired =
    motivation === 'expired' ||
    quickLists.some((q) => /(expired|canceled|cancelled|failed)-listing/i.test(String(q)))

  return {
    sourceRecordId: `batchdata-${idSlug || Date.now()}`,
    source: isExpired ? "expired_listing" : "batchdata_motivated",
    behaviorType: isExpired ? "expired_listing" : "motivated_seller",
    intentType: "seller",
    intentSignals: isExpired ? ["expired_listing"] : [motivation],
    firstName:       firstName || null,
    lastName:        lastName  || null,
    email:           (record.email  as string | null | undefined) ?? null,
    phone:           (record.phone  as string | null | undefined) ?? null,
    city:            (record.city   as string | null | undefined) ?? market.city,
    state:           (record.state  as string | null | undefined) ?? market.state,
    zip:             (record.zip    as string | null | undefined) ?? null,
    mailingAddress:  (record.address as string | null | undefined) ?? null,
    propertyAddress: (record.propertyAddress ?? record.property_address) as string | null | undefined ?? null,
    motivationScore: score,
    rawPayload: record,
  }
}

/**
 * Parse BUYER-intent signals from a real-estate site (Zillow/Realtor/Redfin) —
 * saved searches, favorited/saved listings, and "watching" activity that expose
 * an active buyer (a handle/name + the criteria/property they're tracking).
 * Complements parsePropertySearchResults (which captures FSBO sellers): the same
 * site yields both buyer and seller online behavior. Defensive across markup;
 * a record is emitted only when a buyer handle/name OR saved property is present.
 */
export function parseBuyerSavedSearches(
  html: string,
  site: string,
  market: MarketGeo,
): NormalizedScrapedRecord[] {
  const $ = cheerio.load(html)
  const records: NormalizedScrapedRecord[] = []

  $(
    '[class*="saved-search"], [class*="savedSearch"], [data-saved-search], ' +
    '[class*="favorited"], [class*="saved-home"], [class*="watching"], [data-buyer]',
  ).each((i, el) => {
    const block = $(el)
    const handle =
      block.attr("data-user") ||
      block.find('[class*="user"], [class*="member"], [class*="author"]').first().text().trim() ||
      ""
    const criteria =
      block.find('[class*="criteria"], [class*="search-terms"], [class*="query"]').first().text().trim() ||
      block.text().trim().slice(0, 120)
    const savedAddress =
      block.find('[class*="address"], [class*="home-address"]').first().text().trim() || null

    // Need a usable identity (handle) or a saved property to anchor the lead.
    if (!handle && !savedAddress) return

    const nameParts = handle.split(/\s+/).filter(Boolean)
    records.push({
      sourceRecordId: `${site}-buyer-${block.attr("data-id") ?? block.attr("id") ?? `${i}-${Date.now()}`}`,
      source: site,
      behaviorType: "saved_search",
      intentType: "buyer",
      intentSignals: ["saved_search", "active_buyer"],
      firstName: nameParts.length >= 2 ? nameParts[0] : null,
      lastName: nameParts.length >= 2 ? nameParts.slice(1).join(" ") : null,
      username: handle || undefined,
      propertyAddress: savedAddress,
      city: market.city,
      state: market.state,
      motivationScore: 55, // active saved-search buyers score above passive views
      sourceUrl: null,
      rawPayload: { criteria, handle, savedAddress },
    })
  })

  return records.filter(isViableRecord)
}

// NOTE: expired/withdrawn listings are now sourced from BatchData (the 'expired' motivation
// trigger → quickList 'expired-listing'), tagged by normalizeBatchDataRecord above. The old
// portal-HTML expired parser was consolidated away so expired has a single, structured source.
