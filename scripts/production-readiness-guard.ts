#!/usr/bin/env tsx
/**
 * scripts/production-readiness-guard.ts   (npm run test:production-readiness — pure, no DB)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 138 (lane 138F) — THE PRODUCTION-READINESS CENSUS.
 *
 * It does not re-prove what a survivor already proves. It holds the
 * cross-cutting census the release checklist asks for, and it holds
 * docs/architecture/PRODUCTION-ARCHITECTURE.md in agreement with the code:
 *
 *   C  CRONS — vercel.json schedules ONLY the dispatcher; the dispatcher gates
 *      on verifyCronAuth; every CRON_REGISTRY path resolves to a route file and
 *      has an owner in CRON_MANAGER (deeper: test:cron-dispatch,
 *      test:cron-auth-fail-closed, test:manager-ownership).
 *   E  ENV — every CORE env var is read in code, written in .env.example, and
 *      named in the doc's env table with its fail-closed behaviour; every
 *      webhook secret in WEBHOOK_CONTRACT is written in .env.example
 *      (whole-tree parity: test:env-var-parity).
 *   N  NEXT_PUBLIC — no NEXT_PUBLIC_* name read in code or written in
 *      .env.example has a secret's shape unless it is a CLASSIFIED public key
 *      with its reason; no "use client" module reads a non-public env var.
 *   W  WEBHOOKS — every WEBHOOK_CONTRACT entry verifies its caller (no "none",
 *      no handshake-only) and names where its secret comes from (scheme truth
 *      per route: test:webhook-contract).
 *   P  PUBLIC WRITES — every app/api route the proxy does not session-gate
 *      ('public' or 'open' in classifyProxyPath) that exports a writer method
 *      is gated (session / cron / internal secret / server-issued token /
 *      signature contract) or THROTTLED (checkPublicRateLimit) or CLASSIFIED
 *      here with its reason.
 *   R  RLS — the schema caches carry NO rls flag (blind spot, published); the
 *      RLS survivors stay registered and the doc names the live backstop.
 *   H  BUILD HEAP — vercel.json's build heap and build.yml's bracket are named
 *      in the doc with the same numbers (derived, not pinned).
 *
 * Measurement (CLAUDE.md §2): code tokens are read from stripComments +
 * blankStrings source; every absence assertion has a positive control.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings, blankComments } from "./strip-comments"
import { runtimeFiles } from "./runtime-roots"
import { LIVE_TABLES } from "./live-tables"
import { CRON_REGISTRY } from "../lib/kernel/cron-dispatch"
import { CRON_MANAGER } from "../lib/kernel/manager-registry"
import { WEBHOOK_CONTRACT, type WebhookContractEntry } from "../lib/providers/webhook-contract"
import { classifyProxyPath } from "../app/constants/auth"
import { TENANT_POLICY_SETTINGS_KEYS } from "../lib/kernel/tenant-policy"

const ROOT = process.cwd()
let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
const codeOf = (src: string) => blankStrings(stripComments(src))
function walk(dir: string, keep: (f: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(join(ROOT, dir))) return out
  for (const e of readdirSync(join(ROOT, dir))) {
    if (e === "node_modules" || e.startsWith(".")) continue
    const rel = `${dir}/${e}`
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, keep, out)
    else if (keep(rel)) out.push(rel)
  }
  return out
}
const DOC = "docs/architecture/PRODUCTION-ARCHITECTURE.md"
const doc = existsSync(join(ROOT, DOC)) ? read(DOC) : ""
const envExample = read(".env.example")
const envExampleNames = new Set([...envExample.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]))
const SRC_FILES = [...walk("app", (f) => /\.(ts|tsx)$/.test(f)), ...walk("lib", (f) => /\.(ts|tsx)$/.test(f)), ...walk("components", (f) => /\.(ts|tsx)$/.test(f)), ...walk("hooks", (f) => /\.(ts|tsx)$/.test(f)), "proxy.ts"]
const STRIPPED = new Map<string, string>()
for (const f of SRC_FILES) STRIPPED.set(f, stripComments(read(f)))
/** env names a source READS (process.env.X / process.env["X"]) — comment-stripped, string text intact for the bracket form. */
function envReads(stripped: string): Set<string> {
  const s = new Set<string>()
  for (const m of stripped.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g)) s.add(m[1] ?? m[2])
  return s
}
const ALL_READS = new Set<string>()
for (const s of STRIPPED.values()) for (const n of envReads(s)) ALL_READS.add(n)

