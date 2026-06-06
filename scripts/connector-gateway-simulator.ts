/**
 * scripts/connector-gateway-simulator.ts
 *
 * Runnable contract test for lib/agentic-os/connector-gateway — the single outbound HTTP path for
 * every external vendor (scrapers, enrichment, AI providers). Validates the documented "never
 * throws" guarantee callers (insertRawRecord, peopledata-client, batchdata-client, zenrows-client,
 * apify-client, exa-client, tavily-client) depend on.
 *
 * Run: `npx tsx scripts/connector-gateway-simulator.ts`
 */
import { callConnector } from "../lib/agentic-os/connector-gateway"

let pass = 0, fail = 0
const checks: Array<[string, () => Promise<any>, (r: any) => boolean]> = [
  ["unreachable host → ok=false (no throw)", async () => callConnector<any>({
      connector: "gw-test-unreachable",
      baseUrl:   "https://this-host-does-not-exist-1234567.invalid",
      path:      "ping",
      method:    "GET",
    }), r => r.ok === false && r.data === null && r.error !== null],
  ["malformed URL → ok=false (no throw)", async () => callConnector<any>({
      connector: "gw-test-bad-url",
      baseUrl:   "ht!tp://not a url",
      path:      "/x",
      method:    "GET",
    }), r => r.ok === false && typeof r.error === "string"],
  ["auth omitted → no throw on auth.style access", async () => callConnector<any>({
      connector: "gw-test-no-auth",
      baseUrl:   "https://this-host-does-not-exist-2345678.invalid",
      path:      "/p",
      method:    "GET",
    }), r => r.ok === false],
  ["explicit auth:'none' still works", async () => callConnector<any>({
      connector: "gw-test-auth-none",
      baseUrl:   "https://this-host-does-not-exist-3456789.invalid",
      path:      "/p",
      method:    "GET",
      auth:      { style: "none" } as any,
    }), r => r.ok === false],
]

for (const [name, fn, check] of checks) {
  try {
    const r = await fn()
    if (check(r)) { console.log(` ✓ ${name}`); pass++ }
    else { console.log(` ✗ ${name} → ${JSON.stringify({ ok: r.ok, status: r.status, err: r.error?.slice?.(0, 120) })}`); fail++ }
  } catch (e: any) { console.log(` ✗ ${name} → THREW: ${e.message}`); fail++ }
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
