/**
 * lib/listing-presentation/section-narration.ts
 *
 * Wave 39 — the per-section narration the agent's avatar/voice clone speaks over
 * each pre-listing presentation section. This is the CONTENT that sells the
 * seller on the brokerage + agent + marketing system over any other local
 * agent — deterministic + seller-safe (NEVER states the home's value; that is
 * deferred to the in-person meeting), so it is fully testable and never leaks a
 * suggested price.
 *
 * Flow: buildSectionNarrationScript() → ElevenLabs TTS in the agent's cloned
 * voice → D-ID talking-head → the avatar PIP narrates the section. The script
 * also drives the on-screen bullets so copy + voiceover stay in sync.
 */
import { findSuggestedPriceLeaks } from "@/lib/cma/customer-facing-guard"
import { detectFairHousingViolations, type FairHousingPattern } from "@/lib/compliance-rules/fair-housing-patterns"
import { MARKETING_SYSTEM_FLOOR } from "@/lib/listing-presentation/marketing-system"
import { compositionSeconds, geometryFor } from "@/lib/remotion/composition-geometry"
import {
  narrationBudget,
  narrationLengthDirective,
  narrationMaxTokens,
  narrationOverrunRedraftDirective,
  fitNarrationToBudget,
  fitNarrationWithOneRedraft,
  spokenWords,
  type NarrationBudget,
} from "@/lib/video/script-structure"
// TYPE-ONLY, deliberately. lib/video/script-compliance.ts imports the server
// Supabase client at module scope; a value import here would drag that into the
// deterministic builder and into every pure simulator that exercises it. The
// escalation lane and the compliance verdict are reached by dynamic import at
// the two points that actually need them.
import type { ScriptComplianceActor } from "@/lib/video/script-compliance"

/**
 * The composition these scripts are SPOKEN OVER.
 *
 * section-render.ts queues every non-CMA section as a `ListingSectionReel`, and
 * that composition carries the narration as an <Audio> INSIDE the composition
 * (remotion/ListingSectionReel.tsx:63) against a FIXED durationInFrames. Nothing
 * pads it — an overrun is CUT, mid-word, in a video already sent to a seller. So
 * the script has to be sized to the composition before it is written.
 */
export const SECTION_NARRATION_COMPOSITION = "ListingSectionReel"

/**
 * What a section script is allowed to be, DERIVED from the composition's real
 * geometry. Change ListingSectionReel's durationInFrames and this moves with it;
 * there is no 20 written down anywhere.
 */
export function sectionNarrationBudget(
  compositionId: string = SECTION_NARRATION_COMPOSITION,
): NarrationBudget {
  const geo = geometryFor(compositionId)
  return narrationBudget(compositionId, geo ? compositionSeconds(geo) : 0)
}

export interface NarrationInput {
  sectionKey:    string
  brokerageName: string
  agentName:     string
  areaName?:     string | null
  teamName?:     string | null
}

export interface SectionNarration {
  sectionKey: string
  /** Full narration for ElevenLabs TTS. */
  script:     string
  /** Short on-screen lines (kept in sync with the script). */
  bullets:    string[]
  /**
   * What the budget fit and the compliance belt actually DID, in words, so the
   * caller can stage it beside the render instead of it living only in a
   * console.warn nobody reads. Present only when there is something to say.
   *
   * §1: this is the READER half of `NarrationFit.stillOverBudget`. The field was
   * produced and asserted by scripts/remotion-setup-guard.ts and consumed by
   * nothing — three producers warned and shipped the truncated track anyway.
   * lib/listing-presentation/section-render.ts should stage these onto the
   * render's input_props / ledger so an overrun or a held script is visible.
   */
  notes?:     string[]
  /**
   * TRUE when a HARD fair-housing finding was escalated to a human and the
   * deterministic script is what will be spoken. §5's disposition, in a field
   * rather than only in a log line.
   */
  heldForReview?: boolean
  /** video_scripts_library.id a human now owns, when the escalation filed. */
  reviewId?:  string
}

