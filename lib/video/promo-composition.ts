/**
 * lib/video/promo-composition.ts
 *
 * PURE composition router + per-composition prop builder for the
 * listing-promo Remotion render path
 * (app/api/internal/remotion/render-just-listed/route.ts).
 *
 * THE DRIFT THIS FIXES
 * --------------------
 * render-just-listed hardcoded `selectComposition(id="JustListedReel")`
 * for EVERY listing_promo_videos.event_type. A `just_sold`, `open_house_*`,
 * or `coming_soon` promo therefore rendered with the wrong composition +
 * the wrong prop shape (a "Just Listed" cover frame, a "DM me to tour" CTA,
 * fact cards instead of a SOLD price / open-house headline / coming-soon
 * teaser). This module routes the composition choice deliberately and
 * builds the REQUIRED props for the chosen composition.
 *
 * IT CONSUMES (read-only) the Video Director's SituationKind taxonomy
 * (lib/video/video-director.ts selectVideoFormat) — it does NOT edit it.
 * The map below pins each listing-promo event_type to a SituationKind and
 * the concrete composition the render endpoint feeds Remotion.
 *
 * THE just_listed CUT DECISION — legacy JustListedReel vs the Director's Square
 * -----------------------------------------------------------------------------
 * The Director maps new_listing → JustListedReelSquare (12s, 1080×1080, no
 * fact cards) because that is the W40 PAID-AD cut. The render-just-listed
 * route renders the ORGANIC reel: a 25s 1080×1920 vertical piece that the
 * Wave-14 HYBRID pipeline stitches D-ID intro/outro bookends onto
 * (listing-promo-hybrid-composite) and that the social-publish cron pushes
 * to TikTok / IG Reels / YT Shorts / Pinterest — all 9:16 organic surfaces.
 * The Square cut has no fact-card section and a 12s budget tuned for muted
 * paid feed; swapping the organic path to it would REGRESS the organic
 * deliverable. So we KEEP the legacy JustListedReel (vertical, 25s) for the
 * just_listed organic feed path the route owns, and only re-route the events
 * whose composition was genuinely WRONG (just_sold / open_house / coming_soon).
 * price_reduction / under_contract also stay on the legacy vertical reel —
 * there is no dedicated organic composition for them and their distinct
 * intent is carried by the per-event narration script (listing-promo-reactor
 * TEMPLATES), not a separate composition.
 */
import type { SituationKind } from "@/lib/video/video-director"
import { compositionSeconds, geometryFor } from "@/lib/remotion/composition-geometry"
import { narrationBudget, type NarrationBudget } from "@/lib/video/script-structure"
import { publicPriceEventLabel } from "@/lib/listings/price-improvement-label"

// The full listing-promo event_type set (lib/kernel/lifecycle-promo-policy
// LifecycleEventType). Mirrored here as a literal union so the mapper is
// exhaustively checked at compile time even though the reactor's type lives
// in a server-only module.
export type PromoEventType =
  | "coming_soon"
  | "just_listed"
  | "open_house_announce"
  | "open_house_reminder"
  | "price_reduction"
  | "under_contract"
  | "just_sold"

/** The compositions the listing-promo render path can target. */
export type PromoCompositionId =
  | "JustListedReel"        // legacy vertical 9:16 25s — organic + hybrid bookends
  | "JustSoldReelSquare"    // 1:1 12s social-proof cut (soldPrice / DOM / above-asking)
  | "OpenHouseAnnounceReel" // 1:1 12s event headline (date / time / address)
  | "ComingSoonReel"        // 1:1 12s pre-MLS teaser (whenString / teaser / broll)

export interface PromoCompositionChoice {
  compositionId: PromoCompositionId
  situationKind: SituationKind
}

/**
 * compositionForPromoEvent — PURE. Map a listing-promo event_type to the
 * composition the render endpoint should feed Remotion + the Director
 * SituationKind it corresponds to.
 *
 * Routing (each deliberate):
 *   just_listed         → JustListedReel        (new_listing)  — legacy organic vertical
 *   price_reduction     → JustListedReel        (price_drop)   — organic vertical, neutral script
 *   under_contract      → JustListedReel        (just_sold-adjacent) — no dedicated comp; script-carried
 *   just_sold           → JustSoldReelSquare    (just_sold)    — social-proof cut
 *   open_house_announce → OpenHouseAnnounceReel (open_house)   — event headline
 *   open_house_reminder → OpenHouseAnnounceReel (open_house)   — event headline
 *   coming_soon         → ComingSoonReel        (coming_soon)  — pre-MLS teaser
 *
 * NOTE the choice here is the DESIRED composition. Whether the render
 * endpoint can SAFELY build that composition's required props from the facts
 * it loads is a second decision (buildPromoProps → fellBack). When props
 * can't be built, the endpoint falls back to JustListedReel — honest, never
 * a broken render.
 */
