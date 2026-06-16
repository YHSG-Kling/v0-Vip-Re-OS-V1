// lib/intelligence/winback-video.ts
//
// MULTIMODAL WIN-BACK (pure). For a relationship that has gone DORMANT, a text nudge rarely
// reignites it — but a PERSONAL video ("Hey Pat, you crossed my mind today…") in the agent's own
// face + ElevenLabs-cloned voice is the highest-emotion re-engagement there is. This decides when a
// win-back warrants the Video Director (commissionVideo) and which situation kind fits who they are.
// Only DORMANT triggers it (at-risk gets the lighter email/text plays first); routine/healthy never.
// Pure (no I/O), unit-tested directly; the runner stages it via the existing Video Director.

import type { HealthBand } from "./relationship-health"
import type { SituationKind } from "@/lib/video/commission-situation"

export interface WinbackVideoPlan {
  commission: boolean
  kind: SituationKind | null
  reason: string
}

/** Decide whether a dormant relationship warrants a personal win-back video, and its kind. Pure. */
export function winbackVideoPlan(contactType: string | null | undefined, band: HealthBand): WinbackVideoPlan {
  if (band !== "dormant") {
    return { commission: false, kind: null, reason: `${band} — a win-back video is reserved for dormant relationships` }
  }
  const t = (contactType ?? "").toLowerCase()
  // A past client gets an anniversary-style warm personal note; everyone else a personal explainer.
  const kind: SituationKind = /past|closed|sphere|repeat/.test(t) ? "anniversary" : "explainer"
  return { commission: true, kind, reason: `dormant — stage a personal ${kind} win-back video (highest-emotion re-engagement)` }
}
