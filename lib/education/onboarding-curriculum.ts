// lib/education/onboarding-curriculum.ts
//
// TIER ONBOARDING CURRICULUM (recruiting_manager) — the OS trains the humans the moment they subscribe.
// When a brokerage signs up (solo agent / team / brokerage / multi-location), the platform already
// assigns its published library, but the differentiator is that the OS AUTHORS a rich, tier- and
// role-appropriate onboarding path out of the gate: platform + AI-team orientation, negotiation tactics,
// persona playbooks, real-estate guidance — plus tier-specific material (solo pipeline; team leadership;
// broker recruiting/compliance/development; multi-office ops). Each topic becomes a gated learning_modules
// draft (status pending_review, is_ai_generated) which the existing approve/publish + learning-router then
// deliver to the right role. Idempotent per topic. Reuses the curriculum author's model + renderer — one
// education system, no parallel path.

import { createServiceClient } from "@/lib/supabase/service"
import { authorModuleFor, persistOnboardingModule } from "@/lib/education/onboarding-authoring"

type Svc = ReturnType<typeof createServiceClient>

export type Tier = "solo_agent" | "team" | "brokerage" | "multi_location"

export interface OnboardingTopic {
  key: string
  label: string
  /** learning_modules.audience_roles this topic trains. */
  audienceRoles: string[]
  /** A one-line brief that grounds the model (what this module must teach). */
  brief: string
}

/** Topics every tier gets (agent-facing core). */
const CORE: OnboardingTopic[] = [
  { key: "platform_tour", label: "Meet your AI team: the command center tour", audienceRoles: ["agent", "broker"], brief: "Orient a brand-new user to the one command center and the eleven AI managers — what each manager does and how gated approvals work." },
  { key: "working_with_managers", label: "Working WITH your AI managers", audienceRoles: ["agent"], brief: "How to review and approve gated proposals, hand work to the managers, and let the AI team reduce busywork without losing control." },
  { key: "negotiation_tactics", label: "Negotiation tactics that win in this market", audienceRoles: ["agent"], brief: "Concrete negotiation scripts and tactics for offers, counteroffers, and multiple-offer situations — real phrasings, not theory." },
  { key: "persona_playbook", label: "Reading client personas and adapting your approach", audienceRoles: ["agent"], brief: "How to identify a client's persona (first-time, military/VA, downsizing senior, divorce, foreclosure, probate, FSBO) and tailor communication + guidance to each." },
  { key: "guidance_essentials", label: "Real-estate guidance essentials", audienceRoles: ["agent"], brief: "Fiduciary duty, disclosures, fair-housing language, and the guidance an agent must give at each stage — practical and compliant." },
]

/** Tier-specific additions. */
const BY_TIER: Record<Tier, OnboardingTopic[]> = {
  solo_agent: [
    { key: "solo_pipeline", label: "Filling your pipeline solo", audienceRoles: ["agent"], brief: "How the scrape-to-lead engine + AI ISA fill a solo agent's pipeline across all lead tiers, and how to work it end to end." },
    { key: "self_marketing", label: "Marketing yourself on autopilot", audienceRoles: ["agent"], brief: "Using the built-in listing/social/video marketing so a solo agent markets like a team." },
  ],
  team: [
    { key: "team_collaboration", label: "Working as a team", audienceRoles: ["agent"], brief: "Shared pipeline, lead distribution, and hand-offs so a team collaborates without dropping the ball." },
    { key: "team_leadership", label: "Leading a team", audienceRoles: ["team_lead"], brief: "Capacity balancing, mentoring, accountability, and reading the team's dashboards to keep everyone producing." },
  ],
  brokerage: [
    { key: "recruiting_growth", label: "Growing your brokerage: recruiting + revenue share", audienceRoles: ["broker"], brief: "Using the recruiting scouts, switch-propensity, and the agent-to-agent revenue-share engine to grow the network." },
    { key: "compliance_oversight", label: "Broker oversight: compliance & risk", audienceRoles: ["broker"], brief: "How the Compliance Officer surfaces flags, license readiness, and TRID deadlines — and the broker's role in resolving them." },
    { key: "agent_development", label: "Developing your agents", audienceRoles: ["broker"], brief: "Onboarding, mentorship, skill-freshness, and retention save-plays to develop and keep agents." },
  ],
  multi_location: [
    { key: "recruiting_growth", label: "Growing your brokerage: recruiting + revenue share", audienceRoles: ["broker"], brief: "Using the recruiting scouts, switch-propensity, and the agent-to-agent revenue-share engine to grow the network." },
    { key: "compliance_oversight", label: "Broker oversight: compliance & risk", audienceRoles: ["broker"], brief: "How the Compliance Officer surfaces flags, license readiness, and TRID deadlines — and the broker's role in resolving them." },
    { key: "agent_development", label: "Developing your agents", audienceRoles: ["broker"], brief: "Onboarding, mentorship, skill-freshness, and retention save-plays to develop and keep agents." },
    { key: "multi_office_ops", label: "Running multiple offices", audienceRoles: ["broker"], brief: "Location scoping, per-office roll-ups, and overseeing multiple teams from the one command center." },
  ],
}

