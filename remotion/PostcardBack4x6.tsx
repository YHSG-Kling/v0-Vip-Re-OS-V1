/**
 * remotion/PostcardBack4x6.tsx
 *
 * Wave 36 — 4×6 postcard BACK (1275×1875 px bleed canvas).
 *
 * Lob postcards reserve the right ~50% of the back for the indicia
 * (postage), barcode, and recipient address — anything in that zone
 * is covered. We only render in the left ~50% (the "message panel")
 * plus a thin top brand strip that survives the address-block overlay.
 *
 * Layout:
 *   - Brand strip across the top (8% of height) — color band + logo
 *   - Message panel left 48%: body copy + agent signature
 *   - Opt-out row: per-recipient QR + the same URL in words
 *   - Indicia zone right 52%: LEFT EMPTY for Lob to overlay address
 *
 * Branding sourced same as the front via resolveBrandContext
 * (lib/branding/resolve-brand-context.ts);
 * copy sourced via draftPostcardCopy (the SAME body string used on
 * the front, so the two sides feel coherent, not disjointed).
 *
 * ───────────────────────────────────────────────────────────────────
 * THE OPT-OUT ROW — why this side, and why two affordances.
 *
 * The owner's ruling: a mailed contact or lead must be traceable back
 * to their campaign to unsubscribe, and "postcards also get a qrcode
 * so maybe the unsubscribe can be part of it". The whole mechanism —
 * the per-recipient token, the resolver, the public surface — existed
 * and reached no mail piece. This is the panel that carries it.
 *
 * BACK, not front: the front is the hook and carries the CAMPAIGN's
 * response QR (`qrCodeDataUrl`, one slug shared by every recipient of
 * the campaign). The back is where the fine print lives, and keeping
 * the two QRs on different panels is the physical half of keeping the
 * campaign-level code and the per-recipient token from ever being
 * mistaken for each other.
 *
 * TWO affordances, one URL: the QR is unreadable to the human holding
 * the card, so on its own it asks them to trust an opaque square from
 * the sender they are trying to stop; the printed URL is readable by
 * everyone and typed by almost nobody at 49 characters. Printed
 * together the line labels the square and covers whoever cannot scan,
 * and the square removes the typing. Both are built from the SAME
 * token by lib/direct-mail/mail-opt-out-affordance.ts, so they cannot
 * name two different people.
 */
import React from "react"
import { AbsoluteFill, Img, useVideoConfig } from "remotion"
import { SafeImg } from "./components/SafeImg"

export interface PostcardBack4x6Props {
  /** Same body as the front piece — coherence between sides. */
  body:    string
  /** Agent signature line (e.g. "— Sarah Chen"). Null = brokerage name. */
  signoff: string | null
  /** Agent photo URL — small headshot above the signoff. Null = initials. */
  agentPhotoUrl: string | null
  agentName: string | null
  /**
   * THE PER-RECIPIENT OPT-OUT SENTENCE, exactly as it prints, e.g.
   *   "To stop receiving mail: app.vipagentos.com/unsubscribe/K7M2NP4RQ8TVWX"
   *
   * Built by buildMailOptOutAffordance from THIS recipient's
   * direct_mail_recipients.unsubscribe_token — never from a campaign id, a
   * qr_codes slug, or anything else shared between recipients. The wording
   * lives in lib/direct-mail/unsubscribe-token.ts (mailOptOutPrintLine) so the
   * sentence and the URL cannot drift apart in two files.
   *
   * Null renders NOTHING rather than a placeholder: a wrong or generic opt-out
   * line is worse than none, because it looks like it works. `optOutLine` is
   * declared REQUIRED in lib/remotion/content-contract.ts, so a real send that
   * fails to supply it is a refusable render, not a quietly opt-out-less card.
   */
  optOutLine: string | null
  /**
   * PNG data URL of a QR encoding the SAME per-recipient URL the line spells
   * out. COSMETIC in the content contract: if the encoder fails the card still
   * carries a readable, typeable opt-out, so a QR failure must not cancel an
   * otherwise legitimate send.
   */
  optOutQrDataUrl: string | null
  brand: {
    primaryColor:     string
    accentColor:      string
    logoUrl:          string | null
    brokerageName:    string
    websiteWordmark:  string | null
    phone:            string | null
    licenseLine:      string | null
    shortDisclosure:  string
  }
}

const SAFE_INSET = 56

/**
 * Rendered edge of the opt-out QR, in canvas px. MUST equal
 * MAIL_OPT_OUT_QR_PX in lib/direct-mail/mail-opt-out-affordance.ts, which is
 * the width the PNG is generated at — displaying a QR at anything other than
 * its generated size resamples the module edges and is how a printed code ends
 * up marginal to scan. The two constants are checked against each other by
 * scripts/mail-unsubscribe-simulator.ts. (Not imported: the composition bundle
 * must not pull a server-side module graph in through the Remotion bundler.)
 */
const OPT_OUT_QR_PX = 280

/** Measured height of the fine-print footer block, used to stack above it. */
const FOOTER_BLOCK_H = 96

