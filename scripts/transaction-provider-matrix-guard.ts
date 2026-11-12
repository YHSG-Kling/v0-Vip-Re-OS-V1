#!/usr/bin/env tsx
/**
 * scripts/transaction-provider-matrix-guard.ts   (npm run test:transaction-provider-matrix)
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 141, lane 141C — the TRANSACTION + E-SIGN CAPABILITY FABRIC, the CDA, the legal description.
 * Owner (verbatim, 2026-10-14): "TRANSACTION vs E-SIGN are DIFFERENT capabilities … every provider
 * HEAD claims must actually function (credentials → settings → forms → transaction creation → upload
 * → fill → e-sign if supported → status → sync) or it is not offered. Transaction-provider credentials
 * are the TENANT's; no shared cross-tenant credentials. CDA uses the tenant's selected e-sign provider
 * through the canonical e-sign adapter — never hardwired to Dotloop." · "LEGAL DESCRIPTION … Never
 * invent it: use an approved property-data capability if it legitimately provides it, else ask a
 * human; the form stays incomplete until the data exists."
 *
 * Proves, as RULES (never waypoints):
 *   A. MATRIX TRUTH — the typed registry (lib/integrations/providers/catalog.ts PROVIDER_CAPABILITY_
 *      MATRIX) names, for every provider × step, a file that exists and (for a code method) a method
 *      that exists in STRIPPED source; a MISSING e-sign cell has its honest refusal in code; every
 *      PARTIAL Dotloop cell is still grounded in the request shape it names (if the client is fixed,
 *      this says "flip the cell").
 *   B. VERDICTS — one rule derives "offered" from the cells; the platform e-sign DEFAULT is certified;
 *      an unavailable provider always carries a reason; esignCertified ⇔ the e-sign verdict.
 *   C. SETTINGS — every door that writes a capability selection asks the ONE verdict BEFORE it writes;
 *      the menu lists unavailable providers disabled WITH the reason; the owner's three defaults
 *      (e-sign DocuSign · payments Stripe · accounting QuickBooks) are offerable.
 *   D. CREDENTIALS ARE THE TENANT'S — the resolver walks the tenant cascade and refuses the platform
 *      tier; no transaction-provider client reads a shared env key; every legacy Dotloop helper is
 *      called with the tenant.
 *   E. CDA — follows the e-sign SELECTION (incl. the default) through the canonical dispatch core;
 *      no Dotloop branch; an uncertified selection signs in-app; the record keeps envelope_id.
 *   F. LEGAL DESCRIPTION — requirement + mapping + gate (pure), reader + writers + the human ask
 *      (stripped source), the capability is RentCast only, never model-authored, m768 vocabulary.
 *   G. REGISTRATION.
 * Every absence carries a POSITIVE CONTROL (CLAUDE.md §2); code-token scans read STRIPPED source.
 *
 * MAINTENANCE: domain `transaction_provider_matrix` (lib/kernel/manager-registry.ts) — deal_coordinator;
 * coOwners data_steward (the catalog, the credential cascade) and compliance_officer (the never-invented
 * legal description, the tenant credential boundary).
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import {
  PROVIDER_CATALOG, PROVIDER_CAPABILITY_MATRIX, MATRIX_STEPS, CAPABILITY_REQUIRED_STEPS,
  providerOfferVerdict, esignCertified,
  DEFAULT_ESIGN_PROVIDER, getSelectableEsignProviders, type ProviderName,
} from "../lib/integrations/providers/catalog"
import { providerSelectionVerdict, CONNECTOR_PROVIDERS } from "../lib/connections/scope"
import { resolveCdaSignMode } from "../lib/transactions/cda-esign"
import {
  legalDescriptionRequirement, legalDescriptionGate, typedLegalDescription,
  LEGAL_DESCRIPTION_SOURCES, LEGAL_DESCRIPTION_TASK_SOURCE,
} from "../lib/forms/legal-description"
import { buildPropertyPrefill } from "../lib/intelligence/offer-property-prefill"

const ROOT = process.cwd()
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
/** Code only: comments stripped (line numbers kept). */
const code = (p: string) => stripComments(read(p))
/** Code with string literals blanked too — for token scans a fixture string must not satisfy. */
const bare = (p: string) => blankStrings(stripComments(read(p)))

