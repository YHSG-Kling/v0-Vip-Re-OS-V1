#!/usr/bin/env tsx
/**
 * scripts/compliance-scope-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BOUNDARY PIN FOR THE WAVE-15 OWNER RULING.
 *
 * Verbatim: "the content should get the compliance but any lead scrapping,
 * enrichment or signals or property searching from the buyer should not be put
 * through the compliance or fair housing." And: "do not run the compliance or
 * fair housing on scrapping, enrichment, scoring, sourcing because we determine
 * the kind of education in channels by the age group and other ways to use it
 * without violating the rules."
 *
 * A ruling that lives only in prose is a ruling that gets read once. This is the
 * ruling as a check, in BOTH directions, because only one of them is expensive
 * to get wrong in each direction:
 *
 *   NEGATIVE — no content-compliance / fair-housing entry point is REACHABLE
 *              from the data lane: scraping, enrichment, scoring, sourcing, and
 *              the buyer-search query / filter / scoring path. If somebody
 *              re-wires a content scanner into enrichment, this goes red.
 *
 *   POSITIVE — the SAME content stack is still reachable from a real outbound
 *              message path, a marketing/ad path, a listing-copy path and a
 *              video-script path. If somebody UNWIRES content compliance —
 *              which is the failure mode a negative-only check would happily
 *              report as success — this goes red.
 *
 * ── WHAT IS MEASURED, AND HOW ────────────────────────────────────────────────
 * A static IMPORT-GRAPH reachability walk over every .ts/.tsx under lib/ and
 * app/. Edges come from static `import … from "x"`, `export … from "x"`, and
 * DYNAMIC `await import("x")` — the last one matters here because this codebase
 * routes a great deal of compliance through lazy imports, and a scanner that
 * only saw static imports would report a clean data lane by being blind to the
 * exact edge that is most likely to appear.
 *
 * COMMENT HANDLING (CLAUDE.md §2): `blankComments` from scripts/strip-comments.ts,
 * never a hand-rolled stripper. Comments are BLANKED rather than removed so byte
 * offsets survive for the line numbers reported below, and a commented-out
 * import cannot manufacture a false edge — the single most likely way this
 * check would accuse live code, since half the tombstones in this repo quote an
 * import that no longer exists.
 *
 * ── BLIND SPOTS, PUBLISHED BESIDE THE NUMBER ─────────────────────────────────
 *   1. Specifiers built at runtime (`import(base + name)`) are invisible. None
 *      are known on these paths; the check cannot prove that.
 *   2. Registry / string-keyed dispatch (lib/kernel/manager-registry.ts names
 *      simulators and managers as DATA) is not an import edge and is not
 *      followed. That is correct for this question — a name in a table does not
 *      execute a scanner — but it means "unreachable" here means "unreachable
 *      by import", not "provably never executed".
 *   3. Only lib/ and app/ are walked. scripts/ is excluded on purpose: a
 *      simulator importing a compliance module proves nothing about production
 *      wiring, and including them would make every seed reach everything.
 *   4. The NEGATIVE walk is BOUNDED to the data lane's own modules. Unbounded
 *      transitive reachability answers the wrong question here — an exempt file
 *      importing `lib/kernel/index.ts` for one unrelated symbol would "reach"
 *      every scanner in the tree through a barrel. The unbounded number is still
 *      computed and PRINTED in block [1b] as a watch list, with the chains, so
 *      the bounded zero is never a zero-by-exclusion.
 *
 * Run: npx tsx scripts/compliance-scope-simulator.ts
 * Wired: package.json "test:compliance-scope", chained into "guard".
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { blankComments } from "./strip-comments"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ═══════════════════════════════════════════════════════════════════════════
// THE NAMED LISTS — the ruling, as data
// ═══════════════════════════════════════════════════════════════════════════

/**
 * CONTENT-COMPLIANCE ENTRY POINTS. Every module that scans, rewrites or refuses
 * COPY on fair-housing / advertising-compliance grounds. Reaching any of these
 * is what "content compliance is wired here" means.
 *
 * Each was confirmed to export a scanning or gating function, not merely to
 * mention fair housing in a comment — a header that says "fair housing" is not
 * a control, and counting it would inflate the positive side of this check.
 */
