"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { parseAIJsonResponse } from "@/lib/ai/parse-json-response"

// Most actions in this file used to trust caller-supplied userId/userRole.
// Now: every action derives identity from the session via getAgentContext.
async function requireCaller(): Promise<
  | { ok: true; userId: string; brokerageId: string; userType: string }
  | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { ok: false, error: "Unauthorized" }
  }
  return { ok: true, userId: ctx.userId, brokerageId: ctx.brokerageId, userType: ctx.userType ?? "agent" }
}

// TOMBSTONE: local parseAIJsonResponse merged onto
// lib/ai/parse-json-response.ts parseAIJsonResponse (imported above) — §1/§6
// SAME BODY census round 3, 2026-09-09.

function shouldFilterByUser(role: string): boolean {
  // Admin, Broker, and Compliance Officer see all content
  // SCOPE LADDER (kept inline — admits compliance tier; legacy uppercase
  // spellings retained for old rows): 'superadmin'/'super_admin' removed — dead
  // as users.user_type (0 live rows store either spelling).
  const adminRoles = ["ADMIN", "BROKER", "COMPLIANCE_OFFICER", "admin", "broker", "broker_owner", "broker_admin", "compliance_officer"]
  return !adminRoles.includes(role)
}

// Generate AI Content Ideas based on trends and persona
export async function generateContentIdeas(persona?: string, _userId?: string, _userRole?: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = createServiceClient()

  try {
    // THE TOPIC BANK FEEDS THE STUDIO (owner ruling 22 — wave 145, lane 145Z; lane 145I open loop): the tenant's live topics (its
    // own + platform rows, fresh, unexpired) are offered to the model by id; an idea drawn from one names it (content_ideas.topic_id,
    // m872) so topic → idea → creative attribution joins through the studio board. A refused read is said and the ideas are still
    // made (from the persona alone, with no lineage) — never a guessed topic.
    const nowIso = new Date().toISOString()
    const { data: topicRows, error: topicErr } = await supabase
      .from("content_topic_bank")
      .select("id, topic_title, value_angle")
      .or(`brokerage_id.is.null,brokerage_id.eq.${auth.brokerageId}`)
      .eq("status", "fresh")
      .gte("expires_at", nowIso)
      .order("engagement_score", { ascending: false })
      .limit(8)
    if (topicErr) console.error(`[content-studio] topic bank NOT read — ideas made without topic lineage: ${topicErr.message}`)
    const topics = ((topicRows ?? []) as Array<{ id: string; topic_title: string | null; value_angle: string | null }>).filter((t) => t.id && t.topic_title)
    const topicIds = new Set(topics.map((t) => t.id))
    const topicBlock = topics.length
      ? `\n      Draw each idea from ONE of these topics where it fits, and return that topic's id as "topic_id" (null when the idea is not from a topic — never invent an id):\n${topics.map((t) => `      - ${t.id}: ${t.topic_title}${t.value_angle ? ` (${t.value_angle})` : ""}`).join("\n")}\n`
      : ""

    // Use AI to generate fresh content ideas
    const { text } = await generateText({
      brokerageId: auth.brokerageId,
      userId: auth.userId,
      model: "openai/gpt-4o-mini",
      prompt: `Generate 5 fresh, engaging content ideas for a real estate agent targeting ${persona || "general audience"}. 
      Focus on educational, empathy-driven content that follows the "Them First" philosophy.
      ${topicBlock}
      IMPORTANT: You must respond with ONLY valid JSON, no explanatory text.
      
      Return exactly this format:
      [
        {"title": "Content Title", "description": "Brief description", "type": "video", "topic_id": null},
        {"title": "Another Title", "description": "Description text", "type": "social_post", "topic_id": null}
      ]
      
      Types must be one of: video, social_post, blog, tool`,
    })

    const ideas = parseAIJsonResponse(text)

    // Save to database — stamp brokerage_id + created_by from session
    const { data, error: ideasSaveErr } = await supabase
      .from("content_ideas")
      .insert(
        ideas.map((idea: any) => ({
          title: idea.title,
          description: idea.description,
          content_type: idea.type,
          status: "idea",
          brokerage_id: auth.brokerageId,
          created_by: auth.userId,
        })),
      )
      .select()
    if (ideasSaveErr) console.error(`[content-studio] content ideas NOT saved: ${ideasSaveErr.message}`)

    // LINEAGE — each saved idea's topic (only an id the bank OFFERED; anything else is null), in its own tenant-pinned UPDATE so a
    // database without m872 keeps the ideas (42703 / PGRST204 = not applied, said once).
    const saved = (data ?? []) as Array<{ id: string }>
    for (let i = 0; i < saved.length; i++) {
      const raw = (ideas[i] as { topic_id?: unknown } | undefined)?.topic_id
      const topicId = typeof raw === "string" && topicIds.has(raw) ? raw : null
      if (!topicId) continue
      const { data: stamped, error: lineageErr } = await supabase.from("content_ideas").update({ topic_id: topicId })
        .eq("id", saved[i].id).eq("brokerage_id", auth.brokerageId).select("id")
      if (lineageErr) {
        const code = String((lineageErr as { code?: string }).code ?? "")
        console.error(`[content-studio] idea ${saved[i].id}: topic lineage NOT recorded${code === "42703" || code === "PGRST204" ? " (m872 not applied)" : ""}: ${lineageErr.message}`)
        if (code === "42703" || code === "PGRST204") break
      } else if ((stamped ?? []).length !== 1) console.error(`[content-studio] idea ${saved[i].id}: topic lineage matched no row`)
    }

    revalidatePath("/content-studio")
    return { success: true, ideas: data }
  } catch (error) {
    console.error("Generate content ideas error:", error)
    return { success: false, error: "Failed to generate ideas" }
  }
}

