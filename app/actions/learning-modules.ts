"use server"

/**
 * app/actions/learning-modules.ts
 *
 * Sprint 7 — Knowledge & Growth Router authoring + publisher actions.
 *
 *  - createLearningModuleAction(input)              — author a draft
 *  - updateLearningModuleAction(id, patch)          — edit a draft
 *  - publishLearningModuleAction(id, channels[])    — fan out to channels
 *  - listLearningModulesForBrokerageAction()        — admin list
 *  - getLearningAssignmentsForActorAction(opts)     — server-side wrapper
 *                                                     around the composer
 *
 * The publisher fans one `learning_modules` row into the channel-specific
 * tables that already exist in the schema:
 *
 *   article         → knowledge_articles
 *   blog            → knowledge_articles (with 'blog' tag)
 *   video           → training_videos      (video_url='pending' placeholder)
 *   podcast         → podcast_episodes     (status='draft', script=body)
 *   newsletter      → newsletter_brokers_templates
 *   email           → newsletter_brokers_templates (with 'email' name suffix)
 *   social          → social_posts         (status='draft')
 *   quiz            → onboarding_quizzes   (skipped if no step_id provided)
 *   portal_lesson   → no table insert; the portal-stream-projector reads
 *                     learning_module_channel_publications (channel=
 *                     portal_lesson) and injects module_id into
 *                     portal_event_stream.metadata. Customer completion
 *                     tracked via learning_assignments (status='completed').
 *
 * Every fan-out writes a `learning_module_channel_publications` row so the
 * router knows what's actually published where.
 */

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { pickLearningModulesForActor, type LearningActorKind, type LearningModulePick } from "@/lib/learning-router/composer"

type Channel =
  | "article"
  | "blog"
  | "video"
  | "podcast"
  | "newsletter"
  | "email"
  | "social"
  | "quiz"
  | "portal_lesson"

const ALLOWED_CHANNELS: ReadonlySet<Channel> = new Set([
  "article", "blog", "video", "podcast",
  "newsletter", "email", "social", "quiz", "portal_lesson",
])

const ADMIN_ROLES = new Set(["broker", "broker_admin", "admin", "superadmin", "team_lead"])

// ─── Auth helper for admin actions ──────────────────────────────────────────
async function requireAdmin(): Promise<
  | { ok: true; userId: string; brokerageId: string; userType: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }

  const { data: row } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (!row?.brokerage_id) return { ok: false, error: "Brokerage not configured" }
  if (!ADMIN_ROLES.has(row.user_type as string)) {
    return { ok: false, error: "Forbidden: requires broker / admin / team_lead" }
  }
  return {
    ok: true,
    userId:       user.id,
    brokerageId:  row.brokerage_id as string,
    userType:     row.user_type as string,
  }
}

// ─── Input types ────────────────────────────────────────────────────────────
export interface CreateLearningModuleInput {
  title:               string
  summary?:            string | null
  body?:               string | null
  coverImageUrl?:      string | null
  estimatedMinutes?:   number | null
  audienceRoles?:      string[]
  audiencePersonas?:   string[]
  audienceGenerations?: string[]
  audienceAgeSegs?:    string[]
  stageTags?:          string[]
  gapTags?:            string[]
  channels?:           Channel[]
  quizQuestions?:      unknown
  displayPriority?:    number
  teamId?:             string | null
}

export interface UpdateLearningModulePatch extends Partial<CreateLearningModuleInput> {
  status?: "draft" | "published" | "archived"
}

