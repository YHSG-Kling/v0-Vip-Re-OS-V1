#!/usr/bin/env tsx
/**
 * scripts/wired-surface-guard.ts  (npm run test:wired-surface) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MISSING MIDDLE.
 *
 * Owner's words, and they name the class exactly:
 *
 *   "the ui and the business process/backend know what to do but the middle
 *    doesn't — this type of sweep needs to be expanded so we can finish burning
 *    down these issues"
 *
 * This is not a bug list. It is one defect shape wearing many costumes:
 *
 *   A real control exists. A real capability exists. NOTHING CONNECTS THEM.
 *
 * It is uniquely hard to see, because it is invisible from both ends. Reviewing
 * the UI, the button is right there and looks finished. Reviewing the server
 * action, it is complete, typed, tenant-scoped and tested. Only the JOIN is
 * absent, and nothing in TypeScript, in a linter, or in a code review that reads
 * one file at a time will ever say so. `tsc` is perfectly happy with a <Button>
 * that does nothing — that is a valid button.
 *
 * Confirmed instances that motivated this guard, all found in one sweep:
 *   · "Launch Listing" — the single most prominent control on the listing
 *     lifecycle page, the one the whole readiness checklist counts down to — had
 *     NO onClick. launchListingAction was complete and reachable from nowhere.
 *   · "Save for Buyer" / "Add to Tour" / "Send Now" on every property-alert
 *     match: three buttons, three complete backends, zero handlers.
 *   · markResultViewed: complete, zero callers, so the agent's unviewed badge
 *     counted up forever and could never come down.
 *   · The alert email's primary CTA pointed at /portal/alerts/<id> — a route
 *     that has never existed. Every buyer who tapped it got a 404.
 *
 * ── WHAT THIS GUARD ASSERTS ─────────────────────────────────────────────────
 *
 * TWO INVARIANTS, both ratcheted against a baseline rather than demanded at
 * zero, because the existing debt is real and a guard that cannot go green is a
 * guard people delete:
 *
 *   1. INERT CONTROL — a <Button>/<DropdownMenuItem> with no onClick, no
 *      asChild, no type="submit", not inside a Link/DialogTrigger/form.
 *   2. ORPHAN ACTION — an exported "use server" function in app/actions/** with
 *      no caller anywhere in the app.
 *
 * NEW instances of either fail the build. The baselines may only go DOWN — a
 * check enforces that, so this burns down and cannot silently refill.
 *
 * ── WHY IT IS DELIBERATELY CONSERVATIVE ─────────────────────────────────────
 * A false positive here costs someone an afternoon proving a working button
 * works, and two of those and the guard gets switched off. So every recognised
 * wiring idiom is allowed, and anything ambiguous is NOT flagged. The sweep that
 * produced the baseline found ~14 shapes that look inert to a naive regex and
 * are correctly wired (parent Card carries the onClick, DialogTrigger asChild,
 * DropdownMenuTrigger asChild, a multi-line <Link> wrapper, passed as a `trigger`
 * prop). Missing one real defect is recoverable. Crying wolf is not.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${n}${detail ? `\n      ${detail}` : ""}`) }
}

const BASELINE_PATH = "scripts/wired-surface-baseline.json"

/** PURE — how many inert controls each file holds. */
function tally(files: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const f of files.sort()) out[f] = (out[f] ?? 0) + 1
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE DETECTOR 1 — an inert control
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every way this codebase legitimately wires a control. Presence of ANY of these
 * on the element (or on the enclosing line-range) means "wired" and it is not
 * reported. Add to this list, never narrow it.
 */
const WIRING_ATTRS = [
  "onClick", "onSubmit", "onValueChange", "onPress", "onSelect", "onCheckedChange",
  "asChild",            // Radix: the child (a Link, a form button) carries the behaviour
  "type=\"submit\"",    // inside a <form action={...}>
  "type={\"submit\"}",
  "formAction",
  "href",               // a Button rendered as an anchor
] as const