// Research Keywords for SEO
// Delegates to discoverKeywordsAI which resolves territory from brokerages table
// and incorporates tracked competitors from the competitors table
export async function researchKeywords(topic: string, _userId?: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }
  const brokerageId = auth.brokerageId

  const supabase = createServiceClient()

  // Pull tracked competitors so AI can surface competitor_usage flags
  const { data: competitorRows } = await supabase
    .from("competitors")
    .select("competitor_name")
    .eq("brokerage_id", brokerageId)
  const competitorNames = competitorRows?.map((c) => c.competitor_name) ?? []

  // Delegate to the full keyword discovery engine (territory auto-resolved from brokerages table)
  const { discoverKeywordsAI } = await import("@/app/actions/blog")
  // RECEIPT (wave 155, lane 155R5 — G11): the model call is claimed → run → settled on agent_action_ledger (who asked, under
  // which risk class); ai_tool_usage stays the cost ledger, written by the same inner call with the same numbers (CLAUDE.md §5).
  const { ledgerToolCall } = await import("@/lib/kernel/action-ledger")
  const result = await ledgerToolCall({ brokerageId, action: "ai.keyword_research.generate", actor: { type: "user", userId: auth.userId }, subject: { type: "brokerage", id: brokerageId }, reasonCode: "HUMAN_REQUESTED", riskClass: "READ", systemSource: "content_studio_keywords" }, () => discoverKeywordsAI(auth.userId, {
    brokerageId,
    competitorNames: competitorNames.length ? competitorNames : undefined,
    focusArea: topic,
  })) as Awaited<ReturnType<typeof discoverKeywordsAI>>

  if (!result.success) {
    return { success: false, error: result.error ?? "Keyword research is temporarily unavailable." }
  }

  // Map DiscoveredKeyword to the format the content-studio UI expects. WAVE 154 (lane 154G1 — directive G1 "no invented
  // monthly search volume"): popularity_pct is a MODEL-ESTIMATED 0–100 relative score (app/actions/blog.ts DiscoveredKeyword),
  // not a count of searches — it used to reach the screen ×100 as `searchVolume`, beside an invented `difficulty: 50` and a
  // "competition" read off that same popularity number. A number nobody measured is null; the screen renders "unknown".
  const keywords = (result.keywords ?? []).map((k) => ({
    keyword: k.keyword,
    searchVolume: null as number | null,
    relativeIndex: typeof k.popularity_pct === "number" && Number.isFinite(k.popularity_pct) ? Math.max(0, Math.min(100, Math.round(k.popularity_pct))) : null,
    relativeIndexBasis: "model-estimated relative interest (0–100) — not a count of searches",
    difficulty: null as number | null,
    competition: null as string | null,
    keywordType: k.keyword_type,
    competitorUsage: k.competitor_usage,
    rationale: k.rationale,
  }))

  return { success: true, keywords }
}

