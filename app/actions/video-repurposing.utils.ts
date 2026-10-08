// Layer 8.4 — Video Repurposing Utilities (non-server)
// The repurposed_content_log CHECK vocabularies, which cannot live in the
// "use server" sibling. Platform configuration moved to that sibling — see the
// tombstone below.

// TOMBSTONE: `PlatformTarget`, `PlatformConfig`, `PLATFORM_CONFIGS`,
// `getPlatformConfig`, `getAllPlatformConfigs` and `validateSnippetForPlatform`
// — ALL DELETED as a second, disagreeing copy of one vocabulary.
// SURVIVOR: app/actions/video-repurposing.ts:60 (`PlatformTarget`) and its
// module-private `PLATFORM_CONFIGS` immediately below it.
//
// WHY THAT ONE SURVIVES. It is the map every writer of
// `video_snippets.platform_target` normalises against — createVideoSnippet,
// generateSnippetSuggestions and the batch creator all key off it — so it is the
// vocabulary the database actually receives. The copy that stood here reached
// nothing: its three functions had exactly one importer, and that import
// (app/actions/video-repurposing.ts:11) never called them.
//
// THE TWO COPIES DISAGREED, which is why this was a defect and not a tidy-up.
// Different NAMES for the same platform — `instagram_reel`/`instagram_reels`,
// `youtube_short`/`youtube_shorts`, `linkedin_video`/`linkedin`,
// `facebook_reel`/`facebook_reels`, `twitter_video`/`twitter` — and different
// LIMITS for the same platform: tiktok 600s and 10 hashtags here against 180s
// and 100 there, linkedin 1:1 here against 16:9 there. This copy also had no
// `instagram_story` or `instagram_post` at all, two platforms the survivor
// writes.
//
// WHAT WAS MERGED FORWARD: `minDuration`, and the too-SHORT rejection that
// validateSnippetForPlatform performed with it. The survivor's create path
// checked only the maximum, so a 2-second Reel was accepted and stored and then
// refused by the platform at distribution time. See the `minDuration <` throw in
// createVideoSnippet.
//
// WHAT WAS NOT MERGED, AND WHY: `recommendedDuration`, `captionRequired` and
// `ctaRequired` had no reader anywhere in the tree — not in this module, not in
// the survivor, not in any surface. Carrying them onto the survivor would have
// created three fresh write-with-no-read columns of exactly the kind this
// burn-down exists to close.
//
// NOTE for future readers of lib/validations/index.ts: two tombstones there
// name `validateSnippetForPlatform` as the survivor of `validateHashtags` and
// describe it as "live via app/actions/video-repurposing.ts:11". That import
// was dead. The per-platform hashtag limit those tombstones point at lives on
// the survivor's PLATFORM_CONFIGS (`hashtagLimit`), which is where it always
// really was.

// ─── repurposed_content_log VOCABULARY ────────────────────────────────────────
//
// Verified against the LIVE database, not against convention:
//   repurposed_content_log_status_check
//     CHECK (status IN ('generated','scheduled','published','failed'))
//   repurposed_content_log_approval_status_check
//     CHECK (approval_status IN ('draft','pending_review','approved','rejected'))
//
// These live HERE and not in app/actions/video-repurposing.ts because that file
// carries a top-level "use server" directive, and such a module may only export
// async functions — exporting a const array from it fails Next.js page-data
// collection at build time (scripts/use-server-export-guard.ts is the ratchet).

export const REPURPOSE_LOG_STATUSES = [
  "generated",
  "scheduled",
  "published",
  "failed",
] as const

export const REPURPOSE_LOG_APPROVAL_STATUSES = [
  "draft",
  "pending_review",
  "approved",
  "rejected",
] as const

// TOMBSTONE (§1.3, 2026-08-27): the derived union types `RepurposeLogStatus` /
// `RepurposeLogApprovalStatus` are deleted — nothing consumed them. The vocabulary
// and its ENFORCEMENT live in the two rosters above: imported by
// app/actions/video-repurposing.ts (runtime-validated on every filtered read) and
// rendered as the filter options in the repurpose dashboard.
