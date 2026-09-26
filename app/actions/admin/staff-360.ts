"use server"

/**
 * Staff 360 — the manager's full view of a NON-AGENT staff user (TC, ISA,
 * Compliance Officer, Admin, Broker). The agent card got its 360 first; this
 * is the same treatment for every other user type, so "user management" is a
 * complete operating view of each person rather than a role dropdown.
 *
 * Keep-one: every panel reads rails that already exist —
 *   TC        → transaction_coordinators + transaction_tasks (assigned_user_id,
 *               completed_by) — the coordinator's real queue: open, overdue,
 *               completed, and how many files they carry.
 *   Review    → approval_items (reviewed_by) for compliance_officer/admin/
 *               broker — throughput plus the brokerage queue they're on the
 *               hook for.
 *   Everyone  → activities (agent_user_id) — the universal work log the rest
 *               of the OS already writes.
 *   Academy   → learning_assignments' STAFF lane (staff_user_id — the live
 *               la_one_target_only CHECK gives staff their own target column),
 *               so managers assign classes to staff exactly like agents.
 *
 * Authorization mirrors agent-360.ts: broker / broker_admin / admin /
 * superadmin / team_lead, target scoped to the caller's brokerage.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

/** Roles whose queue is the approval/review desk. */
const REVIEW_ROLES = new Set(["compliance_officer", "compliance_manager", "admin", "broker", "broker_admin"])

export interface Staff360 {
  role: string
  workloadKind: "tc" | "review" | "general"
  tc: { tasksOpen: number; tasksOverdue: number; tasksCompleted30d: number; filesCarried: number } | null
  review: { itemsReviewed: number; queuePending: number } | null
  recentActivity: Array<{ title: string; type: string | null; createdAt: string }>
  academy: {
    assignments: Array<{ moduleId: string; title: string; status: string }>
    availableModules: Array<{ id: string; title: string }>
  }
  memberSince: string | null
}

export async function getStaff360Action(
  targetUserId: string,
): Promise<{ ok: true; data: Staff360 | null } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data: caller } = await supabase
    .from("users").select("user_type, role, brokerage_id").eq("id", user.id).maybeSingle()
  const callerRole = (caller?.user_type ?? caller?.role ?? "") as string
  if (!isAdminOrBroker({ user_type: callerRole })) return { ok: false, error: "Forbidden" }
  if (!caller?.brokerage_id) return { ok: false, error: "No brokerage on your profile" }
  const brokerageId = caller.brokerage_id as string

  const svc = createServiceClient()
  const { data: target } = await svc
    .from("users")
    .select("user_type, role, brokerage_id, created_at")
    .eq("id", targetUserId)
    .maybeSingle()
  if (!target || target.brokerage_id !== brokerageId) return { ok: true, data: null }

  const role = (target.user_type ?? target.role ?? "") as string
  const isTc = role === "tc"
  const workloadKind: Staff360["workloadKind"] = isTc ? "tc" : REVIEW_ROLES.has(role) ? "review" : "general"

  const nowIso = new Date().toISOString()
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString()

  const [openRes, overdueRes, doneRes, filesRes, reviewedRes, queueRes, activityRes, assignRes, modulesRes] =
    await Promise.all([
      isTc
        ? svc.from("transaction_tasks").select("id", { count: "exact", head: true })
            .eq("brokerage_id", brokerageId).eq("assigned_user_id", targetUserId).neq("status", "completed")
        : Promise.resolve({ count: 0 } as any),
      isTc
        ? svc.from("transaction_tasks").select("id", { count: "exact", head: true })
            .eq("brokerage_id", brokerageId).eq("assigned_user_id", targetUserId)
            .neq("status", "completed").lt("due_date", nowIso)
        : Promise.resolve({ count: 0 } as any),
      isTc
        ? svc.from("transaction_tasks").select("id", { count: "exact", head: true })
            .eq("brokerage_id", brokerageId).eq("completed_by", targetUserId)
            .gte("completed_at", thirtyDaysAgo)
        : Promise.resolve({ count: 0 } as any),
      isTc
        ? svc.from("transaction_tasks").select("transaction_id")
            .eq("brokerage_id", brokerageId).eq("assigned_user_id", targetUserId)
            .neq("status", "completed").limit(500)
        : Promise.resolve({ data: [] } as any),
      workloadKind === "review"
        ? svc.from("approval_items").select("id", { count: "exact", head: true })
            .eq("brokerage_id", brokerageId).eq("reviewed_by", targetUserId)
        : Promise.resolve({ count: 0 } as any),
      workloadKind === "review"
        ? svc.from("approval_items").select("id", { count: "exact", head: true })
            .eq("brokerage_id", brokerageId).eq("status", "pending")
        : Promise.resolve({ count: 0 } as any),
      svc.from("activities")
        .select("title, activity_type, created_at")
        .eq("brokerage_id", brokerageId).eq("agent_user_id", targetUserId)
        .order("created_at", { ascending: false }).limit(8),
      svc.from("learning_assignments")
        .select("module_id, status, learning_modules ( title )")
        .eq("staff_user_id", targetUserId).eq("brokerage_id", brokerageId).limit(50),
      svc.from("learning_modules")
        .select("id, title").eq("brokerage_id", brokerageId).eq("status", "published")
        .order("title").limit(100),
    ])

  const filesCarried = new Set(
    ((filesRes as any).data ?? []).map((t: any) => t.transaction_id).filter(Boolean),
  ).size

  return {
    ok: true,
    data: {
      role,
      workloadKind,
      tc: isTc
        ? {
            tasksOpen: (openRes as any).count ?? 0,
            tasksOverdue: (overdueRes as any).count ?? 0,
            tasksCompleted30d: (doneRes as any).count ?? 0,
            filesCarried,
          }
        : null,
      review: workloadKind === "review"
        ? { itemsReviewed: (reviewedRes as any).count ?? 0, queuePending: (queueRes as any).count ?? 0 }
        : null,
      recentActivity: ((activityRes as any).data ?? []).map((a: any) => ({
        title: a.title ?? a.activity_type ?? "Activity",
        type: a.activity_type ?? null,
        createdAt: a.created_at,
      })),
      academy: {
        assignments: ((assignRes as any).data ?? []).map((a: any) => {
          const mod = Array.isArray(a.learning_modules) ? a.learning_modules[0] : a.learning_modules
          return { moduleId: a.module_id as string, title: mod?.title ?? "Module", status: a.status ?? "open" }
        }),
        availableModules: ((modulesRes as any).data ?? []).map((m: any) => ({ id: m.id as string, title: m.title as string })),
      },
      memberSince: (target.created_at as string) ?? null,
    },
  }
}