const CONTENT_ENTRY_POINTS: Array<[string, string]> = [
  ["lib/compliance-rules/fair-housing-patterns.ts", "detectFairHousingViolations — the pattern catalogue"],
  ["lib/compliance-rules/rule-evaluators.ts", "evaluateRegulatoryCompliance / evaluateBrandCompliance"],
  ["lib/compliance-rules/state-fair-housing.ts", "state-specific fair-housing disclosure rules"],
  ["lib/compliance/content-safety-checks.ts", "evaluateContentSafety — fair_housing safety category"],
  ["lib/compliance/client-text-guard.ts", "hasFairHousingViolation / sanitizeProperNoun on client copy"],
  ["lib/kernel/marketing/real-estate-compliance-gate.ts", "realEstateComplianceGate — the ad/marketing gate"],
  ["lib/marketing/content-publish-gate.ts", "enforceContentPublishRules"],
  ["lib/video/script-compliance.ts", "assessScriptCompliance / detectFairHousingRedFlags"],
  ["lib/content-guardian/index.ts", "guardContent — listing + marketing copy"],
  ["lib/listings/mls-rule-check.ts", "checkMlsRules — listing-copy advertising rules"],
  ["lib/buyer-search/fair-housing.ts", "scanExplanation — the buyer-facing copy WE author"],
]

/**
 * THE EXEMPT DATA LANE. Seeds, as path globs. Anything reachable FROM one of
 * these must not be a content entry point.
 *
 * `lib/buyer-search/fair-housing.ts` and `lib/buyer-search/search-engine.ts` are
 * deliberately NOT here. The sanitizer stays on the buyer-facing MATCH
 * EXPLANATION, which is copy we author and publish; the ruling exempts the
 * buyer's query, the filters built from it, the provider call and the scoring —
 * which is exactly the file list below.
 */
const EXEMPT_PATH_GLOBS: Array<[string, string]> = [
  ["lib/lead-pipeline/**", "scraping + enrichment + the whole acquisition lane"],
  ["lib/lead-governance/**", "signal scoring + the protected-class CLASSIFIER (not a gate)"],
  ["lib/external/batchdata-seller-signals.ts", "seller-signal SOURCING from the property provider"],
  ["lib/external/permit-signals.ts", "the other seller-signal source"],
  ["lib/external/batchdata-client.ts", "the property-provider client"],
  ["lib/buyer-search/intent-parser.ts", "buyer property search — the QUERY"],
  ["lib/buyer-search/persona-inference.ts", "buyer property search — persona SCORING"],
  ["lib/buyer-search/buyer-criteria.ts", "buyer property search — the FILTERS"],
  ["lib/buyer-search/conversation-criteria.ts", "buyer property search — the FILTERS"],
  ["lib/buyer-search/search-logger.ts", "buyer property search — the signal log"],
  ["lib/buyer-search/external-match.ts", "buyer property search — the provider call"],
  ["lib/property-matching/match-scorer.ts", "buyer↔listing SCORING"],
  ["lib/property-matching/match-logger.ts", "buyer↔listing scoring — the log"],
]

/**
 * THE POSITIVE CONTROL. Four real production paths, one per content lane the
 * ruling KEEPS gated. Each must reach at least one content entry point.
 *
 * A negative-only check cannot tell "the data lane is clean" from "the scanner
 * import was deleted last Tuesday". These four are what make the zero above
 * mean something (CLAUDE.md §2).
 */
const CONTENT_PATHS: Array<[string, string]> = [
  ["lib/agents/generate-client-message.ts", "OUTBOUND MESSAGE — copy sent to a client"],
  ["app/actions/marketing-studio.ts", "MARKETING / AD — campaign creative"],
  ["app/actions/ai-listing-intake.ts", "LISTING COPY — the public listing description"],
  ["lib/kernel/video.ts", "VIDEO SCRIPT — compliance-first script authoring"],
]