/** PURE: the onboarding topics for a tier (core + tier-specific), deduped by key. */
export function topicsForTier(tier: Tier): OnboardingTopic[] {
  const seen = new Set<string>()
  const out: OnboardingTopic[] = []
  for (const t of [...CORE, ...(BY_TIER[tier] ?? [])]) {
    if (seen.has(t.key)) continue
    seen.add(t.key); out.push(t)
  }
  return out
}

/** PURE: the idempotency gap-tag for an onboarding module (namespaced away from knowledge-gap modules). */
export function onboardingTag(tier: Tier, topicKey: string): string {
  return `onboarding:${tier}:${topicKey}`
}

export interface OnboardingResult { tier: Tier | null; topics: number; authored: number }

/** Author the missing onboarding modules for one brokerage's tier. Best-effort. */
export async function runOnboardingCurriculum(svc: Svc, params: { brokerageId: string; tier?: Tier | null }): Promise<OnboardingResult> {
  const out: OnboardingResult = { tier: null, topics: 0, authored: 0 }
  let tier = params.tier ?? null
  if (!tier) {
    const { data: b } = await svc.from("brokerages").select("plan_tier").eq("id", params.brokerageId).maybeSingle()
    tier = ((b as any)?.plan_tier ?? null) as Tier | null
  }
  if (!tier || !BY_TIER[tier]) return out
  out.tier = tier

  const topics = topicsForTier(tier)
  out.topics = topics.length
  for (const topic of topics) {
    const tag = onboardingTag(tier, topic.key)
    const { data: existing } = await svc.from("learning_modules")
      .select("id").eq("brokerage_id", params.brokerageId).eq("is_ai_generated", true).contains("gap_tags", [tag]).limit(1).maybeSingle()
    if (existing) continue

    const curriculum = await authorModuleFor(topic, tier).catch(() => null)
    if (!curriculum) continue
    const ok = await persistOnboardingModule(svc, params.brokerageId, tag, topic, curriculum)
    if (ok) out.authored++
  }
  return out
}

/** Autonomous: author onboarding for every brokerage missing it (rides the weekly recruit-outreach cron). */
export async function runOnboardingCurriculumAll(svc: Svc): Promise<{ brokerages: number; authored: number }> {
  const out = { brokerages: 0, authored: 0 }
  const { data: rows } = await svc.from("brokerages").select("id, plan_tier").limit(1000)
  for (const b of (rows ?? []) as Array<{ id: string; plan_tier: string | null }>) {
    out.brokerages++
    try { const r = await runOnboardingCurriculum(svc, { brokerageId: b.id, tier: (b.plan_tier ?? null) as Tier | null }); out.authored += r.authored } catch { /* keep going */ }
  }
  return out
}
