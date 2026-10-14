/**
 * scripts/canaries/cda-esign.ts — CDA E-SIGN canary (wave 141, lane 141J):
 *   tenant-selected e-sign provider → signature flow
 * through lib/transactions/cda-esign.ts (resolveCdaSignMode — PURE: no provider → in-app record; provider
 * but no filled PDF → in-app; provider + PDF → e-sign; dispatchCdaSignerEsign — stages the envelope for the
 * CONFIGURED provider, never auto-selects another) and the ONE e-sign resolver
 * (lib/integrations/resolve-esign-provider.ts resolveESignChoice: the tenant's SELECTION, else the platform
 * DEFAULT DocuSign — a refusal is a refusal, never a silent other vendor). Owner (wave 141): "CDA uses the
 * tenant's selected e-sign provider through the canonical e-sign adapter — never hardwired to Dotloop."
 *
 * AUDITED AT 01a71c3c2: dispatchCdaSignerEsign reads the TRANSACTION-FORMS vendor (resolveTransactionFormsProvider),
 * not the e-sign selection — the exact hardwiring lane 141C removes (WAVE141 HOOK). The canary proves the
 * provider-agnostic half at HEAD and the selection-vs-vendor gap with a tenant whose e-sign pick is Dotloop
 * but whose transaction vendor is none.
 */
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, nowIso, setSvc, uuid } from "./_harness"
import { hooksFor } from "./_registry"

export async function run() {
  const c = canary("CDA: tenant-selected e-sign → signature flow (never hardwired to Dotloop)")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: a dispatch stages a signer notification — in-memory only")
  const B = uuid(), B2 = uuid(), U = uuid(), U2 = uuid(), T = uuid()
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-cda` }, { id: B2, name: `${CANARY_TAG} Other`, plan_tier: "team", slug: `${CANARY_TAG}-cda2` }],
    users: [{ id: U, email: `agent@${CANARY_EMAIL_DOMAIN}`, first_name: "Canary", last_name: "Agent", user_type: "agent", brokerage_id: B }, { id: U2, email: `agent2@${CANARY_EMAIL_DOMAIN}`, first_name: "Canary", last_name: "Two", user_type: "agent", brokerage_id: B2 }],
    // Tenant 1: transaction-forms vendor SkySlope; no e-sign selection (→ platform default DocuSign).
    platform_credentials: [{ id: uuid(), brokerage_id: B, owner_type: "brokerage", owner_id: B, platform: "skyslope", account_id: "ss-acct", access_token: "canary-token", is_active: true, created_at: nowIso() }],
    // Tenant 2: e-sign SELECTION Dotloop, no transaction vendor at all.
    provider_overrides: [{ id: uuid(), provider_type: "esign", scope_type: "brokerage", scope_id: B2, provider_key: "dotloop", enabled: true }],
  })
  setSvc(svc)
  const { resolveCdaSignMode, dispatchCdaSignerEsign } = await import("../../lib/transactions/cda-esign")
  c.step("decision (pure): no provider → in-app sign-off is the record; provider but no filled PDF → in-app; provider + PDF → e-sign", resolveCdaSignMode({ providerConfigured: false, hasFilledPdf: true }).mode === "in_app" && resolveCdaSignMode({ providerConfigured: true, hasFilledPdf: false }).mode === "in_app" && resolveCdaSignMode({ providerConfigured: true, hasFilledPdf: true }).mode === "esign", "")
  const { resolveESignChoice } = await import("../../lib/integrations/resolve-esign-provider")
  const choice1 = await resolveESignChoice({ brokerageId: B, userId: U })
  // The refusal NAMES the account it resolved (the platform DocuSign account) and never says the tenant is
  // "set to" another vendor; the sentence that follows lists what the tenant may connect, by design.
  c.step("selection: tenant 1 selected nothing → the DEFAULT (DocuSign) is resolved, or refused naming the DocuSign account — never 'set to' Dotloop, never the transaction vendor", choice1.ok ? choice1.providerName === "docusign" : /DocuSign account/i.test(choice1.error) && !/set to/i.test(choice1.error), JSON.stringify(choice1).slice(0, 200))
  const choice2 = await resolveESignChoice({ brokerageId: B2, userId: U2 })
  c.step("selection: tenant 2 selected Dotloop → Dotloop is resolved, or refused naming the Dotloop selection (its credential is the tenant's own) — never DocuSign substituted", choice2.ok ? choice2.providerName === "dotloop" : /set to Dotloop/i.test(choice2.error) && !/DocuSign account/i.test(choice2.error), JSON.stringify(choice2).slice(0, 200))
  const d1 = await dispatchCdaSignerEsign(svc as never, { brokerageId: B, signerUserId: U, signerRole: "agent", transactionId: T, filledPdfUrl: "https://files.example/cda.pdf", propertyAddress: "1 Canary Way" })
  const note = (svc.tables.notifications ?? []).find((n) => n.brokerage_id === B && n.type === "cda_esign_ready")
  c.step("signature flow: the envelope is STAGED for the configured provider (signer notification names it, dispatched=true) and no Dotloop inline send fires for a non-Dotloop provider", d1.mode === "esign" && d1.dispatched === true && d1.loopId == null && !!note && note.user_id === U && /skyslope/i.test(String(note.title)), JSON.stringify(d1))
  const d2 = await dispatchCdaSignerEsign(svc as never, { brokerageId: B2, signerUserId: U2, signerRole: "agent", transactionId: T, filledPdfUrl: "https://files.example/cda.pdf", propertyAddress: "2 Canary Way" })
  // WAVE141 HOOK (integrator): 141C — CDA follows the E-SIGN selection.
  for (const h of hooksFor("cda-esign")) {
    const at = h.probe()
    if (!at) {
      c.step("HEAD gap measured (the contract lane 141C closes): tenant 2 SELECTED Dotloop for e-sign but has no transaction vendor → the CDA dispatch reads the transaction vendor and answers in-app (selection ignored)", d2.mode === "in_app" && d2.reason === "no_esign_provider_configured", JSON.stringify(d2))
      c.hook(h.lane, h.contract, "dispatchCdaSignerEsign reads resolveTransactionFormsProvider at HEAD")
      continue
    }
    c.step(`${h.lane} landed (${at}): the CDA dispatch for tenant 2 follows the e-sign SELECTION (Dotloop) — the provider named is the selection or a refusal naming it, never the transaction vendor`, /dotloop/i.test(JSON.stringify(d2)) || (d2.mode === "in_app" && /dotloop/i.test(String(d2.reason))), JSON.stringify(d2))
  }
  const d3 = await dispatchCdaSignerEsign(svc as never, { brokerageId: B, signerUserId: U, signerRole: "broker", transactionId: T, filledPdfUrl: null, propertyAddress: "1 Canary Way" })
  c.step("POSITIVE CONTROL: no filled PDF → in-app record, nothing dispatched, no notification staged for it", d3.mode === "in_app" && d3.dispatched === false && (svc.tables.notifications ?? []).filter((n) => n.brokerage_id === B).length === 1, JSON.stringify(d3))
  c.blind("No envelope reaches a provider: DocuSign/Dotloop/SkySlope credentials are absent in-memory, so the resolver's refusals are the asserted facts; the live send is test:cda-esign / test:form-wizard-esign.")
  const a = await cleanupCanary(svc, B), b = await cleanupCanary(svc, B2)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", a.mismatches.length + b.mismatches.length === 0 && a.residual + b.residual === 0, [...a.cleanup, ...b.cleanup].map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report([...a.cleanup, ...b.cleanup], a.residual + b.residual)
}