export const PostcardBack4x6: React.FC<PostcardBack4x6Props> = ({
  body, signoff, agentPhotoUrl, agentName, optOutLine, optOutQrDataUrl, brand,
}) => {
  // Indicia keep-out: right 52% of the canvas is reserved for Lob's
  // address block + barcode. Everything renders in the left 48%. The canvas
  // width comes from the registration (it used to be `1275` typed twice
  // here; test:remotion-setup §5 refuses that literal now).
  const { width } = useVideoConfig()
  const messagePanelRight = width - Math.floor(width * 0.52)  // ~612px at 1275

  // The opt-out row sits between the fine print and the signature. Its height
  // is what pushes the signature up, so a piece with no opt-out (Studio
  // preview) keeps the original layout exactly.
  const showQr    = Boolean(optOutLine && optOutQrDataUrl)
  const optOutH   = optOutLine ? (showQr ? OPT_OUT_QR_PX + 10 : 0) + 52 : 0
  const optOutBottom  = SAFE_INSET + FOOTER_BLOCK_H
  const signoffBottom = SAFE_INSET + 80 + (optOutH > 0 ? optOutH + 40 : 0)

  return (
    <AbsoluteFill style={{
      backgroundColor: "#fff",
      fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
      color: brand.primaryColor,
    }}>
      {/* Brand strip top */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, height: 110,
        backgroundColor: brand.primaryColor,
        display: "flex", alignItems: "center", paddingLeft: SAFE_INSET, paddingRight: SAFE_INSET,
        color: "#fff",
      }}>
        {brand.logoUrl ? (
          <SafeImg src={brand.logoUrl} style={{ height: 64, width: "auto", objectFit: "contain", marginRight: 18 }} />
        ) : (
          <div style={{
            width: 56, height: 56, borderRadius: 10, marginRight: 18,
            backgroundColor: brand.accentColor, color: brand.primaryColor,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 32, fontWeight: 800,
          }}>{brand.brokerageName[0]?.toUpperCase() ?? "B"}</div>
        )}
        <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: 0.5 }}>
          {brand.brokerageName}
        </div>
      </div>

      {/* Accent rule under brand strip */}
      <div style={{
        position: "absolute", top: 110, left: 0, right: 0, height: 6,
        backgroundColor: brand.accentColor,
      }} />

      {/* Message panel — left half only */}
      <div style={{
        position: "absolute",
        top: 170, left: SAFE_INSET, width: messagePanelRight - SAFE_INSET,
        fontSize: 28, lineHeight: 1.55, color: "#333",
      }}>
        {body}
      </div>

      {/* Agent signature block — bottom-left of message panel */}
      <div style={{
        position: "absolute",
        bottom: signoffBottom, left: SAFE_INSET,
        width: messagePanelRight - SAFE_INSET,
        display: "flex", alignItems: "center", gap: 18,
      }}>
        {agentPhotoUrl ? (
          <SafeImg src={agentPhotoUrl} style={{
            width: 90, height: 90, objectFit: "cover", borderRadius: 45,
            border: `3px solid ${brand.accentColor}`,
          }} />
        ) : (
          <div style={{
            width: 90, height: 90, borderRadius: 45,
            backgroundColor: brand.accentColor, color: brand.primaryColor,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 38, fontWeight: 700,
            border: `3px solid ${brand.primaryColor}`,
          }}>{(agentName?.[0] ?? brand.brokerageName[0] ?? "A").toUpperCase()}</div>
        )}
        <div>
          <div style={{ fontSize: 24, fontWeight: 700, color: brand.primaryColor }}>
            {signoff ?? `— ${brand.brokerageName}`}
          </div>
          {agentName && (
            <div style={{ fontSize: 18, color: "#555", marginTop: 2 }}>{agentName}</div>
          )}
        </div>
      </div>

      {/* ── THE OPT-OUT ROW ───────────────────────────────────────────────
          The QR and the sentence encode the SAME per-recipient URL. The
          sentence is what makes this a readable opt-out and what labels the
          square before anybody points a camera at it; the QR is what makes 49
          characters one tap. Renders only when a real recipient token produced
          them — never a placeholder. */}
      {optOutLine && (
        <div style={{
          position: "absolute",
          bottom: optOutBottom, left: SAFE_INSET,
          width: messagePanelRight - SAFE_INSET,
          display: "flex", flexDirection: "column", gap: 10,
        }}>
          {optOutQrDataUrl && (
            <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
              {/* Rendered at exactly the size it was generated at — see
                  OPT_OUT_QR_PX. Scaling a QR here is what makes it not scan. */}
              <Img src={optOutQrDataUrl} style={{
                width: OPT_OUT_QR_PX, height: OPT_OUT_QR_PX,
                backgroundColor: "#fff",
                border: `2px solid ${brand.accentColor}`,
              }} />
              {/* The label is what turns an opaque square into an opt-out: it
                  tells the recipient what they are about to scan BEFORE they
                  scan it, which the QR itself cannot. */}
              <div style={{ fontSize: 26, fontWeight: 800, lineHeight: 1.25, letterSpacing: 0.4, color: "#444" }}>
                SCAN TO<br />STOP MAIL
              </div>
            </div>
          )}
          {/* The same URL in words — full panel width so it breaks cleanly, and
              the only half of this row that works without a camera. */}
          <div style={{ fontSize: 18, lineHeight: 1.4, color: "#444", wordBreak: "break-word" }}>
            {optOutLine}
          </div>
        </div>
      )}

      {/* Footer micro-row — license + disclosure, full width below indicia */}
      <div style={{
        position: "absolute",
        bottom: SAFE_INSET, left: SAFE_INSET, width: messagePanelRight - SAFE_INSET,
        borderTop: `1px solid ${brand.accentColor}`,
        paddingTop: 12,
        fontSize: 14, lineHeight: 1.35, color: "#666",
      }}>
        {brand.licenseLine && <div>{brand.licenseLine}</div>}
        <div style={{ marginTop: 4 }}>{brand.shortDisclosure}</div>
        {(brand.websiteWordmark || brand.phone) && (
          <div style={{ marginTop: 4, color: brand.primaryColor, fontWeight: 600 }}>
            {[brand.websiteWordmark, brand.phone].filter(Boolean).join(" · ")}
          </div>
        )}
      </div>
    </AbsoluteFill>
  )
}
