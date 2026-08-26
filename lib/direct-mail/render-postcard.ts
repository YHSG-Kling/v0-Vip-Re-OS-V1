/**
 * lib/direct-mail/render-postcard.ts
 *
 * Wave 36 — server-side renderer for the 4×6 postcard composition.
 * Composes brand context + AI-drafted compliance-gated copy + a QR
 * PNG data URL, runs Remotion's renderStill() through the cached
 * bundler, uploads the resulting PNG to Vercel Blob, and returns
 * the public URL. dispatchDirectMail can then pass that URL straight
 * to lob.postcards.create({ front: <url> }).
 *
 * Why renderStill and not renderMedia: the postcard composition is
 * pure (durationInFrames=1, no animation). renderStill is the right
 * tool — it skips the video encoding pipeline entirely and produces
 * a PNG in 1-3 seconds vs renderMedia's 8-12s for a 1-frame video.
 *
 * No stubs: the path runs end-to-end against real Lob + real Vercel
 * Blob + real Anthropic. Caller is responsible for compliance gate
 * status — if draftPostcardCopy returns ok=false the helper returns
 * ok=false and dispatchDirectMail falls back to the brokerage's
 * pre-uploaded Lob template id.
 */
import "server-only"
// Was `import { put } from "@vercel/blob"`. Survivor:
// lib/remotion/media-host.ts#hostRenderedMedia → Supabase `media`, the bucket
// lib/storage/document-buckets.ts designates for assets a delivery vendor
// fetches unauthenticated — Lob pulls these panel PNGs by URL at print time.
import { hostRenderedMedia } from "@/lib/remotion/media-host"
import { createServiceClient } from "@/lib/supabase/service"
import QRCode from "qrcode"
import { selectComposition, renderStill } from "@remotion/renderer"
import { getBundle } from "@/lib/remotion/bundle-cache"
import { resolveBrandContext } from "@/lib/branding/resolve-brand-context"
import { draftPostcardCopy, type DirectMailCopyContext } from "@/lib/direct-mail/draft-copy"
import { buildMailOptOutAffordance, mailOptOutProps } from "@/lib/direct-mail/mail-opt-out-affordance"
import path from "node:path"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"

/** Both-sides render result. Front + back URLs ready to drop into
 *  lob.postcards.create({ front: frontUrl, back: backUrl }). */
export interface RenderPostcardBothSidesResult {
  ok:        boolean
  frontUrl?: string
  backUrl?:  string
  copy?:     { headline: string; body: string; cta: string }
  complianceEventId?: string | null
  error?:    string
  violations?: string[]
}

// TOMBSTONE (orphan tranche 4): renderPostcardFront4x6 deleted. The survivor is
// renderPostcardBothSides4x6 below — same brand context, same compliance-gated
// copy draft, same QR + renderStill + Blob upload, and it renders the BACK the
// front-only path never produced (Lob postcards require both sides). Wired live
// from lib/direct-mail/orchestrate-send.ts and app/actions/direct-mail-preview.ts.

/**
 * renderPostcardBothSides4x6
 *
 * Renders front + back of a 4×6 postcard in a single call. Drafts
 * the copy ONCE and reuses it across both sides (so the body on
 * the back is verbatim the same body that earned the headline on
 * the front — coherent reading order). Compliance gate runs once
 * because the copy bundle is the same.
 *
 * Returns frontUrl + backUrl. dispatchDirectMail caller passes
 * them as `templateId` (front) + `backTemplateId` (back).
 *
 * For 6×9 (premium tier), use renderPostcardBothSides6x9 instead.
 */
