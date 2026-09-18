#!/usr/bin/env tsx
/**
 * scripts/webhook-contract-guard.ts   (npm run test:webhook-contract — pure, no DB)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE INBOUND WEBHOOK CONTRACT IS HELD IN AGREEMENT WITH THE ROUTE FILES.
 *
 * Owner ruling, verbatim: "any webhook url needs to be researched to find the
 * latest path which is part of the connection self heal since providers change
 * or update their connection methods as their way of keeping up with
 * technology." The contract (lib/providers/webhook-contract.ts) is the module
 * platform staff read when re-pointing a provider console; this guard makes it
 * impossible for that page to lie:
 *
 *   1. COVERAGE — every app/api/webhooks/**​/route.ts on disk, plus the named
 *      provider-inbound routes, appears in the contract EXACTLY once, and
 *      every contracted routeFile exists on disk. A new webhook route without
 *      a contract row fails the build with its path.
 *   2. SCHEME TRUTH — each entry's declared verification is derived from the
 *      route's own COMMENT-STRIPPED source (§2): the declared header literals
 *      and process.env names must be present, and the scheme's crypto
 *      construct must be REACHABLE from the exported POST handler — found in
 *      the brace-matched POST body, in a local function transitively called
 *      from it, or in a declared implementedIn module the route imports.
 *   3. NO SECOND CLAIM — no two entries claim the same provider+eventKind
 *      unless exactly one carries a compat marker naming a surviving
 *      contracted path. This is the duplicate-pair defect closed 2026-08-27
 *      (meta vs meta-dm, ghl vs gohighlevel) asserted as a RULE so it cannot
 *      recur — a recreated duplicate route trips COVERAGE, and its contract
 *      row then trips THIS check.
 *
 * POSITIVE CONTROLS (§2 — a zero must prove its finder still bites):
 *   · a construct that lives ONLY in a comment must NOT count (stripping);
 *   · a construct in a function never called from POST must NOT count
 *     (reachability), while the same construct wired to POST MUST;
 *   · a mutated contract (duplicate claim without compat; routeFile that
 *     doesn't exist; an on-disk route left out) must be flagged.
 *
 * BLIND SPOTS, published beside the number (§2):
 *   · Console drift is invisible from the repo: this guard proves what WE
 *     serve, not what a provider console points at. Per-entry
 *     failureVisibility names the surface that would show missing deliveries;
 *     entries with null have NO repo-side delivery-failure signal.
 *   · Env NAMES are checked, never values — a present-but-wrong secret passes.
 *   · GET-handshake-only schemes (hub-verify-token-only) are recorded gaps,
 *     not passes: the scheme name itself says the POST payload is unverified.
 *   · One-hop-import scan: a construct behind TWO module hops from a declared
 *     implementedIn file is not seen (none exists today; adding one requires
 *     naming the module in implementedIn).
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { WEBHOOK_CONTRACT, type WebhookContractEntry } from "../lib/providers/webhook-contract"

const root = process.cwd()

let pass = 0
let fail = 0
const fails: string[] = []
const check = (name: string, cond: boolean) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; fails.push(name); console.log(`  ✗ ${name}`) }
}

const srcCache = new Map<string, string>()
const stripped = (relPath: string): string => {
  if (!srcCache.has(relPath)) {
    srcCache.set(relPath, stripComments(readFileSync(join(root, relPath), "utf8")))
  }
  return srcCache.get(relPath)!
}

// ── Route discovery ──────────────────────────────────────────────────────────

/** Recursively find route.ts under a dir, returned repo-relative. */
function findRouteFiles(relDir: string): string[] {
  const abs = join(root, relDir)
  if (!existsSync(abs)) return []
  const out: string[] = []
  for (const name of readdirSync(abs)) {
    const child = join(abs, name)
    const relChild = `${relDir}/${name}`
    if (statSync(child).isDirectory()) out.push(...findRouteFiles(relChild))
    else if (name === "route.ts") out.push(relChild)
  }
  return out
}

/** Provider-inbound routes OUTSIDE app/api/webhooks that receive provider
 *  webhooks (the SmsUrl/VoiceUrl/StatusCallback lanes + the compat opt-out). */
const EXTRA_INBOUND_ROUTES = [
  "app/api/providers/inbound/route.ts",
  "app/api/sms/inbound-optout/route.ts",
  "app/api/voice/twilio/inbound/route.ts",
  "app/api/voice/twilio/status/route.ts",
]

// ── Brace-matched POST reachability ──────────────────────────────────────────

