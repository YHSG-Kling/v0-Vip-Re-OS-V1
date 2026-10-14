/**
 * scripts/canaries/cda-esign.ts — CDA E-SIGN canary (wave 141, lane 141J; wired by lane 141K):
 *   tenant-selected e-sign provider → signature flow
 * through lib/transactions/cda-esign.ts (resolveCdaSignMode — PURE: no provider → in-app record; provider not
 * CERTIFIED → in-app; provider but no filled PDF → in-app; provider + PDF → e-sign; dispatchCdaSignerEsign — the
 * tenant's e-sign CHOICE through the canonical resolver, certified by the capability matrix, sent through the ONE
 * dispatch core) and the ONE e-sign resolver (lib/integrations/resolve-esign-provider.ts resolveESignChoice: the
 * tenant's SELECTION, else the platform DEFAULT DocuSign — a refusal is a refusal, never a silent other vendor).
 * Owner (wave 141): "CDA uses the tenant's selected e-sign provider through the canonical e-sign adapter — never
 * hardwired to Dotloop."
 *
 * AUDITED AT 01a71c3c2: dispatchCdaSignerEsign read the TRANSACTION-FORMS vendor and fired an inline Dotloop
 * branch. LANDED AT 81fcd1f14 (lane 141C): resolveESignChoice → esignCertified → dispatchEsignPacket. The dispatch
 * core's egress is REPLACED by a recorder (scripts/canaries/_esign-dispatch-stub.ts, installed through
 * _harness.ts stubModule BEFORE lib/transactions/cda-esign.ts loads) so the envelope is asserted, never sent.
 */
import { pathToFileURL } from "node:url"
import { join } from "node:path"
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, nowIso, setSvc, stubModule, uuid } from "./_harness"
import { ROOT, hooksFor, strippedRepo } from "./_registry"

