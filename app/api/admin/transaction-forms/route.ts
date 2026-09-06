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
 * GET    list forms for the user's brokerage
 * POST   create a new form (multipart with optional PDF)
 * PATCH  update fields (name, description, field_schema, is_active)
 * DELETE soft-delete (is_active=false)
 *
 * Auth: tenant admin (users.user_type) or platform staff (platform_role) on the
 * user's brokerage — the forms library is tenant-admin config, and platform
 * staff administer tenants.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { issueBucketObjectUrl } from "@/lib/storage/document-buckets"
import { checkUpload } from "@/lib/storage/file-limits"
import { removeOrRecordOrphan } from "@/lib/storage/put-and-sign"
import { isTenantAdminOrPlatformStaff } from "@/lib/auth/resolve-user-role"

async function authAdmin(): Promise<{ userId: string; brokerageId: string } | NextResponse> {
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
  return { userId: user.id, brokerageId: userRow.brokerage_id }
}

// ─── GET — list forms ──────────────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  const auth = await authAdmin()
  if (auth instanceof NextResponse) return auth

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("brokerage_form_library")
    .select("id, name, description, state, packet_type, pdf_url, field_schema, is_active, created_at, updated_at")
    .eq("brokerage_id", auth.brokerageId)
    .order("state", { ascending: true })
    .order("packet_type", { ascending: true })
    .order("name", { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ forms: data ?? [] })
}

// ─── POST — create form (multipart for PDF upload) ─────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await authAdmin()
  if (auth instanceof NextResponse) return auth

  const ct = req.headers.get("content-type") ?? ""
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
  const fieldSchemaRaw = formData.get("field_schema") as string | null
  const file        = formData.get("file")        as File | null

  if (!name || !state || !packetType) {
    return NextResponse.json({ error: "name, state, and packet_type required" }, { status: 400 })
  }

  let pdfUrl: string | null = null
  if (file && file.size > 0) {
    if (file.type !== "application/pdf") {
      return NextResponse.json({ error: "Only PDF uploads supported" }, { status: 415 })
    }
    // The 10 MB here was a fifth hand-kept number. The bytes ride a Vercel
    // Function request body, so 4.5 MB is the real ceiling — a broker uploading
    // a scanned 8 MB form packet was told 10 MB was fine and then 413'd at the
    // edge with no message this code wrote.
    const gate = checkUpload({
      bucket: "brokerage-forms",
      transport: "route_handler",
      bytes: file.size,
      contentType: file.type,
    })
    if (!gate.ok) {
      return NextResponse.json({ error: gate.reason }, { status: 413 })
    }
    // WAS: put(…, { access: "public" }) to Vercel Blob — a brokerage's
    // transaction-form library at permanent unauthenticated URLs, in a
    // third-party blob store the owner rule already says not to use. It now goes
    // to the platform's own `brokerage-forms` Supabase bucket (document-class)
    // and the URL comes from the ONE issuer. FAIL CLOSED: no signed URL → the
    // bytes are removed and the request is refused, never a public link.
    const slug = Math.random().toString(36).slice(2, 9)
    const path = `brokerage/${auth.brokerageId}/${state}-${packetType}-${Date.now()}-${slug}.pdf`
    const buffer = Buffer.from(await file.arrayBuffer())
    const svc = createServiceClient()
    const { error: upErr } = await svc.storage
      .from("brokerage-forms")
      .upload(path, buffer, { contentType: "application/pdf", upsert: false })
    if (upErr) {
      return NextResponse.json({ error: `Storage upload failed: ${upErr.message}` }, { status: 500 })
    }
    const issued = await issueBucketObjectUrl(svc as never, { bucket: "brokerage-forms", objectPath: path })
    if (!issued.ok) {
      await removeOrRecordOrphan(svc as never, {
        bucket: "brokerage-forms", objectPath: path,
        reason: "transaction_form_sign_failed", detail: issued.reason,
        brokerageId: auth.brokerageId,
      })
      return NextResponse.json({ error: issued.reason }, { status: 502 })
    }
    pdfUrl = issued.url
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

  const supabase = await createClient()
  const { data, error } = await supabase.from("brokerage_form_library").insert({
    brokerage_id: auth.brokerageId,
    name,
    description: description ?? null,
    state: state.trim().toUpperCase(),
    packet_type: packetType,
    pdf_url: pdfUrl,
    field_schema: fieldSchema,
    uploaded_by: auth.userId,
    is_active: true,
  }).select("*").single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ form: data })
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
    field_schema?: string[]
    is_active?: boolean
  }
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 })

  const supabase = await createClient()
  // Verify the form belongs to the user's brokerage before updating
  const { data: existing } = await supabase
    .from("brokerage_form_library")
    .select("id")
    .eq("id", body.id)
    .eq("brokerage_id", auth.brokerageId)
    .maybeSingle()
  if (!existing) return NextResponse.json({ error: "Form not in your brokerage" }, { status: 403 })

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (body.name        !== undefined) updates.name        = body.name
  if (body.description !== undefined) updates.description = body.description
  if (body.state       !== undefined) updates.state       = body.state.trim().toUpperCase()
  if (body.packet_type !== undefined) updates.packet_type = body.packet_type
  if (body.field_schema !== undefined) updates.field_schema = body.field_schema
  if (body.is_active   !== undefined) updates.is_active   = body.is_active

  const { error } = await supabase
    .from("brokerage_form_library")
    .update(updates)
    .eq("id", body.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}

// ─── DELETE — soft-delete (is_active=false) ────────────────────────────────

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const auth = await authAdmin()
  if (auth instanceof NextResponse) return auth

  const url = new URL(req.url)
  const id = url.searchParams.get("id")
  if (!id) return NextResponse.json({ error: "id query param required" }, { status: 400 })

  const supabase = await createClient()
  const { error } = await supabase
    .from("brokerage_form_library")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("brokerage_id", auth.brokerageId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
