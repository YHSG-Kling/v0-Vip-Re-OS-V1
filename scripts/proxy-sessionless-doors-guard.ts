#!/usr/bin/env tsx
/**
 * scripts/proxy-sessionless-doors-guard.ts   (npm run test:proxy-sessionless-doors)
 * ─────────────────────────────────────────────────────────────────────────────
 * NO CALLER THAT CAN NEVER CARRY A SESSION IS ANSWERED WITH A 307 TO /login.
 *
 * Lane 88E (wave 88 production-readiness audit; owner: "make sure all loops are
 * closed to be ready to push this platform to production"). proxy.ts redirects
 * a sessionless request on any PROTECTED_ROUTES prefix to /login. The prefixes
 * are broad ('/api/voice', '/api/did', '/api/forms', '/api/intelligence',
 * '/api/admin'), and under them sat routes whose ONLY callers are provider
 * servers, an out-of-process companion, an anonymous visitor or a server-side
 * self-call. Measured on base a51448c8: 15 such routes, among them every Twilio
 * voice webhook (VoiceUrl bound by bindNumberToTwilioLane → inbound voice was
 * dead on a real deploy), the D-ID Agents custom-LLM callback and the public
 * lead-capture form submit. The same audit found the loose `startsWith` PUBLIC
 * match making 17 page routes public by accident (/listings/** via '/listing',
 * /vendor/** and /video-assistant via '/v').
 *
 * WHAT IS HELD (each population DERIVED, never listed here):
 *   P1 every WEBHOOK_CONTRACT path (lib/providers/webhook-contract.ts) passes
 *      the proxy without a session;
 *   P2 every CRON_REGISTRY target (lib/kernel/cron-dispatch.ts) and the
 *      dispatcher pass without a session (the dispatcher's fan-out carries a
 *      Bearer, never a cookie);
 *   P3 CENSUS — every app/api route under a PROTECTED prefix whose
 *      COMMENT-STRIPPED source carries no session gate is classified 'public'
 *      through SESSIONLESS_API_DOORS, and verifies its own caller (signature,
 *      shared secret, timing-safe token, verifyCronAuth) — the one
 *      anonymous-by-design door (/api/forms/submit) is named with its reason;
 *   P3b none of those doors compares a caller value RAW against an env secret
 *      (`h !== process.env.X` passes on an unset or blank secret — found and
 *      fixed in /api/intelligence/classify);
 *   P4 every SESSIONLESS_API_DOORS entry names at least one route on disk, and
 *      every route under it verifies its caller (same construct list);
 *   P5 no route under a PROTECTED prefix is public by ACCIDENT: a public
 *      verdict under a protected prefix must come from an entry that itself
 *      sits at or below that prefix ('/portal/login' under '/portal'), never a
 *      shorter sibling spelling ('/v' under '/vendor');
 *   R  RUNTIME — proxy.ts's default export, invoked for real with no cookie:
 *      a Twilio inbound POST and a form submit pass through (no Location), a
 *      protected dashboard page still redirects to /login, and /vendor/dashboard
 *      (public by accident before) now redirects.
 *
 * POSITIVE CONTROLS (§2): the pre-88E loose classifier, replayed, puts the
 * Twilio inbound webhook in 'protected' and /vendor/dashboard in 'public'; the
 * P3 session finder sees a specimen gate and ignores one inside a COMMENT; the
 * P5 accident finder flags the '/v' → '/vendor' shape.
 *
 * BLIND SPOTS (published beside the numbers): the session-gate finder is
 * NAME-based (a gate reached through a helper whose name is not in
 * SESSION_GATE is read as "no session gate" — over-accusing, never
 * under-accusing, because such a route then has to prove its own caller
 * verification); caller verification is lexical (a construct present in the
 * file is not proven to guard every branch — webhook-contract proves POST
 * reachability for the contracted rows); server actions ("use server") are
 * NOT proxy-gated at all by design and are held elsewhere (sessionless-use-
 * server-census).
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { createRequire } from "node:module"
import { stripComments } from "./strip-comments"
import {
  PUBLIC_ROUTES, PROTECTED_ROUTES, SESSIONLESS_API_DOORS,
  classifyProxyPath, publicRouteMatches,
} from "../app/constants/auth"
import { WEBHOOK_CONTRACT } from "../lib/providers/webhook-contract"
import { CRON_REGISTRY } from "../lib/kernel/cron-dispatch"

const root = process.cwd()
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

/** A session gate, by the helper names this repo uses (name-based — see BLIND SPOTS). */
const SESSION_GATE = /\b(getUser|getAgentContext|require[A-Z]\w*|resolve(?:Write|Acting|Read)\w*Context|getCurrentUser|withAuth|getAuthContext|getSession)\s*\(/
/** A caller-verification construct a sessionless door must carry itself. */
const CALLER_VERIFICATION = /validateTwilioSignature\s*\(|timingSafeEqual\s*\(|verifyCronAuth\s*\(|createHmac\s*\(|constructEvent\w*\s*\(|verify\w*Webhook\s*\(|INTERNAL_API_SECRET|RELAY_SHARED_SECRET|DID_CUSTOM_LLM_KEY|x-twilio-signature/
/** Doors that are anonymous BY DESIGN — the reason is the contract. */
const ANONYMOUS_BY_DESIGN: Record<string, string> = {
  "/api/forms/submit":
    "the public lead-capture form (app/forms/[slug]/FormRenderer.tsx) posts it with no session; the tenant comes from the lead_capture_forms row (slug + is_active), never the body",
}

function walkRoutes(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walkRoutes(p, out)
    else if (name === "route.ts" || name === "route.tsx") out.push(p)
  }
  return out
}
const urlOf = (abs: string) =>
  "/" + relative(join(root, "app"), abs).split(sep).filter((s) => !/^\(.*\)$/.test(s)).join("/").replace(/\/route\.tsx?$/, "")
const concrete = (u: string) => u.replace(/\[\[?\.{0,3}[^\]]+\]\]?/g, "x-sample")

/** The PRE-88E proxy decision, replayed verbatim for the positive controls. */
const PRE_88E_PUBLIC = PUBLIC_ROUTES.filter((r) => !SESSIONLESS_API_DOORS.includes(r) && r !== "/vendor-invite")
function looseClassify(p: string): "public" | "protected" | "open" {
  if (PRE_88E_PUBLIC.some((r) => p.startsWith(r))) return "public"
  if (PROTECTED_ROUTES.some((r) => p.startsWith(r))) return "protected"
  return "open"
}
/** P5 finder: a public verdict under a protected prefix that no entry at/below that prefix grants. */
function accidentalPublic(p: string, publics: string[], matches: (p: string, r: string) => boolean): boolean {
  const prot = PROTECTED_ROUTES.filter((r) => p.startsWith(r))
  if (!prot.length) return false
  const grants = publics.filter((r) => matches(p, r))
  if (!grants.length) return false
  return !grants.some((g) => prot.some((pr) => g.startsWith(pr)))
}

console.log("══════════════════════════════════════════════════════════════════════")
console.log(" PROXY SESSIONLESS DOORS — no provider, companion or visitor is sent to /login")
console.log("══════════════════════════════════════════════════════════════════════")

console.log("\n[controls — the classifier, and the finders against the defects they were written for]")
check("CONTROL (pre-88E replay) the Twilio inbound webhook was 'protected' → a 307 to /login",
  looseClassify("/api/voice/twilio/inbound") === "protected")
check("CONTROL (pre-88E replay) /vendor/dashboard was 'public' through the '/v' prefix",
  looseClassify("/vendor/dashboard") === "public")
check("CONTROL (pre-88E replay) the P5 finder flags /vendor/dashboard as public by accident",
  accidentalPublic("/vendor/dashboard", PRE_88E_PUBLIC, (p, r) => p.startsWith(r)))
check("CONTROL the P5 finder does NOT flag a deliberate child exemption (/portal/login under /portal)",
  !accidentalPublic("/portal/login", PUBLIC_ROUTES, publicRouteMatches))
check("CONTROL the session finder sees a real gate", SESSION_GATE.test(stripComments(`const { data } = await supabase.auth.getUser()`)))
check("CONTROL a session gate named only in a COMMENT is not a gate",
  !SESSION_GATE.test(stripComments(`// callers must getUser() first\nexport async function POST() {}`)))
check("CONTROL the caller-verification finder sees a Twilio signature check",
  CALLER_VERIFICATION.test(stripComments(`if (!validateTwilioSignature(tok, url, params, sig)) return deny()`)))
for (const [p, want] of [
  ["/api/voice/twilio/inbound", "public"], ["/api/voice/twilio/status", "public"],
  ["/api/did/custom-llm", "public"], ["/api/forms/submit", "public"],
  ["/api/voice/end-call", "protected"], ["/api/did/generate-video", "protected"],
  ["/vendor/dashboard", "protected"], ["/vendor-invite/abc", "public"],
  ["/v", "public"], ["/v/some-reel", "public"], ["/video-assistant", "protected"],
  ["/listings/new", "protected"], ["/listing/abc", "public"],
  ["/portal/login", "public"], ["/portal/abc/journey", "protected"], ["/login", "public"],
  ["/api/webhooks/did", "open"], ["/api/cron/dispatch", "open"],
] as const) {
  check(`classifyProxyPath(${p}) === '${want}'`, classifyProxyPath(p) === want, `got ${classifyProxyPath(p)}`)
}

console.log("\n[P1 · every contracted webhook path passes without a session]")
{
  const redirected = WEBHOOK_CONTRACT.filter((e) => classifyProxyPath(e.path) === "protected").map((e) => e.path)
  check(`${WEBHOOK_CONTRACT.length} contracted webhook path(s), none redirected`, redirected.length === 0, redirected.join(", "))
}

console.log("\n[P2 · every cron-registry target passes without a session]")
{
  const paths = Array.from(new Set([...CRON_REGISTRY.map((c) => c.path.split("?")[0]), "/api/cron/dispatch"]))
  const redirected = paths.filter((p) => classifyProxyPath(p) === "protected")
  check(`${paths.length} cron target(s), none redirected`, redirected.length === 0, redirected.join(", "))
}

const apiRoutes = walkRoutes(join(root, "app", "api"))
const underProtected = apiRoutes.filter((f) => PROTECTED_ROUTES.some((r) => urlOf(f).startsWith(r)))
console.log(`\n[P3 · census — ${apiRoutes.length} app/api routes, ${underProtected.length} under a PROTECTED prefix]`)
{
  const sessionless = underProtected.filter((f) => !SESSION_GATE.test(stripComments(readFileSync(f, "utf8"))))
  const redirected: string[] = []
  const unverified: string[] = []
  for (const f of sessionless) {
    const u = urlOf(f)
    if (classifyProxyPath(concrete(u)) !== "public") redirected.push(u)
    const s = stripComments(readFileSync(f, "utf8"))
    if (!CALLER_VERIFICATION.test(s) && !ANONYMOUS_BY_DESIGN[u]) unverified.push(u)
  }
  console.log(`    ${sessionless.length} carry no session gate: ${sessionless.map(urlOf).join(", ")}`)
  const wasRedirected = sessionless.filter((f) => looseClassify(concrete(urlOf(f))) === "protected")
  console.log(`    pre-88E replay: ${wasRedirected.length} of them were answered with a 307 to /login`)
  check("CONTROL (pre-88E replay) the census finds the redirected sessionless doors", wasRedirected.length > 0)
  check("every sessionless route under a PROTECTED prefix is public by name (a provider is never sent to /login)",
    redirected.length === 0, redirected.join(", "))
  check("every one of them verifies its own caller, or is anonymous by design with its reason",
    unverified.length === 0, unverified.join(", "))

  // P3b — a door the proxy now lets through must FAIL CLOSED on its own. The
  // fail-open shape: a caller value compared RAW against the env secret —
  // `header !== process.env.X` — passes when the secret is unset (undefined
  // vs. a missing header) or blank ('' vs. an empty header, the shape a
  // verbatim copy of .env.example's blank values produces).
  const RAW_ENV_COMPARE = /(?:!==|===|!=|==)\s*process\.env\.[A-Z_][A-Z0-9_]*\b(?!\s*\?\?)/
  check("CONTROL the raw-compare finder flags the pre-88E /api/intelligence/classify gate",
    RAW_ENV_COMPARE.test(stripComments(`const authHeader = request.headers.get('x-internal-secret')\nif (authHeader !== process.env.INTERNAL_API_SECRET) { return deny() }`)))
  check("CONTROL the raw-compare finder passes the fail-closed idiom",
    !RAW_ENV_COMPARE.test(stripComments(`const expected = process.env.INTERNAL_API_SECRET ?? ''\nif (!expected || given !== expected) return deny()`)))
  const rawCompares = sessionless.filter((f) => RAW_ENV_COMPARE.test(stripComments(readFileSync(f, "utf8")))).map(urlOf)
  check("no sessionless door compares a caller value RAW against an env secret (unset/blank secret must refuse)",
    rawCompares.length === 0, rawCompares.join(", "))
}

console.log(`\n[P4 · the ${SESSIONLESS_API_DOORS.length} SESSIONLESS_API_DOORS entries are real and self-verifying]`)
for (const door of SESSIONLESS_API_DOORS) {
  const files = apiRoutes.filter((f) => publicRouteMatches(urlOf(f), door))
  check(`${door}: names ${files.length} route(s) on disk`, files.length > 0)
  const weak = files.filter((f) => !CALLER_VERIFICATION.test(stripComments(readFileSync(f, "utf8"))) && !ANONYMOUS_BY_DESIGN[urlOf(f)])
  check(`${door}: every route verifies its caller${ANONYMOUS_BY_DESIGN[door] ? ` (anonymous by design: ${ANONYMOUS_BY_DESIGN[door]})` : ""}`,
    weak.length === 0, weak.map(urlOf).join(", "))
}

console.log("\n[P5 · no route under a PROTECTED prefix is public by accident]")
{
  const pages = (function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) { if (name !== "node_modules") walk(p, out) }
      else if (/^(page|route)\.tsx?$/.test(name)) out.push(p)
    }
    return out
  })(join(root, "app"))
  const urls = Array.from(new Set(pages.map((f) => urlOf(f).replace(/\/page\.tsx?$/, "").replace(/^\/page\.tsx?$/, "/") || "/")))
  const accidents = urls.filter((u) => accidentalPublic(concrete(u), PUBLIC_ROUTES, publicRouteMatches))
  const wasAccident = urls.filter((u) => accidentalPublic(concrete(u), PRE_88E_PUBLIC, (p, r) => p.startsWith(r)))
  console.log(`    ${urls.length} page/route URLs · pre-88E loose matching made ${wasAccident.length} public by accident`)
  check("no page or route is public by accident under a protected prefix", accidents.length === 0, accidents.join(", "))
}

console.log("\n[R · proxy.ts invoked for real, no cookie]")
{
  const _require = createRequire(import.meta.url)
  try {
    const soPath = _require.resolve("server-only")
    _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
  } catch { /* nothing to shim */ }
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://example.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "anon-placeholder"
  const { NextRequest } = await import("next/server")
  const proxy = (await import("../proxy")).default as (r: InstanceType<typeof NextRequest>) => Promise<Response>
  const hit = async (path: string, method = "GET") => {
    const res = await proxy(new NextRequest(`https://app-88e.vercel.app${path}`, { method, headers: { host: "app-88e.vercel.app" } }))
    return { status: res.status, location: res.headers.get("location") ?? "" }
  }
  const twilio = await hit("/api/voice/twilio/inbound", "POST")
  check("Twilio inbound POST passes through (no redirect)", !twilio.location && twilio.status === 200, JSON.stringify(twilio))
  const form = await hit("/api/forms/submit", "POST")
  check("public form submit passes through (no redirect)", !form.location && form.status === 200, JSON.stringify(form))
  const llm = await hit("/api/did/custom-llm", "POST")
  check("D-ID custom-LLM callback passes through (no redirect)", !llm.location && llm.status === 200, JSON.stringify(llm))
  let dash: { status: number; location: string } | null = null
  try { dash = await hit("/dashboard") } catch (e) { check("protected /dashboard evaluates in the harness", false, String(e).slice(0, 160)) }
  if (dash) check("a protected page with no session still redirects to /login", /\/login$/.test(dash.location), JSON.stringify(dash))
  let vendor: { status: number; location: string } | null = null
  try { vendor = await hit("/vendor/dashboard") } catch (e) { check("/vendor/dashboard evaluates in the harness", false, String(e).slice(0, 160)) }
  if (vendor) check("/vendor/dashboard (public by accident before 88E) now redirects to /login", /\/login$/.test(vendor.location), JSON.stringify(vendor))
}

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed) {
  for (const f of failures) console.log(`   - ${f}`)
  console.log("\n❌ PROXY_SESSIONLESS_DOORS_FAIL")
  process.exit(1)
}
console.log("\n✅ PROXY_SESSIONLESS_DOORS_PASS — every provider, companion and anonymous door reaches its route; protected pages still redirect")
