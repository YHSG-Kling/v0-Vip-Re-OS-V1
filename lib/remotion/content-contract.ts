// lib/remotion/content-contract.ts
// ─────────────────────────────────────────────────────────────────────────────
// NO DEMO DATA REACHES A CLIENT.
//
// THE DEFECT THIS CLOSES. Remotion MERGES inputProps over a composition's
// defaultProps. Every composition in remotion/Root.tsx declares defaultProps so
// the Studio preview renders, and those defaults are plausible-looking sample
// data: address "123 Main Street", estimatedValue 600000, a five-star quote
// from "Jamie, Brickell", a market update for "Brickell" at "$675K". A producer
// that stages input_props WITHOUT a composition's content props therefore does
// not render a blank video — it renders a CONFIDENT, WRONG one, and the render
// reports success.
//
// That is exactly what the Video Director did. commissionVideo stages a FIXED
// prop set — intro, outro, qrCodeDataUrl, qrCaption, mlsClean, music_mood,
// brollClips — for EVERY situation kind, whatever composition the format
// resolved to. The equity trigger hands the Director real numbers
// (estimatedValue, purchasePrice, appreciation, appreciationPct,
// estimatedEquity, all RentCast-backed); the Director reads them ONLY to feed
// the hook copy's fact list and drops them on the floor. A past client then
// receives a video reporting the equity in a home they own, using $600,000 and
// $500,000, because those are the Studio preview numbers.
//
// ── WHY A CONTRACT AND NOT "JUST THREAD THE PROPS" ──────────────────────────
// Threading the props fixes today's producers. It does not stop tomorrow's: the
// failure is SILENT and looks like success, so nothing surfaces the next
// producer that forgets, or the next composition that adds a content prop no
// producer knows about. A prop that must be supplied is a fact about the
// composition, so it is declared next to the composition and CHECKED — the same
// move the render cache made for geometry (scripts/remotion-setup-guard.ts).
//
// ── WHY NOT BLANK THE defaultProps INSTEAD ──────────────────────────────────
// Deleting the sample data looks like the most literal reading of "there should
// not be demo data", and it is the worse one: a producer that forgets a prop
// would then ship a BLANK video to the client instead of a wrong one, and a
// blank video still gets delivered. Refusal is the only outcome that cannot
// mislead anybody. The sample data stays where it belongs — a Studio fixture
// that this contract makes UNREACHABLE on a real render. What did get deleted
// is the sample data with no preview value and real potential to be believed:
// the fabricated agent phone numbers and licence lines on the print pieces.
//
// ── WHERE IT IS ENFORCED ────────────────────────────────────────────────────
//   · commissionVideo (staging)  — refuse early, so a manager sees WHY and no
//                                  queue row, QR, or render spend is created.
//   · render-composition (render) — the backstop every other producer path also
//                                  passes through. Cancelled, not failed:
//                                  nothing broke, the render was not renderable.
//
// PURE — no I/O, no DB, no Remotion import. Safe for guards and simulators.

/**
 * What a composition must be TOLD before it can make a claim.
 *
 * `required` — props whose defaultProps value is a factual assertion about a
 *   real property, person, market or relationship. Unsupplied, the composition
 *   states the sample value as fact.
 * `cosmetic` — props that also carry a default value, declared here so the
 *   guard can prove EVERY valued prop was classified deliberately. A prop
 *   missing from both lists fails test:content-contract; there is no third,
 *   silent category.
 */
export interface CompositionContentContract {
  required: string[]
  cosmetic: string[]
  /** Why these props are the claims. Read by the next person to add one. */
  why: string
}

/** Generic chrome shared by nearly every composition — never a claim. */
const CHROME = ["ctaLabel", "brand", "qrCodeDataUrl", "qrCaption", "mlsClean"]