export function buildSectionNarrationScript(input: NarrationInput): SectionNarration {
  const agent = (input.agentName || "your agent").trim()
  const brokerage = (input.brokerageName || "our brokerage").trim()
  const team = input.teamName?.trim()
  const where = input.areaName?.trim() || "your neighborhood"
  const us = team ? `${team} at ${brokerage}` : brokerage

  const S: Record<string, SectionNarration> = {
    intro: {
      sectionKey: "intro",
      script: `Hi, I'm ${agent} with ${us}. Before we even meet, I want to show you exactly how we'll sell your home — with a marketing system no other agent in ${where} runs. Let's walk through it together.`,
      bullets: ["A marketing system no other local agent runs.", `Here's how ${us} will sell your home — before we meet.`],
    },
    credibility: {
      sectionKey: "credibility",
      script: `${us} doesn't just list homes — we market them. You get a full team behind you, not a single busy agent, and a proven track record right here in ${where}. When you hire us, you hire the whole system.`,
      bullets: ["A team behind you, not one busy agent.", `Proven results right here in ${where}.`],
    },
    marketing: {
      sectionKey: "marketing",
      script: `Here's how we sell: cinematic video, animated market data, and omnipresent digital reach across every channel where today's buyers are actually looking. Your home won't be a flyer — it'll be marketed like a brand.`,
      bullets: ["Cinematic video + animated market data.", "Omnipresent reach where buyers actually look.", "Your home, marketed like a brand."],
    },
    process: {
      sectionKey: "process",
      script: `From listing to closing, you'll always know what's next. You and I stay on the same page every step of the way — no surprises, no chasing, no guesswork. We make selling feel effortless.`,
      bullets: ["A clear path from listing to closing.", "You and your agent on the same page, every step."],
    },
    closing: {
      sectionKey: "closing",
      script: `When we meet, I'll walk you through your home's value and our complete strategy in person. Bring your questions — I'll bring the plan. Let's get your home sold for everything it's worth.`,
      bullets: ["Bring your questions — we'll bring the plan.", "Your home's value, covered in person."],
    },
    market: {
      sectionKey: "market",
      script: `Let's look at your market. These are recent comparable sales and where prices are heading in ${where}. Your home's specific value is the very first thing we'll cover when we sit down together.`,
      bullets: [`Recent comparable sales + where ${where} is heading.`, "Your home's value — discussed in person."],
    },
    cma: {
      sectionKey: "cma",
      script: `Here's the market analysis for ${where} — the comparable sales, how long homes are taking to sell, and what buyers are paying. Your home's specific number? We'll go through that together at our meeting, where I can factor in everything that makes your home unique.`,
      bullets: ["The comparable sales + market velocity.", "Your home's number — covered at our meeting."],
    },
  }

  const out = S[input.sectionKey] ?? {
    sectionKey: input.sectionKey,
    script: `${us} is ready to sell your home with a marketing system built for today's market. Let's talk strategy when we meet.`,
    bullets: [`${us} — a marketing system built for today's market.`],
  }

  // Compliance belt: the narration must never carry a suggested price.
  if (findSuggestedPriceLeaks({ script: out.script, bullets: out.bullets }).length > 0) {
    return { sectionKey: out.sectionKey, script: out.script.replace(/\$[\d,]+/g, "the right price"), bullets: out.bullets }
  }
  return out
}

export const NARRATABLE_SECTION_KEYS = ["intro", "credibility", "marketing", "process", "closing", "market", "cma"] as const

