#!/usr/bin/env tsx
/**
 * scripts/batchdata-date-window-guard.ts   (npm run test:batchdata-date-window)
 * ─────────────────────────────────────────────────────────────────────────────
 * Lane 89E (wave 89) — lane 88G's open item 3 closed: "BatchData filter field shapes unresolved
 * (min_tax_delinquent_year, min_foreclosure_recording_date, min_auction_date, min_last_sale_date are
 * MCP parameter names; the v1 searchCriteria JSON they map to was not confirmed) — not wired. With
 * them, 'same-day' becomes a recording-date window on the V1 pull."
 *
 * The shapes were confirmed WITHOUT a paid call (BatchData's MCP search schema publishes the filters;
 * the published SDK mirroring the v1 request schema serialises them as nested {minDate,maxDate} /
 * {min,max} under foreclosure / tax / sale) and wired as ONE pure function, dateWindowCriteria, merged
 * by buildPropertySearchBody's existing verbatim passthrough. PURE — no network, no DB.
 *
 *   A · dateWindowCriteria per trigger: recorder filings → foreclosure.recordingDate.minDate = today −
 *       lookback; auction → foreclosure.auctionDate.minDate = today (upcoming, never a look-back);
 *       tax_lien → tax.taxDelinquentYear.min = year − ceil(lookback/365); aliases resolve; a trigger
 *       with no dated field, or no lookback, → {} (the window-less wave-88 pull, unchanged).
 *   B · buildPropertySearchBody merges the fragment beside the quickList (never replacing it); a pull
 *       with no window is BYTE-IDENTICAL to a pull built without the feature (the rule: opt-in only).
 *   C · the cron threads the market's lookback_days into each SINGLE-trigger pull; the wrapper applies
 *       a window only to a single-trigger pull (BatchData labels a multi-trigger pull with types[0]).
 *   D · what is NOT wired is published: a listing-DATE filter for expired / canceled / failed listings
 *       (no evidence of the key) — those triggers return {} and the proof pins that they do.
 * Every absence rule has a POSITIVE CONTROL.
 * Run: npx tsx scripts/batchdata-date-window-guard.ts
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { dateWindowCriteria, buildPropertySearchBody } from "../lib/external/batchdata-client"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"

const ROOT = process.cwd()
const code = (p: string) => stripComments(readFileSync(join(ROOT, p), "utf8"))
let pass = 0
let fail = 0
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}
const today = new Date("2026-09-29T12:00:00Z")
const W = (lookbackDays: number | null) => ({ lookbackDays, today })

console.log("\n[A · dateWindowCriteria — one fragment per dated trigger]")
ok("pre_foreclosure, 30 days → foreclosure.recordingDate.minDate 2026-08-30",
  JSON.stringify(dateWindowCriteria("pre_foreclosure", W(30))) === JSON.stringify({ foreclosure: { recordingDate: { minDate: "2026-08-30" } } }), JSON.stringify(dateWindowCriteria("pre_foreclosure", W(30))))
ok("notice_of_default / lis_pendens / foreclosure share the recording-date floor",
  ["notice_of_default", "lis_pendens", "foreclosure"].every((t) => JSON.stringify(dateWindowCriteria(t, W(7))) === JSON.stringify({ foreclosure: { recordingDate: { minDate: "2026-09-22" } } })))
ok("auction → foreclosure.auctionDate.minDate = TODAY (upcoming sales; a look-back would list sales already held)",
  JSON.stringify(dateWindowCriteria("auction", W(30))) === JSON.stringify({ foreclosure: { auctionDate: { minDate: "2026-09-29" } } }))
ok("tax_lien, 30 days → tax.taxDelinquentYear.min = 2025 (at least one year back)", JSON.stringify(dateWindowCriteria("tax_lien", W(30))) === JSON.stringify({ tax: { taxDelinquentYear: { min: 2025 } } }))
ok("tax_lien, 3 years → min = 2023", JSON.stringify(dateWindowCriteria("tax_lien", W(1095))) === JSON.stringify({ tax: { taxDelinquentYear: { min: 2023 } } }))
ok("config aliases resolve before the switch (\"preforeclosure\", \"nod\", \"active-auction\", \"tax-delinquent\")",
  "foreclosure" in dateWindowCriteria("preforeclosure", W(1)) && "foreclosure" in dateWindowCriteria("nod", W(1))
  && JSON.stringify(dateWindowCriteria("active-auction", W(1))) === JSON.stringify(dateWindowCriteria("auction", W(1)))
  && "tax" in dateWindowCriteria("tax-delinquent", W(1)))
ok("no lookback (null / 0 / negative / NaN) → {} — the window-less pull",
  [null, 0, -3, Number.NaN].every((d) => Object.keys(dateWindowCriteria("pre_foreclosure", W(d as number))).length === 0))
ok("a trigger with no dated field (high_equity, absentee, probate, vacant, tired_landlord) → {}",
  ["high_equity", "absentee", "probate", "vacant", "tired_landlord"].every((t) => Object.keys(dateWindowCriteria(t, W(30))).length === 0))
ok("[D · published, not wired] expired / canceled_listing / failed_listing carry NO listing-date filter (key unconfirmed — unresolved)",
  ["expired", "canceled_listing", "failed_listing"].every((t) => Object.keys(dateWindowCriteria(t, W(30))).length === 0))
ok("fractional lookback floors to whole days (7.9 → 7)", JSON.stringify(dateWindowCriteria("pre_foreclosure", W(7.9))) === JSON.stringify(dateWindowCriteria("pre_foreclosure", W(7))))

console.log("\n[B · the fragment rides buildPropertySearchBody's passthrough beside the quickList]")
const windowed = buildPropertySearchBody({ state: "FL", city: "Tampa", motivationTypes: ["pre_foreclosure"], searchCriteria: dateWindowCriteria("pre_foreclosure", W(14)) })
ok("query + orQuickLists kept, foreclosure.recordingDate added",
  windowed.searchCriteria.query === "Tampa, FL" && JSON.stringify(windowed.searchCriteria.orQuickLists) === JSON.stringify(["preforeclosure"])
  && JSON.stringify(windowed.searchCriteria.foreclosure) === JSON.stringify({ recordingDate: { minDate: "2026-09-15" } }), JSON.stringify(windowed))
const plain = buildPropertySearchBody({ state: "FL", city: "Tampa", motivationTypes: ["pre_foreclosure"] })
const emptyWindow = buildPropertySearchBody({ state: "FL", city: "Tampa", motivationTypes: ["pre_foreclosure"], searchCriteria: dateWindowCriteria("pre_foreclosure", W(null)) })
ok("RULE: a pull with no window is BYTE-IDENTICAL to the wave-88 pull (opt-in, never a silent behaviour change)", JSON.stringify(plain) === JSON.stringify(emptyWindow))
ok("POSITIVE CONTROL: the windowed body is NOT identical (the window is what changed it)", JSON.stringify(plain) !== JSON.stringify(windowed))

console.log("\n[C · the cron threads the market's lookback into each single-trigger pull]")
const cron = code("app/api/cron/lead-scraping/route.ts")
ok("the motivated-params row type carries lookback_days and the cron derives pullWindow from it",
  /lookback_days\?: number \| null/.test(cron) && /const pullWindow = \{ lookbackDays: motivatedParams\.lookback_days \?\? null \}/.test(cron))
ok("every motivated trigger's pull passes pullWindow", /getMotivatedSellerDataWithCost\(location, \[t\], pullWindow\)/.test(cron))
ok("POSITIVE CONTROL: the finder recognises the retired window-less call", /getMotivatedSellerDataWithCost\(location, \[t\]\)/.test(`batchdata.getMotivatedSellerDataWithCost(location, [t])`) && !/getMotivatedSellerDataWithCost\(location, \[t\]\)/.test(cron))
const client = code("lib/external/batchdata-client.ts")
ok("the wrapper applies a window ONLY to a single-trigger pull (a multi-trigger pull is labelled types[0] and must not be narrowed by one trigger's window)",
  /window && motivationTypes && motivationTypes\.length === 1\s*\?\s*dateWindowCriteria\(motivationTypes\[0\], window\)\s*:\s*undefined/.test(client))
ok("dateWindowCriteria is the ONE window builder (no second recordingDate/auctionDate spelling in app/lib)",
  (client.match(/recordingDate:\s*\{\s*minDate/g) ?? []).length === 1 && (client.match(/auctionDate:\s*\{\s*minDate/g) ?? []).length === 1)

console.log("\n[registration]")
const dom = MAINTENANCE_DOMAINS["batchdata_date_window"]
ok("MAINTENANCE_DOMAINS.batchdata_date_window is owned (data_steward) with cron_manager + finance_manager co-owners named in prose",
  dom?.manager === "data_steward" && ["cron_manager", "finance_manager"].every((c) => (dom?.coOwners ?? []).includes(c as never)) && /cron_manager/.test(dom?.what ?? "") && /finance_manager/.test(dom?.what ?? ""))
ok("its proof is this script's npm target", dom?.proof === "test:batchdata-date-window")

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${pass} passed, ${fail} failed`)
console.log(fail === 0 ? " ✅ BATCHDATA_DATE_WINDOW_PASS — the market's lookback is a date floor on the V1 pull; window-less pulls are unchanged" : " ❌ BATCHDATA_DATE_WINDOW_FAIL")
process.exit(fail === 0 ? 0 : 1)
