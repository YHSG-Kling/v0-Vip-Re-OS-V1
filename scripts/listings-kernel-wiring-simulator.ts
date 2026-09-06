#!/usr/bin/env tsx
/**
 * scripts/listings-kernel-wiring-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proof harness for the LISTINGS KERNEL wiring pass.
 *
 * What it proves, in three layers:
 *
 *   LAYER 1 — STATIC CONSTRUCTS, over COMMENT-STRIPPED source.
 *     Comments are removed before any scan, so no assertion can be satisfied by
 *     prose describing the fix. Every assertion targets a CONSTRUCT (a resolved
 *     call, a parsed object's keys, a destructuring shape, an intersection of
 *     two lists) rather than a spelling.
 *
 *   LAYER 2 — LIVE DATABASE, creds-gated. SKIPS LOUDLY when the DB is
 *     unreachable rather than scoring a network error as a pass. Verifies the
 *     column and CHECK vocabularies the static layer asserts against, empirically.
 *     All test rows are tagged, deleted, and the residue re-counted to zero.
 *
 *   LAYER 3 — NEGATIVE TESTS. For EVERY layer-1 assertion: mutate the real source
 *     on disk, ASSERT THE MUTATION ACTUALLY APPLIED (a replace that silently
 *     no-ops would make the whole suite theatre), re-run that one assertion and
 *     require it to FLIP to failure, restore the file, and verify the restore by
 *     sha256 against the pre-mutation digest.
 *
 * Run:  npx tsx scripts/listings-kernel-wiring-simulator.ts
 */

import { readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { resolve, join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { blankComments } from "./strip-comments"

const HERE = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "..")

// ─────────────────────────────────────────────────────────────────────────────
// Files under test
// ─────────────────────────────────────────────────────────────────────────────

const F = {
  CORE:     "app/actions/listing-lifecycle-core.ts",
  KERNEL:   "app/actions/listings-kernel.ts",
  COMPOSER: "app/components/dashboard/listings/lifecycle/listing-description-composer.tsx",
  GATES:    "app/components/dashboard/listings/lifecycle/listing-gates-panel.tsx",
  PIPELINE: "app/components/dashboard/listings/lifecycle/stage-pipeline.tsx",
  FORMS:    "app/components/dashboard/listings/lifecycle/listing-forms-panel.tsx",
  INTEL:    "app/components/dashboard/listings/lifecycle/listing-intelligence-card.tsx",
  DEFS:     "lib/listing-lifecycle/lifecycle-definitions.ts",
} as const

type FileKey = keyof typeof F

const SURFACE_KEYS: FileKey[] = ["COMPOSER", "GATES", "PIPELINE", "FORMS", "INTEL"]

// ─────────────────────────────────────────────────────────────────────────────
// Comment stripper — the whole suite reads through this
// ─────────────────────────────────────────────────────────────────────────────

// hand-rolled scanner replaced (finding #250): it could not see nested `${…}` templates, regex literals, or an apostrophe in JSX text, and went blind on the code it judges.
const stripComments = blankComments

function readRaw(key: FileKey): string {
  return readFileSync(join(ROOT, F[key]), "utf8")
}

type Sources = Record<FileKey, string>

function loadSources(): Sources {
  const s = {} as Sources
  for (const k of Object.keys(F) as FileKey[]) s[k] = stripComments(readRaw(k))
  return s
}

function sha256(key: FileKey): string {
  return createHash("sha256").update(readRaw(key)).digest("hex")
}

// ─────────────────────────────────────────────────────────────────────────────
// Small parsing helpers — construct extraction, not spelling matching
// ─────────────────────────────────────────────────────────────────────────────

/** Count call sites of `name(` that are not the `function name(` declaration. */
function countCalls(src: string, name: string): number {
  const all = src.match(new RegExp(`\\b${name}\\s*\\(`, "g"))?.length ?? 0
  const decls = src.match(new RegExp(`function\\s+${name}\\s*\\(`, "g"))?.length ?? 0
  return all - decls
}

/** Extract the balanced {...} body that follows `anchor` in src. */
function balancedBlock(src: string, anchor: string, open = "{", close = "}"): string | null {
  const at = src.indexOf(anchor)
  if (at === -1) return null
  const start = src.indexOf(open, at)
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < src.length; i++) {
    if (src[i] === open) depth++
    else if (src[i] === close) {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return null
}

/** Extract the balanced body of `export async function name(` including params. */
function functionBody(src: string, name: string): string | null {
  const re = new RegExp(`(export\\s+)?async\\s+function\\s+${name}\\s*\\(`)
  const m = re.exec(src)
  if (!m) return null
  // find the `{` that opens the body: after the parameter list closes
  let i = m.index + m[0].length - 1
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === "(") depth++
    else if (src[i] === ")") { depth--; if (depth === 0) { i++; break } }
  }
  const bodyStart = src.indexOf("{", i)
  if (bodyStart === -1) return null
  depth = 0
  for (let j = bodyStart; j < src.length; j++) {
    if (src[j] === "{") depth++
    else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(bodyStart, j + 1) }
  }
  return null
}

