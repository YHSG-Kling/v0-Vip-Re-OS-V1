#!/usr/bin/env tsx
/**
 * scripts/openhouse-reputation-wiring-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PROOF FOR THE OPEN HOUSE + REPUTATION MISSING MIDDLE.
 *
 * Two layers.
 *
 * STATIC layer (always runs, no DB):
 *   Reads the real source files, STRIPS COMMENTS FIRST so prose can never
 *   satisfy an assertion, slices individual function bodies so a neighbouring
 *   function cannot satisfy a check on its behalf, and asserts CONSTRUCTS:
 *     · the capability is reached from a real surface,
 *     · the surface reports the SERVER's refusal rather than an optimistic
 *       success,
 *     · every tenant-scoped write carries a brokerage stamp,
 *     · no read is destructured without its error,
 *     · every status/platform literal the code can emit is drawn from the one
 *       canonical vocabulary rather than a private list,
 *     · and the capabilities deliberately left unwired are still unwired, with
 *       the named existing writer still present.
 *
 * LIVE layer (creds-gated, self-cleaning):
 *   Seeds a tagged brokerage/agent/listing/open-house, drives the real kernel
 *   commands against the live schema, proves the walk-in insert shape that was
 *   there before is REFUSED, proves the vocabularies this code emits are all
 *   storable, proves responding to a published review does not unpublish it,
 *   then deletes everything and RE-COUNTS to show zero residue.
 *   With no creds, or with the database unreachable, it SKIPS LOUDLY — a
 *   network error is never scored as a pass.
 *
 * Run:
 *   npx tsx scripts/openhouse-reputation-wiring-simulator.ts
 * Live run:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/openhouse-reputation-wiring-simulator.ts
 */
import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { resolve as resolvePath } from "node:path"
import { fileURLToPath } from "node:url"
import { REFERRAL_STATUSES } from "../lib/referrals/referral-status"
import { blankComments } from "./strip-comments"

// ═════════════════════════════════════════════════════════════════════════════
// HARNESS
// ═════════════════════════════════════════════════════════════════════════════

let pass = 0
const failures: string[] = []

/** Named assertions so a negative test can prove ONE specific check flipped. */
function check(id: string, description: string, condition: boolean): void {
  if (condition) {
    pass++
    console.log(`  ✓ [${id}] ${description}`)
  } else {
    failures.push(id)
    console.log(`  ✗ [${id}] ${description}`)
  }
}

const ROOT = resolvePath(fileURLToPath(import.meta.url), "..", "..")
const read = (rel: string): string => readFileSync(resolvePath(ROOT, rel), "utf8")

// ═════════════════════════════════════════════════════════════════════════════
// COMMENT STRIPPER
// ═════════════════════════════════════════════════════════════════════════════

// hand-rolled scanner replaced (finding #250): it could not see nested `${…}` templates, regex literals, or an apostrophe in JSX text, and went blind on the code it judges.
const stripComments = blankComments

// ═════════════════════════════════════════════════════════════════════════════
// BODY SLICER
// ═════════════════════════════════════════════════════════════════════════════

/** Brace-matches from the first `{` at or after `from`. Assumes comment-stripped input. */
function braceBlockAt(source: string, from: number): string {
  const start = source.indexOf("{", from)
  if (start < 0) return ""
  let depth = 0
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch
      i++
      while (i < source.length) {
        if (source[i] === "\\") { i += 2; continue }
        if (source[i] === q) break
        i++
      }
      continue
    }
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return ""
}

/**
 * Returns the BODY of a named function/arrow/method, so an assertion cannot be
 * satisfied by a neighbouring declaration in the same file. Empty string when
 * the name is not declared — which fails any check that reads it.
 */