// ─── Create ─────────────────────────────────────────────────────────────────
export async function createLearningModuleAction(
  input: CreateLearningModuleInput,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth

  const supabase = createServiceClient()
  const insert = {
    brokerage_id:          auth.brokerageId,
    team_id:               input.teamId ?? null,
    authored_by:           auth.userId,
    title:                 input.title,
    summary:               input.summary ?? null,
    body:                  input.body ?? null,
    cover_image_url:       input.coverImageUrl ?? null,
    estimated_minutes:     input.estimatedMinutes ?? null,
    audience_roles:        input.audienceRoles        ?? [],
    audience_personas:     input.audiencePersonas     ?? [],
    audience_generations:  input.audienceGenerations  ?? [],
    audience_age_segs:     input.audienceAgeSegs      ?? [],
    stage_tags:            input.stageTags            ?? [],
    gap_tags:              input.gapTags              ?? [],
    channels:              input.channels             ?? [],
    quiz_questions:        input.quizQuestions ?? null,
    display_priority:      input.displayPriority ?? 0,
    status:                "draft",
  }
  const { data, error } = await supabase
    .from("learning_modules")
    .insert(insert)
    .select("id")
    .single()
  if (error || !data) return { ok: false, error: error?.message ?? "Insert failed" }

  revalidatePath("/dashboard/admin/learning-modules")
  return { ok: true, id: data.id as string }
}

// ─── Update ─────────────────────────────────────────────────────────────────
export async function updateLearningModuleAction(
  id: string,
  patch: UpdateLearningModulePatch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth

  const supabase = createServiceClient()
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.title              !== undefined) update.title              = patch.title
  if (patch.summary            !== undefined) update.summary            = patch.summary
  if (patch.body               !== undefined) update.body               = patch.body
  if (patch.coverImageUrl      !== undefined) update.cover_image_url    = patch.coverImageUrl
  if (patch.estimatedMinutes   !== undefined) update.estimated_minutes  = patch.estimatedMinutes
  if (patch.audienceRoles      !== undefined) update.audience_roles     = patch.audienceRoles
  if (patch.audiencePersonas   !== undefined) update.audience_personas  = patch.audiencePersonas
  if (patch.audienceGenerations!== undefined) update.audience_generations = patch.audienceGenerations
  if (patch.audienceAgeSegs    !== undefined) update.audience_age_segs  = patch.audienceAgeSegs
  if (patch.stageTags          !== undefined) update.stage_tags         = patch.stageTags
  if (patch.gapTags            !== undefined) update.gap_tags           = patch.gapTags
  if (patch.channels           !== undefined) update.channels           = patch.channels
  if (patch.quizQuestions      !== undefined) update.quiz_questions     = patch.quizQuestions
  if (patch.displayPriority    !== undefined) update.display_priority   = patch.displayPriority
  if (patch.teamId             !== undefined) update.team_id            = patch.teamId
  if (patch.status             !== undefined) {
    update.status = patch.status
    if (patch.status === "published") update.published_at = new Date().toISOString()
  }

  const { error } = await supabase
    .from("learning_modules")
    .update(update)
    .eq("id", id)
    .eq("brokerage_id", auth.brokerageId)
  if (error) return { ok: false, error: error.message }

  revalidatePath("/dashboard/admin/learning-modules")
  return { ok: true }
}

// ─── Publish (multi-channel fan-out) ────────────────────────────────────────
export interface PublishResult {
  ok:      true
  results: Array<{ channel: Channel; status: "published" | "failed"; externalId?: string; externalTable?: string; error?: string }>
}