/**
 * Wrappers that carry the behaviour for a child button. If the control sits
 * inside one of these, it is wired even with no attribute of its own.
 */
const WIRING_WRAPPERS = [
  "<Link", "<a ", "<form", "<DialogTrigger", "<AlertDialogTrigger", "<SheetTrigger",
  "<DropdownMenuTrigger", "<PopoverTrigger", "<TooltipTrigger", "<CollapsibleTrigger",
  "<DialogClose", "<AlertDialogCancel", "<AlertDialogAction", "<label",
] as const

/** PURE — the tag text of the element starting at `<Button` / `<DropdownMenuItem` at i. */
export function elementTag(src: string, i: number): string {
  let depth = 0, quote: string | null = null, esc = false, brace = 0
  for (let p = i; p < src.length; p++) {
    const c = src[p]
    if (esc) { esc = false; continue }
    if (quote) { if (c === "\\") esc = true; else if (c === quote) quote = null; continue }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue }
    if (c === "{") brace++
    else if (c === "}") brace--
    else if (c === "<") depth++
    else if (c === ">" && brace === 0) { depth--; if (depth === 0) return src.slice(i, p + 1) }
  }
  return src.slice(i, Math.min(src.length, i + 800))
}

/**
 * PURE — is the control at index `i` inert?
 *
 * `lookbehind` covers the wrapper case: a <Link> or <DialogTrigger asChild> on a
 * preceding line. 400 chars is enough for a multi-line wrapper and short enough
 * that an unrelated <Link> elsewhere in the file does not mask a real finding.
 */
export function isInertControl(src: string, i: number): boolean {
  const tag = elementTag(src, i)
  if (WIRING_ATTRS.some((a) => tag.includes(a))) return false

  const lookbehind = src.slice(Math.max(0, i - 400), i)
  // A wrapper only counts if it has not been CLOSED before our control starts.
  for (const w of WIRING_WRAPPERS) {
    const at = lookbehind.lastIndexOf(w)
    if (at === -1) continue
    const closeTag = w.replace("<", "</").trim()
    if (!lookbehind.slice(at).includes(closeTag)) return false
  }
  // A `trigger={...}` / `action={...}` prop means the element is being PASSED
  // somewhere that wires it.
  if (/\b(trigger|action|render|as)=\{\s*$/.test(lookbehind)) return false
  return true
}

// ─────────────────────────────────────────────────────────────────────────────
// FILE WALK
// ─────────────────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build", "coverage"])

function walk(dir: string, ext: string[], out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, ext, out)
    else if (ext.some((x) => e.name.endsWith(x))) out.push(p)
  }
  return out
}

const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "").replace(/^[ \t]*\/\/.*$/gm, "")

console.log("══════════════════════════════════════════════════")
console.log(" Wired surface — a control that exists must reach the capability that exists")
console.log("══════════════════════════════════════════════════")