export const CONTENT_CONTRACT: Record<string, CompositionContentContract> = {
  // ── Listing reels ────────────────────────────────────────────────────────
  JustListedReel: {
    required: ["hook", "address", "cityState", "price", "bedrooms", "bathrooms", "sqft"],
    cosmetic: [...CHROME],
    why:
      "Every one of these is printed on screen as a fact about a home a buyer " +
      "can go and look at. `hook` is required because the default reads 'Just " +
      "Listed' and the same composition serves the price_drop situation — an " +
      "unsupplied hook labels a reduction as a new listing.",
  },
  JustListedReelSquare: {
    required: ["hook", "address", "cityState", "price", "bedrooms", "bathrooms", "sqft"],
    cosmetic: [...CHROME],
    why: "Square cut of JustListedReel; identical claims.",
  },
  JustListedReelHorizontal: {
    required: ["hook", "address", "cityState", "price", "bedrooms", "bathrooms", "sqft"],
    cosmetic: [...CHROME],
    why: "16:9 cut of JustListedReel; identical claims.",
  },
  JustSoldReelSquare: {
    required: ["address", "cityState", "soldPrice", "listPrice", "daysOnMarket"],
    cosmetic: [...CHROME],
    why:
      "A sold price and days-on-market are the agent's public track record. " +
      "The defaults claim a sale above asking in seven days.",
  },
  PhotoWalkthroughReel: {
    required: ["hook", "address", "cityState"],
    cosmetic: [...CHROME, "voiceoverUrl"],
    why:
      "The tour is over the listing's own photos, which arrive as imageUrls " +
      "(empty default → the honest no-photos card). The address named over " +
      "them must be the address those photos are of.",
  },
  ComingSoonReel: {
    required: ["address", "cityState", "teaser", "whenString", "agentName"],
    cosmetic: [...CHROME],
    why: "A teaser and a date the viewer is invited to plan around.",
  },
  OpenHouseAnnounceReel: {
    required: ["address", "cityState", "dateLabel", "timeLabel", "bodyLine", "agentName", "agentPhone"],
    cosmetic: [...CHROME],
    why:
      "The single worst default in the library to ship: a wrong date and time " +
      "sends a buyer to a house on a day nobody will be there.",
  },

  // ── Data reels ───────────────────────────────────────────────────────────
  MarketUpdateReel: {
    required: ["areaName", "period", "stats", "agentName", "agentPhone"],
    cosmetic: [...CHROME],
    why:
      "Three stat cards quoting a median price, a days-on-market and an " +
      "inventory count for a named area and a named month. Unsupplied, the " +
      "video reports Brickell's sample figures for whatever market it was " +
      "commissioned about.",
  },
  CMAReel: {
    required: ["subjectAddress", "areaName", "priceTrend", "comps", "daysOnMarket", "affordability"],
    cosmetic: [...CHROME],
    why:
      "A comparative market analysis IS its data. Every chart here is a " +
      "valuation input a seller prices their home on.",
  },
  AffordabilitySnapshotReel: {
    required: ["monthlyHeadline", "areaName", "period", "examples", "ratesAssumption", "agentName", "agentPhone"],
    cosmetic: [...CHROME],
    why:
      "Three real homes at real prices against a stated monthly payment. " +
      "`ratesAssumption` is required because it is the disclosure that makes " +
      "the payment honest — a stale assumption line understates the payment.",
  },
  EquityReportReel: {
    required: [
      "agentName", "address", "estimatedValue", "purchasePrice",
      "appreciation", "appreciationPct", "estimatedEquity", "yearsHeld",
    ],
    cosmetic: [...CHROME, "brandColors"],
    why:
      "THE PROVEN CASE. equity-trigger resolves these from a RentCast AVM and " +
      "the closed transaction's basis price, hands all five to the Director, " +
      "and the Director staged none of them — so a past client received their " +
      "home's equity reported as $600,000 against $500,000 paid. A financial " +
      "claim about a specific person's largest asset.",
  },
  ExplainerAnimReel: {
    required: ["title", "caption", "hasData", "diagram", "agentName"],
    cosmetic: [...CHROME, "eyebrow"],
    why:
      "`diagram` is the animation's entire data set and `hasData` is the flag " +
      "that decides between the chart and the honest 'share your numbers' " +
      "fallback — defaulted true, it asserts data the caller never gave. " +
      "`caption` carries the rate and appreciation assumptions.",
  },

  // ── People reels ─────────────────────────────────────────────────────────
  AgentTalkingHeadReel: {
    required: ["hook", "agentName", "caption"],
    cosmetic: [...CHROME],
    why: "The caption is the sentence on screen while the agent's avatar speaks.",
  },
  AgentExplainerReel: {
    required: ["title", "bullets", "agentName"],
    cosmetic: [...CHROME, "eyebrow"],
    why: "Three bullets of advice attributed to a named agent.",
  },
  TeammateExplainerReel: {
    required: ["title", "agentName"],
    cosmetic: [...CHROME, "eyebrow"],
    why: "Full-frame avatar explainer; the title is the claim it teaches.",
  },
  TestimonialReel: {
    required: ["quote", "clientName", "clientRole", "closingLabel", "stars", "agentName"],
    cosmetic: [...CHROME],
    why:
      "A FABRICATED ENDORSEMENT is not a cosmetic default. The producer " +
      "(video-plays) already reads a real review row and passes quote + " +
      "reviewerName; unsupplied, the reel publishes a five-star review from " +
      "'Jamie, Brickell' who does not exist, attributed to a real agent.",
  },
  NeighborhoodSpotlightReel: {
    required: ["neighborhood", "tagline", "highlights", "agentName", "agentPhone"],
    cosmetic: [...CHROME],
    why: "A median price and walk score quoted for a named neighborhood.",
  },

  // ── Presentation slides ──────────────────────────────────────────────────
  ListingPresentationSlide: {
    required: ["title", "body", "agentName"],
    cosmetic: [...CHROME, "kind", "slideNumber", "totalSlides", "avatarEndFrame"],
    why:
      "Slide structure (kind/number/total/avatar window) is set by the " +
      "composer at chain time and is not a claim; the copy on the slide is.",
  },
  BuyerConsultationSlide: {
    required: ["title", "body", "agentName"],
    cosmetic: [...CHROME, "kind", "slideNumber", "totalSlides", "avatarEndFrame"],
    why: "Buyer-side twin of ListingPresentationSlide.",
  },
  ListingSectionReel: {
    required: ["title", "bullets", "agentName"],
    cosmetic: [...CHROME, "sectionKey", "slideNumber", "totalSlides", "voiceoverUrl"],
    why: "One narrated pre-listing section; the bullets are the pitch.",
  },
  PartnersMeetingReel: {
    required: ["weekLabel", "cards", "oneAsk", "agentName"],
    cosmetic: [...CHROME],
    why:
      "The AI team's weekly recap to leadership. The cards are earned counts — " +
      "deals closed, commission booked, compliance catches. Defaulted, the " +
      "show reports a fictional week to the people who run the brokerage.",
  },

  // ── Stills: print, social, share cards ───────────────────────────────────
  ListingFlyer: {
    required: [
      "address", "cityState", "price", "beds", "baths", "sqft",
      "propertyType", "highlights", "agentName", "agentPhone", "statusLine",
    ],
    cosmetic: [...CHROME],
    why:
      "A print piece handed to strangers at an open house. `statusLine` is " +
      "required because the default reads JUST LISTED over whatever the " +
      "listing's real lifecycle stage is.",
  },
  DoorHanger: {
    required: ["headline", "address", "cityState", "hook", "agentName", "agentPhone"],
    cosmetic: [...CHROME],
    why:
      "Hung on a stranger's door claiming a nearby sale. A wrong address on " +
      "this piece is a claim about a neighbour's home.",
  },
  CarouselSlide: {
    required: ["kicker", "title", "body", "agentName"],
    cosmetic: [...CHROME, "role", "slideCount", "handleLine"],
    why: "Slide role and count are structure; the kicker/title/body are the post.",
  },
  VideoCoverThumb: {
    required: ["title", "subtitle", "agentName", "seoHint"],
    cosmetic: [...CHROME, "kind", "eyebrow"],
    why:
      "The share card AND the text an AI search engine reads to describe a " +
      "video it cannot watch. A defaulted seoHint feeds a fabricated summary " +
      "to the exact surface the GEO work is trying to win.",
  },
  LeadMagnetCard: {
    required: ["headline", "subhead"],
    cosmetic: [...CHROME, "eyebrow"],
    why: "The offer a lead hands over their contact details for.",
  },
  NewsletterDigestVideo: {
    required: ["subject", "marketBeat", "sectionTitles"],
    cosmetic: [...CHROME],
    why: "`marketBeat` quotes a month-over-month median move as fact.",
  },
  NewsletterDigestThumb: {
    required: ["subject", "personaHook", "agentName"],
    cosmetic: [...CHROME],
    why: "The inbox preview a recipient decides to open on.",
  },
  PostcardFront4x6: {
    required: ["headline", "body"],
    cosmetic: [...CHROME, "cta"],
    why:
      "Mailed. The default body claims homes on the recipient's street sold " +
      "in eleven days last month.",
  },
  PostcardBack4x6: {
    required: ["body", "agentName"],
    cosmetic: [...CHROME, "signoff"],
    why:
      "Back side of the same mailed piece, and the side that carries the body " +
      "copy — the front's headline is the hook, this is the claim.",
  },
  PostcardFront6x9: {
    required: ["headline", "body", "statusBadge"],
    cosmetic: [...CHROME, "cta"],
    why: "The default invites the recipient to an open house at a made-up address.",
  },
  PostcardBack6x9: {
    required: ["body", "pullQuote", "agentName"],
    cosmetic: [...CHROME, "signoff"],
    why:
      "Back side of the 6x9 piece. The pull quote is presented as something a " +
      "real person said, which is the same fabrication risk as a testimonial.",
  },

  // ── The one composition whose defaults are REAL copy ─────────────────────
  ProductPromoReel: {
    required: [],
    cosmetic: [...CHROME, "hook", "proofs", "cta", "ctaDomain"],
    why:
      "PLATFORM self-marketing (tier_access = {platform}). Its defaults are " +
      "not sample data standing in for a tenant's facts — they are the " +
      "product's own approved marketing copy, about the product, sourced from " +
      "PRODUCT_ANGLES. Nothing here is a claim about a tenant's property, " +
      "client or market, so there is nothing for a producer to supply.",
  },
}

