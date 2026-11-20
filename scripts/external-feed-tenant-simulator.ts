#!/usr/bin/env tsx
/**
 * scripts/external-feed-tenant-simulator.ts
 *   (npm run test:external-feed-tenant — pure, no DB)
 * ─────────────────────────────────────────────────────────────────────────────
 * A SURFACE WITH NO SESSION MUST NOT GUESS A TENANT.
 *
 * Two owner rulings, 2026-08-24, both closing questions a previous lane recorded
 * as UNRESOLVED rather than guessing:
 *
 *   RULING 2 — "inbound suppression could come from an external feeds like
 *               emails/dms etc."
 *   RULING 3 — "public landing pages should not show cross brokerage comps.
 *               not sure how that got figured in?"
 *
 * They are the same defect seen from two sides. A webhook and a public page both
 * lack a session, so neither can read the tenant from one; and in both places the
 * tenant was allowed to go MISSING rather than being refused:
 *
 *   · inbound-suppression took `brokerageId` FROM THE REQUEST BODY on a service
 *     client (CLAUDE.md §4 forbids that outright), and when it was absent fell to
 *     `.limit(1)` on a bare phone/email match with NO ambiguity check — silencing
 *     whichever brokerage's contact sorted first.
 *   · getSimilarListings took an OPTIONAL brokerageId that its ONE caller never
 *     passed, so a public landing page listed similar homes from every brokerage.
 *
 * ── WHY THIS PROOF IS PART PURE-EXECUTION AND PART SOURCE ────────────────────
 * The RULE — "one distinct tenant or nothing" — is a pure function, so it is
 * EXECUTED here rather than pattern-matched: a regex cannot tell a returned
 * `ok: true` from a returned `ok: false`. The WIRING — that the route actually
 * routes through it, that the parameter is actually required — is structural, so
 * it is read from source. Every source assertion carries a MUTATION: the check is
 * re-run against a deliberately broken copy of the same text and must go RED.
 * A source check that has never been shown to fail is indistinguishable from one
 * whose regex silently stopped matching (CLAUDE.md §2).
 *
 * Source is read through stripComments: a TOMBSTONE IS NOT A CALL SITE, and both
 * of these files now carry long tombstones quoting the very code that was
 * removed. Reading raw source would let the prose satisfy the assertions it
 * exists to describe — the exact failure that took five guards red in one wave.
 */
import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments } from "./strip-comments"
import { resolveUnambiguousTenant, requireTenantedUnambiguousTenant } from "../lib/kernel/unambiguous-tenant"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const raw = (p: string) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : "")
const code = (p: string) => stripComments(raw(p))

