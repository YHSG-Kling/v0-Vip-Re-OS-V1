#!/usr/bin/env tsx
/**
 * scripts/lifecycle-lib-defects-simulator.ts
 *
 *   npx tsx scripts/lifecycle-lib-defects-simulator.ts            (source + pure + live + negative)
 *   npx tsx scripts/lifecycle-lib-defects-simulator.ts --no-negative
 *   npx tsx scripts/lifecycle-lib-defects-simulator.ts --only=d1  (d1 | d2 | d3, comma-separated)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE LIB-LAYER DEFECTS, EACH OF WHICH MADE A FEATURE SILENTLY DO NOTHING.
 *
 * D1 — A STAGE GATE WITH NO VALIDATION AT ALL.
 *      lib/application/listing-lifecycle.ts::advanceListingStageService read the
 *      listing and then wrote listings.lifecycle_stage. No readiness check, no
 *      role check, no stage-machine check — on the LIVE path the stage pipeline
 *      and the AI-chat tool both use. The only gate was client-side, which is
 *      not a gate. Nothing downstream catches it: transitionLifecycle
 *      (lib/kernel/lifecycle.ts) writes the state column UNCONDITIONALLY and
 *      records `fromState` in metadata as a claim it never verifies.
 *      FIXED: the precondition is DERIVED from LISTING_LIFECYCLE_STAGES, so the
 *      gate and the table cannot drift. This file asserts the CONSTRUCT: that
 *      there is no hand-written stage list in the service at all.
 *
 * D2 — A READER LOOKING IN THE WRONG ENTITY SPACE.
 *      lib/kernel/listings.ts::loadListingWorkspace read lifecycle_events with
 *      entity_type='listing'; the stage machine writes 'listing_stage_machine'
 *      (ENTITY_MAP in lib/kernel/lifecycle.ts). BOTH are written, by different
 *      producers, so the fix is to read BOTH — swapping one for the other would
 *      have been the mirror-image bug.
 *
 * D3 — A CHASE LEG THAT MATCHED NOTHING.
 *      lib/kernel/signature-chase.ts filtered client_documents.signature_status
 *      = 'pending'; every writer writes 'pending_signature'. The live column has
 *      NO CHECK constraint, so the database admits both spellings and would
 *      never have refused either side — the vocabulary is settled by the writers
 *      alone, which is exactly how a reader drifts from it in silence.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW THIS PROVES THINGS RATHER THAN CLAIMING THEM
 *
 * · Comments are STRIPPED before scanning, so prose describing a fix can never
 *   satisfy an assertion.
 * · The stage table, the entity-type set and the signature vocabulary are each
 *   PARSED OUT OF SOURCE and then checked against the imported runtime value.
 *   Every downstream assertion is built on the parsed model, so mutating the
 *   source flips it — which is what makes the negative layer real rather than
 *   decorative, and what lets a future divergence be detected instead of a
 *   literal being pinned twice.
 * · The LIVE layer is creds-gated and SKIPS LOUDLY. A network error is never
 *   scored as a pass. Where it can, it proves the defect: it seeds the rows the
 *   old filter missed, asserts the new filter finds them, then deletes and
 *   RE-COUNTS to prove residue is zero.
 * · The NEGATIVE layer breaks every source-backed assertion on purpose, asserts
 *   the mutation actually applied (a `replace` that no-ops makes the whole thing
 *   theatre), confirms that specific check flips to failure, restores, and
 *   verifies the restore by sha256.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { createHash } from "node:crypto"
import { createClient } from "@supabase/supabase-js"

import { LISTING_LIFECYCLE_STAGES, entersFromAnyStage, getStageIndex } from "../lib/listing-lifecycle/lifecycle-definitions"
import { LISTING_TIMELINE_ENTITY_TYPES } from "../lib/kernel/listings"
import { CLIENT_DOCUMENT_AWAITING_SIGNATURE_STATUSES, classifySignatureStall } from "../lib/kernel/signature-chase"
import { stripComments } from "./strip-comments"

const ROOT = process.cwd()

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const arg = (name: string) => argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
const argValue = (name: string) => arg(name)?.split("=")[1] ?? ""
const RUN_NEGATIVE = !arg("no-negative")
const ONLY = argValue("only").split(",").map((s) => s.trim()).filter(Boolean)

// ─────────────────────────────────────────────────────────────────────────────
// FILES
// ─────────────────────────────────────────────────────────────────────────────
const F = {
  service: "lib/application/listing-lifecycle.ts",
  defs: "lib/listing-lifecycle/lifecycle-definitions.ts",
  kernelListings: "lib/kernel/listings.ts",
  kernelLifecycle: "lib/kernel/lifecycle.ts",
  chase: "lib/kernel/signature-chase.ts",
  action: "app/actions/listing-lifecycle.ts",
  writerDotloop: "app/actions/dotloop-integration.ts",
  writerDocIntel: "app/actions/ai-document-intelligence.ts",
  stagePipeline: "app/components/dashboard/listings/lifecycle/stage-pipeline.tsx",
} as const

/** Raw source, re-read every time — the negative layer rewrites these files. */
const raw = (file: string) => readFileSync(resolve(ROOT, file), "utf8")
const sha = (file: string) => createHash("sha256").update(readFileSync(resolve(ROOT, file))).digest("hex")

// stripComments() now comes from scripts/strip-comments.ts — see the import above.
// hand-rolled scanner replaced (finding #250): it could not see nested `${…}` templates, regex literals, or an apostrophe in JSX text, and went blind on the code it judges.

const code = (file: string) => stripComments(raw(file))

/** Balance `{ … }` from `open`; index of the matching `}` or -1. */
function matchBrace(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}") { depth--; if (depth === 0) return i }
  }
  return -1
}

/**
 * The BODY of `function <name>(…)` / `async function <name>(…)`.
 *
 * TWO TRAPS, both of which produce an empty "body" and therefore assertions
 * that can never fail for the right reason:
 *   · the first `{` after the name is the DESTRUCTURED PARAMETER, so the
 *     parameter list is skipped by balancing parens, not by searching for `{`;
 *   · the first `{` after the parameters is inside the RETURN TYPE
 *     (`): Promise<KernelResult<{ … }>> {`), so the body brace is the first `{`
 *     at angle-bracket depth zero.
 */