// Get Content Ideas
export async function getContentIdeas(_userId?: string, _userRole?: string) {
  const auth = await requireCaller()
  if (!auth.ok) return []

  const supabase = createServiceClient()

  try {
    // The topic behind an idea (m872, owner ruling 22) rides along: the board shows which topic-bank theme an idea
    // came from, so topic → idea → creative attribution can be read where ideas are chosen. One FK links the two
    // tables, so the bare embed is unambiguous (PGRST201 needs two).
    let query = supabase
      .from("content_ideas")
      .select("id, brokerage_id, created_by, title, description, content_type, status, created_at, topic_id, topic:content_topic_bank(id, topic_title)")
      .eq("brokerage_id", auth.brokerageId)
      .order("created_at", { ascending: false })
      .limit(50)

    if (shouldFilterByUser(auth.userType)) {
      query = query.eq("created_by", auth.userId)
    }

    const { data, error } = await query

    if (error) {
      console.log("[v0] Get content ideas error:", error)
      return []
    }

    return data || []
  } catch (error) {
    console.log("[v0] Get content ideas error:", error)
    return []
  }
}

// Get Competitor Content — the tenant's OBSERVED competitor posts (competitor_content, written by
// lib/competitive-intel/content-intel-scan.ts). WAVE 154 (lane 154G1 — directive G2 "verified competitor ideas with measured
// or honestly proxy-labeled relative performance"): at the batch-2 base this asked a model to "use realistic metrics for
// openRate (30-60) and clickRate (5-20)" and returned those invented numbers as competitor data on two screens. Now it reads
// what was observed; open / click rates of another business's email are unknowable here and are null; hard counts are
// summed only when present; an Exa row's number is a citation-rank proxy and is labeled so. The post's caption is NOT
// returned — the theme (detected topics + hook) is what a subscriber builds an original piece from.
export async function getCompetitorContent(_userId?: string, _userRole?: string) {
  const auth = await requireCaller()
  if (!auth.ok) return []

  const supabase = createServiceClient()
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { data, error } = await supabase
    .from("competitor_content")
    .select("id, platform, content_type, content_url, posted_at, observed_at, likes_count, comments_count, shares_count, views_count, raw_engagement_data, detected_topics, hook_type, competitor_profiles(competitor_name)")
    .eq("brokerage_id", auth.brokerageId)
    .gte("observed_at", since)
    .order("observed_at", { ascending: false })
    .limit(20)
  if (error) {
    console.error(`[content-studio] competitor_content read refused — no competitor posts shown: ${error.message}`)
    return []
  }
  return ((data ?? []) as Array<{
    id: string; platform: string | null; content_type: string | null; content_url: string | null; posted_at: string | null; observed_at: string | null
    likes_count: number | null; comments_count: number | null; shares_count: number | null; views_count: number | null
    raw_engagement_data: { source?: string | null } | null; detected_topics: string[] | null; hook_type: string | null
    competitor_profiles: { competitor_name: string | null } | Array<{ competitor_name: string | null }> | null
  }>).map((r) => {
    const profile = Array.isArray(r.competitor_profiles) ? r.competitor_profiles[0] : r.competitor_profiles
    const counts = [r.likes_count, r.comments_count, r.shares_count, r.views_count].filter((n): n is number => typeof n === "number")
    const engagement = counts.length ? counts.reduce((s, n) => s + n, 0) : null
    const topics = (r.detected_topics ?? []).slice(0, 4)
    const summary = topics.length ? `Theme: ${topics.join(", ")}${r.hook_type ? ` · hook: ${r.hook_type}` : ""}` : (r.hook_type ? `Hook: ${r.hook_type}` : "Theme not detected")
    const evidenceLabel = engagement !== null
      ? "measured public interactions (platform counts)"
      : r.raw_engagement_data?.source === "exa" ? "search-citation rank proxy — not engagement; hard counts unknown" : "engagement unknown"
    return {
      id: r.id, competitor_name: profile?.competitor_name ?? "Unknown competitor", title: topics[0] ?? r.hook_type ?? "Competitor post",
      content: summary, content_summary: summary, platform: r.platform, content_type: r.content_type, content_url: r.content_url,
      posted_at: r.posted_at, observed_at: r.observed_at, engagement, evidenceLabel,
      openRate: null as number | null, clickRate: null as number | null, sentToCount: null as number | null,
    }
  })
}

