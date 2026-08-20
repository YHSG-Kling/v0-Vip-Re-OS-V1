/**
 * The compliance gate for AI-generated video scripts.
 *
 * This used to live inline inside app/actions/video/generate-script.ts — the
 * wizard path — and nowhere else. The other three reachable script generators
 * (video-generation.ts, link-to-video.ts, lib/kernel/video.ts) produced
 * agent-facing marketing copy with no Fair Housing check, no brand voice, and
 * no compliance_events audit row. Extracting the gate here is what lets all
 * four enforce the same thing instead of one enforcing it privately.
 *
 * Three pieces, used in this order:
 *   1. loadBrandVoiceBlock + THEM_FIRST_BLOCK + FAIR_HOUSING_BLOCK
 *      — injected into the AI system prompt so the model complies proactively.
 *   2. precheckBriefForFairHousing — hard block on the human's raw brief.
 *   3. postcheckScript — advisory warnings on what the model produced.
 *
 * ── On the missing `contact` ────────────────────────────────────────────────
 * These are broadcast payloads: there is no individual recipient at script
 * time. EvaluateOutboundParams documents `contact` as optional precisely for
 * this ("Omit for broadcast campaigns — DNC/TCPA gates are skipped").
 *
 * Every call site used to pass a stub contact with `id: "broadcast"` instead.
 * contacts.id and compliance_events.entity_id are both `uuid`, so that string
 * made BOTH the contact re-fetch and the compliance_events INSERT fail with
 * 22P02 — silently, because neither destructures `error`. The gate still
 * blocked correctly, but it never left an audit row, and the
 * COMPLIANCE_VIOLATION notification is guarded by `if (complianceEvent && ...)`
 * so it never fired either. Omitting the contact is violation-identical (the
 * stub set tcpa_consent true / dnc false / no status, and no call site used
 * sms or phone, so Gates 2 and 3 produced nothing) and it makes the audit
 * write succeed.
 */

import { createClient } from "@/lib/supabase/server"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { evaluateRegulatoryCompliance } from "@/lib/compliance-rules/rule-evaluators"
import { toLibraryScriptType } from "@/app/types/video-generation"

/** Who is generating, for the compliance actor context. */
export interface ScriptComplianceActor {
  userId: string
  brokerageId: string
  teamId?: string
}

/**
 * The persona a broadcast script is graded against.
 *
 * There is no individual recipient at script time (see the header note on the
 * missing `contact`), so there is no real persona either. `first_time` is the
 * value every call site has always used and it is kept — persona feeds
 * applyBrandVoice's NOTES only (lib/kernel/brand-voice.ts getPersonaBrandNotes)
 * and never contributes a violation, so it cannot change a verdict. It is named
 * here so the two calls below can never drift apart the way
 * create-video-project.ts's did.
 */
const SCRIPT_BROADCAST_PERSONA = "first_time" as const

// ─── THE ESCALATION LINE ─────────────────────────────────────────────────────
//
// OWNER RULING: "video scripts need to be written with them first, fair housing
// rules and compliance in mind and if it runs those then it shouldn't hold up
// the video creation unless it is a big red flag needed for a human."
//
// So there are THREE outcomes, not two:
//
//   advisory  — ThemFirst pronoun ratio, brand-voice drift, medium/low fair
//               housing ("safe area", "quiet neighborhood"), UDAAP pricing
//               language. Recorded, shown next to Regenerate, PASSES THROUGH.
//   red_flag  — a HARD fair-housing hit: a direct protected-class reference or
//               high-severity steering/preference language. Still does not
//               block the render, but a human is put on it.
//   unknown   — the evaluator THREW, or the brokerage's prohibited-phrase
//               catalogue could not be read / held nothing / would not compile.
//               That is "we do not know", and it is NOT the same as clean. Made
//               explicit rather than collapsed to "allowed", which is what every
//               catch block here used to do.
//
//               AND IT SUMMONS A HUMAN. `unknown` used to produce a warning line
//               and nothing else — an honest label on a script that then shipped
//               unreviewed, which is fail-OPEN on fair housing wearing a
//               disclosure. It now files the same review row a red flag does,
//               with holdReason 'unevaluated'. An unevaluatable script is held.
//
// The red-flag test is DELIBERATELY the deterministic one. evaluateOutbound
// opens a DB connection (brand voice profile, compliance_events) and can throw;
// evaluateRegulatoryCompliance is pure, synchronous and reads the same shared
// FAIR_HOUSING_PATTERNS array that evaluateOutbound's Gate 4 delegates to. That
// is the point: a database outage can lose the ADVISORY findings and the audit
// row, but it can never make a protected-class violation read as clean.
export type ScriptComplianceState = "clean" | "advisory" | "red_flag" | "unknown"