// ── C · CRONS ────────────────────────────────────────────────────────────────
console.log("\n[C · crons — one platform schedule, every registry path routed + owned]")
const vercel = JSON.parse(read("vercel.json")) as { crons?: Array<{ path: string; schedule: string }>; buildCommand?: string }
check("C1 vercel.json schedules exactly the dispatcher", (vercel.crons ?? []).length === 1 && vercel.crons![0].path === "/api/cron/dispatch", JSON.stringify(vercel.crons))
check("C2 the dispatcher gates on verifyCronAuth before dispatching", /verifyCronAuth\(/.test(codeOf(read("app/api/cron/dispatch/route.ts"))))
const cronBase = (p: string) => p.split("?")[0]
function unownedCrons(registry: Array<{ path: string }>, owners: Record<string, unknown>): string[] {
  return [...new Set(registry.map((e) => cronBase(e.path)))].filter((p) => !owners[p])
}
function unroutedCrons(registry: Array<{ path: string }>): string[] {
  return [...new Set(registry.map((e) => cronBase(e.path)))].filter((p) => !existsSync(join(ROOT, "app" + p, "route.ts")))
}
const unowned = unownedCrons(CRON_REGISTRY, CRON_MANAGER)
const unrouted = unroutedCrons(CRON_REGISTRY)
check(`C3 every CRON_REGISTRY path (${new Set(CRON_REGISTRY.map((e) => cronBase(e.path))).size} distinct) has a CRON_MANAGER owner`, unowned.length === 0, unowned.join(", "))
check("C4 every CRON_REGISTRY path resolves to an app route file", unrouted.length === 0, unrouted.join(", "))
check("C5 POSITIVE CONTROL — an unowned, unrouted specimen path is caught by both finders",
  unownedCrons([{ path: "/api/cron/__specimen__" }], CRON_MANAGER).length === 1 && unroutedCrons([{ path: "/api/cron/__specimen__" }]).length === 1)

// ── E · ENV ──────────────────────────────────────────────────────────────────
console.log("\n[E · env — core vars read, documented, and their fail-closed behaviour named]")
/** The platform cannot serve a request safely without these; each one's
 *  fail-closed reader is cited in the doc's env table. */
const CORE_ENV = [
  "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY",
  "CRON_SECRET", "SECRETS_ENCRYPTION_KEY", "INTERNAL_API_SECRET", "STRIPE_SECRET_KEY",
  "AI_GATEWAY_API_KEY", "NEXT_PUBLIC_APP_URL",
] as const
const docEnvRows = new Set([...doc.matchAll(/^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/gm)].map((m) => m[1]))
check("E1 every CORE env var is READ in code (a stale name cannot sit in the list)", CORE_ENV.every((n) => ALL_READS.has(n)), CORE_ENV.filter((n) => !ALL_READS.has(n)).join(", "))
check("E2 every CORE env var is written in .env.example", CORE_ENV.every((n) => envExampleNames.has(n)), CORE_ENV.filter((n) => !envExampleNames.has(n)).join(", "))
check("E3 every CORE env var is a row of the doc's env table", CORE_ENV.every((n) => docEnvRows.has(n)), CORE_ENV.filter((n) => !docEnvRows.has(n)).join(", "))
const webhookEnv = [...new Set(WEBHOOK_CONTRACT.flatMap((e) => e.secretEnv))]
const undocWebhookEnv = webhookEnv.filter((n) => !envExampleNames.has(n))
check(`E4 every WEBHOOK_CONTRACT secret env (${webhookEnv.length}) is written in .env.example`, undocWebhookEnv.length === 0, undocWebhookEnv.join(", "))
check("E5 POSITIVE CONTROL — a specimen name is absent from all three places", !ALL_READS.has("__SPECIMEN_ENV__") && !envExampleNames.has("__SPECIMEN_ENV__") && !docEnvRows.has("__SPECIMEN_ENV__"))

// ── N · NEXT_PUBLIC ──────────────────────────────────────────────────────────
console.log("\n[N · NEXT_PUBLIC census — nothing secret-shaped is inlined into a client bundle]")
const SECRET_SHAPE = /(SECRET|SERVICE_ROLE|PRIVATE|PASSWORD|PASSWD|TOKEN|CREDENTIAL|_KEY)$|_KEY_|SECRET_/
/** Public-by-design names that match the shape. Each reason must stay true. */
const PUBLIC_BY_DESIGN: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "the anon key is public by Supabase's design; every row it can reach is RLS-bound",
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "a Stripe publishable key is browser-safe by design (pk_…)",
  NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: "a Maps JavaScript API key is a browser key; restrict it by HTTP referrer in the Google console (runbook)",
  NEXT_PUBLIC_GOOGLE_MAPS_KEY: "deprecated alias of NEXT_PUBLIC_GOOGLE_MAPS_API_KEY (lib/env/aliases.ts) — same browser key",
  NEXT_PUBLIC_DEMO_PASSWORD: "demo sign-in is hard-gated OFF on the production deployment (app/constants/auth.ts DEMO_CONFIG.ENABLED requires VERCEL_ENV !== 'production')",
}
function secretShapedPublic(names: Iterable<string>): string[] {
  return [...names].filter((n) => n.startsWith("NEXT_PUBLIC_") && SECRET_SHAPE.test(n) && !PUBLIC_BY_DESIGN[n])
}
const publicNames = new Set<string>([...ALL_READS].filter((n) => n.startsWith("NEXT_PUBLIC_")))
for (const n of envExampleNames) if (n.startsWith("NEXT_PUBLIC_")) publicNames.add(n)
const leaked = secretShapedPublic(publicNames)
console.log(`    census: ${publicNames.size} NEXT_PUBLIC_* names (code reads ∪ .env.example), ${Object.keys(PUBLIC_BY_DESIGN).length} classified public-by-design`)
check("N1 no secret-shaped NEXT_PUBLIC_* name outside the classified public keys", leaked.length === 0, leaked.join(", "))
check("N2 POSITIVE CONTROL — NEXT_PUBLIC_OPENAI_API_KEY / _INTERNAL_API_SECRET / _SERVICE_ROLE_KEY are caught",
  secretShapedPublic(["NEXT_PUBLIC_OPENAI_API_KEY", "NEXT_PUBLIC_INTERNAL_API_SECRET", "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY"]).length === 3)