export function compositionForPromoEvent(eventType: string): PromoCompositionChoice {
  switch (eventType as PromoEventType) {
    case "just_sold":
      return { compositionId: "JustSoldReelSquare", situationKind: "just_sold" }
    case "open_house_announce":
    case "open_house_reminder":
      return { compositionId: "OpenHouseAnnounceReel", situationKind: "open_house" }
    case "coming_soon":
      return { compositionId: "ComingSoonReel", situationKind: "coming_soon" }
    case "price_reduction":
      return { compositionId: "JustListedReel", situationKind: "price_drop" }
    case "just_listed":
      return { compositionId: "JustListedReel", situationKind: "new_listing" }
    case "under_contract":
      // No dedicated organic composition; the "off market" intent rides the
      // narration script. Legacy vertical reel is the honest carrier.
      return { compositionId: "JustListedReel", situationKind: "just_sold" }
    default:
      // Unknown event_type → safe legacy default (the pre-fix behavior).
      return { compositionId: "JustListedReel", situationKind: "new_listing" }
  }
}

/**
 * The narration word budget for a listing-promo event, DERIVED from the
 * composition that event will actually render on.
 *
 * WHY IT LIVES BESIDE THE ROUTER. Every one of the four promo compositions
 * plays its narration as an <Audio> INSIDE the composition against a fixed
 * durationInFrames (remotion/JustListedReel.tsx:89 and its three siblings), so
 * an overrun is CUT — the m313 tpad only rescues the different key,
 * input_props.voiceover_url, which this path never sets. And the four durations
 * are not close: 25s for the organic vertical reel, 12s for each of the three
 * square event cuts. ONE script length for all four is wrong for three of them,
 * which is exactly why the budget is asked of the ROUTER rather than written
 * into the prompt.
 *
 * THE FALLBACK IS SAFE IN THE RIGHT DIRECTION. buildPromoProps can fall back to
 * JustListedReel when a square cut's required facts are missing, and
 * JustListedReel is the LONGEST of the four — a script capped for a 12s square
 * cut always fits the 25s fallback. The reverse could not be true, because
 * JustListedReel is only ever the desired composition for events that never
 * route to a square cut.
 *
 * PURE.
 */
export function promoNarrationBudget(eventType: string): NarrationBudget {
  const { compositionId } = compositionForPromoEvent(eventType)
  const geo = geometryFor(compositionId)
  return narrationBudget(compositionId, geo ? compositionSeconds(geo) : 0)
}

/**
 * Human-readable label for a listing-promo event — the reel's cover hook, the
 * ai_video_projects title, and the thumbnail eyebrow all speak it.
 *
 * MOVED HERE from app/api/internal/remotion/render-just-listed/route.ts (its
 * private `eventLabel`) when the reactor started staging the project row at
 * script time: two writers of one title needed one spelling (§6). `price_changed`
 * is kept — it is a lifecycle alias some older ledger rows carry.
 *
 * THIS LABEL IS PUBLIC. render-just-listed passes it as JustListedReel's `hook`
 * prop (route.ts:654), which is the 96px headline burned into the reel's cover
 * frame, and app/api/cron/listing-promo-social-publish/route.ts joins it into
 * the social caption that publishes to Facebook/Instagram/LinkedIn/TikTok/
 * YouTube/Pinterest/X. So the price case takes the public word from
 * lib/listings/price-improvement-label.ts (owner ruling) — it used to read
 * "Price Update", a third spelling of an idea the ad producer already called
 * "Price Improved" (lib/ads/listing-ad-producer.ts:49). The event_type KEYS
 * below are live DB CHECK values and are unchanged.
 */
export function promoEventLabel(eventType: string): string {
  const publicPriceLabel = publicPriceEventLabel(eventType, "badge")
  if (publicPriceLabel) return publicPriceLabel
  switch (eventType) {
    case "just_listed":         return "Just Listed"
    case "just_sold":           return "Just Sold"
    case "coming_soon":         return "Coming Soon"
    case "open_house_announce": return "Open House"
    case "open_house_reminder": return "Open House"
    case "under_contract":      return "Under Contract"
    default:                    return "New Listing"
  }
}

