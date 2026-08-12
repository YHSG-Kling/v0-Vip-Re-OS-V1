#!/usr/bin/env tsx
/**
 * scripts/credential-cascade-refusal-simulator.ts
 *   (npm run test:credential-cascade-refusal — pure, no DB)
 * ─────────────────────────────────────────────────────────────────────────────
 * A REFUSED CREDENTIAL READ IS NOT AN ABSENT ROW, AND THE CASCADE MUST NOT
 * DESCEND PAST ONE.
 *
 * `lib/connections/resolve-scoped.ts` is THE credential resolver for the whole
 * owner cascade — agent → team → brokerage → platform, most-specific wins — and
 * thirteen files ask it who to call as: idxbroker, Twilio/SMS, QuickBooks,
 * e-sign, transaction forms, GHL sync, ShowingTime, Transistor.
 *
 * It used to answer three different facts with one value:
 *
 *     if (error || !data) return null      // a REFUSAL and an ABSENCE, together
 *     } catch { return null }              // …and a THROW with them
 *
 * and then the cascade loop DESCENDED past that null to the next owner. Two
 * consequences, and the second is the larger one:
 *
 *   1. `lib/property/rentcast-eligibility.ts` returns `idx_check_unreadable` /
 *      ineligible when the IDX lookup cannot be read — a fail-CLOSED branch
 *      protecting an explicit owner ruling ("rentcast … should not be used if the
 *      tenant adds their idx broker credentials"). Its own header admitted the
 *      branch "only fires when the resolver THROWS". The resolver never threw. A
 *      fail-closed branch that cannot run is a comment, and RentCast was spent for
 *      tenants who may own an IDX feed.
 *
 *   2. If the AGENT-tier read is REFUSED rather than empty, the loop did not stop:
 *      it descended and returned the TEAM's, the BROKERAGE's, or the PLATFORM's
 *      credential. That is not a failure — it is a successful call made with
 *      somebody else's account, and every caller reads it as a normal hit. An
 *      agent's text from another number; a financial write in the wrong ledger; a
 *      signature request from the wrong account.
 *
 * Pre-rollout the stores are EMPTY, so today every read answers "absent" honestly
 * and nothing misbehaves. That is precisely why this is proved from the CODE: the
 * defect is invisible until there is data, and then it is invisible again because
 * it looks like success.
 *
 * ── THE FOUR THINGS THIS PROOF STANDS OVER ──────────────────────────────────
 *
 *   C1  The per-owner read does NOT collapse `error` and `!data` into one answer,
 *       and an UNCLASSIFIED error falls on the unreadable side rather than being
 *       waved through as "pre-migration".
 *
 *   C2  The cascade STOPS on an unreadable tier. Asserted as CONTROL FLOW — the
 *       first control keyword after the unreadable test must be `return`, never
 *       `continue` — because "descend on refusal" is the defect stated exactly.
 *
 *   C3  THE ONE NOBODY WROTE LAST WAVE: `idx_check_unreadable` is REACHABLE. Not
 *       "the branch exists" — that was true while it was dead — but that the
 *       resolver the gate calls can actually PRODUCE that state from a resolved
 *       (non-thrown) refusal, that the gate consumes it OUTSIDE its catch block,
 *       and that the consumption lands on the ineligible verdict.
 *
 *   C4  The legacy `resolveScopedConnection` export still returns
 *       `ScopedConnection | null` and still cannot throw, so the twelve callers
 *       nobody touched compile and behave as before.
 *
 * ── HOW THIS PROOF IS BUILT ─────────────────────────────────────────────────
 *   · Every structural assertion reads COMMENT-STRIPPED source. Both files quote
 *     the defect in their own prose — `resolve-scoped.ts` literally contains the
 *     string `if (error || !data) return null` in its header, explaining why it
 *     was wrong. A prose-blind check would fail on the explanation and pass on the
 *     defect.
 *   · Function bodies are sliced by walking the PARAMETER LIST to its closing
 *     paren first. `resolveScopedConnectionResult(provider, ctx: ScopeContext & {
 *     agentId?: string | null })` has a brace in its parameter type, so "first `{`
 *     after the name" lands inside the signature — the exact bug that produced
 *     four false failures in this repo's last proof.
 *   · Every assertion carries a NEGATIVE CONTROL: the defect is written into the
 *     real file, THE PATCH IS VERIFIED TO HAVE APPLIED (a find-string that
 *     silently no longer matches is theatre, not a control), the check is required
 *     to flip RED, and the file is restored and re-verified by sha256.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { createHash } from "node:crypto"

const ROOT = process.cwd()
const RUN_NEGATIVE = !process.argv.includes("--no-negative")

const F = {
  resolver: "lib/connections/resolve-scoped.ts",
  gate: "lib/property/rentcast-eligibility.ts",
}

/** The callers this wave did NOT touch. Every one of them still consumes the
 *  flattening wrapper, and none of them was migrated to the discriminated form —
 *  that is the point of keeping the wrapper.
 *
 *  ELEVEN, not twelve. `app/actions/accounting-sync.ts` was on this roster when
 *  the proof was written, and it should never have been: it IMPORTED
 *  `resolveScopedConnection` and never called it. A dead import is not a caller,
 *  and counting one made this assertion protect a symbol nobody was using. The
 *  import was removed and the roster corrected to the files that actually CALL
 *  the wrapper — which is what "none was silently migrated" is about.
 *
 *  The proof caught its own roster being wrong, in CI, after a late edit that
 *  the local chain run predated. That is the assertion working, not misfiring. */
