"use server"

// app/actions/superadmin/platform-form-packets.ts
// ───────────────────────────────────────────────────────────────────────────
// Platform staff load, approve and retire the licensed FILLABLE form packets of the VIPAgents CATALOGUE (wave 143, lane
// 143B; wave 144, lane 144C — owner ruling 3: packets are the brokerage's and the team's, so an approved catalogue packet is
// offered to brokerages to ADD to their own library, never handed to agents directly; core: lib/forms/platform-form-packets.ts).
//
// GATE FIRST (CLAUDE.md §4): every export is a public endpoint, so each one opens with requireSuperadmin() — the
// highest platform authority, because approving a packet offers licensed content to EVERY tenant — and only
// then touches the service client. The actor recorded is the SESSION's, never a body value. Each act is written to
// superadmin_audit_log (who, what, which packet, the licence basis), read-error checked.
//
// NOTHING HERE PUBLISHES ON UPLOAD: uploadPlatformPacketAction registers a DRAFT; a person approves it (with the
// licence basis the platform holds it under) in a separate act. Uploads are capped below the platform's request
// body limit; a larger licensed PDF is a conversation, not a bigger limit.

import { headers } from "next/headers"
import { revalidatePath } from "next/cache"
import { requireSuperadmin } from "@/lib/auth/platform-guard"
import { createServiceClient } from "@/lib/supabase/service"
import { approvePlatformPacket, registerPlatformPacket, retirePlatformPacket } from "@/lib/forms/platform-form-packets"

/** Stay under the serverless request-body ceiling (multipart overhead included). */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024

type Result = { ok: true; message: string } | { ok: false; error: string }

async function audit(actorUserId: string, actorEmail: string, action: string, targetId: string | null, details: Record<string, unknown>): Promise<string | null> {
  try {
    const svc = createServiceClient()
    const hdrs = await headers()
    const { error } = await svc.from("superadmin_audit_log").insert({
      actor_user_id: actorUserId, actor_email: actorEmail, action, target_type: "platform_form_packet", target_id: targetId,
      details, ip_address: hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"), user_agent: hdrs.get("user-agent"),
    })
    return error ? error.message : null
  } catch (e) {
    return e instanceof Error ? e.message : "audit failed"
  }
}

/** Register a DRAFT packet from an uploaded PDF. Tenants cannot see it until it is approved. */
export async function uploadPlatformPacketAction(formData: FormData): Promise<Result> {
  const gate = await requireSuperadmin()
  if (!gate.ok) return { ok: false, error: gate.error }

  const file = formData.get("file")
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose a PDF to upload." }
  if (file.size > MAX_UPLOAD_BYTES) return { ok: false, error: `That PDF is ${(file.size / (1024 * 1024)).toFixed(1)} MB; uploads are limited to ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.` }

  const svc = createServiceClient()
  const result = await registerPlatformPacket(svc, {
    actorUserId: gate.userId,
    name: String(formData.get("name") ?? ""),
    state: (String(formData.get("state") ?? "").trim() || null),
    packetType: String(formData.get("packetType") ?? ""),
    formCode: (String(formData.get("formCode") ?? "").trim() || null),
    description: (String(formData.get("description") ?? "").trim() || null),
    fileName: file.name,
    bytes: new Uint8Array(await file.arrayBuffer()),
  })
  if (!result.ok) return result
  const auditError = await audit(gate.userId, gate.email, "platform_form_packet.registered", result.packet.id, { name: result.packet.name, state: result.packet.state, packet_type: result.packet.packet_type, fields: result.packet.field_count })
  revalidatePath("/dashboard/superadmin/form-packets")
  return { ok: true, message: `Registered "${result.packet.name}" as a draft with ${result.packet.field_count} fillable fields.${auditError ? ` (Audit row not written: ${auditError})` : ""}` }
}

/** Approve a draft for every subscriber. The licence basis is required. */
export async function approvePlatformPacketAction(input: { packetId: string; licenseNote: string; licenseExpiresAt?: string | null }): Promise<Result> {
  const gate = await requireSuperadmin()
  if (!gate.ok) return { ok: false, error: gate.error }
  const svc = createServiceClient()
  const result = await approvePlatformPacket(svc, { actorUserId: gate.userId, packetId: String(input.packetId ?? ""), licenseNote: String(input.licenseNote ?? ""), licenseExpiresAt: input.licenseExpiresAt || null })
  if (!result.ok) return result
  const auditError = await audit(gate.userId, gate.email, "platform_form_packet.approved", input.packetId, { license_note: input.licenseNote, license_expires_at: input.licenseExpiresAt ?? null, retired_older: result.retiredOlder })
  revalidatePath("/dashboard/superadmin/form-packets")
  return { ok: true, message: `Approved — brokerages can now add it to their own library.${result.retiredOlder ? ` ${result.retiredOlder} older version(s) retired.` : ""}${auditError ? ` (Audit row not written: ${auditError})` : ""}` }
}

/** Retire a catalogue packet: brokerages can no longer add it (copies already in a brokerage's library are the brokerage's). */
export async function retirePlatformPacketAction(input: { packetId: string; reason: string }): Promise<Result> {
  const gate = await requireSuperadmin()
  if (!gate.ok) return { ok: false, error: gate.error }
  const svc = createServiceClient()
  const result = await retirePlatformPacket(svc, { actorUserId: gate.userId, packetId: String(input.packetId ?? ""), reason: String(input.reason ?? "") })
  if (!result.ok) return result
  const auditError = await audit(gate.userId, gate.email, "platform_form_packet.retired", input.packetId, { reason: input.reason })
  revalidatePath("/dashboard/superadmin/form-packets")
  return { ok: true, message: `Retired.${auditError ? ` (Audit row not written: ${auditError})` : ""}` }
}
