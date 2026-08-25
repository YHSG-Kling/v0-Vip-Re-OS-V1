#!/usr/bin/env tsx
/**
 * scripts/stripe-account-scope-simulator.ts
 *   (npm run test:stripe-account-scope — pure, no DB, no network)
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE STRIPE ACCOUNT PER TENANT, ONE FOR THE PLATFORM, AND A REFUSAL WHEN THE
 * RIGHT ONE CANNOT BE NAMED.
 *
 * OWNER RULING (verbatim): "the stripe account will be per tenant and platform so
 * no configuration should be hardcoded."
 *
 * The previous wave concluded the opposite and wrote it down in five places at
 * once — lib/providers/tenancy-matrix.ts ("Never tenant-owned keys"),
 * ENV_CONFIGURATION.md, PRODUCTION-READINESS.md, lib/platform/launch-checklist.ts
 * and lib/platform/go-live-readiness.ts. That is what makes this worth a guard
 * rather than a comment: a single global `STRIPE_SECRET_KEY` is not a missing
 * feature, it is a MONEY DEFECT that looks exactly like success. A brokerage's
 * vendor bill charged on the product's Stripe account succeeds, returns a charge
 * id, renders a paid badge — and issues a receipt naming the wrong merchant,
 * refunds from the wrong balance, and books the amount on the wrong entity. No
 * screen in this app can tell the difference, and neither could a reviewer, which
 * is why the check is structural and mechanical.
 *
 * ── WHAT THIS PROOF STANDS OVER ─────────────────────────────────────────────
 *
 *   C1  THE RULE IS DATA, TOTAL, AND AGREES WITH THE MONEY DIRECTIONS ALREADY
 *       PINNED. `stripeAccountSideFor` is exhaustive over the party vocabulary,
 *       every path in STRIPE_MONEY_PATHS derives its side from its PAYEE, and the
 *       three vendor paths match lib/vendors/vendor-money-directions.ts
 *       payer-for-payer. A side asserted independently of that file would be a
 *       second spelling of the same ruling (CLAUDE.md §6).
 *
 *   C2  THE TENANT RESOLVER CANNOT REACH THE PLATFORM'S ACCOUNT. Asserted as
 *       CONTROL FLOW on comment-stripped source: inside
 *       `resolveTenantStripeAccount`, the `ownerType === "platform"` test must
 *       RETURN, never fall through — "descend to the platform on a miss" is the
 *       defect stated exactly. And that function body must contain no
 *       `process.env` read at all.
 *
 *   C3  THE PLATFORM RESOLVER CANNOT REACH A TENANT'S. Not asserted as a string:
 *       `resolvePlatformStripeAccount` calls the shared cascade with an EMPTY
 *       context, and this proof RUNS `scopeCascade({})` from
 *       lib/connections/scope.ts and requires the result to be exactly one owner,
 *       the platform. If someone later makes the cascade default to a tenant, the
 *       substitution becomes reachable and this goes red on behaviour rather than
 *       on wording.
 *
 *   C4  NOBODY ELSE READS THE PLATFORM'S ENV CREDENTIALS. Every file in the tree
 *       that reads one of the four Stripe env vars must be on a published roster,
 *       WITH a stated reason — and every roster entry must still read one, so the
 *       roster cannot rot into a list of files that stopped mattering. The count,
 *       its denominator and its exclusions are printed beside the verdict.
 *
 *   C5  BOTH WEBHOOK ENDPOINTS IDENTIFY THE SIGNER AND REFUSE ON EVERY BRANCH
 *       THAT IS NOT "verified". A webhook has no session, so the signing account
 *       is the only tenancy claim available; a route that accepted a tenant-signed
 *       event into the platform's ledger would let any tenant with a Stripe
 *       account move any other tenant's subscription row by writing an id into
 *       metadata — the IDOR shape CLAUDE.md §4 names, wearing a webhook.
 *
 *   C6  THE DATABASE CAN SAY "platform". Derived, not hardcoded: every value of
 *       `StripeOwnerScope` must be admitted by BOTH `platform_credentials.scope`
 *       and `platform_credentials.owner_type` in the generated vocabulary cache.
 *       m548 is what makes that true; asserting the RULE rather than the literal
 *       "platform" means a later scope gaining a tier fails here too.
 *
 * ── HOW THIS PROOF IS BUILT ─────────────────────────────────────────────────
 *   · Every structural assertion reads COMMENT-STRIPPED source via
 *     scripts/strip-comments.ts. This is not optional here: all four of the files
 *     under assertion quote the DEFECT in their own headers — resolve-stripe-
 *     account.ts explains at length what falling back to the platform would cost,
 *     and lib/stripe.ts spells out `process.env.STRIPE_SECRET_KEY` in prose. A
 *     prose-blind scan would pass on the defect and fail on the explanation, which
 *     is the exact failure five guards in this repo hit on 2026-08-23.
 *   · `blankStrings` is applied wherever a quoted literal could match — the
 *     refusal MESSAGES name the very env vars C4 hunts for.
 *   · Function bodies are sliced by walking the PARAMETER LIST to its closing
 *     paren FIRST. `resolveCallAccount(on: StripeCallScope)` resolves to a type
 *     containing `{ side: "platform" }`, so "first `{` after the name" lands
 *     inside the signature — the bug that produced four false failures here before.
 *   · Every absence assertion carries a NEGATIVE CONTROL: the defect is written
 *     into the real file, THE PATCH IS VERIFIED TO HAVE APPLIED (a find-string
 *     that silently stopped matching is theatre), the check is required to flip
 *     RED, and the file is restored and re-verified by sha256.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { walkTs } from "./runtime-roots"
import { resolve, join } from "node:path"
import { createHash } from "node:crypto"
import { readdirSync, statSync } from "node:fs"
import { stripComments, blankStrings } from "./strip-comments"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import {
  STRIPE_MONEY_PATHS,
  PLATFORM_ONLY_STRIPE_ENV,
  PLATFORM_WEBHOOK_ENV,
  STRIPE_WEBHOOK_ROUTES,
  STRIPE_WEBHOOK_CONFIG_KEYS,
  stripeAccountSideFor,
  stripeMoneyPath,
  webhookSecretFromConfig,
  connectDestinationReachable,
  MONEY_MOVING_STRIPE_CALLS,
  TENANT_MONEY_ON_PLATFORM_KEY,
  type StripeMoneyParty,
} from "../lib/billing/stripe-account-scope"
import { scopeCascade } from "../lib/connections/scope"
import { VENDOR_MONEY_PATHS } from "../lib/vendors/vendor-money-directions"

const ROOT = process.cwd()
const RUN_NEGATIVE = !process.argv.includes("--no-negative")

const F = {
  rule: "lib/billing/stripe-account-scope.ts",
  resolver: "lib/billing/resolve-stripe-account.ts",
  webhooks: "lib/billing/stripe-webhook-secrets.ts",
  seam: "lib/stripe.ts",
  payment: "lib/providers/payment/index.ts",
  vendorPayments: "app/actions/vendor-payments.ts",
  billingRoute: "app/api/billing/webhook/route.ts",
  vendorRoute: "app/api/webhooks/stripe/vendor/route.ts",
  tenancy: "lib/providers/tenancy-matrix.ts",
  checklist: "lib/platform/launch-checklist.ts",
  goLive: "lib/platform/go-live-readiness.ts",
  envDoc: "ENV_CONFIGURATION.md",
  prodDoc: "PRODUCTION-READINESS.md",
  migration:
    "supabase/migrations/m548-a-credential-scope-that-cannot-say-platform-forces-the-platforms-own-stripe-into-a-tenant-row.sql",
}

/**
 * THE ROSTER: every file allowed to read one of the four platform Stripe env
 * vars, and WHY. Anything else that reads one is the hardcoded configuration the
 * owner ruled out. Each entry must still read one — a roster that outlives its
 * readers is a permission nobody is using and a hole nobody is watching.
 */
