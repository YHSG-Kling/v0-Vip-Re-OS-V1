// lib/education/onboarding-authoring.ts
//
// The model + persistence side of tier onboarding authoring — kept separate so the pure topic syllabus
// (onboarding-curriculum.ts) stays testable without pulling in the AI gateway. Reuses the curriculum
// author's CurriculumSchema + body renderer so onboarding modules read exactly like gap-authored ones,
// on the same learning_modules rail.

import { createServiceClient } from "@/lib/supabase/service"
import { CurriculumSchema, renderModuleBody, type Curriculum } from "@/lib/education/curriculum-author"
import { resolveMaterialFormat, channelsForFormat } from "@/lib/education/delivery-format"
import type { OnboardingTopic, Tier } from "@/lib/education/onboarding-curriculum"

type Svc = ReturnType<typeof createServiceClient>

const TIER_LABEL: Record<Tier, string> = {
  solo_agent: "a solo real-estate agent",
  team: "a real-estate team",
  brokerage: "a real-estate brokerage",
  multi_location: "a multi-location real-estate brokerage",
}

/** Author a rich onboarding module for a tier topic with the model. Throws if the model is unavailable. */
export async function authorModuleFor(topic: OnboardingTopic, tier: Tier): Promise<Curriculum> {
  const { generateObjectRouted } = await import("@/lib/ai/models")
  const { object } = await generateObjectRouted({
    feature: "curriculum_authoring",
    schema: CurriculumSchema,
    system: "You are a master real-estate trainer authoring an IN-DEPTH course for a platform subscriber — written so the least-experienced licensee can follow it start to finish (define every term, walk every form section by section, verbatim scripts, the WHY behind each step) while a veteran still learns something ('If you've done this before' advanced notes). No summaries, no filler: if a lesson could fit on an index card, it is too shallow.",
    maxTokens: 6000,
    prompt: `Author the onboarding micro-course "${topic.label}" for ${TIER_LABEL[tier]} just getting started on our AI real-estate OS.\n\nWhat it must teach: ${topic.brief}\n\nWrite tight, specific, and actionable for a ${topic.audienceRoles.join("/")} audience.`,
  })
  return object
}

/** Persist an onboarding module as a gated learning_modules draft (pending_review). Idempotent by tag. */
export async function persistOnboardingModule(svc: Svc, brokerageId: string, tag: string, topic: OnboardingTopic, curriculum: Curriculum): Promise<boolean> {
  const { error } = await svc.from("learning_modules").insert({
    brokerage_id: brokerageId,
    title: curriculum.title,
    summary: curriculum.summary,
    body: renderModuleBody(curriculum, `Your day-one onboarding path, authored for your plan.`),
    quiz_questions: curriculum.quiz as any,
    is_ai_generated: true,
    status: "pending_review",
    gap_tags: [tag],
    audience_roles: topic.audienceRoles,
    milestone_key: "platform_onboarding",
    channels: channelsForFormat(resolveMaterialFormat({ topicKey: topic.key })),
    estimated_minutes: 6,
    required: true,
    display_priority: 100,
  })
  return !error
}
