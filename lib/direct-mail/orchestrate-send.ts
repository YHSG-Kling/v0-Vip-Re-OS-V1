/**
 * lib/direct-mail/orchestrate-send.ts
 *
 * Wave 36 — orchestrates a render-then-dispatch flow for a single
 * direct-mail piece. Renders the piece's design (Remotion still for
 * postcard fronts, HTML for letters), uploads PNG outputs to Vercel
 * Blob, then dispatches through dispatchDirectMail with the rendered
 * URL/HTML in place of a pre-uploaded Lob template id.
 *
 * Why a separate orchestrator (not folded into dispatchDirectMail):
 *   - dispatchDirectMail is a generic egress chokepoint with consent
 *     gates + provider routing + de-conflict — it should NOT know
 *     about Remotion or AI-drafted copy. The orchestrator owns the
 *     "compose a custom piece" path; existing callers that mail from
 *     a static Lob template stay on dispatchDirectMail directly.
 *
 *   - Fall-through: when copy generation fails (compliance gate or
 *     model error), the orchestrator falls back to the brokerage's
 *     pre-uploaded static template id so the channel never goes dark.
 *     The fallback is auditable — orchestrate_outcome.fellBackTo
 *     carries the reason.
 */
import "server-only"
import { dispatchDirectMail, type DirectMailPieceType } from "@/lib/providers/dispatch"
import { renderPostcardBothSides4x6, renderPostcardBothSides6x9 } from "@/lib/direct-mail/render-postcard"
import { renderLetterHtml } from "@/lib/direct-mail/render-letter"
import type { DirectMailCopyContext } from "@/lib/direct-mail/draft-copy"

export type PostcardSize = "4x6" | "6x9"

export interface OrchestrateSendArgs {
  brokerageId: string
  /** Either lead OR contact recipient — at least one required. */
  leadId?:     string
  contactId?:  string
  userId?:     string
  agentId?:    string
  recipientName: string
  mailingAddress: string
  city:  string
  state: string
  zip:   string
  pieceType: DirectMailPieceType
  copyCtx:   DirectMailCopyContext
  /** Optional QR scan URL (already minted by caller) embedded in the
   *  postcard's QR. Letters typically don't carry QRs. */
  qrScanUrl?: string | null
  /** Fall-back Lob template id when render/copy fails. Required for
   *  the fall-through path to work. */
  fallbackTemplateId: string
  /** Agent context for the letter signoff. */
  agentName?:  string | null
  agentTitle?: string | null
  systemSource?: string
  /** Postcard size when pieceType='postcard'. Default 4x6. 6x9 is
   *  Lob's premium tier (~$1.10/piece vs ~$0.78 for 4x6) and gets a
   *  property photo hero + status badge — reserve for listing
   *  promos, luxury persona, and lifetime-customer reach-outs. */
  postcardSize?: PostcardSize
  /** Optional 6x9-only inputs. Ignored for 4x6 sends. */
  propertyPhotoUrl?: string | null
  statusBadge?:     string | null
  pullQuote?:       string | null
}

export interface OrchestrateSendResult {
  success:    boolean
  providerKey?: string
  messageId?:   string
  /** When true the orchestrator used the rendered piece; when false
   *  it fell back to the static Lob template id. */
  rendered:     boolean
  /** Why we fell back — null if rendered=true. */
  fellBackReason: string | null
  error?:       string
}

export async function orchestrateRenderAndSend(
  args: OrchestrateSendArgs,
): Promise<OrchestrateSendResult> {
  // Render path varies by piece type.
  let templateForLob:     string | undefined
  let backTemplateForLob: string | undefined
  let rendered = false
  let fellBackReason: string | null = null

  if (args.pieceType === "postcard") {
    const size: PostcardSize = args.postcardSize ?? "4x6"
    const r = size === "6x9"
      ? await renderPostcardBothSides6x9({
          brokerageId:      args.brokerageId,
          copyCtx:          args.copyCtx,
          qrScanUrl:        args.qrScanUrl ?? null,
          agentName:        args.agentName ?? null,
          agentPhotoUrl:    null,
          propertyPhotoUrl: args.propertyPhotoUrl ?? null,
          statusBadge:      args.statusBadge ?? null,
          pullQuote:        args.pullQuote ?? null,
        })
      : await renderPostcardBothSides4x6({
          brokerageId:   args.brokerageId,
          copyCtx:       args.copyCtx,
          qrScanUrl:     args.qrScanUrl ?? null,
          agentName:     args.agentName ?? null,
          // Future: pull agent photo from agents.did_photo_url / users.avatar_url
          agentPhotoUrl: null,
        })
    if (r.ok && r.frontUrl && r.backUrl) {
      templateForLob     = r.frontUrl
      backTemplateForLob = r.backUrl
      rendered = true
    } else {
      fellBackReason = r.violations?.length
        ? `compliance: ${r.violations.slice(0, 2).join("; ")}`
        : (r.error ?? "postcard_render_failed")
    }
  } else if (args.pieceType === "letter") {
    const r = await renderLetterHtml({
      brokerageId: args.brokerageId,
      copyCtx:     args.copyCtx,
      recipientFirstName: args.recipientName.split(" ")[0] ?? args.recipientName,
      recipientLastName:  args.recipientName.split(" ").slice(1).join(" "),
      recipientStreet:    args.mailingAddress,
      recipientCityState: `${args.city}, ${args.state}`,
      recipientZip:       args.zip,
      agentName:          args.agentName ?? null,
      agentTitle:         args.agentTitle ?? null,
    })
    if (r.ok && r.html) {
      // Lob letters accept HTML directly via the `file` parameter.
      templateForLob = r.html
      rendered = true
    } else {
      fellBackReason = r.violations?.length
        ? `compliance: ${r.violations.slice(0, 2).join("; ")}`
        : (r.error ?? "letter_render_failed")
    }
  } else {
    // self_mailer not yet wired; fall through to static template.
    fellBackReason = "piece_type_not_orchestrated"
  }

  if (!templateForLob) {
    templateForLob = args.fallbackTemplateId
  }

  const dispatch = await dispatchDirectMail({
    brokerageId: args.brokerageId,
    userId:      args.userId,
    contactId:   args.contactId,
    leadId:      args.leadId,
    agentId:     args.agentId,
    recipientName:  args.recipientName,
    mailingAddress: args.mailingAddress,
    city:           args.city,
    state:          args.state,
    zip:            args.zip,
    templateId:     templateForLob,
    backTemplateId: backTemplateForLob,
    pieceType:      args.pieceType,
    // Lob accepts size strings like '4x6'/'6x9'/'6x11' on
    // postcards.create; passing this through lets the 6x9 path
    // actually order the larger card from Lob.
    size:           args.pieceType === "postcard" ? (args.postcardSize ?? "4x6") : undefined,
    systemSource:   args.systemSource ?? "orchestrated",
    metadata: {
      rendered,
      fell_back_reason: fellBackReason,
      postcard_size:    args.pieceType === "postcard" ? (args.postcardSize ?? "4x6") : undefined,
    },
  })

  return {
    success:        dispatch.success,
    providerKey:    dispatch.providerKey,
    messageId:      dispatch.messageId,
    rendered,
    fellBackReason,
    error:          dispatch.error,
  }
}
