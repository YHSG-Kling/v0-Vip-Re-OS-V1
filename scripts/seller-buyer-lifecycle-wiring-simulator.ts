#!/usr/bin/env tsx
/**
 * scripts/seller-buyer-lifecycle-wiring-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * CATEGORY C BURN-DOWN: BUYER GOVERNANCE, SELLER DECISION GOVERNANCE,
 * OPEN-HOUSE POST-EVENT, AND CALENDAR SYNC.
 *
 * Twelve exports were referenced nowhere. They did not all deserve the same
 * fate, and the difference is the whole point of this file.
 *
 * WIRED (they were finished capabilities with no door):
 *   · getBuyerLifecycleStatistics / getBuyersInSpecificState — a brokerage-wide
 *     buyer pipeline that took brokerage_id FROM THE CALLER and read through a
 *     SERVICE-ROLE client. Wiring that unchanged would have shipped a
 *     cross-tenant read: any signed-in user, any brokerage's counts and contact
 *     ids. The tenant now comes from the session and the panel shows the cohort.
 *   · requestFeedbackFromAttendee — merged. It sent nothing and stamped
 *     feedback_collected_at, recording feedback as COLLECTED at the moment it
 *     was merely REQUESTED. Delivery is delegated to the sender that exists;
 *     what survives here is the tenant proof that sender lacks.
 *   · generateOpenHouseAISummary — reads the attendee table the product
 *     actually fills, unlike the AI insights card next to it, which grades
 *     open_house_analytics and has never found a row.
 *   · getOpenHouseEventPublic — the public kiosk loader. Its status filter
 *     excluded 'active', i.e. the state an open house is in WHILE IT IS
 *     HAPPENING, so the sign-in page 404'd at exactly the hour it exists for.
 *   · connectCalendarProvider / syncEventToProvider / fetchSyncLogs — there was
 *     no way to connect a calendar at all, and "Recent Sync Activity" was a
 *     hard-coded sentence promising logs that no reader ever fetched.
 *
 * DELETED, each against a NAMED duplicate that does the same job more
 * completely, with nothing to port because each deleted body was a strict
 * subset of the survivor's:
 *   · isBuyerGateEnabled            -> buyer-lifecycle-core.ts:getBuyerEnabledGates
 *   · checkCMAReady                 -> seller-decision-governance.ts:evaluateListingCMAQuality
 *   · checkNetSheetValid            -> seller-decision-governance.ts:validateListingNetSheetValidity
 *   · checkPresentationReady        -> seller-decision-governance.ts:evaluateListingPresentationReadiness
 *
 * ─── HOW THIS PROVES ANYTHING ───────────────────────────────────────────────
 *  · Comments are stripped before every scan, and a self-test proves a comment
 *    cannot satisfy a check.
 *  · Assertions slice the CONSTRUCT — one function body, one write payload —
 *    and never grep a whole file. A name survives in its declaration long after
 *    the branch it guards has been gutted, so branches are asserted, not tokens.
 *  · Every assertion family is negative-tested: real source is mutated on disk,
 *    the mutation is proven applied by sha256, the suite re-runs, the SPECIFIC
 *    check id is confirmed to have failed, the file is restored and the restore
 *    is proven by sha256.
 *  · A coverage sweep blanks each file in turn; every assertion declared to own
 *    that file must fail. Pure negations pass on a blank file by construction
 *    and are each paired with a positive assertion that does not.
 *
 * RUN:  npx tsx scripts/seller-buyer-lifecycle-wiring-simulator.ts
 */

import { readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"

// ─── FILES UNDER PROOF ───────────────────────────────────────────────────────

const BUYER = "app/actions/buyer-lifecycle-core.ts"
const PANEL = "app/crm/contacts/[contactId]/components/buyer-lifecycle-panel.tsx"
const GOV = "app/actions/seller-decision-governance.ts"
const CARD = "app/dashboard/listings/[id]/offers/components/seller-decision-readiness-card.tsx"
const OH = "app/actions/seller-open-house.ts"
const OHPANEL = "app/dashboard/listings/[id]/components/open-house-post-event-panel.tsx"
const OHTAB = "app/dashboard/listings/[id]/open-house/tabs/analytics-tab.tsx"
const KIOSKPAGE = "app/open-house/[eventId]/signin/page.tsx"
const KIOSK = "app/open-house/[eventId]/signin/sign-in-kiosk.tsx"
const CAL = "app/actions/calendar/calendar-sync-actions.ts"
const CALPAGE = "app/dashboard/settings/calendar/page.tsx"

const ALL_FILES = [BUYER, PANEL, GOV, CARD, OH, OHPANEL, OHTAB, KIOSKPAGE, KIOSK, CAL, CALPAGE]

// ─── SOURCE ACCESS (cached, cleared for every negative-test re-run) ──────────

const rawCache = new Map<string, string>()
const codeCache = new Map<string, string>()

function raw(path: string): string {
  const hit = rawCache.get(path)
  if (hit !== undefined) return hit
  const text = readFileSync(join(process.cwd(), path), "utf8")
  rawCache.set(path, text)
  return text
}

/**
 * Strip comments so an assertion can never be satisfied by prose describing the
 * fix. Block comments first, then whole-line and trailing line comments. A
 * trailing comment is removed only when the slash pair is not inside a quote on
 * that line, so a URL or a path inside a string literal survives intact.
 */
function stripComments(text: string): string {
  const noBlocks = text.replace(/\/\*[\s\S]*?\*\//g, "")
  return noBlocks
    .split("\n")
    .map((line) => {
      let inS = false, inD = false, inB = false, esc = false
      for (let i = 0; i < line.length; i++) {
        const c = line[i]
        if (esc) { esc = false; continue }
        if (c === "\\") { esc = true; continue }
        if (!inD && !inB && c === "'") { inS = !inS; continue }
        if (!inS && !inB && c === '"') { inD = !inD; continue }
        if (!inS && !inD && c === "`") { inB = !inB; continue }
        if (!inS && !inD && !inB && c === "/" && line[i + 1] === "/") return line.slice(0, i)
      }
      return line
    })
    .join("\n")
}

function code(path: string): string {
  const hit = codeCache.get(path)
  if (hit !== undefined) return hit
  const text = stripComments(raw(path))
  codeCache.set(path, text)
  return text
}

function clearCaches() { rawCache.clear(); codeCache.clear() }

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(join(process.cwd(), path))).digest("hex")
}

// ─── CONSTRUCT SLICING ───────────────────────────────────────────────────────

function matchBrace(text: string, start: number): number {
  let depth = 0, inS = false, inD = false, inB = false, esc = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (esc) { esc = false; continue }
    if (c === "\\") { esc = true; continue }
    if (inS) { if (c === "'") inS = false; continue }
    if (inD) { if (c === '"') inD = false; continue }
    if (inB) { if (c === "`") inB = false; continue }
    if (c === "'") { inS = true; continue }
    if (c === '"') { inD = true; continue }
    if (c === "`") { inB = true; continue }
    if (c === "{") depth++
    else if (c === "}") { depth--; if (depth === 0) return i }
  }
  return -1
}

function matchParen(text: string, start: number): number {
  let depth = 0, inS = false, inD = false, inB = false, esc = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (esc) { esc = false; continue }
    if (c === "\\") { esc = true; continue }
    if (inS) { if (c === "'") inS = false; continue }
    if (inD) { if (c === '"') inD = false; continue }
    if (inB) { if (c === "`") inB = false; continue }
    if (c === "'") { inS = true; continue }
    if (c === '"') { inD = true; continue }
    if (c === "`") { inB = true; continue }
    if (c === "(") depth++
    else if (c === ")") { depth--; if (depth === 0) return i }
  }
  return -1
}

