/**
 * SYSTEM 5.1B - BUYER-PERSONA EXPLANATION GENERATOR
 * Generate natural, buyer-friendly match explanations
 * 
 * CONSTRAINTS:
 * - Use second-person language ("you", "your")
 * - Reference what the buyer said or implied
 * - NO mention of AI, algorithms, scores, internal logic
 * - Persona-aware tone and focus
 */

import type { ParsedBuyerIntent } from './intent-parser'
import type { PersonaProfile } from './persona-inference'
import type { ListingProfile } from '@/lib/property-matching'
import type { BuyerCriteria, CriteriaField, CriteriaProvenanceSource } from './buyer-criteria'
import { provenanceOf } from './buyer-criteria'
import type { LifestyleAsk } from './conversation-criteria'
import {
  lotFactsFrom,
  formatAcres,
  formatDistance,
  readLotMinimum,
  lotMinimumAcres,
  formatLotMinimum,
  type EvidenceSource,
  type FitEvidence,
  type HomeLocationEvidence,
  type AmenityKind,
  type PlaceEvidence,
  type ListingSourceLabel,
} from './explanation-evidence'

export interface BuyerFacingExplanation {
  headline: string // Short, compelling match reason
  bullets: string[] // 3-5 bullet points
  narrative: string // 2-3 sentence natural explanation
  callToAction: string // Next step suggestion
}

/**
 * Generate buyer-friendly explanation for why a listing matches
 * Tailored to buyer persona and intent
 */
export function generateMatchExplanation(
  listing: ListingProfile,
  intent: ParsedBuyerIntent,
  persona: PersonaProfile,
  matchScore: number // Internal score, used for calibration only
): BuyerFacingExplanation {
  const bullets: string[] = []
  let headline = ''
  let narrative = ''
  let callToAction = ''

  // Get persona-specific guidelines
  const { emphasisOn, examplePhrases } = getPersonaGuidelines(persona.persona)

  // 1. HEADLINE - Strong, persona-aligned hook
  if (matchScore >= 80) {
    headline = generateStrongMatchHeadline(listing, intent, persona)
  } else if (matchScore >= 60) {
    headline = generateGoodMatchHeadline(listing, intent, persona)
  } else {
    headline = generateViableMatchHeadline(listing, intent, persona)
  }

  // 2. BULLETS - Top reasons, persona-focused
  
  // Price bullet
  if (intent.maxPrice && listing.price && listing.price <= intent.maxPrice) {
    const priceFriendly = formatPrice(listing.price)
    if (persona.persona === 'investor') {
      bullets.push(`Listed at ${priceFriendly}, below your target threshold`)
    } else if (persona.persona === 'first_time_buyer') {
      bullets.push(`Priced at ${priceFriendly} – within your budget`)
    } else if (persona.persona === 'bargain_hunter') {
      bullets.push(`${priceFriendly} asking price – room to negotiate`)
    } else {
      bullets.push(`${priceFriendly} aligns with your budget`)
    }
  }

  // Bedroom bullet
  if (intent.minBeds && listing.bedrooms && listing.bedrooms >= intent.minBeds) {
    // Wave 147C: was "for your growing family" when intent.lifestyle === 'family' — familial
    // characterization authored by US (the parser never sets that lifestyle any more, and the
    // sanitizer would rewrite it anyway). The bullet now states the fact and the ask.
    if (persona.persona === 'first_time_buyer' || persona.persona === 'move_up_buyer') {
      bullets.push(`${listing.bedrooms} bedrooms — at least the ${intent.minBeds} you asked for`)
    } else if (persona.persona === 'investor') {
      bullets.push(`${listing.bedrooms} beds – strong rental appeal`)
    } else {
      bullets.push(`${listing.bedrooms} bedrooms as you requested`)
    }
  }

  // Location bullet
  if (intent.cities && listing.city && intent.cities.some(c => c.toLowerCase() === (listing.city ?? "").toLowerCase())) {
    if (persona.persona === 'relocation') {
      bullets.push(`Located in ${listing.city} where you're relocating`)
    } else if (persona.persona === 'first_time_buyer') {
      bullets.push(`In your preferred area: ${listing.city}`)
    } else {
      bullets.push(`${listing.city} location matches your search`)
    }
  }

  // Property type bullet
  if (intent.propertyTypes && listing.property_type && intent.propertyTypes.includes(listing.property_type)) {
    const typeFriendly = formatPropertyType(listing.property_type)
    bullets.push(`${typeFriendly} as you're looking for`)
  }

  // Features bullet (persona-specific)
  if (listing.features && listing.features.length > 0) {
    const relevantFeatures = getRelevantFeatures(listing.features, persona, intent)
    if (relevantFeatures.length > 0) {
      const featureList = relevantFeatures.slice(0, 3).join(', ')
      bullets.push(`Features: ${featureList}`)
    }
  }

  // Size/space bullet (if relevant to persona)
  if (listing.square_feet && ['move_up_buyer', 'family', 'investor'].includes(persona.persona)) {
    const sqftFriendly = listing.square_feet.toLocaleString()
    if (persona.persona === 'move_up_buyer') {
      bullets.push(`${sqftFriendly} sq ft – plenty of space to grow`)
    } else if (persona.persona === 'investor') {
      bullets.push(`${sqftFriendly} sq ft at ${formatPricePerSqft(listing.price, listing.square_feet)}/sq ft`)
    }
  }

  // Urgency-based bullet. Wave 147C: was 'Available now – move-in ready' — "move-in ready" is a
  // CONDITION claim no listing field carries (an invented listing fact, C10 rule 7). The status is
  // the fact we hold, so the status is what we say.
  if (intent.urgency === 'high' && listing.status === 'active') {
    bullets.push('Listed as active right now')
  }

  // Limit to 5 bullets max
  const finalBullets = bullets.slice(0, 5)

  // 3. NARRATIVE - Natural language explanation
  narrative = generateNarrative(listing, intent, persona, finalBullets)

  // 4. CALL TO ACTION - Next step
  callToAction = generateCallToAction(persona, intent.urgency)

  return {
    headline,
    bullets: finalBullets,
    narrative,
    callToAction,
  }
}

/**
 * SAY THE PLACE THE BUYER SAID.
 *
 * This module's own stated constraint at the top of the file is "Reference what the
 * buyer said or implied" — and until 2026-08-24 all three headline generators
 * ACCEPTED `intent` and read nothing out of it, falling back to the anonymous
 * "this area" whenever the listing row had no city. The buyer had typed a
 * neighbourhood or a city into the query; the parser had captured it; the headline
 * then refused to use it.
 */
function describeLocation(listing: ListingProfile, intent: ParsedBuyerIntent): string {
  return (
    listing.city ||
    intent.neighborhoods?.[0] ||
    intent.cities?.[0] ||
    'this area'
  )
}

/**
 * Generate strong match headlines (80+ score)
 */
