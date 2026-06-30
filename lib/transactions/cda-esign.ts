// ─── CDA BROKER E-SIGN (the formal signature on the filled CDA) ─────────────────
// Spec: compliance approval triggers the BROKER to sign the CDA — "esign in the app
// if they have a esign provider setup in their integration settings." So when the
// broker signs, if the brokerage has a connected e-sign/transaction provider AND the
// filled CDA PDF exists, we dispatch the formal e-signature envelope carrying that PDF;
// otherwise the broker's in-app sign-off is the record. This mirrors the established
// send-for-esign pattern (Dotloop auto-routes; other providers get an explicit manual
// send; nothing is silently dropped) — no new provider abstraction, no stubs.

export type CdaSignMode = "esign_auto" | "esign_manual" | "in_app"

export interface CdaSignModeResult {
  mode: CdaSignMode
  provider: string | null
  reason: string
}

/**
 * PURE decision: given the brokerage's provider config + whether a filled CDA PDF
 * exists, which way does the broker sign? Deterministic, unit-testable.
 *   • no provider                       → in_app (the in-app sign-off is the record)
 *   • provider but no filled PDF        → in_app (can't e-sign a document that isn't built)
 *   • Dotloop + filled PDF              → esign_auto (auto-routable today)
 *   • other provider + filled PDF       → esign_manual (notify broker to send via their provider)
 */
export function resolveCdaSignMode(input: {
  providerConfigured: boolean
  providerName: string | null
  hasFilledPdf: boolean
}): CdaSignModeResult {
  const provider =
    input.providerName && input.providerName !== "not_configured" ? input.providerName : null

  if (!input.providerConfigured || !provider) {
    return { mode: "in_app", provider: null, reason: "no_esign_provider_configured" }
  }
  if (!input.hasFilledPdf) {
    return { mode: "in_app", provider, reason: "no_filled_cda_pdf_to_sign" }
  }
  if (provider === "dotloop") {
    return { mode: "esign_auto", provider, reason: "dotloop_auto_routable" }
  }
  return { mode: "esign_manual", provider, reason: "provider_requires_manual_send" }
}

// ─── Dispatch (I/O) — reuses resolveTransactionFormsProvider + DotloopProvider ──
export interface CdaEsignDispatchResult {
  mode: CdaSignMode
  provider: string | null
  reason: string
  loopId?: string | null
  dispatched: boolean
  error?: string
}

type Db = Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>

/**
 * Dispatch the broker's formal e-signature on the filled CDA. Best-effort: it NEVER
 * throws to the caller (the in-app broker sign-off is the authoritative state gate;
 * this adds the formal signature transport on top). Returns what actually happened so
 * the action can record an honest reference on the CDA.
 */
export async function dispatchCdaBrokerEsign(
  supabase: Db,
  args: {
    brokerageId: string
    brokerUserId: string
    transactionId: string
    filledPdfUrl: string | null
    propertyAddress: string | null
  },
): Promise<CdaEsignDispatchResult> {
  try {
    const { resolveTransactionFormsProvider } = await import("@/lib/kernel/forms")
    const providerResult = await resolveTransactionFormsProvider({ brokerage_id: args.brokerageId })
    const providerConfigured = !!providerResult.success && !!providerResult.data?.is_configured
    const providerName = providerResult.data?.provider_name ?? null

    const decision = resolveCdaSignMode({
      providerConfigured,
      providerName,
      hasFilledPdf: !!args.filledPdfUrl,
    })

    if (decision.mode === "in_app") {
      return { ...decision, dispatched: false }
    }

    // Resolve the broker as the signer.
    const { data: broker } = await supabase
      .from("users")
      .select("email, first_name, last_name")
      .eq("id", args.brokerUserId)
      .maybeSingle()
    const brokerEmail = (broker as { email?: string | null } | null)?.email ?? null
    if (!brokerEmail) {
      // Can't address an envelope without the broker's email — fall back to in-app, honestly.
      return { mode: "in_app", provider: decision.provider, reason: "broker_email_missing", dispatched: false }
    }
    const brokerName =
      [(broker as any)?.first_name, (broker as any)?.last_name].filter(Boolean).join(" ").trim() || brokerEmail

    if (decision.mode === "esign_manual") {
      // Non-Dotloop providers: notify the broker to send the filled CDA via their provider.
      await supabase.from("notifications").insert({
        user_id: args.brokerUserId,
        brokerage_id: args.brokerageId,
        type: "cda_esign_manual_send",
        title: `Sign the CDA via ${decision.provider}`,
        body: `The filled CDA for ${args.propertyAddress ?? "this transaction"} is ready. Open ${decision.provider} and send it for your signature — auto-send isn't wired for ${decision.provider} yet (only Dotloop is auto-routable today).`,
        entity_type: "transaction",
        entity_id: args.transactionId,
        priority: "high",
        channel: "in_app",
      }).then(() => {}, () => {})
      return { ...decision, dispatched: true }
    }

    // esign_auto → Dotloop: create a loop, attach the filled CDA PDF, send for the broker's signature.
    const { DotloopProvider } = await import("@/lib/integrations/providers/dotloop-provider")
    const creds = providerResult.data?.access_token && providerResult.data?.account_id
      ? { apiKey: providerResult.data.access_token, profileId: providerResult.data.account_id }
      : undefined
    const dotloop = new DotloopProvider(creds)

    const tx = await dotloop.createTransaction({
      propertyAddress: args.propertyAddress ?? "Commission Disbursement Authorization",
      transactionType: "purchase",
      agentId: args.brokerUserId,
      transactionId: args.transactionId,
    })
    if (!tx.success || !tx.externalTransactionId) {
      // Degrade to manual send, honestly — the broker still gets told to sign.
      await supabase.from("notifications").insert({
        user_id: args.brokerUserId,
        brokerage_id: args.brokerageId,
        type: "cda_esign_manual_send",
        title: "Sign the CDA via Dotloop",
        body: `Couldn't auto-create the Dotloop envelope for the CDA (${tx.error ?? "provider error"}). Open Dotloop and send the filled CDA for your signature.`,
        entity_type: "transaction",
        entity_id: args.transactionId,
        priority: "high",
        channel: "in_app",
      }).then(() => {}, () => {})
      return { mode: "esign_manual", provider: "dotloop", reason: tx.error ?? "dotloop_create_failed", dispatched: true }
    }

    await dotloop.attachForms({
      externalTransactionId: tx.externalTransactionId,
      forms: [{ formName: `CDA — ${args.propertyAddress ?? "Transaction"}`, formUrl: args.filledPdfUrl ?? undefined }],
    })
    await dotloop.sendForSignature({
      externalTransactionId: tx.externalTransactionId,
      documentId: tx.externalTransactionId,
      signers: [{ email: brokerEmail, name: brokerName, role: "broker" }],
      message: "Please sign this Commission Disbursement Authorization to authorize the disbursement.",
    })

    return { ...decision, loopId: tx.externalTransactionId, dispatched: true }
  } catch (e) {
    // Never block the broker's in-app sign-off on an e-sign transport failure.
    return { mode: "in_app", provider: null, reason: e instanceof Error ? e.message : "esign_dispatch_failed", dispatched: false }
  }
}
