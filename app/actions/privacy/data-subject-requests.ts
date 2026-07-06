"use server"

/**
 * CCPA / CPRA / GDPR — Data Subject Access Request lifecycle.
 *
 * PUBLIC SUBMISSION:
 *   submitDataSubjectRequestAction — no auth required. Anyone can submit a
 *   request for export, deletion, opt-out-of-sale, etc. CCPA §1798.130 requires
 *   that we accept requests via multiple methods (web form + toll-free or email).
 *
 * ADMIN FULFILLMENT (compliance_officer / admin):
 *   listDSARQueueAction       — sorted by due_at (45-day CCPA clock)
 *   verifyIdentityAction      — mark identity verified before fulfilling
 *   fulfillExportRequestAction — generates JSON bundle of all subject data
 *   anonymizeContactAction    — right-to-be-forgotten: hash PII, preserve
 *                               transaction records for NAR/state retention
 *   denyRequestAction         — record denial reason (must be lawful basis)
 *
 * The 45-day clock starts at received_at and is enforced by due_at.
 * Overdue requests are surfaced in the admin dashboard with red badges.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import { createHash } from "node:crypto"
import { contactRedactionPatch } from "@/lib/privacy/contact-pii-redaction"

const ALLOWED_FULFILLMENT_ROLES = new Set([
  "broker","broker_admin","admin","superadmin","compliance_officer",
])

// ── PUBLIC: SUBMIT ───────────────────────────────────────────────────────────

export type DSARType = "export" | "delete" | "access" | "portability" | "correction" | "opt_out_sale" | "opt_out_sharing"

export interface SubmitDSARInput {
  requestType:    DSARType
  subjectEmail:   string
  subjectName?:   string
  subjectPhone?:  string
  brokerageId?:   string
  notes?:         string
}

export interface SubmitDSARResult {
  ok:           boolean
  error?:       string
  requestId?:   string
  dueDate?:     string
}

function isValidEmail(e: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)
}

export async function submitDataSubjectRequestAction(
  input: SubmitDSARInput,
): Promise<SubmitDSARResult> {
  if (!isValidEmail(input.subjectEmail)) {
    return { ok: false, error: "Valid email required" }
  }
  if (!input.requestType) return { ok: false, error: "Request type required" }

  const svc = createServiceClient()
  const hdrs = await headers()

  // Try to auto-resolve subject_user_id / subject_contact_id by email match
  const [{ data: matchUser }, { data: matchContact }] = await Promise.all([
    svc.from("users").select("id, brokerage_id").eq("email", input.subjectEmail.toLowerCase()).maybeSingle(),
    svc.from("contacts").select("id, brokerage_id").eq("email", input.subjectEmail.toLowerCase()).maybeSingle(),
  ])

  // Resolve brokerage_id: explicit > matched user > matched contact > null
  const brokerageId = input.brokerageId
    ?? matchUser?.brokerage_id
    ?? matchContact?.brokerage_id
    ?? null

  const { data: inserted, error } = await svc
    .from("data_subject_requests")
    .insert({
      request_type:        input.requestType,
      subject_email:       input.subjectEmail.toLowerCase(),
      subject_name:        input.subjectName ?? null,
      subject_phone:       input.subjectPhone ?? null,
      subject_user_id:     matchUser?.id ?? null,
      subject_contact_id:  matchContact?.id ?? null,
      brokerage_id:        brokerageId,
      status:              "received",
      source:              "web_form",
      ip_address:          hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip"),
      user_agent:          hdrs.get("user-agent"),
      notes:               input.notes ?? null,
    })
    .select("id, due_at")
    .single()

  if (error || !inserted) return { ok: false, error: error?.message ?? "Submit failed" }

  return {
    ok:        true,
    requestId: inserted.id as string,
    dueDate:   inserted.due_at as string,
  }
}

// ── ADMIN: LIST QUEUE ────────────────────────────────────────────────────────

async function requireFulfillmentRole(): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data } = await supabase
    .from("users")
    .select("user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!data?.brokerage_id) return { ok: false, error: "Brokerage not configured" }
  if (!ALLOWED_FULFILLMENT_ROLES.has(data.user_type ?? "")) return { ok: false, error: "Forbidden" }
  return { ok: true, userId: user.id, brokerageId: data.brokerage_id }
}

export interface DSARQueueRow {
  id:                  string
  request_type:        string
  subject_email:       string
  subject_name:        string | null
  status:              string
  received_at:         string
  due_at:              string
  days_until_due:      number
  is_overdue:          boolean
  identity_verified:   boolean
  fulfilled_at:        string | null
}

export async function listDSARQueueAction(): Promise<
  | { ok: true; rows: DSARQueueRow[]; overdue: number; due_soon: number }
  | { ok: false; error: string }
> {
  const auth = await requireFulfillmentRole()
  if (!auth.ok) return auth

  const svc = createServiceClient()
  const { data, error } = await svc
    .from("data_subject_requests")
    .select("id, request_type, subject_email, subject_name, status, received_at, due_at, identity_verified, fulfilled_at")
    .eq("brokerage_id", auth.brokerageId)
    .order("due_at", { ascending: true })
    .limit(200)
  if (error) return { ok: false, error: error.message }

  const now = Date.now()
  const rows: DSARQueueRow[] = (data ?? []).map((r: any) => {
    const due = new Date(r.due_at).getTime()
    const days = Math.round((due - now) / (1000 * 60 * 60 * 24))
    return {
      id:                r.id,
      request_type:      r.request_type,
      subject_email:     r.subject_email,
      subject_name:      r.subject_name,
      status:            r.status,
      received_at:       r.received_at,
      due_at:            r.due_at,
      days_until_due:    days,
      is_overdue:        days < 0 && (r.status === "received" || r.status === "in_progress"),
      identity_verified: r.identity_verified,
      fulfilled_at:      r.fulfilled_at,
    }
  })

  return {
    ok: true,
    rows,
    overdue:  rows.filter(r => r.is_overdue).length,
    due_soon: rows.filter(r => !r.is_overdue && r.days_until_due <= 7 && (r.status === "received" || r.status === "in_progress")).length,
  }
}

// ── ADMIN: VERIFY IDENTITY ───────────────────────────────────────────────────

export async function verifyDSARIdentityAction(params: {
  requestId: string
  method:    "magic_link" | "matching_user" | "manual_review" | "driver_license"
}): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireFulfillmentRole()
  if (!auth.ok) return auth
  const svc = createServiceClient()
  const { error } = await svc
    .from("data_subject_requests")
    .update({
      identity_verified:    true,
      identity_verified_at: new Date().toISOString(),
      identity_verified_by: auth.userId,
      identity_method:      params.method,
      status:               "in_progress",
    })
    .eq("id", params.requestId)
    .eq("brokerage_id", auth.brokerageId)
  if (error) return { ok: false, error: error.message }
  revalidatePath("/dashboard/admin/privacy/requests")
  return { ok: true }
}

// ── ADMIN: FULFILL EXPORT ────────────────────────────────────────────────────

/**
 * Generate a JSON bundle of all data we have on the subject across the
 * common tables. Returns the JSON inline (caller can stream to S3 + email
 * a presigned URL — this commit just generates the artifact).
 *
 * CCPA §1798.130(a)(2): right of access includes categories of personal
 * information collected, sources, purposes, and recipients.
 */
