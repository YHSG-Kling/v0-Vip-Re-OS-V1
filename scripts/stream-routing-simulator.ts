#!/usr/bin/env tsx
/**
 * scripts/stream-routing-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * NO STREAM LEAVES THE ROUTED LANE (task #187).
 *
 * generateTextRouted has been the ONE sanctioned entry for non-streaming AI
 * calls — routing table, fair-use cap, cost ledger. The streaming routes
 * bypassed all three by calling the AI SDK's `streamText` directly: eight
 * routes, nine call sites, zero ledger rows, caps never consulted. Streaming
 * now goes through `streamTextRouted` in lib/ai/models.ts, which:
 *
 *   1. routes the model through AI_TASK_ROUTING (call sites name a FEATURE,
 *      never a model),
 *   2. runs the fair-use cap check BEFORE streamText — a blocked tenant is
 *      refused (AIFairUseError → 429) before the first byte, and
 *   3. writes the SAME cost ledger (logAIUsage) in onFinish — one vocabulary,
 *      no second ledger.
 *
 * SOURCE-ONLY proof, deliberately lean: the pieces streamTextRouted reuses
 * (checkAIFairUse, logAIUsage, the routing table) carry their own proofs; what
 * can silently rot here is the CHOKEPOINT — a new route importing `streamText`
 * from "ai" and streaming unmetered again. That is exactly what this pins:
 *   (a) zero direct `streamText(` call sites in app/ + lib/ outside the one
 *       inside streamTextRouted itself — scanned as CODE, comments masked;
 *   (b) streamTextRouted's internal order: cap check BEFORE the stream starts,
 *       ledger write inside onFinish, before the caller's own callback;
 *   (c) every former call site now imports and calls streamTextRouted.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

/** true at every index inside a comment or string literal. */
function codeMask(src: string): boolean[] {
  const mask = new Array<boolean>(src.length).fill(false)
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") mask[i++] = true }
    else if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); const stop = e === -1 ? src.length : e + 2; while (i < stop) mask[i++] = true }
    else if (c === '"' || c === "'" || c === "`") { const q = c; mask[i++] = true; while (i < src.length) { if (src[i] === "\\") { mask[i++] = true; if (i < src.length) mask[i++] = true; continue } if (src[i] === q) { mask[i++] = true; break } if (q !== "`" && src[i] === "\n") break; mask[i++] = true } }
    else i++
  }
  return mask
}

/** Occurrences of `needle` as CODE — comments and string literals masked. */
function codeHits(src: string, needle: string): number {
  const mask = codeMask(src)
  let n = 0, from = 0
  for (;;) {
    const at = src.indexOf(needle, from)
    if (at === -1) return n
    from = at + needle.length
    if (!mask[at]) n++
  }
}

/** Index of the FIRST occurrence of `needle` as CODE, or -1 — same masking. */
function firstCodeHit(src: string, needle: string): number {
  const mask = codeMask(src)
  let from = 0
  for (;;) {
    const at = src.indexOf(needle, from)
    if (at === -1) return -1
    if (!mask[at]) return at
    from = at + needle.length
  }
}

/** Every .ts/.tsx file under `dir` (relative to cwd), recursively. */
function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(join(process.cwd(), dir))) {
    const rel = join(dir, name)
    const st = statSync(join(process.cwd(), rel))
    if (st.isDirectory()) out.push(...tsFiles(rel))
    else if (/\.tsx?$/.test(name)) out.push(rel)
  }
  return out
}

// The one file allowed to call the raw SDK streamText — inside streamTextRouted.
const CHOKEPOINT = join("lib", "ai", "models.ts")

// The eight routes that used to call streamText directly (nine call sites —
// did/custom-llm carried a dead primary/fallback pair).
const FORMER_CALL_SITES = [
  "app/api/chat/stream/route.ts",
  "app/api/internal/ai-chat/route.ts",
  "app/api/widget/message/route.ts",
  "app/api/did/custom-llm/route.ts",
  "app/api/onboarding/performance-report/route.ts",
  "app/api/onboarding/assistant/route.ts",
  "app/api/onboarding/brand/generate-sample/route.ts",
  "app/api/portal/ai-chat/route.ts",
]

