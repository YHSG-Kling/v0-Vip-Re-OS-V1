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
}

export interface RenderLetterResult {
  ok:    boolean
  html?: string
  /** Compliance violations when ok=false. */
  violations?: string[]
  error?: string
}

const escape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

export async function renderLetterHtml(
  args: RenderLetterArgs,
): Promise<RenderLetterResult> {
  const brand = await resolveBrandContext({
    brokerageId: args.brokerageId,
    teamId:      args.copyCtx.teamId ?? null,
    agentUserId: args.copyCtx.agentUserId ?? null,
  })

  const copyResult = await draftLetterCopy(args.copyCtx)
  if (!copyResult.ok) {
    return { ok: false, error: "compliance_gate_failed", violations: copyResult.violations }
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

  // Lob's letter spec: full 8.5×11 page, address block in the upper-
  // left envelope window region (top: ~0.94", left: ~0.5", width
  // ~3.5"). The letter body lives below the address block.
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  @page { size: letter; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; width: 8.5in; height: 11in; font-family: Georgia, 'Times New Roman', serif; color: #111; }
  .page { position: relative; width: 8.5in; height: 11in; padding: 0.5in; }
  .return { font-size: 9pt; line-height: 1.3; color: #444; }
  .return .name { font-weight: 700; color: ${brand.visual.primaryColor}; }
  .recipient { position: absolute; top: 1.7in; left: 0.5in; width: 3.5in; font-size: 11pt; line-height: 1.35; }
  .date { position: absolute; top: 2.6in; left: 0.5in; font-size: 11pt; }
  .body { margin-top: 3.1in; font-size: 12pt; line-height: 1.55; }
  .body p { margin: 0 0 12pt 0; }
  .signoff { margin-top: 18pt; font-size: 12pt; line-height: 1.45; }
  .footer { position: absolute; bottom: 0.4in; left: 0.5in; right: 0.5in; padding-top: 6pt; border-top: 1pt solid ${brand.visual.accentColor}; font-size: 8pt; line-height: 1.35; color: #555; }
  .footer .legal { margin-top: 4pt; }
</style>
</head>
<body>
  <div class="page">
    <div class="return">
      <div class="name">${escape(brand.displayName)}</div>
      ${brand.displayName !== brand.brokerageName ? `<div style="font-size:8pt;color:#666;">brokered by ${escape(brand.brokerageName)}</div>` : ""}
      ${brand.display.websiteWordmark ? `<div>${escape(brand.display.websiteWordmark)}</div>` : ""}
      ${brand.display.phone ? `<div>${escape(brand.display.phone)}</div>` : ""}
    </div>

    <div class="recipient">
      ${escape(args.recipientFirstName)} ${escape(args.recipientLastName)}<br/>
      ${escape(args.recipientStreet)}<br/>
      ${escape(args.recipientCityState)} ${escape(args.recipientZip)}
    </div>

    <div class="date">${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</div>

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
      <div class="legal">${escape(brand.fairHousing.longDisclosure)}</div>
    </div>
  </div>
</body>
</html>`

  return { ok: true, html }
}
