#!/usr/bin/env tsx
/**
 * scripts/video-script-compliance-guard.ts  (npm run test:video-script-compliance)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PRIVATE GATE. Seven functions in this repo are named generateVideoScript.
 * Exactly one of them — app/actions/video/generate-script.ts, behind the
 * /dashboard/videos/create wizard — enforced brand voice, ThemFirst, and Fair
 * Housing. It wrote those rules out inline, so no other generator could reuse
 * them. The other four reachable generators produced agent-facing marketing
 * copy with no Fair Housing check at all:
 *
 *   app/actions/video-generation.ts   → /video-assistant, agent superpowers panel
 *   app/actions/link-to-video.ts      → /content-studio
 *   lib/kernel/video.ts               → the script that actually gets rendered
 *   lib/content-generation/           → EducationEditor, via the engine action
 *     content-generator.ts              app/actions/content-generation-engine.ts
 *
 * That fifth path was nearly missed: it is imported through the barrel
 * @/lib/content-generation, so resolving import specifiers to file paths does
 * not find it. Re-exports hide callers — check the barrel, not just the module.
 *
 * The gate now lives in lib/video/script-compliance.ts and every generator on
 * the GENERATORS roster below calls it — five at extraction, six since
 * 2026-08-28 when app/actions/workflows.ts (generateScriptContent /
 * savePrivateScript, the private-scripts lane) became reachable.
 * This guard is what stops it drifting back into one file's private business.
 *
 * THE SILENT AUDIT. Nine call sites passed evaluateOutbound a stub contact with
 * a non-uuid id ("broadcast", "contextual_draft_target", "broadcast_persona_hook").
 * contacts.id and compliance_events.entity_id are both uuid, so BOTH the contact
 * re-fetch and the compliance_events INSERT failed with 22P02 — silently, since
 * neither destructures `error`. The gates still blocked correctly, but every
 * evaluation went unrecorded, and COMPLIANCE_VIOLATION never fired because that
 * notification is guarded on the audit insert having succeeded. Verified against
 * the live database, not inferred.
 *
 * EvaluateOutboundParams documents `contact` as optional precisely for broadcast
 * payloads, so omitting it is what the stubs were trying to express. Every stub
 * set tcpa_consent true / dnc false / no status and used only social or email,
 * so Gates 2 and 3 contributed nothing — omitting the contact is
 * violation-identical and makes the audit write succeed.
 *
 * ASSERTS THE CONSTRUCT, NOT THE SPELLING. Each check is written so that
 * gutting the branch fails it — a bare token-presence check would keep passing
 * on the function's own import line or a comment mentioning it.
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { blankStrings, stripComments } from "./strip-comments"

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), "utf8")

const failures: string[] = []
const passes: string[] = []

function check(id: string, ok: boolean, detail: string) {
  if (ok) passes.push(id)
  else failures.push(`${id}: ${detail}`)
}

// ── 1. The shared gate exists and exports the three pieces ───────────────────

const gate = stripComments(read("lib/video/script-compliance.ts"))

check(
  "GATE-EXPORTS-THREE",
  /export\s+async\s+function\s+buildComplianceSystemBlocks\s*\(/.test(gate) &&
    /export\s+async\s+function\s+precheckBriefForFairHousing\s*\(/.test(gate) &&
    /export\s+async\s+function\s+postcheckScript\s*\(/.test(gate),
  "lib/video/script-compliance.ts must export buildComplianceSystemBlocks, precheckBriefForFairHousing, postcheckScript",
)

// Assert the constructs, not the spellings: a bare /brand_voice_profile/ test
// still matches "brand_voice_profileGUTTED", so it cannot detect the table
// being repointed. Require the declarations and the actual .from() target.
check(
  "GATE-CARRIES-ALL-THREE-BLOCKS",
  /\bconst\s+THEM_FIRST_BLOCK\s*=/.test(gate) &&
    /\bconst\s+FAIR_HOUSING_BLOCK\s*=/.test(gate) &&
    /\.from\(\s*["']brand_voice_profile["']\s*\)/.test(gate),
  "the shared gate must carry brand voice, ThemFirst and Fair Housing — not a subset",
)

// A failed brand-voice read must not read as "no brand voice configured".
check(
  "GATE-BRAND-VOICE-CHECKS-ERROR",
  /const\s*\{\s*data:\s*bvp,\s*error\s*\}/.test(gate) && /if\s*\(\s*error\s*\|\|\s*!bvp\s*\)/.test(gate),
  "loadBrandVoiceBlock must destructure `error` and branch on it — supabase-js resolves a refused read",
)

// The pre-check blocks on Fair Housing ONLY. If it ever blocks on the whole
// violation list, an agent's shorthand brief gets refused for ThemFirst.
check(
  "GATE-PRECHECK-FAIR-HOUSING-ONLY",
  /startsWith\(\s*["']FairHousing:["']\s*\)/.test(gate),
  "precheckBriefForFairHousing must filter to FairHousing: violations before blocking",
)

// ── 2. Every reachable generator calls the shared gate ───────────────────────
//
// ── THE ROSTER IS DERIVED NOW, NOT HAND-WRITTEN (§2) ─────────────────────────
//
// GENERATORS below was a hand-maintained list of six files, and it was WRONG by
// two: lib/video/chapter-video-generator.ts and app/actions/video/create-video-project.ts
// both call buildComplianceSystemBlocks and neither was on it. Both DO run the
// gate today, so there was no live compliance hole — which is exactly the shape
// this guard's own header (§ "ASSERTS THE CONSTRUCT") says it exists to prevent:
// gutting either file's gate left this guard GREEN, so the assertion was TRUE
// AND USELESS. A roster that only covers the files somebody remembered to type
// is not a measurement of the repo, it is a measurement of the list.
//
// The rule, stated instead of counted: EVERY file under lib/** or app/** that
// calls buildComplianceSystemBlocks — i.e. puts the compliance blocks into a
// writing prompt — must also call postcheckScript on what the model gave back.
// Compliance-first is both halves; a file that only does the first is asking the
// model nicely and never checking.

const SCAN_ROOTS = ["lib", "app"] as const
const SCAN_DIR_EXCLUSIONS = new Set(["node_modules", ".next", "dist", "build", "__tests__", "__snapshots__"])
const SCAN_EXTENSIONS = [".ts", ".tsx"]
/** The gate's own module. It DECLARES buildComplianceSystemBlocks; it is not a caller. */
const GATE_MODULE = "lib/video/script-compliance.ts"