// ── AI narration (the WOW differentiator) ───────────────────────────────────
// Per-section creative brief that steers the AI toward a compelling, specific,
// seller-safe script — not generic filler. The deterministic builder above is
// the fallback when the AI is unavailable.
const SECTION_BRIEF: Record<string, string> = {
  intro:       "Warmly introduce yourself and build anticipation that what follows is a marketing system unlike any other local agent's.",
  credibility: "Establish why this team wins listings — results, the team behind the seller, deep local expertise — so the seller feels they're in the best possible hands.",
  marketing:   "Showcase the marketing machine (cinematic listing video, animated market-data reels, the agent's AI avatar, omnipresent social + portal reach, AI-search-optimized property pages) and contrast it with the tired flyer-and-MLS approach other agents still use.",
  process:     "Reassure the seller the path from listing to closing is clear and stress-free, and that they and the agent stay on the same page the whole way — reduce their anxiety.",
  closing:     "Invite them to the meeting where you'll reveal their home's value and the full strategy; create momentum to choose you.",
  market:      "Walk through the local market with confidence — direction, comparable activity, how fast homes are selling — WITHOUT revealing their home's value.",
  cma:         "Frame the analysis as proof of your data-driven approach and show the market context, while explicitly deferring the home's specific number to the in-person meeting.",
}

// ── TOMBSTONE — `DEFAULT_MARKETING_SYSTEM` (the const that used to be here) ──
//
// SURVIVOR: lib/listing-presentation/marketing-system.ts
//   · MARKETING_SYSTEM_CLAIMS — the six claims, each re-attached to the
//     entitlement that makes it true
//   · composeMarketingSystem() — the pure selector
//   · MARKETING_SYSTEM_FLOOR — the claim-free sentence used when nothing
//     resolves
// The I/O half is lib/listing-presentation/marketing-system-resolver.ts
// resolveMarketingSystem(), called by lib/listing-presentation/section-render.ts.
//
// WHAT IT WAS: one frozen English sentence naming six capabilities, used as the
// fallback for `input.marketingSystem` — which NOTHING in the tree ever set. So
// every seller of every tenant on every plan heard the same six claims, in their
// agent's cloned voice, whether or not that brokerage could deliver them.
//
// WHY IT MOVED (owner ruling, reversing the previous wave's §1 verdict): the
// default marketing system is part of the listing presentation and part of
// ADVERTISEMENT, so it is an active function, not a constant. The previous wave
// un-exported the const because the export had no importers; the export was
// indeed orphaned, but the WRITER was the missing half, and §1.2 says build it.
//
// The measured finding that made this more than tidying: on the live database
// `agent_voice_profiles` and `agent_avatar_assets` both hold ZERO rows, so the
// third claim — a personal AI-avatar video series — was being promised to
// sellers by a platform on which no agent has a voice clone or an avatar, while
// the orchestrator quietly degraded those very sections to on_screen_only. And
// `brokerages.farm_mail_enabled` is false for both live tenants, so the
// direct-mail half of the sixth claim was equally unbacked. The catalogue gates
// both on real facts rather than on the plan alone.
//
// Deliberately NOT re-declared here as a string: a second copy of this prose is
// exactly the §6 defect, and the whole point is that there is no longer a single
// sentence that is true for every tenant.

export interface AINarrationInput extends NarrationInput {
  /** The composition this narration will be spoken over. Defaults to
   *  SECTION_NARRATION_COMPOSITION; pass another id and the word budget
   *  re-derives from THAT composition's geometry. */
  compositionId?:   string
  /** The agent's own angle / proof points (users.presentation_take). */
  agentTake?:       string | null
  /**
   * What THIS brokerage can actually claim to deliver, composed by
   * lib/listing-presentation/marketing-system-resolver.ts resolveMarketingSystem()
   * from the tenant's real entitlements and account state.
   *
   * NO LONGER OPTIONAL IN PRACTICE — section-render.ts sets it on every call.
   * It stays optional in the TYPE because the deterministic path and the
   * simulators construct inputs without a database, and because the fallback
   * below is the safe one: an absent value composes the CLAIM-FREE floor
   * sentence, never the six-capability boast the retired constant made. See the
   * tombstone above.
   */
  marketingSystem?: string | null
  /** Background market context (never a price): e.g. "rising", "balanced". */
  marketTrend?:     string | null
  avgDaysOnMarket?: number | null
  /**
   * WHO IS ON THE HOOK — the actor a hard fair-housing finding is filed under.
   *
   * §5 has two halves and this producer only ever had one: a high-severity hit
   * returned the deterministic script (right) and told NOBODY (wrong — the only
   * record was a console.warn). Filing the review row needs a users id and the
   * SESSION's brokerage id, which the pure builder and the simulators do not
   * have, so it is optional in the TYPE and its absence is reported LOUDLY
   * rather than treated as "nothing to file" (§4, fail closed: "nobody was
   * summoned" must never render as "nobody needed to be").
   *
   * The caller that has both is lib/listing-presentation/section-render.ts
   * (`pres.brokerage_id`, `pres.agent_user_id`).
   */
  escalationActor?: ScriptComplianceActor | null
}

