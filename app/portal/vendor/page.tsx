import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { getVendorBookings } from "@/app/actions/multi-persona"
import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { Wrench, Calendar, CheckCircle2, Clock, DollarSign } from "lucide-react"
import { VendorBookingsList } from "@/components/vendor/bookings-list"

export default async function VendorPortalDashboard({ searchParams }: { searchParams: Promise<{ vendorId?: string }> }) {
  const params = await searchParams
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect("/login")

  let vendorId = params.vendorId
  if (!vendorId) {
    const { data: vendor } = await supabase.from("vendor_directory").select("id").eq("user_id", user.id).single()
    vendorId = vendor?.id
  }

  if (!vendorId) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="p-8 text-center">
            <Wrench className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <p className="text-muted-foreground">No vendor profile found. Please contact your administrator.</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const bookings = await getVendorBookings(vendorId)

  const upcomingCount = bookings?.filter((b: any) => b.status === "scheduled" && new Date(b.scheduled_date) >= new Date())?.length || 0
  const completedCount = bookings?.filter((b: any) => b.status === "completed")?.length || 0
  const pendingPayment = bookings?.filter((b: any) => b.status === "completed" && b.payment_status !== "paid")?.length || 0
  const totalEarnings = bookings?.filter((b: any) => b.payment_status === "paid")?.reduce((sum: number, b: any) => sum + (b.cost || 0), 0) || 0

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Vendor Portal</h1>
          <p className="text-muted-foreground">Manage your service bookings and invoices</p>
        </div>
        <Badge variant="outline" className="text-sm">
          {upcomingCount} Upcoming
        </Badge>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              Upcoming Jobs
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{upcomingCount}</div>
            <p className="text-xs text-muted-foreground">Scheduled</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4" />
              Completed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{completedCount}</div>
            <p className="text-xs text-muted-foreground">This month</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Pending Payment
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-orange-600">{pendingPayment}</div>
            <p className="text-xs text-muted-foreground">Awaiting</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <DollarSign className="h-4 w-4" />
              Total Earnings
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${totalEarnings.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">All time</p>
          </CardContent>
        </Card>
      </div>

      {/* Bookings List */}
      <VendorBookingsList bookings={bookings || []} />
    </div>
  )
}