console.log("\n[pure — the inert-control detector]")
{
  const inert = `<Button size="sm">Save for Buyer</Button>`
  check("flags a Button with no handler at all", isInertControl(inert, 0) === true)
  check("accepts onClick", isInertControl(`<Button onClick={go}>Go</Button>`, 0) === false)
  check("accepts asChild (Radix hands behaviour to the child)",
    isInertControl(`<Button asChild><Link href="/x">Go</Link></Button>`, 0) === false)
  check("accepts a submit button inside a form",
    isInertControl(`<Button type="submit">Save</Button>`, 0) === false)

  // The false-positive shapes the sweep actually hit. Each one cost real time.
  const wrapped = `<Link href="/dashboard/x">\n  <Button size="sm">Open</Button>\n</Link>`
  check("accepts a Button wrapped in a Link (multi-line)",
    isInertControl(wrapped, wrapped.indexOf("<Button")) === false)
  const trigger = `<DialogTrigger asChild>\n  <Button>Schedule</Button>\n</DialogTrigger>`
  check("accepts a DialogTrigger asChild wrapper",
    isInertControl(trigger, trigger.indexOf("<Button")) === false)
  const dropdown = `<DropdownMenuTrigger asChild>\n  <Button>More</Button>\n</DropdownMenuTrigger>`
  check("accepts a DropdownMenuTrigger asChild wrapper",
    isInertControl(dropdown, dropdown.indexOf("<Button")) === false)
  const passed = `<ConfirmDialog trigger={\n  <Button>Delete</Button>\n} />`
  check("accepts a Button passed as a `trigger` prop",
    isInertControl(passed, passed.indexOf("<Button")) === false)

  // A CLOSED wrapper earlier in the file must NOT mask a later real defect —
  // this is the direction that would make the guard useless.
  const closedBefore = `<Link href="/a"><Button onClick={x}>A</Button></Link>\n<Button>B</Button>`
  check("a CLOSED wrapper earlier does not mask a later inert control",
    isInertControl(closedBefore, closedBefore.lastIndexOf("<Button")) === true)
}

// KEYED BY FILE, NOT file:line — deliberately.
//
// The first version keyed on `file:line`, and inserting ONE line above an
// existing inert control renumbered it, so a single new defect reported as
// three. A guard that reports two innocents alongside every real finding is a
// guard people learn to skim, then switch off. Counting per file is stable under
// line shifts and still catches every addition, which is the property that
// matters.
console.log("\n[repo scan — inert controls]")
const inertFound: string[] = []
{
  const files = walk("app", [".tsx"])
  for (const f of files) {
    const src = strip(readFileSync(f, "utf8"))
    for (const m of src.matchAll(/<(Button|DropdownMenuItem|CommandItem)\b/g)) {
      if (isInertControl(src, m.index!)) inertFound.push(f)
    }
  }
  console.log(`  · ${files.length} tsx files · ${inertFound.length} inert controls`)
}

