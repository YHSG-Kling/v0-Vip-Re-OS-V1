"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"

export type ListingTaskTemplate = {
  id: string
  brokerage_id: string
  stage: string
  title: string
  description: string | null
  owner_role: string
  due_offset_days: number
  priority: string
  is_required: boolean
  is_active: boolean
  created_at: string
  updated_at: string
}

async function getBrokerageId(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")
  const { data: profile } = await supabase.from("users").select("brokerage_id").eq("id", user.id).single()
  if (!profile?.brokerage_id) throw new Error("No brokerage found")
  return { userId: user.id, brokerageId: profile.brokerage_id }
}

export async function getListingTaskTemplates(): Promise<ListingTaskTemplate[]> {
  const supabase = await createClient()
  const { brokerageId } = await getBrokerageId(supabase)

  const { data, error } = await supabase
    .from("listing_task_templates")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .order("stage")
    .order("due_offset_days")

  if (error) throw new Error(error.message)
  return (data ?? []) as ListingTaskTemplate[]
}

export async function createListingTaskTemplate(params: {
  stage: string
  title: string
  description?: string
  owner_role?: string
  due_offset_days?: number
  priority?: string
  is_required?: boolean
}): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { brokerageId } = await getBrokerageId(supabase)

  const { error } = await supabase.from("listing_task_templates").insert({
    brokerage_id:    brokerageId,
    stage:           params.stage,
    title:           params.title,
    description:     params.description ?? null,
    owner_role:      params.owner_role ?? "agent",
    due_offset_days: params.due_offset_days ?? 0,
    priority:        params.priority ?? "medium",
    is_required:     params.is_required ?? true,
    is_active:       true,
  })

  if (error) return { success: false, error: error.message }
  revalidatePath("/dashboard/settings/listing-task-templates")
  return { success: true }
}

export async function updateListingTaskTemplate(
  id: string,
  params: Partial<{
    title: string
    description: string
    owner_role: string
    due_offset_days: number
    priority: string
    is_required: boolean
    is_active: boolean
  }>
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { brokerageId } = await getBrokerageId(supabase)

  const { error } = await supabase
    .from("listing_task_templates")
    .update({ ...params, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("brokerage_id", brokerageId)

  if (error) return { success: false, error: error.message }
  revalidatePath("/dashboard/settings/listing-task-templates")
  return { success: true }
}

export async function deleteListingTaskTemplate(id: string): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { brokerageId } = await getBrokerageId(supabase)

  const { error } = await supabase
    .from("listing_task_templates")
    .delete()
    .eq("id", id)
    .eq("brokerage_id", brokerageId)

  if (error) return { success: false, error: error.message }
  revalidatePath("/dashboard/settings/listing-task-templates")
  return { success: true }
}
