// remotion/components/AvatarPIP.tsx
// Same-body census, round 4 (2026-09-09, lane FC). Survivor for the
// byte-identical private `AvatarPIP` in remotion/EquityReportReel.tsx:207
// and remotion/MarketUpdateReel.tsx:193 — top-right circular avatar picture-
// in-picture: agent video clip if provided, else the agent photo, else a
// colored initial monogram.
//
// Wave 56 — merged the third duplicate onto this survivor:
// remotion/AgentExplainerReel.tsx's own private `AvatarPIP` (top-left, 360px,
// three windows into ONE continuous D-ID clip) is now this component too —
// see AgentExplainerReel.tsx for its tombstone. `position`/`size`/`ringWidth`
// exist so this ONE component can serve both look-and-feel variants instead
// of splitting again on the next caller with different geometry (§6).
//
// Wave 56 (owner ruling: "the video product needs to look and appear real...
// the person viewing the video must not think it was made with ai") — the
// FREEZE-RISK SHAPE. EquityReportReel, MarketUpdateReel, and AgentExplainerReel
// each cut THREE separate Sequence windows into ONE continuous avatar clip,
// passing `startFrame`/`endFrame` offsets as `trimBefore`/`trimAfter`.
// A clip measuring shorter than the composition's fixed geometry does not just
// freeze once — every LATER window whose startFrame is already past the clip's
// real end asks `<Video>` to play a slice that does not exist, holding
// whatever frame `<Video>` resolves to (a visibly frozen face) for the entire
// window. `avatarDurationSeconds` (the D-ID-measured clip length, already
// threaded into every avatar render's input_props by
// lib/video/avatar-render-orchestrator.ts) lets this component ask, PER
// WINDOW: does this slice have any real content left, and if the clip ends
// partway through it, fade to the fallback instead of freezing on the last
// rendered frame. avatarPipWindowFade (lib/video/realism-profile.ts) is the
// pure decision; additive/opt-in — a caller with no measurement (prop absent)
// renders EXACTLY as before.
//
// WAVE 60 REALISM FIX — LEAD-IN, NOT ABSOLUTE. `startFrame`/`endFrame` are
// this window's offsets into the clip's OWN timeline, RELATIVE TO WHEN THE
// AVATAR TRACK ITSELF FIRST BECOMES VISIBLE (0 for the first AvatarPIP
// window, not the composition-absolute frame it happens to mount at). Every
// caller here opens on a silent cover/intro tile with no AvatarPIP mounted
// at all, and D-ID is never asked to pad that tile's length as lead-in
// silence (DID_TALK_REALISM_CONFIG.pad_audio, lib/video/realism-profile.ts,
// is 0.3s of TRAILING silence only) — so passing the composition-absolute
// frame here (the pre-fix shape) fed `<Video trimBefore>` that same value
// and silently skipped that many seconds of REAL narration from the front
// of the clip before it was ever heard. See each caller's own "AVATAR
// LEAD-IN FIX" comment.

import React from "react"
import { Video } from "@remotion/media"
import { interpolate, useCurrentFrame } from "remotion"
import { SafeImg } from "./SafeImg"
import { avatarPipWindowFade } from "../../lib/video/realism-profile"

export const AvatarPIP: React.FC<{
  avatarVideoUrl: string | null
  agentPhotoUrl: string | null
  agentName: string
  startFrame: number
  endFrame: number
  accentColor: string
  primaryColor: string
  /**
   * D-ID's OWN measured render duration in seconds for the WHOLE continuous
   * clip this window is a slice of (ai_video_projects.duration_seconds).
   * Optional + additive: absent renders EXACTLY as before — no fade, no
   * fallback swap, the raw hold on whatever `<Video>` does past its own end.
   */
  avatarDurationSeconds?: number | null
  /** Frames per second of the enclosing composition. Defaults to 30 — every
   *  current caller (AgentExplainerReel, EquityReportReel, MarketUpdateReel)
   *  renders at 30fps; a future 60fps caller must pass its own value or the
   *  fade math would be computed against the wrong clock. */
  fps?: number
  /** Ring diameter in px. Defaults to 200 — the original EquityReportReel/
   *  MarketUpdateReel size. AgentExplainerReel's larger top-left PIP passes
   *  360 rather than forking a second component. */
  size?: number
  /** Corner the ring sits in. Defaults to "top-right" (the original
   *  EquityReportReel/MarketUpdateReel placement). */
  position?: "top-right" | "top-left"
  /** Ring boxShadow width in px. Defaults to 4. */
  ringWidth?: number
}> = ({
  avatarVideoUrl, agentPhotoUrl, agentName, startFrame, endFrame, accentColor, primaryColor,
  avatarDurationSeconds, fps = 30, size = 200, position = "top-right", ringWidth = 4,
}) => {
  const frame = useCurrentFrame()
  const corner: React.CSSProperties =
    position === "top-left" ? { top: 32, left: 32 } : { top: 32, right: 32 }
  const ring: React.CSSProperties = {
    position: "absolute", ...corner,
    width: size, height: size, borderRadius: size / 2,
    boxShadow: `0 0 0 ${ringWidth}px ${accentColor}, 0 18px 36px rgba(0,0,0,0.25)`,
    overflow: "hidden", backgroundColor: primaryColor,
  }

  // Wave 56 realism — see the file-header note. hasRealContent === false means
  // this window's slice starts entirely past the clip's measured end: there is
  // nothing to fade FROM, so treat it exactly like "no avatar video" (fall
  // through to the photo/monogram) rather than freeze on the last real frame
  // for the whole window.
  const { hasRealContent, fadeFrame } = avatarPipWindowFade(avatarDurationSeconds, startFrame, endFrame, fps)
  const opacity = fadeFrame != null
    ? interpolate(frame, [fadeFrame, fadeFrame + 12], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    : 1

  if (avatarVideoUrl && hasRealContent) {
    return (
      <div style={ring}>
        <Video src={avatarVideoUrl} objectFit="cover" trimBefore={startFrame} trimAfter={endFrame}
          style={{ width: "100%", height: "100%", opacity }} />
      </div>
    )
  }
  if (agentPhotoUrl) {
    return (
      <div style={ring}>
        <SafeImg src={agentPhotoUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
    )
  }
  return (
    <div style={{
      ...ring, backgroundColor: accentColor,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: Math.round(size * 0.4), color: primaryColor, fontWeight: 800,
    }}>
      {(agentName[0] ?? "A").toUpperCase()}
    </div>
  )
}
