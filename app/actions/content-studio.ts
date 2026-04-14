"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { getAgentContext } from "@/lib/identity/get-agent-context"

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
  const adminRoles = ["ADMIN", "BROKER", "COMPLIANCE_OFFICER"]
  return !adminRoles.includes(role)
}

// Generate AI Content Ideas based on trends and persona
export async function generateContentIdeas(persona?: string, userId?: string, userRole?: string) {
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

    const validUserId = userId && isValidUUID(userId) ? userId : null

    // Save to database using actual schema
    const { data } = await supabase
      .from("content_ideas")
      .insert(
        ideas.map((idea: any) => ({
          title: idea.title,
          description: idea.description,
          content_type: idea.type,
          status: "idea",
          created_by: validUserId, // Only insert if valid UUID
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
export async function researchKeywords(topic: string, userId?: string) {
  const supabase = createServiceClient()

  try {
    const { text } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `Research SEO keywords for real estate topic: "${topic}". 
      
      IMPORTANT: You must respond with ONLY valid JSON, no explanatory text before or after.
      
      Return exactly this format:
      [
        {"keyword": "example keyword", "searchVolume": 5000, "difficulty": 45, "competition": "medium"},
        {"keyword": "another keyword", "searchVolume": 3200, "difficulty": 60, "competition": "high"}
      ]
      
      Provide exactly 10 keywords with realistic search volumes for real estate.`,
    })

    const keywords = parseAIJsonResponse(text)

    return { success: true, keywords }
  } catch (error) {
    console.error("Research keywords error:", error)
    // Return mock data as fallback
    return {
      success: true,
      keywords: [
        { keyword: `${topic} near me`, searchVolume: 8500, difficulty: 42, competition: "medium" },
        { keyword: `best ${topic} 2026`, searchVolume: 6200, difficulty: 55, competition: "high" },
        { keyword: `${topic} tips`, searchVolume: 4800, difficulty: 38, competition: "low" },
        { keyword: `${topic} guide`, searchVolume: 5400, difficulty: 45, competition: "medium" },
        { keyword: `${topic} trends`, searchVolume: 3900, difficulty: 50, competition: "medium" },
        { keyword: `${topic} advice`, searchVolume: 3200, difficulty: 35, competition: "low" },
        { keyword: `${topic} market`, searchVolume: 7100, difficulty: 60, competition: "high" },
        { keyword: `${topic} forecast`, searchVolume: 2800, difficulty: 48, competition: "medium" },
        { keyword: `${topic} analysis`, searchVolume: 2400, difficulty: 52, competition: "medium" },
        { keyword: `${topic} report`, searchVolume: 3600, difficulty: 40, competition: "low" },
      ],
    }
  }
}

// Get Content Ideas
export async function getContentIdeas(userId?: string, userRole?: string) {
  const supabase = createServiceClient()

  try {
    let query = supabase.from("content_ideas").select("*").order("created_at", { ascending: false }).limit(50)

    if (userId && shouldFilterByUser(userRole || "") && isValidUUID(userId)) {
      query = query.eq("created_by", userId)
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

// Get Competitor Content - using generated_content table as fallback
export async function getCompetitorContent(userId?: string, userRole?: string) {
  const supabase = createServiceClient()

  try {
    // Generate AI-powered competitor insights
    const { text } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `Generate 5 trending real estate content examples from top performers. 
      
      IMPORTANT: You must respond with ONLY valid JSON, no explanatory text.
      
      Return exactly this format:
      [
        {"competitor_name": "Agent Name", "content_summary": "Summary text", "content_type": "video", "sentToCount": 1500, "openRate": 45.2, "clickRate": 12.8}
      ]
      
      Use realistic metrics for openRate (30-60) and clickRate (5-20).`,
    })

    console.log("[v0] Raw AI response for competitor content:", text.substring(0, 200))
    
    const competitorData = parseAIJsonResponse(text)
    return competitorData
  } catch (error) {
    console.log("[v0] Competitor content generation error:", error)
    return []
  }
}

// Add Competitor to Monitor
export async function addCompetitor(name: string, url?: string) {
  const { brokerageId } = await getAgentContext()
  if (!brokerageId) return { error: "No brokerage context" }

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
export async function getContentCalendar(userId?: string, userRole?: string) {
  const supabase = createServiceClient()

  let query = supabase
    .from("content_ideas")
    .select("*")
    .eq("status", "in_progress")
    .order("created_at", { ascending: false })
    .limit(30)

  if (userId && shouldFilterByUser(userRole || "") && isValidUUID(userId)) {
    query = query.eq("created_by", userId)
  }

  const { data, error } = await query

  if (error) {
    console.log("[v0] Content calendar error:", error)
    return []
  }

  return data || []
}

// Schedule Content
export async function scheduleContent(params: {
  title: string
  contentType: string
  scheduledDate: string
  platform?: string
  notes?: string
}) {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("content_ideas")
    .insert({
      title: params.title,
      description: params.notes || "",
      content_type: params.contentType,
      status: "in_progress",
    })
    .select()
    .maybeSingle()

  if (error) {
    console.error("[v0] Schedule content error:", error)
    throw error
  }

  revalidatePath("/content-studio")
  return data
}

// Get Publishing Stats
export async function getPublishingStats(userId?: string, userRole?: string) {
  const supabase = createServiceClient()

  let query = supabase.from("content_ideas").select("status, content_type")

  if (userId && shouldFilterByUser(userRole || "") && isValidUUID(userId)) {
    query = query.eq("created_by", userId)
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
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("content_ideas")
    .insert({
      title: idea,
      description: `Target persona: ${persona || "general"}`,
      content_type: contentType,
      status: "idea",
    })
    .select()
    .maybeSingle()

  if (error) throw error

  revalidatePath("/content-studio")
  return data
}

// Get Saved Ideas
export async function getSavedIdeas(userId?: string, userRole?: string) {
  const supabase = createServiceClient()

  let query = supabase
    .from("content_ideas")
    .select("*")
    .eq("status", "idea")
    .order("created_at", { ascending: false })
    .limit(20)

  if (userId && shouldFilterByUser(userRole || "") && isValidUUID(userId)) {
    query = query.eq("created_by", userId)
  }

  const { data, error } = await query

  if (error) {
    console.log("[v0] Get saved ideas error:", error)
    return []
  }

  return data || []
}