export async function run() {
  const c = canary("CDA: tenant-selected e-sign → signature flow (never hardwired to Dotloop)")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: a dispatch stages a signer notification — in-memory only")
  // THE RECORDER, before the CDA graph is first imported (a stub installed later misses loaded modules).
  stubModule("@/lib/esign/dispatch-packet", pathToFileURL(join(ROOT, "scripts/canaries/_esign-dispatch-stub.ts")).href)
  const { esignDispatchRecorder } = await import("./_esign-dispatch-stub")
  const rec = esignDispatchRecorder()
  rec.calls.length = 0
  const B = uuid(), B2 = uuid(), B3 = uuid(), U = uuid(), U2 = uuid(), U3 = uuid(), T = uuid()
  const svc = canaryClient({
    brokerages: [
      { id: B, name: `${CANARY_TAG} Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-cda` },
      { id: B2, name: `${CANARY_TAG} Other`, plan_tier: "team", slug: `${CANARY_TAG}-cda2` },
      { id: B3, name: `${CANARY_TAG} Third`, plan_tier: "team", slug: `${CANARY_TAG}-cda3` },
    ],
    users: [
      { id: U, email: `agent@${CANARY_EMAIL_DOMAIN}`, first_name: "Canary", last_name: "Agent", user_type: "agent", brokerage_id: B },
      { id: U2, email: `agent2@${CANARY_EMAIL_DOMAIN}`, first_name: "Canary", last_name: "Two", user_type: "agent", brokerage_id: B2 },
      { id: U3, email: `agent3@${CANARY_EMAIL_DOMAIN}`, first_name: "Canary", last_name: "Three", user_type: "agent", brokerage_id: B3 },
    ],
    platform_credentials: [
      // Tenant 1: TRANSACTION-FORMS vendor SkySlope (the vendor the old code would have picked) AND the tenant's OWN
      // DocuSign connection; no explicit e-sign selection → the DocuSign DEFAULT resolves to the tenant's own credential.
      { id: uuid(), brokerage_id: B, owner_type: "brokerage", owner_id: B, platform: "skyslope", account_id: "ss-acct", access_token: "canary-token", is_active: true, created_at: nowIso() },
      { id: uuid(), brokerage_id: B, owner_type: "brokerage", owner_id: B, platform: "docusign", account_id: "acct-canary", api_key: "canary-docusign-token", config: { base_uri: "https://demo.docusign.net" }, is_active: true, created_at: nowIso() },
      // Tenant 2: e-sign SELECTION Dotloop with its own connection — a transaction platform whose e-sign path is PARTIAL.
      { id: uuid(), brokerage_id: B2, owner_type: "brokerage", owner_id: B2, platform: "dotloop", account_id: "profile-canary", api_key: "canary-dotloop-token", is_active: true, created_at: nowIso() },
    ],
    provider_overrides: [{ id: uuid(), provider_type: "esign", scope_type: "brokerage", scope_id: B2, provider_key: "dotloop", enabled: true }],
    // Tenant 3: no selection, nothing connected.
  })
  setSvc(svc)
  const { resolveCdaSignMode, dispatchCdaSignerEsign } = await import("../../lib/transactions/cda-esign")
  c.step("decision (pure): no provider → in-app sign-off is the record; provider but no filled PDF → in-app; provider + PDF → e-sign; a provider whose e-sign path is NOT certified → in-app (never a pretend send)", resolveCdaSignMode({ providerConfigured: false, hasFilledPdf: true }).mode === "in_app" && resolveCdaSignMode({ providerConfigured: true, hasFilledPdf: false }).mode === "in_app" && resolveCdaSignMode({ providerConfigured: true, hasFilledPdf: true }).mode === "esign" && resolveCdaSignMode({ providerConfigured: true, providerCertified: false, hasFilledPdf: true }).reason === "esign_provider_not_certified", "")
  const { resolveESignChoice } = await import("../../lib/integrations/resolve-esign-provider")
  const choice1 = await resolveESignChoice({ brokerageId: B, userId: U })
  c.step("selection: tenant 1 selected nothing → the DEFAULT (DocuSign) resolves to the TENANT's own DocuSign connection (brokerage scope, isDefault) — never the SkySlope transaction vendor", choice1.ok && choice1.kind === "api" && choice1.providerName === "docusign" && choice1.resolved.resolvedScope === "brokerage" && choice1.resolved.isDefault === true, JSON.stringify({ ok: choice1.ok, provider: choice1.ok ? choice1.providerName : choice1.error }).slice(0, 200))
  const choice2 = await resolveESignChoice({ brokerageId: B2, userId: U2 })
  c.step("selection: tenant 2 selected Dotloop → Dotloop is resolved with ITS OWN credential — never DocuSign substituted", choice2.ok && choice2.providerName === "dotloop", JSON.stringify({ ok: choice2.ok, provider: choice2.ok ? choice2.providerName : choice2.error }).slice(0, 200))
  const choice3 = await resolveESignChoice({ brokerageId: B3, userId: U3 })
  // The refusal NAMES the account it resolved (the platform DocuSign account) and never says the tenant is
  // "set to" another vendor; the sentence that follows lists what the tenant may connect, by design.
  c.step("selection: tenant 3 selected nothing and connected nothing → the DocuSign default is REFUSED by name (the platform account is not configured here) — never 'set to' another vendor", !choice3.ok && /DocuSign account/i.test(choice3.error) && !/set to/i.test(choice3.error), choice3.ok ? "resolved" : choice3.error.slice(0, 200))
  const d1 = await dispatchCdaSignerEsign(svc as never, { brokerageId: B, signerUserId: U, signerRole: "agent", transactionId: T, filledPdfUrl: "https://files.example/cda.pdf", propertyAddress: "1 Canary Way" })
  const sent = rec.calls[0]
  const note = (svc.tables.notifications ?? []).find((n) => n.brokerage_id === B && n.type === "cda_esign_ready")
  // WAVE141 HOOK (integrator): 141C — CDA follows the E-SIGN selection; wired 141K.
  for (const h of hooksFor("cda-esign")) {
    const at = h.probe()
    if (!at) { c.hook(h.lane, h.contract, "dispatchCdaSignerEsign reads resolveTransactionFormsProvider at HEAD"); continue }
    c.step(`${h.lane} landed (${at}): tenant 1's CDA goes to the e-sign CHOICE (DocuSign, certified) through the ONE dispatch core — exactly one dispatchEsignPacket call (recorded, never sent) carrying the signer, the filled CDA and the transaction; the result is an honest ref (envelopeId, status sent, dispatched) and the signer's bell names DocuSign; SkySlope is never consulted`, d1.mode === "esign" && d1.dispatched === true && d1.provider === "docusign" && d1.envelopeId === "env_canary_1" && d1.status === "sent" && rec.calls.length === 1 && sent?.brokerageId === B && sent?.userId === U && sent?.signers[0]?.email === `agent@${CANARY_EMAIL_DOMAIN}` && sent?.signers[0]?.role === "agent" && sent?.recordId === T && /CDA/.test(String(sent?.documents[0]?.name)) && sent?.documents[0]?.url === "https://files.example/cda.pdf" && !!note && note.user_id === U && /DocuSign/.test(String(note.title)) && !/skyslope/i.test(JSON.stringify(d1) + String(note.title) + String(note.body)), JSON.stringify(d1).slice(0, 200))
    const d2 = await dispatchCdaSignerEsign(svc as never, { brokerageId: B2, signerUserId: U2, signerRole: "agent", transactionId: T, filledPdfUrl: "https://files.example/cda.pdf", propertyAddress: "2 Canary Way" })
    c.step("141C CERTIFIED only: tenant 2's selection (Dotloop — a transaction platform whose e-sign path the matrix reads PARTIAL) is honoured as the choice and REFUSED as a sender — in-app sign-off stays the record, nothing dispatched, no bell, no inline Dotloop send", d2.mode === "in_app" && d2.provider === "dotloop" && d2.reason === "esign_provider_not_certified" && d2.dispatched === false && rec.calls.length === 1 && !(svc.tables.notifications ?? []).some((n) => n.brokerage_id === B2), JSON.stringify(d2))
    const d4 = await dispatchCdaSignerEsign(svc as never, { brokerageId: B3, signerUserId: U3, signerRole: "agent", transactionId: T, filledPdfUrl: "https://files.example/cda.pdf", propertyAddress: "3 Canary Way" })
    c.step("141C a refusal is a refusal: tenant 3 (no selection, nothing connected) answers in-app naming the DocuSign default — never a silent other vendor, nothing dispatched", d4.mode === "in_app" && d4.provider === null && /^no_esign_provider_configured/.test(d4.reason) && /DocuSign/.test(d4.reason) && d4.dispatched === false && rec.calls.length === 1, JSON.stringify(d4).slice(0, 200))
    const src = strippedRepo("lib/transactions/cda-esign.ts") ?? ""
    c.step("141C source rule: the CDA dispatch reads resolveESignChoice + esignCertified and sends through dispatchEsignPacket; it never reads the transaction-forms vendor, never loads its credential, never names a Dotloop branch or loopId", /resolveESignChoice\(/.test(src) && /esignCertified\(/.test(src) && /dispatchEsignPacket\(/.test(src) && !/resolveTransactionFormsProvider|loadTransactionFormsCredential|DotloopProvider|providerName\s*===\s*["']dotloop["']|\bloopId\b/.test(src), "")
    c.step("141C the record is honest: app/actions/cda-portal.ts writes envelope_id / status / handoff_url from the dispatch result (every provider's vocabulary, not Dotloop's)", /envelope_id/.test(strippedRepo("app/actions/cda-portal.ts") ?? "") && /handoff_url/.test(strippedRepo("app/actions/cda-portal.ts") ?? ""), "")
  }
  const d3 = await dispatchCdaSignerEsign(svc as never, { brokerageId: B, signerUserId: U, signerRole: "broker", transactionId: T, filledPdfUrl: null, propertyAddress: "1 Canary Way" })
  c.step("POSITIVE CONTROL: no filled PDF → in-app record, nothing dispatched (the recorder count is unchanged), no notification staged for it", d3.mode === "in_app" && d3.reason === "no_filled_cda_pdf_to_sign" && d3.dispatched === false && rec.calls.length === 1 && (svc.tables.notifications ?? []).filter((n) => n.brokerage_id === B).length === 1, JSON.stringify(d3))
  c.blind("No envelope reaches a provider: the ONE dispatch core's egress is a recorder (scripts/canaries/_esign-dispatch-stub.ts); the DocuSign / Dotloop / SkySlope wire is test:cda-esign, test:form-wizard-esign and test:esign-execution-loop. Tenant credentials are plaintext fixtures read through the same decrypt path the live rows take.")
  const a = await cleanupCanary(svc, B), b = await cleanupCanary(svc, B2), b3 = await cleanupCanary(svc, B3)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", a.mismatches.length + b.mismatches.length + b3.mismatches.length === 0 && a.residual + b.residual + b3.residual === 0, [...a.cleanup, ...b.cleanup, ...b3.cleanup].map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report([...a.cleanup, ...b.cleanup, ...b3.cleanup], a.residual + b.residual + b3.residual)
}
