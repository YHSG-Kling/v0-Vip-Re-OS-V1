#!/usr/bin/env tsx
/**
 * scripts/secrets-rls-guard.ts   (npm run test:secrets-rls)
 * ─────────────────────────────────────────────────────────────────────────────
 * RLS + SECRETS FAIL CLOSED (wave 139E; owner "approve all" 1+2).
 *
 *  R1  the migration that creates the `ensure_rls` event trigger reproduces the live backstop:
 *      CREATE OR REPLACE public.rls_auto_enable() (event_trigger, SECURITY DEFINER, ENABLE ROW
 *      LEVEL SECURITY on public CREATE TABLE / CREATE TABLE AS / SELECT INTO) + the event trigger
 *      created ONLY when pg_event_trigger has none (no DROP). Found by CONTENT, not by number.
 *  R2  RLS-enabled implies no broad grant: that migration carries no GRANT / POLICY / DISABLE RLS.
 *  S1  a missing key REFUSES a new secret write (typed SecretStorageRefusedError, no plaintext
 *      returned, no secret in the message); legacy plaintext + existing envelopes still read and
 *      are never rewritten; dual-key read (current + previous) for rotation.
 *  S2  the refusal is ACTIONABLE: the OAuth refresh refuses BEFORE the provider exchange and the
 *      platform incident is raised with no secret in it (injected client); crm-connect raises it.
 *  S3  a secret never appears in an event/ledger payload (planted-secret positive control) and the
 *      two audit sinks route through the redactor; console census over lib/ + app/.
 *  S4  a tenant cannot read another tenant's secret through the canonical resolver.
 *  S5  a custom manager / extension cannot request an undeclared secret or capability (the ONE
 *      extension lifecycle path: skill-registry validators + requestExtensionCapability).
 *  REG package.json + guard chain + MAINTENANCE_DOMAINS.
 * No network. Scans read stripped source (scripts/strip-comments.ts, scripts/strip-sql-comments.ts).
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import { stripSqlComments } from "./strip-sql-comments"

let pass = 0, fail = 0
const check = (n: string, c: boolean, detail = "") => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) } }
const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
const code = (p: string) => stripComments(read(p))

// ── R1 / R2 — the RLS backstop migration ──────────────────────────────────────────────────────
function rlsMigrationFaults(sql: string): string[] {
  const s = stripSqlComments(sql)
  const faults: string[] = []
  if (!/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.rls_auto_enable\s*\(\s*\)\s*RETURNS\s+event_trigger/i.test(s)) faults.push("function not CREATE OR REPLACE public.rls_auto_enable() RETURNS event_trigger")
  if (!/SECURITY\s+DEFINER/i.test(s)) faults.push("function not SECURITY DEFINER")
  if (!/enable\s+row\s+level\s+security/i.test(s)) faults.push("function does not enable row level security")
  for (const tag of ["CREATE TABLE", "CREATE TABLE AS", "SELECT INTO"]) if (!s.includes(`'${tag}'`)) faults.push(`tag ${tag} missing`)
  if (!/IN\s*\(\s*'public'\s*\)/i.test(s)) faults.push("public schema not enforced")
  const create = s.search(/CREATE\s+EVENT\s+TRIGGER\s+ensure_rls\s+ON\s+ddl_command_end[\s\S]*?EXECUTE\s+FUNCTION\s+public\.rls_auto_enable\s*\(\s*\)/i)
  if (create < 0) faults.push("CREATE EVENT TRIGGER ensure_rls ON ddl_command_end … EXECUTE FUNCTION public.rls_auto_enable() missing")
  const guard = s.search(/IF\s+NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+(pg_catalog\.)?pg_event_trigger\s+WHERE\s+evtname\s*=\s*'ensure_rls'\s*\)\s*THEN/i)
  if (guard < 0 || (create >= 0 && guard > create)) faults.push("no pg_event_trigger existence check before CREATE EVENT TRIGGER (not idempotent)")
  if (/\bDROP\s+(EVENT\s+TRIGGER|FUNCTION|POLICY|TABLE|INDEX)\b/i.test(s)) faults.push("contains a DROP (held by the MCP for the owner)")
  return faults
}
function broadGrantFaults(sql: string): string[] {
  const s = stripSqlComments(sql)
  const out: string[] = []
  if (/\bGRANT\s/i.test(s)) out.push("GRANT")
  if (/\b(CREATE|ALTER)\s+POLICY\b/i.test(s)) out.push("POLICY")
  if (/DISABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(s)) out.push("DISABLE RLS")
  if (/\bTO\s+(anon|authenticated|public)\b/i.test(s)) out.push("TO anon/authenticated/public")
  return out
}

function rlsLayer() {
  console.log("\n[R1/R2 — automatic new-table RLS captured idempotently, no broad grant]")
  const dir = "supabase/migrations"
  const owners = readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".sql"))
    .filter((f) => /CREATE\s+EVENT\s+TRIGGER\s+ensure_rls\b/i.test(stripSqlComments(read(`${dir}/${f}`))))
  check("exactly ONE migration creates the ensure_rls event trigger", owners.length === 1, owners.join(", ") || "none")
  if (owners.length !== 1) return
  const file = `${dir}/${owners[0]}`
  const sql = read(file)
  const head = sql.split("\n")[0]
  check("header is the lane stamp or an APPLIED LIVE stamp", /WRITTEN, NOT APPLIED|APPLIED LIVE/.test(head), head)
  const faults = rlsMigrationFaults(sql)
  check(`${owners[0]} reproduces the live function + trigger with an idempotency guard`, faults.length === 0, faults.join("; "))
  const grants = broadGrantFaults(sql)
  check(`${owners[0]} grants nothing and writes no policy`, grants.length === 0, grants.join(", "))
  // positive controls — the finders still see the defects they exist for
  const unguarded = sql.replace(/IF\s+NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+pg_catalog\.pg_event_trigger\s+WHERE\s+evtname\s*=\s*'ensure_rls'\s*\)\s*THEN/i, "IF true THEN")
  check("CONTROL: removing the existence check is caught", rlsMigrationFaults(unguarded).some((f) => /idempotent/.test(f)))
  check("CONTROL: a DROP EVENT TRIGGER is caught", rlsMigrationFaults(sql + "\nDROP EVENT TRIGGER ensure_rls;").some((f) => /DROP/.test(f)))
  check("CONTROL: a planted GRANT / POLICY is caught", broadGrantFaults(sql + "\nGRANT ALL ON t TO anon;\nCREATE POLICY p ON t FOR ALL USING (true);").length >= 2)
  check("CONTROL: a GRANT inside a comment is NOT counted (stripped)", broadGrantFaults(sql + "\n-- GRANT ALL ON t TO anon").length === 0)
}

// ── S1 — secrets fail closed (pure) ───────────────────────────────────────────────────────────
async function cryptoLayer() {
  console.log("\n[S1 — a missing key refuses a NEW secret write; reads never rewrite; dual-key rotation]")
  const sc = await import("../lib/security/secret-crypto")
  const PLANT = "plaintext-PLANTED-hunter2-7f3a"
  const KEY_A = "a".repeat(64), KEY_B = "b".repeat(64)
  delete process.env.SECRETS_ENCRYPTION_KEY; delete process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS
  let refused: unknown = null; let returned: unknown = "not-called"
  try { returned = sc.encryptSecret(PLANT) } catch (e) { refused = e }
  check("no key → encryptSecret THROWS the typed refusal (never returns)", sc.isSecretStorageRefused(refused) && returned === "not-called")
  check("the refusal code is secrets_key_missing", (refused as { code?: string })?.code === "secrets_key_missing")
  check("the refusal message carries no part of the secret", !String((refused as Error)?.message).includes(PLANT) && !String((refused as Error)?.message).includes("hunter2"))
  check("no key → isEncryptionConfigured() is false (callers can refuse before a side effect)", !sc.isEncryptionConfigured())
  check("empty / null are not secrets and pass (no refusal)", sc.encryptSecret("") === "" && sc.encryptSecret(null) === null)
  check("legacy PLAINTEXT reads verbatim with no key (not an envelope)", sc.decryptSecret("legacy-plain") === "legacy-plain" && !sc.isEncrypted("legacy-plain"))

  process.env.SECRETS_ENCRYPTION_KEY = KEY_A
  const envA = sc.encryptSecret(PLANT)!
  check("CONTROL: with a key the write succeeds as an envelope, not plaintext", sc.isEncrypted(envA) && !envA.includes(PLANT))
  check("legacy plaintext still reads verbatim with a key (no rewrite)", sc.decryptSecret("legacy-plain") === "legacy-plain")
  check("an already-encrypted value is not re-encrypted on write", sc.encryptSecret(envA) === envA)
  delete process.env.SECRETS_ENCRYPTION_KEY
  let noKeyRead = false
  try { sc.decryptSecret(envA) } catch { noKeyRead = true }
  check("an existing envelope is never returned as garbage without a key (throws)", noKeyRead)

  process.env.SECRETS_ENCRYPTION_KEY = KEY_B; process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS = KEY_A
  check("ROTATION: current=B, previous=A → an A-sealed envelope still decrypts", sc.decryptSecret(envA) === PLANT)
  const envB = sc.encryptSecret(PLANT)!
  check("ROTATION: new writes seal with the CURRENT key only", sc.decryptSecret(envB) === PLANT)
  delete process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS
  let dropped = false
  try { sc.decryptSecret(envA) } catch { dropped = true }
  check("ROTATION: with the previous key removed an A envelope THROWS (never a wrong plaintext)", dropped)
  process.env.SECRETS_ENCRYPTION_KEY = KEY_A
  let notWithB = false
  try { sc.decryptSecret(envB) } catch { notWithB = true }
  check("ROTATION: the previous key never sealed anything (B envelope fails under A alone)", notWithB)
  let tamper = false
  try { sc.decryptSecret(envA.slice(0, -4) + "AAAA") } catch { tamper = true }
  check("a tampered envelope throws (GCM auth)", tamper)
  delete process.env.SECRETS_ENCRYPTION_KEY
  check("the env var for rotation is documented in .env.example", /^SECRETS_ENCRYPTION_KEY_PREVIOUS=/m.test(read(".env.example")))
}

// ── fake service client for S2 ─────────────────────────────────────────────────────────────────
type Row = Record<string, unknown>
function fakeSvc(tables: Record<string, Row[]>) {
  const writes: Array<{ table: string; op: string; payload: unknown }> = []
  const from = (table: string) => {
    let op = "select"; let payload: unknown = null
    const result = () => ({ data: op === "select" ? (tables[table] ?? []) : (op === "insert" ? [{ id: "n1" }] : op === "update" ? [{ id: "u1" }] : null), error: null, count: 0 }) // an update + .select() returns the matched row (the writer counts it)
    const b: any = {
      select: () => b, eq: () => b, in: () => b, or: () => b, not: () => b, gte: () => b, lte: () => b, limit: () => b, order: () => b,
      insert: (p: unknown) => { op = "insert"; payload = p; writes.push({ table, op, payload: p }); return b },
      update: (p: unknown) => { op = "update"; payload = p; writes.push({ table, op, payload: p }); return b },
      maybeSingle: async () => ({ data: (tables[table] ?? [])[0] ?? null, error: null }),
      single: async () => ({ data: { id: "n1" }, error: null }),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej),
    }
    void payload
    return b
  }
  return { client: { from } as any, writes }
}

async function incidentLayer() {
  console.log("\n[S2 — the refusal is actionable: refuse BEFORE the OAuth exchange; platform incident, no secret]")
  const PLANT_RT = "refresh-PLANTED-9c1e"
  process.env.GOOGLE_CLIENT_ID = "guard-client"; process.env.GOOGLE_CLIENT_SECRET = "guard-secret"
  delete process.env.SECRETS_ENCRYPTION_KEY; delete process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS
  const soon = new Date(Date.now() + 3600_000).toISOString()
  const staff = [{ id: "staff-1", brokerage_id: "b-platform", platform_role: "superadmin" }]
  const { client, writes } = fakeSvc({
    platform_credentials: [{ id: "cred-1", refresh_token: PLANT_RT, token_expires_at: soon, platform: "gmail" }],
    agent_api_credentials: [], social_media_accounts: [], notifications: [], users: staff,
  })
  let fetches = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => { fetches++; return new Response(JSON.stringify({ access_token: "new-at" }), { status: 200 }) }) as typeof fetch
  try {
    const { runCredentialRefresh } = await import("../lib/security/oauth-refresh")
    const r = await runCredentialRefresh(client)
    check("no key → the provider token exchange is NEVER called (the refresh token is not spent)", fetches === 0, `fetches=${fetches}`)
    check("no key → the credential is reported refused (counted as failed, never skipped)", r.outcomes.some((o) => o.result === "refused_secret_storage") && r.failed >= 1 && r.refreshed === 0)
    check("no key → no credential row was updated", !writes.some((w) => w.table === "platform_credentials"))
    const inc = writes.filter((w) => w.table === "notifications")
    const rows = inc.flatMap((w) => (Array.isArray(w.payload) ? w.payload : [w.payload])) as Row[]
    check("the platform incident was raised to staff (secret_storage_unconfigured)", rows.some((n) => n.type === "secret_storage_unconfigured"))
    check("the incident names the fix (SECRETS_ENCRYPTION_KEY) and carries no secret", rows.every((n) => !JSON.stringify(n).includes(PLANT_RT)) && rows.some((n) => String(n.body).includes("SECRETS_ENCRYPTION_KEY")))

    // positive control: with a key the same sweep exchanges and writes an ENVELOPE, never plaintext
    process.env.SECRETS_ENCRYPTION_KEY = "c".repeat(64)
    const f2 = fakeSvc({ platform_credentials: [{ id: "cred-1", refresh_token: PLANT_RT, token_expires_at: soon, platform: "gmail" }], agent_api_credentials: [], social_media_accounts: [], notifications: [], users: staff })
    const r2 = await runCredentialRefresh(f2.client)
    const upd = f2.writes.find((w) => w.table === "platform_credentials")?.payload as Row | undefined
    check("CONTROL: with a key the refresh runs and stores an enc:v1 envelope", r2.refreshed === 1 && typeof upd?.access_token === "string" && String(upd.access_token).startsWith("enc:v1:"))
  } finally {
    globalThis.fetch = realFetch
    delete process.env.SECRETS_ENCRYPTION_KEY
  }
  const crm = code("app/actions/crm-connect.ts")
  const refusal = crm.slice(crm.indexOf("!isEncryptionConfigured()"), crm.indexOf("!isEncryptionConfigured()") + 900)
  check("crm-connect raises the incident on its refusal, tenant from the session member", /raiseSecretStorageIncident\(/.test(refusal) && /brokerageId:\s*member\.brokerageId/.test(refusal) && !/rawSecret|apiSecret/.test(refusal.slice(0, refusal.indexOf("return {"))))
  const sentinel = code("lib/platform/os-sentinel.ts")
  check("the daily posture sweep is wired (os-sentinel → reportSecretStoragePosture)", /reportSecretStoragePosture\(svc, now\)/.test(sentinel))
  const rot = code("lib/security/credential-rotation.ts")
  const posture = rot.slice(rot.indexOf("async function reportSecretStoragePosture"))
  check("the posture census COUNTS (head) and never selects a secret value", /count:\s*"exact",\s*head:\s*true/.test(posture) && !/select\("(api_key|api_secret|access_token|refresh_token)/.test(posture))
}

// ── S3 — redaction ────────────────────────────────────────────────────────────────────────────
const SECRET_IDENT_RE = /\b(apiSecret|rawSecret|api_secret|access_token|refresh_token|smtp_password|smtpPassword|accessToken|refreshToken|clientSecret|client_secret|decryptSecret\()/
/** console.* calls whose ARGUMENT CODE (strings blanked) names a secret-bearing identifier. */
function consoleSecretHits(src: string): number {
  const s = blankStrings(stripComments(src))
  let hits = 0
  for (const m of s.matchAll(/console\.(log|info|warn|error|debug)\(/g)) {
    let depth = 0, i = (m.index ?? 0) + m[0].length - 1, end = i
    for (; i < s.length; i++) { if (s[i] === "(") depth++; else if (s[i] === ")") { depth--; if (depth === 0) { end = i; break } } }
    if (SECRET_IDENT_RE.test(s.slice((m.index ?? 0), end))) hits++
  }
  return hits
}
function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(join(ROOT, dir))) {
    const p = `${dir}/${f}`
    if (f === "node_modules" || f.startsWith(".")) continue
    const st = statSync(join(ROOT, p))
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(f)) out.push(p)
  }
  return out
}