export async function publishLearningModuleAction(
  moduleId:  string,
  channels:  Channel[],
): Promise<PublishResult | { ok: false; error: string }> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth

  const supabase = createServiceClient()

  const { data: mod, error: modErr } = await supabase
    .from("learning_modules")
    .select("id, brokerage_id, authored_by, team_id, title, summary, body, cover_image_url, estimated_minutes, channels, quiz_questions, audience_roles, stage_tags")
    .eq("id", moduleId)
    .eq("brokerage_id", auth.brokerageId)
    .maybeSingle()
  if (modErr || !mod) return { ok: false, error: modErr?.message ?? "Module not found" }

  const results: PublishResult["results"] = []
  const successfulChannels: Channel[] = []

  for (const ch of channels) {
    if (!ALLOWED_CHANNELS.has(ch)) {
      results.push({ channel: ch, status: "failed", error: `unknown channel: ${ch}` })
      continue
    }

    try {
      const r = await fanOutToChannel(supabase, ch, mod, auth.userId)

      const { error: pubErr } = await supabase
        .from("learning_module_channel_publications")
        .upsert({
          module_id:      mod.id,
          brokerage_id:   mod.brokerage_id,
          channel:        ch,
          external_id:    r.externalId ?? null,
          external_table: r.externalTable ?? null,
          external_url:   r.externalUrl ?? null,
          status:         "published",
          published_at:   new Date().toISOString(),
          error_message:  null,
        }, { onConflict: "module_id,channel" })
      if (pubErr) throw new Error(pubErr.message)

      results.push({ channel: ch, status: "published", externalId: r.externalId, externalTable: r.externalTable })
      successfulChannels.push(ch)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await supabase
        .from("learning_module_channel_publications")
        .upsert({
          module_id:     mod.id,
          brokerage_id:  mod.brokerage_id,
          channel:       ch,
          status:        "failed",
          error_message: msg,
        }, { onConflict: "module_id,channel" })
      results.push({ channel: ch, status: "failed", error: msg })
    }
  }

  // Flip module to 'published' once at least one channel succeeded
  if (successfulChannels.length > 0) {
    await supabase
      .from("learning_modules")
      .update({
        status:       "published",
        published_at: new Date().toISOString(),
        channels:     Array.from(new Set([...(mod.channels ?? []), ...successfulChannels])),
        updated_at:   new Date().toISOString(),
      })
      .eq("id", mod.id)
  }

  revalidatePath("/dashboard/admin/learning-modules")
  return { ok: true, results }
}

// ─── Per-channel fan-out ────────────────────────────────────────────────────
interface ChannelInsert {
  externalId?:    string
  externalTable?: string
  externalUrl?:   string
}

type ServiceClient = ReturnType<typeof createServiceClient>

interface ModuleRow {
  id:                 string
  brokerage_id:       string
  authored_by:        string | null
  team_id:            string | null
  title:              string
  summary:            string | null
  body:               string | null
  cover_image_url:    string | null
  estimated_minutes:  number | null
  channels:           string[] | null
  quiz_questions:     unknown
  audience_roles:     string[] | null
  stage_tags:         string[] | null
}

