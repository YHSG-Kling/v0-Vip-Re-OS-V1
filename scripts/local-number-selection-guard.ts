#!/usr/bin/env tsx
/**
 * scripts/local-number-selection-guard.ts   (npm run test:local-number-selection)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 82, LANE 82D — owner verbatim: "the phone numbers most likely will not
 * be toll free numbers, build non toll free provisioning and selection numbers
 * which will most likely be area codes that start with their location."
 *
 * Asserts the RULE, each absence with a positive control:
 *   1. PLANNER — the tenant's own area code (typed, else the office phone's
 *      NPA) is the FIRST rung; nearby fallback follows Twilio's geographic
 *      search (NearNumber/NearLatLong + Distance, InPostalCode, InLocality +
 *      InRegion, a wider radius, InRegion); toll-free is LAST and only when
 *      asked; no location at all REFUSES (never a random nationwide number);
 *      a typed toll-free/N11/invalid code refuses with the reason.
 *   2. RUNNER — walks rungs until the limit, dedupes, labels each candidate
 *      with its rung, never lets a toll-free number pass as local, reaches
 *      toll-free only when local came up short, records rung errors and
 *      refuses only when EVERY rung errored; the registration lane per
 *      candidate is the SAME toll-free rule kickCarrierRegistration uses.
 *   3. WIRING — the ONE provisioning core runs the ladder through the Twilio
 *      SDK adapter (no hand-built REST), the tenant door is session-gated
 *      (broker roles) and the staff door is providers-write gated, the
 *      purchase path keeps the plan allowance + carrier registration, the
 *      auto-provision path buys LOCAL near the tenant, and both boards list
 *      the suggestions with their rung and a toll-free opt-in (off by default).
 *
 * No network, no DB, no Twilio (stub search).
 * Run: npx tsx scripts/local-number-selection-guard.ts
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments } from "./strip-comments"
import {
  areaCodeFromPhone, isValidLocalAreaCode, planLocalNumberSearch, runLocalNumberSearch, NEAR_DISTANCE_MILES, WIDE_DISTANCE_MILES,
  type LocalSearchStep, type RawCandidate,
} from "../lib/voice/local-number-search"
import { isTollFreeNumber } from "../lib/voice/a2p-registration"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const stripped = (p: string) => stripComments(readFileSync(join(root, p), "utf8"))
const bodyOf = (code: string, sig: string) => { const i = code.indexOf(sig); if (i < 0) return ""; const j = code.indexOf("\nexport ", i + sig.length); return code.slice(i, j < 0 ? undefined : j) }

async function main() {
  console.log("\n[1 · the planner — their area code first, nearby next, toll-free last and only when asked]")
  check("areaCodeFromPhone reads the NPA of a NANP number in any format", areaCodeFromPhone("(512) 555-0100") === "512" && areaCodeFromPhone("+1 305 555 0100") === "305" && areaCodeFromPhone("13055550100") === "305")
  check("CONTROL: toll-free, N11 and malformed numbers yield NO local area code", areaCodeFromPhone("+1 800 555 0100") === null && areaCodeFromPhone("888-555-0100") === null && areaCodeFromPhone("411-555-0100") === null && areaCodeFromPhone("555-0100") === null && areaCodeFromPhone(null) === null)
  check("isValidLocalAreaCode: geographic codes yes; toll-free / N11 / 0-1 leading / premium no", isValidLocalAreaCode("512") && isValidLocalAreaCode("212") && !isValidLocalAreaCode("800") && !isValidLocalAreaCode("833") && !isValidLocalAreaCode("211") && !isValidLocalAreaCode("123") && !isValidLocalAreaCode("900"))
  const office = { phone: "(512) 555-0100", zip: "78701", city: "Austin", state: "tx" }
  const plan = planLocalNumberSearch(office)
  check("with an office phone + ZIP + city/state the ladder is area_code → near_number → postal_code → locality → near_number_wide → region (no toll-free)",
    plan.ok && plan.steps.map((s) => s.rung).join(">") === "area_code>near_number>postal_code>locality>near_number_wide>region" && plan.areaCode === "512")
  check(`near rungs carry Twilio's radius (${NEAR_DISTANCE_MILES} mi, then ${WIDE_DISTANCE_MILES} mi) and the office number in E.164; the region is the 2-letter state`,
    plan.ok && plan.steps[1].params.nearNumber === "+15125550100" && plan.steps[1].params.distance === NEAR_DISTANCE_MILES && plan.steps.find((s) => s.rung === "near_number_wide")?.params.distance === WIDE_DISTANCE_MILES && plan.steps.find((s) => s.rung === "region")?.params.inRegion === "TX" && plan.steps.find((s) => s.rung === "locality")?.params.inLocality === "Austin")
  const withTf = planLocalNumberSearch(office, { includeTollFree: true })
  check("toll-free is the LAST rung and appears only when asked (the secondary option)", withTf.ok && withTf.steps[withTf.steps.length - 1].rung === "toll_free" && plan.ok && !plan.steps.some((s) => s.rung === "toll_free"))
  const typed = planLocalNumberSearch({ ...office, areaCode: "737" })
  check("a typed area code wins over the office phone's", typed.ok && typed.steps[0].params.areaCode === "737" && typed.areaCode === "737")
  const tf = planLocalNumberSearch({ ...office, areaCode: "888" })
  check("a typed TOLL-FREE code is refused with the reason (tick toll-free instead)", !tf.ok && /not a local/.test(tf.reason) && /toll-free/.test(tf.reason))
  const noLoc = planLocalNumberSearch({})
  check("no location at all → REFUSED naming what to add (never a random nationwide number)", !noLoc.ok && /no location on file/.test(noLoc.reason))
  check("CONTROL: the same planner with only a state still plans (region rung)", (() => { const p = planLocalNumberSearch({ state: "FL" }); return p.ok && p.steps.map((s) => s.rung).join() === "region" })())
  const ll = planLocalNumberSearch({ latitude: 30.27, longitude: -97.74, state: "TX" })
  check("a lat/long anchor adds the NearLatLong rung before the state", ll.ok && ll.steps[0].rung === "near_lat_long" && ll.steps[0].params.nearLatLong === "30.27,-97.74")

  console.log("\n[2 · the runner — dedupe, label, never a toll-free number as local, fail closed only when nobody could look]")
  const rows = (nums: string[]): RawCandidate[] => nums.map((n) => ({ phoneNumber: n, locality: "Austin", region: "TX" }))
  if (plan.ok) {
    const calls: string[] = []
    const r = await runLocalNumberSearch(plan, async (step: LocalSearchStep) => {
      calls.push(step.rung)
      if (step.rung === "area_code") return { ok: true, rows: rows(["+15125550101", "+18005550100", "+15125550102"]) }
      if (step.rung === "near_number") return { ok: true, rows: rows(["+15125550102", "+17375550103"]) }
      return { ok: true, rows: rows(["+17375550104"]) }
    }, { limit: 3 })
    check("candidates are deduped, labelled with their rung, and the walk stops at the limit (later rungs not asked)",
      r.ok && r.candidates.map((c) => `${c.phoneNumber}:${c.rung}`).join(",") === "+15125550101:area_code,+15125550102:area_code,+17375550103:near_number" && calls.join() === "area_code,near_number")
    check("a toll-free number returned by a LOCAL rung is dropped, never offered as local", r.ok && !r.candidates.some((c) => c.phoneNumber === "+18005550100"))
    check("inAreaCode marks the tenant's own NPA; every local candidate registers through A2P 10DLC", r.ok && r.candidates[0].inAreaCode && !r.candidates[2].inAreaCode && r.candidates.every((c) => c.registrationLane === "10dlc" && !c.tollFree))
  }
  if (withTf.ok) {
    const calls: string[] = []
    const r = await runLocalNumberSearch(withTf, async (step) => {
      calls.push(step.rung)
      return step.rung === "toll_free" ? { ok: true, rows: rows(["+18885550100"]) } : { ok: true, rows: [] }
    }, { limit: 2 })
    check("toll-free is reached only after every local rung came up short, and is labelled secondary with the toll-free registration lane",
      r.ok && calls[calls.length - 1] === "toll_free" && calls.length === withTf.steps.length && r.candidates.length === 1 && r.candidates[0].tollFree && r.candidates[0].registrationLane === "tollfree" && /secondary/.test(r.candidates[0].rungLabel))
    const r2 = await runLocalNumberSearch(withTf, async (step) => (step.rung === "area_code" ? { ok: true as const, rows: rows(["+15125550101", "+15125550102"]) } : { ok: true as const, rows: rows(["+18885550100"]) }), { limit: 2 })
    check("CONTROL: when local fills the limit, toll-free is never searched", r2.ok && r2.candidates.every((c) => !c.tollFree))
  }
  if (plan.ok) {
    const partial = await runLocalNumberSearch(plan, async (step) => (step.rung === "area_code" ? { ok: false as const, error: "(503) upstream" } : { ok: true as const, rows: rows(["+17375550105"]) }), { limit: 1 })
    check("a rung that errors is recorded and the walk continues", partial.ok && partial.tried[0].error === "(503) upstream" && partial.candidates[0].rung === "near_number")
    const dead = await runLocalNumberSearch(plan, async () => ({ ok: false as const, error: "(401) auth" }))
    check("EVERY rung errored → refused naming the errors (never 'no numbers' when nobody could look)", !dead.ok && /failed on every rung/.test(dead.reason) && /\(401\) auth/.test(dead.reason))
    const empty = await runLocalNumberSearch(plan, async () => ({ ok: true as const, rows: [] }))
    check("CONTROL: every rung answered with nothing → ok with zero candidates (an honest empty, distinct from a failure)", empty.ok && empty.candidates.length === 0)
  }
  check("the candidate's registration lane is the SAME rule kickCarrierRegistration uses (isTollFreeNumber)", isTollFreeNumber("+18885550100") && !isTollFreeNumber("+15125550101") && /isTollFreeNumber\(row\.phoneNumber\)/.test(stripped("lib/voice/local-number-search.ts")) && /isTollFreeNumber\(args\.phoneNumber\) \? "tollfree" : "10dlc"/.test(stripped("lib/voice/a2p-registration.ts")))

  console.log("\n[3 · wiring — one core, the SDK adapter, gated doors, billing + registration kept, both boards]")
  const client = stripped("lib/providers/twilio/client.ts")
  check("the Twilio SDK adapter passes Twilio's geographic params (inRegion / inPostalCode / nearNumber / nearLatLong / distance) and lists TollFree — through the SDK, no hand-built fetch",
    /import Twilio from "twilio"/.test(client) && ["inRegion", "inPostalCode", "nearNumber", "nearLatLong", "distance"].every((k) => new RegExp(`\\{ ${k}: opts\\.${k} \\}`).test(client)) && /\.tollFree\.list\(/.test(client) && !/(?<![.\w])fetch\(/.test(client))
  // Wave 83D re-anchor: the SDK's own `.fetch(` resource method (porting status /
  // portability) is the SDK, not a hand-built request — only a BARE fetch( call is
  // banned. The adapter's ONE deliberate non-SDK call (the utility-bill upload, no
  // SDK resource exists) goes through an injected fetchImpl and is held by
  // scripts/pick-or-port-guard.ts.
  const core = stripped("lib/voice/number-provisioning.ts")
  const suggest = bodyOf(core, "export async function suggestLocalNumbers(")
  check("suggestLocalNumbers = pure planner → canonical creds → SDK search per rung (local or toll-free)", /planLocalNumberSearch\(loc\.anchor/.test(suggest) && /resolveCreds\(svc, brokerageId\)/.test(suggest) && /searchAvailableTollFreeNumbers\(creds/.test(suggest) && /searchAvailableLocalNumbers\(creds, \{ \.\.\.step\.params/.test(suggest))
  check("the location anchor reads the tenant's own brokerage row, and a named location only under the tenant predicate", /from\("brokerages"\)\.select\("phone, (address, )?city, state, zip"\)\.eq\("id", brokerageId\)/.test(core) && /from\("locations"\)\.select\("(address, )?city, state"\)\.eq\("id", opts\.locationId\)\.eq\("brokerage_id", brokerageId\)/.test(core))
  // (Wave 83D re-anchor: the anchor now also reads the street address — the geocoder's input.)
  const prov = bodyOf(core, "export async function provisionNumber(")
  check("provisionNumber with no number and no area code buys the first LOCAL number near the tenant (never toll-free, never any-US)", /if \(!targetNumber && !params\.areaCode\)/.test(prov) && /suggestLocalNumbers\(svc, params\.brokerageId, \{ limit: 1 \}\)/.test(prov) && !/includeTollFree: true/.test(prov))
  check("the purchase pipeline still gates the plan allowance first and kicks carrier registration after purchase", prov.indexOf("evaluateTenantNumberProvisioning") > -1 && prov.indexOf("evaluateTenantNumberProvisioning") < prov.indexOf("purchaseIncomingPhoneNumber(") && prov.indexOf("kickCarrierRegistration(") > prov.indexOf("purchaseIncomingPhoneNumber("))
  const tenant = stripped("app/actions/phone-provisioning.ts")
  const tSuggest = bodyOf(tenant, "export async function suggestLocalNumbersAction(")
  check("the tenant door is session-scoped (acting context + broker role) BEFORE the service client, and takes no brokerageId", tSuggest.indexOf("resolveActingContext()") > 0 && tSuggest.indexOf("isBrokerRole(ctx.userType)") > tSuggest.indexOf("resolveActingContext()") && tSuggest.indexOf("createServiceClient()") > tSuggest.indexOf("isBrokerRole(ctx.userType)") && !/params\.brokerageId|brokerageId:\s*string/.test(tSuggest))
  const tBuy = bodyOf(tenant, "export async function purchaseBrokerageNumberAction(")
  check("the tenant purchase keeps the plan allowance (enforceTenantAllowance: true — bundle/overage/hard cap) and reports the carrier-registration line", /enforceTenantAllowance: true/.test(tBuy) && /registration: result\.registration \?/.test(tBuy) && /A2P 10DLC/.test(tBuy))
  const staff = stripped("app/actions/superadmin/number-provisioning.ts")
  const sSuggest = bodyOf(staff, "export async function suggestLocalNumbersForTenant(")
  check("the staff door is providers-WRITE gated before the service client (platform sees all tenants)", sSuggest.indexOf(`requirePlatformCapability("providers", { requireWrite: true })`) > 0 && sSuggest.indexOf("createServiceClient()") > sSuggest.indexOf("requirePlatformCapability("))
  check("staff provisioning stays platform-side billing (no tenant allowance flag) and audits the carrier registration", !/enforceTenantAllowance/.test(bodyOf(staff, "export async function provisionNumberForTenant(")) && /carrier_registration:/.test(staff))
  const ui = stripped("app/dashboard/admin/phone-settings/phone-settings-client.tsx")
  check("the tenant board: 'Find local numbers' runs the suggestion, each row shows its rung, toll-free is an opt-in OFF by default, the registration line shows after a buy",
    /suggestLocalNumbersAction\(\{ areaCode: areaCode\.trim\(\) \|\| undefined, includeTollFree \}\)/.test(ui) && /Find local numbers/.test(ui) && /c\.rungLabel/.test(ui) && /const \[includeTollFree, setIncludeTollFree\] = useState\(false\)/.test(ui) && /res\.registration/.test(ui))
  const sui = stripped("app/dashboard/superadmin/numbers/numbers-client.tsx")
  check("the superadmin numbers board: the same suggestion per tenant with rung labels and a toll-free opt-in (off by default)", /suggestLocalNumbersForTenant\(\{ brokerageId, areaCode: areaCode\.trim\(\) \|\| undefined, includeTollFree \}\)/.test(sui) && /c\.rungLabel/.test(sui) && /const \[includeTollFree, setIncludeTollFree\] = useState\(false\)/.test(sui))
  check("CONTROL: the default-off finder would fail on a toll-free-first board", !/const \[includeTollFree, setIncludeTollFree\] = useState\(false\)/.test("const [includeTollFree, setIncludeTollFree] = useState(true)"))

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log(" blind spots: no live Twilio search (sandbox) — the adapter's param names are asserted by source against the SDK's LocalList options; brokerages/locations carry no lat/long column, so since wave 83D the office address is geocoded per search through lib/external/nominatim-geocode.ts (memoised in-process, never cached on the row) and NearLatLong + per-candidate distance run only when that geocode succeeds; area-code overlays (two NPAs on one city) are covered by the near/locality rungs, not by an NPA table; porting and BYO numbers are not searched here (ports: scripts/pick-or-port-guard.ts).")
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ LOCAL_NUMBER_SELECTION_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