function generateStrongMatchHeadline(
  listing: ListingProfile,
  intent: ParsedBuyerIntent,
  persona: PersonaProfile
): string {
  const location = describeLocation(listing, intent)

  switch (persona.persona) {
    case 'first_time_buyer':
      return `Excellent starter home in ${location}`
    case 'investor':
      return `High-potential investment in ${location}`
    case 'relocation':
      return `Perfect fit for your move to ${location}`
    case 'downsizer':
      return `Strong downsizing match in ${location}`
    case 'luxury_buyer':
      return `Premium property in ${location}`
    case 'move_up_buyer':
      return `Outstanding upgrade opportunity in ${location}`
    case 'bargain_hunter':
      return `Exceptional value in ${location}`
    default:
      return `Great match in ${location}`
  }
}

/**
 * Generate good match headlines (60-79 score)
 */
function generateGoodMatchHeadline(
  listing: ListingProfile,
  intent: ParsedBuyerIntent,
  persona: PersonaProfile
): string {
  const beds = listing.bedrooms ? `${listing.bedrooms}-bedroom ` : ''
  const type = formatPropertyType(listing.property_type)
  const location = describeLocation(listing, intent)

  switch (persona.persona) {
    case 'first_time_buyer':
      return `Solid ${beds}${type} to start your journey`
    case 'investor':
      return `Promising ${beds}${type} with rental potential`
    case 'relocation':
      return `Well-located ${beds}${type} for your move`
    case 'downsizer':
      return `${beds}${type} worth a look for downsizing`
    case 'luxury_buyer':
      return `Quality ${beds}${type} in desirable location`
    case 'move_up_buyer':
      return `Spacious ${beds}${type} for your next chapter`
    case 'bargain_hunter':
      return `Good value ${beds}${type} in ${location}`
    default:
      return `Nice ${beds}${type} in ${location} matching your criteria`
  }
}

/**
 * Generate viable match headlines (45-59 score)
 *
 * `intent` and `persona` were both accepted here and read by NOTHING — this was the
 * one headline of the three that told the buyer nothing at all, on the very matches
 * that most need a reason to be looked at. The weaker the match, the more the
 * headline has to earn: it now names the ONE thing that does line up (the buyer's
 * own place, their budget, or the persona's stated emphasis) instead of a bare
 * property type.
 */
function generateViableMatchHeadline(
  listing: ListingProfile,
  intent: ParsedBuyerIntent,
  persona: PersonaProfile
): string {
  const type = formatPropertyType(listing.property_type)
  const location = describeLocation(listing, intent)

  if (intent.maxPrice && listing.price && listing.price <= intent.maxPrice) {
    return `${type} in ${location}, within your budget`
  }

  switch (persona.persona) {
    case 'investor':
      return `${type} in ${location} worth running the numbers on`
    case 'bargain_hunter':
      return `${type} in ${location} worth a closer look at the price`
    case 'downsizer':
      return `${type} in ${location} worth considering for downsizing`
    case 'first_time_buyer':
      return `${type} in ${location} worth touring as you compare`
    default:
      return `${type} in ${location} worth considering`
  }
}

/**
 * Generate natural language narrative
 */
function generateNarrative(
  listing: ListingProfile,
  intent: ParsedBuyerIntent,
  persona: PersonaProfile,
  bullets: string[]
): string {
  const location = listing.city ? `in ${listing.city}` : 'in this area'
  const type = formatPropertyType(listing.property_type)

  // Build context-aware narrative
  let intro = ''
  let connection = ''
  let closing = ''

  // Intro - Acknowledge their search
  if (intent.rawQuery.length > 20) {
    intro = `Based on what you're looking for, `
  } else {
    intro = `This property `
  }

  // Connection - Link to their needs.
  //
  // WAVE 147C — NO INVENTED LISTING FACTS (contract C10, rule 7). The closings that stood here
  // asserted things no listing field carries: "move-in ready", "a neighborhood that's perfect for
  // building your future", "the area shows consistent demand", "convenient to major employment
  // centers and offers immediate availability", "every detail reflects uncompromising standards",
  // "strong resale value", "your family's evolving needs" (a familial characterization we author).
  // Each persona keeps its TONE; every sentence is now either a fact we hold (type, place) or a
  // next step the buyer can take to find out for themselves.
  switch (persona.persona) {
    case 'first_time_buyer':
      connection = `this ${type} ${location} is worth a look as a first home. `
      closing = `A tour is the best way to see how it feels in person.`
      break

    case 'investor':
      connection = `this ${type} ${location} may be worth underwriting. `
      closing = `Your agent can pull rents and recent sales nearby so you can run the numbers.`
      break

    case 'relocation':
      connection = `this ${type} ${location} is on your list for the move. `
      closing = `A virtual tour is a good first look from a distance.`
      break

    case 'downsizer':
      connection = `this ${type} ${location} is one to consider. `
      closing = `Ask your agent about upkeep, HOA rules and any shared amenities.`
      break

    case 'luxury_buyer':
      connection = `this ${type} ${location} is on your shortlist. `
      closing = `A private showing is the best way to judge the finishes.`
      break

    case 'move_up_buyer':
      connection = `this ${type} ${location} could give you more room. `
      closing = `See whether the space works for how you live.`
      break

    case 'bargain_hunter':
      connection = `this ${type} ${location} is worth checking on price. `
      closing = `Your agent can pull recent sales to test the asking price.`
      break

    default:
      connection = `matches several of your key criteria. `
      closing = `It's worth exploring further.`
  }

  // `bullets` WAS PASSED IN AND READ BY NOTHING. The bullets are the evidence this
  // narrative is supposed to be narrating; without them the closing sentence made a
  // claim the paragraph never supported. The strongest bullet is named so the prose
  // and the list agree — and when there are no bullets at all, the narrative stops
  // asserting rather than asserting on nothing.
  if (bullets.length === 0) {
    return `${intro}${connection}`
  }
  const evidence = ` The biggest reason: ${lowerFirst(bullets[0])}.`

  return intro + connection + closing + evidence
}

/** Lower-cases the first character only, so a bullet reads as clause. */
function lowerFirst(text: string): string {
  return text.length > 0 ? text.charAt(0).toLowerCase() + text.slice(1) : text
}

/**
 * Generate persona-appropriate call to action
 */
function generateCallToAction(persona: PersonaProfile, urgency?: string): string {
  if (urgency === 'high') {
    return 'Schedule a showing today'
  }

  switch (persona.persona) {
    case 'first_time_buyer':
      return 'Schedule a tour to see if it feels like home'
    case 'investor':
      return 'Request detailed financials and comparable sales'
    case 'relocation':
      return 'Book a virtual or in-person tour'
    case 'downsizer':
      return 'Schedule a relaxed walkthrough'
    case 'luxury_buyer':
      return 'Arrange a private showing'
    case 'move_up_buyer':
      return 'See it in person with your family'
    case 'bargain_hunter':
      return 'Submit an offer or request more details'
    default:
      return 'Schedule a showing to learn more'
  }
}

/**
 * Get persona-specific messaging guidelines
 */
