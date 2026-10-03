// NOT a server-action module (2026-09-03, lane R3-A; template
// lib/behavior-learning/preference-updater.ts:1-9). The module-level "use server"
// that stood here published embedVideoInEmail(emailBody, videoUrl, posterUrl) —
// a PURE string helper, no client, no tenant — as a public HTTP door: nothing to
// steal, but an anonymous RPC that will splice any URL into any HTML for anyone
// who asks is not a capability this app offers. Every caller is in-process
// server code (re-verified 2026-09-03):
//   · lib/kernel/client-welcome.ts:857 (dynamic import, server lib)
//   · lib/ai-isa/index.ts (the barrel), whose only value importers are the
//     "use server" actions app/actions/ai-isa/engage-contact.ts:30,
//     handle-inbound-email.ts:19 and initiate-engagement.ts:31 (the `./ai-isa`
//     in lib/kernel/index.ts and lib/application/index.ts is each package's
//     OWN ai-isa module, not this barrel)
// so the directive published nothing anyone needed. `server-only` makes a future
// client import fail at build time — the same rule as its siblings, kept
// uniform so the barrel stays one kind of thing.
import "server-only"

// AI-ISA email video embed helper.
//
// NOTE: the old generateAvatarVideo (a basic per-recipient D-ID avatar synthesized inline on
// every touch) has been REMOVED — it was superseded everywhere by the governed Video Director
// rail (lib/video/video-director commissionVideo: format selection, brand bookends, tracked QR,
// compliance gate) reached via the asset_manager:lead_creative_handoff bus play for leads and
// the dedicated situational reel producers (anniversary-equity / buyer-match / equity-trigger)
// for contacts. The ISA's re-engagement email now embeds the contact's most recent COMPLETED
// situational reel instead of synthesizing a throwaway clip. embedVideoInEmail stays — it is the
// shared seam that drops a resolved reel URL (or a graceful "being prepared" note) into a body.

/**
 * embedVideoInEmail — drop a resolved reel into the body. A THUMBNAIL (poster) always rides
 * with the video: most email clients strip <video>, so a clickable poster image with a play
 * overlay is the universal fallback (and the <video> poster shows the same frame before play
 * where supported). posterUrl = ai_video_projects.thumbnail_url; null → a play-link fallback.
 */
export async function embedVideoInEmail(emailBody: string, videoUrl: string | null, posterUrl?: string | null) {
  if (!videoUrl) {
    return emailBody.replace('[Video will be embedded here]',
      '[Note: Personalized video intro is being prepared and will be sent shortly]')
  }
  const poster = posterUrl ? ` poster="${posterUrl}"` : ''
  // The universal fallback shown when a client can't render <video> — a clickable thumbnail
  // (with a play glyph) when we have a poster, else a plain watch link.
  const fallback = posterUrl
    ? `<a href="${videoUrl}" style="display:inline-block;position:relative;text-decoration:none;">` +
      `<img src="${posterUrl}" alt="Watch your video" width="480" style="max-width:100%;border-radius:8px;display:block;" />` +
      `<span style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:52px;line-height:1;color:#ffffff;text-shadow:0 2px 10px rgba(0,0,0,.6);">&#9658;</span>` +
      `</a>`
    : `Your email client doesn't support video playback. <a href="${videoUrl}">Click here to watch</a>`
  const videoEmbed = `
    <div style="margin: 20px 0; text-align: center;">
      <video controls${poster} style="max-width: 100%; border-radius: 8px;">
        <source src="${videoUrl}" type="video/mp4">
        ${fallback}
      </video>
    </div>
  `
  return emailBody.replace('[Video will be embedded here]', videoEmbed)
}
