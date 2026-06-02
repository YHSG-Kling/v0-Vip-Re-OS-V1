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
    </>
  )
}
