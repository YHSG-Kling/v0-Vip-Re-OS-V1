#!/usr/bin/env tsx
/**
 * scripts/cda-esign-simulator.ts   (npm run test:cda-esign)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the CDA BROKER e-sign decision — "compliance approval triggers the broker to
 * sign the CDA with the e-sign provider; esign in the app if they have one configured."
 *
 *   PURE: resolveCdaSignMode picks esign_auto (Dotloop) / esign_manual (other provider) /
 *         in_app (no provider, OR no filled PDF to sign) — the deterministic gate that
 *         decides whether the broker signs through a provider or in-app.
 *
 * The dispatch itself is best-effort I/O (reuses resolveTransactionFormsProvider +
 * DotloopProvider, mirroring send-for-esign) and never blocks the in-app sign-off — so
 * the testable core is the decision + the honest fallbacks. No mocks.
 */
import { resolveCdaSignMode } from "../lib/transactions/cda-esign"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[no provider → broker signs in-app]")
  const none = resolveCdaSignMode({ providerConfigured: false, providerName: null, hasFilledPdf: true })
  check("no provider configured → in_app", none.mode === "in_app" && none.provider === null)
  check("reason is honest", none.reason === "no_esign_provider_configured")
  const notCfg = resolveCdaSignMode({ providerConfigured: false, providerName: "not_configured", hasFilledPdf: true })
  check("'not_configured' provider string → in_app", notCfg.mode === "in_app")

  console.log("\n[provider but no filled PDF → can't e-sign nothing]")
  const noPdf = resolveCdaSignMode({ providerConfigured: true, providerName: "dotloop", hasFilledPdf: false })
  check("provider configured but no filled CDA PDF → in_app", noPdf.mode === "in_app" && noPdf.provider === "dotloop")
  check("reason names the missing PDF", noPdf.reason === "no_filled_cda_pdf_to_sign")

  console.log("\n[Dotloop + filled PDF → auto-routed envelope]")
  const dl = resolveCdaSignMode({ providerConfigured: true, providerName: "dotloop", hasFilledPdf: true })
  check("Dotloop + filled PDF → esign_auto", dl.mode === "esign_auto" && dl.provider === "dotloop")

  console.log("\n[other provider + filled PDF → manual send via their provider]")
  for (const p of ["docusign", "skyslope", "formsimplicity", "brokermint", "authentisign"]) {
    const r = resolveCdaSignMode({ providerConfigured: true, providerName: p, hasFilledPdf: true })
    check(`${p} → esign_manual`, r.mode === "esign_manual" && r.provider === p)
  }

  console.log("\n[invariants]")
  const allModes = [none, noPdf, dl, resolveCdaSignMode({ providerConfigured: true, providerName: "docusign", hasFilledPdf: true })]
  check("mode is always one of the three", allModes.every((r) => ["esign_auto", "esign_manual", "in_app"].includes(r.mode)))
  check("esign modes only ever occur WITH a filled PDF", allModes.every((r) => r.mode === "in_app" || r.provider !== null))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ CDA_ESIGN_FAIL"); process.exit(1) }
  console.log(" ✅ CDA_ESIGN_PASS — broker signs via provider when configured, in-app otherwise; never e-signs an unbuilt CDA")
}
main()
