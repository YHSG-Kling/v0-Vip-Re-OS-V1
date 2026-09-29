/**
 * remotion/components/QrOutroBadge.tsx
 *
 * Small bottom-corner overlay for the OUTRO of an AI-made reel. Renders a
 * scannable, tracked QR (the data URL is minted upstream by
 * lib/video/video-qr.ts → mintVideoQr) with a short caption ("Scan to tour").
 *
 * Remotion best-practices honored:
 *   · Fade in via interpolate(useCurrentFrame()) — NO CSS transitions, NO
 *     Tailwind animation classes (they don't render deterministically).
 *   · <Img> from "remotion" for the data URL (not a bare <img>).
 *
 * Renders NOTHING when:
 *   · qrCodeDataUrl is absent (mint failed / QR off) — the video still renders.
 *   · mlsClean is true — MLS feed rules forbid agent/brokerage branding on
 *     listing media, and a tracked agent QR is branding. (Mirrors the
 *     mlsClean skip in lib/video/composite-attribution.ts.)
 *
 * It is positioned absolutely in the bottom-right and is meant to be dropped
 * INSIDE an outro <Sequence> (so it inherits that sequence's timing window).
 */
import React from "react"
import { Img, interpolate, useCurrentFrame, useVideoConfig } from "remotion"
import { cinemaBadgeSlot } from "../../lib/video/cinema-finish"

export interface QrOutroBadgeProps {
  /** data:image/png;base64,... from QRCode.toDataURL. Null/undefined → render nothing. */
  qrCodeDataUrl?: string | null
  /** Short scan prompt, e.g. "Scan to tour". Defaults to "Scan to learn more". */
  caption?: string
  /** Brand colors so the badge frame matches the reel's chrome. */
  primaryColor?: string
  accentColor?: string
  /** MLS-bound cut — carries no agent branding (incl. QR). True → render nothing. */
  mlsClean?: boolean
  /** Corner placement. Defaults to bottom-right. */
  corner?: "bottom-right" | "bottom-left"
}

/**
 * PURE render decision — the badge shows only when there is a data URL to
 * encode AND the cut is not MLS-clean. Exported so the test harness can
 * assert the null-render contract without a Remotion render context.
 */
export function shouldRenderQrBadge(args: {
  qrCodeDataUrl?: string | null
  mlsClean?: boolean
}): boolean {
  return !!args.qrCodeDataUrl && !args.mlsClean
}

export const QrOutroBadge: React.FC<QrOutroBadgeProps> = ({
  qrCodeDataUrl,
  caption = "Scan to learn more",
  primaryColor = "#0F172A",
  accentColor = "#F59E0B",
  mlsClean = false,
  corner = "bottom-right",
}) => {
  const frame = useCurrentFrame()
  const { width, height } = useVideoConfig()

  // Default-off + MLS-clean guard. A missing data URL means minting was
  // skipped or failed; the reel must still render cleanly without the badge.
  // The explicit qrCodeDataUrl truthiness check also narrows it to string.
  if (!qrCodeDataUrl || !shouldRenderQrBadge({ qrCodeDataUrl, mlsClean })) return null

  // Fade in over ~12 frames, hold. interpolate on useCurrentFrame — no CSS.
  const opacity = interpolate(frame, [0, 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })

  // WAVE 89 (lane 89F) — the corner is the frame's badge slot (lib/video/
  // cinema-finish.ts cinemaBadgeSlot): inside the safe sides and above the
  // disclosure footer / caption band. It sat at a typed 28 px, inside the
  // platform UI band and on top of the outro's Equal Housing line.
  const slot = cinemaBadgeSlot(width, height)
  const horizontal = corner === "bottom-left" ? { left: slot.left } : { right: slot.right }

  return (
    <div
      style={{
        position: "absolute",
        bottom: slot.bottom,
        ...horizontal,
        opacity,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        padding: 12,
        borderRadius: 14,
        backgroundColor: "rgba(255,255,255,0.96)",
        boxShadow: `0 0 0 3px ${accentColor}`,
      }}
    >
      <Img
        src={qrCodeDataUrl}
        style={{ width: 132, height: 132, objectFit: "contain" }}
      />
      <div
        style={{
          maxWidth: 156,
          textAlign: "center",
          color: primaryColor,
          fontSize: 18,
          fontWeight: 700,
          lineHeight: 1.15,
          fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
        }}
      >
        {caption}
      </div>
    </div>
  )
}
