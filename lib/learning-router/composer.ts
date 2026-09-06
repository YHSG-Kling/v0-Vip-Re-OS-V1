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
import type { AgeSegment } from "@/lib/kernel/education"
import type { ProtectedClassBasis } from "@/lib/lead-governance/protected-class-signals"

export type LearningActorKind = "agent" | "staff" | "customer"

/** Where a customer pick's age band came from. Mirrors
 *  `EducationContext["ageSegSource"]`; "default" means NOT MEASURED. */
export type LearningAgeSegSource = "birthday" | "age_range" | "seller_signal" | "default"

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
  /**
   * THE MEASURED AGE BAND this pick was scored under, or null when none was
   *  measured (and always null for agent/staff actors, who have no band).
   *
   * CARRIED AS A TYPED FIELD, not dug back out of `signalMetadata`, because the
   * delivery producer branches on it to choose the RAIL. It used to run its own
   * second read of contacts.birthday/age_range to answer the same question — a
   * duplicate banding of one idea (CLAUDE.md §6) and a second round trip. One
   * resolver bands, every consumer reads the band it produced.
   */
  ageSegment:          AgeSegment | null
  ageSegSource:        LearningAgeSegSource
  /**
   * The classifier's reason sentences when protected-class-derived data took
   * part in this pick — carried verbatim from
   * `motivated_seller_signals.signal_details.protected_class_basis`. Empty for
   * every other path. A consumer that PERSISTS the selection writes it down.
   */
  protectedClassBasis: ProtectedClassBasis[]
}

/** The context one module row is scored against. Extracted so the scoring is
 *  callable — and therefore provable — without a database (CLAUDE.md §7). */
export interface LearningScoreContext {
  audienceRole: string | null
  personas:     readonly string[]
  generations:  readonly string[]
  ageSegs:      readonly string[]
  stageTags:    readonly string[]
  gapTags:      readonly string[]
}

/** The scorable fields of one `learning_modules` row. */
export interface LearningModuleRow {
  audience_roles:       string[] | null
  audience_personas:    string[] | null
  audience_generations: string[] | null
  audience_age_segs:    string[] | null
  stage_tags:           string[] | null
  gap_tags:             string[] | null
  display_priority:     number | null
}

/**
 * PURE. Score ONE module row against ONE actor context.
 *
 * THE ONE SCORER. It was inline in `pickLearningModulesForActor`'s loop and is
 * now a function with the identical arithmetic and the identical
 * ineligible-rule, so there is still exactly one place that decides what a match
 * is worth (CLAUDE.md §6). Returns null when the row is INELIGIBLE — either its
 * `audience_roles` excludes this actor, or nothing matched and it is not a
 * universal module.
 */