const PROVIDERS = Object.keys(PROVIDER_CATALOG) as ProviderName[]
/** The lists the ONE rule yields — derived here, per entry, exactly as the menu derives them. */
const offerableProviders = (c: "esign" | "transaction") => PROVIDERS.filter((p) => providerOfferVerdict(c, p).ok)
const unavailableProviders = (c: "esign" | "transaction") => PROVIDERS
  .filter((p) => (c === "esign" ? PROVIDER_CATALOG[p].capabilities.esign : PROVIDER_CATALOG[p].capabilities.transactionForms))
  .map((p) => ({ provider: p, v: providerOfferVerdict(c, p) }))
  .filter((x) => !x.v.ok)
  .map((x) => ({ provider: x.provider, reason: (x.v as { reason: string }).reason }))

// ── A · MATRIX TRUTH ───────────────────────────────────────────────────────────────────────
console.log("\n[A · matrix truth: every cell names a file that exists and a method that exists]")
// `tsx` before `ts`: with a lazy path the first alternative that matches wins, and `.ts` would
// truncate `integrations-client.tsx` to a file that does not exist.
const EVIDENCE_REF = /((?:lib|app|scripts|supabase)\/[\w\-/.[\]]+?\.(?:tsx|ts|sql))(?::(\d+))?(?:\s+([A-Za-z_][\w]*))?/g
const isCodeName = (n: string) => /^[a-z]+[A-Z]\w*$/.test(n) || /^[A-Z][A-Z0-9_]{2,}$/.test(n)
type RefProblem = { provider: string; step: string; file: string; name?: string }
function evidenceProblems(matrix: Record<string, Record<string, { evidence: string }>>): RefProblem[] {
  const out: RefProblem[] = []
  for (const [provider, row] of Object.entries(matrix)) {
    for (const [step, cell] of Object.entries(row)) {
      for (const m of cell.evidence.matchAll(EVIDENCE_REF)) {
        const file = m[1]
        if (!existsSync(join(ROOT, file))) { out.push({ provider, step, file }); continue }
        const name = m[3]
        if (name && isCodeName(name) && !new RegExp(`\\b${name}\\b`).test(code(file))) out.push({ provider, step, file, name })
      }
    }
  }
  return out
}
check("every provider has every step", PROVIDERS.every((p) => MATRIX_STEPS.every((s) => !!PROVIDER_CAPABILITY_MATRIX[p][s]?.status)))
check("every non-BUILT cell carries a reason (the sentence the tenant reads)",
  PROVIDERS.every((p) => MATRIX_STEPS.every((s) => PROVIDER_CAPABILITY_MATRIX[p][s].status === "BUILT" || !!PROVIDER_CAPABILITY_MATRIX[p][s].reason)))
const problems = evidenceProblems(PROVIDER_CAPABILITY_MATRIX)
check(`every evidence file exists and every named code method is in its stripped source (${problems.length} problems)`, problems.length === 0,
  problems.slice(0, 6).map((x) => `${x.provider}.${x.step}: ${x.file}${x.name ? ` ∌ ${x.name}` : " missing"}`).join("; "))
check("POSITIVE CONTROL: the evidence finder catches a missing file and an absent method",
  evidenceProblems({ x: { y: { evidence: "lib/integrations/providers/no-such-provider.ts:1 createTransaction" }, z: { evidence: "lib/integrations/providers/brokermint-provider.ts:1 sendForSignatureNowhere" } } }).length === 2)
check("Brokermint's MISSING e-sign cell is the honest refusal in code (ESIGN_UNSUPPORTED, sendForSignature + getSignatureStatus)",
  PROVIDER_CAPABILITY_MATRIX.brokermint.esign.status === "MISSING" && /ESIGN_UNSUPPORTED/.test(code("lib/integrations/providers/brokermint-provider.ts")) && PROVIDER_CATALOG.brokermint.capabilities.esign === false)
