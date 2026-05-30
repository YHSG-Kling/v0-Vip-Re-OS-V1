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

// ZenRows business-process correction (user-clarified): BOTH buyer-intent AND seller-intent,
// NEVER mls listings (RentCast owns that).
ok(!!getConnectorSpec("zenrows")?.tags?.includes("buyer-intent"),  "registry: zenrows tagged buyer-intent")
ok(!!getConnectorSpec("zenrows")?.tags?.includes("seller-intent"), "registry: zenrows tagged seller-intent (FSBO/motivated-seller forums)")
ok(!!getConnectorSpec("zenrows")?.tags?.includes("no-mls"),        "registry: zenrows tagged no-mls (RentCast owns MLS)")
ok(getConnectorSpec("zenrows")?.category === "scraper",            "registry: zenrows category=scraper")

// SDK metadata from the vendor audit — drives future "adopt typed SDK?" decisions
ok(getConnectorSpec("apify")?.npmSdk     === "apify-client",         "registry: apify npmSdk recorded (high-ROI adopt)")
ok(getConnectorSpec("elevenlabs")?.npmSdk === "elevenlabs",          "registry: elevenlabs npmSdk recorded (high-ROI when TTS lands)")
ok(!!getConnectorSpec("lob")?.npmSdk?.includes("lob-typescript-sdk"), "registry: lob npmSdk recorded (adopt when direct-mail ships)")
ok(getConnectorSpec("exa")?.npmSdk        === "exa-js",              "registry: exa npmSdk recorded (low-ROI swap, normalizer adds value)")
ok(getConnectorSpec("peopledata")?.npmSdk === "peopledatalabs",      "registry: peopledata npmSdk recorded (evaluate later)")
ok(getConnectorSpec("rentcast")?.npmSdk    === undefined,            "registry: rentcast has NO npmSdk (REST is canonical)")
ok(getConnectorSpec("batchdata")?.npmSdk   === undefined,            "registry: batchdata has NO npmSdk (REST is canonical)")
ok(getConnectorSpec("d_id")?.npmSdk === "@d-id/agents-sdk",          "registry: d_id npmSdk recorded (agents-sdk for live avatar)")

// Provider-supplied richer references (OpenAPI / MCP) — used by the healer + future codegen
ok(!!getConnectorSpec("rentcast")?.openapiSpec?.endsWith("rentcast_api_openapi_spec_v1.json"),
   "registry: rentcast openapiSpec URL recorded")
ok(!!getConnectorSpec("batchdata")?.mcpServer?.githubUrl?.includes("batchdata-mcp-server"),
   "registry: batchdata MCP server recorded")
ok(!!getConnectorSpec("batchdata")?.tags?.includes("has-mcp"),
   "registry: batchdata tagged has-mcp (lib/external/batchdata-mcp adapter wired)")

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
