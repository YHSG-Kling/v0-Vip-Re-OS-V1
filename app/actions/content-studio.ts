"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { getAgentContext } from "@/lib/identity/get-agent-context"

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

function parseAIJsonResponse(text: string) {
  // Strip markdown code blocks if present
  let cleanText = text.trim()
  if (cleanText.startsWith("```json")) {
    cleanText = cleanText.replace(/^```json\s*/, "").replace(/```\s*$/, "")
  } else if (cleanText.startsWith("```")) {
    cleanText = cleanText.replace(/^```\s*/, "").replace(/```\s*$/, "")
  }
  return JSON.parse(cleanText.trim())
}

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
    // Use AI to generate fresh content ideas
    const { text } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `Generate 5 fresh, engaging content ideas for a real estate agent targeting ${persona || "general audience"}. 
      Focus on educational, empathy-driven content that follows the "Them First" philosophy.
      
      IMPORTANT: You must respond with ONLY valid JSON, no explanatory text.
      
      Return exactly this format:
      [
        {"title": "Content Title", "description": "Brief description", "type": "video"},
        {"title": "Another Title", "description": "Description text", "type": "social_post"}
      ]
      
      Types must be one of: video, social_post, blog, tool`,
    })

    const ideas = parseAIJsonResponse(text)

    // Save to database — stamp brokerage_id + created_by from session
    const { data } = await supabase
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
  const result = await discoverKeywordsAI(auth.userId, {
    brokerageId,
    competitorNames: competitorNames.length ? competitorNames : undefined,
    focusArea: topic,
  })

  if (!result.success) {
    return { success: false, error: result.error ?? "Keyword research is temporarily unavailable." }
  }

  // Map DiscoveredKeyword to the format the content-studio UI expects
  const keywords = (result.keywords ?? []).map((k) => ({
    keyword: k.keyword,
    searchVolume: Math.round(k.popularity_pct * 100), // relative score as proxy for volume
    difficulty: 50, // AI doesn't provide difficulty; use neutral default
    competition: k.popularity_pct > 70 ? "high" : k.popularity_pct > 40 ? "medium" : "low",
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
    let query = supabase
      .from("content_ideas")
      .select("*")
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

// Get Competitor Content — uses tracked competitors from the competitors table
export async function getCompetitorContent(_userId?: string, _userRole?: string) {
  const auth = await requireCaller()
  if (!auth.ok) return []

  const supabase = createServiceClient()

  // Fetch the brokerage's tracked competitors for context-specific analysis
  const { data: competitorRows } = await supabase
    .from("competitors")
    .select("competitor_name, competitor_url")
    .eq("brokerage_id", auth.brokerageId)
    .limit(10)

  const competitorList =
    competitorRows?.map((c) => c.competitor_name).join(", ") ||
    "top local real estate agents and brokerages"

  try {
    const { text } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `Analyze the high-performing content strategy for these local real estate competitors: ${competitorList}.

      IMPORTANT: You must respond with ONLY valid JSON, no explanatory text.

      Return exactly this format (5 items, using the competitor names listed above):
      [
        {"competitor_name": "Name from list", "content_summary": "What they post about and why it performs", "content_type": "video|blog|social", "sentToCount": 1500, "openRate": 45.2, "clickRate": 12.8}
      ]

      Use realistic metrics for openRate (30-60) and clickRate (5-20). Use the actual competitor names.`,
    })

    const competitorData = parseAIJsonResponse(text)
    return competitorData
  } catch (error) {
    console.log("[v0] Competitor content generation error:", error)
    return []
  }
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
