#!/usr/bin/env tsx
/**
 * scripts/location-literal-census-guard.ts   (npm run test:location-literal-census) — no network, no DB.
 *
 * WAVE 108 (lane 108H) — NO HARD-CODED LOCATION. Owner ruling 4: "lib/kernel/twin-scenario.ts (and anywhere
 * else) must NOT hard-code a territory or location — territories are anywhere in the US." Ruling 1 adds the
 * network benchmarks' market band ("derived, never a literal like gulf_coast unless derived from data").
 *
 * WHAT IT ASSERTS (the RULE, never a waypoint):
 *   A  the census modules (the twin, the scenario engine, the network benchmarks, media intelligence, the
 *      strategy library / engine / learning) carry ZERO location literals in COMMENT-STRIPPED source —
 *      strings and identifiers are scanned (a literal IS a string), comments are not (a tombstone or the
 *      owner's own quote naming a place is not code).
 *   B  NEGATIVE CONTROLS — the detector FAILS a copy of each module with a planted literal of every class
 *      (region token, state name, quoted state code, city, quoted compass territory) — so a clean zero is
 *      the code's, not a blind regex's. Planted in memory only: no source file is mutated.
 *   C  POSITIVE CONTROL — a tombstone comment naming a place is NOT flagged (stripComments runs first).
 *   D  the market band is derived from tenant data (marketBandForState over brokerages.state).
 *   E  registration + ownership.
 *
 * Owner: data_steward. Co-owners named in prose: listing_concierge (farm territories — the only territory
 * model) and ads_manager (paid targeting reads territory zips from tenant data, never a literal place).
 *
 * BLIND SPOTS (published): the city list is finite (the 60 largest US metros + the places this repo's fixtures
 * have used); a place spelled in an identifier the list does not hold is invisible; the repo-wide sweep in F
 * is REPORT-ONLY (printed, not asserted) — only the census modules are held to zero.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { marketBandForState } from "../lib/intelligence/network-benchmarks"
import { MAINTENANCE_DOMAINS, MANAGERS } from "../lib/kernel/manager-registry"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const CENSUS_MODULES = [
  "lib/kernel/brokerage-twin.ts",
  "lib/kernel/twin-scenario.ts",
  "lib/intelligence/network-benchmarks.ts",
  "lib/intelligence/strategy-learning.ts",
  "lib/kernel/media-intelligence.ts",
  "lib/kernel/strategy-library.ts",
  "lib/kernel/strategy-engine.ts",
  // wave 138C: the law-rule registry + healing loop derive jurisdictions from tenant data (never a listed state).
  "lib/compliance-rules/law-rule-registry.ts",
  "lib/kernel/law-rule-healing.ts",
] as const

const STATES = ["Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming"]
const CODES = ["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC"]
const CITIES = ["New York City", "Los Angeles", "Chicago", "Houston", "Phoenix", "Philadelphia", "San Antonio", "San Diego", "Dallas", "Austin", "Jacksonville", "Fort Worth", "Columbus", "Charlotte", "Indianapolis", "San Francisco", "Seattle", "Denver", "Nashville", "Oklahoma City", "El Paso", "Boston", "Portland", "Las Vegas", "Detroit", "Memphis", "Louisville", "Baltimore", "Milwaukee", "Albuquerque", "Tucson", "Fresno", "Sacramento", "Kansas City", "Atlanta", "Miami", "Tampa", "Orlando", "Raleigh", "Minneapolis", "Cleveland", "New Orleans", "Pittsburgh", "Cincinnati", "St. Louis", "Salt Lake City", "Birmingham", "Baton Rouge", "Pensacola", "Gulf Breeze", "Navarre", "Destin", "Fort Walton Beach", "Panama City", "Daphne", "Fairhope", "Orange Beach", "Gulf Shores", "Tallahassee", "Mobile Bay"]
const REGION = /\b(gulf[\s_-]?coast|south[\s_-]?east(ern)?|north[\s_-]?east(ern)?|mid[\s_-]?west(ern)?|pacific[\s_-]?northwest|new[\s_-]england|sun[\s_-]?belt|south[\s_-]?central|mountain[\s_-]west|tri[\s_-]state)\b/i
const STATE_NAME = new RegExp(`\\b(${STATES.map((s) => s.replace(/ /g, "\\s")).join("|")})\\b`)
const STATE_CODE = new RegExp(`["'\`](${CODES.join("|")})["'\`]`)
const CITY = new RegExp(`\\b(${CITIES.map((s) => s.replace(/\./g, "\\.").replace(/ /g, "\\s")).join("|")})\\b`)
const COMPASS = /["'`](north|south|east|west)(_side|_end|_county|_territory)?["'`]/i

/** PURE — every location literal in COMMENT-STRIPPED source, with its line. @proofSeam the census + controls. */
function findLocationLiterals(source: string): Array<{ kind: string; line: number; text: string }> {
  const out: Array<{ kind: string; line: number; text: string }> = []
  stripComments(source).split("\n").forEach((ln, i) => {
    for (const [kind, re] of [["region", REGION], ["state_name", STATE_NAME], ["state_code", STATE_CODE], ["city", CITY], ["compass_territory", COMPASS]] as const) {
      const m = re.exec(ln)
      if (m) out.push({ kind, line: i + 1, text: m[0] })
    }
  })
  return out
}

