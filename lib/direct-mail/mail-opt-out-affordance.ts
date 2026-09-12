/**
 * lib/direct-mail/mail-opt-out-affordance.ts
 *
 * THE OPT-OUT AS IT APPEARS ON THE PHYSICAL PIECE — one place that turns a
 * recipient's token into the two things printed on the card, so the printed
 * sentence and the printed QR can never encode different recipients.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULING THIS SERVES
 *
 *   owner: "postcards also get a qrcode so maybe the unsubscribe can be part of it"
 *
 * and, earlier, that a contact or lead must be "traceable back to their direct
 * mail campaign to unsubscribe". The token, the resolver and the public surface
 * were built and proved; NOTHING PUT THE LINE ON THE CARD. A suppression rail
 * whose only credential is printed nowhere is a rail nobody can reach.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY BOTH A QR AND A PRINTED URL, AND NOT EITHER ALONE
 *
 * QR-ONLY IS NOT AN OPT-OUT, IT IS A DARE. A QR is opaque: the person holding
 * the card cannot read where it goes. They are being asked to point a camera at
 * an unreadable square, supplied by the sender they want to stop hearing from,
 * and trust that it leads to an unsubscribe page rather than a lead-capture
 * funnel. That is the one situation where a recipient is least willing to trust
 * the sender. It also silently excludes everyone without a smartphone, and the
 * over-65 slice of a farm-mail list is not a rounding error.
 *
 * URL-ONLY IS LEGIBLE AND UNUSED. The canonical URL is 49 characters. Everybody
 * can read it; almost nobody will type it. An opt-out with a realistic
 * completion rate near zero satisfies the letter of the ruling and none of it.
 *
 * SO: BOTH, ENCODING THE SAME URL. The printed sentence is the load-bearing
 * half — it is what makes the piece carry a readable opt-out, it is what tells
 * the scanner what the square is before they scan it, and it is the fallback for
 * anyone who cannot scan. The QR is the friction half: it takes the 49 characters
 * nobody wants to type and makes them one tap. Each fixes exactly the other's
 * defect, which is why this module builds them together from one token and
 * returns them as one value — you cannot take the QR without the line.
 *
 * That asymmetry is declared in lib/remotion/content-contract.ts:
 * `optOutLine` is REQUIRED (a mailed piece without a readable opt-out is the
 * defect) and `optOutQrDataUrl` is COSMETIC (a QR that failed to encode
 * degrades the convenience, not the legitimacy — so it must not cancel an
 * otherwise legitimate send).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CAMPAIGN QR AND THIS QR ARE NOT THE SAME OBJECT AND MUST NEVER MERGE
 *
 * app/api/qr/scan/route.ts says it in its own words:
 *
 *   "A QR code is minted PER CAMPAIGN (qr_codes.slug → direct_mail_campaigns
 *    .qr_code_id), so a scan can never identify an individual recipient row"
 *
 * That is precisely why the opt-out CANNOT ride the `qr_codes` table. If the
 * opt-out were a qr_codes row, every recipient of the campaign would print the
 * same slug and the first person to scan it would suppress whichever single
 * recipient that row happened to name — or nobody, since the row names none.
 *
 * So this module:
 *   · never reads or writes `qr_codes`, has no slug, and takes no campaign id;
 *   · encodes `/unsubscribe/<per-recipient token>` DIRECTLY, so the scan lands
 *     on the token surface and never passes through /api/qr/scan;
 *   · contributes nothing to `scan_count` — an opt-out is not a response, and
 *     counting it as campaign engagement would be a lie in the reporting.
 *
 * Physically the two also stay apart: the campaign response QR is rendered on
 * the postcard FRONT (`qrCodeDataUrl`, classified CHROME), this one on the BACK
 * next to the fine print. Different panel, different prop, different lifetime.
 */

import QRCode from "qrcode"
import {
  normalizeMailUnsubToken,
  buildMailUnsubscribeUrl,
  mailOptOutPrintLine,
} from "@/lib/direct-mail/unsubscribe-token"

