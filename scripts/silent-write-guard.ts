#!/usr/bin/env tsx
/**
 * scripts/silent-write-guard.ts   (npm run test:silent-write) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * A REJECTED WRITE LOOKS EXACTLY LIKE A SUCCESSFUL ONE.
 *
 * supabase-js RESOLVES a rejected write. A CHECK violation, an RLS refusal, a
 * constraint breach — all come back as `{ error }` instead of throwing. So:
 *
 *     await svc.from("subscriptions").update(patch).eq("id", id)
 *
 * cannot tell you whether anything happened. That single line is how a cancelled
 * tenant kept paid access for free: Stripe's 'canceled' spelling was rejected by
 * the column's CHECK, the error was dropped, and the row kept its stale 'active'
 * while the paywall read it and let them in.
 *
 * It is the same shape as most of the silent failures found in this codebase —
 * an AI review that reported "configured" and persisted nothing, a de-confliction
 * ledger whose writes were discarded, a step ledger written best-effort. The
 * CHECK-vocabulary guard cannot catch these: it reads inline literals, and the
 * value that broke billing arrived in a VARIABLE from the Stripe API.
 *
 * ── WHAT THIS FORBIDS (and what it does not) ────────────────────────────────
 * Plenty of writes SHOULD be allowed to fail. An audit echo must not break the
 * gate decision it records; a ledger mirror must not fail the payout it mirrors.
 * That is a legitimate choice — the problem is that a deliberate best-effort
 * write and an accidentally-silent one are INDISTINGUISHABLE in the source, so
 * no reviewer and no guard can tell them apart.
 *
 * So this does not ban silent writes. It bans UNDECLARED ones, and only on the
 * tables where losing a write changes what a human is OWED or ALLOWED. On those,
 * a write must either check its error or say out loud that it may fail, by going
 * through lib/db/best-effort.ts with a reason.
 *
 * SCOPE: server code (.ts under app/actions, app/api, lib). Consequential writes
 * belong there; a .tsx client component writing money or access directly would
 * be its own finding, and excluding JSX keeps the statement parser honest.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}

/**
 * Tables where a lost write changes what a human is owed or allowed:
 * money, platform access, and the compliance record.
 */
export const CONSEQUENTIAL_TABLES = [
  "subscriptions", "billing_invoices", "vendor_invoices",
  "commissions", "commission_distributions", "agent_commissions", "transaction_commissions",
  "platform_credentials",
  "compliance_events", "required_disclosures",
  "vendor_directory",
  // ACTIVITIES BELONGS HERE, and its absence was the gap that let a whole class
  // through. This set was money + compliance ledgers; activities is BOTH a
  // compliance record and an operational one. The kernel's conversation memory
  // reads channel/outcome/title straight into the AI's picture of a contact, so
  // a lost row makes the assistant believe an outreach never happened — and a
  // FABRICATED one made it believe an outreach did. It is also the row a broker
  // would hand a regulator as evidence of what was sent. Six writes to it were
  // dropping their result on the floor when this line was added; they are fixed,
  // and this keeps them fixed.
  "activities",
] as const

/** PURE — split source into statements on depth-0 semicolons, string-aware. */
export function splitStatements(src: string): string[] {
  const out: string[] = []
  let buf = "", depth = 0, quote: string | null = null, esc = false
  for (const c of src) {
    buf += c
    if (esc) { esc = false; continue }
    if (quote) { if (c === "\\") esc = true; else if (c === quote) quote = null; continue }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue }
    if ("([{".includes(c)) depth++
    else if (")]}".includes(c)) depth--
    else if (c === ";" && depth === 0) { out.push(buf); buf = "" }
  }
  if (buf.trim()) out.push(buf)
  return out
}

