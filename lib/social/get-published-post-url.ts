export type SocialPlatform =
  | "facebook"
  | "instagram"
  | "linkedin"
  | "twitter"
  | "x"
  | "youtube"
  | "tiktok"
  | "pinterest"
  | "google_business"

/**
 * Derive the canonical public URL for a published post given its platform
 * and the external_post_id stored by the social publishing pipeline.
 * Returns null for unknown platforms so callers can hide the external link.
 */
export function getPublishedPostUrl(
  platform: string,
  externalPostId: string,
): string | null {
  if (!platform || !externalPostId) return null
  const p = platform.toLowerCase() as SocialPlatform

  if (p === "facebook") {
    // externalPostId is typically "{pageId}_{postId}"
    const parts = externalPostId.split("_")
    if (parts.length >= 2) {
      return `https://www.facebook.com/permalink.php?story_fbid=${parts[1]}&id=${parts[0]}`
    }
    return `https://www.facebook.com/${externalPostId}`
  }

  if (p === "instagram") {
    return `https://www.instagram.com/p/${externalPostId}/`
  }

  if (p === "linkedin") {
    if (externalPostId.startsWith("urn:")) {
      return `https://www.linkedin.com/feed/update/${externalPostId}`
    }
    return `https://www.linkedin.com/feed/update/urn:li:activity:${externalPostId}`
  }

  if (p === "twitter" || p === "x") {
    return `https://x.com/i/web/status/${externalPostId}`
  }

  if (p === "youtube") {
    return `https://www.youtube.com/watch?v=${externalPostId}`
  }

  if (p === "tiktok") {
    return `https://www.tiktok.com/@/video/${externalPostId}`
  }

  if (p === "pinterest") {
    return `https://www.pinterest.com/pin/${externalPostId}/`
  }

  if (p === "google_business") {
    return `https://business.google.com/posts/${externalPostId}`
  }

  return null
}
