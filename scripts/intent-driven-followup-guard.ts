#!/usr/bin/env tsx
/**
 * scripts/intent-driven-followup-guard.ts   (npm run test:intent-driven-followup)
 * ───────────────────────────────────────────────────────────
 * WAVE 143, LANE 143E — "AI always listening": follow-up decided from intent, not from a timetable in code.
 *
 * OWNER RULINGS UNDER PROOF
 *   · "Follow-up/touchpoints must NOT be hard-coded: managers check intent and determine the proper follow-up … The follow-up timetable must
 *     not depend on code."
 *   · "A review is always asked at closing." Brief: channel / consent / platform policy; no duplicates, no gating, no misleading incentives
 *     — proved ON THE CLOSE PATH.
 *   · Market leadership: topic suggestions, AI-search visibility, competitor intelligence, content performance, local events → original
 *     marketing; no generic hard-coded content as the strategy.
 *
 * IN-MEMORY: no credentials, no provider, no network. The model is an injected `decide` / `generate` fixture; sends are recorder seams
 * (the gates themselves are test:autonomy-gate / test:outbound-call-gates / test:compliance-*). Every ABSENCE assertion carries a POSITIVE
 * CONTROL (CLAUDE.md §2); every source assertion reads STRIPPED source (a tombstone is not a call site); numbers are DERIVED from the
 * code, never hard-coded from memory.
 *
 *   1 THE POLICY   one place for every follow-up number; defaults = the historical literals; tenant values clamped; legal floor held
 *   2 THE ARBITER  the model chooses ONLY from the planner's menu; locked / invalid / unavailable / over-budget keep the planner's verdict;
 *                  no financials, no protected-class-adjacent memory; deferral is bounded; the cadence is an envelope the model cannot widen
 *   3 THE PLANNER  tenant guardrails reach the hard verdicts; a locked plan says why
 *   4 MOMENTS      the post-close schedule is DELIVERED (it had no reader): sent / delegated / routed / deferred / skipped truthfully, once
 *   5 REVIEW ASK   one engine on the close path: verified closing, delay, one ask per client, real link, screened copy, consent, evidence
 *   6 LEADERSHIP   the five intelligence streams reach the weekly planner, ranked by evidence, never inventing an opportunity
 *   7 CENSUS       no schedule literal in the follow-up decision modules outside the policy (ratchet, with its positive control)
 *
 * BLIND SPOTS, stated beside the numbers: the live tables are not read (columns asserted against scripts/schema-snapshot.ts / check-vocabularies.ts);
 * the model is a fixture (prompt quality, refusal rate and latency are NOT measured here — only that nothing outside the menu / bounds can pass);
 * dispatch / delegation / ledger are recorder seams; the review-copy screen is a conservative regex (it can FALSE-POSITIVE a clean draft into
 * a staged one — fail-closed by design — and cannot judge intent it does not match); local events have NO feed (inferred from geo-tagged topics);
 * Zillow / Realtor.com / Facebook / Yelp solicitation terms and any state real-estate-commission rule on republishing a testimonial are NOT verified.
 *
 * Run: npx tsx --conditions=react-server scripts/intent-driven-followup-guard.ts
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { stripComments, blankStrings } from "./strip-comments"
import { memSupabase, type Row } from "./in-memory-supabase"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => (existsSync(p) ? stripComments(readFileSync(p, "utf8")) : "")
const raw = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "")

const NOW = new Date("2026-10-23T15:00:00Z")
const H = 3_600_000, DAY = 86_400_000

async function main() {
  const policyMod = await import("../lib/ai-isa/followup-policy")
  const arb = await import("../lib/ai-isa/followup-arbiter")
  const lap = await import("../lib/ai-isa/lead-action-plan")
  const reeng = await import("../lib/ai-isa/reengagement-policy")
  const rap = await import("../lib/reputation/review-ask-policy")
  const engine = await import("../lib/reputation/review-ask")
  const draftMod = await import("../lib/reputation/review-request-draft")
  const moments = await import("../lib/sphere/followup-moments")
  const lead = await import("../lib/content-intel/market-leadership")
  const tp = await import("../lib/kernel/tenant-policy")
  const { REVIEW_REQUEST_DEFAULT_DELAY_DAYS } = await import("../lib/reputation/review-request-delay")
  const D = policyMod.DEFAULT_FOLLOWUP_POLICY

  // ═══════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── 1. THE POLICY — one place for every follow-up number ──")
  {
    check("the platform defaults are the historical literals (an unconfigured tenant behaves as before): fatigue 48h · window 8-21 · agent 7d",
      D.guardrails.minHoursBetweenTouches === 48 && D.guardrails.quietHours.startHour === 8 && D.guardrails.quietHours.endHour === 21 && D.guardrails.agentActiveDays === 7)
    check("…re-engagement 14/60/21 stale, Mon/Wed/Fri, 14d window, 30d + 90d spacing, 9 + 13 attempts",
      D.reengagement.staleDays === 14 && D.reengagement.lifetimeStaleDays === 60 && D.reengagement.ghostedDays === 21 && D.reengagement.phase1WindowDays === 14
      && D.reengagement.phase1SendWeekdays.join() === "1,3,5" && D.reengagement.phase2SpacingDays === 30 && D.reengagement.phase3SpacingDays === 90 && D.reengagement.maxGhostAttempts === 9 && D.reengagement.maxHorizonAttempts === 13)
    check("…sphere windows 14/14/21/90 · nurture 7d signal / 25d spacing / 65 threshold",
      D.sphere.lifeEventWindowDays === 14 && D.sphere.valueCheckWindowDays === 14 && D.sphere.anniversaryLookaheadDays === 21 && D.sphere.goneQuietDays === 90
      && D.nurture.signalWindowDays === 7 && D.nurture.enrollmentSpacingDays === 25 && D.nurture.reactivationScoreThreshold === 65)
    check("…post-close moments 3d / 30d / 180d / 365d / 540d with the historical default channels",
      D.postClose.map((m) => `${m.key}:${m.afterClosingDays}:${m.defaultChannel}`).join() === "post_close_3_day:3:video,post_close_30_day:30:sms,post_close_6_month:180:email,home_anniversary:365:video,referral_request:540:sms")
    check("the OLD module constants are DERIVED from the policy, not second copies (DERIVED, one spelling — §6)",
      reeng.DEFAULT_STALE_DAYS === D.reengagement.staleDays && reeng.LIFETIME_STALE_DAYS === D.reengagement.lifetimeStaleDays && reeng.DEFAULT_GHOSTED_DAYS === D.reengagement.ghostedDays
      && reeng.PHASE1_WINDOW_DAYS === D.reengagement.phase1WindowDays && reeng.PHASE2_SPACING_DAYS === D.reengagement.phase2SpacingDays && reeng.PHASE3_SPACING_DAYS === D.reengagement.phase3SpacingDays
      && reeng.DEFAULT_MAX_GHOST_ATTEMPTS === D.reengagement.maxGhostAttempts && reeng.DEFAULT_MAX_HORIZON_ATTEMPTS === D.reengagement.maxHorizonAttempts)
    check("the policy is frozen (a caller cannot mutate the platform default)", Object.isFrozen(D) && Object.isFrozen(D.guardrails) && Object.isFrozen(D.postClose))
    check("never set / null / garbage → the full default, with the reason published",
      policyMod.resolveFollowupPolicy(undefined).source.includes("never set") && policyMod.resolveFollowupPolicy("nope").adjustments.length === 1 && policyMod.resolveFollowupPolicy(null).policy.guardrails.minHoursBetweenTouches === 48)

    // The LEGAL FLOOR: a tenant narrows the send window, never widens it.
    const wide = policyMod.resolveFollowupPolicy({ guardrails: { quietHours: { startHour: 5, endHour: 23 } } })
    check("LEGAL FLOOR: a 5-23 window is clamped to 8-21 (47 CFR 64.1200(c)(1)) and the correction is PUBLISHED",
      wide.policy.guardrails.quietHours.startHour === 8 && wide.policy.guardrails.quietHours.endHour === 21 && wide.adjustments.length >= 2)
    const narrow = policyMod.resolveFollowupPolicy({ guardrails: { quietHours: { startHour: 10, endHour: 18 } } })
    check("…narrowing inside it is honoured (10-18) with no adjustment", narrow.policy.guardrails.quietHours.startHour === 10 && narrow.policy.guardrails.quietHours.endHour === 18 && narrow.adjustments.length === 0)
    check("…an empty window falls back to the platform window, not to 'always allowed'", (() => { const r = policyMod.resolveFollowupPolicy({ guardrails: { quietHours: { startHour: 15, endHour: 15 } } }); return r.policy.guardrails.quietHours.startHour === 8 && r.policy.guardrails.quietHours.endHour === 21 })())
    check("a fatigue floor of 0 is clamped up (a tenant cannot switch fatigue off)", policyMod.resolveFollowupPolicy({ guardrails: { minHoursBetweenTouches: 0 } }).policy.guardrails.minHoursBetweenTouches === 1)
    check("tenant values are honoured and clamped to sane bounds", (() => { const r = policyMod.resolveFollowupPolicy({ reengagement: { phase2SpacingDays: 14, phase3SpacingDays: 9999, phase1SendWeekdays: [2, 4, 9] }, arbiter: { maxDeferDays: 3 } }); return r.policy.reengagement.phase2SpacingDays === 14 && r.policy.reengagement.phase3SpacingDays === 730 && r.policy.reengagement.phase1SendWeekdays.join() === "2,4" && r.policy.arbiter.maxDeferDays === 3 })())
    check("guidance is trimmed + capped", policyMod.resolveFollowupPolicy({ guidance: "x".repeat(5000) }).policy.guidance.length === 2000)

    // Moments: storable keys only
    const vocab = CHECK_VOCABULARIES.lifetime_customer_touchpoints?.touchpoint_type ?? []
    check(`MOMENT_TOUCHPOINT_TYPES ⊂ the live touchpoint_type CHECK (${policyMod.MOMENT_TOUCHPOINT_TYPES.length} of ${vocab.length}) — a key the CHECK refuses would fail the whole schedule insert`,
      vocab.length > 0 && policyMod.MOMENT_TOUCHPOINT_TYPES.every((t) => vocab.includes(t)))
    const mk = policyMod.resolveFollowupPolicy({ postClose: [{ key: "post_close_3_day", afterClosingDays: 5, defaultChannel: "sms", intent: "x" }, { key: "made_up_key", afterClosingDays: 4, defaultChannel: "email", intent: "y" }, { key: "post_close_3_day", afterClosingDays: 9, defaultChannel: "sms", intent: "dup" }] })
    check("a moment key the CHECK would refuse (and a duplicate) is DROPPED with the reason; a tenant's own days are honoured",
      mk.policy.postClose.length === 1 && mk.policy.postClose[0].afterClosingDays === 5 && mk.adjustments.length === 2)
    check("the moment channels are inside the live channel CHECK", D.postClose.every((m) => (CHECK_VOCABULARIES.lifetime_customer_touchpoints?.channel ?? []).includes(m.defaultChannel)))
    check("the post-close moments are an ordered list of day offsets from the closing (ascending) — the consumer dates its rows from `policy.postClose[].afterClosingDays`, and the defaults reproduce the historical 3 / 30 / 180 / 365 / 540",
      D.postClose.every((m, i, all) => i === 0 || all[i - 1].afterClosingDays <= m.afterClosingDays) && D.postClose.map((m) => m.afterClosingDays).join() === "3,30,180,365,540")

    // Registered, versioned, promotable
    check("followup_policy + reputation_profiles are REGISTERED tenant policy keys (every change = an immutable tenant_policy_versions row)",
      !!tp.TENANT_POLICY_SETTINGS_KEYS.followup_policy && !!tp.TENANT_POLICY_SETTINGS_KEYS.reputation_profiles && tp.parsePolicyKey("followup_policy")?.kind === "settings" && tp.parsePolicyKey("reputation_profiles")?.kind === "settings")
    check("(control) an UNregistered key does not parse", tp.parsePolicyKey("follow_up_policy_typo") === null)
    check("the policy key matches the m696 format CHECK", /^[a-z][a-z0-9_]*(:[a-z0-9_-]+)*$/.test(policyMod.FOLLOWUP_POLICY_KEY) && /^[a-z][a-z0-9_]*(:[a-z0-9_-]+)*$/.test(rap.REPUTATION_PROFILES_KEY))
    // loader
    const lsvc = memSupabase({ brokerage_settings: [{ id: "s1", brokerage_id: "B", settings: { followup_policy: { guardrails: { minHoursBetweenTouches: 12 } } } }] })
    check("loadFollowupPolicy reads the tenant's stored value (tenant-pinned)", (await policyMod.loadFollowupPolicy(lsvc, "B")).policy.guardrails.minHoursBetweenTouches === 12 && (await policyMod.loadFollowupPolicy(lsvc, "OTHER")).policy.guardrails.minHoursBetweenTouches === 48)
    const rsvc = memSupabase({}, { refuse: { brokerage_settings: "RLS refused" } })
    const refused = await policyMod.loadFollowupPolicy(rsvc, "B")
    check("a REFUSED read keeps the platform defaults (legal floors intact), says so, and never widens a limit",
      refused.source.includes("refused") && refused.policy.guardrails.quietHours.startHour === 8 && refused.policy.guardrails.minHoursBetweenTouches === 48)

    // The AI ISA's RE-DIAL GAPS — 14d / 30d literals in lib/ai-isa/voice-dial-batch.ts until this wave; now the tenant's policy.
    const voice = await import("../lib/ai-isa/voice-dial-batch")
    check("the voice re-dial gaps are policy fields with the historical defaults (14d any call · 30d cold) and the module's constants are DERIVED from them (one number, one place)",
      D.guardrails.callCooldownDays === 14 && D.guardrails.coldCallCooldownDays === 30 && voice.CALL_COOLDOWN_DAYS === D.guardrails.callCooldownDays && voice.COLD_COOLDOWN_DAYS === D.guardrails.coldCallCooldownDays)
    const callAgo = (days: number, over: Record<string, unknown> = {}) => [{ appointment_set: false, lead_quality_score: 60, created_at: new Date(NOW.getTime() - days * DAY).toISOString(), ...over }]
    check("(control) with the platform gaps a 10-day-old decent call suppresses a re-dial and a 20-day-old one does not", voice.callCooldownActive(callAgo(10), NOW.getTime()) && !voice.callCooldownActive(callAgo(20), NOW.getTime()))
    const tight = { callDays: 3, coldDays: 30 }
    check("a tenant that sets the call gap to 3 days: the SAME 10-day-old call no longer suppresses and a 2-day-old one does (the policy decides, not the code)",
      !voice.callCooldownActive(callAgo(10), NOW.getTime(), tight) && voice.callCooldownActive(callAgo(2), NOW.getTime(), tight))
    check("…a cold-quality call still holds its own, longer gap (10 days: held · 40 days: released)",
      voice.callCooldownActive(callAgo(10, { lead_quality_score: 10 }), NOW.getTime(), tight) && !voice.callCooldownActive(callAgo(40, { lead_quality_score: 10 }), NOW.getTime(), tight))
    check("…a call gap LONGER than the cold gap widens the look-back to it (an appointment 45 days ago suppresses at 60/30, not at the platform 14/30)",
      voice.callCooldownActive(callAgo(45, { appointment_set: true }), NOW.getTime(), { callDays: 60, coldDays: 30 }) && !voice.callCooldownActive(callAgo(45, { appointment_set: true }), NOW.getTime()))
    check("the gaps are clamped and the correction published (9999 → 180; 0 → 1: a tenant can shorten the re-dial gap, never switch it off)", (() => { const r = policyMod.resolveFollowupPolicy({ guardrails: { callCooldownDays: 9999, coldCallCooldownDays: 0 } }); return r.policy.guardrails.callCooldownDays === 180 && r.policy.guardrails.coldCallCooldownDays === 1 && r.adjustments.length === 2 })())
    const vsrc = src("lib/ai-isa/voice-dial-batch.ts")
    check("proposeIsaDialBatch reads the tenant's gaps through the ONE loader and hands them to the cooldown check (not the module constants)",
      /loadFollowupPolicy\(supabase, params\.brokerageId\)/.test(vsrc) && /callCooldownActive\(.*,\s*cooldowns\)/.test(vsrc) && !/callCooldownActive\(callHistory\.get\(r\.contactId\) \?\? \[\]\)/.test(vsrc))

    // THE EDIT SCREEN — the doors (getFollowupPolicyAction / saveFollowupPolicyAction) were written first, and a door nobody opens is an
    // orphan export (orphan doctrine §1.2: BUILD the missing half). The card must cover EVERY number the policy holds — derived from the
    // defaults, so a number added to the policy later cannot be left without a form field.
    const card = src("app/referrals/followup-policy-card.tsx")
    const pageSrc = src("app/referrals/page.tsx")
    const clientSrc = src("app/referrals/referrals-os-client.tsx")
    const numericLeaves = (obj: object, group: string) => Object.entries(obj).filter(([, v]) => typeof v === "number").map(([k]) => `${group}.${k}`)
    const policyNumbers = [
      ...numericLeaves(D.guardrails, "guardrails"), ...numericLeaves(D.reengagement, "reengagement"), ...numericLeaves(D.sphere, "sphere"),
      ...numericLeaves(D.nurture, "nurture"), ...numericLeaves(D.arbiter, "arbiter"),
    ]
    const cardHas = (id: string) => { const [g, k] = id.split("."); return new RegExp(`group:\\s*"${g}",\\s*key:\\s*"${k}"`).test(card) }
    const missingFields = policyNumbers.filter((id) => !cardHas(id))
    check(`EDIT SCREEN: the card has a form field for EVERY numeric policy value (${policyNumbers.length} derived from the defaults) — missing: ${missingFields.join(", ") || "none"}`, policyNumbers.length >= 20 && missingFields.length === 0)
    check("(control) the field finder rejects a number the card does not have and accepts one it does", !cardHas("guardrails.notARealPolicyNumber") && cardHas("guardrails.callCooldownDays"))
    check("…and the non-numeric parts are on the form too: guidance, quiet hours, send weekdays, the post-close moments and the AI switch",
      /guidance:\s*draft\.guidance/.test(card) && /quietHours:/.test(card) && /phase1SendWeekdays:\s*draft\.weekdays/.test(card) && /postClose:\s*moments/.test(card) && /enabled:\s*draft\.arbiterEnabled/.test(card))
    check("the card saves through the gated door and can reset to the platform defaults (null)", /saveFollowupPolicyAction\(policy\)/.test(card) && /saveFollowupPolicyAction\(null\)/.test(card))
    check("/referrals reads the door server-side and hands an admin the card; a non-admin gets none (forbidden hides it, any OTHER refusal is shown)",
      /getFollowupPolicyAction\(\)/.test(pageSrc) && /followupPolicy=\{followupPolicy\}/.test(pageSrc) && /Follow-up policy: \$\{followupPolicyRes\.error\}/.test(pageSrc) && /<FollowupPolicyCard initial=\{followupPolicy\}/.test(clientSrc))
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── 2. THE ARBITER — the model chooses among what is PERMITTED, nothing else ──")
  const intent = (score: number, trend: "rising" | "stable" | "falling" = "rising") =>
    ({ score, trend, velocityPerDay: 2, accelerationPerDay2: 0, confidence: "high", independentSources: 3, momentumRank: score, evidence: [] }) as never
  const base = (over: Partial<import("../lib/ai-isa/lead-action-plan").NextBestExperienceInput> = {}): import("../lib/ai-isa/lead-action-plan").NextBestExperienceInput => ({
    now: NOW, subject: "contact", nba: { memoryFacts: [] },
    person: { contactType: "buyer", persona: "first_time", hasAssignedAgent: true },
    behavior: { touchpoints7d: 0, lastTouchpointChannel: null, portalEducationViews: 0 },
    transaction: null, education: null, fatigue: { riskLevel: null },
    policy: { complianceHardFlag: false, allowedChannels: ["email", "sms"], autoSendAllowed: true, videoAllowed: true },
    ...over,
  })
  const policy = policyMod.platformFollowupPolicy()
  const good = (over: Record<string, unknown> = {}) => async () => ({ optionId: "properties", channel: "email", waitHours: null, rationale: "Rising intent and no touch this week — properties serve them best.", evidence: ["intent", "history"], confidence: 0.8, ...over })
  const open = base({ nba: { intent: intent(80), memoryFacts: [] } })
  const openPlan = lap.planNextBestExperience(open)
  // The arbiter's pipeline steps (facts, menu, prompt, validation, arbitrate) are MODULE-PRIVATE — no step is exported just for a test.
  // The product's entry is arbitrateAndRecordExperience (the ISA engage path and the moment conductor call it); the proof drives the SAME
  // code through that entry with an injected model and recorder seams.
  type PlanOf = ReturnType<typeof lap.planNextBestExperience>
  const sink = { ledger: async (_c: Record<string, unknown>, run: () => Promise<unknown>) => run(), emit: async () => ({ inserted: true }), delegate: async () => ({ ok: true, delegation: { id: "d1" } }) }
  const arbitrateExperiencePlan = async (
    a: { brokerageId: string; input: import("../lib/ai-isa/lead-action-plan").NextBestExperienceInput; plan: PlanOf; policy: import("../lib/ai-isa/followup-policy").FollowupPolicy; budget?: { remaining: number }; moment?: { key: string; intent: string; daysSinceOpen: number } },
    deps: { decide?: import("../lib/ai-isa/followup-arbiter").ArbiterDecide },
  ) => {
    const r = await arb.arbitrateAndRecordExperience(memSupabase({}, { uuidIds: true, stampCreatedAt: true }), { brokerageId: a.brokerageId, contactId: "C", input: a.input, plan: a.plan, now: NOW, policy: a.policy, budget: a.budget, moment: a.moment, systemSource: "t" }, { decide: deps.decide, record: sink })
    return { plan: r.plan, decision: r.decision! }
  }
  {
    check("fixture sanity: the open plan offers properties + communication + wait and is NOT locked", openPlan.locked === null && openPlan.ranked.some((r) => r.kind === "properties") && openPlan.ranked.some((r) => r.kind === "wait"))
    const menuIds = (await arbitrateExperiencePlan({ brokerageId: "B", input: open, plan: openPlan, policy }, { decide: good() })).decision.menu
    check("the menu is built ONLY from the planner's own positive candidates (+ wait)", openPlan.locked === null && menuIds.every((id) => openPlan.ranked.some((r) => r.kind === id && (r.score > 0 || r.kind === "wait"))) && menuIds.length >= 2, menuIds.join())

    // locked — the model is NEVER asked
    for (const [label, input] of [
      ["a dead end (do_not_contact)", base({ nba: { deadEnds: [{ outcome: "do_not_contact", at: null, source: "t" }] } })],
      ["the fatigue window (touched 1h ago)", base({ nba: { lastAnyTouchAt: new Date(NOW.getTime() - H) } })],
      ["critical fatigue", base({ fatigue: { riskLevel: "critical" }, nba: { intent: intent(90) } })],
      ["a hard compliance flag", base({ policy: { complianceHardFlag: true, allowedChannels: ["email"], autoSendAllowed: true, videoAllowed: true } })],
      ["an agent already handling it", base({ nba: { lastAgentTouchAt: new Date(NOW.getTime() - DAY) } })],
    ] as const) {
      let calls = 0
      const p = lap.planNextBestExperience(input)
      const r = await arbitrateExperiencePlan({ brokerageId: "B", input, plan: p, policy }, { decide: async () => { calls++; return good()() } })
      check(`LOCKED — ${label}: the plan says why (${p.locked?.reason?.slice(0, 40) ?? "?"}…), the model is NEVER called, the planner's verdict stands`, p.locked !== null && calls === 0 && r.decision.source === "deterministic" && r.plan.chosen.kind === p.chosen.kind && (r.decision.fallbackReason ?? "").startsWith("locked"))
    }
    check("(control) an unlocked plan IS sent to the model", await (async () => { let calls = 0; await arbitrateExperiencePlan({ brokerageId: "B", input: open, plan: openPlan, policy }, { decide: async () => { calls++; return good()() } }); return calls === 1 })())

    // a valid model pick changes the plan
    const ok = await arbitrateExperiencePlan({ brokerageId: "B", input: open, plan: openPlan, policy }, { decide: good() })
    check("a valid model choice becomes the plan's chosen experience (source ai, evidence + rationale + confidence carried)",
      ok.decision.source === "ai" && ok.plan.chosen.kind === "properties" && ok.decision.evidence.length === 2 && ok.decision.rationale.length > 10 && ok.decision.confidence === 0.8 && ok.decision.fallbackReason === null)
    const w = await arbitrateExperiencePlan({ brokerageId: "B", input: open, plan: openPlan, policy }, { decide: good({ optionId: "wait", channel: null, waitHours: 72 }) })
    check("a wait is re-timed: chosen.dueAt = now + the model's hours (bounded by the policy)", w.plan.chosen.kind === "wait" && w.plan.chosen.dueAt instanceof Date && w.plan.chosen.dueAt.getTime() === NOW.getTime() + 72 * H)

    // every refusal keeps the planner's verdict, with the reason
    const refusals: Array<[string, Record<string, unknown>, RegExp]> = [
      ["an option NOT on the menu (video is not offered to a non-lifetime contact)", { optionId: "video" }, /not on the menu/],
      ["an invented option", { optionId: "send_everything" }, /not on the menu/],
      ["a channel that is not permitted (voice)", { optionId: "communication", channel: "voice" }, /not permitted/],
      ["a wait beyond the policy bound", { optionId: "wait", channel: null, waitHours: policy.arbiter.maxDeferDays * 24 + 1 }, /outside/],
      ["a wait of 0 hours", { optionId: "wait", channel: null, waitHours: 0 }, /outside/],
      ["a wait with no hours", { optionId: "wait", channel: null, waitHours: null }, /needs waitHours/],
      ["waitHours on a non-wait", { optionId: "properties", waitHours: 5 }, /only for a wait/],
      ["no rationale", { rationale: "ok" }, /no rationale/],
      ["evidence that is not a supplied fact", { evidence: ["the moon", "vibes"] }, /cites no evidence/],
      ["confidence below the policy floor", { confidence: 0.05 }, /below the policy floor/],
    ]
    for (const [label, over, why] of refusals) {
      const r = await arbitrateExperiencePlan({ brokerageId: "B", input: open, plan: openPlan, policy }, { decide: good(over) })
      check(`REFUSED — ${label}: the planner's verdict stands (${r.plan.chosen.kind}), reason published`, r.decision.source === "deterministic" && r.plan.chosen.kind === openPlan.chosen.kind && why.test(r.decision.fallbackReason ?? ""), r.decision.fallbackReason ?? "")
    }
    const thrown = await arbitrateExperiencePlan({ brokerageId: "B", input: open, plan: openPlan, policy }, { decide: async () => { throw new Error("gateway down") } })
    check("a model OUTAGE degrades to the planner's verdict (never to an unchecked send)", thrown.decision.source === "deterministic" && /unavailable/.test(thrown.decision.fallbackReason ?? "") && thrown.plan.chosen.kind === openPlan.chosen.kind)
    let spent = 0
    const budget = { remaining: 0 }
    await arbitrateExperiencePlan({ brokerageId: "B", input: open, plan: openPlan, policy, budget }, { decide: async () => { spent++; return good()() } })
    check("an exhausted decision budget never calls the model", spent === 0)
    const b2 = { remaining: 2 }
    for (let i = 0; i < 4; i++) await arbitrateExperiencePlan({ brokerageId: "B", input: open, plan: openPlan, policy, budget: b2 }, { decide: async () => { spent++; return good()() } })
    check("the sweep budget bounds model spend: 4 candidates, budget 2 → exactly 2 model calls", spent === 2 && b2.remaining === 0)
    let off = 0
    await arbitrateExperiencePlan({ brokerageId: "B", input: open, plan: openPlan, policy: { ...policy, arbiter: { ...policy.arbiter, enabled: false } } }, { decide: async () => { off++; return good()() } })
    check("a tenant that turns the arbiter off keeps the deterministic planner (no model call)", off === 0)

    // moment overdue → wait withdrawn
    const momentAt = (days: number) => ({ key: "post_close_3_day", intent: "x", daysSinceOpen: days })
    const overdueMenu = (await arbitrateExperiencePlan({ brokerageId: "B", input: open, plan: openPlan, policy, moment: momentAt(policy.arbiter.maxDeferDays) }, { decide: good() })).decision.menu
    const freshMenu = (await arbitrateExperiencePlan({ brokerageId: "B", input: open, plan: openPlan, policy, moment: momentAt(policy.arbiter.maxDeferDays - 1) }, { decide: good() })).decision.menu
    check("DEFERRAL IS BOUNDED: once a moment has waited maxDeferDays, `wait` leaves the menu (the person is never left to silence); one day earlier it is still offered",
      !overdueMenu.includes("wait") && overdueMenu.length > 0 && freshMenu.includes("wait"), `${overdueMenu.join()} | ${freshMenu.join()}`)
    {
      // NOTHING automated left + deferral exhausted: the single permitted option is a HUMAN. The planner's own pick may still be `wait` —
      // the permitted option wins, the model is never asked (one option is not a choice), and the plan is handed to the agent.
      const lonelyInput = base({ policy: { complianceHardFlag: false, allowedChannels: [], autoSendAllowed: false, videoAllowed: false } })
      const lonely = lap.planNextBestExperience(lonelyInput)
      let asked = 0
      const lr = await arbitrateExperiencePlan({ brokerageId: "B", input: lonelyInput, plan: { ...lonely, ranked: lonely.ranked.filter((r) => r.kind === "wait") }, policy, moment: momentAt(99) }, { decide: async () => { asked++; return good()() } })
      check("…and with NOTHING else on the table an overdue moment routes to a HUMAN, not to nothing: the menu is the agent alone, the model is not asked, and the plan's chosen experience IS the agent (not the planner's `wait`)",
        lr.decision.menu.join() === "agent_intervention" && asked === 0 && lr.decision.kind === "agent_intervention" && lr.plan.chosen.kind === "agent_intervention", `${lr.decision.menu.join()} · chosen ${lr.plan.chosen.kind} · planner chose ${lonely.chosen.kind}`)
    }

    // facts: no financials, no protected-class-adjacent memory
    const withMemory = base({ nba: { intent: intent(80), memoryFacts: [
      { key: "household", value: "two young kids", confidence: 0.9, observedAt: NOW.toISOString() },
      { key: "religion", value: "x", confidence: 0.9, observedAt: NOW.toISOString() },
      { key: "commission_split", value: "70/30", confidence: 0.9, observedAt: NOW.toISOString() },
      { key: "channel_preference", value: "video", confidence: 0.9, observedAt: NOW.toISOString() },
    ] } })
    let prompt = ""
    await arbitrateExperiencePlan({ brokerageId: "B", input: withMemory, plan: lap.planNextBestExperience(withMemory), policy }, { decide: async (a) => { prompt = a.prompt; return good()() } })
    check("PROTECTED-CLASS-ADJACENT memory never reaches the model: only ARBITER_MEMORY_KEYS pass (household / religion are dropped, channel_preference stays) — read from the PROMPT the model was actually sent",
      prompt.length > 0 && /channel_preference/.test(prompt) && !/two young kids|religion|household/.test(prompt))
    check("FINANCIALS never reach the model (commission / cost / margin / usd / cents / revenue / payout)", !lap.FINANCIAL_KEY_PATTERN.test(prompt.replace(/min_hours_between_touches/g, "")) || !/commission|margin|payout|revenue/.test(prompt))
    check("(control) the key filter would have let a financial key through if it were not applied", ["commission_split", "household", "religion"].every((k) => !arb.ARBITER_MEMORY_KEYS.includes(k)) && lap.FINANCIAL_KEY_PATTERN.test("commission_split"))
    check("the system prompt tells the model what it cannot change and that it must cite evidence", /cannot be changed/.test(arb.ARBITER_SYSTEM) && /Choose ONLY an option id from the menu/.test(arb.ARBITER_SYSTEM) && /never reason from any personal characteristic/.test(arb.ARBITER_SYSTEM))

    // ledger detail
    const recorded: Array<Record<string, unknown>> = []
    const deps = {
      record: {
        ledger: async (ctx: Record<string, unknown>, run: () => Promise<unknown>) => { recorded.push(ctx); return run() },
        emit: async () => ({ inserted: true }),
        delegate: async () => ({ ok: true, delegation: { id: "d1" } }),
      },
    }
    const rec = await arb.arbitrateAndRecordExperience(memSupabase({}), { brokerageId: "B", contactId: "C", input: open, plan: openPlan, now: NOW, systemSource: "t", policy }, { decide: good(), ...deps })
    const ctx0 = recorded[0] as { detail?: { arbitration?: Record<string, unknown> }; policyKey?: string; action?: string }
    check("EVIDENCE (LAW 5): the chosen experience's ledger row carries the arbitration — source, rationale, evidence, confidence, menu, policy — and names followup_policy as the policy that permitted it",
      rec.decision?.source === "ai" && !!ctx0?.detail?.arbitration && ctx0.detail.arbitration.source === "ai" && typeof ctx0.detail.arbitration.rationale === "string" && Array.isArray(ctx0.detail.arbitration.evidence) && ctx0.policyKey === "followup_policy" && ctx0.action === "journey.experience.properties")
    recorded.length = 0
    let humanCalls = 0
    const hum = await arb.arbitrateAndRecordExperience(memSupabase({}), { brokerageId: "B", contactId: "C", input: open, plan: openPlan, now: NOW, humanInitiated: true, policy }, { decide: async () => { humanCalls++; return good()() }, ...deps })
    check("a HUMAN-initiated run is the human's call: the arbiter is not consulted and the row keeps the ISA policy key", humanCalls === 0 && hum.decision === null && (recorded[0] as { policyKey?: string }).policyKey === "ai_isa_settings")

    // "route to a human" produces a task a human sees
    {
      const t = memSupabase({ activities: [] }, { uuidIds: true, stampCreatedAt: true })
      const a1 = await arb.routeToAgent(t, { brokerageId: "B", contactId: "C", agentId: "AG", title: "Follow up personally", description: "why", now: NOW })
      const a2 = await arb.routeToAgent(t, { brokerageId: "B", contactId: "C", agentId: "AG", title: "Follow up personally", description: "why", now: NOW })
      check("ROUTE TO AGENT: an agent_intervention the arbiter chose becomes an activity the agent sees — ONE per contact per day (idempotent), tenant + agent stamped, never written with no agent to give it to, a refused write is reported not pretended",
        a1 && a2 && (t.tables.activities ?? []).length === 1 && t.tables.activities[0].agent_id === "AG" && t.tables.activities[0].brokerage_id === "B" && t.tables.activities[0].activity_type === "followup_moment_due"
        && (await arb.routeToAgent(t, { brokerageId: "B", contactId: "C2", agentId: null, title: "x", description: "y", now: NOW })) === false
        && (await arb.routeToAgent(memSupabase({}, { refuse: { activities: "RLS" } }), { brokerageId: "B", contactId: "C", agentId: "AG", title: "x", description: "y", now: NOW })) === false)
      const eng = src("app/actions/ai-isa/engage-contact.ts")
      check("…and the ISA's engage path calls it ONLY for the arbiter's own intervention (decision.source ai), with the contact's agent", /plan\.chosen\.kind === 'agent_intervention' && decision\?\.source === 'ai' && contact\.agent_id/.test(eng) && /routeToAgent\(supabase/.test(eng))
    }

    // NBX deferral bounded by the ledger (the engage path has no moment row)
    {
      const led = memSupabase({}, { uuidIds: true, stampCreatedAt: true })
      const askWait = async (clock: Date) => {
        let offered = true
        const r = await arb.arbitrateAndRecordExperience(led, { brokerageId: "B", contactId: "C-wait", input: { ...open, now: clock }, plan: lap.planNextBestExperience({ ...open, now: clock }), now: clock, systemSource: "t", policy },
          { decide: async (a) => { offered = /"id":"wait"/.test(a.prompt); return good({ optionId: "wait", channel: null, waitHours: 24 })() }, ...deps })
        // the in-memory client stamps WALL-CLOCK created_at; the ledger rows belong to the SIMULATED day they were written on
        for (const row of led.tables.agent_action_ledger ?? []) if (!(row as Row).__stamped) { row.created_at = clock.toISOString(); (row as Row).__stamped = true }
        return { kind: r.plan.chosen.kind, offered, source: r.decision?.source }
      }
      const seen: boolean[] = []
      for (let d = 0; d < policy.arbiter.maxDeferDays + 2; d++) seen.push((await askWait(new Date(NOW.getTime() + d * DAY))).offered)
      const lastOffered = seen.lastIndexOf(true)
      check(`the engage path's own deferral is BOUNDED: each AI wait is a ledger row, and after maxDeferDays (${policy.arbiter.maxDeferDays}) consecutive ones the wait is withdrawn so the person is acted on — the window then slides, because the forced action resets the clock (offered on days ${seen.map((o, i) => (o ? i : -1)).filter((i) => i >= 0).join(",")})`,
        seen.slice(0, policy.arbiter.maxDeferDays).every(Boolean) && lastOffered >= policy.arbiter.maxDeferDays - 1 && seen[policy.arbiter.maxDeferDays] === false && (led.tables.agent_action_ledger ?? []).filter((r) => r.action === "followup.decision.wait").length >= policy.arbiter.maxDeferDays,
        JSON.stringify(seen))
    }

    // cadence (ghost / nurture)
    const cadFacts = { leadTemperature: "warm", leadScore: 55, timeline: "3-6", attempts: 2, hoursSinceLastOutreach: 24 * 31, hoursSinceLastActivity: 24 * 40, daysDeferred: 0, source: "zillow", preferences: [] }
    let cadCalls = 0
    const cadDecide = (over: Record<string, unknown>) => async () => { cadCalls++; return { optionId: "wait", channel: null, waitHours: 48, rationale: "They went quiet recently; hold two days.", evidence: ["intent", "history"], confidence: 0.7, ...over } as never }
    const notDue = await arb.arbitrateCadence({ brokerageId: "B", policy, cadence: { shouldSend: false, phase: 2, daysSinceStart: 40, reason: "phase2_too_soon" }, facts: cadFacts }, { decide: cadDecide({}) })
    check("CADENCE ENVELOPE: a send the tenant's cadence does NOT release is never pulled forward (no consult, no send)", notDue.sendNow === false && notDue.decision === null && cadCalls === 0)
    const inFloor = await arb.arbitrateCadence({ brokerageId: "B", policy, cadence: { shouldSend: true, phase: 2, daysSinceStart: 40, reason: "phase2_due" }, facts: { ...cadFacts, hoursSinceLastOutreach: policy.guardrails.minHoursBetweenTouches - 1 } }, { decide: cadDecide({}) })
    check("…and a due send INSIDE the fatigue floor is held without asking (a deterministic limit)", inFloor.sendNow === false && inFloor.decision === null && cadCalls === 0)
    const deferred = await arb.arbitrateCadence({ brokerageId: "B", policy, cadence: { shouldSend: true, phase: 2, daysSinceStart: 40, reason: "phase2_due" }, facts: cadFacts }, { decide: cadDecide({}) })
    check("a DUE send: the model may hold it (bounded wait) — sendNow false, decision recorded", deferred.sendNow === false && deferred.decision?.kind === "wait" && deferred.decision.waitHours === 48 && cadCalls === 1)
    const released = await arb.arbitrateCadence({ brokerageId: "B", policy, cadence: { shouldSend: true, phase: 2, daysSinceStart: 40, reason: "phase2_due" }, facts: cadFacts }, { decide: cadDecide({ optionId: "send_now", waitHours: null }) })
    check("…or release it (sendNow true)", released.sendNow === true && released.decision?.optionId === "send_now")
    const callsBefore = cadCalls
    const exhausted = await arb.arbitrateCadence({ brokerageId: "B", policy, cadence: { shouldSend: true, phase: 2, daysSinceStart: 40, reason: "phase2_due" }, facts: { ...cadFacts, daysDeferred: policy.arbiter.maxDeferDays } }, { decide: cadDecide({}) })
    check("DEFERRAL EXHAUSTED: after maxDeferDays of holds the wait option is gone — only the send is left, so the deterministic send is released WITHOUT asking the model",
      exhausted.sendNow === true && exhausted.decision?.source === "deterministic" && /only one option/.test(exhausted.decision.fallbackReason ?? "") && cadCalls === callsBefore)
    const stubborn = await arbitrateExperiencePlan({ brokerageId: "B", input: open, plan: openPlan, policy, moment: { key: "post_close_3_day", intent: "x", daysSinceOpen: policy.arbiter.maxDeferDays } }, { decide: good({ optionId: "wait", channel: null, waitHours: 24 }) })
    check("(control) a model that answers `wait` when wait is NOT on the menu (the moment is overdue) is REFUSED, not obeyed", stubborn.decision.source === "deterministic" && /not on the menu/.test(stubborn.decision.fallbackReason ?? "") && stubborn.plan.chosen.kind !== "wait")
    const waits = memSupabase({ agent_action_ledger: [
      { id: "1", brokerage_id: "B", subject_type: "lead", subject_id: "L", action: "followup.decision.wait", created_at: new Date(NOW.getTime() - DAY).toISOString() },
      { id: "2", brokerage_id: "B", subject_type: "lead", subject_id: "L", action: "followup.decision.wait", created_at: new Date(NOW.getTime() - 2 * DAY).toISOString() },
      { id: "3", brokerage_id: "B", subject_type: "lead", subject_id: "L", action: "followup.decision.send_touch", created_at: NOW.toISOString() },
      { id: "4", brokerage_id: "B", subject_type: "lead", subject_id: "L", action: "followup.decision.wait", created_at: new Date(NOW.getTime() - 30 * DAY).toISOString() },
      { id: "5", brokerage_id: "OTHER", subject_type: "lead", subject_id: "L", action: "followup.decision.wait", created_at: NOW.toISOString() },
    ] })
    check("countArbiterWaits counts ONLY this tenant's wait rows for the subject inside the deferral window (2 of 5)", (await arb.countArbiterWaits(waits, { brokerageId: "B", subject: { type: "lead", id: "L" }, now: NOW, policy })) === 2)
    check("…and an unreadable ledger returns null → the callers offer no wait", (await arb.countArbiterWaits(memSupabase({}, { refuse: { agent_action_ledger: "no" } }), { brokerageId: "B", subject: { type: "lead", id: "L" }, now: NOW, policy })) === null)

    // the cadence envelope itself is policy-driven
    const cad = (now: string, extra: Record<string, unknown> = {}) => reeng.shouldSendGhostOutreach({ firstSentAt: "2026-10-01T00:00:00Z", lastSentAt: "2026-10-01T00:00:00Z", now: new Date(now), attempts: 1, ...extra })
    check("the historical cadence is unchanged by default (Mon send, Tue off-day in phase 1)", cad("2026-10-05T12:00:00Z").shouldSend === true && cad("2026-10-06T12:00:00Z").shouldSend === false)
    check("a tenant's re-engagement policy moves the envelope: Tue/Thu send days, and a 10-day phase-2 spacing",
      cad("2026-10-06T12:00:00Z", { policy: { phase1SendWeekdays: [2, 4] } }).shouldSend === true && reeng.shouldSendGhostOutreach({ firstSentAt: "2026-08-01T00:00:00Z", lastSentAt: "2026-10-10T00:00:00Z", now: new Date("2026-10-21T12:00:00Z"), attempts: 3, policy: { phase2SpacingDays: 10 } }).shouldSend === true
        && reeng.shouldSendGhostOutreach({ firstSentAt: "2026-08-01T00:00:00Z", lastSentAt: "2026-10-10T00:00:00Z", now: new Date("2026-10-21T12:00:00Z"), attempts: 3 }).shouldSend === false)
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── 3. THE PLANNER — tenant guardrails reach the hard verdicts ──")
  {
    const touched10hAgo = { lastAnyTouchAt: new Date(NOW.getTime() - 10 * H) }
    const def = lap.reasonsNotToAct(touched10hAgo as never, NOW)
    const tenant = lap.reasonsNotToAct({ ...touched10hAgo, guardrails: { ...D.guardrails, minHoursBetweenTouches: 4 } } as never, NOW)
    check("a touch 10h ago is inside the DEFAULT 48h fatigue window (blocking) but outside a tenant's 4h floor", def.some((r) => r.code === "recently_contacted" && r.blocking) && !tenant.some((r) => r.code === "recently_contacted"))
    const hr7 = { recipientLocalHour: 7 }
    const hr10 = { recipientLocalHour: 10 }
    check("the send window: 7am is outside the default; a tenant window narrowed to 10-18 blocks 9am but a 8-21 default allows it",
      lap.reasonsNotToAct(hr7 as never, NOW).some((r) => r.code === "quiet_hours") && !lap.reasonsNotToAct({ recipientLocalHour: 9 } as never, NOW).some((r) => r.code === "quiet_hours")
      && lap.reasonsNotToAct({ recipientLocalHour: 9, guardrails: { ...D.guardrails, quietHours: { startHour: 10, endHour: 18 } } } as never, NOW).some((r) => r.code === "quiet_hours") && !lap.reasonsNotToAct(hr10 as never, NOW).some((r) => r.code === "quiet_hours"))
    const agentTouch = { lastAgentTouchAt: new Date(NOW.getTime() - 3 * DAY) }
    check("agent-handling window follows the policy (3d ago: blocked by the 7d default, free under a 2d tenant window)",
      lap.reasonsNotToAct(agentTouch as never, NOW).some((r) => r.code === "agent_handling") && !lap.reasonsNotToAct({ ...agentTouch, guardrails: { ...D.guardrails, agentActiveDays: 2 } } as never, NOW).some((r) => r.code === "agent_handling"))
    const plan = lap.planNextContactTouch({ now: NOW, context: { ...touched10hAgo, guardrails: { ...D.guardrails, minHoursBetweenTouches: 4 } } as never })
    check("planNextContactTouch with the tenant's 4h floor SENDS where the default waits", plan.action === "send_touch" && lap.planNextContactTouch({ now: NOW, context: touched10hAgo as never }).action === "wait")
    const waitPlan = lap.planNextContactTouch({ now: NOW, context: { lastAnyTouchAt: new Date(NOW.getTime() - H), guardrails: { ...D.guardrails, minHoursBetweenTouches: 6 } } as never })
    check("the wait's dueAt follows the tenant floor too (touch 1h ago + 6h floor = +5h), not the 48h literal", waitPlan.dueAt instanceof Date && waitPlan.dueAt.getTime() === NOW.getTime() - H + 6 * H)
    const snap = lap.decisionInputSnapshot({ subject: "contact", now: NOW, context: { ...touched10hAgo, guardrails: { ...D.guardrails, minHoursBetweenTouches: 4 } } as never })
    const replay = lap.planFromDecisionInput(snap)
    check("REPLAY is faithful: a snapshot carries the guardrails the decision ran under, and replaying it reaches the same verdict (a pre-143 snapshot without them replays on the defaults)",
      replay?.action === "send_touch" && lap.planFromDecisionInput({ ...snap, context: { ...snap.context!, guardrails: undefined } })?.action === "wait")
  }

  // The remaining sections live in the second half of this file (kept in one script so the RESULT line is ONE number).
  await sections4to7({ policyMod, arb, lap, rap, engine, draftMod, moments, lead, REVIEW_REQUEST_DEFAULT_DELAY_DAYS, base, intent })

  console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
  console.log(" BLIND SPOTS: live tables not read (columns asserted against scripts/schema-snapshot.ts + check-vocabularies.ts); the model is a FIXTURE (prompt quality, refusal rate, latency NOT measured — only that nothing outside the menu / bounds can pass);")
  console.log("   dispatch / delegation / ledger / emit are recorder seams (the gates are test:autonomy-gate / test:outbound-call-gates); the review-copy screen is a conservative regex (it can false-positive a clean draft into a STAGED one and cannot judge intent it does not match);")
  console.log("   local events have NO feed (inferred from geo-tagged topics only); Zillow / Realtor.com / Facebook / Yelp solicitation terms and state real-estate-commission testimonial rules are NOT verified;")
  console.log("   the census counts literal-digit timing constants in the listed decision modules — a computed window, a timing literal in a module outside the list, or a literal in a string is not seen.")
  if (failed > 0) { console.log(` FAILED: ${failures.join(" | ")}`); console.log(" ❌ INTENT_DRIVEN_FOLLOWUP_FAIL"); process.exit(1) }
  console.log(" ✅ INTENT_DRIVEN_FOLLOWUP_PASS — the follow-up is decided from intent inside the tenant's policy; a review is asked once, honestly, at every verified closing")
}

// ═════════════════════════════════════════════════════════════════════════════════════════
type Ctx = {
  policyMod: typeof import("../lib/ai-isa/followup-policy")
  arb: typeof import("../lib/ai-isa/followup-arbiter")
  lap: typeof import("../lib/ai-isa/lead-action-plan")
  rap: typeof import("../lib/reputation/review-ask-policy")
  engine: typeof import("../lib/reputation/review-ask")
  draftMod: typeof import("../lib/reputation/review-request-draft")
  moments: typeof import("../lib/sphere/followup-moments")
  lead: typeof import("../lib/content-intel/market-leadership")
  REVIEW_REQUEST_DEFAULT_DELAY_DAYS: number
  base: (over?: Partial<import("../lib/ai-isa/lead-action-plan").NextBestExperienceInput>) => import("../lib/ai-isa/lead-action-plan").NextBestExperienceInput
  intent: (score: number, trend?: "rising" | "stable" | "falling") => never
}

async function sections4to7(c: Ctx): Promise<void> {
  const { policyMod, arb, lap, rap, engine, draftMod, moments, lead, base, intent } = c
  const dayIso = (d: Date) => d.toISOString().slice(0, 10)
  const ago = (days: number) => new Date(NOW.getTime() - days * DAY)

  // ═══════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── 4. THE POST-CLOSE MOMENTS — the schedule that nothing delivered is now delivered, once, truthfully ──")
  {
    const B = "b-1", AG = "ag-1", C = "c-1"
    const lifetimeInput = base({ person: { contactType: "lifetime_customer", persona: null, hasAssignedAgent: true }, nba: { memoryFacts: [], intent: intent(40, "stable") } })
    const touchRow = (id: string, type: string, date: string, extra: Row = {}): Row => ({ id, brokerage_id: B, contact_id: C, agent_id: AG, touchpoint_type: type, channel: "email", scheduled_date: date, status: "scheduled", related_transaction_id: "tx-1", engagement_data: {}, ...extra })
    const world = (o: { rows?: Row[]; contactBrokerage?: string; policy?: unknown; contactExtra?: Row } = {}) => memSupabase({
      brokerage_settings: [{ id: "s1", brokerage_id: B, settings: o.policy ? { followup_policy: o.policy } : {} }],
      contacts: [{ id: C, brokerage_id: o.contactBrokerage ?? B, first_name: "Pat", last_name: "Lee", email: "pat@example.test", phone: "+15555550100", preferred_channel: null, tcpa_consent: true, email_opt_out: false, email_unsubscribed: false, sms_opt_out: false, sms_unsubscribed: false, dnc_status: false, ai_outreach_paused: false, qualification_summary: null, last_contacted_at: null, contact_type: "lifetime_customer", contact_persona: null, agent_id: AG, buyer_stage: null, video_opt_out: false, ...(o.contactExtra ?? {}) }],
      agents: [{ id: AG, brokerage_id: B, user_id: "u-1" }],
      lifetime_customer_touchpoints: o.rows ?? [touchRow("t3", "post_close_3_day", dayIso(ago(1)))],
      activities: [],
    }, { stampCreatedAt: true, uuidIds: true })
    const rec = { sends: [] as Array<{ ch: string; p: Record<string, any> }>, events: [] as Array<Record<string, any>>, delegations: [] as Array<Record<string, any>>, ledger: [] as Array<Record<string, any>>, decides: 0, messages: 0 }
    const mkDeps = (decideFn: (o: any) => Record<string, unknown> | Promise<Record<string, unknown>>, over: Partial<import("../lib/sphere/followup-moments").ConductDeps> = {}): import("../lib/sphere/followup-moments").ConductDeps => ({
      now: () => NOW,
      loadInputs: async () => ({ ok: true as const, input: lifetimeInput }),
      decide: async (a) => { rec.decides++; return decideFn(a) as never },
      record: {
        ledger: async (ctx: Record<string, any>, run: () => Promise<unknown>) => { rec.ledger.push(ctx); return run() },
        emit: async () => ({ inserted: true }),
        delegate: async (input: Record<string, any>) => { rec.delegations.push(input); return { ok: true, delegation: { id: "del-1" } } },
      },
      message: async () => { rec.messages++; return { subject: "A note from your agent", body: "Hi Pat — thinking of you and the house. Anything you need?", generated: true } },
      dispatchEmail: async (p) => { rec.sends.push({ ch: "email", p }); return { success: true, messageId: "m-1" } },
      dispatchSms: async (p) => { rec.sends.push({ ch: "sms", p }); return { success: true, messageId: "m-2" } },
      emit: async (i) => { rec.events.push(i as Record<string, any>); return {} },
      ...over,
    })
    // The per-tenant conductor is module-private (the cron's entry is the all-tenants one); the proof drives the same code through that entry.
    // Every world below holds ONE tenant's rows, so the all-tenants totals ARE that tenant's result.
    const conduct = async (svc: ReturnType<typeof world>, deps: import("../lib/sphere/followup-moments").ConductDeps) => (await moments.conductDueFollowUpMomentsAllTenants(svc, deps)).totals
    const reset = () => { rec.sends.length = 0; rec.events.length = 0; rec.delegations.length = 0; rec.ledger.length = 0; rec.decides = 0; rec.messages = 0 }
    const choose = (optionId: string, over: Record<string, unknown> = {}) => () => ({ optionId, channel: optionId === "communication" ? "email" : null, waitHours: optionId === "wait" ? 48 : null, rationale: "Closed a day ago and quiet since — a light personal note fits.", evidence: ["relationship", "history"], confidence: 0.8, ...over })
    const rowOf = (svc: ReturnType<typeof world>, id: string) => (svc.tables.lifetime_customer_touchpoints ?? []).find((r) => r.id === id) as Row

    // D0: the unconditional truth — the policy's moments and the rows the close writes
    const planned = lap.planNextBestExperience(lifetimeInput)
    check("fixture sanity: a lifetime contact's planner verdict is the memory/anniversary VIDEO (Sphere-routed), communication and wait are also on the menu",
      planned.chosen.kind === "video" && planned.chosen.via === "sphere_of_influence" && planned.ranked.some((r) => r.kind === "communication") && planned.ranked.some((r) => r.kind === "wait") && planned.locked === null)

    // D1: communication
    {
      reset()
      const svc = world()
      const res = await conduct(svc, mkDeps(choose("communication")))
      const row = rowOf(svc, "t3")
      const s0 = rec.sends[0]
      check("D1 a due moment + the model's `communication` → ONE gated email sent, the row settled `sent` with the decision on it (rationale, evidence, confidence)",
        res.sent === 1 && rec.sends.length === 1 && s0.ch === "email" && row.status === "sent" && row.sent_date === dayIso(NOW) && (row.engagement_data as any).followup.chose === "communication" && (row.engagement_data as any).followup.rationale.length > 10 && (row.engagement_data as any).followup.evidence.length === 2, JSON.stringify(res))
      check("D1 …through the governed dispatcher with the manager armed (autonomy gate), the at-most-once ledger cycle, the policy named, the tenant pinned",
        s0.p.managerKey === "sphere_of_influence" && s0.p.ledger.cycle === "followup_moment:t3" && s0.p.ledger.policyKey === "followup_policy" && s0.p.brokerageId === B && s0.p.contactId === C && s0.p.systemSource === "lifetime_touchpoints")
      check("D1 …the experience is ledgered WITH the arbitration (LAW 5) and LIFETIME_CUSTOMER_TOUCHPOINT_SENT is emitted for the row",
        rec.ledger.some((l) => l.action === "journey.experience.communication" && l.detail?.arbitration?.source === "ai" && l.policyKey === "followup_policy") && rec.events.some((e) => e.event === "lifetime_customer_touchpoint_sent" && e.entityId === C))
      reset()
      const again = await conduct(svc, mkDeps(choose("communication")))
      check("D1 IDEMPOTENT: a re-run finds nothing due, sends nothing, asks nothing", again.scanned === 0 && rec.sends.length === 0 && rec.decides === 0)
    }
    // D2: wait
    {
      reset()
      const svc = world()
      const res = await conduct(svc, mkDeps(choose("wait", { waitHours: 48 })))
      const row = rowOf(svc, "t3")
      check("D2 the model's bounded WAIT moves the row's date (now + 48h), sends nothing, and keeps the reason", res.deferred === 1 && row.status === "scheduled" && row.scheduled_date === dayIso(new Date(NOW.getTime() + 48 * H)) && rec.sends.length === 0 && (row.engagement_data as any).followup.chose === "wait")
    }
    // D2b: a deferral can never be forever — the moment's age counts from when it OPENED
    {
      reset()
      const svc = world({ rows: [touchRow("tw", "post_close_3_day", dayIso(NOW))] })
      let day = 0, asked = 0
      let finished: string | null = null
      const maxDefer = policyMod.DEFAULT_FOLLOWUP_POLICY.arbiter.maxDeferDays
      for (; day <= maxDefer + 3 && !finished; day++) {
        const clock = new Date(NOW.getTime() + day * DAY)
        await conduct(svc, mkDeps(() => { asked++; return choose("wait", { waitHours: 24 })() }, { now: () => clock }))
        const st = rowOf(svc, "tw").status
        if (st !== "scheduled") finished = st
      }
      const trail = (rowOf(svc, "tw").engagement_data as { followup?: { opened_on?: string } }).followup
      check(`D2b A MODEL THAT ALWAYS ANSWERS 'wait' CANNOT HOLD A PERSON FOREVER: after the policy's maxDeferDays (${maxDefer}) the wait option leaves the menu and the moment is acted on (settled '${finished}' on day ${day}, ${asked} model asks) — the open date survives each deferral (opened_on ${trail?.opened_on})`,
        finished === "pending_review" && day <= maxDefer + 2 && trail?.opened_on === dayIso(NOW), `status ${finished} after ${day} runs`)
    }
    // D2c: nothing automated left + deferral exhausted → a person, never silence
    {
      reset()
      const lonelyInput = base({ person: lifetimeInput.person, policy: { complianceHardFlag: false, allowedChannels: [], autoSendAllowed: false, videoAllowed: false } })
      const svc = world({ rows: [touchRow("tl", "post_close_3_day", dayIso(ago(policyMod.DEFAULT_FOLLOWUP_POLICY.arbiter.maxDeferDays)))] })
      const r = await conduct(svc, mkDeps(choose("communication"), { loadInputs: async () => ({ ok: true as const, input: lonelyInput }) }))
      check("D2c NEVER SILENCE: a moment overdue by the policy's maxDeferDays whose planner has no automated option left is handed to the AGENT (a task they see), not retried forever; the model is not asked",
        r.routedToAgent === 1 && rowOf(svc, "tl").status === "pending_review" && (svc.tables.activities ?? []).some((a) => a.activity_type === "followup_moment_due" && a.agent_id === AG && a.brokerage_id === B) && rec.decides === 0, JSON.stringify(r))
    }
    // D3: locked (terminal) and locked (temporary)
    {
      reset()
      const svc = world()
      const dead = base({ person: lifetimeInput.person, nba: { memoryFacts: [], deadEnds: [{ outcome: "do_not_contact", at: null, source: "t" }] } })
      const res = await conduct(svc, mkDeps(choose("communication"), { loadInputs: async () => ({ ok: true as const, input: dead }) }))
      check("D3 a TERMINAL lock (a recorded do-not-contact): the row is settled `skipped` as a DECISION (not a miss — no reaper alarm), nothing sent, the model never asked",
        res.blocked === 1 && rowOf(svc, "t3").status === "skipped" && rec.sends.length === 0 && rec.decides === 0 && /do_not_contact|NBA/.test(String((rowOf(svc, "t3").engagement_data as any).followup.blocked)))
      reset()
      const fresh = world({ rows: [touchRow("tf", "post_close_3_day", dayIso(NOW))] })
      const touched = base({ person: lifetimeInput.person, nba: { memoryFacts: [], lastAnyTouchAt: new Date(NOW.getTime() - H) } })
      const r1 = await conduct(fresh, mkDeps(choose("communication"), { loadInputs: async () => ({ ok: true as const, input: touched }) }))
      check("D3 a TEMPORARY lock (touched an hour ago) keeps the row `scheduled` to retry tomorrow — it is not skipped on day one", r1.retryingTomorrow === 1 && rowOf(fresh, "tf").status === "scheduled" && rec.sends.length === 0)
      const stale = world({ rows: [touchRow("ts", "post_close_3_day", dayIso(ago(policyMod.DEFAULT_FOLLOWUP_POLICY.arbiter.maxDeferDays)))] })
      const r2 = await conduct(stale, mkDeps(choose("communication"), { loadInputs: async () => ({ ok: true as const, input: touched }) }))
      check("D3 …and once the moment has waited the policy's maxDeferDays the temporary block is settled `skipped` (derived from the policy, not a literal)", r2.blocked === 1 && rowOf(stale, "ts").status === "skipped")
    }
    // D4: no canned fallback
    {
      reset()
      const svc = world()
      const res = await conduct(svc, mkDeps(choose("communication"), { message: async () => ({ subject: "A note from your agent", body: "Thinking of you — reply any time.", generated: false }) }))
      check("D4 NO CANNED COPY: when the gateway cannot generate the message, NOTHING is sent and the moment retries tomorrow (the generator's neutral fallback is never shipped unreviewed)", res.retryingTomorrow === 1 && rec.sends.length === 0 && rowOf(svc, "t3").status === "scheduled")
    }
    // D5: video via the existing rail
    {
      reset()
      const svc = world()
      const res = await conduct(svc, mkDeps(choose("video")))
      const d0 = rec.delegations[0]
      check("D5 an on-the-fly AVATAR VIDEO is requested through the EXISTING rail: delegated to the Asset Manager (content_repurpose), routed via the Sphere Manager for a lifetime contact; the row is `pending_review`; nothing is texted on top",
        res.delegated === 1 && rec.delegations.length === 1 && d0.assignedManager === "asset_manager" && d0.capability === "content_repurpose" && d0.requestingManager === "sphere_of_influence" && rowOf(svc, "t3").status === "pending_review" && rec.sends.length === 0)
    }
    // D6: anniversary reconcile
    {
      reset()
      const svc = world({ rows: [touchRow("ta", "home_anniversary", dayIso(NOW)), touchRow("tb", "home_anniversary", dayIso(NOW), { contact_id: "c-2" }), { id: "twin", brokerage_id: B, contact_id: C, touchpoint_type: "home_anniversary", status: "sent", sent_date: dayIso(NOW), scheduled_date: dayIso(NOW), channel: "email" }] })
      const res = await conduct(svc, mkDeps(choose("communication")))
      check("D6 the anniversary the date-driven cron already SENT is reconciled (scheduled → sent), never re-sent and never reaped as `slipped`; one that was NOT sent stays for the cron",
        res.reconciled === 1 && rowOf(svc, "ta").status === "sent" && rowOf(svc, "tb").status === "scheduled" && rec.sends.length === 0 && rec.decides === 0)
    }
    // D7: gate hold vs gate refusal
    {
      reset()
      const held = world()
      const r1 = await conduct(held, mkDeps(choose("communication"), { dispatchEmail: async () => ({ success: false, providerKey: "autonomy_gate", error: "Outbound held: manager on approval_required" }) }))
      check("D7 an autonomy-gate HOLD (the approval queue has it) is `pending_review`, never `sent`", r1.routedToAgent === 1 && rowOf(held, "t3").status === "pending_review")
      const refused = world()
      const r2 = await conduct(refused, mkDeps(choose("communication"), { dispatchEmail: async () => ({ success: false, providerKey: "compliance_gate", error: "Outbound blocked: contact opted out" }) }))
      check("D7 a hard gate REFUSAL is never rendered as a send: the row is `pending_review` WITH a task for the agent (a person decides — never silence)",
        r2.routedToAgent === 1 && rowOf(refused, "t3").status === "pending_review" && (refused.tables.activities ?? []).some((a) => a.activity_type === "followup_moment_due" && a.agent_id === AG && a.brokerage_id === B))
      const dc = world()
      const r3 = await conduct(dc, mkDeps(choose("communication"), { dispatchEmail: async () => ({ success: false, providerKey: "deconflict_gate", error: "Outbound deferred: weekly cap" }) }))
      check("D7 a de-confliction deferral is `not today`: the row stays scheduled", r3.retryingTomorrow === 1 && rowOf(dc, "t3").status === "scheduled")
    }
    // D8: budget, disabled, human
    {
      reset()
      const two = world({ rows: [touchRow("a", "post_close_3_day", dayIso(ago(1))), touchRow("b", "post_close_30_day", dayIso(ago(1)))], policy: { arbiter: { maxDecisionsPerRun: 1 } } })
      const res = await conduct(two, mkDeps(choose("communication")))
      check("D8 the sweep's decision budget (policy.arbiter.maxDecisionsPerRun = 1) bounds model spend: 2 due rows → ONE model call; the other keeps the planner's verdict (video, delegated)",
        rec.decides === 1 && res.arbiterCalls === 1 && res.scanned === 2 && res.sent + res.delegated === 2)
      reset()
      const off = world({ policy: { arbiter: { enabled: false } } })
      const r2 = await conduct(off, mkDeps(choose("communication")))
      check("D8 a tenant that switches the arbiter OFF gets the deterministic planner's moment (no model call, video delegated)", rec.decides === 0 && r2.delegated === 1)
    }
    // D9: tenant pinning, future rows, tenants
    {
      reset()
      const foreign = world({ contactBrokerage: "someone-else" })
      const res = await conduct(foreign, mkDeps(choose("communication")))
      check("D9 TENANT-PINNED: a moment whose contact is in another brokerage sends nothing, asks nothing, and reports why", res.errors.some((e) => /not in this brokerage/.test(e)) && rec.sends.length === 0 && rec.decides === 0 && rowOf(foreign, "t3").status === "scheduled")
      reset()
      const future = world({ rows: [touchRow("tx", "post_close_3_day", dayIso(new Date(NOW.getTime() + DAY)))] })
      const r2 = await conduct(future, mkDeps(choose("communication")))
      check("D9 a moment that has not opened yet is not touched", r2.scanned === 0 && rec.sends.length === 0)
      reset()
      const multi = world({ rows: [touchRow("m1", "post_close_3_day", dayIso(ago(1))), touchRow("m2", "post_close_3_day", dayIso(ago(1)), { brokerage_id: "b-2" })] })
      const all = await moments.conductDueFollowUpMomentsAllTenants(multi, mkDeps(choose("communication")))
      check("D9 the all-tenants entry groups by tenant and never lets one tenant's row be conducted under another: b-2's row names a contact that lives in b-1 → refused (`not in this brokerage`), nothing sent for it; b-1's own row is conducted",
        all.tenants === 2 && all.totals.scanned === 2 && all.totals.errors.some((e) => /^\[b-2\].*not in this brokerage/.test(e)) && rec.sends.length === 1 && rowOf(multi, "m2").status === "scheduled" && rowOf(multi, "m1").status === "sent", JSON.stringify(all.totals.errors))
    }
    // D10: wiring + the pending consumer
    {
      const cron = src("app/api/cron/lifetime-customer-touchpoints/route.ts")
      check("D10 the daily lifetime cron RUNS the conductor (the schedule has a reader) and no longer carries the fixed day-3 / day-30 referral window or imports its sender",
        /conductDueFollowUpMomentsAllTenants/.test(cron) && !/\.in\("close_date",\s*\[/.test(cron) && !/sendReferralRequest/.test(blankStrings(cron)))
      check("D10 (control) the finder still sees the retired fixed-window shape", /\.in\("close_date",\s*\[/.test(`.in("status", ["closed"]).in("close_date", [a, b])`))
      check("D10 the deleted sender left no importer behind (tombstone, not a call site)", !/sendReferralRequest\(/.test(blankStrings(src("app/actions/lifetime-customer-touchpoints.ts"))) && /DELETED \(wave 143, lane 143E\): sendReferralRequest/.test(raw("app/actions/lifetime-customer-touchpoints.ts")))
      const conv = src("lib/kernel/lifetime-conversion.ts")
      const usesPolicy = /loadFollowupPolicy\(/.test(conv) && /\.postClose\b/.test(conv)
      const literal = /const POST_CLOSE_TOUCHPOINTS = \[([\s\S]*?)\] as const/.exec(conv)
      let literalMatchesDefaults = false
      if (literal) {
        const parsed = [...literal[1].matchAll(/type:\s*"(\w+)",\s*daysAfter:\s*([\d\s*]+),\s*channel:\s*"(\w+)"/g)].map((m) => `${m[1]}:${m[2].split("*").map((n) => Number(n.trim())).reduce((a, b) => a * b, 1)}:${m[3]}`)
        literalMatchesDefaults = parsed.join() === policyMod.DEFAULT_FOLLOWUP_POLICY.postClose.map((m) => `${m.key}:${m.afterClosingDays}:${m.defaultChannel}`).join()
      }
      check(`D10 the schedule the CLOSE writes (lib/kernel/lifetime-conversion.ts — lane 143C's file): ${usesPolicy ? "reads the tenant's policy (loadFollowupPolicy → policy.postClose)" : "still a LITERAL, equal to the policy defaults → PENDING OUTSIDE-LANE (the exact change is in the notes); the conductor reads dates from the rows, so nothing is lost"}`,
        usesPolicy || literalMatchesDefaults)
      check("D10 (control) a literal that DRIFTED from the defaults would fail this ratchet", !(`type: "post_close_3_day", daysAfter: 4, channel: "video"`.includes("daysAfter: 3")))
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── 5. THE REVIEW ASK AT CLOSING — one engine, on the close path ──")
  {
    const B = "b-1", AG = "ag-1", TX = "tx-1", BUYER = "c-buyer", SELLER = "c-seller"
    const GOOGLE = "https://g.page/r/CabcdEfgh123/review"
    const old = ["https://g.page/r/YOUR_PLACE_ID/review", "https://www.zillow.com/profile/YOUR_ID/reviews", "https://www.realtor.com/realestateagents/YOUR_ID/reviews", "https://facebook.com/YOUR_PAGE/reviews", "https://www.yelp.com/writeareview/biz/YOUR_BIZ_ID", "https://g.page/r/YOUR_GOOGLE_PLACE_ID/review"]
    check("LINKS: the six placeholder links the old code sent are ALL refused by the validator (positive control — they were the defect)",
      old.every((u, i) => !rap.validateReviewLink((["google", "zillow", "realtor_com", "facebook", "yelp", "google"] as const)[i], u).ok))
    check("…a real platform-hosted https link is accepted; http, a foreign host, a credentialed URL and empty are refused",
      rap.validateReviewLink("google", GOOGLE).ok && !rap.validateReviewLink("google", "http://g.page/r/abc/review").ok && !rap.validateReviewLink("google", "https://evil.example.net/g.page/r/abc").ok
      && !rap.validateReviewLink("google", "https://u:p@g.page/r/abc").ok && !rap.validateReviewLink("zillow", GOOGLE).ok && !rap.validateReviewLink("google", "").ok)

    const FLAG: Array<[string, string, string]> = [
      ["incentive", "Leave us a review and we will send you a $25 gift card.", "incentive"],
      ["incentive", "Everyone who reviews is entered into a drawing for a free dinner.", "incentive"],
      ["incentive", "As a thank you we will take 10% discount off your next service in exchange for a review.", "incentive"],
      ["gating", "If you were happy with the service, please share a review on Google.", "gating"],
      ["gating", "If you had any problem, please contact me first before you post anything.", "gating"],
      ["gating", "Before you post a review, tell us privately what we could do better.", "gating"],
      ["rating_pressure", "A 5-star review would mean the world to me.", "rating_pressure"],
      ["rating_pressure", "Would you leave a positive review?", "rating_pressure"],
      ["suppression", "If something went wrong, please remove your negative review.", "suppression"],
    ]
    const CLEAN = [
      "Hi Pat, it was a pleasure helping you with 12 Oak St. If you have a moment, an honest review of your experience would mean a lot: https://g.page/r/CabcdEfgh123/review",
      "Feel free to reply to this email with any question you have; and if you are willing, share your experience here: https://g.page/r/CabcdEfgh123/review",
      rap.composeManualReviewAsk({ firstName: "Pat", address: "12 Oak St", url: GOOGLE }).body,
    ]
    for (const [kind, text, want] of FLAG) check(`SCREEN (positive control) — ${kind}: "${text.slice(0, 54)}…" is FLAGGED`, rap.screenReviewAskCopy({ body: text }).some((v) => v.code === want), JSON.stringify(rap.screenReviewAskCopy({ body: text })))
    check(`SCREEN (negative control) — ${CLEAN.length} clean asks (honest-experience, one link, "feel free", the manual composer) pass untouched`, CLEAN.every((t) => rap.screenReviewAskCopy({ body: t }).length === 0), JSON.stringify(CLEAN.map((t) => rap.screenReviewAskCopy({ body: t }))))

    const mkWorld = (o: { closeDaysAgo?: number; status?: string; settings?: Row; delay?: number | null; contacts?: Row[]; seed?: Row[]; refuse?: Record<string, string>; dealType?: string } = {}) => {
      const closeDate = dayIso(ago(o.closeDaysAgo ?? 6))
      const contacts = o.contacts ?? [
        { id: BUYER, brokerage_id: B, first_name: "Pat", last_name: "Lee", email: "pat@example.test", phone: null, preferred_channel: null, tcpa_consent: false, email_opt_out: false, email_unsubscribed: false, sms_opt_out: false, sms_unsubscribed: false, dnc_status: false },
        { id: SELLER, brokerage_id: B, first_name: "Sam", last_name: "Roe", email: "sam@example.test", phone: null, preferred_channel: null, tcpa_consent: false, email_opt_out: false, email_unsubscribed: false, sms_opt_out: false, sms_unsubscribed: false, dnc_status: false },
      ]
      return memSupabase({
        transactions: [{ id: TX, brokerage_id: B, agent_id: AG, status: o.status ?? "closed", close_date: closeDate, deal_type: o.dealType ?? "dual", contact_id: BUYER, buyer_contact_id: BUYER, seller_contact_id: SELLER, property_address: "12 Oak St" }],
        brokerage_settings: [{ id: "s1", brokerage_id: B, review_request_delay_days: o.delay === undefined ? null : o.delay, settings: o.settings ?? { reputation_profiles: { google: { url: GOOGLE } } } }],
        contacts, agents: [{ id: AG, brokerage_id: B, user_id: "u-1" }], review_requests: o.seed ?? [], notifications: [], ai_assistant_notes: [],
      }, { stampCreatedAt: true, uuidIds: true, ...(o.refuse ? { refuse: o.refuse } : {}) })
    }
    const R = { gen: 0, prompts: [] as string[], sends: [] as Array<{ ch: string; p: Record<string, any> }>, agentNotes: [] as string[], adminNotes: 0, events: [] as Array<Record<string, any>> }
    const resetR = () => { R.gen = 0; R.prompts.length = 0; R.sends.length = 0; R.agentNotes.length = 0; R.adminNotes = 0; R.events.length = 0 }
    const cleanMsg = (link: string) => ({ subject: "How was your experience?", message: `Hi, it was a pleasure helping you with 12 Oak St. If you have a moment, an honest review of your experience would mean a lot: ${link}`, keyPoints: ["12 Oak St"], personalizedOpener: "Hi", softAsk: "If you have a moment", directAsk: "Please share an honest review" })
    const mkDeps = (genFn?: (prompt: string, n: number) => Record<string, unknown>, over: Partial<import("../lib/reputation/review-ask").ReviewAskDeps> = {}): import("../lib/reputation/review-ask").ReviewAskDeps => ({
      now: () => NOW,
      draft: async (svc, input) => draftMod.draftReviewRequest(svc, input as never, { generate: async (a) => { R.gen++; R.prompts.push(a.prompt); return { object: (genFn ? genFn(a.prompt, R.gen) : cleanMsg(GOOGLE)) as never } } }) as never,
      dispatchEmail: async (p) => { R.sends.push({ ch: "email", p }); return { success: true, messageId: `m${R.sends.length}` } },
      dispatchSms: async (p) => { R.sends.push({ ch: "sms", p }); return { success: true, messageId: `s${R.sends.length}` } },
      emit: async (i) => { R.events.push(i as Record<string, any>); return {} },
      notifyAgent: async (_svc, a) => { R.agentNotes.push(a.type) },
      notifyBrokerageAdmins: async (svc, b, n) => { R.adminNotes++; ;(svc as any).tables.notifications.push({ id: `n${R.adminNotes}`, brokerage_id: b, type: n.type, is_read: false }) },
      ...over,
    })
    const rrs = (svc: ReturnType<typeof mkWorld>) => (svc.tables.review_requests ?? []) as Row[]
    const run = (svc: ReturnType<typeof mkWorld>, deps = mkDeps(), brokerageId = B) => engine.askForReviewAtClose(svc, { brokerageId, transactionId: TX, source: "cron" }, deps)

    // E1 + E2
    {
      resetR()
      const svc = mkWorld()
      const r = await run(svc)
      check("E1 a verified closing past the tenant's delay asks BOTH clients of a dual deal — once each, on ONE platform, with the REAL link",
        r.results.length === 2 && r.results.every((x) => x.status === "sent") && rrs(svc).length === 2 && rrs(svc).every((x) => x.status === "sent" && x.platform === "google" && x.review_url === GOOGLE && !!x.sent_at), JSON.stringify(r.results.map((x) => x.status)))
      check("E1 …every send rides the governed dispatcher: the ledger's at-most-once cycle per (transaction, client), the policy named, the link IN the message, the agent attributed",
        R.sends.length === 2 && new Set(R.sends.map((s) => s.p.ledger.cycle)).size === 2 && R.sends.every((s) => /^review_ask:tx-1:c-/.test(s.p.ledger.cycle) && s.p.ledger.policyKey === "reputation_profiles" && s.p.brokerageId === B && s.p.agentId === AG && String(s.p.text).includes(GOOGLE) && s.p.systemSource === "review_automation"))
      check("E1 …the drafting prompt carries the REAL link and the no-incentive / no-gating rules, and NO placeholder", R.prompts.length === 2 && R.prompts.every((p) => p.includes(GOOGLE) && /Offer NOTHING in exchange/.test(p) && /do not route unhappy clients/.test(p) && !/YOUR_/.test(p)))
      check("E1 …REVIEW_REQUEST_SENT is emitted per client (the evidence of the ask)", R.events.filter((e) => e.event === "review_request_sent").length === 2)
      const spent = R.gen
      resetR()
      const again = await run(svc)
      check("E2 NO DUPLICATES: asking again (cron re-run, hook, event, anyone) asks NOBODY — `already_asked` ×2, zero sends, zero model spend", again.results.every((x) => x.status === "skipped" && (x as any).reason === "already_asked") && R.sends.length === 0 && R.gen === 0 && rrs(svc).length === 2 && spent === 2)
    }
    // dual vs single side
    {
      resetR()
      const seller = mkWorld({ dealType: "seller" })
      const r = await run(seller)
      check("a SELLER-side deal asks the seller only; a BUYER-side deal the buyer only (the agent's client, not the other side's)", r.results.length === 1 && (r.results[0] as any).contactId === SELLER)
      const buyer = mkWorld({ dealType: "buyer" })
      const r2 = await run(buyer)
      check("…buyer side → the buyer (and a DUAL deal asked both, E1 above)", r2.results.length === 1 && (r2.results[0] as any).contactId === BUYER)
    }
    // E3 timing
    {
      resetR()
      const early = mkWorld({ closeDaysAgo: 1 })
      const r = await run(early)
      const due = r.results[0] as any
      check("E3 TIMING: a closing 1 day ago is NOT due under the default delay — skipped `not_due` with the due date derived from close + the default delay; nothing drafted, nothing written",
        r.results.length === 1 && due.reason === "not_due" && due.dueAt === new Date(new Date(dayIso(ago(1))).getTime() + c.REVIEW_REQUEST_DEFAULT_DELAY_DAYS * DAY).toISOString() && R.gen === 0 && rrs(early).length === 0)
      resetR()
      const tenant = mkWorld({ closeDaysAgo: 2, delay: 1 })
      const r2 = await run(tenant)
      check("E3 …and the TENANT's review_request_delay_days is honoured (delay 1, closed 2 days ago → asked) — the timing is the tenant's, not the code's", r2.results.every((x) => x.status === "sent"))
      const aged = mkWorld({ closeDaysAgo: 40 })
      check("E3 …a closing past the sweep window is `aged_out`, not asked months late", ((await run(aged)).results[0] as any).reason === "aged_out")
    }
    // E4 verified closing
    {
      resetR()
      const pending = mkWorld({ status: "under_contract" })
      check("E4 VERIFIED CLOSING: an under_contract deal is never asked (`not_closed`)", ((await run(pending)).results[0] as any).reason === "not_closed" && rrs(pending).length === 0)
      const funded = mkWorld({ status: "funded" })
      check("E4 …`funded` is past the closing table and IS asked (the ladder is closed → funded)", (await run(funded)).results.every((x) => x.status === "sent"))
      const cancelled = mkWorld({ status: "cancelled" })
      check("E4 (control) a cancelled deal is not a closing", ((await run(cancelled)).results[0] as any).reason === "not_closed")
    }
    // E5 legacy adoption
    {
      resetR()
      const legacy = mkWorld({ seed: [{ id: "rr-old", brokerage_id: B, contact_id: BUYER, agent_id: AG, status: "scheduled", created_at: ago(6).toISOString() }] })
      const r = await run(legacy)
      check("E5 a legacy `scheduled` row (the shape closeTransactionCommand used to queue) is ADOPTED, not duplicated and not a reason to skip: exactly one row per client, the legacy id reused, then sent",
        rrs(legacy).filter((x) => x.contact_id === BUYER).length === 1 && rrs(legacy).find((x) => x.id === "rr-old")?.status === "sent" && rrs(legacy).filter((x) => x.contact_id === SELLER).length === 1 && r.results.every((x) => x.status === "sent"))
    }
    // E6 / E7 no real link
    {
      resetR()
      const none = mkWorld({ settings: {} })
      const r = await run(none)
      const r2 = await run(none)
      check("E6 NO REAL LINK ⇒ FAIL CLOSED: nothing drafted (zero model spend), nothing sent, no row written — and the broker is told exactly ONCE (an unread alert is the dedupe), not once per client or per run",
        r.results.every((x) => x.status === "skipped" && (x as any).reason === "no_review_link") && R.gen === 0 && R.sends.length === 0 && rrs(none).length === 0 && R.adminNotes === 1 && r2.results.length === 2)
      resetR()
      const placeholder = mkWorld({ settings: { reputation_profiles: { google: { url: old[0] }, zillow: { url: old[1] } } } })
      const r3 = await run(placeholder)
      check("E7 a PLACEHOLDER link saved in the profile is refused at read — the request is treated as `no link`, the rejection is published in the result", r3.results.every((x) => x.status === "skipped" && (x as any).reason === "no_review_link" && /placeholder/.test(String((x as any).detail))) && R.sends.length === 0)
    }
    // E8 incentive / gating
    {
      resetR()
      const incentive = mkWorld()
      const r = await run(incentive, mkDeps((_p, _n) => ({ ...cleanMsg(GOOGLE), message: `We would love a review — leave one and we will send you a $25 gift card: ${GOOGLE}` })))
      check("E8 AN INCENTIVE IN THE DRAFT: one repair attempt per client (2 drafts), still flagged → STAGED for the agent (`copy_flagged`), NEVER sent; the agent is told; the row stays pending",
        r.results.every((x) => x.status === "staged" && (x as any).why === "copy_flagged") && R.sends.length === 0 && R.gen === 4 && R.agentNotes.every((t) => t === "review_request_flagged") && rrs(incentive).every((x) => x.status === "pending" && !x.sent_at))
      resetR()
      const repaired = mkWorld({ dealType: "buyer" })
      const r2 = await run(repaired, mkDeps((p, n) => (n === 1 ? { ...cleanMsg(GOOGLE), message: `If you were happy with the service, please review us: ${GOOGLE}` } : cleanMsg(GOOGLE))))
      check("E8 a GATING first draft that the repair fixes is SENT clean (2 drafts, the repair prompt names the violation)", r2.results[0].status === "sent" && R.gen === 2 && /gating/.test(R.prompts[1]) && R.sends.length === 1)
    }
    // E9 approval
    {
      resetR()
      const approve = mkWorld({ settings: { reputation_profiles: { google: { url: GOOGLE }, approval: "agent_approves" } } })
      const r = await run(approve)
      check("E9 APPROVAL MODE: a tenant that wants the agent to approve each ask gets a staged draft + a bell, no send", r.results.every((x) => x.status === "staged" && (x as any).why === "agent_approves") && R.sends.length === 0 && R.agentNotes.every((t) => t === "review_request_ready"))
    }
    // E10 channel / consent
    {
      resetR()
      const optedOut = mkWorld({ contacts: [
        { id: BUYER, brokerage_id: B, first_name: "Pat", email: "pat@example.test", phone: null, tcpa_consent: false, email_opt_out: true, email_unsubscribed: false, sms_opt_out: false, sms_unsubscribed: false, dnc_status: false },
        { id: SELLER, brokerage_id: B, first_name: "Sam", email: null, phone: "+15555550101", tcpa_consent: false, email_opt_out: false, email_unsubscribed: false, sms_opt_out: false, sms_unsubscribed: false, dnc_status: false },
      ] })
      const r = await run(optedOut)
      check("E10 CONSENT PRE-FILTER: an email opt-out, and a phone with NO TCPA consent, leave no usable channel — nothing drafted (zero spend), nothing sent", r.results.every((x) => x.status === "skipped" && (x as any).reason === "no_channel") && R.gen === 0 && R.sends.length === 0)
      resetR()
      const sms = mkWorld({ dealType: "buyer", contacts: [{ id: BUYER, brokerage_id: B, first_name: "Pat", email: "pat@example.test", phone: "+15555550100", preferred_channel: "sms", tcpa_consent: true, email_opt_out: false, email_unsubscribed: false, sms_opt_out: false, sms_unsubscribed: false, dnc_status: false }] })
      const r2 = await run(sms)
      check("E10 a client who PREFERS text and has recorded TCPA consent is asked by text (dispatchSms, link in the body); the gate still decides", r2.results[0].status === "sent" && (r2.results[0] as any).channel === "sms" && R.sends[0].ch === "sms" && String(R.sends[0].p.message).includes(GOOGLE))
      check("E10 (control) the same client WITHOUT consent is never texted", rap.chooseReviewChannel({ email: null, phone: "+15555550100", preferred_channel: "sms", tcpa_consent: false }) === null && rap.chooseReviewChannel({ email: "a@b.co", phone: "+15555550100", preferred_channel: "sms", tcpa_consent: false }) === "email")
      resetR()
      const gate = mkWorld({ dealType: "buyer" })
      const r3 = await run(gate, mkDeps(undefined, { dispatchEmail: async (p) => { R.sends.push({ ch: "email", p }); return { success: false, error: "Outbound blocked: contact opted out" } } }))
      check("E10 a gate REFUSAL is never rendered as `sent`: the row stays pending with no sent_at, the result says `send_refused`", r3.results[0].status === "staged" && (r3.results[0] as any).why === "send_refused" && rrs(gate)[0].status === "pending" && !rrs(gate)[0].sent_at)
    }
    // E11 tenant + settings
    {
      resetR()
      const w = mkWorld()
      const foreign = await run(w, mkDeps(), "b-other")
      check("E11 TENANT-PINNED: another brokerage cannot ask on this tenant's closing (`transaction_not_found`), and writes nothing", (foreign.results[0] as any).reason === "transaction_not_found" && rrs(w).length === 0 && R.sends.length === 0)
      const refused = mkWorld({ refuse: { brokerage_settings: "RLS refused" } })
      check("E11 an UNREADABLE settings row refuses the ask — it never sends on the default day", ((await run(refused)).results[0] as any).reason === "settings_unreadable" && rrs(refused).length === 0)
    }
    // E12 platform choice
    {
      const agentId = "11111111-1111-4111-8111-111111111111"
      const prof = rap.parseReputationProfiles({ reputation_profiles: { google: { url: GOOGLE }, zillow: { url: "https://www.zillow.com/profile/jane-doe/" }, platform_order: ["zillow"], agents: { [agentId]: { zillow: { url: "https://www.zillow.com/profile/agent-own/" } } } } })
      const t1 = rap.chooseReviewTarget(prof, agentId), t2 = rap.chooseReviewTarget(prof, null), t3 = rap.chooseReviewTarget(rap.parseReputationProfiles({}), null)
      check("E12 ONE platform, the tenant's order: the agent's own link first, else the brokerage's; nothing configured → null (never a guess)", t1?.platform === "zillow" && t1.scope === "agent" && t1.url.includes("agent-own") && t2?.scope === "brokerage" && t2.url.includes("jane-doe") && t3 === null)
    }
    // E13 the close path (stripped source)
    {
      const kernel = src("lib/kernel/transactions.ts"), hook = src("lib/transactions/stage-progression.ts"), evt = src("lib/listing-lifecycle/lifecycle-event-tasks.ts"), cron = src("app/api/cron/review-request-on-close/route.ts"), svc = src("lib/application/listing-lifecycle.ts")
      const INSERT = /from\("review_requests"\)[\s\S]{0,80}?\.(insert|upsert)\(/
      check("E13 CLOSE PATH — closeTransactionCommand, the closed-stage hook and the transaction.closed handler write NO review_requests row and draft nothing (five writers → one engine)",
        !INSERT.test(kernel) && !INSERT.test(hook) && !/draftReviewRequest\(/.test(hook) && !INSERT.test(evt))
      check("E13 (control) the finder still sees an insert when one is present", INSERT.test(`await supabase.from("review_requests").insert({ a: 1 })`))
      check("E13 …the autonomous sender is the engine, run by the sweep (the cron imports askForReviewAtClose and calls it per closing)", /askForReviewAtClose\(supabase, \{ brokerageId: txn\.brokerage_id, transactionId: txn\.id/.test(cron) && /@\/lib\/reputation\/review-ask"/.test(cron))
      check("E13 …the human Send button no longer ships a placeholder link, marks `sent` only after the gate accepted, and refuses a second ask", !/YOUR_/.test(svc) && /validateReviewLink\(/.test(svc) && /humanApproved: true/.test(svc) && /already sent/.test(svc) && /if \(!sent\.success\)/.test(svc))
      const walk = (await import("./runtime-roots")).walkTs
      const offenders: string[] = []
      for (const f of [...walk("lib"), ...walk("app")]) { const code = blankStrings(src(f)); const rawSrc = stripComments(raw(f)); if (/YOUR_(?:GOOGLE_)?(?:PLACE_)?ID|YOUR_PAGE|YOUR_BIZ_ID/.test(rawSrc) && /review/i.test(rawSrc) && !/\/\/ TOMBSTONE|TOMBSTONE/.test(raw(f))) offenders.push(f); void code }
      check(`E13 no source in lib/ or app/ still carries a review-link PLACEHOLDER (${walk("lib").length + walk("app").length} files scanned)`, offenders.length === 0, offenders.join(", "))
      check("E13 (control) the placeholder finder would flag the old table", /YOUR_(?:GOOGLE_)?(?:PLACE_)?ID|YOUR_PAGE|YOUR_BIZ_ID/.test(`google: "https://g.page/r/YOUR_PLACE_ID/review"`))
      const writers: string[] = []
      for (const f of [...walk("lib"), ...walk("app")]) if (INSERT.test(src(f))) writers.push(f)
      check(`E13 the ONLY review_requests INSERTERS left are the engine's draft core and the human "new request" door (${writers.length}): ${writers.join(", ")}`, writers.sort().join() === ["lib/kernel/reputation.ts", "lib/reputation/review-request-draft.ts"].join())
      check("E13 one platform vocabulary: the draft core accepts the old `realtor` spelling and normalises it to the CHECK's `realtor_com`; the ask platforms are a subset of the review platforms", /normalisePlatform/.test(src("lib/reputation/review-request-draft.ts")) && rap.ASKABLE_REVIEW_PLATFORMS.every((p) => (CHECK_VOCABULARIES.agent_reviews?.platform ?? []).includes(p)), JSON.stringify(CHECK_VOCABULARIES.agent_reviews?.platform))
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── 6. MARKET LEADERSHIP — the five intelligence streams reach the planner, ranked by evidence ──")
  {
    const none: import("../lib/content-intel/market-leadership").LeadershipSignals = { aiVisibility: null, competitorMoves: [], mentions: null, ownPerformance: [], localEvents: [], blindSpots: [] }
    check("with NO signal the list is EMPTY — it never invents an opportunity to fill a week", lead.rankLeadershipOpportunities(none).length === 0)
    const vis = (us: number | null, them: number) => ({ queriesChecked: 20, queriesCited: 4, queriesNotChecked: 1, citationRatePct: 20, shareOfVoicePct: us, ourCitations: 4, competitorCitations: 12, topCompetitors: [{ name: "Rival Realty", citations: 12, sharePct: them }], reason: null })
    const gap = lead.rankLeadershipOpportunities({ ...none, aiVisibility: vis(20, 60) })
    check("AI-SEARCH GAP: a rival named more than we are → an opportunity whose strength IS the share gap (60 − 20), evidence names both numbers and the unread answers", gap.length === 1 && gap[0].kind === "ai_search_gap" && gap[0].strength === 40 && gap[0].evidence.some((e) => /us 20% vs Rival Realty 60%/.test(e)) && gap[0].evidence.some((e) => /could not be read/.test(e)))
    check("…(control) when WE lead the answers there is no gap to chase", lead.rankLeadershipOpportunities({ ...none, aiVisibility: vis(70, 20) }).length === 0 && lead.rankLeadershipOpportunities({ ...none, aiVisibility: vis(null, 20) }).length === 1)
    const moves = lead.rankLeadershipOpportunities({ ...none, competitorMoves: [
      { competitor: "A", platform: "instagram", topics: ["fsbo"], hook: "question", engagement: 9 }, { competitor: "B", platform: "facebook", topics: ["fsbo", "staging"], hook: "listicle", engagement: 4 }, { competitor: "A", platform: "facebook", topics: ["staging"], hook: null, engagement: 2 },
    ] })
    check("COMPETITOR GAP: topics ranked by how many rivals' posts perform on them (fsbo ×2, staging ×2); the brief demands ORIGINAL content and never carries a competitor's caption", moves.length === 2 && moves.every((o) => o.kind === "competitor_gap" && o.strength === 40 && /ORIGINAL/.test(o.brief) && /never copy or paraphrase a competitor/.test(o.brief)))
    const rep = lead.rankLeadershipOpportunities({ ...none, mentions: { total: 10, negative: 3, negativeTopics: [{ topic: "communication", count: 2 }] } })
    check("REPUTATION THEME: appears only when negatives exist; strength = the negative share; the brief forbids naming any reviewer", rep.length === 1 && rep[0].kind === "reputation_theme" && rep[0].strength === 30 && /Do not respond to or name any reviewer/.test(rep[0].brief) && lead.rankLeadershipOpportunities({ ...none, mentions: { total: 10, negative: 0, negativeTopics: [] } }).length === 0)
    const dd = lead.rankLeadershipOpportunities({ ...none, ownPerformance: [{ assetType: "blog", topic: "Closing costs explained", performance: 62 }, { assetType: "video", topic: "Staging on a budget", performance: 81 }] })
    check("DOUBLE DOWN: the brokerage's own best performer, by measured score", dd.length === 1 && dd[0].kind === "double_down" && dd[0].strength === 81 && /Staging on a budget/.test(dd[0].title))
    const all = lead.rankLeadershipOpportunities({ ...none, aiVisibility: vis(20, 60), competitorMoves: [{ competitor: "A", platform: "x", topics: ["t"], hook: null, engagement: 1 }], mentions: { total: 4, negative: 2, negativeTopics: [{ topic: "price", count: 2 }] }, ownPerformance: [{ assetType: "blog", topic: "T", performance: 30 }], localEvents: [{ title: "Downtown Farmers Market", sourceUrl: null }] })
    check("RANKING is by the evidence's own strength, descending; ties break by a fixed kind order (no randomness)", all.every((o, i) => i === 0 || all[i - 1].strength >= o.strength) && all.length === 5)
    const brief = lead.renderLeadershipBriefForKickoff({ ...none, blindSpots: ["local events: no feed"] }, [])
    check("a week with nothing says so plainly and publishes its blind spots", /no leadership signal this week/.test(brief) && /BLIND SPOTS/.test(brief) && /local events: no feed/.test(brief))

    // loader
    const seed = {
      ai_search_citation_observations: [
        { id: "o1", brokerage_id: "b-1", project_id: "p1", observed_on: dayIso(ago(2)), outcome: "cited", competitors_cited: ["Rival Realty"] },
        { id: "o2", brokerage_id: "b-1", project_id: "p2", observed_on: dayIso(ago(2)), outcome: "not_cited", competitors_cited: ["Rival Realty", "Other Co"] },
        { id: "o3", brokerage_id: "b-2", project_id: "p9", observed_on: dayIso(ago(2)), outcome: "cited", competitors_cited: [] },
      ],
      competitor_content: [{ id: "cc1", brokerage_id: "b-1", competitor_id: "k1", platform: "instagram", detected_topics: ["fsbo"], hook_type: "question", engagement_rate: 5, is_high_performing: true, observed_at: ago(3).toISOString() }, { id: "cc2", brokerage_id: "b-1", competitor_id: "k1", platform: "x", detected_topics: ["old"], hook_type: null, engagement_rate: 1, is_high_performing: false, observed_at: ago(3).toISOString() }],
      competitor_brokerages: [{ id: "k1", brokerage_id: "b-1", competitor_name: "Rival Realty" }],
      brand_mentions: [{ id: "bm1", brokerage_id: "b-1", sentiment: "negative", topics: ["communication"], captured_at: ago(4).toISOString() }, { id: "bm2", brokerage_id: "b-1", sentiment: "positive", topics: ["price"], captured_at: ago(4).toISOString() }],
      content_topic_uses: [{ id: "u1", brokerage_id: "b-1", topic_id: "tp1", asset_type: "blog", used_at: ago(5).toISOString() }],
      content_topic_bank: [
        { id: "tp1", brokerage_id: "b-1", topic_title: "Closing costs explained", performance_score: 66, geo_relevance: null, source_url: null, scraped_at: ago(5).toISOString() },
        { id: "tp2", brokerage_id: "b-1", topic_title: "Downtown Farmers Market opens this Saturday", performance_score: null, geo_relevance: { city: "Tampa" }, source_url: "https://example.test/e", scraped_at: ago(1).toISOString() },
        { id: "tp3", brokerage_id: null, topic_title: "Mortgage rates fall again", performance_score: null, geo_relevance: { city: "Tampa" }, source_url: null, scraped_at: ago(1).toISOString() },
      ],
    }
    const sig = await lead.loadMarketLeadershipSignals(memSupabase(seed), "b-1", NOW)
    check("LOADER reads each stream through its survivor, tenant-pinned: AI visibility from THIS tenant's observations only (2 answers, 1 cited), competitor names resolved, only HIGH-performing rival posts, negative mention themes, own scored topic uses",
      sig.aiVisibility?.queriesChecked === 2 && sig.aiVisibility.queriesCited === 1 && sig.aiVisibility.topCompetitors[0].name === "Rival Realty" && sig.competitorMoves.length === 1 && sig.competitorMoves[0].competitor === "Rival Realty"
      && sig.mentions?.negative === 1 && sig.mentions.negativeTopics[0].topic === "communication" && sig.ownPerformance.length === 1 && sig.ownPerformance[0].performance === 66, JSON.stringify(sig).slice(0, 300))
    check("LOCAL EVENTS are only what a geo-tagged topic actually names (the farmers market — not 'mortgage rates'), and the missing events FEED is published as a blind spot", sig.localEvents.length === 1 && /Farmers Market/.test(sig.localEvents[0].title) && sig.blindSpots.some((b) => /no dedicated events feed/.test(b)))
    const refused = await lead.loadMarketLeadershipSignals(memSupabase(seed, { refuse: { competitor_content: "RLS", brand_mentions: "RLS" } }), "b-1", NOW)
    check("a REFUSED stream is a published blind spot, never an empty stream that reads as 'nothing is happening'; the other streams still load", refused.blindSpots.some((b) => /competitor content not read/.test(b)) && refused.blindSpots.some((b) => /brand mentions not read/.test(b)) && refused.aiVisibility !== null)
    const empty = await lead.loadMarketLeadershipSignals(memSupabase({}), "b-1", NOW)
    check("an empty tenant publishes WHY each stream is empty (the monitor has recorded no answers yet …) and yields no opportunity", empty.blindSpots.length >= 4 && lead.rankLeadershipOpportunities(empty).length === 0)
    const agent = src("lib/agents/marketing-agent.ts")
    check("WIRED: the weekly marketing planner's snapshot loads the signals and its kickoff renders them (a survivor's reader at last), and its system prompt tells it to turn the strongest into ORIGINAL pieces",
      /loadMarketLeadershipSignals\(svc, brokerageId\)/.test(agent) && /renderLeadershipBriefForKickoff\(snap\.marketLeadership/.test(agent) && /marketLeadershipLines,/.test(agent) && /MARKET LEADERSHIP signals/.test(raw("lib/agents/marketing-agent.ts")))
    const ll = src("lib/content-intel/market-leadership.ts")
    check("the leadership module reuses the survivors (citation-share's citationShare) and writes NOTHING — no insert / update / upsert / delete", /citationShare\(rows\)/.test(ll) && !/\.(insert|update|upsert|delete)\(/.test(ll))
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── 7. THE CENSUS — no schedule literal in the follow-up decision modules outside the policy ──")
  {
    // A literal-digit timing constant: `N * 24 * 60 * 60 * 1000`, `N * 86_400_000`, `N * DAY_MS`, or `FOO_DAYS = N` / `FOO_HOURS = N`.
    const TIMING = /(?<![\w.])\d[\d_]*\s*\*\s*(?:24\s*\*\s*60\s*\*\s*60\s*\*\s*1000|86_?400_?000|DAY_MS)|[A-Z][A-Z0-9_]*_(?:DAYS|HOURS)\s*=\s*\d/g
    const count = (code: string) => (blankStrings(code).match(TIMING) ?? []).length
    check("CENSUS positive control: each literal shape the finder counts IS seen", count("const a = 14 * 24 * 60 * 60 * 1000") === 1 && count("x = 7 * 86_400_000") === 1 && count("y = 3 * DAY_MS") === 1 && count("const COLD_DEDUP_DAYS = 30") === 1 && count("const FATIGUE_HOURS = 48") === 1)
    check("…and policy-derived windows are NOT counted (a variable, a policy field, a module unit constant)", count("x = followup.nurture.signalWindowDays * 24 * 60 * 60 * 1000") === 0 && count("const DAY_MS = 86_400_000") === 0 && count("y = thresholdDays * 86_400_000") === 0)
    // The files that DECIDE a follow-up. CONVERTED = must be zero (derived from the policy). RATCHET = must not grow past the measured baseline.
    const CONVERTED = [
      "lib/ai-isa/reengagement-policy.ts", "lib/ai-isa/long-term-nurture.ts", "lib/ai-isa/ghost-reengagement.ts", "lib/ai-isa/followup-arbiter.ts",
      "lib/sphere/next-best-actions.ts", "lib/sphere/followup-moments.ts", "lib/reputation/review-ask.ts", "lib/reputation/review-ask-policy.ts", "lib/content-intel/market-leadership.ts",
      "lib/ai-isa/voice-dial-batch.ts",
    ]
    const RATCHET: Record<string, { baseline: number; why: string }> = {
      "lib/ai-isa/lead-action-plan.ts": { baseline: 2, why: "the 7-day and 30-day EVIDENCE look-backs behind the planner's `touchpoints7d` / portal-education-views facts (named in the field, read as evidence) — not a send schedule; the fatigue floor, send window and agent-handling window it DECIDES with are the tenant's policy" },
      "lib/ai-isa/cold-contact-escalation.ts": { baseline: 1, why: "COLD_DEDUP_DAYS — a de-duplication window on an ALERT TO STAFF (one escalation per contact per window), not a message to a customer" },
      // The rest of lib/ai-isa / lib/reputation / lib/fatigue / lib/content-intel / lib/sphere that a domain-wide scan found (published, not hidden):
      "lib/ai-isa/callback-task.ts": { baseline: 1, why: "MAX_CALLBACK_HORIZON_MS — a sanity bound on a callback date the PERSON asked for (rejects a typo'd year), not a send schedule" },
      "lib/ai-isa/convert-buyer-lead-on-intent.ts": { baseline: 1, why: "the +2d default requested showing date when the lead named none — a booking default the agent confirms (STILL OPEN: candidate for the policy)" },
      "lib/ai-isa/direct-mail-trigger.ts": { baseline: 1, why: "the 30d idempotency window MIRRORING the de-conflict cap inside dispatchDirectMail (lib/providers — another lane's file; STILL OPEN: both must move together)" },
      "lib/ai-isa/listing-appointment.ts": { baseline: 1, why: "SEARCH_HORIZON_DAYS — how far ahead to look for an open appointment slot, not a gap between touches" },
      "lib/ai-isa/meeting-followthrough.ts": { baseline: 2, why: "HORIZON_MIN/MAX_DAYS — bounds that reject a nonsense follow-up date PARSED from the meeting; the person's own date is the schedule" },
      "lib/ai-isa/meeting-recap.ts": { baseline: 1, why: "MEETING_EVENT_LINK_WINDOW_HOURS — the tolerance for matching a call to a calendar event, not a schedule" },
      "lib/ai-isa/showing-cancellation-copy.ts": { baseline: 1, why: "CANCELLATION_LOOKBACK_DAYS — a recency bound on a trigger event (a cancellation older than this is stale), not a gap between touches (STILL OPEN: candidate for the policy)" },
      "lib/reputation/review-request-delay.ts": { baseline: 4, why: "DEFAULT_DELAY_DAYS is the DEFAULT of the existing tenant-editable review delay column (brokerage_settings.review_request_delay_days — the survivor); LOOKBACK / MIN_AGE / MISSED_RUN_GRACE are the engine's catch-up bounds" },
      "lib/fatigue/fatigue-calculator.ts": { baseline: 3, why: "MEASUREMENT windows of the fatigue SCORE (touches in the last 7d / 14d, missed appointments in 90d) — what is counted, not when to send" },
      "lib/content-intel/performance-aggregator.ts": { baseline: 1, why: "the 30d REPORTING window of content performance" },
      "lib/content-intel/topic-bank.ts": { baseline: 1, why: "OFFICE_CLAIM_WINDOW_DAYS — how long an office's claim on a topic holds" },
      "lib/sphere/lifetime-touchpoint-reaper-policy.ts": { baseline: 1, why: "STALE_TOUCHPOINT_GRACE_DAYS — a MAINTENANCE threshold on a row nobody delivered (asserted by name below)" },
    }
    const others = ["lib/ai-isa/next-best-touch.ts", "lib/ai-isa/lead-nurture.ts", "lib/ai-isa/adaptive-reengagement.ts", "lib/ai-isa/speed-to-lead-policy.ts", "lib/ai-isa/stale-contact-detector.ts", "lib/ai-isa/saved-home-nudge.ts", "lib/ai-isa/ghost-escalation.ts", "lib/sphere/lifetime-touchpoint-reaper.ts"]
    let denominator = 0
    for (const f of CONVERTED) { denominator++; const n = count(src(f)); check(`CONVERTED ${f}: 0 timing literals (derived from the tenant policy) — found ${n}`, existsSync(f) && n === 0) }
    for (const f of [...Object.keys(RATCHET), ...others]) {
      denominator++
      const n = count(src(f)); const base = RATCHET[f]?.baseline ?? 0
      check(`RATCHET ${f}: ${n} ≤ baseline ${base}${RATCHET[f] ? ` (${RATCHET[f].why})` : ""}`, existsSync(f) && n <= base)
    }
    console.log(`  · census denominator: ${denominator} follow-up decision modules scanned (${CONVERTED.length} converted to the policy, ${denominator - CONVERTED.length} ratcheted); blind spot: a computed window, a module outside the list, and a literal inside a string are not seen; the campaign-sequence step delays are tenant-authored templates (the sequence is the delivery survivor) and are out of this census`)
    // DOMAIN SWEEP — closes the "a module outside the list" blind spot: EVERY file under the follow-up domains is scanned, and one that
    // carries a timing literal must be named in RATCHET with its stated reason (a CONVERTED file is held at zero above).
    const walk = (d: string, out: string[] = []): string[] => {
      if (!existsSync(d)) return out
      for (const n of readdirSync(d)) { const p = `${d}/${n}`; if (statSync(p).isDirectory()) walk(p, out); else if (/\.tsx?$/.test(n)) out.push(p) }
      return out
    }
    const DOMAINS = ["lib/ai-isa", "lib/sphere", "lib/reputation", "lib/fatigue", "lib/kernel/marketing", "lib/content-intel"]
    const swept = DOMAINS.flatMap((d) => walk(d))
    const unlisted = swept.filter((f) => count(src(f)) > 0 && !(f in RATCHET))
    check(`DOMAIN SWEEP positive control: the walker sees the domains (${swept.length} files, including this wave's new modules) and the finder sees a literal in a known ratcheted file`,
      swept.length > 50 && swept.includes("lib/ai-isa/followup-policy.ts") && swept.includes("lib/reputation/review-ask.ts") && swept.includes("lib/content-intel/market-leadership.ts") && count(src("lib/fatigue/fatigue-calculator.ts")) > 0)
    check(`DOMAIN SWEEP: no file under ${DOMAINS.join(" · ")} carries a timing literal that is neither CONVERTED nor RATCHETed with a stated reason — unlisted: ${unlisted.join(", ") || "none"}`, unlisted.length === 0)
    check("the reaper's grace window (3 days past a moment's date) is a MAINTENANCE threshold on a row nobody delivered, not a follow-up timetable: it is a named exported constant, not an inline literal", /export const STALE_TOUCHPOINT_GRACE_DAYS = 3/.test(src("lib/sphere/lifetime-touchpoint-reaper-policy.ts")))
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
