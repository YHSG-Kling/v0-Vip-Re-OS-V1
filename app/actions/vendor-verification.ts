"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { scoreVendorApplication, canTransition, type VendorStatus } from "@/lib/kernel/vendor-verification"
import { readVendorInsurance, type InsuranceStatus } from "@/lib/kernel/vendor-doc-compliance"

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

  const { data: v, error: vErr } = await svc.from("vendors").select("id, name, category, email, phone, website, estimated_turnaround_days").eq("id", vendorId).eq("brokerage_id", brokerageId).maybeSingle()
  if (vErr) throw new Error(`Could not read the vendor: ${vErr.message}`)
  if (!v) throw new Error("Vendor not found in your brokerage")

  const { data: dupes } = await svc.from("vendors").select("id").eq("brokerage_id", brokerageId).eq("status", "active").ilike("name", (v as any).name ?? "").eq("category", (v as any).category ?? "").neq("id", vendorId).limit(1)
  const isDuplicate = (dupes ?? []).length > 0

  const result = scoreVendorApplication({
    name: (v as any).name, email: (v as any).email, phone: (v as any).phone, website: (v as any).website,
    category: (v as any).category, estimatedTurnaroundDays: (v as any).estimated_turnaround_days, isDuplicate,
  })
  const { error: scoreErr } = await svc.from("vendors").update({ ai_verification_score: result.score, verification_flags: result.flags, status: "pending", updated_at: new Date().toISOString() }).eq("id", vendorId)
  if (scoreErr) throw new Error(`Failed to stage the vendor for approval: ${scoreErr.message}`)
  return { score: result.score, recommendation: result.recommendation, status: "pending" }
}

async function transitionVendor(vendorId: string, to: VendorStatus, extra: Record<string, unknown> = {}): Promise<void> {
  const { userId, brokerageId } = await requireAdmin()
  const svc = createServiceClient()
  const { data: v, error: readErr } = await svc.from("vendors").select("id, status").eq("id", vendorId).eq("brokerage_id", brokerageId).maybeSingle()
  if (readErr) throw new Error(`Could not read the vendor: ${readErr.message}`)
  if (!v) throw new Error("Vendor not found in your brokerage")
  if (!canTransition(((v as any).status ?? null) as VendorStatus | null, to)) {
    throw new Error(`Cannot move vendor from ${(v as any).status ?? "active"} to ${to}`)
  }
  // vendors.status IS the broker approval gate — whether this vendor may be
  // booked or shown to a client at all. A lost write here leaves a rejected
  // vendor on the bench while the screen reports it removed.
  const { error: writeErr } = await svc.from("vendors").update({ status: to, verified_by: userId, verified_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...extra }).eq("id", vendorId)
  if (writeErr) throw new Error(`Failed to move the vendor to ${to}: ${writeErr.message}`)
}

/** Admin approves a vendor → active (surfaceable). No vendor can self-activate; this is the only path. */
export async function approveVendor(vendorId: string): Promise<{ ok: true }> {
  await transitionVendor(vendorId, "active")
  return { ok: true }
}

/** Admin rejects a vendor → inactive, with a reason recorded on the verification flags. */
export async function rejectVendor(vendorId: string, reason: string): Promise<{ ok: true }> {
  const svc = createServiceClient()
  const { data: v, error: readErr } = await svc.from("vendors").select("verification_flags").eq("id", vendorId).maybeSingle()
  if (readErr) throw new Error(`Could not read the vendor: ${readErr.message}`)
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
  // m376 forces the expiry to be ISO-leading; a non-ISO string would come back
  // as a 23514 rather than as a silently unreadable date. Say so plainly here.
  if (!ISO_DATE.test(expiry)) throw new Error(`Expiry must be a yyyy-mm-dd date — got "${expiry}"`)
  bag[credentialType] = { ...(bag[credentialType] ?? {}), expiry, ...(url ? { url } : {}) }
  const { error: credErr } = await svc.from("vendors").update({ compliance_credentials: bag, updated_at: new Date().toISOString() }).eq("id", vendorId)
  if (credErr) throw new Error(`Failed to record ${credentialType} expiry: ${credErr.message}`)
  return { ok: true }
}

