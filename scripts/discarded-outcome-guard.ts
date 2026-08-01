/**
 * scripts/discarded-outcome-guard.ts
 *
 * test:discarded-outcome — THE UI MAY NOT CLAIM AN OUTCOME IT NEVER CHECKED.
 *
 * THE DEFECT, in the owner's words: the user executes something on the UI side,
 * it looks like it is running, the business process and the backend are
 * programmed correctly — and the middle does not know what it needs to do.
 *
 * Concretely:
 *
 *     await approveInspectionQuoteAction({ ... })   // returns {success:false,...}
 *     toast({ title: "Approved" })                  // says it worked regardless
 *     router.refresh()
 *
 * The action is correct. It checks authorisation, it checks that the transaction
 * belongs to the caller's brokerage, and it REPORTS failure honestly by
 * returning { success: false, error }. The caller throws that away. So a broker
 * clicks Approve, the spinner completes, the page refreshes, and nothing at all
 * happened — with no error anywhere, because nobody asked.
 *
 * THE DISCRIMINATOR THAT MAKES THIS PRECISE, and the reason a first attempt at
 * this detector was 48 hits of mostly-noise. There are two ways an action
 * reports failure, and only one of them can be dropped:
 *
 *   · THROWS  — `if (txnError) throw txnError`. The caller's try/catch handles
 *               it. Discarding the return value is CORRECT and common, e.g.
 *               assignTransactionCoordinator. Not a defect. Not flagged.
 *   · RETURNS — `return { success: false, error }`. The failure lives entirely
 *               in the value. Discard it and the failure ceases to exist.
 *
 * So this guard resolves each awaited call to its definition, keeps only the
 * actions that report failure BY RETURN, and flags the client callers that
 * discard the result and then show success anyway (a toast, a dialog close, a
 * router.refresh). That narrowed 48 candidates to a list where every entry is
 * the real shape.
 *
 * WHY THIS PATTERN IS DIFFERENT FROM THE OTHERS THIS REPO TRACKS. The identity
 * guards catch a wrong VALUE. The error-message guard catches a wrong
 * EXPLANATION. This one catches a missing CONVERSATION: two correct layers that
 * never exchanged the one fact that mattered. It is the hardest kind to notice
 * from the outside, because the screen shows exactly what success looks like.
 *
 * RATCHET, not an invariant. A discarded result can be legitimate — a
 * fire-and-forget telemetry ping, an action whose failure genuinely does not
 * change what the user should see. Each entry needs a human to decide whether
 * the user would want to know. The number may only go down.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"

const read = (p: string) => { try { return readFileSync(p, "utf8") } catch { return "" } }
function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${e.name}`
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue
      walk(full, out)
    } else if (/\.tsx?$/.test(e.name)) out.push(full)
  }
  return out
}

/**
 * RESOLVE THE IMPORT, DO NOT MATCH THE NAME. This codebase has TWO exported
 * functions called disconnectSocialAccount: the one in social-media-automation
 * RETURNS { success:false }, and the one in social-publishing THROWS. A
 * name-only match flagged the page that imports the throwing one — correct code
 * whose try/catch was exactly right — and very nearly "fixed" it into a type
 * error. Keying on `${module}#${name}` is the difference between a detector that
 * finds bugs and one that manufactures them.
 */
function moduleKey(specifier: string, importerFile: string): string {
  if (specifier.startsWith("@/")) return specifier.slice(2)
  if (specifier.startsWith(".")) {
    const dir = importerFile.split("/").slice(0, -1)
    for (const part of specifier.split("/")) {
      if (part === ".") continue
      else if (part === "..") dir.pop()
      else dir.push(part)
    }
    return dir.join("/")
  }
  return specifier
}
/** name -> the modules that import it, per client file. */
function importedFrom(src: string, file: string): Map<string, string> {
  const m = new Map<string, string>()
  for (const im of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const mod = moduleKey(im[2], file)
    for (const raw of im[1].split(",")) {
      const name = raw.split(/\s+as\s+/).pop()!.trim()
      if (name) m.set(name, mod)
    }
  }
  return m
}

