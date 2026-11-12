#!/usr/bin/env tsx
/**
 * scripts/ui-wiring-census-guard.ts   (npm run test:ui-wiring-census — pure, no DB)
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY VISIBLE ACTION IS WIRED, AND THE PHONE ADAPTS INSTEAD OF SHRINKING.
 *
 * Wave 141, lane 141I (owner, 2026-10-14, AI-NATIVE UX ruling): "Every visible
 * action wired; no dead buttons/menus/selectors/tabs/cards/save/generate/send …
 * Mobile ADAPTS (table → cards, multi-column → stepper/drawer, side panels →
 * sheets, touch-safe), never merely shrinks. Current design system; preserve
 * accessibility." And the lane rule: a surface that cannot be wired this wave
 * is hidden behind an honest "not available yet" state, never a dead click.
 *
 * MEASURED AT 01a71c3c2 BEFORE ANY FIX (the denominator, CLAUDE.md §2): 1,795
 * app/**\/*.tsx modules (ui primitives + api excluded), 4,738 <Button>/<button>
 * and 67 menu items. First-order dead buttons (no handler at all): 3 — one a
 * builder's preview mock, two finder false positives the exclusion table below
 * now models. The subtler shapes carried the real findings: a seller-portal
 * "Play" overlay with no handler, two portal privacy switches nothing read, an
 * academy category card and a video-board card that were cursor-pointer and
 * dead, a heatmap cell that lied with its cursor. Every one was fixed on its
 * survivor or made honest; the census below holds them at ZERO on the critical
 * paths and ratchets the rest.
 *
 * WHAT IS HELD
 *   A  DEAD SURFACES (stripped source — a tombstone is not a call site, §2):
 *      NO_HANDLER            <Button>/<button>/menu item with no onClick/onSelect/
 *                            submit/asChild/href/spread, not inside a <form>, not
 *                            inside a *Trigger/*Close/AlertDialogAction wrapper, a
 *                            <Link>/<a>, a <label htmlFor>, and not handed to a
 *                            parent as a prop value (`trigger={<Button …>}`)
 *      NOOP/CONSOLE/SOON     inline handlers that do nothing, only console.log, or
 *                            say "coming soon"/"not implemented"
 *      EMPTY/CONSOLE/SOON_NAMED  named handleX / onX functions with those bodies
 *      PREVENT_DEFAULT_ONLY  a submit handler whose only statement is preventDefault
 *      TOAST_ONLY_HANDLER    a handler that only toasts/alerts (claims without doing)
 *      CLICK_STATE_UNREAD    onClick={() => setX(…)} where `x` is read nowhere
 *      TAB_WITHOUT_CONTENT   <TabsTrigger value> with no <TabsContent value> (and no
 *                            onValueChange routing) — a tab that shows nothing
 *      FETCH_MISSING_ROUTE   fetch("/api/…") to a route with no route.ts
 *      DYNIMPORT_MISSING_*   await import("@/app/actions/x") naming a member x
 *                            does not export (tsc cannot see through the three
 *                            dynamic forms)
 *      CURSOR_POINTER_NO_HANDLER  a card/div/span styled clickable with no handler
 *      TOGGLE/SELECT_NO_HANDLER   Switch/Checkbox/RadioGroup/Slider/Select with no
 *                            change handler, no name, not disabled, no spread, and
 *                            no clickable parent
 *      CONTROLLED_INPUT_NO_ONCHANGE  value={…} with no onChange/readOnly
 *      FORM_NO_SUBMIT        <form> with no onSubmit/action AND no named inputs (a
 *                            GET filter form with name= inputs is honest)
 *      CRITICAL PATHS (signup, onboarding, invites/users, contacts, leads,
 *      listings, offers, transactions, CDA, settings, billing, providers, lead
 *      magnets, website, portals) must read 0; everything else is a shrink-only
 *      ratchet (scripts/ui-wiring-census-baseline.json).
 *   B  MOBILE (static, critical flows only): raw <table> without a horizontal
 *      scroll container = 0; fixed ≥ 400px widths without scroll = 0; fixed
 *      sidebars (w-64…w-96 shrink-0/border) without a breakpoint = 0; ≥ 4-column
 *      grids with no breakpoint, 3-column grids, whitespace-nowrap flex rows,
 *      sub-touch (< 32px) buttons and tables without a card variant are
 *      published and ratcheted; the four PRIMARY lists this lane adapted (seats,
 *      invitations, invoices, transactions) must keep their card variant.
 *      PLAYWRIGHT SMOKE at 1280/820/390 runs ONLY when UI_SMOKE_BASE_URL is set
 *      and a browser is installed; otherwise it is reported SKIPPED, never
 *      claimed (the agent sandbox has no browser — published blind spot).
 *   C  THE SURFACES THIS LANE WIRED stay wired (rules, not waypoints): the
 *      seller-portal play control mounts the ONE portal player; the portal
 *      privacy switches are disabled with the honest sentence; the system
 *      providers console gates on requireSuperadmin before rendering; the
 *      embedded intelligence surfaces (next-best-action panels, contact
 *      follow-up/insights cards) are mounted by a page, not merely exported.
 *   P  POSITIVE CONTROLS for every finder — a broken regex and a clean tree both
 *      report zero (§2).
 *
 * BLIND SPOTS (published beside the numbers): handlers passed through props
 * (`onAction={…}`) are judged at the leaf, not traced; a parent's onClick is
 * recognised within a 400-char window and may be fooled by nested same-name
 * tags; JSX text is not masked by blankStrings (strip-comments' own stated blind
 * spot), so a word in element text can read as a token; the mobile census is
 * lexical (class strings), it cannot see computed classes or CSS modules; the
 * sub-touch rule reads Tailwind height classes only.
 *
 * ── WAVE 142 (lane 142H — complete feature / UI / mobile / product-journey audit) ──
 * The hard-zero population is now EVERY product journey the owner named (JOURNEYS
 * below: listings · offers · transactions & closing · legal forms & e-sign · CDA &
 * commissions · buyer/seller CRM · agents & vendors · lead acquisition · AI ISA &
 * communications · marketing/media/books/video · portals · websites · settings ·
 * billing · support · education · managers & operations · reports), reported PER
 * JOURNEY with its denominator. MEASURED AT fec8b6a95 with the wave-141 finders:
 * 0 dead surfaces anywhere. The finders below were added for the shapes that
 * census could not see — and each found live defects on the journeys:
 *   STATE_ONLY_ACTION_HANDLER  a handler NAMED as a persisting action (save / submit
 *                              / send / generate / publish / sync / upload / …) whose
 *                              body only sets local state: the TC "Contact Vendor"
 *                              form whose submit was setTimeout(() => setSent(true))
 *                              ("Request Sent" — nothing sent); the seller-update
 *                              "Save as Draft" that cleared two flags and saved nothing
 *   CHANGE_STATE_UNREAD        a Select / Input / Textarea whose state is read by
 *                              nothing but its own control: the ROI "Date Window", the
 *                              video-analytics range, the lead-magnet QR label, the
 *                              Coming-Soon card's editable AI post and email teaser
 *                              (activation regenerated both and dropped the edits —
 *                              UNWIRED GENERATION)
 *   SUCCESS_BEFORE_RESULT      a success toast before the first await (0 at HEAD)
 *   EMPTY_SELECT_ITEM_VALUE    <SelectItem value=""> — Radix throws at runtime (0)
 *   HASH_HREF                  <a href="#"> / <Link href="#"> with no handler (0)
 *   DIALOG/SHEET_NO_TITLE      a DialogContent / SheetContent with no title anywhere
 *                              in the file — screen readers announce nothing (1: the
 *                              public listing page's video + gallery dialogs)
 *   ICON_BUTTON_NO_LABEL (a11y.*, ratchet)  size="icon" buttons with no accessible
 *                              name: 95 at HEAD across the app, all 95 labelled by the
 *                              lane (aria-label / title / sr-only); the ratchet holds 0
 * MOBILE: the hard zeros (raw table without scroll, fixed ≥400px width, fixed
 * sidebar) now hold over the widened population (14 / 2 / 6 found at HEAD — the
 * settings rail, the CRM contact rail, the workflow builder rail, 13 raw tables —
 * all adapted); the five wave-141 ratchets keep their MEASURED population
 * (MOBILE_RATCHET_PREFIXES) so they only ever fall, and the widened journeys ratchet
 * under their own keys (journeys.*). An OUTSIDE-LANE exemption (another lane owns
 * the file this wave) must keep reproducing its finding or be deleted (X1) — it
 * can never outlive the defect it names.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import { walkTs } from "./runtime-roots"
// The journey vocabulary lives in ./ui-journeys (wave 146, lane 146H) — one definition for every UI guard.
import { JOURNEYS, journeyOf, underPrefix } from "./ui-journeys"
export { JOURNEYS, journeyOf }

const ROOT = process.cwd()
const BASELINE_PATH = join(ROOT, "scripts", "ui-wiring-census-baseline.json")
let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const rel = (abs: string) => abs.slice(ROOT.length + 1).replace(/\\/g, "/")
const lineOf = (s: string, i: number) => s.slice(0, i).split("\n").length

// ── Populations ───────────────────────────────────────────────────────────────
const APP_TSX = walkTs(join(ROOT, "app")).filter((f) => f.endsWith(".tsx") && !/\/app\/components\/ui\//.test(f) && !/\/app\/api\//.test(f))
/** The wave-141 critical paths (lane 141I prompt) — the MEASURED population of the five mobile ratchets
 *  (2026-10-14); it stays exactly this so those counts only ever fall. */