/**
 * The two rule names evaluateRegulatoryCompliance emits for real Fair Housing
 * findings. Its third regulatory family ("Guaranteed Investment Return" and the
 * other UDAAP pricing rules) is a genuine violation but it is NOT fair housing,
 * so it stays advisory — the ruling escalates fair housing, not everything.
 */
const FAIR_HOUSING_RULE_NAMES = new Set(["Fair Housing Act Violation", "Protected Class Reference"])

/**
 * BIG RED FLAGS in `content` — pure, synchronous, no DB, no network.
 *
 * The bar is `severity === "high"` on the two Fair Housing rule families, which
 * is the repo's own encoding of how bad a hit is (lib/compliance-rules/
 * fair-housing-patterns.ts). That set is: direct protected-class references
 * ("perfect for families", "no children", "adults only", religion/retiree
 * targeting), the §3604(c) protected-class word scan, and high-severity
 * steering ("changing neighborhood"). Medium/low fair-housing findings —
 * "safe area", "quiet neighborhood", "walk to church", "wheelchair
 * accessible" — are real and are reported, but as ADVISORY: escalating every
 * one of them would put a human in front of most listing scripts, which is the
 * hold-up the ruling forbids.
 *
 * Prefixed `FairHousing:` to match what evaluateOutbound emits, because
 * app/actions/link-to-video.ts classifies severity off exactly that prefix.
 */
export function detectFairHousingRedFlags(
  content: string,
  journeyType: "buyer" | "seller",
): string[] {
  if (!content?.trim()) return []
  const findings = evaluateRegulatoryCompliance({
    content_type: "social",
    channel_intent: journeyType,
    raw_content: content,
    context: { persona: SCRIPT_BROADCAST_PERSONA },
  })
  return findings
    .filter((v) => v.severity === "high" && FAIR_HOUSING_RULE_NAMES.has(v.rule_name))
    .map((v) => `FairHousing: ${v.description}`)
}

/**
 * Brand voice guidelines for the AI system prompt (Gate 1, proactive).
 *
 * `toneOverride` short-circuits the profile read — the wizard lets the agent
 * pick a tone per script, and that choice wins over the brokerage default.
 * Returns "" when the brokerage has no active profile, so it can be dropped
 * from the prompt with .filter(Boolean).
 */
async function loadBrandVoiceBlock(
  brokerageId: string,
  toneOverride?: string,
): Promise<string> {
  if (toneOverride) return `\nBrand voice tone: ${toneOverride}`

  const supabase = await createClient()
  const { data: bvp, error } = await supabase
    .from("brand_voice_profile")
    .select(
      "tone, formality_level, key_brand_messages, preferred_words, prohibited_words, tagline, mission_statement",
    )
    .eq("brokerage_id", brokerageId)
    .eq("is_active", true)
    .maybeSingle()

  // A refused or failed read is not "this brokerage has no brand voice" — say
  // nothing rather than silently generating off-brand copy under a default.
  if (error || !bvp) return ""

  return `
Brand voice guidelines (Gate 1 — follow strictly):
- Tone: ${bvp.tone ?? "professional"}
- Formality: ${bvp.formality_level ?? "moderate"}
${bvp.key_brand_messages?.length ? `- Key messages to reinforce: ${bvp.key_brand_messages.join("; ")}` : ""}
${bvp.preferred_words?.length ? `- Preferred words/phrases: ${bvp.preferred_words.join(", ")}` : ""}
${bvp.prohibited_words?.length ? `- NEVER use these words/phrases: ${bvp.prohibited_words.join(", ")}` : ""}
${bvp.tagline ? `- Brand tagline (may reference): ${bvp.tagline}` : ""}
${bvp.mission_statement ? `- Mission (may reference): ${bvp.mission_statement}` : ""}`
}