/** Brace-match the body starting at the first `{` at/after `from`. */
function braceMatchedBlock(src: string, from: number): string | null {
  const open = src.indexOf("{", from)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  return null
}

interface Reachability {
  /** Concatenated source of the POST body + every local function transitively
   *  called from it. */
  reachable: string
  postFound: boolean
}

/** Source reachable from the exported POST handler: its brace-matched body
 *  plus the bodies of local `function name(` declarations transitively
 *  referenced from it. */
function postReachableSource(src: string): Reachability {
  const postIdx = src.search(/export\s+async\s+function\s+POST\s*\(/)
  if (postIdx < 0) return { reachable: "", postFound: false }
  const postBody = braceMatchedBlock(src, postIdx) ?? ""

  // Local function declarations (top-level or not — name → body).
  const localFns = new Map<string, string>()
  const fnRe = /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = fnRe.exec(src)) !== null) {
    const body = braceMatchedBlock(src, m.index + m[0].length - 1)
    if (body) localFns.set(m[1], body)
  }

  // Transitive closure of local calls from POST.
  const included = new Set<string>()
  let frontier = postBody
  let reachable = postBody
  let grew = true
  while (grew) {
    grew = false
    for (const [name, body] of localFns) {
      if (included.has(name)) continue
      if (new RegExp(`\\b${name}\\s*\\(`).test(frontier) || new RegExp(`\\b${name}\\s*\\(`).test(reachable)) {
        included.add(name)
        reachable += "\n" + body
        grew = true
      }
    }
    frontier = reachable
  }
  return { reachable, postFound: true }
}

// ── Scheme constructs (the code tokens each declared scheme must show) ───────

/** Patterns that must appear in POST-reachable source (route) or in a declared
 *  implementedIn module the route imports. Each is a CODE token — scanned on
 *  stripped source only. */
