#!/usr/bin/env tsx
/**
 * scripts/dashboard-data-layer-simulator.ts   (tsx scripts/dashboard-data-layer-simulator.ts)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DASHBOARD DATA LANE — NOW A LEDGER, NOT A CORPSE.
 *
 * ── WHAT THIS PROOF USED TO STAND OVER, AND WHY IT MOVED ─────────────────────
 *
 * `hooks/use-dashboard-data.ts` (19 hooks) and `app/api/dashboard/data/route.ts`
 * (18 branches) were a parallel data layer nothing imported. Wave 13 judged them
 * a DUPLICATE — every branch a strict subset of a live server action, and the
 * one capability the lane appeared to add (SWR + `mutate`) already available over
 * those richer readers — and hardened the route rather than deleting it, because
 * the method is MERGE FIRST and three scoping properties it carried were not yet
 * on their survivors.
 *
 * Wave 16 landed those merges and deleted both files. **A proof cannot outlive
 * what it proves**, so this one moved rather than being retired: its valuable
 * half was never the route's internals, it was the SURVIVOR LEDGER — the record
 * of where each capability went, enforced as data instead of prose.
 *
 * That ledger now lives at `lib/dashboard/data-survivors.ts` and this proof
 * stands over it and over the SURVIVORS themselves.
 *
 * ── WHY THE LEDGER STILL EARNS ITS KEEP AFTER THE DELETE ────────────────────
 *
 * Because the thing that produced this lane can happen again. Someone wanting
 * "one endpoint that fetches any dashboard entity" will write it a second time
 * unless there is a findable record saying where each of those eighteen reads
 * already lives and what each one had to absorb. A verdict that only lives in a
 * commit message is a verdict nobody will find.
 *
 * ── THE FIVE ASSERTIONS ──────────────────────────────────────────────────────
 *   L1  The ledger is TOTAL — every `DashboardDataType` names a survivor, and
 *       every survivor has a merge record. No entity quietly went nowhere.
 *   L2  Every survivor RESOLVES: the file exists and DECLARES that function.
 *       This is what stops the ledger from decaying into 18 plausible strings.
 *   L3  The retired files STAY retired. A returning `app/api/dashboard/data/`
 *       route is the regression this whole wave was about.
 *   L4  No survivor takes its TENANT FROM ITS CALLER. The single defect class
 *       that made the route dangerous was a caller-supplied identity column, so
 *       no survivor may declare a `brokerageId`/`brokerage_id` parameter.
 *   L5  Every survivor DESTRUCTURES `error` on ITS OWN reads. supabase-js
 *       RESOLVES a refused query, so `const { data }` renders "permission
 *       denied" and "you have none" identically — and pre-rollout every table is
 *       EMPTY, which is exactly when that lie is invisible.
 *
 *       Scoped to the survivor FUNCTION'S BODY, not to its file. Several of
 *       these files are thousands of lines holding dozens of unrelated
 *       functions, and a file-wide assertion would report their reads as
 *       failures of this ledger — which is not what this proof is about and
 *       would make it a nag nobody could ever get green. What the retired
 *       branch guaranteed was that ITS read surfaced refusals; the survivor
 *       must guarantee the same for the read that replaced it.
 *
 * ── HOW THIS PROOF IS BUILT ──────────────────────────────────────────────────
 *   · Assertions read the CONSTRUCT, never a spelling, and comment-stripped
 *     source — prose must never satisfy a structural check. (The survivors are
 *     heavily commented and several comments quote the very identifiers being
 *     asserted on, so this is load-bearing rather than ceremonial.)
 *   · Every assertion carries a NEGATIVE CONTROL: the defect is written into the
 *     real file, THE PATCH IS VERIFIED TO HAVE APPLIED (a find-string that
 *     silently no longer matches is theatre, not a control), the check is
 *     required to flip RED, and the file is restored and re-verified by sha256.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { createHash } from "node:crypto"
import { stripComments } from "./strip-comments"
import {
  DASHBOARD_DATA_SURVIVOR,
  DASHBOARD_DATA_MERGE_RECORD,
  RETIRED_DASHBOARD_DATA_FILES,
  type DashboardDataType,
} from "../lib/dashboard/data-survivors"

const ROOT = process.cwd()
const RUN_NEGATIVE = !process.argv.includes("--no-negative")
const LEDGER = "lib/dashboard/data-survivors.ts"

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
/** Comment-stripped source. Prose must never satisfy a structural assertion. */
const code = (p: string) =>
  stripComments(raw(p))

const ENTRIES = Object.entries(DASHBOARD_DATA_SURVIVOR) as Array<[DashboardDataType, string]>
const survivorFiles = [...new Set(ENTRIES.map(([, v]) => v.split(":")[0]))]

