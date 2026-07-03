// lib/education/regulatory-curriculum.ts
//
// REGULATORY → CURRICULUM AUTOPILOT — when a new rule or law comes to light, the OS doesn't just escalate
// a brief, it TRAINS the team on it. The Compliance Officer's regulatory watcher already detects a real,
// sourced reg change and maps it to the OS surfaces it touches; this authors a short, specific training
// module explaining the change and exactly what agents/brokers must now do, on the same canonical
// learning_modules rail, so the existing approve/publish + learning-router push it to the affected roles.
// Grounded in the REAL change (title/source/effective date) — never invents a regulation. Idempotent per
// change signature. "Your brokerage was trained on the new rule before your competitors read the email."

import { createServiceClient } from "@/lib/supabase/service"
import { CurriculumSchema, renderModuleBody, type Curriculum } from "@/lib/education/curriculum-author"
import { resolveMaterialFormat, channelsForFormat } from "@/lib/education/delivery-format"

type Svc = ReturnType<typeof createServiceClient>

export interface RegChangeInput {
  signature: string
  title: string
  source: string
  url: string | null
  severityTier: string
  effectiveDate: string | null
  surfaceLabels: string[]
}

/** The idempotency gap-tag for a regulatory training module. */
export function regulationTag(signature: string): string {
  return `regulation:${signature}`
}

/** Author a training module for a regulatory change with the model. Throws if the model is unavailable. */
export async function authorRegulatoryModule(change: RegChangeInput): Promise<Curriculum> {
  const { generateObjectRouted } = await import("@/lib/ai/models")
  const effective = change.effectiveDate ? ` It takes effect ${change.effectiveDate}.` : ""
  const surfaces = change.surfaceLabels.length ? ` It touches: ${change.surfaceLabels.join("; ")}.` : ""
  const { object } = await generateObjectRouted({
    feature: "curriculum_authoring",
    schema: CurriculumSchema,
    system: "You are a real-estate compliance trainer. Write a SHORT, specific training module for licensed agents and brokers explaining a real regulatory change and exactly what they must now do to stay compliant. Be concrete and current. Cite the effective date when known. Do not present legal advice as absolute — tell them to confirm specifics with their broker/compliance officer or counsel.",
    prompt: `Author the compliance training "${change.title}".\n\nSource: ${change.source}${change.url ? ` (${change.url})` : ""}. Severity: ${change.severityTier}.${effective}${surfaces}\n\nGround everything in THIS change. Tell them what changed and the concrete steps to comply.`,
  })
  return object
}

/** Persist a regulatory training module as a gated learning_modules draft (broker + agent audience). */
export async function persistRegulatoryModule(svc: Svc, brokerageId: string, change: RegChangeInput, curriculum: Curriculum): Promise<boolean> {
  const tag = regulationTag(change.signature)
  const { error } = await svc.from("learning_modules").insert({
    brokerage_id: brokerageId,
    title: curriculum.title,
    summary: curriculum.summary,
    body: renderModuleBody(curriculum, `Authored by the Compliance Officer from a real regulatory change${change.effectiveDate ? ` effective ${change.effectiveDate}` : ""} — confirm specifics with your broker/counsel.`),
    quiz_questions: curriculum.quiz as any,
    is_ai_generated: true,
    status: "pending_review",
    gap_tags: [tag],
    audience_roles: ["agent", "broker"],
    channels: channelsForFormat(resolveMaterialFormat({ topicKey: tag })),
    estimated_minutes: 6,
    // A binding change is required training; advisory is recommended.
    required: change.severityTier === "binding",
  })
  return !error
}

/** Detect-then-author: author a gated training module for a NEW reg change (idempotent per signature). */
export async function authorRegulatoryTraining(svc: Svc, params: { brokerageId: string; change: RegChangeInput }): Promise<boolean> {
  const tag = regulationTag(params.change.signature)
  const { data: existing } = await svc.from("learning_modules")
    .select("id").eq("brokerage_id", params.brokerageId).eq("is_ai_generated", true).contains("gap_tags", [tag]).limit(1).maybeSingle()
  if (existing) return false
  const curriculum = await authorRegulatoryModule(params.change).catch(() => null)
  if (!curriculum) return false
  return persistRegulatoryModule(svc, params.brokerageId, params.change, curriculum)
}
