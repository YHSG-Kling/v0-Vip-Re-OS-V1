/**
 * scripts/discarded-outcome-guard.ts
 *
 * test:discarded-outcome — THE UI MAY NOT CLAIM AN OUTCOME IT NEVER CHECKED.
 *
 * THE DEFECT, in the owner's words: the user executes something on the UI side,
 * it looks like it is running, the business process and the backend are
 * programmed correctly — and the middle does not know what it needs to do.
 *
 * Concretely:
 *
 *     await approveInspectionQuoteAction({ ... })   // returns {success:false,...}
 *     toast({ title: "Approved" })                  // says it worked regardless
 *     router.refresh()
 *
 * The action is correct. It checks authorisation, it checks that the transaction
 * belongs to the caller's brokerage, and it REPORTS failure honestly by
 * returning { success: false, error }. The caller throws that away. So a broker
 * clicks Approve, the spinner completes, the page refreshes, and nothing at all
 * happened — with no error anywhere, because nobody asked.
 *
 * THE DISCRIMINATOR THAT MAKES THIS PRECISE, and the reason a first attempt at
 * this detector was 48 hits of mostly-noise. There are two ways an action
 * reports failure, and only one of them can be dropped:
 *
 *   · THROWS  — `if (txnError) throw txnError`. The caller's try/catch handles
 *               it. Discarding the return value is CORRECT and common, e.g.
 *               assignTransactionCoordinator. Not a defect. Not flagged.
 *   · RETURNS — `return { success: false, error }`. The failure lives entirely
 *               in the value. Discard it and the failure ceases to exist.
 *
 * So this guard resolves each awaited call to its definition, keeps only the
 * actions that report failure BY RETURN, and flags the client callers that
 * discard the result and then show success anyway (a toast, a dialog close, a
 * router.refresh). That narrowed 48 candidates to a list where every entry is
 * the real shape.
 *
 * WHY THIS PATTERN IS DIFFERENT FROM THE OTHERS THIS REPO TRACKS. The identity
 * guards catch a wrong VALUE. The error-message guard catches a wrong
 * EXPLANATION. This one catches a missing CONVERSATION: two correct layers that
 * never exchanged the one fact that mattered. It is the hardest kind to notice
 * from the outside, because the screen shows exactly what success looks like.
 *
 * RATCHET, not an invariant. A discarded result can be legitimate — a
 * fire-and-forget telemetry ping, an action whose failure genuinely does not
 * change what the user should see. Each entry needs a human to decide whether
 * the user would want to know. The number may only go down.
 *
 * ── WAVE 143 (lane 143J — deduplication, UI functionality and feature certification) ──
 * THIS GUARD SAT AT ZERO WHILE TEN DISCARDED REFUSALS SHIPPED. Measured at 21da8e4e with the detector widened (below):
 * 10 dropped results in 7 files, every one real — the AI reply coach accepting / rejecting a draft the server refused
 * (the composer was handed the text and the toast said "accepted"); content-studio "Video deleted" for a video still
 * there; the buyer portal telling a buyer "Request sent — your agent will follow up" IN ITS CATCH BRANCH for a showing
 * that was never created; the CRM scheduler closing and clearing its form over a refused showing; the buyer bypass-verify
 * marking a buyer verified over a financial profile that was never written; the required-document rules (blocking ↔
 * warning, remove, attach template) whose refusals showed nothing; the impersonation Exit that could not end a session and
 * said nothing. All were fixed on their survivors (count 10 → 0: a fix, not a blind finder — section 5's controls recognise
 * every shape, and the pre-fix tree reproduces all ten). Two more were found beside it: a new section 1b for the same
 * defect over `fetch` (which RESOLVES on a 403 / 404 / 500 — the video library removed a script from the list and closed
 * its drawer on a refused DELETE; pre-fix tree reproduces it, 1 → 0), and, by hand, one the detector cannot see by design:
 * the CRM "Save property" insert declared best-effort with a false reason ("analytics/cache/annotation row") then toasted
 * "Property saved" — fixed to read the refusal. WHY IT WAS BLIND (what the widening changed):
 *   · failure was recognised only as `{ success:false }` — the impersonation, required-document and legacy-showing actions
 *     return `{ ok:false }` / `{ error }`;
 *   · success was recognised only as shadcn's `toast({ title })` — sonner's `toast.success(` (most of the files above) was
 *     invisible, so every file on sonner sat outside the guard;
 *   · "any `if (` in the next 600 characters" counted as having read the outcome, and the 600-character window crossed into the
 *     next handler;
 *   · the catalogue cut a function's body at the next `export async function`, so one function's `{ success:false }` was
 *     attributed to its neighbours (cancelSubscription — which only returns success:true or throws — was catalogued as a
 *     failure-returner until the cut moved to the next top-level declaration);
 *   · raw source, comments included.
 * The census in scripts/ui-wiring-census-guard.ts deliberately does NOT carry a second copy of this finder (one canonical
 * path, §1): its blind-spot line points here.
 */