// ─────────────────────────────────────────────────────────────────────────────
function assertLedgerTotal(): boolean {
  const missingSurvivor = ENTRIES.filter(([, v]) => !v || !v.includes(":")).map(([k]) => k)
  const missingRecord = ENTRIES.filter(
    ([k]) => !(DASHBOARD_DATA_MERGE_RECORD[k] ?? "").trim(),
  ).map(([k]) => k)
  return check(
    `L1  ledger is total — ${ENTRIES.length} types, each with a survivor and a merge record`,
    missingSurvivor.length === 0 && missingRecord.length === 0,
    `noSurvivor=[${missingSurvivor}] noRecord=[${missingRecord}]`,
  )
}

/** Does `file` actually DECLARE `fn`? Function, const-arrow, or default export. */
function declares(file: string, fn: string): boolean {
  if (!existsSync(resolve(ROOT, file))) return false
  const src = code(file)
  const patterns = [
    new RegExp(`\\bfunction\\s+${fn}\\b`),
    new RegExp(`\\b(?:const|let|var)\\s+${fn}\\s*[:=]`),
    new RegExp(`\\bclass\\s+${fn}\\b`),
    // `export default async function OffersPage()` — the one page in the ledger.
    new RegExp(`export\\s+default\\s+(?:async\\s+)?function\\s+${fn}\\b`),
  ]
  return patterns.some((re) => re.test(src))
}

function assertSurvivorsResolve(): boolean {
  const broken = ENTRIES.filter(([, v]) => {
    const [file, fn] = v.split(":")
    return !declares(file, fn)
  }).map(([k, v]) => `${k}→${v}`)
  return check(
    "L2  every named survivor resolves to a function its file really declares",
    broken.length === 0,
    broken.join(", "),
  )
}

function assertRetiredStayRetired(): boolean {
  const back = RETIRED_DASHBOARD_DATA_FILES.filter((f) => existsSync(resolve(ROOT, f)))
  return check(
    "L3  the retired lane files stay retired",
    back.length === 0,
    back.length ? `${back.join(", ")} is back` : "",
  )
}

/**
 * L4 — no survivor accepts its TENANT from its caller.
 *
 * Scoped to each survivor's OWN parameter list, not the whole file: several of
 * these modules legitimately pass `brokerageId` DOWN to a service layer after
 * resolving it from the session, and forbidding the identifier outright would
 * forbid the correct pattern along with the defect.
 */
function tenantParamOf(file: string, fn: string): string | null {
  const src = code(file)
  const m = new RegExp(
    `(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+${fn}\\s*\\(`,
  ).exec(src)
  if (!m) return null
  const open = src.indexOf("(", m.index + m[0].length - 1)
  let depth = 0
  let i = open
  for (; i < src.length; i++) {
    if (src[i] === "(") depth++
    else if (src[i] === ")") {
      depth--
      if (depth === 0) break
    }
  }
  const params = src.slice(open + 1, i)
  return /\bbrokerage_?[Ii]d\s*[?:]/.test(params) ? params.replace(/\s+/g, " ").trim() : null
}

function assertNoCallerSuppliedTenant(): boolean {
  const offenders: string[] = []
  for (const [k, v] of ENTRIES) {
    const [file, fn] = v.split(":")
    const p = tenantParamOf(file, fn)
    if (p) offenders.push(`${k}→${fn}(${p.slice(0, 60)})`)
  }
  return check(
    "L4  no survivor takes its tenant from its caller",
    offenders.length === 0,
    offenders.join(" | "),
  )
}

/**
 * L5 — a refused read is never rendered as an empty one.
 *
 * Asserted per FILE over the survivor set: every `await`ed supabase query in a
 * survivor file must destructure `error`. Counting bare `const { data } = await`
 * is the construct — a rename of the variable keeps it caught, and a comment
 * mentioning `error` cannot satisfy it because the source is comment-stripped.
 */
/** The source of `fn`'s own body in `file`, brace-matched. Null if not found. */
function bodyOf(file: string, fn: string): string | null {
  if (!existsSync(resolve(ROOT, file))) return null
  const src = code(file)
  const m = new RegExp(
    `(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+${fn}\\s*\\(`,
  ).exec(src)
  if (!m) return null
  const open = src.indexOf("{", m.index + m[0].length)
  if (open === -1) return null
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}") {
      depth--
      if (depth === 0) return src.slice(open + 1, i)
    }
  }
  return null
}

/** Reads in `body` that destructure `data` without `error`. */
function bareDataReads(body: string): number {
  let n = 0
  for (const m of body.matchAll(/const\s*\{([^}]*)\}\s*=\s*await\s+/g)) {
    const destructured = m[1]
    if (!/\bdata\b/.test(destructured)) continue
    if (/\berror\b/.test(destructured)) continue
    n++
  }
  return n
}

