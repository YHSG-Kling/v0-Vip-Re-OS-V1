/**
 * remotion/ListingPresentationSlide.tsx
 *
 * Wave 39 — the listing-presentation differentiator. Most real-
 * estate listing presentations today are static PDFs the seller-side
 * agent emails to the homeowner before the appointment. Conversion
 * data across the industry: those PDFs get opened ~38% of the time
 * and read all the way through ~6% of the time.
 *
 * This composition is one SLIDE of a multi-slide presentation video
 * — the agent's avatar narrates each slide via D-ID, the brokerage
 * brand owns the page chrome, and the listing presentation becomes
 * a 5-8 minute personalized video the homeowner actually watches.
 * Conversion-data benchmark for narrated video presentations is
 * 60-75% completion. The shift in attention is the moat.
 *
 * Single-slide format (1920×1080 horizontal — wide enough that the
 * avatar PIP doesn't fight the body content; matches the laptop /
 * tablet / TV the homeowner is watching on):
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  brand chrome (logo top-L, slide number top-R)               │
 *   │                                                              │
 *   │  SLIDE TITLE                                                 │
 *   │                                                              │
 *   │  [optional hero image / chart]    [avatar PIP — bottom-R]    │
 *   │  Body paragraph(s)                                           │
 *   │                                                              │
 *   │  brokerage attribution (footer)                              │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Composer flow:
 *   The presentation-video-composer (separate orchestrator, lands
 *   with W40+ work) chains 5–12 of these slides end-to-end. Each
 *   slide gets a different chunk of the avatar video (D-ID stitches
 *   the full narration into one mp4; we play the right slice per
 *   slide via `startFrame`/`endFrame`). One D-ID job, one ffmpeg
 *   concatenation pass — final deliverable is a single mp4 the
 *   agent sends as a portal asset + email attachment.
 *
 * Per-slide duration is the LOG-related field: the composer
 * computes it from the narration length for that slide (passed via
 * `durationInFrames` at chain time), so the slide and the audio
 * stay in sync without a separate sync pass.
 *
 * Slide kinds (visual layouts the body can take):
 *   - "title"     full-bleed title + subhead, avatar centered
 *   - "image"     hero image left ~60% + body text right ~40%
 *   - "chart"     SVG/canvas chart left + body right (W40 will
 *                 supply the chart payload as React content)
 *   - "comps"     side-by-side comparable-properties grid
 *   - "closing"   centered CTA + agent contact info
 *
 * For this composition we render the "image" + "title" + "closing"
 * variants natively; the "chart" + "comps" variants accept arbitrary
 * React children via the `bodyContent` prop so the composer can
 * inject whatever it needs without forking compositions.
 */
import React from "react"
import { Video } from "@remotion/media"
import {
  AbsoluteFill,
  Img,
  interpolate,
  useCurrentFrame,
} from "remotion"

export type SlideKind = "title" | "image" | "comps" | "chart" | "closing"

export interface ListingPresentationSlideProps {
  kind:           SlideKind
  /** 1-based slide index (e.g. 3 of 8). */
  slideNumber:    number
  totalSlides:    number
  title:          string
  /** Body paragraphs — array so each renders with a paragraph gap. */
  body:           string[]
  /** Optional hero image (used when kind='image'). */
  heroImageUrl?:  string | null
  /** Custom React content for chart/comps slides. The composer
   *  hands in whatever it needs; this composition just frames it. */
  bodyContent?:   React.ReactNode
  /** D-ID avatar narration for THIS slide. The composer passes the
   *  full narration video and the slice that maps to this slide. */
  avatarVideoUrl: string | null
  avatarStartFrame: number
  avatarEndFrame:   number
  /** Agent's static photo fallback. */
  agentPhotoUrl:  string | null
  /** Agent's display name — used in the bottom-right name plate. */
  agentName:      string
  brand: {
    primaryColor:    string
    accentColor:     string
    surfaceColor?:   string   // body background; defaults to #FFFFFF
    logoUrl?:        string
    brokerageName:   string
    licenseLine?:    string
    showEhoMark?:    boolean
  }
}

