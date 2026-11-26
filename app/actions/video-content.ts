"use server"


// =====================================================
// VIDEO CONTENT GENERATION SERVER ACTIONS
// AI-powered video script and content creation
// =====================================================

// ── DELETED: generateVideoScript (wave 57, Task B duplicates round 2) ──────
//
// SURVIVOR: app/actions/video/generate-script.ts:141 generateVideoScript —
// the canonical Video Studio generator (behind /dashboard/videos/create),
// documented by lib/kernel/manager-registry.ts video_script_compliance /
// video_repurpose_render_writers as the most complete of the FIVE audited
// generateVideoScript implementations: compliance gate before AND after
// generation (lib/video/script-compliance.ts — brand voice, ThemFirst, Fair
// Housing), saveToLibrary, nine video types mapped through
// toLibraryScriptType against the live five-value CHECK. This was a SIXTH,
// unaudited copy — scripts/video-script-compliance-guard.ts's enumerated
// five never named it, so it carried NO compliance gate at all on
// agent-facing marketing copy, the exact hole §5's "compliance-first" ruling
// exists to close.
//
// Zero live callers: reachable only through lib/orchestrator/internal.ts's
// dynamic import of this module, and that import named the four event handlers
// (moved in lane 86F3 to lib/video/video-event-reactions.ts — tombstone below) —
// never generateVideoScript. No page, component, or route named it.
//
// NOT BLINDLY MERGED: this copy carried a feature-tier gate
// (canAccessFeature/incrementFeatureUsage on the "video_generation" key,
// verified live as enabled/unlimited on all four tiers today — a no-op
// currently) that the survivor does not have of its own; the survivor's
// AI call instead routes through generateAIResponse -> resolveAIModel,
// which the survivor's own comment says "applies brokerage tier caps
// automatically" — whether that is an equivalent control or a real gap is
// UNRESOLVED (needs a follow-up read of resolveAIModel's tier-cap logic
// against feature_flags before touching the most-used video action in the
// tree without the full guard chain to verify against).

// TOMBSTONE (lane 86F3, orphan doctrine §1.1) — the four "EVENT HANDLERS - Called
// by orchestrator" LIVED HERE and are gone: handleVideoGenerated,
// approveAndGenerateVideo, handleVideoPublished, handleHighEngagement. Each was a
// "use server" export — a public endpoint taking video_id / script_id / user_id
// from the browser — on the COOKIE client, with no tenant predicate on its writes;
// their one caller, lib/orchestrator/internal.ts EVENT_HANDLERS, dispatches from
// cron and webhooks with no cookie, so they wrote nothing and returned success.
// No browser caller existed (grep), so no public door was kept.
// SURVIVOR: lib/video/video-event-reactions.ts — reactToVideoReady,
// reactToVideoScriptApproved, reactToVideoPublished, reactToVideoHighEngagement
// (server-only, the EVENT row's tenant pinned on every read and write, the
// recipient proven in it, writes counted).
// NOT CARRIED OVER, on purpose: approveAndGenerateVideo's two writes.
//   · approval_status='approved' with the payload's user as approver — a THIRD,
//     ungated writer beside the ONE gated one (app/actions/video-generation.ts
//     updateScriptApprovalStatus; manager-registry video_script_approval_single_writer).
//     The reaction now VERIFIES the approval on the row instead.
//   · ai_video_projects.status='generating' with no provider job — a wedge the
//     poller can never complete. Rendering is lib/kernel/video.ts
//     submitVideoGenerationJob (render hold + slot claim + provider job); creation
//     is lib/kernel/content-creators.ts createVideoProject (86B's tier meter).

// TOMBSTONE (orphan tranche 3): createShortClip deleted — a video_snippets
// writer no surface called. The live survivor is
// app/actions/video-repurposing.ts:createVideoSnippet, wired from the snippet
// wizard and repurpose dashboard, and strictly more complete: it stamps the
// caller's brokerage after verifying the source project/asset belongs to it
// (this one wrote no tenant at all), validates platform_target against
// PLATFORM_CONFIGS, enforces end > start and per-platform duration limits,
// and auto-derives the aspect ratio.
