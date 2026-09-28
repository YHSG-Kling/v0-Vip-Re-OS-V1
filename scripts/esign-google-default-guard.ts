#!/usr/bin/env tsx
/**
 * scripts/esign-google-default-guard.ts   (npm run test:esign-google-default)
 * ─────────────────────────────────────────────────────────────────────────────
 * Lane 88B (wave 88). Owner, verbatim: "google esign is default not dotloop."
 *
 * FINDING FIRST: the repo had NO Google e-sign integration to "make default" — every unconfigured
 * path fell back to Dotloop (lib/kernel/providers.ts SYSTEM_DEFAULTS.esign "dotloop", getEsignStatus
 * `?? "dotloop"`, the settings override form's first value, the admin provider panel's default).
 * Google Workspace eSignature (Docs/Drive → Tools → eSignature → Request signature) publishes no API
 * to create a request and allows no framing, so the missing half was built the only honest way: a
 * PORTAL-SEND catalog provider (lib/integrations/providers/catalog.ts google_esign, portalSend) that
 * our flow fills and stages for, then hands the agent their own Google Drive — the same manual-send
 * rail Brokermint already used (lib/workflow/adapters/send-for-esign.ts).
 *
 * Proven on the REAL code:
 *   A · the catalog: DEFAULT_ESIGN_PROVIDER is google_esign (portalSend, new-tab Drive window);
 *       resolveEsignProviderOrDefault maps unconfigured / "none" / unknown / non-e-sign → the default
 *       and keeps a real selection; Dotloop REMAINS selectable (settings menu + connect list).
 *   B · provider resolution: resolveProviderCore("esign") with no override answers google_esign; an
 *       explicit Dotloop override still wins; getTransactionProviderByName("google_esign") refuses with
 *       the send-from-Drive sentence; Dotloop still instantiates.
 *   C · no silent Dotloop default survives in the resolution / settings / UI / onboarding sources,
 *       and the send-for-esign step, launchEsignEnvelope, the actor resolver, the forms library and
 *       onboarding all name the Google default.
 * Every absence has a positive control. Rule, not waypoint.
 * Blind spots: C is text over comment-stripped source of the NAMED files (listed in the output); a
 * Dotloop default under another spelling in an unnamed file is not seen. The workflow step is judged
 * statically (its dynamic imports need the live service client).
 * Run: npx tsx scripts/esign-google-default-guard.ts
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"

const ROOT = process.cwd()
const code = (p: string) => stripComments(readFileSync(join(ROOT, p), "utf8"))
let pass = 0
let fail = 0
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}

const STUB_BY_SPEC: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => { throw new Error('no service client in the proof') }",
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const stub = STUB_BY_SPEC[spec]
    if (stub !== undefined) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

const BRK = "11111111-1111-4111-8111-111111111111"

async function main() {
  // ── A · the catalog ──────────────────────────────────────────────────────────────
  console.log("\n[A · catalog: Google eSignature is the default; Dotloop stays selectable]")
  const C = await import("../lib/integrations/providers/catalog")
  ok("DEFAULT_ESIGN_PROVIDER is google_esign", C.DEFAULT_ESIGN_PROVIDER === "google_esign")
  const g = C.getCatalogEntry("google_esign")
  ok("google_esign is a portal-send e-sign provider (no send API, no framing, not a forms library)",
    !!g && g.portalSend === true && g.capabilities.esign && !g.capabilities.embed && !g.capabilities.transactionForms && g.label === "Google eSignature")
  const portal = C.providerPortalMode("google_esign")
  ok("its window opens the agent's own Google Drive in a new tab", portal?.mode === "new_tab" && /^https:\/\/drive\.google\.com\//.test(portal?.url ?? ""))
  for (const v of [null, undefined, "", "not_configured", "none", "bogus_vendor", "brokermint"]) {
    ok(`resolveEsignProviderOrDefault(${JSON.stringify(v)}) → google_esign`, C.resolveEsignProviderOrDefault(v as any) === "google_esign")
  }
  ok("POSITIVE CONTROL: a real selection is kept — resolveEsignProviderOrDefault(\"dotloop\") → dotloop",
    C.resolveEsignProviderOrDefault("dotloop") === "dotloop" && C.resolveEsignProviderOrDefault("DocuSign") === "docusign")
  const selectable = C.getSelectableEsignProviders()
  ok("settings menu: Google eSignature FIRST, Dotloop still offered", selectable[0] === "google_esign" && selectable.includes("dotloop"), selectable.join(","))
  const connectable = C.getEsignProviders()
  ok("connect allow-list (lib/connections/scope.ts): Dotloop still connectable; Google has no credential so it is not a connection",
    connectable.includes("dotloop") && !connectable.includes("google_esign" as any), connectable.join(","))

  // ── B · provider resolution ──────────────────────────────────────────────────────
  console.log("\n[B · resolution: no override → Google; an explicit Dotloop pick still wins]")
  const P = await import("../lib/kernel/providers")
  const none = await P.resolveProviderCore(memSupabase({ provider_overrides: [], users: [], teams: [] }) as any,
    { providerType: "esign", actorContext: { userId: "u1", brokerageId: BRK } })
  ok("resolveProviderCore(esign) with no override → google_esign (system default)", none.providerKey === "google_esign" && none.scope === "system_default", JSON.stringify(none))
  const picked = await P.resolveProviderCore(memSupabase({
    provider_overrides: [{ provider_type: "esign", scope_type: "brokerage", scope_id: BRK, enabled: true, provider_key: "dotloop", config: {} }],
    users: [], teams: [],
  }) as any, { providerType: "esign", actorContext: { userId: "u1", brokerageId: BRK } })
  ok("POSITIVE CONTROL: a brokerage that selected Dotloop keeps Dotloop", picked.providerKey === "dotloop" && picked.scope === "brokerage", JSON.stringify(picked))
  const R = await import("../lib/integrations/providers/provider-resolver")
  let googleErr = ""
  try { R.getTransactionProviderByName("google_esign") } catch (e: any) { googleErr = String(e?.message ?? e) }
  ok("getTransactionProviderByName(google_esign) refuses with WHERE to send (not \"not yet available\")",
    /Google eSignature sends from/.test(googleErr) && !/not yet available/.test(googleErr), googleErr)
  let dotloopOk = false
  try { dotloopOk = !!R.getTransactionProviderByName("dotloop", { apiKey: "k", profileId: "p" }) } catch { dotloopOk = false }
  ok("Dotloop still instantiates (selectable, not removed)", dotloopOk)

  // ── C · no silent Dotloop default; every surface names Google ────────────────────
  console.log("\n[C · sources: no Dotloop default; Google named at every unconfigured door]")
  const SILENT_DOTLOOP = /esign:\s*["']dotloop["']|provider_name\s*\?\?\s*["']dotloop["']|provider_key:\s*["']dotloop["']\s*\}|default:\s*["']dotloop["']/
  const NAMED = [
    "lib/kernel/providers.ts", "lib/kernel/forms.ts", "app/dashboard/settings/integrations/integrations-client.tsx",
    "app/dashboard/admin/components/os/provider-intelligence-panel.tsx", "lib/workflow/adapters/send-for-esign.ts",
    "lib/integrations/resolve-esign-provider.ts",
  ]
  const hits = NAMED.filter((f) => SILENT_DOTLOOP.test(code(f)))
  ok(`0 of ${NAMED.length} resolution/settings/UI sources default e-sign to Dotloop`, hits.length === 0, hits.join(", "))
  for (const specimen of [`  esign:        "dotloop",`, `const providerName = providerResult.data?.provider_name ?? "dotloop"`, `const EMPTY_OVERRIDE: OverrideForm = { provider_type: "esign", provider_key: "dotloop" }`, `{ type: "esign", label: "E-Sign", default: "dotloop" },`]) {
    ok(`POSITIVE CONTROL: the finder recognises the retired shape ${specimen.trim().slice(0, 48)}…`, SILENT_DOTLOOP.test(specimen))
  }
  const kp = code("lib/kernel/providers.ts")
  ok("SYSTEM_DEFAULTS.esign reads the ONE catalog default", /esign:\s*DEFAULT_ESIGN_PROVIDER/.test(kp))
  const sfe = code("lib/workflow/adapters/send-for-esign.ts")
  ok("send-for-esign: an unconfigured brokerage uses the default (manual-send via Drive), a REFUSED resolution still stops",
    /else if \(result\.success\) \{[\s\S]{0,200}provider = DEFAULT_ESIGN_PROVIDER/.test(sfe) && /if \(!provider \|\| provider === "not_configured"\)/.test(sfe))
  ok("send-for-esign: the manual-send bell names the provider's own window + the Google eSignature steps",
    /manualEntry\?\.portalSend/.test(sfe) && /Tools → eSignature → Request signature/.test(sfe))
  ok("launchEsignEnvelope: unconfigured → names the Google default and its Drive window (still an honest refusal)",
    /E-sign defaults to \$\{portal\?\.label/.test(code("lib/kernel/forms.ts")))
  const res = code("lib/integrations/resolve-esign-provider.ts")
  ok("resolveESignProviderForActor: a Google pick is refused with the portal sentence BEFORE any credential search",
    res.indexOf("getCatalogEntry(preferredPlatform)?.portalSend") > 0 && res.indexOf("getCatalogEntry(preferredPlatform)?.portalSend") < res.indexOf("for (const provider of providersToTry)"))
  ok("resolveESignProviderForActor: nothing selected/connected → the Google default sentence, not \"connect Dotloop\"", /: portalSendMessage\(DEFAULT_ESIGN_PROVIDER\)/.test(res))
  ok("forms library: with nothing connected it offers the Google eSignature window",
    /providerPortalMode\(DEFAULT_ESIGN_PROVIDER\)/.test(code("app/dashboard/forms/FormsLibraryClient.tsx")))
  ok("settings: the override menu and form open on the default", /getSelectableEsignProviders\(\)/.test(code("app/dashboard/settings/integrations/integrations-client.tsx")) && /provider_key: DEFAULT_ESIGN_PROVIDER/.test(code("app/dashboard/settings/integrations/integrations-client.tsx")))
  ok("onboarding: the required e-sign category is met by the default (no connection needed)",
    /typeConnected\.has\(t\) \|\| t === "esign"/.test(code("app/dashboard/onboarding/tech-stack/tech-stack-client.tsx")))
  ok("onboarding checklist copy names the Google default", /Google eSignature/.test(code("lib/onboarding/setup-readiness.ts")))

  console.log(`\n  scanned for a silent Dotloop default: ${NAMED.join(", ")}`)
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
  console.log(" ESIGN_GOOGLE_DEFAULT_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
