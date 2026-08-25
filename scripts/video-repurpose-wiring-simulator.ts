#!/usr/bin/env tsx
/**
 * scripts/video-repurpose-wiring-simulator.ts
 *   npx tsx scripts/video-repurpose-wiring-simulator.ts
 *
 * PROOF FOR THE VIDEO-REPURPOSING RAIL.
 *
 * Layer 1 (pure, always runs) reads the SOURCE and asserts the CONSTRUCT:
 *   · every orphan that was wired is reachable from a real surface,
 *   · every projectId-taking action carries a STRUCTURAL tenant gate,
 *   · the three render-ish actions are still unreferenced, i.e. no THIRD
 *     writer of ai_video_projects' render slot was introduced,
 *   · the surfaces report the SERVER's verdict rather than an optimistic one.
 *
 * Layer 2 (creds-gated) checks the same vocabulary against the LIVE database
 * and SKIPS LOUDLY when the database is unreachable — a network error is never
 * scored as a pass. Anything it seeds is deleted and re-counted to zero.
 *
 * COMMENTS ARE STRIPPED before any scan, so prose (including the long
 * do-not-wire banners this rail now carries) cannot satisfy an assertion.
 * Function bodies are SLICED so a neighbouring function cannot satisfy a check
 * on its behalf.
 */

import { readFileSync, existsSync } from "node:fs"
import { walkTs, rootRuntimeFiles } from "./runtime-roots"
import { join } from "node:path"
import { blankComments, blankStrings } from "./strip-comments"

const root = process.cwd()

