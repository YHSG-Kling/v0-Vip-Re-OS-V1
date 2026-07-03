"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { scoreVendorApplication, canTransition, type VendorStatus } from "@/lib/kernel/vendor-verification"

async function requireAdmin(): Promise<{ userId: string; brokerageId: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")
  const svc = createServiceClient()
  const { data: profile } = await svc.from("users").select("brokerage_id, user_type, role").eq("id", user.id).maybeSingle()
  const brokerageId = (profile as any)?.brokerage_id
  const isAdmin = ["broker", "admin", "broker_admin", "superadmin"].includes(String((profile as any)?.user_type)) || ["broker", "admin", "owner"].includes(String((profile as any)?.role))
  if (!brokerageId || !isAdmin) throw new Error("Not authorized — vendor approval is broker/admin only")
  return { userId: user.id, brokerageId }
}

/**
 * Score a vendor's application (completeness + risk + duplicate) and stage it as PENDING approval.
 * Called when a vendor is created/invited. Never sets active — only an admin can (approveVendor).
 */
export async function submitVendorForVerification(vendorId: string): Promise<{ score: number; recommendation: string; status: "pending" }> {
  const { brokerageId } = await requireAdmin()
  const svc = createServiceClient()

  const { data: v } = await svc.from("vendors").select("id, name, category, email, phone, website, estimated_turnaround_days").eq("id", vendorId).eq("brokerage_id", brokerageId).maybeSingle()
  if (!v) throw new Error("Vendor not found in your brokerage")

  const { data: dupes } = await svc.from("vendors").select("id").eq("brokerage_id", brokerageId).eq("status", "active").ilike("name", (v as any).name ?? "").eq("category", (v as any).category ?? "").neq("id", vendorId).limit(1)
  const isDuplicate = (dupes ?? []).length > 0

  const result = scoreVendorApplication({
    name: (v as any).name, email: (v as any).email, phone: (v as any).phone, website: (v as any).website,
    category: (v as any).category, estimatedTurnaroundDays: (v as any).estimated_turnaround_days, isDuplicate,
  })
  await svc.from("vendors").update({ ai_verification_score: result.score, verification_flags: result.flags, status: "pending", updated_at: new Date().toISOString() }).eq("id", vendorId)
  return { score: result.score, recommendation: result.recommendation, status: "pending" }
}

async function transitionVendor(vendorId: string, to: VendorStatus, extra: Record<string, unknown> = {}): Promise<void> {
  const { userId, brokerageId } = await requireAdmin()
  const svc = createServiceClient()
  const { data: v } = await svc.from("vendors").select("id, status").eq("id", vendorId).eq("brokerage_id", brokerageId).maybeSingle()
  if (!v) throw new Error("Vendor not found in your brokerage")
  if (!canTransition(((v as any).status ?? null) as VendorStatus | null, to)) {
    throw new Error(`Cannot move vendor from ${(v as any).status ?? "active"} to ${to}`)
  }
  await svc.from("vendors").update({ status: to, verified_by: userId, verified_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...extra }).eq("id", vendorId)
}

/** Admin approves a vendor → active (surfaceable). No vendor can self-activate; this is the only path. */
export async function approveVendor(vendorId: string): Promise<{ ok: true }> {
  await transitionVendor(vendorId, "active")
  return { ok: true }
}

/** Admin rejects a vendor → inactive, with a reason recorded on the verification flags. */
export async function rejectVendor(vendorId: string, reason: string): Promise<{ ok: true }> {
  const svc = createServiceClient()
  const { data: v } = await svc.from("vendors").select("verification_flags").eq("id", vendorId).maybeSingle()
  const flags = Array.isArray((v as any)?.verification_flags) ? (v as any).verification_flags : []
  await transitionVendor(vendorId, "inactive", { verification_flags: [...flags, `rejected:${reason}`] })
  return { ok: true }
}

/**
 * Admin records/updates a vendor's compliance credential (license / insurance / …) with its expiry date,
 * stored on the vendor's compliance_credentials jsonb. The document-expiry monitor acts on these dates
 * (insurance lapse → suspend; license lapse → soft flag + grace).
 */
export async function setVendorComplianceCredential(
  vendorId: string,
  credentialType: "license" | "insurance" | "certification" | "bond",
  expiry: string,
  url?: string,
): Promise<{ ok: true }> {
  const { brokerageId } = await requireAdmin()
  const svc = createServiceClient()
  const { data: v } = await svc.from("vendors").select("compliance_credentials").eq("id", vendorId).eq("brokerage_id", brokerageId).maybeSingle()
  if (!v) throw new Error("Vendor not found in your brokerage")
  const bag = ((v as any).compliance_credentials && typeof (v as any).compliance_credentials === "object") ? (v as any).compliance_credentials : {}
  bag[credentialType] = { expiry, ...(url ? { url } : {}) }
  await svc.from("vendors").update({ compliance_credentials: bag, updated_at: new Date().toISOString() }).eq("id", vendorId)
  return { ok: true }
}

/** Admin asks the vendor for more info — keeps them pending, records the requested items on the flags. */
export async function requestVendorInfo(vendorId: string, items: string[]): Promise<{ ok: true }> {
  const { brokerageId } = await requireAdmin()
  const svc = createServiceClient()
  const { data: v } = await svc.from("vendors").select("verification_flags").eq("id", vendorId).eq("brokerage_id", brokerageId).maybeSingle()
  if (!v) throw new Error("Vendor not found in your brokerage")
  const flags = Array.isArray((v as any).verification_flags) ? (v as any).verification_flags : []
  await svc.from("vendors").update({ verification_flags: [...flags, ...items.map((i) => `info_requested:${i}`)], updated_at: new Date().toISOString() }).eq("id", vendorId)
  return { ok: true }
}