/** All double/single-quoted string literals inside a snippet. */
function stringLiterals(snippet: string): string[] {
  return (snippet.match(/["']([A-Za-z0-9_]+)["']/g) ?? []).map((s) => s.slice(1, -1))
}

/** The canonical ListingStage union, read from the definitions module. */
function listingStageUnion(defsSrc: string): Set<string> {
  const at = defsSrc.indexOf("export type ListingStage")
  if (at === -1) return new Set()
  const end = defsSrc.indexOf("export type", at + 10)
  const block = defsSrc.slice(at, end === -1 ? at + 4000 : end)
  return new Set(stringLiterals(block))
}

/**
 * Every `const { ... } = await <supabase query>` destructuring in src, returned
 * as the raw brace group. Brace-balanced so nested patterns like
 * `const { data: { user }, error } = await ...` are captured whole.
 *
 * DELIBERATELY EXCLUDES `await import(...)` — a dynamic module import is a
 * destructuring of an ES namespace object and has no `error` channel. Including
 * it would make the check unsatisfiable and therefore meaningless.
 *
 * A query is recognised by its RHS: `supabase`/`svc`/`query` receivers, or any
 * chain containing `.from(` or `.auth.` — i.e. the things that RESOLVE on
 * failure instead of throwing, which is the entire hazard being tested.
 */
function awaitDestructurings(src: string): string[] {
  const out: string[] = []
  const re = /const\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const open = src.indexOf("{", m.index)
    let depth = 0
    let close = -1
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++
      else if (src[i] === "}") { depth--; if (depth === 0) { close = i; break } }
    }
    if (close === -1) continue
    const after = src.slice(close + 1, close + 40)
    if (!/^\s*=\s*await\b/.test(after)) continue

    // The RHS expression, up to the end of the statement.
    const rhsStart = src.indexOf("await", close)
    const rhs = src.slice(rhsStart, rhsStart + 400)
    if (/^await\s+import\s*\(/.test(rhs)) continue                 // module import
    const isQuery =
      /^await\s+(supabase|svc|query)\b/.test(rhs) ||
      /^await\s+[A-Za-z_$][\w$]*\s*\n?\s*\.\s*(from|auth)\b/.test(rhs) ||
      /^await\s+[^;]{0,300}?\.\s*from\s*\(/.test(rhs)
    if (!isQuery) continue

    out.push(src.slice(open, close + 1))
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// The action inventory
// ─────────────────────────────────────────────────────────────────────────────

/** The seven orphans this pass WIRED, and the module each is imported from. */
const WIRED: Array<{ action: string; module: string }> = [
  { action: "generateListingDescriptionAction", module: "listings-kernel" },
  { action: "saveListingDraftAction",           module: "listings-kernel" },
  { action: "prefillListingFormAction",         module: "listings-kernel" },
  { action: "getListingNextStages",             module: "listing-lifecycle-core" },
  { action: "getEnabledGates",                  module: "listing-lifecycle-core" },
  { action: "checkSystemGate",                  module: "listing-lifecycle-core" },
  { action: "getLifecycleStages",               module: "listing-lifecycle-core" },
  { action: "getListingLifecycleHistory",       module: "listing-lifecycle-core" },
]

/** Actions deliberately left unwired — they must still EXIST (never deleted).
 *
 * attachMediaAction and createTransactionFromOfferAction are NOT in this list
 * any more: both were deleted under the owner's merge-then-delete ruling, each
 * with a named, wired, strictly-more-complete survivor —
 * app/actions/listing-media.ts:uploadListingMedia and
 * lib/transactions/offer-bridge.ts:createTransactionFromOffer respectively
 * (see the tombstone notes in listings-kernel.ts). That is a collapse into a
 * duplicate, not a capability loss. */
const PRESERVED = [
  "closeListingAction",
  "updateListingStageAction",
  "loadListingWorkspaceAction",
]

/** The columns saveListingDraftAction is allowed to write. */
function editableFields(kernelSrc: string): string[] {
  const block = balancedBlock(kernelSrc, "EDITABLE_LISTING_FIELDS", "[", "]")
  return block ? stringLiterals(block) : []
}

// Columns that must NEVER be hand-editable through the draft action.
const FORBIDDEN_EDITABLE = [
  "mls_number", "mls_link", "status", "lifecycle_stage",
  "brokerage_id", "agent_id", "seller_contact_id", "id", "listing_date",
]

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 1 — assertions
// ─────────────────────────────────────────────────────────────────────────────

type Assertion = {
  id: string
  name: string
  run: (S: Sources) => boolean
  detail?: (S: Sources) => string
}

const ASSERTIONS: Assertion[] = [
  {
    id: "A01",
    name: "current stage is resolved from listings.lifecycle_stage",
    run: (S) => {
      const body = functionBody(S.CORE, "resolveCurrentStage")
      if (!body) return false
      // Construct: a read of the `listings` table whose projection includes the
      // lifecycle_stage column.
      const from = /\.from\(\s*["']listings["']\s*\)/.test(body)
      const sel = /\.select\(\s*["'][^"']*lifecycle_stage[^"']*["']\s*\)/.test(body)
      return from && sel
    },
    detail: (S) => (functionBody(S.CORE, "resolveCurrentStage") ? "resolver present but not reading lifecycle_stage" : "resolveCurrentStage not defined"),
  },
  {
    id: "A02",
    name: "every stage-dependent action routes through the resolver",
    run: (S) => countCalls(S.CORE, "resolveCurrentStage") >= 6,
    detail: (S) => `call sites = ${countCalls(S.CORE, "resolveCurrentStage")} (need >= 6)`,
  },
  {
    id: "A03",
    name: "the writer-less activities stage probe is no longer used",
    run: (S) => !/\bgetCurrentLifecycleStage\b/.test(S.CORE),
    detail: () => "getCurrentLifecycleStage still referenced in listing-lifecycle-core",
  },
  {
    id: "A04",
    name: "role map covers the live user_type vocabulary (broker_owner, superadmin)",
    run: (S) => {
      const block = balancedBlock(S.CORE, "USER_TYPE_TO_LIFECYCLE_ROLE")
      if (!block) return false
      const pairs = new Map<string, string>()
      for (const m of block.matchAll(/([A-Za-z_]+)\s*:\s*["']([a-z_]+)["']/g)) pairs.set(m[1], m[2])
      return (
        pairs.get("broker_owner") === "broker" &&
        pairs.get("superadmin") === "admin" &&
        pairs.get("agent") === "agent" &&
        pairs.get("team_lead") === "team_lead" &&
        pairs.get("broker") === "broker" &&
        pairs.get("admin") === "admin"
      )
    },
    detail: (S) => {
      const block = balancedBlock(S.CORE, "USER_TYPE_TO_LIFECYCLE_ROLE")
      return block ? `map = ${block.replace(/\s+/g, " ").slice(0, 160)}` : "map not found"
    },
  },
  {
    id: "A05",
    name: "STAGE_TO_EVENT keys are all real ListingStage values (dead vocab gone)",
    run: (S) => {
      const union = listingStageUnion(S.DEFS)
      const block = balancedBlock(S.CORE, "STAGE_TO_EVENT")
      if (!block || union.size === 0) return false
      const keys = [...block.matchAll(/^\s*([A-Z_]+)\s*:/gm)].map((m) => m[1])
      if (keys.length === 0) return false
      // Every key must be a real stage, AND the go-live event must be reachable.
      return keys.every((k) => union.has(k)) && keys.includes("MLS_ACTIVE")
    },
    detail: (S) => {
      const union = listingStageUnion(S.DEFS)
      const block = balancedBlock(S.CORE, "STAGE_TO_EVENT") ?? ""
      const keys = [...block.matchAll(/^\s*([A-Z_]+)\s*:/gm)].map((m) => m[1])
      const bad = keys.filter((k) => !union.has(k))
      return bad.length ? `phantom stage keys: ${bad.join(", ")}` : `keys = ${keys.join(", ")}`
    },
  },
  {
    id: "A06",
    name: "LAUNCH_STAGES contains only real ListingStage values",
    run: (S) => {
      const union = listingStageUnion(S.DEFS)
      const block = balancedBlock(S.CORE, "LAUNCH_STAGES", "[", "]")
      if (!block || union.size === 0) return false
      const vals = stringLiterals(block)
      return vals.length > 0 && vals.every((v) => union.has(v))
    },
    detail: (S) => {
      const union = listingStageUnion(S.DEFS)
      const block = balancedBlock(S.CORE, "LAUNCH_STAGES", "[", "]") ?? ""
      const bad = stringLiterals(block).filter((v) => !union.has(v))
      return bad.length ? `phantom stages: ${bad.join(", ")}` : `values = ${stringLiterals(block).join(", ")}`
    },
  },
  {
    id: "A07",
    name: "agents.id is resolved to users.id before any agentUserId dispatch",
    run: (S) => {
      // Construct: the identity helper is actually CALLED (an import alone proves
      // nothing), and no agentUserId is assigned straight off a .agent_id field.
      const called = countCalls(S.CORE, "resolveAgentRecordToUserId") >= 1
      const substituted = /agentUserId\s*=\s*[^\n]*\.agent_id/.test(S.CORE)
      return called && !substituted
    },
    detail: (S) =>
      countCalls(S.CORE, "resolveAgentRecordToUserId") < 1
        ? "resolveAgentRecordToUserId is never called"
        : "an agentUserId is assigned directly from .agent_id",
  },
  {
    id: "A08",
    name: "every awaited supabase destructuring binds `error`",
    run: (S) => {
      for (const key of ["CORE", "KERNEL"] as FileKey[]) {
        for (const g of awaitDestructurings(S[key])) {
          if (!/\berror\b/.test(g)) return false
        }
      }
      return true
    },
    detail: (S) => {
      const bad: string[] = []
      for (const key of ["CORE", "KERNEL"] as FileKey[]) {
        for (const g of awaitDestructurings(S[key])) {
          if (!/\berror\b/.test(g)) bad.push(`${F[key]}: ${g.replace(/\s+/g, " ")}`)
        }
      }
      return bad.length ? bad.join(" | ") : "all bind error"
    },
  },
  {
    id: "A09",
    name: "listing-scoped actions carry an explicit brokerage anchor",
    run: (S) => {
      const fns = [
        "saveListingDraftAction",
        "generateListingDescriptionAction",
        "prefillListingFormAction",
        "loadListingWorkspaceAction",
      ]
      return fns.every((fn) => {
        const body = functionBody(S.KERNEL, fn)
        return !!body && /\.eq\(\s*["']brokerage_id["']/.test(body)
      })
    },
    detail: (S) => {
      const missing = [
        "saveListingDraftAction",
        "generateListingDescriptionAction",
        "prefillListingFormAction",
        "loadListingWorkspaceAction",
      ].filter((fn) => {
        const body = functionBody(S.KERNEL, fn)
        return !body || !/\.eq\(\s*["']brokerage_id["']/.test(body)
      })
      return missing.length ? `unanchored: ${missing.join(", ")}` : "all anchored"
    },
  },
  {
    id: "A10",
    name: "editable-field allow-list admits public_remarks and excludes owned columns",
    run: (S) => {
      const fields = editableFields(S.KERNEL)
      if (fields.length === 0) return false
      return fields.includes("public_remarks") && FORBIDDEN_EDITABLE.every((f) => !fields.includes(f))
    },
    detail: (S) => {
      const fields = editableFields(S.KERNEL)
      const leaked = FORBIDDEN_EDITABLE.filter((f) => fields.includes(f))
      if (leaked.length) return `allow-list leaks owned columns: ${leaked.join(", ")}`
      return fields.includes("public_remarks") ? `fields = ${fields.length}` : "public_remarks missing"
    },
  },
  {
    id: "A11",
    name: "the allow-list is enforced against incoming keys, not merely declared",
    run: (S) => {
      const body = functionBody(S.KERNEL, "saveListingDraftAction")
      if (!body) return false
      // Construct: the incoming keys are tested for membership in the allow-list.
      return /EDITABLE_LISTING_FIELDS[\s\S]{0,80}?\.includes\s*\(/.test(body)
    },
    detail: () => "saveListingDraftAction does not test incoming keys against EDITABLE_LISTING_FIELDS",
  },
  {
    id: "A12",
    name: "every wired action is imported AND invoked on a listing surface",
    run: (S) =>
      WIRED.every(({ action, module }) =>
        SURFACE_KEYS.some((k) => {
          const src = S[k]
          const imported = new RegExp(
            `import\\s*\\{[^}]*\\b${action}\\b[^}]*\\}\\s*from\\s*["'][^"']*${module}["']`,
          ).test(src)
          return imported && countCalls(src, action) >= 1
        }),
      ),
    detail: (S) => {
      const missing = WIRED.filter(
        ({ action, module }) =>
          !SURFACE_KEYS.some((k) => {
            const src = S[k]
            const imported = new RegExp(
              `import\\s*\\{[^}]*\\b${action}\\b[^}]*\\}\\s*from\\s*["'][^"']*${module}["']`,
            ).test(src)
            return imported && countCalls(src, action) >= 1
          }),
      ).map((w) => w.action)
      return missing.length ? `unwired: ${missing.join(", ")}` : "all wired"
    },
  },
  {
    id: "A13",
    name: "the composer reports the SERVER's verdict on a save",
    run: (S) => {
      const body = balancedBlock(S.COMPOSER, "function save(")
      if (!body) return false
      // Construct: the success flag is tested, and the failure branch returns
      // BEFORE anything marks the save as done.
      const guards = /if\s*\(\s*!\s*res\.success\s*\)/.test(body)
      const marksSaved = /setSaved\s*\(\s*true\s*\)/.test(body)
      if (!guards || !marksSaved) return false
      const guardAt = body.search(/if\s*\(\s*!\s*res\.success\s*\)/)
      const savedAt = body.search(/setSaved\s*\(\s*true\s*\)/)
      return guardAt !== -1 && savedAt !== -1 && guardAt < savedAt
    },
    detail: () => "save() marks success without first testing res.success",
  },
  {
    id: "A14",
    name: "the pipeline gates clicks on structure ∩ authority",
    run: (S) => {
      const src = S.PIPELINE
      // Construct: an intersection is computed from BOTH lists ...
      const intersects =
        /effectiveNextStages\s*=[\s\S]{0,300}?validNextStages\s*\.\s*filter\s*\([\s\S]{0,120}?authorizedNextStages/.test(src)
      // ... and it is what actually gates the UI (both the click handler and the
      // per-row enabled flag), not the unfiltered page-supplied list.
      const clickGated = /function\s+handleStageClick[\s\S]{0,200}?effectiveNextStages\s*\.\s*includes/.test(src)
      const rowGated = /isValidNext\s*=\s*effectiveNextStages\s*\.\s*includes/.test(src)
      return intersects && clickGated && rowGated
    },
    detail: (S) => {
      const src = S.PIPELINE
      const bits = [
        /effectiveNextStages\s*=[\s\S]{0,300}?validNextStages\s*\.\s*filter\s*\([\s\S]{0,120}?authorizedNextStages/.test(src) ? null : "no intersection",
        /function\s+handleStageClick[\s\S]{0,200}?effectiveNextStages\s*\.\s*includes/.test(src) ? null : "click handler ungated",
        /isValidNext\s*=\s*effectiveNextStages\s*\.\s*includes/.test(src) ? null : "row flag ungated",
      ].filter(Boolean)
      return bits.join(", ") || "gated"
    },
  },
  {
    id: "A15",
    name: "a failed gate read renders as UNKNOWN, never as closed",
    run: (S) => {
      const src = S.GATES
      // Construct: the failure branch sets the gate list to null (the unknown
      // sentinel), and the renderer has a distinct three-way branch on null.
      const nullsOnError = /if\s*\(\s*!\s*g\.success\s*\)[\s\S]{0,240}?setEnabled\s*\(\s*null\s*\)/.test(src)
      const threeWay = /isOpen\s*===\s*null/.test(src)
      const derivesNull = /isOpen\s*=\s*enabled\s*===\s*null\s*\?\s*null/.test(src)
      return nullsOnError && threeWay && derivesNull
    },
    detail: () => "a failed getEnabledGates read collapses to an empty (i.e. all-closed) gate list",
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 3 — one mutation per assertion
// ─────────────────────────────────────────────────────────────────────────────

type Mutation = {
  assertionId: string
  file: FileKey
  find: string
  replace: string
  /** Replace only the Nth occurrence (0-based). Default: all occurrences. */
  occurrence?: number
  /** Append instead of replace. */
  append?: string
}

const MUTATIONS: Mutation[] = [
  { assertionId: "A01", file: "CORE", find: `.select("lifecycle_stage, brokerage_id, agent_id")`, replace: `.select("brokerage_id, agent_id")` },
  { assertionId: "A02", file: "CORE", find: `await resolveCurrentStage(`, replace: `await __noResolver(` },
  { assertionId: "A03", file: "CORE", find: "", replace: "", append: "\nasync function __deadProbe(s: unknown, l: string) { return getCurrentLifecycleStage(s as never, l) }\n" },
  { assertionId: "A04", file: "CORE", find: `  broker_owner: "broker",`, replace: `` },
  { assertionId: "A05", file: "CORE", find: `      MLS_ACTIVE:         KernelEvent.LISTING_PUBLISHED,`, replace: `      ACTIVE:             KernelEvent.LISTING_PUBLISHED,` },
  { assertionId: "A06", file: "CORE", find: `["MLS_ACTIVE", "COMING_SOON_ACTIVE"]`, replace: `["MLS_ACTIVE", "COMING_SOON_ACTIVE", "PUBLISHED"]` },
  { assertionId: "A07", file: "CORE", find: `await resolveAgentRecordToUserId(listingAgentRecordId)`, replace: `listingAgentRecordId` },
  { assertionId: "A08", file: "KERNEL", find: `const { data: owned, error: ownedError } = await supabase`, replace: `const { data: owned } = await supabase` },
  { assertionId: "A09", file: "KERNEL", find: `    .eq("brokerage_id", ctx.brokerageId)\n    .maybeSingle()`, replace: `    .maybeSingle()` },
  { assertionId: "A10", file: "KERNEL", find: `  "public_remarks", "showing_instructions",`, replace: `  "public_remarks", "showing_instructions", "mls_number",` },
  { assertionId: "A11", file: "KERNEL", find: `if ((EDITABLE_LISTING_FIELDS as readonly string[]).includes(key)) {`, replace: `if (key.length > 0) {` },
  { assertionId: "A12", file: "COMPOSER", find: `await generateListingDescriptionAction({ listingId, style })`, replace: `await Promise.resolve({ success: true, description: "" })` },
  { assertionId: "A13", file: "COMPOSER", find: `        if (!res.success) {`, replace: `        if (res === undefined) {` },
  { assertionId: "A14", file: "PIPELINE", find: `          const isValidNext = effectiveNextStages.includes(stage.stage)`, replace: `          const isValidNext = validNextStages.includes(stage.stage)` },
  { assertionId: "A15", file: "GATES", find: `          setEnabled(null)`, replace: `          setEnabled([])` },
]

// ─────────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(name + (detail ? ` — ${detail}` : ""))
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

function runLayer1() {
  console.log("\n[Layer 1 · static constructs, comment-stripped]")

  // Sanity: the stripper must actually be doing work, or every assertion below
  // could be satisfied by a doc-block.
  const rawCore = readRaw("CORE")
  const strippedCore = stripComments(rawCore)
  check(
    "comment stripper removes prose (a claim in a comment cannot satisfy a check)",
    rawCore.includes("THE ROLE VOCABULARY GAP") && !strippedCore.includes("THE ROLE VOCABULARY GAP"),
    "stripper did not remove a known doc-block phrase",
  )

  const S = loadSources()

  check(
    "ListingStage union parsed from the definitions module",
    listingStageUnion(S.DEFS).size >= 30,
    `parsed ${listingStageUnion(S.DEFS).size} stages`,
  )

  for (const a of ASSERTIONS) {
    const ok = a.run(S)
    check(`${a.id} ${a.name}`, ok, ok ? undefined : a.detail?.(S))
  }

  console.log("\n[Layer 1b · unwired capabilities are PRESERVED, not deleted]")
  const both = S.KERNEL
  for (const fn of PRESERVED) {
    check(
      `${fn} still exported (an unwired capability is work to finish, never to remove)`,
      new RegExp(`export\\s+async\\s+function\\s+${fn}\\s*\\(`).test(both),
      "capability missing from listings-kernel.ts",
    )
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 2 — live database
// ─────────────────────────────────────────────────────────────────────────────

async function runLayer2() {
  console.log("\n[Layer 2 · live database]")

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const keyPresent = !!process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !keyPresent) {
    console.log("  ⏭  SKIPPED LOUDLY — SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL and")
    console.log("     SUPABASE_SERVICE_ROLE_KEY are not both set, so the live vocabulary")
    console.log("     checks did NOT run. This is a SKIP, not a pass: nothing below was")
    console.log("     verified against the database.")
    return { skipped: true as const }
  }

  let svc: any
  try {
    const mod = await import("../lib/supabase/service")
    svc = mod.createServiceClient()
  } catch (e) {
    console.log(`  ⏭  SKIPPED LOUDLY — service client unavailable: ${(e as Error).message}`)
    return { skipped: true as const }
  }

  // Reachability probe. A network failure must SKIP, never score as a pass.
  const probe = await svc.from("listings").select("id").limit(1)
  if (probe.error && /fetch|network|ENOTFOUND|ECONNREFUSED|timeout/i.test(probe.error.message)) {
    console.log(`  ⏭  SKIPPED LOUDLY — database unreachable: ${probe.error.message}`)
    return { skipped: true as const }
  }
  if (probe.error) {
    check("database reachable", false, probe.error.message)
    return { skipped: false as const }
  }
  check("database reachable", true)

  const S = loadSources()
  const TAG = `__lkwsim_${Date.now()}__`
  const createdListingIds: string[] = []

  try {
    // ── L1: every allow-listed column really exists on `listings` ────────────
    const fields = editableFields(S.KERNEL)
    const sel = await svc.from("listings").select(["id", "lifecycle_stage", ...fields].join(",")).limit(1)
    check(
      `all ${fields.length} allow-listed columns exist on listings (no phantom columns)`,
      !sel.error,
      sel.error?.message,
    )

    // ── L2: the ListingStage union in source == the live CHECK vocabulary ────
    // Probed empirically: a phantom stage the OLD code used must be REJECTED,
    // and a real one ACCEPTED.
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
    if (!brk) {
      console.log("  ⏭  stage-vocabulary probe skipped — no brokerage row to scope test data to.")
    } else {
      const mk = (stage: string) => ({
        address: `${TAG} ${stage}`,
        brokerage_id: (brk as any).id,
        lifecycle_stage: stage,
        status: "draft",
      })

      const phantom = await svc.from("listings").insert(mk("PUBLISHED")).select("id").maybeSingle()
      check(
        "phantom stage 'PUBLISHED' is REJECTED by listings_lifecycle_stage_check (the removed vocabulary was unusable)",
        !!phantom.error,
        phantom.error ? undefined : "the database ACCEPTED a stage the source union does not contain",
      )
      if (phantom.data?.id) createdListingIds.push(phantom.data.id)

      const real = await svc.from("listings").insert(mk("MLS_ACTIVE")).select("id, lifecycle_stage").maybeSingle()
      check(
        "real stage 'MLS_ACTIVE' is ACCEPTED (the replacement vocabulary is live)",
        !real.error && real.data?.lifecycle_stage === "MLS_ACTIVE",
        real.error?.message,
      )
      if (real.data?.id) createdListingIds.push(real.data.id)

      // Every STAGE_TO_EVENT key must be a live-legal stage value.
      const block = balancedBlock(S.CORE, "STAGE_TO_EVENT") ?? ""
      const eventKeys = [...block.matchAll(/^\s*([A-Z_]+)\s*:/gm)].map((m) => m[1])
      let allLegal = true
      const illegal: string[] = []
      for (const k of eventKeys) {
        const r = await svc.from("listings").insert(mk(k)).select("id").maybeSingle()
        if (r.data?.id) createdListingIds.push(r.data.id)
        if (r.error) { allLegal = false; illegal.push(k) }
      }
      check(
        `every STAGE_TO_EVENT key is a live-legal lifecycle_stage (${eventKeys.length} keys)`,
        allLegal,
        illegal.length ? `rejected by the CHECK: ${illegal.join(", ")}` : undefined,
      )
    }

    // ── L3: the activities stage probe really is writer-less ────────────────
    const act = await svc
      .from("activities")
      .select("id", { count: "exact", head: true })
      .eq("activity_type", "listing_lifecycle_transition")
    check(
      "activities.activity_type='listing_lifecycle_transition' has ZERO rows (the old stage probe is writer-less)",
      !act.error && (act.count ?? -1) === 0,
      act.error ? act.error.message : `count = ${act.count}`,
    )

    // ── L4: the live user_type vocabulary contains the roles the map adds ────
    const roleBlock = balancedBlock(S.CORE, "USER_TYPE_TO_LIFECYCLE_ROLE") ?? ""
    const mappedTypes = [...roleBlock.matchAll(/([A-Za-z_]+)\s*:\s*["'][a-z_]+["']/g)].map((m) => m[1])
    const bogus = await svc
      .from("users")
      .select("id")
      .eq("user_type", "definitely_not_a_real_user_type")
      .limit(1)
    check(
      "users.user_type is queryable (role vocabulary is a real column, not invented)",
      !bogus.error,
      bogus.error?.message,
    )
    let allTypesLegal = true
    const rejectedTypes: string[] = []
    for (const t of mappedTypes) {
      const r = await svc.from("users").select("id").eq("user_type", t).limit(1)
      if (r.error) { allTypesLegal = false; rejectedTypes.push(t) }
    }
    check(
      `every mapped user_type is a queryable value (${mappedTypes.length} roles: ${mappedTypes.join(", ")})`,
      allTypesLegal,
      rejectedTypes.length ? `rejected: ${rejectedTypes.join(", ")}` : undefined,
    )

    // ── L5: identity classes — the FKs the fix depends on ───────────────────
    // listings.agent_id must NOT accept a users.id. Probed by joining: a listing's
    // agent_id must resolve in `agents`, never in `users` alone.
    const { data: someAgent } = await svc.from("agents").select("id, user_id").limit(1).maybeSingle()
    if (someAgent && brk) {
      const badId = (someAgent as any).user_id // a users.id
      const r = await svc
        .from("listings")
        .insert({ address: `${TAG} identity`, brokerage_id: (brk as any).id, agent_id: badId, status: "draft" })
        .select("id")
        .maybeSingle()
      if (r.data?.id) createdListingIds.push(r.data.id)
      check(
        "listings.agent_id REFUSES a users.id (agents.id and users.id are distinct id spaces)",
        !!r.error,
        r.error ? undefined : "a users.id was accepted into listings.agent_id — the FK is not what pg_constraint reported",
      )
    } else {
      console.log("  ⏭  identity-class probe skipped — no agents row available.")
    }
  } finally {
    // ── CLEANUP + RESIDUE RECOUNT ───────────────────────────────────────────
    for (const id of createdListingIds) {
      await svc.from("listings").delete().eq("id", id)
    }
    const residue = await svc
      .from("listings")
      .select("id", { count: "exact", head: true })
      .like("address", `${TAG}%`)
    check(
      "test-data residue is 0 (every row this run created was removed)",
      !residue.error && (residue.count ?? -1) === 0,
      residue.error ? residue.error.message : `residue = ${residue.count}`,
    )
  }

  return { skipped: false as const }
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 3 — negative tests
// ─────────────────────────────────────────────────────────────────────────────

function runLayer3() {
  console.log("\n[Layer 3 · negative tests — every assertion must be breakable]")

  const byId = new Map(ASSERTIONS.map((a) => [a.id, a]))
  let negPassed = 0
  let negFailed = 0
  const negFailures: string[] = []

  // Every assertion must have a mutation. An assertion nobody can break is not
  // a test.
  for (const a of ASSERTIONS) {
    if (!MUTATIONS.some((m) => m.assertionId === a.id)) {
      negFailed++
      negFailures.push(`${a.id} has NO mutation — it can never be shown to fail`)
      console.log(`  ✗ ${a.id} has no mutation defined`)
    }
  }

  for (const mut of MUTATIONS) {
    const a = byId.get(mut.assertionId)
    if (!a) {
      negFailed++
      negFailures.push(`mutation targets unknown assertion ${mut.assertionId}`)
      continue
    }

    const path = join(ROOT, F[mut.file])
    const original = readFileSync(path, "utf8")
    const digestBefore = createHash("sha256").update(original).digest("hex")

    // Build the mutated content.
    let mutated: string
    if (mut.append) {
      mutated = original + mut.append
    } else if (mut.occurrence !== undefined) {
      let seen = -1
      let idx = -1
      let from = 0
      while (true) {
        const at = original.indexOf(mut.find, from)
        if (at === -1) break
        seen++
        if (seen === mut.occurrence) { idx = at; break }
        from = at + mut.find.length
      }
      mutated = idx === -1 ? original : original.slice(0, idx) + mut.replace + original.slice(idx + mut.find.length)
    } else {
      mutated = original.split(mut.find).join(mut.replace)
    }

    // ── THE MUTATION MUST ACTUALLY APPLY ────────────────────────────────────
    // A `replace` that silently no-ops would make this whole layer theatre.
    if (mutated === original) {
      negFailed++
      negFailures.push(`${a.id} mutation was a NO-OP (target text not found in ${F[mut.file]})`)
      console.log(`  ✗ ${a.id} mutation did not apply — target text absent from ${F[mut.file]}`)
      continue
    }

    let flipped = false
    let stillPassesBefore = false
    try {
      // Confirm the assertion PASSES on clean source first — an assertion that
      // is already failing proves nothing when broken.
      stillPassesBefore = a.run(loadSources())

      writeFileSync(path, mutated, "utf8")
      const mutatedDigest = createHash("sha256").update(readFileSync(path, "utf8")).digest("hex")
      const reallyOnDisk = mutatedDigest !== digestBefore

      if (!reallyOnDisk) {
        negFailed++
        negFailures.push(`${a.id} mutation did not reach disk`)
        console.log(`  ✗ ${a.id} mutation did not reach disk`)
        continue
      }

      flipped = a.run(loadSources()) === false
    } finally {
      // ── RESTORE, AND VERIFY THE RESTORE BY SHA256 ─────────────────────────
      writeFileSync(path, original, "utf8")
      const digestAfter = createHash("sha256").update(readFileSync(path, "utf8")).digest("hex")
      if (digestAfter !== digestBefore) {
        negFailed++
        negFailures.push(`${a.id} FAILED TO RESTORE ${F[mut.file]} — sha256 mismatch`)
        console.log(`  ✗✗ ${a.id} FAILED TO RESTORE ${F[mut.file]} (sha256 mismatch) — FIX THIS FILE BY HAND`)
        continue
      }
    }

    if (!stillPassesBefore) {
      negFailed++
      negFailures.push(`${a.id} was already failing on clean source — negative test is meaningless`)
      console.log(`  ✗ ${a.id} was already failing before mutation`)
    } else if (flipped) {
      negPassed++
      console.log(`  ✓ ${a.id} broke as expected, restored (sha256 verified)`)
    } else {
      negFailed++
      negFailures.push(`${a.id} did NOT fail when broken — assertion is too loose, TIGHTEN IT`)
      console.log(`  ✗ ${a.id} survived its mutation — assertion is too loose`)
    }
  }

  return { negPassed, negFailed, negFailures }
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═".repeat(78))
  console.log("LISTINGS KERNEL — wiring simulator")
  console.log("═".repeat(78))

  runLayer1()
  const live = await runLayer2()
  const neg = runLayer3()

  console.log("\n" + "═".repeat(78))
  console.log(`Layer 1+2 assertions : ${passed} passed, ${failed} failed`)
  console.log(`Layer 3 negative     : ${neg.negPassed} broke-and-restored, ${neg.negFailed} failed`)
  if (live.skipped) console.log(`Layer 2 live         : SKIPPED (creds absent) — not counted as passing`)
  console.log("═".repeat(78))

  if (failures.length) {
    console.log("\nFAILURES:")
    for (const f of failures) console.log(`  · ${f}`)
  }
  if (neg.negFailures.length) {
    console.log("\nNEGATIVE-TEST FAILURES:")
    for (const f of neg.negFailures) console.log(`  · ${f}`)
  }

  process.exit(failed + neg.negFailed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error("simulator crashed:", e)
  process.exit(1)
})