/**
 * File a hard fair-housing finding on the lane that already exists, and READ
 * WHAT CAME BACK.
 *
 * THE LANE (nothing new is built): lib/video/script-compliance.ts
 * escalateScriptToHumanReview writes video_scripts_library at
 * approval_status='pending_review', which app/actions/marketing-ai-approvals.ts
 * listPendingMarketingAssetsAction already reads and
 * /dashboard/admin/marketing-approvals already renders.
 *
 * ITS OWN try/catch, for the same reason video-render-hold.ts gives: the
 * escalation opens a database connection and can throw outright, and a failure
 * to file the paperwork must never be allowed to change the DISPOSITION it was
 * filed about. The deterministic script ships either way; only the note changes.
 *
 * §3: supabase-js RESOLVES a refusal, so `ok:false` is a real outcome here and
 * is reported as one. An escalation that silently fails to record is worse than
 * none — it reads as handled.
 */
async function escalateSectionScript(args: {
  actor:      ScriptComplianceActor | null | undefined
  sectionKey: string
  script:     string
  redFlags:   string[]
  warnings:   string[]
  budget:     NarrationBudget
}): Promise<{ notes: string[]; reviewId?: string }> {
  const done = (note: string, reviewId?: string) => ({ notes: [note, ...args.redFlags], reviewId })
  if (!args.actor?.userId || !args.actor?.brokerageId) {
    const note =
      `[section-narration] ${args.sectionKey} — HARD fair-housing finding, and NO HUMAN WAS SUMMONED: `
      + `this call supplied no escalationActor, so there is no session brokerage to file `
      + `video_scripts_library under. The deterministic script ships, but nobody is reviewing the model's.`
    console.error(note)
    return done(note)
  }
  try {
    const { escalateScriptToHumanReview } = await import("@/lib/video/script-compliance")
    const filed = await escalateScriptToHumanReview({
      actor:     args.actor,
      script:    args.script,
      // The live CHECK admits five values; toLibraryScriptType maps this one.
      videoType: "listing_presentation",
      title:     `Pre-listing presentation — ${args.sectionKey} section narration (held: Fair Housing)`,
      redFlags:  args.redFlags,
      warnings:  args.warnings,
      holdReason: "fair_housing_red_flag",
      durationTargetSeconds: Math.round(args.budget.compositionSeconds) || undefined,
    })
    if (filed.ok) {
      const note =
        `[section-narration] ${args.sectionKey} — HARD fair-housing finding escalated for human review `
        + `(video_scripts_library ${filed.reviewId}, pending_review). The deterministic script is what the seller hears.`
      console.warn(note)
      return done(note, filed.reviewId)
    }
    const note =
      `[section-narration] ${args.sectionKey} — the review row could NOT be filed (${filed.error}). `
      + `The model's script is still withheld, but no reviewer exists — ask an admin to look at this section directly.`
    console.error(note)
    return done(note)
  } catch (err) {
    const note =
      `[section-narration] ${args.sectionKey} — the review row could NOT be filed `
      + `(${err instanceof Error ? err.message : String(err)}). The model's script is still withheld, `
      + `but no reviewer exists — ask an admin to look at this section directly.`
    console.error(note)
    return done(note)
  }
}

/**
 * The HARD-fair-housing door onto the lane above: pattern hits → red-flag
 * sentences (each carrying the rule's own suggested rewrite and legal
 * reference, so the reviewer is not left to guess what tripped) → the review
 * row. Split out so the disposition branch itself reads in three lines: file
 * it, attach what came back, speak the deterministic script.
 */