const PLATFORM_ENV_READERS: Record<string, string> = {
  "lib/stripe.ts":
    "THE platform seam. Its whole job is to hand out the PLATFORM's client; STRIPE_SECRET_KEY is the platform's own credential of last resort behind the platform_credentials row.",
  "lib/billing/resolve-stripe-account.ts":
    "THE resolver. resolvePlatformStripeAccount reads env only after the platform-owned row is looked for; resolveTenantStripeAccount never reads env at all (asserted separately, C2).",
  "lib/billing/stripe-subscription-ops.ts":
    "isStripeConfigured — the platform write-through gate for tenant SUBSCRIPTIONS (money the platform is the payee on). Platform scope by construction.",
  "app/api/cron/stripe-drift/route.ts":
    "Weekly price-drift check on subscription_tiers.stripe_price_id — the platform's OWN price catalogue, on the platform's account.",
  "app/settings/billing/upgrade-modal.tsx":
    "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY for the tenant→PLATFORM subscription checkout. A tenant collecting its own money uses its own account's publishable key, never this one.",
}

/** Directories that are not product source. Published as the measurement's exclusions. */
const SCAN_EXCLUDED_DIRS = ["node_modules", ".next", ".git", "scripts", "supabase", "public", "docs", "plugins", ".claude"]

