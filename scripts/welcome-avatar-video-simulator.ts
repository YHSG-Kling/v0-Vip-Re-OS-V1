#!/usr/bin/env tsx
/**
 * scripts/welcome-avatar-video-simulator.ts
 *   (npm run test:welcome-avatar-video)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULING THIS PROVES, VERBATIM:
 *
 *   "i believe automatic content is being sent from the first moment that the
 *    lead becomes a contact like the welcome portal email with a personal avatar
 *    video from the agent.. we only sent content to leads and contacts that are
 *    personalized and situation, them first messaging."
 *
 * THE OWNER SAID "I BELIEVE", AND HE WAS HALF RIGHT. Measured on the live
 * project hrvaqgvukzxfskkcrwbt before this lane:
 *
 *   lifecycle_events where event_type='contact_agent_assigned'   50
 *   agent_intro_videos (ANY status, ANY trigger)                  0
 *   ai_video_projects                                             0
 *   agent_client_messages tagged client_welcome_v1                0
 *
 * Fifty assignment events and not one video row — not even a 'suppressed' or a
 * 'failed' one, both of which the reactor writes before it spends anything. So
 * the portal invite was real and the PERSONAL AVATAR VIDEO had never been
 * produced for anybody. This file is the proof that the missing half is now
 * wired, and — more importantly — the proof that it is wired the way the
 * rulings require rather than merely present.
 *
 * ── FIVE THINGS ARE UNDER TEST, AND THEY PULL AGAINST EACH OTHER ────────────
 *
 *   (A) SITUATIONAL, THEM-FIRST. A welcome that opens "Hi there, great to have
 *       you" is the defect. The script must be built from what the CONTACT row
 *       already knows.
 *   (B) COMPLIANCE-FIRST (§5). Fair housing reaches the WRITING prompt, not
 *       only a post-hoc scan. A welcome video naming a market is exactly where
 *       this bites. Warnings ride through; only a HARD flag is treated as hard.
 *   (C) IT MUST NOT BLOCK THE PORTAL, AND MUST NOT UNWIND A CONVERSION. The
 *       tail is best-effort by construction.
 *   (D) IT MUST NOT SEND — OR BILL — TWICE. `ai_tool_usage` is the cost ledger
 *       and it feeds an invoice.
 *   (E) BOTH CONVERSION LANES, ONE FUNCTION (§6).
 *
 * ── HOW THIS PROOF IS BUILT ─────────────────────────────────────────────────
 *
 * BEHAVIOUR FIRST. Sections 1–2 run the REAL `buildWelcomeSituation` and the
 * REAL `ensureWelcomeAvatarVideo`; only the avatar spine and the Supabase
 * client are stubbed, so the production functions decide and the stub records
 * what they decided. Nothing is generated and nothing is rendered — no paid
 * provider is touched, which is the standing rule for this tree. The spine call
 * is ASSERTED, not performed.
 *
 * Sections 3–5 assert CONSTRUCTS behaviour cannot see: the ORDER of steps
 * inside two source files. Order is the whole of (C) and (D) — a video call
 * placed before the portal grant, or a model draft placed before the
 * idempotency ledger, is correct-looking code that costs a contact their portal
 * or a brokerage a duplicate invoice.
 *
 * Section 6 is the POSITIVE CONTROL for sections 3–5 (CLAUDE.md §2: a broken
 * regex and a clean tree both report zero). Every source assertion is re-run
 * against an IN-MEMORY copy of the file with the defect re-introduced, and the
 * check fails if the finder still passes. Nothing on disk is modified — other
 * lanes are editing this tree concurrently.
 *
 * ── MEASUREMENT DISCIPLINE (§2) ─────────────────────────────────────────────
 * Every source scan reads COMMENT-STRIPPED source via scripts/strip-comments.
 * These files quote their own defects at length — the tombstones and the
 * rulings are meant to stay — so a raw-source scan would count a comment naming
 * `draftScript` as a call site and grade the tree on its own documentation.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { stripComments } from "./strip-comments"
import {
  buildWelcomeSituation,
  describeDroppedFacts,
  TIMELINE_BUCKET_PHRASE,
  WELCOME_FAIR_HOUSING_DIRECTIVES,
} from "../lib/contact-promotion/welcome-situation"

const ROOT = process.cwd()
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8")
/** Comment-stripped source. Load-bearing — see the header. */
const code = (p: string) => stripComments(raw(p))

const REACTOR = "lib/video/intro-video-reactor.ts"
const MANUAL = "lib/contact-promotion/promote-lead-to-contact.ts"
const AUTO = "lib/kernel/lead-acquisition-handlers.ts"
const ENSURE = "lib/contact-promotion/welcome-avatar-video.ts"
/**
 * THE SHARED CONVERSION ENTRY POINT — added 2026-08-25 when the welcome
 * consolidated onto ONE email (owner ruling: "the welcome email is the first on
 * conversion that has the welcome with portal info to also inclue the embedded
 * personal video").
 *
 * THIS IS A WAYPOINT REPAIR, NOT A WEAKENING (CLAUDE.md §2). Section 5 used to
 * assert that the video call and the portal grant appeared, in that order, INSIDE
 * `lib/contact-promotion/promote-lead-to-contact.ts` — i.e. it pinned the RULE
 * ("the grant survives a failed video", "both lanes get the video, neither holds
 * a copy") to the FILE the calls happened to live in. Both calls moved together
 * into the one entry point both lanes now share, which is the §6 outcome this
 * simulator's own 5.2 exists to push toward — so the assertions follow them
 * rather than reporting the consolidation as a regression. The rule is unchanged
 * and every control below still re-injects the real defect.
 */
