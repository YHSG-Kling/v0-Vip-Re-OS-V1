#!/usr/bin/env tsx
/**
 * scripts/vendor-budget-tier-honesty-simulator.ts
 *   (npm run test:vendor-budget-tier-honesty)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BUDGET GATE'S TIER READ REPORTS ITS DEGRADATION, AND THE GATE STILL FAILS
 * OPEN.
 *
 * `checkVendorBudget` performs TWO reads. The second — the month-to-date ledger
 * read — has always honoured this file's own contract: it destructures `error`
 * and returns `degraded: true` so a caller knows the verdict was FAIL-OPEN
 * rather than measured. The first — the plan-tier read — did not:
 *
 *     const { data: brokerage } = await supabase.from(…)
 *     const planTier = brokerage?.plan_tier ?? "solo_agent"
 *
 * supabase-js RESOLVES a refused query instead of throwing, so a REFUSED tier
 * read arrived as `data: null` and silently became the most restrictive tier on
 * the platform. An enterprise tenant could then be measured against a ceiling
 * that is not its ceiling and told it was over budget — a refusal that looks
 * measured and is not.
 *
 * ── WHAT THIS PROOF STANDS OVER ─────────────────────────────────────────────
 *
 *   E0  The defective spelling survives in this repo only as PROSE. Both
 *       budget-gate.ts and this header quote it to explain it, so every
 *       structural assertion below runs on COMMENT-STRIPPED source. A
 *       prose-blind check would fail on the explanation and pass on the defect.
 *
 *   E1  EVERY supabase read inside `checkVendorBudget` destructures `error` —
 *       enumerated over the FUNCTION BODY, read by read. Not over the file (the
 *       other exports in it are a different contract), and not as a count: a
 *       count is dodged by the next read somebody adds, which is precisely how
 *       the two reads in this one function drifted apart in the first place.
 *
 *   E2  A REFUSED TIER READ IS REPORTED, NOT DEFAULTED. Asserted as a construct
 *       chain rather than a spelling: the identifier the tier read binds its
 *       `error` to must be the identifier a guard tests, that guard must come
 *       BEFORE the plan-tier default is computed, and the branch it guards must
 *       RETURN a result carrying both `degraded` and `degradedTier`.
 *
 *   E3  THE FAIL-OPEN CONTRACT SURVIVES. This gate fails open BY DESIGN — "a
 *       ledger read error must never take a customer flow down" — and wave 18's
 *       RentCast gate leaned on that contract explicitly. The property most at
 *       risk from a well-meaning "fail closed everywhere" edit is therefore the
 *       one asserted hardest: every read-error branch, and the catch, must
 *       return `allowed: true` and must not return `allowed: false`.
 *
 *   E4  THE MEASURED PATH STILL SAYS WHETHER THE CEILING WAS ASSUMED. An absent
 *       tenant record (maybeSingle → null with NO error) is not a refusal: the
 *       verdict is fully measured and may legitimately refuse, so the fail-open
 *       flag stays off — yet the ceiling was still assumed. That is the case one
 *       boolean cannot describe, and it is why the result names WHICH half
 *       degraded. Asserted by linking the flag in the measured return back to a
 *       binding derived from the tier read's own data.
 *
 *   E5  THE ASSUMED TIER IS GENUINELY THE MOST RESTRICTIVE CEILING. Executed,
 *       not read: the constant is lifted out of the source and run through the
 *       real pure evaluator. If a later edit "helpfully" raises the assumption,
 *       an unreadable record becomes a near-uncapped one and this goes red.
 *
 * ── HOW THIS PROOF IS BUILT ─────────────────────────────────────────────────
 *   · Structural assertions read COMMENT-STRIPPED source (E0 guards that).
 *   · The function body is sliced by scanning to the CLOSING PAREN of the
 *     parameter list first. `checkVendorBudget(params: { … }): Promise<…>` puts
 *     braces in the parameter type, so "the first `{` after the name" lands
 *     inside the signature — the exact mistake that produced four false
 *     failures in this repo's last proof.
 *   · Every assertion carries a NEGATIVE CONTROL: the defect is written into the
 *     real file, THE PATCH IS VERIFIED TO HAVE APPLIED (a find-string that
 *     silently no longer matches is theatre), the check is required to flip RED,
 *     and the file is restored and re-verified by sha256.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { createHash } from "node:crypto"
import { MONTHLY_VENDOR_BUDGET_USD, vendorBudgetForTier } from "../lib/vendor-governance/budget-eval"

const ROOT = process.cwd()
const RUN_NEGATIVE = !process.argv.includes("--no-negative")

const F = { gate: "lib/vendor-governance/budget-gate.ts" }
const FN = "checkVendorBudget"

/** The spelling of the defect. Present in PROSE, and nowhere else. */
const DEFECT = "const { data: brokerage } = await supabase"

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
/** Comment-stripped source. Load-bearing: this file quotes the defect it fixed. */
const code = (p: string) =>
  raw(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")

/**
 * The BODY of a named function — everything from the `{` that follows the
 * CLOSING PAREN of the parameter list, to its matching `}`.
 *
 * Deliberately not "the first `{` after the name": this function's parameter
 * type is an inline object (`params: { brokerageId: string … }`), so that
 * shortcut slices the signature and reports the body as empty. Paren depth is
 * counted first, and only then is a brace looked for.
 */
function bodyOf(src: string, fn: string): string | null {
  const m = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${fn}\\s*\\(`).exec(src)
  if (!m) return null
  let i = m.index + m[0].length
  let paren = 1
  for (; i < src.length && paren > 0; i++) {
    if (src[i] === "(") paren++
    else if (src[i] === ")") paren--
  }
  const open = src.indexOf("{", i)
  if (open === -1) return null
  return blockAt(src, open)
}

/** The balanced `{ … }` block starting at `open`. */
function blockAt(src: string, open: number): string {
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

/** Every `.from("…")` read in `body`, with the destructuring that received it. */
interface Read { table: string; at: number; pattern: string | null }
function readsIn(body: string): Read[] {
  // Every read site, however it is written — this is the enumeration a future
  // read cannot dodge by not destructuring at all.
  const sites = [...body.matchAll(/\.from\(\s*"([a-z_]+)"/g)].map((m) => ({
    table: m[1],
    at: m.index ?? 0,
    pattern: null as string | null,
  }))
  // The subset that arrived through a destructuring assignment off an awaited
  // client. `\s*` spans the newline between `await supabase` and `.from(`.
  for (const d of body.matchAll(/const\s*\{([^}]*)\}\s*=\s*await\s+\w+\s*\.from\(\s*"([a-z_]+)"/g)) {
    const fromAt = (d.index ?? 0) + d[0].indexOf('.from(')
    const site = sites.find((s) => s.at === fromAt)
    if (site) site.pattern = d[1]
  }
  return sites
}

/** The identifier a destructuring pattern binds `error` to, or null. */
function errorBinding(pattern: string | null): string | null {
  if (!pattern) return null
  const renamed = /\berror\s*:\s*(\w+)/.exec(pattern)
  if (renamed) return renamed[1]
  return /\berror\b/.test(pattern) ? "error" : null
}

/** The identifier a destructuring pattern binds `data` to, or null. */
function dataBinding(pattern: string | null): string | null {
  if (!pattern) return null
  const renamed = /\bdata\s*:\s*(\w+)/.exec(pattern)
  return renamed ? renamed[1] : (/\bdata\b/.test(pattern) ? "data" : null)
}

/** The `if (<ident>) { … }` block guarding on `ident`, with its start index. */
function guardBlock(body: string, ident: string): { at: number; block: string } | null {
  const m = new RegExp(`if\\s*\\(\\s*${ident}\\s*\\)`).exec(body)
  if (!m) return null
  const open = body.indexOf("{", m.index + m[0].length - 1)
  if (open === -1) return null
  return { at: m.index, block: blockAt(body, open) }
}

function gateBody(): string {
  const b = bodyOf(code(F.gate), FN)
  if (b === null) throw new Error(`could not slice the body of ${FN}`)
  return b
}

// ─────────────────────────────────────────────────────────────────────────────
// E0 — the defect exists as PROSE only, so stripping comments is load-bearing
// ─────────────────────────────────────────────────────────────────────────────
function assertDefectIsProseOnly(): boolean {
  const inProse = raw(F.gate).includes(DEFECT)
  const inCode = code(F.gate).includes(DEFECT)
  return check(
    "E0  the dropped-error spelling survives only in prose — structural checks run comment-stripped",
    inProse && !inCode,
    `quotedInProse=${inProse} presentInCode=${inCode}`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// E1 — every read in the function body destructures `error`
// ─────────────────────────────────────────────────────────────────────────────
function assertEveryReadDestructuresError(): boolean {
  const reads = readsIn(gateBody())
  const blind = reads.filter((r) => errorBinding(r.pattern) === null).map((r) => r.table)
  return check(
    `E1  every supabase read inside ${FN} destructures \`error\` (${reads.length} read site(s) enumerated)`,
    reads.length >= 2 && blind.length === 0,
    `reads=${reads.length} errorBlind=[${blind.join(", ")}]`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// E2 — a refused TIER read is reported as degraded, not silently defaulted
// ─────────────────────────────────────────────────────────────────────────────
function assertRefusedTierReadIsReported(): boolean {
  const body = gateBody()
  const tier = readsIn(body).find((r) => r.table === "brokerages")
  if (!tier) return check("E2  a refused tier read is reported as degraded", false, "no tier read found in the body")

  const errIdent = errorBinding(tier.pattern)
  if (!errIdent) {
    return check("E2  a refused tier read is reported as degraded", false, "the tier read does not bind `error` at all")
  }
  const guard = guardBlock(body, errIdent)
  if (!guard) {
    return check("E2  a refused tier read is reported as degraded", false, `nothing guards on \`${errIdent}\``)
  }
  // The default must not be computed before the refusal is handled — computing
  // it first IS the defect, whatever the guard afterwards says.
  const defaultAt = body.search(/const\s+planTier\s*=/)
  const guardedFirst = defaultAt === -1 || guard.at < defaultAt
  const returns = /\breturn\b/.test(guard.block)
  const saysDegraded = /\bdegraded\s*:\s*true\b/.test(guard.block)
  const saysWhichHalf = /\bdegradedTier\s*:\s*true\b/.test(guard.block)

  return check(
    "E2  the tier read's own error identifier guards a branch that RETURNS a degraded result, before any default tier is computed",
    guardedFirst && returns && saysDegraded && saysWhichHalf,
    `errorBinding=${errIdent} guardBeforeDefault=${guardedFirst} returns=${returns} degraded=${saysDegraded} degradedTier=${saysWhichHalf}`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// E3 — NEGATIVE CONTROL OF THE WHOLE WAVE: the gate still FAILS OPEN
// ─────────────────────────────────────────────────────────────────────────────
function assertStillFailsOpen(): boolean {
  const body = gateBody()
  const reads = readsIn(body)
  const branches: Array<{ name: string; block: string }> = []

  for (const r of reads) {
    const ident = errorBinding(r.pattern)
    if (!ident) continue
    const g = guardBlock(body, ident)
    if (!g) {
      return check(
        "E3  every read-error branch still returns allowed:true (fail-open preserved)",
        false,
        `the ${r.table} read binds \`${ident}\` but nothing guards on it — the fail-open branch does not exist`,
      )
    }
    branches.push({ name: `${r.table}:${ident}`, block: g.block })
  }

  const catchAt = body.search(/\bcatch\b[^{]*\{/)
  if (catchAt === -1) {
    return check("E3  every read-error branch still returns allowed:true (fail-open preserved)", false, "no catch branch")
  }
  branches.push({ name: "catch", block: blockAt(body, body.indexOf("{", catchAt)) })

  const closed = branches.filter((b) => !/\ballowed\s*:\s*true\b/.test(b.block) || /\ballowed\s*:\s*false\b/.test(b.block))
  return check(
    `E3  every read-error branch AND the catch still return allowed:true — the gate did not become fail-closed (${branches.length} branch(es))`,
    branches.length >= 3 && closed.length === 0,
    `failClosed=[${closed.map((b) => b.name).join(", ")}]`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// E4 — the MEASURED verdict still says whether the ceiling was assumed
// ─────────────────────────────────────────────────────────────────────────────
function assertMeasuredVerdictNamesAssumedCeiling(): boolean {
  const body = gateBody()
  const measured = /return\s*\{[^}]*\.\.\.\s*evaluateVendorBudget\s*\([^)]*\)[^}]*\}/.exec(body)
  if (!measured) {
    return check("E4  the measured verdict names an assumed ceiling", false, "no evaluateVendorBudget return found")
  }
  const flag = /\bdegradedTier\s*:\s*(\w+)/.exec(measured[0])
  if (!flag) {
    return check(
      "E4  the measured verdict names an assumed ceiling",
      false,
      "the measured return carries no degradedTier — an assumed ceiling would be indistinguishable from a read one",
    )
  }
  // Construct link: the flag must come from a binding derived from the tier
  // read's OWN data, not from a literal somebody can flip to false.
  const tier = readsIn(body).find((r) => r.table === "brokerages")
  const dataIdent = tier ? dataBinding(tier.pattern) : null
  const binding = new RegExp(`const\\s+${flag[1]}\\s*=([^\\n]*)`).exec(body)
  const derived = !!(binding && dataIdent && binding[1].includes(dataIdent))
  return check(
    "E4  the measured verdict carries a degradedTier derived from the tier read's own data — an ABSENT record yields a measured verdict against an ASSUMED ceiling, and says so",
    derived,
    `flag=${flag[1]} tierData=${dataIdent} derived=${derived}`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// E5 — executed: the assumed tier really is the most restrictive ceiling
// ─────────────────────────────────────────────────────────────────────────────
function assertAssumedTierIsMostRestrictive(): boolean {
  const m = /const\s+ASSUMED_TIER_ON_UNREADABLE\s*=\s*"([a-z_]+)"/.exec(code(F.gate))
  if (!m) {
    return check("E5  the assumed tier is the most restrictive ceiling", false, "no assumed-tier constant found")
  }
  const assumed = m[1]
  const ceilings = Object.values(MONTHLY_VENDOR_BUDGET_USD)
  const lowest = Math.min(...ceilings)
  const assumedCeiling = vendorBudgetForTier(assumed)
  return check(
    `E5  the tier assumed on an unreadable record is the LOWEST ceiling in the table (${assumed} = $${assumedCeiling}, min $${lowest})`,
    assumed in MONTHLY_VENDOR_BUDGET_USD && assumedCeiling === lowest,
    `assumed=${assumed} ceiling=${assumedCeiling} lowest=${lowest}`,
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
    try {
      wentRed = !fn()
    } catch (e) {
      // A slice that can no longer be taken is still the check going red.
      wentRed = true
    }
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

// The defect exactly as it stood before this wave.
const TIER_READ_FIXED = `const { data: brokerage, error: tierError } = await supabase`
const TIER_READ_DEFECT = `const { data: brokerage } = await supabase`

function main(): void {
  console.log("VENDOR BUDGET — TIER-READ HONESTY, FAIL-OPEN PRESERVED\n")
  console.log("ASSERTIONS")
  assertDefectIsProseOnly()
  assertEveryReadDestructuresError()
  assertRefusedTierReadIsReported()
  assertStillFailsOpen()
  assertMeasuredVerdictNamesAssumedCeiling()
  assertAssumedTierIsMostRestrictive()

  if (RUN_NEGATIVE) {
    console.log("\nNEGATIVE CONTROLS")

    // 1+2. THE defect restored: the tier read drops its error. It must red BOTH
    //      the read enumeration and the prose-only guard (the spelling is now in
    //      code), which is what proves comment-stripping is doing real work.
    controlled(
      "the tier read drops its `error` again (E1)",
      { file: F.gate, find: TIER_READ_FIXED, replace: TIER_READ_DEFECT },
      assertEveryReadDestructuresError,
    )
    controlled(
      "the defective spelling present in CODE, not just prose (E0)",
      { file: F.gate, find: TIER_READ_FIXED, replace: TIER_READ_DEFECT },
      assertDefectIsProseOnly,
    )

    // 3. A NEW read that dodges destructuring entirely — the case a count would
    //    miss and an enumeration cannot.
    controlled(
      "a newly added read that destructures nothing at all (E1)",
      {
        file: F.gate,
        find: `    const spent = (rows ?? []).reduce(`,
        replace:
          `    const extra = await supabase.from("brokerages").select("plan_tier").eq("id", params.brokerageId)\n` +
          `    void extra\n` +
          `    const spent = (rows ?? []).reduce(`,
      },
      assertEveryReadDestructuresError,
    )

    // 4. The refusal handled nowhere — error bound, guard gone: the tier default
    //    is computed regardless, which is the defect wearing a destructure.
    controlled(
      "the tier error bound but never guarded — the default computed anyway (E2)",
      { file: F.gate, find: `    if (tierError) {`, replace: `    if (false) {` },
      assertRefusedTierReadIsReported,
    )

    // 5. The refusal branch stops naming which half degraded — one flag for two
    //    different unknowns.
    controlled(
      "the tier-refusal branch stops naming WHICH half degraded (E2)",
      {
        file: F.gate,
        find: `degraded: true, degradedTier: true, degradedSpend: true,\n      }\n    }`,
        replace: `degraded: true, degradedSpend: true,\n      }\n    }`,
      },
      assertRefusedTierReadIsReported,
    )

    // 6-8. THE FAIL-OPEN CONTRACT — the property most at risk from a
    //      well-meaning "fail closed everywhere" edit. One control per branch,
    //      because a single one would let the other two invert unnoticed.
    controlled(
      "the TIER-refusal branch made fail-CLOSED (E3)",
      {
        file: F.gate,
        find: `        allowed: true, spent: 0, budget: DEFAULT_VENDOR_BUDGET, percent: 0, softWarning: false,`,
        replace: `        allowed: false, spent: 0, budget: DEFAULT_VENDOR_BUDGET, percent: 0, softWarning: false,`,
      },
      assertStillFailsOpen,
    )
    controlled(
      "the LEDGER-refusal branch made fail-CLOSED (E3)",
      {
        file: F.gate,
        find: `        allowed: true, spent: 0, budget, percent: 0, softWarning: false, planTier,`,
        replace: `        allowed: false, spent: 0, budget, percent: 0, softWarning: false, planTier,`,
      },
      assertStillFailsOpen,
    )
    controlled(
      "the CATCH branch made fail-CLOSED (E3)",
      {
        file: F.gate,
        find: `      allowed: true, spent: 0, budget: DEFAULT_VENDOR_BUDGET, percent: 0, softWarning: false,\n      planTier: ASSUMED_TIER_ON_UNREADABLE,`,
        replace: `      allowed: false, spent: 0, budget: DEFAULT_VENDOR_BUDGET, percent: 0, softWarning: false,\n      planTier: ASSUMED_TIER_ON_UNREADABLE,`,
      },
      assertStillFailsOpen,
    )

    // 9. The measured path stops distinguishing an assumed ceiling from a read
    //    one — an absent record silently priced as if it were solo_agent.
    controlled(
      "the measured verdict stops naming an assumed ceiling (E4)",
      {
        file: F.gate,
        find: `params.addCost ?? 0), planTier, degradedTier: tierAssumed }`,
        replace: `params.addCost ?? 0), planTier }`,
      },
      assertMeasuredVerdictNamesAssumedCeiling,
    )

    // 10. The flag pinned to a literal instead of the tier read's own data — a
    //     value that can never say "assumed" is not an honesty flag.
    controlled(
      "degradedTier pinned to a literal instead of the tier read's data (E4)",
      { file: F.gate, find: `const tierAssumed = !brokerage?.plan_tier`, replace: `const tierAssumed = false` },
      assertMeasuredVerdictNamesAssumedCeiling,
    )

    // 11. The assumed ceiling "helpfully" raised — an unreadable record becomes
    //     a near-uncapped one.
    controlled(
      "the assumed tier raised off the lowest ceiling (E5)",
      {
        file: F.gate,
        find: `const ASSUMED_TIER_ON_UNREADABLE = "solo_agent"`,
        replace: `const ASSUMED_TIER_ON_UNREADABLE = "multi_location"`,
      },
      assertAssumedTierIsMostRestrictive,
    )
  }

  console.log(
    failures.length === 0
      ? "\nPASS — the tier read reports its degradation, names which half, and the gate still fails open.\n"
      : `\nFAIL — ${failures.length} problem(s):\n${failures.map((f) => `  - ${f}`).join("\n")}\n`,
  )
  process.exit(failures.length === 0 ? 0 : 1)
}

main()