export const MOBILE_RATCHET_PREFIXES = [
  "app/signup", "app/get-started", "app/login", "app/onboarding", "app/dashboard/onboarding", "app/dashboard/getting-started",
  "app/dashboard/admin/users", "app/settings/users", "app/dashboard/settings/team", "app/dashboard/settings/teams", "app/vendor-invite",
  "app/crm/contacts", "app/leads", "app/dashboard/listings", "app/listings", "app/offers", "app/dashboard/offers",
  "app/transactions", "app/dashboard/transactions", "app/transaction",
  "app/settings", "app/dashboard/settings", "app/dashboard/admin/billing",
  "app/dashboard/marketing/lead-magnets", "app/lm", "app/site", "app/dashboard/tools/home-value",
  "app/portal", "app/components/portal", "app/vendor", "app/lender",
]
/** Every journey prefix — the hard-zero population (a superset of the wave-141 paths). */
export const CRITICAL_PREFIXES = [...new Set(Object.values(JOURNEYS).flat())]
const isCritical = (f: string) => CRITICAL_PREFIXES.some((p) => underPrefix(f, p))
const inRatchetPopulation = (f: string) => MOBILE_RATCHET_PREFIXES.some((p) => underPrefix(f, p))
/**
 * A finding in a file ANOTHER LANE owns this wave (the lane prompt: "report their UI defects as outside-lane
 * with file:line"). Each entry is reported, not failed — and X1 deletes it the moment the finding stops
 * reproducing, so an exemption can never outlive the defect it names.
 */
export const OUTSIDE_LANE_EXEMPTIONS: Array<{ file: string; kind: string; lane: string; why: string }> = [
  { file: "app/dashboard/agent/business-cards/page.tsx", kind: "RAW_TABLE_NO_SCROLL", lane: "142D (business-card scanner page)", why: "the recent-scans <table> (:664) has no horizontal scroll container; lane D owns the scanner page this wave — reported in lane 142H's notes, one-line fix: overflow-x-auto on its wrapper" },
]
const isExempt = (h: { file: string; kind: string }) => OUTSIDE_LANE_EXEMPTIONS.some((e) => e.file === h.file && e.kind === h.kind)

