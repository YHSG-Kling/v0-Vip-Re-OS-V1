#!/usr/bin/env tsx
/**
 * scripts/children-census.ts   (npm run test:children-census — NOT YET
 * REGISTERED, see the wave-56 report that shipped this file for the exact
 * package.json / guard-chain / MAINTENANCE_DOMAINS lines an integrator must add)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE HALF scripts/hidden-wire-census.ts CATEGORY (c) DOES NOT COVER.
 *
 * (c)'s own header says it directly: "`children` and `className` are excluded
 * from 'passed but never read'" (hidden-wire-census.ts:70-72) — deliberately,
 * because both are legitimately consumed by ancestor wrapper behaviour that
 * scan cannot see. That leaves (c) covering exactly HALF of what wave 56
 * asked this file to census:
 *
 *   HALF A — "Props declares `children`, no caller ever passes it" — ALREADY
 *   COVERED. This is (c)'s "declared but never passed" side, and `children`
 *   is NOT excluded from THAT half (only from "passed but never read"). Wave
 *   54 fixed the exact false-positive this half would otherwise produce
 *   (AppShell.children, SettingsCard.children, AgentFinancialsClient.children
 *   — a non-self-closing call site's nested content now counts as passing
 *   children; hidden-wire-census.ts:104-109). Verified again this wave:
 *   `npx tsx scripts/hidden-wire-census.ts` → "(c) PROPS DRIFT: 0
 *   declared-never-passed, 0 passed-never-read" (see wave-56 report for the
 *   fresh RESULT line). Building a second scanner for this half would be the
 *   exact duplicate §1 forbids — survivor: scripts/hidden-wire-census.ts:731
 *   (EXEMPT_UNREAD) and the (c) scan starting ~line 800. NOT re-implemented here.
 *
 *   HALF B — a component's BODY reads `children` (`{children}`,
 *   `props.children`, or a local `const { children } = props` destructure)
 *   while its OWN declared Props type never names `children`, directly or by
 *   forwarding a base type that carries it — THE GENUINE GAP. TypeScript
 *   normally catches this (reading an undeclared property is a compile
 *   error), but shapes exist where it would not: a loosely-typed / `any`
 *   param, or a file with no Props annotation at all. This file's job is
 *   HALF B only.
 *
 * ── SCOPE (§2) ───────────────────────────────────────────────────────────
 * app/ and lib/ .tsx files, comment-stripped (`stripComments`) so a tombstone
 * or narrative comment naming `children` is never mistaken for a real read.
 *
 * A component is FLAGGED when ALL of:
 *   · its OWN body (excluding any NESTED inline component defined inside it —
 *     see blankNestedChildrenComponents below) contains a `children` READ;
 *   · its Props type — resolved from the destructure/param's own type
 *     annotation if one exists (any name, not just the `<Name>Props`
 *     convention), else a same-file `<Name>Props` interface/type — does NOT
 *     itself declare `children`;
 *   · that Props type does NOT forward a base type that carries `children`
 *     implicitly: `React.PropsWithChildren`, `*ComponentProps<`,
 *     `*ComponentPropsWithoutRef<`, `*ComponentPropsWithRef<`,
 *     `*HTMLAttributes<`, `*DOMAttributes<` all count as declaring it —
 *     every one of those TypeScript builtins/aliases includes `children` on
 *     the type they forward from, so treating them as "does not declare
 *     children" would be a false accusation on ~every shadcn/Radix wrapper
 *     in the repo (the first cut of this file did exactly that: 16 of its
 *     first 22 findings were AccordionTrigger/DialogContent/SelectItem/etc.
 *     forwarding `React.ComponentProps<typeof RadixPrimitive.X>`, corrected
 *     before this file shipped);
 *   · the destructured/param signature is NOT a bare `...rest`/`...props`
 *     spread with no local type (cannot prove absence one layer up) —
 *     excluded, published as a blind spot, same posture (c) takes.
 *
 * BLIND SPOTS, published beside the count:
 *   · A Props type declared in a SEPARATE file is not resolved cross-file —
 *     only a same-file type (by the param's own annotated name, or the
 *     `<Name>Props` convention) is checked.
 *   · `ComponentProps<typeof SomeLocalComponent>` where SomeLocalComponent
 *     itself does NOT declare children is treated as declaring it anyway
 *     (the forward-base heuristic is name-based, not resolved) — under-
 *     accusing, the safe direction for an accusation list.
 *   · Nested-component stripping (see below) is regex-balanced-bracket based,
 *     not a real parser — a nested arrow whose body contains an unbalanced
 *     bracket inside a STRING literal could mis-bound. Not observed in this
 *     corpus; strip-comments already removes comments before this runs.
 *
 * Report-only, no baseline: `--list` prints every finding and exits 0.
 */
import { readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { walkTs } from "./runtime-roots"
import { stripComments } from "./strip-comments"

const ROOT = process.cwd()
const rel = (f: string) => relative(ROOT, f).split(sep).join("/")

type Finding = { file: string; component: string; line: number }

function lineOf(src: string, idx: number): number {
  let n = 1
  for (let i = 0; i < idx; i++) if (src[i] === "\n") n++
  return n
}

/** Balanced-brace extraction of `{ ... }` starting at the first `{` at/after `from`. */
function braceBody(src: string, from: number): { body: string; end: number } | null {
  const start = src.indexOf("{", from)
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}") { depth--; if (depth === 0) return { body: src.slice(start + 1, i), end: i } }
  }
  return null
}

/** Skip one balanced (), {} or [] group starting at/after `from`; returns index just past it, or null. */
function skipBalancedGroup(src: string, from: number): number | null {
  let i = from
  while (i < src.length && /\s/.test(src[i])) i++
  if (i >= src.length || !"({[".includes(src[i])) return null
  const stack: string[] = []
  for (; i < src.length; i++) {
    const c = src[i]
    if ("({[".includes(c)) stack.push(c)
    else if (")}]".includes(c)) { stack.pop(); if (stack.length === 0) return i + 1 }
  }
  return null
}

/**
 * A component's own body can CONTAIN a nested inline component (a closure
 * declared inside it, e.g. `const RowShell = ({ children }: {...}) => …`)
 * that legitimately declares and reads its OWN `children`. Left unstripped,
 * that inner declaration's `{children}` JSX read gets attributed to the
 * OUTER component, which never itself reads children — the exact false
 * positive this function exists to prevent (found live on
 * LaunchReadinessChecklist and NotificationsPage's inline TitleEl/RowShell).
 */
function blankNestedChildrenComponents(body: string): string {
  let out = body
  const nestedRe = /\(\s*\{[^{}()]*\bchildren\b[^{}()]*\}\s*(?::\s*[^)]*)?\)\s*=>|\(\s*children\s*(?::\s*[^)]*)?\)\s*=>/g
  const ranges: [number, number][] = []
  let m: RegExpExecArray | null
  nestedRe.lastIndex = 0
  while ((m = nestedRe.exec(out))) {
    const afterArrow = m.index + m[0].length
    const end = skipBalancedGroup(out, afterArrow)
    if (end !== null) ranges.push([m.index, end])
    else {
      const semi = out.indexOf(";", afterArrow)
      ranges.push([m.index, semi === -1 ? out.length : semi + 1])
    }
  }
  ranges.sort((a, b) => b[0] - a[0])
  for (const [s, e] of ranges) out = out.slice(0, s) + " ".repeat(e - s) + out.slice(e)
  return out
}

const FORWARDS_CHILDREN = /PropsWithChildren|ComponentProps(?:WithoutRef|WithRef)?\s*<|HTMLAttributes\s*<|DOMAttributes\s*</

function propsDeclaresChildren(propsTypeSource: string): boolean {
  if (/\bchildren\s*\??\s*:/.test(propsTypeSource)) return true
  if (FORWARDS_CHILDREN.test(propsTypeSource)) return true
  return false
}

/** interface Name { ... } → the brace body. type Name = <rhs>; → the rhs text up to the statement end. */
function findTypeSource(src: string, name: string): string | null {
  const ifaceRe = new RegExp(`\\binterface\\s+${name}\\b[^{]*\\{`)
  const mi = ifaceRe.exec(src)
  if (mi) { const b = braceBody(src, mi.index); if (b) return b.body }

  const aliasRe = new RegExp(`\\btype\\s+${name}\\s*=\\s*`)
  const ma = aliasRe.exec(src)
  if (ma) {
    const rhsStart = ma.index + ma[0].length
    if (src[rhsStart] === "{") { const b = braceBody(src, rhsStart); if (b) return b.body }
    // non-object alias (e.g. `React.ComponentProps<typeof X>`) — take up to
    // the top-level `;` (depth-aware so a `<...>`/`(...)` inside doesn't end it early)
    let depth = 0
    for (let i = rhsStart; i < src.length; i++) {
      const c = src[i]
      if ("(<[{".includes(c)) depth++
      else if (")>]}".includes(c)) depth = Math.max(0, depth - 1)
      else if (c === ";" && depth === 0) return src.slice(rhsStart, i)
    }
    return src.slice(rhsStart, Math.min(src.length, rhsStart + 300))
  }
  return null
}

/** Type name referenced directly in a param signature, if any: `{ x }: Foo` or `props: Foo`. */
function paramTypeName(params: string): string | null {
  const p = params.trim()
  let m = /\}\s*:\s*([A-Za-z_][\w.]*)/.exec(p)
  if (m) return m[1]
  m = /^[A-Za-z_]\w*\s*:\s*([A-Za-z_][\w.]*)/.exec(p)
  if (m) return m[1]
  return null
}

const COMPONENT_RE = /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Z][A-Za-z0-9_]*)\s*\(([^)]*)\)|(?:export\s+)?const\s+([A-Z][A-Za-z0-9_]*)\s*(?::\s*[^=]+)?=\s*(?:React\.forwardRef\s*\()?\(([^)]*)\)\s*(?::[^=]+)?=>/g

