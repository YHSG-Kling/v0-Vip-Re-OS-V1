"use server"

/**
 * app/actions/admin/onboarding-steps.ts
 *
 * ONBOARDING CURRICULUM AUTHORING — the gap: the canonical onboarding system
 * (agent_onboarding + onboarding_steps + agent_step_completions) is fully live and
 * auto-starts on invite, but nothing in the app could AUTHOR steps — every agent
 * inherited the one global (brokerage_id NULL) template seeded by SQL. These
 * actions let a brokerage admin add/edit/remove BROKERAGE-scoped steps that the
 * onboarding loader already reads (lib/kernel/onboarding.ts: brokerage_id.eq.<id>
 * OR is null, filtered by target_role). No schema change — the table already has
 * brokerage_id + target_role[].
 *
 * Admin-gated (broker / broker_admin / admin / superadmin). Platform-default steps
 * (brokerage_id NULL) are READ-ONLY here — a tenant can only manage its own rows.
 * recruiting_manager owns the onboarding journey.
 */

import { revalidatePath } from "next/cache"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity"

const ADMIN_ROLES = new Set(["broker", "broker_admin", "admin", "superadmin"])
const CATEGORIES = new Set(["license", "compliance", "tech", "training", "practice", "brand", "other"])

async function requireAdmin(): Promise<
  | { ok: true; brokerageId: string; userId: string }
  | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }
  if (!ADMIN_ROLES.has(ctx.userType)) return { ok: false, error: "Forbidden" }
  return { ok: true, brokerageId: ctx.brokerageId, userId: ctx.userId }
}

export interface CurriculumStep {
  id: string
  dayNumber: number
  stepOrder: number
  stepKey: string
  stepName: string
  category: string
  required: boolean
  estimatedMinutes: number | null
  instructions: string | null
  videoUrl: string | null
  targetRole: string[] | null
  /** true for platform defaults (brokerage_id NULL) — read-only to a tenant. */
  isPlatformDefault: boolean
}

function rowToStep(r: Record<string, unknown>, callerBrokerageId: string): CurriculumStep {
  return {
    id: r.id as string,
    dayNumber: (r.day_number as number) ?? 1,
    stepOrder: (r.step_order as number) ?? 0,
    stepKey: r.step_key as string,
    stepName: r.step_name as string,
    category: (r.category as string) ?? "other",
    required: (r.required as boolean) ?? true,
    estimatedMinutes: (r.estimated_minutes as number | null) ?? null,
    instructions: (r.instructions as string | null) ?? null,
    videoUrl: (r.video_url as string | null) ?? null,
    targetRole: (r.target_role as string[] | null) ?? null,
    isPlatformDefault: (r.brokerage_id as string | null) !== callerBrokerageId,
  }
}

/** List the effective curriculum: the brokerage's own steps + the platform
 *  defaults (read-only), ordered as the agent sees them. */
export async function listOnboardingCurriculumAction(): Promise<
  { ok: true; steps: CurriculumStep[] } | { ok: false; error: string }
> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("onboarding_steps")
    .select("id, brokerage_id, day_number, step_order, step_key, step_name, category, required, estimated_minutes, instructions, video_url, target_role")
    .or(`brokerage_id.eq.${auth.brokerageId},brokerage_id.is.null`)
    .order("day_number", { ascending: true })
    .order("step_order", { ascending: true })
  if (error) return { ok: false, error: error.message }
  return { ok: true, steps: (data ?? []).map((r) => rowToStep(r as Record<string, unknown>, auth.brokerageId)) }
}

export interface SaveStepInput {
  /** Present → update that brokerage step; absent → create. */
  id?: string | null
  dayNumber: number
  stepOrder: number
  stepKey: string
  stepName: string
  category: string
  required?: boolean
  estimatedMinutes?: number | null
  instructions?: string | null
  videoUrl?: string | null
  targetRole?: string[] | null
}

export async function saveOnboardingStepAction(
  input: SaveStepInput,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth

  const stepName = (input.stepName ?? "").trim()
  if (!stepName) return { ok: false, error: "Step name is required" }
  const stepKey = (input.stepKey ?? "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "")
  if (!stepKey) return { ok: false, error: "Step key is required" }
  if (!CATEGORIES.has(input.category)) return { ok: false, error: `Category must be one of: ${[...CATEGORIES].join(", ")}` }
  const dayNumber = Number.isFinite(input.dayNumber) && input.dayNumber >= 1 ? Math.floor(input.dayNumber) : 1
  const stepOrder = Number.isFinite(input.stepOrder) ? Math.floor(input.stepOrder) : 0
  const targetRole = Array.isArray(input.targetRole) && input.targetRole.length > 0
    ? input.targetRole.map((r) => String(r).toLowerCase())
    : null

  const svc = createServiceClient()

  const payload = {
    // brokerage_id is ALWAYS the caller's own tenant — a tenant can never author a
    // platform-default (NULL) step or a step for another brokerage.
    brokerage_id: auth.brokerageId,
    day_number: dayNumber,
    step_order: stepOrder,
    step_key: stepKey,
    step_name: stepName,
    category: input.category,
    required: input.required ?? true,
    estimated_minutes: input.estimatedMinutes ?? null,
    instructions: input.instructions?.trim() || null,
    video_url: input.videoUrl?.trim() || null,
    target_role: targetRole,
  }

  if (input.id) {
    // Only the tenant's OWN step is editable (never a platform default).
    const { data: existing } = await svc.from("onboarding_steps").select("brokerage_id").eq("id", input.id).maybeSingle()
    if (!existing || (existing as { brokerage_id: string | null }).brokerage_id !== auth.brokerageId) {
      return { ok: false, error: "Step not found for this brokerage" }
    }
    const { error } = await svc.from("onboarding_steps").update(payload).eq("id", input.id)
    if (error) return { ok: false, error: error.message }
    revalidatePath("/dashboard/admin/onboarding")
    return { ok: true, id: input.id }
  }

  const { data, error } = await svc.from("onboarding_steps").insert(payload).select("id").single()
  if (error) return { ok: false, error: error.message }
  revalidatePath("/dashboard/admin/onboarding")
  return { ok: true, id: (data as { id: string }).id }
}

export async function deleteOnboardingStepAction(
  stepId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await requireAdmin()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  // Refuse to delete anything but the tenant's own step (platform defaults are shared).
  const { data: existing } = await svc.from("onboarding_steps").select("brokerage_id").eq("id", stepId).maybeSingle()
  if (!existing || (existing as { brokerage_id: string | null }).brokerage_id !== auth.brokerageId) {
    return { ok: false, error: "Step not found for this brokerage" }
  }
  const { error } = await svc.from("onboarding_steps").delete().eq("id", stepId)
  if (error) return { ok: false, error: error.message }
  revalidatePath("/dashboard/admin/onboarding")
  return { ok: true }
}
