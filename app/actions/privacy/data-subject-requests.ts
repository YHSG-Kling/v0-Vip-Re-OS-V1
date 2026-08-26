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

/**
 * Column names that carry AUTHENTICATION material rather than personal data, and
 * so must never ride out in an export bundle. Owner ruling (finding #294): "no
 * credentials should be listed in csv" — ruled on the expense CSV, applied here
 * because this bundle is an export too and leaves the building the same way.
 *
 * A DENYLIST on the way out, not an allowlist on the way in: a data-subject
 * export is a legal completeness obligation, so a new column must reach the
 * subject by default. See fulfillExportRequestAction for the measurement that
 * made this live rather than theoretical.
 *
 * Deliberately NOT matched: `*_url` columns (personal_website_url, the social
 * handles, avatar_url) — those are the subject's own published links and ARE
 * their personal data. If a storage signed URL is ever added to a table read
 * here, add it by NAME; a blanket url match would gut the bundle.
 */
const EXPORT_SECRET_COLUMN =
  /(password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|credential|_hash$|^hash$|otp|mfa|totp)/i

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

  // ── THE AUDIT RECORD (built 2026-08-26, orphan doctrine §1.2) ─────────────
  //
  // Eleven columns on data_subject_requests were WRITTEN and read by NOBODY:
  // identity_method, identity_verified_at, identity_verified_by, fulfilled_by,
  // response_summary, denied_reason, source, ip_address, user_agent,
  // subject_phone and notes. The queue reader below selected nine summary
  // fields and stopped, so the record of HOW a statutory request was handled —
  // who checked identity and by what method, what was actually delivered, who
  // signed it off, why it was refused — could be written and never read back.
  //
  // That is not a tidiness problem. The comment at DSAR_IDENTITY_METHODS below
  // already says the vocabulary is enforced in code because otherwise a typo
  // becomes "a permanent, unreviewable audit record of how a legal identity
  // check was performed" — and unreviewable is exactly what it was, because
  // nothing reviewed it. A brokerage answering a regulator about a CCPA/GDPR
  // response had the facts in the table and no way to show them.
  //
  // No duplicate reader exists anywhere in the tree, so §1.2 applies: BUILD the
  // missing half. It is added to the EXISTING queue reader rather than a new
  // detail action — one query, one round trip, no new module in the compile
  // graph (§8), and the audit line renders under the row it belongs to.
  //
  // ip_address / user_agent are the requester's own intake provenance and are
  // shown only to the fulfilment roles that already see their email and phone
  // on this same row, inside the same tenant predicate. They are the evidence
  // that the request came from where it claims to have come from.

  /** How identity was proved: magic_link | matching_user | manual_review | driver_license. */
  identity_method:      string | null
  identity_verified_at: string | null
  /** users.id of the staff member who accepted the identity proof. */
  identity_verified_by: string | null
  identity_verified_by_name: string | null
  /** users.id of whoever fulfilled it. */
  fulfilled_by:         string | null
  fulfilled_by_name:    string | null
  /** What was actually delivered to the subject. */
  response_summary:     string | null
  /** Why it was refused — the half a denial is meaningless without. */
  denied_reason:        string | null
  /** Intake channel: web_form | email | phone | postal | api (live CHECK). */
  source:               string | null
  subject_phone:        string | null
  ip_address:           string | null
  user_agent:           string | null
  notes:                string | null
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
    .select(
      "id, request_type, subject_email, subject_name, status, received_at, due_at, identity_verified, fulfilled_at, " +
      // The audit half — see the note on DSARQueueRow above.
      "identity_method, identity_verified_at, identity_verified_by, fulfilled_by, response_summary, denied_reason, " +
      "source, subject_phone, ip_address, user_agent, notes",
    )
    .eq("brokerage_id", auth.brokerageId)
    .order("due_at", { ascending: true })
    .limit(200)
  if (error) return { ok: false, error: error.message }

  // Resolve the two staff ids to names in ONE bounded lookup. A failure here
  // leaves the NAME null and keeps the ID — the audit record must still show
  // who acted even when we cannot pretty-print them, so a refused name lookup
  // degrades the display and never the evidence.
  const staffIds = [...new Set(
    (data ?? []).flatMap((r: any) => [r.identity_verified_by, r.fulfilled_by]).filter(Boolean) as string[],
  )]
  const staffName = new Map<string, string>()
  if (staffIds.length > 0) {
    const { data: staff, error: staffError } = await svc
      .from("users")
      .select("id, first_name, last_name, email")
      .in("id", staffIds)
    if (staffError) {
      console.error("[dsar-queue] staff name lookup refused:", staffError.message)
    } else {
      for (const u of staff ?? []) {
        const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim()
        staffName.set(u.id as string, name || (u.email as string | null) || (u.id as string))
      }
    }
  }

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

      identity_method:           r.identity_method ?? null,
      identity_verified_at:      r.identity_verified_at ?? null,
      identity_verified_by:      r.identity_verified_by ?? null,
      identity_verified_by_name: r.identity_verified_by ? (staffName.get(r.identity_verified_by) ?? null) : null,
      fulfilled_by:              r.fulfilled_by ?? null,
      fulfilled_by_name:         r.fulfilled_by ? (staffName.get(r.fulfilled_by) ?? null) : null,
      response_summary:          r.response_summary ?? null,
      denied_reason:             r.denied_reason ?? null,
      source:                    r.source ?? null,
      subject_phone:             r.subject_phone ?? null,
      ip_address:                r.ip_address == null ? null : String(r.ip_address),
      user_agent:                r.user_agent ?? null,
      notes:                     r.notes ?? null,
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

