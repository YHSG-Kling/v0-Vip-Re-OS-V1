import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getAllVendorBookings } from "@/app/actions/vendor-marketplace"
import { Button } from "@/components/ui/button"
import { Briefcase, ArrowLeft } from "lucide-react"
import Link from "next/link"
import { JobsClient } from "./jobs-client"

export const dynamic = "force-dynamic"

export default async function VendorJobsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  let bookings: any[] = []
  try {
    bookings = (await getAllVendorBookings()) || []
  } catch {
    bookings = []
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-3">
        <Link href="/vendor/dashboard">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Briefcase className="w-6 h-6 text-blue-600" />
            My Jobs
          </h1>
          <p className="text-gray-500 text-sm">
            {bookings.length} total job{bookings.length !== 1 ? "s" : ""}
          </p>
        </div>
      </div>
      <JobsClient bookings={bookings} />
    </div>
  )
}
