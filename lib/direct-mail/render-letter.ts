/**
 * lib/direct-mail/render-letter.ts
 *
 * Wave 36 — Lob letter HTML generator. Lob letters accept HTML
 * directly (the `file` parameter on lob.letters.create can be HTML),
 * so we skip Remotion entirely for letters — HTML rendering is
 * cheaper, more predictable, and Lob handles the PDF conversion +
 * fold + envelope insertion server-side.
 *
 * The HTML follows Lob's letter template requirements:
 *   - 8.5×11" page (Lob handles trim + bleed automatically for letters)
 *   - 0.5" margin on all sides
 *   - Address block in the top-left within the windowed envelope
 *     coordinate area (Lob expects this for the envelope window to
 *     show the recipient address through)
 *   - Equal Housing Opportunity disclosure mandatory at footer
 *
 * AI-drafted body is compliance-gated upstream in lib/direct-mail/
 * draft-copy.ts:draftLetterCopy. This helper only does presentation.
 */
import "server-only"
import { resolveBrandContext } from "@/lib/branding/resolve-brand-context"
import { draftLetterCopy, type DirectMailCopyContext } from "@/lib/direct-mail/draft-copy"
import { HANDWRITING_STYLE_TYPEFACE, layoutContentViolations } from "@/lib/direct-mail/piece-type"
import type { SenderAddress } from "@/lib/providers/mailing-cass-gate"
// WAVE 152 (lane 152C): THE OPTIONAL QR REGION of the letter and personal-note layouts — one decision (the region spec in
// the blank layout library), one encoding contract (quiet zone / error correction / contrast).
import QRCode from "qrcode"
import { decideMailQrRegion, type MailQrRegionDecision } from "@/lib/direct-mail/mail-piece-rules"
import { qrEncodeOptions } from "@/lib/marketing/qr-contract"

export interface RenderLetterArgs {
  brokerageId: string
  copyCtx:     DirectMailCopyContext
  /** Recipient details — substituted into the greeting line. */
  recipientFirstName: string
  recipientLastName:  string
  recipientStreet:    string
  recipientCityState: string
  recipientZip:       string
  /** Agent name for the signoff line (the recipient feels the letter
   *  is from a person, not a template). */
  agentName:          string | null
  agentTitle:         string | null
  /** Wave 151 (151H): `handwriting_style` sets the body and signature in the handwriting-STYLE PRINTED typeface of the
   *  personal-note layout (piece-type.ts HANDWRITING_STYLE_TYPEFACE) — printed, never described as handwritten. */
  noteStyle?:         "handwriting_style" | null
  /** Wave 151 (151H): THE TENANT's return address for the letterhead (the envelope window shows Lob's `from`, which the
   *  dispatcher's sender gate makes the same address). Never the platform's. */
  returnAddress?:     SenderAddress | null
  /** Wave 152 (152C): the campaign's REGISTERED code (`/api/qr/scan?slug=<token>`, minted by lib/marketing/tracked-qr.ts) for
   *  the layout's optional QR region. Absent, unregistered or not active → the region stays blank and the letter still
   *  renders (decideMailQrRegion); it never fails the piece. */
  qrScanUrl?:         string | null
  /** The code's lifecycle state when the caller read it (lib/marketing/qr-contract.ts qrLifecycleState). */
  qrCodeState?:       string | null
}

export interface RenderLetterResult {
  ok:    boolean
  html?: string
  /** Wave 152 (152C): what the optional QR region did — printed (with the token) or left blank, and why. */
  qrRegion?: MailQrRegionDecision
  /** Compliance violations when ok=false. */
  violations?: string[]
  complianceEventId?: string | null
  error?: string
}

const escape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** The QR region's markup: a VECTOR symbol at the layout's print size (the quiet zone is inside it — the encoder's
 *  margin), a one-line prompt, and the code's token in small type (what the scan maps back to). Empty when not printed.
 *  Placed BEFORE the body in the page and positioned absolutely (bottom-right, above the footer disclosure): its place on
 *  paper never depends on the body's length, and a caller that swaps the body for locked copy (the preset path) cannot
 *  remove it. */
async function qrRegionHtml(region: MailQrRegionDecision): Promise<string> {
  if (!region.print) return ""
  const svg = await QRCode.toString(region.scanUrl, { ...qrEncodeOptions(Math.round(region.sizeIn * 300)), type: "svg" })
  return `<div class="qr-region" data-qr-token="${escape(region.token)}">
        <div class="qr-symbol">${svg}</div>
        <div class="qr-caption">Scan with your phone camera</div>
        <div class="qr-token">${escape(region.token)}</div>
      </div>`
}

