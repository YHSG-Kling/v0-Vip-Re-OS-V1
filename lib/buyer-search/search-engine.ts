/**
 * SYSTEM 5.1B: BUYER SEARCH ENGINE — LIB LAYER
 *
 * Pure domain logic for natural-language property search.
 * No "use server" directive — this is a lib module callable from
 * both server actions and other lib modules (e.g. voice-assistant).
 *
 * Dependency direction: lib/buyer-search → lib/property-matching → lib/external
 * The action layer (app/actions/buyer-property-search.ts) re-exports from here.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { isValidUUID } from '@/lib/validations'
import { publiclyVisibleListingStatuses } from '@/lib/listings/listing-status-sync'
import { handleError } from '@/lib/errors'
import { parseNaturalLanguageQuery, mergeIntentWithContext, intentToFilters } from './intent-parser'
import { inferBuyerPersona } from './persona-inference'
import { generateMatchExplanation, explainCriteriaFit, composeNeighbourlyExplanation, fullExplanationText, type CriteriaFit, type ListingFitFacts } from './explanation-generator'
import { describeListingSource, licensedResultPhotoUrl, claimsFromFit, validateClaims, statedHardConstraints, answerStatedConstraints, type ConstraintAnswer, type ExplanationClaim, type ListingSourceLabel, type HomeLocationEvidence } from './explanation-evidence'
import { logBatchBuyerSearchMatches, appendBuyerSearchPreferences } from './search-logger'
import { scanExplanation, scanFairHousing } from './fair-housing'
import { scoreBuyerForListing, type BuyerProfile, type ListingProfile } from '@/lib/property-matching/match-scorer' // the module, not the barrel (proxy-graph budget)
import type { ParsedBuyerIntent } from './intent-parser'
import type { BuyerCriteria } from './buyer-criteria'
import { intentWithStoredCriteria, fitCriteriaFor } from './conversational-search'
// WAVE 153 (lane 153E): the one street+ZIP join key (dedup against the IDX / RentCast copy of a tenant listing) and the
// compliance-attested Coming Soon rule + the Coming Soon address door. All three are already on this module's page graphs.
import { normalizeAddressKey } from '@/lib/analytics/prediction-accuracy'
import { loadComingSoonPolicy, evaluateComingSoonReadiness } from '@/lib/compliance/coming-soon-policy'
import { resolveComingSoonCreativeAddress } from '@/lib/marketing/listing-public-address'
// Wave 150 (lane 150W): the buyer's stated must-haves held over the page (canary 7), and the ONE photo rule (R9).

/**
 * WHAT A BUYER CAN SHOP (wave 147C). A buyer search returns homes a buyer can act on: ACTIVE
 * listings. This is the buyer-shopping rule, NOT the public-visibility rule — lane 147F owns the
 * shared predicate `publiclyVisibleListingStatuses` (contract C12: archived is internal-only and
 * never reaches a public/portal search). WIRED (wave 147, lane 147Z — lane 147C Outside-lane 1):
 * every buyer read filters on buyerShoppableListingStatuses() below — this list INTERSECTED with
 * F's ONE public predicate — so a status F hides can never be shown here even if this list grows
 * (e.g. to coming_soon). Archived rides deleted_at, filtered beside it at every read.
 */
export const BUYER_SHOPPABLE_LISTING_STATUSES = ['active'] as const

/** The statuses a buyer read may return: the shoppable list ∩ lane 147F's public predicate (contract C12). PURE. */
export function buyerShoppableListingStatuses(): string[] {
  const pub = new Set<string>(publiclyVisibleListingStatuses())
  return BUYER_SHOPPABLE_LISTING_STATUSES.filter((s) => pub.has(s))
}

// ─── WAVE 153 (lane 153E) — THE TENANT'S OWN INVENTORY IN THE SHOPPING AGENT ──────────────────────────────────────────
// Owner (verbatim, 2026-11-14): "the tenant or user's listings that they created on the platform should be searchable for
// the shopping agent." VERIFIED: the tenant's own ACTIVE listings were already searched (step 4, bounded to the
// contact's tenant, deleted_at IS NULL, read LIVE on every search — a status change or an archive leaves the results on
// the very next search; there is no index to go stale). The three gaps closed here:
//   1. COMING SOON ONLY UNDER POLICY — a Coming Soon listing is shown only when the brokerage's compliance-attested MLS
//      rule permits Coming Soon for that listing's market (lib/compliance/coming-soon-policy.ts — no rule, an unattested
//      rule or an unreadable one → not shown, the closed default), labelled Coming Soon (never "active"), with the street
//      address only when the seller authorized it AND the rule permits it (lib/marketing/listing-public-address.ts
//      resolveComingSoonCreativeAddress), else "City, ST". Drafts, signed-not-live, withdrawn, cancelled, off-market,
//      expired, sold and archived listings are never shown as shoppable (the C12 partition, unchanged).
//   2. ONE HOME, ONE RESULT — the same house in the tenant's own inventory and in the IDX feed / RentCast used to appear
//      twice. The tenant's listing is kept (its live status, its own photos, its in-house save / tour path); the outside
//      copy is folded in as PROVENANCE ("also on <MLS> #<n>"), and its photo is borrowed only from the tenant's own IDX
//      feed when the listing has none of its own (owner R9: RentCast is never a photo source).
//   3. ORIGIN + FRESHNESS on every result — where the status comes from (the live board, the tenant's MLS feed, a
//      property-data provider) and when it was read.
//   4. NO STALE ACTIVE — when the tenant's own board says a home is under contract or recently sold, an outside copy
//      still reporting it for sale is suppressed (feeds lag; the listing brokerage's own board does not).

/** The Coming Soon status the Shopping Agent may show UNDER POLICY — inside lane 147F's public predicate (C12). PURE. */
function buyerComingSoonStatuses(): string[] {
  return (publiclyVisibleListingStatuses() as string[]).filter((s) => s === 'coming_soon')
}

/** PURE — the unit designator a street line carries ("#4", "Apt 2B", "Unit 12"), lower-cased, or "" — kept apart from
 *  the canonical address key (which drops it) so two condos in one building never fold into one result. */