import { readFileSync } from "node:fs"
import { walkTs, rootRuntimeFiles } from "./runtime-roots"
import { stripComments, blankStrings } from "./strip-comments"

const read = (p: string) => { try { return readFileSync(p, "utf8") } catch { return "" } }
// TOMBSTONE (orphan doctrine §1.1) — the private walker that stood here was one of
// 82 byte-identical copies of the same readdirSync walker. The survivor is
// scripts/runtime-roots.ts:61 (`walkTs`), imported above.
//
// The copy was not a style problem. It enumerated DIRECTORIES, and a root-level
// FILE is not a directory, so `proxy.ts` — the Next 16 edge middleware, which
// gates auth and queries blog_posts, brokerages, users and tenant_custom_domains
// with a SERVICE client on EVERY request — was outside this guard's corpus. A file
// that is never opened reports green, which is the failure shape §2 of CLAUDE.md
// names. `rootRuntimeFiles()` from the same survivor supplies the root files.

/**
 * RESOLVE THE IMPORT, DO NOT MATCH THE NAME. This codebase has TWO exported
 * functions called disconnectSocialAccount: the one in social-media-automation
 * RETURNS { success:false }, and the one in social-publishing THROWS. A
 * name-only match flagged the page that imports the throwing one — correct code
 * whose try/catch was exactly right — and very nearly "fixed" it into a type
 * error. Keying on `${module}#${name}` is the difference between a detector that
 * finds bugs and one that manufactures them.
 */
function moduleKey(specifier: string, importerFile: string): string {
  if (specifier.startsWith("@/")) return specifier.slice(2)
  if (specifier.startsWith(".")) {
    const dir = importerFile.split("/").slice(0, -1)
    for (const part of specifier.split("/")) {
      if (part === ".") continue
      else if (part === "..") dir.pop()
      else dir.push(part)
    }
    return dir.join("/")
  }
  return specifier
}
/** name -> the modules that import it, per client file. */
function importedFrom(src: string, file: string): Map<string, string> {
  const m = new Map<string, string>()
  for (const im of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const mod = moduleKey(im[2], file)
    for (const raw of im[1].split(",")) {
      const name = raw.split(/\s+as\s+/).pop()!.trim()
      if (name) m.set(name, mod)
    }
  }
  return m
}

/**
 * Does this (comment-stripped) function BODY hand a failure back AS A VALUE? `{ success:false }` is the original
 * spelling; wave 143J added the three other spellings the actions here actually use — `{ ok:false }` (impersonation,
 * required documents), a bare `{ error }` (the legacy showing wrapper) and `{ data:null, error }`. Reading only the
 * first is why this guard sat at 0 while ten dropped refusals shipped.
 */
export const FAILURE_RETURN = /return\s*\{\s*(?:[^}]*\bsuccess\s*:\s*false|ok\s*:\s*false|error\s*:|data\s*:\s*null\s*,\s*error)/

/** Actions that report failure BY RETURN VALUE — the only ones worth tracking. Source is read COMMENT-STRIPPED (§2: a tombstone is not a call site). */
export function actionsThatReturnFailure(files: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const f of files) {
    const s = stripComments(read(f))
    for (const m of s.matchAll(/export\s+async\s+function\s+(\w+)/g)) {
      let body = s.slice(m.index! + m[0].length, m.index! + m[0].length + 6000)
      // the function ends at the next top-level declaration of ANY kind — the old `export async function` cut let one
      // function's body run on into its neighbours' (cancelSubscription only returns success:true or throws, and was
      // catalogued as a failure-returner because of the function that follows it)
      const nxt = body.search(/\n(?:export|async function|function|const|let)\s/)
      if (nxt !== -1) body = body.slice(0, nxt)
      if (FAILURE_RETURN.test(body)) out.set(`${f.replace(/^\.\//, "").replace(/\.tsx?$/, "")}#${m[1]}`, f)
    }
  }
  return out
}

