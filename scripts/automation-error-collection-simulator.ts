#!/usr/bin/env tsx
/**
 * scripts/automation-error-collection-simulator.ts   (npm run test:automation-errors) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * AN ERROR THAT IS NOT WRITTEN IS NOT AN ERROR, IT IS SILENCE.
 *
 * automation_errors.status carries a live CHECK:
 *
 *   CHECK (status = ANY (ARRAY['open','investigating','resolved','dismissed']))
 *   DEFAULT 'open'
 *
 * Four AI-ISA call sites hand-rolled their own insert with `status: 'new'`:
 *
 *   app/actions/ai-isa/engage-contact.ts
 *   app/actions/ai-isa/initiate-engagement.ts
 *   app/actions/ai-isa/initiate-contact-engagement.ts
 *   lib/ai-isa/email-generator.ts
 *
 * Verified against the live database: an insert with status='new' raises
 * check_violation. supabase-js resolves that as `{ error }` rather than throwing,
 * and all four discarded the result — so every AI-ISA engagement failure was
 * console.error'd and then written NOWHERE. The table that exists to be the
 * record of automation failure had no record of the loudest ones.
 *
 * They set no brokerage_id either, and every console that reads this table filters
 * on it. Verified live: a row anchored to a brokerage is visible to the console
 * query; an unanchored one is not. Fixing the status alone would have moved the
 * failure from "rejected" to "written and invisible".
 *
 * The console read had the mirror defect — `in(status, ['open','failed'])`.
 * 'failed' is not in the vocabulary, and asking for it instead of 'investigating'
 * meant an error someone had actually picked up dropped off the list. Verified
 * live: an 'investigating' row scores 0 on the old filter, 1 on the new one.
 *
 * lib/errors/collect-error.ts was already the canonical writer and already got
 * all of this right — status, tenant anchor, stack trace, resolution-log entry,
 * critical-severity kernel alert. It just took an RLS-scoped client, which a
 * cron or engine running without a session cannot use. It now accepts an injected
 * client, and the four sites go through it.
 *
 * THE BASELINE. 20 other files still insert into the table directly. They are not all wrong —
 * most omit status entirely and inherit the 'open' default — but each is a place
 * the vocabulary can drift again. The baseline freezes that population: a NEW
 * direct insert fails this guard, and routing an old one through collectError
 * shrinks the list. Run UPDATE_AUTOMATION_ERROR_BASELINE=1 after deliberately
 * changing it.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join, relative, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { stripComments } from "./strip-comments"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const BASELINE_PATH = join(root, "scripts", "automation-error-baseline.json")

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, d?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n + (d ? ` — ${d}` : "")); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) }
}
const strip = (s: string) => stripComments(s)
const src = (p: string) => strip(readFileSync(join(root, p), "utf8"))

/** PURE — files under app/ and lib/ that insert into automation_errors directly. */
export function directInsertFiles(
  files: Array<{ path: string; text: string }>,
  collectorPath: string,
): string[] {
  const out: string[] = []
  for (const { path, text } of files) {
    if (path === collectorPath) continue
    // Cut each window at the next .from( so a later table's .insert cannot be
    // mistaken for this one's.
    for (const m of text.matchAll(/\.from\((['"])automation_errors\1\)/g)) {
      const rest = text.slice(m.index! + m[0].length)
      const next = rest.search(/\.from\(/)
      const win = next === -1 ? rest : rest.slice(0, next)
      if (/\.(insert|upsert)\s*\(/.test(win)) { out.push(path); break }
    }
  }
  return out.sort()
}

console.log("\n[pure — the direct-insert scan]")
{
  const files = [
    { path: "a.ts", text: `supabase.from("automation_errors").insert({ x: 1 })` },
    { path: "b.ts", text: `supabase.from("automation_errors").select("id").eq("status","open")` },
    // A read on automation_errors followed by an insert on a DIFFERENT table.
    { path: "c.ts", text: `db.from('automation_errors').select('id')\ndb.from('other').insert({})` },
    { path: "collector.ts", text: `supabase.from("automation_errors").insert({})` },
  ]
  const found = directInsertFiles(files, "collector.ts")
  check("flags a direct insert", found.includes("a.ts"))
  check("ignores a pure read", !found.includes("b.ts"))
  check("does not carry the window past the next .from(", !found.includes("c.ts"))
  check("never flags the collector itself", !found.includes("collector.ts"))
}

console.log("\n[the vocabulary, as the schema snapshot records it]")
{
  const live = CHECK_VOCABULARIES.automation_errors?.status ?? []
  check(`status has 4 admitted values (${live.join(", ")})`, live.length === 4)
  check("'open' is the default the collector writes", live.includes("open"))
  check("'investigating' is real — the console must not filter it out", live.includes("investigating"))
  check("'new' is NOT admitted (this is what the four sites wrote)", !live.includes("new"))
  check("'failed' is NOT admitted (this is what the console asked for)", !live.includes("failed"))
}

console.log("\n[the collector writes the vocabulary, and takes an injected client]")
{
  const c = src("lib/errors/collect-error.ts")
  check("writes status: 'open'", /status:\s*"open"/.test(c))
  check("anchors the row to a brokerage", /brokerage_id:\s*brokerageId \|\| null/.test(c))
  check("accepts an injected client for service-context callers", /client\?:/.test(c))
  // m483: the default moved from the RLS-scoped server client to the SERVICE
  // client. Error intake is a post-authorization AUDIT write — every caller has
  // already passed its own gate (route auth / action gate / cron secret), and
  // the staff-seat-tightened INSERT policies on automation_errors /
  // error_stack_traces / error_resolution_log would silently drop a consumer
  // seat's report through an RLS-scoped default.
  check("defaults to the SERVICE client when none is passed (post-authz audit intake)",
    /params\.client \?\? createServiceClient\(\)/.test(c))
  check("still records the stack trace", c.includes("error_stack_traces"))
  check("still opens a resolution-log entry", c.includes("error_resolution_log"))
  check("still raises a kernel alert on critical", c.includes("SYSTEM_HEALTH_ALERT"))
}

console.log("\n[the four AI-ISA sites route through the collector]")
{
  const sites = [
    "app/actions/ai-isa/engage-contact.ts",
    "app/actions/ai-isa/initiate-engagement.ts",
    "app/actions/ai-isa/initiate-contact-engagement.ts",
    "lib/ai-isa/email-generator.ts",
  ]
  for (const p of sites) {
    const s = src(p)
    check(`${p} calls collectError`, /collectError\(\{/.test(s))
    check(`${p} no longer writes status: 'new'`, !/status:\s*'new'/.test(s))
    check(`${p} passes its service client through`, /client: supabase/.test(s))
    check(`${p} anchors the error to a brokerage`, /brokerageId[,:]/.test(s))
  }
  // The two wrappers resolve the tenant inside the try; the catch needs it too.
  for (const p of ["app/actions/ai-isa/initiate-engagement.ts",
                   "app/actions/ai-isa/initiate-contact-engagement.ts"]) {
    const s = src(p)
    check(`${p} hoists brokerageId so the catch can anchor`,
      /let brokerageId: string \| null = null/.test(s) && /brokerageId = \(/.test(s))
  }
}

console.log("\n[the console reads the vocabulary it can actually get]")
{
  const page = src("app/dashboard/admin/automations/page.tsx")
  check("the automations console filters open + investigating",
    /\.in\("status", \["open", "investigating"\]\)/.test(page))
  check("it no longer asks for the impossible 'failed'", !/"failed"/.test(page))
}

console.log("\n[repo — the hand-rolled insert population is frozen]")
{
  const files: Array<{ path: string; text: string }> = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e === ".next" || e === ".git") continue
      const full = join(dir, e)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (!/\.(ts|tsx)$/.test(e)) continue
      const text = readFileSync(full, "utf8")
      if (!text.includes("automation_errors")) continue
      files.push({ path: relative(root, full).replace(/\\/g, "/"), text: strip(text) })
    }
  }
  walk(join(root, "app"))
  walk(join(root, "lib"))

  const found = directInsertFiles(files, "lib/errors/collect-error.ts")
  console.log(`  · ${files.length} files mention the table · ${found.length} insert into it directly`)

  const baseline: string[] = existsSync(BASELINE_PATH)
    ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
    : []

  if (process.env.UPDATE_AUTOMATION_ERROR_BASELINE === "1") {
    writeFileSync(BASELINE_PATH, JSON.stringify(found, null, 2) + "\n")
    console.log(`  · baseline rewritten with ${found.length} entries`)
    process.exit(0)
  }

  const known = new Set(baseline)
  const fresh = found.filter((f) => !known.has(f))
  const routed = baseline.filter((b) => !found.includes(b))
  check(`no NEW hand-rolled automation_errors insert (${baseline.length} baselined)`,
    fresh.length === 0, fresh.slice(0, 6).join(", "))
  check(`the four AI-ISA sites are off the list (${routed.length} routed since the baseline)`,
    !found.includes("app/actions/ai-isa/engage-contact.ts") &&
    !found.includes("app/actions/ai-isa/initiate-engagement.ts") &&
    !found.includes("app/actions/ai-isa/initiate-contact-engagement.ts") &&
    !found.includes("lib/ai-isa/email-generator.ts"))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ AUTOMATION_ERROR_COLLECTION_FAIL"); process.exit(1) }
console.log(" ✅ AUTOMATION_ERROR_COLLECTION_PASS — the AI-ISA failures reach the table, anchored and visible")
