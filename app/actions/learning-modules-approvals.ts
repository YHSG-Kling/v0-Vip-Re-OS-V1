"use server"

/**
 * Admin approval surface for AI-generated learning_modules.
 *
 * Post-migration 1049, generateAIEducation writes status='pending_review'.
 * These actions let an admin (broker / broker_admin / admin / superadmin /
 * team_lead) approve → published OR reject with a reason.
 *
 * Audit trail: approved_by / approved_at OR rejected_by / rejected_at +
 * rejection_reason populated on the row.
 */

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

const ADMIN_ROLES = new Set(["broker", "broker_admin", "admin", "superadmin", "team_lead"])

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
  const userType = row.user_type as string
  if (!ADMIN_ROLES.has(userType)) return { ok: false, error: "Forbidden" }
  return { ok: true, userId: user.id, brokerageId: row.brokerage_id as string, userType }
}

export interface PendingModuleRow {
  id:                string
  title:             string
  summary:           string | null
  body:              string | null
  channels:          string[]
  is_ai_generated:   boolean
  audience_roles:    string[]
  audience_personas: string[]
  stage_tags:        string[]
  milestone_key:     string | null
  created_at:        string
}

export async function listPendingApprovalModulesAction(): Promise<
  | { ok: true; rows: PendingModuleRow[] }
  | { ok: false; error: string }
> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth

  const svc = createServiceClient()
  const { data, error } = await svc
    .from("learning_modules")
    .select("id, title, summary, body, channels, is_ai_generated, audience_roles, audience_personas, stage_tags, milestone_key, created_at")
    .eq("brokerage_id", auth.brokerageId)
    .eq("status", "pending_review")
    .order("created_at", { ascending: false })
    .limit(100)
  if (error) return { ok: false, error: error.message }

  const rows = ((data ?? []) as Array<Record<string, unknown>>).map(r => ({
    id:                r.id as string,
    title:             r.title as string,
    summary:           (r.summary as string | null) ?? null,
    body:              (r.body as string | null) ?? null,
    channels:          (r.channels as string[] | null) ?? [],
    is_ai_generated:   !!r.is_ai_generated,
    audience_roles:    (r.audience_roles as string[] | null) ?? [],
    audience_personas: (r.audience_personas as string[] | null) ?? [],
    stage_tags:        (r.stage_tags as string[] | null) ?? [],
    milestone_key:     (r.milestone_key as string | null) ?? null,
    created_at:        r.created_at as string,
  }))
  return { ok: true, rows }
}

export async function approveLearningModuleAction(
  moduleId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth

  const svc = createServiceClient()
  const { data: m } = await svc
    .from("learning_modules")
    .select("brokerage_id, status")
    .eq("id", moduleId)
    .maybeSingle()
  if (!m) return { ok: false, error: "Module not found" }
  if (m.brokerage_id !== auth.brokerageId) return { ok: false, error: "Forbidden" }
  if (m.status !== "pending_review") {
    return { ok: false, error: `Cannot approve from status '${m.status}'` }
  }

  const now = new Date().toISOString()
  const { error } = await svc
    .from("learning_modules")
    .update({
      status:       "published",
      approved_by:  auth.userId,
      approved_at:  now,
      published_at: now,
      updated_at:   now,
    })
    .eq("id", moduleId)
  if (error) return { ok: false, error: error.message }

  revalidatePath("/dashboard/admin/learning-modules/approvals")
  return { ok: true }
}

export async function rejectLearningModuleAction(
  moduleId: string,
  reason:   string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth
  if (!reason || reason.trim().length < 5) {
    return { ok: false, error: "Rejection reason is required" }
  }

  const svc = createServiceClient()
  const { data: m } = await svc
    .from("learning_modules")
    .select("brokerage_id, status")
    .eq("id", moduleId)
    .maybeSingle()
  if (!m) return { ok: false, error: "Module not found" }
  if (m.brokerage_id !== auth.brokerageId) return { ok: false, error: "Forbidden" }
  if (m.status !== "pending_review") {
    return { ok: false, error: `Cannot reject from status '${m.status}'` }
  }

  const now = new Date().toISOString()
  const { error } = await svc
    .from("learning_modules")
    .update({
      status:           "rejected",
      rejected_by:      auth.userId,
      rejected_at:      now,
      rejection_reason: reason.trim(),
      updated_at:       now,
    })
    .eq("id", moduleId)
  if (error) return { ok: false, error: error.message }

  revalidatePath("/dashboard/admin/learning-modules/approvals")
  return { ok: true }
}