/** The identity-proof methods this action accepts. The column carries no CHECK
 *  constraint (verified against the live schema), so the vocabulary is enforced
 *  HERE — otherwise a typo becomes a permanent, unreviewable audit record of how
 *  a legal identity check was performed. */
const DSAR_IDENTITY_METHODS = ["magic_link", "matching_user", "manual_review", "driver_license"] as const
export type DSARIdentityMethod = (typeof DSAR_IDENTITY_METHODS)[number]

/** Statuses from which a request may still be worked. 'fulfilled'/'denied'/
 *  'withdrawn'/'expired' are terminal — verifying identity on a closed request
 *  would rewrite the record of a legal response after the fact. */
const DSAR_OPEN_STATUSES = ["received", "in_progress"] as const

export async function verifyDSARIdentityAction(params: {
  requestId: string
  method:    DSARIdentityMethod
}): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireFulfillmentRole()
  if (!auth.ok) return auth
  if (!(DSAR_IDENTITY_METHODS as readonly string[]).includes(params.method)) {
    return { ok: false, error: `Unknown identity method — must be one of: ${DSAR_IDENTITY_METHODS.join(", ")}` }
  }
  const svc = createServiceClient()

  // An UPDATE that matches nothing SUCCEEDS in postgrest. brokerage_id on this
  // table is NULLABLE (a public submission we could not attribute lands with
  // NULL), so `.eq("brokerage_id", ...)` silently matches zero rows for exactly
  // the requests most likely to be mis-clicked. count:"exact" turns that into a
  // refusal instead of a green toast over an unverified subject.
  const { error, count } = await svc
    .from("data_subject_requests")
    .update({
      identity_verified:    true,
      identity_verified_at: new Date().toISOString(),
      identity_verified_by: auth.userId,
      identity_method:      params.method,
      status:               "in_progress",
    }, { count: "exact" })
    .eq("id", params.requestId)
    .eq("brokerage_id", auth.brokerageId)
    .in("status", [...DSAR_OPEN_STATUSES])
  if (error) return { ok: false, error: error.message }
  if ((count ?? 0) === 0) {
    return { ok: false, error: "No open request matched — it may belong to another brokerage, be unattributed, or already be closed. Nothing was verified." }
  }

  await svc.from("audit_log").insert({
    after:       { brokerage_id: auth.brokerageId, request_id: params.requestId, identity_method: params.method, verified_by: auth.userId },
    user_id:     auth.userId,
    action:      "dsar.identity_verified",
    entity_type: "data_subject_request",
    entity_id:   params.requestId,
  })

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
  const { data: req, error: reqErr } = await svc
    .from("data_subject_requests")
    .select("id, request_type, subject_email, subject_user_id, subject_contact_id, brokerage_id, identity_verified, status")
    .eq("id", requestId)
    .maybeSingle()
  if (reqErr) return { ok: false, error: reqErr.message }
  if (!req) return { ok: false, error: "Request not found" }
  if (req.brokerage_id !== auth.brokerageId) return { ok: false, error: "Forbidden" }
  // IDENTITY GATES THE EXPORT. This branch must stay ABOVE every read below —
  // an export that runs before verification hands a stranger another person's
  // file, which is the failure mode this whole lifecycle exists to prevent.
  if (!req.identity_verified) return { ok: false, error: "Verify identity before fulfilling export" }
  if (req.status === "denied" || req.status === "withdrawn" || req.status === "expired") {
    return { ok: false, error: `This request is ${req.status} — reopen it before exporting.` }
  }
  if (req.request_type === "delete" || req.request_type === "opt_out_sale" || req.request_type === "opt_out_sharing") {
    return { ok: false, error: "Use fulfill-specific action for this request type" }
  }

  // Gather data from the standard tables. (Brokerage-internal tables only —
  // never include records from OTHER brokerages.)
  const email = req.subject_email
  // Resolve the subject's contact ids ONCE — every record set below is scoped to
  // the SUBJECT, never the whole brokerage (a data-subject export must not leak
  // other clients' deals).
  // Every read below is DESTRUCTURED for `error`. supabase-js RESOLVES a refused
  // query, so `data ?? []` renders an RLS/permission denial as "we hold nothing
  // on you" — the single most dangerous shape a legal export can take. Any
  // failed source aborts the export rather than shipping a silently short bundle.
  const failedSources: string[] = []
  const noteFailure = (label: string, err: { message: string } | null) => {
    if (err) failedSources.push(`${label}: ${err.message}`)
  }

  const contactIdsRes = await svc.from("contacts").select("id").eq("email", email).eq("brokerage_id", req.brokerage_id)
  noteFailure("contacts(id)", contactIdsRes.error)
  const subjectContactIds: string[] = contactIdsRes.data?.map((c: any) => c.id) ?? []
  const idsOrNone = subjectContactIds.length > 0 ? subjectContactIds : ["00000000-0000-0000-0000-000000000000"]
  const idList = idsOrNone.join(",")
  // communications was a writer-less legacy table (burn-down round 6 repoint) — export the WRITTEN
  // stores instead: messages (contact-scoped) + isa_outreach_log (lead-scoped; leads.contact_id).
  const leadIdsRes = await svc.from("leads").select("id").in("contact_id", idsOrNone)
  noteFailure("leads(id)", leadIdsRes.error)
  const subjectLeadIds: string[] = leadIdsRes.data?.map((l: any) => l.id) ?? []
  const leadIdsOrNone = subjectLeadIds.length > 0 ? subjectLeadIds : ["00000000-0000-0000-0000-000000000000"]
  const [user, contacts, messages, isaOutreach, transactions, offers, showings, consents] = await Promise.all([
    svc.from("users").select("*").eq("email", email).eq("brokerage_id", req.brokerage_id).maybeSingle(),
    svc.from("contacts").select("*").eq("email", email).eq("brokerage_id", req.brokerage_id),
    svc.from("messages").select("id, type, direction, subject, body, status, created_at, contact_id")
       .in("contact_id", idsOrNone)
       .limit(500),
    svc.from("isa_outreach_log").select("id, channel, subject, body_snippet, status, sent_at, created_at, lead_id")
       .in("lead_id", leadIdsOrNone)
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

  noteFailure("users", user.error)
  noteFailure("contacts", contacts.error)
  noteFailure("messages", messages.error)
  noteFailure("isa_outreach_log", isaOutreach.error)
  noteFailure("transactions", transactions.error)
  noteFailure("offers", offers.error)
  noteFailure("showings", showings.error)
  noteFailure("contact_consent_events", consents.error)
  if (failedSources.length > 0) {
    return {
      ok: false,
      error: `Export aborted — ${failedSources.length} data source(s) could not be read, so the bundle would be incomplete: ${failedSources.join("; ")}`,
    }
  }

  // NO CREDENTIAL LEAVES IN AN EXPORT — owner ruling (finding #294), verbatim:
  // "294 no credentials should be listed in csv." Ruled on the expense CSV; it is
  // a rule about EXPORTS, and this bundle is the largest export in the tree.
  //
  // The two `select("*")` reads above are deliberate and stay: a data-subject
  // export is a LEGAL completeness obligation, so a column added tomorrow must
  // reach the subject without anyone remembering to widen an allowlist. That is
  // exactly why the credential filter is a DENYLIST applied on the way OUT rather
  // than an allowlist applied on the way in — completeness by default, secrets
  // never.
  //
  // MEASURED live 2026-08-22 against hrvaqgvukzxfskkcrwbt: `users.password_hash`
  // exists and 1 of 23 rows carries one, so this was reachable, not theoretical.
  // A password hash is not a bearer credential — it cannot be replayed at a login
  // form — but it is offline-crackable credential material, and it has no business
  // in a file handed to a requester over email. WHAT A READER SHOULD USE INSTEAD:
  // nothing; authentication material is not personal data the subject is owed, and
  // its absence is stated in the bundle rather than left as a silent hole.
  const redactedColumns: string[] = []
  const stripSecrets = <T extends Record<string, unknown> | null>(row: T): T => {
    if (!row) return row
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(row)) {
      if (EXPORT_SECRET_COLUMN.test(k)) { redactedColumns.push(k); continue }
      out[k] = v
    }
    return out as T
  }

  const bundle = {
    generated_at:        new Date().toISOString(),
    subject_email:       email,
    brokerage_id:        req.brokerage_id,
    user_record:         stripSecrets(user.data as Record<string, unknown> | null),
    contact_records:     (contacts.data ?? []).map((c: any) => stripSecrets(c)),
    // Named, not silent: a bundle that quietly drops a column is indistinguishable
    // from a bundle whose source was refused, and this file already refuses to ship
    // a silently short export.
    redacted_columns:    Array.from(new Set(redactedColumns)),
    communications:      [
      ...(messages.data ?? []).map((m: any) => ({ source: "messages", ...m })),
      ...(isaOutreach.data ?? []).map((o: any) => ({ source: "isa_outreach_log", ...o })),
    ],
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

  const summary = `Export bundle generated with ${bundle.contact_records.length} contact(s), ${bundle.communications.length} communication(s), ${bundle.transactions.length} transaction(s).`
  const { error: closeErr, count: closeCount } = await svc
    .from("data_subject_requests")
    .update({
      status:              "fulfilled",
      fulfilled_at:        new Date().toISOString(),
      fulfilled_by:        auth.userId,
      response_summary:    summary,
    }, { count: "exact" })
    .eq("id", requestId)
    .eq("brokerage_id", auth.brokerageId)
  if (closeErr) return { ok: false, error: `Bundle built but the request could not be closed out: ${closeErr.message}` }
  if ((closeCount ?? 0) === 0) {
    return { ok: false, error: "Bundle built but no request row was closed out — refusing to report a fulfilled request that is still open." }
  }

  // The 45-day clock's answer is a legal event. audit_log is the platform's
  // existing ledger (already the record for billing overrides and retention
  // acceptances) — write there rather than standing up a parallel privacy log.
  await svc.from("audit_log").insert({
    after:       { brokerage_id: auth.brokerageId, request_id: requestId, subject_email: email, summary, contact_records: bundle.contact_records.length, communications: bundle.communications.length, transactions: bundle.transactions.length },
    user_id:     auth.userId,
    action:      "dsar.export_fulfilled",
    entity_type: "data_subject_request",
    entity_id:   requestId,
  })

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
  // Same zero-match trap as verify: refusing a legal request that was never
  // actually marked denied is the worst possible combination — the subject is
  // told no, the record still shows the clock running.
  const { error, count } = await svc
    .from("data_subject_requests")
    .update({
      status:        "denied",
      denied_reason: params.reason.trim(),
      fulfilled_at:  new Date().toISOString(),
      fulfilled_by:  auth.userId,
    }, { count: "exact" })
    .eq("id", params.requestId)
    .eq("brokerage_id", auth.brokerageId)
    .in("status", [...DSAR_OPEN_STATUSES])
  if (error) return { ok: false, error: error.message }
  if ((count ?? 0) === 0) {
    return { ok: false, error: "No open request matched — it may belong to another brokerage, be unattributed, or already be closed. Nothing was denied." }
  }

  await svc.from("audit_log").insert({
    after:       { brokerage_id: auth.brokerageId, request_id: params.requestId, denied_reason: params.reason.trim(), denied_by: auth.userId },
    user_id:     auth.userId,
    action:      "dsar.request_denied",
    entity_type: "data_subject_request",
    entity_id:   params.requestId,
  })

  revalidatePath("/dashboard/admin/privacy/requests")
  return { ok: true }
}
