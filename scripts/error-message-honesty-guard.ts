/**
 * scripts/error-message-honesty-guard.ts
 *
 * test:error-message-honesty — AN ERROR MUST NAME ITS OWN CAUSE.
 *
 * THE DEFECT. A guard tests one thing and blames another:
 *
 *     if (!agentRecordId) return { error: "Voice clone not set up." }
 *
 * The condition asks whether the user has an AGENT PROFILE. The message tells
 * them their VOICE CLONE is missing. Both can be false at once, so the sentence
 * is not a lie exactly — it is worse than a lie, because it is plausible. The
 * person debugging it goes and looks at the voice clone, finds it present and
 * correct, and concludes the system is flaky.
 *
 * THIS IS THE MOST EXPENSIVE PATTERN IN THIS CODEBASE PER INSTANCE. The identity
 * split cost more in total, but a wrong id at least fails at a foreign key that
 * names the constraint. A misdirecting error message actively sends the reader
 * somewhere else, and it does it every single time the path runs. Real examples
 * found by audit in this sweep, each of which had a DIFFERENT true cause:
 *
 *   · "agent has no elevenlabs_voice_id"   — the clone existed; the lookup used
 *                                             the wrong id class
 *   · "Voice clone not set up"              — it was set up; an agents id had been
 *                                             fed to a users→agents resolver
 *   · "No contacts match the criteria"      — the segment filter matched nothing
 *                                             because the id class was wrong
 *   · "Forbidden"                           — a users id failed an agents-scoped
 *                                             ownership check
 *
 * A FIFTH CASE WAS CONSIDERED AND REJECTED, which is worth recording because the
 * temptation to include it was strong. "Invalid social account ID" came from
 * `!isValidUUID(socialAccountId)` where the caller passed "". The message is
 * HONEST — the value really was not a valid UUID. The defect was one layer up:
 * a guard that should have been unreachable became the entire user experience.
 * That is the placeholder-argument pattern, not this one. Bending the detector
 * to claim it would have been the very error this file exists to catch.
 *
 * In every one of those, the UI was right and the schema was right, and only the
 * sentence in between was pointing the wrong way.
 *
 * HOW THIS DETECTS IT, AND WHY IT IS A RATCHET AND NOT AN INVARIANT. For every
 * `if (!X) ... "message"`, it compares the words in X against the words in the
 * message, after expanding a synonym table for the honest-but-differently-worded
 * pairs (`!res.ok` → "Failed to fetch" is fine; `!user` → "Not authenticated" is
 * fine). Zero overlap is a CANDIDATE, not a defect: a message can legitimately
 * describe a consequence rather than a condition, and English has more ways to
 * be honest than a word-overlap test can model.
 *
 * So the number is a review queue. It may only go down. Every previous detector
 * in this repo that was promoted to a zero-baseline invariant on the strength of
 * its own examples turned out to be measuring its own vocabulary — twice — and
 * this one is no better founded than those were.
 *
 * §2 and §3 exist for that reason: they prove the detector fires on every real
 * shape above AND stays quiet on eleven honest forms it must not flag. A
 * detector only ever tested against the examples it was written from always
 * passes — this repo has been burned by that twice.
 *
 * THE QUEUE HAS BEEN READ END TO END. All 78 were opened and triaged one by one.
 * TWO were defects and are fixed, and both were the same shape — a null check on
 * a FIELD wearing a message about the ROW:
 *
 *   portal-lifetime.ts   !contact?.agent_id  → "Contact not found"
 *   multi-persona.ts     !loanRow?.transaction_id → "Loan record not found"
 *
 * In both, the record was sitting right there; only its link was missing. The
 * `?.` is what fuses the two causes: it lets one `if` stand for "no row" and
 * "row without the link", and only the first gets a sentence. Each is now split
 * into two checks with two messages, which is the general repair for this shape.
 *
 * THE OTHER 76 ARE HONEST, and that is a finding rather than a to-do. They are
 * consequence-descriptions ("Negotiation analysis failed" for `!strategy.data`),
 * checks whose message already names both causes ("Contact not found or access
 * denied"), or generic wrapper names the word-overlap test cannot see through
 * (`!auth.ok` guarding a message about the agent profile — correct code). Two
 * that read like the fixed pair were traced and are NOT: video-generation.ts
 * proves `!parent` is really an absent row, and kernel/video.ts's "already in
 * progress" is preceded, twenty lines up, by the existence check that rules the
 * other cause out.
 *
 * SO DO NOT GRIND THIS NUMBER DOWN BY REWRITING SENTENCES. The queue was
 * saturated at 76 as a REVIEW list, and further reduction by editing prose means
 * bending honest sentences to satisfy a word-overlap heuristic — the exact
 * inversion this file warns about above. Its remaining job is the ratchet: it
 * fails when a NEW misdirecting message appears.
 *
 * There is one other legitimate way down, and it is the opposite of bending:
 * making the INSTRUMENT read what the code actually says. That is what took it
 * 81 → 76 (the interpolated-reason rule) and 76 → 72 (a delimiter-aware message
 * extractor, closing the truncation blind spot this header had recorded but
 * worked around). Both fixed the guard, neither touched a sentence. The current
 * figure and its full derivation are at BASELINE below.
 *
 * 76 → 79, AND THE THREE ARE NAMED, because a ratchet raised without a reason is
 * just a disabled guard. All three are on the PUBLIC website chat widget, where
 * the visitor is not the operator and vagueness is the correct register — the
 * honest repair the heuristic wants ("session token missing") would be worse
 * copy AND would narrate an internal credential to an anonymous stranger:
 *
 *   app/widget/[brokerageSlug]/widget-chat-client.tsx:77   !cancelled
 *     NOT A CONDITION AT ALL — a heuristic false positive. `cancelled` is the
 *     React effect-cleanup flag; the cause is the `.catch()` this line sits in,
 *     and the message describes THAT. The scanner sees the nearest `if`.
 *   app/widget/[brokerageSlug]/widget-chat-client.tsx:131  !sessionToken
 *   app/widget/chat/widget-chat-client.tsx:87              !brokerageSlug
 *     Both are true at the visitor's level: chat really is unavailable to them.
 *     Naming the token or the slug tells a stranger about our session model.
 *
 * 79 → 80, AND THE ONE IS NAMED:
 *
 *   lib/transactions/offer-bridge.ts:351  !creationGate.allowed
 *     → "[offer-bridge] Gate refused transaction creation: ${creationGate.reason}"
 *     The SECOND of the two transaction-creation chokepoints. Its twin at :193
 *     is identical in shape and has been inside the baseline since it was
 *     written; this line is new only because the owner's ruling ("a transaction
 *     is only created after compliance is good, all documents present with full
 *     signatures and initials") required gating a SECOND creation path, and the
 *     honest thing was to refuse there in the same words.
 *
 *     The heuristic reads the condition's subject as `allowed` and finds no
 *     overlap with the message's nouns. But the message does not merely name the
 *     right cause — it INTERPOLATES it: `creationGate.reason` carries which of
 *     the four obligations failed and which documents are missing, unsigned or
 *     un-initialled. A message that hands the reader the specific failing
 *     requirement is the opposite of the defect this guard exists to catch, and
 *     the only way to satisfy the word-overlap test would be to say "not
 *     allowed" — strictly less informative. That is the bending this file's own
 *     header forbids, so the ratchet moves instead of the sentence.
 *
 *     SECOND INSTANCE OF THE SAME SHAPE, 80 → 81, ALSO NAMED:
 *
 *   lib/ads/audience-persona-basis.ts:274  !res.ok
 *     → `[audience-persona-basis] REFUSED: audience "${audienceLabel}" ${res.refusal}`
 *     The owner ruled "audience should be segmented on persona", and this is the
 *     positive half of that gate — it requires what an audience MUST be, beside
 *     assertAudienceSegmentationAllowed which refuses what it may not be.
 *
 *     Identical reasoning to offer-bridge:351 above, and recorded separately
 *     rather than folded into it because a ratchet entry that stands for "and
 *     others like it" is how a baseline stops being readable. The condition's
 *     subject is `ok`; the message interpolates `res.refusal`, which names the
 *     offending PERSONA and why it is ads-ineligible, plus the audience label so
 *     an operator knows which one to fix. Satisfying the word-overlap test would
 *     mean writing "not ok" — strictly less informative than the sentence that
 *     is there.
 *
 *     THE PATTERN IS NOW WORTH NAMING, since it has produced two of the last two
 *     raises: a refusal that CARRIES ITS REASON as an interpolated value will
 *     always look misdirecting to a word-overlap heuristic, because the words
 *     that make it honest are not in the source at all — they arrive at runtime.
 *     That is the opposite of the defect this guard exists to catch, and it is
 *     the shape this codebase should be producing MORE of. If a third arrives,
 *     the right response is to teach the detector about interpolated reason
 *     values, not to keep raising the number.
 *
 *     ACCOUNTING, because a raise with a wrong story is worse than no story:
 *     the count went 79 → 80, not 79 → 81, because :193 was already counted.
 *     Verified against HEAD rather than inferred — an earlier reading of mine
 *     guessed that a deleted export had removed some other flagged site, and it
 *     had not.
 *
 * Same standard as the 76 above: consequence-descriptions on a surface whose
 * reader cannot act on the cause. If a FOURTH appears, judge it the same way —
 * do not assume this note licenses the next increment.
 */