function getPersonaGuidelines(persona: string) {
  // Simplified version for internal use
  const guidelines: Record<string, { emphasisOn: string[]; examplePhrases: string[] }> = {
    first_time_buyer: {
      emphasisOn: ['affordability', 'neighborhood', 'safety', 'schools'],
      examplePhrases: ['perfect to start', 'great neighborhood', 'within budget'],
    },
    investor: {
      emphasisOn: ['cash flow', 'cap rate', 'rental demand', 'appreciation'],
      examplePhrases: ['strong returns', 'solid fundamentals', 'rental potential'],
    },
    relocation: {
      emphasisOn: ['commute', 'amenities', 'move-in ready'],
      examplePhrases: ['convenient location', 'ready to occupy', 'well-connected'],
    },
    downsizer: {
      emphasisOn: ['low maintenance', 'accessibility', 'community'],
      examplePhrases: ['easy upkeep', 'active community', 'single level'],
    },
    luxury_buyer: {
      emphasisOn: ['exclusivity', 'quality', 'prestige'],
      examplePhrases: ['exceptional quality', 'rare opportunity', 'premium finishes'],
    },
    move_up_buyer: {
      emphasisOn: ['space', 'upgrades', 'schools', 'resale'],
      examplePhrases: ['room to grow', 'upgraded features', 'strong resale'],
    },
    bargain_hunter: {
      emphasisOn: ['value', 'price', 'potential'],
      examplePhrases: ['great value', 'below market', 'priced right'],
    },
  }

  return guidelines[persona] || { emphasisOn: [], examplePhrases: [] }
}

/**
 * Filter features relevant to persona and intent
 */
function getRelevantFeatures(
  features: string[],
  persona: PersonaProfile,
  intent: ParsedBuyerIntent
): string[] {
  const priorityFeatures: string[] = []

  // Filter based on persona focus
  features.forEach(feature => {
    const featureLower = feature.toLowerCase()

    if (persona.persona === 'first_time_buyer') {
      if (['updated kitchen', 'new appliances', 'move-in ready', 'garage'].some(p => featureLower.includes(p))) {
        priorityFeatures.push(feature)
      }
    } else if (persona.persona === 'investor') {
      if (['separate entrance', 'rental unit', 'income potential', 'low maintenance'].some(p => featureLower.includes(p))) {
        priorityFeatures.push(feature)
      }
    } else if (persona.persona === 'luxury_buyer') {
      if (['gourmet kitchen', 'wine cellar', 'smart home', 'pool', 'views'].some(p => featureLower.includes(p))) {
        priorityFeatures.push(feature)
      }
    } else if (persona.persona === 'downsizer') {
      if (['single story', 'elevator', 'no stairs', 'hoa amenities'].some(p => featureLower.includes(p))) {
        priorityFeatures.push(feature)
      }
    } else {
      // General relevance
      if (intent.features?.some(f => featureLower.includes(f.toLowerCase()))) {
        priorityFeatures.push(feature)
      } else {
        priorityFeatures.push(feature)
      }
    }
  })

  return priorityFeatures
}

/**
 * Format helpers
 */
function formatPrice(price: number | null): string {
  if (!price) return 'Price available upon request'
  return `$${(price / 1000).toFixed(0)}K`
}

function formatPricePerSqft(price: number | null, sqft: number | null): string {
  if (!price || !sqft) return 'N/A'
  const pricePerSqft = price / sqft
  return `$${pricePerSqft.toFixed(0)}`
}

function formatPropertyType(type: string | null): string {
  if (!type) return 'property'
  
  const typeMap: Record<string, string> = {
    single_family: 'single-family home',
    condo: 'condo',
    townhouse: 'townhouse',
    multi_family: 'multi-family property',
    apartment: 'apartment',
  }

  return typeMap[type] || type
}

// ═════════════════════════════════════════════════════════════════════════════
// EXPLAINABLE MATCH — { matches, misses, unknowns } (wave 147, lane 147C, contract C10)
// ═════════════════════════════════════════════════════════════════════════════
//
// The persona copy above says WHY a buyer might like a home. This says HOW the home lines
// up with what the buyer actually asked for, item by item, and it is deterministic: the
// matcher compares the listing's own data to the buyer's criteria and nothing else.
//
//   match   — the listing's data satisfies the ask ("Listed at $575k").
//   miss    — the listing's data contradicts the ask ("3 bedrooms — you asked for 4").
//   unknown — the listing data cannot answer the ask. ALWAYS said, never guessed:
//             absence of a mention is not absence of the feature, and no feed measures
//             natural light, a commute, or how quiet a street is.
//
// Lifestyle asks are answered ONLY where accurate source data exists: the listing's own
// structured columns (has_pool, has_septic, hoa_dues, lot_size), the listing agent's public
// remarks — a REPORT, attributed as such ("the listing description mentions …"), never
// restated as verified fact — and, since wave 148 (lane 148E, contract C18), the evidence a home
// carries (location-evidence.ts): a Mapbox-routed drive time, OpenStreetMap places within an
// easy walk, building spacing and road exposure, a RentCast lot size in acres. Each such answer
// names its source on `evidence`; with no evidence the ask stays UNKNOWN.

// Wave 148 (lane 148E, contract C18): + 'provider' — an ask answered by a provider's evidence (a Mapbox drive time,
// OpenStreetMap places / building spacing, a RentCast lot size) rather than the listing row; the item then carries
// `evidence` naming exactly which source, how sure, the figures it states and — only then — a map.
export type FitSource = 'listing' | 'listing_remarks' | 'provider' | 'none'

export interface FitItem {
  /** The criteria field (or `lifestyle:<kind>`) this item answers. */
  field: CriteriaField | `lifestyle:${string}`
  /** The buyer's ask in plain words ("Under $600k", "Natural light"). */
  ask: string
  /** What the data says, or why it cannot say. */
  detail: string
  source: FitSource
  /** said | inferred | default — said asks lead every bucket. */
  provenance: CriteriaProvenanceSource | null
  /** C18 (wave 148E): the evidence behind a lifestyle answer — absent on a plain listing-row fact. */
  evidence?: FitEvidence
  /** Wave 148E: the same fact said briefly, for the spoken / narrative voice (the checklist keeps `detail`). */
  brief?: string
}

export interface CriteriaFit {
  matches: FitItem[]
  misses: FitItem[]
  unknowns: FitItem[]
  /** Wave 149 (149B, C27): measured facts with NO verdict because the buyer has not given the bar (the lot with no
   *  stated minimum). Evidence-backed; the buyer decides. Optional for older serialised fits. */
  facts?: FitItem[]
}

/** The listing facts the fit reads — platform rows carry more of them than an external feed row. */
export interface ListingFitFacts {
  price: number | null
  bedrooms: number | null
  bathrooms: number | null
  square_feet?: number | null
  property_type: string | null
  city: string | null
  zip?: string | null
  status?: string | null
  has_pool?: boolean | null
  has_septic?: boolean | null
  hoa_dues?: number | null
  lot_size?: number | null
  /** Wave 149Z (m954): the unit the listing states beside lot_size ('square_feet' | 'acres'); null = not stated. */
  lot_size_unit?: string | null
  year_built?: number | null
  public_remarks?: string | null
  features?: string[] | null
  /** Wave 148 (148E): a lot size the source reports in SQUARE FEET (RentCast lotSize) — converted to acres, never guessed. */
  lot_size_sqft?: number | null
  /** Wave 148 (148E): who reported the row's facts — the listing itself, or RentCast property data. */
  facts_source?: EvidenceSource
}

