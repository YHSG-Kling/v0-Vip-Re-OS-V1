#!/usr/bin/env tsx
/**
 * scripts/ai-spend-booked-guard.ts  (npm run test:ai-spend-booked) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * A MODEL CALL MUST BOOK ITS SPEND.
 *
 * CLAUDE.md §5: "AI is platform-covered, with per-tier overage. `ai_tool_usage`
 * is the cost ledger; it feeds `meter_readings.ai_tokens` and the overage
 * projection. A WRONG NUMBER THERE IS A WRONG INVOICE."
 *
 * A model call that writes no ledger row is not a small accounting gap. It is
 * spend the platform pays for and never sees: invisible to the tenant's overage
 * projection, invisible to the fair-use cap (`ai_tokens_monthly`), invisible to
 * per-manager cost (lib/platform/manager-ops.ts) and invisible to the per-agent
 * P&L (app/actions/pl-truth-engine.ts). Both of those read `ai_tool_usage` and
 * neither can report what was never written.
 *
 * ── WHY A NEW GUARD AND NOT AN EXTENSION (§6 checked, not assumed) ───────────
 *
 * Three neighbouring guards were read before this one was written. None owns
 * this claim; each owns a DIFFERENT property of the same call:
 *
 *   · scripts/ai-gateway-single-lane-guard.ts — WHICH LANE reaches the model
 *     ("ai goes through vercel ai gateway"). A call can be perfectly on-gateway
 *     and still book nothing.
 *   · scripts/data-guard-guard.ts — WHETHER THE PROMPT IS REDACTED before it
 *     leaves. Its baseline is the same shape as this one's and its corpus
 *     overlaps, but redaction and billing are independent: every one of its
 *     three "chokepoints" redacts, and only ONE of them books.
 *   · scripts/ai-overage-simulator.ts — the ARITHMETIC once rows exist
 *     (deriveAIOverage, quota, rate). It is downstream of this file: it proves
 *     the sum is right, this proves the addends were written at all.
 *
 * Extending any of them would have merged two claims into one red light. These
 * are siblings, not duplicates.
 *
 * ── WHAT IS ASSERTED ─────────────────────────────────────────────────────────
 *
 *   A1  THE RULE, NOT A NUMBER. Every production file that reaches a model on an
 *       UNBOOKING LANE must either book the spend itself (logAIUsage / a direct
 *       ai_tool_usage insert) or be named in UNBOOKED_DEBT below with a reason.
 *       A new unbooked call site fails CI. The debt list may only SHRINK.
 *
 *   A2  THE ROUTED LANE'S OWN BLIND SPOT DOES NOT GROW. lib/ai/models.ts writes
 *       the ledger under `if (request.brokerageId)` — so a call on the routed
 *       lane that omits `brokerageId` is ALSO unbilled. "Routed" is not a
 *       synonym for "booked", and this is a ratchet on that count.
 *
 *   A3  THE BOOKING PRIMITIVE STILL EXISTS AND STILL REACHES THE LEDGER.
 *       An absence assertion is worthless if the thing it points at moved.
 *
 *   A4  THE ROUTED LANES ACTUALLY CALL IT — executed against the source, so A1
 *       cannot pass by everyone migrating onto a lane that stopped booking.
 *
 *   PC  POSITIVE CONTROL, run on every invocation. §2: "a broken regex and a
 *       clean tree both report zero." The finder is executed against a synthetic
 *       unbooked call site and must FIND it, and against a booked one and must
 *       NOT. If the detector rots, this guard goes red before the tree does.
 *
 * ── HOW IT READS SOURCE, AND WHY THAT IS NOT OPTIONAL ────────────────────────
 *
 * Through scripts/strip-comments.ts, comments blanked AND string contents masked.
 * §2 of CLAUDE.md: "A TOMBSTONE IS NOT A CALL SITE." This is not hypothetical
 * here — the migration this guard accompanies left exactly that landmine:
 * lib/intelligence/intent-classifier.ts:1-2 is a tombstone reading
 *
 *     // ROUTED, was raw. This file used to `import { generateObject } from 'ai'`
 *
 * A guard reading raw source would match that comment, conclude the file still
 * imports the raw SDK, and accuse a file OF THE VERY THING THE TOMBSTONE RECORDS
 * HAVING FIXED — forever, because the tombstone is meant to stay. Five guards
 * failed precisely this way in one wave (2026-08-23). Strings are masked too, so
 * a fixture or a prompt containing "generateText" cannot register as a call.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, relative } from "node:path"
import { walkTs, rootRuntimeFiles } from "./runtime-roots"
import { stripComments, blankStrings } from "./strip-comments"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const BASELINE_PATH = join(root, "scripts", "ai-spend-booked-baseline.json")

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, extra?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n); console.log(`  ✗ ${n}${extra ? ` — ${extra}` : ""}`) }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE THREE UNBOOKING LANES.
//
// A lane is "unbooking" when reaching a model through it writes NO ai_tool_usage
// row, so the CALLER is the only one who can. Each was verified by reading the
// module, not by reputation:
//
//   raw      — `import { generateText } from "ai"`. No rails at all.
//   shim     — lib/ai/generate.ts. Its own header says it, verbatim at :175:
//              "unlike lib/ai/models.ts's routed lanes it never calls logAIUsage".
//              It returns GeneratedUsage (real provider counts + the SERVED
//              MODEL) precisely so a caller CAN book; a caller that takes the
//              usage and drops it is a different defect from one that never had
//              a figure, but the invoice is wrong either way.
//   guarded  — lib/data-guard/guarded-generate.ts. Redacts, then calls the raw
//              SDK. It is a DATA-GUARD chokepoint, not a billing one — being on
//              it satisfies data-guard-guard and says nothing about the ledger.
//
// The ROUTED lane (lib/ai/models.ts) is deliberately absent: it books, and A2
// covers the one condition under which it does not.
// ─────────────────────────────────────────────────────────────────────────────
const LANES = [
  { name: "raw", module: /^ai$/, fns: ["generateText", "generateObject", "streamText", "streamObject"] },
  { name: "shim", module: /(^@\/|\/)lib\/ai\/generate$/, fns: ["generateObject", "generateAIObject", "generateAIJSON", "generateAIText", "generateChatResponse"] },
  { name: "guarded", module: /(^@\/|\/)lib\/data-guard\/guarded-generate$/, fns: ["guardedGenerateText"] },
] as const

/** The routed lane — booked, but only when a tenant is passed (A2). */
const ROUTED_MODULE = /(^@\/|\/)lib\/ai\/models$/
const ROUTED_FNS = ["generateTextRouted", "generateObjectRouted", "streamTextRouted"]

