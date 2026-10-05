// lib/education/client-education-authoring.ts
//
// The model + persistence side of client education authoring — kept separate so the pure syllabus stays
// testable without the AI gateway. Reuses the curriculum author's CurriculumSchema + body renderer so a
// client module reads like the rest, on the same learning_modules rail. The voice differs: client modules
// are warm, plain-language, reassuring — written FOR the buyer/seller, not the agent.

import { createServiceClient } from "@/lib/supabase/service"
import { CurriculumSchema, renderModuleBody, type Curriculum } from "@/lib/education/curriculum-author"
import { resolveMaterialFormat, channelsForFormat } from "@/lib/education/delivery-format"
import type { ClientTopic } from "@/lib/education/client-education-curriculum"
import { hasFairHousingViolation } from "@/lib/compliance/client-text-guard"

type Svc = ReturnType<typeof createServiceClient>

/**
 * COMPLIANCE-FIRST (CLAUDE.md §5, wave 103 lane 103A): the fair-housing rule is IN the writing
 * prompt, not only in the post-hoc scan — the same discipline the video scripts follow. A client
 * lesson never characterises neighbourhoods or people by a protected class, never steers, and
 * never states the client's own money (price, proceeds, commission, loan terms): those live in
 * the portal's own deal surfaces under their own gates, not in a lesson every band may receive.
 */
export const CLIENT_LESSON_COMPLIANCE_RULES =
  "Fair Housing (42 U.S.C. §3604): never describe a neighbourhood, school, community or buyer/seller by race, colour, religion, national origin, sex, familial status or disability, and never steer toward or away from an area on those grounds — say nothing like 'family-friendly', 'good schools' or 'safe neighbourhood'. Do not state or estimate any dollar figure about THIS client's deal (price, proceeds, commission, loan terms, net sheet); refer them to their agent, lender or attorney for their own numbers."

/** Author a warm, plain-language client module with the model. Throws if the model is unavailable. */
export async function authorClientModule(topic: ClientTopic): Promise<Curriculum> {
  const { generateObjectRouted } = await import("@/lib/ai/models")
  const { object } = await generateObjectRouted({
    feature: "curriculum_authoring",
    schema: CurriculumSchema,
    system: "You are writing a short, reassuring lesson FOR a real-estate client (a buyer or seller), not for an agent. Plain language, warm and calm, no jargon. Answer 'what happens now' and 'what should I do' concretely. Never give legal or financial advice as fact — frame as general guidance and defer specifics to their agent/attorney/lender. " + CLIENT_LESSON_COMPLIANCE_RULES,
    prompt: `Write the client lesson "${topic.title}".\n\nWhat it must cover: ${topic.brief}\n\nKeep it short, specific, and human — a nervous client should feel calmer and know their next step after reading it.`,
  })
  return object
}

/** PURE: the post-hoc scan — a hard fair-housing phrase anywhere in the rendered lesson refuses it.
 *  Warnings pass through; only the unambiguous steering phrase (the one shared regex) escalates.
 *  @proofSeam the refusal is asserted on a steering fixture by scripts/competency-guard.ts; its only
 *  product caller is persistClientModule in this file. */
export function clientModulePassesCompliance(curriculum: Curriculum): { ok: boolean; reason?: string } {
  const text = renderModuleBody(curriculum, "")
  if (hasFairHousingViolation(text) || hasFairHousingViolation(curriculum.title) || hasFairHousingViolation(curriculum.summary ?? "")) {
    return { ok: false, reason: "fair_housing_phrase" }
  }
  return { ok: true }
}

/** Persist a client module as a gated learning_modules draft (audience 'customer', stage/persona tagged).
 *  REFUSES a lesson that fails the compliance scan — nothing steering reaches the review queue. */
export async function persistClientModule(svc: Svc, brokerageId: string, tag: string, topic: ClientTopic, curriculum: Curriculum): Promise<boolean> {
  const isPersona = topic.kind === "persona"
  const compliance = clientModulePassesCompliance(curriculum)
  if (!compliance.ok) {
    console.error("[client-education] lesson refused by the compliance scan — not persisted:", { tag, reason: compliance.reason })
    return false
  }
  const { error } = await svc.from("learning_modules").insert({
    brokerage_id: brokerageId,
    title: curriculum.title,
    summary: curriculum.summary,
    body: renderModuleBody(curriculum, `A guide for you at this step — your agent is one message away.`),
    quiz_questions: curriculum.quiz as any,
    is_ai_generated: true,
    status: "pending_review",
    gap_tags: [tag],
    audience_roles: ["customer"],
    audience_personas: isPersona && topic.persona ? [topic.persona] : [],
    // stage_tags drive the learning-router's kernel-context match (buyer_stage / milestone / portal view).
    // A topic may cover a journey WINDOW via topic.stages; otherwise it anchors on its single milestone.
    stage_tags: !isPersona ? (topic.stages ?? (topic.milestone ? [topic.milestone] : [])) : [],
    milestone_key: !isPersona ? (topic.milestone ?? null) : null,
    channels: channelsForFormat(resolveMaterialFormat({ topicKey: topic.key })),
    estimated_minutes: 4,
    required: false,
    display_priority: 50,
  })
  return !error
}
