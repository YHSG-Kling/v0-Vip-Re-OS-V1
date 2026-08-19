#!/usr/bin/env tsx
/**
 * scripts/orphan-export-guard.ts (npm run test:orphan-exports)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FUNCTION-LEVEL ORPHAN LEDGER — A WIRE LIST, NOT A DELETE LIST.
 *
 * READ THIS BEFORE ACTING ON THE OUTPUT.
 *
 * Everything this guard reports is a capability that was BUILT and never
 * CONNECTED. The correct response to an entry is to finish wiring it to the
 * surface it was written for. It is NOT permission to delete. Deleting an
 * unwired capability is how a quarter of a working system disappears one
 * "cleanup" at a time, and it has already happened once in this repo.
 *
 * Deletion requires a NAMED DUPLICATE — `file.ts:functionName` that does the same
 * job MORE completely — established by reading both, not by this count.
 *
 * WHY THIS EXISTS ALONGSIDE test:no-orphan-actions.
 *
 * That guard asks "is this FILE imported by anything?" and the answer across
 * app/actions is yes, 545 out of 545 — zero orphans. But a file with fourteen
 * exports is "wired" the moment ONE of them is imported. The other thirteen can
 * be unreachable and the file-level guard reports a clean sheet.
 *
 * At function level the picture is different, and it is the honest one:
 * hundreds of exported server actions and library functions that nothing
 * anywhere calls. Verified by hand on a sample — getPendingFollowups,
 * loadRevenueSummaryAction, markBrokerageSetupCompleteAction,
 * retrySubscriberInvite — each has zero references outside its own file.
 *
 * HOW IT COUNTS. An export is orphaned when its name appears in NO other file in
 * the repo. That deliberately treats a barrel re-export as a reference: if
 * app/actions/index.ts names it, it is reachable, and the wiring question moves
 * to the barrel's consumers. Same-file references (its own logs, its own
 * helpers) do not count — a function that only calls itself is still orphaned.
 *
 * KNOWN BLIND SPOT, stated so nobody trusts this further than it deserves:
 * anything reached ONLY through a string-keyed registry or dynamic dispatch
 * looks orphaned here. Check for that before concluding a capability is unused.
 *
 * The baseline is per-file counts and may only go DOWN. Wiring one export lowers
 * its file's count; adding a new unwired export raises it and fails.
 */
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { stripComments } from "./strip-comments"

const root = process.cwd()
/**
 * Vendor + build output. These nest legitimately (a package can carry its own
 * node_modules), so they are skipped at EVERY depth.
 */
const SKIP_ANY_DEPTH = new Set([
  "node_modules", ".next", ".git", "coverage", "dist", "build",
])

/**
 * Skipped ONLY as top-level repository directories.
 *
 * These were previously in the same set as the vendor dirs, and walk() tested
 * the bare directory NAME at every depth, so any nested directory that happened
 * to share a name vanished from the corpus — as an export source AND, more
 * damagingly, as a REFERENCE source. Four real product directories were
 * invisible: app/actions/public (server actions), app/api/scripts (routes),
 * app/dashboard/isa/scripts, and lib/supabase. An export whose only caller
 * lived in one of them read as orphaned purely because the caller could not be
 * seen — services/supabase.ts:createBrowserClient was exactly that, referenced
 * from lib/supabase/client.ts.
 *
 * The intent was always to skip the top-level supabase/ migrations directory,
 * the top-level scripts/ proof corpus (walked separately as proofRoot below),
 * public/ assets, and the vendored .claude/ + plugins/ trees — never their
 * same-named descendants.
 */
const SKIP_TOP_LEVEL = new Set([
  "public", "scripts", ".claude", "plugins", "supabase",
])

