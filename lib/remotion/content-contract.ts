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
      "valuation input a seller prices their home on. `daysOnMarket` is a " +
      "{values, labels} pair and the builder emits it EMPTY-BUT-SHAPED when no " +
      "comp reports a figure; isSupplied reads a container of empties as " +
      "unsupplied, so that case is refused rather than drawn as a bar chart " +
      "with no bars.",
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
    required: ["body", "agentName", "optOutLine"],
    cosmetic: [...CHROME, "signoff", "optOutQrDataUrl"],
    why:
      "Back side of the same mailed piece, and the side that carries the body " +
      "copy — the front's headline is the hook, this is the claim. " +
      "`optOutLine` is REQUIRED for a reason the other entries do not cover: it " +
      "is not a claim that could be WRONG, it is the piece's only route back to " +
      "the sender, and its default is null precisely so nothing plausible can be " +
      "printed in its place. A postcard mailed without it is a solicitation the " +
      "recipient has no way to stop — the defect the owner ruled on — and a " +
      "postcard mailed with a SHARED or stale token is worse, because scanning " +
      "it suppresses a stranger. Required means both outcomes are a refusable " +
      "render instead of a silent one. `optOutQrDataUrl` is COSMETIC on purpose " +
      "and the asymmetry is the whole design: the printed line is what makes the " +
      "opt-out readable, typeable and legitimate, while the QR only removes the " +
      "friction of 49 characters — so a failed QR encode must degrade the card, " +
      "never cancel a legitimate send. The QR here is NOT the campaign's " +
      "`qrCodeDataUrl` (chrome, front panel, one qr_codes slug shared by every " +
      "recipient); it encodes this recipient's own /unsubscribe/<token> URL and " +
      "never touches the qr_codes table.",
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
 *
 * A CONTAINER OF NOTHING SAYS NOTHING (2026-09-02). An object or array is
 * supplied only if at least one of its members is. The shape that proved it:
 * lib/charts/cma-reel-data.ts builds `daysOnMarket: { values: [], labels: [] }`
 * when no comparable reports a days-on-market figure. Two keys, so the old
 * rule (non-empty object ⇒ supplied) accepted it, and CMAReel then rendered
 * remotion/charts/DaysOnMarketBars over an empty series — `Math.min(...[])` is
 * Infinity, `verticalBars([])` maps nothing, and the seller received a
 * "days on market" panel with no bars in it and no honest empty state (the
 * composition has none; the chart is unconditional at remotion/CMAReel.tsx:95).
 * The same rule catches `[{}]`, `[""]`, `{ values: [] }` and every other
 * container a producer can build by mapping over an empty result set. `{ a: 0 }`
 * and `{ hasData: false }` stay supplied because their members are.
 */
export function isSupplied(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === "string") return value.trim().length > 0
  if (Array.isArray(value)) return value.some(isSupplied)
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).some(isSupplied)
  return true
}

// TOMBSTONE (orphan burn-down, lane E): `contentContract(compositionId)` deleted.
// A one-line accessor over CONTENT_CONTRACT with zero callers. Both real
// consumers reach the table directly and more completely:
//   · scripts/content-contract-guard.ts:128 iterates CONTENT_CONTRACT itself —
//     it has to, since it proves EVERY composition is classified, which a
//     per-id lookup cannot express.
//   · the runtime enforcement path never wants the contract object at all, only
//     the answer: lib/video/video-director.ts:1084 calls missingContentProps
//     (:346 below), which does the same lookup internally and returns the prop
//     NAMES the refusal sentence needs.
// Nothing merged: the accessor's only distinct behaviour was `?? null`, and
// missingContentProps already encodes the same "unknown composition is not an
// outage" ruling (see its header).

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

// TOMBSTONE (orphan burn-down, lane E): `wouldRenderDemoData(id, props)` deleted.
// It was literally `missingContentProps(id, props).length > 0` with zero callers.
// The survivor is missingContentProps (:346 above), and the boolean form is the
// WEAKER shape for the one job this module exists to do: both enforcement sites
// need the prop NAMES, not a yes/no, because the refusal has to say WHICH claims
// were never supplied —
//   · lib/video/video-director.ts:1083-1089 (staging refusal, feeds
//     describeMissingContent so the manager reads why)
//   · app/api/internal/remotion/render-composition — the render backstop, which
//     stamps contentContractError(missing) on the cancelled row.
// A caller that only wants the boolean writes `.length > 0` at the call site and
// still has the names when it turns out it needs them.

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

