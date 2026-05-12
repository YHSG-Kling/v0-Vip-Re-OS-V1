/**
 * Knowledge & Growth Router — composer.
 *
 * Single entry point: pickLearningModulesForActor() — pulls the right
 * context (agent / staff / customer), intersects it against
 * learning_modules.audience_*, stage_tags, and gap_tags, then returns
 * a priority-ranked top-N.
 *
 * Excludes modules the actor already completed (per learning_assignments).
 *
 * Composes cleanly with:
 *   - Sprint 5 Forever Portal live feed (customer modules can be surfaced
 *     in-line when a milestone lifecycle_event fires)
 *   - Sprint 6 Action Queue (agent modules sit in a sibling "Learn This
 *     Week" card)
 *   - Brokerage Intelligence Mesh (Sprint 4) — gap_tags map to insight
 *     pattern_keys so the same insight that drives Sprint 4 adoption
 *     drives the corresponding learning module assignment here
 */

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import { resolveAgentLearningContext } from "./resolve-agent-learning-context"
import { resolveStaffLearningContext } from "./resolve-staff-learning-context"
import { resolveEducationContext } from "@/lib/portal/resolve-education-context"

export type LearningActorKind = "agent" | "staff" | "customer"

export interface LearningModulePick {
  id:                  string
  title:               string
  summary:             string | null
  coverImageUrl:       string | null
  estimatedMinutes:    number | null
  channels:            string[]
  /** Why this was picked (drives UI explainer). */
  signalSource:        string
  signalMetadata:      Record<string, unknown>
  priorityScore:       number | null
}

interface PickInput {
  supabase:    SupabaseClient
  /** Discriminator. The router resolves the right context internally. */
  actorKind:   LearningActorKind
  /** For agent/staff: their users.id. For customer: the contacts.id. */
  actorId:     string
  /** Hard cap on returned modules. Default 3 — keep the UI tight. */
  limit?:      number
}

