// Hunt 4 (lane Z1, 2026-09-08): every `.rpc("name")` call site vs `create or replace function
// name` in supabase/migrations/*.sql. Comments stripped before scanning (CLAUDE.md §2).
import { readFileSync } from "node:fs"
import { globSync } from "glob"
import { stripComments } from "./strip-comments"

const ROOT = process.cwd()

function main() {
  const rpcCalls = new Map<string, string[]>()
  const files = globSync("{app,lib}/**/*.{ts,tsx}", {
    cwd: ROOT,
    ignore: ["**/node_modules/**", "**/.claude/**", "**/*.test.ts", "**/*.d.ts"],
  })
  for (const rel of files) {
    const raw = readFileSync(`${ROOT}/${rel}`, "utf8")
    const stripped = stripComments(raw)
    const lines = stripped.split("\n")
    lines.forEach((line, i) => {
      const re = /\.rpc\(\s*["']([a-zA-Z0-9_]+)["']/g
      let m: RegExpExecArray | null
      while ((m = re.exec(line))) {
        const name = m[1]
        if (!rpcCalls.has(name)) rpcCalls.set(name, [])
        rpcCalls.get(name)!.push(`${rel}:${i + 1}`)
      }
    })
  }

  const sqlFiles = globSync("supabase/migrations/*.sql", { cwd: ROOT })
  const defined = new Set<string>()
  for (const rel of sqlFiles) {
    const raw = readFileSync(`${ROOT}/${rel}`, "utf8")
    // SQL comments: strip -- line comments (stripComments handles // and /* */, JS-shaped;
    // SQL uses --, so do that pass separately here rather than misuse the JS stripper).
    const noDashComments = raw.replace(/--[^\n]*/g, "")
    const re = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?([a-zA-Z0-9_]+)"?/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(noDashComments))) defined.add(m[1])
  }

  const missing: string[] = []
  const unused: string[] = []
  for (const [name, sites] of rpcCalls) {
    if (!defined.has(name)) missing.push(`${name}  <-  ${sites.slice(0, 2).join(", ")}`)
  }
  for (const name of defined) {
    if (!rpcCalls.has(name)) unused.push(name)
  }

  console.log(`Total distinct .rpc() call names: ${rpcCalls.size}`)
  console.log(`Total distinct CREATE FUNCTION names across migrations: ${defined.size}`)
  console.log("")
  console.log("── CALLED BUT NO MIGRATION DEFINES IT (reader with no writer) ──")
  missing.forEach(m => console.log(`  ${m}`))
  console.log("")
  console.log(`── DEFINED BUT NEVER CALLED FROM app/lib (${unused.length}, list only — many are trigger/RLS-internal, not app-called) ──`)
  // Only print a sample — full function census is huge (trigger functions, etc.), not the ask here.

  // POSITIVE CONTROL: a function literally named in a comment must not count as "defined";
  // a synthetic .rpc call inside a // comment must not count as "called".
  const synthetic = `
    // create or replace function fake_control_defined_in_comment() returns void as $$ $$;
    await supabase.rpc("fake_control_called_in_code")
  `
  const strippedSynthetic = stripComments(synthetic)
  const commentGone = !strippedSynthetic.includes("fake_control_defined_in_comment")
  const callSurvives = /\.rpc\(\s*["']fake_control_called_in_code["']/.test(strippedSynthetic)
  console.log("")
  console.log(`POSITIVE CONTROL — JS comment stripped before scan: ${commentGone ? "PASS" : "FAIL"}`)
  console.log(`POSITIVE CONTROL — real call site still detected after stripping: ${callSurvives ? "PASS" : "FAIL"}`)

  console.log("")
  console.log("BLIND SPOTS: dynamic rpc names (`.rpc(variableName)`) are invisible to this scan.")
  console.log("SQL functions defined outside supabase/migrations/*.sql (e.g. applied by hand via the")
  console.log("Supabase dashboard, or functions created by an extension) will false-positive as missing.")
  console.log("'DEFINED BUT NEVER CALLED' includes trigger functions and RLS-internal helpers that are")
  console.log("never meant to be called via .rpc() from app code — that list is not itself a finding.")
}

main()