export async function renderLetterHtml(
  args: RenderLetterArgs,
  /** Proof seam (wave 152, 152C — scripts/direct-mail-rendering-guard.ts §L drives the REAL renderer): the brand cascade
   *  and the copy writer, injected. Production callers pass nothing and get the real ones. */
  deps: { resolveBrand?: typeof resolveBrandContext; draftCopy?: typeof draftLetterCopy } = {},
): Promise<RenderLetterResult> {
  const brand = await (deps.resolveBrand ?? resolveBrandContext)({
    brokerageId: args.brokerageId,
    teamId:      args.copyCtx.teamId ?? null,
    agentUserId: args.copyCtx.agentUserId ?? null,
  })

  const copyResult = await (deps.draftCopy ?? draftLetterCopy)(args.copyCtx)
  if (!copyResult.ok) {
    return { ok: false, error: "compliance_gate_failed", violations: copyResult.violations, complianceEventId: copyResult.complianceEventId }
  }
  const { greeting, body, signoff } = copyResult.copy

  // Substitute {{first_name}} the prompt was told to emit.
  const greetingFilled = greeting.replace(/{{\s*first_name\s*}}/gi, escape(args.recipientFirstName))

  // Body paragraphs — the model returns body as a string; split on
  // blank lines so we render real <p> tags rather than one giant <p>.
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  const agentLine = args.agentName
    ? `${escape(args.agentName)}${args.agentTitle ? ` — ${escape(args.agentTitle)}` : ""}`
    : escape(brand.displayName)

  // Wave 151 (151H): the personal-note LAYOUT sets the body in the handwriting-style PRINTED typeface (a layout constant —
  // the brand font keeps the letterhead and footer). The tenant's own return address prints on the letterhead; the layout
  // itself names no address and no brand.
  const note = args.noteStyle === "handwriting_style"
  const noteFontLink = note ? `<link rel="stylesheet" href="${HANDWRITING_STYLE_TYPEFACE.cssUrl}" />` : ""
  const bodyFont = note ? `'${HANDWRITING_STYLE_TYPEFACE.family}', cursive` : "Georgia, 'Times New Roman', serif"
  const bodySize = note ? "15pt" : "12pt"
  const ra = args.returnAddress ?? null
  // Wave 152 (152C): the layout's OPTIONAL QR region — the letter's or the personal note's, per the layout library.
  const qrRegion = decideMailQrRegion({ layout: note ? "personal_letter" : "letter", scanUrl: args.qrScanUrl ?? null, codeState: args.qrCodeState ?? null })
  const qrMarkup = await qrRegionHtml(qrRegion)
  const qrSize = qrRegion.print ? `${qrRegion.sizeIn}in` : "0"

  // Lob's letter spec: full 8.5×11 page, address block in the upper-
  // left envelope window region (top: ~0.94", left: ~0.5", width
  // ~3.5"). The letter body lives below the address block.
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
${noteFontLink}
<style>
  @page { size: letter; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; width: 8.5in; height: 11in; font-family: Georgia, 'Times New Roman', serif; color: #111; }
  .page { position: relative; width: 8.5in; height: 11in; padding: 0.5in; }
  .return { font-size: 9pt; line-height: 1.3; color: #444; }
  .return .name { font-weight: 700; color: ${brand.visual.primaryColor}; }
  .recipient { position: absolute; top: 1.7in; left: 0.5in; width: 3.5in; font-size: 11pt; line-height: 1.35; }
  .date { position: absolute; top: 2.6in; left: 0.5in; font-size: 11pt; }
  .body { margin-top: 3.1in; font-family: ${bodyFont}; font-size: ${bodySize}; line-height: 1.55; }
  .body p { margin: 0 0 12pt 0; }
  .signoff { margin-top: 18pt; font-family: ${bodyFont}; font-size: ${bodySize}; line-height: 1.45; }
  .footer { position: absolute; bottom: 0.4in; left: 0.5in; right: 0.5in; padding-top: 6pt; border-top: 1pt solid ${brand.visual.accentColor}; font-size: 8pt; line-height: 1.35; color: #555; }
  .footer .legal { margin-top: 4pt; }
  .qr-region { position: absolute; right: 0.5in; bottom: 0.95in; width: ${qrSize}; text-align: center; font-family: Arial, Helvetica, sans-serif; color: #111; }
  .qr-symbol { width: ${qrSize}; height: ${qrSize}; background: #fff; }
  .qr-symbol svg { width: 100%; height: 100%; display: block; }
  .qr-caption { font-size: 7pt; margin-top: 2pt; }
  .qr-token { font-size: 5.5pt; color: #555; letter-spacing: 0.02em; word-break: break-all; }
</style>
</head>
<body>
  <div class="page">
    <div class="return">
      <div class="name">${escape(brand.displayName)}</div>
      ${brand.displayName !== brand.brokerageName ? `<div style="font-size:8pt;color:#666;">brokered by ${escape(brand.brokerageName)}</div>` : ""}
      ${ra ? `<div>${escape(ra.line1)}${ra.line2 ? `, ${escape(ra.line2)}` : ""}</div><div>${escape(ra.city)}, ${escape(ra.state)} ${escape(ra.zip)}</div>` : ""}
      ${brand.display.websiteWordmark ? `<div>${escape(brand.display.websiteWordmark)}</div>` : ""}
      ${brand.display.phone ? `<div>${escape(brand.display.phone)}</div>` : ""}
    </div>

    <div class="recipient">
      ${escape(args.recipientFirstName)} ${escape(args.recipientLastName)}<br/>
      ${escape(args.recipientStreet)}<br/>
      ${escape(args.recipientCityState)} ${escape(args.recipientZip)}
    </div>

    <div class="date">${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</div>

    ${qrMarkup}

    <div class="body">
      <p>${escape(greetingFilled)}</p>
      ${paragraphs.map((p) => `<p>${escape(p)}</p>`).join("\n      ")}
      <div class="signoff">
        <p>${escape(signoff)}</p>
        <p>${agentLine}</p>
      </div>
    </div>

    <div class="footer">
      ${brand.display.licenseLine ? `<div>${escape(brand.display.licenseLine)}</div>` : ""}
      ${note ? `<div>Printed in a handwriting-style typeface.</div>` : ""}
      <div class="legal">${escape(brand.fairHousing.longDisclosure)}</div>
    </div>
  </div>
</body>
</html>`

  // A TENANT's piece never carries the platform's identity or a saved Lob address id (piece-type.ts layoutContentViolations —
  // the same scan the proof runs on the blank layouts). Refused, said, never mailed.
  const violations = layoutContentViolations(html)
  if (violations.length) {
    return { ok: false, error: "layout_content_refused", violations: violations.map((v) => `rendered piece carries ${v}`), complianceEventId: copyResult.complianceEventId }
  }

  return { ok: true, html, complianceEventId: copyResult.complianceEventId, qrRegion }
}
