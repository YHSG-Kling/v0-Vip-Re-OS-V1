// ─── CDA E-SIGN (agent signs → compliance → broker signs, each via THEIR provider) ──
// Spec (owner): the AGENT signs the CDA via the e-sign provider configured in settings,
// then it goes to compliance; the approved CDA goes to the BROKER, who signs via THEIR
// configured e-sign provider. The system always uses whatever provider the user set up —
// no provider is special-cased or auto-fired. When no provider is configured (or the
// filled PDF isn't built yet), the in-app sign-off is the record.
//
// WAVE 141 (lane 141C; owner verbatim: "CDA uses the tenant's selected e-sign provider through
// the canonical e-sign adapter — never hardwired to Dotloop"; "TRANSACTION vs E-SIGN are
// DIFFERENT capabilities"). WHAT WAS WRONG HERE: the dispatch resolved the TRANSACTION-FORMS
// vendor (lib/kernel/forms.ts resolveTransactionFormsProvider — "the newest active TM credential")
// as if it were the e-sign choice, and then fired an inline `if (providerName === "dotloop")`
// branch that built a Dotloop loop by hand (createTransaction → attachForms → sendForSignature)
// — every other provider got a notification and nothing sent. Both are gone:
//   · WHICH provider = the tenant's E-SIGN SELECTION (user → team → brokerage, else the DocuSign
//     default incl. the platform account) — lib/integrations/resolve-esign-provider.ts
//     resolveESignChoice, the same answer the FormWizard, the listing agreement and the
//     per-document send get;
//   · CERTIFIED only — a selection whose e-sign path the capability matrix does not certify
//     (lib/integrations/providers/catalog.ts esignCertified: a transaction platform that merely
//     claims e-sign) is refused by name and the in-app sign-off stays the record;
//   · HOW it is sent = the ONE dispatch core lib/esign/dispatch-packet.ts dispatchEsignPacket
//     (createTransaction → attachForms → sendForSignature, verdict read; DocuSign's platform
//     account for the default; the Google Drive hand-off for Google eSignature).
// TOMBSTONE: the inline DotloopProvider branch (and its loadTransactionFormsCredential egress)
// is DELETED onto dispatchEsignPacket; the result field `loopId` (Dotloop vocabulary) is now
// `envelopeId` (every provider's envelope / loop / signing / Drive-file id).

export type CdaSignMode = "esign" | "in_app"
export type CdaSignerRole = "agent" | "broker"

export interface CdaSignModeResult {
  mode: CdaSignMode
  reason: string
}

/**
 * PURE decision: does this signer sign through their configured provider, or in-app?
 *   • no provider configured  → in_app (the in-app sign-off is the record)
 *   • provider not CERTIFIED  → in_app (its e-sign path is not proven — never a pretend send)
 *   • provider but no filled PDF → in_app (can't e-sign a document that isn't built)
 *   • provider + filled PDF    → esign (dispatch via WHATEVER provider is configured)
 * Note: provider identity does NOT change the decision — no provider is privileged.
 */
export function resolveCdaSignMode(input: {
  providerConfigured: boolean
  hasFilledPdf: boolean
  /** The capability matrix's e-sign verdict for the configured provider (default: certified). */
  providerCertified?: boolean
}): CdaSignModeResult {
  if (!input.providerConfigured) return { mode: "in_app", reason: "no_esign_provider_configured" }
  if (input.providerCertified === false) return { mode: "in_app", reason: "esign_provider_not_certified" }
  if (!input.hasFilledPdf) return { mode: "in_app", reason: "no_filled_cda_pdf_to_sign" }
  return { mode: "esign", reason: "configured_provider" }
}

// ─── Dispatch (I/O) — routes through the provider the brokerage configured ──────
export interface CdaEsignDispatchResult {
  mode: CdaSignMode
  provider: string | null
  reason: string
  /** The provider's envelope / loop / signing id (or the Drive file id for Google eSignature). */
  envelopeId?: string | null
  /** "sent" = the provider emailed the signer; "awaiting_agent_send" = the signer sends from the hand-off window. */
  status?: "sent" | "awaiting_agent_send" | null
  /** The hand-off window (DocuSign sender view / Google Drive) when the send is finished there. */
  handoffUrl?: string | null
  dispatched: boolean
}

type Db = Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>

/**
 * Dispatch a signer's e-signature on the filled CDA through the brokerage's CONFIGURED
 * e-sign provider. Best-effort — never throws (the in-app sign-off is the authoritative state
 * gate; e-sign is the transport on top). Notifies the signer with the honest status and
 * returns what actually happened so the caller can record an honest ref.
 */
