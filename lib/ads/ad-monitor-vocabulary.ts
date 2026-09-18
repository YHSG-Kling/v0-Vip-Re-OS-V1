// lib/ads/ad-monitor-vocabulary.ts
//
// The competitor-monitor platform vocabularies, kept OUT of lib/ads/ad-monitor.ts
// because that file carries a top-level "use server" directive and a "use server"
// module may export ONLY async functions. Exporting these arrays from there made
// Next.js fail page-data collection with
//   A "use server" file can only export async functions, found object.
// which breaks the production build outright — it is not a lint-level concern.
//
// Types alone would have been fine (they are erased at compile time); it is the
// two runtime arrays that cannot live behind the directive. They belong in a plain
// module anyway: the values are consumed by a CLIENT component
// (app/dashboard/campaigns/competitive/track-competitor-dialog.tsx) to populate its
// platform pickers, and a client importing them from a "use server" file would be
// pulling a value across an RPC boundary that only carries functions.
//
// VERIFIED AGAINST THE LIVE CHECK CONSTRAINTS, which differ between the two tables:
//   competitor_ads_source_platform_check   → facebook | instagram | google
//   competitor_posts_source_platform_check → facebook | instagram | linkedin | x
//                                            | youtube | tiktok
// The ad union previously offered 'linkedin' and 'tiktok', which the ads CHECK
// rejects (23514), so those branches were unreachable and any caller trusting the
// type hit an opaque database error. The post union offered 'twitter', which the
// posts CHECK also rejects (the live value is 'x'), and omitted 'x' and 'youtube'
// which it does admit.

export type CompetitorAdPlatform = "facebook" | "instagram" | "google"

export type CompetitorPostPlatform =
  | "facebook"
  | "instagram"
  | "linkedin"
  | "x"
  | "youtube"
  | "tiktok"

export const COMPETITOR_AD_PLATFORMS: readonly CompetitorAdPlatform[] = [
  "facebook",
  "instagram",
  "google",
] as const

export const COMPETITOR_POST_PLATFORMS: readonly CompetitorPostPlatform[] = [
  "facebook",
  "instagram",
  "linkedin",
  "x",
  "youtube",
  "tiktok",
] as const