function money(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`
  if (n >= 10_000) return `$${Math.round(n / 1000)}k`
  return `$${n.toLocaleString('en-US')}`
}

/** The phrase in the remarks that supports an ask, quoted back — or null. */
function remarksMention(remarks: string | null | undefined, pattern: RegExp): string | null {
  if (!remarks) return null
  const m = pattern.exec(remarks)
  return m ? m[0].trim() : null
}

const LIGHT_IN_REMARKS = /\b(natural light|sun[- ]?(?:filled|drenched|lit)|light[- ]filled|bright and airy|skylights?|south[- ]facing|walls? of windows|floor[- ]to[- ]ceiling windows)\b/i
const OPEN_PLAN_IN_REMARKS = /\bopen (?:floor ?plan|concept|layout)\b/i
const SINGLE_LEVEL_IN_REMARKS = /\b(single[- ]stor(?:y|ey)|one[- ]stor(?:y|ey)|single[- ]level|one[- ]level|ranch)\b/i
const PRIMARY_MAIN_IN_REMARKS = /\b(?:primary|master)(?: bedroom| suite)?\s+(?:on|down)\s+(?:the\s+)?(?:main|first|ground)\b/i
const SPLIT_IN_REMARKS = /\bsplit (?:floor ?plan|bedrooms?)\b/i
const ACCESS_IN_REMARKS = /\b(wheelchair[- ]accessible|step[- ]free|zero[- ]step|no[- ]step entry|ada[- ]compliant|wide doorways|elevator)\b/i
const QUIET_IN_REMARKS = /\b(cul[- ]de[- ]sac|quiet street|low[- ]traffic)\b/i

type Bucketed = { bucket: keyof CriteriaFit; item: FitItem }

// ─── LIFESTYLE ANSWERED FROM EVIDENCE (wave 148, lane 148E — owner ruling 7, contract C18) ───────
//
// Owner: "if they need walkability or how far it is to commute or yard size or quiet setting, those can have more
// info like a map; outdoor space is a home with acreage; quiet setting is not close to neighbors." Each ask is now
// answered from the evidence a home actually carries (./location-evidence.ts gathers it; ./explanation-evidence.ts
// types it), with the figure, the source, the assumption and the limits — and stays UNKNOWN when no evidence exists.
// The thresholds below are the plain-language bars the explanation uses to say "fits" or "doesn't"; the FIGURE is
// always shown beside the verdict so the buyer judges for themselves.

// TOMBSTONE (wave 149, lane 149B — owner ruling 5, C27): three platform-invented yard bars stood here —
// ACREAGE_MIN_ACRES = 1 ("acreage" meant ≥ 1 acre unless the buyer said otherwise), ROOMY_LOT_ACRES = 0.25 (a "bigger
// yard" ask matched at a quarter acre) and SMALL_LOT_ACRES = 0.2 (a "less yard" ask matched at a fifth of an acre).
// Owner: "The buyer decides the yard and acreage minimum. AI clarifies, never invents a minimum." The verdict now
// comes ONLY from the buyer's stated minimum (LifestyleAsk.lotMinimum — conversation-criteria.ts statedLotMinimum);
// without one the lot is stated as a FACT (fit.facts — acres, sq ft, source, limits) and the buyer is asked how much
// yard or land feels right. Survivor of the comparison: the outdoor_space case below.
/** Straight-line metres that read as "an easy walk" (≈ 15 minutes at an average pace). */
const WALKABLE_METERS = 1200
/** Quiet / privacy bars: the nearest other mapped building, and how close a major road or mainline rail runs. */
const ROOMY_SPACING_METERS = 40
const CLOSE_SPACING_METERS = 25
const LOUD_ROAD_METERS = 120
const LOUD_RAIL_METERS = 200

const AMENITY_KIND_BY_TARGET: Array<[RegExp, AmenityKind]> = [
  [/\b(parks?|trails?|greenbelt)\b/i, 'park'],
  [/\b(grocery|grocery stores?)\b/i, 'grocery'],
  [/\b(coffee|coffee shops?|restaurants?|shops|shopping)\b/i, 'cafe_restaurant'],
  [/\b(transit|train|train station|light rail)\b/i, 'transit'],
]
const AMENITY_WORDS_FOR: Record<AmenityKind, string> = { park: 'park', grocery: 'grocery store', cafe_restaurant: 'café or restaurant', transit: 'transit stop' }

const OUTDOOR_FEATURES_IN_REMARKS = /\b(fenced (?:back)?yard|covered patio|patio|deck|porch|outdoor kitchen|garden|wooded|pasture|barn|creek|pond|sprinkler system|mature trees)\b/gi

const lifestyleMap = (m: import('./explanation-evidence').MapEvidence | null | undefined) => (m && m.image_url ? m : null)

function outdoorFeatureNote(l: ListingFitFacts): string | null {
  const found = new Set<string>()
  for (const m of (l.public_remarks ?? '').matchAll(OUTDOOR_FEATURES_IN_REMARKS)) found.add(m[0].toLowerCase())
  for (const f of l.features ?? []) if (OUTDOOR_FEATURES_IN_REMARKS.test(f)) found.add(f.toLowerCase())
  OUTDOOR_FEATURES_IN_REMARKS.lastIndex = 0
  if (!found.size) return null
  return `the listing mentions ${[...found].slice(0, 3).join(', ')}`
}

function lifestyleFit(ask: LifestyleAsk, l: ListingFitFacts, prov: CriteriaProvenanceSource | null, ev?: HomeLocationEvidence | null): Bucketed {
  const field = `lifestyle:${ask.kind}` as const
  const askText = ask.label.charAt(0).toUpperCase() + ask.label.slice(1)
  const reported = (phrase: string): Bucketed => ({ bucket: 'matches', item: { field, ask: askText, detail: `The listing description mentions "${phrase}" (the listing agent's words, not an inspection)`, source: 'listing_remarks', provenance: prov } })
  const unknown = (detail: string): Bucketed => ({ bucket: 'unknowns', item: { field, ask: askText, detail, source: 'none', provenance: prov } })
  const proven = (bucket: keyof CriteriaFit, detail: string, evidence: FitEvidence, brief?: string): Bucketed => ({ bucket, item: { field, ask: askText, detail, source: evidence.source === 'listing' ? 'listing' : 'provider', provenance: prov, evidence, ...(brief ? { brief } : {}) } })
  const acreLot = (acres: number) => `a ${acres >= 10 ? Math.round(acres) : acres >= 1 ? acres.toFixed(1).replace(/\.0$/, '') : acres.toFixed(2)}-acre lot`
  const lot = lotFactsFrom({ lotSizeSqft: l.lot_size_sqft ?? null, lotSize: l.lot_size ?? null, lotSizeUnit: l.lot_size_unit ?? null, source: l.facts_source ?? 'listing' })
  const lotCaveat = lot?.basis === 'inferred_from_magnitude' ? "the listing doesn't record the unit, so it's read from the size of the number" : null

  switch (ask.kind) {
    case 'commute': {
      if (!ask.target) return unknown("Tell me where the commute is to and I'll map the drive from this address")
      const t = ev?.travel.find((x) => x.target.toLowerCase() === ask.target!.toLowerCase())
      if (!t || t.minutes == null) {
        return unknown(t?.note
          ? `I couldn't measure the drive to ${ask.target} just now (${t.note}) — ask me again or check a map from the address at the hour you'd travel`
          : `Drive time to ${ask.target} isn't measured for this home yet — tap "Why this home?" and I'll map it, or ask your agent`)
      }
      const miles = t.meters != null ? Math.round((t.meters / 1609.344) * 10) / 10 : null
      const how = t.profile === 'walking' ? 'on foot' : t.profile === 'cycling' ? 'by bike' : 'by car'
      const detail = `About ${t.minutes} min ${how} to ${t.placeLabel}${miles != null ? ` (${formatDistance(t.meters!)})` : ''} — ${t.assumption}`
      const evidence: FitEvidence = { source: 'provider:mapbox', confidence: t.profile === 'driving-traffic' ? 'high' : 'medium', figures: { minutes: t.minutes, ...(miles != null ? { miles } : {}) }, observed_at: t.observed_at, caveat: t.assumption, map: lifestyleMap(t.map) }
      const brief = `about ${t.minutes} minutes ${how} to ${t.placeLabel}${t.profile === 'driving' ? ' outside rush hour' : ''}`
      if (ask.maxMinutes != null && t.minutes > ask.maxMinutes) return proven('misses', `${detail} — over the ${ask.maxMinutes} minutes you gave`, evidence, `${brief}, over the ${ask.maxMinutes} minutes you gave`)
      return proven('matches', detail, evidence, brief)
    }
    case 'nearby_amenity': {
      const kind = ask.target ? AMENITY_KIND_BY_TARGET.find(([re]) => re.test(ask.target!))?.[1] ?? null : null
      if (ask.target && !kind) return unknown(`Whether ${ask.target} ${/s$/.test(ask.target) ? 'are' : 'is'} close by isn't something I can map yet — a map from the address will show you`)
      const a = ev?.amenities
      if (!a) {
        return unknown(ask.target
          ? `Whether ${ask.target} ${/s$/.test(ask.target) ? 'are' : 'is'} close by isn't in the listing data — tap "Why this home?" and I'll look at the map`
          : "Walkability isn't in the listing data — tap \"Why this home?\" and I'll look at what's mapped within an easy walk")
      }
      const pool: PlaceEvidence[] = (kind ? a.places.filter((p) => p.kind === kind) : a.places).slice().sort((x, y) => x.meters - y.meters)
      const near = pool.filter((p) => p.meters <= WALKABLE_METERS)
      const evidence = (figures: Record<string, number>): FitEvidence => ({ source: a.source, confidence: 'medium', figures, observed_at: a.observed_at, caveat: 'straight-line distances to places OpenStreetMap has mapped — actual walking routes are longer, and coverage varies', map: lifestyleMap(a.map) })
      const list = (ps: PlaceEvidence[]) => ps.slice(0, 3).map((p) => `${p.name} (${formatDistance(p.meters)})`).join(', ')
      if (near.length > 0) {
        const lead = kind ? `${near.length === 1 ? 'A' : near.length} ${AMENITY_WORDS_FOR[kind]}${near.length === 1 ? '' : 's'} within an easy walk` : `${near.length} everyday place${near.length === 1 ? '' : 's'} mapped within an easy walk`
        return proven('matches', `${lead}: ${list(near)}`, evidence({ places_within_walk: near.length, nearest_meters: near[0].meters }), `${near[0].name} is ${formatDistance(near[0].meters)} away`)
      }
      if (pool.length > 0) return proven('misses', `The nearest mapped ${kind ? AMENITY_WORDS_FOR[kind] : 'everyday place'} is ${pool[0].name}, ${formatDistance(pool[0].meters)} away — more of a short drive than a walk`, evidence({ nearest_meters: pool[0].meters }), `the nearest mapped ${kind ? AMENITY_WORDS_FOR[kind] : 'everyday place'} is ${formatDistance(pool[0].meters)} away`)
      return unknown(`OpenStreetMap shows no ${kind ? AMENITY_WORDS_FOR[kind] : 'everyday places'} mapped close by — coverage varies, so a drive around is worth it`)
    }
    case 'outdoor_space': {
      if (!lot) return unknown("Yard size isn't in the listing data — photos and a visit will show you")
      if (lot.acres == null) return unknown(`The lot size is listed as ${lot.raw} but the listing doesn't say whether that's acres or square feet — your agent can confirm`)
      const acres = Math.round(lot.acres * 100) / 100
      const sizeText = `${formatAcres(lot.acres)}${lot.sqft ? ` (about ${Math.round(lot.sqft).toLocaleString('en-US')} sq ft)` : ''}`
      const features = outdoorFeatureNote(l)
      const caveat = ["usable yard isn't measured — slopes, easements, setbacks and HOA rules can shrink it, and the plat or survey shows the boundaries", lotCaveat].filter(Boolean).join('; ')
      const evidence: FitEvidence = { source: lot.source, confidence: lot.basis === 'reported_sqft' || lot.basis === 'reported_acres' ? 'high' : 'medium', figures: { acres, ...(lot.sqft ? { lot_sqft: Math.round(lot.sqft) } : {}) }, caveat }
      const withFeatures = (s: string) => (features ? `${s}; ${features}` : s)
      const lotBrief = (tail: string) => `${acreLot(lot.acres!)}${tail}`
      // C27: the BUYER's minimum decides (converted to acres — conversion is allowed, inventing is not). A legacy row's
      // `minAcres` was only ever set from a stated number (148E's parser), so it is read as the buyer's when no
      // `lotMinimum` rides the ask.
      const stated = readLotMinimum(ask.lotMinimum)
        ?? (ask.minAcres && ask.minAcres > 0 ? { value: ask.minAcres, unit: 'acres' as const, stated_by: 'buyer' as const, literal: ask.evidence, confidence: 'high' as const } : null)
      if (stated && ask.direction !== 'less') {
        const min = lotMinimumAcres(stated)
        const said = formatLotMinimum(stated)
        return lot.acres >= min
          ? proven('matches', withFeatures(`The lot is ${sizeText} — at or above the ${said} you said`), evidence, lotBrief(`, at or above the ${said} you said`))
          : proven('misses', withFeatures(`The lot is ${sizeText} — under the ${said} you said`), evidence, lotBrief(`, under the ${said} you said`))
      }
      // No bar the buyer gave → the lot is a FACT, not a verdict, and the buyer is asked (never a platform minimum).
      const question = ask.direction === 'less'
        ? "how much yard feels easy to keep up is yours to say — tell me a size and I'll check every home against it"
        : "how much yard or land feels right is yours to say — tell me a size (half an acre, 2 acres, 10,000 sq ft) and I'll check every home against it"
      return { bucket: 'facts', item: { field, ask: askText, detail: withFeatures(`The lot is ${sizeText}; ${question}`), source: evidence.source === 'listing' ? 'listing' : 'provider', provenance: prov, evidence, brief: lotBrief('') } }
    }
    case 'quiet_setting': {
      const hit = remarksMention(l.public_remarks, QUIET_IN_REMARKS)
      const s = ev?.surroundings
      const acres = lot?.acres ?? null
      const caveatQuiet = "distance isn't sound — a visit at rush hour is the real test, and OpenStreetMap's building coverage varies by area"
      if (s) {
        const figures: Record<string, number> = {}
        if (s.nearestOtherBuildingMeters != null) figures.nearest_building_feet = Math.round(s.nearestOtherBuildingMeters * 3.28084)
        if (s.nearestMajorRoad) figures.major_road_feet = Math.round(s.nearestMajorRoad.meters * 3.28084)
        if (acres != null) figures.acres = Math.round(acres * 100) / 100
        const evidence: FitEvidence = { source: s.source, confidence: 'low', figures, observed_at: s.observed_at, caveat: caveatQuiet }
        const remarkNote = hit ? `; the listing description mentions "${hit}"` : ''
        if (s.nearestMajorRoad && s.nearestMajorRoad.meters <= LOUD_ROAD_METERS) {
          return proven('misses', `A major road${s.nearestMajorRoad.name ? ` (${s.nearestMajorRoad.name})` : ''} runs ${formatDistance(s.nearestMajorRoad.meters)} away, so expect some traffic sound${remarkNote}`, evidence, `a major road runs ${formatDistance(s.nearestMajorRoad.meters)} away`)
        }
        if (s.nearestRailMeters != null && s.nearestRailMeters <= LOUD_RAIL_METERS) {
          return proven('misses', `A rail line runs ${formatDistance(s.nearestRailMeters)} away${remarkNote}`, evidence, `a rail line runs ${formatDistance(s.nearestRailMeters)} away`)
        }
        const spacing = s.nearestOtherBuildingMeters
        const onLand = acres != null && acres >= 0.75
        if ((spacing != null && spacing >= ROOMY_SPACING_METERS) || onLand) {
          return proven('matches', `${spacing != null ? `The nearest other mapped building is ${formatDistance(spacing)} away` : 'No other building is mapped close by'}${acres != null ? ` on ${acreLot(acres)}` : ''}, and no major road is mapped within a quarter mile${remarkNote}`, evidence, spacing != null ? `the nearest other building sits ${formatDistance(spacing)} away, with no major road close by` : 'no other building is mapped close by')
        }
        if (spacing != null && spacing < CLOSE_SPACING_METERS) {
          return proven('misses', `Homes sit close together here — the nearest other mapped building is ${formatDistance(spacing)} away${remarkNote}`, evidence, `homes sit close together, about ${formatDistance(spacing).replace(/^about /, '')} apart`)
        }
        if (spacing != null) {
          return proven('matches', `Typical spacing — the nearest other mapped building is ${formatDistance(spacing)} away, with no major road mapped close by${remarkNote}`, evidence, `typical spacing, the next building ${formatDistance(spacing)} away`)
        }
      }
      if (acres != null && acres >= 1) {
        return proven('matches', `On ${formatAcres(acres)}, there's real room between this home and the next${hit ? `; the listing description mentions "${hit}"` : ''}`, { source: lot!.source, confidence: 'medium', figures: { acres: Math.round(acres * 100) / 100 }, caveat: caveatQuiet }, `real room between this home and the next on ${formatAcres(acres)}`)
      }
      return hit ? reported(hit) : unknown("How close the next home sits and how busy the street is aren't in the listing data — tap \"Why this home?\" and I'll check the map, or drive by at rush hour")
    }
    case 'natural_light': {
      if (ask.direction === 'less') return unknown("How much light the rooms get isn't in the listing data — photos and a visit will tell you")
      const hit = remarksMention(l.public_remarks, LIGHT_IN_REMARKS)
      return hit ? reported(hit) : unknown("Natural light isn't something the listing data measures — photos and a visit at the time of day you care about will tell you")
    }
    case 'layout': {
      const pattern = ask.label === 'open floor plan' ? OPEN_PLAN_IN_REMARKS
        : ask.label === 'single level' ? SINGLE_LEVEL_IN_REMARKS
        : ask.label.startsWith('primary') ? PRIMARY_MAIN_IN_REMARKS
        : SPLIT_IN_REMARKS
      const hit = remarksMention(l.public_remarks, pattern)
      return hit ? reported(hit) : unknown(`The listing data doesn't say whether it has a ${ask.label} — the floor plan or a tour will answer it`)
    }
    case 'accessibility': {
      const hit = remarksMention(l.public_remarks, ACCESS_IN_REMARKS)
      return hit ? reported(hit) : unknown("Accessibility features aren't confirmed in the listing data — your agent can ask the listing agent for specifics")
    }
  }
}

/** Feature asks with a structured column; anything else is answered from remarks or left unknown. */
function featureFit(feature: string, l: ListingFitFacts, prov: CriteriaProvenanceSource | null): Bucketed {
  const f = feature.toLowerCase()
  const ask = `Has ${f}`
  const item = (detail: string, source: FitSource): FitItem => ({ field: 'mustHaveFeatures', ask, detail, source, provenance: prov })
  if (/\bpool\b/.test(f) && typeof l.has_pool === 'boolean') {
    return l.has_pool ? { bucket: 'matches', item: item('The listing data shows a pool', 'listing') } : { bucket: 'misses', item: item('The listing data shows no pool', 'listing') }
  }
  if (l.features?.some((x) => x.toLowerCase().includes(f))) return { bucket: 'matches', item: item(`Listed feature: ${f}`, 'listing') }
  const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const hit = remarksMention(l.public_remarks, new RegExp(`\\b${esc}s?\\b`, 'i'))
  if (hit) return { bucket: 'matches', item: item(`The listing description mentions "${hit}"`, 'listing_remarks') }
  return { bucket: 'unknowns', item: item('Not in the listing data — not mentioned is not the same as missing, so ask before you rule it out', 'none') }
}

function dealBreakerFit(db: string, l: ListingFitFacts, prov: CriteriaProvenanceSource | null): Bucketed {
  const ask = `No ${db}`
  const item = (detail: string, source: FitSource): FitItem => ({ field: 'dealBreakers', ask, detail, source, provenance: prov })
  const type = (l.property_type ?? '').toLowerCase()
  switch (db) {
    case 'hoa':
      if (l.hoa_dues == null) return { bucket: 'unknowns', item: item('HOA dues are not in the listing data — confirm before you tour', 'none') }
      return l.hoa_dues > 0 ? { bucket: 'misses', item: item(`HOA dues listed at ${money(l.hoa_dues)}`, 'listing') } : { bucket: 'matches', item: item('The listing reports no HOA dues', 'listing') }
    case 'pool':
      if (typeof l.has_pool !== 'boolean') return { bucket: 'unknowns', item: item('The listing data does not say whether there is a pool', 'none') }
      return l.has_pool ? { bucket: 'misses', item: item('The listing data shows a pool', 'listing') } : { bucket: 'matches', item: item('The listing data shows no pool', 'listing') }
    case 'septic':
      if (typeof l.has_septic !== 'boolean') return { bucket: 'unknowns', item: item('Sewer vs septic is not in the listing data', 'none') }
      return l.has_septic ? { bucket: 'misses', item: item('The listing data shows a septic system', 'listing') } : { bucket: 'matches', item: item('The listing data shows no septic system', 'listing') }
    case 'condo':
    case 'townhouse':
      if (!type) return { bucket: 'unknowns', item: item('The property type is not in the listing data', 'none') }
      return type.includes(db) ? { bucket: 'misses', item: item(`It is a ${db}`, 'listing') } : { bucket: 'matches', item: item(`It is a ${formatPropertyType(type)}`, 'listing') }
    default:
      return { bucket: 'unknowns', item: item(`Whether it has ${db === 'busy road' ? 'a busy road out front' : `a ${db}`} isn't in the listing data`, 'none') }
  }
}

/**
 * PURE. How one listing lines up with the buyer's criteria — every ask lands in exactly one
 * bucket, and an ask the data cannot answer is an UNKNOWN with a plain sentence saying so.
 * Said asks are listed before inferred ones in each bucket.
 */
export function explainCriteriaFit(listing: ListingFitFacts, criteria: BuyerCriteria, evidence: HomeLocationEvidence | null = null): CriteriaFit {
  const fit: CriteriaFit = { matches: [], misses: [], unknowns: [], facts: [] }
  const add = (b: Bucketed) => (fit[b.bucket] ??= []).push(b.item)
  const p = (f: CriteriaField) => provenanceOf(criteria, f)
  const it = (bucket: keyof CriteriaFit, field: CriteriaField, ask: string, detail: string, source: FitSource) =>
    add({ bucket, item: { field, ask, detail, source, provenance: p(field) } })

  if (criteria.maxPrice != null) {
    const ask = `Under ${money(criteria.maxPrice)}`
    if (listing.price == null) it('unknowns', 'maxPrice', ask, "The price isn't listed", 'none')
    else if (listing.price <= criteria.maxPrice) it('matches', 'maxPrice', ask, `Listed at ${money(listing.price)}`, 'listing')
    else it('misses', 'maxPrice', ask, `Listed at ${money(listing.price)} — ${money(listing.price - criteria.maxPrice)} over your top number`, 'listing')
  }
  if (criteria.minPrice != null && listing.price != null && listing.price < criteria.minPrice) {
    it('misses', 'minPrice', `Over ${money(criteria.minPrice)}`, `Listed at ${money(listing.price)} — below the range you gave`, 'listing')
  }
  if (criteria.minBeds != null) {
    const ask = `${criteria.minBeds}+ bedrooms`
    if (listing.bedrooms == null) it('unknowns', 'minBeds', ask, "The bedroom count isn't listed", 'none')
    else if (listing.bedrooms >= criteria.minBeds) it('matches', 'minBeds', ask, `${listing.bedrooms} bedrooms`, 'listing')
    else it('misses', 'minBeds', ask, `${listing.bedrooms} bedrooms — you asked for ${criteria.minBeds}`, 'listing')
  }
  if (criteria.minBaths != null) {
    const ask = `${criteria.minBaths}+ bathrooms`
    if (listing.bathrooms == null) it('unknowns', 'minBaths', ask, "The bathroom count isn't listed", 'none')
    else if (listing.bathrooms >= criteria.minBaths) it('matches', 'minBaths', ask, `${listing.bathrooms} bathrooms`, 'listing')
    else it('misses', 'minBaths', ask, `${listing.bathrooms} bathrooms — you asked for ${criteria.minBaths}`, 'listing')
  }
  if (criteria.cities.length > 0 || criteria.zipCodes.length > 0) {
    const ask = `In ${[...criteria.cities, ...criteria.zipCodes].join(' / ')}`
    const field: CriteriaField = criteria.cities.length > 0 ? 'cities' : 'zipCodes'
    const cityHit = !!listing.city && criteria.cities.some((c) => c.toLowerCase() === listing.city!.toLowerCase())
    const zipHit = !!listing.zip && criteria.zipCodes.includes(listing.zip)
    if (cityHit || zipHit) it('matches', field, ask, `In ${cityHit ? listing.city : listing.zip}`, 'listing')
    else if (!listing.city && !listing.zip) it('unknowns', field, ask, "The location isn't in the listing data", 'none')
    else it('misses', field, ask, `In ${listing.city ?? listing.zip}`, 'listing')
  }
  if (criteria.propertyTypes.length > 0) {
    const ask = criteria.propertyTypes.map((t) => formatPropertyType(t)).join(' or ')
    if (!listing.property_type) it('unknowns', 'propertyTypes', ask, "The property type isn't listed", 'none')
    else if (criteria.propertyTypes.includes(listing.property_type)) it('matches', 'propertyTypes', ask, `A ${formatPropertyType(listing.property_type)}`, 'listing')
    else it('misses', 'propertyTypes', ask, `A ${formatPropertyType(listing.property_type)}`, 'listing')
  }
  for (const f of criteria.mustHaveFeatures) add(featureFit(f, listing, p('mustHaveFeatures')))
  for (const db of criteria.dealBreakers) add(dealBreakerFit(db, listing, p('dealBreakers')))
  for (const ask of criteria.lifestyle ?? []) add(lifestyleFit(ask, listing, p('lifestyle'), evidence))

  const rank = (i: FitItem) => (i.provenance === 'said' ? 0 : i.provenance === 'inferred' ? 1 : 2)
  for (const k of ['matches', 'misses', 'unknowns', 'facts'] as const) (fit[k] ??= []).sort((a, b) => rank(a) - rank(b))
  return fit
}

// ─── Validators for any explanation DRAFT (the model-written narration's gate) ──

/** PURE. Every number in a draft must appear in the facts it was given (no invented figures). */
export function numbersAreGrounded(text: string, facts: string): boolean {
  const norm = (s: string) => s.replace(/[$,]/g, '')
  const factText = norm(facts)
  for (const m of norm(text).matchAll(/\d+(?:\.\d+)?/g)) {
    if (!factText.includes(m[0])) return false
  }
  return true
}

/** Words that would restate an UNKNOWN ask as if the listing had answered it. */
const UNKNOWN_KIND_WORDS: Record<string, RegExp> = {
  'lifestyle:natural_light': /\b(light|bright|sunny|sun)\b/i,
  'lifestyle:commute': /\b(commute|drive time|minutes? (?:to|from))\b/i,
  'lifestyle:nearby_amenity': /\b(walk(?:able|ing)?|nearby|close to|near)\b/i,
  'lifestyle:quiet_setting': /\b(quiet|peaceful|traffic)\b/i,
  'lifestyle:outdoor_space': /\b(yard|lawn|garden)\b/i,
  'lifestyle:accessibility': /\b(accessible|step[- ]free|wheelchair)\b/i,
  'lifestyle:layout': /\b(open (?:floor ?plan|concept)|single[- ]level|one[- ]story)\b/i,
}

/** PURE. Does a draft speak to an ask the fit marked UNKNOWN? Returns that ask, or null. */
export function restatesUnknown(text: string, fit: CriteriaFit): string | null {
  for (const u of fit.unknowns) {
    const re = UNKNOWN_KIND_WORDS[u.field as string]
    if (re && re.test(text)) return u.ask
  }
  return null
}

/** Who the explanation speaks for (wave 148E): the tenant's brand and the buyer's agent — never invented. */
export interface NeighbourlyVoice {
  /** The buyer's agent's name as the brokerage holds it; absent → "your agent". */
  agentName?: string | null
  brokerageName?: string | null
  /** The source label (in-house · IDX/MLS · RentCast property data) — a RentCast home says so in the narrative. */
  source?: ListingSourceLabel | null
}

export interface NeighbourlyExplanation {
  headline: string
  narrative: string
  /** Code-authored, always present when the fit has unknowns. */
  unknownsSentence: string | null
  /** ONE gentle question drawn from a fixed list (never free text) — what would help the buyer next. */
  followUpQuestion: string
  /** The gentle offer to meet the agent — the explanation is the agent's first impression. */
  agentOffer: string
}

/** PURE. The one follow-up question, chosen from a FIXED list in the order that helps the buyer most. */
function chooseFollowUp(fit: CriteriaFit): string {
  const unknown = (k: string) => fit.unknowns.find((u) => u.field === `lifestyle:${k}`)
  const commute = unknown('commute')
  if (commute && /^Tell me where/.test(commute.detail)) return "Where's the commute to? Give me an address or a landmark and I'll map the drive for you."
  if (commute) return 'Would you like me to map the drive at the time you usually leave?'
  if (unknown('quiet_setting')) return 'Would you like me to look at how close the next homes sit and how near the busy roads run?'
  if (unknown('nearby_amenity')) return "Would you like me to map what's within an easy walk of the front door?"
  if ((fit.facts ?? []).some((f) => f.field === 'lifestyle:outdoor_space')) return "How much yard or land would feel right to you? Give me a size in acres or square feet and I'll check every home against your number."
  if (unknown('outdoor_space')) return 'Would you like me to ask for the lot survey so you can see exactly where the yard ends?'
  if (unknown('natural_light')) return 'Would you like me to ask the listing agent which rooms get the best light, and when?'
  if (fit.misses.length > 0) return `Is "${fit.misses[0].ask.toLowerCase()}" a deal-breaker for you, or could the rest make up for it?`
  return 'What would make this one a yes for you?'
}

/**
 * PURE. The explanation in the voice of a kind, knowledgeable neighbour who happens to be the best agent in town —
 * built ONLY from the fit, so it says nothing the data does not (owner: "a helping neighbor and more personable so
 * that they want to meet with an agent … It is about them."). It opens on what the buyer told us, gives the specific
 * figures (including a measured drive, the acres, the spacing, when evidence holds them), is honest about a miss in
 * one sentence, says when a home is RentCast property data rather than a verified listing, asks ONE gentle question,
 * and offers the agent without pressure. The unknowns sentence is ALWAYS present when there are unknowns.
 */
export function composeNeighbourlyExplanation(
  fit: CriteriaFit,
  listingLabel: string,
  voice: NeighbourlyVoice = {},
): NeighbourlyExplanation {
  const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)
  const agent = voice.agentName?.trim() || null
  const agentRef = agent ?? 'your agent'
  const said = fit.matches.filter((m) => m.provenance === 'said')
  const lead = (said.length ? said : fit.matches).slice(0, 3)
  const headline = fit.misses.length === 0 && fit.matches.length > 0
    ? `${listingLabel} lines up with what you asked for`
    : fit.matches.length > 0 ? `${listingLabel} fits part of your list` : `${listingLabel} only partly fits`
  const parts: string[] = []
  if (lead.length > 0) {
    const opener = fit.misses.length === 0 ? `I took a close look at ${listingLabel} for you, and it lines up with what you told me matters` : `I took a close look at ${listingLabel} for you — here's how it lines up with what you told me`
    parts.push(`${opener}: ${lead.map((m) => `${lower(m.ask)} — ${m.brief ?? lower(m.detail)}`).join('; ')}.`)
  } else {
    parts.push(`I looked at ${listingLabel} for you, but the listing data doesn't confirm any of what you asked for yet.`)
  }
  // The evidence-backed lifestyle answers the lead did not already say (a measured drive, the acres, the spacing).
  const extra = fit.matches.filter((m) => !lead.includes(m) && m.source === 'provider').slice(0, 2)
  const TOPIC: Record<string, string> = { 'lifestyle:commute': 'your commute', 'lifestyle:nearby_amenity': 'getting around on foot', 'lifestyle:quiet_setting': 'peace and quiet', 'lifestyle:outdoor_space': 'outdoor space' }
  for (const m of extra) parts.push(`Good to know for ${TOPIC[m.field as string] ?? lower(m.ask)}: ${m.brief ?? lower(m.detail)}.`)
  const lotFact = (fit.facts ?? []).find((f) => f.field === 'lifestyle:outdoor_space')
  if (lotFact) parts.push(`On the yard: this one sits on ${lotFact.brief ?? lower(lotFact.detail)}.`)
  if (fit.misses.length > 0) {
    const more = fit.misses.length - 1
    parts.push(`One honest heads-up: ${fit.misses[0].brief ?? lower(fit.misses[0].detail)}${more > 0 ? `, and ${more} more ${more === 1 ? "thing doesn't" : "things don't"} line up` : ''}.`)
  }
  if (voice.source && !voice.source.verified_active_listing) {
    parts.push(`This one comes from RentCast property data rather than a verified active listing, so ${agentRef} will confirm it's truly available before you plan a visit.`)
  }
  const unknownsSentence = fit.unknowns.length > 0
    ? `What I can't tell you yet from the listing: ${fit.unknowns.map((u) => lower(u.ask)).join(', ')}. ${agent ? `${agent} can find out` : 'Your agent can find out'}, or you'll see it for yourself in person.`
    : null
  const agentOffer = fit.matches.length > 0
    ? `If it feels promising, ${agentRef} would be glad to show it to you in person and answer what a listing can't — just say the word and I'll set up a time.`
    : `${agent ?? 'Your agent'} would be happy to talk it through with you before you decide whether it's worth a visit — just say the word.`
  return { headline, narrative: parts.join(' '), unknownsSentence, followUpQuestion: chooseFollowUp(fit), agentOffer }
}

/** PURE. The whole buyer-facing explanation as one text (narrative · unknowns · question · offer) — what the rubric reads. */
export function fullExplanationText(e: Pick<NeighbourlyExplanation, 'narrative' | 'unknownsSentence' | 'followUpQuestion' | 'agentOffer'>): string {
  return [e.narrative, e.unknownsSentence, e.followUpQuestion, e.agentOffer].filter(Boolean).join(' ')
}
