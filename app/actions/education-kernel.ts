'use server'

// app/actions/education-kernel.ts
//
// Server Action entry points for the client-education (CONTACT) rail of the
// Education kernel. Agent/staff training is a different rail with a different
// target column and different writers (app/actions/academy-learning.ts,
// app/actions/admin/agent-360.ts) — this file only ever writes
// learning_assignments rows whose target is a CONTACT.
//
// TWO THINGS VERIFIED AGAINST THE LIVE DATABASE, BOTH OF WHICH MADE EVERY WRITE
// IN THIS FILE IMPOSSIBLE BEFORE IT WAS EVER CALLED:
//
//   1. learning_assignments has RLS ENABLED and ZERO insert-capable policies.
//      Its only policies are la_agent_self (SELECT) and la_self_update (UPDATE).
//      Every write here passed the request-scoped, RLS-bound client into the
//      kernel, so an INSERT or UPSERT could only ever be refused. That is why
//      every OTHER writer of this table in the codebase — academy-learning.ts,
//      admin/agent-360.ts, admin/staff-360.ts, lib/portal/static-lesson-bridge.ts,
//      lib/agents/education-delivery-producer.ts — uses the service client. The
//      writes below now do the same, which means RLS is no longer doing ANY of
//      the tenant work and the tenancy checks in this file ARE the boundary.
//      They are therefore explicit, and they run before the write.
//
//   2. Every action took `brokerageId` FROM THE CALLER. A "use server" action
//      that accepts its own tenant as an argument has no tenant boundary: any
//      signed-in user could assign another brokerage's module to another
//      brokerage's contact. The tenant is resolved from the SESSION now and the
//      parameter is gone.
//
// Also enforced here because the kernel cannot see it: learning_assignments
// carries la_one_target_only — exactly one of agent_user_id / staff_user_id /
// contact_id may be set — and uq_la_contact_module makes (contact_id, module_id)
// unique, which is what makes assignment idempotent rather than duplicating.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { revalidatePath } from "next/cache"
import {
  createEducationalResource,
  assignResource,
  recordCompletion,
  bulkAssignResources,
  getResourceUsageAnalytics,
} from "@/lib/kernel/education"

// ─── INTERNAL: actor + tenant, always from the session ───────────────────────

type Actor = { ok: true; userId: string; brokerageId: string } | { ok: false; error: string }

async function resolveActor(): Promise<Actor> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Not authenticated" }
  if (!ctx.brokerageId) return { ok: false, error: "Your account is not linked to a brokerage yet." }
  return { ok: true, userId: ctx.userId, brokerageId: ctx.brokerageId }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Confirm every named module and contact really belongs to this brokerage.
 * The service client bypasses RLS, so nothing else will do this for us.
 */
async function assertTenantOwnsAll(
  svc: ReturnType<typeof createServiceClient>,
  brokerageId: string,
  moduleIds: string[],
  contactIds: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (moduleIds.length > 0) {
    const { data, error } = await svc
      .from("learning_modules")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .in("id", moduleIds)
    if (error) return { ok: false, error: error.message }
    const found = new Set((data ?? []).map((r: { id: string }) => r.id))
    const missing = moduleIds.filter((id) => !found.has(id))
    if (missing.length > 0) {
      return { ok: false, error: `${missing.length} of those lessons are not in your brokerage.` }
    }
  }

  if (contactIds.length > 0) {
    const { data, error } = await svc
      .from("contacts")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .in("id", contactIds)
    if (error) return { ok: false, error: error.message }
    const found = new Set((data ?? []).map((r: { id: string }) => r.id))
    const missing = contactIds.filter((id) => !found.has(id))
    if (missing.length > 0) {
      return { ok: false, error: `${missing.length} of those clients are not in your brokerage.` }
    }
  }

  return { ok: true }
}

// ─── ACTION: createResourceAction ────────────────────────────────────────────
//
// Writes learning_modules, which DOES have an insert-capable policy
// (lm_admin_write, admin roles only) — so this one keeps the RLS-bound client
// and lets the database enforce the role. `brokerageId` is accepted for the
// existing caller's signature and IGNORED: the tenant comes from the session.

