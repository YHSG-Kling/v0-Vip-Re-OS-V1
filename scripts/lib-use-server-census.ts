#!/usr/bin/env tsx
/**
 * scripts/lib-use-server-census.ts  (npm run test:lib-use-server-census) — pure, no DB.
 *
 * A lib/ MODULE WITH A TOP-LEVEL "use server" AND NO SESSION TOUCH IS A ROW OF
 * UNGATED PUBLIC HTTP DOORS.
 *
 * CLAUDE.md §4: in a `"use server"` file EVERY export is a public HTTP endpoint.
 * Next.js compiles each one into an RPC any browser session can call with any
 * arguments. The intended home for that directive is app/actions/**, where each
 * action reads the session first. In lib/ the directive is almost always a
 * leftover: a helper that takes `brokerageId` as a PARAMETER and runs it on the
 * service client — §4's named IDOR shape — published to the network for no
 * caller that needed it, because every real caller was in-process server code.
 *
 * Measured 2026-09-03 (lane R3-A, wave 26 carried item 1): of the lib/ files
 * carrying the directive, 24 touched no session token at all. 20 were swapped
 * for `import "server-only"` in that lane (template:
 * lib/behavior-learning/preference-updater.ts:1-9); the four below remain by
 * ruling, each named with its owner. This guard is the RATCHET that keeps the
 * number from growing back: a NEW lib/ file that carries the directive without a
 * session touch fails the chain, and a name on the allowlist that has since been
 * closed fails it too, so the list cannot carry retired names reading as
 * enforced (§2).
 *
 * WHAT COUNTS AS A SESSION TOUCH. One of the spellings this repo uses to reach
 * the caller's identity: `auth.getUser`, `createClient()` from
 * `@/lib/supabase/server`, `requireCaller`, `requireActor`, `getSession`,
 * `cookies()`, `headers()`, `createServerClient`, `getCurrentUser`,
 * `requireUser`, `getAuthenticatedUser`, `resolveActor`, `requireAdmin`,
 * `requirePlatform*` — plus `getAgentContext`, this repo's canonical resolver
 * (lib/identity/get-agent-context.ts reads `auth.getUser()` through the cookie
 * client), which the original 24-file census did not list and therefore counted
 * two gated doors (lib/lead-promotion/eligibility-evaluator.ts and
 * lib/repurpose/transcribe.ts) as ungated. Both are swapped now, so the number
 * does not move on that account; the token is listed so the next such door is
 * classified correctly.
 *
 * HOW IT READS THE SOURCE (§2). The directive is found on COMMENT-STRIPPED
 * source, by the rule Next applies (the first non-empty statement), through
 * scripts/strip-comments.ts — a tombstone that says "this file was `"use
 * server"`" is prose, not a directive, and the orphan doctrine REQUIRES such
 * tombstones, so a scanner that read raw text would go red on exactly the files
 * that were fixed. Identifier tokens are matched on blankStrings() output, so a
 * log message that happens to say "requireUser refused" is not a gate; the
 * `@/lib/supabase/server` specifier is matched on stripComments() output, since
 * an import path IS a string. Every one of those choices has a positive control
 * below that fails if it is undone.
 *
 * STATED BLIND SPOTS (§2 — published beside the number):
 *   · The token list is a SPELLING list. A gate spelled another way reads as
 *     absent, so this guard OVER-reports — the safe direction: a false "new
 *     door" is a review, never a silent pass. Add the spelling when it happens.
 *   · A token anywhere in the file counts for every export in it. Per-export
 *     gating (one export reads the session, its sibling does not) is not
 *     measured here; that is scripts/use-server-export-guard.ts territory and
 *     the tenant-scope guards'.
 *   · Only lib/ is walked. app/actions/** is where the directive belongs and is
 *     judged by the action-level guards; app/api routes carry no directive.
 */
import { existsSync, readFileSync } from "node:fs"
import { walkTs } from "./runtime-roots"
import { stripComments, blankStrings } from "./strip-comments"

// ─── The allowlist: files that still carry an ungated directive, BY RULING ───
//
// Every entry names who closes it and how. When it is closed, this guard fails
// until the line is deleted — deliberately (§2: a hardcoded name that no longer
// applies must not sit in a list reading as enforced).
//
// HISTORY: the list held four entries when this guard landed (2026-09-03):
// multi-agent-router.ts and qualification-evaluator.ts (client components
// imported them — closed by moving the browser-facing calls behind gated
// actions, app/actions/coordination.ts and app/actions/ai-isa/evaluate-lead-
// qualification.ts, and making the modules server-only) and fatigue-calculator.ts
// / stale-lead-processor.ts (swapped to server-only once lane H2's edits to
// the same files landed). All four closed the same day; the list is empty and
// any NEW ungated lib module fails the guard.
const KNOWN_UNGATED: ReadonlyArray<{ file: string; why: string }> = []