/** PURE — does this statement write a consequential table without acknowledging failure? */
export function isSilentWrite(stmt: string, tables: readonly string[] = CONSEQUENTIAL_TABLES): string | null {
  const m = stmt.match(/\.from\(["'](\w+)["']\)/)
  if (!m || !tables.includes(m[1])) return null

  // SCOPED TO THE WRITE, not to the whole chunk.
  //
  // splitStatements cuts on depth-0 semicolons, and much of this codebase omits
  // them — a semicolon-free module is ONE chunk, i.e. the entire file. Judging
  // the chunk then answers the wrong question in both directions:
  //   · FALSE POSITIVE — one unrelated `.catch(() => {})` anywhere in the file
  //     (e.g. on a processKernelEvent call) marked every write in it swallowed.
  //   · FALSE NEGATIVE, the dangerous one — one `const { error } = …` anywhere
  //     in the file marked every OTHER write in it captured, so a whole module's
  //     silent writes hid behind a single correct one.
  // Looking at a window around THIS write asks the question that was meant:
  // does this write acknowledge its own failure? The lookbehind covers the
  // `const { error } = await svc` that precedes `.from(`; the lookahead covers
  // the rest of the chain, including a trailing `.catch`.
  const start = Math.max(0, m.index! - 160)
  const scope = stmt.slice(start, m.index! + 600)

  if (!/\.(insert|update|upsert|delete)\s*\(/.test(scope)) return null
  // Declared as allowed-to-fail, with a reason.
  if (/\bbestEffort\s*\(/.test(scope)) return null
  // The result is captured somewhere the caller can inspect.
  const captured =
    /(const|let|var)\s*\{[^}]*\berror\b/.test(scope) ||
    /(const|let|var)\s+\w+\s*=\s*await/.test(scope) ||
    /\breturn\s+await/.test(scope) ||
    /^\s*return\s/.test(scope)
  // Explicitly thrown away — only when it hangs off THIS chain.
  const tail = stmt.slice(m.index!, m.index! + 600)
  const swallowed = /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(tail) || /\bvoid\s+Promise/.test(tail)
  return (!captured || swallowed) ? m[1] : null
}

console.log("══════════════════════════════════════════════════")
console.log(" Silent-write guard (a rejected write must not look like a success)")
console.log("══════════════════════════════════════════════════")

console.log("\n[pure — the detector]")
{
  // The exact line that cost a cancelled tenant's access.
  check("flags the paywall shape: an awaited update with no error check",
    isSilentWrite(`await svc.from("subscriptions").update(patch).eq("id", target.id)`) === "subscriptions")
  check("accepts it once the error is destructured",
    isSilentWrite(`const { error } = await svc.from("subscriptions").update(patch).eq("id", id)`) === null)
  check("accepts a captured result the caller can inspect",
    isSilentWrite(`const res = await svc.from("commissions").insert(row)`) === null)
  check("accepts a DECLARED best-effort write",
    isSilentWrite(`await bestEffort(svc.from("compliance_events").insert(row), "audit echo")`) === null)
  check("still flags a write whose error is explicitly thrown away",
    isSilentWrite(`const { error } = await svc.from("commissions").insert(row).catch(() => {})`) === "commissions")
  check("flags void Promise fire-and-forget",
    isSilentWrite(`void Promise.resolve(svc.from("agent_commissions").update(x))`) === "agent_commissions")
  check("ignores a READ on a consequential table",
    isSilentWrite(`const { data } = await svc.from("subscriptions").select("status")`) === null)
  check("ignores a write to a table outside the consequential set",
    isSilentWrite(`await svc.from("page_views").insert(row)`) === null)

  // No `.from("…")` in this fixture on purpose: the schema-drift guard also
  // scans this file and would read a fake table name here as a real one.
  check("splitStatements keeps a multi-line chain together",
    splitStatements(`const { error } = await a\n  .select(b)\n  .update(y);\nfoo();`).length === 2)
  check("…and is not fooled by a semicolon inside a string",
    splitStatements(`const a = "x;y"; const b = 1;`).length === 2)
}

console.log("\n[repo scan — server surface]")
{
  const roots = ["app/actions", "app/api", "lib"]
  const files: string[] = []
  const walk = (d: string) => {
    if (!existsSync(d)) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith(".ts")) files.push(p)
    }
  }
  roots.forEach(walk)

  const found: string[] = []
  for (const f of files) {
    const src = readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "")
    for (const stmt of splitStatements(src)) {
      const table = isSilentWrite(stmt)
      if (table) found.push(`${f} → ${table}`)
    }
  }
  console.log(`  · ${files.length} server files scanned · ${CONSEQUENTIAL_TABLES.length} consequential tables`)
  check(`no undeclared silent write on a consequential table (${found.length} found)`,
    found.length === 0, found.slice(0, 8).join(" | "))

  // The helper must exist and actually surface the failure it tolerates —
  // otherwise "declaring" a write best-effort would just be a nicer way to hide.
  const be = existsSync("lib/db/best-effort.ts") ? readFileSync("lib/db/best-effort.ts", "utf8") : ""
  check("bestEffort exists and takes a REASON", /export async function bestEffort/.test(be) && /reason: string/.test(be))
  check("…and logs the failure rather than swallowing it", /console\.warn/.test(be))
  check("…and reports ok/error back to the caller", /ok: false/.test(be) && /ok: true/.test(be))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ SILENT_WRITE_FAIL"); process.exit(1) }
console.log(" ✅ SILENT_WRITE_PASS — every consequential write checks its error or declares it may fail")