// A PARTIAL cell is grounded: the Dotloop client still speaks the shapes the matrix names as undocumented.
const dl = code("lib/integrations/providers/dotloop-provider.ts")
check("Dotloop PARTIAL cells are grounded in the client's request shape (transaction_type / file_url / full_name still sent) — if the client is corrected, flip the cells",
  /transaction_type:/.test(dl) && /file_url:/.test(dl) && /full_name:/.test(dl)
  && PROVIDER_CAPABILITY_MATRIX.dotloop.transaction_creation.status === "PARTIAL" && PROVIDER_CAPABILITY_MATRIX.dotloop.document_upload.status === "PARTIAL" && PROVIDER_CAPABILITY_MATRIX.dotloop.esign.status === "PARTIAL")
check("the matrix's own documentary evidence is dated and names its vendor sources (dotloop.github.io, apidocs.lwolf.com, VENDOR_CONTRACTS)",
  /EVIDENCE READ \d{4}-\d{2}-\d{2}/.test(read("lib/integrations/providers/catalog.ts")) && /dotloop\.github\.io\/public-api/.test(read("lib/integrations/providers/catalog.ts")) && /apidocs\.lwolf\.com/.test(read("lib/integrations/providers/catalog.ts")) && /VENDOR_CONTRACTS/.test(read("lib/integrations/providers/catalog.ts")))

// ── B · VERDICTS ───────────────────────────────────────────────────────────────────────────
console.log("\n[B · verdicts derive from the cells by ONE rule]")
const derived = (cap: "transaction" | "esign", p: ProviderName) => {
  const claims = cap === "esign" ? PROVIDER_CATALOG[p].capabilities.esign : PROVIDER_CATALOG[p].capabilities.transactionForms
  return claims && CAPABILITY_REQUIRED_STEPS[cap].every((s) => PROVIDER_CAPABILITY_MATRIX[p][s].status === "BUILT")
}
check("providerOfferVerdict ⇔ (the catalog claims it ∧ every required cell BUILT), for every provider × capability",
  PROVIDERS.every((p) => providerOfferVerdict("esign", p).ok === derived("esign", p) && providerOfferVerdict("transaction", p).ok === derived("transaction", p)))
