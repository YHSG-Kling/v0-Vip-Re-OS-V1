"use server"

/**
 * Vendor Document Center — pulls every document related to the vendor's work:
 *   - Invoices they've issued (vendor_invoices)
 *   - Deliverables they've uploaded for jobs (transaction_documents, filed by
 *     app/actions/vendor-portal.ts:uploadVendorJobDocument)
 *   - Service agreements / contracts (client_documents where uploaded_by = vendor user)
 *
 * Vendors authenticate via /vendor/dashboard; the vendor identity these reads key
 * on is `vendors.id`, resolved from the user's `user_role_assignments` grant —
 * the same rail lib/kernel/portal-auth.ts:requireVendorActor gates on.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

export interface VendorDocument {
  id: string
  category: "invoice" | "deliverable" | "agreement"
  title: string
  description: string
  url: string | null
  uploadedAt: string
  status: string | null
  badge?: { label: string; color: string }
  /** Optional context */
  bookingId?: string | null
  jobId?: string | null
  invoiceId?: string | null
  amount?: number | null
}

export interface VendorDocumentSummary {
  documents: VendorDocument[]
  byCategory: Record<string, number>
  totalCount: number
}

export async function getVendorDocuments(): Promise<VendorDocumentSummary> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return EMPTY

  const svc = createServiceClient()

  // ── WHICH VENDOR ID ──────────────────────────────────────────────────────
  // Both reads below key on `vendors.id`: schema-fk-map records
  // vendor_invoices.vendor_id → vendors and vendor_jobs.vendor_id → vendors.
  // This resolved `vendor_marketplace_profiles.id` instead — a DIFFERENT id
  // class (vendors.platform_vendor_id → vendor_marketplace_profiles is the link
  // between them), so every query here compared a marketplace-profile id against
  // a vendors id and returned nothing. CLAUDE.md §3 records the same shape for
  // agents.id vs users.id.
  //
  // `user_role_assignments` is the canonical vendor identity rail — it is what
  // lib/kernel/portal-auth.ts:requireVendorActor gates on, and it is the only
  // one asked here (see the note under the lookup).
  const { data: grants, error: grantError } = await svc
    .from("user_role_assignments")
    .select("vendor_id")
    .eq("user_id", user.id)
    .not("vendor_id", "is", null)

  if (grantError) {
    console.error("[vendor-documents] vendor identity read refused:", grantError.message)
    return EMPTY
  }

  const vendorId = (grants ?? []).map((g: any) => g.vendor_id as string).find(Boolean) ?? null

  // NO MARKETPLACE-PROFILE FALLBACK. Resolving `vendors` by
  // `platform_vendor_id = <marketplace profile>` would be a tenant-free lookup
  // on a tenant table — this account holds no brokerage of its own to scope it
  // by, which is exactly why the role grant is the identity rail: it carries the
  // vendor AND the brokerage together. An account with a marketplace profile and
  // no grant has no vendor identity in any brokerage yet, and the honest answer
  // for it is an empty document centre, not a bench row found by guesswork.
  if (!vendorId) return EMPTY

  // Pull from three sources in parallel
  const [invoicesResult, jobsResult, agreementsResult] = await Promise.all([
    fetchVendorInvoices(svc, vendorId),
    fetchVendorJobDeliverables(svc, vendorId),
    fetchVendorAgreements(svc, user.id),
  ])

  const documents = [...invoicesResult, ...jobsResult, ...agreementsResult]
    .sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime())

  const byCategory = documents.reduce(
    (acc, d) => ({ ...acc, [d.category]: (acc[d.category] ?? 0) + 1 }),
    {} as Record<string, number>
  )

  return { documents, byCategory, totalCount: documents.length }
}

// ---------------------------------------------------------------------------

async function fetchVendorInvoices(
  svc: ReturnType<typeof createServiceClient>,
  vendorId: string
): Promise<VendorDocument[]> {
  const { data } = await svc
    .from("vendor_invoices")
    .select("id, invoice_number, total_amount, status, billed_to, invoice_date, paid_at, booking_id")
    .eq("vendor_id", vendorId)
    .order("invoice_date", { ascending: false })
    .limit(100)

  return (data ?? []).map((inv: any) => ({
    id: `invoice-${inv.id}`,
    category: "invoice" as const,
    title: inv.invoice_number ?? `INV-${String(inv.id).slice(0, 8).toUpperCase()}`,
    description: `Billed to ${inv.billed_to} · ${formatMoney(inv.total_amount)}`,
    url: null,  // invoice rendering happens in-app, not external file
    uploadedAt: inv.invoice_date,
    status: inv.status,
    badge: invoiceStatusBadge(inv.status),
    invoiceId: inv.id,
    bookingId: inv.booking_id,
    amount: inv.total_amount,
  }))
}

