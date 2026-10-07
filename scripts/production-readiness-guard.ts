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
import { stripComments, blankStrings } from "./strip-comments"
import { CRON_REGISTRY } from "../lib/kernel/cron-dispatch"
import { CRON_MANAGER } from "../lib/kernel/manager-registry"
import { WEBHOOK_CONTRACT, type WebhookContractEntry } from "../lib/providers/webhook-contract"
import { classifyProxyPath } from "../app/constants/auth"

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
check("W3 every contracted routeFile exists", WEBHOOK_CONTRACT.every((e) => existsSync(join(ROOT, e.routeFile))), WEBHOOK_CONTRACT.filter((e) => !existsSync(join(ROOT, e.routeFile))).map((e) => e.routeFile).join(", "))

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
  "app/api/twiml/whisper-bridge/route.ts": "local verifyTwilioSignature (X-Twilio-Signature HMAC-SHA1, TWILIO_AUTH_TOKEN; unset → refuse) — not yet a WEBHOOK_CONTRACT row (finding)",
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

console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
if (fail) { console.log("FAILURES:\n  - " + fails.join("\n  - ")); process.exit(1) }