/**
 * A visible claim that the thing worked. Wave 143J: sonner's `toast.success(` was invisible here (only shadcn's
 * `toast({ title })` was recognised), so every file on sonner was outside the guard; a non-destructive toast whose
 * title is not itself a failure, a form close/reset, an onSuccess-style callback and a refresh/push all count.
 */
const SUCCESS_SIGNAL = /toast\.success\(|toast\(\s*\{(?![^}]*(?:variant\s*:\s*["']destructive|title\s*:\s*["'`][^"'`]*(?:fail|error|could not|couldn't|unable|cannot|can't|denied|refus|not (?:sent|saved|created|requested)))\b)|\bset\w*(?:Saved|Success|Sent|Done|Complete\w*|Submitted)\(\s*true\s*\)|\bset\w*(?:Open|Dialog|Form|Sheet|Modal|Editing)\(\s*(?:false|null)\s*\)|\bon(?:Success|Saved|Created|Updated|Complete\w*|Accept\w*|Close|Done)\(|\brouter\.(?:refresh|push)\(/i
/**
 * Fire-and-forget BY CONTRACT: nobody is owed the result of a beacon, and bestEffort / sentinelWrite are the repo's
 * explicit "this write may fail, here is why" wrappers (lib/db/best-effort.ts, lib/kernel/write-sentinel.ts) — dropping
 * their `{ ok }` is their whole purpose. Whether the WRITE they wrap deserved that declaration is a different question,
 * answered per call site (the saved-property insert did not — see app/crm/contacts/[contactId]/search/search-client.tsx).
 */
const TELEMETRY_CALL = /^(track|record|log|emit|ping|beacon|mark\w*(Viewed|Seen|Read|Opened)|increment|touch|bestEffort|sentinelWrite)/i

interface Hit { file: string; line: number; fn: string; definedIn: string; shape?: "BARE" | "UNREAD" }

/**
 * PURE: the discarded outcomes in ONE client file. The call's result must be READ before the same block claims success:
 *   BARE    `await act(…)` as a statement — nothing can have been read;
 *   UNREAD  `const r = await act(…)` where `r` (or a destructured name) is not mentioned before the claim.
 * (Wave 143J replaced "any `if (` in the next 600 characters counts as a read" — which let `await act(); if (x) …` through —
 * with this, and bounded the search to the enclosing block instead of a character window that crossed into the next handler.)
 */
export function scanSource(file: string, raw: string, returnsFailure: ReadonlyMap<string, string>): Hit[] {
  if (!file.endsWith(".tsx")) return []
  const src = stripComments(raw)
  if (!src.includes('"use client"') && !src.includes("'use client'")) return []
  const imports = importedFrom(src, file)
  const code = blankStrings(src)
  const hits: Hit[] = []
  for (const m of code.matchAll(/(?<![.\w$])(?:(?:const|let|var)\s+([\w$]+|\{[^}=]*\}|\[[^\]=]*\])\s*(?::\s*[^=]+)?=\s*|([\w$]+)\s*=\s*)?\(?\s*await\s+([\w$]+)\s*\(/g)) {
    const fn = m[3]
    const mod = imports.get(fn)
    if (!mod || TELEMETRY_CALL.test(fn)) continue
    const definedIn = returnsFailure.get(`${mod}#${fn}`)
    if (!definedIn) continue
    // the call's own parentheses, then the rest of the enclosing block
    let i = m.index! + m[0].length, depth = 1
    for (; i < code.length && depth > 0; i++) { if (code[i] === "(") depth++; else if (code[i] === ")") depth-- }
    const callEnd = i
    let d = 0, j = callEnd
    for (; j < code.length; j++) { if (code[j] === "{") d++; else if (code[j] === "}") { if (d === 0) break; d-- } }
    // the claim is read on the string-intact source (blankStrings keeps offsets): `variant: "destructive"` is the honest branch
    const claim = SUCCESS_SIGNAL.exec(src.slice(callEnd, j))
    if (!claim) continue
    const line = src.slice(0, m.index!).split("\n").length
    const varName = m[1] ?? m[2]
    if (!varName) {
      const pre = code.slice(Math.max(0, m.index! - 60), m.index!).replace(/\s+$/, ""); const lc = pre.slice(-1)
      const stmtStart = pre === "" || ";{}".includes(lc) || /\b(else|try)$/.test(pre) || (lc === ")" && /\b(if|for|while)\s*\([^)]*\)$/.test(pre))
      if (!stmtStart || /^\s*\.(then|catch|finally)\b/.test(code.slice(callEnd, callEnd + 20))) continue
      hits.push({ file, line, fn, definedIn, shape: "BARE" })
    } else {
      const ids = varName.replace(/[{}\[\]]/g, "").split(",").map((x) => x.split(":").pop()!.trim().replace(/^\.\.\./, "")).filter(Boolean)
      const upToClaim = code.slice(callEnd, j).slice(0, claim.index)
      if (!ids.some((id) => new RegExp(`(?<![\\w$.])${id.replace(/\$/g, "\\$")}(?![\\w$])`).test(upToClaim))) hits.push({ file, line, fn, definedIn, shape: "UNREAD" })
    }
  }
  return hits
}

function findDiscarded(files: string[], returnsFailure: Map<string, string>): Hit[] {
  return files.flatMap((file) => scanSource(file, read(file), returnsFailure))
}

/**
 * PURE: `await fetch(…)` whose RESPONSE is never read before the same block claims success. fetch RESOLVES on a 403 / 404 / 500
 * — only a network failure throws — so a dropped response is a dropped refusal exactly like a dropped `{ success:false }`
 * (wave 143J: the video library removed a script from the list on a refused DELETE). A chain that consumes the response
 * (`.then`, `.json()`) is a read; a bare statement or an assigned-but-unmentioned response is not.
 */
export function scanFetchSource(file: string, raw: string): Hit[] {
  if (!file.endsWith(".tsx")) return []
  const src = stripComments(raw)
  if (!src.includes('"use client"') && !src.includes("'use client'")) return []
  const code = blankStrings(src)
  const hits: Hit[] = []
  for (const m of code.matchAll(/(?<![.\w$])(?:(?:const|let|var)\s+([\w$]+|\{[^}=]*\})\s*=\s*|([\w$]+)\s*=\s*)?\(?\s*await\s+fetch\s*\(/g)) {
    let i = m.index! + m[0].length, depth = 1
    for (; i < code.length && depth > 0; i++) { if (code[i] === "(") depth++; else if (code[i] === ")") depth-- }
    const callEnd = i
    if (/^\s*\.(then|catch|json|text|blob)\b/.test(code.slice(callEnd, callEnd + 14))) continue
    let d = 0, j = callEnd
    for (; j < code.length; j++) { if (code[j] === "{") d++; else if (code[j] === "}") { if (d === 0) break; d-- } }
    const claim = SUCCESS_SIGNAL.exec(src.slice(callEnd, j)); if (!claim) continue
    const v = m[1] ?? m[2]
    const line = src.slice(0, m.index!).split("\n").length
    if (!v) {
      const pre = code.slice(Math.max(0, m.index! - 60), m.index!).replace(/\s+$/, ""); const lc = pre.slice(-1)
      if (!(pre === "" || ";{}".includes(lc) || /\b(else|try)$/.test(pre) || (lc === ")" && /\b(if|for|while)\s*\([^)]*\)$/.test(pre)))) continue
      hits.push({ file, line, fn: "fetch", definedIn: "(network)", shape: "BARE" })
    } else {
      const ids = v.replace(/[{}]/g, "").split(",").map((x) => x.split(":").pop()!.trim()).filter(Boolean)
      const upToClaim = code.slice(callEnd, j).slice(0, claim.index)
      if (!ids.some((id) => new RegExp(`(?<![\\w$.])${id}(?![\\w$])`).test(upToClaim))) hits.push({ file, line, fn: "fetch", definedIn: "(network)", shape: "UNREAD" })
    }
  }
  return hits
}

function main() {
let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}

const FILES = [...walkTs("app"), ...walkTs("lib"), ...walkTs("components"), ...rootRuntimeFiles(".")]
const RETURNS_FAILURE = actionsThatReturnFailure(FILES)

// ZERO — but read the header before trusting it. This started at 48 name-matched
// candidates, became 27 once the throw-vs-return discriminator was applied, 13
// once imports were resolved rather than names matched, and 0 once the real ones
// were fixed. Two of those reductions were the DETECTOR getting more honest, not
// the codebase getting better, which is worth remembering before treating a zero
// as an all-clear: this guard can only see `if (!X)`-shaped client handlers that
// call a `{success:false}`-returning action and then signal success. It cannot
// see a handler that checks the outcome and then does the wrong thing with it,
// and it does not look at server-to-server calls at all.
const BASELINE = 0

console.log("\n═══ 1. No UI claims success without reading the outcome ═══")
const hits = findDiscarded(FILES, RETURNS_FAILURE)
{
  for (const h of hits) console.log(`     ${h.file}:${h.line}  await ${h.fn}(…)  — returns success:false in ${h.definedIn}`)
  ok(`client callers discarding a returned failure, at or below ${BASELINE} (found ${hits.length})`,
    hits.length <= BASELINE,
    `${hits.length} > ${BASELINE} — a new screen claims an outcome nobody checked`)
}

console.log("\n═══ 1b. No UI claims success over a fetch response it never read (wave 143J) ═══")
const fetchHits = FILES.flatMap((file) => scanFetchSource(file, read(file)))
{
  for (const h of fetchHits) console.log(`     ${h.file}:${h.line}  await fetch(…)  — the response is never read before success is claimed (${h.shape})`)
  ok(`client fetches whose response is dropped before a success claim: at or below 0 (found ${fetchHits.length})`, fetchHits.length === 0,
    `${fetchHits.length} > 0 — fetch resolves on a 4xx / 5xx; read res.ok before claiming`)
}

console.log("\n═══ 2. The discriminator holds in both directions ═══")
{
  ok("the catalogue only contains actions that report failure BY RETURN,\n    which is what makes discarding it fatal",
    RETURNS_FAILURE.size > 0 &&
    /return\s*\{[^}]*success:\s*false/.test(read("app/actions/transaction-inspections.ts")))

  // The two-functions-one-name case that name-matching got wrong.
  ok("disconnectSocialAccount resolves per IMPORT — social-publishing THROWS and\n    must not be flagged, social-media-automation RETURNS and must be",
    /throw new Error\("Unauthorized"\)/.test(read("app/actions/social-publishing.ts")) &&
    RETURNS_FAILURE.has("app/actions/social-media-automation#disconnectSocialAccount") &&
    !RETURNS_FAILURE.has("app/actions/social-publishing#disconnectSocialAccount"))

  // assignTransactionCoordinator THROWS (`if (txnError) throw txnError`) and its
  // caller wraps the await in try/catch. Discarding the return value there is
  // correct, and an earlier version of this detector flagged it — 48 hits, most
  // of them noise. A guard that flags correct code teaches people to ignore it.
  const mp = read("app/actions/multi-persona.ts")
  ok("assignTransactionCoordinator still reports failure by THROWING, so it is\n    correctly absent from the catalogue",
    /throw txnError/.test(mp) && !RETURNS_FAILURE.has("app/actions/multi-persona#assignTransactionCoordinator"))
}

console.log("\n═══ 3. The transaction-inspections cluster reads its outcomes ═══")
{
  // Five money/compliance approvals on one screen, every one of them discarded:
  // approve inspection quote, approve insurance quote, mark inspection complete,
  // submit insurance quote approval, update earnest money. Each action checks
  // authorisation and brokerage ownership and returns { success:false, error } —
  // and the screen said "done" regardless.
  const c = read("app/dashboard/transactions/[id]/transaction-detail-client.tsx")
  // ASSERT THE CONSTRUCT, NOT ITS SYNTAX. A first version of this required the
  // literal shape `const x = await fn(` and failed on the two calls that sit in
  // a ternary — correct code, wrong shape. An assertion that pins a spelling
  // rather than a behaviour is the same error this repo has now paid for three
  // times. What matters is that the outcome is READ before the screen moves on.
  for (const fn of [
    "approveInspectionQuoteAction", "approveInsuranceQuoteAction", "markInspectionCompleteAction",
    "submitInsuranceQuoteApprovalAction", "updateEarnestMoneyAction",
  ]) {
    const at = c.indexOf(`await ${fn}`)
    const window = at === -1 ? "" : c.slice(at, at + 900)
    ok(`${fn} — its outcome is read before the screen claims success`,
      at !== -1 && /!res\?\.success|!result\?\.success|\.success\b/.test(window))
  }
}

console.log("\n═══ 4. The partner portals read their outcomes (m378) ═══")
{
  // These are the ones an OUTSIDE party sees. A lender moves the loan status, a
  // title company ticks a closing item — the page refreshes, the old value is
  // still there, and nothing was said. Worse than an internal miss: the partner
  // has no way to tell a refused update from a slow one, and no support path.
  //
  // Every one of these files already had an `error` state and used it elsewhere.
  // lender-actions even checks r.error on its createLenderApplication call, four
  // lines above a sibling that did not. The same "some paths fixed, others not"
  // shape the CDA and activities clusters had.
  const PORTAL: Array<[string, string]> = [
    ["app/portal/lender/[transactionId]/lender-actions.tsx", "flagLenderIssue"],
    ["app/portal/lender/[transactionId]/lender-actions.tsx", "updateLenderLoanStatus"],
    ["app/portal/lender/[transactionId]/lender-actions.tsx", "updateLenderApplicationStatus"],
    ["app/portal/title/[transactionId]/title-actions.tsx", "updateTitleStatus"],
    ["app/portal/title/[transactionId]/closing-checklist.tsx", "updateClosingPrepItem"],
  ]
  for (const [file, fn] of PORTAL) {
    const src = read(file)
    const at = src.indexOf(`await ${fn}`)
    ok(`${fn} — the portal reads the outcome before refreshing`,
      at !== -1 && /!r\?\.success/.test(src.slice(at, at + 700)))
  }
}

console.log("\n═══ 5. The detector still recognises every shape it was written for (wave 143J positive controls) ═══")
{
  // Fixtures hand the scanner two action modules: one that RESOLVES a refusal, one that only throws.
  const FX = new Map<string, string>([
    ["app/actions/fx#refuses", "app/actions/fx.ts"], ["app/actions/fx#refusesOk", "app/actions/fx.ts"],
    ["app/actions/fx#refusesError", "app/actions/fx.ts"], ["app/actions/fx#trackView", "app/actions/fx.ts"],
  ])
  const scan = (body: string) => scanSource("app/fixture.tsx", `"use client"\nimport { refuses, refusesOk, refusesError, throws, trackView } from "@/app/actions/fx"\n${body}`, FX).length
  ok("a bare await of a refusing action, then sonner's toast.success, is caught (the original detector could not see toast.success)",
    scan(`async function go() { await refuses({}); toast.success("Saved") }`) === 1)
  ok("the other spellings of 'returned a failure' — { ok:false }, { error } — are caught once the action is catalogued",
    scan(`async function go() { try { await refusesOk(); setOpen(false) } catch {} }`) === 1 &&
    scan(`async function go() { const r = await refusesError(); toast({ title: "Saved" }) }`) === 1)
  ok("an assigned-but-never-read result (plain or destructured) followed by a claim is caught",
    scan(`async function go() { const r = await refuses(); router.refresh() }`) === 1 &&
    scan(`async function go() { const { success } = await refuses(); toast.success("Saved") }`) === 1)
  ok("a result that is read before the claim, a call that throws, a telemetry beacon, a .then chain, a destructive-only toast and an inline `(await x()).ok` are NOT caught",
    scan(`async function go() { const r = await refuses(); if (!r.success) { toast.error(r.error); return } toast.success("Saved") }`) === 0 &&
    scan(`async function go() { const { success, error } = await refuses(); if (!success) return toast.error(error); toast.success("Saved") }`) === 0 &&
    scan(`async function go() { await throws(); toast.success("Saved") }`) === 0 &&
    scan(`async function go() { await trackView(); toast.success("Saved") }`) === 0 &&
    scan(`async function go() { await refuses({}).then(handle); toast.success("Saved") }`) === 0 &&
    scan(`async function go() { await refuses({}); toast({ title: "Failed", variant: "destructive" }) }`) === 0 &&
    scan(`async function go() { if ((await refuses({})).success) toast.success("Saved") }`) === 0)
  ok("a bare await followed by an unrelated `if (` is no longer treated as having read the outcome",
    scan(`async function go() { await refuses({}); if (items.length) toast.success("Saved") }`) === 1)
  const sf = (body: string) => scanFetchSource("app/fixture.tsx", `"use client"\n${body}`).length
  ok("fetch: a bare awaited fetch followed by a success claim, and an assigned-but-unread response, are caught; res.ok read first, a .then / .json() chain and a destructive-only toast are not",
    sf(`async function go() { await fetch("/api/x", { method: "DELETE" }); setItems([]); router.refresh() }`) === 1 &&
    sf(`async function go() { const res = await fetch("/api/x"); toast.success("Done") }`) === 1 &&
    sf(`async function go() { const res = await fetch("/api/x"); if (!res.ok) { toast.error("no"); return } toast.success("Done") }`) === 0 &&
    sf(`async function go() { await fetch("/api/x").then(r => r.json()); toast.success("Done") }`) === 0 &&
    sf(`async function go() { const data = await (await fetch("/api/x")).json(); toast.success("Done") }`) === 0 &&
    sf(`async function go() { await fetch("/api/x"); toast({ title: "Failed", variant: "destructive" }) }`) === 0)
  ok("the failure-return spellings are recognised and a throw is not",
    FAILURE_RETURN.test("return { success: false, error: 'x' }") && FAILURE_RETURN.test("return { ok: false, error: 'x' }") &&
    FAILURE_RETURN.test("return { error: result.error }") && FAILURE_RETURN.test("return { data: null, error }") &&
    !FAILURE_RETURN.test("throw new Error('x')") && !FAILURE_RETURN.test("return { success: true }"))
  ok("a tombstone naming a dropped call inside a comment is not a call site (§2)",
    scanSource("app/fixture.tsx", `"use client"\nimport { refuses } from "@/app/actions/fx"\n// await refuses({}); toast.success("Saved")\nconst a = 1`, FX).length === 0)
  // The nine files fixed in wave 143J keep reading their outcome — asserted as a rule on the construct, per file.
  const FIXED_143J: Array<[string, RegExp]> = [
    ["app/components/ai-copilot/inline-ai-reply-coach.tsx", /accepted\?\.success/],
    ["app/components/content-studio/LinkToVideoGenerator.tsx", /deleted\?\.success/],
    ["app/components/portal/PersonaPropertiesDashboard.tsx", /requested\?\.success/],
    ["app/crm/components/os/buyer-match-panel.tsx", /requested\?\.error/],
    ["app/crm/components/financial-verification-panel.tsx", /profile\.success/],
    ["app/dashboard/settings/required-documents/required-doc-row-actions.tsx", /r\.ok/],
    ["app/components/layout/impersonation-banner.tsx", /ended\.ok/],
    ["app/crm/contacts/[contactId]/search/search-client.tsx", /saveError/],
    ["app/dashboard/videos/library/page.tsx", /res\.ok/],
  ]
  for (const [f, re] of FIXED_143J) ok(`${f} — reads the action's outcome`, re.test(stripComments(read(f))))
}

console.log(`\n${"═".repeat(70)}`)
console.log(`DISCARDED OUTCOME — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  console.log("\nThe action told the truth. The screen did not pass it on.")
  process.exit(1)
}
console.log(`${hits.length} client callers discard a returned failure (baseline ${BASELINE}).`)
console.log("A REVIEW QUEUE: some discards are legitimate. Ask whether the user")
console.log("would want to know, then read the outcome or say why you did not.")
}

// Runs only when invoked directly, so scanSource / FAILURE_RETURN can be imported by a tool or another proof.
if (process.argv[1] && /discarded-outcome-guard\.ts$/.test(process.argv[1])) main()