const SCHEME_CONSTRUCTS: Record<WebhookContractEntry["scheme"], RegExp[]> = {
  "hmac-sha256": [/createHmac\(\s*["']sha256["']/, /timingSafeEqual\(/],
  "ed25519-or-hmac-sha256": [/createHmac\(\s*["']sha256["']/, /timingSafeEqual\(/, /createPublicKey\(/, /cryptoVerify\(|crypto\.verify\(/],
  "twilio-url-hmac-sha1": [/validateTwilioSignature\(|createHmac\(\s*["']sha1["']/],
  "meta-hub-plus-sha256": [/x-hub-signature-256/, /createHmac\(\s*["']sha256["']/, /timingSafeEqual\(/],
  "hub-verify-token-only": [/hub\.verify_token|challengeCode/],
  "shared-secret": [/x-webhook-secret|x-postmark-token/],
  "stripe-signature": [/stripe-signature/],
  "zoom-hmac-sha256": [/verifyZoomWebhook\(|createHmac\(\s*["']sha256["']/],
  "multi-provider": [/createHmac\(/, /timingSafeEqual\(/],
  none: [],
}

/** Refusal statuses a verifying route must be able to answer with (400 covers
 *  Stripe's and the CE route's signature refusals). */
const REFUSAL = /\b40[013]\b/

// ── The checker itself (pure over a contract + a file set) ───────────────────

interface CheckInput {
  contract: WebhookContractEntry[]
  routesOnDisk: string[]
}

function contractProblems({ contract, routesOnDisk }: CheckInput): string[] {
  const problems: string[] = []

  // 1a. Every on-disk route is contracted exactly once.
  const byRouteFile = new Map<string, number>()
  for (const e of contract) byRouteFile.set(e.routeFile, (byRouteFile.get(e.routeFile) ?? 0) + 1)
  for (const r of routesOnDisk) {
    const n = byRouteFile.get(r) ?? 0
    if (n === 0) problems.push(`uncontracted route: ${r}`)
    if (n > 1) problems.push(`route contracted ${n} times: ${r}`)
  }
  // 1b. Every contracted route exists.
  for (const e of contract) {
    if (!routesOnDisk.includes(e.routeFile)) problems.push(`contract names a route not on disk (or outside the covered set): ${e.routeFile}`)
  }

  // 3. provider+eventKind uniqueness, compat-aware.
  const byClaim = new Map<string, WebhookContractEntry[]>()
  for (const e of contract) {
    const k = `${e.provider} :: ${e.eventKind}`
    byClaim.set(k, [...(byClaim.get(k) ?? []), e])
  }
  const paths = new Set(contract.map((e) => e.path))
  for (const [claim, entries] of byClaim) {
    if (entries.length === 1) continue
    const canonical = entries.filter((e) => !e.compat)
    const compats = entries.filter((e) => e.compat)
    if (canonical.length !== 1) {
      problems.push(`duplicate claim ${claim}: ${entries.length} entries, ${canonical.length} without a compat marker (need exactly 1)`)
      continue
    }
    for (const c of compats) {
      if (c.compat!.survivorPath !== canonical[0].path || !paths.has(c.compat!.survivorPath)) {
        problems.push(`compat entry ${c.path} for ${claim} must name the surviving contracted path (${canonical[0].path})`)
      }
    }
  }
  return problems
}

// ═════════════════════════════════════════════════════════════════════════════

console.log("\n── POSITIVE CONTROLS — the finders still bite ──")
{
  // Stripping control: construct only in a comment must NOT count.
  const commented = stripComments(`
    // createHmac("sha256", secret) — tombstone prose, not code
    /* timingSafeEqual(a, b) */
    export async function POST(req: Request) { return new Response("ok") }
  `)
  const commentedReach = postReachableSource(commented)
  check("control: createHmac in a COMMENT is not counted (stripping works)",
    !SCHEME_CONSTRUCTS["hmac-sha256"].every((re) => re.test(commentedReach.reachable)))

  // Reachability control: construct wired to POST counts…
  const wired = stripComments(`
    import { createHmac, timingSafeEqual } from "crypto"
    function verifySig(raw: string) {
      const c = createHmac("sha256", "s").update(raw).digest("hex")
      return timingSafeEqual(Buffer.from(c), Buffer.from(c))
    }
    export async function POST(req: Request) {
      if (!verifySig(await req.text())) return new Response("no", { status: 401 })
      return new Response("ok")
    }
  `)
  const wiredReach = postReachableSource(wired)
  check("control: createHmac+timingSafeEqual reachable from POST IS counted",
    SCHEME_CONSTRUCTS["hmac-sha256"].every((re) => re.test(wiredReach.reachable)))

  // …and the SAME construct in a function POST never calls does not.
  const orphaned = stripComments(`
    import { createHmac, timingSafeEqual } from "crypto"
    function deadVerify(raw: string) {
      const c = createHmac("sha256", "s").update(raw).digest("hex")
      return timingSafeEqual(Buffer.from(c), Buffer.from(c))
    }
    export async function POST(req: Request) { return new Response("ok") }
  `)
  const orphanedReach = postReachableSource(orphaned)
  check("control: the same construct in a function POST never calls is NOT counted",
    !SCHEME_CONSTRUCTS["hmac-sha256"].some((re) => re.test(orphanedReach.reachable)))

  // Mutation controls on the contract checker.
  const fakeRoutes = ["app/api/webhooks/alpha/route.ts", "app/api/webhooks/beta/route.ts"]
  const entry = (over: Partial<WebhookContractEntry>): WebhookContractEntry => ({
    provider: "alpha", eventKind: "events", path: "/api/webhooks/alpha",
    routeFile: "app/api/webhooks/alpha/route.ts", scheme: "hmac-sha256",
    verificationHeaders: ["x-a"], secretEnv: ["A_SECRET"],
    consoleField: "-", failureVisibility: null, ...over,
  })
  check("control: an uncontracted on-disk route is flagged",
    contractProblems({ contract: [entry({})], routesOnDisk: fakeRoutes })
      .some((p) => p.includes("uncontracted route: app/api/webhooks/beta/route.ts")))
  check("control: a contract row for a route not on disk is flagged",
    contractProblems({
      contract: [entry({}), entry({ path: "/x", routeFile: "app/api/webhooks/ghost/route.ts", provider: "g" })],
      routesOnDisk: fakeRoutes.slice(0, 1),
    }).some((p) => p.includes("not on disk")))
  check("control: a duplicate provider+eventKind claim WITHOUT compat is flagged",
    contractProblems({
      contract: [entry({}), entry({ path: "/api/webhooks/beta", routeFile: "app/api/webhooks/beta/route.ts" })],
      routesOnDisk: fakeRoutes,
    }).some((p) => p.startsWith("duplicate claim alpha :: events")))
  check("control: the same duplicate WITH a compat marker naming the survivor passes",
    !contractProblems({
      contract: [entry({}), entry({
        path: "/api/webhooks/beta", routeFile: "app/api/webhooks/beta/route.ts",
        compat: { survivorPath: "/api/webhooks/alpha", reason: "control" },
      })],
      routesOnDisk: fakeRoutes,
    }).some((p) => p.startsWith("duplicate claim")))
}

console.log("\n── 1+3. COVERAGE + UNIQUE CLAIMS on the real tree ──")
const routesOnDisk = [
  ...findRouteFiles("app/api/webhooks"),
  ...EXTRA_INBOUND_ROUTES.filter((r) => existsSync(join(root, r))),
].sort()
{
  for (const r of EXTRA_INBOUND_ROUTES) {
    check(`named inbound route exists on disk: ${r}`, existsSync(join(root, r)))
  }
  const problems = contractProblems({ contract: WEBHOOK_CONTRACT, routesOnDisk })
  check(`coverage + claims clean over ${routesOnDisk.length} route(s) / ${WEBHOOK_CONTRACT.length} contract row(s)`,
    problems.length === 0)
  for (const p of problems) console.log(`      · ${p}`)

  // The adjudicated compat duplicate is the ONLY one and stays visible.
  const compats = WEBHOOK_CONTRACT.filter((e) => e.compat)
  check("every compat entry names an unresolved-console reason",
    compats.every((e) => (e.compat?.reason ?? "").length > 20))
}

console.log("\n── 2. SCHEME TRUTH — declared verification is what the code does ──")
for (const e of WEBHOOK_CONTRACT) {
  if (!existsSync(join(root, e.routeFile))) continue // already reported above
  const routeSrc = stripped(e.routeFile)
  const implSrcs = (e.implementedIn ?? []).filter((f) => existsSync(join(root, f))).map((f) => stripped(f))
  const everywhere = [routeSrc, ...implSrcs].join("\n")
  const label = `${e.provider}/${e.eventKind} (${e.path})`

  for (const f of e.implementedIn ?? []) {
    check(`${label}: implementedIn exists — ${f}`, existsSync(join(root, f)))
  }

  // Header literals are read somewhere on the entry's files.
  for (const h of e.verificationHeaders) {
    check(`${label}: reads header "${h}"`, everywhere.toLowerCase().includes(h.toLowerCase()))
  }
  // Env names are consulted somewhere on the entry's files.
  for (const env of e.secretEnv) {
    check(`${label}: consults process.env.${env}`, new RegExp(`process\\.env\\.${env}\\b`).test(everywhere))
  }

  // The scheme construct must be REACHABLE from POST (route body, a local fn
  // transitively called from it, or a declared implementedIn module).
  const constructs = SCHEME_CONSTRUCTS[e.scheme]
  if (constructs.length > 0) {
    const reach = postReachableSource(routeSrc)
    check(`${label}: exported POST handler found`, reach.postFound)
    if (e.scheme === "hub-verify-token-only") {
      // The handshake lives on GET (subscription verification, not payload
      // verification) — scan the whole file; the scheme NAME records the
      // unverified-POST gap rather than hiding it.
      for (const re of constructs) {
        check(`${label}: scheme ${e.scheme} construct ${re.source.slice(0, 40)} present`, re.test(everywhere))
      }
    } else {
      const searchable = [reach.reachable, ...implSrcs].join("\n")
      for (const re of constructs) {
        check(`${label}: scheme ${e.scheme} construct ${re.source.slice(0, 40)} reachable from POST`, re.test(searchable))
      }
      // A verifying scheme must be able to REFUSE (fail closed, §4).
      check(`${label}: refusal status present (fail closed)`, REFUSAL.test(reach.reachable) || implSrcs.some((s) => REFUSAL.test(s)))
    }
  }
}

console.log("\n── BLIND SPOTS (published, not passed) ──")
{
  const blind = WEBHOOK_CONTRACT.filter((e) => e.failureVisibility === null)
  const unverifiedPayload = WEBHOOK_CONTRACT.filter((e) => e.scheme === "hub-verify-token-only" || e.scheme === "none")
  console.log(`  · console drift is repo-invisible for ALL ${WEBHOOK_CONTRACT.length} entries — the contract proves what WE serve`)
  console.log(`  · ${blind.length} entr(ies) have NO repo-side delivery-failure surface: ${blind.map((e) => e.path).join(", ")}`)
  console.log(`  · ${unverifiedPayload.length} entr(ies) accept UNVERIFIED POST payloads (recorded gap): ${unverifiedPayload.map((e) => e.path).join(", ")}`)
  console.log("  · env NAMES are asserted, env VALUES are not; a present-but-wrong secret passes here")
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ WEBHOOK_CONTRACT_FAIL — the console-facing contract disagrees with the routes"); process.exit(1) }
console.log(" ✅ WEBHOOK_CONTRACT_PASS — every inbound webhook route is contracted once, verified as declared, no duplicate claims")
