/**
 * remotion/components/EqualHousingMark.tsx
 *
 * THE shared Equal Housing Opportunity attribution — §6, one vocabulary. Wave
 * 48/49 found remotion/NewsletterDigestThumb.tsx (the persona inbox-preview
 * card rendered alongside every newsletter video) carrying no fair-housing
 * mark at all while its sibling remotion/VideoCoverThumb.tsx (the universal
 * og:image thumbnail for every other video) always renders one — a card the
 * newsletter video's own audience never sees fails the same federal
 * attribution requirement every other listing/market-facing surface honors
 * (scripts/video-assembly-simulator.ts's §branding section already proves
 * this rule fleet-wide for the VIDEO compositions themselves; the two THUMB
 * stills sit outside that sweep's corpus, which is exactly how this one went
 * unnoticed).
 *
 * Both thumbnails now render through this ONE component instead of each
 * typing its own copy of the string + styling:
 *   - VideoCoverThumb.tsx    → variant="inline" (sits inside the footer
 *                              sentence beside the brokerage name)
 *   - NewsletterDigestThumb.tsx → variant="inline" (new — the finding above)
 *
 * MERGED (wave 50): the near-identical `EhoBadge` locals formerly in
 * remotion/JustListedReel.tsx and remotion/PhotoWalkthroughReel.tsx — the same
 * `variant="badge"`-shaped absolutely-positioned pill, a different anchor from
 * the "inline" variant above — now render THIS component (tombstones at each
 * file's former EhoBadge definition name this survivor). Because
 * scripts/video-assembly-simulator.ts's §branding section regex-scanned EACH
 * COMPOSITION's OWN stripped source for the literal "Equal Housing Opportunity"
 * string, moving the string behind this import would have read as the mark
 * going MISSING; brandingSection()'s check now also accepts a composition that
 * imports EqualHousingMark and renders `<EqualHousingMark` (rendersEhoMark()),
 * so an imported shared mark counts exactly like an inline literal.
 */
import React from "react"
import { useVideoConfig } from "remotion"
import { cinemaBadgeSlot, cinemaTypeScale } from "../../lib/video/cinema-finish"

export interface EqualHousingMarkProps {
  /** Show the mark. Defaults true — the composition's own brand.showEhoMark
   *  (or an equivalent explicit false) is the only reason to omit it; the
   *  mark itself never defaults to hidden. */
  show?: boolean
  /** "inline" — plain text meant to sit inside an existing text line (a
   *  footer sentence, a byline) — used by VideoCoverThumb and
   *  NewsletterDigestThumb. "badge" — a self-positioned pill anchored
   *  bottom-left over a full-bleed frame — used by JustListedReel and
   *  PhotoWalkthroughReel, merged onto this survivor (see file header). */
  variant?: "inline" | "badge"
  fontSize?: number
  color?: string
  opacity?: number
  fontFamily?: string
}

const EHO_TEXT = "Equal Housing Opportunity"

export const EqualHousingMark: React.FC<EqualHousingMarkProps> = ({
  show = true, variant = "inline", fontSize, color, opacity, fontFamily,
}) => {
  // The hook runs unconditionally (React rules); a still card with no
  // <Composition> context is never a caller of the badge variant.
  const { width, height } = useVideoConfig()
  if (!show) return null

  if (variant === "badge") {
    // WAVE 89 (lane 89F) — the pill sits in the frame's badge slot (lib/video/
    // cinema-finish.ts cinemaBadgeSlot: inside the safe left inset, above the
    // caption band) on the scale's caption step. It was a typed 24 px corner in
    // 14 px type — inside the platform UI band and under the burned captions.
    const slot = cinemaBadgeSlot(width, height)
    return (
      <div style={{
        position: "absolute",
        bottom: slot.bottom,
        left: slot.left,
        backgroundColor: "rgba(255,255,255,0.9)",
        color: "#000",
        padding: "6px 12px",
        borderRadius: 6,
        fontSize: fontSize ?? cinemaTypeScale(width, height).caption,
        fontWeight: 600,
        ...(fontFamily ? { fontFamily } : {}),
      }}>
        {EHO_TEXT}
      </div>
    )
  }

  return (
    <span style={{
      ...(fontSize !== undefined ? { fontSize } : {}),
      ...(color !== undefined ? { color } : {}),
      ...(opacity !== undefined ? { opacity } : {}),
      ...(fontFamily ? { fontFamily } : {}),
    }}>
      {EHO_TEXT}
    </span>
  )
}
