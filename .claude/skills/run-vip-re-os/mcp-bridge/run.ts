/**
 * Runner for the MCP replay bridge (see bridge.ts header).
 *
 *   node --import tsx --import ./.claude/skills/run-vip-re-os/mcp-bridge/register.mjs \
 *        .claude/skills/run-vip-re-os/mcp-bridge/run.ts <scenario.ts> [--ingest <answer.json>]
 *
 * Exit 3 = the scenario needs the live DB: batch.sql (in BRIDGE_DIR) is printed;
 * run it with the Supabase MCP execute_sql, save the JSON answer, re-run with
 * --ingest. Exit 0 = the scenario completed; its step table is printed.
 */
import path from "node:path"
import fs from "node:fs"
import { pathToFileURL } from "node:url"
import { start, finish, isStopped, BridgeStop, ingest, externalCalls, emulations, stats } from "./bridge"

export interface StepRow { step: string; capability: string; via: string; verdict: "works" | "refused" | "error" | "not reachable" | "emulated"; detail: string }
export interface WalkCtx { row: (r: StepRow) => void; ids: Record<string, string>; log: (...a: unknown[]) => void }

async function main() {
  const args = process.argv.slice(2)
  const scenario = args[0]
  const dir0 = process.env.BRIDGE_DIR || path.join(process.cwd(), ".bridge")
  fs.mkdirSync(dir0, { recursive: true })
  // App console noise goes to a file, not the agent's context; the runner writes to stdout directly.
  const appLog = fs.createWriteStream(path.join(dir0, "app-console.log"), { flags: "w" })
  for (const k of ["log", "info", "warn", "error", "debug"] as const) (console as any)[k] = (...a: unknown[]) => appLog.write(`[${k}] ${a.map((x) => typeof x === "string" ? x : (() => { try { return JSON.stringify(x) } catch { return String(x) } })()).join(" ")}\n`)
  const out = (s: string) => process.stdout.write(s + "\n")
  const ing = args.indexOf("--ingest")
  if (ing >= 0) ingest(args[ing + 1])
  start()
  const rows: StepRow[] = []
  const ids: Record<string, string> = {}
  const logs: string[] = []
  const ctx: WalkCtx = { row: (r) => rows.push(r), ids, log: (...a) => logs.push(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")) }
  const mod = await import(pathToFileURL(path.resolve(scenario)).href)
  let crash: unknown = null
  try { await mod.journey(ctx) } catch (e) { if (!(e instanceof BridgeStop)) crash = e }
  const dir = process.env.BRIDGE_DIR || path.join(process.cwd(), ".bridge")
  if (isStopped() || !finish()) {
    const s = stats()
    out(`NEED_SQL calls=${s.calls} cached=${s.cached} rows_so_far=${rows.length}`)
    for (const r of rows.slice(process.env.W91_ALLROWS ? 0 : -1)) out(`  row ${r.step} ${r.verdict}: ${r.detail.slice(0, 200)}`)
    if (crash) out("CRASH " + String((crash as Error).stack ?? crash).slice(0, 1500))
    out(fs.readFileSync(path.join(dir, "batch-current.sql"), "utf8"))
    process.exit(3)
  }
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({ rows, ids, logs, externalCalls, emulations, crash: crash ? String((crash as Error).stack ?? crash) : null }, null, 1))
  out(`DONE calls=${stats().calls}`)
  for (const r of rows) out(`| ${r.step} | ${r.capability} | ${r.via} | ${r.verdict} | ${r.detail.replace(/\|/g, "/").slice(0, 400)} |`)
  if (crash) out("CRASH " + String((crash as Error).stack ?? crash).slice(0, 2000))
  out("external calls refused: " + externalCalls.length + " " + [...new Set(externalCalls.map((u) => { try { return new URL(u).host } catch { return u } }))].join(", "))
  await new Promise((r) => appLog.end(r))
  process.exit(0)
}
main()