// ── Tag reader (shared by both censuses) ──────────────────────────────────────
/** The opening tag that starts at `<Name` — attrs text and where it ends; `{…}` and strings stepped over. */
export function openingTag(src: string, start: number): { attrs: string; end: number; selfClosing: boolean } | null {
  let i = start + 1
  while (i < src.length && /[A-Za-z0-9_.$]/.test(src[i])) i++
  let depth = 0, quote: string | null = null
  const a0 = i
  for (; i < src.length; i++) {
    const ch = src[i]
    if (quote) { if (ch === quote) quote = null; continue }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue }
    if (ch === "{") depth++
    else if (ch === "}") depth--
    else if (depth === 0 && ch === ">") {
      const attrs = src.slice(a0, i)
      return { attrs, end: i + 1, selfClosing: /\/\s*$/.test(attrs) }
    }
  }
  return null
}
/** Is `idx` inside an element opened by a tag matching `open` (regex on the tag name) that has not closed yet? Window-bounded. */
function enclosedBy(src: string, idx: number, open: RegExp, attrTest?: RegExp, window = 400): boolean {
  const w = src.slice(Math.max(0, idx - window), idx)
  const re = new RegExp(`<(${open.source})\\b([^>]*)>`, "g")
  let last: RegExpExecArray | null = null
  for (let m: RegExpExecArray | null; (m = re.exec(w)); ) if (!attrTest || attrTest.test(m[2])) last = m
  if (!last) return false
  const after = w.slice(last.index + last[0].length)
  return !new RegExp(`</${last[1]}\\s*>`).test(after)
}
const HANDLED_ATTR = /\b(onClick|onSelect|onSubmit|onPointerDown|onMouseDown|onTouchEnd|onKeyDown|asChild|href|formAction|form=)\b|type=["']submit["']|\{\.\.\./
const WRAPPERS = /[A-Za-z]*Trigger|[A-Za-z]*Close|AlertDialogAction|AlertDialogCancel/
function insideForm(src: string, idx: number): boolean {
  const before = src.slice(0, idx)
  return (before.match(/<form\b/g) ?? []).length > (before.match(/<\/form>/g) ?? []).length
}
const passedAsProp = (src: string, idx: number) => /\w+=\{\s*\(?\s*$/.test(src.slice(Math.max(0, idx - 60), idx))

// ── A · dead-surface finders (PURE: source in, hits out) ──────────────────────
export interface Hit { file: string; line: number; kind: string; detail: string }
const INTERACTIVE = ["Button", "button", "DropdownMenuItem", "ContextMenuItem", "CommandItem", "MenubarItem"]
const apiRoutes = walkTs(join(ROOT, "app/api")).filter((f) => /\/route\.ts$/.test(f)).map((f) => f.slice(join(ROOT, "app").length).replace(/\/route\.ts$/, "").replace(/\\/g, "/"))
export function apiRouteExists(p: string, routes = apiRoutes): boolean {
  const segs = p.split("/").filter(Boolean)
  return routes.some((r) => {
    const rs = r.split("/").filter(Boolean)
    for (let i = 0; i < rs.length; i++) {
      if (rs[i].startsWith("[...")) return true
      if (i >= segs.length) return false
      if (rs[i].startsWith("[")) continue
      if (rs[i] !== segs[i]) return false
    }
    return rs.length === segs.length
  })
}
function exportsOf(modRel: string): Set<string> | null {
  const mod = join(ROOT, modRel)
  const file = [mod + ".ts", mod + ".tsx", mod + "/index.ts"].find((f) => existsSync(f))
  if (!file) return null
  const target = stripComments(readFileSync(file, "utf8"))
  const names = new Set<string>()
  for (const e of target.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)/g)) names.add(e[1])
  for (const e of target.matchAll(/export\s*\{([^}]*)\}/g)) for (const n of e[1].split(",")) { const nm = n.trim().split(/\s+as\s+/).pop(); if (nm) names.add(nm) }
  return names
}
function handlerBody(src: string, openBrace: number): string | null {
  let depth = 0
  for (let i = openBrace; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(openBrace + 1, i) } }
  return null
}
export function deadSurfaces(file: string, raw: string, opts: { exportsOf?: (m: string) => Set<string> | null; routeExists?: (p: string) => boolean } = {}): Hit[] {
  const src = stripComments(raw)
  const code = blankStrings(src)
  const hits: Hit[] = []
  const push = (i: number, kind: string, detail: string) => hits.push({ file, line: lineOf(src, i), kind, detail: detail.replace(/\s+/g, " ").slice(0, 90) })
  const ex = opts.exportsOf ?? exportsOf
  const routeOk = opts.routeExists ?? apiRouteExists

  for (const name of INTERACTIVE) {
    for (const m of src.matchAll(new RegExp(`<${name}(?=[\\s/>])`, "g"))) {
      const tag = openingTag(src, m.index!); if (!tag) continue
      if (HANDLED_ATTR.test(tag.attrs)) continue
      if (/(^|\s)disabled(\s|$)/.test(tag.attrs)) { push(m.index!, "ALWAYS_DISABLED", `${name} ${tag.attrs}`); continue }
      if ((name === "Button" || name === "button") && insideForm(src, m.index!) && !/type=["']button["']/.test(tag.attrs)) continue
      if (enclosedBy(src, m.index!, WRAPPERS)) continue
      if (enclosedBy(src, m.index!, /Link|a|label/, undefined, 300)) continue
      if (passedAsProp(src, m.index!)) continue
      if (!tag.selfClosing && /^\s*<(Link|a)\b/.test(src.slice(tag.end, tag.end + 300))) continue
      push(m.index!, "NO_HANDLER", `${name} ${tag.attrs}`)
    }
  }
  for (const m of src.matchAll(/on(Click|Select|Submit)=\{\s*\(\s*\)\s*=>\s*(\{\s*\}|undefined|null|void 0)\s*\}/g)) push(m.index!, "NOOP_HANDLER", m[0])
  for (const m of src.matchAll(/on(Click|Select|Submit)=\{\s*\([^)]*\)\s*=>\s*\{?\s*console\.(log|info|warn)\([^)]*\)\s*;?\s*\}?\s*\}/g)) push(m.index!, "CONSOLE_HANDLER", m[0])
  for (const m of src.matchAll(/on(Click|Select|Submit)=\{[^}]{0,120}(coming soon|not implemented|not yet implemented)/gi)) push(m.index!, "SOON_HANDLER", m[0])
  for (const m of src.matchAll(/(?:const|function)\s+(handle[A-Z]\w*|on[A-Z]\w*|submit\w*)\s*(?:=\s*(?:async\s*)?\([^)]*\)\s*=>|\([^)]*\))\s*\{/g)) {
    const body = handlerBody(src, m.index! + m[0].length - 1); if (body === null) continue
    const trimmed = body.trim()
    const stmts = trimmed.split(/\n|;/).map((s) => s.trim()).filter(Boolean)
    if (trimmed === "") push(m.index!, "EMPTY_NAMED_HANDLER", m[1])
    else if (/^console\.(log|info|warn)\([^)]*\)\s*;?$/.test(trimmed)) push(m.index!, "CONSOLE_NAMED_HANDLER", m[1])
    else if (/coming soon|not implemented|not yet implemented/i.test(trimmed) && trimmed.length < 200) push(m.index!, "SOON_NAMED_HANDLER", `${m[1]} ${trimmed}`)
    else if (stmts.every((s) => /^e(vent)?\.(preventDefault|stopPropagation)\(\)$/.test(s))) push(m.index!, "PREVENT_DEFAULT_ONLY", m[1])
    else if (stmts.every((s) => /^(toast(\.\w+)?\(|alert\()/.test(s) || /^[)}\]]+$/.test(s) || /^(title|description|variant|duration):/.test(s))) push(m.index!, "TOAST_ONLY_HANDLER", `${m[1]} ${trimmed}`)
  }
  for (const m of src.matchAll(/on(?:Click|Select)=\{\s*\(\s*\)\s*=>\s*set([A-Z]\w*)\s*\([^)]*\)\s*\}/g)) {
    const cap = m[1]; const name = cap[0].toLowerCase() + cap.slice(1)
    if (!new RegExp(`\\[\\s*${name}\\s*,\\s*set${cap}\\s*\\]\\s*=\\s*useState`).test(code)) continue
    const mentions = [...code.matchAll(new RegExp(`(?<![A-Za-z0-9_$.])${name}(?![A-Za-z0-9_$])`, "g"))].length
    if (mentions <= 1) push(m.index!, "CLICK_STATE_UNREAD", `set${cap} → ${name} read nowhere`)
  }
  const triggers = [...src.matchAll(/<TabsTrigger\b[^>]*\bvalue=["']([^"']+)["']/g)].map((m) => ({ v: m[1], i: m.index! }))
  const contents = new Set([...src.matchAll(/<TabsContent\b[^>]*\bvalue=["']([^"']+)["']/g)].map((m) => m[1]))
  if (triggers.length && contents.size && !/<Tabs\b[^>]*onValueChange=/.test(src)) for (const t of triggers) if (!contents.has(t.v)) push(t.i, "TAB_WITHOUT_CONTENT", t.v)
  for (const m of src.matchAll(/fetch\(\s*["'`](\/api\/[A-Za-z0-9_\-\/\[\]]+?)["'`?]/g)) { const p = m[1].replace(/\/$/, ""); if (!routeOk(p)) push(m.index!, "FETCH_MISSING_ROUTE", p) }
  for (const m of src.matchAll(/import\(\s*["']@\/(app\/actions\/[^"']+)["']\s*\)/g)) {
    const names = ex(m[1])
    const at = m.index! + m[0].length
    const after = src.slice(at, at + 200), before = src.slice(Math.max(0, m.index! - 160), m.index!)
    const wanted: string[] = []
    const direct = /^\s*\)\s*\.(\w+)\s*\(/.exec(after); if (direct) wanted.push(direct[1])
    const then = /^\s*\.then\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\1\.(\w+)\s*\(/.exec(after); if (then) wanted.push(then[2])
    const destr = /(?:const|let)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?$/.exec(before); if (destr) for (const n of destr[1].split(",")) { const nm = n.trim().split(/\s*:\s*/)[0]; if (nm) wanted.push(nm) }
    if (!names) { push(m.index!, "DYNIMPORT_MISSING_MODULE", m[1]); continue }
    for (const w of wanted) if (!names.has(w)) push(m.index!, "DYNIMPORT_MISSING_EXPORT", `${m[1]}.${w}`)
  }
  for (const m of src.matchAll(/<(Card|div|li|tr|span|section|article)\b/g)) {
    const tag = openingTag(src, m.index!); if (!tag) continue
    if (!/cursor-pointer/.test(tag.attrs)) continue
    if (HANDLED_ATTR.test(tag.attrs) || /\bon[A-Z]\w+=/.test(tag.attrs)) continue
    if (enclosedBy(src, m.index!, WRAPPERS) || enclosedBy(src, m.index!, /Link|a|label/, undefined, 300) || passedAsProp(src, m.index!)) continue
    if (enclosedBy(src, m.index!, /[A-Za-z]+/, /\bon(Click|Select)=/)) continue
    push(m.index!, "CURSOR_POINTER_NO_HANDLER", `${m[1]} ${tag.attrs}`)
  }
  for (const m of src.matchAll(/<(Switch|Checkbox|RadioGroup|Slider|ToggleGroup|Toggle)\b/g)) {
    const tag = openingTag(src, m.index!); if (!tag) continue
    if (/\bon(CheckedChange|ValueChange|Change|Click|PressedChange)\b|\{\.\.\.|\bname=|\bdisabled\b|\breadOnly\b/.test(tag.attrs)) continue
    if (enclosedBy(src, m.index!, /[A-Za-z]+/, /\bon(Click|Select)=/) || passedAsProp(src, m.index!)) continue
    push(m.index!, "TOGGLE_NO_HANDLER", `${m[1]} ${tag.attrs}`)
  }
  for (const m of src.matchAll(/<Select\b(?![A-Za-z])/g)) {
    const tag = openingTag(src, m.index!); if (!tag) continue
    if (/\bonValueChange\b|\{\.\.\.|\bname=|\bdisabled\b/.test(tag.attrs)) continue
    push(m.index!, "SELECT_NO_HANDLER", tag.attrs)
  }
  for (const m of src.matchAll(/<(Input|Textarea|input|textarea)\b/g)) {
    const tag = openingTag(src, m.index!); if (!tag) continue
    if (!/\bvalue=\{/.test(tag.attrs)) continue
    if (/\bonChange\b|\bonInput\b|\{\.\.\.|\breadOnly\b|\bdisabled\b|\bonValueChange\b|type=["'](hidden|submit|checkbox|radio)["']/.test(tag.attrs)) continue
    push(m.index!, "CONTROLLED_INPUT_NO_ONCHANGE", `${m[1]} ${tag.attrs}`)
  }
  for (const m of src.matchAll(/<form\b/g)) {
    const tag = openingTag(src, m.index!); if (!tag) continue
    if (/\bonSubmit\b|\baction=|\{\.\.\.|\bmethod=/.test(tag.attrs)) continue
    const end = src.indexOf("</form>", tag.end)
    const body = src.slice(tag.end, end === -1 ? src.length : end)
    if (/\bname=/.test(body)) continue
    push(m.index!, "FORM_NO_SUBMIT", tag.attrs)
  }

  // ── wave 142 (lane 142H): the shapes the first census could not see ──────────
  // STATE_ONLY_ACTION_HANDLER — a handler NAMED as a persisting action whose body only sets local state
  // (plus toasts / preventDefault / timers / pure helpers): a "Save" that saves nothing, a submit that fakes
  // a send with setTimeout, a "Generate" that calls nothing. Opening a dialog or switching a UI mode is not
  // an action (UI setters are excluded) and a handler that calls ANY other function is left alone.
  for (const m of src.matchAll(/(?:const|function)\s+((?:handle|on)?[A-Za-z]\w*)\s*(?:=\s*(?:async\s*)?\([^)]*\)\s*=>|\([^)]*\))\s*\{/g)) {
    const name = m[1]
    if (!ACTION_HANDLER_NAME.test(name)) continue
    const body = handlerBody(src, m.index! + m[0].length - 1); if (body === null) continue
    const b = blankStrings(body)
    if (!b.trim() || /\bawait\b|\bfetch\(|\.then\(|startTransition|router\.|window\.|location\.|document\.|navigator\.|dispatch\(|mutate|\.submit\(|\.click\(/.test(b)) continue
    const calls = [...b.matchAll(/\b([A-Za-z_$][\w$.]*)\s*\(/g)].map((c) => c[1])
    if (calls.length === 0 || !calls.every((c) => TRIVIAL_CALL.test(c))) continue
    const setters = calls.filter((c) => /^set[A-Z]/.test(c))
    if (setters.length === 0 || setters.every((c) => UI_STATE_SETTER.test(c))) continue
    // An OPENER: a handler that opens a dialog / sheet / drawer (pre-filling its fields first) hands the
    // action to that surface's own submit — handleBookVendor → setBookingDialogOpen(true) is not dead.
    if (setters.some((c) => UI_OPENER_SETTER.test(c))) continue
    push(m.index!, "STATE_ONLY_ACTION_HANDLER", `${name} → ${calls.join(",")}`)
  }
  // CHANGE_STATE_UNREAD — onValueChange / onCheckedChange / onChange sets state that nothing reads but the
  // control itself (`value={x}` on the same control is not a reader). A <Tabs>/<Accordion>/<Collapsible>
  // pair IS consumed by the control (it shows content by value) and is not a selector.
  for (const m of src.matchAll(/on(ValueChange|CheckedChange|Change|PressedChange)=\{\s*(?:\(\s*\w*\s*\)\s*=>\s*)?set([A-Z]\w*)\s*(?:\(\s*[\w.]*\s*\))?\s*\}/g)) {
    const cap = m[2]; const name = cap[0].toLowerCase() + cap.slice(1)
    if (!new RegExp(`\\[\\s*${name}\\s*,\\s*set${cap}\\s*\\]\\s*=\\s*useState`).test(code)) continue
    const tagStart = src.lastIndexOf("<", m.index!)
    const tagName = /^<([A-Za-z][A-Za-z0-9.]*)/.exec(src.slice(tagStart, tagStart + 40))?.[1] ?? ""
    if (/^Tabs$|TabsList|^Accordion|^Collapsible|^Carousel|^ToggleGroup$/.test(tagName)) continue
    const stripped = code.replace(new RegExp(`\\b(value|checked|defaultValue|pressed|selected)=\\{\\s*${name}\\s*\\}`, "g"), "")
    const mentions = [...stripped.matchAll(new RegExp(`(?<![A-Za-z0-9_$.])${name}(?![A-Za-z0-9_$])`, "g"))].length
    if (mentions <= 1) push(m.index!, "CHANGE_STATE_UNREAD", `<${tagName}> set${cap} → ${name} read nowhere but its own control`)
  }
  // SUCCESS_BEFORE_RESULT — an async handler that claims success BEFORE its first await.
  for (const m of src.matchAll(/(?:const|function)\s+(\w+)\s*(?:=\s*async\s*\([^)]*\)\s*=>|=\s*async\s+function\s*\([^)]*\))\s*\{|async\s+function\s+(\w+)\s*\([^)]*\)\s*\{/g)) {
    const body = handlerBody(src, m.index! + m[0].length - 1); if (body === null) continue
    const aw = body.search(/\bawait\b/); if (aw < 0) continue
    const claim = body.search(/toast\.success\(|variant:\s*["']success["']|title:\s*["'`](Saved|Sent|Done|Success|Updated|Created|Published|Deleted|Approved|Submitted|Scheduled|Connected)\b/i)
    if (claim >= 0 && claim < aw) push(m.index!, "SUCCESS_BEFORE_RESULT", `${m[1] ?? m[2]} claims success before its first await`)
  }
  // EMPTY_SELECT_ITEM_VALUE — Radix Select throws at runtime on value="".
  for (const m of src.matchAll(/<SelectItem\b[^>]*\bvalue=(?:""|''|\{""\}|\{''\})/g)) push(m.index!, "EMPTY_SELECT_ITEM_VALUE", m[0])
  // HASH_HREF — <a href="#"> / <Link href="#"> with no handler: a link that goes nowhere.
  for (const m of src.matchAll(/<(a|Link)\b/g)) {
    const tag = openingTag(src, m.index!); if (!tag) continue
    if (!/\bhref=["']#["']/.test(tag.attrs) || /\bonClick=/.test(tag.attrs)) continue
    push(m.index!, "HASH_HREF", `${m[1]} ${tag.attrs}`)
  }
  // DIALOG_NO_TITLE / SHEET_NO_TITLE — a DialogContent / SheetContent with no title anywhere in the file.
  const dlg = (src.match(/<DialogContent\b/g) ?? []).length
  if (dlg > 0 && !/DialogTitle/.test(src)) push(src.search(/<DialogContent\b/), "DIALOG_NO_TITLE", `${dlg} DialogContent, no DialogTitle`)
  const sht = (src.match(/<SheetContent\b/g) ?? []).length
  if (sht > 0 && !/SheetTitle/.test(src)) push(src.search(/<SheetContent\b/), "SHEET_NO_TITLE", `${sht} SheetContent, no SheetTitle`)
  return hits
}
/** Handler names that promise persistence / dispatch (past-tense callbacks like handleCreated and openers like handleCreateOpen are not actions). */
const ACTION_HANDLER_NAME = /^(handle|on)?(save|submit|send|generate|publish|sync|upload|export|import|invite|approve|reject|pay|launch|convert|regenerate|resend|verify|connect|disconnect|schedule|book|archive|delete)(?!d\b|ed\b|Complete|Success|Error|Change|Open|Click)/i
/** Calls a state-only body may contain and still be state-only (setters, toasts, timers, pure helpers, local collection methods). */
const TRIVIAL_CALL = /^(set[A-Z]\w*|toast(\.\w+)?|alert|console\.\w+|e\.(preventDefault|stopPropagation)|event\.(preventDefault|stopPropagation)|String|Number|Boolean|Array\.from|Math\.\w+|Date\.now|Date|JSON\.\w+|Object\.\w+|parseInt|parseFloat|isNaN|isFinite|setTimeout|clearTimeout|requestAnimationFrame|structuredClone|encodeURIComponent|decodeURIComponent|crypto\.randomUUID|Set|Map|\w+\.(trim|toLowerCase|toUpperCase|filter|map|includes|find|findIndex|some|every|push|slice|splice|split|join|replace|test|has|get|set|delete|add|toFixed|startsWith|endsWith|indexOf|concat|forEach|reduce|flatMap|sort|reverse|at|keys|values|entries|toString|localeCompare|getTime|toISOString))$/
/** Setters that merely open / close / switch a UI mode — a handler that only does this is a UI affordance, not a dead action. */
const UI_STATE_SETTER = /^set\w*(Open|Dialog|Modal|Mode|Step|Show\w*|Visible|Expanded|Selected\w*|Active\w*|Editing\w*|Tab|View|Sheet|Drawer|Panel|Preview|Hover\w*|Focus\w*|Menu|Confirm\w*|Pending|Loading|Busy|Submitting|Saving)$/
/** Setters that OPEN a surface whose own submit carries the action (the handler is an opener, whatever else it pre-fills). */
const UI_OPENER_SETTER = /^set(\w*(Open|Dialog|Modal|Sheet|Drawer)|Show\w+)$/

/** ACCESSIBILITY (wave 142): a size="icon" button with no accessible name — no aria-label / title on it, no
 *  sr-only text or labelled child inside it, no visible text. A ratchet over the whole app (a11y.*). */
export function a11yHits(file: string, raw: string): Hit[] {
  const src = stripComments(raw)
  const hits: Hit[] = []
  for (const m of src.matchAll(/<Button\b/g)) {
    const tag = openingTag(src, m.index!); if (!tag) continue
    if (!/size=["']icon/.test(tag.attrs) || /aria-label|title=|aria-labelledby/.test(tag.attrs)) continue
    if (tag.selfClosing) { hits.push({ file, line: lineOf(src, m.index!), kind: "ICON_BUTTON_NO_LABEL", detail: tag.attrs.replace(/\s+/g, " ").slice(0, 90) }); continue }
    const close = src.indexOf("</Button>", tag.end)
    const inner = src.slice(tag.end, close < 0 ? tag.end + 400 : close)
    // visible text: a run of letters at the start of the body or after a child tag (`<X />Close`, `Close`)
    if (/sr-only|aria-label|title=/.test(inner) || /(^|>)\s*[A-Za-z][^<>{}]*\s*(<|$)/.test(inner)) continue
    hits.push({ file, line: lineOf(src, m.index!), kind: "ICON_BUTTON_NO_LABEL", detail: tag.attrs.replace(/\s+/g, " ").slice(0, 90) })
  }
  return hits
}

// ── B · mobile finders (PURE) ─────────────────────────────────────────────────
export function mobileHits(file: string, raw: string): Hit[] {
  const src = stripComments(raw)
  const hits: Hit[] = []
  const push = (i: number, kind: string, detail: string) => hits.push({ file, line: lineOf(src, i), kind, detail: detail.replace(/\s+/g, " ").slice(0, 90) })
  // A horizontal scroll container: overflow-x-auto / overflow-auto / overflow-x-scroll, or a Radix
  // ScrollArea with a horizontal ScrollBar (wave 142: the referral kanban scrolls through one).
  const hasScroll = /overflow-(x-)?auto|overflow-x-scroll|<ScrollBar\b[^>]*orientation=["']horizontal["']/.test(src)
  for (const m of src.matchAll(/<([A-Za-z][A-Za-z0-9.]*)\b/g)) {
    const tag = openingTag(src, m.index!); if (!tag) continue
    const cls = /className=\{?["'`]([^"'`]*)["'`]/.exec(tag.attrs)?.[1]; if (!cls) continue
    const name = m[1]
    const fixed = /(^|\s)grid-cols-(\d+)/.exec(cls)
    if (fixed && Number(fixed[2]) >= 3 && !/\b(sm|md|lg|xl):grid-cols-/.test(cls) && name !== "TabsList")
      push(m.index!, Number(fixed[2]) >= 4 ? "GRID_COLS_4PLUS_NO_BREAKPOINT" : "GRID_COLS_3_NO_BREAKPOINT", cls)
    for (const w of cls.matchAll(/(?:^|\s)(?:min-)?w-\[(\d{3,4})px\]/g)) if (Number(w[1]) >= 400 && !hasScroll && !/\b(sm|md|lg):w-/.test(cls) && !/\bw-full\b/.test(cls)) push(m.index!, "FIXED_WIDTH_400PLUS_NO_SCROLL", `${w[0].trim()} · ${cls}`)
    // A fixed rail: w-64…w-96 that is bordered, or shrink-0 in a file with no horizontal scroll container
    // (a shrink-0 column INSIDE a scrolling kanban row is adapted by design — wave 142).
    if (/(^|\s)w-(64|72|80|96)(\s|$)/.test(cls) && /\b(shrink-0|flex-shrink-0|border-[lr])\b/.test(cls) && !/\b(sm|md|lg|xl):(w-|hidden|block|flex)/.test(cls) && !/\bhidden\b|\bw-full\b/.test(cls) && (/\bborder-[lr]\b/.test(cls) || !hasScroll))
      push(m.index!, "FIXED_SIDEBAR_NO_BREAKPOINT", cls)
    if ((name === "Button" || name === "button") && /(^|\s)(h-[4-7]|size-[4-7])(\s|$)/.test(cls)) push(m.index!, "SUB_TOUCH_BUTTON", cls)
    if (/\bflex\b/.test(cls) && /\bwhitespace-nowrap\b/.test(cls) && !/overflow-x-auto|flex-wrap|truncate/.test(cls)) push(m.index!, "NOWRAP_FLEX_ROW", cls)
  }
  const ui = (src.match(/<Table\b/g) ?? []).length, rawT = (src.match(/<table\b/g) ?? []).length
  if (ui + rawT > 0) {
    const hasCards = /\b(sm|md|lg):hidden\b/.test(src) && /\bhidden (sm|md|lg):(block|table|flex|grid)\b/.test(src)
    if (rawT > 0 && !hasScroll) push(src.search(/<table\b/), "RAW_TABLE_NO_SCROLL", `${rawT} raw <table>`)
    push(src.search(/<[Tt]able\b/), hasCards ? "TABLE_WITH_CARD_VARIANT" : "TABLE_NO_CARD_VARIANT", `ui ${ui} raw ${rawT}`)
  }
  return hits
}

// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log("══════════════════════════════════════════════════════════════")
  console.log(" UI wiring census — every visible action wired; the phone adapts")
  console.log("══════════════════════════════════════════════════════════════")

  // ── P · positive controls ──────────────────────────────────────────────────
  console.log("\n[P · positive controls — each finder still recognises the defect it was written for]")
  const ds = (s: string) => deadSurfaces("fixture.tsx", s, { exportsOf: (m) => (m === "app/actions/real" ? new Set(["real"]) : null), routeExists: (p) => p === "/api/real" })
  const kinds = (s: string) => ds(s).map((h) => h.kind)
  check("P1 a <Button> with no handler is NO_HANDLER; with onClick, asChild, inside <form>, inside a *Trigger / DialogClose, inside <Link>, inside <label htmlFor>, passed as a prop, or spread it is not",
    kinds(`<Button variant="outline">Save</Button>`).includes("NO_HANDLER") &&
    kinds(`<Button onClick={save}>Save</Button>`).length === 0 &&
    kinds(`<Button asChild><Link href="/x">Go</Link></Button>`).length === 0 &&
    kinds(`<form onSubmit={go}><Button>Save</Button></form>`).length === 0 &&
    kinds(`<DialogTrigger asChild><Button>Open</Button></DialogTrigger>`).length === 0 &&
    kinds(`<DialogClose asChild><Button variant="outline">Close</Button></DialogClose>`).length === 0 &&
    kinds(`<Link href="/x"><Button>Go</Button></Link>`).length === 0 &&
    kinds(`<label htmlFor="f"><Button asChild><span className="cursor-pointer">Upload</span></Button></label>`).length === 0 &&
    kinds(`<Dlg trigger={<Button size="sm">Record</Button>} />`).length === 0 &&
    kinds(`<Button {...props}>x</Button>`).length === 0)
  check("P2 a tombstone naming a dead button is NOT a hit (stripped before the scan)", kinds(`{/* <Button variant="ghost">dead</Button> */}\n// <Button>dead</Button>\nconst x = 1`).length === 0)
  check("P3 inline no-op / console-only / 'coming soon' handlers are caught", kinds(`<Button onClick={() => {}}>a</Button>`).includes("NOOP_HANDLER") && kinds(`<Button onClick={() => console.log("x")}>a</Button>`).includes("CONSOLE_HANDLER") && kinds(`<Button onClick={() => toast("Coming soon")}>a</Button>`).includes("SOON_HANDLER"))
  check("P4 named handlers: empty, console-only, preventDefault-only and toast-only are caught; a real one is not",
    kinds(`const handleSave = () => {\n}`).includes("EMPTY_NAMED_HANDLER") &&
    kinds(`const handleSave = () => { console.log("save") }`).includes("CONSOLE_NAMED_HANDLER") &&
    kinds(`function handleSubmit(e) { e.preventDefault() }`).includes("PREVENT_DEFAULT_ONLY") &&
    kinds(`const handleSend = () => {\n  toast({\n    title: "Sent",\n    description: "ok",\n  })\n}`).includes("TOAST_ONLY_HANDLER") &&
    kinds(`const handleSave = async () => { const r = await save(id); if (!r.ok) toast(r.error) }`).length === 0)
  check("P5 click-set state nobody reads is caught; state that is rendered is not",
    kinds(`const [open, setOpen] = useState(false)\nreturn <Button onClick={() => setOpen(true)}>x</Button>`).includes("CLICK_STATE_UNREAD") &&
    !kinds(`const [open, setOpen] = useState(false)\nreturn <><Button onClick={() => setOpen(true)}>x</Button><Dialog open={open} /></>`).includes("CLICK_STATE_UNREAD"))
  check("P6 a TabsTrigger with no TabsContent is caught; one whose Tabs routes by onValueChange is not",
    kinds(`<Tabs><TabsList><TabsTrigger value="a">A</TabsTrigger><TabsTrigger value="b">B</TabsTrigger></TabsList><TabsContent value="a">x</TabsContent></Tabs>`).includes("TAB_WITHOUT_CONTENT") &&
    !kinds(`<Tabs onValueChange={setTab}><TabsList><TabsTrigger value="a">A</TabsTrigger><TabsTrigger value="b">B</TabsTrigger></TabsList><TabsContent value="a">x</TabsContent></Tabs>`).includes("TAB_WITHOUT_CONTENT"))
  check("P7 fetch to a missing /api route is caught; an existing one is not; a dynamic segment matches",
    kinds(`fetch("/api/missing")`).includes("FETCH_MISSING_ROUTE") && kinds(`fetch("/api/real")`).length === 0 && apiRouteExists("/api/x/123", ["/api/x/[id]"]) && !apiRouteExists("/api/y", ["/api/x/[id]"]))
  check("P8 a dynamic import naming a missing export / module is caught in all three forms; a real member is not",
    kinds(`const r = (await import("@/app/actions/real")).nope()`).includes("DYNIMPORT_MISSING_EXPORT") &&
    kinds(`const r = await import("@/app/actions/real").then(m => m.nope())`).includes("DYNIMPORT_MISSING_EXPORT") &&
    kinds(`const { nope } = await import("@/app/actions/real")`).includes("DYNIMPORT_MISSING_EXPORT") &&
    kinds(`const r = await import("@/app/actions/ghost").then(m => m.real())`).includes("DYNIMPORT_MISSING_MODULE") &&
    kinds(`const r = await import("@/app/actions/real").then(m => m.real())`).length === 0)
  check("P9 a cursor-pointer card with no handler is caught; one with onClick, inside a Link, or inside a clickable parent is not",
    kinds(`<Card className="cursor-pointer hover:shadow">x</Card>`).includes("CURSOR_POINTER_NO_HANDLER") &&
    kinds(`<Card onClick={go} className="cursor-pointer">x</Card>`).length === 0 &&
    kinds(`<Link href="/x"><Card className="cursor-pointer">x</Card></Link>`).length === 0 &&
    kinds(`<div onClick={go}><span className="cursor-pointer">x</span></div>`).length === 0)
  check("P10 a Switch/Checkbox/Select with no change handler is caught; disabled, named, spread, or inside a clickable row is not",
    kinds(`<Switch defaultChecked />`).includes("TOGGLE_NO_HANDLER") &&
    kinds(`<Select value={v}><SelectTrigger /></Select>`).includes("SELECT_NO_HANDLER") &&
    kinds(`<Switch defaultChecked disabled />`).length === 0 && kinds(`<Checkbox name="x" />`).length === 0 && kinds(`<Switch {...field} />`).length === 0 &&
    kinds(`<div onClick={toggle}><Checkbox checked={on} /></div>`).length === 0 && kinds(`<Select onValueChange={set}><SelectTrigger /></Select>`).length === 0)
  check("P11 a controlled input with no onChange is caught; readOnly / checkbox-with-value is not; a form with no submit and no named inputs is caught, a GET filter form is not",
    kinds(`<Input value={x} />`).includes("CONTROLLED_INPUT_NO_ONCHANGE") && kinds(`<Input value={x} readOnly />`).length === 0 && kinds(`<input type="checkbox" value={k} defaultChecked />`).length === 0 &&
    kinds(`<form className="x"><Input value={x} onChange={set} /></form>`).includes("FORM_NO_SUBMIT") && kinds(`<form><input name="q" /></form>`).length === 0)
  const mh = (s: string) => mobileHits("fixture.tsx", s).map((h) => h.kind)
  check("P12 mobile: raw table without scroll, ≥400px fixed width, fixed sidebar, 5-col grid, sub-touch button and nowrap row are caught; their adapted forms are not",
    mh(`<table className="w-full"><tr><td>x</td></tr></table>`).includes("RAW_TABLE_NO_SCROLL") && !mh(`<div className="overflow-x-auto"><table className="w-full"><tr><td>x</td></tr></table></div>`).includes("RAW_TABLE_NO_SCROLL") &&
    mh(`<SheetContent className="w-[500px] sm:max-w-[500px]">x</SheetContent>`).includes("FIXED_WIDTH_400PLUS_NO_SCROLL") && !mh(`<SheetContent className="w-full sm:w-[500px]">x</SheetContent>`).includes("FIXED_WIDTH_400PLUS_NO_SCROLL") &&
    mh(`<div className="w-72 shrink-0 border-r">x</div>`).includes("FIXED_SIDEBAR_NO_BREAKPOINT") && !mh(`<div className="w-full md:w-72 shrink-0">x</div>`).includes("FIXED_SIDEBAR_NO_BREAKPOINT") &&
    mh(`<div className="grid grid-cols-5 gap-3">x</div>`).includes("GRID_COLS_4PLUS_NO_BREAKPOINT") && !mh(`<div className="grid grid-cols-2 lg:grid-cols-5">x</div>`).includes("GRID_COLS_4PLUS_NO_BREAKPOINT") && !mh(`<TabsList className="grid w-full grid-cols-5">x</TabsList>`).includes("GRID_COLS_4PLUS_NO_BREAKPOINT") &&
    mh(`<Button className="h-7 text-xs">x</Button>`).includes("SUB_TOUCH_BUTTON") && !mh(`<Button className="h-9">x</Button>`).includes("SUB_TOUCH_BUTTON") &&
    mh(`<div className="flex items-center whitespace-nowrap">x</div>`).includes("NOWRAP_FLEX_ROW") &&
    mh(`<div className="md:hidden">cards</div><div className="hidden md:block"><Table /></div>`).includes("TABLE_WITH_CARD_VARIANT") && mh(`<Table />`).includes("TABLE_NO_CARD_VARIANT") &&
    // wave 142: overflow-auto and a horizontal ScrollBar are scroll containers; a shrink-0 column inside a scrolling row is not a sidebar, a bordered rail still is
    !mh(`<div className="overflow-auto"><table className="w-full"><tr><td>x</td></tr></table></div>`).includes("RAW_TABLE_NO_SCROLL") &&
    !mh(`<ScrollArea><div className="flex min-w-[1200px]">x</div><ScrollBar orientation="horizontal" /></ScrollArea>`).includes("FIXED_WIDTH_400PLUS_NO_SCROLL") &&
    !mh(`<div className="overflow-x-auto"><div className="w-72 flex-shrink-0 flex flex-col">col</div></div>`).includes("FIXED_SIDEBAR_NO_BREAKPOINT") &&
    mh(`<div className="overflow-x-auto"><aside className="w-72 border-r shrink-0">x</aside></div>`).includes("FIXED_SIDEBAR_NO_BREAKPOINT"))
  check("P13 wave 142 — a handler NAMED save/submit/send/generate that only sets local state is caught (a setTimeout-faked submit too); one that awaits an action, calls a callback, or only opens a dialog is not; a local toggle is not an action",
    kinds(`const handleSave = () => { setSaved(true); toast({ title: "Saved" }) }`).includes("STATE_ONLY_ACTION_HANDLER") &&
    kinds(`const handleSubmit = async (e) => { e.preventDefault(); setLoading(true); setTimeout(() => { setSent(true); setLoading(false) }, 1000) }`).includes("STATE_ONLY_ACTION_HANDLER") &&
    kinds(`const handleGenerate = () => { setResult("x") }`).includes("STATE_ONLY_ACTION_HANDLER") &&
    !kinds(`const handleSave = async () => { const r = await saveAction(x); if (!r.ok) setError(r.error) }`).includes("STATE_ONLY_ACTION_HANDLER") &&
    !kinds(`const handleSave = () => { onSave(form) }`).includes("STATE_ONLY_ACTION_HANDLER") &&
    !kinds(`const handleCreate = () => { setCreateOpen(true) }`).includes("STATE_ONLY_ACTION_HANDLER") &&
    !kinds(`const handleBook = (v) => { setSelectedVendor(v); setBookingServiceType(v.category || ""); setBookingDialogOpen(true) }`).includes("STATE_ONLY_ACTION_HANDLER") &&
    !kinds(`const handleCreated = () => { setItems([]) }`).includes("STATE_ONLY_ACTION_HANDLER") &&
    !kinds(`const toggleItem = (id) => { setSelected((p) => p.includes(id) ? p.filter((x) => x !== id) : [...p, id]) }`).includes("STATE_ONLY_ACTION_HANDLER"))
  check("P14 wave 142 — a Select / Input whose state nothing reads but its own control is caught; one that is rendered or sent is not; a Tabs value/onValueChange pair is not a selector",
    kinds(`const [range, setRange] = useState("30d")\nreturn <Select value={range} onValueChange={setRange}><SelectTrigger /></Select>`).includes("CHANGE_STATE_UNREAD") &&
    kinds(`const [label, setLabel] = useState("")\nreturn <Input value={label} onChange={(e) => setLabel(e.target.value)} />`).includes("CHANGE_STATE_UNREAD") &&
    !kinds(`const [range, setRange] = useState("30d")\nreturn <><Select value={range} onValueChange={setRange}><SelectTrigger /></Select><p>{range}</p></>`).includes("CHANGE_STATE_UNREAD") &&
    !kinds(`const [tab, setTab] = useState("a")\nreturn <Tabs value={tab} onValueChange={setTab}><TabsContent value="a">x</TabsContent></Tabs>`).includes("CHANGE_STATE_UNREAD"))
  check("P15 wave 142 — a success toast BEFORE the first await is caught; after it is not",
    kinds(`const handleSend = async () => { toast.success("Sent"); await send() }`).includes("SUCCESS_BEFORE_RESULT") &&
    !kinds(`const handleSend = async () => { await send(); toast.success("Sent") }`).includes("SUCCESS_BEFORE_RESULT"))
  check("P16 wave 142 — an empty SelectItem value, a href=\"#\" with no handler, and a Dialog / Sheet with no title are caught; their honest forms are not",
    kinds(`<SelectItem value="">All</SelectItem>`).includes("EMPTY_SELECT_ITEM_VALUE") && !kinds(`<SelectItem value="all">All</SelectItem>`).includes("EMPTY_SELECT_ITEM_VALUE") &&
    kinds(`<a href="#">x</a>`).includes("HASH_HREF") && !kinds(`<a href="#" onClick={go}>x</a>`).includes("HASH_HREF") && !kinds(`<Link href="/x">x</Link>`).includes("HASH_HREF") &&
    kinds(`<Dialog><DialogContent>x</DialogContent></Dialog>`).includes("DIALOG_NO_TITLE") && !kinds(`<Dialog><DialogContent><DialogTitle>T</DialogTitle>x</DialogContent></Dialog>`).includes("DIALOG_NO_TITLE") &&
    kinds(`<Sheet><SheetContent>x</SheetContent></Sheet>`).includes("SHEET_NO_TITLE") && !kinds(`<Sheet><SheetContent><SheetHeader><SheetTitle>T</SheetTitle></SheetHeader></SheetContent></Sheet>`).includes("SHEET_NO_TITLE"))
  const ah = (s: string) => a11yHits("fixture.tsx", s).map((h) => h.kind)
  check("P17 wave 142 — a size=\"icon\" button with no accessible name is caught; aria-label, title, sr-only text, a labelled child link, or visible text is not",
    ah(`<Button size="icon"><X /></Button>`).includes("ICON_BUTTON_NO_LABEL") &&
    !ah(`<Button size="icon" aria-label="Close"><X /></Button>`).includes("ICON_BUTTON_NO_LABEL") &&
    !ah(`<Button size="icon" title="Close"><X /></Button>`).includes("ICON_BUTTON_NO_LABEL") &&
    !ah(`<Button size="icon"><X /><span className="sr-only">Close</span></Button>`).includes("ICON_BUTTON_NO_LABEL") &&
    !ah(`<Button size="icon" asChild><Link href="/x" aria-label="Open"><X /></Link></Button>`).includes("ICON_BUTTON_NO_LABEL") &&
    !ah(`<Button size="icon">Close</Button>`).includes("ICON_BUTTON_NO_LABEL"))
  check("P18 wave 142 — journeyOf reports a file under its LONGEST matching prefix; a file outside every journey is null; the wave-141 ratchet population sits inside the journeys",
    journeyOf("app/dashboard/transactions/[id]/cda/page.tsx") === "CDA & commissions" && journeyOf("app/dashboard/transactions/page.tsx") === "transactions & closing" &&
    journeyOf("app/components/ui/button.tsx") === null && MOBILE_RATCHET_PREFIXES.every((p) => isCritical(p + "/page.tsx")))

  // ── A · dead-surface census ────────────────────────────────────────────────
  console.log("\n[A · dead-surface census — stripped source over app/**/*.tsx]")
  const all: Hit[] = []
  const a11y: Hit[] = []
  let buttons = 0, menuItems = 0
  const perJourney: Record<string, { modules: number; buttons: number; dead: number; mobile: number; a11y: number }> = {}
  for (const name of Object.keys(JOURNEYS)) perJourney[name] = { modules: 0, buttons: 0, dead: 0, mobile: 0, a11y: 0 }
  for (const abs of APP_TSX) {
    const raw = readFileSync(abs, "utf8")
    const s = stripComments(raw)
    const b = (s.match(/<(Button|button)(?=[\s/>])/g) ?? []).length
    buttons += b
    menuItems += (s.match(/<(DropdownMenuItem|ContextMenuItem|CommandItem|MenubarItem)(?=[\s/>])/g) ?? []).length
    const dead = deadSurfaces(rel(abs), raw)
    const access = a11yHits(rel(abs), raw)
    all.push(...dead)
    a11y.push(...access)
    const j = journeyOf(rel(abs))
    if (j) { perJourney[j].modules++; perJourney[j].buttons += b; perJourney[j].dead += dead.length; perJourney[j].a11y += access.length }
  }
  const byKind = (hits: Hit[]) => { const o: Record<string, Hit[]> = {}; for (const h of hits) (o[h.kind] ??= []).push(h); return o }
  const aByKind = byKind(all)
  const critical = all.filter((h) => isCritical(h.file) && !isExempt(h))
  console.log(`    denominator: ${APP_TSX.length} modules · ${buttons} buttons · ${menuItems} menu items · ${Object.keys(JOURNEYS).length} journeys / ${CRITICAL_PREFIXES.length} prefixes (hard zero) · ${APP_TSX.filter((f) => !isCritical(rel(f))).length} modules outside every journey (ratchet)`)
  for (const [k, v] of Object.entries(aByKind).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`    ${k}: ${v.length}`)
    for (const h of v.slice(0, 12)) console.log(`      ${isCritical(h.file) ? "P0/P1 " : "      "}${h.file}:${h.line}  ${h.detail}`)
    if (v.length > 12) console.log(`      … ${v.length - 12} more`)
  }
  console.log(`    a11y ICON_BUTTON_NO_LABEL: ${a11y.length} (ratchet; the first 8)`)
  for (const h of a11y.slice(0, 8)) console.log(`      ${h.file}:${h.line}  ${h.detail}`)
  console.log("    BLIND SPOTS: prop-passed handlers judged at the leaf; clickable-parent recognition is window-bounded (400 chars); JSX text unmasked; a handler that calls a real action and then lies about its result is test:discarded-outcome's job (scripts/discarded-outcome-guard.ts — the ONE census of a dropped action result; wave 143J widened it), not this one; STATE_ONLY reads handler NAMES (an unnamed inline arrow that saves nothing is not seen); CHANGE_STATE_UNREAD cannot see a read through a ref or a closure in another file.")
  check("A1 the census population is real (≥ 1,000 modules, ≥ 3,000 buttons)", APP_TSX.length >= 1000 && buttons >= 3000, `${APP_TSX.length} / ${buttons}`)
  check("A2 ZERO dead surfaces on every product journey (P0/P1) — wave 141's critical paths and wave 142's journeys alike", critical.length === 0, critical.map((h) => `${h.kind} ${h.file}:${h.line}`).join(", "))

  // ── B · mobile census over the critical flows ──────────────────────────────
  console.log("\n[B · mobile census — critical flows, static class analysis at 390px]")
  const criticalFiles = [...new Set(APP_TSX.filter((f) => isCritical(rel(f))))]
  const mob: Hit[] = []
  for (const abs of criticalFiles) {
    const hs = mobileHits(rel(abs), readFileSync(abs, "utf8"))
    mob.push(...hs)
    const j = journeyOf(rel(abs))
    if (j) perJourney[j].mobile += hs.filter((h) => /^(RAW_TABLE_NO_SCROLL|FIXED_WIDTH_400PLUS_NO_SCROLL|FIXED_SIDEBAR_NO_BREAKPOINT)$/.test(h.kind)).length
  }
  const mByKind = byKind(mob)
  /** The wave-141 ratchet population (MOBILE_RATCHET_PREFIXES) — a subset of the journeys. */
  const mobRatchet = mob.filter((h) => inRatchetPopulation(h.file))
  const mrByKind = byKind(mobRatchet)
  console.log(`    denominator: ${criticalFiles.length} journey modules (${criticalFiles.filter((f) => inRatchetPopulation(rel(f))).length} in the wave-141 ratchet population); ${(mByKind.TABLE_WITH_CARD_VARIANT ?? []).length + (mByKind.TABLE_NO_CARD_VARIANT ?? []).length} with a table`)
  for (const [k, v] of Object.entries(mByKind).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`    ${k}: ${v.length} (wave-141 population ${(mrByKind[k] ?? []).length})`)
    if (k !== "SUB_TOUCH_BUTTON" && k !== "GRID_COLS_3_NO_BREAKPOINT" && k !== "TABLE_WITH_CARD_VARIANT" && k !== "TABLE_NO_CARD_VARIANT" && k !== "GRID_COLS_4PLUS_NO_BREAKPOINT") for (const h of v.slice(0, 40)) console.log(`      ${h.file}:${h.line}  ${h.detail}${isExempt(h) ? "  (OUTSIDE-LANE — " + OUTSIDE_LANE_EXEMPTIONS.find((e) => e.file === h.file && e.kind === h.kind)!.lane + ")" : ""}`)
  }
  console.log("\n    per journey (modules · buttons · dead · mobile hard-zero hits · unlabelled icon buttons):")
  for (const [name, p] of Object.entries(perJourney)) console.log(`      ${name.padEnd(34)} ${String(p.modules).padStart(4)} · ${String(p.buttons).padStart(5)} · ${p.dead} · ${p.mobile} · ${p.a11y}`)
  console.log("    BLIND SPOTS: lexical class scan (no computed classes, no CSS modules, no runtime measurement); the sub-touch rule reads Tailwind height classes only and the design-system default (h-9 = 36px) is below the 44px target by design — an OWNER item, not a per-file fix; a rail hidden by a PARENT in another file (hidden lg:flex around a pane) reads as fixed unless the pane itself carries a breakpoint.")
  const hard = (k: string) => (mByKind[k] ?? []).filter((h) => !isExempt(h))
  check("B1 no raw <table> on any journey lacks a horizontal scroll container", hard("RAW_TABLE_NO_SCROLL").length === 0, hard("RAW_TABLE_NO_SCROLL").map((h) => `${h.file}:${h.line}`).join(", "))
  check("B2 no fixed ≥ 400px width on any journey without a scroll container or a breakpoint", hard("FIXED_WIDTH_400PLUS_NO_SCROLL").length === 0, hard("FIXED_WIDTH_400PLUS_NO_SCROLL").map((h) => `${h.file}:${h.line}`).join(", "))
  check("B3 no fixed sidebar (w-64…w-96, bordered or shrink-0 outside a scroll row) on any journey without a breakpoint", hard("FIXED_SIDEBAR_NO_BREAKPOINT").length === 0, hard("FIXED_SIDEBAR_NO_BREAKPOINT").map((h) => `${h.file}:${h.line}`).join(", "))
  const stale = OUTSIDE_LANE_EXEMPTIONS.filter((e) => !mob.some((h) => h.file === e.file && h.kind === e.kind) && !all.some((h) => h.file === e.file && h.kind === e.kind))
  check("X1 every OUTSIDE-LANE exemption still reproduces the finding it names (a fixed one must be deleted — an exemption never outlives its defect)", stale.length === 0, stale.map((e) => `${e.file} ${e.kind} (${e.lane})`).join(", "))
  /** The PRIMARY lists this lane adapted (table → cards below md). A rule on each file, not a count. */
  const PRIMARY_LISTS = ["app/settings/users/users-management-client.tsx", "app/dashboard/admin/users/invitations/invitations-table.tsx", "app/settings/billing/invoice-history-table.tsx", "app/dashboard/transactions/page.tsx"]
  const primaryMissing = PRIMARY_LISTS.filter((f) => !(mByKind.TABLE_WITH_CARD_VARIANT ?? []).some((h) => h.file === f))
  check("B4 the four primary lists (seats, invitations, invoices, transactions) render a card variant below md", primaryMissing.length === 0, primaryMissing.join(", "))

  // ── C · the surfaces this lane wired stay wired (rules) ───────────────────
  console.log("\n[C · wired surfaces — rules on the survivors, not waypoints]")
  const read = (p: string) => (existsSync(join(ROOT, p)) ? stripComments(readFileSync(join(ROOT, p), "utf8")) : "")
  const play = read("app/portal/[contactId]/components/seller-mode/agent-update-video-card.tsx")
  check("C1 the seller-portal play control is a <button> with a handler that mounts the ONE portal player (CardVideoPlayer)", /<button[^>]*onClick=\{[^}]*setPlaying\(true\)/.test(play) && /<CardVideoPlayer\b/.test(play) && /from\s+["']\.\.\/CardVideoPlayer["']/.test(play))
  const portalSettings = read("app/components/portal/PortalSettingsPage.tsx")
  // RE-ASSERTED ON THE RULE (wave 147, lane 147H — ruling 9): the C2 waypoint pinned two DISABLED switches captioned
  // "Not available yet". Lane 147H finished them: the activity switch left the launch surface (agents see portal
  // activity by design — stated as the rule) and the family switch became a link to the control that already existed
  // (the shared-search member list). The rule C2 guarded: no portal privacy control is a dead toggle — every <Switch>
  // binds onCheckedChange or is disabled with the truth beside it, and the family visibility control reaches the
  // shared-search page where members are managed.
  const deadPortalSwitch = (src: string) => [...src.matchAll(/<Switch\b([^>]*)\/?>/g)].filter((m) => !/\bonCheckedChange\b/.test(m[1]) && !/\bdisabled\b/.test(m[1])).length
  const disabledWithoutTruth = (portalSettings.match(/<Switch[^>]*\bdisabled\b/g) ?? []).length > (portalSettings.match(/Not available yet|isn['’]t (?:available|configured)|not configured/gi) ?? []).length
  check("C2 no portal privacy control is a dead toggle (every <Switch> is bound or disabled with the truth beside it) and family visibility reaches the shared-search member control", deadPortalSwitch(portalSettings) === 0 && !disabledWithoutTruth && /href=\{`\/portal\/\$\{contactId\}\/search`\}/.test(portalSettings))
  check("C2 POSITIVE CONTROL — an enabled handler-less switch is dead; a bound one is not", deadPortalSwitch(`<Switch defaultChecked />`) === 1 && deadPortalSwitch(`<Switch checked={v} onCheckedChange={set} />`) === 0)
  const providersPage = read("app/dashboard/admin/system/providers/page.tsx")
  // Integration (2026-10-14): the refusal is IN PLACE (RoleGateNotice — page-role-gate-roster P5: a
  // redirect("/dashboard") on a role refusal is "a click that appeared to do nothing"); the gate still
  // decides before the client renders and the notice names the audience without revealing platform data.
  check("C3 the platform providers console gates on requireSuperadmin before rendering the client and refuses IN PLACE (RoleGateNotice, never a silent bounce; platform staff see full config; a tenant never reaches it)", /requireSuperadmin\(\)/.test(providersPage) && /if\s*\(!gate\.ok\)\s*return\s*<RoleGateNotice\b/.test(providersPage) && !/redirect\(/.test(providersPage) && providersPage.indexOf("requireSuperadmin()") < providersPage.indexOf("<SystemProvidersClient"))
  const crm = read("app/crm/page.tsx"), agent = read("app/dashboard/agent/page.tsx")
  const contactPages = walkTs(join(ROOT, "app/crm/contacts/[contactId]")).filter((f) => /\/page\.tsx$|client\.tsx$/.test(f)).map((f) => stripComments(readFileSync(f, "utf8"))).join("\n")
  check("C4 embedded intelligence is MOUNTED, not merely exported: NextBestActionPanel on the CRM board, AgentNextBestActions on the agent dashboard, follow-up + buyer-insights cards on the contact detail", /<NextBestActionPanel\b/.test(crm) && /<AgentNextBestActions\b/.test(agent) && /followup-card/.test(contactPages) && /buyer-insights-panel/.test(contactPages))
  const academy = read("app/academy/page.tsx")
  check("C5 the academy category cards are controls (onSelect wired, aria-pressed, list filtered by resourceType)", /onSelect=\{\(\) => setResourceType/.test(academy) && /aria-pressed=/.test(academy) && /visibleResources/.test(academy))
  // ── wave 142 (lane 142H): the surfaces this lane wired — rules, not waypoints ──
  const comingSoon = read("app/components/dashboard/listings/lifecycle/coming-soon-command-card.tsx")
  const socialAction = read("app/actions/social-media-automation.ts"), emailAction = read("app/actions/email-campaigns.ts")
  check("C6 the Coming-Soon card ships the agent's REVIEWED copy: the edited social post reaches createListingPosts (contentOverride) and the edited teaser reaches prepareListingEmailCampaign (bodyOverride), and both actions read the field they declare",
    /createListingPosts\(\{[^}]*contentOverride:\s*socialPost\b/.test(comingSoon) && /prepareListingEmailCampaign\(\{[^}]*bodyOverride:\s*emailBody\b/.test(comingSoon) &&
    /contentOverride\?:\s*string/.test(socialAction) && /params\.contentOverride/.test(socialAction) &&
    /bodyOverride\?:\s*string/.test(emailAction) && /params\.bodyOverride/.test(emailAction))
  const videoAnalytics = read("app/dashboard/videos/analytics/page.tsx"), videoAction = read("app/actions/video-generation.ts")
  check("C7 the video-analytics range reaches its read: the page passes { sinceDays } to getVideoPerformanceStats and the action applies it to the project query",
    /getVideoPerformanceStats\([^)]*\{\s*sinceDays\b/.test(videoAnalytics) && /opts\?\.sinceDays[\s\S]{0,200}\.gte\("created_at"/.test(videoAction))
  const roiPage = read("app/dashboard/campaigns/roi/page.tsx"), roiClient = read("app/dashboard/campaigns/roi/roi-dashboard-client.tsx")
  check("C8 the ROI 'Date Window' reaches its read: the page resolves ?window= through resolveRoiWindow and passes the bounds to getChannelPerformanceData; the client's select writes the URL (router.replace) and says what the window applies to",
    /searchParams/.test(roiPage) && /resolveRoiWindow\(/.test(roiPage) && /getChannelPerformanceData\([^)]*windowStart,\s*windowEnd\)/.test(roiPage) &&
    /onValueChange=\{changeWindow\}/.test(roiClient) && /router\.replace\(`\?window=\$\{v\}`\)/.test(roiClient) && /Applies to the Channel Comparison/.test(roiClient))
  const composer = read("app/components/listings/SellerUpdateComposer.tsx"), sellerUpdates = read("app/actions/seller-updates.ts")
  check("C9 'Save as Draft' on the seller-update composer persists through the drafts survivor: the composer calls saveSellerUpdateDraft and loads loadSellerUpdateDraft back; the action writes ai_message_drafts with the seller_update trigger and reads the pending row by it; the send stamps the draft sent",
    /saveSellerUpdateDraft\(\{/.test(composer) && /loadSellerUpdateDraft\(listingId\)/.test(composer) &&
    /from\("ai_message_drafts"\)[\s\S]{0,400}trigger_event:\s*SELLER_UPDATE_DRAFT_TRIGGER/.test(sellerUpdates) &&
    /\.eq\("trigger_event",\s*SELLER_UPDATE_DRAFT_TRIGGER\)[\s\S]{0,120}\.eq\("status",\s*"pending"\)/.test(sellerUpdates) &&
    /status:\s*"sent"[\s\S]{0,300}\.eq\("trigger_event",\s*SELLER_UPDATE_DRAFT_TRIGGER\)/.test(sellerUpdates))
  const settingsSidebar = read("app/components/settings/SettingsSidebar.tsx"), settingsLayout = read("app/settings/layout.tsx")
  check("C10 the settings rail adapts: a md:hidden horizontal section strip, the w-64 aside hidden below md, and the layout stacks (flex-col md:flex-row)",
    /<nav[^>]*className="[^"]*\bmd:hidden\b/.test(settingsSidebar) && /<aside className="hidden md:block w-64/.test(settingsSidebar) && /flex flex-col md:flex-row h-screen/.test(settingsLayout))
  const vendorContact = read("app/transaction/vendors/contact/page.tsx")
  check("C11 the TC 'Contact Vendor' route never renders a form again — it redirects to the vendor directory (the booking survivor) and carries no <form>", /redirect\(['"]\/dashboard\/vendors['"]\)/.test(vendorContact) && !/<form\b/.test(vendorContact) && !/setTimeout/.test(vendorContact))

  // ── S · Playwright smoke (opt-in; honest SKIPPED otherwise) ────────────────
  console.log("\n[S · Playwright smoke at 1280 / 820 / 390 — opt-in]")
  const base = process.env.UI_SMOKE_BASE_URL
  let browserOk = false
  try { const pw = await import("playwright"); const b = await pw.chromium.launch({ headless: true }); await b.close(); browserOk = true } catch { browserOk = false }
  if (!base || !browserOk) {
    console.log(`    SKIPPED — ${!base ? "UI_SMOKE_BASE_URL not set" : "no Chromium available in this environment"}; nothing is claimed about rendered overflow (published blind spot; the static census above is the proof that ran).`)
  } else {
    const pw = await import("playwright")
    const browser = await pw.chromium.launch({ headless: true })
    const pages = ["/login", "/signup", "/get-started", "/pricing"]
    let overflow: string[] = []
    for (const width of [1280, 820, 390]) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 } })
      const page = await ctx.newPage()
      for (const p of pages) {
        try {
          await page.goto(base + p, { waitUntil: "domcontentloaded", timeout: 30000 })
          const sw = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth))
          if (sw > width + 1) overflow.push(`${p}@${width} scrollWidth ${sw}`)
        } catch (e) { overflow.push(`${p}@${width} failed: ${String((e as Error).message).slice(0, 80)}`) }
      }
      await ctx.close()
    }
    await browser.close()
    check("S1 no horizontal page overflow on the public critical pages at 1280 / 820 / 390", overflow.length === 0, overflow.join("; "))
  }

  // ── R · ratchets ───────────────────────────────────────────────────────────
  console.log("\n[R · ratchets — shrink-only counts outside the hard zeros]")
  const counts: Record<string, number> = {}
  for (const [k, v] of Object.entries(aByKind)) counts[`dead.${k}`] = v.length
  const MOBILE_RATCHET_KINDS = ["GRID_COLS_4PLUS_NO_BREAKPOINT", "GRID_COLS_3_NO_BREAKPOINT", "NOWRAP_FLEX_ROW", "SUB_TOUCH_BUTTON", "TABLE_NO_CARD_VARIANT"]
  // mobile.* keeps the wave-141 MEASURED population (so it only falls); journeys.* is the wave-142 population; a11y.* is the whole app.
  for (const k of MOBILE_RATCHET_KINDS) counts[`mobile.${k}`] = (mrByKind[k] ?? []).length
  for (const k of MOBILE_RATCHET_KINDS) counts[`journeys.${k}`] = (mByKind[k] ?? []).length
  counts["a11y.ICON_BUTTON_NO_LABEL"] = a11y.length
  if (process.argv.includes("--write-baseline")) {
    writeFileSync(BASELINE_PATH, JSON.stringify({ _: "Shrink-only ratchets for scripts/ui-wiring-census-guard.ts. dead.* = dead-surface hits OUTSIDE the journeys (the journeys are a hard zero); mobile.* = static mobile findings on the wave-141 critical paths (lane 141I, measured 2026-10-14 — that population is frozen so these only fall); journeys.* = the same findings over every product journey (lane 142H, measured 2026-10-19 after the lane's fixes); a11y.* = icon buttons without an accessible name over the whole app (142H). Each may only fall; regenerate deliberately with --write-baseline and say why in the commit.", counts }, null, 2) + "\n")
    console.log(`    baseline written: ${JSON.stringify(counts)}`)
  }
  const baseline = existsSync(BASELINE_PATH) ? (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as { counts: Record<string, number> }).counts : {}
  const grew = Object.entries(counts).filter(([k, n]) => n > (baseline[k] ?? 0)).map(([k, n]) => `${k} ${baseline[k] ?? 0} → ${n}`)
  console.log(`    counts: ${Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(" · ")}`)
  check("R1 no ratcheted count grew (dead surfaces off the journeys; mobile findings on the wave-141 paths and on the journeys; unlabelled icon buttons)", grew.length === 0, grew.join(", "))
  check("R2 the baseline file exists and names every ratcheted key", Object.keys(counts).every((k) => k in baseline), Object.keys(counts).filter((k) => !(k in baseline)).join(", "))

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail) { console.log("FAILURES:\n  - " + fails.join("\n  - ")); process.exit(1) }
  console.log("✅ UI_WIRING_CENSUS_PASS")
}
main().catch((e) => { console.error(e); process.exit(1) })
