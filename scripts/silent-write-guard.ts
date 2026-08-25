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
import { readFileSync, existsSync, writeFileSync } from "node:fs"
import { walkTs, rootRuntimeFiles } from "./runtime-roots"
import { join } from "node:path"
import { stripComments } from "./strip-comments"

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
  // VENDORS carries the premium-placement flags since m355 (they were on
  // vendor_directory, which was in this list). markPlacementPaid flipping
  // `preferred` is the DELIVERY of something a vendor paid for — a lost write
  // there is a paid placement that silently never happens. It also carries
  // `status`, which is the broker approval gate deciding whether a vendor may be
  // booked or shown to a client at all.
  "vendors",
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
  // CONTACTS carries the consent flags — email_unsubscribed, sms_opt_out,
  // tcpa_consent, dnc_status, ai_autopilot_level. A silently-lost write here is
  // a consumer's opt-out that did not take effect while the UI said it did,
  // which is the single most expensive thing in this product to get wrong.
  "contacts",
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
  // EVERY `.from(` IN THE CHUNK, NOT THE FIRST ONE.
  //
  // This used to be `stmt.match(...)` — a single, non-global match — so the whole
  // careful per-write windowing below ran against exactly ONE write per chunk, and
  // if that first `.from(` named a table outside the consequential list the
  // function returned null for everything after it.
  //
  // Combined with splitStatements, which cuts on DEPTH-0 SEMICOLONS, that is a
  // whole-file blind spot rather than an edge case: a module written without
  // trailing semicolons is ONE chunk, so the first `.from()` in the file decided
  // the verdict for the entire file. `proxy.ts` is exactly such a module — its
  // first `.from()` is `blog_posts`, not consequential — and a silent write to
  // `commissions` appended to it was not judged clean, it was never examined.
  //
  // Found because the runtime-roots merge put proxy.ts in this guard's corpus for
  // the first time; the identical fixture in lib/ was caught, which is what made
  // the difference a finder bug rather than a corpus one. The header below already
  // described per-write scoping — this loop is what makes that description true
  // for the second and subsequent writes in a chunk.
  return silentWritesIn(stmt, tables)[0] ?? null
}

/**
 * PURE — EVERY silent consequential write in this chunk, not just the first.
 *
 * `isSilentWrite` answers with one verdict because its positive controls are
 * written that way, but the repo scan must not stop at the first hit: chunks here
 * are frequently WHOLE FILES (see the semicolon note above), so "first silent
 * write in the chunk" would report at most one site per file and undercount every
 * module that has more than one.
 */
