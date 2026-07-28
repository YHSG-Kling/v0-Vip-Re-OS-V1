#!/usr/bin/env tsx
/**
 * scripts/agent-id-class-guard.ts   (npm run test:agent-id-class) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE WRONG-CLASS WRITE. This schema is split-brain: some columns named agent_id
 * FOREIGN KEY agents(id) and others FK users(id). newsletter_scheduled_sends.agent_id
 * is a users.id; net_sheet_calculations.agent_id is an agents.id. The column NAME
 * tells you nothing, so `agent_id: user.id` reads fine in review and is rejected by
 * the foreign key at runtime.
 *
 * lib/kernel/agent-identity.ts states the rule in its own header — "NEVER do:
 * agentId = user.id" — and a prior pass fixed 60+ sites. It still missed
 * saveNetSheet, where the consequence was total: every insert was FK-rejected, so
 * net_sheet_calculations held ZERO rows and the seller net sheet's Save button had
 * never once worked. A rule a human has to remember is not a rule; this is the
 * ratchet that enforces it.
 *
 * WHAT IT CHECKS. For every `.from(t)` chain that inserts/upserts/updates, any
 * payload key that is an agents(id) FK column on THAT table must not be assigned a
 * user-id expression.
 *
 * The window is cut at the NEXT `.from(` on purpose. A fixed-size window spills into
 * the following query and mis-attributes its payload — that produced 6 false
 * positives out of 15 on the first sweep, including flagging
 * newsletter_scheduled_sends.agent_id, which is CORRECTLY a users.id.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { AGENT_FK_COLUMNS, USERS_FK_AGENTISH_COLUMNS } from "./agent-fk-columns"

const root = process.cwd()

/** Expressions that denote a users.id. */
const USER_ID_EXPR = /\b(user\.user\.id|user\.id|userId|session\.user\.id|authUserId|currentUserId)\b/
/** Already routed through the canonical resolver (or a value known to be an agents.id). */
const RESOLVED = /resolveAgentId|requireAgentId|actingAgentId|\bagentId\b|agent\.id|agentRow/

/**
 * Expressions that ARE an agents.id — the REVERSE-direction hazard. Writing one of
 * these into a users(id) FK is exactly as broken as the forward case, and it cost
 * more: listing_promo_videos.agent_id killed the whole lifecycle-promo path, and
 * listing_health_scores/interventions.agent_id meant the listing-health scorer had
 * never persisted a single row.
 */
const AGENT_ID_EXPR = /\b(resolveAgentId|requireAgentId|agentRecordId|actingAgentId|\w*[Ll]isting\.agent_id|\w*[Cc]ontact\.agent_id|\w*[Tt]ransaction\.agent_id|listings\.agent_id|l\.agent_id)\b/
/** A plain users.id — correct for a users(id) FK. */
const USER_ID_OK = /\b(user\.user\.id|user\.id|userId|agentUserId|\w*[Uu]serId|session\.user\.id)\b/

function* walk(dir: string): Generator<string> {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return }
  for (const n of entries) {
    if (n === "node_modules" || n === ".next" || n.startsWith(".")) continue
    const p = join(dir, n)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (/\.(ts|tsx)$/.test(n)) yield p
  }
}

export interface WrongClassWrite { file: string; table: string; column: string; expr: string }