// Add Competitor to Monitor
export async function addCompetitor(name: string, url?: string) {
  const auth = await requireCaller()
  if (!auth.ok) return { error: auth.error }
  const brokerageId = auth.brokerageId

  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("competitors")
    .insert({
      brokerage_id: brokerageId,
      competitor_name: name,
      competitor_url: url ?? null,
    })
    .select("id, competitor_name, competitor_url, created_at")
    .single()

  if (error) {
    // Unique constraint violation — competitor already tracked
    if (error.code === "23505") {
      const { data: existing } = await supabase
        .from("competitors")
        .select("id, competitor_name, competitor_url, created_at")
        .eq("brokerage_id", brokerageId)
        .eq("competitor_name", name)
        .single()
      return existing
    }
    console.error("[v0] addCompetitor error:", error)
    return { error: error.message }
  }

  return data
}

// Get Content Calendar - using content_ideas table as substitute
export async function getContentCalendar(_userId?: string, _userRole?: string) {
  const auth = await requireCaller()
  if (!auth.ok) return []

  const supabase = createServiceClient()

  let query = supabase
    .from("content_ideas")
    .select("*")
    .eq("brokerage_id", auth.brokerageId)
    .eq("status", "in_progress")
    .order("created_at", { ascending: false })
    .limit(30)

  if (shouldFilterByUser(auth.userType)) {
    query = query.eq("created_by", auth.userId)
  }

  const { data, error } = await query

  if (error) {
    console.log("[v0] Content calendar error:", error)
    return []
  }

  return data || []
}

// Schedule Content — writes to campaign_calendar so platform/channel is preserved
export async function scheduleContent(params: {
  title: string
  contentType: string
  scheduledDate: string
  platform?: string
  notes?: string
}) {
  const auth = await requireCaller()
  if (!auth.ok) throw new Error(auth.error)
  const brokerageId = auth.brokerageId
  const userId = auth.userId
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("campaign_calendar")
    .insert({
      brokerage_id: brokerageId,
      agent_user_id: userId, // campaign_calendar.agent_user_id FKs users(id) — never agents(id)
      event_type: params.contentType,
      channel: params.platform ?? null,
      title: params.title,
      scheduled_at: params.scheduledDate,
      notes: params.notes ?? "",
      status: "scheduled",
    })
    .select()
    .maybeSingle()

  if (error) {
    console.error("[v0] Schedule content error:", error)
    throw error
  }

  revalidatePath("/dashboard/marketing/studio")
  return data
}

// Get Publishing Stats
export async function getPublishingStats(_userId?: string, _userRole?: string) {
  const auth = await requireCaller()
  if (!auth.ok) {
    return { totalPosts: 0, published: 0, scheduled: 0, drafts: 0, totalEngagement: 0 }
  }

  const supabase = createServiceClient()

  let query = supabase
    .from("content_ideas")
    .select("status, content_type")
    .eq("brokerage_id", auth.brokerageId)

  if (shouldFilterByUser(auth.userType)) {
    query = query.eq("created_by", auth.userId)
  }

  const { data, error } = await query

  if (error) {
    console.log("[v0] Publishing stats error:", error)
    return {
      totalPosts: 0,
      published: 0,
      scheduled: 0,
      drafts: 0,
      totalEngagement: 0,
    }
  }

  const stats = {
    totalPosts: data?.length || 0,
    published: data?.filter((d) => d.status === "published").length || 0,
    scheduled: data?.filter((d) => d.status === "in_progress").length || 0,
    drafts: data?.filter((d) => d.status === "idea").length || 0,
    totalEngagement: 0, // Not available in this schema
  }

  return stats
}

// Save Content Idea
export async function saveContentIdea(idea: string, contentType: string, persona?: string) {
  const auth = await requireCaller()
  if (!auth.ok) throw new Error(auth.error)

  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("content_ideas")
    .insert({
      title: idea,
      description: `Target persona: ${persona || "general"}`,
      content_type: contentType,
      status: "idea",
      brokerage_id: auth.brokerageId,
      created_by: auth.userId,
    })
    .select()
    .maybeSingle()

  if (error) throw error

  revalidatePath("/content-studio")
  return data
}

// Get Saved Ideas
export async function getSavedIdeas(_userId?: string, _userRole?: string) {
  const auth = await requireCaller()
  if (!auth.ok) return []

  const supabase = createServiceClient()

  let query = supabase
    .from("content_ideas")
    .select("*")
    .eq("brokerage_id", auth.brokerageId)
    .eq("status", "idea")
    .order("created_at", { ascending: false })
    .limit(20)

  if (shouldFilterByUser(auth.userType)) {
    query = query.eq("created_by", auth.userId)
  }

  const { data, error } = await query

  if (error) {
    console.log("[v0] Get saved ideas error:", error)
    return []
  }

  return data || []
}
