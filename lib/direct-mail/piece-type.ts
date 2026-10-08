/**
 * lib/direct-mail/piece-type.ts
 *
 * THE ONE piece_type VOCABULARY for direct_mail_campaigns (CLAUDE.md §6).
 *
 * The column has no CHECK. Its readers compare against these literals:
 *   - app/api/cron/letter-audio-renderer drains `piece_type = 'letter'`
 *   - app/actions/campaign-bundles.ts and lib/agents/marketing-agent-actions.ts branch on
 *     `'postcard'` / `'letter'`
 *   - app/actions/ai-direct-mail.ts DirectMailPieceType declared the four below as "matches
 *     the piece_type column"
 * The voice webhook (lib/elevenlabs/conv-ai.ts tool schema) and the copilot tool
 * (app/api/internal/ai-chat) speak a second vocabulary: postcard_4x6 | postcard_6x9 |
 * postcard_6x11 | letter | handwritten | thank_you_note. Those spellings used to flow into
 * the column as-is (content-staging passed `pieceType as never`), so a spoken "letter" was
 * the only piece a reader could ever match. Every writer now folds through
 * canonicalCampaignPieceType, and the size is a print detail the campaign row does not
 * carry (direct_mail_presets.postcard_size is where a size lives).
 *
 * Client-safe: no imports.
 */

export const CAMPAIGN_PIECE_TYPES = ["postcard", "letter", "handwritten_letter", "thank_you_note"] as const
export type CampaignPieceType = (typeof CAMPAIGN_PIECE_TYPES)[number]

/** Fold any spoken or typed piece spelling onto the one column vocabulary. Unknown → null
 *  (the caller decides the default, and says so). */
export function canonicalCampaignPieceType(raw: string | null | undefined): CampaignPieceType | null {
  const v = String(raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (!v) return null
  if ((CAMPAIGN_PIECE_TYPES as readonly string[]).includes(v)) return v as CampaignPieceType
  if (v.startsWith("postcard")) return "postcard"
  if (v === "handwritten" || v === "handwritten_note") return "handwritten_letter"
  if (v === "thank_you" || v === "thankyou_note" || v === "thank_you_card") return "thank_you_note"
  return null
}
