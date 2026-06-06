/**
 * remotion/BuyerConsultationSlide.tsx
 *
 * Wave 39 — buyer-side counterpart to ListingPresentationSlide.
 * Same composer pattern: one SLIDE of an N-slide narrated video
 * presentation, the agent's avatar narrates from a bottom-right
 * PIP, brand chrome owns the page. Chained 5-10 of these end to
 * end to ship a personalized buyer consultation video the lead
 * actually watches.
 *
 * Why buyer-side needs its own slide kinds (vs reusing the
 * listing one):
 *   · Listing presentations are CMAs + strategy → "image" / "chart"
 *     / "comps" do the work.
 *   · Buyer consultations are JOURNEY + EDUCATION → "search", "loan",
 *     "offer_strategy", "timeline" do the work. The visual layouts
 *     differ; cramming both into one composition forces the composer
 *     into awkward fork branches.
 *
 * The "shopping_search" slide is the killer for the buyer side —
 * shows three example listings with photo + price + bd/ba in a
 * row so the lead sees "this is what your budget actually buys
 * RIGHT NOW in the market you asked about". No competitor ships
 * personalized search-result rows inside a narrated avatar video.
 *
 * Tier note: this composition is the same shape ListingPresentation
 * uses; tier access is enforced at the caller layer via the
 * composition registry (m168 + lib/remotion/registry.ts).
 */
import React from "react"
import {
  AbsoluteFill,
  Img,
  Video,
  interpolate,
  useCurrentFrame,
} from "remotion"

export type BuyerSlideKind =
  | "title"
  | "loan"           // "What pre-approval actually tells sellers"
  | "search"         // "Three homes that fit your search today"
  | "offer_strategy" // "How we'd win a bidding war on these"
  | "timeline"       // "From signed offer to closing day"
  | "closing"

export interface BuyerSearchExample {
  /** Property address line. */
  address:   string
  cityState: string
  price:     string
  bedrooms:  string
  bathrooms: string
  photoUrl:  string | null
}

export interface BuyerConsultationSlideProps {
  kind:           BuyerSlideKind
  slideNumber:    number
  totalSlides:    number
  title:          string
  /** Body paragraphs — each gets its own gap. */
  body:           string[]
  /** Used by kind='search' — 1-3 example listings shown in a row. */
  searchExamples?: BuyerSearchExample[]
  /** Used by kind='timeline' — labeled checkpoints across the slide.
   *  Composer passes 3-5 ("Offer accepted", "Inspection", "Appraisal",
   *  "Closing"). */
  timelineLabels?: string[]
  /** Hero image (loan slide often shows a closing-day photo). */
  heroImageUrl?:  string | null
  bodyContent?:   React.ReactNode
  avatarVideoUrl: string | null
  avatarStartFrame: number
  avatarEndFrame:   number
  agentPhotoUrl:  string | null
  agentName:      string
  brand: {
    primaryColor:    string
    accentColor:     string
    surfaceColor?:   string
    logoUrl?:        string
    brokerageName:   string
    licenseLine?:    string
    showEhoMark?:    boolean
  }
}

const SURFACE_DEFAULT = "#FFFFFF"

export const BuyerConsultationSlide: React.FC<BuyerConsultationSlideProps> = ({
  kind, slideNumber, totalSlides, title, body, searchExamples,
  timelineLabels, heroImageUrl, bodyContent, avatarVideoUrl,
  avatarStartFrame, avatarEndFrame, agentPhotoUrl, agentName, brand,
}) => {
  const surface = brand.surfaceColor ?? SURFACE_DEFAULT
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
        {/* "BUYER GUIDE" wordmark instead of generic slide number on
            the cover-style kinds — sets the document's tone. */}
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{
            padding: "4px 12px", borderRadius: 4,
            backgroundColor: brand.accentColor, color: brand.primaryColor,
            fontSize: 13, fontWeight: 800, letterSpacing: 4, textTransform: "uppercase",
          }}>
            Buyer Guide
          </div>
          <div style={{ fontSize: 16, letterSpacing: 3, color: brand.accentColor, fontWeight: 600 }}>
            {String(slideNumber).padStart(2, "0")} / {String(totalSlides).padStart(2, "0")}
          </div>
        </div>
      </div>

      {/* Body region — varies by slide kind */}
      <div style={{
        position: "absolute", top: 80, left: 0, right: 0, bottom: 120,
        padding: "48px 56px",
      }}>
        {kind === "title" && <TitleSlideBody title={title} body={body} accentColor={brand.accentColor} />}
        {kind === "loan" && <LoanSlideBody title={title} body={body} heroImageUrl={heroImageUrl ?? null} accentColor={brand.accentColor} />}
        {kind === "search" && (
          <SearchSlideBody title={title} body={body} examples={searchExamples ?? []} accentColor={brand.accentColor} primaryColor={brand.primaryColor} />
        )}
        {kind === "offer_strategy" && (
          <OfferStrategyBody title={title} body={body} accentColor={brand.accentColor}>
            {bodyContent}
          </OfferStrategyBody>
        )}
        {kind === "timeline" && (
          <TimelineSlideBody title={title} body={body} labels={timelineLabels ?? []} accentColor={brand.accentColor} primaryColor={brand.primaryColor} />
        )}
        {kind === "closing" && <ClosingSlideBody title={title} body={body} accentColor={brand.accentColor} brand={brand} />}
      </div>

      <AvatarPIP
        avatarVideoUrl={avatarVideoUrl}
        agentPhotoUrl={agentPhotoUrl}
        agentName={agentName}
        startFrame={avatarStartFrame}
        endFrame={avatarEndFrame}
        accentColor={brand.accentColor}
        primaryColor={brand.primaryColor}
      />

      <div style={{
        position: "absolute", bottom: 32, left: 56,
        display: "flex", alignItems: "center", gap: 12,
      }}>
        <div style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: brand.accentColor }} />
        <div style={{ fontSize: 18, fontWeight: 600, color: brand.primaryColor }}>{agentName}</div>
      </div>

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