import { readFileSync } from "node:fs"
import { walkTs, rootRuntimeFiles } from "./runtime-roots"

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
 * `if (!X) ... "message"` — the guard and the sentence it blames.
 *
 * THE BODY IS DELIMITER-AWARE, AND THAT IS THE WHOLE POINT (CLAUDE.md §2).
 * This pattern used to spell the message body `[^"'\`]{6,120}` — one class
 * forbidding ALL THREE quote characters no matter which one opened the string.
 * A template literal is the normal way to write a refusal that carries its
 * reason, and quoting a value inside one is the normal way to make it readable:
 *
 *     throw new Error(`A referral cannot move from "${previousStatus}" to "${status}". …`)
 *
 * The capture stopped dead at that inner `"`, so the guard judged the fragment
 * `A referral cannot move from` — and then reported the message as blaming a
 * different noun, because every word that made it honest sat past the cut. Two
 * of the three "new" findings on 2026-09-04 were this, not new misdirection:
 * one message was truncated at its first quoted interpolation, the other
 * (`${verdict.reason ?? "…"}`) was cut to `${verdict.reason ??` — which also
 * hid it from honestByInterpolatedReason, the rule written for exactly that
 * shape. A guard that cannot see the sentence it judges accuses the sentence.
 *
 * So the opening delimiter now decides what may appear inside it: only a
 * backtick closes a template, only `"` closes a double-quoted string. The
 * ceiling moves 120 → 200 for the same reason — a message longer than the
 * ceiling did not merely truncate, it failed to match at all and dropped the
 * guard out of the corpus silently, which is the blind spot, not a pass.
 */