console.log("\n[repo scan — orphan server actions]")
const orphanFound: string[] = []
{
  const actionFiles = walk("app/actions", [".ts"])
  const callerFiles = [...walk("app", [".ts", ".tsx"]), ...walk("lib", [".ts", ".tsx"]), ...walk("hooks", [".ts", ".tsx"])]
  const callerSrc = new Map(callerFiles.map((f) => [f, readFileSync(f, "utf8")]))

  for (const f of actionFiles) {
    const src = readFileSync(f, "utf8")
    if (!/^["']use server["']/m.test(src)) continue
    for (const m of src.matchAll(/export\s+async\s+function\s+(\w+)/g)) {
      const name = m[1]
      let referenced = false
      for (const [cf, cs] of callerSrc) {
        if (cf === f) continue
        if (new RegExp(`\\b${name}\\b`).test(cs)) { referenced = true; break }
      }
      if (!referenced) orphanFound.push(`${f}:${name}`)
    }
  }
  console.log(`  · ${actionFiles.length} action files · ${orphanFound.length} orphan actions`)
}

console.log("\n[ratchet — new instances fail, the baseline may only go DOWN]")
{
  const baseline = existsSync(BASELINE_PATH)
    ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
    : null

  if (!baseline || process.env.WIRED_SURFACE_REBASELINE === "1") {
    writeFileSync(BASELINE_PATH, JSON.stringify(
      { inertByFile: tally(inertFound), orphanActions: orphanFound.sort() }, null, 2) + "\n")
    console.log(`  · baseline written: ${inertFound.length} inert, ${orphanFound.length} orphan`)
    check("baseline created (re-run to enforce)", true)
  } else {
    const wasInertByFile: Record<string, number> = baseline.inertByFile ?? {}
    const nowInertByFile = tally(inertFound)
    const wasOrphan = new Set<string>(baseline.orphanActions ?? [])

    // A file REGRESSES when it holds more inert controls than it was allowed.
    // A brand-new file with any inert control regresses from an implicit 0.
    const regressed = Object.entries(nowInertByFile)
      .filter(([f, n]) => n > (wasInertByFile[f] ?? 0))
      .map(([f, n]) => `${f} (${wasInertByFile[f] ?? 0} → ${n})`)
    const newOrphan = orphanFound.filter((x) => !wasOrphan.has(x))

    check(`no file gained an inert control (${regressed.length})`, regressed.length === 0,
      regressed.slice(0, 6).join("\n      "))
    check(`no NEW orphan server action (${newOrphan.length})`, newOrphan.length === 0,
      newOrphan.slice(0, 6).join("\n      "))

    // The burn-down half. Without this the baseline is a place to hide.
    const baselineInertTotal = Object.values(wasInertByFile).reduce((a, b) => a + b, 0)
    check(`inert total did not grow (${inertFound.length} ≤ ${baselineInertTotal})`,
      inertFound.length <= baselineInertTotal)
    check(`orphan baseline did not grow (${orphanFound.length} ≤ ${wasOrphan.size})`,
      orphanFound.length <= wasOrphan.size)

    const fixedInert = baselineInertTotal - inertFound.length
    const fixedOrphan = [...wasOrphan].filter((x) => !orphanFound.includes(x)).length
    if (fixedInert > 0 || fixedOrphan > 0) {
      console.log(`  · burned down this pass: ${fixedInert} inert, ${fixedOrphan} orphan`)
      console.log(`  · run WIRED_SURFACE_REBASELINE=1 npm run test:wired-surface to lock the gain in`)
    }
  }
}

console.log("\n[the surfaces fixed in this pass stay fixed]")
{
  const src = (p: string) => (existsSync(p) ? strip(readFileSync(p, "utf8")) : "")
  const alerts = src("app/crm/contacts/[contactId]/alerts/page.tsx")
  check("alerts: Save for Buyer is wired", /saveAlertResultForBuyer\(r\.id, "saved"\)/.test(alerts))
  check("alerts: Add to Tour is wired", /saveAlertResultForBuyer\(r\.id, "tour_requested"\)/.test(alerts))
  check("alerts: Send Now is wired", /sendAlertResultNow\(r\.id\)/.test(alerts))
  check("alerts: every one READS its outcome, so a refusal is not a silent no-op",
    /res\.success \? \{ ok: true/.test(alerts))
  check("alerts: opening a match marks it viewed (the badge can finally come down)",
    /markResultViewed\(r\.id, contactId\)/.test(alerts))

  const actions = src("app/actions/property-alerts/alert-actions.ts")
  check("alerts: in-house AND outside properties both handled, decided SERVER-side",
    /if \(row\.listing_id\) return row\.listing_id/.test(actions)
    && /return `ext_idx_\$\{row\.mls_number\}`/.test(actions))
  check("alerts: a send that reached zero channels is reported as NOT sent",
    /if \(delivery\.sent === 0\)/.test(actions))

  const notifier = src("lib/property-alerts/alert-notifier.ts")
  check("the buyer's alert link is contact-scoped (it 404'd for every buyer)",
    /\/portal\/\$\{alert\.contact_id\}\/alerts\/\$\{alert\.id\}/.test(notifier))
  check("…and no longer sends the BUYER to an agent CRM route",
    !/\/crm\/contacts\/\$\{alert\.contact_id\}/.test(notifier))
  check("the route the email points at now exists",
    existsSync("app/portal/[contactId]/alerts/[alertId]/page.tsx"))

  const pdv = src("app/components/portal/PropertyDetailsView.tsx")
  check("portal: Contact Agent is wired", /onClick=\{handleContactAgent\}/.test(pdv))
  check("…and reads its outcome", /res\.success[\s\S]{0,120}?ok: true/.test(pdv))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ WIRED_SURFACE_FAIL"); process.exit(1) }
console.log(" ✅ WIRED_SURFACE_PASS — no new dead control, no new unreachable action")