let pass = 0
let fail = 0
const failures: string[] = []
function check(label: string, ok: boolean) {
  if (ok) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}`) }
}

function raw(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8")
}
/** Source with comments removed — the ONLY thing a code-token scan may read. */
function code(rel: string): string {
  return stripComments(raw(rel))
}
/** Source with comments AND string literals removed — for scans a message could match. */
function codeNoStrings(rel: string): string {
  return blankStrings(stripComments(raw(rel)))
}

/**
 * Slice a function body out of stripped source, walking the PARAMETER LIST to its
 * closing paren before hunting for the opening brace. A parameter TYPE may contain
 * braces (`on: StripeCallScope` resolves to `{ side: "platform" } | …`, and inline
 * object types appear directly in several signatures here), so "first `{` after
 * the name" lands inside the signature and slices garbage.
 */
function functionBody(src: string, name: string): string | null {
  const at = src.indexOf(`function ${name}(`)
  if (at < 0) return null
  let i = src.indexOf("(", at)
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === "(") depth++
    else if (src[i] === ")") { depth--; if (depth === 0) { i++; break } }
  }
  const brace = src.indexOf("{", i)
  if (brace < 0) return null
  let d = 0
  for (let j = brace; j < src.length; j++) {
    if (src[j] === "{") d++
    else if (src[j] === "}") { d--; if (d === 0) return src.slice(brace, j + 1) }
  }
  return null
}

/**
 * Source between two markers. Used where a function's RETURN TYPE contains braces
 * (`Promise<{ status: "ok"; … } | { status: "unreadable"; … }>`), which defeats
 * brace-walking just as a braced PARAMETER type does — the same class of slicing
 * bug, one annotation further right.
 */
function regionBetween(src: string, startMarker: string, endMarker: string): string {
  const a = src.indexOf(startMarker)
  if (a < 0) return ""
  const b = src.indexOf(endMarker, a + startMarker.length)
  return b < 0 ? src.slice(a) : src.slice(a, b)
}

/**
 * The slice of `resolveTenantStripeAccount` that decides what happens when the
 * shared cascade lands on the PLATFORM tier. Both the assertion and its mutation
 * control read THIS, so they cannot disagree about where the branch is.
 */
function platformFallbackBranch(): string {
  const b = functionBody(code(F.resolver), "resolveTenantStripeAccount") ?? ""
  const at = b.search(/conn\.ownerType\s*===\s*"platform"/)
  return at < 0 ? "" : b.slice(at, at + 300)
}

/** Every .ts/.tsx file under product source, with the exclusions published above. */
function productSourceFiles(): string[] {
  // TOMBSTONE (orphan doctrine §1.1) — the private walker that stood here was one of
  // 82 copies of the same readdirSync walker. The survivor is
  // scripts/runtime-roots.ts:61 (`walkTs`), imported above. This one already walked
  // ROOT, so it was not blind to `proxy.ts`; it is DEDUPLICATED only, and every
  // exclusion below is this file's own, preserved so the corpus does not move.
  return walkTs(ROOT)
    .filter((p) => !p.slice(ROOT.length + 1).split("/").some((seg) => SCAN_EXCLUDED_DIRS.includes(seg)))
    .map((p) => p.slice(ROOT.length + 1))
    .sort()
}

/**
 * THE RESIDUAL FINDER — every MONEY-MOVING call made on the `stripe` proxy that
 * lib/stripe.ts exports (i.e. on the PLATFORM's key), across the files given.
 *
 * Reads COMMENT-STRIPPED source, without exception. lib/stripe.ts, this file and
 * app/actions/vendor-payments.ts all spell these call names out in prose — the
 * vendor-payments header is a tombstone naming where each repointed site went, and
 * it is meant to STAY. A raw-source scan would count those sentences as call sites
 * and accuse the repo of exactly what the tombstone records having fixed, which is
 * the failure five guards in this tree hit on 2026-08-23 (CLAUDE.md §2).
 *
 * A file that does not import the platform seam is skipped: `stripe.transfers` on
 * a locally-resolved tenant client would be a different (and correct) thing.
 */
function moneyMovingPlatformSeamCalls(files: string[]): Array<{ file: string; at: string }> {
  const hits: Array<{ file: string; at: string }> = []
  for (const rel of files) {
    let src: string
    try { src = code(rel) } catch { continue }
    if (!/(from|import\()\s*["']@\/lib\/stripe["']/.test(src)) continue
    for (const call of MONEY_MOVING_STRIPE_CALLS) {
      if (src.includes(`stripe.${call}(`)) hits.push({ file: rel, at: call })
    }
  }
  return hits
}

/** Which of the four env vars a file actually READS (process.env.X), prose and
 *  string literals excluded. */
function envReadsIn(rel: string): string[] {
  let src: string
  try { src = codeNoStrings(rel) } catch { return [] }
  return PLATFORM_ONLY_STRIPE_ENV.filter((n) => new RegExp(`process\\.env\\.${n}\\b`).test(src))
}

console.log("\n═══ C1 · the rule is data, total, and agrees with the pinned money directions ═══")
{
  const parties: StripeMoneyParty[] = ["platform", "brokerage", "team", "agent", "vendor", "contact"]
  check(
    "stripeAccountSideFor is exhaustive: platform → platform, every other party → tenant",
    parties.every((p) => stripeAccountSideFor(p) === (p === "platform" ? "platform" : "tenant")),
  )
  check(
    "every money path's side is DERIVED from its payee (no path states a side of its own)",
    STRIPE_MONEY_PATHS.every((p) => stripeAccountSideFor(p.payee) === (p.payee === "platform" ? "platform" : "tenant")),
  )
  check("path ids are unique and resolvable by id", new Set(STRIPE_MONEY_PATHS.map((p) => p.id)).size === STRIPE_MONEY_PATHS.length
    && STRIPE_MONEY_PATHS.every((p) => stripeMoneyPath(p.id)?.payee === p.payee))
  check("an unknown path id resolves to null rather than throwing (a caller that cannot name its path must be able to refuse)",
    stripeMoneyPath("no_such_path") === null)

  // The vendor directions were pinned as DATA two waves ago. Restating them here
  // independently would be a second spelling of one ruling; agreeing with them
  // mechanically is the point.
  const vendorAgreement = VENDOR_MONEY_PATHS.map((v) => {
    const mine = stripeMoneyPath(v.id)
    return { id: v.id, ok: !!mine && mine.payer === v.payer && mine.payee === v.payee }
  })
  check(
    `all ${VENDOR_MONEY_PATHS.length} vendor money paths agree payer-for-payer with vendor-money-directions.ts (${vendorAgreement.filter((v) => v.ok).length}/${vendorAgreement.length})`,
    vendorAgreement.every((v) => v.ok),
  )
  check(
    "the vendor PLATFORM tier is on the platform's account and the vendor PACKAGE is on the brokerage's — the two are opposite and must not collapse",
    stripeAccountSideFor(stripeMoneyPath("vendor_platform_tier")!.payee) === "platform"
      && stripeAccountSideFor(stripeMoneyPath("vendor_package")!.payee) === "tenant",
  )
  check(
    "the tenant SaaS subscription is on the PLATFORM's account (the tenant is the payer, not the payee — reading the direction off the payer inverts exactly this path)",
    stripeAccountSideFor(stripeMoneyPath("tenant_saas_subscription")!.payee) === "platform",
  )
  check("webhookSecretFromConfig rejects blanks and unknown keys, and reads each endpoint's own key",
    webhookSecretFromConfig({ webhook_secret: "  " }) === null
    && webhookSecretFromConfig({ nonsense: "whsec_x" }) === null
    && webhookSecretFromConfig({ webhook_secret: "whsec_a" }) === "whsec_a"
    && webhookSecretFromConfig({ vendor_webhook_secret: "whsec_v" }, "vendor_marketplace") === "whsec_v"
    && webhookSecretFromConfig({ webhook_secret: "whsec_a" }, "vendor_marketplace") === null)
  check("the two endpoints' config keys are disjoint — one endpoint's secret can never verify the other's deliveries",
    STRIPE_WEBHOOK_CONFIG_KEYS.tenant_billing.every((k) => !STRIPE_WEBHOOK_CONFIG_KEYS.vendor_marketplace.includes(k)))
  check("every webhook route named in the rule module exists on disk",
    Object.values(STRIPE_WEBHOOK_ROUTES).every((r) => {
      try { statSync(resolve(ROOT, `app${r}/route.ts`)); return true } catch { return false }
    }))
}

console.log("\n═══ C2 · the tenant resolver cannot reach the platform's account ═══")
{
  const src = code(F.resolver)
  const body = functionBody(src, "resolveTenantStripeAccount")
  check("resolveTenantStripeAccount body is sliceable (parameter-list walk, not first-brace)", !!body)
  const b = body ?? ""
  check(
    'it tests for a platform-owned resolution: ownerType === "platform"',
    /conn\.ownerType\s*===\s*"platform"/.test(b),
  )
  // CONTROL FLOW, not wording: the first control keyword after the platform test
  // must be `return`. `continue`/fall-through is the defect stated exactly.
  const after = platformFallbackBranch()
  check(
    "…and it RETURNS on that test rather than descending (first control keyword after it is `return`)",
    /^[\s\S]{0,200}?\breturn\b/.test(after) && !/^[\s\S]{0,200}?\b(continue|break)\b/.test(after),
  )
  check(
    "the returned status is a refusal (`missing`) and the branch does NOT reach for the platform's account",
    /status:\s*"missing"/.test(after) && !/resolvePlatformStripeAccount/.test(after),
  )
  check(
    "resolveTenantStripeAccount reads NO process.env at all — a tenant never falls back to an environment variable",
    !/process\.env/.test(b),
  )
  check(
    "it refuses when there is no tenant in context, instead of treating that as a platform call",
    /!ctx\.brokerageId/.test(b) && /status:\s*"missing"/.test(b),
  )
  check(
    "an unreadable tier is a refusal, distinct from a missing credential",
    /status\s*===\s*"unreadable"/.test(b) && /status:\s*"unreadable"/.test(b),
  )
  check(
    "vendor/contact owners are refused as merchants (they are billed, they do not hold the account)",
    /asStripeOwnerScope/.test(b),
  )
  // The `connect` shape must send Stripe-Account, or the platform's key debits the
  // platform. Asserted where the header is actually attached.
  const pay = codeNoStrings(F.payment)
  check(
    "lib/providers/payment attaches Stripe-Account for connect-mode tenants on BOTH money-moving calls",
    (pay.match(/mode\s*===\s*"connect"\s*&&\s*connectedAccountId\s*\?\s*\{\s*stripeAccount/g) ?? []).length >= 2
      || (code(F.payment).match(/mode === "connect" && connectedAccountId \? \{ stripeAccount/g) ?? []).length >= 2,
  )
  check(
    "createTransfer and createPaymentIntent REQUIRE a call scope (no default — a default is how the wrong account gets picked silently)",
    /createTransfer\(\s*params:\s*CreateTransferParams,\s*on:\s*StripeCallScope\s*\)/.test(code(F.payment))
      && /createPaymentIntent\(\s*[\s\S]{0,120}?on:\s*StripeCallScope,?\s*\)/.test(code(F.payment)),
  )
}

console.log("\n═══ C3 · the platform resolver cannot reach a tenant's account ═══")
{
  const src = code(F.resolver)
  const body = functionBody(src, "resolvePlatformStripeAccount") ?? ""
  check("resolvePlatformStripeAccount calls the shared cascade with an EMPTY context",
    /resolveScopedConnectionResult\("stripe",\s*\{\s*\}\)/.test(body))
  // BEHAVIOURAL, not textual: run the cascade the resolver hands that context to.
  const cascade = scopeCascade({})
  check("…and scopeCascade({}) really is exactly one owner, the platform — so a tenant tier is unreachable, not merely unvisited",
    cascade.length === 1 && cascade[0].ownerType === "platform")
  const tenantCascade = scopeCascade({ agentUserId: "a", teamId: "t", brokerageId: "b" })
  check("the same cascade with a tenant context ends at the platform — which is exactly why the tenant resolver must reject that last tier (C2)",
    tenantCascade[tenantCascade.length - 1].ownerType === "platform" && tenantCascade.length === 4)
  check("a non-platform resolution on the platform path is refused rather than used",
    /conn\.ownerType\s*!==\s*"platform"/.test(body) && /status:\s*"unreadable"/.test(body))
  check("an unreadable platform tier does NOT fall through to the env key (a stale env var may name a different account)",
    /status\s*===\s*"unreadable"/.test(body) && !/unreadable[\s\S]{0,120}process\.env/.test(body))
  check("the platform seam prefers the resolver over the env var (getPlatformStripe exists and calls it)",
    /export async function getPlatformStripe/.test(code(F.seam))
    && /resolvePlatformStripeAccount\(\)/.test(code(F.seam)))
}

console.log("\n═══ C4 · nobody else reads the platform's env credentials ═══")
{
  const files = productSourceFiles()
  const readers = files.filter((f) => envReadsIn(f).length > 0)
  const offRoster = readers.filter((f) => !(f in PLATFORM_ENV_READERS))
  const rosterWithoutReads = Object.keys(PLATFORM_ENV_READERS).filter((f) => envReadsIn(f).length === 0)

  console.log(`    scanned ${files.length} .ts/.tsx files under ${ROOT}`)
  console.log(`    excluded dirs: ${SCAN_EXCLUDED_DIRS.join(", ")} (scripts/ excluded because simulators SET these vars to exercise refusal paths)`)
  console.log(`    env names hunted: ${PLATFORM_ONLY_STRIPE_ENV.join(", ")}`)
  console.log(`    readers found: ${readers.length} — ${readers.map((f) => `${f} [${envReadsIn(f).join("+")}]`).join(" · ") || "none"}`)

  check(`every env reader is on the published platform roster (off-roster: ${offRoster.length}${offRoster.length ? " → " + offRoster.join(", ") : ""})`,
    offRoster.length === 0)
  check(`every roster entry still reads one (stale permissions: ${rosterWithoutReads.length}${rosterWithoutReads.length ? " → " + rosterWithoutReads.join(", ") : ""})`,
    rosterWithoutReads.length === 0)
  check("every roster entry carries a stated reason", Object.values(PLATFORM_ENV_READERS).every((why) => why.length > 40))
  check("neither webhook route reads a hardcoded signing secret any more",
    envReadsIn(F.billingRoute).length === 0 && envReadsIn(F.vendorRoute).length === 0)
  check("lib/providers/payment reads no env credential — it resolves per call scope",
    envReadsIn(F.payment).length === 0)

  // POSITIVE CONTROL for the finder itself. A broken regex and a clean tree both
  // report zero; this proves the scan still recognises what it was written for.
  const decoy = "lib/billing/stripe-account-scope.ts"
  const decoySrc = raw(decoy)
  const decoySha = createHash("sha256").update(decoySrc).digest("hex")
  writeFileSync(resolve(ROOT, decoy), decoySrc + "\nexport const __probe = process.env.STRIPE_SECRET_KEY\n")
  const sawDecoy = envReadsIn(decoy).includes("STRIPE_SECRET_KEY")
  writeFileSync(resolve(ROOT, decoy), decoySrc)
  const restoredOk = createHash("sha256").update(readFileSync(resolve(ROOT, decoy), "utf8")).digest("hex") === decoySha
  check("POSITIVE CONTROL — the env-reader finder detects an injected process.env.STRIPE_SECRET_KEY", sawDecoy)
  check("POSITIVE CONTROL — and the probe file was restored byte-identically", restoredOk)
}

console.log("\n═══ C5 · both webhook endpoints identify the signer and refuse otherwise ═══")
{
  for (const [label, rel] of [["tenant billing", F.billingRoute], ["vendor marketplace", F.vendorRoute]] as const) {
    const src = code(rel)
    check(`${label}: verifies through the shared per-account verifier`, /verifyStripeWebhook\(/.test(src))
    check(`${label}: does not construct events against a single hardcoded secret`,
      !/constructEvent\(/.test(src))
    check(`${label}: refuses when no signing secret exists at all (no_candidates)`, /"no_candidates"/.test(src))
    check(`${label}: refuses — and does not blame the sender — when the roster is unreadable (503)`,
      /"unreadable"/.test(src) && /503/.test(src))
    check(`${label}: refuses an unverified signature (400)`, /"unverified"/.test(src) && /400/.test(src))
    check(`${label}: refuses a TENANT-signed delivery for the platform's ledger`,
      /verification\.ownerType\s*!==\s*"platform"/.test(src))
    check(`${label}: names the refusal rather than answering an empty ok`, /applied:\s*false/.test(src))
    // CONTROL FLOW: the tenant-signed test must RETURN before any handler runs.
    const at = src.search(/verification\.ownerType\s*!==\s*"platform"/)
    const after = at >= 0 ? src.slice(at, at + 700) : ""
    check(`${label}: …and RETURNS on that test rather than continuing into the handlers`,
      /return\s+NextResponse/.test(after))
  }
  const wh = code(F.webhooks)
  // Sliced by MARKERS, not by braces: this function's return type is a union of
  // object types, so a brace-walk lands inside the annotation. And the import
  // block above lists both names, so an indexOf over the whole file would compare
  // import order rather than call order.
  const candidateFn = regionBetween(wh, "export async function stripeWebhookCandidates", "export async function verifyStripeWebhook")
  check("the verifier tries the PLATFORM's secret first, then tenants — the common path is one HMAC",
    candidateFn.length > 200
    && candidateFn.indexOf("resolvePlatformStripeAccount") >= 0
    && candidateFn.indexOf("resolvePlatformStripeAccount") < candidateFn.indexOf("readTenantStripeWebhookCredentials"))
  check("a delivery is attributed to the account whose secret VERIFIED it, not to anything in the payload",
    /status:\s*"verified"[\s\S]{0,300}ownerType:\s*candidate\.ownerType/.test(wh))
  check("an unreadable candidate roster is reported as unreadable, never as an empty roster",
    /roster\.status\s*===\s*"unreadable"/.test(wh))
  check("the tenant roster cap is published in the refusal when it is hit",
    /tenantRosterCapped/.test(wh) && /TENANT_WEBHOOK_CANDIDATE_LIMIT/.test(wh))
  check("the verifier's placeholder key is never sent to Stripe (constructEvent is pure crypto, and the client is not built from the platform key)",
    /VERIFIER_KEY_IS_UNUSED/.test(wh) && !/process\.env/.test(wh))
  check("both endpoints' platform env names are declared in the rule module rather than typed at the route",
    PLATFORM_WEBHOOK_ENV.tenant_billing === "STRIPE_WEBHOOK_SECRET"
    && PLATFORM_WEBHOOK_ENV.vendor_marketplace === "STRIPE_VENDOR_WEBHOOK_SECRET")
}

