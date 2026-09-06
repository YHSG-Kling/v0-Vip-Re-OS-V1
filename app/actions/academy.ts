"use server"

/**
 * app/actions/academy.ts
 *
 * After migration 1042, all education content flows through `learning_modules`
 * (the Sprint 7 canonical store). This file is now ONLY the playbook-template
 * marketplace — clone, feedback, list. The old academy_content / educational_
 * moments tables are gone; getAcademyContent() now delegates to the learning-
 * modules listing instead.
 */

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { getAgentContext } from "@/lib/identity/get-agent-context"

// ─── Learning content (delegates to learning_modules) ────────────────────────
//
// Kept as a named export so existing UI imports continue to resolve.
// Callers get rows shaped like the old academy_content rows (id, title, type,
// body, tags, view_count, is_published, created_at) — but sourced from
// learning_modules.

export interface AcademyContentRow {
  id:                string
  title:             string
  type:              string
  description:       string
  body:              string
  tags:              string[]
  view_count:        number
  estimated_minutes: number
  cover_image_url:   string | null
  video_url:         string | null
  is_published:      boolean
  created_by:        string | null
  created_at:        string
}

export async function getAcademyContent(filters?: {
  type?:        string
  tags?:        string[]
  searchQuery?: string
}): Promise<AcademyContentRow[]> {
  const supabase = await createClient()

  let query = supabase
    .from("learning_modules")
    .select("id, title, summary, body, audience_roles, gap_tags, stage_tags, channels, estimated_minutes, view_count, cover_image_url, status, authored_by, created_at")
    .eq("status", "published")
    .order("view_count", { ascending: false })
    .limit(50)

  if (filters?.type) {
    // Map old academy "type" enum to channels: sop / playbook_breakdown /
    // case_study / loom_link → article / video. Pre-prod simplification.
    if (filters.type === "loom_link") query = query.contains("channels", ["video"])
    else                              query = query.contains("channels", ["article"])
  }
  if (filters?.tags && filters.tags.length > 0) {
    query = query.overlaps("gap_tags", filters.tags)
  }
  if (filters?.searchQuery) {
    query = query.ilike("title", `%${filters.searchQuery}%`)
  }

  const { data, error } = await query
  if (error) {
    console.error("getAcademyContent:", error)
    return []
  }

  return (data ?? []).map((r: Record<string, unknown>) => ({
    id:                r.id as string,
    title:             r.title as string,
    type:              (((r.channels as string[] | null) ?? [])[0]) ?? "article",
    description:       (r.summary as string | null) ?? "",
    body:              (r.body as string | null) ?? "",
    tags:              [
      ...((r.gap_tags as string[] | null) ?? []),
      ...((r.stage_tags as string[] | null) ?? []),
    ],
    view_count:        (r.view_count as number | null) ?? 0,
    estimated_minutes: (r.estimated_minutes as number | null) ?? 5,
    cover_image_url:   (r.cover_image_url as string | null) ?? null,
    video_url:         null, // resolved by the channel publication if a video was fanned out
    is_published:      true,
    created_by:        (r.authored_by as string | null) ?? null,
    created_at:        r.created_at as string,
  }))
}

export async function incrementViewCount(moduleId: string): Promise<void> {
  const supabase = await createClient()
  await supabase.rpc("increment_learning_module_view", { p_module_id: moduleId })
}

// ─── Top contributors — sourced from learning_modules.authored_by ────────────
export async function getTopContributors(): Promise<
  Array<{ user_id: string; full_name: string | null; module_count: number; total_views: number }>
> {
  const supabase = await createClient()
  const { data } = await supabase
    .from("learning_modules")
    .select("authored_by, view_count, users:authored_by(first_name, last_name)")
    .eq("status", "published")
    .not("authored_by", "is", null)

  const map = new Map<string, { full_name: string | null; module_count: number; total_views: number }>()
  // Supabase returns the joined `users:authored_by` as an array even for
  // a single-FK relationship — read the first element.
  for (const row of (data ?? []) as Array<{
    authored_by: string
    view_count:  number | null
    users:       Array<{ first_name: string | null; last_name: string | null }> | null
  }>) {
    const userRow = row.users?.[0] ?? null
    const existing = map.get(row.authored_by) ?? {
      full_name:    userRow
        ? [userRow.first_name, userRow.last_name].filter(Boolean).join(" ") || null
        : null,
      module_count: 0,
      total_views:  0,
    }
    existing.module_count += 1
    existing.total_views  += row.view_count ?? 0
    map.set(row.authored_by, existing)
  }
  return Array.from(map.entries())
    .map(([user_id, agg]) => ({ user_id, ...agg }))
    .sort((a, b) => b.total_views - a.total_views || b.module_count - a.module_count)
    .slice(0, 10)
}

