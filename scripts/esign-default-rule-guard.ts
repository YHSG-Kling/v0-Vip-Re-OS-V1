#!/usr/bin/env tsx
/**
 * scripts/esign-default-rule-guard.ts   (npm run test:esign-default-rule)
 * ─────────────────────────────────────────────────────────────────────────────
 * Lane 89A (wave 89). Owner, verbatim: "brokerage uses their own transaction and esign provider. the
 * platforms defualt esign is no longer google but we decided on docusign instead since it will embed
 * in our platform window." Renamed from lane 88B's esign-google-default-guard.ts and RE-ANCHORED TO
 * THE RULE, not the vendor:
 *
 *   WHICH provider  = the user's → team's → brokerage's e-sign SELECTION, else the catalog DEFAULT
 *                     (DEFAULT_ESIGN_PROVIDER — DocuSign today; the proof reads the constant).
 *   WHOSE credential = that ONE provider's connection (agent → team → brokerage → platform tier); for
 *                     the DEFAULT only, the platform's own DocuSign account (JWT grant) is the last rung.
 *   NEVER            "whatever transaction-management vendor is connected".
 *   Google eSignature stays SELECTABLE — a choice, never a silent fallback.
 *
 * Proven on the REAL code (module-edge stubs only where the live service client / vendor would be):
 *   A · the catalog: the default is a real, implemented, embedded-send e-sign provider; Google stays
 *       selectable; the settings menu offers the default first.
 *   B · resolveProviderCore("esign"): no override → the default; a selection wins.
 *   C · resolveESignProviderForActor / resolveESignChoice on ten worlds — the default with nothing
 *       connected → the platform account; a connected OTHER vendor never stands in (positive control:
 *       the retired rule would have picked it); a selection resolves to ITS credential or a refusal by
 *       name; a Google selection is the Google choice; the webhook's provider hint is honoured;
 *       a user pick beats a brokerage pick; a missing platform account is a refusal, not a fallback.
 *   D · the platform account's pure half: the RS256 assertion verifies with the public key, carries
 *       iss/sub/aud/scope, ≤ 1 h; env status names what is missing; demo ↔ prod base URI.
 *   E · the workflow send step (REAL adapter): default → the resolved provider sends; a Google
 *       selection → the manual-send rail; a refused resolution fails closed.
 *   F · sources: no silent vendor default; every door reads the ONE constant; the retired "iterate
 *       whatever is connected" shape is absent (and recognised by the finder).
 * Every absence has a positive control. Rule, not waypoint.
 * Blind spots: F is text over comment-stripped source of the NAMED files; a default under another
 * spelling in an unnamed file is not seen. No vendor is called (no credentials here).
 * Run: npx tsx scripts/esign-default-rule-guard.ts
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { generateKeyPairSync, createVerify } from "node:crypto"
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

const G = globalThis as any
// THE WORLD the resolver sees: the selection rows, the connections per (provider, owner), the
// platform DocuSign account's answer. Each is stubbed at the module edge; the resolver is REAL.
G.__89A = {
  mem: memSupabase,
  overrides: [] as any[],
  connections: {} as Record<string, { ownerType: string; ownerId: string; apiKey: string; accountId: string }>,
  platform: { ok: true, credential: { apiKey: "platform-token", profileId: "platform-acct", baseUri: "https://demo.docusign.net", expiresAt: Date.now() + 3_600_000 } } as any,
  // The workflow step's stubs (section E).
  wfSelection: "docusign",
  wfResolved: null as any,
  wfCalls: [] as string[],
}
const STUB_BY_SPEC: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => globalThis.__89A.mem({ provider_overrides: globalThis.__89A.overrides, users: [], teams: [] })",
  "@/lib/connections/resolve-scoped": "export const resolveScopedConnection = async (provider, ctx) => { const w = globalThis.__89A.connections; const order = ['agent:'+(ctx.agentUserId||''), 'team:'+(ctx.teamId||''), 'brokerage:'+(ctx.brokerageId||''), 'platform:platform']; for (const key of order) { const c = w[provider+'@'+key]; if (c) return { provider, credentialId: 'cred-'+provider+'-'+c.ownerType, apiKey: c.apiKey, accountId: c.accountId, config: {}, ownerType: c.ownerType, ownerId: c.ownerId } } return null }",
  "@/lib/esign/docusign-platform-account": "export const resolvePlatformDocusignCredential = async () => globalThis.__89A.platform; export const platformDocusignConfigured = () => ({ configured: !!globalThis.__89A.platform.ok, missing: [] })",
  "@/lib/kernel/tenant-config-reads": "export const resolveTenantProvider = async () => ({ providerKey: globalThis.__89A.wfSelection, config: {}, scope: 'brokerage' })",
  "@/lib/esign/google-esign-handoff": "export const handOffToGoogleEsign = async () => ({ ok: false, files: [], error: 'not in the proof' }); export const googleEsignReadiness = async () => ({ connected: false, driveGranted: null, email: null })",
}
// The workflow step imports the resolver dynamically; in section E it is swapped for a stub that
// answers from the world (so the REAL resolver is exercised in C and the REAL step in E).
let stubResolverForWorkflow = false
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    if (stubResolverForWorkflow && spec === "@/lib/integrations/resolve-esign-provider") {
      const src = "export const resolveESignProviderForActor = async () => { const r = globalThis.__89A.wfResolved; if (!r) throw new Error('E-sign is set to DocuSign, but no active DocuSign connection was found for you, your team or your brokerage.'); return r }"
      return { url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true }
    }
    const stub = STUB_BY_SPEC[spec]
    if (stub !== undefined) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

const BRK = "11111111-1111-4111-8111-111111111111"
const USER = "22222222-2222-4222-8222-222222222222"
const TEAM = "33333333-3333-4333-8333-333333333333"
const sel = (scope: string, id: string, key: string) => ({ provider_type: "esign", scope_type: scope, scope_id: id, enabled: true, provider_key: key, config: {} })
const conn = (provider: string, ownerType: string, ownerId: string) => ({ [`${provider}@${ownerType}:${ownerId}`]: { ownerType, ownerId, apiKey: `${provider}-key`, accountId: `${provider}-acct` } })

async function main() {
  // ── A · the catalog ──────────────────────────────────────────────────────────────
  console.log("\n[A · catalog: the default is a real embedded-send e-sign provider; Google stays selectable]")
  const C = await import("../lib/integrations/providers/catalog")
  const DEF = C.DEFAULT_ESIGN_PROVIDER
  const d = C.getCatalogEntry(DEF)
  ok(`DEFAULT_ESIGN_PROVIDER (${DEF}) is an IMPLEMENTED e-sign provider with an EMBEDDED sender view (frames in our window)`,
    !!d && d.implemented && d.capabilities.esign && C.supportsEmbeddedSend(DEF) && !d.portalSend)
  ok("owner ruling: the default is DocuSign (the value today — the rule above is what the rest proves)", DEF === "docusign")
  const g = C.getCatalogEntry("google_esign")
  ok("Google eSignature remains a selectable portal-send e-sign provider (its Drive hand-off kept), not the default",
    !!g && g.portalSend === true && g.capabilities.esign && DEF !== "google_esign")
  const selectable = C.getSelectableEsignProviders()
  ok("settings menu: the default FIRST, Google eSignature and Dotloop still offered", selectable[0] === DEF && selectable.includes("google_esign") && selectable.includes("dotloop"), selectable.join(","))
  ok("the silent 'unknown selection → default' mapper (resolveEsignProviderOrDefault) is retired onto the resolver — tombstone names the survivor",
    !("resolveEsignProviderOrDefault" in C) && /TOMBSTONE \(lane 89A\): resolveEsignProviderOrDefault deleted/.test(readFileSync(join(ROOT, "lib/integrations/providers/catalog.ts"), "utf8")))
  ok("connect allow-list (lib/connections/scope.ts): the default and Dotloop connectable; Google has no credential", C.getEsignProviders().includes(DEF) && C.getEsignProviders().includes("dotloop") && !C.getEsignProviders().includes("google_esign" as any))

  // ── B · provider resolution core ─────────────────────────────────────────────────
  console.log("\n[B · resolveProviderCore(esign): no override → the default; a selection wins]")
  const P = await import("../lib/kernel/providers")
  const none = await P.resolveProviderCore(memSupabase({ provider_overrides: [], users: [], teams: [] }) as any, { providerType: "esign", actorContext: { userId: "u1", brokerageId: BRK } })
  ok("no override → DEFAULT_ESIGN_PROVIDER (system default)", none.providerKey === DEF && none.scope === "system_default", JSON.stringify(none))
  for (const pick of ["dotloop", "google_esign"]) {
    const picked = await P.resolveProviderCore(memSupabase({ provider_overrides: [sel("brokerage", BRK, pick)], users: [], teams: [] }) as any, { providerType: "esign", actorContext: { userId: "u1", brokerageId: BRK } })
    ok(`POSITIVE CONTROL: a brokerage that selected ${pick} keeps it`, picked.providerKey === pick && picked.scope === "brokerage", JSON.stringify(picked))
  }

  // ── C · THE RESOLVER, ten worlds ─────────────────────────────────────────────────
  console.log("\n[C · resolveESignProviderForActor: selection → default; ONE provider's credential; never 'whatever is connected']")
  const R = await import("../lib/integrations/resolve-esign-provider")
  const world = (overrides: any[], connections: Record<string, any>, platform?: any) => { G.__89A.overrides = overrides; G.__89A.connections = connections; if (platform !== undefined) G.__89A.platform = platform }
  const attempt = async (ctx: any) => { try { return { ok: true as const, r: await R.resolveESignProviderForActor(ctx) } } catch (e: any) { return { ok: false as const, error: String(e?.message ?? e) } } }
  const ctx = { brokerageId: BRK, userId: USER, teamId: TEAM }

  world([], {})
  const w1 = await attempt(ctx)
  ok("1 · no selection, nothing connected → the DEFAULT on the PLATFORM's account (scope platform, isDefault)",
    w1.ok && w1.r.providerName === DEF && w1.r.resolvedScope === "platform" && w1.r.isDefault === true && w1.r.credentials.apiKey === "platform-token", JSON.stringify(w1))

  world([], { ...conn("dotloop", "brokerage", BRK) })
  const w2 = await attempt(ctx)
  ok("2 · no selection, ONLY Dotloop connected → still the default (platform DocuSign), Dotloop never stands in",
    w2.ok && w2.r.providerName === DEF && w2.r.resolvedScope === "platform", JSON.stringify(w2))
  G.__89A.platform = { ok: false, configured: false, error: "The platform DocuSign account is not configured (missing DOCUSIGN_JWT_USER_ID)." }
  const w2b = await attempt(ctx)
  ok("2b · …and with no platform account either, a REFUSAL naming the default — never the connected other vendor",
    !w2b.ok && /DocuSign/.test(w2b.error) && !/providerName/.test(w2b.error) && /DOCUSIGN_JWT_USER_ID/.test(w2b.error), JSON.stringify(w2b))
  ok("POSITIVE CONTROL: the retired rule (first connected vendor wins) WOULD have answered dotloop here",
    (() => { const connected = Object.keys(G.__89A.connections).map((k) => k.split("@")[0]); return ["dotloop", "docusign", "skyslope", "authentisign"].find((p) => connected.includes(p)) === "dotloop" })())

  world([], { ...conn("docusign", "brokerage", BRK) }, { ok: false, configured: false, error: "unused" })
  const w3 = await attempt(ctx)
  ok("3 · no selection, the BROKERAGE's own DocuSign connected → the default on the tenant's credential (scope brokerage), the platform account untouched",
    w3.ok && w3.r.providerName === DEF && w3.r.resolvedScope === "brokerage" && w3.r.isDefault === true && w3.r.credentials.apiKey === "docusign-key", JSON.stringify(w3))

  world([sel("brokerage", BRK, "dotloop")], { ...conn("dotloop", "brokerage", BRK), ...conn("docusign", "brokerage", BRK) })
  const w4 = await attempt(ctx)
  ok("4 · brokerage SELECTED Dotloop (DocuSign also connected) → Dotloop with ITS credential, isDefault false",
    w4.ok && w4.r.providerName === "dotloop" && w4.r.resolvedScope === "brokerage" && w4.r.isDefault === false && w4.r.credentials.apiKey === "dotloop-key", JSON.stringify(w4))

  world([sel("brokerage", BRK, "dotloop")], { ...conn("docusign", "brokerage", BRK) }, { ok: true, credential: { apiKey: "platform-token", profileId: "platform-acct", baseUri: "https://demo.docusign.net", expiresAt: Date.now() + 3_600_000 } })
  const w5 = await attempt(ctx)
  ok("5 · SELECTED Dotloop but only DocuSign connected → refused BY NAME (Dotloop); DocuSign and the platform account never stand in",
    !w5.ok && /Dotloop/.test(w5.error) && /brokerage setting/.test(w5.error), JSON.stringify(w5))

  world([sel("brokerage", BRK, "google_esign")], { ...conn("docusign", "brokerage", BRK) })
  const w6 = await attempt(ctx)
  ok("6 · SELECTED Google eSignature → the resolver refuses with WHERE to send from (no credential exists)", !w6.ok && /Google eSignature/.test(w6.error) && /Request signature/.test(w6.error), JSON.stringify(w6))
  const c6 = await R.resolveESignChoice(ctx)
  ok("6b · …and resolveESignChoice makes it the GOOGLE choice (scope brokerage, not 'default')", c6.ok && c6.kind === "google" && c6.resolvedScope === "brokerage", JSON.stringify(c6))

  world([sel("brokerage", BRK, "docusign")], { ...conn("skyslope", "brokerage", BRK), ...conn("docusign", "brokerage", BRK) })
  const w8 = await attempt({ ...ctx, provider: "skyslope" })
  ok("8 · the webhook's provider hint (the vendor that SENT the envelope) is honoured over the selection", w8.ok && w8.r.providerName === "skyslope" && w8.r.isDefault === false, JSON.stringify(w8))

  world([sel("brokerage", BRK, "dotloop"), sel("user", USER, "skyslope")], { ...conn("skyslope", "agent", USER), ...conn("dotloop", "brokerage", BRK) })
  const w9 = await attempt(ctx)
  ok("9 · the USER's selection beats the brokerage's, and resolves to the user's own credential (scope user)", w9.ok && w9.r.providerName === "skyslope" && w9.r.resolvedScope === "user", JSON.stringify(w9))

  world([], {})
  const c10 = await R.resolveESignChoice(ctx)
  ok("10 · resolveESignChoice with nothing selected → the API default on the platform account (never a silent Google fallback)",
    c10.ok && c10.kind === "api" && c10.providerName === DEF && c10.resolved.resolvedScope === "platform", JSON.stringify(c10))
  world([], {}, { ok: false, configured: false, error: "The platform DocuSign account is not configured (missing DOCUSIGN_RSA_PRIVATE_KEY)." })
  const c10b = await R.resolveESignChoice(ctx)
  ok("10b · …and without the platform account it is a REFUSAL that names Google as a choice — not a silent switch to it",
    !c10b.ok && /select Google eSignature/.test(c10b.error), JSON.stringify(c10b))
  world([sel("brokerage", BRK, "brokermint")], {})
  const w11 = await attempt(ctx)
  ok("11 · a selection that cannot sign (Brokermint) is refused by name, never replaced", !w11.ok && /Brokermint/.test(w11.error), JSON.stringify(w11))

  // ── D · the platform account's pure half ─────────────────────────────────────────
  console.log("\n[D · platform DocuSign account: JWT assertion, env status, base URI]")
  const J = await import("../lib/esign/docusign-jwt")
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string
  const now = 1_800_000_000
  const jwt = J.buildDocusignJwtAssertion({ integrationKey: "ik-123", userId: "user-guid", oauthHost: "https://account-d.docusign.com/", privateKeyPem: pem.replace(/\n/g, "\\n"), nowSec: now, ttlSec: 7200 })
  const [h, c, s] = jwt.split(".")
  const verifier = createVerify("RSA-SHA256"); verifier.update(`${h}.${c}`)
  const sigOk = verifier.verify(publicKey, Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4), "base64"))
  ok("the assertion is RS256-signed and verifies with the key's public half (a \\n-escaped PEM accepted)", sigOk)
  const decodeJwtClaims = (assertion: string): Record<string, unknown> => {
    const part = assertion.split(".")[1] ?? ""
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4), "base64").toString("utf8"))
  }
  const claims = decodeJwtClaims(jwt)
  ok("claims: iss = integration key, sub = API user, aud = the OAuth HOST (no scheme, no slash), scope 'signature impersonation'",
    claims.iss === "ik-123" && claims.sub === "user-guid" && claims.aud === "account-d.docusign.com" && claims.scope === J.DOCUSIGN_JWT_SCOPE, JSON.stringify(claims))
  ok("lifetime is capped at DocuSign's 1 hour (7200 asked → 3600)", claims.iat === now && (claims.exp as number) - (claims.iat as number) === 3600)
  ok("token exchange body is the jwt-bearer grant", J.docusignTokenExchangeBody("x").grant_type === "urn:ietf:params:oauth:grant-type:jwt-bearer")
  const st = J.platformDocusignEnvStatus({ DOCUSIGN_INTEGRATION_KEY: "ik", DOCUSIGN_OAUTH_HOST: "account-d.docusign.com" })
  ok("env status NAMES the missing variables (fail closed, said out loud)", !st.configured && st.missing.join(",") === "DOCUSIGN_JWT_USER_ID,DOCUSIGN_RSA_PRIVATE_KEY,DOCUSIGN_PLATFORM_ACCOUNT_ID", st.missing.join(","))
  ok("demo OAuth host → demo REST base; production host → www; an explicit base URI wins",
    st.baseUri === "https://demo.docusign.net"
    && J.platformDocusignEnvStatus({ DOCUSIGN_OAUTH_HOST: "account.docusign.com" }).baseUri === "https://www.docusign.net"
    && J.platformDocusignEnvStatus({}).baseUri === "https://www.docusign.net"
    && J.platformDocusignEnvStatus({ DOCUSIGN_OAUTH_HOST: "account.docusign.com", DOCUSIGN_BASE_URI: "https://na3.docusign.net/" }).baseUri === "https://na3.docusign.net")
  ok("POSITIVE CONTROL: all four present → configured", J.platformDocusignEnvStatus({ DOCUSIGN_INTEGRATION_KEY: "a", DOCUSIGN_JWT_USER_ID: "b", DOCUSIGN_RSA_PRIVATE_KEY: "c", DOCUSIGN_PLATFORM_ACCOUNT_ID: "d" }).configured)
  const envDoc = readFileSync(join(ROOT, ".env.example"), "utf8")
  ok("every platform-account env var is documented in .env.example", J.PLATFORM_DOCUSIGN_ENV.every((k) => new RegExp(`^${k}=`, "m").test(envDoc)))

  // ── E · the workflow send step (REAL adapter) ─────────────────────────────────────
  console.log("\n[E · workflow send step: selection → the resolver's provider; Google selection → manual rail; refusal fails closed]")
  stubResolverForWorkflow = true
  const { sendForEsignAdapter } = await import("../lib/workflow/adapters/send-for-esign")
  const DOC = "e1000000-0000-4000-8000-000000000001"
  const fakeProvider = {
    name: "docusign",
    createTransaction: async () => { G.__89A.wfCalls.push("create"); return { success: true, externalTransactionId: "env-1" } },
    attachForms: async () => { G.__89A.wfCalls.push("attach"); return { success: true, attachedCount: 1 } },
    sendForSignature: async () => { G.__89A.wfCalls.push("send"); return { success: true } },
  }
  const run = async () => {
    const db = memSupabase({ documents: [{ id: DOC, document_type: "listing_agreement", status: "draft_ready", content: "x", state_code: "TX", transaction_id: null, listing_id: null, storage_url: null, metadata: {}, contact_id: "c1" }], notifications: [], listings: [], transactions: [], client_documents: [], signature_requests: [] })
    const res = await sendForEsignAdapter.execute({ enrollmentId: "en1", step: {} as any, contact: { id: "c1", first_name: "Pat", email: "pat@example.com" } as any, brokerageId: BRK, agentUserId: USER, agentId: null, supabase: db, previousOutputs: {} } as any)
    return { res, db }
  }
  G.__89A.wfSelection = DEF; G.__89A.wfResolved = { providerName: DEF, provider: fakeProvider, resolvedScope: "platform", isDefault: true, credentials: { apiKey: "t", profileId: "a" }, accountId: "a", credentialId: "platform-docusign" }; G.__89A.wfCalls = []
  const e1 = await run()
  ok("default (nothing selected) → the step SENDS through the resolver's provider (create → attach → send)",
    e1.res.status === "sent" && e1.res.providerKey === DEF && G.__89A.wfCalls.join(">") === "create>attach>send", JSON.stringify(e1.res))
  G.__89A.wfSelection = "google_esign"; G.__89A.wfCalls = []
  const e2 = await run()
  ok("Google eSignature SELECTED → the manual-send rail (skipped, bell names Drive + Request signature); the resolver is not asked",
    e2.res.providerKey === "google_esign" && e2.res.status === "skipped" && G.__89A.wfCalls.length === 0 && (e2.db as any).tables.notifications.some((n: any) => /Google eSignature/.test(n.title) && /Request signature/.test(n.body)), JSON.stringify(e2.res))
  G.__89A.wfSelection = DEF; G.__89A.wfResolved = null; G.__89A.wfCalls = []
  const e3 = await run()
  ok("selected/default provider unresolvable → error naming it (fail closed), nothing sent",
    e3.res.status === "error" && /DocuSign/.test(String(e3.res.error)) && G.__89A.wfCalls.length === 0, JSON.stringify(e3.res))
  stubResolverForWorkflow = false

  // ── F · sources ──────────────────────────────────────────────────────────────────
  console.log("\n[F · sources: no silent vendor default; the ONE constant everywhere; the retired iteration is gone]")
  const SILENT_VENDOR = /esign:\s*["'](dotloop|docusign|google_esign)["']|provider_name\s*\?\?\s*["']dotloop["']|provider_key:\s*["'](dotloop|google_esign)["']\s*\}|default:\s*["'](dotloop|google_esign)["']/
  const NAMED = [
    "lib/kernel/providers.ts", "lib/kernel/forms.ts", "app/dashboard/settings/integrations/integrations-client.tsx",
    "app/dashboard/admin/components/os/provider-intelligence-panel.tsx", "lib/workflow/adapters/send-for-esign.ts",
    "lib/integrations/resolve-esign-provider.ts", "app/actions/settings/provider-settings-actions.ts",
  ]
  const hits = NAMED.filter((f) => SILENT_VENDOR.test(code(f)))
  ok(`0 of ${NAMED.length} resolution/settings/UI sources hard-code an e-sign vendor as the default`, hits.length === 0, hits.join(", "))
  for (const specimen of [`  esign:        "dotloop",`, `  esign: "google_esign",`, `const providerName = providerResult.data?.provider_name ?? "dotloop"`, `{ type: "esign", label: "E-Sign", default: "dotloop" },`]) {
    ok(`POSITIVE CONTROL: the finder recognises the retired shape ${specimen.trim().slice(0, 40)}…`, SILENT_VENDOR.test(specimen))
  }
  ok("SYSTEM_DEFAULTS.esign (kernel + settings mirror) read the ONE catalog constant",
    /esign:\s*DEFAULT_ESIGN_PROVIDER/.test(code("lib/kernel/providers.ts")) && /esign:\s*DEFAULT_ESIGN_PROVIDER/.test(code("app/actions/settings/provider-settings-actions.ts")))
  const res = code("lib/integrations/resolve-esign-provider.ts")
  const RETIRED_ITERATION = /providersToTry\s*=\s*preferredPlatform\s*\?\s*\[preferredPlatform\]\s*:\s*SUPPORTED_PLATFORMS/
  ok("POSITIVE CONTROL: the finder recognises the retired 'iterate every connected vendor' shape",
    RETIRED_ITERATION.test(`const providersToTry = preferredPlatform ? [preferredPlatform] : SUPPORTED_PLATFORMS`))
  ok("the resolver no longer iterates SUPPORTED_PLATFORMS for a credential — one provider, from the selection or the default",
    !RETIRED_ITERATION.test(res) && /selection\.pick \|\| DEFAULT_ESIGN_PROVIDER/.test(res) && /resolveScopedConnection\(providerName, scopeCtx\)/.test(res))
  ok("the resolver's supported set derives from the catalog (getEsignProviders), not a hand list", /SUPPORTED_PLATFORMS:\s*string\[\]\s*=\s*getEsignProviders\(\)/.test(res))
  ok("the platform account is the default's LAST rung, gated on isDefault", /isDefault && providerName === DEFAULT_ESIGN_PROVIDER/.test(res) && res.indexOf("resolveScopedConnection(providerName, scopeCtx)") < res.indexOf("resolvePlatformDocusignCredential()"))
  const sfe = code("lib/workflow/adapters/send-for-esign.ts")
  ok("send-for-esign: WHICH = the e-sign selection; WHOSE = the resolver (no TM same-vendor read)",
    /resolveTenantProvider\(\{\s*providerType: "esign"/.test(sfe) && /resolveESignProviderForActor\(\{ brokerageId, userId: agentUserId/.test(sfe) && !/resolveTransactionFormsProvider/.test(sfe))
  ok("POSITIVE CONTROL: the retired TM-drives-e-sign shape is recognised, and absent",
    /result\.data\.provider_name === entry\.name/.test(`if (result.success && result.data?.is_configured && result.data.provider_name === entry.name) {`) && !/result\.data\.provider_name === entry\.name/.test(sfe))
  const kf = code("lib/kernel/forms.ts")
  ok("kernel forms: launchEsignEnvelope + getEsignStatus resolve through the resolver, never the newest TM credential",
    (kf.match(/resolveESignProviderForActor\(\{ brokerageId: input\.brokerage_id \}\)/g) ?? []).length === 2 && !/resolveEsignProviderOrDefault\(providerResult/.test(kf))
  ok("webhook downloader names the vendor that SENT the envelope", /provider,\s*\n\s*\}\)/.test(code("lib/esign-webhooks/download-signed-package.ts")) || /userId:\s*actorUserId,\s*provider,/.test(code("lib/esign-webhooks/download-signed-package.ts")))
  ok("forms library: with nothing connected it offers the DEFAULT's window (from the constant, embedded copy when not portal-send)",
    /providerPortalMode\(DEFAULT_ESIGN_PROVIDER\)/.test(code("app/dashboard/forms/FormsLibraryClient.tsx")) && /getCatalogEntry\(DEFAULT_ESIGN_PROVIDER\)\?\.portalSend/.test(code("app/dashboard/forms/FormsLibraryClient.tsx")))
  ok("settings: the override menu and form open on the default", /getSelectableEsignProviders\(\)/.test(code("app/dashboard/settings/integrations/integrations-client.tsx")) && /provider_key: DEFAULT_ESIGN_PROVIDER/.test(code("app/dashboard/settings/integrations/integrations-client.tsx")))
  ok("onboarding: the required e-sign category is met by the default (no connection needed)", /typeConnected\.has\(t\) \|\| t === "esign"/.test(code("app/dashboard/onboarding/tech-stack/tech-stack-client.tsx")))
  ok("onboarding checklist copy names the DocuSign default and keeps the tenant's own account as the upgrade", /default, DocuSign/.test(code("lib/onboarding/setup-readiness.ts")) && /own DocuSign/.test(code("lib/onboarding/setup-readiness.ts")))
  const wiz = code("app/components/form-wizard/FormWizard.tsx")
  ok("FormWizard: Google is described as a SELECTION, the default as embedded", /Google eSignature \(your selection\)/.test(wiz) && !/Google eSignature \(your default\)/.test(wiz) && /platform default \(embedded\)/.test(wiz))
  ok("nothing still registers the retired proof (package.json script / guard chain, the registry KEY) — prose may name it as history",
    !/esign-google-default/.test(readFileSync(join(ROOT, "package.json"), "utf8")) && !/esign_google_default\s*:/.test(code("lib/kernel/manager-registry.ts")) && /esign_default_rule\s*:/.test(code("lib/kernel/manager-registry.ts")))

  console.log(`\n  scanned for a silent vendor default: ${NAMED.join(", ")}`)
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
  console.log(" ESIGN_DEFAULT_RULE_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
