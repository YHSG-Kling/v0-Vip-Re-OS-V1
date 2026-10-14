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
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import { walkTs } from "./runtime-roots"

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
/** Subscriber / agent critical paths (lane 141I prompt): a dead surface here is P0/P1 and fails. */
export const CRITICAL_PREFIXES = [
  "app/signup", "app/get-started", "app/login", "app/onboarding", "app/dashboard/onboarding", "app/dashboard/getting-started",
  "app/dashboard/admin/users", "app/settings/users", "app/dashboard/settings/team", "app/dashboard/settings/teams", "app/vendor-invite",
  "app/crm/contacts", "app/leads", "app/dashboard/listings", "app/listings", "app/offers", "app/dashboard/offers",
  "app/transactions", "app/dashboard/transactions", "app/transaction",
  "app/settings", "app/dashboard/settings", "app/dashboard/admin/billing",
  "app/dashboard/marketing/lead-magnets", "app/lm", "app/site", "app/dashboard/tools/home-value",
  "app/portal", "app/components/portal", "app/vendor", "app/lender",
]
const isCritical = (f: string) => CRITICAL_PREFIXES.some((p) => f === p || f.startsWith(p + "/"))

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
  return hits
}

// ── B · mobile finders (PURE) ─────────────────────────────────────────────────
export function mobileHits(file: string, raw: string): Hit[] {
  const src = stripComments(raw)
  const hits: Hit[] = []
  const push = (i: number, kind: string, detail: string) => hits.push({ file, line: lineOf(src, i), kind, detail: detail.replace(/\s+/g, " ").slice(0, 90) })
  const hasScroll = /overflow-x-auto/.test(src)
  for (const m of src.matchAll(/<([A-Za-z][A-Za-z0-9.]*)\b/g)) {
    const tag = openingTag(src, m.index!); if (!tag) continue
    const cls = /className=\{?["'`]([^"'`]*)["'`]/.exec(tag.attrs)?.[1]; if (!cls) continue
    const name = m[1]
    const fixed = /(^|\s)grid-cols-(\d+)/.exec(cls)
    if (fixed && Number(fixed[2]) >= 3 && !/\b(sm|md|lg|xl):grid-cols-/.test(cls) && name !== "TabsList")
      push(m.index!, Number(fixed[2]) >= 4 ? "GRID_COLS_4PLUS_NO_BREAKPOINT" : "GRID_COLS_3_NO_BREAKPOINT", cls)
    for (const w of cls.matchAll(/(?:^|\s)(?:min-)?w-\[(\d{3,4})px\]/g)) if (Number(w[1]) >= 400 && !hasScroll && !/\b(sm|md|lg):w-/.test(cls) && !/\bw-full\b/.test(cls)) push(m.index!, "FIXED_WIDTH_400PLUS_NO_SCROLL", `${w[0].trim()} · ${cls}`)
    if (/(^|\s)w-(64|72|80|96)(\s|$)/.test(cls) && /\b(shrink-0|flex-shrink-0|border-[lr])\b/.test(cls) && !/\b(sm|md|lg|xl):(w-|hidden|block|flex)/.test(cls) && !/\bhidden\b|\bw-full\b/.test(cls))
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
    mh(`<div className="md:hidden">cards</div><div className="hidden md:block"><Table /></div>`).includes("TABLE_WITH_CARD_VARIANT") && mh(`<Table />`).includes("TABLE_NO_CARD_VARIANT"))

  // ── A · dead-surface census ────────────────────────────────────────────────
  console.log("\n[A · dead-surface census — stripped source over app/**/*.tsx]")
  const all: Hit[] = []
  let buttons = 0, menuItems = 0
  for (const abs of APP_TSX) {
    const raw = readFileSync(abs, "utf8")
    const s = stripComments(raw)
    buttons += (s.match(/<(Button|button)(?=[\s/>])/g) ?? []).length
    menuItems += (s.match(/<(DropdownMenuItem|ContextMenuItem|CommandItem|MenubarItem)(?=[\s/>])/g) ?? []).length
    all.push(...deadSurfaces(rel(abs), raw))
  }
  const byKind = (hits: Hit[]) => { const o: Record<string, Hit[]> = {}; for (const h of hits) (o[h.kind] ??= []).push(h); return o }
  const aByKind = byKind(all)
  const critical = all.filter((h) => isCritical(h.file))
  console.log(`    denominator: ${APP_TSX.length} modules · ${buttons} buttons · ${menuItems} menu items · ${CRITICAL_PREFIXES.length} critical-path prefixes`)
  for (const [k, v] of Object.entries(aByKind).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`    ${k}: ${v.length}`)
    for (const h of v.slice(0, 12)) console.log(`      ${isCritical(h.file) ? "P0/P1 " : "      "}${h.file}:${h.line}  ${h.detail}`)
    if (v.length > 12) console.log(`      … ${v.length - 12} more`)
  }
  console.log("    BLIND SPOTS: prop-passed handlers judged at the leaf; clickable-parent recognition is window-bounded (400 chars); JSX text unmasked; a handler that calls a real action and then lies about its result is test:ui-delivery's domain, not this one.")
  check("A1 the census population is real (≥ 1,000 modules, ≥ 3,000 buttons)", APP_TSX.length >= 1000 && buttons >= 3000, `${APP_TSX.length} / ${buttons}`)
  check("A2 ZERO dead surfaces on the subscriber/agent critical paths (P0/P1)", critical.length === 0, critical.map((h) => `${h.kind} ${h.file}:${h.line}`).join(", "))

  // ── B · mobile census over the critical flows ──────────────────────────────
  console.log("\n[B · mobile census — critical flows, static class analysis at 390px]")
  const criticalFiles = [...new Set(APP_TSX.filter((f) => isCritical(rel(f))))]
  const mob: Hit[] = []
  for (const abs of criticalFiles) mob.push(...mobileHits(rel(abs), readFileSync(abs, "utf8")))
  const mByKind = byKind(mob)
  console.log(`    denominator: ${criticalFiles.length} critical-flow modules; ${(mByKind.TABLE_WITH_CARD_VARIANT ?? []).length + (mByKind.TABLE_NO_CARD_VARIANT ?? []).length} with a table`)
  for (const [k, v] of Object.entries(mByKind).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`    ${k}: ${v.length}`)
    if (k !== "SUB_TOUCH_BUTTON" && k !== "GRID_COLS_3_NO_BREAKPOINT" && k !== "TABLE_WITH_CARD_VARIANT") for (const h of v.slice(0, 40)) console.log(`      ${h.file}:${h.line}  ${h.detail}`)
  }
  console.log("    BLIND SPOTS: lexical class scan (no computed classes, no CSS modules, no runtime measurement); the sub-touch rule reads Tailwind height classes only and the design-system default (h-9 = 36px) is below the 44px target by design — an OWNER item, not a per-file fix.")
  const zero = (k: string) => (mByKind[k] ?? []).length
  check("B1 no raw <table> on a critical flow lacks a horizontal scroll container", zero("RAW_TABLE_NO_SCROLL") === 0, (mByKind.RAW_TABLE_NO_SCROLL ?? []).map((h) => `${h.file}:${h.line}`).join(", "))
  check("B2 no fixed ≥ 400px width on a critical flow without a scroll container or a breakpoint", zero("FIXED_WIDTH_400PLUS_NO_SCROLL") === 0, (mByKind.FIXED_WIDTH_400PLUS_NO_SCROLL ?? []).map((h) => `${h.file}:${h.line}`).join(", "))
  check("B3 no fixed sidebar (w-64…w-96, shrink-0/border) on a critical flow without a breakpoint", zero("FIXED_SIDEBAR_NO_BREAKPOINT") === 0, (mByKind.FIXED_SIDEBAR_NO_BREAKPOINT ?? []).map((h) => `${h.file}:${h.line}`).join(", "))
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
  check("C2 the portal privacy switches are disabled with the honest 'Not available yet' sentence beside them (never a dead toggle)", (portalSettings.match(/<Switch[^>]*\bdisabled\b/g) ?? []).length >= 2 && (portalSettings.match(/Not available yet/g) ?? []).length >= 2)
  const providersPage = read("app/dashboard/admin/system/providers/page.tsx")
  check("C3 the platform providers console gates on requireSuperadmin before rendering the client (platform staff see full config; a tenant never reaches it)", /requireSuperadmin\(\)/.test(providersPage) && /if\s*\(!gate\.ok\)\s*redirect\(/.test(providersPage) && providersPage.indexOf("requireSuperadmin()") < providersPage.indexOf("<SystemProvidersClient"))
  const crm = read("app/crm/page.tsx"), agent = read("app/dashboard/agent/page.tsx")
  const contactPages = walkTs(join(ROOT, "app/crm/contacts/[contactId]")).filter((f) => /\/page\.tsx$|client\.tsx$/.test(f)).map((f) => stripComments(readFileSync(f, "utf8"))).join("\n")
  check("C4 embedded intelligence is MOUNTED, not merely exported: NextBestActionPanel on the CRM board, AgentNextBestActions on the agent dashboard, follow-up + buyer-insights cards on the contact detail", /<NextBestActionPanel\b/.test(crm) && /<AgentNextBestActions\b/.test(agent) && /followup-card/.test(contactPages) && /buyer-insights-panel/.test(contactPages))
  const academy = read("app/academy/page.tsx")
  check("C5 the academy category cards are controls (onSelect wired, aria-pressed, list filtered by resourceType)", /onSelect=\{\(\) => setResourceType/.test(academy) && /aria-pressed=/.test(academy) && /visibleResources/.test(academy))

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
  for (const k of ["GRID_COLS_4PLUS_NO_BREAKPOINT", "GRID_COLS_3_NO_BREAKPOINT", "NOWRAP_FLEX_ROW", "SUB_TOUCH_BUTTON", "TABLE_NO_CARD_VARIANT"]) counts[`mobile.${k}`] = zero(k)
  if (process.argv.includes("--write-baseline")) {
    writeFileSync(BASELINE_PATH, JSON.stringify({ _: "Shrink-only ratchets for scripts/ui-wiring-census-guard.ts (lane 141I, measured 2026-10-14 after the lane's fixes). dead.* = dead-surface hits OUTSIDE the critical paths (critical paths are a hard zero); mobile.* = static mobile findings on the critical flows that are published, not failed. Each may only fall; regenerate deliberately with --write-baseline and say why in the commit.", counts }, null, 2) + "\n")
    console.log(`    baseline written: ${JSON.stringify(counts)}`)
  }
  const baseline = existsSync(BASELINE_PATH) ? (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as { counts: Record<string, number> }).counts : {}
  const grew = Object.entries(counts).filter(([k, n]) => n > (baseline[k] ?? 0)).map(([k, n]) => `${k} ${baseline[k] ?? 0} → ${n}`)
  console.log(`    counts: ${Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(" · ")}`)
  check("R1 no ratcheted count grew (dead surfaces off the critical paths; mobile findings on them)", grew.length === 0, grew.join(", "))
  check("R2 the baseline file exists and names every ratcheted key", Object.keys(counts).every((k) => k in baseline), Object.keys(counts).filter((k) => !(k in baseline)).join(", "))

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail) { console.log("FAILURES:\n  - " + fails.join("\n  - ")); process.exit(1) }
  console.log("✅ UI_WIRING_CENSUS_PASS")
}
main().catch((e) => { console.error(e); process.exit(1) })