async function fanOutToChannel(
  supabase: ServiceClient,
  channel:  Channel,
  mod:      ModuleRow,
  authorUserId: string,
): Promise<ChannelInsert> {
  switch (channel) {
    case "article":
    case "blog": {
      const slug = `${slugify(mod.title)}-${mod.id.slice(0, 8)}`
      const { data, error } = await supabase
        .from("knowledge_articles")
        .insert({
          brokerage_id: mod.brokerage_id,
          author_id:    mod.authored_by ?? authorUserId,
          title:        mod.title,
          slug,
          content:      mod.body ?? mod.summary ?? mod.title,
          excerpt:      mod.summary ?? null,
          category:     channel === "blog" ? "blog" : "learning_module",
          tags:         channel === "blog" ? ["blog", "learning_module"] : ["learning_module"],
          status:       "published",
          published_at: new Date().toISOString(),
        })
        .select("id")
        .single()
      if (error || !data) throw new Error(error?.message ?? "article insert failed")
      return {
        externalId:    data.id as string,
        externalTable: "knowledge_articles",
        externalUrl:   `/knowledge/${slug}`,
      }
    }

    case "video": {
      // Sprint 7 + 1051 + 1052: real fan-out. Create an ai_video_projects
      // row + linked training_videos row.
      //
      //   * Provider — resolved from agent_voice_profiles.preferred_avatar_provider
      //     (default 'did') or global_settings.additional_settings.platform_video_provider.
      //     D-ID is the platform primary, not HeyGen. Earlier code hardcoded heygen.
      //   * audience_type — derived from learning_module.audience_roles:
      //       'customer' → 'customer_facing' (compliance gate applies)
      //       agent/staff/tc/compliance/team_lead → 'in_house' (brand voice only)
      //   * Initial provider columns — set heygen_status / provider_status
      //     to 'pending' only for the chosen provider.
      const { resolveVideoProvider, initialProviderColumns } = await import("@/lib/marketing/video-provider-resolver")
      const provider = await resolveVideoProvider(supabase, {
        brokerageId:  mod.brokerage_id,
        agentUserId:  mod.authored_by ?? authorUserId,
      })
      const providerCols = initialProviderColumns(provider)

      const audienceType = (mod.audience_roles ?? []).includes("customer")
        ? "customer_facing"
        : "in_house"

      const { data: avp, error: avpErr } = await supabase
        .from("ai_video_projects")
        .insert({
          brokerage_id:       mod.brokerage_id,
          agent_id:           mod.authored_by ?? authorUserId,
          title:              mod.title,
          script_content:     mod.body ?? mod.summary ?? mod.title,
          video_type:         "education",
          video_provider:     provider,
          ...providerCols,
          status:             "draft",
          approval_status:    "pending_review",
          is_ai_generated:    true,
          audience_type:      audienceType,
          learning_module_id: mod.id,
          video_metadata:     { description: mod.summary ?? null, source: "learning_module" },
        })
        .select("id")
        .single()
      if (avpErr || !avp) throw new Error(avpErr?.message ?? "ai_video_projects insert failed")

      const { data: tv, error: tvErr } = await supabase
        .from("training_videos")
        .insert({
          brokerage_id:        mod.brokerage_id,
          title:               mod.title,
          description:         mod.summary,
          category:             deriveVideoCategory(mod),
          video_url:            "pending://heygen",   // updated when HeyGen + approval finish
          thumbnail_url:        mod.cover_image_url,
          duration_seconds:     secondsFromMinutes(mod.estimated_minutes),
          created_by:           mod.authored_by ?? authorUserId,
          is_required:          false,
          is_ai_generated:      true,
          ai_video_project_id:  avp.id,
        })
        .select("id")
        .single()
      if (tvErr || !tv) throw new Error(tvErr?.message ?? "training_videos insert failed")

      return {
        externalId:    tv.id as string,
        externalTable: "training_videos",
        externalUrl:   `/training/${tv.id}`,
      }
    }

    case "podcast": {
      const { data: agentRow } = await supabase
        .from("agents")
        .select("id")
        .eq("user_id", mod.authored_by ?? authorUserId)
        .eq("brokerage_id", mod.brokerage_id)
        .maybeSingle()
      const agentId = (agentRow?.id as string | null) ?? null
      if (!agentId) throw new Error("podcast requires an agent row for authored_by user")

      const { data, error } = await supabase
        .from("podcast_episodes")
        .insert({
          brokerage_id: mod.brokerage_id,
          agent_id:     agentId,
          title:        mod.title,
          description:  mod.summary,
          script:       mod.body ?? mod.summary ?? "",
          status:       "draft",
          category:     "learning_module",
        })
        .select("id")
        .single()
      if (error || !data) throw new Error(error?.message ?? "podcast insert failed")
      return { externalId: data.id as string, externalTable: "podcast_episodes" }
    }

    case "newsletter":
    case "email": {
      const { data, error } = await supabase
        .from("newsletter_brokers_templates")
        .insert({
          brokerage_id: mod.brokerage_id,
          name:         channel === "email" ? `Email — ${mod.title}` : mod.title,
          content:      mod.body ?? mod.summary ?? mod.title,
          status:       "draft",
        })
        .select("id")
        .single()
      if (error || !data) throw new Error(error?.message ?? `${channel} insert failed`)
      return { externalId: data.id as string, externalTable: "newsletter_brokers_templates" }
    }

    case "social": {
      const { data, error } = await supabase
        .from("social_posts")
        .insert({
          brokerage_id: mod.brokerage_id,
          user_id:      mod.authored_by ?? authorUserId,
          platform:     "facebook",       // platform-agnostic draft; broker picks before approving
          post_type:    "custom",
          content:      truncateForSocial(mod.summary ?? mod.title),
          status:       "draft",
          ai_generated: false,
        })
        .select("id")
        .single()
      if (error || !data) throw new Error(error?.message ?? "social insert failed")
      return { externalId: data.id as string, externalTable: "social_posts" }
    }

    case "quiz": {
      // onboarding_quizzes.step_id is NOT NULL — we only publish if the module
      // is explicitly tied to a step. Otherwise, the quiz lives inline on the
      // learning_modules.quiz_questions jsonb and is delivered through the
      // module renderer (no separate quiz row needed).
      throw new Error("quiz channel: render inline from learning_modules.quiz_questions — no fan-out needed")
    }

    case "portal_lesson": {
      // No table insert. The portal_event_stream projector looks up
      // learning_module_channel_publications by channel='portal_lesson' to
      // know which modules to inject as lesson cards into the live feed.
      // Customer completion is recorded against learning_assignments
      // (contact_id, module_id) by markLessonRead / markResourceCompleted.
      return {
        externalTable: "portal_lesson_registry",
        externalUrl:   `/portal/lessons/${mod.id}`,
      }
    }
  }
}

