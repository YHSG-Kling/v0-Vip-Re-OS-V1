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
import { JustListedReelHorizontal } from "./JustListedReelHorizontal"
import { JustSoldReelSquare } from "./JustSoldReelSquare"
import { ComingSoonReel } from "./ComingSoonReel"
import { OpenHouseAnnounceReel } from "./OpenHouseAnnounceReel"
import { AgentTalkingHeadReel } from "./AgentTalkingHeadReel"
import { AgentExplainerReel } from "./AgentExplainerReel"
import { TestimonialReel } from "./TestimonialReel"
import { NeighborhoodSpotlightReel } from "./NeighborhoodSpotlightReel"
import { MarketUpdateReel } from "./MarketUpdateReel"
import { ListingPresentationSlide } from "./ListingPresentationSlide"
import { LeadMagnetCard } from "./LeadMagnetCard"
import { NewsletterDigestVideo } from "./NewsletterDigestVideo"
import { NewsletterDigestThumb } from "./NewsletterDigestThumb"
import { PostcardFront4x6 } from "./PostcardFront4x6"
import { PostcardBack4x6 } from "./PostcardBack4x6"
import { PostcardFront6x9 } from "./PostcardFront6x9"
import { PostcardBack6x9 } from "./PostcardBack6x9"

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
          agentPhone: "(555) 555-1212",
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
          agentPhone: "(555) 555-1212",
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
          agentPhone:   "(555) 555-1212",
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
      {/* Wave 39 — 1200×630 Open-Graph lead-magnet card. Used by the
          W40 ad creator for FB lead-form ads, LinkedIn Sponsored
          Content, X/Twitter cards, and email-share fallback. Static
          composition; renderStill() emits the PNG. */}
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
            websiteWordmark: "yourbrokerage.com",
            phone:           "(555) 555-1212",
            licenseLine:     "CA License # 02345678",
            shortDisclosure: "Equal Housing Opportunity. All information deemed reliable but not guaranteed.",
          },
        }}
      />
      {/* Wave 36 — 4×6 postcard back. Left ~48% holds body+signature;
          right ~52% kept empty for Lob's address indicia overlay. */}
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
          brand: {
            primaryColor:    "#0F172A",
            accentColor:     "#F59E0B",
            logoUrl:         null,
            brokerageName:   "Your Brokerage",
            websiteWordmark: "yourbrokerage.com",
            phone:           "(555) 555-1212",
            licenseLine:     "CA License # 02345678",
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
            websiteWordmark: "yourbrokerage.com",
            phone:           "(555) 555-1212",
            licenseLine:     "CA License # 02345678",
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
            websiteWordmark: "yourbrokerage.com",
            phone:           "(555) 555-1212",
            licenseLine:     "CA License # 02345678",
            shortDisclosure: "Equal Housing Opportunity. All information deemed reliable but not guaranteed.",
          },
        }}
      />
    </>
  )
}