export async function renderPostcardBothSides4x6(args: {
  brokerageId: string
  copyCtx:     DirectMailCopyContext
  /** CAMPAIGN-level response QR (a qr_codes slug shared by every recipient of
   *  this campaign). Front panel only. NOT the opt-out — see below. */
  qrScanUrl:   string | null
  agentName:   string | null
  agentPhotoUrl: string | null
  /**
   * THIS RECIPIENT's `direct_mail_recipients.unsubscribe_token`, read straight
   * off the row the drain just inserted. PER-RECIPIENT and never shared: it is
   * the only credential the public opt-out surface accepts, and it names one
   * person on one campaign.
   *
   * Deliberately a TOKEN and not a URL: taking a URL here would let a caller
   * hand this argument the campaign's `qrScanUrl` by mistake, and the two
   * arguments would then be interchangeable at the type level. A token can only
   * come from a recipient row.
   *
   * Null (no row, or the insert was refused) prints no opt-out row, which the
   * content contract classifies as an unsatisfied REQUIRED prop rather than a
   * quietly opt-out-less card.
   */
  unsubscribeToken?: string | null
}): Promise<RenderPostcardBothSidesResult> {
  const brand = await resolveBrandContext({
    brokerageId: args.brokerageId,
    teamId:      args.copyCtx.teamId ?? null,
    agentUserId: args.copyCtx.agentUserId ?? null,
  })
  const copyResult = await draftPostcardCopy(args.copyCtx)
  if (!copyResult.ok) {
    return { ok: false, error: "compliance_gate_failed", violations: copyResult.violations, complianceEventId: copyResult.complianceEventId }
  }

  let qrCodeDataUrl: string | null = null
  if (args.qrScanUrl) {
    qrCodeDataUrl = await QRCode.toDataURL(args.qrScanUrl, {
      width: 600,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#000000", light: "#ffffff" },
    })
  }

  const entry = path.join(process.cwd(), "remotion", "Root.tsx")
  const serveUrl = await getBundle(entry)

  const brandProp = {
    primaryColor:    brand.visual.primaryColor,
    accentColor:     brand.visual.accentColor,
    logoUrl:         brand.visual.logoUrl,
    brokerageName:   brand.brokerageName,
    websiteWordmark: brand.display.websiteWordmark,
    phone:           brand.display.phone,
    licenseLine:     brand.display.licenseLine,
    shortDisclosure: brand.fairHousing.shortDisclosure,
  }

  // Render front
  const frontInput = {
    headline: copyResult.copy.headline,
    body:     copyResult.copy.body,
    cta:      copyResult.copy.cta,
    qrCodeDataUrl,
    brand: brandProp,
  }
  const frontComp = await selectComposition({ serveUrl, id: "PostcardFront4x6", inputProps: frontInput })
  const frontPath = path.join(tmpdir(), `postcard-front-${Date.now()}.png`)
  await renderStill({
    composition: frontComp, serveUrl,
    output: frontPath, inputProps: frontInput, imageFormat: "png",
  })

  // ── THE OPT-OUT ON THE PIECE ────────────────────────────────────────────
  // Built from the RECIPIENT's token, on the BACK, and structurally separate
  // from the campaign QR above: that one came from `args.qrScanUrl` (a qr_codes
  // slug every recipient of this campaign shares) and goes on the FRONT; this
  // one encodes /unsubscribe/<this recipient's token> and never reads, writes
  // or counts against the qr_codes table. Collapsing the two would print one
  // shared code on every card, so the first scan would suppress a stranger.
  const optOut = mailOptOutProps(await buildMailOptOutAffordance(args.unsubscribeToken))

  // Render back
  const backInput = {
    body:    copyResult.copy.body,
    signoff: args.agentName ? `— ${args.agentName.split(" ")[0] ?? args.agentName}` : null,
    agentPhotoUrl: args.agentPhotoUrl,
    agentName: args.agentName,
    ...optOut,
    brand: brandProp,
  }
  const backComp = await selectComposition({ serveUrl, id: "PostcardBack4x6", inputProps: backInput })
  const backPath = path.join(tmpdir(), `postcard-back-${Date.now()}.png`)
  await renderStill({
    composition: backComp, serveUrl,
    output: backPath, inputProps: backInput, imageFormat: "png",
  })

  // Upload both
  const [frontBuf, backBuf] = await Promise.all([
    fs.readFile(frontPath),
    fs.readFile(backPath),
  ])
  await Promise.all([fs.unlink(frontPath).catch(() => {}), fs.unlink(backPath).catch(() => {})])

  const stamp = Date.now()
  const svc = createServiceClient()
  const [frontUp, backUp] = await Promise.all([
    hostRenderedMedia(svc, `direct-mail/postcard-4x6/${args.brokerageId}/${stamp}-front.png`, frontBuf, "image/png", "media"),
    hostRenderedMedia(svc, `direct-mail/postcard-4x6/${args.brokerageId}/${stamp}-back.png`, backBuf, "image/png", "media"),
  ])

  return {
    ok:       true,
    frontUrl: frontUp,
    backUrl:  backUp,
    copy:     copyResult.copy,
    complianceEventId: copyResult.complianceEventId,
  }
}

