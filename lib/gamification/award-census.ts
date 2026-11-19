// lib/gamification/award-census.ts
// ─────────────────────────────────────────────────────────────────────────────
// WAVE 154 (lane 154E — owner: "why is the gamification award function retired? that function needs to work.")
//
// THE AWARD CENSUS: for every reason the ledger can carry, WHERE the trusted business event comes from and HOW MUCH it can
// be trusted. Pure data, importable from a Client Component (award-points.ts imports it to decide what a surface may
// ADVERTISE). It deliberately does NOT declare a state: scripts/gamification-guard.ts DERIVES each reason's state —
// WORKING / NO EMITTER / EMITTER NOT WIRED / ADVERTISED BUT UNEARNABLE / EARNABLE BUT NOT SHOWN — from this census, the
// live LIFECYCLE_AWARD_RULES, the advertised list, and the emitter patterns found in STRIPPED source. A census row that
// names an emitter the source no longer carries turns the guard red, so this table cannot drift from the code.

import type { PointReason } from "./award-points"

/**
 * How far the triggering moment can be trusted as a REAL outcome.
 *   verified_outcome — a third party, a provider, the stage machine or a cron proves it (a close, a published post with an
 *                      external id, an accredited CE webhook, a client-authored review, a system-matched mentor pairing).
 *   bounded_self     — the seat performs it, but the award is bounded so it cannot be farmed (once per onboarding step,
 *                      once per agent for life).
 *   booking_only     — the event is a BOOKING, not a held outcome. Earnable (bounded), never advertised.
 *   self_attested    — the seat merely asserts it (types a number, posts a watch percentage, creates its own record).
 *                      NEVER wired to an award: that is the hole wave 153 closed.
 *   none             — no event exists at all.
 */
export type AwardTrust = "verified_outcome" | "bounded_self" | "booking_only" | "self_attested" | "none"

export interface AwardCensusRow {
  reason: PointReason | "CHALLENGE_PRIZE" | "ADMIN_ADJUSTMENT"
  /** How the award is reached: the event reactor (a LIFECYCLE_AWARD_RULES row), a call site, or nothing. */
  path: "reactor" | "call_site" | "none"
  /** The business moment, in words. */
  trigger: string
  /** file + a code token the guard must find in that file's STRIPPED source (proves the emitter / caller still stands). */
  emitters: ReadonlyArray<{ file: string; token: string }>
  trust: AwardTrust
  /** How the earning agents.id is reached (agents.id and users.id are DISJOINT — cross via agents.user_id). */
  agent: string
  /** Set when an owner decision is required before this reason can be earned or advertised. */
  ownerDecision?: string
}