export async function dispatchCdaSignerEsign(
  supabase: Db,
  args: {
    brokerageId: string
    signerUserId: string
    signerRole: CdaSignerRole
    transactionId: string
    filledPdfUrl: string | null
    propertyAddress: string | null
  },
): Promise<CdaEsignDispatchResult> {
  try {
    // The signer (envelope recipient) and the team tier the selection cascade reads.
    const { data: signer, error: signerErr } = await supabase
      .from("users")
      .select("email, first_name, last_name, team_id")
      .eq("id", args.signerUserId)
      .eq("brokerage_id", args.brokerageId)
      .maybeSingle()
    if (signerErr) return { mode: "in_app", provider: null, reason: `signer_read_refused: ${signerErr.message}`, dispatched: false }
    const signerEmail = (signer as { email?: string | null } | null)?.email ?? null
    const signerTeamId = ((signer as { team_id?: string | null } | null)?.team_id as string | null) ?? null

    // WHICH provider: the tenant's e-sign SELECTION (user → team → brokerage), else the default.
    const { resolveESignChoice } = await import("@/lib/integrations/resolve-esign-provider")
    const choice = await resolveESignChoice({ brokerageId: args.brokerageId, userId: args.signerUserId, teamId: signerTeamId })
    if (!choice.ok) {
      return { ...resolveCdaSignMode({ providerConfigured: false, hasFilledPdf: !!args.filledPdfUrl }), provider: null, dispatched: false, reason: `no_esign_provider_configured: ${choice.error}` }
    }
    const providerName = choice.providerName
    const { esignCertified, getCatalogEntry } = await import("@/lib/integrations/providers/catalog")
    const certified = esignCertified(providerName)
    const decision = resolveCdaSignMode({ providerConfigured: true, providerCertified: certified, hasFilledPdf: !!args.filledPdfUrl })
    if (decision.mode === "in_app") {
      return { ...decision, provider: providerName, dispatched: false }
    }
    if (!signerEmail) {
      return { mode: "in_app", provider: providerName, reason: "signer_email_missing", dispatched: false }
    }
    const signerName =
      [(signer as any)?.first_name, (signer as any)?.last_name].filter(Boolean).join(" ").trim() || signerEmail
    const label = getCatalogEntry(providerName)?.label ?? providerName
    const docName = `CDA — ${args.propertyAddress ?? "Commission Disbursement Authorization"}`

    // HOW: the ONE dispatch core — the same path every other e-sign send takes.
    const { dispatchEsignPacket } = await import("@/lib/esign/dispatch-packet")
    const sent = await dispatchEsignPacket(supabase as any, {
      brokerageId: args.brokerageId,
      userId: args.signerUserId,
      teamId: signerTeamId,
      transactionType: "purchase",
      propertyAddress: args.propertyAddress ?? "Commission Disbursement Authorization",
      signers: [{ email: signerEmail, name: signerName, role: args.signerRole }],
      documents: [{ name: docName, url: args.filledPdfUrl as string }],
      recordId: args.transactionId,
      message: "Please sign this Commission Disbursement Authorization to authorize the disbursement.",
    })
    if (!sent.ok) {
      return { mode: "in_app", provider: providerName, reason: `esign_dispatch_refused: ${sent.error ?? "unknown"}`, dispatched: false }
    }

    // Tell the signer the HONEST status: emailed by the provider, or finished from the hand-off window.
    const roleLabel = args.signerRole === "agent" ? "your" : "the broker's"
    const handoffUrl = sent.handoff?.urls[0]?.url ?? null
    const body = sent.status === "awaiting_agent_send"
      ? `The filled CDA for ${args.propertyAddress ?? "this transaction"} is staged in ${label} for ${roleLabel} signature — finish the send from the ${label} window.${sent.handoff?.instructions ? ` ${sent.handoff.instructions}` : ""}`
      : `${label} has emailed the filled CDA for ${args.propertyAddress ?? "this transaction"} for ${roleLabel} signature.`
    const { error: notifyError } = await supabase.from("notifications").insert({
      user_id: args.signerUserId,
      brokerage_id: args.brokerageId,
      type: "cda_esign_ready",
      title: `Sign the CDA via ${label}`,
      body,
      entity_type: "transaction",
      entity_id: args.transactionId,
      priority: "high",
      channel: "in_app",
    })
    if (notifyError) console.warn("[cda-esign.ts] notifications insert refused — the bell will not ring:", notifyError.message)

    return { ...decision, provider: providerName, envelopeId: sent.envelopeId ?? null, status: sent.status ?? null, handoffUrl, dispatched: true }
  } catch (e) {
    return { mode: "in_app", provider: null, reason: e instanceof Error ? e.message : "esign_dispatch_failed", dispatched: false }
  }
}
