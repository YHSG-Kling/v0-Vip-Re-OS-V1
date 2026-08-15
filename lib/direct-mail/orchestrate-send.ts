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
import { pickVariantArm, recordVariantSend } from "@/lib/direct-mail/variant-bandit"
import type { Persona } from "@/lib/kernel/types"

export type PostcardSize = "4x6" | "6x9"

export interface OrchestrateSendArgs {
  brokerageId: string
  /** Wave 36 tier cascade. The team and agent context BOTH live in
   *  copyCtx (single source of truth — draft-copy + render-postcard
   *  + render-letter all read from there). teamId/agentUserId
   *  resolve the brand layers in resolveBrandContext. */
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
  /** Wave 36 bandit telemetry. The variant the Thompson sampler
   *  picked + whether the pick was exploration (cold arm) vs
   *  exploitation (hot arm). Null when the bandit was skipped
   *  (letter sends, no eligible arms). */
  variantPick?: {
    variantId:    string
    compositionId: string
    copyStyle:    string
    sampledProb:  number
    isExploration: boolean
  } | null
  /** Wave 36 m156 — id of the compliance_events row the gate emitted.
   *  Caller stamps it on direct_mail_campaigns for per-piece audit. */
  complianceEventId?: string | null
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
  let variantPick: OrchestrateSendResult["variantPick"] = null
  let complianceEventId: string | null = null

  // Wave 36 bandit pick (postcard sends only — letters use a fixed
  // letterhead). systemSource maps to bandit use_kind; "lifecycle:*"
  // collapses to use_kind="lifecycle" so all 7 lifecycle events share
  // the same arm pool (we test creative across the lifecycle as one
  // cohort; the policy controls audience scope per event).
  function inferUseKind(): "farm_mail" | "welcome_kit" | "sphere_outreach" | "lifecycle" | "pre_listing_kit" | null {
    const src = args.systemSource ?? ""
    if (src === "ai_isa")            return "welcome_kit"
    if (src === "farm_mail")         return "farm_mail"
    if (src === "pre_listing_kit")   return "pre_listing_kit"
    if (src.startsWith("lifecycle:")) return "lifecycle"
    if (src === "sphere_outreach")   return "sphere_outreach"
    return null
  }

  if (args.pieceType === "postcard") {
    const size: PostcardSize = args.postcardSize ?? "4x6"
    // Bandit pick happens BEFORE render so the picked composition_id
    // could (future) route to different Remotion comps. For now the
    // copy_style is a context hint passed through copyCtx; the chosen
    // composition is whatever the size resolved to.
    const useKind = inferUseKind()
    if (useKind && args.copyCtx.persona) {
      const pick = await pickVariantArm({
        brokerageId: args.brokerageId,
        persona:     args.copyCtx.persona as Persona,
        useKind,
        size,
      })
      if (pick) {
        variantPick = {
          variantId:     pick.variantId,
          compositionId: pick.compositionId,
          copyStyle:     pick.copyStyle,
          sampledProb:   pick.sampledProb,
          isExploration: pick.isExploration,
        }
        // Wave 36 — stamp the bandit's copy_style into copyCtx so
        // draftPostcardCopy / draftLetterCopy actually swap in the
        // arm's prompt overlay. Without this the bandit rotated
        // labels but not the writing; with this each arm produces
        // structurally different creative.
        args.copyCtx.copyStyle = pick.copyStyle
      }
    }
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
    // Wave 36 m156 — surface the compliance event id from the gate run.
    if (r.complianceEventId) complianceEventId = r.complianceEventId
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
    if (r.complianceEventId) complianceEventId = r.complianceEventId
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
      variant_id:       variantPick?.variantId ?? null,
      copy_style:       variantPick?.copyStyle ?? null,
    },
  })

  // Wave 36 — bandit feedback. Record the send on the variant's
  // outcomes row so the next pick for this cohort sees it. Cost
  // approximation by size: 4x6 ≈ $0.78, 6x9 ≈ $1.10; in cents for the
  // bigint column.
  if (variantPick && dispatch.success) {
    const costCents = args.pieceType === "postcard"
      ? (args.postcardSize === "6x9" ? 110 : 78)
      : 120  // letter
    await recordVariantSend({
      variantId:   variantPick.variantId,
      brokerageId: args.brokerageId,
      costCents,
    }).catch((e) => console.error("[orchestrator] recordVariantSend failed:", e))
  }

  return {
    success:        dispatch.success,
    providerKey:    dispatch.providerKey,
    messageId:      dispatch.messageId,
    rendered,
    fellBackReason,
    variantPick,
    complianceEventId,
    error:          dispatch.error,
  }
}
