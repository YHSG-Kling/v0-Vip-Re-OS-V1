// lib/kernel/document-custody.ts
//
// THE DOCUMENT STORAGE CUSTODY LAYER — compliance-grade custody for the
// `client-documents` Supabase Storage bucket. The natural completion of the
// auto-filing + document-audit work: once a document is FILED, custody governs
// HOW it is accessed and HOW LONG it must be kept.
//
// Three honest capabilities, all reusing existing rails (NO new table):
//
//   1. GOVERNED ACCESS — instead of a bare, ungoverned getPublicUrl() (which on a
//      PRIVATE bucket does not even resolve), issueGovernedDocumentUrl mints a
//      TIME-LIMITED createSignedUrl(path, ttl). The bucket
//      `client-documents` is created PRIVATE (scripts/511-create-document-storage-bucket.sql:
//      public=false) — so a signed URL is the CORRECT access primitive, not public.
//
//   2. ACCESS AUDIT — every governed URL mint RECORDS a who/when/why/doc row on the
//      EXISTING `document_access_log` table (verified live: document_id,
//      accessed_by_type, accessed_by_id, accessed_by_email, access_type, ip_address,
//      user_agent, accessed_at). It is RLS-enabled and already the canonical access
//      ledger (app/actions/dotloop-integration.ts logs external share-link views to
//      it). No new audit table is built — this one fits exactly.
//
//   3. RETENTION POLICY — retentionPolicyFor(doc_category) is a DATA map of how long
//      a document type must typically be kept, with an HONEST basis string. These are
//      DEFAULTS reflecting common US real-estate record-retention norms (transaction
//      records 3–7 years, varies by state + brokerage policy) — they are NOT a
//      statement of law for any particular state. runRetentionScan flags documents
//      PAST their retention window for human REVIEW; it NEVER auto-deletes (a gated
//      report, custody of record).
//
// HONEST throughout: a document whose document_url has no parsable in-bucket object
// path (the data: DB-fallback, or an external URL) CANNOT be signed — we return a
// reason, never a fabricated URL and never a fabricated access-log row.
//
// NOT server-only (simulator-driven). Live functions only ever write through a
// caller-supplied / service client — never import a browser client here.

import {
  DOCUMENT_BUCKET,
  parseBucketObjectPath,
  isDocCategory,
  type DocCategory,
} from "./document-autofile"