/** PURE — exported so the checks below can exercise it directly. */
export function scanSource(src: string, file: string): WrongClassWrite[] {
  const out: WrongClassWrite[] = []
  for (const [table, cols] of Object.entries(AGENT_FK_COLUMNS)) {
    const needle = `.from("${table}")`
    let i = src.indexOf(needle)
    while (i !== -1) {
      const rest = src.slice(i + needle.length)
      const nextFrom = rest.search(/\.from\(/)
      const win = needle + (nextFrom >= 0 ? rest.slice(0, nextFrom) : rest.slice(0, 1200))
      if (/\.(insert|upsert|update)\s*\(/.test(win)) {
        for (const col of cols) {
          const re = new RegExp(`\\b${col}\\s*:\\s*([^,\\n}]+)`, "g")
          let m: RegExpExecArray | null
          while ((m = re.exec(win))) {
            const expr = m[1].trim()
            if (USER_ID_EXPR.test(expr) && !RESOLVED.test(expr)) {
              out.push({ file, table, column: col, expr: expr.slice(0, 80) })
            }
          }
        }
      }
      i = src.indexOf(needle, i + 1)
    }
  }
  return out
}

/** PURE — the REVERSE direction: an agents.id written into a users(id) FK. */
export function scanSourceReverse(src: string, file: string): WrongClassWrite[] {
  const out: WrongClassWrite[] = []
  for (const [table, cols] of Object.entries(USERS_FK_AGENTISH_COLUMNS)) {
    const needle = `.from("${table}")`
    let i = src.indexOf(needle)
    while (i !== -1) {
      const rest = src.slice(i + needle.length)
      const nextFrom = rest.search(/\.from\(/)
      const win = needle + (nextFrom >= 0 ? rest.slice(0, nextFrom) : rest.slice(0, 1200))
      if (/\.(insert|upsert|update)\s*\(/.test(win)) {
        for (const col of cols) {
          const re = new RegExp(`\\b${col}\\s*:\\s*([^,\\n}]+)`, "g")
          let m: RegExpExecArray | null
          while ((m = re.exec(win))) {
            const expr = m[1].trim()
            if (AGENT_ID_EXPR.test(expr) && !USER_ID_OK.test(expr)) {
              out.push({ file, table, column: col, expr: expr.slice(0, 80) })
            }
          }
        }
      }
      i = src.indexOf(needle, i + 1)
    }
  }
  return out
}

let passed = 0, failed = 0
const failures: string[] = []
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

console.log("══════════════════════════════════════════════════")
console.log(" Agent id-class guard (no users.id may be written to an agents(id) FK)")
console.log("══════════════════════════════════════════════════")

console.log("\n[pure — the detector]")
check("flags a raw user.id on an agents(id) column",
  scanSource('await svc.from("activities").insert({ agent_id: user.id })', "t.ts").length === 1)
check("accepts a resolveAgentId call",
  scanSource('await svc.from("activities").insert({ agent_id: await resolveAgentId(svc, user.id) })', "t.ts").length === 0)
check("accepts an already-resolved agent id variable",
  scanSource('await svc.from("activities").insert({ agent_id: actingAgentId })', "t.ts").length === 0)
check("ignores a column that is NOT an agents(id) FK (users-FK agent_id)",
  scanSource('await svc.from("newsletter_scheduled_sends").insert({ agent_id: user.id })', "t.ts").length === 0)
check("does not spill into the NEXT query's payload",
  scanSource(
    'await svc.from("activities").select("id").eq("x",1)\n' +
    'await svc.from("newsletter_scheduled_sends").insert({ agent_id: user.id })', "t.ts",
  ).length === 0)
check("ignores a read-only chain (no insert/update)",
  scanSource('await svc.from("activities").select("agent_id").eq("agent_id", user.id)', "t.ts").length === 0)

console.log("\n[pure — the REVERSE detector]")
check("flags a resolved agents.id on a users(id) FK",
  scanSourceReverse('await svc.from("listing_promo_videos").insert({ agent_id: await resolveAgentId(svc, x) })', "t.ts").length === 1)
check("flags listings.agent_id on a users(id) FK",
  scanSourceReverse('await svc.from("listing_health_scores").insert({ agent_id: listing.agent_id })', "t.ts").length === 1)
check("accepts a genuine users.id there",
  scanSourceReverse('await svc.from("transparency_updates").insert({ agent_id: user.id })', "t.ts").length === 0)
check("accepts an already-normalised agentUserId",
  scanSourceReverse('await svc.from("listing_promo_videos").insert({ agent_id: agentUserId })', "t.ts").length === 0)

console.log("\n[repo scan]")
const files: string[] = []
for (const d of ["app", "lib", "services"]) for (const f of walk(join(root, d))) files.push(f)
const offenders: WrongClassWrite[] = []
for (const f of files) {
  let src = ""
  try { src = readFileSync(f, "utf8") } catch { continue }
  if (!src.includes(".from(")) continue
  offenders.push(...scanSource(src, relative(root, f).replace(/\\/g, "/")))
}
console.log(`  · ${files.length} files scanned · ${Object.keys(AGENT_FK_COLUMNS).length} tables carry an agents(id) FK`)
check("no user-id expression is written to an agents(id) FK column",
  offenders.length === 0,
  offenders.map((o) => `${o.file}: ${o.table}.${o.column} = ${o.expr}`).join("; "))

const reverse: WrongClassWrite[] = []
for (const f of files) {
  let src = ""
  try { src = readFileSync(f, "utf8") } catch { continue }
  if (!src.includes(".from(")) continue
  reverse.push(...scanSourceReverse(src, relative(root, f).replace(/\\/g, "/")))
}
console.log(`  · ${Object.keys(USERS_FK_AGENTISH_COLUMNS).length} tables carry an agent-ISH users(id) FK`)
check("no agents-id expression is written to a users(id) FK column",
  reverse.length === 0,
  reverse.map((o) => `${o.file}: ${o.table}.${o.column} = ${o.expr}`).join("; "))

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log(" ✗ Failures:")
  for (const f of failures) console.log(`   - ${f}`)
  console.log(" ❌ AGENT_ID_CLASS_FAIL — resolve through resolveAgentId (lib/kernel/agent-identity)")
  process.exit(1)
}
console.log(" ✅ AGENT_ID_CLASS_PASS — every agents(id) FK write carries an agents.id")
