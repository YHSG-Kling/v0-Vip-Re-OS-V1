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
 *   V  TENANT VOCABULARY (wave 140, lane A+M) — no tenant-facing app/**​/*.tsx
 *      renders "platform-covered"; the ruling-named 140J sites are a ratchet.
 *   X  READINESS MATRIX (wave 140, lane A+M) — docs/architecture/READINESS-MATRIX.md
 *      covers every census capability with status, action, lane and real cites.
 *   G  RELEASE GATE (wave 141, lane 141J) — EVERY owner gate of the wave-141
 *      ruling mapped to the proof(s) and canary(ies) that certify it; a gate
 *      reads CERTIFIED only when every proof is registered, in a guard chain and
 *      on disk, and every canary is in the roster with no WAVE141 HOOK pending (of the
 *      lanes the gate's contract names, when `hookLanes` narrows it — lane 141K) —
 *      otherwise NOT CERTIFIED with its reasons (never silently green). The
 *      verdict line "RELEASE: READY / NOT READY" is the integrator's reading;
 *      "guards green" alone is never READY.
 *   B  PRODUCTION BLOCKERS (wave 142, lane 142I) — every blocker of the wave-141
 *      final report re-proved at HEAD from code + header stamps and CLASSIFIED
 *      (PASS / BLOCKED / WAITING_EXTERNAL / PENDING lane / UNSUPPORTED); the
 *      legal-forms default rule (a per-tenant default is absent or certified);
 *      the Playwright UI smoke wiring; no live row is read.
 *   G′ WAVE 142 GATES (lane 142I) — the thirteen wave-142 ruling areas mapped to
 *      the proof keys lanes 142A–G register BY CONTRACT, hookLanes naming the lane;
 *      canaries are lane 142J's (the integrator fills the column from its notes).
 *
 * Measurement (CLAUDE.md §2): code tokens are read from stripComments +
 * blankStrings source; every absence assertion has a positive control.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings, blankComments, stringLiterals } from "./strip-comments"
import { runtimeFiles, walkTs } from "./runtime-roots"
import { LIVE_TABLES } from "./live-tables"
import { CANARY_KEYS, WAVE141_HOOKS, hookCensus } from "./canaries/_registry"
import { CRON_REGISTRY } from "../lib/kernel/cron-dispatch"
import { CRON_MANAGER, MAINTENANCE_DOMAINS, MANAGERS } from "../lib/kernel/manager-registry"
import { WEBHOOK_CONTRACT, type WebhookContractEntry } from "../lib/providers/webhook-contract"
import { classifyProxyPath } from "../app/constants/auth"
import { TENANT_POLICY_SETTINGS_KEYS } from "../lib/kernel/tenant-policy"
import { claimOf } from "./migration-status"
import { providerOfferVerdict, DEFAULT_ESIGN_PROVIDER } from "../lib/integrations/providers/catalog"

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
  // vendor_tier_pricing: FINDING P1 (139G) CLOSED by wave 140J — the vendor checkout
  // (app/actions/vendor-billing.ts createVendorSubscriptionCheckout) now resolves the
  // administered override through resolveTierPrice and refuses an unset price
  // (price_not_configured); the key has a consuming reader, so K2 retires the exception.
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
function doorOf(users: string[], ui: Set<string>, edges: (f: string) => string[], fronts: string[] = []): string | null {
  for (const f of users) if (ui.has(f)) return f
  for (const g of ui) { const hit = edges(g).find((t) => users.includes(t)); if (hit) return `${g} → ${hit}` }
  // law 4 (UI → service → domain module): a NAMED kernel front that itself imports the persister, imported directly by
  // a user-layer module. The front is named per table, never discovered — hub over-reach stays excluded.
  for (const front of fronts) {
    const persister = edges(front).find((t) => users.includes(t))
    if (!persister) continue
    for (const g of ui) if (edges(g).includes(front)) return `${g} → ${front} → ${persister}`
  }
  return null
}
/** Window tables with NO user door BY DESIGN — platform/cron-internal evidence or caches, each with its reason. */
const DOORLESS_BY_DESIGN: Record<string, string> = {}
/** Wave 145 (lane 145I, the one editor of this census this wave): doorless-by-design rulings for tables ANOTHER wave-145
 *  lane's migration adds. While that migration is not in the tree the table is not in the window, so the entry is
 *  PENDING (printed, never stale); the moment the table enters the window the entry becomes an ordinary
 *  DOORLESS_BY_DESIGN row and U2's staleness rule applies to it unchanged (the rule, not the waypoint). */
const DOORLESS_BY_DESIGN_PENDING_LANE: Record<string, { lane: string; reason: string }> = {
  protected_research_attributes: { lane: "145F (m864)", reason: "research-only store (owner ruling 12, wave 145F): service-role writes, RLS SELECT for platform staff / same-tenant compliance_officer; no user door by design until the owner decides the research roles and surface" },
}
/** Landed = the lane's migration put the table in the window AND its runtime code uses it (a migration without its code is
 *  M1's finding, not this ruling's). */
const pendingLanded = (t: string) => windowTables.includes(t) && (tableUse.get(t)?.length ?? 0) > 0
for (const [t, e] of Object.entries(DOORLESS_BY_DESIGN_PENDING_LANE)) if (pendingLanded(t)) DOORLESS_BY_DESIGN[t] = e.reason
console.log(`    pending-lane doorless rulings: ${Object.entries(DOORLESS_BY_DESIGN_PENDING_LANE).map(([t, e]) => `${t} (${e.lane}) ${pendingLanded(t) ? "LANDED — now an ordinary ruling" : windowTables.includes(t) ? "pending: migration present, runtime code not" : "pending: table not in this tree's window"}`).join("; ") || "none"}`)
/** Tables whose persisting module is fronted by a kernel service (wave 142: the forms-submit route stopped importing
 *  lib/kernel/person-identity.ts directly once capture consolidated onto captureFormSubmission → captureContact, so the
 *  identity layer's doors are all one service deep — the contact brief, the CRM command set, the capture pipeline). */
const DOOR_FRONTS: Record<string, string[]> = {
  person_identities: ["lib/contacts/contact-brief.ts", "lib/kernel/crm.ts", "lib/contact-pipeline/contact-capture.ts"],
  person_identity_evidence: ["lib/contacts/contact-brief.ts", "lib/kernel/crm.ts", "lib/contact-pipeline/contact-capture.ts"],
  // wave 145 (lane 145Z; m866, lane 145G contract C4): the humanized final's version ledger is persisted by
  // lib/marketing/humanize-final.ts; a PERSON reaches it through the lead-magnet publish door (app/actions/lead-magnets-actions.ts
  // → publishLeadMagnet records the approved final that went live) — the kernel front named here, never discovered.
  distribution_finals: ["lib/kernel/lead-magnets.ts"],
}
const doors = new Map(windowTables.map((t) => [t, doorOf(tableUse.get(t)!, userLayer, importEdges, DOOR_FRONTS[t] ?? [])]))
const doorless = windowTables.filter((t) => tableUse.get(t)!.length > 0 && !doors.get(t))
const unexplainedDoorless = doorless.filter((t) => !DOORLESS_BY_DESIGN[t])
console.log(`    census: ${pages.length} pages reach ${reachable.size} runtime modules (${userLayer.size} in the user layer); ${windowTables.length - doorless.length}/${windowTables.length} window tables have a door; ${doorless.length} doorless (${Object.keys(DOORLESS_BY_DESIGN).length} by design)`)
for (const t of windowTables) console.log(`      ${t}: ${doors.get(t) ? `door ${doors.get(t)}` : DOORLESS_BY_DESIGN[t] ? `doorless by design — ${DOORLESS_BY_DESIGN[t]}` : "NO DOOR"}`)
console.log("    BLIND SPOT: a door is an import/fetch edge, not a rendered control — a panel that imports the service for a constant counts; computed fetch paths are not followed; a capability with no window table (pure code) is censused by test:orphan-routes / orphan-export, not here.")
check("U1 every window table with runtime use has a user door (or is classified doorless by design)", unexplainedDoorless.length === 0, unexplainedDoorless.join(", "))
check("U1b POSITIVE CONTROL — a named front that does NOT import the persister is not a door; one that does, imported by a user-layer module, is",
  doorOf(["p.ts"], new Set(["app/x.ts"]), (f) => (f === "app/x.ts" ? ["front.ts"] : []), ["front.ts"]) === null
  && doorOf(["p.ts"], new Set(["app/x.ts"]), (f) => (f === "app/x.ts" ? ["front.ts"] : f === "front.ts" ? ["p.ts"] : []), ["front.ts"]) === "app/x.ts → front.ts → p.ts")
const staleFronts = Object.keys(DOOR_FRONTS).filter((t) => !windowTables.includes(t))
check("U1c every DOOR_FRONTS table is a window table (a retired name cannot sit in the map reading as fronted)", staleFronts.length === 0, staleFronts.join(", "))
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

// ═════════════════════════════════════════════════════════════════════════════
// WAVE 140 (lane A+M) — READINESS MATRIX + TENANT-FACING VOCABULARY.
// ═════════════════════════════════════════════════════════════════════════════

// ── V · TENANT-FACING VOCABULARY ─────────────────────────────────────────────
console.log("\n[V · tenant-facing vocabulary — no \"platform-covered\" in a .tsx a tenant can read (owner, wave 140)]")
/** Platform-staff surfaces: an operator reads the cost-bearing entity by name there, by design. */
const PLATFORM_FACING = /^app\/dashboard\/superadmin\//
/** Wave 140P widened the census from "platform-covered" to the whole family the ruling names
 *  ("platform-paid", "we cover") — the approved wording is "included in your subscription" /
 *  "never counted as your spend". */
const FORBIDDEN_TENANT_VOCAB = /platform[- ](covered|paid)|\bwe cover\b/i
/** PURE — offending line numbers of a .tsx module. Comments are stripped (a tombstone or a JSX
 *  comment is not copy); STRINGS AND JSX TEXT ARE KEPT — the rendered words are the subject. */
function tenantVocabHits(src: string): number[] {
  const out: number[] = []
  stripComments(src).split("\n").forEach((l, i) => { if (FORBIDDEN_TENANT_VOCAB.test(l)) out.push(i + 1) })
  return out
}
/** The sites the wave-140 ruling named, owned by lane 140J. A RATCHET, not a waypoint: this list may
 *  only shrink; when it reaches zero hits it is deleted. Lane 140J rewrote all four (leads :202,
 *  brand-listening-card :31, admin/import :339, financials/brokerage :1052) to "included in your
 *  subscription" — the census read 0 at 496ab27fa, so the owned list is EMPTY and the ratchet is 0
 *  (wave 140P). Every tenant-facing hit is now a NEW finding under V1. */
const TENANT_VOCAB_OWNED: Record<string, string> = {}
/** 0 since wave 140P (was 4 at the wave-140 base). */
const TENANT_VOCAB_RATCHET = 0
const tenantTsx = SRC_FILES.filter((f) => f.startsWith("app/") && f.endsWith(".tsx") && !PLATFORM_FACING.test(f))
const vocabHits = tenantTsx.map((f) => ({ f, lines: tenantVocabHits(read(f)) })).filter((h) => h.lines.length)
const vocabNew = vocabHits.filter((h) => !TENANT_VOCAB_OWNED[h.f])
const vocabOwnedCount = vocabHits.filter((h) => TENANT_VOCAB_OWNED[h.f]).reduce((n, h) => n + h.lines.length, 0)
console.log(`    census: ${tenantTsx.length} tenant-facing .tsx modules (app/** minus ${SRC_FILES.filter((f) => PLATFORM_FACING.test(f) && f.endsWith(".tsx")).length} platform-staff); ${vocabHits.length} render "platform-covered"`)
for (const h of vocabHits) console.log(`      ${h.f}:${h.lines.join(",")}${TENANT_VOCAB_OWNED[h.f] ? "  (owned)" : "  NEW"}`)
console.log("    BLIND SPOT: .ts server-action result strings and lib/ copy are not in this population (at HEAD every .ts hit is a comment); a phrase assembled from fragments is not seen.")
check("V1 no tenant-facing .tsx outside the 140J-owned list renders \"platform-covered\"", vocabNew.length === 0, vocabNew.map((h) => `${h.f}:${h.lines.join(",")}`).join(", "))
check(`V2 the 140J-owned ratchet only shrinks (${vocabOwnedCount} ≤ ${TENANT_VOCAB_RATCHET})`, vocabOwnedCount <= TENANT_VOCAB_RATCHET)
const vanishedOwned = Object.keys(TENANT_VOCAB_OWNED).filter((f) => !existsSync(join(ROOT, f)))
check("V3 every owned file still exists (a renamed file re-enters the census under its new name)", vanishedOwned.length === 0, vanishedOwned.join(", "))
check("V4 POSITIVE CONTROL — JSX text and a string literal are caught (platform-covered, platform-paid, we cover); a JSX comment, a line comment and the approved wording are not",
  tenantVocabHits(`export default function P() { return <p>Platform-covered — never billed</p> }`).length === 1 &&
  tenantVocabHits(`const s = "raw sourcing is platform-covered"`).length === 1 &&
  tenantVocabHits(`export default function P() { return <p>Platform-paid (not your cost)</p> }`).length === 1 &&
  tenantVocabHits(`const s = "we cover enrichment for you"`).length === 1 &&
  tenantVocabHits(`export default function P() { return <p>{/* platform-covered */}x</p> }\n// platform-covered ledger\n// platform-paid ledger`).length === 0 &&
  tenantVocabHits(`const s = "included in your subscription — never counted as your spend"`).length === 0 &&
  tenantVocabHits(`const s = "Covered by the platform (not the tenant's cost)"`).length === 0)
check("V5 the platform-staff exclusion is narrow (superadmin only) and the population is non-empty", tenantTsx.length > 100 && !PLATFORM_FACING.test("app/dashboard/admin/import/page.tsx") && PLATFORM_FACING.test("app/dashboard/superadmin/a2p/page.tsx"))

/** V6 (wave 141, lane 141I — owner, PROVIDER VISIBILITY: "Never expose to a tenant: platform-paid /
 *  platform-covered / internal credentials / internal provider billing or configuration"): the widened
 *  vocabulary. An ENV-VAR-SHAPED secret name (FOO_API_KEY, FOO_SECRET, FOO_TOKEN) rendered in a string
 *  literal or JSX text of a tenant-facing .tsx is platform configuration on a tenant screen. A
 *  `process.env.X` read is code, not copy; NEXT_PUBLIC_* names are public by contract; a code identifier
 *  (MANUAL_CHAIN_KEY) is not copy either — only literals and element text count. Measured at 01a71c3c2:
 *  /settings/providers ("Requires: DID_API_KEY + ELEVENLABS_API_KEY in environment"), the Zoom join
 *  fallback note (ZOOM_SDK_KEY/ZOOM_SDK_SECRET) and the ungated system-providers console — all three
 *  fixed by the lane (wording → capability status; the console gated, see V7). */