function addressUnit(street: string | null | undefined): string {
  const m = /(?:#|\bapt\.?|\bapartment|\bunit|\bsuite|\bste\.?)\s*([\w-]+)/i.exec(String(street ?? ''))
  return m ? m[1].toLowerCase() : ''
}

/** PURE — the identity a home is matched on: the canonical street+ZIP key (lib/analytics/prediction-accuracy.ts
 *  normalizeAddressKey, the one join key) plus its unit; and its MLS number, alphanumerics upper-cased. */
function homeIdentity(street: string | null | undefined, zip: string | null | undefined, mlsNumber: string | null | undefined): { address: string | null; mls: string | null; zip5: string | null } {
  const key = normalizeAddressKey(street, zip)
  const mls = String(mlsNumber ?? '').replace(/[^0-9a-z]/gi, '').toUpperCase()
  const zip5 = /^\d{5}/.test(String(zip ?? '').trim()) ? String(zip).trim().slice(0, 5) : null
  return { address: key ? `${key}#${addressUnit(street)}` : null, mls: mls.length >= 4 ? mls : null, zip5 }
}

/**
 * PURE — fold outside copies (IDX / RentCast rows, `__external`) of a home the tenant itself lists into that listing.
 * A match is the same street+ZIP+unit, or the same MLS number in the same ZIP. The platform row survives with
 * `__also_listed` provenance; an IDX photo is borrowed only when the listing has no photo of its own. Returns the merged
 * list and how many outside copies were folded (reported, never silent).
 */
function foldOutsideCopiesIntoOwnListings(platform: any[], external: any[], ownOffMarket: any[] = []): { listings: any[]; folded: number; staleSuppressed: number } {
  const own = platform.map((l) => ({ row: l, id: homeIdentity(l.address, l.zip, l.mls_number) }))
  const offMarket = ownOffMarket.map((l) => homeIdentity(l.address, l.zip, l.mls_number))
  const same = (a: ReturnType<typeof homeIdentity>, b: ReturnType<typeof homeIdentity>) =>
    (!!a.address && a.address === b.address) || (!!a.mls && a.mls === b.mls && (!a.zip5 || !b.zip5 || a.zip5 === b.zip5))
  const kept: any[] = []
  let folded = 0
  let staleSuppressed = 0
  for (const e of external) {
    const eid = homeIdentity(e.__address, e.zip, e.__mls_number)
    const twin = own.find(({ id }) => same(id, eid))
    // The tenant's OWN board says this very home is under contract or just sold — an outside copy still reporting it
    // for sale is stale, and is never shown as available (counted, never silent).
    if (!twin && offMarket.some((id) => same(id, eid))) { staleSuppressed++; continue }
    if (!twin) { kept.push(e); continue }
    folded++
    const t = twin.row
    t.__also_listed = [...(t.__also_listed ?? []), { source: e.__source, mls_name: e.__mls_name ?? null, mls_number: e.__mls_number ?? null }]
    if (!t.primary_photo_url && e.__source === 'idx' && e.__photo_url) { t.primary_photo_url = e.__photo_url; t.__photo_source = 'idx_mls' }
  }
  return { listings: [...platform, ...kept], folded, staleSuppressed }
}

/** How long after a tenant listing SOLD its own board still outranks an outside copy calling the home for sale. Past
 *  it, a re-listing by anyone is plausible and the outside row is shown on its own label. PURE constant. */
const SOLD_OUTRANKS_OUTSIDE_COPY_DAYS = 120

// The store→search glue (intentWithStoredCriteria, fitCriteriaFor) lives with the rest of the C10
// conversation in ./conversational-search.ts and is imported above.

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface BuyerSearchResult {
  listing_id: string
  /** street address for the portal card (platform listings); external feeds supply their own. */
  address: string | null
  /** display photo for the portal card. */
  primary_photo_url: string | null
  headline: string
  bullets: string[]
  narrative: string
  callToAction: string
  price: number | null
  bedrooms: number | null
  bathrooms: number | null
  city: string | null
  state: string | null
  property_type: string | null
  features: string[] | null
  internal_match_score: number
  internal_confidence: 'low' | 'medium' | 'high'
  /** Where this listing came from. 'platform' = our DB; 'rentcast'/'idx' = external feed (display-only) */
  source?: 'platform' | 'rentcast' | 'idx'
  /** External feed identifier when source !== 'platform' (no UUID; do not use as FK) */
  external_id?: string
  /** Display photo URL for external listings — IDX feed rows ONLY (owner R9: RentCast is never a photo source). */
  photo_url?: string
  /** Wave 150 (150W): the originating MLS's name and number a RentCast /listings/sale row reports (shown as the source). */
  mls_name?: string | null
  mls_number?: string | null
  /**
   * Wave 147C (C10): how this home lines up with the buyer's criteria — matches, misses and
   * UNKNOWNS (asks the listing data cannot answer, said as unknown, never guessed).
   */
  fit?: CriteriaFit
  /** Wave 147C: the neighbourly explanation built ONLY from `fit` (+ the code-authored unknowns line). */
  explanation_voice?: string
  /**
   * Wave 148E (owner ruling 8): WHAT THIS RESULT IS — one of the brokerage's own listings, an MLS listing through the
   * tenant's IDX feed, or RentCast property data (NOT a verified active listing).
   */
  source_label?: ListingSourceLabel
  /** Wave 148E (contract C18): every buyer-facing claim with its evidence source and confidence; unknowns stay unknown. */
  claims?: ExplanationClaim[]
  /** Wave 148E: the one gentle question and the offer to meet the agent (the agent's first impression). */
  follow_up_question?: string
  agent_offer?: string
  /** Wave 153 (153E): the status AS ITS SOURCE REPORTS IT — the tenant's live board for its own listings (active, or
   *  coming_soon under policy), the feed / provider for an outside row. */
  listing_status?: string | null
  /** Wave 153 (153E): where the status comes from and when it was read (the tenant's board is read live per search). */
  freshness?: { basis: 'live_board' | 'mls_feed' | 'provider'; source_updated_at: string | null; checked_at: string }
  /** Wave 153 (153E): outside copies of this same home folded into the tenant's own listing (provenance kept). */
  also_listed_on?: Array<{ source: string; mls_name: string | null; mls_number: string | null }>
  /** Wave 153 (153E): whose photo `primary_photo_url` / `photo_url` is — the listing's own media, or the tenant's IDX feed. */
  photo_source?: 'tenant_listing_media' | 'idx_mls' | null
}

/**
 * The brand an explanation speaks for (wave 148E): the brokerage's name and the buyer's agent's FIRST name, read under
 * the caller's verified tenant (agents.id → agents.user_id → users — agents.id and users.id are disjoint, CLAUDE.md §3).
 * Every refusal is read and logged; an unreadable name degrades to "your agent", never to an invented one.
 */
export async function loadExplanationVoice(
  supabase: ReturnType<typeof createServiceClient>,
  brokerageId: string | null,
  agentId: string | null,
): Promise<{ brokerageName: string | null; agentName: string | null }> {
  if (!brokerageId) return { brokerageName: null, agentName: null }
  const { data: b, error: bErr } = await supabase.from('brokerages').select('name, dba').eq('id', brokerageId).maybeSingle()
  if (bErr) console.error('[buyer-search] brokerage name read refused:', bErr.message)
  const brokerageName = ((b as { dba?: string | null; name?: string | null } | null)?.dba || (b as { name?: string | null } | null)?.name || null)
  let agentName: string | null = null
  if (agentId) {
    const { data: a, error: aErr } = await supabase.from('agents').select('user_id').eq('id', agentId).eq('brokerage_id', brokerageId).maybeSingle()
    if (aErr) console.error('[buyer-search] agent read refused:', aErr.message)
    const userId = (a as { user_id?: string | null } | null)?.user_id ?? null
    if (userId) {
      const { data: u, error: uErr } = await supabase.from('users').select('first_name').eq('id', userId).maybeSingle()
      if (uErr) console.error('[buyer-search] agent name read refused:', uErr.message)
      agentName = ((u as { first_name?: string | null } | null)?.first_name ?? '').trim() || null
    }
  }
  return { brokerageName, agentName }
}

export interface BuyerSearchParams {
  contactId: string
  naturalLanguageQuery: string
  options?: {
    limit?: number
    minScore?: number
    logSignals?: boolean
    includeDebugInfo?: boolean
    /**
     * Wave 147C: the buyer's STORED criteria (buyer-criteria.ts loadBuyerCriteria — the one store,
     * read by the caller under its verified tenant). Fills what the query did not say and is what
     * each result's fit is explained against.
     */
    criteria?: BuyerCriteria | null
  }
}

// ─── CORE SEARCH (lib-level, no "use server") ─────────────────────────────────

/**
 * Natural language → scored property matches.
 * Used by:
 *   - app/actions/buyer-property-search.ts  (action wrapper, adds "use server")
 *   - lib/buyer-execution/voice-assistant-integration.ts  (voice path, lib→lib)
 */
export async function searchPropertiesCore(params: BuyerSearchParams) {
  const { contactId, naturalLanguageQuery, options = {} } = params
  const { limit = 20, minScore = 40, logSignals = true, includeDebugInfo = false, criteria: storedCriteria = null } = options

  if (!isValidUUID(contactId)) return { success: false, error: 'Invalid contact ID' }
  if (!naturalLanguageQuery || naturalLanguageQuery.trim().length < 5) {
    return { success: false, error: 'Search query too short' }
  }

  try {
    const supabase = createServiceClient()

    // 1. Parse NL intent
    const parsedIntent = parseNaturalLanguageQuery(naturalLanguageQuery)

    // 2. Fetch contact + conversation context
    const { data: contact } = await supabase
      .from('contacts')
      .select('id, brokerage_id, agent_id, first_name, last_name, notes, created_at')
      .eq('id', contactId)
      .single()

    if (!contact) return { success: false, error: 'Contact not found' }

    // 2b. THE ONE NL criteria parser (lane 91C) fills what the word lists
    // missed — a city off the metro list ("in Frisco"), a ZIP — with the Haiku
    // lane only for a gap, booked to the CONTACT's tenant (read above under
    // the id; never a caller-supplied brokerage). Rules-first values already
    // on parsedIntent stand; the parser only fills empty fields.
    const { parseBuyerCriteria } = await import('./parse-buyer-criteria')
    const one = await parseBuyerCriteria(naturalLanguageQuery, { brokerageId: contact.brokerage_id ?? null })
    if (!parsedIntent.cities?.length && one.criteria.cities?.length) parsedIntent.cities = one.criteria.cities
    if (!parsedIntent.zipCodes?.length && one.criteria.zipCodes?.length) parsedIntent.zipCodes = one.criteria.zipCodes
    if (!parsedIntent.states?.length && one.criteria.state) parsedIntent.states = [one.criteria.state]
    if (parsedIntent.maxPrice == null && parsedIntent.minPrice == null) {
      if (one.criteria.minPrice != null) parsedIntent.minPrice = one.criteria.minPrice
      if (one.criteria.maxPrice != null) parsedIntent.maxPrice = one.criteria.maxPrice
    }
    if (parsedIntent.minBeds == null && one.criteria.minBeds != null) parsedIntent.minBeds = one.criteria.minBeds
    if (parsedIntent.minBaths == null && one.criteria.minBaths != null) parsedIntent.minBaths = one.criteria.minBaths

    const { data: insight } = await supabase
      .from('conversation_insights')
      .select('inferred_intent:context_summary, urgency_level:escalation_urgency, overall_sentiment, health_score, updated_at')
      .eq('contact_id', contactId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    // ONE VOCABULARY FOR "WHAT THEY ASKED FOR LAST TIME" (wave 147C, CLAUDE.md §6). This read used
    // to hand mergeIntentWithContext `ai_inference.search.recent_intent`, which search-logger.ts
    // WRITES as { price_range: { max }, min_beds, cities } — while the merge READS { maxPrice,
    // preferredCities, minBeds }. No key matched, so a buyer's previous search never filled a gap
    // in the next one. The stored criteria (the one store) now come first; the notes fallback is
    // mapped onto the reader's keys instead of being passed through under the writer's.
    let existingPreferences: any = null
    if (contact.notes) {
      try {
        const n = JSON.parse(contact.notes)
        const recent = n.ai_inference?.search?.recent_intent
        existingPreferences = n.ai_inference?.buyer_preferences
          || (recent ? { maxPrice: recent.price_range?.max, preferredCities: recent.cities, minBeds: recent.min_beds } : null)
      } catch { /* non-JSON notes */ }
    }
    Object.assign(parsedIntent, intentWithStoredCriteria(parsedIntent, storedCriteria))

    const enrichedIntent = mergeIntentWithContext(parsedIntent, {
      inferred_intent: insight?.inferred_intent,
      urgency_level: insight?.urgency_level,
      existing_preferences: existingPreferences,
    })

    // 3. Persona
    const persona = inferBuyerPersona(enrichedIntent, {
      sentiment: insight?.overall_sentiment,
      inferred_intent: insight?.inferred_intent,
      health_score: insight?.health_score,
    })

    // 4. Query listings
    //
    // IN-HOUSE MEANS THIS BROKERAGE'S OWN (wave 148E, owner ruling 8: "buyer search is either on in-house listings or
    // outside properties using RentCast or the tenant's IDX/MLS provider"). This read used to take every active
    // listing on the PLATFORM — another brokerage's inventory shown inside this tenant's portal as "our listing",
    // which is neither in-house nor the tenant's own IDX display agreement (MLS IDX rules are how brokers show each
    // other's listings). It is now bounded to the CONTACT's tenant (read above under the contact id — never a caller
    // value); a contact with no tenant gets no in-house rows (fail closed), and the outside sources below still run.
    const filters = intentToFilters(enrichedIntent)
    // WAVE 153 (153E): + mls_number (the dedup identity) and updated_at (the freshness each result reports). The buyer's
    // price / beds / baths / place / type filters are ONE function applied to both of the tenant's own reads (active,
    // and Coming Soon under policy) — each read keeps its own tenant bound, status list and archive exclusion in plain sight.
    const LISTING_COLUMNS = 'id, address, primary_photo_url, price:list_price, bedrooms, bathrooms, square_feet:sqft, property_type, city, state, zip, status, created_at, updated_at, mls_number, has_pool, has_septic, hoa_dues, lot_size, lot_size_unit, year_built, public_remarks'
    const withBuyerFilters = (query: any) => {
      let f = query
      if (filters.priceRange?.max) f = f.lte('list_price', filters.priceRange.max)
      if (filters.priceRange?.min) f = f.gte('list_price', filters.priceRange.min)
      if (filters.bedrooms?.min)   f = f.gte('bedrooms', filters.bedrooms.min)
      if (filters.bedrooms?.max)   f = f.lte('bedrooms', filters.bedrooms.max)
      if (filters.bathrooms?.min)  f = f.gte('bathrooms', filters.bathrooms.min)
      if (filters.cities?.length)  f = f.in('city', filters.cities)
      if (filters.states?.length)  f = f.in('state', filters.states)
      if (filters.propertyTypes?.length) f = f.in('property_type', filters.propertyTypes)
      return f
    }
    const q = withBuyerFilters(supabase
      .from('listings')
      // has_pool / has_septic / hoa_dues / lot_size / year_built / public_remarks (wave 147C) are what
      // the explainable fit answers lifestyle asks and deal-breakers from — columns the live table has.
      .select(LISTING_COLUMNS)
      .eq('brokerage_id', contact.brokerage_id ?? '')
      .in('status', buyerShoppableListingStatuses())
      .is('deleted_at', null))  // deleted_at IS NULL = NOT soft-deleted (was inverted: returned only deleted rows)

    const { data: platformListings, error: listingsError } = contact.brokerage_id
      ? await q.order('created_at', { ascending: false }).limit(200)
      : { data: [] as any[], error: null }

    if (listingsError) return { success: false, error: 'Failed to fetch listings' }

    // WAVE 153 (153E) — COMING SOON ONLY UNDER POLICY. Every refusal here leaves Coming Soon OUT (fail closed) and the
    // active search above still answers; the reason is logged, never shown to the buyer as a system message.
    const comingSoonListings: any[] = []
    if (contact.brokerage_id && buyerComingSoonStatuses().length > 0) {
      const { data: csRows, error: csErr } = await withBuyerFilters(supabase
        .from('listings')
        .select(LISTING_COLUMNS)
        .eq('brokerage_id', contact.brokerage_id)
        .in('status', buyerComingSoonStatuses())
        .is('deleted_at', null))
        .order('created_at', { ascending: false }).limit(25)
      if (csErr) console.error('[buyer-search] coming-soon read refused — none shown:', csErr.message)
      else if ((csRows ?? []).length > 0) {
        const policy = await loadComingSoonPolicy(supabase, contact.brokerage_id).catch((e: unknown) => ({ ok: false as const, error: String(e) }))
        if (!policy.ok) console.error('[buyer-search] coming-soon policy unreadable — none shown:', policy.error)
        else {
          for (const row of csRows as any[]) {
            if (!evaluateComingSoonReadiness(policy.policy, { stateCode: row.state ?? null }).ready) continue
            const addr = await resolveComingSoonCreativeAddress({ policyClient: supabase, termsClient: supabase, listing: { id: row.id, brokerage_id: contact.brokerage_id, address: row.address ?? null, city: row.city ?? null, state: row.state ?? null, zip: row.zip ?? null } })
              .catch(() => null)
            if (!addr) continue
            comingSoonListings.push({ ...row, address: addr.decision.disclose ? row.address : null, __coming_soon: true, __public_location: addr.publicLocation })
          }
        }
      }
    }

    // 4b. Augment with external listings (Rentcast / IDX) when configured.
    // External listings are display-only and tagged so the UI can route the
    // explain-match modal differently. They scored alongside platform listings.
    const externalListings: any[] = []
    let externalSource: 'rentcast' | 'idx' | 'none' = 'none'
    try {
      // THE AREA RULE (lane 91C). RentCast searches one city+state or one ZIP;
      // a city with no state used to go out bare, and a query with no place at
      // all went out as an area-less sweep — a paid request whose rows had
      // nothing to do with where the buyer is looking. The state now falls
      // back to the tenant's own (the same rule alert-engine.ts
      // resolveAlertSearchState applies), and with NO area the paid call is
      // not made: our own board above still answers.
      const zip = enrichedIntent.zipCodes?.[0]
      let state = filters.states?.[0]
      if (!state && filters.cities?.length && !zip && contact.brokerage_id) {
        const { data: tenant, error: tenantError } = await supabase.from('brokerages').select('state').eq('id', contact.brokerage_id).maybeSingle()
        if (tenantError) console.error('[buyer-search] brokerage state read refused:', tenantError.message)
        state = (tenant as { state?: string | null } | null)?.state ?? undefined
      }
      const hasArea = !!zip || (!!filters.cities?.length && !!state)
      const { searchExternalListings } = await import('@/lib/property/external-listings-search')
      const { BUYER_LISTING_RECENCY_DAYS } = await import('@/lib/property-alerts/alert-cadence')
      const ext = !hasArea
        ? { source: 'none' as const, listings: [] as Awaited<ReturnType<typeof searchExternalListings>>['listings'] }
        : await searchExternalListings({
        brokerageId: contact.brokerage_id ?? '',
        city: zip ? undefined : filters.cities?.[0],
        state: zip ? undefined : state,
        zipCode: zip,
        bedroomsMin: filters.bedrooms?.min,
        bedroomsMax: filters.bedrooms?.max,
        bathroomsMin: filters.bathrooms?.min,
        priceMin: filters.priceRange?.min,
        priceMax: filters.priceRange?.max,
        propertyType: filters.propertyTypes?.[0],
        limit: 50,
        // Recency (owner, wave 91: "we should only pull more recent data").
        listedWithinDays: BUYER_LISTING_RECENCY_DAYS,
        contactId,
        // A RENTER'S budget is monthly (wave 147C): without this the router searched the for-sale
        // market with a $2,500 ceiling and a renter's conversational search could never match.
        listingType: enrichedIntent.listingType === 'rent' ? 'rental' : 'sale',
      })
      if (ext.source !== 'none' && ext.listings.length > 0) {
        externalSource = ext.source
        for (const e of ext.listings) {
          externalListings.push({
            // synthetic id — never used as a UUID FK
            id: `ext_${e.source}_${e.externalId}`,
            price: e.price,
            bedrooms: e.bedrooms,
            bathrooms: e.bathrooms,
            square_feet: e.squareFeet,
            property_type: e.propertyType,
            city: e.city,
            state: e.state,
            zip: e.zip,
            features: [],
            status: 'active',
            created_at: new Date().toISOString(),
            // Wave 148E: the facts a RentCast row carries (an IDX row carries none of them — null, never guessed).
            // lot_size_sqft is SQUARE FEET as RentCast reports it; facts_source labels whose facts these are (C18).
            lot_size_sqft: e.lotSizeSqft ?? null,
            hoa_dues: e.hoaMonthly ?? null,
            facts_source: e.source === 'rentcast' ? 'provider:rentcast' : 'listing',
            __lat: e.latitude ?? null,
            __lon: e.longitude ?? null,
            __external: true,
            __source: e.source,
            __external_id: e.externalId,
            // Owner R9 (2026-11-06): photos only from the tenant's IDX/MLS feed or the tenant's own uploads — a RentCast
            // row never shows one, whatever URL the vendor row may carry.
            __photo_url: licensedResultPhotoUrl(e.source, e.photoUrl),
            __address: e.address,
            // Wave 150 (150W): the MLS a RentCast /listings/sale row names, shown as the listing's source; the status
            // AS THE SOURCE REPORTS IT (an IDX featured set is the feed's active inventory). Null stays null.
            __mls_name: (e as { mlsName?: string | null }).mlsName ?? null,
            __mls_number: (e as { mlsNumber?: string | null }).mlsNumber ?? null,
            __status_reported: e.source === 'idx' ? 'active' : (e.sourceStatus ?? null),
            // Wave 151 (151G): the row's DATA TYPE, verified-status and source label (idx_feed / feed_active / the feed's
            // name; listing_records / provider_reported / RentCast's label) — the portal card prints them beside the MLS name.
            __data_type: e.dataType,
            __verified_status: e.verifiedStatus,
            __source_label: e.sourceLabel,
          })
        }
      }
    } catch {
      // External augmentation is best-effort; never fail the search
    }

    // WAVE 153 (153E): NO STALE ACTIVE — the tenant's own listings that went UNDER CONTRACT (pending) or SOLD recently,
    // read only when outside rows exist, so an outside copy still calling that home "for sale" is suppressed. Withdrawn /
    // expired / cancelled are NOT used: such a home may be re-listed elsewhere, and that listing is real. A refused read
    // suppresses nothing (the outside rows keep their own source labels — they are never presented as the tenant's).
    let ownOffMarket: any[] = []
    if (contact.brokerage_id && externalListings.length > 0) {
      const { data: offRows, error: offErr } = await supabase
        .from('listings')
        .select('id, address, zip, mls_number, status, sold_date, updated_at')
        .eq('brokerage_id', contact.brokerage_id)
        .in('status', ['pending', 'sold'])
        .limit(500)
      if (offErr) console.error('[buyer-search] own off-market read refused — no outside copy suppressed:', offErr.message)
      const soldSince = Date.now() - SOLD_OUTRANKS_OUTSIDE_COPY_DAYS * 86_400_000
      ownOffMarket = ((offRows ?? []) as any[]).filter((l) => l.status === 'pending' || new Date(l.sold_date ?? l.updated_at ?? 0).getTime() >= soldSince)
    }
    // WAVE 153 (153E): ONE HOME, ONE RESULT — the tenant's own listing absorbs its IDX / RentCast copy as provenance.
    const merged = foldOutsideCopiesIntoOwnListings([...(platformListings ?? []), ...comingSoonListings], externalListings, ownOffMarket)
    const listings = merged.listings
    const checkedAt = new Date().toISOString()

    if (listings.length === 0) {
      return {
        success: true,
        results: [],
        message: 'No properties found matching your criteria',
        intent_summary: {
          parsed_successfully: true,
          confidence: enrichedIntent.confidence,
          ambiguities: enrichedIntent.ambiguities,
        },
      }
    }

    // 5. Score
    const buyerProfile: BuyerProfile = {
      contact_id: contactId,
      first_name: contact.first_name || 'Buyer',
      last_name: contact.last_name || '',
      notes: contact.notes,
      created_at: contact.created_at,
      inferred_intent: insight?.inferred_intent,
      urgency_level: insight?.urgency_level,
      sentiment: insight?.overall_sentiment,
      health_score: insight?.health_score,
      updated_at: insight?.updated_at,
    }

    const viableListings = listings
      .map(listing => {
        const ms = scoreBuyerForListing(buyerProfile, listing as ListingProfile)
        return { listing: listing as ListingProfile, matchScore: ms.score, confidence: ms.match_confidence }
      })
      .filter(s => s.matchScore >= minScore)
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, limit)

    // 6. Generate buyer-friendly explanations
    //
    // FAIR-HOUSING SCOPE (owner ruling, wave 15). Nothing above this line is
    // compliance-scanned: the buyer's own query, the filters built from it, the
    // provider call and the scoring all run untouched — a buyer may search
    // however they like. The ONE thing sanitized is the marketing prose WE
    // author about a match, which is copy we publish and therefore ours to be
    // liable for. scripts/compliance-scope-simulator.ts pins that boundary in
    // both directions.
    //
    // And the rewrite is a REPORTED FACT, not a silent edit. sanitizeExplanation
    // returned a `flagged[]` and this function used to drop it, which made "the
    // sanitizer fired on 12 of 20 explanations" and "the sanitizer is unwired"
    // produce byte-identical output — the exact measurement defect
    // lib/lead-governance/protected-class-signals.ts calls out for a narrowed
    // query. Labels are aggregated, logged, and returned in
    // metadata.fair_housing_sanitized.
    const fairHousingLabels = new Set<string>()
    let fairHousingRewrites = 0
    // The criteria every result is EXPLAINED against (wave 147C): the stored criteria with their
    // provenance, plus this query's own words as said. Built once per search.
    const fitCriteria = fitCriteriaFor(enrichedIntent, storedCriteria)

    // WAVE 148E — THE NEIGHBOURLY ANSWER'S EVIDENCE AND VOICE. The brand the explanation speaks for (the brokerage, the
    // buyer's agent by first name), and — when the buyer named a place they commute to — ONE cache-first, gated Matrix
    // request for the homes that already carry coordinates (location-evidence.ts; never a geocode per home here).
    // Best-effort: a failure leaves the commute UNKNOWN with an invitation to "why this home?", never a guess.
    const brand = await loadExplanationVoice(supabase, contact.brokerage_id ?? null, (contact as { agent_id?: string | null }).agent_id ?? null)
      .catch(() => ({ brokerageName: null, agentName: null }))
    let pageEvidence = new Map<string, HomeLocationEvidence>()
    if (contact.brokerage_id && (fitCriteria.lifestyle ?? []).some((a) => a.kind === 'commute' && !!a.target)) {
      try {
        const { gatherPageTravelEvidence } = await import('./location-evidence')
        pageEvidence = await gatherPageTravelEvidence({
          brokerageId: contact.brokerage_id,
          homes: viableListings.map(({ listing }) => {
            const l = listing as any
            return { key: String(l.id), address: l.__external ? (l.__address ?? null) : (l.address ?? null), city: l.city ?? null, state: l.state ?? null, zip: l.zip ?? null, lat: l.__lat ?? null, lon: l.__lon ?? null, coordsSource: l.__source === 'rentcast' ? 'provider:rentcast' : 'listing' }
          }),
          asks: fitCriteria.lifestyle ?? [],
          systemSource: enrichedIntent.listingType === 'rent' ? 'renter_search' : 'buyer_search',
        })
      } catch (e) {
        console.error('[buyer-search] travel evidence unavailable (commute stays unknown):', e instanceof Error ? e.message : e)
      }
    }
    let claimProblems = 0

    const pageResults: BuyerSearchResult[] = viableListings.map(({ listing, matchScore, confidence }) => {
      const scanned = scanExplanation(generateMatchExplanation(listing, enrichedIntent, persona, matchScore))
      if (scanned.flagged.length > 0) {
        fairHousingRewrites++
        for (const label of scanned.flagged) fairHousingLabels.add(label)
      }
      const exp = scanned.clean
      const isExternal = (listing as any).__external === true
      // EXPLAINABLE MATCH (C10): deterministic, from the listing's own data only; the neighbourly
      // voice is composed from the fit and steering-checked like every other line WE author.
      const fit: CriteriaFit = explainCriteriaFit(listing as unknown as ListingFitFacts, fitCriteria, pageEvidence.get(String(listing.id)) ?? null)
      const comingSoon = !isExternal && (listing as any).__coming_soon === true
      const label = (isExternal ? (listing as any).__address : ((listing as any).address ?? (listing as any).__public_location)) || listing.city || 'This home'
      // C18 + owner ruling 8: the source labelled for what it is; every claim carries its evidence.
      let sourceLabel = describeListingSource(isExternal ? (listing as any).__source : 'platform', { brokerageName: brand.brokerageName, mlsName: isExternal ? ((listing as any).__mls_name ?? null) : null })
      // WAVE 153 (153E): a Coming Soon listing is said to be Coming Soon — never a verified ACTIVE listing — and a home
      // whose IDX / RentCast copy was folded in names where else it is listed (provenance the buyer can check).
      if (comingSoon) sourceLabel = { ...sourceLabel, label: `${sourceLabel.label} · Coming Soon, not on the MLS yet`, verified_active_listing: false, caveat: "Coming Soon: this home isn't on the market yet. Your agent can tell you when it can be shown and how to hear about it first." }
      const alsoListed = (!isExternal ? ((listing as any).__also_listed ?? []) : []) as Array<{ source: string; mls_name: string | null; mls_number: string | null }>
      if (alsoListed.length > 0) {
        const where = alsoListed.map((a) => a.mls_name ? `${a.mls_name}${a.mls_number ? ` #${a.mls_number}` : ''}` : a.source === 'idx' ? "your agent's MLS feed" : 'RentCast property data').join(', ')
        sourceLabel = { ...sourceLabel, label: `${sourceLabel.label} · also listed on ${where}` }
      }
      const claims = claimsFromFit(fit, sourceLabel)
      const verdict = validateClaims(claims)
      if (!verdict.ok) { claimProblems += verdict.problems.length; console.error('[buyer-search] C18 claim contract broken:', verdict.problems.slice(0, 3)) }
      const voice = composeNeighbourlyExplanation(fit, label, { agentName: brand.agentName, brokerageName: brand.brokerageName, source: sourceLabel })
      const voiceScan = scanFairHousing(fullExplanationText(voice))
      if (voiceScan.flagged.length > 0) {
        fairHousingRewrites++
        for (const l of voiceScan.flagged) fairHousingLabels.add(l)
      }
      return {
        listing_id: listing.id,
        address: isExternal ? ((listing as any).__address ?? null) : ((listing as any).address ?? null),
        primary_photo_url: isExternal ? ((listing as any).__photo_url ?? null) : ((listing as any).primary_photo_url ?? null),
        headline: exp.headline,
        bullets: exp.bullets,
        narrative: exp.narrative,
        callToAction: exp.callToAction,
        price: listing.price,
        bedrooms: listing.bedrooms,
        bathrooms: listing.bathrooms,
        city: listing.city,
        state: listing.state,
        property_type: listing.property_type,
        features: null,  // listings has no features column
        internal_match_score: matchScore,
        internal_confidence: confidence,
        source: isExternal ? ((listing as any).__source as 'rentcast' | 'idx') : 'platform',
        external_id: isExternal ? (listing as any).__external_id : undefined,
        photo_url: isExternal ? ((listing as any).__photo_url ?? undefined) : undefined,
        mls_name: isExternal ? ((listing as any).__mls_name ?? null) : null,
        mls_number: isExternal ? ((listing as any).__mls_number ?? null) : null,
        fit,
        explanation_voice: voiceScan.clean,
        source_label: sourceLabel,
        claims,
        follow_up_question: voice.followUpQuestion,
        agent_offer: voice.agentOffer,
        // WAVE 153 (153E): the status as its source reports it, where that status comes from and when it was read, the
        // outside copies folded into this result, and whose photo this is.
        listing_status: isExternal ? ((listing as any).__status_reported ?? null) : ((listing as any).status ?? null),
        freshness: isExternal
          ? { basis: (listing as any).__source === 'idx' ? 'mls_feed' as const : 'provider' as const, source_updated_at: null, checked_at: checkedAt }
          : { basis: 'live_board' as const, source_updated_at: (listing as any).updated_at ?? null, checked_at: checkedAt },
        also_listed_on: alsoListed.length > 0 ? alsoListed : undefined,
        photo_source: isExternal ? ((listing as any).__photo_url ? 'idx_mls' : null) : ((listing as any).primary_photo_url ? ((listing as any).__photo_source ?? 'tenant_listing_media') : null),
      }
    })
    if (claimProblems > 0) console.error(`[buyer-search] ${claimProblems} C18 claim problem(s) on this page — see above`)

    // WAVE 150 (lane 150W — directive canary 7, C27): THE BUYER'S STATED MUST-HAVES ARE HELD. When the buyer gave a lot
    // minimum (their unit) and/or a commute limit to a named place, only licensed, reported-ACTIVE homes whose explanation
    // PROVED each one met are shown; misses and unknowns are left out and counted, and an empty page carries the shortage
    // explanation built from the measured figures (lib/buyer-search/buyer-constraints.ts). No stated number → nothing held.
    const constraints = statedHardConstraints(fitCriteria.lifestyle ?? [])
    let constraintAnswer: ConstraintAnswer | null = null
    let results = pageResults
    if (constraints.length > 0) {
      const statusOf = new Map(viableListings.map(({ listing }) => {
        const l = listing as any
        return [String(l.id), l.__external ? (l.__status_reported ?? null) : (l.status ?? null)] as const
      }))
      constraintAnswer = answerStatedConstraints(pageResults.map((r) => ({
        ref: String(r.listing_id),
        label: r.address ?? r.city ?? 'This home',
        // ONE origin vocabulary (saved-homes): a platform row is the tenant's own listing; rentcast / idx as the source says.
        origin: savedHomeOrigin({ source: r.source === 'platform' || !r.source ? 'brokerage_listing' : r.source }),
        status: statusOf.get(String(r.listing_id)) ?? null,
        fit: r.fit ?? null,
      })), constraints)
      const keep = new Set(constraintAnswer.options)
      results = pageResults.filter((r) => keep.has(String(r.listing_id)))
    }

    if (fairHousingRewrites > 0) {
      console.warn('[buyer-search] fair-housing sanitizer rewrote generated match copy', {
        contact_id: contactId,
        explanations_rewritten: fairHousingRewrites,
        explanations_total: results.length,
        labels: Array.from(fairHousingLabels),
      })
    }

    // 7. Log signals — only for platform listings (external listings have
    // synthetic IDs that aren't UUIDs and don't FK back to listings table)
    if (logSignals && results.length > 0) {
      const platformResults = results.filter(r => r.source === 'platform' || !r.source)
      if (platformResults.length > 0) {
        await logBatchBuyerSearchMatches(
          contactId,
          platformResults.map(r => ({ listingId: r.listing_id, matchScore: r.internal_match_score, confidenceLevel: r.internal_confidence })),
          enrichedIntent,
          persona
        )
      }
      await appendBuyerSearchPreferences(contactId, enrichedIntent, persona)
    }

    return {
      success: true,
      results,
      /** Wave 150 (150W, canary 7): the stated must-haves, what was held back and why, and the shortage explanation. */
      constraint_answer: constraintAnswer,
      metadata: {
        total_listings_evaluated: listings.length,
        results_returned: results.length,
        /** Wave 153 (153E): outside copies folded into the tenant's own listings, and Coming Soon listings shown under policy. */
        outside_copies_folded: merged.folded,
        stale_outside_copies_suppressed: merged.staleSuppressed,
        coming_soon_shown: comingSoonListings.length,
        search_confidence: enrichedIntent.confidence,
        /**
         * What the fair-housing sanitizer rewrote in OUR generated copy — never
         * anything about the buyer's query, filters or scores. Reported so a
         * rewrite is visible rather than inferred; `explanations_rewritten: 0`
         * is a real "nothing fired", not "nobody looked".
         */
        fair_housing_sanitized: {
          explanations_rewritten: fairHousingRewrites,
          explanations_total: results.length,
          labels: Array.from(fairHousingLabels),
        },
        ...(includeDebugInfo && {
          debug: {
            persona_detected: persona.persona,
            persona_confidence: persona.confidence,
            parsed_intent: enrichedIntent,
          },
        }),
      },
    }
  } catch (error) {
    console.error('[v0] Error in searchPropertiesCore:', error)
    return handleError(error, 'searchPropertiesCore')
  }
}

/**
 * Explain a single property match for a buyer (lib-level).
 */
export async function explainPropertyMatchCore(params: {
  contactId: string
  listingId: string
  context?: string
}) {
  const { contactId, listingId, context } = params
  if (!isValidUUID(contactId) || !isValidUUID(listingId)) {
    return { success: false, error: 'Invalid contact or listing ID' }
  }

  try {
    const supabase = createServiceClient()

    const [{ data: listing, error: lErr }, { data: contact, error: cErr }] = await Promise.all([
      supabase.from('listings').select('id, price:list_price, bedrooms, bathrooms, square_feet:sqft, property_type, city, state, zip, status, created_at').eq('id', listingId).single(),
      supabase.from('contacts').select('id, first_name, last_name, notes, created_at').eq('id', contactId).single(),
    ])

    if (lErr || !listing) return { success: false, error: 'Listing not found' }
    if (cErr || !contact) return { success: false, error: 'Contact not found' }

    const { data: insight } = await supabase
      .from('conversation_insights')
      .select('inferred_intent:context_summary, urgency_level:escalation_urgency, overall_sentiment, health_score')
      .eq('contact_id', contactId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const buyerProfile: BuyerProfile = {
      contact_id: contactId,
      first_name: contact.first_name || 'Buyer',
      last_name: contact.last_name || '',
      notes: contact.notes,
      created_at: contact.created_at,
      inferred_intent: insight?.inferred_intent,
      urgency_level: insight?.urgency_level,
      sentiment: insight?.overall_sentiment,
      health_score: insight?.health_score,
    }

    const matchScore = scoreBuyerForListing(buyerProfile, listing as ListingProfile)
    const minimalIntent: ParsedBuyerIntent = { rawQuery: context || 'Show me details', confidence: 0.5 }
    const persona = inferBuyerPersona(minimalIntent, {
      sentiment: insight?.overall_sentiment,
      inferred_intent: insight?.inferred_intent,
      health_score: insight?.health_score,
    })
    // Same boundary and same honesty rule as searchPropertiesCore above: only the
    // explanation copy WE author is sanitized, and what the sanitizer rewrote is
    // returned rather than swallowed.
    const scanned = scanExplanation(generateMatchExplanation(listing as ListingProfile, minimalIntent, persona, matchScore.score))
    const explanation = scanned.clean
    if (scanned.flagged.length > 0) {
      console.warn('[buyer-search] fair-housing sanitizer rewrote generated match copy', {
        contact_id: contactId,
        listing_id: listingId,
        labels: scanned.flagged,
      })
    }

    return {
      success: true,
      explanation: {
        headline: explanation.headline,
        bullets: explanation.bullets,
        narrative: explanation.narrative,
        callToAction: explanation.callToAction,
      },
      /** Labels the fair-housing sanitizer rewrote in the copy above; [] = nothing fired. */
      fair_housing_sanitized: scanned.flagged,
      listing: { id: listing.id, price: listing.price, bedrooms: listing.bedrooms, city: listing.city, state: listing.state },
      match_quality: matchScore.match_confidence,
    }
  } catch (error) {
    console.error('[v0] Error in explainPropertyMatchCore:', error)
    return handleError(error, 'explainPropertyMatchCore')
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SAVED-HOME ORIGINS (wave 150, lane 150W; moved here from lib/portal/saved-homes.ts by the integrator — the engine is on
// every page graph, the portal read model is not; saved-homes re-exports them). The engine-side photo rule
// (`licensedResultPhotoUrl`) and the `isHttpUrl` predicate moved on to lib/buyer-search/explanation-evidence.ts beside
// `describeListingSource` — the SOURCE rule and the PHOTO rule are the same ruling (owner R9/R11: RentCast carries facts,
// never photos); this module imports the photo rule back for `__photo_url`.
// ═════════════════════════════════════════════════════════════════════════════

// ─── ORIGIN (the ONE saved-home origin vocabulary) ───────────────────────────────────────────────────────────────────────────────────────

export const SAVED_HOME_ORIGINS = ["idx_mls", "rentcast_listing", "buyer_url", "tenant_listing", "manual"] as const
export type SavedHomeOrigin = (typeof SAVED_HOME_ORIGINS)[number]

/** The `saved_properties.source` value each external origin is written with (m991 adds 'buyer_url' to the CHECK). */
export const SOURCE_FOR_ORIGIN = { idx_mls: "idx", rentcast_listing: "rentcast", buyer_url: "buyer_url" } as const

/** PURE. The origin a saved_properties row carries, from the survivor `source` column. */
export function savedHomeOrigin(row: { source?: string | null; listing_id?: string | null }): SavedHomeOrigin {
  const s = String(row.source ?? "").toLowerCase()
  if (s === "idx" || s === "mls") return "idx_mls"
  if (s === "rentcast") return "rentcast_listing"
  if (s === "buyer_url") return "buyer_url"
  if (s === "brokerage_listing" || row.listing_id) return "tenant_listing"
  return "manual"
}
