#!/usr/bin/env tsx
/**
 * scripts/rendered-empty-states-guard.ts   (npm run test:rendered-empty-states)
 * ─────────────────────────────────────────────────────────────────────────────
 * A LIST SURFACE SAYS SO WHEN IT IS EMPTY — PROVED BY RENDERING, NOT BY GREP.
 *
 * Lane 90D (wave 90 production walkthrough; owner: "walk through every section of
 * the platform … add test data if need be … note any areas of improvement, areas
 * that need fixing"). Lane 89D's static route walk tallied 120 pages as
 * NO_EMPTY_STATE by a vocabulary grep to import depth 2 and published that as a
 * blind spot (89D §2, §6 P2-7): "the walk cannot prove an empty state for the
 * ~100 client components it did not open". A vocabulary grep is blind both ways
 * — `>No transactions found<` in JSX text never matched its `"No ` pattern, and a
 * component can carry the words in a branch that never renders. A brand-new
 * tenant's day one is every list at zero rows; a page that renders a bare heading
 * or nothing at all reads as broken, not as empty.
 *
 * WHAT IS HELD (populations DERIVED from the tree, never listed by hand):
 *   P0 POSITIVE CONTROLS — the classifier and the mount harness are run against
 *      fixtures whose verdict is known: a list that renders `null` on [] must
 *      read BLANK; a list that says "No items yet" must read PASS; a heading-only
 *      list must read NO_SENTENCE; a component that calls useRouter()/
 *      useSearchParams()/usePathname() must MOUNT (the harness supplies the App
 *      Router contexts, so a router-using list is not silently unmountable); a
 *      component that throws must read UNMOUNTABLE and never PASS.
 *   P1 RENDERED EMPTY STATES — every `"use client"` component under app/ (ui
 *      primitives and API routes excluded) whose exported component takes at
 *      least one ARRAY-typed prop is imported for real and mounted under
 *      react-dom/server with every array prop `[]` and every other prop a typed
 *      placeholder ("" / 0 / false / {} / noop). The rendered TEXT is classified:
 *        PASS         — carries an empty-state sentence ("No … yet", "Nothing …",
 *                       "will appear here", "haven't …", "Get started …");
 *        NO_SENTENCE  — renders text but never says the list is empty (soft:
 *                       a heading + zero rows; listed, ratcheted, not failed);
 *        BLANK        — renders no meaningful text at all on empty input (the
 *                       defect; must be 0);
 *        UNMOUNTABLE  — could not import or render under Node (reason recorded,
 *                       published as the blind spot beside the numbers).
 *   P2 STATIC SUBTREE CENSUS — for every app/**\/page.tsx, the page and its
 *      whole import subtree (app/ + components/, stripped source, any depth) is
 *      read; a page whose subtree maps over data and carries NO empty vocabulary
 *      anywhere is LIST_WITHOUT_EMPTY_STATE. This is the server-rendered half
 *      that P1 cannot mount (async server pages need a session) — a ratchet.
 *
 * Ratchets live in scripts/rendered-empty-states-baseline.json and may only
 * fall. Comments are stripped before any token scan (CLAUDE.md §2); the rendered
 * check reads output, not source, so a tombstone cannot fool it either way.
 *
 * Blind spots (published): P1 renders the component's INITIAL client state —
 * a component that fetches in useEffect renders its pre-fetch branch, which is
 * what a slow network shows and is classified as such; nested-object props are
 * `{}` so a component that dereferences `contact.address.city` is UNMOUNTABLE
 * rather than proven; server pages are held only by P2's lexical census.
 */
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { fileURLToPath } from "node:url"
import { blankComments } from "./strip-comments"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const BASELINE_PATH = path.join(HERE, "rendered-empty-states-baseline.json")
const req = createRequire(path.join(ROOT, "package.json"))

