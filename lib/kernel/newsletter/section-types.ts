/**
 * lib/kernel/newsletter/section-types.ts
 *
 * CANONICAL newsletter section taxonomy. This file is the single source of
 * truth for what section TYPES exist across the platform. The 4 historical
 * vocabularies (Track A, Insider Edit, Template Builder, Legacy AI Writer)
 * all map into this taxonomy:
 *
 *   Track A           "intro|market_update|tips|listings|community|cta"
 *   Insider Edit      "hook|events|civic|deal|eats"
 *   Template Builder  "real_estate_tip|market_update|local_news|agent_feature|property_highlight"
 *   Legacy AI Writer  "hero|featured_listings|market_update|tips|testimonial|cta|custom"
 *
 *   →                 "agent_intro|market_update|new_listings|property_highlight|
 *                      local_news|local_event|neighborhood_spotlight|mortgage_rates|
 *                      tips|testimonial|community_eats|cta|custom"
 *
 * Generators write the canonical key into newsletter_sections.section_type
 * (m117 added the column + check constraint). The assembler uses the type for
 * (a) default ordering when order_index is unset, (b) rendering hints, and
 * (c) display labels in the Marketing Studio newsletter tab.
 */

export type NewsletterSectionType =
  | "agent_intro"
  | "market_update"
  | "new_listings"
  | "property_highlight"
  | "local_news"
  | "local_event"
  | "neighborhood_spotlight"
  | "mortgage_rates"
  | "tips"
  | "testimonial"
  | "community_eats"
  | "cta"
  | "custom"

export interface NewsletterSectionTypeDef {
  /** Canonical snake_case key — written into newsletter_sections.section_type. */
  key:           NewsletterSectionType
  /** UI display label — shown in the Marketing Studio newsletter tab. */
  label:         string
  /** Short description for the section's purpose (helper text). */
  description:   string
  /** Default sort weight for assembly when order_index is NULL on a row.
   *  Lower number = higher up in the rendered newsletter. */
  defaultOrder:  number
  /** Aliases — older string keys the generators may still write. The publisher
   *  normalizes these to the canonical key before persisting. */
  aliases:       string[]
  /** When true, the generator should pass the contact's contact_persona to
   *  the AI prompt so the copy lands in-register. */
  personaAware:  boolean
}

export const NEWSLETTER_SECTION_TYPES: Record<NewsletterSectionType, NewsletterSectionTypeDef> = {
  agent_intro: {
    key:           "agent_intro",
    label:         "Agent Intro",
    description:   "Opening note from the agent — sets the tone, frames the issue.",
    defaultOrder:  10,
    aliases:       ["intro", "hero", "agent_feature", "hook"],
    personaAware:  true,
  },
  market_update: {
    key:           "market_update",
    label:         "Market Update",
    description:   "Local market trends, stats, and what they mean for the recipient.",
    defaultOrder:  20,
    aliases:       ["market_trends", "market_stats"],
    personaAware:  true,
  },
  new_listings: {
    key:           "new_listings",
    label:         "New Listings",
    description:   "New on-market properties this issue. Persona-filtered: investors see investment-friendly listings, first-time buyers see starter homes.",
    defaultOrder:  30,
    aliases:       ["listings", "featured_listings"],
    personaAware:  true,
  },
  property_highlight: {
    key:           "property_highlight",
    label:         "Property Highlight",
    description:   "Single featured property — usually a flagship listing or an off-market opportunity.",
    defaultOrder:  35,
    aliases:       ["deal", "property_feature"],
    personaAware:  false,
  },
  local_news: {
    key:           "local_news",
    label:         "Local News",
    description:   "Community / neighborhood news — schools, infrastructure, civic updates.",
    defaultOrder:  40,
    aliases:       ["community"],
    personaAware:  false,
  },
  local_event: {
    key:           "local_event",
    label:         "Local Events",
    description:   "Curated upcoming events — open houses, farmer's markets, civic meetings.",
    defaultOrder:  45,
    aliases:       ["events"],
    personaAware:  false,
  },
  neighborhood_spotlight: {
    key:           "neighborhood_spotlight",
    label:         "Neighborhood Spotlight",
    description:   "Deep-dive on one neighborhood — development watch, zoning, amenities, comps.",
    defaultOrder:  50,
    aliases:       ["civic", "development_watch"],
    personaAware:  false,
  },
  mortgage_rates: {
    key:           "mortgage_rates",
    label:         "Mortgage Rates",
    description:   "Current rate update + what it means for borrowing power. Carries TRID-aware language.",
    defaultOrder:  55,
    aliases:       ["rates", "interest_rate_update"],
    personaAware:  true,
  },
  tips: {
    key:           "tips",
    label:         "Tips",
    description:   "Actionable advice — buyer prep, seller prep, homeownership how-to.",
    defaultOrder:  60,
    aliases:       ["real_estate_tip", "tip"],
    personaAware:  true,
  },
  testimonial: {
    key:           "testimonial",
    label:         "Client Testimonial",
    description:   "Quote / story from a past client — third-party social proof.",
    defaultOrder:  70,
    aliases:       [],
    personaAware:  false,
  },
  community_eats: {
    key:           "community_eats",
    label:         "Community & Eats",
    description:   "Local restaurant or café recommendation — lifestyle anchor.",
    defaultOrder:  80,
    aliases:       ["eats"],
    personaAware:  false,
  },
  cta: {
    key:           "cta",
    label:         "Call to Action",
    description:   "Single clear ask — book a consult, request a CMA, schedule a tour.",
    defaultOrder:  90,
    aliases:       [],
    personaAware:  true,
  },
  custom: {
    key:           "custom",
    label:         "Custom",
    description:   "Free-form section the generator could not classify. Renders by order_index alone.",
    defaultOrder:  100,
    aliases:       [],
    personaAware:  false,
  },
}

export const ALL_SECTION_TYPES: NewsletterSectionTypeDef[] =
  Object.values(NEWSLETTER_SECTION_TYPES)

/**
 * Normalize any historical / alias key to the canonical NewsletterSectionType.
 * Returns "custom" for unrecognized input — never throws, since the publisher
 * is best-effort and an unknown section type shouldn't block a send.
 */
export function normalizeSectionType(input: string | null | undefined): NewsletterSectionType {
  if (!input) return "custom"
  const lower = input.toLowerCase().trim()
  if (lower in NEWSLETTER_SECTION_TYPES) return lower as NewsletterSectionType
  for (const def of ALL_SECTION_TYPES) {
    if (def.aliases.includes(lower)) return def.key
  }
  return "custom"
}

export function defaultOrderFor(type: string | null | undefined): number {
  return NEWSLETTER_SECTION_TYPES[normalizeSectionType(type)].defaultOrder
}

export function displayLabelFor(type: string | null | undefined): string {
  return NEWSLETTER_SECTION_TYPES[normalizeSectionType(type)].label
}
