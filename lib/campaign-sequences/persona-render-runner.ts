// lib/campaign-sequences/persona-render-runner.ts
//
// Live side of persona+enrichment copy: load the record from the table that OWNS it (contacts vs
// leads) and generate step copy grounded in that person — never a hard-coded template. The step's
// INTENT becomes the goal; the persona + Fair-Housing-safe facts ground the generation; the
// deterministic fallback is a last resort only (so a touch always produces copy).

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { generatePersonaCopy, type CopyDraft, type CopyGenerator } from "@/lib/kernel/ai-copy"
import { buildPersonaContext, CONTACT_PERSONA_COLUMNS, LEAD_PERSONA_COLUMNS, type PersonaEntity, type PersonaContext } from "./persona-render"

type Svc = ReturnType<typeof createServiceClient>

/** Load the persona + safe facts for a contact or lead from its OWNING table. */
export async function loadEntityPersonaContext(svc: Svc, entity: PersonaEntity, id: string, now: Date = new Date()): Promise<PersonaContext> {
  const table = entity === "lead" ? "leads" : "contacts"
  const cols = entity === "lead" ? LEAD_PERSONA_COLUMNS : CONTACT_PERSONA_COLUMNS
  const { data } = await svc.from(table).select(cols).eq("id", id).maybeSingle()
  if (!data) return { persona: { audience: entity }, facts: [] }
  return buildPersonaContext(data as any, entity, now)
}

export interface GenerateEntityStepCopyInput {
  svc: Svc
  entity: PersonaEntity
  id: string
  /** WHAT we're writing (the intent), e.g. "a warm, no-pressure check-in re-engaging a quiet buyer". */
  intent: string
  channel: string
  words?: number
  /** Deterministic last-resort copy when the generator yields nothing. */
  fallback: CopyDraft
  generator?: CopyGenerator
  now?: Date
}

/**
 * Generate persona+enrichment-grounded copy for one cadence/sequence step. The copy is written to
 * THIS person from their enriched, Fair-Housing-safe facts — not a static string.
 */
export async function generateEntityStepCopy(input: GenerateEntityStepCopyInput): Promise<CopyDraft> {
  const ctx = await loadEntityPersonaContext(input.svc, input.entity, input.id, input.now ?? new Date())
  return generatePersonaCopy(
    { goal: input.intent, facts: ctx.facts, channel: input.channel, persona: ctx.persona, words: input.words },
    input.fallback,
    { generator: input.generator },
  )
}