export const AWARD_CENSUS: readonly AwardCensusRow[] = [
  { reason: "LISTING_CLOSED", path: "reactor", trigger: "TRANSACTION_CLOSED — the kernel close command or the gated stage machine", trust: "verified_outcome",
    emitters: [{ file: "lib/kernel/transactions.ts", token: "KernelEvent.TRANSACTION_CLOSED" }, { file: "lib/transactions/stage-progression.ts", token: "KernelEvent.TRANSACTION_CLOSED" }],
    agent: "transactions.agent_id (entity transaction)" },
  { reason: "FIRST_CLOSE", path: "reactor", trigger: "the agent's first TRANSACTION_CLOSED, once for life", trust: "verified_outcome",
    emitters: [{ file: "lib/kernel/transactions.ts", token: "KernelEvent.TRANSACTION_CLOSED" }, { file: "lib/transactions/stage-progression.ts", token: "KernelEvent.TRANSACTION_CLOSED" }],
    agent: "transactions.agent_id" },
  { reason: "REPEAT_CLIENT_CLOSED", path: "reactor", trigger: "TRANSACTION_CLOSED where either contact already closed with this agent", trust: "verified_outcome",
    emitters: [{ file: "lib/kernel/transactions.ts", token: "KernelEvent.TRANSACTION_CLOSED" }], agent: "transactions.agent_id + prior closed/funded transaction" },
  { reason: "REFERRAL_CONVERTED", path: "reactor", trigger: "a referral marked won AND evidenced by a closed/funded transaction (referrals.transaction_id or the referred contact on the deal); or that deal closing after the referral was won — once per transaction", trust: "verified_outcome",
    emitters: [{ file: "app/actions/referrals/referral-actions.ts", token: "KernelEvent.REFERRAL_CONVERTED" }, { file: "lib/kernel/transactions.ts", token: "KernelEvent.TRANSACTION_CLOSED" }],
    agent: "referrals.agent_id" },
  { reason: "SHOWING_COMPLETED", path: "reactor", trigger: "a real showings row marked completed (never a requested or proposed slot)", trust: "verified_outcome",
    emitters: [{ file: "app/actions/showings.ts", token: "KernelEvent.SHOWING_COMPLETED" }, { file: "app/actions/seller-showings.ts", token: "KernelEvent.SHOWING_COMPLETED" }],
    agent: "metadata.agent_id, else showings.agent_id" },
  { reason: "OFFER_SUBMITTED", path: "reactor", trigger: "the buyer lifecycle crossing into BUYER_OFFER_SUBMITTED — once per buyer contact", trust: "verified_outcome",
    emitters: [{ file: "lib/buyer-lifecycle/lifecycle-logger.ts", token: "KernelEvent.OFFER_SUBMITTED" }], agent: "contacts.agent_id (entity buyer_lifecycle)" },
  { reason: "SOCIAL_POST_PUBLISHED", path: "reactor", trigger: "the publisher cron posted an APPROVED post and got an external post id", trust: "verified_outcome",
    emitters: [{ file: "app/api/cron/publish-social-posts/route.ts", token: "KernelEvent.SOCIAL_POST_PUBLISHED" }], agent: "social_posts.agent_id, else social_posts.user_id → agents.user_id" },
  { reason: "CLIENT_REVIEW_RECEIVED", path: "reactor", trigger: "the CLIENT (isContactSelf) submits a review or testimonial; rating null (testimonial) or ≥ 4 — once per client per year", trust: "verified_outcome",
    emitters: [{ file: "lib/reputation/review-landed.ts", token: "KernelEvent.REVIEW_RECEIVED" }, { file: "app/actions/portal-lifetime.ts", token: "onReviewLanded(" }, { file: "app/actions/multi-persona.ts", token: "onReviewLanded(" }],
    agent: "agent_reviews.agent_id (entity agent_review)" },
  { reason: "CERTIFICATION_EARNED", path: "reactor", trigger: "awardCertification inserts an agent_certifications row after a SERVER re-check of eligibility (once per certification name)", trust: "verified_outcome",
    emitters: [{ file: "lib/onboarding/certification-engine.ts", token: "KernelEvent.CERTIFICATION_AWARDED" }], agent: "agent_certifications.agent_id" },
  { reason: "CE_COMPLETED", path: "reactor", trigger: "an accredited CE provider webhook records a NEW agent_ce_completions row", trust: "verified_outcome",
    emitters: [{ file: "app/actions/ce-provider.ts", token: "KernelEvent.CE_COMPLETED" }], agent: "metadata.agent_id (provider-resolved)" },
  { reason: "COMPETENCY_IMPROVED", path: "reactor", trigger: "the adaptive development radar measured a competency RISE — once per competency per year", trust: "verified_outcome",
    emitters: [{ file: "lib/education/skill-freshness-radar.ts", token: "KernelEvent.COMPETENCY_IMPROVED" }], agent: "metadata.agent_id" },
  { reason: "MENTOR_SESSION_HELD", path: "reactor", trigger: "a session logged by a PARTY to an ACTIVE system-matched mentor pairing — both parties, once per pairing per ISO week", trust: "verified_outcome",
    emitters: [{ file: "app/actions/onboarding/mentor-session.ts", token: "KernelEvent.MENTOR_SESSION_HELD" }], agent: "metadata.mentor_agent_id + mentee_agent_id (from agent_mentor_relationships)" },
  { reason: "ONBOARDING_COMPLETED", path: "reactor", trigger: "the agent onboarding completion edge (false → true) or completeOnboarding — once for life", trust: "bounded_self",
    emitters: [{ file: "lib/kernel/agent-onboarding.ts", token: "KernelEvent.ONBOARDING_COMPLETED" }, { file: "lib/onboarding/certification-engine.ts", token: "KernelEvent.ONBOARDING_COMPLETED" }, { file: "lib/kernel/onboarding.ts", token: "KernelEvent.USER_ONBOARDING_COMPLETED" }],
    agent: "agent_onboarding.agent_id / users.id → agents.user_id" },
  { reason: "ONBOARDING_STEP_COMPLETED", path: "reactor", trigger: "an onboarding step completed — once per step uuid", trust: "bounded_self",
    emitters: [{ file: "lib/kernel/onboarding.ts", token: "KernelEvent.USER_ONBOARDING_STEP_COMPLETED" }], agent: "users.id → agents.user_id" },
  { reason: "FIRST_CONTACT", path: "reactor", trigger: "the agent's first CONTACT_CREATED, once for life (never a sale milestone)", trust: "bounded_self",
    emitters: [{ file: "lib/kernel/crm.ts", token: "KernelEvent.CONTACT_CREATED" }], agent: "contacts.agent_id" },
  // WAVE 155 (155C — owner R3 "appt with a signed agreement"): the booking award is RETIRED (no rule); the appointment earns
  // only as SIGNED_AGREEMENT_APPOINTMENT below. Kept here because historical ledger rows may carry the reason.
  { reason: "FIRST_APPOINTMENT", path: "none", trigger: "RETIRED (owner R3): ISA_APPOINTMENT_SCHEDULED is a BOOKING — a booked or held appointment alone earns nothing", trust: "booking_only",
    emitters: [{ file: "lib/ai-isa/appointment-scheduler.ts", token: "KernelEvent.ISA_APPOINTMENT_SCHEDULED" }], agent: "—" },
  { reason: "SIGNED_AGREEMENT_APPOINTMENT", path: "reactor", trigger: "an EXECUTED listing agreement (both signatures + compliance passed) or buyer agreement (provider / click-through, or a recorded wet signature WITH the document) preceded by a genuine, held appointment by that agent with that client — once per agreement (the root of a correction chain). The listing emit reaches the reactor; the buyer emit is an outside-lane request (lane 155C notes)", trust: "verified_outcome",
    emitters: [{ file: "app/actions/seller-listing/execution-engine.ts", token: "KernelEvent.LISTING_AGREEMENT_SIGNED" }], agent: "listings.agent_id / buyer_broker_agreements.agent_id (from the evidence row, never the payload)" },
  { reason: "WORK_ANNIVERSARY", path: "reactor", trigger: "the weekly recruit-outreach cron finds a work anniversary — once per year", trust: "verified_outcome",
    emitters: [{ file: "lib/gamification/work-anniversaries.ts", token: "KernelEvent.AGENT_WORK_ANNIVERSARY" }], agent: "entity agent" },
  { reason: "LIFETIME_TOUCHPOINT_KEPT", path: "reactor", trigger: "a lifetime touch actually SENT (the one sent-row ledger) — once per client per year", trust: "verified_outcome",
    emitters: [{ file: "lib/sphere/lifetime-touchpoint-ledger.ts", token: "KernelEvent.LIFETIME_CUSTOMER_TOUCHPOINT_SENT" }], agent: "metadata.agent_id" },
  { reason: "SELLER_LIFETIME_TRANSITION", path: "reactor", trigger: "the seller's post-close lifetime transition (side seller)", trust: "verified_outcome",
    emitters: [{ file: "lib/application/listing-lifecycle.ts", token: "KernelEvent.LIFETIME_CUSTOMER" }], agent: "metadata.agent_id" },
  { reason: "CONTACT_ASSIGNED", path: "call_site", trigger: "an authorized reassignment moves a contact to the agent", trust: "verified_outcome",
    emitters: [{ file: "app/actions/contact-reassignment.ts", token: "awardAgentPoints(svc," }], agent: "input.toAgentId, proven in-tenant and active before the move" },
  { reason: "CHALLENGE_PRIZE", path: "call_site", trigger: "a broker-created challenge ends; the cron scores it and pays the configured prize — once per challenge per winner", trust: "verified_outcome",
    emitters: [{ file: "lib/recruiting/challenge-runner.ts", token: "awardAgentPointsOnce(svc," }], agent: "challenge_participants.agent_id" },
  { reason: "ADMIN_ADJUSTMENT", path: "call_site", trigger: "a tenant admin's audited correction (reason + action ledger), never to their own record", trust: "verified_outcome",
    emitters: [{ file: "app/actions/gamification.ts", token: "awardAgentPointsOnce(svc," }], agent: "agents.id read in the session's tenant" },
  // ── no trusted event — NOT wired, NOT advertised ──
  { reason: "REFERRAL_CREATED", path: "none", trigger: "createReferral — the seat types its own referral record (any number of them)", trust: "self_attested",
    emitters: [{ file: "app/actions/referrals/referral-actions.ts", token: "KernelEvent.REFERRAL_RECEIVED" }], agent: "referrals.agent_id",
    ownerDecision: "A referral is credited when it CLOSES (REFERRAL_CONVERTED, evidenced). Points for merely entering one need a third-party author (a partner-portal submission) first." },
  // WAVE 155 (155C): the two former owner questions, answered by the owner (R1, R2) and moved up into the verified rows.
  { reason: "TRAINING_COMPLETED", path: "reactor", trigger: "a course quiz PASSED — graded on the server by gradeQuiz from the stored questions at the course threshold, persisted, once per course (the watched-video emitter, entity 'agent', never earns)", trust: "verified_outcome",
    emitters: [{ file: "app/actions/academy-learning.ts", token: "KernelEvent.TRAINING_COURSE_COMPLETED" }, { file: "lib/academy/course-completion.ts", token: "gradeQuiz(questions, clean" }],
    agent: "metadata.agent_id, re-verified through agents.user_id → the learner's persisted passing attempt" },
  { reason: "OPEN_HOUSE_HOSTED", path: "reactor", trigger: "an open house HELD — the host ends it (or the post-event sweep finds a sign-in), never from draft or cancelled; one per listing + date (a duplicate calendar row counts once); sign-ins and RSVPs stay a separate analytic", trust: "verified_outcome",
    emitters: [{ file: "lib/gamification/lifecycle-awards.ts", token: "KernelEvent.LISTING_OPEN_HOUSE_COMPLETED" }, { file: "app/actions/seller-open-house.ts", token: "recordOpenHouseHeld(" }, { file: "app/actions/open-house-automation.ts", token: "recordOpenHouseHeld(" }],
    agent: "open_house_events.agent_id of the canonical held row" },
  { reason: "VENDOR_REVIEW_WRITTEN", path: "none", trigger: "VENDOR_REVIEW_SUBMITTED is in the enum and nothing emits it", trust: "none", emitters: [], agent: "—",
    ownerDecision: "Should an agent earn points for reviewing a vendor (submitVendorReview, verified when a party to the deal)?" },
  { reason: "FOLLOWUP_SENT", path: "none", trigger: "no follow-up-sent event exists", trust: "none", emitters: [], agent: "—",
    ownerDecision: "No trusted follow-up outcome exists; retire the reason or name the event." },
  { reason: "CAP_HIT", path: "none", trigger: "KernelEvent.CAP_HIT has no emitter", trust: "none", emitters: [], agent: "—",
    ownerDecision: "A commission-cap award would tie points to compensation — confirm it stays unearned." },
]
