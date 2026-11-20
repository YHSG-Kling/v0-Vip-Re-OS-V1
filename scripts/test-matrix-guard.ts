/**
 * scripts/test-matrix-guard.ts
 *
 * test:test-matrix — docs/operations/TEST-MATRIX.md stays in agreement with the
 * proofs it names, and never lets a simulated test read as a live-provider one.
 *
 * WHY THIS EXISTS. The wave-143 test matrix (lane 143K) says, per capability, which
 * proof exercises it, in which MODE, what was NOT performed and why. A matrix that
 * names a proof which does not exist, claims a CI chain a proof is not in, hides an
 * unperformed test behind a blank cell, or labels an in-memory run "live" is worse
 * than no matrix: it reads as coverage. This guard holds the document to the code.
 *
 * RULES (every one asserts a RULE and derives its numbers — CLAUDE.md §2: nothing
 * here pins a waypoint, so chaining a proof or landing a pending lane never turns
 * it red):
 *   R1  every `test:<key>` the matrix names (outside the Pending section) is a real
 *       package.json script, and the scripts/*.ts file it runs exists.
 *   R2  every `scripts/…ts` path the matrix names exists, or is listed in the Pending section
 *       (a pending lane proof is allowed to be absent; an invented one is not).
 *   R3  a run-record row whose "CI chain" cell says `guard` / `guard:compliance` is
 *       really a member of that chain (word-boundary `npm run <key>`). The reverse
 *       claim `none` is informational only: chaining the proof is the DESIRED end
 *       state, so it is reported as stale, never failed.
 *   R3b a run-record row whose "Via sweep" cell says `yes` is really reached by the CI
 *       simulator sweep (scripts/simulator-sweep.ts, a step of `guard`): the filter is READ
 *       from that file's own source, never restated here, so a narrowed sweep fails the row
 *       while a widened one only reports the `no` rows as stale (the desired end state).
 *   R4  the Tier 1 table covers every capability the lane brief lists, each row
 *       names a proof OR carries an explicit disposition (PENDING / NOT RUN /
 *       UNSUPPORTED), and its Mode uses the closed vocabulary — Tier 1 may only be
 *       STATIC and/or IN-MEMORY (or NONE, where nothing ran), never LIVE-TEST or LIVE.
 *   R5  every row of the Not-performed register carries all five fields — NAME,
 *       DEPENDENCY, TESTED INSTEAD, FUTURE VALIDATION, RISK — non-empty, not a
 *       placeholder, and RISK starts with LOW / MEDIUM / HIGH.
 *   R5b every Tier 2 / Tier 3 row that says NOT RUN is also a row of that register
 *       (matched by its first cell), so no unperformed test hides in a tier table.
 *   R6  every environment-variable NAME the matrix cites is real: it appears as a code
 *       token (comments stripped) in runtime / script / config code, or is documented in
 *       .env.example. Presence is printed by NAME ONLY; no value is ever read into output.
 *   R7  every proof the matrix lists as credential-gated really reads process.env
 *       and really has a skip path (soundness only — see BLIND SPOTS).
 *   R8  every Pending row names a wave LANE (wave number + lane letter: 143A–143J, 144A–144K …) and a scripts/ path.
 *       WAVE 144 (lane 144J): the rule was pinned to the wave-143 waypoint (`143[A-J]`), so the first wave-144 pending
 *       proof could only be recorded by breaking the guard. Re-asserted as the RULE — a lane id of the repo's own
 *       `<wave><letter>` form — with a positive control for both waves and a negative one for a lane-less row.
 *
 * POSITIVE CONTROLS. Each finder is first run on a fixture that contains exactly the
 * defect it exists to catch, and must report it (a clean tree and a broken regex both
 * report zero — the control proves which one this is). The comment-vs-code control
 * proves R6 reads STRIPPED source: an env name that appears only in a comment (e.g. a
 * tombstone) is not a read.
 *
 * BLIND SPOTS (published beside the number):
 *   · the PASS/FAIL results in the run record are point-in-time evidence; this guard
 *     does not re-run proofs and cannot tell a stale result from a current one.
 *   · R7 proves the listed proofs are credential-gated; it does NOT prove the list is
 *     complete (a heuristic census of all scripts matched 395 files, nearly all false
 *     positives). Completeness is measured by the run: a proof that exits 0 with a skip
 *     marker is SKIPPED, never PASS (see the Reproduce section).
 *   · R6 accepts a name that appears as ANY code token (`process.env.X`, `process.env["X"]`,
 *     or a string literal in a list such as lib/billing/stripe-account-scope.ts), so a name
 *     that is only mentioned in a user-facing message string would also pass.
 *   · R3 reads `npm run <key>` in package.json script strings only; a proof invoked by
 *     a workflow step or spawned by another proof is "none" here (e2e.yml runs
 *     test:e2e-flows and check-live-schema-drift directly; the doc names them).
 *   · Mode is the author's classification of what the proof's code reaches; the guard
 *     checks the vocabulary and the Tier 1 restriction, not the classification.
 */