async function redactionLayer() {
  console.log("\n[S3 — a secret never lands in an event / ledger payload or a log line]")
  const { redactSecretValues } = await import("../lib/security/export-credential-scan")
  const PLANT = "sek-PLANTED-4b2d-value"
  const payload = {
    provider: "fub", count: 3, token: "{first_name}",
    api_secret: PLANT, nested: { accessToken: PLANT, list: [{ "refresh-token": PLANT }, { note: "enc:v1:abc:def:ghi" }] },
    stripe: "sk_live_" + "x".repeat(24), Authorization: `Bearer ${PLANT}`,
  }
  check("CONTROL: the planted secret is really in the raw payload", JSON.stringify(payload).includes(PLANT))
  const red = redactSecretValues(payload)
  const out = JSON.stringify(red)
  check("the planted secret appears NOWHERE after redaction (name, nesting, arrays, header)", !out.includes(PLANT))
  check("secret SHAPES are redacted (our envelope, a Stripe secret key)", !out.includes("enc:v1:abc") && !out.includes("sk_live_"))
  check("non-secret fields pass untouched (incl. a template `token`)", red.provider === "fub" && red.count === 3 && red.token === "{first_name}")
  check("the input object is not mutated", payload.api_secret === PLANT)
  const emit = code("lib/kernel/emit.ts")
  check("emitKernelEvent stores metadata through redactSecretValues", /const metadata: Record<string, unknown> = redactSecretValues\(/.test(emit))
  const ledger = code("lib/kernel/action-ledger.ts")
  check("withActionLedger stores detail through redactSecretValues", /detail:\s*redactSecretValues\(/.test(ledger))
  check("CONTROL: the wiring check goes red on the unwrapped shape", !/detail:\s*redactSecretValues\(/.test(ledger.replace(/detail:\s*redactSecretValues\(/, "detail: (")))
  // census: console calls in lib/ + app/ naming a secret-bearing identifier
  check("CONTROL: the console census sees a planted leak", consoleSecretHits(`console.error("x", tokens.access_token)`) === 1 && consoleSecretHits(`console.error("access_token missing")`) === 0)
  const files = [...walk("lib"), ...walk("app")]
  const hits: string[] = []
  for (const f of files) { const n = consoleSecretHits(read(f)); if (n) hits.push(`${f}×${n}`) }
  console.log(`    census: ${files.length} files in lib/ + app/; console calls naming a secret identifier: ${hits.length ? hits.join(", ") : "0"}`)
  check("no console call in lib/ + app/ passes a secret-bearing identifier", hits.length === 0, hits.join(", "))
}

// ── S4 — tenant isolation of the canonical secret resolver ────────────────────────────────────
const STORES = ["agent_api_credentials", "platform_credentials", "integration_credentials"]
function unpinnedSecretReads(src: string): string[] {
  const s = stripComments(src)
  const out: string[] = []
  for (const store of STORES) {
    let at = 0
    for (;;) {
      const i = s.indexOf(`.from("${store}")`, at)
      if (i < 0) break
      at = i + 1
      const end = s.indexOf("\n\n", i)
      const chain = s.slice(i, end < 0 ? i + 800 : Math.min(end, i + 800))
      if (!/\.select\("[^"]*(api_key|api_secret|access_token|refresh_token)/.test(chain)) continue
      if (!/\.eq\("brokerage_id",\s*input\.brokerageId\)/.test(chain)) out.push(store)
    }
  }
  return out
}
function tenantLayer() {
  console.log("\n[S4 — a tenant cannot read another tenant's secret (canonical resolver)]")
  const cm = read("lib/integrations/connection-manager.ts")
  const bad = unpinnedSecretReads(cm)
  check("every secret-selecting store read in connection-manager pins brokerage_id from the verified input", bad.length === 0, bad.join(", "))
  check("CONTROL: removing the agent-stage pin is caught", unpinnedSecretReads(cm.replace(/\.eq\("brokerage_id", input\.brokerageId\)\s*\n\s*\.in\("service_name", aliases\)/, '.in("service_name", aliases)')).includes("agent_api_credentials"))
}

// ── S5 — extensions cannot reach an undeclared secret / capability ────────────────────────────
async function extensionLayer() {
  console.log("\n[S5 — the extension lifecycle refuses an undeclared secret or capability]")
  const reg = await import("../lib/kernel/skill-registry")
  const { adapterFor, routedProviders } = await import("../lib/kernel/provider-adapters")
  const name = routedProviders().find((p) => (adapterFor(p)?.credential.envVars.length ?? 0) > 0)!
  const a = adapterFor(name)!
  const base = { name, version: 1, adapter: a, evaluation_suite: "guard" }
  const ok = reg.validateProviderAdapterExtension(base)
  check(`CONTROL: the registered ${name} declaration itself is admitted`, ok.ok, ok.errors.join(", "))
  const smug = reg.validateProviderAdapterExtension({ ...base, adapter: { ...a, credential: { ...a.credential, envVars: [...a.credential.envVars, "SUPABASE_SERVICE_ROLE_KEY", "SECRETS_ENCRYPTION_KEY"] } } })
  check("a provider-adapter extension asking for an undeclared secret is refused by name", !smug.ok && smug.errors.includes("undeclared_credential:SUPABASE_SERVICE_ROLE_KEY") && smug.errors.includes("undeclared_credential:SECRETS_ENCRYPTION_KEY"))
  const cm = reg.validateCustomManagerDeclaration({ secret: "x", api_key: "y" } as any)
  check("a custom manager smuggling a secret field is refused (not_data)", !cm.ok && cm.errors.includes("not_data:secret") && cm.errors.includes("not_data:api_key"))
  check("an undeclared capability is refused at call time", reg.capabilityCallRefusal([], null, "send_email")?.startsWith("undeclared_capability:") === true)
  const { requestExtensionCapability } = await import("../lib/kernel/skill-marketplace")
  let delegated = 0
  const r = await requestExtensionCapability({ declared: [], owner: null }, { capability: "send_email" } as any, {} as any, { delegate: async () => { delegated++; return { ok: true } } })
  check("requestExtensionCapability refuses before ANY delegation", !r.ok && delegated === 0, r.reason)
}

function registrationLayer() {
  console.log("\n[REG]")
  const pkg = read("package.json")
  check("package.json wires test:secrets-rls", /"test:secrets-rls":\s*"tsx scripts\/secrets-rls-guard\.ts"/.test(pkg))
  check("the guard chain runs it", new RegExp("npm run test:secrets-rls(\\s|&|$)").test(JSON.parse(pkg).scripts.guard ?? ""))
  check("a MAINTENANCE_DOMAINS entry owns it", /proof:\s*"test:secrets-rls"/.test(code("lib/kernel/manager-registry.ts")))
}

async function main() {
  rlsLayer()
  await cryptoLayer()
  await incidentLayer()
  await redactionLayer()
  tenantLayer()
  await extensionLayer()
  registrationLayer()
  console.log("\nBLIND SPOTS: the migration is checked as TEXT (the live trigger was read once via MCP, 2026-10-08); the")
  console.log("  redactor is name/shape based (a secret under a neutral key with no known shape passes); the console")
  console.log("  census is identifier-based; S4 covers the canonical resolver only (other readers rely on RLS + their own pins).")
  console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