// ─── THE BROKERAGE'S OWN PROHIBITED WORDS ────────────────────────────────────
//
// OWNER RULING: brokerages add their own prohibited words in settings.
// app/actions/compliance-phrases.ts is that settings surface and it writes
// `prohibited_phrases` rows carrying the tenant's brokerage_id; m450 seeded the
// same table with 25 federal Fair Housing / RESPA / UDAAP phrases on rows with
// brokerage_id IS NULL, and RLS unions the two for a reader.
//
// THAT CATALOGUE HAD NEVER REACHED A VIDEO SCRIPT. Neither the writing prompt
// nor the post-check consulted it: buildComplianceSystemBlocks read
// brand_voice_profile.prohibited_words — a DIFFERENT column on a DIFFERENT
// table, which the settings screen does not write — and evaluateOutbound's
// Gate 5 walks a hard-coded ten-phrase array (lib/kernel/compliance.ts
// THEM_FIRST_PROHIBITED). So a broker could type a word into Settings →
// Prohibited phrases, see it saved, and have every AI video script in the
// brokerage ignore it. Both halves are fixed below: the list goes INTO the
// prompt (proactive, Gate 6) and the produced script is scanned against it.
//
// NO SECOND SCANNER. The scan is lib/application/compliance-monitoring.ts
// scanForProhibitedPhrases — the same pure function the content-approval gate
// uses, with the same DB_SEVERITY_TO_ISSUE_GRADE normalisation. It is reached by
// dynamic import so this module (loaded by six generators) does not pull that
// file's `ai` / next-cache graph into every one of them.

/** How the phrase catalogue read went. `empty` and `unreadable` are NOT passes. */
export type PhraseCatalogueState = "loaded" | "empty" | "unreadable"

export interface ProhibitedPhraseCatalogue {
  state: PhraseCatalogueState
  /** Rows as scanForProhibitedPhrases wants them. Empty unless state is "loaded". */
  rows: Array<{
    phrase: string
    phrase_pattern?: string | null
    category?: string | null
    severity?: string | null
    suggested_alternative?: string | null
  }>
  /** Why the read failed, when it did. */
  error?: string
}

/**
 * Every active prohibited phrase this SESSION may see — federal ∪ this tenant's.
 *
 * NO `.eq("brokerage_id", …)`. `NULL = <uuid>` is never true, so that filter
 * would hide all 25 federal rows and leave the gate reading only whatever the
 * brokerage happened to type — the exact mistake app/actions/compliance-phrases.ts
 * documents at (a). RLS already unions the two scopes.
 *
 * THREE OUTCOMES, and only one of them is "we checked":
 *   loaded     — rows came back; the scan can run.
 *   empty      — the table answered with nothing. That is not a clean bill of
 *                health, it is a gate that would pass every script ever written.
 *                prohibited_phrases held ZERO rows for the whole life of this
 *                product until m450, and every scan in that period returned
 *                "compliant" (see scanContentComplianceService, which now
 *                THROWS on this branch for the same reason).
 *   unreadable — the query errored, or createClient itself threw. supabase-js
 *                RESOLVES a refused read, so `error` is destructured; a throw is
 *                caught here rather than taking down the generation, and both
 *                report the same honest state.
 */
