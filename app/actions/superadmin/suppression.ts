"use server"

/**
 * Superadmin suppression-list management.
 *
 * The platform_suppression_list is the CROSS-TENANT do-not-contact wall:
 * once a phone/email lands here, no subscriber may touch it via any channel
 * (engine-1 distribution, email, SMS, voice, direct mail all consult it).
 * Automated writers already exist (ISA opt-out detection, TCPA flags, spam
 * complaints) — this is the HUMAN half of the loop: platform staff answering
 * a consumer's "stop contacting me" request or clearing a mistaken entry.
 *
 * Gates: list/add require the 'sentinel' platform capability (superadmin +
 * admin — compliance operators). REMOVE is superadmin-only: taking someone
 * OFF the do-not-contact wall re-exposes them to every tenant's outreach,
 * which is the destructive direction. Every add/remove is audit-logged.
 *
 * Actions:
 *   listSuppressionAction(search?)
 *   addSuppressionEntryAction({phone?, email?, notes?})
 *   removeSuppressionEntryAction({id, reason})
 */

import { createServiceClient } from "@/lib/supabase/service"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { addToSuppressionList } from "@/lib/platform/suppression-list"
import { revalidatePath } from "next/cache"
import { headers } from "next/headers"

export interface SuppressionRow {
  id: string
  phone_digits: string | null
  email: string | null
  reason: string
  source_brokerage_id: string | null
  added_by_user_id: string | null
  notes: string | null
  created_at: string | null
}

/** Audit write, same shape as brokerage-management's private helper — the
 *  helper stays un-exported there ("use server" exports become client-callable
 *  actions, and a forgeable audit writer would defeat the ledger). */
async function writeSuppressionAudit(params: {
  actorUserId: string
  action: string
  targetId?: string
  details: Record<string, unknown>
}): Promise<void> {
  try {
    const svc = createServiceClient()
    const hdrs = await headers()
    const { data: actor } = await svc.from("users").select("email").eq("id", params.actorUserId).maybeSingle()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: params.actorUserId,
      actor_email: actor?.email ?? null,
      action: params.action,
      target_type: "suppression_entry",
      target_id: params.targetId ?? null,
      details: params.details,
      ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"),
      user_agent: hdrs.get("user-agent"),
    })
  } catch (err) {
    console.error("[suppression-audit] write failed:", err)
  }
}

export async function listSuppressionAction(search?: string): Promise<
  { ok: true; rows: SuppressionRow[]; total: number } | { ok: false; error: string }
> {
  const gate = await requirePlatformCapability("sentinel")
  if (!gate.ok) return { ok: false, error: gate.error ?? "Forbidden" }

  const svc = createServiceClient()
  let q = svc
    .from("platform_suppression_list")
    .select("id, phone_digits, email, reason, source_brokerage_id, added_by_user_id, notes, created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .limit(200)
  const term = search?.trim()
  if (term) {
    const digits = term.replace(/\D/g, "")
    q = digits.length >= 4
      ? q.or(`phone_digits.ilike.%${digits}%,email.ilike.%${term.toLowerCase()}%`)
      : q.ilike("email", `%${term.toLowerCase()}%`)
  }
  const { data, error, count } = await q
  if (error) return { ok: false, error: error.message }
  return { ok: true, rows: (data ?? []) as SuppressionRow[], total: count ?? data?.length ?? 0 }
}

export async function addSuppressionEntryAction(params: {
  phone?: string | null
  email?: string | null
  notes?: string | null
}): Promise<{ ok: boolean; error?: string }> {
  const gate = await requirePlatformCapability("sentinel")
  if (!gate.ok || !gate.userId) return { ok: false, error: gate.error ?? "Forbidden" }
  if (!params.phone?.trim() && !params.email?.trim()) {
    return { ok: false, error: "Provide a phone or an email to suppress" }
  }

  const res = await addToSuppressionList({
    phone: params.phone ?? null,
    email: params.email ?? null,
    reason: "manual_admin",
    addedByUserId: gate.userId,
    notes: params.notes?.trim() || null,
  })
  if (!res.added) return { ok: false, error: `Nothing added (${res.reason})` }

  await writeSuppressionAudit({
    actorUserId: gate.userId,
    action: "suppression.entry_added",
    details: {
      phone_last4: params.phone ? params.phone.replace(/\D/g, "").slice(-4) : null,
      email_domain: params.email?.includes("@") ? params.email.trim().toLowerCase().split("@")[1] : null,
      notes: params.notes?.trim() || null,
    },
  })
  revalidatePath("/dashboard/superadmin/suppression")
  return { ok: true }
}

export async function removeSuppressionEntryAction(params: {
  id: string
  reason: string
}): Promise<{ ok: boolean; error?: string }> {
  // Removal re-exposes the person to every tenant's outreach — superadmin only.
  const gate = await requirePlatformCapability("sentinel")
  if (!gate.ok || !gate.userId) return { ok: false, error: gate.error ?? "Forbidden" }
  if (gate.role !== "superadmin") return { ok: false, error: "Removing suppression entries requires superadmin" }
  if (!params.reason?.trim() || params.reason.trim().length < 5) {
    return { ok: false, error: "A reason (5+ chars) is required to remove an entry" }
  }

  const svc = createServiceClient()
  const { data: row } = await svc
    .from("platform_suppression_list")
    .select("id, phone_digits, email, reason")
    .eq("id", params.id)
    .maybeSingle()
  if (!row) return { ok: false, error: "Entry not found" }

  const { error } = await svc.from("platform_suppression_list").delete().eq("id", params.id)
  if (error) return { ok: false, error: error.message }

  await writeSuppressionAudit({
    actorUserId: gate.userId,
    action: "suppression.entry_removed",
    targetId: params.id,
    details: {
      removal_reason: params.reason.trim(),
      phone_last4: row.phone_digits ? String(row.phone_digits).slice(-4) : null,
      email_domain: row.email?.includes("@") ? String(row.email).split("@")[1] : null,
      original_reason: row.reason,
    },
  })
  revalidatePath("/dashboard/superadmin/suppression")
  return { ok: true }
}
