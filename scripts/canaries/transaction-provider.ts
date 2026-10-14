/**
 * scripts/canaries/transaction-provider.ts — TRANSACTION PROVIDER canary (wave 141, lane 141J):
 *   tenant selects a provider → forms work
 * through lib/kernel/forms.ts (resolveTransactionFormsProvider — the tenant's TRANSACTION-FORMS vendor from
 * its OWN platform_credentials; loadTransactionFormsCredential — the egress half; loadAvailableTransactionForms
 * — the brokerage's forms, never empty) and the ONE provider catalog (lib/integrations/providers/catalog.ts:
 * implemented + capabilities esign / transactionForms / embed; DEFAULT_ESIGN_PROVIDER docusign). Owner
 * (wave 141): "TRANSACTION vs E-SIGN are DIFFERENT capabilities … Transaction-provider credentials are the
 * TENANT's; no shared cross-tenant credentials … every provider HEAD claims must actually function or it is
 * not offered." The typed capability MATRIX (lane 141C, lib/transactions/provider-capabilities.ts) is a
 * WAVE141 HOOK.
 */
import { CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, nowIso, setSvc, uuid } from "./_harness"
import { hooksFor } from "./_registry"

export async function run() {
  const c = canary("Transaction provider: tenant selects a provider → forms work (credentials tenant-owned; capability catalog honest)")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: provider credentials are tenant secrets — in-memory only")
  const B = uuid(), B2 = uuid()
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-tx` }, { id: B2, name: `${CANARY_TAG} Other`, plan_tier: "team", slug: `${CANARY_TAG}-tx2` }],
    // The tenant's OWN selection: SkySlope, connected (account_id set), a sealed token stored.
    platform_credentials: [{ id: uuid(), brokerage_id: B, owner_type: "brokerage", owner_id: B, platform: "skyslope", account_id: "ss-acct-canary", access_token: "canary-plaintext-token", is_active: true, created_at: nowIso() }],
    brokerage_forms: [
      { id: uuid(), brokerage_id: B, form_name: `${CANARY_TAG} Listing Agreement`, form_category: "listing_agreement", form_type: "listing", is_required: true, is_active: true, document_url: "https://files.example/la.pdf", state: "FL" },
      { id: uuid(), brokerage_id: B, form_name: `${CANARY_TAG} Seller Disclosure`, form_category: "disclosure", form_type: "listing", is_required: true, is_active: true, document_url: null, state: null },
    ],
  })
  setSvc(svc)
  const { resolveTransactionFormsProvider, loadTransactionFormsCredential, loadAvailableTransactionForms } = await import("../../lib/kernel/forms")
  const p = await resolveTransactionFormsProvider({ brokerage_id: B })
  c.step("select: the tenant's transaction-forms provider resolves from ITS OWN credential row (skyslope, configured, a sealed token stored)", p.success && p.data?.provider_name === "skyslope" && p.data.is_configured === true && p.data.has_access_token === true && p.data.account_id === "ss-acct-canary", p.error ?? JSON.stringify(p.data))
  c.step("credential boundary: the QUESTION answer carries no secret (no access_token key on the resolver's result — wave 140P)", !!p.data && !("access_token" in (p.data as object)), Object.keys(p.data ?? {}).join(","))
  const other = await resolveTransactionFormsProvider({ brokerage_id: B2 })
  c.step("POSITIVE CONTROL (tenant-owned, never shared): another tenant resolves not_configured — tenant 1's credential never leaks across", other.success && other.data?.provider_name === "not_configured" && other.data.is_configured === false && other.data.has_access_token === false, JSON.stringify(other.data))
  const cred = await loadTransactionFormsCredential({ brokerage_id: B })
  c.step("egress half: loadTransactionFormsCredential (server-side, never from a \"use server\" export) decrypts the stored token for the provider request", cred.success && cred.data?.provider_name === "skyslope" && cred.data.access_token === "canary-plaintext-token", cred.error ?? "")
  const forms = await loadAvailableTransactionForms({ brokerage_id: B, context_type: "listing", state: "FL" })
  const names = (forms.data?.forms ?? []).map((f) => f.name)
  c.step("forms work: the listing context lists the brokerage's OWN forms (state FL + stateless), required first", forms.success && names.length === 2 && names[0] === `${CANARY_TAG} Listing Agreement` && (forms.data?.forms ?? []).every((f) => /listing|disclosure/.test(String(f.category))), forms.error ?? names.join(" | "))
  const empty = await loadAvailableTransactionForms({ brokerage_id: B2, context_type: "offer" })
  c.step("forms work: a tenant with no library still gets the context defaults (purchase contract first) — the forms window is never empty", empty.success && (empty.data?.forms ?? []).length > 0 && /purchase contract/i.test(String(empty.data?.forms[0]?.name)), "")
  const { PROVIDER_CATALOG, DEFAULT_ESIGN_PROVIDER, getSelectableEsignProviders, getEsignProviders } = await import("../../lib/integrations/providers/catalog")
  const entries = Object.values(PROVIDER_CATALOG)
  const esignSelectable = getSelectableEsignProviders()
  c.step("capability honesty: e-sign and transaction-forms are SEPARATE flags per provider; a forms-only provider (brokermint) is never offered for e-sign", entries.every((e) => typeof e.capabilities.esign === "boolean" && typeof e.capabilities.transactionForms === "boolean") && PROVIDER_CATALOG.brokermint.capabilities.esign === false && !esignSelectable.includes("brokermint") && !getEsignProviders().includes("brokermint"), esignSelectable.join(","))
  c.step("capability honesty: only IMPLEMENTED (or portal-send) providers are selectable; the platform default e-sign is DocuSign and listed first", esignSelectable.every((n) => PROVIDER_CATALOG[n].implemented || PROVIDER_CATALOG[n].portalSend) && DEFAULT_ESIGN_PROVIDER === "docusign" && esignSelectable[0] === "docusign", `default ${DEFAULT_ESIGN_PROVIDER}`)
  c.step("capability honesty: an embed claim is per provider (skyslope frames; dotloop does not) — the wizard never shows a blank iframe for a provider with no embed surface", PROVIDER_CATALOG.skyslope.capabilities.embed === true && PROVIDER_CATALOG.dotloop.capabilities.embed === false, "")
  // WAVE141 HOOK (integrator): 141C — the typed matrix.
  for (const h of hooksFor("transaction-provider")) {
    const at = h.probe()
    if (!at) { c.hook(h.lane, h.contract, "at HEAD the catalog carries implemented + 3 capability flags; the per-path BUILT/PARTIAL/UNWIRED/MISSING matrix does not exist"); continue }
    const mod = (await import(`../../${at.replace(/\.ts$/, "")}`)) as Record<string, unknown>
    const matrix = Object.values(mod).find((v) => v && typeof v === "object" && !Array.isArray(v) && Object.values(v as Record<string, unknown>).some((row) => row && typeof row === "object")) as Record<string, Record<string, unknown>> | undefined
    c.step(`${h.lane} landed (${at}): the matrix names every catalog provider and every cell carries a BUILT/PARTIAL/UNWIRED/MISSING verdict (the integrator wires the selectable-only rule here: WAVE141 HOOK (integrator): 141C)`, !!matrix && entries.every((e) => e.name in matrix) && Object.values(matrix).every((row) => /BUILT|PARTIAL|UNWIRED|MISSING/.test(JSON.stringify(row))), matrix ? Object.keys(matrix).join(",") : "no matrix export found")
  }
  c.blind("No provider is called: creating a transaction, uploading, filling and syncing with SkySlope are the adapter's live paths (test:provider-adapter, test:form-wizard-esign); this canary proves selection, the credential boundary and the forms list.")
  const a = await cleanupCanary(svc, B), b = await cleanupCanary(svc, B2)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", a.mismatches.length + b.mismatches.length === 0 && a.residual + b.residual === 0, [...a.cleanup, ...b.cleanup].map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report([...a.cleanup, ...b.cleanup], a.residual + b.residual)
}
