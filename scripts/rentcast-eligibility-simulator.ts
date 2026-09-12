#!/usr/bin/env tsx
/**
 * scripts/rentcast-eligibility-simulator.ts   (tsx scripts/rentcast-eligibility-simulator.ts)
 * ─────────────────────────────────────────────────────────────────────────────
 * RENTCAST IS NOT SPENT ON A TENANT WHO OWNS A FEED — AND THE DECISION IS MADE
 * BEFORE THE MONEY MOVES.
 *
 * OWNER RULING (verbatim):
 *   "rentcast is platform owned and should not be used if the tenant adds their
 *    idx broker credentials"
 *
 * That is a CONNECTION rule, not a results rule. Before this wave the tree had
 * exactly one executable precedence — `lib/property/listing-source.ts` — and it
 * encoded the WRONG one:
 *
 *     if (opts.hasIdx && opts.idxResultCount > 0) return "idx"
 *
 * IDX had to be connected AND to have ALREADY RETURNED ROWS, so IDX was called
 * first and RentCast was skipped only when IDX happened to produce results for
 * that query. A brokerage with its own feed still paid for RentCast on every
 * thin search — precisely the case they connected IDX to fix.
 *
 * And in `lib/cma/comp-provider.ts` there was no precedence at all: RentCast was
 * called FIRST and UNCONDITIONALLY, with `idxConnected` computed ninety lines
 * later — *after* `costCents += RENTCAST_COMPS_COST_CENTS` had already run. The
 * question "were we allowed to spend?" was answered after spending.
 *
 * ── THE FIVE THINGS THIS PROOF STANDS OVER ──────────────────────────────────
 *
 *   E1  ONE resolver answers all three questions, and its answer is
 *       DISCRIMINATED. "We deliberately did not call" and "we could not reach
 *       the provider" are opposite facts about the product; a boolean makes them
 *       the same screen. Every reason in the vocabulary must be reachable.
 *
 *   E2  A PLATFORM-TIER IDX credential is NOT "the tenant added their
 *       credentials". The cascade is agent → team → brokerage → platform, and
 *       the last tier is the PRODUCT'S fallback account. Counting it would
 *       suppress RentCast for every tenant on the system the moment one platform
 *       IDX row exists — a total, silent outage dressed as compliance.
 *
 *   E3  EVERY RentCast export asks the gate BEFORE it reaches the network.
 *       Asserted as an ORDER, because "spends then checks" is the comp-provider
 *       defect stated exactly.
 *
 *   E4  `listing-source.ts` no longer conditions on a RESULT COUNT.
 *
 *   E5  `external-listings-search.ts` still reads the PLATFORM key and still
 *       performs NO per-tenant RentCast credential read — the wave-17 invariant
 *       that must not regress while wave 18 narrows the same gate.
 *
 * ── HOW THIS PROOF IS BUILT ─────────────────────────────────────────────────
 *   · Assertions read the CONSTRUCT on COMMENT-STRIPPED source. These files
 *     quote the old defective code in their own headers — `listing-source.ts`
 *     literally contains the string `opts.idxResultCount > 0` in prose,
 *     explaining why it was wrong. A prose-blind check would fail on the
 *     explanation and pass on the defect.
 *   · Every assertion carries a NEGATIVE CONTROL: the defect is written into the
 *     real file, THE PATCH IS VERIFIED TO HAVE APPLIED (a find-string that
 *     silently no longer matches is theatre, not a control), the check is
 *     required to flip RED, and the file is restored and re-verified by sha256.
 *   · ONE assertion reads a VALUE rather than source text, and it is the one that
 *     had to (lane W3, 2026-09-01). `RENTCAST_ELIGIBILITY_REASONS` carries a
 *     keep-with-reason at rentcast-eligibility.ts:149-150 — "Exported so a proof
 *     can assert the vocabulary exists" — and this proof did not import it. E1
 *     tested `/export\s+const\s+RENTCAST_ELIGIBILITY_REASONS/` against the source
 *     and E1's reachability list was a HARDCODED copy of the five reasons, so the
 *     export could have been emptied to `[]`, or a member renamed, and both
 *     assertions would still have passed: the declaration was still spelled that
 *     way, and the private copy still listed what the code no longer said. §2's
 *     "true and useless" shape, and a second copy of a vocabulary besides (§6).
 *     E1c now LOADS the module and compares the array's CONTENTS against the
 *     `RentcastEligibilityReason` union parsed out of the declaration — neither
 *     side a member list this file keeps — and the reachability scan below runs
 *     over the loaded array, so gutting the vocabulary turns this proof red
 *     instead of leaving it green and vacuous.
 *
 *     The load is a cache-busted dynamic import, on purpose: a static import
 *     binds ONCE, so the negative controls below — which patch the real file and
 *     re-run the check — would go on reading the vocabulary as it was at startup
 *     and "prove" the control fired when nothing had been re-read.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import { stripComments } from "./strip-comments"
// Type-only: the union is a compile-time fact, and importing it here is what makes
// a rename of the type itself a BUILD failure in this proof rather than a silent
// drift the runtime comparison below would have to discover.
import type { RentcastEligibilityReason } from "../lib/property/rentcast-eligibility"

const ROOT = process.cwd()
const RUN_NEGATIVE = !process.argv.includes("--no-negative")

const F = {
  gate: "lib/property/rentcast-eligibility.ts",
  readers: "lib/property/rentcast.ts",
  source: "lib/property/listing-source.ts",
  external: "lib/property/external-listings-search.ts",
  comps: "lib/cma/comp-provider.ts",
  avm: "lib/avm/provider-chain.ts",
}

const failures: string[] = []
function check(label: string, ok: boolean, detail = ""): boolean {
  if (ok) console.log(`  ✓ ${label}`)
  else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`)
    failures.push(label)
  }
  return ok
}

const raw = (p: string) => readFileSync(resolve(ROOT, p), "utf8")
const sha = (p: string) => createHash("sha256").update(raw(p)).digest("hex")
/** Comment-stripped source. Load-bearing here: these files quote the defect. */
const code = (p: string) =>
  stripComments(raw(p))