// ─── Prop builder ─────────────────────────────────────────────────────────────

/** The listing facts the render endpoint already loads (loadListingFacts) plus
 *  the sale-outcome columns this builder additionally reads for just_sold. */
export interface PromoListingFacts {
  address:       string
  city_state:    string
  price:         string        // USD-formatted list price
  bedrooms:      string
  bathrooms:     string
  sqft:          string
  property_type: string
  images:        string[]
  /** USD-formatted sold price (listings.sold_price) — "" when not sold/known. */
  soldPrice?:    string
  /** Days on market (created_at → sold_date) — null when not computable. */
  daysOnMarket?: number | null
  /** Open-house date headline (e.g. "This Saturday") — "" when unknown. */
  openHouseDate?: string
  /** Open-house time window (e.g. "12:00 - 2:00 PM") — "" when unknown. */
  openHouseTime?: string
}

export interface PromoBrand {
  primaryColor: string
  accentColor:  string
  logoUrl?:     string
  agentName?:   string
  agentPhone?:  string
  showEhoMark:  boolean
  /** Brokerage trade name — required by the square event compositions'
   *  bottom disclosure line. */
  brokerageName?: string
}

export interface BuildPropsInput {
  choice:        PromoCompositionChoice
  facts:         PromoListingFacts
  brand:         PromoBrand
  voiceoverUrl:  string
  qrCodeDataUrl: string | null
  qrCaption:     string
  hook:          string
  /** SOUND-OFF CAPTIONS (additive + default-off). Precomputed word-accurate cues
   *  built upstream from REAL ElevenLabs alignment. Threaded onto every voiced
   *  composition's captionsCues prop. Absent → no captions (current behavior). */
  captionsCues?:  import("./caption-plan").CaptionCue[] | null
  /** SOUND-OFF CAPTIONS fallback — the raw VO script text (the CaptionLayer
   *  estimates timing in-composition). Absent → no caption fallback. */
  captionScript?: string | null
}

export interface BuildPropsResult {
  /** The composition the endpoint should ACTUALLY render — equals
   *  choice.compositionId unless a fallback occurred. */
  compositionId: PromoCompositionId
  /** Strongly-shaped props for `compositionId`. */
  inputProps:    Record<string, unknown>
  /** True when the desired composition's required props could not be built
   *  from the available facts and we fell back to JustListedReel. */
  fellBack:      boolean
  /** Human-readable reason for the fallback (observability), null otherwise. */
  fallbackReason: string | null
}

/** The legacy JustListedReel prop shape — the route's pre-fix behavior. This
 *  is also the universal FALLBACK payload. */
function buildJustListedProps(i: BuildPropsInput): Record<string, unknown> {
  return {
    hook:          i.hook,
    address:       i.facts.address,
    cityState:     i.facts.city_state,
    price:         i.facts.price,
    bedrooms:      i.facts.bedrooms,
    bathrooms:     i.facts.bathrooms,
    sqft:          i.facts.sqft,
    imageUrls:     i.facts.images,
    brand:         i.brand,
    voiceoverUrl:  i.voiceoverUrl,
    qrCodeDataUrl: i.qrCodeDataUrl,
    qrCaption:     i.qrCaption,
    captionsCues:  i.captionsCues ?? null,
    captionScript: i.captionScript ?? null,
  }
}

function fallback(i: BuildPropsInput, reason: string): BuildPropsResult {
  return {
    compositionId:  "JustListedReel",
    inputProps:     buildJustListedProps(i),
    fellBack:       true,
    fallbackReason: reason,
  }
}

/**
 * buildPromoProps — PURE. Assemble the REQUIRED props for the chosen
 * composition from the facts the route loads. When the chosen composition's
 * required facts are missing, FALL BACK to JustListedReel (honest, no broken
 * render) and flag it.
 */