// ─── Template marketplace (unchanged — playbook cloning, not education) ────
export async function getMarketplaceTemplates(filters?: {
  tags?:        string[]
  searchQuery?: string
  sortBy?:      "popular" | "recent" | "top_rated"
  /** When true, return only templates the CURRENT user authored (any visibility). */
  mineOnly?:    boolean
}) {
  const supabase = await createClient()

  // Alias live columns (template_name/template_body/rating/usage_count) to the names the UI expects.
  let query = supabase
    .from("template_marketplace")
    .select("id, name:template_name, description:template_body, template_type, visibility, average_rating:rating, clone_count:usage_count, metadata, created_at, updated_at")

  if (filters?.mineOnly) {
    // "My Templates" — the user's OWN authored templates, regardless of visibility
    // (their private drafts should surface here even though the marketplace hides them).
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return []
    query = query.eq("author_user_id", user.id)
  } else {
    query = query.in("visibility", ["global", "brokerage_only"])
  }

  // NOTE: live template_marketplace has no `tags` column — tag filtering is a no-op.
  if (filters?.searchQuery) {
    query = query.or(`template_name.ilike.%${filters.searchQuery}%,template_body.ilike.%${filters.searchQuery}%`)
  }
  if (filters?.sortBy === "popular")        query = query.order("usage_count", { ascending: false })
  else if (filters?.sortBy === "top_rated") query = query.order("rating", { ascending: false })
  else                                       query = query.order("created_at", { ascending: false })

  const { data, error } = await query
  if (error) {
    console.error("getMarketplaceTemplates:", error)
    return []
  }
  return data || []
}

export async function cloneTemplate(templateId: string) {
  const supabase = await createClient()

  const { data: template, error: fetchError } = await supabase
    .from("template_marketplace")
    .select("id, name:template_name, template_type, metadata, usage_count")
    .eq("id", templateId)
    .single()
  if (fetchError || !template) return { error: "Template not found" }

  // STAMPED. The marketplace it is cloned FROM is deliberately cross-brokerage, but
  // the clone is not: it lands in `plan_tasks` as this tenant's own playbook.
  //
  // All four live `plan_tasks` policies read
  // `brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()`, granted to
  // `authenticated`. A NULL brokerage_id SATISFIES that predicate for EVERY tenant —
  // so an unstamped clone is not private, it is published to every signed-in user of
  // every other brokerage, who can also edit and delete it. Hence the stamp.
  //
  // The tenant comes from the SESSION, not from `templateId`: that argument is
  // caller-supplied into a `"use server"` export, so deriving the tenant from it would
  // let the caller pick which brokerage to write into.
  const { brokerageId, isAuthenticated } = await getAgentContext()
  if (!isAuthenticated) return { error: "Not authenticated" }
  // Refuse rather than fall back to NULL. Writing the row untenanted would hand the
  // clone to the whole platform, which is worse than not cloning it.
  if (!brokerageId) return { error: "Your account is not attached to a brokerage" }

  // plan_tasks (live, merged playbook table): task_description is NOT NULL; playbook
  // fields are playbook_name/trigger_type/steps/target_persona_ids/active. Clone source
  // data lives in template.metadata. No agent_id column on plan_tasks (re-verified
  // against the live schema) — brokerage_id is the whole tenant key here.
  const meta = (template.metadata as any) || {}
  const { data: clonedPlaybook, error: cloneError } = await supabase
    .from("plan_tasks")
    .insert({
      brokerage_id:       brokerageId,
      task_description:   `${template.name} (Copy)`,
      playbook_name:      `${template.name} (Copy)`,
      trigger_type:       meta.trigger_type || "manual",
      steps:              meta.steps || [],
      target_persona_ids: meta.target_persona_ids || [],
      active:             false,
    })
    .select()
    .single()
  if (cloneError) return { error: "Failed to clone template" }

  await supabase
    .from("template_marketplace")
    .update({ usage_count: ((template.usage_count as number) || 0) + 1 })
    .eq("id", templateId)

  revalidatePath("/academy")
  return { success: true, playbook: clonedPlaybook }
}

export async function addTemplateFeedback(data: {
  templateId:   string
  feedbackType: "comment" | "upvote" | "request_variation"
  comment?:     string
  rating?:      number
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: "Not authenticated" }

  // template_feedback has no feedback_type column (nothing reads it). Drop it.
  const { error } = await supabase.from("template_feedback").insert({
    template_id: data.templateId,
    user_id:     user.id,
    comment:     data.comment,
    rating:      data.rating, // CHECK rating BETWEEN 1 AND 5
  })
  if (error) return { error: "Failed to add feedback" }

  revalidatePath("/academy")
  return { success: true }
}

/**
 * Feedback on a marketplace template.
 *
 * GATED (was not). Lower stakes than this slice's other findings — the academy
 * marketplace is deliberately cross-brokerage, so there is no tenant predicate to
 * add and none is claimed here. But the rows carry free-text comments written by
 * named users, and `"use server"` made reading them an anonymous HTTP endpoint.
 * Requiring a session matches its write-side sibling `addTemplateFeedback`
 * directly above, which has always required one.
 */
export async function getTemplateFeedback(templateId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  // template_feedback.user_id FKs auth.users (not public.users) — no embeddable
  // public.users relationship, so select the row only.
  const { data, error } = await supabase
    .from("template_feedback")
    .select("*")
    .eq("template_id", templateId)
    .order("created_at", { ascending: false })
    .limit(10)
  if (error) return []
  return data || []
}