check(`the platform e-sign DEFAULT (${DEFAULT_ESIGN_PROVIDER}) is certified for e-sign`, esignCertified(DEFAULT_ESIGN_PROVIDER) && offerableProviders("esign").includes(DEFAULT_ESIGN_PROVIDER))
check("Google eSignature (portal send) is certified for e-sign and refused for transactions by CAPABILITY", esignCertified("google_esign") && (() => { const v = providerOfferVerdict("transaction", "google_esign"); return !v.ok && v.step === "capability" })())
check("Brokermint is refused for e-sign by CAPABILITY (no e-sign), not by a cell", (() => { const v = providerOfferVerdict("esign", "brokermint"); return !v.ok && v.step === "capability" })())
check("Dotloop is refused for e-sign at its FIRST non-BUILT required step (credentials: no OAuth lifecycle) with the reason", (() => { const v = providerOfferVerdict("esign", "dotloop"); return !v.ok && v.step === "credentials" && /12-hour|OAuth/.test(v.reason) })())
check("SkySlope: transactions offered (files + documents paths published), e-sign refused at the envelope-path open item", providerOfferVerdict("transaction", "skyslope").ok && (() => { const v = providerOfferVerdict("esign", "skyslope"); return !v.ok && v.step === "esign" })())
check("an unknown name is refused, never guessed", !providerOfferVerdict("esign", "zipform").ok && !providerOfferVerdict("transaction", null).ok)
check("every unavailable provider carries a non-empty reason naming the provider", (["esign", "transaction"] as const).every((c) => unavailableProviders(c).every((u) => u.reason.length > 20 && new RegExp(PROVIDER_CATALOG[u.provider].label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(u.reason))))
check("offerable ∪ unavailable = every provider the catalog CLAIMS for the capability (nothing hidden)",
  (["esign", "transaction"] as const).every((c) => {
    const claimed = PROVIDERS.filter((p) => (c === "esign" ? PROVIDER_CATALOG[p].capabilities.esign : PROVIDER_CATALOG[p].capabilities.transactionForms)).sort()
    const listed = [...offerableProviders(c), ...unavailableProviders(c).map((u) => u.provider)].sort()
    return claimed.join() === listed.join()
  }))
console.log(`     offerable — esign: ${offerableProviders("esign").join(", ")} · transaction: ${offerableProviders("transaction").join(", ")}`)
console.log(`     unavailable — esign: ${unavailableProviders("esign").map((u) => u.provider).join(", ")} · transaction: ${unavailableProviders("transaction").map((u) => u.provider).join(", ")}`)

// ── C · SETTINGS ───────────────────────────────────────────────────────────────────────────
console.log("\n[C · settings: one setting per capability, selectable only when certified, unavailable with the reason]")
check("providerSelectionVerdict: a certified e-sign / transaction pick is allowed; an uncertified one is refused with the matrix's reason",
  providerSelectionVerdict("esign", DEFAULT_ESIGN_PROVIDER).ok && providerSelectionVerdict("transaction", "skyslope").ok
  && !providerSelectionVerdict("esign", "brokermint").ok && !providerSelectionVerdict("transaction", "dotloop").ok
  && /unavailable/.test((providerSelectionVerdict("transaction", "dotloop") as { reason: string }).reason))
check("accounting / payments: the Connection OS allow-list (QuickBooks, Stripe); Xero answers with what blocks it; an unknown is refused; 'none' always allowed",
  providerSelectionVerdict("accounting", "quickbooks").ok && providerSelectionVerdict("payment", "stripe").ok
  && !providerSelectionVerdict("accounting", "xero").ok && /not enabled yet/.test((providerSelectionVerdict("accounting", "xero") as { reason: string }).reason)
  && !providerSelectionVerdict("payment", "paypal").ok && providerSelectionVerdict("esign", "none").ok && providerSelectionVerdict("payment", "none").ok
  && CONNECTOR_PROVIDERS.financial.includes("quickbooks") && CONNECTOR_PROVIDERS.financial.includes("stripe"))
// The owner's three defaults are offerable — read from the kernel table as TEXT (never restated here).
const kp = code("lib/kernel/providers.ts")
const defaultOf = (t: string) => (kp.match(new RegExp(`^\\s*${t}:\\s*"([a-z_]+)"`, "m")) ?? [])[1] ?? null
check("the kernel defaults — payment Stripe, accounting QuickBooks — are selectable; the e-sign default is the ONE catalog constant",
  defaultOf("payment") === "stripe" && providerSelectionVerdict("payment", "stripe").ok && defaultOf("accounting") === "quickbooks" && providerSelectionVerdict("accounting", "quickbooks").ok && /esign:\s*DEFAULT_ESIGN_PROVIDER/.test(kp))
const doorAsksFirst = (src: string, fn: string) => {
  const body = src.slice(src.indexOf(`export async function ${fn}`))
  const ask = body.indexOf("providerSelectionVerdict(")
  const write = body.indexOf('.from("provider_overrides")')
  return ask > 0 && write > ask
}
check("app/actions/settings/integrations.ts upsertProviderOverride asks the verdict BEFORE it writes provider_overrides", doorAsksFirst(code("app/actions/settings/integrations.ts"), "upsertProviderOverride"))
check("app/actions/settings/provider-settings-actions.ts saveProviderOverride asks the verdict BEFORE it writes provider_overrides", doorAsksFirst(code("app/actions/settings/provider-settings-actions.ts"), "saveProviderOverride"))
check("POSITIVE CONTROL: a door that writes without asking is caught", !doorAsksFirst(`export async function saveX(p) {\n  await db.from("provider_overrides").upsert(p)\n}`, "saveX"))
const ui = code("app/dashboard/settings/integrations/integrations-client.tsx")
check("the settings menu offers ONE setting per capability (esign · transaction · accounting · payment) and reads the same verdict", /"esign", "transaction", "accounting", "payment"/.test(ui) && /providerSelectionVerdict\(/.test(ui))
check("the menu lists an unavailable provider DISABLED with the honest reason (never advertised, never hidden); Dotloop stays listed", /disabled=\{!v\.ok\}/.test(ui) && /unavailable/.test(ui) && /Unavailable — \{/.test(ui) && getSelectableEsignProviders().includes("dotloop"))
check("the page hands the kernel defaults down as data (SYSTEM_DEFAULTS), the client restates none", /SYSTEM_DEFAULTS/.test(code("app/dashboard/settings/integrations/page.tsx")) && !/SYSTEM_DEFAULTS\s*[:=]/.test(ui))

// ── D · CREDENTIALS ARE THE TENANT'S ───────────────────────────────────────────────────────
console.log("\n[D · credentials are the tenant's: cascade, platform tier refused, no shared env key]")
const pr = code("lib/integrations/providers/provider-resolver.ts")
const credFn = pr.slice(pr.indexOf("export async function resolveTenantProviderCredentials"), pr.indexOf("export async function resolveTransactionProviderSelection"))
check("resolveTenantProviderCredentials walks the ONE cascade (resolveScopedConnection with brokerageId) and refuses the platform tier by name",
  /resolveScopedConnection\(provider,\s*\{\s*brokerageId: ctx\.brokerageId/.test(credFn) && /ownerType === "platform"/.test(credFn) && /ok: false/.test(credFn))
const getTp = pr.slice(pr.indexOf("export async function getTransactionProvider("), pr.indexOf("export function getTransactionProviderByName"))
check("getTransactionProvider instantiates with the TENANT's credential — never a bare factory()", /resolveTenantProviderCredentials\(normalized/.test(getTp) && /factory\(cred\.credentials\)/.test(getTp) && !/factory\(\)/.test(getTp))
check("getTransactionProvider never consults the kernel's system default for `transaction` (no silent Dotloop): only a user / team / brokerage selection counts, then the legacy setting, then NONE",
  /resolveTransactionProviderSelection\(brokerageId\)/.test(getTp) && /r\.scope === "brokerage" \|\| r\.scope === "team" \|\| r\.scope === "user"/.test(pr) && /source: "none"/.test(pr) && !/SYSTEM_DEFAULTS/.test(bare("lib/integrations/providers/provider-resolver.ts")))
check("POSITIVE CONTROL: the bare-factory shape is what the finder refuses", /factory\(\)/.test(`  return factory()`))
const envFinder = (s: string) => /process\.env\.DOTLOOP_API_KEY|process\.env\.DOTLOOP_PROFILE_ID/.test(s)
check("no transaction-provider client or legacy Dotloop helper reads a shared env key (stripped + blanked source)",
  !envFinder(bare("lib/integrations/providers/dotloop-provider.ts")) && !envFinder(bare("lib/providers/esign/index.ts"))
  && ["docusign", "skyslope", "authentisign", "brokermint", "formsimplicity"].every((n) => !/process\.env\./.test(bare(`lib/integrations/providers/${n}-provider.ts`))))
check("POSITIVE CONTROL: the env finder recognises the retired shape", envFinder(`const apiKey = process.env.DOTLOOP_API_KEY`))
check("DotloopProvider serves ONLY an injected tenant credential (getCredentials returns the injection or null)",
  /return this\.injectedCredentials/.test(dl) && /return null/.test(dl.slice(dl.indexOf("private getCredentials"), dl.indexOf("private request"))))
check("the legacy Dotloop helpers resolve the TENANT's row through the resolver, and every caller passes the tenant",
  /resolveTenantProviderCredentials\("dotloop",\s*\{\s*brokerageId\s*\}\)/.test(code("lib/providers/esign/index.ts"))
  && /syncLoopDocuments\(brokerageId,\s*loopId\)/.test(code("lib/transactions/dotloop-document-sync.ts"))
  && /getLoopActivity\(ctx\.brokerageId,\s*loopId\)/.test(code("app/actions/dotloop-integration.ts"))
  && /await addParticipant\(\{\s*brokerageId: ctx\.brokerageId/.test(code("app/actions/dotloop-integration.ts"))
  && /await uploadLoopDocument\(\{\s*brokerageId: ctx\.brokerageId/.test(code("app/actions/dotloop-integration.ts")))
check("the forms-credential reader pins the brokerage (newestTransactionFormsCredential)", /\.eq\("brokerage_id", brokerage_id\)/.test(code("lib/kernel/forms.ts").slice(code("lib/kernel/forms.ts").indexOf("async function newestTransactionFormsCredential"))))

// ── E · CDA ────────────────────────────────────────────────────────────────────────────────
console.log("\n[E · the CDA follows the e-sign SELECTION through the canonical adapter — never Dotloop]")
const cda = code("lib/transactions/cda-esign.ts")
const cdaBare = bare("lib/transactions/cda-esign.ts")
check("cda-esign resolves WHICH through resolveESignChoice (user → team → brokerage, else the default) and HOW through dispatchEsignPacket",
  /resolveESignChoice\(\{\s*brokerageId: args\.brokerageId,\s*userId: args\.signerUserId,\s*teamId: signerTeamId/.test(cda) && /dispatchEsignPacket\(supabase as any,/.test(cda))
check("cda-esign gates on the matrix (esignCertified) — an uncertified selection signs in-app", /esignCertified\(providerName\)/.test(cda) && /providerCertified: certified/.test(cda))
const dotloopBranch = (s: string) => /===\s*"dotloop"|DotloopProvider|resolveTransactionFormsProvider|loadTransactionFormsCredential/.test(s)
check("no Dotloop branch, no transaction-vendor read, no forms-credential egress remains in cda-esign (stripped + blanked source)", !dotloopBranch(cdaBare) && !/dotloop/.test(cdaBare))
check("POSITIVE CONTROL: the retired shape is recognised", dotloopBranch(`    if (providerName === "dotloop") {\n      const dotloop = new DotloopProvider(creds)`))
check("PURE resolveCdaSignMode: no provider → in_app; uncertified → in_app (esign_provider_not_certified); no PDF → in_app; certified + PDF → esign; identity never matters",
  resolveCdaSignMode({ providerConfigured: false, hasFilledPdf: true }).reason === "no_esign_provider_configured"
  && resolveCdaSignMode({ providerConfigured: true, providerCertified: false, hasFilledPdf: true }).mode === "in_app"
  && resolveCdaSignMode({ providerConfigured: true, providerCertified: false, hasFilledPdf: true }).reason === "esign_provider_not_certified"
  && resolveCdaSignMode({ providerConfigured: true, hasFilledPdf: false }).reason === "no_filled_cda_pdf_to_sign"
  && resolveCdaSignMode({ providerConfigured: true, providerCertified: true, hasFilledPdf: true }).mode === "esign"
  && resolveCdaSignMode({ providerConfigured: true, hasFilledPdf: true }).mode === "esign")
const rsp = code("lib/integrations/resolve-esign-provider.ts")
check("the selection the CDA follows is the ONE rule: user → team → brokerage, else DEFAULT_ESIGN_PROVIDER (the default is a selection the CDA honours)",
  rsp.indexOf('readOverride("user"') < rsp.indexOf('readOverride("team"') && rsp.indexOf('readOverride("team"') < rsp.indexOf('readOverride("brokerage"') && /selection\.pick \|\| DEFAULT_ESIGN_PROVIDER/.test(rsp))
const portal = code("app/actions/cda-portal.ts")
check("both CDA signer doors (agent submit, broker sign) record the provider ENVELOPE id and status — the Dotloop `loop_id` vocabulary is gone",
  (portal.match(/envelope_id: (agentEsign|esign)\.envelopeId/g) ?? []).length === 2 && !/loop_id: (agentEsign|esign)\.loopId/.test(portal) && /dispatchCdaSignerEsign\(supabase, \{/.test(portal))
check("the CDA signer is read tenant-pinned (brokerage_id) and the notification says the honest status (sent vs awaiting the hand-off window)",
  /\.eq\("brokerage_id", args\.brokerageId\)/.test(cda) && /awaiting_agent_send/.test(cda) && /has emailed the filled CDA/.test(cda))

// ── F · LEGAL DESCRIPTION ──────────────────────────────────────────────────────────────────
console.log("\n[F · legal description: required → mapped → resolved from a legitimate source → or a human is asked; never invented]")
const FIELDS = ["Property Address", "Legal Description", "Buyer Name", "Purchase Price"]
const req = legalDescriptionRequirement(FIELDS, {})
check("a form carrying a Legal Description field REQUIRES it and is unsatisfied with no fact", req.required && !req.satisfied && req.fields.join() === "Legal Description")
check("the same form is satisfied once the fact exists; a form without the field needs nothing", legalDescriptionRequirement(FIELDS, { legalDescription: "LOT 4 BLK 2 SPRINGFIELD ADD" }).satisfied && !legalDescriptionRequirement(["Buyer Name"], {}).required)
check("the mapping survivor fills exactly the Legal Description field from the fact (buildPropertyPrefill)",
  (() => { const r = buildPropertyPrefill(FIELDS, { legalDescription: "LOT 4 BLK 2" }); return r.filled.length === 1 && r.filled[0].formField === "Legal Description" && r.filled[0].source === "legalDescription" })())
check("the agent's typed value is recognised by field name, blanks ignored", typedLegalDescription({ "Legal Description": " LOT 9 ", "Buyer Name": "x" }) === "LOT 9" && typedLegalDescription({ "Legal Description": "  " }) === null && typedLegalDescription(null) === null)
const gateBlank = legalDescriptionGate([{ name: "Purchase Agreement", fields: [{ name: "Legal Description", value: "" }, { name: "Buyer Name", value: "Ann" }] }])
check("THE GATE: a blank Legal Description makes the packet INCOMPLETE, naming the document and the field, and says it is never invented",
  !gateBlank.complete && gateBlank.blank.length === 1 && /Purchase Agreement/.test(gateBlank.reason ?? "") && /Legal Description/.test(gateBlank.reason ?? "") && /never invented/.test(gateBlank.reason ?? ""))
check("the gate passes a filled field and a form without the field", legalDescriptionGate([{ name: "A", fields: [{ name: "Legal Description", value: "LOT 1" }] }, { name: "B", fields: [{ name: "Buyer Name", value: "" }] }]).complete)
// THE RULE, not a waypoint (wave 142): the vocabulary is whatever the LATEST migration that defines the
// legal_description_source CHECK says (m768 wrote agent | rentcast; m786 widened it) — never a pinned file.
const migDir = join(ROOT, "supabase/migrations")
const sourceMigs = readdirSync(migDir)
  .filter((f) => /^m\d+-.*\.sql$/.test(f) && /legal_description_source IN \(/.test(readFileSync(join(migDir, f), "utf8")))
  .sort((a, b) => Number(a.match(/^m(\d+)/)![1]) - Number(b.match(/^m(\d+)/)![1]))
const mig = sourceMigs.length ? read(`supabase/migrations/${sourceMigs[sourceMigs.length - 1]}`) : ""
check("a migration defines the legal_description_source CHECK, and the LATEST one is honestly stamped (the lane stamp, or APPLIED LIVE once the integrator applies it)", sourceMigs.length > 0 && /^-- ── (WRITTEN, NOT APPLIED|APPLIED LIVE)/.test(mig), sourceMigs.join(", "))
const checkValues = [...mig.matchAll(/legal_description_source IN \(([^)]+)\)/g)].map((m) => m[1].split(",").map((s) => s.trim().replace(/'/g, "")).sort().join())
check(`ONE vocabulary: the latest defining migration's CHECK (${sourceMigs[sourceMigs.length - 1] ?? "none"}, both tables) equals LEGAL_DESCRIPTION_SOURCES, and a model is not a source`,
  checkValues.length === 2 && checkValues.every((v) => v === [...LEGAL_DESCRIPTION_SOURCES].sort().join()) && !(LEGAL_DESCRIPTION_SOURCES as readonly string[]).some((s) => /ai|model|llm/.test(s)), checkValues.join(" | "))
const runner = code("lib/intelligence/offer-property-prefill-runner.ts")
check("READER: resolveKnownPropertyFacts selects legal_description on BOTH records into KnownPropertyFacts.legalDescription",
  /from\("listings"\)\.select\("[^"]*legal_description/.test(runner) && /from\("transactions"\)\.select\("[^"]*legal_description/.test(runner) && /facts\.legalDescription = /.test(runner))
const ld = code("lib/forms/legal-description.ts")
check("WRITERS: the record write is tenant-pinned and COUNTED (.select('id')), for both records, the source beside the value (wave 142: with provenance)", /legal_description: value, legal_description_source: provenance\.source/.test(ld) &&/\.eq\("brokerage_id", args\.brokerageId\)\s*\n?\s*\.select\("id"\)/.test(ld) && /data\.length === 0/.test(ld))
check("the capability is RentCast's property record ONLY (approved, metered in rentcast.ts) — never BatchData, never Versium, never a model",
  /@\/lib\/property\/rentcast/.test(ld) && /legalDescription/.test(ld) && !/batchdata|versium|generateText|generateObject|anthropic|openai/i.test(bare("lib/forms/legal-description.ts")))
check("POSITIVE CONTROL: the model finder recognises a model call", /generateText|generateObject/.test(`const r = await generateText({ prompt })`))
check("THE HUMAN ASK rides the existing task rail (tasks, source legal_description_request, the agent's own agents.id, deduped on the open task, completed when a value lands)",
  /from\("tasks"\)\.insert\(/.test(ld) && /source: LEGAL_DESCRIPTION_TASK_SOURCE/.test(ld) && LEGAL_DESCRIPTION_TASK_SOURCE === "legal_description_request"
  && /from\("agents"\)\.select\("id"\)\.eq\("user_id", userId\)/.test(ld) && /is\("completed_at", null\)/.test(ld) && /completed_at: new Date\(\)\.toISOString\(\), status: "completed"/.test(ld))
const psf = code("app/actions/buyer-offer/prefill-storage-form.ts")
check("WIRED into the FormWizard's Fill step: prefillStorageFormAction asks the requirement from the PDF's fields and resolves (typed value wins) before the fill; the result carries `incomplete`",
  /legalDescriptionRequirement\(await listPdfFields\(srcBytes\), facts\)/.test(psf) && /resolveLegalDescriptionForForm\(svc, \{/.test(psf) && /typedValue: typedLegal/.test(psf) && psf.indexOf("resolveLegalDescriptionForForm(") < psf.indexOf("prefillPropertyIntoPdf(srcBytes") && /incomplete,/.test(psf))
const dp = code("lib/esign/dispatch-packet.ts")
check("THE SEND REFUSES an incomplete packet BEFORE the e-sign choice, the envelope and the Drive copy (the ONE dispatch core)",
  /legalDescriptionGate\(inspected\)/.test(dp) && dp.indexOf("incompletePacketReason(svc, input.documents)") > 0 && dp.indexOf("incompletePacketReason(svc, input.documents)") < dp.indexOf("resolveESignChoice({ brokerageId: input.brokerageId"))
const wiz = code("app/components/form-wizard/FormWizard.tsx")
check("the wizard shows the INCOMPLETE state with its reason (not a rewrite — one notice beside the preview)", /fs\.incomplete/.test(wiz) && /legal description required/i.test(wiz) && /incomplete: res\.incomplete \?\? null/.test(wiz))

// ── G · REGISTRATION ───────────────────────────────────────────────────────────────────────
console.log("\n[G · registration]")
const pkg = read("package.json")
check("package.json wires test:transaction-provider-matrix", /"test:transaction-provider-matrix":\s*"tsx scripts\/transaction-provider-matrix-guard\.ts"/.test(pkg))
check("the guard chain runs it (membership, never a position)", new RegExp("npm run test:transaction-provider-matrix(\\s|&|$)").test(JSON.parse(pkg).scripts.guard ?? ""))
check("a MAINTENANCE_DOMAINS entry owns it", /proof:\s*"test:transaction-provider-matrix"/.test(code("lib/kernel/manager-registry.ts")))

console.log("\nBLIND SPOTS: no vendor is called — a BUILT cell means the documented path is wired with the tenant's credential, not that a live call succeeded today;")
console.log("  evidence line numbers drift with edits (the method-name check holds, the number is a pointer); the dispatch gate inspects library PDFs only")
console.log("  (record URLs and non-PDF documents pass through, stated in dispatch-packet.ts); m768's columns are asserted as TEXT until applied.")
console.log(`\nRESULT: ${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`)
if (failures.length) { console.log("FAILURES:"); failures.forEach((f) => console.log("  - " + f)) }
process.exit(failed === 0 ? 0 : 1)