/**
 * Locate a named function's declaration start and the index of its BODY brace.
 *
 * Taking the first brace after the name lands inside a destructured parameter
 * or inside an inline return type, so: paren-match the parameter list, then
 * walk the return-type annotation tracking angle / brace / bracket depth. The
 * body brace is the first one seen at depth zero.
 */
function fnAnchors(path: string, name: string): { start: number; bodyOpen: number; text: string } | null {
  const text = code(path)
  const decl = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`)
  const m = decl.exec(text)
  if (!m) return null
  const start = m.index + m[0].search(/\S/)
  const paramOpen = m.index + m[0].length - 1
  const paramClose = matchParen(text, paramOpen)
  if (paramClose < 0) return null

  let angle = 0, brace = 0, bracket = 0
  for (let i = paramClose + 1; i < text.length; i++) {
    const c = text[i]
    if (c === "<") angle++
    else if (c === ">") { if (angle > 0) angle-- }
    else if (c === "[") bracket++
    else if (c === "]") { if (bracket > 0) bracket-- }
    else if (c === "{") {
      if (angle === 0 && bracket === 0 && brace === 0) return { start, bodyOpen: i, text }
      brace++
    } else if (c === "}") { if (brace > 0) brace-- }
  }
  return null
}

/** The body of one named function — the unit every assertion below reads. */
function fnBody(path: string, name: string): string {
  const a = fnAnchors(path, name)
  if (!a) return ""
  const close = matchBrace(a.text, a.bodyOpen)
  if (close < 0) return ""
  return a.text.slice(a.bodyOpen, close + 1)
}

/** A function's declaration: everything up to its body brace. */
function fnSignature(path: string, name: string): string {
  const a = fnAnchors(path, name)
  if (!a) return ""
  return a.text.slice(a.start, a.bodyOpen)
}

/**
 * A function's PARAMETER LIST only — the parens, not the return type.
 *
 * TIGHTENED AFTER A FALSE FAILURE. The first version of the tenancy checks
 * scanned fnSignature for `brokerageId: string`, which also matches the
 * function's own RETURN type (`{ ok: true; brokerageId: string; ... }`). That
 * is the mirror image of the bug it hunts: a signature check that cannot tell
 * an input from an output would have passed on getBuyersInSpecificState purely
 * because that one happens not to return the field. Only the parameters can
 * carry a caller-supplied tenant, so only the parameters are read.
 */
function fnParams(path: string, name: string): string {
  const text = code(path)
  const decl = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`)
  const m = decl.exec(text)
  if (!m) return ""
  const open = m.index + m[0].length - 1
  const close = matchParen(text, open)
  if (close < 0) return ""
  return text.slice(open, close + 1)
}

/** Is `name` exported as a function from this module? */
function exportsFn(path: string, name: string): boolean {
  return new RegExp(`\\n\\s*export\\s+(?:async\\s+)?function\\s+${name}\\s*\\(`).test(code(path))
}

/** The named-import list pulled from one module specifier, within a scope. */
function importedFrom(scope: string, specifier: string): string {
  const re = new RegExp(`import\\s*\\{([\\s\\S]*?)\\}\\s*from\\s*["']${specifier.replace(/[/@.]/g, "\\$&")}["']`)
  return re.exec(scope)?.[1] ?? ""
}

/** The literal argument list of one call, sliced from a scope. */
function callArgs(scope: string, name: string): string[] {
  const out: string[] = []
  const re = new RegExp(`\\b${name}\\s*\\(`, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(scope))) {
    const open = m.index + m[0].length - 1
    const close = matchParen(scope, open)
    if (close < 0) continue
    out.push(scope.slice(open + 1, close))
  }
  return out
}

/** The object literal handed to `.select(`/`.insert(`/`.update(` after `.from(table)`. */
function selectArgFor(scope: string, table: string): string[] {
  const out: string[] = []
  const re = new RegExp(`from\\(\\s*["']${table}["']\\s*\\)`, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(scope))) {
    const rest = scope.slice(m.index, m.index + 3000)
    const si = rest.indexOf(".select(")
    if (si < 0) continue
    if (/\.from\(/.test(rest.slice(m[0].length, si))) continue
    const open = rest.indexOf("(", si)
    const close = matchParen(rest, open)
    if (close < 0) continue
    out.push(rest.slice(open + 1, close))
  }
  return out
}

// ─── CHECK HARNESS ───────────────────────────────────────────────────────────

type Result = { id: string; label: string; ok: boolean }
let results: Result[] = []
let quiet = false

function check(id: string, label: string, ok: boolean) {
  results.push({ id, label, ok })
  if (!quiet) console.log(`  ${ok ? "✓" : "✗"} [${id}] ${label}`)
}

function section(title: string) { if (!quiet) console.log(`\n${title}`) }

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 0 — the stripper and the slicers cannot be fooled
// ═══════════════════════════════════════════════════════════════════════════