/** m376 — the shape vendors_compliance_credentials_shape will accept for a date field. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export interface RecordVendorInsuranceInput {
  vendorId: string
  carrier: string
  policyNumber: string
  /** Liability limit in whole USD. */
  coverageAmount: number
  /** yyyy-mm-dd — when coverage began. */
  effectiveDate: string
  /** yyyy-mm-dd — when coverage lapses. THE date every verdict is computed from. */
  expiry: string
  /** Link to the stored certificate document. */
  certificateUrl?: string
}

export type RecordVendorInsuranceResult =
  | { success: true; status: InsuranceStatus }
  | { success: false; error: string }

/**
 * VENDOR INSURANCE VERIFICATION — record a certificate of insurance against the
 * canonical vendor row and report back what the STORED dates actually say.
 *
 * Three things this deliberately does NOT do:
 *
 *  1. IT NEVER FABRICATES A VERDICT. There is no "isCompliant" input and no
 *     compliance flag written anywhere. The posture returned to the caller is
 *     computed by readVendorInsurance() from the expiry that was READ BACK out
 *     of the database after the write — so the caller is told what the row now
 *     says, not what this function was asked to say. If the write were rejected,
 *     the read-back could not report success.
 *  2. IT WRITES NO PARALLEL RECORD. The certificate goes into the vendor's
 *     existing compliance_credentials bag, which is the same jsonb the nightly
 *     document-expiry sweep (lib/kernel/vendor-doc-compliance.ts, ridden by the
 *     vendor-orchestration cron) already reads to hard-suspend a lapsed vendor.
 *     A second home for the expiry would mean the screen and the suspender could
 *     disagree about whether a vendor is insured.
 *  3. IT DOES NOT REACTIVATE A SUSPENDED VENDOR. Recording a renewal is evidence;
 *     restoring a vendor to the bench is a broker decision and stays behind
 *     approveVendor(). Auto-reactivating here would let a data-entry action
 *     silently undo a liability suspension.
 *
 * Auth: broker/admin of the vendor's own brokerage (requireAdmin). Scope: the
 * lookup and the write are both pinned to that brokerage_id, so a GLOBAL vendor
 * (brokerage_id IS NULL, shared by every tenant) is out of reach here by
 * construction — matching the m355 tenant-write policy.
 */