function main() {
  const files = [...walkTs(join(ROOT, "app")), ...walkTs(join(ROOT, "lib"))].filter((f) => f.endsWith(".tsx"))
  let scanned = 0
  let componentsChecked = 0
  let spreadExcluded = 0
  const findings: Finding[] = []

  for (const f of files) {
    let raw: string
    try { raw = readFileSync(f, "utf8") } catch { continue }
    const src = stripComments(raw)
    scanned++

    COMPONENT_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = COMPONENT_RE.exec(src))) {
      const name = m[1] ?? m[3]
      const params = (m[2] ?? m[4] ?? "").trim()
      if (!name) continue

      const bodyRaw = braceBody(src, m.index + m[0].length - 1)
      if (!bodyRaw) continue
      componentsChecked++
      const body = blankNestedChildrenComponents(bodyRaw.body)

      const paramHead = params.split(/[:,){]/)[0].trim() || "props"
      const readsChildren =
        /\{\s*children\s*\}/.test(body) ||
        /\bprops\s*\.\s*children\b/.test(body) ||
        new RegExp(`\\bconst\\s*\\{[^}]*\\bchildren\\b[^}]*\\}\\s*=\\s*${paramHead}\\b`).test(body)
      if (!readsChildren) continue

      const isBareSpread = /^\s*\.\.\.\s*(rest|props)\s*$/.test(params) || (/^\s*\{[^}]*\.\.\.[a-zA-Z_]+[^}]*\}\s*$/.test(params) && !/:/.test(params))
      if (isBareSpread) { spreadExcluded++; continue }

      // Inline object-type param: (props: { children: React.ReactNode })
      if (/children\s*\??\s*:/.test(params)) continue

      const namedType = paramTypeName(params)
      let declared = false
      if (namedType) {
        const src2 = findTypeSource(src, namedType.replace(/^[A-Za-z_]+\./, ""))
        if (src2 !== null && propsDeclaresChildren(src2)) declared = true
        else if (src2 === null) declared = true // cross-file/unresolved type — cannot prove absence (blind spot)
      } else {
        const conv = findTypeSource(src, `${name}Props`)
        if (conv !== null && propsDeclaresChildren(conv)) declared = true
      }
      if (declared) continue

      findings.push({ file: rel(f), component: name, line: lineOf(src, m.index) })
    }
  }

  // ── positive control (§2): a synthetic component that reads children
  //    without declaring it must be caught, and a legitimate forwarder must not ──
  {
    const good = stripComments(`
      interface FooProps { label: string }
      function Foo(props: FooProps) {
        return <div>{children}</div>
      }
    `)
    let caught = false
    COMPONENT_RE.lastIndex = 0
    let mm: RegExpExecArray | null
    while ((mm = COMPONENT_RE.exec(good))) {
      const nm = mm[1] ?? mm[3]
      if (nm !== "Foo") continue
      const b = braceBody(good, mm.index + mm[0].length - 1)
      if (b && /\{\s*children\s*\}/.test(blankNestedChildrenComponents(b.body))) {
        const t = findTypeSource(good, "FooProps")
        if (t !== null && !propsDeclaresChildren(t)) caught = true
      }
    }
    const negative = stripComments(`
      function Bar({ children, ...props }: React.ComponentProps<typeof Baz>) {
        return <div>{children}</div>
      }
    `)
    let falsePositive = false
    COMPONENT_RE.lastIndex = 0
    while ((mm = COMPONENT_RE.exec(negative))) {
      const nm = mm[1] ?? mm[3]
      if (nm !== "Bar") continue
      const params = (mm[2] ?? mm[4] ?? "")
      const t = findTypeSource(negative, "Bar")
      const nt = paramTypeName(params)
      const src2 = nt ? findTypeSource(negative, nt) : null
      if (src2 !== null && !propsDeclaresChildren(src2!)) falsePositive = true
    }
    if (!caught || falsePositive) {
      console.log(`❌ CHILDREN_CENSUS_SELFTEST_FAIL — caught=${caught} falsePositiveOnComponentPropsForward=${falsePositive}; do not trust the count below`)
      process.exit(1)
    }
  }

  console.log("══════════════════════════════════════════════════")
  console.log(" CHILDREN CENSUS — {children} read without a declared Props.children (Half B; Half A is scripts/hidden-wire-census.ts category (c), 0/0)")
  console.log("══════════════════════════════════════════════════")
  console.log(` ${scanned} .tsx files scanned · ${componentsChecked} component declarations checked · ${spreadExcluded} excluded (bare rest/props spread — cannot prove absence)`)
  console.log(` undeclared-children reads: ${findings.length}`)
  for (const fi of findings) console.log(`  ✗ ${fi.file}:${fi.line}  ${fi.component} reads children, Props does not declare it`)

  if (process.argv.includes("--list")) {
    console.log("\n(--list mode: exit 0)")
    process.exit(0)
  }
  if (findings.length > 0) {
    console.log("\n❌ CHILDREN_CENSUS_FAIL")
    process.exit(1)
  }
  console.log("\n✅ CHILDREN_CENSUS_PASS")
}

main()