export function scoreLearningModule(
  r: LearningModuleRow,
  ctx: LearningScoreContext,
): { score: number; matchedSignals: string[] } | null {
  // Role audience: empty array = show to everyone
  if (ctx.audienceRole && r.audience_roles && r.audience_roles.length > 0) {
    if (!r.audience_roles.includes(ctx.audienceRole)) return null
  }

  let score = (r.display_priority ?? 0) * 10
  const matchedSignals: string[] = []

  if (ctx.gapTags.length > 0 && r.gap_tags && r.gap_tags.length > 0) {
    const overlap = r.gap_tags.filter((t) => ctx.gapTags.includes(t))
    if (overlap.length > 0) {
      score += 100 * overlap.length
      matchedSignals.push(`gap:${overlap.join(",")}`)
    }
  }

  if (ctx.personas.length > 0 && r.audience_personas && r.audience_personas.length > 0) {
    const overlap = r.audience_personas.filter((p) => ctx.personas.includes(p))
    if (overlap.length > 0) {
      score += 60
      matchedSignals.push(`persona:${overlap.join(",")}`)
    }
  }

  if (ctx.generations.length > 0 && r.audience_generations && r.audience_generations.length > 0) {
    const overlap = r.audience_generations.filter((g) => ctx.generations.includes(g))
    if (overlap.length > 0) {
      score += 40
      matchedSignals.push(`generation:${overlap.join(",")}`)
    }
  }

  if (ctx.ageSegs.length > 0 && r.audience_age_segs && r.audience_age_segs.length > 0) {
    const overlap = r.audience_age_segs.filter((a) => ctx.ageSegs.includes(a))
    if (overlap.length > 0) {
      score += 30
      matchedSignals.push(`age:${overlap.join(",")}`)
    }
  }

  if (ctx.stageTags.length > 0 && r.stage_tags && r.stage_tags.length > 0) {
    const overlap = r.stage_tags.filter((s) => ctx.stageTags.includes(s))
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

  if (matchedSignals.length === 0 && !isUniversal) return null
  return { score, matchedSignals }
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
  // Carried onto every pick as typed fields — see LearningModulePick.
  let ageSegment: AgeSegment | null = null
  let ageSegSource: LearningAgeSegSource = "default"
  let protectedClassBasis: ProtectedClassBasis[] = []

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
    // ── THE SELLER-SIGNAL PERSONA HINTS ────────────────────────────────────
    // `contacts.contact_persona` is one hand-set field, so a client who is BOTH
    // an heir and a senior could only ever be one of them. The seller-signal lane
    // observes those states independently (inherited_property, senior_owner,
    // recent_divorce, household_outgrown) and every one of them maps onto a
    // persona this scorer ALREADY matches against `audience_personas` and that
    // lib/kernel/education.ts ALREADY carries a lesson supplement for — so the
    // hints WIDEN the persona set rather than introducing a second tag axis
    // (CLAUDE.md §6). Deduped: a stored persona that agrees with a signal must
    // not score twice.
    for (const hint of ctx.personaHints) {
      if (!personas.includes(hint)) personas.push(hint)
    }
    generations = ctx.generationalCohort && ctx.generationalCohort !== "unknown" ? [ctx.generationalCohort] : []
    // A DEFAULTED BAND IS NOT A MEASURED ONE. `resolveEducationContext` returns
    // "30-50" as a placeholder when neither contacts.birthday nor the enrichment
    // lane's contacts.age_range said anything; scoring it as if it had been
    // observed handed every unbanded contact a +30 match against modules tagged
    // 30-50, so "we routed by age group" and "we guessed 30-50" produced the same
    // number (CLAUDE.md §2). Only a measured band participates in scoring now.
    ageSegs     = ctx.ageSegSource === "default" ? [] : [ctx.ageSeg]
    ageSegment  = ctx.ageSegSource === "default" ? null : ctx.ageSeg
    ageSegSource = ctx.ageSegSource
    protectedClassBasis = ctx.protectedClassBasis
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
    signalMetadata = {
      ageSeg: ctx.ageSeg, ageSegSource: ctx.ageSegSource,
      generationalCohort: ctx.generationalCohort, persona: c?.contact_persona,
      milestone: ctx.currentMilestone,
      personaHints: ctx.personaHints,
      sellerSignalTypes: ctx.sellerSignalTypes,
    }
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
  const scoreContext: LearningScoreContext = {
    audienceRole, personas, generations, ageSegs, stageTags, gapTags,
  }
  const scored: LearningModulePick[] = []
  for (const r of rows as Row[]) {
    const hit = scoreLearningModule(r, scoreContext)
    if (!hit) continue

    scored.push({
      id:                r.id,
      title:             r.title,
      summary:           r.summary,
      coverImageUrl:     r.cover_image_url,
      estimatedMinutes:  r.estimated_minutes,
      channels:          r.channels ?? [],
      signalSource:      hit.matchedSignals[0] ?? signalSource,
      signalMetadata:    { matched: hit.matchedSignals, ...signalMetadata },
      priorityScore:     hit.score,
      ageSegment,
      ageSegSource,
      protectedClassBasis,
    })
  }

  scored.sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0))
  return scored.slice(0, limit)
}
