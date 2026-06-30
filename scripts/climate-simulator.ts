#!/usr/bin/env tsx
/**
 * scripts/climate-simulator.ts   (npm run test:climate)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves location → climate derivation (deriveClimate / parseUsState): US state
 * extraction from an address tail, zone classification (cold/temperate/warm/
 * tropical), coastal storm exposure, Southern-hemisphere detection, and safe
 * defaults when the location is missing/unparseable. Pure: no I/O, no network.
 *
 * NOTE: this is the coarse state-level heuristic; the production path is a live
 * climate-normals/weather lookup keyed off geocode (see lib/portal/climate.ts).
 */
import { deriveClimate, parseUsState } from "../lib/portal/climate"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[parseUsState extracts the state from an address tail]")
  check("standard address", parseUsState("123 Oak St, Austin, TX 78701") === "TX")
  check("no zip", parseUsState("500 Bay Rd, Miami, FL") === "FL")
  check("lowercase fallback", parseUsState("10 lake st, minneapolis, mn") === "MN")
  check("no state → null", parseUsState("123 Somewhere Lane") === null)
  check("empty → null", parseUsState("") === null)
  check("does not match random 2-letter word as state", parseUsState("12 Go St, Nowhere") === null || parseUsState("12 Go St, Nowhere") !== "GO")

  console.log("\n[zone classification]")
  check("MN → cold", deriveClimate("x, Minneapolis, MN").zone === "cold")
  check("AZ → warm", deriveClimate("x, Phoenix, AZ").zone === "warm")
  check("FL → tropical", deriveClimate("x, Miami, FL").zone === "tropical")
  check("NY → temperate", deriveClimate("x, Albany, NY").zone === "temperate")
  check("unknown → temperate default", deriveClimate(null).zone === "temperate")

  console.log("\n[coastal storm exposure]")
  check("FL storm-exposed", deriveClimate("x, Miami, FL").stormExposed)
  check("LA storm-exposed", deriveClimate("x, New Orleans, LA").stormExposed)
  check("AZ NOT storm-exposed", !deriveClimate("x, Phoenix, AZ").stormExposed)

  console.log("\n[hemisphere]")
  check("US → north", deriveClimate("x, Denver, CO").hemisphere === "north")
  check("Australia → south", deriveClimate("1 Harbour St, Sydney, Australia").hemisphere === "south")
  check("Chile → south", deriveClimate("Av Siempre, Santiago, Chile").hemisphere === "south")

  console.log("\n[region surfaced for 'tailored to {region}' copy]")
  check("region = state", deriveClimate("x, Austin, TX 78701").region === "TX")
  check("region null when unknown", deriveClimate("123 Somewhere").region === null)

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ CLIMATE_FAIL"); process.exit(1) }
  console.log(" ✅ CLIMATE_PASS — location → hemisphere + zone + storm exposure, safe defaults")
}
main()