import { existsSync, readFileSync } from "node:fs"
import { runtimeFiles, walkTs } from "./runtime-roots"
import { stripComments } from "./strip-comments"

const DOC = "docs/operations/TEST-MATRIX.md"
const read = (p: string) => { try { return readFileSync(p, "utf8") } catch { return "" } }

let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}

// ───────────────────────────── pure finders (also run on fixtures) ─────────────────────────────

type Section = Map<string, string>
/** Split a markdown document into `## Title` → body. */
function sections(md: string): Section {
  const out: Section = new Map()
  const parts = md.split(/^## +/m).slice(1)
  for (const p of parts) {
    const nl = p.indexOf("\n")
    const title = (nl === -1 ? p : p.slice(0, nl)).trim()
    out.set(title, nl === -1 ? "" : p.slice(nl + 1))
  }
  return out
}
/** Find a section whose title starts with the given prefix (case-insensitive). */
function section(secs: Section, prefix: string): string | null {
  for (const [t, b] of secs) if (t.toLowerCase().startsWith(prefix.toLowerCase())) return b
  return null
}
/** Table rows (header + separator dropped) as trimmed cell arrays. A cell never contains `|`. */
function tableRows(body: string): string[][] {
  const lines = body.split("\n").filter((l) => /^\s*\|/.test(l))
  const rows = lines.map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()))
  return rows.filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c))).slice(1)
}
const backticked = (text: string): string[] => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1])
const proofKeysIn = (text: string): string[] =>
  backticked(text).filter((t) => /^test:[a-z0-9][a-z0-9:_-]*$/.test(t))
const scriptPathsIn = (text: string): string[] =>
  backticked(text).filter((t) => /^scripts\/[A-Za-z0-9_./-]+\.ts$/.test(t))
const envNamesIn = (text: string): string[] =>
  backticked(text).filter((t) => /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(t))

const PLACEHOLDER = /^(?:|-|—|–|n\/?a|tbd|todo|\?|unknown|none|\.\.\.)$/i