console.log("\n═══ C6 · the database can name every scope a Stripe account resolves at ═══")
{
  // DERIVED, not hardcoded (CLAUDE.md §2 — do not pin an assertion to a waypoint).
  // The rule: every owner scope the resolver can return must be spellable in BOTH
  // owner-label columns. m548 is what makes `scope` satisfy it.
  const scopes = ["platform", "brokerage", "team", "agent"]
  const vocab = CHECK_VOCABULARIES.platform_credentials ?? {}
  const scopeVocab = vocab.scope ?? []
  const ownerVocab = vocab.owner_type ?? []
  check(`platform_credentials.scope admits every StripeOwnerScope (${scopeVocab.join("|") || "—"})`,
    scopes.every((s) => scopeVocab.includes(s)))
  check(`platform_credentials.owner_type admits every StripeOwnerScope (${ownerVocab.join("|") || "—"})`,
    scopes.every((s) => ownerVocab.includes(s)))
  check("platform_credentials.platform admits 'stripe' — the credential can exist at all",
    (vocab.platform ?? []).includes("stripe"))
  check("m548 exists and widens the scope CHECK rather than narrowing it",
    /ADD CONSTRAINT platform_credentials_scope_check/.test(raw(F.migration))
    && /'platform'::text/.test(raw(F.migration))
    && ["brokerage", "team", "agent"].every((s) => new RegExp(`'${s}'::text`).test(raw(F.migration))))
}

