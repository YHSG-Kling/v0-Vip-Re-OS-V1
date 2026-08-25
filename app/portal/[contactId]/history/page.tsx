import Link from "next/link"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { determinePortalView } from "@/lib/kernel/portal"
import { getTransactionHistory } from "@/app/actions/portal-lifetime"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  ArrowLeft,
  CheckCircle2,
  FileText,
  Calendar,
  Download,
  Home,
  Clock,
  Printer,
} from "lucide-react"

export default async function HistoryPage({
  params,
}: {
  params: Promise<{ contactId: string }>
}) {
  const { contactId } = await params
  const supabase = await createClient()

  // Verify lifetime portal access
  const portalView = await determinePortalView(supabase, { contactId })
  if (portalView.view !== "lifetime") {
    redirect(`/portal/${contactId}`)
  }

  const history = await getTransactionHistory(contactId)

  if (!history) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="p-8 text-center">
            <p className="text-muted-foreground">No transaction history found.</p>
            <Button variant="outline" className="mt-4" asChild>
              <Link href={`/portal/${contactId}`}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Portal
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const milestones = history.transaction_milestones || []
  const documents = history.documents || []

  // Sort milestones by completion date
  const sortedMilestones = [...milestones]
    .filter((m: any) => m.status === "completed")
    .sort((a: any, b: any) => 
      new Date(a.completed_date || 0).getTime() - new Date(b.completed_date || 0).getTime()
    )

  // Key dates
  const keyDates = [
    { label: "Offer Date", date: history.offer_date },
    { label: "Close Date", date: history.close_date },
  ].filter(d => d.date)

  // Key documents
  const keyDocTypes = [
    "purchase_agreement",
    "inspection_report",
    "closing_disclosure",
    "deed",
    "title_insurance",
  ]
  const keyDocuments = documents.filter((d: any) =>
    keyDocTypes.some(type => d.document_type?.toLowerCase().includes(type.replace("_", " ")))
  )

  const formatDate = (date: string) =>
    new Date(date).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    })

  const formatPrice = (price: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(price)

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Button variant="ghost" size="sm" className="mb-2" asChild>
            <Link href={`/portal/${contactId}`}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Portal
            </Link>
          </Button>
          <h1 className="text-3xl font-bold tracking-tight">Transaction History</h1>
          <p className="text-muted-foreground">{history.property_address}</p>
        </div>
        <Button variant="outline" onClick={() => window.print()}>
          <Printer className="mr-2 h-4 w-4" />
          Print Summary
        </Button>
      </div>

      {/* Summary Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Home className="h-5 w-5 text-blue-600" />
            <CardTitle>Purchase Summary</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <p className="text-sm text-muted-foreground">Property Address</p>
              <p className="font-medium">{history.property_address}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Close Date</p>
              <p className="font-medium">{formatDate(history.close_date)}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Sale Price</p>
              <p className="font-medium">{formatPrice(history.sale_price)}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Timeline */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-green-600" />
              <CardTitle>Journey Timeline</CardTitle>
            </div>
            <CardDescription>Your home purchase milestones</CardDescription>
          </CardHeader>
          <CardContent>
            {sortedMilestones.length > 0 ? (
              <div className="relative space-y-0">
                {/* Timeline line */}
                <div className="absolute left-4 top-2 bottom-2 w-0.5 bg-green-200" />

                {sortedMilestones.map((milestone: any, index: number) => (
                  <div key={milestone.id} className="relative flex gap-4 pb-6 last:pb-0">
                    <div className="relative z-10 flex-shrink-0 w-8 h-8 rounded-full bg-green-100 flex items-center justify-center">
                      <CheckCircle2 className="h-4 w-4 text-green-600" />
                    </div>
                    <div className="flex-1 pt-1">
                      <p className="font-medium capitalize">
                        {milestone.milestone_name?.replace(/_/g, " ")}
                      </p>
                      {milestone.completed_date && (
                        <p className="text-sm text-muted-foreground">
                          {formatDate(milestone.completed_date)}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-center py-4">
                No milestone history available
              </p>
            )}
          </CardContent>
        </Card>

        {/* Key Documents */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-blue-600" />
              <CardTitle>Key Documents</CardTitle>
            </div>
            <CardDescription>Important documents from your transaction</CardDescription>
          </CardHeader>
          <CardContent>
            {documents.length > 0 ? (
              <div className="space-y-3">
                {documents.slice(0, 10).map((doc: any) => (
                  <div
                    key={doc.id}
                    className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <FileText className="h-5 w-5 text-muted-foreground" />
                      <div>
                        <p className="font-medium text-sm">{doc.file_name}</p>
                        <p className="text-xs text-muted-foreground capitalize">
                          {doc.document_type?.replace(/_/g, " ")}
                        </p>
                      </div>
                    </div>
                    {doc.file_url && (
                      <Button variant="ghost" size="sm" asChild>
                        <a href={doc.file_url} target="_blank" rel="noopener noreferrer">
                          <Download className="h-4 w-4" />
                        </a>
                      </Button>
                    )}
                  </div>
                ))}
                {documents.length > 10 && (
                  <Button variant="outline" className="w-full" asChild>
                    <Link href={`/portal/${contactId}/documents`}>
                      View All Documents ({documents.length})
                    </Link>
                  </Button>
                )}
              </div>
            ) : (
              <p className="text-muted-foreground text-center py-4">
                No documents available
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Important Dates */}
      {keyDates.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Calendar className="h-5 w-5 text-purple-600" />
              <CardTitle>Important Dates</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-4">
              {keyDates.map((item, index) => (
                <div key={index} className="p-3 rounded-lg bg-muted/50">
                  <p className="text-sm text-muted-foreground">{item.label}</p>
                  <p className="font-medium">{formatDate(item.date!)}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
