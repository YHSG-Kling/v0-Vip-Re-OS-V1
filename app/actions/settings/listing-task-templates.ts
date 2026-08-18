"use server"

import { revalidatePath } from "next/cache"
// ★ ACT-AS WRITE SEAM ★ — the tenant resolves from the acting context (the
// impersonated seat under act-as, never the raw staff row), writers refuse
// read_only grants and write through the acting db with the brokerage predicate
// pinned; zero rows changed is a refusal, not success.
import { resolveActingContext, resolveWriteContext } from "@/lib/platform/acting-context"

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

export async function getListingTaskTemplates(): Promise<ListingTaskTemplate[]> {
  const ctx = await resolveActingContext()
  // Braced so the honesty guard's literal scan cannot cross into the next
  // check's message — the relay throws the seam's own error, not a fixed noun.
  if (!ctx.ok) { throw new Error(ctx.error) }
  if (!ctx.brokerageId) throw new Error("No brokerage found")
  const supabase = ctx.db
  const brokerageId = ctx.brokerageId

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
  // ACT-AS WRITE SEAM — read_only refused before the write.
  const ctx = await resolveWriteContext()
  if (!ctx.ok) return { success: false, error: ctx.error }
  if (!ctx.brokerageId) return { success: false, error: "No brokerage found" }
  const supabase = ctx.db
  const brokerageId = ctx.brokerageId

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
  // ACT-AS WRITE SEAM — read_only refused before the write.
  const ctx = await resolveWriteContext()
  if (!ctx.ok) return { success: false, error: ctx.error }
  if (!ctx.brokerageId) return { success: false, error: "No brokerage found" }
  const supabase = ctx.db
  const brokerageId = ctx.brokerageId

  // Zero rows updated is a refusal (wrong id / other tenant), not success —
  // supabase-js resolves an RLS refusal as zero rows with error:null.
  const { data: updated, error } = await supabase
    .from("listing_task_templates")
    .update({ ...params, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("brokerage_id", brokerageId)
    .select("id")

  if (error) return { success: false, error: error.message }
  if (!updated || updated.length === 0) {
    return { success: false, error: "Template not found in your brokerage" }
  }
  revalidatePath("/dashboard/settings/listing-task-templates")
  return { success: true }
}

export async function deleteListingTaskTemplate(id: string): Promise<{ success: boolean; error?: string }> {
  // ACT-AS WRITE SEAM — read_only refused before the delete.
  const ctx = await resolveWriteContext()
  if (!ctx.ok) return { success: false, error: ctx.error }
  if (!ctx.brokerageId) return { success: false, error: "No brokerage found" }
  const supabase = ctx.db
  const brokerageId = ctx.brokerageId

  // Zero rows deleted is a refusal, not success.
  const { data: deleted, error } = await supabase
    .from("listing_task_templates")
    .delete()
    .eq("id", id)
    .eq("brokerage_id", brokerageId)
    .select("id")

  if (error) return { success: false, error: error.message }
  if (!deleted || deleted.length === 0) {
    return { success: false, error: "Template not found in your brokerage" }
  }
  revalidatePath("/dashboard/settings/listing-task-templates")
  return { success: true }
}
