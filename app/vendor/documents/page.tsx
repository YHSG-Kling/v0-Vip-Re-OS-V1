import { redirect } from "next/navigation"
import Link from "next/link"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getVendorDocuments } from "@/app/actions/vendor-documents"
import { readVendorW9, type VendorW9Read } from "@/lib/vendors/w9"
import { VendorW9Card } from "./w9-card"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  ArrowLeft, FolderOpen, FileText, Receipt, FileCheck, ExternalLink,
} from "lucide-react"

export const dynamic = "force-dynamic"
export const metadata = { title: "My Documents" }

const CATEGORY_META = {
  invoice:     { label: "Invoices",            icon: <Receipt className="h-4 w-4" /> },
  deliverable: { label: "Job Deliverables",    icon: <FileCheck className="h-4 w-4" /> },
  agreement:   { label: "Agreements",          icon: <FileText className="h-4 w-4" /> },
} as const

export default async function VendorDocumentsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const summary = await getVendorDocuments()

  // W-9 posture (owner round 43) — canonical vendor linkage is
  // user_role_assignments.vendor_id (the same rail the invoice center uses).
  let vendorId: string | null = null
  let w9: VendorW9Read | null = null
  const { data: ra } = await supabase
    .from("user_role_assignments")
    .select("vendor_id")
    .eq("user_id", user.id)
    .not("vendor_id", "is", null)
    .maybeSingle()
  if (ra?.vendor_id) {
    vendorId = ra.vendor_id as string
    w9 = await readVendorW9(createServiceClient(), vendorId).catch(() => null)
  }

  // Group by category for display
  const grouped: Record<string, typeof summary.documents> = {}
  for (const doc of summary.documents) {
    if (!grouped[doc.category]) grouped[doc.category] = []
    grouped[doc.category].push(doc)
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-3">
        <Link href="/vendor/dashboard">
          <Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FolderOpen className="h-6 w-6 text-blue-600" />
            My Documents
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Invoices, job deliverables, and service agreements — all in one place.
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total Documents" value={summary.totalCount} />
        <StatCard label="Invoices" value={summary.byCategory.invoice ?? 0} />
        <StatCard label="Deliverables" value={summary.byCategory.deliverable ?? 0} />
        <StatCard label="Agreements" value={summary.byCategory.agreement ?? 0} />
      </div>

      {/* W-9 on file (owner round 43) — the payer-side tax-compliance basic. */}
      {vendorId && w9 && <VendorW9Card vendorId={vendorId} w9={w9} />}

      {summary.totalCount === 0 ? (
        <Card>
          <CardContent className="p-12 text-center text-sm text-muted-foreground">
            No documents yet. As you complete jobs and submit invoices, they'll appear here.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {(Object.keys(CATEGORY_META) as Array<keyof typeof CATEGORY_META>).map((cat) => {
            const docs = grouped[cat] ?? []
            if (docs.length === 0) return null
            const meta = CATEGORY_META[cat]
            return (
              <Card key={cat}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    {meta.icon}
                    {meta.label}
                    <span className="text-muted-foreground font-normal text-xs">
                      ({docs.length})
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="divide-y">
                    {docs.map((doc) => (
                      <div
                        key={doc.id}
                        className="px-4 py-3 flex items-center justify-between gap-3 text-sm hover:bg-muted/40 transition-colors"
                      >
                        <div className="flex items-start gap-3 min-w-0 flex-1">
                          <FileText className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                          <div className="min-w-0 flex-1">
                            <p className="font-medium truncate">{doc.title}</p>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {doc.description} · {new Date(doc.uploadedAt).toLocaleDateString()}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          {doc.badge && (
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${doc.badge.color}`}>
                              {doc.badge.label}
                            </span>
                          )}
                          {doc.url ? (
                            <a
                              href={doc.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-blue-600 hover:underline flex items-center gap-1"
                            >
                              <ExternalLink className="h-3 w-3" />
                              Open
                            </a>
                          ) : doc.invoiceId ? (
                            <Link
                              href={`/vendor/earnings`}
                              className="text-xs text-blue-600 hover:underline"
                            >
                              View
                            </Link>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-3 text-center">
        <p className="text-2xl font-bold">{value}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
      </CardContent>
    </Card>
  )
}