import type { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

// Re-export the bucket constant so custody callers have one import surface.
export { DOCUMENT_BUCKET, parseBucketObjectPath }

// URL ISSUANCE ONLY. The classification of which buckets may serve a permanent
// unauthenticated URL, and the write-time router that honours it, live in
// lib/storage/document-buckets.ts. They are re-exported here — and NOT
// re-implemented — so "how a document URL is issued" has exactly one spelling
// (CLAUDE.md §6): issueGovernedDocumentUrl below governs a READ of a
// client_documents row (short purpose-scoped TTL + document_access_log row);
// issueBucketObjectUrl governs the URL a WRITER persists after storing bytes.
// Nothing else in this file is touched by that lane.
export {
  isDocumentClassBucket,
  issueBucketObjectUrl,
  DOCUMENT_CLASS_BUCKETS,
  PUBLIC_MEDIA_BUCKETS,
} from "@/lib/storage/document-buckets"

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — PURE retention policy (a DATA map, honest defaults; no I/O)
// ─────────────────────────────────────────────────────────────────────────────

export interface RetentionPolicy {
  /** How many years a document of this category must typically be RETAINED. */
  keepYears: number
  /** HONEST basis — what the default reflects + the "confirm your state" caveat. */
  basis: string
}

/**
 * RETENTION DEFAULTS per canonical doc_category.
 *
 * These are DEFAULTS reflecting common US real-estate record-retention practice
 * (most state RE commissions require transaction/brokerage records be kept ~3–7
 * years; lending/financial docs trend longer). They are a STARTING POINT, not legal
 * advice — every `basis` string says so, and confirm-your-state is the standing
 * caveat. Anything off-enum falls to DEFAULT_RETENTION.
 *
 * The conservative spine: the contract/offer/disclosure documents that make up the
 * legal transaction record get the longer 7-year default; supporting financial
 * verification docs 7 years (mortgage/lending norm); diligence reports 5 years.
 */
export const RETENTION_DEFAULTS: Record<DocCategory, RetentionPolicy> = {
  // ── The legal transaction record — the documents a board/audit asks for first ──
  offer_form:              { keepYears: 7, basis: "Default: executed offers/purchase agreements are the core transaction record; most state RE commissions require ~3–7yr retention. Confirm your state + brokerage policy." },
  contract:                { keepYears: 7, basis: "Default: contracts/addenda are part of the binding transaction record (~3–7yr typical). Confirm your state + brokerage policy." },
  disclosure:              { keepYears: 7, basis: "Default: disclosures carry the longest tail liability; kept with the transaction record (~3–7yr typical, some states longer). Confirm your state." },
  title:                   { keepYears: 7, basis: "Default: title/closing documents (CD, settlement, deed) are kept with the closed-file record (~5–7yr typical). Confirm your state + title company policy." },
  // ── Financial verification — lending/mortgage retention runs longer ──
  pre_approval_letter:     { keepYears: 7, basis: "Default: financing-readiness records aligned to lending retention norms (~7yr). Confirm your lender/state policy." },
  proof_of_funds:          { keepYears: 7, basis: "Default: funds-verification records aligned to lending retention norms (~7yr). Confirm your lender/state policy." },
  bank_statement:          { keepYears: 7, basis: "Default: financial source documents aligned to lending/tax retention norms (~7yr). Confirm your lender/state policy." },
  tax_return:              { keepYears: 7, basis: "Default: tax documents follow the ~7yr financial-records norm. Confirm with a tax/financial advisor." },
  gift_letter:             { keepYears: 7, basis: "Default: gift letters are lending source documents (~7yr). Confirm your lender/state policy." },
  employment_verification: { keepYears: 7, basis: "Default: income/employment verification are lending source documents (~7yr). Confirm your lender/state policy." },
  // ── Diligence reports — supporting record, shorter tail ──
  inspection_report:       { keepYears: 5, basis: "Default: diligence reports kept as supporting transaction record (~5yr typical). Confirm your state + brokerage policy." },
  appraisal:               { keepYears: 5, basis: "Default: appraisals kept as supporting transaction record; lender appraisal retention can be longer (~5yr typical). Confirm your lender/state policy." },
  insurance:               { keepYears: 5, basis: "Default: insurance documents kept with the supporting transaction record (~5yr typical). Confirm your policy/carrier requirements." },
  // ── Unsorted / unknown — the conservative floor ──
  other:                   { keepYears: 7, basis: "Default (conservative): uncategorized documents kept to the longest common transaction-record window (~7yr) until categorized. Confirm your state + brokerage policy." },
}

/** The fallback policy for an unrecognized / null category — conservative 7yr. */
export const DEFAULT_RETENTION: RetentionPolicy = {
  keepYears: 7,
  basis: "Default (conservative fallback): unknown document type kept to the longest common transaction-record window (~7yr). Confirm your state + brokerage policy.",
}

/**
 * retentionPolicyFor — PURE. Maps a doc_category onto its retention DEFAULT.
 * Honest: an unknown/null/off-enum category returns DEFAULT_RETENTION (never throws,
 * never invents a state-specific rule).
 */
export function retentionPolicyFor(docCategory: string | null | undefined): RetentionPolicy {
  if (isDocCategory(docCategory ?? null)) {
    return RETENTION_DEFAULTS[docCategory as DocCategory]
  }
  return DEFAULT_RETENTION
}

/** The minimal doc shape isRetentionExpired needs (subset of a client_documents row). */
export interface RetainableDoc {
  doc_category: string | null
  /** The retention clock starts at upload/creation. */
  created_at: string | null
}

export interface RetentionStatus {
  /** True when now is PAST the retention window (the doc is overdue for review). */
  expired: boolean
  keepYears: number
  basis: string
  /** ISO timestamp the retention window ENDS (created_at + keepYears), or null when
   *  created_at is unparsable (then expired is honestly false — we cannot judge). */
  retainUntil: string | null
  /** Whole days past the window when expired (else 0). */
  daysOverdue: number
}

const MS_PER_DAY = 86_400_000

/**
 * isRetentionExpired — PURE. Is this document PAST its retention window as of `now`?
 *
 * retainUntil = created_at + keepYears. Honest boundary: the day retention ENDS is
 * NOT yet expired (expired only strictly AFTER retainUntil). An unparsable / missing
 * created_at → expired:false, retainUntil:null (we cannot judge what we cannot date —
 * never flag on a fabricated date).
 */
export function isRetentionExpired(doc: RetainableDoc, now: Date = new Date()): RetentionStatus {
  const { keepYears, basis } = retentionPolicyFor(doc.doc_category)

  if (!doc.created_at) {
    return { expired: false, keepYears, basis, retainUntil: null, daysOverdue: 0 }
  }
  const created = new Date(doc.created_at)
  if (Number.isNaN(created.getTime())) {
    return { expired: false, keepYears, basis, retainUntil: null, daysOverdue: 0 }
  }

  // created_at + keepYears (calendar-year accurate, leap-safe via setFullYear).
  const until = new Date(created)
  until.setFullYear(until.getFullYear() + keepYears)

  const expired = now.getTime() > until.getTime()
  const daysOverdue = expired ? Math.floor((now.getTime() - until.getTime()) / MS_PER_DAY) : 0

  return { expired, keepYears, basis, retainUntil: until.toISOString(), daysOverdue }
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — PURE signed-URL TTL policy (purpose → seconds; no I/O)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The governed access PURPOSES. Each maps to a TTL appropriate to the use:
 * a fleeting in-app VIEW is short; a deliberate DOWNLOAD a little longer; a
 * compliance/legal EXPORT longer still (someone is collecting a file on purpose);
 * a system ANALYSIS pass (AI classify/audit reading the object) is short-lived.
 */
export type AccessPurpose = "view" | "download" | "share" | "compliance_export" | "analysis"

/** TTLs in SECONDS, by purpose. Conservative — a signed URL is a time-limited grant,
 *  not a standing public link; shorter is safer. */
const TTL_BY_PURPOSE: Record<AccessPurpose, number> = {
  view:               5 * 60,        // 5 minutes — an in-app preview
  download:           15 * 60,       // 15 minutes — a deliberate save-to-disk
  share:              60 * 60,       // 1 hour — a link handed to a represented party
  compliance_export:  24 * 60 * 60,  // 24 hours — a broker/auditor collecting records
  analysis:           10 * 60,       // 10 minutes — a system OCR/vision read
}

/** The TTL used when a caller passes an unrecognized purpose — the shortest (view). */
export const DEFAULT_TTL_SECONDS = TTL_BY_PURPOSE.view

/**
 * signedUrlTtlFor — PURE. purpose → signed-URL lifetime in SECONDS. Unknown purpose
 * → the shortest safe default (view, 5 min). Never returns 0 or a negative.
 */
export function signedUrlTtlFor(purpose: string | null | undefined): number {
  if (purpose && purpose in TTL_BY_PURPOSE) {
    return TTL_BY_PURPOSE[purpose as AccessPurpose]
  }
  return DEFAULT_TTL_SECONDS
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — LIVE: issue a governed (time-limited, audited) document URL
// ─────────────────────────────────────────────────────────────────────────────

export interface IssueGovernedUrlParams {
  documentId: string
  /** WHO is requesting access — recorded on the audit row (honest provenance). */
  requestedBy: {
    type?: string | null   // 'agent' | 'client' | 'external' | 'system' | …
    id?: string | null     // agent/user/contact id when known
    email?: string | null
    ipAddress?: string | null
    userAgent?: string | null
  }
  /** WHY — drives the TTL and is recorded as the access_type on the audit row. */
  purpose: AccessPurpose
}

export interface IssueGovernedUrlResult {
  ok: boolean
  /** The minted time-limited signed URL (present only when ok). */
  signedUrl?: string
  /** TTL the URL was signed for, in seconds. */
  ttlSeconds?: number
  /** The in-bucket object key that was signed. */
  objectPath?: string
  /** document_access_log.id of the recorded access row (when written). */
  auditId?: string
  /** Honest reason when a URL could NOT be issued (no sign attempted/fabricated). */
  reason?: string
}

/**
 * issueGovernedDocumentUrl — the live custody capstone for ONE access.
 *
 *   1. Load the client_documents row (skip honestly if gone).
 *   2. Resolve the in-bucket object path from document_url (parseBucketObjectPath).
 *      No parsable path (data: DB-fallback / external URL) → cannot sign, return a
 *      reason. NEVER fabricate a URL, NEVER write a misleading access row.
 *   3. Mint a TIME-LIMITED createSignedUrl(path, ttl) where ttl = signedUrlTtlFor(purpose).
 *   4. RECORD a who/when/why/doc row on document_access_log (the existing audit rail).
 *      The audit write is best-effort: a logging hiccup never voids a successfully
 *      minted URL, but a sign FAILURE is reported honestly (no row, no URL).
 *
 * Reuses the autofile bucket constant + path parser — one source of truth for what
 * "an object in our bucket" means.
 */
export async function issueGovernedDocumentUrl(
  params: IssueGovernedUrlParams,
  client?: Svc,
): Promise<IssueGovernedUrlResult> {
  const { documentId, requestedBy, purpose } = params
  const supabase = client ?? (await import("@/lib/supabase/service")).createServiceClient()
  const ttlSeconds = signedUrlTtlFor(purpose)

  // 1. Load the doc.
  const { data: doc } = await supabase
    .from("client_documents")
    .select("id, document_url, document_name")
    .eq("id", documentId)
    .maybeSingle()

  if (!doc) {
    return { ok: false, reason: "document not found", ttlSeconds }
  }
  const row = doc as { id: string; document_url: string | null; document_name: string | null }

  // 2. Resolve the in-bucket object path — honest when there isn't one.
  const objectPath = parseBucketObjectPath(row.document_url)
  if (!objectPath) {
    return {
      ok: false,
      ttlSeconds,
      reason:
        "document_url has no parsable object in the client-documents bucket " +
        "(data: DB-fallback or external URL) — cannot mint a signed URL",
    }
  }

  // 3. Mint the TIME-LIMITED signed URL.
  let signedUrl: string
  try {
    const { data: signed, error } = await (supabase as any).storage
      .from(DOCUMENT_BUCKET)
      .createSignedUrl(objectPath, ttlSeconds)
    if (error || !signed?.signedUrl) {
      return {
        ok: false,
        ttlSeconds,
        objectPath,
        reason: error?.message ?? "createSignedUrl returned no URL",
      }
    }
    signedUrl = signed.signedUrl as string
  } catch (e: any) {
    return { ok: false, ttlSeconds, objectPath, reason: e?.message ?? String(e) }
  }

  // 4. RECORD the access on the existing document_access_log rail (best-effort).
  let auditId: string | undefined
  try {
    const { data: logRow } = await supabase
      .from("document_access_log")
      .insert({
        document_id: documentId,
        accessed_by_type: requestedBy.type ?? "system",
        accessed_by_id: requestedBy.id ?? null,
        accessed_by_email: requestedBy.email ?? null,
        access_type: purpose, // WHY — the governed purpose
        ip_address: requestedBy.ipAddress ?? null,
        user_agent: requestedBy.userAgent ?? null,
      })
      .select("id")
      .maybeSingle()
    auditId = (logRow as { id?: string } | null)?.id
  } catch {
    // The URL is valid; an audit hiccup must not void it. (Reason left unset — the
    // URL succeeded; callers can detect a missing auditId if they require the row.)
  }

  return { ok: true, signedUrl, ttlSeconds, objectPath, auditId }
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — LIVE: retention scan (a GATED report, never an auto-delete)
// ─────────────────────────────────────────────────────────────────────────────

export interface RetentionFlag {
  documentId: string
  documentName: string | null
  docCategory: string | null
  transactionId: string | null
  createdAt: string | null
  keepYears: number
  retainUntil: string | null
  daysOverdue: number
  basis: string
}

export interface RetentionScanResult {
  brokerageId: string
  scanned: number
  /** Documents PAST their retention window — surfaced for human review. */
  overdue: RetentionFlag[]
  errors: string[]
}

/**
 * runRetentionScan — for ONE brokerage, flag every document PAST its retention window
 * for REVIEW. Reads the brokerage's client_documents, applies the pure
 * isRetentionExpired policy to each, and collects the overdue ones with the WHY
 * (category default + basis + days overdue).
 *
 * HONEST + SAFE: this is a REPORT, never a delete. Custody of record means a flagged
 * document is surfaced to a human to decide (archive / purge per the brokerage's own
 * verified policy) — the system never destroys a record on a DEFAULT it admits is not
 * law. Documents with no parsable created_at are simply not flagged (cannot judge).
 */
export async function runRetentionScan(
  brokerageId: string,
  client?: Svc,
  opts: { limit?: number; now?: Date } = {},
): Promise<RetentionScanResult> {
  const supabase = client ?? (await import("@/lib/supabase/service")).createServiceClient()
  const limit = opts.limit ?? 1000
  const now = opts.now ?? new Date()

  const result: RetentionScanResult = { brokerageId, scanned: 0, overdue: [], errors: [] }

  const { data: docs, error } = await supabase
    .from("client_documents")
    .select("id, document_name, doc_category, transaction_id, created_at")
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: true })
    .limit(limit)

  if (error) {
    result.errors.push(error.message)
    return result
  }

  for (const d of (docs ?? []) as Array<{
    id: string
    document_name: string | null
    doc_category: string | null
    transaction_id: string | null
    created_at: string | null
  }>) {
    result.scanned += 1
    const status = isRetentionExpired({ doc_category: d.doc_category, created_at: d.created_at }, now)
    if (status.expired) {
      result.overdue.push({
        documentId: d.id,
        documentName: d.document_name,
        docCategory: d.doc_category,
        transactionId: d.transaction_id,
        createdAt: d.created_at,
        keepYears: status.keepYears,
        retainUntil: status.retainUntil,
        daysOverdue: status.daysOverdue,
        basis: status.basis,
      })
    }
  }

  return result
}
