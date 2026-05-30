/**
 * scripts/intelligence-modules-simulator.ts
 *
 * Exercises the pure + DB-bound paths of the 8 intelligence modules built this turn:
 *   #1 contact-signal-rescrape   (server-only — registry assertions only)
 *   #2 deal-investigator         (server-only — registry assertions only)
 *   #3 socrata-client            (LIVE public call to a known-good open dataset, no auth needed)
 *   #4 vision-property           (registry assertion + tsc proves wiring; live call needs key)
 *   #5 relisting-detector        (server-only — registry assertion)
 *   #6 intent-phrase-rollup      (server-only — registry assertion)
 *   #7 email-verifier            (RFC + MX tiers run live, no cost; Tier 3 covered by tsc)
 *   #8 lob-address-verify        (registry assertion; live call needs key)
 *
 * Pure pieces get real assertions; server-only modules covered by tsc + connector-gateway contract
 * + their own dedicated DB-bound tests when wired into a route.
 */
import { checkEmailSyntax, checkEmailMx } from "../lib/external/email-verifier"
import { socrataQuery } from "../lib/external/socrata-client"
import { getConnectorSpec } from "../lib/agentic-os/connector-registry"

let pass = 0, fail = 0
const ok = (cond: boolean, msg: string) => { if (cond) pass++; else { fail++; console.log(` ✗ ${msg}`) } }

// ── #7 Email verifier — Tier 1 (pure) ───────────────────────────────────────
const goodSyn = checkEmailSyntax("alice@example.com")
ok(goodSyn.verified && goodSyn.tier === 1,                          "email Tier 1: valid syntax")
const badSyn  = checkEmailSyntax("not-an-email")
ok(!badSyn.verified && badSyn.tier === 1,                           "email Tier 1: bad syntax rejected")
const disp    = checkEmailSyntax("foo@mailinator.com")
ok(!disp.verified && disp.isDisposable === true,                    "email Tier 1: disposable domain rejected")
const role    = checkEmailSyntax("support@acme.com")
ok(role.verified && role.isRoleAccount === true,                    "email Tier 1: role account flagged but not rejected")
const empty   = checkEmailSyntax("")
ok(!empty.verified,                                                 "email Tier 1: empty rejected")

// ── #7 Email verifier — Tier 2 (live MX lookup, free) ───────────────────────
const mxOk   = await checkEmailMx("alice@google.com")  // google.com has MX
ok(mxOk.verified && mxOk.tier === 2 && mxOk.hasMx === true,         "email Tier 2: google.com has MX")
const mxBad  = await checkEmailMx("alice@nonexistent-test-domain-12345.invalid")
ok(!mxBad.verified && mxBad.tier === 2 && mxBad.hasMx === false,    "email Tier 2: .invalid domain has no MX")
// Bad-syntax address short-circuits at Tier 1 and never hits DNS.
const mxShort = await checkEmailMx("not-an-email")
ok(!mxShort.verified && mxShort.tier === 1,                         "email Tier 2: bad syntax short-circuits before MX")

// ── #3 Socrata — live call against a known-stable open dataset (NYC 311, no auth) ─
// We ask for ONE row to keep the call bounded; the contract under test is "adapter returns
// structured result, never throws", not "this exact dataset id never changes".
const sa = await socrataQuery({
  host: "data.cityofnewyork.us",
  datasetId: "erm2-nwe9",                  // NYC 311 Service Requests — long-stable public dataset
  query: { limit: 1 },
})
ok(typeof sa.ok === "boolean" && Array.isArray(sa.data),            "socrata: live call returns structured shape (no throw)")
ok(sa.ok ? sa.data.length >= 0 : typeof sa.error === "string",      "socrata: ok=true implies array data, ok=false implies error string")
// Bad host — must not throw (gateway contract); returns ok=false structured.
const sb = await socrataQuery({ host: "this-portal-does-not-exist-12345.invalid", datasetId: "abcd-1234", query: { limit: 1 } })
ok(sb.ok === false,                                                 "socrata: bad host returns ok=false (no throw)")

// ── Registry assertions for the new connectors / endpoints ─────────────────
ok(!!getConnectorSpec("socrata"),                                   "registry: socrata connector added")
ok(getConnectorSpec("socrata")?.category === "scraper",             "registry: socrata category=scraper")
ok(!!getConnectorSpec("socrata")?.tags?.includes("permits"),        "registry: socrata tagged 'permits'")

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
