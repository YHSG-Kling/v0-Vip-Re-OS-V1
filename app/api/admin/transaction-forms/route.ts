/**
 * Admin API for the brokerage transaction-forms library
 * (brokerage_form_library table — used by the AI form-fill engine to
 * autofill state-specific transaction forms with prefilled fields).
 *
 * Distinct from /api/admin/forms (which manages lead-capture web forms in
 * the `forms` table). This API manages the broker's PDF-form library that
 * the workflow OS form-fill engine consults when assembling offer/listing
 * packets.
 *
 * GET    list the library rows the caller's memberships reach, the teams they may share with, and the platform catalogue
 * POST   upload a packet (multipart with the PDF) — shared with the whole brokerage, or with ONE team;
 *        or (JSON { action: "add_from_catalogue", platform_packet_id, team_id?, state? }) add a platform-catalogue packet
 * PATCH  update fields (name, description, state, packet_type, form_code, field_schema, licence, is_active)
 * DELETE soft-delete (is_active=false)
 *
 * WAVE 144 (lane 144C — owner ruling 3: "Form packets are NOT platform-owned. The brokerage or team uploads approved form packets …
 * into THEIR OWN tenant/team bucket and shares them with their agents as templates"). This route was already the ONE upload path
 * (app/actions/compliance/manage-required-docs.ts "keep-one"); it now writes through the ONE packet writer,
 * lib/forms/tenant-form-packets.ts — which stores the master in the OWNER's folder (`brokerage/{id}/packets/…` or
 * `teams/{id}/packets/…`), records the licence, counts the fillable fields, and refuses a sharer without the authority for the
 * scope (brokerage-wide: the oversight class; one team: that team's lead or oversight). The platform catalogue is a SOURCE a
 * brokerage adds from (lib/forms/platform-form-packets.ts addPlatformPacketToLibrary), never an owner.
 *
 * Auth: a signed-in tenant admin (users.user_type, including a team lead for their own team) or platform staff (platform_role) on
 * the user's brokerage — the forms library is tenant-admin config, and platform staff administer tenants. Tenant from the
 * SESSION; the service client is opened only after that gate (CLAUDE.md §4).
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { checkUpload } from "@/lib/storage/file-limits"
import { isPlatformStaffIdentity, isTenantAdminOrPlatformStaff } from "@/lib/auth/resolve-user-role"
import {
  FORM_PACKET_BUCKET, issueTenantPacketUrl, listLibraryForActor, mayManagePacketScope, registerTenantFormPacket, resolvePacketActor, retireTenantFormPacket, updateTenantFormPacket,
  type PacketActor,
} from "@/lib/forms/tenant-form-packets"
import { PLATFORM_PACKET_PREVIEW_TTL_SECONDS, addPlatformPacketToLibrary, listPlatformPacketsForTenant, parsePlatformPacketPath } from "@/lib/forms/platform-form-packets"

type Svc = ReturnType<typeof createServiceClient>

async function authAdmin(): Promise<{ userId: string; brokerageId: string; actor: PacketActor; svc: Svc } | NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // `error` destructured: supabase-js resolves a refused read, and a refusal must
  // not be reported as "no brokerage on user".
  const { data: userRow, error: userError } = await supabase
    .from("users").select("brokerage_id, user_type, platform_role").eq("id", user.id).maybeSingle()
  if (userError) return NextResponse.json({ error: "Role lookup failed" }, { status: 500 })
  if (!userRow?.brokerage_id) return NextResponse.json({ error: "No brokerage on user" }, { status: 422 })

  // ONE vocabulary per column: user_type answers the tenant half, platform_role
  // the staff half — never coalesced into a single mixed value.
  if (!isTenantAdminOrPlatformStaff(userRow)) {
    return NextResponse.json({ error: "Admin role required" }, { status: 403 })
  }
  // GATE PASSED — only now the service client, and the actor is resolved from the SESSION user.
  const svc = createServiceClient()
  const resolved = await resolvePacketActor(svc as never, user.id)
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 500 })
  // Platform staff administer tenants: they act with the brokerage's oversight authority on the brokerage they are attached to.
  const actor: PacketActor = isPlatformStaffIdentity(userRow.user_type, userRow.platform_role) ? { ...resolved.actor, oversight: true } : resolved.actor
  return { userId: user.id, brokerageId: userRow.brokerage_id, actor, svc }
}

// ─── GET — list forms ──────────────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  const auth = await authAdmin()
  if (auth instanceof NextResponse) return auth

  const lib = await listLibraryForActor(auth.svc as never, auth.actor)
  if (!lib.ok) return NextResponse.json({ error: lib.error }, { status: 500 })
  // EVERY PACKET LINK IS MINTED PER VIEW (wave 145, lane 145A): a registered master's `pdf_url` in this response is a short-lived
  // link from the ONE minting door, issued only for a row this manager has authority over — never the stored column (which used
  // to carry a 10-year bearer URL no retirement or membership end could revoke). A row whose link cannot be minted shows none.
  const forms = await Promise.all(lib.forms.map(async (f) => {
    if (!f.storage_path) return f
    const minted = await issueTenantPacketUrl(auth.svc as never, auth.actor, f, "manage")
    return { ...f, pdf_url: minted.ok ? minted.url : null }
  }))
  // The platform catalogue — what this brokerage MAY add to its own library. A refused catalogue read is reported beside the
  // library, never as an empty catalogue (and never blocks the brokerage's own forms).
  const catalogue = await listPlatformPacketsForTenant(auth.svc as never, {})
  const platformCatalogue: Array<Record<string, unknown>> = []
  if (catalogue.ok) {
    for (const p of catalogue.packets) {
      // Only a well-formed catalogue master path is ever signed (never an arbitrary object a registry row happened to name).
      const signed = parsePlatformPacketPath(p.path)
        ? (await auth.svc.storage.from(FORM_PACKET_BUCKET).createSignedUrl(p.path, PLATFORM_PACKET_PREVIEW_TTL_SECONDS)).data
        : null
      platformCatalogue.push({ id: p.packetId, name: p.name, state: p.state, packet_type: p.packetType, form_code: p.formCode, version: p.version, license_note: p.licenseNote, license_expires_at: p.licenseExpiresAt, preview_url: signed?.signedUrl ?? null })
    }
  }
  return NextResponse.json({
    forms, share_teams: lib.shareTeams, may_share_brokerage_wide: mayManagePacketScope(auth.actor, null),
    platform_catalogue: platformCatalogue, platform_catalogue_error: catalogue.ok ? null : catalogue.error,
  })
}

// ─── POST — upload a packet (multipart), or add one from the platform catalogue (JSON) ─────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await authAdmin()
  if (auth instanceof NextResponse) return auth

  const ct = req.headers.get("content-type") ?? ""
  if (ct.includes("application/json")) {
    const body = await req.json().catch(() => ({})) as { action?: string; platform_packet_id?: string; team_id?: string | null; state?: string | null }
    if (body.action !== "add_from_catalogue" || !body.platform_packet_id) return NextResponse.json({ error: "action add_from_catalogue with platform_packet_id required" }, { status: 400 })
    const added = await addPlatformPacketToLibrary(auth.svc as never, auth.actor, { packetId: body.platform_packet_id, teamId: body.team_id ?? null, state: body.state ?? null })
    if (!added.ok) return NextResponse.json({ error: added.error }, { status: 422 })
    return NextResponse.json({ form: added.packet, existing: added.existing })
  }

  let formData: FormData
  if (ct.includes("multipart/form-data")) {
    try {
      formData = await req.formData()
    } catch {
      return NextResponse.json({ error: "Invalid form data" }, { status: 400 })
    }
  } else {
    return NextResponse.json({ error: "multipart/form-data required" }, { status: 415 })
  }

  const name        = formData.get("name")        as string | null
  const description = formData.get("description") as string | null
  const state       = formData.get("state")       as string | null
  const packetType  = formData.get("packet_type") as string | null
  const teamId      = (formData.get("team_id") as string | null) || null
  const formCode    = formData.get("form_code")   as string | null
  const licenseNote = formData.get("license_note") as string | null
  const licenseExpiresAt = (formData.get("license_expires_at") as string | null) || null
  const fieldSchemaRaw = formData.get("field_schema") as string | null
  const file        = formData.get("file")        as File | null

  if (!name || !state || !packetType) {
    return NextResponse.json({ error: "name, state, and packet_type required" }, { status: 400 })
  }
  // The PDF is optional, as it always was here: a field-schema-only entry is the AI form-fill engine's mapping with no master.
  const hasFile = !!file && file.size > 0
  if (hasFile && file!.type !== "application/pdf") {
    return NextResponse.json({ error: "Only PDF uploads supported" }, { status: 415 })
  }
  if (hasFile) {
    // The bytes ride a Vercel Function request body, so 4.5 MB is the real ceiling (the ONE limits table, lib/storage/file-limits.ts).
    const gate = checkUpload({
      bucket: "brokerage-forms",
      transport: "route_handler",
      bytes: file!.size,
      contentType: file!.type,
    })
    if (!gate.ok) {
      return NextResponse.json({ error: gate.reason }, { status: 413 })
    }
  }

  let fieldSchema: string[] | null = null
  if (fieldSchemaRaw) {
    try {
      const parsed = JSON.parse(fieldSchemaRaw)
      if (Array.isArray(parsed) && parsed.every(x => typeof x === "string")) {
        fieldSchema = parsed
      }
    } catch { /* invalid JSON — leave as null */ }
  }

  const registered = await registerTenantFormPacket(auth.svc as never, auth.actor, {
    teamId, name, description, state, packetType, formCode, licenseNote, licenseExpiresAt, fieldSchema,
    fileName: hasFile ? file!.name : null, bytes: hasFile ? new Uint8Array(await file!.arrayBuffer()) : null,
  })
  if (!registered.ok) return NextResponse.json({ error: registered.error }, { status: 422 })

  // NO LINK IS PERSISTED (wave 145, lane 145A). This used to write a 10-YEAR signed URL (issueBucketObjectUrl's default TTL) into
  // brokerage_form_library.pdf_url — a bearer link to a licensed master that every reader of the row could keep using after the
  // packet was retired, its licence expired or their membership ended. `storage_path` is the durable reference; the link the
  // uploader sees now is minted per view by the ONE door (lib/forms/tenant-form-packets.ts issueTenantPacketUrl) and lives minutes.
  const minted = registered.packet.storage_path ? await issueTenantPacketUrl(auth.svc as never, auth.actor, registered.packet, "manage") : null
  return NextResponse.json({ form: { ...registered.packet, pdf_url: minted?.ok ? minted.url : null }, note: minted && !minted.ok ? `the preview link could not be minted (${minted.reason})` : null })
}

// ─── PATCH — update form ───────────────────────────────────────────────────

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const auth = await authAdmin()
  if (auth instanceof NextResponse) return auth

  const body = await req.json().catch(() => ({})) as {
    id?: string
    name?: string
    description?: string
    state?: string
    packet_type?: string
    form_code?: string | null
    field_schema?: string[]
    is_active?: boolean
    license_note?: string | null
    license_expires_at?: string | null
  }
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 })
  const { id, ...patch } = body
  const updated = await updateTenantFormPacket(auth.svc as never, auth.actor, id, patch)
  if (!updated.ok) return NextResponse.json({ error: updated.error }, { status: 403 })
  return NextResponse.json({ success: true })
}

// ─── DELETE — soft-delete (is_active=false) ────────────────────────────────

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const auth = await authAdmin()
  if (auth instanceof NextResponse) return auth

  const url = new URL(req.url)
  const id = url.searchParams.get("id")
  if (!id) return NextResponse.json({ error: "id query param required" }, { status: 400 })

  const retired = await retireTenantFormPacket(auth.svc as never, auth.actor, id)
  if (!retired.ok) return NextResponse.json({ error: retired.error }, { status: 403 })
  return NextResponse.json({ success: true })
}