export function buildPromoProps(i: BuildPropsInput): BuildPropsResult {
  const { choice, facts, brand } = i

  switch (choice.compositionId) {
    case "JustSoldReelSquare": {
      // REQUIRED: soldPrice. JustSoldReelSquare's whole job is the SOLD price
      // strip; without it the composition is empty. daysOnMarket + listPrice
      // (for the ABOVE-ASKING badge) are optional enhancements.
      if (!facts.soldPrice) {
        return fallback(i, "just_sold: listings.sold_price not set — cannot build JustSoldReelSquare")
      }
      const inputProps = {
        address:       facts.address,
        cityState:     facts.city_state,
        soldPrice:     facts.soldPrice,
        listPrice:     facts.price || null,        // drives ABOVE-ASKING badge when sold > list
        daysOnMarket:  facts.daysOnMarket ?? null,
        imageUrls:     facts.images,
        ctaLabel:      "List your home with me",
        brand,
        voiceoverUrl:  i.voiceoverUrl,
        qrCodeDataUrl: i.qrCodeDataUrl,
        qrCaption:     i.qrCaption,
        captionsCues:  i.captionsCues ?? null,
        captionScript: i.captionScript ?? null,
      }
      return { compositionId: "JustSoldReelSquare", inputProps, fellBack: false, fallbackReason: null }
    }

    case "OpenHouseAnnounceReel": {
      // REQUIRED: dateLabel + timeLabel — the headline IS the event. The
      // render endpoint loads no open-house schedule (eventContext is not
      // threaded to the render path), so unless the facts carry both, fall back.
      if (!facts.openHouseDate || !facts.openHouseTime) {
        return fallback(i, "open_house: no event date/time available to the render path — cannot build OpenHouseAnnounceReel")
      }
      const inputProps = {
        address:       facts.address,
        cityState:     facts.city_state,
        dateLabel:     facts.openHouseDate,
        timeLabel:     facts.openHouseTime,
        imageUrls:     facts.images,
        bodyLine:      null,
        ctaLabel:      "Save the date",
        agentName:     brand.agentName ?? "Your Agent",
        agentPhone:    brand.agentPhone,
        voiceoverUrl:  i.voiceoverUrl,
        contextCues:   [],
        qrCodeDataUrl: i.qrCodeDataUrl,
        qrCaption:     i.qrCaption,
        brand: {
          primaryColor:  brand.primaryColor,
          accentColor:   brand.accentColor,
          logoUrl:       brand.logoUrl,
          brokerageName: brand.brokerageName ?? "",
          showEhoMark:   brand.showEhoMark,
        },
      }
      return { compositionId: "OpenHouseAnnounceReel", inputProps, fellBack: false, fallbackReason: null }
    }

    case "ComingSoonReel": {
      // REQUIRED: whenString (deterministic "Coming Soon" headline) +
      // agentName + cityState. teaser is built from the listing facts. All of
      // these the route loads, so coming_soon never needs a fallback.
      const teaser = buildComingSoonTeaser(facts)
      const inputProps = {
        address:        facts.address || null,
        cityState:      facts.city_state,
        teaser,
        heroImageUrl:   facts.images[0] ?? null,
        whenString:     "Coming Soon",
        ctaLabel:       "DM me to be first in line",
        brollClips:     [],
        contextCues:    [],
        avatarVideoUrl: null,
        agentPhotoUrl:  null,
        agentName:      brand.agentName ?? "Your Agent",
        voiceoverUrl:   i.voiceoverUrl,
        brand: {
          primaryColor:  brand.primaryColor,
          accentColor:   brand.accentColor,
          logoUrl:       brand.logoUrl,
          brokerageName: brand.brokerageName ?? "",
          showEhoMark:   brand.showEhoMark,
        },
      }
      return { compositionId: "ComingSoonReel", inputProps, fellBack: false, fallbackReason: null }
    }

    case "JustListedReel":
    default:
      // The legacy organic cut — also the deliberate target for just_listed /
      // price_reduction / under_contract. Never a fallback here.
      return {
        compositionId:  "JustListedReel",
        inputProps:     buildJustListedProps(i),
        fellBack:       false,
        fallbackReason: null,
      }
  }
}

/** Build the ComingSoon teaser chip from listing facts — "3 BD · 2 BA · condo".
 *  Returns null when no facts are usable (the composition then leans on
 *  visuals alone, which is its documented fallback). */
export function buildComingSoonTeaser(facts: PromoListingFacts): string | null {
  const parts: string[] = []
  if (facts.bedrooms) parts.push(`${facts.bedrooms} BD`)
  if (facts.bathrooms) parts.push(`${facts.bathrooms} BA`)
  if (facts.property_type) parts.push(facts.property_type)
  return parts.length > 0 ? parts.join(" · ") : null
}

/** Compute whole days between a listing's created_at and its sold_date.
 *  Returns null when either is missing or the math is non-finite/negative. */
export function computeDaysOnMarket(createdAt: string | null, soldDate: string | null): number | null {
  if (!createdAt || !soldDate) return null
  const start = Date.parse(createdAt)
  const end   = Date.parse(soldDate)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  const days = Math.round((end - start) / (24 * 60 * 60 * 1000))
  return days >= 0 ? days : null
}