/**
 * Directories whose exports are expected to be consumed by name somewhere.
 *
 * `services/` was a blind spot: the roots were ["app", "lib"], so its live
 * files — supabaseService.ts (14 importers, one of them lib/orchestrator/
 * internal.ts), supabase.ts (16), aiMappingService.ts, goHighLevelService.ts —
 * had never been measured at all. Most of the directory exports namespace
 * OBJECTS (`export const x = {...}`), which the regexes below do not match, so
 * only its `export function` / arrow-function exports enter the ledger: 15 of
 * them, 12 from goHighLevelService.ts and 3 from supabase.ts.
 *
 * ADDING THIS ROOT RAISED THE BASELINE (8876 → 8891 scanned, 1499 → 1508
 * unreferenced, category C 367 → 376) and that increase is a MEASUREMENT
 * EXPANSION, not a regression: nothing was added, a directory that was always
 * unreferenced simply became visible. The ~9 that landed in C were the
 * zero-caller GoHighLevel reads and bulk sync — getGHLContact,
 * searchGHLContacts, getGHLConversations, getGHLMessages, getGHLContactNotes,
 * addGHLContactTags, removeGHLContactTags, bulkSyncContactsToGHL.
 *
 * THAT BACKLOG LINE IS RETIRED (orphan burn-down, lane O). It said the GHL read
 * side "is the platform-staff book-import direction, so these are a backlog to
 * finish" — and it HAS since been finished, but in lib/crm/import-pull.ts, not
 * in services/. `pullGoHighLevel` (import-pull.ts:142, dispatched by
 * pullCrmPage and called from app/actions/lead-import/crm-pull-actions.ts) is
 * the tenant-credentialed, cursor-paginated, gate-routed read those two were
 * a weaker second copy of. All eight are now gone, each with a tombstone in
 * services/goHighLevelService.ts naming its survivor. The four that ARE wired
 * (syncContactToGHL, logGHLCall, addGHLContactNote,
 * getContactConversationHistory) prove the file is live.
 */
// `hooks` added after the use-server guard was found reporting green over a
// directory it never opened. Auditing every sweep's file walk for the same
// narrowing turned up this one: the census covered app, lib and services (the
// latter added when services/ was found uncensused) and had never once opened
// hooks/, so it reported a precise-looking 1437 while 33 exported hooks sat
// outside the count — 29 of them referenced by nothing anywhere in the tree,
// including the twenty data hooks in hooks/use-dashboard-data.ts
// (useTransactions, useContacts, useListings, useOffers, useCommissions, …),
// which together are an entire unwired data layer.
//
// This RAISES the number, and that is the point: it is a measurement fix, the
// same shape as the prose-only-reference correction that took the count from 29
// to 240. A census that quietly excludes a directory is not a smaller problem,
// it is an unmeasured one, and the reported figure was wrong in the flattering
// direction.
//
// NOT a delete list — the standing rule holds: an unwired capability is work to
// FINISH. These hooks are now visible so they can be wired or consciously ruled
// on, instead of being invisible to the instrument that exists to find them.
// ─── AND THEN THE SAME NARROWING WAS FOUND A FOURTH TIME ────────────────────
// The list above was the instrument's reach, and a hand-written list only ever
// covers what someone remembered to type. `services/` was added when it was
// found uncensused; `hooks/` was added when the same audit found 33 exported
// hooks outside the count. Both times the list was extended by one name and left
// a list. FIVE more top-level directories ship TypeScript and none of them was
// ever opened as an export source: remotion/ (42 files, and it RENDERS —
// compositions are real runtime), types/, constants/, contexts/, workflows/,
// plus the root-level proxy.ts and types.ts.
//
// constants/crm-standards.ts is the one that surfaced it: a burn-down lane moved
// a live map onto it as the survivor of a deletion, and only afterwards noticed
// that nothing in constants/ is measured at all — the "survivor" it had chosen
// was in a directory the census cannot see.
//
// So the roots are now DERIVED from the corpus instead of typed into it: every
// top-level directory that contributes TypeScript, minus the ones named below
// with a reason. walk() already excluded the vendor and non-product directories
// before this point, and the REFERENCE corpus was ALREADY the whole tree — only
// the EXPORT side was narrowed. So widening here cannot invent an orphan by
// failing to see its caller; it can only reveal exports that were always there.
//
// This RAISES the number, and that is the point, exactly as it was for hooks/
// and for the prose-only-reference correction that took the count from 29 to
// 240. A census that quietly excludes a directory is not a smaller problem, it
// is an unmeasured one, and the reported figure was wrong in the flattering
// direction.

/** Directories that hold TypeScript but whose exports are not product surface. */
const NON_RUNTIME_EXPORT_ROOTS = new Set([
  "e2e",   // Playwright harness — its exports are fixtures, consumed by the runner, not by the app
])