// ─── Session tokens ───────────────────────────────────────────────────────────
interface Token { name: string; re: RegExp; on: "identifiers" | "specifiers" }
const SESSION_TOKENS: ReadonlyArray<Token> = [
  { name: "auth.getUser",                            re: /\bauth\.getUser\b/,                              on: "identifiers" },
  { name: 'createClient() from "@/lib/supabase/server"', re: /from\s*["']@\/lib\/supabase\/server["']/,      on: "specifiers" },
  { name: "requireCaller",                           re: /\brequireCaller\b/,                              on: "identifiers" },
  { name: "requireActor",                            re: /\brequireActor\b/,                               on: "identifiers" },
  { name: "getSession",                              re: /\bgetSession\b/,                                 on: "identifiers" },
  { name: "cookies()",                               re: /\bcookies\(\)/,                                  on: "identifiers" },
  { name: "headers()",                               re: /\bheaders\(\)/,                                  on: "identifiers" },
  { name: "createServerClient",                      re: /\bcreateServerClient\b/,                         on: "identifiers" },
  { name: "getCurrentUser",                          re: /\bgetCurrentUser\b/,                             on: "identifiers" },
  { name: "requireUser",                             re: /\brequireUser\b/,                                on: "identifiers" },
  { name: "getAuthenticatedUser",                    re: /\bgetAuthenticatedUser\b/,                       on: "identifiers" },
  { name: "resolveActor",                            re: /\bresolveActor\b/,                               on: "identifiers" },
  { name: "requireAdmin",                            re: /\brequireAdmin\b/,                               on: "identifiers" },
  { name: "requirePlatform*",                        re: /\brequirePlatform\w*\b/,                         on: "identifiers" },
  { name: "getAgentContext",                         re: /\bgetAgentContext\b/,                            on: "identifiers" },
]

// ─── Classification ───────────────────────────────────────────────────────────
interface Verdict { directive: boolean; tokens: string[] }

/**
 * Top-level directive by the rule Next applies: the first non-empty line of the
 * COMMENT-STRIPPED source, either quote style, optional semicolon. Same rule as
 * scripts/use-server-export-guard.ts:hasUseServerDirective — restated rather than
 * imported because that module runs its guard at import time.
 */
function hasUseServerDirective(stripped: string): boolean {
  const first = stripped.split("\n").find((l) => l.trim().length > 0) ?? ""
  return /^\s*["']use server["']\s*;?\s*$/.test(first)
}

export function classify(src: string): Verdict {
  const stripped = stripComments(src)
  const directive = hasUseServerDirective(stripped)
  if (!directive) return { directive, tokens: [] }
  const identifiers = blankStrings(src)
  const tokens = SESSION_TOKENS
    .filter((t) => t.re.test(t.on === "identifiers" ? identifiers : stripped))
    .map((t) => t.name)
  return { directive, tokens }
}

const isUngatedDoor = (v: Verdict) => v.directive && v.tokens.length === 0

// ─── Reporting ────────────────────────────────────────────────────────────────
let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(p, "utf8")

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n═══ 1. POSITIVE CONTROLS — the finder still recognises the defect it was written for ═══")
{
  const SERVICE = 'import { createServiceClient } from "@/lib/supabase/service"\n'
  const BODY = 'export async function door(brokerageId: string) {\n  return createServiceClient().from("leads").select("id").eq("brokerage_id", brokerageId)\n}\n'

  const open = `"use server"\n\n${SERVICE}\n${BODY}`
  ok("a directive with a service client and no session token IS reported", isUngatedDoor(classify(open)))

  const tombstoned = `// TOMBSTONE (2026-09-03): this file was "use server" until every caller was\n// shown to be in-process; see lib/behavior-learning/preference-updater.ts.\nimport "server-only"\n\n${SERVICE}\n${BODY}`
  ok("the SAME body with the directive only in a tombstone comment + `import \"server-only\"` is NOT reported", !classify(tombstoned).directive)

  const gated = `"use server"\n\nimport { createClient } from "@/lib/supabase/server"\n\nexport async function door() {\n  const { data: { user } } = await createClient().auth.getUser()\n  return user\n}\n`
  const gv = classify(gated)
  ok("a directive that reads the session (createClient from @/lib/supabase/server + auth.getUser) is NOT reported",
    gv.directive && !isUngatedDoor(gv), `tokens: ${gv.tokens.join(", ")}`)
  ok("…and both spellings are named, so the specifier match and the identifier match each work",
    gv.tokens.includes("auth.getUser") && gv.tokens.includes('createClient() from "@/lib/supabase/server"'))

  const tokenInComment = `"use server"\n// callers already ran requireUser() before reaching this helper\n${SERVICE}export async function door() {}\n`
  ok("a session token that appears ONLY in a comment does not count as a gate (comments are stripped first)", isUngatedDoor(classify(tokenInComment)))

  const tokenInString = `"use server"\n${SERVICE}export async function door() { throw new Error("requireUser refused this call") }\n`
  ok("a session token that appears ONLY inside a string literal does not count as a gate (blankStrings)", isUngatedDoor(classify(tokenInString)))

  const underDocBlock = `/**\n * A doc block that runs past line three.\n * line 3\n * line 4\n */\n"use server"\n${SERVICE}export async function door() {}\n`
  ok("a directive under a leading doc block is still a directive (Next reads the first STATEMENT)", isUngatedDoor(classify(underDocBlock)))

  const afterImport = `import x from "y"\n"use server"\nexport async function door() {}\n`
  ok("a \"use server\" string AFTER an import is not a directive (Next ignores it there)", !classify(afterImport).directive)

  const gatedByAgentContext = `"use server"\nimport { getAgentContext } from "@/lib/identity"\n${SERVICE}export async function door() { const { brokerageId } = await getAgentContext(); return brokerageId }\n`
  ok("getAgentContext — this repo's canonical session resolver — counts as a session touch", !isUngatedDoor(classify(gatedByAgentContext)))
}

console.log("\n═══ 2. LIVE CONTROLS — the classifier agrees with two files whose shape is settled ═══")
{
  const template = "lib/behavior-learning/preference-updater.ts"
  const tv = existsSync(template) ? classify(read(template)) : null
  ok(`${template} (the server-only template) carries NO directive — its header mentions "use server" only in prose`,
    tv !== null && !tv.directive)
  const resolver = "lib/identity/get-agent-context.ts"
  const rv = existsSync(resolver) ? classify(read(resolver)) : null
  ok(`${resolver} (the canonical resolver) carries the directive AND a session touch, so it is not a door`,
    rv !== null && rv.directive && rv.tokens.length > 0, rv ? `tokens: ${rv.tokens.join(", ")}` : "file missing")
}

console.log("\n═══ 3. THE CENSUS — lib/**/*.ts with a top-level \"use server\" and no session touch ═══")
{
  const files = walkTs("lib").filter((f) => /\.tsx?$/.test(f)).sort()
  let withDirective = 0
  const doors: string[] = []
  const gated: Array<{ file: string; tokens: string[] }> = []
  for (const f of files) {
    const v = classify(read(f))
    if (!v.directive) continue
    withDirective++
    if (v.tokens.length === 0) doors.push(f)
    else gated.push({ file: f, tokens: v.tokens })
  }

  console.log(`\n  DENOMINATOR: ${files.length} lib/**/*.ts(x) files walked · ${withDirective} carry a top-level "use server" · ${gated.length} of those touch a session token · ${doors.length} touch none`)
  console.log(`  (a file counts as "touching a session" on ANY of ${SESSION_TOKENS.length} spellings; per-export gating is not measured here — see the header's blind spots)`)

  if (doors.length) {
    console.log("\n  Ungated directive files:")
    for (const d of doors) {
      const known = KNOWN_UNGATED.find((k) => k.file === d)
      console.log(`    ${known ? "·" : "✗"} ${d}${known ? `\n        allowed by ruling: ${known.why}` : "\n        NEW — not on the allowlist"}`)
    }
  }

  ok("the directive finder sees SOMETHING in lib/ (zero would mean the finder is blind, not that the tree is clean)", withDirective > 0, `${withDirective} directive files`)

  const newDoors = doors.filter((d) => !KNOWN_UNGATED.some((k) => k.file === d))
  ok(`ZERO lib/ files carry a top-level "use server" with no session touch beyond the ${KNOWN_UNGATED.length} named by ruling (found ${newDoors.length} new)`,
    newDoors.length === 0,
    newDoors.length ? `NEW: ${newDoors.join(", ")} — either gate it (tenant from the SESSION, then the service client) or, when every caller is in-process, swap the directive for \`import "server-only"\` per lib/behavior-learning/preference-updater.ts:1-9` : undefined)

  const missing = KNOWN_UNGATED.filter((k) => !existsSync(k.file))
  ok("every allowlisted file still exists (a deleted file must leave the list)", missing.length === 0, missing.map((m) => m.file).join(", "))

  const stale = KNOWN_UNGATED.filter((k) => existsSync(k.file) && !doors.includes(k.file))
  ok("every allowlisted file is STILL an ungated door (a closed door must leave the list — the ratchet only tightens)",
    stale.length === 0,
    stale.length ? `closed since listing — delete from KNOWN_UNGATED in scripts/lib-use-server-census.ts: ${stale.map((s) => s.file).join(", ")}` : undefined)
}

console.log(`\n${"═".repeat(70)}`)
console.log(`LIB "use server" CENSUS — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  console.log("\nA lib/ module with a top-level \"use server\" and no session touch publishes every")
  console.log("export as an ungated HTTP door (CLAUDE.md §4). Gate it, or close it with `import \"server-only\"`.")
  process.exit(1)
}
console.log("No new ungated \"use server\" module in lib/; the allowlist is current.")
