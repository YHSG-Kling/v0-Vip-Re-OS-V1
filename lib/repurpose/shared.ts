// Shared, side-effect-free helpers for the repurpose pipeline. Kept out of the
// "use server" action files so both the synchronous actions and the async
// completion-side distributor can import them.

// Platforms accepted by social_posts.platform CHECK — only these can be
// auto-distributed.
export const DISTRIBUTABLE_PLATFORMS = new Set([
  "facebook",
  "instagram",
  "linkedin",
  "twitter",
  "tiktok",
  "youtube",
  "pinterest",
  "google_business",
])

export function extractHashtags(text: string): string[] {
  const matches = text.match(/#[\p{L}0-9_]+/gu) ?? []
  return Array.from(new Set(matches.map((h) => h.slice(1)))).slice(0, 15)
}