// The harness must never reach a live project: stub env so client-side supabase
// factories construct without throwing; nothing here performs I/O (SSR runs no effects).
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://127.0.0.1:1"
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "rendered-empty-states-stub"
// `server-only` throws at load outside the RSC condition and, because tsx links
// CJS synchronously, the throw escapes a dynamic import()'s rejection and kills
// the process. Pre-seed its cache entry so a client component whose lib import
// reaches it (through a barrel the bundler tree-shakes) is still mounted. The
// client/server boundary itself is held by test:client-server-only, not here.
{
  const Module = req("node:module") as { _cache: Record<string, unknown> }
  for (const name of ["server-only", "client-only"]) {
    try { const p = req.resolve(name); Module._cache[p] = { id: p, filename: p, loaded: true, exports: {} } } catch { /* not installed */ }
  }
}

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ── Vocabulary ────────────────────────────────────────────────────────────────
// Rendered TEXT (tags already replaced by newlines) — a sentence that tells the
// viewer the list is empty. Kept deliberately narrow: "no credit card required"
// must not count, "No showings yet" must.
const EMPTY_SENTENCE = /(^|\n)\s*(no|nothing|none)\b[^\n]{0,80}\b(yet|found|scheduled|recorded|available|so far|to show|right now|to display|to review|pending|assigned|configured|connected|logged|tracked|added|created|generated|uploaded|selected|saved|here|in progress|on file|at the moment|for now)\b|(^|\n)No\s+(?![^\n]*\b(credit|required|longer|thanks|obligation)\b)[a-z][a-z' -]{1,40}\.?(\n|$)|\bnothing (here|to show|yet|scheduled|staged|recorded|queued|waiting|pending)\b|\bhaven'?t\b|\bhasn'?t\b|\bget started\b|\bwill (appear|show up|be listed|populate) here\b|\bappear here\b|\bshow up here\b|\bonce you\b|\bnot yet\b|\bempty\b|\bstart by\b|\bcreate your first\b|\badd your first\b/i
// Source-side vocabulary for the P2 lexical census (stripped source).
const EMPTY_SOURCE = /[>"'`{(]\s*No\s+[a-z]|No\s+\w+(\s+\w+)?\s+(yet|found|scheduled|recorded|available|to show|so far)|Nothing (here|to show|yet|scheduled|recorded|staged|queued)|empty-state|EmptyState|emptyState|haven.t|hasn.t|Get started|No results|not yet|yet\.|length === 0 \?|\.length === 0|\.length\s*>\s*0\s*(\?|&&)|\.length\s*\?|!\w+\.length|isEmpty|Once you|will appear here|show up here|appear here/i

// ── File helpers ─────────────────────────────────────────────────────────────
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, out) }
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}
const srcCache = new Map<string, string>()
const stripped = (abs: string) => { let s = srcCache.get(abs); if (s === undefined) { s = blankComments(fs.readFileSync(abs, "utf8")); srcCache.set(abs, s) } return s }
const rel = (abs: string) => path.relative(ROOT, abs)
const isClient = (s: string) => /^\s*["']use client["']/m.test(s)

function resolveImport(fromAbs: string, spec: string): string | null {
  let base: string
  if (spec.startsWith("@/")) base = path.join(ROOT, spec.slice(2))
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromAbs), spec)
  else return null
  for (const ext of ["", ".tsx", ".ts", "/index.tsx", "/index.ts"]) {
    const p = base + ext
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
  }
  return null
}

