/**
 * scripts/batchdata-mcp-simulator.ts
 *
 * Exercises the lib/external/batchdata-mcp adapter's contract WITHOUT spending real API budget:
 *   - unconfigured (BATCHDATA_MCP_URL unset) → returns { unconfigured: true }
 *   - prefer-MCP helper: unconfigured → falls back to the REST thunk and labels via:"rest"
 *   - prefer-MCP helper: when REST throws, error surfaces (no uncaught throw)
 *
 * Pure / no external I/O — the gateway path bails on missing MCP URL before any HTTP attempt.
 */
import { callBatchDataMcp, batchDataPreferMcp } from "../lib/external/batchdata-mcp"

let pass = 0, fail = 0
const ok = (cond: boolean, msg: string) => { if (cond) pass++; else { fail++; console.log(` ✗ ${msg}`) } }

// Ensure env is empty for this run regardless of caller shell.
delete process.env.BATCHDATA_MCP_URL
delete process.env.BATCHDATA_MCP_AUTH

const r1 = await callBatchDataMcp<{ matches: number }>("property.search", { state: "TX" })
ok(r1.ok === false,                  "MCP: returns ok=false when unconfigured")
ok(r1.unconfigured === true,          "MCP: unconfigured flag set so caller can fall back")
ok(typeof r1.error === "string",      "MCP: human-readable error message present")

const r2 = await batchDataPreferMcp<{ count: number }>(
  "property.search", { state: "TX" },
  async () => ({ count: 42 }),  // REST fallback thunk
)
ok(r2.via === "rest" && r2.data?.count === 42, "prefer-MCP: falls back to REST thunk when MCP unconfigured")
ok(r2.error === null,                          "prefer-MCP: REST success surfaces error=null")

const r3 = await batchDataPreferMcp<{ count: number }>(
  "property.search", { state: "TX" },
  async () => { throw new Error("REST blew up") },
)
ok(r3.via === "rest" && r3.data === null && (r3.error ?? "").includes("REST"),
   "prefer-MCP: REST throwing surfaces structured error (no uncaught throw)")

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
