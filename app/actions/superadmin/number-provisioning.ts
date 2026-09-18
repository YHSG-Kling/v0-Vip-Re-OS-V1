"use server"

// app/actions/superadmin/number-provisioning.ts
// ─────────────────────────────────────────────────────────────────────────────
// STAFF-SIDE NUMBER PROVISIONING (the platform-context path deferred in round
// 24). Every action is providers-gated with requireWrite — a read-downgraded
// role cannot search, buy, or release — and every mutation lands BOTH ledgers:
// phone_number_events (source 'staff_provisioned' / 'staff_released') and
// superadmin_audit_log. The pipeline itself is the ONE shared core
// (lib/voice/number-provisioning.ts) the tenant action also runs — keep-one,
// no fork. Mock-safe: without Twilio creds the core answers an honest
// "not configured"; nothing here ever fakes a purchase or a release.
//
// RELEASE SAFETY: releasing a number is destructive (the tenant loses the
// line; Twilio may re-sell it). The action REQUIRES a `confirm` field that
// must equal the number VERBATIM (exact string match against the stored
// phone_number) — a UI checkbox cannot satisfy it by accident.

import { headers } from "next/headers"
import { createServiceClient } from "@/lib/supabase/service"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import {
  searchAvailableNumbers,
  provisionNumber,
  releaseNumber,
  type NumberCandidate,
} from "@/lib/voice/number-provisioning"

async function audit(
  svc: ReturnType<typeof createServiceClient>,
  userId: string,
  action: string,
  brokerageId: string,
  details: Record<string, unknown>,
) {
  try {
    const hdrs = await headers()
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: userId, action, target_type: "brokerage", target_id: brokerageId,
      details, ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"), user_agent: hdrs.get("user-agent"),
    })
  } catch (err) { console.error("[number-provisioning audit] failed:", err) }
}

// ─── Search ──────────────────────────────────────────────────────────────────

export async function searchNumbersForTenant(params: {
  brokerageId: string
  areaCode?: string
  locality?: string
}): Promise<{ ok: true; candidates: NumberCandidate[]; credTier: string } | { ok: false; error: string; notConfigured?: boolean }> {
  const gate = await requirePlatformCapability("providers", { requireWrite: true })
  if (!gate.ok || !gate.userId) return { ok: false, error: gate.error ?? "Forbidden" }
  if (!params.brokerageId) return { ok: false, error: "brokerageId is required" }

  const svc = createServiceClient()
  const { data: brk } = await svc.from("brokerages").select("id").eq("id", params.brokerageId).maybeSingle()
  if (!brk) return { ok: false, error: "Tenant not found" }

  const res = await searchAvailableNumbers(svc, params.brokerageId, {
    areaCode: params.areaCode || null,
    locality: params.locality || null,
    limit: 10,
  })
  if (!res.ok) return res
  return { ok: true, candidates: res.candidates, credTier: res.credTier }
}

// ─── Provision ───────────────────────────────────────────────────────────────

export async function provisionNumberForTenant(params: {
  brokerageId: string
  /** Exact candidate (from a search) — omit to buy the first match for areaCode. */
  phoneNumber?: string
  areaCode?: string
}): Promise<
  | { ok: true; phoneNumber: string; twilioSid: string | null; credTier: string; bound: boolean; bindNote?: string }
  | { ok: false; error: string; notConfigured?: boolean }
> {
  const gate = await requirePlatformCapability("providers", { requireWrite: true })
  if (!gate.ok || !gate.userId) return { ok: false, error: gate.error ?? "Forbidden" }
  if (!params.brokerageId) return { ok: false, error: "brokerageId is required" }

  const svc = createServiceClient()
  const { data: brk } = await svc.from("brokerages").select("id, name").eq("id", params.brokerageId).maybeSingle()
  if (!brk) return { ok: false, error: "Tenant not found" }

  // The ONE shared pipeline (same as the tenant action): search-or-exact →
  // purchase → persist (brokerage-scoped inventory row) → events line →
  // webhook binding onto the AI lane.
  const result = await provisionNumber(svc, {
    brokerageId: params.brokerageId,
    phoneNumber: params.phoneNumber || null,
    areaCode: params.areaCode || null,
    scopeType: "brokerage",
    eventSource: "staff_provisioned",
    eventNotes: `Provisioned from the fleet numbers console by platform staff`,
    bindToVoiceLane: true,
  })
  if (!result.ok) return result

  await audit(svc, gate.userId, "numbers.staff_provisioned", params.brokerageId, {
    brokerage_name: (brk as any).name ?? null,
    phone_number: result.phoneNumber,
    twilio_sid: result.twilioSid,
    cred_tier: result.credTier,
    bound_to_voice_lane: result.bound,
    ...(result.bindNote ? { bind_note: result.bindNote } : {}),
  })
  return { ok: true, phoneNumber: result.phoneNumber, twilioSid: result.twilioSid, credTier: result.credTier, bound: result.bound, bindNote: result.bindNote }
}

// ─── Release ─────────────────────────────────────────────────────────────────

export async function releaseNumberForTenant(params: {
  brokerageId: string
  numberRowId: string
  /** MUST equal the number verbatim (exact match against the stored phone_number). */
  confirm: string
}): Promise<{ ok: true; phoneNumber: string; twilioReleased: boolean; note?: string } | { ok: false; error: string; notConfigured?: boolean }> {
  const gate = await requirePlatformCapability("providers", { requireWrite: true })
  if (!gate.ok || !gate.userId) return { ok: false, error: gate.error ?? "Forbidden" }
  if (!params.brokerageId || !params.numberRowId) return { ok: false, error: "brokerageId and numberRowId are required" }

  const svc = createServiceClient()
  const { data: row } = await svc.from("tenant_phone_numbers")
    .select("id, brokerage_id, phone_number, is_active")
    .eq("id", params.numberRowId).maybeSingle()
  const n = row as any
  if (!n || n.brokerage_id !== params.brokerageId) return { ok: false, error: "Number not found for this tenant" }

  // TYPE-THE-NUMBER CONFIRMATION — verbatim, before anything touches Twilio.
  if (typeof params.confirm !== "string" || params.confirm !== n.phone_number) {
    return { ok: false, error: `Confirmation mismatch — type the number exactly as stored (${n.phone_number}) to release it. Nothing was changed.` }
  }

  const result = await releaseNumber(svc, {
    brokerageId: params.brokerageId,
    numberRowId: params.numberRowId,
    eventSource: "staff_released",
    notes: "Released from the fleet numbers console by platform staff",
  })
  if (!result.ok) return result

  await audit(svc, gate.userId, "numbers.staff_released", params.brokerageId, {
    phone_number: result.phoneNumber,
    twilio_released: result.twilioReleased,
    ...(result.note ? { note: result.note } : {}),
  })
  return result
}