export function silentWritesIn(stmt: string, tables: readonly string[] = CONSEQUENTIAL_TABLES): string[] {
  const out: string[] = []
  for (const m of stmt.matchAll(/\.from\(["'](\w+)["']\)/g)) {
    if (!tables.includes(m[1])) continue
    const table = judgeOneWrite(stmt, m.index!, m[1])
    if (table) out.push(table)
  }
  return out
}

/** PURE — the verdict for the single write whose `.from(` sits at `at`. */
function judgeOneWrite(stmt: string, at: number, table: string): string | null {
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
  // The WRITE VERB must belong to THIS chain. A fixed-size lookahead is not
  // good enough: a `.from("contacts").select(…)` READ followed a few lines later
  // by an unrelated `.update(…)` would be read as a silent write. Walk the
  // actual method chain — `.name( … )` runs with balanced parens — and stop at
  // the first token that is not part of it.
  const chain = chainFrom(stmt, at)

  if (!/\.(insert|update|upsert|delete)\s*\(/.test(chain)) return null
  // Declared as allowed-to-fail, with a reason. The wrapper sits BEFORE .from(,
  // so look at the lookbehind for it too.
  const lookbehind = stmt.slice(Math.max(0, at - 160), at)
  if (/\bbestEffort\s*\(/.test(lookbehind) || /\bbestEffort\s*\(/.test(chain)) return null
  // The result is captured somewhere the caller can inspect — the binding is to
  // the LEFT of `.from(`.
  const captured =
    /(const|let|var)\s*\{[^}]*\berror\b/.test(lookbehind) ||
    /(const|let|var)\s+\w+\s*=\s*await/.test(lookbehind) ||
    /\breturn\s+await/.test(lookbehind) ||
    /(^|\n)\s*return\s+[^\n]*$/.test(lookbehind)
  // Explicitly thrown away — only when it hangs off THIS chain.
  const swallowed =
    /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(chain) ||
    /\bvoid\s+Promise/.test(lookbehind)
  return (!captured || swallowed) ? table : null
}

/** PURE — the contiguous `.method(…)` chain starting at `.from(` at index i. */
export function chainFrom(src: string, i: number): string {
  let p = i
  const end = src.length
  while (p < end) {
    // skip whitespace between links
    while (p < end && /\s/.test(src[p])) p++
    if (src[p] !== ".") break
    let q = p + 1
    while (q < end && /[\w$]/.test(src[q])) q++
    if (src[q] !== "(") break
    // consume balanced parens, string-aware
    let depth = 0, quote: string | null = null, esc = false
    while (q < end) {
      const c = src[q]
      if (esc) { esc = false; q++; continue }
      if (quote) { if (c === "\\") esc = true; else if (c === quote) quote = null; q++; continue }
      if (c === '"' || c === "'" || c === "`") { quote = c; q++; continue }
      if (c === "(") depth++
      else if (c === ")") { depth--; if (depth === 0) { q++; break } }
      q++
    }
    p = q
  }
  return src.slice(i, p)
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
  // TOMBSTONE (orphan doctrine §1.1) — the private walker that stood here was one of
  // 82 copies of the same readdirSync walker. The survivor is
  // scripts/runtime-roots.ts:61 (`walkTs`), imported above.
//
  // It enumerated DIRECTORIES, and a root-level FILE is not a directory, so
  // `proxy.ts` — the Next 16 edge middleware, which gates auth and queries four
  // tables with a SERVICE client on EVERY request — was outside this guard's corpus.
  // A file that is never opened reports green, which is the failure shape §2 of
  // CLAUDE.md names. `rootRuntimeFiles()` from the same survivor supplies it.
  //
  // `proxy.ts` belongs in a SILENT-WRITE corpus specifically: it is a server
  // surface that talks to Supabase with a service client, which is exactly the
  // shape this guard judges — it simply is not inside any of the three roots.
  const files: string[] = [
    ...roots.flatMap((d) => walkTs(d)),
    ...rootRuntimeFiles("."),
  ].filter((p) => p.endsWith(".ts"))

  const found = new Map<string, number>()   // "file → table" → count
  for (const f of files) {
    const src = stripComments(readFileSync(f, "utf8"))
    for (const stmt of splitStatements(src)) {
      for (const table of silentWritesIn(stmt)) {
        const key = `${f} → ${table}`
        found.set(key, (found.get(key) ?? 0) + 1)
      }
    }
  }
  const total = [...found.values()].reduce((a, b) => a + b, 0)
  console.log(`  · ${files.length} server files scanned · ${CONSEQUENTIAL_TABLES.length} consequential tables`)

  // ── RATCHET, NOT AN INVARIANT — and the reason is the whole point ───────────
  //
  // This assertion read `found.length === 0` and passed, for as long as it has
  // existed, at ZERO. That zero was not a clean tree: `isSilentWrite` matched only
  // the FIRST `.from(` in a chunk, and splitStatements makes a semicolon-free
  // module ONE chunk, so in most files exactly one write was ever judged and every
  // later one was skipped unexamined. Fixing the finder took the count 0 → the
  // baseline below. NONE of these sites is new code and none is in proxy.ts — they
  // are pre-existing writes that this guard has never once looked at.
  //
  // They are FROZEN rather than accepted. The list names every site, growth fails
  // CI, and the number may only go down — the same shape tenant-scope-guard and
  // data-guard-guard use for debt they can see but have not yet burned. Raising it
  // to make a new violation pass is the one thing it must never be used for.
  const baselinePath = join(process.cwd(), "scripts", "silent-write-baseline.json")
  const baseline: Record<string, number> =
    existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : {}

  if (process.env.SILENT_WRITE_BASELINE === "1") {
    const snap: Record<string, number> = {}
    for (const k of [...found.keys()].sort()) snap[k] = found.get(k)!
    writeFileSync(baselinePath, `${JSON.stringify(snap, null, 2)}\n`)
    console.log(`Baseline written: ${found.size} site(s), ${total} silent write(s) frozen (may only shrink)`)
    process.exit(0)
  }

  const grew: string[] = []
  for (const [key, count] of found.entries()) {
    const allowed = baseline[key] ?? 0
    if (count > allowed) grew.push(`${key} — ${count} silent write(s) (baseline ${allowed})`)
  }
  const burned = Object.keys(baseline).filter((k) => (found.get(k) ?? 0) < baseline[k])
  const baselineTotal = Object.values(baseline).reduce((a, b) => a + b, 0)
  console.log(`  · ${total} silent write(s) across ${found.size} site(s) · frozen debt ${baselineTotal}`)
  if (burned.length > 0) {
    console.log(`  ↓ ${burned.length} site(s) improved — re-freeze with SILENT_WRITE_BASELINE=1 npm run test:silent-write`)
  }
  check(`no NEW undeclared silent write on a consequential table (${grew.length} new)`,
    grew.length === 0, grew.slice(0, 8).join(" | "))

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
// The old wording here was "every consequential write checks its error or declares
// it may fail". That was the claim the broken finder licensed, and it was not true:
// 177 writes do neither. The guard's honest promise is that no NEW one appears.
console.log(" ✅ SILENT_WRITE_PASS — no NEW undeclared silent write; the frozen debt may only shrink")