export async function recordVendorInsuranceAction(input: RecordVendorInsuranceInput): Promise<RecordVendorInsuranceResult> {
  try {
    const vendorId = String(input.vendorId ?? "").trim()
    if (!vendorId) return { success: false, error: "A vendor is required." }

    const carrier = String(input.carrier ?? "").trim()
    if (!carrier) return { success: false, error: "Carrier name is required — a certificate with no insurer on it verifies nothing." }

    const policyNumber = String(input.policyNumber ?? "").trim()
    if (!policyNumber) return { success: false, error: "Policy number is required." }

    const coverageAmount = Number(input.coverageAmount)
    if (!Number.isFinite(coverageAmount) || coverageAmount < 0) {
      return { success: false, error: "Coverage amount must be a whole dollar figure of 0 or more." }
    }

    const effectiveDate = String(input.effectiveDate ?? "").trim()
    const expiry = String(input.expiry ?? "").trim()
    // Checked here so the admin gets a sentence instead of a 23514 from
    // vendors_compliance_credentials_shape, which enforces exactly this.
    if (!ISO_DATE.test(effectiveDate)) return { success: false, error: "Effective date must be a yyyy-mm-dd date." }
    if (!ISO_DATE.test(expiry)) return { success: false, error: "Expiry date must be a yyyy-mm-dd date." }
    if (expiry <= effectiveDate) return { success: false, error: "Expiry must fall after the effective date." }

    const certificateUrl = String(input.certificateUrl ?? "").trim()

    const { userId, brokerageId } = await requireAdmin()
    const svc = createServiceClient()

    const { data: vendor, error: readErr } = await svc
      .from("vendors")
      .select("id, name, compliance_credentials")
      .eq("id", vendorId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    if (readErr) return { success: false, error: `Could not read the vendor: ${readErr.message}` }
    if (!vendor) return { success: false, error: "Vendor not found in your brokerage (global vendors are not editable from here)." }

    const existing = (vendor as any).compliance_credentials
    const bag: Record<string, unknown> = existing && typeof existing === "object" ? { ...existing } : {}
    // The key is the literal 'insurance' and nothing else: it is the sole member
    // of HARD_SUSPEND_TYPES, so any other spelling would quietly downgrade a
    // lapse to a 14-day grace. m376 now refuses the typo at the database too.
    bag.insurance = {
      carrier,
      policy_number: policyNumber,
      coverage_amount: Math.round(coverageAmount),
      effective_date: effectiveDate,
      expiry,
      ...(certificateUrl ? { url: certificateUrl } : {}),
      verified_at: new Date().toISOString(),
      // users.id — the id space vendors.verified_by holds and the space m376's
      // vendors_verified_by_fkey pins. requireAdmin resolved it from the session's
      // auth user, so it is never an agents.id or a contacts.id.
      verified_by: userId,
    }

    const { data: saved, error: writeErr } = await svc
      .from("vendors")
      .update({ compliance_credentials: bag, updated_at: new Date().toISOString() })
      .eq("id", vendorId)
      .eq("brokerage_id", brokerageId)
      .select("id, compliance_credentials")
      .maybeSingle()
    if (writeErr) return { success: false, error: `Insurance was not saved: ${writeErr.message}` }
    if (!saved) return { success: false, error: "Insurance was not saved — the vendor row did not accept the update." }

    // THE VERDICT COMES FROM THE ROW, not from the input above.
    const status = readVendorInsurance((saved as any).compliance_credentials, new Date())
    return { success: true, status }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Failed to record insurance." }
  }
}

/**
 * Admin sets a custom monthly price (USD) for a vendor subscription tier, stored on the brokerage's
 * settings (brokerage_settings.settings.vendor_tier_pricing). A brokerage that wants different pricing than
 * the platform defaults overrides it here; the billing resolver (resolveTierPrice) honors it. Pass a
 * negative/NaN amount to clear an override back to the platform default.
 */
export async function setVendorTierPricing(
  tier: "basic" | "standard" | "premium" | "preferred_network",
  monthlyPriceUsd: number,
): Promise<{ ok: true; pricing: Record<string, number> }> {
  const { brokerageId } = await requireAdmin()
  const svc = createServiceClient()
  const { data: row } = await svc.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
  const settings = (row as { settings?: Record<string, unknown> } | null)?.settings ?? {}
  const pricing: Record<string, number> = { ...((settings as any).vendor_tier_pricing ?? {}) }
  if (Number.isFinite(monthlyPriceUsd) && monthlyPriceUsd >= 0) pricing[tier] = Math.round(monthlyPriceUsd)
  else delete pricing[tier]
  const nextSettings = { ...settings, vendor_tier_pricing: pricing }
  const { error } = await svc.from("brokerage_settings").upsert({ brokerage_id: brokerageId, settings: nextSettings, updated_at: new Date().toISOString() }, { onConflict: "brokerage_id" })
  if (error) throw new Error(`Failed to save pricing: ${error.message}`)
  return { ok: true, pricing }
}

/** Admin asks the vendor for more info — keeps them pending, records the requested items on the flags. */
export async function requestVendorInfo(vendorId: string, items: string[]): Promise<{ ok: true }> {
  const { brokerageId } = await requireAdmin()
  const svc = createServiceClient()
  const { data: v, error: readErr } = await svc.from("vendors").select("verification_flags").eq("id", vendorId).eq("brokerage_id", brokerageId).maybeSingle()
  if (readErr) throw new Error(`Could not read the vendor: ${readErr.message}`)
  if (!v) throw new Error("Vendor not found in your brokerage")
  const flags = Array.isArray((v as any).verification_flags) ? (v as any).verification_flags : []
  const { error: flagErr } = await svc.from("vendors").update({ verification_flags: [...flags, ...items.map((i) => `info_requested:${i}`)], updated_at: new Date().toISOString() }).eq("id", vendorId)
  if (flagErr) throw new Error(`Failed to record the request: ${flagErr.message}`)
  return { ok: true }
}
