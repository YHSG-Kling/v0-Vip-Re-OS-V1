// remotion/components/AvatarPIP.tsx
// Same-body census, round 4 (2026-09-09, lane FC). Survivor for the
// byte-identical private `AvatarPIP` in remotion/EquityReportReel.tsx:207
// and remotion/MarketUpdateReel.tsx:193 — top-right circular avatar picture-
// in-picture: agent video clip if provided, else the agent photo, else a
// colored initial monogram.

import React from "react"
import { Video } from "@remotion/media"
import { SafeImg } from "./SafeImg"

export const AvatarPIP: React.FC<{
  avatarVideoUrl: string | null
  agentPhotoUrl: string | null
  agentName: string
  startFrame: number
  endFrame: number
  accentColor: string
  primaryColor: string
}> = ({ avatarVideoUrl, agentPhotoUrl, agentName, startFrame, endFrame, accentColor, primaryColor }) => {
  const ring: React.CSSProperties = {
    position: "absolute", top: 32, right: 32,
    width: 200, height: 200, borderRadius: 100,
    boxShadow: `0 0 0 4px ${accentColor}, 0 18px 36px rgba(0,0,0,0.25)`,
    overflow: "hidden", backgroundColor: primaryColor,
  }
  if (avatarVideoUrl) {
    return (
      <div style={ring}>
        <Video src={avatarVideoUrl} objectFit="cover" trimBefore={startFrame} trimAfter={endFrame}
          style={{ width: "100%", height: "100%" }} />
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
      fontSize: 80, color: primaryColor, fontWeight: 800,
    }}>
      {(agentName[0] ?? "A").toUpperCase()}
    </div>
  )
}