async function escalateHardFairHousing(
  input: AINarrationInput,
  script: string,
  hardHits: FairHousingPattern[],
  budget: NarrationBudget,
): Promise<{ notes: string[]; reviewId?: string }> {
  return escalateSectionScript({
    actor:      input.escalationActor,
    sectionKey: input.sectionKey,
    script,
    redFlags:   hardHits.map((v) => `FairHousing: "${v.phrase}" — rewrite as: ${v.fix} (${v.reference})`),
    warnings:   [],
    budget,
  })
}

/**
 * Generate a compelling, personalized, SELLER-SAFE narration script for one
 * section using the platform's metered AI gateway. Weaves the brokerage
 * marketing system, the agent's own take, and market context into as much
 * spoken text as the composition can actually play. Falls back to the
 * deterministic builder on any AI failure, and scrubs any dollar figure the
 * model emits (the no-price rule is absolute).
 *
 * ── LENGTH IS NOW A CONSTRAINT, NOT A HOPE ──────────────────────────────────
 * The prompt asked for "3 to 5 sentences" and the gateway was given 320 tokens,
 * so a typical draft ran 60–80 words ≈ 24–32 spoken seconds against a
 * composition that then ran TEN SECONDS. Two thirds of every section narration
 * was cut off mid-word and nothing anywhere noticed. Both halves are fixed here:
 * the prompt now carries the budget DERIVED from the composition's geometry, and
 * the returned text is measured and trimmed at a sentence boundary if the model
 * ignored it. The deterministic fallback goes through the same trim — it was
 * ~45 words, and it ships exactly when the AI is unavailable.
 *
 * AND THEN THE OTHER HALF: capping a 60–80 word script to 20 words left these
 * sections saying one sentence. m566 widened ListingSectionReel from 300 to 900
 * frames (10s → 30s), which is why the budget now reads 60 words — enough for
 * the 4–5 sentence paragraph the brief below actually asks for, and comfortably
 * over the 33–46 words the deterministic fallbacks run. NOTHING here was
 * retyped to make that happen: the number below is still geometryFor() ×
 * compositionSeconds() and it moved on its own.
 *
 * AND THE THIRD HALF — SOMETHING ACTUALLY READS `stillOverBudget` NOW (§1).
 * `fitNarrationToBudget` has reported it since it was written and this function
 * did what the other two producers did: `console.warn(fit.note)` and shipped the
 * script. A warn is not a reader. ListingSectionReel carries the narration as an
 * <Audio> inside a FIXED durationInFrames, so a first sentence that overruns is
 * cut mid-word in a video already sent to a seller. The policy is now
 * fitNarrationWithOneRedraft: re-draft ONCE at the same budget, and if that
 * still does not fit, speak the DETERMINISTIC script rather than bake a track
 * that gets truncated. Every note it produced comes back on `notes` so the
 * caller can stage it — not only into a log.
 */