/* ─────────── slide bodies ─────────── */

const TitleSlideBody: React.FC<{ title: string; body: string[]; accentColor: string }> = ({
  title, body, accentColor,
}) => {
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
          fontSize: 26, opacity: interpolate(frame, [18 + i * 6, 36 + i * 6], [0, 0.8]),
          maxWidth: 1200, lineHeight: 1.45,
        }}>{p}</div>
      ))}
    </div>
  )
}

const LoanSlideBody: React.FC<{
  title: string; body: string[]; heroImageUrl: string | null; accentColor: string
}> = ({ title, body, heroImageUrl, accentColor }) => (
  <div style={{ height: "100%", display: "flex", gap: 48 }}>
    <div style={{ width: "42%", display: "flex", flexDirection: "column", justifyContent: "center" }}>
      <div style={{ width: 48, height: 4, backgroundColor: accentColor, marginBottom: 20 }} />
      <div style={{ fontSize: 48, fontWeight: 800, lineHeight: 1.1, marginBottom: 24 }}>
        {title}
      </div>
      {body.map((p, i) => (
        <div key={i} style={{ fontSize: 22, lineHeight: 1.5, marginBottom: 16, opacity: 0.85 }}>{p}</div>
      ))}
    </div>
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
  </div>
)

const SearchSlideBody: React.FC<{
  title: string; body: string[]; examples: BuyerSearchExample[]; accentColor: string; primaryColor: string
}> = ({ title, body, examples, accentColor, primaryColor }) => {
  const three = examples.slice(0, 3)
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ marginBottom: 24 }}>
        <div style={{ width: 48, height: 4, backgroundColor: accentColor, marginBottom: 16 }} />
        <div style={{ fontSize: 40, fontWeight: 800, lineHeight: 1.05 }}>
          {title}
        </div>
        {body.map((p, i) => (
          <div key={i} style={{ fontSize: 18, lineHeight: 1.4, marginTop: 8, opacity: 0.8 }}>{p}</div>
        ))}
      </div>
      <div style={{ flex: 1, display: "flex", gap: 20 }}>
        {three.length === 0 ? (
          <div style={{
            width: "100%", display: "flex", alignItems: "center", justifyContent: "center",
            backgroundColor: "#F3F4F6", borderRadius: 12, color: "#9CA3AF", fontSize: 20, fontStyle: "italic",
          }}>
            Search results loaded by the composer
          </div>
        ) : three.map((ex, i) => (
          <div key={i} style={{
            flex: 1, borderRadius: 12, overflow: "hidden",
            boxShadow: `0 4px 16px rgba(0,0,0,0.12)`,
            display: "flex", flexDirection: "column",
            border: `1px solid ${primaryColor}22`,
          }}>
            <div style={{ height: "55%", backgroundColor: "#E5E7EB" }}>
              {ex.photoUrl ? (
                <Img src={ex.photoUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                <div style={{
                  width: "100%", height: "100%", display: "flex",
                  alignItems: "center", justifyContent: "center",
                  color: "#9CA3AF", fontSize: 16,
                }}>Photo</div>
              )}
            </div>
            <div style={{ padding: "16px 20px", flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: 28, fontWeight: 800, color: accentColor, marginBottom: 4 }}>
                  {ex.price}
                </div>
                <div style={{ fontSize: 14, opacity: 0.7 }}>
                  {ex.bedrooms} bd · {ex.bathrooms} ba
                </div>
              </div>
              <div style={{
                fontSize: 16, fontWeight: 600, lineHeight: 1.3, marginTop: 12,
                color: primaryColor,
              }}>
                {ex.address}
                <div style={{ fontSize: 13, opacity: 0.6, fontWeight: 500, marginTop: 2 }}>
                  {ex.cityState}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

const OfferStrategyBody: React.FC<{
  title: string; body: string[]; accentColor: string; children?: React.ReactNode
}> = ({ title, body, accentColor, children }) => (
  <div style={{ height: "100%", display: "flex", gap: 48 }}>
    <div style={{ width: "40%", display: "flex", flexDirection: "column", justifyContent: "center" }}>
      <div style={{ width: 48, height: 4, backgroundColor: accentColor, marginBottom: 20 }} />
      <div style={{ fontSize: 42, fontWeight: 800, lineHeight: 1.1, marginBottom: 20 }}>
        {title}
      </div>
      {body.map((p, i) => (
        <div key={i} style={{ fontSize: 20, lineHeight: 1.45, marginBottom: 12, opacity: 0.85 }}>{p}</div>
      ))}
    </div>
    <div style={{ width: "60%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
      {children ?? (
        <div style={{ color: "#9CA3AF", fontSize: 22, fontStyle: "italic" }}>
          Strategy diagram loaded by the composer
        </div>
      )}
    </div>
  </div>
)

const TimelineSlideBody: React.FC<{
  title: string; body: string[]; labels: string[]; accentColor: string; primaryColor: string
}> = ({ title, body, labels, accentColor, primaryColor }) => {
  const five = labels.slice(0, 5)
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ marginBottom: 32 }}>
        <div style={{ width: 48, height: 4, backgroundColor: accentColor, marginBottom: 16 }} />
        <div style={{ fontSize: 48, fontWeight: 800, lineHeight: 1.05, marginBottom: 16 }}>{title}</div>
        {body.map((p, i) => (
          <div key={i} style={{ fontSize: 20, lineHeight: 1.4, opacity: 0.85 }}>{p}</div>
        ))}
      </div>
      <div style={{ flex: 1, display: "flex", alignItems: "center", position: "relative" }}>
        {/* Horizontal line */}
        <div style={{
          position: "absolute", top: "50%", left: 32, right: 32, height: 4,
          backgroundColor: accentColor, opacity: 0.5,
        }} />
        {/* Step pills */}
        <div style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", zIndex: 1, padding: "0 32px" }}>
          {five.map((label, i) => (
            <div key={i} style={{
              display: "flex", flexDirection: "column", alignItems: "center", gap: 12,
            }}>
              <div style={{
                width: 56, height: 56, borderRadius: 28,
                backgroundColor: accentColor, color: primaryColor,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 24, fontWeight: 900,
                boxShadow: `0 6px 16px ${primaryColor}33`,
              }}>{i + 1}</div>
              <div style={{
                fontSize: 18, fontWeight: 700, textAlign: "center", maxWidth: 200,
                color: primaryColor,
              }}>
                {label}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const ClosingSlideBody: React.FC<{
  title: string; body: string[]; accentColor: string
  brand: BuyerConsultationSlideProps["brand"]
}> = ({ title, body, accentColor, brand }) => (
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
      Your next step
    </div>
    <div style={{ fontSize: 64, fontWeight: 800, lineHeight: 1.05, marginBottom: 24 }}>
      {title}
    </div>
    {body.map((p, i) => (
      <div key={i} style={{ fontSize: 24, lineHeight: 1.45, opacity: 0.8, maxWidth: 1100, marginBottom: 8 }}>{p}</div>
    ))}
  </div>
)

/* ─────────── avatar PIP (shared shape) ─────────── */

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
    width: 280, height: 280, borderRadius: 140,
    boxShadow: `0 0 0 5px ${accentColor}, 0 24px 48px rgba(0,0,0,0.18)`,
    overflow: "hidden", backgroundColor: primaryColor,
  }
  if (avatarVideoUrl) {
    return (
      <div style={ring}>
        <Video src={avatarVideoUrl} startFrom={startFrame} endAt={endFrame}
          style={{ width: "100%", height: "100%", objectFit: "cover" }} />
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
      ...ring, backgroundColor: accentColor,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: 100, color: primaryColor, fontWeight: 800,
    }}>
      {(agentName[0] ?? "A").toUpperCase()}
    </div>
  )
}
