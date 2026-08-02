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
 * SO DO NOT GRIND THIS NUMBER DOWN. 76 is a saturated queue, not a backlog, and
 * further reduction means bending honest sentences to satisfy a word-overlap
 * heuristic — the exact inversion this file warns about above. Its remaining job
 * is the ratchet: it fails when a NEW misdirecting message appears.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"

const read = (p: string) => { try { return readFileSync(p, "utf8") } catch { return "" } }
function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${e.name}`
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue
      walk(full, out)
    } else if (/\.tsx?$/.test(e.name)) out.push(full)
  }
  return out
}

/** `if (!X) ... "message"` — the guard and the sentence it blames. */
const GUARD_RE = new RegExp(
  String.raw`if\s*\(\s*!([A-Za-z_$][\w.$?]*)\s*\)\s*\{?[^{}]{0,200}?` +
  String.raw`(?:error:\s*|Error\(\s*|message:\s*)["'\`]([^"'\`]{6,120})["'\`]`,
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
  return honestBySynonym(cond, msg)
}

interface Hit { file: string; line: number; cond: string; msg: string }

function findMismatches(): Hit[] {
  const hits: Hit[] = []
  for (const file of [...walk("app"), ...walk("lib"), ...walk("components")]) {
    const s = read(file)
    for (const m of s.matchAll(GUARD_RE)) {
      const [, cond, msg] = m
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
const BASELINE = 76

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