check("N3 NEGATIVE CONTROL — a plain URL name is not secret-shaped", secretShapedPublic(["NEXT_PUBLIC_APP_URL"]).length === 0)
const staleClassified = Object.keys(PUBLIC_BY_DESIGN).filter((n) => !publicNames.has(n))
check("N4 every classified public key is still read or documented (no stale exemption)", staleClassified.length === 0, staleClassified.join(", "))
const SERVER_ONLY_OK = new Set(["NODE_ENV"])
function clientEnvLeaks(src: string): string[] {
  const stripped = stripComments(src)
  if (!/^\s*["']use client["']/.test(stripped)) return []
  return [...envReads(stripped)].filter((n) => !n.startsWith("NEXT_PUBLIC_") && !SERVER_ONLY_OK.has(n))
}
const clientLeaks: string[] = []
for (const f of SRC_FILES) { const l = clientEnvLeaks(read(f)); if (l.length) clientLeaks.push(`${f}: ${l.join(",")}`) }
check("N5 no \"use client\" module reads a non-public env var", clientLeaks.length === 0, clientLeaks.join(" | "))
check("N6 POSITIVE CONTROL — a client specimen reading CRON_SECRET is caught; the same read in a comment is not",
  clientEnvLeaks(`"use client"\nconst s = process.env.CRON_SECRET`).length === 1 && clientEnvLeaks(`"use client"\n// process.env.CRON_SECRET`).length === 0)

// ── W · WEBHOOKS ─────────────────────────────────────────────────────────────
console.log("\n[W · webhook signature census — every inbound door verifies its caller]")
const UNVERIFIED_SCHEMES = new Set(["none", "hub-verify-token-only"])
function unverifiedWebhooks(entries: Array<Pick<WebhookContractEntry, "path" | "scheme" | "secretEnv" | "implementedIn">>): string[] {
  return entries.filter((e) => UNVERIFIED_SCHEMES.has(e.scheme) || (e.secretEnv.length === 0 && (e.implementedIn ?? []).length === 0)).map((e) => `${e.path} (${e.scheme})`)
}
const byScheme = new Map<string, number>()
for (const e of WEBHOOK_CONTRACT) byScheme.set(e.scheme, (byScheme.get(e.scheme) ?? 0) + 1)
console.log(`    census: ${WEBHOOK_CONTRACT.length} contracted doors — ${[...byScheme].map(([k, v]) => `${k} ${v}`).join(", ")}`)
const unverified = unverifiedWebhooks(WEBHOOK_CONTRACT)
check("W1 no contracted webhook is unverified or secretless", unverified.length === 0, unverified.join(", "))
check("W2 POSITIVE CONTROL — a 'none' door and a secretless signature door are both caught",
  unverifiedWebhooks([{ path: "/x", scheme: "none", secretEnv: ["X"] }, { path: "/y", scheme: "hmac-sha256", secretEnv: [] }]).length === 2)
/** PURE — timingSafeEqual calls with no length guard / try just before them: on unequal lengths it THROWS,
 *  so a forged signature answers 500 instead of 401 (wave-138 R-4 class; 139G). */
function unguardedTimingSafe(src: string): number {
  const code = blankStrings(stripComments(src))
  let n = 0
  for (const m of code.matchAll(/\btimingSafeEqual\s*\(/g)) {
    const before = code.slice(Math.max(0, m.index! - 240), m.index!)
    if (!/\.length\s*[!=]==?|\btry\s*\{/.test(before)) n++
  }
  return n
}
const webhookCodeFiles = [...new Set(WEBHOOK_CONTRACT.flatMap((e) => [e.routeFile, ...(e.implementedIn ?? [])]))].filter((f) => existsSync(join(ROOT, f)))
const unguardedCompare = webhookCodeFiles.filter((f) => unguardedTimingSafe(read(f)) > 0)
check(`W4 no contracted webhook module (${webhookCodeFiles.length}) calls timingSafeEqual without a length guard (unequal lengths throw → 500, not 401)`, unguardedCompare.length === 0, unguardedCompare.join(", "))
check("W5 POSITIVE CONTROL — the pre-139G whisper-bridge compare is caught; a length-guarded one is not",
  unguardedTimingSafe(`function v(e: string, s: string) { const x = 1\n  return crypto.timingSafeEqual(Buffer.from(e), Buffer.from(s)) }`) === 1 &&
  unguardedTimingSafe(`function v(a: Buffer, b: Buffer) { return a.length === b.length && timingSafeEqual(a, b) }`) === 0)
check("W3 every contracted routeFile exists",WEBHOOK_CONTRACT.every((e) => existsSync(join(ROOT, e.routeFile))), WEBHOOK_CONTRACT.filter((e) => !existsSync(join(ROOT, e.routeFile))).map((e) => e.routeFile).join(", "))

// ── P · PUBLIC WRITES ────────────────────────────────────────────────────────
console.log("\n[P · public write census — not session-gated by the proxy ⇒ gated, throttled or classified]")
/** Gate idioms, read from stripped code (a tombstone naming one is not a gate). */
const GATE = /\b(requireAuth|requireUser|requireCallerTenant|requireContactAccess|require[A-Z]\w*Actor|require[A-Z]\w*Access|requireSuperadminAuth|requirePlatformStaffAuth|getAgentContext|resolveWriteContextForTenant|resolveWriteContext|verifyCronAuth|serveDomainApi|resolveAgenticCaller|resolveExternalPartnerIdentity|auth\.getUser)\s*\(|INTERNAL_API_SECRET|RELAY_SHARED_SECRET/
const THROTTLE = /\bcheckPublicRateLimit\s*\(/
const contracted = new Set(WEBHOOK_CONTRACT.map((e) => e.routeFile))
/** Ungated, unthrottled writers that are acceptable as they stand — each with its reason. */
const PUBLIC_WRITE_CLASSIFIED: Record<string, string> = {
  "app/api/auth/reset-password/route.ts": "Supabase Auth applies its own per-address recovery-email rate limit (P2: an app-side throttle is still open)",
  "app/api/blog/track-view/route.ts": "anonymous view counter (hashed IP de-dupe), no contact write, no spend (P2: throttle open)",
  "app/api/blog/track-share/route.ts": "anonymous share counter, no contact write, no spend (P2: throttle open)",
  "app/api/track/dwell/route.ts": "dwell beacon on an existing visitor session, constant answer, no contact write (P2: throttle open)",
  "app/api/embed/session/route.ts": "origin allow-list + checkUsageCap bound the tenant's media spend (P2: a per-IP throttle is open)",
  "app/api/embed/session/end/route.ts": "closes a session the server issued; no create, no spend",
  "app/api/embed/session/heartbeat/route.ts": "touches a session the server issued; no create, no spend",
  "app/api/widget/capture-lead/route.ts": "server-issued widget_session_token (minted by the throttled /api/widget/session)",
  "app/api/widget/intake/route.ts": "server-issued widget_session_token (minted by the throttled /api/widget/session)",
  "app/api/widget/live-agent-request/route.ts": "server-issued widget_session_token (minted by the throttled /api/widget/session)",
  "app/api/workflow/buyer-intake/submit/route.ts": "single-use intake token the OS authored",
  "app/api/workflow/buyer-intake/upload/route.ts": "single-use intake token the OS authored",
  "app/api/live-agent/simli-turn/route.ts": "resolveOpenSimliSession — a live session the server opened",
  "app/api/showings/feedback/[token]/route.ts": "feedback token the OS authored into the link",
  "app/api/portal/messages/send/route.ts": "delegates to the sendPortalMessage server action, which gates on the portal session",
  "app/api/did/custom-llm/route.ts": "D-ID custom-LLM door: bearer secret checked inside (sessionless provider door)",
  "app/api/agent-assistant/tool-call/route.ts": "ElevenLabs tool webhook: per-session signed token checked inside",
  "app/api/workflow/trigger/route.ts": "Authorization: Bearer secret compared timing-safe (platform secret or a tenant webhook subscription's signing secret)",
}
function needsClassification(file: string, src: string): boolean {
  const code = stripComments(src)
  if (!/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b|export\s+const\s+(POST|PUT|PATCH|DELETE)\b/.test(code)) return false
  if (contracted.has(file)) return false
  return !GATE.test(code) && !THROTTLE.test(code)
}
const routeFiles = walk("app/api", (f) => f.endsWith("/route.ts"))
const exposed = routeFiles.filter((f) => classifyProxyPath("/" + f.replace(/^app\//, "").replace(/\/route\.ts$/, "")) !== "protected")
const unclassified = exposed.filter((f) => needsClassification(f, read(f)) && !PUBLIC_WRITE_CLASSIFIED[f])
const throttled = exposed.filter((f) => THROTTLE.test(stripComments(read(f))))
console.log(`    census: ${routeFiles.length} api routes, ${exposed.length} not session-gated by the proxy, ${throttled.length} throttled, ${Object.keys(PUBLIC_WRITE_CLASSIFIED).length} classified`)
check("P1 every exposed writer route is gated, throttled, signature-contracted or classified", unclassified.length === 0, unclassified.join(", "))
const staleWrite = Object.keys(PUBLIC_WRITE_CLASSIFIED).filter((f) => !existsSync(join(ROOT, f)))
check("P2 every classified route still exists", staleWrite.length === 0, staleWrite.join(", "))
const contractedButClassified = Object.keys(PUBLIC_WRITE_CLASSIFIED).filter((f) => contracted.has(f))
check("P2b no classified route is ALSO a WEBHOOK_CONTRACT row (the contract is its gate — the exemption is stale; 139G closed R-4 this way)", contractedButClassified.length === 0, contractedButClassified.join(", "))
check("P2c the twiml whisper bridge is a contracted Twilio-signed door (wave-138 R-4)", WEBHOOK_CONTRACT.some((e) => e.routeFile === "app/api/twiml/whisper-bridge/route.ts" && e.scheme === "twilio-url-hmac-sha1"))
check("P3 POSITIVE CONTROL — an ungated POST specimen is caught; a throttled one and a commented-out gate behave",
  needsClassification("app/api/__specimen__/route.ts", "export async function POST() { return 1 }") &&
  !needsClassification("app/api/__specimen__/route.ts", "export async function POST() { checkPublicRateLimit('s','k',{limit:1,windowMs:1}) }") &&
  needsClassification("app/api/__specimen__/route.ts", "// requireAuth(req)\nexport async function POST() { return 1 }"))
const LANE_THROTTLED = ["app/api/forms/submit/route.ts", "app/api/open-house/attend/route.ts", "app/api/qr/submit/route.ts", "app/api/embed/capture/route.ts", "app/api/lead-magnets/submissions/route.ts", "app/api/track/identify/route.ts"]
check("P4 the contact-creating public intake doors are throttled (138F P1 fix)", LANE_THROTTLED.every((f) => THROTTLE.test(stripComments(read(f)))), LANE_THROTTLED.filter((f) => !THROTTLE.test(stripComments(read(f)))).join(", "))

// ── R · RLS ──────────────────────────────────────────────────────────────────
console.log("\n[R · RLS — blind spot published, survivors held]")
const snapshot = read("scripts/schema-snapshot.ts")
console.log("    BLIND SPOT: scripts/schema-snapshot.ts / live-tables.ts carry no rls flag, so CI cannot census RLS. The live census is in the doc (read-only query) and the live backstop is the ensure_rls event trigger.")
check("R1 the cache really carries no rls flag (if one appears, this layer must start reading it)", !/rls_enabled|relrowsecurity/.test(snapshot))
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
check("R2 the RLS survivors stay registered (test:rls-public-grant, test:rls-anon-escape)", !!pkg.scripts["test:rls-public-grant"] && !!pkg.scripts["test:rls-anon-escape"])
check("R3 the doc names the live RLS backstop (ensure_rls → rls_auto_enable)", /ensure_rls/.test(doc) && /rls_auto_enable/.test(doc))

// ── H · BUILD HEAP ───────────────────────────────────────────────────────────
console.log("\n[H · build heap — the doc carries the numbers the config carries]")
const vercelHeap = (vercel.buildCommand ?? "").match(/max-old-space-size=(\d+)/)?.[1]
const buildYml = read(".github/workflows/build.yml")
const ciHeap = buildYml.match(/BUILD_HEAP_MB \|\| '(\d+)'/)?.[1]
check("H1 vercel.json's buildCommand sets an explicit heap", !!vercelHeap)
check("H2 build.yml declares the CI build heap default", !!ciHeap)
check("H3 the doc states both heap numbers", !!vercelHeap && !!ciHeap && doc.includes(vercelHeap) && doc.includes(ciHeap), `vercel=${vercelHeap} ci=${ciHeap}`)

// ── D · DOC ──────────────────────────────────────────────────────────────────
console.log("\n[D · design doc — exists, linked from the constitution, cites real files]")
check("D1 the production architecture doc exists", doc.length > 0)
check("D2 the constitution links it", read("docs/architecture/OS-CONSTITUTION.md").includes("PRODUCTION-ARCHITECTURE.md"))
const cites = [...doc.matchAll(/`((?:lib|app|scripts|supabase|docs|\.github)\/[A-Za-z0-9_./\[\]-]+\.(?:ts|tsx|sql|md|yml|json))(?::(\d+))?`/g)]
const badCites = cites.filter(([, f, line]) => {
  if (!existsSync(join(ROOT, f))) return true
  return !!line && Number(line) > read(f).split("\n").length
}).map(([, f, l]) => `${f}${l ? ":" + l : ""}`)
check(`D3 every file:line the doc cites exists (${cites.length} citations)`, cites.length > 0 && badCites.length === 0, [...new Set(badCites)].join(", "))

// ═════════════════════════════════════════════════════════════════════════════
// WAVE 139 (lane 139G) — INTEGRATION CLOSURE CENSUSES. Each one derives its
// population from the code (never a pinned list), publishes its exceptions with
// reasons, fails on a STALE exception, and proves its finder bites (positive control).
// Corpus: runtimeFiles() (scripts/runtime-roots.ts — every directory that ships).
// ═════════════════════════════════════════════════════════════════════════════
const RUNTIME = runtimeFiles().map((f) => f.replace(/^\.\//, ""))
const RT = new Map<string, { bc: string; bs: string }>()
for (const f of RUNTIME) { const raw = read(f); RT.set(f, { bc: blankComments(raw), bs: blankStrings(raw) }) }
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// ── K · POLICY KEYS × READERS ────────────────────────────────────────────────
console.log("\n[K · policy-key reader census — every TENANT_POLICY_SETTINGS_KEYS key has a consuming reader]")
/** The policy plumbing reads EVERY key generically (constitution, history, merge) — not a consumer. */
const POLICY_PLUMBING = new Set(["lib/kernel/tenant-policy.ts", "lib/settings/brokerage-settings-merge.ts"])
/** [start, end) spans of every `mergeBrokerageSettings(…)` call — a read INSIDE one is the writer's
 *  read-modify-write, not a consumer. Paren-matched on string-blanked code (offsets aligned). */
function mergeSpans(bs: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const m of bs.matchAll(/\bmergeBrokerageSettings\s*\(/g)) {
    let depth = 0
    for (let i = m.index! + m[0].length - 1; i < bs.length; i++) {
      if (bs[i] === "(") depth++
      else if (bs[i] === ")" && --depth === 0) { out.push([m.index!, i + 1]); break }
    }
  }
  return out
}
/** Offsets where `key` is READ: `.key` / `?.key` (code, not a call), `x["key"]`, `x[CONST]` (CONST = "key")
 *  — an element access follows an expression (`ident`, `)`, `]`, `?.`), so a computed object-literal WRITE
 *  `{ [CONST]: v }` (after `{` or `,`) is not one — outside every mergeBrokerageSettings call. */
function policyKeyReads(text: { bc: string; bs: string }, key: string, consts: string[]): number[] {
  const hits: number[] = []
  const ELEM = `(?:[\\w)\\]]|\\?\\.)\\s*\\[\\s*`
  for (const m of text.bs.matchAll(new RegExp(`(?:\\?\\.|\\.)\\s*${esc(key)}\\b(?!\\s*\\()`, "g"))) hits.push(m.index!)
  for (const m of text.bc.matchAll(new RegExp(`${ELEM}["'\`]${esc(key)}["'\`]\\s*\\]`, "g"))) hits.push(m.index!)
  if (consts.length) for (const m of text.bs.matchAll(new RegExp(`${ELEM}(?:${consts.map(esc).join("|")})\\s*\\]`, "g"))) hits.push(m.index!)
  const spans = mergeSpans(text.bs)
  return hits.filter((i) => !spans.some(([a, b]) => i >= a && i < b))
}
const SPEC_W = `// settings.spec_key\nawait mergeBrokerageSettings(svc, id, (s) => { const prev = s.spec_key; return { spec_key: prev, [SPEC_KEY]: 1 } })\nconst w = { spec_key: 1, [SPEC_KEY]: 2 }\nconst msg = "settings.spec_key"\n`
const SPEC_R = `const v = settings.spec_key\nconst u = s ? (settings as Record<string, any>)[SPEC_KEY] : null\n`
const policyKeys = Object.keys(TENANT_POLICY_SETTINGS_KEYS)
const keyConsts = new Map<string, string[]>()
for (const t of RT.values()) for (const m of t.bc.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::\s*\w+\s*)?=\s*["']([a-z][a-z0-9_]*)["']/g)) {
  if (policyKeys.includes(m[2])) keyConsts.set(m[2], [...new Set([...(keyConsts.get(m[2]) ?? []), m[1]])])
}
/** A CONSUMER reader is a .ts module (a service, action, route or cron); a .tsx-only reader is DISPLAY. */
function policyReaders(key: string): { consumers: string[]; display: string[] } {
  const consumers: string[] = [], display: string[] = []
  for (const [f, t] of RT) {
    if (POLICY_PLUMBING.has(f)) continue
    if (policyKeyReads(t, key, keyConsts.get(key) ?? []).length === 0) continue
    ;(f.endsWith(".tsx") ? display : consumers).push(f)
  }
  return { consumers, display }
}
/** Keys whose readers are DISPLAY-ONLY or absent, accepted with a reason that names the finding. */
const POLICY_KEY_EXCEPTIONS: Record<string, string> = {
  vendor_tier_pricing: "FINDING P1 (139G notes): the admin queue DISPLAYS the override (app/dashboard/admin/vendor-approvals/page.tsx) but the vendor checkout (app/actions/vendor-billing.ts createVendorSubscriptionCheckout) charges VENDOR_TIERS[t] and never reads it — money + unset tier pricing (wave-139 ECONOMICS ruling) → owner",
}
const policyCensus = policyKeys.map((k) => ({ key: k, ...policyReaders(k) }))
const unread = policyCensus.filter((r) => r.consumers.length === 0 && !POLICY_KEY_EXCEPTIONS[r.key])
console.log(`    census: ${policyKeys.length} settings policy keys; ${policyCensus.filter((r) => r.consumers.length).length} with a consuming reader, ${policyCensus.filter((r) => !r.consumers.length && r.display.length).length} display-only, ${policyCensus.filter((r) => !r.consumers.length && !r.display.length).length} unread; ${Object.keys(POLICY_KEY_EXCEPTIONS).length} excepted`)
for (const r of policyCensus) console.log(`      ${r.key}: ${r.consumers.length} consumer(s)${r.consumers.length ? ` e.g. ${r.consumers[0]}` : ""}${r.display.length ? `, ${r.display.length} display` : ""}`)
check("K1 every TENANT_POLICY_SETTINGS_KEYS key has a consuming (non-display, non-plumbing, non-writer) reader", unread.length === 0, unread.map((r) => r.key).join(", "))
const stalePolicyEx = Object.keys(POLICY_KEY_EXCEPTIONS).filter((k) => !policyKeys.includes(k) || policyCensus.find((r) => r.key === k)!.consumers.length > 0)
check("K2 no stale policy exception (excepted key still registered AND still lacks a consumer)", stalePolicyEx.length === 0, stalePolicyEx.join(", "))
check("K3 POSITIVE CONTROL — a writer-only read (inside mergeBrokerageSettings), an object-literal write and a comment are NOT reads; a consumer read and a [CONST] read ARE",
  policyKeyReads({ bc: blankComments(SPEC_W), bs: blankStrings(SPEC_W) }, "spec_key", ["SPEC_KEY"]).length === 0 &&
  policyKeyReads({ bc: blankComments(SPEC_R), bs: blankStrings(SPEC_R) }, "spec_key", ["SPEC_KEY"]).length === 2)

// ── M · MIGRATION RUNTIME USAGE ──────────────────────────────────────────────
console.log("\n[M · migration runtime census — every table/column added in the closure window is read or written by runtime code]")
/** The census window opens at m697 (wave 101's first schema, the start of the waves this closure audits)
 *  and has NO upper bound: every later migration is in it the moment its file lands. */
const MIGRATION_WINDOW_FLOOR = 697
interface MigrationAdds { file: string; tables: string[]; columns: Array<{ table: string; column: string }>; dropped: string[] }
/** PURE — tables created, columns added and tables dropped by one migration's SQL (SQL `--` comments removed). */
function parseMigrationAdds(file: string, sql: string): MigrationAdds {
  // Dollar-quoted bodies (functions / DO blocks) and '…' literals are DATA, not DDL — m752's event-trigger body
  // carries the text 'CREATE TABLE AS', which a bare scan read as a table named "as". Blank them first.
  // ORDER (CLAUDE.md §2): line comments FIRST — an apostrophe in a comment would otherwise open a "string"
  // that swallows real DDL — then dollar bodies, then literals.
  const code = sql.split("\n").map((l) => { const i = l.indexOf("--"); return i >= 0 ? l.slice(0, i) : l }).join("\n")
    .replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, " ").replace(/'(?:[^']|'')*'/g, "''")
  const out: MigrationAdds = { file, tables: [], columns: [], dropped: [] }
  for (const stmt of code.split(";")) {
    const ct = stmt.match(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?/i)
    if (ct) out.tables.push(ct[1].toLowerCase())
    const at = stmt.match(/\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?"?(\w+)"?/i)
    if (at) for (const c of stmt.matchAll(/\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gi)) out.columns.push({ table: at[1].toLowerCase(), column: c[1].toLowerCase() })
    const dt = stmt.match(/\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?/i)
    if (dt) out.dropped.push(dt[1].toLowerCase())
  }
  return out
}
const MIG_DIR = "supabase/migrations"
const windowFiles = readdirSync(join(ROOT, MIG_DIR)).filter((f) => f.endsWith(".sql") && Number(f.match(/^m(\d+)/)?.[1] ?? -1) >= MIGRATION_WINDOW_FLOOR).sort()
const adds = windowFiles.map((f) => parseMigrationAdds(f, read(`${MIG_DIR}/${f}`)))
const droppedInWindow = new Set(adds.flatMap((a) => a.dropped))
const liveSet = new Set(LIVE_TABLES)
const windowTables = [...new Set(adds.flatMap((a) => a.tables))].filter((t) => !droppedInWindow.has(t))
const windowColumns = adds.flatMap((a) => a.columns.map((c) => ({ ...c, file: a.file }))).filter((c) => !windowTables.includes(c.table) && !droppedInWindow.has(c.table))
/** Runtime files whose code names the table as a string literal (`.from("t")`, `table: "t"`). */
function tableUsers(table: string, corpus: Map<string, { bc: string }> = RT): string[] {
  const re = new RegExp(`["'\`]${esc(table)}["'\`]`)
  return [...corpus].filter(([, t]) => re.test(t.bc)).map(([f]) => f)
}
/** Runtime files whose code (comments blanked, strings intact — a select list is a string) names the column. */
function columnUsers(column: string, corpus: Map<string, { bc: string }> = RT): string[] {
  const re = new RegExp(`\\b${esc(column)}\\b`)
  return [...corpus].filter(([, t]) => re.test(t.bc)).map(([f]) => f)
}
/** Added but deliberately without a runtime reader/writer — each with its reason. */
const MIGRATION_RUNTIME_EXCEPTIONS: Record<string, string> = {}
const tableUse = new Map(windowTables.map((t) => [t, tableUsers(t)]))
const unusedTables = windowTables.filter((t) => tableUse.get(t)!.length === 0 && !MIGRATION_RUNTIME_EXCEPTIONS[t])
const unusedColumns = windowColumns.filter((c) => columnUsers(c.column).length === 0 && !MIGRATION_RUNTIME_EXCEPTIONS[`${c.table}.${c.column}`])
const fileOnly = windowTables.filter((t) => !liveSet.has(t))
console.log(`    census: ${windowFiles.length} migrations ≥ m${MIGRATION_WINDOW_FLOOR} → ${windowTables.length} tables created, ${windowColumns.length} columns added to older tables; ${fileOnly.length} created-in-file but not live (${fileOnly.join(", ") || "none"})`)
console.log("    BLIND SPOT: a column whose name is generic (subject, purpose, brand…) counts as used wherever that word is code; only an ABSENT name is a proof of no use.")
/** Narrower, published (not failed): columns never named in a file that also names their table — a row
 *  helper can carry a column away from its `.from()`, so this is a reading list, not a verdict. */
const tableUsersOnce = new Map<string, Set<string>>()
const usersOfTable = (t: string) => { if (!tableUsersOnce.has(t)) tableUsersOnce.set(t, new Set(tableUsers(t))); return tableUsersOnce.get(t)! }
const notColocated = windowColumns.filter((c) => { const own = usersOfTable(c.table); const withTable = new Map([...RT].filter(([f]) => own.has(f))); return withTable.size > 0 && columnUsers(c.column, withTable).length === 0 })
console.log(`    co-location: ${windowColumns.length - notColocated.length}/${windowColumns.length} added columns are named in a file that also names their table${notColocated.length ? `; not co-located: ${notColocated.map((c) => `${c.table}.${c.column}`).join(", ")}` : ""}`)
check("M1 every table created in the window is read or written by runtime code", unusedTables.length === 0, unusedTables.join(", "))
check("M2 every column added in the window to an older table is named by runtime code", unusedColumns.length === 0, unusedColumns.map((c) => `${c.table}.${c.column} (${c.file})`).join(", "))
const staleMigEx = Object.keys(MIGRATION_RUNTIME_EXCEPTIONS).filter((k) => k.includes(".") ? !windowColumns.some((c) => `${c.table}.${c.column}` === k) || columnUsers(k.split(".")[1]).length > 0 : !windowTables.includes(k) || tableUse.get(k)!.length > 0)
check("M3 no stale migration exception", staleMigEx.length === 0, staleMigEx.join(", "))
const specMig = parseMigrationAdds("m999-spec.sql", "-- CREATE TABLE public.commented_out (id int);\nCREATE TABLE IF NOT EXISTS public.spec_tbl (id int);\nALTER TABLE public.old_tbl\n  ADD COLUMN IF NOT EXISTS spec_col text,\n  ADD COLUMN other_col int;\n")
const specCorpus = new Map([["lib/spec.ts", { bc: blankComments(`// .from("spec_tbl") spec_col\nexport const x = 1`) }]])
check("M4 POSITIVE CONTROL — the parser finds the created table + both added columns (not the commented one); a table/column named only in a comment is UNUSED",
  specMig.tables.join() === "spec_tbl" && specMig.columns.map((c) => `${c.table}.${c.column}`).join() === "old_tbl.spec_col,old_tbl.other_col" &&
  tableUsers("spec_tbl", specCorpus).length === 0 && columnUsers("spec_col", specCorpus).length === 0 &&
  tableUsers("spec_tbl", new Map([["lib/s.ts", { bc: `svc.from("spec_tbl")` }]])).length === 1)

// ── U · USER DOORS ───────────────────────────────────────────────────────────
console.log("\n[U · user-door census — every window table a capability persists to is reachable from a page a user can open]")
/** Door entries: every app/** page (test:orphan-routes holds each one LINKED from a nav surface or a
 *  named external source) and, transitively, every app/api route a reachable module fetches by path. */
function makeResolver() {
  const tryF = (p: string): string | null => {
    for (const c of [p, `${p}.ts`, `${p}.tsx`, `${p}/index.ts`, `${p}/index.tsx`]) if (RT.has(c)) return c
    return null
  }
  return (spec: string, from: string): string | null => {
    if (spec.startsWith("./") || spec.startsWith("../")) return tryF(join(from, "..", spec).replace(/\\/g, "/"))
    if (spec.startsWith("@/components/")) return tryF(`app/components/${spec.slice(13)}`) ?? tryF(spec.slice(2))
    if (spec.startsWith("@/")) return tryF(spec.slice(2))
    return null
  }
}
const resolveSpec = makeResolver()
const edgeCache = new Map<string, string[]>()
function importEdges(f: string): string[] {
  const hit = edgeCache.get(f); if (hit) return hit
  const bc = RT.get(f)?.bc ?? ""
  const out: string[] = []
  for (const m of bc.matchAll(/(?:^|[;\n}])\s*(?:import|export)\s+(type\s+)?(?:[^'"`;]*?\bfrom\s*)?["']([^"']+)["']/g)) { if (!m[1]) { const r = resolveSpec(m[2], f); if (r) out.push(r) } }
  for (const m of bc.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g)) { const r = resolveSpec(m[1], f); if (r) out.push(r) }
  edgeCache.set(f, out)
  return out
}
const apiRoutes = RUNTIME.filter((f) => /^app\/api\/.+\/route\.ts$/.test(f)).map((f) => {
  const path = "/" + f.replace(/^app\//, "").replace(/\/route\.ts$/, "").split("/").filter((s) => !/^\(.*\)$/.test(s)).join("/")
  const re = new RegExp(`["'\`](?:\\$\\{[^}]*\\})?${path.split("/").map((s) => /^\[.*\]$/.test(s) ? "(?:\\$\\{[^}]*\\}|[^/\"'\`?#]+)" : esc(s)).join("/")}(?:[?"'\`#]|\\$\\{)`)
  return { file: f, re }
})
/** Everything reachable from the doors (pages + fetched api routes), to a fixpoint. */
function doorReach(pages: string[]): Set<string> {
  const seen = new Set<string>(pages); const q = [...pages]; const fetched = new Set<string>()
  for (;;) {
    while (q.length) { const f = q.pop()!; for (const t of importEdges(f)) if (!seen.has(t)) { seen.add(t); q.push(t) } }
    let grew = false
    for (const r of apiRoutes) {
      if (fetched.has(r.file)) continue
      for (const f of seen) if (r.re.test(RT.get(f)!.bc)) { fetched.add(r.file); if (!seen.has(r.file)) { seen.add(r.file); q.push(r.file); grew = true } break }
    }
    if (!grew) return seen
  }
}
const pages = RUNTIME.filter((f) => /^app\/(?!api\/).*\/page\.tsx?$|^app\/page\.tsx?$/.test(f))
const reachable = doorReach(pages)
/** The USER LAYER: page-reachable app/** modules (pages, panels, server actions, UI-fetched api routes) —
 *  never a cron route. Reachability alone is too wide (hub modules put ~95% of lib/ one walk from some page),
 *  so a capability has a DOOR only when its persisting module IS a user-layer module or is imported
 *  DIRECTLY by one (the service a panel/action calls). */
const userLayer = new Set([...reachable].filter((f) => f.startsWith("app/") && !f.startsWith("app/api/cron/")))
/** PURE over its inputs — the door of a capability whose persisting modules are `users`, or null. */
function doorOf(users: string[], ui: Set<string>, edges: (f: string) => string[]): string | null {
  for (const f of users) if (ui.has(f)) return f
  for (const g of ui) { const hit = edges(g).find((t) => users.includes(t)); if (hit) return `${g} → ${hit}` }
  return null
}
/** Window tables with NO user door BY DESIGN — platform/cron-internal evidence or caches, each with its reason. */
const DOORLESS_BY_DESIGN: Record<string, string> = {}
const doors = new Map(windowTables.map((t) => [t, doorOf(tableUse.get(t)!, userLayer, importEdges)]))
const doorless = windowTables.filter((t) => tableUse.get(t)!.length > 0 && !doors.get(t))
const unexplainedDoorless = doorless.filter((t) => !DOORLESS_BY_DESIGN[t])
console.log(`    census: ${pages.length} pages reach ${reachable.size} runtime modules (${userLayer.size} in the user layer); ${windowTables.length - doorless.length}/${windowTables.length} window tables have a door; ${doorless.length} doorless (${Object.keys(DOORLESS_BY_DESIGN).length} by design)`)
for (const t of windowTables) console.log(`      ${t}: ${doors.get(t) ? `door ${doors.get(t)}` : DOORLESS_BY_DESIGN[t] ? `doorless by design — ${DOORLESS_BY_DESIGN[t]}` : "NO DOOR"}`)
console.log("    BLIND SPOT: a door is an import/fetch edge, not a rendered control — a panel that imports the service for a constant counts; computed fetch paths are not followed; a capability with no window table (pure code) is censused by test:orphan-routes / orphan-export, not here.")
check("U1 every window table with runtime use has a user door (or is classified doorless by design)", unexplainedDoorless.length === 0, unexplainedDoorless.join(", "))
const staleDoorless = Object.keys(DOORLESS_BY_DESIGN).filter((t) => !doorless.includes(t))
check("U2 no stale doorless exception (the table still exists in the window and still has no door)", staleDoorless.length === 0, staleDoorless.join(", "))
check("U2b POSITIVE CONTROL — a service imported only by a cron route has NO door; the same service imported by an action does",
  doorOf(["lib/spec-svc.ts"], new Set(["app/actions/spec.ts"]), (f) => f === "app/api/cron/spec/route.ts" ? ["lib/spec-svc.ts"] : []) === null &&
  doorOf(["lib/spec-svc.ts"], new Set(["app/actions/spec.ts"]), (f) => f === "app/actions/spec.ts" ? ["lib/spec-svc.ts"] : []) === "app/actions/spec.ts → lib/spec-svc.ts")
check("U3 POSITIVE CONTROL — an api route fetched by path from a page-reachable module is a door; an unfetched one is not",
  apiRoutes.length > 0 && apiRoutes.some((r) => r.re.test('fetch("/api/' + r.file.slice(8, -9).split("/").map((s) => /^\[.*\]$/.test(s) ? "x1" : s).join("/") + '")')) &&
  !apiRoutes.some((r) => r.re.test('fetch("/api/__specimen_never_routed__")')))
check("U4 the door walk reaches the server-action layer (a closure that resolves nothing would report no doors)", [...reachable].filter((f) => f.startsWith("app/actions/")).length > 50 && [...reachable].filter((f) => f.startsWith("lib/")).length > 200)

// ── S · SERVICE CLIENT BEFORE A SESSION GATE ─────────────────────────────────
console.log("\n[S · \"use server\" exports — the session gate precedes the service client (CLAUDE.md §4)]")
const SESSION_GATE = /\b(\w*[Gg]ate|\w*[Aa]uth\w*|require\w*|getAgentContext|resolve\w*|getUser|getSession|verify\w*|assert\w*|get\w*Context|getCurrentUser|getProfile|\w*Admin|\w*Staff|\w*Session\w*|createClient)\s*\(/
/** PURE — exported async functions of a "use server" module whose body reaches createServiceClient() before
 *  ANY gate-shaped call. A wide gate idiom on purpose: a miss here is a real ungated door, not a style nit. */
function serviceBeforeGate(src: string): string[] {
  if (!/^\s*["']use server["']/.test(stripComments(src))) return []
  const code = blankStrings(stripComments(src))
  const out: string[] = []
  for (const m of code.matchAll(/export\s+async\s+function\s+(\w+)\s*\([^)]*\)[^{]*\{/g)) {
    let depth = 0, end = code.length
    for (let i = m.index! + m[0].length - 1; i < code.length; i++) { if (code[i] === "{") depth++; else if (code[i] === "}" && --depth === 0) { end = i; break } }
    const body = code.slice(m.index! + m[0].length, end)
    const svc = body.search(/\bcreateServiceClient\s*\(/)
    if (svc < 0) continue
    const g = body.search(SESSION_GATE)
    if (g < 0 || g > svc) out.push(m[1])
  }
  return out
}
/** The doors this audit closed (wave 139, 139G) — each must stay gated before its service client. */
const CLOSED_DOORS = ["app/actions/portal-document-requests.ts", "app/actions/portal-loan-checklist.ts", "app/actions/compliance/seed-required-docs.ts", "app/actions/buyer-offer/record-seller-signed-counter.ts", "app/actions/education-tutor.ts"]
const reopened = CLOSED_DOORS.flatMap((f) => serviceBeforeGate(read(f)).map((fn) => `${f} ${fn}`))
const svcFirst = RUNTIME.flatMap((f) => serviceBeforeGate(read(f)).map((fn) => `${f}:${fn}`))
console.log(`    census: ${svcFirst.length} "use server" exports reach the service client before a gate-shaped call (published, not failed: most are public-by-design doors — home value, landing pages, RSVP, recruit inquiry; the open list is in the 139G notes)`)
check(`S1 the ${CLOSED_DOORS.length} doors 139G closed gate on the session before the service client`, reopened.length === 0, reopened.join(", "))
check("S2 POSITIVE CONTROL — an ungated service-client export is caught; the same export gated first is not; a non-\"use server\" module is out of scope",
  serviceBeforeGate(`"use server"\nexport async function leak(id: string) { const svc = createServiceClient(); return svc }`).join() === "leak" &&
  serviceBeforeGate(`"use server"\nexport async function ok(id: string) { const a = await requireContactAccess(id); const svc = createServiceClient() }`).length === 0 &&
  serviceBeforeGate(`export async function lib(id: string) { const svc = createServiceClient() }`).length === 0)

console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
if (fail) { console.log("FAILURES:\n  - " + fails.join("\n  - ")); process.exit(1) }
