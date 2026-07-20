#!/usr/bin/env tsx
/**
 * scripts/launch-checklist-simulator.ts  (npm run test:launch-checklist) — pure, no DB.
 *
 * THE LAUNCH CHECKLIST STAYS HONEST — locks for lib/platform/launch-checklist.ts
 * and the public-surface rate limiter:
 *
 *   1. NO ASPIRATIONAL ROWS — every envVar named by a checklist row actually
 *      appears as process.env.<VAR> somewhere in the shipped codebase
 *      (grep-verified; a row for a var nothing reads is tribal fiction).
 *   2. NO VALUE ECHOING — the module touches process.env in exactly one
 *      presence helper; a canary value planted in the env NEVER appears in
 *      the serialized checklist (runtime lock, not just a lint).
 *   3. TIER VOCABULARY — exactly launch-blocking / launch-degraded / optional,
 *      and the rollup counts reconcile with the items.
 *   4. BOARD MOUNT — the superadmin go-live board (connectors page) renders
 *      the LaunchChecklistCard fed by buildLaunchChecklist().
 *   5. PUBLIC RATE LIMITER — the keep-one helper exists with its per-instance
 *      honesty note, and the worst public POST surfaces (signup, get-started
 *      coupon check, widget session + message) are wired to it.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, relative } from "node:path"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel: string) => readFileSync(join(root, rel), "utf8")

// ── Collect every process.env.<VAR> reference in the shipped code ───────────
const SCAN_DIRS = ["lib", "app", "services"]
const envRefs = new Set<string>()
function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const abs = join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) { walk(abs); continue }
    if (!/\.(ts|tsx|js|mjs)$/.test(name)) continue
    const rel = relative(root, abs).replace(/\\/g, "/")
    if (rel === "lib/platform/launch-checklist.ts") continue // rows can't self-verify
    const src = readFileSync(abs, "utf8")
    for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) envRefs.add(m[1]!)
  }
}
for (const d of SCAN_DIRS) walk(join(root, d))

async function main() {
  console.log("\nLAUNCH CHECKLIST SIMULATOR — presence-map honesty locks\n")

  // ── 1+2+3. Runtime locks on the module itself ─────────────────────────────
  console.log("checklist module (runtime)")
  const CANARY = "sk_sim_canary_value_never_echoed_XyZ123"
  process.env.STRIPE_SECRET_KEY = CANARY          // blocking row, single-var
  process.env.ELEVENLABS_API_KEY = CANARY         // degraded row
  delete process.env.LOB_API_KEY                  // optional row, forced absent

  const { buildLaunchChecklist } = await import("../lib/platform/launch-checklist")
  const checklist = buildLaunchChecklist()
  const json = JSON.stringify(checklist)

  check("canary env VALUE never appears in the serialized checklist (no value echoing)", !json.includes(CANARY))
  const stripeRow = checklist.items.find((i) => i.envVars.includes("STRIPE_SECRET_KEY"))
  check("presence detection works — set var reads configured=true", stripeRow?.configured === true)
  const lobRow = checklist.items.find((i) => i.envVars.includes("LOB_API_KEY"))
  check("absence detection works — unset var reads configured=false", lobRow?.configured === false)

  const ALLOWED_FIELDS = new Set(["key", "capability", "envVars", "anyOf", "configured", "whatLightsUp", "tier"])
  const strayFields = checklist.items.flatMap((i) => Object.keys(i).filter((k) => !ALLOWED_FIELDS.has(k)))
  check("item shape carries no value-bearing field (return type lock)", strayFields.length === 0, [...new Set(strayFields)].join(", "))

  const TIERS = new Set(["launch-blocking", "launch-degraded", "optional"])
  const badTiers = checklist.items.filter((i) => !TIERS.has(i.tier))
  check("tier vocabulary is exactly launch-blocking / launch-degraded / optional", badTiers.length === 0, badTiers.map((i) => i.key).join(", "))
  const n = (t: string) => checklist.items.filter((i) => i.tier === t).length
  const c = (t: string) => checklist.items.filter((i) => i.tier === t && i.configured).length
  check("rollup counts reconcile with the items",
    checklist.blockingTotal === n("launch-blocking") && checklist.blockingConfigured === c("launch-blocking") &&
    checklist.degradedTotal === n("launch-degraded") && checklist.degradedConfigured === c("launch-degraded") &&
    checklist.optionalTotal === n("optional") && checklist.optionalConfigured === c("optional"))
  check("checklist has blocking, degraded, and optional tiers populated",
    checklist.blockingTotal >= 8 && checklist.degradedTotal >= 8 && checklist.optionalTotal >= 5,
    `${checklist.blockingTotal}/${checklist.degradedTotal}/${checklist.optionalTotal}`)
  const dupKeys = checklist.items.map((i) => i.key).filter((k, ix, a) => a.indexOf(k) !== ix)
  check("row keys unique", dupKeys.length === 0, dupKeys.join(", "))

  // ── 1. Every row's env vars are REAL gates in the codebase ────────────────
  console.log("\nno aspirational rows (grep-verified env vars)")
  const missing: string[] = []
  for (const item of checklist.items) {
    for (const v of item.envVars) if (!envRefs.has(v)) missing.push(`${item.key}:${v}`)
  }
  check(`every checklist envVar appears as process.env.<VAR> in lib/app/services (${checklist.items.length} rows)`,
    missing.length === 0, missing.join(", "))

  // ── 2. Static value-echo lock on the module source ────────────────────────
  console.log("\nchecklist module (source)")
  const src = read("lib/platform/launch-checklist.ts")
  // Code-level env reads only: `process.env[...]` or `process.env.FOO` — the
  // header's prose mentions of "process.env.<VAR>" don't count as touches.
  const envTouches = src.match(/process\.env(\[|\.[A-Z])/g) ?? []
  check("module touches process.env exactly once (the presence helper)", envTouches.length === 1, `${envTouches.length} touches`)
  check("no template interpolation of env values", !/\$\{[^}]*process\.env/.test(src))

  // ── 4. Board mount ────────────────────────────────────────────────────────
  console.log("\ngo-live board mount")
  const page = read("app/dashboard/superadmin/connectors/page.tsx")
  const card = read("app/dashboard/superadmin/connectors/go-live-card.tsx")
  check("connectors page imports buildLaunchChecklist (server-side presence compute)", page.includes("buildLaunchChecklist"))
  check("connectors page mounts <LaunchChecklistCard", page.includes("<LaunchChecklistCard"))
  check("go-live-card exports LaunchChecklistCard beside the probe card (keep-one board)",
    card.includes("export function LaunchChecklistCard") && card.includes("export function GoLiveCard"))
  check("card copy states the presence-only / no-values posture", /values are never read|Presence only/i.test(card))

  // ── 5. Public-surface rate limiter ────────────────────────────────────────
  console.log("\npublic-surface rate limiter")
  const limiterPath = "lib/security/public-rate-limit.ts"
  check("keep-one limiter helper exists", existsSync(join(root, limiterPath)))
  const limiter = read(limiterPath)
  check("limiter documents its PER-INSTANCE honesty note + distributed v2", /PER-INSTANCE/i.test(limiter) && /distributed/i.test(limiter))
  check("limiter is dependency-free (no upstash/redis import)", !/from ["'](@upstash|ioredis|redis)/.test(limiter))
  check("limiter bounds its memory (prune/max-entries)", /MAX_ENTRIES/.test(limiter))

  const WIRED: Array<[string, string]> = [
    ["app/actions/auth/signup-brokerage.ts", "signup (tenant provisioning)"],
    ["app/get-started/actions.ts", "get-started coupon check"],
    ["app/api/widget/session/route.ts", "widget session mint"],
    ["app/api/widget/message/route.ts", "widget chat (LLM spend)"],
  ]
  for (const [rel, label] of WIRED) {
    const s = read(rel)
    check(`${label} wired to checkPublicRateLimit`, s.includes("checkPublicRateLimit"), rel)
  }
  check("widget routes answer 429 with Retry-After",
    read("app/api/widget/session/route.ts").includes("Retry-After") &&
    read("app/api/widget/message/route.ts").includes("Retry-After"))

  // ── Verdict ───────────────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log("\nFailures:")
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
  console.log("\nLaunch checklist locks hold: real env gates only, values never echoed, board mounted, public surfaces throttled.")
}

main().catch((e) => { console.error(e); process.exit(1) })