/**
 * The vendor's job deliverables.
 *
 * WAS: `vendor_jobs.documents_uploaded`, read here as a JSONB array of
 * `{url, name, uploaded_at, type}`. Two things were wrong with that, and the
 * second is the one a static sweep could not have found.
 *
 *   1. NOTHING IN THE TREE WRITES THAT COLUMN. The ONE upload path a vendor has,
 *      uploadVendorJobDocument (app/actions/vendor-portal.ts:438), stores the
 *      bytes in the private `transaction-documents` bucket and files a
 *      `transaction_documents` row carrying `metadata.job_id` and
 *      `metadata.vendor_id`.
 *   2. IT IS NOT AN ARRAY. MEASURED LIVE against hrvaqgvukzxfskkcrwbt on
 *      2026-08-28 (information_schema.columns):
 *      `vendor_jobs.documents_uploaded` is `integer DEFAULT 0` — a COUNT. So the
 *      `Array.isArray(docs)` guard below was false on every row and the loop
 *      `continue`d, which is why this failed silently rather than throwing.
 *
 * Either way this panel's whole "deliverable" category rendered empty for every
 * vendor on the platform, no matter how many files they had uploaded.
 *
 * The duplicate resolves in favour of `transaction_documents`, and not merely
 * because it is the side with the writer: it is the tenanted ledger with the
 * status, the audit stamps and the upload's own orphan-compensation path — and
 * `storage_url` there is a SIGNED url, which is exactly the kind of value that
 * must not be copied into a second JSONB store to rot at its own pace.
 * `vendor_jobs.documents_uploaded` is therefore READ BY NOBODY from here on;
 * its survivor is this function.
 */
async function fetchVendorJobDeliverables(
  svc: ReturnType<typeof createServiceClient>,
  vendorId: string
): Promise<VendorDocument[]> {
  // The vendor's own jobs first — the deliverable rows are addressed by job id,
  // and reading the jobs is also what keeps a document filed under someone
  // else's job out of this list.
  const { data: jobs, error: jobsError } = await svc
    .from("vendor_jobs")
    .select("id, transaction_id, status")
    .eq("vendor_id", vendorId)
    .limit(100)

  if (jobsError) {
    console.error("[vendor-documents] job read refused:", jobsError.message)
    return []
  }

  const jobById = new Map<string, { transaction_id: string | null; status: string | null }>()
  for (const j of jobs ?? []) {
    jobById.set(String((j as any).id), {
      transaction_id: (j as any).transaction_id ?? null,
      status: (j as any).status ?? null,
    })
  }
  if (jobById.size === 0) return []

  const { data: docs, error: docsError } = await svc
    .from("transaction_documents")
    .select("id, doc_label, doc_type, status, storage_url, uploaded_at, created_at, metadata")
    .eq("uploaded_by_type", "vendor")
    .in("metadata->>job_id", [...jobById.keys()])
    .order("uploaded_at", { ascending: false })
    .limit(200)

  if (docsError) {
    console.error("[vendor-documents] deliverable read refused:", docsError.message)
    return []
  }

  const out: VendorDocument[] = []
  for (const d of docs ?? []) {
    const jobId = String((d as any).metadata?.job_id ?? "")
    const job = jobById.get(jobId)
    if (!job) continue
    out.push({
      id: `deliverable-${(d as any).id}`,
      category: "deliverable",
      title: (d as any).doc_label ?? "Job deliverable",
      description: (d as any).doc_type ? humanize(String((d as any).doc_type)) : "Job deliverable",
      url: (d as any).storage_url ?? null,
      uploadedAt: (d as any).uploaded_at ?? (d as any).created_at ?? new Date().toISOString(),
      status: (d as any).status ?? job.status,
      jobId,
    })
  }
  return out
}

async function fetchVendorAgreements(
  svc: ReturnType<typeof createServiceClient>,
  userId: string
): Promise<VendorDocument[]> {
  // Service agreements / contracts uploaded by or for this vendor user
  const { data } = await svc
    .from("client_documents")
    .select("id, document_name, document_url, document_type, created_at, uploaded_by")
    .eq("uploaded_by", userId)
    .order("created_at", { ascending: false })
    .limit(100)

  return (data ?? []).map((d: any) => ({
    id: `agreement-${d.id}`,
    category: "agreement" as const,
    title: d.document_name,
    description: d.document_type ? humanize(d.document_type) : "Document",
    url: d.document_url,
    uploadedAt: d.created_at,
    status: null,
  }))
}

// ---------------------------------------------------------------------------

function invoiceStatusBadge(status: string | null) {
  const map: Record<string, { label: string; color: string }> = {
    draft: { label: "Draft", color: "bg-gray-100 text-gray-700" },
    submitted: { label: "Submitted", color: "bg-blue-100 text-blue-800" },
    viewed: { label: "Viewed", color: "bg-indigo-100 text-indigo-800" },
    paid: { label: "Paid", color: "bg-green-100 text-green-800" },
    overdue: { label: "Overdue", color: "bg-red-100 text-red-800" },
    cancelled: { label: "Cancelled", color: "bg-gray-100 text-gray-500" },
  }
  return map[status ?? ""] ?? { label: status ?? "—", color: "bg-gray-100 text-gray-700" }
}

function formatMoney(amount: number | null): string {
  if (amount == null) return "—"
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount)
}

function humanize(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

const EMPTY: VendorDocumentSummary = {
  documents: [],
  byCategory: {},
  totalCount: 0,
}
