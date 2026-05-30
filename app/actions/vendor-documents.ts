"use server"

/**
 * Vendor Document Center — pulls every document related to the vendor's work:
 *   - Invoices they've issued (vendor_invoices)
 *   - Deliverables they've uploaded for jobs (vendor_jobs.documents_uploaded)
 *   - Service agreements / contracts (client_documents where uploaded_by = vendor user)
 *
 * Vendors authenticate via /vendor/dashboard so user.id → vendor_marketplace_profiles.user_id.
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

  // Resolve the vendor profile
  const { data: vendorProfile } = await svc
    .from("vendor_marketplace_profiles")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle()

  if (!vendorProfile) return EMPTY

  // Pull from three sources in parallel
  const [invoicesResult, jobsResult, agreementsResult] = await Promise.all([
    fetchVendorInvoices(svc, vendorProfile.id),
    fetchVendorJobDeliverables(svc, vendorProfile.id),
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

async function fetchVendorJobDeliverables(
  svc: ReturnType<typeof createServiceClient>,
  vendorId: string
): Promise<VendorDocument[]> {
  const { data: jobs } = await svc
    .from("vendor_jobs")
    .select("id, transaction_id, status, documents_uploaded")
    .eq("vendor_id", vendorId)
    .limit(100)

  const out: VendorDocument[] = []
  for (const job of jobs ?? []) {
    const docs = (job.documents_uploaded ?? []) as Array<{
      url?: string
      name?: string
      uploaded_at?: string
      type?: string
    }>
    if (!Array.isArray(docs)) continue
    for (let i = 0; i < docs.length; i++) {
      const d = docs[i]
      if (!d?.url) continue
      out.push({
        id: `deliverable-${job.id}-${i}`,
        category: "deliverable",
        title: d.name ?? `Deliverable ${i + 1}`,
        description: d.type ? `${d.type}` : "Job deliverable",
        url: d.url,
        uploadedAt: d.uploaded_at ?? new Date().toISOString(),
        status: job.status,
        jobId: job.id,
      })
    }
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