// ═══════════════════════════════════════════════════════════════════════════
// THE IMPORT GRAPH
// ═══════════════════════════════════════════════════════════════════════════

const SCAN_ROOTS = ["lib", "app"]
const EXTS = [".ts", ".tsx"]

function walkFiles(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return out }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next" || e === "__tests__") continue
    const full = join(dir, e)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) walkFiles(full, out)
    else if (EXTS.some((x) => e.endsWith(x)) && !e.endsWith(".d.ts")) out.push(full)
  }
  return out
}

const allFiles = SCAN_ROOTS.flatMap((r) => walkFiles(join(root, r)))
const rel = (abs: string) => relative(root, abs).split("\\").join("/")

/** Resolve a specifier to a repo-relative module path, or null when it leaves
 *  the repo (a package) or cannot be found on disk. */
function resolveSpecifier(fromAbs: string, spec: string): string | null {
  let base: string
  if (spec.startsWith("@/")) base = join(root, spec.slice(2))
  else if (spec.startsWith("./") || spec.startsWith("../")) base = resolve(dirname(fromAbs), spec)
  else return null
  for (const cand of [
    base, ...EXTS.map((x) => base + x), ...EXTS.map((x) => join(base, "index" + x)),
  ]) {
    try { if (existsSync(cand) && statSync(cand).isFile()) return rel(cand) } catch { /* keep looking */ }
  }
  return null
}

/**
 * Edges out of one file. `blankComments` first (CLAUDE.md §2) so a commented-out
 * import is not counted — never a hand-rolled stripper, and never `/* *\/`
 * blocks before `//` lines, which is the defect that makes an analyzer swallow
 * live code.
 */
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g
function edgesOf(abs: string): string[] {
  let src: string
  try { src = readFileSync(abs, "utf8") } catch { return [] }
  const blanked = blankComments(src)
  const out = new Set<string>()
  for (const m of blanked.matchAll(IMPORT_RE)) {
    const target = resolveSpecifier(abs, m[1])
    if (target) out.add(target)
  }
  return Array.from(out)
}

const graph = new Map<string, string[]>()
let edgeCount = 0
for (const f of allFiles) {
  const e = edgesOf(f)
  graph.set(rel(f), e)
  edgeCount += e.length
}

const CONTENT_SET = new Set(CONTENT_ENTRY_POINTS.map(([p]) => p))

/**
 * BFS from `seed`; returns the first import PATH that lands on a content entry
 * point, or null. Returning the path rather than a boolean is deliberate: a red
 * result has to name the edge somebody added, not merely assert one exists.
 *
 * `through` bounds which modules the walk may traverse, and that bound is the
 * whole measurement. UNBOUNDED transitive reachability answers the wrong
 * question in a codebase with barrels: `lib/lead-pipeline/enrichment-orchestrator.ts`
 * imports `lib/kernel/index.ts`, which re-exports `lib/kernel/compliance.ts`,
 * which imports the rule evaluators — so an unbounded walk "proves" that
 * enrichment runs a content scan when in fact it imported a barrel for an
 * unrelated symbol. Bounding the walk to the DATA LANE'S OWN MODULES asks the
 * question that matters: does the exempt code, or code it owns, call a content
 * scanner. The unbounded number is still computed and PRINTED below as a
 * watch list, because a blind spot published is a blind spot; a blind spot
 * silently excluded is a lie (CLAUDE.md §2).
 */
function pathToContent(seed: string, through?: Set<string>): string[] | null {
  if (!graph.has(seed)) return null
  const prev = new Map<string, string | null>([[seed, null]])
  const queue = [seed]
  while (queue.length > 0) {
    const cur = queue.shift()!
    if (cur !== seed && CONTENT_SET.has(cur)) {
      const chain: string[] = []
      let node: string | null = cur
      while (node) { chain.unshift(node); node = prev.get(node) ?? null }
      return chain
    }
    if (through && cur !== seed && !through.has(cur)) continue
    for (const next of graph.get(cur) ?? []) {
      if (!prev.has(next)) { prev.set(next, cur); queue.push(next) }
    }
  }
  return null
}

