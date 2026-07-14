// lib/education/depth-reauthor.ts
//
// DEPTH RE-AUTHOR SWEEP (recruiting_manager) — the education depth upgrade
// (owner rule: "all education/academy needs to have that same indepth/detailed
// and not just some summary") only changes what gets authored NEXT. Modules
// authored BEFORE the upgrade are still on the shelf in summary form — the
// exact shallow material the owner said fails a first-year licensee who needs
// a contract walked section by section. This sweep finds them and re-authors
// them in place through the same depth engine.
//
// How a shallow module is recognized: every depth-engine body renders each
// lesson's full walkthrough followed by the literal "**Key takeaways**" recap
// marker (renderModuleBody). An AI-authored module WITHOUT that marker
// predates the upgrade. Re-authoring writes a marker-bearing body, so the
// sweep is SELF-TERMINATING — each module is rewritten exactly once.
//
// How the topic is recovered (pure, testable):
//   onboarding:{tier}:{key}      → topicsForTier(tier) syllabus entry
//   program:book_authority:{key} → BOOK_TOPICS entry
//   anything else (knowledge-gap / question tags) → a topic synthesized from
//   the module's OWN title + summary (real data, never hardcoded filler).
//
// Governance unchanged: the rewrite lands as status 'pending_review' — a human
// re-approves the deeper version before anyone studies it. Capped per run
// (LLM cost + reviewer load); rides the weekly recruit-outreach cron.

import type { SupabaseClient } from "@supabase/supabase-js"
import type { OnboardingTopic, Tier } from "@/lib/education/onboarding-curriculum"

type Svc = SupabaseClient<any, any, any>

/** The literal recap marker every depth-engine body carries (renderModuleBody). */
export const DEPTH_MARKER = "**Key takeaways**"

const TIERS: Tier[] = ["solo_agent", "team", "brokerage", "multi_location"]
const MAX_REAUTHOR_PER_RUN = 4

export interface ShallowModuleRow {
  id: string
  title: string | null
  summary: string | null
  gap_tags: string[] | null
  audience_roles: string[] | null
}

/** PURE: is this body pre-upgrade shallow (no lesson walkthrough recap marker)? */
export function isShallowBody(body: string | null | undefined): boolean {
  return !String(body ?? "").includes(DEPTH_MARKER)
}

/**
 * PURE: recover the authoring topic for a shallow module. Syllabus-tagged
 * modules get their canonical topic back (brief included); everything else
 * gets a topic built from the module's own title + summary so the re-author
 * stays grounded in what the module was actually about.
 */
export async function recoverTopicForModule(
  row: ShallowModuleRow,
  brokerageTier: Tier,
): Promise<{ topic: OnboardingTopic; tier: Tier } | null> {
  const tags = (row.gap_tags ?? []).filter(Boolean)

  for (const tag of tags) {
    if (tag.startsWith("onboarding:")) {
      const [, tierSeg, ...keyParts] = tag.split(":")
      const key = keyParts.join(":")
      const tier = (TIERS as string[]).includes(tierSeg) ? (tierSeg as Tier) : brokerageTier
      const { topicsForTier } = await import("@/lib/education/onboarding-curriculum")
      const topic = topicsForTier(tier).find((t) => t.key === key)
      if (topic) return { topic, tier }
    }
    if (tag.startsWith("program:book_authority:")) {
      const key = tag.slice("program:book_authority:".length)
      const { BOOK_TOPICS } = await import("@/lib/education/book-authority-program")
      const topic = BOOK_TOPICS.find((t) => t.key === key)
      if (topic) return { topic, tier: brokerageTier }
    }
  }

  // Knowledge-gap / question modules: the module's own title + summary ARE the topic.
  const title = (row.title ?? "").trim()
  if (!title) return null // nothing real to ground a re-author in — honest skip
  return {
    topic: {
      key: tags[0] ?? `module:${row.id}`,
      label: title,
      audienceRoles: row.audience_roles?.length ? row.audience_roles : ["agent"],
      brief: `${row.summary?.trim() || title}. Re-author this course IN DEPTH for every experience level: define every term, walk any form or document SECTION BY SECTION, verbatim scripts where speech is involved, the WHY behind each step — never a summary.`,
    },
    tier: brokerageTier,
  }
}

export interface DepthReauthorResult { scanned: number; reauthored: number }

/** Re-author every pre-upgrade shallow AI module for one brokerage (capped per run). */
export async function reauthorShallowModules(svc: Svc, brokerageId: string): Promise<DepthReauthorResult> {
  const out: DepthReauthorResult = { scanned: 0, reauthored: 0 }

  const { data: b } = await svc.from("brokerages").select("plan_tier").eq("id", brokerageId).maybeSingle()
  const rawTier = String((b as any)?.plan_tier ?? "solo_agent")
  const tier: Tier = (TIERS as string[]).includes(rawTier) ? (rawTier as Tier) : "solo_agent"

  // The marker is literal text; % wildcards make it a substring match.
  const { data: rows } = await svc.from("learning_modules")
    .select("id, title, summary, body, gap_tags, audience_roles")
    .eq("brokerage_id", brokerageId)
    .eq("is_ai_generated", true)
    .not("body", "ilike", `%${DEPTH_MARKER}%`)
    .limit(50)

  const shallow = ((rows ?? []) as Array<ShallowModuleRow & { body: string | null }>)
    .filter((r) => isShallowBody(r.body))
  out.scanned = shallow.length
  if (shallow.length === 0) return out

  const { authorModuleFor } = await import("@/lib/education/onboarding-authoring")
  const { renderModuleBody } = await import("@/lib/education/curriculum-author")

  for (const row of shallow.slice(0, MAX_REAUTHOR_PER_RUN)) {
    const recovered = await recoverTopicForModule(row, tier)
    if (!recovered) continue
    const curriculum = await authorModuleFor(recovered.topic, recovered.tier).catch(() => null)
    if (!curriculum) continue // model unavailable — the marker is still absent, next run retries

    const { error } = await svc.from("learning_modules").update({
      title: curriculum.title,
      summary: curriculum.summary,
      body: renderModuleBody(curriculum, "Re-authored in depth by the Recruiting Manager — the earlier summary version predated the depth standard."),
      quiz_questions: curriculum.quiz as any,
      status: "pending_review", // a human re-approves the deeper version
    }).eq("id", row.id)
    if (!error) out.reauthored++
  }
  return out
}

/** Autonomous: sweep every brokerage (rides the weekly recruit-outreach cron). Self-terminating via the marker. */
export async function runDepthReauthorAll(svc: Svc): Promise<{ brokerages: number; reauthored: number }> {
  const { data: brokerages } = await svc.from("brokerages").select("id").limit(1000)
  let reauthored = 0
  for (const b of ((brokerages ?? []) as Array<{ id: string }>)) {
    const r = await reauthorShallowModules(svc, b.id).catch(() => null)
    if (r) reauthored += r.reauthored
  }
  return { brokerages: (brokerages ?? []).length, reauthored }
}
