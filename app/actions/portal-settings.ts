"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"

interface ProfileUpdate {
  first_name?: string
  last_name?: string
  email?: string
  phone?: string
  address?: string
  city?: string
  state?: string
  zip_code?: string
  preferred_contact_method?: string
  metadata?: Record<string, any>
}

export async function updateContactProfile(
  contactId: string,
  updates: ProfileUpdate,
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createClient()

    const { error } = await supabase
      .from("contacts")
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq("id", contactId)

    if (error) {
      console.error("Error updating contact profile:", error)
      return { success: false, error: error.message }
    }

    revalidatePath(`/portal/${contactId}`)
    revalidatePath(`/portal/${contactId}/settings`)

    return { success: true }
  } catch (error) {
    console.error("Unexpected error updating profile:", error)
    return { success: false, error: "An unexpected error occurred" }
  }
}

export async function uploadProfilePhoto(
  contactId: string,
  file: File,
): Promise<{ success: boolean; url?: string; error?: string }> {
  try {
    const supabase = await createClient()

    // Upload to Supabase Storage
    const fileExt = file.name.split(".").pop()
    const fileName = `${contactId}-${Date.now()}.${fileExt}`
    const filePath = `avatars/${fileName}`

    const { error: uploadError } = await supabase.storage.from("client-documents").upload(filePath, file)

    if (uploadError) {
      return { success: false, error: uploadError.message }
    }

    // Signed URL — client-documents is a PRIVATE bucket (m278); getPublicUrl 403s.
    const { signedDocUrl } = await import("@/lib/storage/signed-doc-url")
    const avatarUrl = await signedDocUrl(supabase, "client-documents", filePath)

    // Update contact with new avatar URL
    const { error: updateError } = await supabase
      .from("contacts")
      .update({ avatar_url: avatarUrl })
      .eq("id", contactId)

    if (updateError) {
      return { success: false, error: updateError.message }
    }

    revalidatePath(`/portal/${contactId}`)
    revalidatePath(`/portal/${contactId}/settings`)

    return { success: true, url: avatarUrl }
  } catch (error) {
    console.error("Error uploading profile photo:", error)
    return { success: false, error: "Failed to upload photo" }
  }
}

/**
 * The client portal's two privacy obligations — Request Data Export and Delete
 * Account — filed into the DSAR system that already exists.
 *
 * BOTH BUTTONS WERE INERT. On PortalSettingsPage they rendered with no onClick,
 * no confirm, no form: a destructive-styled "Delete Account" and a "Request Data
 * Export" that a client could press forever with nothing happening. These are
 * not ordinary features — they are CCPA/CPRA and GDPR obligations with a
 * statutory clock, and a control that silently does nothing is worse than no
 * control, because the client believes they have exercised a right.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: delete anything. The repo already has a
 * complete data-subject-request system — scripts/1064-data-subject-requests.sql
 * (with a trigger setting due_at to received_at + 45 days), the admin queue at
 * /dashboard/admin/privacy/requests, identity verification, and
 * fulfillExportRequestAction / fulfillDeleteRequestAction which perform the real
 * export bundle and the 40-column PII redaction in lib/privacy/
 * contact-pii-redaction.ts. Erasure is a governed, audited act with a human in
 * the loop. The portal's job is to FILE the request and start the clock.
 *
 * This replaces deletePortalAccount(), which was an orphan with zero callers and
 * would have been actively harmful if wired: it nulled 5 fields instead of 40+,
 * created no DSAR row so no statutory clock ever started, had no auth beyond
 * RLS, and nulled contacts.email — which is the key fulfillDeleteRequestAction
 * looks the subject up by, so it would have broken the compliant path it was
 * imitating.
 */
export async function fileDataSubjectRequestFromPortal(params: {
  contactId: string
  requestType: "export" | "delete"
}): Promise<{ success: boolean; requestId?: string; dueDate?: string; error?: string }> {
  const { requireContactAccess } = await import("@/lib/portal/require-contact-access")
  const access = await requireContactAccess(params.contactId)

  // Staff must not be able to file an erasure request "as" a client from the
  // client's own settings screen — this is a self-service right.
  if (!access.ok || !access.isContactSelf) {
    return { success: false, error: "Only the account holder can make this request." }
  }

  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()

  const { data: contact } = await svc
    .from("contacts")
    .select("email, first_name, last_name, phone, contact_user_id")
    .eq("id", params.contactId)
    .maybeSingle()

  // subject_email is NOT NULL and is how the fulfilment side finds the subject.
  if (!contact?.email) {
    return {
      success: false,
      error: "Your account has no email address on file, which is how we verify and fulfil this request. Add one in Profile first, or contact your agent.",
    }
  }

  const { data: row, error } = await svc
    .from("data_subject_requests")
    .insert({
      request_type: params.requestType,
      subject_email: contact.email,
      subject_phone: contact.phone ?? null,
      subject_name: [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim() || null,
      subject_contact_id: params.contactId,
      subject_user_id: contact.contact_user_id ?? null,
      brokerage_id: access.brokerageId,
      // The portal session IS the identity check the statute asks for: this
      // person authenticated as the subject, which is stronger evidence than
      // the anonymous public form gets.
      identity_verified: true,
      identity_verified_at: new Date().toISOString(),
      identity_method: "matching_user",
      status: "received",
      // source CHECK is web_form|email|phone|postal|api — "portal" would be
      // rejected outright, which is exactly the class of bug this sweep keeps
      // finding. The portal is a web form.
      source: "web_form",
      notes: "Filed by the account holder from their client portal.",
    })
    .select("id, due_at")
    .single()

  if (error) return { success: false, error: error.message }

  // Best-effort only — a notification failure must never lose a filed request.
  try {
    const { data: staff } = await svc
      .from("users")
      .select("id")
      .eq("brokerage_id", access.brokerageId)
      .in("user_type", ["admin", "broker", "broker_owner", "superadmin"])
      .limit(5)

    for (const u of (staff ?? []) as Array<{ id: string }>) {
      await svc.from("notifications").insert({
        user_id: u.id,
        brokerage_id: access.brokerageId,
        type: "data_subject_request_received",
        title: params.requestType === "delete"
          ? "🔒 A client requested account deletion"
          : "🔒 A client requested a copy of their data",
        body: `${contact.email} filed a ${params.requestType} request from their portal. It is due by ${row?.due_at ? new Date(row.due_at).toLocaleDateString() : "the statutory deadline"}. Action it in Admin → Privacy → Requests.`,
        entity_type: "contact",
        entity_id: params.contactId,
        priority: "high",
        is_read: false,
      }).then(() => {}, () => {})
    }

    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    await publishManagerSignal({
      brokerageId: access.brokerageId,
      fromManager: "data_steward",
      toManager: "compliance_officer",
      signalType: "dsar_filed",
      entityType: "contact",
      entityId: params.contactId,
      contactId: params.contactId,
      message: `A ${params.requestType} request was filed from the client portal and is on the statutory clock.`,
      payload: { request_id: row?.id, request_type: params.requestType, due_at: row?.due_at },
    }, svc).then(() => {}, () => {})
  } catch { /* the request is filed; surfacing it is best-effort */ }

  return { success: true, requestId: row?.id, dueDate: row?.due_at ?? undefined }
}