console.log("\n═══ C7 · the replaced architecture is corrected wherever it was written down ═══")
{
  // The previous wave's conclusion lived in five places. A guard that fixed the
  // code and left the go-live board green on the old story would be worse than
  // no guard: an operator reads the board, not the resolver.
  const tenancy = raw(F.tenancy)
  check("tenancy-matrix no longer claims Stripe is never tenant-owned", !/Never tenant-owned keys/.test(tenancy))
  check("tenancy-matrix's stripe row names both sides", /provider: "stripe"[\s\S]{0,3000}?PER TENANT/.test(tenancy))
  const checklist = raw(F.checklist)
  check("launch checklist scopes its Stripe rows to the PLATFORM's account",
    /capability: "Stripe billing — the PLATFORM's own account/.test(checklist))
  const goLive = raw(F.goLive)
  check("go-live board reports the TENANT half as its own row (it had none — which is how 'Stripe: ready' meant the platform key alone)",
    /stripe_tenant_accounts/.test(goLive))
  check("go-live's tenant row reads the error before the rows (an unreadable store must not render as 'no tenants connected')",
    /if \(error\) return r\("broken"/.test(code(F.goLive)))
  for (const [label, rel] of [["ENV_CONFIGURATION.md", F.envDoc], ["PRODUCTION-READINESS.md", F.prodDoc]] as const) {
    const doc = raw(rel)
    check(`${label} quotes the owner ruling verbatim`, /the stripe account will be per tenant and platform so\s*\n?\s*no configuration should be hardcoded/.test(doc.replace(/\s+/g, " ").replace(/(.{0,0})/, "$1")) || /per tenant and platform so no configuration should be hardcoded/.test(doc.replace(/\s+/g, " ")))
    check(`${label} says the env vars are PLATFORM scope only`, /PLATFORM/.test(doc) && /platform_credentials/.test(doc))
  }
}

console.log("\n═══ C8 · the platform key moves no tenant money — DERIVED, not declared ═══")
{
  // OWNER RULING (verbatim): "no sites should move tenant money on the platform key."
  //
  // THE COUNT THAT MOVES: 2 → 0. Both entries TENANT_MONEY_ON_PLATFORM_KEY carried
  // were repointed at lib/providers/payment (createTransfer / createCheckoutSession
  // / retrieveCheckoutSession), which resolve per call scope and refuse rather than
  // substitute the platform's account. The list is empty; the MECHANISM is not —
  // deleting the finder to move the number is the §1 failure this block exists to
  // make impossible.
  //
  // So the residual set is DERIVED here rather than read. lib/stripe.ts hands out
  // the PLATFORM's client; this scans every importer's comment-stripped source for
  // the calls that MOVE MONEY and requires each hit to be either
  //   · in a file the roster classifies `platform_payee` (the platform really is
  //     the merchant — a subscription checkout, a refund of one), or
  //   · declared in TENANT_MONEY_ON_PLATFORM_KEY as a known-wrong residual.
  // Anything else is a new tenant-money site on the platform key, and it fails here.
  //
  // `connect_admin` is the third classification and the strictest: a file that may
  // import the platform seam ONLY to administer the Connect platform (mint an
  // acct_…, issue an onboarding link, read one back). Those move nothing, so ANY
  // money-moving call in such a file is a violation whether or not it is declared.
  type ImporterKind = "platform_payee" | "connect_admin"
  const PLATFORM_CLIENT_IMPORTERS: Record<string, { kind: ImporterKind; why: string }> = {
    "app/api/billing/webhook/route.ts": { kind: "platform_payee",
      why: "The platform's billing ledger; uses getPlatformStripe() and refuses tenant-signed deliveries." },
    "app/actions/vendor-billing.ts": { kind: "platform_payee",
      why: "VENDOR_PLATFORM_TIER — the vendor pays the PLATFORM for its marketplace tier. Correct account, legacy source (the sync env proxy rather than the resolver)." },
    "app/actions/admin/create-subscriber.ts": { kind: "platform_payee",
      why: "Provisions a tenant's subscription customer on the platform's account. Correct account, legacy source." },
    "app/actions/billing.ts": { kind: "platform_payee",
      why: "tenant_saas_subscription — a brokerage's checkout for its own plan. The platform is the merchant." },
    "lib/billing/stripe-portal.ts": { kind: "platform_payee",
      why: "The billing portal a tenant manages its PLATFORM subscription in — the portal belongs to the account that holds the customer." },
    "lib/billing/stripe-subscription-ops.ts": { kind: "platform_payee",
      why: "Cancel / resume / reprice / extend-trial / refund on the platform's own subscriptions." },
    "lib/billing/ai-overage.ts": { kind: "platform_payee",
      why: "tenant_ai_overage — CLAUDE.md §5, AI is platform-covered with per-tier overage. Platform revenue, platform account." },
    "app/actions/superadmin/plan-catalog.ts": { kind: "platform_payee",
      why: "Publishes subscription_tiers prices to Stripe — the platform's OWN price catalogue." },
    "app/actions/superadmin/coupons.ts": { kind: "platform_payee",
      why: "Platform discounts against platform prices." },
    "app/api/cron/stripe-drift/route.ts": { kind: "platform_payee",
      why: "Weekly drift check on the platform's own tier prices." },
    "app/actions/vendor-payments.ts": { kind: "connect_admin",
      why: "CONNECT-PLATFORM ADMIN ONLY — accounts.create / accountLinks.create / accounts.retrieve. An acct_… is minted on the Connect platform that will own it and this product has exactly one; none of the three moves a cent. Its money paths (vendor payout, portal checkout) go through lib/providers/payment on the TENANT's account." },
  }
  const importers = productSourceFiles().filter((f) => {
    let src = ""
    try { src = code(f) } catch { return false }
    return /(from|import\()\s*["']@\/lib\/stripe["']/.test(src)
  })
  console.log(`    importers of lib/stripe.ts (the PLATFORM client): ${importers.length} — ${importers.join(" · ")}`)
  const unknown = importers.filter((f) => !(f in PLATFORM_CLIENT_IMPORTERS))
  const stale = Object.keys(PLATFORM_CLIENT_IMPORTERS).filter((f) => !importers.includes(f))
  check(`every importer of the platform client is on the roster (unknown: ${unknown.length}${unknown.length ? " → " + unknown.join(", ") : ""})`, unknown.length === 0)
  check(`the roster carries no entry that stopped importing (stale: ${stale.length}${stale.length ? " → " + stale.join(", ") : ""})`, stale.length === 0)
  check("every roster entry carries a stated reason", Object.values(PLATFORM_CLIENT_IMPORTERS).every((e) => e.why.length > 40))

  // THE FINDER. Comments stripped — this very file, lib/stripe.ts and
  // vendor-payments.ts all NAME these calls in prose describing the defect, and a
  // prose-blind scan would accuse the explanations and miss the code.
  const found = moneyMovingPlatformSeamCalls(importers)
  console.log(`    money-moving calls hunted: ${MONEY_MOVING_STRIPE_CALLS.join(", ")}`)
  console.log(`    money-moving calls ON the platform seam: ${found.length} — ${found.map((h) => `${h.file}::${h.at}`).join(" · ") || "none"}`)

  const undeclared = found.filter((h) => {
    const entry = PLATFORM_CLIENT_IMPORTERS[h.file]
    if (entry?.kind === "platform_payee") return false
    return !TENANT_MONEY_ON_PLATFORM_KEY.some((r) => r.file === h.file && r.at.includes(h.at))
  })
  check(
    `every money-moving call on the platform seam is either a platform-payee path or a DECLARED residual (undeclared: ${undeclared.length}${undeclared.length ? " → " + undeclared.map((h) => `${h.file}::${h.at}`).join(", ") : ""})`,
    undeclared.length === 0,
  )
  const connectAdminViolations = found.filter((h) => PLATFORM_CLIENT_IMPORTERS[h.file]?.kind === "connect_admin")
  check(
    `no file classified connect_admin moves money on the platform seam (violations: ${connectAdminViolations.length}${connectAdminViolations.length ? " → " + connectAdminViolations.map((h) => `${h.file}::${h.at}`).join(", ") : ""})`,
    connectAdminViolations.length === 0,
  )
  // The list may be EMPTY — that is the goal state — but it may not be STALE. A
  // declaration with no matching call site is a residual someone fixed without
  // deleting the paperwork, and it would keep a red flag flying over clean code.
  const staleResiduals = TENANT_MONEY_ON_PLATFORM_KEY.filter(
    (r) => !found.some((h) => h.file === r.file && r.at.includes(h.at)),
  )
  check(
    `every declared residual still matches a real call site (stale declarations: ${staleResiduals.length}${staleResiduals.length ? " → " + staleResiduals.map((r) => `${r.file}::${r.at}`).join(", ") : ""})`,
    staleResiduals.length === 0,
  )
  check("every declared residual names a real money path and a real importer",
    TENANT_MONEY_ON_PLATFORM_KEY.every((r) => stripeMoneyPath(r.pathId) !== null && importers.includes(r.file)))
  check("every declared residual is a TENANT-side path — a platform-payee path on the platform key is not a residual, it is correct",
    TENANT_MONEY_ON_PLATFORM_KEY.every((r) => stripeAccountSideFor(stripeMoneyPath(r.pathId)!.payee) === "tenant"))

  // POSITIVE CONTROL for the finder. "0 residuals" and "the regex broke" print the
  // same number, so the defect is written into the real file and the finder is
  // required to see it. The file restored is checked by sha256.
  const probeFile = "app/actions/vendor-payments.ts"
  const probeSrc = raw(probeFile)
  const probeSha = createHash("sha256").update(probeSrc).digest("hex")
  writeFileSync(
    resolve(ROOT, probeFile),
    probeSrc + "\nasync function __probeTenantMoney() { await stripe.transfers.create({ amount: 1 } as never) }\n",
  )
  const probeFound = moneyMovingPlatformSeamCalls([probeFile])
  writeFileSync(resolve(ROOT, probeFile), probeSrc)
  const probeRestored = createHash("sha256").update(readFileSync(resolve(ROOT, probeFile), "utf8")).digest("hex") === probeSha
  check("POSITIVE CONTROL — the residual finder detects an injected stripe.transfers.create() on the platform seam",
    probeFound.some((h) => h.file === probeFile && h.at === "transfers.create"))
  check("POSITIVE CONTROL — and the probe file was restored byte-identically", probeRestored)

  console.log(`    residual tenant-money call sites still on the platform key: ${TENANT_MONEY_ON_PLATFORM_KEY.length}${TENANT_MONEY_ON_PLATFORM_KEY.length ? " (in " + [...new Set(TENANT_MONEY_ON_PLATFORM_KEY.map((r) => r.file))].join(", ") + ")" : " — the owner ruling is met"}`)
}

console.log("\n═══ C9 · the two repointed sites resolve the TENANT from the SESSION, and fail closed ═══")
{
  const pay = code(F.vendorPayments)

  // Both money paths call the scope-carrying survivors, not the platform seam.
  check("initiateVendorPayout pays through createTransfer on the TENANT's account",
    /createTransfer\(\s*\{[\s\S]{0,600}?\},\s*\{\s*side:\s*"tenant",\s*brokerageId:\s*ctx\.brokerageId\s*\}/.test(pay))
  check("startVendorInvoiceCheckout collects through createCheckoutSession on the TENANT's account",
    /createCheckoutSession\(\s*\{[\s\S]{0,1400}?\},\s*\{\s*side:\s*"tenant",\s*brokerageId:\s*sessionBrokerageId\s*\}/.test(pay))
  check("confirmVendorInvoiceCheckout reads the session back on the SAME account it was created on",
    /retrieveCheckoutSession\(\s*params\.sessionId,\s*\{\s*side:\s*"tenant",\s*brokerageId:\s*sessionBrokerageId,?\s*\}/.test(pay))
  check("neither site passes { side: \"platform\" } anywhere in this file",
    !/side:\s*"platform"/.test(pay))

  // THE TENANT COMES FROM THE SESSION (CLAUDE.md §4). On the staff side that is
  // resolveWriteContext(); on the portal side it is the contact row
  // verifyContactCaller matched against the signed-in user. Neither is a parameter.
  check("the payout's brokerage is the session's (ctx.brokerageId from resolveWriteContext), never a parameter",
    /const ctx = await resolveWriteContext\(\)/.test(pay) && !/brokerageId:\s*params\./.test(pay))
  check("the portal's brokerage is the SESSION-VERIFIED contact's, not the invoice's own claim",
    /const sessionBrokerageId = gate\.contact\.brokerage_id/.test(pay))
  check("…and the invoice's brokerage is CHECKED against it rather than trusted (an invoice id must not select a bank account)",
    (pay.match(/invoice\.brokerage_id\s*!==\s*sessionBrokerageId/g) ?? []).length >= 2)

  // FAIL CLOSED, and legibly: the refusal is returned as `error`, which both
  // client components render verbatim. `platform_credentials` holds 0 rows live, so
  // this is the branch that actually runs today.
  check("a refused payout returns the resolver's sentence and writes NO vendor_payouts row",
    /if \(!transfer\.success \|\| !transfer\.transferId\) \{[\s\S]{0,400}?return \{ success: false, error: transfer\.error/.test(pay))
  check("a refused checkout returns the resolver's sentence rather than a redirect",
    /if \(!checkout\.success \|\| !checkout\.url\) \{[\s\S]{0,200}?return \{ success: false, error: checkout\.error/.test(pay))
  check("a refused session read is reported, not read past (an unreadable session must not settle an invoice)",
    /if \(!session\.success\) \{[\s\S]{0,200}?return \{ success: false, error: session\.error/.test(pay))
  for (const [label, rel, needle] of [
    ["payout button", "app/vendor/earnings/payout-button.tsx", /res\.error/],
    ["portal pay button", "app/portal/[contactId]/invoices/pay-invoice-button.tsx", /res\.error/],
  ] as const) {
    check(`${label} renders the refusal sentence to the operator rather than swallowing it`, needle.test(code(rel)))
  }

  // mode: "connect" — the header AND the destination. Omitting the header sends the
  // platform's key with no address and debits the PLATFORM; omitting the destination
  // settles into the payer's own balance instead of the payee's.
  const payment = code(F.payment)
  check("all three tenant-money calls attach Stripe-Account when the resolved mode is connect",
    (payment.match(/mode === "connect" && connectedAccountId \? \{ stripeAccount/g) ?? []).length >= 4)
  // The destination key is a STRING literal (the gateway's form bodies are flat,
  // pre-flattened maps), so this reads comment-stripped source WITH strings intact —
  // blankStrings would erase the very token being asserted.
  check("createCheckoutSession sends a DESTINATION so the funds land on the payee, not the payer",
    payment.includes("payment_intent_data[transfer_data][destination]"))
  check("createTransfer and createCheckoutSession both REQUIRE a call scope (no default)",
    /createTransfer\(\s*params:\s*CreateTransferParams,\s*on:\s*StripeCallScope\s*\)/.test(payment)
      && /createCheckoutSession\(\s*[\s\S]{0,120}?on:\s*StripeCallScope,?\s*\)/.test(payment)
      && /retrieveCheckoutSession\(\s*[\s\S]{0,120}?on:\s*StripeCallScope,?\s*\)/.test(payment))

  // THE CONNECT TOPOLOGY RULE, run rather than read.
  check("connectDestinationReachable: a connect-mode payer can address a sibling acct_… under the same platform",
    connectDestinationReachable({ payerMode: "connect", payerLabel: "brokerage b", destinationAccountId: "acct_v" }).ok === true)
  const direct = connectDestinationReachable({ payerMode: "direct", payerLabel: "brokerage b", destinationAccountId: "acct_v" })
  check("…and a direct-mode payer (its own Stripe account, its own Connect platform) CANNOT, and the refusal names both parties",
    direct.ok === false && direct.reason.includes("brokerage b") && direct.reason.includes("acct_v"))
  check("the rule is applied at the money calls, not just exported",
    /destinationRefusal\(resolved\.account, params\.destinationAccountId\)/.test(payment)
      && (payment.match(/if \(unreachable\) return \{ success: false, error: unreachable \}/g) ?? []).length >= 2)

  // THE PREMISE that rule stands on: every acct_… in this product is minted under
  // the PLATFORM's Connect platform, so a direct-mode tenant is provably foreign to
  // it. That is a fact about the CODE — asserted here rather than stored as a column
  // with one possible value (CLAUDE.md §1).
  const minters = productSourceFiles().filter((f) => {
    let src = ""
    try { src = code(f) } catch { return false }
    return /stripe\.accounts\.create\(/.test(src) || /"v1\/accounts"/.test(src)
  })
  console.log(`    Connect-account minting sites: ${minters.length} — ${minters.join(" · ")}`)
  check(`every Connect-account minter resolves the PLATFORM account (${minters.length} found)`,
    minters.length > 0 && minters.every((f) => {
      const src = code(f)
      // Either the platform seam (lib/stripe.ts) or an explicit { side: "platform" }.
      return /(from|import\()\s*["']@\/lib\/stripe["']/.test(src) || /resolveCallAccount\(\{\s*side:\s*"platform"\s*\}\)/.test(src)
    }))
}

// ─── NEGATIVE CONTROLS ───────────────────────────────────────────────────────
// Each writes the DEFECT into the real file, VERIFIES THE PATCH APPLIED, requires
// the corresponding check to flip red, then restores and re-verifies by sha256.
// A control whose find-string silently stopped matching proves nothing, so the
// application is asserted before the flip is measured.
if (RUN_NEGATIVE) {
  console.log("\n═══ NEGATIVE CONTROLS (mutation) ═══")
  const mutate = (
    label: string,
    rel: string,
    find: string,
    replaceWith: string,
    stillRed: () => boolean,
  ) => {
    const path = resolve(ROOT, rel)
    const before = readFileSync(path, "utf8")
    const sha = createHash("sha256").update(before).digest("hex")
    const applied = before.includes(find)
    if (!applied) {
      check(`${label} — PATCH DID NOT APPLY (find-string no longer present; control is theatre until fixed)`, false)
      return
    }
    writeFileSync(path, before.replace(find, replaceWith))
    let wentRed = false
    try { wentRed = stillRed() } finally { writeFileSync(path, before) }
    const restored = createHash("sha256").update(readFileSync(path, "utf8")).digest("hex") === sha
    check(`${label} — the check goes RED with the defect present`, wentRed)
    check(`${label} — file restored byte-identically`, restored)
  }

  // THE MUTATION THE OWNER RULING IS ABOUT: make the tenant resolver fall back to
  // the platform's account instead of refusing.
  mutate(
    "tenant resolver falls back to the PLATFORM account",
    F.resolver,
    `  if (conn.ownerType === "platform") {
    return {
      status: "missing",
      side: "tenant",
      message: tenantMissingMessage(ctx.brokerageId),
    }
  }`,
    `  if (conn.ownerType === "platform") {
    return await resolvePlatformStripeAccount(endpoint)
  }`,
    () => {
      const branch = platformFallbackBranch()
      return !/status:\s*"missing"/.test(branch) || /resolvePlatformStripeAccount/.test(branch)
    },
  )

  // THE SECOND HALF: make the tenant resolver read the platform's env var.
  mutate(
    "tenant resolver reads process.env",
    F.resolver,
    `  if (!ctx.brokerageId) {`,
    `  if (!ctx.brokerageId && !process.env.STRIPE_SECRET_KEY) {`,
    () => {
      const b = functionBody(code(F.resolver), "resolveTenantStripeAccount") ?? ""
      return /process\.env/.test(b)
    },
  )

  // THE PLATFORM HALF: give the platform resolver a tenant context.
  mutate(
    "platform resolver walks a TENANT cascade",
    F.resolver,
    `resolveScopedConnectionResult("stripe", {})`,
    `resolveScopedConnectionResult("stripe", { brokerageId: process.env.ANY_TENANT ?? null })`,
    () => {
      const b = functionBody(code(F.resolver), "resolvePlatformStripeAccount") ?? ""
      return !/resolveScopedConnectionResult\("stripe",\s*\{\s*\}\)/.test(b)
    },
  )

  // THE WEBHOOK HALF: accept a tenant-signed delivery into the platform's ledger.
  mutate(
    "billing webhook accepts a tenant-signed delivery",
    F.billingRoute,
    `  if (verification.ownerType !== "platform") {`,
    `  if (verification.ownerType === "no_such_scope") {`,
    () => !/verification\.ownerType\s*!==\s*"platform"/.test(code(F.billingRoute)),
  )

  // THE ROSTER: an off-roster file reading the platform's key must be caught.
  mutate(
    "an off-roster file reads the platform key",
    F.webhooks,
    `const VERIFIER_KEY_IS_UNUSED = "sk_signature_verification_only_never_sent_to_stripe"`,
    `const VERIFIER_KEY_IS_UNUSED = process.env.STRIPE_SECRET_KEY ?? "x"`,
    () => envReadsIn(F.webhooks).length > 0 && !(F.webhooks in PLATFORM_ENV_READERS),
  )

  // ── THE TWO SITES THE OWNER RULED ON ────────────────────────────────────────
  // "no sites should move tenant money on the platform key." Each of these puts
  // ONE of them back on the platform's key, as it stood before this lane, and
  // requires the residual finder to see it. If the finder ever stops seeing them,
  // an empty TENANT_MONEY_ON_PLATFORM_KEY stops meaning anything.
  const seesResidualIn = (rel: string, call: string) =>
    moneyMovingPlatformSeamCalls([rel]).some((h) => h.file === rel && h.at === call)

  mutate(
    "SITE 1 — the vendor payout falls back to stripe.transfers.create() on the platform key",
    F.vendorPayments,
    `    const transfer = await createTransfer(`,
    `    const transfer = await stripe.transfers.create({ amount: 1 } as never) ?? await createTransfer(`,
    () => seesResidualIn(F.vendorPayments, "transfers.create"),
  )

  mutate(
    "SITE 2 — the portal checkout falls back to stripe.checkout.sessions.create() on the platform key",
    F.vendorPayments,
    `  const checkout = await createCheckoutSession(`,
    `  const checkout = await stripe.checkout.sessions.create({} as never) ?? await createCheckoutSession(`,
    () => seesResidualIn(F.vendorPayments, "checkout.sessions.create"),
  )

  // AND THE SCOPE ITSELF: repointing the call is only half the ruling — handing the
  // survivor `{ side: "platform" }` charges the same wrong account through a
  // correct-looking function, so C9 must go red on that too.
  mutate(
    'SITE 1 — createTransfer is handed { side: "platform" } instead of the session\'s tenant',
    F.vendorPayments,
    `      { side: "tenant", brokerageId: ctx.brokerageId },`,
    `      { side: "platform" },`,
    () => {
      const pay = code(F.vendorPayments)
      return /side:\s*"platform"/.test(pay)
        && !/createTransfer\(\s*\{[\s\S]{0,600}?\},\s*\{\s*side:\s*"tenant",\s*brokerageId:\s*ctx\.brokerageId\s*\}/.test(pay)
    },
  )

  mutate(
    "SITE 2 — the portal's tenant is taken from the INVOICE rather than from the session",
    F.vendorPayments,
    // `mutate` replaces the FIRST occurrence, which is startVendorInvoiceCheckout's.
    // confirmVendorInvoiceCheckout's identical block survives, so the assertion below
    // must count call sites rather than ask whether the phrase still appears at all.
    `  const sessionBrokerageId = gate.contact.brokerage_id
  if (!sessionBrokerageId || invoice.brokerage_id !== sessionBrokerageId) {
    return { success: false, error: "Invoice not found" }
  }`,
    `  const sessionBrokerageId = invoice.brokerage_id ?? ""`,
    () => {
      const pay = code(F.vendorPayments)
      return !/const sessionBrokerageId = gate\.contact\.brokerage_id/.test(pay)
        || (pay.match(/invoice\.brokerage_id\s*!==\s*sessionBrokerageId/g) ?? []).length < 2
    },
  )
} else {
  console.log("\n(negative controls skipped — --no-negative)")
}

console.log(`\n${fail === 0 ? "✅" : "❌"} stripe-account-scope: ${pass} passed, ${fail} failed`)
if (fail) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
}
process.exit(fail === 0 ? 0 : 1)
