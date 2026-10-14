#!/usr/bin/env tsx
/**
 * scripts/crm-boundaries-guard.ts   (npm run test:crm-boundaries)
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 141, lane 141D — THE CRM BOUNDARIES (owner, 2026-10-14, binding):
 *
 *   A · AIRTABLE IS RETIRED. No runtime identifier (lib/ app/ services/ components/) names it;
 *       the four legacy operational scripts are gone; the one schema remnant
 *       (global_settings.airtable_api_key) is dropped by m771 and no longer declared on the row
 *       type. POSITIVE CONTROL: the finder flags a fixture that reads AIRTABLE_API_KEY.
 *   B · OUTBOUND (tenant → their CRM) is TENANT-CONTROLLED: the connect/disconnect/status actions
 *       take the tenant from the SESSION (no body brokerageId), every gateway push is BOOKED to the
 *       tenant (api_response_logs.brokerage_id), the outcome is STAMPED on the tenant's own
 *       credential row and the settings page shows the provider's refusal with the fix; a
 *       provider the layer cannot dispatch is reported unsupported, never silently rerouted.
 *   C · INBOUND (external CRM → VIPAgents) is PLATFORM STAFF ONLY and runs the chain: staff
 *       authorization on platform_role (never a tenant admin, never the legacy user_type marker)
 *       → explicit mapping against the ONE registry → preview (dry run of the real lane) →
 *       validation (the registry's identity rule) → dedupe against the TARGET tenant → controlled
 *       commit (token-bound to the previewed mapping) → only THEN evidence + the kernel event.
 *       A tenant is refused with one clear sentence. No `...row` spread into a canonical insert.
 *   D · GHL + SMTP stay configured: the GHL sync-out path and its inbound no-op ack are intact,
 *       the SMTP columns are declared/read/protected, and there is NO mail transport in the tree
 *       (owner: "do NOT build an SMTP server").
 *
 * Reads STRIPPED source for every code-token assertion (CLAUDE.md §2 — a tombstone naming
 * Airtable is prose, not a reference) and blankStrings where a string literal would confuse the
 * parse. Every absence assertion carries a positive control. Rule, not waypoint: no date, no row
 * count, no chain position (membership regex), migration header accepts applied OR not-applied.
 *
 * BLIND SPOTS (published beside the numbers):
 *   · The Airtable identifier scan blanks STRING LITERALS, so a URL or env name held only in a
 *     string is invisible to it by design (a string is not an identifier the runtime resolves). The
 *     two deliberate string survivors (SNAPSHOT_FORBIDDEN_FIELDS) are asserted separately; a scan
 *     of scripts/ with strings kept covers the operational scripts.
 *   · HubSpot sync-out rides its official SDK adapter, which does not pass the connector gateway:
 *     its outcome IS stamped on the tenant's row, but it lands no api_response_logs row (wave 71A
 *     design; recorded, not hidden).
 *   · The behavioural lane runs on the in-memory client: PostgREST CHECKs (contacts_contact_type_check,
 *     lead_imports_status_check) are not exercised here — the live-schema vocabulary guards hold them.
 *
 * Run: NODE_OPTIONS="--max-old-space-size=6000" npx tsx scripts/crm-boundaries-guard.ts
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { registerHooks } from "node:module"
import { stripComments, blankStrings } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"
import { CRM_CONTACT_INGRESS_CONTRACT, CRM_CONTACT_INGRESS_IDENTITY_ANY_OF } from "../lib/kernel/schema-adaptation"
import { fubToRow, loftyToRow, ghlToRow, CRM_IMPORT_PROVIDERS, crmImportPreviewToken } from "../lib/crm/import-pull"
import { parseContactRecords, parseContactsCsv } from "../lib/platform/tenant-import-parser"
import { importParsedContacts } from "../lib/platform/tenant-import"

const ROOT = process.cwd()
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8")
const code = (p: string) => stripComments(raw(p))
const ids = (p: string) => blankStrings(stripComments(raw(p)))
let pass = 0
let fail = 0
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}

// The pure sync-outcome patch lives in lib/crm/sync.ts, whose import graph reaches the cookie
// client and the provider adapters. Stub the two supabase constructors + server-only so the
// module LOADS; nothing in this proof calls them (the stubs throw if anything does).
const STUB_BY_SPEC: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => { throw new Error('not used by this proof') }",
  "@/lib/supabase/server": "export const createClient = async () => { throw new Error('not used by this proof') }",
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const stub = STUB_BY_SPEC[spec]
    if (stub !== undefined) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

const NEVER_WALK = new Set(["node_modules", ".next", ".git", ".claude", "dist", "coverage"])
function walk(dir: string, out: string[] = []): string[] {
  let entries: string[] = []
  try { entries = readdirSync(dir) } catch { return out }
  for (const e of entries) {
    if (NEVER_WALK.has(e)) continue
    const p = join(dir, e)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e) && !e.endsWith(".d.ts")) out.push(p)
  }
  return out
}

const RUNTIME_ROOTS = ["lib", "app", "services", "components"].filter((d) => existsSync(join(ROOT, d)))
const runtimeFiles = RUNTIME_ROOTS.flatMap((d) => walk(join(ROOT, d)))

async function main() {
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[A · AIRTABLE — retired from runtime, with a positive control]")
  const airtableIdent = /airtable/i
  const airtableHits = runtimeFiles.filter((f) => airtableIdent.test(blankStrings(stripComments(readFileSync(f, "utf8"))))).map((f) => relative(ROOT, f))
  ok(`no runtime IDENTIFIER names Airtable across ${runtimeFiles.length} files in ${RUNTIME_ROOTS.join("/")} (found ${airtableHits.length})`,
    airtableHits.length === 0, airtableHits.join(", "))
  ok("POSITIVE CONTROL: the finder flags a module that reads AIRTABLE_API_KEY (identifier survives string-blanking)",
    airtableIdent.test(blankStrings(stripComments(`const key = process.env.AIRTABLE_API_KEY\nawait fetch("https://api.airtable.com/v0/x", { headers: { Authorization: key } })`))))
  ok("POSITIVE CONTROL (blind spot stated): a module holding Airtable ONLY in a string literal is NOT an identifier hit",
    !airtableIdent.test(blankStrings(stripComments(`const url = "https://api.airtable.com/v0/x"`))))
  const scriptFiles = walk(join(ROOT, "scripts")).map((f) => relative(ROOT, f))
    // Excluded: the generated cache, this guard, and the two CHECKERS that name the token in order to look for it
    // (lane 141J's crm-outbound canary + its probe registry) — a checker is not an operational path.
    .filter((f) => !/scripts\/schema-snapshot\.ts$/.test(f) && !/scripts\/crm-boundaries-guard\.ts$/.test(f) && !/scripts\/canaries\/(crm-outbound|_registry)\.ts$/.test(f))
  const scriptHits = scriptFiles.filter((f) => airtableIdent.test(stripComments(raw(f))))
  ok(`no operational script (strings kept, comments stripped) touches Airtable — ${scriptFiles.length} scripts scanned, schema-snapshot.ts (generated cache) + the two Airtable-retirement checkers excluded (found ${scriptHits.length})`,
    scriptHits.length === 0, scriptHits.join(", "))
  for (const gone of ["scripts/seed-test-contacts.ts", "scripts/011-migrate-airtable-to-supabase.ts", "scripts/migrate-airtable-imports.sh", "scripts/complete-migration.ts"]) {
    ok(`legacy Airtable operational path deleted: ${gone}`, !existsSync(join(ROOT, gone)))
  }
  ok("POSITIVE CONTROL: existsSync sees a file that IS there (scripts/crm-pull-simulator.ts)", existsSync(join(ROOT, "scripts/crm-pull-simulator.ts")))
  const pkg = raw("package.json")
  ok("package.json runs none of the deleted scripts", !/seed-test-contacts|011-migrate-airtable|migrate-airtable-imports|complete-migration/.test(pkg))
  ok("lib/migration-status.ts (the Airtable → Supabase record) names each deleted script's survivor",
    /seed-test-contacts\.ts[\s\S]*011-seed-test-contacts\.sql/.test(raw("lib/migration-status.ts")) && /crm-pull-actions\.ts/.test(raw("lib/migration-status.ts")))
  const gs = code("lib/kernel/global-settings.ts")
  ok("GlobalSettingsRow no longer declares airtable_api_key (no writer can target a dropped column)", !/^\s*airtable_api_key:/m.test(gs))
  ok("…and STILL declares the SMTP + from + GHL columns (configured paths untouched)",
    ["smtp_host", "smtp_port", "smtp_username", "smtp_password", "from_email", "from_name", "ghl_api_key"].every((c) => new RegExp(`^\\s*${c}:`, "m").test(gs)))
  const forbidden = code("lib/platform/config-snapshots.ts")
  ok("SNAPSHOT_FORBIDDEN_FIELDS keeps the NAME airtable_api_key (a historical payload is refused, never applied onto a dropped column)",
    /SNAPSHOT_FORBIDDEN_FIELDS\s*=\s*\[[^\]]*"airtable_api_key"/.test(forbidden) && /SNAPSHOT_FORBIDDEN_FIELDS\s*=\s*\[[^\]]*"smtp_password"/.test(forbidden))
  const m771s = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => /^m771-/.test(f))
  ok("m771 exists (exactly one)", m771s.length === 1, m771s.join(","))
  const m771 = m771s[0] ? raw(`supabase/migrations/${m771s[0]}`) : ""
  ok("m771's first line carries the lane stamp or the applied stamp (rule, not waypoint)", /^-- ── (WRITTEN, NOT APPLIED|APPLIED LIVE)/.test(m771))
  ok("m771 drops global_settings.airtable_api_key", /ALTER TABLE public\.global_settings DROP COLUMN IF EXISTS airtable_api_key;/.test(m771))
  const dropsOther = (sql: string) => /DROP COLUMN IF EXISTS (smtp_\w+|from_email|from_name|ghl_api_key)/.test(sql)
  ok("m771 drops NOTHING else — no SMTP / from / GHL column", !dropsOther(m771))
  ok("POSITIVE CONTROL: the other-column finder flags a mutated m771 that dropped smtp_host", dropsOther(m771 + "\nALTER TABLE public.global_settings DROP COLUMN IF EXISTS smtp_host;"))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[B · OUTBOUND — tenant-controlled, booked, errors actionable, unavailability honest]")
  const connect = code("app/actions/crm-connect.ts")
  const bodyTenant = /export async function \w+\s*\([^)]*\bbrokerageId\b/
  ok("crm-connect.ts: no exported action takes a body brokerageId — tenant from the SESSION (getAgentContext)",
    !bodyTenant.test(connect) && /getAgentContext\(\)/.test(connect))
  ok("POSITIVE CONTROL: the body-tenant finder flags an action that takes brokerageId", bodyTenant.test(`export async function x(input: { brokerageId: string }) {}`))
  ok("tenant credentials: connect writes agent_api_credentials (agent scope) or integration_credentials + brokerage_integrations (brokerage scope), encrypted",
    /from\("agent_api_credentials"\)\s*\.upsert/.test(connect) && /from\("integration_credentials"\)\s*\.upsert/.test(connect) && /api_key:\s*encryptSecret\(/.test(connect))
  const fub = code("lib/crm/providers/followupboss.ts")
  const lofty = code("lib/crm/providers/lofty.ts")
  const ghl = code("services/goHighLevelService.ts")
  const sync = code("lib/crm/sync.ts")
  ok("Follow Up Boss push is BOOKED to the tenant (callConnector brokerageId: scope.brokerageId)", /brokerageId:\s*scope\.brokerageId\s*\?\?\s*null/.test(fub))
  ok("Lofty push is BOOKED to the tenant", /brokerageId:\s*scope\.brokerageId\s*\?\?\s*null/.test(lofty))
  ok("GoHighLevel: the gateway call carries the config's brokerageId (tenant-credentialed = tenant-booked; env default = platform scope)", /brokerageId:\s*config\.brokerageId\s*\?\?\s*null/.test(ghl))
  ok("sync.ts hands the tenant scope to FUB/Lofty and the brokerageId into the tenant's GHL override",
    /syncContactToFollowUpBoss\(contact,\s*conn\?\.apiKey\s*\?\?\s*null,\s*scope\)/.test(sync) && /syncContactToLofty\(contact,[^)]*,\s*scope\)/.test(sync) && /ghlOverride\s*=\s*\{\s*apiKey:\s*conn\.apiKey,\s*locationId,\s*brokerageId\s*\}/.test(sync))
  ok("the four supported outbound providers are dispatched (ghl, followupboss, lofty, hubspot) and anything else is reported UNSUPPORTED (never rerouted)",
    /providerKey === "ghl"/.test(sync) && /providerKey === "followupboss" \|\| providerKey === "lofty" \|\| providerKey === "hubspot"/.test(sync) && /is not yet supported in the sync layer/.test(sync))
  ok("the egress gate still refuses a nameless/unreachable contact before any push", /validateEgress\(CRM_CONTACT_EGRESS_CONTRACT/.test(sync))
  ok("every dispatch stamps its outcome on the tenant's credential row (stampCrmSyncOutcome ×3: GHL, gateway providers, unsupported)",
    (sync.match(/await stampCrmSyncOutcome\(/g) ?? []).length >= 3)
  ok("the stamp READS its refusal and its row count (.select(\"id\") + error + zero-row log) — CLAUDE.md §3", /await q\.select\("id"\)/.test(sync) && /matched no row/.test(sync))
  const S = await import("../lib/crm/sync")
  const now = new Date("2026-10-14T12:00:00Z")
  const agentOk = S.crmSyncOutcomePatch("agent_api_credentials", { success: true }, now)
  ok("PURE: agent-scope success → error_message cleared, is_verified true, last_verified_at stamped",
    agentOk?.error_message === null && agentOk?.is_verified === true && agentOk?.last_verified_at === now.toISOString(), JSON.stringify(agentOk))
  const agentBad = S.crmSyncOutcomePatch("agent_api_credentials", { success: false, error: "401 invalid key" }, now)
  ok("PURE: agent-scope failure → error_message carries the provider's refusal, is_verified NOT demoted", agentBad?.error_message === "401 invalid key" && !("is_verified" in (agentBad ?? {})), JSON.stringify(agentBad))
  const brkBad = S.crmSyncOutcomePatch("brokerage_integrations", { success: false, error: "503 upstream" }, now)
  ok("PURE: brokerage-scope failure → last_error + last_health_check_at, and NEVER a status flip (a transient push must not demote the tenant's CRM)",
    brkBad?.last_error === "503 upstream" && brkBad?.last_health_check_at === now.toISOString() && !("status" in (brkBad ?? {})), JSON.stringify(brkBad))
  const pcOk = S.crmSyncOutcomePatch("platform_credentials", { success: true }, now)
  ok("PURE: Connection-Center scope success → sync_error null + last_synced_at", pcOk?.sync_error === null && pcOk?.last_synced_at === now.toISOString())
  ok("PURE: 'nothing connected' (requiresConfiguration) writes NOTHING — it is not a failure of a connection",
    S.crmSyncOutcomePatch("agent_api_credentials", { success: false, requiresConfiguration: true, error: "not connected" }, now) === null)
  ok("PURE: a provider error is bounded to 500 chars on the row", (S.crmSyncOutcomePatch("platform_credentials", { success: false, error: "x".repeat(900) }, now)?.sync_error as string).length === 500)
  ok("getCrmStatusAction returns lastError + lastSyncedAt from the credential row (agent: error_message/last_verified_at; brokerage: last_error/last_health_check_at)",
    /lastError:\s*\(activeRow\?\.error_message/.test(connect) && /lastError:\s*\(active\?\.last_error/.test(connect) && /select\("provider_name, status, last_error, last_health_check_at"\)/.test(connect))
  const form = code("app/settings/crm/crm-connect-form.tsx")
  ok("the tenant's settings form shows the refusal WITH the fix (update the key / disconnect) — actionable, never hidden",
    /Last sync to \{p\.label\} failed/.test(form) && /\{lastError\}/.test(form) && /Update \+ set active/.test(form) && /disconnect this CRM/.test(form))
  ok("…and the page passes it through", /lastError=\{status\.lastError\}/.test(code("app/settings/crm/page.tsx")))
  ok("tenant-facing CRM copy never says \"platform-covered\"", !/platform-covered/i.test(form) && !/platform-covered/i.test(code("app/settings/crm/page.tsx")) && !/platform-covered/i.test(code("app/dashboard/admin/import/page.tsx")))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[C · INBOUND — platform staff only, mapped, previewed, validated, deduped, controlled commit, only then events]")
  const pull = code("app/actions/lead-import/crm-pull-actions.ts")
  const pullIds = ids("app/actions/lead-import/crm-pull-actions.ts")
  ok("ONE inbound rule over the ONE staff gate: inboundImportGate(await gateStaffAction(\"tenants\")) refuses a null platform_role (legacy user_type marker)",
    /function inboundImportGate\(gate: StaffGate\): StaffGate/.test(pull) && /if \(!gate\.platformRole\) return \{ ok: false, error: INBOUND_IMPORT_LEGACY_MARKER_REFUSAL \}/.test(pull))
  const exported = [...pull.matchAll(/export async function (\w+)\(/g)].map((m) => m[1])
  const gated = exported.filter((fn) => {
    const start = pull.indexOf(`export async function ${fn}(`)
    const next = pull.indexOf("export async function", start + 1)
    const body = pull.slice(start, next < 0 ? undefined : next)
    const gateAt = body.indexOf('inboundImportGate(await gateStaffAction("tenants"))')
    const svcAt = body.indexOf("createServiceClient()")
    // The gate call is IN the body, and BEFORE the first service-client use (or there is none).
    return gateAt >= 0 && (svcAt < 0 || gateAt < svcAt)
  })
  ok(`every exported inbound door is behind that gate (${gated.length}/${exported.length}: ${exported.join(", ")})`, exported.length >= 4 && gated.length === exported.length)
  const superadminIdent = /\bsuperadmin\b|user_type/
  ok("crm-pull-actions.ts never spells superadmin or user_type in code (identifiers; strings blanked)", !superadminIdent.test(pullIds))
  ok("POSITIVE CONTROL: the finder flags a gate written on user_type", superadminIdent.test(blankStrings(stripComments(`if (profile.user_type === "superadmin") admit()`))))
  ok("a TENANT is refused with ONE clear sentence (names who runs it and that their own CRM link is OUT only)",
    /INBOUND_IMPORT_TENANT_REFUSAL\s*=/.test(pull) && /run by VIPAgents staff during your onboarding/.test(pull) && /syncs contacts OUT to your CRM only/.test(pull) && /INBOUND_IMPORT_TENANT_REFUSAL \}/.test(pull))
  ok("the staff gate exposes the RAW platform_role beside the resolved role", /platformRole:\s*\(\(profile as \{ platform_role\?: string \| null \} \| null\)\?\.platform_role \?\? null\) \|\| null/.test(code("lib/platform/staff-action-gate.ts")))
  const gate = code("lib/platform/staff-action-gate.ts")
  ok("…and the gate itself reads platform_role (platformStaffCan over resolvePlatformRole), never a tenant-admin roster", /resolvePlatformRole\(profile/.test(gate) && /platformStaffCan\(role, capability\)/.test(gate) && !/TENANT_ADMIN_USER_TYPES/.test(gate))

  // The registry + the explicit mapping
  const parser = code("lib/platform/tenant-import-parser.ts")
  ok("the parser maps ONTO the ONE registry (CRM_CONTACT_INGRESS_CONTRACT) and enforces its identity rule (CRM_CONTACT_INGRESS_IDENTITY_ANY_OF)",
    /import \{ CRM_CONTACT_INGRESS_CONTRACT, CRM_CONTACT_INGRESS_IDENTITY_ANY_OF \} from "@\/lib\/kernel\/schema-adaptation"/.test(parser) &&
    /CANONICAL_IMPORT_FIELDS\.has\(key\)/.test(parser) && /CRM_CONTACT_INGRESS_IDENTITY_ANY_OF\.find\(/.test(parser))
  const handRule = /!firstName && !lastName && !email && !phoneDigits/
  ok("the identity rule is no longer hand-written in the parser", !handRule.test(parser))
  ok("POSITIVE CONTROL: the hand-rule finder recognises the old text", handRule.test(`if (!firstName && !lastName && !email && !phoneDigits) return x`))
  const registryKeys = new Set(CRM_CONTACT_INGRESS_CONTRACT.fields.map((f) => f.key))
  const aliasTargets = new Set([...parser.matchAll(/^\s*[\w]+:\s*"([a-z_]+)"/gm)].map((m) => m[1]).filter((v) => !/^(list_price|listing_date|mls_number)$/.test(v)))
  // The alias map literal holds `spelling: "canonical"` pairs; listing aliases are excluded by name.
  ok(`registry ⟷ parser agree: every alias target is a registry field (${[...aliasTargets].filter((t) => !registryKeys.has(t)).join(",") || "none missing"})`,
    [...aliasTargets].every((t) => registryKeys.has(t)) && aliasTargets.size > 0)
  ok(`…and every registry field has an alias (${[...registryKeys].filter((k) => !aliasTargets.has(k)).join(",") || "none missing"})`, [...registryKeys].every((k) => aliasTargets.has(k)))
  ok("the registry names NO consent field (TCPA consent is earned on our rail, never imported)", ![...registryKeys].some((k) => /consent|tcpa|opt/.test(k)))
  ok("the registry sits beside the EGRESS contract in the same file (one home for both directions)", /CRM_CONTACT_EGRESS_CONTRACT/.test(code("lib/kernel/schema-adaptation.ts")) && /CRM_CONTACT_INGRESS_CONTRACT/.test(code("lib/kernel/schema-adaptation.ts")))
  ok("the identity any-of group names first_name/last_name/full_name/email/phone", CRM_CONTACT_INGRESS_IDENTITY_ANY_OF[0].slice().sort().join(",") === "email,first_name,full_name,last_name,phone")
  const noIdentity = parseContactRecords([{ City: "Austin", Notes: "x" }])
  ok("VALIDATION: a row with no identity is rejected with the registry's names", noIdentity.rows.length === 0 && noIdentity.errors.length === 1 && /needs one of: first_name, last_name, full_name, email, phone/.test(noIdentity.errors[0].problem))
  ok("VALIDATION: a 5-digit phone is not identity; a 7-digit one is",
    parseContactRecords([{ Phone: "12345" }]).rows.length === 0 && parseContactRecords([{ Phone: "5551234" }]).rows.length === 1)
  ok("parseContactsCsv (the CSV half) reports the same explicit mapping table",
    JSON.stringify(parseContactsCsv("First Name,Email,Mystery\nDana,d@x.com,1").mapping) === JSON.stringify({ "First Name": "first_name", Email: "email" }))

  // The mappers emit ONLY registry-resolvable keys; vendor enums ride Notes as text.
  const fubRow = fubToRow({ firstName: "Dana", lastName: "K", emails: [{ value: "d@x.com" }], phones: [{ value: "+15551234567" }], addresses: [{ street: "1 Main", city: "Austin", state: "TX", code: "78701" }], stage: "Buyer", source: "Zillow", tags: ["hot", "sphere"] })
  const loftyRow = loftyToRow({ first_name: "C", last_name: "D", emails: ["c@d.com"], phones: ["+15551111111"], zipCode: "78703", stage: "Nurture", leadType: "Seller", source: "Open house", tags: ["past client"] })
  const ghlRow = ghlToRow({ firstName: "E", lastName: "F", email: "e@f.com", phone: "+15552222222", postalCode: "78704", type: "lead", source: "Facebook", tags: ["seller"] })
  for (const [name, row] of [["fubToRow", fubRow], ["loftyToRow", loftyRow], ["ghlToRow", ghlRow]] as const) {
    const p = parseContactRecords([row])
    ok(`${name}: EVERY emitted key maps onto a registry field (unmapped: ${p.unmappedHeaders.join(",") || "none"}); row is importable`,
      p.unmappedHeaders.length === 0 && Object.keys(p.mapping).length === Object.keys(row).length && p.rows.length === 1)
  }
  const vendorKeyed = parseContactRecords([{ "First Name": "A", "FUB Tags": "hot", Type: "Buyer" }])
  ok("POSITIVE CONTROL: a vendor-keyed row (\"FUB Tags\", \"Type\") is NOT mapped — the keys surface as ignored", vendorKeyed.unmappedHeaders.sort().join(",") === "FUB Tags,Type")
  const fubParsed = parseContactRecords([fubRow]).rows[0]
  ok("vendor context preserved, never trusted: FUB stage → notes TEXT, tags → tags, source → the old CRM's source label",
    /Follow Up Boss stage: Buyer/.test(fubParsed.notes ?? "") && (fubParsed.tags ?? []).join(",") === "hot,sphere" && fubParsed.source === "Zillow")
  ok("Lofty lead type + stage → notes text (a vendor enum is never a canonical enum)", /Lofty lead type: Seller/.test(parseContactRecords([loftyRow]).rows[0].notes ?? "") && /Lofty stage: Nurture/.test(parseContactRecords([loftyRow]).rows[0].notes ?? ""))
  ok("no mapper emits a consent key", [fubRow, loftyRow, ghlRow].every((r) => !Object.keys(r).some((k) => /consent|tcpa|opt[_ ]?in/i.test(k))))
  ok("inbound providers are exactly followupboss/lofty/gohighlevel (HubSpot is sync-out only)", CRM_IMPORT_PROVIDERS.slice().sort().join(",") === "followupboss,gohighlevel,lofty")

  // Preview + controlled commit
  ok("PREVIEW action exists, runs the real lane as a DRY RUN (nothing written) and hands back mapping, ignored keys, counts, sample and the token",
    /export async function previewCrmImportAction\(/.test(pull) && /dryRun: true/.test(pull) && /mapping,\s*ignoredKeys: parsed\.unmappedHeaders,/.test(pull) && /previewToken,\s*\}\s*$/m.test(pull) && /sample: parsed\.rows\.slice\(0, PREVIEW_SAMPLE_ROWS\)/.test(pull))
  ok("preview is audited (crm_import_previewed)", /auditStaffAction\(gate, "crm_import_previewed"/.test(pull))
  const runBody = pull.slice(pull.indexOf("export async function runCrmImportAction("), pull.indexOf("export async function getCrmImportStatusAction("))
  ok("COMMIT refuses without a preview token, recomputes it from the FIRST page and refuses a mismatch BEFORE importParsedContacts",
    /if \(!input\.previewToken\)/.test(runBody) && runBody.indexOf("crmImportPreviewToken(") < runBody.indexOf("await importParsedContacts(") && /expected !== input\.previewToken/.test(runBody) && /preview again before importing/.test(runBody))
  ok("ONLY THEN: the lead_imports evidence row and LEAD_IMPORT_COMPLETED come AFTER the commit (source order), with the provider named",
    runBody.indexOf("await importParsedContacts(") < runBody.indexOf('.from("lead_imports")') && runBody.indexOf('.from("lead_imports")') < runBody.indexOf("KernelEvent.LEAD_IMPORT_COMPLETED") && /source: "crm_pull"/.test(runBody) && /emitKernelEvent\(\{/.test(runBody))
  ok("the evidence row is the SAME ledger the tenant's own CSV import writes (status completed|failed, counts, field_map)", /field_map: mappingSeen/.test(runBody) && /status: created > 0 \|\| !pullError \? "completed" : "failed"/.test(runBody))
  const tok = crmImportPreviewToken({ provider: "followupboss", brokerageId: "b1", mapping: { Email: "email", "First Name": "first_name" }, ignoredKeys: ["Type"] })
  ok("PURE token: deterministic + order-independent over the mapping", tok === crmImportPreviewToken({ provider: "followupboss", brokerageId: "b1", mapping: { "First Name": "first_name", Email: "email" }, ignoredKeys: ["Type"] }) && /^pv1-[0-9a-f]{16}$/.test(tok))
  ok("PURE token: a different tenant, provider, mapping or ignored key changes it",
    tok !== crmImportPreviewToken({ provider: "followupboss", brokerageId: "b2", mapping: { Email: "email", "First Name": "first_name" }, ignoredKeys: ["Type"] }) &&
    tok !== crmImportPreviewToken({ provider: "lofty", brokerageId: "b1", mapping: { Email: "email", "First Name": "first_name" }, ignoredKeys: ["Type"] }) &&
    tok !== crmImportPreviewToken({ provider: "followupboss", brokerageId: "b1", mapping: { Email: "email" }, ignoredKeys: ["Type"] }) &&
    tok !== crmImportPreviewToken({ provider: "followupboss", brokerageId: "b1", mapping: { Email: "email", "First Name": "first_name" }, ignoredKeys: [] }))
  const panel = code("app/dashboard/superadmin/brokerages/[id]/tenant-crm-pull-panel.tsx")
  ok("the staff panel previews first and only enables Import with a token in hand (mapping table + ignored keys rendered)",
    /previewCrmImportAction\(/.test(panel) && /disabled=\{pending \|\| !preview\?\.previewToken\}/.test(panel) && /previewToken: preview\.previewToken/.test(panel) && /Field mapping/.test(panel) && /preview\.ignoredKeys/.test(panel))
  ok("the tenant's import page tells the truth: staff run it after preview, three providers, HubSpot NOT offered inbound",
    /run by VIPAgents staff/.test(code("app/dashboard/admin/import/page.tsx")) && /Follow Up Boss,\s*Lofty or GoHighLevel/.test(code("app/dashboard/admin/import/page.tsx")) && !/HubSpot or GoHighLevel/.test(code("app/dashboard/admin/import/page.tsx")))

  // No spread into a canonical insert
  const spreadInsert = /\.insert\(\s*\{\s*\.\.\./
  const rowsInsert = /\.insert\(\s*(?:page\.rows|rows|records|parsed\.rows|input\.rows)\b/
  for (const f of ["lib/platform/tenant-import.ts", "lib/crm/import-pull.ts", "app/actions/lead-import/crm-pull-actions.ts"]) {
    const s = ids(f)
    ok(`${f}: no \`...row\` spread and no vendor-rows array handed to .insert() — external schemas never write canonical fields directly`, !spreadInsert.test(s) && !rowsInsert.test(s))
  }
  ok("POSITIVE CONTROL: the spread finders flag `.insert({ ...row })` and `.insert(page.rows)`", spreadInsert.test(`svc.from("contacts").insert({ ...row, brokerage_id })`) && rowsInsert.test(`svc.from("contacts").insert(page.rows)`))
  const ti = code("lib/platform/tenant-import.ts")
  ok("the contacts payload is a LITERAL with the tenant anchor, agents.id owner, source 'import' and tcpa_consent: false",
    /brokerage_id: brokerageId,/.test(ti) && /agent_id: agent\.agentId,/.test(ti) && /source: "import",/.test(ti) && /tcpa_consent: false,/.test(ti) && /source_subtype: r\.source,/.test(ti))
  ok("importParsedContacts has the dryRun seam: stops BEFORE insertInBatches and reports wouldInsert", /if \(params\.dryRun\) \{/.test(ti) && ti.indexOf("if (params.dryRun) {") < ti.indexOf("await insertInBatches(svc, \"contacts\", payloads)") && /wouldInsert: payloads\.length/.test(ti))

  // Behavioural: the lane on the in-memory client — preview writes nothing, commit lands canonical columns only.
  const BRK = "11111111-1111-4111-8111-111111111111"
  const OTHER = "22222222-2222-4222-8222-222222222222"
  const AG = "a1000000-0000-4000-8000-000000000001"
  const seed = () => memSupabase({
    brokerages: [{ id: BRK }],
    agents: [{ id: AG, brokerage_id: BRK, is_active: true, created_at: "2026-01-01T00:00:00Z" }],
    contacts: [{ id: "c1000000-0000-4000-8000-000000000001", brokerage_id: BRK, email: "dup@x.com", phone_digits: "5550000000", deleted_at: null }],
  }, { uuidIds: true })
  const pageRows = [
    fubToRow({ firstName: "Dup", lastName: "Licate", emails: [{ value: "DUP@x.com" }], phones: [], stage: "Past" }),
    fubToRow({ firstName: "Dana", lastName: "K", emails: [{ value: "d@x.com" }], phones: [{ value: "+15551234567" }], addresses: [{ city: "Austin", state: "TX" }], stage: "Buyer", source: "Zillow", tags: ["hot"] }),
    { City: "Nowhere" },
  ]
  const parsed = parseContactRecords(pageRows)
  ok("the page parses to 2 importable rows + 1 validation problem (position 3)", parsed.rows.length === 2 && parsed.errors.length === 1 && parsed.errors[0].line === 3)
  const svc1 = seed()
  const dry = await importParsedContacts({ svc: svc1, brokerageId: BRK, dedupe: "email_phone", parsed, dryRun: true, emptyLabel: "fub page" })
  ok("DRY RUN: tenant verified, owner agent resolved, dedupe scanned — 1 would import, 1 would skip (email match, case-insensitive), 0 inserted",
    dry.ok && dry.dryRun === true && dry.wouldInsert === 1 && dry.skippedDuplicates === 1 && dry.inserted === 0 && dry.agentId === AG, JSON.stringify(dry))
  ok("DRY RUN wrote NOTHING to contacts", !svc1.writes.some((w) => w.table === "contacts") && svc1.tables.contacts.length === 1)
  const real = await importParsedContacts({ svc: svc1, brokerageId: BRK, dedupe: "email_phone", parsed, emptyLabel: "fub page" })
  const landed = svc1.tables.contacts.find((c) => c.email === "d@x.com")
  ok("COMMIT: the same lane lands exactly the 1 new row, anchored to the TARGET tenant + owner agent", real.ok && real.inserted === 1 && real.skippedDuplicates === 1 && landed?.brokerage_id === BRK && landed?.agent_id === AG, JSON.stringify(real))
  ok("…with CANONICAL columns only (no vendor key reaches the row), consent false, vendor context in notes/tags/source_subtype",
    !!landed && Object.keys(landed).every((k) => /^[a-z_]+$/.test(k)) && landed.tcpa_consent === false && landed.source === "import" && landed.source_subtype === "Zillow" &&
    /Follow Up Boss stage: Buyer/.test(landed.notes ?? "") && (landed.tags ?? []).join(",") === "hot", landed ? Object.keys(landed).join(",") : "no row")
  const wrong = await importParsedContacts({ svc: seed(), brokerageId: OTHER, dedupe: "email_phone", parsed })
  ok("FAIL CLOSED: an unknown target tenant is refused before any dedupe or insert", !wrong.ok && /Brokerage not found/.test(wrong.error ?? "") && wrong.inserted === 0)
  const refused = memSupabase({ brokerages: [{ id: BRK }], agents: [{ id: AG, brokerage_id: BRK, is_active: true }] }, { refuse: { contacts: "permission denied for table contacts" } })
  const r2 = await importParsedContacts({ svc: refused, brokerageId: BRK, dedupe: "email_phone", parsed, dryRun: true })
  ok("a REFUSED dedupe scan is returned as the error (supabase-js resolves refusals; the lane reads them)", !r2.ok && /permission denied/.test(r2.error ?? ""))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[D · GHL + SMTP — configured paths intact, no mail transport built]")
  ok("GHL sync-out: lib/crm/sync.ts dispatches providerKey 'ghl' to syncContactToGHL (services/goHighLevelService.ts) through the connector gateway",
    /syncContactToGHL\(\{/.test(sync) && /import \{ syncContactToGHL \} from "@\/services\/goHighLevelService"/.test(sync) && /connector: "gohighlevel"/.test(ghl) && /callConnector\(/.test(ghl))
  const ghlWebhook = code("app/api/webhooks/gohighlevel/route.ts")
  ok("GHL inbound webhook acks and ingests NOTHING (sync-out only): no contacts write in the route", /sync-out only/.test(ghlWebhook) && !/\.from\(\s*["']contacts["']\s*\)/.test(ghlWebhook))
  ok("the tenant's own GHL credential still resolves through the scoped cascade (resolveScopedConnection(\"ghl\"))", /resolveScopedConnection\("ghl"/.test(sync))
  const mailTransport = /\b(nodemailer|createTransport|SMTPServer|smtp-server|createSecureServer)\b/
  const transportHits = runtimeFiles.filter((f) => mailTransport.test(blankStrings(stripComments(readFileSync(f, "utf8"))))).map((f) => relative(ROOT, f))
  ok(`NO SMTP server / mail transport in the runtime tree (${transportHits.length} found across ${runtimeFiles.length} files)`, transportHits.length === 0, transportHits.join(", "))
  ok("POSITIVE CONTROL: the transport finder flags nodemailer.createTransport", mailTransport.test(blankStrings(stripComments(`const t = nodemailer.createTransport({ host })`))))
  ok("package.json declares no nodemailer / smtp-server dependency", !/"(nodemailer|smtp-server)"\s*:/.test(pkg))
  ok("SMTP settings are READ as the email-provider signal by onboarding readiness (setup-readiness + critical-setup: from_email || smtp_host)",
    /g\.from_email \|\| g\.smtp_host/.test(code("lib/onboarding/setup-readiness.ts")) && /g\.from_email \|\| g\.smtp_host/.test(code("lib/onboarding/critical-setup.ts")))
  ok("SMTP secrets stay protected from snapshots (smtp_password/username/host/port in SNAPSHOT_FORBIDDEN_FIELDS)",
    ["smtp_password", "smtp_username", "smtp_host", "smtp_port"].every((c) => new RegExp(`SNAPSHOT_FORBIDDEN_FIELDS\\s*=\\s*\\[[^\\]]*"${c}"`).test(forbidden)))
  ok("the one outbound email sender contract is lib/providers/outbound-sender.ts (OutboundSender: tenant_credential | platform_env | agent_mailbox), untouched by this lane",
    existsSync(join(ROOT, "lib/providers/outbound-sender.ts")) && /export interface OutboundSender/.test(code("lib/providers/outbound-sender.ts")) && /"tenant_credential" \| "platform_env" \| "agent_mailbox"/.test(code("lib/providers/outbound-sender.ts")))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[registration]")
  const dom = MAINTENANCE_DOMAINS["crm_boundaries"]
  ok("MAINTENANCE_DOMAINS.crm_boundaries is owned by data_steward with compliance_officer as co-owner, named in prose",
    dom?.manager === "data_steward" && (dom?.coOwners ?? []).includes("compliance_officer") && /compliance_officer|Compliance Officer/.test(dom?.what ?? ""))
  ok("its proof is this script's npm target", dom?.proof === "test:crm-boundaries")
  ok("package.json wires the proof and the guard chain runs it (membership, not position)", /"test:crm-boundaries":\s*"tsx scripts\/crm-boundaries-guard\.ts"/.test(pkg) && new RegExp("npm run test:crm-boundaries(\\s|&|$)").test(pkg))

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  console.log(fail === 0 ? " ✅ CRM_BOUNDARIES_PASS — Airtable retired; outbound is the tenant's; inbound is staff-only, mapped, previewed, committed under control" : " ❌ CRM_BOUNDARIES_FAIL")
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