export async function pickLearningModulesForActor(input: PickInput): Promise<LearningModulePick[]> {
  const { supabase, actorKind, actorId } = input
  const limit = input.limit ?? 3

  // ── Resolve context per actor kind ─────────────────────────────────────
  let brokerageId: string | null = null
  let audienceRole: string | null = null
  let personas: string[] = []
  let generations: string[] = []
  let ageSegs: string[] = []
  let stageTags: string[] = []
  let gapTags: string[] = []
  let completedIds: string[] = []
  let signalSource = "general"
  let signalMetadata: Record<string, unknown> = {}

  if (actorKind === "agent") {
    const ctx = await resolveAgentLearningContext(supabase, actorId)
    if (!ctx) return []
    brokerageId   = ctx.brokerageId
    audienceRole  = "agent"
    gapTags       = ctx.gapTags
    completedIds  = ctx.completedModuleIds
    signalSource  = ctx.gapTags[0] ? `gap:${ctx.gapTags[0]}` : `tenure:agent_${ctx.tenureDays ?? 0}d`
    signalMetadata = { tenureDays: ctx.tenureDays, gapTags: ctx.gapTags, unadoptedInsightIds: ctx.unadoptedInsightIds }
  } else if (actorKind === "staff") {
    const ctx = await resolveStaffLearningContext(supabase, actorId)
    if (!ctx) return []
    brokerageId   = ctx.brokerageId
    audienceRole  = ctx.role.toLowerCase()  // 'tc' / 'compliance_officer' / 'team_lead'
    gapTags       = ctx.gapTags
    completedIds  = ctx.completedModuleIds
    signalSource  = ctx.gapTags[0] ? `gap:${ctx.gapTags[0]}` : `tenure:${ctx.tenureBucket}`
    signalMetadata = { role: ctx.role, tenureBucket: ctx.tenureBucket, gapTags: ctx.gapTags }
  } else {
    // customer
    const ctx = await resolveEducationContext(supabase, actorId)
    audienceRole = "customer"
    // Customer's brokerage is derived from contact row
    const { data: c } = await supabase
      .from("contacts")
      .select("brokerage_id, contact_persona, buyer_stage")
      .eq("id", actorId)
      .maybeSingle()
    brokerageId = (c?.brokerage_id as string | null) ?? null
    if (!brokerageId) return []
    if (c?.contact_persona) personas = [c.contact_persona as string]
    generations = ctx.generationalCohort && ctx.generationalCohort !== "unknown" ? [ctx.generationalCohort] : []
    ageSegs     = [ctx.ageSeg]
    if (ctx.currentMilestone) stageTags.push(ctx.currentMilestone)
    if (ctx.buyerStage)       stageTags.push(ctx.buyerStage)
    if (ctx.portalView)       stageTags.push(ctx.portalView)
    // Post-1043: customer completion is now also tracked in learning_assignments
    // (contact_id + status='completed'). Fetch those module ids to exclude.
    {
      const { data: completedRows } = await supabase
        .from("learning_assignments")
        .select("module_id")
        .eq("contact_id", actorId)
        .eq("status", "completed")
      completedIds = ((completedRows as Array<{ module_id: string }> | null) ?? []).map(r => r.module_id)
    }
    signalSource = ctx.currentMilestone ? `milestone:${ctx.currentMilestone}` : `persona:${c?.contact_persona ?? "general"}`
    signalMetadata = { ageSeg: ctx.ageSeg, generationalCohort: ctx.generationalCohort, persona: c?.contact_persona, milestone: ctx.currentMilestone }
  }

  if (!brokerageId) return []

  // ── Query learning_modules for candidates ──────────────────────────────
  let q = supabase
    .from("learning_modules")
    .select("id, title, summary, cover_image_url, estimated_minutes, channels, audience_roles, audience_personas, audience_generations, audience_age_segs, stage_tags, gap_tags, display_priority")
    .eq("brokerage_id", brokerageId)
    .eq("status", "published")
    .order("display_priority", { ascending: false })
    .limit(50)  // pull a wide candidate set, then filter in-process

  if (completedIds.length > 0) {
    q = q.not("id", "in", `(${completedIds.join(",")})`)
  }

  const { data: rows } = await q
  if (!rows) return []

  type Row = {
    id: string
    title: string
    summary: string | null
    cover_image_url: string | null
    estimated_minutes: number | null
    channels: string[]
    audience_roles: string[]
    audience_personas: string[]
    audience_generations: string[]
    audience_age_segs: string[]
    stage_tags: string[]
    gap_tags: string[]
    display_priority: number | null
  }

  // ── In-process intersection + scoring ─────────────────────────────────
  const scored: LearningModulePick[] = []
  for (const r of rows as Row[]) {
    // Role audience: empty array = show to everyone
    if (audienceRole && r.audience_roles && r.audience_roles.length > 0) {
      if (!r.audience_roles.includes(audienceRole)) continue
    }

    // Score per matched dimension
    let score = (r.display_priority ?? 0) * 10
    const matchedSignals: string[] = []

    if (gapTags.length > 0 && r.gap_tags && r.gap_tags.length > 0) {
      const overlap = r.gap_tags.filter((t) => gapTags.includes(t))
      if (overlap.length > 0) {
        score += 100 * overlap.length
        matchedSignals.push(`gap:${overlap.join(",")}`)
      }
    }

    if (personas.length > 0 && r.audience_personas && r.audience_personas.length > 0) {
      const overlap = r.audience_personas.filter((p) => personas.includes(p))
      if (overlap.length > 0) {
        score += 60
        matchedSignals.push(`persona:${overlap.join(",")}`)
      }
    }

    if (generations.length > 0 && r.audience_generations && r.audience_generations.length > 0) {
      const overlap = r.audience_generations.filter((g) => generations.includes(g))
      if (overlap.length > 0) {
        score += 40
        matchedSignals.push(`generation:${overlap.join(",")}`)
      }
    }

    if (ageSegs.length > 0 && r.audience_age_segs && r.audience_age_segs.length > 0) {
      const overlap = r.audience_age_segs.filter((a) => ageSegs.includes(a))
      if (overlap.length > 0) {
        score += 30
        matchedSignals.push(`age:${overlap.join(",")}`)
      }
    }

    if (stageTags.length > 0 && r.stage_tags && r.stage_tags.length > 0) {
      const overlap = r.stage_tags.filter((s) => stageTags.includes(s))
      if (overlap.length > 0) {
        score += 80 * overlap.length
        matchedSignals.push(`stage:${overlap.join(",")}`)
      }
    }

    // Show-to-everyone fallback: empty audience_roles + empty gap_tags +
    // empty stage_tags = a universal module, eligible but low score
    const isUniversal =
      (!r.audience_roles || r.audience_roles.length === 0) &&
      (!r.gap_tags || r.gap_tags.length === 0) &&
      (!r.stage_tags || r.stage_tags.length === 0)

    if (matchedSignals.length === 0 && !isUniversal) continue

    scored.push({
      id:                r.id,
      title:             r.title,
      summary:           r.summary,
      coverImageUrl:     r.cover_image_url,
      estimatedMinutes:  r.estimated_minutes,
      channels:          r.channels ?? [],
      signalSource:      matchedSignals[0] ?? signalSource,
      signalMetadata:    { matched: matchedSignals, ...signalMetadata },
      priorityScore:     score,
    })
  }

  scored.sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0))
  return scored.slice(0, limit)
}