/** Root-level .ts files ship too (proxy.ts, types.ts); "" is their prefix. */
function scannedRoots(all: string[]): string[] {
  const roots = new Set<string>()
  for (const f of all) {
    const slash = f.indexOf("/")
    const top = slash === -1 ? "" : f.slice(0, slash)
    if (NON_RUNTIME_EXPORT_ROOTS.has(top)) continue
    // Dot-directories are configuration and agent scaffolding (.agents, .claude,
    // .github), never product runtime. They stay in the REFERENCE corpus — a
    // config file that names an export is still evidence of use — but nothing in
    // them is a product export to be held to account.
    if (top.startsWith(".")) continue
    roots.add(top)
  }
  return [...roots].sort()
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return out }
  // Anchored, not by bare name. proofRoot below calls walk() STARTING inside
  // scripts/, where atRoot is false — so the top-level skip never hides the
  // proof corpus from itself.
  const atRoot = dir === root
  for (const e of entries) {
    if (SKIP_ANY_DEPTH.has(e)) continue
    if (atRoot && SKIP_TOP_LEVEL.has(e)) continue
    const p = join(dir, e)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e) && !/\.d\.ts$/.test(e)) out.push(p)
  }
  return out
}

const files = walk(root).map((f) => relative(root, f).replace(/\\/g, "/"))
const corpus = new Map<string, string>()
for (const f of files) {
  try { corpus.set(f, readFileSync(join(root, f), "utf8")) } catch { corpus.set(f, "") }
}

/** Comments stripped so a mention in prose does not count as an export or a use. */
function code(f: string): string {
  const raw = corpus.get(f) ?? ""
  // WAS two regexes: block comments first, then line comments. That order is the
  // defect — a slash-star inside a LINE comment opened a block comment for the
  // first regex, which then ran to the next star-slash anywhere below and deleted
  // the code in between. It cost this census its credibility twice: once
  // swallowing ~670 lines, and once swallowing 5,936 of 12,967 characters of
  // compliance-bridge-panel.tsx — which made two WIRED server actions
  // (emitCompliancePassedAction, loadComplianceBridgeStatusAction) read as
  // "referenced NOWHERE". An analyzer that under-reads does not go quiet; it
  // accuses working code. stripComments() is a single left-to-right scan that
  // tracks state, which is the only thing that can actually decide this.
  return stripComments(raw)
}

const codeCache = new Map<string, string>()
for (const f of files) codeCache.set(f, code(f))

/**
 * A CALL SITE, NOT A MENTION.
 *
 * code() strips comments, so prose in a /* *\/ block never counted as a use.
 * STRING LITERALS survived it, and that hole was load-bearing: 240 exports were
 * classed "referenced" on the strength of a name appearing inside a string, 231
 * of them inside the narrative `what:` fields of lib/kernel/manager-registry.ts.
 * One of those passages literally reads "NOTHING WAS DELETED: addAgentExpense,
 * setAgentGoal and assignAgentToContact each have a named more-complete
 * survivor" — so the registry's own record of retiring three functions was the
 * only thing keeping them off the burn-down list. Documentation was masquerading
 * as wiring.
 *
 * String-DISPATCH is not affected, and that was checked before this landed:
 * workflows.ts `handlers[toolName]` and manager-signals.ts `SIGNAL_HANDLERS[...]`
 * look up tables whose VALUES are assigned in code, so the string is the key and
 * the function is still named executably. Same for lib/orchestrator/internal.ts,
 * which reaches its targets as `m.handleVideoGenerated` — a property access, not
 * a string.
 *
 * Contents are blanked but the quotes are kept, so nothing downstream that
 * counts or slices this text shifts.
 *
 * DELIBERATELY NOT APPLIED TO proofCorpus below: a proof legitimately names the
 * capability it stands over inside a string (a needs: [...] list, a table of
 * expected symbols). Stripping there would collapse category A into C and
 * report proven-but-unwired work as dead — the exact misread this guard exists
 * to prevent.
 */