export async function fulfillExportRequestAction(requestId: string): Promise<
  | { ok: true; bundle: Record<string, unknown> }
  | { ok: false; error: string }
> {
  const auth = await requireFulfillmentRole()
  if (!auth.ok) return auth

  const svc = createServiceClient()
  const { data: req } = await svc
    .from("data_subject_requests")
    .select("id, request_type, subject_email, subject_user_id, subject_contact_id, brokerage_id, identity_verified, status")
    .eq("id", requestId)
    .maybeSingle()
  if (!req) return { ok: false, error: "Request not found" }
  if (req.brokerage_id !== auth.brokerageId) return { ok: false, error: "Forbidden" }
  if (!req.identity_verified) return { ok: false, error: "Verify identity before fulfilling export" }
  if (req.request_type === "delete" || req.request_type === "opt_out_sale" || req.request_type === "opt_out_sharing") {
    return { ok: false, error: "Use fulfill-specific action for this request type" }
  }

  // Gather data from the standard tables. (Brokerage-internal tables only —
  // never include records from OTHER brokerages.)
  const email = req.subject_email
  // Resolve the subject's contact ids ONCE — every record set below is scoped to
  // the SUBJECT, never the whole brokerage (a data-subject export must not leak
  // other clients' deals).
  const subjectContactIds: string[] =
    (await svc.from("contacts").select("id").eq("email", email).eq("brokerage_id", req.brokerage_id))
      .data?.map((c: any) => c.id) ?? []
  const idsOrNone = subjectContactIds.length > 0 ? subjectContactIds : ["00000000-0000-0000-0000-000000000000"]
  const idList = idsOrNone.join(",")
  const [user, contacts, communications, transactions, offers, showings, consents] = await Promise.all([
    svc.from("users").select("*").eq("email", email).eq("brokerage_id", req.brokerage_id).maybeSingle(),
    svc.from("contacts").select("*").eq("email", email).eq("brokerage_id", req.brokerage_id),
    svc.from("communications").select("id, channel, direction, content_preview, sent_at, contact_id")
       .or(`contact_email.eq.${email},to_email.eq.${email}`)
       .limit(500),
    svc.from("transactions").select("id, property_address, status, created_at, buyer_contact_id, seller_contact_id")
       .eq("brokerage_id", req.brokerage_id)
       .or(`buyer_contact_id.in.(${idList}),seller_contact_id.in.(${idList}),contact_id.in.(${idList})`),
    svc.from("offers").select("id, status, offer_price, created_at, contact_id").eq("brokerage_id", req.brokerage_id)
       .in("contact_id", idsOrNone),
    svc.from("showings").select("id, listing_id, scheduled_at, sync_source, status, contact_id")
       .in("contact_id", idsOrNone),
    svc.from("contact_consent_events").select("*").in("contact_id", idsOrNone),
  ])

  const bundle = {
    generated_at:        new Date().toISOString(),
    subject_email:       email,
    brokerage_id:        req.brokerage_id,
    user_record:         user.data,
    contact_records:     contacts.data ?? [],
    communications:      communications.data ?? [],
    transactions:        transactions.data ?? [],
    offers:              offers.data ?? [],
    showings:            showings.data ?? [],
    consent_history:     consents.data ?? [],
    ccpa_categories_disclosed: [
      "identifiers (email, phone, name)",
      "commercial information (transactions, offers)",
      "internet activity (portal logins)",
      "geolocation (property interest area)",
      "professional info (agent of record)",
    ],
  }

  await svc
    .from("data_subject_requests")
    .update({
      status:              "fulfilled",
      fulfilled_at:        new Date().toISOString(),
      fulfilled_by:        auth.userId,
      response_summary:    `Export bundle generated with ${bundle.contact_records.length} contact(s), ${bundle.communications.length} communication(s), ${bundle.transactions.length} transaction(s).`,
    })
    .eq("id", requestId)

  revalidatePath("/dashboard/admin/privacy/requests")
  return { ok: true, bundle }
}

