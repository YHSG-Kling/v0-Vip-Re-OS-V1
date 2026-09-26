// lib/social/dm-support.ts
// PURE platform-capability map for social DM sends — importable from client
// components (no gateway/server imports). The dispatcher (dm-dispatch.ts)
// re-exports this so server code has one import site.

export interface SocialDmSupport {
  supported: boolean
  /** Honest reason when unsupported — shown verbatim in the composer. */
  reason?: string
}

/** What the connected-account tokens can ACTUALLY send, per platform. */
export function socialDmSupport(platform: string): SocialDmSupport {
  switch ((platform || "").toLowerCase()) {
    case "facebook":
    case "instagram":
      return { supported: true } // Messenger/IG Send API with the page token (24h reply window)
    case "whatsapp":
      return { supported: true } // Cloud API free-form text (24h customer window)
    case "linkedin":
      return { supported: false, reason: "LinkedIn's API doesn't allow DM sends for standard apps — reply from your LinkedIn inbox." }
    case "twitter":
    case "x":
      return { supported: false, reason: "X restricts DM sends to enterprise API tiers — reply from your X inbox." }
    default:
      return { supported: false, reason: "This platform has no connected DM send path." }
  }
}