function callSites(src: string): string {
  // `\\.` DOES NOT MATCH A BACKSLASH-NEWLINE — `.` excludes newline in JS regex. A
  // template literal containing a line continuation therefore failed to match, the
  // scanner paired the WRONG backticks, and everything to the next one was masked
  // away. lib/agents/asset-manager.ts collapsed from 36,824 characters to 5,745 —
  // 85% of the file gone as a reference source — which hid the only caller of
  // lib/remotion/registry.ts:listCompositionsForTier and reported it as an orphan.
  // Second false-accusation mechanism found in this census in one wave, and like
  // the first it was a lane refusing to delete live code that surfaced it.
  // `\\[\s\S]` consumes the escaped character whatever it is, newline included.
  return src
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
    .replace(/"(?:\\[\s\S]|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\[\s\S]|[^'\\\n])*'/g, "''")
}

const useCache = new Map<string, string>()
for (const f of files) useCache.set(f, callSites(codeCache.get(f)!))

interface ExportRef { file: string; name: string }

const SCANNED_ROOTS = scannedRoots(files)

const exportsFound: ExportRef[] = []
for (const f of files) {
  // "" is the root-level prefix and matches every path, so it is tested as
  // "has no slash" rather than as a prefix.
  const top = f.indexOf("/") === -1 ? "" : f.slice(0, f.indexOf("/"))
  if (!SCANNED_ROOTS.includes(top)) continue
  // STRING-MASKED, not just comment-stripped. The comment-stripped text still
  // carried string LITERALS, and the export regex matched inside them: the
  // cross-referral sweep registry stores each sweep's grep marker as data —
  // `marker: "export async function publishApprovalSlaReferrals"` — and every
  // such row minted a PHANTOM export (five of them, all in
  // lib/managers/cross-referral.ts), double-counting functions that exist once.
  // callSites() blanks string contents but keeps the quotes, so a declaration's
  // own name (never inside a string) still matches while quoted prose cannot.
  const src = useCache.get(f)!
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g)) {
    exportsFound.push({ file: f, name: m[1] })
  }
  for (const m of src.matchAll(/export\s+const\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/g)) {
    exportsFound.push({ file: f, name: m[1] })
  }
}

const orphans: ExportRef[] = []
for (const e of exportsFound) {
  const re = new RegExp(`\\b${e.name.replace(/\$/g, "\\$")}\\b`)
  let referenced = false
  for (const f of files) {
    if (f === e.file) continue
    if (re.test(useCache.get(f)!)) { referenced = true; break }
  }
  if (!referenced) orphans.push(e)
}

const proofRoot = join(root, "scripts")
const proofCorpus: string[] = []
if (existsSync(proofRoot)) {
  for (const f of walk(proofRoot)) {
    try {
      proofCorpus.push(
        stripComments(readFileSync(f, "utf8")),
      )
    } catch { /* unreadable file contributes nothing */ }
  }
}