function assertRefusalsSurfaced(): boolean {
  const offenders: string[] = []
  const unreadable: string[] = []
  for (const [k, v] of ENTRIES) {
    const [file, fn] = v.split(":")
    const body = bodyOf(file, fn)
    if (body === null) {
      // L2 already fails on a survivor that does not resolve; a body this proof
      // cannot read must never be scored as CLEAN — that is how an assertion
      // quietly stops asserting.
      unreadable.push(`${k}→${fn}`)
      continue
    }
    const n = bareDataReads(body)
    if (n > 0) offenders.push(`${k}→${fn}(${n})`)
  }
  return check(
    "L5  every survivor destructures `error` in its own body",
    offenders.length === 0 && unreadable.length === 0,
    [offenders.join(", "), unreadable.length ? `unreadable body: ${unreadable.join(", ")}` : ""]
      .filter(Boolean)
      .join(" | "),
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

/** L2/L3/L4 read the ledger through `import`, so they must re-read from disk. */
function reReadLedgerAnd(fn: (led: Record<string, string>) => boolean): boolean {
  const src = raw(LEDGER)
  const body = /DASHBOARD_DATA_SURVIVOR[^=]*=\s*\{([\s\S]*?)\n\}/.exec(src)
  if (!body) return false
  const led: Record<string, string> = {}
  for (const m of body[1].matchAll(/(\w+)\s*:\s*"([^"]+)"/g)) led[m[1]] = m[2]
  return fn(led)
}

function assertSurvivorsResolveFromDisk(): boolean {
  return reReadLedgerAnd((led) => {
    const broken = Object.entries(led).filter(([, v]) => {
      const [file, fn] = v.split(":")
      return !declares(file, fn)
    })
    return check(
      "L2  every named survivor resolves to a function its file really declares",
      broken.length === 0,
      broken.map(([k, v]) => `${k}→${v}`).join(", "),
    )
  })
}

function main(): void {
  console.log("DASHBOARD DATA SURVIVOR LEDGER\n")
  console.log("ASSERTIONS")
  assertLedgerTotal()
  assertSurvivorsResolve()
  assertRetiredStayRetired()
  assertNoCallerSuppliedTenant()
  assertRefusalsSurfaced()

  console.log(`\n  ${ENTRIES.length} data types → ${survivorFiles.length} survivor files`)

  if (RUN_NEGATIVE) {
    console.log("\nNEGATIVE CONTROLS")

    // 1. A ledger entry naming a function that does not exist — the way a ledger
    //    rots: the string stays plausible while the code moves out from under it.
    controlled(
      "a ledger entry pointing at a function that does not exist",
      {
        file: LEDGER,
        find: `contacts:       "app/actions/contacts.ts:getContacts"`,
        replace: `contacts:       "app/actions/contacts.ts:getContactsRenamedAway"`,
      },
      assertSurvivorsResolveFromDisk,
    )

    // 2. The ledger points at a file that no longer exists at all.
    controlled(
      "a ledger entry pointing at a deleted file",
      {
        file: LEDGER,
        find: `vendors:        "app/actions/vendor-marketplace.ts:searchVendors"`,
        replace: `vendors:        "app/actions/vendor-marketplace-gone.ts:searchVendors"`,
      },
      assertSurvivorsResolveFromDisk,
    )

    // 3. The retired route comes back. This is THE regression.
    const revived = "app/api/dashboard/data/route.ts"
    {
      const before = existsSync(resolve(ROOT, revived))
      const dir = resolve(ROOT, "app/api/dashboard/data")
      mkdirSync(dir, { recursive: true })
      writeFileSync(resolve(ROOT, revived), "export {}\n")
      const mark = failures.length
      const wentRed = !assertRetiredStayRetired()
      while (failures.length > mark) failures.pop()
      rmSync(dir, { recursive: true, force: true })
      console.log(
        wentRed
          ? "  ✓ NEGATIVE CONTROL the retired route file comes back — went RED as required"
          : "  ✗ NEGATIVE CONTROL the retired route file comes back — STAYED GREEN",
      )
      if (!wentRed) failures.push("negative control stayed green: retired route revived")
      if (before) failures.push("retired route existed before its own control ran")
    }

    // 4. A survivor grows a caller-supplied tenant parameter — the exact defect
    //    class that made the route dangerous.
    controlled(
      "a survivor grows a caller-supplied brokerageId parameter",
      {
        file: "app/actions/transactions.ts",
        find: "export async function getTransactions(filters?: {\n  status?: string",
        replace: "export async function getTransactions(filters?: {\n  brokerageId?: string\n  status?: string",
      },
      assertNoCallerSuppliedTenant,
    )

    // 5. A survivor stops destructuring `error` on a read.
    controlled(
      "a survivor read stops destructuring `error`",
      {
        file: "app/actions/communications.ts",
        find: "const { data, error } = await supabase\n      .from(\"messages\")",
        replace: "const { data } = await supabase\n      .from(\"messages\")",
      },
      assertRefusalsSurfaced,
    )
  }

  console.log("")
  if (failures.length) {
    console.log(`FAILED (${failures.length})`)
    for (const f of failures) console.log(`  · ${f}`)
    process.exit(1)
  }
  console.log("PASSED — the lane is gone and every capability it carried has a named, resolving home")
}

main()