export async function createResourceAction(input: {
  title: string
  description: string
  contentType: string
  content: string
  estimatedMinutes: number
  /** @deprecated ignored — the tenant is resolved from the session. */
  brokerageId?: string
  /** True when the body was written by a model — lands at pending_review for
   *  admin approval instead of publishing (lib/kernel/education.ts). */
  isAiGenerated?: boolean
}) {
  const actor = await resolveActor()
  if (!actor.ok) throw new Error(actor.error)

  const supabase = await createClient()

  return createEducationalResource(supabase, {
    title: input.title,
    description: input.description,
    contentType: input.contentType as "video" | "article" | "interactive" | "assessment" | "podcast",
    content: input.content,
    estimatedMinutes: input.estimatedMinutes,
    createdBy: actor.userId,
    brokerageId: actor.brokerageId,
    isAiGenerated: !!input.isAiGenerated,
  })
}

// ─── ACTION: assignResourceAction ────────────────────────────────────────────
//
// Puts one lesson on one client's learning queue.
// UI: the Client Learning panel on /dashboard/education.

export async function assignResourceAction(input: {
  contactId: string
  resourceId: string
}): Promise<{ success: boolean; assignmentId?: string; error?: string }> {
  const actor = await resolveActor()
  if (!actor.ok) return { success: false, error: actor.error }

  if (!UUID_RE.test(input.contactId ?? "")) return { success: false, error: "Pick a client." }
  if (!UUID_RE.test(input.resourceId ?? "")) return { success: false, error: "Pick a lesson." }

  const svc = createServiceClient()
  const owns = await assertTenantOwnsAll(svc, actor.brokerageId, [input.resourceId], [input.contactId])
  if (!owns.ok) return { success: false, error: owns.error }

  try {
    const result = await assignResource(svc, {
      contactId: input.contactId,
      resourceId: input.resourceId,
      brokerageId: actor.brokerageId,
    })
    revalidatePath("/dashboard/education")
    return { success: true, assignmentId: result.assignmentId }
  } catch (err) {
    // uq_la_contact_module makes a repeat assignment a 23505 rather than a
    // second row. Say that plainly instead of surfacing the constraint name.
    const message = err instanceof Error ? err.message : "Could not assign that lesson."
    if (message.includes("uq_la_contact_module") || message.includes("duplicate key")) {
      return { success: false, error: "That client already has this lesson." }
    }
    console.error("[assignResourceAction]", err)
    return { success: false, error: message }
  }
}

// ─── ACTION: recordCompletionAction ──────────────────────────────────────────
//
// Marks a client's lesson complete and emits the education_completed lifecycle
// event. Upserts on (contact_id, module_id) so completing a lesson the client
// was never formally assigned still records it, rather than failing.

export async function recordCompletionAction(input: {
  contactId: string
  resourceId: string
  timeSpentMinutes: number
  retentionScore?: number
}): Promise<{ success: boolean; progressId?: string; error?: string }> {
  const actor = await resolveActor()
  if (!actor.ok) return { success: false, error: actor.error }

  if (!UUID_RE.test(input.contactId ?? "")) return { success: false, error: "Pick a client." }
  if (!UUID_RE.test(input.resourceId ?? "")) return { success: false, error: "Pick a lesson." }

  const minutes = Number(input.timeSpentMinutes ?? 0)
  if (!Number.isFinite(minutes) || minutes < 0) {
    return { success: false, error: "Time spent must be zero or more minutes." }
  }

  const svc = createServiceClient()
  const owns = await assertTenantOwnsAll(svc, actor.brokerageId, [input.resourceId], [input.contactId])
  if (!owns.ok) return { success: false, error: owns.error }

  try {
    const result = await recordCompletion(svc, {
      contactId: input.contactId,
      resourceId: input.resourceId,
      completedAt: new Date().toISOString(),
      timeSpentMinutes: minutes,
      retentionScore: input.retentionScore,
      brokerageId: actor.brokerageId,
    })
    revalidatePath("/dashboard/education")
    return { success: true, progressId: result.progressId }
  } catch (err) {
    console.error("[recordCompletionAction]", err)
    return { success: false, error: err instanceof Error ? err.message : "Could not record that completion." }
  }
}

// ─── ACTION: bulkAssignAction ────────────────────────────────────────────────
//
// Assigns several lessons to several clients at once.
//
// The kernel's bulkAssignResources upserts with ignoreDuplicates and then
// returns `assignedCount: assignments.length` — i.e. it reports every pair as
// newly assigned even when the upsert skipped them, and it discards the error
// object entirely. A broker re-running a bulk assign would be told "48 assigned"
// when nothing at all had changed. The TRUE count is measured here, by reading
// the assignment rows that exist before and after the write.

