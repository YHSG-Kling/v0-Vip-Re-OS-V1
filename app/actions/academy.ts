"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"

export async function getAcademyContent(filters?: {
  type?: string
  tags?: string[]
  searchQuery?: string
}) {
  const supabase = await createClient()

  let query = supabase
    .from("academy_content")
    .select("*")
    .eq("is_published", true)
    .order("view_count", { ascending: false })

  if (filters?.type) {
    query = query.eq("type", filters.type)
  }

  if (filters?.tags && filters.tags.length > 0) {
    query = query.contains("tags", filters.tags)
  }

  if (filters?.searchQuery) {
    query = query.ilike("title", `%${filters.searchQuery}%`)
  }

  const { data: academyRows, error } = await query

  if (error) {
    console.error("Error fetching academy content:", error)
  }

  // Also include resources saved via EducationEditor (educational_moments table)
  let momentsQuery = supabase
    .from("educational_moments")
    .select("id, title, description, content_type, content, estimated_minutes, created_at")
    .order("created_at", { ascending: false })
    .limit(50)

  if (filters?.searchQuery) {
    momentsQuery = momentsQuery.ilike("title", `%${filters.searchQuery}%`)
  }
  if (filters?.type) {
    momentsQuery = momentsQuery.eq("content_type", filters.type)
  }

  const { data: momentsRows } = await momentsQuery

  const mappedMoments = (momentsRows ?? []).map((m: any) => ({
    id: m.id,
    title: m.title,
    type: m.content_type,
    description: m.description ?? "",
    content: m.content ?? "",
    estimated_minutes: m.estimated_minutes ?? 5,
    tags: [],
    view_count: 0,
    is_published: true,
    created_at: m.created_at,
    _source: "educational_moments",
  }))

  return [...(academyRows ?? []), ...mappedMoments]
}

export async function getMarketplaceTemplates(filters?: {
  tags?: string[]
  searchQuery?: string
  sortBy?: "popular" | "recent" | "top_rated"
}) {
  const supabase = await createClient()

  let query = supabase.from("template_marketplace").select("*").in("visibility", ["global", "brokerage_only"])

  if (filters?.tags && filters.tags.length > 0) {
    query = query.contains("tags", filters.tags)
  }

  if (filters?.searchQuery) {
    query = query.or(`name.ilike.%${filters.searchQuery}%,description.ilike.%${filters.searchQuery}%`)
  }

  // Sort
  if (filters?.sortBy === "popular") {
    query = query.order("clone_count", { ascending: false })
  } else if (filters?.sortBy === "top_rated") {
    query = query.order("average_rating", { ascending: false })
  } else {
    query = query.order("created_at", { ascending: false })
  }

  const { data, error } = await query

  if (error) {
    console.error("Error fetching templates:", error)
    return []
  }

  return data || []
}

export async function cloneTemplate(templateId: string) {
  const supabase = await createClient()

  // Get the template
  const { data: template, error: fetchError } = await supabase
    .from("template_marketplace")
    .select("*")
    .eq("id", templateId)
    .single()

  if (fetchError || !template) {
    return { error: "Template not found" }
  }

  // Get current user
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { error: "Not authenticated" }
  }

  // Clone the playbook
  const { data: clonedPlaybook, error: cloneError } = await supabase
    .from("plan_tasks")
    .insert({
      name: `${template.name} (Copy)`,
      description: template.description,
      trigger_type: template.source_playbook?.trigger_type || "manual",
      audience_filter: template.source_playbook?.audience_filter || {},
      steps: template.source_playbook?.steps || [],
      agent_id: user.id,
      is_active: false, // Clones start as inactive
    })
    .select()
    .single()

  if (cloneError) {
    console.error("Error cloning playbook:", cloneError)
    return { error: "Failed to clone template" }
  }

  // Increment clone count
  await supabase
    .from("template_marketplace")
    .update({ clone_count: (template.clone_count || 0) + 1 })
    .eq("id", templateId)

  revalidatePath("/academy")
  return { success: true, playbook: clonedPlaybook }
}

export async function incrementViewCount(contentId: string) {
  const supabase = await createClient()

  await supabase.rpc("increment_view_count", { content_id: contentId })
}

export async function addTemplateFeedback(data: {
  templateId: string
  feedbackType: "comment" | "upvote" | "request_variation"
  comment?: string
  rating?: number
}) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { error: "Not authenticated" }
  }

  const { error } = await supabase.from("template_feedback").insert({
    template_id: data.templateId,
    user_id: user.id,
    feedback_type: data.feedbackType,
    comment: data.comment,
    rating: data.rating,
  })

  if (error) {
    console.error("Error adding feedback:", error)
    return { error: "Failed to add feedback" }
  }

  revalidatePath("/academy")
  return { success: true }
}

export async function getTopContributors() {
  const supabase = await createClient()

  const { data, error } = await supabase.rpc("get_top_contributors_with_stats")

  if (error) {
    console.error("Error fetching contributors:", error)
    // Return empty array to allow fallback to mock data
    return []
  }

  return data || []
}

export async function getTemplateFeedback(templateId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("template_feedback")
    .select(`
      *,
      user:user_id (
        name,
        avatar_url
      )
    `)
    .eq("template_id", templateId)
    .order("created_at", { ascending: false })
    .limit(10)

  if (error) {
    console.error("Error fetching feedback:", error)
    return []
  }

  return data || []
}
