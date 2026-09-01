/**
 * remotion/Root.tsx
 *
 * Remotion composition registry. The render endpoint imports the
 * registerRoot pattern via @remotion/bundler's bundle() helper which reads
 * this file as the entry. Compositions are versioned by id — when the
 * render endpoint calls renderMedia({ composition: 'JustListedReel' }) it
 * resolves to the entry below.
 */
import React from "react"
import { Composition } from "remotion"
import { JustListedReel } from "./JustListedReel"
import { JustListedReelSquare } from "./JustListedReelSquare"
import { PhotoWalkthroughReel } from "./PhotoWalkthroughReel"
import { JustListedReelHorizontal } from "./JustListedReelHorizontal"
import { JustSoldReelSquare } from "./JustSoldReelSquare"
import { ComingSoonReel } from "./ComingSoonReel"
import { OpenHouseAnnounceReel } from "./OpenHouseAnnounceReel"
import { AgentTalkingHeadReel } from "./AgentTalkingHeadReel"
import { AgentExplainerReel } from "./AgentExplainerReel"
import { TeammateExplainerReel } from "./TeammateExplainerReel"
import { ExplainerAnimReel } from "./ExplainerAnimReel"
import { TestimonialReel } from "./TestimonialReel"
import { NeighborhoodSpotlightReel } from "./NeighborhoodSpotlightReel"
import { MarketUpdateReel } from "./MarketUpdateReel"
import { ListingPresentationSlide } from "./ListingPresentationSlide"
import { BuyerConsultationSlide } from "./BuyerConsultationSlide"
import { AffordabilitySnapshotReel } from "./AffordabilitySnapshotReel"
import { CMAReel } from "./CMAReel"
import { EquityReportReel } from "./EquityReportReel"
import { ListingSectionReel } from "./ListingSectionReel"
import { ProductPromoReel } from "./ProductPromoReel"
import { VideoCoverThumb } from "./VideoCoverThumb"
import { LeadMagnetCard } from "./LeadMagnetCard"
import { NewsletterDigestVideo } from "./NewsletterDigestVideo"
import { NewsletterDigestThumb } from "./NewsletterDigestThumb"
import { PostcardFront4x6 } from "./PostcardFront4x6"
import { ListingFlyer } from "./ListingFlyer"
import { DoorHanger } from "./DoorHanger"
import { CarouselSlide } from "./CarouselSlide"
import { PostcardBack4x6 } from "./PostcardBack4x6"
import { PostcardFront6x9 } from "./PostcardFront6x9"
import { PostcardBack6x9 } from "./PostcardBack6x9"
import { PartnersMeetingReel } from "./PartnersMeetingReel"