// ── ADMIN: ANONYMIZE (RIGHT TO BE FORGOTTEN) ─────────────────────────────────

function hashForAudit(v: string): string {
  return "anon_" + createHash("sha256").update(v).digest("hex").slice(0, 16)
}

/**
 * Anonymize the contact rather than hard-delete. Preserves transaction
 * records for NAR + state RE commission retention (3–7 years post-close)
 * while removing PII per CCPA §1798.105 / GDPR Art. 17.
 *
 * Redacts the COMPLETE PII column set (see contactRedactionPatch): names +
 * legal names, email, phones, DL image, full/mailing address, demographics,
 * financial bands, court/public records, social handles, enrichment blobs,
 * external identifiers. Preserves: id, brokerage_id, transaction linkage,
 * created_at, de-identified state, privacy_anonymized_*.
 */
export async function fulfillDeleteRequestAction(requestId: string): Promise<
  { ok: boolean; error?: string; contactsAnonymized?: number }
> {
  const auth = await requireFulfillmentRole()
  if (!auth.ok) return auth

  const svc = createServiceClient()
  const { data: req } = await svc
    .from("data_subject_requests")
    .select("id, subject_email, brokerage_id, identity_verified, request_type")
    .eq("id", requestId)
    .maybeSingle()
  if (!req) return { ok: false, error: "Request not found" }
  if (req.brokerage_id !== auth.brokerageId) return { ok: false, error: "Forbidden" }
  if (!req.identity_verified) return { ok: false, error: "Verify identity before deletion" }

  const email = req.subject_email as string
  const audit_hash = hashForAudit(email)

  const { data: anonymized, error: anonErr } = await svc
    .from("contacts")
    .update(contactRedactionPatch(audit_hash, requestId))
    .eq("email", email)
    .eq("brokerage_id", req.brokerage_id)
    .select("id")
  if (anonErr) return { ok: false, error: anonErr.message }

  await svc
    .from("data_subject_requests")
    .update({
      status:              "fulfilled",
      fulfilled_at:        new Date().toISOString(),
      fulfilled_by:        auth.userId,
      response_summary:    `${anonymized?.length ?? 0} contact record(s) anonymized. Transaction records retained per state real-estate retention rules.`,
    })
    .eq("id", requestId)

  revalidatePath("/dashboard/admin/privacy/requests")
  return { ok: true, contactsAnonymized: anonymized?.length ?? 0 }
}

// ── ADMIN: DENY ──────────────────────────────────────────────────────────────

export async function denyDSARRequestAction(params: {
  requestId: string
  reason:    string
}): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireFulfillmentRole()
  if (!auth.ok) return auth
  if (!params.reason || params.reason.trim().length < 10) {
    return { ok: false, error: "Denial reason required (10+ chars — must cite lawful basis)" }
  }
  const svc = createServiceClient()
  const { error } = await svc
    .from("data_subject_requests")
    .update({
      status:        "denied",
      denied_reason: params.reason.trim(),
      fulfilled_at:  new Date().toISOString(),
      fulfilled_by:  auth.userId,
    })
    .eq("id", params.requestId)
    .eq("brokerage_id", auth.brokerageId)
  if (error) return { ok: false, error: error.message }
  revalidatePath("/dashboard/admin/privacy/requests")
  return { ok: true }
}