/** Does any OTHER product file name this export? */
const usedInProduct = (name: string, from: string) => {
  const re = new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`)
  return files.some((f) => f !== from && re.test(useCache.get(f)!))
}

const reachedModule = new Map<string, boolean>()
for (const o of orphans) {
  if (reachedModule.has(o.file)) continue
  reachedModule.set(
    o.file,
    exportsFound.some((e) => e.file === o.file && usedInProduct(e.name, o.file)),
  )
}

const cat = { proofOnly: 0, internal: 0, trulyDead: 0 }
const deadByFile: Record<string, number> = {}
/** Category C members, kept so the backlog can actually be READ (see --list). */
const deadExports: Array<{ file: string; name: string }> = []
for (const o of orphans) {
  const re = new RegExp(`\\b${o.name.replace(/\$/g, "\\$")}\\b`)
  const selfHits = (useCache.get(o.file)!.match(new RegExp(re.source, "g")) ?? []).length
  if (proofCorpus.some((p) => re.test(p))) cat.proofOnly++
  else if (reachedModule.get(o.file) && selfHits > 1) cat.internal++
  else {
    cat.trulyDead++
    deadByFile[o.file] = (deadByFile[o.file] ?? 0) + 1
    deadExports.push({ file: o.file, name: o.name })
  }
}

/**
 * `--list` — print category C and exit WITHOUT asserting.
 *
 * The C number was unactionable on its own: a burn-down list you cannot read is
 * just a number that shames you. This enumerates it, densest file first, so the
 * work can be triaged against real candidates instead of guessed at.
 *
 * Read-only and assertion-free ON PURPOSE. It runs before the ratchet below and
 * exits 0 regardless, so it can never be mistaken for a passing guard run and
 * can never be wired into the chain as one.
 */
if (process.argv.includes("--list")) {
  const byFile = new Map<string, string[]>()
  for (const d of deadExports) {
    if (!byFile.has(d.file)) byFile.set(d.file, [])
    byFile.get(d.file)!.push(d.name)
  }
  const ordered = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  console.log(`\n[category C — referenced NOWHERE] ${cat.trulyDead} exports across ${ordered.length} files\n`)
  for (const [file, names] of ordered) {
    console.log(`  ${file}  (${names.length})`)
    for (const n of names.sort()) console.log(`      ${n}`)
  }
  console.log(`\nNOT AN ASSERTION — this is the backlog, not a verdict. Wire these to the`)
  console.log(`surface they were written for; do not delete them to move the number.`)
  process.exit(0)
}


const counts: Record<string, number> = {}
for (const o of orphans) counts[o.file] = (counts[o.file] ?? 0) + 1

const baselinePath = join(root, "scripts", "orphan-export-baseline.json")

/**
 * THE CENSUS — the half of this guard that protects capabilities.
 *
 * The orphan count alone is a TRAP. It falls when an export is wired up, and it
 * falls exactly as fast when the export is DELETED. A ratchet that only watches
 * that number rewards deletion and calls it progress — which is precisely how a
 * batch of agents once removed 15 working capabilities and left the metric
 * looking better than before.
 *
 * So the census records how many exported functions EXIST. Wiring one keeps the
 * census flat and lowers the orphan count. Deleting one lowers BOTH, and the
 * census floor turns that into a CI failure that names the files.
 *
 * Lowering the census is a real operation — collapsing a genuine duplicate is
 * legitimate — but it must be a deliberate, reviewed act with a named duplicate,
 * not a side effect of a cleanup pass. Re-baselining is how you declare it.
 */
interface Baseline {
  /** Per-file orphan counts. May only go DOWN. */
  files: Record<string, number>
  /** Total exported functions in the scanned roots. May NOT go down silently. */
  census: number
  /** Per-file export census, so a drop can name the file that lost capability. */
  fileCensus: Record<string, number>
  /**
   * Per-file export NAMES. The census above counts; this one identifies.
   *
   * Counting alone cannot tell a MOVE from a DELETION, and it cannot see a swap
   * at all — delete `foo` from a file and add an unrelated `bar` to it and the
   * count is unchanged while a capability is gone. Names close both holes.
   */
  fileExports: Record<string, string[]>
}

const fileCensus: Record<string, number> = {}
const fileExports: Record<string, string[]> = {}
for (const e of exportsFound) {
  fileCensus[e.file] = (fileCensus[e.file] ?? 0) + 1
  ;(fileExports[e.file] ??= []).push(e.name)
}

if (process.env.ORPHAN_EXPORT_BASELINE === "1") {
  // trulyDead is recorded so the REAL backlog has a ratchet of its own. The
  // per-file counts above cannot serve that purpose: a file can hold its count
  // steady while a live internal helper turns into an unreachable one.
  const next = {
    files: counts, census: exportsFound.length, fileCensus, fileExports,
    trulyDead: cat.trulyDead,
  } as Baseline & { trulyDead: number }
  writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`)
  console.log(`Baseline written: ${orphans.length} orphaned of ${exportsFound.length} exports across ${Object.keys(counts).length} files.`)
  console.log(`  A. proof-only ${cat.proofOnly} · B. internal/live ${cat.internal} · C. referenced nowhere ${cat.trulyDead}`)
  process.exit(0)
}

const raw = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : {}
// Tolerate the pre-census baseline shape so this guard can be upgraded in place.
const baselineObj: Baseline = raw.files
  ? raw
  : { files: raw as Record<string, number>, census: 0, fileCensus: {} }

const baseline = baselineObj.files
const baselineTotal = Object.values(baseline).reduce((a, b) => a + b, 0)

console.log("\n[orphan-export guard — exported functions nothing else references]")
console.log(`  ${exportsFound.length} exported functions scanned · ${orphans.length} unreferenced (baseline ${baselineTotal})`)
// The roots are derived, so they are PRINTED. A derived list nobody can see is the
// same opacity the hand-written list had, wearing a better hat.
console.log(`  export roots (derived): ${SCANNED_ROOTS.map((r) => r || "<repo root>").join(", ")}`)

const regressionsDead: string[] = []