/**
 * The top-level REGION of `fn` — from its declaration to the next top-level
 * declaration (or EOF).
 *
 * Deliberately NOT brace-matched from the function name. These signatures put
 * braces in the PARAMETER type (`params: RentcastCaller & { filters: … }`) and
 * in the RETURN type (`Promise<{ success: boolean … }>`), so "first `{` after
 * the name" lands inside the signature and slices the wrong text — which is
 * exactly the bug that made this proof's first run report all six exports
 * ungated when every one of them is gated. A region is sufficient for the ORDER
 * assertions here and cannot be fooled by a brace in a type.
 */
function regionOf(src: string, fn: string): string | null {
  const m = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${fn}\\s*\\(`).exec(src)
  if (!m) return null
  const rest = src.slice(m.index + m[0].length)
  const next = /\n(?:export\s+)?(?:async\s+)?function\s+\w|\nexport\s+(?:const|type|interface)\s/.exec(rest)
  return next ? rest.slice(0, next.index) : rest
}

/**
 * The BODY of a region returned by `regionOf` — everything after the parameter
 * list closes.
 *
 * `regionOf` starts just past the opening `(`, so the region still contains the
 * PARAMETER declarations. That matters: `resolveListingSource` legitimately
 * still declares `idxResultCount?: number` for callers that pass it, and an
 * assertion that the decision does not CONDITION on the count must not trip over
 * the parameter merely being declared. Scanning to the matching `)` and taking
 * the first `{` after it separates "the signature mentions it" from "the
 * decision uses it" — which is the whole difference between a surviving
 * parameter and a surviving defect.
 */
function bodyAfterParams(region: string): string {
  let depth = 1
  let i = 0
  for (; i < region.length && depth > 0; i++) {
    if (region[i] === "(") depth++
    else if (region[i] === ")") depth--
  }
  const brace = region.indexOf("{", i)
  return brace === -1 ? region.slice(i) : region.slice(brace)
}

// ─────────────────────────────────────────────────────────────────────────────
// E1 — one resolver, discriminated answer, every reason reachable
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The vocabulary AS A VALUE, re-loaded from disk on every call.
 *
 * `?v=n` defeats the ESM module cache so a negative control that patches the real
 * file is actually re-read. Without it the second load returns the first load's
 * frozen array and the control would report "went RED as required" on the
 * strength of nothing at all.
 */
let vocabLoads = 0
async function loadReasonVocabulary(): Promise<readonly string[] | null> {
  const href = `${pathToFileURL(resolve(ROOT, F.gate)).href}?v=${vocabLoads++}`
  try {
    const mod = (await import(href)) as { RENTCAST_ELIGIBILITY_REASONS?: unknown }
    const v = mod.RENTCAST_ELIGIBILITY_REASONS
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return null
    return v as readonly string[]
  } catch {
    // A module that will not load is NOT a pass. Returning null makes every
    // assertion below fail loudly rather than skip.
    return null
  }
}

/**
 * The members of the `RentcastEligibilityReason` UNION, read out of its
 * declaration on comment-stripped source.
 *
 * Deliberately NOT a list this file keeps: a hardcoded copy is a second spelling
 * of the same vocabulary (§6) and a waypoint (§2) — it passes for as long as
 * nobody edits it, which is the opposite of what an assertion is for. The union
 * is terminated at the first line that is not a `| "member"` continuation, so the
 * `RENTCAST_ELIGIBILITY_REASONS` declaration that follows it cannot leak in and
 * make the two sides agree by construction.
 */
function unionMembersFromSource(): string[] {
  const m = /export\s+type\s+RentcastEligibilityReason\s*=([\s\S]*?)(?:\n\s*\n|\nexport\s)/.exec(code(F.gate))
  if (!m) return []
  const out: string[] = []
  for (const a of m[1].matchAll(/\|\s*"([a-z0-9_]+)"/gi)) if (!out.includes(a[1])) out.push(a[1])
  return out
}

/**
 * E1c — THE BINDING. The exported array and the union declare the SAME set.
 *
 * Both sides are derived: one from the loaded module, one from the declaration.
 * The emptiness check is load-bearing — a gutted const and a gutted union agree
 * perfectly at zero members, which is precisely the "true and useless" pass this
 * assertion replaced.
 */
async function assertVocabularyMatchesTheUnion(): Promise<boolean> {
  const vocab = await loadReasonVocabulary()
  const union = unionMembersFromSource()
  const inVocab = new Set(vocab ?? [])
  const inUnion = new Set(union)
  const missing = union.filter((r) => !inVocab.has(r))
  const extra = [...inVocab].filter((r) => !inUnion.has(r))
  return check(
    "E1c the EXPORTED vocabulary is the union itself — asserted on the loaded VALUE, not on the spelling of its declaration",
    vocab !== null && vocab.length > 0 && union.length > 0 && missing.length === 0 && extra.length === 0,
    `loaded=${vocab === null ? "FAILED TO LOAD" : `[${vocab}]`} union=[${union}] missingFromExport=[${missing}] notInUnion=[${extra}]`,
  )
}

async function assertDiscriminated(): Promise<boolean> {
  const src = code(F.gate)
  // The vocabulary is exported as DATA and read here as data — a member this
  // proof does not know about is still tested, and a member deleted from the
  // export stops being tested, which is what makes E1c above compulsory.
  const vocab = await loadReasonVocabulary()
  // The TYPE UNION declares every reason, so testing the whole file would report
  // a reason as reachable when only its type survives. Strip the union first and
  // look at what is actually RETURNED — a reason no caller can observe is not a
  // reason, it is a comment with a colon in it.
  const returns = src.replace(/export\s+type\s+RentcastEligibility\s*=[\s\S]*?\n\n/, "")
  const unreachable = (vocab ?? []).filter((r) => !new RegExp(`reason:\\s*"${r}"`).test(returns))
  // …and the answer carries the underlying FACTS, not just a verdict.
  const carriesFacts = /idx\s*[,:]/.test(src) && /platformKeyPresent/.test(src) && /budget\s*[,:]/.test(src)
  return check(
    "E1  the gate returns a DISCRIMINATED reason (not a boolean), and every reason in the EXPORTED vocabulary is reachable",
    vocab !== null && vocab.length > 0 && unreachable.length === 0 && carriesFacts,
    `vocabLoaded=${vocab === null ? "no" : `${vocab.length} reasons`} carriesFacts=${carriesFacts} unreturned=[${unreachable}]`,
  )
}

/** Compile-time use of the imported type — the union is a fact this proof is
 *  bound to, so renaming it breaks the build here instead of drifting silently. */
const REASON_TYPE_WITNESS: RentcastEligibilityReason = "eligible"
void REASON_TYPE_WITNESS

function assertFailsClosedOnUnreadableIdx(): boolean {
  const src = code(F.gate)
  // An unreadable IDX check must yield INELIGIBLE. Reading it as "no IDX" would
  // spend platform money in possible violation of the ruling, which is the one
  // direction that is not recoverable.
  const branch = /status\s*===\s*"unreadable"[\s\S]{0,400}?eligible:\s*false/.test(src)
  // …and the resolver must never downgrade a throw into "not connected".
  const resolver = regionOf(src, "resolveTenantIdxConnection") ?? ""
  const throwPath = /catch[\s\S]{0,300}?status:\s*"unreadable"/.test(resolver)
  return check(
    "E1b an UNREADABLE IDX check fails CLOSED and is never read as 'no IDX connected'",
    branch && throwPath,
    `ineligibleBranch=${branch} throwYieldsUnreadable=${throwPath}`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// E2 — a PLATFORM-tier credential is not the tenant's
// ─────────────────────────────────────────────────────────────────────────────
function assertPlatformTierIsNotTheTenant(): boolean {
  const resolver = regionOf(code(F.gate), "resolveTenantIdxConnection") ?? ""
  const excluded = /ownerType\s*===\s*"platform"[\s\S]{0,80}?status:\s*"not_connected"/.test(resolver)
  // A row with no usable key must not count either — `forBrokerage` would fall
  // through to the platform env for it, so the tenant is NOT served from their
  // own account and the gate must agree with the client it guards.
  const keyRequired = /!\s*conn\.apiKey[\s\S]{0,80}?status:\s*"not_connected"/.test(resolver)
  return check(
    "E2  a PLATFORM-tier IDX hit is NOT counted as the tenant's own credential",
    excluded && keyRequired,
    `platformExcluded=${excluded} emptyKeyExcluded=${keyRequired}`,
  )
}

function assertGateUsesTheClientsResolver(): boolean {
  const src = code(F.gate)
  // The gate and IDXBrokerClient.forBrokerage MUST consult the same resolver, or
  // they can disagree about whether a tenant "has IDX" — and a gate that
  // disagrees with the client it guards is worse than no gate.
  // `resolveScopedConnectionResult` is the DISCRIMINATED form of the same
  // resolver in the same module — `resolveScopedConnection` is a one-line
  // projection of it — so either name satisfies "the same resolver the client
  // uses". Wave 19 repointed this gate onto the discriminated form so
  // `idx_check_unreadable` became reachable.
  const sameResolver = /resolveScopedConnection(?:Result)?\(\s*IDX_PROVIDER|resolveScopedConnection(?:Result)?\(\s*"idxbroker"/.test(src)
  const noRivalRead = !/\.from\(\s*["'](platform_credentials|agent_api_credentials|integration_credentials)["']\s*\)/.test(src)
  return check(
    "E2b the gate resolves IDX through the SAME resolver the client uses, with no rival read",
    sameResolver && noRivalRead,
    `sameResolver=${sameResolver} noRivalRead=${noRivalRead}`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// E3 — every RentCast export asks the gate BEFORE the network
// ─────────────────────────────────────────────────────────────────────────────
const RENTCAST_EXPORTS = [
  "searchRentcastSaleListings",
  "getRentcastListingStatus",
  "searchRentcastRentalListings",
  "getRentcastAVM",
  "getRentcastMarketStats",
  // Reads the comparables AND the AVM off the ONE /avm/value response, so the
  // CMA lane can show the provider's own estimate as a baseline without buying
  // a second lookup. This is the gated export; `getRentcastComps` below is a
  // thin reader over it.
  "getRentcastAvmAndComps",
  "getRentcastComps",
]

/**
 * A DELEGATING export: one that issues no request of its own and reaches the
 * provider only through another export in this list.
 *
 * `getRentcastComps` became one of these when the comps pull and the AVM read
 * were merged into `getRentcastAvmAndComps` — two calls to `/avm/value` for one
 * question was two charges and two possibly-different comparable sets. A
 * delegate has no `gateRentcast(` of its own and does not need one; it is gated
 * by the thing it calls.
 *
 * This is the ONLY relaxation, and it is deliberately narrow: the delegate must
 * make NO network call itself, AND its delegate must be in this list, AND that
 * delegate must itself pass the gate-before-network test. A body that calls
 * `rentcastGet(` without a gate is still an offender no matter what else it
 * calls, so "delegating" cannot be used to smuggle an ungated request in.
 */
function delegateTargetOf(body: string): string | null {
  if (body.includes("rentcastGet(")) return null
  for (const fn of RENTCAST_EXPORTS) {
    if (new RegExp(`\\b${fn}\\s*\\(`).test(body)) return fn
  }
  return null
}

function assertGatedBeforeNetwork(): boolean {
  const src = code(F.readers)
  const offenders: string[] = []
  const clean = new Set<string>()
  const delegating: Array<{ fn: string; target: string }> = []

  for (const fn of RENTCAST_EXPORTS) {
    const region = regionOf(src, fn)
    const body = region === null ? null : bodyAfterParams(region)
    if (body === null) {
      // A body this proof cannot read must never be scored as CLEAN — that is
      // how an assertion quietly stops asserting.
      offenders.push(`${fn}(unreadable)`)
      continue
    }
    const gate = body.indexOf("gateRentcast(")
    const net = body.indexOf("rentcastGet(")
    if (gate !== -1 && (net === -1 || gate < net)) { clean.add(fn); continue }
    if (gate !== -1) { offenders.push(`${fn}(spends-then-checks)`); continue }
    const target = delegateTargetOf(body)
    if (target === null) { offenders.push(`${fn}(ungated)`); continue }
    delegating.push({ fn, target })
  }
  // Resolve delegates only against exports proven clean above. A delegate whose
  // target is itself an offender (or another delegate) is NOT excused.
  for (const d of delegating) {
    if (clean.has(d.target)) clean.add(d.fn)
    else offenders.push(`${d.fn}(delegates to ungated ${d.target})`)
  }

  return check(
    `E3  all ${RENTCAST_EXPORTS.length} RentCast exports ask the gate BEFORE reaching the network` +
      (delegating.length ? ` (${delegating.map((d) => `${d.fn}→${d.target}`).join(", ")} gated by delegation)` : ""),
    offenders.length === 0,
    offenders.join(", "),
  )
}

function assertCompProviderDecidesBeforeSpending(): boolean {
  const compsRegion = regionOf(code(F.comps), "sourceCompsForCma")
  const body = compsRegion === null ? null : bodyAfterParams(compsRegion)
  if (body === null) return check("E3b comp-provider decides eligibility before it spends", false, "body unreadable")
  const decide = body.indexOf("resolveRentcastEligibility(")
  // The pull is now the COMBINED reader (comparables + the AVM baseline off the
  // one /avm/value response). Both spellings are looked for so this stays an
  // assertion about the ORDER rather than about which name the pull has today —
  // and a body where NEITHER appears is an offender, not a pass, because a
  // vacuous `pull === -1` is how this check would quietly stop checking.
  const pull = Math.min(
    ...["getRentcastAvmAndComps(", "getRentcastComps("]
      .map((n) => body.indexOf(n))
      .filter((i) => i !== -1)
      .concat([Number.POSITIVE_INFINITY]),
  )
  const spend = body.indexOf("costCents += RENTCAST_COMPS_COST_CENTS")
  const ok =
    decide !== -1 && Number.isFinite(pull) && decide < pull && (spend === -1 || decide < spend)
  return check(
    "E3b comp-provider decides eligibility BEFORE the pull and before costCents moves",
    ok,
    `decide@${decide} pull@${pull} spend@${spend}`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// E4 — connection decides, not a result count
// ─────────────────────────────────────────────────────────────────────────────
function assertNoResultCountRule(): boolean {
  const src = code(F.source)
  // The defect was a COMPARISON on the result count inside the decision. The
  // parameter may survive for callers; conditioning on it may not.
  // ANY appearance of the count inside the decision body is the defect — an
  // operator allow-list missed `(opts.idxResultCount ?? 0) > 0` on the first run.
  // The parameter may survive in the signature for callers; conditioning on it
  // may not.
  const region = regionOf(src, "resolveListingSource")
  const conditions = region === null ? true : /idxResultCount/.test(bodyAfterParams(region))
  const connectionRule = /hasIdx[\s\S]{0,60}?return\s+"idx"/.test(src)
  return check(
    "E4  listing-source decides on CONNECTION, never on a result count",
    !conditions && connectionRule,
    `conditionsOnCount=${conditions} connectionRule=${connectionRule}`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// E5 — the wave-17 platform-gating invariant did not regress
// ─────────────────────────────────────────────────────────────────────────────
function assertNoTenantRentcastCredentialRead(): boolean {
  const offenders: string[] = []
  for (const p of [F.external, F.readers, F.gate]) {
    const src = code(p)
    // RentCast is platform-only: no tenant credential exists, so no code may
    // look one up. This is the wave-17 invariant; wave 18 NARROWS the gate and
    // must not widen the credential.
    if (/\.from\(\s*["']integration_credentials["']\s*\)/.test(src)) offenders.push(p)
  }
  const external = code(F.external)
  // The platform-key question is asked through its NAMED reader here
  // (`isRentcastConfigured`, which resolves the one platform key) rather than by
  // touching process.env inline. Assert the question is asked, not the spelling
  // it is asked in.
  const platformKey =
    /isRentcastConfigured\s*\(/.test(external) ||
    /process\.env\.RENTCAST_API_KEY/.test(external) ||
    /platformKeyPresent/.test(external)
  return check(
    "E5  no per-tenant RentCast credential read survives, and the platform key is still the availability test",
    offenders.length === 0 && platformKey,
    `tenantReads=[${offenders}] platformKeyConsulted=${platformKey}`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// NEGATIVE CONTROLS
// ─────────────────────────────────────────────────────────────────────────────
interface Control { file: string; find: string; replace: string }

async function controlled(label: string, c: Control, fn: () => boolean | Promise<boolean>): Promise<void> {
  const before = raw(c.file)
  const beforeSha = sha(c.file)
  const after = before.replace(c.find, c.replace)
  if (after === before) {
    console.log(`  ✗ NEGATIVE CONTROL ${label} — PATCH DID NOT APPLY; proves nothing`)
    failures.push(`negative control did not apply: ${label}`)
    return
  }
  writeFileSync(resolve(ROOT, c.file), after)
  let wentRed = false
  try {
    const mark = failures.length
    wentRed = !(await fn())
    while (failures.length > mark) failures.pop()
  } finally {
    writeFileSync(resolve(ROOT, c.file), before)
    if (sha(c.file) !== beforeSha) {
      failures.push(`FAILED TO RESTORE ${c.file}`)
      console.log(`  ✗ FAILED TO RESTORE ${c.file}`)
      return
    }
  }
  console.log(
    wentRed
      ? `  ✓ NEGATIVE CONTROL ${label} — went RED as required`
      : `  ✗ NEGATIVE CONTROL ${label} — STAYED GREEN with the defect present`,
  )
  if (!wentRed) failures.push(`negative control stayed green: ${label}`)
}

async function main(): Promise<void> {
  console.log("RENTCAST ELIGIBILITY — THE ONE GATE\n")
  console.log("ASSERTIONS")
  await assertVocabularyMatchesTheUnion()
  await assertDiscriminated()
  assertFailsClosedOnUnreadableIdx()
  assertPlatformTierIsNotTheTenant()
  assertGateUsesTheClientsResolver()
  assertGatedBeforeNetwork()
  assertCompProviderDecidesBeforeSpending()
  assertNoResultCountRule()
  assertNoTenantRentcastCredentialRead()

  if (RUN_NEGATIVE) {
    console.log("\nNEGATIVE CONTROLS")

    // 1. THE headline regression: a platform-tier IDX row counts as the tenant's,
    //    which would suppress RentCast for every tenant on the system.
    await controlled(
      "a PLATFORM-tier IDX credential counted as the tenant's own",
      {
        file: F.gate,
        find: `  if (conn.ownerType === "platform") return { status: "not_connected" }`,
        replace: `  // control: platform tier wrongly counted`,
      },
      assertPlatformTierIsNotTheTenant,
    )

    // 2. The unreadable branch made eligible — spending on an unprovable answer.
    await controlled(
      "an unreadable IDX check made ELIGIBLE instead of failing closed",
      {
        file: F.gate,
        find: `  if (idx.status === "unreadable") {`,
        replace: `  if (false) {`,
      },
      assertFailsClosedOnUnreadableIdx,
    )

    // 3. A reason that exists in the type but is never returned — a verdict no
    //    caller can ever observe.
    await controlled(
      "a reason that is declared but never returned",
      {
        file: F.gate,
        find: `      reason: "budget_exhausted",`,
        replace: `      reason: "no_platform_key",`,
      },
      assertDiscriminated,
    )

    // 4. One export spends before it checks — the comp-provider defect, moved.
    await controlled(
      "a RentCast export reaching the network before the gate",
      {
        file: F.readers,
        find: `  const { apiKey } = await gateRentcast(params)`,
        replace: `  const apiKey = await getApiKey(params.brokerageId)`,
      },
      assertGatedBeforeNetwork,
    )

    // 5. comp-provider decides after it has already spent — the original defect.
    await controlled(
      "comp-provider resolving eligibility AFTER costCents has moved",
      {
        file: F.comps,
        find: `  const rentcastEligibility = await resolveRentcastEligibility({`,
        replace: `  costCents += RENTCAST_COMPS_COST_CENTS\n  const rentcastEligibility = await resolveRentcastEligibility({`,
      },
      assertCompProviderDecidesBeforeSpending,
    )

    // 6. The result-count rule restored — the wrong rule, which is the one that
    //    was actually in the tree.
    await controlled(
      "the old result-count precedence put back",
      {
        file: F.source,
        find: `  if (opts.hasIdx) return "idx"`,
        replace: `  if (opts.hasIdx && (opts.idxResultCount ?? 0) > 0) return "idx"`,
      },
      assertNoResultCountRule,
    )

    // 7. A per-tenant RentCast credential read reintroduced — the wave-17
    //    invariant regressing while wave 18 narrows the same gate.
    await controlled(
      "a per-tenant RentCast credential read reintroduced",
      {
        file: F.gate,
        find: `function platformRentcastKey(): string | null {`,
        replace: `async function tenantKey(b: string) { const s: any = null; return s.from("integration_credentials").eq("brokerage_id", b) }\nfunction platformRentcastKey(): string | null {`,
      },
      assertNoTenantRentcastCredentialRead,
    )

    // 8. The gate opening a RIVAL IDX lookup instead of the client's resolver —
    //    the two would then be free to disagree about "has IDX".
    await controlled(
      "the gate resolving IDX through a rival read instead of the client's resolver",
      {
        file: F.gate,
        find: `    resolved = await resolveScopedConnectionResult(IDX_PROVIDER, {`,
        replace: `    const anySvc: any = null; resolved = await anySvc.from("platform_credentials").select("*"); void ((x: any) => x)({`,
      },
      assertGateUsesTheClientsResolver,
    )

    // ── 9-11. THE VOCABULARY BINDING (lane W3) ────────────────────────────────
    // These three are the controls the OLD assertion could not have: it tested
    // `/export const RENTCAST_ELIGIBILITY_REASONS/` against the source, so it
    // stayed GREEN through every one of them — the export is still spelled that
    // way in all three. Each patches the ARRAY only (the `"member",` form with a
    // trailing comma appears nowhere else; the union writes `| "member"`), so the
    // union is left untouched and it is genuinely the disagreement that is caught.
    await controlled(
      "a member REMOVED from the exported vocabulary while the union still declares it",
      {
        file: F.gate,
        find: `  "budget_exhausted",\n  "eligible",\n] as const`,
        replace: `  "eligible",\n] as const`,
      },
      assertVocabularyMatchesTheUnion,
    )

    await controlled(
      "a member RENAMED in the exported vocabulary (the union keeps the real spelling)",
      {
        file: F.gate,
        find: `  "idx_check_unreadable",\n  "no_platform_key",`,
        replace: `  "idx_check_unreadable_v2",\n  "no_platform_key",`,
      },
      assertVocabularyMatchesTheUnion,
    )

    await controlled(
      "the vocabulary GUTTED to an empty array — the shape a text assertion cannot see at all",
      {
        file: F.gate,
        find: `  "tenant_has_idx",\n  "idx_check_unreadable",\n  "no_platform_key",\n  "budget_exhausted",\n  "eligible",\n] as const`,
        replace: `] as const`,
      },
      assertVocabularyMatchesTheUnion,
    )
  }

  console.log("")
  if (failures.length) {
    console.log(`FAILED (${failures.length})`)
    for (const f of failures) console.log(`  · ${f}`)
    process.exit(1)
  }
  console.log(
    "PASSED — RentCast is not spent on a tenant who owns a feed, the platform's own fallback account is not mistaken for the tenant's, and every lane decides before the money moves",
  )
}

// A rejection here must not read as a pass: an unhandled promise rejection can
// leave the exit code at 0, which is exactly the "nobody checked renders as
// checked and fine" shape this proof exists to prevent (§4 fail closed).
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