function walkSource(dir: string, out: string[] = []): string[] {
  let entries: Array<{ name: string; isDirectory(): boolean }>
  try { entries = readdirSync(join(root, dir), { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) {
      if (SCAN_DIR_EXCLUSIONS.has(e.name)) continue
      walkSource(rel, out)
    } else if (SCAN_EXTENSIONS.some((x) => e.name.endsWith(x))) {
      out.push(rel)
    }
  }
  return out
}

/**
 * Does this source CALL `fn`?
 *
 * Reads source with comments blanked AND string/template contents blanked
 * (scripts/strip-comments.ts blankStrings — one left-to-right scan, never a
 * hand-rolled stripper). Both halves are load-bearing here:
 *
 *   · A TOMBSTONE IS NOT A CALL SITE. app/actions/video/create-video-project.ts
 *     carries a tombstone naming buildComplianceSystemBlocks, and section-narration.ts
 *     carries a comment naming it in prose about what it does NOT do. Reading raw
 *     source would count both as callers — the exact failure that made five guards
 *     accuse live code of the thing a tombstone records having fixed.
 *   · A FIXTURE IS NOT A CALL SITE either: a quoted specimen (a prompt, a
 *     narrative, a manager-registry entry describing the gate) must not count.
 *
 * The DECLARATION is neutralised first, so the module that exports a function
 * does not read as one of its own callers.
 */
function callsFunction(code: string, fn: string): boolean {
  const withoutDeclaration = code.replace(
    new RegExp(String.raw`function\s+${fn}\s*\(`, "g"),
    "function __declaration__(",
  )
  return new RegExp(String.raw`\b${fn}\s*\(`).test(withoutDeclaration)
}

/**
 * Every file that puts the compliance blocks into a writing prompt, and whether
 * it also post-checks. Pure over the (file, code) pairs it is handed, so the
 * positive control below can feed it synthetic sources.
 */
function deriveGateRoster(files: Array<{ file: string; code: string }>): {
  callers: string[]
  unchecked: string[]
} {
  const callers = files
    .filter((f) => f.file !== GATE_MODULE && callsFunction(f.code, "buildComplianceSystemBlocks"))
    .map((f) => f.file)
  const byFile = new Map(files.map((f) => [f.file, f.code]))
  const unchecked = callers.filter((f) => !/await\s+postcheckScript\s*\(/.test(byFile.get(f) ?? ""))
  return { callers, unchecked }
}

const SCANNED_FILES = SCAN_ROOTS.flatMap((r) => walkSource(r))
// CHEAP PRE-FILTER, and it cannot lose a call site: blanking comments and string
// contents never INTRODUCES a token, so a file whose RAW text does not contain
// the name cannot contain a call to it after blanking either. Only the handful
// of candidates pay for the character scan — without this the guard reads every
// one of the ~4,500 files twice and runs ~7s slower on every chain.
const SCANNED = SCANNED_FILES
  .map((file) => ({ file, raw: read(file) }))
  .filter((f) => f.raw.includes("buildComplianceSystemBlocks") || f.raw.includes("postcheckScript"))
  .map(({ file, raw }) => ({ file, code: blankStrings(raw) }))
const DERIVED = deriveGateRoster(SCANNED)

check(
  "GATE-ROSTER-EVERY-CALLER-POSTCHECKS",
  DERIVED.unchecked.length === 0,
  `${DERIVED.unchecked.join(", ")} put the compliance blocks in the writing prompt but never await postcheckScript(...) — `
  + `compliance-first is both halves`,
)

// POSITIVE CONTROL (§2). A broken finder and a clean tree both report zero, and
// this finder replaced a hand-written list precisely because "0 found" was
// meaningless. These fixtures prove it still recognises the defect it exists for
// — and still refuses to be satisfied by prose or by a quoted specimen.
{
  const FIXTURES = [
    { file: "fixture/gutted.ts", code: blankStrings(`const b = await buildComplianceSystemBlocks(id)\nconst s = await gen(b)`) },
    { file: "fixture/whole.ts", code: blankStrings(`const b = await buildComplianceSystemBlocks(id)\nconst w = await postcheckScript(actor, s, "buyer")`) },
    { file: "fixture/tombstone.ts", code: blankStrings(`// this used to call buildComplianceSystemBlocks(brokerageId); see the survivor\nexport const x = 1`) },
    { file: "fixture/specimen.ts", code: blankStrings(`const help = "call buildComplianceSystemBlocks(id) then postcheckScript(a, s, j)"`) },
    { file: GATE_MODULE, code: blankStrings(`export async function buildComplianceSystemBlocks(brokerageId: string) { return [] }`) },
  ]
  const control = deriveGateRoster(FIXTURES)
  check(
    "CONTROL-FINDER-CATCHES-A-GUTTED-POSTCHECK",
    control.unchecked.length === 1 && control.unchecked[0] === "fixture/gutted.ts",
    `expected exactly fixture/gutted.ts, got [${control.unchecked.join(", ")}]`,
  )
  check(
    "CONTROL-FINDER-IGNORES-COMMENTS-STRINGS-AND-THE-DECLARATION",
    control.callers.length === 2
      && control.callers.includes("fixture/gutted.ts")
      && control.callers.includes("fixture/whole.ts"),
    `a tombstone, a quoted specimen and the gate's own declaration must not read as call sites; got [${control.callers.join(", ")}]`,
  )
  check(
    "CONTROL-SCAN-ACTUALLY-READ-THE-TREE",
    SCANNED_FILES.length > 500 && DERIVED.callers.length >= 6,
    `${SCANNED_FILES.length} files walked, ${SCANNED.length} candidates scanned, ${DERIVED.callers.length} gate callers derived — `
    + `a walk that reads nothing reports zero defects`,
  )
}

console.log(
  `\n  roster DERIVED: ${DERIVED.callers.length} file(s) under ${SCAN_ROOTS.map((r) => `${r}/**`).join(" + ")} `
  + `call buildComplianceSystemBlocks, out of ${SCANNED_FILES.length} .ts/.tsx files walked `
  + `(${SCANNED.length} of them named either half in raw text and were character-scanned).`,
)
for (const c of DERIVED.callers) console.log(`    · ${c}`)
console.log(
  `  BLIND SPOTS beside the number (§2):\n`
  + `    · Denominator is lib/** + app/** only. scripts/**, remotion/** and any\n`
  + `      generator living elsewhere is OUT — as is ${GATE_MODULE} itself, which\n`
  + `      declares the function rather than calling it.\n`
  + `    · Excluded directories: ${[...SCAN_DIR_EXCLUSIONS].join(", ")}. Files whose RAW text\n`
  + `      names neither half are skipped before the character scan — sound, because\n`
  + `      blanking comments and strings never introduces a token.\n`
  + `    · The rule proven is "blocks in the prompt ⇒ postcheck after". A generator\n`
  + `      that calls NEITHER is invisible to this derivation — that is what the\n`
  + `      named GENERATORS roster below still covers, and why it survives.\n`
  + `    · precheckBriefForFairHousing is per-file and cannot be derived: only the\n`
  + `      file knows which of its fields are CALLER-authored prose.`,
)

const GENERATORS: Array<{ id: string; file: string; needs: string[] }> = [
  {
    id: "WIZARD",
    file: "app/actions/video/generate-script.ts",
    needs: ["buildComplianceSystemBlocks", "precheckBriefForFairHousing", "postcheckScript"],
  },
  {
    id: "VIDEO-GENERATION",
    file: "app/actions/video-generation.ts",
    needs: ["buildComplianceSystemBlocks", "precheckBriefForFairHousing", "postcheckScript"],
  },
  {
    id: "LINK-TO-VIDEO",
    file: "app/actions/link-to-video.ts",
    needs: ["buildComplianceSystemBlocks", "postcheckScript"],
  },
  {
    id: "KERNEL-VIDEO",
    file: "lib/kernel/video.ts",
    needs: ["buildComplianceSystemBlocks", "postcheckScript"],
  },
  {
    // The gate sits in the action, not in the pure generator, because that is
    // where the authenticated actor already resolves.
    id: "CONTENT-ENGINE",
    file: "app/actions/content-generation-engine.ts",
    needs: ["buildComplianceSystemBlocks", "precheckBriefForFairHousing", "postcheckScript"],
  },
  {
    // The SIXTH generator, reachable since 2026-08-28: generateScriptContent
    // (caller-supplied context pre-checked, compliance blocks IN the writing
    // prompt) and savePrivateScript (agent-written text, post-checked) both
    // store to `public.scripts` through ONE fused gate+store helper
    // (gateAndStorePrivateScript), so there is exactly one `await
    // postcheckScript(` in the file and no path reaches the INSERT without the
    // gate — a hard fair-housing / blocking-phrase flag refuses the store.
    // savePrivateScript's content is a FINISHED script, not model-bound prose,
    // so it deliberately carries no `if (x?.trim())` prose-gate marker (see
    // unprecheckedProseGates below): the marker is for caller prose entering a
    // writing prompt, and the only such field here is generateScriptContent's
    // context, whose gate does pre-check.
    id: "WORKFLOWS",
    file: "app/actions/workflows.ts",
    needs: ["buildComplianceSystemBlocks", "precheckBriefForFairHousing", "postcheckScript"],
  },
]

/**
 * EVERY CALLER-AUTHORED PROSE FIELD IN A FILE, AND WHETHER ITS OWN GATE
 * PRE-CHECKS IT.
 *
 * WHY THIS EXISTS, and it is CLAUDE.md §2 paying for itself in the most direct
 * way available: the check below used to be `.test(src)` alone — a BOOLEAN. One
 * surviving call site anywhere in the file kept it true. That was harmless while
 * every generator had exactly one caller-prose field, and stopped being harmless
 * the moment app/actions/video-generation.ts gained a second one
 * (`params.keyPoints`) when a deleted route was merged into it. From then on the
 * FIRST pre-check could be deleted and this guard stayed green, because the
 * second one satisfied the boolean.
 *
 * Nobody noticed by reading it. The repo's own negative test noticed, and named
 * it exactly:
 *
 *   MISSED  VIDEO-GENERATION-CALLS-precheckBriefForFairHousing
 *           (guard stayed GREEN under mutation)
 *
 * An assertion that was TRUE and USELESS — the shape a positive control exists
 * to find, and the reason "0 found" is never evidence on its own.
 *
 * THE RULE IS DERIVED, NOT COUNTED. "video-generation.ts must have 2
 * pre-checks" would be a §2 waypoint: stale the moment a lane adds a third
 * field, and green while the WRONG two are checked. Instead the files mark
 * caller-authored prose themselves, with an `if (x?.trim())` gate —
 * video-generation.ts says so in its own words, "the agent's free-text
 * description and key points are the only caller-authored prose here; the
 * purpose/persona/tone keys are ours" — so the rule is that every such block
 * pre-checks INSIDE ITSELF. Add a fourth prose field and forget its gate and
 * this goes red with nobody editing the guard.
 */
function unprecheckedProseGates(src: string): string[] {
  const orphaned: string[] = []
  for (const m of src.matchAll(/if\s*\(\s*([A-Za-z_$][\w$.]*)\?\.trim\(\)\s*\)\s*\{/g)) {
    // Brace-MATCHED, not regex'd to the first `}`. A lazy `[\s\S]*?\}` stops at
    // the first nested closing brace and reports a block as missing what the
    // block plainly contains — a finder bug this repo has now paid for twice.
    const open = src.indexOf("{", m.index! + m[0].length - 1)
    let depth = 0
    let end = open
    for (let k = open; k < src.length; k++) {
      if (src[k] === "{") depth++
      else if (src[k] === "}") {
        depth--
        if (depth === 0) { end = k; break }
      }
    }
    if (!/await\s+precheckBriefForFairHousing\s*\(/.test(src.slice(open, end))) orphaned.push(m[1])
  }
  return orphaned
}

for (const g of GENERATORS) {
  const src = stripComments(read(g.file))
  for (const fn of g.needs) {
    // `await fn(` — the CALL, not the import specifier and not a mention.
    const called = new RegExp(String.raw`await\s+${fn}\s*\(`).test(src)
    if (fn !== "precheckBriefForFairHousing") {
      check(`${g.id}-CALLS-${fn}`, called, `${g.file} must await ${fn}(...)`)
      continue
    }
    // The pre-check is the one gate a file can hold MORE THAN ONE of, so it is
    // the one that cannot be asserted as a boolean. It must be called, AND every
    // caller-prose gate must be covered — a file with two prose fields and one
    // pre-check has half its input reaching the model ungated.
    const orphaned = unprecheckedProseGates(src)
    check(
      `${g.id}-CALLS-${fn}`,
      called && orphaned.length === 0,
      !called
        ? `${g.file} must await ${fn}(...)`
        : `${g.file} has ${orphaned.length} caller-prose gate(s) that never pre-check: ${orphaned.join(", ")}`,
    )
  }
}

// The named roster is a SUBSET of the derived one, or it is decoration. The
// CALLERS list further down learned this the hard way: a file stopped calling
// evaluateOutbound and its per-file check stayed green while asserting nothing.
// A named generator that stops calling the gate must go RED here, not silently
// drop out of the derivation.
{
  const derived = new Set(DERIVED.callers)
  const stale = GENERATORS.filter((g) => !derived.has(g.file)).map((g) => g.file)
  check(
    "GENERATORS-ROSTER-IS-A-SUBSET-OF-THE-DERIVED-ONE",
    stale.length === 0,
    `${stale.join(", ")} is named on the GENERATORS roster but no longer calls buildComplianceSystemBlocks — `
    + `either it was gutted, or the entry is decoration and must come off`,
  )
  const notNamed = DERIVED.callers.filter((f) => !GENERATORS.some((g) => g.file === f))
  console.log(
    `  derived-but-unnamed (covered by GATE-ROSTER-EVERY-CALLER-POSTCHECKS, not by a\n`
    + `  per-file precheck rule): ${notNamed.length > 0 ? notNamed.join(", ") : "(none)"}`,
  )
}

// The wizard must no longer own a private copy of the rule text — that is the
// drift this whole task was about.
const wizard = stripComments(read("app/actions/video/generate-script.ts"))
check(
  "WIZARD-HAS-NO-PRIVATE-COPY",
  !/ThemFirst communication philosophy/.test(wizard) &&
    !/Fair Housing compliance \(Gate 4/.test(wizard),
  "app/actions/video/generate-script.ts must not re-declare the ThemFirst/Fair Housing block text",
)

// The engine's own header used to say "no publishing/approval/compliance".
// A file that runs a compliance gate must not describe itself as ungated.
const engine = read("app/actions/content-generation-engine.ts")
check(
  "CONTENT-ENGINE-HEADER-HONEST",
  !/Draft-only, no publishing\/approval\/compliance/.test(engine),
  "content-generation-engine.ts header still claims it runs no compliance, but the video lane now does",
)

// ── 3. No evaluateOutbound call passes a non-uuid contact id ─────────────────
// This is the audit-row killer. Any string literal id that is not a uuid
// expression means the compliance_events INSERT will 22P02 and be swallowed.

const CALLERS = [
  "app/actions/social/generate-social-post.ts",
  "app/actions/ai-newsletter.ts",
  "app/actions/blog.ts",
  "app/actions/social-media-automation.ts",
  "lib/video/persona-variant-post-pass.ts",
  "lib/video/script-compliance.ts",
  // app/actions/video/generate-script.ts is deliberately absent: it no longer
  // calls evaluateOutbound directly, it delegates to the shared gate above.
  // Listing it here would assert nothing.
  //
  // app/actions/video/create-video-project.ts left for the SAME reason, and it
  // is worth naming because it was listed here and PASSING while asserting
  // nothing. Its only two `evaluateOutbound` mentions are inside the tombstone
  // comment describing the fail-open call it USED to make; this loop strips
  // comments first, so evaluateOutboundArgs() returned an empty list and the
  // per-caller check was vacuously true. A caller list is only a check while
  // every file on it still calls the thing — a name that stops calling has to
  // come off, or the list quietly turns into decoration.
]

/**
 * Extract each evaluateOutbound(...) argument by brace matching. A whole-file
 * regex is not good enough here: ai-newsletter.ts contains `id: "modern"` for a
 * newsletter TEMPLATE, which has nothing to do with a contact. Only the actual
 * argument to the gate can be judged.
 */
function evaluateOutboundArgs(src: string): string[] {
  const out: string[] = []
  const re = /evaluateOutbound\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length
    let depth = 1
    const start = i
    for (; i < src.length && depth > 0; i++) {
      const c = src[i]
      if (c === "(" || c === "{" || c === "[") depth++
      else if (c === ")" || c === "}" || c === "]") depth--
    }
    out.push(src.slice(start, i))
  }
  return out
}

for (const f of CALLERS) {
  const src = stripComments(read(f))
  // A contact id that is a bare lowercase string literal is always a stub — a
  // real one is an expression (contact.id, row.id, params.contactId).
  const stub = evaluateOutboundArgs(src)
    .map((arg) => /id:\s*["'][a-z_]+["']/.exec(arg))
    .find(Boolean)
  check(
    `NO-STUB-CONTACT-${f.replace(/[^a-z]/gi, "-")}`,
    !stub,
    `${f} passes evaluateOutbound a literal stub ${stub?.[0]} — compliance_events.entity_id is uuid, the audit INSERT will fail with 22P02`,
  )
}

// ── 4. The surfaces show what the gate found ─────────────────────────────────
// A gate whose result never reaches the agent is not wired.

// Each surface must both READ the action's complianceWarnings and DISPLAY them.
// Reading alone is exactly the failure mode this replaces: the wizard action
// computed warnings for months and its own page never rendered one.
const SURFACES: Array<{ id: string; file: string; reads: RegExp; displays: RegExp }> = [
  {
    id: "WIZARD-UI",
    file: "app/dashboard/videos/create/video-create-client.tsx",
    reads: /setScriptComplianceWarnings\(\s*result\.complianceWarnings/,
    displays: /scriptComplianceWarnings\.map\(/,
  },
  {
    id: "VIDEO-ASSISTANT-UI",
    file: "app/video-assistant/page.tsx",
    reads: /\.complianceWarnings\b/,
    displays: /toast\.warning\(/,
  },
  {
    id: "SUPERPOWERS-UI",
    file: "app/dashboard/agent/components/agent-superpowers-panel.tsx",
    reads: /result\.complianceWarnings\b/,
    displays: /Compliance notes/,
  },
  {
    id: "CONTENT-STUDIO-UI",
    file: "app/components/content-studio/LinkToVideoGenerator.tsx",
    reads: /result\.complianceWarnings\b/,
    displays: /toast\.warning\(/,
  },
]

for (const s of SURFACES) {
  const src = stripComments(read(s.file))
  check(
    `${s.id}-SURFACES-WARNINGS`,
    s.reads.test(src) && s.displays.test(src),
    `${s.file} must read the action's complianceWarnings AND render them`,
  )
}

// The two paths that used to swallow a refusal must report its reason.
const assistant = stripComments(read("app/video-assistant/page.tsx"))
check(
  "VIDEO-ASSISTANT-REPORTS-REFUSAL",
  /failure\?\.error/.test(assistant),
  "app/video-assistant/page.tsx must surface the action's error when every variation fails",
)

const superpowers = stripComments(read("app/dashboard/agent/components/agent-superpowers-panel.tsx"))
check(
  "SUPERPOWERS-REPORTS-REFUSAL",
  /result\?\.error/.test(superpowers),
  "agent-superpowers-panel.tsx must show result.error rather than 'Generated script is empty'",
)

// ── 4b. workflows: a hard red flag refuses the `scripts` store ───────────────
// The owner's ruling for the private-script lane: advisory findings ride along,
// a hard fair-housing / blocking-phrase flag means the row is NOT written.
// Asserted as a CONSTRUCT AND AN ORDER, not a spelling: the red-flag early
// return must exist and must precede the file's single `.from("scripts")`
// INSERT, so gutting the branch or moving the write above the gate goes red.

{
  const wf = stripComments(read("app/actions/workflows.ts"))
  const refusal = wf.search(/const\s+redFlags\s*=[\s\S]*?if\s*\(redFlags\.length > 0\)\s*\{\s*return/)
  const insert = wf.indexOf('.from("scripts")')
  check(
    "WORKFLOWS-RED-FLAG-REFUSES-STORE",
    refusal !== -1 && insert !== -1 && refusal < insert,
    "app/actions/workflows.ts must return on redFlags BEFORE its single .from(\"scripts\") insert — a red-flagged script must never be stored",
  )
}

// ── 5. link-to-video: a deterministic Fair Housing hit is not overridable ────

const l2v = stripComments(read("app/actions/link-to-video.ts"))
check(
  "LINK-TO-VIDEO-FORCES-REVISION",
  /script_status:\s*["']needs_revision["']/.test(l2v) && /compliance_check_passed:\s*false/.test(l2v),
  "link-to-video must force the queue row back to needs_revision when the kernel gate finds a violation",
)

// ── Report ───────────────────────────────────────────────────────────────────

console.log(`\nvideo-script-compliance: ${passes.length} passed, ${failures.length} failed\n`)
if (failures.length) {
  for (const f of failures) console.error(`  FAIL  ${f}`)
  console.error("\nVIDEO_SCRIPT_COMPLIANCE_FAIL\n")
  process.exit(1)
}
console.log("  All video script generators enforce the shared compliance gate.\n")