/**
 * Assign a published academy module to a STAFF user (the staff_user_id lane —
 * the live la_one_target_only CHECK requires exactly one target column, so
 * staff assignments must NOT set agent_user_id).
 */
export async function assignAcademyModuleToStaffAction(
  input: { targetUserId: string; moduleId: string },
): Promise<{ ok: boolean; error?: string; duplicate?: boolean }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data: caller } = await supabase
    .from("users").select("user_type, role, brokerage_id").eq("id", user.id).maybeSingle()
  const callerRole = (caller?.user_type ?? caller?.role ?? "") as string
  if (!isAdminOrBroker({ user_type: callerRole })) return { ok: false, error: "Forbidden" }
  if (!caller?.brokerage_id) return { ok: false, error: "No brokerage on your profile" }

  const svc = createServiceClient()

  // CROSS-TENANT GUARD: the TARGET must belong to the caller's brokerage.
  // Verifying only the module let a manager write a learning_assignments row
  // for a user in another tenant (VADE security finding).
  const { data: targetUser } = await svc
    .from("users").select("id, brokerage_id").eq("id", input.targetUserId).maybeSingle()
  if (!targetUser || targetUser.brokerage_id !== caller.brokerage_id) {
    return { ok: false, error: "User not found in your brokerage" }
  }

  const { data: mod } = await svc
    .from("learning_modules").select("id, brokerage_id, status").eq("id", input.moduleId).maybeSingle()
  if (!mod || mod.brokerage_id !== caller.brokerage_id) return { ok: false, error: "Module not found in your academy" }
  if (mod.status !== "published") return { ok: false, error: "Module isn't published yet" }

  const { data: existing } = await svc
    .from("learning_assignments").select("id")
    .eq("staff_user_id", input.targetUserId).eq("module_id", input.moduleId).maybeSingle()
  if (existing) return { ok: true, duplicate: true }

  const { error } = await svc.from("learning_assignments").insert({
    brokerage_id: caller.brokerage_id,
    module_id: input.moduleId,
    staff_user_id: input.targetUserId,
    signal_source: "manager_assigned",
    status: "open",
  })
  if (error) return { ok: false, error: error.message }
  revalidatePath(`/dashboard/admin/users/${input.targetUserId}`)
  return { ok: true }
}
