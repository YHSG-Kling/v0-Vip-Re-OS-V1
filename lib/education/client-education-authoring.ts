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

type Svc = ReturnType<typeof createServiceClient>

/** Author a warm, plain-language client module with the model. Throws if the model is unavailable. */
export async function authorClientModule(topic: ClientTopic): Promise<Curriculum> {
  const { generateObjectRouted } = await import("@/lib/ai/models")
  const { object } = await generateObjectRouted({
    feature: "curriculum_authoring",
    schema: CurriculumSchema,
    system: "You are writing a short, reassuring lesson FOR a real-estate client (a buyer or seller), not for an agent. Plain language, warm and calm, no jargon. Answer 'what happens now' and 'what should I do' concretely. Never give legal or financial advice as fact — frame as general guidance and defer specifics to their agent/attorney/lender.",
    prompt: `Write the client lesson "${topic.title}".\n\nWhat it must cover: ${topic.brief}\n\nKeep it short, specific, and human — a nervous client should feel calmer and know their next step after reading it.`,
  })
  return object
}

/** Persist a client module as a gated learning_modules draft (audience 'customer', stage/persona tagged). */
export async function persistClientModule(svc: Svc, brokerageId: string, tag: string, topic: ClientTopic, curriculum: Curriculum): Promise<boolean> {
  const isPersona = topic.kind === "persona"
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
