/**
 * scripts/open-loop-ledger-dispositions-153l.ts — wave 153, closing (lane 153L's re-check, recorded at integration; owner ruling 16:
 * "fix any notes from all the waves that may still be open or still apply … built but not finished needs finishing").
 *
 * Lane 153L re-read the earlier-wave launch-critical rows the ledger still carried as missing-code against the tree the later
 * wave-153 lanes left. Six findings (eight rows — two were filed twice by two waves) are closed IN CODE by lanes 153P, 153Q and 153S;
 * each was re-read on the integrated tree before it was recorded here, and each carries evidence the generator re-derives on every
 * run (`path#anchor` in STRIPPED source), so a closure that stops being true turns test:open-loop-ledger red. Four findings stay OPEN
 * as the earlier waves dispositioned them (143G-OL-05 / 146I-OL-03, 145A-SO-06 / 146I-OL-05, 146A-SO-02 / 146Z-NC-02, 143D-SO-05).
 * Spread LAST into MANUAL_DISPOSITIONS (scripts/open-loop-ledger-dispositions.ts), after 153K, so the later re-evaluation wins.
 */
import type { Disposition } from "./open-loop-ledger"

const L = "wave 153 closing re-evaluation (lane 153L's re-check, re-read on the integrated tree)"
const cl = (e: string[], note: string): Disposition => ({ s: "closed", e, by: `${L} — ${note}`, lc: true })

const SENDER_UNSET = "lane 153P: no sender literal ships — an unconfigured sending address or domain refuses (`sender_unset`) and the newsletter cron defers the campaign; nothing is sent from a third party's domain"
const PRIVATE_RENDER = "lane 153Q: a render that belongs to one Contact is hosted in the private personal-video bucket (renderHostBucketFor), the public bucket only for a render with no Contact"

export const WAVE153L_DISPOSITIONS: Record<string, Disposition> = {
  "143H-OL-09": cl(["lib/email/orchestrate-email-preset-send.ts#error: \"sender_unset:OUTBOUND_EMAIL_FROM\"", "app/actions/ai-newsletter.ts#sender_unset: NEWSLETTER_FROM_DOMAIN is not configured", "app/api/cron/publish-newsletters/route.ts#\"sender_unset:NEWSLETTER_FROM_DOMAIN\""], SENDER_UNSET),
  "146I-OL-10": cl(["app/actions/ai-newsletter.ts#sender_unset: NEWSLETTER_FROM_DOMAIN is not configured", "app/api/cron/publish-newsletters/route.ts#\"sender_unset:NEWSLETTER_FROM_DOMAIN\""], SENDER_UNSET),
  "146F-OL-05": cl(
    ["app/actions/video/distribute-video.ts#const gated = await insertVideoSocialPostForApproval(supabase, {", "lib/kernel/video.ts#const gated = await insertVideoSocialPostForApproval(supabase, {"],
    "lane 153P: both human publish doors file the social post through insertVideoSocialPostForApproval — neither inserts a post already marked approved",
  ),
  "146B-SO-07": cl(
    ["app/api/webhooks/whatsapp/route.ts#if (!brokerageId) {", "app/api/webhooks/whatsapp/route.ts#const tenantId: string = brokerageId"],
    "lane 153S: an inbound on an unmapped business number returns before any match — nothing is matched, staged or recorded without a tenant, and every later read is pinned to the receiving account's tenant",
  ),
  "146B-SO-06": cl(
    ["app/api/providers/inbound/route.ts#if (senderAuth === \"fail\") {", "app/api/providers/inbound/route.ts#function senderAuthEvidence(providerType: string, raw: unknown)"],
    "lane 153S: the provider-routed door now computes the same sender-authentication verdict as the inbound-mail door (DMARC / aligned DKIM / aligned SPF) and refuses an explicit fail before any match; `unknown` proceeds and is said in the response, exactly as the other door treats it",
  ),
  "146C-SO-04": cl(["lib/remotion/media-host.ts#return project?.contact_id ? PERSONAL_VIDEO_BUCKET : publicBucket", "app/api/internal/remotion/render-composition/route.ts#stillBucket = renderHostBucketFor("], PRIVATE_RENDER),
  "146C-OL-04": cl(["lib/remotion/media-host.ts#return project?.contact_id ? PERSONAL_VIDEO_BUCKET : publicBucket", "app/api/internal/remotion/render-composition/route.ts#stillBucket = renderHostBucketFor("], PRIVATE_RENDER),
}