export const ListingPresentationSlide: React.FC<ListingPresentationSlideProps> = ({
  kind, slideNumber, totalSlides, title, body, heroImageUrl,
  bodyContent, avatarVideoUrl, avatarStartFrame, avatarEndFrame,
  agentPhotoUrl, agentName, brand,
}) => {
  const surface = brand.surfaceColor ?? "#FFFFFF"
  const showEho = brand.showEhoMark ?? true

  return (
    <AbsoluteFill style={{
      backgroundColor: surface,
      fontFamily: "system-ui, -apple-system, sans-serif",
      color: brand.primaryColor,
    }}>
      {/* Brand chrome — top bar */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, height: 80,
        backgroundColor: brand.primaryColor, color: "#fff",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 48px",
      }}>
        {brand.logoUrl ? (
          <Img src={brand.logoUrl} style={{ height: 40, objectFit: "contain" }} />
        ) : (
          <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: 2 }}>{brand.brokerageName}</div>
        )}
        <div style={{ fontSize: 16, letterSpacing: 3, color: brand.accentColor, fontWeight: 600 }}>
          {String(slideNumber).padStart(2, "0")} / {String(totalSlides).padStart(2, "0")}
        </div>
      </div>

      {/* Body region — varies by slide kind */}
      <div style={{
        position: "absolute", top: 80, left: 0, right: 0, bottom: 120,
        padding: "48px 56px",
      }}>
        {kind === "title" && (
          <TitleSlideBody title={title} body={body} accentColor={brand.accentColor} />
        )}
        {kind === "image" && (
          <ImageSlideBody title={title} body={body} heroImageUrl={heroImageUrl ?? null} accentColor={brand.accentColor} />
        )}
        {(kind === "chart" || kind === "comps") && (
          <ChartOrCompsSlideBody title={title} body={body} accentColor={brand.accentColor}>
            {bodyContent}
          </ChartOrCompsSlideBody>
        )}
        {kind === "closing" && (
          <ClosingSlideBody title={title} body={body} accentColor={brand.accentColor} brand={brand} />
        )}
      </div>

      {/* Avatar PIP — bottom-right. ~280×280 with brand-accent ring.
          The slide's avatar slice plays underneath; the homeowner
          sees a continuous narration even as slide content cuts. */}
      <AvatarPIP
        avatarVideoUrl={avatarVideoUrl}
        agentPhotoUrl={agentPhotoUrl}
        agentName={agentName}
        startFrame={avatarStartFrame}
        endFrame={avatarEndFrame}
        accentColor={brand.accentColor}
        primaryColor={brand.primaryColor}
      />

      {/* Bottom-left agent name plate */}
      <div style={{
        position: "absolute", bottom: 32, left: 56,
        display: "flex", alignItems: "center", gap: 12,
      }}>
        <div style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: brand.accentColor }} />
        <div style={{ fontSize: 18, fontWeight: 600, color: brand.primaryColor }}>{agentName}</div>
      </div>

      {/* Footer attribution */}
      <div style={{
        position: "absolute", bottom: 0, left: 0, right: 0, height: 40,
        backgroundColor: brand.primaryColor, color: "#fff", opacity: 0.85,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 12, letterSpacing: 1,
      }}>
        {brand.brokerageName}
        {showEho && " · Equal Housing Opportunity"}
        {brand.licenseLine && ` · ${brand.licenseLine}`}
      </div>
    </AbsoluteFill>
  )
}

/* ─────────── slide body kinds ─────────── */

const TitleSlideBody: React.FC<{ title: string; body: string[]; accentColor: string }> = ({ title, body, accentColor }) => {
  const frame = useCurrentFrame()
  return (
    <div style={{
      height: "100%", display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", textAlign: "center",
    }}>
      <div style={{
        width: 64, height: 4, backgroundColor: accentColor, marginBottom: 32,
        opacity: interpolate(frame, [0, 12], [0, 1]),
      }} />
      <div style={{
        fontSize: 84, fontWeight: 800, lineHeight: 1.05, marginBottom: 24,
        opacity: interpolate(frame, [6, 24], [0, 1]),
      }}>
        {title}
      </div>
      {body.map((p, i) => (
        <div key={i} style={{
          fontSize: 28, opacity: interpolate(frame, [18 + i * 6, 36 + i * 6], [0, 0.8]),
          maxWidth: 1200, lineHeight: 1.45,
        }}>{p}</div>
      ))}
    </div>
  )
}