function fnBody(src: string, name: string): string {
  const re = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+\\b${name}\\b\\s*\\(`)
  const m = re.exec(src)
  if (!m) return ""
  let i = m.index + m[0].length - 1
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === "(") depth++
    else if (src[i] === ")") { depth--; if (depth === 0) { i++; break } }
  }
  let angle = 0
  let open = -1
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === "<") angle++
    else if (c === ">") { if (angle > 0) angle-- }
    else if (c === "{" && angle === 0) { open = i; break }
  }
  if (open === -1) return ""
  const close = matchBrace(src, open)
  return close === -1 ? "" : src.slice(open, close + 1)
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE-PARSED MODELS
//
// Each model is parsed out of the file and then checked against the imported
// runtime value. Assertions are built on the PARSED model so that breaking the
// source flips them; the parsed-equals-imported check is what keeps the parsed
// model honest.
// ─────────────────────────────────────────────────────────────────────────────

interface ParsedStage { stage: string; allowedFrom: string[]; readinessChecks: string[]; requiredRoles: string[] }

function parseStageTable(): ParsedStage[] {
  const src = code(F.defs)
  const start = src.indexOf("LISTING_LIFECYCLE_STAGES")
  if (start === -1) return []
  const arrayOpen = src.indexOf("[", start)
  if (arrayOpen === -1) return []
  const body = src.slice(arrayOpen)
  const re = /\{\s*stage:\s*"([A-Z_]+)"[\s\S]*?allowedFrom:\s*\[([^\]]*)\][\s\S]*?readinessChecks:\s*\[([^\]]*)\][\s\S]*?requiredRoles:\s*\[([^\]]*)\]/g
  const list: ParsedStage[] = []
  const strings = (s: string) => (s.match(/"([^"]+)"/g) ?? []).map((x) => x.slice(1, -1))
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    list.push({ stage: m[1], allowedFrom: strings(m[2]), readinessChecks: strings(m[3]), requiredRoles: strings(m[4]) })
  }
  return list
}

/** `export const NAME = [ "a", "b" ] as const` → ["a","b"] */
function parseStringArrayConst(file: string, name: string): string[] {
  const src = code(file)
  const re = new RegExp(`export\\s+const\\s+\\b${name}\\b[^=]*=\\s*\\[([^\\]]*)\\]`)
  const m = re.exec(src)
  if (!m) return []
  return (m[1].match(/"([^"]+)"/g) ?? []).map((x) => x.slice(1, -1))
}

const sameSet = (a: string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|")

/** Reachability over the PARSED allowedFrom graph. */
function everyRouteTo(target: string, mustPassThrough: string, table: ParsedStage[]): { ok: boolean; counterexample?: string[] } {
  const byName = new Map(table.map((s) => [s.stage, s]))
  const seen = new Set<string>()
  // Walk BACKWARDS from the target through allowedFrom. If any walk reaches a
  // root (a stage with no predecessors) without crossing `mustPassThrough`,
  // there is a route around the requirement.
  const walk = (stage: string, path: string[]): string[] | null => {
    if (stage === mustPassThrough) return null
    const def = byName.get(stage)
    if (!def) return [...path, `${stage}(unknown)`]
    if (def.allowedFrom.length === 0) return [...path, stage] // reached a root
    const key = `${stage}::${path.length}`
    if (seen.has(key)) return null
    seen.add(key)
    for (const prev of def.allowedFrom) {
      const bad = walk(prev, [...path, stage])
      if (bad) return bad
    }
    return null
  }
  const counterexample = walk(target, [])
  return counterexample ? { ok: false, counterexample } : { ok: true }
}

/**
 * Every supabase STATEMENT in a body — the whole `const {...} = await
 * supabase.from(...)…` chain, not just the line the `.from(` happens to sit on.
 *
 * A line-scoped matcher is the trap here: `const { data } = await supabase`
 * puts `.from(` on the NEXT line, so a per-line scan skips exactly the
 * multi-line chains that carry the defect. Statements are cut at the next line
 * that starts a new one — crucially including `if`, so a trailing
 * `if (someError)` is NOT counted as this statement checking its own error.
 */
function supabaseStatements(src: string): string[] {
  const lines = src.split("\n")
  const startRe = /^\s*(export\s+)?(const|let|var|await|return|if|for|while|switch|try|throw)\b/
  const starts: number[] = []
  for (let i = 0; i < lines.length; i++) if (startRe.test(lines[i])) starts.push(i)
  const stmts: string[] = []
  for (let k = 0; k < starts.length; k++) {
    const a = starts[k]
    const b = k + 1 < starts.length ? starts[k + 1] : lines.length
    stmts.push(lines.slice(a, b).join("\n"))
  }
  return stmts.filter((s) => /\.from\(\s*["']/.test(s) && /\b(supabase|svc)\b/.test(s))
}

/**
 * Statements whose outcome is discarded.
 *
 * A `Promise.all([...])` batch is destructured into NAMED results and checked
 * afterwards (`if (listingResult.error) …`), so for those the requirement is
 * that every named result is error-checked somewhere in the module — a batch
 * where even one result is unchecked is still reported.
 */
function uncheckedSupabaseStatements(src: string): string[] {
  return supabaseStatements(src).filter((s) => {
    const batch = /const\s*\[([^\]]+)\]\s*=\s*await\s+Promise\.all\(/.exec(s)
    if (batch) {
      const names = batch[1].split(",").map((n) => n.trim()).filter(Boolean)
      return !names.every((n) => new RegExp(`\\b${n}\\.error\\b`).test(src))
    }
    return !/\berror\b/.test(s)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// ASSERTIONS
// ─────────────────────────────────────────────────────────────────────────────

type Outcome = { ok: boolean; detail?: string }
interface Assertion {
  id: string
  defect: "d1" | "d2" | "d3" | "d4"
  layer: "source" | "pure" | "live"
  what: string
  run: () => Outcome | Promise<Outcome>
  /** Source mutations that MUST flip this assertion to failure. */
  breaks: { file: string; find: string | RegExp; replace: string }[]
}

// Live handles, filled by the live layer.
let LIVE: {
  svc: ReturnType<typeof createClient> | null
  listingId: string | null
  brokerageId: string | null
  notes: string[]
} = { svc: null, listingId: null, brokerageId: null, notes: [] }

const SEED_EVENT_ID = "dddddddd-0000-4000-8000-00000000e101"
const SEED_EVENT_ID_2 = "dddddddd-0000-4000-8000-00000000e102"
const SEED_DOC_ID = "dddddddd-0000-4000-8000-00000000e301"

const assertions: Assertion[] = [
  // ══════════════════════════════════════════════════════════════════════════
  // D4 — the portal-visibility toggle read the wrong entity space
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: "d4.portal-toggle-reads-the-stage-machine",
    defect: "d4",
    layer: "pure",
    what: "setMilestonePortalVisibility looks for the stage event in listing_stage_machine, not the MLS-status stream — it filtered entity_type 'listing' alone, so every toggle answered 'Event not found'",
    run: () => {
      const body = fnBody(code(F.action), "setMilestonePortalVisibility")
      if (!body) return { ok: false, detail: "setMilestonePortalVisibility not found" }
      const reads = /\.in\(\s*["']entity_type["']\s*,\s*\[[^\]]*listing_stage_machine[^\]]*\]/.test(body)
      if (!reads) return { ok: false, detail: "the stage lookup does not include listing_stage_machine" }
      const onlyMls = /\.eq\(\s*["']entity_type["']\s*,\s*["']listing["']\s*\)/.test(body)
      if (onlyMls) return { ok: false, detail: "still pinned to entity_type 'listing' (MLS status), which carries no lifecycle stage" }
      return { ok: true, detail: "reads both entity spaces; to_state disambiguates" }
    },
    breaks: [
      { file: F.action, find: `.in("entity_type", ["listing_stage_machine", "listing"])`, replace: `.eq("entity_type", "listing")` },
    ],
  },
  {
    id: "d4.portal-toggle-distinguishes-refusal-from-absence",
    defect: "d4",
    layer: "pure",
    what: "a refused read and a genuinely missing transition are reported as DIFFERENT things, so an RLS denial never reads as 'no such milestone'",
    run: () => {
      const body = fnBody(code(F.action), "setMilestonePortalVisibility")
      if (!body) return { ok: false, detail: "function not found" }
      const refusal = /if\s*\(\s*fetchError\s*\)[\s\S]{0,200}?return/.test(body)
      const absence = /if\s*\(\s*!\s*evt\s*\)[\s\S]{0,300}?return/.test(body)
      if (!refusal) return { ok: false, detail: "no distinct branch on fetchError" }
      if (!absence) return { ok: false, detail: "no distinct branch on a missing event" }
      return { ok: true, detail: "refusal and absence answered separately" }
    },
    breaks: [
      { file: F.action, find: `  if (fetchError) {`, replace: `  if (false) {` },
    ],
  },
  {
    id: "d4.portal-toggle-surfaces-the-verdict",
    defect: "d4",
    layer: "pure",
    what: "the stage pipeline SHOWS the server's refusal instead of silently snapping the switch back",
    run: () => {
      const body = fnBody(code(F.stagePipeline), "handlePortalToggle")
      if (!body) return { ok: false, detail: "handlePortalToggle not found" }
      if (!/else\s*\{[\s\S]{0,300}?setError\s*\(/.test(body)) {
        return { ok: false, detail: "no else-branch reporting the refusal to the agent" }
      }
      return { ok: true, detail: "refusal reaches the surface" }
    },
    breaks: [
      { file: F.stagePipeline, find: `      setError(result.error ?? "Could not change portal visibility for this milestone")`, replace: `      void result` },
    ],
  },
  // ══════════════════════════════════════════════════════════════════════════
  // D1 — the stage gate
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: "d1.parsed-table-matches-runtime",
    defect: "d1",
    layer: "pure",
    what: "the stage table parsed from source IS the runtime LISTING_LIFECYCLE_STAGES (keeps every derived assertion below honest)",
    run: () => {
      const parsed = parseStageTable()
      if (parsed.length !== LISTING_LIFECYCLE_STAGES.length) {
        return { ok: false, detail: `parsed ${parsed.length} stages, runtime has ${LISTING_LIFECYCLE_STAGES.length}` }
      }
      for (let i = 0; i < parsed.length; i++) {
        const p = parsed[i]
        const r = LISTING_LIFECYCLE_STAGES[i]
        if (p.stage !== r.stage) return { ok: false, detail: `#${i}: parsed ${p.stage} vs runtime ${r.stage}` }
        if (p.allowedFrom.join(",") !== r.allowedFrom.join(",")) return { ok: false, detail: `${p.stage}.allowedFrom drifted` }
        if (p.readinessChecks.join(",") !== r.readinessChecks.join(",")) return { ok: false, detail: `${p.stage}.readinessChecks drifted` }
        if (p.requiredRoles.join(",") !== r.requiredRoles.join(",")) return { ok: false, detail: `${p.stage}.requiredRoles drifted` }
      }
      return { ok: true, detail: `${parsed.length} stages parsed and matched` }
    },
    breaks: [
      { file: F.defs, find: `    stage: "MLS_ACTIVE",\n    label: "MLS Active",`, replace: `    stage: "MLS_ACTIVE_XX",\n    label: "MLS Active",` },
      // THIS FIXTURE NO LONGER SPANS readinessChecks, ON PURPOSE (CLAUDE.md §2 —
      // "do not pin an assertion to a WAYPOINT"). It used to read
      // `allowedFrom: [...],\n    readinessChecks: ["mls_data_complete"],`, so
      // when the owner's 2026-09-04 ruling added `documents_verified` to
      // MLS_ACTIVE the find string stopped matching and the theatre detector
      // (correctly, loudly) reported the mutation as not applied. The mutation
      // only ever needed to drift allowedFrom; it is now anchored on the stage's
      // IDENTITY plus the one line it actually changes, so a future change to
      // this stage's readiness checks cannot break it again.
      { file: F.defs, find: `    stage: "MLS_ACTIVE",\n    label: "MLS Active",\n    description: "Live on MLS",\n    allowedFrom: ["OPEN_HOUSE_MARKETING"],`, replace: `    stage: "MLS_ACTIVE",\n    label: "MLS Active",\n    description: "Live on MLS",\n    allowedFrom: ["LEAD"],` },
    ],
  },
  {
    id: "d1.owner-ruling-holds-by-construction",
    defect: "d1",
    layer: "pure",
    what: "EVERY route through allowedFrom to a publicly-live stage (MLS_ACTIVE, COMING_SOON_ACTIVE) passes through LISTING_AGREEMENT_SIGNED — a listing cannot go live around a signed agreement",
    run: () => {
      const table = parseStageTable()
      for (const live of ["MLS_ACTIVE", "COMING_SOON_ACTIVE"]) {
        const r = everyRouteTo(live, "LISTING_AGREEMENT_SIGNED", table)
        if (!r.ok) return { ok: false, detail: `${live} reachable without a signed agreement via ${r.counterexample?.join(" ← ")}` }
      }
      const signed = table.find((s) => s.stage === "LISTING_AGREEMENT_SIGNED")
      if (!signed || signed.readinessChecks.length === 0) {
        return { ok: false, detail: "LISTING_AGREEMENT_SIGNED declares no readiness checks — the gate would wave it through" }
      }
      return { ok: true, detail: `LISTING_AGREEMENT_SIGNED requires [${signed.readinessChecks.join(", ")}]` }
    },
    breaks: [
      // Anchored on stage identity + the allowedFrom line only — see the note on
      // the sibling fixture above for why readinessChecks was dropped from it.
      { file: F.defs, find: `    stage: "MLS_ACTIVE",\n    label: "MLS Active",\n    description: "Live on MLS",\n    allowedFrom: ["OPEN_HOUSE_MARKETING"],`, replace: `    stage: "MLS_ACTIVE",\n    label: "MLS Active",\n    description: "Live on MLS",\n    allowedFrom: ["OPEN_HOUSE_MARKETING", "LEAD"],` },
      // This one still pins LISTING_AGREEMENT_SIGNED's own checks, which the
      // assertion reads directly (it fails when that stage declares none), so
      // the literal IS the thing under test rather than a waypoint beside it.
      { file: F.defs, find: `    readinessChecks: ["dotloop_signatures", "documents_verified"],`, replace: `    readinessChecks: [],` },
    ],
  },
  {
    id: "d1.terminal-exit-rule-is-derived",
    defect: "d1",
    layer: "pure",
    what: "entersFromAnyStage is DERIVED (empty allowedFrom + not the first stage), so LISTING_CANCELLED stays reachable while LEAD and MLS_ACTIVE do not become free-for-alls",
    run: () => {
      const table = parseStageTable()
      const derived = (s: string) => {
        const def = table.find((t) => t.stage === s)
        const idx = table.findIndex((t) => t.stage === s)
        return !!def && def.allowedFrom.length === 0 && idx > 0
      }
      const cases: [string, boolean][] = [["LISTING_CANCELLED", true], ["LEAD", false], ["MLS_ACTIVE", false], ["LISTING_AGREEMENT_SIGNED", false]]
      for (const [stage, expect] of cases) {
        if (derived(stage) !== expect) return { ok: false, detail: `derived(${stage})=${derived(stage)}, expected ${expect}` }
        if (entersFromAnyStage(stage as never) !== expect) return { ok: false, detail: `runtime entersFromAnyStage(${stage}) disagrees with the table` }
        if (getStageIndex(stage as never) < 0) return { ok: false, detail: `${stage} is not in the runtime table` }
      }
      // The RUNTIME check above cannot see a source edit (the module is already
      // imported), so the rule's SOURCE is asserted too — otherwise dropping the
      // index guard, which would make LEAD enterable from anywhere, passes.
      const fn = fnBody(code(F.defs), "entersFromAnyStage")
      if (!fn) return { ok: false, detail: "entersFromAnyStage does not exist" }
      if (!/def\.allowedFrom\.length\s*===\s*0/.test(fn)) return { ok: false, detail: "the rule no longer derives from allowedFrom" }
      if (!/getStageIndex\(stage\)\s*>\s*0/.test(fn)) return { ok: false, detail: "the entry-point guard is gone — LEAD would become enterable from any stage" }
      return { ok: true }
    },
    breaks: [
      { file: F.defs, find: `  return def.allowedFrom.length === 0 && getStageIndex(stage) > 0`, replace: `  return def.allowedFrom.length === 0` },
      { file: F.defs, find: `    stage: "LISTING_CANCELLED",\n    label: "Listing Cancelled",\n    description: "Active listing cancelled by agent, seller, or admin",\n    allowedFrom: [],`, replace: `    stage: "LISTING_CANCELLED",\n    label: "Listing Cancelled",\n    description: "Active listing cancelled by agent, seller, or admin",\n    allowedFrom: ["MLS_ACTIVE"],` },
    ],
  },
  {
    id: "d1.service-holds-no-hand-written-stage-list",
    defect: "d1",
    layer: "source",
    what: "THE CONSTRUCT: the service contains no canonical stage names other than the one pre-existing appointment write — the precondition cannot be hand-copied out of the table and drift from it",
    run: () => {
      const table = parseStageTable()
      const names = new Set(table.map((s) => s.stage))
      // APPOINTMENT_SET is written by scheduleListingAppointmentService, which
      // predates this pass and books an appointment rather than advancing a
      // gated stage. Anything else appearing here is a copied stage list.
      const permitted = new Set(["APPOINTMENT_SET"])
      const src = code(F.service)
      const found = new Set<string>()
      for (const lit of src.match(/"([A-Z][A-Z_]+)"/g) ?? []) {
        const v = lit.slice(1, -1)
        if (names.has(v) && !permitted.has(v)) found.add(v)
      }
      if (found.size > 0) return { ok: false, detail: `hand-written stage literals in the service: ${[...found].join(", ")}` }
      return { ok: true, detail: `0 copied stage names (table has ${names.size})` }
    },
    breaks: [
      { file: F.service, find: `  const def = getStageDefinition(target as ListingStage)`, replace: `  const ALLOWED_FROM = ["LISTING_AGREEMENT_INITIATED", "MLS_DATE_CONFIRMED"]\n  const def = getStageDefinition(target as ListingStage)` },
    ],
  },
  {
    id: "d1.gate-derives-from-the-table",
    defect: "d1",
    layer: "source",
    what: "requireListingStageAdvance reads the listing's OWN lifecycle_stage and derives the precondition from getStageDefinition + validateStageTransition + evaluateReadinessChecks",
    run: () => {
      const body = fnBody(code(F.service), "requireListingStageAdvance")
      if (!body) return { ok: false, detail: "requireListingStageAdvance does not exist" }
      const misses: string[] = []
      if (!/getStageDefinition\(/.test(body)) misses.push("does not consult the stage definition")
      if (!/\.from\("listings"\)[\s\S]{0,200}lifecycle_stage/.test(body)) misses.push("does not read listings.lifecycle_stage")
      if (!/validateStageTransition\(/.test(body)) misses.push("does not run the canonical validator")
      if (!/evaluateReadinessChecks\(/.test(body)) misses.push("does not evaluate readiness checks")
      if (!/def\.readinessChecks/.test(body)) misses.push("readiness checks are not taken from the definition")
      if (!/entersFromAnyStage\(/.test(body)) misses.push("does not use the derived terminal-exit rule")
      return misses.length ? { ok: false, detail: misses.join("; ") } : { ok: true }
    },
    breaks: [
      { file: F.service, find: `  const readiness = await evaluateReadinessChecks(supabase, listingId, def.readinessChecks)`, replace: `  const readiness = { passedChecks: [] as string[], failedChecks: [] as string[] }` },
      { file: F.service, find: `  const validation = validateStageTransition({`, replace: `  const validation = { allowed: true, reason: undefined } as any\n  const unusedValidation = ((_: unknown) => _)({` },
    ],
  },
  {
    id: "d1.gate-refuses-a-failed-read",
    defect: "d1",
    layer: "source",
    what: "a gate that could not READ is not a gate that passed — the listing read, the profile read and auth are all error-checked before any verdict",
    run: () => {
      const body = fnBody(code(F.service), "requireListingStageAdvance")
      if (!body) return { ok: false, detail: "requireListingStageAdvance does not exist" }
      const misses: string[] = []
      if (!/if\s*\(listingError\)\s*return\s*\{\s*ok:\s*false/.test(body)) misses.push("listing read error not refused")
      if (!/if\s*\(profileError\)\s*return\s*\{\s*ok:\s*false/.test(body)) misses.push("profile read error not refused")
      if (!/if\s*\(authError\)\s*return\s*\{\s*ok:\s*false/.test(body)) misses.push("auth error not refused")
      if (!/if\s*\(!fromStage\)/.test(body)) misses.push("a listing with no stage is not refused (it would be waved through on a guessed predecessor)")
      return misses.length ? { ok: false, detail: misses.join("; ") } : { ok: true }
    },
    breaks: [
      { file: F.service, find: `  if (listingError) return { ok: false, error: \`Could not read the listing's stage: \${listingError.message}\` }`, replace: `  void listingError` },
      { file: F.service, find: `  if (profileError) return { ok: false, error: \`Could not read your profile: \${profileError.message}\` }`, replace: `  void profileError` },
    ],
  },
  {
    id: "d1.gate-has-no-bypass",
    defect: "d1",
    layer: "source",
    what: "no override/bypass parameter is threaded into this path — isAdminOverride is pinned false, honouring the ruling that a listing is not taken on without a signed agreement",
    run: () => {
      const src = code(F.service)
      const gate = fnBody(src, "requireListingStageAdvance")
      if (!gate) return { ok: false, detail: "requireListingStageAdvance does not exist" }
      if (!/isAdminOverride:\s*false/.test(gate)) return { ok: false, detail: "isAdminOverride is not pinned false" }
      if (/isAdminOverride:\s*(true|!!|\w*[Oo]verride\w*\b(?!:))/.test(gate)) return { ok: false, detail: "isAdminOverride is derived from something" }
      const advance = fnBody(src, "advanceListingStageService")
      if (/override/i.test(advance.split("{")[0] ?? "")) return { ok: false, detail: "advanceListingStageService took an override parameter" }
      return { ok: true }
    },
    breaks: [
      { file: F.service, find: `    isAdminOverride: false,`, replace: `    isAdminOverride: true,` },
    ],
  },
  {
    id: "d1.both-stage-writers-are-gated",
    defect: "d1",
    layer: "source",
    what: "BOTH exported writers of listings.lifecycle_stage on this path (advanceListingStageService and updateListingStageService) run the gate and return on refusal before writing",
    run: () => {
      const src = code(F.service)
      for (const fn of ["advanceListingStageService", "updateListingStageService"]) {
        const body = fnBody(src, fn)
        if (!body) return { ok: false, detail: `${fn} does not exist` }
        const gateAt = body.indexOf("requireListingStageAdvance(")
        if (gateAt === -1) return { ok: false, detail: `${fn} does not run the gate` }
        if (!/gate\.ok/.test(body)) return { ok: false, detail: `${fn} does not act on the gate verdict` }
        const writeAt = body.search(/\.from\("listing(s|_stage_history)"\)[\s\S]{0,80}\.(update|insert)\(/)
        if (writeAt !== -1 && writeAt < gateAt) return { ok: false, detail: `${fn} writes before it gates` }
      }
      return { ok: true }
    },
    breaks: [
      { file: F.service, find: `  const gate = await requireListingStageAdvance(supabase, params.listing_id, params.stage)\n  if (!gate.ok) return { success: false as const, error: gate.error }`, replace: `  const gate = { ok: true, brokerageId: "", fromStage: null } as any` },
      { file: F.service, find: `  const gate = await requireListingStageAdvance(supabase, listingId, toStage)`, replace: `  const gate = { ok: true, brokerageId: "", fromStage: null, actorUserId: "", readinessPassed: [], readinessFailed: [], stageEnteredAt: null } as any\n  const unusedGate = async () => null` },
    ],
  },
  {
    id: "d1.every-write-is-checked-and-tenant-scoped",
    defect: "d1",
    layer: "source",
    what: "every write in advanceListingStageService destructures `error` and carries an explicit brokerage_id filter — an unchecked write is how a stage advance reports success over a refused audit trail",
    run: () => {
      const body = fnBody(code(F.service), "advanceListingStageService")
      if (!body) return { ok: false, detail: "advanceListingStageService does not exist" }
      const writes = [...body.matchAll(/(const\s*\{[^}]*\}\s*=\s*)?await\s+supabase[\s\S]{0,700}?(?=\n\n|\n  if|\n  const|$)/g)]
        .filter((m) => /\.(insert|update)\(/.test(m[0]))
      if (writes.length < 3) return { ok: false, detail: `expected 3 writes (history close, history insert, listings update), found ${writes.length}` }
      for (const w of writes) {
        if (!/error/.test(w[1] ?? "")) return { ok: false, detail: `an UNCHECKED write remains: ${w[0].slice(0, 90).replace(/\s+/g, " ")}…` }
      }
      const updates = writes.filter((w) => /\.from\("listing(s|_stage_history)"\)[\s\S]{0,600}\.update\(/.test(w[0]))
      for (const u of updates) {
        if (!/\.eq\("brokerage_id"/.test(u[0])) return { ok: false, detail: "an update is not brokerage-scoped" }
      }
      if (!/brokerage_id:\s*gate\.brokerageId/.test(body)) return { ok: false, detail: "the history insert does not carry brokerage_id (the row would be tenant-unscoped)" }
      return { ok: true, detail: `${writes.length} writes, all error-checked` }
    },
    breaks: [
      { file: F.service, find: `  const { error: historyError } = await supabase.from("listing_stage_history").insert({`, replace: `  await supabase.from("listing_stage_history").insert({` },
      { file: F.service, find: `    .eq("id", listingId)\n    .eq("brokerage_id", gate.brokerageId)\n  if (stageError) {`, replace: `    .eq("id", listingId)\n  if (stageError) {` },
    ],
  },
  {
    id: "d1.identity-classes-are-resolved",
    defect: "d1",
    layer: "source",
    what: "listing_stage_history.completed_by (FK → users) is written from a RESOLVED id, never from the raw caller-supplied agentId, and never as `agentId ?? user.id`",
    run: () => {
      const src = code(F.service)
      const body = fnBody(src, "advanceListingStageService")
      if (!body) return { ok: false, detail: "advanceListingStageService does not exist" }
      if (/completed_by:\s*agentId\b/.test(body)) return { ok: false, detail: "completed_by is written from the raw agents-or-users parameter" }
      if (/agentId\s*\?\?\s*\w+\.?\w*id/i.test(body)) return { ok: false, detail: "an `agentId ?? user.id` alias is present" }
      if (!/completed_by:\s*completedBy/.test(body)) return { ok: false, detail: "completed_by is not the resolved value" }
      const resolver = fnBody(src, "resolveHistoryActorUserId")
      if (!resolver) return { ok: false, detail: "resolveHistoryActorUserId does not exist" }
      if (!/resolveAgentRecordToUserId\(/.test(resolver)) return { ok: false, detail: "the resolver does not go through the canonical identity helper" }
      if (!/\.eq\("brokerage_id"/.test(resolver)) return { ok: false, detail: "the resolver does not tenant-check the id it returns" }
      return { ok: true }
    },
    breaks: [
      { file: F.service, find: `    completed_by: completedBy,`, replace: `    completed_by: agentId,` },
      { file: F.service, find: `  const resolved = await resolveAgentRecordToUserId(suppliedId)`, replace: `  const resolved = suppliedId` },
    ],
  },
  {
    id: "d1.automations-do-not-fire-on-a-refusal",
    defect: "d1",
    layer: "source",
    what: "the action layer only fires stage automations after a SUCCESSFUL advance — the service reports a refusal by returning, not throwing",
    run: () => {
      const body = fnBody(code(F.action), "advanceListingStage")
      if (!body) return { ok: false, detail: "advanceListingStage does not exist" }
      const call = body.indexOf("advanceListingStageService(")
      const guard = body.search(/if\s*\(!result\??\.success\)\s*return/)
      // The OVERRIDE branch fires automations too and sits earlier in the body;
      // the one that matters here is the LAST occurrence, on the normal path.
      const fire = body.lastIndexOf("fireStageAutomations(")
      if (call === -1 || fire === -1) return { ok: false, detail: "the normal advance path changed shape" }
      if (guard === -1) return { ok: false, detail: "no success guard between the service call and the automations" }
      if (!(call < guard && guard < fire)) return { ok: false, detail: "the guard does not sit between the advance and the automations" }
      return { ok: true }
    },
    breaks: [
      { file: F.action, find: `  if (!result?.success) return result\n`, replace: `` },
    ],
  },
  {
    id: "d1.kernel-still-has-no-downstream-enforcement",
    defect: "d1",
    layer: "source",
    what: "THE PREMISE: transitionLifecycle still writes the state column unconditionally and never verifies fromState — so the pre-gate really is the only enforcement",
    run: () => {
      const src = code(F.kernelLifecycle)
      if (/\.eq\(\s*entityDef\.stateColumn\s*,\s*fromState\s*\)/.test(src)) {
        return { ok: false, detail: "the kernel now verifies fromState — this gate's premise has changed and should be re-read" }
      }
      if (!/from_state:\s*fromState/.test(src)) return { ok: false, detail: "fromState is no longer recorded as an unverified claim — shape changed" }
      return { ok: true }
    },
    breaks: [
      { file: F.kernelLifecycle, find: `    .from(entityDef.table)\n    .update(updatePayload)\n    .eq("id", entityId)`, replace: `    .from(entityDef.table)\n    .update(updatePayload)\n    .eq("id", entityId)\n    .eq(entityDef.stateColumn, fromState)` },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // D2 — the workspace timeline
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: "d2.entity-type-set-parsed-matches-runtime",
    defect: "d2",
    layer: "pure",
    what: "LISTING_TIMELINE_ENTITY_TYPES parsed from source IS the runtime export (keeps the assertions below derived rather than pinned)",
    run: () => {
      const parsed = parseStringArrayConst(F.kernelListings, "LISTING_TIMELINE_ENTITY_TYPES")
      if (parsed.length === 0) return { ok: false, detail: "the constant could not be parsed" }
      if (!sameSet(parsed, LISTING_TIMELINE_ENTITY_TYPES)) {
        return { ok: false, detail: `parsed [${parsed}] vs runtime [${LISTING_TIMELINE_ENTITY_TYPES}]` }
      }
      return { ok: true, detail: `[${parsed.join(", ")}]` }
    },
    breaks: [
      { file: F.kernelListings, find: `export const LISTING_TIMELINE_ENTITY_TYPES = ["listing", "listing_stage_machine"] as const`, replace: `export const LISTING_TIMELINE_ENTITY_TYPES = ["listing"] as const` },
    ],
  },
  {
    id: "d2.every-declared-entity-type-has-a-live-producer",
    defect: "d2",
    layer: "source",
    what: "each entity_type the reader declares is actually WRITTEN by a producer — derived from the constant, so removing one or adding a phantom one both fail",
    run: () => {
      const parsed = parseStringArrayConst(F.kernelListings, "LISTING_TIMELINE_ENTITY_TYPES")
      if (parsed.length < 2) return { ok: false, detail: `the reader declares only [${parsed}] — the other producer's rows stay invisible` }
      const kernelLifecycle = code(F.kernelLifecycle)
      const kernelListings = code(F.kernelListings)
      const action = code(F.action)
      const missing: string[] = []
      for (const t of parsed) {
        const writtenByStageMachine = new RegExp(`\\b${t}:\\s*\\{\\s*table:\\s*"listings"`).test(kernelLifecycle)
        const writtenDirectly =
          new RegExp(`entity_type:\\s*"${t}"`).test(kernelListings) || new RegExp(`entity_type:\\s*"${t}"`).test(action)
        if (!writtenByStageMachine && !writtenDirectly) missing.push(t)
      }
      if (missing.length) return { ok: false, detail: `no producer writes: ${missing.join(", ")}` }
      return { ok: true, detail: `${parsed.length} entity types, each with a named producer` }
    },
    breaks: [
      { file: F.kernelListings, find: `export const LISTING_TIMELINE_ENTITY_TYPES = ["listing", "listing_stage_machine"] as const`, replace: `export const LISTING_TIMELINE_ENTITY_TYPES = ["listing", "listing_stage_machine", "listing_ghost"] as const` },
      { file: F.kernelLifecycle, find: `  listing_stage_machine: { table: "listings",  stateColumn: "lifecycle_stage" },`, replace: `  listing_stage_machineX: { table: "listings",  stateColumn: "lifecycle_stage" },` },
    ],
  },
  {
    id: "d2.workspace-reads-both-spaces",
    defect: "d2",
    layer: "source",
    what: "loadListingWorkspace filters lifecycle_events with .in(entity_type, LISTING_TIMELINE_ENTITY_TYPES) — not a single .eq on one of the two",
    run: () => {
      const body = fnBody(code(F.kernelListings), "loadListingWorkspace")
      if (!body) return { ok: false, detail: "loadListingWorkspace does not exist" }
      const timeline = body.slice(body.indexOf('.from("lifecycle_events")'))
      if (!/\.from\("lifecycle_events"\)/.test(body)) return { ok: false, detail: "no lifecycle_events read" }
      if (/\.eq\(\s*["']entity_type["']/.test(timeline.slice(0, 400))) return { ok: false, detail: "still pins ONE entity_type with .eq" }
      if (!/\.in\(\s*["']entity_type["']\s*,\s*\[\s*\.\.\.LISTING_TIMELINE_ENTITY_TYPES\s*\]\s*\)/.test(timeline.slice(0, 400))) {
        return { ok: false, detail: "the filter is not derived from LISTING_TIMELINE_ENTITY_TYPES" }
      }
      return { ok: true }
    },
    breaks: [
      { file: F.kernelListings, find: `        .in("entity_type", [...LISTING_TIMELINE_ENTITY_TYPES])`, replace: `        .eq("entity_type", "listing")` },
    ],
  },
  {
    id: "d2.workspace-distinguishes-failure-from-emptiness",
    defect: "d2",
    layer: "source",
    what: "all four workspace reads check `.error`, so a refused read is a named failure instead of an empty list that reads exactly like 'no history'",
    run: () => {
      const body = fnBody(code(F.kernelListings), "loadListingWorkspace")
      if (!body) return { ok: false, detail: "loadListingWorkspace does not exist" }
      const needed = ["listingResult", "mediaResult", "tasksResult", "timelineResult"]
      const missing = needed.filter((r) => !new RegExp(`if\\s*\\(${r}\\.error\\)`).test(body))
      if (missing.length) return { ok: false, detail: `unchecked reads: ${missing.join(", ")}` }
      if (!/\.find\(\([^)]*\)\s*=>\s*\{[\s\S]*?to_state/.test(body)) {
        return { ok: false, detail: "the current-stage derivation does not look at metadata.to_state, which is the key the stage writer actually uses" }
      }
      return { ok: true }
    },
    breaks: [
      { file: F.kernelListings, find: `    if (timelineResult.error) return { success: false, error: \`Could not read the listing's history: \${timelineResult.error.message}\` }`, replace: `` },
      { file: F.kernelListings, find: `    if (mediaResult.error)    return { success: false, error: \`Could not read the listing's media: \${mediaResult.error.message}\` }`, replace: `` },
    ],
  },
  {
    id: "d2.no-unchecked-reads-left-in-the-kernel-module",
    defect: "d2",
    layer: "source",
    what: "no `await supabase.from(...)` in lib/kernel/listings.ts discards its error, and no lifecycle_events write is swallowed by `.then(() => {})`",
    run: () => {
      const src = code(F.kernelListings)
      if (/\.then\(\(\)\s*=>\s*\{\}\)/.test(src)) return { ok: false, detail: "a write outcome is still swallowed by .then(() => {})" }
      const unchecked = uncheckedSupabaseStatements(src)
      if (unchecked.length) {
        return { ok: false, detail: `${unchecked.length} unchecked: ${unchecked.map((u) => u.trim().slice(0, 90).replace(/\s+/g, " ")).join(" | ")}` }
      }
      return { ok: true, detail: `${supabaseStatements(src).length} supabase statements, all error-aware` }
    },
    breaks: [
      { file: F.kernelListings, find: `    const { data: listing, error: prefillError } = await supabase`, replace: `    const { data: listing } = await supabase` },
      { file: F.kernelListings, find: `    const { error: launchEventError } = await supabase`, replace: `    await supabase` },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // D3 — the signature chase
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: "d3.vocabulary-parsed-matches-runtime",
    defect: "d3",
    layer: "pure",
    what: "CLIENT_DOCUMENT_AWAITING_SIGNATURE_STATUSES parsed from source IS the runtime export",
    run: () => {
      const parsed = parseStringArrayConst(F.chase, "CLIENT_DOCUMENT_AWAITING_SIGNATURE_STATUSES")
      if (parsed.length === 0) return { ok: false, detail: "the constant could not be parsed" }
      if (!sameSet(parsed, CLIENT_DOCUMENT_AWAITING_SIGNATURE_STATUSES)) {
        return { ok: false, detail: `parsed [${parsed}] vs runtime [${CLIENT_DOCUMENT_AWAITING_SIGNATURE_STATUSES}]` }
      }
      return { ok: true, detail: `[${parsed.join(", ")}]` }
    },
    breaks: [
      { file: F.chase, find: `export const CLIENT_DOCUMENT_AWAITING_SIGNATURE_STATUSES = ["pending_signature"] as const`, replace: `export const CLIENT_DOCUMENT_AWAITING_SIGNATURE_STATUSES = ["pending"] as const` },
    ],
  },
  {
    id: "d3.reader-and-writers-agree",
    defect: "d3",
    layer: "source",
    what: "THE DIVERGENCE DETECTOR: the awaiting-signature spellings the WRITERS emit, scraped from their source, are exactly the set the reader filters on — neither side is a pinned literal",
    run: () => {
      const declared = new Set(parseStringArrayConst(F.chase, "CLIENT_DOCUMENT_AWAITING_SIGNATURE_STATUSES"))
      if (declared.size === 0) return { ok: false, detail: "the reader declares no vocabulary at all" }
      const written = new Set<string>()
      for (const f of [F.writerDotloop, F.writerDocIntel]) {
        for (const m of code(f).matchAll(/signature_status["']?\s*:\s*[^,;\n]*?["']([a-z_]*pending[a-z_]*)["']/g)) {
          written.add(m[1])
        }
      }
      if (written.size === 0) return { ok: false, detail: "no writer of an awaiting signature_status was found — the premise moved" }
      const readerOnly = [...declared].filter((v) => !written.has(v))
      const writerOnly = [...written].filter((v) => !declared.has(v))
      if (readerOnly.length || writerOnly.length) {
        return {
          ok: false,
          detail: `reader/writer divergence — reader-only: [${readerOnly.join(", ") || "none"}], writer-only: [${writerOnly.join(", ") || "none"}]`,
        }
      }
      return { ok: true, detail: `both sides agree on [${[...written].join(", ")}]` }
    },
    breaks: [
      { file: F.chase, find: `export const CLIENT_DOCUMENT_AWAITING_SIGNATURE_STATUSES = ["pending_signature"] as const`, replace: `export const CLIENT_DOCUMENT_AWAITING_SIGNATURE_STATUSES = ["pending"] as const` },
      { file: F.writerDocIntel, find: `.update({ signature_status: "pending_signature" })`, replace: `.update({ signature_status: "awaiting_pending_countersign" })` },
    ],
  },
  {
    id: "d3.chase-query-derives-its-filter",
    defect: "d3",
    layer: "source",
    what: "the client_documents sweep filters with .in(signature_status, CLIENT_DOCUMENT_AWAITING_SIGNATURE_STATUSES) and no longer pins .eq('signature_status', 'pending')",
    run: () => {
      const body = fnBody(code(F.chase), "runSignatureChase")
      if (!body) return { ok: false, detail: "runSignatureChase does not exist" }
      if (/\.eq\(\s*["']signature_status["']\s*,\s*["']pending["']\s*\)/.test(body)) {
        return { ok: false, detail: "the dead 'pending' filter is still there" }
      }
      if (!/\.in\(\s*["']signature_status["']\s*,\s*\[\s*\.\.\.CLIENT_DOCUMENT_AWAITING_SIGNATURE_STATUSES\s*\]\s*\)/.test(body)) {
        return { ok: false, detail: "the filter is not derived from the vocabulary constant" }
      }
      if (!/d\.signature_status/.test(body)) {
        return { ok: false, detail: "the row's own status is not passed through to the notification (a hard-coded status describes a state the row is not in)" }
      }
      return { ok: true }
    },
    breaks: [
      { file: F.chase, find: `      .in("signature_status", [...CLIENT_DOCUMENT_AWAITING_SIGNATURE_STATUSES])`, replace: `      .eq("signature_status", "pending")` },
      { file: F.chase, find: `          d.document_name ?? "document", String(d.signature_status ?? ""), d.created_at)`, replace: `          d.document_name ?? "document", "pending", d.created_at)` },
    ],
  },
  {
    id: "d3.classifier-admits-every-declared-spelling",
    defect: "d3",
    layer: "pure",
    what: "classifySignatureStall treats every value in the declared vocabulary as OPEN — a corrected query with a classifier that still rejects the spelling chases nobody",
    run: () => {
      const now = new Date("2026-07-08T12:00:00Z")
      for (const status of CLIENT_DOCUMENT_AWAITING_SIGNATURE_STATUSES) {
        const nudge = classifySignatureStall({ signature_status: status, created_at: "2026-07-05T12:00:00Z" }, now)
        const escalate = classifySignatureStall({ signature_status: status, created_at: "2026-07-03T00:00:00Z" }, now)
        const fresh = classifySignatureStall({ signature_status: status, created_at: "2026-07-08T00:00:00Z" }, now)
        if (nudge !== "nudge") return { ok: false, detail: `"${status}" at 72h classified ${nudge}, not nudge` }
        if (escalate !== "escalate") return { ok: false, detail: `"${status}" at 132h classified ${escalate}, not escalate` }
        if (fresh !== "none") return { ok: false, detail: `"${status}" at 12h classified ${fresh} — a fabricated stall` }
      }
      // The other ledger's vocabulary must not have been collateral damage.
      if (classifySignatureStall({ esign_status: "sent", sent_at: "2026-07-05T12:00:00Z" }, now) !== "nudge") {
        return { ok: false, detail: "the contract_signatures leg stopped chasing 'sent'" }
      }
      if (classifySignatureStall({ esign_status: "fully_signed", sent_at: "2026-07-01T00:00:00Z" }, now) !== "none") {
        return { ok: false, detail: "a terminal status is being chased" }
      }
      // The runtime checks above cannot see a source edit (the module is already
      // imported), so the SOURCE wiring is asserted too: OPEN_STATUSES must be
      // built from the same constant the query filters on, not list it again.
      const src = code(F.chase)
      const open = /const\s+OPEN_STATUSES\s*=\s*\[([\s\S]*?)\]\s*as\s+const/.exec(src)
      if (!open) return { ok: false, detail: "OPEN_STATUSES could not be found" }
      if (!/\.\.\.CLIENT_DOCUMENT_AWAITING_SIGNATURE_STATUSES/.test(open[1])) {
        return { ok: false, detail: "OPEN_STATUSES no longer spreads the declared vocabulary — the query and the classifier can diverge" }
      }
      if (!/"pending"/.test(open[1])) {
        return { ok: false, detail: "'pending' was dropped — it is a real contract_signatures esign_status and that leg would stop chasing" }
      }
      return { ok: true }
    },
    breaks: [
      { file: F.chase, find: `  ...CLIENT_DOCUMENT_AWAITING_SIGNATURE_STATUSES,\n] as const`, replace: `] as const` },
      { file: F.chase, find: `  "sent", "viewed", "agent_signed", "pending",`, replace: `  "sent", "viewed", "agent_signed",` },
    ],
  },
  {
    id: "d3.sweep-reads-and-writes-are-checked",
    defect: "d3",
    layer: "source",
    what: "no read or write in the sweep discards its error — a failed dedupe read would re-notify everybody daily, and a refused insert counted as a delivered nudge",
    run: () => {
      const src = code(F.chase)
      if (/\.then\(undefined,\s*\(\)\s*=>\s*\{\}\)/.test(src)) return { ok: false, detail: "the notification insert still swallows its rejection" }
      const unchecked = uncheckedSupabaseStatements(src)
      if (unchecked.length) {
        return { ok: false, detail: `${unchecked.length} unchecked: ${unchecked.map((u) => u.trim().slice(0, 90).replace(/\s+/g, " ")).join(" | ")}` }
      }
      const chaseFn = src.slice(src.indexOf("const chase = async"))
      if (!/if\s*\(!brokerageId\)/.test(chaseFn)) {
        return { ok: false, detail: "a service-role sweep writes notifications without an explicit brokerage — cross-tenant surface" }
      }
      if (!/\.eq\("brokerage_id",\s*brokerageId\)\.ilike/.test(chaseFn.replace(/\s+/g, " ").replace(/ \./g, "."))) {
        return { ok: false, detail: "the dedupe read is not brokerage-scoped" }
      }
      return { ok: true, detail: `${supabaseStatements(src).length} supabase statements, all error-aware` }
    },
    breaks: [
      { file: F.chase, find: `    const { data: dup, error: dupError } = await svc.from("notifications").select("id")`, replace: `    const { data: dup } = await svc.from("notifications").select("id")` },
      { file: F.chase, find: `    if (!brokerageId) { r.skipped += 1; return }`, replace: `    ` },
    ],
  },

  // ══════════════════════════════════════════════════════════════════════════
  // LIVE — creds-gated. Filters are built from the SOURCE-PARSED constants, so
  // these flip in the negative layer too (when creds are present).
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: "d1.live.columns-the-new-writes-use-are-real",
    defect: "d1",
    layer: "live",
    what: "live: EVERY column the gated write targets — scraped from the write payloads themselves — is a real column. Phantom columns are the defect class that makes a write a silent no-op",
    run: async () => {
      if (!LIVE.svc) return { ok: false, detail: "no live client" }
      const body = fnBody(code(F.service), "advanceListingStageService")
      if (!body) return { ok: false, detail: "advanceListingStageService does not exist" }

      /** Keys of the object literal passed to `.insert(` / `.update(` after `.from("<table>")`. */
      const payloadKeys = (table: string, verb: "insert" | "update"): string[] => {
        const re = new RegExp(`\\.from\\("${table}"\\)[\\s\\S]{0,200}?\\.${verb}\\(\\{`)
        const m = re.exec(body)
        if (!m) return []
        const open = body.indexOf("{", m.index + m[0].length - 1)
        const close = matchBrace(body, open)
        const obj = body.slice(open + 1, close)
        // Top-level keys only; spreads and nested objects are ignored.
        const keys: string[] = []
        let depth = 0
        for (const line of obj.split("\n")) {
          const km = /^\s*([a-z_][a-z0-9_]*)\s*:/.exec(line)
          if (depth === 0 && km) keys.push(km[1])
          depth += (line.match(/[[{(]/g) ?? []).length - (line.match(/[\]})]/g) ?? []).length
          if (depth < 0) depth = 0
        }
        return keys
      }

      const historyKeys = payloadKeys("listing_stage_history", "insert")
      const historyUpdateKeys = payloadKeys("listing_stage_history", "update")
      const listingKeys = payloadKeys("listings", "update")
      if (historyKeys.length === 0 || listingKeys.length === 0) {
        return { ok: false, detail: "could not scrape the write payloads — the writes changed shape" }
      }
      const checks: [string, string[]][] = [
        ["listing_stage_history", [...new Set([...historyKeys, ...historyUpdateKeys])]],
        ["listings", listingKeys],
      ]
      for (const [table, keys] of checks) {
        const r = await LIVE.svc.from(table).select(keys.join(", ")).limit(1)
        if (r.error) return { ok: false, detail: `${table}: ${r.error.message} (columns written: ${keys.join(", ")})` }
      }
      return { ok: true, detail: `${checks.map(([t, k]) => `${t}(${k.length})`).join(", ")} — every written column is real` }
    },
    breaks: [
      { file: F.service, find: `    stage_name: toStage,`, replace: `    stage_name: toStage,\n    phantom_stage_column: toStage,` },
    ],
  },
  {
    id: "d2.live.old-filter-misses-what-the-new-one-finds",
    defect: "d2",
    layer: "live",
    what: "live: seed one row per declared entity_type, then prove the OLD single-entity_type filter sees strictly fewer than the new one — and clean up to zero residue",
    run: async () => {
      const svc = LIVE.svc
      if (!svc || !LIVE.listingId || !LIVE.brokerageId) return { ok: false, detail: "no live client / no listing to hang the proof on" }
      const declared = parseStringArrayConst(F.kernelListings, "LISTING_TIMELINE_ENTITY_TYPES")
      if (declared.length < 2) return { ok: false, detail: `the reader declares only [${declared}] — the other producer stays invisible` }
      const ids = [SEED_EVENT_ID, SEED_EVENT_ID_2]
      try {
        const rows = declared.slice(0, 2).map((entityType, i) => ({
          id: ids[i],
          brokerage_id: LIVE.brokerageId,
          entity_type: entityType,
          entity_id: LIVE.listingId,
          event_type: "lifecycle.LISTING_STAGE_CHANGED",
          metadata: { from_state: "OPEN_HOUSE_MARKETING", to_state: "MLS_ACTIVE", simulator: true },
        }))
        const ins = await svc.from("lifecycle_events").insert(rows as never)
        if (ins.error) return { ok: false, detail: `seed failed: ${ins.error.message}` }

        const oldFilter = await svc.from("lifecycle_events").select("id", { count: "exact", head: true })
          .eq("entity_id", LIVE.listingId).eq("entity_type", "listing")
        const newFilter = await svc.from("lifecycle_events").select("id", { count: "exact", head: true })
          .eq("entity_id", LIVE.listingId).in("entity_type", declared)
        if (oldFilter.error || newFilter.error) {
          return { ok: false, detail: `read failed: ${oldFilter.error?.message ?? newFilter.error?.message}` }
        }
        const oldCount = oldFilter.count ?? 0
        const newCount = newFilter.count ?? 0
        if (newCount <= oldCount) {
          return { ok: false, detail: `the new filter found ${newCount}, the old one ${oldCount} — it is not reading the second entity space` }
        }
        return { ok: true, detail: `old filter ${oldCount} row(s), new filter ${newCount} — the stage-machine history was invisible` }
      } finally {
        await svc.from("lifecycle_events").delete().in("id", ids)
        const residue = await svc.from("lifecycle_events").select("id", { count: "exact", head: true }).in("id", ids)
        LIVE.notes.push(`lifecycle_events seed residue after cleanup: ${residue.count ?? "unknown"}`)
      }
    },
    breaks: [
      { file: F.kernelListings, find: `export const LISTING_TIMELINE_ENTITY_TYPES = ["listing", "listing_stage_machine"] as const`, replace: `export const LISTING_TIMELINE_ENTITY_TYPES = ["listing"] as const` },
    ],
  },
  {
    id: "d3.live.the-writers-spelling-is-the-one-that-matches",
    defect: "d3",
    layer: "live",
    what: "live: seed a client_documents row with the spelling the WRITERS use, then prove the old 'pending' filter finds nothing and the declared filter finds it — and clean up to zero residue",
    run: async () => {
      const svc = LIVE.svc
      if (!svc || !LIVE.brokerageId) return { ok: false, detail: "no live client / no brokerage" }
      const declared = parseStringArrayConst(F.chase, "CLIENT_DOCUMENT_AWAITING_SIGNATURE_STATUSES")
      if (declared.length === 0) return { ok: false, detail: "no declared vocabulary" }
      // The spelling the writers emit, scraped from the writers — not pinned here.
      const written = new Set<string>()
      for (const f of [F.writerDotloop, F.writerDocIntel]) {
        for (const m of code(f).matchAll(/signature_status["']?\s*:\s*[^,;\n]*?["']([a-z_]*pending[a-z_]*)["']/g)) written.add(m[1])
      }
      const seedStatus = [...written][0]
      if (!seedStatus) return { ok: false, detail: "could not scrape a writer spelling" }
      try {
        const ins = await svc.from("client_documents").insert({
          id: SEED_DOC_ID,
          brokerage_id: LIVE.brokerageId,
          document_name: "Listing Agreement (simulator)",
          document_url: "https://example.invalid/simulator.pdf",
          signature_status: seedStatus,
          created_at: new Date(Date.now() - 5 * 86_400_000).toISOString(),
        } as never)
        if (ins.error) return { ok: false, detail: `seed failed: ${ins.error.message}` }

        const oldFilter = await svc.from("client_documents").select("id", { count: "exact", head: true })
          .eq("id", SEED_DOC_ID).eq("signature_status", "pending")
        const newFilter = await svc.from("client_documents").select("id", { count: "exact", head: true })
          .eq("id", SEED_DOC_ID).in("signature_status", declared)
        if (oldFilter.error || newFilter.error) {
          return { ok: false, detail: `read failed: ${oldFilter.error?.message ?? newFilter.error?.message}` }
        }
        if ((oldFilter.count ?? 0) !== 0) {
          return { ok: false, detail: `the old 'pending' filter matched ${oldFilter.count} — the premise moved, re-read the writers` }
        }
        if ((newFilter.count ?? 0) !== 1) {
          return { ok: false, detail: `the declared filter matched ${newFilter.count}, not the seeded row written as "${seedStatus}"` }
        }
        return { ok: true, detail: `row written as "${seedStatus}": old filter 0, declared filter 1` }
      } finally {
        await svc.from("client_documents").delete().eq("id", SEED_DOC_ID)
        const residue = await svc.from("client_documents").select("id", { count: "exact", head: true }).eq("id", SEED_DOC_ID)
        LIVE.notes.push(`client_documents seed residue after cleanup: ${residue.count ?? "unknown"}`)
      }
    },
    breaks: [
      { file: F.chase, find: `export const CLIENT_DOCUMENT_AWAITING_SIGNATURE_STATUSES = ["pending_signature"] as const`, replace: `export const CLIENT_DOCUMENT_AWAITING_SIGNATURE_STATUSES = ["pending"] as const` },
    ],
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// RUNNER
// ─────────────────────────────────────────────────────────────────────────────

async function runOne(a: Assertion): Promise<Outcome> {
  try {
    return await a.run()
  } catch (e) {
    return { ok: false, detail: `threw: ${e instanceof Error ? e.message : String(e)}` }
  }
}

async function openLive(): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) {
    LIVE.notes.push("no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in the environment")
    return false
  }
  const svc = createClient(url, key, { auth: { persistSession: false } })
  const probe = await svc.from("listings").select("id, brokerage_id").not("brokerage_id", "is", null).limit(1)
  if (probe.error) {
    LIVE.notes.push(`database unreachable or refused: ${probe.error.message}`)
    return false
  }
  const row = (probe.data ?? [])[0] as { id?: string; brokerage_id?: string } | undefined
  if (!row?.id || !row?.brokerage_id) {
    LIVE.notes.push("no listing with a brokerage to hang the seeded proof on")
    return false
  }
  LIVE = { svc: svc as never, listingId: row.id, brokerageId: row.brokerage_id, notes: LIVE.notes }
  LIVE.notes.push(`connected; anchor listing ${row.id}`)
  return true
}

async function main() {
  const selected = assertions.filter((a) => ONLY.length === 0 || ONLY.includes(a.defect))

  console.log("══════════════════════════════════════════════════════════════════════")
  console.log(" LIFECYCLE LIB DEFECTS — a gate that gated nothing, a reader in the")
  console.log(" wrong entity space, and a chase leg that matched nothing")
  console.log("══════════════════════════════════════════════════════════════════════")

  const liveReady = await openLive()

  let pass = 0
  let fail = 0
  let liveSkipped = 0
  const failures: string[] = []
  const results = new Map<string, Outcome>()

  for (const layer of ["source", "pure", "live"] as const) {
    const group = selected.filter((a) => a.layer === layer)
    if (group.length === 0) continue
    console.log(`\n─── ${layer.toUpperCase()} ${"─".repeat(62 - layer.length)}`)
    if (layer === "live" && !liveReady) {
      console.log(`  ⊘ SKIPPED LOUDLY — ${LIVE.notes.join("; ")}`)
      console.log("    A network error is NOT a pass. The source and pure layers proved the")
      console.log("    code's contract; they did not prove the database agrees. Re-run with")
      console.log("    service credentials to close that gap.")
      liveSkipped = group.length
      continue
    }
    for (const a of group) {
      const r = await runOne(a)
      results.set(a.id, r)
      if (r.ok) { pass++; console.log(`  ✔ ${a.id}\n      ${a.what}${r.detail ? `\n      → ${r.detail}` : ""}`) }
      else { fail++; failures.push(`${a.id}: ${r.detail ?? ""}`); console.log(`  ✘ ${a.id}\n      ${a.what}\n      → ${r.detail ?? ""}`) }
    }
  }

  let negPass = 0
  let negFail = 0
  let negSkip = 0
  const negProblems: string[] = []

  if (RUN_NEGATIVE) {
    console.log(`\n─── NEGATIVE (every assertion is broken on purpose) ${"─".repeat(18)}`)
    for (const a of selected) {
      if (a.layer === "live" && !liveReady) {
        negSkip += a.breaks.length || 1
        console.log(`  ⊘ ${a.id}  negative test skipped — its layer did not run (no creds)`)
        continue
      }
      if (a.breaks.length === 0) {
        // An assertion nobody can break is not testing anything. The only ones
        // allowed here are pure schema-existence probes, and they are called out.
        negFail++
        negProblems.push(`${a.id}: has NO negative test`)
        console.log(`  ✘ ${a.id}  no negative test defined`)
        continue
      }
      for (let bi = 0; bi < a.breaks.length; bi++) {
        const b = a.breaks[bi]
        const path = resolve(ROOT, b.file)
        const before = readFileSync(path, "utf8")
        const digestBefore = createHash("sha256").update(before).digest("hex")
        const after = before.replace(b.find as never, b.replace)

        // THEATRE DETECTOR — a replace that matched nothing leaves the file
        // untouched, and the assertion would "fail to fail" for the wrong reason.
        if (after === before) {
          negFail++
          negProblems.push(`${a.id}[${bi}]: the mutation DID NOT APPLY (find string no longer matches ${b.file})`)
          console.log(`  ✘ ${a.id}[${bi}]  mutation did not apply — the negative test is theatre, fix the find string`)
          continue
        }

        writeFileSync(path, after, "utf8")
        let broke = false
        let detail = ""
        try {
          const r = await runOne(a)
          broke = !r.ok
          detail = r.detail ?? ""
        } finally {
          writeFileSync(path, before, "utf8")
        }
        const restored = createHash("sha256").update(readFileSync(path)).digest("hex") === digestBefore

        if (broke && restored) {
          negPass++
          console.log(`  ✔ ${a.id}[${bi}]  broke as expected, file restored (sha256 verified)`)
        } else {
          negFail++
          if (!broke) negProblems.push(`${a.id}[${bi}]: still PASSED with the defect reintroduced — it is not testing anything`)
          if (!restored) negProblems.push(`${a.id}[${bi}]: FILE NOT RESTORED (${b.file})`)
          console.log(`  ✘ ${a.id}[${bi}]  ${!broke ? "did NOT flip to failure" : ""}${!restored ? " FILE NOT RESTORED" : ""}${detail ? ` (${detail})` : ""}`)
        }
      }
    }
  }

  console.log(`\n${"═".repeat(70)}`)
  console.log(` SOURCE + PURE + LIVE   ${pass} passed, ${fail} failed${liveSkipped ? `, ${liveSkipped} live SKIPPED` : ""}`)
  if (RUN_NEGATIVE) console.log(` NEGATIVE               ${negPass} flipped to failure as required, ${negFail} did not${negSkip ? `, ${negSkip} skipped` : ""}`)
  if (LIVE.notes.length) console.log(` LIVE NOTES             ${LIVE.notes.join(" | ")}`)
  console.log("═".repeat(70))

  if (failures.length) {
    console.log("\nFailures:")
    for (const f of failures) console.log(`  · ${f}`)
  }
  if (negProblems.length) {
    console.log("\nNegative-layer problems:")
    for (const f of negProblems) console.log(`  · ${f}`)
  }

  if (fail > 0 || negFail > 0) {
    console.log("\nWhat is at stake: the pre-gate is the ONLY enforcement of listing stage")
    console.log("order anywhere — transitionLifecycle writes the state column")
    console.log("unconditionally. A workspace that reads one entity space shows an empty")
    console.log("history for every listing, and a chase leg that matches nothing means")
    console.log("nobody is ever chased for a signature they owe.")
    process.exit(1)
  }
  console.log("✅ LIFECYCLE_LIB_DEFECTS_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
