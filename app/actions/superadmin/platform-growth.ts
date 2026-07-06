"use server"

// app/actions/superadmin/platform-growth.ts
// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM SELF-MARKETING — capture + work prospects for VIP Agents itself. Public
// capture (anyone can raise their hand for the product); the funnel + advance +
// pitch-draft are gated to platform MARKETING staff (or superadmin) via the
// capability map. Every staff write is audited.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { headers } from "next/headers"
import { revalidatePath } from "next/cache"
import { validateProspectInput, rollupGrowthFunnel, composeProspectOutreach, PROSPECT_STATUSES } from "@/lib/platform/growth-funnel"
import { platformStaffCan } from "@/lib/platform/platform-staff-roster"

// ── PUBLIC: capture a prospect (no auth — a "get started / notify me" hand-raise) ──
export async function capturePlatformProspectAction(input: {
  name?: string; email: string; company?: string; roleInterest?: string; source?: string; interestNote?: string
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const v = validateProspectInput(input)
  if (!v.ok) return { ok: false, error: v.error }
  const svc = createServiceClient()
  // Idempotent by email — a repeat hand-raise updates, never duplicates.
  const { data, error } = await svc.from("platform_prospects").upsert({
    name: v.value.name, email: v.value.email, company: v.value.company,
    role_interest: v.value.roleInterest, source: v.value.source, interest_note: v.value.interestNote,
    updated_at: new Date().toISOString(),
  }, { onConflict: "email" }).select("id").single()
  if (error) return { ok: false, error: error.message }
  return { ok: true, id: (data as any).id }
}

// ── Gated: platform marketing staff (or superadmin) ───────────────────────────
async function requireMarketingStaff(): Promise<{ ok: true; userId: string; email: string; role: string } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data } = await supabase.from("users").select("user_type, platform_role, email").eq("id", user.id).maybeSingle()
  const role = (data as any)?.platform_role ?? ((data as any)?.user_type === "superadmin" ? "superadmin" : null)
  if (!platformStaffCan(role, "marketing")) return { ok: false, error: "Forbidden — platform marketing access required" }
  return { ok: true, userId: user.id, email: (data as any)?.email ?? user.email ?? "", role }
}

async function audit(actorUserId: string, actorEmail: string, action: string, targetId: string, details: Record<string, unknown>) {
  try {
    const svc = createServiceClient(); const hdrs = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: actorUserId, actor_email: actorEmail, action, target_type: "platform_prospect", target_id: targetId,
      details, ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"), user_agent: hdrs.get("user-agent"),
    })
  } catch (err) { console.error("[platform-growth audit] failed:", err) }
}

export async function listPlatformProspectsAction(): Promise<{ ok: true; prospects: any[]; funnel: ReturnType<typeof rollupGrowthFunnel> } | { ok: false; error: string }> {
  const auth = await requireMarketingStaff()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data, error } = await svc.from("platform_prospects")
    .select("id, name, email, company, role_interest, source, status, interest_note, contacted_at, created_at")
    .order("created_at", { ascending: false }).limit(500)
  if (error) return { ok: false, error: error.message }
  return { ok: true, prospects: data ?? [], funnel: rollupGrowthFunnel(data ?? []) }
}

export async function advanceProspectAction(input: { id: string; status: string }): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireMarketingStaff()
  if (!auth.ok) return auth
  if (!(PROSPECT_STATUSES as readonly string[]).includes(input.status)) return { ok: false, error: "Invalid status" }
  const svc = createServiceClient()
  const patch: Record<string, unknown> = { status: input.status, updated_at: new Date().toISOString() }
  if (input.status === "contacted") patch.contacted_at = new Date().toISOString()
  const { error } = await svc.from("platform_prospects").update(patch).eq("id", input.id)
  if (error) return { ok: false, error: error.message }
  await audit(auth.userId, auth.email, "platform_prospect.advanced", input.id, { status: input.status })
  revalidatePath("/dashboard/superadmin/growth")
  return { ok: true }
}

/** Draft the platform's own outreach pitch for a prospect — GATED, never auto-sent. */
export async function draftProspectOutreachAction(id: string): Promise<{ ok: true; subject: string; body: string } | { ok: false; error: string }> {
  const auth = await requireMarketingStaff()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { data: p } = await svc.from("platform_prospects").select("name, role_interest, company").eq("id", id).maybeSingle()
  if (!p) return { ok: false, error: "Prospect not found" }
  const draft = composeProspectOutreach({ name: (p as any).name, roleInterest: (p as any).role_interest, company: (p as any).company })
  return { ok: true, ...draft }
}