function phantomKeys(text: string, scripts: Record<string, string>): string[] {
  return proofKeysIn(text).filter((k) => !(k in scripts))
}
function missingScriptFiles(keys: string[], scripts: Record<string, string>, exists: (p: string) => boolean): string[] {
  const bad: string[] = []
  for (const k of keys) {
    const f = (scripts[k] ?? "").match(/scripts\/[^\s]+\.ts/)?.[0]
    if (f && !exists(f)) bad.push(`${k} → ${f}`)
  }
  return bad
}
function inChain(key: string, chainScript: string): boolean {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?:^|\\s)npm run ${esc}(?=\\s|$)`).test(chainScript)
}
/** Run-record rows whose "CI chain" cell claims a chain the proof is not in. */
function falseChainClaims(rows: string[][], scripts: Record<string, string>): string[] {
  const bad: string[] = []
  for (const r of rows) {
    const key = proofKeysIn(r[0] ?? "")[0]
    if (!key) continue
    const claim = (r.find((c) => /^`?(?:guard|guard:compliance)`?$/.test(c)) ?? "").replace(/`/g, "")
    if (claim && !inChain(key, scripts[claim] ?? "")) bad.push(`${key} claims ${claim}`)
  }
  return bad
}
/** Not-performed register rows with a missing / placeholder field or a RISK that is not LOW|MEDIUM|HIGH. */
function incompleteNotRun(rows: string[][]): string[] {
  const bad: string[] = []
  for (const r of rows) {
    const label = r[0] || "(unnamed row)"
    if (r.length < 5) { bad.push(`${label}: ${r.length} of 5 fields`); continue }
    for (let i = 0; i < 5; i++) if (PLACEHOLDER.test((r[i] ?? "").replace(/[`*_]/g, "").trim())) bad.push(`${label}: field ${i + 1} is empty/placeholder`)
    if (!/^(?:LOW|MEDIUM|HIGH)\b/.test((r[4] ?? "").replace(/[`*_]/g, "").trim())) bad.push(`${label}: RISK must start with LOW, MEDIUM or HIGH`)
  }
  return bad
}
const MODE_WORDS = ["STATIC", "IN-MEMORY", "LIVE-TEST", "LIVE", "NONE"] as const
/** Mode cell → the vocabulary words it uses, or null when it uses anything else. */
function modeWords(cell: string): string[] | null {
  const parts = cell.replace(/[`*]/g, "").split("+").map((s) => s.trim()).filter(Boolean)
  if (!parts.length) return null
  if (!parts.every((p) => (MODE_WORDS as readonly string[]).includes(p))) return null
  return parts.includes("NONE") && parts.length > 1 ? null : parts // NONE = nothing ran; it cannot be combined
}
/** Tier 1 rows whose Mode is outside STATIC / IN-MEMORY (a simulated test must never read as live). */
function tier1ModeViolations(rows: string[][], modeCol = 1): string[] {
  const bad: string[] = []
  for (const r of rows) {
    const w = modeWords(r[modeCol] ?? "")
    if (!w) bad.push(`${r[0]}: Mode "${r[modeCol] ?? ""}" is outside the vocabulary`)
    else if (w.some((x) => x === "LIVE" || x === "LIVE-TEST")) bad.push(`${r[0]}: Tier 1 row declares ${w.join("+")}`)
  }
  return bad
}
/** The sweep's own target filter, READ from scripts/simulator-sweep.ts (`/…/.test(pkg.scripts[s] …)`); null when it cannot be found. */
function sweepFilterFrom(sweepSrc: string): RegExp | null {
  const m = /(\/tsx[^\n]*?\/)\.test\(pkg\.scripts\[s\]/.exec(sweepSrc)
  if (!m) return null
  try { return new RegExp(m[1].slice(1, -1)) } catch { return null }
}
/** Rows that say `yes` (reached by the sweep) for a proof whose command the sweep filter does not match; and `no` rows it now matches. */
function sweepClaims(rows: string[][], scripts: Record<string, string>, re: RegExp): { falseYes: string[]; staleNo: string[] } {
  const falseYes: string[] = [], staleNo: string[] = []
  for (const r of rows) {
    const key = proofKeysIn(r[0] ?? "")[0]
    const claim = r.find((c) => /^(?:yes|no)$/.test(c))
    if (!key || !claim) continue
    const matches = re.test(scripts[key] ?? "")
    if (claim === "yes" && !matches) falseYes.push(key)
    if (claim === "no" && matches) staleNo.push(key)
  }
  return { falseYes, staleNo }
}
/** Capabilities the lane brief requires Tier 1 to cover (matched against the row's first cell). */
const REQUIRED_DOMAINS: Array<[string, RegExp]> = [
  ["TypeScript", /typescript/i], ["schema / migration", /schema/i], ["RLS / tenant isolation", /rls|tenant isolation/i],
  ["platform roles", /platform roles/i], ["commission waterfall / referral / residual / revenue share / agreements", /commission/i],
  ["subscriber / seat convergence", /subscriber/i], ["Stripe event idempotency", /stripe/i], ["listing intake", /listing intake/i],
  ["outside offer / counter", /outside offer/i], ["email matching", /email matching/i], ["compliance matrices", /compliance matri/i],
  ["state roles", /state roles/i], ["contract precedence", /contract precedence/i], ["closing compliance", /closing compliance/i],
  ["CDA / HUD corrections", /cda/i], ["FormWizard / PDF persistence", /formwizard/i], ["e-sign event simulation", /e-sign/i],
  ["scanner / identity", /scanner/i], ["enrichment triggering", /enrichment/i], ["marketing assets", /marketing assets/i],
  ["lead-magnet / book export", /lead.magnet/i], ["Remotion local render", /remotion/i], ["support / AI routing", /support/i],
  ["UI / mobile", /ui .*mobile|mobile/i], ["self-healing", /self-healing/i],
]
const DISPOSITION = /\b(?:PENDING 143[A-J]|NOT RUN|UNSUPPORTED)\b/
/** Required capabilities with no row, or a row with neither a registered proof nor a disposition. */
function uncoveredDomains(rows: string[][], keyExists: (k: string) => boolean): string[] {
  const bad: string[] = []
  for (const [name, re] of REQUIRED_DOMAINS) {
    const row = rows.find((r) => re.test(r[0] ?? ""))
    if (!row) { bad.push(`${name}: no row`); continue }
    const text = row.join(" | ")
    const hasProof = proofKeysIn(text).some(keyExists)
    if (!hasProof && !DISPOSITION.test(text)) bad.push(`${name}: neither a registered proof nor a disposition`)
  }
  return bad
}
/** scripts/ paths that neither exist nor appear in the Pending section (an invented proof). */
function inventedPaths(paths: string[], exists: (p: string) => boolean, pending: Set<string>): string[] {
  return paths.filter((p) => !exists(p) && !pending.has(p))
}
const normName = (s: string) => s.replace(/[`*_]/g, "").replace(/\s+/g, " ").trim().toLowerCase()
/** Tier rows that say NOT RUN but whose first cell is not the first cell of any register row. */
function unregisteredNotRun(tierRows: string[][], registerRows: string[][]): string[] {
  const names = new Set(registerRows.map((r) => normName(r[0] ?? "")))
  return tierRows.filter((r) => /\bNOT RUN\b/.test(r.join(" ")) && !names.has(normName(r[0] ?? ""))).map((r) => r[0] || "(unnamed row)")
}
/** A lane id in the repo's own form: the wave number (140 and up) + the lane letter ("143A", "144J"). */
const LANE_ID = /\b1(?:4\d|[5-9]\d)[A-K]\b/
/** Pending rows without a wave lane or without a scripts/ path. */
function badPendingRows(rows: string[][]): string[] {
  const bad: string[] = []
  for (const r of rows) {
    const label = r[0] || "(unnamed row)"
    if (!LANE_ID.test(r[0] ?? "")) bad.push(`${label}: first cell must name a wave lane (e.g. 143A, 144J)`)
    if (!scriptPathsIn(r.join(" ")).length) bad.push(`${label}: no scripts/ path`)
  }
  return bad
}
/** Which of `wanted` appear as a whole-word CODE token in STRIPPED source (a comment, e.g. a tombstone, is not a read). */
function envNamesInCode(strippedSrc: string, wanted: Iterable<string>): Set<string> {
  const out = new Set<string>()
  for (const n of wanted) if (new RegExp(`(?<![A-Za-z0-9_])${n}(?![A-Za-z0-9_])`).test(strippedSrc)) out.add(n)
  return out
}
/** Credential-gated = reads process.env AND has a skip/return path announced by a console line. */
function isCredentialGated(strippedSrc: string): boolean {
  const reads = /process\.env\.[A-Z]|process\.env\[/.test(strippedSrc)
  const skip = /console\.(?:log|warn|info)\([^\n]*?(?:skipp?(?:ed|ing)?\b|SKIP|⊘|⏭)/i.test(strippedSrc)
  return reads && skip
}

// ───────────────────────────── positive controls ─────────────────────────────

console.log("\n[0 · positive controls — each finder must see the defect it exists to catch]")
{
  const fakeScripts: Record<string, string> = {
    "test:alpha": "tsx scripts/alpha.ts", "test:beta": "tsx scripts/beta.ts", "test:e2e": "playwright test", "test:e2e:ui": "playwright test --ui",
    guard: "npm run test:alpha && npm run test:e2e:ui && npm run test:zeta", "guard:compliance": "npm run test:beta",
  }
  const exists = (p: string) => p === "scripts/alpha.ts"
  ok("control · a phantom proof key is caught (and a real one is not)",
    JSON.stringify(phantomKeys("see `test:alpha` and `test:phantom-143k`", fakeScripts)) === JSON.stringify(["test:phantom-143k"]))
  ok("control · a proof whose scripts/ file is missing is caught",
    missingScriptFiles(["test:alpha", "test:beta"], fakeScripts, exists).join() === "test:beta → scripts/beta.ts")
  ok("control · chain membership is word-boundary: test:e2e is NOT in a chain that only has test:e2e:ui",
    inChain("test:e2e:ui", fakeScripts.guard) && !inChain("test:e2e", fakeScripts.guard) && inChain("test:zeta", fakeScripts.guard) && !inChain("test:alph", fakeScripts.guard))
  ok("control · a false `guard` claim is caught, a true one and a `none` are not",
    JSON.stringify(falseChainClaims([["`test:alpha`", "guard"], ["`test:beta`", "guard"], ["`test:e2e`", "none"], ["`test:beta`", "guard:compliance"]], fakeScripts)) === JSON.stringify(["test:beta claims guard"]))
  const sweepFixture = 'const targets = Object.keys(pkg.scripts)\n  .filter((s) => /tsx\\s+scripts\\/[\\w.-]+\\.ts/.test(pkg.scripts[s] ?? ""))'
  const narrow = sweepFilterFrom(sweepFixture)
  const wide = sweepFilterFrom('x.filter((s) => /tsx\\s+(?:--[\\w=.-]+\\s+)*scripts\\/[\\w.-]+\\.ts/.test(pkg.scripts[s] ?? ""))')
  const cmdPlain = "tsx scripts/a.ts", cmdFlag = "tsx --conditions=react-server scripts/b.ts"
  ok("control · the sweep filter is READ from source: a plain command matches, a flagged one does not; a widened filter matches both; unreadable source yields null",
    !!narrow && narrow.test(cmdPlain) && !narrow.test(cmdFlag) && !!wide && wide.test(cmdPlain) && wide.test(cmdFlag) && sweepFilterFrom("nothing here") === null)
  const sc = sweepClaims([["`test:p`", "yes"], ["`test:f`", "yes"], ["`test:f`", "no"], ["`test:p`", "no"]], { "test:p": cmdPlain, "test:f": cmdFlag }, narrow!)
  ok("control · a false `yes` (the sweep cannot reach it) is a failure; a `no` the filter now matches is only stale; true claims pass",
    JSON.stringify(sc.falseYes) === JSON.stringify(["test:f"]) && JSON.stringify(sc.staleNo) === JSON.stringify(["test:p"]))
  ok("control · a Not-performed row with an empty field, a placeholder, a short row or a bad RISK is caught; a full row is not",
    incompleteNotRun([["a", "dep", "instead", "future", "HIGH — reason"]]).length === 0 &&
    incompleteNotRun([["a", "", "instead", "future", "LOW"]]).length === 1 &&
    incompleteNotRun([["a", "dep", "TBD", "future", "LOW"]]).length === 1 &&
    incompleteNotRun([["a", "dep", "instead", "future"]]).length === 1 &&
    incompleteNotRun([["a", "dep", "instead", "future", "probably fine"]]).length === 1)
  ok("control · a NOT RUN tier row that is missing from the register is caught; a registered one and a RAN one are not",
    JSON.stringify(unregisteredNotRun([["NR-01 a", "NOT RUN"], ["NR-02 b", "NOT RUN"], ["NR-03 c", "RAN"]], [["`NR-01 a`", "x", "y", "z", "LOW"]])) === JSON.stringify(["NR-02 b"]))
  ok("control · a simulated test declared LIVE / LIVE-TEST, or a mode outside the vocabulary, is caught in Tier 1",
    tier1ModeViolations([["x", "STATIC + IN-MEMORY"], ["y", "IN-MEMORY"]]).length === 0 &&
    tier1ModeViolations([["x", "LIVE"]]).length === 1 && tier1ModeViolations([["x", "IN-MEMORY + LIVE-TEST"]]).length === 1 &&
    tier1ModeViolations([["x", "simulated"]]).length === 1 && tier1ModeViolations([["x", ""]]).length === 1 &&
    tier1ModeViolations([["x", "NONE"]]).length === 0 && tier1ModeViolations([["x", "NONE + IN-MEMORY"]]).length === 1)
  ok("control · a missing capability row, and a row with no proof and no disposition, are caught",
    uncoveredDomains([["TypeScript scoped", "STATIC", "`test:alpha`"]], (k) => k === "test:alpha").length === REQUIRED_DOMAINS.length - 1 &&
    uncoveredDomains([["TypeScript scoped", "STATIC", "nothing"]], () => true)[0]?.startsWith("TypeScript"))
  ok("control · a scripts/ path that is absent AND unlisted is caught; an absent-but-pending one and a present one are not",
    JSON.stringify(inventedPaths(["scripts/a.ts", "scripts/b.ts", "scripts/c.ts"], (p) => p === "scripts/a.ts", new Set(["scripts/b.ts"]))) === JSON.stringify(["scripts/c.ts"]))
  ok("control · a Pending row without a lane or without a scripts/ path is caught",
    badPendingRows([["143A", "`scripts/outside-offer-loop-guard.ts`"]]).length === 0 &&
    badPendingRows([["144J", "`scripts/wave144-canaries.ts`"]]).length === 0 &&
    badPendingRows([["offers", "`scripts/x.ts`"]]).length === 1 && badPendingRows([["143B", "no path"]]).length === 1 &&
    badPendingRows([["1430A", "`scripts/x.ts`"]]).length === 1)
  const withComment = "// process.env.ONLY_IN_A_COMMENT_143K\nconst k = process.env.REAL_READ_143K\nconst j = process.env[\"BRACKET_READ_143K\"]"
  const names = envNamesInCode(stripComments(withComment + '\nconst L = ["LISTED_NAME_143K"]'), ["ONLY_IN_A_COMMENT_143K", "REAL_READ_143K", "BRACKET_READ_143K", "LISTED_NAME_143K", "REAL_READ"])
  ok("control · an env name that appears only in a comment is NOT a code token; dotted, bracketed and listed names are; a longer name does not match a shorter one",
    !names.has("ONLY_IN_A_COMMENT_143K") && names.has("REAL_READ_143K") && names.has("BRACKET_READ_143K") && names.has("LISTED_NAME_143K") && !names.has("REAL_READ"))
  ok("control · the credential-gate finder sees an env read + a console skip line, and ignores a file with only one of them",
    isCredentialGated('if (!process.env.SOME_KEY) { console.log("○ skipped (no credentials)"); process.exit(0) }') &&
    !isCredentialGated('console.log("skipped a row")') && !isCredentialGated("const k = process.env.SOME_KEY"))
  ok("control · section / table parsing sees the rows of a fixture and drops header + separator",
    JSON.stringify(tableRows("| h1 | h2 |\n|---|---|\n| a | b |\n| c | d |")) === JSON.stringify([["a", "b"], ["c", "d"]]) &&
    section(sections("# T\n## Tier 1 — x\nbody"), "tier 1") === "body")
}

// ───────────────────────────── the real document ─────────────────────────────

console.log(`\n[1 · ${DOC}]`)
const md = read(DOC)
ok("the matrix exists and is not empty", md.length > 2000, `${md.length} bytes`)
const secs = sections(md)
const REQUIRED_SECTIONS = ["Evidence rules", "Credential census", "Tier 1 —", "Tier 1 run record", "Tier 2 —", "Tier 3 —", "Not-performed register", "Pending proofs", "Credential-gated proofs", "Blind spots", "Reproduce"]
for (const s of REQUIRED_SECTIONS) ok(`section present: "${s}…"`, section(secs, s) !== null)

const scripts: Record<string, string> = (() => { try { return JSON.parse(read("package.json")).scripts ?? {} } catch { return {} } })()
ok("package.json scripts are readable", Object.keys(scripts).length > 100, `${Object.keys(scripts).length} scripts`)

const pendingBody = section(secs, "Pending proofs") ?? ""
const outsidePending = [...secs].filter(([t]) => !t.toLowerCase().startsWith("pending proofs") && !t.toLowerCase().startsWith("evidence rules") && !t.toLowerCase().startsWith("reproduce")).map(([, b]) => b).join("\n")

console.log("\n[2 · R1/R2 — every proof and script the matrix names is real]")
{
  const keys = [...new Set(proofKeysIn(outsidePending))]
  const phantoms = phantomKeys(keys.map((k) => `\`${k}\``).join(" "), scripts)
  ok(`R1 · all ${keys.length} named proof keys are package.json scripts`, phantoms.length === 0, phantoms.join(", "))
  const noFile = missingScriptFiles(keys, scripts, existsSync)
  ok("R1 · every named proof's scripts/*.ts file exists", noFile.length === 0, noFile.join("; "))
  const paths = [...new Set(scriptPathsIn(outsidePending))]
  const pendingPaths = new Set(scriptPathsIn(pendingBody))
  const gone = inventedPaths(paths, existsSync, pendingPaths)
  ok(`R2 · all ${paths.length} named scripts/ paths exist or are listed as pending lane proofs`, gone.length === 0, gone.join(", "))
}

console.log("\n[3 · R3 — the CI-chain column]")
{
  const rows = tableRows(section(secs, "Tier 1 run record") ?? "")
  ok(`the run record has rows (${rows.length})`, rows.length > 0)
  const bad = falseChainClaims(rows, scripts)
  ok("R3 · no run-record row claims a chain its proof is not in", bad.length === 0, bad.join("; "))
  const stale = rows.filter((r) => /^`?none`?$/.test(r.find((c) => /^`?(?:guard|guard:compliance|none)`?$/.test(c)) ?? "")).map((r) => proofKeysIn(r[0] ?? "")[0]).filter((k) => k && (inChain(k, scripts["guard"] ?? "") || inChain(k, scripts["guard:compliance"] ?? "")))
  console.log(`  · informational: ${stale.length} row(s) say "none" but are now chained${stale.length ? ` (refresh the doc): ${stale.slice(0, 8).join(", ")}` : ""}`)
}

console.log("\n[3b · R3b — the Via-sweep column]")
{
  const sweepRe = sweepFilterFrom(read("scripts/simulator-sweep.ts"))
  ok("the CI sweep's target filter is readable from scripts/simulator-sweep.ts", sweepRe !== null)
  if (sweepRe) {
    const rows = tableRows(section(secs, "Tier 1 run record") ?? "")
    const { falseYes, staleNo } = sweepClaims(rows, scripts, sweepRe)
    ok("R3b · no run-record row claims a sweep the filter cannot reach", falseYes.length === 0, falseYes.join(", "))
    console.log(`  · informational: ${staleNo.length} row(s) say "no" but the sweep filter now matches them${staleNo.length ? ` (refresh the doc): ${staleNo.join(", ")}` : ""}`)
  }
}

console.log("\n[4 · R4 — Tier 1 covers every capability the brief lists, in a closed Mode vocabulary]")
{
  const rows = tableRows(section(secs, "Tier 1 —") ?? "")
  const keyExists = (k: string) => k in scripts
  const unc = uncoveredDomains(rows, keyExists)
  ok(`R4 · all ${REQUIRED_DOMAINS.length} required capabilities have a proof or a stated disposition`, unc.length === 0, unc.join("; "))
  const modeBad = tier1ModeViolations(rows)
  ok("R4 · every Tier 1 Mode is STATIC / IN-MEMORY (never LIVE-TEST / LIVE) — a simulated test is never a live-provider success", modeBad.length === 0, modeBad.join("; "))
}

console.log("\n[5 · R5 — the Not-performed register is complete]")
{
  const rows = tableRows(section(secs, "Not-performed register") ?? "")
  ok(`the register has rows (${rows.length})`, rows.length > 0)
  const bad = incompleteNotRun(rows)
  ok("R5 · every row has NAME, DEPENDENCY, TESTED INSTEAD, FUTURE VALIDATION and a LOW/MEDIUM/HIGH RISK", bad.length === 0, bad.slice(0, 6).join("; "))
  // R5b — a Tier 2 / Tier 3 test the matrix says was NOT RUN must be in the register (no unperformed test hides in a tier table).
  const tierRows = [...tableRows(section(secs, "Tier 2 —") ?? ""), ...tableRows(section(secs, "Tier 3 —") ?? "")]
  const hidden = unregisteredNotRun(tierRows, rows)
  ok(`R5b · all ${tierRows.length} Tier 2 / Tier 3 rows are in the register (none unperformed-and-unlisted)`, tierRows.length > 0 && hidden.length === 0, hidden.join("; "))
  const tier2 = tableRows(section(secs, "Tier 2 —") ?? "")
  const claimsRun = tier2.filter((r) => /\bRAN\b|\bPASS(?:ED)?\b/.test(r.join(" ")) && !/\bNOT RUN\b/.test(r.join(" ")))
  console.log(`  · informational: ${claimsRun.length} Tier 2 row(s) claim a run (each must quote the credential NAMES present and the command, in the lane notes)`)
}

console.log("\n[6 · R6 — every environment name cited is real (presence by NAME only)]")
{
  const cited = [...new Set(["Credential census", "Tier 2 —", "Tier 3 —", "Not-performed register", "Credential-gated proofs"].flatMap((s) => envNamesIn(section(secs, s) ?? "")))]
  ok(`${cited.length} environment names are cited`, cited.length > 0)
  const example = read(".env.example")
  const declared = new Set([...example.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]))
  // Runtime code, the scripts/ and e2e/ harnesses and the root playwright config: a name is real when
  // any of them READS it (stripped source), or when .env.example documents it.
  const sources = [...new Set([...runtimeFiles("."), ...walkTs("scripts"), ...walkTs("e2e"), "playwright.config.ts"])]
  // Cheap pre-filter on raw text; strip only the files that mention a not-yet-documented cited name at all.
  const read_ = new Set<string>()
  const wanted = new Set(cited.filter((n) => !declared.has(n)))
  if (wanted.size) {
    for (const f of sources) {
      if (f.endsWith("test-matrix-guard.ts")) continue // this file names the controls' fixtures, never a real read
      const raw = read(f)
      const candidates = [...wanted].filter((n) => !read_.has(n) && raw.includes(n))
      if (!candidates.length) continue
      for (const n of envNamesInCode(stripComments(raw), candidates)) read_.add(n)
    }
  }
  const unreal = cited.filter((n) => !declared.has(n) && !read_.has(n))
  ok("R6 · every cited name is documented in .env.example or read by non-comment code", unreal.length === 0, unreal.join(", "))
  const present = cited.filter((n) => Object.prototype.hasOwnProperty.call(process.env, n) && (process.env[n] ?? "") !== "")
  console.log(`  · presence (names only, values never read into output): ${present.length} of ${cited.length} cited names are set in THIS environment`)
  if (present.length) console.log(`    set: ${present.join(", ")}`)
}

console.log("\n[7 · R7 — the listed credential-gated proofs really are]")
{
  const rows = tableRows(section(secs, "Credential-gated proofs") ?? "")
  ok(`the credential-gated list has rows (${rows.length})`, rows.length > 0)
  const notGated: string[] = []
  for (const r of rows) {
    const key = proofKeysIn(r[0] ?? "")[0]
    const f = key ? (scripts[key] ?? "").match(/scripts\/[^\s]+\.ts/)?.[0] : (scriptPathsIn(r[0] ?? "")[0])
    if (!f) { notGated.push(`${r[0]}: no script`); continue }
    if (!isCredentialGated(stripComments(read(f)))) notGated.push(`${key ?? f}: no env read + skip path in ${f}`)
  }
  ok("R7 · each listed proof reads process.env and has a console skip path", notGated.length === 0, notGated.join("; "))
}

console.log("\n[8 · R8 — pending lane proofs are named]")
{
  const rows = tableRows(pendingBody)
  ok(`the pending list has rows (${rows.length})`, rows.length > 0)
  const bad = badPendingRows(rows)
  ok("R8 · every pending row names a wave lane and a scripts/ path", bad.length === 0, bad.join("; "))
  const landed = rows.map((r) => scriptPathsIn(r.join(" "))[0]).filter((p) => p && existsSync(p))
  console.log(`  · informational: ${landed.length} of ${rows.length} pending proofs are on disk at this commit${landed.length ? ` (run them: ${landed.join(", ")})` : ""}`)
}

console.log(`\n${"─".repeat(60)}\n RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  console.log("\nThe test matrix must describe the proofs that exist, in the mode they actually run.")
  process.exit(1)
}
console.log("\n✅ TEST_MATRIX — every named proof is real, every unperformed test states its dependency, and no simulated run is labelled live.")