// 25 seconds @ 30 fps = 750 frames. 1080×1920 = vertical 9:16 — the
// canonical social-reel format (TikTok / IG Reels / YouTube Shorts /
// Pinterest Idea Pins). Horizontal 16:9 variants can be added as separate
// compositions when an agent requests a YouTube long-form version.
export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* Composition expects either no inputProps generic or a Zod schema —
          we pass strongly-typed inputProps at render time via
          /api/internal/remotion/render-just-listed (the bundler resolves
          types from JustListedReel directly). The any-cast is the documented
          escape hatch for typed-props compositions in Remotion 4 without
          adding a Zod runtime dep just for the registry. */}
      <Composition
        id="JustListedReel"
        component={JustListedReel as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={750}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{
          hook:        "Just Listed",
          address:     "123 Main Street",
          cityState:   "Miami, FL",
          price:       "$625,000",
          bedrooms:    "3",
          bathrooms:   "2",
          sqft:        "1,850",
          imageUrls:   [],
          brand: {
            primaryColor: "#0F172A",
            accentColor:  "#F59E0B",
            showEhoMark:  true,
          },
        }}
      />
      {/* Wave 39 — square 1:1 ad variant of JustListedReel. 12s @ 30fps
          = 360 frames. 1080×1080 matches Meta/IG feed default + LinkedIn
          sponsored content. The W40 ad creator picks this composition
          when staging paid placements; the 9:16 vertical reel stays
          the organic format. */}
      <Composition
        id="JustListedReelSquare"
        component={JustListedReelSquare as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={360}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={{
          hook:       "Just Listed",
          address:    "123 Main Street",
          cityState:  "Miami, FL",
          price:      "$625,000",
          bedrooms:   "3",
          bathrooms:  "2",
          sqft:       "1,850",
          imageUrls:  [],
          ctaLabel:   "Tour this listing",
          brand: {
            primaryColor: "#0F172A",
            accentColor:  "#F59E0B",
            showEhoMark:  true,
          },
        }}
      />
      {/* CINEMATIC photo→walkthrough reel. Turns any MLS photo set into a
          MOVING property tour — each photo gets a Ken Burns pan/zoom over its
          own frame window with a cross-fade into the next, plus narrated
          tour-beat captions. So even a listing with NO video gets a
          scroll-stopping reel. Motion is planned PURELY upstream by
          lib/video/ken-burns-plan.ts (kenBurnsPlan → per-photo clip windows);
          the composition renders the plan verbatim with interpolate scale +
          translate (NO CSS transitions). Reuses the JustListedReel brand / QR /
          voiceover contract so it slots into the same render pipeline +
          bookends + music-mood. Honest fallback card when no photos. 1080×1080
          square + 20s @ 30fps = 600 frames. The Video Director selects this
          format when a listing has photos but no walkthrough video; an empty
          photo plan means the Director skips it. */}
      <Composition
        id="PhotoWalkthroughReel"
        component={PhotoWalkthroughReel as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={600}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={{
          hook:       "Take the tour",
          address:    "123 Main Street",
          cityState:  "Brickell, FL",
          imageUrls:  [],
          captions:   [],
          ctaLabel:   "DM me to tour.",
          voiceoverUrl:  undefined,
          qrCodeDataUrl: null,
          qrCaption:     "Scan to tour",
          mlsClean:      false,
          brand: {
            primaryColor: "#0F172A",
            accentColor:  "#F59E0B",
            showEhoMark:  true,
          },
        }}
      />
      {/* Wave 39 — Just Sold square variant. Social-proof companion
          to JustListedReelSquare. Shows SOLD treatment + sold price +
          days-on-market + optional "ABOVE ASKING" badge. 1080×1080 +
          12s @ 30fps. */}
      <Composition
        id="JustSoldReelSquare"
        component={JustSoldReelSquare as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={360}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={{
          address:       "123 Main Street",
          cityState:     "Miami, FL",
          soldPrice:     "$640,000",
          listPrice:     "$625,000",
          daysOnMarket:  7,
          imageUrls:     [],
          ctaLabel:      "List your home with me",
          brand: {
            primaryColor: "#0F172A",
            accentColor:  "#F59E0B",
            showEhoMark:  true,
          },
        }}
      />
      {/* Wave 39 — D-ID + ElevenLabs differentiator. Frames an
          agent's talking-head avatar video with brokerage chrome
          (intro card + caption strip + outro CTA). The avatar mp4
          is rendered upstream via lib/did/index.ts + the
          poll-did-videos cron (already ships a logo-composited
          version). When no avatar is available, the composition
          gracefully falls back to a static agent-photo card. The
          single composition no competitor in the space ships today. */}
      <Composition
        id="AgentTalkingHeadReel"
        component={AgentTalkingHeadReel as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={420}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={{
          hook:           "MEET YOUR AGENT",
          agentName:      "Your Agent",
          caption:        "Three things every first-time buyer should ask before bidding.",
          ctaLabel:       "Book a free 15-min consult",
          avatarVideoUrl: null,
          agentPhotoUrl:  null,
          brand: {
            primaryColor:  "#0F172A",
            accentColor:   "#F59E0B",
            brokerageName: "Your Brokerage",
            showEhoMark:   true,
          },
        }}
      />
      {/* Wave 39 — generic explainer reel with three bullets and
          persistent avatar PIP. Reusable across the highest-engagement
          educational formats: "3 things to know before bidding",
          "what closing costs actually cover", etc. 1080×1080 + 18s. */}
      <Composition
        id="AgentExplainerReel"
        component={AgentExplainerReel as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={540}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={{
          eyebrow:    "FIRST-TIME BUYER",
          title:      "Three things to know before you bid",
          bullets: [
            "A pre-approval letter expires — yours needs to be dated within 60 days.",
            "Escalation clauses can win the bid but cap your downside; ask me how.",
            "The inspection contingency is the lever, not the price.",
          ],
          ctaLabel:   "Book a 15-min consult",
          agentName:  "Your Agent",
          avatarVideoUrl: null,
          agentPhotoUrl:  null,
          brand: {
            primaryColor:  "#0F172A",
            accentColor:   "#F59E0B",
            brokerageName: "Your Brokerage",
            showEhoMark:   true,
          },
        }}
      />
      {/* TEAMMATE VIDEO lane — full-frame D-ID avatar explainer wrapped in
          the tenant's brand kit: branded intro card, persistent lower-third
          (agent + brokerage), logo watermark, branded outro CTA + QR badge.
          Commissioned by lib/video/avatar-explainer (AI-authored, gated copy;
          ElevenLabs voice; D-ID clip wired in on provider completion).
          1080×1080 + 30s. */}
      <Composition
        id="TeammateExplainerReel"
        component={TeammateExplainerReel as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={900}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={{
          eyebrow:  "BUYER BASICS",
          title:    "Three things to know before you bid",
          ctaLabel: "Book a 15-min consult",
          agentName: "Your Agent",
          avatarVideoUrl: null,
          agentPhotoUrl:  null,
          brand: {
            primaryColor:  "#0F172A",
            accentColor:   "#F59E0B",
            brokerageName: "Your Brokerage",
            showEhoMark:   true,
          },
        }}
      />
      {/* ANIMATED EXPLAINER reel — the in-stack answer to Manim. Animates
          a real-estate CONCEPT as a deterministic diagram (equity-over-time
          draw-on curve / rate-buydown payment bars / closing-timeline stepped
          path / what-$X/mo-buys price bars) with the agent avatar PIP
          narrating. Diagram content is pure data
          (lib/charts/explainer-diagram.ts); geometry reuses
          lib/charts/geometry; animation is interpolate/spring/Sequence only.
          Topic + facts ride on situation.facts. 1080×1080 + 18s. Avatar
          optional — honest "share your numbers" fallback when facts are thin. */}
      <Composition
        id="ExplainerAnimReel"
        component={ExplainerAnimReel as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={540}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={{
          eyebrow:  "FIRST-TIME BUYER",
          title:    "How your equity grows",
          caption:  "Assumes 4.0% appreciation, 6.5% / 30yr loan — estimates, not a guarantee.",
          ctaLabel: "Want your numbers?",
          hasData:  true,
          diagram: {
            kind: "equity_over_time" as const,
            points: [
              { year: 0,  value: 500000, balance: 400000, equity: 100000 },
              { year: 2,  value: 540800, balance: 388000, equity: 152800 },
              { year: 4,  value: 584929, balance: 374000, equity: 210929 },
              { year: 6,  value: 632659, balance: 358000, equity: 274659 },
              { year: 8,  value: 684285, balance: 340000, equity: 344285 },
              { year: 10, value: 740122, balance: 320000, equity: 420122 },
            ],
            startValue: 500000,
            startLoan:  400000,
            apr:        0.04,
            rate:       0.065,
            termYears:  30,
            finalEquity: 420122,
          },
          agentName:      "Your Agent",
          avatarVideoUrl: null,
          agentPhotoUrl:  null,
          brand: {
            primaryColor:  "#0F172A",
            accentColor:   "#F59E0B",
            brokerageName: "Your Brokerage",
            showEhoMark:   true,
          },
        }}
      />
      {/* Wave 39 — monthly/weekly market-update reel with three big
          stat cards + avatar narration. Fires automatically from
          the market-data-refresh cron. 1080×1080 + 16s. */}
      <Composition
        id="MarketUpdateReel"
        component={MarketUpdateReel as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={480}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={{
          areaName: "Brickell",
          period:   "October 2026",
          stats: [
            { value: "$675K", label: "MEDIAN SALE PRICE", delta: "+3.2% MoM", direction: "up_good" as const },
            { value: "12 days", label: "AVG DAYS ON MARKET", delta: "-3 days vs Sept", direction: "down_good" as const },
            { value: "84",     label: "ACTIVE LISTINGS",    delta: "+8 vs Sept",       direction: "up_bad" as const },
          ],
          ctaLabel:  "Want my take on your block?",
          agentName: "Your Agent",
          agentPhone: null,
          avatarVideoUrl: null,
          agentPhotoUrl:  null,
          brand: {
            primaryColor:  "#0F172A",
            accentColor:   "#F59E0B",
            brokerageName: "Your Brokerage",
            showEhoMark:   true,
          },
        }}
      />
      {/* Wave 39 — the listing-presentation differentiator. ONE slide
          of an N-slide narrated video presentation; the composer
          chains 5-12 of these with the avatar narrating each. PIP
          stays bottom-right on every slide so the homeowner watches
          the agent walk them through. 1920×1080 horizontal so a
          tablet or TV viewing experience reads correctly. The slide
          duration is set per-slide by the composer at chain time —
          this Composition registers at a 6s default purely so the
          studio preview renders without zero-frame errors. */}
      <Composition
        id="ListingPresentationSlide"
        component={ListingPresentationSlide as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={180}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          kind:        "image" as const,
          slideNumber: 1,
          totalSlides: 8,
          title:       "Your home, the market, the strategy.",
          body: [
            "I've prepared a tailored walkthrough of what this market is rewarding right now and how we'd position your home.",
            "We'll cover comparable sales, pricing strategy, our launch plan, and the buyer profile most likely to make an offer.",
          ],
          heroImageUrl:     null,
          bodyContent:      null,
          avatarVideoUrl:   null,
          avatarStartFrame: 0,
          avatarEndFrame:   180,
          agentPhotoUrl:    null,
          agentName:        "Your Agent",
          brand: {
            primaryColor:  "#0F172A",
            accentColor:   "#F59E0B",
            surfaceColor:  "#FFFFFF",
            brokerageName: "Your Brokerage",
            showEhoMark:   true,
          },
        }}
      />
      {/* Wave 39 — pre-listing teaser. "Coming soon" before the MLS
          listing goes live. Cheap Remotion-only render by default;
          optional D-ID avatar PIP if the brokerage opts in. 1080×1080
          + 12s + B-roll support + content-bank context cues. */}
      <Composition
        id="ComingSoonReel"
        component={ComingSoonReel as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={360}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={{
          address:        "Coming this week",
          cityState:      "Brickell, FL",
          teaser:         "3 BD · rooftop deck",
          heroImageUrl:   null,
          whenString:     "This Friday",
          ctaLabel:       "DM me to be first in line",
          brollClips:     [],
          contextCues:    [],
          avatarVideoUrl: null,
          agentPhotoUrl:  null,
          agentName:      "Your Agent",
          brand: {
            primaryColor:  "#0F172A",
            accentColor:   "#F59E0B",
            brokerageName: "Your Brokerage",
            showEhoMark:   true,
          },
        }}
      />
      {/* Wave 39 — open house event reel. Date / time / address get
          the visual headline. 1080×1080 + 12s. */}
      <Composition
        id="OpenHouseAnnounceReel"
        component={OpenHouseAnnounceReel as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={360}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={{
          address:    "185 Berry Street",
          cityState:  "Brickell, FL",
          dateLabel:  "This Saturday",
          timeLabel:  "12:00 - 2:00 PM",
          imageUrls:  [],
          bodyLine:   "Modern 3-bed with rooftop deck — RSVP not required.",
          ctaLabel:   "Save the date",
          agentName:  "Your Agent",
          agentPhone: null,
          brand: {
            primaryColor:  "#0F172A",
            accentColor:   "#F59E0B",
            brokerageName: "Your Brokerage",
            showEhoMark:   true,
          },
        }}
      />
      {/* Wave 39 — testimonial reel. 5-star quote + attribution +
          optional agent reaction PIP. Pure Remotion when no avatar
          supplied. 1080×1080 + 14s. */}
      <Composition
        id="TestimonialReel"
        component={TestimonialReel as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={420}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={{
          quote:         "She listened, she was honest, and she got us the home we'd been chasing for six months. Couldn't recommend more.",
          clientName:    "Jamie, Brickell",
          clientRole:    "Buyer",
          closingLabel:  "Closed Oct 2026",
          stars:         5,
          ctaLabel:      "Read more reviews",
          agentName:     "Your Agent",
          avatarVideoUrl: null,
          agentPhotoUrl:  null,
          brand: {
            primaryColor:  "#0F172A",
            accentColor:   "#F59E0B",
            brokerageName: "Your Brokerage",
            showEhoMark:   true,
          },
        }}
      />
      {/* Wave 39 — neighborhood spotlight. Heaviest user of the
          B-roll layer. Lifestyle clips under data highlights +
          agent narration. 1080×1080 + 16s. */}
      <Composition
        id="NeighborhoodSpotlightReel"
        component={NeighborhoodSpotlightReel as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={480}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={{
          neighborhood: "Brickell",
          tagline:      "Where rooftops meet the bay.",
          highlights: [
            { label: "MEDIAN PRICE",  value: "$675K" },
            { label: "WALK SCORE",    value: "92" },
          ],
          brollClips:   [],
          ctaLabel:     "Want a private tour?",
          agentName:    "Your Agent",
          agentPhone:   null,
          brand: {
            primaryColor:  "#0F172A",
            accentColor:   "#F59E0B",
            brokerageName: "Your Brokerage",
            showEhoMark:   true,
          },
        }}
      />
      {/* Wave 39 — horizontal 16:9 variant of JustListed for
          YouTube ads + FB in-stream + CTV/OTT placements. 1920×1080
          + 20s. Voiceover-on by default since CTV viewers aren't
          muted-feed. */}
      <Composition
        id="JustListedReelHorizontal"
        component={JustListedReelHorizontal as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={600}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          hook:      "Just Listed",
          address:   "123 Main Street",
          cityState: "Miami, FL",
          price:     "$625,000",
          bedrooms:  "3",
          bathrooms: "2",
          sqft:      "1,850",
          imageUrls: [],
          ctaLabel:  "Tour this listing",
          brand: {
            primaryColor: "#0F172A",
            accentColor:  "#F59E0B",
            showEhoMark:  true,
          },
        }}
      />
      {/* Wave 39 — buyer-side counterpart to ListingPresentationSlide.
          Same composer pattern: one slide of an N-slide narrated
          presentation video with avatar PIP bottom-right. Slide
          kinds: title / loan / search / offer_strategy / timeline /
          closing. The "search" kind is the killer — renders 3
          example listings with photo + price inside the narrated
          video so the lead sees what their budget buys live.
          1920×1080 / per-slide duration set by composer. */}
      <Composition
        id="BuyerConsultationSlide"
        component={BuyerConsultationSlide as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={180}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          kind:        "title" as const,
          slideNumber: 1,
          totalSlides: 8,
          title:       "Your buy, step by step.",
          body: [
            "I put together a personalized walkthrough of what your search looks like this week, what pre-approval gets you, and how we'd structure your first offer.",
            "We'll cover loan options, current inventory, offer strategy, and the closing timeline.",
          ],
          searchExamples:  [],
          timelineLabels:  [],
          heroImageUrl:    null,
          bodyContent:     null,
          avatarVideoUrl:  null,
          avatarStartFrame: 0,
          avatarEndFrame:   180,
          agentPhotoUrl:    null,
          agentName:        "Your Agent",
          brand: {
            primaryColor:  "#0F172A",
            accentColor:   "#F59E0B",
            surfaceColor:  "#FFFFFF",
            brokerageName: "Your Brokerage",
            showEhoMark:   true,
          },
        }}
      />
      {/* Wave 39 — buyer-side reel. Shows what a target monthly
          payment buys in the lead's market THIS WEEK. Three real
          listings; data freshness drives engagement. 1080×1080 + 15s.
          The "monthly payment" framing (vs sticker price) is the
          conversion trick — first-time buyers think in monthly
          budget, not list price. */}
      <Composition
        id="AffordabilitySnapshotReel"
        component={AffordabilitySnapshotReel as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={450}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={{
          monthlyHeadline: "What $3,200/mo buys here",
          areaName:        "Brickell",
          period:          "This week",
          examples: [
            { address: "1245 Bay Rd",   cityState: "Brickell, FL", price: "$485,000", bedrooms: "2", bathrooms: "2", photoUrl: null },
            { address: "501 N Riverwalk", cityState: "Brickell, FL", price: "$525,000", bedrooms: "2", bathrooms: "2", photoUrl: null },
            { address: "210 SE 8th St",  cityState: "Brickell, FL", price: "$540,000", bedrooms: "2", bathrooms: "2", photoUrl: null },
          ],
          ratesAssumption: "Estimated at 6.5% / 30yr / 20% down · actual rate varies",
          ctaLabel:   "Want a real list?",
          agentName:  "Your Agent",
          agentPhone: null,
          brand: {
            primaryColor:  "#0F172A",
            accentColor:   "#F59E0B",
            brokerageName: "Your Brokerage",
            showEhoMark:   true,
          },
        }}
      />
      {/* Wave 39 — Comparative Market Analysis reel. The chart-layer
          flagship: a narrated, data-driven CMA video (price trend +
          comps + days-on-market + monthly-payment donut) instead of a
          static PDF. 1080×1080 + 24s. Charts are deterministic SVG
          (lib/charts/geometry); data arrives via inputProps from the
          caller's RentCast/comps payload. */}
      <Composition
        id="CMAReel"
        component={CMAReel as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={720}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={{
          subjectAddress: "123 Main Street",
          areaName:       "Brickell, FL",
          priceTrend: {
            values: [612000, 628000, 631000, 645000, 662000, 689000],
            labels: ["May", "Jun", "Jul", "Aug", "Sep", "Oct"],
          },
          comps: [
            { label: "Subject", value: 675000, isSubject: true },
            { label: "501 N Riverwalk", value: 640000 },
            { label: "1245 Bay Rd", value: 658000 },
            { label: "210 SE 8th St", value: 612000 },
          ],
          daysOnMarket: {
            values: [21, 18, 14, 12, 11, 9],
            labels: ["May", "Jun", "Jul", "Aug", "Sep", "Oct"],
          },
          affordability: {
            segments: [
              { label: "P&I",       value: 3200, color: "#F59E0B" },
              { label: "Taxes",     value: 720,  color: "#60A5FA" },
              { label: "Insurance", value: 240,  color: "#34D399" },
              { label: "HOA",       value: 180,  color: "#A78BFA" },
            ],
            centerValue: "$4,340",
          },
          ctaLabel:  "Want this analysis for your home?",
          brand: {
            primaryColor:  "#0F172A",
            accentColor:   "#F59E0B",
            brokerageName: "Your Brokerage",
            agentName:     "Your Agent",
            showEhoMark:   true,
          },
        }}
      />
      {/* Wave 39 — Anniversary Equity Reel. The video face of
          lib/kernel/anniversary-equity.ts: on a past client's yearly
          closing anniversary, the OPTIONAL personalized reel that rides
          the SAME real equity numbers the portal card + gated note carry
          (estimated current value, what they paid, appreciation, and
          equity ONLY when the original loan is on file — otherwise the
          honest appreciation-only treatment). Mirrors MarketUpdateReel:
          stat cards + optional avatar PIP, plus a deterministic SVG
          basis→value bar (lib/charts/geometry) and the tracked
          QrOutroBadge (mintVideoQr kind "anniversary" → anniversary_video
          → the portal equity card). 1080×1080 + 18s. Avatar optional. */}
      <Composition
        id="EquityReportReel"
        component={EquityReportReel as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={540}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={{
          agentName:       "Your Agent",
          agentPhotoUrl:   null,
          avatarVideoUrl:  null,
          address:         "123 Main Street, Brickell, FL",
          estimatedValue:  600000,
          purchasePrice:   500000,
          appreciation:    100000,
          appreciationPct: 20,
          estimatedEquity: 206000,
          yearsHeld:       1,
          qrCodeDataUrl:   null,
          qrCaption:       "Scan for your equity update",
          brandColors: {
            primaryColor:  "#0F172A",
            accentColor:   "#F59E0B",
            brokerageName: "Your Brokerage",
            showEhoMark:   true,
          },
        }}
      />
      {/* Wave 39 — one pre-listing presentation SECTION as a branded,
          narratable animated slide (intro / credibility / marketing / process /
          closing). The CMA/market section uses CMAReel; every other dripped
          section uses this. Avatar PIP + ElevenLabs narration optional.

          DURATION IS THE SCRIPT LENGTH. The narration is an <Audio> INSIDE this
          composition, so lib/video/script-structure.ts sizes the script to
          durationInFrames/fps (× 0.8 headroom at 150 wpm ⇒ 2 words per second).
          At 300 frames that bought TWENTY words — one sentence — for the section
          that has to sell the seller. m566 widened it to 900 (30s ⇒ 60 words):
          over the 33–46 words the deterministic fallbacks run, and enough for the
          4–5 sentence paragraph the AI brief asks for. Change this and
          remotion_compositions.duration_frames together — test:remotion-setup §3
          compares them field-for-field. */}
      <Composition
        id="ListingSectionReel"
        component={ListingSectionReel as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={900}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          sectionKey: "intro",
          title:      "Meet Your Listing Team",
          bullets:    ["A marketing system no other local agent runs.", "Here's exactly how we'll sell your home."],
          agentName:  "Your Agent",
          agentPhotoUrl: null,
          avatarVideoUrl: null,
          voiceoverUrl:   null,
          slideNumber: 1,
          totalSlides: 5,
          brand: {
            primaryColor:  "#0F172A",
            accentColor:   "#F59E0B",
            brokerageName: "Your Brokerage",
            showEhoMark:   true,
          },
        }}
      />
      {/* Wave 39 — universal 1200×630 thumbnail composition. EVERY
          video in the library uses this for og:image / share-card /
          AI-search-discoverable preview. Kind parameter drives the
          treatment (listing / explainer / presentation / market_update
          / testimonial / open_house / coming_soon / neighborhood /
          affordability / agent_avatar). Generated alongside every
          video render so the AI-search ecosystem (ChatGPT browse /
          Perplexity / Claude / Google AI Overviews) can read what the
          video is about even though they don't index video. */}
      <Composition
        id="VideoCoverThumb"
        component={VideoCoverThumb as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={1}
        fps={30}
        width={1200}
        height={630}
        defaultProps={{
          kind:           "listing" as const,
          title:          "Just Listed — 123 Main Street",
          subtitle:       "$625K · 3 bd · 2 ba · Brickell, FL",
          eyebrow:        "JUST LISTED",
          heroImageUrl:   null,
          agentPhotoUrl:  null,
          agentName:      "Your Agent",
          brand: {
            primaryColor:  "#0F172A",
            accentColor:   "#F59E0B",
            brokerageName: "Your Brokerage",
            showEhoMark:   true,
          },
          seoHint:        "Just-listed home in Brickell, FL — see photos and details inside.",
        }}
      />
      {/* Wave 39 — 1200×630 Open-Graph lead-magnet card. Static
          composition; renderStill() emits the PNG.
          PRODUCER STATUS (verified 2026-09-01): NO producer stages this
          composition yet. This comment used to claim "used by the W40 ad
          creator", which was never true — lib/ads/* touches no Remotion
          composition (listing-ad-producer sources listing photos and
          'CarouselSlide'-kind creatives, not OG cards), and nothing writes
          composition_id: "LeadMagnetCard". The registration stays (§1: a
          wanted capability's built half — the live lead-magnet lane in
          lib/kernel/lead-magnets.ts ships guides + QR codes with no share
          imagery at all); the missing half is the producer that renders
          this card for a magnet's landing/ad surfaces. */}
      <Composition
        id="LeadMagnetCard"
        component={LeadMagnetCard as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={1}
        fps={30}
        width={1200}
        height={630}
        defaultProps={{
          eyebrow:      "FREE GUIDE",
          headline:     "What your home is worth in today's market",
          subhead:      "A custom 5-page valuation report — no commitment, no spam.",
          ctaLabel:     "Get my report",
          heroImageUrl: null,
          brand: {
            primaryColor:  "#0F172A",
            accentColor:   "#F59E0B",
            brokerageName: "Your Brokerage",
            showEhoMark:   true,
          },
        }}
      />
      <Composition
        id="NewsletterDigestVideo"
        component={NewsletterDigestVideo as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={600}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{
          subject:        "Your weekly market digest",
          marketBeat:     "Median price up 3.2% vs last month",
          sectionTitles:  ["Market Update", "New Listings", "Local News"],
          brand: {
            primaryColor:  "#0F172A",
            accentColor:   "#F59E0B",
            brokerageName: "Your Brokerage",
          },
        }}
      />
      {/* Wave 22a — per-persona inbox-preview still thumbnail. 1200×630
          Open-Graph ratio so it works in Gmail/Apple Mail inbox previews
          AND when the email is forwarded into Slack/Teams/iOS Messages.
          durationInFrames=1 because renderStill() needs an anchor; the
          composition itself is pure (no animation). */}
      <Composition
        id="NewsletterDigestThumb"
        component={NewsletterDigestThumb as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={1}
        fps={30}
        width={1200}
        height={630}
        defaultProps={{
          agentName:     "Your Agent",
          agentPhotoUrl: null,
          personaHook:   "This week's market window in your area",
          subject:       "Your weekly market digest",
          brand: {
            primaryColor:  "#0F172A",
            accentColor:   "#F59E0B",
            brokerageName: "Your Brokerage",
          },
        }}
      />
      {/* Wave 36 — 4×6 postcard front. Lob's bleed canvas is 4.25"×6.25"
          at 300 DPI = 1275×1875 px. renderStill() produces the PNG that
          ships to Lob's postcards.create({ front: <url> }). */}
      {/* THE LISTING FLYER — 8.5x11 @ 300 DPI print still (bleed canvas
          2625x3375). The open-house handout with hero photo, facts strip,
          agent block, and the tracked scan-to-tour QR. */}
      <Composition
        id="ListingFlyer"
        component={ListingFlyer as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={1}
        fps={30}
        width={2625}
        height={3375}
        defaultProps={{
          address: "128 Harborview Lane", cityState: "Naples, FL 34102",
          price: "$1,250,000", beds: "4", baths: "3.5", sqft: "3,240",
          propertyType: "Single Family", highlights: ["Chef's kitchen with quartz island", "Saltwater pool + lanai", "Half-acre corner lot", "3-car garage"],
          heroImageUrl: null, photoUrls: [], agentName: "Your Agent",
          agentPhone: null, agentPhotoUrl: null,
          qrCodeDataUrl: null, qrCaption: "Scan to tour",
          statusLine: "JUST LISTED",
          brand: { primaryColor: "#0F172A", accentColor: "#F59E0B", logoUrl: null, brokerageName: "Your Brokerage", licenseLine: null, showEhoMark: true },
        }}
      />

      {/* THE CAROUSEL SLIDE — 1080x1350 (4:5 IG portrait) still, one per
          swipe. The producer renders N and the sweep assembles the ordered
          set into one approval-gated social_posts row (media_urls). */}
      <Composition
        id="CarouselSlide"
        component={CarouselSlide as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={1}
        fps={30}
        width={1080}
        height={1350}
        defaultProps={{
          role: "hook", slideIndex: 0, slideCount: 5,
          kicker: "JUST LISTED · NAPLES, FL",
          title: "128 Harborview Lane",
          body: "$1,250,000",
          photoUrl: null, statValue: "", statLabel: "",
          agentName: "Your Agent", agentPhotoUrl: null,
          handleLine: "Your Brokerage",
          brand: { primaryColor: "#0F172A", accentColor: "#F59E0B", logoUrl: null, brokerageName: "Your Brokerage", licenseLine: null, showEhoMark: true },
        }}
      />

      {/* THE DOOR HANGER — 4.25x11 @ 300 DPI print still (bleed canvas
          1350x3375, dashed die-cut knob guide). The just-sold door-knock
          piece: neighbor hook + scan-to-value QR + agent block. */}
      <Composition
        id="DoorHanger"
        component={DoorHanger as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={1}
        fps={30}
        width={1350}
        height={3375}
        defaultProps={{
          headline: "JUST SOLD",
          address: "128 Harborview Lane", cityState: "Naples, FL 34102",
          heroImageUrl: null,
          hook: "Curious what YOUR home is worth in today's market?",
          agentName: "Your Agent", agentPhone: null, agentPhotoUrl: null,
          qrCodeDataUrl: null, qrCaption: "Scan for your home's value",
          brand: { primaryColor: "#0F172A", accentColor: "#F59E0B", logoUrl: null, brokerageName: "Your Brokerage", licenseLine: null, showEhoMark: true },
        }}
      />

      <Composition
        id="PostcardFront4x6"
        component={PostcardFront4x6 as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={1}
        fps={30}
        width={1275}
        height={1875}
        defaultProps={{
          headline:      "Your block, your number",
          body:          "Homes on your street sold in 11 days last month. Curious what yours would do today?",
          cta:           "Get your home's number",
          qrCodeDataUrl: null,
          brand: {
            primaryColor:    "#0F172A",
            accentColor:     "#F59E0B",
            logoUrl:         null,
            brokerageName:   "Your Brokerage",
            // NO SAMPLE CONTACT DETAILS. A brand block is classified COSMETIC by
            // lib/remotion/content-contract, so unlike the content props these
            // defaults REMAIN reachable on a real render — and these three were a
            // phone number, a website and a state licence number that would have
            // been printed onto a mailed postcard. Null renders the block empty,
            // which is honest; the tenant's real values arrive via resolveReelBrand.
            websiteWordmark: null,
            phone:           null,
            licenseLine:     null,
            shortDisclosure: "Equal Housing Opportunity. All information deemed reliable but not guaranteed.",
          },
        }}
      />
      {/* Wave 36 — 4×6 postcard back. Left ~48% holds body+signature;
          right ~52% kept empty for Lob's address indicia overlay.

          NO SAMPLE OPT-OUT. optOutLine and optOutQrDataUrl default to null,
          and they are the one pair of props on this card where a plausible
          default would be actively dangerous: a token identifies a PERSON, so
          a sample token printed on every card in a run would hand whoever
          scans it the power to suppress one arbitrary stranger — or nobody,
          if it names no live row, which is the same card carrying an opt-out
          that silently does not work. Null renders the row absent, and
          lib/remotion/content-contract.ts declares optOutLine REQUIRED, so a
          real send arriving here with no recipient token is a refusable
          render rather than a mailed piece with no way to say stop. Filled in
          per recipient by lib/direct-mail/mail-opt-out-affordance.ts.

          (This note lives OUTSIDE defaultProps on purpose: the content-contract
          guard parses that block as text, and a comment inside it hides the
          prop that follows — an apostrophe in one even swallows the rest of
          the block as a string literal.) */}
      <Composition
        id="PostcardBack4x6"
        component={PostcardBack4x6 as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={1}
        fps={30}
        width={1275}
        height={1875}
        defaultProps={{
          body:          "Homes on your street sold in 11 days last month. Curious what yours would do today?",
          signoff:       "— Your agent",
          agentPhotoUrl: null,
          agentName:     "Your Agent",
          optOutLine:      null,
          optOutQrDataUrl: null,
          brand: {
            primaryColor:    "#0F172A",
            accentColor:     "#F59E0B",
            logoUrl:         null,
            brokerageName:   "Your Brokerage",
            // NO SAMPLE CONTACT DETAILS. A brand block is classified COSMETIC by
            // lib/remotion/content-contract, so unlike the content props these
            // defaults REMAIN reachable on a real render — and these three were a
            // phone number, a website and a state licence number that would have
            // been printed onto a mailed postcard. Null renders the block empty,
            // which is honest; the tenant's real values arrive via resolveReelBrand.
            websiteWordmark: null,
            phone:           null,
            licenseLine:     null,
            shortDisclosure: "Equal Housing Opportunity. All information deemed reliable but not guaranteed.",
          },
        }}
      />
      {/* Wave 36 — 6×9 postcard front (Lob premium tier, 1875×2775 bleed).
          Photo hero top 55%, headline + body + CTA + QR below. Used for
          listing promos (just_listed/just_sold/open_house), luxury
          persona pieces, and lifetime-customer reach-outs where the
          extra canvas earns its ~$1.10 cost. */}
      <Composition
        id="PostcardFront6x9"
        component={PostcardFront6x9 as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={1}
        fps={30}
        width={1875}
        height={2775}
        defaultProps={{
          headline:    "Coming this Saturday",
          body:        "Open house at 185 Berry Street — modern 3-bed with rooftop deck. Stop by between 12 and 2.",
          cta:         "See the photos",
          statusBadge: "OPEN HOUSE",
          propertyPhotoUrl: null,
          qrCodeDataUrl:    null,
          brand: {
            primaryColor:    "#0F172A",
            accentColor:     "#F59E0B",
            logoUrl:         null,
            brokerageName:   "Your Brokerage",
            // NO SAMPLE CONTACT DETAILS. A brand block is classified COSMETIC by
            // lib/remotion/content-contract, so unlike the content props these
            // defaults REMAIN reachable on a real render — and these three were a
            // phone number, a website and a state licence number that would have
            // been printed onto a mailed postcard. Null renders the block empty,
            // which is honest; the tenant's real values arrive via resolveReelBrand.
            websiteWordmark: null,
            phone:           null,
            licenseLine:     null,
            shortDisclosure: "Equal Housing Opportunity. All information deemed reliable but not guaranteed.",
          },
        }}
      />
      {/* Wave 36 — 6×9 postcard back. Same indicia keep-out as 4×6
          back; 6×9 gets room for a pull quote + 2-3 paragraphs of body. */}
      <Composition
        id="PostcardBack6x9"
        component={PostcardBack6x9 as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={1}
        fps={30}
        width={1875}
        height={2775}
        defaultProps={{
          body:          "Open houses are where the real conversations happen. Even if you're a year out, come walk through — you'll see what's possible.",
          pullQuote:     "The best buyers don't wait for the listing — they tour the neighborhood first.",
          signoff:       "— Your agent",
          agentPhotoUrl: null,
          agentName:     "Your Agent",
          brand: {
            primaryColor:    "#0F172A",
            accentColor:     "#F59E0B",
            logoUrl:         null,
            brokerageName:   "Your Brokerage",
            // NO SAMPLE CONTACT DETAILS. A brand block is classified COSMETIC by
            // lib/remotion/content-contract, so unlike the content props these
            // defaults REMAIN reachable on a real render — and these three were a
            // phone number, a website and a state licence number that would have
            // been printed onto a mailed postcard. Null renders the block empty,
            // which is honest; the tenant's real values arrive via resolveReelBrand.
            websiteWordmark: null,
            phone:           null,
            licenseLine:     null,
            shortDisclosure: "Equal Housing Opportunity. All information deemed reliable but not guaranteed.",
          },
        }}
      />
      {/* THE PARTNERS' MEETING — the AI team's weekly recap show, narrated by the broker's D-ID
          avatar. Earned stat cards (deals/plays/drills/whispers/handoffs) + the Finance Manager's
          booked-GCI card + the Compliance Officer's pre-flight disposition (the differentiator) +
          the one ask. 1920×1080 desk/TV format, 30s @ 30fps = 900 frames; the composition packs the
          earned cards into the card window so a quiet week is honest, not padded. */}
      <Composition
        id="PartnersMeetingReel"
        component={PartnersMeetingReel as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={900}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          weekLabel: "the week of 2026-06-15",
          cards: [
            { value: "2", label: "DEALS CLOSED", sub: "this week", kind: "team" },
            { value: "3", label: "TEAM PLAYS", sub: "managers coordinated, not scattered", kind: "team" },
            { value: "1", label: "DEADLINES SAVED", sub: "caught before they burned a deal", kind: "team" },
            { value: "$18K", label: "GROSS COMMISSION BOOKED", sub: "$1.2M weighted in the pipeline", kind: "finance" },
            { value: "31", label: "OUTBOUND PRE-FLIGHTED", sub: "4 Fair-Housing/consent fixes caught · 1 released over objection", kind: "compliance" },
          ],
          oneAsk: "5 proposals waiting on you",
          narration: null,
          agentName: "Your Team",
          avatarVideoUrl: null,
          agentPhotoUrl: null,
          brand: {
            primaryColor: "#0F172A",
            accentColor: "#F59E0B",
            brokerageName: "Your Brokerage",
            showEhoMark: true,
            logoUrl: null,
          },
        }}
      />
      {/* PLATFORM SELF-MARKETING — VIP Agents' own promo (text-motion, no photo/
          D-ID cost). 15s @30fps vertical; props come from the product content
          engine's PRODUCT_ANGLES so text posts + video tell ONE honest story. */}
      <Composition
        id="ProductPromoReel"
        component={ProductPromoReel as unknown as React.FC<Record<string, unknown>>}
        durationInFrames={450}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{
          hook: "Most real-estate software is another dashboard. VIP Agents is an AI TEAM.",
          proofs: [
            "13 accountable AI managers hand real work to each other — lead to deal to lifetime client.",
            "One command center. Every action owned, gated, and auditable.",
            "A voice admin that takes a command and executes it end to end.",
          ],
          cta: "See the AI team hand a real deal between managers — live.",
          brand: { primaryColor: "#0F172A", accentColor: "#F59E0B", name: "VIP Agents", tagline: "The AI team that runs the whole business" },
          ctaDomain: "vipagents.ai/get-started",
        }}
      />
    </>
  )
}