// ── WHAT "UNREFERENCED" ACTUALLY MEANS — three very different things ────────
//
// The single number above conflated three populations, and acting on it as if
// it were one backlog is dangerous in BOTH directions: it invites wiring code
// that already runs, and deleting code that is load-bearing.
//
//   A. PROOF-ONLY — referenced from scripts/ but from nothing in app/ or lib/.
//      This guard deliberately excludes the top-level scripts/ from the corpus
//      (SKIP_TOP_LEVEL — anchored, so app/api/scripts is still measured) so
//      that "a simulator imports it" never counts as "the product uses it".
//      That is the right call, and it means these have a proof standing over a
//      capability no surface reaches yet. Real work, but a different KIND of
//      work: the proof already describes the contract.
//
//   B. INTERNAL HELPER of a module the product DOES reach. The header says a
//      same-file reference does not count, "a function that only calls itself is
//      still orphaned" — true for a lone self-recursive function, but it also
//      catches every exported helper that its own module's reachable entry point
//      calls. Worked example: lib/analytics/prediction-accuracy.ts exports
//      summarizeDomRows, which is called at line 1346 of that same file by
//      getPredictionAccuracyReport — and THAT is imported by /dashboard/analytics
//      and the superadmin platform page. The helper runs on every page load.
//      Same shape in lib/kernel/client-story-drafts.ts (sellerUpdateBrief, called
//      in-file by a runner the deal-health-scan cron invokes) and in
//      lib/video/director-content.ts (prop builders behind
//      resolveDirectorContentProps, imported by video-director.ts).
//      THESE ARE LIVE. Wiring them would duplicate a call that already happens;
//      deleting them would break a working feature. Category B is not a backlog.
//
//   C. REFERENCED NOWHERE — not in the product, not in a proof, not even by its
//      own module. This is the honest burn-down list.
//
// Reported, not enforced, except for C: A and B move for legitimate reasons, but
// C growing means a genuinely unreachable export was just added.
console.log(`     A. proof-only (a simulator names it, no surface does)  ${cat.proofOnly}`)
console.log(`     B. internal helper of a REACHED module — LIVE CODE     ${cat.internal}`)
console.log(`     C. referenced NOWHERE — the real burn-down list        ${cat.trulyDead}`)
if (cat.proofOnly + cat.internal + cat.trulyDead !== orphans.length) {
  console.log(`     ! classification does not reconcile with ${orphans.length} — treat the split as unproven`)
}
const baselineDead = (baselineObj as any).trulyDead as number | undefined
if (typeof baselineDead === "number" && cat.trulyDead > baselineDead) {
  regressionsDead.push(`category C grew ${baselineDead} → ${cat.trulyDead} — a genuinely unreachable export was added`)
}

const regressions: string[] = []
for (const [file, count] of Object.entries(counts)) {
  const allowed = baseline[file] ?? 0
  if (count > allowed) {
    regressions.push(`${file} — ${count} unreferenced export(s) (baseline ${allowed})`)
  }
}

const improved: string[] = []
for (const [file, allowed] of Object.entries(baseline)) {
  const now = counts[file] ?? 0
  if (now < allowed) improved.push(`${file}: ${allowed} → ${now}`)
}

if (improved.length > 0) {
  console.log(`\n  ↓ burned down in ${improved.length} file(s):`)
  for (const i of improved.slice(0, 20)) console.log(`     ${i}`)
  if (improved.length > 20) console.log(`     … and ${improved.length - 20} more`)
  console.log(`\n  Re-baseline with ORPHAN_EXPORT_BASELINE=1 npm run test:orphan-exports`)
}