const GUARD_RE = new RegExp(
  String.raw`if\s*\(\s*!([A-Za-z_$][\w.$?]*)\s*\)\s*\{?[^{}]{0,200}?` +
  String.raw`(?:error:\s*|Error\(\s*|message:\s*)` +
  String.raw`(?:\`([^\`]{6,200})\`|"([^"]{6,200})"|'([^']{6,200})')`,
  "gs",
)

/**
 * THE SUBJECT OF A GUARD IS ITS LAST PROPERTY ACCESS, not the object it was
 * reached through. `userContext?.agentId` tests an AGENT PROFILE; it is not an
 * auth check merely because "user" appears in the path. Taking the whole path
 * let `userContext?.agentId` → "You must be logged in" read as honest, because
 * the "user" prefix matched the auth synonym. The trailing segment is what the
 * condition is actually about.
 */
const GENERIC_ACCESSOR = new Set(["id", "ok", "data", "length", "success", "value", "result", "rows", "error"])
function subjectOf(ident: string): string {
  const segs = ident.split(/[?.]+/).filter(Boolean)
  const last = segs[segs.length - 1] ?? ident
  // A generic accessor is not a subject. `selected?.contact?.id` is about the
  // CONTACT, and `res.ok` is about the RESPONSE — taking only the tail made both
  // read as mismatches against perfectly honest messages.
  if (GENERIC_ACCESSOR.has(last.toLowerCase()) && segs.length > 1) {
    return `${segs[segs.length - 2]} ${last}`
  }
  return last
}