/**
 * renderPostcardBothSides6x9
 *
 * Lob's premium postcard tier (~$1.10/piece, ~40% more than 4×6).
 * Reserve for sends where the larger canvas earns its cost:
 *   - Listing promos (just_listed, just_sold, open_house, price_
 *     reduction) — the property photo carries the impact
 *   - Luxury persona pieces (statusBadge="JUST LISTED" on a $2M+
 *     home — the agent paying extra postage signals premium service)
 *   - Lifetime-customer reach-outs (anniversaryYears worth the cost)
 *
 * The optional propertyPhotoUrl + statusBadge are what justify 6×9 —
 * without a photo this composition is just a more expensive 4×6.
 */
export async function renderPostcardBothSides6x9(args: {
  brokerageId: string
  copyCtx:     DirectMailCopyContext
  qrScanUrl:   string | null
  agentName:   string | null
  agentPhotoUrl: string | null
  /** Property photo for the front-hero (top 55% of the canvas). */
  propertyPhotoUrl: string | null
  /** Status badge — "JUST LISTED" | "JUST SOLD" | "OPEN HOUSE" | etc.
   *  Null = no badge. */
  statusBadge: string | null
  /** Optional pull quote on the back. */
  pullQuote: string | null
}): Promise<RenderPostcardBothSidesResult> {
  const brand = await resolveBrandContext({
    brokerageId: args.brokerageId,
    teamId:      args.copyCtx.teamId ?? null,
    agentUserId: args.copyCtx.agentUserId ?? null,
  })
  const copyResult = await draftPostcardCopy(args.copyCtx)
  if (!copyResult.ok) {
    return { ok: false, error: "compliance_gate_failed", violations: copyResult.violations, complianceEventId: copyResult.complianceEventId }
  }

  let qrCodeDataUrl: string | null = null
  if (args.qrScanUrl) {
    qrCodeDataUrl = await QRCode.toDataURL(args.qrScanUrl, {
      width: 720, margin: 1, errorCorrectionLevel: "M",
      color: { dark: "#000000", light: "#ffffff" },
    })
  }

  const entry = path.join(process.cwd(), "remotion", "Root.tsx")
  const serveUrl = await getBundle(entry)
  const brandProp = {
    primaryColor:    brand.visual.primaryColor,
    accentColor:     brand.visual.accentColor,
    logoUrl:         brand.visual.logoUrl,
    brokerageName:   brand.brokerageName,
    websiteWordmark: brand.display.websiteWordmark,
    phone:           brand.display.phone,
    licenseLine:     brand.display.licenseLine,
    shortDisclosure: brand.fairHousing.shortDisclosure,
  }

  const frontInput = {
    headline:         copyResult.copy.headline,
    body:             copyResult.copy.body,
    cta:              copyResult.copy.cta,
    statusBadge:      args.statusBadge,
    propertyPhotoUrl: args.propertyPhotoUrl,
    qrCodeDataUrl,
    brand: brandProp,
  }
  const frontComp = await selectComposition({ serveUrl, id: "PostcardFront6x9", inputProps: frontInput })
  const frontPath = path.join(tmpdir(), `postcard6x9-front-${Date.now()}.png`)
  await renderStill({
    composition: frontComp, serveUrl,
    output: frontPath, inputProps: frontInput, imageFormat: "png",
  })

  const backInput = {
    body:    copyResult.copy.body,
    pullQuote: args.pullQuote,
    signoff: args.agentName ? `— ${args.agentName.split(" ")[0] ?? args.agentName}` : null,
    agentPhotoUrl: args.agentPhotoUrl,
    agentName: args.agentName,
    brand: brandProp,
  }
  const backComp = await selectComposition({ serveUrl, id: "PostcardBack6x9", inputProps: backInput })
  const backPath = path.join(tmpdir(), `postcard6x9-back-${Date.now()}.png`)
  await renderStill({
    composition: backComp, serveUrl,
    output: backPath, inputProps: backInput, imageFormat: "png",
  })

  const [frontBuf, backBuf] = await Promise.all([
    fs.readFile(frontPath), fs.readFile(backPath),
  ])
  await Promise.all([fs.unlink(frontPath).catch(() => {}), fs.unlink(backPath).catch(() => {})])

  const stamp = Date.now()
  const svc = createServiceClient()
  const [frontUp, backUp] = await Promise.all([
    hostRenderedMedia(svc, `direct-mail/postcard-6x9/${args.brokerageId}/${stamp}-front.png`, frontBuf, "image/png", "media"),
    hostRenderedMedia(svc, `direct-mail/postcard-6x9/${args.brokerageId}/${stamp}-back.png`, backBuf, "image/png", "media"),
  ])

  return {
    ok:       true,
    frontUrl: frontUp,
    backUrl:  backUp,
    copy:     copyResult.copy,
    complianceEventId: copyResult.complianceEventId,
  }
}