const ImageSlideBody: React.FC<{
  title: string; body: string[]; heroImageUrl: string | null; accentColor: string
}> = ({ title, body, heroImageUrl, accentColor }) => {
  return (
    <div style={{ height: "100%", display: "flex", gap: 48 }}>
      <div style={{ width: "58%", height: "100%", borderRadius: 12, overflow: "hidden", backgroundColor: "#E5E7EB" }}>
        {heroImageUrl ? (
          <Img src={heroImageUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <div style={{
            width: "100%", height: "100%", display: "flex",
            alignItems: "center", justifyContent: "center",
            color: "#9CA3AF", fontSize: 24,
          }}>Photo placeholder</div>
        )}
      </div>
      <div style={{ width: "42%", display: "flex", flexDirection: "column", justifyContent: "center" }}>
        <div style={{ width: 48, height: 4, backgroundColor: accentColor, marginBottom: 20 }} />
        <div style={{ fontSize: 48, fontWeight: 800, lineHeight: 1.1, marginBottom: 24 }}>
          {title}
        </div>
        {body.map((p, i) => (
          <div key={i} style={{ fontSize: 22, lineHeight: 1.5, marginBottom: 16, opacity: 0.85 }}>{p}</div>
        ))}
      </div>
    </div>
  )
}

const ChartOrCompsSlideBody: React.FC<{
  title: string; body: string[]; accentColor: string; children?: React.ReactNode
}> = ({ title, body, accentColor, children }) => {
  return (
    <div style={{ height: "100%", display: "flex", gap: 48 }}>
      <div style={{ width: "62%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
        {children ?? (
          <div style={{ color: "#9CA3AF", fontSize: 22, fontStyle: "italic" }}>
            Chart / comp grid loaded by the composer
          </div>
        )}
      </div>
      <div style={{ width: "38%", display: "flex", flexDirection: "column", justifyContent: "center" }}>
        <div style={{ width: 48, height: 4, backgroundColor: accentColor, marginBottom: 20 }} />
        <div style={{ fontSize: 42, fontWeight: 800, lineHeight: 1.1, marginBottom: 24 }}>
          {title}
        </div>
        {body.map((p, i) => (
          <div key={i} style={{ fontSize: 20, lineHeight: 1.5, marginBottom: 14, opacity: 0.85 }}>{p}</div>
        ))}
      </div>
    </div>
  )
}

const ClosingSlideBody: React.FC<{
  title: string; body: string[]; accentColor: string
  brand: ListingPresentationSlideProps["brand"]
}> = ({ title, body, accentColor, brand }) => {
  return (
    <div style={{
      height: "100%", display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", textAlign: "center",
    }}>
      <div style={{
        display: "inline-block", padding: "10px 24px", borderRadius: 6,
        backgroundColor: accentColor, color: brand.primaryColor,
        fontSize: 16, fontWeight: 700, letterSpacing: 4, textTransform: "uppercase",
        marginBottom: 28,
      }}>
        Next step
      </div>
      <div style={{ fontSize: 64, fontWeight: 800, lineHeight: 1.05, marginBottom: 24 }}>
        {title}
      </div>
      {body.map((p, i) => (
        <div key={i} style={{ fontSize: 24, lineHeight: 1.45, opacity: 0.8, maxWidth: 1100, marginBottom: 8 }}>{p}</div>
      ))}
    </div>
  )
}

/* ─────────── avatar PIP ─────────── */

const AvatarPIP: React.FC<{
  avatarVideoUrl: string | null
  agentPhotoUrl:  string | null
  agentName:      string
  startFrame:     number
  endFrame:       number
  accentColor:    string
  primaryColor:   string
}> = ({ avatarVideoUrl, agentPhotoUrl, agentName, startFrame, endFrame, accentColor, primaryColor }) => {
  const ring: React.CSSProperties = {
    position: "absolute", bottom: 64, right: 56,
    width: 280, height: 280,
    borderRadius: 140,
    boxShadow: `0 0 0 5px ${accentColor}, 0 24px 48px rgba(0,0,0,0.18)`,
    overflow: "hidden",
    backgroundColor: primaryColor,
  }
  if (avatarVideoUrl) {
    return (
      <div style={ring}>
        <Video
          objectFit="cover"
          src={avatarVideoUrl}
          trimBefore={startFrame}
          trimAfter={endFrame}
          style={{ width: "100%", height: "100%" }}
        />
      </div>
    )
  }
  if (agentPhotoUrl) {
    return (
      <div style={ring}>
        <Img src={agentPhotoUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
    )
  }
  return (
    <div style={{
      ...ring,
      backgroundColor: accentColor,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: 100, color: primaryColor, fontWeight: 800,
    }}>
      {(agentName[0] ?? "A").toUpperCase()}
    </div>
  )
}