let passed = 0
let failed = 0
const failures: string[] = []

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    failures.push(label + (detail ? ` — ${detail}` : ""))
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`)
  }
}

// ─── SOURCE LOADING + COMMENT STRIPPING ──────────────────────────────────────
//
// Block comments, line comments, and the contents of string/template literals
// are all removed. String bodies go too: a check must be satisfied by CODE, and
// a toast message or a doc URL that happens to contain the right identifier is
// not code. Regex literals are left alone by treating "/" conservatively — this
// file only needs to survive the handful of sources it reads, all of which use
// plain quotes.

// hand-rolled scanner replaced (finding #250): it could not see nested `${…}` templates or regex literals, and a hand-rolled string masker desynchronises on a stray backtick.
const strip = blankStrings

// hand-rolled scanner replaced (finding #250): it could not see nested `${…}` templates or regex literals, and a hand-rolled string masker desynchronises on a stray backtick.
const stripCommentsOnly = blankComments

function load(rel: string): string {
  const p = join(root, rel)
  if (!existsSync(p)) {
    throw new Error(`missing source file: ${rel}`)
  }
  return readFileSync(p, "utf8")
}

/**
 * THE SLICER. Returns the body of `name` and nothing else, so a check on
 * submitAvatarVideoRender cannot be satisfied by retryVideoGeneration sitting
 * below it. Brace-matched from the declaration's first "{" — the input is
 * already comment- and string-canonicalised by the caller, so braces inside
 * comments or strings cannot unbalance it.
 */
function body(canonical: string, name: string): string {
  const declRe = new RegExp(
    `(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*[(<]|` +
    `(?:export\\s+)?const\\s+${name}\\s*(?::[^=]*)?=\\s*(?:async\\s*)?\\(`,
  )
  const m = declRe.exec(canonical)
  if (!m) return ""

  // 1. Skip the PARAMETER LIST by paren-matching. Destructured or object-typed
  //    parameters contain braces (`filters?: { status?: string }`), and taking
  //    the first "{" after the name would slice the parameter type instead of
  //    the body — silently returning a fragment that no assertion can match.
  let p = canonical.indexOf("(", m.index)
  if (p === -1) return ""
  let parens = 0
  for (; p < canonical.length; p++) {
    if (canonical[p] === "(") parens++
    else if (canonical[p] === ")") {
      parens--
      if (parens === 0) { p++; break }
    }
  }

  // 2. Skip the RETURN TYPE. `Promise<{ ok: true } | { ok: false }>` also
  //    contains braces; they sit inside angle brackets, so track angle depth and
  //    accept only a "{" seen at angle depth 0. `=>` is not an angle bracket.
  let angle = 0
  let i = p
  for (; i < canonical.length; i++) {
    const ch = canonical[i]
    if (ch === "=" && canonical[i + 1] === ">") { i++; continue }
    if (ch === "<") angle++
    else if (ch === ">") { if (angle > 0) angle-- }
    else if (ch === "{" && angle === 0) break
    else if (ch === ";" && angle === 0) return "" // declaration only, no body
  }
  if (i >= canonical.length) return ""

  let depth = 0
  const start = i
  for (; i < canonical.length; i++) {
    if (canonical[i] === "{") depth++
    else if (canonical[i] === "}") {
      depth--
      if (depth === 0) return canonical.slice(start, i + 1)
    }
  }
  return canonical.slice(start)
}

/** Does `name` appear as a CALL (identifier followed by "(") in this slice? */
function calls(slice: string, name: string): boolean {
  return new RegExp(`\\b${name}\\s*\\(`).test(slice)
}

// ═════════════════════════════════════════════════════════════════════════════
// LAYER 1 — PURE
// ═════════════════════════════════════════════════════════════════════════════

const REPURPOSE_ACTIONS = "app/actions/video-repurposing.ts"
const REPURPOSE_UTILS   = "app/actions/video-repurposing.utils.ts"
const CREATE_PROJECT    = "app/actions/video/create-video-project.ts"
const SNIPPETS_CLIENT   = "app/dashboard/videos/snippets/snippets-page-client.tsx"
const WIZARD_PANEL      = "app/dashboard/campaigns/repurpose/components/snippet-wizard-panel.tsx"
const REPURPOSE_CLIENT  = "app/dashboard/campaigns/repurpose/repurpose-dashboard-client.tsx"
const CREATE_CLIENT     = "app/dashboard/videos/create/video-create-client.tsx"

const rawRepurpose = load(REPURPOSE_ACTIONS)
const rawUtils     = load(REPURPOSE_UTILS)
const rawCreate    = load(CREATE_PROJECT)
const rawSnippets  = load(SNIPPETS_CLIENT)
const rawWizard    = load(WIZARD_PANEL)
const rawDash      = load(REPURPOSE_CLIENT)
const rawVideoNew  = load(CREATE_CLIENT)

// Two canonicalisations per file: identifiers-only (strings blanked) and
// literals-preserved. Comments are gone from both.
const repurpose  = strip(rawRepurpose)
const repurposeL = stripCommentsOnly(rawRepurpose)
const utilsL     = stripCommentsOnly(rawUtils)
const create     = strip(rawCreate)
const createL    = stripCommentsOnly(rawCreate)
const snippets   = strip(rawSnippets)
const snippetsL  = stripCommentsOnly(rawSnippets)
const wizard     = strip(rawWizard)
const dash       = strip(rawDash)
const videoNew   = strip(rawVideoNew)

console.log("\n[Layer 0 · the comment stripper actually strips]")
{
  const probe = `const a = 1 /* deleteSnippet(x) */; // getSnippetDetail(y)\nconst s = "requireCaller()"`
  const s = strip(probe)
  check("block comments are removed", !s.includes("deleteSnippet"))
  check("line comments are removed", !s.includes("getSnippetDetail"))
  check("string literal bodies are removed in the identifier pass", !s.includes("requireCaller"))
  const sl = stripCommentsOnly(probe)
  check("literal pass keeps string bodies", sl.includes("requireCaller"))
  check("literal pass still drops comments", !sl.includes("deleteSnippet"))
}

console.log("\n[Layer 0b · the body slicer isolates one function]")
{
  const probe = `
function alpha(a) { const x = MARKER_A(1); }
function beta(b) { const y = MARKER_B(2); }
`
  const a = body(probe, "alpha")
  const b = body(probe, "beta")
  check("slicer finds alpha's marker", calls(a, "MARKER_A"))
  check("slicer excludes beta's marker from alpha", !calls(a, "MARKER_B"))
  check("slicer finds beta's marker", calls(b, "MARKER_B"))
  check("slicer excludes alpha's marker from beta", !calls(b, "MARKER_A"))

  // The two shapes that silently returned a fragment before: an object-typed
  // PARAMETER, and a braced RETURN TYPE. Both must be skipped.
  const tricky = `
async function gamma(opts: { a: string; b: number }): Promise<{ ok: true } | { ok: false }> { MARKER_C(1) }
async function delta() { MARKER_D(2) }
`
  const g = body(tricky, "gamma")
  check("slicer skips an object-typed parameter list", calls(g, "MARKER_C"))
  check("slicer skips a braced return type and stops at the real body", !calls(g, "MARKER_D"))
}

// ─── 1. THE TENANT GATE, STRUCTURALLY ────────────────────────────────────────
//
// ai_video_projects.brokerage_id is NULLABLE and every RLS policy on it reads
// (brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id()), so an
// untenanted row is readable by every brokerage; the kernel reads through the
// service client, which bypasses RLS entirely. Therefore: every browser-callable
// action that takes a projectId must resolve the project to the CALLER'S OWN
// brokerage, derived from the session, before it delegates.

console.log("\n[Layer 1 · tenant gate on ai_video_projects — structural]")
{
  const gate = body(create, "requireProjectInCallerBrokerage")
  check("create-video-project defines requireProjectInCallerBrokerage", gate.length > 0)
  check("the gate resolves the caller from the SESSION", calls(gate, "requireCaller"))
  const gateL = body(createL, "requireProjectInCallerBrokerage")
  check(
    "the gate reads ai_video_projects.brokerage_id",
    /from\("ai_video_projects"\)/.test(gateL) && /select\("brokerage_id"\)/.test(gateL),
  )
  check(
    "the gate compares for EQUALITY (a NULL brokerage_id can never satisfy it)",
    /project\.brokerage_id\s*!==\s*caller\.brokerageId/.test(gate),
  )

  // Every projectId-taking export in the file, wired or not — all of them are
  // live RPC endpoints regardless of whether a surface calls them.
  const PROJECT_ID_ACTIONS = [
    "submitAvatarVideoRender",
    "pollVideoStatus",
    "retryVideoGeneration",
    "getVideoProject",
    "getVideoProjectSnippetSource",
  ]
  for (const fn of PROJECT_ID_ACTIONS) {
    const slice = body(create, fn)
    check(`${fn} is present`, slice.length > 0)
    check(
      `${fn} calls the tenant gate`,
      calls(slice, "requireProjectInCallerBrokerage"),
    )
  }

  // The gate is worthless if the function then filters on the ARGUMENT it was
  // handed. Every one of these must have its brokerage parameter neutered.
  for (const fn of ["submitAvatarVideoRender", "pollVideoStatus", "retryVideoGeneration", "getVideoProject"]) {
    const decl = new RegExp(`function\\s+${fn}\\s*\\(([^)]*)\\)`)
    const m = decl.exec(create)
    check(
      `${fn} does not trust a caller-supplied brokerageId (param is neutered)`,
      !!m && /_brokerageId/.test(m[1]) && !/[^_]\bbrokerageId\s*:/.test(m[1]),
      m ? m[1].replace(/\s+/g, " ").trim() : "signature not found",
    )
  }

  // The session-derived helpers on the repurposing file.
  // Tightened: a bare /getUser/ still matched a mutated `getUserZZ`, so the
  // check could not be made to fail. Anchor on the exact member call.
  const rc = body(repurpose, "requireCaller")
  check("video-repurposing requireCaller reads auth.getUser", /\bauth\.getUser\(\)/.test(rc))
  const rcL = body(repurposeL, "requireCaller")
  check("video-repurposing requireCaller resolves users.brokerage_id", /from\("users"\)/.test(rcL))

  for (const fn of ["deleteSnippet", "getSnippetById", "getRepurposedContentLogs", "generateCaptionVariations", "getFilteredRepurposeHistory"]) {
    const slice = body(repurpose, fn)
    check(`${fn} gates on requireCaller`, calls(slice, "requireCaller"))
  }
  for (const fn of ["deleteSnippet", "getSnippetById", "getRepurposedContentLogs"]) {
    const sliceL = body(repurposeL, fn)
    check(
      `${fn} scopes its query to the session brokerage`,
      /\.eq\("brokerage_id",\s*auth\.brokerageId\)/.test(sliceL),
    )
  }
}

// ─── 2. NO THIRD RENDER-START PATH ───────────────────────────────────────────
//
// Two paths already write the SAME ai_video_projects render slot and the owner
// has ruled they are not to be consolidated:
//   · app/api/did/generate-video/route.ts  (status='generating' + provider_job_id)
//   · lib/kernel/video.ts:submitVideoGenerationJob (atomic slot claim)
// submitAvatarVideoRender / retryVideoGeneration / pollVideoStatus all drive
// that same D-ID rail. None of them may acquire a caller.

console.log("\n[Layer 1 · no THIRD writer of the render slot]")
{
  const RENDER_ACTIONS = ["submitAvatarVideoRender", "retryVideoGeneration", "pollVideoStatus"]

  // Walk every source file in the app/lib trees and look for a reference.
  // TOMBSTONE (orphan doctrine §1.1) — the private `walk()` generator that stood
  // here was one of 82 copies of the same readdirSync walker. The survivor is
  // scripts/runtime-roots.ts:61 (`walkTs`), imported above.
//
  // It enumerated DIRECTORIES, and a root-level FILE is not a directory, so
  // `proxy.ts` — the Next 16 edge middleware, which gates auth and queries four
  // tables with a SERVICE client on EVERY request — was outside this guard's corpus.
  // A file that is never opened reports green, which is the failure shape §2 of
  // CLAUDE.md names. `rootRuntimeFiles()` from the same survivor supplies it.
  function* scanCorpus(dirs: string[]): Generator<string> {
    for (const d of dirs) yield* walkTs(join(root, d))
    yield* rootRuntimeFiles(root)
  }

  const referrers: Record<string, string[]> = { submitAvatarVideoRender: [], retryVideoGeneration: [], pollVideoStatus: [] }
  let scanned = 0
  {
    for (const p of scanCorpus(["app", "lib"])) {
      const rel = p.slice(root.length + 1).replace(/\\/g, "/")
      // The defining file may of course name them; nobody else may.
      if (rel === CREATE_PROJECT) continue
      const src = strip(readFileSync(p, "utf8"))
      scanned++
      for (const fn of RENDER_ACTIONS) {
        if (new RegExp(`\\b${fn}\\b`).test(src)) referrers[fn].push(rel)
      }
    }
  }
  check(`scanned the app + lib trees (${scanned} files)`, scanned > 200)
  for (const fn of RENDER_ACTIONS) {
    check(
      `${fn} has ZERO referrers outside its own module`,
      referrers[fn].length === 0,
      referrers[fn].join(", "),
    )
  }

  // And the surfaces this task touched must not have grown a render-start
  // write of their own.
  for (const [name, srcL] of [
    ["snippets-page-client", stripCommentsOnly(rawSnippets)],
    ["snippet-wizard-panel", stripCommentsOnly(rawWizard)],
    ["repurpose-dashboard-client", stripCommentsOnly(rawDash)],
  ] as const) {
    check(
      `${name} writes no provider_job_id / 'generating' status`,
      !/provider_job_id/.test(srcL) && !/status:\s*"generating"/.test(srcL),
    )
  }

  // The one render-start on the create wizard is the pre-existing D-ID route
  // POST — exactly one, and no second one was added beside it.
  const didPosts = (stripCommentsOnly(rawVideoNew).match(/\/api\/did\/generate-video/g) ?? []).length
  check("video-create-client still has exactly ONE render-start endpoint", didPosts === 1, `found ${didPosts}`)
  check(
    "video-create-client did not gain a second render trigger",
    !calls(videoNew, "submitAvatarVideoRender") && !calls(videoNew, "retryVideoGeneration"),
  )
}

// ─── 3. THE WIRING — each orphan reachable from a real surface ───────────────

console.log("\n[Layer 1 · wired: action → surface → user]")
{
  const importsOf = (raw: string) =>
    Array.from(stripCommentsOnly(raw).matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g))
      .flatMap(m => m[1].split(",").map(s => s.trim().replace(/^type\s+/, "")).filter(Boolean).map(n => `${n}@${m[2]}`))

  const snippetImports = importsOf(rawSnippets)
  const wizardImports  = importsOf(rawWizard)
  const dashImports    = importsOf(rawDash)
  const videoImports   = importsOf(rawVideoNew)

  const wiring: Array<[string, string, string[], string]> = [
    ["deleteSnippet",                 "snippets page",  snippetImports, snippets],
    ["getSnippetDetail",              "snippets page",  snippetImports, snippets],
    ["generateCaptionVariations",     "snippets page",  snippetImports, snippets],
    ["getSocialAccountsForDistribution", "snippets page", snippetImports, snippets],
    ["getVideoProjectSnippetSource",  "snippet wizard", wizardImports,  wizard],
    ["getFilteredRepurposeHistory",   "repurpose dash", dashImports,    dash],
    ["improveScript",                 "video create",   videoImports,   videoNew],
  ]

  for (const [fn, surface, imports, src] of wiring) {
    check(`${surface} IMPORTS ${fn}`, imports.some(i => i.startsWith(`${fn}@`)))
    check(`${surface} CALLS ${fn}`, calls(src, fn))
  }

  // getSnippetById is reached through getSnippetDetail (and is the ownership
  // gate scheduleSnippetToSocial leans on) — assert the delegation, not a
  // direct import.
  check(
    "getSnippetDetail delegates to getSnippetById",
    calls(body(repurpose, "getSnippetDetail"), "getSnippetById"),
  )

  // logRepurposedContent is reached when a user runs the Snippet Wizard.
  check(
    "batchCreateSnippets records each snippet via logRepurposedContent",
    calls(body(repurpose, "batchCreateSnippets"), "logRepurposedContent"),
  )
  check(
    "the wizard is the surface that reaches batchCreateSnippets",
    calls(wizard, "batchCreateSnippets"),
  )

  // getRepurposedContentLogs is reached through getFilteredRepurposeHistory.
  check(
    "getFilteredRepurposeHistory delegates to getRepurposedContentLogs",
    calls(body(repurpose, "getFilteredRepurposeHistory"), "getRepurposedContentLogs"),
  )

  // The schedule sheet now actually SENDS the account it picked.
  check(
    "snippets page passes socialAccountId into scheduleSnippetToSocial",
    /socialAccountId:\s*selectedAccountId/.test(body(snippets, "handleSchedule")),
  )
}

// ─── 4. THE UI REPORTS THE SERVER'S VERDICT ─────────────────────────────────

console.log("\n[Layer 1 · the surface reports the server's verdict]")
{
  const del = body(snippets, "handleDelete")
  check("delete handler branches on result.success", /result\.success/.test(del))
  check("delete handler does not toast success unconditionally", /if\s*\(\s*!\s*result\.success\s*\)/.test(del))

  const vary = body(snippets, "handleGenerateVariations")
  check("caption variations branch on result.success", /!\s*result\.success/.test(vary))

  // The wizard's inverted verdict: it used to read `.success` off a bare ARRAY,
  // so every successful generation was announced as a failure.
  const gen = body(wizard, "generateSuggestions")
  check("wizard reads result.success on generateSnippetSuggestions", /result\.success/.test(gen))
  check("wizard no longer casts the result to any before reading success", !/result\s+as\s+any/.test(gen))

  const batch = body(wizard, "createAndQueue")
  check("wizard reads result.success on batchCreateSnippets", /result\.success/.test(batch))
  check(
    "wizard reports the SERVER's created count, not the requested count",
    /result\.snippetIds/.test(batch),
  )
  check(
    "wizard surfaces partial refusals",
    /result\.failed/.test(batch),
  )

  const hist = body(dash, "applyHistoryFilters")
  check("history filter branches on result.success", /!\s*result\.success/.test(hist))
  // Tightened: the function also calls setHistoryFilterError(null) to clear, so
  // a bare name match passed even when the SERVER's error was thrown away.
  check("history filter surfaces the server error", /setHistoryFilterError\(\s*result\.error/.test(hist))

  const imp = body(videoNew, "handleImproveScript")
  check("improve-script handler branches on result.success", /!\s*result\.success/.test(imp))
}

// ─── 5. THE DEFECTS FIXED — assert the fix, by construct ────────────────────

console.log("\n[Layer 1 · defect fixes hold]")
{
  // (a) social_posts.post_type is a CHECKED column and the snippet's
  //     platform_target is in none of its allowed values.
  const sched = body(repurposeL, "scheduleSnippetToSocial")
  check(
    "scheduleSnippetToSocial writes a post_type the CHECK allows",
    /post_type:\s*"custom"/.test(sched),
  )
  check(
    "scheduleSnippetToSocial no longer writes platform_target into post_type",
    !/post_type:\s*snippet\.platform_target/.test(sched),
  )

  // (b) repurposed_content_log.source_id is uuid NOT NULL — "" is 22P02.
  const log = body(repurpose, "logRepurposedContent")
  check("logRepurposedContent validates sourceId as a uuid", /isValidUUID\(\s*data\.sourceId\s*\)/.test(log))
  check(
    "scheduleSnippetToSocial no longer passes an empty-string sourceId",
    !/sourceId:\s*snippet\.video_project_id\s*\|\|\s*snippet\.source_video_asset_id\s*\|\|\s*""/.test(
      body(repurposeL, "scheduleSnippetToSocial"),
    ),
  )

  // (c) a DELETE that matches nothing SUCCEEDS in postgrest.
  const del = body(repurposeL, "deleteSnippet")
  check("deleteSnippet asks postgrest for an exact count", /delete\(\{\s*count:\s*"exact"\s*\}\)/.test(del))
  check("deleteSnippet refuses when nothing was deleted", /if\s*\(\s*!count\s*\)/.test(del))

  // (d) generateCaptionVariations used to echo the input back as a "result".
  const cap = body(repurposeL, "generateCaptionVariations")
  check(
    "generateCaptionVariations no longer echoes the input caption as a fake result",
    !/caption:\s*params\.originalCaption\s*,/.test(cap),
  )
  check(
    "generateCaptionVariations returns an explicit failure verdict",
    /success:\s*false/.test(cap),
  )

  // (e) identity class: social_media_accounts.agent_id is AGENTS-class, and the
  //     browser only ever holds a USERS id.
  const soc = body(create, "getSocialAccountsForDistribution")
  check(
    "getSocialAccountsForDistribution resolves users→agents through the helper",
    calls(soc, "resolveAgentIdInBrokerage"),
  )
  const socL = body(createL, "getSocialAccountsForDistribution")
  check(
    "getSocialAccountsForDistribution no longer compares a users id to agent_id",
    !/\.eq\("agent_id",\s*agentId\)/.test(socL),
  )

  // (f) supabase-js RESOLVES a failed query. Every read/write in the touched
  //     functions must destructure `error`.
  for (const [file, canonical, fns] of [
    [REPURPOSE_ACTIONS, repurpose, ["getRepurposedContentLogs", "deleteSnippet", "getSnippetById", "logRepurposedContent"]],
    [CREATE_PROJECT, create, ["getVideoProject", "getVideoProjects", "getSocialAccountsForDistribution", "requireCaller", "requireProjectInCallerBrokerage"]],
  ] as const) {
    for (const fn of fns) {
      const slice = body(canonical as string, fn)
      const awaits = (slice.match(/await\s+(supabase|svc|query)\b/g) ?? []).length
      const destructured = (slice.match(/\{[^}]*\berror\b[^}]*\}\s*=\s*await/g) ?? []).length
        + (slice.match(/const\s*\{\s*error[^}]*\}\s*=\s*await/g) ?? []).length
      // `slice.length > 0` is load-bearing: without it a RENAMED or deleted
      // function produced an empty slice, awaits===0, and the check passed
      // vacuously — it could not be made to fail.
      // `destructured >= awaits` is likewise load-bearing: one destructured
      // query used to excuse every other bare `await supabase` beside it.
      check(
        `${file.split("/").pop()}:${fn} destructures error on its queries`,
        slice.length > 0 && destructured >= awaits,
        `awaits=${awaits} destructured=${destructured} sliceLen=${slice.length}`,
      )
    }
  }

  // (g) generateAIScript and improveScript burn paid inference — both gated.
  check("generateAIScript authenticates before it spends", calls(body(create, "generateAIScript"), "requireCaller"))
  check("improveScript authenticates before it spends", calls(body(create, "improveScript"), "requireCaller"))
  check(
    "generateAIScript no longer trusts a caller-supplied brokerageId",
    !/brokerageId:\s*params\.brokerageId/.test(body(create, "generateAIScript")),
  )
}