// ── Prop-signature parser (component's declared props → typed placeholders) ──
function balanced(s: string, open: number, o = "{", c = "}"): string | null {
  if (s[open] !== o) return null
  let d = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === o) d++
    else if (s[i] === c) { d--; if (d === 0) return s.slice(open + 1, i) }
  }
  return null
}
function splitTop(body: string): string[] {
  const out: string[] = []; let d = 0, cur = ""
  for (const ch of body) {
    if ("{[(<".includes(ch)) d++
    if ("}])>".includes(ch)) d--
    if (d === 0 && (ch === ";" || ch === "," || ch === "\n")) { if (cur.trim()) out.push(cur.trim()); cur = ""; continue }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}
type PropSpec = { name: string; type: string; optional: boolean }
function parsePropsBody(body: string): PropSpec[] {
  const specs: PropSpec[] = []
  for (const entry of splitTop(body)) {
    const m = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(\?)?\s*:\s*([\s\S]+)$/.exec(entry)
    if (m) specs.push({ name: m[1], optional: !!m[2], type: m[3].trim() })
  }
  return specs
}
function isArrayType(t: string): boolean {
  const core = t.replace(/\s*\|\s*(null|undefined)\s*/g, "").trim()
  return /\[\]$/.test(core) || /^(Readonly)?Array</.test(core) || /^readonly\s+.*\[\]$/.test(core)
}
function placeholderFor(t: string, name = "text"): unknown {
  if (isArrayType(t)) return []
  const core = t.replace(/\s*\|\s*(null|undefined)\s*/g, "").trim()
  if (/=>/.test(core)) return () => undefined
  // A string prop carries its own NAME so caller-supplied copy (a title, a
  // label, an emptyMessage) shows up as text and BLANK means the component
  // itself put nothing readable on the page. A string-literal union keeps its
  // first member so a discriminated branch still renders.
  if (/^["'`]/.test(core)) return core.split("|")[0].trim().replace(/^["'`]|["'`]$/g, "")
  if (/^string\b/.test(core)) return name
  if (/^number\b/.test(core)) return 0
  if (/^boolean\b/.test(core)) return false
  if (/^(React\.)?(ReactNode|ReactElement|JSX\.Element)\b/.test(core)) return null
  if (/\|\s*null/.test(t)) return null
  if (/^Record<|^\{|^Partial<|^Pick<|^Omit<|^NonNullable<|^[A-Z][\w.]*(<[^>]*>)?$/.test(core)) return {}
  return undefined
}
/** Finds the exported component + its props. Returns null when the file has no
 *  recognisable exported component signature. */
function componentSignature(src: string): { exportName: string; props: PropSpec[] } | null {
  // 1) export default function Name(<params>)  /  export function Name(<params>)
  const fn = /export\s+(default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(src)
  let exportName: string | null = null, paramsText: string | null = null
  if (fn) {
    exportName = fn[1] ? "default" : fn[2]
    paramsText = balanced(src, fn.index + fn[0].length - 1, "(", ")")
  } else {
    // 2) export const Name = ({...}: Props) =>  |  export default (…)
    const arrow = /export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:React\.)?(?:memo|forwardRef)?\(?\s*(?:async\s+)?\(/.exec(src)
    if (!arrow) return null
    exportName = arrow[1]
    paramsText = balanced(src, arrow.index + arrow[0].length - 1, "(", ")")
  }
  if (!exportName || paramsText === null) return null
  const params = paramsText.trim()
  if (!params) return { exportName, props: [] }
  // first param only: `{ a, b }: { … }` | `{ a }: Props` | `props: Props`
  let typeStart = -1, depth = 0
  for (let i = 0; i < params.length; i++) {
    const ch = params[i]
    if ("{[(<".includes(ch)) depth++
    else if ("}])>".includes(ch)) depth--
    else if (ch === ":" && depth === 0) { typeStart = i + 1; break }
    else if (ch === "," && depth === 0) break
  }
  if (typeStart < 0) return { exportName, props: [] }
  let typeText = params.slice(typeStart).trim()
  // drop a default initialiser (`= {}`) and a trailing second param
  typeText = typeText.replace(/\s*=\s*\{\}\s*$/, "")
  let body: string | null = null
  if (typeText.startsWith("{")) body = balanced(typeText, 0)
  else {
    const ident = /^(?:Readonly<)?([A-Za-z_$][\w$]*)/.exec(typeText)?.[1]
    if (ident) {
      const decl = new RegExp(`(?:interface\\s+${ident}\\s*(?:extends[^{]+)?\\{|type\\s+${ident}\\s*=\\s*\\{)`).exec(src)
      if (decl) body = balanced(src, decl.index + decl[0].length - 1)
    }
  }
  if (body === null) return { exportName, props: [] }
  return { exportName, props: parsePropsBody(body) }
}

// ── Mount harness (App Router contexts so useRouter/useSearchParams/usePathname resolve) ──
const { AppRouterContext } = req("next/dist/shared/lib/app-router-context.shared-runtime.js")
const { PathnameContext, SearchParamsContext, PathParamsContext } = req("next/dist/shared/lib/hooks-client-context.shared-runtime.js")
const stubRouter = { push() {}, replace() {}, back() {}, forward() {}, refresh() {}, prefetch() {}, hmrRefresh() {} }
function mount(Comp: React.ComponentType<any>, props: Record<string, unknown>): string {
  const el = React.createElement(
    AppRouterContext.Provider, { value: stubRouter },
    React.createElement(PathnameContext.Provider, { value: "/" },
      React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams() },
        React.createElement(PathParamsContext.Provider, { value: {} },
          React.createElement(Comp, props)))))
  return renderToStaticMarkup(el)
}
function textOf(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ")
    .split("\n").map((l) => l.trim()).filter(Boolean).join("\n")
}
// SELF_HIDING — the component returned null/nothing on empty input (html === ""):
// a widget that hides itself inside a parent surface, which is a design choice
// the parent answers for. BLANK — markup came back but carries no readable text:
// an empty shell (a bare grid, a table with no rows, an icon-only card), which
// is the defect a first-day tenant sees as "broken".
// LOADING — the component fetches after mount and its pre-fetch branch is a
// spinner or skeleton: SSR shows what a slow network shows. Published, not failed.
type Verdict = "PASS" | "NO_SENTENCE" | "BLANK" | "SELF_HIDING" | "LOADING" | "UNMOUNTABLE"
const LOADING_MARKUP = /animate-spin|animate-pulse|data-slot="skeleton"|\bLoading\b|Loader2|lucide-loader/
function classify(html: string, text: string): Exclude<Verdict, "UNMOUNTABLE"> {
  if (html.trim() === "") return "SELF_HIDING"
  const letters = text.replace(/[^A-Za-z]/g, "")
  if (letters.length < 5) return LOADING_MARKUP.test(html) ? "LOADING" : "BLANK"
  return EMPTY_SENTENCE.test(text) ? "PASS" : "NO_SENTENCE"
}
async function renderFile(abs: string, exportName: string, props: Record<string, unknown>): Promise<{ verdict: Verdict; text: string; html: string; reason?: string }> {
  const origError = console.error, origWarn = console.warn
  console.error = () => {}; console.warn = () => {}
  try {
    const mod = await import(abs)
    const Comp = mod[exportName]
    if (typeof Comp !== "function") return { verdict: "UNMOUNTABLE", text: "", html: "", reason: `export ${exportName} is not a component` }
    const html = mount(Comp, props)
    const text = textOf(html)
    return { verdict: classify(html, text), text, html }
  } catch (e: any) {
    return { verdict: "UNMOUNTABLE", text: "", html: "", reason: String(e?.message ?? e).split("\n")[0].slice(0, 160) }
  } finally { console.error = origError; console.warn = origWarn }
}
/** P2 helper: does this stripped source map over an identifier that was READ
 *  (awaited call, `.data`, or a `data:` destructure)? `features.map(` over a
 *  static marketing array is not a list surface. */
function mapsOverReadData(s: string): boolean {
  for (const m of s.matchAll(/\b([A-Za-z_$][\w$]*)\.map\(/g)) {
    const id = m[1]
    if (["Object", "Array", "Promise", "React"].includes(id)) continue
    const fetched = new RegExp(`(?:const|let)\\s+(?:\\{[^}]*\\b${id}\\b[^}]*\\}|${id})\\s*=\\s*\\(?\\s*await\\b|data:\\s*${id}\\b|\\b${id}\\s*=\\s*[^=\\n]*\\.data\\b|\\b${id}\\s*=\\s*[^=\\n]*\\?\\?\\s*\\[\\]`)
    if (fetched.test(s)) return true
  }
  return false
}

async function main() {
  console.log("══════════════════════════════════════════════════════════════")
  console.log(" Rendered empty-state guard — every list surface says so when empty")
  console.log("══════════════════════════════════════════════════════════════")
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as { no_sentence: number; self_hiding: number; list_without_empty_state: number }

  // ── P0 positive controls ───────────────────────────────────────────────────
  console.log("\n P0 — positive controls (the classifier and the harness see what they are for)")
  const BlankList = ({ items }: { items: string[] }) => (items.length ? React.createElement("ul", null, items.map((i) => React.createElement("li", { key: i }, i))) : null)
  const GoodList = ({ items }: { items: string[] }) => React.createElement("div", null, React.createElement("h2", null, "Items"), items.length === 0 ? React.createElement("p", null, "No items yet — add your first one.") : null)
  const HeadingOnly = ({ items }: { items: string[] }) => React.createElement("div", null, React.createElement("h2", null, "Transactions overview"), React.createElement("span", null, `${items.length} rows`))
  const RouterUser = () => { const r = req("next/navigation"); r.useRouter(); r.useSearchParams(); r.usePathname(); return React.createElement("p", null, "No showings yet.") }
  const Thrower = () => { throw new Error("boom") }
  const ShellList = ({ items }: { items: string[] }) => React.createElement("div", { className: "grid" }, React.createElement("table", null, React.createElement("tbody", null, items.map((i) => React.createElement("tr", { key: i })))))
  const cls = (C: React.ComponentType<any>, p: Record<string, unknown>) => { const h = mount(C, p); return classify(h, textOf(h)) }
  check("P0 a list returning null on [] reads SELF_HIDING (widget hides itself)", cls(BlankList, { items: [] }) === "SELF_HIDING")
  check("P0 a list rendering an empty shell (grid + rowless table) on [] reads BLANK", cls(ShellList, { items: [] }) === "BLANK")
  check("P0 a list saying 'No items yet' reads PASS", cls(GoodList, { items: [] }) === "PASS")
  check("P0 a heading-only list reads NO_SENTENCE", cls(HeadingOnly, { items: [] }) === "NO_SENTENCE")
  const Spinner = () => React.createElement("div", { className: "animate-spin h-8 w-8" })
  const ShortEmpty = ({ items }: { items: string[] }) => React.createElement("p", null, items.length ? "x" : "No calls")
  check("P0 a spinner-only pre-fetch branch reads LOADING, not BLANK", cls(Spinner, {}) === "LOADING")
  check("P0 a short empty sentence ('No calls') is text, not BLANK", cls(ShortEmpty, { items: [] }) === "PASS")
  check("P0 P2 vocabulary: a section hidden by `length > 0 &&` counts as handled", EMPTY_SOURCE.test(blankComments(`{listings.length > 0 && (<section/>)}`)))
  check("P0 P2 helper: `features.map(` over a static array is NOT a data list", !mapsOverReadData(blankComments(`const features = [{a:1}]\nexport default function P(){ return <ul>{features.map(f => <li key={f.a}/>)}</ul> }`)))
  check("P0 P2 helper: `rows.map(` where rows came from an awaited action IS a data list", mapsOverReadData(blankComments(`const rows = await listThings()\nreturn <ul>{rows.map(r => <li key={r.id}/>)}</ul>`)))
  check("P0 'no credit card required' is NOT an empty sentence", !EMPTY_SENTENCE.test("Start a 14-day free trial below\nno credit card required."))
  check("P0 JSX text 'No transactions found' IS an empty sentence", EMPTY_SENTENCE.test("Transactions\nNo transactions found"))
  check("P0 a useRouter/useSearchParams/usePathname component MOUNTS under the harness", (() => { try { return cls(RouterUser, {}) === "PASS" } catch { return false } })())
  check("P0 a throwing component is UNMOUNTABLE, never PASS", (() => { try { mount(Thrower, {}); return false } catch { return true } })())
  check("P0 prop parser: inline type with an array prop", (() => { const s = componentSignature(`"use client"\nexport function X({ rows, title }: { rows: Row[]; title: string }) { return null }`); return !!s && s.props.length === 2 && isArrayType(s.props[0].type) && !isArrayType(s.props[1].type) })())
  check("P0 prop parser: named interface with an optional nullable array", (() => { const s = componentSignature(`interface Props {\n  items?: Item[] | null\n  onPick: (id: string) => void\n}\nexport default function Y({ items, onPick }: Props) { return null }`); return !!s && s.exportName === "default" && s.props.some((p) => p.name === "items" && isArrayType(p.type)) })())
  check("P0 prop parser: arrow export const", (() => { const s = componentSignature(`export const Z = ({ list }: { list: Array<Thing> }) => null`); return !!s && s.exportName === "Z" && s.props.length === 1 && isArrayType(s.props[0].type) })())

  // ── P1 rendered empty states ───────────────────────────────────────────────
  console.log("\n P1 — every client component with an array prop, mounted with []")
  const appFiles = walk(path.join(ROOT, "app")).filter((f) => f.endsWith(".tsx") && !/\/app\/components\/ui\//.test(f) && !/\/app\/api\//.test(f) && !/\.(test|spec|stories)\.tsx$/.test(f))
  const candidates: Array<{ abs: string; exportName: string; props: PropSpec[] }> = []
  let clientFiles = 0, noSignature = 0, noArrayProp = 0
  for (const abs of appFiles) {
    const s = stripped(abs)
    if (!isClient(s)) continue
    clientFiles++
    const sig = componentSignature(s)
    if (!sig) { noSignature++; continue }
    if (!sig.props.some((p) => isArrayType(p.type))) { noArrayProp++; continue }
    candidates.push({ abs, ...sig })
  }
  const results: Record<Verdict, string[]> = { PASS: [], NO_SENTENCE: [], BLANK: [], SELF_HIDING: [], LOADING: [], UNMOUNTABLE: [] }
  const reasons = new Map<string, number>()
  for (const c of candidates) {
    const props: Record<string, unknown> = {}
    // An OPTIONAL string keeps its default (`emptyMessage = "No pending…"` is
    // the component's own sentence); a required one carries its name.
    for (const p of c.props) props[p.name] = p.optional && /^string\b/.test(p.type.trim()) ? undefined : placeholderFor(p.type, p.name)
    const r = await renderFile(c.abs, c.exportName, props)
    results[r.verdict].push(rel(c.abs))
    if (r.verdict === "UNMOUNTABLE") { const k = (r.reason ?? "?").replace(/['"`][^'"`]*['"`]/g, "…").slice(0, 60); reasons.set(k, (reasons.get(k) ?? 0) + 1) }
    if (r.verdict === "BLANK") console.log(`    BLANK        ${rel(c.abs)}  (${c.exportName}) html=${r.html.length}b «${r.html.replace(/\s+/g, " ").slice(0, 110)}»`)
  }
  console.log(`  · denominator: ${clientFiles} "use client" files under app/ (ui primitives + api excluded); ${noSignature} with no parseable exported signature, ${noArrayProp} with no array prop → ${candidates.length} mounted`)
  console.log(`  · PASS ${results.PASS.length} · NO_SENTENCE ${results.NO_SENTENCE.length} · SELF_HIDING ${results.SELF_HIDING.length} · LOADING ${results.LOADING.length} · BLANK ${results.BLANK.length} · UNMOUNTABLE ${results.UNMOUNTABLE.length}`)
  for (const f of results.LOADING) console.log(`    LOADING      ${f}`)
  const topReasons = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
  for (const [k, n] of topReasons) console.log(`    unmountable ×${n}: ${k}`)
  for (const f of results.SELF_HIDING) console.log(`    SELF_HIDING  ${f}`)
  for (const f of results.NO_SENTENCE) console.log(`    NO_SENTENCE  ${f}`)
  const mounted = results.PASS.length + results.NO_SENTENCE.length + results.BLANK.length + results.SELF_HIDING.length + results.LOADING.length
  check("P1 at least 40 list components actually mounted (the harness is not blind)", mounted >= 40, `${mounted}`)
  check("P1 no list component renders an empty SHELL on empty input", results.BLANK.length === 0, results.BLANK.join(", "))
  check(`P1 NO_SENTENCE ratchet ≤ ${baseline.no_sentence}`, results.NO_SENTENCE.length <= baseline.no_sentence, `${results.NO_SENTENCE.length}`)
  check(`P1 SELF_HIDING ratchet ≤ ${baseline.self_hiding}`, results.SELF_HIDING.length <= baseline.self_hiding, `${results.SELF_HIDING.length}`)
  check("P1 UNMOUNTABLE is a minority of the population (blind spot bounded)", results.UNMOUNTABLE.length < candidates.length / 2, `${results.UNMOUNTABLE.length}/${candidates.length}`)

  // ── P2 static subtree census (server-rendered lists) ──────────────────────
  console.log("\n P2 — page subtree census: a page that maps over data must carry an empty state somewhere in its tree")
  const pages = appFiles.filter((f) => /\/page\.tsx$/.test(f))
  const flagged: string[] = []
  for (const page of pages) {
    const seen = new Set<string>(); const q = [page]; let vocab = false, mapsData = false
    while (q.length) {
      const f = q.shift()!; if (seen.has(f)) continue; seen.add(f)
      const s = stripped(f)
      if (EMPTY_SOURCE.test(s)) vocab = true
      if (!/\/app\/components\/ui\//.test(f) && mapsOverReadData(s)) mapsData = true
      for (const m of s.matchAll(/from\s+["']([^"']+)["']/g)) {
        const r = resolveImport(f, m[1]); if (!r) continue
        const rr = rel(r)
        if (!/^(app|components)\//.test(rr) || /\/actions\//.test(rr) || /\/app\/api\//.test(rr)) continue
        q.push(r)
      }
    }
    if (mapsData && !vocab) flagged.push(rel(page))
  }
  for (const f of flagged) console.log(`    LIST_WITHOUT_EMPTY_STATE  ${f}`)
  console.log(`  · denominator: ${pages.length} pages; ${flagged.length} map over data with no empty vocabulary anywhere in their subtree`)
  check(`P2 LIST_WITHOUT_EMPTY_STATE ratchet ≤ ${baseline.list_without_empty_state}`, flagged.length <= baseline.list_without_empty_state, `${flagged.length}`)
  check("P2 the census still recognises the defect (a page mapping fetched data with no vocabulary is flagged)", (() => {
    const s = blankComments(`import { listThings } from "@/app/actions/things"\nexport default async function P(){ const rows = await listThings(); return <ul>{rows.map(r => <li key={r.id}>{r.name}</li>)}</ul> }`)
    return mapsOverReadData(s) && !EMPTY_SOURCE.test(s)
  })())

  console.log("\n──────────────────────────────────────────────────────────────")
  if (failures.length) { console.log(" Failures:"); for (const f of failures) console.log("  - " + f) }
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ❌ RENDERED_EMPTY_STATES_FAIL"); process.exit(1) }
  console.log(" ✅ RENDERED_EMPTY_STATES_PASS — every mounted list surface says so when it is empty; the server-side census did not grow")
}
main().catch((e) => { console.error(e); process.exit(1) })
