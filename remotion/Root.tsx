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
