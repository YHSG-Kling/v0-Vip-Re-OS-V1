'use server'

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

export async function embedVideoInEmail(emailBody: string, videoUrl: string | null) {
  if (!videoUrl) {
    return emailBody.replace('[Video will be embedded here]',
      '[Note: Personalized video intro is being prepared and will be sent shortly]')
  }
  const videoEmbed = `
    <div style="margin: 20px 0; text-align: center;">
      <video controls style="max-width: 100%; border-radius: 8px;">
        <source src="${videoUrl}" type="video/mp4">
        Your email client doesn't support video playback.
        <a href="${videoUrl}">Click here to watch</a>
      </video>
    </div>
  `
  return emailBody.replace('[Video will be embedded here]', videoEmbed)
}