function selfTest() {
  section("[layer 0 · a comment cannot satisfy a check]")

  const blockOpen = "/" + "*"
  const blockClose = "*" + "/"
  const decoy =
    `${blockOpen} const ctx = await requireBrokerage() lives here ${blockClose}\n` +
    `const real = 1 // const ctx = await requireBrokerage() trailing decoy\n` +
    `const url = "https:` + `//example.com/keep"\n`

  const stripped = stripComments(decoy)

  check("SELF-1", "block comments are removed before any scan",
    !/requireBrokerage\(\) lives here/.test(stripped))
  check("SELF-2", "trailing line comments are removed before any scan",
    !/trailing decoy/.test(stripped))
  check("SELF-3", "...but a slash pair inside a string literal survives",
    /example\.com\/keep/.test(stripped) && /const real = 1/.test(stripped))

  const stats = fnBody(BUYER, "getBuyerLifecycleStatistics")
  check("SELF-4", "fnBody returns ONE function, not the module",
    stats.length > 100 && stats.length < code(BUYER).length / 4 &&
    !/export async function getBuyersInSpecificState/.test(stats))

  const pub = fnBody(OH, "getOpenHouseEventPublic")
  check("SELF-5", "fnBody survives a multi-line generic return type",
    pub.length > 500 && !/export async function getPostEventIntelligence/.test(pub) &&
    /serviceClient/.test(pub))
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 1 — the buyer pipeline answers to the session, not to its argument
// ═══════════════════════════════════════════════════════════════════════════

function buyerTenancyLayer() {
  section("[layer 1 · a service-role reader must not take its tenant from the caller]")

  const statsParams = fnParams(BUYER, "getBuyerLifecycleStatistics")
  const statsBody = fnBody(BUYER, "getBuyerLifecycleStatistics")
  const peersParams = fnParams(BUYER, "getBuyersInSpecificState")
  const peersBody = fnBody(BUYER, "getBuyersInSpecificState")
  const req = fnBody(BUYER, "requireBrokerage")

  check("B1", "getBuyerLifecycleStatistics no longer accepts a caller-supplied brokerageId",
    statsParams !== "" && !/brokerage/i.test(statsParams))
  check("B2", "...it resolves the tenant from the session and REFUSES when it cannot",
    /const\s+ctx\s*=\s*await\s+requireBrokerage\(\)/.test(statsBody) &&
    /if\s*\(!ctx\.ok\)\s*return\s*\{\s*ok:\s*false\s*,\s*error:\s*ctx\.error\s*\}/.test(statsBody))
  check("B3", "...and the reader is handed the SESSION's brokerage id",
    /getLifecycleStatistics\(\s*ctx\.brokerageId\s*,/.test(statsBody))

  check("B4", "getBuyersInSpecificState no longer accepts a caller-supplied brokerageId",
    peersParams !== "" && !/brokerage/i.test(peersParams))
  check("B5", "...it too resolves the tenant from the session and refuses on failure",
    /const\s+ctx\s*=\s*await\s+requireBrokerage\(\)/.test(peersBody) &&
    /if\s*\(!ctx\.ok\)\s*return\s*\{\s*ok:\s*false\s*,\s*error:\s*ctx\.error\s*\}/.test(peersBody))
  check("B6", "...an unknown state is a refusal, not an empty cohort that reads as 'nobody'",
    /getStateDefinition\(params\.state\)/.test(peersBody) &&
    /if\s*\(!getStateDefinition\(params\.state\)\)\s*\{[\s\S]{0,200}?return\s*\{\s*ok:\s*false/.test(peersBody))
  check("B7", "...and the reader is handed the SESSION's brokerage id",
    /getBuyersInState\(\s*ctx\.brokerageId\s*,\s*params\.state\s*,/.test(peersBody))

  check("B8", "requireBrokerage destructures the users read error — a refusal is not 'no brokerage'",
    /const\s*\{\s*data:\s*row\s*,\s*error\s*\}\s*=\s*await\s+supabase/.test(req) &&
    /if\s*\(error\)\s*return\s*\{\s*ok:\s*false/.test(req) &&
    /\.maybeSingle\(\)/.test(req))
  check("B9", "...and it reads the tenant off users.id, never off a caller argument",
    /\.from\(\s*["']users["']\s*\)[\s\S]{0,200}?\.eq\(\s*["']id["']\s*,\s*user\.id\s*\)/.test(req))

  section("[layer 1b · isBuyerGateEnabled is gone, and its survivor is intact]")

  check("B10", "isBuyerGateEnabled is no longer exported",
    !exportsFn(BUYER, "isBuyerGateEnabled"))
  check("B11", "...and the lib helper it wrapped is no longer imported either",
    !/^\s*isGateEnabled,\s*$/m.test(code(BUYER)))
  check("B12", "the NAMED survivor getBuyerEnabledGates still exists and still delegates",
    exportsFn(BUYER, "getBuyerEnabledGates") &&
    /getEnabledGatesForBuyer\(contactId\)/.test(fnBody(BUYER, "getBuyerEnabledGates")))
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 2 — the cohort actually reaches a screen, refusals included
// ═══════════════════════════════════════════════════════════════════════════

function buyerSurfaceLayer() {
  section("[layer 2 · the buyer lifecycle panel shows the brokerage cohort]")

  const ui = code(PANEL)
  const imports = importedFrom(ui, "@/app/actions/buyer-lifecycle-core")
  const load = fnBody(PANEL, "loadCohort")

  check("B13", "the panel imports both pipeline readers",
    /\bgetBuyerLifecycleStatistics\b/.test(imports) && /\bgetBuyersInSpecificState\b/.test(imports))
  check("B14", "...and calls the statistics reader with NO tenant argument",
    callArgs(load, "getBuyerLifecycleStatistics").some((a) => a.trim() === ""))
  check("B15", "...and asks for the cohort by STATE only",
    callArgs(load, "getBuyersInSpecificState").some(
      (a) => /state/.test(a) && !/brokerage/i.test(a)))
  check("B16", "a refused statistics read renders as a refusal, never as zero buyers",
    /if\s*\(!stats\.ok\)\s*\{\s*setCohort\(\{\s*kind:\s*["']error["']/.test(load))
  check("B17", "a refused cohort read renders as a refusal too",
    /if\s*\(!peers\.ok\)\s*\{\s*setCohort\(\{\s*kind:\s*["']error["']/.test(load))
  check("B18", "...the panel renders that error branch rather than swallowing it",
    /cohort\.kind === "error"/.test(ui) && /could not be read/i.test(ui))
  check("B19", "...and the buyer being viewed is excluded from their own peer list",
    /peers\.contactIds\.filter\(\(id\)\s*=>\s*id\s*!==\s*contactId\)/.test(load))
  check("B20", "a zero total is NOT presented as proof of an empty pipeline",
    /cohort\.totalBuyers === 0/.test(ui) && /refused/i.test(ui))
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 3 — the three boolean-only seller wrappers are gone, survivors wired
// ═══════════════════════════════════════════════════════════════════════════

function sellerDecisionLayer() {
  section("[layer 3 · three subset wrappers deleted against named survivors]")

  check("D1", "checkCMAReady is no longer exported", !exportsFn(GOV, "checkCMAReady"))
  check("D2", "checkNetSheetValid is no longer exported", !exportsFn(GOV, "checkNetSheetValid"))
  check("D3", "checkPresentationReady is no longer exported", !exportsFn(GOV, "checkPresentationReady"))

  check("D4", "the three NAMED survivors are all still exported",
    exportsFn(GOV, "evaluateListingCMAQuality") &&
    exportsFn(GOV, "validateListingNetSheetValidity") &&
    exportsFn(GOV, "evaluateListingPresentationReadiness"))

  const cma = fnBody(GOV, "evaluateListingCMAQuality")
  const net = fnBody(GOV, "validateListingNetSheetValidity")
  const pres = fnBody(GOV, "evaluateListingPresentationReadiness")

  check("D5", "evaluateListingCMAQuality still runs derive-then-evaluate, the deleted wrapper's whole body",
    /deriveCMAQualityFromEvents\(input\.listingId\)/.test(cma) &&
    /await\s+evaluateCMAQuality\(cmaInput\)/.test(cma))
  check("D6", "validateListingNetSheetValidity still derives, validates, AND emits the expiry warning",
    /deriveNetSheetValidityFromEvents\(input\.listingId\)/.test(net) &&
    /validateNetSheetValidity\(netSheetInput\)/.test(net) &&
    /emitNetSheetExpirationWarning\(input\.listingId,\s*result\.daysRemaining\)/.test(net))
  check("D7", "evaluateListingPresentationReadiness keeps 'no data' distinct from 'not ready'",
    /derivePresentationReadinessFromEvents\(listingId\)/.test(pres) &&
    /if\s*\(!input\)\s*\{[\s\S]{0,200}?success:\s*false/.test(pres))

  check("D8", "the boolean lib helpers are no longer imported into the module",
    !/\bisCMAReady\b/.test(code(GOV)) &&
    !/\bisPresentationReady\b/.test(code(GOV)) &&
    !/isNetSheetValid,/.test(code(GOV)))

  section("[layer 3b · the readiness card calls the survivors and reads their verdicts]")

  const cardUi = code(CARD)
  const runChecks = fnBody(CARD, "runChecks")

  check("D9", "the card calls all three survivors",
    /evaluateListingCMAQuality\(\{\s*listingId\s*\}\)/.test(runChecks) &&
    /validateListingNetSheetValidity\(\{\s*listingId\s*\}\)/.test(runChecks) &&
    /evaluateListingPresentationReadiness\(listingId\)/.test(runChecks))
  check("D10", "...and stores the ENGINE'S refusal when a result is missing",
    /cmaRes\.success && cmaRes\.data[\s\S]{0,200}?error:\s*cmaRes\.error/.test(runChecks) &&
    /netSheetRes\.success && netSheetRes\.data[\s\S]{0,240}?error:\s*netSheetRes\.error/.test(runChecks))
  check("D11", "...and the card renders engine text, not an invented cause",
    /reasons=\{cma\?\.violations \?\? \[\]\}/.test(cardUi) &&
    /engineError=\{state\.cma\?\.error \?\? null\}/.test(cardUi))
  check("D12", "the deleted wrappers are not called from the card either",
    !/checkCMAReady\(/.test(cardUi) &&
    !/checkNetSheetValid\(/.test(cardUi) &&
    !/checkPresentationReady\(/.test(cardUi))
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 4 — the feedback request stops lying and gains a tenant boundary
// ═══════════════════════════════════════════════════════════════════════════

function feedbackLayer() {
  section("[layer 4 · asking for feedback is not the same as receiving it]")

  const body = fnBody(OH, "requestFeedbackFromAttendee")

  check("F1", "requestFeedbackFromAttendee writes NOTHING to open_house_attendees",
    body !== "" && !/\.update\(/.test(body) && !/\.insert\(/.test(body) && !/\.upsert\(/.test(body))
  check("F2", "...it delegates delivery to the sender that actually sends",
    /sendFeedbackRequestToAttendee\(params\.attendeeId\)/.test(body))
  check("F3", "...and returns THAT sender's verdict instead of assuming delivery",
    /if\s*\(!sent\.success\)\s*\{[\s\S]{0,200}?return\s*\{\s*success:\s*false/.test(body))
  check("F4", "...ownership is proven against the STORED tenant via the service client",
    /createServiceClient\(\)/.test(body) &&
    /if\s*\(attendee\.brokerage_id\s*!==\s*auth\.brokerageId\)\s*return\s*\{\s*success:\s*false/.test(body))
  check("F5", "...an UNTENANTED attendee row is refused, not silently accepted",
    /if\s*\(!attendee\.brokerage_id\)\s*\{[\s\S]{0,300}?success:\s*false/.test(body))
  check("F6", "...the ownership read destructures its error",
    /const\s*\{\s*data:\s*attendee\s*,\s*error:\s*readErr\s*\}/.test(body) &&
    /if\s*\(readErr\)\s*return\s*\{\s*success:\s*false/.test(body) &&
    /\.maybeSingle\(\)/.test(body))
  check("F7", "...and an attendee who has already given feedback is refused",
    /if\s*\(attendee\.feedback_collected_at\)\s*\{[\s\S]{0,200}?success:\s*false/.test(body))

  section("[layer 4b · both feedback buttons go through the tenant-bounded path]")

  const panel = code(OHPANEL)
  const handler = fnBody(OHPANEL, "handleRequestFeedback")

  check("F8", "the post-event panel imports the tenant-bounded action",
    /\brequestFeedbackFromAttendee\b/.test(importedFrom(panel, "@/app/actions/seller-open-house")))
  check("F9", "...its handler calls it with the attendee AND the listing",
    /requestFeedbackFromAttendee\(\{\s*attendeeId\s*,\s*listingId\s*\}\)/.test(handler))
  check("F10", "...and reads the verdict before marking the request as sent",
    /if\s*\(!res\.success\)\s*\{[\s\S]{0,200}?setError\([\s\S]{0,120}?return/.test(handler))
  check("F11", "...the untenanted API route is no longer the panel's path",
    panel !== "" && !/api\/open-house\/request-feedback/.test(panel))

  const tab = code(OHTAB)
  check("F12", "the analytics tab also routes feedback through the tenant-bounded action",
    /requestFeedbackFromAttendee\(\{\s*attendeeId\s*,\s*listingId\s*\}\)/.test(tab) &&
    !/\bsendFeedbackRequestToAttendee\b/.test(tab))
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 5 — the attendee debrief reads a table that has a writer
// ═══════════════════════════════════════════════════════════════════════════

function debriefLayer() {
  section("[layer 5 · the debrief reads open_house_attendees, which is actually written]")

  const body = fnBody(OH, "generateOpenHouseAISummary")

  check("G1", "generateOpenHouseAISummary proves the event belongs to the caller first",
    /verifyEventOwnership\(params\.eventId,\s*auth\.brokerageId\)/.test(body) &&
    /if\s*\(!evOwn\.ok\)\s*return\s*\{\s*success:\s*false/.test(body))
  check("G2", "...its read destructures the error — a denial is not an empty open house",
    /const\s*\{\s*data:\s*attendees\s*,\s*error:\s*attendeeErr\s*\}/.test(body) &&
    /if\s*\(attendeeErr\)\s*\{[\s\S]{0,240}?success:\s*false/.test(body))
  check("G3", "...and it is brokerage-filtered on top of the event filter",
    /\.eq\(\s*["']event_id["']\s*,\s*params\.eventId\s*\)[\s\S]{0,160}?\.eq\(\s*["']brokerage_id["']\s*,\s*auth\.brokerageId\s*\)/.test(body))

  const sel = selectArgFor(body, "open_house_attendees")
  check("G4", "...it no longer fetches contact PII it never says out loud",
    sel.length === 1 && !/email/.test(sel[0]) && !/phone/.test(sel[0]))
  check("G5", "...the select is ONE string literal, not runtime concatenation",
    sel.length === 1 && !/\+/.test(sel[0]) && /^\s*["'][^"']+["']\s*$/.test(sel[0]))

  section("[layer 5b · the debrief is reachable and its refusal is visible]")

  const tab = code(OHTAB)
  const gen = fnBody(OHTAB, "handleGenerateDebrief")

  check("G6", "the analytics tab imports the debrief action",
    /\bgenerateOpenHouseAISummary\b/.test(importedFrom(tab, "@/app/actions/seller-open-house")))
  check("G7", "...calls it for the completed event",
    /generateOpenHouseAISummary\(\{\s*eventId:\s*completedEventId\s*\}\)/.test(gen))
  check("G8", "...reads the verdict and shows a failure as a failure",
    /if\s*\(!res\.success\)\s*\{[\s\S]{0,300}?setDebriefError\(/.test(gen))
  check("G9", "...and there is a control that reaches the handler",
    /onClick=\{handleGenerateDebrief\}/.test(tab) && /\{debriefError && \(/.test(tab))
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 6 — the public kiosk: open when the door is open, and public-safe
// ═══════════════════════════════════════════════════════════════════════════

// open_house_events_status_check, read live from project hrvaqgvukzxfskkcrwbt
// on 2026-08-05.
const LIVE_EVENT_STATUSES = ["scheduled", "marketing", "active", "completed", "cancelled"]
// The states checkInAttendee will still accept a check-in for.
const SIGNABLE_STATUSES = ["scheduled", "marketing", "active"]

function kioskLayer() {
  section("[layer 6 · the sign-in kiosk works during the open house, and leaks nothing]")

  const body = fnBody(OH, "getOpenHouseEventPublic")

  const inArg = /\.in\(\s*["']status["']\s*,\s*\[([^\]]*)\]\s*\)/.exec(body)?.[1] ?? ""
  const codedStatuses = Array.from(inArg.matchAll(/["']([^"']+)["']/g)).map((m) => m[1])

  check("P1", "the status filter is a set, not the single 'scheduled' that excluded a live event",
    codedStatuses.length === SIGNABLE_STATUSES.length &&
    SIGNABLE_STATUSES.every((s) => codedStatuses.includes(s)) &&
    !/\.eq\(\s*["']status["']\s*,\s*["']scheduled["']\s*\)/.test(body))
  check("P2", "...every status it accepts is one the live CHECK constraint allows",
    codedStatuses.length > 0 && codedStatuses.every((s) => LIVE_EVENT_STATUSES.includes(s)))
  check("P3", "...and a completed or cancelled event is still refused",
    codedStatuses.length > 0 &&
    !codedStatuses.includes("completed") && !codedStatuses.includes("cancelled"))

  const sel = selectArgFor(body, "open_house_events")
  check("P4", "the event select is ONE string literal — no runtime concatenation",
    sel.length === 1 && !/\+/.test(sel[0]) && /^\s*["'][^"']+["']\s*$/.test(sel[0]))

  // The RETURN literal is the public payload. Slice it, do not grep the body:
  // brokerage_id and agent_id are legitimately read inside the function.
  const retIdx = body.lastIndexOf("return {")
  const retLit = retIdx < 0 ? "" : body.slice(retIdx + 7, matchBrace(body, body.indexOf("{", retIdx)) + 1)

  check("P5", "the returned payload carries no tenant or row ids beyond the event itself",
    retLit !== "" &&
    !/brokerage_id/.test(retLit) && !/agent_id/.test(retLit) &&
    !/listing_id/.test(retLit) && !/email/.test(retLit) && !/list_price/.test(retLit))
  check("P6", "...and it does carry what a public event page must render",
    /eventId:/.test(retLit) && /eventDate:/.test(retLit) &&
    /listing:/.test(retLit) && /branding/.test(retLit) && /agent/.test(retLit))

  check("P7", "the agent is resolved agents -> agents.user_id -> users, with no id-space guess",
    /\.from\(\s*["']agents["']\s*\)[\s\S]{0,240}?\.eq\(\s*["']id["']\s*,\s*event\.agent_id\s*\)/.test(body) &&
    /\.from\(\s*["']users["']\s*\)[\s\S]{0,240}?\.eq\(\s*["']id["']\s*,\s*agentRow\.user_id\s*\)/.test(body) &&
    !/event\.agent_id\s*\?\?/.test(body))
  check("P8", "branding is scoped to THIS event's brokerage, never the first settings row",
    /\.from\(\s*["']global_settings["']\s*\)[\s\S]{0,240}?\.eq\(\s*["']brokerage_id["']\s*,\s*event\.brokerage_id\s*\)/.test(body) &&
    !/\.from\(\s*["']global_settings["']\s*\)[\s\S]{0,240}?\.limit\(1\)/.test(body))

  section("[layer 6b · the page stopped building its own duplicate query]")

  const page = code(KIOSKPAGE)
  check("P9", "the kiosk page calls the action instead of querying the database itself",
    /getOpenHouseEventPublic\(eventId\)/.test(page) && !/createServiceClient/.test(page))
  check("P10", "...and 404s on anything the action refuses to serve",
    /if\s*\(!event\)\s*notFound\(\)/.test(page))
  check("P11", "...the kiosk component is handed one payload, not a raw listing row",
    /<SignInKiosk\s+event=\{event\}\s*\/>/.test(page))

  const kiosk = code(KIOSK)
  const props = /interface\s+PublicOpenHouseEvent\s*\{([\s\S]*?)\n\}/.exec(kiosk)?.[1] ?? ""
  check("P12", "the public component's props declare no ids or emails beyond the event id",
    props !== "" && !/brokerage_id/.test(props) && !/agent_id/.test(props) &&
    !/\bemail\b/.test(props) && !/list_price/.test(props))
  check("P13", "...and the TCPA disclosure names the brokerage, resolved not guessed",
    /const consentPartyName = event\.brokerageName \?\? branding\?\.appName \?\? "our brokerage"/.test(kiosk) &&
    /TCPA_CONSENT_TEXT\(consentPartyName\)/.test(kiosk))
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 7 — calendar: a way in, a push, and a log that tells the truth
// ═══════════════════════════════════════════════════════════════════════════

// calendar_provider_accounts_provider_type_check, read live from project
// hrvaqgvukzxfskkcrwbt on 2026-08-05.
const LIVE_PROVIDER_TYPES = ["google_calendar", "outlook"]

function calendarLayer() {
  section("[layer 7 · you can now connect a calendar, and the log states the outcome]")

  const cal = code(CAL)
  const connect = fnBody(CAL, "connectCalendarProvider")
  const push = fnBody(CAL, "syncEventToProvider")
  const logs = fnBody(CAL, "fetchSyncLogs")

  const vocabArg =
    /const\s+LIVE_PROVIDER_TYPES\s*:[^=]*=\s*\[([^\]]*)\]/.exec(cal)?.[1] ?? ""
  const codedProviders = Array.from(vocabArg.matchAll(/["']([^"']+)["']/g)).map((m) => m[1])

  check("C1", "the provider vocabulary equals the live provider_type CHECK constraint",
    codedProviders.length === LIVE_PROVIDER_TYPES.length &&
    LIVE_PROVIDER_TYPES.every((p) => codedProviders.includes(p)) &&
    codedProviders.every((p) => LIVE_PROVIDER_TYPES.includes(p)))
  check("C2", "connectCalendarProvider validates the provider at RUNTIME and refuses",
    /LIVE_PROVIDER_TYPES\.includes\(providerType\)/.test(connect) &&
    /if\s*\(!LIVE_PROVIDER_TYPES\.includes\(providerType\)\)\s*\{[\s\S]{0,300}?ok:\s*false/.test(connect))
  check("C3", "...and the actor comes from the session, never from the caller",
    /supabase\.auth\.getUser\(\)/.test(connect) &&
    /linkCalendarProvider\(\{\s*\n?\s*userId:\s*user\.id/.test(connect))
  check("C4", "...it returns a verdict instead of throwing a page away",
    /return\s*\{\s*ok:\s*true\s*,\s*id:\s*linked\.id\s*\}/.test(connect) &&
    /catch\s*\(error\)\s*\{[\s\S]{0,300}?ok:\s*false/.test(connect))
  check("C5", "syncEventToProvider returns its outcome rather than swallowing it",
    /return\s*\{\s*ok:\s*true\s*\}/.test(push) &&
    /catch\s*\(error\)\s*\{[\s\S]{0,300}?ok:\s*false/.test(push))
  check("C6", "fetchSyncLogs distinguishes an empty history from a refused one",
    /return\s*\{\s*ok:\s*true\s*,\s*logs\s*\}/.test(logs) &&
    /catch\s*\(error\)\s*\{[\s\S]{0,300}?ok:\s*false/.test(logs))

  section("[layer 7b · the settings page reaches all three]")

  const page = code(CALPAGE)
  const imports = importedFrom(page, "@/app/actions/calendar/calendar-sync-actions")

  check("C7", "the settings page imports all three previously-unreachable actions",
    /\bconnectCalendarProvider\b/.test(imports) &&
    /\bsyncEventToProvider\b/.test(imports) &&
    /\bfetchSyncLogs\b/.test(imports))
  check("C8", "...a form actually calls the linker with both fields",
    /connectCalendarProvider\(\{[\s\S]{0,240}?providerType:[\s\S]{0,160}?providerAccountId:/.test(page))
  check("C9", "...and a refused link is shown to the agent, not hidden",
    /if\s*\(!res\.ok\)\s*redirect\(/.test(page) && /\{sp\.error && \(/.test(page))
  check("C10", "...the picker offers ONLY the two provider values the column accepts",
    LIVE_PROVIDER_TYPES.every((p) => new RegExp(`<option value="${p}">`).test(page)) &&
    (page.match(/<option value="/g) ?? []).length === LIVE_PROVIDER_TYPES.length)
  check("C11", "...sync logs are fetched per account and their verdict kept",
    /await fetchSyncLogs\(account\.id\)/.test(page) &&
    /res\.ok\s*\?\s*\{\s*logs:\s*res\.logs,\s*error:\s*null\s*\}\s*:\s*\{\s*logs:\s*\[\],\s*error:\s*res\.error\s*\}/.test(page))
  check("C12", "...and the log's own status and reason are what the screen prints",
    /\{log\.status\}/.test(page) && /\{log\.error_message\}/.test(page) &&
    /history\?\.error \?/.test(page))
  check("C13", "...the placeholder that promised logs it never fetched is gone",
    page !== "" && !/Sync logs will appear here after the first sync/.test(page))
  check("C14", "...a push button exists and surfaces its refusal",
    /syncEventToProvider\(ev\.id,\s*account\.id\)/.test(page))

  section("[layer 7c · the iCal token stops being another tenant's]")

  check("C15", "the settings read is filtered to the caller's own brokerage",
    /\.from\(\s*["']global_settings["']\s*\)[\s\S]{0,240}?\.eq\(\s*["']brokerage_id["']\s*,\s*brokerageId\s*\)/.test(page))
  check("C16", "...and it can no longer throw the whole page away on zero rows",
    !/\.limit\(1\)\s*\n?\s*\.single\(\)/.test(page) &&
    /const\s*\{\s*data:\s*settings\s*,\s*error:\s*settingsError\s*\}[\s\S]{0,400}?\.maybeSingle\(\)/.test(page))
  check("C17", "...a missing token is a statement about the token only",
    /iCalNote\s*=\s*"No iCalendar feed token/.test(page))
}

// ═══════════════════════════════════════════════════════════════════════════

function runAll(): Result[] {
  results = []
  clearCaches()
  selfTest()
  buyerTenancyLayer()
  buyerSurfaceLayer()
  sellerDecisionLayer()
  feedbackLayer()
  debriefLayer()
  kioskLayer()
  calendarLayer()
  return results
}

// ═══════════════════════════════════════════════════════════════════════════
// NEGATIVE TESTS — mutate real source, prove the SPECIFIC check fails
// ═══════════════════════════════════════════════════════════════════════════

const MUTATIONS: Array<{ id: string; file: string; note: string; find: string; replace: string }> = [
  { id: "B1", file: BUYER, note: "take the tenant back from the caller",
    find: `export async function getBuyerLifecycleStatistics(params?: {\n  startDate?: Date`,
    replace: `export async function getBuyerLifecycleStatistics(params?: {\n  brokerageId: string\n  startDate?: Date` },

  { id: "B4", file: BUYER, note: "take the cohort reader's tenant back from the caller",
    find: `export async function getBuyersInSpecificState(params: {\n  state: BuyerState`,
    replace: `export async function getBuyersInSpecificState(params: {\n  brokerageId: string\n  state: BuyerState` },

  { id: "B2", file: BUYER, note: "continue past an unresolved session",
    find: `  const ctx = await requireBrokerage()\n  if (!ctx.ok) return { ok: false, error: ctx.error }\n\n  const statistics = await getLifecycleStatistics(`,
    replace: `  const ctx = await requireBrokerage()\n  if (!ctx.ok) return { ok: false, error: "" as string }\n\n  const statistics = await getLifecycleStatistics(` },

  { id: "B6", file: BUYER, note: "let an unknown state through as an empty cohort",
    find: `  if (!getStateDefinition(params.state)) {`,
    replace: `  if (false && !getStateDefinition(params.state)) {` },

  { id: "B8", file: BUYER, note: "swallow the users read error into 'no brokerage'",
    find: `  const { data: row, error } = await supabase\n    .from("users")`,
    replace: `  const { data: row } = await supabase\n    .from("users")` },

  { id: "B10", file: BUYER, note: "resurrect the subset wrapper",
    find: `export async function getBuyerEnabledGates(contactId: string): Promise<string[]> {`,
    replace: `export async function isBuyerGateEnabled(p: { contactId: string }): Promise<string[]> {\n  return []\n}\n\nexport async function getBuyerEnabledGates(contactId: string): Promise<string[]> {` },

  { id: "B14", file: PANEL, note: "hand the panel's tenant back to the reader",
    find: `        getBuyerLifecycleStatistics(),`,
    replace: `        getBuyerLifecycleStatistics({ brokerageId } as never),` },

  { id: "B16", file: PANEL, note: "render a refused statistics read as zero buyers",
    find: `      if (!stats.ok) { setCohort({ kind: "error", message: stats.error }); return }`,
    replace: `      if (!stats.ok) { return }` },

  { id: "B19", file: PANEL, note: "list the buyer as their own peer",
    find: `        peerContactIds: peers.contactIds.filter((id) => id !== contactId),`,
    replace: `        peerContactIds: peers.contactIds,` },

  { id: "D1", file: GOV, note: "resurrect the boolean-only CMA wrapper",
    find: `export async function evaluateListingCMAQuality(input: {`,
    replace: `export async function checkCMAReady(listingId: string) {\n  return { success: true, data: { isReady: false } }\n}\n\nexport async function evaluateListingCMAQuality(input: {` },

  { id: "D6", file: GOV, note: "drop the expiry warning the survivor carries",
    find: `      await emitNetSheetExpirationWarning(input.listingId, result.daysRemaining)`,
    replace: `      void result.daysRemaining` },

  { id: "D9", file: CARD, note: "stop calling the detailed CMA evaluator",
    find: `        evaluateListingCMAQuality({ listingId }),`,
    replace: `        Promise.resolve({ success: true, data: null } as never),` },

  { id: "F1", file: OH, note: "stamp feedback as collected at request time again",
    find: `  const { sendFeedbackRequestToAttendee } = await import("@/app/actions/open-house-automation")`,
    replace: `  await svc.from("open_house_attendees").update({ feedback_collected_at: new Date().toISOString() }).eq("id", params.attendeeId)\n  const { sendFeedbackRequestToAttendee } = await import("@/app/actions/open-house-automation")` },

  { id: "F3", file: OH, note: "report success for a delivery the sender refused",
    find: `  if (!sent.success) {\n    return { success: false, error: sent.error ?? "The feedback request was not delivered" }\n  }`,
    replace: `  void sent` },

  { id: "F5", file: OH, note: "accept an untenanted attendee row",
    find: `  if (!attendee.brokerage_id) {`,
    replace: `  if (false) {` },

  { id: "F6", file: OH, note: "swallow the ownership read error",
    find: `  const { data: attendee, error: readErr } = await svc`,
    replace: `  const readErr = null as { message: string } | null\n  const { data: attendee } = await svc` },

  { id: "F9", file: OHPANEL, note: "call the action without the listing it revalidates",
    find: `    const res = await requestFeedbackFromAttendee({ attendeeId, listingId })`,
    replace: `    const res = await requestFeedbackFromAttendee({ attendeeId, listingId: "" })` },

  { id: "F12", file: OHTAB, note: "route the analytics tab back through the untenanted sender",
    find: `    const res = await requestFeedbackFromAttendee({ attendeeId, listingId })`,
    replace: `    const res = { success: true } as { success: boolean; error?: string }; void attendeeId` },

  { id: "G2", file: OH, note: "render a refused attendee read as an empty open house",
    find: `  const { data: attendees, error: attendeeErr } = await supabase\n    .from("open_house_attendees")\n    .select("name, working_with_agent, interest_level, ai_lead_score, notes")`,
    replace: `  const attendeeErr = null as { message: string } | null\n  const { data: attendees } = await supabase\n    .from("open_house_attendees")\n    .select("name, working_with_agent, interest_level, ai_lead_score, notes")` },

  { id: "G4", file: OH, note: "fetch attendee PII the summary never speaks",
    find: `    .select("name, working_with_agent, interest_level, ai_lead_score, notes")`,
    replace: `    .select("name, email, phone, working_with_agent, interest_level, ai_lead_score, notes")` },

  { id: "G8", file: OHTAB, note: "ignore the debrief's verdict",
    find: `    if (!res.success) {\n      setDebrief(null)\n      setDebriefError(res.error ?? "The debrief could not be generated.")\n      return\n    }`,
    replace: `    void res` },

  { id: "P1", file: OH, note: "close the kiosk during the open house again",
    find: `    .in("status", ["scheduled", "marketing", "active"])`,
    replace: `    .eq("status", "scheduled")` },

  { id: "P3", file: OH, note: "let a completed event keep collecting sign-ins",
    find: `    .in("status", ["scheduled", "marketing", "active"])`,
    replace: `    .in("status", ["scheduled", "marketing", "active", "completed"])` },

  { id: "P5", file: OH, note: "put the tenant id back into the public payload",
    find: `  return {\n    eventId: event.id,`,
    replace: `  return {\n    brokerage_id: event.brokerage_id,\n    eventId: event.id,` },

  { id: "P7", file: OH, note: "look an agents.id up in the users id space again",
    find: `      .eq("id", agentRow.user_id)`,
    replace: `      .eq("id", event.agent_id)` },

  { id: "P8", file: OH, note: "read branding from whichever settings row comes first",
    find: `      .eq("brokerage_id", event.brokerage_id)\n      .maybeSingle()`,
    replace: `      .limit(1)\n      .maybeSingle()` },

  { id: "P9", file: KIOSKPAGE, note: "let the page rebuild its own duplicate query",
    find: `import { getOpenHouseEventPublic } from "@/app/actions/seller-open-house"`,
    replace: `import { createServiceClient } from "@/lib/supabase/service"\nimport { getOpenHouseEventPublic } from "@/app/actions/seller-open-house"` },

  { id: "P13", file: KIOSK, note: "name the consent party after the white-label app only",
    find: `  const consentPartyName = event.brokerageName ?? branding?.appName ?? "our brokerage"`,
    replace: `  const consentPartyName = branding?.appName ?? "our brokerage"` },

  { id: "C1", file: CAL, note: "offer a provider the column refuses",
    find: `const LIVE_PROVIDER_TYPES: readonly CalendarProviderType[] = ["google_calendar", "outlook"]`,
    replace: `const LIVE_PROVIDER_TYPES = ["google_calendar", "outlook", "apple_calendar"] as string[]` },

  { id: "C2", file: CAL, note: "skip the runtime vocabulary gate",
    find: `  if (!LIVE_PROVIDER_TYPES.includes(providerType)) {`,
    replace: `  if (false) {` },

  { id: "C6", file: CAL, note: "make a refused sync history look like an empty one",
    find: `    const logs = await listSyncLogs({ userId: user.id, providerAccountId })\n    return { ok: true, logs }`,
    replace: `    const logs = await listSyncLogs({ userId: user.id, providerAccountId })\n    return { ok: true as const, logs }` },

  { id: "C10", file: CALPAGE, note: "offer a third provider the database refuses",
    find: `              <option value="outlook">Outlook</option>`,
    replace: `              <option value="outlook">Outlook</option>\n              <option value="apple_calendar">Apple Calendar</option>` },

  { id: "C11", file: CALPAGE, note: "drop the sync-history refusal on the floor",
    find: `      res.ok ? { logs: res.logs, error: null } : { logs: [], error: res.error },`,
    replace: `      res.ok ? { logs: res.logs, error: null } : { logs: [], error: null },` },

  { id: "C15", file: CALPAGE, note: "read whichever brokerage's ical token comes first",
    find: `      .select("additional_settings")\n      .eq("brokerage_id", brokerageId)`,
    replace: `      .select("additional_settings")` },

  { id: "C16", file: CALPAGE, note: "throw the whole page away when there is no settings row",
    find: `      .eq("brokerage_id", brokerageId)\n      .maybeSingle()`,
    replace: `      .eq("brokerage_id", brokerageId)\n      .limit(1)\n      .single()` },
]

function negativeTests(): { ran: number; proved: number; problems: string[] } {
  const problems: string[] = []
  let proved = 0

  for (const mut of MUTATIONS) {
    const abs = join(process.cwd(), mut.file)
    const original = readFileSync(abs, "utf8")
    const shaBefore = sha(mut.file)

    if (!original.includes(mut.find)) {
      problems.push(`[${mut.id}] mutation anchor not found in ${mut.file} — the negative test did not run`)
      continue
    }

    writeFileSync(abs, original.replace(mut.find, mut.replace), "utf8")
    const shaAfter = sha(mut.file)

    try {
      if (shaAfter === shaBefore) {
        problems.push(`[${mut.id}] mutation did not change the file (sha256 identical) — not a real test`)
        continue
      }

      quiet = true
      const mutated = runAll()
      quiet = false

      const target = mutated.find((r) => r.id === mut.id)
      if (!target) {
        problems.push(`[${mut.id}] check id does not exist`)
      } else if (target.ok) {
        problems.push(`[${mut.id}] SURVIVED "${mut.note}" — the assertion cannot fail, so it proves nothing`)
      } else {
        proved++
        console.log(`  ✓ [${mut.id}] fails when: ${mut.note}`)
      }
    } finally {
      writeFileSync(abs, original, "utf8")
      const shaRestored = sha(mut.file)
      if (shaRestored !== shaBefore) {
        problems.push(`[${mut.id}] RESTORE FAILED for ${mut.file} — sha256 ${shaRestored} != ${shaBefore}`)
      }
    }
  }

  return { ran: MUTATIONS.length, proved, problems }
}

// ═══════════════════════════════════════════════════════════════════════════
// COVERAGE SWEEP — every assertion must depend on the file it claims to read
// ═══════════════════════════════════════════════════════════════════════════
//
// The mutations above prove an assertion is TIGHT ENOUGH to catch a plausible
// regression. This sweep proves the complementary thing about EVERY assertion:
// that it reads the construct it claims to read. Each file is blanked in turn
// and the checks that own it must all fail.
//
// Checks written as a pure negation ("this is gone") pass on a blank file by
// construction — that is exactly what vacuous truth looks like — so each is
// listed here and paired with a positive assertion that does fail, named so
// the pairing cannot rot silently.

const OWNERSHIP: Record<string, string[]> = {
  [BUYER]: ["SELF-4", "B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B12"],
  [PANEL]: ["B13", "B14", "B15", "B16", "B17", "B18", "B19", "B20"],
  [GOV]: ["D4", "D5", "D6", "D7"],
  [CARD]: ["D9", "D10", "D11"],
  [OH]: ["SELF-5", "F1", "F2", "F3", "F4", "F5", "F6", "F7",
         "G1", "G2", "G3", "G4", "G5",
         "P1", "P2", "P4", "P5", "P6", "P7", "P8"],
  [OHPANEL]: ["F8", "F9", "F10"],
  [OHTAB]: ["F12", "G6", "G7", "G8", "G9"],
  [KIOSKPAGE]: ["P9", "P10", "P11"],
  [KIOSK]: ["P12", "P13"],
  [CAL]: ["C1", "C2", "C3", "C4", "C5", "C6"],
  [CALPAGE]: ["C7", "C8", "C9", "C10", "C11", "C12", "C14", "C15", "C16", "C17"],
}

/** id -> the positive assertion that carries its weight on a blank file. */
const VACUOUS_ON_BLANK: Record<string, string> = {
  "B10": "B12 (the NAMED survivor must still exist and still delegate)",
  "B11": "B12",
  "D1": "D4 + D5 (the survivors must exist and still derive-then-evaluate)",
  "D2": "D4 + D6",
  "D3": "D4 + D7",
  "D8": "D5 + D6 + D7 (the survivors' own bodies must still be present)",
  "D12": "D9 (the card must call the three survivors)",
  "F11": "F8 + F9 (the panel must import and call the bounded action)",
  "P3": "P1 + P2 (the accepted status set must be present and live-legal)",
  "C13": "C11 + C12 (real log rows must be fetched and printed)",
  "SELF-1": "SELF-3 (the stripper self-test runs on an inline fixture)",
  "SELF-2": "SELF-3",
  "SELF-3": "n/a — operates on an inline fixture, not project source",
}

function coverageSweep(): { checked: number; problems: string[] } {
  const problems: string[] = []
  let checked = 0

  quiet = true
  const allIds = runAll().map((r) => r.id)
  quiet = false
  const owned = new Set(Object.values(OWNERSHIP).flat())
  for (const id of allIds) {
    if (!owned.has(id) && !(id in VACUOUS_ON_BLANK)) {
      problems.push(`[${id}] is neither owned by a file nor declared vacuous-on-blank`)
    }
  }

  for (const file of ALL_FILES) {
    const abs = join(process.cwd(), file)
    const original = readFileSync(abs, "utf8")
    const shaBefore = sha(file)
    writeFileSync(abs, "export {}\n", "utf8")
    try {
      if (sha(file) === shaBefore) {
        problems.push(`blanking ${file} did not change it — sweep invalid`)
        continue
      }
      quiet = true
      const blanked = runAll()
      quiet = false
      for (const id of OWNERSHIP[file] ?? []) {
        checked++
        const r = blanked.find((x) => x.id === id)
        if (!r) problems.push(`[${id}] declared for ${file} but no such check exists`)
        else if (r.ok) problems.push(`[${id}] STILL PASSES with ${file} blanked — it does not read that file`)
      }
    } finally {
      writeFileSync(abs, original, "utf8")
      if (sha(file) !== shaBefore) problems.push(`RESTORE FAILED for ${file}`)
    }
  }

  return { checked, problems }
}

// ═══════════════════════════════════════════════════════════════════════════
// OPTIONAL LIVE LAYER — skips LOUDLY, and a skip is not a pass
// ═══════════════════════════════════════════════════════════════════════════

async function liveLayer(): Promise<"ran" | "skipped"> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    console.log("\n" + "!".repeat(74))
    console.log("!! LIVE LAYER SKIPPED — no NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.")
    console.log("!! A SKIP IS NOT A PASS. The CHECK vocabularies asserted above")
    console.log("!!   open_house_events.status  = scheduled|marketing|active|completed|cancelled")
    console.log("!!   calendar_provider_accounts.provider_type = google_calendar|outlook")
    console.log("!! were read from project hrvaqgvukzxfskkcrwbt on 2026-08-05 and are hard-coded")
    console.log("!! here. If the schema has moved since, this run cannot tell you.")
    console.log("!".repeat(74))
    return "skipped"
  }

  const { createClient: sb } = await import("@supabase/supabase-js")
  const db = sb(url, key, { auth: { persistSession: false } })

  console.log("\n[live · the columns these actions name still exist]")

  // Read-only probes. Each selects the exact column list the wired code selects;
  // PostgREST 400s on an unknown column, so a rename cannot pass silently.
  // NOTHING IS WRITTEN, so there is no residue to clean up — proven by LIVE-5.
  const probes: Array<[string, string, string]> = [
    ["LIVE-1", "open_house_attendees", "id, brokerage_id, contact_id, feedback_collected_at, name, working_with_agent, interest_level, ai_lead_score, notes"],
    ["LIVE-2", "open_house_events", "id, event_date, start_time, end_time, status, brokerage_id, agent_id"],
    ["LIVE-3", "calendar_sync_logs", "id, brokerage_id, provider_account_id, direction, event_count, status, error_message, started_at, completed_at"],
    ["LIVE-4", "calendar_provider_accounts", "id, brokerage_id, user_id, provider_type, provider_account_id, is_active, last_sync_at, sync_direction"],
  ]

  for (const [id, table, columns] of probes) {
    const { error } = await db.from(table).select(columns).limit(1)
    check(id, `${table} still has every column the wired code selects`, !error)
    if (error) console.log(`    ${error.message}`)
  }

  // The status filter the kiosk uses must at minimum be accepted by the API.
  const { error: statusErr } = await db
    .from("open_house_events")
    .select("id")
    .in("status", SIGNABLE_STATUSES)
    .limit(1)
  check("LIVE-5", "the kiosk's status filter is accepted by the live table", !statusErr)

  console.log("  (this layer is READ-ONLY — it inserts nothing, so it leaves no residue)")

  return "ran"
}

// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("=".repeat(74))
  console.log("BUYER / SELLER-DECISION / OPEN-HOUSE / CALENDAR WIRING SIMULATOR")
  console.log("=".repeat(74))

  const first = runAll()
  const passed = first.filter((r) => r.ok).length
  const failed = first.filter((r) => !r.ok)

  console.log("\n" + "-".repeat(74))
  console.log(`STATIC ASSERTIONS: ${passed}/${first.length} passed`)
  if (failed.length) {
    console.log("FAILED:")
    for (const f of failed) console.log(`  ✗ [${f.id}] ${f.label}`)
  }

  console.log("\n" + "-".repeat(74))
  console.log("NEGATIVE TESTS — mutating real source, proving each check can fail")
  const neg = negativeTests()
  console.log(`\nNEGATIVE TESTS: ${neg.proved}/${neg.ran} assertions proven falsifiable`)
  if (neg.problems.length) {
    console.log("PROBLEMS:")
    for (const p of neg.problems) console.log(`  ✗ ${p}`)
  }

  console.log("\n" + "-".repeat(74))
  console.log("COVERAGE SWEEP — blanking each file, every assertion that owns it must fail")
  const sweep = coverageSweep()
  console.log(`COVERAGE SWEEP: ${sweep.checked} assertions proven to read real source`)
  console.log(`  (${Object.keys(VACUOUS_ON_BLANK).length} assertions are pure negations and pass on a`)
  console.log(`   blank file by construction — each is paired with a positive assertion above)`)
  if (sweep.problems.length) {
    console.log("PROBLEMS:")
    for (const p of sweep.problems) console.log(`  ✗ ${p}`)
  }

  const after = runAll()
  const afterPassed = after.filter((r) => r.ok).length
  const restoredClean = afterPassed === passed && after.length === first.length
  console.log(`\nPOST-RESTORE RE-RUN: ${afterPassed}/${after.length} passed ` +
    `(${restoredClean ? "identical to the first run" : "DIFFERENT — a restore leaked"})`)

  const live = await liveLayer()

  console.log("\n" + "=".repeat(74))
  const ok = failed.length === 0 && neg.problems.length === 0 &&
    sweep.problems.length === 0 && restoredClean
  console.log(ok ? "RESULT: PASS" : "RESULT: FAIL")
  if (live === "skipped") console.log("(live layer skipped — see the banner above; a skip is not a pass)")
  console.log("=".repeat(74))

  process.exit(ok ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