function slugify(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 64)
}

/**
 * Map a learning_module's audience/stage to one of training_videos.category's
 * allowed values (CHECK: platform_tour / lead_management / listing_workflow /
 * transaction / portal / marketing / isa_engine / compliance / them_first /
 * mobile_app / custom). Everything Sprint 7 fans out as 'custom' unless it
 * obviously maps onto an existing bucket.
 */
function deriveVideoCategory(mod: ModuleRow): string {
  const roles  = mod.audience_roles  ?? []
  const stages = mod.stage_tags      ?? []
  if (roles.includes("customer"))           return "portal"
  if (roles.includes("agent"))              return "platform_tour"
  if (roles.includes("compliance_officer")) return "compliance"
  if (roles.includes("tc"))                 return "transaction"
  if (stages.some(s => /listing|showing/i.test(s))) return "listing_workflow"
  if (stages.some(s => /offer|inspection|appraisal|closing/i.test(s))) return "transaction"
  return "custom"
}

function secondsFromMinutes(mins: number | null | undefined): number {
  if (!mins || mins < 0) return 0
  return Math.round(mins * 60)
}

function truncateForSocial(s: string): string {
  return s.length <= 270 ? s : `${s.slice(0, 267)}...`
}

// ─── List + actor-wrapped composer (used by client UIs) ─────────────────────
export async function listLearningModulesForBrokerageAction(opts?: {
  limit?: number
}): Promise<
  | { ok: true; rows: Array<{ id: string; title: string; summary: string | null; status: string; channels: string[]; publishedAt: string | null; displayPriority: number }> }
  | { ok: false; error: string }
> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from("learning_modules")
    .select("id, title, summary, status, channels, published_at, display_priority")
    .eq("brokerage_id", auth.brokerageId)
    .order("created_at", { ascending: false })
    .limit(opts?.limit ?? 100)
  if (error) return { ok: false, error: error.message }
  const rows = (data ?? []).map((r: Record<string, unknown>) => ({
    id:               r.id as string,
    title:            r.title as string,
    summary:          (r.summary as string | null) ?? null,
    status:           r.status as string,
    channels:         (r.channels as string[] | null) ?? [],
    publishedAt:      (r.published_at as string | null) ?? null,
    displayPriority:  (r.display_priority as number | null) ?? 0,
  }))
  return { ok: true, rows }
}

export async function getLearningAssignmentsForActorAction(opts: {
  actorKind: LearningActorKind
  actorId:   string
  limit?:    number
}): Promise<{ ok: true; picks: LearningModulePick[] } | { ok: false; error: string }> {
  const supabase = await createClient()
  // Auth: caller must be signed in, and may only request picks for themselves
  // unless they're an admin in the same brokerage.
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }

  if (opts.actorKind !== "customer" && user.id !== opts.actorId) {
    const { data: row } = await supabase
      .from("users")
      .select("user_type")
      .eq("id", user.id)
      .maybeSingle()
    if (!row || !ADMIN_ROLES.has((row.user_type as string) ?? "")) {
      return { ok: false, error: "Forbidden" }
    }
  }

  const picks = await pickLearningModulesForActor({
    supabase,
    actorKind: opts.actorKind,
    actorId:   opts.actorId,
    limit:     opts.limit,
  })
  return { ok: true, picks }
}