// ─── 6. VOCABULARY — the constants match what the code enforces ─────────────

console.log("\n[Layer 1 · status vocabulary is one list, in a non-'use server' module]")
{
  // Tightened with the `=`: without it, a renamed REPURPOSE_LOG_STATUSES_ZZ
  // still satisfied the prefix and the check could not be made to fail.
  check(
    "REPURPOSE_LOG_STATUSES lives in the utils (non-'use server') module",
    /export const REPURPOSE_LOG_STATUSES\s*=/.test(utilsL),
  )
  check(
    "REPURPOSE_LOG_APPROVAL_STATUSES lives there too",
    /export const REPURPOSE_LOG_APPROVAL_STATUSES\s*=/.test(utilsL),
  )
  check(
    "the action module imports the vocabulary rather than redeclaring it",
    /REPURPOSE_LOG_STATUSES/.test(repurposeL) && !/export const REPURPOSE_LOG_STATUSES/.test(repurposeL),
  )
  check(
    "getRepurposedContentLogs validates status against that list",
    /REPURPOSE_LOG_STATUSES/.test(body(repurposeL, "getRepurposedContentLogs")),
  )
  check(
    "getFilteredRepurposeHistory validates approvalStatus against that list",
    /REPURPOSE_LOG_APPROVAL_STATUSES/.test(body(repurposeL, "getFilteredRepurposeHistory")),
  )

  // THIS ASSERTION USED TO PIN THE DIVERGENCE IN PLACE. The picker read the
  // D-ID cron's terminal token ('completed') while create-video-project's
  // pollVideoStatus writes 'ready', and this check asserted the picker was
  // "unchanged" — which locked in a reader that could only ever see one of the
  // pipeline's several success tokens.
  //
  // That was the narrow case of a wider defect: ai_video_projects.status has
  // five tokens meaning "this video is finished" (completed, ready, uploaded,
  // published, distributed) and every reader that hard-coded 'completed' made
  // the other four invisible. The worst was 'distributed' — lib/kernel/video.ts
  // writes it on a SUCCESSFUL distribution, so succeeding removed the video
  // from this very picker.
  //
  // The picker now reads the one shared VIDEO_FINISHED_STATUSES list, so the
  // cron's token and pollVideoStatus's token are both accepted and the two can
  // no longer disagree. Assert THAT — a reader that goes back to a single
  // hard-coded token fails here.
  const pageL = stripCommentsOnly(load("app/dashboard/campaigns/repurpose/page.tsx"))
  check(
    "the repurpose source picker reads the shared finished-video list, not one hard-coded token",
    /\.in\("status",\s*VIDEO_FINISHED_STATUSES/.test(pageL) &&
      !/\.eq\("status",\s*"completed"\)/.test(pageL),
  )
  // And that list must still be the single source — not re-spelled locally.
  const policyL = stripCommentsOnly(load("lib/video/video-pipeline-reaper-policy.ts"))
  const statusL = stripCommentsOnly(load("lib/video/video-status.ts"))
  check(
    "VIDEO_FINISHED_STATUSES covers every success token the pipeline writes",
    // m374 collapsed the five finished spellings into two: ready/video_ready/
    // uploaded/preview_ready all became `completed`, and `distributed` became
    // `published`. The list is now the CANONICAL pair, and it lives in
    // lib/video/video-status.ts — the reaper policy only re-exports it.
    ["completed", "published"].every((t) =>
      new RegExp(`"${t}"`).test(
        statusL.slice(statusL.indexOf("VIDEO_FINISHED_STATUSES"), statusL.indexOf("VIDEO_FINISHED_STATUSES") + 300),
      ),
    ) &&
      // and the retired spellings must NOT have crept back into it
      !/VIDEO_FINISHED_STATUSES[\s\S]{0,300}"(ready|uploaded|distributed|video_ready)"/.test(statusL),
  )
  // THIS ASSERTION EXISTED TO PIN A DIVERGENCE THAT IS NOW GONE. pollVideoStatus
  // persisted `ready` while every reader looked for `completed`, and this check
  // asserted that mismatch stayed put. m374 retired `ready` into `completed`, so
  // the write and the readers finally agree and there is nothing left to pin.
  //
  // What still matters is that the PERSISTED WRITE uses a canonical token — the
  // CHECK constraint now rejects anything else, so a regression here is a
  // runtime insert failure, not a silent mismatch. Anchor on the update's
  // neighbouring column so only the write, never the return object, satisfies it.
  check(
    "pollVideoStatus persists a canonical terminal token, not a private spelling",
    /status:\s*"completed",\s*provider_status:/.test(body(createL, "pollVideoStatus")),
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// LAYER 2 — LIVE (creds-gated, skips LOUDLY)
// ═════════════════════════════════════════════════════════════════════════════

async function testLive() {
  console.log("\n[Layer 2 · live database — schema + seeded round-trip]")

  const hasUrl = !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  const hasKey = !!process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!hasUrl || !hasKey) {
    console.log("  ⏭  SKIPPED — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.")
    console.log("     The pure layer above ran in full. Nothing here was scored.")
    return
  }

  let svc: any
  try {
    const mod = await import("../lib/supabase/service")
    svc = mod.createServiceClient()
  } catch (err: any) {
    console.log(`  ⏭  SKIPPED — could not build the service client: ${err?.message}`)
    return
  }

  // Reachability probe FIRST. A network error must never be scored as a pass.
  const probe = await svc.from("brokerages").select("id").limit(1)
  if (probe.error) {
    console.log(`  ⏭  SKIPPED — database unreachable: ${probe.error.message}`)
    console.log("     Not scored as a pass or a failure.")
    return
  }

  // ── The CHECK constraints this rail's literals depend on ──
  const constraintSql = `
    select conname, pg_get_constraintdef(oid) as def
    from pg_constraint
    where conrelid in ('social_posts'::regclass, 'repurposed_content_log'::regclass,
                       'video_snippets'::regclass, 'ai_video_projects'::regclass)
      and contype = 'c'`
  const { data: cons, error: consErr } = await svc.rpc("exec_sql", { sql: constraintSql }).then(
    (r: any) => r,
    () => ({ data: null, error: { message: "no exec_sql rpc" } }),
  )
  if (consErr || !cons) {
    console.log("  ⏭  constraint introspection unavailable through the client (needs exec_sql) — schema asserted by round-trip instead.")
  } else {
    const defs: string = JSON.stringify(cons)
    check("social_posts.post_type CHECK admits 'custom'", /custom/.test(defs))
    check("social_posts.post_type CHECK does NOT admit 'instagram_reels'", !/instagram_reels/.test(defs))
  }

  // ── ai_video_projects.status has NO check → free text, writers decide ──
  const statusProbe = await svc.from("ai_video_projects").select("id, status").limit(1)
  check("ai_video_projects is readable through the service client", !statusProbe.error, statusProbe.error?.message)

  // ── Seeded round-trip on repurposed_content_log ──
  const { data: brk, error: brkErr } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (brkErr || !brk) {
    console.log("  ⏭  no brokerage row — skipping the seeded round-trip.")
    return
  }
  const brokerageId = (brk as { id: string }).id
  const NOTE_TAG = `__vrw_sim_${Date.now()}__`
  const seeded: string[] = []

  try {
    // The vocabulary the code writes must be accepted, and the one it refuses
    // must be rejected — proven against the live CHECK, not against a comment.
    const good = await svc
      .from("repurposed_content_log")
      .insert({
        brokerage_id: brokerageId,
        source_type: "video_project",
        source_id: "00000000-0000-0000-0000-000000000001",
        output_type: "snippet",
        output_ref_table: "video_snippets",
        output_ref_id: "00000000-0000-0000-0000-000000000002",
        status: "generated",
        approval_status: "pending_review",
        notes: NOTE_TAG,
      })
      .select("id")
      .maybeSingle()
    check("repurposed_content_log accepts status='generated' / approval='pending_review'", !good.error, good.error?.message)
    if (good.data?.id) seeded.push(good.data.id)

    const bad = await svc
      .from("repurposed_content_log")
      .insert({
        brokerage_id: brokerageId,
        source_type: "video_project",
        source_id: "00000000-0000-0000-0000-000000000001",
        output_type: "snippet",
        output_ref_table: "video_snippets",
        output_ref_id: "00000000-0000-0000-0000-000000000002",
        status: "pending",
        approval_status: "pending_review",
        notes: NOTE_TAG,
      })
      .select("id")
      .maybeSingle()
    check("repurposed_content_log REFUSES an off-vocabulary status ('pending')", !!bad.error)
    if (bad.data?.id) seeded.push(bad.data.id)

    // supabase-js resolves rather than throws — the refusal above arrives as
    // `error`, which is precisely the class this rail keeps getting wrong.
    check("the refusal arrived as `error`, not as a thrown exception", bad.error !== undefined)
  } finally {
    // ── CLEAN UP AND RE-COUNT ──
    const { error: delErr } = await svc.from("repurposed_content_log").delete().eq("notes", NOTE_TAG)
    check("seeded rows deleted without error", !delErr, delErr?.message)
    const { count, error: countErr } = await svc
      .from("repurposed_content_log")
      .select("id", { count: "exact", head: true })
      .eq("notes", NOTE_TAG)
    check("residue re-count is 0", !countErr && (count ?? 0) === 0, countErr?.message ?? `count=${count}`)
  }
}

// ═════════════════════════════════════════════════════════════════════════════

await testLive()

console.log("\n" + "─".repeat(62))
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log("\n FAILURES:")
  for (const f of failures) console.log(`   · ${f}`)
  console.log("\n ❌ VIDEO_REPURPOSE_WIRING_FAIL")
  process.exit(1)
}
console.log(" ✅ VIDEO_REPURPOSE_WIRING_PASS — orphans wired, tenant gate structural, no third render writer")