const UNTOUCHED_CALLERS = [
  "app/actions/dispatch-showing.ts",
  "app/actions/seller-showings.ts",
  "app/actions/podcast-generation.ts",
  "app/api/cron/distribute-podcast-episodes/route.ts",
  "lib/idxbroker-client.ts",
  "lib/crm/sync.ts",
  "lib/providers/messaging/resolve-sms-provider.ts",
  "lib/finance/accounting-egress.ts",
  "lib/integrations/resolve-esign-provider.ts",
  "lib/integrations/transaction-providers/resolve-transaction-provider.ts",
  "lib/workflow/adapters/schedule-showing.ts",
]

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
/** Comment-stripped source. Load-bearing here: both files quote the defect. */
const code = (p: string) =>
  raw(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")

/**
 * The top-level REGION of `fn` — from just past its opening paren to the next
 * top-level declaration (or EOF). Deliberately not brace-matched from the name.
 */
function regionOf(src: string, fn: string): string | null {
  const m = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${fn}\\s*\\(`).exec(src)
  if (!m) return null
  const rest = src.slice(m.index + m[0].length)
  const next = /\n(?:export\s+)?(?:async\s+)?function\s+\w|\nexport\s+(?:const|type|interface)\s|\ntype\s+\w|\nconst\s+\w/.exec(rest)
  return next ? rest.slice(0, next.index) : rest
}

/**
 * The BODY of a region — everything from the `{` that follows the CLOSING paren
 * of the parameter list.
 *
 * `resolveScopedConnectionResult` and `resolveScopedConnection` both declare
 * `ctx: ScopeContext & { agentId?: string | null }`, so the first `{` after the
 * function name is inside the PARAMETER TYPE. Walking the parens first is the
 * difference between reading the body and reading the signature.
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

/** The balanced `{ … }` block starting at or after `fromIdx`. */
function braceBlockFrom(src: string, fromIdx: number): string {
  const open = src.indexOf("{", fromIdx)
  if (open === -1) return ""
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}") {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  return src.slice(open)
}

/** The body of the FIRST `for (…)` in a function body, paren-walked so a `{` in
 *  the loop header cannot be mistaken for the loop body. */
function firstLoopBody(body: string): string | null {
  const m = /for\s*\(/.exec(body)
  if (!m) return null
  let i = m.index + m[0].length
  let depth = 1
  for (; i < body.length && depth > 0; i++) {
    if (body[i] === "(") depth++
    else if (body[i] === ")") depth--
  }
  const blk = braceBlockFrom(body, i)
  return blk === "" ? null : blk
}

/** The same text with every `catch (…) { … }` block removed. Used to prove the
 *  gate observes unreadability from the RESOLVED path and not only from a throw —
 *  "only fires when the resolver throws" is the dead-branch defect exactly. */
function withoutCatchBlocks(body: string): string {
  let out = body
  for (let guard = 0; guard < 16; guard++) {
    const m = /catch\s*(?:\([^)]*\))?\s*\{/.exec(out)
    if (!m) break
    const braceIdx = out.indexOf("{", m.index)
    const blk = braceBlockFrom(out, braceIdx)
    if (blk === "") break
    out = out.slice(0, m.index) + out.slice(braceIdx + blk.length)
  }
  return out
}

/** The first control keyword reached after `fromIdx`, or null. */
function firstControlKeyword(body: string, fromIdx: number): string | null {
  const m = /\b(return|continue|break|throw)\b/.exec(body.slice(fromIdx))
  return m ? m[1] : null
}

// ─────────────────────────────────────────────────────────────────────────────
// C1 — a refusal is distinguishable from an absence, and the unknown fails closed
// ─────────────────────────────────────────────────────────────────────────────
function assertRefusalIsNotAbsence(): boolean {
  const src = code(F.resolver)
  const region = regionOf(src, "readOwnerCredential")
  if (region === null) {
    // A body this proof cannot read must never be scored CLEAN — that is how an
    // assertion quietly stops asserting.
    return check("C1  the per-owner read separates a REFUSAL from an ABSENCE", false, "readOwnerCredential unreadable")
  }
  const body = bodyAfterParams(region)

  // (a) THE DEFECT ITSELF: one condition mentioning both facts, joined by `||`.
  const collapsed = /\(\s*!?\s*\b(?:error|data)\b\s*\|\|\s*!?\s*\b(?:error|data)\b\s*\)/.test(body)

  // (b) The error is tested on its OWN, and its branch does not answer "absent".
  const errTest = /if\s*\(\s*error\s*\)\s*return\s+([^\n]+)/.exec(body)
  const errorHandledAlone = errTest !== null
  const errorIsNotAbsence = errorHandledAlone && !/"absent"/.test(errTest![1])

  // (c) …and an empty result is the one that answers "absent".
  const absenceIsAbsence = /if\s*\(\s*!\s*data\s*\)\s*return\s*\{\s*status:\s*"absent"/.test(body)

  // (d) The error is inspected BEFORE the row, so no path can reach the absence
  //     answer while an error is still unread.
  const errAt = body.search(/if\s*\(\s*error\s*\)/)
  const absAt = body.search(/if\s*\(\s*!\s*data\s*\)/)
  const errorFirst = errAt !== -1 && absAt !== -1 && errAt < absAt

  // (e) A THROW is its own answer too — never a silent fall-through.
  const throwIsUnreadable = /catch\s*\([^)]*\)\s*\{[\s\S]{0,400}?status:\s*"unreadable"/.test(body)

  return check(
    "C1  the per-owner read separates a REFUSAL from an ABSENCE (and a THROW from both)",
    !collapsed && errorHandledAlone && errorIsNotAbsence && absenceIsAbsence && errorFirst && throwIsUnreadable,
    `collapsed=${collapsed} errorAlone=${errorHandledAlone} errorNotAbsence=${errorIsNotAbsence} absenceIsAbsence=${absenceIsAbsence} errorFirst=${errorFirst} throwUnreadable=${throwIsUnreadable}`,
  )
}

function assertUnknownErrorFailsClosed(): boolean {
  const src = code(F.resolver)
  const region = regionOf(src, "classifyReadError")
  if (region === null) {
    return check("C1b an UNCLASSIFIED read error is unreadable, not 'pre-migration'", false, "classifyReadError unreadable")
  }
  const body = bodyAfterParams(region)
  // "This shape does not exist yet" may only be concluded from a CLOSED SET of
  // codes that say something structural about the schema. Anything else — a
  // permission refusal, a timeout, an error with no code at all — must land on
  // the unreadable side. So the schema answer is GUARDED and the unguarded
  // fall-through is the unreadable one.
  // Paren-tolerant on purpose: the guard is a membership call
  // (`SET.has(code)`), so `[^)]*` would stop at the inner `)` and report an
  // unguarded fall-through that is not there.
  const schemaGuarded = /if\s*\([\s\S]*?\)\s*return\s*\{\s*status:\s*"schema_absent"/.test(body)
  const lastSchema = body.lastIndexOf('"schema_absent"')
  const lastUnreadable = body.lastIndexOf('"unreadable"')
  const fallthroughIsUnreadable = lastUnreadable !== -1 && lastUnreadable > lastSchema
  // The allow-list is a real set, not an open-ended string test.
  const closedSet = /new\s+Set\s*\(/.test(code(F.resolver))
  return check(
    "C1b an UNCLASSIFIED read error is UNREADABLE, and only a closed set of schema codes falls through",
    schemaGuarded && fallthroughIsUnreadable && closedSet,
    `schemaGuarded=${schemaGuarded} fallthroughUnreadable=${fallthroughIsUnreadable} closedSet=${closedSet}`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// C2 — the cascade STOPS on an unreadable tier (asserted as CONTROL FLOW)
// ─────────────────────────────────────────────────────────────────────────────
function assertCascadeStopsOnUnreadable(): boolean {
  const src = code(F.resolver)
  const region = regionOf(src, "resolveScopedConnectionResult")
  if (region === null) {
    return check("C2  the cascade STOPS on an unreadable tier instead of descending", false, "resolver unreadable")
  }
  const loop = firstLoopBody(bodyAfterParams(region))
  if (loop === null) {
    return check("C2  the cascade STOPS on an unreadable tier instead of descending", false, "cascade loop not found")
  }
  // The loop must walk the shared cascade, not a hand-rolled tier order.
  const walksCascade = /scopeCascade\s*\(/.test(bodyAfterParams(region))
  // THE CONTROL-FLOW ASSERTION. Find where the loop tests for unreadability and
  // require the FIRST control keyword after it to be `return`. `continue` there
  // is the defect verbatim: one tier's outage handing back a less-specific
  // owner's credential.
  const testAt = loop.search(/status\s*===\s*"unreadable"/)
  const keyword = testAt === -1 ? null : firstControlKeyword(loop, testAt)
  const stops = keyword === "return"
  // …and what it returns is the unreadable state, not a quiet null.
  const returnsUnreadable = /status\s*===\s*"unreadable"[\s\S]{0,600}?return\s*\{\s*status:\s*"unreadable"/.test(loop)
  // The only thing allowed to continue the walk is a tier with nothing to say.
  const descendsOnRefusal = /status\s*===\s*"unreadable"[\s\S]{0,200}?\bcontinue\b/.test(loop)
  return check(
    "C2  the cascade STOPS on an unreadable tier instead of descending to the next owner",
    walksCascade && stops && returnsUnreadable && !descendsOnRefusal,
    `walksCascade=${walksCascade} firstKeywordAfterTest=${keyword} returnsUnreadable=${returnsUnreadable} descends=${descendsOnRefusal}`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// C3 — `idx_check_unreadable` is REACHABLE (the assertion nobody wrote)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Reachability is a CHAIN, and last wave every link but the first was already in
 * place — which is exactly why "the branch exists" proved nothing. All four links
 * are asserted together so a break anywhere reports as unreachable:
 *
 *   L1 the gate calls the DISCRIMINATED resolver, not the wrapper that flattens
 *      every failure to null
 *   L2 the gate maps that resolver's unreadable state to its own, from OUTSIDE
 *      its catch block — a mapping that only exists inside `catch` is the dead
 *      branch again, since supabase-js RESOLVES a refused query
 *   L3 the resolver can actually PRODUCE that state from a resolved read: the
 *      per-owner read answers unreadable on `error`, and the cascade surfaces a
 *      tier's unreadable as the result's unreadable
 *   L4 the gate's consumption lands on the ineligible verdict named
 *      `idx_check_unreadable`
 */
function assertUnreadableIsReachable(): boolean {
  const gate = code(F.gate)
  const res = code(F.resolver)

  const idxRegion = regionOf(gate, "resolveTenantIdxConnection")
  const idxBody = idxRegion === null ? null : bodyAfterParams(idxRegion)
  const outsideCatch = idxBody === null ? "" : withoutCatchBlocks(idxBody)

  // L1 — the discriminated resolver, by construct: a call whose name carries the
  //      result form. The flattening wrapper cannot express this state at all.
  const l1 = idxBody !== null && /resolveScopedConnectionResult\s*\(/.test(outsideCatch)

  // L2 — consumed on the RESOLVED path, not only in a catch.
  const testAt = outsideCatch.search(/status\s*===\s*"unreadable"/)
  const l2 =
    testAt !== -1 &&
    /status\s*===\s*"unreadable"[\s\S]{0,600}?status:\s*"unreadable"/.test(outsideCatch.slice(testAt))

  // L3 — the state is PRODUCIBLE upstream from a resolved (non-thrown) read.
  const readRegion = regionOf(res, "readOwnerCredential")
  const readBody = readRegion === null ? "" : bodyAfterParams(readRegion)
  const errRet = /if\s*\(\s*error\s*\)\s*return\s+([^\n]+)/.exec(readBody)
  const perTierProduces = errRet !== null && !/"absent"/.test(errRet[1])
  const classifier = regionOf(res, "classifyReadError")
  const classifierProduces = classifier !== null && /status:\s*"unreadable"/.test(bodyAfterParams(classifier))
  const cascadeRegion = regionOf(res, "resolveScopedConnectionResult")
  const cascadeLoop = cascadeRegion === null ? null : firstLoopBody(bodyAfterParams(cascadeRegion))
  const cascadeSurfaces =
    cascadeLoop !== null &&
    /status\s*===\s*"unreadable"[\s\S]{0,600}?return\s*\{\s*status:\s*"unreadable"/.test(cascadeLoop)
  const l3 = perTierProduces && classifierProduces && cascadeSurfaces

  // L4 — and it lands on the ineligible verdict.
  const verdictRegion = regionOf(gate, "resolveRentcastEligibility")
  const verdict = verdictRegion === null ? "" : bodyAfterParams(verdictRegion)
  const l4 = /status\s*===\s*"unreadable"[\s\S]{0,600}?reason:\s*"idx_check_unreadable"/.test(verdict)

  return check(
    "C3  `idx_check_unreadable` is REACHABLE — the resolver can produce the state, on the resolved path, and the gate lands on the verdict",
    l1 && l2 && l3 && l4,
    `L1_discriminatedResolver=${l1} L2_consumedOutsideCatch=${l2} L3_producible=${l3}(tier=${perTierProduces} classifier=${classifierProduces} cascade=${cascadeSurfaces}) L4_verdict=${l4}`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// C4 — the legacy export is unchanged for the twelve callers nobody touched
// ─────────────────────────────────────────────────────────────────────────────
function assertLegacyWrapperShapeUnchanged(): boolean {
  const src = code(F.resolver)
  // The SHAPE the twelve callers compile against.
  const sig = /export\s+async\s+function\s+resolveScopedConnection\s*\(([\s\S]*?)\)\s*:\s*Promise<([^>]*(?:<[^>]*>)?[^>]*)>/.exec(src)
  const returnsNullable = sig !== null && /ScopedConnection\s*\|\s*null/.test(sig[2])
  const takesSameArgs = sig !== null && /provider\s*:\s*string/.test(sig[1]) && /ScopeContext/.test(sig[1])

  const region = regionOf(src, "resolveScopedConnection")
  const body = region === null ? "" : bodyAfterParams(region)
  // It must not learn to throw: eleven of the twelve have no handler for one, so
  // a throw here turns one tier's outage into an uncaught exception inside SMS
  // dispatch, e-sign, accounting egress and CRM sync.
  const cannotThrow = body !== "" && !/\bthrow\b/.test(body)
  // …and it must not leak the discriminated object to callers typed for a
  // connection-or-null.
  const noDiscriminantLeak = body !== "" && !/return\s*\{\s*status:/.test(body)
  // An unreadable resolves to the SAME null those callers get today.
  const nullPath = /\bnull\b/.test(body)

  return check(
    "C4  the legacy `resolveScopedConnection` still returns `ScopedConnection | null`, still cannot throw, and maps unreadable to null",
    returnsNullable && takesSameArgs && cannotThrow && noDiscriminantLeak && nullPath,
    `nullableReturn=${returnsNullable} sameArgs=${takesSameArgs} cannotThrow=${cannotThrow} noLeak=${noDiscriminantLeak} nullPath=${nullPath}`,
  )
}

function assertUntouchedCallersStillOnTheWrapper(): boolean {
  const migrated: string[] = []
  const missing: string[] = []
  for (const p of UNTOUCHED_CALLERS) {
    let src: string
    try {
      src = code(p)
    } catch {
      missing.push(p)
      continue
    }
    if (!/\bresolveScopedConnection\b/.test(src)) missing.push(p)
    if (/resolveScopedConnectionResult/.test(src)) migrated.push(p)
  }
  return check(
    `C4b all ${UNTOUCHED_CALLERS.length} untouched callers still consume the WRAPPER and none was silently migrated`,
    migrated.length === 0 && missing.length === 0,
    `migrated=[${migrated}] missingOrRenamed=[${missing}]`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// NEGATIVE CONTROLS
// ─────────────────────────────────────────────────────────────────────────────
interface Control { file: string; find: string; replace: string }

function controlled(label: string, c: Control, fn: () => boolean): void {
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
    wentRed = !fn()
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

function main(): void {
  console.log("CREDENTIAL CASCADE — A REFUSAL IS NOT AN ABSENCE\n")
  console.log("ASSERTIONS")
  assertRefusalIsNotAbsence()
  assertUnknownErrorFailsClosed()
  assertCascadeStopsOnUnreadable()
  assertUnreadableIsReachable()
  assertLegacyWrapperShapeUnchanged()
  assertUntouchedCallersStillOnTheWrapper()

  if (RUN_NEGATIVE) {
    console.log("\nNEGATIVE CONTROLS")

    // 1. THE ORIGINAL LINE, restored: a refusal and an absence as one answer.
    controlled(
      "`error || !data` collapsed back into one answer",
      {
        file: F.resolver,
        find:
          `    if (error) return classifyReadError(error)\n` +
          `    if (!data) return { status: "absent" }`,
        replace: `    if (error || !data) return { status: "absent" }`,
      },
      assertRefusalIsNotAbsence,
    )

    // 2. The throw swallowed again — the `catch { return null }` at the old :63,
    //    in its new clothes.
    controlled(
      "a THROWN read swallowed as an absence instead of reported unreadable",
      {
        file: F.resolver,
        // The 4-space form is the per-owner read's catch; the legacy catch below
        // it is indented six, so this cannot patch the wrong one.
        find: `    return {\n      status: "unreadable",\n      detail: `,
        replace: `    return {\n      status: "absent",\n      detail: `,
      },
      assertRefusalIsNotAbsence,
    )

    // 3. An unclassified error waved through as "pre-migration" — fail-OPEN on the
    //    unknown, which is how a refusal gets to look like a missing column.
    controlled(
      "an unclassified read error treated as pre-migration (fail-open on the unknown)",
      {
        file: F.resolver,
        find:
          `  if (code && SCHEMA_ABSENT_CODES.has(code)) return { status: "schema_absent", detail }\n` +
          `  return { status: "unreadable", detail }`,
        replace:
          `  if (code === "42501") return { status: "unreadable", detail }\n` +
          `  return { status: "schema_absent", detail }`,
      },
      assertUnknownErrorFailsClosed,
    )

    // 4. THE HEADLINE DEFECT: the cascade descends past a refused tier and hands
    //    back a less-specific owner's credential.
    controlled(
      "the cascade DESCENDING past an unreadable tier (one tier's outage → another tier's credential)",
      {
        file: F.resolver,
        find: `      return { status: "unreadable", ownerType: owner.ownerType, ownerId: owner.ownerId, detail: read.detail }`,
        replace: `      continue`,
      },
      assertCascadeStopsOnUnreadable,
    )

    // 5. …and the same defect measured through REACHABILITY: if the cascade
    //    descends, the gate can never see the state, so the branch dies again.
    controlled(
      "the same descent, measured as reachability — the gate can no longer observe an unreadable IDX check",
      {
        file: F.resolver,
        find: `      return { status: "unreadable", ownerType: owner.ownerType, ownerId: owner.ownerId, detail: read.detail }`,
        replace: `      continue`,
      },
      assertUnreadableIsReachable,
    )

    // 6. The state made unproducible at the source — the wave-18 world, where the
    //    gate's branch existed and could never run.
    controlled(
      "the per-owner read answering ABSENT on a refusal — the state becomes unproducible and the branch dies",
      {
        file: F.resolver,
        find: `    if (error) return classifyReadError(error)`,
        replace: `    if (error) return { status: "absent" }`,
      },
      assertUnreadableIsReachable,
    )

    // 7. The gate repointed back onto the flattening wrapper — every failure
    //    arrives as null again, so `idx_check_unreadable` is dead code again.
    controlled(
      "the gate repointed onto the flattening wrapper (every failure arrives as null)",
      {
        file: F.gate,
        find: `    resolved = await resolveScopedConnectionResult(IDX_PROVIDER, {`,
        replace: `    resolved = await resolveScopedConnection(IDX_PROVIDER, {`,
      },
      assertUnreadableIsReachable,
    )

    // 8. The gate observing unreadability ONLY from a throw — the exact wording of
    //    the wave-18 limitation, reinstated.
    controlled(
      "the gate observing unreadability only from a THROW, never from a resolved refusal",
      {
        file: F.gate,
        find: `  if (resolved.status === "unreadable") {`,
        replace: `  if (false) {`,
      },
      assertUnreadableIsReachable,
    )

    // 9. The wrapper learning to throw — an uncaught exception inside eleven call
    //    sites that have no handler for one.
    controlled(
      "the legacy wrapper learning to THROW on unreadable",
      {
        file: F.resolver,
        find: `  return result.status === "connected" ? result.connection : null`,
        replace:
          `  if (result.status === "unreadable") throw new Error(result.detail)\n` +
          `  return result.status === "connected" ? result.connection : null`,
      },
      assertLegacyWrapperShapeUnchanged,
    )

    // 10. The wrapper leaking the discriminated shape to callers typed for
    //     `ScopedConnection | null`.
    controlled(
      "the legacy wrapper leaking the discriminated result to its twelve callers",
      {
        file: F.resolver,
        find: `): Promise<ScopedConnection | null> {\n  const result = await resolveScopedConnectionResult(provider, ctx)`,
        replace: `): Promise<ScopedConnectionResult> {\n  const result = await resolveScopedConnectionResult(provider, ctx)`,
      },
      assertLegacyWrapperShapeUnchanged,
    )

    // 11. A caller silently migrated off the wrapper — the "do not change the
    //     other eleven" boundary, enforced rather than remembered.
    controlled(
      "an untouched caller silently migrated onto the discriminated resolver",
      {
        file: "lib/idxbroker-client.ts",
        find: `import { resolveScopedConnection } from "@/lib/connections/resolve-scoped"`,
        replace: `import { resolveScopedConnectionResult } from "@/lib/connections/resolve-scoped"`,
      },
      assertUntouchedCallersStillOnTheWrapper,
    )
  }

  console.log("")
  if (failures.length) {
    console.log(`FAILED (${failures.length})`)
    for (const f of failures) console.log(`  · ${f}`)
    process.exit(1)
  }
  console.log(
    "PASSED — a refused credential read is distinguishable from an absent row, the cascade stops rather than serving another owner's credential, and the RentCast gate's unreadable branch is genuinely reachable",
  )
}

main()