export async function bulkAssignAction(input: {
  resourceIds: string[]
  contactIds: string[]
}): Promise<{
  success: boolean
  requested: number
  newlyAssigned: number
  alreadyAssigned: number
  error?: string
}> {
  const zero = { requested: 0, newlyAssigned: 0, alreadyAssigned: 0 }

  const actor = await resolveActor()
  if (!actor.ok) return { success: false, ...zero, error: actor.error }

  const resourceIds = Array.from(new Set(input.resourceIds ?? [])).filter((id) => UUID_RE.test(id))
  const contactIds = Array.from(new Set(input.contactIds ?? [])).filter((id) => UUID_RE.test(id))
  if (resourceIds.length === 0) return { success: false, ...zero, error: "Pick at least one lesson." }
  if (contactIds.length === 0) return { success: false, ...zero, error: "Pick at least one client." }

  const requested = resourceIds.length * contactIds.length

  const svc = createServiceClient()
  const owns = await assertTenantOwnsAll(svc, actor.brokerageId, resourceIds, contactIds)
  if (!owns.ok) return { success: false, ...zero, requested, error: owns.error }

  const countExisting = async (): Promise<number | null> => {
    const { count, error } = await svc
      .from("learning_assignments")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", actor.brokerageId)
      .in("contact_id", contactIds)
      .in("module_id", resourceIds)
    if (error) {
      console.error("[bulkAssignAction] count failed:", error)
      return null
    }
    return count ?? 0
  }

  const before = await countExisting()

  const result = await bulkAssignResources(svc, {
    resourceIds,
    contactIds,
    brokerageId: actor.brokerageId,
  })
  if (!result.success) {
    return { success: false, ...zero, requested, error: "The database refused the bulk assignment." }
  }

  const after = await countExisting()
  if (before === null || after === null) {
    return {
      success: false,
      requested,
      newlyAssigned: 0,
      alreadyAssigned: 0,
      error: "The lessons were written but the result could not be verified — reload before assigning again.",
    }
  }

  const newlyAssigned = after - before
  revalidatePath("/dashboard/education")
  return {
    success: true,
    requested,
    newlyAssigned,
    alreadyAssigned: requested - newlyAssigned,
  }
}

// ─── ACTION: getAnalyticsAction ──────────────────────────────────────────────
//
// Per-lesson usage for one module.
//
// getResourceUsageAnalytics discards its `error` object and returns zeros, so a
// refused read is indistinguishable from a lesson nobody has touched. Module
// ownership is therefore established FIRST, with the error destructured, and a
// module that is not in this brokerage is refused rather than reported as a
// lesson with no activity.

export async function getAnalyticsAction(input: {
  resourceId: string
}): Promise<{
  success: boolean
  viewCount: number
  completionCount: number
  openCount: number
  error?: string
}> {
  const zero = { viewCount: 0, completionCount: 0, openCount: 0 }

  const actor = await resolveActor()
  if (!actor.ok) return { success: false, ...zero, error: actor.error }
  if (!UUID_RE.test(input.resourceId ?? "")) return { success: false, ...zero, error: "Pick a lesson." }

  const svc = createServiceClient()

  const { data: moduleRow, error: moduleErr } = await svc
    .from("learning_modules")
    .select("id")
    .eq("id", input.resourceId)
    .eq("brokerage_id", actor.brokerageId)
    .maybeSingle()
  if (moduleErr) {
    console.error("[getAnalyticsAction] module lookup failed:", moduleErr)
    return { success: false, ...zero, error: moduleErr.message }
  }
  if (!moduleRow) return { success: false, ...zero, error: "That lesson is not in your brokerage." }

  // The kernel gives viewCount / completionCount; the open count is the
  // difference a broker actually acts on, so it is derived here rather than
  // left for the surface to guess.
  const analytics = await getResourceUsageAnalytics(svc, {
    resourceId: input.resourceId,
    brokerageId: actor.brokerageId,
  })

  return {
    success: true,
    viewCount: analytics.viewCount,
    completionCount: analytics.completionCount,
    openCount: Math.max(analytics.viewCount - analytics.completionCount, 0),
  }
}
