// lib/lead-pipeline/social-identity-resolve.ts
//
// LANE 72B — owner verbatim (wave 72): "we use peopledata for finding a
// person's name etc. from raw leads that may come in from the scrapers
// especially from posts or behavioral signal intent online."
//
// THE GAP THIS FILLS: lib/lead-pipeline/social-sourcer.ts's normalizers
// (normalizeRedditPost, normalizeInstagramPost, …) already capture a scraped
// post's `username` on NormalizedScrapedRecord (lib/lead-pipeline/raw-record-
// types.ts), and isViableRecord() already treats username ALONE as enough to
// create a raw_scraped_leads row — but a record with ONLY a handle (no name,
// email or phone, the exact shape a Reddit/Instagram/Facebook post-author
// signal arrives in) had nowhere to go from there: PeopleData Labs'
// person/enrich endpoint identifies by NAME, EMAIL, PHONE or PROFILE (a
// social-profile URL) — never by a bare platform username — and nothing in
// this repo turned a scraped `username` + its source platform into the
// profile URL that endpoint needs.
//
// PURE — no network, no DB. Exercised directly by
// scripts/peopledata-identity-resolve-simulator.ts.

/** Sources whose normalizer's `username` is a per-platform HANDLE that maps
 *  onto a public profile URL PDL's `profile` param can match against. Every
 *  other SourceKey (property-site chatter, phrase-intent search results,
 *  BatchData quicklists, first-party site/email signals, …) has no handle
 *  concept at all — `deriveSocialProfileUrl` returns null for those rather
 *  than guessing a URL shape PDL was never going to match. */
const PROFILE_URL_BUILDERS: Record<string, (handle: string) => string> = {
  reddit_intent: (h) => `https://www.reddit.com/user/${h}`,
  reddit_relocation: (h) => `https://www.reddit.com/user/${h}`,
  instagram_intent: (h) => `https://www.instagram.com/${h}`,
  facebook_group: (h) => `https://www.facebook.com/${h}`,
  facebook_marketplace: (h) => `https://www.facebook.com/${h}`,
  facebook_recommend_realtor: (h) => `https://www.facebook.com/${h}`,
  linkedin_relocation: (h) => `https://www.linkedin.com/in/${h}`,
}

/** PURE. Turns a scraped `source` + `username` into the social-profile URL
 *  PDL's person/enrich `profile` param expects, or null when the source has
 *  no known profile-URL shape (never guessed) or the handle is empty/already
 *  a full URL (passed through unchanged — a normalizer that already captured
 *  a full profile link should never be re-wrapped). */
export function deriveSocialProfileUrl(source: string | null | undefined, username: string | null | undefined): string | null {
  const handle = (username ?? '').trim()
  if (!handle) return null
  if (/^https?:\/\//i.test(handle)) return handle
  // Strip a leading '@' — every platform's own share links omit it, and PDL's
  // profile matcher is asked for a URL, not a handle string.
  const cleanHandle = handle.replace(/^@/, '')
  if (!cleanHandle) return null
  const key = (source ?? '').trim().toLowerCase()
  const build = PROFILE_URL_BUILDERS[key]
  return build ? build(cleanHandle) : null
}