// ── THE CENSUS CHECK — did a capability disappear? ──────────────────────────
//
// BY NAME, NOT BY COUNT. Counting per file cannot tell the two apart:
//
//   · MOVED  — extracted to another module. The capability still exists and every
//              caller still resolves it. Splitting a module so a pure leaf stops
//              dragging the server kernel into a client bundle is exactly this,
//              and it is a FIX. A count-only census calls it capability loss and
//              fails CI on correct work, which teaches people to re-baseline
//              reflexively — and a reflex re-baseline is how a real deletion gets
//              waved through.
//   · DELETED — the name is gone from the entire tree. That is the thing this
//              guard exists to catch.
//
// Names also close a hole counting never could: delete `foo` from a file and add
// an unrelated `bar` to it, and the count is unchanged while a capability is gone.
const lostCapability: string[] = []
const movedCapability: string[] = []
if (baselineObj.census > 0) {
  const baseNames = baselineObj.fileExports
  if (baseNames) {
    // Where each name is exported NOW, and where it was exported at baseline.
    const liveHomes = new Map<string, string[]>()
    for (const e of exportsFound) (liveHomes.get(e.name) ?? liveHomes.set(e.name, []).get(e.name)!).push(e.file)
    const baselineHomes = new Map<string, Set<string>>()
    for (const [f, names] of Object.entries(baseNames)) {
      for (const n of names) (baselineHomes.get(n) ?? baselineHomes.set(n, new Set()).get(n)!).add(f)
    }

    for (const [file, had] of Object.entries(baseNames)) {
      const nowHere = new Set(fileExports[file] ?? [])
      for (const name of had) {
        if (nowHere.has(name)) continue
        // A MOVE needs a NEW HOME — a file that exports this name now and did NOT
        // export it at baseline.
        //
        // "The name still exists somewhere" is not enough, and assuming it was is a
        // false negative this guard's own negative test caught: deleting
        // seller-context-presentation.ts:formatPrice was waved through because
        // app/lib/listing-utils.ts has always had an unrelated formatPrice. Common
        // names — formatPrice, getStats, handler — would mask each other's deletion
        // forever. A pre-existing same-named function in an unrelated module is a
        // COINCIDENCE, not a destination.
        const newHome = (liveHomes.get(name) ?? []).find(
          (f) => f !== file && !(baselineHomes.get(name)?.has(f)),
        )
        if (newHome) movedCapability.push(`${name}: ${file} → ${newHome}`)
        else lostCapability.push(`${file}:${name}`)
      }
    }
  } else {
    // Pre-names baseline: fall back to counting so the guard still protects a
    // repo that has not been re-baselined yet.
    for (const [file, had] of Object.entries(baselineObj.fileCensus)) {
      const now = fileCensus[file] ?? 0
      if (now < had) lostCapability.push(`${file} — ${had} → ${now} exported function(s)`)
    }
  }
}

if (movedCapability.length > 0) {
  console.log(`\n  → ${movedCapability.length} export(s) MOVED (still present elsewhere — not a loss):`)
  for (const m of movedCapability.slice(0, 20)) console.log(`     ${m}`)
  if (movedCapability.length > 20) console.log(`     … and ${movedCapability.length - 20} more`)
  console.log("     Re-baseline to record the new home: ORPHAN_EXPORT_BASELINE=1 npm run test:orphan-exports")
}

if (lostCapability.length > 0) {
  console.log(`\n  ✗ CAPABILITY REMOVED — ${lostCapability.length} export(s) exist NOWHERE in the tree:`)
  for (const l of lostCapability.slice(0, 25)) console.log(`     - ${l}`)
  if (lostCapability.length > 25) console.log(`     … and ${lostCapability.length - 25} more`)
  console.log("\n  An unwired capability is work to FINISH, never to remove. Deleting one")
  console.log("  lowers the orphan count too, which is exactly why that number alone")
  console.log("  cannot be trusted as progress.")
  console.log("\n  If a deletion is genuinely correct you must be able to NAME THE DUPLICATE")
  console.log("  it collapses into — file.ts:functionName that does the same job more")
  console.log("  completely — and then re-baseline deliberately:")
  console.log("     ORPHAN_EXPORT_BASELINE=1 npm run test:orphan-exports")
  console.log(" ❌ ORPHAN_EXPORT_FAIL — capability removed")
  process.exit(1)
}

console.log(`  census: ${exportsFound.length} exported functions (baseline ${baselineObj.census || "unset"})`)

console.log("\n──────────────────────────────────────────────────")
if (regressionsDead.length > 0) {
  console.log("")
  for (const r of regressionsDead) console.log(`  ✗ ${r}`)
  console.log("\n  Category C is the honest backlog: not reachable from the product, not")
  console.log("  named by a proof, not even used inside its own module. Wire it to the")
  console.log("  surface it was written for. Do not delete it to make this pass.")
  console.log(" ❌ ORPHAN_EXPORT_FAIL")
  process.exit(1)
}

if (regressions.length > 0) {
  console.log(`  ✗ ${regressions.length} file(s) gained an unreferenced export:`)
  for (const r of regressions.slice(0, 25)) console.log(`     - ${r}`)
  if (regressions.length > 25) console.log(`     … and ${regressions.length - 25} more`)
  console.log("\n  A new export with no caller is an unfinished feature. WIRE it to the")
  console.log("  surface it was written for — do not delete it, and do not raise the")
  console.log("  baseline to make this pass.")
  console.log(" ❌ ORPHAN_EXPORT_FAIL")
  process.exit(1)
}

console.log(` ✅ ORPHAN_EXPORT_PASS — no NEW unwired export (${orphans.length} on the wire-list, burn-down)`)