console.log("══════════════════════════════════════════════════")
console.log(" Location-literal census — no module hard-codes a territory, state, city or region")
console.log("══════════════════════════════════════════════════")

console.log("\nA. the census modules are clean (comment-stripped source; strings and identifiers scanned)")
const sources = Object.fromEntries(CENSUS_MODULES.map((p) => [p, readFileSync(p, "utf8")])) as Record<string, string>
let lines = 0
for (const p of CENSUS_MODULES) {
  const hits = findLocationLiterals(sources[p])
  lines += sources[p].split("\n").length
  check(`A ${p}: 0 location literals`, hits.length === 0, hits.slice(0, 5).map((h) => `${h.kind}@${h.line} ${h.text}`).join(", "))
}
console.log(`  · denominator: ${CENSUS_MODULES.length} modules, ${lines} lines scanned`)

console.log("\nB. NEGATIVE CONTROLS — a planted literal of every class FAILS the census (in memory; no file mutated)")
const plants: Array<[string, string]> = [
  ["region", `const band = "gulf_coast"`],
  ["state_name", `const where = { state: "Florida" }`],
  ["state_code", `const s = ["TX", "LA"]`],
  ["city", `assumed("x", "escrow_days", 38, "days", "contract-to-close in Pensacola")`],
  ["compass_territory", `const subject = { type: "territory", id: "north" }`],
]
for (const [kind, plant] of plants) {
  const caught = CENSUS_MODULES.every((p) => findLocationLiterals(`${sources[p]}\n${plant}\n`).some((h) => h.kind === kind))
  check(`B ${kind}: '${plant}' planted into each census module is caught`, caught)
}
check("B (control) the region the network benchmarks used to hard-code is caught in its old shape", findLocationLiterals(`const BANDS = { gulf_coast: ["TX", "LA", "MS", "AL", "FL"] }`).length >= 2)

console.log("\nC. POSITIVE CONTROL — a comment naming a place is not code")
check("C a tombstone / owner quote naming a place is NOT flagged (comments stripped first)", findLocationLiterals(`// TOMBSTONE: a "gulf_coast" band for Texas / Pensacola stood here\nconst x = marketBandForState(row.state)\n/* "TX" */`).length === 0)

console.log("\nD. the market band is DERIVED from tenant data")
check("D marketBandForState reads the stored state and never names a region (TX → tx; blank / free text → unknown_market)", marketBandForState("TX") === "tx" && marketBandForState(" ny ") === "ny" && marketBandForState(null) === "unknown_market" && marketBandForState("Gulf Coast") === "unknown_market")

console.log("\nE. registration + ownership")
{
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }
  check("E1 package.json: test:location-literal-census → this guard, on the guard chain (membership, not position)", pkg.scripts["test:location-literal-census"] === "tsx scripts/location-literal-census-guard.ts" && /npm run test:location-literal-census(\s|&|$)/.test(pkg.scripts.guard))
  const d = MAINTENANCE_DOMAINS.location_literal_census
  check("E2 MAINTENANCE_DOMAINS.location_literal_census: data_steward owns it, proof test:location-literal-census, co-owners named in the prose", d?.manager === "data_steward" && d.proof === "test:location-literal-census" && (d.coOwners ?? []).length === 2 && (d.coOwners ?? []).every((k) => k in MANAGERS && d.what.includes(k)))
}

console.log("\nF. REPORT-ONLY — the wider sweep (lib/kernel + lib/intelligence), printed not asserted")
{
  const walk = (dir: string, out: string[] = []): string[] => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) walk(p, out); else if (/\.ts$/.test(n)) out.push(p) } return out }
  const files = [...walk("lib/kernel"), ...walk("lib/intelligence")].filter((p) => !(CENSUS_MODULES as readonly string[]).includes(p))
  const flagged = files.map((p) => ({ p, n: findLocationLiterals(readFileSync(p, "utf8")).length })).filter((x) => x.n > 0)
  console.log(`  · ${flagged.length} of ${files.length} other modules carry a location-shaped literal (review list, not a failure): ${flagged.slice(0, 12).map((x) => `${x.p}(${x.n})`).join(", ")}${flagged.length > 12 ? " …" : ""}`)
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} location-literal-census: ${passed} passed, ${failed} failed`)
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