/** A file books its own spend when it calls the ledger primitive or writes the table. */
const booksSpend = (code: string) =>
  /\blogAIUsage\s*\(/.test(code) || /\.from\(\s*["'`]ai_tool_usage["'`]\s*\)[\s\S]{0,200}?\.insert\s*\(/.test(code)

/**
 * Call sites of an unbooking lane in one file, alias-aware.
 * `import { generateTextRouted as generateText }` is the DOCUMENTED usage of the
 * routed lane (lib/ai/models.ts:609), so a scanner keyed on the local name would
 * read a routed call as a raw one. Binding is resolved from the import, never
 * from the identifier at the call site.
 */
function laneCallSites(code: string, codeKeepStrings: string) {
  const hits: Array<{ lane: string; fn: string; local: string }> = []
  const routed: Array<{ fn: string; local: string; idx: number }> = []
  const importRe = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g
  let m: RegExpExecArray | null
  while ((m = importRe.exec(codeKeepStrings))) {
    if (m[1]) continue // type-only import buys no runtime call
    const spec = m[3]
    for (const piece of m[2].split(",")) {
      const s = piece.trim()
      if (!s || s.startsWith("type ")) continue
      const [origRaw, localRaw] = s.split(/\s+as\s+/)
      const orig = origRaw.trim()
      const local = (localRaw ?? origRaw).trim()
      const callRe = new RegExp(`\\b${local.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:<[^;()]*?>)?\\s*\\(`)
      if (ROUTED_MODULE.test(spec) && ROUTED_FNS.includes(orig)) {
        const rx = new RegExp(callRe.source, "g")
        let c: RegExpExecArray | null
        while ((c = rx.exec(code))) routed.push({ fn: orig, local, idx: c.index })
        continue
      }
      for (const lane of LANES) {
        if (lane.module.test(spec) && (lane.fns as readonly string[]).includes(orig) && callRe.test(code)) {
          hits.push({ lane: lane.name, fn: orig, local })
        }
      }
    }
  }
  return { hits, routed }
}

/** Balanced argument text for the call whose `(` follows `from`. */
function argsAfter(code: string, from: number): string {
  const open = code.indexOf("(", from)
  if (open === -1) return ""
  let depth = 0
  for (let i = open; i < code.length; i++) {
    const c = code[i]
    if (c === "(" || c === "{" || c === "[") depth++
    else if (c === ")" || c === "}" || c === "]") { depth--; if (depth === 0) return code.slice(open + 1, i) }
  }
  return code.slice(open + 1)
}

// ─────────────────────────────────────────────────────────────────────────────
// PC · POSITIVE CONTROL — the finder is proved to work before it is trusted.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[PC · positive control — the finder recognises the defect it was written for]")
{
  const defect = `
import { generateText } from "ai"
export async function draft(p: string) {
  const { text } = await generateText({ model: "openai/gpt-4o-mini", prompt: p })
  return text
}`
  const booked = `
import { generateText } from "ai"
import { logAIUsage } from "@/lib/ai/cost-tracking"
export async function draft(p: string, brokerageId: string, userId: string) {
  const { text, usage } = await generateText({ model: "openai/gpt-4o-mini", prompt: p })
  await logAIUsage({ userId, brokerageId, model: "gpt-4o-mini", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, feature: "x" })
  return text
}`
  // A tombstone naming the raw SDK — must NOT read as a call site.
  const tombstone = `
// ROUTED, was raw. This file used to \`import { generateObject } from 'ai'\` and
// pass resolveModel('anthropic/claude-sonnet-4-20250514').
import { generateObjectRouted } from "@/lib/ai/models"
export async function go(brokerageId: string) {
  return generateObjectRouted({ feature: "x", brokerageId, schema: {} as never })
}`
  // A prompt STRING mentioning the SDK — must NOT read as a call site.
  const stringy = `
import { generateObjectRouted } from "@/lib/ai/models"
const HELP = "call generateText({ model }) from 'ai' to reach a model"
export async function go(brokerageId: string) { return generateObjectRouted({ feature: "x", brokerageId, schema: {} as never, prompt: HELP }) }`

  const analyse = (src: string) => {
    const noComments = stripComments(src)
    const code = blankStrings(noComments)
    const { hits, routed } = laneCallSites(code, noComments)
    return { unbooked: hits.length > 0 && !booksSpend(code), hits: hits.length, routed }
  }

  check("finds an UNBOOKED raw-SDK call site", analyse(defect).unbooked)
  check("does NOT flag the same call site once it books", analyse(booked).unbooked === false)
  check("a TOMBSTONE naming the raw SDK is not a call site (§2)", analyse(tombstone).hits === 0)
  check("the raw SDK named inside a STRING is not a call site (§2)", analyse(stringy).hits === 0)
  const r = analyse(`
import { generateTextRouted } from "@/lib/ai/models"
export async function go() { return generateTextRouted({ feature: "x", prompt: "hi" }) }`)
  check("finds a ROUTED call site that omits brokerageId (A2 detector alive)",
    r.routed.length === 1)
}

// ─────────────────────────────────────────────────────────────────────────────
// THE CORPUS
// ─────────────────────────────────────────────────────────────────────────────
const files = [
  ...walkTs(join(root, "app")),
  ...walkTs(join(root, "lib")),
  ...walkTs(join(root, "services")),
  ...rootRuntimeFiles(root),
]
  .filter((p) => !/\.(test|spec)\.tsx?$/.test(p))
  .map((p) => relative(root, p).replace(/\\/g, "/"))
  .sort()

/**
 * NAMED EXCLUSIONS — every entry carries the reason it is not a defect.
 * These are the files that MUST reach the raw SDK: they are the lanes
 * themselves. Nothing else belongs here; unclosed call sites go in the frozen
 * debt baseline instead, where they are visible and can only shrink.
 */
const LANE_MODULES: Record<string, string> = {
  "lib/ai/models.ts":
    "THE ROUTED LANE ITSELF. Wraps the raw SDK and is the only module that calls logAIUsage for it. Excluded because it IS the booking implementation — it also passes A4 below, which is the executed proof.",
  "lib/ai/generate.ts":
    "THE UNBOOKING SHIM ITSELF. Must import the raw SDK to wrap it. Deliberately books nothing (its own header, :175) and instead returns GeneratedUsage — real provider counts plus the SERVED MODEL — so its callers can book. Its callers are NOT excluded.",
  "lib/data-guard/guarded-generate.ts":
    "THE DATA-GUARD WRAPPER ITSELF. Redacts, then calls the raw SDK; scripts/data-guard-guard.ts owns that claim. Excluded as a lane module, not as a biller — its callers are NOT excluded.",
}

const unbookedNow: Record<string, string[]> = {}   // file → ["raw:generateText", …]
const routedNoTenant: Record<string, number> = {}  // file → count of routed sites missing brokerageId

for (const f of files) {
  let src: string
  try { src = readFileSync(join(root, f), "utf8") } catch { continue }
  if (!/generate(Text|Object)|streamText|streamObject|guardedGenerateText/.test(src)) continue

  const noComments = stripComments(src)
  const code = blankStrings(noComments)
  const { hits, routed } = laneCallSites(code, noComments)

  if (hits.length > 0 && !LANE_MODULES[f] && !booksSpend(code)) {
    unbookedNow[f] = [...new Set(hits.map((h) => `${h.lane}:${h.fn}`))].sort()
  }

  // A2 — routed, but no tenant, so lib/ai/models.ts's `if (request.brokerageId)`
  // never fires. A SPREAD (`...spendActor`) can carry the tenant in from a
  // helper (app/actions/ai-direct-mail.ts does exactly that), and this scanner
  // cannot follow it — so a spread counts as RESOLVED rather than being
  // reported as a defect it cannot prove. §1: write "unresolved", do not guess.
  const missing = routed.filter((rr) => {
    const args = argsAfter(code, rr.idx + rr.local.length - 1)
    return !/\bbrokerage_?Id\b/i.test(args) && !/\.\.\.[A-Za-z_$]/.test(args)
  })
  if (missing.length > 0) routedNoTenant[f] = missing.length
}

// ─────────────────────────────────────────────────────────────────────────────
// THE FROZEN DEBT
// ─────────────────────────────────────────────────────────────────────────────
type Baseline = { unbooked: Record<string, string[]>; routedWithoutTenant: Record<string, number> }
const empty: Baseline = { unbooked: {}, routedWithoutTenant: {} }
const baseline: Baseline = existsSync(BASELINE_PATH)
  ? { ...empty, ...(JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline) }
  : empty

const snapshot: Baseline = { unbooked: unbookedNow, routedWithoutTenant: routedNoTenant }

if (process.env.UPDATE_AI_SPEND_BASELINE === "1") {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(snapshot, null, 2)}\n`)
  const u = Object.keys(unbookedNow).length
  const r = Object.values(routedNoTenant).reduce((s, v) => s + v, 0)
  console.log(`\n  ✎ baseline rewritten — ${u} unbooked file(s), ${r} routed site(s) without a tenant.`)
  process.exit(0)
}

console.log("\n[A1 · no NEW unbooked model call site]")
const newUnbooked = Object.keys(unbookedNow).filter((f) => !baseline.unbooked[f])
const burnedUnbooked = Object.keys(baseline.unbooked).filter((f) => !unbookedNow[f])
console.log(`  unbooked call sites: ${Object.keys(unbookedNow).length} file(s) · frozen debt ${Object.keys(baseline.unbooked).length} · lane modules excluded ${Object.keys(LANE_MODULES).length}`)
console.log(`  corpus: ${files.length} production .ts/.tsx under app/ lib/ services/ + root runtime files (tests excluded)`)
if (burnedUnbooked.length > 0) {
  console.log(`  ↓ ${burnedUnbooked.length} file(s) now book their spend — re-freeze with UPDATE_AI_SPEND_BASELINE=1:`)
  for (const b of burnedUnbooked) console.log(`     · ${b}`)
}
check(`no NEW file reaches a model without booking (${newUnbooked.length} new)`,
  newUnbooked.length === 0, newUnbooked.join(", "))

console.log("\n[A2 · 'routed' is not a synonym for 'booked' — the blind spot may not grow]")
const totalNow = Object.values(routedNoTenant).reduce((s, v) => s + v, 0)
const totalWas = Object.values(baseline.routedWithoutTenant).reduce((s, v) => s + v, 0)
console.log(`  routed call sites with NO brokerageId: ${totalNow} across ${Object.keys(routedNoTenant).length} file(s) · frozen ${totalWas}`)
console.log("  (lib/ai/models.ts books under `if (request.brokerageId)` — these write no row)")
if (totalNow < totalWas) console.log(`  ↓ ${totalWas - totalNow} site(s) gained a tenant — re-freeze with UPDATE_AI_SPEND_BASELINE=1`)
const grew = Object.entries(routedNoTenant).filter(([f, n]) => n > (baseline.routedWithoutTenant[f] ?? 0))
check(`no file gained a routed call site without a tenant (${grew.length} grew)`,
  grew.length === 0, grew.map(([f, n]) => `${f} ${baseline.routedWithoutTenant[f] ?? 0}→${n}`).join(", "))

console.log("\n[A3 · the ledger primitive still exists and still reaches ai_tool_usage]")
const ct = blankStrings(stripComments(readFileSync(join(root, "lib/ai/cost-tracking.ts"), "utf8")))
const ctStrings = stripComments(readFileSync(join(root, "lib/ai/cost-tracking.ts"), "utf8"))
check("logAIUsage is exported from lib/ai/cost-tracking.ts", /export\s+async\s+function\s+logAIUsage\s*\(/.test(ct))
check("logAIUsage inserts into ai_tool_usage", /from\(\s*["']ai_tool_usage["']\s*\)[\s\S]{0,400}?\.insert\s*\(/.test(ctStrings))
check("logAIUsage names the model on the row (m508: tokens must name their model)", /model_used:\s*params\.model/.test(ctStrings))

console.log("\n[A4 · the routed lanes actually call the primitive — else A1 passes onto a dead lane]")
const models = blankStrings(stripComments(readFileSync(join(root, "lib/ai/models.ts"), "utf8")))
const logCalls = (models.match(/\blogAIUsage\s*\(/g) ?? []).length
check(`lib/ai/models.ts calls logAIUsage on every routed lane (found ${logCalls}, need ≥4: generateAIResponse + generateTextRouted + generateObjectRouted + streamTextRouted)`,
  logCalls >= 4)
check("lib/ai/generate.ts still exposes GeneratedUsage with the SERVED MODEL, so shim callers can book",
  /export\s+interface\s+GeneratedUsage/.test(blankStrings(stripComments(readFileSync(join(root, "lib/ai/generate.ts"), "utf8")))) &&
  /model:\s*AIModel\s*\|\s*null/.test(blankStrings(stripComments(readFileSync(join(root, "lib/ai/generate.ts"), "utf8")))))

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) {
  for (const f of fails) console.log(`   · ${f}`)
  console.log(" ❌ AI_SPEND_BOOKED_FAIL")
  process.exit(1)
}
console.log(` ✅ AI_SPEND_BOOKED_PASS — no new unbooked model call; ${Object.keys(baseline.unbooked).length} file(s) + ${totalWas} routed site(s) of frozen debt, which may only shrink`)