function expandGlob(glob: string): string[] {
  if (!glob.endsWith("/**")) return graph.has(glob) ? [glob] : []
  const prefix = glob.slice(0, -2)
  return Array.from(graph.keys()).filter((p) => p.startsWith(prefix))
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("═".repeat(58))
console.log(" Compliance scope — the wave-15 boundary, pinned both ways")
console.log("═".repeat(58))

console.log(`\n[0 · the denominator]`)
const exemptSeeds = EXEMPT_PATH_GLOBS.flatMap(([g]) => expandGlob(g))
console.log(`  files scanned .............. ${allFiles.length} (lib/ + app/, .ts + .tsx, excluding *.d.ts and __tests__)`)
console.log(`  import edges resolved ...... ${edgeCount} (static + export-from + dynamic import() + require())`)
console.log(`  content entry points ....... ${CONTENT_ENTRY_POINTS.length}`)
console.log(`  exempt data-lane seeds ..... ${exemptSeeds.length} from ${EXEMPT_PATH_GLOBS.length} globs`)
console.log(`  positive-control paths ..... ${CONTENT_PATHS.length}`)
console.log(`  EXCLUDED from the walk ..... scripts/, node_modules/, .next/, __tests__/, *.d.ts,`)
console.log(`                               runtime-built specifiers, and string-keyed registry dispatch`)

// ── every named module must actually exist, or the whole check is theatre ────
console.log(`\n[0b · the lists name real files — a check that judges nothing reports zero]`)
const missingContent = CONTENT_ENTRY_POINTS.filter(([p]) => !graph.has(p)).map(([p]) => p)
check(`all ${CONTENT_ENTRY_POINTS.length} content entry points exist on disk and were parsed`,
  missingContent.length === 0, missingContent.join(", "))
const missingSeeds = EXEMPT_PATH_GLOBS.filter(([g]) => expandGlob(g).length === 0).map(([g]) => g)
check(`all ${EXEMPT_PATH_GLOBS.length} exempt globs match at least one parsed file`,
  missingSeeds.length === 0, missingSeeds.join(", "))
const missingPos = CONTENT_PATHS.filter(([p]) => !graph.has(p)).map(([p]) => p)
check(`all ${CONTENT_PATHS.length} positive-control paths exist on disk and were parsed`,
  missingPos.length === 0, missingPos.join(", "))
check("the graph resolved a non-trivial number of edges (a broken resolver would report a clean tree)",
  edgeCount > allFiles.length, `${edgeCount} edges over ${allFiles.length} files`)

// ── the resolver itself, proved on a known-true edge ─────────────────────────
check("POSITIVE CONTROL ON THE RESOLVER — a known static edge is present",
  (graph.get("lib/buyer-search/search-engine.ts") ?? []).includes("lib/buyer-search/fair-housing.ts"),
  JSON.stringify(graph.get("lib/buyer-search/search-engine.ts")?.slice(0, 6)))
check("POSITIVE CONTROL ON THE RESOLVER — a known DYNAMIC `await import()` edge is present too",
  (graph.get("lib/agents/education-delivery-producer.ts") ?? []).includes("lib/agents/agent-client-messages.ts"),
  "dynamic imports are the edge most likely to smuggle a scanner back onto the data lane")

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n[1 · NEGATIVE — content compliance is UNREACHABLE from the data lane]`)
// OWNER RULING: scraping, enrichment, scoring, sourcing and the buyer-search
// query/filter/scoring path are exempt. Each glob is asserted as a group so a
// failure names the glob, and then the offending chain is printed in full.
//
// THE WALK IS BOUNDED TO THE DATA LANE ITSELF (see `pathToContent`). A direct
// import of a scanner, or an import of one by another exempt module, is a
// violation. An import that leaves the lane into a shared barrel is NOT, and is
// reported separately in [1b] instead of being asserted here — mixing the two
// would make this check red for a reason that is not the ruling.
const EXEMPT_SET = new Set(exemptSeeds)
for (const [glob, why] of EXEMPT_PATH_GLOBS) {
  const seeds = expandGlob(glob)
  const violations: string[] = []
  for (const seed of seeds) {
    const chain = pathToContent(seed, EXEMPT_SET)
    if (chain) violations.push(chain.join(" → "))
  }
  check(`${glob} (${why}) — ${seeds.length} file(s), 0 reach content compliance`,
    violations.length === 0, violations.slice(0, 3).join("  ||  "))
}

console.log(`\n[1b · THE BLIND SPOT, PUBLISHED — reachability THROUGH shared modules]`)
// NOT ASSERTED, and the reason is stated rather than assumed: every chain here
// leaves the data lane through a module that also serves content lanes
// (lib/kernel/index.ts, lib/ai/models.ts, lib/kernel/ingress-continuity.ts).
// Importing a barrel is not calling a scanner. This list exists so the number is
// not zero-by-exclusion: if a chain here ever shortens to a DIRECT edge, [1]
// above turns red on the same commit.
{
  const leaky: string[] = []
  for (const seed of exemptSeeds) {
    const chain = pathToContent(seed)
    if (chain) leaky.push(chain.join(" → "))
  }
  console.log(`  ${leaky.length} of ${exemptSeeds.length} exempt files reach a content entry point through a SHARED module`)
  for (const chain of leaky.slice(0, 6)) console.log(`    · ${chain}`)
  if (leaky.length > 6) console.log(`    · … and ${leaky.length - 6} more (same barrels)`)
  console.log(`  NOTE: lib/lead-pipeline/offer-rejection-recovery-runner.ts and`)
  console.log(`        lib/lead-governance/stale-lead-processor.ts are OUTBOUND-COPY producers`)
  console.log(`        that happen to live in data-lane directories. Their reach into content`)
  console.log(`        compliance is correct — they author copy. They are the reason this is a`)
  console.log(`        printed watch list and not an assertion.`)
}

// POSITIVE CONTROL ON THE NEGATIVE FINDER. A clean tree and a broken walk both
// print "0 reach content compliance" (CLAUDE.md §2). So a synthetic violation is
// injected into a COPY of the graph — enrichment-orchestrator importing the
// fair-housing pattern catalogue, the exact edit this block exists to stop — and
// the walk must find it. If this control ever goes green-side-up, every ✓ above
// is a broken regex reporting zero.
{
  const seed = "lib/lead-pipeline/enrichment-orchestrator.ts"
  const real = graph.get(seed) ?? []
  graph.set(seed, [...real, "lib/compliance-rules/fair-housing-patterns.ts"])
  const caught = pathToContent(seed, EXEMPT_SET)
  graph.set(seed, real)   // restore before anything else reads the graph
  check("POSITIVE CONTROL — an INJECTED content-compliance import into enrichment IS caught",
    caught !== null && caught[caught.length - 1] === "lib/compliance-rules/fair-housing-patterns.ts",
    caught ? caught.join(" → ") : "THE WALK MISSED A PLANTED VIOLATION — every zero above is meaningless")
  check("…and the injection was undone, so the real graph is unchanged",
    !(graph.get(seed) ?? []).includes("lib/compliance-rules/fair-housing-patterns.ts"))
}

// The one import in the acquisition lane that LOOKS like compliance and is not.
// Named explicitly so a future reader does not "fix" it: phone hygiene is
// DNC/TCPA, a different statute and a different lane from fair housing.
check("…and the ONE compliance import in lib/lead-pipeline is phone hygiene (DNC/TCPA), NOT fair housing",
  (graph.get("lib/lead-pipeline/enrichment-orchestrator.ts") ?? []).some((e) => e.includes("phone-scrub"))
  && !(graph.get("lib/lead-pipeline/enrichment-orchestrator.ts") ?? []).some((e) => CONTENT_SET.has(e)),
  JSON.stringify((graph.get("lib/lead-pipeline/enrichment-orchestrator.ts") ?? []).filter((e) => e.includes("compliance"))))

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n[2 · POSITIVE CONTROL — content compliance is STILL WIRED on every content lane]`)
// If this block ever goes green-by-emptiness the negative block above is
// worthless: a tree with no content compliance anywhere satisfies it perfectly.
//
// ASSERTED AS A DIRECT EDGE, not as transitive reachability, and that choice was
// forced by a failed break-test: commenting the compliance import out of
// app/actions/marketing-studio.ts left this block GREEN, because the file still
// reached a scanner through an unrelated barrel. A positive control that
// survives the exact deletion it exists to catch is not a control. Depth 1 —
// "this file imports a scanner itself" — is the claim that cannot be satisfied
// by a barrel.
for (const [seed, lane] of CONTENT_PATHS) {
  const direct = (graph.get(seed) ?? []).filter((e) => CONTENT_SET.has(e))
  check(`${lane} — ${seed} imports content compliance DIRECTLY`,
    direct.length > 0, "NOTHING IMPORTED — content compliance has been unwired on this lane")
  if (direct.length > 0) console.log(`      via ${direct.join(", ")}`)
  else {
    const chain = pathToContent(seed)
    console.log(`      (transitively it still reaches ${chain ? chain[chain.length - 1] : "nothing"} — a barrel, not a wire)`)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n[3 · THE REFUSAL THAT MOVED — protected class may not segment an ad audience]`)
// The data-lane gates became labels; the refusal landed on ad targeting. If this
// block goes red the ruling was implemented as pure deletion, which is exactly
// what CLAUDE.md §1 forbids.
const { protectedClassSegmentationIn, assertAudienceSegmentationAllowed, labelProtectedClassFields } =
  await import("../lib/lead-governance/protected-class-signals")

function throws(fn: () => unknown): string | null {
  try { fn(); return null } catch (e) { return e instanceof Error ? e.message : String(e) }
}

check("an ad audience segmented by AGE is refused",
  (throws(() => assertAudienceSegmentationAllowed({ filters: { min_owner_age: 65 } }, "A")) ?? "").includes("REFUSED"))
check("…by FAMILIAL STATUS is refused",
  (throws(() => assertAudienceSegmentationAllowed({ filters: { has_children: true } }, "A")) ?? "").includes("REFUSED"))
check("…by a protected TAG VALUE rather than a key is refused",
  (throws(() => assertAudienceSegmentationAllowed({ filters: { contact_tags: ["recently-divorced"] } }, "A")) ?? "").includes("REFUSED"))
check("CONTROL — a behavioural / lifecycle audience is NOT refused (the gate is not refusing everything)",
  throws(() => assertAudienceSegmentationAllowed(
    { type: "contact_list", filters: { contact_tags: ["past-client", "open-house-attendee"], seed_country: "US" } }, "A")) === null)
check("CONTROL — a null / empty rule is not refused (an audience with no rule segments on nothing)",
  protectedClassSegmentationIn(null).length === 0 && protectedClassSegmentationIn({}).length === 0)
check("the data lane LABELS instead of stripping — a demographic survives storage and is named",
  (() => {
    const r = labelProtectedClassFields({ intel: { salePropensity: 90 }, demographics: { age: 71 } })
    return (r.value as any).demographics.age === 71 && r.paths.includes("demographics")
  })())
check("wired for real — lib/audiences/audience-sync.ts imports the refusal",
  (graph.get("lib/audiences/audience-sync.ts") ?? []).includes("lib/lead-governance/protected-class-signals.ts"))

// ── THE DEFINE SIDE (finding #298) ──────────────────────────────────────────
// The refusal used to sit ONLY on the populate half. A protected-class audience
// could therefore be created and SAVED — the offending source_rule persisting in
// the row a provider-side or manual sync reads — and the refusal was discoverable
// only later, as an audience that came back empty. Both halves are asserted now,
// and they are asserted as a DIRECT depth-1 import plus a call in the file's own
// (comment-blanked) source, for the same reason block [2] is: a transitive reach
// through a barrel survives the exact deletion this exists to catch.
//
// These are PRESENCE assertions, so they need no injected positive control the
// way an absence assertion does — a broken reader reports absence and goes red,
// which is the safe direction. The BEHAVIOURAL controls immediately below are
// what prove the gate still discriminates rather than refusing everything.
{
  const callsIn = (p: string) =>
    (blankComments(readFileSync(join(root, p), "utf8")).match(/assertAudienceSegmentationAllowed\s*\(/g) ?? []).length

  check("DEFINE — lib/kernel/ads.ts imports the refusal DIRECTLY (not through a barrel)",
    (graph.get("lib/kernel/ads.ts") ?? []).includes("lib/lead-governance/protected-class-signals.ts"))
  check("DEFINE + POPULATE — lib/kernel/ads.ts CALLS it twice: createAudienceSegment (before the INSERT) and syncAudience (before any contact is read)",
    callsIn("lib/kernel/ads.ts") === 2, `${callsIn("lib/kernel/ads.ts")} live call(s) after comment-blanking`)
  check("DEFINE — app/actions/campaign-presets.ts, the OTHER writer of facebook_custom_audiences.source_rule, calls it too",
    (graph.get("app/actions/campaign-presets.ts") ?? []).includes("lib/lead-governance/protected-class-signals.ts")
    && callsIn("app/actions/campaign-presets.ts") === 1,
    `${callsIn("app/actions/campaign-presets.ts")} live call(s)`)
}

// ── THE GATE MUST NOT REFUSE THE PRODUCT'S OWN SHIPPED AUDIENCES ────────────
// The first thing this gate did was refuse `lifetime_customers`, whose filter
// `min_purchase_age_months` tokenizes to [min,purchase,age,months]. That "age" is
// the age of a PURCHASE, not of a person. The key was renamed to
// `min_tenure_months` rather than carving an exception into the gate — a gate
// that special-cases our own key is a gate the next author weakens. This check is
// what stops the same collision being re-introduced by a new template.
{
  const { FB_AUDIENCE_TEMPLATES } = await import("../lib/ads/fb-audience-templates")
  const refused = FB_AUDIENCE_TEMPLATES
    .map((t) => [t.id, protectedClassSegmentationIn(t.sourceRule)] as const)
    .filter(([, hits]) => hits.length > 0)
    .map(([id, hits]) => `${id}:${hits.join("|")}`)
  check(`all ${FB_AUDIENCE_TEMPLATES.length} shipped audience templates PASS the gate (it refuses protected class, not our own product)`,
    refused.length === 0, refused.join("  ||  "))
  check("…and the finder that cleared them is not blind — the pre-rename key IS still caught",
    protectedClassSegmentationIn({ type: "lifetime_customers", filters: { min_purchase_age_months: 0 } }).length > 0,
    "if this goes green-side-up the check above passes by seeing nothing")
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n[4 · THE CAPABILITY THE RULING WAS FOR — education routed by AGE BAND]`)
const { ageSegmentFromAge, ageSegmentFromAgeRange, AGE_SEGMENTS } = await import("../lib/kernel/education")
const { pickEducationChannel } = await import("../lib/agents/education-delivery-producer")

check("bands are BUCKETS, defined once, and a band is all a selector ever sees",
  AGE_SEGMENTS.join("|") === "18-30|30-50|50-65|65+")
check("an unmeasured age stays UNMEASURED — it does not default into a band",
  ageSegmentFromAge(null) === null && ageSegmentFromAge(0) === null && ageSegmentFromAgeRange(null) === null)
check("the enrichment lane's own banding collapses onto ours (one age vocabulary, CLAUDE.md §6)",
  ageSegmentFromAgeRange("25-34") === "30-50" && ageSegmentFromAgeRange("18-24") === "18-30"
  && ageSegmentFromAgeRange("55-64") === "50-65" && ageSegmentFromAgeRange("65+") === "65+",
  [ageSegmentFromAgeRange("25-34"), ageSegmentFromAgeRange("18-24"), ageSegmentFromAgeRange("55-64"), ageSegmentFromAgeRange("65+")].join(","))
{
  const consented = { tcpa_consent: true, dnc_status: false }
  const young = pickEducationChannel({ ageSegment: "18-30", moduleChannels: ["video"], consent: consented, preferredChannel: null })
  const mid = pickEducationChannel({ ageSegment: "30-50", moduleChannels: ["article"], consent: consented, preferredChannel: null })
  const old = pickEducationChannel({ ageSegment: "65+", moduleChannels: ["article"], consent: consented, preferredChannel: null })
  check("THE OWNER'S ASK — the CHANNEL differs by age band for the same lesson",
    young.channel !== mid.channel && mid.channel !== old.channel,
    `18-30=${young.channel} 30-50=${mid.channel} 65+=${old.channel}`)
  check("…and an unbanded contact falls to the portal, not to the middle band's rail",
    pickEducationChannel({ ageSegment: null, moduleChannels: [], consent: consented, preferredChannel: null }).channel === "portal")
  check("CONSENT still outranks the band — no TCPA consent means no SMS to the young band",
    pickEducationChannel({ ageSegment: "18-30", moduleChannels: ["video"], consent: { tcpa_consent: false, sms_opt_out: true }, preferredChannel: null })
      .channel !== "sms")
  check("STATED PREFERENCE still outranks the band — an email-only contact is not pushed",
    pickEducationChannel({ ageSegment: "30-50", moduleChannels: ["article"], consent: consented, preferredChannel: "email" }).channel === "email")
  check("every rejected rail is REPORTED, so 'portal' is never indistinguishable from 'nothing was tried'",
    pickEducationChannel({ ageSegment: "50-65", moduleChannels: ["podcast"], consent: consented, preferredChannel: null }).rejected.length > 0)
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n[5 · CONTENT STAYS GATED — and the rewrite is a REPORTED fact]`)
// The buyer-facing match explanation is copy WE author, so it stays sanitized
// under the ruling. What changed is that the sanitizer's `flagged[]` used to be
// discarded by the caller, which made "the sanitizer fired on 12 of 20
// explanations" and "the sanitizer is unwired" byte-identical (CLAUDE.md §2).
const { scanExplanation, scanFairHousing } = await import("../lib/buyer-search/fair-housing")
{
  const dirty = {
    headline: "Great home for your growing family",
    bullets: ["Near top-rated schools", "3 beds, 2 baths"],
    narrative: "Perfect for families in a very safe neighborhood.",
    callToAction: "See it in person with your family",
  }
  const r = scanExplanation(dirty)
  check("the buyer-facing explanation is still sanitized (content stays gated)",
    !/growing family|top-rated|families|safe neighborhood|with your family/i.test(
      [r.clean.headline, ...r.clean.bullets, r.clean.narrative, r.clean.callToAction].join(" ")),
    JSON.stringify(r.clean))
  check("…and every rule that fired is REPORTED, not swallowed",
    r.flagged.length >= 3 && r.flagged.includes("familial-status") && r.flagged.includes("safety-proxy"),
    r.flagged.join(","))
  check("CONTROL — clean copy reports NOTHING and is returned byte-identical",
    (() => {
      const clean = { headline: "3 beds, 2 baths", bullets: ["Pool"], narrative: "Built 1998.", callToAction: "Book a tour" }
      const c = scanExplanation(clean)
      return c.flagged.length === 0 && c.clean.headline === clean.headline && c.clean.narrative === clean.narrative
    })())
  check("…and the buyer's OWN words are never the thing being scanned — only copy we author",
    scanFairHousing("near good schools").clean !== undefined
    && (graph.get("lib/buyer-search/intent-parser.ts") ?? []).every((e) => !CONTENT_SET.has(e)),
    "intent-parser is the buyer's query and imports no scanner")
  check("the search engine CONSUMES the report rather than dropping it",
    /fair_housing_sanitized/.test(blankComments(readFileSync(join(root, "lib/buyer-search/search-engine.ts"), "utf8"))),
    "search-engine.ts must surface the flagged labels in its metadata")
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(58))
console.log(` ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log(" FAILURES:")
  for (const f of failures) console.log(`   · ${f}`)
}
console.log("═".repeat(58))
process.exit(failed > 0 ? 1 : 0)