/** Split an identifier into lowercase words: `agentId` → agent, id */
function tokens(ident: string): Set<string> {
  return new Set(
    subjectOf(ident)
      .replace(/[?.]/g, " ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/_/g, " ")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean),
  )
}

const STOP = new Set([
  "the", "a", "an", "is", "are", "was", "be", "been", "to", "for", "of", "in", "on", "at", "and",
  "or", "not", "no", "this", "that", "it", "you", "your", "we", "us", "please", "try", "again",
  "can", "cannot", "could", "must", "have", "has", "with", "from", "yet", "any", "found", "before",
  "there", "then", "into", "out", "up", "do", "does", "did", "will", "would", "should", "may",
])
function words(msg: string): Set<string> {
  return new Set(
    msg
      .replace(/\$\{[^}]*\}/g, " ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      // Split on underscores too. Without this, a message naming a real column
      // ("agent has no elevenlabs_voice_id") kept the column as ONE token, so a
      // guard on `voiceId` looked like a mismatch when it was perfectly honest.
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  )
}

/**
 * HONEST PAIRS THAT SHARE NO WORDS. These are not evasions — they are the normal
 * way English names a consequence. Without them the detector flags ~200 correct
 * guards and teaches everyone to ignore it, which is the failure mode that makes
 * a guard worse than no guard.
 */
const SYNONYMS: Array<[RegExp, RegExp]> = [
  [/\b(ok|res|resp|response|r)\b/, /\b(fetch|load|loaded|request|failed|http|network|search|status|fail)\b/],
  [/\b(user|session|auth|authed|userdata|claims|token)\b/, /\b(authenticated|authentication|logged|login|signed|sign|unauthorized|unauthenticated)\b/],
  [/\b(ctx|context|provider)\b/, /\b(provider|within|context|shell)\b/],
  [/\b(cancelled|canceled|aborted|mounted)\b/, /\b(load|loaded|settings|fields|cancel)\b/],
  [/\b(brokerage|tenant|org)\b/, /\b(brokerage|tenant|organisation|organization|workspace|account)\b/],
  [/\b(key|keys|apikey|credential|credentials|secret)\b/, /\b(credential|credentials|configured|configure|key|api|connect|connected)\b/],
  [/\b(data|rows|row|result|results|records)\b/, /\b(data|record|records|result|results|empty|none|nothing)\b/],
  // NOTE the absence of a blanket `id|uuid` ↔ `invalid|missing` rule. It made
  // "Invalid social account ID" read as honest for ANY id-ish condition, which
  // is too generous — most misdirecting messages mention an id somewhere.
  [/\b(isvalid|valid|shape|format|parse)\b/, /\b(invalid|malformed|format|parse)\b/],
]

function honestBySynonym(cond: Set<string>, msg: Set<string>): boolean {
  const c = [...cond].join(" ")
  const m = [...msg].join(" ")
  return SYNONYMS.some(([cr, mr]) => cr.test(c) && mr.test(m))
}

/**
 * THE PRIMARY CLAIM ONLY — the first clause, before the first `.`, `—`, `;` or
 * newline. This matters more than it looks. "Voice clone not set up. The agent
 * must complete Settings → Voice & Avatar" mentions "agent" in its SECOND
 * sentence, which was enough to make an earlier version of this check call it
 * honest. It is not: the sentence the reader acts on is the first one, and that
 * one accuses the voice clone. A message may add context after its claim; it may
 * not launder a wrong claim by mentioning the right noun later.
 */
function primaryClaim(message: string): string {
  return message.split(/[.;\n]|\s—\s/)[0] ?? message
}

/**
 * A REFUSAL THAT CARRIES ITS OWN REASON, INTERPOLATED FROM THE TESTED SUBJECT.
 *
 * This file's header predicted this and said what to do about it: "a refusal
 * that CARRIES ITS REASON as an interpolated value will always look misdirecting
 * to a word-overlap heuristic, because the words that make it honest are not in
 * the source at all — they arrive at runtime… If a third arrives, the right
 * response is to TEACH THE DETECTOR about interpolated reason values, not to
 * keep raising the number." A third and fourth arrived on 2026-09-04, so this is
 * that teaching rather than another raise.
 *
 * THE RULE, and it is deliberately narrow: the message interpolates an
 * expression rooted at the SAME object the condition tested. `!res.ok` whose
 * message carries `${res.status}` and `${res.error}` is not blaming a different
 * noun — it is handing the reader the tested subject's own account of the
 * failure, which is strictly MORE informative than any sentence that would
 * satisfy word overlap ("not ok").
 *
 * WHAT IT WILL NOT ADMIT, so this does not become a loophole:
 *   · a bare `${…}` of anything else — interpolating an unrelated variable is
 *     exactly how a misdirecting message launders itself;
 *   · a root of 2 characters or fewer, matching the main matcher's own floor;
 *   · a condition with no object root at all (`!contact` interpolating
 *     `${contact}` proves nothing the word test would not already catch).
 */
function honestByInterpolatedReason(condIdent: string, message: string): boolean {
  const root = condIdent.trim().split(/[.?[(]/)[0]?.trim() ?? ""
  if (root.length <= 2 || !/^[A-Za-z_$][\w$]*$/.test(root)) return false
  // The condition must be a PROPERTY of that root (`res.ok`), not the root
  // itself — otherwise `!contact` → "${contact} missing" would qualify.
  if (!new RegExp(`^${root}[.?[]`).test(condIdent.trim())) return false
  for (const m of message.matchAll(/\$\{([^}]*)\}/g)) {
    const expr = m[1] ?? ""
    // Rooted at the same object, and NOT the identical property being tested —
    // a message echoing `${res.ok}` says nothing the condition did not.
    if (new RegExp(`\\b${root}\\s*[.?[]`).test(expr) && expr.trim() !== condIdent.trim()) return true
  }
  return false
}

/** True when the message plausibly names the thing the condition tested. */
export function messageMatchesCondition(condIdent: string, message: string): boolean {
  const cond = tokens(condIdent)
  const msg = words(primaryClaim(message))
  for (const t of cond) {
    if (t.length <= 2) continue
    for (const w of msg) {
      if (w === t || w.startsWith(t) || t.startsWith(w)) return true
    }
  }
  if (honestBySynonym(cond, msg)) return true
  // Checked on the WHOLE message, not primaryClaim: a refusal commonly states
  // its claim first and interpolates the reason after the dash, and that reason
  // is the honest part. It cannot launder a wrong claim, because the expression
  // must be rooted at the very object the condition tested.
  return honestByInterpolatedReason(condIdent, message)
}

interface Hit { file: string; line: number; cond: string; msg: string }

function findMismatches(): Hit[] {
  const hits: Hit[] = []
  for (const file of [...walkTs("app"), ...walkTs("lib"), ...walkTs("components"), ...rootRuntimeFiles(".")]) {
    const s = read(file)
    for (const m of s.matchAll(GUARD_RE)) {
      // One of the three delimiter branches captured; the other two are undefined.
      const cond = m[1]!
      const msg  = m[2] ?? m[3] ?? m[4]
      if (msg === undefined) continue
      if (messageMatchesCondition(cond, msg)) continue
      hits.push({ file, line: s.slice(0, m.index!).split("\n").length, cond, msg: msg.trim() })
    }
  }
  return hits
}

let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}

// ── A REVIEW QUEUE, NOT A BUG COUNT. Lower it as messages are corrected; never
// raise it. Each entry needs a human to decide whether the sentence describes a
// CONSEQUENCE (fine) or a DIFFERENT CAUSE (the defect).
// 2026-09-04: 81 → 76, DOWNWARD, and the arithmetic is written out because a
// ratchet that moves without an account is just a number someone edited.
//
//   81  pre-wave
//   +2  two new refusals in lib/providers/calendar/outlook-calendar-sync-adapter.ts
//   -1  lib/kernel/calendar-sync-orchestrator.ts deleted (it had one)
//   = 82, which is what turned this guard red.
//
//   -2  both Outlook messages REWORDED rather than excused. One said
//       "…returned no id" while testing `externalId` ("id" is below the
//       two-character floor, so nothing overlapped) and now says "no external
//       id". The other embedded `${existingId ? "update" : "insert"}`, whose
//       quote characters truncate what this file can read to
//       `Microsoft Graph ${existingId ?` — a message plainly containing the word
//       "failed" that this guard could not see the word "failed" in. The verb is
//       computed into a local now. THAT IS A REAL BLIND SPOT, recorded here: a
//       quote inside a `${…}` cuts the captured message short.
//
//   -4  the interpolated-reason rule below, which this file's own header
//       instructed the next reader to write instead of raising the number again:
//         lib/transactions/offer-bridge.ts:193 and :351   (${gate.reason})
//         lib/ai-isa/appointment-scheduler.ts:71          (${verdict.reason})
//         lib/did/index.ts:431                            (${budget.spent})
//       Two of those were the very entries the header had raised the baseline
//       for, so teaching the detector RETIRED its own excuses.
//
//   = 76, measured, not chosen.
//
// 2026-09-04, wave 28 — 76 → 72, and the blind spot recorded four lines above is
// now CLOSED rather than worked around.
//
//   That note said, in this file's own words: "THAT IS A REAL BLIND SPOT,
//   recorded here: a quote inside a `${…}` cuts the captured message short." The
//   response at the time was to rewrite the SOURCE so the guard could read it
//   (computing the verb into a local). This wave the guard reported 78 and named
//   three new offenders; two of them were that blind spot firing again, on
//   app/actions/referrals/referral-actions.ts:329 and :579 — messages truncated
//   at an inner quote and then judged on the fragment. Rewriting two more call
//   sites to suit the instrument would have been the third time. GUARD_RE is
//   delimiter-aware instead, so the ceiling moves for the reason §2 gives: a
//   guard that cannot see the code it judges is worse than no guard.
//
//   -3  messages that were always honest and are now READ IN FULL, so the
//       interpolated-reason rule and the word matcher can both see them
//       (referral-actions.ts:329 and :579 among them).
//   -1  app/actions/referrals/referral-actions.ts:324 — a GENUINE hit, fixed in
//       the CODE, not the guard: `const { data: current }` holding a referral row
//       meant the guard tested `current` and the sentence said "Referral", and no
//       reader could tell they were the same thing either. The binding is named
//       currentReferral now.
//   The corpus also GREW (the 120-char ceiling moves to 200 — a message longer
//   than the ceiling did not truncate, it failed to match and dropped the guard
//   out of the corpus entirely), and no new offender surfaced in what it added.
//
//   = 72, measured, not chosen.
const BASELINE = 72

console.log("\n═══ 1. No NEW guard blames something it did not test ═══")
const hits = findMismatches()
{
  for (const h of hits.slice(0, 40)) console.log(`     ${h.file}:${h.line}  !${h.cond}  →  "${h.msg.slice(0, 70)}"`)
  if (hits.length > 40) console.log(`     … and ${hits.length - 40} more`)
  ok(`guards whose message names a different noun, at or below ${BASELINE} (found ${hits.length})`,
    hits.length <= BASELINE,
    `${hits.length} > ${BASELINE} — a new misdirecting message was added`)
}

console.log("\n═══ 2. The shapes it must catch — all live in this tree today ═══")
{
  // WHAT THIS DETECTOR CAN AND CANNOT SEE. Sharpening this cost two rounds and
  // is the most useful thing in the file, so it is written down rather than
  // remembered.
  //
  // CATCHES — the message names a DIFFERENT NOUN than the condition tests:
  //     if (!profile?.brokerage_id) return { error: "Not authenticated" }
  // The user IS authenticated. They have no brokerage. Being told to log in
  // again describes a fix that cannot possibly work.
  //
  // CANNOT CATCH — a TRUTHFUL message sitting on a WRONG condition:
  //     if (!voiceProfile) return { error: "agent has no elevenlabs_voice_id" }
  // when the profile was looked up by the wrong id class. The sentence honestly
  // reports what the code observed; the code observed the wrong thing. No
  // word-overlap test can see that, and pretending otherwise would make this
  // guard fire on correct code. That class belongs to test:identity-class and
  // test:identity-fallback, which already caught every instance of it.
  //
  // Two of the five examples this file was originally written from turned out to
  // be that second kind — "agent has no elevenlabs_voice_id" and "No contacts
  // match the criteria". Both messages were honest. Keeping them as test cases
  // would have forced the detector to flag honest code to satisfy its own
  // premise, which is precisely the failure it exists to name.
  const REAL: Array<[string, string, string]> = [
    ["profile?.brokerage_id", "Not authenticated",
      "tests a BROKERAGE, blames AUTH — the user is logged in and always will be"],
    ["contact", "Lead not found",
      "tests a CONTACT, blames a LEAD — different table, different business object in this OS"],
    ["userContext?.agentId", "You must be logged in to create a contact",
      "tests an AGENT PROFILE, blames LOGIN — logging in again can never fix it"],
    ["agentRecordId", "Voice clone not set up. The agent must complete Settings",
      "tests an AGENT PROFILE, blames the VOICE CLONE, which is present and correct"],
  ]
  for (const [cond, msg, why] of REAL) {
    ok(`flags  !${cond} → "${msg.slice(0, 40)}"\n    (${why})`,
      !messageMatchesCondition(cond, msg))
  }
}

console.log("\n═══ 3. And stays quiet on the honest forms it must not flag ═══")
{
  const HONEST: Array<[string, string]> = [
    ["agentRecordId", "No agent profile for this user — an AI ISA campaign is agent-scoped."],
    ["res.ok", "Failed to fetch data"],
    ["response.ok", "Failed to load billing data"],
    ["user", "Not authenticated"],
    ["userData.user", "Not authenticated"],
    ["ctx", "useShell must be used within <ShellProvider>"],
    ["brokerageId", "getVendors requires a brokerageId"],
    ["agent", "Agent not found"],
    ["contact", "No contact selected"],
    ["cancelled", "Could not load widget settings"],
    ["apiKey", "Provider is not configured — add credentials in Settings"],
  ]
  for (const [cond, msg] of HONEST) {
    ok(`quiet on  !${cond} → "${msg.slice(0, 50)}"`, messageMatchesCondition(cond, msg))
  }

  // ── THE INTERPOLATED-REASON RULE, PROVED IN BOTH DIRECTIONS ───────────────
  // A rule that only ever says YES would have silently emptied this whole
  // guard, so each admission is paired with the near-miss it must still refuse.
  ok('quiet on  !gate.allowed → "Gate refused transaction creation: ${gate.reason}"',
    messageMatchesCondition("gate.allowed", "[offer-bridge] Gate refused transaction creation: ${gate.reason}"))
  ok('quiet on  !verdict.contactId → "Cannot schedule: ${verdict.reason}"',
    messageMatchesCondition("verdict.contactId", "Cannot schedule ISA appointment: ${verdict.reason}"))

  ok("NEGATIVE CONTROL an interpolation of a DIFFERENT object is still flagged",
    !messageMatchesCondition("gate.allowed", "Something went wrong: ${other.reason}"))
  ok("NEGATIVE CONTROL echoing the SAME property back proves nothing and is still flagged",
    !messageMatchesCondition("gate.allowed", "Refused: ${gate.allowed}"))
  ok("NEGATIVE CONTROL a bare condition with no object root does not qualify",
    !messageMatchesCondition("lead", "Contact missing: ${lead}"))
  ok("NEGATIVE CONTROL a message with NO interpolation is unaffected by the new rule",
    !messageMatchesCondition("gate.allowed", "Transaction could not be created"))
  ok("NEGATIVE CONTROL a two-character root is below the floor, like the word matcher's",
    !messageMatchesCondition("g.allowed", "Refused: ${g.reason}"))
  // POSITIVE CONTROL that the new rule is doing REAL work rather than riding the
  // word matcher: the SAME sentence with the interpolation written out as plain
  // prose is still flagged. If this went quiet, the admissions above would prove
  // nothing about interpolation — they would just be word overlap.
  ok("POSITIVE CONTROL the same sentence WITHOUT the interpolation is still flagged",
    !messageMatchesCondition("gate.allowed", "[offer-bridge] Gate refused transaction creation: the reason"))

  // ── THE EXTRACTOR MUST READ THE SENTENCE IT JUDGES ────────────────────────
  // These run GUARD_RE itself, not just the matcher, because the 2026-09-04
  // defect was upstream of every rule above: a template literal quoting a value
  // inside itself was truncated at that inner quote, and the fragment was then
  // judged. A rule cannot be right about a sentence it never received.
  const extract = (src: string) => {
    const m = new RegExp(GUARD_RE.source, "s").exec(src)
    return m ? { cond: m[1], msg: m[2] ?? m[3] ?? m[4] } : null
  }
  const tmplWithQuotes =
    'if (!verdict.ok) { throw new Error(`A referral cannot move from "${previousStatus}" to "${status}". From here it can go to: ${verdict.allowed.join(", ")}.`) }'
  const got = extract(tmplWithQuotes)
  ok("POSITIVE CONTROL a template quoting a value inside itself is read WHOLE, not cut at the inner quote",
    got !== null && got.msg!.includes("From here it can go to"))
  ok("…and once whole, its interpolated reason is recognised, so it is not flagged",
    got !== null && messageMatchesCondition(got.cond!, got.msg!))
  ok("NEGATIVE CONTROL the pre-fix behaviour really did cut it — the old one-class body stops at the inner quote",
    /(?:Error\(\s*)["'`]([^"'`]{6,120})["'`]/.exec(tmplWithQuotes)?.[1] === "A referral cannot move from ")
  ok("a double-quoted message may contain a backtick and is still read whole",
    extract('if (!x.ok) throw new Error("the `id` column is missing from this row")')?.msg
      === "the `id` column is missing from this row")
  ok("NEGATIVE CONTROL a double-quoted message still ENDS at its own closing quote",
    extract('if (!x.ok) throw new Error("first message"); const s = "second message"')?.msg
      === "first message")
}

console.log(`\n${"═".repeat(70)}`)
console.log(`ERROR-MESSAGE HONESTY — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  console.log("\nAn error that names the wrong cause is worse than a vague one: it is")
  console.log("plausible, so the reader goes and investigates the thing it accused.")
  process.exit(1)
}
console.log(`${hits.length} guards blame a noun they did not test (baseline ${BASELINE}).`)
console.log("A REVIEW QUEUE, not a bug count — a message may honestly describe a")
console.log("consequence rather than its condition. Read the site before changing it.")