function functionBody(source: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const patterns = [
    new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\s*[(<]`),
    new RegExp(`(?:export\\s+)?(?:const|let)\\s+${escaped}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?[(<]`),
    new RegExp(`\\b${escaped}\\s*[:=]\\s*(?:async\\s*)?\\(`),
  ]
  for (const p of patterns) {
    const m = p.exec(source)
    if (!m) continue
    // Walk past the parameter list, then past the RETURN TYPE ANNOTATION. A
    // signature like `): Promise<{ ok: true }> {` contains a brace that is part
    // of the type, so naively taking "the next brace" slices the type instead of
    // the body — and an empty/wrong slice makes every assertion on it a lie.
    let i = m.index + m[0].length - 1
    let paren = 0
    for (; i < source.length; i++) {
      const ch = source[i]
      if (ch === "(" || ch === "[") paren++
      else if (ch === ")" || ch === "]") { paren--; if (paren === 0) { i++; break } }
    }
    let angle = 0
    let bodyStart = -1
    for (; i < source.length; i++) {
      const ch = source[i]
      if (ch === "<") angle++
      else if (ch === ">") { if (angle > 0) angle-- }
      else if (ch === "{" && angle === 0) { bodyStart = i; break }
    }
    const body = bodyStart >= 0 ? braceBlockAt(source, bodyStart) : ""
    if (body) return body
  }
  return ""
}

/** The arrow/callback expression that CONTAINS a given call, sliced by braces. */
function enclosingBlockOf(source: string, needle: string): string {
  const at = source.indexOf(needle)
  if (at < 0) return ""
  // Walk backwards to the nearest unbalanced `{`.
  let depth = 0
  for (let i = at; i >= 0; i--) {
    if (source[i] === "}") depth++
    else if (source[i] === "{") {
      if (depth === 0) return braceBlockAt(source, i)
      depth--
    }
  }
  return ""
}

// ═════════════════════════════════════════════════════════════════════════════
// SHARED CONSTRUCT PREDICATES
// ═════════════════════════════════════════════════════════════════════════════

/**
 * supabase-js RESOLVES a failed query. A destructure that takes only `data`
 * therefore turns a refusal into an empty result. This finds any such
 * destructure in a body.
 */
function hasBareDataDestructure(body: string): boolean {
  return /const\s*\{\s*data(?:\s*:\s*[A-Za-z_$][\w$]*)?\s*\}\s*=\s*await/.test(body)
}

/** Every key AND every target value quoted inside an object-literal graph. */
function statusGraphVocabulary(body: string): Set<string> {
  const vocab = new Set<string>()
  for (const m of body.matchAll(/^\s*([A-Za-z_][\w]*)\s*:\s*\[/gm)) vocab.add(m[1])
  for (const m of body.matchAll(/"([a-z_]+)"/g)) vocab.add(m[1])
  return vocab
}

/**
 * The object literal handed to `.insert(` on a given table, so a tenant-stamp
 * assertion is made against the PAYLOAD rather than against the whole function
 * (where a parameter declaration named brokerage_id would satisfy it).
 */
function insertPayload(body: string, table: string, actionType?: string): string {
  const re = new RegExp(`from\\(\\s*"${table}"\\s*\\)[\\s\\S]{0,120}?\\.insert\\(`, "g")
  for (const m of body.matchAll(re)) {
    const payload = braceBlockAt(body, m.index + m[0].length - 1)
    if (!actionType || payload.includes(`"${actionType}"`)) return payload
  }
  return ""
}

/** The `{ … }` block guarded by `if (<condition>)`, so a guard can be asserted to act. */
function guardedBlock(body: string, condition: string): string {
  const re = new RegExp(`if\\s*\\(\\s*${condition}\\s*\\)\\s*\\{`)
  const m = re.exec(body)
  if (!m) return ""
  return braceBlockAt(body, m.index + m[0].length - 1)
}

/** The string literals in an `as const` array literal assigned to `name`. */
function arrayLiteralValues(source: string, name: string): string[] {
  const re = new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`)
  const m = re.exec(source)
  if (!m) return []
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])
}

/** The `value:` members of an object-array literal assigned to `name`. */
function objectArrayValues(source: string, name: string): string[] {
  const re = new RegExp(`${name}[^=]*=\\s*\\[([\\s\\S]*?)\\n\\]`)
  const m = re.exec(source)
  if (!m) return []
  return [...m[1].matchAll(/value:\s*"([^"]+)"/g)].map((x) => x[1])
}

// ═════════════════════════════════════════════════════════════════════════════
// FILES UNDER TEST
// ═════════════════════════════════════════════════════════════════════════════

const F = {
  ohAction:  "app/actions/open-house-kernel.ts",
  ohKernel:  "lib/kernel/open-house.ts",
  repAction: "app/actions/reputation-kernel.ts",
  repKernel: "lib/kernel/reputation.ts",
  ohSurface: "app/dashboard/open-houses/open-houses-client.tsx",
  reviewSurface: "app/dashboard/referrals/components/os/review-request-panel.tsx",
  reputationSurface: "app/components/reputation/ReputationPanel.tsx",
  lifetimeSurface: "app/lifetime-customers/page.tsx",
  referralWriter: "app/actions/referrals/referral-actions.ts",
  reviewWriterA: "app/actions/multi-persona.ts",
  reviewWriterB: "app/actions/portal-lifetime.ts",
  ohLegacy: "app/actions/open-house.ts",
  ohKiosk: "app/api/open-house/attend/route.ts",
}

const S: Record<keyof typeof F, string> = Object.fromEntries(
  Object.entries(F).map(([k, v]) => [k, stripComments(read(v))]),
) as Record<keyof typeof F, string>

const OH_ACTIONS = [
  "resolveOrCreateOpenHouseContactAction",
  "createOpenHouseAttendeeFromContactAction",
  "attachOpenHouseSourceAttributionAction",
  "notifyAssignedAgentForOpenHouseLeadAction",
  "generateOpenHouseFollowupNextActionAction",
] as const

// ═════════════════════════════════════════════════════════════════════════════
// STATIC LAYER
// ═════════════════════════════════════════════════════════════════════════════

function staticLayer(): void {
  console.log("\n[comment stripper · self-test]")
  {
    const probe = [
      'const a = "kept"',
      "const re = /a\\/b/",
      "const t = `tpl`",
    ].join("\n")
    const stripped = stripComments(probe)
    check("STRIP-1", "string, regex and template literals survive stripping",
      stripped.includes('"kept"') && stripped.includes("/a\\/b/") && stripped.includes("`tpl`"))
    // Built from fragments so this file never contains a literal block-comment
    // opener inside a string.
    const opener = "/" + "*"
    const closer = "*" + "/"
    const commented = `${opener} brokerage_id ${closer}\nconst x = 1 // brokerage_id\n`
    check("STRIP-2", "prose inside comments cannot satisfy a source assertion",
      !stripComments(commented).includes("brokerage_id"))
  }

  console.log("\n[open house · action layer]")
  for (const name of OH_ACTIONS) {
    const body = functionBody(S.ohAction, name)
    check(`OH-SCOPE-${name}`, `${name} resolves its tenant + actor server-side`,
      body.length > 0 && /resolve\w*Scope\s*\(/.test(body) && /scope\./.test(body))
    check(`OH-NOSPOOF-${name}`, `${name} refuses a caller-supplied brokerage_id / agent_id`,
      body.length > 0 && !/input\.(brokerage_id|agent_id)/.test(body))
    check(`OH-REFUSAL-${name}`, `${name} returns the refusal instead of proceeding`,
      /success:\s*false/.test(body) && /error:\s*\w*scoped\w*\.error|error:\s*scoped\.error/.test(body))
  }
  {
    const scope = functionBody(S.ohAction, "resolveOpenHouseScope")
    check("OH-TENANT-GATE", "scope resolver proves the open house is in the actor's brokerage",
      /from\(\s*"open_house_events"\s*\)/.test(scope) &&
      /event\.brokerage_id\s*!==\s*ctx\.brokerageId/.test(scope))
    check("OH-SCOPE-ERR", "scope resolver destructures the event read's error",
      !hasBareDataDestructure(scope) && /eventErr/.test(scope))
    check("OH-IDENTITY", "scope resolver takes agents.id from the identity helper, never users.id",
      /ctx\.agentId/.test(scope) && !/ctx\.userId/.test(scope))

    const complete = functionBody(S.ohAction, "completeOpenHouseCheckInAction")
    check("OH-NORMALISE", "composite check-in normalises the incoming agent_id class",
      /normaliseAgentId\s*\(/.test(complete) && !/agent_id:\s*input\.agent_id/.test(complete))
    check("OH-DEGRADED", "composite check-in reports enrichment steps that failed",
      /attributionResult/.test(complete) && /notifyResult/.test(complete) &&
      /followupResult\.success/.test(complete) && /error:\s*degraded\.length/.test(complete))

    const normalise = functionBody(S.ohAction, "normaliseAgentId")
    check("OH-NO-FALLBACK", "agent id normaliser refuses rather than substituting the id it was handed",
      /resolveUserIdToAgentRecord\s*\(/.test(normalise) &&
      /ok:\s*false/.test(normalise) &&
      !/\?\?\s*candidateAgentId/.test(normalise))
  }

  console.log("\n[open house · kernel writes]")
  {
    const attendee = functionBody(S.ohKernel, "createOpenHouseAttendeeFromContact")
    check("OH-TENANT-ATTENDEE", "the attendee INSERT PAYLOAD carries a brokerage stamp",
      /\bbrokerage_id\b/.test(insertPayload(attendee, "open_house_attendees")))
    check("OH-TENANT-ATTENDEE-REQ", "attendee insert refuses an untenanted write",
      /success:\s*false/.test(guardedBlock(attendee, "!brokerage_id")))

    const notify = functionBody(S.ohKernel, "notifyAssignedAgentForOpenHouseLead")
    check("OH-TENANT-NOTIFY", "the agent-notification INSERT PAYLOAD carries a brokerage stamp",
      /\bbrokerage_id\b/.test(insertPayload(notify, "ai_autopilot_actions", "open_house_follow_up")))
    check("OH-NOTIFY-VERDICT", "a refused notification is reported, not logged and swallowed",
      /return\s*\{\s*success:\s*false/.test(guardedBlock(notify, "actionErr")))

    const followup = functionBody(S.ohKernel, "generateOpenHouseFollowupNextAction")
    check("OH-TENANT-FOLLOWUP", "the follow-up INSERT PAYLOAD carries a brokerage stamp",
      /\bbrokerage_id\b/.test(insertPayload(followup, "ai_autopilot_actions", "open_house_follow_up_message")))

    const attribution = functionBody(S.ohKernel, "attachOpenHouseSourceAttribution")
    check("OH-ATTRIB-ERR", "a refused attribution lifecycle write is reported, not swallowed",
      /eventErr/.test(attribution) && /success:\s*false/.test(guardedBlock(attribution, "eventErr")))

    const contact = functionBody(S.ohKernel, "resolveOrCreateOpenHouseContact")
    check("OH-DEDUP-READS", "contact dedup lookups destructure their errors",
      !hasBareDataDestructure(contact))
    check("OH-DEDUP-ABORT", "every refused dedup lookup returns instead of falling through to an insert",
      (contact.match(/if\s*\(\s*error\s*\)\s*\{\s*return/g) ?? []).length >= 2)
  }

  console.log("\n[open house · surface reachability]")
  {
    const imports = /import\s*\{([\s\S]*?)\}\s*from\s*"@\/app\/actions\/open-house-kernel"/.exec(S.ohSurface)
    const imported = imports ? imports[1] : ""
    for (const name of OH_ACTIONS) {
      check(`OH-SURFACE-${name}`, `${name} is imported and invoked by the open house surface`,
        imported.includes(name) && new RegExp(`${name}\\s*\\(`).test(S.ohSurface))
    }
    const add = functionBody(S.ohSurface, "handleAdd")
    check("OH-SURFACE-CHAIN", "walk-in handler runs contact → attendee → attribution in order",
      add.indexOf("resolveOrCreateOpenHouseContactAction") >= 0 &&
      add.indexOf("resolveOrCreateOpenHouseContactAction") < add.indexOf("createOpenHouseAttendeeFromContactAction") &&
      add.indexOf("createOpenHouseAttendeeFromContactAction") < add.indexOf("attachOpenHouseSourceAttributionAction"))
    check("OH-SURFACE-REFUSAL", "walk-in handler renders the server's refusal and stops",
      /!contactRes\.success/.test(add) && /setAddError\(\s*contactRes\.error/.test(add) &&
      /!attendeeRes\.success/.test(add) && /attendeeRes\.error/.test(add))
    check("OH-SURFACE-NO-OPTIMISM", "walk-in handler never reports success before the server answers",
      add.indexOf("sonnerToast.success") > add.indexOf("attendeeRes.error"))

    const followUp = functionBody(S.ohSurface, "handleQueueFollowUp")
    check("OH-SURFACE-FOLLOWUP", "per-attendee follow-up runs notify then draft",
      followUp.indexOf("notifyAssignedAgentForOpenHouseLeadAction") >= 0 &&
      followUp.indexOf("notifyAssignedAgentForOpenHouseLeadAction") < followUp.indexOf("generateOpenHouseFollowupNextActionAction"))
    check("OH-SURFACE-FOLLOWUP-REFUSAL", "a refused follow-up is shown as a refusal, not a success",
      /!notifyRes\.success/.test(followUp) && /ok:\s*false/.test(followUp) && /notifyRes\.error/.test(followUp))
    check("OH-SURFACE-IDSPACE", "follow-up is gated on a contacts.id, not an attendee id",
      /if\s*\(\s*!attendee\.contact_id\s*\)/.test(followUp))
    check("OH-SURFACE-REREAD", "a failed attendee re-read is not rendered as an empty event",
      /setLoadError\(\s*refresh\.error/.test(functionBody(S.ohSurface, "refreshAttendees")))
  }

  console.log("\n[open house · interest vocabulary]")
  {
    const levels = objectArrayValues(S.ohSurface, "INTEREST_LEVELS")
    const LIVE_INTEREST = ["hot", "warm", "cold", "no_interest"]
    check("OH-INTEREST-VOCAB", "the interest picker offers only storable values",
      levels.length === LIVE_INTEREST.length && levels.every((v) => LIVE_INTEREST.includes(v)))
    const styleKeys = [...(/INTEREST_STYLES[^=]*=\s*\{([\s\S]*?)\n\}/.exec(S.ohSurface)?.[1] ?? "")
      .matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1])
    check("OH-INTEREST-BADGES", "every storable interest value has a badge style",
      LIVE_INTEREST.every((v) => styleKeys.includes(v)))
  }

  console.log("\n[reputation · vocabularies]")
  {
    const canonical = new Set(REFERRAL_STATUSES.map((s) => s.value as string))
    const graph = /REFERRAL_STATUS_TRANSITIONS[^=]*=\s*\{([\s\S]*?)\n\}/.exec(S.repKernel)?.[1] ?? ""
    const graphVocab = statusGraphVocabulary(graph)
    const strays = [...graphVocab].filter((v) => !canonical.has(v))
    check("REP-REFERRAL-VOCAB", "referral transition graph speaks only the canonical status vocabulary",
      graphVocab.size > 0 && strays.length === 0)

    const advance = functionBody(S.repKernel, "advanceReferralStatus")
    check("REP-REFERRAL-TERMINAL", "the won-terminal status is taken from a named constant, not inlined",
      /REFERRAL_TERMINAL_WON/.test(advance) && !/"converted"/.test(advance))

    const platforms = arrayLiteralValues(S.repKernel, "REVIEW_PLATFORMS")
    const pickerPlatforms = objectArrayValues(S.reputationSurface, "REVIEW_PLATFORMS")
    check("REP-PLATFORM-AGREE", "the review-request picker offers only platforms the kernel accepts",
      pickerPlatforms.length > 0 && pickerPlatforms.every((p) => platforms.includes(p)))
    const filterPlatforms = objectArrayValues(S.reputationSurface, "REVIEW_FILTER_PLATFORMS")
      .filter((p) => p !== "all")
    check("REP-FILTER-AGREE", "the review filters query only platforms the kernel accepts",
      filterPlatforms.length > 0 && filterPlatforms.every((p) => platforms.includes(p)))
  }

  console.log("\n[reputation · kernel reads and writes]")
  {
    const respond = functionBody(S.repKernel, "respondToReview")
    const publishAssignments = [...respond.matchAll(/is_published\s*[:=]\s*([^\n,}]+)/g)].map((m) => m[1].trim())
    check("REP-NO-UNPUBLISH", "responding to a review can only raise is_published, never lower it",
      publishAssignments.length > 0 && publishAssignments.every((v) => v === "true"))
    check("REP-OWNERSHIP-ERR", "a refused ownership read is not reported as 'not your review'",
      !hasBareDataDestructure(respond) && /ownershipErr/.test(respond))

    const workspace = functionBody(S.repKernel, "loadReputationWorkspace")
    check("REP-WORKSPACE-ERR", "a refused workspace read is distinguishable from an empty workspace",
      /reviewsRes\.error/.test(workspace) && /requestsRes\.error/.test(workspace) &&
      /referralsRes\.error/.test(workspace) && /success:\s*false/.test(workspace))

    const createReq = functionBody(S.repKernel, "createReviewRequest")
    check("REP-DUP-GUARD", "a refused duplicate check blocks the insert instead of waving it through",
      !hasBareDataDestructure(createReq) && /dupErr/.test(createReq))

    const emit = functionBody(S.repKernel, "emitLifecycleEvent")
    check("REP-EVENT-ERR", "a refused lifecycle insert is surfaced, not silently skipped",
      !hasBareDataDestructure(emit) && /emitted:\s*false/.test(emit))

    const actor = functionBody(S.repAction, "resolveActor")
    check("REP-ACTOR-ERR", "a refused agents lookup is not reported as 'not authenticated'",
      !hasBareDataDestructure(actor) && /profileErr/.test(actor))
    check("REP-ACTOR-IDSPACE", "the actor resolver reads agents.id by user_id rather than reusing users.id",
      /from\(\s*"agents"\s*\)/.test(actor) && /eq\(\s*"user_id"/.test(actor) &&
      !/agentId:\s*user\.id/.test(actor))
  }

  console.log("\n[reputation · surface reachability]")
  {
    check("REP-RESPOND-IMPORT", "respondToReviewAction is imported by the reviews surface",
      /import\s*\{[^}]*respondToReviewAction[^}]*\}\s*from\s*"@\/app\/actions\/reputation-kernel"/.test(S.reviewSurface))
    const save = functionBody(S.reviewSurface, "handleSaveResponse")
    check("REP-RESPOND-CALL", "the reviews surface invokes it with the review id and publish intent",
      /respondToReviewAction\s*\(\s*\{[^}]*reviewId[^}]*publishNow/.test(save))
    check("REP-RESPOND-REFUSAL", "a refused publish is shown as the server's message",
      /result\.success/.test(save) && /setResponseError\(\s*\(\s*result/.test(save) &&
      !/catch\s*\(\s*\(\s*\)\s*=>\s*null\s*\)/.test(save))
    check("REP-RESPOND-CONTROL", "the drafted response is editable and has a publish control",
      /<Textarea[\s\S]{0,240}value=\{responseText\}/.test(S.reviewSurface) &&
      /handleSaveResponse\(review\.id,\s*true\)/.test(S.reviewSurface))

    check("REP-PERF-IMPORT", "loadReviewPerformanceAction is imported by the reputation surface",
      /import\s*\{[^}]*loadReviewPerformanceAction[^}]*\}\s*from\s*"@\/app\/actions\/reputation-kernel"/.test(S.reputationSurface))
    const perfEffect = enclosingBlockOf(S.reputationSurface, "loadReviewPerformanceAction()")
    check("REP-PERF-REFUSAL", "an unreadable performance strip is not rendered as a spotless one",
      /setPerformanceError\(/.test(perfEffect) && /setPerformance\(\s*null\s*\)/.test(perfEffect))
    check("REP-PERF-RENDER", "the performance refusal reaches the screen",
      /performanceError\s*\?/.test(S.reputationSurface))

    const logRequest = enclosingBlockOf(S.reputationSurface, "createReviewRequestAction({")
    check("REP-REQUEST-VERDICT", "the review-request control reports the server's verdict",
      /result\?\.success/.test(logRequest) && /toast\.error/.test(logRequest))
    check("REP-REQUEST-NO-SWALLOW", "the review-request control no longer discards the result",
      !/createReviewRequestAction\([\s\S]{0,400}?\.catch\(\s*\(\s*\)\s*=>\s*null\s*\)/.test(S.reputationSurface))

    const loadReviews = functionBody(S.lifetimeSurface, "loadReviews")
    check("REP-WORKSPACE-SURFACE", "a refused reputation workspace read is surfaced on the page",
      /!result\.success/.test(loadReviews) && /setReviewsLoadError\(\s*\(\s*result/.test(loadReviews) &&
      /reviewsLoadError\s*&&/.test(S.lifetimeSurface))
  }

  console.log("\n[deliberately unwired · second-writer guard]")
  {
    const surfaces = [S.ohSurface, S.reviewSurface, S.reputationSurface, S.lifetimeSurface].join("\n")
    check("UNWIRED-RECORD-REVIEW", "recordReviewAction is NOT wired — agent_reviews already has writers",
      !/\brecordReviewAction\b/.test(surfaces))
    check("UNWIRED-RECORD-REVIEW-WRITER", "the existing agent_reviews writers are still present",
      /submitClientFeedback/.test(S.reviewWriterA) &&
      /from\(\s*"agent_reviews"\s*\)\s*\n?\s*\.insert/.test(S.reviewWriterA) &&
      /from\(\s*"agent_reviews"\s*\)\.insert/.test(S.reviewWriterB))
    check("UNWIRED-REFERRAL-CREATE", "createReferralRequestAction is NOT wired — referrals already has a writer",
      !/\bcreateReferralRequestAction\b/.test(surfaces))
    check("UNWIRED-REFERRAL-ADVANCE", "advanceReferralStatusAction is NOT wired — referrals.status already has a writer",
      !/\badvanceReferralStatusAction\b/.test(surfaces))
    check("UNWIRED-REFERRAL-WRITER", "the existing referrals writers are still present and more complete",
      /export\s+async\s+function\s+createReferral\s*\(/.test(S.referralWriter) &&
      /export\s+async\s+function\s+updateReferralStatus\s*\(/.test(S.referralWriter) &&
      /captureContact\s*\(/.test(functionBody(S.referralWriter, "createReferral")) &&
      /isReferralStatus\s*\(/.test(functionBody(S.referralWriter, "updateReferralStatus")))
    check("UNWIRED-NOT-DELETED", "none of the unwired capabilities were deleted",
      /export\s+async\s+function\s+recordReviewAction\b/.test(S.repAction) &&
      /export\s+async\s+function\s+createReferralRequestAction\b/.test(S.repAction) &&
      /export\s+async\s+function\s+advanceReferralStatusAction\b/.test(S.repAction))
  }

  console.log("\n[TCPA · the capability moved before the duplicate was removed]")
  {
    const insertPayload = functionBody(S.ohKernel, "createOpenHouseAttendeeFromContact")

    // The CONSTRUCT, not the spelling: the phone that reaches the insert must be
    // guarded by the consent flag. A payload that writes phone unconditionally
    // fails even if the word "tcpa" appears elsewhere in the function.
    check("TCPA-KERNEL-GATE", "the kernel drops the phone number when consent was not given",
      /phone:\s*tcpa_consent\s*&&/.test(insertPayload))
    check("TCPA-KERNEL-PERSISTS", "the kernel records the consent decision itself",
      /\btcpa_consent,/.test(insertPayload))
    check("TCPA-KERNEL-DEFAULT-DENY", "consent defaults to withheld, never to granted",
      /tcpa_consent\s*=\s*false/.test(insertPayload))

    // The action layer must carry it through; a dropped field silently
    // re-defaults to false at the kernel and the checkbox becomes decorative.
    const actionBody = functionBody(S.ohAction, "createOpenHouseAttendeeFromContactAction")
    check("TCPA-ACTION-THREADED", "the action forwards consent rather than dropping it",
      /tcpa_consent:\s*input\.tcpa_consent/.test(actionBody))

    // The surface must actually collect it and send what it collected.
    const addHandler = functionBody(S.ohSurface, "handleAdd")
    check("TCPA-SURFACE-COLLECTS", "the walk-in form has a consent control bound to state",
      /tcpaConsent:\s*e\.target\.checked/.test(S.ohSurface))
    check("TCPA-SURFACE-SENDS", "the check-in sends the consent the user actually gave",
      /tcpa_consent:\s*addForm\.tcpaConsent/.test(addHandler))

    // The duplicate is gone, and the homes that replaced it are real.
    check("TCPA-LEGACY-RETIRED", "recordAttendee is removed, not merely unreferenced",
      !/export\s+async\s+function\s+recordAttendee\b/.test(S.ohLegacy))
    // Sliced, not grepped: the contact_id must be in the ATTENDEE insert payload
    // (the route also writes contacts and lifecycle_events, and a match in
    // either of those would prove nothing about the attendee row), and the
    // consent check must be a REFUSAL, not merely a mention of the token.
    const kioskAttendeeInsert = (() => {
      const i = S.ohKiosk.indexOf('.from("open_house_attendees")')
      return i === -1 ? "" : S.ohKiosk.slice(i, i + 400)
    })()
    check("TCPA-KIOSK-HOME-EXISTS", "the public kiosk home supplies contact_id on the attendee row itself",
      /contact_id:/.test(kioskAttendeeInsert))
    check("TCPA-KIOSK-REFUSES", "the public kiosk REFUSES a check-in with no consent, it does not just note it",
      /if\s*\(\s*!\s*tcpaConsent\s*\)[\s\S]{0,200}?\b400\b/.test(S.ohKiosk))
    check("TCPA-AGENT-HOME-EXISTS", "the authenticated home still exists and supplies contact_id",
      /export\s+async\s+function\s+createOpenHouseAttendeeFromContact\b/.test(S.ohKernel) &&
      /contact_id,/.test(insertPayload))
  }

  console.log("\n[compliance · no new egress]")
  {
    const notify = functionBody(S.ohKernel, "notifyAssignedAgentForOpenHouseLead")
    const followup = functionBody(S.ohKernel, "generateOpenHouseFollowupNextAction")
    const EGRESS = /dispatchSms|dispatchEmail|dispatchDirectMail|sendSms|sendEmail|email_queue|twilio|resend/i
    check("CMP-NO-DIRECT-SEND", "the newly wired open house commands queue internally and send nothing",
      !EGRESS.test(notify) && !EGRESS.test(followup))
    const followUpHandler = functionBody(S.ohSurface, "handleQueueFollowUp")
    check("CMP-SURFACE-NO-SEND", "the follow-up control opens no direct send path",
      !EGRESS.test(followUpHandler))
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// LIVE LAYER — creds-gated, self-cleaning, skips loudly
// ═════════════════════════════════════════════════════════════════════════════

async function liveLayer(): Promise<"ran" | "skipped"> {
  const hasCreds =
    !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[live layer] ⏭  SKIPPED LOUDLY — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.")
    console.log("             The static layer above proves the WIRING; the live layer proves the")
    console.log("             SCHEMA agrees. A skipped live layer is NOT a passing live layer.")
    return "skipped"
  }

  let svc: any
  try {
    const mod = await import("../lib/supabase/service")
    svc = mod.createServiceClient()
    const { error } = await svc.from("brokerages").select("id").limit(1)
    if (error) throw new Error(error.message)
  } catch (e) {
    console.log(`\n[live layer] ⏭  SKIPPED LOUDLY — database unreachable: ${(e as Error).message}`)
    console.log("             A network or auth error is NOT scored as a pass.")
    return "skipped"
  }

  const tag = `OHREP-${Date.now()}`
  const brokerageId = randomUUID()
  const otherBrokerageId = randomUUID()
  const userId = randomUUID()
  const agentId = randomUUID()
  const listingId = randomUUID()
  const eventId = randomUUID()
  const cleanup: Array<() => PromiseLike<unknown>> = []

  console.log(`\n[live layer] tag=${tag}`)
  try {
    await svc.from("brokerages").insert([
      { id: brokerageId, name: `${tag} Brokerage` },
      { id: otherBrokerageId, name: `${tag} Other Brokerage` },
    ])
    cleanup.push(() => svc.from("brokerages").delete().in("id", [brokerageId, otherBrokerageId]))

    await svc.from("users").insert({
      id: userId, brokerage_id: brokerageId, email: `oh+${tag}@demo.invalid`,
      first_name: "Sim", last_name: "Agent", user_type: "agent",
    })
    cleanup.push(() => svc.from("users").delete().eq("id", userId))

    await svc.from("agents").insert({ id: agentId, user_id: userId, brokerage_id: brokerageId })
    cleanup.push(() => svc.from("agents").delete().eq("id", agentId))

    await svc.from("listings").insert({
      id: listingId, brokerage_id: brokerageId, agent_id: agentId, address: `${tag} 1 Sim Way`,
    })
    cleanup.push(() => svc.from("listings").delete().eq("id", listingId))

    await svc.from("open_house_events").insert({
      id: eventId, listing_id: listingId, brokerage_id: brokerageId, agent_id: agentId,
      event_date: new Date().toISOString(), status: "active",
    })
    cleanup.push(() => svc.from("open_house_events").delete().eq("id", eventId))

    // L1 — the OLD walk-in insert shape must be REFUSED.
    {
      const { error } = await svc.from("open_house_attendees").insert({
        event_id: eventId, name: `${tag} Walkin`, email: `walkin+${tag}@demo.invalid`,
        check_in_time: new Date().toISOString(),
      })
      check("LIVE-CONTACT-REQUIRED",
        "an attendee insert with no contact_id is refused by the live schema",
        !!error)
    }

    // L2 — the real kernel chain lands, tenanted, in the agents id space.
    let kernel: typeof import("../lib/kernel/open-house") | null = null
    try { kernel = await import("../lib/kernel/open-house") } catch { kernel = null }
    check("LIVE-KERNEL-IMPORT", "the open house kernel module loads outside Next", kernel !== null)

    if (kernel) {
      const contactRes = await kernel.resolveOrCreateOpenHouseContact({
        brokerage_id: brokerageId, agent_id: agentId,
        first_name: tag, last_name: "Walkin", email: `walkin+${tag}@demo.invalid`,
        open_house_id: eventId,
      })
      check("LIVE-CONTACT-CREATED", "the kernel resolves a contact for a walk-in",
        contactRes.success && !!contactRes.contact_id)
      if (contactRes.contact_id) {
        cleanup.push(() => svc.from("contacts").delete().eq("id", contactRes.contact_id as string))
      }

      const attendeeRes = contactRes.contact_id
        ? await kernel.createOpenHouseAttendeeFromContact({
            open_house_id: eventId, contact_id: contactRes.contact_id,
            brokerage_id: brokerageId, first_name: tag, last_name: "Walkin",
            email: `walkin+${tag}@demo.invalid`, interest_level: 5,
          })
        : { success: false, attendee_id: null as string | null }
      check("LIVE-ATTENDEE-CREATED", "the kernel records the attendee against that contact",
        attendeeRes.success && !!attendeeRes.attendee_id)

      if (attendeeRes.attendee_id) {
        const { data: row } = await svc.from("open_house_attendees")
          .select("brokerage_id, interest_level, contact_id").eq("id", attendeeRes.attendee_id).maybeSingle()
        check("LIVE-ATTENDEE-TENANTED",
          "the attendee row is stamped with a brokerage (an untenanted row is readable by every tenant)",
          row?.brokerage_id === brokerageId)
        check("LIVE-ATTENDEE-INTEREST", "the numeric interest level maps to a storable enum value",
          row?.interest_level === "hot")

        const notifyRes = await kernel.notifyAssignedAgentForOpenHouseLead({
          contact_id: contactRes.contact_id as string, attendee_id: attendeeRes.attendee_id,
          agent_id: agentId, brokerage_id: brokerageId, open_house_id: eventId,
          first_name: tag, interest_level: 5,
        })
        check("LIVE-NOTIFY", "the assigned agent's next-action row lands with an agents-class id",
          notifyRes.success)

        const followRes = await kernel.generateOpenHouseFollowupNextAction({
          contact_id: contactRes.contact_id as string, attendee_id: attendeeRes.attendee_id,
          open_house_id: eventId, property_id: listingId, first_name: tag,
          interest_level: 5, agent_id: agentId, brokerage_id: brokerageId,
        })
        check("LIVE-FOLLOWUP", "the follow-up next-action row lands", followRes.success)

        const { data: actions } = await svc.from("ai_autopilot_actions")
          .select("id, brokerage_id, agent_id").eq("agent_id", agentId)
        cleanup.push(() => svc.from("ai_autopilot_actions").delete().eq("agent_id", agentId))
        check("LIVE-AUTOPILOT-TENANTED", "every queued next-action carries the brokerage stamp",
          (actions ?? []).length >= 2 && (actions ?? []).every((a: any) => a.brokerage_id === brokerageId))

        const attribRes = await kernel.attachOpenHouseSourceAttribution({
          contact_id: contactRes.contact_id as string, open_house_id: eventId,
          attendee_id: attendeeRes.attendee_id, brokerage_id: brokerageId, agent_id: agentId,
        })
        check("LIVE-ATTRIBUTION", "the attribution lifecycle event lands", attribRes.success)
        cleanup.push(() => svc.from("lifecycle_events").delete().eq("brokerage_id", brokerageId))
      }
    }

    // L3 — every referral status the transition graph can emit must be storable.
    {
      const graph = /REFERRAL_STATUS_TRANSITIONS[^=]*=\s*\{([\s\S]*?)\n\}/.exec(S.repKernel)?.[1] ?? ""
      const vocab = [...statusGraphVocabulary(graph)]
      const referralId = randomUUID()
      await svc.from("referrals").insert({
        id: referralId, brokerage_id: brokerageId, agent_id: agentId,
        referral_name: `${tag} Referral`, status: "received",
      })
      cleanup.push(() => svc.from("referrals").delete().eq("id", referralId))
      const refused: string[] = []
      for (const status of vocab) {
        const { error } = await svc.from("referrals").update({ status }).eq("id", referralId)
        if (error) refused.push(status)
      }
      check("LIVE-REFERRAL-VOCAB",
        `every status the transition graph can emit is storable (refused: ${refused.join(", ") || "none"})`,
        vocab.length > 0 && refused.length === 0)
    }

    // L4 — every review platform the kernel types as valid must be storable.
    {
      const platforms = arrayLiteralValues(S.repKernel, "REVIEW_PLATFORMS")
      const refused: string[] = []
      const ids: string[] = []
      for (const platform of platforms) {
        const id = randomUUID()
        const { error } = await svc.from("agent_reviews").insert({
          id, brokerage_id: brokerageId, agent_id: agentId, rating: 5,
          review_text: `${tag} probe`, platform, is_published: true,
        })
        if (error) refused.push(platform)
        else ids.push(id)
      }
      if (ids.length) cleanup.push(() => svc.from("agent_reviews").delete().in("id", ids))
      check("LIVE-PLATFORM-VOCAB",
        `every review platform the kernel accepts is storable (refused: ${refused.join(", ") || "none"})`,
        platforms.length > 0 && refused.length === 0)

      // L5 — responding without publishNow must not retract a published review.
      if (ids.length) {
        let reputation: typeof import("../lib/kernel/reputation") | null = null
        try { reputation = await import("../lib/kernel/reputation") } catch { reputation = null }
        if (reputation) {
          const res = await reputation.respondToReview({
            agentId, brokerageId, reviewId: ids[0], responseText: `${tag} thank you`,
          })
          const { data: after } = await svc.from("agent_reviews")
            .select("is_published, response_text").eq("id", ids[0]).maybeSingle()
          check("LIVE-NO-UNPUBLISH",
            "responding without publishNow leaves a published review published",
            res.success && after?.is_published === true && !!after?.response_text)
        } else {
          check("LIVE-NO-UNPUBLISH", "reputation kernel module loads outside Next", false)
        }
      }
    }
  } finally {
    for (const undo of cleanup.reverse()) { try { await undo() } catch { /* keep unwinding */ } }
  }

  // RE-COUNT — residue must be exactly zero.
  const residue: Record<string, number> = {}
  for (const table of [
    "open_house_attendees", "open_house_events", "referrals", "agent_reviews",
    "ai_autopilot_actions", "lifecycle_events", "contacts", "listings", "agents", "users", "brokerages",
  ]) {
    const { count } = await svc.from(table).select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
    residue[table] = count ?? 0
  }
  const total = Object.values(residue).reduce((a, b) => a + b, 0)
  check("LIVE-ZERO-RESIDUE",
    `every seeded row was removed (${JSON.stringify(residue)})`, total === 0)

  return "ran"
}

// ═════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log("OPEN HOUSE + REPUTATION WIRING SIMULATOR")
  staticLayer()
  const live = await liveLayer()

  console.log(`\nRESULT: ${pass} passed, ${failures.length} failed (live layer: ${live})`)
  if (failures.length > 0) {
    console.log(`FAILED CHECKS: ${failures.join(", ")}`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error("SIMULATOR CRASHED:", e)
  process.exit(1)
})