const SHARED = "lib/contact-promotion/conversion-welcome.ts"

let pass = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail?: string): boolean {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fails.push(name); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
  return cond
}

// ═════════════════════════════════════════════════════════════════════════════
// EDGE INTERCEPTION — so the REAL ensure runs against a spine we control.
//
// The spine is `server-only` and would submit a D-ID render. It is replaced by
// a recorder: the call is ASSERTED, never performed. No paid provider is
// reached from this file, by construction and not by luck.
// ═════════════════════════════════════════════════════════════════════════════

interface SpineCall {
  brokerageId: string
  contactId: string
  agentId: string
  delivery?: string
  situation?: { facts: string[]; complianceDirectives: string[] }
}

const SPINE: {
  calls: SpineCall[]
  answer: () => Promise<any>
} = { calls: [], answer: async () => ({ ok: true, status: "rendering", videoProjectId: "vp-1" }) }

;(globalThis as any).__WAV_SPINE = {
  dispatchAssignmentIntroVideo: async (input: SpineCall) => {
    SPINE.calls.push(input)
    return SPINE.answer()
  },
}

registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    if (spec === "server-only") return { url: "data:text/javascript,export{}", shortCircuit: true }
    if (spec === "@/lib/video/intro-video-reactor") {
      return {
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "export const dispatchAssignmentIntroVideo = (...a) => globalThis.__WAV_SPINE.dispatchAssignmentIntroVideo(...a)",
          ),
        shortCircuit: true,
      }
    }
    return next(spec, ctx)
  },
})

/** A minimal `contacts` reader. Mirrors supabase-js: a refusal RESOLVES. */
function contactsClient(answer: { data: any; error: any }, opts?: { expectTenant?: string }) {
  const seen: { table?: string; eqs: Array<[string, any]> } = { eqs: [] }
  const client = {
    seen,
    from(table: string) {
      seen.table = table
      const b: any = {
        select: () => b,
        eq: (col: string, val: any) => { seen.eqs.push([col, val]); return b },
        maybeSingle: async () => {
          if (opts?.expectTenant) {
            const tenant = seen.eqs.find(([c]) => c === "brokerage_id")?.[1]
            if (tenant !== opts.expectTenant) return { data: null, error: null }
          }
          return answer
        },
      }
      return b
    },
  }
  return client
}

const RICH_CONTACT = {
  id: "c-1",
  contact_type: "buyer",
  contact_persona: "first_time",
  timeline: "3-6_months",
  city: "Tampa",
  state: "FL",
  property_type: "single_family",
  budget_min: 350000,
  budget_max: 480000,
  beds: 3,
  video_opt_out: false,
}