/**
 * Is a staged value ACTUALLY supplied?
 *
 * Strict on purpose. `""`, `[]` and null all mean the producer had nothing to
 * say, and Remotion treats undefined as absent and falls straight back to the
 * default — so anything short of real content must count as missing, or the
 * contract would be satisfiable by staging blanks.
 *
 * `0` and `false` ARE supplied: a zero appreciation and a hasData:false are
 * both real, deliberate answers.
 */
export function isSupplied(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === "string") return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === "object") return Object.keys(value as object).length > 0
  return true
}

/** The contract for a composition, or null when it declares none. */
export function contentContract(compositionId: string): CompositionContentContract | null {
  return CONTENT_CONTRACT[compositionId] ?? null
}

/**
 * The required content props this props payload does NOT supply.
 *
 * An UNKNOWN composition returns [] rather than throwing: a composition that
 * has not been classified yet is caught by test:content-contract at build time,
 * and refusing every render of it at runtime would turn a missing declaration
 * into an outage.
 */
export function missingContentProps(
  compositionId: string,
  props: Record<string, unknown> | null | undefined,
): string[] {
  const contract = CONTENT_CONTRACT[compositionId]
  if (!contract) return []
  const p = props ?? {}
  return contract.required.filter((k) => !isSupplied(p[k]))
}

/** Would this render state something the caller never supplied? */
export function wouldRenderDemoData(
  compositionId: string,
  props: Record<string, unknown> | null | undefined,
): boolean {
  return missingContentProps(compositionId, props).length > 0
}

/** The sentence a manager reads on the refusal. Names the props, never guesses why. */
export function describeMissingContent(compositionId: string, missing: string[]): string {
  if (missing.length === 0) return ""
  const list = missing.slice(0, 6).join(", ")
  const more = missing.length > 6 ? `, and ${missing.length - 6} more` : ""
  return (
    `${compositionId} was not given ${missing.length} content prop${missing.length === 1 ? "" : "s"} ` +
    `it states as fact (${list}${more}). Rendering it would publish the composition's ` +
    `preview sample data as if it were this client's, so the render was refused.`
  )
}

/** The error string stamped on a refused render row. Machine-readable prefix. */
export const CONTENT_CONTRACT_ERROR_PREFIX = "content_props_missing:"

export function contentContractError(missing: string[]): string {
  return `${CONTENT_CONTRACT_ERROR_PREFIX}${missing.join(",")}`.slice(0, 800)
}
