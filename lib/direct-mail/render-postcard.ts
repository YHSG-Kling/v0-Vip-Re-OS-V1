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
import { put } from "@vercel/blob"
import QRCode from "qrcode"
import { selectComposition, renderStill } from "@remotion/renderer"
import { getBundle } from "@/lib/remotion/bundle-cache"
import { resolveBrokerageBrandContext } from "@/lib/branding/resolve-brokerage-brand"
import { draftPostcardCopy, type DirectMailCopyContext } from "@/lib/direct-mail/draft-copy"
import path from "node:path"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"

export interface RenderPostcardArgs {
  brokerageId: string
  copyCtx:     DirectMailCopyContext
  /** The QR scan URL the postcard's QR encodes. Caller is responsible
   *  for creating the qr_codes row + slug; we just encode the slug
   *  redirector URL into the PNG so scanning lands at /api/qr/scan
   *  which records the event + redirects to the destination. */
  qrScanUrl:   string | null
}

export interface RenderPostcardResult {
  ok:       boolean
  url?:     string
  width?:   number
  height?:  number
  copy?:    { headline: string; body: string; cta: string }
  error?:   string
  /** Compliance violations when ok=false because the copy gate failed. */
  violations?: string[]
}

export async function renderPostcardFront4x6(
  args: RenderPostcardArgs,
): Promise<RenderPostcardResult> {
  // 1. Brand context — primary/accent color, logo, license, Fair Housing line.
  const brand = await resolveBrokerageBrandContext(args.brokerageId)

  // 2. AI-drafted copy with compliance redraft loop. Fail closed if
  //    both attempts violate — dispatchDirectMail caller will fall
  //    back to a static Lob template rather than mail copy the gate
  //    rejected.
  const copyResult = await draftPostcardCopy(args.copyCtx)
  if (!copyResult.ok) {
    return { ok: false, error: "compliance_gate_failed", violations: copyResult.violations }
  }

  // 3. QR PNG. qrcode renders to a data URL we can drop straight into
  //    the Remotion composition's <Img>.
  let qrCodeDataUrl: string | null = null
  if (args.qrScanUrl) {
    qrCodeDataUrl = await QRCode.toDataURL(args.qrScanUrl, {
      width: 600,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#000000", light: "#ffffff" },
    })
  }

  // 4. Bundle + select + renderStill. Bundle is module-cached so
  //    subsequent renders in the same warm function reuse it.
  const entry = path.join(process.cwd(), "remotion", "Root.tsx")
  const serveUrl = await getBundle(entry)

  const inputProps = {
    headline: copyResult.copy.headline,
    body:     copyResult.copy.body,
    cta:      copyResult.copy.cta,
    qrCodeDataUrl,
    brand: {
      primaryColor:    brand.visual.primaryColor,
      accentColor:     brand.visual.accentColor,
      logoUrl:         brand.visual.logoUrl,
      brokerageName:   brand.brokerageName,
      websiteWordmark: brand.display.websiteWordmark,
      phone:           brand.display.phone,
      licenseLine:     brand.display.licenseLine,
      shortDisclosure: brand.fairHousing.shortDisclosure,
    },
  }

  const composition = await selectComposition({
    serveUrl,
    id: "PostcardFront4x6",
    inputProps,
  })

  const outPath = path.join(tmpdir(), `postcard-${Date.now()}.png`)
  await renderStill({
    composition,
    serveUrl,
    output: outPath,
    inputProps,
    imageFormat: "png",
  })

  // 5. Upload to Vercel Blob — Lob will fetch from this URL.
  const buf = await fs.readFile(outPath)
  await fs.unlink(outPath).catch(() => {})
  const uploaded = await put(
    `direct-mail/postcard-4x6/${args.brokerageId}/${Date.now()}.png`,
    buf,
    { access: "public", contentType: "image/png" },
  )

  return {
    ok:     true,
    url:    uploaded.url,
    width:  composition.width,
    height: composition.height,
    copy:   copyResult.copy,
  }
}
