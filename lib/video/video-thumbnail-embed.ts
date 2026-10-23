/**
 * lib/video/video-thumbnail-embed.ts
 *
 * ONE definition of "a finished reel, inside an email".
 *
 * The owner's stated delivery shape for a finished reel: an email carrying a
 * THUMBNAIL that links to the video in our Supabase bucket (video_url is the
 * persisted bucket URL by the time a reel is finished — poll-did-videos
 * downloads the D-ID render into the bucket before completing the row). Falls
 * back to a button when the render produced no thumbnail, because a bare URL in
 * an email body is the thing this shape exists to avoid.
 *
 * Lifted out of lib/orchestrator/internal.ts so the pre-listing section drip
 * (lib/listing-presentation/section-drip.ts) and the campaign-asset embed share
 * ONE block instead of drifting into two different-looking emails for the same
 * product. Kept dependency-free on purpose: the drip cron must not pull the
 * orchestrator's whole handler graph in just to render an <img>.
 */

/** Minimal HTML escape for attribute/text interpolation inside the block. */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!))
}

export function videoThumbnailEmbed(videoUrl: string, thumbnailUrl?: string | null): string {
  return (
    `\n\n<div style="margin:24px 0;text-align:center">` +
    `<a href="${esc(videoUrl)}" target="_blank">` +
    (thumbnailUrl
      ? `<img src="${esc(thumbnailUrl)}" alt="Watch video" style="max-width:480px;width:100%;border-radius:8px"/>`
      : `<span style="display:inline-block;padding:14px 28px;background:#2563eb;color:#fff;border-radius:6px;font-weight:600">Watch the video</span>`) +
    `</a></div>\n`
  )
}