/**
 * Rendered edge length of the opt-out QR, in canvas pixels, and the pixel width
 * the PNG is generated at. THE TWO ARE THE SAME NUMBER ON PURPOSE.
 *
 * MEASURED, not guessed. The 4x6 back is a 1275x1875 canvas for a 4x6 inch
 * card — 318 px per inch. The live payload
 * `https://app.vipagentos.com/unsubscribe/K7M2NP4RQ8TVWX` is 53 bytes, which at
 * error correction Q is a VERSION 5 symbol: 37 modules, 39 with the 1-module
 * quiet zone either side. At 280 px `qrcode` picks an integer scale of 7, so a
 * module is 7/318 in = 0.56 mm and the code prints 22.4 mm square. 0.56 mm is
 * comfortably above the ~0.4 mm floor a phone camera needs off paper; a longer
 * `NEXT_PUBLIC_APP_URL` pushing the symbol to version 6 (43 with quiet zone)
 * still lands on scale 6 = 0.48 mm, which still scans.
 *
 * Generating at the DISPLAYED size rather than at 2-3x and downsampling is
 * deliberate: `qrcode` picks an integer px-per-module and centres the result,
 * and resampling that down re-aliases the module edges, which is the classic
 * way a printed QR ends up marginal-to-unscannable. remotion/PostcardBack4x6.tsx
 * renders at this exact number — the constants are checked against each other by
 * scripts/mail-unsubscribe-simulator.ts.
 */
export const MAIL_OPT_OUT_QR_PX = 280

/**
 * Error correction Q (25%). Higher than the M used for the campaign response QR
 * because this square is on the fine-print end of a card that gets folded,
 * franked, rubber-banded and rained on, and because the cost of a failed scan is
 * different in kind: a missed marketing scan is a lost lead, a missed opt-out
 * scan is somebody who asked to be left alone and was not.
 */
export const MAIL_OPT_OUT_QR_OPTIONS = {
  width: MAIL_OPT_OUT_QR_PX,
  margin: 1,
  errorCorrectionLevel: "Q" as const,
  color: { dark: "#000000", light: "#ffffff" },
}

export interface MailOptOutAffordance {
  /** The canonical 14-character token this affordance belongs to. */
  token: string
  /** The full https URL the QR encodes. */
  url: string
  /** The sentence printed on the card, scheme stripped (`mailOptOutPrintLine`). */
  line: string
  /** PNG data URL of the QR, or null when the encoder refused. */
  qrDataUrl: string | null
  /** Why the QR is null. Surfaced, never swallowed — the line still prints. */
  qrError?: string
}

/**
 * buildMailOptOutAffordance — one recipient's token → what gets printed.
 *
 * Returns NULL when the token is missing or malformed. It does not fall back to
 * a campaign-level link, a support address or an empty string: an opt-out
 * affordance that does not resolve to the person holding the card is worse than
 * none, because it looks like a working opt-out and consumes the one attempt
 * most people make. A null return is what makes `optOutLine` unsupplied, which
 * is what the content contract refuses.
 *
 * A QR FAILURE IS NOT AN AFFORDANCE FAILURE. If the encoder throws, the printed
 * line is still returned and the piece still carries a readable, typeable
 * opt-out; only the convenience is lost. That is the whole reason the two halves
 * are classified differently in the content contract.
 */
export async function buildMailOptOutAffordance(
  rawToken: string | null | undefined,
  baseUrl?: string,
): Promise<MailOptOutAffordance | null> {
  const token = normalizeMailUnsubToken(rawToken)
  if (!token) return null

  const url = buildMailUnsubscribeUrl(token, baseUrl)
  const line = mailOptOutPrintLine(token, baseUrl)

  let qrDataUrl: string | null = null
  let qrError: string | undefined
  try {
    qrDataUrl = await QRCode.toDataURL(url, MAIL_OPT_OUT_QR_OPTIONS)
  } catch (e) {
    qrError = e instanceof Error ? e.message : String(e)
    console.error(`[mail-opt-out] QR encode failed for a mail piece; printing the URL only: ${qrError}`)
  }

  return { token, url, line, qrDataUrl, qrError }
}

/**
 * The prop payload the postcard back compositions take. Kept here so a caller
 * cannot pass the line without the QR, or the QR of one recipient beside the
 * line of another.
 */
export interface MailOptOutProps {
  optOutLine: string | null
  optOutQrDataUrl: string | null
}

/**
 * Affordance → the two props, and a NULL affordance → both props EXPLICITLY
 * null rather than omitted. That distinction is load-bearing: Remotion MERGES
 * inputProps over defaultProps, so an omitted prop silently falls back to the
 * composition's Studio default, while an explicit null cannot. Not a
 * hypothetical — it is the exact mechanism lib/remotion/content-contract.ts
 * exists to close.
 */
export function mailOptOutProps(a: MailOptOutAffordance | null): MailOptOutProps {
  if (!a) return { optOutLine: null, optOutQrDataUrl: null }
  return { optOutLine: a.line, optOutQrDataUrl: a.qrDataUrl }
}
