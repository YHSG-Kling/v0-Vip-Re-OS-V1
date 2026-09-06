// ─── CDA E-SIGN (agent signs → compliance → broker signs, each via THEIR provider) ──
// Spec (owner): the AGENT signs the CDA via the e-sign provider configured in settings,
// then it goes to compliance; the approved CDA goes to the BROKER, who signs via THEIR
// configured e-sign provider. The system always uses whatever provider the user set up —
// no provider is special-cased or auto-fired. When no provider is configured (or the
// filled PDF isn't built yet), the in-app sign-off is the record.

export type CdaSignMode = "esign" | "in_app"
export type CdaSignerRole = "agent" | "broker"

export interface CdaSignModeResult {
  mode: CdaSignMode
  reason: string
}

/**
 * PURE decision: does this signer sign through their configured provider, or in-app?
 *   • no provider configured  → in_app (the in-app sign-off is the record)
 *   • provider but no filled PDF → in_app (can't e-sign a document that isn't built)
 *   • provider + filled PDF    → esign (dispatch via WHATEVER provider is configured)
 * Note: provider identity does NOT change the decision — no provider is privileged.
 */
export function resolveCdaSignMode(input: {
  providerConfigured: boolean
  hasFilledPdf: boolean
}): CdaSignModeResult {
  if (!input.providerConfigured) return { mode: "in_app", reason: "no_esign_provider_configured" }
  if (!input.hasFilledPdf) return { mode: "in_app", reason: "no_filled_cda_pdf_to_sign" }
  return { mode: "esign", reason: "configured_provider" }
}

// ─── Dispatch (I/O) — routes through the provider the brokerage configured ──────
export interface CdaEsignDispatchResult {
  mode: CdaSignMode
  provider: string | null
  reason: string
  loopId?: string | null
  dispatched: boolean
}

type Db = Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>

/**
 * Dispatch a signer's e-signature on the filled CDA through the brokerage's CONFIGURED
 * provider. Best-effort — never throws (the in-app sign-off is the authoritative state
 * gate; e-sign is the transport on top). Stages the envelope for the configured provider
 * (notifying the signer with the filled PDF) and, where an inline provider integration
 * exists, fires it. Returns what actually happened so the caller can record an honest ref.
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
    const { resolveTransactionFormsProvider } = await import("@/lib/kernel/forms")
    const providerResult = await resolveTransactionFormsProvider({ brokerage_id: args.brokerageId })
    const providerConfigured = !!providerResult.success && !!providerResult.data?.is_configured
    const providerName = providerResult.data?.provider_name && providerResult.data.provider_name !== "not_configured"
      ? providerResult.data.provider_name
      : null

    const decision = resolveCdaSignMode({ providerConfigured, hasFilledPdf: !!args.filledPdfUrl })
    if (decision.mode === "in_app" || !providerName) {
      return { ...decision, provider: providerName, dispatched: false }
    }

    // Resolve the signer's email (envelope recipient).
    const { data: signer } = await supabase
      .from("users")
      .select("email, first_name, last_name")
      .eq("id", args.signerUserId)
      .maybeSingle()
    const signerEmail = (signer as { email?: string | null } | null)?.email ?? null
    if (!signerEmail) {
      return { mode: "in_app", provider: providerName, reason: "signer_email_missing", dispatched: false }
    }
    const signerName =
      [(signer as any)?.first_name, (signer as any)?.last_name].filter(Boolean).join(" ").trim() || signerEmail
    const roleLabel = args.signerRole === "agent" ? "your" : "the broker's"

    // Always stage the envelope for the CONFIGURED provider — the signer is told their CDA
    // is ready to sign via that provider, with the filled PDF. This is provider-agnostic.
    await supabase.from("notifications").insert({
      user_id: args.signerUserId,
      brokerage_id: args.brokerageId,
      type: "cda_esign_ready",
      title: `Sign the CDA via ${providerName}`,
      body: `The filled CDA for ${args.propertyAddress ?? "this transaction"} is ready for ${roleLabel} signature in ${providerName}.`,
      entity_type: "transaction",
      entity_id: args.transactionId,
      priority: "high",
      channel: "in_app",
    }).then(() => {}, () => {})

    // Where an inline provider integration exists, fire it through the configured provider.
    // (Dotloop is the only inline-wired provider today — used ONLY when it IS the configured
    // provider, never auto-selected over the user's choice.)
    let loopId: string | null = null
    if (providerName === "dotloop") {
      try {
        const { DotloopProvider } = await import("@/lib/integrations/providers/dotloop-provider")
        const creds = providerResult.data?.access_token && providerResult.data?.account_id
          ? { apiKey: providerResult.data.access_token, profileId: providerResult.data.account_id }
          : undefined
        const dotloop = new DotloopProvider(creds)
        const tx = await dotloop.createTransaction({
          propertyAddress: args.propertyAddress ?? "Commission Disbursement Authorization",
          transactionType: "purchase",
          transactionId: args.transactionId,
        })
        if (tx.success && tx.externalTransactionId) {
          loopId = tx.externalTransactionId
          await dotloop.attachForms({
            externalTransactionId: tx.externalTransactionId,
            forms: [{ formName: `CDA — ${args.propertyAddress ?? "Transaction"}`, formUrl: args.filledPdfUrl ?? undefined }],
          })
          await dotloop.sendForSignature({
            externalTransactionId: tx.externalTransactionId,
            documentId: tx.externalTransactionId,
            signers: [{ email: signerEmail, name: signerName, role: args.signerRole }],
            message: "Please sign this Commission Disbursement Authorization to authorize the disbursement.",
          })
        }
      } catch { /* staging notification already sent; inline send is best-effort */ }
    }

    return { ...decision, provider: providerName, loopId, dispatched: true }
  } catch (e) {
    return { mode: "in_app", provider: null, reason: e instanceof Error ? e.message : "esign_dispatch_failed", dispatched: false }
  }
}