async function main() {
  const { ensureWelcomeAvatarVideo, WELCOME_VIDEO_EXCLUDED_CONTACT_TYPES } = await import(
    "../lib/contact-promotion/welcome-avatar-video"
  )

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n[1 · THE SITUATION — personalized, situational, them-first (PURE)]")
  // ═══════════════════════════════════════════════════════════════════════════

  const rich = buildWelcomeSituation(RICH_CONTACT)
  check(
    "1.1 a contact the CRM knows produces situational facts, not a generic hello",
    rich.isSituational && rich.facts.length >= 5,
    `facts=${JSON.stringify(rich.facts)}`,
  )
  check(
    "1.2 …and every fact is written from THEIR side of the table (them-first)",
    rich.facts.every((f) => /\bthey\b|\bthem\b|\btheir\b|\byou\b/i.test(f)),
    JSON.stringify(rich.facts),
  )
  check(
    "1.3 the buying/selling side is stated — it changes the whole shape of the script",
    rich.facts.some((f) => /they are buying/i.test(f)),
  )

  // TIMELINE STAYS IN BUCKETS (§5: 1-3 / 3-6 / 6-12, never 30/60/90).
  check(
    "1.4 the timeline vocabulary is the live CHECK's buckets and nothing else",
    Object.keys(TIMELINE_BUCKET_PHRASE).sort().join(",") ===
      ["1-3_months", "12+_months", "3-6_months", "6-12_months", "immediate", "researching"].sort().join(","),
    Object.keys(TIMELINE_BUCKET_PHRASE).join(","),
  )
  check(
    "1.5 …and no bucket is ever spelled in days (§5 forbids 30/60/90)",
    !Object.values(TIMELINE_BUCKET_PHRASE).some((p) => /\b(30|60|90)\b/.test(p)),
  )
  const outOfVocab = buildWelcomeSituation({ ...RICH_CONTACT, timeline: "45_days" })
  check(
    "1.6 an out-of-vocabulary timeline yields NO timing fact — a guess is worse than silence",
    !outOfVocab.facts.some((f) => /timing/i.test(f)) &&
      outOfVocab.warnings.some((w) => w.includes("45_days")),
    JSON.stringify(outOfVocab.warnings),
  )

  // ── (B) COMPLIANCE-FIRST, WITH BOTH SIDES OF THE CONTROL ──────────────────
  console.log("\n[1b · compliance-first — the rules are an INPUT, and the finder works both ways]")

  check(
    "1.7 the fair-housing floor is present on EVERY situation, even an empty one",
    buildWelcomeSituation({}).complianceDirectives.length === WELCOME_FAIR_HOUSING_DIRECTIVES.length &&
      WELCOME_FAIR_HOUSING_DIRECTIVES.length >= 4,
  )
  check(
    "1.8 …and it is phrased as a WRITING instruction, not a grading rubric",
    WELCOME_FAIR_HOUSING_DIRECTIVES.some((d) => /what you WRITE, not a review afterwards/i.test(d)),
  )

  // GEOGRAPHY: the exact place the ruling says this bites.
  check(
    "1.9 naming the market IS allowed — that is the personalisation, not the risk",
    rich.facts.some((f) => f.includes("Tampa, FL")),
  )
  check(
    "1.10 …but a named market forces its own steering ban into the prompt",
    rich.complianceDirectives.some(
      (d) => d.includes("Tampa, FL") && /neighbourhood|school|safety/i.test(d) && /may NOT characterise/i.test(d),
    ),
    JSON.stringify(rich.complianceDirectives.slice(-1)),
  )
  check(
    // Asserted through buildWelcomeSituation's real output, not against an
    // exported helper: an export whose only caller is a proof is a surface
    // nobody asked for, and orphan-export-guard flags it as one.
    "1.11 …naming the place while saying nothing about its people is stated explicitly",
    rich.complianceDirectives.some((d) => d.includes("say nothing about its people")),
  )
  check(
    "1.12 schools/community/safe are named as the steering proxies they are",
    WELCOME_FAIR_HOUSING_DIRECTIVES.some((d) => /school/i.test(d) && /safety|crime/i.test(d)),
  )

  // POSITIVE CONTROL (§2): prove the finder still recognises the defect.
  const hard = buildWelcomeSituation({ ...RICH_CONTACT, contact_persona: "perfect for families" })
  check(
    "1.13 POSITIVE CONTROL — a HARD fair-housing phrase in the CRM is DROPPED before the prompt",
    hard.droppedFacts.length === 1 &&
      hard.droppedFacts[0].field === "contact_persona" &&
      !hard.facts.some((f) => /perfect for families/i.test(f)),
    JSON.stringify({ dropped: hard.droppedFacts, facts: hard.facts }),
  )
  check(
    "1.14 …and the drop is REPORTED with the fix, never silent",
    describeDroppedFacts(hard.droppedFacts)[0].includes("Fix the CRM wording"),
  )
  // THE OTHER SIDE OF THE CONTROL — a finder that drops everything reads clean too.
  check(
    "1.15 NEGATIVE CONTROL — a clean persona is NOT dropped (the screen is not a shredder)",
    rich.droppedFacts.length === 0 && rich.facts.some((f) => f.includes("first_time")),
  )
  // §5: warnings pass through; only a HARD flag is treated as hard.
  const soft = buildWelcomeSituation({ ...RICH_CONTACT, contact_persona: "quiet neighborhood" })
  check(
    "1.16 an ADVISORY fair-housing phrase RIDES THROUGH as a warning (§5), it is not dropped",
    soft.droppedFacts.length === 0 &&
      soft.warnings.some((w) => /advisory fair-housing/i.test(w)) &&
      soft.facts.some((f) => /quiet neighborhood/i.test(f)),
    JSON.stringify({ dropped: soft.droppedFacts, warnings: soft.warnings }),
  )
  // Bed count must never become a familial-status inference.
  check(
    "1.17 a bed count is stated as a requirement, with speculation about occupants forbidden",
    rich.facts.some((f) => /3 bedrooms/.test(f) && /do not speculate about who the rooms are for/i.test(f)),
  )
  check(
    "1.18 a budget is acknowledged but promises nothing (no price/value claims)",
    rich.facts.some((f) => /promise nothing about what it buys/i.test(f)),
  )
  check(
    "1.19 a contact the CRM knows NOTHING about produces no invented detail",
    buildWelcomeSituation({}).facts.length === 0 && buildWelcomeSituation({}).isSituational === false,
  )
  check(
    "1.20 …and null/undefined never throws (the tail must not care)",
    buildWelcomeSituation(null).facts.length === 0 && buildWelcomeSituation(undefined).isSituational === false,
  )

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n[2 · THE ENSURE — real function, spine asserted not performed]")
  // ═══════════════════════════════════════════════════════════════════════════

  const P = { contactId: "c-1", agentId: "a-1", brokerageId: "b-1" }

  // 2a. THE HAPPY PATH — and what actually reaches the spine.
  SPINE.calls = []
  SPINE.answer = async () => ({ ok: true, status: "rendering", videoProjectId: "vp-9" })
  const okRun = await ensureWelcomeAvatarVideo(
    contactsClient({ data: RICH_CONTACT, error: null }, { expectTenant: "b-1" }) as any,
    P,
  )
  check(
    "2.1 a healthy conversion commissions the video and reports the project id",
    okRun.commissioned && okRun.reason === "commissioned" && okRun.videoProjectId === "vp-9",
    JSON.stringify(okRun),
  )
  check(
    "2.2 it is SITUATIONAL — the facts the CRM knows actually reach the spine",
    SPINE.calls.length === 1 &&
      (SPINE.calls[0].situation?.facts.length ?? 0) >= 5 &&
      okRun.situational === true,
    JSON.stringify(SPINE.calls[0]?.situation?.facts),
  )
  check(
    "2.3 …and the compliance directives ride WITH them (compliance-first, §5)",
    (SPINE.calls[0].situation?.complianceDirectives.length ?? 0) > WELCOME_FAIR_HOUSING_DIRECTIVES.length,
    JSON.stringify(SPINE.calls[0]?.situation?.complianceDirectives?.length),
  )
  check(
    "2.4 delivery is BOTH — the ruling asks for the clip in the email AND the portal",
    SPINE.calls[0].delivery === "both",
  )
  check(
    "2.5 the agents-class id is passed straight through (agents.id ≠ users.id)",
    SPINE.calls[0].agentId === "a-1",
  )

  // 2b. THE TENANT. Reads are PINNED, never trusted from the row.
  const tenantClient = contactsClient({ data: RICH_CONTACT, error: null }, { expectTenant: "b-1" })
  SPINE.calls = []
  const wrongTenant = await ensureWelcomeAvatarVideo(tenantClient as any, { ...P, brokerageId: "b-OTHER" })
  check(
    "2.6 a cross-tenant contact id commissions NOTHING and says why",
    !wrongTenant.commissioned &&
      SPINE.calls.length === 0 &&
      wrongTenant.warnings.some((w) => w.includes("is not in brokerage")),
    JSON.stringify(wrongTenant),
  )
  check(
    "2.7 …and the read carried the brokerage predicate on the query itself",
    tenantClient.seen.eqs.some(([c]) => c === "brokerage_id"),
    JSON.stringify(tenantClient.seen.eqs),
  )

  // 2c. supabase-js RESOLVES refusals. A refused read is not "no such contact".
  SPINE.calls = []
  const refused = await ensureWelcomeAvatarVideo(
    contactsClient({ data: null, error: { message: "RLS refused" } }) as any,
    P,
  )
  check(
    "2.8 a REFUSED contact read is read, reported, and spends nothing",
    !refused.commissioned &&
      SPINE.calls.length === 0 &&
      refused.warnings.some((w) => w.includes("RLS refused") && w.includes("Nothing was spent")),
    JSON.stringify(refused),
  )

  // 2d. THE CONTACT'S OWN CHOICE.
  SPINE.calls = []
  const optOut = await ensureWelcomeAvatarVideo(
    contactsClient({ data: { ...RICH_CONTACT, video_opt_out: true }, error: null }) as any,
    P,
  )
  check(
    "2.9 video_opt_out refuses BEFORE the spine — their choice costs nothing",
    optOut.reason === "video_opt_out" && SPINE.calls.length === 0,
  )
  check(
    "2.10 …and it says the portal invite is unaffected (the video must never cost them the portal)",
    optOut.warnings.some((w) => /portal invite is unaffected/i.test(w)),
  )

  // 2e. A COUNTERPARTY IS NOT A CLIENT.
  for (const t of WELCOME_VIDEO_EXCLUDED_CONTACT_TYPES) {
    SPINE.calls = []
    const ex = await ensureWelcomeAvatarVideo(
      contactsClient({ data: { ...RICH_CONTACT, contact_type: t }, error: null }) as any,
      P,
    )
    check(
      `2.11 contact_type '${t}' gets no personal welcome video, and no spend`,
      ex.reason === "excluded_contact_type" && SPINE.calls.length === 0,
    )
  }
  for (const t of ["buyer", "seller", "investor", "prospect", "both"]) {
    check(
      `2.12 contact_type '${t}' is NOT excluded from the welcome video`,
      !WELCOME_VIDEO_EXCLUDED_CONTACT_TYPES.includes(t),
    )
  }

  // 2f. IDEMPOTENCY, WHICH IS A BILLING PROPERTY (§5).
  SPINE.calls = []
  SPINE.answer = async () => ({ ok: true, status: "already_queued", reason: "duplicate trigger" })
  const dedup = await ensureWelcomeAvatarVideo(contactsClient({ data: RICH_CONTACT, error: null }) as any, P)
  check(
    "2.13 a RETRIED conversion reports already_commissioned, not a second commission",
    dedup.commissioned === true && dedup.reason === "already_commissioned",
    JSON.stringify(dedup),
  )

  // 2g. FAIL CLOSED ON THE VIDEO, NEVER ON THE CONVERSION.
  SPINE.calls = []
  SPINE.answer = async () => { throw new Error("D-ID exploded") }
  const boom = await ensureWelcomeAvatarVideo(contactsClient({ data: RICH_CONTACT, error: null }) as any, P)
  check(
    "2.14 a THROWN spine never propagates — the conversion is already committed",
    boom.commissioned === false &&
      boom.reason === "unavailable" &&
      boom.warnings.some((w) => w.includes("D-ID exploded") && /portal invite is unaffected/i.test(w)),
    JSON.stringify(boom),
  )

  SPINE.answer = async () => ({ ok: false, status: "failed", reason: "agent voice/avatar profile not configured" })
  const notReady = await ensureWelcomeAvatarVideo(contactsClient({ data: RICH_CONTACT, error: null }) as any, P)
  check(
    "2.15 'the agent has no avatar yet' is a SETUP TASK, told as one — not an incident",
    notReady.reason === "agent_not_video_ready" &&
      notReady.warnings.some((w) => /Settings → Voice & Avatar/.test(w)),
    JSON.stringify(notReady),
  )
  check(
    "2.16 …and it never promises a recording the agent did not make",
    notReady.warnings.some((w) => /without a video block rather than promising/i.test(w)),
  )

  SPINE.answer = async () => ({
    ok: false, status: "failed", reason: "compliance violations on both initial draft and redraft",
    violations: ["FairHousing: protected class reference"],
  })
  const blocked = await ensureWelcomeAvatarVideo(contactsClient({ data: RICH_CONTACT, error: null }) as any, P)
  check(
    "2.17 a hard compliance refusal comes back as a WARNING with the violations, never a throw",
    blocked.reason === "refused" &&
      blocked.warnings.some((w) => w.includes("FairHousing: protected class reference")),
    JSON.stringify(blocked),
  )

  // A HARD CRM PHRASE reaches the conversion's warning list, so a human sees it.
  SPINE.calls = []
  SPINE.answer = async () => ({ ok: true, status: "rendering", videoProjectId: "vp-2" })
  const dirty = await ensureWelcomeAvatarVideo(
    contactsClient({ data: { ...RICH_CONTACT, contact_persona: "no children" }, error: null }) as any,
    P,
  )
  check(
    "2.18 a HARD phrase in the CRM row surfaces on the conversion's warnings for a human",
    dirty.warnings.some((w) => w.startsWith("HARD fair-housing phrase")),
    JSON.stringify(dirty.warnings),
  )
  check(
    "2.19 …and the offending text NEVER reaches the writing prompt",
    !JSON.stringify(SPINE.calls[0]?.situation?.facts ?? []).includes("no children"),
    JSON.stringify(SPINE.calls[0]?.situation?.facts),
  )

  // Missing inputs must not reach the spine at all.
  SPINE.calls = []
  const noAgent = await ensureWelcomeAvatarVideo(contactsClient({ data: RICH_CONTACT, error: null }) as any, {
    ...P, agentId: "",
  })
  check(
    "2.20 a missing agent id spends nothing and names the missing field",
    SPINE.calls.length === 0 && noAgent.warnings.some((w) => w.includes("missing agentId")),
  )

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n[3 · COMPLIANCE-FIRST INSIDE THE SPINE — the prompt, not the scan]")
  // ═══════════════════════════════════════════════════════════════════════════
  const reactor = code(REACTOR)

  check("3.1 the reactor accepts a situation on the assignment-intro input", checkSituationInput(reactor))
  check("3.2 the situation is rendered into the WRITING prompt", checkSituationInPrompt(reactor))
  check("3.3 the compliance directives are rendered into the WRITING prompt", checkDirectivesInPrompt(reactor))
  check(
    "3.4 the prompt-side blocks are built BEFORE the model call, not after it",
    checkPromptBeforeModel(reactor),
  )
  check(
    "3.5 the pre-flight evaluateOutbound gate + redraft still runs (the prompt does not replace it)",
    /runWithComplianceRedraft/.test(reactor) && /evaluateOutbound/.test(reactor),
  )
  check(
    "3.6 a script that fails BOTH draft and redraft still refuses to spend render credit",
    /compliance violations on both initial draft and redraft/.test(reactor),
  )

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n[4 · THE SPEND IS DELIBERATE AND LEDGERED (§5 — a wrong number is a wrong invoice)]")
  // ═══════════════════════════════════════════════════════════════════════════
  check("4.1 the script draft books its tenant, so ai_tool_usage is written", checkDraftBooksTenant(reactor))
  check(
    "4.2 the ledger gate really is `if (request.brokerageId)` — this is why 4.1 matters",
    /if\s*\(\s*request\.brokerageId\s*\)/.test(code("lib/ai/models.ts")),
  )
  check(
    "4.3 the REDRAFT is booked too — it is a second billable call",
    checkRedraftBooksTenant(reactor),
  )
  check(
    "4.4 the id classes are not crossed (ai_tool_usage.agent_id→agents, user_id→users)",
    /agentId:\s*args\.agentRecordId/.test(reactor) && /userId:\s*args\.agentUserId/.test(reactor),
  )

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n[5 · ORDER — the portal survives, and a retry costs nothing]")
  // ═══════════════════════════════════════════════════════════════════════════
  const manual = code(MANUAL)
  const auto = code(AUTO)
  const shared = code(SHARED)

  check("5.1 the MANUAL lane reaches the shared ensure (through the one conversion entry point)",
    /deliverConversionWelcome\s*\(/.test(manual) && /ensureWelcomeAvatarVideo\s*\(/.test(shared))
  check("5.2 the AUTOMATIC lane reaches the SAME shared ensure (§6 — neither holds a copy)",
    /deliverConversionWelcome\s*\(/.test(auto) && /ensureWelcomeAvatarVideo\s*\(/.test(shared))
  check(
    "5.2b NEITHER lane holds its own copy of the call — one entry point, no drift",
    !/ensureWelcomeAvatarVideo\s*\(/.test(manual) && !/ensureWelcomeAvatarVideo\s*\(/.test(auto),
  )
  check(
    "5.3 nothing on the conversion path reaches the avatar spine directly (one commissioning path)",
    !/dispatchAssignmentIntroVideo/.test(manual) && !/dispatchAssignmentIntroVideo/.test(auto)
    && !/dispatchAssignmentIntroVideo/.test(shared),
  )
  check("5.4 the video runs AFTER the portal grant, so it can never cost a contact their portal",
    checkVideoAfterPortal(shared))
  check(
    "5.5 the video result is folded into WARNINGS, never thrown (a failure cannot unwind a conversion)",
    checkVideoNeverThrows(shared),
  )
  check(
    "5.6 the idempotency ledger insert precedes the model draft — a retry spends NOTHING",
    checkLedgerBeforeDraft(reactor),
  )
  check(
    "5.7 the conversion's own marker still short-circuits a re-promotion before any of this",
    /if\s*\(\s*lead\.contact_id\s*\)/.test(manual),
  )
  check(
    "5.8 the ensure reads the CONTACT and never the lead (§5 — conversion is FINAL)",
    checkReadsContactNotLead(code(ENSURE)),
  )

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n[6 · POSITIVE CONTROLS — re-introduce each defect in memory, prove the finder sees it]")
  // ═══════════════════════════════════════════════════════════════════════════
  // §2: a broken regex and a clean tree both report zero. Every check in
  // sections 3–5 is re-run against a mutated copy and MUST fail.

  check(
    "6.1 situation dropped from the input type → 3.1 goes red",
    !checkSituationInput(reactor.replace(/situation\?:\s*ScriptSituation/g, "")),
  )
  check(
    "6.2 situation block removed from the prompt → 3.2 goes red",
    !checkSituationInPrompt(reactor.replace(/\$\{situationBlock\}/g, "")),
  )
  check(
    "6.3 compliance block removed from the prompt → 3.3 goes red",
    !checkDirectivesInPrompt(reactor.replace(/\$\{complianceBlock\}/g, "")),
  )
  check(
    "6.4 blocks built AFTER the model call → 3.4 goes red",
    !checkPromptBeforeModel(reactor.replace(/const situationBlock/, "const zzUnusedBlock")),
  )
  check(
    "6.5 brokerageId dropped from the draft call → 4.1 goes red (unbilled spend)",
    !checkDraftBooksTenant(reactor.replace(/brokerageId:\s*args\.brokerageId\s*\?\?\s*null,/, "")),
  )
  check(
    "6.6 brokerageId dropped from the redraft → 4.3 goes red",
    !checkRedraftBooksTenant(reactor.replace(/brokerageId:\s*input\.brokerageId,\n\s*agentUserId,\n\s*agentRecordId,\n\s*isNewsletterSubscriber,/, "isNewsletterSubscriber,")),
  )
  check(
    "6.7 the video moved ABOVE the portal grant → 5.4 goes red",
    // The markers are the CALL sites, not the bare names: the entry point
    // imports `grantPortalAccessForPromotedContact` at the top of the file, so
    // swapping on the bare name inverts the import line and leaves the calls in
    // their original order — a mutation that mutates nothing, which would have
    // reported this control as passing while proving nothing.
    !checkVideoAfterPortal(
      swapOrder(shared, "grantPortalAccessForPromotedContact(supabase", "ensureWelcomeAvatarVideo(supabase"),
    ),
  )
  check(
    "6.8 the video result thrown instead of warned → 5.5 goes red",
    !checkVideoNeverThrows(
      shared.replace(
        /warnings\.push\(\.\.\.video\.warnings\)/,
        "if (!video.commissioned) throw new Error(video.reason ?? '')",
      ),
    ),
  )
  {
    // The mutation must be the REAL hoist. See hoistDraftAboveLedger for the
    // token-swap version that mutated nothing and reported this control green
    // while the on-disk defect was live.
    const hoisted = hoistDraftAboveLedger(reactor)
    check(
      "6.9a the hoist mutation actually moved something (a no-op control proves nothing)",
      hoisted !== reactor,
      "the anchors in hoistDraftAboveLedger have drifted — this control is inert",
    )
    check(
      "6.9b the model draft moved ABOVE the idempotency ledger → 5.6 goes red (a retry bills twice)",
      !checkLedgerBeforeDraft(hoisted),
    )
  }
  check(
    "6.10 the ensure reaching back to `leads` → 5.8 goes red (§5 conversion is FINAL)",
    !checkReadsContactNotLead(code(ENSURE).replace('.from("contacts")', '.from("leads")')),
  )
  check(
    "6.11 the AUTOMATIC lane losing its call → 5.2 goes red (the drift this exists to prevent)",
    !/deliverConversionWelcome\s*\(/.test(auto.replace(/deliverConversionWelcome/g, "somethingElse")),
  )
  check(
    "6.12 a lane re-growing its OWN copy of the video call → 5.2b goes red",
    !(!/ensureWelcomeAvatarVideo\s*\(/.test(manual + "\nawait ensureWelcomeAvatarVideo(supabase, {})")
      && !/ensureWelcomeAvatarVideo\s*\(/.test(auto)),
  )

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fails.length} failed`)
  if (fails.length > 0) {
    for (const f of fails) console.log(`   - ${f}`)
    console.log(" ❌ WELCOME_AVATAR_VIDEO_FAIL — a generic welcome, an unbilled render, or a video that can cost a contact their portal")
    process.exit(1)
  }
  console.log(" ✅ WELCOME_AVATAR_VIDEO_PASS — a newly converted contact gets a personal avatar video from")
  console.log("    THEIR agent, written from their own situation with fair housing in the writing prompt;")
  console.log("    both conversion lanes call the one function; a failure warns instead of unwinding; and a")
  console.log("    retried conversion is deduped before anything is generated or billed.")
}

// ─── The finders. Named so section 6 can re-run each against a mutated copy. ──
//
// Each takes SOURCE, so the same function grades the real file and the injected
// defect. A finder that only works on disk cannot be positive-controlled.

function checkSituationInput(src: string): boolean {
  return /interface\s+AssignmentIntroInput[\s\S]{0,300}?situation\?:\s*ScriptSituation/.test(src)
}

/** Is the situation rendered INTO the assignment prompt string? */
function checkSituationInPrompt(src: string): boolean {
  const prompt = assignmentPrompt(src)
  return prompt !== null && prompt.includes("${situationBlock}")
}

function checkDirectivesInPrompt(src: string): boolean {
  const prompt = assignmentPrompt(src)
  return prompt !== null && prompt.includes("${complianceBlock}")
}

/** The `contact_agent_assigned` branch of basePrompt, or null. */
function assignmentPrompt(src: string): string | null {
  const m = /const basePrompt = args\.trigger === "contact_agent_assigned"\s*\?\s*`([\s\S]*?)`\s*:/.exec(src)
  return m ? m[1] : null
}

/**
 * Both blocks must be BUILT before the prompt is assembled and the model is
 * called. §5's whole point: the rules inform the writing, they are not applied
 * to the result.
 */
function checkPromptBeforeModel(src: string): boolean {
  const sit = src.indexOf("const situationBlock")
  const comp = src.indexOf("const complianceBlock")
  const base = src.indexOf("const basePrompt")
  const call = src.indexOf("generateTextRouted({")
  if (sit < 0 || comp < 0 || base < 0 || call < 0) return false
  return sit < base && comp < base && base < call
}

/** The draft call books the tenant, so lib/ai/models.ts writes ai_tool_usage. */
function checkDraftBooksTenant(src: string): boolean {
  const m = /generateTextRouted\(\{([\s\S]*?)\}\)/.exec(src)
  return m !== null && /brokerageId:\s*args\.brokerageId/.test(m[1])
}

/** The redraft closure passes the tenant through too. */
function checkRedraftBooksTenant(src: string): boolean {
  const m = /draft:\s*\(\{\s*violations\s*\}\)\s*=>\s*draftScript\(\{([\s\S]*?)\}\)/.exec(src)
  return m !== null && /brokerageId:\s*input\.brokerageId/.test(m[1])
}

/** The video call sits AFTER the portal grant in the manual tail. */
function checkVideoAfterPortal(src: string): boolean {
  const portal = src.indexOf("grantPortalAccessForPromotedContact(supabase")
  const video = src.indexOf("ensureWelcomeAvatarVideo(supabase")
  return portal >= 0 && video >= 0 && portal < video
}

/**
 * The video result is warned about, never thrown, in the conversion tail.
 *
 * The result variable is matched as `\w+` rather than by its name: the call moved
 * from the manual lane (where it was `welcomeVideo`) into the shared entry point
 * (where it is `video`), and pinning a finder to a local identifier is the same
 * waypoint mistake as pinning it to a file.
 */
function checkVideoNeverThrows(src: string): boolean {
  const at = src.indexOf("ensureWelcomeAvatarVideo(supabase")
  if (at < 0) return false
  // The window from the call to the end of the step. A `throw` anywhere in it
  // turns a best-effort tail into a rollback.
  const window = src.slice(at, at + 700)
  return /warnings\.push\(\.\.\.\w+\.warnings\)/.test(window) && !/\bthrow\b/.test(window)
}

/**
 * The idempotency ledger insert must precede the model draft, or a retried
 * conversion pays for a script it then throws away.
 *
 * ── WHY THIS IS ANCHORED ON 23505 AND NOT ON THE TABLE NAME ─────────────────
 * The first version searched for `from("agent_intro_videos")` and compared its
 * index to the draft's. It reported GREEN against a tree where the draft had
 * actually been hoisted above the ledger — the exact defect it was written to
 * catch — because `agent_intro_videos` is written THREE times in this file and
 * `indexOf` found the FIRST: the `video_opt_out` suppression insert at step 2,
 * which sits above the draft no matter where the ledger goes. The finder was
 * measuring a row that has nothing to do with idempotency, and the in-memory
 * control was fooled the same way, so both halves agreed on a wrong answer.
 * That is CLAUDE.md §2's "a guard that cannot see the code it judges" in its
 * purest form, and it was only caught because the mutation was also applied ON
 * DISK and the simulator re-run.
 *
 * The unique-violation branch is the only thing in the file that IS the
 * idempotency gate — it is what turns the partial unique index
 * `uq_agent_intro_videos_per_trigger` into an 'already_queued' return — so it
 * is what the ordering is measured against.
 */
function checkLedgerBeforeDraft(src: string): boolean {
  const dedup = src.indexOf('"23505"')
  const draft = firstDraftCallSite(src)
  return dedup >= 0 && draft >= 0 && dedup < draft
}

/**
 * WHERE THE FIRST MODEL CALL HAPPENS — derived, not pinned to one spelling.
 *
 * This used to search for the literal `script = await draftScript(`, which was
 * the assignment form of a SEPARATE pre-draft step that has since been deleted:
 * runWithComplianceRedraft makes the first draft itself, so that call bought a
 * script the reactor threw away and billed the tenant for it. The moment the
 * waste was removed, an assertion pinned to its spelling reported the ledger
 * ordering as BROKEN — CLAUDE.md §2's "do not pin an assertion to a WAYPOINT",
 * failing because the work finished.
 *
 * The RULE is "no draftScript call may precede the dedupe branch", so the finder
 * takes the EARLIEST call site of any spelling and refuses to pass when there is
 * none at all (a rename must go red, not silently green).
 *
 * The function DEFINITION (`async function draftScript(args:`) is excluded — it
 * sits below the runner and is not a call.
 */
function firstDraftCallSite(src: string): number {
  let earliest = -1
  const re = /(?<!function\s)draftScript\(\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    if (earliest < 0 || m.index < earliest) earliest = m.index
  }
  return earliest
}

/**
 * THE REAL DEFECT, not a token swap: hoist the whole "5. Draft initial script"
 * block above the ledger insert, exactly as a careless refactor would. The
 * earlier control swapped two identifiers and left the blocks where they were,
 * which is a mutation that mutates nothing.
 */
function hoistDraftAboveLedger(src: string): string {
  const led    = src.indexOf("  const ledger = await svc")
  const ledEnd = src.indexOf("  const introVideoId = ledger.data?.id")
  // The whole compliance loop — which now OWNS the first draft — is the block
  // that gets hoisted. Anchored on its opening `let script: string` declaration
  // through the end of its gate closure.
  const dStart = src.indexOf("  let script: string")
  const dEnd   = src.indexOf("  if (complianceResult.ok) {")
  if (led < 0 || ledEnd < 0 || dStart < 0 || dEnd < 0 || !(led < ledEnd && ledEnd < dStart && dStart < dEnd)) {
    // Anchors moved. Return the source unchanged so the control FAILS loudly
    // rather than quietly proving nothing.
    return src
  }
  const ledger = src.slice(led, ledEnd)
  const between = src.slice(ledEnd, dStart)
  const draft = src.slice(dStart, dEnd)
  return src.slice(0, led) + draft + ledger + between + src.slice(dEnd)
}

/** The ensure reads `contacts` and never reaches back to `leads` (§5). */
function checkReadsContactNotLead(src: string): boolean {
  return /\.from\("contacts"\)/.test(src) && !/\.from\("leads"\)/.test(src)
}

/**
 * Swap the FIRST occurrences of two markers in a source string, so an ordering
 * finder can be handed the inverted order. Pure — used only by section 6.
 */
function swapOrder(src: string, first: string, second: string): string {
  const a = src.indexOf(first)
  const b = src.indexOf(second)
  if (a < 0 || b < 0) return src
  const [lo, loTok, hi, hiTok] = a < b ? [a, first, b, second] : [b, second, a, first]
  return src.slice(0, lo) + hiTok + src.slice(lo + loTok.length, hi) + loTok + src.slice(hi + hiTok.length)
}

main().catch((err) => {
  console.error("welcome-avatar-video: harness error", err)
  process.exit(1)
})