export async function generateSectionNarration(input: AINarrationInput): Promise<SectionNarration> {
  const budget = sectionNarrationBudget(input.compositionId ?? SECTION_NARRATION_COMPOSITION)
  const rawFallback = buildSectionNarrationScript(input)
  /** Everything worth recording about this section's draft. Returned, not just logged. */
  const notes: string[] = []
  /** The deterministic script, held to the same budget as the AI's. */
  const fallback = ((): SectionNarration => {
    const fit = fitNarrationToBudget(rawFallback.script, budget)
    if (fit.note) {
      const note = `[section-narration] deterministic fallback — ${fit.note}`
      console.warn(note)
      notes.push(note)
    }
    return { ...rawFallback, script: fit.script }
  })()
  const brief = SECTION_BRIEF[input.sectionKey]
  if (!brief) return notes.length > 0 ? { ...fallback, notes: [...notes] } : fallback

  const agent = (input.agentName || "your agent").trim()
  const brokerage = (input.brokerageName || "our brokerage").trim()
  const us = input.teamName?.trim() ? `${input.teamName.trim()} at ${brokerage}` : brokerage
  const where = input.areaName?.trim() || "your neighborhood"

  const prompt = [
    `You are writing the spoken narration for ${agent}, a real estate agent at ${us}, that their AI avatar will speak in ${agent}'s own cloned voice over ONE section of a pre-listing presentation video sent to a home seller in ${where} BEFORE the listing appointment.`,
    ``,
    `SECTION GOAL: ${brief}`,
    `OVERALL GOAL: Wow the seller and prove why they should list with ${us} over any other local agent — sell the marketing system and the relationship.`,
    input.agentTake?.trim() ? `\nTHE AGENT'S OWN ANGLE (weave in naturally, first person):\n${input.agentTake.trim()}` : ``,
    // ADVERTISING, SPOKEN TO A CONSUMER. Every capability named here is one the
    // resolver proved this tenant is entitled to and has the account state for;
    // an absent value falls to the CLAIM-FREE floor rather than to a boast.
    // The model is told it may not add to the list — the catalogue is authored
    // and reviewed prose, and a model-invented seventh capability would be an
    // unbacked claim in the agent's own cloned voice.
    `\nTHE MARKETING SYSTEM TO SELL — these are the ONLY capabilities you may claim, and you may claim ALL of them:\n${(input.marketingSystem?.trim() || MARKETING_SYSTEM_FLOOR)}`,
    input.marketTrend?.trim() ? `\nMARKET BACKGROUND (context only — never quote a price): the market is ${input.marketTrend.trim()}${input.avgDaysOnMarket ? `, homes averaging about ${input.avgDaysOnMarket} days on market` : ``}.` : ``,
    ``,
    `HARD RULES:`,
    `- NEVER state the seller's home value, a suggested list price, or ANY dollar figure. Defer all pricing to the in-person meeting.`,
    // COMPLIANCE-FIRST (§5): the advertising bound is an INPUT to the writing
    // prompt, not a grade applied afterwards. The claim list was already
    // capability-gated and fair-housing screened before it got here.
    `- NEVER invent a marketing capability. Claim ONLY what THE MARKETING SYSTEM TO SELL lists above — no extra channels, no guarantees, no results promises, no timelines, and no claim about what other agents do or do not do.`,
    `- Fair housing is absolute: describe the HOME and the MARKETING, never the people who live in the area. No reference to who a neighborhood is for, no schools, no "safe", no "family" framing.`,
    `- First person ("I", "my team", "we"), warm, confident, specific to ${where} — not generic.`,
    // WAS "3 to 5 sentences" — a fixed count that no composition duration ever
    // agreed with. The ceiling now comes from ListingSectionReel's own geometry.
    `- ${narrationLengthDirective(budget)} Conversational, meant to be spoken aloud. No bullet points, no markdown, no stage directions, no salutations.`,
    `- This is ${agent} speaking directly to the homeowner.`,
    ``,
    `Write only the narration text.`,
  ].filter(Boolean).join("\n")

  /**
   * Attach the disposition to the DETERMINISTIC result, so `return fallback` is
   * literally what a hold does and the record travels WITH the script rather
   * than only into a log line. `fallback` is this call's own object; nothing
   * outside this function holds a reference to it.
   */
  const attach = (extra: string[] = [], reviewId?: string): SectionNarration => {
    const all = [...notes, ...extra]
    if (all.length > 0) fallback.notes = all
    if (reviewId) { fallback.heldForReview = true; fallback.reviewId = reviewId }
    return fallback
  }

  try {
    const { generateAIText } = await import("@/lib/ai/generate")

    // ── THE OVERRUN IS READ, NOT WARNED ABOUT (§1) ─────────────────────────
    // VERIFY, don't trust: "at most N words" in a prompt is a request, and
    // fitNarrationToBudget is the enforcement. What was MISSING is what happens
    // when the trim cannot get under budget — `stillOverBudget`, i.e. the first
    // sentence alone is longer than the composition. That was warned about and
    // then baked anyway, so the seller heard it cut mid-word. One re-draft, then
    // the deterministic script; the shared policy lives in
    // lib/video/script-structure.ts fitNarrationWithOneRedraft so the two render
    // routes and this producer cannot drift apart (§6).
    const drafted = await fitNarrationWithOneRedraft({
      budget,
      label: `[section-narration] ${input.sectionKey}`,
      deterministic: () => rawFallback.script,
      draft: async ({ previous }) => {
        const { text } = await generateAIText(
          previous ? `${prompt}\n${narrationOverrunRedraftDirective(previous, budget)}` : prompt,
          { maxTokens: narrationMaxTokens(budget), temperature: 0.8, feature: "listing_presentation_narration" },
        )
        let draft = (text ?? "").trim().replace(/^["“]|["”]$/g, "")
        // "The model returned junk" floor. WAS `script.length < 40` — a character
        // literal that would start rejecting VALID output the moment the derived
        // budget dropped below ~7 words, i.e. it fought the cap. Counted in words
        // instead, well under any real budget. An empty fit reads as "nothing to
        // speak" downstream and takes the deterministic path.
        if (spokenWords(draft).length < 3) return fitNarrationToBudget("", budget)
        // Absolute no-price rule — scrub any dollar figure or leaked valuation,
        // BEFORE the fit, so the trim measures the text that will be spoken.
        if (/\$\s?\d/.test(draft) || findSuggestedPriceLeaks({ script: draft }).length > 0) {
          draft = draft.replace(/\$\s?[\d,]+(?:\.\d+)?/g, "the right price")
        }
        return fitNarrationToBudget(draft, budget)
      },
    })
    for (const n of drafted.notes) console.warn(n)
    notes.push(...drafted.notes)
    // "refused" means the composition cannot carry ANY narration; the fallback
    // is already fitted to the same budget, so returning it is honest either way.
    if (drafted.outcome === "refused" || !drafted.script) return attach()
    // The deterministic branch already IS the fallback text — nothing model-
    // authored survived, so there is nothing for the compliance belt to judge.
    if (drafted.outcome === "deterministic") return attach()
    const script = drafted.script

    // ── FAIR-HOUSING BELT, AND THIS PATH HAD NONE ──────────────────────────
    // Measured while wiring the marketing-system function: the price scrub above
    // was the ONLY compliance check on this producer. Every other AI video-script
    // path in the repo goes through runWithComplianceRedraft (listing-promo,
    // intro-video, avatar-explainer, podcast, direct-mail, generate-client-message)
    // — this one goes through neither that nor buildComplianceSystemBlocks, while
    // producing a script SPOKEN IN THE AGENT'S CLONED VOICE to a home seller.
    // The frozen marketing string satisfied nothing by being static; it simply
    // was not model-authored. Now that the prompt composes per-tenant claims, the
    // model's output needs the belt the prompt's braces already assume.
    //
    // §5's disposition, BOTH HALVES. It used to be one: a HARD (high-severity)
    // hit correctly returned the deterministic script — authored copy that cannot
    // carry a protected-class reference — and then told NOBODY. A console.warn is
    // not an escalation; "a tenant's model produced protected-class language in
    // the agent's own cloned voice" is precisely the event a human is supposed to
    // see, and §5 says a hard flag escalates. It now files the review row on the
    // lane that already exists (escalateScriptToHumanReview → video_scripts_library
    // 'pending_review' → app/actions/marketing-ai-approvals.ts), and the filing's
    // own outcome is READ: a refused insert says so rather than reading as handled.
    // Medium/low still ride through as warnings, because escalating those would
    // hold up every presentation — the ruling is explicit that warnings pass.
    //
    // Deliberately the DETERMINISTIC detector as the hard gate rather than a
    // model call: it is pure, it cannot itself fail open, and a fallback is
    // always available here, so refusing costs the seller nothing.
    const fhHits = detectFairHousingViolations(script)
    const hardHits = fhHits.filter((v) => v.severity === "high")
    if (hardHits.length > 0) {
      const filed = await escalateHardFairHousing(input, script, hardHits, budget)
      attach(filed.notes, filed.reviewId)
      return fallback
    }
    const advisory = fhHits
      .map((v) => `FairHousing(${v.severity}): "${v.phrase}" — suggested: ${v.fix} (${v.reference})`)
    if (advisory.length > 0) {
      console.warn(`[section-narration] ${input.sectionKey} — advisory fair-housing finding(s), passing through per §5: ${advisory.join("; ")}`)
      notes.push(...advisory)
    }

    // ── AND THE REST OF THE GATE, WHEN THERE IS AN ACTOR TO RUN IT AS ──────
    // R3's other half: this producer called neither runWithComplianceRedraft nor
    // buildComplianceSystemBlocks nor postcheckScript. The prompt above is now
    // compliance-FIRST in its own right (§5) — fair housing, the no-price rule
    // and the capability bound are all written INTO it — and the deterministic
    // detector above is the hard belt. What was still missing is the brokerage's
    // OWN prohibited-phrase catalogue, brand voice and ThemFirst, plus the
    // compliance_events audit row.
    //
    // WHY assessScriptCompliance AND NOT postcheckScript. postcheckScript is a
    // thin wrapper over it that FLATTENS red flags, warnings and UNKNOWN lines
    // into one string[] — right for the four generators that only display
    // sentences to an agent, wrong here, because this producer HAS a hold lever
    // (the deterministic script) and therefore needs to know which class a
    // finding is in before it can act on it.
    //
    // WHY IT IS GATED ON AN ACTOR. Both the gate and the audit row need a users
    // id and the SESSION's brokerage. The sibling generators are server actions
    // that always have one; this producer is reached from a cron under the
    // service client, so without an actor every section would grade `unknown`
    // and that would be noise, not a finding. When no actor is supplied the
    // pure detector above is still the belt and the model's text is still
    // withheld on any hard hit — so the absence degrades what is CHECKED, never
    // what SHIPS.
    if (input.escalationActor?.userId && input.escalationActor?.brokerageId) {
      try {
        const { assessScriptCompliance } = await import("@/lib/video/script-compliance")
        const verdict = await assessScriptCompliance(input.escalationActor, script, "seller")
        if (verdict.redFlags.length > 0) {
          const filed = await escalateSectionScript({
            actor: input.escalationActor,
            sectionKey: input.sectionKey,
            script, redFlags: verdict.redFlags, warnings: verdict.warnings, budget,
          })
          attach([`Compliance RED FLAG — the model's script is withheld.`, ...filed.notes], filed.reviewId)
          return fallback
        }
        if (verdict.state === "unknown") {
          // FAIL CLOSED, and cheaply. "Nobody could check" is not "checked and
          // fine" (§4). No reviewer is summoned because nothing model-authored
          // ships — the authored fallback needs no human, unlike the generator
          // paths where the unchecked script is what the agent walks away with.
          console.warn(`[section-narration] ${input.sectionKey} — compliance UNKNOWN; speaking the deterministic script instead: ${verdict.unknownReasons.join("; ")}`)
          return attach(verdict.unknownReasons)
        }
        if (verdict.warnings.length > 0) {
          console.warn(`[section-narration] ${input.sectionKey} — advisory compliance finding(s), passing through per §5: ${verdict.warnings.join("; ")}`)
          notes.push(...verdict.warnings)
        }
      } catch (gateErr) {
        // The gate itself threw. Same ruling as the unknown state above.
        const msg = gateErr instanceof Error ? gateErr.message : String(gateErr)
        console.warn(`[section-narration] ${input.sectionKey} — the compliance gate could not run (${msg}); speaking the deterministic script.`)
        return attach([`Compliance gate could not run (${msg}) — deterministic script spoken.`])
      }
    }

    // Bullets stay deterministic (concise, seller-safe on-screen text).
    return {
      sectionKey: input.sectionKey,
      script,
      bullets: fallback.bullets,
      ...(notes.length > 0 ? { notes } : {}),
    }
  } catch {
    return attach()
  }
}
