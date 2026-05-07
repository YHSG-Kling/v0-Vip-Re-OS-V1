import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import Link from "next/link"
import { determinePortalView } from "@/lib/kernel/portal"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { Badge } from "@/app/components/ui/badge"
import { ArrowLeft, Phone, Mail, MapPin, Building2, Briefcase, MessageSquare } from "lucide-react"
import { RequestBookingButton } from "./request-booking-button"

export default async function ClientVendorsPage({
  params,
}: {
  params: Promise<{ contactId: string }>
}) {
  const { contactId } = await params
  const supabase = await createClient()

  // Verify buyer portal view — use contract input { contactId }
  const portalViewOutput = await determinePortalView(supabase, { contactId })
  if (portalViewOutput.view !== "buyer") {
    redirect(`/portal/${contactId}`)
  }

  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, name, agent_id")
    .eq("id", contactId)
    .single()

  if (!contact || contactError) {
    redirect("/portal?error=contact_not_found")
  }

  // Get contact's active transaction
  const { data: transaction } = await supabase
    .from("transactions")
    .select("id, contact_id")
    .eq("buyer_contact_id", contactId)
    .not("status", "in", "(cancelled)")
    .order("created_at", { ascending: false })
    .limit(1)
    .single()

  // Parallel data fetches
  const [assignedVendorsResult, preferredVendorsResult, agentResult] = await Promise.all([
    // Assigned vendors from vendor_assignments for this transaction
    // vendors table schema: id, name, email, phone, website, category, rating
    transaction
      ? supabase
          .from("vendor_assignments")
          .select(`
            id,
            assignment_type,
            scheduled_date,
            status,
            vendors:vendor_id(id, name, category, phone, email),
            vendor_jobs:vendor_jobs(id, status, cost_estimate, cost_actual)
          `)
          .eq("transaction_id", transaction.id)
          .order("scheduled_date", { ascending: false, nullsFirst: false })
      : Promise.resolve({ data: [] }),
    // Preferred vendors from vendor_directory for agent's brokerage
    // vendor_directory schema: id, brokerage_id, name, category, phone, email, website, rating, notes
    contact.agent_id
      ? supabase
          .from("agents")
          .select("brokerage_id")
          .eq("id", contact.agent_id)
          .single()
          .then(async (agentRes) => {
            if (!agentRes.data?.brokerage_id) return { data: [] }
            return supabase
              .from("vendor_directory")
              .select("id, name, category, phone, email, website, rating, notes, brokerage_id")
              .eq("brokerage_id", agentRes.data.brokerage_id)
              .order("category", { ascending: true })
          })
      : Promise.resolve({ data: [] }),
    // Get agent info for attribution
    contact.agent_id
      ? supabase
          .from("agents")
          .select("id, first_name, last_name")
          .eq("id", contact.agent_id)
          .single()
      : Promise.resolve({ data: null }),
  ])

  const assignedVendors = assignedVendorsResult.data ?? []
  const preferredVendors = preferredVendorsResult.data ?? []
  const agent = agentResult.data

  const contactName = contact.first_name || contact.name || "there"

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <Button variant="ghost" size="sm" className="mb-2" asChild>
          <Link href={`/portal/${contactId}`}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Dashboard
          </Link>
        </Button>
        <h1 className="text-3xl font-bold">Your Vendor Team</h1>
        <p className="text-muted-foreground mt-1">
          Professionals assisting with your transaction
        </p>
      </div>

      {/* Section 1: My Transaction Team Vendors */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Briefcase className="h-5 w-5" />
            Your Transaction Team
          </CardTitle>
          <CardDescription>
            Vendors assigned to your home purchase
          </CardDescription>
        </CardHeader>
        <CardContent>
          {assignedVendors.length === 0 ? (
            <div className="text-center py-8">
              <Building2 className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
              <p className="text-muted-foreground mb-2">
                Your vendor team will be assigned as your transaction progresses
              </p>
              <p className="text-sm text-muted-foreground">
                Check back soon for updates from your agent
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {assignedVendors.map((assignment: any) => (
                <div
                  key={assignment.id}
                  className="p-4 border rounded-lg hover:bg-muted/30 transition-colors"
                >
                  <div className="flex items-start justify-between gap-4 mb-3">
                    <div>
                      <h3 className="font-semibold">
                        {assignment.vendors?.name || "Vendor"}
                      </h3>
                      <div className="flex flex-wrap gap-2 mt-1">
                        <Badge variant="secondary" className="text-xs">
                          {assignment.assignment_type}
                        </Badge>
                        <Badge
                          variant="outline"
                          className={`text-xs ${
                            assignment.status === "completed"
                              ? "bg-green-50 text-green-700 border-green-200"
                              : "bg-blue-50 text-blue-700 border-blue-200"
                          }`}
                        >
                          {assignment.status}
                        </Badge>
                      </div>
                    </div>
                  </div>

                  {/* Job status */}
                  {assignment.vendor_jobs && assignment.vendor_jobs.length > 0 && (
                    <div className="mb-3 p-3 bg-muted/50 rounded-lg text-sm">
                      <p className="font-medium mb-1">Job Status</p>
                      {assignment.vendor_jobs.map((job: any) => (
                        <div key={job.id} className="text-muted-foreground">
                          <p>{job.status}</p>
                          {job.cost_estimate && (
                            <p className="text-xs">Est. Cost: ${job.cost_estimate.toLocaleString()}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Contact info and scheduled date */}
                  <div className="flex flex-wrap gap-4 text-sm mb-3">
                    {assignment.vendors?.phone && (
                      <a
                        href={`tel:${assignment.vendors.phone}`}
                        className="flex items-center gap-1 text-blue-600 hover:underline"
                      >
                        <Phone className="h-4 w-4" />
                        {assignment.vendors.phone}
                      </a>
                    )}
                    {assignment.vendors?.email && (
                      <a
                        href={`mailto:${assignment.vendors.email}`}
                        className="flex items-center gap-1 text-blue-600 hover:underline"
                      >
                        <Mail className="h-4 w-4" />
                        Email
                      </a>
                    )}
                    {assignment.scheduled_date && (
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <MapPin className="h-4 w-4" />
                        {new Date(assignment.scheduled_date).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                    )}
                  </div>

                  {/* Message agent button */}
                  <Button variant="outline" size="sm" className="w-full" asChild>
                    <Link href={`/portal/${contactId}/messages`}>
                      <MessageSquare className="h-4 w-4 mr-2" />
                      Message Agent About This Vendor
                    </Link>
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section 2: Preferred Vendors Directory */}
      {preferredVendors.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5" />
              Recommended Professionals
            </CardTitle>
            <CardDescription>
              {agent ? `Recommended by ${agent.first_name || "your agent"}` : "Recommended vendors"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-2">
              {preferredVendors.map((dirEntry: any) => (
                <div
                  key={dirEntry.id}
                  className="p-4 border rounded-lg hover:bg-muted/30 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0">
                      <h3 className="font-semibold truncate">
                        {dirEntry.name || "Vendor"}
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        {dirEntry.category}
                      </p>
                    </div>
                  </div>

                  {dirEntry.rating && (
                    <div className="flex items-center gap-1 text-sm mb-3">
                      <span className="text-yellow-500">★</span>
                      <span className="font-medium">{Number(dirEntry.rating).toFixed(1)}</span>
                    </div>
                  )}

                  <div className="space-y-1 text-sm mb-3">
                    {dirEntry.phone && (
                      <a
                        href={`tel:${dirEntry.phone}`}
                        className="flex items-center gap-2 text-blue-600 hover:underline"
                      >
                        <Phone className="h-4 w-4" />
                        {dirEntry.phone}
                      </a>
                    )}
                    {dirEntry.website && (
                      <a
                        href={dirEntry.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 text-blue-600 hover:underline"
                      >
                        <Building2 className="h-4 w-4" />
                        Visit Website
                      </a>
                    )}
                  </div>

                  <p className="text-xs text-muted-foreground mb-3">
                    Recommended by {agent?.first_name || "your agent"}
                  </p>

                  {/* Contact-initiated booking request */}
                  <RequestBookingButton
                    contactId={contactId}
                    vendorId={dirEntry.vendor_id ?? dirEntry.id}
                    vendorName={dirEntry.name ?? "this vendor"}
                    defaultServiceType={dirEntry.category ?? "consultation"}
                  />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty state message if no assigned vendors */}
      {assignedVendors.length === 0 && preferredVendors.length > 0 && (
        <Card className="bg-blue-50 border-blue-200">
          <CardContent className="pt-6">
            <p className="text-sm text-blue-900">
              Looking for help now? Above are professionals recommended by your agent. Feel free to reach out to them or contact your agent for vendor recommendations.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