/** Actions that report failure BY RETURN VALUE — the only ones worth tracking. */
function actionsThatReturnFailure(files: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const f of files) {
    const s = read(f)
    for (const m of s.matchAll(/export\s+async\s+function\s+(\w+)/g)) {
      let body = s.slice(m.index! + m[0].length, m.index! + m[0].length + 6000)
      const nxt = body.search(/\nexport\s+async\s+function\s/)
      if (nxt !== -1) body = body.slice(0, nxt)
      if (/return\s*\{[^}]*success:\s*false/.test(body)) out.set(`${f.replace(/^\.\//, "").replace(/\.tsx?$/, "")}#${m[1]}`, f)
    }
  }
  return out
}

/** A visible claim that the thing worked. */
const SUCCESS_SIGNAL = /toast\(\s*\{[^}]*title|setOpen\(false\)|setIsOpen\(false\)|setSuccess\(true\)|router\.(?:push|refresh)\(/
/** Any inspection of the outcome at all. */
const OUTCOME_READ = /\.(?:success|ok|error)\b|\bif\s*\(/

interface Hit { file: string; line: number; fn: string; definedIn: string }

function findDiscarded(files: string[], returnsFailure: Map<string, string>): Hit[] {
  const hits: Hit[] = []
  for (const file of files) {
    if (!file.endsWith(".tsx")) continue
    const s = read(file)
    if (!s.includes('"use client"') && !s.includes("'use client'")) continue
    const imports = importedFrom(s, file)
    for (const m of s.matchAll(/(?<![=\w.])await\s+(\w+)\s*\(/g)) {
      const fn = m[1]
      const mod = imports.get(fn)
      if (!mod) continue
      const definedIn = returnsFailure.get(`${mod}#${fn}`)
      if (!definedIn) continue
      const after = s.slice(m.index! + m[0].length, m.index! + m[0].length + 600)
      const succ = after.match(SUCCESS_SIGNAL)
      if (!succ) continue
      if (OUTCOME_READ.test(after.slice(0, succ.index!))) continue
      hits.push({ file, line: s.slice(0, m.index!).split("\n").length, fn, definedIn })
    }
  }
  return hits
}

let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}

const FILES = [...walk("app"), ...walk("lib"), ...walk("components")]
const RETURNS_FAILURE = actionsThatReturnFailure(FILES)

// 13 after the inspections + portal clusters were fixed AND the detector was
// taught to resolve imports (name-matching had inflated the count with
// same-named-but-throwing actions). Lower it as callers start reading their
// outcomes; never raise it.
const BASELINE = 13

console.log("\n═══ 1. No UI claims success without reading the outcome ═══")
const hits = findDiscarded(FILES, RETURNS_FAILURE)
{
  for (const h of hits) console.log(`     ${h.file}:${h.line}  await ${h.fn}(…)  — returns success:false in ${h.definedIn}`)
  ok(`client callers discarding a returned failure, at or below ${BASELINE} (found ${hits.length})`,
    hits.length <= BASELINE,
    `${hits.length} > ${BASELINE} — a new screen claims an outcome nobody checked`)
}

console.log("\n═══ 2. The discriminator holds in both directions ═══")
{
  ok("the catalogue only contains actions that report failure BY RETURN,\n    which is what makes discarding it fatal",
    RETURNS_FAILURE.size > 0 &&
    /return\s*\{[^}]*success:\s*false/.test(read("app/actions/transaction-inspections.ts")))

  // The two-functions-one-name case that name-matching got wrong.
  ok("disconnectSocialAccount resolves per IMPORT — social-publishing THROWS and\n    must not be flagged, social-media-automation RETURNS and must be",
    /throw new Error\("Unauthorized"\)/.test(read("app/actions/social-publishing.ts")) &&
    RETURNS_FAILURE.has("app/actions/social-media-automation#disconnectSocialAccount") &&
    !RETURNS_FAILURE.has("app/actions/social-publishing#disconnectSocialAccount"))

  // assignTransactionCoordinator THROWS (`if (txnError) throw txnError`) and its
  // caller wraps the await in try/catch. Discarding the return value there is
  // correct, and an earlier version of this detector flagged it — 48 hits, most
  // of them noise. A guard that flags correct code teaches people to ignore it.
  const mp = read("app/actions/multi-persona.ts")
  ok("assignTransactionCoordinator still reports failure by THROWING, so it is\n    correctly absent from the catalogue",
    /throw txnError/.test(mp) && !RETURNS_FAILURE.has("app/actions/multi-persona#assignTransactionCoordinator"))
}

console.log("\n═══ 3. The transaction-inspections cluster reads its outcomes ═══")
{
  // Five money/compliance approvals on one screen, every one of them discarded:
  // approve inspection quote, approve insurance quote, mark inspection complete,
  // submit insurance quote approval, update earnest money. Each action checks
  // authorisation and brokerage ownership and returns { success:false, error } —
  // and the screen said "done" regardless.
  const c = read("app/dashboard/transactions/[id]/transaction-detail-client.tsx")
  // ASSERT THE CONSTRUCT, NOT ITS SYNTAX. A first version of this required the
  // literal shape `const x = await fn(` and failed on the two calls that sit in
  // a ternary — correct code, wrong shape. An assertion that pins a spelling
  // rather than a behaviour is the same error this repo has now paid for three
  // times. What matters is that the outcome is READ before the screen moves on.
  for (const fn of [
    "approveInspectionQuoteAction", "approveInsuranceQuoteAction", "markInspectionCompleteAction",
    "submitInsuranceQuoteApprovalAction", "updateEarnestMoneyAction",
  ]) {
    const at = c.indexOf(`await ${fn}`)
    const window = at === -1 ? "" : c.slice(at, at + 900)
    ok(`${fn} — its outcome is read before the screen claims success`,
      at !== -1 && /!res\?\.success|!result\?\.success|\.success\b/.test(window))
  }
}

console.log("\n═══ 4. The partner portals read their outcomes (m378) ═══")
{
  // These are the ones an OUTSIDE party sees. A lender moves the loan status, a
  // title company ticks a closing item — the page refreshes, the old value is
  // still there, and nothing was said. Worse than an internal miss: the partner
  // has no way to tell a refused update from a slow one, and no support path.
  //
  // Every one of these files already had an `error` state and used it elsewhere.
  // lender-actions even checks r.error on its createLenderApplication call, four
  // lines above a sibling that did not. The same "some paths fixed, others not"
  // shape the CDA and activities clusters had.
  const PORTAL: Array<[string, string]> = [
    ["app/portal/lender/[transactionId]/lender-actions.tsx", "flagLenderIssue"],
    ["app/portal/lender/[transactionId]/lender-actions.tsx", "updateLenderLoanStatus"],
    ["app/portal/lender/[transactionId]/lender-actions.tsx", "updateLenderApplicationStatus"],
    ["app/portal/title/[transactionId]/title-actions.tsx", "updateTitleStatus"],
    ["app/portal/title/[transactionId]/closing-checklist.tsx", "updateClosingPrepItem"],
  ]
  for (const [file, fn] of PORTAL) {
    const src = read(file)
    const at = src.indexOf(`await ${fn}`)
    ok(`${fn} — the portal reads the outcome before refreshing`,
      at !== -1 && /!r\?\.success/.test(src.slice(at, at + 700)))
  }
}

console.log(`\n${"═".repeat(70)}`)
console.log(`DISCARDED OUTCOME — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  console.log("\nThe action told the truth. The screen did not pass it on.")
  process.exit(1)
}
console.log(`${hits.length} client callers discard a returned failure (baseline ${BASELINE}).`)
console.log("A REVIEW QUEUE: some discards are legitimate. Ask whether the user")
console.log("would want to know, then read the outcome or say why you did not.")