// A raw-SDK import of streamText anywhere outside the chokepoint is the leak
// forming again, even before a call site appears. \b does NOT split
// streamText|Routed (word char to word char), so the routed import never trips this.
const RAW_IMPORT_RE = /import\s*(?:type\s*)?\{[^}]*\bstreamText\b[^}]*\}\s*from\s*["']ai["']/

console.log("\n[(a) the chokepoint — zero direct streamText( call sites in app/ + lib/]")
{
  const offenders: string[] = []
  let chokepointHits = 0
  for (const rel of [...tsFiles("app"), ...tsFiles("lib")]) {
    const src = readFileSync(join(process.cwd(), rel), "utf8")
    const hits = codeHits(src, "streamText(")
    if (rel === CHOKEPOINT) { chokepointHits = hits; continue }
    if (hits > 0) offenders.push(`${rel} (${hits})`)
    else if (RAW_IMPORT_RE.test(src)) offenders.push(`${rel} (imports streamText from "ai")`)
  }
  check("no file in app/ or lib/ calls or imports the raw streamText except lib/ai/models.ts" +
    (offenders.length ? ` — LEAKED: ${offenders.join(", ")}` : ""),
    offenders.length === 0)
  check("lib/ai/models.ts calls streamText exactly once — the call inside streamTextRouted",
    chokepointHits === 1)
}

console.log("\n[(b) streamTextRouted — cap BEFORE the stream, ledger in onFinish]")
{
  const MODELS = read(CHOKEPOINT)
  const start = MODELS.indexOf("export async function streamTextRouted")
  const end = MODELS.indexOf("export async function generateSimpleText")
  const body = start !== -1 && end > start ? MODELS.slice(start, end) : ""
  check("streamTextRouted exists in lib/ai/models.ts (and generateSimpleText still follows it)",
    body.length > 0)
  const capAt = body.indexOf("checkAIFairUse(")
  const streamAt = body.indexOf("streamText({")
  check("the fair-use check runs BEFORE streamText — refuse before the first byte",
    capAt !== -1 && streamAt !== -1 && capAt < streamAt)
  check("a blocked tenant is refused with the typed AIFairUseError, not a bare Error",
    /if \(!fairUse\.allowed\) \{\s*\n\s*throw new AIFairUseError\(/.test(body))
  check("the ledger is the SAME logAIUsage every non-streaming call writes, inside onFinish",
    /onFinish: async \(event\) => \{[\s\S]*?logAIUsage\(\{/.test(body))
  check("...and it lands BEFORE the caller's own onFinish, so a throwing callback cannot lose it",
    body.indexOf("logAIUsage({") !== -1 &&
    body.indexOf("callerOnFinish?.(") !== -1 &&
    body.indexOf("logAIUsage({") < body.indexOf("callerOnFinish?.("))
  check("routing comes from the table (selectModelForTask), never a caller-named model",
    codeHits(body, "selectModelForTask(") === 1 && !/\bmodel\??:\s*string/.test(body))
  check("the Data Guard scrub is inherited here too, not left to each route",
    codeHits(body, "redactSensitive(") >= 2)
}

console.log("\n[(c) the eight former call sites — repointed, session-resolved identity]")
for (const rel of FORMER_CALL_SITES) {
  const src = read(rel)
  check(`${rel.replace("app/api/", "")}: imports streamTextRouted from @/lib/ai/models and calls it`,
    /import \{[^}]*streamTextRouted[^}]*\} from ["']@\/lib\/ai\/models["']/.test(src) &&
    codeHits(src, "streamTextRouted(") >= 1)
  check(`${rel.replace("app/api/", "")}: maps AIFairUseError to a pre-stream 429`,
    /AIFairUseError/.test(src) && codeHits(src, "instanceof AIFairUseError") >= 1)
}
// Identity must come from each route's own session resolution, never the body.
// Spot-pin the one route that historically took userId from the POST body
// (chat/stream, fixed in #178) — a body-sourced userId must never return.
check("chat/stream: no userId is read off the request body (session ctx only)",
  !/const \{[^}]*userId[^}]*\} = await req\.json\(\)/.test(read("app/api/chat/stream/route.ts")))

console.log("\n[(d) #187 closures — anonymous turns metered, history estimated, DID fails closed]")
{
  const MODELS = read(CHOKEPOINT)
  const start = MODELS.indexOf("export async function streamTextRouted")
  const end = MODELS.indexOf("export async function generateSimpleText")
  const body = start !== -1 && end > start ? MODELS.slice(start, end) : ""

  // GAP 1 — the cost of a turn ALWAYS lands on the tenant. A staff seat is
  // attribution on the row, never the condition for the row to exist.
  check("streamTextRouted: the ledger gate is the TENANT alone — no userId && brokerageId gate survives",
    codeHits(body, "if (brokerageId)") === 1 && codeHits(body, "userId && brokerageId") === 0)

  const COST = read("lib/ai/cost-tracking.ts")
  const logStart = COST.indexOf("export async function logAIUsage")
  const logEnd = COST.indexOf("export async function getCurrentMonthUsage")
  const logBody = logStart !== -1 && logEnd > logStart ? COST.slice(logStart, logEnd) : ""
  check("logAIUsage accepts a null user — anonymous tenant traffic lands in the ledger, not on the floor",
    codeHits(logBody, "userId: string | null") === 1)
  check("logAIUsage writes on the service client — the anonymous lanes have no session for RLS to pass",
    codeHits(logBody, "createServiceClient(") === 1 && codeHits(logBody, "await createClient(") === 0)

  const USAGE = read("lib/usage.ts")
  const incStart = USAGE.indexOf("export async function incrementUsage")
  const incEnd = USAGE.indexOf("export async function checkLimit")
  const incBody = incStart !== -1 && incEnd > incStart ? USAGE.slice(incStart, incEnd) : ""
  check("incrementUsage (the ai_tokens_monthly writer the cap reads) writes on the service client too",
    codeHits(incBody, "createServiceClient(") === 1 && codeHits(incBody, "await createClient(") === 0)

  const widget = read("app/api/widget/message/route.ts")
  check("widget/message: the ONLY brokerageId handed to the stream is the session row's — never the body's",
    codeHits(widget, "brokerageId:") === 1 && codeHits(widget, "brokerageId: session.brokerage_id") === 1)

  // GAP 2 — the pre-flight estimate must see the whole conversation, through
  // the ONE estimator, before checkAIFairUse decides.
  check("streamTextRouted: the pre-flight estimate folds the carried messages into estimateTokens, before the cap check",
    (() => {
      const est = body.indexOf("estimateTokens(")
      const msgs = body.indexOf("messagesTextForEstimate(request.messages)")
      const cap = body.indexOf("checkAIFairUse(")
      return est !== -1 && msgs !== -1 && cap !== -1 && est < msgs && msgs < cap
    })())
  check("messagesTextForEstimate returns TEXT for estimateTokens — it is not a second token heuristic",
    codeHits(MODELS, "function messagesTextForEstimate(") === 1 &&
    (() => {
      const h = MODELS.indexOf("function messagesTextForEstimate(")
      const hb = MODELS.slice(h, MODELS.indexOf("\n}", h))
      return codeHits(hb, "/ 4") === 0 && codeHits(hb, "Math.ceil(") === 0 && codeHits(hb, "estimateTokens(") === 0
    })())

  // GAP 3 — did/custom-llm fails CLOSED: no resolvable tenant, no stream.
  const did = read("app/api/did/custom-llm/route.ts")
  const callAt = firstCodeHit(did, "streamTextRouted(")
  const markerGate = firstCodeHit(did, "if (!contactId)")
  const tenantGate = firstCodeHit(did, "if (!ctx || !ctx.brokerageId)")
  check("did/custom-llm: a turn without the context marker is refused with a 4xx BEFORE the stream call",
    markerGate !== -1 && callAt !== -1 && markerGate < callAt &&
    /status: 400/.test(did.slice(markerGate, markerGate + 220)))
  check("did/custom-llm: an unresolvable contact or tenant is refused with a 4xx BEFORE the stream call",
    tenantGate !== -1 && callAt !== -1 && tenantGate < callAt &&
    /status: 403/.test(did.slice(tenantGate, tenantGate + 220)))
  check("did/custom-llm: the fail-open lane is gone — no mutable null ledger identity can reach the stream",
    codeHits(did, "let ledgerBrokerageId") === 0 && codeHits(did, "let ledgerUserId") === 0)
}

console.log("\n[negative controls — each scan must be able to fail]")
check("NEGATIVE — the code-hit scanner sees through neither comments nor strings",
  codeHits('// streamText(\nconst s = "streamText("', "streamText(") === 0 &&
  codeHits("const r = streamText({ model })", "streamText(") === 1)
check("NEGATIVE — a route that regressed to a direct call WOULD be caught",
  codeHits('import { streamText } from "ai"\nconst r = streamText({})', "streamText(") === 1)
check("NEGATIVE — the raw-import scan trips on streamText but NOT on streamTextRouted",
  RAW_IMPORT_RE.test('import { streamText, tool } from "ai"') &&
  !RAW_IMPORT_RE.test('import { streamTextRouted } from "@/lib/ai/models"') &&
  !RAW_IMPORT_RE.test('import { convertToModelMessages } from "ai"'))
check("NEGATIVE — the order comparator would flag a cap check placed AFTER the stream",
  (() => { const s = "streamText({}); checkAIFairUse("; const c = s.indexOf("checkAIFairUse("); const t = s.indexOf("streamText({"); return !(c !== -1 && t !== -1 && c < t) })())
check("NEGATIVE — the tenant-gate scan WOULD flag a resurrected userId && brokerageId ledger gate",
  codeHits("if (userId && brokerageId) { logAIUsage({}) }", "userId && brokerageId") === 1)
check("NEGATIVE — the estimate scan fails on the old prompt-only estimate",
  'const estTokens = estimateTokens((request.prompt ?? "") + (request.system ?? "")) + 2000'
    .indexOf("messagesTextForEstimate(request.messages)") === -1)
check("NEGATIVE — firstCodeHit skips commented and quoted mentions but finds real code",
  (() => {
    const s = '// streamTextRouted(\nconst x = "streamTextRouted("\nstreamTextRouted('
    return firstCodeHit(s, "streamTextRouted(") === s.lastIndexOf("streamTextRouted(") &&
      firstCodeHit('// only a comment mention', "streamTextRouted(") === -1
  })())
check("NEGATIVE — the DID order comparator flags a refusal placed AFTER the stream call",
  (() => {
    const s = "streamTextRouted({}); if (!contactId) return refuse()"
    const g = firstCodeHit(s, "if (!contactId)"); const c = firstCodeHit(s, "streamTextRouted(")
    return !(g !== -1 && c !== -1 && g < c)
  })())

console.log("\n" + "─".repeat(78))
console.log(`${pass} passed, ${fail} failed`)
if (fail) { for (const f of fails) console.log(`  ✗ ${f}`) ; process.exit(1) }