let pass = 0
let fail = 0
const failures: string[] = []
function check(label: string, cond: boolean, why?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${why ? `\n      ${why}` : ""}`) }
}

/**
 * A source assertion PLUS its own negative control. `predicate` is run on the
 * real stripped source (must be TRUE) and again on a mutated copy (must be
 * FALSE). Both halves are reported, because a check that cannot fail is not a
 * check.
 */
function checkWithMutation(
  label: string,
  src: string,
  predicate: (s: string) => boolean,
  mutation: [find: string, replace: string],
  why: string,
) {
  const live = predicate(src)
  const mutated = src.includes(mutation[0]) ? src.replace(mutation[0], mutation[1]) : null
  if (mutated === null) {
    fail++
    failures.push(`${label} (mutation anchor missing)`)
    console.log(`  ✗ ${label}\n      MUTATION ANCHOR NOT FOUND: ${JSON.stringify(mutation[0].slice(0, 70))}`)
    console.log("      The control cannot run, so this check's green means nothing.")
    return
  }
  const broken = predicate(mutated)
  if (live && !broken) { pass++; console.log(`  ✓ ${label}  [mutation → red ✓]`) }
  else {
    fail++
    failures.push(label)
    console.log(`  ✗ ${label}`)
    if (!live) console.log(`      the real source does NOT satisfy it — ${why}`)
    if (broken) console.log("      …and the MUTATED source satisfies it too, so the check cannot detect the defect at all")
  }
}

console.log("══════════════════════════════════════════════════════════════════")
console.log("EXTERNAL-FEED TENANT RESOLUTION — rulings 2 & 3")
console.log("══════════════════════════════════════════════════════════════════")

// ═══ 1. THE RULE ITSELF, EXECUTED ═════════════════════════════════════════
console.log("\n═══ 1. lib/kernel/unambiguous-tenant.ts — one distinct tenant or nothing ═══")
{
  const A = "11111111-1111-1111-1111-111111111111"
  const B = "22222222-2222-2222-2222-222222222222"

  check("ONE candidate in ONE tenant is accepted",
    (() => { const r = resolveUnambiguousTenant([{ id: "c1", brokerage_id: A }]); return r.ok && r.brokerageId === A })(),
    "the honest case is refused, so the fix would break every legitimate inbound opt-out")

  check("TWO candidates in the SAME tenant are accepted, and BOTH rows come back",
    (() => {
      const r = resolveUnambiguousTenant([{ id: "c1", brokerage_id: A }, { id: "c2", brokerage_id: A }])
      return r.ok && r.brokerageId === A && r.rows.length === 2
    })(),
    "duplicate contacts inside one brokerage are not ambiguity — refusing them would break a common, harmless shape (and sendgrid's limit(5) fallback needs every id)")

  check("TWO TENANTS claiming the identity is REFUSED — this is the whole point",
    (() => {
      const r = resolveUnambiguousTenant([{ id: "c1", brokerage_id: A }, { id: "c2", brokerage_id: B }])
      return !r.ok && r.reason === "ambiguous_tenant" && r.tenantCount === 2
    })(),
    "the same person at two brokerages would be resolved to whichever sorted first — one tenant's 'stop' silencing another tenant's contact")

  check("NO candidates is 'no_match', which is NOT the same answer as ambiguity",
    (() => { const r = resolveUnambiguousTenant([]); return !r.ok && r.reason === "no_match" && r.tenantCount === 0 })(),
    "'nobody' and 'we cannot tell whose' would report identically, and a caller could not choose a different status code for them")

  check("null/undefined rows are 'no_match', not a crash",
    !resolveUnambiguousTenant(null).ok && !resolveUnambiguousTenant(undefined).ok,
    "supabase-js returns data:null on a refusal (CLAUDE.md §3), so this is the shape a REFUSED read arrives in")

  check("candidates that all carry a NULL brokerage_id are unambiguous ABOUT BEING UNTENANTED",
    (() => { const r = resolveUnambiguousTenant([{ id: "c1", brokerage_id: null }]); return r.ok && r.brokerageId === null })(),
    "contacts.brokerage_id is nullable; collapsing 'untenanted' into 'ambiguous' would hide which of the two happened")

  check("…and the FAIL-CLOSED variant refuses exactly that case",
    (() => { const r = requireTenantedUnambiguousTenant([{ id: "c1", brokerage_id: null }]); return !r.ok && r.reason === "untenanted" })(),
    "a caller that must write a NOT NULL brokerage_id would be handed null and refused by the database instead of by the rule")

  check("NEGATIVE CONTROL — the rule is not just 'take the first row'",
    (() => {
      const naive = [{ id: "c1", brokerage_id: A }, { id: "c2", brokerage_id: B }][0].brokerage_id
      const r = resolveUnambiguousTenant([{ id: "c1", brokerage_id: A }, { id: "c2", brokerage_id: B }])
      return naive === A && !r.ok
    })(),
    "the naive answer and the rule's answer agree here, which would mean the rule adds nothing")
}

// ═══ 2. RULING 2 — the inbound-suppression webhook ════════════════════════
console.log("\n═══ 2. app/api/webhooks/inbound-suppression/route.ts (ruling 2) ═══")
{
  const ROUTE = "app/api/webhooks/inbound-suppression/route.ts"
  const src = code(ROUTE)
  check("the route file was read at all", src.length > 500,
    "an empty read makes every assertion below vacuously true")

  // The body-supplied tenant is GONE. Asserted on STRIPPED source, because the
  // tombstone that must stay names the removed field in prose.
  check("no body-supplied tenant survives anywhere in the executable source",
    !/payload\.brokerageId/.test(src) && !/brokerageId\?:\s*string/.test(src),
    "CLAUDE.md §4 — the tenant would still be arriving in the request body on a service client")
  check("…and the tombstone that records the removal is still PROSE, not code",
    /payload\.brokerageId/.test(raw(ROUTE)) && !/payload\.brokerageId/.test(src),
    "either the tombstone was deleted (§1 requires it stay) or the field came back as real code")

  checkWithMutation(
    "the fuzzy identity lookup reads limit(2), never limit(1)",
    src,
    (s) => /\.limit\(2\)/.test(s) && !/\.eq\(identity\.column, identity\.value\)[\s\S]{0,80}\.limit\(1\)/.test(s),
    [".limit(2)", ".limit(1)"],
    "with one row the ambiguity rule cannot tell an unambiguous match from a truncated ambiguous one — it would report ok for the first of five tenants",
  )

  checkWithMutation(
    "the candidates go through the shared rule, not a re-spelling",
    src,
    (s) => /resolveUnambiguousTenant\(/.test(s) && /from "@\/lib\/kernel\/unambiguous-tenant"/.test(raw(ROUTE)),
    ["resolveUnambiguousTenant(", "takeFirst("],
    "§6 — a fourth private copy of the one-distinct-tenant rule",
  )

  checkWithMutation(
    "AMBIGUITY REFUSES with 409, rather than picking a tenant",
    src,
    (s) => /reason === "ambiguous_tenant"/.test(s) && /"tenant_ambiguous"/.test(s) && /status: 409/.test(s),
    ['reason === "ambiguous_tenant"', 'reason === "never"'],
    "the ambiguous branch would fall through and the handler would suppress whichever contact it found first",
  )

  checkWithMutation(
    "the tenant is DERIVED from the resolved contact row, never asserted by the caller",
    src,
    (s) => /const resolvedBrokerageId = \(contactData as/.test(s) && /brokerage_id\?: string \| null/.test(s),
    ["const resolvedBrokerageId = (contactData as", "const resolvedBrokerageId = (payload as"],
    "the write's tenant would come from something other than the row the identity resolved to",
  )

  checkWithMutation(
    "a lead lookup that is REFUSED stops the handler instead of falling through to the fuzzy match",
    src,
    (s) => /if \(leadError\)/.test(s) && s.indexOf("if (leadError)") < s.indexOf("fuzzyIdentity"),
    ["if (leadError)", "if (false && leadError)"],
    "CLAUDE.md §3 — supabase-js RESOLVES a refusal, so a permission denial would read as 'this lead has no contact' and a precise lookup would silently become a guess",
  )

  checkWithMutation(
    "the contact UPDATE counts rows — a zero-row update is not success",
    src,
    (s) => /\.select\("id"\)/.test(s) && /updated\.length === 0/.test(s),
    ["updated.length === 0", "updated.length === -1"],
    "CLAUDE.md §3 — an UPDATE matching nothing resolves with error null, byte-identical to one that worked, and the feed would be told the person was suppressed",
  )

  checkWithMutation(
    "the audit ledger row goes through addSuppression — the designated writer",
    src,
    (s) => /addSuppression\(\{/.test(s) && /brokerageId: resolvedBrokerageId/.test(s) && /channel: SUPPRESSION_CHANNEL\[/.test(s),
    ["addSuppression({", "recordSuppressionEvent({"],
    "the deleted writer omitted brokerage_id and channel — both NOT NULL with no default — so every insert it made was refused 23502 and the ledger stayed empty",
  )

  checkWithMutation(
    "a REFUSED ledger row is reported, not swallowed",
    src,
    (s) => /if \(!ledger\.suppressed\)/.test(s) && /"suppression_ledger_failed"/.test(s),
    ["if (!ledger.suppressed)", "if (false)"],
    "a consent withdrawal that is not recorded is not a consent withdrawal, and the old code answered success:true either way",
  )

  check("an untenanted contact REFUSES rather than writing a ledger row it cannot tenant",
    /if \(!resolvedBrokerageId\)/.test(src) && /"tenant_unresolved"/.test(src),
    "contact_suppression_list.brokerage_id is NOT NULL; a null would be refused by the database and swallowed here")

  check("the deleted duplicate writer is gone from the kernel",
    !/export async function recordSuppressionEvent/.test(code("lib/kernel/suppression-sync.ts")),
    "two writers of contact_suppression_list, one of which cannot write, is the §1 duplicate this closed")
  check("…and its tombstone names the survivor at file:line",
    /addSuppression/.test(raw("lib/kernel/suppression-sync.ts")) &&
    /check-suppression\.ts/.test(raw("lib/kernel/suppression-sync.ts")),
    "CLAUDE.md §1 — every deletion names its survivor")
  check("syncSuppressionState (the lead↔contact flag mirror) was NOT collateral damage",
    /export async function syncSuppressionState/.test(code("lib/kernel/suppression-sync.ts")),
    "a different job with its own live caller; deleting it would be 'deleting to move a number'")
}

// ═══ 3. RULING 3 — the public listing landing page ════════════════════════
console.log("\n═══ 3. app/actions/listing-landing.ts + app/listing/[slug]/page.tsx (ruling 3) ═══")
{
  const ACTION = "app/actions/listing-landing.ts"
  const PAGE = "app/listing/[slug]/page.tsx"
  const asrc = code(ACTION)
  const psrc = code(PAGE)
  check("both files were read", asrc.length > 500 && psrc.length > 500,
    "an empty read makes every assertion below vacuously true")

  checkWithMutation(
    "the brokerage id is a REQUIRED parameter — not optional, not defaulted",
    asrc,
    (s) => /getSimilarListings\(listingId: string, zip: string, brokerageId: string\)/.test(s) &&
           !/getSimilarListings\([^)]*brokerageId\?/.test(s) &&
           !/getSimilarListings\([^)]*brokerageId: string = /.test(s),
    ["brokerageId: string)", "brokerageId?: string)"],
    "an optional tenant parameter whose callers never pass it is indistinguishable from no tenancy at all — which is exactly how this shipped",
  )

  checkWithMutation(
    "the predicate is UNCONDITIONAL — tenantScope refuses a blank, applyTenantScope applies it",
    asrc,
    (s) => /tenantScope\(brokerageId, /.test(s) && /applyTenantScope\(query, scope\)/.test(s) &&
           !/if \(brokerageId\) \{[\s\S]{0,120}\.eq\("brokerage_id"/.test(s),
    ["applyTenantScope(query, scope)", "query"],
    "the `if (brokerageId)` shape would be back: the query runs either way and a blank id returns every brokerage's listings",
  )

  checkWithMutation(
    "the DTO surfaces the listing's tenant so the caller has something to pass",
    asrc,
    (s) => /brokerage_id: string \| null/.test(s) && /brokerage_id: \(listing\.brokerage_id as string \| null\) \?\? null/.test(s),
    ["brokerage_id: (listing.brokerage_id as string | null) ?? null", "// removed"],
    "the column was already being READ and then dropped, which is why the page had nothing to pass and the scope never applied",
  )

  checkWithMutation(
    "the ONE caller now passes the tenant",
    psrc,
    (s) => /getSimilarListings\(listing\.id, listing\.zip, listing\.brokerage_id\)/.test(s),
    ["getSimilarListings(listing.id, listing.zip, listing.brokerage_id)", "getSimilarListings(listing.id, listing.zip)"],
    "this is the defect verbatim: the caller that never passed the parameter",
  )

  checkWithMutation(
    "an untenanted listing renders NO similar listings — fail closed, never everyone's",
    psrc,
    (s) => /listing\.brokerage_id\s*\n?\s*\?\s*getSimilarListings\(/.test(s) && /Promise\.resolve\(\[\]\)/.test(s),
    ["Promise.resolve([])", "getSimilarListings(listing.id, listing.zip, \"\")"],
    "listings.brokerage_id is nullable; the falsy path must yield nothing rather than reaching the query with a blank tenant",
  )

  check("NEGATIVE CONTROL — the other readers in this file were not swept up",
    /export async function getListingBySlug/.test(asrc) &&
    /export async function getNeighborhoodData/.test(asrc) &&
    /export async function logLandingSession/.test(asrc),
    "a fix that quietly removed neighbouring exports would move the number without doing the work")
}

console.log("\n══════════════════════════════════════════════════════════════════")
console.log(`EXTERNAL-FEED TENANT — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFAILED:")
  for (const f of failures) console.log(`  - ${f}`)
  console.log(" ❌ EXTERNAL_FEED_TENANT_FAIL — a surface with no session guessed a tenant")
  process.exit(1)
}
console.log(" ✅ EXTERNAL_FEED_TENANT_PASS — identity first, tenant derived, ambiguity refused")