export async function loadProhibitedPhraseCatalogue(): Promise<ProhibitedPhraseCatalogue> {
  try {
    const supabase = await createClient()
    const { data, error } = await supabase
      .from("prohibited_phrases")
      .select("phrase, phrase_pattern, category, severity, suggested_alternative")
      .eq("is_active", true)
      .order("category", { ascending: true })
      .order("phrase", { ascending: true })

    if (error) return { state: "unreadable", rows: [], error: error.message }
    const rows = (data ?? []) as ProhibitedPhraseCatalogue["rows"]
    if (rows.length === 0) return { state: "empty", rows: [] }
    return { state: "loaded", rows }
  } catch (err) {
    return {
      state: "unreadable",
      rows: [],
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * The prompt cap. A brokerage may accumulate hundreds of words; a system prompt
 * that carries all of them crowds out the rest of the brief and costs tokens on
 * every generation. The BLOCKING ones are never dropped — they are the words the
 * brokerage said it will not let leave the building — and the advisory ones fill
 * whatever is left.
 */
const PROMPT_PHRASE_LIMIT = 80

/**
 * The brokerage's own prohibited words, as a system-prompt block (Gate 6,
 * proactive). "" when the catalogue could not be read or holds nothing — a
 * prompt cannot usefully say "we failed to load your rules", and the HONEST
 * reporting of that state belongs to assessScriptCompliance below, which turns
 * it into `unknown` rather than `clean`.
 */
export function buildProhibitedPhraseBlock(catalogue: ProhibitedPhraseCatalogue): string {
  if (catalogue.state !== "loaded") return ""

  const blocking = catalogue.rows.filter((r) => r.severity === "critical")
  const advisory = catalogue.rows.filter((r) => r.severity !== "critical")
  const chosenBlocking = blocking.slice(0, PROMPT_PHRASE_LIMIT)
  const chosenAdvisory = advisory.slice(0, Math.max(0, PROMPT_PHRASE_LIMIT - chosenBlocking.length))
  if (chosenBlocking.length === 0 && chosenAdvisory.length === 0) return ""

  const quote = (r: { phrase: string }) => `"${r.phrase}"`
  const alternatives = catalogue.rows
    .filter((r) => r.suggested_alternative)
    .slice(0, 12)
    .map((r) => `"${r.phrase}" → ${r.suggested_alternative}`)

  return [
    `\nProhibited words and phrases (Gate 6 — this brokerage's own list plus the federal catalogue, mandatory):`,
    chosenBlocking.length
      ? `- NEVER write any of these, in any form: ${chosenBlocking.map(quote).join(", ")}`
      : "",
    chosenAdvisory.length
      ? `- Avoid these unless the brief makes them unavoidable: ${chosenAdvisory.map(quote).join(", ")}`
      : "",
    alternatives.length ? `- Preferred replacements: ${alternatives.join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

/** Findings that must summon a human — the brokerage graded these BLOCKING. */
export const PROHIBITED_PHRASE_RED_FLAG_PREFIX = "ProhibitedPhrase(blocking):"
/** Findings that ride along with the script and hold nothing up. */
export const PROHIBITED_PHRASE_ADVISORY_PREFIX = "ProhibitedPhrase:"
/** Prefix on every "the gate could not run" line, at every call site. */
export const COMPLIANCE_UNKNOWN_PREFIX = "Compliance: UNKNOWN"

export interface ProhibitedPhraseFindings {
  catalogueState: PhraseCatalogueState
  /** severity 'critical' → DB_SEVERITY_TO_ISSUE_GRADE 'blocking'. A human is put on these. */
  redFlags: string[]
  /** info / warning rows. Surfaced, never blocking — see PHRASE_SEVERITY_HELP. */
  warnings: string[]
  /**
   * Set when the catalogue could not be read, held nothing, or would not
   * COMPILE. Any of the three means the tenant's own rules were not applied, and
   * none of them is "the script is clean".
   */
  unknownReason?: string
}

/**
 * Scan a script against the phrase catalogue and grade what comes back.
 *
 * SEVERITY IS THE BROKERAGE'S OWN JUDGEMENT, NOT OURS. The settings screen tells
 * a broker in so many words that `critical` is "the only severity that makes
 * content FAIL the scan" (lib/compliance/phrase-vocabulary.ts
 * PHRASE_SEVERITY_HELP), and DB_SEVERITY_TO_ISSUE_GRADE maps exactly that value
 * to `blocking`. So critical → red flag, everything else → advisory. Inventing a
 * different bar here would mean the screen lies about what the word does.
 *
 * A MALFORMED STORED PATTERN THROWS. scanForProhibitedPhrases builds
 * `new RegExp(phrase_pattern || phrase, "gi")` and deliberately does not catch,
 * so one bad row takes the whole scan down. That is right — a scan that cannot
 * compile its catalogue must not report content clean — and it is caught HERE
 * into `unknownReason` rather than into an empty finding list.
 */
export async function assessProhibitedPhrases(
  script: string,
  catalogue?: ProhibitedPhraseCatalogue,
): Promise<ProhibitedPhraseFindings> {
  const cat = catalogue ?? (await loadProhibitedPhraseCatalogue())

  if (cat.state === "unreadable") {
    return {
      catalogueState: "unreadable",
      redFlags: [],
      warnings: [],
      unknownReason:
        `${COMPLIANCE_UNKNOWN_PREFIX} — the prohibited-phrase catalogue could not be read ` +
        `(${cat.error ?? "unknown error"}). This brokerage's own prohibited words were NOT applied to this script.`,
    }
  }
  if (cat.state === "empty") {
    return {
      catalogueState: "empty",
      redFlags: [],
      warnings: [],
      unknownReason:
        `${COMPLIANCE_UNKNOWN_PREFIX} — the prohibited-phrase catalogue holds no active phrases, so the ` +
        `phrase scan would pass every script ever written. "No rules configured" is not "compliant". ` +
        `Apply supabase/migrations/m450-* and add this brokerage's words in Settings → Prohibited phrases.`,
    }
  }

  let found: Array<{ severity?: string; found?: string; category?: string | null; suggestedAlternative?: string | null }>
  try {
    const { scanForProhibitedPhrases } = await import("@/lib/application/compliance-monitoring")
    found = scanForProhibitedPhrases(cat.rows, script)
  } catch (err) {
    return {
      catalogueState: "loaded",
      redFlags: [],
      warnings: [],
      unknownReason:
        `${COMPLIANCE_UNKNOWN_PREFIX} — the prohibited-phrase scan could not run ` +
        `(${err instanceof Error ? err.message : String(err)}). A stored phrase or match pattern does not compile, ` +
        `so no phrase was checked. Fix it in Settings → Prohibited phrases.`,
    }
  }

  const redFlags: string[] = []
  const warnings: string[] = []
  for (const f of found) {
    const alt = f.suggestedAlternative ? ` Use instead: ${f.suggestedAlternative}.` : ""
    if (f.severity === "blocking") {
      redFlags.push(
        `${PROHIBITED_PHRASE_RED_FLAG_PREFIX} "${f.found}" is on this brokerage's blocking list` +
        `${f.category ? ` (${f.category})` : ""}.${alt}`,
      )
    } else {
      warnings.push(
        `${PROHIBITED_PHRASE_ADVISORY_PREFIX} "${f.found}"${f.category ? ` (${f.category})` : ""}` +
        ` — severity ${f.severity ?? "warning"}.${alt}`,
      )
    }
  }
  return { catalogueState: "loaded", redFlags, warnings }
}

/**
 * The BLOCKING phrase findings inside a flat list from postcheckScript. PURE —
 * no second database read.
 *
 * The five generators that consume postcheckScript get one array of sentences.
 * A caller has to be able to tell which of them summon a human, and it cannot
 * do that by re-running the scan: the catalogue read costs a round trip and,
 * worse, a second read can disagree with the first. The prefix is the contract.
 */
export function detectProhibitedPhraseRedFlags(findings: string[]): string[] {
  return findings.filter((f) => f.startsWith(PROHIBITED_PHRASE_RED_FLAG_PREFIX))
}

/** ThemFirst philosophy for the AI system prompt (Gate 5, proactive). */
const THEM_FIRST_BLOCK = `
ThemFirst communication philosophy (Gate 5 — apply throughout):
- Use "you" and "your" language at least 60% of the time relative to "I/me/my/we/our".
- Focus every sentence on what the CLIENT experiences, benefits from, or discovers.
- Avoid ego-driven phrases: "I'm the best agent", "trust me", "you'd be crazy not to".
- Avoid false urgency: "limited time offer", "this won't last long", "don't miss out", "you need to act fast".
- Avoid investment advice claims: "guaranteed to appreciate", "you'll make money", "great investment".
- Frame the agent's expertise as a resource FOR the client, not a credential about the agent.`

/** Fair Housing directive for the AI system prompt (Gate 4, proactive). */
const FAIR_HOUSING_BLOCK = `
Fair Housing compliance (Gate 4 — mandatory):
- NEVER reference or imply race, color, religion, sex, national origin, disability, or familial status.
- NEVER use neighborhood steering language (e.g., "great schools", "safe area", "quiet neighborhood" as dog-whistles).
- Describe properties by features, square footage, layout, and price — not by the demographics of residents.
- Keep all language neutral and inclusive.`

/**
 * The proactive blocks, ready to splice into a system prompt.
 * Callers .filter(Boolean).join("\n\n") them with their own type/tone context.
 *
 * THIS IS WHERE "WRITTEN WITH THEM FIRST, FAIR HOUSING AND COMPLIANCE IN MIND"
 * ACTUALLY HAPPENS. Everything downstream of generation is a grade; this is the
 * only place the rules are an INPUT. Four blocks now, not three — the brokerage's
 * own prohibited words (Gate 6) join brand voice, ThemFirst and Fair Housing,
 * because a word a broker typed into Settings that the writing prompt never sees
 * is a rule that only exists on a screen.
 *
 * Return type is unchanged (string[]) on purpose: six callers spread this into
 * their prompt arrays and none of them has to change to get the new block.
 */
export async function buildComplianceSystemBlocks(
  brokerageId: string,
  toneOverride?: string,
): Promise<string[]> {
  const brandVoiceBlock = await loadBrandVoiceBlock(brokerageId, toneOverride)
  const phraseBlock = buildProhibitedPhraseBlock(await loadProhibitedPhraseCatalogue())
  return [brandVoiceBlock, THEM_FIRST_BLOCK, FAIR_HOUSING_BLOCK, phraseBlock].filter(Boolean)
}

export interface BriefPrecheckResult {
  /** True when the brief must not be sent to the model at all. */
  blocked: boolean
  /** The first Fair Housing violation, phrased for the agent. */
  reason?: string
  /**
   * True when evaluateOutbound THREW. The brief is still let through (an
   * infrastructure failure must not strand the agent), but the caller can no
   * longer mistake that for "the gate looked and found nothing".
   */
  evaluatorFailed: boolean
  /** Why the evaluator failed, when it did. */
  evaluatorError?: string
}

/**
 * Hard block on the agent's raw brief — Fair Housing only.
 *
 * ThemFirst and Brand Voice deliberately do NOT block here: they govern
 * outbound copy, not the shorthand an agent types into a form. A brief reading
 * "my listing, I need a punchy intro" is agent-centric by nature and must not
 * be refused for it.
 *
 * THE FAIL-OPEN IS FIXED, NOT REMOVED. This used to be `catch { return
 * { blocked: false } }` with a comment calling that "reported as unblocked" —
 * so a database outage turned the pre-generation Fair Housing block into a
 * no-op, silently. Two changes:
 *
 *   1. The DETERMINISTIC red-flag scan runs FIRST and outside the try. It needs
 *      no database, so a protected-class brief is refused whether or not the
 *      kernel gate is reachable. That is the half that must never fail open.
 *   2. A throw is still unblocked — an infrastructure failure must not strand
 *      the agent — but it is now reported as `evaluatorFailed: true` instead of
 *      being indistinguishable from a clean brief.
 */
export async function precheckBriefForFairHousing(
  actor: ScriptComplianceActor,
  brief: string,
  journeyType: "buyer" | "seller",
): Promise<BriefPrecheckResult> {
  // Deterministic first: this cannot throw and cannot be lost to a DB outage.
  const deterministic = detectFairHousingRedFlags(brief, journeyType)
  if (deterministic.length > 0) {
    return { blocked: true, reason: deterministic[0], evaluatorFailed: false }
  }

  try {
    const preCheck = await evaluateOutbound({
      actorContext: { userId: actor.userId, role: "agent", brokerageId: actor.brokerageId, teamId: actor.teamId },
      journeyType,
      persona: SCRIPT_BROADCAST_PERSONA,
      messageType: "social",
      content: brief,
    })
    const fairHousingViolations = (preCheck.violations ?? []).filter((v) =>
      v.startsWith("FairHousing:"),
    )
    if (fairHousingViolations.length > 0) {
      return { blocked: true, reason: fairHousingViolations[0], evaluatorFailed: false }
    }
    return { blocked: false, evaluatorFailed: false }
  } catch (err) {
    return {
      blocked: false,
      evaluatorFailed: true,
      evaluatorError: err instanceof Error ? err.message : String(err),
    }
  }
}

/** The full verdict on a generated script — see ScriptComplianceState above. */
export interface ScriptComplianceAssessment {
  state: ScriptComplianceState
  /** Advisory findings. Recorded and surfaced; they NEVER hold up a render. */
  warnings: string[]
  /** Hard fair-housing hits. A human is put on these — see the ruling above. */
  redFlags: string[]
  /** True when evaluateOutbound threw: "we do not know", not "it is clean". */
  evaluatorFailed: boolean
  evaluatorError?: string
  /** The compliance_events row the kernel gate wrote, when it got that far. */
  complianceEventId?: string
  /**
   * loaded | empty | unreadable for `prohibited_phrases`. Anything but `loaded`
   * means the brokerage's own words were not applied, which forces `unknown`.
   */
  phraseCatalogueState: PhraseCatalogueState
  /** The UNKNOWN sentences: a thrown evaluator, an unusable phrase catalogue, or both. */
  unknownReasons: string[]
}

/**
 * The full compliance verdict on a generated script.
 *
 * The script was produced under a system prompt that already carried brand
 * voice, ThemFirst and Fair Housing, so anything left is a model slip. Per the
 * ruling NOTHING here blocks the render — the caller shows warnings next to a
 * Regenerate button, and escalates red flags to the human lane
 * (escalateScriptToHumanReview) while still handing the agent their script.
 */
export async function assessScriptCompliance(
  actor: ScriptComplianceActor,
  script: string,
  journeyType: "buyer" | "seller",
): Promise<ScriptComplianceAssessment> {
  // Deterministic first and OUTSIDE the try, for the reason on
  // detectFairHousingRedFlags: a thrown evaluator must not be able to hide a
  // protected-class violation.
  const redFlags = detectFairHousingRedFlags(script, journeyType)

  // The brokerage's OWN words, second, and also outside the try — same reason.
  // assessProhibitedPhrases never throws: it converts a refused read, an empty
  // catalogue and an uncompilable pattern into an explicit unknownReason, so a
  // failure here can never arrive as an empty finding list.
  const phrases = await assessProhibitedPhrases(script)
  redFlags.push(...phrases.redFlags)

  let warnings: string[] = [...phrases.warnings]
  let evaluatorFailed = false
  let evaluatorError: string | undefined
  let complianceEventId: string | undefined

  try {
    const postCheck = await evaluateOutbound({
      actorContext: { userId: actor.userId, role: "agent", brokerageId: actor.brokerageId, teamId: actor.teamId },
      journeyType,
      persona: SCRIPT_BROADCAST_PERSONA,
      messageType: "social",
      content: script,
    })
    complianceEventId = postCheck.complianceEventId
    // The kernel gate re-derives the same Fair Housing hits from the same rule
    // array, so drop anything the deterministic pass already reported rather
    // than showing the agent the identical sentence twice. `warnings` already
    // holds the advisory phrase findings, so this APPENDS — assigning over it
    // would silently drop the brokerage's own non-blocking words.
    warnings.push(...(postCheck.violations ?? []).filter((v) => !redFlags.includes(v)))
  } catch (err) {
    evaluatorFailed = true
    evaluatorError = err instanceof Error ? err.message : String(err)
  }

  const unknownReasons: string[] = []
  if (evaluatorFailed) {
    unknownReasons.push(
      `${COMPLIANCE_UNKNOWN_PREFIX} — the compliance evaluator could not run (${evaluatorError ?? "unknown error"}). ` +
      `Fair Housing was still checked deterministically; brand voice and ThemFirst were NOT. Review before publishing.`,
    )
  }
  if (phrases.unknownReason) unknownReasons.push(phrases.unknownReason)

  // ORDER OF PRECEDENCE. A known violation outranks "we do not know" — a dead
  // async gate must never downgrade a protected-class hit to a shrug. And
  // "we do not know" outranks "advisory", because an unapplied rule set is not
  // a clean bill of health with a note attached.
  const state: ScriptComplianceState =
    redFlags.length > 0 ? "red_flag"
      : unknownReasons.length > 0 ? "unknown"
        : warnings.length > 0 ? "advisory"
          : "clean"

  return {
    state,
    warnings,
    redFlags,
    evaluatorFailed,
    evaluatorError,
    complianceEventId,
    phraseCatalogueState: phrases.catalogueState,
    unknownReasons,
  }
}

/**
 * The flat advisory list, for the four generators that only ever wanted a list
 * of sentences to show the agent (video-generation.ts, link-to-video.ts,
 * lib/kernel/video.ts, content-generation-engine.ts).
 *
 * Signature and return type are UNCHANGED so those four keep compiling, but two
 * things it used to hide are now in the list:
 *   · red flags lead, still `FairHousing:`-prefixed so link-to-video.ts's
 *     `startsWith("FairHousing:") ? "violation" : "warning"` classifier keeps
 *     grading them as violations;
 *   · a thrown evaluator yields an explicit UNKNOWN line instead of
 *     `undefined`. `undefined` read as "clean" at every one of those call
 *     sites, which is the fail-open this fixes.
 * Still returns undefined ONLY when the gate ran, in full, and found nothing —
 * which now includes the brokerage's own prohibited-phrase catalogue having been
 * READ. An unreadable or empty catalogue produces a `Compliance: UNKNOWN` line
 * here rather than an absence, because "no rules configured" is not "compliant".
 */
export async function postcheckScript(
  actor: ScriptComplianceActor,
  script: string,
  journeyType: "buyer" | "seller",
): Promise<string[] | undefined> {
  const assessment = await assessScriptCompliance(actor, script, journeyType)
  const flat = [...assessment.redFlags, ...assessment.warnings, ...assessment.unknownReasons]
  return flat.length > 0 ? flat : undefined
}

// ─── THE HUMAN LANE ──────────────────────────────────────────────────────────

export interface ScriptEscalationResult {
  ok: boolean
  /** video_scripts_library.id — the row a human now owns. */
  reviewId?: string
  error?: string
}

/**
 * Put a red-flagged script in front of a human, on the lane that already exists.
 *
 * THE LANE (not a new one): video_scripts_library.approval_status =
 * 'pending_review' is read by app/actions/marketing-ai-approvals.ts
 * listPendingMarketingAssetsAction (the `vs` query, kind 'video_script') and
 * rendered at /dashboard/admin/marketing-approvals. Approve/reject route
 * through the ONE canonical transition,
 * lib/kernel/approval-queue-aggregator.ts applyMarketingAssetApproval /
 * applyMarketingAssetRejection, whose MARKETING_TABLE_BY_KIND already maps
 * video_script → video_scripts_library. compliance_review_notes is a real
 * column and is already rendered on the script detail sheet
 * (app/dashboard/videos/library/page.tsx:881). Nothing new is built here.
 *
 * WHY THE ROW IS FORCED. saveToLibrary is optional, and a generator that did
 * not ask to save produced no row at all — so there was nothing for a human to
 * find. An escalation with no row is not an escalation. A red flag therefore
 * writes the row whether or not the caller wanted a library entry.
 *
 * WHY NOT 'draft'. Every generator wrote approval_status 'draft', and the
 * admin queue filters 'pending_review' exclusively — so no AI script has ever
 * reached that surface. 'draft' is right for the ordinary case (an agent's own
 * shelf); 'pending_review' is what actually summons a human.
 *
 * agent_id is agents-class (FK agents(id)) while every caller holds a users id,
 * so it is RESOLVED, never substituted; created_by is the users id. brokerageId
 * must be the SESSION's — the only policy on this table is
 * `brokerage_id = current_user_brokerage_id()`, so a foreign one is refused.
 */
export async function escalateScriptToHumanReview(params: {
  actor: ScriptComplianceActor
  script: string
  /** The raw videoType — mapped through toLibraryScriptType (live CHECK admits five). */
  videoType: string
  title: string
  redFlags: string[]
  warnings?: string[]
  brandVoiceTone?: string
  durationTargetSeconds?: number
  /**
   * WHY a person is being summoned. Defaults to the original case, a hard Fair
   * Housing finding.
   *
   * `unevaluated` is the FAIL-CLOSED case and it is the reason this parameter
   * exists. A script whose compliance could not be evaluated — the kernel gate
   * threw, or the brokerage's phrase catalogue could not be read — used to
   * produce a warning line and nothing else: state `unknown`, no queue row, no
   * reviewer. That is fail-OPEN on fair housing dressed as honesty. The two
   * cases share ONE lane and ONE row shape; only the note differs, so the
   * reviewer can see whether they are judging a finding or an absence.
   */
  holdReason?: "fair_housing_red_flag" | "unevaluated"
  /** The `Compliance: UNKNOWN — …` sentences, when holdReason is "unevaluated". */
  unknownReasons?: string[]
}): Promise<ScriptEscalationResult> {
  const supabase = await createClient()

  const { resolveAgentIdInBrokerage } = await import("@/lib/kernel/agent-identity")
  const agentId = await resolveAgentIdInBrokerage(
    supabase,
    params.actor.userId,
    params.actor.brokerageId,
  )

  const unevaluated = params.holdReason === "unevaluated"
  const notes = [
    unevaluated
      ? "HELD FOR HUMAN REVIEW — this AI-generated video script could NOT be compliance-checked. " +
        "It is not known to be clean; it is known to be unchecked."
      : "HELD FOR HUMAN REVIEW — hard Fair Housing finding on an AI-generated video script.",
    ...params.redFlags.map((f) => `• ${f}`),
    ...(unevaluated && params.unknownReasons?.length
      ? ["What could not be checked:", ...params.unknownReasons.map((r) => `• ${r}`)]
      : []),
    ...(params.warnings?.length
      ? ["Advisory (not blocking):", ...params.warnings.map((w) => `• ${w}`)]
      : []),
  ].join("\n")

  const { data, error } = await supabase
    .from("video_scripts_library")
    .insert({
      brokerage_id: params.actor.brokerageId,
      // agents-class or nothing — never the users id (FK agents(id)).
      agent_id: agentId,
      script_type: toLibraryScriptType(params.videoType),
      title: params.title,
      script_content: params.script,
      duration_target_seconds: params.durationTargetSeconds ?? null,
      brand_voice_tone: params.brandVoiceTone ?? null,
      ai_generated: true,
      approval_status: "pending_review",
      compliance_review_notes: notes,
      is_active: true,
      created_by: params.actor.userId,
    })
    .select("id")
    .maybeSingle()

  // supabase-js RESOLVES a refused insert. If this is swallowed, the script is
  // reported as escalated while no human was ever summoned — the exact failure
  // the audit-trail note at the top of this file describes.
  if (error) return { ok: false, error: error.message }
  if (!data?.id) return { ok: false, error: "The review row was not created — nothing is waiting for a human." }
  return { ok: true, reviewId: data.id as string }
}