// ─────────────────────────────────────────────────────────────────────────────
// THE VOICEOVER CENSUS — which compositions PLAY `input_props.voiceoverUrl`.
//
// ONE FACT, WHICH HAD TWO SPELLINGS (§6, measured 2026-09-03):
//
//   · this set, formerly private to lib/video/avatar-render-orchestrator.ts
//     (VOICEOVER_CONSUMING_COMPOSITIONS, 14 members) — byte-identical to the
//     compositions under remotion/ that render `<Audio src={…voiceoverUrl}>`;
//   · the live column `remotion_compositions.requires_voiceover`, true for a
//     DIFFERENT nine (AgentExplainerReel, AgentTalkingHeadReel,
//     BuyerConsultationSlide, EquityReportReel, ExplainerAnimReel,
//     JustListedReelHorizontal, ListingPresentationSlide, MarketUpdateReel,
//     NeighborhoodSpotlightReel) — a hand-seeded m168 guess that fed
//     `used_voiceover` on every asset-manager and coordinator render row. Under
//     it a ListingPresentationSlide render with no audio at all was ledgered as
//     narrated, and a JustListedReel that carried its narration IN FRAME was
//     ledgered as silent.
//
// THE MEANING CHOSEN IS THE MEASURABLE ONE: a composition "consumes a
// voiceover" iff its remotion/ entry renders `<Audio src={voiceoverUrl}>`.
// That is provable in CI with no database — scripts/remotion-setup-guard.ts §5
// proves every DECLARATION of the prop has such a reader, and
// scripts/content-contract-guard.ts §15 derives the reader set from remotion/**
// (comment-stripped) and asserts it equals THIS set. The live column is a
// MIRROR of this set as of m601 (supabase/migrations/m601-…), the way
// COMPOSITION_GEOMETRY mirrors the live geometry in the other direction; §15
// compares the two whenever SUPABASE_SERVICE_ROLE_KEY is present and SAYS IT
// SKIPPED otherwise. Code that DECIDES anything reads this set; the column is
// read only by callers that already hold a live row (a cost estimate, a badge).
//
// WHY HERE. This module is the one pure, DB-free description of what each
// composition's props MEAN, already imported by every producer that stages a
// render and by the guard that proves it. A composition that plays the prop is
// a fact of the same kind as "this prop is a claim".
//
// WHAT THE SET DOES NOT SAY. `voiceover_url` (snake) is a FINISH key: the
// render coordinator muxes it under any composition after the frames are
// rendered. A composition absent here can still ship narrated through that
// channel — and the coordinator flips `used_voiceover` to true when the mux
// lands. This set answers only the in-frame question.
//
// Source: grep '<Audio' remotion/ for src={…voiceoverUrl} (2026-09-01,
// re-measured 2026-09-03). A new consumer is added HERE and nowhere else.
// ─────────────────────────────────────────────────────────────────────────────
export const VOICEOVER_CONSUMING_COMPOSITIONS: ReadonlySet<string> = new Set<string>([
  "AffordabilitySnapshotReel",
  "AgentTalkingHeadReel",
  "CMAReel",
  "ComingSoonReel",
  "JustListedReel",
  "JustListedReelHorizontal",
  "JustListedReelSquare",
  "JustSoldReelSquare",
  "ListingSectionReel",
  "NeighborhoodSpotlightReel",
  "NewsletterDigestVideo",
  "OpenHouseAnnounceReel",
  "PhotoWalkthroughReel",
  "TestimonialReel",
])

/** Does this composition render `<Audio src={voiceoverUrl}>`? PURE. */
export function consumesVoiceover(compositionId: string | null | undefined): boolean {
  return !!compositionId && VOICEOVER_CONSUMING_COMPOSITIONS.has(compositionId)
}

/**
 * Will THIS render play an in-frame voiceover? — the composition consumes the
 * prop AND the staged props actually carry one. This is the honest initial
 * value of `remotion_composition_renders.used_voiceover`: a fact about the
 * render, not about the composition. The coordinator may still flip it to true
 * later when a snake-key `voiceover_url` finish mux lands. PURE.
 */
export function stagesVoiceover(
  compositionId: string | null | undefined,
  props: Record<string, unknown> | null | undefined,
): boolean {
  return consumesVoiceover(compositionId) && isSupplied(props?.voiceoverUrl)
}
