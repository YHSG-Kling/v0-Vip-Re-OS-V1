// ─── AUTONOMOUS REPURPOSE PLANNER (a manager decides to cut platform shorts) ────
// Repurposing was a MANUAL UI process (the snippets tool / the campaigns/repurpose
// dashboard) — no manager ever decided, on its own, to turn a finished broadcast video
// into platform-specific shorts. This is the pure decision layer for the MANAGED loop:
// when a broadcast marketing reel completes, the Campaign Orchestrator hands off to the
// Asset Manager, which re-commissions the SAME content as vertical shorts for the social
// channels the primary didn't already cover — through the existing Director/commissionVideo
// pipeline (real render + bookends + QR + gating), no manual clip-cutting.
//
// Pure (no I/O) → unit-testable. The handler in manager-signals.ts calls commissionVideo.

/** The vertical social channels we cut platform shorts for (Director's isVerticalSocial set). */
export const SHORT_CHANNELS = ["tiktok", "instagram"] as const
export type ShortChannel = (typeof SHORT_CHANNELS)[number]

/** Public social channels — a video that targets one of these is a BROADCAST asset (repurposable);
 *  a video that only targets email/portal is a 1:1 piece and is never turned into public shorts. */
const BROADCAST_CHANNELS = new Set(["tiktok", "instagram", "youtube", "facebook"])

export interface RepurposeSource {
  /** ai_video_projects.video_metadata.director_key — carries the recursion marker. */
  directorKey: string | null
  /** the channels the PRIMARY reel already covered (video_metadata.target_channels). */
  targetChannels: string[]
  /** 'lead' (or a contact-addressed reel) → a 1:1 piece, never publicly repurposed. */
  audience?: string | null
}

/**
 * PURE: is this completed video worth repurposing into platform shorts?
 *   • must be a BROADCAST asset (targets a public social channel),
 *   • must NOT be a 1:1 lead/contact reel,
 *   • must NOT already be a repurpose variant (recursion guard — director_key carries ':repurpose:').
 */
export function isRepurposableVideo(v: RepurposeSource): boolean {
  if (!v.directorKey || v.directorKey.includes(":repurpose:")) return false
  if (v.audience === "lead") return false
  return (v.targetChannels ?? []).some((c) => BROADCAST_CHANNELS.has(String(c).toLowerCase()))
}

/**
 * PURE: which SHORT channels to cut that the primary didn't already cover. A long horizontal
 * reel (youtube/facebook) → tiktok + instagram verticals; a reel that already covered both
 * shorts channels → [] (nothing to add, no wasted render).
 */
export function planRepurposeChannels(v: RepurposeSource): ShortChannel[] {
  const covered = new Set((v.targetChannels ?? []).map((c) => String(c).toLowerCase()))
  return SHORT_CHANNELS.filter((c) => !covered.has(c))
}

/** The idempotency discriminator that makes a variant a DISTINCT commission (not a dedupe of
 *  the primary). director_key becomes `director:<kind>:<entity>:repurpose:<channel>`. */
export function repurposeDiscriminator(channel: ShortChannel): string {
  return `repurpose:${channel}`
}
