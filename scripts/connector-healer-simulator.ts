/**
 * scripts/connector-healer-simulator.ts
 *
 * Pure simulator for the connector healer that does NOT cross the server-only boundary
 * (the healer + Supabase service client are server-only). Covers:
 *   - connector-registry assertions (pure)
 *   - the explicit "ZenRows is buyer-intent only, NOT MLS" tagging the user clarified
 *
 * The DB-bound healer behavior (writes connector_healing_proposals rows) is verified via Supabase
 * MCP in the matching e2e check, not here.
 */
import { getConnectorSpec, listConnectorsByCategory, CONNECTOR_REGISTRY } from "../lib/agentic-os/connector-registry"

let pass = 0, fail = 0
const ok = (cond: boolean, msg: string) => { if (cond) pass++; else { fail++; console.log(` ✗ ${msg}`) } }

// Registry — vendor docs/github lookups
ok(!!getConnectorSpec("peopledata")?.docsUrl?.startsWith("https://"), "registry: peopledata has docsUrl")
ok(!!getConnectorSpec("peopledata")?.githubUrl?.includes("peopledatalabs"), "registry: peopledata has github")
ok(!!getConnectorSpec("rentcast")?.githubUrl?.includes("RentCast"),  "registry: rentcast has github")
ok(getConnectorSpec("rentcast")?.category === "mls",                 "registry: rentcast is the MLS connector")
ok(!!getConnectorSpec("batchdata")?.githubUrl?.includes("batchdataco"), "registry: batchdata has github")
ok(!!getConnectorSpec("exa")?.githubUrl?.includes("exa-labs"),       "registry: exa has github")
ok(!!getConnectorSpec("apify")?.githubUrl?.includes("apify"),        "registry: apify has github")
ok(!!getConnectorSpec("lob")?.githubUrl?.includes("lob"),            "registry: lob has github")
ok(!!getConnectorSpec("d_id")?.githubUrl?.includes("de-id"),         "registry: d-id has github")
ok(!!getConnectorSpec("elevenlabs")?.githubUrl?.includes("elevenlabs"), "registry: elevenlabs has github")

// ZenRows business-process correction (user-clarified)
ok(!!getConnectorSpec("zenrows")?.tags?.includes("buyer-intent"), "registry: zenrows tagged buyer-intent")
ok(!!getConnectorSpec("zenrows")?.tags?.includes("no-mls"),       "registry: zenrows tagged no-mls (RentCast owns MLS)")
ok(getConnectorSpec("zenrows")?.category === "scraper",           "registry: zenrows category=scraper")

// Category lookups (drive healer doc-search priorities)
ok(listConnectorsByCategory("ai").length >= 3,                   "registry: ≥3 ai connectors (anthropic, google_ai, exa, …)")
ok(listConnectorsByCategory("mls").length >= 1,                  "registry: ≥1 mls connector")
ok(listConnectorsByCategory("letters").some(c => c.connector === "lob"), "registry: lob is the letters connector")
ok(listConnectorsByCategory("enrichment").some(c => c.connector === "peopledata"), "registry: peopledata is enrichment")

// Unknown lookup returns null (not throw)
ok(getConnectorSpec("nonsense_made_up") === null,                "registry: unknown returns null")

// Every spec has the four required fields
for (const [name, spec] of Object.entries(CONNECTOR_REGISTRY)) {
  ok(!!spec.connector && spec.connector === name,                `registry: ${name} connector field matches key`)
  ok(!!spec.baseUrl?.startsWith("https://"),                     `registry: ${name} has https baseUrl`)
  ok(!!spec.docsUrl?.startsWith("https://"),                     `registry: ${name} has https docsUrl`)
  ok(!!spec.envKey || spec.auth === "none",                      `registry: ${name} has envKey or none auth`)
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
