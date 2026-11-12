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
import { pickVariantArm, recordVariantSend, type BanditPickReason } from "@/lib/direct-mail/variant-bandit"
import { experimentLedgerDetail } from "@/lib/kernel/experiments"
import type { Persona } from "@/lib/kernel/types"
import type { MailFormat } from "@/lib/direct-mail/piece-type"
import { readSenderVoiceBrief, type SenderVoiceBrief } from "@/lib/direct-mail/draft-copy"

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
  /** Optional CAMPAIGN-level QR scan URL (already minted by caller, a
   *  qr_codes slug shared by every recipient of the campaign) printed in the
   *  layout's OPTIONAL QR region — the postcard FRONT and, since wave 152
   *  (lane 152C), the letter and the personal note too. Absent or unusable →
   *  the region stays blank and the piece still mails (decideMailQrRegion). */
  qrScanUrl?: string | null
  /**
   * THIS RECIPIENT's `direct_mail_recipients.unsubscribe_token` — the
   * credential printed on the piece so the person holding it can stop the
   * mail. PER-RECIPIENT; the campaign QR above is not.
   *
   * The caller that inserts the recipient row is the caller that has this
   * (campaign-drain selects it back off the insert). Absent, the postcard back
   * prints no opt-out row and the content contract's REQUIRED `optOutLine` is
   * unsatisfied — a fact, surfaced, rather than a card with no way to say stop.
   */
  unsubscribeToken?: string | null
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
  /** Wave 150 (150R): the at-most-once key for THIS piece (piece-type.ts mailPieceIdempotencyKey). The
   *  action ledger refuses a second claim, so a re-fired caller cannot charge for the same piece twice. */
  idempotencyKey?:  string
  /** Wave 151 (151H): the campaign row's PRINT format. `personal_letter` renders the letter in the handwriting-style
   *  printed typeface on the global personal-note layout (pieceType stays "letter"). Default: derived from pieceType. */
  format?: MailFormat
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
    /** R4 — why this arm (thompson_sample | frozen_exploit | frozen_all_cold_catalog_default). */
    pickReason:   BanditPickReason
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

  // ── WAVE 151 (lane 151H): THE SENDER'S RETURN ADDRESS, BEFORE ANY RENDER ──
  // TOMBSTONE: the tenant's `from` was set only on the static-template branch below, so every RENDERED piece — the normal
  // path for the drain, the lifecycle reactor and farm mail — reached the dispatcher with no sender and mailed under the
  // platform's saved address. The ONE resolver (piece-type.ts resolveTenantSenderAddress) runs first; the ONE gate
  // (mailing-cass-gate.ts decideSenderAddress) refuses by name BEFORE a Remotion render or a model call is paid for.
  const { resolveTenantSenderAddress } = await import("@/lib/direct-mail/piece-type")
  const { decideSenderAddress } = await import("@/lib/providers/mailing-cass-gate")
  const senderRead = await resolveTenantSenderAddress({ brokerageId: args.brokerageId, teamId: args.copyCtx.teamId ?? null, agentUserId: args.copyCtx.agentUserId ?? args.userId ?? null })
  const senderGate = decideSenderAddress(senderRead.address, { platformLobAddressId: process.env.LOB_RETURN_ADDRESS_ID })
  if (!senderGate.ok) {
    return { success: false, rendered: false, fellBackReason: null, variantPick, complianceEventId, error: `Not mailed — sender address refused (${senderGate.code}): ${senderGate.reason}${senderRead.refusal ? ` — ${senderRead.refusal}` : ""}` }
  }
  const senderAddress = senderRead.address
  const format: MailFormat = args.format ?? (args.pieceType === "postcard" ? "postcard" : "letter")

  // ── WAVE 151 (lane 151H — 151I's plug point): the SENDER'S VOICE conditions the FIRST draft. The brief is read once here
  // (draft-copy.ts readSenderVoiceBrief — today from brand_voice_profile + the brand cascade; lane 151I's reader replaces its
  // body) and rides copyCtx so both renderers' drafts are written in the sender's voice from the start, never "generate
  // generic then let the human rewrite".
  const senderVoice: SenderVoiceBrief = args.copyCtx.senderVoice ?? (await readSenderVoiceBrief(args.copyCtx))
  args.copyCtx.senderVoice = senderVoice
  args.copyCtx.format = format

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
          pickReason:    pick.pickReason,
        }
        // Wave 36 — stamp the bandit's copy_style into copyCtx so
        // draftPostcardCopy / draftLetterCopy actually swap in the
        // arm's prompt overlay. Without this the bandit rotated
        // labels but not the writing; with this each arm produces
        // structurally different creative.
        args.copyCtx.copyStyle = pick.copyStyle
      }
    }
    // KNOWN GAP, SAID OUT LOUD RATHER THAN DROPPED. remotion/PostcardBack6x9
    // does not yet take the opt-out props, so a 6x9 piece mails with no printed
    // way to say stop even when we hold this recipient's token. That is the same
    // defect the 4x6 just closed, one composition over, and it is left visible
    // here instead of silently discarding the token: the fix is to add
    // optOutLine/optOutQrDataUrl to PostcardBack6x9 + its Root defaults + its
    // content contract, then spread `mailOptOutProps(...)` into the 6x9
    // backInput exactly as renderPostcardBothSides4x6 now does.
    if (size === "6x9" && args.unsubscribeToken) {
      console.error(
        "[orchestrator] 6x9 postcard is mailing WITHOUT a printed opt-out: " +
        "PostcardBack6x9 does not accept optOutLine/optOutQrDataUrl yet, so this " +
        "recipient's unsubscribe token cannot reach the piece.",
      )
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
          // The per-recipient opt-out. Passed as a TOKEN, not a URL, so it can
          // never be confused with the campaign-level qrScanUrl above.
          unsubscribeToken: args.unsubscribeToken ?? null,
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
      // Wave 151 (151H): the handwriting-style PRINTED note on the personal-note layout; the tenant's return address on the letterhead.
      noteStyle:          format === "personal_letter" ? "handwriting_style" : null,
      returnAddress:      senderAddress,
      // Wave 152 (152C): the campaign's registered code prints in the letter's / note's optional QR region.
      qrScanUrl:          args.qrScanUrl ?? null,
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

  // ── WAVE 150 (lane 150R, owner ruling R5): THE FALLBACK IS THE GLOBAL FORMAT TEMPLATE + BRAND DATA ──
  // TOMBSTONE: the fallback used to mail `args.fallbackTemplateId` (a per-tenant Lob template) as the
  // FRONT with no back and no merge variables, so the dispatcher's `LOB_POSTCARD_BACK_ID ?? front`
  // printed the front on both sides when no back was configured, and a global template printed blank.
  // fallbackLobTemplates (lib/direct-mail/piece-type.ts) names the GLOBAL format template(s) first,
  // reads the tenant id only as a measured legacy fallback, and REFUSES a postcard with no distinct back.
  // The tenant/user/office brand is resolved now and passed as merge_variables.
  let fallbackMergeVars: Record<string, string> | undefined
  let templateSource: string = rendered ? "rendered_piece" : "none"
  if (!templateForLob) {
    const { fallbackLobTemplates, readMailBrandFacts, buildMailMergeVariables } = await import("@/lib/direct-mail/piece-type")
    // The personal note falls back to the GLOBAL personal-note layout (151H), never the ordinary letter's.
    const fb = fallbackLobTemplates(format === "personal_letter" ? "personal_letter" : args.pieceType, args.fallbackTemplateId)
    if (!fb.ok) {
      return { success: false, rendered: false, fellBackReason: fellBackReason ?? fb.reason, variantPick, complianceEventId, error: `Not mailed — ${fb.reason}` }
    }
    templateForLob = fb.templateId
    backTemplateForLob = fb.backTemplateId
    templateSource = fb.source
    const brandRead = await readMailBrandFacts({
      brokerageId: args.brokerageId,
      teamId: args.copyCtx.teamId ?? null,
      agentUserId: args.copyCtx.agentUserId ?? args.userId ?? null,
    })
    const brand = buildMailMergeVariables(brandRead.facts, { recipientName: args.recipientName, qrDestinationUrl: args.qrScanUrl ?? null, pictureUrl: args.propertyPhotoUrl ?? null })
    if (brand.oversize) {
      return { success: false, rendered: false, fellBackReason, variantPick, complianceEventId, error: "Not mailed — merge variables exceed Lob's 25,000-character limit" }
    }
    fallbackMergeVars = brand.mergeVars
    // TOMBSTONE (151H): `fallbackFrom = brandRead.facts.returnAddress` lived here, so only this branch carried the tenant's
    // address. SURVIVOR: `senderAddress`, resolved above for EVERY path (lib/direct-mail/piece-type.ts resolveTenantSenderAddress).
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
    // The handwriting-style printed note prints in color (the typeface reads as ink); the ordinary letter keeps its default.
    ...(format === "personal_letter" ? { color: true } : {}),
    ...(fallbackMergeVars ? { mergeVars: fallbackMergeVars } : {}),
    // THE TENANT's sender address on EVERY path (rendered or fallback) — wave 151, 151H.
    fromAddress:    senderAddress,
    systemSource:   args.systemSource ?? "orchestrated",
    // Wave 101 (101B): the bandit's arm rides the send's ledger row as detail.experiment, so 100A
    // attribution rolls outcomes up by arm beside the A/B arms (lib/kernel/experiments.ts). The
    // Thompson sampler keeps choosing it — an adaptive allocator, not a fixed-weight split.
    // 102D/102F: the send ran under the tenant's `direct_mail_exploration` policy (the bandit kill
    // switch, lib/kernel/tenant-policy.ts) — named as policyKey so the ledger row reads
    // `direct_mail_exploration@<version>` (LAW 5), with the bandit's pick reason beside the arm (R4).
    // Wave 150 (150R): the caller's at-most-once key rides the SAME ledger object (a retried drain / reactor
    // firing replays the first dispatch instead of charging again).
    ...(variantPick
      ? { ledger: { detail: { ...experimentLedgerDetail({ key: "direct_mail_variant", arm: variantPick.variantId }), bandit_pick_reason: variantPick.pickReason }, policyKey: "direct_mail_exploration", ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}) } }
      : args.idempotencyKey ? { ledger: { idempotencyKey: args.idempotencyKey } } : {}),
    metadata: {
      template_source: templateSource,
      mail_format:      format,
      sender_address_source: senderAddress?.source ?? null,
      rendered,
      fell_back_reason: fellBackReason,
      postcard_size:    args.pieceType === "postcard" ? (args.postcardSize ?? "4x6") : undefined,
      variant_id:       variantPick?.variantId ?? null,
      copy_style:       variantPick?.copyStyle ?? null,
      bandit_pick_reason: variantPick?.pickReason ?? null,
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