const ENV_SECRET_NAME = /\b(?!NEXT_PUBLIC_)[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:API_KEY|KEY|SECRET|TOKEN)\b/g
/** PURE — offending line numbers: env-var-shaped names inside string literals or JSX text (comments stripped). */
function envNameHits(src: string): number[] {
  const stripped = stripComments(src)
  const ranges: Array<[number, number]> = stringLiterals(stripped).map((l) => [l.start, l.end])
  for (const m of stripped.matchAll(/>([^<>{}]+)</g)) ranges.push([m.index! + 1, m.index! + 1 + m[1].length])
  const out: number[] = []
  for (const m of stripped.matchAll(ENV_SECRET_NAME)) {
    const i = m.index!
    const pre = stripped.slice(Math.max(0, i - 16), i)
    if (/process\.env\.$|process\.env\[\s*["']$/.test(pre)) continue
    if (!ranges.some(([s, e]) => i >= s && i + m[0].length <= e)) continue
    const line = stripped.slice(0, i).split("\n").length
    if (!out.includes(line)) out.push(line)
  }
  return out
}
/** Platform consoles that live OUTSIDE app/dashboard/superadmin/ and legitimately render provider config
 *  — each named with the gate that keeps a tenant out; V7 proves the gate is real, not a label. */
const PLATFORM_CONSOLES_OUTSIDE_SUPERADMIN: Record<string, { gatedBy: string; gateFile: string; gateCall: RegExp }> = {
  "app/dashboard/admin/system/providers/system-providers-client.tsx": { gatedBy: "mounted only by ./page.tsx, which awaits requireSuperadmin() and refuses IN PLACE (RoleGateNotice — page-role-gate-roster P5, never a silent redirect) before rendering", gateFile: "app/dashboard/admin/system/providers/page.tsx", gateCall: /requireSuperadmin\(\)[\s\S]*if\s*\(!gate\.ok\)\s*return\s*<RoleGateNotice\b[\s\S]*<SystemProvidersClient/ },
}
const envHits = tenantTsx.map((f) => ({ f, lines: envNameHits(read(f)) })).filter((h) => h.lines.length)
const envNew = envHits.filter((h) => !PLATFORM_CONSOLES_OUTSIDE_SUPERADMIN[h.f])
console.log(`    census (V6): ${envHits.length} tenant-facing .tsx render an env-var-shaped secret name in copy; ${Object.keys(PLATFORM_CONSOLES_OUTSIDE_SUPERADMIN).length} classified platform console(s) outside the superadmin path`)
for (const h of envHits) console.log(`      ${h.f}:${h.lines.join(",")}${PLATFORM_CONSOLES_OUTSIDE_SUPERADMIN[h.f] ? "  (platform console — gated)" : "  NEW"}`)
console.log("    BLIND SPOT: a name assembled from fragments, or read from a config object the page renders, is not seen; a provider's DISPLAY name (Twilio, SendGrid) is allowed — the rule is configuration and credentials, not vendor names.")
check("V6 no tenant-facing .tsx renders an env-var-shaped secret name in a string literal or JSX text (platform configuration never reaches a tenant screen)", envNew.length === 0, envNew.map((h) => `${h.f}:${h.lines.join(",")}`).join(", "))
const ungatedConsoles = Object.entries(PLATFORM_CONSOLES_OUTSIDE_SUPERADMIN).filter(([f, g]) => !existsSync(join(ROOT, f)) || !existsSync(join(ROOT, g.gateFile)) || !g.gateCall.test(codeOf(read(g.gateFile))) || !/import\s*\{[^}]*SystemProvidersClient[^}]*\}\s*from\s*["']\.\/system-providers-client["']/.test(stripComments(read(g.gateFile))) || /export\s+default/.test(codeOf(read(f))))
check("V7 every classified platform console outside the superadmin path is REAL: its file exists, it exports no default page, and its named gate file awaits the platform gate and refuses in place before mounting it", ungatedConsoles.length === 0, ungatedConsoles.map(([f]) => f).join(", "))
check("V8 POSITIVE CONTROL — an env name in JSX text and in a string literal is caught; a process.env read, a NEXT_PUBLIC_ name, a code identifier and a comment are not",
  envNameHits(`export default function P() { return <p>Requires: DID_API_KEY in environment</p> }`).length === 1 &&
  envNameHits(`const rows = [{ envKey: "ZENROWS_API_KEY" }]`).length === 1 &&
  envNameHits(`const k = process.env.DID_API_KEY; const j = process.env["ELEVENLABS_API_KEY"]`).length === 0 &&
  envNameHits(`const s = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!); const t = "NEXT_PUBLIC_MAPBOX_TOKEN"`).length === 0 &&
  envNameHits(`const MANUAL_CHAIN_KEY = "listing-appt-prep"; run({ chainKey: MANUAL_CHAIN_KEY })`).length === 0 &&
  envNameHits(`// needs DID_API_KEY\n/* and ZOOM_SDK_SECRET */\nconst x = 1`).length === 0)

// ── X · READINESS MATRIX ─────────────────────────────────────────────────────
console.log("\n[X · readiness matrix — docs/architecture/READINESS-MATRIX.md covers every capability, with status, action, lane and real citations]")
const MATRIX = "docs/architecture/READINESS-MATRIX.md"
const matrix = existsSync(join(ROOT, MATRIX)) ? read(MATRIX) : ""
/** The census capabilities (wave 140, lane A): a row per entry, matched case-insensitively on the first cell. */
const MATRIX_CAPABILITIES = ["tenant creation", "subscription activation", "provisioning", "snapshot/template", "entitlements", "feature flags", "tenant policies", "brokerage/global settings", "manager initialization", "website creation", "portals", "seats/users", "teams/roles", "phone provisioning", "A2P", "communication defaults", "billing", "Stripe", "provider credentials", "Mapbox", "self-healing", "readiness/health checks"]
const STATUS_VOCAB = ["BUILT", "PARTIAL", "DUPLICATED", "UNWIRED", "MISSING"]
const ACTION_VOCAB = ["KEEP", "WIRE", "FIX", "CONSOLIDATE", "BUILD"]
interface MatrixRow { capability: string; status: string | null; action: string | null; lane: string | null }
/** PURE — the capability rows of the matrix table (cells: capability | survivor | callers | status | edge | action). */
function parseMatrixRows(md: string): MatrixRow[] {
  const rows: MatrixRow[] = []
  for (const line of md.split("\n")) {
    if (!line.startsWith("|")) continue
    const cells = line.split("|").slice(1, -1).map((c) => c.trim())
    if (cells.length < 6 || /^-+$/.test(cells[0]) || /^capability$/i.test(cells[0])) continue
    rows.push({
      capability: cells[0],
      status: STATUS_VOCAB.find((s) => new RegExp(`\\b${s}\\b`).test(cells[3])) ?? null,
      action: ACTION_VOCAB.find((a) => new RegExp(`\\b${a}\\b`).test(cells[5])) ?? null,
      lane: cells[5].match(/\b140[A-M]\b/)?.[0] ?? null,
    })
  }
  return rows
}
const matrixRows = parseMatrixRows(matrix)
const rowFor = (cap: string) => matrixRows.find((r) => r.capability.toLowerCase() === cap.toLowerCase())
const missingRows = MATRIX_CAPABILITIES.filter((c) => !rowFor(c))
const incompleteRows = matrixRows.filter((r) => !r.status || !r.action || !r.lane).map((r) => `${r.capability} (status ${r.status ?? "?"}, action ${r.action ?? "?"}, lane ${r.lane ?? "?"})`)
const matrixCites = [...matrix.matchAll(/`((?:lib|app|scripts|supabase|docs|\.github)\/[A-Za-z0-9_./\[\]-]+\.(?:ts|tsx|sql|md|yml|json))(?::(\d+))?`/g)]
const badMatrixCites = [...new Set(matrixCites.filter(([, f, line]) => !existsSync(join(ROOT, f)) || (!!line && Number(line) > read(f).split("\n").length)).map(([, f, l]) => `${f}${l ? ":" + l : ""}`))]
const statusTally = STATUS_VOCAB.map((s) => `${s} ${matrixRows.filter((r) => r.status === s).length}`).join(", ")
console.log(`    census: ${matrixRows.length} rows / ${MATRIX_CAPABILITIES.length} capabilities; ${statusTally}; ${matrixCites.length} citations`)
check("X1 the readiness matrix exists", matrix.length > 0)
check(`X2 every census capability (${MATRIX_CAPABILITIES.length}) has a row`, missingRows.length === 0, missingRows.join(", "))
check("X3 every row carries a STATUS, an ACTION and an owning wave-140 lane", matrixRows.length > 0 && incompleteRows.length === 0, incompleteRows.join("; "))
check(`X4 every file:line the matrix cites exists (${matrixCites.length})`, matrixCites.length > 0 && badMatrixCites.length === 0, badMatrixCites.join(", "))
check("X5 the production architecture doc links the matrix", doc.includes("READINESS-MATRIX.md"))
check("X6 POSITIVE CONTROL — a row with no status / no lane is incomplete; a header or rule row is skipped; a full row parses",
  (() => {
    const r = parseMatrixRows("| Capability | S | C | Status | E | Action |\n|---|---|---|---|---|---|\n| specimen | `x.ts:1` | d | ok | e | FIX — 140J |\n| specimen2 | s | c | PARTIAL | e | BUILD — 140D |")
    return r.length === 2 && r[0].status === null && r[0].lane === "140J" && r[1].status === "PARTIAL" && r[1].action === "BUILD" && r[1].lane === "140D"
  })())

// ═════════════════════════════════════════════════════════════════════════════
// WAVE 142 (lane 142I) — THE PRODUCTION BLOCKERS RE-PROVED AT HEAD.
// The wave-141 final report closed with nine owner blockers (fifteen items). Each is re-proved here
// from CODE — stripped source (a comment or a tombstone is not a rule), header stamps (a migration
// file's own claim, read through the ONE classifier scripts/migration-status.ts claimOf) and the
// workflow files — and CLASSIFIED beside its check:
//   PASS              the code-side rule holds at HEAD (everything the repo can prove);
//   BLOCKED           an owner / platform-staff configuration the code refuses to fake (an env key, a
//                     Stripe price, a tier snapshot, owner-held DDL) — the code's refusal IS the proof;
//   WAITING_EXTERNAL  a credential, a DNS record or a run that lives outside the repo;
//   PENDING <lane>    a wave-142 lane contract whose proof key has not landed (reads NOT CERTIFIED in G′);
//   UNSUPPORTED       a stated limitation — never a fake control.
// This guard reads NO live row: the live database has not been operated (support_tickets 0, offers 0,
// every render table 0 on 2026-10-19), so any live reader of an operational count classifies "0 rows"
// NOT_APPLICABLE, never PASS; the structural checks below (columns, policies, settings, routes) are the
// code-provable half.
// ═════════════════════════════════════════════════════════════════════════════

// ── B · PRODUCTION BLOCKERS ──────────────────────────────────────────────────
console.log("\n[B · production blockers re-proved at HEAD — the code-side rule of every wave-141 blocker, classified]")
/** Comments blanked, STRINGS INTACT — the probe's subject is a literal (a table, a status, an env key, a vendor). */
const bc = (p: string) => blankComments(read(p))
type ProofState = "ok" | "absent" | "unchained" | "no-file"
/** Every guard* chain joined — membership is the word-boundary rule, never a position (wave 107). */
const guardChain = Object.entries(pkg.scripts).filter(([k]) => k.startsWith("guard")).map(([, v]) => v).join(" && ")
/** PURE — one proof key's state: registered in package.json, in a guard chain, its script on disk. */
function proofStateFor(key: string, scripts: Record<string, string>, chain: string, fileExists: (rel: string) => boolean): ProofState {
  const script = scripts[key]
  if (!script) return "absent"
  if (!new RegExp(`npm run ${esc(key)}(\\s|&|$)`).test(chain)) return "unchained"
  const file = script.match(/(scripts\/[\w./\[\]-]+\.ts)/)?.[1]
  if (file && !fileExists(file)) return "no-file"
  return "ok"
}
const proofState = (key: string) => proofStateFor(key, pkg.scripts, guardChain, (rel) => existsSync(join(ROOT, rel)))
type BlockerClass = "PASS" | "BLOCKED" | "WAITING_EXTERNAL" | "PENDING" | "UNSUPPORTED"
interface BlockerRow { id: string; blocker: string; classification: BlockerClass; who: string; reading: string }
const blockerRows: BlockerRow[] = []
const classify = (id: string, blocker: string, classification: BlockerClass, who: string, reading: string) => { blockerRows.push({ id, blocker, classification, who, reading }) }

// B1 — SECRETS_ENCRYPTION_KEY + re-seal
const secretCrypto = codeOf(read("lib/security/secret-crypto.ts"))
const readinessCode = codeOf(read("lib/kernel/tenant-readiness.ts"))
const readinessBc = bc("lib/kernel/tenant-readiness.ts")
/** PURE — the readiness contract's security check BLOCKS (never passes, never repairs) when encryption is unconfigured. */
function securityCheckFailsClosed(code: string): boolean {
  return /requiredSecurityState:\s*async[\s\S]{0,600}?if\s*\(!configured\)\s*return\s+blocked\(/.test(code)
}
check("B1 SECRETS_ENCRYPTION_KEY — a new secret write refuses without it (SecretStorageRefusedError), isEncryptionConfigured is the one reader, the readiness contract BLOCKS requiredSecurityState (never repairs), the re-seal action exists and is mounted on the OS Sentinel board, and the key is a CORE env (E1–E3)",
  /class SecretStorageRefusedError/.test(secretCrypto) && /export function isEncryptionConfigured/.test(secretCrypto) && securityCheckFailsClosed(readinessCode)
  && /export async function resealLegacyPlaintextSecretsAction/.test(codeOf(read("app/actions/superadmin/secret-migration.ts")))
  && /\bresealLegacyPlaintextSecretsAction\b/.test(codeOf(read("app/dashboard/superadmin/sentinel/os-sentinel-board.tsx")))
  && (CORE_ENV as readonly string[]).includes("SECRETS_ENCRYPTION_KEY"))
check("B1c POSITIVE CONTROL — a security check that PASSES when unconfigured is not fail-closed; one that BLOCKS is",
  !securityCheckFailsClosed(`requiredSecurityState: async (c) => { const configured = x(); if (!configured) return pass(""); return pass("") },`)
  && securityCheckFailsClosed(`requiredSecurityState: async (c) => { const configured = x(); if (!configured) return blocked(""); return pass("") },`))
classify("B1", "SECRETS_ENCRYPTION_KEY in Production + re-seal", "BLOCKED", "owner sets the Vercel env; platform staff run the OS Sentinel re-seal", "code refuses plaintext and blocks readiness without the key; the env value is not readable here")

// B2 — the four required platform lanes (Twilio voice_sms, email, Stripe payments, AI gateway ai_llm)
const requiredCats = [...(readinessBc.match(/REQUIRED_PROVIDER_CATEGORIES[^=]*=\s*new Set\(\[([^\]]*)\]\)/)?.[1] ?? "").matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]).sort()
const RULING_LANES = ["ai_llm", "email", "payments", "voice_sms"]
check(`B2 the required provider lanes are exactly the ruling's four (${requiredCats.join(", ") || "none read"}), a dark required lane BLOCKS the readiness contract (owner: platform), the posture derives platform_dark from an absent platform key, and each lane's env key is written in .env.example`,
  requiredCats.join() === RULING_LANES.join() && /providerState:\s*async[\s\S]{0,900}?if\s*\(darkRequired\.length\)\s*return\s+blocked\(/.test(readinessCode)
  && /return \{ state: "platform_dark", ready: false \}/.test(bc("lib/platform/provider-posture.ts"))
  && ["TWILIO_ACCOUNT_SID", "SENDGRID_API_KEY", "STRIPE_SECRET_KEY", "AI_GATEWAY_API_KEY"].every((n) => envExampleNames.has(n)))
classify("B2", "Twilio / email / Stripe / AI-gateway lanes lit at platform level", "BLOCKED", "platform staff set the platform env keys", "the contract blocks providerState while a required lane is dark; the keys are not readable here")

// B3 — Stripe tier / seat / metered / setup / vendor prices
const planCatalog = bc("lib/billing/plan-catalog.ts")
check("B3 prices are NEVER code literals: PRICE_NOT_CONFIGURED is the one typed state, isConfiguredPriceCents the one test, the plan checkout refuses through planPriceNotConfigured, the incident is raised through raisePriceNotConfiguredIncident, and the price proofs (plan-catalog, billing-convergence) are chained",
  /export const PRICE_NOT_CONFIGURED = "price_not_configured"/.test(planCatalog) && /export function isConfiguredPriceCents/.test(planCatalog)
  && /planPriceNotConfigured\(/.test(codeOf(read("lib/billing/subscription-activation.ts")))
  && /export async function raisePriceNotConfiguredIncident/.test(codeOf(read("lib/billing/price-not-configured.ts")))
  && proofState("test:plan-catalog") === "ok" && proofState("test:billing-convergence") === "ok")
classify("B3", "Stripe tier / seat / metered / setup / vendor price ids", "BLOCKED", "owner administers subscription_tiers.*_price_cents + Stripe price ids", "every money move refuses price_not_configured; the live catalogue is not read here (the database has not been operated)")

// B4 — one canonical config snapshot per tier
const trialFunnel = bc("lib/platform/trial-funnel.ts")
const canonicalTiers = [...(bc("lib/kernel/tenant-creation.ts").match(/export const CANONICAL_TIERS[^=]*=\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1])
check(`B4 the tier snapshot is read from platform_config_snapshots by payload.recommendedTier and is null when absent; the readiness contract BLOCKS the snapshot check without one; ${canonicalTiers.length} canonical tier(s) each need one (${canonicalTiers.join(", ")})`,
  /\.from\("platform_config_snapshots"\)[\s\S]{0,300}?\.eq\("payload->>recommendedTier", tier\)/.test(trialFunnel) && /if \(error \|\| !data\) return null/.test(trialFunnel)
  && /snapshot:\s*async[\s\S]{0,600}?if\s*\(!snap\)\s*return\s+blocked\(/.test(readinessCode) && canonicalTiers.length >= 4)
classify("B4", "one canonical config snapshot per tier", "BLOCKED", "platform staff capture one snapshot per canonical tier", `${canonicalTiers.length} tiers; the contract blocks the snapshot check for a tenant on a tier with none`)

// B5 — owner-held DDL + the reviewed superadmin / RLS migration (lane 142A writes it)
const MIG = "supabase/migrations"
const migrationFiles = readdirSync(join(ROOT, MIG)).filter((f) => f.endsWith(".sql"))
const migrationNamed = (n: number) => migrationFiles.find((f) => new RegExp(`^m${n}-`).test(f)) ?? null
const stampOf = (f: string | null) => (f ? claimOf(read(`${MIG}/${f}`)) : "absent")
const ownerSqlStamped = (f: string | null) => !!f && /OWNER SQL/i.test(read(`${MIG}/${f}`).slice(0, 600))
/** PURE — the policy census of an ALTER POLICY migration. SQL `--` comments are removed FIRST (CLAUDE.md §2 — the
 *  same idiom parseMigrationAdds uses); quoted literals are KEPT because the retired inline arm IS a quoted literal.
 *  Counts statements, ALTER POLICY statements, DROPs (refused: the MCP holds destructive DDL for the owner), inline
 *  user_type superadmin arms, and policies confined by neither a brokerage predicate nor a platform identity.
 *  BLIND SPOT: a `--` inside a quoted literal truncates that line (as in parseMigrationAdds). */
function rlsPolicyCensus(sql: string): { statements: number; alterPolicy: number; drops: number; superadminArms: number; unconfined: number } {
  const code = sql.split("\n").map((l) => { const i = l.indexOf("--"); return i >= 0 ? l.slice(0, i) : l }).join("\n")
  const out = { statements: 0, alterPolicy: 0, drops: 0, superadminArms: 0, unconfined: 0 }
  for (const raw of code.split(";")) {
    const stmt = raw.trim()
    if (!stmt) continue
    out.statements++
    if (/^DROP\s/i.test(stmt)) out.drops++
    if (/\bALTER\s+POLICY\b/i.test(stmt)) {
      out.alterPolicy++
      if (/\buser_type\b[^;]*'super_?admin'/i.test(stmt)) out.superadminArms++
      if (!/\bbrokerage_id\b|\bis_platform_admin\s*\(\)|\bis_platform_staff\s*\(\)|\bcurrent_user_brokerage_id\s*\(\)/i.test(stmt)) out.unconfined++
    }
  }
  return out
}
const m739 = migrationNamed(739), m771 = migrationNamed(771), m780 = migrationNamed(780), m781 = migrationNamed(781), m782 = migrationNamed(782)
const m780Sql = m780 ? read(`${MIG}/${m780}`) : ""
check("B5a the owner-held DDL files exist and state their status (739: three DROP INDEX; 771: DROP COLUMN), and 780 defines is_platform_admin + is_platform_staff on platform_role",
  !!m739 && !!m771 && !!m780 && ["applied", "not_applied"].includes(stampOf(m739)) && ["applied", "not_applied"].includes(stampOf(m771))
  && /CREATE OR REPLACE FUNCTION public\.is_platform_admin\(\)/.test(m780Sql) && /CREATE OR REPLACE FUNCTION public\.is_platform_staff\(\)/.test(m780Sql), `739 ${stampOf(m739)}, 771 ${stampOf(m771)}, 780 ${stampOf(m780)}`)
const m781Census = m781 ? rlsPolicyCensus(read(`${MIG}/${m781}`)) : null
check("B5b when the reviewed ALTER POLICY migration (lane 142A's, 781) is present: no DROP statement, ≥1 ALTER POLICY, no inline user_type superadmin arm, every altered policy confined by brokerage or gated on a platform identity, and a stated header",
  !m781 || (m781Census!.drops === 0 && m781Census!.alterPolicy > 0 && m781Census!.superadminArms === 0 && m781Census!.unconfined === 0 && stampOf(m781) !== "unstated"),
  m781Census ? `${m781} ${JSON.stringify(m781Census)} stamp ${stampOf(m781)}` : "absent at HEAD (lane 142A contract)")
const m782Sql = m782 ? read(`${MIG}/${m782}`) : ""
const m782NewCheck = m782Sql.match(/ADD\s+CONSTRAINT\s+users_user_type_check[\s\S]*?\(([\s\S]*?)\)\s*\)?\s*;/i)?.[1] ?? ""
check("B5c when the users_user_type_check file (lane 142A's, 782) is present: it states its status (OWNER SQL, or APPLIED LIVE once the MCP accepted the DROP CONSTRAINT), drops and re-adds users_user_type_check, and the new vocabulary omits 'superadmin'",
  !m782 || ((ownerSqlStamped(m782) || stampOf(m782) === "applied") && /DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?users_user_type_check/i.test(m782Sql) && /ADD\s+CONSTRAINT\s+users_user_type_check/i.test(m782Sql) && m782NewCheck.length > 0 && !/'superadmin'/.test(m782NewCheck)),
  m782 ? `${m782} owner-stamped ${ownerSqlStamped(m782)}, stamp ${stampOf(m782)}` : "absent at HEAD (lane 142A contract)")
check("B5d POSITIVE CONTROL — the policy census catches an inline superadmin arm, an unconfined policy and a DROP; a confined ALTER POLICY passes; a commented-out DROP is not a statement",
  (() => { const c = rlsPolicyCensus("-- DROP POLICY x ON t;\nALTER POLICY p ON public.t USING (user_type = 'superadmin' OR brokerage_id = current_user_brokerage_id());\nALTER POLICY q ON public.t USING (true);\nDROP POLICY r ON public.t;\nALTER POLICY s ON public.t USING (is_platform_admin());"); return c.statements === 4 && c.alterPolicy === 3 && c.superadminArms === 1 && c.unconfined === 1 && c.drops === 1 })())
/** PURE — live authority arms testing the dead user_type 'superadmin' (strings intact, comments blanked). */
function superadminTypeArms(bcSrc: string): number { return (bcSrc.match(/\b(?:user_type|userType)\s*(?:===?|!==?)\s*["']superadmin["']/g) ?? []).length }
const armFiles = [...RT].filter(([, t]) => superadminTypeArms(t.bc) > 0).map(([f]) => f)
console.log(`    reading: ${armFiles.length} runtime file(s) still test user_type === 'superadmin' as an authority arm (lane 142A's census; 0 live rows carry that type): ${armFiles.join(", ") || "none"}`)
check("B5e POSITIVE CONTROL — the arm finder sees a live arm and not a comment", superadminTypeArms(`const s = profile?.user_type === "superadmin" || x`) === 1 && superadminTypeArms(blankComments(`// user_type === "superadmin"\nconst y = 1`)) === 0)
const migClass = (f: string | null, pendingLane: string, who: string): [BlockerClass, string] => !f ? ["PENDING", `${pendingLane} contract — file not landed`] : stampOf(f) === "applied" ? ["PASS", `${f} stamped applied`] : ["BLOCKED", `${f} stamped ${stampOf(f)} — ${who}`]
for (const [id, label, f, lane, who] of [["B5.1", "739 three DROP INDEX", m739, "integrator", "owner SQL editor (the MCP holds destructive DDL)"], ["B5.2", "771 DROP COLUMN global_settings (the retired CRM key — lane 141D)", m771, "integrator", "owner SQL editor"], ["B5.3", "781 ALTER POLICY set (37 policies)", m781, "142A", "integrator applies via MCP, one statement per call"], ["B5.4", "782 users_user_type_check without superadmin", m782, "142A", "owner SQL editor (DROP CONSTRAINT is held)"]] as const) {
  const [cls, reading] = migClass(f, lane, who)
  classify(id, label, cls, who, reading)
}

// B5′ — wave 143 (lane 143H): the decision-gated and the owner-approvable migrations. NOT owner-held DDL (an ALTER POLICY, an
// UPDATE and two ALTER COLUMNs are accepted by the MCP) — they wait on a DECISION, or on a coupled code change shipping in the same
// release. The statements of m795 are reproduced verbatim in docs/operations/OWNER-SQL.md (scripts/operations-docs-guard.ts holds it).
const m795 = migrationNamed(795), m840 = migrationNamed(840), m841 = migrationNamed(841)
for (const [id, label, f, lane, who] of [
  ["B5.5", "795 tenant_safety_findings → platform staff only (changes what tenant admins see)", m795, "142A", "OWNER DECISION (tenant vs platform surface) + the re-homing of its three readers, then the integrator applies"],
  ["B5.6", "840 the title company's preliminary statement has ONE doc_type spelling (data rewrite, 0 rows live)", m840, "143H", "owner approves the vocabulary change; the integrator applies with the four coupled code sites"],
  ["B5.7", "841 global_settings.timezone can say 'not chosen' (NULL = derive from the brokerage's state)", m841, "143H", "the integrator applies; the reaper / milestone bridge / settings form read it in the same release"],
] as const) {
  const [cls, reading] = migClass(f, lane, who)
  classify(id, label, cls, who, reading)
}

// B6 — Mapbox / Open-Meteo / Google Ads declarations + credentials
const adapters = bc("lib/kernel/provider-adapters.ts"), registry = bc("lib/agentic-os/connector-registry.ts")
const adapterEnv = (key: string) => [...(adapters.match(new RegExp(`^\\s*${key}:\\s*\\{[^\\n]*`, "m"))?.[0] ?? "").matchAll(/envVars:\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/"([A-Z0-9_]+)"/g)].map((x) => x[1]))
const b6Env = { mapbox: adapterEnv("mapbox"), open_meteo: adapterEnv("open_meteo"), google_ads: adapterEnv("google_ads") }
check(`B6 Mapbox / Open-Meteo / Google Ads each declare their credential env (${Object.entries(b6Env).map(([k, v]) => `${k}: ${v.join("+") || "none"}`).join("; ")}), every one is written in .env.example, Google Ads speaks ONE version constant with its published sunset, and Mapbox has a platform probe`,
  b6Env.mapbox.includes("MAPBOX_TOKEN") && b6Env.open_meteo.includes("OPEN_METEO_API_KEY") && b6Env.google_ads.includes("GOOGLE_ADS_DEVELOPER_TOKEN")
  && Object.values(b6Env).flat().every((n) => envExampleNames.has(n))
  && /export const GOOGLE_ADS_API_VERSION = "v\d+"/.test(registry) && /deprecatedAfter:\s*GOOGLE_ADS_API_SUNSET_AFTER/.test(adapters)
  && /^\s*mapbox:\s*\{/m.test(bc("lib/agentic-os/connector-probe.ts")))
classify("B6", "Mapbox license + tokens; Open-Meteo commercial key; Google Ads developer token + OAuth", "WAITING_EXTERNAL", "owner obtains the credentials; platform staff set the env", "declarations, env names, version + sunset and the probe are code; the keys are not readable here")

// B7 — certified tenant-selected LEGAL-FORMS + e-sign configurations
/** PURE — inside one "use server" export, the certification verdict is read BEFORE the provider_overrides write. */
function verdictBeforeWrite(bcSrc: string, fn: string): boolean {
  const start = bcSrc.search(new RegExp(`export\\s+async\\s+function\\s+${fn}\\b`))
  if (start < 0) return false
  const body = bcSrc.slice(start)
  const v = body.search(/\bproviderSelectionVerdict\(/), w = body.search(/\.from\("provider_overrides"\)/)
  return v >= 0 && w >= 0 && v < w
}
check("B7 a tenant's e-sign / legal-forms SELECTION is certified by the capability matrix at BOTH write doors (verdict before the provider_overrides write) and in the menu — one rule, providerSelectionVerdict → providerOfferVerdict",
  /providerOfferVerdict\(capability, key\)/.test(codeOf(read("lib/connections/scope.ts")))
  && verdictBeforeWrite(bc("app/actions/settings/integrations.ts"), "upsertProviderOverride") && verdictBeforeWrite(bc("app/actions/settings/provider-settings-actions.ts"), "saveProviderOverride")
  && /providerSelectionVerdict\(/.test(codeOf(read("app/dashboard/settings/integrations/integrations-client.tsx"))))
check("B7c POSITIVE CONTROL — a door that writes before it asks the verdict is caught", !verdictBeforeWrite(`export async function spec() { await svc.from("provider_overrides").upsert({}); providerSelectionVerdict("esign", "x") }`, "spec") && verdictBeforeWrite(`export async function spec() { const v = providerSelectionVerdict("esign", "x"); await svc.from("provider_overrides").upsert({}) }`, "spec"))
classify("B7", "certified tenant-selected legal-forms + e-sign configurations", "PASS", "tenant selects; the matrix certifies", "no tenant has selected yet (the database has not been operated) — per-tenant state is NOT_APPLICABLE live")

// B8 — NO uncertified default legal-forms integration (the kernel table + its settings mirror)
/** PURE — the value a SYSTEM_DEFAULTS table (kernel or mirror) assigns to a provider type: a quoted vendor, an
 *  UPPER_CASE constant (the e-sign default reads the catalog constant), or null when the type has NO default. */
function tableDefault(src: string, type: string): string | null {
  const table = src.match(/SYSTEM_DEFAULTS[^=]*=\s*\{([\s\S]*?)\n\}/)?.[1] ?? ""
  const m = table.match(new RegExp(`^\\s*${type}:\\s*(?:"([a-z_]+)"|([A-Z_]+))\\s*,`, "m"))
  return m ? (m[1] ?? m[2]) : null
}
const kernelTable = bc("lib/kernel/providers.ts"), mirrorTable = bc("app/actions/settings/provider-settings-actions.ts")
const certifiedOrAbsent = (v: string | null) => v === null || providerOfferVerdict("transaction", v).ok
const providerResolver = read("lib/integrations/providers/provider-resolver.ts")
check(`B8 THE LEGAL-FORMS DEFAULT RULE — a per-tenant transaction default in SYSTEM_DEFAULTS (kernel: ${tableDefault(kernelTable, "transaction") ?? "none"}; settings mirror: ${tableDefault(mirrorTable, "transaction") ?? "none"}) is absent or CERTIFIED by the matrix; the e-sign default is the catalog constant and certified; the transaction resolver never consults the kernel default (NONE without a selection)`,
  certifiedOrAbsent(tableDefault(kernelTable, "transaction")) && certifiedOrAbsent(tableDefault(mirrorTable, "transaction"))
  && tableDefault(kernelTable, "esign") === "DEFAULT_ESIGN_PROVIDER" && tableDefault(mirrorTable, "esign") === "DEFAULT_ESIGN_PROVIDER" && providerOfferVerdict("esign", DEFAULT_ESIGN_PROVIDER).ok
  && !/SYSTEM_DEFAULTS/.test(codeOf(providerResolver)) && /source: "none"/.test(blankComments(providerResolver)))
check("B8c POSITIVE CONTROL — the retired `transaction: \"dotloop\"` default is UNCERTIFIED for the capability (its first required cell refuses) and the table reader sees it; the e-sign line is read as the catalog constant",
  !providerOfferVerdict("transaction", "dotloop").ok
  && tableDefault(`export const SYSTEM_DEFAULTS: Readonly<Record<string, string>> = {\n  esign:        DEFAULT_ESIGN_PROVIDER,\n  transaction:  "dotloop",\n  crm:          "follow_up_boss",\n}\n`, "transaction") === "dotloop"
  && tableDefault(`const SYSTEM_DEFAULTS = {\n  esign: DEFAULT_ESIGN_PROVIDER,\n}\n`, "esign") === "DEFAULT_ESIGN_PROVIDER"
  && tableDefault(`const SYSTEM_DEFAULTS = {\n  esign: DEFAULT_ESIGN_PROVIDER,\n}\n`, "transaction") === null)
classify("B8", "no uncertified default legal-forms integration", "PASS", "lane 142I", "the kernel table and its mirror carry no transaction default; the tenant selects a certified provider")

// B9 — the baseline system URL + custom-domain DNS readiness (no wildcard prerequisite)
const siteUrlSrc = bc("lib/platform/site-url.ts")
const hardDomain = (s: string) => /https?:\/\/(?!\$\{)[a-z0-9-]+\.[a-z]{2,}/i.test(s)
check("B9 the baseline website is served at a PATH under the one app origin (tenantWebsitePath = /site/<slug>), the origin resolver hard-codes no domain, and the custom-domain state machine is pending_dns → verifying → active with a fail-closed DNS probe",
  !hardDomain(siteUrlSrc) && /export function siteUrl\(\)/.test(siteUrlSrc)
  && /export function tenantWebsitePath\(slug: string\): string \{ return `\/site\/\$\{slug\}` \}/.test(bc("lib/kernel/tenant-creation.ts"))
  && /export const CUSTOM_DOMAIN_STATUSES = \["pending_dns", "verifying", "active", "error", "removed"\]/.test(bc("lib/platform/custom-domains.ts")) && /export async function probeDomainDns/.test(codeOf(read("lib/platform/custom-domains.ts"))))
check("B9c POSITIVE CONTROL — a hard-coded origin is caught; the VERCEL_URL template is not", hardDomain(`const u = "https://vipagents.com"`) && !hardDomain("return `https://${vercel.trim()}`"))
classify("B9", "subdomain wildcard / DNS readiness", "PASS", "none — the baseline URL needs no wildcard", "path-based baseline; a tenant's own custom domain is WAITING_EXTERNAL per tenant (its DNS)")
classify("B9b", "system subdomain per tenant (wildcard + cert + proxy branch)", "UNSUPPORTED", "owner call", "not built (lane 141G finding stands); the baseline /site/<slug> URL serves every tenant without it")

// B10 — portal privacy settings
/** PURE — privacy switches that neither bind a handler nor are disabled with the truth beside them (a dead toggle). */
function deadSwitches(src: string): number {
  let n = 0
  for (const m of stripComments(src).matchAll(/<Switch\b([^>]*)\/?>/g)) if (!/\bonCheckedChange\b/.test(m[1]) && !/\bdisabled\b/.test(m[1])) n++
  return n
}
const portalSettingsPage = read("app/components/portal/PortalSettingsPage.tsx")
check("B10 the portal's privacy OBLIGATIONS are wired (Request Data Export / Delete file a data-subject request through fileDataSubjectRequestFromPortal) and no privacy switch is a dead toggle (every <Switch> binds onCheckedChange or is disabled with the truth beside it)",
  /export async function fileDataSubjectRequestFromPortal/.test(codeOf(read("app/actions/portal-settings.ts"))) && /\bfileDataSubjectRequestFromPortal\(/.test(codeOf(portalSettingsPage)) && deadSwitches(portalSettingsPage) === 0)
check("B10c POSITIVE CONTROL — a handler-less, enabled switch is a dead toggle; a disabled one and a bound one are not", deadSwitches(`<Switch defaultChecked />`) === 1 && deadSwitches(`<Switch defaultChecked disabled aria-label="x" />`) === 0 && deadSwitches(`<Switch checked={v} onCheckedChange={set} />`) === 0)
classify("B10", "portal privacy settings", "PASS", "none", "DSR export / delete doors wired; the two preference switches are disabled with the truth (no column, writer or reader — UNSUPPORTED preference, stated; owner call to build)")

// B11 — Playwright production UI smoke in CI
const e2eYml = read(".github/workflows/e2e.yml"), pwConfig = bc("playwright.config.ts")
check("B11 the Playwright UI smoke is runnable against a deployed URL: e2e.yml job reads UI_SMOKE_BASE_URL (input or repository variable), states its skip without one, runs `playwright test`; playwright.config.ts reads the same variable and carries a phone-width project; the @smoke spec exists; e2e/README.md documents it; test:e2e is registered",
  /UI_SMOKE_BASE_URL/.test(e2eYml) && /skipped — UI_SMOKE_BASE_URL is not set/.test(e2eYml) && /playwright test/.test(e2eYml)
  && /process\.env\.UI_SMOKE_BASE_URL/.test(pwConfig) && /mobile-chromium/.test(pwConfig)
  && existsSync(join(ROOT, "e2e/ui-smoke.spec.ts")) && /@smoke/.test(read("e2e/ui-smoke.spec.ts")) && /UI_SMOKE_BASE_URL/.test(read("e2e/README.md")) && !!pkg.scripts["test:e2e"])
classify("B11", "Playwright production smoke in CI", "WAITING_EXTERNAL", "owner sets UI_SMOKE_BASE_URL (repository variable) or dispatches with a preview URL", "the job, the config read and the spec are code; no browser and no app env exist in this container, so no run is claimed")

// B12 — tenant support isolation (lane 142A's contract)
/** PURE — the retired cross-brokerage arm: a TENANT user type admitted to every brokerage's tickets. */
const supportTypeArm = (bcSrc: string) => /\b(?:userType|user_type)\s*===?\s*["']support["']/.test(bcSrc)
const supportArmPresent = supportTypeArm(bc("app/actions/support.ts"))
const b12Key = proofState("test:support-isolation")
console.log(`    reading B12: test:support-isolation ${b12Key}; the tenant-type 'support' cross-brokerage arm in app/actions/support.ts is ${supportArmPresent ? "PRESENT (lane 142A removes it)" : "gone"}`)
check("B12 the platform support console gates on requirePlatformCapability(\"support\") — platform_role, never a tenant user_type", /requirePlatformCapability\("support"\)/.test(bc("app/actions/superadmin/support-console.ts")))
check("B12c POSITIVE CONTROL — the 'support' user_type arm is recognised in code and not in a comment", supportTypeArm(`if (ctx.userType === "support") return true`) && !supportTypeArm(blankComments(`// ctx.userType === "support"\nconst x = 1`)))
classify("B12", "tenant support isolation", b12Key === "ok" && !supportArmPresent ? "PASS" : "PENDING", "lane 142A", `proof ${b12Key}; cross-brokerage 'support' arm ${supportArmPresent ? "present" : "gone"}`)

// B13 — CDA policy configuration (brokerage setting present + consistent)
const brokerageCols = [...(read("scripts/schema-snapshot.ts").match(/^\s*brokerages:\s*\[([^\]]*)\]/m)?.[1] ?? "").matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1])
const CDA_COLUMNS = ["offers_cda", "cda_onboarding_at", "non_cda_payout_default"]
const cdaSetup = bc("app/actions/brokerage-cda-setup.ts")
check("B13 the brokerage CDA setting is three live columns (offers_cda, cda_onboarding_at, non_cda_payout_default) with ONE roster-gated writer that stamps all three consistently (payout default null when CDA is offered), read by the commission reconciliation and the CDA page",
  CDA_COLUMNS.every((c) => brokerageCols.includes(c))
  && /export async function setBrokerageCdaSettingAction/.test(cdaSetup) && /offers_cda:\s*input\.offersCda/.test(cdaSetup) && /cda_onboarding_at:\s*new Date\(\)\.toISOString\(\)/.test(cdaSetup) && /non_cda_payout_default:\s*input\.offersCda \? null :/.test(cdaSetup) && /isBrokerageFinanceAdmin\(/.test(cdaSetup)
  && /\.select\("offers_cda\b[^"]*"\)/.test(bc("lib/commission/reconcile-tracking.ts")) && /\.select\("offers_cda\b[^"]*"\)/.test(bc("app/dashboard/transactions/[id]/cda/page.tsx")))
classify("B13", "CDA policy configuration", "PASS", "tenant admin (finance roster) sets it", "structural; a tenant's value is NOT_APPLICABLE live (0 closing_disclosure_agreement rows — never operated)")

// B14 — Remotion / video readiness (lane 142F's playable-output contract)
const renderCoord = bc("lib/remotion/render-coordinator.ts"), mediaHost = bc("lib/remotion/media-host.ts")
const playabilityProbeLanded = /\bftyp\b|\bmoov\b|\bEBML\b|ffprobe|playab/i.test(renderCoord + mediaHost)
const b14Key = proofState("test:video-pipeline-truth")
console.log(`    reading B14: test:video-pipeline-truth ${b14Key}; playable-output probe at the completion path ${playabilityProbeLanded ? "landed" : "pending (lane 142F)"}; live render rows 0 → NOT_APPLICABLE`)
check("B14 the video completion path and its reaper exist (finalizeCoordinatedRender, hostRenderedMedia, video-pipeline-reaper) and ONE status vocabulary (CANONICAL_VIDEO_STATUSES)",
  /export async function finalizeCoordinatedRender/.test(renderCoord) && /export async function hostRenderedMedia/.test(mediaHost) && existsSync(join(ROOT, "lib/video/video-pipeline-reaper.ts")) && /export const CANONICAL_VIDEO_STATUSES/.test(bc("lib/video/video-status.ts")))
classify("B14", "Remotion / video readiness (playable output)", b14Key === "ok" && playabilityProbeLanded ? "PASS" : "PENDING", "lane 142F", `proof ${b14Key}; probe ${playabilityProbeLanded ? "landed" : "pending"}; remotion_composition_renders 0 rows live`)

// B15 — support / incident operations
const immOps = [...(bc("lib/kernel/immediate-operations.ts").match(/export const IMMEDIATE_OPERATIONS = \[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1])
const RULING_OPS = ["tenant_creation", "user_creation", "invitation", "seat_provisioning", "billing_activation", "provider_connection", "phone_a2p"]
check(`B15 support / incident operations: the support-sla cron is registered and owned, its route runs runSupportSlaSweep, IMMEDIATE_OPERATIONS covers the ruling's operations (${immOps.length} declared), the escalation signal has a registered consumer, and tenant readiness is a health detector`,
  CRON_REGISTRY.some((e) => cronBase(e.path) === "/api/cron/support-sla") && unownedCrons([{ path: "/api/cron/support-sla" }], CRON_MANAGER).length === 0
  && /runSupportSlaSweep\(/.test(codeOf(read("app/api/cron/support-sla/route.ts"))) && RULING_OPS.every((o) => immOps.includes(o))
  && /export const OPERATION_SIGNAL_TYPE = "operation_failure_escalated"/.test(bc("lib/kernel/immediate-operations.ts")) && /handleOperationFailureEscalated/.test(codeOf(read("lib/kernel/manager-signals.ts")))
  && /"tenant_readiness"/.test(bc("lib/kernel/os-health.ts")), RULING_OPS.filter((o) => !immOps.includes(o)).join(", "))
classify("B15", "support / incident operations readiness", "PASS", "cron_manager / data_steward", "structural; support_tickets 0 rows live → NOT_APPLICABLE until operated")

// B16 — wave 143 (lane 143H): the operations documents are DERIVED from the code (scripts/operations-docs-guard.ts regenerates
// them and fails on drift), so "every environment name, every provider, every owner step is written down" is checked, not asserted.
const OPS_INV = "docs/operations/ENVIRONMENT-INVENTORY.md", OPS_CERT = "docs/operations/PROVIDER-CERTIFICATION.md"
const OPS_DOCS = [OPS_INV, OPS_CERT, "docs/operations/OWNER-SQL.md", "docs/operations/ACTIVATION-CHECKLIST.md"]
const derivedMarker = (md: string, id: string) => new RegExp(`<!-- GENERATED:${id}:BEGIN -->`).test(md)
const b16Key = proofState("test:operations-docs")
check("B16 the four operations documents exist, the inventory and the certification carry their GENERATED markers, and the guard that holds them to the code is on disk",
  OPS_DOCS.every((p) => existsSync(join(ROOT, p))) && derivedMarker(read(OPS_INV), "env-inventory") && derivedMarker(read(OPS_CERT), "provider-contracts")
  && existsSync(join(ROOT, "scripts/operations-docs-guard.ts")))
check("B16c POSITIVE CONTROL — a hand-written document with no markers is not 'derived'", !derivedMarker("# hand-written inventory\n| NAME | x |\n", "env-inventory") && derivedMarker("<!-- GENERATED:env-inventory:BEGIN -->\nx", "env-inventory"))
classify("B16", "environment inventory, provider certification, owner SQL and activation checklist derived from the code", b16Key === "ok" ? "PASS" : "PENDING", "lane 143H; the integrator registers test:operations-docs", `documents present; proof ${b16Key}`)

console.log("    ┌ blocker table (classification is the reading; the check above it is the rule)")
for (const r of blockerRows) console.log(`    │ ${r.id.padEnd(5)} ${r.classification.padEnd(17)} ${r.blocker} — who: ${r.who} — ${r.reading}`)
const tally = (["PASS", "BLOCKED", "WAITING_EXTERNAL", "PENDING", "UNSUPPORTED"] as BlockerClass[]).map((c) => `${c} ${blockerRows.filter((r) => r.classification === c).length}`).join(", ")
console.log(`    └ census: ${blockerRows.length} rows — ${tally}`)
console.log("    BLIND SPOT: this section reads CODE, HEADER STAMPS and WORKFLOW FILES, never the database or the deployment env — an env key, a Stripe price, a snapshot row, an applied policy or a Playwright run is proven only by the integrator's live check / the recorded CI run; a header stamp is the migration's own claim (test:migration-claim adjudicates it against the ledger).")

// ═════════════════════════════════════════════════════════════════════════════
// WAVE 145 (lane 145I) — A · THE AUTONOMY BOUNDARY. Brief: "Managers coordinate through the kernel only; no
// autonomous production-code mutation without the deployment control." The healing rails already bound WHAT a
// manager may do (lib/kernel/self-healing.ts — declared playbooks only, an invented action refused, money / tenant /
// security / deletion forbidden; lib/kernel/improvement-proposals.ts — a closed subject-kind list, a human decides).
// This census holds the boundary from the other side: no runtime module (everything that ships, so everything a
// manager can reach) carries the SHAPE of a code mutation or a deploy — a source-control / package-manager / deploy
// CLI spawn, a GitHub contents / commit write, a Vercel deployment or deploy-hook call, or a file write under the
// repository source tree. The deployment control is the human PR → CI (guards + build) → Vercel promotion; nothing
// in the runtime may stand in for it. Read on comment-blanked source with strings intact (a URL is a literal),
// each shape with a positive control.
// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[A · autonomy boundary — managers act through the kernel's declared rails; nothing autonomous mutates production code or deploys]")
const CLI_NAMES = ["g" + "it", "npm", "npx", "pnpm", "yarn", "vercel", "gh", "supabase"]
const CLI_SPAWN = new RegExp(`\\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\\(\\s*["'\`](?:${CLI_NAMES.join("|")})\\b`)
/** PURE — the code-mutation / deploy shapes in one comment-blanked module (strings intact). */
function codeMutationShapes(src: string): string[] {
  const out: string[] = []
  if (CLI_SPAWN.test(src)) out.push("spawns a source-control / package-manager / deploy CLI")
  if (/api\.github\.com[^"'`]*\/(?:contents|git\/(?:commits|refs|trees|blobs)|pulls|merges)\b/.test(src) || /\.(?:createOrUpdateFileContents|createCommit|updateRef|createRef)\(/.test(src)) out.push("writes to a GitHub repository")
  if (/\/v\d+\/deployments\b|\/v1\/integrations\/deploy\/|api\.vercel\.com\/[^"'`]*deploy/.test(src)) out.push("creates a Vercel deployment / calls a deploy hook")
  if (/\b(?:writeFile|writeFileSync|appendFile|appendFileSync|rm|rmSync|unlink|unlinkSync|rename|renameSync)\(\s*(?:(?:path\.)?(?:join|resolve)\(\s*process\.cwd\(\)|["'`](?:\.\/)?(?:app|lib|scripts|supabase|components|hooks|remotion)\/)/.test(src)) out.push("writes / deletes a file under the repository source tree")
  return out
}
check("A1 POSITIVE CONTROL — every code-mutation / deploy shape is recognised in code and NOT in a comment; a tmpdir media write and the custom-domain API are not shapes",
  codeMutationShapes(blankComments(`await execFile("${CLI_NAMES[0]}", ["commit", "-am", "x"])`)).length === 1
  && codeMutationShapes(blankComments(`await fetch("https://api.github.com/repos/o/r/contents/lib/x.ts", { method: "PUT" })`)).length === 1
  && codeMutationShapes(blankComments("await fetch(`https://api.vercel.com/v13/deployments?teamId=${t}`, { method: \"POST\" })")).length === 1
  && codeMutationShapes(blankComments(`await writeFile(join(process.cwd(), "lib/kernel/x.ts"), src)`)).length === 1
  && codeMutationShapes(blankComments(`// await execFile("${CLI_NAMES[0]}", ["push"])\n/* fetch("https://api.vercel.com/v13/deployments") */ const x = 1`)).length === 0
  && codeMutationShapes(blankComments("await fs.writeFile(join(os.tmpdir(), \"in.mp4\"), buf)\nawait fetch(`${VERCEL_API}/v10/projects/${p}/domains`)")).length === 0)
{
  const hits = RUNTIME.map((f) => [f, codeMutationShapes(RT.get(f)?.bc ?? "")] as const).filter(([, h]) => h.length > 0)
  check(`A2 no runtime module (${RUNTIME.length} files) carries a code-mutation or deploy shape — the deployment control (human PR → CI guards + build → promotion) is never bypassed`,
    hits.length === 0, hits.map(([f, h]) => `${f}: ${h.join("; ")}`).join(" | "))
  const proposalSrc = bc("lib/kernel/improvement-proposals.ts")
  const kinds = [...(proposalSrc.match(/export const PROPOSAL_SUBJECT_KINDS\s*=\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/["']([a-z_]+)["']/g)].map((m) => m[1])
  const CODE_KIND = /code|deploy|migration|schema|sql|release|commit/
  check(`A3 the improvement-proposal subject kinds (${kinds.join(", ")}) name no code / deploy / migration / SQL kind — a manager can PROPOSE policy, never a code change`,
    kinds.length >= 5 && !kinds.some((k) => CODE_KIND.test(k)), kinds.filter((k) => CODE_KIND.test(k)).join(", "))
  const healSrc = bc("lib/kernel/self-healing.ts")
  const lib = healSrc.split(/export const SELF_HEAL_PLAYBOOKS\s*=\s*\{/)[1]?.split(/\n\}/)[0] ?? ""
  const playbooks = [...lib.matchAll(/^\s{2}([a-z_]+)\s*:\s*\{\s*label:\s*"([^"]*)"/gm)].map((m) => ({ key: m[1], label: m[2] }))
  const codeBooks = playbooks.filter((p) => CODE_KIND.test(p.key) || /\b(code|deploy|commit|migration|release)\b/i.test(p.label))
  check(`A4 the self-healing playbook library (${playbooks.length} declared) holds no code / deploy / migration action — healing re-runs, re-syncs, re-renders and hands off; it never edits code`,
    playbooks.length >= 8 && codeBooks.length === 0, codeBooks.map((p) => p.key).join(", "))
  const healRaw = read("lib/kernel/self-healing.ts")
  check("A5 the self-healing selection validator exists and refuses an INVENTED action and SQL in a parameter (both refusals present)",
    /export function validatePlaybookSelection/.test(healSrc) && /is not a declared playbook/.test(healRaw) && /never LLM → SQL/.test(healRaw))
  console.log(`    reading: ${hits.length} runtime module(s) with a code-mutation / deploy shape · ${kinds.length} proposal kinds · ${playbooks.length} healing playbooks (${playbooks.map((p) => p.key).join(", ")})`)
  console.log("    BLIND SPOT: a shape assembled at runtime (a CLI name or a URL built from variables, a dynamic import of a deploy SDK) is invisible; the Vercel API is allowed for custom-domain attach only (lib/platform/custom-domains.ts), which changes routing config, not code.")
}

// ═════════════════════════════════════════════════════════════════════════════
// WAVE 141 (lane 141J) — THE RELEASE GATE.
// Owner (2026-10-14): "RELEASE GATE: READY requires every PASS in the owner's list (security, tenant
// isolation, role safety, brokerage identity, subscriber migration, Stripe proration, provisioning,
// users/invites, website, custom domain, transaction providers, e-sign, CDA, legal description, CRM
// rules, lead magnets, AI creation, QR/barcode, business card scanner, coupons, A2P, provider
// experience, UI wiring, mobile, self-healing, build/CI). Green guards alone are NOT READY."
// Managers: only the ones registered in lib/kernel/manager-registry.ts MANAGERS at HEAD — the
// registered recruiting_manager included (owner, 2026-10-14) — never an invented one.
// ═════════════════════════════════════════════════════════════════════════════

// ── G · RELEASE GATE ─────────────────────────────────────────────────────────
console.log("\n[G · release gate — every owner gate → the proofs + canaries that certify it; no proof ⇒ NOT CERTIFIED]")
/** The owner's list, verbatim order (the ruling). */
const OWNER_GATE_NAMES = ["security", "tenant isolation", "role safety", "brokerage identity", "subscriber migration", "Stripe proration", "provisioning", "users/invites", "website", "custom domain", "transaction providers", "e-sign", "CDA", "legal description", "CRM rules", "lead magnets", "AI creation", "QR/barcode", "business card scanner", "coupons", "A2P", "provider experience", "UI wiring", "mobile", "self-healing", "build/CI"] as const
interface GateSpec {
  gate: string
  /** package.json test:* keys. Lanes 141A–I's (and 142A–G's) keys are named by CONTRACT (their prompts): while a key is absent the gate reads NOT CERTIFIED. */
  proofs: string[]
  /** scripts/canaries roster keys (CANARY_KEYS); a canary with a WAVE141 HOOK still pending does not certify. */
  canaries: string[]
  /** Lane 141K: when a canary carries hooks for SEVERAL lanes' contracts, the lanes whose pending hook blocks THIS
   *  gate (the lead-magnet canary carries 141E AI-draft/attribution hooks AND the 141F QR allow-list hook — the
   *  QR/barcode gate waits on 141F, not on 141E). Omitted = any pending hook on the canary blocks the gate. */
  hookLanes?: string[]
  /** Workflow files that must exist for the in-repo half of a CI gate. */
  ci?: string[]
  /** A verdict this guard cannot read (it lives outside the repo) — the gate can only reach EXTERNAL, never CERTIFIED, here. */
  external?: string
  /** Wave 142 (lane 142I): the lanes whose contracts the gate waits on — documentation beside hookLanes. */
  lanes?: string[]
}
interface ReleaseGate extends GateSpec { gate: (typeof OWNER_GATE_NAMES)[number] }
const RELEASE_GATES: ReleaseGate[] = [
  // Wave 142 (lane 142I): the lane contracts of wave 142 are added to the gates they certify — a key absent at HEAD
  // reads NOT CERTIFIED until the lane lands (the wave-141 rule, unchanged). test:support-isolation is lane 142A's.
  { gate: "security", proofs: ["test:secrets-rls", "test:credential-migration", "test:rls-public-grant", "test:rls-anon-escape", "test:webhook-contract", "test:production-readiness", "test:support-isolation"], canaries: [], lanes: ["142A"] },
  { gate: "tenant isolation", proofs: ["test:tenant-scope", "test:conditional-tenant-predicate", "test:sessionless-use-server-census", "test:brokerage-identity", "test:support-isolation"], canaries: ["seat", "same-name-brokerage"], lanes: ["142A"] },
  { gate: "role safety", proofs: ["test:role-vocabulary", "test:immediate-operations"], canaries: ["crm-inbound"], hookLanes: ["141B"] },
  { gate: "brokerage identity", proofs: ["test:brokerage-identity"], canaries: ["solo-subscriber", "same-name-brokerage"] },
  { gate: "subscriber migration", proofs: ["test:brokerage-identity"], canaries: ["brokerage-adoption"] },
  { gate: "Stripe proration", proofs: ["test:coupons-and-handoff", "test:stripe-webhook-events"], canaries: ["brokerage-adoption"] },
  { gate: "provisioning", proofs: ["test:subscriber-convergence", "test:tenant-readiness", "test:tenant-baseline", "test:tenant-provisioning-loops"], canaries: ["subscriber", "seat"] },
  { gate: "users/invites", proofs: ["test:seat-user-convergence", "test:immediate-operations"], canaries: ["seat", "user-invite"] },
  { gate: "website", proofs: ["test:tenant-baseline", "test:tenant-creation"], canaries: ["subscriber"] },
  { gate: "custom domain", proofs: ["test:domain-api", "test:custom-domain-flow"], canaries: ["custom-domain"] },
  { gate: "transaction providers", proofs: ["test:transaction-provider-matrix", "test:form-wizard-esign", "test:provider-adapter", "test:listing-offer-lifecycle"], canaries: ["transaction-provider"], lanes: ["142B"] },
  { gate: "e-sign", proofs: ["test:form-wizard-esign", "test:transaction-provider-matrix", "test:listing-offer-lifecycle"], canaries: ["cda-esign", "transaction-provider"], lanes: ["142B"] },
  { gate: "CDA", proofs: ["test:cda-flow", "test:cda-process-chain", "test:cda-esign", "test:transaction-provider-matrix", "test:cda-closing-flow"], canaries: ["cda-esign"], lanes: ["142C"] },
  { gate: "legal description", proofs: ["test:transaction-provider-matrix", "test:cda-closing-flow"], canaries: ["legal-description"], lanes: ["142C"] },
  { gate: "CRM rules", proofs: ["test:crm-boundaries", "test:crm-pull", "test:crm-sync-credential"], canaries: ["crm-outbound", "crm-inbound"] },
  { gate: "lead magnets", proofs: ["test:lead-magnet-creation", "test:lead-magnet-flow", "test:lead-magnet-embed", "test:autonomous-marketing"], canaries: ["lead-magnet"], lanes: ["142E"] },
  { gate: "AI creation", proofs: ["test:lead-magnet-creation", "test:ai-routing-coverage", "test:cost-completeness", "test:autonomous-marketing"], canaries: ["lead-magnet"], lanes: ["142E"] },
  { gate: "QR/barcode", proofs: ["test:qr-and-card-scanner", "test:qr-registry", "test:marketing-qr"], canaries: ["lead-magnet"], hookLanes: ["141F"] },
  { gate: "business card scanner", proofs: ["test:qr-and-card-scanner", "test:entity-types", "test:immediate-enrichment"], canaries: ["business-card"], lanes: ["142D"] },
  { gate: "coupons", proofs: ["test:coupons-and-handoff", "test:plan-catalog"], canaries: ["coupon"] },
  { gate: "A2P", proofs: ["test:phone-a2p-automation", "test:tenant-readiness"], canaries: [] },
  { gate: "provider experience", proofs: ["test:ui-wiring-census", "test:integration-status", "test:provider-adapter", "test:production-readiness"], canaries: [] },
  { gate: "UI wiring", proofs: ["test:ui-wiring-census", "test:no-dead-components", "test:dangling-links", "test:orphan-routes"], canaries: [] },
  { gate: "mobile", proofs: ["test:ui-wiring-census", "test:mobile-readiness"], canaries: ["mobile"] },
  { gate: "self-healing", proofs: ["test:self-healing", "test:os-health", "test:healing-policy"], canaries: ["self-healing"] },
  { gate: "build/CI", proofs: ["test:proxy-graph-budget"], canaries: [], ci: [".github/workflows/build.yml", ".github/workflows/guards.yml"], external: "the build + guards workflow runs green on the RELEASE commit — read from GitHub by the integrator, never from this repo" },
]
type CanaryState = "ok" | "unknown" | "pending"
interface GateVerdict { gate: string; state: "CERTIFIED" | "NOT CERTIFIED" | "EXTERNAL"; owner: string; proofs: Array<{ key: string; state: ProofState }>; canaries: Array<{ key: string; state: CanaryState; lanes: string[] }>; reasons: string[] }
interface GateEnv {
  scripts: Record<string, string>
  /** Every guard* chain joined — membership is the word-boundary rule, never a position. */
  chain: string
  fileExists: (rel: string) => boolean
  roster: readonly string[]
  /** Pending WAVE141 hooks by canary key → lanes. */
  pending: Map<string, string[]>
  /** proof key → accountable manager (MAINTENANCE_DOMAINS); the owner of a gate is the owner of its first registered proof. */
  ownerOf: (proof: string) => string | null
  managers: ReadonlySet<string>
}
/** PURE — one gate's verdict from the environment. */
function certifyGate(g: GateSpec, env: GateEnv): GateVerdict {
  // ONE proof-state rule (proofStateFor, section B) — the blockers table and both gate tables read it.
  const proofs = g.proofs.map((key) => ({ key, state: proofStateFor(key, env.scripts, env.chain, env.fileExists) }))
  const canaries = g.canaries.map((key) => {
    if (!env.roster.includes(key)) return { key, state: "unknown" as CanaryState, lanes: [] }
    // Lane 141K: only the lanes this gate's contract names block it (hookLanes); unnamed = every pending hook blocks.
    const lanes = (env.pending.get(key) ?? []).filter((l) => !g.hookLanes || g.hookLanes.includes(l))
    return { key, state: (lanes.length ? "pending" : "ok") as CanaryState, lanes }
  })
  const reasons: string[] = []
  for (const p of proofs) if (p.state !== "ok") reasons.push(`${p.key} ${p.state === "absent" ? "not registered (lane contract not landed)" : p.state === "unchained" ? "registered but in NO guard chain (certifies nothing in CI)" : "script file missing"}`)
  for (const c of canaries) if (c.state !== "ok") reasons.push(`canary ${c.key} ${c.state === "unknown" ? "not in the roster" : `WAVE141 HOOK pending (${c.lanes.join(", ")})`}`)
  for (const f of g.ci ?? []) if (!env.fileExists(f)) reasons.push(`${f} missing`)
  const ownerProof = proofs.find((p) => p.state !== "absent" && env.ownerOf(p.key))
  const owner = ownerProof ? env.ownerOf(ownerProof.key)! : "unassigned (no registered proof)"
  if (owner !== "unassigned (no registered proof)" && !env.managers.has(owner)) reasons.push(`owner ${owner} is not a registered manager`)
  const clean = reasons.length === 0
  return { gate: g.gate, state: clean ? (g.external ? "EXTERNAL" : "CERTIFIED") : "NOT CERTIFIED", owner, proofs, canaries, reasons: g.external && clean ? [`external verdict required: ${g.external}`] : reasons }
}
// guardChain is defined once in section B (wave 142) and read here.
const proofOwner = new Map<string, string>()
for (const d of Object.values(MAINTENANCE_DOMAINS) as Array<{ manager: string; proof: string }>) if (!proofOwner.has(d.proof)) proofOwner.set(d.proof, d.manager)
const census = hookCensus()
const pendingByCanary = new Map<string, string[]>()
for (const h of census.pending) pendingByCanary.set(h.canary, [...new Set([...(pendingByCanary.get(h.canary) ?? []), h.lane])])
const gateEnv: GateEnv = { scripts: pkg.scripts, chain: guardChain, fileExists: (rel) => existsSync(join(ROOT, rel)), roster: CANARY_KEYS, pending: pendingByCanary, ownerOf: (p) => proofOwner.get(p) ?? null, managers: new Set(Object.keys(MANAGERS)) }
const verdicts = RELEASE_GATES.map((g) => certifyGate(g, gateEnv))
const certified = verdicts.filter((v) => v.state === "CERTIFIED"), external = verdicts.filter((v) => v.state === "EXTERNAL"), notCertified = verdicts.filter((v) => v.state === "NOT CERTIFIED")
const mark = (s: ProofState | CanaryState) => (s === "ok" ? "✓" : s === "pending" ? "⏳" : "✗")
for (const v of verdicts) console.log(`    ${v.state.padEnd(13)} ${v.gate.padEnd(22)} owner ${v.owner.padEnd(22)} proofs ${v.proofs.map((p) => `${p.key.replace(/^test:/, "")}${mark(p.state)}`).join(" ")}${v.canaries.length ? `  canaries ${v.canaries.map((c) => `${c.key}${mark(c.state)}${c.lanes.length ? `(${c.lanes.join("+")})` : ""}`).join(" ")}` : ""}${v.reasons.length ? `\n                  · ${v.reasons.join("\n                  · ")}` : ""}`)
const allProofs = [...new Set(RELEASE_GATES.flatMap((g) => g.proofs))]
const absentProofs = allProofs.filter((k) => !pkg.scripts[k]), unchainedProofs = allProofs.filter((k) => pkg.scripts[k] && !new RegExp(`npm run ${esc(k)}(\\s|&|$)`).test(guardChain))
console.log(`    census: ${RELEASE_GATES.length} owner gates; ${allProofs.length} distinct proofs named — ${allProofs.length - absentProofs.length - unchainedProofs.length} registered+chained, ${unchainedProofs.length} registered but unchained (${unchainedProofs.join(", ") || "none"}), ${absentProofs.length} not landed (${absentProofs.join(", ") || "none"}); ${CANARY_KEYS.length} canaries in the roster; ${WAVE141_HOOKS.length} WAVE141 hooks — ${census.pending.length} pending, ${census.landed.length} landed`)
console.log("    BLIND SPOT: a proof that is registered and chained certifies its gate only as far as its own assertions reach — this table is the MAP, the proofs are the evidence; a canary hook landing is read from stripped source (the lane's module exists), not from the canary having run.")
check(`G1 the gate table names every owner gate exactly once (${OWNER_GATE_NAMES.length})`, RELEASE_GATES.length === OWNER_GATE_NAMES.length && OWNER_GATE_NAMES.every((n) => RELEASE_GATES.filter((g) => g.gate === n).length === 1), OWNER_GATE_NAMES.filter((n) => RELEASE_GATES.filter((g) => g.gate === n).length !== 1).join(", "))
check("G2 every gate names at least one proof (a gate with no proof can never be certified — a table defect, not a reading)", RELEASE_GATES.every((g) => g.proofs.length > 0), RELEASE_GATES.filter((g) => !g.proofs.length).map((g) => g.gate).join(", "))
check("G3 every canary a gate names is in the runner's roster and on disk", RELEASE_GATES.every((g) => g.canaries.every((c) => (CANARY_KEYS as readonly string[]).includes(c) && existsSync(join(ROOT, `scripts/canaries/${c}.ts`)))), RELEASE_GATES.flatMap((g) => g.canaries.filter((c) => !(CANARY_KEYS as readonly string[]).includes(c) || !existsSync(join(ROOT, `scripts/canaries/${c}.ts`)))).join(", "))
check("G4 every roster canary exists on disk and every WAVE141 hook names a roster canary (the census cannot point at nothing)", CANARY_KEYS.every((k) => existsSync(join(ROOT, `scripts/canaries/${k}.ts`))) && WAVE141_HOOKS.every((h) => (CANARY_KEYS as readonly string[]).includes(h.canary)), "")
check("G5 every REGISTERED proof the table names has a MAINTENANCE_DOMAINS owner that is a registered manager (the roster is the registry's, recruiting_manager included)", allProofs.filter((k) => pkg.scripts[k]).every((k) => !proofOwner.has(k) || Object.keys(MANAGERS).includes(proofOwner.get(k)!)), "")
check("G6 POSITIVE CONTROL — a gate naming an unregistered proof is NOT CERTIFIED; one naming a registered+chained proof and a hook-free canary is CERTIFIED; an unchained proof is a reason; a pending hook is a reason; a pending hook of a lane the gate's hookLanes does NOT name is not (and one it names is); an invented owner is refused and recruiting_manager is accepted",
  (() => {
    const env: GateEnv = { scripts: { "test:spec": "tsx scripts/spec.ts", "test:unchained": "tsx scripts/spec.ts" }, chain: "npm run test:spec && npm run test:specialist", fileExists: () => true, roster: ["spec-canary", "hooked"], pending: new Map([["hooked", ["141Z"]]]), ownerOf: (p) => (p === "test:spec" ? "recruiting_manager" : null), managers: new Set(Object.keys(MANAGERS)) }
    const a = certifyGate({ gate: "coupons", proofs: ["test:absent"], canaries: [] }, env)
    const b = certifyGate({ gate: "coupons", proofs: ["test:spec"], canaries: ["spec-canary"] }, env)
    const c2 = certifyGate({ gate: "coupons", proofs: ["test:unchained"], canaries: [] }, env)
    const d = certifyGate({ gate: "coupons", proofs: ["test:spec"], canaries: ["hooked"] }, env)
    const e = certifyGate({ gate: "coupons", proofs: ["test:spec"], canaries: [] }, { ...env, ownerOf: () => "growth_manager" })
    const f = certifyGate({ gate: "coupons", proofs: ["test:spec"], canaries: ["hooked"], hookLanes: ["141Y"] }, env)
    const g2 = certifyGate({ gate: "coupons", proofs: ["test:spec"], canaries: ["hooked"], hookLanes: ["141Z"] }, env)
    return a.state === "NOT CERTIFIED" && b.state === "CERTIFIED" && b.owner === "recruiting_manager" && c2.state === "NOT CERTIFIED" && /NO guard chain/.test(c2.reasons[0]) && d.state === "NOT CERTIFIED" && /141Z/.test(d.reasons[0]) && e.state === "NOT CERTIFIED" && /not a registered manager/.test(e.reasons[0]) && f.state === "CERTIFIED" && g2.state === "NOT CERTIFIED" && /141Z/.test(g2.reasons[0])
  })())
check("G7 POSITIVE CONTROL — the hook census reads STRIPPED source: a probe over a module that names its token only in a comment answers null (the harness strips before every probe)", (() => { const specimen = "// declared_affiliation\nexport const x = 1\n"; return !/\bdeclared_affiliation\b/.test(stripComments(specimen)) && /\bdeclared_affiliation\b/.test(specimen) })())
/** PURE — the gate rows of the matrix's release-gate section: a FIVE-cell table (gate | proofs | canaries |
 *  owner | reading) so section X's six-cell capability parser never reads a gate as a capability. */
function parseGateRows(section: string): string[] {
  return section.split("\n").filter((l) => l.startsWith("|")).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()))
    .filter((cells) => cells.length === 5 && !/^-+$/.test(cells[0]) && !/^gate$/i.test(cells[0])).map((cells) => cells[0].toLowerCase())
}
const gateDoc = matrix.split(/^## /m).find((s) => /^Wave 141 release gate/i.test(s)) ?? ""
const gateRows = parseGateRows(gateDoc)
const gateDocMissing = OWNER_GATE_NAMES.filter((n) => !gateRows.includes(n.toLowerCase()))
check("G8a POSITIVE CONTROL — the gate-row parser reads a five-cell row, skips the header and the rule, and ignores a six-cell capability row", parseGateRows("| Gate | P | C | O | R |\n|---|---|---|---|---|\n| coupons | a | b | c | d |\n| six | a | b | c | d | e |").join() === "coupons" && parseMatrixRows("| coupons | a | b | c | d |").length === 0)
check(`G8 docs/architecture/READINESS-MATRIX.md carries the release-gate table with a row per owner gate (${gateRows.length}/${OWNER_GATE_NAMES.length})`, gateDoc.length > 0 && gateDocMissing.length === 0, gateDocMissing.join(", "))
check("G9 the production architecture doc names the release gate section", /release gate/i.test(doc))

// ── G′ · WAVE 142 GATES (lane 142I) ──────────────────────────────────────────
// The wave-142 ruling's FINAL VERIFICATION list (the lane-J canary areas): security/support, listing, offer,
// FormWizard, preliminary HUD/CD, CDA, commissions/payment, lifetime, intelligence, marketing, video,
// AI/support/education, commercial/platform. Each maps to the proof keys lanes 142A–G register BY CONTRACT
// (their prompts) plus the chained survivors that already certify the area; `hookLanes` names the lane whose
// pending canary hook blocks the gate (the same rule as the wave-141 table). The canary column is lane 142J's
// (scripts/canaries/*): it is EMPTY here on purpose — the integrator fills it from lane J's notes, and G3 then
// holds every named canary to the roster.
console.log("\n[G′ · wave 142 gates — the ruling's thirteen areas → the lane contracts (A–G) + chained survivors]")
const WAVE142_LANE_IDS = ["142A", "142B", "142C", "142D", "142E", "142F", "142G", "142H", "142I", "142J"]
/** The proof keys lanes 142A–G register, BY CONTRACT — read from $S/prompt142A…G (one owner per key). */
const WAVE142_CONTRACT_PROOFS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "142A": ["test:support-isolation"], "142B": ["test:listing-offer-lifecycle"], "142C": ["test:cda-closing-flow"],
  "142D": ["test:immediate-enrichment", "test:entity-types"], "142E": ["test:autonomous-marketing"], "142F": ["test:video-pipeline-truth"], "142G": ["test:ai-by-your-side"],
})
const WAVE142_GATES: GateSpec[] = [
  { gate: "security/support", lanes: ["142A"], hookLanes: ["142A"], proofs: ["test:support-isolation", "test:cross-tenant-read", "test:platform-discriminator", "test:support-console"], canaries: [] },
  { gate: "listing", lanes: ["142B"], hookLanes: ["142B"], proofs: ["test:listing-offer-lifecycle", "test:listing-compliance-loop", "test:listing-documents-gate", "test:esign-execution-loop"], canaries: [] },
  { gate: "offer", lanes: ["142B"], hookLanes: ["142B"], proofs: ["test:listing-offer-lifecycle", "test:offer-compliance-loop", "test:transaction-creation-gate", "test:esign-execution-loop"], canaries: [] },
  { gate: "FormWizard", lanes: ["142B"], hookLanes: ["142B"], proofs: ["test:listing-offer-lifecycle", "test:form-wizard-esign", "test:transaction-provider-matrix"], canaries: [] },
  { gate: "preliminary HUD/CD", lanes: ["142C"], hookLanes: ["142C"], proofs: ["test:cda-closing-flow", "test:cda-flow"], canaries: [] },
  { gate: "CDA", lanes: ["142C"], hookLanes: ["142C"], proofs: ["test:cda-closing-flow", "test:cda-esign", "test:cda-delivery"], canaries: [] },
  { gate: "commissions/payment", lanes: ["142C"], hookLanes: ["142C"], proofs: ["test:cda-closing-flow", "test:commission-ledger-sync", "test:commission-finalization"], canaries: [] },
  { gate: "lifetime", lanes: ["142C"], hookLanes: ["142C"], proofs: ["test:cda-closing-flow", "test:lifetime-ledger", "test:conversion-finality"], canaries: [] },
  { gate: "intelligence", lanes: ["142D"], hookLanes: ["142D"], proofs: ["test:entity-types", "test:immediate-enrichment", "test:business-card-classification", "test:enrichment-one-rail", "test:provider-adapter"], canaries: [] },
  { gate: "marketing", lanes: ["142E"], hookLanes: ["142E"], proofs: ["test:autonomous-marketing", "test:lead-magnet-creation", "test:topic-claim-scope"], canaries: [] },
  { gate: "video", lanes: ["142F"], hookLanes: ["142F"], proofs: ["test:video-pipeline-truth", "test:render-from-approval", "test:did-live-agent"], canaries: [] },
  { gate: "AI/support/education", lanes: ["142G"], hookLanes: ["142G"], proofs: ["test:ai-by-your-side", "test:immediate-operations", "test:curriculum-author"], canaries: [] },
  { gate: "commercial/platform", lanes: ["142H", "142I", "142J"], hookLanes: ["142H", "142I", "142J"], proofs: ["test:production-readiness", "test:tenant-readiness", "test:subscriber-convergence", "test:coupons-and-handoff", "test:ui-wiring-census", "test:canaries"], canaries: [] },
]
const verdicts142 = WAVE142_GATES.map((g) => certifyGate(g, gateEnv))
const certified142 = verdicts142.filter((v) => v.state === "CERTIFIED"), notCertified142 = verdicts142.filter((v) => v.state !== "CERTIFIED")
for (const v of verdicts142) console.log(`    ${v.state.padEnd(13)} ${v.gate.padEnd(22)} owner ${v.owner.padEnd(22)} lanes ${(WAVE142_GATES.find((g) => g.gate === v.gate)!.lanes ?? []).join("+").padEnd(14)} proofs ${v.proofs.map((p) => `${p.key.replace(/^test:/, "")}${mark(p.state)}`).join(" ")}${v.reasons.length ? `\n                  · ${v.reasons.join("\n                  · ")}` : ""}`)
const contractKeys = Object.values(WAVE142_CONTRACT_PROOFS).flat()
const contractLanded = contractKeys.filter((k) => proofState(k) === "ok"), contractPending = contractKeys.filter((k) => proofState(k) === "absent"), contractUnchained = contractKeys.filter((k) => proofState(k) === "unchained")
console.log(`    census: ${WAVE142_GATES.length} wave-142 gates; ${contractKeys.length} lane contract keys — ${contractLanded.length} landed+chained (${contractLanded.join(", ") || "none"}), ${contractUnchained.length} registered but unchained (${contractUnchained.join(", ") || "none"}), ${contractPending.length} pending (${contractPending.join(", ") || "none"}); canary column: lane 142J's (empty here by design)`)
check("G10 every wave-142 gate names ≥1 proof and waits on a wave-142 lane (hookLanes ⊆ the lane ids); every lane contract key (A–G) is named by ≥1 wave-142 gate",
  WAVE142_GATES.every((g) => g.proofs.length > 0 && (g.hookLanes ?? []).length > 0 && g.hookLanes!.every((l) => WAVE142_LANE_IDS.includes(l))) && contractKeys.every((k) => WAVE142_GATES.some((g) => g.proofs.includes(k))),
  contractKeys.filter((k) => !WAVE142_GATES.some((g) => g.proofs.includes(k))).join(", "))
check("G11 no contract key is claimed by two lanes, and every non-contract proof a wave-142 gate names is registered + chained TODAY (a survivor named here must already certify)",
  new Set(contractKeys).size === contractKeys.length && WAVE142_GATES.flatMap((g) => g.proofs).filter((k) => !contractKeys.includes(k)).every((k) => proofState(k) === "ok"),
  WAVE142_GATES.flatMap((g) => g.proofs).filter((k) => !contractKeys.includes(k) && proofState(k) !== "ok").join(", "))
check("G12 POSITIVE CONTROL — a wave-142 gate naming an absent contract key reads NOT CERTIFIED 'not registered (lane contract not landed)'; a 142-lane hook pending on a named canary blocks only a gate whose hookLanes names that lane",
  (() => {
    const env142: GateEnv = { ...gateEnv, scripts: { "test:spec": "tsx scripts/spec.ts" }, chain: "npm run test:spec", fileExists: () => true, roster: ["hooked142"], pending: new Map([["hooked142", ["142F"]]]), ownerOf: () => "data_steward" }
    const a = certifyGate({ gate: "specimen", proofs: ["test:__wave142_specimen__"], canaries: [], hookLanes: ["142Z"] }, env142)
    const b = certifyGate({ gate: "video", proofs: ["test:spec"], canaries: ["hooked142"], hookLanes: ["142F"] }, env142)
    const c3 = certifyGate({ gate: "marketing", proofs: ["test:spec"], canaries: ["hooked142"], hookLanes: ["142E"] }, env142)
    return a.state === "NOT CERTIFIED" && /not registered/.test(a.reasons[0]) && b.state === "NOT CERTIFIED" && /142F/.test(b.reasons[0]) && c3.state === "CERTIFIED"
  })())
const gateDoc142 = matrix.split(/^## /m).find((s) => /^Wave 142 release gate/i.test(s)) ?? ""
const gateRows142 = parseGateRows(gateDoc142)
console.log(`    reading: READINESS-MATRIX.md "Wave 142 release gate" section ${gateDoc142 ? `present — ${gateRows142.length} gate row(s)` : "absent (lane 142J writes it; the integrator fills the canary column from its notes)"}`)
check("G13 when the matrix carries a wave-142 release-gate section, it has a five-cell row per wave-142 gate (the rule applies the moment the section lands)",
  !gateDoc142 || WAVE142_GATES.every((g) => gateRows142.includes(g.gate.toLowerCase())), WAVE142_GATES.filter((g) => !gateRows142.includes(g.gate.toLowerCase())).map((g) => g.gate).join(", "))

// ═════════════════════════════════════════════════════════════════════════════
// WAVE 145 (lane 145I) — G″ · THE WAVE-145 CLOSURE GATES. The owner's 2026-10-27 rulings, grouped by the lane-J canary
// areas (security · listings · financial onboarding · providers/channels · lead/contact · signals · marketing ·
// compliance/UX) plus this lane's managers/production closure and lane J's canary runner. Each gate names the CHAINED
// survivors that already certify its area and the NEW proof keys its lane published ("## package.json keys to add" in
// $S/lane145X-notes.md, collected by lane 145I — the one editor of the registry this wave). A lane that had NOT
// published when lane 145I closed is `null` here: every gate waiting on it reads NOT CERTIFIED with that reason, never
// silently green. Ruling 23 ("form-bucket security is release-blocking until the live storage policies are applied and
// verified") is the security gate's EXTERNAL verdict until every brokerage-forms storage.objects migration of lane
// 145A carries the applied stamp (the MCP cannot alter storage.objects — 42501 — so the owner applies it in the SQL
// editor with OWNER-SQL §F's verification queries); the stamp is read through the ONE classifier (claimOf).
// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[G″ · wave 145 gates — the owner's 2026-10-27 rulings → the lane contracts (145A–J) + chained survivors]")
const WAVE145_LANE_IDS = ["145A", "145B", "145C", "145D", "145E", "145F", "145G", "145H", "145I", "145J"] as const
/** NEW proof keys per wave-145 lane (null = the lane had not published its notes when lane 145I closed). */
const WAVE145_CONTRACT_PROOFS: Readonly<Record<(typeof WAVE145_LANE_IDS)[number], readonly string[] | null>> = Object.freeze({
  "145A": ["test:transfer-classification"], "145B": ["test:listing-coming-soon-live-date"], "145C": ["test:agreement-governance"], "145D": ["test:channel-provider-matrix"], "145E": [],
  "145F": ["test:lifetime-signals"], "145G": ["test:content-distribution"], "145H": ["test:accessibility-preferences", "test:team-checklist"], "145I": [], "145J": ["test:wave145-canaries"],
})
const contract145 = (lane: (typeof WAVE145_LANE_IDS)[number]) => WAVE145_CONTRACT_PROOFS[lane] ?? []
/** Lane 145A's form-bucket policy migrations (its assigned range m854–m855) that touch storage.objects for brokerage-forms. */
const FORM_BUCKET_POLICY_MIGRATIONS = [854, 855].map(migrationNamed).filter((f): f is string => !!f)
  .filter((f) => { const sql = read(`${MIG}/${f}`); return /storage\.objects/i.test(sql) && /brokerage-forms/.test(sql) })
const formBucketApplied = FORM_BUCKET_POLICY_MIGRATIONS.length > 0 && FORM_BUCKET_POLICY_MIGRATIONS.every((f) => stampOf(f) === "applied")
const FORM_BUCKET_EXTERNAL = formBucketApplied ? undefined
  : `ruling 23 — the brokerage-forms storage.objects policies (${FORM_BUCKET_POLICY_MIGRATIONS.join(", ") || "lane 145A's m854–m855, not in the tree"}; docs/operations/OWNER-SQL.md §F) are applied in the owner SQL editor and verified with §F's queries — release-blocking until the migration carries the applied stamp`
interface Wave145Gate extends GateSpec { gate: string; rulings: string; lanes: Array<(typeof WAVE145_LANE_IDS)[number]> }
const WAVE145_GATES: Wave145Gate[] = [
  { gate: "security", rulings: "23, 24", lanes: ["145A"], hookLanes: ["145A"], canaries: [], external: FORM_BUCKET_EXTERNAL,
    proofs: ["test:tenant-scope", "test:brokerage-identity", "test:form-wizard-esign", "test:support-isolation", ...contract145("145A")] },
  { gate: "listings", rulings: "1, 2", lanes: ["145B"], hookLanes: ["145B"], canaries: [],
    proofs: ["test:listing-offer-lifecycle", "test:journey-promotion-gates", "test:listing-compliance-loop", ...contract145("145B")] },
  { gate: "financial onboarding", rulings: "3–10", lanes: ["145C"], hookLanes: ["145C"], canaries: [],
    proofs: ["test:agreement-waterfall", "test:cap-cycle", "test:concession-ledger", "test:closing-compliance", "test:proposal-compliance-gate", "test:referral-payouts", ...contract145("145C")] },
  { gate: "providers/channels", rulings: "13", lanes: ["145D"], hookLanes: ["145D"], canaries: [],
    proofs: ["test:vendor-retirement", "test:provider-readiness", "test:provider-cost-routing", "test:egress-coverage", ...contract145("145D")] },
  { gate: "lead/contact", rulings: "15, 16, 17", lanes: ["145E"], hookLanes: ["145E"], canaries: [],
    proofs: ["test:intent-driven-followup", "test:next-best-experience", "test:conversion-welcome", "test:welcome-avatar-video", "test:conversion-finality", "test:speed-to-lead", ...contract145("145E")] },
  { gate: "signals", rulings: "11, 12, 14", lanes: ["145F"], hookLanes: ["145F"], canaries: [],
    proofs: ["test:signal-integrity", "test:versium-capability-matrix", "test:enrichment-one-rail", "test:local-intel", ...contract145("145F")] },
  { gate: "marketing", rulings: "19, 20, 22", lanes: ["145G"], hookLanes: ["145G"], canaries: [],
    proofs: ["test:brand-listening", "test:book-publishing", "test:tv-spot", "test:content-studio", ...contract145("145G")] },
  { gate: "compliance/UX", rulings: "18, 21", lanes: ["145H"], hookLanes: ["145H"], canaries: [],
    proofs: ["test:adaptive-vocabulary", "test:closing-compliance", "test:education-delivery", "test:check-vocabulary", ...contract145("145H")] },
  { gate: "managers/production", rulings: "brief 145I (chains, registry, autonomy boundary)", lanes: ["145I"], hookLanes: ["145I"], canaries: [],
    proofs: ["test:parent-child-graph", "test:manager-ownership", "test:production-readiness", "test:orphaned-children", "test:manager-cross-cooperation", ...contract145("145I")] },
  { gate: "canaries", rulings: "every ruling + contracts C1–C7", lanes: ["145J"], hookLanes: ["145J"], canaries: [],
    proofs: [...contract145("145J")] },
]
/** PURE — a wave-145 gate's verdict: certifyGate's, then NOT CERTIFIED while a lane it waits on has no published contract. */
function certify145(g: GateSpec & { lanes: readonly string[]; rulings?: string }, env: GateEnv, contracts: Readonly<Record<string, readonly string[] | null>>): GateVerdict {
  const v = certifyGate(g, env)
  const unpublished = g.lanes.filter((l) => contracts[l] === null)
  if (!unpublished.length) return v
  return { ...v, state: "NOT CERTIFIED", reasons: [...unpublished.map((l) => `lane ${l} had not published its contract (notes) when lane 145I closed`), ...v.reasons.filter((r) => !/^external verdict required/.test(r))] }
}
const verdicts145 = WAVE145_GATES.map((g) => certify145(g, gateEnv, WAVE145_CONTRACT_PROOFS))
const certified145 = verdicts145.filter((v) => v.state === "CERTIFIED"), external145 = verdicts145.filter((v) => v.state === "EXTERNAL"), notCertified145 = verdicts145.filter((v) => v.state === "NOT CERTIFIED")
for (const v of verdicts145) console.log(`    ${v.state.padEnd(13)} ${v.gate.padEnd(22)} owner ${v.owner.padEnd(22)} lanes ${(WAVE145_GATES.find((g) => g.gate === v.gate)!.lanes ?? []).join("+").padEnd(6)} proofs ${v.proofs.map((p) => `${p.key.replace(/^test:/, "")}${mark(p.state)}`).join(" ")}${v.reasons.length ? `\n                  · ${v.reasons.join("\n                  · ")}` : ""}`)
const contractKeys145 = WAVE145_LANE_IDS.flatMap((l) => contract145(l))
const unpublished145 = WAVE145_LANE_IDS.filter((l) => WAVE145_CONTRACT_PROOFS[l] === null)
console.log(`    census: ${WAVE145_GATES.length} wave-145 gates; ${contractKeys145.length} lane contract keys (${contractKeys145.filter((k) => proofState(k) === "ok").length} landed+chained, ${contractKeys145.filter((k) => proofState(k) === "unchained").length} registered but unchained, ${contractKeys145.filter((k) => proofState(k) === "absent").length} pending); lanes unpublished at 145I close: ${unpublished145.join(", ") || "none"}; form-bucket policy migrations: ${FORM_BUCKET_POLICY_MIGRATIONS.map((f) => `${f} (${stampOf(f)})`).join(", ") || "none in the tree"}`)
check("G14 every wave-145 gate names ≥1 proof or waits on an unpublished lane, waits only on wave-145 lanes, and every published contract key is named by ≥1 wave-145 gate",
  WAVE145_GATES.every((g) => (g.proofs.length > 0 || g.lanes.some((l) => WAVE145_CONTRACT_PROOFS[l] === null)) && g.lanes.length > 0 && g.lanes.every((l) => (WAVE145_LANE_IDS as readonly string[]).includes(l)))
  && contractKeys145.every((k) => WAVE145_GATES.some((g) => g.proofs.includes(k))),
  contractKeys145.filter((k) => !WAVE145_GATES.some((g) => g.proofs.includes(k))).join(", "))
check("G15 no wave-145 contract key is claimed by two lanes, and every SURVIVOR a wave-145 gate names is registered + chained TODAY",
  new Set(contractKeys145).size === contractKeys145.length && WAVE145_GATES.flatMap((g) => g.proofs).filter((k) => !contractKeys145.includes(k)).every((k) => proofState(k) === "ok"),
  WAVE145_GATES.flatMap((g) => g.proofs).filter((k) => !contractKeys145.includes(k) && proofState(k) !== "ok").join(", "))
check("G16 POSITIVE CONTROL — a gate waiting on an unpublished lane reads NOT CERTIFIED even when its survivors are green; the form-bucket rule makes a green security gate EXTERNAL (never CERTIFIED) until the policy migration is stamped applied",
  (() => {
    const env145: GateEnv = { ...gateEnv, scripts: { "test:spec": "tsx scripts/spec.ts" }, chain: "npm run test:spec", fileExists: () => true, roster: [], pending: new Map(), ownerOf: () => "data_steward" }
    const waiting = certify145({ gate: "x", rulings: "", lanes: ["145B"], proofs: ["test:spec"], canaries: [] }, env145, { "145B": null })
    const ext = certify145({ gate: "security", rulings: "", lanes: ["145A"], proofs: ["test:spec"], canaries: [], external: "ruling 23" }, env145, { "145A": ["test:spec"] })
    const ok = certify145({ gate: "y", rulings: "", lanes: ["145A"], proofs: ["test:spec"], canaries: [] }, env145, { "145A": ["test:spec"] })
    return waiting.state === "NOT CERTIFIED" && /145B/.test(waiting.reasons[0]) && ext.state === "EXTERNAL" && ok.state === "CERTIFIED"
  })())
const gateDoc145 = matrix.split(/^## /m).find((s) => /^Wave 145 release gate/i.test(s)) ?? ""
const gateRows145 = parseGateRows(gateDoc145)
console.log(`    reading: READINESS-MATRIX.md "Wave 145 release gate" section ${gateDoc145 ? `present — ${gateRows145.length} gate row(s)` : "absent"}`)
check("G17 when the matrix carries a wave-145 release-gate section, it has a row per wave-145 gate (the rule applies the moment the section lands)",
  !gateDoc145 || WAVE145_GATES.every((g) => gateRows145.includes(g.gate.toLowerCase())), WAVE145_GATES.filter((g) => !gateRows145.includes(g.gate.toLowerCase())).map((g) => g.gate).join(", "))

// ═════════════════════════════════════════════════════════════════════════════
// WAVE 146 (lane 146I) — G‴ · THE WAVE-146 GATES. The owner's 2026-10-29 rulings in the spec's priority order (ruling 20:
// (1) the Supabase access-control exposure, (2) bidirectional communication and the corrected welcome, (3) Customer 360 and
// the advertising paths, (4) every exposed product journey), one gate per lane brief. Each names the CHAINED survivors that
// already certify its area and the NEW proof keys its lane published ("## package.json keys to add" in $S/lane146X-notes.md,
// collected by lane 146I, the one editor of the registry this wave); a lane that had not published when 146I closed is `null`
// and every gate waiting on it reads NOT CERTIFIED with that reason. The security gate is EXTERNAL while ANY storage.objects
// policy migration (lane 145A's brokerage-forms m854–m855, and lane 146A's sibling-bucket set in its range m874–m875) lacks
// the applied stamp — storage.objects is owner SQL-editor (the MCP is refused with 42501), read through the ONE classifier.
// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[G‴ · wave 146 gates — the owner's 2026-10-29 rulings → the lane contracts (146A–J) + chained survivors]")
const WAVE146_LANE_IDS = ["146A", "146B", "146C", "146D", "146E", "146F", "146G", "146H", "146I", "146J"] as const
/** NEW proof keys per wave-146 lane (null = the lane had not published its notes when lane 146I closed). */
const WAVE146_CONTRACT_PROOFS: Readonly<Record<(typeof WAVE146_LANE_IDS)[number], readonly string[] | null>> = Object.freeze({
  "146A": [], "146B": ["test:inbound-communication"], "146C": [], "146D": ["test:customer-360"], "146E": ["test:ads-tv-connections"],
  "146F": ["test:lead-magnet-promise"], "146G": ["test:manager-governance-change", "test:manager-duplicate-proofs"], "146H": ["test:ui-palette-contrast", "test:ui-capability-surface"], "146I": [], "146J": ["test:wave146-canaries"],
})
const contract146 = (lane: (typeof WAVE146_LANE_IDS)[number]) => WAVE146_CONTRACT_PROOFS[lane] ?? []
/** Every storage.objects policy migration of the two security lanes' ranges (145A m854–m855, 146A m874–m875). */
const STORAGE_POLICY_MIGRATIONS_146 = [854, 855, 874, 875].map(migrationNamed).filter((f): f is string => !!f)
  .filter((f) => /storage\.objects/i.test(read(`${MIG}/${f}`)))
const storageApplied146 = STORAGE_POLICY_MIGRATIONS_146.length > 0 && STORAGE_POLICY_MIGRATIONS_146.every((f) => stampOf(f) === "applied")
const STORAGE_EXTERNAL_146 = storageApplied146 ? undefined
  : `ruling 20 (1) — the storage.objects policies (${STORAGE_POLICY_MIGRATIONS_146.filter((f) => stampOf(f) !== "applied").join(", ") || "none in the tree"}) are applied in the owner SQL editor and verified (docs/operations/OWNER-SQL.md §F / §G; LIVE: public.storage_bucket_policy_readiness() — the go-live board's storage_policies probe reads 'ready' only when every private document bucket is owner_scoped / service_only) — release-blocking until each migration carries the applied stamp`
// The LIVE read is wired into the go-live board (wave 146, 146Z on lane 146A's Outside-lane 1): a static guard cannot call the
// database, so it holds the WIRING — the required probe calls the readiness rpc, never reads a migration stamp, and fails closed.
const goLiveSrc = stripComments(read("lib/platform/go-live-readiness.ts"))
const storageProbe = /d\("storage_policies",[^)]*,\s*false\)[\s\S]*?svc\.rpc\("storage_bucket_policy_readiness"\)[\s\S]*?owner_scoped[\s\S]*?service_only/.exec(goLiveSrc)?.[0] ?? ""
check("G22 the go-live board carries a REQUIRED storage_policies probe that reads the LIVE policy state (rpc storage_bucket_policy_readiness), names no migration stamp, and reads an empty answer as broken (never ready)",
  storageProbe.length > 0 && !/APPLIED|stampOf|claimOf|WRITTEN, NOT APPLIED/.test(storageProbe) && /rows\.length === 0\) return r\("broken"/.test(goLiveSrc))
check("G22 POSITIVE CONTROL — the probe finder rejects a stamp-reading probe and an optional one",
  !/d\("storage_policies",[^)]*,\s*false\)[\s\S]*?svc\.rpc\("storage_bucket_policy_readiness"\)/.test(`const r = d("storage_policies", "x", true); const ok = stampOf("m875") === "applied"`))
interface Wave146Gate extends GateSpec { gate: string; rulings: string; lanes: Array<(typeof WAVE146_LANE_IDS)[number]> }
const WAVE146_GATES: Wave146Gate[] = [
  { gate: "access control", rulings: "20 (1)", lanes: ["146A"], hookLanes: ["146A"], canaries: [], external: STORAGE_EXTERNAL_146,
    proofs: ["test:transfer-classification", "test:tenant-scope", "test:public-bucket-egress", "test:brokerage-identity", ...contract146("146A")] },
  { gate: "communications", rulings: "2, 3, 7, 10 (arbiter)", lanes: ["146B"], hookLanes: ["146B"], canaries: [],
    proofs: ["test:intent-driven-followup", "test:next-best-experience", "test:channel-provider-matrix", "test:egress-coverage", ...contract146("146B")] },
  { gate: "welcome/portal", rulings: "6", lanes: ["146C"], hookLanes: ["146C"], canaries: [],
    proofs: ["test:conversion-welcome", "test:conversion-finality", "test:speed-to-lead", "test:client-automation-rulings", ...contract146("146C")] },
  { gate: "customer 360", rulings: "11, 12, 13", lanes: ["146D"], hookLanes: ["146D"], canaries: [],
    proofs: ["test:lifetime-signals", "test:signal-integrity", "test:versium-capability-matrix", "test:enrichment-one-rail", ...contract146("146D")] },
  { gate: "ads/approval", rulings: "2, 8, 9", lanes: ["146E"], hookLanes: ["146E"], canaries: [],
    proofs: ["test:vibe-ctv-dispatch", "test:tv-spot", "test:provider-readiness", "test:content-distribution", ...contract146("146E")] },
  { gate: "deliverables/video", rulings: "4, 10", lanes: ["146F"], hookLanes: ["146F"], canaries: [],
    proofs: ["test:lead-magnet-flow", "test:video-pipeline-truth", "test:book-publishing", "test:autonomous-marketing", ...contract146("146F")] },
  { gate: "managers/healing", rulings: "14, 15", lanes: ["146G"], hookLanes: ["146G"], canaries: [],
    proofs: ["test:manager-cross-cooperation", "test:self-healing", "test:proposal-compliance-gate", "test:controlled-learning", ...contract146("146G")] },
  { gate: "surfaces/design", rulings: "16, 18", lanes: ["146H"], hookLanes: ["146H"], canaries: [],
    proofs: ["test:ui-delivery", "test:ui-wiring-census", "test:rendered-empty-states", "test:mobile-readiness", "test:accessibility-preferences", ...contract146("146H")] },
  // test:proof-ownership is named by the 146I brief but measured (2026-10-29) as registered and in NO guard chain — a survivor
  // named here must already certify (G19), so it waits in the 146I notes' "package.json keys to add" (chain membership) and
  // joins this list the day it is chained.
  { gate: "chains/closure", rulings: "5, 15, 18 (brief 146I)", lanes: ["146I"], hookLanes: ["146I"], canaries: [],
    proofs: ["test:parent-child-graph", "test:manager-ownership", "test:production-readiness", "test:orphaned-children", ...contract146("146I")] },
  { gate: "canaries", rulings: "every ruling + contracts C1–C7", lanes: ["146J"], hookLanes: ["146J"], canaries: [],
    proofs: [...contract146("146J")] },
]
const verdicts146 = WAVE146_GATES.map((g) => {
  const v = certify145(g, gateEnv, WAVE146_CONTRACT_PROOFS)
  // certify145's unpublished reason names lane 145I; the same rule here names 146I.
  return { ...v, reasons: v.reasons.map((r) => r.replace("when lane 145I closed", "when lane 146I closed")) }
})
const certified146 = verdicts146.filter((v) => v.state === "CERTIFIED"), external146 = verdicts146.filter((v) => v.state === "EXTERNAL"), notCertified146 = verdicts146.filter((v) => v.state === "NOT CERTIFIED")
for (const v of verdicts146) console.log(`    ${v.state.padEnd(13)} ${v.gate.padEnd(22)} owner ${v.owner.padEnd(22)} lanes ${(WAVE146_GATES.find((g) => g.gate === v.gate)!.lanes ?? []).join("+").padEnd(6)} proofs ${v.proofs.map((p) => `${p.key.replace(/^test:/, "")}${mark(p.state)}`).join(" ")}${v.reasons.length ? `\n                  · ${v.reasons.join("\n                  · ")}` : ""}`)
const contractKeys146 = WAVE146_LANE_IDS.flatMap((l) => contract146(l))
const unpublished146 = WAVE146_LANE_IDS.filter((l) => WAVE146_CONTRACT_PROOFS[l] === null)
console.log(`    census: ${WAVE146_GATES.length} wave-146 gates; ${contractKeys146.length} lane contract keys (${contractKeys146.filter((k) => proofState(k) === "ok").length} landed+chained, ${contractKeys146.filter((k) => proofState(k) === "unchained").length} registered but unchained, ${contractKeys146.filter((k) => proofState(k) === "absent").length} pending); lanes unpublished at 146I close: ${unpublished146.join(", ") || "none"}; storage.objects policy migrations: ${STORAGE_POLICY_MIGRATIONS_146.map((f) => `${f} (${stampOf(f)})`).join(", ") || "none in the tree"}`)
check("G18 every wave-146 gate names ≥1 proof or waits on an unpublished lane, waits only on wave-146 lanes, and every published contract key is named by ≥1 wave-146 gate",
  WAVE146_GATES.every((g) => (g.proofs.length > 0 || g.lanes.some((l) => WAVE146_CONTRACT_PROOFS[l] === null)) && g.lanes.length > 0 && g.lanes.every((l) => (WAVE146_LANE_IDS as readonly string[]).includes(l)))
  && contractKeys146.every((k) => WAVE146_GATES.some((g) => g.proofs.includes(k))),
  contractKeys146.filter((k) => !WAVE146_GATES.some((g) => g.proofs.includes(k))).join(", "))
check("G19 no wave-146 contract key is claimed by two lanes, and every SURVIVOR a wave-146 gate names is registered + chained TODAY",
  new Set(contractKeys146).size === contractKeys146.length && WAVE146_GATES.flatMap((g) => g.proofs).filter((k) => !contractKeys146.includes(k)).every((k) => proofState(k) === "ok"),
  WAVE146_GATES.flatMap((g) => g.proofs).filter((k) => !contractKeys146.includes(k) && proofState(k) !== "ok").join(", "))
check("G20 POSITIVE CONTROL — the wave-146 storage rule: an unstamped storage.objects migration makes a green access-control gate EXTERNAL (never CERTIFIED); a stamped set lifts it; an unpublished lane holds its gate NOT CERTIFIED",
  (() => {
    const env146: GateEnv = { ...gateEnv, scripts: { "test:spec": "tsx scripts/spec.ts" }, chain: "npm run test:spec", fileExists: () => true, roster: [], pending: new Map(), ownerOf: () => "data_steward" }
    const ext = certify145({ gate: "access control", rulings: "", lanes: ["146A"] as never, proofs: ["test:spec"], canaries: [], external: "ruling 20 (1)" }, env146, { "146A": ["test:spec"] })
    const lifted = certify145({ gate: "access control", rulings: "", lanes: ["146A"] as never, proofs: ["test:spec"], canaries: [], external: undefined }, env146, { "146A": ["test:spec"] })
    const waiting = certify145({ gate: "x", rulings: "", lanes: ["146B"] as never, proofs: ["test:spec"], canaries: [] }, env146, { "146B": null })
    return ext.state === "EXTERNAL" && lifted.state === "CERTIFIED" && waiting.state === "NOT CERTIFIED"
  })())
const gateDoc146 = matrix.split(/^## /m).find((s) => /^Wave 146 release gate/i.test(s)) ?? ""
const gateRows146 = parseGateRows(gateDoc146)
console.log(`    reading: READINESS-MATRIX.md "Wave 146 release gate" section ${gateDoc146 ? `present — ${gateRows146.length} gate row(s)` : "absent"}`)
check("G21 when the matrix carries a wave-146 release-gate section, it has a row per wave-146 gate (the rule applies the moment the section lands)",
  !gateDoc146 || WAVE146_GATES.every((g) => gateRows146.includes(g.gate.toLowerCase())), WAVE146_GATES.filter((g) => !gateRows146.includes(g.gate.toLowerCase())).map((g) => g.gate).join(", "))

// ═════════════════════════════════════════════════════════════════════════════
// WAVE 147 (lane 147H) — O · THE OWNER OBLIGATIONS STAY RELEASE-BLOCKING IN THE OUTPUT. Two obligations no code can
// discharge (wave 146 report §18–19): (O1) the storage.objects policies — m855 (OWNER-SQL §F) and m875 (§G) — read
// from the migration stamps through the ONE classifier (the go-live board reads the LIVE state); (O2) the four unlinked
// portal-contact seed accounts — read from OWNER-SQL §I's status line, which the owner flips to RESOLVED with the date
// and the zero census. Each blocks the RELEASE line until discharged; licensing / provider configuration is printed
// as WAITING_EXTERNAL by variable name (never a value), each name proven to be one the runtime actually reads.
// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[O · owner obligations — release-blocking until the owner discharges them (wave 146 §18–19, lane 147H)]")
const ownerSqlDoc = existsSync(join(ROOT, "docs/operations/OWNER-SQL.md")) ? read("docs/operations/OWNER-SQL.md") : ""
/** PURE — §I's status line: RESOLVED only when the owner wrote it (with a date); anything else is open. */
const seedAccountsResolved = (doc: string): boolean => {
  const sec = doc.split(/^## /m).find((s) => /^I\.\s/.test(s)) ?? ""
  return /^- Status:\s*RESOLVED\b.*\d{4}-\d{2}-\d{2}.*\b0\b/m.test(sec)
}
interface OwnerObligation { id: string; what: string; blocking: boolean; where: string }
const OWNER_OBLIGATIONS: OwnerObligation[] = [
  { id: "O1", what: "storage.objects policies on the five document buckets — m855 (brokerage-forms) and m875 (client / transaction / agent / offer documents)", blocking: !storageApplied146, where: `docs/operations/OWNER-SQL.md §F / §G — stamps: ${STORAGE_POLICY_MIGRATIONS_146.map((f) => `${f} (${stampOf(f)})`).join(", ") || "none in the tree"}; LIVE truth: public.storage_bucket_policy_readiness()` },
  { id: "O2", what: "the four unlinked portal-contact seed accounts (users.user_type='contact' with no contacts.contact_user_id) — link each or remove it", blocking: !seedAccountsResolved(ownerSqlDoc), where: "docs/operations/OWNER-SQL.md §I (census query + status line)" },
]
for (const o of OWNER_OBLIGATIONS) console.log(`    ${o.blocking ? "RELEASE-BLOCKING" : "discharged      "} ${o.id} ${o.what} — ${o.where}`)
check("O1 the storage-policy obligation (m855 §F / m875 §G) is RELEASE-BLOCKING while any storage.objects policy migration lacks the applied stamp (same classifier as the wave-146 access-control gate)",
  OWNER_OBLIGATIONS[0].blocking === !storageApplied146 && STORAGE_POLICY_MIGRATIONS_146.length > 0)
check("O2 the seed-account obligation is RELEASE-BLOCKING until OWNER-SQL §I's status line reads RESOLVED with a date and the zero census (the section exists and carries its census query)",
  /^## I\. /m.test(ownerSqlDoc) && /contact_user_id = u\.id/.test(ownerSqlDoc) && OWNER_OBLIGATIONS[1].blocking === !seedAccountsResolved(ownerSqlDoc))
check("O POSITIVE CONTROL — an OPEN status line blocks; a RESOLVED line with a date and the zero lifts it; a RESOLVED line with no date does not",
  !seedAccountsResolved("## I. x\n- Status: OPEN — 4 unlinked (measured 2026-10-31)\n") && seedAccountsResolved("## I. x\n- Status: RESOLVED 2026-11-02 — census 0\n") && !seedAccountsResolved("## I. x\n- Status: RESOLVED — census 0\n"))
/** WAITING_EXTERNAL by NAME (never a value): the configuration the owner obtains outside the repo (wave 146 §19.5 +
 *  the variables lane 147H's configuration messages name). Each must be a variable the runtime reads. */
const WAITING_EXTERNAL_147H: ReadonlyArray<{ env: string; provider: string; where: string }> = [
  { env: "NEXT_PUBLIC_APP_URL", provider: "the deployment's public URL", where: "Vercel project env (owner)" },
  { env: "ELEVENLABS_API_KEY", provider: "ElevenLabs (voice cloning, narration)", where: "elevenlabs.io account → API keys" },
  { env: "DID_API_KEY", provider: "D-ID (avatar video)", where: "studio.d-id.com → API" },
  { env: "SENDGRID_API_KEY", provider: "SendGrid (email)", where: "app.sendgrid.com → API keys" },
  { env: "TWILIO_ACCOUNT_SID", provider: "Twilio (SMS / voice master account)", where: "console.twilio.com" },
  { env: "STRIPE_SECRET_KEY", provider: "Stripe (owner ruling: no live billing this wave)", where: "dashboard.stripe.com → developers" },
  { env: "META_APP_SECRET", provider: "Meta (app review + webhook signature)", where: "developers.facebook.com → app settings" },
  { env: "COLLABORATIVE_SEARCH_ENABLED", provider: "platform kill switch (default on; 'false' switches family search off)", where: "Vercel project env (owner)" },
]
const runtimeEnv = new Set<string>()
for (const root of ["app", "lib"]) for (const f of walkTs(join(ROOT, root))) for (const m of stripComments(readFileSync(f, "utf8")).matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) runtimeEnv.add(m[1])
for (const w of WAITING_EXTERNAL_147H) console.log(`    WAITING_EXTERNAL ${w.env} — ${w.provider} — ${w.where}`)
check(`O3 every WAITING_EXTERNAL configuration is named by a variable the runtime reads (${WAITING_EXTERNAL_147H.length}; never a value)`, WAITING_EXTERNAL_147H.every((w) => runtimeEnv.has(w.env)), WAITING_EXTERNAL_147H.filter((w) => !runtimeEnv.has(w.env)).map((w) => w.env).join(", "))
const ownerBlocking = OWNER_OBLIGATIONS.filter((o) => o.blocking)

console.log(`\nRELEASE GATE: ${certified.length}/${RELEASE_GATES.length} certified, ${external.length} external-verdict, ${notCertified.length} not certified${notCertified.length ? ` — ${notCertified.map((v) => v.gate).join(", ")}` : ""}`)
console.log(`WAVE 142 GATE: ${certified142.length}/${WAVE142_GATES.length} certified, ${notCertified142.length} not certified${notCertified142.length ? ` — ${notCertified142.map((v) => v.gate).join(", ")}` : ""}`)
console.log(`WAVE 145 GATE: ${certified145.length}/${WAVE145_GATES.length} certified, ${external145.length} external-verdict, ${notCertified145.length} not certified${notCertified145.length ? ` — ${notCertified145.map((v) => v.gate).join(", ")}` : ""}`)
console.log(`WAVE 146 GATE: ${certified146.length}/${WAVE146_GATES.length} certified, ${external146.length} external-verdict, ${notCertified146.length} not certified${notCertified146.length ? ` — ${notCertified146.map((v) => v.gate).join(", ")}` : ""}`)
const openGates = notCertified.length + notCertified142.length + notCertified145.length + notCertified146.length
const externalAll = [...external, ...external145, ...external146]
console.log(`OWNER OBLIGATIONS: ${ownerBlocking.length}/${OWNER_OBLIGATIONS.length} RELEASE-BLOCKING${ownerBlocking.length ? ` — ${ownerBlocking.map((o) => o.id).join(", ")}` : ""}`)
// The owner obligations (lane 147H) join the verdict: a release with an undischarged obligation is NOT READY even when
// every gate certifies in-repo.
console.log(`RELEASE: ${openGates === 0 && externalAll.length === 0 && ownerBlocking.length === 0 ? "READY — every owner gate (wave 141 + wave 142 + wave 145 + wave 146) certified in-repo and every owner obligation discharged" : "NOT READY — " + [openGates ? `${openGates} gate(s) not certified (wave 141 ${notCertified.length}, wave 142 ${notCertified142.length}, wave 145 ${notCertified145.length}, wave 146 ${notCertified146.length})` : "", externalAll.length ? `${externalAll.length} gate(s) await an external verdict (${externalAll.map((v) => v.gate).join(", ")})` : "", ownerBlocking.length ? `${ownerBlocking.length} owner obligation(s) RELEASE-BLOCKING (${ownerBlocking.map((o) => o.id).join(", ")})` : ""].filter(Boolean).join("; ")}`)

console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
if (fail) { console.log("FAILURES:\n  - " + fails.join("\n  - ")); process.exit(1) }
